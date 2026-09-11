/**
 * Tooltip / OHLCV readout displayed in the top-left of the chart.
 */
import React from 'react';
import { useChartStore } from '../store/chartStore';

export const CandleTooltip: React.FC = () => {
  const {
    crosshair, primarySlots, theme, overlayConfigs, overlays,
    session, timeframe, showIndicatorsAndDrawings, currentSeries, rawCandles,
  } = useChartStore();

  const slot = primarySlots[crosshair.slotIndex];
  const c = slot?.candle;
  const bg = theme === 'dark' ? 'rgba(19,23,34,0.85)' : 'rgba(255,255,255,0.92)';
  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const mono: React.CSSProperties = { fontFamily: 'monospace', fontSize: 12 };
  const bull = '#26a69a';
  const bear = '#ef5350';

  // Prefer the DB-loaded series identity; fall back to whatever the raw
  // candles carry (works for CSV files that only set `symbol` per row).
  const seriesLabel = currentSeries
    ? `${currentSeries.market.toUpperCase()} · ${currentSeries.symbol}`
    : (rawCandles[0]?.symbol ? rawCandles[0].symbol : 'No symbol loaded');

  // Header block – shown even when the cursor isn't over a bar so the chart
  // always tells you what you're looking at.
  const header = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
      <strong style={{ fontSize: 13 }}>{seriesLabel}</strong>
      <span style={{ fontSize: 11, opacity: 0.7 }}>{timeframe}</span>
    </div>
  );

  // No crosshair yet – render just the header at the top-left as a watermark.
  if (!crosshair.visible) {
    return (
      <div style={{
        position: 'absolute', top: 8, left: 8, background: bg, color: text,
        padding: '4px 8px', borderRadius: 4, ...mono, boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
      }}>
        {header}
      </div>
    );
  }

  // Use the resolved (possibly extrapolated) timestamp from crosshair state
  const displayTs = crosshair.timestamp || slot?.timestamp || 0;
  const tz = session.timezone;
  const isDailyOrCoarser = ['1d', '1w', '1M'].includes(timeframe);

  // Format timestamp.
  //   • D/W/M slots are anchored at 12:00 UTC of the trading date, so
  //     formatting in UTC always shows the correct calendar day for every
  //     display tz (Sydney, NY, LA, UTC …).
  //   • Intraday slots carry the exact market timestamp; format in the
  //     session tz so wall-clock times match the session open/close.
  function formatTime(ts: number): string {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isDailyOrCoarser) {
      return d.toLocaleDateString('en-US', {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    }
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

  if (!c) {
    return (
      <div style={{ position: 'absolute', top: 8, left: 8, background: bg, color: text, padding: '4px 8px', borderRadius: 4, ...mono }}>
        {header}
        <div style={{ opacity: 0.7 }}>{formatTime(displayTs)} — No data</div>
      </div>
    );
  }

  const isUp = c.close >= c.open;
  const color = isUp ? bull : bear;
  const pct = ((c.close - c.open) / c.open * 100).toFixed(2);

  // For D/W/M use the slot's noon-UTC timestamp (session-agnostic anchor);
  // for intraday use the raw candle's own timestamp.
  const labelTs = isDailyOrCoarser ? (slot?.timestamp ?? c.timestamp) : c.timestamp;

  return (
    <div style={{ position: 'absolute', top: 8, left: 8, background: bg, color: text, padding: '6px 10px', borderRadius: 4, ...mono, lineHeight: 1.6, boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
      {header}
      <div style={{ opacity: 0.6, fontSize: 10 }}>{formatTime(labelTs)}</div>
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
