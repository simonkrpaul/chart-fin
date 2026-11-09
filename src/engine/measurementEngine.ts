/**
 * Range Measurement Engine
 *
 * Computes the full statistics for a user-selected range on the chart.
 */
import type { CandleSlot, RangeMeasurementResult } from '../types';

const ONE_DAY_MS = 86_400_000;

/** TradingView-style duration, e.g. "3d 4h", "5h 30m", "45m". */
export function formatDuration(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  let rem = Math.round(Math.abs(ms) / 60_000);
  const d = Math.floor(rem / 1440); rem -= d * 1440;
  const h = Math.floor(rem / 60);
  const m = rem - h * 60;
  if (d > 0) return `${sign}${d}d${h ? ` ${h}h` : ''}`;
  if (h > 0) return `${sign}${h}h${m ? ` ${m}m` : ''}`;
  return `${sign}${m}m`;
}

/**
 * Measures from `startSlotIndex` to `endSlotIndex` (direction-aware, like
 * TradingView's Measure tool). When cursor prices are supplied the change
 * and % are computed between those prices, so the badge matches the box.
 */
export function measureRange(
  slots: CandleSlot[],
  startSlotIndex: number,
  endSlotIndex: number,
  _tz: string,
  startCursorPrice?: number,
  endCursorPrice?: number,
): RangeMeasurementResult {
  const last = Math.max(0, slots.length - 1);
  const from = Math.min(Math.max(0, startSlotIndex), last);
  const to = Math.min(Math.max(0, endSlotIndex), last);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const window = slots.slice(lo, hi + 1);

  const filled = window.filter(s => s.candle !== null);
  // TradingView counts bar *intervals* (index difference), skipping empty gap slots.
  const intervals = window.slice(1).filter(s => s.candle !== null).length;
  const tradingBars = to >= from ? intervals : -intervals;

  const startSlot = slots[from];
  const endSlot = slots[to];

  const startCandle = startSlot?.candle ?? (to >= from ? filled[0] : filled[filled.length - 1])?.candle ?? null;
  const endCandle = endSlot?.candle ?? (to >= from ? filled[filled.length - 1] : filled[0])?.candle ?? null;

  const startPrice = startCursorPrice ?? startCandle?.close ?? 0;
  const endPrice = endCursorPrice ?? endCandle?.close ?? 0;

  let high = -Infinity;
  let low = Infinity;
  let volumeSum = 0;

  for (const s of filled) {
    const c = s.candle!;
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
    volumeSum += c.volume;
  }

  if (!isFinite(high)) high = 0;
  if (!isFinite(low)) low = 0;

  const absoluteMove = endPrice - startPrice;
  const percentMove = startPrice !== 0 ? (absoluteMove / startPrice) * 100 : 0;

  const elapsedMs = (endSlot?.timestamp ?? 0) - (startSlot?.timestamp ?? 0);
  const calendarDays = Math.floor(Math.abs(elapsedMs) / ONE_DAY_MS);

  return {
    startTimestamp: startSlot?.timestamp ?? 0,
    endTimestamp: endSlot?.timestamp ?? 0,
    startPrice,
    endPrice,
    calendarDays,
    tradingBars,
    absoluteMove,
    percentMove,
    high,
    low,
    priceRange: high - low,
    volumeSum: filled.length > 0 ? volumeSum : null,
    elapsedMs,
  };
}
