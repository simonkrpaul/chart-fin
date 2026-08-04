/**
 * Sample data generator – creates synthetic OHLCV candles for development / demo.
 * Uses a simple random-walk model.  Replace with real data fetcher in production.
 */
import type { RawCandle, Timeframe } from '../types';
import { TIMEFRAME_MINUTES } from '../engine/calendarEngine';

export function generateSampleCandles(
  startMs: number,
  endMs: number,
  timeframe: Timeframe,
  basePrice = 500,
  symbol = 'DEMO',
): RawCandle[] {
  // ── Daily / Weekly / Monthly ────────────────────────────────────────────
  if (timeframe === '1d' || timeframe === '1w' || timeframe === '1M') {
    return generateBarCandles(startMs, endMs, timeframe, basePrice, symbol);
  }

  // ── Intraday ────────────────────────────────────────────────────────────
  const intervalMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
  const candles: RawCandle[] = [];
  let price = basePrice;
  let ts = startMs;

  while (ts <= endMs) {
    const date = new Date(ts);
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    const dayOfWeek = date.getUTCDay();

    if (dayOfWeek === 0 || dayOfWeek === 6) { ts += intervalMs; continue; }

    const utcMinutes = hour * 60 + minute;
    if (utcMinutes < 14 * 60 + 30 || utcMinutes >= 21 * 60) { ts += intervalMs; continue; }

    // Random walk
    const changePercent = (Math.random() - 0.495) * 0.012;
    price += price * changePercent;

    const volatility = price * 0.005;
    const open = price * (1 + (Math.random() - 0.5) * 0.004);
    const high = open + Math.random() * volatility;
    const low = open - Math.random() * volatility;
    const close = low + Math.random() * (high - low);
    const volume = Math.floor(10_000 + Math.random() * 90_000);

    candles.push({
      timestamp: ts,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume,
      symbol,
      exchange: 'DEMO',
      adjusted: false,
      session: 'regular',
      timezone: 'America/New_York',
    });

    ts += intervalMs;
  }

  return candles;
}

/** Generate daily / weekly / monthly OHLCV bars via random walk. */
function generateBarCandles(
  startMs: number,
  endMs: number,
  timeframe: '1d' | '1w' | '1M',
  basePrice: number,
  symbol: string,
): RawCandle[] {
  const candles: RawCandle[] = [];
  let price = basePrice;
  let ts = startMs;

  const DAY = 86_400_000;
  const step = timeframe === '1d' ? DAY : timeframe === '1w' ? 7 * DAY : 30 * DAY;

  while (ts <= endMs) {
    const dow = new Date(ts).getUTCDay();
    // Skip weekends for daily; weekly/monthly skip naturally
    if (timeframe === '1d' && (dow === 0 || dow === 6)) { ts += DAY; continue; }

    const changePercent = (Math.random() - 0.49) * (timeframe === '1M' ? 0.06 : timeframe === '1w' ? 0.03 : 0.015);
    price += price * changePercent;
    const range = price * (timeframe === '1M' ? 0.04 : timeframe === '1w' ? 0.02 : 0.008);
    const open  = price * (1 + (Math.random() - 0.5) * 0.006);
    const high  = open + Math.random() * range;
    const low   = open - Math.random() * range;
    const close = low + Math.random() * (high - low);
    const volume = Math.floor(500_000 + Math.random() * 4_500_000);

    candles.push({
      timestamp: ts,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low:  +low.toFixed(2),
      close: +close.toFixed(2),
      volume,
      symbol,
      exchange: 'DEMO',
      adjusted: false,
      session: 'regular',
      timezone: 'America/New_York',
    });
    ts += step;
  }
  return candles;
}
