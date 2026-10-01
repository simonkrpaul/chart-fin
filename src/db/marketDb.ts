/**
 * marketDb.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * High-level facade over `marketStore` (IndexedDB) + CSV manifest fallback.
 *
 * Public surface:
 *   • ensureMarkets()              – seeds preset markets into the DB
 *   • ingestManifest(url?)         – bulk-loads CSVs listed in a manifest
 *   • loadInitialCandles()         – fast tail query (last N bars) for chart start
 *   • loadCandlesBefore()          – lazy backfill on pan-left
 *   • saveCandlesForSeries()       – used by uploads / API pulls
 *   • listMarketsWithCounts()      – for the picker UI
 *
 * The manifest is a static JSON file shipped in `public/data/markets/` that
 * lists every CSV bundled with the app. Python scripts (`import_market.py`,
 * `mock_data.py`) write to that folder and rebuild the manifest so the
 * browser can bootstrap without contacting a server.
 */
import type { RawCandle, Timeframe } from '../types';
import { parseOHLCVFile } from '../utils/dataParser';
import { MARKET_PRESET_LIST, getMarketPreset } from '../engine/marketPresets';
import { canResample, resampleCandles, filterBySessionHours } from '../engine/resampleEngine';
import { TIMEFRAME_MINUTES } from '../engine/calendarEngine';
import * as store from './marketStore';
import { getCandles as queryCandles } from './marketStore';

const MANIFEST_URL_DEFAULT = '/data/markets/manifest.json';
const INITIAL_BAR_COUNT = 2000;
const BACKFILL_BAR_COUNT = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Manifest schema
// ─────────────────────────────────────────────────────────────────────────────

export interface ManifestSource {
  market: string;
  symbol: string;
  timeframe: Timeframe;
  url: string;
  exchange?: string;
  description?: string;
}

export interface Manifest {
  version: number;
  generatedAt: string;
  sources: ManifestSource[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest cache — in-memory, fetched once, refreshable on demand
//
// The manifest is the SOURCE OF TRUTH for what data exists. IndexedDB is
// a pure cache layer: if it hits, great; if it misses, we fetch the CSV
// straight off disk. This is why the picker and the load path both go
// through _getManifestUrl() rather than trusting the IDB's availableTimeframes.
// ─────────────────────────────────────────────────────────────────────────────

let _manifestPromise: Promise<Manifest | null> | null = null;
let _manifestByKey: Map<string, ManifestSource> | null = null;

const seriesKey = (market: string, symbol: string, tf: Timeframe) =>
  `${market}::${symbol}::${tf}`;

async function _fetchManifest(url: string): Promise<Manifest | null> {
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[manifest] fetch ${url} → HTTP ${resp.status}`);
      return null;
    }
    const m = (await resp.json()) as Manifest;
    // eslint-disable-next-line no-console
    console.info(`[manifest] fetched ${m.sources?.length ?? 0} series (generatedAt=${m.generatedAt})`);
    return m;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[manifest] fetch ${url} failed`, err);
    return null;
  }
}

/**
 * Fetch (and cache) the manifest. Idempotent; concurrent callers share one
 * in-flight fetch. Call `refreshManifest()` after a downloader script runs
 * to invalidate.
 */
export async function getManifest(url: string = MANIFEST_URL_DEFAULT): Promise<Manifest | null> {
  if (_manifestPromise) {
    const cached = await _manifestPromise;
    // If a prior boot-time call cached a null (e.g. Vite not yet ready /
    // transient 404), don't keep returning null forever — re-fetch.
    if (cached) return cached;
    _manifestPromise = null;
  }
  _manifestPromise = _fetchManifest(url).then(m => {
    if (m) {
      _manifestByKey = new Map(
        m.sources.map(s => [seriesKey(s.market, s.symbol, s.timeframe), s]),
      );
    }
    return m;
  });
  return _manifestPromise;
}

/** Force a fresh manifest fetch on next call. */
export function refreshManifest(): void {
  _manifestPromise = null;
  _manifestByKey = null;
}

/** Manifest entry for (market, symbol, timeframe) or null if not advertised. */
export async function getManifestSource(
  market: string, symbol: string, tf: Timeframe,
): Promise<ManifestSource | null> {
  await getManifest();
  return _manifestByKey?.get(seriesKey(market, symbol, tf)) ?? null;
}

