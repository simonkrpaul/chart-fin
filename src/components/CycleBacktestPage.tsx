/**
 * CycleBacktestPage – full-page institutional-style report for the offset
 * cycle backtest (route: #cycle-report). Rendered instead of the chart UI.
 */
import React, { useMemo } from 'react';
import { useChartStore } from '../store/chartStore';
import { useCycleBacktestStore } from '../store/cycleBacktestStore';
import type { CycleBacktestResult, PerfMetrics } from '../engine/cycleBacktestEngine';

const GREEN = '#26a69a';
const RED = '#ef5350';
const BLUE = '#2962ff';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmtDate = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const fmtDateTime = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
const pct = (v: number, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}%` : '—');
const num = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '∞');
const signColor = (v: number) => (v > 0 ? GREEN : v < 0 ? RED : undefined);

function verdict(r: CycleBacktestResult): { label: string; color: string; reasons: string[] } {
  const reasons: string[] = [];
  const p = r.monteCarlo?.returnPValue ?? 1;
  const enoughTrades = r.metrics.trades >= 30;
  const oosOk = r.outOfSample.totalReturnPct > 0 && r.outOfSample.trades > 0;
  const beatsBh = r.metrics.sharpe > r.benchmark.sharpe;
  reasons.push(`${r.metrics.trades} trades ${enoughTrades ? '(≥30, OK)' : '(<30, too few for significance)'}`);
  reasons.push(`Monte Carlo p-value ${r.monteCarlo ? p.toFixed(3) : 'n/a'} ${p < 0.05 ? '(cycle timing beats random phase)' : '(not distinguishable from random phase)'}`);
  reasons.push(`Out-of-sample return ${pct(r.outOfSample.totalReturnPct)} ${oosOk ? '(holds up)' : '(does not hold up)'}`);
  reasons.push(`Sharpe ${num(r.metrics.sharpe)} vs buy & hold ${num(r.benchmark.sharpe)}`);
  if (enoughTrades && p < 0.05 && oosOk && beatsBh) return { label: 'Statistically significant edge', color: GREEN, reasons };
  if (p < 0.1 && oosOk) return { label: 'Weak / inconclusive evidence', color: '#f0b90b', reasons };
  return { label: 'No statistical edge', color: RED, reasons };
}

function exportCsv(r: CycleBacktestResult) {
  const head = 'id,direction,entry_time,entry_price,exit_time,exit_price,stop,return_pct,bars,exit_reason,mae_pct,mfe_pct,equity_after\n';
  const rows = r.trades.map(t => [
    t.id, t.direction, new Date(t.entryTs).toISOString(), t.entryPrice, new Date(t.exitTs).toISOString(), t.exitPrice,
    t.stopPrice ?? '', t.returnPct.toFixed(4), t.bars, t.exitReason, t.maePct.toFixed(4), t.mfePct.toFixed(4), t.equityAfter.toFixed(4),
  ].join(','));
  const blob = new Blob([head + rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cycle-backtest-${r.meta.overlayLabel.replace(/\W+/g, '_')}-${fmtDate(r.generatedAt)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─────────────────────────────────────────────────────────────────────────────
// Charts (plain SVG)
// ─────────────────────────────────────────────────────────────────────────────

const LineChart: React.FC<{
  series: { values: number[]; color: string; label: string }[];
  xs: number[];
  height: number;
  grid: string;
  text: string;
  markerX?: number;
  fillBelowZero?: boolean;
}> = ({ series, xs, height, grid, text, markerX, fillBelowZero }) => {
  const W = 1000;
  const H = height;
  const all = series.flatMap(s => s.values).filter(Number.isFinite);
  if (!all.length || xs.length < 2) return null;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const x0 = xs[0];
  const xSpan = xs[xs.length - 1] - x0 || 1;
  const X = (v: number) => ((v - x0) / xSpan) * W;
  const Y = (v: number) => H - 4 - ((v - min) / span) * (H - 8);
  const ticks = [min, min + span / 2, max];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block' }}>
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={0} x2={W} y1={Y(tv)} y2={Y(tv)} stroke={grid} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <text x={4} y={Y(tv) - 2} fill={text} fontSize={11}>{tv.toFixed(1)}</text>
        </g>
      ))}
      {markerX !== undefined && (
        <line x1={X(markerX)} x2={X(markerX)} y1={0} y2={H} stroke="#f0b90b" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      )}
      {series.map(s => {
        const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('');
        return (
          <g key={s.label}>
            {fillBelowZero && <path d={`${d}L${W},${Y(0)}L0,${Y(0)}Z`} fill={s.color} opacity={0.25} />}
            <path d={d} fill="none" stroke={s.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </svg>
  );
};

const Histogram: React.FC<{ bins: { from: number; to: number; count: number }[]; actual: number; text: string }> = ({ bins, actual, text }) => {
  const W = 1000;
  const H = 160;
  const maxC = Math.max(1, ...bins.map(b => b.count));
  const lo = bins[0].from;
  const hi = bins[bins.length - 1].to;
  const X = (v: number) => ((v - lo) / (hi - lo || 1)) * W;
  const bw = W / bins.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} preserveAspectRatio="none" style={{ width: '100%', height: H + 18, display: 'block' }}>
      {bins.map((b, i) => {
        const h = (b.count / maxC) * (H - 10);
        return <rect key={i} x={i * bw + 1} y={H - h} width={bw - 2} height={h} fill="#5d606b" />;
      })}
      <line x1={X(actual)} x2={X(actual)} y1={0} y2={H} stroke={BLUE} strokeWidth={3} vectorEffect="non-scaling-stroke" />
      <text x={Math.min(W - 160, X(actual) + 6)} y={14} fill={BLUE} fontSize={12}>actual {pct(actual)}</text>
      <text x={0} y={H + 14} fill={text} fontSize={11}>{pct(lo, 0)}</text>
      <text x={W - 60} y={H + 14} fill={text} fontSize={11}>{pct(hi, 0)}</text>
    </svg>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export const CycleBacktestPage: React.FC = () => {
  const { themeTokens: t } = useChartStore();
  const { result, closePage } = useCycleBacktestStore();
  const bg = t.background;
  const border = t.gridLine;
  const text = t.axisText;
  const fg = '#d1d4dc';

  const card: React.CSSProperties = { border: `1px solid ${border}`, borderRadius: 6, padding: 14, marginBottom: 14, background: bg };
  const h2: React.CSSProperties = { fontSize: 14, fontWeight: 600, margin: '0 0 10px', color: fg };
  const th: React.CSSProperties = { textAlign: 'left', color: text, fontWeight: 500, padding: '4px 8px', borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '4px 8px', borderBottom: `1px solid ${border}`, whiteSpace: 'nowrap' };

  const curve = useMemo(() => {
    if (!result) return null;
    const xs = result.equityCurve.map(p => p.ts);
    return {
      xs,
      eq: result.equityCurve.map(p => p.equity),
      bh: result.equityCurve.map(p => p.benchmark),
      dd: result.equityCurve.map(p => p.drawdownPct),
    };
  }, [result]);

  if (!result || !curve) {
    return (
      <div style={{ flex: 1, background: bg, color: fg, padding: 40 }}>
        <button onClick={closePage} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer' }}>← Back to chart</button>
        <p style={{ color: text, marginTop: 20 }}>No cycle backtest result yet. Run one from the 🎯 Cycle Backtest tab in the sidebar.</p>
      </div>
    );
  }

  const r = result;
  const m = r.metrics;
  const v = verdict(r);
  const mc = r.monteCarlo;

  const kpis: [string, string, string | undefined][] = [
    ['Net return', pct(m.totalReturnPct), signColor(m.totalReturnPct)],
    ['CAGR', pct(m.cagrPct), signColor(m.cagrPct)],
    ['Sharpe (ann.)', num(m.sharpe), signColor(m.sharpe)],
    ['Sortino', num(m.sortino), undefined],
    ['Calmar', num(m.calmar), undefined],
    ['Max drawdown', `${m.maxDrawdownPct.toFixed(2)}%`, RED],
    ['Longest DD', `${m.maxDrawdownDays.toFixed(0)} d`, undefined],
    ['Ann. volatility', `${m.annVolPct.toFixed(2)}%`, undefined],
    ['Trades', String(m.trades), undefined],
    ['Win rate', `${m.winRatePct.toFixed(1)}%`, undefined],
    ['Profit factor', num(m.profitFactor), signColor(m.profitFactor - 1)],
    ['Expectancy / trade', pct(m.expectancyPct, 3), signColor(m.expectancyPct)],
    ['Payoff ratio', num(m.payoffRatio), undefined],
    ['t-stat (trades)', num(m.tStat), undefined],
    ['Exposure', `${m.exposurePct.toFixed(1)}%`, undefined],
    ['Trades / year', num(m.tradesPerYear, 1), undefined],
  ];

  const perfRows: [string, (p: PerfMetrics) => string][] = [
    ['Period', p => `${fmtDate(p.startTs)} → ${fmtDate(p.endTs)}`],
    ['Return', p => pct(p.totalReturnPct)],
    ['CAGR', p => pct(p.cagrPct)],
    ['Sharpe', p => num(p.sharpe)],
    ['Max DD', p => `${p.maxDrawdownPct.toFixed(2)}%`],
    ['Trades', p => String(p.trades)],
    ['Win rate', p => `${p.winRatePct.toFixed(1)}%`],
    ['Profit factor', p => num(p.profitFactor)],
    ['Expectancy', p => pct(p.expectancyPct, 3)],
  ];

  const sweepMax = Math.max(1, ...r.sweep.map(c => Math.abs(c.totalReturnPct)));
  const sweepCell = (lr: number, off: number) => r.sweep.find(c => c.swingLR === lr && c.offset === off);
  const positiveCells = r.sweep.filter(c => c.totalReturnPct > 0).length;

  return (
    <div style={{ flex: 1, overflow: 'auto', background: bg, color: fg, fontSize: 12 }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '16px 20px 40px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <button onClick={closePage} style={{ background: BLUE, color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontWeight: 600 }}>← Back to chart</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Offset Cycle Backtest Report</div>
            <div style={{ color: text }}>
              {r.meta.overlayLabel} · offset {r.meta.offsetDays} d · {r.meta.timeframe} · swing {r.config.swingLR} ·{' '}
              {r.config.entryMode === 'pivot_open' ? 'enter at projected pivot' : 'confirm-break entry'} · {fmtDate(r.meta.fromTs)} → {fmtDate(r.meta.toTs)} · {r.meta.bars.toLocaleString()} bars
            </div>
          </div>
          <button onClick={() => exportCsv(r)} style={{ background: 'transparent', color: fg, border: `1px solid ${border}`, borderRadius: 4, padding: '6px 12px', cursor: 'pointer' }}>Export trades CSV</button>
        </div>

        {/* Verdict */}
        <div style={{ ...card, borderColor: v.color }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: v.color, marginBottom: 6 }}>{v.label}</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: text, lineHeight: 1.6 }}>
            {v.reasons.map(x => <li key={x}>{x}</li>)}
          </ul>
          {r.warnings.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: '#f0b90b', lineHeight: 1.6 }}>
              {r.warnings.map(w => <li key={w}>{w}</li>)}
            </ul>
          )}
        </div>

        {/* KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
          {kpis.map(([k, val, c]) => (
            <div key={k} style={{ border: `1px solid ${border}`, borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ color: text, fontSize: 11 }}>{k}</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: c ?? fg }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Equity */}
        <div style={card}>
          <h2 style={h2}>
            Equity (strategy <span style={{ color: BLUE }}>━</span> vs buy &amp; hold <span style={{ color: '#9598a1' }}>━</span>, base 100) ·{' '}
            <span style={{ color: '#f0b90b' }}>┆ in-sample / out-of-sample split {fmtDate(r.splitTs)}</span>
          </h2>
          <LineChart
            xs={curve.xs}
            height={260}
            grid={border}
            text={text}
            markerX={r.splitTs}
            series={[
              { values: curve.bh, color: '#9598a1', label: 'bh' },
              { values: curve.eq, color: BLUE, label: 'eq' },
            ]}
          />
          <div style={{ color: text, margin: '10px 0 4px' }}>Drawdown %</div>
          <LineChart xs={curve.xs} height={110} grid={border} text={text} fillBelowZero series={[{ values: curve.dd, color: RED, label: 'dd' }]} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 14 }}>
          {/* IS / OOS / Benchmark */}
          <div style={card}>
            <h2 style={h2}>Robustness: in-sample vs out-of-sample</h2>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr><th style={th} /><th style={th}>Full</th><th style={th}>In-sample</th><th style={th}>Out-of-sample</th></tr>
              </thead>
              <tbody>
                {perfRows.map(([k, f]) => (
                  <tr key={k}>
                    <td style={{ ...td, color: text }}>{k}</td>
                    <td style={td}>{f(m)}</td>
                    <td style={td}>{f(r.inSample)}</td>
                    <td style={td}>{f(r.outOfSample)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ color: text, marginTop: 10 }}>
              Buy &amp; hold: {pct(r.benchmark.totalReturnPct)} · CAGR {pct(r.benchmark.cagrPct)} · Sharpe {num(r.benchmark.sharpe)} · Max DD {r.benchmark.maxDrawdownPct.toFixed(2)}%
            </div>
          </div>

          {/* Trade stats */}
          <div style={card}>
            <h2 style={h2}>Trade statistics</h2>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr><th style={th} /><th style={th}>All</th><th style={th}>Long</th><th style={th}>Short</th></tr>
              </thead>
              <tbody>
                <tr><td style={{ ...td, color: text }}>Trades</td><td style={td}>{m.trades}</td><td style={td}>{m.long.trades}</td><td style={td}>{m.short.trades}</td></tr>
                <tr><td style={{ ...td, color: text }}>Win rate</td><td style={td}>{m.winRatePct.toFixed(1)}%</td><td style={td}>{m.long.winRatePct.toFixed(1)}%</td><td style={td}>{m.short.winRatePct.toFixed(1)}%</td></tr>
                <tr><td style={{ ...td, color: text }}>Avg trade</td><td style={td}>{pct(m.expectancyPct, 3)}</td><td style={td}>{pct(m.long.avgReturnPct, 3)}</td><td style={td}>{pct(m.short.avgReturnPct, 3)}</td></tr>
                <tr><td style={{ ...td, color: text }}>Compounded</td><td style={td}>{pct(m.totalReturnPct)}</td><td style={td}>{pct(m.long.totalReturnPct)}</td><td style={td}>{pct(m.short.totalReturnPct)}</td></tr>
                <tr><td style={{ ...td, color: text }}>Profit factor</td><td style={td}>{num(m.profitFactor)}</td><td style={td}>{num(m.long.profitFactor)}</td><td style={td}>{num(m.short.profitFactor)}</td></tr>
              </tbody>
            </table>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', marginTop: 10, color: text }}>
              <span>Avg win / loss: <b style={{ color: fg }}>{pct(m.avgWinPct)} / {pct(-m.avgLossPct)}</b></span>
              <span>Median trade: <b style={{ color: fg }}>{pct(m.medianTradePct, 3)}</b></span>
              <span>Best / worst: <b style={{ color: fg }}>{pct(m.bestTradePct)} / {pct(m.worstTradePct)}</b></span>
              <span>Max consec. W / L: <b style={{ color: fg }}>{m.maxConsecWins} / {m.maxConsecLosses}</b></span>
              <span>Avg bars held: <b style={{ color: fg }}>{m.avgBarsHeld.toFixed(1)}</b></span>
              <span>Avg MAE / MFE: <b style={{ color: fg }}>{pct(m.avgMaePct)} / {pct(m.avgMfePct)}</b></span>
            </div>
          </div>

          {/* Cycle timing */}
          <div style={card}>
            <h2 style={h2}>Cycle timing accuracy</h2>
            <div style={{ color: text, lineHeight: 1.7 }}>
              Projected swings in range: <b style={{ color: fg }}>{r.meta.pivotsInRange}</b> · traded <b style={{ color: fg }}>{r.meta.pivotsTraded}</b>
              {r.config.lookAheadGuard && <> · skipped (not yet confirmed) <b style={{ color: fg }}>{r.meta.pivotsSkippedLookahead}</b></>}
              <br />
              Hit rate (actual swing {r.config.swingLR} of same type within ±{r.timing.toleranceBars} bars):{' '}
              <b style={{ color: fg }}>{r.timing.hitRatePct.toFixed(1)}%</b> ({r.timing.hits}/{r.timing.evaluated})
              {mc && <> · random phase: <b style={{ color: fg }}>{mc.randomHitRatePct.toFixed(1)}%</b> · p = <b style={{ color: fg }}>{mc.hitRatePValue.toFixed(3)}</b></>}
              <br />
              Mean |error|: <b style={{ color: fg }}>{r.timing.meanAbsErrBars.toFixed(1)} bars</b> · median <b style={{ color: fg }}>{r.timing.medianAbsErrBars.toFixed(1)}</b> · bias{' '}
              <b style={{ color: fg }}>{r.timing.meanSignedErrBars >= 0 ? '+' : ''}{r.timing.meanSignedErrBars.toFixed(1)} bars</b>{' '}
              ({r.timing.meanSignedErrBars >= 0 ? 'projection tends to be late' : 'projection tends to be early'})
            </div>
          </div>

          {/* Monte Carlo */}
          <div style={card}>
            <h2 style={h2}>Monte Carlo: random-phase test</h2>
            {mc ? (
              <>
                <div style={{ color: text, marginBottom: 8, lineHeight: 1.6 }}>
                  The same swing schedule is shifted to {mc.runs} random phases. If the cycle has real timing value the actual run should sit in the right tail.
                  <br />
                  Return p = <b style={{ color: fg }}>{mc.returnPValue.toFixed(3)}</b> · Sharpe p = <b style={{ color: fg }}>{mc.sharpePValue.toFixed(3)}</b> · percentile{' '}
                  <b style={{ color: fg }}>{mc.returnPercentile.toFixed(0)}</b> · random median {pct(mc.randomReturnP50)} (5–95%: {pct(mc.randomReturnP5)} … {pct(mc.randomReturnP95)})
                </div>
                <Histogram bins={mc.histogram} actual={m.totalReturnPct} text={text} />
              </>
            ) : (
              <div style={{ color: text }}>Skipped.</div>
            )}
          </div>
        </div>

        {/* Stop comparison */}
        {r.stopComparison?.length > 0 && (
          <div style={card}>
            <h2 style={h2}>Stop-loss comparison — same cycle entries, final exit on next swing</h2>
            <div style={{ color: text, marginBottom: 8 }}>
              Each row reruns the identical trade schedule with a different stop. Lower max drawdown with a similar Calmar/Sharpe means the stop is helping; if return collapses the stop is cutting good trades.
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    {['Stop rule', 'Return', 'CAGR', 'Max DD', 'Sharpe', 'Calmar', 'Trades', 'Win %', 'Worst trade', 'Stop exits'].map(h => <th key={h} style={th}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {r.stopComparison.map(row => {
                    const bestDd = Math.min(...r.stopComparison.map(x => x.maxDrawdownPct));
                    return (
                      <tr key={row.label} style={{ outline: row.current ? `2px solid ${BLUE}` : undefined, outlineOffset: -2 }}>
                        <td style={{ ...td, fontWeight: row.current ? 700 : 400 }}>{row.label}{row.current ? ' (current)' : ''}</td>
                        <td style={{ ...td, color: signColor(row.totalReturnPct) }}>{pct(row.totalReturnPct)}</td>
                        <td style={{ ...td, color: signColor(row.cagrPct) }}>{pct(row.cagrPct)}</td>
                        <td style={{ ...td, color: row.maxDrawdownPct === bestDd ? GREEN : RED, fontWeight: row.maxDrawdownPct === bestDd ? 700 : 400 }}>{row.maxDrawdownPct.toFixed(2)}%</td>
                        <td style={td}>{num(row.sharpe)}</td>
                        <td style={td}>{num(row.calmar)}</td>
                        <td style={td}>{row.trades}</td>
                        <td style={td}>{row.winRatePct.toFixed(1)}%</td>
                        <td style={{ ...td, color: signColor(row.worstTradePct) }}>{pct(row.worstTradePct)}</td>
                        <td style={td}>{row.stopExits}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Sweep */}
        {r.sweep.length > 0 && (
          <div style={card}>
            <h2 style={h2}>Parameter sensitivity (net return %) — swing strength × entry shift</h2>
            <div style={{ color: text, marginBottom: 8 }}>
              {positiveCells}/{r.sweep.length} combinations profitable. A robust cycle shows a broad profitable plateau, not a single lucky cell. Current setting outlined.
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Swing \ shift</th>
                    {r.sweepOffsets.map(o => <th key={o} style={{ ...th, textAlign: 'center' }}>{o > 0 ? `+${o}` : o}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {r.sweepLRs.map(lr => (
                    <tr key={lr}>
                      <td style={{ ...td, color: text }}>{lr}</td>
                      {r.sweepOffsets.map(off => {
                        const c = sweepCell(lr, off);
                        if (!c) return <td key={off} style={td} />;
                        const a = Math.min(0.85, Math.abs(c.totalReturnPct) / sweepMax);
                        const isCur = lr === r.config.swingLR && off === r.config.entryOffsetBars;
                        return (
                          <td
                            key={off}
                            title={`Sharpe ${c.sharpe.toFixed(2)} · ${c.trades} trades · win ${c.winRatePct.toFixed(1)}% · DD ${c.maxDrawdownPct.toFixed(1)}%`}
                            style={{
                              ...td,
                              textAlign: 'center',
                              background: c.totalReturnPct >= 0 ? `rgba(38,166,154,${a})` : `rgba(239,83,80,${a})`,
                              outline: isCur ? `2px solid ${BLUE}` : undefined,
                              outlineOffset: -2,
                            }}
                          >
                            {c.totalReturnPct.toFixed(1)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Monthly */}
        <div style={card}>
          <h2 style={h2}>Monthly returns %</h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>Year</th>
                  {MONTHS.map(x => <th key={x} style={{ ...th, textAlign: 'right' }}>{x}</th>)}
                  <th style={{ ...th, textAlign: 'right' }}>Year</th>
                </tr>
              </thead>
              <tbody>
                {r.monthly.map(y => (
                  <tr key={y.year}>
                    <td style={{ ...td, color: text }}>{y.year}</td>
                    {y.months.map((mv, i) => (
                      <td key={i} style={{ ...td, textAlign: 'right', color: mv === null ? text : signColor(mv) }}>{mv === null ? '' : mv.toFixed(1)}</td>
                    ))}
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: signColor(y.total) }}>{y.total.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Upcoming / open position */}
        <div style={card}>
          <h2 style={h2}>Forward view</h2>
          {r.openPosition ? (
            <div style={{ marginBottom: 8 }}>
              Open position: <b style={{ color: r.openPosition.direction === 'long' ? GREEN : RED }}>{r.openPosition.direction.toUpperCase()}</b> since{' '}
              {fmtDateTime(r.openPosition.entryTs)} @ {r.openPosition.entryPrice} · unrealised {pct(r.openPosition.unrealisedPct)}
            </div>
          ) : (
            <div style={{ color: text, marginBottom: 8 }}>Flat at the last bar.</div>
          )}
          {r.upcoming.length ? (
            <table style={{ borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Projected turn</th><th style={th}>Type</th><th style={th}>Action</th><th style={th}>Source date</th></tr></thead>
              <tbody>
                {r.upcoming.map(u => (
                  <tr key={u.projectedTs + u.type}>
                    <td style={td}>{fmtDateTime(u.projectedTs)}</td>
                    <td style={td}>Swing {u.type}</td>
                    <td style={{ ...td, color: u.type === 'low' ? GREEN : RED }}>{u.type === 'low' ? 'BUY' : 'SELL'}</td>
                    <td style={{ ...td, color: text }}>{fmtDateTime(u.originalTs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ color: text }}>No projected swings beyond the last bar (overlay window ends before today + offset).</div>
          )}
        </div>

        {/* Trade list */}
        <div style={card}>
          <h2 style={h2}>Trades ({r.trades.length}{r.trades.length > 1000 ? ', showing last 1000' : ''})</h2>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead style={{ position: 'sticky', top: 0, background: bg }}>
                <tr>
                  {['#', 'Side', 'Entry', 'Entry px', 'Exit', 'Exit px', 'Return', 'Bars', 'Exit reason', 'MAE', 'MFE', 'Equity'].map(h => <th key={h} style={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {r.trades.slice(-1000).map(tr => (
                  <tr key={tr.id}>
                    <td style={td}>{tr.id}</td>
                    <td style={{ ...td, color: tr.direction === 'long' ? GREEN : RED }}>{tr.direction === 'long' ? 'BUY' : 'SELL'}</td>
                    <td style={td}>{fmtDateTime(tr.entryTs)}</td>
                    <td style={td}>{tr.entryPrice}</td>
                    <td style={td}>{fmtDateTime(tr.exitTs)}</td>
                    <td style={td}>{tr.exitPrice.toFixed(2)}</td>
                    <td style={{ ...td, color: signColor(tr.returnPct) }}>{pct(tr.returnPct)}</td>
                    <td style={td}>{tr.bars}</td>
                    <td style={{ ...td, color: text }}>{tr.exitReason.replace(/_/g, ' ')}</td>
                    <td style={td}>{pct(tr.maePct)}</td>
                    <td style={td}>{pct(tr.mfePct)}</td>
                    <td style={td}>{tr.equityAfter.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Methodology */}
        <div style={{ ...card, color: text, lineHeight: 1.7 }}>
          <h2 style={h2}>Methodology</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>Signals: strict swing pivots (strength {r.config.swingLR}) on the overlay's source candles, projected forward {r.meta.offsetDays} calendar days. Swing low → long, swing high → short; the opposite swing closes the trade (stop-and-reverse).</li>
            <li>Execution: fills at the bar open ({r.config.entryMode === 'pivot_open' ? 'of the projected pivot bar' : 'after a close beyond the pivot bar range'}), entry shift {r.config.entryOffsetBars} bars, costs {r.config.commissionBps + r.config.slippageBps} bps per side, 100% equity per trade, compounded.</li>
            <li>Risk: {r.config.stopMode === 'atr' ? `stop ${r.config.stopAtrMult}× ATR(${r.config.atrPeriod}) from the prior bar` : r.config.stopMode === 'pct' ? `stop ${r.config.stopPct}%` : r.config.stopMode === 'swing' ? `stop at the last confirmed small swing (strength ${r.config.minorSwingLR}) low for longs / high for shorts${r.config.trailSwingStop ? ', trailed to each newer small swing after entry' : ''}` : 'no stop'}{r.config.takeProfitR > 0 ? `, target ${r.config.takeProfitR}R` : ''}{r.config.maxHoldBars > 0 ? `, max ${r.config.maxHoldBars} bars` : ''}. If stop and target are touched in the same bar the stop is assumed first; gaps fill at the open.</li>
            <li>Look-ahead guard {r.config.lookAheadGuard ? 'ON' : 'OFF'}: a projected pivot is only traded once the {r.config.swingLR} source bars confirming it had closed in real time. {r.config.matchOverlayPlot ? 'Consecutive same-type swings are merged into the most extreme one, matching the overlay plot.' : 'Swings are not merged (strictly causal).'}</li>
            <li>Risk metrics use mark-to-market daily equity, annualised by the observed trading days per year. Out-of-sample = last {Math.round((1 - r.config.inSampleFraction) * 100)}% of bars (no parameters are fitted, so this checks stability over time).</li>
            <li>Monte Carlo: the trade schedule is circularly shifted to random phases (same spacing, random timing); p-value = share of shifted runs that do at least as well.</li>
          </ul>
        </div>
      </div>
    </div>
  );
};
