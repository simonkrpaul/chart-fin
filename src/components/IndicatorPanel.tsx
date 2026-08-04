/**
 * IndicatorPanel – sidebar panel to add / remove / toggle indicators.
 */
import React, { useState } from 'react';
import { useChartStore } from '../store/chartStore';
import type { IndicatorConfig, IndicatorType } from '../types';

/** Numeric parameter keys that exist on each indicator type */
const PARAM_KEYS: Partial<Record<IndicatorType, string[]>> = {
  SMA:      ['period'],
  EMA:      ['period'],
  RSI:      ['period'],
  BBANDS:   ['period', 'stddev'],
  MACD:     ['fast', 'slow', 'signal'],
  ATR:      ['period'],
  SWING_HL: ['leftRight'],
  SUPPORT_RESISTANCE: ['backBars', 'pivotStrength', 'minTouches'],
  SESSIONS: [],
  MOON_SIGNALS: [],
  DYNAMIC_GRID: ['interval', 'numLines'],
  WICK_REVERSAL: ['wickRatio', 'minAtrMultiple'],
  TRADE_SIGNALS: ['preMinutes', 'holdMinutes', 'minMovePct'],
  HIGH_LOW_LEVELS: [],
};

const INDICATOR_PRESETS: { type: IndicatorType; label: string; defaults: Record<string, number | string | boolean> }[] = [
  { type: 'SMA', label: 'SMA', defaults: { period: 20, source: 'close' } },
  { type: 'EMA', label: 'EMA', defaults: { period: 20, source: 'close' } },
  { type: 'VWAP', label: 'VWAP', defaults: {} },
  { type: 'VOLUME', label: 'Volume', defaults: {} },
  { type: 'RSI', label: 'RSI', defaults: { period: 14 } },
  { type: 'MACD', label: 'MACD', defaults: { fast: 12, slow: 26, signal: 9 } },
  { type: 'BBANDS', label: 'Bollinger', defaults: { period: 20, stddev: 2 } },
  { type: 'ATR', label: 'ATR', defaults: { period: 14 } },
  { type: 'SWING_HL', label: 'Swing HL', defaults: { leftRight: 5 } },
  { type: 'SUPPORT_RESISTANCE', label: 'S/R Zones', defaults: { backBars: 300, pivotStrength: 10, minTouches: 2, transparency: 35 } },
  { type: 'SESSIONS', label: 'Sessions', defaults: { showNY: true, showLondon: true, showTokyo: true, showSydney: true, transparency: 90 } },
  { type: 'MOON_SIGNALS', label: 'Moon Signals (Buy/Sell)', defaults: {} },
  { type: 'DYNAMIC_GRID', label: 'Dynamic Grid & Diagonals', defaults: { interval: 1618, numLines: 5, date1: Date.UTC(2026, 3, 13), date2: Date.UTC(2027, 3, 13), colorVert: '#2962ff', colorHoriz: '#e0b500', colorDiag: '#e53935' } },
  { type: 'WICK_REVERSAL', label: 'Wick Reversal', defaults: { wickRatio: 60, minAtrMultiple: 1 } },
  { type: 'TRADE_SIGNALS', label: 'Trade Signals (Long/Short)', defaults: { preMinutes: 30, holdMinutes: 35, minMovePct: 0.01 } },
  { type: 'HIGH_LOW_LEVELS', label: 'High/Low Levels', defaults: { showDaily: true, showWeekly: true, showMonthly: true, showSession: true, dailyColor: '#2196f3', weeklyColor: '#ff9800', monthlyColor: '#9c27b0', sessionColor: '#e91e63' } },
];

const COLORS = ['#2196f3', '#ff9800', '#4caf50', '#e91e63', '#9c27b0', '#00bcd4'];

