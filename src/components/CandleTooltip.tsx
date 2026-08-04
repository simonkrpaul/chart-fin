/**
 * Tooltip / OHLCV readout displayed in the top-left of the chart.
 */
import React from 'react';
import { useChartStore } from '../store/chartStore';

export const CandleTooltip: React.FC = () => {
  const { crosshair, primarySlots, theme, overlayConfigs, overlays, session, timeframe, showIndicatorsAndDrawings } = useChartStore();

  if (!crosshair.visible) return null;

  const slot = primarySlots[crosshair.slotIndex];
  const c = slot?.candle;
  const bg = theme === 'dark' ? 'rgba(19,23,34,0.85)' : 'rgba(255,255,255,0.92)';
  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const mono: React.CSSProperties = { fontFamily: 'monospace', fontSize: 12 };
  const bull = '#26a69a';
  const bear = '#ef5350';

  // Use the resolved (possibly extrapolated) timestamp from crosshair state
  const displayTs = crosshair.timestamp || slot?.timestamp || 0;
  const tz = session.timezone;

  // Format timestamp in the selected timezone
  function formatTime(ts: number): string {
    if (!ts) return '—';
    const d = new Date(ts);
    const isIntraday = !['1d', '1w', '1M'].includes(timeframe);
    if (isIntraday) {
      return d.toLocaleString('en-US', {
        timeZone: tz,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
    return d.toLocaleDateString('en-US', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  if (!c) {
    return (
      <div style={{ position: 'absolute', top: 8, left: 8, background: bg, color: text, padding: '4px 8px', borderRadius: 4, ...mono }}>
        {formatTime(displayTs)} — No data
      </div>
    );
  }

  const isUp = c.close >= c.open;
  const color = isUp ? bull : bear;
  const pct = ((c.close - c.open) / c.open * 100).toFixed(2);

  return (
    <div style={{ position: 'absolute', top: 8, left: 8, background: bg, color: text, padding: '6px 10px', borderRadius: 4, ...mono, lineHeight: 1.6, boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
      <div style={{ opacity: 0.6, fontSize: 10 }}>{formatTime(c.timestamp)}</div>
      <div>
        O <span style={{ color }}>{c.open.toFixed(2)}</span>{' '}
        H <span style={{ color: bull }}>{c.high.toFixed(2)}</span>{' '}
        L <span style={{ color: bear }}>{c.low.toFixed(2)}</span>{' '}
        C <span style={{ color }}>{c.close.toFixed(2)}</span>{' '}
        <span style={{ color, fontSize: 11 }}>({isUp ? '+' : ''}{pct}%)</span>
      </div>
      <div style={{ opacity: 0.7 }}>Vol {formatVol(c.volume)}</div>

      {/* Overlay values at same slot */}
      {showIndicatorsAndDrawings && overlayConfigs.filter(cfg => cfg.visible).map(cfg => {
        const ov = overlays[cfg.id];
        if (!ov) return null;
        // Match by nearest slot index (fractional for virtual future slots)
        const pc = ov.projectedCandles.reduce<typeof ov.projectedCandles[0] | null>((best, p) => {
          const d = Math.abs(p.projectedSlotIndex - crosshair.slotIndex);
          if (d > 0.5) return best; // only within half a slot
          if (!best) return p;
          return d < Math.abs(best.projectedSlotIndex - crosshair.slotIndex) ? p : best;
        }, null);
        if (!pc) return null;
        return (
          <div key={cfg.id} style={{ borderTop: `1px solid rgba(255,255,255,0.1)`, marginTop: 4, paddingTop: 4, fontSize: 11 }}>
            <span style={{ color: cfg.color }}>●</span> {cfg.label} C:{pc.candle.close.toFixed(2)}
            {pc.normalizedValue !== undefined && ` (${pc.normalizedValue.toFixed(2)})`}
          </div>
        );
      })}
    </div>
  );
};

function formatVol(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K';
  return String(v);
}
