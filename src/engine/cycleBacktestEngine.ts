/**
 * Offset-cycle backtest engine.
 *
 * Trades the projected swing highs/lows of an offset overlay (historical price
 * shifted forward N calendar days) against the real bars of the chart:
 *   projected swing LOW  → go long,  projected swing HIGH → go short.
 *
 * Validation follows the usual institutional checklist:
 *   • fills at bar open (never at the close of the bar that generated the signal)
 *   • commission + slippage on every side
 *   • look-ahead guard: a projected pivot is only tradable once the source bars
 *     that confirm it (pivot + N bars) had actually closed in real time
 *   • mark-to-market equity → annualised Sharpe / Sortino / Calmar / drawdown
 *   • buy & hold benchmark, monthly returns, long vs short breakdown
 *   • in-sample / out-of-sample split
 *   • timing accuracy of projected vs actual swings
 *   • circular-shift Monte Carlo (same cycle, random phase) → p-values
 *   • parameter-sensitivity sweep (swing strength × entry shift)
 *
 * Pure functions only — runs in a Web Worker (see workers/cycleBacktestWorker.ts).
 */
import type { BacktestSignal, BacktestStats, BacktestTrade, CandleSlot, OffsetOverlay } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Config & input types
// ─────────────────────────────────────────────────────────────────────────────

export type CycleEntryMode = 'pivot_open' | 'confirm_break';
export type CycleStopMode = 'none' | 'atr' | 'pct' | 'swing';
export type CycleDirection = 'both' | 'long_only' | 'short_only';

export interface CycleBacktestConfig {
  overlayId: string;
  /** Pivot strength: bars on each side that must be lower (high) / higher (low). */
  swingLR: number;
  /** pivot_open = enter at the open of the projected pivot bar; confirm_break = wait for a close beyond the pivot bar's range, fill next open. */
  entryMode: CycleEntryMode;
  /** Shift every projected pivot by ±N bars (negative = earlier). */
  entryOffsetBars: number;
  direction: CycleDirection;
  stopMode: CycleStopMode;
  atrPeriod: number;
  stopAtrMult: number;
  stopPct: number;
  /** Strength of the small chart swings used by the 'swing' stop. */
  minorSwingLR: number;
  /** Move the swing stop to each new small swing that forms after entry (only tightens). */
  trailSwingStop: boolean;
  /** Take profit as a multiple of the initial stop distance (0 = off). */
  takeProfitR: number;
  /** Force exit after N bars (0 = off). */
  maxHoldBars: number;
  commissionBps: number;
  slippageBps: number;
  lookAheadGuard: boolean;
  /** Merge consecutive same-type swings into the most extreme one, exactly like the overlay's Swing H/L plot. */
  matchOverlayPlot: boolean;
  /** A projected pivot "hits" if an actual pivot of the same type is within ±N bars. */
  hitToleranceBars: number;
  inSampleFraction: number;
  monteCarloRuns: number;
  runSweep: boolean;
}

export const DEFAULT_CYCLE_BACKTEST_CONFIG: CycleBacktestConfig = {
  overlayId: '',
  swingLR: 15,
  entryMode: 'pivot_open',
  entryOffsetBars: 0,
  direction: 'both',
  stopMode: 'atr',
  atrPeriod: 14,
  stopAtrMult: 2,
  stopPct: 2,
  minorSwingLR: 3,
  trailSwingStop: true,
  takeProfitR: 0,
  maxHoldBars: 0,
  commissionBps: 5,
  slippageBps: 2,
  lookAheadGuard: true,
  matchOverlayPlot: true,
  hitToleranceBars: 3,
  inSampleFraction: 0.7,
  monteCarloRuns: 500,
  runSweep: true,
};

