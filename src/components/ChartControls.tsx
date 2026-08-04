/**
 * ChartControls – floating zoom / scroll / reset widget overlaid on the chart.
 *
 * Positioned at the bottom-right of the chart pane (like TradingView).
 * Buttons:
 *   ◀◀  scroll far left (jump)
 *   ◀   scroll left
 *   −   zoom out
 *   +   zoom in
 *   ▶   scroll right
 *   ▶▶  scroll to latest (end)
 *   ⊡   reset view (fit all)
 */
import React, { useCallback } from 'react';
import { useChartStore } from '../store/chartStore';

export const ChartControls: React.FC = () => {
  const { viewport, zoom, pan, resetView, theme } = useChartStore();

  const bg     = theme === 'dark' ? 'rgba(30,34,45,0.92)' : 'rgba(240,243,250,0.95)';
  const text   = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#d0d3db';
  const hover  = theme === 'dark' ? '#2a2e39' : '#e0e3eb';

  // Step sizes
  const smallStep  = Math.max(1, Math.round(viewport.visibleSlotCount * 0.1));
  const largeStep  = Math.max(1, Math.round(viewport.visibleSlotCount * 0.5));
  const anchorMid  = viewport.firstSlotIndex + Math.floor(viewport.visibleSlotCount / 2);

  const handleZoomIn  = useCallback(() => zoom(-1, anchorMid), [zoom, anchorMid]);
  const handleZoomOut = useCallback(() => zoom(1, anchorMid),  [zoom, anchorMid]);

  const btnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28,
    background: 'transparent',
    color: text,
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
    transition: 'background 0.12s',
    userSelect: 'none',
  };

  const Btn: React.FC<{ title: string; onClick: () => void; children: React.ReactNode }> = ({ title, onClick, children }) => (
    <button
      title={title}
      onClick={onClick}
      style={btnStyle}
      onMouseEnter={e => (e.currentTarget.style.background = hover)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  );

  const Sep = () => (
    <div style={{ width: 1, height: 16, background: border, margin: '0 2px', flexShrink: 0 }} />
  );

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 38,  // just above the time axis
        right: 80,   // just left of the price axis
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 6,
        padding: '2px 4px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        zIndex: 10,
        userSelect: 'none',
      }}
    >
      {/* Scroll */}
      <Btn title="Jump left" onClick={() => pan(-largeStep)}>⟨⟨</Btn>
      <Btn title="Scroll left" onClick={() => pan(-smallStep)}>⟨</Btn>

      <Sep />

      {/* Zoom */}
      <Btn title="Zoom out (−)" onClick={handleZoomOut}>−</Btn>
      <Btn title="Zoom in (+)" onClick={handleZoomIn}>+</Btn>

      <Sep />

      {/* Scroll right */}
      <Btn title="Scroll right" onClick={() => pan(smallStep)}>⟩</Btn>
      <Btn title="Jump to latest" onClick={() => pan(Number.MAX_SAFE_INTEGER)}>⟩⟩</Btn>

      <Sep />

      {/* Reset / fit all */}
      <Btn title="Reset view – fit all bars" onClick={resetView}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
          <rect x="1" y="1" width="5" height="5" rx="1" stroke={text} strokeWidth="1.3"/>
          <rect x="8" y="1" width="5" height="5" rx="1" stroke={text} strokeWidth="1.3"/>
          <rect x="1" y="8" width="5" height="5" rx="1" stroke={text} strokeWidth="1.3"/>
          <rect x="8" y="8" width="5" height="5" rx="1" stroke={text} strokeWidth="1.3"/>
        </svg>
      </Btn>

      <Sep />

      {/* Go to date */}
      <Btn title="Go to date (G)" onClick={() => window.dispatchEvent(new Event('open-goto-date'))}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
          <rect x="1" y="2" width="12" height="11" rx="1.5" stroke={text} strokeWidth="1.2"/>
          <line x1="4" y1="1" x2="4" y2="3.5" stroke={text} strokeWidth="1.2" strokeLinecap="round"/>
          <line x1="10" y1="1" x2="10" y2="3.5" stroke={text} strokeWidth="1.2" strokeLinecap="round"/>
          <line x1="1" y1="5.5" x2="13" y2="5.5" stroke={text} strokeWidth="1"/>
        </svg>
      </Btn>
    </div>
  );
};
