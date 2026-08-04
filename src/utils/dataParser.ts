/**
 * OHLCV data parser – converts uploaded CSV or JSON files into RawCandle[].
 *
 * ── Supported CSV column names (case-insensitive, any order) ──────────────
 *
 *   timestamp / time / date / datetime / t
 *   open  / o
 *   high  / h
 *   low   / l
 *   close / c
 *   volume / vol / v          (optional – defaults to 0)
 *   symbol / ticker           (optional)
 *
 * ── Timestamp formats accepted ───────────────────────────────────────────
 *   Unix seconds     1700000000
 *   Unix ms          1700000000000
 *   ISO 8601         "2024-01-02T09:30:00Z"
 *   ISO 8601 no TZ   "2024-01-02 09:30:00"   (treated as UTC)
 *   US date          "01/02/2024 09:30"
 *
 * ── Supported JSON formats ───────────────────────────────────────────────
 *   Array of objects: [{ timestamp, open, high, low, close, volume }, ...]
 *   Array of arrays:  [[timestamp, open, high, low, close, volume], ...]
 *   Wrapper object:   { candles: [...] }  or  { data: [...] }
 */
import type { RawCandle } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface ParseResult {
  candles: RawCandle[];
  errors: string[];
  symbol?: string;
}

const EARLIEST_ACCEPTABLE_TS = Date.UTC(2000, 0, 1);

