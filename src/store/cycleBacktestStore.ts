/**
 * cycleBacktestStore – config, worker lifecycle and result of the offset-cycle
 * backtest. The full report lives on its own page (#cycle-report); trades are
 * also pushed into the chart store so buy/sell markers render on the chart.
 */
import { create } from 'zustand';
import type { StoreApi } from 'zustand';
import type { ChartState, ChartActions } from './chartStore';
import {
  DEFAULT_CYCLE_BACKTEST_CONFIG,
  barsFromSlots,
  sourceFromOverlay,
  toBacktestStats,
  type CycleBacktestConfig,
  type CycleBacktestResult,
} from '../engine/cycleBacktestEngine';
import type { CycleWorkerResponse } from '../workers/cycleBacktestWorker';

type ChartStoreApi = StoreApi<ChartState & ChartActions>;

const LS_CONFIG = 'chartfin.cycleBacktest.config';
const PAGE_HASH = '#cycle-report';

function readConfig(): CycleBacktestConfig {
  try {
    const raw = localStorage.getItem(LS_CONFIG);
    if (raw) return { ...DEFAULT_CYCLE_BACKTEST_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore corrupt storage */ }
  return { ...DEFAULT_CYCLE_BACKTEST_CONFIG };
}

interface CycleBacktestState {
  config: CycleBacktestConfig;
  result: CycleBacktestResult | null;
  running: boolean;
  progress: { pct: number; label: string };
  error: string | null;
  pageOpen: boolean;
  showChartStats: boolean;
  setConfig: (patch: Partial<CycleBacktestConfig>) => void;
  run: (chart: ChartStoreApi) => void;
  cancel: () => void;
  clear: () => void;
  openPage: () => void;
  closePage: () => void;
  setShowChartStats: (v: boolean) => void;
}

let worker: Worker | null = null;
let targetChart: ChartStoreApi | null = null;

export const useCycleBacktestStore = create<CycleBacktestState>()((set, get) => ({
  config: readConfig(),
  result: null,
  running: false,
  progress: { pct: 0, label: '' },
  error: null,
  pageOpen: typeof window !== 'undefined' && window.location.hash === PAGE_HASH,
  showChartStats: true,

  setConfig: (patch) => {
    const config = { ...get().config, ...patch };
    localStorage.setItem(LS_CONFIG, JSON.stringify(config));
    set({ config });
  },

  run: (chart) => {
    const { config } = get();
    const s = chart.getState();
    const overlay = s.overlays[config.overlayId];
    if (!overlay) {
      set({ error: 'Pick an offset overlay first (add one in the Offset Overlays tab).' });
      return;
    }
    const bars = barsFromSlots(s.primarySlots);
    const source = sourceFromOverlay(overlay);

    worker?.terminate();
    worker = new Worker(new URL('../workers/cycleBacktestWorker.ts', import.meta.url), { type: 'module' });
    targetChart = chart;
    set({ running: true, error: null, progress: { pct: 0, label: 'Starting' } });

    worker.onmessage = (evt: MessageEvent<CycleWorkerResponse>) => {
      const msg = evt.data;
      if (msg.type === 'progress') {
        set({ progress: { pct: msg.pct, label: msg.label } });
        return;
      }
      worker?.terminate();
      worker = null;
      if (msg.type === 'error') {
        set({ running: false, error: msg.message });
        return;
      }
      set({ running: false, result: msg.result, showChartStats: true });
      chart.setState({
        backtestResult: toBacktestStats(msg.result),
        backtestSignals: msg.result.chartSignals,
        showBacktestSignals: true,
        showBacktestReport: false,
      });
    };
    worker.onerror = (e) => {
      worker?.terminate();
      worker = null;
      set({ running: false, error: e.message || 'Backtest worker crashed' });
    };
    worker.postMessage({
      config,
      bars,
      source,
      meta: { overlayLabel: overlay.config.label, offsetDays: overlay.config.calendarDayOffset, timeframe: s.timeframe },
    });
  },

  cancel: () => {
    worker?.terminate();
    worker = null;
    set({ running: false, progress: { pct: 0, label: '' } });
  },

  clear: () => {
    get().cancel();
    targetChart?.setState({ backtestResult: null, backtestSignals: [], showBacktestSignals: false });
    targetChart = null;
    set({ result: null, error: null });
  },

  openPage: () => {
    window.location.hash = PAGE_HASH;
    set({ pageOpen: true });
  },

  closePage: () => {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    set({ pageOpen: false });
  },

  setShowChartStats: (v) => set({ showChartStats: v }),
}));

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    useCycleBacktestStore.setState({ pageOpen: window.location.hash === PAGE_HASH });
  });
}
