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

/**
 * Intraday slot generation (1m / 5m / 15m / 1h / 4h …).
 *
 * For continuous markets (crypto, session.tradingDays covers all 7 days
 * with a full 00:00–23:59 session) every slot is 'trading' and there are
 * no gaps to worry about.
 *
 * For non-continuous markets (equities, futures) we intentionally fill
 * the whole 24 h of every calendar day at the TF cadence so that
 *   • the intraday x-axis is uniform across days,
 *   • the overnight window between session close and next open renders
 *     as underscore-glyph placeholder columns (status 'outside_session'),
 *   • cross-market offset overlays (e.g. BTC on AAPL 5m) can map to
 *     every slot instead of only during 09:30–16:00 NY,
 *   • the `_applyGapVisibility` "hide gaps" toggle can collapse all
 *     empty columns for a compact session-only view.
 *
 * Memory note: full-fill multiplies slot count by 24 h / session_hours
 * (≈ 3.7× for NYSE 5m). At 8 years of 5m data this is ~840K slots ≈
 * 80 MB — still tractable in the browser. Loads capped at 2000 bars use
 * ~10K slots so the default user experience is unaffected.
 */
function generateIntradaySlots(
  startMs: number,
  endMs: number,
  timeframe: Timeframe,
  session: SessionConfig,
): CandleSlot[] {
  const tfMinutes = TIMEFRAME_MINUTES[timeframe];
  const tfMs = tfMinutes * 60_000;
  const tz = session.timezone;
  const slots: CandleSlot[] = [];
  let slotIndex = 0;
  const holidaySet = new Set(session.holidays);
  const [openH, openM] = parseTime(session.regularOpen);
  const [closeH, closeM] = parseTime(session.regularClose);

  const startLocal = toZonedTime(new Date(startMs), tz);
  const endLocal = toZonedTime(new Date(endMs), tz);
  const totalDays = differenceInCalendarDays(startOfDay(endLocal), startOfDay(startLocal)) + 1;

  for (let d = 0; d < totalDays; d++) {
    const dayDate = addDays(startOfDay(startLocal), d);
    const localDateStr = format(dayDate, 'yyyy-MM-dd');
    const isoWeekday = (getDay(dayDate) || 7);
    const isTrading = session.tradingDays.includes(isoWeekday);
    const isHoliday = holidaySet.has(localDateStr);

    const midnightUtc = fromZonedTime(`${localDateStr}T00:00:00`, tz).getTime();
    const nextMidnightUtc = midnightUtc + 24 * 60 * 60 * 1000;

    // Session boundaries (UTC ms) for this local day — used to decide
    // 'trading' vs 'outside_session' inside the 24 h fill loop.
    const halfDay = session.halfDays[localDateStr];
    const [sesCloseH, sesCloseM] = halfDay ? parseTime(halfDay.close) : [closeH, closeM];
    const sessionOpenMs  = localToUtcMs(localDateStr, openH, openM, tz);
    const sessionCloseMs = localToUtcMs(localDateStr, sesCloseH, sesCloseM, tz);
    const sessionStatus: SlotStatus = halfDay ? 'halfday' : 'trading';

    let dayBackdrop: SlotStatus | null = null;
    if (!isTrading) dayBackdrop = 'weekend';
    else if (isHoliday) dayBackdrop = 'holiday';

    for (let ts = midnightUtc; ts < nextMidnightUtc; ts += tfMs) {
      let status: SlotStatus;
      if (dayBackdrop) status = dayBackdrop;
      // Overlap semantics: the slot covers [ts, ts+tfMs). Treat it as a
      // session slot when it overlaps [sessionOpenMs, sessionCloseMs) so
      // e.g. on a 1h chart with a 09:30 open, the 09:00 slot captures the
      // 09:30-09:59 opening candle instead of being marked outside_session.
      else if (ts < sessionCloseMs && ts + tfMs > sessionOpenMs) status = sessionStatus;
      else status = 'outside_session';
      slots.push({ slotIndex: slotIndex++, timestamp: ts, status, candle: null });
    }
  }
  return slots;
}

/** Daily slots – one slot per calendar day; trading days get status 'trading'. */
// ── Daily / Weekly / Monthly slot generators ─────────────────────────────
//
// For D/W/M timeframes we operate purely in UTC calendar space:
//   • All raw daily bars from every supported provider (Kaggle, Bybit,
//     Alpaca, Dukascopy, mock) are stamped at 00:00 UTC of their trading
//     date. Iterating UTC calendar days makes the raw-candle → slot
//     mapping a trivial 1-to-1 by `toISOString().slice(0,10)`.
//   • Anchoring the slot timestamp at 12:00 UTC guarantees it lands on
//     the intended calendar date in any display tz between UTC−11 and
//     UTC+12 (i.e. every IANA zone this app supports). The session tz is
//     therefore irrelevant for D/W/M rendering — it only informs which
//     UTC weekdays are trading days and which UTC calendar dates are
//     holidays.
//   • Session tz still drives intraday slot generation (see
//     generateIntradaySlots) because session open/close matters at
//     minute/hour granularity.