/**
 * All timeframes the manifest advertises for a symbol. Returns finest-first
 * (1m before 5m before 1h etc.), so `[0]` is the ideal resample source.
 */
export async function getManifestTimeframes(
  market: string, symbol: string,
): Promise<{ timeframe: Timeframe; url: string; exchange?: string; description?: string }[]> {
  const m = await getManifest();
  if (!m) return [];
  return m.sources
    .filter(s => s.market === market && s.symbol === symbol)
    .sort((a, b) => TIMEFRAME_MINUTES[a.timeframe] - TIMEFRAME_MINUTES[b.timeframe])
    .map(s => ({
      timeframe: s.timeframe, url: s.url,
      exchange: s.exchange, description: s.description,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

/** Ensure every preset market exists as a row in the markets store. */
export async function ensureMarkets(): Promise<void> {
  for (const preset of MARKET_PRESET_LIST) {
    await store.upsertMarket({
      id: preset.id,
      label: preset.label,
      kind: preset.kind,
      timezone: preset.timezone,
      continuous: preset.continuous,
    });
  }
}

/**
 * Fetch the manifest and ingest any sources that are not yet stored.
 *
 * Boot-safe: pass `background: true` to yield to the event loop between each
 * series so the app stays responsive. Fetches run with limited concurrency
 * (default 8-way).
 *
 * Cache: skips entirely when the manifest's `generatedAt` matches what was
 * last successfully ingested. Set `force: true` to override.
 *
 * Progress: dispatches `window` events `manifest-ingest-progress` with
 * `{ processed, total, phase, message }` so UI can render a badge.
 */
const KEY_MANIFEST_CACHE = 'manifestIngestedAt';

// Single-flight guard: multiple concurrent callers (boot effect firing twice
// under StrictMode, Rescan button, etc.) share one in-flight run instead of
// racing on the same 500 CSVs.
let _ingestInFlight: Promise<ManifestSource[]> | null = null;

export async function ingestManifest(
  url: string = MANIFEST_URL_DEFAULT,
  opts: { force?: boolean; concurrency?: number; background?: boolean } = {},
): Promise<ManifestSource[]> {
  if (_ingestInFlight && !opts.force) {
    // eslint-disable-next-line no-console
    console.info('[ingestManifest] joining in-flight run');
    return _ingestInFlight;
  }
  _ingestInFlight = _ingestManifestImpl(url, opts);
  try {
    return await _ingestInFlight;
  } finally {
    _ingestInFlight = null;
  }
}

async function _ingestManifestImpl(
  url: string,
  opts: { force?: boolean; concurrency?: number; background?: boolean },
): Promise<ManifestSource[]> {
  const concurrency = Math.max(1, opts.concurrency ?? (opts.background ? 3 : 8));
  let manifest: Manifest;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];
    manifest = await resp.json();
  } catch {
    return [];
  }

  const cached = await store.getSetting<string>(KEY_MANIFEST_CACHE);
  if (!opts.force && cached === manifest.generatedAt) {
    // eslint-disable-next-line no-console
    console.info('[ingestManifest] cache hit — skipping', { generatedAt: manifest.generatedAt });
    return [];
  }

  const total = manifest.sources.length;
  const ingested: ManifestSource[] = [];
  let processed = 0;

  const emit = (extra: Record<string, unknown> = {}) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('manifest-ingest-progress', {
        detail: { processed, total, ...extra },
      }));
    }
  };
  emit({ phase: 'start', message: `Ingesting ${total} series…` });

  const ingestOne = async (src: ManifestSource): Promise<void> => {
    try {
      const existing = await store.getSymbol(src.market, src.symbol);
      const knownRange = (existing && existing.availableTimeframes?.includes(src.timeframe))
        ? await store.getSeriesRange(src.market, src.symbol, src.timeframe)
        : null;

      const resp = await fetch(src.url);
      if (!resp.ok) return;
      const text = await resp.text();
      const file = new File([text], src.url.split('/').pop() ?? 'data.csv', { type: 'text/csv' });
      const { candles } = await parseOHLCVFile(file);
      if (candles.length === 0) return;

      // Delta ingest: only write rows outside the existing range.
      let toWrite = candles;
      if (knownRange && knownRange.firstTs !== null && knownRange.lastTs !== null && !opts.force) {
        const first = knownRange.firstTs;
        const last  = knownRange.lastTs;
        toWrite = candles.filter(c => c.timestamp < first || c.timestamp > last);
        if (toWrite.length === 0) return;
      }

      await store.upsertSymbol({
        market: src.market,
        symbol: src.symbol,
        exchange: src.exchange,
        description: src.description,
        baseTimeframe: src.timeframe,
      });
      await store.saveCandles(src.market, src.symbol, src.timeframe, toWrite);
      ingested.push(src);
    } catch {
      // Best-effort — skip unreadable source and move on.
    }
  };

  // Concurrent worker pool.
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < manifest.sources.length) {
      const idx = cursor++;
      const src = manifest.sources[idx];
      await ingestOne(src);
      processed++;
      emit({ phase: 'progress', message: `${src.market}/${src.symbol}` });
      if (opts.background) {
        // Yield after every symbol so picker interactions stay snappy.
        await new Promise(r => setTimeout(r, 0));
      }
    }
  });
  await Promise.all(workers);

  await store.setSetting(KEY_MANIFEST_CACHE, manifest.generatedAt);
  emit({ phase: 'done', message: `Ingested ${ingested.length} of ${total}` });
  // eslint-disable-next-line no-console
  console.info('[ingestManifest] done', {
    total, ingested: ingested.length, generatedAt: manifest.generatedAt,
  });
  return ingested;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart-loading paths
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadedCandles {
  candles: RawCandle[];
  /** Which timeframe was actually read from the DB (may differ from requested when resampled). */
  sourceTimeframe: Timeframe;
  /** True when the requested TF was derived from a finer one via resampling. */
  resampled: boolean;
}

