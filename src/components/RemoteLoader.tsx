/**
 * RemoteLoader – fetches a CSV/JSON file from a URL and loads it into the chart.
 * Used for quick-loading pre-generated datasets from public/data/.
 *
 * Loading 5m data automatically enables all higher timeframes (10m, 15m, 1h,
 * 4h, 1d, 1w, 1M) via the resample engine — just switch the TF selector.
 */
import React, { useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { parseOHLCVFile, detectTimeframe } from '../utils/dataParser';
import { saveDataset, clearPersisted } from '../db/persistence';

interface QuickDataset {
  label: string;
  url: string;
  symbol: string;
  hint?: string;
}

const QUICK_DATASETS: QuickDataset[] = [
  { label: 'BTC 1m', url: '/data/btc_1m.csv', symbol: 'BTC/USD', hint: 'Loads 1m data — resample to any higher TF' },
  { label: 'BTC 5m', url: '/data/btc_5m.csv', symbol: 'BTC/USD', hint: 'Loads 5m data — switch any TF to auto-resample' },
  { label: 'BTC 1d', url: '/data/btc_1d.csv', symbol: 'BTC/USD' },
  { label: 'BTC 1h', url: '/data/btc_1h.csv', symbol: 'BTC/USD', hint: 'Loads 1h — resample to 4h/1d/1w/1M' },
];

export const RemoteLoader: React.FC = () => {
  const { loadCandles, setTimeframe, theme } = useChartStore();
  const [loading, setLoading] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const text   = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#c8cad5';
  const okColor    = '#26a69a';
  const errorColor = '#ef5350';

  async function loadDataset(ds: QuickDataset) {
    setLoading(ds.label);
    setStatus('');
    try {
      const resp = await fetch(ds.url);
      if (!resp.ok) throw new Error(`${ds.url} not found — run scripts/download_btc.py first`);
      const text_content = await resp.text();
      // Create a synthetic File object so we can reuse the existing parser
      const file = new File([text_content], ds.url.split('/').pop()!, { type: 'text/csv' });
      const { candles, errors } = await parseOHLCVFile(file);

      if (!candles.length) throw new Error(errors[0] ?? 'No valid candles');

      const tf = detectTimeframe(candles);
      setTimeframe(tf);
      loadCandles(candles, candles[0].timestamp, candles[candles.length - 1].timestamp);

      // Persist URL so the dataset auto-reloads on the next page visit
      saveDataset({ url: ds.url, symbol: ds.symbol });

      const warn = errors.length ? ` (${errors.length} rows skipped)` : '';
      setStatus(`✓ ${ds.symbol} · ${candles.length.toLocaleString()} candles · ${tf}${warn}`);
    } catch (e) {
      setStatus(`✗ ${(e as Error).message}`);
    } finally {
      setLoading(null);
    }
  }

  const isError = status.startsWith('✗');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: text, fontSize: 11, opacity: 0.6 }}>Quick load:</span>
      {QUICK_DATASETS.map(ds => (
        <button
          key={ds.url}
          disabled={loading !== null}
          onClick={() => loadDataset(ds)}
          title={ds.hint}
          style={{
            background: 'transparent',
            color: loading === ds.label ? '#2962ff' : text,
            border: `1px solid ${border}`,
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 11,
            cursor: loading !== null ? 'wait' : 'pointer',
            opacity: loading !== null && loading !== ds.label ? 0.5 : 1,
          }}
        >
          {loading === ds.label ? '⏳' : ''}{ds.label}
        </button>
      ))}
      {status && (
        <span style={{ fontSize: 11, color: isError ? errorColor : okColor, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {status}
        </span>
      )}

      <div style={{ width: 1, height: 20, background: border, margin: '0 4px' }} />

      {/* Clear persisted data */}
      <button
        title="Clear all saved preferences and reload the page"
        onClick={() => { clearPersisted(); window.location.reload(); }}
        style={{
          background: 'transparent',
          color: text,
          border: `1px solid ${border}`,
          borderRadius: 4,
          padding: '4px 8px',
          fontSize: 11,
          cursor: 'pointer',
          opacity: 0.6,
        }}
      >
        ✕ Reset
      </button>
    </div>
  );
};
