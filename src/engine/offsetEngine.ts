/**
 * Historical Offset / Comparison Engine
 *
 * Takes a past date range and projects it onto the current chart timeline
 * by shifting each candle's timestamp forward by N calendar days (preserving
 * exact intraday time positions).
 *
 * Key guarantees:
 * - Calendar-day shifting: weekends / holidays are NOT collapsed.
 * - Intraday time is preserved: a 10:30 candle from 20 days ago stays at 10:30.
 * - Missing slots in the historical window remain missing after projection.
 * - Multiple overlays (10/20/30/40/50 day) are fully independent.
 */
import type {
  CandleSlot,
  OffsetOverlay,
  OffsetOverlayConfig,
  ProjectedCandle,
  RawCandle,
  SessionConfig,
  SwingPoint,
  Timeframe,
} from '../types';
import { TIMEFRAME_MINUTES } from './calendarEngine';

/**
 * Find the primary slot index whose timestamp is closest to targetMs.
 * If targetMs is within toleranceMs of a slot, returns that integer index.
 * If targetMs is BEYOND the last slot, returns a virtual (extrapolated)
 * fractional index so the overlay can be rendered past the chart edge.
 * Returns -1 only when targetMs is before the first slot and out of tolerance.
 */
function nearestOrVirtualSlotIndex(
  primarySlots: CandleSlot[],
  targetMs: number,
  toleranceMs: number,
  avgIntervalMs: number,
): number {
  if (primarySlots.length === 0) return -1;

  const lastSlot = primarySlots[primarySlots.length - 1];

  // Beyond the last slot → extrapolate forward
  if (targetMs > lastSlot.timestamp + toleranceMs) {
    const overshootMs = targetMs - lastSlot.timestamp;
    return (primarySlots.length - 1) + overshootMs / avgIntervalMs;
  }

  // Binary search for nearest slot within tolerance
  let lo = 0;
  let hi = primarySlots.length - 1;
  let bestIdx = -1;
  let bestDiff = Infinity;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const diff = Math.abs(primarySlots[mid].timestamp - targetMs);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = mid; }
    if (primarySlots[mid].timestamp < targetMs) lo = mid + 1;
    else hi = mid - 1;
  }

  return bestDiff <= toleranceMs ? bestIdx : -1;
}

export function buildOffsetOverlay(
  primarySlots: CandleSlot[],
  config: OffsetOverlayConfig,
  historicalCandles: RawCandle[],
  _session: SessionConfig,
  timeframe: Timeframe,
): OffsetOverlay {
  // Shift amount in milliseconds (pure calendar days – no timezone gymnastics)
  const shiftMs = config.calendarDayOffset * 24 * 60 * 60 * 1000;

  // Tolerance for nearest-slot lookup: half the interval of the timeframe
  const tfIntervalMs = TIMEFRAME_MINUTES[timeframe] * 60 * 1000;
  const toleranceMs = tfIntervalMs / 2;

  // Average interval between primary slots (used for forward extrapolation)
  const avgIntervalMs = primarySlots.length > 1
    ? (primarySlots[primarySlots.length - 1].timestamp - primarySlots[0].timestamp) / (primarySlots.length - 1)
    : tfIntervalMs;

  // For daily timeframe, build a UTC-date-string → slot-index map.
  // This avoids a systematic mismatch: primary daily slots are stamped at
  // session-open UTC (e.g. 14:30 UTC for NYSE), while raw candles from
  // 24/7 data sources (crypto) arrive at midnight UTC.  The resulting
  // ~14.5 h gap is larger than the 12 h timestamp tolerance, so the
  // nearest-slot binary search always misses on weekdays.
  const dateSlotMap = new Map<string, number>();
  if (timeframe === '1d') {
    for (let i = 0; i < primarySlots.length; i++) {
      const d = new Date(primarySlots[i].timestamp);
      dateSlotMap.set(
        `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`,
        i,
      );
    }
  }

  // Determine anchor candle close for normalization modes
  let anchorClose: number | null = null;
  if (config.mode === 'normalized' || config.mode === 'percent' || config.mode === 'index100') {
    const sorted = [...historicalCandles].sort((a, b) => a.timestamp - b.timestamp);
    anchorClose = sorted.find(c => c.close > 0)?.close ?? null;
  }

  // Project each historical candle forward by shiftMs, find nearest primary slot
  const projected: ProjectedCandle[] = [];

  // Sort source candles by time
  const sorted = [...historicalCandles].sort((a, b) => a.timestamp - b.timestamp);

  for (const candle of sorted) {
    const projectedTs = candle.timestamp + shiftMs;

    let projectedSlotIndex: number;
    if (timeframe === '1d') {
      // Period-based lookup: match by UTC calendar date to avoid session-vs-midnight gap
      const pd = new Date(projectedTs);
      const key = `${pd.getUTCFullYear()}-${pd.getUTCMonth()}-${pd.getUTCDate()}`;
      const found = dateSlotMap.get(key);
      if (found !== undefined) {
        projectedSlotIndex = found;
      } else {
        // Date not in primary range – either before the first slot or beyond the last bar.
        // Let nearestOrVirtualSlotIndex handle forward extrapolation.
        projectedSlotIndex = nearestOrVirtualSlotIndex(primarySlots, projectedTs, toleranceMs, avgIntervalMs);
      }
    } else {
      projectedSlotIndex = nearestOrVirtualSlotIndex(primarySlots, projectedTs, toleranceMs, avgIntervalMs);
    }

    let normalizedValue: number | undefined;
    if (anchorClose !== null && anchorClose !== 0) {
      if (config.mode === 'percent') {
        normalizedValue = ((candle.close - anchorClose) / anchorClose) * 100;
      } else if (config.mode === 'index100') {
        normalizedValue = (candle.close / anchorClose) * 100;
      } else if (config.mode === 'normalized') {
        normalizedValue = candle.close / anchorClose;
      }
    }

    projected.push({
      originalTimestamp: candle.timestamp,
      projectedTimestamp: projectedTs,
      projectedSlotIndex,
      candle,
      normalizedValue,
    });
  }

  return {
    config,
    projectedCandles: projected,
    indicators: [],
    overlaySwingPoints: _computeOverlaySwingPoints(projected, config),
  };
}