const ALL_TIMEFRAMES: Timeframe[] = ['1m', '5m', '10m', '15m', '1h', '4h', '1d', '1w', '1M'];

/** Pick the finest stored TF that can resample up to `requested`. */
function pickSourceTimeframe(
  requested: Timeframe,
  available: Timeframe[],
): Timeframe | null {
  if (available.includes(requested)) return requested;
  // Prefer the finest resamplable source (highest fidelity).
  const candidates = available
    .filter(tf => canResample(tf, requested))
    .sort((a, b) => TIMEFRAME_MINUTES[a] - TIMEFRAME_MINUTES[b]);
  return candidates[0] ?? null;
}

/**
 * Fetch a CSV and parse it fully (keep every row). Streams the response
 * body line-by-line so we never buffer the whole text as a 300 MB+ JS
 * string. The parsed candle array itself is still big (~800 MB for a
 * 7 M-row 1m file) — if memory matters, call `_fetchCsvCandlesTail`
 * with a bounded `maxRows` instead.
 */
async function _fetchCsvCandles(url: string): Promise<RawCandle[]> {
  return _streamCsvCandles(url, { maxRows: Infinity });
}

async function _fetchCsvCandlesTail(url: string, maxRows: number): Promise<RawCandle[]> {
  return _streamCsvCandles(url, { maxRows });
}

/**
 * One streaming CSV parser used by both the full-load and tail-load paths.
 * When `opts.maxRows` is finite, a ring buffer keeps only the newest N rows.
 * When Infinity, every row is appended to an unbounded array.
 *
 * Assumes the canonical schema (`timestamp,open,high,low,close,volume`
 * with Unix ms UTC timestamps). Falls back to a comma delimiter if the
 * header uses a different one.
 */
