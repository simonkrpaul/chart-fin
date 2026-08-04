/**
 * Range Measurement Engine
 *
 * Computes the full statistics for a user-selected range on the chart.
 */
import type { CandleSlot, RangeMeasurementResult } from '../types';

export function measureRange(
  slots: CandleSlot[],
  startSlotIndex: number,
  endSlotIndex: number,
  tz: string,
): RangeMeasurementResult {
  const lo = Math.min(startSlotIndex, endSlotIndex);
  const hi = Math.max(startSlotIndex, endSlotIndex);
  const window = slots.slice(lo, hi + 1);

  const filled = window.filter(s => s.candle !== null);
  const tradingBars = filled.length;

  const startSlot = window[0];
  const endSlot = window[window.length - 1];

  const startCandle = filled[0]?.candle ?? null;
  const endCandle = filled[filled.length - 1]?.candle ?? null;

  const startPrice = startCandle?.open ?? 0;
  const endPrice = endCandle?.close ?? 0;

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

  // Compute calendar days from total covered span (first open → last close).
  // We infer the candle period from adjacent slots so the count is
  // n_bars × bar_period / ms_per_day, ceiling-divided.  This avoids
  // timezone-boundary artifacts from calendar-date arithmetic.
  const ONE_DAY_MS = 86_400_000;
  const candlePeriodMs = hi > lo ? slots[lo + 1].timestamp - slots[lo].timestamp : 0;
  const totalSpanMs = endSlot.timestamp - startSlot.timestamp + candlePeriodMs;
  const calendarDays = Math.max(1, Math.ceil(totalSpanMs / ONE_DAY_MS));

  return {
    startTimestamp: startSlot.timestamp,
    endTimestamp: endSlot.timestamp,
    startPrice,
    endPrice,
    calendarDays,
    tradingBars,
    absoluteMove,
    percentMove,
    high,
    low,
    priceRange: high - low,
    volumeSum: tradingBars > 0 ? volumeSum : null,
    elapsedMs: endSlot.timestamp - startSlot.timestamp,
  };
}
