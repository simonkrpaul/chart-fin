/**
 * Manual backtest engine – evaluates hand-drawn Long/Short position drawings
 * against candle data with account sizing and exchange (Bybit) fees.
 */
import type { CandleSlot, PositionDrawing } from '../types';

export type SizeMode = 'qty' | 'notional' | 'riskPct';
export type FeeMode = 'percent' | 'points';
export type SameBarRule = 'sl_first' | 'tp_first';

export interface ManualTradeSettings {
  initialCapital: number;
  /** qty = fixed BTC, notional = fixed USD position value, riskPct = % of equity lost at SL (incl. fees) */
  sizeMode: SizeMode;
  sizeValue: number;
  /** Bybit BTCUSDT qty step is 0.001 */
  qtyStep: number;
  leverage: number;
  /** percent = Bybit fee rate × notional on each side; points = fixed round-trip cost in price points */
  feeMode: FeeMode;
  entryFeePct: number;
  exitFeePct: number;
  roundTripPoints: number;
  sameBarRule: SameBarRule;
  /** Default stop distance (price points) for replay Buy/Sell buttons */
  replaySlPoints: number;
  /** Default reward:risk for replay Buy/Sell buttons */
  replayRR: number;
  /** Chart label visibility */
  showUsd: boolean;
  showAcctPct: boolean;
  showBreakeven: boolean;
}

/** Bybit USDT perpetual, non-VIP: taker 0.055%, maker 0.02%. */
export const BYBIT_DEFAULT_SETTINGS: ManualTradeSettings = {
  initialCapital: 1000,
  sizeMode: 'qty',
  sizeValue: 0.01,
  qtyStep: 0.001,
  leverage: 10,
  feeMode: 'percent',
  entryFeePct: 0.055,
  exitFeePct: 0.055,
  roundTripPoints: 32,
  sameBarRule: 'sl_first',
  replaySlPoints: 300,
  replayRR: 2,
  showUsd: true,
  showAcctPct: true,
  showBreakeven: true,
};

export type PositionOutcome = 'tp' | 'sl' | 'closed' | 'open' | 'not_triggered' | 'waiting';

export interface PositionStat {
  id: string;
  direction: 'long' | 'short';
  entryTs: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
  qty: number;
  qtyOverridden: boolean;
  notional: number;
  margin: number;
  marginExceeded: boolean;
  /** Price points needed in favour just to cover fees */
  breakevenPoints: number;
  /** Round-trip fee estimate at entry price */
  estFee: number;
  /** Projected net $ if TP / SL is hit */
  tpNet: number;
  slNet: number;
  outcome: PositionOutcome;
  exitPrice: number | null;
  exitTs: number | null;
  grossPnl: number;
  fees: number;
  netPnl: number;
  /** Net P&L in units of the (fee-inclusive) risk */
  rMultiple: number;
  equityBefore: number;
  equityAfter: number;
}

export interface ManualBacktestSummary {
  trades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  totalFees: number;
  netPnl: number;
  /** Unrealized net P&L of trades still open (marked at the last visible close) */
  openPnl: number;
  openTrades: number;
  finalEquity: number;
  returnPct: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  avgR: number;
  equityCurve: { ts: number; equity: number }[];
}

export function feeFor(entry: number, exit: number, qty: number, s: ManualTradeSettings): number {
  if (s.feeMode === 'points') return qty * s.roundTripPoints;
  return (qty * (entry * s.entryFeePct + exit * s.exitFeePct)) / 100;
}

/** Points the price must move in favour so net P&L is zero. */
export function breakevenPoints(entry: number, isLong: boolean, s: ManualTradeSettings): number {
  if (s.feeMode === 'points') return s.roundTripPoints;
  const a = s.entryFeePct / 100;
  const b = s.exitFeePct / 100;
  const exit = isLong ? (entry * (1 + a)) / (1 - b) : (entry * (1 - a)) / (1 + b);
  return Math.abs(exit - entry);
}

function grossFor(isLong: boolean, entry: number, exit: number, qty: number): number {
  return (isLong ? exit - entry : entry - exit) * qty;
}

