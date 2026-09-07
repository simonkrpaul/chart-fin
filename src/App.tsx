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
import { IngestProgressBadge } from './components/IngestProgressBadge';
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
import { useLazyBackfill } from './hooks/useLazyBackfill';
import { requestPersistentStorage } from './db/marketStore';
import { restoreLastSession, markBootReady } from './store/chartSession';
import { ensureMarkets, ingestManifest } from './db/marketDb';

// Guards against React 19 StrictMode double-invocation of the boot effect.
let _bootRan = false;

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
  useLazyBackfill();

  // Ask the browser to mark chart-fin-db as persistent so it survives eviction.
  useEffect(() => { void requestPersistentStorage(); }, []);

  // Boot: seed markets, restore last session immediately. The manifest
  // ingest runs in the background so a fresh clone with 500 CSVs doesn't
  // block first paint. Module-level flag guards against React 19 StrictMode
  // double-invocation in dev (otherwise we'd fire two concurrent ingests
  // and two concurrent series loads).
  useEffect(() => {
    if (_bootRan) return;
    _bootRan = true;
    (async () => {
      await ensureMarkets();
      await restoreLastSession();
      markBootReady();
      // Only start the background manifest ingest AFTER the initial series
      // is loaded. Otherwise IDB write contention makes the first chart
      // paint 3–4× slower on machines with 500+ series to sync.
      // Small idle-callback so React commits + first paint happen first.
      const kick = () => { void ingestManifest(undefined, { background: true }); };
      if ('requestIdleCallback' in window) {
        (window as unknown as { requestIdleCallback: (cb: () => void) => void })
          .requestIdleCallback(kick);
      } else {
        setTimeout(kick, 500);
      }
    })();
  }, []);

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
      <IngestProgressBadge />
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
