// ─────────────────────────────────────────────────────────────────────────────
// Raw market data – exactly as it arrives from a provider
// ─────────────────────────────────────────────────────────────────────────────

export type Timeframe = '1m' | '5m' | '10m' | '15m' | '1h' | '4h' | '1d' | '1w' | '1M';

export interface RawCandle {
  timestamp: number; // Unix ms UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  // optional metadata
  symbol?: string;
  exchange?: string;
  adjusted?: boolean;
  corporateAction?: 'split' | 'dividend' | null;
  session?: 'regular' | 'pre' | 'post' | 'holiday';
  timezone?: string; // IANA tz, e.g. "America/New_York"
}

// ─────────────────────────────────────────────────────────────────────────────
// Calendar / session config
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionConfig {
  timezone: string; // IANA, default "America/New_York"
  regularOpen: string; // "09:30"
  regularClose: string; // "16:00"
  // ISO weekday numbers that are trading days, 1=Mon..7=Sun
  tradingDays: number[]; // default [1,2,3,4,5]
  holidays: string[]; // ISO date strings "YYYY-MM-DD"
  halfDays: Record<string, { close: string }>; // "YYYY-MM-DD" -> early close time
}

export const DEFAULT_SESSION: SessionConfig = {
  timezone: 'America/New_York',
  regularOpen: '09:30',
  regularClose: '16:00',
  tradingDays: [1, 2, 3, 4, 5],
  holidays: [],
  halfDays: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Normalized calendar-aligned slot – the internal representation used by the
// renderer.  A slot always exists even if the market was closed.
// ─────────────────────────────────────────────────────────────────────────────

export type SlotStatus = 'trading' | 'weekend' | 'holiday' | 'halfday' | 'gap' | 'outside_session';

export interface CandleSlot {
  // Index into the master slot array (0-based, monotonically increasing)
  slotIndex: number;
  // Canonical UTC timestamp for this slot's open time
  timestamp: number; // ms UTC
  status: SlotStatus;
  // Present only when status === 'trading' and data was received
  candle: RawCandle | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Indicator series
// ─────────────────────────────────────────────────────────────────────────────

export type IndicatorType = 'SMA' | 'EMA' | 'VWAP' | 'VOLUME' | 'RSI' | 'MACD' | 'BBANDS' | 'ATR' | 'SWING_HL' | 'SUPPORT_RESISTANCE' | 'SESSIONS' | 'MOON_SIGNALS' | 'DYNAMIC_GRID' | 'WICK_REVERSAL' | 'TRADE_SIGNALS' | 'HIGH_LOW_LEVELS';

export interface IndicatorConfig {
  id: string; // unique, e.g. "sma-20"
  type: IndicatorType;
  params: Record<string, number | string | boolean>; // { period: 20, source: 'close' }
  color: string;
  lineWidth: number;
  visible: boolean;
  pane: 'main' | 'sub'; // sub = separate panel below main chart
}

export interface IndicatorPoint {
  slotIndex: number;
  timestamp: number;
  value: number | null; // null == not yet calculable (e.g. warmup period)
  // MACD / BBANDS emit multiple values keyed by label
  values?: Record<string, number | null>;
}

/** A single confirmed swing pivot (used by SWING_HL indicator) */
export interface SwingPoint {
  /** Index into the master slot array */
  slotIndex: number;
  /** UTC timestamp of the pivot bar */
  timestamp: number;
  /** Pivot price (high value for 'high', low value for 'low') */
  price: number;
  /** Whether this pivot is a swing high or swing low */
  type: 'high' | 'low';
}

/** A support/resistance zone detected by clustering pivots */
export interface SRZone {
  /** Top of the zone */
  top: number;
  /** Bottom of the zone */
  bottom: number;
  /** Number of pivot touches that confirmed this zone */
  touches: number;
  /** Bar index where the zone starts (leftmost confirming pivot) */
  leftBarSlotIndex: number;
  /** Current state: 1 = price above (support), -1 = price below (resistance), 0 = inside */
  side: 1 | -1 | 0;
}

/** A session range box (used by SESSIONS indicator) */
export interface SessionZone {
  /** Session name (e.g. "New York") */
  name: string;
  /** Session color */
  color: string;
  /** First slot index in this session instance */
  startSlotIndex: number;
  /** Last slot index in this session instance */
  endSlotIndex: number;
  /** Session high */
  high: number;
  /** Session low */
  low: number;
}

/** A weekend/day divider marker (used by SESSIONS indicator) */
export interface WeekendMarker {
  /** Slot index where the weekend day starts */
  slotIndex: number;
  /** Day label: "Saturday" or "Sunday" */
  label: string;
}

/** A buy/sell signal marker (used by MOON_SIGNALS, WICK_REVERSAL indicators) */
export interface SignalMarker {
  slotIndex: number;
  timestamp: number;
  price: number;
  type: 'buy' | 'sell';
  /** Optional label override (e.g. 'P' for pinbar, 'W' for wick) */
  label?: string;
}

/** A trade entry/exit marker pair (used by TRADE_SIGNALS indicator) */
export interface TradeMarker {
  entrySlotIndex: number;
  exitSlotIndex: number;
  entryPrice: number;
  exitPrice: number;
  direction: 'long' | 'short';
  pnlPct: number;
  /** Whether this trade was a winner */
  win: boolean;
}

/** A high/low level line for a time period (daily, weekly, monthly, session) */
export interface HighLowLevel {
  /** Start slot index of the period this level belongs to */
  startSlotIndex: number;
  /** End slot index of the period */
  endSlotIndex: number;
  /** Price of the high or low */
  price: number;
  /** Whether this is a high or low */
  type: 'high' | 'low';
  /** Period type */
  period: 'daily' | 'weekly' | 'monthly' | 'session';
  /** Color for this level line */
  color: string;
  /** Optional label */
  label?: string;
}

/** Dynamic grid & diagonals data (used by DYNAMIC_GRID indicator) */
export interface GridDiagonalData {
  /** Timestamp of first vertical line */
  date1: number;
  /** Timestamp of second vertical line */
  date2: number;
  /** Interval between horizontal lines (price units) */
  interval: number;
  /** Number of horizontal lines above/below current price */
  numLines: number;
}

export interface IndicatorSeries {
  config: IndicatorConfig;
  points: IndicatorPoint[];
  /** Confirmed swing pivots – populated only for the SWING_HL indicator */
  swingPoints?: SwingPoint[];
  /** Support/resistance zones – populated only for SUPPORT_RESISTANCE */
  srZones?: SRZone[];
  /** Session range boxes – populated only for SESSIONS */
  sessionZones?: SessionZone[];
  /** Weekend day dividers – populated only for SESSIONS */
  weekendMarkers?: WeekendMarker[];
  /** Buy/sell signal markers – populated only for MOON_SIGNALS */
  signalMarkers?: SignalMarker[];
  /** Dynamic grid & diagonals – populated only for DYNAMIC_GRID */
  gridData?: GridDiagonalData;
  /** Trade entry/exit markers – populated only for TRADE_SIGNALS */
  tradeMarkers?: TradeMarker[];
  /** High/Low level lines – populated only for HIGH_LOW_LEVELS */
  highLowLevels?: HighLowLevel[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Historical offset / comparison overlay
// ─────────────────────────────────────────────────────────────────────────────

export type OverlayMode = 'overlay' | 'stacked' | 'normalized' | 'percent' | 'index100';

export interface OffsetOverlayConfig {
  id: string;
  label: string; // "20-day offset"
  sourceStartTimestamp: number; // UTC ms – start of historical window
  sourceEndTimestamp: number; // UTC ms – end of historical window
  calendarDayOffset: number; // how many calendar days to shift forward
  mode: OverlayMode;
  anchorType: 'date' | 'session_start' | 'first_visible' | 'custom';
  anchorTimestamp?: number; // used when anchorType === 'custom'
  color: string;
  opacity: number; // 0–1
  lineOnly: boolean; // render as line instead of candles
  dashed: boolean;
  visible: boolean;
  zIndex: number;
  /** Show Swing High-Low zigzag on this overlay */
  showSwingHL: boolean;
  /** Look-ahead / look-behind bars for pivot detection (default 5) */
  swingHLLeftRight: number;
  /** When showSwingHL is on: show % move labels between consecutive swing points */
  showSwingPct?: boolean;
  /** When true, also render a vertically-mirrored clone anchored near current price */
  mirror?: boolean;
}

/**
 * A projected candle – holds the original data but with a new timestamp
 * that places it on the current chart timeline.
 */
export interface ProjectedCandle {
  originalTimestamp: number;
  projectedTimestamp: number;
  projectedSlotIndex: number;
  candle: RawCandle;
  /** Percent-change from anchor candle close (used in percent/index modes) */
  normalizedValue?: number;
}

export interface OffsetOverlay {
  config: OffsetOverlayConfig;
  projectedCandles: ProjectedCandle[];
  indicators: IndicatorSeries[]; // indicators computed on the overlay series
  /** Swing points computed from projected candles when config.showSwingHL is true */
  overlaySwingPoints?: SwingPoint[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawing objects
// ─────────────────────────────────────────────────────────────────────────────

export type DrawingTool =
  | 'trendline'
  | 'horizontal'
  | 'vertical'
  | 'rectangle'
  | 'measurement'
  | 'fibonacci'
  | 'long_position'
  | 'short_position'
  | 'bar_pattern'
  | 'replay'
  | 'none';

export interface DrawingPoint {
  timestamp: number; // snapped to slot timestamp
  price: number;
  slotIndex: number;
}

export interface BaseDrawing {
  id: string;
  tool: DrawingTool;
  color: string;
  lineWidth: number;
  visible: boolean;
  locked: boolean;
  zIndex: number;
}

export interface TrendlineDrawing extends BaseDrawing {
  tool: 'trendline';
  start: DrawingPoint;
  end: DrawingPoint;
  extendLeft: boolean;
  extendRight: boolean;
}

export interface HorizontalLineDrawing extends BaseDrawing {
  tool: 'horizontal';
  price: number;
  label?: string;
}

export interface VerticalLineDrawing extends BaseDrawing {
  tool: 'vertical';
  timestamp: number;
  slotIndex: number;
  label?: string;
}

export interface RectangleDrawing extends BaseDrawing {
  tool: 'rectangle';
  topLeft: DrawingPoint;
  bottomRight: DrawingPoint;
  fillOpacity: number;
}

export interface MeasurementDrawing extends BaseDrawing {
  tool: 'measurement';
  start: DrawingPoint;
  end: DrawingPoint;
  result?: RangeMeasurementResult; // computed on draw complete
}

export interface FibonacciDrawing extends BaseDrawing {
  tool: 'fibonacci';
  start: DrawingPoint;
  end: DrawingPoint;
  /** Retracement levels to display (defaults: 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1) */
  levels: number[];
  /** Whether to extend lines to the right edge of the chart */
  extendRight: boolean;
}

export const FIBONACCI_DEFAULT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export interface PositionDrawing extends BaseDrawing {
  tool: 'long_position' | 'short_position';
  entry: DrawingPoint;
  end: DrawingPoint;       // TP side (drag endpoint)
  /** Take-profit price (computed from entry + drag direction) */
  tpPrice: number;
  /** Stop-loss price (computed from entry, opposite side) */
  slPrice: number;
  /** Risk/Reward ratio */
  riskReward: number;
}

export type Drawing =
  | TrendlineDrawing
  | HorizontalLineDrawing
  | VerticalLineDrawing
  | RectangleDrawing
  | MeasurementDrawing
  | FibonacciDrawing
  | PositionDrawing;

// ─────────────────────────────────────────────────────────────────────────────
// Range measurement result
// ─────────────────────────────────────────────────────────────────────────────

export interface RangeMeasurementResult {
  startTimestamp: number;
  endTimestamp: number;
  startPrice: number;
  endPrice: number;
  calendarDays: number;
  tradingBars: number;
  absoluteMove: number;
  percentMove: number;
  high: number;
  low: number;
  priceRange: number;
  volumeSum: number | null;
  elapsedMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Viewport / chart state
// ─────────────────────────────────────────────────────────────────────────────

export interface Viewport {
  /** First slot index visible on screen */
  firstSlotIndex: number;
  /** Total number of visible slots (determines zoom) */
  visibleSlotCount: number;
  /** Canvas logical width in pixels */
  width: number;
  /** Main chart pane height (px) */
  mainPaneHeight: number;
  /** Sub-pane height (volume / RSI / etc.) (px) */
  subPaneHeight: number;
  /** Right-axis width (px) */
  priceAxisWidth: number;
  /** Bottom axis height (px) */
  timeAxisHeight: number;
}

export interface PriceScale {
  min: number;
  max: number;
  /** If true, auto-fit Y to visible candles */
  autoFit: boolean;
  /** Separate price scale for overlay series */
  overlayScale?: { min: number; max: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Crosshair
// ─────────────────────────────────────────────────────────────────────────────

export interface CrosshairState {
  visible: boolean;
  slotIndex: number;
  /** Resolved UTC timestamp for the hovered slot (extrapolated for virtual future slots). */
  timestamp: number;
  price: number;
  x: number; // canvas px
  y: number; // canvas px
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart series (the master primary series + each overlay)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChartSeries {
  id: string; // 'primary' | overlay config id
  label: string;
  slots: CandleSlot[];
  timeframe: Timeframe;
  sessionConfig: SessionConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker message contracts
// ─────────────────────────────────────────────────────────────────────────────

export type WorkerRequest =
  | { type: 'GENERATE_SLOTS'; payload: GenerateSlotsPayload }
  | { type: 'NORMALIZE'; payload: NormalizePayload }
  | { type: 'COMPUTE_INDICATOR'; payload: ComputeIndicatorPayload }
  | { type: 'PROJECT_OVERLAY'; payload: ProjectOverlayPayload }
  | { type: 'MEASURE_RANGE'; payload: MeasureRangePayload };

export type WorkerResponse =
  | { type: 'SLOTS_READY'; id: string; slots: CandleSlot[] }
  | { type: 'NORMALIZED_READY'; id: string; slots: CandleSlot[] }
  | { type: 'INDICATOR_READY'; id: string; series: IndicatorSeries }
  | { type: 'OVERLAY_READY'; id: string; overlay: OffsetOverlay }
  | { type: 'MEASURE_RESULT'; id: string; result: RangeMeasurementResult }
  | { type: 'ERROR'; id: string; message: string };

export interface GenerateSlotsPayload {
  id: string;
  startMs: number;
  endMs: number;
  timeframe: Timeframe;
  session: SessionConfig;
}

export interface NormalizePayload {
  id: string;
  slots: CandleSlot[];
  raw: RawCandle[];
}

export interface ComputeIndicatorPayload {
  id: string;
  slots: CandleSlot[];
  config: IndicatorConfig;
}

export interface ProjectOverlayPayload {
  id: string;
  primarySlots: CandleSlot[];
  overlayConfig: OffsetOverlayConfig;
  historicalCandles: RawCandle[];
  session: SessionConfig;
  timeframe: Timeframe;
}

export interface MeasureRangePayload {
  id: string;
  slots: CandleSlot[];
  startSlotIndex: number;
  endSlotIndex: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persisted layout / preferences
// ─────────────────────────────────────────────────────────────────────────────

export interface ChartLayout {
  id: string;
  name: string;
  timeframe: Timeframe;
  drawings: Drawing[];
  indicators: IndicatorConfig[];
  overlays: OffsetOverlayConfig[];
  viewport: Pick<Viewport, 'firstSlotIndex' | 'visibleSlotCount'>;
  priceScale: PriceScale;
  theme: 'dark' | 'light';
  createdAt: number;
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme tokens (used by renderer directly – no CSS variables in canvas)
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemeTokens {
  background: string;
  gridLine: string;
  gridLineMajor: string;
  axisText: string;
  axisBorder: string;
  crosshair: string;
  bullCandle: string;
  bearCandle: string;
  bullWick: string;
  bearWick: string;
  volume: string;
  sessionShade: string;
  missingSlot: string;
}

export const DARK_THEME: ThemeTokens = {
  background: '#131722',
  gridLine: '#2a2e39',
  gridLineMajor: '#3c4151',
  axisText: '#9598a1',
  axisBorder: '#2a2e39',
  crosshair: '#758696',
  bullCandle: '#26a69a',
  bearCandle: '#ef5350',
  bullWick: '#26a69a',
  bearWick: '#ef5350',
  volume: '#5d606b',
  sessionShade: 'rgba(255,255,255,0.02)',
  missingSlot: 'rgba(255,255,255,0.03)',
};

export const LIGHT_THEME: ThemeTokens = {
  background: '#ffffff',
  gridLine: '#e1e3ea',
  gridLineMajor: '#c8cad5',
  axisText: '#6a6d78',
  axisBorder: '#c8cad5',
  crosshair: '#9598a1',
  bullCandle: '#26a69a',
  bearCandle: '#ef5350',
  bullWick: '#26a69a',
  bearWick: '#ef5350',
  volume: '#b2b5be',
  sessionShade: 'rgba(0,0,0,0.02)',
  missingSlot: 'rgba(0,0,0,0.02)',
};

// ─────────────────────────────────────────────────────────────────────────────
// Backtesting
// ─────────────────────────────────────────────────────────────────────────────

/** All built-in strategy identifiers */
export type BacktestStrategyId =
  | 'ema_crossover'
  | 'sma_crossover'
  | 'ema_price_cross'
  | 'rsi_ob_os'
  | 'macd_signal_cross'
  | 'overlay_swing_hl'
  | 'overlay_swing_close'
  | 'ny_10am_breakout';

/** Per-strategy tunable parameters */
export interface BacktestStrategyParams {
  // EMA / SMA crossover
  fastPeriod?: number;
  slowPeriod?: number;
  // EMA/SMA price-cross
  period?: number;
  // Overlay Swing HL
  overlayId?: string;       // ID of OffsetOverlay to use
  swingHLLeftRight?: number;   // pivot look-ahead/behind bars
  requireCloseConfirm?: boolean; // entry only after close above/below pivot level
  swingStopLoss?: boolean;        // stop when candle closes back beyond pivot level
  // RSI overbought/oversold
  rsiPeriod?: number;
  overbought?: number;
  oversold?: number;
  // MACD
  fastEma?: number;
  slowEma?: number;
  signalPeriod?: number;
  // NY 10am Breakout
  /** 'breakout' = trade break of 10am candle H/L; 'color' = green→long, red→short */
  ny10amMode?: 'breakout' | 'color';
  /** Take profit % for NY session exit (0 = hold until session end) */
  ny10amTpPct?: number;
  /** NY session end hour in UTC (default 20 = 4pm ET during EDT) */
  nySessionEndHourUTC?: number;
  /** Entry candle hour in UTC (default 14 = 10am ET during EDT) */
  nyEntryHourUTC?: number;
  /** Close-back stop: exit if price closes back through entry candle open */
  ny10amCloseBack?: boolean;
}

/** Risk management — applies to all strategies */
export interface BacktestRiskParams {
  /** Close trade when price moves this % in favour of the position. 0 = disabled. */
  takeProfitPct: number;
  /** Close trade when price moves this % against the position. 0 = disabled. */
  stopLossPct: number;
}

/** Position direction */
export type TradeDirection = 'long' | 'short';

/** What caused a trade to close */
export type TradeExitReason = 'signal' | 'take_profit' | 'stop_loss' | 'end_of_data';

/** A completed round-trip trade */
export interface BacktestTrade {
  id: string;
  direction: TradeDirection;
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  entrySlotIndex: number;
  exitSlotIndex: number;
  bars: number;
  /** Gross P&L as % of entry price */
  pnlPct: number;
  /** Gross P&L in price points */
  pnlPoints: number;
  /** Cumulative equity at close of this trade (starts from 100) */
  equityAfter: number;
  signal: 'buy' | 'sell';
  /** Why the trade was closed */
  exitReason: TradeExitReason;
}

/** A single buy or sell signal that should appear on the chart */
export interface BacktestSignal {
  slotIndex: number;
  timestamp: number;
  type: 'buy' | 'sell';
  price: number;
  strategyId: BacktestStrategyId;
}

/** Aggregate performance statistics – mirrors TradingView's Strategy Tester */
export interface BacktestStats {
  // ── Overview ──────────────────────────────────────────────────────────────
  netProfitPct: number;
  netProfitPoints: number;
  grossProfitPct: number;
  grossLossPct: number;
  /** Buy-and-hold return % over the same period */
  buyHoldReturnPct: number;
  /** Max equity drawdown % from peak */
  maxDrawdownPct: number;
  /** Longest drawdown streak in bars */
  maxDrawdownBars: number;

  // ── Trade summary ─────────────────────────────────────────────────────────
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  /** Average profit on winning trades % */
  avgWinPct: number;
  /** Average loss on losing trades % (positive = magnitude) */
  avgLossPct: number;
  /** Ratio of avgWin to avgLoss */
  profitFactor: number;
  /** Expectancy per trade % */
  expectancyPct: number;

  // ── Risk / reward ─────────────────────────────────────────────────────────
  /** Sharpe ratio (annualised, risk-free = 0) */
  sharpeRatio: number;
  /** Sortino ratio */
  sortinoRatio: number;
  /** CAGR approximation */
  cagrPct: number | null;

  // ── Trade duration ────────────────────────────────────────────────────────
  avgBarsInTrade: number;
  maxBarsInTrade: number;
  minBarsInTrade: number;

  // ── Exit reason breakdown ─────────────────────────────────────────────────
  tpExits: number;
  slExits: number;
  signalExits: number;
  eodExits: number;

  // ── Per-trade log ─────────────────────────────────────────────────────────
  trades: BacktestTrade[];

  // ── Equity curve (equity value after each trade, starts at 100) ───────────
  equityCurve: { timestamp: number; equity: number }[];
}

/** Which trade directions the strategy is allowed to take */
export type TradeDirectionMode = 'both' | 'long_only' | 'short_only';

/** Full backtest run configuration */
export interface BacktestConfig {
  strategyId: BacktestStrategyId;
  params: BacktestStrategyParams;
  /** Which directions are allowed: both (default), long_only, short_only */
  tradeDirection: TradeDirectionMode;
  /** @deprecated use tradeDirection instead. Kept for backward compat. */
  allowShorts: boolean;
  /** Initial equity (used for display only; all stats normalised to 100) */
  initialEquity: number;
  /** Commission per trade as % of trade value */
  commissionPct: number;
  /** Take-profit % from entry price. 0 = disabled. */
  takeProfitPct: number;
  /** Stop-loss % from entry price. 0 = disabled. */
  stopLossPct: number;
  /**
   * Minimum bars a position must be open before the stop-loss activates.
   * 0 = SL active immediately (default behaviour).
   * e.g. 6 on a 5m chart = price-based SL is ignored for the first 30 min.
   */
  slDelayBars: number;
  /**
   * When true, strategy-signal exits are suppressed while TP or SL is set.
   * The trade will only close when TP/SL price is hit or data ends.
   * This prevents the strategy from closing a trade before the TP target
   * is reached (e.g. EMA cross-back on the very next bar).
   */
  holdForTpSl: boolean;
}

/** State for the backtest slice of the store */
export interface BacktestState {
  backtestConfig: BacktestConfig;
  backtestResult: BacktestStats | null;
  backtestSignals: BacktestSignal[];
  backtestRunning: boolean;
  showBacktestSignals: boolean;
  showBacktestReport: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade Journal – imported trade logs plotted on chart
// ─────────────────────────────────────────────────────────────────────────────

export type TradeLogDirection = 'long' | 'short';
export type TradeLogAction = 'open' | 'close';

export interface TradeLogEntry {
  id: string;
  timestamp: number;        // UTC ms
  direction: TradeLogDirection;
  action: TradeLogAction;   // open or close
  price: number;
  quantity: number;
  fees: number;
  orderType: string;        // Limit, Market, etc.
  transactionId: string;
  /** Raw "Filled Type" — Trade or Funding (Funding entries are informational) */
  filledType: string;
}

/** A matched round-trip trade from the journal */
export interface TradeLogRoundTrip {
  id: string;
  direction: TradeLogDirection;
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  entrySlotIndex: number;
  exitSlotIndex: number;
  quantity: number;
  pnlPct: number;
  pnlUsd: number;
  totalFees: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ephemeris / Planetary Date Markers
// ─────────────────────────────────────────────────────────────────────────────

export interface EphemerisMarker {
  /** UTC ms timestamp of the event */
  timestamp: number;
  /** Slot index on the primary chart (resolved after loading) */
  slotIndex: number;
  /** Display label, e.g. "Sun ☌ Moon" or "Rahu Rising" */
  label: string;
  /** Optional color for the marker line */
  color: string;
  /** Extra info */
  meta?: Record<string, number | string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom Transit Zones (date-range markers from planetary transits)
// ─────────────────────────────────────────────────────────────────────────────

/** A single transit date range */
export interface TransitZone {
  /** Entry timestamp (UTC ms) */
  entryTimestamp: number;
  /** Exit timestamp (UTC ms) */
  exitTimestamp: number;
  /** Resolved entry slot index */
  entrySlotIndex: number;
  /** Resolved exit slot index */
  exitSlotIndex: number;
}

/** A group of transit zones with a shared label/color/visibility */
export interface TransitZoneGroup {
  /** Unique ID */
  id: string;
  /** Display label e.g. "94% UP Venus Helio 02°46' Sc -> 18°56' Sag" */
  label: string;
  /** Direction hint */
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  /** Probability text e.g. "94%" */
  probability: string;
  /** Color for the shaded zone */
  color: string;
  /** Whether this group is currently visible */
  visible: boolean;
  /** The individual transit date ranges */
  zones: TransitZone[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycle Combiner (weighted sum of multiple offset day cycles)
// ─────────────────────────────────────────────────────────────────────────────

/** A single cycle input to the combiner */
export interface CycleInput {
  /** Offset in calendar days (e.g. 273, 121, 7) */
  offsetDays: number;
  /** Weight multiplier (default 1.0) */
  weight: number;
  /** Whether this cycle is enabled */
  enabled: boolean;
}

/** Configuration for the cycle combiner */
export interface CycleCombinerConfig {
  /** Individual cycles to combine */
  cycles: CycleInput[];
  /** Smoothing period (number of slots for EMA smoothing, 0 = no smoothing) */
  smoothing: number;
  /** Whether the combiner is visible */
  visible: boolean;
  /** Line color */
  color: string;
}

/** Computed output of the cycle combiner per slot index */
export interface CycleCombinerOutput {
  /** Combined value per slot (index-aligned with primarySlots, can extend beyond) */
  values: (number | null)[];
  /** Min value in the array (for scaling) */
  min: number;
  /** Max value in the array (for scaling) */
  max: number;
}