export const IndicatorPanel: React.FC = () => {
  const {
    indicatorConfigs,
    addIndicator,
    removeIndicator,
    toggleIndicator,
    updateIndicatorConfig,
    theme,
  } = useChartStore();

  const bg = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#e0e3eb';
  const subtle = theme === 'dark' ? '#2a2e39' : '#e0e3eb';

  function addIndicatorPreset(preset: typeof INDICATOR_PRESETS[0]) {
    const id = `${preset.type.toLowerCase()}-${Date.now()}`;
    const existing = indicatorConfigs.filter(c => c.type === preset.type).length;
    const config: IndicatorConfig = {
      id,
      type: preset.type,
      params: { ...preset.defaults },
      color: COLORS[existing % COLORS.length],
      lineWidth: 1.5,
      visible: true,
      pane: preset.type === 'VOLUME' || preset.type === 'RSI' || preset.type === 'MACD' || preset.type === 'ATR'
        ? 'sub'
        : 'main', // SWING_HL, SUPPORT_RESISTANCE → 'main' (default)
    };
    addIndicator(config);
  }

  return (
    <div style={{ background: bg, color: text, padding: 12, width: '100%', boxSizing: 'border-box', overflowY: 'auto', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>Indicators</div>

      {/* Add preset */}
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: 'block', opacity: 0.6, marginBottom: 4 }}>Add indicator</label>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {INDICATOR_PRESETS.map(p => (
            <button
              key={`${p.type}-btn`}
              onClick={() => addIndicatorPreset(p)}
              style={{
                background: 'transparent',
                color: text,
                border: `1px solid ${border}`,
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${border}`, marginBottom: 8 }} />

      {indicatorConfigs.length === 0 && (
        <div style={{ opacity: 0.5, fontSize: 11 }}>No indicators.</div>
      )}

      {indicatorConfigs.map(cfg => {
        const paramKeys = PARAM_KEYS[cfg.type] ?? [];
        return (
          <div key={cfg.id} style={{ marginBottom: 6, padding: '6px 8px', background: subtle, borderRadius: 4 }}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: paramKeys.length ? 5 : 0 }}>
              <span style={{ width: 10, height: 3, background: cfg.color, display: 'inline-block', borderRadius: 2, flexShrink: 0 }} />
              <span style={{ flex: 1, opacity: cfg.visible ? 1 : 0.4, fontSize: 11 }}>
                {cfg.type}
              </span>
              <button
                onClick={() => toggleIndicator(cfg.id)}
                style={{ fontSize: 10, padding: '1px 5px', cursor: 'pointer', background: 'transparent', color: text, border: `1px solid ${border}`, borderRadius: 3, flexShrink: 0 }}
              >
                {cfg.visible ? 'Hide' : 'Show'}
              </button>
              <button
                onClick={() => removeIndicator(cfg.id)}
                style={{ fontSize: 10, padding: '1px 5px', cursor: 'pointer', background: 'transparent', color: '#ef5350', border: '1px solid #ef5350', borderRadius: 3, flexShrink: 0 }}
              >
                ✕
              </button>
            </div>

            {/* Editable params */}
            {paramKeys.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {paramKeys.map(key => (
                  <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, opacity: 0.7 }}>
                    <span style={{ textTransform: 'capitalize' }}>{key}</span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={cfg.params[key] as number ?? ''}
                      onChange={e => {
                        const v = parseInt(e.target.value, 10);
                        if (!isNaN(v) && v > 0) updateIndicatorConfig(cfg.id, { [key]: v });
                      }}
                      style={{
                        width: 44, padding: '1px 4px', fontSize: 10,
                        background: subtle, color: text,
                        border: `1px solid ${border}`, borderRadius: 3,
                      }}
                    />
                  </label>
                ))}
              </div>
            )}

            {/* Show % move – only for SWING_HL */}
            {cfg.type === 'SWING_HL' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, opacity: 0.8, marginTop: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!cfg.params.showSwingPct}
                  onChange={e => updateIndicatorConfig(cfg.id, { showSwingPct: e.target.checked })}
                />
                Show % move
              </label>
            )}

            {/* Session toggles – only for SESSIONS */}
            {cfg.type === 'SESSIONS' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
                {([
                  { key: 'showNY', label: 'New York', color: '#ff5d00' },
                  { key: 'showLondon', label: 'London', color: '#2157f3' },
                  { key: 'showTokyo', label: 'Tokyo', color: '#e91e63' },
                  { key: 'showSydney', label: 'Sydney', color: '#ffeb3b' },
                ] as const).map(s => (
                  <label key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, opacity: 0.8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={cfg.params[s.key] !== false}
                      onChange={e => updateIndicatorConfig(cfg.id, { [s.key]: e.target.checked })}
                    />
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                    {s.label}
                  </label>
                ))}
              </div>
            )}

            {/* HIGH_LOW_LEVELS: period toggles and color pickers */}
            {cfg.type === 'HIGH_LOW_LEVELS' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
                {([
                  { key: 'showDaily', label: 'Daily', colorKey: 'dailyColor' },
                  { key: 'showWeekly', label: 'Weekly', colorKey: 'weeklyColor' },
                  { key: 'showMonthly', label: 'Monthly', colorKey: 'monthlyColor' },
                  { key: 'showSession', label: 'Session', colorKey: 'sessionColor' },
                ] as const).map(s => (
                  <label key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, opacity: 0.8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={cfg.params[s.key] !== false}
                      onChange={e => updateIndicatorConfig(cfg.id, { [s.key]: e.target.checked })}
                    />
                    <input
                      type="color"
                      value={(cfg.params[s.colorKey] as string) || '#ffffff'}
                      onChange={e => updateIndicatorConfig(cfg.id, { [s.colorKey]: e.target.value })}
                      style={{ width: 16, height: 16, padding: 0, border: 'none', cursor: 'pointer' }}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
            )}

            {/* DYNAMIC_GRID: date pickers and color inputs */}
            {cfg.type === 'DYNAMIC_GRID' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                {/* Date inputs */}
                {([
                  { key: 'date1', label: 'Date 1' },
                  { key: 'date2', label: 'Date 2' },
                ] as const).map(d => (
                  <label key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, opacity: 0.8 }}>
                    <span style={{ width: 40 }}>{d.label}</span>
                    <input
                      type="date"
                      value={(() => {
                        const ts = cfg.params[d.key] as number;
                        if (!ts) return '';
                        const dt = new Date(ts);
                        return dt.toISOString().slice(0, 10);
                      })()}
                      onChange={e => {
                        const ms = new Date(e.target.value + 'T00:00:00Z').getTime();
                        if (!isNaN(ms)) updateIndicatorConfig(cfg.id, { [d.key]: ms });
                      }}
                      style={{
                        padding: '1px 4px', fontSize: 10,
                        background: subtle, color: text,
                        border: `1px solid ${border}`, borderRadius: 3,
                        colorScheme: 'dark',
                      }}
                    />
                  </label>
                ))}
                {/* Color inputs */}
                {([
                  { key: 'colorVert', label: 'Vertical' },
                  { key: 'colorHoriz', label: 'Horizontal' },
                  { key: 'colorDiag', label: 'Diagonal' },
                ] as const).map(c => (
                  <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, opacity: 0.8 }}>
                    <span style={{ width: 55 }}>{c.label}</span>
                    <input
                      type="color"
                      value={(cfg.params[c.key] as string) ?? '#ffffff'}
                      onChange={e => updateIndicatorConfig(cfg.id, { [c.key]: e.target.value })}
                      style={{ width: 24, height: 18, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
