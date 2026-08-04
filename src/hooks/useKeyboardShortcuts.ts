/**
 * useKeyboardShortcuts – global keyboard shortcuts.
 */
import { useEffect } from 'react';
import { useChartStore } from '../store/chartStore';

export function useKeyboardShortcuts() {
  const { undoDrawing, redoDrawing, setDrawingTool, setTheme, theme } = useChartStore();

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoDrawing(); }
      if (mod && e.key === 'z' && e.shiftKey)  { e.preventDefault(); redoDrawing(); }
      if (mod && e.key === 'y')                { e.preventDefault(); redoDrawing(); }
      if (e.key === 'Escape')                  { setDrawingTool('none'); }
      if (e.key === 't' && !mod)               { setDrawingTool('trendline'); }
      if (e.key === 'h' && !mod)               { setDrawingTool('horizontal'); }
      if (e.key === 'r' && !mod)               { setDrawingTool('rectangle'); }
      if (e.key === 'm' && !mod)               { setDrawingTool('measurement'); }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undoDrawing, redoDrawing, setDrawingTool, setTheme, theme]);
}