function _computeOverlaySwingPoints(
  projected: ProjectedCandle[],
  config: OffsetOverlayConfig,
): SwingPoint[] | undefined {
  if (!config.showSwingHL) return undefined;

  const lr = Math.max(1, config.swingHLLeftRight ?? 5);

  // Sort by ORIGINAL timestamp so pivot detection sees the complete, gapless
  // price sequence. Filtering to only the projected (valid-slot) candles first
  // would leave a sparse subset where almost every bar looks like a local extreme.
  const sorted = [...projected].sort((a, b) => a.originalTimestamp - b.originalTimestamp);
  if (sorted.length < lr * 2 + 1) return [];

  // Run pivot detection using array indices (continuous, no gaps).
  type RawPivot = { type: 'high' | 'low'; price: number; idx: number };
  const raw: RawPivot[] = [];

  for (let i = lr; i < sorted.length - lr; i++) {
    const b = sorted[i];

    let isPH = true;
    for (let j = i - lr; j <= i + lr; j++) {
      if (j === i) continue;
      if (sorted[j].candle.high >= b.candle.high) { isPH = false; break; }
    }
    if (isPH) { raw.push({ type: 'high', price: b.candle.high, idx: i }); continue; }

    let isPL = true;
    for (let j = i - lr; j <= i + lr; j++) {
      if (j === i) continue;
      if (sorted[j].candle.low <= b.candle.low) { isPL = false; break; }
    }
    if (isPL) raw.push({ type: 'low', price: b.candle.low, idx: i });
  }

  // Apply dominant-swing merge and map to projected slot coordinates.
  // Skip any pivot whose candle didn't project onto the primary chart.
  const swingPoints: SwingPoint[] = [];
  for (const p of raw) {
    const pc = sorted[p.idx];
    if (pc.projectedSlotIndex < 0) continue; // not on chart – skip rendering

    const sp: SwingPoint = {
      slotIndex: pc.projectedSlotIndex,
      timestamp: pc.projectedTimestamp,
      price: p.price,
      type: p.type,
    };

    if (swingPoints.length === 0) {
      swingPoints.push(sp);
      continue;
    }
    const last = swingPoints[swingPoints.length - 1];
    if (last.type === p.type) {
      if ((p.type === 'high' && p.price > last.price) ||
          (p.type === 'low'  && p.price < last.price)) {
        swingPoints[swingPoints.length - 1] = sp;
      }
    } else {
      swingPoints.push(sp);
    }
  }

  return swingPoints;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-overlay layout helper
//
// Assigns zIndex and display lanes so that 10/20/30/40/50-day overlays
// don't fully obscure one another. Strategy:
//   - In 'overlay' mode: use distinct colors + opacity tiering
//   - In 'stacked' mode: assign verticalLaneIndex per overlay
// ─────────────────────────────────────────────────────────────────────────────

export const OVERLAY_PALETTE = [
  '#f5c518', // yellow
  '#4fc3f7', // light blue
  '#ff7043', // orange
  '#ab47bc', // purple
  '#66bb6a', // green
  '#ec407a', // pink
];

export function assignOverlayVisuals(
  configs: OffsetOverlayConfig[],
): OffsetOverlayConfig[] {
  return configs.map((c, i) => ({
    ...c,
    color: c.color || OVERLAY_PALETTE[i % OVERLAY_PALETTE.length],
    opacity: c.opacity ?? (0.7 - i * 0.08), // slight opacity reduction per layer
    zIndex: i,
  }));
}
