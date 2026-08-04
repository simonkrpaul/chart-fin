/**
 * EphemerisPanel – sidebar panel to query planetary aspect dates from the
 * ephemeris server and display them as vertical markers on the chart.
 */
import React, { useState } from 'react';
import { useChartStore } from '../store/chartStore';
import type { EphemerisMarker, TransitZoneGroup } from '../types';

const PLANETS = [
  'Sun', 'Moon', 'Mercury', 'Venus', 'Mars',
  'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
  'Rahu', 'True Rahu', 'Ketu',
];

const ASPECTS = [
  { label: 'Conjunction (0°)', value: 0 },
  { label: 'Sextile (60°)', value: 60 },
  { label: 'Square (90°)', value: 90 },
  { label: 'Trine (120°)', value: 120 },
  { label: 'Opposition (180°)', value: 180 },
];

const AYANAMSAS = ['Lahiri', 'Raman', 'Krishnamurti', 'Fagan/Bradley', 'Tropical'];

const MARKER_COLORS = ['#e040fb', '#00e5ff', '#ffab00', '#76ff03', '#ff1744', '#d500f9'];

const RANGE_PRESETS = [
  { label: '1Y', years: 1 },
  { label: '2Y', years: 2 },
  { label: '3Y', years: 3 },
  { label: '5Y', years: 5 },
  { label: '10Y', years: 10 },
];

const API_BASE = 'http://127.0.0.1:5050';

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function yearsAgo(n: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return toDateStr(d);
}

