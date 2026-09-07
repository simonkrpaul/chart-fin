/**
 * CSV file adapter — user picks a local file, we parse it into RawCandles.
 * The file lives in `params.extras.file` (browsers can't be handed a File via
 * a plain form binding until submit, so the panel sets this at submit time).
 */
import type { RawCandle } from '../../types';
import { parseOHLCVFile } from '../../utils/dataParser';
import type { SourceAdapter } from '../types';

export const csvFileAdapter: SourceAdapter = {
  id: 'csv-file',
  label: 'CSV / JSON file',
  description: 'Upload a local OHLCV file from your machine.',
  sourceInfo:
    'Reads the file entirely in the browser — no network, no server. The parsed candles ' +
    'go straight into IndexedDB for the selected (market, symbol, timeframe).',
  expectedFormat:
`CSV (comma, semicolon, or tab-separated; first row = header):

  timestamp,open,high,low,close,volume        ← minimal
  time,open,high,low,close,volume,symbol
  date,open,high,low,close,vol

Accepted column aliases (case-insensitive):
  timestamp: timestamp | time | date | datetime | t | ts | open_time
  open:      open | o
  high:      high | h
  low:       low  | l
  close:     close | c | weighted_price
  volume:    volume | vol | v | volume_(btc) | volume_(currency)   (optional)
  symbol:    symbol | ticker | sym                                 (optional)

Timestamp formats:
  Unix seconds       1700000000
  Unix milliseconds  1700000000000
  ISO 8601           2024-01-02T09:30:00Z
  ISO no timezone    2024-01-02 09:30:00     (treated as UTC)
  US date            01/02/2024 09:30

Example row:
  2024-01-02T00:00:00Z,42000.5,42500.1,41800.0,42250.3,1234.5

JSON alternatives:
  [ { "timestamp": …, "open": …, "high": …, "low": …, "close": …, "volume": … }, … ]
  [ [ ts, o, h, l, c, v ], … ]
  { "candles": [ … ] }   or   { "data": [ … ] }`,
  kinds: ['crypto', 'us_equity', 'us_futures', 'forex', 'asx', 'lse', 'custom'],
  paramsSchema: [
    { name: 'file', label: 'File', kind: 'file', required: true,
      accept: '.csv,.json,.txt,.tsv,text/csv,application/json',
      help: 'CSV, TSV, or JSON. The file is parsed locally.' },
  ],
  async fetch(params) {
    const file = params.extras?.file as File | undefined;
    if (!file) throw new Error('Please choose a file first.');
    const { candles, errors, symbol } = await parseOHLCVFile(file);
    if (candles.length === 0) {
      throw new Error(
        errors[0] ??
        'No candles parsed — check the format hint below for accepted columns/timestamps.',
      );
    }
    const sorted: RawCandle[] = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    return {
      candles: sorted,
      meta: { description: symbol },
      warnings: errors.length ? errors.slice(0, 5) : undefined,
    };
  },
};
