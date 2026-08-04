/**
 * App – root component. Wires together the toolbar, sidebar panels, and
 * the multi-panel chart grid.
 *
 * The outer ChartStoreContext.Provider always points at the active panel's
 * store so that the Toolbar, IndicatorPanel, etc. automatically operate on
 * whichever chart the user last clicked.
 */
import { useMemo, useState, useEffect, useCallback } from 'react';
import { useChartStore, ChartStoreContext, primaryChartStore } from './store/chartStore';
import { useLayoutStore, LAYOUT_PANEL_IDS } from './store/layoutStore';
import { ChartCanvas } from './components/ChartCanvas';
import { Toolbar } from './components/Toolbar';
import { CandleTooltip } from './components/CandleTooltip';
import { ChartControls } from './components/ChartControls';
import { ReplayControls } from './components/ReplayControls';
import { OverlayPanel } from './components/OverlayPanel';
import { IndicatorPanel } from './components/IndicatorPanel';
import { MeasurementOverlay } from './components/MeasurementOverlay';
import { BacktestPanel } from './components/BacktestPanel';
import { BacktestReport } from './components/BacktestReport';
import { TradeJournalPanel } from './components/TradeJournalPanel';
import { EphemerisPanel } from './components/EphemerisPanel';
import { CycleCombinerPanel } from './components/CycleCombinerPanel';
import { GoToDateDialog } from './components/GoToDateDialog';
import { LayoutGrid } from './components/LayoutGrid';
import { useResizeObserver } from './hooks/useResizeObserver';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { usePersistence } from './hooks/usePersistence';

// ─────────────────────────────────────────────────────────────────────────────
// Inner component – rendered inside the active panel's ChartStoreContext so
// that Toolbar, sidebar panels, and keyboard shortcuts all operate on the
// currently-selected chart.
// ─────────────────────────────────────────────────────────────────────────────
function AppInner() {
  const { themeTokens } = useChartStore();
  const { layoutType } = useLayoutStore();
  const singlePanel = layoutType === '1';
  const { ref, width, height } = useResizeObserver<HTMLDivElement>();
  useKeyboardShortcuts();

  // Go-to-date dialog state
  const [goToDateOpen, setGoToDateOpen] = useState(false);
  const openGoToDate = useCallback(() => setGoToDateOpen(true), []);
  const closeGoToDate = useCallback(() => setGoToDateOpen(false), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setGoToDateOpen(true);
      }
    };
    const customHandler = () => setGoToDateOpen(true);
    window.addEventListener('keydown', handler);
    window.addEventListener('open-goto-date', customHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('open-goto-date', customHandler);
    };
  }, []);

  const bg     = themeTokens.background;
  const border = themeTokens.gridLine;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: bg,
        overflow: 'hidden',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <Toolbar />
      <GoToDateDialog open={goToDateOpen} onClose={closeGoToDate} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left sidebar – fixed width, always operates on the active panel */}
        <div
          style={{
            width: 224,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            borderRight: `1px solid ${border}`,
            overflowY: 'auto',
          }}
        >
          <IndicatorPanel />
          <BacktestPanel />
          <OverlayPanel />
          <TradeJournalPanel />
          <EphemerisPanel />
          <CycleCombinerPanel />
        </div>

        {/* Chart area */}
        {singlePanel ? (
          /* Single-panel: legacy layout with BacktestReport below canvas */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div ref={ref} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
              {width > 0 && height > 0 && (
                <>
                  <ChartCanvas width={width} height={height} />
                  <CandleTooltip />
                  <ChartControls />
                  <ReplayControls />
                  <MeasurementOverlay />
                </>
              )}
            </div>
            <BacktestReport />
          </div>
        ) : (
          /* Multi-panel grid */
          <LayoutGrid />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Root – resolves the active panel's store and provides it via context so
// the sidebar / toolbar always targets the correct chart.
// ─────────────────────────────────────────────────────────────────────────────

// Lazy import of the store cache from ChartPanel to resolve the active store.
// We import it here to avoid re-creating stores.
import { _getPanelStore } from './components/ChartPanel';

function App() {
  usePersistence(); // Runs outside context → operates on primaryChartStore (p1)

  const { activePanelId } = useLayoutStore();
  const activeStore = useMemo(
    () => _getPanelStore(activePanelId),
    [activePanelId],
  );

  return (
    <ChartStoreContext.Provider value={activeStore}>
      <AppInner />
    </ChartStoreContext.Provider>
  );
}

export default App;
