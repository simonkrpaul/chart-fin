/**
 * marketStore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * IndexedDB-backed persistent store for multi-market OHLCV + chart layouts.
 *
 * Why IndexedDB (via `idb`)?
 *   • Guaranteed cross-browser support with no WASM init overhead
 *   • Composite indexes make range queries millisecond-fast (2000 bars ≈ 3 ms)
 *   • Storage limits are generous (tens of GB in modern browsers)
 *
 * ── Object stores ────────────────────────────────────────────────────────────
 *   markets   – market metadata (id, label, kind, timezone, continuous)
 *   symbols   – per-symbol metadata (market, symbol, exchange, description)
 *   ohlcv     – individual candles keyed by [market, symbol, timeframe, ts]
 *   layouts   – full chart layout snapshots keyed by id (name is a unique index)
 *   settings  – free-form key/value blobs (e.g. last-selected market/symbol)
 *
 * The `ohlcv` store's composite key gives O(log n) range queries via the
 * `by-series-ts` index, which is what powers the "fast paginated load" the
 * app performs when the user selects a chart.
 */
import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { ChartLayout, ChartTemplate, RawCandle, Timeframe } from '../types';
import type { MarketKind } from '../engine/marketPresets';

const DB_NAME = 'chart-fin-db';
const DB_VERSION = 2;

const TIMEFRAME_MINUTES_LOCAL: Record<Timeframe, number> = {
  '1m': 1, '5m': 5, '10m': 10, '15m': 15, '1h': 60, '4h': 240,
  '1d': 1440, '1w': 10080, '1M': 43200,
};

function _finestTimeframe(a: Timeframe, b: Timeframe): Timeframe {
  return TIMEFRAME_MINUTES_LOCAL[a] <= TIMEFRAME_MINUTES_LOCAL[b] ? a : b;
}

/**
 * Ask the browser to mark our storage as "persistent" so it survives disk
 * pressure eviction. Safe to call repeatedly; a no-op on browsers without
 * the API.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Records
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketRecord {
  id: string;                // 'crypto', 'us_equity', 'asx', ...
  label: string;             // 'Crypto (24/7 UTC)'
  kind: MarketKind;
  timezone: string;
  continuous: boolean;
  createdAt: number;
}

export interface SymbolRecord {
  market: string;
  symbol: string;
  exchange?: string;
  description?: string;
  baseTimeframe: Timeframe;         // finest-grain TF stored for this symbol
  availableTimeframes: Timeframe[]; // every TF with at least one row in ohlcv
  firstTs?: number;
  lastTs?: number;
  candleCount?: number;
  updatedAt: number;
}

/**
 * A single OHLCV bar, stored one row per candle. The composite key
 * `[market, symbol, timeframe, timestamp]` uniquely identifies each row and
 * gives us upsert semantics via `put`.
 */
export interface OhlcvRecord {
  market: string;
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;   // Unix ms UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ChartFinDB extends DBSchema {
  markets: {
    key: string;
    value: MarketRecord;
  };
  symbols: {
    key: [string, string]; // [market, symbol]
    value: SymbolRecord;
    indexes: { 'by-market': string };
  };
  ohlcv: {
    key: [string, string, Timeframe, number]; // [market, symbol, tf, ts]
    value: OhlcvRecord;
    indexes: {
      'by-series-ts': [string, string, Timeframe, number];
    };
  };
  layouts: {
    key: string;
    value: ChartLayout;
    indexes: { 'by-name': string; 'by-updated': number };
  };
  templates: {
    key: string;
    value: ChartTemplate;
    indexes: { 'by-name': string; 'by-updated': number };
  };
  settings: {
    key: string;
    value: { key: string; value: unknown; updatedAt: number };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DB singleton
// ─────────────────────────────────────────────────────────────────────────────

let _dbPromise: Promise<IDBPDatabase<ChartFinDB>> | null = null;

/** Reject if `p` doesn't settle within `ms`. Used to prevent IDB from
 *  hanging the whole app when the browser's IDB subsystem is stuck
 *  (held upgrade lock, aborted-transaction state, etc.). */
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[marketStore] ${tag} timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(timer); resolve(v); },
           e => { clearTimeout(timer); reject(e); });
  });
}

