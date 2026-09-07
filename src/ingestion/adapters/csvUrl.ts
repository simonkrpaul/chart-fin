/**
 * CSV URL adapter — fetches a CSV/JSON from a URL. Used for bundled quick
 * datasets under public/data/ or any HTTP endpoint that returns OHLCV rows.
 */
import { parseOHLCVFile } from '../../utils/dataParser';
import type { SourceAdapter } from '../types';

export const csvUrlAdapter: SourceAdapter = {
  id: 'csv-url',
  label: 'CSV / JSON URL',
  description: 'Fetch a CSV or JSON file over HTTP and ingest it.',
  sourceInfo:
    'Convenient for bundled datasets under public/data/, static CDN files, or your own ' +
    'backend endpoints that return OHLCV. Same parser as CSV file upload.',
  expectedFormat: 'Same columns/timestamps as the CSV file adapter — see its hint.',
  kinds: ['crypto', 'us_equity', 'us_futures', 'forex', 'asx', 'lse', 'custom'],
  paramsSchema: [
    { name: 'url', label: 'URL', kind: 'url', required: true,
      placeholder: '/data/bybit_btcusdt_1m.csv',
      help: 'Absolute or app-relative URL. Files under public/ are served at their same path.' },
  ],
  async fetch(params) {
    const url = (params.extras?.url as string | undefined) ?? '';
    if (!url) throw new Error('URL required');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const blob = await resp.blob();
    const name = url.split('/').pop() ?? 'remote.csv';
    const file = new File([blob], name, { type: blob.type || 'text/csv' });
    const { candles, errors, symbol } = await parseOHLCVFile(file);
    if (candles.length === 0) {
      throw new Error(errors[0] ?? 'No candles parsed from remote file.');
    }
    return {
      candles: [...candles].sort((a, b) => a.timestamp - b.timestamp),
      meta: { description: symbol },
      warnings: errors.length ? errors.slice(0, 5) : undefined,
    };
  },
};
