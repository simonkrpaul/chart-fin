/**
 * Calendar & Time-Slot Engine
 *
 * Generates a complete ordered array of CandleSlots for a date range,
 * including empty slots for weekends, holidays, and non-trading windows.
 * This is the backbone of calendar-day alignment.
 */
import {
  addDays,
  addWeeks,
  addMonths,
  startOfDay,
  startOfWeek,
  startOfMonth,
  endOfMonth,
  getDay,
  format,
  differenceInCalendarDays,
} from 'date-fns';
import { toZonedTime, fromZonedTime } from './tzUtils';
import type { CandleSlot, SessionConfig, SlotStatus, Timeframe } from '../types';

export const INTRADAY_TIMEFRAMES: Timeframe[] = ['1m', '5m', '10m', '15m', '1h', '4h'];

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '10m': 10,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
  '1M': 43200,
};

/** Parse "HH:MM" into [hour, minute] */
function parseTime(t: string): [number, number] {
  const [h, m] = t.split(':').map(Number);
  return [h, m];
}

/** Build a UTC timestamp for a given local date + time + IANA timezone */
function localToUtcMs(
  localDateStr: string, // "YYYY-MM-DD"
  hour: number,
  minute: number,
  tz: string,
): number {
  return fromZonedTime(`${localDateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`, tz).getTime();
}

/** Generate every slot timestamp for a single trading day */
function slotsForDay(
  localDateStr: string,
  session: SessionConfig,
  tfMinutes: number,
): { timestamps: number[]; status: SlotStatus } {
  const tz = session.timezone;
  const [openH, openM] = parseTime(session.regularOpen);

  // Check half-day
  const halfDay = session.halfDays[localDateStr];
  const [closeH, closeM] = parseTime(halfDay ? halfDay.close : session.regularClose);
  const status: SlotStatus = halfDay ? 'halfday' : 'trading';

  const openMs = localToUtcMs(localDateStr, openH, openM, tz);
  const closeMs = localToUtcMs(localDateStr, closeH, closeM, tz);

  const timestamps: number[] = [];
  let cursor = openMs;
  while (cursor < closeMs) {
    timestamps.push(cursor);
    cursor += tfMinutes * 60_000;
  }
  return { timestamps, status };
}

/**
 * Generate the complete slot array for [startMs, endMs] (inclusive by day).
 *
 * Every calendar day/week/month in the range appears. Non-trading intervals
 * get placeholder slots so the time axis is never compressed.
 */
export function generateSlots(
  startMs: number,
  endMs: number,
  timeframe: Timeframe,
  session: SessionConfig,
): CandleSlot[] {
  if (timeframe === '1d') return generateDailySlots(startMs, endMs, session);
  if (timeframe === '1w') return generateWeeklySlots(startMs, endMs, session);
  if (timeframe === '1M') return generateMonthlySlots(startMs, endMs, session);
  return generateIntradaySlots(startMs, endMs, timeframe, session);
}

/** Intraday slot generation (5m / 10m / 15m / 1h / 4h) – original logic. */
function generateIntradaySlots(
  startMs: number,
  endMs: number,
  timeframe: Timeframe,
  session: SessionConfig,
): CandleSlot[] {
  const tfMinutes = TIMEFRAME_MINUTES[timeframe];
  const tz = session.timezone;
  const slots: CandleSlot[] = [];
  let slotIndex = 0;
  const holidaySet = new Set(session.holidays);

  const startLocal = toZonedTime(new Date(startMs), tz);
  const endLocal = toZonedTime(new Date(endMs), tz);
  const totalDays = differenceInCalendarDays(startOfDay(endLocal), startOfDay(startLocal)) + 1;

  for (let d = 0; d < totalDays; d++) {
    const dayDate = addDays(startOfDay(startLocal), d);
    const localDateStr = format(dayDate, 'yyyy-MM-dd');
    const isoWeekday = (getDay(dayDate) || 7);
    const isTrading = session.tradingDays.includes(isoWeekday);
    const isHoliday = holidaySet.has(localDateStr);

    if (!isTrading) {
      const midnightUtc = fromZonedTime(`${localDateStr}T00:00:00`, tz).getTime();
      slots.push({ slotIndex: slotIndex++, timestamp: midnightUtc, status: 'weekend', candle: null });
      continue;
    }
    if (isHoliday) {
      const midnightUtc = fromZonedTime(`${localDateStr}T00:00:00`, tz).getTime();
      slots.push({ slotIndex: slotIndex++, timestamp: midnightUtc, status: 'holiday', candle: null });
      continue;
    }
    const { timestamps, status } = slotsForDay(localDateStr, session, tfMinutes);
    for (const ts of timestamps) {
      slots.push({ slotIndex: slotIndex++, timestamp: ts, status, candle: null });
    }
  }
  return slots;
}