export function getDB(): Promise<IDBPDatabase<ChartFinDB>> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = withTimeout(
    openDB<ChartFinDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('markets')) {
          db.createObjectStore('markets', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('symbols')) {
          const s = db.createObjectStore('symbols', { keyPath: ['market', 'symbol'] });
          s.createIndex('by-market', 'market');
        }
        if (!db.objectStoreNames.contains('ohlcv')) {
          const o = db.createObjectStore('ohlcv', {
            keyPath: ['market', 'symbol', 'timeframe', 'timestamp'],
          });
          // Range queries: WHERE market=? AND symbol=? AND tf=? AND ts BETWEEN ? AND ?
          o.createIndex('by-series-ts', ['market', 'symbol', 'timeframe', 'timestamp']);
        }
        if (!db.objectStoreNames.contains('layouts')) {
          const l = db.createObjectStore('layouts', { keyPath: 'id' });
          l.createIndex('by-name', 'name', { unique: true });
          l.createIndex('by-updated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('templates')) {
          const t = db.createObjectStore('templates', { keyPath: 'id' });
          t.createIndex('by-name', 'name', { unique: true });
          t.createIndex('by-updated', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      },
      // Fires if another tab holds an older-version connection open and
      // blocks our upgrade. Logging + letting the timeout take over is
      // better than silently waiting forever.
      blocked() {
        // eslint-disable-next-line no-console
        console.warn('[marketStore] IDB open blocked — another tab is holding an older version. Close other tabs or hard-refresh.');
      },
      // Fires when WE hold an older version while a newer tab tries to
      // upgrade. Drop our handle so the other tab can proceed.
      blocking() {
        // eslint-disable-next-line no-console
        console.warn('[marketStore] IDB connection blocking another tab — closing.');
        _dbPromise?.then(db => db.close()).catch(() => { /* ignore */ });
        _dbPromise = null;
      },
      // Fires if the DB connection is force-terminated (browser restart,
      // tab OOM, etc). Clear the cached promise so the next call reconnects.
      terminated() {
        // eslint-disable-next-line no-console
        console.warn('[marketStore] IDB connection terminated — will reconnect on next call.');
        _dbPromise = null;
      },
    }),
    8_000,
    'openDB',
  ).catch(err => {
    // Clear the cache so a future call retries instead of latching into
    // the rejected promise forever.
    _dbPromise = null;
    throw err;
  });
  return _dbPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markets
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertMarket(m: Omit<MarketRecord, 'createdAt'>): Promise<void> {
  const db = await getDB();
  const existing = await db.get('markets', m.id);
  await db.put('markets', { ...m, createdAt: existing?.createdAt ?? Date.now() });
}

export async function listMarkets(): Promise<MarketRecord[]> {
  const db = await getDB();
  return db.getAll('markets');
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbols
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertSymbol(s: Omit<SymbolRecord, 'updatedAt' | 'availableTimeframes'> & { availableTimeframes?: Timeframe[] }): Promise<void> {
  const db = await getDB();
  const existing = await db.get('symbols', [s.market, s.symbol]);
  const merged: SymbolRecord = {
    ...s,
    availableTimeframes: s.availableTimeframes ?? existing?.availableTimeframes ?? [],
    updatedAt: Date.now(),
  };
  await db.put('symbols', merged);
}

export async function listSymbols(market: string): Promise<SymbolRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('symbols', 'by-market', market);
}

export async function getSymbol(market: string, symbol: string): Promise<SymbolRecord | undefined> {
  const db = await getDB();
  return db.get('symbols', [market, symbol]);
}

// ─────────────────────────────────────────────────────────────────────────────
// OHLCV bulk operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upsert a batch of candles for a single (market, symbol, timeframe) series.
 *
 * Performance notes
 * ─────────────────
 *   • We do NOT await each `put` – idb pipelines them through the same tx and
 *     that alone is a 100× speed-up over awaiting per row (a 500k-row CSV
 *     drops from minutes to a few seconds).
 *   • Very large arrays are split into `CHUNK` transactions so the UI can
 *     interleave reads (chart pans) between chunks.
 */
const SAVE_CHUNK_SIZE = 50_000;

export interface SaveProgress {
  saved: number;
  total: number;
  chunkMs: number;
}

