/**
 * CycleBacktestPanel – sidebar config for the offset-cycle backtest.
 * Results open on a separate page (CycleBacktestPage); markers go on the chart.
 */
import React, { useContext, useEffect } from 'react';
import { useChartStore, ChartStoreContext, primaryChartStore } from '../store/chartStore';
import { useCycleBacktestStore } from '../store/cycleBacktestStore';
import type { CycleBacktestConfig } from '../engine/cycleBacktestEngine';

type NumKey = { [K in keyof CycleBacktestConfig]: CycleBacktestConfig[K] extends number ? K : never }[keyof CycleBacktestConfig];

const NUM_FIELDS: { key: NumKey; label: string; step: number; min: number; title?: string }[] = [
  { key: 'swingLR', label: 'Swing H/L strength', step: 1, min: 1, title: 'Bars on each side of a pivot (15 = your swing value)' },
  { key: 'entryOffsetBars', label: 'Entry shift (bars)', step: 1, min: -50, title: 'Negative = enter before the projected turn' },
  { key: 'atrPeriod', label: 'ATR period', step: 1, min: 1 },
  { key: 'stopAtrMult', label: 'Stop × ATR', step: 0.25, min: 0 },
  { key: 'stopPct', label: 'Stop %', step: 0.25, min: 0 },
  { key: 'minorSwingLR', label: 'Small swing strength', step: 1, min: 1, title: 'Stop sits at the last small swing low (long) / high (short) on the chart' },
  { key: 'takeProfitR', label: 'Take profit (R, 0=off)', step: 0.5, min: 0 },
  { key: 'maxHoldBars', label: 'Max bars held (0=off)', step: 1, min: 0 },
  { key: 'commissionBps', label: 'Commission (bps/side)', step: 0.5, min: 0 },
  { key: 'slippageBps', label: 'Slippage (bps/side)', step: 0.5, min: 0 },
  { key: 'hitToleranceBars', label: 'Timing tolerance (bars)', step: 1, min: 0 },
  { key: 'inSampleFraction', label: 'In-sample fraction', step: 0.05, min: 0.1 },
  { key: 'monteCarloRuns', label: 'Monte Carlo runs', step: 100, min: 0 },
];

