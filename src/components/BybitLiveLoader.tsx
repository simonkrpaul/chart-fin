/**
 * BybitLiveLoader – public BTCUSDT perpetual live feed bridge.
 *
 * Features:
 *   1) Probes Bybit connectivity on mount (green/red indicator).
 *   2) Syncs full REST history using pagination (fills gaps from downtime).
 *   3) Loads synced candles into the chart store (merges with local data).
 *   4) Opens a public WebSocket for real-time kline updates.
 *   5) Button is greyed out when Bybit is unreachable.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import type { RawCandle } from '../types';

/* ── Bybit API types ──────────────────────────────────────────────────────── */

interface BybitKlinePayload {
  topic: string;
  data: Array<{
    start: string | number;
    timestamp?: string | number;
    open: string | number;
    high: string | number;
    low: string | number;
    close: string | number;
    volume: string | number;
    confirm?: boolean;
  }>;
}

interface BybitRestKlineResponse {
  retCode?: number;
  result?: {
    list?: Array<string[]>;
  };
}

/* ── Constants ────────────────────────────────────────────────────────────── */

const WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const REST_BASE = 'https://api.bybit.com/v5/market/kline';
const SYMBOL = 'BTCUSDT';
const CATEGORY = 'linear';
const REST_LIMIT = 1000;
const ONE_MIN_MS = 60_000;
const EARLIEST_ACCEPTABLE_TS = Date.UTC(2017, 0, 1);
/** How many days of REST history to fetch when syncing (covers week+ offline). */
const SYNC_DAYS = 14;
/** Rate-limit pause between REST pages (ms). */
const PAGE_DELAY_MS = 120;

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function toTimestampMs(value: string | number | undefined): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  // Bybit v5 always returns ms timestamps, but guard against seconds
  return n < 1e11 ? n * 1000 : n;
}

function parseBybitRow(row: string[]): RawCandle | null {
  const [start, open, high, low, close, volume] = row;
  const ts = toTimestampMs(start);
  if (ts < EARLIEST_ACCEPTABLE_TS) return null;
  const o = Number(open), h = Number(high), l = Number(low), c = Number(close), v = Number(volume);
  if ([o, h, l, c].some(x => !Number.isFinite(x))) return null;
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0, symbol: SYMBOL, exchange: 'Bybit' };
}

function parseWsBar(bar: BybitKlinePayload['data'][0]): RawCandle | null {
  const ts = toTimestampMs(bar.start ?? bar.timestamp);
  if (ts < EARLIEST_ACCEPTABLE_TS) return null;
  const o = Number(bar.open), h = Number(bar.high), l = Number(bar.low), c = Number(bar.close), v = Number(bar.volume);
  if ([o, h, l, c].some(x => !Number.isFinite(x))) return null;
  return { timestamp: ts, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0, symbol: SYMBOL, exchange: 'Bybit' };
}

/**
 * Fetch paginated 1-minute klines from Bybit REST.
 * Bybit returns newest-first, so we paginate backwards from endMs.
 */
async function fetchPaginatedHistory(
  startMs: number,
  endMs: number,
  onProgress?: (pct: number, count: number) => void,
): Promise<RawCandle[]> {
  const all: RawCandle[] = [];
  let cursorEnd = endMs;
  const totalSpan = endMs - startMs;
  let pageCount = 0;

  while (cursorEnd > startMs) {
    const url = `${REST_BASE}?category=${CATEGORY}&symbol=${SYMBOL}&interval=1&limit=${REST_LIMIT}&start=${startMs}&end=${cursorEnd}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Bybit REST ${resp.status}`);

    const payload = (await resp.json()) as BybitRestKlineResponse;
    const list = payload.result?.list ?? [];
    if (!list.length) break;

    for (const row of list) {
      const bar = parseBybitRow(row);
      if (bar && bar.timestamp >= startMs) all.push(bar);
    }

    // Oldest timestamp in batch (Bybit returns newest first, last element is oldest)
    const oldestTs = toTimestampMs(list[list.length - 1][0]);
    cursorEnd = oldestTs - 1;
    pageCount++;

    if (onProgress) {
      const fetchedSpan = endMs - cursorEnd;
      const pct = totalSpan > 0 ? Math.min(100, Math.round((fetchedSpan / totalSpan) * 100)) : 100;
      onProgress(pct, all.length);
    }

    if (list.length < REST_LIMIT) break;
    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
  }

  // Deduplicate and sort ascending
  const seen = new Set<number>();
  const deduped: RawCandle[] = [];
  for (const bar of all) {
    if (!seen.has(bar.timestamp)) {
      seen.add(bar.timestamp);
      deduped.push(bar);
    }
  }
  deduped.sort((a, b) => a.timestamp - b.timestamp);
  return deduped;
}