export async function saveCandles(
  market: string,
  symbol: string,
  timeframe: Timeframe,
  candles: RawCandle[],
  onProgress?: (p: SaveProgress) => void,
): Promise<void> {
  if (candles.length === 0) return;
  const db = await getDB();

  let saved = 0;
  for (let start = 0; start < candles.length; start += SAVE_CHUNK_SIZE) {
    const chunk = candles.slice(start, start + SAVE_CHUNK_SIZE);
    const t0 = performance.now();
    const tx = db.transaction('ohlcv', 'readwrite');
    const ohlcvStore = tx.objectStore('ohlcv');
    for (const c of chunk) {
      // Fire-and-forget within the tx – idb queues them for us.
      void ohlcvStore.put({
        market, symbol, timeframe,
        timestamp: c.timestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume,
      });
    }
    await tx.done;
    saved += chunk.length;
    onProgress?.({ saved, total: candles.length, chunkMs: performance.now() - t0 });
  }

  // Refresh the symbol range metadata once at the end.
  const sortedTs = candles.map(c => c.timestamp).sort((a, b) => a - b);
  const first = sortedTs[0];
  const last = sortedTs[sortedTs.length - 1];
  const tx2 = db.transaction('symbols', 'readwrite');
  const symStore = tx2.objectStore('symbols');
  const existing = await symStore.get([market, symbol]);
  const availableSet = new Set<Timeframe>(existing?.availableTimeframes ?? []);
  availableSet.add(timeframe);
  const finestSoFar = existing?.baseTimeframe ?? timeframe;
  const merged: SymbolRecord = {
    market,
    symbol,
    baseTimeframe: _finestTimeframe(finestSoFar, timeframe),
    availableTimeframes: Array.from(availableSet),
    firstTs: existing?.firstTs === undefined ? first : Math.min(existing.firstTs, first),
    lastTs: existing?.lastTs === undefined ? last : Math.max(existing.lastTs, last),
    candleCount: (existing?.candleCount ?? 0) + candles.length,
    exchange: existing?.exchange,
    description: existing?.description,
    updatedAt: Date.now(),
  };
  await symStore.put(merged);
  await tx2.done;
}

/**
 * Paginated range query — the primary read path for chart loading.
 *
 * Returns up to `limit` candles for the given series where
 * `fromMs <= ts <= toMs`. When `direction === 'desc'` it returns the most
 * recent bars first (used for the initial 2000-bar load).
 *
 * Performance: with no `limit` (used by "Load entire history"), we use
 * `store.index.getAll(range)` which fetches every matching row in a single
 * native call — ~50× faster than cursor iteration for 1 M+ row scans.
 * When `limit` is set we cursor-iterate so we can stop early.
 */
export async function getCandles(opts: {
  market: string;
  symbol: string;
  timeframe: Timeframe;
  fromMs?: number;
  toMs?: number;
  limit?: number;
  direction?: 'asc' | 'desc';
}): Promise<RawCandle[]> {
  const { market, symbol, timeframe, fromMs, toMs, limit, direction = 'asc' } = opts;
  const db = await getDB();

  const lower: [string, string, Timeframe, number] = [
    market, symbol, timeframe, fromMs ?? -Infinity,
  ];
  const upper: [string, string, Timeframe, number] = [
    market, symbol, timeframe, toMs ?? Infinity,
  ];
  const range = IDBKeyRange.bound(lower, upper);
  const idx = db.transaction('ohlcv').store.index('by-series-ts');

  // Fast bulk path: no per-row awaits. `direction` only matters when a
  // `limit` is set (to pick the tail vs the head); with no limit we return
  // every matching row, and the renderer always needs ascending order.
  if (!limit) {
    const rows = await idx.getAll(range);
    const out: RawCandle[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i];
      out[i] = {
        timestamp: v.timestamp,
        open: v.open, high: v.high, low: v.low, close: v.close,
        volume: v.volume,
        symbol: v.symbol,
      };
    }
    return out;
  }

  // Bounded path. Two scenarios, both avoid the row-by-row cursor loop
  // (microtask storm) and the "slice tail of full getAll" (OOM for big series).
  //
  // direction='asc'  → IDB's native `getAll(range, count)` limits natively.
  // direction='desc' → read how many rows are in the range, then open a
  //                    cursor and `advance` the surplus in ONE call, then
  //                    `getAll` from that anchor forward. 3 round-trips
  //                    total, independent of how big the series is.
  if (direction === 'asc') {
    const rows = await idx.getAll(range, limit);
    const out: RawCandle[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i];
      out[i] = {
        timestamp: v.timestamp,
        open: v.open, high: v.high, low: v.low, close: v.close,
        volume: v.volume,
        symbol: v.symbol,
      };
    }
    return out;
  }

  // direction='desc'
  const total = await idx.count(range);
  if (total <= limit) {
    const rows = await idx.getAll(range);
    const out: RawCandle[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i];
      out[i] = {
        timestamp: v.timestamp,
        open: v.open, high: v.high, low: v.low, close: v.close,
        volume: v.volume,
        symbol: v.symbol,
      };
    }
    return out;
  }
  // Skip (total - limit) rows via a single `advance` call, then bulk-read
  // the rest. Avoids both the OOM full-range read AND the cursor loop.
  const skip = total - limit;
  const startCursor = await idx.openCursor(range, 'next');
  if (!startCursor) return [];
  const anchor = skip > 0 ? await startCursor.advance(skip) : startCursor;
  if (!anchor) return [];
  const anchorTs = anchor.value.timestamp;
  const upperTs = toMs ?? Infinity;
  const anchoredRange = IDBKeyRange.bound(
    [market, symbol, timeframe, anchorTs],
    [market, symbol, timeframe, upperTs],
  );
  const rows = await idx.getAll(anchoredRange);
  const out: RawCandle[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i];
    out[i] = {
      timestamp: v.timestamp,
      open: v.open, high: v.high, low: v.low, close: v.close,
      volume: v.volume,
      symbol: v.symbol,
    };
  }
  return out;
}

