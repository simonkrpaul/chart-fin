/**
 * LayoutManager – save / load / delete named chart snapshots.
 *
 * A snapshot captures: timeframe, theme, indicators, drawings, overlays,
 * viewport position, and price scale.  The raw candle data is NOT saved
 * (dataset URL is stored separately via RemoteLoader).
 */
import React, { useState, useRef, useEffect } from 'react';
import { useChartStore } from '../store/chartStore';
import { saveLayout, listLayouts, deleteLayout } from '../db/persistence';
import type { ChartLayout } from '../types';

export const LayoutManager: React.FC = () => {
  const { exportLayout, importLayout, theme } = useChartStore();

  const [open, setOpen]       = useState(false);
  const [name, setName]       = useState('');
  const [layouts, setLayouts] = useState<ChartLayout[]>([]);
  const [status, setStatus]   = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  const text    = theme === 'dark' ? '#d1d4dc' : '#131722';
  const bg      = theme === 'dark' ? '#1e222d' : '#ffffff';
  const border  = theme === 'dark' ? '#2a2e39' : '#e0e3eb';
  const hover   = theme === 'dark' ? '#2a2e39' : '#f0f3fa';
  const accent  = '#2962ff';
  const danger  = '#ef5350';
  const ok      = '#26a69a';

  // Refresh list whenever the panel opens
  useEffect(() => {
    if (open) setLayouts(listLayouts());
  }, [open]);

  // Close when clicking outside
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) { setStatus('⚠ Please enter a name'); return; }
    const layout = exportLayout();
    saveLayout({ ...layout, name: trimmed });
    setLayouts(listLayouts());
    setStatus(`✓ Saved "${trimmed}"`);
    setTimeout(() => setStatus(''), 2500);
  }

  function handleLoad(layout: ChartLayout) {
    importLayout(layout);
    setStatus(`✓ Loaded "${layout.name}"`);
    setOpen(false);
    setTimeout(() => setStatus(''), 2500);
  }

  function handleDelete(e: React.MouseEvent, id: string, layoutName: string) {
    e.stopPropagation();
    deleteLayout(id);
    setLayouts(listLayouts());
    setStatus(`Deleted "${layoutName}"`);
    setTimeout(() => setStatus(''), 2000);
  }

  const btnBase: React.CSSProperties = {
    border: `1px solid ${border}`,
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 11,
    cursor: 'pointer',
    transition: 'background 0.1s',
  };

  return (
    <div ref={panelRef} style={{ position: 'relative', display: 'inline-block' }}>
      {/* Trigger button */}
      <button
        style={{ ...btnBase, background: open ? accent : 'transparent', color: open ? '#fff' : text }}
        onClick={() => setOpen(v => !v)}
        title="Save or load named chart layouts"
      >
        ⊞ Layouts
      </button>

      {/* Status badge (shows briefly outside the panel) */}
      {!open && status && (
        <span style={{ marginLeft: 6, fontSize: 11, color: status.startsWith('✓') ? ok : text }}>
          {status}
        </span>
      )}

      {/* Dropdown panel */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 100,
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: 6,
            padding: 12,
            width: 280,
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {/* Save row */}
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
              placeholder="Layout name…"
              style={{
                flex: 1,
                background: hover,
                color: text,
                border: `1px solid ${border}`,
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 12,
                outline: 'none',
              }}
            />
            <button
              style={{ ...btnBase, background: accent, color: '#fff', border: 'none' }}
              onClick={handleSave}
            >
              Save
            </button>
          </div>

          {/* Status */}
          {status && (
            <span style={{ fontSize: 11, color: status.startsWith('✓') ? ok : '#f5a623' }}>
              {status}
            </span>
          )}

          {/* Saved layouts list */}
          {layouts.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: text, opacity: 0.5, marginBottom: -4 }}>
                Saved layouts
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
                {layouts.map(l => (
                  <div
                    key={l.id}
                    onClick={() => handleLoad(l)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 8px',
                      borderRadius: 4,
                      cursor: 'pointer',
                      background: 'transparent',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = hover)}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div>
                      <span style={{ color: text, fontSize: 12 }}>{l.name}</span>
                      <span style={{ color: text, fontSize: 10, opacity: 0.45, marginLeft: 8 }}>
                        {l.timeframe} · {new Date(l.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                    <button
                      title="Delete"
                      onClick={e => handleDelete(e, l.id, l.name)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: danger,
                        fontSize: 13,
                        cursor: 'pointer',
                        padding: '0 4px',
                        lineHeight: 1,
                        opacity: 0.7,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {layouts.length === 0 && (
            <span style={{ fontSize: 11, color: text, opacity: 0.4, textAlign: 'center' }}>
              No saved layouts yet
            </span>
          )}
        </div>
      )}
    </div>
  );
};
