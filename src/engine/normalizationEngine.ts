/**
 * Data Normalization Engine
 *
 * Merges raw OHLCV candles into an already-generated CandleSlot array.
 * Handles: duplicate timestamps, out-of-order data, candles outside the
 * slot window, and preserves null for missing slots.
 */
import type { CandleSlot, RawCandle, Timeframe } from '../types';
import { buildTimestampIndex } from './calendarEngine';

// ── Calendar-period helpers (UTC) ─────────────────────────────────────────
function utcDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function utcWeekStr(ms: number): string {
  const d = new Date(ms);
  const dow = d.getUTCDay() || 7; // Mon=1..Sun=7
  const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - dow));
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thu.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function utcMonthStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7); // "YYYY-MM"
}

function buildPeriodIndex(
  slots: CandleSlot[],
  periodFn: (ms: number) => string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of slots) {
    const key = periodFn(s.timestamp);
    if (!map.has(key)) map.set(key, s.slotIndex); // first slot in period wins
  }
  return map;
}

/**
 * Merge raw candles into a slot array.
 *
 * Mutates `slots` in place: all our callers (`loadCandles`, `setTimeframe`,
 * `prependCandles`, chartWorker) throw away the input array immediately
 * after this call, so the previous deep-copy was pure allocation overhead
 * — ~1 M wasted slot objects on a 500 k-bar load, enough to trigger GC
 * pauses and OOM crashes.
 *
 * For intraday timeframes: exact timestamp matching.
 * For D/W/M timeframes: calendar-period matching (UTC day / ISO week / month)
 * so that CSV files with midnight-UTC timestamps match session-aligned slots.
 */
export function normalizeCandles(
  slots: CandleSlot[],
  raw: RawCandle[],
  timeframe?: Timeframe,
): CandleSlot[] {
  if (timeframe === '1d' || timeframe === '1w' || timeframe === '1M') {
    const periodFn = timeframe === '1d' ? utcDateStr
                   : timeframe === '1w' ? utcWeekStr
                   : utcMonthStr;
    const periodIndex = buildPeriodIndex(slots, periodFn);
    for (const candle of raw) {
      const si = periodIndex.get(periodFn(candle.timestamp));
      if (si === undefined) continue;
      slots[si].candle = candle;
    }
  } else {
    const index = buildTimestampIndex(slots);
    for (const candle of raw) {
      const si = index.get(candle.timestamp);
      if (si === undefined) continue;
      slots[si].candle = candle;
    }
  }

  return slots;
}

/**
 * Incrementally append new candles (used for streaming/live updates).
 * Returns updated slot array (immutable update – new array).
 */
export function appendCandles(
  current: CandleSlot[],
  incoming: RawCandle[],
): CandleSlot[] {
  if (incoming.length === 0) return current;
  return normalizeCandles(current, incoming);
}

/**
 * Detect gaps in slot data: returns ranges of consecutive null-candle trading
 * slots. Useful for rendering gap markers and for data-fetch requests.
 */
export interface GapRange {
  startSlotIndex: number;
  endSlotIndex: number;
  startTimestamp: number;
  endTimestamp: number;
}

export function detectGaps(slots: CandleSlot[]): GapRange[] {
  const gaps: GapRange[] = [];
  let gapStart: CandleSlot | null = null;

  for (const slot of slots) {
    const isTradingSlot = slot.status === 'trading' || slot.status === 'halfday';
    if (isTradingSlot && slot.candle === null) {
      if (!gapStart) gapStart = slot;
    } else {
      if (gapStart) {
        const prev = slots[slot.slotIndex - 1];
        gaps.push({
          startSlotIndex: gapStart.slotIndex,
          endSlotIndex: prev.slotIndex,
          startTimestamp: gapStart.timestamp,
          endTimestamp: prev.timestamp,
        });
        gapStart = null;
      }
    }
  }
  // Close any trailing gap
  if (gapStart) {
    const last = slots[slots.length - 1];
    gaps.push({
      startSlotIndex: gapStart.slotIndex,
      endSlotIndex: last.slotIndex,
      startTimestamp: gapStart.timestamp,
      endTimestamp: last.timestamp,
    });
  }
  return gaps;
}
