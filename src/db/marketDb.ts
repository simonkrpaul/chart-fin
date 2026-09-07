/**
 * marketDb.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * High-level facade over `marketStore` (IndexedDB) and `duckdb` (WASM SQL).
 *
 * Public surface:
 *   • ensureMarkets()              – seeds preset markets into the DB
 *   • ingestManifest(url?)         – bulk-loads CSVs listed in a manifest
 *   • loadInitialCandles()         – fast tail query (last N bars) for chart start
 *   • loadCandlesBefore()          – lazy backfill on pan-left
 *   • saveCandlesForSeries()       – used by uploads / API pulls
 *   • listMarketsWithCounts()      – for the picker UI
 *   • invalidateAnalyticalCache()  – DuckDB cache reset after writes
 *
 * The manifest is a static JSON file shipped in `public/data/markets/` that
 * lists every CSV bundled with the app. Python scripts (`import_market.py`,
 * `mock_data.py`) write to that folder and rebuild the manifest so the
 * browser can bootstrap without contacting a server.
 */
import type { RawCandle, Timeframe } from '../types';
import { parseOHLCVFile } from '../utils/dataParser';
import { MARKET_PRESET_LIST, getMarketPreset } from '../engine/marketPresets';
import { canResample, resampleCandles } from '../engine/resampleEngine';
import { TIMEFRAME_MINUTES } from '../engine/calendarEngine';
import * as store from './marketStore';
import { invalidateSeries, queryCandles } from './duckdb';

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
      invalidateSeries(src.market, src.symbol, src.timeframe);
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
 * Fast initial load – returns the most recent `count` bars for the series.
 * Falls back to resampling from the finest stored TF when the exact TF is
 * not in the DB (e.g. requested 1w but only 1d is stored).
 *
 * Pass `count = Infinity` (or a very large number) to load every stored bar.
 */
export async function loadInitialCandles(
  market: string,
  symbol: string,
  timeframe: Timeframe,
  count: number = INITIAL_BAR_COUNT,
): Promise<LoadedCandles> {
  const sym = await store.getSymbol(market, symbol);
  const available = sym?.availableTimeframes ?? [];
  const sourceTf = pickSourceTimeframe(timeframe, available);
  if (!sourceTf) return { candles: [], sourceTimeframe: timeframe, resampled: false };

  const loadAll = !Number.isFinite(count);
  const ratio = TIMEFRAME_MINUTES[timeframe] / TIMEFRAME_MINUTES[sourceTf];
  const rawLimit = loadAll
    ? undefined
    : sourceTf === timeframe ? count : Math.ceil(count * ratio);
  const rows = await queryCandles({
    market, symbol, timeframe: sourceTf,
    limit: rawLimit,
    direction: 'desc',
  });
  const candles = sourceTf === timeframe ? rows : resampleCandles(rows, timeframe);
  return { candles, sourceTimeframe: sourceTf, resampled: sourceTf !== timeframe };
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
  const candles = sourceTf === timeframe ? rows : resampleCandles(rows, timeframe);
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
  invalidateSeries(market, symbol, timeframe);
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
  /** Manifest URL for a pending symbol — used to prioritise its ingest. */
  manifestUrl?: string;
}

export interface PickerMarket {
  id: string;
  label: string;
  continuous: boolean;
  timezone: string;
  symbols: PickerSymbol[];
}

export async function listMarketsForPicker(
  manifestUrl: string = MANIFEST_URL_DEFAULT,
): Promise<PickerMarket[]> {
  const dbMarkets = await listMarketsWithSymbols();
  const byId = new Map<string, PickerMarket>(
    dbMarkets.map(m => [m.id, {
      id: m.id, label: m.label,
      continuous: m.continuous, timezone: m.timezone,
      symbols: m.symbols.map(s => ({ ...s, status: 'ready' as const })),
    }]),
  );

  // Overlay manifest so pending symbols appear too.
  try {
    const resp = await fetch(manifestUrl);
    if (resp.ok) {
      const manifest = (await resp.json()) as Manifest;
      for (const src of manifest.sources) {
        const market = byId.get(src.market);
        if (!market) continue;
        const existing = market.symbols.find(s => s.symbol === src.symbol);
        if (existing) {
          // Track known TF list without overwriting DB availability.
          if (!existing.availableTimeframes?.includes(src.timeframe)) {
            // Manifest advertises this TF; DB doesn't have it yet.
            existing.manifestUrl = src.url;
          }
          continue;
        }
        market.symbols.push({
          market: src.market,
          symbol: src.symbol,
          exchange: src.exchange,
          description: src.description,
          baseTimeframe: src.timeframe,
          availableTimeframes: [],
          updatedAt: 0,
          status: 'pending',
          manifestUrl: src.url,
        });
      }
    }
  } catch {
    // Manifest missing — return DB-only view.
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
  invalidateSeries(src.market, src.symbol, src.timeframe);
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
