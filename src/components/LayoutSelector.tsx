/**
 * LayoutSelector – toolbar widget for choosing the chart panel layout
 * and toggling the sync-lock scroll feature.
 *
 * Shows TradingView-style layout icons (simple CSS grid previews) in a
 * dropdown popup, plus a sync-lock checkbox below.
 */
import React, { useState, useRef, useEffect } from 'react';
import { useLayoutStore } from '../store/layoutStore';
import type { LayoutType } from '../store/layoutStore';
import { useChartStore } from '../store/chartStore';

/** Small SVG-like CSS box icon for each layout */
const LAYOUT_OPTIONS: { type: LayoutType; label: string; icon: React.ReactNode }[] = [
  {
    type: '1',
    label: 'Single',
    icon: (
      <div style={{ width: 28, height: 20, border: '1.5px solid currentColor', borderRadius: 2 }} />
    ),
  },
  {
    type: '2h',
    label: '2 Columns',
    icon: (
      <div style={{ width: 28, height: 20, display: 'flex', gap: 2 }}>
        <div style={{ flex: 1, border: '1.5px solid currentColor', borderRadius: 2 }} />
        <div style={{ flex: 1, border: '1.5px solid currentColor', borderRadius: 2 }} />
      </div>
    ),
  },
  {
    type: '2v',
    label: '2 Rows',
    icon: (
      <div style={{ width: 28, height: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ flex: 1, border: '1.5px solid currentColor', borderRadius: 2 }} />
        <div style={{ flex: 1, border: '1.5px solid currentColor', borderRadius: 2 }} />
      </div>
    ),
  },
  {
    type: '3h',
    label: '3 Columns',
    icon: (
      <div style={{ width: 28, height: 20, display: 'flex', gap: 2 }}>
        <div style={{ flex: 1, border: '1.5px solid currentColor', borderRadius: 2 }} />
        <div style={{ flex: 1, border: '1.5px solid currentColor', borderRadius: 2 }} />
        <div style={{ flex: 1, border: '1.5px solid currentColor', borderRadius: 2 }} />
      </div>
    ),
  },
  {
    type: '2x2',
    label: '2×2 Grid',
    icon: (
      <div style={{ width: 28, height: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        <div style={{ border: '1.5px solid currentColor', borderRadius: 2 }} />
        <div style={{ border: '1.5px solid currentColor', borderRadius: 2 }} />
        <div style={{ border: '1.5px solid currentColor', borderRadius: 2 }} />
        <div style={{ border: '1.5px solid currentColor', borderRadius: 2 }} />
      </div>
    ),
  },
];

export const LayoutSelector: React.FC = () => {
  const { layoutType, setLayout, syncLock, toggleSyncLock } = useLayoutStore();
  const { theme } = useChartStore();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const bg      = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const popupBg = theme === 'dark' ? '#2a2e39' : '#ffffff';
  const text    = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border  = theme === 'dark' ? '#363c4e' : '#e0e3eb';
  const accent  = '#2962ff';

  const currentIcon = LAYOUT_OPTIONS.find((o) => o.type === layoutType)?.icon;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      {/* Trigger button */}
      <button
        title="Chart Layout"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          background: open ? accent : 'transparent',
          color: open ? '#fff' : text,
          border: `1px solid ${open ? accent : border}`,
          borderRadius: 4,
          padding: '4px 8px',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', color: open ? '#fff' : text }}>
          {currentIcon}
        </span>
        <span>Layout ▾</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            background: popupBg,
            border: `1px solid ${border}`,
            borderRadius: 6,
            padding: 10,
            zIndex: 1000,
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            minWidth: 220,
          }}
        >
          {/* Layout options */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {LAYOUT_OPTIONS.map((opt) => {
              const active = layoutType === opt.type;
              return (
                <button
                  key={opt.type}
                  title={opt.label}
                  onClick={() => { setLayout(opt.type); setOpen(false); }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                    background: active ? accent : 'transparent',
                    color: active ? '#fff' : text,
                    border: `1px solid ${active ? accent : border}`,
                    borderRadius: 5,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    fontSize: 10,
                  }}
                >
                  {opt.icon}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: border, marginBottom: 8 }} />

          {/* Sync-lock toggle */}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              fontSize: 12,
              color: text,
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={syncLock}
              onChange={toggleSyncLock}
              style={{ accentColor: accent, width: 14, height: 14 }}
            />
            <span>
              🔗 Lock scroll sync
              <span style={{ opacity: 0.6, marginLeft: 5, fontSize: 10 }}>
                (pan/zoom all charts together)
              </span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
};
