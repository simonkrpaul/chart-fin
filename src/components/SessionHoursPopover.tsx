/**
 * SessionHoursPopover — small in-chart control for tuning the trading-hours
 * window. Opens from the session badge in the toolbar.
 *
 * Auto-detect: inspects the loaded candles and picks the tightest window
 * containing ≥99% of the bars (per minute-of-day, in the session tz).
 *
 * Manual override: type new HH:MM values and hit Apply. The filter and the
 * gap-visibility slot grid rebuild immediately.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useChartStore } from '../store/chartStore';

interface Props {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

function timeToMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

export const SessionHoursPopover: React.FC<Props> = ({ anchorRef, open, onClose }) => {
  const { session, setSessionHours, autoDetectSessionHours, resetSessionToMarketPreset, theme, rawCandles } = useChartStore();
  const [openInput, setOpenInput] = useState(session.regularOpen);
  const [closeInput, setCloseInput] = useState(session.regularClose);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const isDark = theme === 'dark';
  const bg = isDark ? '#1e222d' : '#ffffff';
  const border = isDark ? '#2a2e39' : '#c8cad5';
  const text = isDark ? '#d1d4dc' : '#131722';
  const accent = '#2962ff';
  const subtle = isDark ? '#161c29' : '#f5f6f9';

  // Reset input state whenever the popover opens.
  useEffect(() => {
    if (open) {
      setOpenInput(session.regularOpen);
      setCloseInput(session.regularClose);
    }
  }, [open, session.regularOpen, session.regularClose]);

  // Position the popover under the anchor.
  useEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left });
  }, [open, anchorRef]);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)
          && anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;

  const openMin = timeToMinutes(openInput);
  const closeMin = timeToMinutes(closeInput);
  const valid = openMin !== null && closeMin !== null && openMin < closeMin;

  const inputStyle: React.CSSProperties = {
    background: subtle, color: text, border: `1px solid ${border}`,
    borderRadius: 4, padding: '4px 8px', fontSize: 12, width: 70,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  };

  return (
    <div
      ref={popRef}
      style={{
        position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000,
        background: bg, color: text, border: `1px solid ${border}`,
        borderRadius: 6, padding: 10, minWidth: 260,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 8, letterSpacing: 0.3 }}>
        Session hours ({session.timezone})
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 10, opacity: 0.7, width: 42 }}>Open</span>
        <input
          type="text"
          value={openInput}
          onChange={e => setOpenInput(e.target.value)}
          placeholder="09:30"
          style={inputStyle}
        />
        <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 8, width: 36 }}>Close</span>
        <input
          type="text"
          value={closeInput}
          onChange={e => setCloseInput(e.target.value)}
          placeholder="16:00"
          style={inputStyle}
        />
      </div>

      {!valid && (
        <div style={{ fontSize: 10, color: '#ef5350', marginBottom: 6 }}>
          Enter HH:MM with open &lt; close.
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button
          onClick={() => { if (valid) { setSessionHours(openInput, closeInput); onClose(); } }}
          disabled={!valid}
          style={{
            flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600,
            background: accent, color: '#fff', border: 'none', borderRadius: 4,
            cursor: valid ? 'pointer' : 'not-allowed', opacity: valid ? 1 : 0.5,
          }}
        >
          Apply
        </button>
        <button
          onClick={() => { autoDetectSessionHours(); onClose(); }}
          disabled={rawCandles.length === 0}
          title="Read the loaded candles and pick the tightest window covering ≥99% of bars (min 1 hour wide)."
          style={{
            flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600,
            background: 'transparent', color: text, border: `1px solid ${border}`,
            borderRadius: 4, cursor: rawCandles.length ? 'pointer' : 'not-allowed',
            opacity: rawCandles.length ? 1 : 0.5,
          }}
        >
          Auto-detect
        </button>
      </div>

      {/* Escape hatch — always visible so a misfired auto-detect / manual
          override can be undone with one click. */}
      <button
        onClick={() => { resetSessionToMarketPreset(); onClose(); }}
        title="Restore the session to the current market's default hours."
        style={{
          width: '100%', padding: '4px 0', fontSize: 10,
          background: 'transparent', color: text, border: `1px dashed ${border}`,
          borderRadius: 4, cursor: 'pointer', marginBottom: 8,
        }}
      >
        ↺ Reset to market default
      </button>

      {/* Quick presets */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {[
          ['NYSE regular', '09:30', '16:00'],
          ['Pre + Regular', '04:00', '16:00'],
          ['Reg + After', '09:30', '20:00'],
          ['Full ETH', '04:00', '20:00'],
          ['Full day', '00:00', '23:59'],
        ].map(([label, o, c]) => (
          <button
            key={label}
            onClick={() => { setOpenInput(o); setCloseInput(c); }}
            style={{
              fontSize: 10, padding: '3px 6px',
              background: subtle, color: text,
              border: `1px solid ${border}`, borderRadius: 3, cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 9, opacity: 0.55, marginTop: 8, lineHeight: 1.4 }}>
        Applies to all timeframes. Bars outside the window are filtered before
        resampling, so higher-TF candles never mix session and pre/after-hours.
      </div>
    </div>
  );
};
