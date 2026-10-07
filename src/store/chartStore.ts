/**
 * Zustand store – single source of truth for all chart state.
 *
 * Slices:
 *   data       – primary slot array, timeframe, session
 *   viewport   – pan / zoom state
 *   indicators – computed indicator series
 *   overlays   – offset comparison overlays
 *   drawings   – user-drawn objects
 *   crosshair  – hover state
 *   ui         – theme, tool selection, layout prefs
 *
 * Worker bridge is initialized here and dispatches async ops.
 */
import { createContext, useContext } from 'react';
import { createStore, useStore } from 'zustand';
import type { StoreApi } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { chartRegistry } from './chartRegistry';
import { useLayoutStore } from './layoutStore';
import { randomId } from '../utils/id';
import type {
  CandleSlot,
  ChartLayout,
  CrosshairState,
  Drawing,
  DrawingTool,
  IndicatorConfig,
  IndicatorSeries,
  OffsetOverlay,
  OffsetOverlayConfig,
  PriceScale,
  RangeMeasurementResult,
  RawCandle,
  SessionConfig,
  ThemeTokens,
  Timeframe,
  Viewport,
  BacktestConfig,
  BacktestStats,
  BacktestSignal,
  BacktestStrategyId,
  TradeLogEntry,
  TradeLogRoundTrip,
  EphemerisMarker,
  TransitZoneGroup,
  CycleCombinerConfig,
  CycleCombinerOutput,
  CycleInput,
} from '../types';
import { DARK_THEME as darkTheme, LIGHT_THEME as lightTheme, DEFAULT_SESSION } from '../types';
import { runBacktest as _runBacktest } from '../engine/backtestEngine';
import { generateSlots, buildTimestampIndex, generateUnconstrainedSlots, INTRADAY_TIMEFRAMES, TIMEFRAME_MINUTES } from '../engine/calendarEngine';
import { toZonedTime } from '../engine/tzUtils';
import { normalizeCandles } from '../engine/normalizationEngine';
import { computeIndicator } from '../engine/indicatorEngine';
import { detectSwingPoints } from '../engine/indicatorEngine';
import { buildOffsetOverlay, assignOverlayVisuals } from '../engine/offsetEngine';
import { resampleCandles, canResample, filterBySessionHours } from '../engine/resampleEngine';
import { measureRange } from '../engine/measurementEngine';
import { parseTradeLogCsv, matchRoundTrips } from '../utils/tradeLogParser';

