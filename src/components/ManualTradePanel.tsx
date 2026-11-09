/**
 * ManualTradePanel – manual backtest on hand-drawn Long/Short positions.
 * Account sizing, Bybit fees, per-trade results, and save/load sessions.
 */
import React, { useMemo, useRef, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import {
  useManualTradeStore,
  parseSessionFile,
  downloadSession,
  MANUAL_BACKTEST_KIND,
  type ManualBacktestSession,
} from '../store/manualTradeStore';
import {
  runManualBacktest,
  breakevenPoints,
  slotIndexAtOrAfter,
  type ManualTradeSettings,
  type PositionOutcome,
} from '../engine/manualBacktest';
import type { PositionDrawing } from '../types';
import { randomId } from '../utils/id';

const GREEN = '#26a69a';
const RED = '#ef5350';
const ACCENT = '#2962ff';

const OUTCOME_LABEL: Record<PositionOutcome, string> = {
  tp: 'TP', sl: 'SL', closed: 'Closed', open: 'Open', not_triggered: 'No fill', waiting: 'Waiting',
};

const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

export const ManualTradePanel: React.FC = () => {
  const {
    theme, drawings, primarySlots, viewport, currentSeries, replay,
    pan, setDrawingTool, activeDrawingTool, updateDrawing, deleteDrawing, setPositionDrawings,
  } = useChartStore();
  const { settings, setSettings, resetSettings, sessions, upsertSession, deleteSession } = useManualTradeStore();

  const [sessionName, setSessionName] = useState('');
  const [status, setStatus] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const subtle = theme === 'dark' ? '#2a2e39' : '#e0e3eb';
  const inputBg = theme === 'dark' ? '#131722' : '#ffffff';

  const positions = useMemo(
    () => drawings.filter((d): d is PositionDrawing => d.tool === 'long_position' || d.tool === 'short_position'),
    [drawings],
  );
  const asOf = replay.active ? replay.index : undefined;
  const { stats, summary } = useMemo(
    () => runManualBacktest(positions, primarySlots, settings, asOf),
    [positions, primarySlots, settings, asOf],
  );

  const lastClose = useMemo(() => {
    for (let i = Math.min(primarySlots.length - 1, asOf ?? Infinity); i >= 0; i--) {
      const c = primarySlots[i].candle;
      if (c) return c.close;
    }
    return 0;
  }, [primarySlots, asOf]);

  const flash = (msg: string) => { setStatus(msg); setTimeout(() => setStatus(''), 2500); };

  const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '3px 5px', fontSize: 11,
    background: inputBg, color: text, border: `1px solid ${subtle}`, borderRadius: 3,
  };
  const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({
    padding: '4px 8px', fontSize: 11, background: bg, color: fg,
    border: bg === 'transparent' ? `1px solid ${subtle}` : 'none', borderRadius: 3, cursor: 'pointer',
  });
  const section: React.CSSProperties = { background: subtle, borderRadius: 4, padding: 8, marginBottom: 8 };
  const label: React.CSSProperties = { fontSize: 10, opacity: 0.65, marginBottom: 2, display: 'block' };

  const num = (key: keyof ManualTradeSettings, step = 'any') => (
    <input
      type="number"
      step={step}
      value={settings[key] as number}
      onChange={e => {
        const v = parseFloat(e.target.value);
        if (Number.isFinite(v) && v >= 0) setSettings({ [key]: v } as Partial<ManualTradeSettings>);
      }}
      style={inputStyle}
    />
  );

  const jumpTo = (ts: number) => {
    const si = slotIndexAtOrAfter(primarySlots, ts);
    const targetFirst = Math.max(0, si - Math.floor(viewport.visibleSlotCount / 2));
    pan(targetFirst - viewport.firstSlotIndex);
  };

  const buildSession = (name: string): ManualBacktestSession => {
    const existing = sessions.find(s => s.name === name);
    const now = Date.now();
    return {
      kind: MANUAL_BACKTEST_KIND,
      version: 1,
      id: existing?.id ?? randomId(),
      name,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      series: currentSeries ?? undefined,
      settings,
      positions,
    };
  };

  const handleSave = () => {
    const name = sessionName.trim();
    if (!name) { flash('Enter a session name'); return; }
    if (!positions.length) { flash('No positions on the chart'); return; }
    upsertSession(buildSession(name));
    flash(`Saved "${name}"`);
  };

  const loadSession = (s: ManualBacktestSession) => {
    if (positions.length && !confirm(`Replace the ${positions.length} position(s) on the chart with "${s.name}"?`)) return;
    if (s.series && currentSeries && s.series.symbol !== currentSeries.symbol) {
      if (!confirm(`This session was saved on ${s.series.symbol}; current chart is ${currentSeries.symbol}. Load anyway?`)) return;
    }
    // Slot indices depend on the loaded data/timeframe – rebuild them from timestamps
    const remapped = s.positions.map(p => {
      const entrySi = slotIndexAtOrAfter(primarySlots, p.entry.timestamp);
      const endSi = p.end.timestamp > 0
        ? slotIndexAtOrAfter(primarySlots, p.end.timestamp)
        : entrySi + Math.max(1, p.end.slotIndex - p.entry.slotIndex);
      return {
        ...p,
        entry: { ...p.entry, slotIndex: entrySi },
        end: { ...p.end, slotIndex: Math.max(entrySi + 1, endSi) },
      };
    });
    setPositionDrawings(remapped);
    setSettings(s.settings);
    setSessionName(s.name);
    if (remapped[0]) jumpTo(remapped[0].entry.timestamp);
    flash(`Loaded "${s.name}" (${remapped.length} trades)`);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const s = parseSessionFile(await file.text());
      upsertSession(s);
      loadSession(s);
    } catch (err) {
      flash(`Import failed: ${(err as Error).message}`);
    }
  };

  const bePts = lastClose ? breakevenPoints(lastClose, true, settings) : 0;

  return (
    <div style={{ color: text, padding: 10, fontSize: 11 }}>
      {/* ── Place trades ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button
          style={{ ...btn(activeDrawingTool === 'long_position' ? GREEN : 'transparent', activeDrawingTool === 'long_position' ? '#fff' : GREEN), flex: 1 }}
          onClick={() => setDrawingTool(activeDrawingTool === 'long_position' ? 'none' : 'long_position')}
        >▲ Long</button>
        <button
          style={{ ...btn(activeDrawingTool === 'short_position' ? RED : 'transparent', activeDrawingTool === 'short_position' ? '#fff' : RED), flex: 1 }}
          onClick={() => setDrawingTool(activeDrawingTool === 'short_position' ? 'none' : 'short_position')}
        >▼ Short</button>
      </div>
      <div style={{ fontSize: 10, opacity: 0.6, marginBottom: 8, lineHeight: 1.4 }}>
        Click entry, drag to target. Drag top/bottom handles to resize vertically, left/right handles to resize horizontally, the box to move it. Right-click → Reset size.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginBottom: 8, fontSize: 10 }}>
        <span style={{ opacity: 0.6, width: '100%' }}>Show on chart</span>
        {([
          ['showUsd', '$ amounts'],
          ['showAcctPct', '% of account'],
          ['showBreakeven', 'Break-even line'],
        ] as const).map(([key, text]) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
            <input type="checkbox" checked={settings[key]} onChange={e => setSettings({ [key]: e.target.checked })} />
            {text}
          </label>
        ))}
      </div>

      {/* ── Summary ───────────────────────────────────────────────── */}
      {replay.active && primarySlots[replay.index] && (
        <div style={{ fontSize: 10, color: ACCENT, marginBottom: 4 }}>
          Replay – results as of {new Date(primarySlots[replay.index].timestamp).toLocaleString()}
        </div>
      )}
      <div style={section}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 10px' }}>
          <span style={{ opacity: 0.6 }}>Equity</span>
          <span style={{ fontWeight: 600 }}>{usd(summary.finalEquity)}</span>
          {summary.openTrades > 0 && (
            <>
              <span style={{ opacity: 0.6 }}>Open P&L ({summary.openTrades})</span>
              <span style={{ fontWeight: 600, color: summary.openPnl >= 0 ? GREEN : RED }}>{usd(summary.openPnl)}</span>
            </>
          )}
          <span style={{ opacity: 0.6 }}>Net P&L</span>
          <span style={{ fontWeight: 600, color: summary.netPnl >= 0 ? GREEN : RED }}>
            {usd(summary.netPnl)} ({summary.returnPct >= 0 ? '+' : ''}{summary.returnPct.toFixed(2)}%)
          </span>
          <span style={{ opacity: 0.6 }}>Trades</span>
          <span>{summary.closedTrades} closed / {summary.trades}</span>
          <span style={{ opacity: 0.6 }}>Win rate</span>
          <span>{summary.winRate.toFixed(1)}% ({summary.wins}W/{summary.losses}L)</span>
          <span style={{ opacity: 0.6 }}>Fees paid</span>
          <span>{usd(summary.totalFees)}</span>
          <span style={{ opacity: 0.6 }}>Profit factor</span>
          <span>{Number.isFinite(summary.profitFactor) ? summary.profitFactor.toFixed(2) : '∞'}</span>
          <span style={{ opacity: 0.6 }}>Max drawdown</span>
          <span style={{ color: summary.maxDrawdown > 0 ? RED : undefined }}>
            {usd(summary.maxDrawdown)} ({summary.maxDrawdownPct.toFixed(2)}%)
          </span>
          <span style={{ opacity: 0.6 }}>Avg R</span>
          <span>{summary.avgR.toFixed(2)}R</span>
        </div>
      </div>

      {/* ── Trades ────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontWeight: 600 }}>Trades ({stats.length})</span>
        {positions.length > 0 && (
          <button
            style={{ ...btn('transparent', RED), padding: '2px 6px', fontSize: 10 }}
            onClick={() => { if (confirm('Remove all long/short positions from the chart?')) setPositionDrawings([]); }}
          >Clear all</button>
        )}
      </div>
      {stats.length === 0 && <div style={{ opacity: 0.5, fontSize: 10, marginBottom: 8 }}>No positions drawn yet.</div>}
      <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 8 }}>
        {stats.map(t => (
          <div key={t.id} style={{ background: subtle, borderRadius: 3, padding: '4px 6px', marginBottom: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} onClick={() => jumpTo(t.entryTs)} title="Jump to trade">
              <span style={{ fontWeight: 700, fontSize: 9, color: t.direction === 'long' ? GREEN : RED, minWidth: 30 }}>
                {t.direction === 'long' ? 'LONG' : 'SHORT'}
              </span>
              <span style={{ flex: 1, opacity: 0.75 }}>
                {new Date(t.entryTs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span style={{ opacity: 0.75 }}>{OUTCOME_LABEL[t.outcome]}</span>
              <span style={{ fontWeight: 600, minWidth: 54, textAlign: 'right', color: t.exitPrice === null ? undefined : t.netPnl >= 0 ? GREEN : RED }}>
                {t.exitPrice === null ? '—' : usd(t.netPnl)}
              </span>
              <button
                title="Delete"
                onClick={e => { e.stopPropagation(); deleteDrawing(t.id); }}
                style={{ background: 'transparent', border: 'none', color: RED, cursor: 'pointer', fontSize: 12, padding: 0 }}
              >×</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 10, opacity: 0.85 }}>
              <span>@ {t.entryPrice.toFixed(1)}</span>
              <span style={{ opacity: 0.7 }}>Qty</span>
              <input
                type="number"
                step={settings.qtyStep || 'any'}
                placeholder={t.qty.toFixed(4)}
                value={t.qtyOverridden ? t.qty : ''}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  updateDrawing(t.id, { qty: Number.isFinite(v) && v > 0 ? v : undefined } as Partial<PositionDrawing>);
                }}
                style={{ ...inputStyle, width: 70, padding: '1px 4px', fontSize: 10 }}
                title="Override size for this trade (blank = use default sizing)"
              />
              <span title="Net $ at SL / TP">{usd(t.slNet)} / {usd(t.tpNet)}</span>
            </div>
            {t.marginExceeded && (
              <div style={{ color: RED, fontSize: 9, marginTop: 2 }}>
                Margin {usd(t.margin)} exceeds equity {usd(t.equityBefore)} at {settings.leverage}x
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Account & sizing ──────────────────────────────────────── */}
      <div style={section}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Account</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <div><span style={label}>Capital ($)</span>{num('initialCapital', '100')}</div>
          <div><span style={label}>Leverage (x)</span>{num('leverage', '1')}</div>
          <div style={{ gridColumn: '1 / span 2' }}>
            <span style={label}>Position size</span>
            <select
              value={settings.sizeMode}
              onChange={e => setSettings({ sizeMode: e.target.value as ManualTradeSettings['sizeMode'] })}
              style={inputStyle}
            >
              <option value="qty">Fixed quantity (BTC)</option>
              <option value="notional">Fixed position value ($)</option>
              <option value="riskPct">Risk % of equity at SL</option>
            </select>
          </div>
          <div>
            <span style={label}>{settings.sizeMode === 'qty' ? 'Qty (BTC)' : settings.sizeMode === 'notional' ? 'Value ($)' : 'Risk (%)'}</span>
            {num('sizeValue')}
          </div>
          <div><span style={label}>Qty step</span>{num('qtyStep', '0.001')}</div>
          <div><span style={label}>Default SL (pts)</span>{num('replaySlPoints', '10')}</div>
          <div><span style={label}>Default R:R</span>{num('replayRR', '0.5')}</div>
        </div>
      </div>

      {/* ── Fees ──────────────────────────────────────────────────── */}
      <div style={section}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Bybit fees</div>
        <select
          value={settings.feeMode}
          onChange={e => setSettings({ feeMode: e.target.value as ManualTradeSettings['feeMode'] })}
          style={{ ...inputStyle, marginBottom: 6 }}
        >
          <option value="percent">Fee rate (% of position value)</option>
          <option value="points">Fixed round-trip points</option>
        </select>
        {settings.feeMode === 'percent' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <div><span style={label}>Entry fee %</span>{num('entryFeePct', '0.005')}</div>
              <div><span style={label}>Exit fee %</span>{num('exitFeePct', '0.005')}</div>
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
              <button style={btn('transparent', text)} onClick={() => setSettings({ entryFeePct: 0.055, exitFeePct: 0.055 })}>Taker/Taker</button>
              <button style={btn('transparent', text)} onClick={() => setSettings({ entryFeePct: 0.02, exitFeePct: 0.055 })}>Maker/Taker</button>
              <button style={btn('transparent', text)} onClick={() => setSettings({ entryFeePct: 0.02, exitFeePct: 0.02 })}>Maker/Maker</button>
            </div>
          </>
        ) : (
          <div><span style={label}>Round-trip cost (points per 1 BTC)</span>{num('roundTripPoints', '1')}</div>
        )}
        {lastClose > 0 && (
          <div style={{ fontSize: 10, opacity: 0.75, marginTop: 6 }}>
            Break-even ≈ <b>{bePts.toFixed(1)} pts</b> at {lastClose.toFixed(1)} (any size)
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <span style={label}>TP & SL hit in same candle</span>
          <select
            value={settings.sameBarRule}
            onChange={e => setSettings({ sameBarRule: e.target.value as ManualTradeSettings['sameBarRule'] })}
            style={inputStyle}
          >
            <option value="sl_first">Assume SL first (conservative)</option>
            <option value="tp_first">Assume TP first</option>
          </select>
        </div>
        <button style={{ ...btn('transparent', text), marginTop: 6, width: '100%' }} onClick={resetSettings}>Reset to Bybit defaults</button>
      </div>

      {/* ── Sessions ──────────────────────────────────────────────── */}
      <div style={section}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Saved sessions</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <input
            placeholder="Session name"
            value={sessionName}
            onChange={e => setSessionName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button style={btn(ACCENT)} onClick={handleSave}>Save</button>
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <button
            style={{ ...btn('transparent', text), flex: 1 }}
            onClick={() => {
              if (!positions.length) { flash('No positions on the chart'); return; }
              downloadSession(buildSession(sessionName.trim() || `manual-backtest-${new Date().toISOString().slice(0, 10)}`));
            }}
          >⬇ Export file</button>
          <button style={{ ...btn('transparent', text), flex: 1 }} onClick={() => fileRef.current?.click()}>⬆ Import file</button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleImport} />
        </div>
        {status && <div style={{ fontSize: 10, marginBottom: 6, color: ACCENT }}>{status}</div>}
        {sessions.length === 0 && <div style={{ opacity: 0.5, fontSize: 10 }}>No saved sessions.</div>}
        {sessions.map(s => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 0', borderTop: `1px solid ${inputBg}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
              <div style={{ fontSize: 9, opacity: 0.6 }}>
                {s.positions.length} trades{s.series ? ` · ${s.series.symbol} ${s.series.timeframe}` : ''} · {new Date(s.updatedAt).toLocaleDateString()}
              </div>
            </div>
            <button style={{ ...btn(ACCENT), padding: '2px 6px' }} onClick={() => loadSession(s)}>Load</button>
            <button style={{ ...btn('transparent', text), padding: '2px 6px' }} title="Download JSON" onClick={() => downloadSession(s)}>⬇</button>
            <button
              style={{ ...btn('transparent', RED), padding: '2px 6px' }}
              title="Delete"
              onClick={() => { if (confirm(`Delete session "${s.name}"?`)) deleteSession(s.id); }}
            >×</button>
          </div>
        ))}
      </div>
    </div>
  );
};
