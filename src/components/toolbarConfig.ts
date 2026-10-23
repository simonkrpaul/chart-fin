import type { DrawingTool, Timeframe } from '../types';

export const TOOLS: { key: DrawingTool; label: string; title?: string }[] = [
  { key: 'none', label: '✦ Cursor' },
  { key: 'trendline', label: '╱ Trend' },
  { key: 'fibonacci', label: '◇ Fib', title: 'Fibonacci retracement – drag from swing high to swing low (or vice versa)' },
  { key: 'horizontal', label: '─ H-Line' },
  { key: 'vertical', label: '│ V-Line' },
  { key: 'cyclic', label: '┃┃┃ Cycles', title: 'Cyclic Lines – click first line, then click again to set interval; drag the anchor to slide' },
  { key: 'rectangle', label: '□ Rect' },
  { key: 'measurement', label: '↔ Measure' },
  { key: 'long_position', label: '▲ Long', title: 'Long position – click entry, drag to take-profit (shows TP/SL/R:R)' },
  { key: 'short_position', label: '▼ Short', title: 'Short position – click entry, drag to take-profit (shows TP/SL/R:R)' },
  { key: 'bar_pattern', label: '⧉ Pattern', title: 'Drag to select a historical range and overlay it on the current chart' },
  { key: 'replay', label: '▶ Replay', title: 'Click on any candle to start bar replay from that point' },
];

export const TIMEFRAMES: Timeframe[] = ['1m', '5m', '10m', '15m', '1h', '4h', '1d', '1w', '1M'];