/**
 * Quick connectivity check — fetch 1 bar to test if Bybit API is reachable.
 */
async function probeBybitConnection(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(
      `${REST_BASE}?category=${CATEGORY}&symbol=${SYMBOL}&interval=1&limit=1`,
      { signal: controller.signal },
    );
    clearTimeout(timeoutId);
    if (!resp.ok) return false;
    const data = (await resp.json()) as BybitRestKlineResponse;
    return (data.result?.list?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/* ── Component ────────────────────────────────────────────────────────────── */

export const BybitLiveLoader: React.FC = () => {
  const { loadCandles, appendCandles, setTimeframe, theme, rawCandles, baseCandles } = useChartStore();
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState('Checking Bybit…');
  const [wsConnected, setWsConnected] = useState(false);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null); // null = probing
  const [loading, setLoading] = useState(false);
  const probeInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#c8cad5';
  const okColor = '#26a69a';
  const errorColor = '#ef5350';
  const accent = '#2962ff';
  const disabledBg = theme === 'dark' ? '#23262f' : '#e8eaed';
  const disabledText = theme === 'dark' ? '#555' : '#999';

  /* ── Connectivity probe ─────────────────────────────────────────────────── */

  const runProbe = useCallback(async () => {
    const ok = await probeBybitConnection();
    setApiReachable(ok);
    if (ok) {
      setStatus(wsConnected ? `Live · ${SYMBOL}` : 'Bybit reachable');
    } else {
      setStatus('Bybit unreachable');
    }
  }, [wsConnected]);

  useEffect(() => {
    runProbe();
    // Re-probe every 30 seconds
    probeInterval.current = setInterval(runProbe, 30_000);
    return () => {
      if (probeInterval.current) clearInterval(probeInterval.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [runProbe]);

  /* ── Stop feed ──────────────────────────────────────────────────────────── */

  const stopFeed = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setWsConnected(false);
    setStatus('Live feed stopped');
  }, []);

  /* ── Start feed (sync + live) ───────────────────────────────────────────── */

  const startFeed = useCallback(async () => {
    if (apiReachable === false) {
      setStatus('Cannot connect to Bybit');
      return;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setStatus('Already connected');
      return;
    }

    setLoading(true);

    try {
      /* ── Phase 1: determine sync window ─────────────────────────────────── */
      const nowMs = Date.now();
      const existingCandles = baseCandles.length > 0 ? baseCandles : rawCandles;
      let syncStartMs: number;

      if (existingCandles.length > 0) {
        // Find the last timestamp in existing data — sync from there
        const lastTs = existingCandles.reduce((max, c) => Math.max(max, c.timestamp), 0);
        syncStartMs = lastTs;
        const gapHours = ((nowMs - lastTs) / (3600 * 1000)).toFixed(1);
        setStatus(`Syncing ${gapHours}h gap…`);
      } else {
        // No local data — fetch SYNC_DAYS of 1m history
        syncStartMs = nowMs - (SYNC_DAYS * 24 * 60 * 60 * 1000);
        setStatus(`Loading ${SYNC_DAYS} days of 1m history…`);
      }

      /* ── Phase 2: paginated REST fetch ──────────────────────────────────── */
      const newCandles = await fetchPaginatedHistory(
        syncStartMs,
        nowMs,
        (pct, count) => setStatus(`Syncing… ${pct}% (${count.toLocaleString()} bars)`),
      );

      /* ── Phase 3: merge into chart ──────────────────────────────────────── */
      if (existingCandles.length === 0) {
        // Fresh load — set timeframe to 1m and load everything
        setTimeframe('1m');
        if (newCandles.length > 0) {
          loadCandles(newCandles, newCandles[0].timestamp, newCandles[newCandles.length - 1].timestamp);
        }
        setStatus(`Loaded ${newCandles.length.toLocaleString()} candles`);
      } else {
        // Merge: only append candles newer than what we have
        const existingTimestamps = new Set(existingCandles.map(c => c.timestamp));
        const lastExistingTs = existingCandles.reduce((max, c) => Math.max(max, c.timestamp), 0);
        const missing = newCandles.filter(
          c => c.timestamp > lastExistingTs && !existingTimestamps.has(c.timestamp),
        );

        // Also update the last existing candle (might have been a partial bar)
        const updatedLast = newCandles.filter(c => c.timestamp === lastExistingTs);

        const toAppend = [...updatedLast, ...missing];
        if (toAppend.length > 0) {
          appendCandles(toAppend);
          setStatus(`Synced ${toAppend.length.toLocaleString()} candles`);
        } else {
          setStatus('Already up to date');
        }
      }

      /* ── Phase 4: open WebSocket for live updates ───────────────────────── */
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        setApiReachable(true);
        setStatus(`Live · ${SYMBOL} · connected`);
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: ['kline.1.BTCUSDT'],
        }));
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as BybitKlinePayload;
          if (!msg?.data?.length) return;
          const bar = parseWsBar(msg.data[0]);
          if (!bar) return;
          appendCandles([bar]);
          const price = bar.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          setStatus(`Live · $${price} · ${new Date(bar.timestamp).toLocaleTimeString()}`);
        } catch {
          // Ignore malformed frames
        }
      };

      ws.onerror = () => {
        setWsConnected(false);
        setStatus('WebSocket error');
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        setStatus('WebSocket closed');
      };
    } catch (e) {
      setWsConnected(false);
      setApiReachable(false);
      setStatus(`✗ ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [apiReachable, rawCandles, baseCandles, loadCandles, appendCandles, setTimeframe]);

  /* ── Derived UI state ───────────────────────────────────────────────────── */

  const isProbing = apiReachable === null;
  const canClick = apiReachable === true || wsConnected;
  const isDisabled = loading || (!canClick && !wsConnected);

  // Connection indicator color
  const dotColor = isProbing ? '#888' : apiReachable ? okColor : errorColor;
  const dotTitle = isProbing
    ? 'Checking Bybit connectivity…'
    : apiReachable
      ? (wsConnected ? 'Live WebSocket connected' : 'Bybit API reachable')
      : 'Bybit API unreachable — check your network';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {/* ── Connection status dot ─────────────────────────────────────────── */}
      <span
        title={dotTitle}
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: wsConnected ? `0 0 6px ${okColor}` : 'none',
          transition: 'background 0.3s, box-shadow 0.3s',
          flexShrink: 0,
        }}
      />

      {/* ── Live feed button ──────────────────────────────────────────────── */}
      <button
        onClick={wsConnected ? stopFeed : startFeed}
        disabled={isDisabled}
        style={{
          background: wsConnected ? accent : isDisabled ? disabledBg : 'transparent',
          color: wsConnected ? '#fff' : isDisabled ? disabledText : text,
          border: `1px solid ${wsConnected ? accent : isDisabled ? (theme === 'dark' ? '#333' : '#ccc') : border}`,
          borderRadius: 4,
          padding: '4px 8px',
          fontSize: 11,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
          opacity: isDisabled && !loading ? 0.5 : 1,
          transition: 'all 0.2s',
        }}
        title={
          isDisabled && !loading
            ? 'Bybit is unreachable — live feed unavailable'
            : wsConnected
              ? 'Click to disconnect live feed'
              : 'Sync missing data and connect live 1m feed'
        }
      >
        {loading ? '⏳ Syncing…' : wsConnected ? '■ Live' : '◉ Live Feed'}
      </button>

      {/* ── Status text ───────────────────────────────────────────────────── */}
      {status && (
        <span
          style={{
            color: status.startsWith('✗') ? errorColor : wsConnected ? okColor : text,
            fontSize: 11,
            maxWidth: 380,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            opacity: 0.85,
          }}
        >
          {status}
        </span>
      )}
    </div>
  );
};