function roundQty(q: number, step: number): number {
  if (!(step > 0)) return q;
  return Math.max(step, Math.floor(q / step + 1e-9) * step);
}

export function computeQty(pd: PositionDrawing, equity: number, s: ManualTradeSettings): number {
  if (pd.qty && pd.qty > 0) return pd.qty;
  const entry = pd.entry.price;
  switch (s.sizeMode) {
    case 'qty':
      return s.sizeValue;
    case 'notional':
      return roundQty(s.sizeValue / entry, s.qtyStep);
    case 'riskPct': {
      const riskUsd = (equity * s.sizeValue) / 100;
      const perUnit = Math.abs(entry - pd.slPrice) + feeFor(entry, pd.slPrice, 1, s);
      return perUnit > 0 ? roundQty(riskUsd / perUnit, s.qtyStep) : s.qtyStep;
    }
  }
}

/** First index with timestamp >= ts (slots are sorted ascending). */
export function slotIndexAtOrAfter(slots: CandleSlot[], ts: number): number {
  let lo = 0, hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid].timestamp < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

interface SimResult {
  outcome: PositionOutcome;
  exitPrice: number | null;
  exitTs: number | null;
}

function simulate(pd: PositionDrawing, slots: CandleSlot[], s: ManualTradeSettings, asOfIndex?: number): SimResult {
  const isLong = pd.tool === 'long_position';
  const entry = pd.entry.price;
  const startIdx = slotIndexAtOrAfter(slots, pd.entry.timestamp);
  const span = Math.max(0, pd.end.slotIndex - pd.entry.slotIndex);
  const endIdx = pd.end.timestamp > pd.entry.timestamp
    ? slotIndexAtOrAfter(slots, pd.end.timestamp)
    : startIdx + span;

  // In bar replay, candles after the replay cursor don't exist yet
  let lastCandleIdx = Math.min(slots.length - 1, asOfIndex ?? Infinity);
  while (lastCandleIdx >= 0 && !slots[lastCandleIdx].candle) lastCandleIdx--;
  const stop = Math.min(endIdx, lastCandleIdx);

  // Market orders fill at the entry bar's close, so that bar's range can't hit TP/SL
  let triggered = !!pd.entryAtClose;
  let lastClose: { price: number; ts: number } | null = null;
  for (let i = pd.entryAtClose ? startIdx + 1 : startIdx; i <= stop; i++) {
    const c = slots[i]?.candle;
    if (!c) continue;
    if (!triggered) {
      if (c.low <= entry && c.high >= entry) triggered = true;
      else continue;
    }
    const hitTp = isLong ? c.high >= pd.tpPrice : c.low <= pd.tpPrice;
    const hitSl = isLong ? c.low <= pd.slPrice : c.high >= pd.slPrice;
    if (hitTp && hitSl) {
      return s.sameBarRule === 'tp_first'
        ? { outcome: 'tp', exitPrice: pd.tpPrice, exitTs: c.timestamp }
        : { outcome: 'sl', exitPrice: pd.slPrice, exitTs: c.timestamp };
    }
    if (hitSl) return { outcome: 'sl', exitPrice: pd.slPrice, exitTs: c.timestamp };
    if (hitTp) return { outcome: 'tp', exitPrice: pd.tpPrice, exitTs: c.timestamp };
    lastClose = { price: c.close, ts: c.timestamp };
  }

  const dataEndedInsideBox = endIdx > lastCandleIdx;
  if (!triggered) return { outcome: dataEndedInsideBox ? 'waiting' : 'not_triggered', exitPrice: null, exitTs: null };
  if (dataEndedInsideBox) {
    if (!lastClose) return { outcome: 'open', exitPrice: entry, exitTs: slots[startIdx]?.timestamp ?? null };
    return { outcome: 'open', exitPrice: lastClose.price, exitTs: lastClose.ts };
  }
  return { outcome: 'closed', exitPrice: lastClose?.price ?? entry, exitTs: lastClose?.ts ?? null };
}

const REALIZED: PositionOutcome[] = ['tp', 'sl', 'closed'];

