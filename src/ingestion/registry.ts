/**
 * Adapter registry. Adding a new data source = new file in adapters/ + one
 * line here. Every UI surface iterates ADAPTERS to render the source picker.
 */
import type { SourceAdapter } from './types';
import { csvFileAdapter } from './adapters/csvFile';
import { csvUrlAdapter } from './adapters/csvUrl';
import { mockAdapter } from './adapters/mock';
import { bybitAdapter } from './adapters/bybit';
import { alpacaAdapter } from './adapters/alpaca';

export const ADAPTERS: Record<string, SourceAdapter> = {
  [csvFileAdapter.id]: csvFileAdapter,
  [csvUrlAdapter.id]:  csvUrlAdapter,
  [bybitAdapter.id]:   bybitAdapter,
  [alpacaAdapter.id]:  alpacaAdapter,
  [mockAdapter.id]:    mockAdapter,
};

export function listAdapters(): SourceAdapter[] {
  return Object.values(ADAPTERS);
}

export function getAdapter(id: string): SourceAdapter | undefined {
  return ADAPTERS[id];
}
