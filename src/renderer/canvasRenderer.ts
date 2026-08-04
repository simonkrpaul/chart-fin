/**
 * Canvas 2D Renderer
 *
 * Renders the chart onto a layered canvas setup:
 *   1. Background layer  – grid, session shading, axis labels
 *   2. Candle layer      – primary candlesticks + volume bars
 *   3. Overlay layer     – offset comparison overlays
 *   4. Indicator layer   – MA lines, etc.
 *   5. Drawing layer     – trendlines, rectangles, etc.
 *   6. Overlay-UI layer  – crosshair, tooltip, measurement labels
 *
 * All coordinate math is viewport-relative.  Slot width is computed from
 * (canvasWidth - priceAxisWidth) / visibleSlotCount.
 */
import type {
  CandleSlot,
  CrosshairState,
  Drawing,
  FibonacciDrawing,
  GridDiagonalData,
  IndicatorSeries,
  OffsetOverlay,
  PriceScale,
  SignalMarker,
  SRZone,
  ThemeTokens,
  Timeframe,
  TradeMarker,
  Viewport,
  BacktestSignal,
  TradeLogRoundTrip,
  EphemerisMarker,
  HighLowLevel,
  TransitZoneGroup,
  CycleCombinerOutput,
} from '../types';
import { FIBONACCI_DEFAULT_LEVELS } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  viewport: Viewport;
  priceScale: PriceScale;
  theme: ThemeTokens;
  dpr: number; // device pixel ratio
  timeframe: Timeframe;
  /** IANA timezone used for slot generation and axis labels (e.g. "America/New_York", "UTC") */
  timezone: string;
  /** If set, only render candles/indicators up to this slot index (bar replay mode). */
  replayIndex?: number;
}

function slotWidth(vp: Viewport): number {
  return (vp.width - vp.priceAxisWidth) / vp.visibleSlotCount;
}

function slotToX(slotIndex: number, vp: Viewport): number {
  const sw = slotWidth(vp);
  return (slotIndex - vp.firstSlotIndex) * sw;
}

function priceToY(price: number, ps: PriceScale, paneHeight: number): number {
  if (ps.max === ps.min) return paneHeight / 2;
  return paneHeight - ((price - ps.min) / (ps.max - ps.min)) * paneHeight;
}

// ─────────────────────────────────────────────────────────────────────────────
// Background layer
// ─────────────────────────────────────────────────────────────────────────────

export function renderBackground(rc: RenderContext, slots: CandleSlot[]): void {
  const { ctx, viewport: vp, priceScale: ps, theme } = rc;
  const pw = vp.width - vp.priceAxisWidth;
  const ph = vp.mainPaneHeight;
  const sw = slotWidth(vp);

  // Fill background
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, vp.width, ph + vp.subPaneHeight + vp.timeAxisHeight);

  // Horizontal grid lines (price)
  const gridCount = 6;
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridCount; i++) {
    const y = (i / gridCount) * ph;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(pw, y);
    ctx.stroke();
  }

  // Shade missing slots (weekend / holiday)
  for (let i = 0; i < vp.visibleSlotCount; i++) {
    const si = vp.firstSlotIndex + i;
    if (si >= slots.length) break;
    const slot = slots[si];
    if (slot.status === 'weekend' || slot.status === 'holiday') {
      const x = i * sw;
      ctx.fillStyle = theme.missingSlot;
      ctx.fillRect(x, 0, sw, ph);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-chart hour labels (intraday only) – thin vertical tick + hour at chart top
// ─────────────────────────────────────────────────────────────────────────────

export function renderHourLabels(rc: RenderContext, slots: CandleSlot[]): void {
  const isIntraday = rc.timeframe !== '1d' && rc.timeframe !== '1w' && rc.timeframe !== '1M';
  if (!isIntraday || slots.length === 0) return;

  const { ctx, viewport: vp, theme } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const pw = vp.width - vp.priceAxisWidth;
  const tz = rc.timezone;

  // Average interval for extrapolating virtual future slots
  const avgIntervalMs = slots.length > 1
    ? (slots[slots.length - 1].timestamp - slots[0].timestamp) / (slots.length - 1)
    : 60_000;

  // For 1h candles, label every candle. For sub-hour, label at each hour boundary.
  const is1hCandle = avgIntervalMs >= 3_500_000 && avgIntervalMs <= 3_700_000; // ~1 hour

  let lastHour = '';

  ctx.save();
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i < vp.visibleSlotCount; i++) {
    const si = vp.firstSlotIndex + i;
    const ts = si < slots.length
      ? slots[si].timestamp
      : slots.length > 0
        ? slots[slots.length - 1].timestamp + (si - slots.length + 1) * avgIntervalMs
        : 0;
    if (!ts) continue;

    const d = new Date(ts);
    const hourStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
    const hour = hourStr.split(':')[0];

    if (is1hCandle) {
      // Every candle is 1 hour — label every single one
      const x = i * sw + sw / 2;
      if (x < 0 || x > pw) continue;

      // Subtle vertical tick line
      ctx.strokeStyle = theme.gridLine;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.15;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x, ph);
      ctx.stroke();
      ctx.setLineDash([]);

      // Hour number on every candle
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = theme.axisText;
      ctx.fillText(hour, x, 2);
    } else {
      // Sub-hour timeframe: label at each new hour boundary
      if (hour === lastHour) continue;
      lastHour = hour;

      const x = i * sw + sw / 2;
      if (x < 0 || x > pw) continue;

      ctx.strokeStyle = theme.gridLine;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.2;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, 12);
      ctx.lineTo(x, ph);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 0.7;
      ctx.fillStyle = theme.axisText;
      ctx.fillText(hour, x, 2);
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Price axis
// ─────────────────────────────────────────────────────────────────────────────

export function renderPriceAxis(rc: RenderContext): void {
  const { ctx, viewport: vp, priceScale: ps, theme } = rc;
  const pw = vp.width - vp.priceAxisWidth;
  const ph = vp.mainPaneHeight;

  ctx.fillStyle = theme.background;
  ctx.fillRect(pw, 0, vp.priceAxisWidth, ph);

  ctx.strokeStyle = theme.axisBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pw, 0);
  ctx.lineTo(pw, ph);
  ctx.stroke();

  const gridCount = 6;
  ctx.fillStyle = theme.axisText;
  ctx.font = `11px -apple-system, sans-serif`;
  ctx.textAlign = 'left';

  for (let i = 0; i <= gridCount; i++) {
    const price = ps.min + ((gridCount - i) / gridCount) * (ps.max - ps.min);
    const y = (i / gridCount) * ph;
    ctx.fillText(formatPrice(price), pw + 6, y + 4);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Time axis
// ─────────────────────────────────────────────────────────────────────────────

export function renderTimeAxis(rc: RenderContext, slots: CandleSlot[]): void {
  const { ctx, viewport: vp, theme } = rc;
  const sw = slotWidth(vp);
  const y0 = vp.mainPaneHeight + vp.subPaneHeight;
  const pw = vp.width - vp.priceAxisWidth;
  const tz = rc.timezone;

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, y0, pw, vp.timeAxisHeight);

  ctx.strokeStyle = theme.axisBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y0);
  ctx.lineTo(pw, y0);
  ctx.stroke();

  ctx.fillStyle = theme.axisText;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'center';

  // Label density: ~80px per label
  const labelInterval = Math.max(1, Math.floor(80 / sw));
  let lastYear = '';
  let lastMonth = '';

  // Average interval for extrapolating timestamps of virtual future slots
  const avgIntervalMs = slots.length > 1
    ? (slots[slots.length - 1].timestamp - slots[0].timestamp) / (slots.length - 1)
    : 60_000;

  for (let i = 0; i < vp.visibleSlotCount; i += labelInterval) {
    const si = vp.firstSlotIndex + i;
    // For virtual slots past the last primary slot, extrapolate the timestamp
    const ts = si < slots.length
      ? slots[si].timestamp
      : slots.length > 0
        ? slots[slots.length - 1].timestamp + (si - slots.length + 1) * avgIntervalMs
        : 0;
    if (!ts) continue;
    const d = new Date(ts);
    const x = i * sw + sw / 2;
    let label: string;

    if (rc.timeframe === '1M') {
      const yr  = String(d.getUTCFullYear());
      const mon = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
      label = yr !== lastYear ? `${mon} ${yr}` : mon;
      lastYear = yr;
    } else if (rc.timeframe === '1w') {
      const mon = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
      const day = d.getUTCDate();
      const yr  = String(d.getUTCFullYear());
      label = mon !== lastMonth ? `${mon} ${day}` : String(day);
      if (mon !== lastMonth) { lastMonth = mon; lastYear = yr; }
    } else if (rc.timeframe === '1d') {
      const mon = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
      const day = d.getUTCDate();
      label = mon !== lastMonth ? `${mon} ${day}` : String(day);
      lastMonth = mon;
    } else {
      // Intraday: show date/time in the session timezone
      const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });
      const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
      label = dateStr !== lastMonth ? dateStr : timeStr;
      lastMonth = dateStr;
    }

    ctx.fillText(label, x, y0 + 15);
  }

  // ── Timezone badge – bottom-right of time axis, left of price axis border ──
  const tzAbbr = (() => {
    try {
      // Get short offset string, e.g. "GMT-4" or "UTC"
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset', timeZone: tz })
        .formatToParts(new Date());
      const offset = parts.find(p => p.type === 'timeZoneName')?.value ?? tz;
      // Also get the city/region short name for display, e.g. "New York" from "America/New_York"
      const city = tz.includes('/') ? tz.split('/').pop()!.replace(/_/g, ' ') : tz;
      return `${city} (${offset})`;
    } catch {
      return tz;
    }
  })();

  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.axisText;
  ctx.globalAlpha = 0.55;
  ctx.fillText(tzAbbr, pw - 6, y0 + 15);
  ctx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candlesticks + volume
// ─────────────────────────────────────────────────────────────────────────────

