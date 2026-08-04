/**
 * BacktestPanel – configuration sidebar for the Strategy Tester.
 *
 * Lets the user pick a strategy, tune its parameters, set commission,
 * allow/disallow shorts, then run the backtest.  Results are shown via
 * BacktestReport.
 */
import React, { useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { STRATEGY_DEFAULTS } from '../engine/backtestEngine';
import type { BacktestStrategyId, BacktestStrategyParams, TradeDirectionMode } from '../types';

const STRATEGIES: { id: BacktestStrategyId; label: string }[] = [
  { id: 'ema_crossover',       label: 'EMA Crossover' },
  { id: 'sma_crossover',       label: 'SMA Crossover' },
  { id: 'ema_price_cross',     label: 'Price × EMA' },
  { id: 'rsi_ob_os',           label: 'RSI Overbought/Oversold' },
  { id: 'macd_signal_cross',   label: 'MACD Signal Cross' },
  { id: 'overlay_swing_hl',    label: 'Overlay Swing H/L' },
  { id: 'overlay_swing_close', label: 'Overlay Swing Close' },
  { id: 'ny_10am_breakout',    label: 'NY 10am Breakout' },
];

// Param labels per strategy
const PARAM_LABELS: Record<BacktestStrategyId, { key: keyof BacktestStrategyParams; label: string; min: number; max: number; step: number }[]> = {
  ema_crossover: [
    { key: 'fastPeriod', label: 'Fast EMA', min: 2, max: 200, step: 1 },
    { key: 'slowPeriod', label: 'Slow EMA', min: 2, max: 500, step: 1 },
  ],
  sma_crossover: [
    { key: 'fastPeriod', label: 'Fast SMA', min: 2, max: 200, step: 1 },
    { key: 'slowPeriod', label: 'Slow SMA', min: 2, max: 500, step: 1 },
  ],
  ema_price_cross: [
    { key: 'period', label: 'EMA Period', min: 2, max: 500, step: 1 },
  ],
  rsi_ob_os: [
    { key: 'rsiPeriod',   label: 'RSI Period',    min: 2,  max: 100, step: 1 },
    { key: 'overbought',  label: 'Overbought',    min: 50, max: 99,  step: 1 },
    { key: 'oversold',    label: 'Oversold',      min: 1,  max: 49,  step: 1 },
  ],
  macd_signal_cross: [
    { key: 'fastEma',      label: 'Fast EMA',    min: 2, max: 100, step: 1 },
    { key: 'slowEma',      label: 'Slow EMA',    min: 2, max: 200, step: 1 },
    { key: 'signalPeriod', label: 'Signal',      min: 2, max: 50,  step: 1 },
  ],
  // overlay_swing_hl has no numeric params rendered via paramDefs;
  // its overlay picker + leftRight input are rendered specially below.
  overlay_swing_hl: [
    { key: 'swingHLLeftRight', label: 'Left/Right Bars', min: 1, max: 50, step: 1 },
  ],
  overlay_swing_close: [
    { key: 'swingHLLeftRight', label: 'Left/Right Bars', min: 1, max: 50, step: 1 },
  ],
  ny_10am_breakout: [
    { key: 'nyEntryHourUTC',      label: 'Entry Hour (UTC)', min: 0,  max: 23, step: 1 },
    { key: 'nySessionEndHourUTC', label: 'Session End (UTC)', min: 0,  max: 23, step: 1 },
    { key: 'ny10amTpPct',         label: 'Take Profit %',    min: 0.1, max: 20, step: 0.1 },
  ],
};

function N(v: unknown): string {
  if (typeof v === 'number') return String(v);
  return '';
}

export const BacktestPanel: React.FC = () => {
  const {
    themeTokens: t,
    backtestConfig,
    backtestResult,
    backtestRunning,
    showBacktestSignals,
    showBacktestReport,
    overlayConfigs,
    updateBacktestConfig,
    runBacktest,
    clearBacktest,
    toggleBacktestSignals,
    toggleBacktestReport,
  } = useChartStore();

  const [open, setOpen] = useState(false);
  const [showRisk, setShowRisk] = useState(false);

  const border = t.gridLine;
  const bg = t.background;
  const bg2 = t.gridLineMajor;
  const text = t.axisText;
  const accent = '#2962ff';
  const textPrimary = '#d1d4dc';

  const paramDefs = PARAM_LABELS[backtestConfig.strategyId];

  function changeStrategy(id: BacktestStrategyId) {
    const riskReset = id === 'overlay_swing_close'
      ? { commissionPct: 0, takeProfitPct: 0, stopLossPct: 0, slDelayBars: 0, holdForTpSl: false }
      : {};
    updateBacktestConfig({
      strategyId: id,
      params: { ...STRATEGY_DEFAULTS[id].params },
      ...riskReset,
    });
  }

  function changeParam(key: keyof BacktestStrategyParams, raw: string) {
    const num = parseFloat(raw);
    if (!isNaN(num)) {
      updateBacktestConfig({ params: { ...backtestConfig.params, [key]: num } });
    }
  }

  const inputStyle: React.CSSProperties = {
    background: bg2,
    border: `1px solid ${border}`,
    color: textPrimary,
    borderRadius: 4,
    padding: '3px 6px',
    fontSize: 12,
    width: 64,
    outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    color: text,
    fontSize: 11,
    flex: 1,
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  };

  return (
    <div style={{ borderBottom: `1px solid ${border}` }}>
      {/* Header toggle */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          borderBottom: open ? `1px solid ${border}` : 'none',
          color: textPrimary,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        <span>⚡ Strategy Tester</span>
        <span style={{ fontSize: 10, color: text }}>
          {backtestResult
            ? `${backtestResult.netProfitPct >= 0 ? '+' : ''}${backtestResult.netProfitPct.toFixed(2)}%`
            : open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Strategy selector */}
          <div style={rowStyle}>
            <span style={labelStyle}>Strategy</span>
            <select
              value={backtestConfig.strategyId}
              onChange={e => changeStrategy(e.target.value as BacktestStrategyId)}
              style={{ ...inputStyle, width: 140 }}
            >
              {STRATEGIES.map(s => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>

          {/* Per-strategy params */}
          {paramDefs.map(p => (
            <div key={p.key} style={rowStyle}>
              <span style={labelStyle}>{p.label}</span>
              <input
                type="number"
                min={p.min}
                max={p.max}
                step={p.step}
                value={N(backtestConfig.params[p.key])}
                onChange={e => changeParam(p.key, e.target.value)}
                style={inputStyle}
              />
            </div>
          ))}

          {/* Overlay Swing HL: overlay picker + confirm close */}
          {backtestConfig.strategyId === 'overlay_swing_hl' && (
            <>
              <div style={rowStyle}>
                <span style={labelStyle}>Overlay</span>
                {overlayConfigs.length === 0 ? (
                  <span style={{ fontSize: 11, opacity: 0.6 }}>No overlays added</span>
                ) : (
                  <select
                    value={backtestConfig.params.overlayId ?? ''}
                    onChange={e => updateBacktestConfig({ params: { ...backtestConfig.params, overlayId: e.target.value } })}
                    style={{ ...inputStyle, width: 140 }}
                  >
                    <option value=''>-- select overlay --</option>
                    {overlayConfigs.map(ov => (
                      <option key={ov.id} value={ov.id}>{ov.label}</option>
                    ))}
                  </select>
                )}
              </div>
              <div style={rowStyle}>
                <span style={{ ...labelStyle, lineHeight: '1.3' }}>
                  Confirm Close
                  <span style={{ display: 'block', fontSize: 10, color: text }}>Enter only on close above/below pivot</span>
                </span>
                <input
                  type="checkbox"
                  checked={backtestConfig.params.requireCloseConfirm !== false}
                  onChange={e => updateBacktestConfig({ params: { ...backtestConfig.params, requireCloseConfirm: e.target.checked } })}
                  style={{ accentColor: accent }}
                  title="When enabled, a trade is only entered after the close breaks above the swing Low's high (for BUY) or below the swing High's low (for SELL). Exits always happen immediately at the pivot bar regardless."
                />
              </div>
              <div style={rowStyle}>
                <span style={{ ...labelStyle, lineHeight: '1.3' }}>
                  Swing Stop Loss
                  <span style={{ display: 'block', fontSize: 10, color: text }}>Exit when close re-crosses pivot level</span>
                </span>
                <input
                  type="checkbox"
                  checked={!!backtestConfig.params.swingStopLoss}
                  onChange={e => updateBacktestConfig({ params: { ...backtestConfig.params, swingStopLoss: e.target.checked } })}
                  style={{ accentColor: accent }}
                  title="Long exits when candle closes back below the swing Low price. Short exits when candle closes back above the swing High price."
                />
              </div>
            </>
          )}

          {/* Overlay Swing Close: overlay picker (stop + close-confirm always on) */}
          {backtestConfig.strategyId === 'overlay_swing_close' && (
            <>
              <div style={rowStyle}>
                <span style={labelStyle}>Overlay</span>
                {overlayConfigs.length === 0 ? (
                  <span style={{ fontSize: 11, opacity: 0.6 }}>No overlays added</span>
                ) : (
                  <select
                    value={backtestConfig.params.overlayId ?? ''}
                    onChange={e => updateBacktestConfig({ params: { ...backtestConfig.params, overlayId: e.target.value } })}
                    style={{ ...inputStyle, width: 140 }}
                  >
                    <option value=''>-- select overlay --</option>
                    {overlayConfigs.map(ov => (
                      <option key={ov.id} value={ov.id}>{ov.label}</option>
                    ))}
                  </select>
                )}
              </div>
              <div style={{ fontSize: 10, color: text, opacity: 0.7, marginBottom: 4, lineHeight: 1.4 }}>
                BUY when close &gt; any swing price • SELL when close &lt; any swing price.
                Exit at opposite swing point. No stop loss — use Direction to restrict trade side.
              </div>
            </>
          )}

          {/* NY 10am Breakout: mode selector */}
          {backtestConfig.strategyId === 'ny_10am_breakout' && (
            <>
              <div style={rowStyle}>
                <span style={labelStyle}>Mode</span>
                <select
                  value={backtestConfig.params.ny10amMode ?? 'breakout'}
                  onChange={e => updateBacktestConfig({ params: { ...backtestConfig.params, ny10amMode: e.target.value as 'breakout' | 'color' } })}
                  style={{ ...inputStyle, width: 120 }}
                >
                  <option value='breakout'>Breakout H/L</option>
                  <option value='color'>Candle Color</option>
                </select>
              </div>
              <div style={rowStyle}>
                <span style={{ ...labelStyle, lineHeight: '1.3' }}>
                  Close-Back Stop
                  <span style={{ display: 'block', fontSize: 10, color: text }}>Exit if close crosses entry candle open</span>
                </span>
                <input
                  type="checkbox"
                  checked={backtestConfig.params.ny10amCloseBack !== false}
                  onChange={e => updateBacktestConfig({ params: { ...backtestConfig.params, ny10amCloseBack: e.target.checked } })}
                  style={{ accentColor: accent }}
                />
              </div>
              <div style={{ fontSize: 10, color: text, opacity: 0.7, marginBottom: 4, lineHeight: 1.4 }}>
                {backtestConfig.params.ny10amMode === 'color'
                  ? 'Green 10am candle → long, red → short. Exit at session end.'
                  : 'Enter on close above/below 10am candle H/L. Exit at session end.'}
              </div>
            </>
          )}

          <div style={{ width: '100%', height: 1, background: border, margin: '6px 0' }} />

          {/* Risk Settings — collapsible */}
          <button
            onClick={() => setShowRisk(v => !v)}
            style={{ background: 'none', border: 'none', color: text, fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0', marginBottom: 4 }}
          >
            <span style={{ fontSize: 9 }}>{showRisk ? '▼' : '▶'}</span>
            Risk Settings
          </button>

          {showRisk && (<>
          {/* Commission – hidden for overlay_swing_close */}
          {backtestConfig.strategyId !== 'overlay_swing_close' && (
          <div style={rowStyle}>
            <span style={labelStyle}>Commission %</span>
            <input
              type="number"
              min={0}
              max={5}
              step={0.01}
              value={backtestConfig.commissionPct}
              onChange={e => updateBacktestConfig({ commissionPct: parseFloat(e.target.value) || 0 })}
              style={inputStyle}
            />
          </div>
          )}

          {/* Take Profit – hidden for overlay_swing_close */}
          {backtestConfig.strategyId !== 'overlay_swing_close' && (
          <div style={rowStyle}>
            <span style={labelStyle}>Take Profit %</span>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={backtestConfig.takeProfitPct ?? 0}
              onChange={e => updateBacktestConfig({ takeProfitPct: parseFloat(e.target.value) || 0 })}
              style={inputStyle}
              title="Set to 0 to disable. Closes position when price moves this % in your favour."
            />
          </div>
          )}

          {/* Stop Loss – hidden for overlay_swing_close */}
          {backtestConfig.strategyId !== 'overlay_swing_close' && (
          <div style={rowStyle}>
            <span style={labelStyle}>Stop Loss %</span>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={backtestConfig.stopLossPct ?? 0}
              onChange={e => updateBacktestConfig({ stopLossPct: parseFloat(e.target.value) || 0 })}
              style={inputStyle}
              title="Set to 0 to disable. Closes position when price moves this % against you."
            />
          </div>
          )}

          {/* Trade Direction */}
          <div style={rowStyle}>
            <span style={labelStyle}>Direction</span>
            <select
              value={backtestConfig.tradeDirection ?? 'both'}
              onChange={e => updateBacktestConfig({ tradeDirection: e.target.value as TradeDirectionMode })}
              style={{ ...inputStyle, width: 100 }}
            >
              <option value="long_only">Buy only</option>
              <option value="short_only">Sell only</option>
              <option value="both">Both</option>
            </select>
          </div>

          {/* SL Delay – hidden for overlay_swing_close */}
          {backtestConfig.strategyId !== 'overlay_swing_close' && (
          <div style={rowStyle}>
            <span style={labelStyle}>SL Delay (bars)</span>
            <input
              type="number"
              min={0}
              max={1000}
              step={1}
              value={backtestConfig.slDelayBars ?? 0}
              onChange={e => updateBacktestConfig({ slDelayBars: parseInt(e.target.value, 10) || 0 })}
              style={inputStyle}
              title="Number of bars to wait before the stop-loss activates. On a 5m chart, 6 bars = 30 min SL delay. Set to 0 for immediate SL."
            />
          </div>
          )}

          {/* Hold for TP/SL – hidden for overlay_swing_close */}
          {backtestConfig.strategyId !== 'overlay_swing_close' && (
          <div style={rowStyle}>
            <span style={{ ...labelStyle, lineHeight: '1.3' }}>
              Hold for TP/SL
              <span style={{ display: 'block', fontSize: 10, color: t.axisText }}>
                Ignore exit signals, wait for TP/SL
              </span>
            </span>
            <input
              type="checkbox"
              checked={backtestConfig.holdForTpSl ?? true}
              onChange={e => updateBacktestConfig({ holdForTpSl: e.target.checked })}
              style={{ accentColor: accent }}
              title="When enabled and TP or SL is set, strategy exit signals are suppressed. The trade stays open until TP or SL price is hit."
            />
          </div>
          )}

          </>
          )} {/* end Risk Settings */}

          <div style={{ width: '100%', height: 1, background: border, margin: '6px 0' }} />

          {/* Signals toggle */}
          {backtestResult && (
            <div style={rowStyle}>
              <span style={labelStyle}>Show Signals</span>
              <input
                type="checkbox"
                checked={showBacktestSignals}
                onChange={toggleBacktestSignals}
                style={{ accentColor: accent }}
              />
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button
              onClick={runBacktest}
              disabled={backtestRunning}
              style={{
                flex: 1,
                background: accent,
                border: 'none',
                color: '#fff',
                borderRadius: 4,
                padding: '6px 0',
                fontSize: 12,
                fontWeight: 600,
                cursor: backtestRunning ? 'not-allowed' : 'pointer',
                opacity: backtestRunning ? 0.6 : 1,
              }}
            >
              {backtestRunning ? 'Running…' : 'Run Backtest'}
            </button>
            {backtestResult && (
              <button
                onClick={clearBacktest}
                style={{
                  background: 'none',
                  border: `1px solid ${border}`,
                  color: text,
                  borderRadius: 4,
                  padding: '6px 10px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Quick-stat preview when result is available */}
          {backtestResult && (
            <div
              style={{
                marginTop: 8,
                background: bg2,
                border: `1px solid ${border}`,
                borderRadius: 6,
                padding: '8px 10px',
                fontSize: 11,
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '4px 12px',
              }}
            >
              {[
                ['Net P&L', `${backtestResult.netProfitPct >= 0 ? '+' : ''}${backtestResult.netProfitPct.toFixed(2)}%`],
                ['Trades', String(backtestResult.totalTrades)],
                ['Win %', `${backtestResult.winRatePct.toFixed(1)}%`],
                ['Max DD', `-${backtestResult.maxDrawdownPct.toFixed(2)}%`],
                ['Profit F.', isFinite(backtestResult.profitFactor) ? backtestResult.profitFactor.toFixed(2) : '∞'],
                ['Sharpe', backtestResult.sharpeRatio.toFixed(2)],
              ].map(([lbl, val]) => (
                <React.Fragment key={lbl}>
                  <span style={{ color: text }}>{lbl}</span>
                  <span style={{ color: textPrimary, textAlign: 'right' }}>{val}</span>
                </React.Fragment>
              ))}
              <div style={{ gridColumn: '1/-1', marginTop: 4 }}>
                <button
                  onClick={toggleBacktestReport}
                  style={{
                    width: '100%',
                    background: 'none',
                    border: `1px solid ${border}`,
                    color: accent,
                    borderRadius: 4,
                    padding: '5px 0',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  {showBacktestReport ? 'Hide Full Report' : 'View Full Report'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
