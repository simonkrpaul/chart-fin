/**
 * TimezoneSelector – TradingView-style dropdown for changing the chart timezone.
 *
 * Common zones are grouped into regions matching TradingView's layout.
 * Selecting a zone calls setTimezone() which re-generates all candle slots.
 */
import React, { useState, useRef, useEffect } from 'react';
import { useChartStore } from '../store/chartStore';

export interface TzOption {
  tz: string;          // IANA timezone
  label: string;       // Human-readable city / name
  offset?: string;     // e.g. "UTC−5" — computed at runtime
}

const TZ_GROUPS: { group: string; zones: TzOption[] }[] = [
  {
    group: 'UTC',
    zones: [
      { tz: 'UTC', label: 'UTC' },
    ],
  },
  {
    group: 'Americas',
    zones: [
      { tz: 'America/New_York',    label: 'New York' },
      { tz: 'America/Chicago',     label: 'Chicago' },
      { tz: 'America/Denver',      label: 'Denver' },
      { tz: 'America/Los_Angeles', label: 'Los Angeles' },
      { tz: 'America/Toronto',     label: 'Toronto' },
      { tz: 'America/Vancouver',   label: 'Vancouver' },
      { tz: 'America/Sao_Paulo',   label: 'São Paulo' },
    ],
  },
  {
    group: 'Europe',
    zones: [
      { tz: 'Europe/London',   label: 'London' },
      { tz: 'Europe/Paris',    label: 'Paris' },
      { tz: 'Europe/Berlin',   label: 'Frankfurt' },
      { tz: 'Europe/Zurich',   label: 'Zurich' },
      { tz: 'Europe/Moscow',   label: 'Moscow' },
      { tz: 'Europe/Istanbul', label: 'Istanbul' },
    ],
  },
  {
    group: 'Asia / Pacific',
    zones: [
      { tz: 'Asia/Dubai',      label: 'Dubai' },
      { tz: 'Asia/Kolkata',    label: 'Mumbai' },
      { tz: 'Asia/Singapore',  label: 'Singapore' },
      { tz: 'Asia/Shanghai',   label: 'Shanghai' },
      { tz: 'Asia/Tokyo',      label: 'Tokyo' },
      { tz: 'Asia/Seoul',      label: 'Seoul' },
      { tz: 'Asia/Hong_Kong',  label: 'Hong Kong' },
      { tz: 'Australia/Sydney',label: 'Sydney' },
    ],
  },
];

/** Format e.g. "America/New_York" → "UTC−5" or "UTC+5:30" */
function fmtOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz;
  } catch {
    return tz;
  }
}

export const TimezoneSelector: React.FC = () => {
  const { session, setTimezone, theme } = useChartStore();
  const currentTz = session.timezone;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus search when opened
  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 30);
  }, [open]);

  const bg      = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const popupBg = theme === 'dark' ? '#2a2e39' : '#ffffff';
  const text     = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border   = theme === 'dark' ? '#363c4e' : '#e0e3eb';
  const accent   = '#2962ff';
  const muted    = theme === 'dark' ? '#787b86' : '#9598a1';
  const hoverBg  = theme === 'dark' ? '#363c4e' : '#f0f3fa';

  // Find current label
  const currentOption = TZ_GROUPS.flatMap((g) => g.zones).find((z) => z.tz === currentTz);
  const currentLabel  = currentOption ? currentOption.label : currentTz;
  const currentOffset = fmtOffset(currentTz);

  // Filter
  const q = search.toLowerCase();
  const filtered = TZ_GROUPS.map((g) => ({
    ...g,
    zones: g.zones.filter(
      (z) => !q || z.label.toLowerCase().includes(q) || z.tz.toLowerCase().includes(q),
    ),
  })).filter((g) => g.zones.length > 0);

  function select(tz: string) {
    setTimezone(tz);
    setOpen(false);
    setSearch('');
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      {/* Trigger */}
      <button
        title="Chart Timezone"
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
          whiteSpace: 'nowrap',
        }}
      >
        🕐 {currentLabel} <span style={{ opacity: 0.7, fontSize: 11 }}>({currentOffset})</span> ▾
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
            zIndex: 1000,
            boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
            width: 240,
            maxHeight: 380,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Search box */}
          <div style={{ padding: '8px 10px', borderBottom: `1px solid ${border}` }}>
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search timezone…"
              style={{
                width: '100%',
                background: bg,
                color: text,
                border: `1px solid ${border}`,
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 12,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Scrollable list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.map((group) => (
              <div key={group.group}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: muted,
                    padding: '6px 12px 3px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {group.group}
                </div>
                {group.zones.map((zone) => {
                  const active = zone.tz === currentTz;
                  const offset = fmtOffset(zone.tz);
                  return (
                    <div
                      key={zone.tz}
                      onClick={() => select(zone.tz)}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '6px 14px',
                        cursor: 'pointer',
                        fontSize: 12,
                        color: active ? accent : text,
                        fontWeight: active ? 600 : 400,
                        background: active ? (theme === 'dark' ? '#1e3a5f' : '#e8f0fe') : 'transparent',
                      }}
                      onMouseEnter={(e) => {
                        if (!active) (e.currentTarget as HTMLDivElement).style.background = hoverBg;
                      }}
                      onMouseLeave={(e) => {
                        if (!active) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                      }}
                    >
                      <span>{zone.label}</span>
                      <span style={{ fontSize: 11, color: muted }}>{offset}</span>
                    </div>
                  );
                })}
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: '12px 14px', fontSize: 12, color: muted }}>
                No matching timezone
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