/** Daily slots – one slot per calendar day; trading days get status 'trading'. */
function generateDailySlots(
  startMs: number,
  endMs: number,
  session: SessionConfig,
): CandleSlot[] {
  const tz = session.timezone;
  const slots: CandleSlot[] = [];
  let slotIndex = 0;
  const holidaySet = new Set(session.holidays);
  const [openH, openM] = parseTime(session.regularOpen);

  const startLocal = toZonedTime(new Date(startMs), tz);
  const endLocal   = toZonedTime(new Date(endMs), tz);
  const totalDays  = differenceInCalendarDays(startOfDay(endLocal), startOfDay(startLocal)) + 1;

  for (let d = 0; d < totalDays; d++) {
    const dayDate      = addDays(startOfDay(startLocal), d);
    const localDateStr = format(dayDate, 'yyyy-MM-dd');
    const isoWeekday   = getDay(dayDate) || 7;
    const isTrading    = session.tradingDays.includes(isoWeekday);
    const isHoliday    = holidaySet.has(localDateStr);

    if (!isTrading) {
      const ts = fromZonedTime(`${localDateStr}T00:00:00`, tz).getTime();
      slots.push({ slotIndex: slotIndex++, timestamp: ts, status: 'weekend', candle: null });
      continue;
    }
    if (isHoliday) {
      const ts = fromZonedTime(`${localDateStr}T00:00:00`, tz).getTime();
      slots.push({ slotIndex: slotIndex++, timestamp: ts, status: 'holiday', candle: null });
      continue;
    }
    const halfDay = session.halfDays[localDateStr];
    const status: SlotStatus = halfDay ? 'halfday' : 'trading';
    const ts = localToUtcMs(localDateStr, openH, openM, tz);
    slots.push({ slotIndex: slotIndex++, timestamp: ts, status, candle: null });
  }
  return slots;
}

/** Weekly slots – one slot per calendar week (Mon-based). */
function generateWeeklySlots(
  startMs: number,
  endMs: number,
  session: SessionConfig,
): CandleSlot[] {
  const tz = session.timezone;
  const slots: CandleSlot[] = [];
  let slotIndex = 0;
  const holidaySet = new Set(session.holidays);
  const [openH, openM] = parseTime(session.regularOpen);

  // Snap to Monday of the start week
  const startLocal = toZonedTime(new Date(startMs), tz);
  const endLocal   = toZonedTime(new Date(endMs), tz);
  let weekStart    = startOfWeek(startOfDay(startLocal), { weekStartsOn: 1 }); // Mon
  const weekEnd    = startOfWeek(startOfDay(endLocal),   { weekStartsOn: 1 });

  while (weekStart <= weekEnd) {
    // Find first trading day in this Mon–Fri week
    let tradingTs: number | null = null;
    for (let off = 0; off < 5; off++) {
      const day        = addDays(weekStart, off);
      const dateStr    = format(day, 'yyyy-MM-dd');
      const isoWeekday = getDay(day) || 7;
      if (session.tradingDays.includes(isoWeekday) && !holidaySet.has(dateStr)) {
        tradingTs = localToUtcMs(dateStr, openH, openM, tz);
        break;
      }
    }
    const mondayStr = format(weekStart, 'yyyy-MM-dd');
    const ts = tradingTs ?? fromZonedTime(`${mondayStr}T00:00:00`, tz).getTime();
    const status: SlotStatus = tradingTs ? 'trading' : 'holiday';
    slots.push({ slotIndex: slotIndex++, timestamp: ts, status, candle: null });
    weekStart = addWeeks(weekStart, 1);
  }
  return slots;
}

