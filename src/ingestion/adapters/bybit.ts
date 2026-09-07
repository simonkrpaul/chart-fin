/**
 * Bybit adapter — public REST + WebSocket for linear/spot markets.
 *
 * Ported from the old BybitLiveLoader component. Feeds into the unified
 * ingestion service so any symbol (not just BTCUSDT) can be pulled.
 */
import type { RawCandle } from '../../types';
import type { SourceAdapter, SourceParams } from '../types';

const REST_BASE = 'https://api.bybit.com/v5/market/kline';
const WS_URL    = 'wss://stream.bybit.com/v5/public/linear';
const REST_LIMIT = 1000;
const PAGE_DELAY_MS = 120;
const EARLIEST_ACCEPTABLE_TS = Date.UTC(2017, 0, 1);

interface BybitRestKlineResponse {
  retCode?: number;
  result?: { list?: Array<string[]> };
}
interface BybitKlinePayload {
  topic: string;
  data: Array<{
    start: string | number; timestamp?: string | number;
    open: string | number; high: string | number; low: string | number;
    close: string | number; volume: string | number;
    confirm?: boolean;
  }>;
}

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240',
  '1d': 'D', '1w': 'W', '1M': 'M',
};

function toMs(v: string | number | undefined): number {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n < 1e11 ? n * 1000 : n;
}

function parseRow(row: string[], symbol: string): RawCandle | null {
  const [start, open, high, low, close, volume] = row;
  const ts = toMs(start);
  if (ts < EARLIEST_ACCEPTABLE_TS) return null;
  const o = Number(open), h = Number(high), l = Number(low), c = Number(close), v = Number(volume);
  if ([o, h, l, c].some(x => !Number.isFinite(x))) return null;
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0, symbol, exchange: 'Bybit' };
}

async function fetchHistory(params: SourceParams): Promise<RawCandle[]> {
  const category = (params.extras?.category as string) || 'linear';
  const interval = INTERVAL_MAP[params.timeframe];
  if (!interval) throw new Error(`bybit: unsupported timeframe ${params.timeframe}`);
  const daysBack = Number(params.extras?.days ?? 14);
  const endMs = params.to ?? Date.now();
  const startMs = params.from ?? endMs - daysBack * 86_400_000;

  const all: RawCandle[] = [];
  let cursorEnd = endMs;

  while (cursorEnd > startMs) {
    const url = `${REST_BASE}?category=${category}&symbol=${params.symbol}&interval=${interval}&limit=${REST_LIMIT}&start=${startMs}&end=${cursorEnd}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Bybit REST ${resp.status}`);
    const payload = (await resp.json()) as BybitRestKlineResponse;
    const list = payload.result?.list ?? [];
    if (!list.length) break;
    for (const row of list) {
      const bar = parseRow(row, params.symbol);
      if (bar && bar.timestamp >= startMs) all.push(bar);
    }
    const oldestTs = toMs(list[list.length - 1][0]);
    cursorEnd = oldestTs - 1;
    if (list.length < REST_LIMIT) break;
    await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
  }

  const seen = new Set<number>();
  const deduped: RawCandle[] = [];
  for (const bar of all) if (!seen.has(bar.timestamp)) { seen.add(bar.timestamp); deduped.push(bar); }
  deduped.sort((a, b) => a.timestamp - b.timestamp);
  return deduped;
}

export const bybitAdapter: SourceAdapter = {
  id: 'bybit',
  label: 'Bybit (REST + WS)',
  description: 'Public Bybit v5 klines. No API key required.',
  sourceInfo:
    'Historical bars are fetched from https://api.bybit.com/v5/market/kline with pagination. ' +
    'Live streaming subscribes to wss://stream.bybit.com/v5/public/linear. Symbols must exist ' +
    'on Bybit (e.g. BTCUSDT, ETHUSDT, SOLUSDT for linear perps).',
  expectedFormat: 'Bybit returns 6-tuple rows [start_ts, open, high, low, close, volume]. Normalised to RawCandle here.',
  docsUrl: 'https://bybit-exchange.github.io/docs/v5/market/kline',
  kinds: ['crypto'],
  supportsStream: true,
  paramsSchema: [
    { name: 'category', label: 'Category', kind: 'select',
      options: [{ label: 'Linear (perp)', value: 'linear' }, { label: 'Spot', value: 'spot' }, { label: 'Inverse', value: 'inverse' }],
      defaultValue: 'linear' },
    { name: 'days',     label: 'History (days back)', kind: 'number', defaultValue: 14,
      help: 'How far back to page. 14 days of 1m ≈ 20 k bars.' },
  ],
  async fetch(params) {
    const candles = await fetchHistory(params);
    return { candles, meta: { exchange: 'Bybit' } };
  },
  stream(params, onBar) {
    const interval = INTERVAL_MAP[params.timeframe] ?? '1';
    const topic = `kline.${interval}.${params.symbol}`;
    let ws: WebSocket | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(WS_URL);
      ws.onopen = () => ws!.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
      ws.onmessage = evt => {
        try {
          const msg = JSON.parse(evt.data) as BybitKlinePayload;
          if (!msg.topic?.startsWith('kline.')) return;
          for (const bar of msg.data ?? []) {
            if (bar.confirm === false) continue; // only confirmed bars
            const ts = toMs(bar.start ?? bar.timestamp);
            if (ts < EARLIEST_ACCEPTABLE_TS) continue;
            const o = Number(bar.open), h = Number(bar.high), l = Number(bar.low), c = Number(bar.close), v = Number(bar.volume);
            if ([o, h, l, c].some(x => !Number.isFinite(x))) continue;
            onBar({ timestamp: ts, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0, symbol: params.symbol, exchange: 'Bybit' });
          }
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => { if (!stopped) setTimeout(connect, 2000); };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => { stopped = true; ws?.close(); ws = null; };
  },
};
