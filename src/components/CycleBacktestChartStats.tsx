/**
 * CycleBacktestChartStats – compact stats box drawn over the chart while an
 * offset-cycle backtest result is active. Full report: CycleBacktestPage.
 */
import React from 'react';
import { useCycleBacktestStore } from '../store/cycleBacktestStore';

export const CycleBacktestChartStats: React.FC = () => {
  const { result, showChartStats, setShowChartStats, openPage } = useCycleBacktestStore();
  if (!result || !showChartStats) return null;
  const m = result.metrics;
  const color = (v: number) => (v >= 0 ? '#26a69a' : '#ef5350');
  const rows: [string, string, string?][] = [
    ['Net', `${m.totalReturnPct >= 0 ? '+' : ''}${m.totalReturnPct.toFixed(2)}%`, color(m.totalReturnPct)],
    ['B&H', `${result.benchmark.totalReturnPct >= 0 ? '+' : ''}${result.benchmark.totalReturnPct.toFixed(2)}%`],
    ['Trades', `${m.trades} (${m.long.trades}L / ${m.short.trades}S)`],
    ['Win rate', `${m.winRatePct.toFixed(1)}%`],
    ['Profit factor', Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'],
    ['Sharpe', m.sharpe.toFixed(2)],
    ['Max DD', `${m.maxDrawdownPct.toFixed(2)}%`, '#ef5350'],
    ['Timing hit', `${result.timing.hitRatePct.toFixed(0)}% ±${result.timing.toleranceBars}`],
    ['MC p-value', result.monteCarlo ? result.monteCarlo.returnPValue.toFixed(3) : '—'],
  ];

  return (
    <div
      style={{
        position: 'absolute',
        left: 8,
        bottom: 36,
        zIndex: 5,
        background: 'rgba(19,23,34,0.88)',
        border: '1px solid #2a2e39',
        borderRadius: 6,
        padding: '8px 10px',
        color: '#d1d4dc',
        fontSize: 11,
        minWidth: 190,
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6, gap: 6 }}>
        <b style={{ flex: 1 }}>🎯 Cycle swing {result.config.swingLR} · {result.meta.overlayLabel}</b>
        <button
          onClick={() => setShowChartStats(false)}
          title="Hide"
          style={{ background: 'none', border: 'none', color: '#9598a1', cursor: 'pointer', fontSize: 12, padding: 0 }}
        >
          ✕
        </button>
      </div>
      {rows.map(([k, v, c]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, lineHeight: 1.6 }}>
          <span style={{ color: '#9598a1' }}>{k}</span>
          <span style={{ color: c ?? '#d1d4dc', fontWeight: 600 }}>{v}</span>
        </div>
      ))}
      <button
        onClick={openPage}
        style={{ marginTop: 6, width: '100%', background: '#2962ff', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 0', cursor: 'pointer', fontSize: 11 }}
      >
        Full report ↗
      </button>
    </div>
  );
};
