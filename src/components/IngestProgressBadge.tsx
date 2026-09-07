/**
 * IngestProgressBadge — small toast that appears while the manifest ingest
 * is running in the background. Listens to the `manifest-ingest-progress`
 * window event dispatched by `ingestManifest()`.
 */
import React, { useEffect, useState } from 'react';
import { useChartStore } from '../store/chartStore';

interface ProgressState {
  processed: number;
  total: number;
  phase?: 'start' | 'progress' | 'done';
  message?: string;
}

export const IngestProgressBadge: React.FC = () => {
  const { theme } = useChartStore();
  const [state, setState] = useState<ProgressState | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ProgressState>).detail;
      if (!detail) return;
      setState(detail);
      if (detail.phase === 'done') {
        // Auto-hide 3 s after completion.
        setTimeout(() => setState(null), 3000);
      }
    };
    window.addEventListener('manifest-ingest-progress', handler);
    return () => window.removeEventListener('manifest-ingest-progress', handler);
  }, []);

  if (!state) return null;
  const pct = state.total > 0 ? Math.min(100, Math.round((state.processed / state.total) * 100)) : 0;
  const bg     = theme === 'dark' ? '#131722' : '#ffffff';
  const border = theme === 'dark' ? '#2a2e39' : '#c8cad5';
  const text   = theme === 'dark' ? '#d1d4dc' : '#131722';
  const accent = '#2962ff';
  const done = state.phase === 'done';

  return (
    <div style={{
      position: 'fixed', top: 12, right: 12, zIndex: 900,
      background: bg, color: text, border: `1px solid ${border}`,
      borderRadius: 6, padding: '8px 12px', minWidth: 220,
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)', fontSize: 11,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>{done ? 'Ingest complete' : 'Ingesting data…'}</strong>
        <span style={{ opacity: 0.7 }}>{state.processed} / {state.total}</span>
      </div>
      <div style={{
        height: 4, background: border, borderRadius: 2, marginTop: 4, overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: accent,
          transition: 'width 0.15s ease-out',
        }} />
      </div>
      {state.message && (
        <div style={{ marginTop: 4, opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {state.message}
        </div>
      )}
    </div>
  );
};