export function runManualBacktest(
  positions: PositionDrawing[],
  slots: CandleSlot[],
  s: ManualTradeSettings,
  asOfIndex?: number,
): { stats: PositionStat[]; summary: ManualBacktestSummary } {
  const sorted = [...positions].sort((a, b) => a.entry.timestamp - b.entry.timestamp);
  const stats: PositionStat[] = [];

  for (const pd of sorted) {
    const isLong = pd.tool === 'long_position';
    const entry = pd.entry.price;
    // Equity at entry = capital + all trades already realized before this entry
    const equityBefore = s.initialCapital + stats
      .filter(t => REALIZED.includes(t.outcome) && t.exitTs !== null && t.exitTs <= pd.entry.timestamp)
      .reduce((sum, t) => sum + t.netPnl, 0);
    const qty = computeQty(pd, equityBefore, s);
    const notional = qty * entry;
    const margin = s.leverage > 0 ? notional / s.leverage : notional;

    const tpNet = grossFor(isLong, entry, pd.tpPrice, qty) - feeFor(entry, pd.tpPrice, qty, s);
    const slNet = grossFor(isLong, entry, pd.slPrice, qty) - feeFor(entry, pd.slPrice, qty, s);

    const sim = slots.length ? simulate(pd, slots, s, asOfIndex) : { outcome: 'waiting' as const, exitPrice: null, exitTs: null };
    let grossPnl = 0, fees = 0;
    if (sim.exitPrice !== null) {
      grossPnl = grossFor(isLong, entry, sim.exitPrice, qty);
      fees = feeFor(entry, sim.exitPrice, qty, s);
    }
    const netPnl = grossPnl - fees;
    const risk = Math.abs(slNet);

    stats.push({
      id: pd.id,
      direction: isLong ? 'long' : 'short',
      entryTs: pd.entry.timestamp,
      entryPrice: entry,
      tpPrice: pd.tpPrice,
      slPrice: pd.slPrice,
      qty,
      qtyOverridden: !!(pd.qty && pd.qty > 0),
      notional,
      margin,
      marginExceeded: margin > equityBefore,
      breakevenPoints: breakevenPoints(entry, isLong, s),
      estFee: feeFor(entry, entry, qty, s),
      tpNet,
      slNet,
      outcome: sim.outcome,
      exitPrice: sim.exitPrice,
      exitTs: sim.exitTs,
      grossPnl,
      fees,
      netPnl,
      rMultiple: risk > 0 ? netPnl / risk : 0,
      equityBefore,
      equityAfter: equityBefore + (REALIZED.includes(sim.outcome) ? netPnl : 0),
    });
  }

  const realized = stats
    .filter(t => REALIZED.includes(t.outcome))
    .sort((a, b) => (a.exitTs ?? 0) - (b.exitTs ?? 0));

  let equity = s.initialCapital, peak = equity, maxDd = 0, maxDdPct = 0;
  const equityCurve = [{ ts: realized[0]?.entryTs ?? 0, equity }];
  for (const t of realized) {
    equity += t.netPnl;
    equityCurve.push({ ts: t.exitTs ?? t.entryTs, equity });
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    if (dd > maxDd) { maxDd = dd; maxDdPct = peak > 0 ? (dd / peak) * 100 : 0; }
  }

  const wins = realized.filter(t => t.netPnl > 0);
  const losses = realized.filter(t => t.netPnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.netPnl, 0));
  const netPnl = equity - s.initialCapital;
  const open = stats.filter(t => t.outcome === 'open');

  return {
    stats,
    summary: {
      trades: stats.length,
      closedTrades: realized.length,
      wins: wins.length,
      losses: losses.length,
      winRate: realized.length ? (wins.length / realized.length) * 100 : 0,
      grossProfit,
      grossLoss,
      totalFees: realized.reduce((a, t) => a + t.fees, 0),
      netPnl,
      openPnl: open.reduce((a, t) => a + t.netPnl, 0),
      openTrades: open.length,
      finalEquity: equity,
      returnPct: s.initialCapital > 0 ? (netPnl / s.initialCapital) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      maxDrawdown: maxDd,
      maxDrawdownPct: maxDdPct,
      avgR: realized.length ? realized.reduce((a, t) => a + t.rMultiple, 0) / realized.length : 0,
      equityCurve,
    },
  };
}
