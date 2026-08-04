/**
 * Toolbar – drawing tool selector and timeframe switcher.
 */
import React, { useCallback } from 'react';
import { useChartStore } from '../store/chartStore';
import { DataLoader } from './DataLoader';
import { RemoteLoader } from './RemoteLoader';
import { LayoutManager } from './LayoutManager';
import { LayoutSelector } from './LayoutSelector';
import { TimezoneSelector } from './TimezoneSelector';
import type { DrawingTool, Timeframe } from '../types';

const TOOLS: { key: DrawingTool; label: string; title?: string }[] = [
  { key: 'none', label: '✦ Cursor' },
  { key: 'trendline', label: '╱ Trend' },
  { key: 'fibonacci', label: '◇ Fib', title: 'Fibonacci retracement – drag from swing high to swing low (or vice versa)' },
  { key: 'horizontal', label: '─ H-Line' },
  { key: 'vertical', label: '│ V-Line' },
  { key: 'rectangle', label: '□ Rect' },
  { key: 'measurement', label: '↔ Measure' },
  { key: 'long_position', label: '▲ Long', title: 'Long position – click entry, drag to take-profit (shows TP/SL/R:R)' },
  { key: 'short_position', label: '▼ Short', title: 'Short position – click entry, drag to take-profit (shows TP/SL/R:R)' },
  { key: 'bar_pattern', label: '⧉ Pattern', title: 'Drag to select a historical range and overlay it on the current chart' },
  { key: 'replay', label: '▶ Replay', title: 'Click on any candle to start bar replay from that point' },
];

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '10m', '15m', '1h', '4h', '1d', '1w', '1M'];

export const Toolbar: React.FC = () => {
  const {
    activeDrawingTool,
    setDrawingTool,
    timeframe,
    setTimeframe,
    theme,
    setTheme,
    showIndicatorsAndDrawings,
    toggleIndicatorsAndDrawingsVisibility,
    undoDrawing,
    redoDrawing,
    past,
    future,
  } = useChartStore();

  const bg = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const text = theme === 'dark' ? '#d1d4dc' : '#131722';
  const accent = '#2962ff';
  const border = theme === 'dark' ? '#2a2e39' : '#e0e3eb';

  const handleScreenshot = useCallback(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-chart-canvas]');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `chart-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, []);

  const btn = (active: boolean): React.CSSProperties => ({
    background: active ? accent : 'transparent',
    color: active ? '#fff' : text,
    border: `1px solid ${active ? accent : border}`,
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
    transition: 'background 0.15s',
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        background: bg,
        borderBottom: `1px solid ${border}`,
        flexWrap: 'wrap',
      }}
    >
      {/* Timeframes */}
      <span style={{ color: text, fontSize: 11, opacity: 0.6, marginRight: 4 }}>TF:</span>
      {TIMEFRAMES.map(tf => (
        <button key={tf} style={btn(timeframe === tf)} onClick={() => setTimeframe(tf)}>
          {tf}
        </button>
      ))}

      <div style={{ width: 1, height: 20, background: border, margin: '0 6px' }} />

      {/* Drawing tools */}
      <span style={{ color: text, fontSize: 11, opacity: 0.6, marginRight: 4 }}>Draw:</span>
      {TOOLS.map(t => (
        <button
          key={t.key}
          style={btn(activeDrawingTool === t.key)}
          onClick={() => setDrawingTool(t.key)}
          title={t.title}
        >
          {t.label}
        </button>
      ))}

      <button
        style={btn(!showIndicatorsAndDrawings)}
        onClick={toggleIndicatorsAndDrawingsVisibility}
        title="Hide/show all indicators and drawings"
      >
        {showIndicatorsAndDrawings ? 'Hide Ind+Draw' : 'Show Ind+Draw'}
      </button>

      <div style={{ width: 1, height: 20, background: border, margin: '0 6px' }} />

      {/* Undo/Redo */}
      <button
        style={{ ...btn(false), opacity: past.length === 0 ? 0.4 : 1 }}
        onClick={undoDrawing}
        disabled={past.length === 0}
        title="Undo (⌘Z)"
      >
        ↩ Undo
      </button>
      <button
        style={{ ...btn(false), opacity: future.length === 0 ? 0.4 : 1 }}
        onClick={redoDrawing}
        disabled={future.length === 0}
        title="Redo (⌘⇧Z)"
      >
        ↪ Redo
      </button>

      <div style={{ width: 1, height: 20, background: border, margin: '0 6px' }} />

      {/* Named layout save / load */}
      <LayoutManager />

      <div style={{ width: 1, height: 20, background: border, margin: '0 6px' }} />

      {/* Theme toggle */}
      <button style={btn(false)} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? '☀ Light' : '☾ Dark'}
      </button>

      <div style={{ width: 1, height: 20, background: border, margin: '0 6px' }} />

      {/* File upload */}
      <DataLoader />

      <div style={{ width: 1, height: 20, background: border, margin: '0 6px' }} />

      {/* Remote / pre-generated datasets */}
      <RemoteLoader />

      <div style={{ width: 1, height: 20, background: border, margin: '0 6px' }} />

      {/* Chart layout selector + sync-lock */}
      <LayoutSelector />

      <div style={{ width: 1, height: 20, background: border, margin: '0 6px' }} />

      {/* Timezone selector */}
      <TimezoneSelector />

      <div style={{ width: 1, height: 20, background: border, margin: '0 6px' }} />

      {/* Screenshot */}
      <button
        style={btn(false)}
        onClick={handleScreenshot}
        title="Save chart as PNG image"
      >
        📷 Screenshot
      </button>
    </div>
  );
};
