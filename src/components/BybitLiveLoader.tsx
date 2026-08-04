/**
 * BybitLiveLoader – public BTCUSDT perpetual live feed bridge.
 *
 * Steps:
 *   1) Fetch recent 1-minute candles from Bybit REST.
 *   2) Load them into the chart as the initial dataset.
 *   3) Open a public websocket subscription for live kline updates.
 *   4) Append each new candle into the live chart.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { resampleCandles } from '../engine/resampleEngine';
import { detectTimeframe } from '../utils/dataParser';
import type { RawCandle } from '../types';

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
  }>;
}

interface BybitRestKlineResponse {
  result?: {
    list?: Array<string[]>;
  };
}

const WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const REST_URL = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=5&limit=1000';
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const EARLIEST_ACCEPTABLE_TS = Date.UTC(2000, 0, 1);

export const BybitLiveLoader: React.FC = () => {
  const { loadCandles, appendCandles, setTimeframe, theme, rawCandles, baseTimeframe } = useChartStore();
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState('');
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);

  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#c8cad5';
  const okColor = '#26a69a';
  const errorColor = '#ef5350';
  const accent = '#2962ff';

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const toTimestampMs = (value: string | number | undefined): number => {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return 0;
    // Bybit REST returns start in ms already; websocket frames also use ms.
    // If the incoming payload is a seconds-based epoch, convert once to ms.
    return n > 1e12 ? n : n > 1e9 ? n : n * 1000;
  };

  const normalizeBybitBar = (row: { start: string | number; timestamp?: string | number; open: string | number; high: string | number; low: string | number; close: string | number; volume: string | number }): RawCandle => ({
    timestamp: toTimestampMs(row.start ?? row.timestamp),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    symbol: 'BTCUSDT',
    exchange: 'Bybit',
  });

  const isValidBar = (bar: RawCandle): boolean => {
    return Number.isFinite(bar.timestamp) && bar.timestamp >= EARLIEST_ACCEPTABLE_TS;
  };

  const fetchHistory = async (): Promise<RawCandle[]> => {
    const resp = await fetch(REST_URL);
    if (!resp.ok) {
      throw new Error(`Bybit REST request failed: ${resp.status}`);
    }

    const payload = (await resp.json()) as BybitRestKlineResponse;
    const list = payload.result?.list ?? [];
    if (!list.length) {
      throw new Error('Bybit returned no kline history.');
    }

    return list
      .map((row) => {
        const [start, open, high, low, close, volume] = row;
        const bar = {
          timestamp: toTimestampMs(start),
          open: Number(open),
          high: Number(high),
          low: Number(low),
          close: Number(close),
          volume: Number(volume),
          symbol: 'BTCUSDT',
          exchange: 'Bybit',
        } as RawCandle;
        return isValidBar(bar) ? bar : null;
      })
      .filter((bar): bar is RawCandle => bar !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  };

  const stopFeed = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnected(false);
    setStatus('Bybit live feed stopped');
  };

  const startFeed = async () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setStatus('Bybit live feed already connected');
      return;
    }

    setLoading(true);
    setStatus('Loading BTCUSDT history…');

    try {
      const candles = await fetchHistory();

      if (rawCandles.length === 0) {
        setTimeframe('5m');
        loadCandles(candles, candles[0].timestamp, candles[candles.length - 1].timestamp);
      } else {
        const currentTf = baseTimeframe ?? detectTimeframe(rawCandles);
        const localForSync = currentTf === '5m' ? rawCandles : resampleCandles(rawCandles, '5m');
        const localTsStart = localForSync[0]?.timestamp ?? rawCandles[0]?.timestamp ?? 0;
        const localTsEnd = localForSync[localForSync.length - 1]?.timestamp ?? rawCandles[rawCandles.length - 1]?.timestamp ?? 0;

        if (currentTf !== '5m') {
          setTimeframe('5m');
          loadCandles(localForSync, localTsStart, localTsEnd);
          setStatus('Resampled local history to 5m for live sync');
        }

        const lastLocalTs = localForSync.reduce((maxTs, c) => Math.max(maxTs, c.timestamp), 0);
        const existingTimes = new Set(localForSync.map(c => c.timestamp));
        const missingTail = candles
          .filter(c => c.timestamp > lastLocalTs)
          .filter(c => !existingTimes.has(c.timestamp));

        if (missingTail.length > 0) {
          appendCandles(missingTail);
          setStatus(`Synced ${missingTail.length} missing BTCUSDT 5m candles`);
        } else {
          const expectedNext = lastLocalTs + FIVE_MINUTES_MS;
          const nearestLive = candles.find(c => c.timestamp >= expectedNext);
          setStatus(nearestLive ? 'BTCUSDT history already aligned with the live chart' : 'BTCUSDT live tail is up to date');
        }
      }

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        const liveStatus = rawCandles.length === 0
          ? `Bybit live BTCUSDT 5m connected · ${candles.length} history candles`
          : `Bybit live BTCUSDT 5m connected · history synced`;
        setStatus(liveStatus);
        ws.send(JSON.stringify({
          op: 'subscribe',
          args: ['kline.5.BTCUSDT'],
        }));
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data) as BybitKlinePayload;
          if (!msg?.data?.length) return;
          const latest = normalizeBybitBar(msg.data[0]);
          if (!isValidBar(latest)) return;
          appendCandles([latest]);
          setStatus(`Live BTCUSDT · ${new Date(latest.timestamp).toLocaleTimeString()} · ${latest.close}`);
        } catch {
          // Ignore malformed frames silently.
        }
      };

      ws.onerror = () => {
        setConnected(false);
        setStatus('✗ Bybit websocket error');
      };

      ws.onclose = () => {
        setConnected(false);
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
      };
    } catch (e) {
      setConnected(false);
      setStatus(`✗ ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <button
        onClick={connected ? stopFeed : startFeed}
        disabled={loading}
        style={{
          background: connected ? accent : 'transparent',
          color: connected ? '#fff' : text,
          border: `1px solid ${connected ? accent : border}`,
          borderRadius: 4,
          padding: '4px 8px',
          fontSize: 11,
          cursor: loading ? 'wait' : 'pointer',
          whiteSpace: 'nowrap',
        }}
        title="Load local 5m history first, then connect to the public Bybit BTCUSDT perpetual live feed"
      >
        {loading ? '⏳' : connected ? '■' : '◉'} {connected ? 'Live' : 'Live Feed'}
      </button>

      <span style={{ color: text, fontSize: 10, opacity: 0.7 }}>
        Load 5m history first, then sync the live tail
      </span>

      {status && (
        <span
          style={{
            color: status.startsWith('✗') ? errorColor : connected ? okColor : text,
            fontSize: 11,
            maxWidth: 340,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {status}
        </span>
      )}
    </div>
  );
};