/**
 * Fast metadata query used to decide how much data to backfill on pan-left.
 * Returns the earliest and latest timestamp stored for the series.
 */
export async function getSeriesRange(
  market: string,
  symbol: string,
  timeframe: Timeframe,
): Promise<{ firstTs: number | null; lastTs: number | null; count: number }> {
  const db = await getDB();
  const idx = db.transaction('ohlcv').store.index('by-series-ts');
  const range = IDBKeyRange.bound(
    [market, symbol, timeframe, -Infinity],
    [market, symbol, timeframe, Infinity],
  );
  const first = await idx.openCursor(range, 'next');
  const firstTs = first?.value.timestamp ?? null;
  const last = await idx.openCursor(range, 'prev');
  const lastTs = last?.value.timestamp ?? null;
  const count = await idx.count(range);
  return { firstTs, lastTs, count };
}

/** Delete every candle in a series. Rarely needed — mostly for tests. */
export async function deleteSeries(
  market: string,
  symbol: string,
  timeframe: Timeframe,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['ohlcv', 'symbols'], 'readwrite');
  const range = IDBKeyRange.bound(
    [market, symbol, timeframe, -Infinity],
    [market, symbol, timeframe, Infinity],
  );
  let cursor = await tx.objectStore('ohlcv').openCursor(range);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Wipe every cached candle + symbol-range metadata.
 *
 * Used by the picker's "↻ Rescan disk" action so the next series open
 * re-reads from CSV (useful after `scripts/mt5_sync.py` writes fresher
 * bars than what's sitting in IDB). Layouts, markets, and settings are
 * preserved — only the OHLCV cache + symbol stats are cleared.
 */
export async function clearCandleCache(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['ohlcv', 'symbols'], 'readwrite');
  await tx.objectStore('ohlcv').clear();
  await tx.objectStore('symbols').clear();
  await tx.done;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layouts (chart snapshots)
// ─────────────────────────────────────────────────────────────────────────────

export async function saveLayoutDb(layout: ChartLayout): Promise<void> {
  const db = await getDB();
  await db.put('layouts', { ...layout, updatedAt: Date.now() });
}

export async function getLayoutDb(id: string): Promise<ChartLayout | undefined> {
  const db = await getDB();
  return db.get('layouts', id);
}

export async function getLayoutByNameDb(name: string): Promise<ChartLayout | undefined> {
  const db = await getDB();
  return db.getFromIndex('layouts', 'by-name', name);
}

export async function listLayoutsDb(): Promise<ChartLayout[]> {
  const db = await getDB();
  const all = await db.getAll('layouts');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteLayoutDb(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('layouts', id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates (series-agnostic analysis presets — see ChartTemplate type)
// ─────────────────────────────────────────────────────────────────────────────

export async function saveTemplateDb(tpl: ChartTemplate): Promise<void> {
  const db = await getDB();
  await db.put('templates', { ...tpl, updatedAt: Date.now() });
}

export async function getTemplateDb(id: string): Promise<ChartTemplate | undefined> {
  const db = await getDB();
  return db.get('templates', id);
}

export async function getTemplateByNameDb(name: string): Promise<ChartTemplate | undefined> {
  const db = await getDB();
  return db.getFromIndex('templates', 'by-name', name);
}

export async function listTemplatesDb(): Promise<ChartTemplate[]> {
  const db = await getDB();
  const all = await db.getAll('templates');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteTemplateDb(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('templates', id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Free-form settings (e.g. last selected market / symbol / TF)
// ─────────────────────────────────────────────────────────────────────────────

export async function setSetting(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put('settings', { key, value, updatedAt: Date.now() });
}

export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  const db = await getDB();
  const rec = await db.get('settings', key);
  return rec?.value as T | undefined;
}
