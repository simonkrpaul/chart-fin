/**
 * ChartPanel – a self-contained chart "window" that owns its own Zustand store.
 *
 * • Creates / reuses a store instance for the given panelId.
 * • Provides that store via ChartStoreContext so all child components
 *   (ChartCanvas, CandleTooltip, etc.) read from the correct panel state.
 * • Registers / unregisters with chartRegistry for sync-lock broadcast.
 * • Fires setActivePanel when the panel is clicked.
 */
import React, { useEffect, useMemo } from 'react';
import type { StoreApi } from 'zustand';
import { ChartStoreContext, createChartStore, primaryChartStore } from '../store/chartStore';
import type { ChartState, ChartActions } from '../store/chartStore';
import { chartRegistry } from '../store/chartRegistry';
import { useLayoutStore, LAYOUT_PANEL_IDS } from '../store/layoutStore';
import { ChartCanvas } from './ChartCanvas';
import { CandleTooltip } from './CandleTooltip';
import { ChartControls } from './ChartControls';
import { ReplayControls } from './ReplayControls';
import { MeasurementOverlay } from './MeasurementOverlay';
import { BacktestReport } from './BacktestReport';
import { useResizeObserver } from '../hooks/useResizeObserver';

// Module-level cache so switching layouts doesn't re-create stores.
const _storeCache = new Map<string, StoreApi<ChartState & ChartActions>>();

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function hydratePanelStoreFrom(source: StoreApi<ChartState & ChartActions>, target: StoreApi<ChartState & ChartActions>): void {
  const s = source.getState();
  target.setState({
    timeframe: s.timeframe,
    session: deepClone(s.session),
    primarySlots: deepClone(s.primarySlots),
    rawCandles: deepClone(s.rawCandles),
    baseCandles: deepClone(s.baseCandles),
    baseTimeframe: s.baseTimeframe,
    viewport: deepClone(s.viewport),
    priceScale: deepClone(s.priceScale),
    indicatorConfigs: deepClone(s.indicatorConfigs),
    indicatorSeries: deepClone(s.indicatorSeries),
    overlayConfigs: deepClone(s.overlayConfigs),
    overlays: deepClone(s.overlays),
    historicalCandlesByOverlay: deepClone(s.historicalCandlesByOverlay),
    drawings: deepClone(s.drawings),
    drawingInProgress: null,
    lastMeasurement: deepClone(s.lastMeasurement),
    crosshair: { visible: false, slotIndex: 0, timestamp: 0, price: 0, x: 0, y: 0 },
    theme: s.theme,
    themeTokens: deepClone(s.themeTokens),
    showIndicatorsAndDrawings: s.showIndicatorsAndDrawings,
    past: [],
    future: [],
    backtestConfig: deepClone(s.backtestConfig),
    backtestResult: deepClone(s.backtestResult),
    backtestSignals: deepClone(s.backtestSignals),
    backtestRunning: false,
    showBacktestSignals: s.showBacktestSignals,
    showBacktestReport: s.showBacktestReport,
    replay: { active: false, playing: false, index: 0, startIndex: 0, speed: 1 },
    tradeLogEntries: deepClone(s.tradeLogEntries),
    tradeLogRoundTrips: deepClone(s.tradeLogRoundTrips),
    showTradeLog: s.showTradeLog,
  });
}

export function _getPanelStore(panelId: string): StoreApi<ChartState & ChartActions> {
  if (panelId === 'p1') return primaryChartStore;
  if (!_storeCache.has(panelId)) {
    const target = createChartStore(panelId);
    const { activePanelId } = useLayoutStore.getState();
    const source = activePanelId === panelId
      ? primaryChartStore
      : (activePanelId === 'p1' ? primaryChartStore : (_storeCache.get(activePanelId) ?? primaryChartStore));
    hydratePanelStoreFrom(source, target);
    _storeCache.set(panelId, target);
  }
  return _storeCache.get(panelId)!;
}

function getOrCreateStore(panelId: string): StoreApi<ChartState & ChartActions> {
  return _getPanelStore(panelId);
}

interface Props {
  panelId: string;
}

export const ChartPanel: React.FC<Props> = ({ panelId }) => {
  const store = useMemo(() => getOrCreateStore(panelId), [panelId]);
  const { activePanelId, setActivePanel, layoutType, setLayout } = useLayoutStore();
  const isActive = activePanelId === panelId;
  const isMultiLayout = layoutType !== '1';

  // Register with sync-lock broadcast registry
  useEffect(() => {
    chartRegistry.register(panelId, {
      pan: (delta) => store.getState().pan(delta),
      zoom: (delta, anchor) => store.getState().zoom(delta, anchor),
    });
    return () => chartRegistry.unregister(panelId);
  }, [panelId, store]);

  const { ref, width, height } = useResizeObserver<HTMLDivElement>();

  const theme = store.getState().theme;
  const border = isActive
    ? '2px solid #2962ff'
    : theme === 'dark' ? '2px solid #2a2e39' : '2px solid #e0e3eb';

  return (
    <ChartStoreContext.Provider value={store}>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border,
          boxSizing: 'border-box',
          minWidth: 0,
          minHeight: 0,
          position: 'relative',
        }}
        onClick={() => !isActive && setActivePanel(panelId)}
      >
        {isMultiLayout && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              const visiblePanels = LAYOUT_PANEL_IDS[layoutType];
              const remainingId = visiblePanels.find((id) => id !== panelId);
              if (!remainingId) return;

              const remainingStore = _getPanelStore(remainingId);
              if (remainingId !== 'p1') {
                hydratePanelStoreFrom(remainingStore, primaryChartStore);
              }

              // Use p1 as the single-layout host to avoid blank states when
              // collapsing from multi-panel mode.
              setActivePanel('p1');
              setLayout('1');
            }}
            title="Close this chart"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 20,
              width: 24,
              height: 24,
              borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(0,0,0,0.35)',
              color: '#fff',
              cursor: 'pointer',
              lineHeight: 1,
              fontSize: 14,
            }}
          >
            x
          </button>
        )}

        {/* Canvas area */}
        <div ref={ref} style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
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
        {/* Backtest report docked below canvas */}
        <BacktestReport />
      </div>
    </ChartStoreContext.Provider>
  );
};