async function _streamCsvCandles(
  url: string,
  opts: { maxRows: number },
): Promise<RawCandle[]> {
  const { maxRows } = opts;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  if (!resp.body) {
    // No streaming support — buffered fetch is the only option.
    const text = await resp.text();
    const filename = url.split('/').pop() ?? 'data.csv';
    const file = new File([text], filename, { type: 'text/csv' });
    const { candles } = await parseOHLCVFile(file);
    return isFinite(maxRows) ? candles.slice(Math.max(0, candles.length - maxRows)) : candles;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const bounded = isFinite(maxRows);
  const ring: (RawCandle | null)[] | null = bounded ? new Array(maxRows).fill(null) : null;
  const unbounded: RawCandle[] | null = bounded ? null : [];
  let head = 0;
  let filled = 0;

  let buf = '';
  let headerParsed = false;
  let delim = ',';
  let tsCol = 0, oCol = 1, hCol = 2, lCol = 3, cCol = 4, vCol = 5;

  const acceptLine = (line: string): void => {
    if (!line) return;
    if (!headerParsed) {
      delim = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
      const headers = line.split(delim).map(h => h.trim().toLowerCase());
      const idx = (names: string[]) => {
        for (const n of names) { const i = headers.indexOf(n); if (i !== -1) return i; }
        return -1;
      };
      tsCol = idx(['timestamp','time','date','datetime','t','ts']);
      oCol  = idx(['open','o']);
      hCol  = idx(['high','h']);
      lCol  = idx(['low','l']);
      cCol  = idx(['close','c']);
      vCol  = idx(['volume','vol','v']);
      headerParsed = true;
      return;
    }
    const cells = line.split(delim);
    if (cells.length < 5) return;
    const rawTs = cells[tsCol];
    let ts: number;
    if (/^\d+$/.test(rawTs)) {
      ts = Number(rawTs);
      if (ts < 1e12) ts *= 1000; // Unix seconds → ms
    } else {
      const parsed = Date.parse(rawTs);
      if (isNaN(parsed)) return;
      ts = parsed;
    }
    const open  = parseFloat(cells[oCol]);
    const high  = parseFloat(cells[hCol]);
    const low   = parseFloat(cells[lCol]);
    const close = parseFloat(cells[cCol]);
    if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) return;
    const volume = vCol >= 0 && cells[vCol] ? parseFloat(cells[vCol]) || 0 : 0;

    const candle: RawCandle = { timestamp: ts, open, high, low, close, volume };
    if (unbounded !== null) {
      unbounded.push(candle);
    } else {
      ring![head] = candle;
      head = (head + 1) % maxRows;
      if (filled < maxRows) filled++;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // Walk the chunk with a cursor instead of re-slicing `buf` per line.
    // The old `buf = buf.slice(idx + 1)` on every iteration copied the full
    // remaining buffer for each line — O(N²) in chunk size and the direct
    // cause of OOM crashes on multi-year streaming parses.
    let start = 0;
    let idx = buf.indexOf('\n', start);
    while (idx >= 0) {
      // Trim a trailing \r by narrowing the end instead of allocating a new string.
      const end = idx > start && buf.charCodeAt(idx - 1) === 13 ? idx - 1 : idx;
      if (end > start) acceptLine(buf.substring(start, end));
      start = idx + 1;
      idx = buf.indexOf('\n', start);
    }
    // Keep only the unconsumed tail (one slice per chunk, not per line).
    buf = start < buf.length ? buf.substring(start) : '';
  }
  // Flush any trailing partial line (last row without newline).
  const last = buf.trim();
  if (last) acceptLine(last);

  // Materialize the result.
  if (unbounded !== null) return unbounded;
  const out: RawCandle[] = new Array(filled);
  const start = filled < maxRows ? 0 : head;
  for (let i = 0; i < filled; i++) {
    out[i] = ring![(start + i) % maxRows]!;
  }
  return out;
}

/**
 * Write freshly-parsed candles into IndexedDB in the background so the next
 * open of this series can use the fast DB path. Errors are swallowed —
 * writeback is best-effort and must never block the chart from opening.
 */
function _writebackCandles(
  market: string, symbol: string, timeframe: Timeframe,
  candles: RawCandle[], src: ManifestSource,
): void {
  if (candles.length === 0) return;
  queueMicrotask(async () => {
    try {
      await store.upsertSymbol({
        market, symbol,
        exchange: src.exchange,
        description: src.description,
        baseTimeframe: timeframe,
      });
      await store.saveCandles(market, symbol, timeframe, candles);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[marketDb] writeback for ${market}/${symbol}@${timeframe} failed`, err);
    }
  });
}

/**
 * Pick the best source timeframe from what's advertised in the manifest.
 * Prefers the requested TF if available, else the finest coarser TF that
 * can be resampled UP to it.
 */
async function _pickManifestSource(
  market: string, symbol: string, requested: Timeframe,
): Promise<{ tf: Timeframe; src: ManifestSource } | null> {
  const tfs = await getManifestTimeframes(market, symbol);
  if (tfs.length === 0) return null;
  // Exact match wins.
  const exact = tfs.find(t => t.timeframe === requested);
  if (exact) return { tf: exact.timeframe, src: await getManifestSource(market, symbol, exact.timeframe) as ManifestSource };
  // Otherwise the finest TF that can resample UP to `requested`.
  const finest = tfs.find(t => canResample(t.timeframe, requested));
  if (!finest) return null;
  const src = await getManifestSource(market, symbol, finest.timeframe);
  return src ? { tf: finest.timeframe, src } : null;
}

/**
 * Load candles for (market, symbol, timeframe).
 *
 *   1. Try IndexedDB (cache hit → fast path, < 100 ms).
 *   2. On miss, fetch the CSV straight from the manifest URL and parse it
 *      (~500 ms for a 100 K-row file). Optionally write the result back
 *      to IDB in the background so the next open is fast.
 *   3. If neither IDB nor the manifest has the series, return empty.
 *
 * The CSV is the source of truth. IndexedDB is a pure cache — its state
 * can never block a load.
 */
export async function loadInitialCandles(
  market: string,
  symbol: string,
  timeframe: Timeframe,
  count: number = INITIAL_BAR_COUNT,
): Promise<LoadedCandles> {
  const preset = getMarketPreset(market);
  const loadAll = !Number.isFinite(count);

  // ── Fast path: IndexedDB cache hit ────────────────────────────────────
  // All IDB calls are wrapped in try/catch: a broken IDB (hung openDB,
  // aborted transaction after a tab OOM crash, etc.) must never block
  // the chart from loading — we just fall through to CSV.
  let sym: store.SymbolRecord | undefined;
  try {
    sym = await store.getSymbol(market, symbol);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[loadInitialCandles] IDB getSymbol(${market}, ${symbol}) failed — falling through to CSV`, err);
    sym = undefined;
  }
  const available = sym?.availableTimeframes ?? [];
  const dbSourceTf = pickSourceTimeframe(timeframe, available);
  if (dbSourceTf) {
    const ratio = TIMEFRAME_MINUTES[timeframe] / TIMEFRAME_MINUTES[dbSourceTf];
    const rawLimit = loadAll
      ? undefined
      : dbSourceTf === timeframe ? count : Math.ceil(count * ratio);
    let rows: RawCandle[] = [];
    try {
      rows = await queryCandles({
        market, symbol, timeframe: dbSourceTf,
        limit: rawLimit,
        direction: 'desc',
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[loadInitialCandles] IDB queryCandles failed — falling through to CSV`, err);
    }
    if (rows.length > 0) {
      const filtered = preset ? filterBySessionHours(rows, preset.session, dbSourceTf) : rows;
      const candles = dbSourceTf === timeframe ? filtered : resampleCandles(filtered, timeframe);
      // eslint-disable-next-line no-console
      console.info(`[loadInitialCandles] ${market}/${symbol}@${timeframe} — IDB hit (${rows.length} rows)`);
      return { candles, sourceTimeframe: dbSourceTf, resampled: dbSourceTf !== timeframe };
    }
    // eslint-disable-next-line no-console
    console.info(`[loadInitialCandles] ${market}/${symbol}@${timeframe} — IDB miss (record exists but no rows) → falling through to CSV`);
  } else {
    // eslint-disable-next-line no-console
    console.info(`[loadInitialCandles] ${market}/${symbol}@${timeframe} — not in IDB → will fetch CSV`);
  }

  // ── Fallback: fetch CSV directly from the manifest ─────────────────────
  const picked = await _pickManifestSource(market, symbol, timeframe);
  if (!picked) {
    // eslint-disable-next-line no-console
    console.warn(`[loadInitialCandles] ${market}/${symbol}@${timeframe} — no manifest entry found`);
    return { candles: [], sourceTimeframe: timeframe, resampled: false };
  }
  // eslint-disable-next-line no-console
  console.info(`[loadInitialCandles] ${market}/${symbol}@${timeframe} — fetching CSV: ${picked.src.url} (source TF ${picked.tf})`);

  // When the caller wants a bounded window we stream + tail-buffer the CSV
  // so a 6-M-row / 300-MB file (XAUUSD 1m) doesn't blow the tab. Writeback
  // is skipped in that case because we don't have the full history.
  const sourceRatio = TIMEFRAME_MINUTES[timeframe] / TIMEFRAME_MINUTES[picked.tf];
  const sourceMax = loadAll ? Infinity : Math.ceil(count * sourceRatio);

  let csvCandles: RawCandle[];
  try {
    csvCandles = loadAll
      ? await _fetchCsvCandles(picked.src.url)
      : await _fetchCsvCandlesTail(picked.src.url, sourceMax);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[loadInitialCandles] ${market}/${symbol}@${timeframe} — CSV fetch failed`, err);
    throw err;
  }
  if (csvCandles.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`[loadInitialCandles] ${market}/${symbol}@${timeframe} — CSV parsed as empty`);
    return { candles: [], sourceTimeframe: picked.tf, resampled: false };
  }
  // eslint-disable-next-line no-console
  console.info(`[loadInitialCandles] ${market}/${symbol}@${timeframe} — CSV OK: ${csvCandles.length} rows (${loadAll ? 'full' : 'tail'})`);

  // Only warm the cache when we hold the full history — a partial tail
  // would corrupt the IDB record.
  if (loadAll) {
    _writebackCandles(market, symbol, picked.tf, csvCandles, picked.src);
  }

  const filtered = preset ? filterBySessionHours(csvCandles, preset.session, picked.tf) : csvCandles;
  const candles = picked.tf === timeframe ? filtered : resampleCandles(filtered, timeframe);
  return { candles, sourceTimeframe: picked.tf, resampled: picked.tf !== timeframe };
}

/**
 * Lazy backfill – returns up to `count` bars strictly older than `beforeMs`.
 * Same resample-from-base fallback as `loadInitialCandles`.
 */
export async function loadCandlesBefore(
  market: string,
  symbol: string,
  timeframe: Timeframe,
  beforeMs: number,
  count: number = BACKFILL_BAR_COUNT,
): Promise<LoadedCandles> {
  const sym = await store.getSymbol(market, symbol);
  const available = sym?.availableTimeframes ?? [];
  const sourceTf = pickSourceTimeframe(timeframe, available);
  if (!sourceTf) return { candles: [], sourceTimeframe: timeframe, resampled: false };

  const ratio = TIMEFRAME_MINUTES[timeframe] / TIMEFRAME_MINUTES[sourceTf];
  const rawLimit = sourceTf === timeframe ? count : Math.ceil(count * ratio);
  const rows = await queryCandles({
    market, symbol, timeframe: sourceTf,
    toMs: beforeMs - 1,
    limit: rawLimit,
    direction: 'desc',
  });
  const preset = getMarketPreset(market);
  const filtered = preset ? filterBySessionHours(rows, preset.session, sourceTf) : rows;
  const candles = sourceTf === timeframe ? filtered : resampleCandles(filtered, timeframe);
  return { candles, sourceTimeframe: sourceTf, resampled: sourceTf !== timeframe };
}

/**
 * Timeframes the picker should show for a given symbol: every TF actually in
 * the DB plus every coarser TF derivable from the finest stored one.
 */
export function selectableTimeframes(sym: store.SymbolRecord | undefined): Timeframe[] {
  if (!sym) return [];
  const available = new Set(sym.availableTimeframes ?? []);
  const finest = sym.baseTimeframe;
  if (finest) {
    for (const tf of ALL_TIMEFRAMES) {
      if (canResample(finest, tf)) available.add(tf);
    }
  }
  return ALL_TIMEFRAMES.filter(tf => available.has(tf));
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path – used by uploads / live feeds
// ─────────────────────────────────────────────────────────────────────────────

export async function saveCandlesForSeries(
  market: string,
  symbol: string,
  timeframe: Timeframe,
  candles: RawCandle[],
  meta?: { exchange?: string; description?: string },
  onProgress?: (p: store.SaveProgress) => void,
): Promise<void> {
  await store.upsertSymbol({
    market,
    symbol,
    exchange: meta?.exchange,
    description: meta?.description,
    baseTimeframe: timeframe,
  });
  await store.saveCandles(market, symbol, timeframe, candles, onProgress);
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only helpers for pickers
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketWithSymbols {
  id: string;
  label: string;
  continuous: boolean;
  timezone: string;
  symbols: store.SymbolRecord[];
}

export async function listMarketsWithSymbols(): Promise<MarketWithSymbols[]> {
  const markets = await store.listMarkets();
  const result: MarketWithSymbols[] = [];
  for (const m of markets) {
    const symbols = await store.listSymbols(m.id);
    result.push({
      id: m.id,
      label: m.label,
      continuous: m.continuous,
      timezone: m.timezone,
      symbols,
    });
  }
  // Also include preset markets even if they have no rows yet
  for (const preset of MARKET_PRESET_LIST) {
    if (!result.find(r => r.id === preset.id)) {
      result.push({
        id: preset.id,
        label: preset.label,
        continuous: preset.continuous,
        timezone: preset.timezone,
        symbols: [],
      });
    }
  }
  return result;
}

/**
 * Merge two sources for the picker:
 *   1. IndexedDB — symbols with actual candles (`ready`).
 *   2. manifest.json — every symbol on disk, even those not yet ingested
 *      (`pending` — picker can trigger a priority ingest on select).
 *
 * Result: the picker instantly shows all 500 symbols on first boot even
 * before the background ingest reaches them.
 */
export interface PickerSymbol extends store.SymbolRecord {
  status: 'ready' | 'pending';
  /**
   * Manifest URL for the symbol's default (base) timeframe — kept for
   * backward compat with the pending-ingest path.
   */
  manifestUrl?: string;
  /**
   * Per-timeframe manifest URLs. Populated whenever the manifest advertises
   * a TF that the DB doesn't yet have. Used by the picker to fetch the
   * correct CSV when the user selects a TF that isn't in availableTimeframes.
   */
  pendingByTf?: Partial<Record<Timeframe, string>>;
  /**
   * Per-timeframe provenance labels (from `meta.json.sources[tf].exchange`)
   * so the picker can show e.g. `5m — evtradelabs (mid)` and distinguish
   * multiple sources under one symbol.
   */
  exchangeByTf?: Partial<Record<Timeframe, string>>;
}

export interface PickerMarket {
  id: string;
  label: string;
  continuous: boolean;
  timezone: string;
  symbols: PickerSymbol[];
}

/**
 * Build the picker view: manifest is the source of truth for what exists.
 * IndexedDB is consulted only to mark which series are already cached
 * (used purely for the "(cached)" label — not required for load).
 */
export async function listMarketsForPicker(
  manifestUrl: string = MANIFEST_URL_DEFAULT,
): Promise<PickerMarket[]> {
  const manifest = await getManifest(manifestUrl);

  // IndexedDB is used to mark which series are already cached. If IDB
  // itself is in a bad state (e.g. aborted transaction after a tab OOM
  // crash), treat the cache as empty and render the picker purely from
  // the manifest + preset list. Users can still click any series to load
  // it from CSV; symbols just won't show the "ready" badge.
  let dbMarkets: MarketWithSymbols[];
  try {
    dbMarkets = await listMarketsWithSymbols();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[listMarketsForPicker] IDB unavailable, falling back to manifest only', err);
    dbMarkets = MARKET_PRESET_LIST.map(p => ({
      id: p.id, label: p.label, continuous: p.continuous,
      timezone: p.timezone, symbols: [],
    }));
  }

  // Start with every preset market present, empty symbol list.
  const byId = new Map<string, PickerMarket>(
    dbMarkets.map(m => [m.id, {
      id: m.id, label: m.label,
      continuous: m.continuous, timezone: m.timezone,
      symbols: [] as PickerSymbol[],
    }]),
  );

  // Index the DB's cached symbols so we can mark them as already loaded.
  const dbBySymbol = new Map<string, store.SymbolRecord>();
  for (const m of dbMarkets) {
    for (const s of m.symbols) {
      dbBySymbol.set(`${m.id}::${s.symbol}`, s);
    }
  }

  if (manifest) {
    // Group manifest entries by (market, symbol) — one PickerSymbol per pair.
    const grouped = new Map<string, { market: string; symbol: string; entries: ManifestSource[] }>();
    for (const src of manifest.sources) {
      const key = `${src.market}::${src.symbol}`;
      let g = grouped.get(key);
      if (!g) { g = { market: src.market, symbol: src.symbol, entries: [] }; grouped.set(key, g); }
      g.entries.push(src);
    }

    for (const { market, symbol, entries } of grouped.values()) {
      const pmarket = byId.get(market);
      if (!pmarket) continue;
      // Finest TF first — this becomes the picker's default `baseTimeframe`.
      entries.sort((a, b) => TIMEFRAME_MINUTES[a.timeframe] - TIMEFRAME_MINUTES[b.timeframe]);
      const finest = entries[0];
      const advertisedTfs = entries.map(e => e.timeframe);
      const dbRec = dbBySymbol.get(`${market}::${symbol}`);
      const cachedTfs = new Set(dbRec?.availableTimeframes ?? []);
      const isFullyCached = advertisedTfs.every(tf => cachedTfs.has(tf));

      pmarket.symbols.push({
        market, symbol,
        exchange: finest.exchange ?? dbRec?.exchange,
        description: finest.description ?? dbRec?.description,
        baseTimeframe: finest.timeframe,
        availableTimeframes: advertisedTfs,
        updatedAt: dbRec?.updatedAt ?? 0,
        status: isFullyCached ? 'ready' : 'pending',
        manifestUrl: finest.url,
        pendingByTf: Object.fromEntries(entries.map(e => [e.timeframe, e.url])),
        exchangeByTf: Object.fromEntries(
          entries.filter(e => e.exchange).map(e => [e.timeframe, e.exchange!])
        ),
      });
    }
  }

  // Also surface any DB-only symbols not in the manifest (e.g. user uploads).
  for (const [key, dbRec] of dbBySymbol) {
    const [marketId, symbol] = key.split('::');
    const pmarket = byId.get(marketId);
    if (!pmarket) continue;
    if (pmarket.symbols.some(s => s.symbol === symbol)) continue;
    pmarket.symbols.push({ ...dbRec, status: 'ready' });
  }

  for (const m of byId.values()) {
    m.symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }
  return Array.from(byId.values());
}

/**
 * Priority ingest — jump the queue and fetch one specific series so the
 * user's just-selected symbol is loaded immediately.
 */
export async function ingestOne(src: ManifestSource, opts: { force?: boolean } = {}): Promise<number> {
  const existing = await store.getSymbol(src.market, src.symbol);
  const knownRange = (existing && existing.availableTimeframes?.includes(src.timeframe))
    ? await store.getSeriesRange(src.market, src.symbol, src.timeframe)
    : null;

  const resp = await fetch(src.url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${src.url}`);
  const text = await resp.text();
  const file = new File([text], src.url.split('/').pop() ?? 'data.csv', { type: 'text/csv' });
  const { candles } = await parseOHLCVFile(file);
  if (candles.length === 0) return 0;

  let toWrite = candles;
  if (knownRange && knownRange.firstTs !== null && knownRange.lastTs !== null && !opts.force) {
    toWrite = candles.filter(c => c.timestamp < knownRange.firstTs! || c.timestamp > knownRange.lastTs!);
    if (toWrite.length === 0) return 0;
  }

  await store.upsertSymbol({
    market: src.market,
    symbol: src.symbol,
    exchange: src.exchange,
    description: src.description,
    baseTimeframe: src.timeframe,
  });
  await store.saveCandles(src.market, src.symbol, src.timeframe, toWrite);
  return toWrite.length;
}

export function presetFor(marketId: string) {
  return getMarketPreset(marketId);
}

// Re-export layout helpers so callers only need to import from this facade.
export {
  saveLayoutDb,
  getLayoutDb,
  getLayoutByNameDb,
  listLayoutsDb,
  deleteLayoutDb,
  setSetting,
  getSetting,
  getSeriesRange,
} from './marketStore';
