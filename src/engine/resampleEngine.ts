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
import type { RawCandle, Timeframe } from '../types';
import { TIMEFRAME_MINUTES } from './calendarEngine';

/** Returns true if `target` is a coarser timeframe than `source`. */
export function isCoarserThan(target: Timeframe, source: Timeframe): boolean {
  return TIMEFRAME_MINUTES[target] > TIMEFRAME_MINUTES[source];
}

/** Returns true if the source candles can be resampled into targetTf. */
export function canResample(sourceTf: Timeframe, targetTf: Timeframe): boolean {
  return TIMEFRAME_MINUTES[targetTf] >= TIMEFRAME_MINUTES[sourceTf];
}

/**
 * Aggregate `source` candles into `targetTf` buckets.
 * Handles all 8 supported timeframes.
 */
export function resampleCandles(source: RawCandle[], targetTf: Timeframe): RawCandle[] {
  if (source.length === 0) return [];

  const targetMs = TIMEFRAME_MINUTES[targetTf] * 60_000;

  const getBucketStart = (ts: number): number => {
    if (targetTf === '1w') {
      // ISO week starts Monday UTC
      const d = new Date(ts);
      const day = d.getUTCDay(); // 0=Sun, 1=Mon ... 6=Sat
      const daysFromMonday = (day + 6) % 7;
      const mondayMs = ts - daysFromMonday * 86_400_000;
      // Floor to midnight UTC of that Monday
      const mondayDate = new Date(mondayMs);
      return Date.UTC(mondayDate.getUTCFullYear(), mondayDate.getUTCMonth(), mondayDate.getUTCDate());
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
