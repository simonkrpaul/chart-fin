/**
 * BacktestReport – TradingView-style Strategy Tester report panel.
 *
 * Three tabs: Overview · Trade List · Equity Curve
 *
 * Shows the same metric layout as TradingView's built-in Strategy Tester:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  Net P&L    Gross P&L    Max DD    Buy&Hold    Win%     │
 *   ├─────────────────────────┬───────────────────────────────┤
 *   │ Trades  / Win / Lose    │ Avg Win / Avg Loss / ProfitF  │
 *   │ Expectancy  Sharpe  …   │ Avg / Max / Min bars          │
 *   └─────────────────────────┴───────────────────────────────┘
 */
import React, { useRef, useEffect, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import type { BacktestTrade } from '../types';
import { format } from 'date-fns';

type Tab = 'overview' | 'trades' | 'equity';

function fmt2(n: number) { return n.toFixed(2); }
function fmtPct(n: number, forceSign = false) {
  const s = (forceSign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
  return s;
}
function fmtDate(ms: number) { return format(new Date(ms), 'MMM d, yyyy HH:mm'); }

const GREEN = '#26a69a';
const RED   = '#ef5350';
const DIM   = '#9598a1';

// Reusable metric tile
function Metric({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: DIM, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color: color ?? '#d1d4dc' }}>{value}</span>
      {sub && <span style={{ fontSize: 10, color: DIM }}>{sub}</span>}
    </div>
  );
}

