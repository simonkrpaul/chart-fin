/**
 * Alpaca adapter — historical bars for one US equity symbol.
 *
 * Endpoint: https://data.alpaca.markets/v2/stocks/bars
 * Docs:     https://docs.alpaca.markets/us/docs/getting-started-with-alpaca-market-data
 *
 * Free tier notes
 * ───────────────
 *   • Auth headers: APCA-API-KEY-ID / APCA-API-SECRET-KEY
 *   • Feed = IEX by default (delayed 15 min, unlimited history for equities)
 *   • Rate limit: 200 req/min — we self-throttle to ~200 ms between pages
 *
 * For bulk downloads (S&P 500, etc.) use scripts/download_alpaca.py — it
 * batches 100 symbols per request and writes CSVs straight into
 * public/data/markets/us_equity/, which the browser auto-ingests.
 */
import type { RawCandle, Timeframe } from '../../types';
import type { SourceAdapter, SourceParams } from '../types';

const API_BASE = 'https://data.alpaca.markets/v2/stocks/bars';
const PAGE_LIMIT = 10_000;
const PAGE_DELAY_MS = 200;

const TF_TO_ALPACA: Record<string, string> = {
  '1m':  '1Min',
  '5m':  '5Min',
  '15m': '15Min',
  '1h':  '1Hour',
  '4h':  '4Hour',
  '1d':  '1Day',
  '1w':  '1Week',
  '1M':  '1Month',
};

interface AlpacaBar {
  t: string;   // ISO 8601
  o: number; h: number; l: number; c: number;
  v: number;
  n?: number; vw?: number;
}
interface AlpacaBarsResponse {
  bars?: Record<string, AlpacaBar[]>;
  next_page_token?: string | null;
}

function tfToAlpaca(tf: Timeframe): string {
  const m = TF_TO_ALPACA[tf];
  if (!m) throw new Error(`Alpaca: unsupported timeframe ${tf}`);
  return m;
}

async function fetchAllPages(
  symbol: string,
  tf: Timeframe,
  startIso: string,
  endIso: string,
  headers: HeadersInit,
  feed: string,
  adjustment: string,
): Promise<RawCandle[]> {
  const bars: RawCandle[] = [];
  let pageToken: string | null = null;
  do {
    const params = new URLSearchParams({
      symbols:    symbol,
      timeframe:  tfToAlpaca(tf),
      start:      startIso,
      end:        endIso,
      limit:      String(PAGE_LIMIT),
      feed,
      adjustment,
    });
    if (pageToken) params.set('page_token', pageToken);
    const resp = await fetch(`${API_BASE}?${params.toString()}`, { headers });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Alpaca ${resp.status}: ${body.slice(0, 200) || resp.statusText}`);
    }
    const json = (await resp.json()) as AlpacaBarsResponse;
    const list = json.bars?.[symbol] ?? [];
    for (const b of list) {
      const ts = Date.parse(b.t);
      if (!Number.isFinite(ts)) continue;
      bars.push({
        timestamp: ts,
        open: b.o, high: b.h, low: b.l, close: b.c,
        volume: b.v,
        symbol,
        exchange: 'Alpaca',
      });
    }
    pageToken = json.next_page_token ?? null;
    if (pageToken) await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
  } while (pageToken);
  bars.sort((a, b) => a.timestamp - b.timestamp);
  return bars;
}

export const alpacaAdapter: SourceAdapter = {
  id: 'alpaca',
  label: 'Alpaca (US equities)',
  description: 'Historical bars from Alpaca Market Data v2 (free IEX feed by default).',
  sourceInfo:
    'Hits https://data.alpaca.markets/v2/stocks/bars with your API key + secret. ' +
    'IEX feed is free and 15-min delayed; SIP requires a paid plan. ' +
    'For bulk S&P 500 downloads use scripts/download_alpaca.py — it writes CSVs to ' +
    'public/data/markets/us_equity/ which the browser auto-ingests on boot.',
  expectedFormat: 'Alpaca returns bars as { t, o, h, l, c, v }. Normalised to RawCandle here.',
  docsUrl: 'https://docs.alpaca.markets/us/docs/getting-started-with-alpaca-market-data',
  kinds: ['us_equity', 'us_futures'],
  paramsSchema: [
    { name: 'apiKeyId',    label: 'API Key ID',    kind: 'password', required: true,
      help: 'APCA-API-KEY-ID from https://app.alpaca.markets/paper/dashboard/overview' },
    { name: 'apiSecretKey', label: 'API Secret Key', kind: 'password', required: true,
      help: 'APCA-API-SECRET-KEY. Never checked in.' },
    { name: 'feed',        label: 'Feed', kind: 'select',
      options: [
        { label: 'IEX (free, 15-min delayed)', value: 'iex' },
        { label: 'SIP (paid, real-time)',      value: 'sip' },
      ],
      defaultValue: 'iex' },
    { name: 'adjustment',  label: 'Adjustment', kind: 'select',
      options: [
        { label: 'Raw (no adjustment)',           value: 'raw' },
        { label: 'Split-adjusted',                value: 'split' },
        { label: 'Dividend-adjusted',             value: 'dividend' },
        { label: 'Split + dividend (all)',        value: 'all' },
      ],
      defaultValue: 'raw' },
    { name: 'years',       label: 'History (years back)', kind: 'number', defaultValue: 5,
      help: 'Ignored if you set from/to on the shared row.' },
  ],
  async fetch(params: SourceParams) {
    const key    = (params.extras?.apiKeyId    as string | undefined)?.trim() ?? '';
    const secret = (params.extras?.apiSecretKey as string | undefined)?.trim() ?? '';
    if (!key || !secret) throw new Error('Alpaca: API Key ID and Secret Key are required.');

    const feed       = (params.extras?.feed as string | undefined) ?? 'iex';
    const adjustment = (params.extras?.adjustment as string | undefined) ?? 'raw';
    const years      = Number(params.extras?.years ?? 5);
    const endMs   = params.to   ?? Date.now();
    const startMs = params.from ?? endMs - years * 365 * 86_400_000;

    const startIso = new Date(startMs).toISOString();
    const endIso   = new Date(endMs).toISOString();

    const headers: HeadersInit = {
      'APCA-API-KEY-ID':     key,
      'APCA-API-SECRET-KEY': secret,
      'Accept':              'application/json',
    };

    const candles = await fetchAllPages(
      params.symbol, params.timeframe, startIso, endIso, headers, feed, adjustment,
    );
    return { candles, meta: { exchange: 'Alpaca' } };
  },
};
