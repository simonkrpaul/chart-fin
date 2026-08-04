/**
 * GoToDateDialog – TradingView-style "Go to date" popup.
 *
 * Opens via keyboard shortcut (G) or a toolbar button.
 * User types a date (and optional time), then the chart scrolls to center
 * on the closest available slot.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useChartStore } from '../store/chartStore';

interface Props {
  open: boolean;
  onClose: () => void;
}

export const GoToDateDialog: React.FC<Props> = ({ open, onClose }) => {
  const { primarySlots, viewport, pan, themeTokens } = useChartStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dateValue, setDateValue] = useState('');
  const [timeValue, setTimeValue] = useState('');
  const [error, setError] = useState('');

  // Focus input on open
  useEffect(() => {
    if (open) {
      setDateValue('');
      setTimeValue('');
      setError('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!dateValue) return;

    // Build date from calendar picker values
    const [year, month, day] = dateValue.split('-').map(Number);
    const [hours, minutes] = timeValue ? timeValue.split(':').map(Number) : [0, 0];
    const targetDate = new Date(year, month - 1, day, hours, minutes);
    const targetMs = targetDate.getTime();

    if (isNaN(targetMs)) {
      setError('Invalid date selected');
      return;
    }

    if (primarySlots.length === 0) {
      setError('No chart data loaded');
      return;
    }

    // Binary search for closest slot
    const slotIdx = findClosestSlot(primarySlots, targetMs);

    // Check if the found slot is reasonably close (within chart range)
    const first = primarySlots[0].timestamp;
    const last = primarySlots[primarySlots.length - 1].timestamp;
    if (targetMs < first || targetMs > last) {
      // Still navigate but show a warning
      if (targetMs < first) {
        setError('Date is before chart data start – jumping to earliest');
      } else {
        setError('Date is after chart data end – jumping to latest');
      }
    }

    // Center on that slot
    const centerOffset = Math.floor(viewport.visibleSlotCount / 2);
    const targetFirst = Math.max(0, slotIdx - centerOffset);
    const delta = targetFirst - viewport.firstSlotIndex;
    pan(delta);
    onClose();
  }, [dateValue, timeValue, primarySlots, viewport, pan, onClose]);

  if (!open) return null;

  const bg = themeTokens.background;
  const text = themeTokens.axisText;
  const border = themeTokens.gridLine;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 120,
        background: 'rgba(0,0,0,0.4)',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: bg,
          border: `1px solid ${border}`,
          borderRadius: 8,
          padding: '20px 24px',
          minWidth: 320,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ color: text, fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
          Go to Date
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={inputRef}
              type="date"
              value={dateValue}
              onChange={e => { setDateValue(e.target.value); setError(''); }}
              style={{
                flex: 2,
                padding: '8px 12px',
                fontSize: 14,
                background: themeTokens.background,
                color: text,
                border: `1px solid ${border}`,
                borderRadius: 4,
                outline: 'none',
                boxSizing: 'border-box',
                colorScheme: 'dark',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = '#2962ff')}
              onBlur={e => (e.currentTarget.style.borderColor = border)}
            />
            <input
              type="time"
              value={timeValue}
              onChange={e => { setTimeValue(e.target.value); setError(''); }}
              placeholder="HH:mm"
              style={{
                flex: 1,
                padding: '8px 12px',
                fontSize: 14,
                background: themeTokens.background,
                color: text,
                border: `1px solid ${border}`,
                borderRadius: 4,
                outline: 'none',
                boxSizing: 'border-box',
                colorScheme: 'dark',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = '#2962ff')}
              onBlur={e => (e.currentTarget.style.borderColor = border)}
            />
          </div>
          {error && (
            <div style={{ color: '#f44336', fontSize: 11, marginTop: 6 }}>{error}</div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '6px 14px',
                fontSize: 12,
                background: 'transparent',
                color: text,
                border: `1px solid ${border}`,
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={{
                padding: '6px 14px',
                fontSize: 12,
                background: '#2962ff',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Go
            </button>
          </div>
        </form>
        <div style={{ color: '#787b86', fontSize: 11, marginTop: 10 }}>
          Shortcut: <kbd style={{ background: border, padding: '1px 5px', borderRadius: 3, fontSize: 11 }}>G</kbd> to open
        </div>
      </div>
    </div>
  );
};


// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a user-entered date string into Unix ms.
 * Accepts:
 *   - YYYY-MM-DD
 *   - YYYY-MM-DD HH:mm
 *   - YYYY-MM-DD HH:mm:ss
 *   - MM/DD/YYYY
 *   - DD/MM/YYYY HH:mm  (if day > 12 disambiguates; otherwise assumes M/D/Y)
 *   - ISO 8601 strings
 */
function parseUserDate(input: string): number | null {
  // Try native Date parse for ISO/standard formats
  // Replace common separators
  let normalized = input.replace(/\s+/g, ' ').trim();

  // YYYY-MM-DD with optional time
  const isoMatch = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (isoMatch) {
    const [, y, m, d, hh, mm, ss] = isoMatch;
    const date = new Date(
      parseInt(y), parseInt(m) - 1, parseInt(d),
      parseInt(hh || '0'), parseInt(mm || '0'), parseInt(ss || '0')
    );
    if (!isNaN(date.getTime())) return date.getTime();
  }

  // M/D/YYYY or D/M/YYYY with optional time
  const slashMatch = normalized.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (slashMatch) {
    const [, a, b, y, hh, mm, ss] = slashMatch;
    // If first number > 12, it must be day (D/M/Y), else assume M/D/Y
    let month: number, day: number;
    if (parseInt(a) > 12) {
      day = parseInt(a);
      month = parseInt(b) - 1;
    } else {
      month = parseInt(a) - 1;
      day = parseInt(b);
    }
    const date = new Date(
      parseInt(y), month, day,
      parseInt(hh || '0'), parseInt(mm || '0'), parseInt(ss || '0')
    );
    if (!isNaN(date.getTime())) return date.getTime();
  }

  // Fallback: native Date constructor
  const fallback = new Date(normalized);
  if (!isNaN(fallback.getTime())) return fallback.getTime();

  return null;
}

/**
 * Binary-search for the slot whose timestamp is closest to `targetMs`.
 */
function findClosestSlot(slots: { timestamp: number }[], targetMs: number): number {
  if (slots.length === 0) return 0;
  let lo = 0;
  let hi = slots.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].timestamp < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // lo is the first slot >= targetMs; check if lo-1 is closer
  if (lo > 0) {
    const diffLo = Math.abs(slots[lo].timestamp - targetMs);
    const diffPrev = Math.abs(slots[lo - 1].timestamp - targetMs);
    if (diffPrev < diffLo) return lo - 1;
  }
  return lo;
}