/** Monthly slots – one slot per calendar month. */
function generateMonthlySlots(
  startMs: number,
  endMs: number,
  session: SessionConfig,
): CandleSlot[] {
  const tz = session.timezone;
  const slots: CandleSlot[] = [];
  let slotIndex = 0;
  const holidaySet = new Set(session.holidays);
  const [openH, openM] = parseTime(session.regularOpen);

  const startLocal = toZonedTime(new Date(startMs), tz);
  const endLocal   = toZonedTime(new Date(endMs), tz);
  let monthStart   = startOfMonth(startOfDay(startLocal));
  const monthEnd   = startOfMonth(startOfDay(endLocal));

  while (monthStart <= monthEnd) {
    const daysInMonth = differenceInCalendarDays(endOfMonth(monthStart), monthStart) + 1;
    let tradingTs: number | null = null;
    for (let off = 0; off < daysInMonth; off++) {
      const day        = addDays(monthStart, off);
      const dateStr    = format(day, 'yyyy-MM-dd');
      const isoWeekday = getDay(day) || 7;
      if (session.tradingDays.includes(isoWeekday) && !holidaySet.has(dateStr)) {
        tradingTs = localToUtcMs(dateStr, openH, openM, tz);
        break;
      }
    }
    const monthStr = format(monthStart, 'yyyy-MM-dd');
    const ts = tradingTs ?? fromZonedTime(`${monthStr}T00:00:00`, tz).getTime();
    const status: SlotStatus = tradingTs ? 'trading' : 'holiday';
    slots.push({ slotIndex: slotIndex++, timestamp: ts, status, candle: null });
    monthStart = addMonths(monthStart, 1);
  }
  return slots;
}

/**
 * Compute the expected slot count for a given timeframe on a single trading day
 * (full session, no half-day).
 */
export function slotsPerDay(tf: Timeframe, session: SessionConfig): number {
  if (tf === '1d' || tf === '1w' || tf === '1M') return 1;
  const [openH, openM] = parseTime(session.regularOpen);
  const [closeH, closeM] = parseTime(session.regularClose);
  const totalMinutes = (closeH * 60 + closeM) - (openH * 60 + openM);
  return Math.floor(totalMinutes / TIMEFRAME_MINUTES[tf]);
}

/**
 * Generate unconstrained uniform-interval slots from startMs to endMs.
 * Used as a fallback for 24/7 data (e.g. crypto) where session-based
 * slot generation would leave most candles without a matching slot.
 */
export function generateUnconstrainedSlots(
  startMs: number,
  endMs: number,
  timeframe: Timeframe,
): CandleSlot[] {
  const tfMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
  // Snap start to nearest floor multiple of tfMs
  const snapped = Math.floor(startMs / tfMs) * tfMs;
  const slots: CandleSlot[] = [];
  let slotIndex = 0;
  for (let t = snapped; t <= endMs + tfMs; t += tfMs) {
    slots.push({ slotIndex: slotIndex++, timestamp: t, status: 'trading', candle: null });
  }
  return slots;
}

/**
 * Given a slot array (already generated), build a Map<timestamp, slotIndex>
 * for O(1) lookup when merging raw candles.
 */
export function buildTimestampIndex(slots: CandleSlot[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const s of slots) {
    map.set(s.timestamp, s.slotIndex);
  }
  return map;
}

/**
 * Shift a UTC timestamp forward by N calendar days, preserving intraday time.
 * Uses timezone-aware arithmetic so DST transitions don't corrupt the result.
 */
export function shiftByCalendarDays(
  utcMs: number,
  calendarDays: number,
  tz: string,
): number {
  const local = toZonedTime(new Date(utcMs), tz);
  const shifted = addDays(local, calendarDays);
  return fromZonedTime(shifted, tz).getTime();
}

/**
 * Count calendar days between two UTC timestamps (using local calendar).
 */
export function calendarDaysBetween(aMs: number, bMs: number, tz: string): number {
  const a = toZonedTime(new Date(aMs), tz);
  const b = toZonedTime(new Date(bMs), tz);
  return Math.max(1, differenceInCalendarDays(startOfDay(b), startOfDay(a)));
}
