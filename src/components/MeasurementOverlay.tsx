/**
 * MeasurementOverlay – slim TradingView-style status bar that appears
 * along the bottom edge of the chart while a measurement is active.
 */
import React from 'react';
import { useChartStore } from '../store/chartStore';

export const MeasurementOverlay: React.FC = () => {
  const { lastMeasurement, theme } = useChartStore();
  if (!lastMeasurement) return null;

  const m    = lastMeasurement;
  const up   = m.absoluteMove >= 0;
  const sign = up ? '+' : '';
  const moveColor = up ? '#26a69a' : '#ef5350';
  const bg   = theme === 'dark' ? 'rgba(19,23,34,0.92)' : 'rgba(240,243,250,0.96)';
  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const sep  = theme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';

  const Cell: React.FC<{ label: string; value: React.ReactNode; valueColor?: string }> = ({ label, value, valueColor }) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 12px', borderRight: `1px solid ${sep}` }}>
      <span style={{ fontSize: 9, opacity: 0.5, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 1 }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: valueColor ?? text }}>{value}</span>
    </div>
  );

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 32,
        left: '50%',
        transform: 'translateX(-50%)',
        background: bg,
        color: text,
        display: 'flex',
        alignItems: 'stretch',
        borderRadius: 5,
        boxShadow: '0 2px 14px rgba(0,0,0,0.35)',
        border: `1px solid ${sep}`,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        pointerEvents: 'none',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      <Cell label="Bars"     value={m.tradingBars} />
      <Cell label="Days"     value={m.calendarDays} />
      <Cell label="Change"   value={`${sign}${m.absoluteMove.toFixed(2)}`} valueColor={moveColor} />
      <Cell label="Change %" value={`${sign}${m.percentMove.toFixed(2)}%`} valueColor={moveColor} />
      <Cell label="High"     value={m.high.toFixed(2)} />
      <Cell label="Low"      value={m.low.toFixed(2)} />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 12px' }}>
        <span style={{ fontSize: 9, opacity: 0.5, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 1 }}>Range</span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{m.priceRange.toFixed(2)}</span>
      </div>
    </div>
  );
};