// ── EMA smoothing for cycle combiner ─────────────────────────────────────────
function _emaSmoothArray(data: (number | null)[], period: number): (number | null)[] {
  if (period <= 1) return data;
  const k = 2 / (period + 1);
  const result: (number | null)[] = new Array(data.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v === null) { result[i] = prev; continue; }
    if (prev === null) { prev = v; result[i] = v; continue; }
    prev = v * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

// Filter slots per the current gap-visibility mode.
//
//   session_trading_days
//     Drop every null-candle slot (overnight, weekend, holiday, real
//     data gaps). Only actual trading bars remain. slotIndex is
//     re-numbered so bars pack contiguously.
//
//   session_calendar_days
//     Same candles as trading_days — every real trading bar shown, no
//     mid-session data-gap columns, no overnight columns. The ONLY thing
//     added over trading_days is placeholder columns during session hours
//     on weekend and holiday days, so Fri close → Sat spacer → Sun spacer
//     → Mon open is visible.
//
// Uses overlap semantics on the timeframe bucket so mid-hour session
// opens (e.g. 09:30 on a 1h chart) still get their opening candle drawn
// on the aligned 09:00 slot instead of vanishing.
//
// Returned array is a new object each call.
function _applyGapVisibility(
  slots: CandleSlot[],
  mode: 'session_trading_days' | 'session_calendar_days',
  session: SessionConfig,
  timeframe: Timeframe,
): CandleSlot[] {
  if (mode === 'session_trading_days') {
    const kept = slots.filter(s => s.candle !== null);
    return kept.map((s, i) => ({ ...s, slotIndex: i }));
  }
  // session_calendar_days — need to check weekend/holiday time-of-day.
  const [openH, openM] = session.regularOpen.split(':').map(n => parseInt(n, 10));
  const [closeH, closeM] = session.regularClose.split(':').map(n => parseInt(n, 10));
  const openMin = openH * 60 + openM;
  const closeMin = closeH * 60 + closeM;
  const tfMin = TIMEFRAME_MINUTES[timeframe];
  const tz = session.timezone;
  const holidaySet = new Set(session.holidays);

  const kept = slots.filter(s => {
    // Any real trading candle is unconditionally kept. This deliberately does
    // NOT gate on `status === 'trading'` because status assignment involves
    // tz math on the slot's midnight boundary, and any subtle bug there
    // would silently mask real bars. If a candle exists at this slot, we
    // trust the data and render it. Guarantees Trading Days ⊆ Calendar Days.
    if (s.candle !== null) return true;
    // For empty slots, decide weekend/holiday classification directly from
    // the timestamp (in session tz) rather than trusting `s.status`. Any
    // slot generator hiccup that mislabels a Sunday would otherwise cause
    // Sunday spacer columns to silently disappear. Format the date via the
    // tz-aware formatter so DST and local-midnight edge cases can't shift it.
    const local = toZonedTime(new Date(s.timestamp), tz);
    const startMin = local.getHours() * 60 + local.getMinutes();
    const endMin = startMin + tfMin;
    if (!(startMin < closeMin && endMin > openMin)) return false;
    const jsDay = local.getDay();                    // 0=Sun ... 6=Sat
    const isoWeekday = jsDay === 0 ? 7 : jsDay;      // 1=Mon ... 7=Sun
    const isTradingDay = session.tradingDays.includes(isoWeekday);
    const y = local.getFullYear();
    const m = String(local.getMonth() + 1).padStart(2, '0');
    const d = String(local.getDate()).padStart(2, '0');
    const isHoliday = holidaySet.has(`${y}-${m}-${d}`);
    // Empty slot inside a session-hour window on a non-trading day (weekend
    // or holiday) → spacer placeholder. All other empty slots → drop.
    return !isTradingDay || isHoliday;
  });
  return kept.map((s, i) => ({ ...s, slotIndex: i }));
}

// How many slots (including extrapolated future overlay/combiner slots) the chart spans.
function _effectiveSlotCount(state: { primarySlots: CandleSlot[]; overlays: Record<string, OffsetOverlay>; cycleCombinerOutput?: CycleCombinerOutput | null; cycleCombinerConfig?: CycleCombinerConfig }): number {
  let max = state.primarySlots.length;
  for (const ov of Object.values(state.overlays)) {
    if (!ov.config.visible) continue;
    for (const pc of ov.projectedCandles) {
      if (pc.projectedSlotIndex > max) max = pc.projectedSlotIndex;
    }
  }
  // Extend for cycle combiner forward projection
  if (state.cycleCombinerConfig?.visible && state.cycleCombinerOutput) {
    const combLen = state.cycleCombinerOutput.values.length;
    if (combLen > max) max = combLen;
  }
  return Math.ceil(max) + 1;
}

function _resolveOverlayHistoricalCandles(
  state: ChartState,
  cfg: OffsetOverlayConfig,
  fallback: RawCandle[] = [],
): RawCandle[] {
  const source = state.baseCandles.length > 0 ? state.baseCandles : state.rawCandles;
  let resolved = source.filter(
    c => c.timestamp >= cfg.sourceStartTimestamp && c.timestamp <= cfg.sourceEndTimestamp,
  );

  if (resolved.length === 0) resolved = fallback;
  if (resolved.length === 0) return resolved;

  // Keep overlay source aligned with the display timeframe so each projected
  // slot maps to one timeframe-consistent candle instead of stacked minis.
  const sourceTf = state.baseCandles.length > 0 ? state.baseTimeframe : state.timeframe;
  if (sourceTf && sourceTf !== state.timeframe && canResample(sourceTf, state.timeframe)) {
    try {
      return resampleCandles(resolved, state.timeframe);
    } catch {
      return resolved;
    }
  }

  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// State shape
// ─────────────────────────────────────────────────────────────────────────────

export interface ChartState {
  // Data
  timeframe: Timeframe;
  session: SessionConfig;
  primarySlots: CandleSlot[];
  rawCandles: RawCandle[];
  /** Finest-grain candles loaded — source for resampling to coarser timeframes. */
  baseCandles: RawCandle[];
  baseTimeframe: Timeframe | null;

  // Viewport
  viewport: Viewport;
  priceScale: PriceScale;

  // Indicators
  indicatorConfigs: IndicatorConfig[];
  indicatorSeries: Record<string, IndicatorSeries>; // keyed by config.id

  // Overlays
  overlayConfigs: OffsetOverlayConfig[];
  overlays: Record<string, OffsetOverlay>; // keyed by config.id
  historicalCandlesByOverlay: Record<string, RawCandle[]>;
  /** Master switch that hides every offset overlay without discarding each
   *  config's own `visible` flag — flip off for a one-click clean chart, flip
   *  back on to restore whatever the user had toggled per-overlay. */
  showOverlays: boolean;
  /** When true AND ≥ 2 visible overlays agree on candle direction at a slot,
   *  paint a subtle vertical band behind the main candles (green = all up,
   *  red = all down). Any disagreement or missing overlay candle → no band. */
  offsetConfluenceHighlight: boolean;

  // Drawings
  drawings: Drawing[];
  activeDrawingTool: DrawingTool;
  drawingInProgress: Drawing | null;

  // Measurements
  lastMeasurement: RangeMeasurementResult | null;

  // Crosshair
  crosshair: CrosshairState;

  // UI
  theme: 'dark' | 'light';
  themeTokens: ThemeTokens;
  showIndicatorsAndDrawings: boolean;
  /**
   * Two-state gap-visibility mode. Source of truth for how empty slots
   * are filtered before rendering:
   *   • 'session_trading_days'  – drop every null-candle slot AND every
   *                                weekend / holiday slot. Trading bars
   *                                (session hours only) are packed
   *                                contiguously; Fri close is followed
   *                                immediately by Mon open.
   *   • 'session_calendar_days' – drop overnight ('outside_session')
   *                                slots on trading days, but keep
   *                                weekend / holiday placeholder columns
   *                                during the session window so
   *                                Sat + Sun appear as empty spacers
   *                                between Fri close and Mon open. Real
   *                                mid-session data gaps stay visible.
   */
  gapVisibility: 'session_trading_days' | 'session_calendar_days';
  /**
   * Legacy alias — true whenever `gapVisibility === 'session_calendar_days'`.
   * Kept in sync so the canvas renderer's underscore-glyph logic works
   * unchanged.
   */
  showEmptyGapSlots: boolean;

  // Current DB-loaded series context (used for lazy backfill on pan-left).
  currentSeries: { market: string; symbol: string; timeframe: Timeframe } | null;
  /** True when an async DB backfill is in flight – suppresses re-entry. */
  backfillInFlight: boolean;

  // History (undo/redo)
  past: Drawing[][];
  future: Drawing[][];

  // Backtesting
  backtestConfig: BacktestConfig;
  backtestResult: BacktestStats | null;
  backtestSignals: BacktestSignal[];
  backtestRunning: boolean;
  showBacktestSignals: boolean;
  showBacktestReport: boolean;

  // Bar replay
  replay: {
    active: boolean;
    playing: boolean;
    index: number;       // current "now" bar – candles up to here are visible
    startIndex: number;  // where replay started from
    speed: number;       // bars per second
  };

  // Trade Journal
  tradeLogEntries: TradeLogEntry[];
  tradeLogRoundTrips: TradeLogRoundTrip[];
  showTradeLog: boolean;

  // Ephemeris markers
  ephemerisMarkers: EphemerisMarker[];
  showEphemerisMarkers: boolean;

  // Custom transit zones
  transitZoneGroups: TransitZoneGroup[];

  // Cycle combiner
  cycleCombinerConfig: CycleCombinerConfig;
  cycleCombinerOutput: CycleCombinerOutput | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

export interface ChartActions {
  // Data loading
  setTimeframe: (tf: Timeframe) => void;
  setSession: (s: SessionConfig) => void;
  /** Override just the session's regular open / close (both "HH:MM"). */
  setSessionHours: (open: string, close: string) => void;
  /** Detect the tightest ≥99% session window from the loaded candles. */
  autoDetectSessionHours: () => void;
  /** Reset the session to the current market's preset (escape hatch). */
  resetSessionToMarketPreset: () => void;
  /** Change the display/session timezone and re-generate all slots. */
  setTimezone: (tz: string) => void;
  /**
   * Load new candles. When `_preserveBase` is true (internal use only), the
   * baseCandles/baseTimeframe fields are not overwritten so that switching
   * timeframes can keep resampling from the original finest-grain data.
   */
  loadCandles: (raw: RawCandle[], startMs: number, endMs: number, _preserveBase?: boolean) => void;
  appendCandles: (raw: RawCandle[]) => void;
  /** Prepend older candles (used by lazy backfill). Keeps viewport locked to the same slot the user was viewing. */
  prependCandles: (raw: RawCandle[]) => void;
  /** Record the DB series currently backing this chart so lazy backfill knows what to fetch. */
  setCurrentSeries: (series: { market: string; symbol: string; timeframe: Timeframe } | null) => void;
  setBackfillInFlight: (v: boolean) => void;
  addBarPatternOverlay: (sourceStartSlotIndex: number, sourceEndSlotIndex: number) => void;

  // Viewport
  setViewport: (v: Partial<Viewport>) => void;
  setPriceScale: (p: Partial<PriceScale>) => void;
  /** Shift price range by `priceDelta` (positive = up) */
  panPrice: (priceDelta: number) => void;
  /** Expand/contract price range around centre by factor (>1 = zoom out, <1 = zoom in) */
  scalePrice: (factor: number) => void;
  /** Re-enable autoFit and immediately refit the price scale to visible bars */
  resetPriceScale: () => void;
  zoom: (delta: number, anchorSlotIndex: number) => void;
  pan: (slotDelta: number) => void;
  /** Snap to show the last N bars and re-fit the price scale. */
  resetView: () => void;

  // Replay
  startReplay: (fromSlotIndex: number) => void;
  stopReplay: () => void;
  setReplayPlaying: (playing: boolean) => void;
  stepReplay: (delta: number) => void;
  setReplaySpeed: (speed: number) => void;
  tickReplay: () => void;

  // Indicators
  addIndicator: (config: IndicatorConfig) => void;
  removeIndicator: (id: string) => void;
  toggleIndicator: (id: string) => void;
  updateIndicatorConfig: (id: string, params: Record<string, number | string | boolean>) => void;
  recomputeAllIndicators: () => void;

  // Overlays
  addOverlay: (config: OffsetOverlayConfig, historicalCandles: RawCandle[]) => void;
  removeOverlay: (id: string) => void;
  toggleOverlay: (id: string) => void;
  toggleShowOverlays: () => void;
  toggleOffsetConfluenceHighlight: () => void;
  updateOverlayConfig: (id: string, patch: Partial<OffsetOverlayConfig>) => void;

  // Drawings
  setDrawingTool: (tool: DrawingTool) => void;
  startDrawing: (d: Drawing) => void;
  updateDrawingInProgress: (d: Drawing) => void;
  commitDrawing: () => void;
  cancelDrawing: () => void;
  updateDrawing: (id: string, patch: Partial<Drawing>) => void;
  deleteDrawing: (id: string) => void;
  undoDrawing: () => void;
  redoDrawing: () => void;

  // Backtest
  runBacktest: () => void;
  updateBacktestConfig: (patch: Partial<BacktestConfig>) => void;
  clearBacktest: () => void;
  toggleBacktestSignals: () => void;
  toggleBacktestReport: () => void;

  // Measurements
  measureSelectedRange: (startSlotIndex: number, endSlotIndex: number) => void;

  // Trade Journal
  loadTradeLog: (csvText: string) => void;
  clearTradeLog: () => void;
  toggleTradeLog: () => void;

  // Ephemeris markers
  setEphemerisMarkers: (markers: EphemerisMarker[]) => void;
  clearEphemerisMarkers: () => void;
  toggleEphemerisMarkers: () => void;

  // Custom transit zones
  addTransitZoneGroup: (group: Omit<TransitZoneGroup, 'id'>) => void;
  removeTransitZoneGroup: (id: string) => void;
  toggleTransitZoneGroup: (id: string) => void;
  clearAllTransitZones: () => void;

  // Cycle combiner
  setCycleCombinerConfig: (config: Partial<CycleCombinerConfig>) => void;
  addCycleInput: (input: CycleInput) => void;
  removeCycleInput: (index: number) => void;
  updateCycleInput: (index: number, patch: Partial<CycleInput>) => void;
  recomputeCycleCombiner: () => void;

  // Crosshair
  setCrosshair: (c: Partial<CrosshairState>) => void;

  // UI
  setTheme: (t: 'dark' | 'light') => void;
  toggleIndicatorsAndDrawingsVisibility: () => void;
  /** Toggle between the two gap-visibility modes. */
  toggleEmptyGapSlots: () => void;
  /** Set gap visibility directly. */
  setGapVisibility: (mode: 'session_trading_days' | 'session_calendar_days') => void;

  // Layout persistence
  exportLayout: () => ChartLayout;
  importLayout: (layout: ChartLayout) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial state
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_VIEWPORT: Viewport = {
  firstSlotIndex: 0,
  visibleSlotCount: 200,
  width: 1200,
  mainPaneHeight: 500,
  subPaneHeight: 120,
  priceAxisWidth: 70,
  timeAxisHeight: 30,
};

const INITIAL_PRICE_SCALE: PriceScale = {
  min: 0,
  max: 100,
  autoFit: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Store factory – creates an independent Zustand store for one chart panel.
// The primary store (`primaryChartStore`) is the legacy single-panel store.
// ─────────────────────────────────────────────────────────────────────────────

export function createChartStore(panelId: string = 'p1'): StoreApi<ChartState & ChartActions> {
  return createStore<ChartState & ChartActions>()(
  immer((set, get) => ({
    // ── initial data state ──────────────────────────────────────────────────
    timeframe: '5m',
    session: DEFAULT_SESSION,
    primarySlots: [],
    rawCandles: [],
    baseCandles: [],
    baseTimeframe: null,

    // ── viewport ────────────────────────────────────────────────────────────
    viewport: INITIAL_VIEWPORT,
    priceScale: INITIAL_PRICE_SCALE,

    // ── indicators ──────────────────────────────────────────────────────────
    indicatorConfigs: [],
    indicatorSeries: {},

    // ── overlays ────────────────────────────────────────────────────────────
    overlayConfigs: [],
    overlays: {},
    historicalCandlesByOverlay: {},
    showOverlays: true,
    offsetConfluenceHighlight: false,

    // ── drawings ────────────────────────────────────────────────────────────
    drawings: [],
    activeDrawingTool: 'none',
    drawingInProgress: null,

    // ── measurements ────────────────────────────────────────────────────────
    lastMeasurement: null,

    // ── crosshair ───────────────────────────────────────────────────────────
    crosshair: { visible: false, slotIndex: 0, timestamp: 0, price: 0, x: 0, y: 0 },

    // ── ui ──────────────────────────────────────────────────────────────────
    theme: 'dark',
    themeTokens: darkTheme,
    showIndicatorsAndDrawings: true,
    // Default: calendar-days packing (overnight gaps removed, weekend +
    // holiday spacer columns preserved so day-to-day rhythm is visible).
    // Toggle to trading-days to pack Fri close → Mon open contiguously.
    gapVisibility: 'session_calendar_days',
    showEmptyGapSlots: true,

    // ── current DB series ──────────────────────────────────────────────────
    currentSeries: null,
    backfillInFlight: false,

    // ── history ─────────────────────────────────────────────────────────────
    past: [],
    future: [],

    // ── backtest ────────────────────────────────────────────────────────────
    backtestConfig: {
      strategyId: 'ema_crossover' as BacktestStrategyId,
      params: { fastPeriod: 9, slowPeriod: 21 },
      allowShorts: false,
      initialEquity: 10000,
      commissionPct: 0.1,
      takeProfitPct: 0,
      stopLossPct: 0,
      slDelayBars: 0,
      holdForTpSl: true,
      tradeDirection: 'long_only' as const,
    },
    backtestResult: null,
    backtestSignals: [],
    backtestRunning: false,
    showBacktestSignals: true,
    showBacktestReport: false,

    // ── replay ──────────────────────────────────────────────────────────────
    replay: { active: false, playing: false, index: 0, startIndex: 0, speed: 1 },

    // ── trade journal ────────────────────────────────────────────────────────
    tradeLogEntries: [],
    tradeLogRoundTrips: [],
    showTradeLog: true,

    // ── ephemeris markers ────────────────────────────────────────────────────
    ephemerisMarkers: [],
    showEphemerisMarkers: true,

    // ── custom transit zones ─────────────────────────────────────────────────
    transitZoneGroups: [],

    // ── cycle combiner ───────────────────────────────────────────────────────
    cycleCombinerConfig: {
      cycles: [],
      smoothing: 5,
      visible: true,
      color: '#00e5ff',
    },
    cycleCombinerOutput: null,

    // ────────────────────────────────────────────────────────────────────────
    // DATA ACTIONS
    // ────────────────────────────────────────────────────────────────────────

    setTimeframe: (tf) => {
      set(state => { state.timeframe = tf; });
      // Re-generate slots and re-normalize candles with new timeframe.
      // If we have base (finest-grain) candles and the target TF is coarser,
      // resample from the base instead of using the current rawCandles.
      const s = get();
      const base = s.baseCandles.length > 0 ? s.baseCandles : s.rawCandles;
      const baseTf = s.baseTimeframe ?? tf;
      if (base.length === 0) return;

      // Drop extended-hours bars before resample so higher-TF buckets at the
      // session open don't blend pre-market data with the real opening bar.
      const filteredBase = filterBySessionHours(base, s.session, baseTf);

      let source: RawCandle[];
      if (canResample(baseTf, tf)) {
        source = resampleCandles(filteredBase, tf);
      } else {
        source = filteredBase;
      }

      // Build a session-aware slot grid so weekends/holidays become empty
      // slots (rendered as gaps or "_" markers), then place candles into it.
      // Falls back to a raw-timestamp grid when the session grid fits poorly
      // (e.g. 24/7 crypto on a weekday-only preset).
      const sorted = [...source].sort((a, b) => a.timestamp - b.timestamp);
      if (sorted.length === 0) return;
      const startMs = sorted[0].timestamp;
      const endMs   = sorted[sorted.length - 1].timestamp;

      let slots = generateSlots(startMs, endMs, tf, s.session);
      let normalized = normalizeCandles(slots, sorted, tf);

      const tradingSlots = normalized.filter(sl => sl.status === 'trading').length;
      const filled = normalized.filter(sl => sl.candle !== null).length;
      const capturedFraction = sorted.length > 0 ? filled / sorted.length : 1;
      const poorIntradayFit = INTRADAY_TIMEFRAMES.includes(tf)
        && tradingSlots > 0
        && (filled / tradingSlots < 0.15 || capturedFraction < 0.5);
      const poorGeneralFit = capturedFraction < 0.8;

      if (poorIntradayFit || poorGeneralFit) {
        slots = generateUnconstrainedSlots(startMs, endMs, tf);
        normalized = normalizeCandles(slots, sorted, tf);
      }

      normalized = _applyGapVisibility(normalized, s.gapVisibility, s.session, tf);

      const visibleCount = Math.min(200, normalized.length);

      set(state => {
        state.rawCandles = source;
        state.primarySlots = normalized;
        state.viewport.firstSlotIndex = Math.max(0, normalized.length - visibleCount);
        state.viewport.visibleSlotCount = visibleCount;
      });

      // Recompute indicators and overlays on the new timeline
      get().recomputeAllIndicators();
      const configs = get().overlayConfigs;
      for (const cfg of configs) {
        const cs = get();
        const resolvedHist = _resolveOverlayHistoricalCandles(cs, cfg, cs.historicalCandlesByOverlay[cfg.id] ?? []);
        set(state => {
          state.overlays[cfg.id] = buildOffsetOverlay(state.primarySlots, cfg, resolvedHist, state.session, state.timeframe);
          state.historicalCandlesByOverlay[cfg.id] = resolvedHist;
        });
      }
      get().recomputeCycleCombiner();
      _autoFitPriceScale(set, get);
    },

    setSession: (session) => {
      set(state => { state.session = session; });
    },

    /**
     * Update just the session's regular open / close (both "HH:MM"). Rebuilds
     * primarySlots so bars outside the new window disappear immediately.
     */
    setSessionHours: (open: string, close: string) => {
      set(state => {
        state.session = { ...state.session, regularOpen: open, regularClose: close };
      });
      const s = get();
      if (s.baseCandles.length > 0) get().setTimeframe(s.timeframe);
    },

    /**
     * Inspect the loaded baseCandles and infer the tightest session window
     * that contains ≥99% of the bars (per minute-of-day, in session tz).
     * Applies the result via setSessionHours() so the chart reloads.
     *
     * Safety rails:
     *  - Requires at least MIN_SAMPLE bars total; otherwise no-op.
     *  - Rejects windows shorter than MIN_WINDOW_MIN minutes to guard against
     *    sparse data producing a nonsense 25-minute session.
     */
    autoDetectSessionHours: () => {
      const s = get();
      const src = s.baseCandles.length > 0 ? s.baseCandles : s.rawCandles;
      const MIN_SAMPLE = 200;         // fewer bars → detection is unreliable
      const MIN_WINDOW_MIN = 60;      // never collapse below 1h
      if (src.length < MIN_SAMPLE) {
        console.warn(`[hurst] auto-detect skipped: only ${src.length} bars available (need ${MIN_SAMPLE}).`);
        return;
      }
      const tz = s.session.timezone;
      const perMin = new Array(1440).fill(0);
      for (const c of src) {
        const local = toZonedTime(new Date(c.timestamp), tz);
        const m = local.getHours() * 60 + local.getMinutes();
        perMin[m]++;
      }
      const total = src.length;
      const target = Math.floor(total * 0.99);
      const prefix = new Array(1441).fill(0);
      for (let i = 0; i < 1440; i++) prefix[i + 1] = prefix[i] + perMin[i];

      let bestStart = 0, bestEnd = 1440, bestSize = 1440;
      for (let start = 0; start < 1440; start++) {
        if (perMin[start] === 0) continue;
        let lo = start + 1, hi = 1440;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (prefix[mid] - prefix[start] >= target) hi = mid;
          else lo = mid + 1;
        }
        if (lo <= 1440 && prefix[lo] - prefix[start] >= target) {
          const size = lo - start;
          if (size < bestSize && size >= MIN_WINDOW_MIN) {
            bestSize = size; bestStart = start; bestEnd = lo;
          }
        }
      }
      // If we never found a window >= MIN_WINDOW_MIN that meets the 99%
      // target, expand around the busiest minute to a MIN_WINDOW_MIN
      // window as a sane fallback.
      if (bestSize === 1440) {
        let peak = 0, peakIdx = 0;
        for (let i = 0; i < 1440; i++) if (perMin[i] > peak) { peak = perMin[i]; peakIdx = i; }
        bestStart = Math.max(0, peakIdx - MIN_WINDOW_MIN / 2);
        bestEnd = Math.min(1440, bestStart + MIN_WINDOW_MIN);
      }

      bestStart = Math.floor(bestStart / 5) * 5;
      bestEnd = Math.ceil(bestEnd / 5) * 5;
      const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      get().setSessionHours(fmt(bestStart), fmt(Math.min(bestEnd, 1440)));
    },

    /**
     * Reset the session to whatever the current market's preset dictates.
     * Escape hatch when auto-detect or manual override left the session in
     * a weird state.
     */
    resetSessionToMarketPreset: () => {
      const s = get();
      const market = s.currentSeries?.market;
      if (!market) return;
      // Use the same lookup path as openSeries.
      import('../engine/marketPresets').then(({ getMarketPreset }) => {
        const preset = getMarketPreset(market);
        if (!preset) return;
        set(state => { state.session = preset.session; });
        const cur = get();
        if (cur.baseCandles.length > 0) get().setTimeframe(cur.timeframe);
      });
    },

    setTimezone: (tz) => {
      set(state => { state.session = { ...state.session, timezone: tz }; });
      // Re-run the full pipeline so generateSlots / _applyGapVisibility pick up
      // the new tz and weekend spacers stay put in calendar-day mode.
      const s = get();
      if (s.baseCandles.length > 0) get().setTimeframe(s.timeframe);
    },

    loadCandles: (raw, startMs, endMs, _preserveBase = false) => {
      const { timeframe, session } = get();
      let slots = generateSlots(startMs, endMs, timeframe, session);
      let normalized = normalizeCandles(slots, raw, timeframe);

      // Session-based grids can drop candles when data is 24/7 (crypto) or
      // otherwise not aligned to exchange session boundaries. Detect low capture
      // and switch to a uniform unconstrained timeline to avoid visible gaps.
      const tradingSlots = normalized.filter(s => s.status === 'trading').length;
      const filled = normalized.filter(s => s.candle !== null).length;
      const capturedFraction = raw.length > 0 ? filled / raw.length : 1;

      const poorIntradayFit = INTRADAY_TIMEFRAMES.includes(timeframe)
        && tradingSlots > 0
        && (filled / tradingSlots < 0.15 || capturedFraction < 0.5);

      // For higher timeframes we still fall back when the session grid misses a
      // meaningful chunk of candles (e.g. weekend candles on 24/7 daily data).
      const poorGeneralFit = capturedFraction < 0.8;

      if (poorIntradayFit || poorGeneralFit) {
        slots = generateUnconstrainedSlots(startMs, endMs, timeframe);
        normalized = normalizeCandles(slots, raw, timeframe);
      }

      normalized = _applyGapVisibility(normalized, get().gapVisibility, get().session, timeframe);
      const visibleCount = Math.min(200, normalized.length);

      set(state => {
        state.rawCandles = raw;
        if (!_preserveBase) {
          // Fresh data load — record as the new base for resampling
          state.baseCandles = raw;
          state.baseTimeframe = timeframe;
        }
        state.primarySlots = normalized;
        state.viewport.firstSlotIndex = Math.max(0, normalized.length - visibleCount);
        state.viewport.visibleSlotCount = visibleCount;
      });

      // Recompute indicators and overlays
      get().recomputeAllIndicators();
      // Re-project each overlay
      const configs = get().overlayConfigs;
      for (const cfg of configs) {
        const s = get();
        const resolvedHist = _resolveOverlayHistoricalCandles(s, cfg, s.historicalCandlesByOverlay[cfg.id] ?? []);
        set(state => {
          state.overlays[cfg.id] = buildOffsetOverlay(state.primarySlots, cfg, resolvedHist, state.session, state.timeframe);
          state.historicalCandlesByOverlay[cfg.id] = resolvedHist;
        });
      }

      // Auto-fit price scale
      _autoFitPriceScale(set, get);
    },

    appendCandles: (incoming) => {
      set(state => {
        const tsIndex = buildTimestampIndex(state.primarySlots);
        const nextPrimarySlots = [...state.primarySlots];
        const newRaw = [...state.rawCandles];

        for (const c of incoming) {
          const si = tsIndex.get(c.timestamp);
          if (si !== undefined) {
            nextPrimarySlots[si] = { ...nextPrimarySlots[si], candle: c };
          }
          const existingIdx = newRaw.findIndex(r => r.timestamp === c.timestamp);
          if (existingIdx >= 0) newRaw[existingIdx] = c;
          else newRaw.push(c);
        }

        state.rawCandles = newRaw;
        state.primarySlots = nextPrimarySlots;
        if (state.baseTimeframe === null || state.timeframe === state.baseTimeframe) {
          state.baseCandles = newRaw;
        }
      });

      // Keep indicator and overlay projections synchronized with new bars.
      get().recomputeAllIndicators();
      const configs = get().overlayConfigs;
      for (const cfg of configs) {
        const s = get();
        const resolvedHist = _resolveOverlayHistoricalCandles(s, cfg, s.historicalCandlesByOverlay[cfg.id] ?? []);
        set(state => {
          state.overlays[cfg.id] = buildOffsetOverlay(state.primarySlots, cfg, resolvedHist, state.session, state.timeframe);
          state.historicalCandlesByOverlay[cfg.id] = resolvedHist;
        });
      }

      _autoFitPriceScale(set, get);
    },

    prependCandles: (older) => {
      if (older.length === 0) return;
      const { rawCandles, timeframe, session, viewport } = get();
      if (rawCandles.length === 0) {
        // No baseline yet – fall through to full loadCandles.
        const startMs = older[0].timestamp;
        const endMs = older[older.length - 1].timestamp;
        get().loadCandles(older, startMs, endMs);
        return;
      }

      // Merge older ⨯ existing without duplicates, preserving ascending order.
      const seen = new Set<number>(rawCandles.map(c => c.timestamp));
      const merged: RawCandle[] = [];
      for (const c of older) if (!seen.has(c.timestamp)) merged.push(c);
      if (merged.length === 0) return;
      const combined = [...merged, ...rawCandles];
      combined.sort((a, b) => a.timestamp - b.timestamp);

      const startMs = combined[0].timestamp;
      const endMs = combined[combined.length - 1].timestamp;

      // Rebuild slots against the extended range.
      let slots = generateSlots(startMs, endMs, timeframe, session);
      let normalized = normalizeCandles(slots, combined, timeframe);
      const tradingSlots = normalized.filter(s => s.status === 'trading').length;
      const filled = normalized.filter(s => s.candle !== null).length;
      const capturedFraction = combined.length > 0 ? filled / combined.length : 1;
      const poorIntraday = INTRADAY_TIMEFRAMES.includes(timeframe)
        && tradingSlots > 0
        && (filled / tradingSlots < 0.15 || capturedFraction < 0.5);
      const poorGeneral = capturedFraction < 0.8;
      if (poorIntraday || poorGeneral) {
        slots = generateUnconstrainedSlots(startMs, endMs, timeframe);
        normalized = normalizeCandles(slots, combined, timeframe);
      }

      normalized = _applyGapVisibility(normalized, get().gapVisibility, session, timeframe);

      // Lock the viewport to the same rightmost slot the user was looking at
      // so the visible window doesn't jump when we prepend history.
      const shift = normalized.length - get().primarySlots.length;

      set(state => {
        state.rawCandles = combined;
        if (state.baseTimeframe === null || state.timeframe === state.baseTimeframe) {
          state.baseCandles = combined;
        }
        state.primarySlots = normalized;
        state.viewport.firstSlotIndex = Math.max(0, viewport.firstSlotIndex + shift);
      });

      get().recomputeAllIndicators();
      const configs = get().overlayConfigs;
      for (const cfg of configs) {
        const s = get();
        const resolvedHist = _resolveOverlayHistoricalCandles(s, cfg, s.historicalCandlesByOverlay[cfg.id] ?? []);
        set(state => {
          state.overlays[cfg.id] = buildOffsetOverlay(state.primarySlots, cfg, resolvedHist, state.session, state.timeframe);
          state.historicalCandlesByOverlay[cfg.id] = resolvedHist;
        });
      }
      _autoFitPriceScale(set, get);
    },

    setCurrentSeries: (series) => {
      set(state => { state.currentSeries = series; });
    },

    setBackfillInFlight: (v) => {
      set(state => { state.backfillInFlight = v; });
    },

    addBarPatternOverlay: (sourceStartSlotIndex, sourceEndSlotIndex) => {
      const { primarySlots, rawCandles } = get();
      const lo = Math.min(sourceStartSlotIndex, sourceEndSlotIndex);
      const hi = Math.max(sourceStartSlotIndex, sourceEndSlotIndex);
      if (lo < 0 || hi >= primarySlots.length) return;

      const sourceStartMs = primarySlots[lo].timestamp;
      const sourceEndMs   = primarySlots[hi].timestamp;
      // Project the selected range forward so it starts at the last visible slot
      const lastSlot = primarySlots[primarySlots.length - 1];
      const shiftMs  = lastSlot.timestamp - sourceStartMs;
      const shiftDays = Math.round(shiftMs / (24 * 60 * 60 * 1000));

      // Filter raw candles by UTC calendar date to avoid session-vs-midnight timestamp
      // mismatches (daily slots are at session-open UTC, raw candles often at midnight UTC).
      const startDateStr = new Date(sourceStartMs).toISOString().slice(0, 10);
      const endDateStr   = new Date(sourceEndMs).toISOString().slice(0, 10);
      const historicalCandles = rawCandles.filter(c => {
        const d = new Date(c.timestamp).toISOString().slice(0, 10);
        return d >= startDateStr && d <= endDateStr;
      });

      const config: import('../types').OffsetOverlayConfig = {
        id: randomId(),
        label: `Pattern ${new Date(sourceStartMs).toLocaleDateString()}`,
        sourceStartTimestamp: sourceStartMs,
        sourceEndTimestamp: sourceEndMs,
        calendarDayOffset: shiftDays,
        mode: 'overlay',
        anchorType: 'date',
        color: '',
        opacity: 0.75,
        lineOnly: false,
        dashed: true,
        visible: true,
        zIndex: 0,
        showSwingHL: false,
        swingHLLeftRight: 5,
      };
      get().addOverlay(config, historicalCandles);
    },

    // ────────────────────────────────────────────────────────────────────────
    // VIEWPORT ACTIONS
    // ────────────────────────────────────────────────────────────────────────

    setViewport: (patch) => {
      set(state => { Object.assign(state.viewport, patch); });
    },

    setPriceScale: (patch) => {
      set(state => { Object.assign(state.priceScale, patch); });
    },

    panPrice: (priceDelta) => {
      set(state => {
        state.priceScale.autoFit = false;
        state.priceScale.min += priceDelta;
        state.priceScale.max += priceDelta;
      });
    },

    scalePrice: (factor) => {
      set(state => {
        const { min, max } = state.priceScale;
        const mid = (min + max) / 2;
        const half = ((max - min) / 2) * factor;
        state.priceScale.autoFit = false;
        state.priceScale.min = mid - half;
        state.priceScale.max = mid + half;
      });
    },

    resetPriceScale: () => {
      set(state => { state.priceScale.autoFit = true; });
      _autoFitPriceScale(set, get);
    },

    zoom: (delta, anchorSlotIndex) => {
      set(state => {
        const vp = state.viewport;
        const effective = _effectiveSlotCount(state);
        const newCount = Math.max(20, Math.min(
          effective,
          Math.round(vp.visibleSlotCount * (1 + delta * 0.1)),
        ));
        // Keep anchor slot in same screen position
        const ratio = (anchorSlotIndex - vp.firstSlotIndex) / vp.visibleSlotCount;
        const newFirst = Math.max(0, Math.round(anchorSlotIndex - ratio * newCount));
        vp.visibleSlotCount = newCount;
        vp.firstSlotIndex = Math.min(newFirst, Math.max(0, effective - newCount));
      });
      _autoFitPriceScale(set, get);
      const { syncLock } = useLayoutStore.getState();
      if (syncLock) chartRegistry.broadcastZoom(panelId, delta, anchorSlotIndex);
    },

    pan: (slotDelta) => {
      set(state => {
        const vp = state.viewport;
        const effective = _effectiveSlotCount(state);
        const maxFirst = Math.max(0, effective - vp.visibleSlotCount);
        vp.firstSlotIndex = Math.max(0, Math.min(maxFirst, vp.firstSlotIndex + slotDelta));
      });
      _autoFitPriceScale(set, get);
      const { syncLock } = useLayoutStore.getState();
      if (syncLock) chartRegistry.broadcastPan(panelId, slotDelta);
    },

    resetView: () => {
      set(state => {
        const vp = state.viewport;
        const total = state.primarySlots.length;
        const defaultVisible = Math.min(200, total);
        vp.visibleSlotCount = defaultVisible;
        vp.firstSlotIndex = Math.max(0, total - defaultVisible);
      });
      _autoFitPriceScale(set, get);
    },

    // ────────────────────────────────────────────────────────────────────────
    // REPLAY ACTIONS
    // ────────────────────────────────────────────────────────────────────────

    startReplay: (fromSlotIndex) => {
      set(state => {
        const vp = state.viewport;
        state.replay.active = true;
        state.replay.playing = false;
        state.replay.index = fromSlotIndex;
        state.replay.startIndex = fromSlotIndex;
        // Keep ~70% of visible slots as history before the cursor
        const lookback = Math.floor(vp.visibleSlotCount * 0.7);
        vp.firstSlotIndex = Math.max(0, fromSlotIndex - lookback);
      });
      _autoFitPriceScale(set, get);
    },

    stopReplay: () => {
      set(state => {
        state.replay.active = false;
        state.replay.playing = false;
      });
      _autoFitPriceScale(set, get);
    },

    setReplayPlaying: (playing) => {
      set(state => { state.replay.playing = playing; });
    },

    stepReplay: (delta) => {
      set(state => {
        const total = state.primarySlots.length;
        const newIndex = Math.max(
          state.replay.startIndex,
          Math.min(total - 1, state.replay.index + delta),
        );
        state.replay.index = newIndex;
        const vp = state.viewport;
        const lookback = Math.floor(vp.visibleSlotCount * 0.7);
        vp.firstSlotIndex = Math.max(0, newIndex - lookback);
      });
      _autoFitPriceScale(set, get);
    },

    setReplaySpeed: (speed) => {
      set(state => { state.replay.speed = speed; });
    },

    tickReplay: () => {
      const { replay, primarySlots } = get();
      if (!replay.active || !replay.playing) return;
      if (replay.index >= primarySlots.length - 1) {
        set(state => { state.replay.playing = false; });
        return;
      }
      set(state => {
        const newIndex = state.replay.index + 1;
        state.replay.index = newIndex;
        const vp = state.viewport;
        const lookback = Math.floor(vp.visibleSlotCount * 0.7);
        vp.firstSlotIndex = Math.max(0, newIndex - lookback);
      });
      _autoFitPriceScale(set, get);
    },

    // ────────────────────────────────────────────────────────────────────────
    // INDICATOR ACTIONS
    // ────────────────────────────────────────────────────────────────────────

    addIndicator: (config) => {
      // Skip if an indicator with this id is already present
      if (get().indicatorConfigs.some(c => c.id === config.id)) return;
      set(state => {
        state.indicatorConfigs.push(config);
      });
      const series = computeIndicator(get().primarySlots, config);
      set(state => { state.indicatorSeries[config.id] = series; });
    },

    removeIndicator: (id) => {
      set(state => {
        state.indicatorConfigs = state.indicatorConfigs.filter(c => c.id !== id);
        delete state.indicatorSeries[id];
      });
    },

    toggleIndicator: (id) => {
      set(state => {
        const cfg = state.indicatorConfigs.find(c => c.id === id);
        if (cfg) cfg.visible = !cfg.visible;
      });
    },

    updateIndicatorConfig: (id, params) => {
      set(state => {
        const cfg = state.indicatorConfigs.find(c => c.id === id);
        if (cfg) cfg.params = { ...cfg.params, ...params };
      });
      // Recompute just this indicator
      const cfg = get().indicatorConfigs.find(c => c.id === id);
      if (cfg) {
        const series = computeIndicator(get().primarySlots, cfg);
        set(state => { state.indicatorSeries[id] = series; });
      }
    },

    recomputeAllIndicators: () => {
      const { primarySlots, indicatorConfigs } = get();
      const series: Record<string, IndicatorSeries> = {};
      for (const cfg of indicatorConfigs) {
        series[cfg.id] = computeIndicator(primarySlots, cfg);
      }
      set(state => { state.indicatorSeries = series; });
    },

    // ────────────────────────────────────────────────────────────────────────
    // OVERLAY ACTIONS
    // ────────────────────────────────────────────────────────────────────────

    addOverlay: (config, historicalCandles) => {
      // Skip if an overlay with this id is already present (guards against StrictMode double-invoke)
      if (get().overlayConfigs.some(c => c.id === config.id)) return;

      const styled = assignOverlayVisuals([
        ...get().overlayConfigs,
        config,
      ]).pop()!;

      const s = get();
      const resolvedHist = _resolveOverlayHistoricalCandles(s, styled, historicalCandles);

      const overlay = buildOffsetOverlay(
        s.primarySlots,
        styled,
        resolvedHist,
        s.session,
        s.timeframe,
      );

      set(state => {
        state.overlayConfigs.push(styled);
        state.overlays[styled.id] = overlay;
        state.historicalCandlesByOverlay[styled.id] = resolvedHist;
      });
    },

    removeOverlay: (id) => {
      set(state => {
        state.overlayConfigs = state.overlayConfigs.filter(c => c.id !== id);
        delete state.overlays[id];
        delete state.historicalCandlesByOverlay[id];
      });
    },

    toggleOverlay: (id) => {
      set(state => {
        const cfg = state.overlayConfigs.find(c => c.id === id);
        if (cfg) cfg.visible = !cfg.visible;
      });
    },

    toggleShowOverlays: () => {
      set(state => { state.showOverlays = !state.showOverlays; });
    },

    toggleOffsetConfluenceHighlight: () => {
      set(state => { state.offsetConfluenceHighlight = !state.offsetConfluenceHighlight; });
    },

    updateOverlayConfig: (id, patch) => {
      set(state => {
        const cfg = state.overlayConfigs.find(c => c.id === id);
        if (cfg) Object.assign(cfg, patch);
      });
      // Re-project
      const cfg = get().overlayConfigs.find(c => c.id === id);
      if (!cfg) return;
      const s = get();
      const resolvedHist = _resolveOverlayHistoricalCandles(s, cfg, s.historicalCandlesByOverlay[id] ?? []);
      const overlay = buildOffsetOverlay(s.primarySlots, cfg, resolvedHist, s.session, s.timeframe);
      set(state => {
        state.overlays[id] = overlay;
        state.historicalCandlesByOverlay[id] = resolvedHist;
      });
    },

    // ────────────────────────────────────────────────────────────────────────
    // DRAWING ACTIONS
    // ────────────────────────────────────────────────────────────────────────

    setDrawingTool: (tool) => {
      set(state => {
        state.activeDrawingTool = tool;
        state.drawingInProgress = null;
      });
    },

    startDrawing: (d) => {
      set(state => { state.drawingInProgress = d; });
    },

    updateDrawingInProgress: (d) => {
      set(state => { state.drawingInProgress = d; });
    },

    commitDrawing: () => {
      const { drawingInProgress, primarySlots, session } = get();
      if (!drawingInProgress) return;

      // For measurement drawings, compute the result and embed it before committing
      let finalDrawing: Drawing = drawingInProgress as Drawing;
      if (drawingInProgress.tool === 'measurement') {
        const d = drawingInProgress as import('../types').MeasurementDrawing;
        const result = measureRange(primarySlots, d.start.slotIndex, d.end.slotIndex, session.timezone);
        finalDrawing = { ...d, result };
        // Also update the persistent lastMeasurement so the status bar shows
        set(state => { state.lastMeasurement = result; });
      }

      set(state => {
        state.past.push([...state.drawings]);
        state.future = [];
        state.drawings.push(finalDrawing);
        state.drawingInProgress = null;
      });
    },

    cancelDrawing: () => {
      set(state => { state.drawingInProgress = null; });
    },

    updateDrawing: (id, patch) => {
      set(state => {
        const d = state.drawings.find(x => x.id === id);
        if (d) Object.assign(d, patch);
      });
    },

    deleteDrawing: (id) => {
      set(state => {
        state.past.push([...state.drawings]);
        state.future = [];
        state.drawings = state.drawings.filter(d => d.id !== id);
      });
    },

    undoDrawing: () => {
      const { past } = get();
      if (!past.length) return;
      set(state => {
        const prev = state.past.pop()!;
        state.future.push([...state.drawings]);
        state.drawings = prev;
      });
    },

    redoDrawing: () => {
      const { future } = get();
      if (!future.length) return;
      set(state => {
        const next = state.future.pop()!;
        state.past.push([...state.drawings]);
        state.drawings = next;
      });
    },

    // ────────────────────────────────────────────────────────────────────────
    // BACKTEST
    // ────────────────────────────────────────────────────────────────────────

    runBacktest: () => {
      const { primarySlots, backtestConfig, overlays } = get();
      set(s => { s.backtestRunning = true; });
      try {
        // For overlay-based strategies: resolve swing points from the selected overlay.
        let swingPoints: import('../types').SwingPoint[] | undefined;
        if (backtestConfig.strategyId === 'overlay_swing_hl' || backtestConfig.strategyId === 'overlay_swing_close') {
          const overlayId = backtestConfig.params.overlayId ?? '';
          const ov = overlays[overlayId];
          if (ov) {
            // Use pre-computed swing points (available when showSwingHL is on)
            // or compute fresh ones using the params leftRight value.
            if (ov.overlaySwingPoints?.length) {
              swingPoints = ov.overlaySwingPoints;
            } else {
              const lr = Math.max(1, Number(backtestConfig.params.swingHLLeftRight ?? 5));
              const sorted = [...ov.projectedCandles]
                .filter(pc => pc.projectedSlotIndex >= 0)
                .sort((a, b) => a.originalTimestamp - b.originalTimestamp);
              swingPoints = detectSwingPoints(
                sorted.map(pc => ({
                  slotIndex: pc.projectedSlotIndex,
                  timestamp: pc.projectedTimestamp,
                  high: pc.candle.high,
                  low: pc.candle.low,
                })),
                lr,
              );
            }
          }
        }

        const { stats, signals } = _runBacktest(primarySlots, backtestConfig, swingPoints ? { swingPoints } : undefined);
        set(s => {
          s.backtestResult = stats;
          s.backtestSignals = signals;
          s.backtestRunning = false;
          s.showBacktestReport = true;
          s.showBacktestSignals = true;
        });
      } catch (e) {
        set(s => { s.backtestRunning = false; });
        console.error('Backtest failed', e);
      }
    },

    updateBacktestConfig: (patch) => {
      set(s => {
        Object.assign(s.backtestConfig, patch);
        s.backtestResult = null;
        s.backtestSignals = [];
        s.showBacktestReport = false;
      });
    },

    clearBacktest: () => {
      set(s => {
        s.backtestResult = null;
        s.backtestSignals = [];
        s.showBacktestReport = false;
        s.showBacktestSignals = false;
      });
    },

    toggleBacktestSignals: () => {
      set(s => { s.showBacktestSignals = !s.showBacktestSignals; });
    },

    toggleBacktestReport: () => {
      set(s => { s.showBacktestReport = !s.showBacktestReport; });
    },

    // ────────────────────────────────────────────────────────────────────────
    // MEASUREMENT
    // ────────────────────────────────────────────────────────────────────────

    measureSelectedRange: (startSlotIndex, endSlotIndex) => {
      const { primarySlots, session } = get();
      const result = measureRange(primarySlots, startSlotIndex, endSlotIndex, session.timezone);
      set(state => { state.lastMeasurement = result; });
    },

    // ────────────────────────────────────────────────────────────────────────
    // TRADE JOURNAL
    // ────────────────────────────────────────────────────────────────────────

    loadTradeLog: (csvText) => {
      const entries = parseTradeLogCsv(csvText);
      const { primarySlots } = get();
      const roundTrips = matchRoundTrips(entries, primarySlots);
      set(state => {
        state.tradeLogEntries = entries;
        state.tradeLogRoundTrips = roundTrips;
        state.showTradeLog = true;
      });
    },

    clearTradeLog: () => {
      set(state => {
        state.tradeLogEntries = [];
        state.tradeLogRoundTrips = [];
      });
    },

    toggleTradeLog: () => {
      set(state => { state.showTradeLog = !state.showTradeLog; });
    },

    // ────────────────────────────────────────────────────────────────────────
    // EPHEMERIS MARKERS
    // ────────────────────────────────────────────────────────────────────────

    setEphemerisMarkers: (markers) => {
      // Resolve slot indices from timestamps using *fractional* slot positions.
      // Nearest-slot rounding causes every intraday event on the same day to
      // collapse onto a single daily bar (all Aug-17 aspects would stack on
      // the Aug-17 12:00 UTC slot). Interpolating between the two bracketing
      // slots gives each aspect its exact intraday X even on a coarse TF.
      const { primarySlots } = get();
      if (primarySlots.length === 0) { set(state => { state.ephemerisMarkers = markers; }); return; }

      const lastIdx = primarySlots.length - 1;
      const firstTs = primarySlots[0].timestamp;
      const lastTs = primarySlots[lastIdx].timestamp;
      const avgInterval = lastIdx > 0 ? (lastTs - firstTs) / lastIdx : 60000;

      const resolved = markers.map(m => {
        let slotIndex: number;
        if (m.timestamp <= firstTs) {
          // Before data start – project backward using the average interval.
          slotIndex = -(firstTs - m.timestamp) / avgInterval;
        } else if (m.timestamp >= lastTs) {
          // After data end – project forward using the average interval.
          slotIndex = lastIdx + (m.timestamp - lastTs) / avgInterval;
        } else {
          // Inside data range – binary-search the *previous* slot, then
          // interpolate between prev and next by timestamp fraction.
          let lo = 0, hi = lastIdx;
          while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if (primarySlots[mid].timestamp <= m.timestamp) lo = mid;
            else hi = mid - 1;
          }
          const prevIdx = lo;
          const prevTs  = primarySlots[prevIdx].timestamp;
          if (prevIdx === lastIdx) {
            slotIndex = prevIdx + (m.timestamp - prevTs) / avgInterval;
          } else {
            const nextTs = primarySlots[prevIdx + 1].timestamp;
            const span   = nextTs - prevTs;
            slotIndex = span > 0
              ? prevIdx + (m.timestamp - prevTs) / span
              : prevIdx;
          }
        }
        return { ...m, slotIndex };
      });
      set(state => { state.ephemerisMarkers = resolved; });
    },

    clearEphemerisMarkers: () => {
      set(state => { state.ephemerisMarkers = []; });
    },

    toggleEphemerisMarkers: () => {
      set(state => { state.showEphemerisMarkers = !state.showEphemerisMarkers; });
    },

    // CUSTOM TRANSIT ZONES
    // ────────────────────────────────────────────────────────────────────────

    addTransitZoneGroup: (group) => {
      const { primarySlots } = get();
      if (primarySlots.length === 0) return;

      // Compute average slot interval for extrapolation
      const lastIdx = primarySlots.length - 1;
      const firstTs = primarySlots[0].timestamp;
      const lastTs = primarySlots[lastIdx].timestamp;
      const avgInterval = lastIdx > 0 ? (lastTs - firstTs) / lastIdx : 60000;

      // Resolve slot index from timestamp, extrapolating beyond data range
      function resolveSlot(ts: number): number {
        // Before first slot: extrapolate backward
        if (ts <= firstTs) {
          const slotsBack = Math.round((firstTs - ts) / avgInterval);
          return -slotsBack;
        }
        // After last slot: extrapolate forward
        if (ts >= lastTs) {
          const slotsForward = Math.round((ts - lastTs) / avgInterval);
          return lastIdx + slotsForward;
        }
        // Within range: binary search
        let bestIdx = 0;
        let bestDiff = Infinity;
        let lo = 0, hi = lastIdx;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const diff = Math.abs(primarySlots[mid].timestamp - ts);
          if (diff < bestDiff) { bestDiff = diff; bestIdx = mid; }
          if (primarySlots[mid].timestamp < ts) lo = mid + 1;
          else hi = mid - 1;
        }
        return bestIdx;
      }

      const resolved: TransitZoneGroup = {
        ...group,
        id: `transit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        zones: group.zones.map(z => ({
          ...z,
          entrySlotIndex: resolveSlot(z.entryTimestamp),
          exitSlotIndex: resolveSlot(z.exitTimestamp),
        })),
      };
      set(state => { state.transitZoneGroups.push(resolved); });
    },

    removeTransitZoneGroup: (id) => {
      set(state => { state.transitZoneGroups = state.transitZoneGroups.filter(g => g.id !== id); });
    },

    toggleTransitZoneGroup: (id) => {
      set(state => {
        const g = state.transitZoneGroups.find(g => g.id === id);
        if (g) g.visible = !g.visible;
      });
    },

    clearAllTransitZones: () => {
      set(state => { state.transitZoneGroups = []; });
    },

    // ────────────────────────────────────────────────────────────────────────
    // CYCLE COMBINER
    // ────────────────────────────────────────────────────────────────────────

    setCycleCombinerConfig: (patch) => {
      set(state => { Object.assign(state.cycleCombinerConfig, patch); });
      get().recomputeCycleCombiner();
    },

    addCycleInput: (input) => {
      set(state => { state.cycleCombinerConfig.cycles.push(input); });
      get().recomputeCycleCombiner();
    },

    removeCycleInput: (index) => {
      set(state => { state.cycleCombinerConfig.cycles.splice(index, 1); });
      get().recomputeCycleCombiner();
    },

    updateCycleInput: (index, patch) => {
      set(state => { Object.assign(state.cycleCombinerConfig.cycles[index], patch); });
      get().recomputeCycleCombiner();
    },

    recomputeCycleCombiner: () => {
      const { cycleCombinerConfig, rawCandles, primarySlots } = get();
      const enabledCycles = cycleCombinerConfig.cycles.filter(c => c.enabled);
      if (enabledCycles.length === 0 || primarySlots.length === 0 || rawCandles.length === 0) {
        set(state => { state.cycleCombinerOutput = null; });
        return;
      }

      // Compute average slot interval for forward extrapolation
      const lastIdx = primarySlots.length - 1;
      const firstTs = primarySlots[0].timestamp;
      const lastTs = primarySlots[lastIdx].timestamp;
      const avgInterval = lastIdx > 0 ? (lastTs - firstTs) / lastIdx : 60000;

      // Project forward: use the shortest cycle offset to determine how far ahead we can project
      const minOffset = Math.min(...enabledCycles.map(c => c.offsetDays));
      const forwardSlots = Math.round((minOffset * 24 * 60 * 60 * 1000) / avgInterval);
      const totalSlots = primarySlots.length + forwardSlots;
      const combined: (number | null)[] = new Array(totalSlots).fill(null);

      // For each slot (including future), compute weighted sum of percent-change from each cycle offset
      for (let si = 0; si < totalSlots; si++) {
        // Extrapolate timestamp for future slots
        const slotTs = si < primarySlots.length
          ? primarySlots[si].timestamp
          : lastTs + (si - lastIdx) * avgInterval;

        let weightedSum = 0;
        let totalWeight = 0;

        for (const cycle of enabledCycles) {
          // Find the candle that is `offsetDays` calendar days ago
          const offsetMs = cycle.offsetDays * 24 * 60 * 60 * 1000;
          const pastTs = slotTs - offsetMs;

          // Find closest raw candle to pastTs via binary search
          let bestIdx = -1;
          let bestDiff = Infinity;
          let lo = 0, hi = rawCandles.length - 1;
          while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            const diff = Math.abs(rawCandles[mid].timestamp - pastTs);
            if (diff < bestDiff) { bestDiff = diff; bestIdx = mid; }
            if (rawCandles[mid].timestamp < pastTs) lo = mid + 1;
            else hi = mid - 1;
          }

          if (bestIdx < 0) continue;
          // Skip if the match is too far from target (more than 2 intervals away)
          if (bestDiff > avgInterval * 2) continue;

          // Compute percent change of that past candle relative to its previous
          const prevIdx = bestIdx - 1;
          if (prevIdx < 0) continue;
          const prevClose = rawCandles[prevIdx].close;
          const currClose = rawCandles[bestIdx].close;
          if (prevClose === 0) continue;
          const pctChange = ((currClose - prevClose) / prevClose) * 100;

          weightedSum += pctChange * cycle.weight;
          totalWeight += Math.abs(cycle.weight);
        }

        if (totalWeight > 0) {
          combined[si] = weightedSum / totalWeight;
        }
      }

      // Apply EMA smoothing
      const smoothed = _emaSmoothArray(combined, cycleCombinerConfig.smoothing);

      // Compute min/max
      let min = Infinity, max = -Infinity;
      for (const v of smoothed) {
        if (v !== null) {
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!isFinite(min)) { min = -1; max = 1; }

      set(state => { state.cycleCombinerOutput = { values: smoothed, min, max }; });
    },

    // ────────────────────────────────────────────────────────────────────────
    // CROSSHAIR
    // ────────────────────────────────────────────────────────────────────────

    setCrosshair: (patch) => {
      set(state => { Object.assign(state.crosshair, patch); });
    },

    // ────────────────────────────────────────────────────────────────────────
    // UI
    // ────────────────────────────────────────────────────────────────────────

    setTheme: (t) => {
      set(state => {
        state.theme = t;
        state.themeTokens = t === 'dark' ? darkTheme : lightTheme;
      });
    },

    toggleIndicatorsAndDrawingsVisibility: () => {
      set(state => {
        state.showIndicatorsAndDrawings = !state.showIndicatorsAndDrawings;
      });
    },

    toggleEmptyGapSlots: () => {
      const next: 'session_trading_days' | 'session_calendar_days' =
        get().gapVisibility === 'session_trading_days'
          ? 'session_calendar_days'
          : 'session_trading_days';
      set(state => {
        state.gapVisibility = next;
        state.showEmptyGapSlots = next === 'session_calendar_days';
      });
      const s = get();
      if (s.baseCandles.length > 0) get().setTimeframe(s.timeframe);
    },

    setGapVisibility: (mode) => {
      set(state => {
        state.gapVisibility = mode;
        state.showEmptyGapSlots = mode === 'session_calendar_days';
      });
      const s = get();
      if (s.baseCandles.length > 0) get().setTimeframe(s.timeframe);
    },

    // ────────────────────────────────────────────────────────────────────────
    // LAYOUT PERSISTENCE
    // ────────────────────────────────────────────────────────────────────────

    exportLayout: () => {
      const s = get();
      return {
        id: randomId(),
        name: 'Untitled Layout',
        timeframe: s.timeframe,
        series: s.currentSeries ? { ...s.currentSeries } : undefined,
        drawings: s.drawings,
        indicators: s.indicatorConfigs,
        overlays: s.overlayConfigs,
        viewport: { firstSlotIndex: s.viewport.firstSlotIndex, visibleSlotCount: s.viewport.visibleSlotCount },
        priceScale: s.priceScale,
        theme: s.theme,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },

    importLayout: (layout) => {
      set(state => {
        state.timeframe = layout.timeframe;
        state.drawings = layout.drawings;
        state.indicatorConfigs = layout.indicators;
        state.overlayConfigs = layout.overlays;
        state.viewport.firstSlotIndex = layout.viewport.firstSlotIndex;
        state.viewport.visibleSlotCount = layout.viewport.visibleSlotCount;
        Object.assign(state.priceScale, layout.priceScale);
        state.theme = layout.theme;
        state.themeTokens = layout.theme === 'dark' ? darkTheme : lightTheme;
        if (layout.series) state.currentSeries = {
          market: layout.series.market,
          symbol: layout.series.symbol,
          timeframe: layout.series.timeframe,
        };
      });
    },
  })),
  );
} // end createChartStore

// ─────────────────────────────────────────────────────────────────────────────
// Primary (legacy) store – used by usePersistence and as the p1 panel default
// ─────────────────────────────────────────────────────────────────────────────

export const primaryChartStore: StoreApi<ChartState & ChartActions> = createChartStore('p1');

// ─────────────────────────────────────────────────────────────────────────────
// React context – each ChartPanel provides its own store instance here.
// Components call useChartStore() which reads from the nearest provider,
// falling back to primaryChartStore when no provider is present.
// ─────────────────────────────────────────────────────────────────────────────

export const ChartStoreContext = createContext<StoreApi<ChartState & ChartActions> | null>(null);

/** Context-aware hook – replaces the old module-level singleton hook. */
export function useChartStore(): ChartState & ChartActions {
  const ctx = useContext(ChartStoreContext);
  return useStore(ctx ?? primaryChartStore);
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helper: auto-fit price scale to visible candles
// ─────────────────────────────────────────────────────────────────────────────

function _autoFitPriceScale(set: any, get: () => ChartState & ChartActions) {
  const { primarySlots, viewport, priceScale, overlays, overlayConfigs, replay, showOverlays } = get();
  if (!priceScale.autoFit) return;

  const start = viewport.firstSlotIndex;
  const replayEnd = replay?.active ? replay.index : primarySlots.length - 1;
  const end = Math.min(replayEnd, start + viewport.visibleSlotCount - 1);
  const visible = primarySlots.slice(start, end + 1);

  let min = Infinity, max = -Infinity;
  for (const s of visible) {
    if (!s.candle) continue;
    if (s.candle.low < min) min = s.candle.low;
    if (s.candle.high > max) max = s.candle.high;
  }

  // Include visible overlay candles in the scale only if they're in a similar price range.
  // Overlays with large offsets (where price differs significantly) are rendered with
  // scale-to-fit in the renderer, so including their raw prices would blow out the axis.
  const primaryMin = min;
  const primaryMax = max;
  const primaryRange = primaryMax - primaryMin;
  for (const cfg of overlayConfigs) {
    if (!showOverlays || !cfg.visible || cfg.mode === 'percent' || cfg.mode === 'index100') continue;
    const ov = overlays[cfg.id];
    if (!ov) continue;
    // Check if the overlay is in a similar price range to the primary
    let ovMin = Infinity, ovMax = -Infinity;
    for (const pc of ov.projectedCandles) {
      if (pc.projectedSlotIndex < start || pc.projectedSlotIndex > end) continue;
      const c = pc.candle;
      if (c.low < ovMin) ovMin = c.low;
      if (c.high > ovMax) ovMax = c.high;
    }
    if (!isFinite(ovMin) || !isFinite(ovMax)) continue;
    // Only include if the overlay overlaps with primary range (within 20% drift)
    const overlapLow = Math.max(primaryMin, ovMin);
    const overlapHigh = Math.min(primaryMax, ovMax);
    const noOverlap = overlapLow >= overlapHigh;
    const rangeDiffRatio = primaryRange > 0 ? Math.abs((ovMax - ovMin) - primaryRange) / primaryRange : 0;
    if (noOverlap || rangeDiffRatio > 0.2) continue; // skip – renderer will rescale
    if (ovMin < min) min = ovMin;
    if (ovMax > max) max = ovMax;
  }

  if (!isFinite(min) || !isFinite(max)) return;
  const padding = (max - min) * 0.05;
  set((state: ChartState) => {
    state.priceScale.min = min - padding;
    state.priceScale.max = max + padding;
  });
}
