/**
 * Ingestion layer — common types.
 *
 * Every data source (Bybit REST/WS, Alpaca, Dukascopy, CSV file, CSV URL, in-
 * browser mock, …) implements one `SourceAdapter`. The IngestionService turns
 * every source into the same write path against IndexedDB.
 */
import type { RawCandle, Timeframe } from '../types';
import type { MarketKind } from '../engine/marketPresets';

/** Values passed to an adapter. Common fields plus adapter-specific extras. */
export interface SourceParams {
  market: string;         // 'crypto' | 'us_equity' | ...
  symbol: string;         // 'BTCUSDT' | 'SPY' | ...
  timeframe: Timeframe;
  from?: number;          // Unix ms, inclusive
  to?: number;            // Unix ms, inclusive
  /** Adapter-specific fields (API key, category, file handle, etc.) */
  extras?: Record<string, unknown>;
}

export interface IngestResult {
  candles: RawCandle[];
  meta?: { exchange?: string; description?: string };
  warnings?: string[];
}

/** Kind of adapter form field – drives the auto-generated ingestion UI. */
export type FieldKind =
  | 'text' | 'number' | 'password' | 'select'
  | 'date' | 'file' | 'url';

export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  defaultValue?: string | number;
  /** File adapters only – MIME hint, e.g. 'text/csv'. */
  accept?: string;
  help?: string;
}

export interface SourceAdapter {
  id: string;                                 // 'csv-file' | 'bybit' | 'alpaca' | ...
  label: string;                              // 'CSV file'
  /** One-line summary — shown at the top of the panel. */
  description?: string;
  /** What data the adapter provides + where it comes from. Rendered as a note block. */
  sourceInfo?: string;
  /** Accepted input format (columns, timestamp, delimiters). Rendered verbatim. */
  expectedFormat?: string;
  /** Optional docs link. */
  docsUrl?: string;
  kinds: MarketKind[];                        // which market kinds it can serve ('*' = any)
  supportsStream?: boolean;                   // live WS
  /** Fields the ingest panel should render for this adapter. */
  paramsSchema: FieldDef[];
  /** One-shot fetch. Always returns candles sorted by ts ascending. */
  fetch(params: SourceParams): Promise<IngestResult>;
  /** Optional live stream. Returns an unsubscribe fn. */
  stream?(params: SourceParams, onBar: (c: RawCandle) => void): () => void;
}

export interface IngestSummary {
  sourceId: string;
  market: string;
  symbol: string;
  timeframe: Timeframe;
  rows: number;                // rows actually written to the DB this call
  newRows?: number;            // rows outside the existing range
  skippedRows?: number;        // rows in the existing range that were kept as-is
  overwrittenRows?: number;    // rows in the existing range that were overwritten
  firstTs?: number;
  lastTs?: number;
  warnings?: string[];
  durationMs: number;
}

export type IngestMode = 'append-only' | 'overwrite';
