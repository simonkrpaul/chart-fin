/**
 * IngestionService — the single write path from any source adapter into
 * IndexedDB. `ingest()` is what every UI button and every backfill job calls.
 *
 * Also exposes `startStream()` for adapters with a WebSocket feed (Bybit).
 * The stream helper writes into both the running chart store (via
 * appendCandles) and the DB so live data survives reload.
 */
import type { RawCandle } from '../types';
import { getAdapter } from './registry';
import type { IngestMode, IngestSummary, SourceParams } from './types';
import { saveCandlesForSeries } from '../db/marketDb';
import { getSeriesRange } from '../db/marketStore';
import { primaryChartStore } from '../store/chartStore';
import { detectTimeframe } from '../utils/dataParser';

export type IngestProgress =
  | { phase: 'fetching'; message: string }
  | { phase: 'validating'; message: string }
  | { phase: 'saving'; saved: number; total: number; message: string }
  | { phase: 'done'; message: string };

export interface IngestOptions {
  /**
   * append-only (default): skip rows whose timestamp is already inside the
   *   stored [firstTs..lastTs] range for this (market, symbol, timeframe).
   *   Only genuinely new head/tail rows are written. Amendments to existing
   *   rows are NOT applied.
   * overwrite: put every row unconditionally, replacing any existing row
   *   with the same timestamp. Use this when re-ingesting a file with
   *   amendments in the middle.
   */
  mode?: IngestMode;
  onProgress?: (p: IngestProgress) => void;
}

/** One-shot ingest: adapter fetch → validate → DB write. */
export async function ingest(
  sourceId: string,
  params: SourceParams,
  opts: IngestOptions = {},
): Promise<IngestSummary> {
  const adapter = getAdapter(sourceId);
  if (!adapter) throw new Error(`Unknown source: ${sourceId}`);
  const mode: IngestMode = opts.mode ?? 'append-only';
  const onProgress = opts.onProgress;
  const t0 = performance.now();

  onProgress?.({ phase: 'fetching', message: `Fetching from ${adapter.label}…` });
  const { candles: fetched, meta, warnings: fetchWarnings } = await adapter.fetch(params);
  const warnings: string[] = fetchWarnings ? [...fetchWarnings] : [];
  // eslint-disable-next-line no-console
  console.info('[ingest] fetched', {
    adapter: adapter.id, rows: fetched.length,
    firstTs: fetched[0]?.timestamp, lastTs: fetched[fetched.length - 1]?.timestamp,
    warnings: fetchWarnings,
  });

  if (fetched.length === 0) {
    onProgress?.({ phase: 'done', message: 'No candles returned.' });
    return { sourceId, market: params.market, symbol: params.symbol, timeframe: params.timeframe,
             rows: 0, warnings, durationMs: performance.now() - t0 };
  }

  onProgress?.({ phase: 'validating', message: `Validating ${fetched.length.toLocaleString()} candles…` });
  const detected = detectTimeframe(fetched);
  if (detected !== params.timeframe) {
    warnings.push(
      `Timeframe mismatch: file looks like ${detected} but you chose ${params.timeframe}. ` +
      `Continuing under ${params.timeframe} — switch the selector to ${detected} if that's the real cadence.`,
    );
  }

  // Filter for delta ingest.
  let toWrite: RawCandle[] = fetched;
  let skipped = 0;
  let overwritten = 0;
  const range = await getSeriesRange(params.market, params.symbol, params.timeframe);
  // eslint-disable-next-line no-console
  console.info('[ingest] existing range', {
    market: params.market, symbol: params.symbol, tf: params.timeframe,
    firstTs: range.firstTs, lastTs: range.lastTs, count: range.count, mode,
  });
  if (mode === 'append-only') {
    if (range.firstTs !== null && range.lastTs !== null) {
      const first = range.firstTs;
      const last  = range.lastTs;
      toWrite = fetched.filter(c => c.timestamp < first || c.timestamp > last);
      skipped = fetched.length - toWrite.length;
    }
  } else {
    // In overwrite mode, count how many rows fall inside the existing range —
    // those are the ones being amended, purely for reporting.
    if (range.firstTs !== null && range.lastTs !== null) {
      overwritten = fetched.filter(
        c => c.timestamp >= range.firstTs! && c.timestamp <= range.lastTs!,
      ).length;
    }
  }

  if (toWrite.length === 0) {
    const durationMs = performance.now() - t0;
    onProgress?.({ phase: 'done', message: 'Nothing new to save.' });
    return {
      sourceId,
      market: params.market, symbol: params.symbol, timeframe: params.timeframe,
      rows: 0, newRows: 0, skippedRows: skipped, overwrittenRows: 0,
      firstTs: fetched[0].timestamp, lastTs: fetched[fetched.length - 1].timestamp,
      warnings: warnings.length ? warnings : undefined, durationMs,
    };
  }

  onProgress?.({ phase: 'saving', saved: 0, total: toWrite.length, message: 'Saving to DB…' });
  await saveCandlesForSeries(
    params.market, params.symbol, params.timeframe, toWrite, meta,
    ({ saved, total }) => onProgress?.({
      phase: 'saving', saved, total,
      message: `Saving to DB… ${saved.toLocaleString()} / ${total.toLocaleString()}`,
    }),
  );

  const durationMs = performance.now() - t0;
  onProgress?.({ phase: 'done', message: `Done in ${durationMs.toFixed(0)} ms.` });
  return {
    sourceId,
    market: params.market, symbol: params.symbol, timeframe: params.timeframe,
    rows: toWrite.length,
    newRows: mode === 'append-only' ? toWrite.length : toWrite.length - overwritten,
    skippedRows: skipped,
    overwrittenRows: overwritten,
    firstTs: toWrite[0].timestamp,
    lastTs: toWrite[toWrite.length - 1].timestamp,
    warnings: warnings.length ? warnings : undefined,
    durationMs,
  };
}

/**
 * Live stream: appends each incoming bar into the primary chart store and,
 * throttled, persists it to the DB via saveCandlesForSeries.
 */
export function startStream(sourceId: string, params: SourceParams): () => void {
  const adapter = getAdapter(sourceId);
  if (!adapter?.stream) throw new Error(`${sourceId} does not support streaming`);
  const buffer: RawCandle[] = [];
  const flushIntervalMs = 5000;
  const flushTimer = setInterval(() => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0);
    void saveCandlesForSeries(params.market, params.symbol, params.timeframe, batch);
  }, flushIntervalMs);
  const unsubscribe = adapter.stream(params, (bar: RawCandle) => {
    primaryChartStore.getState().appendCandles([bar]);
    buffer.push(bar);
  });
  return () => {
    clearInterval(flushTimer);
    if (buffer.length > 0) {
      void saveCandlesForSeries(params.market, params.symbol, params.timeframe, buffer.splice(0));
    }
    unsubscribe();
  };
}
