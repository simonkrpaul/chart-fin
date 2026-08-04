/**
 * OverlayPanel – sidebar panel to add / remove / configure historical offset overlays.
 *
 * Usage:
 *   - Pick an "anchor date" (the date from which the offset starts showing on chart).
 *   - Set offset days N.
 *   - The overlay shows data starting from (anchorDate − N calendar days),
 *     projected forward by N days so it aligns to the anchor date on screen.
 *   - Rolls forward automatically to today / the latest chart bar.
 */
import React, { useState, useMemo } from 'react';
import { useChartStore } from '../store/chartStore';
import { computeCorrelation, scanBestCorrelation } from '../engine/correlationEngine';
import type { OffsetOverlayConfig, OverlayMode } from '../types';
import type { ScanOutput, ScanMode } from '../engine/correlationEngine';

const MODES: OverlayMode[] = ['overlay', 'normalized', 'percent', 'index100'];
const QUICK_DAYS = [10, 20, 30, 50, 100, 121, 273, 343, 365];
const PALETTE = ['#f5c518','#4fc3f7','#ff7043','#ab47bc','#66bb6a','#ec407a','#ffffff','#ff5252'];

/** Format a Date as YYYY-MM-DD for <input type="date"> */
function toDateInput(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const OverlayPanel: React.FC = () => {
  const {
    overlayConfigs,
    overlays,
    primarySlots,
    rawCandles,
    addOverlay,
    removeOverlay,
    toggleOverlay,
    updateOverlayConfig,
    theme,
  } = useChartStore();

  // Compute correlation for each visible overlay
  const correlations = useMemo(() => {
    const map: Record<string, { r: number; n: number } | null> = {};
    for (const cfg of overlayConfigs) {
      const ov = overlays[cfg.id];
      if (!ov || !cfg.visible) { map[cfg.id] = null; continue; }
      map[cfg.id] = computeCorrelation(primarySlots, ov.projectedCandles);
    }
    return map;
  }, [overlayConfigs, overlays, primarySlots]);

  // Default anchor = 2025-01-01; default offset = 273 calendar days
  const [anchorDate, setAnchorDate] = useState('2025-01-01');
  const [offsetDays, setOffsetDays] = useState(273);
  const [mode, setMode] = useState<OverlayMode>('overlay');
  const [color, setColor] = useState(PALETTE[0]);
  const [showSwingHL, setShowSwingHL] = useState(false);
  const [swingHLLeftRight, setSwingHLLeftRight] = useState(5);
  const [showSwingPct, setShowSwingPct] = useState(false);

  // Correlation scanner state
  const [scanMax, setScanMax] = useState(5000);
  const [scanWindow, setScanWindow] = useState(90);
  const [scanMode, setScanMode] = useState<ScanMode>('returns');
  const [scanSwingLR, setScanSwingLR] = useState(5);
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<ScanOutput | null>(null);
  const [scanProgress, setScanProgress] = useState(0);

  const bg     = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const text   = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#e0e3eb';
  const subtle = theme === 'dark' ? '#2a2e39' : '#e0e3eb';
  const inp: React.CSSProperties = {
    background: subtle, color: text,
    border: `1px solid ${border}`, borderRadius: 3,
    padding: '3px 6px', width: '100%', boxSizing: 'border-box',
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  };

  /**
   * Add an overlay:
   *  - source from (anchorDate − offsetDays) through (latest chart date − offsetDays)
   *  - projected forward by offsetDays calendar days
   *  - Feb 1 + 10d = Feb 11 → appears at Feb 11 slot
   */
  function addOverlayFromConfig(days: number, anchor: string) {
    if (!rawCandles.length || !primarySlots.length) return;

    const anchorMs  = new Date(anchor + 'T00:00:00Z').getTime();
    const shiftMs   = days * 24 * 60 * 60 * 1000;

    // Source window: candles from (anchor − offset) through the latest available raw candle.
    // After projection (+offset days), the data aligns from anchorDate forward.
    // Candles near the last bar will land AFTER it → enables forward projection into the future.
    const lastRawMs     = rawCandles.reduce((m, c) => Math.max(m, c.timestamp), 0);
    const sourceStartMs = anchorMs - shiftMs;
    const sourceEndMs   = lastRawMs;

    if (sourceStartMs >= sourceEndMs) {
      alert('Anchor date is beyond the available data range.');
      return;
    }

    const historicalCandles = rawCandles.filter(
      c => c.timestamp >= sourceStartMs && c.timestamp <= sourceEndMs,
    );

    if (historicalCandles.length === 0) {
      alert(
        `No data found for the ${days}-day look-back window.\n` +
        `Expected source data between:\n` +
        `  ${new Date(sourceStartMs).toDateString()} → ${new Date(sourceEndMs).toDateString()}\n\n` +
        `Make sure you have loaded historical data that covers this range.`,
      );
      return;
    }

    const config: OffsetOverlayConfig = {
      id: crypto.randomUUID(),
      label: `${days}d from ${anchor}`,
      sourceStartTimestamp: sourceStartMs,
      sourceEndTimestamp: sourceEndMs,
      calendarDayOffset: days,
      mode,
      anchorType: 'date',
      color,
      opacity: 0.75,
      lineOnly: false,
      dashed: false,
      visible: true,
      zIndex: 0,
      showSwingHL,
      swingHLLeftRight,
      showSwingPct: showSwingHL ? showSwingPct : false,
    };
    addOverlay(config, historicalCandles);
  }

  const inputStyle: React.CSSProperties = { ...inp, fontSize: 11 };

  return (
    <div style={{ background: bg, color: text, padding: 12, width: '100%', boxSizing: 'border-box', overflowY: 'auto', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>Offset Comparisons</div>

      {/* Anchor date */}
      <div style={{ marginBottom: 6 }}>
        <label style={{ display: 'block', opacity: 0.6, marginBottom: 3, fontSize: 11 }}>
          Anchor date <span style={{ opacity: 0.5 }}>(candles appear from here)</span>
        </label>
        <input
          type="date"
          value={anchorDate}
          onChange={e => setAnchorDate(e.target.value)}
          style={inputStyle}
        />
      </div>

      {/* Offset days dropdown */}
      <div style={{ marginBottom: 6 }}>
        <label style={{ display: 'block', opacity: 0.6, marginBottom: 3, fontSize: 11 }}>
          Offset (calendar days)
        </label>
        <select
          value={QUICK_DAYS.includes(offsetDays) ? offsetDays : ''}
          onChange={e => { if (e.target.value) setOffsetDays(Number(e.target.value)); }}
          style={inputStyle}
        >
          <option value="" disabled>Select days…</option>
          {QUICK_DAYS.map(d => (
            <option key={d} value={d}>{d} days</option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={3650}
          value={offsetDays}
          onChange={e => setOffsetDays(Math.max(1, Number(e.target.value)))}
          placeholder="Custom days"
          style={{ ...inputStyle, marginTop: 4 }}
        />
      </div>

      {/* Mode */}
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: 'block', opacity: 0.6, marginBottom: 3, fontSize: 11 }}>Display mode</label>
        <select value={mode} onChange={e => setMode(e.target.value as OverlayMode)} style={inputStyle}>
          {MODES.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {/* Color */}
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: 'block', opacity: 0.6, marginBottom: 4, fontSize: 11 }}>Color</label>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {PALETTE.map(c => (
            <button
              key={c}
              onClick={() => setColor(c)}
              title={c}
              style={{
                width: 18, height: 18, borderRadius: 3, background: c, border: color === c ? '2px solid #fff' : `2px solid transparent`,
                cursor: 'pointer', padding: 0, flexShrink: 0,
                boxShadow: color === c ? '0 0 0 1px #2962ff' : 'none',
              }}
            />
          ))}
          {/* Free-pick */}
          <input
            type="color"
            value={color}
            onChange={e => setColor(e.target.value)}
            title="Custom color"
            style={{ width: 22, height: 22, padding: 0, border: 'none', borderRadius: 3, cursor: 'pointer', background: 'none' }}
          />
        </div>
      </div>

      {/* Swing HL option */}
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={showSwingHL} onChange={e => setShowSwingHL(e.target.checked)} />
          Show Swing HL
        </label>
        {showSwingHL && (
          <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span style={{ opacity: 0.6 }}>Left/Right</span>
              <input
                type="number" min={1} max={50} value={swingHLLeftRight}
                onChange={e => setSwingHLLeftRight(Math.max(1, Number(e.target.value)))}
                style={{ ...inputStyle, width: 50 }}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
              <input type="checkbox" checked={showSwingPct} onChange={e => setShowSwingPct(e.target.checked)} />
              Show % move
            </label>
          </div>
        )}
      </div>

      {/* Add button */}
      <button
        onClick={() => addOverlayFromConfig(offsetDays, anchorDate)}
        style={{
          width: '100%', marginBottom: 6, padding: '5px 0',
          background: '#2962ff', color: '#fff',
          border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12,
        }}
      >
        + Add overlay
      </button>

      {/* Quick presets */}
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: 'block', opacity: 0.5, marginBottom: 4, fontSize: 10 }}>Quick days (uses anchor date above)</label>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {QUICK_DAYS.map(d => (
            <button
              key={d}
              onClick={() => { setOffsetDays(d); addOverlayFromConfig(d, anchorDate); }}
              style={{
                background: 'transparent', color: text,
                border: `1px solid ${border}`, borderRadius: 3,
                padding: '2px 6px', fontSize: 10, cursor: 'pointer',
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${border}`, marginBottom: 8 }} />

      {/* Correlation Scanner */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 11 }}>Correlation Scanner</div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', opacity: 0.6, fontSize: 10, marginBottom: 2 }}>Max offset days</label>
            <input
              type="number" min={100} max={10000} value={scanMax}
              onChange={e => setScanMax(Math.max(100, Number(e.target.value)))}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', opacity: 0.6, fontSize: 10, marginBottom: 2 }}>Compare window (days)</label>
            <input
              type="number" min={7} max={365} value={scanWindow}
              onChange={e => setScanWindow(Math.max(7, Number(e.target.value)))}
              style={inputStyle}
            />
          </div>
        </div>
        {/* Scan mode toggle */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', opacity: 0.6, fontSize: 10, marginBottom: 2 }}>Mode</label>
            <select value={scanMode} onChange={e => setScanMode(e.target.value as ScanMode)} style={inputStyle}>
              <option value="returns">Price Returns</option>
              <option value="swing">Swing Points</option>
            </select>
          </div>
          {scanMode === 'swing' && (
            <div style={{ width: 70 }}>
              <label style={{ display: 'block', opacity: 0.6, fontSize: 10, marginBottom: 2 }}>Swing L/R</label>
              <input
                type="number" min={2} max={50} value={scanSwingLR}
                onChange={e => setScanSwingLR(Math.max(2, Number(e.target.value)))}
                style={inputStyle}
              />
            </div>
          )}
        </div>
        <button
          disabled={scanning || rawCandles.length === 0}
          onClick={() => {
            setScanning(true);
            setScanResults(null);
            setScanProgress(0);
            const anchorMs = new Date(anchorDate + 'T00:00:00Z').getTime();
            const windowMs = scanWindow * 24 * 60 * 60 * 1000;
            // Run async to avoid blocking UI
            setTimeout(() => {
              const results = scanBestCorrelation(
                rawCandles, anchorMs, windowMs, scanMax, 1, 15,
                (pct) => setScanProgress(pct),
                scanMode, scanSwingLR,
              );
              setScanResults(results);
              setScanning(false);
              setScanProgress(1);
            }, 0);
          }}
          style={{
            width: '100%', padding: '5px 0',
            background: scanning ? '#555' : '#4caf50', color: '#fff',
            border: 'none', borderRadius: 4, cursor: scanning ? 'wait' : 'pointer', fontSize: 11,
          }}
        >
          {scanning ? `Scanning... ${Math.round(scanProgress * 100)}%` : `Scan 1–${scanMax} days`}
        </button>
        {scanResults && (scanResults.positive.length > 0 || scanResults.negative.length > 0) && (
          <div style={{ marginTop: 6 }}>
            {/* Positive correlations */}
            {scanResults.positive.length > 0 && (
              <>
                <div style={{ opacity: 0.8, fontSize: 10, marginBottom: 3, color: '#66bb6a', fontWeight: 600 }}>▲ Top positive (same direction):</div>
                {scanResults.positive.map((sr, i) => (
                  <div
                    key={`pos-${sr.offsetDays}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3,
                      padding: '3px 6px', background: subtle, borderRadius: 3, fontSize: 11,
                    }}
                  >
                    <span style={{ fontWeight: 600, minWidth: 20 }}>#{i + 1}</span>
                    <span style={{ flex: 1 }}>{sr.offsetDays}d</span>
                    <span style={{
                      fontWeight: 600,
                      color: sr.r >= 0.5 ? '#66bb6a' : '#ffa726',
                    }}>
                      {(sr.r * 100).toFixed(1)}%
                    </span>
                    <span style={{ opacity: 0.5, fontSize: 10 }}>{sr.n}pts</span>
                    <button
                      onClick={() => { setOffsetDays(sr.offsetDays); addOverlayFromConfig(sr.offsetDays, anchorDate); }}
                      title="Add as overlay"
                      style={{
                        background: '#2962ff', color: '#fff', border: 'none',
                        borderRadius: 3, padding: '1px 6px', fontSize: 10, cursor: 'pointer',
                      }}
                    >
                      + Add
                    </button>
                  </div>
                ))}
              </>
            )}
            {/* Negative correlations */}
            {scanResults.negative.length > 0 && (
              <>
                <div style={{ opacity: 0.8, fontSize: 10, marginTop: 8, marginBottom: 3, color: '#ef5350', fontWeight: 600 }}>▼ Top negative (mirror opposite):</div>
                {scanResults.negative.map((sr, i) => (
                  <div
                    key={`neg-${sr.offsetDays}`}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3,
                      padding: '3px 6px', background: subtle, borderRadius: 3, fontSize: 11,
                    }}
                  >
                    <span style={{ fontWeight: 600, minWidth: 20 }}>#{i + 1}</span>
                    <span style={{ flex: 1 }}>{sr.offsetDays}d</span>
                    <span style={{ fontWeight: 600, color: '#ef5350' }}>
                      {(sr.r * 100).toFixed(1)}%
                    </span>
                    <span style={{ opacity: 0.5, fontSize: 10 }}>{sr.n}pts</span>
                    <button
                      onClick={() => { setOffsetDays(sr.offsetDays); addOverlayFromConfig(sr.offsetDays, anchorDate); }}
                      title="Add as overlay"
                      style={{
                        background: '#2962ff', color: '#fff', border: 'none',
                        borderRadius: 3, padding: '1px 6px', fontSize: 10, cursor: 'pointer',
                      }}
                    >
                      + Add
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${border}`, marginBottom: 8 }} />

      {/* Active overlays */}
      {overlayConfigs.length === 0 && (
        <div style={{ opacity: 0.5, fontSize: 11 }}>No overlays active.</div>
      )}
      {overlayConfigs.map(cfg => (
        <div key={cfg.id} style={{ marginBottom: 8, padding: 8, background: subtle, borderRadius: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <input
              type="color"
              value={cfg.color || '#ffffff'}
              onChange={e => updateOverlayConfig(cfg.id, { color: e.target.value })}
              title="Change color"
              style={{ width: 16, height: 16, padding: 0, border: 'none', borderRadius: '50%', cursor: 'pointer', background: 'none', flexShrink: 0 }}
            />
            <span style={{ flex: 1, fontWeight: 500, fontSize: 11, lineHeight: 1.3, wordBreak: 'break-word' }}>
              {cfg.label}
              {correlations[cfg.id] && (
                <span style={{
                  marginLeft: 6,
                  fontSize: 10,
                  fontWeight: 600,
                  color: (correlations[cfg.id]!.r >= 0.5) ? '#66bb6a'
                       : (correlations[cfg.id]!.r >= 0) ? '#ffa726'
                       : '#ef5350',
                  opacity: 0.9,
                }}>
                  {(correlations[cfg.id]!.r * 100).toFixed(1)}% corr
                  <span style={{ opacity: 0.5, fontWeight: 400 }}> ({correlations[cfg.id]!.n}pts)</span>
                </span>
              )}
            </span>
            <button
              onClick={() => toggleOverlay(cfg.id)}
              style={{ fontSize: 10, padding: '1px 5px', cursor: 'pointer', background: 'transparent', color: text, border: `1px solid ${border}`, borderRadius: 3, flexShrink: 0 }}
            >
              {cfg.visible ? 'Hide' : 'Show'}
            </button>
            <button
              onClick={() => removeOverlay(cfg.id)}
              style={{ fontSize: 10, padding: '1px 5px', cursor: 'pointer', background: 'transparent', color: '#ef5350', border: '1px solid #ef5350', borderRadius: 3, flexShrink: 0 }}
            >
              ✕
            </button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <input type="checkbox" checked={cfg.lineOnly} onChange={e => updateOverlayConfig(cfg.id, { lineOnly: e.target.checked })} />
            Line only
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, marginTop: 4 }}>
            <input type="checkbox" checked={cfg.mirror ?? false} onChange={e => updateOverlayConfig(cfg.id, { mirror: e.target.checked })} />
            Mirror (inverted clone)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, marginTop: 4 }}>
            <input
              type="checkbox"
              checked={cfg.showSwingHL ?? false}
              onChange={e => updateOverlayConfig(cfg.id, { showSwingHL: e.target.checked })}
            />
            Swing HL
            {cfg.showSwingHL && (
              <input
                type="number" min={1} max={50}
                value={cfg.swingHLLeftRight ?? 5}
                onChange={e => updateOverlayConfig(cfg.id, { swingHLLeftRight: Math.max(1, Number(e.target.value)) })}
                title="Left/Right bars"
                style={{ width: 38, marginLeft: 4, background: subtle, color: text, border: `1px solid ${border}`, borderRadius: 3, padding: '1px 4px', fontSize: 11 }}
              />
            )}
          </label>
          {cfg.showSwingHL && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, marginTop: 2, marginLeft: 16, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={cfg.showSwingPct ?? false}
                onChange={e => updateOverlayConfig(cfg.id, { showSwingPct: e.target.checked })}
              />
              Show % move
            </label>
          )}
          <label style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
            Opacity {Math.round(cfg.opacity * 100)}%
            <input
              type="range" min={10} max={100}
              value={Math.round(cfg.opacity * 100)}
              onChange={e => updateOverlayConfig(cfg.id, { opacity: Number(e.target.value) / 100 })}
              style={{ width: '100%', marginTop: 2 }}
            />
          </label>
        </div>
      ))}
    </div>
  );
};
