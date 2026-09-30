/**
 * Resample Engine
 *
 * Aggregates finer-timeframe OHLCV candles into coarser timeframes.
 * e.g. 5m → 1h, 1h → 1d, etc.
 *
 * Bucket boundaries:
 *   Fixed-period TFs (5m, 10m, 15m, 1h, 4h, 1d): floor(ts / periodMs) * periodMs
 *   1w: start of ISO week (Monday UTC)
 *   1M: start of UTC calendar month
 */
import type { RawCandle, SessionConfig, Timeframe } from '../types';
import { TIMEFRAME_MINUTES } from './calendarEngine';
import { toZonedTime } from './tzUtils';

/** Returns true if `target` is a coarser timeframe than `source`. */
export function isCoarserThan(target: Timeframe, source: Timeframe): boolean {
  return TIMEFRAME_MINUTES[target] > TIMEFRAME_MINUTES[source];
}

/** Returns true if the source candles can be resampled into targetTf. */
export function canResample(sourceTf: Timeframe, targetTf: Timeframe): boolean {
  return TIMEFRAME_MINUTES[targetTf] >= TIMEFRAME_MINUTES[sourceTf];
}

/**
 * Drop candles whose timestamps fall outside the session's regular hours
 * window. This must run BEFORE resampling for session markets so that a
 * higher-TF bucket (e.g. 09:00 hourly) doesn't silently swallow pre-market
 * (08:00–09:29) bars alongside the real 09:30 opening bar, which produces
 * "distorted" candles at the session open on any TF ≥ 15m.
 *
 * Only runs for INTRADAY source timeframes. Daily / weekly / monthly bars
 * are stamped at midnight UTC (or ~19:00 local for NY-based markets),
 * which is always outside the 09:30–16:00 session window — filtering them
 * would drop every single bar. Weekend / holiday handling for daily bars
 * happens later, in the gap-visibility filter.
 *
 * A no-op for continuous 24/7 markets (crypto, forex) whose session covers
 * the full day.
 */
export function filterBySessionHours(
  source: RawCandle[],
  session: SessionConfig,
  sourceTf?: Timeframe,
): RawCandle[] {
  // Skip for daily-or-coarser TFs — one bar per day means no intraday
  // session windowing is meaningful.
  if (sourceTf === '1d' || sourceTf === '1w' || sourceTf === '1M') return source;
  const [openH, openM] = session.regularOpen.split(':').map(n => parseInt(n, 10));
  const [closeH, closeM] = session.regularClose.split(':').map(n => parseInt(n, 10));
  const openMin = openH * 60 + openM;
  const closeMin = closeH * 60 + closeM;
  // Any market whose session covers the full day is a 24/7 market — skip.
  if (openMin === 0 && closeMin >= 23 * 60 + 59) return source;

  const tz = session.timezone;
  return source.filter(c => {
    const local = toZonedTime(new Date(c.timestamp), tz);
    const min = local.getHours() * 60 + local.getMinutes();
    return min >= openMin && min < closeMin;
  });
}

/**
 * Aggregate `source` candles into `targetTf` buckets.
 * Handles all 8 supported timeframes.
 *
 * Daily / weekly buckets follow the forex trading-day convention (matches
 * TradingView / MT5 / CME): the trading day starts at 17:00 New York.
 * A bar timestamped Sunday 22:00 UTC (= Sun 18:00 EDT) rolls into
 * Monday's daily candle instead of a stub Sunday bar.
 */
export function resampleCandles(
  source: RawCandle[],
  targetTf: Timeframe,
  boundaryTz: string = 'America/New_York',
  boundaryHour: number = 17,
): RawCandle[] {
  if (source.length === 0) return [];

  const targetMs = TIMEFRAME_MINUTES[targetTf] * 60_000;

  // Trading-day (calendar) start at `boundaryHour` in `boundaryTz`, returned
  // as midnight UTC of that trading day so the bar label matches TV / MT5.
  const forexTradingDayStartMs = (ts: number): number => {
    const local = toZonedTime(new Date(ts), boundaryTz);
    // toZonedTime returns a "fake local" date whose *displayed* fields are
    // the wall-clock values in boundaryTz — read them via the local getters.
    let y = local.getFullYear();
    let m = local.getMonth();
    let d = local.getDate();
    if (local.getHours() >= boundaryHour) {
      // Shift to next calendar day.
      const next = new Date(Date.UTC(y, m, d + 1));
      y = next.getUTCFullYear();
      m = next.getUTCMonth();
      d = next.getUTCDate();
    }
    return Date.UTC(y, m, d);
  };

  const getBucketStart = (ts: number): number => {
    if (targetTf === '1d') {
      return forexTradingDayStartMs(ts);
    }
    if (targetTf === '1w') {
      // Monday of the trading week.
      const dayStart = forexTradingDayStartMs(ts);
      const d = new Date(dayStart);
      const dow = d.getUTCDay(); // 0=Sun..6=Sat  (dayStart is already 00:00 UTC)
      const daysFromMonday = (dow + 6) % 7;
      const monday = new Date(dayStart - daysFromMonday * 86_400_000);
      return Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());
    }
    if (targetTf === '1M') {
      const d = new Date(ts);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    // For all fixed-period timeframes, floor to the nearest period boundary
    return Math.floor(ts / targetMs) * targetMs;
  };

  // Group candles by bucket key (preserving insertion order via sorted keys)
  const buckets = new Map<number, RawCandle[]>();
  for (const c of source) {
    const key = getBucketStart(c.timestamp);
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push(c);
  }

  // Aggregate each bucket OHLCV
  const result: RawCandle[] = [];
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const candles = buckets.get(key)!;
    let high = -Infinity, low = Infinity, volume = 0;
    for (const c of candles) {
      if (c.high > high) high = c.high;
      if (c.low  < low)  low  = c.low;
      volume += c.volume;
    }
    result.push({
      timestamp: key,
      open:   candles[0].open,
      high,
      low,
      close:  candles[candles.length - 1].close,
      volume,
    });
  }

  return result;
}