function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export const CycleBacktestPanel: React.FC = () => {
  const chartApi = useContext(ChartStoreContext) ?? primaryChartStore;
  const { themeTokens: t, overlayConfigs, updateOverlayConfig, showBacktestSignals, toggleBacktestSignals } = useChartStore();
  const { config, setConfig, run, cancel, clear, running, progress, error, result, openPage, showChartStats, setShowChartStats } =
    useCycleBacktestStore();

  useEffect(() => {
    if (overlayConfigs.length && !overlayConfigs.some(o => o.id === config.overlayId)) {
      setConfig({ overlayId: overlayConfigs[0].id });
    }
  }, [overlayConfigs, config.overlayId, setConfig]);

  const text = t.axisText;
  const textPrimary = '#d1d4dc';
  const input: React.CSSProperties = {
    background: t.gridLineMajor, border: `1px solid ${t.gridLine}`, color: textPrimary,
    borderRadius: 4, padding: '3px 6px', fontSize: 12, width: 72, outline: 'none',
  };
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 };
  const label: React.CSSProperties = { color: text, fontSize: 11, flex: 1 };
  const btn = (bg: string): React.CSSProperties => ({
    background: bg, color: '#fff', border: 'none', borderRadius: 4, padding: '6px 10px',
    fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 1,
  });
  const selectedOverlay = overlayConfigs.find(o => o.id === config.overlayId);

  return (
    <div style={{ padding: '10px 12px', color: textPrimary, fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>🎯 Offset Cycle Backtest</div>
      <div style={{ color: text, fontSize: 11, marginBottom: 10, lineHeight: 1.4 }}>
        Projected swing <b>low</b> → long, projected swing <b>high</b> → short (stop-and-reverse).
        Fills at bar open with costs; validated with out-of-sample split, Monte Carlo phase test and a parameter sweep.
      </div>

      <div style={row}>
        <span style={label}>Offset overlay</span>
        <select
          value={config.overlayId}
          onChange={e => setConfig({ overlayId: e.target.value })}
          style={{ ...input, width: 140 }}
        >
          {!overlayConfigs.length && <option value="">— none —</option>}
          {overlayConfigs.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>

      <div style={row}>
        <span style={label}>Entry</span>
        <select
          value={config.entryMode}
          onChange={e => setConfig({ entryMode: e.target.value as CycleBacktestConfig['entryMode'] })}
          style={{ ...input, width: 140 }}
        >
          <option value="pivot_open">At projected pivot (open)</option>
          <option value="confirm_break">Confirm break, next open</option>
        </select>
      </div>

      <div style={row}>
        <span style={label}>Direction</span>
        <select
          value={config.direction}
          onChange={e => setConfig({ direction: e.target.value as CycleBacktestConfig['direction'] })}
          style={{ ...input, width: 140 }}
        >
          <option value="both">Long & short</option>
          <option value="long_only">Long only</option>
          <option value="short_only">Short only</option>
        </select>
      </div>

      <div style={row}>
        <span style={label}>Stop</span>
        <select
          value={config.stopMode}
          onChange={e => setConfig({ stopMode: e.target.value as CycleBacktestConfig['stopMode'] })}
          style={{ ...input, width: 140 }}
        >
          <option value="atr">ATR multiple</option>
          <option value="pct">Fixed %</option>
          <option value="swing">Previous small swing H/L</option>
          <option value="none">None (exit on next swing)</option>
        </select>
      </div>

      {NUM_FIELDS.filter(f =>
        !(f.key === 'stopAtrMult' || f.key === 'atrPeriod') || config.stopMode === 'atr',
      ).filter(f => f.key !== 'stopPct' || config.stopMode === 'pct')
        .filter(f => f.key !== 'minorSwingLR' || config.stopMode === 'swing').map(f => (
        <div key={f.key} style={row} title={f.title}>
          <span style={label}>{f.label}</span>
          <input
            type="number"
            step={f.step}
            min={f.min}
            value={config[f.key]}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!Number.isNaN(v)) setConfig({ [f.key]: v } as Partial<CycleBacktestConfig>);
            }}
            style={input}
          />
        </div>
      ))}

      {config.stopMode === 'swing' && (
        <label style={{ ...row, cursor: 'pointer' }} title="Raise (long) / lower (short) the stop to each new small swing that forms after entry">
          <input type="checkbox" checked={config.trailSwingStop} onChange={e => setConfig({ trailSwingStop: e.target.checked })} />
          <span style={label}>Trail to new small swings</span>
        </label>
      )}

      <label style={{ ...row, cursor: 'pointer' }} title="Only trade a projected pivot once the source bars confirming it had closed in real time">
        <input type="checkbox" checked={config.lookAheadGuard} onChange={e => setConfig({ lookAheadGuard: e.target.checked })} />
        <span style={label}>Look-ahead guard</span>
      </label>
      <label style={{ ...row, cursor: 'pointer' }} title="Keep only the most extreme of consecutive highs (or lows), exactly like the overlay's Swing H/L plot">
        <input type="checkbox" checked={config.matchOverlayPlot} onChange={e => setConfig({ matchOverlayPlot: e.target.checked })} />
        <span style={label}>Match overlay plot (merge swings)</span>
      </label>
      <label style={{ ...row, cursor: 'pointer' }}>
        <input type="checkbox" checked={config.runSweep} onChange={e => setConfig({ runSweep: e.target.checked })} />
        <span style={label}>Parameter sensitivity sweep</span>
      </label>

      {selectedOverlay && selectedOverlay.swingHLLeftRight !== config.swingLR && (
        <div style={{ color: '#f0b90b', fontSize: 11, marginBottom: 6, lineHeight: 1.4 }}>
          Overlay plots swing {selectedOverlay.swingHLLeftRight}, backtest uses {config.swingLR} — trades won't line up with the plot.
          <button
            onClick={() => setConfig({ swingLR: selectedOverlay.swingHLLeftRight })}
            style={{ ...btn('#434651'), width: '100%', marginTop: 4, flex: 'none' }}
          >
            Use overlay's swing {selectedOverlay.swingHLLeftRight}
          </button>
        </div>
      )}
      {config.stopMode !== 'none' && (
        <div style={{ color: text, fontSize: 11, marginBottom: 6, lineHeight: 1.4 }}>
          Stops add exits between swings. Set Stop to "None" for pure swing-to-swing trades.
        </div>
      )}

      {selectedOverlay && (
        <button
          onClick={() => updateOverlayConfig(selectedOverlay.id, { showSwingHL: true, swingHLLeftRight: config.swingLR })}
          style={{ ...btn('transparent'), border: `1px solid ${t.gridLine}`, color: text, width: '100%', marginBottom: 8 }}
          title="Draw the overlay's swing H/L with the same strength"
        >
          Show swing {config.swingLR} on overlay
        </button>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {running ? (
          <button onClick={cancel} style={btn('#ef5350')}>Cancel</button>
        ) : (
          <button onClick={() => run(chartApi)} style={btn('#2962ff')} disabled={!overlayConfigs.length}>Run backtest</button>
        )}
        {result && !running && <button onClick={clear} style={btn('#434651')}>Clear</button>}
      </div>

      {running && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ height: 4, background: t.gridLine, borderRadius: 2 }}>
            <div style={{ width: `${progress.pct}%`, height: '100%', background: '#2962ff', borderRadius: 2 }} />
          </div>
          <div style={{ color: text, fontSize: 11, marginTop: 4 }}>{progress.label}</div>
        </div>
      )}
      {error && <div style={{ color: '#ef5350', fontSize: 11, marginBottom: 8 }}>{error}</div>}

      {result && !running && (
        <div style={{ border: `1px solid ${t.gridLine}`, borderRadius: 4, padding: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 11 }}>
            <span style={{ color: text }}>Net return</span>
            <span style={{ color: result.metrics.totalReturnPct >= 0 ? '#26a69a' : '#ef5350' }}>{fmtPct(result.metrics.totalReturnPct)}</span>
            <span style={{ color: text }}>Trades / win %</span>
            <span>{result.metrics.trades} / {result.metrics.winRatePct.toFixed(1)}%</span>
            <span style={{ color: text }}>Sharpe</span>
            <span>{result.metrics.sharpe.toFixed(2)}</span>
            <span style={{ color: text }}>Max DD</span>
            <span>{result.metrics.maxDrawdownPct.toFixed(2)}%</span>
            <span style={{ color: text }}>MC p-value</span>
            <span>{result.monteCarlo ? result.monteCarlo.returnPValue.toFixed(3) : '—'}</span>
          </div>
          <button onClick={openPage} style={{ ...btn('#2962ff'), width: '100%', marginTop: 8 }}>Open full report ↗</button>
          <label style={{ ...row, marginTop: 8, marginBottom: 2, cursor: 'pointer' }}>
            <input type="checkbox" checked={showBacktestSignals} onChange={toggleBacktestSignals} />
            <span style={label}>Buy/sell markers on chart</span>
          </label>
          <label style={{ ...row, marginBottom: 0, cursor: 'pointer' }}>
            <input type="checkbox" checked={showChartStats} onChange={e => setShowChartStats(e.target.checked)} />
            <span style={label}>Stats box on chart</span>
          </label>
        </div>
      )}
    </div>
  );
};