export interface CycleBar {
  slotIndex: number;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** One source (historical) candle of the overlay, already projected onto the chart. */
export interface CycleSourceBar {
  originalTimestamp: number;
  projectedTimestamp: number;
  projectedSlotIndex: number;
  high: number;
  low: number;
}

export interface CycleBacktestInput {
  config: CycleBacktestConfig;
  bars: CycleBar[];
  source: CycleSourceBar[];
  meta: { overlayLabel: string; offsetDays: number; timeframe: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export type CycleExitReason = 'signal' | 'stop_loss' | 'take_profit' | 'time_exit' | 'end_of_data';

export interface CycleTrade {
  id: number;
  direction: 'long' | 'short';
  entryIdx: number;
  exitIdx: number;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number | null;
  /** Net of costs, % of entry notional. */
  returnPct: number;
  bars: number;
  exitReason: CycleExitReason;
  maePct: number;
  mfePct: number;
  equityAfter: number;
}

export interface SideStats {
  trades: number;
  winRatePct: number;
  avgReturnPct: number;
  totalReturnPct: number;
  profitFactor: number;
}

export interface PerfMetrics {
  startTs: number;
  endTs: number;
  years: number;
  totalReturnPct: number;
  cagrPct: number;
  annVolPct: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDrawdownPct: number;
  maxDrawdownDays: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  payoffRatio: number;
  profitFactor: number;
  expectancyPct: number;
  medianTradePct: number;
  bestTradePct: number;
  worstTradePct: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  avgBarsHeld: number;
  exposurePct: number;
  tradesPerYear: number;
  tStat: number;
  avgMaePct: number;
  avgMfePct: number;
  long: SideStats;
  short: SideStats;
}

export interface BenchmarkMetrics {
  totalReturnPct: number;
  cagrPct: number;
  sharpe: number;
  maxDrawdownPct: number;
}

export interface TimingStats {
  evaluated: number;
  hits: number;
  hitRatePct: number;
  meanAbsErrBars: number;
  medianAbsErrBars: number;
  /** >0 = projected pivots tend to arrive after the real turn. */
  meanSignedErrBars: number;
  toleranceBars: number;
}

export interface MonteCarloStats {
  runs: number;
  returnPValue: number;
  sharpePValue: number;
  hitRatePValue: number;
  returnPercentile: number;
  randomReturnP5: number;
  randomReturnP50: number;
  randomReturnP95: number;
  randomSharpeP50: number;
  randomSharpeP95: number;
  randomHitRatePct: number;
  histogram: { from: number; to: number; count: number }[];
}

export interface SweepCell {
  swingLR: number;
  offset: number;
  totalReturnPct: number;
  sharpe: number;
  trades: number;
  winRatePct: number;
  maxDrawdownPct: number;
}

export interface StopComparisonRow {
  label: string;
  current: boolean;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  calmar: number;
  trades: number;
  winRatePct: number;
  worstTradePct: number;
  stopExits: number;
}

export interface UpcomingPivot {
  type: 'high' | 'low';
  projectedTs: number;
  originalTs: number;
  sourcePrice: number;
}

export interface CycleBacktestResult {
  config: CycleBacktestConfig;
  generatedAt: number;
  meta: CycleBacktestInput['meta'] & {
    bars: number;
    fromTs: number;
    toTs: number;
    pivotsDetected: number;
    pivotsInRange: number;
    pivotsTraded: number;
    pivotsSkippedLookahead: number;
    pivotsFuture: number;
  };
  metrics: PerfMetrics;
  benchmark: BenchmarkMetrics;
  inSample: PerfMetrics;
  outOfSample: PerfMetrics;
  splitTs: number;
  trades: CycleTrade[];
  equityCurve: { ts: number; equity: number; benchmark: number; drawdownPct: number }[];
  monthly: { year: number; months: (number | null)[]; total: number }[];
  timing: TimingStats;
  monteCarlo: MonteCarloStats | null;
  sweep: SweepCell[];
  stopComparison: StopComparisonRow[];
  sweepLRs: number[];
  sweepOffsets: number[];
  upcoming: UpcomingPivot[];
  openPosition: { direction: 'long' | 'short'; entryTs: number; entryPrice: number; unrealisedPct: number } | null;
  warnings: string[];
  chartTrades: BacktestTrade[];
  chartSignals: BacktestSignal[];
}

export type ProgressFn = (pct: number, label: string) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Input adapters (main thread)
// ─────────────────────────────────────────────────────────────────────────────

export function barsFromSlots(slots: CandleSlot[]): CycleBar[] {
  const out: CycleBar[] = [];
  for (const s of slots) {
    const c = s.candle;
    if (!c) continue;
    out.push({ slotIndex: s.slotIndex, timestamp: s.timestamp, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return out;
}

export function sourceFromOverlay(overlay: OffsetOverlay): CycleSourceBar[] {
  return overlay.projectedCandles
    .map(pc => ({
      originalTimestamp: pc.originalTimestamp,
      projectedTimestamp: pc.projectedTimestamp,
      projectedSlotIndex: pc.projectedSlotIndex,
      high: pc.candle.high,
      low: pc.candle.low,
    }))
    .sort((a, b) => a.originalTimestamp - b.originalTimestamp);
}

// ─────────────────────────────────────────────────────────────────────────────
// Small numeric helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;

function medianInterval(ts: number[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < ts.length && diffs.length < 500; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 60_000;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lowerBound(arr: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function computeAtr(bars: CycleBar[], period: number): Float64Array {
  const atr = new Float64Array(bars.length).fill(NaN);
  if (bars.length <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  }
  let prev = sum / period;
  atr[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    prev = (prev * (period - 1) + tr) / period;
    atr[i] = prev;
  }
  return atr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pivot detection & mapping
// ─────────────────────────────────────────────────────────────────────────────

interface SourcePivot {
  type: 'high' | 'low';
  price: number;
  originalTs: number;
  projectedTs: number;
  projectedSlotIndex: number;
  /** Real time at which the pivot became confirmed (close of pivot + lr source bars). */
  confirmTs: number;
}

interface MappedPivot extends SourcePivot {
  status: 'in' | 'future' | 'before';
  barIdx: number;
}

/** Strict pivots, same rule as offsetEngine._computeOverlaySwingPoints (before its merge step). */
function detectSourcePivots(src: CycleSourceBar[], lr: number): SourcePivot[] {
  const out: SourcePivot[] = [];
  if (src.length < lr * 2 + 1) return out;
  const interval = medianInterval(src.map(s => s.originalTimestamp));
  for (let i = lr; i < src.length - lr; i++) {
    const b = src[i];
    let isHigh = true;
    for (let j = i - lr; j <= i + lr; j++) {
      if (j !== i && src[j].high >= b.high) { isHigh = false; break; }
    }
    let isLow = false;
    if (!isHigh) {
      isLow = true;
      for (let j = i - lr; j <= i + lr; j++) {
        if (j !== i && src[j].low <= b.low) { isLow = false; break; }
      }
    }
    if (!isHigh && !isLow) continue;
    out.push({
      type: isHigh ? 'high' : 'low',
      price: isHigh ? b.high : b.low,
      originalTs: b.originalTimestamp,
      projectedTs: b.projectedTimestamp,
      projectedSlotIndex: b.projectedSlotIndex,
      confirmTs: src[i + lr].originalTimestamp + interval,
    });
  }
  return out;
}

/**
 * Mirror of the overlay plot: drop pivots that are off the chart, then keep only the
 * most extreme of consecutive same-type swings. `lookaheadMerges` counts replacements
 * whose newer swing was not yet confirmed when the older one would have been traded.
 */
function mergeLikeOverlay(pivots: SourcePivot[]): { pivots: SourcePivot[]; lookaheadMerges: number } {
  const kept: SourcePivot[] = [];
  let lookaheadMerges = 0;
  for (const p of pivots) {
    if (p.projectedSlotIndex < 0) continue;
    const last = kept[kept.length - 1];
    if (!last || last.type !== p.type) {
      kept.push(p);
      continue;
    }
    if ((p.type === 'high' && p.price > last.price) || (p.type === 'low' && p.price < last.price)) {
      if (p.confirmTs > last.projectedTs) lookaheadMerges++;
      kept[kept.length - 1] = p;
    }
  }
  return { pivots: kept, lookaheadMerges };
}

function swingPivots(src: CycleSourceBar[], lr: number, matchOverlayPlot: boolean): { pivots: SourcePivot[]; lookaheadMerges: number } {
  const raw = detectSourcePivots(src, lr);
  return matchOverlayPlot ? mergeLikeOverlay(raw) : { pivots: raw, lookaheadMerges: 0 };
}

function mapPivots(pivots: SourcePivot[], bars: CycleBar[], barTs: Float64Array, barSlot: Float64Array, barInterval: number): MappedPivot[] {
  const n = bars.length;
  const firstTs = bars[0].timestamp;
  const lastTs = bars[n - 1].timestamp;
  const lastSlot = bars[n - 1].slotIndex;
  return pivots.map(p => {
    if (p.projectedSlotIndex >= 0) {
      const slot = Math.ceil(p.projectedSlotIndex - 1e-9);
      if (slot > lastSlot) return { ...p, status: 'future' as const, barIdx: -1 };
      const idx = lowerBound(barSlot, slot);
      return idx < n ? { ...p, status: 'in' as const, barIdx: idx } : { ...p, status: 'future' as const, barIdx: -1 };
    }
    if (p.projectedTs > lastTs + barInterval * 0.5) return { ...p, status: 'future' as const, barIdx: -1 };
    if (p.projectedTs < firstTs - barInterval * 0.5) return { ...p, status: 'before' as const, barIdx: -1 };
    const idx = lowerBound(barTs, p.projectedTs - barInterval * 0.45);
    return idx < n ? { ...p, status: 'in' as const, barIdx: idx } : { ...p, status: 'future' as const, barIdx: -1 };
  });
}

/** Per-bar event array: +1 = projected low (long), -1 = projected high (short). */
function buildEvents(pivots: MappedPivot[], bars: CycleBar[], offset: number, guard: boolean) {
  const n = bars.length;
  const events = new Int8Array(n);
  let used = 0;
  let skipped = 0;
  for (const p of pivots) {
    if (p.status !== 'in') continue;
    const idx = p.barIdx + offset;
    if (idx < 0 || idx >= n) continue;
    if (guard && p.confirmTs > bars[idx].timestamp) { skipped++; continue; }
    if (events[idx] === 0) {
      events[idx] = p.type === 'low' ? 1 : -1;
      used++;
    }
  }
  return { events, used, skipped };
}

function detectBarPivots(bars: CycleBar[], lr: number): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = lr; i < bars.length - lr; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lr; j <= i + lr && (isHigh || isLow); j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) highs.push(i);
    else if (isLow) lows.push(i);
  }
  return { highs, lows };
}

function nearestDistance(sorted: number[], idx: number): number {
  if (!sorted.length) return Infinity;
  const k = lowerBound(sorted, idx);
  let best = Infinity;
  if (k < sorted.length) best = sorted[k] - idx;
  if (k > 0 && Math.abs(idx - sorted[k - 1]) < Math.abs(best)) best = sorted[k - 1] - idx;
  return -best; // >0 → projected pivot came after the actual one
}

function timingStats(
  points: { type: 'high' | 'low'; barIdx: number }[],
  actual: { highs: number[]; lows: number[] },
  tol: number,
): TimingStats {
  const errs: number[] = [];
  let hits = 0;
  for (const p of points) {
    const d = nearestDistance(p.type === 'high' ? actual.highs : actual.lows, p.barIdx);
    if (!Number.isFinite(d)) continue;
    errs.push(d);
    if (Math.abs(d) <= tol) hits++;
  }
  const abs = errs.map(Math.abs);
  return {
    evaluated: errs.length,
    hits,
    hitRatePct: errs.length ? (hits / errs.length) * 100 : 0,
    meanAbsErrBars: mean(abs),
    medianAbsErrBars: median(abs),
    meanSignedErrBars: mean(errs),
    toleranceBars: tol,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation
// ─────────────────────────────────────────────────────────────────────────────

interface SimResult {
  equity: Float64Array;
  trades: CycleTrade[];
  inMarketBars: number;
}

interface SimPosition {
  dir: 1 | -1;
  entryIdx: number;
  entryPrice: number;
  stop: number;
  tp: number;
  mae: number;
  mfe: number;
}

/** Small swings on the chart's own bars, as known at each bar's open. */
interface MinorSwings {
  lowPx: Float64Array;
  lowIdx: Int32Array;
  highPx: Float64Array;
  highIdx: Int32Array;
}

/** Index i holds the latest swing confirmed by the close of bar i-1 (pivot j needs k bars after it). */
function minorSwingLevels(bars: CycleBar[], k: number): MinorSwings {
  const n = bars.length;
  const out: MinorSwings = {
    lowPx: new Float64Array(n).fill(NaN),
    lowIdx: new Int32Array(n).fill(-1),
    highPx: new Float64Array(n).fill(NaN),
    highIdx: new Int32Array(n).fill(-1),
  };
  let lowPx = NaN, lowIdx = -1, highPx = NaN, highIdx = -1;
  for (let i = 0; i < n; i++) {
    out.lowPx[i] = lowPx;
    out.lowIdx[i] = lowIdx;
    out.highPx[i] = highPx;
    out.highIdx[i] = highIdx;
    const j = i - k;
    if (j < k) continue;
    let isHigh = true;
    let isLow = true;
    for (let m = j - k; m <= j + k && (isHigh || isLow); m++) {
      if (m === j) continue;
      if (bars[m].high >= bars[j].high) isHigh = false;
      if (bars[m].low <= bars[j].low) isLow = false;
    }
    if (isHigh) { highPx = bars[j].high; highIdx = j; }
    if (isLow) { lowPx = bars[j].low; lowIdx = j; }
  }
  return out;
}

function simulate(bars: CycleBar[], events: Int8Array, cfg: CycleBacktestConfig, atr: Float64Array, minor: MinorSwings): SimResult {
  const n = bars.length;
  const equity = new Float64Array(n);
  const trades: CycleTrade[] = [];
  const cost = (cfg.commissionBps + cfg.slippageBps) / 10_000;
  const canLong = cfg.direction !== 'short_only';
  const canShort = cfg.direction !== 'long_only';
  const allowed = (d: number) => (d === 1 ? canLong : canShort);

  let cash = 1;
  let inMarketBars = 0;
  // `as` keeps TS from narrowing to null — pos is reassigned inside open()/close().
  let pos = null as SimPosition | null;
  let pending = null as { dir: 1 | -1; level: number; setAt: number } | null;
  let enterNext = 0 as 0 | 1 | -1;

  const open = (i: number, dir: 1 | -1, px: number) => {
    let stop = NaN;
    if (cfg.stopMode === 'atr') {
      const a = atr[Math.max(0, i - 1)];
      if (Number.isFinite(a) && a > 0) stop = px - dir * cfg.stopAtrMult * a;
    } else if (cfg.stopMode === 'pct' && cfg.stopPct > 0) {
      stop = px * (1 - dir * cfg.stopPct / 100);
    } else if (cfg.stopMode === 'swing') {
      const lv = dir === 1 ? minor.lowPx[i] : minor.highPx[i];
      // Only a swing on the protective side of the fill is a valid stop.
      if (Number.isFinite(lv) && dir * (px - lv) > 0) stop = lv;
    }
    const tp = cfg.takeProfitR > 0 && Number.isFinite(stop) ? px + dir * cfg.takeProfitR * Math.abs(px - stop) : NaN;
    pos = { dir, entryIdx: i, entryPrice: px, stop, tp, mae: 0, mfe: 0 };
  };

  const close = (i: number, px: number, reason: CycleExitReason) => {
    if (!pos) return;
    const ret = pos.dir * (px / pos.entryPrice - 1) - 2 * cost;
    cash *= 1 + ret;
    trades.push({
      id: trades.length + 1,
      direction: pos.dir === 1 ? 'long' : 'short',
      entryIdx: pos.entryIdx,
      exitIdx: i,
      entryTs: bars[pos.entryIdx].timestamp,
      exitTs: bars[i].timestamp,
      entryPrice: pos.entryPrice,
      exitPrice: px,
      stopPrice: Number.isFinite(pos.stop) ? pos.stop : null,
      returnPct: ret * 100,
      bars: i - pos.entryIdx,
      exitReason: reason,
      maePct: pos.mae * 100,
      mfePct: pos.mfe * 100,
      equityAfter: cash * 100,
    });
    pos = null;
  };

  for (let i = 0; i < n; i++) {
    const b = bars[i];

    if (enterNext !== 0) {
      if (pos && pos.dir !== enterNext) close(i, b.open, 'signal');
      if (!pos && allowed(enterNext)) open(i, enterNext, b.open);
      enterNext = 0;
    }

    const ev = events[i] as 0 | 1 | -1;
    if (ev !== 0) {
      if (pos && pos.dir !== ev) close(i, b.open, 'signal');
      if (cfg.entryMode === 'pivot_open') {
        if (!pos && allowed(ev)) open(i, ev, b.open);
      } else if (allowed(ev) && (!pos || pos.dir !== ev)) {
        pending = { dir: ev, level: NaN, setAt: i };
      } else {
        pending = null;
      }
    }

    if (pos) {
      const p = pos;
      const adverse = p.dir === 1 ? (b.low / p.entryPrice - 1) : (1 - b.high / p.entryPrice);
      const favour = p.dir === 1 ? (b.high / p.entryPrice - 1) : (1 - b.low / p.entryPrice);
      p.mae = Math.min(p.mae, adverse);
      p.mfe = Math.max(p.mfe, favour);
      if (cfg.stopMode === 'swing' && cfg.trailSwingStop) {
        const idx = p.dir === 1 ? minor.lowIdx[i] : minor.highIdx[i];
        const lv = p.dir === 1 ? minor.lowPx[i] : minor.highPx[i];
        const tighter = !Number.isFinite(p.stop) || p.dir * (lv - p.stop) > 0;
        if (idx >= p.entryIdx && tighter && p.dir * (b.open - lv) > 0) p.stop = lv;
      }
      // Stop is checked before target when both fall inside one bar (conservative).
      if (p.dir === 1) {
        if (Number.isFinite(p.stop) && b.low <= p.stop) close(i, Math.min(b.open, p.stop), 'stop_loss');
        else if (Number.isFinite(p.tp) && b.high >= p.tp) close(i, Math.max(b.open, p.tp), 'take_profit');
      } else {
        if (Number.isFinite(p.stop) && b.high >= p.stop) close(i, Math.max(b.open, p.stop), 'stop_loss');
        else if (Number.isFinite(p.tp) && b.low <= p.tp) close(i, Math.min(b.open, p.tp), 'take_profit');
      }
    }

    if (pos && cfg.maxHoldBars > 0 && i - pos.entryIdx >= cfg.maxHoldBars) {
      close(i, b.close, 'time_exit');
    }

    if (pending) {
      if (pending.setAt === i) {
        pending.level = pending.dir === 1 ? b.high : b.low;
      } else if ((pending.dir === 1 && b.close > pending.level) || (pending.dir === -1 && b.close < pending.level)) {
        enterNext = pending.dir;
        pending = null;
      }
    }

    if (pos) {
      inMarketBars++;
      equity[i] = cash * (1 + pos.dir * (b.close / pos.entryPrice - 1) - cost);
    } else {
      equity[i] = cash;
    }
  }

  if (pos && n > 0) {
    close(n - 1, bars[n - 1].close, 'end_of_data');
    equity[n - 1] = cash;
  }
  return { equity, trades, inMarketBars };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

/** Index of the last bar of each UTC day. */
function dayEndIndices(bars: CycleBar[]): Int32Array {
  const idx: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const day = Math.floor(bars[i].timestamp / DAY_MS);
    const next = i + 1 < bars.length ? Math.floor(bars[i + 1].timestamp / DAY_MS) : NaN;
    if (day !== next) idx.push(i);
  }
  return Int32Array.from(idx);
}

interface EquityStats {
  totalReturnPct: number;
  cagrPct: number;
  annVolPct: number;
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  maxDrawdownDays: number;
  years: number;
}

function equityStats(
  bars: CycleBar[],
  equity: ArrayLike<number>,
  dayEnds: Int32Array,
  from: number,
  to: number,
  base: number,
): EquityStats {
  const empty: EquityStats = { totalReturnPct: 0, cagrPct: 0, annVolPct: 0, sharpe: 0, sortino: 0, maxDrawdownPct: 0, maxDrawdownDays: 0, years: 0 };
  if (to - from < 2 || base <= 0) return empty;
  const startTs = bars[from].timestamp;
  const endTs = bars[to - 1].timestamp;
  const years = Math.max((endTs - startTs) / YEAR_MS, 1 / 365.25);
  const final = equity[to - 1] / base;

  // Daily returns when there are enough days, otherwise per-bar.
  const k0 = lowerBound(dayEnds, from);
  const k1 = lowerBound(dayEnds, to);
  const rets: number[] = [];
  let periodsPerYear: number;
  if (k1 - k0 >= 10) {
    let prev = base;
    for (let k = k0; k < k1; k++) {
      const e = equity[dayEnds[k]];
      rets.push(e / prev - 1);
      prev = e;
    }
    periodsPerYear = (k1 - k0) / years;
  } else {
    let prev = base;
    for (let i = from; i < to; i++) {
      rets.push(equity[i] / prev - 1);
      prev = equity[i];
    }
    periodsPerYear = (to - from) / years;
  }
  const m = mean(rets);
  const sd = stdev(rets);
  const downside = Math.sqrt(rets.reduce((a, r) => a + (r < 0 ? r * r : 0), 0) / Math.max(1, rets.length));
  const ann = Math.sqrt(periodsPerYear);

  let peak = base;
  let peakTs = startTs;
  let maxDd = 0;
  let maxDdMs = 0;
  for (let i = from; i < to; i++) {
    const e = equity[i];
    if (e >= peak) {
      peak = e;
      peakTs = bars[i].timestamp;
    } else {
      maxDd = Math.max(maxDd, (peak - e) / peak);
      maxDdMs = Math.max(maxDdMs, bars[i].timestamp - peakTs);
    }
  }

  return {
    totalReturnPct: (final - 1) * 100,
    cagrPct: final > 0 ? (Math.pow(final, 1 / years) - 1) * 100 : -100,
    annVolPct: sd * ann * 100,
    sharpe: sd > 0 ? (m / sd) * ann : 0,
    sortino: downside > 0 ? (m / downside) * ann : 0,
    maxDrawdownPct: maxDd * 100,
    maxDrawdownDays: maxDdMs / DAY_MS,
    years,
  };
}

function sideStats(trades: CycleTrade[]): SideStats {
  const rets = trades.map(t => t.returnPct);
  const gp = rets.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(rets.filter(r => r <= 0).reduce((a, b) => a + b, 0));
  return {
    trades: trades.length,
    winRatePct: trades.length ? (rets.filter(r => r > 0).length / trades.length) * 100 : 0,
    avgReturnPct: mean(rets),
    totalReturnPct: (rets.reduce((a, r) => a * (1 + r / 100), 1) - 1) * 100,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
  };
}

function perfMetrics(
  bars: CycleBar[],
  equity: ArrayLike<number>,
  dayEnds: Int32Array,
  allTrades: CycleTrade[],
  from: number,
  to: number,
): PerfMetrics {
  const base = from > 0 ? equity[from - 1] : 1;
  const eq = equityStats(bars, equity, dayEnds, from, to, base);
  const trades = allTrades.filter(t => t.entryIdx >= from && t.entryIdx < to);
  const rets = trades.map(t => t.returnPct);
  const wins = rets.filter(r => r > 0);
  const losses = rets.filter(r => r <= 0);
  const gp = wins.reduce((a, b) => a + b, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b, 0));
  const avgWin = wins.length ? gp / wins.length : 0;
  const avgLoss = losses.length ? gl / losses.length : 0;

  let cw = 0, cl = 0, maxCw = 0, maxCl = 0;
  for (const r of rets) {
    if (r > 0) { cw++; cl = 0; } else { cl++; cw = 0; }
    maxCw = Math.max(maxCw, cw);
    maxCl = Math.max(maxCl, cl);
  }

  let inMarket = 0;
  for (const t of trades) inMarket += Math.max(1, Math.min(t.exitIdx, to - 1) - t.entryIdx);
  const sd = stdev(rets);

  return {
    startTs: bars[from]?.timestamp ?? 0,
    endTs: bars[Math.max(from, to - 1)]?.timestamp ?? 0,
    years: eq.years,
    totalReturnPct: eq.totalReturnPct,
    cagrPct: eq.cagrPct,
    annVolPct: eq.annVolPct,
    sharpe: eq.sharpe,
    sortino: eq.sortino,
    calmar: eq.maxDrawdownPct > 0 ? eq.cagrPct / eq.maxDrawdownPct : 0,
    maxDrawdownPct: eq.maxDrawdownPct,
    maxDrawdownDays: eq.maxDrawdownDays,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    expectancyPct: mean(rets),
    medianTradePct: median(rets),
    bestTradePct: rets.length ? Math.max(...rets) : 0,
    worstTradePct: rets.length ? Math.min(...rets) : 0,
    maxConsecWins: maxCw,
    maxConsecLosses: maxCl,
    avgBarsHeld: mean(trades.map(t => t.bars)),
    exposurePct: to > from ? Math.min(100, (inMarket / (to - from)) * 100) : 0,
    tradesPerYear: eq.years > 0 ? trades.length / eq.years : 0,
    tStat: sd > 0 && rets.length > 1 ? mean(rets) / (sd / Math.sqrt(rets.length)) : 0,
    avgMaePct: mean(trades.map(t => t.maePct)),
    avgMfePct: mean(trades.map(t => t.mfePct)),
    long: sideStats(trades.filter(t => t.direction === 'long')),
    short: sideStats(trades.filter(t => t.direction === 'short')),
  };
}

function monthlyReturns(bars: CycleBar[], equity: ArrayLike<number>): CycleBacktestResult['monthly'] {
  const byYear = new Map<number, (number | null)[]>();
  let prev = 1;
  for (let i = 0; i < bars.length; i++) {
    const d = new Date(bars[i].timestamp);
    const nextMonth = i + 1 < bars.length ? new Date(bars[i + 1].timestamp).getUTCMonth() : -1;
    if (d.getUTCMonth() === nextMonth) continue;
    const y = d.getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, new Array(12).fill(null));
    byYear.get(y)![d.getUTCMonth()] = (equity[i] / prev - 1) * 100;
    prev = equity[i];
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, months]) => ({
      year,
      months,
      total: (months.reduce<number>((a, m) => a * (1 + (m ?? 0) / 100), 1) - 1) * 100,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export function runCycleBacktest(input: CycleBacktestInput, onProgress?: ProgressFn): CycleBacktestResult {
  const { config: cfg, bars, meta } = input;
  const n = bars.length;
  const warnings: string[] = [];
  if (n < Math.max(50, cfg.swingLR * 4)) throw new Error(`Not enough bars on the chart (${n}). Load more history.`);
  const source = [...input.source].sort((a, b) => a.originalTimestamp - b.originalTimestamp);
  if (source.length < cfg.swingLR * 2 + 1) throw new Error('The overlay has too few source candles for this swing strength.');

  onProgress?.(2, 'Detecting projected swings');
  const barTs = Float64Array.from(bars, b => b.timestamp);
  const barSlot = Float64Array.from(bars, b => b.slotIndex);
  const barInterval = medianInterval(bars.slice(0, 600).map(b => b.timestamp));
  const atr = computeAtr(bars, Math.max(1, cfg.atrPeriod));
  const minor = minorSwingLevels(bars, Math.max(1, cfg.minorSwingLR));
  const dayEnds = dayEndIndices(bars);

  const swings = swingPivots(source, cfg.swingLR, cfg.matchOverlayPlot);
  const pivots = mapPivots(swings.pivots, bars, barTs, barSlot, barInterval);
  const inRange = pivots.filter(p => p.status === 'in');
  const { events, used, skipped } = buildEvents(pivots, bars, cfg.entryOffsetBars, cfg.lookAheadGuard);
  if (!inRange.length) warnings.push('No projected swing falls inside the loaded bars — scroll/load more history or change the offset.');
  if (cfg.lookAheadGuard && skipped > 0) {
    warnings.push(`${skipped} projected swing(s) skipped: they were not yet confirmed (pivot + ${cfg.swingLR} source bars) when the trade would have been placed. Use a larger offset or a smaller swing value.`);
  }
  if (swings.lookaheadMerges > 0) {
    warnings.push(`${swings.lookaheadMerges} swing merge(s) used a newer swing that was not yet confirmed at trade time (overlay-plot matching). Untick "Match overlay plot" for a strictly causal test.`);
  }

  onProgress?.(10, 'Simulating trades');
  const sim = simulate(bars, events, cfg, atr, minor);
  const metrics = perfMetrics(bars, sim.equity, dayEnds, sim.trades, 0, n);
  if (metrics.trades < 30) warnings.push(`Only ${metrics.trades} trades — statistics are not significant below ~30 trades.`);

  // Same entries/exits under each stop rule, to see what the stop does to drawdown.
  const stopVariants: { label: string; patch: Partial<CycleBacktestConfig> }[] = [
    { label: 'No stop (exit on next swing only)', patch: { stopMode: 'none' } },
    { label: `ATR stop ${cfg.stopAtrMult}× ATR(${cfg.atrPeriod})`, patch: { stopMode: 'atr' } },
    { label: `Small swing ${cfg.minorSwingLR} stop, fixed`, patch: { stopMode: 'swing', trailSwingStop: false } },
    { label: `Small swing ${cfg.minorSwingLR} stop, trailing`, patch: { stopMode: 'swing', trailSwingStop: true } },
  ];
  if (cfg.stopMode === 'pct') stopVariants.push({ label: `Fixed ${cfg.stopPct}% stop`, patch: { stopMode: 'pct' } });
  const stopComparison: StopComparisonRow[] = stopVariants.map(v => {
    const vc = { ...cfg, ...v.patch };
    const s = simulate(bars, events, vc, atr, minor);
    const st = equityStats(bars, s.equity, dayEnds, 0, n, 1);
    const rets = s.trades.map(t => t.returnPct);
    return {
      label: v.label,
      current: vc.stopMode === cfg.stopMode && (vc.stopMode !== 'swing' || vc.trailSwingStop === cfg.trailSwingStop),
      totalReturnPct: st.totalReturnPct,
      cagrPct: st.cagrPct,
      maxDrawdownPct: st.maxDrawdownPct,
      sharpe: st.sharpe,
      calmar: st.maxDrawdownPct > 0 ? st.cagrPct / st.maxDrawdownPct : 0,
      trades: s.trades.length,
      winRatePct: rets.length ? (rets.filter(r => r > 0).length / rets.length) * 100 : 0,
      worstTradePct: rets.length ? Math.min(...rets) : 0,
      stopExits: s.trades.filter(t => t.exitReason === 'stop_loss').length,
    };
  });

  // Benchmark: buy & hold on closes.
  const bh = new Float64Array(n);
  const c0 = bars[0].close;
  for (let i = 0; i < n; i++) bh[i] = bars[i].close / c0;
  const bhStats = equityStats(bars, bh, dayEnds, 0, n, 1);

  const splitIdx = Math.min(n - 1, Math.max(1, Math.floor(n * cfg.inSampleFraction)));
  const inSample = perfMetrics(bars, sim.equity, dayEnds, sim.trades, 0, splitIdx);
  const outOfSample = perfMetrics(bars, sim.equity, dayEnds, sim.trades, splitIdx, n);

  onProgress?.(15, 'Measuring timing accuracy');
  const actual = detectBarPivots(bars, cfg.swingLR);
  const tol = Math.max(0, cfg.hitToleranceBars);
  const timingPoints = inRange.map(p => ({ type: p.type, barIdx: p.barIdx }));
  const timing = timingStats(timingPoints, actual, tol);

  // Monte Carlo: same pivot schedule, random phase (circular shift).
  let monteCarlo: MonteCarloStats | null = null;
  const minShift = Math.max(cfg.swingLR * 2, Math.floor(n * 0.02));
  const runs = Math.min(cfg.monteCarloRuns, Math.floor(3e8 / n));
  if (runs >= 20 && n - 2 * minShift > 0 && used > 0) {
    const rng = mulberry32(0xc1c1e);
    const eventIdx: number[] = [];
    for (let i = 0; i < n; i++) if (events[i] !== 0) eventIdx.push(i);
    const rRet: number[] = [];
    const rSharpe: number[] = [];
    const rHit: number[] = [];
    const shifted = new Int8Array(n);
    for (let r = 0; r < runs; r++) {
      const k = minShift + Math.floor(rng() * (n - 2 * minShift));
      shifted.fill(0);
      for (const i of eventIdx) shifted[(i + k) % n] = events[i];
      const s = simulate(bars, shifted, cfg, atr, minor);
      const st = equityStats(bars, s.equity, dayEnds, 0, n, 1);
      rRet.push(st.totalReturnPct);
      rSharpe.push(st.sharpe);
      rHit.push(timingStats(timingPoints.map(p => ({ type: p.type, barIdx: (p.barIdx + k) % n })), actual, tol).hitRatePct);
      if (r % 10 === 0) onProgress?.(15 + Math.round((r / runs) * 55), `Monte Carlo ${r}/${runs}`);
    }
    const sortedRet = [...rRet].sort((a, b) => a - b);
    const sortedSharpe = [...rSharpe].sort((a, b) => a - b);
    const pv = (xs: number[], x: number) => (xs.filter(v => v >= x).length + 1) / (xs.length + 1);
    const lo = Math.min(sortedRet[0], metrics.totalReturnPct);
    const hi = Math.max(sortedRet[sortedRet.length - 1], metrics.totalReturnPct);
    const binCount = 30;
    const width = (hi - lo) / binCount || 1;
    const histogram = Array.from({ length: binCount }, (_, b) => ({ from: lo + b * width, to: lo + (b + 1) * width, count: 0 }));
    for (const v of rRet) histogram[Math.min(binCount - 1, Math.floor((v - lo) / width))].count++;
    monteCarlo = {
      runs,
      returnPValue: pv(rRet, metrics.totalReturnPct),
      sharpePValue: pv(rSharpe, metrics.sharpe),
      hitRatePValue: pv(rHit, timing.hitRatePct),
      returnPercentile: (rRet.filter(v => v < metrics.totalReturnPct).length / rRet.length) * 100,
      randomReturnP5: quantile(sortedRet, 0.05),
      randomReturnP50: quantile(sortedRet, 0.5),
      randomReturnP95: quantile(sortedRet, 0.95),
      randomSharpeP50: quantile(sortedSharpe, 0.5),
      randomSharpeP95: quantile(sortedSharpe, 0.95),
      randomHitRatePct: mean(rHit),
      histogram,
    };
  } else {
    warnings.push('Monte Carlo skipped (too few bars or no tradable swings).');
  }

  // Parameter sensitivity sweep.
  const sweepLRs = [...new Set([5, 8, 10, 12, 15, 20, 25, 30, cfg.swingLR])].sort((a, b) => a - b);
  const sweepOffsets = [...new Set([-5, -3, -1, 0, 1, 3, 5, cfg.entryOffsetBars])].sort((a, b) => a - b);
  const sweep: SweepCell[] = [];
  if (cfg.runSweep) {
    let done = 0;
    const total = sweepLRs.length * sweepOffsets.length;
    for (const lr of sweepLRs) {
      const pv = mapPivots(swingPivots(source, lr, cfg.matchOverlayPlot).pivots, bars, barTs, barSlot, barInterval);
      for (const off of sweepOffsets) {
        const ev = buildEvents(pv, bars, off, cfg.lookAheadGuard).events;
        const s = simulate(bars, ev, cfg, atr, minor);
        const st = equityStats(bars, s.equity, dayEnds, 0, n, 1);
        sweep.push({
          swingLR: lr,
          offset: off,
          totalReturnPct: st.totalReturnPct,
          sharpe: st.sharpe,
          trades: s.trades.length,
          winRatePct: s.trades.length ? (s.trades.filter(t => t.returnPct > 0).length / s.trades.length) * 100 : 0,
          maxDrawdownPct: st.maxDrawdownPct,
        });
        done++;
        if (done % 4 === 0) onProgress?.(70 + Math.round((done / total) * 25), `Sweep ${done}/${total}`);
      }
    }
  }

  onProgress?.(96, 'Building report');
  const step = Math.max(1, Math.floor(n / 2000));
  const equityCurve: CycleBacktestResult['equityCurve'] = [];
  let peak = 1;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, sim.equity[i]);
    if (i % step === 0 || i === n - 1) {
      equityCurve.push({ ts: bars[i].timestamp, equity: sim.equity[i] * 100, benchmark: bh[i] * 100, drawdownPct: ((sim.equity[i] - peak) / peak) * 100 });
    }
  }

  const lastTs = bars[n - 1].timestamp;
  const upcoming = pivots
    .filter(p => p.status === 'future' || (p.status === 'in' && p.projectedTs > lastTs))
    .slice(0, 12)
    .map(p => ({ type: p.type, projectedTs: p.projectedTs, originalTs: p.originalTs, sourcePrice: p.price }));

  const lastTrade = sim.trades[sim.trades.length - 1];
  const openPosition = lastTrade && lastTrade.exitReason === 'end_of_data'
    ? { direction: lastTrade.direction, entryTs: lastTrade.entryTs, entryPrice: lastTrade.entryPrice, unrealisedPct: lastTrade.returnPct }
    : null;

  const { chartTrades, chartSignals } = toChartTrades(bars, sim.trades);

  onProgress?.(100, 'Done');
  return {
    config: cfg,
    generatedAt: Date.now(),
    meta: {
      ...meta,
      bars: n,
      fromTs: bars[0].timestamp,
      toTs: lastTs,
      pivotsDetected: pivots.length,
      pivotsInRange: inRange.length,
      pivotsTraded: used,
      pivotsSkippedLookahead: skipped,
      pivotsFuture: pivots.filter(p => p.status === 'future').length,
    },
    metrics,
    benchmark: { totalReturnPct: bhStats.totalReturnPct, cagrPct: bhStats.cagrPct, sharpe: bhStats.sharpe, maxDrawdownPct: bhStats.maxDrawdownPct },
    inSample,
    outOfSample,
    splitTs: bars[splitIdx].timestamp,
    trades: sim.trades,
    equityCurve,
    monthly: monthlyReturns(bars, sim.equity),
    timing,
    monteCarlo,
    sweep,
    sweepLRs,
    sweepOffsets,
    upcoming,
    openPosition,
    warnings,
    stopComparison,
    chartTrades,
    chartSignals,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart adapters (reuse the existing buy/sell marker + P&L band renderer)
// ─────────────────────────────────────────────────────────────────────────────

function toChartTrades(bars: CycleBar[], trades: CycleTrade[]): { chartTrades: BacktestTrade[]; chartSignals: BacktestSignal[] } {
  const chartTrades: BacktestTrade[] = trades.map(t => ({
    id: String(t.id),
    direction: t.direction,
    entryTimestamp: t.entryTs,
    exitTimestamp: t.exitTs,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    entrySlotIndex: bars[t.entryIdx].slotIndex,
    exitSlotIndex: bars[t.exitIdx].slotIndex,
    bars: t.bars,
    pnlPct: t.returnPct,
    pnlPoints: t.direction === 'long' ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice,
    equityAfter: t.equityAfter,
    signal: t.direction === 'long' ? 'buy' : 'sell',
    exitReason: t.exitReason === 'time_exit' ? 'signal' : t.exitReason,
  }));

  const seen = new Set<string>();
  const chartSignals: BacktestSignal[] = [];
  const push = (idx: number, type: 'buy' | 'sell', price: number) => {
    const key = `${idx}:${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    chartSignals.push({ slotIndex: bars[idx].slotIndex, timestamp: bars[idx].timestamp, type, price, strategyId: 'overlay_swing_hl' });
  };
  for (const t of trades) {
    push(t.entryIdx, t.direction === 'long' ? 'buy' : 'sell', t.entryPrice);
    if (t.exitReason !== 'end_of_data') push(t.exitIdx, t.direction === 'long' ? 'sell' : 'buy', t.exitPrice);
  }
  return { chartTrades, chartSignals };
}

/** Shape the result as BacktestStats so the chart's trade bands render. */
export function toBacktestStats(r: CycleBacktestResult): BacktestStats {
  const m = r.metrics;
  const bars = r.trades.map(t => t.bars);
  return {
    netProfitPct: m.totalReturnPct,
    netProfitPoints: r.chartTrades.reduce((a, t) => a + t.pnlPoints, 0),
    grossProfitPct: m.avgWinPct * m.wins,
    grossLossPct: m.avgLossPct * m.losses,
    buyHoldReturnPct: r.benchmark.totalReturnPct,
    maxDrawdownPct: m.maxDrawdownPct,
    maxDrawdownBars: 0,
    totalTrades: m.trades,
    winningTrades: m.wins,
    losingTrades: m.losses,
    winRatePct: m.winRatePct,
    avgWinPct: m.avgWinPct,
    avgLossPct: m.avgLossPct,
    profitFactor: m.profitFactor,
    expectancyPct: m.expectancyPct,
    sharpeRatio: m.sharpe,
    sortinoRatio: m.sortino,
    cagrPct: m.cagrPct,
    avgBarsInTrade: Math.round(m.avgBarsHeld),
    maxBarsInTrade: bars.length ? Math.max(...bars) : 0,
    minBarsInTrade: bars.length ? Math.min(...bars) : 0,
    tpExits: r.trades.filter(t => t.exitReason === 'take_profit').length,
    slExits: r.trades.filter(t => t.exitReason === 'stop_loss').length,
    signalExits: r.trades.filter(t => t.exitReason === 'signal' || t.exitReason === 'time_exit').length,
    eodExits: r.trades.filter(t => t.exitReason === 'end_of_data').length,
    trades: r.chartTrades,
    equityCurve: r.equityCurve.map(p => ({ timestamp: p.ts, equity: p.equity })),
  };
}