export const EphemerisPanel: React.FC = () => {
  const {
    ephemerisMarkers,
    showEphemerisMarkers,
    setEphemerisMarkers,
    clearEphemerisMarkers,
    toggleEphemerisMarkers,
    transitZoneGroups,
    addTransitZoneGroup,
    removeTransitZoneGroup,
    toggleTransitZoneGroup,
    clearAllTransitZones,
    theme,
  } = useChartStore();

  // Form state
  const [planet1, setPlanet1] = useState('Sun');
  const [planet2, setPlanet2] = useState('Moon');
  const [aspect, setAspect] = useState(0);
  const [orb, setOrb] = useState(1.0);
  const [ayanamsa, setAyanamsa] = useState('Lahiri');
  const [stepMinutes, setStepMinutes] = useState(60);
  const [color, setColor] = useState(MARKER_COLORS[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'aspect' | 'rising'>('aspect');

  // Date range state
  const [startDate, setStartDate] = useState(yearsAgo(1));
  const [endDate, setEndDate] = useState(toDateStr(new Date()));

  // Rising-specific
  const [node, setNode] = useState('Rahu');
  const [lat, setLat] = useState(28.6139);
  const [lon, setLon] = useState(77.209);

  const bg = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#e0e3eb';
  const subtle = theme === 'dark' ? '#2a2e39' : '#e0e3eb';
  const inp: React.CSSProperties = {
    background: subtle, color: text,
    border: `1px solid ${border}`, borderRadius: 3,
    padding: '3px 6px', width: '100%', boxSizing: 'border-box',
    fontSize: 11,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  };

  function applyPreset(years: number) {
    setStartDate(yearsAgo(years));
    setEndDate(toDateStr(new Date()));
  }

  async function fetchAspectDates() {
    if (!startDate || !endDate) { setError('Set date range'); return; }

    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${API_BASE}/api/ephemeris/dates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          planet1,
          planet2,
          aspect,
          orb,
          ayanamsa,
          step_minutes: stepMinutes,
        }),
      });
      if (!resp.ok) throw new Error(`Server error ${resp.status}`);
      const data = await resp.json();
      const markers: EphemerisMarker[] = (data.dates || []).map((d: any) => ({
        timestamp: d.timestamp,
        slotIndex: 0,
        label: d.label || `${planet1} ${aspect}° ${planet2}`,
        color,
        meta: { planet1_deg: d.planet1_deg, planet2_deg: d.planet2_deg },
      }));
      // Sort newest first
      markers.sort((a, b) => b.timestamp - a.timestamp);
      setEphemerisMarkers([...ephemerisMarkers, ...markers]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function fetchRisingDates() {
    if (!startDate || !endDate) { setError('Set date range'); return; }

    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${API_BASE}/api/ephemeris/rising`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          node,
          orb,
          ayanamsa,
          step_minutes: stepMinutes,
          location: { lat, lon },
        }),
      });
      if (!resp.ok) throw new Error(`Server error ${resp.status}`);
      const data = await resp.json();
      const markers: EphemerisMarker[] = (data.dates || []).map((d: any) => ({
        timestamp: d.timestamp,
        slotIndex: 0,
        label: d.label || `${node} Rising`,
        color,
        meta: { asc_deg: d.asc_deg, node_deg: d.node_deg },
      }));
      markers.sort((a, b) => b.timestamp - a.timestamp);
      setEphemerisMarkers([...ephemerisMarkers, ...markers]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Sort markers newest first for display
  const sortedMarkers = [...ephemerisMarkers].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <div style={{ background: bg, color: text, padding: 12, width: '100%', boxSizing: 'border-box', overflowY: 'auto', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Ephemeris Dates</span>
        <button
          onClick={toggleEphemerisMarkers}
          style={{ fontSize: 10, padding: '1px 6px', cursor: 'pointer', background: 'transparent', color: text, border: `1px solid ${border}`, borderRadius: 3 }}
        >
          {showEphemerisMarkers ? 'Hide' : 'Show'}
        </button>
      </div>

      {/* Mode selector */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <button
          onClick={() => setMode('aspect')}
          style={{ ...inp, background: mode === 'aspect' ? '#2962ff' : subtle, color: mode === 'aspect' ? '#fff' : text, cursor: 'pointer', textAlign: 'center' as const }}
        >
          Aspects
        </button>
        <button
          onClick={() => setMode('rising')}
          style={{ ...inp, background: mode === 'rising' ? '#2962ff' : subtle, color: mode === 'rising' ? '#fff' : text, cursor: 'pointer', textAlign: 'center' as const }}
        >
          Rising
        </button>
      </div>

      {/* Date Range */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        <label style={{ fontSize: 10, opacity: 0.7 }}>Date Range</label>
        <div style={{ display: 'flex', gap: 4 }}>
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ ...inp, flex: 1 }} />
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ ...inp, flex: 1 }} />
        </div>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {RANGE_PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => applyPreset(p.years)}
              style={{
                fontSize: 9, padding: '2px 6px', cursor: 'pointer',
                background: subtle, color: text,
                border: `1px solid ${border}`, borderRadius: 3,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'aspect' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 10, opacity: 0.7 }}>Planet 1</label>
          <select value={planet1} onChange={e => setPlanet1(e.target.value)} style={inp}>
            {PLANETS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          <label style={{ fontSize: 10, opacity: 0.7 }}>Planet 2</label>
          <select value={planet2} onChange={e => setPlanet2(e.target.value)} style={inp}>
            {PLANETS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          <label style={{ fontSize: 10, opacity: 0.7 }}>Aspect</label>
          <select value={aspect} onChange={e => setAspect(Number(e.target.value))} style={inp}>
            {ASPECTS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
        </div>
      )}

      {mode === 'rising' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 10, opacity: 0.7 }}>Node</label>
          <select value={node} onChange={e => setNode(e.target.value)} style={inp}>
            <option value="Rahu">Rahu</option>
            <option value="Ketu">Ketu</option>
          </select>

          <div style={{ display: 'flex', gap: 4 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 10, opacity: 0.7 }}>Lat</label>
              <input type="number" step="0.01" value={lat} onChange={e => setLat(Number(e.target.value))} style={inp} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 10, opacity: 0.7 }}>Lon</label>
              <input type="number" step="0.01" value={lon} onChange={e => setLon(Number(e.target.value))} style={inp} />
            </div>
          </div>
        </div>
      )}

      {/* Common controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, borderTop: `1px solid ${border}`, paddingTop: 8 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 10, opacity: 0.7 }}>Orb°</label>
            <input type="number" step="0.1" min="0.1" max="10" value={orb} onChange={e => setOrb(Number(e.target.value))} style={inp} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 10, opacity: 0.7 }}>Step (min)</label>
            <input type="number" min="1" max="1440" value={stepMinutes} onChange={e => setStepMinutes(Number(e.target.value))} style={inp} />
          </div>
        </div>

        <label style={{ fontSize: 10, opacity: 0.7 }}>Ayanamsa</label>
        <select value={ayanamsa} onChange={e => setAyanamsa(e.target.value)} style={inp}>
          {AYANAMSAS.map(a => <option key={a} value={a}>{a}</option>)}
        </select>

        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <label style={{ fontSize: 10, opacity: 0.7 }}>Color</label>
          <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ width: 28, height: 20, border: 'none', background: 'transparent', cursor: 'pointer' }} />
          {MARKER_COLORS.map(c => (
            <div
              key={c}
              onClick={() => setColor(c)}
              style={{ width: 14, height: 14, borderRadius: 2, background: c, cursor: 'pointer', border: color === c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)' }}
            />
          ))}
        </div>

        <button
          onClick={mode === 'aspect' ? fetchAspectDates : fetchRisingDates}
          disabled={loading}
          style={{
            background: '#2962ff', color: '#fff', border: 'none', borderRadius: 4,
            padding: '6px 0', cursor: loading ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600,
          }}
        >
          {loading ? '⏳ Computing...' : '+ Find Dates'}
        </button>

        {error && <div style={{ color: '#ef5350', fontSize: 10 }}>{error}</div>}
      </div>

      {/* Active markers */}
      <div style={{ marginTop: 10, borderTop: `1px solid ${border}`, paddingTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 10, opacity: 0.7 }}>Markers ({ephemerisMarkers.length})</span>
          {ephemerisMarkers.length > 0 && (
            <button onClick={clearEphemerisMarkers} style={{ fontSize: 10, padding: '1px 5px', cursor: 'pointer', background: 'transparent', color: '#ef5350', border: '1px solid #ef5350', borderRadius: 3 }}>
              Clear all
            </button>
          )}
        </div>
        {sortedMarkers.length === 0 && <div style={{ opacity: 0.5, fontSize: 11 }}>No markers. Use controls above to find planetary dates.</div>}
        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
          {sortedMarkers.map((m, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, marginBottom: 3, padding: '2px 0' }}>
              <span style={{ width: 8, height: 8, borderRadius: 1, background: m.color, flexShrink: 0 }} />
              <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>
                {new Date(m.timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Custom Transit Zones ──────────────────────────────────────────── */}
      <TransitZonesSection
        groups={transitZoneGroups}
        addGroup={addTransitZoneGroup}
        removeGroup={removeTransitZoneGroup}
        toggleGroup={toggleTransitZoneGroup}
        clearAll={clearAllTransitZones}
        bg={bg}
        text={text}
        border={border}
        subtle={subtle}
      />
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Venus Helio transit presets (computed from venus_helio_transits.py)
// ─────────────────────────────────────────────────────────────────────────────

interface TransitPreset {
  label: string;
  direction: 'UP' | 'DOWN';
  probability: string;
  color: string;
  /** Array of [entryISO, exitISO] pairs */
  dates: [string, string][];
}

const VENUS_HELIO_PRESETS: TransitPreset[] = [
  {
    label: "Venus Helio 28°11' Gem → 17°35' Leo",
    direction: 'DOWN', probability: '82%', color: '#ff5252',
    dates: [
      ['2020-02-22', '2020-03-23'], ['2020-10-03', '2020-11-03'],
      ['2021-05-16', '2021-06-16'], ['2021-12-27', '2022-01-26'],
      ['2022-08-09', '2022-09-08'], ['2023-03-21', '2023-04-21'],
      ['2023-11-01', '2023-12-01'], ['2024-06-13', '2024-07-13'],
      ['2025-01-23', '2025-02-23'], ['2025-09-05', '2025-10-05'],
      ['2026-04-18', '2026-05-18'], ['2026-11-28', '2026-12-29'],
      ['2027-07-11', '2027-08-11'],
    ],
  },
  {
    label: "Venus Helio 01°33' Vir → 26°19' Lib",
    direction: 'DOWN', probability: '78%', color: '#ff6e40',
    dates: [
      ['2020-04-01', '2020-05-05'], ['2020-11-12', '2020-12-15'],
      ['2021-06-24', '2021-07-28'], ['2022-02-04', '2022-03-10'],
      ['2022-09-17', '2022-10-20'], ['2023-04-29', '2023-06-02'],
      ['2023-12-10', '2024-01-13'], ['2024-07-22', '2024-08-25'],
      ['2025-03-03', '2025-04-06'], ['2025-10-14', '2025-11-17'],
      ['2026-05-27', '2026-06-30'], ['2027-01-06', '2027-02-09'],
      ['2027-08-19', '2027-09-22'],
    ],
  },
  {
    label: "Venus Helio 02°46' Sc → 18°56' Sag",
    direction: 'UP', probability: '94%', color: '#69f0ae',
    dates: [
      ['2020-05-09', '2020-06-07'], ['2020-12-19', '2021-01-17'],
      ['2021-08-01', '2021-08-30'], ['2022-03-14', '2022-04-12'],
      ['2022-10-24', '2022-11-22'], ['2023-06-06', '2023-07-05'],
      ['2024-01-17', '2024-02-15'], ['2024-08-29', '2024-09-26'],
      ['2025-04-10', '2025-05-09'], ['2025-11-21', '2025-12-20'],
      ['2026-07-04', '2026-08-02'], ['2027-02-13', '2027-03-14'],
      ['2027-09-26', '2027-10-25'],
    ],
  },
  {
    label: "Venus Helio 13°25' Aq → 24°42' Aq",
    direction: 'DOWN', probability: '79%', color: '#ffd740',
    dates: [
      ['2020-07-11', '2020-07-18'], ['2021-02-21', '2021-02-28'],
      ['2021-10-03', '2021-10-11'], ['2022-05-16', '2022-05-23'],
      ['2022-12-27', '2023-01-03'], ['2023-08-09', '2023-08-16'],
      ['2024-03-20', '2024-03-27'], ['2024-10-31', '2024-11-07'],
      ['2025-06-13', '2025-06-20'], ['2026-01-23', '2026-01-30'],
      ['2026-09-05', '2026-09-12'], ['2027-04-18', '2027-04-25'],
      ['2027-11-28', '2027-12-06'],
    ],
  },
  {
    label: "Venus Helio 11°53' Pis → 15°11' Ar",
    direction: 'UP', probability: '89%', color: '#40c4ff',
    dates: [
      ['2020-07-29', '2020-08-19'], ['2021-03-11', '2021-04-01'],
      ['2021-10-21', '2021-11-11'], ['2022-06-03', '2022-06-24'],
      ['2023-01-14', '2023-02-04'], ['2023-08-26', '2023-09-16'],
      ['2024-04-07', '2024-04-28'], ['2024-11-18', '2024-12-09'],
      ['2025-07-01', '2025-07-22'], ['2026-02-10', '2026-03-03'],
      ['2026-09-23', '2026-10-14'], ['2027-05-06', '2027-05-27'],
      ['2027-12-16', '2027-12-31'],
    ],
  },
];

const MERCURY_HELIO_PRESETS: TransitPreset[] = [
  {
    label: "Mercury Helio 14°10' Canc → 26°39' Canc",
    direction: 'DOWN', probability: '72%', color: '#e040fb',
    dates: [
      ['2020-02-16', '2020-02-18'], ['2020-05-14', '2020-05-16'],
      ['2020-08-10', '2020-08-12'], ['2020-11-06', '2020-11-08'],
      ['2021-02-02', '2021-02-04'], ['2021-05-01', '2021-05-03'],
      ['2021-07-28', '2021-07-30'], ['2021-10-24', '2021-10-26'],
      ['2022-01-20', '2022-01-22'], ['2022-04-18', '2022-04-20'],
      ['2022-07-15', '2022-07-17'], ['2022-10-11', '2022-10-13'],
      ['2023-01-07', '2023-01-09'], ['2023-04-05', '2023-04-07'],
      ['2023-07-02', '2023-07-04'], ['2023-09-28', '2023-09-30'],
      ['2023-12-25', '2023-12-27'], ['2024-03-22', '2024-03-24'],
      ['2024-06-17', '2024-06-20'], ['2024-09-13', '2024-09-16'],
      ['2024-12-10', '2024-12-12'], ['2025-03-08', '2025-03-10'],
      ['2025-06-04', '2025-06-06'], ['2025-08-31', '2025-09-02'],
      ['2025-11-27', '2025-11-29'], ['2026-02-23', '2026-02-25'],
      ['2026-05-22', '2026-05-24'], ['2026-08-18', '2026-08-20'],
      ['2026-11-14', '2026-11-16'], ['2027-02-10', '2027-02-12'],
      ['2027-05-09', '2027-05-11'], ['2027-08-05', '2027-08-07'],
      ['2027-11-01', '2027-11-03'],
    ],
  },
  {
    label: "Mercury Helio 00°08' Lib → 29°26' Sco",
    direction: 'DOWN', probability: '62%', color: '#ab47bc',
    dates: [
      ['2020-03-02', '2020-03-20'], ['2020-05-29', '2020-06-16'],
      ['2020-08-25', '2020-09-12'], ['2020-11-21', '2020-12-09'],
      ['2021-02-17', '2021-03-07'], ['2021-05-16', '2021-06-03'],
      ['2021-08-12', '2021-08-30'], ['2021-11-08', '2021-11-26'],
      ['2022-02-04', '2022-02-22'], ['2022-05-03', '2022-05-21'],
      ['2022-07-30', '2022-08-17'], ['2022-10-26', '2022-11-13'],
      ['2023-01-22', '2023-02-09'], ['2023-04-20', '2023-05-08'],
      ['2023-07-17', '2023-08-04'], ['2023-10-13', '2023-10-31'],
      ['2024-01-08', '2024-01-27'], ['2024-04-05', '2024-04-24'],
      ['2024-07-02', '2024-07-21'], ['2024-09-28', '2024-10-17'],
      ['2024-12-25', '2025-01-13'], ['2025-03-23', '2025-04-11'],
      ['2025-06-19', '2025-07-08'], ['2025-09-15', '2025-10-03'],
      ['2025-12-12', '2025-12-30'], ['2026-03-10', '2026-03-28'],
      ['2026-06-06', '2026-06-24'], ['2026-09-02', '2026-09-20'],
      ['2026-11-29', '2026-12-17'], ['2027-02-25', '2027-03-15'],
      ['2027-05-24', '2027-06-11'], ['2027-08-20', '2027-09-07'],
      ['2027-11-16', '2027-12-04'],
    ],
  },
  {
    label: "Mercury Helio 22°07' Aqu → 26°34' Pis",
    direction: 'UP', probability: '76%', color: '#7c4dff',
    dates: [
      ['2020-01-20', '2020-01-28'], ['2020-04-17', '2020-04-25'],
      ['2020-07-14', '2020-07-22'], ['2020-10-10', '2020-10-18'],
      ['2021-01-06', '2021-01-14'], ['2021-04-04', '2021-04-12'],
      ['2021-07-01', '2021-07-09'], ['2021-09-27', '2021-10-05'],
      ['2021-12-24', '2022-01-01'], ['2022-03-22', '2022-03-30'],
      ['2022-06-18', '2022-06-26'], ['2022-09-14', '2022-09-22'],
      ['2022-12-11', '2022-12-19'], ['2023-03-09', '2023-03-17'],
      ['2023-06-05', '2023-06-13'], ['2023-09-01', '2023-09-09'],
      ['2023-11-28', '2023-12-06'], ['2024-02-24', '2024-03-03'],
      ['2024-05-21', '2024-05-30'], ['2024-08-17', '2024-08-26'],
      ['2024-11-13', '2024-11-22'], ['2025-02-09', '2025-02-18'],
      ['2025-05-08', '2025-05-17'], ['2025-08-04', '2025-08-13'],
      ['2025-10-31', '2025-11-09'], ['2026-01-27', '2026-02-05'],
      ['2026-04-25', '2026-05-04'], ['2026-07-22', '2026-07-31'],
      ['2026-10-18', '2026-10-27'], ['2027-01-14', '2027-01-23'],
      ['2027-04-12', '2027-04-20'], ['2027-07-09', '2027-07-17'],
      ['2027-10-05', '2027-10-13'],
    ],
  },
  {
    label: "Mercury Helio 02°04' Leo → 15°55' Leo",
    direction: 'UP', probability: '76%', color: '#536dfe',
    dates: [
      ['2020-02-19', '2020-02-22'], ['2020-05-17', '2020-05-19'],
      ['2020-08-13', '2020-08-15'], ['2020-11-09', '2020-11-11'],
      ['2021-02-05', '2021-02-07'], ['2021-05-04', '2021-05-06'],
      ['2021-07-31', '2021-08-02'], ['2021-10-27', '2021-10-29'],
      ['2022-01-23', '2022-01-25'], ['2022-04-21', '2022-04-23'],
      ['2022-07-18', '2022-07-20'], ['2022-10-14', '2022-10-16'],
      ['2023-01-10', '2023-01-12'], ['2023-04-08', '2023-04-10'],
      ['2023-07-05', '2023-07-07'], ['2023-10-01', '2023-10-03'],
      ['2023-12-28', '2023-12-30'], ['2024-03-25', '2024-03-27'],
      ['2024-06-20', '2024-06-23'], ['2024-09-16', '2024-09-19'],
      ['2024-12-13', '2024-12-16'], ['2025-03-11', '2025-03-14'],
      ['2025-06-07', '2025-06-10'], ['2025-09-03', '2025-09-06'],
      ['2025-11-30', '2025-12-03'], ['2026-02-26', '2026-03-01'],
      ['2026-05-25', '2026-05-28'], ['2026-08-21', '2026-08-24'],
      ['2026-11-17', '2026-11-20'], ['2027-02-13', '2027-02-16'],
      ['2027-05-12', '2027-05-15'], ['2027-08-08', '2027-08-11'],
      ['2027-11-04', '2027-11-07'],
    ],
  },
];

const MERCURY_SUN_HELIO_PRESETS: TransitPreset[] = [
  {
    label: "Mercury-Sun Helio 249°28' → 268°25'",
    direction: 'DOWN', probability: '74%', color: '#ff8a65',
    dates: [
      ['2020-02-03', '2020-02-07'], ['2020-05-18', '2020-05-22'],
      ['2020-09-12', '2020-09-23'], ['2021-01-16', '2021-01-21'],
      ['2021-05-02', '2021-05-06'], ['2021-08-23', '2021-09-02'],
      ['2021-12-30', '2022-01-05'], ['2022-04-16', '2022-04-20'],
      ['2022-08-05', '2022-08-13'], ['2022-12-13', '2022-12-19'],
      ['2023-04-01', '2023-04-04'], ['2023-07-18', '2023-07-25'],
      ['2023-11-25', '2023-12-02'], ['2024-03-15', '2024-03-19'],
      ['2024-06-30', '2024-07-06'], ['2024-11-04', '2024-11-13'],
      ['2025-02-28', '2025-03-03'], ['2025-06-13', '2025-06-18'],
      ['2025-10-15', '2025-10-25'], ['2026-02-12', '2026-02-16'],
      ['2026-05-28', '2026-06-01'], ['2026-09-25', '2026-10-05'],
      ['2027-01-26', '2027-01-31'], ['2027-05-12', '2027-05-16'],
      ['2027-09-04', '2027-09-15'],
    ],
  },
  {
    label: "Mercury-Sun Helio 187°26' → 216°46'",
    direction: 'DOWN', probability: '68%', color: '#ffab91',
    dates: [
      ['2020-01-14', '2020-01-25'], ['2020-05-06', '2020-05-11'],
      ['2020-08-19', '2020-08-28'], ['2020-12-24', '2021-01-06'],
      ['2021-04-20', '2021-04-26'], ['2021-08-03', '2021-08-11'],
      ['2021-12-03', '2021-12-19'], ['2022-04-04', '2022-04-10'],
      ['2022-07-18', '2022-07-25'], ['2022-11-12', '2022-11-29'],
      ['2023-03-19', '2023-03-26'], ['2023-07-02', '2023-07-08'],
      ['2023-10-23', '2023-11-08'], ['2024-03-01', '2024-03-09'],
      ['2024-06-16', '2024-06-21'], ['2024-10-03', '2024-10-17'],
      ['2025-02-12', '2025-02-20'], ['2025-05-31', '2025-06-06'],
      ['2025-09-15', '2025-09-27'], ['2026-01-24', '2026-02-04'],
      ['2026-05-16', '2026-05-21'], ['2026-08-29', '2026-09-08'],
      ['2027-01-05', '2027-01-17'], ['2027-04-30', '2027-05-06'],
      ['2027-08-13', '2027-08-21'], ['2027-12-16', '2027-12-30'],
    ],
  },
  {
    label: "Mercury-Sun Helio 61°07' → 146°21'",
    direction: 'UP', probability: '83%', color: '#00e676',
    dates: [
      ['2020-03-21', '2020-04-27'], ['2020-07-24', '2020-08-10'],
      ['2020-11-06', '2020-12-01'], ['2021-03-01', '2021-04-10'],
      ['2021-07-07', '2021-07-25'], ['2021-10-22', '2021-11-12'],
      ['2022-02-10', '2022-03-24'], ['2022-06-20', '2022-07-10'],
      ['2022-10-06', '2022-10-25'], ['2023-01-23', '2023-03-06'],
      ['2023-06-02', '2023-06-24'], ['2023-09-20', '2023-10-08'],
      ['2024-01-05', '2024-02-14'], ['2024-05-13', '2024-06-08'],
      ['2024-09-04', '2024-09-21'], ['2024-12-18', '2025-01-24'],
      ['2025-04-23', '2025-05-23'], ['2025-08-19', '2025-09-05'],
      ['2025-12-02', '2026-01-03'], ['2026-04-03', '2026-05-07'],
      ['2026-08-03', '2026-08-20'], ['2026-11-16', '2026-12-13'],
      ['2027-03-13', '2027-04-21'], ['2027-07-17', '2027-08-04'],
      ['2027-10-31', '2027-11-24'],
    ],
  },
  {
    label: "Mercury-Sun Helio 03°09' → 27°23'",
    direction: 'UP', probability: '74%', color: '#b2ff59',
    dates: [
      ['2020-02-27', '2020-03-05'], ['2020-07-02', '2020-07-13'],
      ['2020-10-26', '2020-10-31'], ['2021-02-09', '2021-02-16'],
      ['2021-06-12', '2021-06-25'], ['2021-10-10', '2021-10-15'],
      ['2022-01-24', '2022-01-29'], ['2022-05-23', '2022-06-05'],
      ['2022-09-24', '2022-09-29'], ['2023-01-08', '2023-01-13'],
      ['2023-05-03', '2023-05-16'], ['2023-09-07', '2023-09-13'],
      ['2023-12-23', '2023-12-28'], ['2024-04-13', '2024-04-25'],
      ['2024-08-20', '2024-08-27'], ['2024-12-06', '2024-12-11'],
      ['2025-03-26', '2025-04-05'], ['2025-08-02', '2025-08-10'],
      ['2025-11-21', '2025-11-25'], ['2026-03-08', '2026-03-17'],
      ['2026-07-14', '2026-07-24'], ['2026-11-05', '2026-11-09'],
      ['2027-02-19', '2027-02-26'], ['2027-06-25', '2027-07-06'],
      ['2027-10-20', '2027-10-25'],
    ],
  },
];

const MOON_NODE_PRESETS: TransitPreset[] = [
  {
    label: "Moon-N.Node 221°17' → 95°18'",
    direction: 'DOWN', probability: '59%', color: '#78909c',
    dates: [
      ['2020-01-01', '2020-01-16'], ['2020-01-26', '2020-02-12'],
      ['2020-02-22', '2020-03-11'], ['2020-03-20', '2020-04-07'],
      ['2020-04-16', '2020-05-04'], ['2020-05-13', '2020-06-01'],
      ['2020-06-09', '2020-06-28'], ['2020-07-07', '2020-07-25'],
      ['2020-08-03', '2020-08-21'], ['2020-08-30', '2020-09-17'],
      ['2020-09-26', '2020-10-15'], ['2020-10-23', '2020-11-11'],
      ['2020-11-20', '2020-12-08'], ['2020-12-17', '2021-01-04'],
      ['2021-01-13', '2021-01-31'], ['2021-02-09', '2021-02-28'],
      ['2021-03-09', '2021-03-27'], ['2021-04-05', '2021-04-23'],
      ['2021-05-02', '2021-05-21'], ['2021-05-29', '2021-06-17'],
      ['2021-06-25', '2021-07-14'], ['2021-07-23', '2021-08-10'],
      ['2021-08-19', '2021-09-06'], ['2021-09-15', '2021-10-04'],
      ['2021-10-12', '2021-10-31'], ['2021-11-09', '2021-11-27'],
      ['2021-12-06', '2021-12-24'], ['2022-01-02', '2022-01-20'],
      ['2022-01-30', '2022-02-17'], ['2022-02-26', '2022-03-16'],
      ['2022-03-25', '2022-04-12'], ['2022-04-21', '2022-05-09'],
      ['2022-05-18', '2022-06-06'], ['2022-06-15', '2022-07-03'],
      ['2022-07-12', '2022-07-30'], ['2022-08-08', '2022-08-26'],
      ['2022-09-04', '2022-09-22'], ['2022-10-02', '2022-10-19'],
      ['2022-10-29', '2022-11-16'], ['2022-11-25', '2022-12-13'],
      ['2022-12-22', '2023-01-09'], ['2023-01-19', '2023-02-05'],
      ['2023-02-15', '2023-03-04'], ['2023-03-14', '2023-03-31'],
      ['2023-04-10', '2023-04-28'], ['2023-05-07', '2023-05-25'],
      ['2023-06-04', '2023-06-21'], ['2023-07-01', '2023-07-18'],
      ['2023-07-28', '2023-08-14'], ['2023-08-25', '2023-09-10'],
      ['2023-09-21', '2023-10-08'], ['2023-10-18', '2023-11-04'],
      ['2023-11-14', '2023-12-01'], ['2023-12-11', '2023-12-28'],
      ['2024-01-08', '2024-01-24'], ['2024-02-04', '2024-02-21'],
      ['2024-03-02', '2024-03-19'], ['2024-03-29', '2024-04-15'],
      ['2024-04-25', '2024-05-12'], ['2024-05-22', '2024-06-08'],
      ['2024-06-19', '2024-07-06'], ['2024-07-16', '2024-08-02'],
      ['2024-08-12', '2024-08-29'], ['2024-09-08', '2024-09-25'],
      ['2024-10-05', '2024-10-22'], ['2024-11-02', '2024-11-19'],
      ['2024-11-29', '2024-12-16'], ['2024-12-26', '2025-01-12'],
      ['2025-01-22', '2025-02-08'], ['2025-02-18', '2025-03-07'],
      ['2025-03-18', '2025-04-04'], ['2025-04-14', '2025-05-01'],
      ['2025-05-11', '2025-05-28'], ['2025-06-07', '2025-06-25'],
      ['2025-07-04', '2025-07-22'], ['2025-07-31', '2025-08-18'],
      ['2025-08-28', '2025-09-14'], ['2025-09-24', '2025-10-11'],
      ['2025-10-21', '2025-11-08'], ['2025-11-17', '2025-12-05'],
      ['2025-12-14', '2026-01-01'], ['2026-01-10', '2026-01-29'],
      ['2026-02-07', '2026-02-25'], ['2026-03-06', '2026-03-24'],
      ['2026-04-02', '2026-04-20'], ['2026-04-29', '2026-05-17'],
      ['2026-05-26', '2026-06-14'], ['2026-06-23', '2026-07-11'],
      ['2026-07-20', '2026-08-07'], ['2026-08-16', '2026-09-03'],
      ['2026-09-12', '2026-09-30'], ['2026-10-10', '2026-10-28'],
      ['2026-11-06', '2026-11-24'], ['2026-12-03', '2026-12-21'],
      ['2026-12-30', '2027-01-18'], ['2027-01-26', '2027-02-14'],
      ['2027-02-23', '2027-03-13'], ['2027-03-22', '2027-04-09'],
      ['2027-04-18', '2027-05-06'], ['2027-05-15', '2027-06-03'],
      ['2027-06-11', '2027-06-30'], ['2027-07-09', '2027-07-27'],
      ['2027-08-05', '2027-08-23'], ['2027-09-01', '2027-09-20'],
      ['2027-09-28', '2027-10-17'], ['2027-10-26', '2027-11-13'],
      ['2027-11-22', '2027-12-10'], ['2027-12-19', '2027-12-31'],
    ],
  },
];

/** All preset groups by category */
const ALL_PRESET_CATEGORIES = [
  { name: 'Venus Helio', presets: VENUS_HELIO_PRESETS },
  { name: 'Mercury Helio', presets: MERCURY_HELIO_PRESETS },
  { name: 'Mercury-Sun Helio', presets: MERCURY_SUN_HELIO_PRESETS },
  { name: 'Moon-N.Node', presets: MOON_NODE_PRESETS },
];

function presetToGroup(preset: TransitPreset): Omit<TransitZoneGroup, 'id'> {
  return {
    label: preset.label,
    direction: preset.direction,
    probability: preset.probability,
    color: preset.color,
    visible: true,
    zones: preset.dates.map(([entry, exit]) => ({
      entryTimestamp: new Date(entry + 'T00:00:00Z').getTime(),
      exitTimestamp: new Date(exit + 'T23:59:59Z').getTime(),
      entrySlotIndex: 0,
      exitSlotIndex: 0,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TransitZonesSection sub-component
// ─────────────────────────────────────────────────────────────────────────────

interface TransitZonesSectionProps {
  groups: TransitZoneGroup[];
  addGroup: (g: Omit<TransitZoneGroup, 'id'>) => void;
  removeGroup: (id: string) => void;
  toggleGroup: (id: string) => void;
  clearAll: () => void;
  bg: string;
  text: string;
  border: string;
  subtle: string;
}

const TransitZonesSection: React.FC<TransitZonesSectionProps> = ({
  groups, addGroup, removeGroup, toggleGroup, clearAll, bg, text, border, subtle,
}) => {
  const [expanded, setExpanded] = useState(true);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [openCategory, setOpenCategory] = useState<string | null>(null);

  // Custom form state
  const [customPlanet, setCustomPlanet] = useState('Venus');
  const [customPlanet2, setCustomPlanet2] = useState(''); // empty = single planet mode
  const [customCoordinate, setCustomCoordinate] = useState<'heliocentric' | 'sidereal_lahiri' | 'tropical'>('heliocentric');
  const [customStartDeg, setCustomStartDeg] = useState(0);
  const [customStartMin, setCustomStartMin] = useState(0);
  const [customStartSign, setCustomStartSign] = useState('Ari');
  const [customEndDeg, setCustomEndDeg] = useState(0);
  const [customEndMin, setCustomEndMin] = useState(0);
  const [customEndSign, setCustomEndSign] = useState('Ari');
  const [customDirection, setCustomDirection] = useState<'UP' | 'DOWN'>('UP');
  const [customProbability, setCustomProbability] = useState('');
  const [customColor, setCustomColor] = useState('#e040fb');
  const [customScanStart, setCustomScanStart] = useState('2020-01-01');
  const [customScanEnd, setCustomScanEnd] = useState('2027-12-31');
  // For angular diff mode (no sign, just raw degrees)
  const [customStartAngle, setCustomStartAngle] = useState(0);
  const [customEndAngle, setCustomEndAngle] = useState(0);
  const [customLoading, setCustomLoading] = useState(false);
  const [customError, setCustomError] = useState('');

  const isAngularDiffMode = customPlanet2 !== '';

  const SIGN_OPTIONS = ['Ari', 'Tau', 'Gem', 'Can', 'Leo', 'Vir', 'Lib', 'Sco', 'Sag', 'Cap', 'Aqu', 'Pis'];
  const PLANET_OPTIONS = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Rahu (Mean Node)', 'Rahu (True Node)', 'Ketu'];

  const inp: React.CSSProperties = {
    background: subtle, color: text,
    border: `1px solid ${border}`, borderRadius: 3,
    padding: '2px 4px', fontSize: 10,
    colorScheme: 'dark',
  };

  async function computeCustomTransit() {
    setCustomLoading(true);
    setCustomError('');
    try {
      const resp = await fetch('http://127.0.0.1:5050/api/ephemeris/helio-transit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planet: customPlanet,
          planet2: customPlanet2 || undefined,
          coordinate: customCoordinate,
          start_deg: isAngularDiffMode ? Math.floor(customStartAngle) : customStartDeg,
          start_min: isAngularDiffMode ? Math.round((customStartAngle % 1) * 60) : customStartMin,
          start_sign: isAngularDiffMode ? undefined : customStartSign,
          end_deg: isAngularDiffMode ? Math.floor(customEndAngle) : customEndDeg,
          end_min: isAngularDiffMode ? Math.round((customEndAngle % 1) * 60) : customEndMin,
          end_sign: isAngularDiffMode ? undefined : customEndSign,
          start_angle: isAngularDiffMode ? customStartAngle : undefined,
          end_angle: isAngularDiffMode ? customEndAngle : undefined,
          scan_start: customScanStart,
          scan_end: customScanEnd,
          step_hours: customPlanet === 'Moon' ? 1 : (customPlanet === 'Mercury' ? 2 : 4),
        }),
      });
      if (!resp.ok) throw new Error(`Server error ${resp.status}`);
      const data = await resp.json();
      if (!data.zones || data.zones.length === 0) {
        setCustomError('No transits found in date range');
        return;
      }
      const label = isAngularDiffMode
        ? `${customPlanet}-${customPlanet2} ${customCoordinate === 'heliocentric' ? 'Helio' : customCoordinate === 'sidereal_lahiri' ? 'Sid' : 'Trop'} ${customStartAngle.toFixed(0)}° → ${customEndAngle.toFixed(0)}°`
        : `${customPlanet} ${customCoordinate === 'heliocentric' ? 'Helio' : customCoordinate === 'sidereal_lahiri' ? 'Sid' : 'Trop'} ${customStartDeg}°${customStartMin}' ${customStartSign} → ${customEndDeg}°${customEndMin}' ${customEndSign}`;

      addGroup({
        label,
        direction: customDirection,
        probability: customProbability || '?%',
        color: customColor,
        visible: true,
        zones: data.zones.map((z: any) => ({
          entryTimestamp: z.entry_ts,
          exitTimestamp: z.exit_ts,
          entrySlotIndex: 0,
          exitSlotIndex: 0,
        })),
      });
      setCustomError('');
    } catch (e) {
      setCustomError((e as Error).message);
    } finally {
      setCustomLoading(false);
    }
  }

  return (
    <div style={{ marginTop: 12, borderTop: `1px solid ${border}`, paddingTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, cursor: 'pointer' }}
           onClick={() => setExpanded(!expanded)}>
        <span style={{ fontWeight: 600, fontSize: 11 }}>
          {expanded ? '▾' : '▸'} Custom Transits ({groups.length})
        </span>
        {groups.length > 0 && (
          <button
            onClick={e => { e.stopPropagation(); clearAll(); }}
            style={{ fontSize: 10, padding: '1px 5px', cursor: 'pointer', background: 'transparent', color: '#ef5350', border: '1px solid #ef5350', borderRadius: 3 }}
          >
            Clear all
          </button>
        )}
      </div>

      {expanded && (
        <>
          {/* ── Custom Transit Form ─────────────────────────────────── */}
          <div style={{ marginBottom: 8, borderBottom: `1px solid ${border}`, paddingBottom: 8 }}>
            <div
              style={{ fontSize: 10, fontWeight: 600, cursor: 'pointer', marginBottom: 4 }}
              onClick={() => setShowCustomForm(!showCustomForm)}
            >
              {showCustomForm ? '▾' : '▸'} Custom Calculation
            </div>

            {showCustomForm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {/* Coordinate system */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, opacity: 0.7, width: 55 }}>System:</span>
                  <select value={customCoordinate} onChange={e => setCustomCoordinate(e.target.value as any)} style={{ ...inp, flex: 1 }}>
                    <option value="heliocentric">Heliocentric</option>
                    <option value="sidereal_lahiri">Sidereal (Lahiri)</option>
                    <option value="tropical">Tropical</option>
                  </select>
                </div>

                {/* Planet 1 */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, opacity: 0.7, width: 55 }}>Planet:</span>
                  <select value={customPlanet} onChange={e => setCustomPlanet(e.target.value)} style={{ ...inp, flex: 1 }}>
                    {PLANET_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>

                {/* Planet 2 (optional, for angular diff) */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, opacity: 0.7, width: 55 }}>Planet 2:</span>
                  <select value={customPlanet2} onChange={e => setCustomPlanet2(e.target.value)} style={{ ...inp, flex: 1 }}>
                    <option value="">(none – single planet)</option>
                    {PLANET_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>

                {/* Degree inputs */}
                {isAngularDiffMode ? (
                  <>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, opacity: 0.7, width: 55 }}>Start°:</span>
                      <input type="number" value={customStartAngle} onChange={e => setCustomStartAngle(+e.target.value)} style={{ ...inp, width: 60 }} step="0.01" />
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, opacity: 0.7, width: 55 }}>End°:</span>
                      <input type="number" value={customEndAngle} onChange={e => setCustomEndAngle(+e.target.value)} style={{ ...inp, width: 60 }} step="0.01" />
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, opacity: 0.7, width: 55 }}>Start:</span>
                      <input type="number" value={customStartDeg} onChange={e => setCustomStartDeg(+e.target.value)} style={{ ...inp, width: 30 }} min={0} max={29} />
                      <span style={{ fontSize: 9 }}>°</span>
                      <input type="number" value={customStartMin} onChange={e => setCustomStartMin(+e.target.value)} style={{ ...inp, width: 30 }} min={0} max={59} />
                      <span style={{ fontSize: 9 }}>'</span>
                      <select value={customStartSign} onChange={e => setCustomStartSign(e.target.value)} style={{ ...inp, width: 45 }}>
                        {SIGN_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, opacity: 0.7, width: 55 }}>End:</span>
                      <input type="number" value={customEndDeg} onChange={e => setCustomEndDeg(+e.target.value)} style={{ ...inp, width: 30 }} min={0} max={29} />
                      <span style={{ fontSize: 9 }}>°</span>
                      <input type="number" value={customEndMin} onChange={e => setCustomEndMin(+e.target.value)} style={{ ...inp, width: 30 }} min={0} max={59} />
                      <span style={{ fontSize: 9 }}>'</span>
                      <select value={customEndSign} onChange={e => setCustomEndSign(e.target.value)} style={{ ...inp, width: 45 }}>
                        {SIGN_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </>
                )}

                {/* Direction + Probability + Color */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <select value={customDirection} onChange={e => setCustomDirection(e.target.value as any)} style={{ ...inp, width: 60 }}>
                    <option value="UP">▲ UP</option>
                    <option value="DOWN">▼ DOWN</option>
                  </select>
                  <input type="text" placeholder="e.g. 82%" value={customProbability} onChange={e => setCustomProbability(e.target.value)} style={{ ...inp, width: 40 }} />
                  <input type="color" value={customColor} onChange={e => setCustomColor(e.target.value)} style={{ width: 20, height: 20, padding: 0, border: 'none', cursor: 'pointer' }} />
                </div>

                {/* Scan range */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, opacity: 0.7, width: 55 }}>Scan:</span>
                  <input type="date" value={customScanStart} onChange={e => setCustomScanStart(e.target.value)} style={{ ...inp, flex: 1 }} />
                  <span style={{ fontSize: 9 }}>→</span>
                  <input type="date" value={customScanEnd} onChange={e => setCustomScanEnd(e.target.value)} style={{ ...inp, flex: 1 }} />
                </div>

                <button
                  onClick={computeCustomTransit}
                  disabled={customLoading}
                  style={{
                    width: '100%', marginTop: 2, padding: '5px 0', fontSize: 10, fontWeight: 600,
                    background: '#2962ff', color: '#fff', border: 'none', borderRadius: 3,
                    cursor: customLoading ? 'wait' : 'pointer',
                  }}
                >
                  {customLoading ? '⏳ Computing...' : '+ Compute & Add Transit'}
                </button>
                {customError && <div style={{ color: '#ef5350', fontSize: 9 }}>{customError}</div>}
              </div>
            )}
          </div>

          {/* ── Preset Categories ───────────────────────────────────── */}
          {ALL_PRESET_CATEGORIES.map(cat => (
            <div key={cat.name} style={{ marginBottom: 6 }}>
              <div
                style={{ fontSize: 10, fontWeight: 600, cursor: 'pointer', marginBottom: 3, opacity: 0.8 }}
                onClick={() => setOpenCategory(openCategory === cat.name ? null : cat.name)}
              >
                {openCategory === cat.name ? '▾' : '▸'} {cat.name} ({cat.presets.length})
              </div>
              {openCategory === cat.name && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 6 }}>
                  {cat.presets.map((preset, i) => {
                    const alreadyAdded = groups.some(g => g.label === preset.label);
                    return (
                      <button
                        key={i}
                        onClick={() => addGroup(presetToGroup(preset))}
                        disabled={alreadyAdded}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4,
                          fontSize: 9, padding: '2px 5px', cursor: alreadyAdded ? 'default' : 'pointer',
                          background: alreadyAdded ? subtle : 'transparent',
                          color: alreadyAdded ? text : preset.color,
                          border: `1px solid ${alreadyAdded ? border : preset.color}`,
                          borderRadius: 3, textAlign: 'left', opacity: alreadyAdded ? 0.5 : 1,
                        }}
                      >
                        <span style={{ fontWeight: 700 }}>{preset.direction === 'UP' ? '▲' : '▼'}</span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {preset.probability} {preset.label}
                        </span>
                        {alreadyAdded && <span style={{ fontSize: 8 }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          {/* ── Active groups list ──────────────────────────────────── */}
          {groups.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6, borderTop: `1px solid ${border}`, paddingTop: 6 }}>
              <div style={{ fontSize: 10, opacity: 0.6 }}>Active on chart:</div>
              {groups.map(g => (
                <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '2px 4px', background: subtle, borderRadius: 3 }}>
                  <input
                    type="checkbox"
                    checked={g.visible}
                    onChange={() => toggleGroup(g.id)}
                    style={{ margin: 0, cursor: 'pointer' }}
                  />
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: g.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: g.visible ? 1 : 0.4 }}>
                    {g.direction === 'UP' ? '▲' : '▼'} {g.probability} {g.label}
                  </span>
                  <span style={{ opacity: 0.5, fontSize: 9 }}>{g.zones.length} zones</span>
                  <button
                    onClick={() => removeGroup(g.id)}
                    style={{ fontSize: 10, padding: '0 3px', cursor: 'pointer', background: 'transparent', color: '#ef5350', border: 'none', fontWeight: 700 }}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