/** Midnight UTC of the UTC calendar day containing `ms`. */
function utcDayFloor(ms: number): number {
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

/** "YYYY-MM-DD" of the UTC calendar day containing `ms`. */
function utcDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO weekday (1=Mon..7=Sun) of the UTC calendar day containing `ms`. */
function utcIsoWeekday(ms: number): number {
  return new Date(ms).getUTCDay() || 7;
}

/** Anchor the slot ts at 12:00 UTC of a given UTC day (safe across tzs). */
const NOON_MS = 12 * 60 * 60 * 1000;

function generateDailySlots(
  startMs: number,
  endMs: number,
  session: SessionConfig,
): CandleSlot[] {
  const holidaySet = new Set(session.holidays);
  const slots: CandleSlot[] = [];
  let slotIndex = 0;

  const firstDay = utcDayFloor(startMs);
  const lastDay  = utcDayFloor(endMs);

  for (let day = firstDay; day <= lastDay; day += 86_400_000) {
    const ts        = day + NOON_MS;
    const dateKey   = utcDateKey(day);
    const weekday   = utcIsoWeekday(day);
    const isTrading = session.tradingDays.includes(weekday);
    const isHoliday = holidaySet.has(dateKey);

    let status: SlotStatus;
    if (!isTrading) status = 'weekend';
    else if (isHoliday) status = 'holiday';
    else if (session.halfDays[dateKey]) status = 'halfday';
    else status = 'trading';

    slots.push({ slotIndex: slotIndex++, timestamp: ts, status, candle: null });
  }
  return slots;
}

/** Weekly slots – one slot per ISO week (Mon-based, UTC). */
function generateWeeklySlots(
  startMs: number,
  endMs: number,
  session: SessionConfig,
): CandleSlot[] {
  const holidaySet = new Set(session.holidays);
  const slots: CandleSlot[] = [];
  let slotIndex = 0;

  // Snap start to the Monday of its UTC week.
  const startDay = utcDayFloor(startMs);
  const shiftToMon = ((utcIsoWeekday(startDay) - 1) * 86_400_000);
  let weekStart = startDay - shiftToMon;
  const endDay = utcDayFloor(endMs);

  while (weekStart <= endDay) {
    // Find the first UTC trading day of the week that isn't a holiday.
    let tradingDay: number | null = null;
    for (let off = 0; off < 5; off++) {
      const day     = weekStart + off * 86_400_000;
      const weekday = utcIsoWeekday(day);
      if (session.tradingDays.includes(weekday) && !holidaySet.has(utcDateKey(day))) {
        tradingDay = day;
        break;
      }
    }
    const ts = (tradingDay ?? weekStart) + NOON_MS;
    const status: SlotStatus = tradingDay !== null ? 'trading' : 'holiday';
    slots.push({ slotIndex: slotIndex++, timestamp: ts, status, candle: null });
    weekStart += 7 * 86_400_000;
  }
  return slots;
}

/** Monthly slots – one slot per UTC calendar month. */
function generateMonthlySlots(
  startMs: number,
  endMs: number,
  session: SessionConfig,
): CandleSlot[] {
  const holidaySet = new Set(session.holidays);
  const slots: CandleSlot[] = [];
  let slotIndex = 0;

  const start = new Date(utcDayFloor(startMs));
  const end   = new Date(utcDayFloor(endMs));
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth();

  while (y < endY || (y === endY && m <= endM)) {
    const firstOfMonth = Date.UTC(y, m, 1);
    const daysInMonth  = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

    let tradingDay: number | null = null;
    for (let off = 0; off < daysInMonth; off++) {
      const day     = firstOfMonth + off * 86_400_000;
      const weekday = utcIsoWeekday(day);
      if (session.tradingDays.includes(weekday) && !holidaySet.has(utcDateKey(day))) {
        tradingDay = day;
        break;
      }
    }
    const ts = (tradingDay ?? firstOfMonth) + NOON_MS;
    const status: SlotStatus = tradingDay !== null ? 'trading' : 'holiday';
    slots.push({ slotIndex: slotIndex++, timestamp: ts, status, candle: null });

    m += 1;
    if (m === 12) { m = 0; y += 1; }
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
