/**
 * IngestionPanel — admin surface for pushing data into IndexedDB.
 *
 * Renders the ADAPTERS registry as a source picker, auto-generates the
 * per-adapter form from `paramsSchema`, streams live progress from the
 * ingest service, and shows the adapter's accepted format + source info
 * so the user knows exactly what shape of data to provide.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { listAdapters } from '../ingestion/registry';
import { ingest, type IngestProgress } from '../ingestion/ingestionService';
import type { FieldDef, IngestMode, SourceParams } from '../ingestion/types';
import { MARKET_PRESET_LIST } from '../engine/marketPresets';
import { detectTimeframe } from '../utils/dataParser';
import type { RawCandle, Timeframe } from '../types';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '10m', '15m', '1h', '4h', '1d', '1w', '1M'];

interface IngestionPanelProps {
  initial?: { market?: string; symbol?: string; timeframe?: Timeframe };
  onClose: (didIngest: boolean) => void;
}

type Outcome = null
  | { kind: 'success'; message: string }
  | { kind: 'skipped'; message: string }
  | { kind: 'error'; message: string };

interface PreviewInfo {
  rows: number;
  first: RawCandle;
  last: RawCandle;
  detectedTimeframe: Timeframe;
  detectedSymbol?: string;
}

export const IngestionPanel: React.FC<IngestionPanelProps> = ({ initial, onClose }) => {
  const { theme } = useChartStore();
  const adapters = useMemo(() => listAdapters(), []);
  const [sourceId, setSourceId] = useState(adapters[0]?.id ?? '');
  const [market, setMarket]     = useState(initial?.market ?? 'crypto');
  const [symbol, setSymbol]     = useState(initial?.symbol ?? '');
  const [tf, setTf]             = useState<Timeframe>(initial?.timeframe ?? '1m');
  const [extras, setExtras]     = useState<Record<string, unknown>>({});
  const [busy, setBusy]         = useState(false);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [outcome, setOutcome]   = useState<Outcome>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showFormat, setShowFormat] = useState(false);
  const [mode, setMode]         = useState<IngestMode>('append-only');
  const [preview, setPreview]   = useState<PreviewInfo | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [didIngest, setDidIngest] = useState(false);

  const bg      = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const bgSoft  = theme === 'dark' ? '#131722' : '#ffffff';
  const bgCode  = theme === 'dark' ? '#0d1117' : '#f6f8fa';
  const text    = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border  = theme === 'dark' ? '#2a2e39' : '#c8cad5';
  const accent  = '#2962ff';
  const okColor = '#26a69a';
  const warn    = '#f5a623';

  const adapter = adapters.find(a => a.id === sourceId);

  const setExtra = (k: string, v: unknown) => setExtras(prev => ({ ...prev, [k]: v }));

  // Runs the adapter's fetch WITHOUT touching the DB so the user can verify
  // the data was parsed correctly before committing.
  const handlePreview = useCallback(async () => {
    if (!adapter) return;
    setPreviewBusy(true);
    setPreview(null);
    setOutcome(null);
    try {
      const params: SourceParams = { market, symbol: symbol.trim() || 'PREVIEW', timeframe: tf, extras };
      const { candles, meta, warnings: fetchWarnings } = await adapter.fetch(params);
      if (!candles.length) {
        setOutcome({ kind: 'error', message: 'Preview: adapter returned 0 rows. Check the format hint below.' });
        return;
      }
      const detectedTf = detectTimeframe(candles);
      const detectedSym = candles[0]?.symbol ?? meta?.description;
      const info: PreviewInfo = {
        rows: candles.length,
        first: candles[0],
        last: candles[candles.length - 1],
        detectedTimeframe: detectedTf,
        detectedSymbol: detectedSym,
      };
      setPreview(info);
      if (detectedSym && !symbol.trim()) setSymbol(detectedSym);
      if (detectedTf !== tf) setTf(detectedTf);
      if (fetchWarnings?.length) setWarnings(fetchWarnings);
      // eslint-disable-next-line no-console
      console.info('[ingest:preview]', { adapter: adapter.id, info, warnings: fetchWarnings });
    } catch (e) {
      const msg = (e as Error).message;
      setOutcome({ kind: 'error', message: `Preview failed: ${msg}` });
      // eslint-disable-next-line no-console
      console.error('[ingest:preview] failed', e);
    } finally {
      setPreviewBusy(false);
    }
  }, [adapter, market, symbol, tf, extras]);

  // Auto-preview when the file/URL changes so the user immediately sees what
  // was parsed.
  useEffect(() => {
    if (!adapter) return;
    if (adapter.id === 'csv-file' && !extras.file) return;
    if (adapter.id === 'csv-url'  && !extras.url) return;
    if (adapter.id !== 'csv-file' && adapter.id !== 'csv-url') return;
    void handlePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extras.file, extras.url, adapter?.id]);

  const renderField = (f: FieldDef) => {
    const commonStyle: React.CSSProperties = {
      background: bgSoft, color: text, border: `1px solid ${border}`,
      borderRadius: 4, padding: '4px 8px', fontSize: 12, width: '100%',
    };
    switch (f.kind) {
      case 'text':
      case 'url':
      case 'password':
        return (
          <input
            type={f.kind === 'password' ? 'password' : f.kind === 'url' ? 'url' : 'text'}
            placeholder={f.placeholder}
            defaultValue={f.defaultValue as string | undefined}
            onChange={e => setExtra(f.name, e.target.value)}
            style={commonStyle}
          />
        );
      case 'number':
        return (
          <input
            type="number"
            defaultValue={f.defaultValue as number | undefined}
            onChange={e => setExtra(f.name, e.target.value === '' ? undefined : Number(e.target.value))}
            style={commonStyle}
          />
        );
      case 'date':
        return (
          <input
            type="date"
            onChange={e => setExtra(f.name, e.target.value ? new Date(e.target.value).getTime() : undefined)}
            style={commonStyle}
          />
        );
      case 'select':
        return (
          <select
            defaultValue={f.defaultValue as string | undefined}
            onChange={e => setExtra(f.name, e.target.value)}
            style={commonStyle}
          >
            {(f.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        );
      case 'file':
        return (
          <input
            type="file"
            accept={f.accept}
            onChange={e => setExtra(f.name, e.target.files?.[0])}
            style={{ ...commonStyle, padding: 4 }}
          />
        );
      default:
        return null;
    }
  };

  const handleIngest = useCallback(async () => {
    if (!adapter) return;
    if (!symbol.trim()) { setOutcome({ kind: 'error', message: 'Symbol is required.' }); return; }
    setBusy(true);
    setOutcome(null);
    setWarnings([]);
    setProgress({ phase: 'fetching', message: `Contacting ${adapter.label}…` });
    // eslint-disable-next-line no-console
    console.info('[ingest] start', { adapter: adapter.id, market, symbol: symbol.trim(), tf, mode, extras });
    try {
      const params: SourceParams = { market, symbol: symbol.trim(), timeframe: tf, extras };
      const summary = await ingest(adapter.id, params, { mode, onProgress: p => setProgress(p) });
      // eslint-disable-next-line no-console
      console.info('[ingest] done', summary);
      const range = summary.firstTs && summary.lastTs
        ? ` · ${new Date(summary.firstTs).toISOString().slice(0, 10)} → ${new Date(summary.lastTs).toISOString().slice(0, 10)}`
        : '';
      const parts: string[] = [];
      if (summary.rows > 0) parts.push(`${summary.rows.toLocaleString()} written`);
      if (summary.skippedRows && summary.skippedRows > 0) parts.push(`${summary.skippedRows.toLocaleString()} skipped (already in DB)`);
      if (summary.overwrittenRows && summary.overwrittenRows > 0) parts.push(`${summary.overwrittenRows.toLocaleString()} amended`);
      if (summary.rows === 0 && (summary.skippedRows ?? 0) === 0) {
        setOutcome({ kind: 'error', message: 'The adapter returned 0 rows. Click "Preview" to see what the parser produced.' });
      } else if (summary.rows === 0 && (summary.skippedRows ?? 0) > 0) {
        setOutcome({
          kind: 'skipped',
          message:
            `Nothing new to save — all ${summary.skippedRows!.toLocaleString()} rows are already in the DB ` +
            `for ${market}/${symbol.trim()}/${tf}. Switch write mode to "Amend + overwrite" if the file has corrections.`,
        });
        setDidIngest(true);
      } else {
        setOutcome({ kind: 'success', message: `${parts.join(' · ')} in ${summary.durationMs.toFixed(0)} ms${range}` });
        setDidIngest(true);
      }
      if (summary.warnings?.length) setWarnings(summary.warnings);
    } catch (e) {
      const msg = (e as Error).message;
      // eslint-disable-next-line no-console
      console.error('[ingest] failed', e);
      setOutcome({ kind: 'error', message: msg });
    } finally {
      setBusy(false);
    }
  }, [adapter, market, symbol, tf, extras, mode]);

  const btnStyle: React.CSSProperties = {
    background: 'transparent', color: text, border: `1px solid ${border}`,
    borderRadius: 4, padding: '6px 12px', fontSize: 12, cursor: 'pointer',
  };
  const fieldStyle: React.CSSProperties = {
    background: bgSoft, color: text, border: `1px solid ${border}`,
    borderRadius: 4, padding: '4px 8px', fontSize: 12, width: '100%',
  };

  const progressPct = progress?.phase === 'saving' && progress.total > 0
    ? Math.min(100, Math.round((progress.saved / progress.total) * 100))
    : null;

  return (
    <div
      onClick={() => onClose(didIngest)}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: bg, color: text, border: `1px solid ${border}`, borderRadius: 8,
          padding: 16, width: 640, maxHeight: '90vh', overflow: 'auto',
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>Ingest data into DB</h3>
          <button style={btnStyle} onClick={() => onClose(didIngest)}>Close</button>
        </div>

        {/* Source picker + description */}
        <label style={{ fontSize: 11, opacity: 0.7 }}>Source</label>
        <select
          value={sourceId}
          onChange={e => { setSourceId(e.target.value); setExtras({}); setOutcome(null); setPreview(null); setProgress(null); }}
          style={{ ...fieldStyle, marginBottom: 6 }}
        >
          {adapters.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        {adapter?.description && <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 4 }}>{adapter.description}</div>}
        {adapter?.sourceInfo && (
          <div style={{
            background: bgSoft, border: `1px solid ${border}`, borderRadius: 4,
            padding: 8, fontSize: 11, opacity: 0.9, marginBottom: 8,
          }}>
            <strong style={{ fontSize: 10, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 }}>Where the data comes from</strong>
            <div style={{ marginTop: 4 }}>{adapter.sourceInfo}</div>
            {adapter.docsUrl && (
              <div style={{ marginTop: 4 }}>
                <a href={adapter.docsUrl} target="_blank" rel="noreferrer" style={{ color: accent }}>Docs ↗</a>
              </div>
            )}
          </div>
        )}

        {/* Target series */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          <div>
            <label style={{ fontSize: 11, opacity: 0.7 }}>Market</label>
            <select value={market} onChange={e => setMarket(e.target.value)} style={fieldStyle}>
              {MARKET_PRESET_LIST.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, opacity: 0.7 }}>Symbol</label>
            <input value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="e.g. BTCUSDT, SPY, EURUSD" style={fieldStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, opacity: 0.7 }}>Timeframe</label>
            <select value={tf} onChange={e => setTf(e.target.value as Timeframe)} style={fieldStyle}>
              {TIMEFRAMES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        {/* Adapter params */}
        {adapter && adapter.paramsSchema.length > 0 && (
          <div style={{ borderTop: `1px solid ${border}`, paddingTop: 8, marginBottom: 10 }}>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>{adapter.label} parameters</div>
            {adapter.paramsSchema.map(f => (
              <div key={f.name} style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 11, opacity: 0.7, display: 'block', marginBottom: 2 }}>
                  {f.label}{f.required ? ' *' : ''}
                </label>
                {renderField(f)}
                {f.help && <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2 }}>{f.help}</div>}
              </div>
            ))}
          </div>
        )}

        {/* Accepted format */}
        {adapter?.expectedFormat && (
          <div style={{ borderTop: `1px solid ${border}`, paddingTop: 8, marginBottom: 10 }}>
            <button
              type="button"
              onClick={() => setShowFormat(v => !v)}
              style={{ ...btnStyle, padding: '2px 8px', fontSize: 11 }}
            >
              {showFormat ? '▾ Hide accepted format' : '▸ Show accepted format'}
            </button>
            {showFormat && (
              <pre style={{
                background: bgCode, color: text, border: `1px solid ${border}`, borderRadius: 4,
                padding: 10, fontSize: 11, lineHeight: 1.4, marginTop: 6,
                whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto',
              }}>{adapter.expectedFormat}</pre>
            )}
          </div>
        )}

        {/* Write mode */}
        <div style={{
          border: `1px solid ${border}`, borderRadius: 4, padding: 8, marginBottom: 8,
          background: bgSoft, fontSize: 11,
        }}>
          <div style={{ opacity: 0.7, marginBottom: 4 }}>Write mode</div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="radio" checked={mode === 'append-only'} onChange={() => setMode('append-only')} />
            <span>
              <strong>Append new only</strong> (recommended)
              <div style={{ opacity: 0.65, marginTop: 2 }}>
                Skip rows whose timestamp is already stored. Fast — re-ingesting the same file is nearly instant.
              </div>
            </span>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer', marginTop: 6 }}>
            <input type="radio" checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} />
            <span>
              <strong>Amend + overwrite</strong>
              <div style={{ opacity: 0.65, marginTop: 2 }}>
                Overwrite every matching row. Use when you're re-ingesting a file with corrections in the middle.
              </div>
            </span>
          </label>
        </div>

        {/* Preview */}
        <div style={{
          border: `1px solid ${border}`, borderRadius: 4, padding: 8, marginBottom: 8,
          background: bgSoft, fontSize: 11,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ opacity: 0.7 }}>Preview (parses the source without writing)</div>
            <button
              type="button"
              onClick={handlePreview}
              disabled={previewBusy || busy}
              style={{ ...btnStyle, padding: '2px 8px', fontSize: 11 }}
            >
              {previewBusy ? 'Parsing…' : (preview ? '↻ Re-preview' : '👁 Preview')}
            </button>
          </div>
          {preview && (
            <div style={{ marginTop: 6 }}>
              <div>
                Rows: <strong>{preview.rows.toLocaleString()}</strong>
                {' · '}Detected TF: <strong>{preview.detectedTimeframe}</strong>
                {preview.detectedSymbol && <> · Detected symbol: <strong>{preview.detectedSymbol}</strong></>}
              </div>
              <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 10, opacity: 0.85 }}>
                First: {new Date(preview.first.timestamp).toISOString()}  O={preview.first.open} H={preview.first.high} L={preview.first.low} C={preview.first.close} V={preview.first.volume}
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.85 }}>
                Last:  {new Date(preview.last.timestamp).toISOString()}  O={preview.last.open} H={preview.last.high} L={preview.last.low} C={preview.last.close} V={preview.last.volume}
              </div>
            </div>
          )}
          {!preview && !previewBusy && (
            <div style={{ marginTop: 4, opacity: 0.55 }}>
              Click Preview to parse the file/URL and see what was extracted before saving.
            </div>
          )}
        </div>

        {/* Action */}
        <button
          onClick={handleIngest}
          disabled={busy}
          style={{ ...btnStyle, width: '100%', background: accent, color: '#fff', borderColor: accent, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? (progress?.message ?? 'Working…') : 'Fetch & save to DB'}
        </button>

        {/* Progress bar */}
        {progressPct !== null && (
          <div style={{
            height: 6, background: bgSoft, border: `1px solid ${border}`, borderRadius: 3,
            marginTop: 8, overflow: 'hidden',
          }}>
            <div style={{ height: '100%', width: `${progressPct}%`, background: accent, transition: 'width 0.15s' }} />
          </div>
        )}

        {/* Outcome banner */}
        {outcome && (
          <div style={{
            marginTop: 10, padding: 8, borderRadius: 4, fontSize: 12,
            background: outcome.kind === 'success' ? 'rgba(38,166,154,0.12)'
                     : outcome.kind === 'skipped' ? 'rgba(245,166,35,0.14)'
                     : 'rgba(239,83,80,0.14)',
            border: `1px solid ${
              outcome.kind === 'success' ? okColor
              : outcome.kind === 'skipped' ? warn
              : '#ef5350'
            }`,
            color: outcome.kind === 'success' ? okColor
                 : outcome.kind === 'skipped' ? warn
                 : '#ef5350',
          }}>
            <strong>
              {outcome.kind === 'success' ? '✓ Ingested' : outcome.kind === 'skipped' ? '⚠ Nothing new' : '✗ Failed'}
            </strong>
            <div style={{ marginTop: 4, color: text, opacity: 0.9 }}>{outcome.message}</div>
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <ul style={{ marginTop: 6, paddingLeft: 16, fontSize: 11, color: warn }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
};
