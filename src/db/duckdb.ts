/**
 * duckdb.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Optional DuckDB-WASM SQL layer for heavy analytical queries.
 *
 * The primary persistent store is IndexedDB (`./marketStore.ts`). DuckDB is
 * hydrated on demand from that store so users get SQL/columnar analytics
 * without depending on the WASM module being reachable at startup.
 *
 * If DuckDB WASM fails to initialise (module URL blocked, offline first
 * load, etc.) every function here degrades gracefully — the caller falls
 * back to plain IndexedDB queries in `./marketDb.ts`.
 */
import * as duckdb from '@duckdb/duckdb-wasm';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { RawCandle, Timeframe } from '../types';
import { getCandles } from './marketStore';

let _db: AsyncDuckDB | null = null;
let _conn: AsyncDuckDBConnection | null = null;
let _initPromise: Promise<AsyncDuckDB | null> | null = null;
const _hydratedSeries = new Set<string>();

function seriesKey(market: string, symbol: string, timeframe: Timeframe): string {
  return `${market}::${symbol}::${timeframe}`;
}

function seriesTable(market: string, symbol: string, timeframe: Timeframe): string {
  // sanitise identifiers – DuckDB is picky about odd chars
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
  return `ohlcv_${safe(market)}_${safe(symbol)}_${safe(timeframe)}`;
}

/**
 * Initialise DuckDB WASM. Returns null if init fails (safe to call again;
 * subsequent calls will retry).
 */
export async function initDuckDB(): Promise<AsyncDuckDB | null> {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const bundles = duckdb.getJsDelivrBundles();
      const bundle = await duckdb.selectBundle(bundles);
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker!}");`], {
          type: 'text/javascript',
        }),
      );
      const worker = new Worker(workerUrl);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      _db = db;
      _conn = await db.connect();
      return db;
    } catch (e) {
      // Init failed – caller falls back to plain IndexedDB.
      // eslint-disable-next-line no-console
      console.warn('[duckdb] init failed – analytical layer disabled', e);
      _db = null;
      _conn = null;
      return null;
    } finally {
      _initPromise = null;
    }
  })();

  return _initPromise;
}

export function isDuckDbReady(): boolean {
  return _db !== null && _conn !== null;
}

/**
 * Populate the DuckDB table for one series from IndexedDB. No-op if the
 * series is already hydrated in this session.
 */
export async function hydrateSeries(
  market: string,
  symbol: string,
  timeframe: Timeframe,
): Promise<boolean> {
  const key = seriesKey(market, symbol, timeframe);
  if (_hydratedSeries.has(key)) return true;
  const db = await initDuckDB();
  if (!db || !_conn) return false;

  const candles = await getCandles({ market, symbol, timeframe });
  if (candles.length === 0) {
    _hydratedSeries.add(key);
    return true;
  }

  const table = seriesTable(market, symbol, timeframe);
  await _conn.query(`DROP TABLE IF EXISTS ${table}`);
  await _conn.query(`
    CREATE TABLE ${table} (
      ts BIGINT PRIMARY KEY,
      open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE
    )
  `);

  // Batch insert via Arrow-like JSON — fastest path in duckdb-wasm without
  // extra deps. For very large series (>100k rows) prefer Parquet ingest.
  const stmt = await _conn.prepare(
    `INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?)`,
  );
  try {
    for (const c of candles) {
      await stmt.query(
        c.timestamp, c.open, c.high, c.low, c.close, c.volume,
      );
    }
  } finally {
    await stmt.close();
  }
  _hydratedSeries.add(key);
  return true;
}

/**
 * Run an arbitrary SQL query against DuckDB. Returns an array of plain
 * objects. Throws if DuckDB is not initialised.
 */
export async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  if (!_conn) {
    const db = await initDuckDB();
    if (!db || !_conn) throw new Error('DuckDB not available');
  }
  const result = await _conn!.query(query);
  return result.toArray().map((row) => row.toJSON()) as T[];
}

/**
 * Range query via DuckDB. Falls back to IndexedDB if DuckDB is unavailable
/**
 * Range query.
 *
 * IMPORTANT: This delegates to IndexedDB via `getCandles`. The DuckDB path
 * was scaffolded but the `hydrateSeries` insert loop is O(N) sequential
 * awaits, which freezes the browser on any series > 100 k rows (e.g. AAPL 1m
 * ~1.5 M bars = many minutes of frozen UI). IndexedDB range queries on the
 * `by-series-ts` composite index return 2 000 bars in ~3 ms and every-bar
 * scans in ~1-2 s, so DuckDB is unnecessary overhead for chart loading.
 *
 * DuckDB remains initialisable via `initDuckDB()` and usable via `sql()` for
 * ad-hoc analytical queries where SQL is convenient.
 */
export async function queryCandles(opts: {
  market: string;
  symbol: string;
  timeframe: Timeframe;
  fromMs?: number;
  toMs?: number;
  limit?: number;
  direction?: 'asc' | 'desc';
}): Promise<RawCandle[]> {
  return getCandles(opts);
}

/** Mark the DuckDB copy stale so the next query re-hydrates from IndexedDB. */
export function invalidateSeries(market: string, symbol: string, timeframe: Timeframe): void {
  _hydratedSeries.delete(seriesKey(market, symbol, timeframe));
}