export function renderCandles(rc: RenderContext, slots: CandleSlot[]): void {
  const { ctx, viewport: vp, priceScale: ps, theme } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const bodyW = Math.max(1, sw * 0.6);

  for (let i = 0; i < vp.visibleSlotCount; i++) {
    const si = vp.firstSlotIndex + i;
    if (si >= slots.length) break;
    if (rc.replayIndex !== undefined && si > rc.replayIndex) break;
    const slot = slots[si];
    if (!slot.candle) continue;

    const c = slot.candle;
    const x = i * sw + sw / 2;
    const isBull = c.close >= c.open;
    const color = isBull ? theme.bullCandle : theme.bearCandle;

    const openY = priceToY(c.open, ps, ph);
    const closeY = priceToY(c.close, ps, ph);
    const highY = priceToY(c.high, ps, ph);
    const lowY = priceToY(c.low, ps, ph);

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    // Body
    const bodyTop = Math.min(openY, closeY);
    const bodyH = Math.max(1, Math.abs(openY - closeY));
    ctx.fillStyle = color;
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume bars (in sub-pane)
// ─────────────────────────────────────────────────────────────────────────────

export function renderVolume(rc: RenderContext, slots: CandleSlot[]): void {
  const { ctx, viewport: vp, theme } = rc;
  const sw = slotWidth(vp);
  const ph = vp.subPaneHeight;
  const y0 = vp.mainPaneHeight;
  const barW = Math.max(1, sw * 0.7);

  // Find max volume in view for scale
  let maxVol = 1;
  for (let i = 0; i < vp.visibleSlotCount; i++) {
    const si = vp.firstSlotIndex + i;
    if (rc.replayIndex !== undefined && si > rc.replayIndex) break;
    const c = slots[si]?.candle;
    if (c && c.volume > maxVol) maxVol = c.volume;
  }

  for (let i = 0; i < vp.visibleSlotCount; i++) {
    const si = vp.firstSlotIndex + i;
    if (si >= slots.length) break;
    if (rc.replayIndex !== undefined && si > rc.replayIndex) break;
    const slot = slots[si];
    if (!slot.candle) continue;

    const c = slot.candle;
    const x = i * sw + sw / 2;
    const barH = (c.volume / maxVol) * ph * 0.9;
    const isBull = c.close >= c.open;
    ctx.fillStyle = isBull ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)';
    ctx.fillRect(x - barW / 2, y0 + ph - barH, barW, barH);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycle Combiner
// ─────────────────────────────────────────────────────────────────────────────

export function renderCycleCombiner(
  rc: RenderContext,
  output: CycleCombinerOutput,
  color: string,
): void {
  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const { values, min, max } = output;
  const range = max - min || 1;

  // Map combiner value → Y in main pane (scale to fill 5%-95% of chart height for wide swings)
  const padding = ph * 0.05;
  const drawH = ph - padding * 2;
  const toY = (v: number) => padding + drawH * (1 - (v - min) / range);

  // Zero line Y
  const zeroY = toY(0);

  // Draw zero line (subtle dashed)
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  ctx.lineTo(vp.width - vp.priceAxisWidth, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Collect points
  const points: { x: number; y: number; val: number }[] = [];
  for (let i = 0; i < vp.visibleSlotCount; i++) {
    const si = vp.firstSlotIndex + i;
    if (si < 0 || si >= values.length) continue;
    if (rc.replayIndex !== undefined && si > rc.replayIndex) break;
    const v = values[si];
    if (v === null) continue;
    const x = i * sw + sw / 2;
    const y = toY(v);
    points.push({ x, y, val: v });
  }

  if (points.length < 2) { ctx.restore(); return; }

  // Fill above/below zero with translucent green/red
  // Green fill (above zero)
  ctx.beginPath();
  let inGreen = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.val >= 0) {
      if (!inGreen) { ctx.moveTo(p.x, zeroY); inGreen = true; }
      ctx.lineTo(p.x, p.y);
    } else {
      if (inGreen) { ctx.lineTo(p.x, zeroY); inGreen = false; }
    }
  }
  if (inGreen) ctx.lineTo(points[points.length - 1].x, zeroY);
  ctx.closePath();
  ctx.fillStyle = 'rgba(38, 166, 154, 0.35)';
  ctx.fill();

  // Red fill (below zero)
  ctx.beginPath();
  let inRed = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.val < 0) {
      if (!inRed) { ctx.moveTo(p.x, zeroY); inRed = true; }
      ctx.lineTo(p.x, p.y);
    } else {
      if (inRed) { ctx.lineTo(p.x, zeroY); inRed = false; }
    }
  }
  if (inRed) ctx.lineTo(points[points.length - 1].x, zeroY);
  ctx.closePath();
  ctx.fillStyle = 'rgba(239, 83, 80, 0.35)';
  ctx.fill();

  // Draw the line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Indicators
// ─────────────────────────────────────────────────────────────────────────────

export function renderIndicators(
  rc: RenderContext,
  indicatorSeries: IndicatorSeries[],
  slots: CandleSlot[] = [],
): void {
  const { ctx, viewport: vp, priceScale: ps, theme } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;

  for (const series of indicatorSeries) {
    if (!series.config.visible) continue;

    // ── SWING_HL: zigzag lines + H/L labels ────────────────────────────────
    if (series.config.type === 'SWING_HL') {
      _renderSwingHL(rc, series, slots);
      continue;
    }

    // ── SUPPORT_RESISTANCE: coloured zone boxes ─────────────────────────────
    if (series.config.type === 'SUPPORT_RESISTANCE') {
      _renderSRZones(rc, series);
      continue;
    }

    // ── SESSIONS: session range boxes with labels ───────────────────────────
    if (series.config.type === 'SESSIONS') {
      _renderSessions(rc, series);
      continue;
    }

    // ── MOON_SIGNALS: buy/sell markers ───────────────────────────────────────
    if (series.config.type === 'MOON_SIGNALS') {
      _renderMoonSignals(rc, series);
      continue;
    }

    // ── DYNAMIC_GRID: horizontal lines, vertical lines, diagonal lines ──────
    if (series.config.type === 'DYNAMIC_GRID') {
      _renderDynamicGrid(rc, series, slots);
      continue;
    }

    // ── WICK_REVERSAL: long wick markers ─────────────────────────────────────
    if (series.config.type === 'WICK_REVERSAL') {
      _renderWickReversal(rc, series);
      continue;
    }

    // ── TRADE_SIGNALS: entry/exit arrows with PnL ────────────────────────────
    if (series.config.type === 'TRADE_SIGNALS') {
      _renderTradeSignals(rc, series);
      continue;
    }

    // ── HIGH_LOW_LEVELS: horizontal high/low lines per period ────────────────
    if (series.config.type === 'HIGH_LOW_LEVELS') {
      _renderHighLowLevels(rc, series);
      continue;
    }

    if (series.config.pane !== 'main') continue;

    ctx.strokeStyle = series.config.color;
    ctx.lineWidth = series.config.lineWidth;
    ctx.setLineDash([]);
    ctx.beginPath();

    let started = false;
    for (let i = 0; i < vp.visibleSlotCount; i++) {
      const si = vp.firstSlotIndex + i;
      if (rc.replayIndex !== undefined && si > rc.replayIndex) break;
      const pt = series.points[si];
      if (!pt || pt.value === null) { started = false; continue; }

      const x = i * sw + sw / 2;
      const y = priceToY(pt.value, ps, ph);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ── Private: render SUPPORT_RESISTANCE zones ──────────────────────────────────

const SR_SUPPORT_COLOR    = '#26a69a'; // green
const SR_RESISTANCE_COLOR = '#ef5350'; // red
const SR_INSIDE_COLOR     = '#787b86'; // gray

function _renderSRZones(rc: RenderContext, series: IndicatorSeries): void {
  const zones = series.srZones;
  if (!zones || zones.length === 0) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const pw = vp.width - vp.priceAxisWidth;
  const transparency = ((series.config.params.transparency as number) ?? 35) / 100;

  const replayEnd = rc.replayIndex ?? Infinity;

  for (const zone of zones) {
    // Skip zones that start after the replay cursor
    if (zone.leftBarSlotIndex > replayEnd) continue;
    const topY = priceToY(zone.top, ps, ph);
    const bottomY = priceToY(zone.bottom, ps, ph);

    // Skip zones entirely off-screen vertically
    if (topY > ph && bottomY > ph) continue;
    if (topY < 0 && bottomY < 0) continue;

    // Determine left edge: zone starts from leftBarSlotIndex
    const leftX = Math.max(0, (zone.leftBarSlotIndex - vp.firstSlotIndex) * sw);

    // Zone extends to the right edge of the chart (extend.right in Pine)
    const rightX = pw;
    if (leftX >= pw) continue;

    const zoneColor = zone.side === 1 ? SR_SUPPORT_COLOR
                    : zone.side === -1 ? SR_RESISTANCE_COLOR
                    : SR_INSIDE_COLOR;

    const y1 = Math.min(topY, bottomY);
    const h = Math.abs(bottomY - topY);

    // Fill
    ctx.save();
    ctx.globalAlpha = 1 - transparency;
    ctx.fillStyle = zoneColor;
    ctx.fillRect(leftX, y1, rightX - leftX, h);
    ctx.restore();

    // Border lines (top and bottom of zone)
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = zoneColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(leftX, topY);
    ctx.lineTo(rightX, topY);
    ctx.moveTo(leftX, bottomY);
    ctx.lineTo(rightX, bottomY);
    ctx.stroke();
    ctx.restore();

    // Touch count label on the right edge
    ctx.save();
    ctx.fillStyle = zoneColor;
    ctx.globalAlpha = 0.8;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    const midY = (topY + bottomY) / 2;
    ctx.fillText(`${zone.touches} touches`, rightX - 4, midY + 3);
    ctx.restore();
  }
}

// ── Private: render SESSIONS range boxes ──────────────────────────────────────

function _renderSessions(rc: RenderContext, series: IndicatorSeries): void {
  const zones = series.sessionZones;
  if (!zones || zones.length === 0) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const transparency = ((series.config.params.transparency as number) ?? 90) / 100;

  const firstVisible = vp.firstSlotIndex;
  const lastVisible = vp.firstSlotIndex + vp.visibleSlotCount;
  const replayEnd = rc.replayIndex ?? Infinity;

  for (const zone of zones) {
    // Skip zones entirely off-screen
    if (zone.endSlotIndex < firstVisible || zone.startSlotIndex > lastVisible) continue;
    // Skip zones that start after the replay cursor
    if (zone.startSlotIndex > replayEnd) continue;

    const clampedEndSlot = Math.min(zone.endSlotIndex, replayEnd);
    const x1 = Math.max(0, (zone.startSlotIndex - firstVisible) * sw);
    const x2 = Math.min(vp.width - vp.priceAxisWidth, (clampedEndSlot - firstVisible + 1) * sw);
    const topY = priceToY(zone.high, ps, ph);
    const bottomY = priceToY(zone.low, ps, ph);

    // Skip zones entirely off-screen vertically
    if (topY > ph && bottomY > ph) continue;
    if (topY < 0 && bottomY < 0) continue;

    const y1 = Math.min(topY, bottomY);
    const h = Math.abs(bottomY - topY);

    // Background fill
    ctx.save();
    ctx.globalAlpha = 1 - transparency;
    ctx.fillStyle = zone.color;
    ctx.fillRect(x1, y1, x2 - x1, h);
    ctx.restore();

    // Dotted outline
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = zone.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(x1, y1, x2 - x1, h);
    ctx.setLineDash([]);
    ctx.restore();

    // Session label (top center of box, below hour labels row)
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = zone.color;
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const labelX = (x1 + x2) / 2;
    const labelY = Math.max(y1 - 2, 22);
    ctx.fillText(zone.name, labelX, labelY);
    ctx.restore();
  }

  // ── Weekend vertical markers ───────────────────────────────────────────
  const markers = series.weekendMarkers;
  if (markers && markers.length > 0) {
    const firstVisible = vp.firstSlotIndex;
    const lastVisible2 = vp.firstSlotIndex + vp.visibleSlotCount;

    for (const marker of markers) {
      if (marker.slotIndex < firstVisible || marker.slotIndex > lastVisible2) continue;
      if (marker.slotIndex > replayEnd) continue;

      const x = (marker.slotIndex - firstVisible) * sw;

      // Dashed vertical line spanning the full main pane
      ctx.save();
      ctx.strokeStyle = '#787b86';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ph);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Day label at the top (below hour labels row)
      ctx.save();
      ctx.fillStyle = '#787b86';
      ctx.globalAlpha = 0.8;
      ctx.font = '9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(marker.label, x, 15);
      ctx.restore();
    }
  }
}

// ── Private: render MOON_SIGNALS buy/sell markers ─────────────────────────────

function _renderMoonSignals(rc: RenderContext, series: IndicatorSeries): void {
  const markers = series.signalMarkers;
  if (!markers || markers.length === 0) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const firstVisible = vp.firstSlotIndex;
  const lastVisible = vp.firstSlotIndex + vp.visibleSlotCount;

  const replayEnd = rc.replayIndex ?? Infinity;

  for (const marker of markers) {
    if (marker.slotIndex < firstVisible || marker.slotIndex > lastVisible) continue;
    if (marker.slotIndex > replayEnd) continue;

    const x = (marker.slotIndex - firstVisible) * sw + sw / 2;
    const y = priceToY(marker.price, ps, ph);

    const isBuy = marker.type === 'buy';
    const color = isBuy ? '#00e676' : '#ff5252';
    const triangleSize = Math.max(6, Math.min(12, sw * 0.6));

    // Draw vertical dashed line
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ph);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Draw triangle marker
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    if (isBuy) {
      // Upward triangle below the candle
      const tipY = y + triangleSize * 0.5;
      ctx.moveTo(x, tipY - triangleSize);
      ctx.lineTo(x - triangleSize * 0.6, tipY);
      ctx.lineTo(x + triangleSize * 0.6, tipY);
    } else {
      // Downward triangle above the candle
      const tipY = y - triangleSize * 0.5;
      ctx.moveTo(x, tipY + triangleSize);
      ctx.lineTo(x - triangleSize * 0.6, tipY);
      ctx.lineTo(x + triangleSize * 0.6, tipY);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Draw label
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.font = 'bold 9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    if (isBuy) {
      ctx.textBaseline = 'top';
      ctx.fillText('BUY', x, y + triangleSize * 0.7);
    } else {
      ctx.textBaseline = 'bottom';
      ctx.fillText('SELL', x, y - triangleSize * 0.7);
    }
    ctx.restore();
  }
}

// ── Private: render WICK_REVERSAL markers ─────────────────────────────────────

function _renderWickReversal(rc: RenderContext, series: IndicatorSeries): void {
  const markers = series.signalMarkers;
  if (!markers || markers.length === 0) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const firstVisible = vp.firstSlotIndex;
  const lastVisible = vp.firstSlotIndex + vp.visibleSlotCount;

  const replayEnd = rc.replayIndex ?? Infinity;

  for (const m of markers) {
    if (m.slotIndex < firstVisible || m.slotIndex > lastVisible) continue;
    if (m.slotIndex > replayEnd) continue;

    const x = (m.slotIndex - firstVisible + 0.5) * sw;
    const y = priceToY(m.price, ps, ph);
    const isBuy = m.type === 'buy';
    const isPin = m.label === 'PIN';
    const color = isPin ? (isBuy ? '#ffab00' : '#e040fb') : (isBuy ? '#00e676' : '#ff1744');
    const label = m.label ?? 'W';

    const size = Math.max(5, Math.min(sw * 0.4, 10));
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();

    if (isPin) {
      // Star/circle marker for pin bars — more prominent
      const cy = isBuy ? y + size + 4 : y - size - 4;
      ctx.arc(x, cy, size * 0.7, 0, Math.PI * 2);
    } else {
      // Diamond marker for wick reversals
      const cy = isBuy ? y + size + 4 : y - size - 4;
      ctx.moveTo(x, cy - size);
      ctx.lineTo(x + size * 0.6, cy);
      ctx.lineTo(x, cy + size);
      ctx.lineTo(x - size * 0.6, cy);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Label
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.font = `bold ${isPin ? 9 : 8}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    if (isBuy) {
      ctx.textBaseline = 'top';
      ctx.fillText(label, x, y + size * 2 + 6);
    } else {
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, x, y - size * 2 - 6);
    }
    ctx.restore();
  }
}

// ── Private: render TRADE_SIGNALS entry/exit markers ──────────────────────────

function _renderTradeSignals(rc: RenderContext, series: IndicatorSeries): void {
  const trades = series.tradeMarkers;
  if (!trades || trades.length === 0) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const firstVisible = vp.firstSlotIndex;
  const lastVisible = vp.firstSlotIndex + vp.visibleSlotCount;
  const replayEnd = rc.replayIndex ?? Infinity;

  for (const trade of trades) {
    // Skip trades beyond the replay cursor
    if (trade.entrySlotIndex > replayEnd) continue;
    const entryVisible = trade.entrySlotIndex >= firstVisible && trade.entrySlotIndex <= lastVisible;
    const exitVisible = trade.exitSlotIndex >= firstVisible && trade.exitSlotIndex <= lastVisible && trade.exitSlotIndex <= replayEnd;

    if (!entryVisible && !exitVisible) continue;

    const isLong = trade.direction === 'long';
    const entryColor = isLong ? '#2962ff' : '#e91e63';
    const exitColor = trade.win ? '#26a69a' : '#ef5350';
    const arrowSize = Math.max(7, Math.min(14, sw * 0.7));

    // ── Entry marker ─────────────────────────────────────────────────────
    if (entryVisible) {
      const ex = (trade.entrySlotIndex - firstVisible + 0.5) * sw;
      const ey = priceToY(trade.entryPrice, ps, ph);

      // Connecting line from entry to exit (if both visible)
      if (exitVisible) {
        const xx = (trade.exitSlotIndex - firstVisible + 0.5) * sw;
        const xy = priceToY(trade.exitPrice, ps, ph);
        ctx.save();
        ctx.strokeStyle = exitColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(xx, xy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Entry arrow
      ctx.save();
      ctx.fillStyle = entryColor;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      if (isLong) {
        // Upward arrow (long entry)
        const tipY = ey + arrowSize + 4;
        ctx.moveTo(ex, tipY - arrowSize);
        ctx.lineTo(ex - arrowSize * 0.5, tipY);
        ctx.lineTo(ex + arrowSize * 0.5, tipY);
      } else {
        // Downward arrow (short entry)
        const tipY = ey - arrowSize - 4;
        ctx.moveTo(ex, tipY + arrowSize);
        ctx.lineTo(ex - arrowSize * 0.5, tipY);
        ctx.lineTo(ex + arrowSize * 0.5, tipY);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Entry label
      ctx.save();
      ctx.fillStyle = entryColor;
      ctx.globalAlpha = 0.9;
      ctx.font = 'bold 9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      if (isLong) {
        ctx.textBaseline = 'top';
        ctx.fillText('LONG', ex, ey + arrowSize + 6);
      } else {
        ctx.textBaseline = 'bottom';
        ctx.fillText('SHORT', ex, ey - arrowSize - 6);
      }
      ctx.restore();
    }

    // ── Exit marker ──────────────────────────────────────────────────────
    if (exitVisible) {
      const xx = (trade.exitSlotIndex - firstVisible + 0.5) * sw;
      const xy = priceToY(trade.exitPrice, ps, ph);

      // Exit X marker
      ctx.save();
      ctx.strokeStyle = exitColor;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      const xSize = arrowSize * 0.4;
      ctx.beginPath();
      ctx.moveTo(xx - xSize, xy - xSize);
      ctx.lineTo(xx + xSize, xy + xSize);
      ctx.moveTo(xx + xSize, xy - xSize);
      ctx.lineTo(xx - xSize, xy + xSize);
      ctx.stroke();
      ctx.restore();

      // PnL label
      const pnlText = `${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(2)}%`;
      ctx.save();
      ctx.font = 'bold 9px -apple-system, sans-serif';
      ctx.textAlign = 'center';

      // Background pill for PnL
      const metrics = ctx.measureText(pnlText);
      const pillW = metrics.width + 8;
      const pillH = 14;
      const pillY = isLong ? xy - arrowSize - 16 : xy + arrowSize + 4;

      ctx.fillStyle = exitColor;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.roundRect(xx - pillW / 2, pillY, pillW, pillH, 3);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 1;
      ctx.textBaseline = 'middle';
      ctx.fillText(pnlText, xx, pillY + pillH / 2);
      ctx.restore();
    }
  }
}

// ── Private: render HIGH_LOW_LEVELS (horizontal lines for period highs/lows) ──

function _renderHighLowLevels(rc: RenderContext, series: IndicatorSeries): void {
  const levels = series.highLowLevels;
  if (!levels || levels.length === 0) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const firstVisible = vp.firstSlotIndex;
  const lastVisible = vp.firstSlotIndex + vp.visibleSlotCount;
  const chartWidth = vp.width - vp.priceAxisWidth;
  const replayEnd = rc.replayIndex ?? Infinity;

  ctx.save();

  for (const level of levels) {
    // Skip levels completely outside the visible range
    if (level.endSlotIndex < firstVisible || level.startSlotIndex > lastVisible) continue;
    // Skip levels that start after the replay cursor
    if (level.startSlotIndex > replayEnd) continue;

    const clampedEnd = Math.min(level.endSlotIndex, replayEnd);
    const x1 = Math.max(0, (level.startSlotIndex - firstVisible) * sw);
    const x2 = Math.min(chartWidth, (clampedEnd - firstVisible + 1) * sw);
    const y = priceToY(level.price, ps, ph);

    // Skip if line is outside the canvas vertically
    if (y < -5 || y > ph + 5) continue;

    ctx.strokeStyle = level.color;
    ctx.lineWidth = level.type === 'high' ? 1.5 : 1;
    ctx.globalAlpha = 0.8;

    // Dashed for high, dotted for low
    ctx.setLineDash(level.type === 'high' ? [6, 3] : [2, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();

    // Label
    if (level.label) {
      ctx.setLineDash([]);
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillStyle = level.color;
      ctx.globalAlpha = 0.9;
      ctx.textAlign = 'left';
      ctx.textBaseline = level.type === 'high' ? 'bottom' : 'top';
      const labelY = level.type === 'high' ? y - 2 : y + 2;
      ctx.fillText(level.label, x1 + 4, labelY);
    }
  }

  ctx.setLineDash([]);
  ctx.restore();
}

// ── Private: render DYNAMIC_GRID (horizontal + vertical + diagonal lines) ─────

function _renderDynamicGrid(
  rc: RenderContext,
  series: IndicatorSeries,
  slots: CandleSlot[],
): void {
  const gd = series.gridData;
  if (!gd) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const pw = vp.width - vp.priceAxisWidth;

  const { date1, date2, interval, numLines } = gd;

  // Helper: find X position for a given timestamp using slot interpolation
  function tsToX(ts: number): number {
    if (slots.length < 2) return -9999;
    // Binary search for closest slot
    let lo = 0, hi = slots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (slots[mid].timestamp < ts) lo = mid + 1;
      else hi = mid;
    }
    // Interpolate between surrounding slots
    const idx = lo;
    if (idx >= slots.length) {
      // Extrapolate past end
      const avgMs = (slots[slots.length - 1].timestamp - slots[0].timestamp) / (slots.length - 1);
      const extraSlots = (ts - slots[slots.length - 1].timestamp) / avgMs;
      return (slots.length - 1 + extraSlots - vp.firstSlotIndex) * sw;
    }
    if (idx === 0 || slots[idx].timestamp === ts) {
      return (idx - vp.firstSlotIndex) * sw;
    }
    // Interpolate
    const prev = slots[idx - 1];
    const curr = slots[idx];
    const frac = (ts - prev.timestamp) / (curr.timestamp - prev.timestamp);
    const slotPos = (idx - 1) + frac;
    return (slotPos - vp.firstSlotIndex) * sw;
  }

  // Determine the range of horizontal levels to draw (from 0 upward, filtered to visible)
  const visibleMin = ps.min;
  const visibleMax = ps.max;
  const currentMid = (visibleMin + visibleMax) / 2;

  // Compute levels centered around current price to cover numLines above/below
  const baseLevelIdx = Math.round(currentMid / interval);
  const startIdx = baseLevelIdx - numLines;
  const endIdx = baseLevelIdx + numLines;

  // Vertical line colors
  const colorVert = (series.config.params.colorVert as string) ?? '#2962ff';
  const colorHoriz = (series.config.params.colorHoriz as string) ?? '#e0b500';
  const colorDiag = (series.config.params.colorDiag as string) ?? '#e53935';

  // Recurring period: repeat verticals + diagonals every (date2 - date1) ms
  const period = date2 - date1;
  // Determine visible time range to know how many periods to draw
  const firstVisibleTs = slots.length > 0
    ? slots[Math.max(0, vp.firstSlotIndex)]?.timestamp ?? slots[0].timestamp
    : date1;
  const lastVisibleTs = slots.length > 0
    ? (slots[Math.min(slots.length - 1, vp.firstSlotIndex + vp.visibleSlotCount)]?.timestamp ?? slots[slots.length - 1].timestamp)
    : date2;
  // How many periods back/forward from date1 do we need?
  const periodsBack = Math.ceil((date1 - firstVisibleTs) / period) + 1;
  const periodsFwd = Math.ceil((lastVisibleTs - date1) / period) + 1;

  ctx.save();

  // ── Horizontal lines ──
  ctx.strokeStyle = colorHoriz;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  for (let idx = startIdx; idx <= endIdx; idx++) {
    const yLevel = idx * interval;
    if (yLevel < visibleMin || yLevel > visibleMax) continue;
    const y = priceToY(yLevel, ps, ph);
    ctx.moveTo(0, y);
    ctx.lineTo(pw, y);
  }
  ctx.stroke();

  // ── Recurring vertical lines + diagonals ──
  // Draw more levels to ensure diagonals crossing the visible area are included
  const extraLevels = Math.ceil((visibleMax - visibleMin) / interval) + 2;
  const diagStart = baseLevelIdx - numLines - extraLevels;
  const diagEnd = baseLevelIdx + numLines + extraLevels;

  for (let p = -periodsBack; p <= periodsFwd; p++) {
    const pStart = date1 + p * period;
    const pEnd = pStart + period;
    const xStart = tsToX(pStart);
    const xEnd = tsToX(pEnd);

    // ── Vertical line at period start ──
    ctx.strokeStyle = colorVert;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    ctx.setLineDash([]);
    ctx.beginPath();
    if (xStart >= -pw && xStart <= pw * 2) {
      ctx.moveTo(xStart, 0);
      ctx.lineTo(xStart, ph);
    }
    ctx.stroke();

    // ── Diagonal lines for this period ──
    ctx.strokeStyle = colorDiag;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (let idx = diagStart; idx <= diagEnd; idx++) {
      const yStart = idx * interval;
      const yEnd = yStart + interval;
      const y1 = priceToY(yStart, ps, ph);
      const y2 = priceToY(yEnd, ps, ph);
      if ((y1 < -ph && y2 < -ph) || (y1 > ph * 2 && y2 > ph * 2)) continue;
      ctx.moveTo(xStart, y1);
      ctx.lineTo(xEnd, y2);
    }
    ctx.stroke();
  }

  ctx.restore();
}

// ── Private: render one SWING_HL series ───────────────────────────────────────

function _renderSwingHL(
  rc: RenderContext,
  series: IndicatorSeries,
  slots: CandleSlot[],
): void {
  const sp = series.swingPoints;
  if (!sp || sp.length === 0) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const color = series.config.color;
  const lw = series.config.lineWidth;

  const lastVisibleSlot = vp.firstSlotIndex + vp.visibleSlotCount - 1;
  const replayEnd = rc.replayIndex ?? Infinity;

  // Helper: convert a slotIndex to screen X (centre of bar)
  function toX(slotIndex: number): number {
    return (slotIndex - vp.firstSlotIndex) * sw + sw / 2;
  }

  // ── 1. Draw zigzag segments between consecutive swing points ──────────────
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.setLineDash([]);
  ctx.lineJoin = 'round';
  ctx.beginPath();

  let pathStarted = false;
  for (let i = 0; i < sp.length; i++) {
    const p = sp[i];
    if (p.slotIndex > replayEnd) break;

    const x = toX(p.slotIndex);
    const y = priceToY(p.price, ps, ph);

    if (!pathStarted) { ctx.moveTo(x, y); pathStarted = true; }
    else ctx.lineTo(x, y);
  }

  // ── 2. Tail: last confirmed swing → current (last visible) bar ────────────
  // ZigZag mode: if last swing was a high, tail goes toward the low; vice-versa.
  const lastSp = sp[sp.length - 1];
  if (lastSp && lastSp.slotIndex <= replayEnd && slots.length > 0) {
    // Find the last visible, candle-bearing slot ≤ replayEnd
    let tailSlot: CandleSlot | null = null;
    const endIdx = Math.min(lastVisibleSlot, replayEnd, slots.length - 1);
    for (let i = endIdx; i >= 0; i--) {
      if (slots[i]?.candle) { tailSlot = slots[i]; break; }
    }
    if (tailSlot && tailSlot.slotIndex > lastSp.slotIndex) {
      const candle = tailSlot.candle!;
      const tailPrice = lastSp.type === 'high' ? candle.low : candle.high;
      const tx = toX(tailSlot.slotIndex);
      const ty = priceToY(tailPrice, ps, ph);

      if (!pathStarted) { ctx.moveTo(toX(lastSp.slotIndex), priceToY(lastSp.price, ps, ph)); }
      ctx.lineTo(tx, ty);
    }
  }

  ctx.stroke();

  // ── 3. Labels (H / L) and dots at each confirmed swing point ──────────────
  const dotR = Math.max(3, lw * 1.5);
  const labelFont = `bold ${Math.max(9, Math.min(12, sw * 0.6))}px -apple-system,sans-serif`;

  for (const p of sp) {
    if (p.slotIndex > replayEnd) break;

    // Only render if within extended visible range (allow a bit off-screen)
    const screenI = p.slotIndex - vp.firstSlotIndex;
    if (screenI < -2 || screenI > vp.visibleSlotCount + 2) continue;

    const x = toX(p.slotIndex);
    const y = priceToY(p.price, ps, ph);
    const isHigh = p.type === 'high';

    // Dot at pivot
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // "H" or "L" label above (for high) or below (for low)
    ctx.font = labelFont;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = isHigh ? 'bottom' : 'top';
    const labelY = isHigh ? y - dotR - 3 : y + dotR + 3;
    ctx.fillText(isHigh ? 'H' : 'L', x, labelY);
  }

  // ── % move pills between consecutive pivots ──────────────────────────────
  if (series.config.params.showSwingPct) {
    _drawSwingPctPills(ctx, sp, vp, ps, ph, sw, replayEnd);
  }

  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

// Helper shared by _renderSwingHL and _renderOverlaySwingHL
function _drawSwingPctPills(
  ctx: CanvasRenderingContext2D,
  swingPoints: import('../types').SwingPoint[],
  vp: { firstSlotIndex: number; visibleSlotCount: number },
  ps: import('../types').PriceScale,
  ph: number,
  sw: number,
  replayEnd: number,
  mapPrice: (p: number) => number = (p) => p,
): void {
  if (swingPoints.length < 2) return;
  ctx.font = 'bold 13px -apple-system,sans-serif';
  function toX(slotIndex: number) { return (slotIndex - vp.firstSlotIndex) * sw + sw / 2; }

  for (let i = 1; i < swingPoints.length; i++) {
    const prev = swingPoints[i - 1];
    const curr = swingPoints[i];
    if (curr.slotIndex > replayEnd) break;

    const sI0 = prev.slotIndex - vp.firstSlotIndex;
    const sI1 = curr.slotIndex - vp.firstSlotIndex;
    if (sI0 < -60 || sI0 > vp.visibleSlotCount + 60) continue;
    if (sI1 < -60 || sI1 > vp.visibleSlotCount + 60) continue;

    const diff = curr.price - prev.price;
    const pct = (diff / prev.price) * 100;
    const isRising = diff > 0;
    const sign = isRising ? '+' : '';
    const pctLine = sign + pct.toFixed(2) + '%';
    // Format points: use 2 decimals for values < 1000, 0 decimals for large prices
    const ptsFmt = Math.abs(diff) < 1000 ? diff.toFixed(2) : diff.toFixed(0);
    const ptsLine = sign + ptsFmt + ' pts';

    const x1 = toX(prev.slotIndex); const y1 = priceToY(mapPrice(prev.price), ps, ph);
    const x2 = toX(curr.slotIndex); const y2 = priceToY(mapPrice(curr.price), ps, ph);
    const midX = (x1 + x2) / 2;

    const padX = 5;
    const lineH = 17; // px per text line
    const padY = 3;
    const bh = lineH * 2 + padY * 2 + 1; // two text rows + padding + divider gap
    const bw = Math.max(ctx.measureText(pctLine).width, ctx.measureText(ptsLine).width) + padX * 2;

    // Anchor the pill at the extreme end of the segment:
    //   rising  (L→H): pill sits just above the H endpoint (top of move)
    //   falling (H→L): pill sits just below the L endpoint (bottom of move)
    const anchorY = isRising ? Math.min(y1, y2) : Math.max(y1, y2);
    const pillX = midX - bw / 2;
    const pillY = isRising ? anchorY - bh - 6 : anchorY + 6;

    const pillBg = isRising ? 'rgba(38,166,154,0.88)' : 'rgba(239,83,80,0.88)';
    ctx.fillStyle = pillBg;
    const r = 3;
    ctx.beginPath();
    ctx.moveTo(pillX + r, pillY);
    ctx.lineTo(pillX + bw - r, pillY);
    ctx.quadraticCurveTo(pillX + bw, pillY, pillX + bw, pillY + r);
    ctx.lineTo(pillX + bw, pillY + bh - r);
    ctx.quadraticCurveTo(pillX + bw, pillY + bh, pillX + bw - r, pillY + bh);
    ctx.lineTo(pillX + r, pillY + bh);
    ctx.quadraticCurveTo(pillX, pillY + bh, pillX, pillY + bh - r);
    ctx.lineTo(pillX, pillY + r);
    ctx.quadraticCurveTo(pillX, pillY, pillX + r, pillY);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Top line: percentage (bold)
    ctx.font = 'bold 13px -apple-system,sans-serif';
    ctx.fillText(pctLine, midX, pillY + padY + lineH / 2);
    // Thin divider
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(pillX + 4, pillY + padY + lineH, bw - 8, 1);
    // Bottom line: points (slightly lighter weight)
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '12px -apple-system,sans-serif';
    ctx.fillText(ptsLine, midX, pillY + padY + lineH + 1 + lineH / 2 + 1);
  }
}

export function renderOverlays(
  rc: RenderContext,
  overlays: OffsetOverlay[],
): void {
  const { ctx, viewport: vp, priceScale: ps, theme } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;

  for (const ov of overlays) {
    if (!ov.config.visible) continue;

    const color = ov.config.color;
    const alpha = ov.config.opacity;
    const bodyW = Math.max(1, sw * 0.5);

    // ── Scale-to-fit: rescale overlay prices to match the primary price range ──
    // This keeps large-offset overlays visually aligned with the current chart.
    let mapPrice = (p: number) => p; // identity by default
    let ovMin = Infinity, ovMax = -Infinity;
    if (ov.config.mode === 'overlay') {
      // Compute overlay min/max for visible projected candles
      for (const pc of ov.projectedCandles) {
        const screenI = pc.projectedSlotIndex - vp.firstSlotIndex;
        if (pc.projectedSlotIndex < 0 || screenI >= vp.visibleSlotCount + 1) continue;
        if (screenI < -1) continue;
        const c = pc.candle;
        if (c.low < ovMin) ovMin = c.low;
        if (c.high > ovMax) ovMax = c.high;
      }
      // If the overlay's range doesn't overlap with the primary range at all,
      // or the difference is significant (>20%), rescale to fit.
      if (isFinite(ovMin) && isFinite(ovMax) && ovMax > ovMin) {
        const primaryRange = ps.max - ps.min;
        const ovRange = ovMax - ovMin;
        const overlapLow = Math.max(ps.min, ovMin);
        const overlapHigh = Math.min(ps.max, ovMax);
        const noOverlap = overlapLow >= overlapHigh;
        const rangeDiffRatio = Math.abs(ovRange - primaryRange) / primaryRange;

        if (noOverlap || rangeDiffRatio > 0.2) {
          // Linear map: overlay range → primary range (with 10% padding)
          const pad = primaryRange * 0.1;
          const targetMin = ps.min + pad;
          const targetMax = ps.max - pad;
          mapPrice = (p: number) => targetMin + ((p - ovMin) / ovRange) * (targetMax - targetMin);
        }
      }
    }

    // Render normal overlay
    _renderOverlayCandles(ctx, ov, vp, ps, ph, sw, bodyW, color, alpha, mapPrice);

    // ── Swing HL for this overlay ─────────────────────────────────────────
    if (ov.overlaySwingPoints?.length) {
      _renderOverlaySwingHL(rc, ov.overlaySwingPoints, color, alpha, ov.config.showSwingPct ?? false, mapPrice);
    }

    // ── Mirror clone ──────────────────────────────────────────────────────
    if (ov.config.mirror && ov.config.mode === 'overlay' && isFinite(ovMin) && isFinite(ovMax) && ovMax > ovMin) {
      // Mirror inverts the overlay vertically, anchored near the current price.
      // currentPrice = midpoint of visible primary range (so mirrored data sits near current action)
      const currentMid = (ps.min + ps.max) / 2;
      const ovRange = ovMax - ovMin;
      const ovMid = (ovMin + ovMax) / 2;

      // Mirrored map: invert around ovMid, then translate so it centers on currentMid
      // mappedNormal → (p - ovMin) / ovRange mapped to target
      // For mirror, we invert: mirror(p) = ovMax + ovMin - p, then apply same scale-to-fit
      const primaryRange = ps.max - ps.min;
      const pad = primaryRange * 0.1;
      const targetMin = ps.min + pad;
      const targetMax = ps.max - pad;

      const mapPriceMirror = (p: number) => {
        const mirrored = ovMax + ovMin - p; // flip around midpoint
        return targetMin + ((mirrored - ovMin) / ovRange) * (targetMax - targetMin);
      };

      // Render mirrored with dashed style and reduced opacity
      const mirrorAlpha = alpha * 0.6;
      const mirrorColor = color;
      _renderOverlayCandles(ctx, ov, vp, ps, ph, sw, bodyW, mirrorColor, mirrorAlpha, mapPriceMirror, true);

      // Mirror swing points if present
      if (ov.overlaySwingPoints?.length) {
        _renderOverlaySwingHL(rc, ov.overlaySwingPoints, mirrorColor, mirrorAlpha, ov.config.showSwingPct ?? false, mapPriceMirror);
      }
    }
  }
}

/** Render overlay candle bodies/wicks or line dots. */
function _renderOverlayCandles(
  ctx: CanvasRenderingContext2D,
  ov: OffsetOverlay,
  vp: { firstSlotIndex: number; visibleSlotCount: number; mainPaneHeight: number },
  ps: { min: number; max: number },
  ph: number,
  sw: number,
  bodyW: number,
  color: string,
  alpha: number,
  mapPrice: (p: number) => number,
  dashed = false,
): void {
  for (const pc of ov.projectedCandles) {
    const screenI = pc.projectedSlotIndex - vp.firstSlotIndex;
    if (pc.projectedSlotIndex < 0 || screenI >= vp.visibleSlotCount + 500) continue;
    if (screenI < -1) continue;

    const c = pc.candle;
    const x = screenI * sw + sw / 2;
    const isBull = c.close >= c.open;

    if (ov.config.lineOnly) {
      const y = priceToY(mapPrice(c.close), ps, ph);
      ctx.strokeStyle = colorWithAlpha(color, alpha);
      ctx.lineWidth = 1;
      if (ov.config.dashed || dashed) ctx.setLineDash([4, 3]);
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const openY = priceToY(mapPrice(c.open), ps, ph);
      const closeY = priceToY(mapPrice(c.close), ps, ph);
      const highY = priceToY(mapPrice(c.high), ps, ph);
      const lowY = priceToY(mapPrice(c.low), ps, ph);

      // Wick
      ctx.strokeStyle = colorWithAlpha(color, alpha);
      ctx.lineWidth = 1;
      if (dashed) ctx.setLineDash([3, 2]);
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();

      // Body – hollow outline
      const bodyTop = Math.min(openY, closeY);
      const bodyH = Math.max(1, Math.abs(openY - closeY));
      ctx.strokeStyle = colorWithAlpha(color, alpha);
      ctx.lineWidth = dashed ? 1 : 1.5;
      if (dashed) ctx.setLineDash([3, 2]);
      else ctx.setLineDash([]);
      ctx.strokeRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
    }
  }
  ctx.setLineDash([]);
}

/** Render a swing-HL zigzag on an offset overlay using projected slot indices. */
function _renderOverlaySwingHL(
  rc: RenderContext,
  swingPoints: import('../types').SwingPoint[],
  color: string,
  opacity: number,
  showPct: boolean,
  mapPrice: (p: number) => number = (p) => p,
): void {
  if (swingPoints.length === 0) return;
  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const strokeColor = colorWithAlpha(color, Math.min(1, opacity + 0.2));

  function toX(slotIndex: number) { return (slotIndex - vp.firstSlotIndex) * sw + sw / 2; }

  // Zigzag line
  ctx.save();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let pathStarted = false;
  for (const p of swingPoints) {
    const screenI = p.slotIndex - vp.firstSlotIndex;
    if (screenI < -2 || screenI > vp.visibleSlotCount + 2) { pathStarted = false; continue; }
    const x = toX(p.slotIndex);
    const y = priceToY(mapPrice(p.price), ps, ph);
    if (!pathStarted) { ctx.moveTo(x, y); pathStarted = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Dots + H / L labels
  const dotR = 3;
  ctx.font = 'bold 10px -apple-system,sans-serif';
  ctx.fillStyle = strokeColor;
  for (const p of swingPoints) {
    const screenI = p.slotIndex - vp.firstSlotIndex;
    if (screenI < -2 || screenI > vp.visibleSlotCount + 2) continue;
    const x = toX(p.slotIndex);
    const y = priceToY(mapPrice(p.price), ps, ph);
    const isHigh = p.type === 'high';
    ctx.beginPath();
    ctx.arc(x, y, dotR, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = isHigh ? 'bottom' : 'top';
    ctx.fillText(isHigh ? 'H' : 'L', x, isHigh ? y - dotR - 2 : y + dotR + 2);
  }

  // ── % move pills between consecutive pivots ──────────────────────────────
  if (showPct) {
    _drawSwingPctPills(ctx, swingPoints, vp, ps, ph, sw, Infinity, mapPrice);
  }

  ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawings
// ─────────────────────────────────────────────────────────────────────────────

// ── Hit-testing ──────────────────────────────────────────────────────────────

const HIT_TOLERANCE = 8;

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
}

/**
 * Returns the ID of the topmost drawing under the given canvas point, or null.
 * Iterates in reverse draw order so the front-most drawing wins.
 */
export function hitTestDrawings(
  cx: number,
  cy: number,
  drawings: Drawing[],
  vp: Viewport,
  ps: PriceScale,
): string | null {
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;

  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i];
    if (!d.visible) continue;

    switch (d.tool) {
      case 'horizontal': {
        const y = priceToY(d.price, ps, ph);
        if (Math.abs(cy - y) <= HIT_TOLERANCE) return d.id;
        break;
      }
      case 'vertical': {
        const x = (d.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        if (Math.abs(cx - x) <= HIT_TOLERANCE) return d.id;
        break;
      }
      case 'trendline': {
        const x1 = (d.start.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const x2 = (d.end.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const y1 = priceToY(d.start.price, ps, ph);
        const y2 = priceToY(d.end.price, ps, ph);
        if (distToSegment(cx, cy, x1, y1, x2, y2) <= HIT_TOLERANCE) return d.id;
        break;
      }
      case 'rectangle': {
        const x1 = (d.topLeft.slotIndex - vp.firstSlotIndex) * sw;
        const x2 = (d.bottomRight.slotIndex - vp.firstSlotIndex) * sw;
        const y1 = priceToY(d.topLeft.price, ps, ph);
        const y2 = priceToY(d.bottomRight.price, ps, ph);
        const left = Math.min(x1, x2), right = Math.max(x1, x2);
        const top  = Math.min(y1, y2), bot   = Math.max(y1, y2);
        if (cx >= left - HIT_TOLERANCE && cx <= right + HIT_TOLERANCE &&
            cy >= top  - HIT_TOLERANCE && cy <= bot   + HIT_TOLERANCE) {
          if (Math.abs(cx - left) <= HIT_TOLERANCE || Math.abs(cx - right) <= HIT_TOLERANCE ||
              Math.abs(cy - top)  <= HIT_TOLERANCE || Math.abs(cy - bot)   <= HIT_TOLERANCE) {
            return d.id;
          }
        }
        break;
      }
      case 'measurement': {
        const x1 = (d.start.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const x2 = (d.end.slotIndex   - vp.firstSlotIndex) * sw + sw / 2;
        const y1 = priceToY(d.start.price, ps, ph);
        const y2 = priceToY(d.end.price,   ps, ph);
        const left = Math.min(x1, x2), right = Math.max(x1, x2);
        const top  = Math.min(y1, y2), bot   = Math.max(y1, y2);
        if (cx >= left - HIT_TOLERANCE && cx <= right + HIT_TOLERANCE &&
            cy >= top  - HIT_TOLERANCE && cy <= bot   + HIT_TOLERANCE) {
          return d.id;
        }
        break;
      }
      case 'fibonacci': {
        const fd = d as FibonacciDrawing;
        const levels = fd.levels ?? FIBONACCI_DEFAULT_LEVELS;
        const priceDiff = fd.end.price - fd.start.price;
        for (const level of levels) {
          const price = fd.start.price + priceDiff * level;
          const ly = priceToY(price, ps, ph);
          if (Math.abs(cy - ly) <= HIT_TOLERANCE) return d.id;
        }
        // Also hit-test the anchor trendline
        const x1 = (fd.start.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const x2 = (fd.end.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const y1 = priceToY(fd.start.price, ps, ph);
        const y2 = priceToY(fd.end.price, ps, ph);
        if (distToSegment(cx, cy, x1, y1, x2, y2) <= HIT_TOLERANCE) return d.id;
        break;
      }
      case 'long_position':
      case 'short_position': {
        const pd = d as import('../types').PositionDrawing;
        const entryY = priceToY(pd.entry.price, ps, ph);
        const tpY = priceToY(pd.tpPrice, ps, ph);
        const slY = priceToY(pd.slPrice, ps, ph);
        // Hit if cursor is near any of the 3 horizontal lines
        if (Math.abs(cy - entryY) <= HIT_TOLERANCE) return d.id;
        if (Math.abs(cy - tpY) <= HIT_TOLERANCE) return d.id;
        if (Math.abs(cy - slY) <= HIT_TOLERANCE) return d.id;
        break;
      }
    }
  }
  return null;
}

/** Returns which anchor of a fibonacci drawing the cursor is near: 'start', 'end', or null */
export function hitTestFibPart(
  cx: number,
  cy: number,
  drawing: Drawing,
  vp: Viewport,
  ps: PriceScale,
): 'start' | 'end' | null {
  if (drawing.tool !== 'fibonacci') return null;
  const fd = drawing as FibonacciDrawing;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const HIT = 10;
  const x1 = (fd.start.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
  const y1 = priceToY(fd.start.price, ps, ph);
  const x2 = (fd.end.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
  const y2 = priceToY(fd.end.price, ps, ph);
  if (Math.abs(cx - x1) <= HIT && Math.abs(cy - y1) <= HIT) return 'start';
  if (Math.abs(cx - x2) <= HIT && Math.abs(cy - y2) <= HIT) return 'end';
  return null;
}

/** Returns which part of a position drawing the cursor is near: 'tp', 'sl', 'entry', or null */
export function hitTestPositionPart(
  cy: number,
  drawing: Drawing,
  vp: Viewport,
  ps: PriceScale,
): 'tp' | 'sl' | 'entry' | null {
  if (drawing.tool !== 'long_position' && drawing.tool !== 'short_position') return null;
  const pd = drawing as import('../types').PositionDrawing;
  const ph = vp.mainPaneHeight;
  const HIT = 8;
  const entryY = priceToY(pd.entry.price, ps, ph);
  const tpY = priceToY(pd.tpPrice, ps, ph);
  const slY = priceToY(pd.slPrice, ps, ph);
  if (Math.abs(cy - tpY) <= HIT) return 'tp';
  if (Math.abs(cy - slY) <= HIT) return 'sl';
  if (Math.abs(cy - entryY) <= HIT) return 'entry';
  return null;
}

export function renderDrawings(
  rc: RenderContext,
  drawings: Drawing[],
  slots: CandleSlot[],
  hoveredId?: string,
): void {
  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const pw = vp.width - vp.priceAxisWidth;

  // Glow pass – redraw the hovered drawing with a wider translucent stroke first
  if (hoveredId) {
    const hd = drawings.find(d => d.id === hoveredId);
    if (hd?.visible) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = (hd.lineWidth ?? 1) + 6;
      ctx.setLineDash([]);
      switch (hd.tool) {
        case 'horizontal': {
          const y = priceToY(hd.price, ps, ph);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke();
          break;
        }
        case 'vertical': {
          const x = (hd.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke();
          break;
        }
        case 'trendline': {
          const x1 = (hd.start.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
          const x2 = (hd.end.slotIndex   - vp.firstSlotIndex) * sw + sw / 2;
          const y1 = priceToY(hd.start.price, ps, ph);
          const y2 = priceToY(hd.end.price,   ps, ph);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          break;
        }
        case 'rectangle':
        case 'measurement': {
          const [p1, p2] = hd.tool === 'rectangle'
            ? [hd.topLeft, hd.bottomRight]
            : [hd.start, hd.end];
          const x1 = (p1.slotIndex - vp.firstSlotIndex) * sw + (hd.tool === 'measurement' ? sw / 2 : 0);
          const x2 = (p2.slotIndex - vp.firstSlotIndex) * sw + (hd.tool === 'measurement' ? sw / 2 : 0);
          const y1 = priceToY(p1.price, ps, ph);
          const y2 = priceToY(p2.price, ps, ph);
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          break;
        }
        case 'fibonacci': {
          const fd = hd as FibonacciDrawing;
          const x1 = (fd.start.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
          const x2 = (fd.end.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
          const y1 = priceToY(fd.start.price, ps, ph);
          const y2 = priceToY(fd.end.price, ps, ph);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          break;
        }
        case 'long_position':
        case 'short_position': {
          const pd = hd as import('../types').PositionDrawing;
          const entryY = priceToY(pd.entry.price, ps, ph);
          ctx.beginPath(); ctx.moveTo(0, entryY); ctx.lineTo(pw, entryY); ctx.stroke();
          break;
        }
      }
      ctx.restore();
    }
  }

  for (const d of drawings) {
    if (!d.visible) continue;
    ctx.strokeStyle = d.color;
    ctx.lineWidth = d.lineWidth;
    ctx.setLineDash([]);

    switch (d.tool) {
      case 'horizontal': {
        const y = priceToY(d.price, ps, ph);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(pw, y);
        ctx.stroke();
        break;
      }
      case 'vertical': {
        const si = d.slotIndex;
        const x = (si - vp.firstSlotIndex) * sw + sw / 2;
        if (x < 0 || x > pw) break;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ph);
        ctx.stroke();
        break;
      }
      case 'trendline': {
        const x1 = (d.start.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const x2 = (d.end.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const y1 = priceToY(d.start.price, ps, ph);
        const y2 = priceToY(d.end.price, ps, ph);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        break;
      }
      case 'rectangle': {
        const x1 = (d.topLeft.slotIndex - vp.firstSlotIndex) * sw;
        const x2 = (d.bottomRight.slotIndex - vp.firstSlotIndex) * sw;
        const y1 = priceToY(d.topLeft.price, ps, ph);
        const y2 = priceToY(d.bottomRight.price, ps, ph);
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
        ctx.fillStyle = colorWithAlpha(d.color, 0.07);
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
        break;
      }
      case 'measurement': {
        const x1 = (d.start.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const x2 = (d.end.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const y1 = priceToY(d.start.price, ps, ph);
        const y2 = priceToY(d.end.price, ps, ph);
        const left  = Math.min(x1, x2);
        const top   = Math.min(y1, y2);
        const rectW = Math.abs(x2 - x1);
        const rectH = Math.abs(y2 - y1);

        // Selection rectangle with semi-transparent fill
        const up = (d.result?.percentMove ?? 0) >= 0;
        const fillColor = up ? 'rgba(38,166,154,0.13)' : 'rgba(239,83,80,0.13)';
        ctx.fillStyle = fillColor;
        ctx.fillRect(left, top, rectW, rectH);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = up ? '#26a69a' : '#ef5350';
        ctx.lineWidth = 1;
        ctx.strokeRect(left, top, rectW, rectH);
        ctx.setLineDash([]);

        if (d.result) {
          const r = d.result;
          const pct = r.percentMove;
          const sign = pct >= 0 ? '+' : '';
          const absSign = r.absoluteMove >= 0 ? '+' : '';
          const badgeColor = up ? '#26a69a' : '#ef5350';

          // Info badge — two rows inside the rectangle at the top-left
          const pad   = 6;
          const lh    = 15;
          const badgeH = lh * 2 + pad * 2;
          const row1  = `${sign}${pct.toFixed(2)}%  ${absSign}${r.absoluteMove.toFixed(2)}`;
          const row2  = `${r.tradingBars} bars  ·  ${r.calendarDays} days`;

          ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
          const w1 = ctx.measureText(row1).width;
          ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
          const w2 = ctx.measureText(row2).width;
          const badgeW = Math.max(w1, w2) + pad * 2 + 2;

          // Place badge: prefer top-left of rect, shift right if clipped
          let bx = left + 4;
          let by = top + 4;
          if (bx + badgeW > left + rectW - 4) bx = left + rectW - badgeW - 4;
          if (by + badgeH > top + rectH - 4)  by = top + rectH - badgeH - 4;
          bx = Math.max(bx, left + 2);
          by = Math.max(by, top + 2);

          // Badge background
          ctx.fillStyle = up ? 'rgba(38,166,154,0.88)' : 'rgba(239,83,80,0.88)';
          ctx.beginPath();
          (ctx as CanvasRenderingContext2D).roundRect?.(bx, by, badgeW, badgeH, 3);
          ctx.fill();

          // Row 1 – pct & absolute (bold, white)
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(row1, bx + pad, by + pad + lh - 3);

          // Row 2 – bars & days (slightly dimmed)
          ctx.globalAlpha = 0.85;
          ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.fillText(row2, bx + pad, by + pad + lh * 2 - 2);
          ctx.globalAlpha = 1;

          // Also draw a compact label on the border line when rect is too small
          if (rectW < 80 || rectH < badgeH + 8) {
            ctx.fillStyle = badgeColor;
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(
              `${sign}${pct.toFixed(2)}%  ${r.tradingBars}b  ${r.calendarDays}d`,
              left,
              top - 5,
            );
          }
        }
        break;
      }
      case 'fibonacci': {
        const fd = d as FibonacciDrawing;
        const x1 = (fd.start.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const x2 = (fd.end.slotIndex - vp.firstSlotIndex) * sw + sw / 2;
        const y1 = priceToY(fd.start.price, ps, ph);
        const y2 = priceToY(fd.end.price, ps, ph);
        const levels = fd.levels ?? FIBONACCI_DEFAULT_LEVELS;
        const priceDiff = fd.end.price - fd.start.price;
        const rightEdge = fd.extendRight ? pw : Math.max(x1, x2) + 60;

        // Level colors matching TradingView's palette
        const levelColors: Record<number, string> = {
          0: '#787b86',
          0.236: '#f7525f',
          0.382: '#ff9800',
          0.5: '#4caf50',
          0.618: '#089981',
          0.786: '#2962ff',
          1: '#787b86',
        };

        for (const level of levels) {
          const price = fd.start.price + priceDiff * level;
          const ly = priceToY(price, ps, ph);
          const color = levelColors[level] ?? fd.color;

          // Draw the level line
          ctx.strokeStyle = color;
          ctx.lineWidth = level === 0 || level === 1 ? 1.5 : 1;
          ctx.setLineDash(level === 0.5 ? [5, 3] : []);
          ctx.beginPath();
          ctx.moveTo(Math.min(x1, x2), ly);
          ctx.lineTo(rightEdge, ly);
          ctx.stroke();

          // Fill zone between levels (subtle)
          const levelIdx = levels.indexOf(level);
          if (levelIdx < levels.length - 1) {
            const nextPrice = fd.start.price + priceDiff * levels[levelIdx + 1];
            const nextY = priceToY(nextPrice, ps, ph);
            ctx.fillStyle = colorWithAlpha(color, 0.04);
            ctx.fillRect(Math.min(x1, x2), Math.min(ly, nextY), rightEdge - Math.min(x1, x2), Math.abs(nextY - ly));
          }

          // Label on the left side (like TradingView)
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(
            `${(level * 100).toFixed(1)}%  (${price.toFixed(2)})`,
            Math.min(x1, x2) - 6,
            ly + 3,
          );
        }

        // Draw the anchor trendline
        ctx.strokeStyle = fd.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      case 'long_position':
      case 'short_position': {
        const pd = d as import('../types').PositionDrawing;
        const isLong = pd.tool === 'long_position';
        const entryY = priceToY(pd.entry.price, ps, ph);
        const tpY = priceToY(pd.tpPrice, ps, ph);
        const slY = priceToY(pd.slPrice, ps, ph);
        const leftX = (pd.entry.slotIndex - vp.firstSlotIndex) * sw;
        const rightX = (pd.end.slotIndex - vp.firstSlotIndex) * sw + sw;
        const boxLeft = Math.min(leftX, rightX);
        const boxRight = Math.max(leftX, rightX);
        const boxWidth = Math.max(boxRight - boxLeft, sw * 4);

        const profitColor = '#26a69a';  // green
        const lossColor = '#ef5350';    // red
        const entryColor = '#2962ff';   // blue

        // TP zone (profit)
        const tpTop = Math.min(entryY, tpY);
        const tpBot = Math.max(entryY, tpY);
        ctx.fillStyle = colorWithAlpha(profitColor, 0.12);
        ctx.fillRect(boxLeft, tpTop, boxWidth, tpBot - tpTop);
        ctx.strokeStyle = profitColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(boxLeft, tpY);
        ctx.lineTo(boxLeft + boxWidth, tpY);
        ctx.stroke();

        // TP drag handle (small filled square)
        ctx.fillStyle = profitColor;
        ctx.fillRect(boxLeft + boxWidth / 2 - 5, tpY - 5, 10, 10);
        // Arrow icon on handle
        ctx.fillStyle = '#fff';
        ctx.font = '8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('↕', boxLeft + boxWidth / 2, tpY);

        // SL zone (loss)
        const slTop = Math.min(entryY, slY);
        const slBot = Math.max(entryY, slY);
        ctx.fillStyle = colorWithAlpha(lossColor, 0.12);
        ctx.fillRect(boxLeft, slTop, boxWidth, slBot - slTop);
        ctx.strokeStyle = lossColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(boxLeft, slY);
        ctx.lineTo(boxLeft + boxWidth, slY);
        ctx.stroke();

        // SL drag handle (small filled square)
        ctx.fillStyle = lossColor;
        ctx.fillRect(boxLeft + boxWidth / 2 - 5, slY - 5, 10, 10);
        ctx.fillStyle = '#fff';
        ctx.font = '8px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('↕', boxLeft + boxWidth / 2, slY);

        // Entry line
        ctx.strokeStyle = entryColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(boxLeft, entryY);
        ctx.lineTo(boxLeft + boxWidth, entryY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Labels
        ctx.font = 'bold 10px -apple-system, sans-serif';
        ctx.textAlign = 'left';
        const labelX = boxLeft + boxWidth + 6;

        // TP label
        const tpPct = ((pd.tpPrice - pd.entry.price) / pd.entry.price * 100) * (isLong ? 1 : -1);
        ctx.fillStyle = profitColor;
        ctx.fillText(`TP ${pd.tpPrice.toFixed(2)} (${tpPct >= 0 ? '+' : ''}${tpPct.toFixed(2)}%)`, labelX, tpY + 4);

        // SL label
        const slPct = ((pd.slPrice - pd.entry.price) / pd.entry.price * 100) * (isLong ? 1 : -1);
        ctx.fillStyle = lossColor;
        ctx.fillText(`SL ${pd.slPrice.toFixed(2)} (${slPct >= 0 ? '+' : ''}${slPct.toFixed(2)}%)`, labelX, slY + 4);

        // Entry label
        ctx.fillStyle = entryColor;
        ctx.fillText(`${isLong ? 'LONG' : 'SHORT'} @ ${pd.entry.price.toFixed(2)}`, labelX, entryY + 4);

        // R:R badge
        if (pd.riskReward > 0) {
          const badgeText = `R:R  1:${pd.riskReward.toFixed(2)}`;
          const badgeX = boxLeft + 6;
          const badgeY = isLong ? tpY + 8 : tpY - 8;
          ctx.font = 'bold 11px -apple-system, sans-serif';
          ctx.fillStyle = profitColor;
          ctx.textAlign = 'left';
          ctx.textBaseline = isLong ? 'top' : 'bottom';
          ctx.fillText(badgeText, badgeX, badgeY);
          ctx.textBaseline = 'alphabetic';
        }

        break;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Crosshair
// ─────────────────────────────────────────────────────────────────────────────

export function renderCrosshair(rc: RenderContext, ch: CrosshairState): void {
  if (!ch.visible) return;
  const { ctx, viewport: vp, theme } = rc;
  const pw = vp.width - vp.priceAxisWidth;
  const ph = vp.mainPaneHeight + vp.subPaneHeight;

  ctx.strokeStyle = theme.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  // Vertical
  ctx.beginPath();
  ctx.moveTo(ch.x, 0);
  ctx.lineTo(ch.x, ph);
  ctx.stroke();

  // Horizontal (only in main pane)
  ctx.beginPath();
  ctx.moveTo(0, ch.y);
  ctx.lineTo(pw, ch.y);
  ctx.stroke();

  ctx.setLineDash([]);

  // ── Price label on Y-axis (TradingView-style) ─────────────────────────────
  if (ch.y >= 0 && ch.y <= vp.mainPaneHeight) {
    const price = ch.price;
    const label = formatPrice(price);
    const labelFont = '11px -apple-system, sans-serif';
    ctx.font = labelFont;
    const textW = ctx.measureText(label).width;
    const padX = 6;
    const padY = 4;
    const tagW = textW + padX * 2;
    const tagH = 18;
    const tagX = pw;
    const tagY = ch.y - tagH / 2;

    // Background pill
    ctx.fillStyle = theme.crosshair;
    ctx.fillRect(tagX, tagY, tagW, tagH);

    // Arrow/notch pointing left
    ctx.beginPath();
    ctx.moveTo(tagX, ch.y - 5);
    ctx.lineTo(tagX - 4, ch.y);
    ctx.lineTo(tagX, ch.y + 5);
    ctx.closePath();
    ctx.fill();

    // Price text
    ctx.fillStyle = theme.background;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, tagX + padX, ch.y);
    ctx.textBaseline = 'alphabetic';
  }

  // ── Time label on X-axis (TradingView-style) ──────────────────────────────
  {
    const ts = ch.timestamp;
    if (ts) {
      const d = new Date(ts);
      const tz = rc.timezone;
      const isIntraday = !['1d', '1w', '1M'].includes(rc.timeframe);
      let timeLabel: string;
      if (isIntraday) {
        timeLabel = d.toLocaleString('en-US', {
          timeZone: tz,
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      } else {
        timeLabel = d.toLocaleDateString('en-US', {
          timeZone: tz,
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
      }

      const y0 = vp.mainPaneHeight + vp.subPaneHeight;
      const labelFont = '10px -apple-system, sans-serif';
      ctx.font = labelFont;
      const textW = ctx.measureText(timeLabel).width;
      const padX = 6;
      const tagW = textW + padX * 2;
      const tagH = vp.timeAxisHeight - 2;
      const tagX = ch.x - tagW / 2;
      const tagY = y0 + 1;

      // Background pill
      ctx.fillStyle = theme.crosshair;
      ctx.fillRect(tagX, tagY, tagW, tagH);

      // Time text
      ctx.fillStyle = theme.background;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(timeLabel, ch.x, y0 + tagH / 2 + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bar replay cursor
// ─────────────────────────────────────────────────────────────────────────────

export function renderReplayCursor(rc: RenderContext): void {
  const { replayIndex } = rc;
  if (replayIndex === undefined) return;
  const { ctx, viewport: vp, theme } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight + vp.subPaneHeight;
  const pw = vp.width - vp.priceAxisWidth;
  const screenI = replayIndex - vp.firstSlotIndex;
  const xCursor = screenI * sw + sw; // right edge of the current (last revealed) bar

  // Shade the "future" area to the right of the cursor
  if (xCursor >= 0 && xCursor < pw) {
    ctx.save();
    ctx.fillStyle = theme.background;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(xCursor, 0, pw - xCursor, ph);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Blue vertical line at the right edge of the last revealed bar
  if (screenI >= -1 && screenI <= vp.visibleSlotCount) {
    ctx.save();
    ctx.strokeStyle = '#2962ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(xCursor, 0);
    ctx.lineTo(xCursor, ph);
    ctx.stroke();
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function colorWithAlpha(hex: string, alpha: number): string {
  // Accepts #rrggbb
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function formatPrice(p: number): string {
  if (p >= 10000) return p.toFixed(0);
  if (p >= 1000) return p.toFixed(1);
  if (p >= 100) return p.toFixed(2);
  return p.toFixed(3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Backtest signal arrows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders buy (▲ green) and sell (▼ red) arrows below/above candles.
 * Arrow size scales with slot width so they stay readable at any zoom.
 */
export function renderBacktestSignals(
  rc: RenderContext,
  signals: BacktestSignal[],
  slots: CandleSlot[],
  trades?: import('../types').BacktestTrade[],
): void {
  if (!signals.length) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const arrowH = Math.max(6, Math.min(14, sw * 0.8));
  const arrowW = arrowH * 0.75;

  // Build a fast slotIndex → candle map for the visible window
  const slotMap = new Map<number, CandleSlot>();
  for (let i = vp.firstSlotIndex; i < vp.firstSlotIndex + vp.visibleSlotCount && i < slots.length; i++) {
    slotMap.set(slots[i].slotIndex, slots[i]);
  }

  const visEnd = vp.firstSlotIndex + vp.visibleSlotCount;

  // ── 1. P&L trade bands (TradingView style) ─────────────────────────────
  if (trades?.length) {
    ctx.save();
    for (const trade of trades) {
      if (rc.replayIndex !== undefined && trade.entrySlotIndex > rc.replayIndex) continue;
      if (trade.exitSlotIndex < vp.firstSlotIndex || trade.entrySlotIndex >= visEnd) continue;

      const isWin = trade.pnlPct >= 0;
      const bandColor = isWin ? 'rgba(38,166,154,0.12)' : 'rgba(239,83,80,0.12)';
      const lineColor = isWin ? 'rgba(38,166,154,0.5)'  : 'rgba(239,83,80,0.5)';
      const textColor = isWin ? '#26a69a' : '#ef5350';

      const entryScreen = Math.max(0, trade.entrySlotIndex - vp.firstSlotIndex);
      const exitScreen  = Math.min(visEnd - 1, trade.exitSlotIndex) - vp.firstSlotIndex;

      const x1 = entryScreen * sw;
      const x2 = (exitScreen + 1) * sw;

      const entryY = priceToY(trade.entryPrice, ps, ph);
      const exitY  = priceToY(trade.exitPrice,  ps, ph);
      const bandTop    = Math.min(entryY, exitY);
      const bandBottom = Math.max(entryY, exitY);
      const bandH      = Math.max(2, bandBottom - bandTop);

      // Shaded band between entry and exit price levels
      ctx.fillStyle = bandColor;
      ctx.fillRect(x1, bandTop, x2 - x1, bandH);

      // Entry price dashed line
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x1, entryY);
      ctx.lineTo(x2, entryY);
      ctx.stroke();

      // Exit price dashed line
      ctx.beginPath();
      ctx.moveTo(x1, exitY);
      ctx.lineTo(x2, exitY);
      ctx.stroke();
      ctx.setLineDash([]);

      // P&L label pill centred in the band
      const midX = (x1 + x2) / 2;
      const midY = (entryY + exitY) / 2;
      const pnlSign = trade.pnlPct >= 0 ? '+' : '';
      const pnlLabel = `${pnlSign}${trade.pnlPct.toFixed(2)}%`;

      const fontSize = Math.max(9, Math.min(12, sw * 0.7));
      ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const tw = ctx.measureText(pnlLabel).width;
      const px = 4, py = 2;
      const pw = tw + px * 2;
      const pillH = fontSize + py * 2;
      const rx = midX - pw / 2;
      const ry = midY - pillH / 2;
      const rr = pillH / 2;

      ctx.fillStyle = isWin ? 'rgba(38,166,154,0.25)' : 'rgba(239,83,80,0.25)';
      ctx.beginPath();
      ctx.moveTo(rx + rr, ry);
      ctx.arcTo(rx + pw, ry,         rx + pw, ry + pillH, rr);
      ctx.arcTo(rx + pw, ry + pillH, rx,      ry + pillH, rr);
      ctx.arcTo(rx,      ry + pillH, rx,      ry,         rr);
      ctx.arcTo(rx,      ry,         rx + pw, ry,         rr);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = textColor;
      ctx.fillText(pnlLabel, midX, midY);
    }
    ctx.restore();
  }

  // ── 2. Entry/exit arrows ────────────────────────────────────────────────
  ctx.save();
  for (const sig of signals) {
    const slot = slotMap.get(sig.slotIndex);
    if (!slot || !slot.candle) continue;

    const screenI = sig.slotIndex - vp.firstSlotIndex;
    if (screenI < 0 || screenI >= vp.visibleSlotCount) continue;

    const cx = screenI * sw + sw / 2;
    const isBuy = sig.type === 'buy';
    const candle = slot.candle;
    const color = isBuy ? '#26a69a' : '#ef5350';

    // Position: buy arrow below the low, sell arrow above the high
    const refPrice = isBuy ? candle.low : candle.high;
    const base = priceToY(refPrice, ps, ph);

    // Arrow tip points toward the candle; base is away from it
    const tipGap  = 3;                             // px gap between candle and tip
    const tipY    = isBuy ? base + tipGap : base - tipGap;
    const arrowTip = isBuy ? tipY + arrowH : tipY - arrowH; // outermost point

    // ── Draw filled triangle ──────────────────────────────────────────────
    ctx.beginPath();
    if (isBuy) {
      ctx.moveTo(cx,               tipY);           // tip (pointing up toward candle)
      ctx.lineTo(cx + arrowW / 2,  arrowTip);       // bottom-right
      ctx.lineTo(cx - arrowW / 2,  arrowTip);       // bottom-left
    } else {
      ctx.moveTo(cx,               tipY);           // tip (pointing down toward candle)
      ctx.lineTo(cx + arrowW / 2,  arrowTip);       // top-right
      ctx.lineTo(cx - arrowW / 2,  arrowTip);       // top-left
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // ── "B" / "S" label inside the arrow ─────────────────────────────────
    const labelFontSize = Math.max(7, Math.min(10, arrowH * 0.65));
    ctx.font = `bold ${labelFontSize}px -apple-system, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Vertically centre in the triangle body (midpoint between tip and base)
    const arrowMidY = (tipY + arrowTip) / 2;
    ctx.fillText(isBuy ? 'B' : 'S', cx, arrowMidY);

    // ── "BUY" / "SELL" pill label below (buy) or above (sell) the arrow ──
    const pillText  = isBuy ? 'BUY' : 'SELL';
    const pillFont  = Math.max(8, Math.min(10, sw * 0.55));
    ctx.font        = `bold ${pillFont}px -apple-system, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    const textW     = ctx.measureText(pillText).width;
    const pillPadX  = 4, pillPadY = 2;
    const pillW     = textW + pillPadX * 2;
    const pillH     = pillFont + pillPadY * 2;
    const pillX     = cx - pillW / 2;
    const pillY     = isBuy
      ? arrowTip + 3
      : arrowTip - 3 - pillH;

    ctx.fillStyle = color;
    const r = pillH / 2;
    ctx.beginPath();
    ctx.moveTo(pillX + r, pillY);
    ctx.arcTo(pillX + pillW, pillY,          pillX + pillW, pillY + pillH, r);
    ctx.arcTo(pillX + pillW, pillY + pillH,  pillX,         pillY + pillH, r);
    ctx.arcTo(pillX,         pillY + pillH,  pillX,         pillY,         r);
    ctx.arcTo(pillX,         pillY,          pillX + pillW, pillY,         r);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pillText, cx, pillY + pillH / 2);
  }
  ctx.restore();

  // ── 3. Stop-loss hit labels ─────────────────────────────────────────────
  // For every trade closed by stop_loss, draw a horizontal tick at the exit
  // price on the exit bar + a "SL" pill, so the user can see exactly where
  // price hit the stop.
  if (trades?.length) {
    ctx.save();
    const slColor = '#ef5350';
    const tickHalfBars = 1.5; // width of the tick line in bar-widths each side

    for (const trade of trades) {
      if (trade.exitReason !== 'stop_loss') continue;
      if (rc.replayIndex !== undefined && trade.exitSlotIndex > rc.replayIndex) continue;

      const screenI = trade.exitSlotIndex - vp.firstSlotIndex;
      if (screenI < 0 || screenI >= vp.visibleSlotCount) continue;

      const cx   = screenI * sw + sw / 2;
      const slY  = priceToY(trade.exitPrice, ps, ph);
      const isLong = trade.direction === 'long';

      // Short horizontal tick at the SL level
      ctx.strokeStyle = slColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(cx - sw * tickHalfBars, slY);
      ctx.lineTo(cx + sw * tickHalfBars, slY);
      ctx.stroke();

      // Small vertical notch pointing into the candle
      ctx.beginPath();
      ctx.moveTo(cx, slY);
      ctx.lineTo(cx, isLong ? slY + 5 : slY - 5);
      ctx.stroke();

      // "SL" pill
      const pillFont = Math.max(8, Math.min(10, sw * 0.55));
      ctx.font = `bold ${pillFont}px -apple-system, sans-serif`;
      const pillText = 'SL';
      const tw = ctx.measureText(pillText).width;
      const pillPadX = 4, pillPadY = 2;
      const pillW = tw + pillPadX * 2;
      const pillH = pillFont + pillPadY * 2;
      // Place pill to the right of the tick, offset vertically so it doesn't
      // overlap the BUY/SELL arrow – long SL is below the level, short above.
      const pillX = cx + sw * tickHalfBars + 3;
      const pillY = isLong ? slY : slY - pillH;

      const r = pillH / 2;
      ctx.fillStyle = slColor;
      ctx.beginPath();
      ctx.moveTo(pillX + r, pillY);
      ctx.arcTo(pillX + pillW, pillY,         pillX + pillW, pillY + pillH, r);
      ctx.arcTo(pillX + pillW, pillY + pillH, pillX,         pillY + pillH, r);
      ctx.arcTo(pillX,         pillY + pillH, pillX,         pillY,         r);
      ctx.arcTo(pillX,         pillY,         pillX + pillW, pillY,         r);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pillText, pillX + pillW / 2, pillY + pillH / 2);
    }
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade Journal renderer
// ─────────────────────────────────────────────────────────────────────────────

export function renderTradeLog(
  rc: RenderContext,
  roundTrips: TradeLogRoundTrip[],
  slots: CandleSlot[],
): void {
  if (!roundTrips.length) return;

  const { ctx, viewport: vp, priceScale: ps } = rc;
  const sw = slotWidth(vp);
  const ph = vp.mainPaneHeight;
  const visEnd = vp.firstSlotIndex + vp.visibleSlotCount;

  ctx.save();

  for (const trade of roundTrips) {
    if (trade.exitSlotIndex < vp.firstSlotIndex || trade.entrySlotIndex >= visEnd) continue;

    const isWin = trade.pnlPct >= 0;
    const isLong = trade.direction === 'long';
    const color = isWin ? '#26a69a' : '#ef5350';
    const bgColor = isWin ? 'rgba(38,166,154,0.06)' : 'rgba(239,83,80,0.06)';

    const entryScreen = trade.entrySlotIndex - vp.firstSlotIndex;
    const exitScreen = trade.exitSlotIndex - vp.firstSlotIndex;

    const x1 = entryScreen * sw + sw / 2;
    const x2 = exitScreen * sw + sw / 2;
    const entryY = priceToY(trade.entryPrice, ps, ph);
    const exitY = priceToY(trade.exitPrice, ps, ph);

    const sameSlot = Math.abs(trade.entrySlotIndex - trade.exitSlotIndex) < 2;

    // ── Shaded band between entry and exit price ──
    const bandTop = Math.min(entryY, exitY);
    const bandH = Math.max(2, Math.abs(entryY - exitY));
    if (!sameSlot) {
      const bx1 = Math.max(0, entryScreen * sw);
      const bx2 = Math.min(vp.visibleSlotCount * sw, (exitScreen + 1) * sw);
      ctx.fillStyle = bgColor;
      ctx.fillRect(bx1, bandTop, bx2 - bx1, bandH);
    }

    // ── Connecting line from entry to exit ──
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.8;
    ctx.setLineDash([]);
    ctx.beginPath();
    if (sameSlot) {
      // Vertical line at the candle showing entry→exit range
      ctx.moveTo(x2, entryY);
      ctx.lineTo(x2, exitY);
    } else {
      ctx.moveTo(x1, entryY);
      ctx.lineTo(x2, exitY);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // ── Entry marker: filled circle ──
    const dotR = Math.max(3, Math.min(5, sw * 0.3));
    const entryX = sameSlot ? x2 : x1;
    ctx.beginPath();
    ctx.arc(entryX, entryY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // ── Exit marker: filled circle ──
    ctx.beginPath();
    ctx.arc(x2, exitY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // ── Direction label at entry ──
    const labelFontSize = Math.max(8, Math.min(10, sw * 0.5));
    ctx.font = `bold ${labelFontSize}px -apple-system, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = sameSlot ? 'right' : 'center';
    ctx.textBaseline = isLong ? 'top' : 'bottom';
    const labelOffset = dotR + 3;
    const lx = sameSlot ? entryX - dotR - 2 : entryX;
    ctx.fillText(
      isLong ? 'L' : 'S',
      lx,
      isLong ? entryY + labelOffset : entryY - labelOffset,
    );

    // ── P&L label ──
    const midX = sameSlot ? x2 + sw * 0.6 : (x1 + x2) / 2;
    const midY = (entryY + exitY) / 2;
    const pnlText = `${isWin ? '+' : ''}${trade.pnlPct.toFixed(2)}%`;
    const pnlUsdText = `$${trade.pnlUsd >= 0 ? '+' : ''}${trade.pnlUsd.toFixed(0)}`;

    const fontSize = Math.max(9, Math.min(11, sw * 0.55));
    ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
    ctx.textAlign = sameSlot ? 'left' : 'center';
    ctx.textBaseline = 'middle';

    // Pill background
    const fullLabel = `${pnlText} ${pnlUsdText}`;
    const tw = ctx.measureText(fullLabel).width;
    const px = 5, py = 2;
    const pw = tw + px * 2;
    const pillH = fontSize + py * 2;
    const rx = sameSlot ? midX : midX - pw / 2;
    const ry = midY - pillH / 2;
    const rr = pillH / 2;

    ctx.fillStyle = isWin ? 'rgba(38,166,154,0.2)' : 'rgba(239,83,80,0.2)';
    ctx.beginPath();
    ctx.moveTo(rx + rr, ry);
    ctx.arcTo(rx + pw, ry, rx + pw, ry + pillH, rr);
    ctx.arcTo(rx + pw, ry + pillH, rx, ry + pillH, rr);
    ctx.arcTo(rx, ry + pillH, rx, ry, rr);
    ctx.arcTo(rx, ry, rx + pw, ry, rr);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = color;
    const textX = sameSlot ? rx + pw / 2 : midX;
    ctx.textAlign = 'center';
    ctx.fillText(fullLabel, textX, midY);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Ephemeris Markers – vertical lines at planetary event timestamps
// ─────────────────────────────────────────────────────────────────────────────

export function renderEphemerisMarkers(
  rc: RenderContext,
  markers: EphemerisMarker[],
): void {
  if (markers.length === 0) return;
  const { ctx, viewport: vp } = rc;
  const height = vp.height;
  const sw = slotWidth(vp);

  ctx.save();

  for (const marker of markers) {
    const x = slotToX(marker.slotIndex, vp) + sw / 2;
    // Skip if not visible
    if (x < 0 || x > vp.width - vp.priceAxisWidth) continue;

    // Vertical line
    ctx.strokeStyle = marker.color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Label at top
    const fontSize = 9;
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.fillStyle = marker.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // Background for readability
    const labelText = marker.label;
    const tw = ctx.measureText(labelText).width + 6;
    const lx = x - tw / 2;
    const ly = 4;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = rc.theme.background;
    ctx.fillRect(lx, ly, tw, fontSize + 4);
    ctx.globalAlpha = 1;
    ctx.fillStyle = marker.color;
    ctx.fillText(labelText, x, ly + 2);
  }

  ctx.restore();
}

// ── Render transit zone groups (shaded date-range backgrounds) ────────────────

export function renderTransitZones(
  rc: RenderContext,
  groups: TransitZoneGroup[],
): void {
  if (groups.length === 0) return;
  const { ctx, viewport: vp } = rc;
  const sw = slotWidth(vp);
  const height = vp.mainPaneHeight;
  const chartWidth = vp.width - vp.priceAxisWidth;

  ctx.save();

  for (const group of groups) {
    if (!group.visible) continue;

    for (const zone of group.zones) {
      const x1 = slotToX(zone.entrySlotIndex, vp);
      const x2 = slotToX(zone.exitSlotIndex, vp) + sw;

      // Skip if entirely off-screen
      if (x2 < 0 || x1 > chartWidth) continue;

      const clampX1 = Math.max(0, x1);
      const clampX2 = Math.min(chartWidth, x2);
      const w = clampX2 - clampX1;

      // Shaded background
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = group.color;
      ctx.fillRect(clampX1, 0, w, height);

      // Left and right boundary lines
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = group.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);

      if (x1 >= 0 && x1 <= chartWidth) {
        ctx.beginPath();
        ctx.moveTo(x1, 0);
        ctx.lineTo(x1, height);
        ctx.stroke();
      }
      if (x2 >= 0 && x2 <= chartWidth) {
        ctx.beginPath();
        ctx.moveTo(x2, 0);
        ctx.lineTo(x2, height);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Draw label for the first visible zone in this group
    const firstVisibleZone = group.zones.find(z => {
      const x = slotToX(z.entrySlotIndex, vp);
      return x >= 0 && x <= chartWidth;
    });
    if (firstVisibleZone) {
      const lx = Math.max(4, slotToX(firstVisibleZone.entrySlotIndex, vp) + 4);
      const ly = height - 18;
      const dirArrow = group.direction === 'UP' ? '▲' : group.direction === 'DOWN' ? '▼' : '●';
      const labelText = `${dirArrow} ${group.probability} ${group.label}`;

      ctx.globalAlpha = 0.85;
      ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = ctx.measureText(labelText).width + 8;
      ctx.fillStyle = rc.theme.background;
      ctx.fillRect(lx - 2, ly - 1, tw, 12);
      ctx.globalAlpha = 1;
      ctx.fillStyle = group.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(labelText, lx, ly);
    }
  }

  ctx.restore();
}


