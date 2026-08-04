/**
 * DataLoader – file upload button that parses a CSV or JSON file and
 * loads the resulting OHLCV candles into the chart store.
 *
 * Accepts drag-and-drop or click-to-browse.
 */
import React, { useRef, useState, useCallback } from 'react';
import { useChartStore } from '../store/chartStore';
import { parseOHLCVFile, detectTimeframe } from '../utils/dataParser';

export const DataLoader: React.FC = () => {
  const { loadCandles, setTimeframe, theme } = useChartStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [dragging, setDragging] = useState(false);

  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#c8cad5';
  const accent = '#2962ff';
  const errorColor = '#ef5350';
  const okColor = '#26a69a';

  async function processFile(file: File) {
    setStatus('loading');
    setMessage(`Parsing ${file.name}…`);
    try {
      const { candles, errors, symbol } = await parseOHLCVFile(file);

      if (candles.length === 0) {
        setStatus('error');
        setMessage(errors[0] ?? 'No valid candles found.');
        return;
      }

      const tf = detectTimeframe(candles);
      const startMs = candles[0].timestamp;
      const endMs = candles[candles.length - 1].timestamp;

      setTimeframe(tf);
      loadCandles(candles, startMs, endMs);

      const warningStr = errors.length > 0 ? ` (${errors.length} rows skipped)` : '';
      setStatus('ok');
      setMessage(`Loaded ${candles.length.toLocaleString()} candles${symbol ? ` · ${symbol}` : ''} · ${tf}${warningStr}`);
    } catch (e) {
      setStatus('error');
      setMessage((e as Error).message);
    }
  }

  const handleFile = useCallback((file: File | undefined) => {
    if (!file) return;
    processFile(file);
  }, [loadCandles, setTimeframe, theme]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFile(e.target.files?.[0]);
    // reset so the same file can be re-uploaded
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  const btnStyle: React.CSSProperties = {
    background: 'transparent',
    color: text,
    border: `1px solid ${border}`,
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  const statusColor = status === 'ok' ? okColor : status === 'error' ? errorColor : text;

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <button
        style={{
          ...btnStyle,
          borderColor: dragging ? accent : border,
          color: dragging ? accent : text,
        }}
        onClick={() => inputRef.current?.click()}
        title="Upload CSV or JSON OHLCV file"
      >
        {status === 'loading' ? '⏳ Loading…' : '↑ Load data'}
      </button>

      {message && (
        <span style={{ fontSize: 11, color: statusColor, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {message}
        </span>
      )}

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.json,.txt,.tsv"
        style={{ display: 'none' }}
        onChange={handleInputChange}
      />
    </div>
  );
};
