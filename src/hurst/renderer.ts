/**
 * Hurst Cycles – canvas renderer (isolated).
 *
 * Draws, per enabled cycle: CMA line, envelope bands, FLD line, past
 * trough markers, and forward-projection window for the next trough.
 *
 * All drawing is done inside the main pane. The renderer does not touch
 * any store; it receives its data via arguments.
 */
import type { RenderContext } from '../renderer/canvasRenderer';
import type { CandleSlot, Viewport, PriceScale } from '../types';
import type { HurstConfig, HurstOutput } from './types';

// Local copies of viewport/price helpers so this module is self-contained.
function slotWidth(vp: Viewport): number {
  return (vp.width - vp.priceAxisWidth) / vp.visibleSlotCount;
}
function slotXCenter(slotIndex: number, vp: Viewport): number {
  const sw = slotWidth(vp);
  return (slotIndex - vp.firstSlotIndex) * sw + sw / 2;
}
function priceToY(price: number, ps: PriceScale, paneHeight: number): number {
  if (ps.max === ps.min) return paneHeight / 2;
  return paneHeight - ((price - ps.min) / (ps.max - ps.min)) * paneHeight;
}

// Convert a hex color like "#43a047" to "rgba(67, 160, 71, a)".
function withAlpha(hex: string, a: number): string {
  if (!hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) return hex;
  const full = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Draw a per-slot value array as a polyline in price space. */
function drawSeries(
  rc: RenderContext,
  values: (number | null)[],
  slots: CandleSlot[],
  color: string,
  lineWidth: number,
  dashed: boolean,
): void {
  const { ctx, viewport: vp, priceScale: ps } = rc;
  const ph = vp.mainPaneHeight;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  if (dashed) ctx.setLineDash([5, 4]);

  ctx.beginPath();
  let started = false;
  for (let i = 0; i < vp.visibleSlotCount; i++) {
    const si = vp.firstSlotIndex + i;
    if (si < 0 || si >= values.length) { started = false; continue; }
    if (rc.replayIndex !== undefined && si > rc.replayIndex) break;
    const v = values[si];
    if (v === null) { started = false; continue; }
    const x = slotXCenter(si, vp);
    const y = priceToY(v, ps, ph);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
  // consumed only affects state via setLineDash; save/restore handles both
  void slots;
}

/** Envelope band: fill between (cma + amp) and (cma − amp). */
function drawEnvelope(
  rc: RenderContext,
  cma: (number | null)[],
  amplitude: number,
  color: string,
): void {
  if (amplitude <= 0) return;
  const { ctx, viewport: vp, priceScale: ps } = rc;
  const ph = vp.mainPaneHeight;

  const upper: { x: number; y: number }[] = [];
  const lower: { x: number; y: number }[] = [];

  for (let i = 0; i < vp.visibleSlotCount; i++) {
    const si = vp.firstSlotIndex + i;
    if (si < 0 || si >= cma.length) continue;
    if (rc.replayIndex !== undefined && si > rc.replayIndex) break;
    const m = cma[si];
    if (m === null) continue;
    const x = slotXCenter(si, vp);
    upper.push({ x, y: priceToY(m + amplitude, ps, ph) });
    lower.push({ x, y: priceToY(m - amplitude, ps, ph) });
  }
  if (upper.length < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(upper[0].x, upper[0].y);
  for (let i = 1; i < upper.length; i++) ctx.lineTo(upper[i].x, upper[i].y);
  for (let i = lower.length - 1; i >= 0; i--) ctx.lineTo(lower[i].x, lower[i].y);
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, 0.06);
  ctx.fill();
  ctx.restore();
}

/** Downward triangle at price = candle.low for each past trough. */
function drawTroughs(
  rc: RenderContext,
  troughSlotIndices: number[],
  slots: CandleSlot[],
  color: string,
): void {
  const { ctx, viewport: vp, priceScale: ps } = rc;
  const ph = vp.mainPaneHeight;
  const sw = slotWidth(vp);
  const size = Math.max(4, Math.min(8, sw * 0.6));

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;

  for (const si of troughSlotIndices) {
    if (si < vp.firstSlotIndex) continue;
    if (si >= vp.firstSlotIndex + vp.visibleSlotCount) break;
    if (rc.replayIndex !== undefined && si > rc.replayIndex) break;
    const slot = slots[si];
    if (!slot || !slot.candle) continue;
    const x = slotXCenter(si, vp);
    const y = priceToY(slot.candle.low, ps, ph) + size + 4;
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x - size * 0.7, y);
    ctx.lineTo(x + size * 0.7, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Shaded vertical band for the projected next-trough window. */
function drawProjection(
  rc: RenderContext,
  projection: { startSlotIndex: number; endSlotIndex: number },
  color: string,
): void {
  const { ctx, viewport: vp } = rc;
  const ph = vp.mainPaneHeight;
  const sw = slotWidth(vp);

  const x1 = (projection.startSlotIndex - vp.firstSlotIndex) * sw;
  const x2 = (projection.endSlotIndex   - vp.firstSlotIndex + 1) * sw;
  const rightEdge = vp.width - vp.priceAxisWidth;

  const clippedX1 = Math.max(0, x1);
  const clippedX2 = Math.min(rightEdge, x2);
  if (clippedX2 <= clippedX1) return;

  ctx.save();
  ctx.fillStyle = withAlpha(color, 0.08);
  ctx.fillRect(clippedX1, 0, clippedX2 - clippedX1, ph);
  ctx.strokeStyle = withAlpha(color, 0.7);
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(clippedX1 + 0.5, 0);
  ctx.lineTo(clippedX1 + 0.5, ph);
  ctx.moveTo(clippedX2 - 0.5, 0);
  ctx.lineTo(clippedX2 - 0.5, ph);
  ctx.stroke();
  ctx.restore();
}

// ── Public entry ────────────────────────────────────────────────────────────

/**
 * Draw all Hurst overlays. Safe to call every frame; internally guards on
 * `config.visible`, empty output, and missing per-cycle data.
 */
export function renderHurst(
  rc: RenderContext,
  slots: CandleSlot[],
  config: HurstConfig,
  output: HurstOutput | null,
): void {
  if (!config.visible || !output) return;

  for (const band of config.cycles) {
    if (!band.enabled) continue;
    const data = output.perCycle[band.id];
    if (!data) continue;

    if (config.tools.showEnvelope) drawEnvelope(rc, data.cma, data.amplitude, band.color);
    if (config.tools.showCma)      drawSeries(rc, data.cma, slots, band.color, 1.5, false);
    if (config.tools.showFld)      drawSeries(rc, data.fld, slots, band.color, 1.25, true);
    if (config.tools.showTroughs)  drawTroughs(rc, data.troughSlotIndices, slots, band.color);
    if (config.tools.showProjection && data.projection) {
      drawProjection(rc, data.projection, band.color);
    }
  }
}
