/**
 * ChartPicker — the everyday "open a chart" surface.
 *
 * Reads only from IndexedDB. Two lists side-by-side:
 *   • Saved layouts    – click to load with drawings/indicators/viewport.
 *   • Series in DB     – market/symbol/timeframe. TF list is derived from
 *                        availableTimeframes + resample fallback.
 *
 * If nothing is selectable yet the user is nudged toward "+ Ingest data",
 * which opens the IngestionPanel.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import {
  ensureMarkets,
  listMarketsForPicker,
  refreshManifest,
  selectableTimeframes,
  type PickerMarket,
} from '../db/marketDb';
import { listLayoutsDb } from '../db/marketStore';
import { openSeries, openLayout, setDefaultLayout, getDefaultLayoutId } from '../store/chartSession';
import type { ChartLayout, Timeframe } from '../types';
import { TIMEFRAME_MINUTES } from '../engine/calendarEngine';
import { IngestionPanel } from './IngestionPanel';

// History-depth options, days each. `null` = load everything the DB has.
interface DepthOption { label: string; days: number | null; }
const DEPTH_OPTIONS: DepthOption[] = [
  { label: 'Last 1 month',  days: 30 },
  { label: 'Last 3 months', days: 91 },
  { label: 'Last 6 months', days: 182 },
  { label: 'Last 1 year',   days: 365 },
  { label: 'Last 2 years',  days: 730 },
  { label: 'Last 3 years',  days: 1095 },
  { label: 'Last 5 years',  days: 1826 },
  { label: 'Last 7 years',  days: 2556 },
  { label: 'Last 10 years', days: 3653 },
  { label: 'Last 15 years', days: 5479 },
  { label: 'Last 20 years', days: 7305 },
  { label: 'All history',   days: null },
];

// Smart default depth per TF, chosen so first-open never blows past ~50k bars
// even on high-frequency TFs (browser stays responsive under ~200k slots).
const DEFAULT_DEPTH_DAYS: Record<Timeframe, number | null> = {
  '1m':  30,
  '5m':  91,
  '10m': 182,
  '15m': 365,
  '1h':  1826,   // 5y
  '4h':  3653,   // 10y
  '1d':  null,   // all history
  '1w':  null,
  '1M':  null,
};

const LS_DEPTH_KEY = 'chartfin.picker.depthDaysByTf.v1';

function readSavedDepth(): Partial<Record<Timeframe, number | null>> {
  try {
    const raw = localStorage.getItem(LS_DEPTH_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeSavedDepth(map: Partial<Record<Timeframe, number | null>>): void {
  try { localStorage.setItem(LS_DEPTH_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

// Convert (tf, days) → target bar count. `null` days means unlimited.
function depthToBarCount(tf: Timeframe, days: number | null): number {
  if (days === null) return Infinity;
  const barsPerDay = (60 * 24) / TIMEFRAME_MINUTES[tf];
  return Math.ceil(days * barsPerDay);
}

export const ChartPicker: React.FC = () => {
  const { theme } = useChartStore();
  const [open, setOpen]         = useState(false);
  const [ingestOpen, setIngest] = useState(false);
  const [markets, setMarkets]   = useState<PickerMarket[]>([]);
  const [layouts, setLayouts]   = useState<ChartLayout[]>([]);
  const [defaultId, setDefaultId] = useState<string | undefined>(undefined);
  const [marketId, setMarketId] = useState<string>('forex');
  const [symbol, setSymbol]     = useState<string>('');
  const [tf, setTf]             = useState<Timeframe>('1d');
  const [depthDays, setDepthDays] = useState<number | null>(null);
  const [status, setStatus]     = useState<string>('');
  const [busy, setBusy]         = useState(false);

  const bg     = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const bgCard = theme === 'dark' ? '#131722' : '#ffffff';
  const text   = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#c8cad5';
  const accent = '#2962ff';

  const refresh = useCallback(async () => {
    const [m, l, d] = await Promise.all([
      listMarketsForPicker(),
      listLayoutsDb(),
      getDefaultLayoutId(),
    ]);
    setMarkets(m);
    setLayouts(l);
    setDefaultId(d);
  }, []);

  useEffect(() => {
    if (!open) return;
    (async () => {
      await ensureMarkets();
      await refresh();
    })();
  }, [open, refresh]);

  // Auto-refresh the picker as background ingest progresses so newly-ready
  // symbols flip from "pending" → "ready" without a manual reopen.
  useEffect(() => {
    if (!open) return;
    let lastRefresh = 0;
    const handler = () => {
      const now = performance.now();
      if (now - lastRefresh < 800) return; // throttle
      lastRefresh = now;
      void refresh();
    };
    window.addEventListener('manifest-ingest-progress', handler);
    return () => window.removeEventListener('manifest-ingest-progress', handler);
  }, [open, refresh]);

  const currentMarket = useMemo(
    () => markets.find(m => m.id === marketId),
    [markets, marketId],
  );
  const currentSymbolRecord = useMemo(
    () => currentMarket?.symbols.find(s => s.symbol === symbol),
    [currentMarket, symbol],
  );
  const tfOptions = useMemo(
    () => selectableTimeframes(currentSymbolRecord),
    [currentSymbolRecord],
  );

  // Auto-pick first symbol/TF when market changes.
  useEffect(() => {
    if (!currentMarket) return;
    if (currentMarket.symbols.length === 0) { setSymbol(''); return; }
    if (!currentMarket.symbols.find(s => s.symbol === symbol)) {
      const first = currentMarket.symbols[0];
      setSymbol(first.symbol);
      setTf(first.baseTimeframe);
    }
  }, [currentMarket, symbol]);

  useEffect(() => {
    if (tfOptions.length === 0) return;
    if (!tfOptions.includes(tf)) setTf(tfOptions[tfOptions.length - 1]);
  }, [tfOptions, tf]);

  // History depth: per-TF smart default, overridable, persisted in localStorage.
  useEffect(() => {
    const saved = readSavedDepth();
    const days = saved[tf] !== undefined ? saved[tf]! : DEFAULT_DEPTH_DAYS[tf];
    setDepthDays(days);
  }, [tf]);

  const handleOpenSeries = useCallback(async () => {
    if (!symbol) { setStatus('No symbol selected'); return; }
    // Persist the user's choice for this TF so next open reuses it.
    const saved = readSavedDepth();
    saved[tf] = depthDays;
    writeSavedDepth(saved);

    const targetBars = depthToBarCount(tf, depthDays);
    setBusy(true);
    const t0 = performance.now();
    try {
      // openSeries → loadInitialCandles will hit the IDB cache first and
      // fall back to fetching the CSV directly from the manifest URL if
      // the cache is empty. No manual pre-ingest needed.
      setStatus(depthDays === null
        ? 'Loading full history…'
        : `Loading last ${depthDays}d (~${targetBars.toLocaleString()} bars)…`);
      const res = await openSeries(marketId, symbol, tf, targetBars);
      if (!res.ok) { setStatus(res.message ?? 'Failed'); setBusy(false); return; }
      const dt = (performance.now() - t0).toFixed(1);
      setStatus(`✓ ${res.rows.toLocaleString()} bars · ${dt} ms${res.resampled ? ` · resampled from ${res.sourceTimeframe}` : ''}`);
      setOpen(false);
    } catch (e) {
      setStatus(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [marketId, symbol, tf, depthDays]);

  const handleOpenLayout = useCallback(async (layout: ChartLayout) => {
    setBusy(true); setStatus(`Loading "${layout.name}"…`);
    try {
      const res = await openLayout(layout);
      setStatus(res.rows > 0
        ? `✓ Loaded "${layout.name}" · ${res.rows} bars`
        : `✓ Loaded "${layout.name}" (no series)`);
      setOpen(false);
    } catch (e) {
      setStatus(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRescan = useCallback(async () => {
    setStatus('Refreshing symbol list from manifest…');
    refreshManifest();  // Drop the cached manifest so next call re-fetches.
    await refresh();
    setStatus('Symbol list refreshed. Pick a symbol to load it.');
  }, [refresh]);

  const handleTogglePin = useCallback(async (e: React.MouseEvent, layout: ChartLayout) => {
    e.stopPropagation();
    const next = defaultId === layout.id ? null : layout.id;
    await setDefaultLayout(next);
    setDefaultId(next ?? undefined);
  }, [defaultId]);

  const btnStyle: React.CSSProperties = {
    background: 'transparent', color: text, border: `1px solid ${border}`,
    borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
  };

  return (
    <>
      <button style={btnStyle} onClick={() => setOpen(true)} title="Open a chart from the local DB or a saved layout">
        📈 Open chart
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: bg, color: text, border: `1px solid ${border}`, borderRadius: 8,
              padding: 16, width: 720, maxHeight: '80vh', overflow: 'auto',
              boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Open chart</h3>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btnStyle} onClick={handleRescan} disabled={busy}
                        title="Re-read public/data/markets/manifest.json — picks up files added by Python scripts.">
                  ↻ Rescan disk
                </button>
                <button style={btnStyle} onClick={() => { setIngest(true); }}>+ Ingest data</button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {/* Saved layouts */}
              <section>
                <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>Saved layouts</div>
                {layouts.length === 0
                  ? <div style={{ opacity: 0.5, fontSize: 12 }}>None yet.</div>
                  : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {layouts.map(l => {
                        const pinned = defaultId === l.id;
                        return (
                          <div
                            key={l.id}
                            style={{ display: 'flex', gap: 4 }}
                          >
                            <button
                              onClick={() => handleOpenLayout(l)}
                              style={{ ...btnStyle, textAlign: 'left', background: bgCard, flex: 1 }}
                            >
                              <div style={{ fontSize: 12 }}>
                                {pinned ? '★ ' : ''}{l.name}
                              </div>
                              <div style={{ fontSize: 10, opacity: 0.6 }}>
                                {l.timeframe}
                                {l.series ? ` · ${l.series.market}/${l.series.symbol}` : ''}
                                {' · '}{new Date(l.updatedAt).toLocaleString()}
                              </div>
                            </button>
                            <button
                              onClick={e => handleTogglePin(e, l)}
                              title={pinned ? 'Unpin default' : 'Pin as default (loads on boot)'}
                              style={{ ...btnStyle, padding: '4px 8px' }}
                            >
                              {pinned ? '★' : '☆'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )
                }
              </section>

              {/* Series in DB */}
              <section>
                <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>Series in DB</div>
                <label style={{ fontSize: 11, opacity: 0.7 }}>Market</label>
                <select
                  value={marketId}
                  onChange={e => setMarketId(e.target.value)}
                  style={{ ...btnStyle, width: '100%', marginBottom: 6 }}
                >
                  {markets.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>

                <label style={{ fontSize: 11, opacity: 0.7 }}>Symbol</label>
                <select
                  value={symbol}
                  onChange={e => setSymbol(e.target.value)}
                  style={{ ...btnStyle, width: '100%', marginBottom: 6 }}
                >
                  {(currentMarket?.symbols ?? []).map(s => {
                    // Every symbol advertised in the manifest is loadable
                    // (the CSV fetch fallback covers the "not yet cached"
                    // case transparently). Show the TFs the manifest has;
                    // no more "pending" gate.
                    const tfs = (s.availableTimeframes ?? []).join(', ') || 'no data';
                    const cached = s.status === 'ready' ? ' ✓' : '';
                    return (
                      <option key={s.symbol} value={s.symbol}>
                        {s.symbol} ({tfs}){cached}
                      </option>
                    );
                  })}
                  {(currentMarket?.symbols.length ?? 0) === 0 && <option value="">(none)</option>}
                </select>

                <label style={{ fontSize: 11, opacity: 0.7 }}>Timeframe</label>
                <select
                  value={tf}
                  onChange={e => setTf(e.target.value as Timeframe)}
                  disabled={tfOptions.length === 0}
                  style={{ ...btnStyle, width: '100%', marginBottom: 4 }}
                >
                  {tfOptions.map(o => {
                    const stored = (currentSymbolRecord?.availableTimeframes ?? []).includes(o);
                    const src = currentSymbolRecord?.exchangeByTf?.[o];
                    const suffix = src ? ` — ${src}` : (stored ? '' : ' (derived)');
                    return <option key={o} value={o}>{o}{suffix}</option>;
                  })}
                </select>
                {(() => {
                  const src = currentSymbolRecord?.exchangeByTf?.[tf];
                  return src ? (
                    <div style={{ fontSize: 10, opacity: 0.65, marginBottom: 10 }}>
                      source: {src}
                    </div>
                  ) : <div style={{ marginBottom: 10 }} />;
                })()}

                <label style={{ fontSize: 11, opacity: 0.7 }}>
                  History depth
                  {currentSymbolRecord?.candleCount && (
                    <span style={{ opacity: 0.55, marginLeft: 6 }}>
                      · DB has {currentSymbolRecord.candleCount.toLocaleString()} {currentSymbolRecord.baseTimeframe} bars
                    </span>
                  )}
                </label>
                <select
                  value={depthDays === null ? 'all' : String(depthDays)}
                  onChange={e => setDepthDays(e.target.value === 'all' ? null : Number(e.target.value))}
                  style={{ ...btnStyle, width: '100%', marginBottom: 4 }}
                >
                  {DEPTH_OPTIONS.map(o => {
                    const bars = depthToBarCount(tf, o.days);
                    const barsLabel = bars === Infinity ? 'all' : `~${bars.toLocaleString()} bars`;
                    return (
                      <option key={o.label} value={o.days === null ? 'all' : String(o.days)}>
                        {o.label}  ({barsLabel})
                      </option>
                    );
                  })}
                </select>
                {(() => {
                  const bars = depthToBarCount(tf, depthDays);
                  if (bars > 500_000) {
                    return (
                      <div style={{ fontSize: 10, color: '#ff9800', marginBottom: 6 }}>
                        ⚠ {bars.toLocaleString()} bars may slow the browser. Consider a shorter window.
                      </div>
                    );
                  }
                  return <div style={{ marginBottom: 6 }} />;
                })()}

                <button
                  onClick={handleOpenSeries}
                  disabled={busy || !symbol}
                  style={{
                    ...btnStyle,
                    background: symbol ? accent : 'transparent',
                    color: symbol ? '#fff' : text,
                    borderColor: symbol ? accent : border,
                    width: '100%',
                    opacity: (busy || !symbol) ? 0.6 : 1,
                  }}
                >
                  {busy ? 'Loading…' : (depthDays === null
                    ? 'Open (all history)'
                    : `Open (last ${depthDays >= 365 ? `${(depthDays/365).toFixed(depthDays % 365 ? 1 : 0)}y` : `${depthDays}d`})`)}
                </button>
              </section>
            </div>

            {status && <div style={{ marginTop: 12, fontSize: 11, opacity: 0.8 }}>{status}</div>}
          </div>
        </div>
      )}

      {ingestOpen && (
        <IngestionPanel
          initial={{ market: marketId, symbol, timeframe: tf }}
          onClose={async (didIngest) => {
            setIngest(false);
            if (didIngest) await refresh();
          }}
        />
      )}
    </>
  );
};