export async function parseOHLCVFile(file: File): Promise<ParseResult> {
  const text = await file.text();
  const lower = file.name.toLowerCase();

  if (lower.endsWith('.json')) {
    return parseJSON(text, file.name);
  }
  // treat everything else as CSV (including .txt, .tsv)
  return parseCSV(text, file.name);
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV parser
// ─────────────────────────────────────────────────────────────────────────────

function parseCSV(text: string, filename: string): ParseResult {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) {
    return { candles: [], errors: ['File has no data rows.'] };
  }

  // Detect delimiter: comma, semicolon, or tab
  const firstLine = lines[0];
  const delim = firstLine.includes('\t') ? '\t'
    : firstLine.includes(';') ? ';'
    : ',';

  const headers = firstLine.split(delim).map(h => h.trim().replace(/^["']|["']$/g, '').toLowerCase());

  const col = (names: string[]) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };

  const tsCol  = col(['timestamp','time','date','datetime','t','ts','open_time']);
  const oCol   = col(['open','o']);
  const hCol   = col(['high','h']);
  const lCol   = col(['low','l']);
  const cCol   = col(['close','c','weighted_price']); // weighted_price as close fallback for Kaggle BTC
  const vCol   = col(['volume','vol','v','volume_(btc)','volume_btc','volume_(currency)']);  // Kaggle BTC has volume_(btc)
  const symCol = col(['symbol','ticker','sym']);
  const priceCol = col(['price','p','px','last','trade_price']);

  if (tsCol === -1) { return { candles: [], errors: ['No timestamp column found. Expected one of: timestamp, time, date, datetime, t'] }; }

  // ── Tick/trade data detection ─────────────────────────────────────────────
  // If we have a 'price' column but no OHLC columns, this is tick data.
  // Aggregate ticks into 1-minute OHLCV candles in-browser.
  if (priceCol !== -1 && oCol === -1 && hCol === -1 && lCol === -1 && cCol === -1) {
    return parseTicksToOHLCV(lines, delim, tsCol, priceCol, vCol, symCol);
  }

  if (oCol  === -1) { return { candles: [], errors: ['No open column found.'] }; }
  if (hCol  === -1) { return { candles: [], errors: ['No high column found.'] }; }
  if (lCol  === -1) { return { candles: [], errors: ['No low column found.'] }; }
  if (cCol  === -1) { return { candles: [], errors: ['No close column found.'] }; }

  const candles: RawCandle[] = [];
  const seen = new Set<number>();

  for (let i = 1; i < lines.length; i++) {
    const row = splitCSVRow(lines[i], delim);
    if (row.length < 5) continue;

    const cell = (idx: number) => idx >= 0 ? row[idx]?.trim().replace(/^["']|["']$/g, '') : '';

    const tsRaw = cell(tsCol);
    const ts = parseTimestamp(tsRaw);
    if (ts === null) {
      errors.push(`Row ${i + 1}: cannot parse timestamp "${tsRaw}"`);
      continue;
    }
    if (ts < EARLIEST_ACCEPTABLE_TS) {
      errors.push(`Row ${i + 1}: timestamp ${tsRaw} is before 2000-01-01 and will be skipped`);
      continue;
    }

    const open  = parseFloat(cell(oCol));
    const high  = parseFloat(cell(hCol));
    const low   = parseFloat(cell(lCol));
    const close = parseFloat(cell(cCol));
    const volume = vCol !== -1 ? parseFloat(cell(vCol)) || 0 : 0;

    // Skip rows with NaN values (common in Kaggle BTC dataset for missing intervals)
    if ([open, high, low, close].some(n => isNaN(n))) continue;

    if (seen.has(ts)) continue; // deduplicate
    seen.add(ts);

    candles.push({
      timestamp: ts,
      open, high, low, close, volume,
      symbol: symCol !== -1 ? cell(symCol) || undefined : undefined,
    });
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  const symbol = candles[0]?.symbol;
  return { candles, errors: errors.slice(0, 20), symbol }; // cap error list at 20
}

function splitCSVRow(line: string, delim: string): string[] {
  // Handle quoted fields containing the delimiter
  const result: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' || ch === "'") { inQuote = !inQuote; continue; }
    if (ch === delim && !inQuote) { result.push(cur); cur = ''; continue; }
    cur += ch;
  }
  result.push(cur);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick data → 1-minute OHLCV aggregation
// ─────────────────────────────────────────────────────────────────────────────

const ONE_MINUTE_MS = 60_000;

function parseTicksToOHLCV(
  lines: string[],
  delim: string,
  tsCol: number,
  priceCol: number,
  volCol: number,
  symCol: number,
): ParseResult {
  const errors: string[] = [];

  // Parse all ticks
  interface Tick { ts: number; price: number; volume: number; }
  const ticks: Tick[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row = splitCSVRow(lines[i], delim);
    const cell = (idx: number) => idx >= 0 ? row[idx]?.trim().replace(/^["']|["']$/g, '') : '';

    const tsRaw = cell(tsCol);
    const ts = parseTimestamp(tsRaw);
    if (ts === null || ts < EARLIEST_ACCEPTABLE_TS) continue;

    const price = parseFloat(cell(priceCol));
    if (isNaN(price) || price <= 0) continue;

    const volume = volCol !== -1 ? (parseFloat(cell(volCol)) || 0) : 0;
    ticks.push({ ts, price, volume });
  }

  if (ticks.length === 0) {
    return { candles: [], errors: ['No valid ticks found in file.'] };
  }

  // Sort by timestamp
  ticks.sort((a, b) => a.ts - b.ts);

  // Aggregate into 1-minute buckets
  const candles: RawCandle[] = [];
  let bucketStart = Math.floor(ticks[0].ts / ONE_MINUTE_MS) * ONE_MINUTE_MS;
  let open = ticks[0].price;
  let high = ticks[0].price;
  let low = ticks[0].price;
  let close = ticks[0].price;
  let vol = ticks[0].volume;

  for (let i = 1; i < ticks.length; i++) {
    const tick = ticks[i];
    const tickBucket = Math.floor(tick.ts / ONE_MINUTE_MS) * ONE_MINUTE_MS;

    if (tickBucket !== bucketStart) {
      // Emit the completed candle
      candles.push({ timestamp: bucketStart, open, high, low, close, volume: vol });

      // Start new bucket
      bucketStart = tickBucket;
      open = tick.price;
      high = tick.price;
      low = tick.price;
      close = tick.price;
      vol = tick.volume;
    } else {
      // Update current bucket
      if (tick.price > high) high = tick.price;
      if (tick.price < low) low = tick.price;
      close = tick.price;
      vol += tick.volume;
    }
  }
  // Emit last bucket
  candles.push({ timestamp: bucketStart, open, high, low, close, volume: vol });

  // Try to extract symbol from first row
  let symbol: string | undefined;
  if (symCol !== -1) {
    const firstRow = splitCSVRow(lines[1], delim);
    symbol = firstRow[symCol]?.trim().replace(/^["']|["']$/g, '') || undefined;
  }

  errors.push(`Aggregated ${ticks.length.toLocaleString()} ticks → ${candles.length.toLocaleString()} 1-minute candles`);

  return { candles, errors, symbol };
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON parser
// ─────────────────────────────────────────────────────────────────────────────

function parseJSON(text: string, _filename: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { candles: [], errors: [`Invalid JSON: ${(e as Error).message}`] };
  }

  // Unwrap common wrapper shapes
  let arr: unknown[];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const key = ['candles','data','ohlcv','bars','results','t'].find(k => Array.isArray(obj[k]));
    if (!key) return { candles: [], errors: ['JSON must be an array or an object with a "candles" / "data" key.'] };
    arr = obj[key] as unknown[];
  } else {
    return { candles: [], errors: ['JSON root must be an array or object.'] };
  }

  const errors: string[] = [];
  const candles: RawCandle[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < arr.length; i++) {
    const row = arr[i];

    // Array-of-arrays: [ts, o, h, l, c, v]
    if (Array.isArray(row)) {
      const [t, o, h, l, c, v = 0] = row as number[];
      const ts = parseTimestamp(String(t));
      if (ts === null) { errors.push(`Item ${i}: bad timestamp`); continue; }
      if (seen.has(ts)) continue;
      seen.add(ts);
      candles.push({ timestamp: ts, open: +o, high: +h, low: +l, close: +c, volume: +v });
      continue;
    }

    if (row && typeof row === 'object') {
      const obj = row as Record<string, unknown>;
      const tsRaw = obj.timestamp ?? obj.time ?? obj.date ?? obj.datetime ?? obj.t ?? obj.open_time;
      const ts = parseTimestamp(String(tsRaw));
      if (ts === null) { errors.push(`Item ${i}: bad timestamp "${tsRaw}"`); continue; }
      if (ts < EARLIEST_ACCEPTABLE_TS) { errors.push(`Item ${i}: timestamp "${tsRaw}" is before 2000-01-01 and will be skipped`); continue; }
      if (seen.has(ts)) continue;
      seen.add(ts);
      candles.push({
        timestamp: ts,
        open:   toNum(obj.open   ?? obj.o),
        high:   toNum(obj.high   ?? obj.h),
        low:    toNum(obj.low    ?? obj.l),
        close:  toNum(obj.close  ?? obj.c),
        volume: toNum(obj.volume ?? obj.vol ?? obj.v ?? 0),
        symbol: typeof obj.symbol === 'string' ? obj.symbol : undefined,
      });
    }
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  const symbol = candles[0]?.symbol;
  return { candles, errors: errors.slice(0, 20), symbol };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timestamp normalizer → Unix ms UTC
// ─────────────────────────────────────────────────────────────────────────────

function parseTimestamp(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!isNaN(n)) {
    // Accept both Unix seconds and Unix milliseconds, but normalize everything
    // to Unix milliseconds so local history and live Bybit candles share one contract.
    return Math.abs(n) < 1e11 ? n * 1000 : n;
  }
  const s = String(raw).trim();
  // Replace space separator with T for ISO parsing
  const d = new Date(s.replace(' ', 'T').replace(/([+-]\d{2}:\d{2})?$/, v => v || 'Z'));
  if (!isNaN(d.getTime())) return d.getTime();
  return null;
}

function toNum(v: unknown): number {
  const n = parseFloat(String(v));
  return isNaN(n) ? 0 : n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeframe auto-detection from candle interval
// ─────────────────────────────────────────────────────────────────────────────

import type { Timeframe } from '../types';
import { TIMEFRAME_MINUTES } from '../engine/calendarEngine';

export function detectTimeframe(candles: RawCandle[]): Timeframe {
  if (candles.length < 2) return '1d';
  // Compute median gap between consecutive candles (skip zero-gaps)
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(candles.length, 50); i++) {
    const g = candles[i].timestamp - candles[i - 1].timestamp;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return '1d';
  gaps.sort((a, b) => a - b);
  const medianMs  = gaps[Math.floor(gaps.length / 2)];
  const medianMin = medianMs / 60_000;

  // Find nearest supported timeframe
  const tfs = Object.entries(TIMEFRAME_MINUTES) as [Timeframe, number][];
  let best: Timeframe = '1d';
  let bestDiff = Infinity;
  for (const [tf, min] of tfs) {
    const diff = Math.abs(min - medianMin);
    if (diff < bestDiff) { bestDiff = diff; best = tf; }
  }
  return best;
}