// Section divider
function Section({ title }: { title: string }) {
  return (
    <div style={{ gridColumn: '1 / -1', marginTop: 12, marginBottom: 4, color: DIM, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', borderBottom: '1px solid #2a2e39', paddingBottom: 4 }}>
      {title}
    </div>
  );
}

// Mini equity curve SVG
function EquitySvg({ curve, width, height }: { curve: { timestamp: number; equity: number }[]; width: number; height: number }) {
  if (curve.length < 2) return null;
  const minE = Math.min(...curve.map(p => p.equity));
  const maxE = Math.max(...curve.map(p => p.equity));
  const rangeE = maxE - minE || 1;
  const pad = 8;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const pts = curve.map((p, i) => {
    const x = pad + (i / (curve.length - 1)) * w;
    const y = pad + h - ((p.equity - minE) / rangeE) * h;
    return `${x},${y}`;
  });

  // Area fill
  const area = `M${pts[0]} L${pts.join(' L')} L${pad + w},${pad + h} L${pad},${pad + h} Z`;
  const finalEquity = curve[curve.length - 1].equity;
  const lineColor = finalEquity >= 100 ? GREEN : RED;

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* baseline */}
      <line x1={pad} y1={pad + h} x2={pad + w} y2={pad + h} stroke="#2a2e39" strokeWidth={1} />
      {/* 100 baseline */}
      {minE < 100 && maxE > 100 && (() => {
        const y100 = pad + h - ((100 - minE) / rangeE) * h;
        return <line x1={pad} y1={y100} x2={pad + w} y2={y100} stroke="#3c4151" strokeWidth={1} strokeDasharray="3 3" />;
      })()}
      <path d={area} fill="url(#eqGrad)" />
      <polyline points={pts.join(' ')} fill="none" stroke={lineColor} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

export const BacktestReport: React.FC = () => {
  const { themeTokens: t, backtestResult, showBacktestReport, toggleBacktestReport, clearBacktest } = useChartStore();
  const [tab, setTab] = useState<Tab>('overview');
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(600);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([e]) => setContainerW(e.contentRect.width));
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  if (!showBacktestReport || !backtestResult) return null;

  const r = backtestResult;
  const bg = t.background;
  const border = t.gridLine;
  const bg2 = t.gridLineMajor;
  const textPrimary = '#d1d4dc';

  const tabStyle = (active: boolean): React.CSSProperties => ({
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid #2962ff' : '2px solid transparent',
    color: active ? textPrimary : DIM,
    padding: '7px 14px',
    fontSize: 12,
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  });

  return (
    <div
      ref={containerRef}
      style={{
        flexShrink: 0,
        height: 280,
        background: bg,
        borderTop: `2px solid #2962ff`,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      {/* Tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${border}`, flexShrink: 0 }}>
        <span style={{ padding: '0 12px', fontSize: 12, fontWeight: 700, color: '#2962ff', borderRight: `1px solid ${border}` }}>
          Strategy Tester
        </span>
        {(['overview', 'trades', 'equity'] as Tab[]).map(tb => (
          <button key={tb} onClick={() => setTab(tb)} style={tabStyle(tab === tb)}>
            {tb.charAt(0).toUpperCase() + tb.slice(1)}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={toggleBacktestReport}
          style={{ background: 'none', border: 'none', color: DIM, cursor: 'pointer', padding: '0 12px', fontSize: 16 }}
        >×</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto' }}>

        {/* ── OVERVIEW ─────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
              gap: '12px 20px',
              padding: '14px 16px',
            }}
          >
            <Section title="Performance" />
            <Metric
              label="Net P&L"
              value={fmtPct(r.netProfitPct, true)}
              color={r.netProfitPct >= 0 ? GREEN : RED}
            />
            <Metric
              label="Gross Profit"
              value={fmtPct(r.grossProfitPct)}
              color={GREEN}
            />
            <Metric
              label="Gross Loss"
              value={`-${fmtPct(r.grossLossPct)}`}
              color={RED}
            />
            <Metric
              label="Buy & Hold"
              value={fmtPct(r.buyHoldReturnPct, true)}
              color={r.buyHoldReturnPct >= 0 ? GREEN : RED}
            />
            <Metric
              label="Max Drawdown"
              value={`-${fmtPct(r.maxDrawdownPct)}`}
              sub={`${r.maxDrawdownBars} bars`}
              color={RED}
            />
            {r.cagrPct != null && (
              <Metric
                label="CAGR"
                value={fmtPct(r.cagrPct, true)}
                color={r.cagrPct >= 0 ? GREEN : RED}
              />
            )}

            <Section title="Trade Statistics" />
            <Metric label="Total Trades"    value={String(r.totalTrades)} />
            <Metric label="Winning Trades"  value={String(r.winningTrades)} color={GREEN} />
            <Metric label="Losing Trades"   value={String(r.losingTrades)}  color={RED} />
            <Metric label="Win Rate"        value={fmtPct(r.winRatePct)} />
            <Metric label="Avg Win"         value={`+${fmtPct(r.avgWinPct)}`}  color={GREEN} />
            <Metric label="Avg Loss"        value={`-${fmtPct(r.avgLossPct)}`} color={RED} />
            <Metric label="Profit Factor"   value={isFinite(r.profitFactor) ? fmt2(r.profitFactor) : '∞'} />
            <Metric label="Expectancy"      value={fmtPct(r.expectancyPct, true)} color={r.expectancyPct >= 0 ? GREEN : RED} />

            <Section title="Risk" />
            <Metric label="Sharpe Ratio"  value={fmt2(r.sharpeRatio)} />
            <Metric label="Sortino Ratio" value={fmt2(r.sortinoRatio)} />

            <Section title="Trade Duration (bars)" />
            <Metric label="Avg Bars"  value={String(r.avgBarsInTrade)} />
            <Metric label="Max Bars"  value={String(r.maxBarsInTrade)} />
            <Metric label="Min Bars"  value={String(r.minBarsInTrade)} />

            <Section title="Exit Reasons" />
            <Metric label="Take Profit" value={String(r.tpExits)}     color={r.tpExits > 0 ? GREEN : undefined} />
            <Metric label="Stop Loss"   value={String(r.slExits)}     color={r.slExits > 0 ? RED : undefined} />
            <Metric label="Signal"      value={String(r.signalExits)} />
            <Metric label="End of Data" value={String(r.eodExits)}    color={DIM} />
          </div>
        )}

        {/* ── TRADE LIST ───────────────────────────────────────────────── */}
        {tab === 'trades' && (
          <div style={{ overflow: 'auto', height: '100%' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 11,
                color: textPrimary,
              }}
            >
              <thead>
                <tr style={{ background: bg2, position: 'sticky', top: 0 }}>
                  {['#', 'Type', 'Entry Date', 'Entry Price', 'Exit Date', 'Exit Price', 'Exit', 'Bars', 'P&L %', 'P&L pts', 'Equity'].map(h => (
                    <th
                      key={h}
                      style={{
                        padding: '6px 10px',
                        textAlign: 'left',
                        color: DIM,
                        fontWeight: 600,
                        borderBottom: `1px solid ${border}`,
                        whiteSpace: 'nowrap',
                      }}
                    >{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.trades.map((trade: BacktestTrade) => {
                  const pnlColor = trade.pnlPct >= 0 ? GREEN : RED;
                  return (
                    <tr
                      key={trade.id}
                      style={{ borderBottom: `1px solid ${border}` }}
                    >
                      <td style={{ padding: '5px 10px', color: DIM }}>{trade.id}</td>
                      <td style={{ padding: '5px 10px' }}>
                        <span
                          style={{
                            background: trade.direction === 'long' ? 'rgba(38,166,154,0.15)' : 'rgba(239,83,80,0.15)',
                            color: trade.direction === 'long' ? GREEN : RED,
                            borderRadius: 3,
                            padding: '1px 5px',
                            fontWeight: 600,
                          }}
                        >
                          {trade.direction.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '5px 10px', color: DIM, whiteSpace: 'nowrap' }}>{fmtDate(trade.entryTimestamp)}</td>
                      <td style={{ padding: '5px 10px' }}>{trade.entryPrice.toFixed(2)}</td>
                      <td style={{ padding: '5px 10px', color: DIM, whiteSpace: 'nowrap' }}>{fmtDate(trade.exitTimestamp)}</td>
                      <td style={{ padding: '5px 10px' }}>{trade.exitPrice.toFixed(2)}</td>
                      <td style={{ padding: '5px 10px', whiteSpace: 'nowrap' }}>
                        {trade.exitReason === 'take_profit' && <span style={{ color: '#26a69a', fontWeight: 700 }}>TP</span>}
                        {trade.exitReason === 'stop_loss'   && <span style={{ color: '#ef5350', fontWeight: 700 }}>SL</span>}
                        {trade.exitReason === 'signal'      && <span style={{ color: DIM }}>Signal</span>}
                        {trade.exitReason === 'end_of_data' && <span style={{ color: DIM }}>EOD</span>}
                      </td>
                      <td style={{ padding: '5px 10px', color: DIM }}>{trade.bars}</td>
                      <td style={{ padding: '5px 10px', color: pnlColor, fontWeight: 700 }}>
                        {trade.pnlPct >= 0 ? '+' : ''}{trade.pnlPct.toFixed(2)}%
                      </td>
                      <td style={{ padding: '5px 10px', color: pnlColor }}>
                        {trade.pnlPoints >= 0 ? '+' : ''}{trade.pnlPoints.toFixed(2)}
                      </td>
                      <td style={{ padding: '5px 10px', color: DIM }}>{trade.equityAfter.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {r.trades.length === 0 && (
              <div style={{ textAlign: 'center', padding: 24, color: DIM }}>No trades generated</div>
            )}
          </div>
        )}

        {/* ── EQUITY CURVE ─────────────────────────────────────────────── */}
        {tab === 'equity' && (
          <div style={{ padding: '12px 16px', height: '100%', boxSizing: 'border-box' }}>
            <div style={{ marginBottom: 8, fontSize: 11, color: DIM }}>
              Starting equity: 100 → Final: {r.equityCurve[r.equityCurve.length - 1]?.equity.toFixed(2) ?? '—'}
            </div>
            <EquitySvg
              curve={r.equityCurve}
              width={containerW - 32}
              height={220}
            />
          </div>
        )}
      </div>
    </div>
  );
};
