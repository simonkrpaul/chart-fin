/**
 * Backtesting Engine
 *
 * Architecture
 * ────────────
 * Each strategy is a pure function that receives a price series and emits a
 * sequence of { bar, signal: 'buy' | 'sell' | 'hold' } objects.  The engine
 * then executes those signals against the raw OHLCV data, tracking entries,
 * exits, commissions and equity, and finally computes TradingView-equivalent
 * performance statistics.
 *
 * Supported strategies
 * ────────────────────
 *   ema_crossover    – fast EMA crosses above/below slow EMA
 *   sma_crossover    – same with SMA
 *   ema_price_cross  – close crosses above/below a single EMA
 *   rsi_ob_os        – RSI exits overbought (sell) / oversold (buy)
 *   macd_signal_cross– MACD line crosses above/below signal line
 *
 * How to add a new strategy
 * ─────────────────────────
 * 1. Add its id to `BacktestStrategyId` in types/index.ts.
 * 2. Write a function `myStrategy(closes, params): SignalRow[]`.
 * 3. Register it in `generateSignals()` switch below.
 * That's it — the rest of the engine handles execution and stats.
 */

import type {
  CandleSlot,
  BacktestConfig,
  BacktestStats,
  BacktestTrade,
  BacktestSignal,
  BacktestStrategyId,
  BacktestStrategyParams,
  TradeExitReason,
  SwingPoint,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Low-level indicator helpers (standalone so the engine has zero deps)
// ─────────────────────────────────────────────────────────────────────────────

function computeEma(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    count++;
    if (count < period) { out[i] = null; continue; }
    if (count === period) { prev = sum / period; out[i] = prev; continue; }
    prev = values[i] * k + prev! * (1 - k);
    out[i] = prev;
  }
  return out;
}

function computeSma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  const win: number[] = [];
  for (let i = 0; i < values.length; i++) {
    win.push(values[i]);
    sum += values[i];
    if (win.length > period) { sum -= win.shift()!; }
    out[i] = win.length === period ? sum / period : null;
  }
  return out;
}

function computeRsi(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  // Seed with first `period` changes
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  const rsi0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  out[period] = rsi0;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
}

function computeMacd(
  values: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MacdResult {
  const fast = computeEma(values, fastPeriod);
  const slow = computeEma(values, slowPeriod);
  const macdLine: (number | null)[] = values.map((_, i) => {
    if (fast[i] == null || slow[i] == null) return null;
    return fast[i]! - slow[i]!;
  });
  // Signal = EMA of MACD line (skip nulls for seed)
  const macdValues = macdLine.map(v => v ?? 0);
  const rawSignal = computeEma(macdValues, signalPeriod);
  // Mask out values where we didn't have enough macd data
  const firstMacd = macdLine.findIndex(v => v != null);
  const signal: (number | null)[] = rawSignal.map((v, i) => (i < firstMacd ? null : v));
  return { macd: macdLine, signal };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal-row type used internally
// ─────────────────────────────────────────────────────────────────────────────

type SignalRow = 'buy' | 'sell' | 'hold';

// ─────────────────────────────────────────────────────────────────────────────
// Strategy implementations
// ─────────────────────────────────────────────────────────────────────────────

function stratEmaCrossover(closes: number[], params: BacktestStrategyParams): SignalRow[] {
  const fast = computeEma(closes, params.fastPeriod ?? 9);
  const slow = computeEma(closes, params.slowPeriod ?? 21);
  return closes.map((_, i) => {
    if (i === 0 || fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) return 'hold';
    if (fast[i - 1]! <= slow[i - 1]! && fast[i]! > slow[i]!) return 'buy';
    if (fast[i - 1]! >= slow[i - 1]! && fast[i]! < slow[i]!) return 'sell';
    return 'hold';
  });
}

function stratSmaCrossover(closes: number[], params: BacktestStrategyParams): SignalRow[] {
  const fast = computeSma(closes, params.fastPeriod ?? 10);
  const slow = computeSma(closes, params.slowPeriod ?? 30);
  return closes.map((_, i) => {
    if (i === 0 || fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) return 'hold';
    if (fast[i - 1]! <= slow[i - 1]! && fast[i]! > slow[i]!) return 'buy';
    if (fast[i - 1]! >= slow[i - 1]! && fast[i]! < slow[i]!) return 'sell';
    return 'hold';
  });
}

function stratEmaPriceCross(closes: number[], params: BacktestStrategyParams): SignalRow[] {
  const ema = computeEma(closes, params.period ?? 20);
  return closes.map((c, i) => {
    if (i === 0 || ema[i] == null || ema[i - 1] == null) return 'hold';
    if (closes[i - 1] <= ema[i - 1]! && c > ema[i]!) return 'buy';
    if (closes[i - 1] >= ema[i - 1]! && c < ema[i]!) return 'sell';
    return 'hold';
  });
}

function stratRsiObOs(closes: number[], params: BacktestStrategyParams): SignalRow[] {
  const rsiVals = computeRsi(closes, params.rsiPeriod ?? 14);
  const ob = params.overbought ?? 70;
  const os = params.oversold ?? 30;
  return closes.map((_, i) => {
    if (i === 0 || rsiVals[i] == null || rsiVals[i - 1] == null) return 'hold';
    // Buy when RSI crosses back above oversold from below
    if (rsiVals[i - 1]! < os && rsiVals[i]! >= os) return 'buy';
    // Sell when RSI crosses back below overbought from above
    if (rsiVals[i - 1]! > ob && rsiVals[i]! <= ob) return 'sell';
    return 'hold';
  });
}

function stratMacdSignalCross(closes: number[], params: BacktestStrategyParams): SignalRow[] {
  const { macd, signal } = computeMacd(
    closes,
    params.fastEma ?? 12,
    params.slowEma ?? 26,
    params.signalPeriod ?? 9,
  );
  return closes.map((_, i) => {
    if (i === 0 || macd[i] == null || signal[i] == null || macd[i - 1] == null || signal[i - 1] == null) return 'hold';
    if (macd[i - 1]! <= signal[i - 1]! && macd[i]! > signal[i]!) return 'buy';
    if (macd[i - 1]! >= signal[i - 1]! && macd[i]! < signal[i]!) return 'sell';
    return 'hold';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Overlay Swing HL strategy  (with optional close-confirmation filter)
 * ─────────────────────────────────────────────────────────────────────
 * A) requireCloseConfirm = TRUE (default)
 *   SETUP  – a swing Low/High projected bar is detected.  No signal yet.
 *   TRIGGER– the first subsequent bar whose close breaks above the swing
 *            High (for BUY) or below the swing Low (for SELL) fires the
 *            entry signal at that bar's close price.
 *   EXIT   – handled by executeTrades: when the OPPOSITE swing bar is
 *            reached while in a position, exit immediately at bar close.
 *
 * B) requireCloseConfirm = FALSE
 *   Signal fires immediately on the swing bar itself (BUY at swing Low,
 *   SELL at swing High).  Exits are handled the same way in executeTrades.
 *
 * swingPoints are indexed by `slotIndex` (matches filledSlots[i].slotIndex).
 */
function stratOverlaySwingHL(
  filledSlots: CandleSlot[],
  swingPoints: SwingPoint[],
  requireCloseConfirm: boolean,
): SignalRow[] {
  // Build a lookup: slotIndex → pivot candle details
  const lookup = new Map<number, { type: 'high' | 'low'; price: number }>();
  for (const sp of swingPoints) {
    if (!lookup.has(sp.slotIndex)) lookup.set(sp.slotIndex, { type: sp.type, price: sp.price });
  }

  if (!requireCloseConfirm) {
    // Immediate mode: signal fires right on the pivot bar
    return filledSlots.map(slot => {
      const entry = lookup.get(slot.slotIndex);
      if (entry?.type === 'low')  return 'buy';
      if (entry?.type === 'high') return 'sell';
      return 'hold';
    });
  }

  // ── Confirmed-close mode ─────────────────────────────────────────────────
  const signals: SignalRow[] = new Array(filledSlots.length).fill('hold');
  // Pending setup: direction we're waiting to confirm + the level to beat
  let pending: { direction: 'buy' | 'sell'; confirmLevel: number } | null = null;

  for (let i = 0; i < filledSlots.length; i++) {
    const slot  = filledSlots[i];
    const c     = slot.candle!;
    const entry = lookup.get(slot.slotIndex);

    if (entry) {
      // Swing Low  → BUY when close breaks above the pivot HIGH of this candle
      // Swing High → SELL when close breaks below the pivot LOW of this candle
      if (entry.type === 'low') {
        pending = { direction: 'buy',  confirmLevel: c.high };
      } else {
        pending = { direction: 'sell', confirmLevel: c.low  };
      }
      // The pivot bar itself does NOT generate a signal.
      // (Exit of existing position is handled by executeTrades' swing-exit.)
      continue;
    }

    if (pending) {
      if (pending.direction === 'buy'  && c.close > pending.confirmLevel) {
        signals[i] = 'buy';
        pending = null;
      } else if (pending.direction === 'sell' && c.close < pending.confirmLevel) {
        signals[i] = 'sell';
        pending = null;
      }
    }
  }

  return signals;
}

/**
 * NY 10am Breakout Strategy
 * ─────────────────────────────
 * Identifies the candle at NY 10am (configurable UTC hour) and trades
 * the breakout or close direction within the NY session.
 *
 * Modes:
 *   'breakout'  – after the 10am candle closes, buy/sell on break of its high/low
 *   'color'     – green 10am candle → long, red 10am candle → short
 *
 * Exit: end of NY session (configurable) OR take-profit %.
 * Close-back stop: if enabled, exit when price closes back through the entry candle's open.
 */
function stratNy10amBreakout(
  slots: CandleSlot[],
  params: BacktestStrategyParams,
): SignalRow[] {
  const mode = params.ny10amMode ?? 'breakout';
  const entryHourUTC = params.nyEntryHourUTC ?? 14; // 10am ET = 14 UTC (EDT)
  const sessionEndHourUTC = params.nySessionEndHourUTC ?? 20; // 4pm ET = 20 UTC
  const closeBack = params.ny10amCloseBack !== false; // default ON

  const signals: SignalRow[] = new Array(slots.length).fill('hold');

  // State machine per trading day
  let refCandle: { high: number; low: number; close: number; open: number } | null = null;
  let inTrade: 'long' | 'short' | null = null;
  let tradedToday = false; // only one trade per day
  let currentDay = -1;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot.candle) continue;
    const candle = slot.candle;
    const d = new Date(slot.timestamp);
    const hourUTC = d.getUTCHours();
    const dayOfYear = Math.floor(slot.timestamp / 86400000); // rough day identifier

    // New day → reset state
    if (dayOfYear !== currentDay) {
      // Close any lingering position from previous day
      if (inTrade) {
        signals[i] = inTrade === 'long' ? 'sell' : 'buy';
        inTrade = null;
      }
      refCandle = null;
      tradedToday = false;
      currentDay = dayOfYear;
    }

    // Session end → force exit
    if (inTrade && hourUTC >= sessionEndHourUTC) {
      signals[i] = inTrade === 'long' ? 'sell' : 'buy';
      inTrade = null;
      refCandle = null;
      tradedToday = true; // don't re-enter same day
      continue;
    }

    // Close-back stop: exit when candle closes back through the reference candle's open
    if (closeBack && inTrade && refCandle) {
      if (inTrade === 'long' && candle.close < refCandle.open) {
        signals[i] = 'sell';
        inTrade = null;
        tradedToday = true;
        continue;
      } else if (inTrade === 'short' && candle.close > refCandle.open) {
        signals[i] = 'buy';
        inTrade = null;
        tradedToday = true;
        continue;
      }
    }

    // Already traded or in a trade today — skip entry logic
    if (tradedToday || inTrade) continue;

    // Identify the entry-hour candle (first candle at entryHourUTC)
    if (!refCandle && hourUTC === entryHourUTC) {
      refCandle = { high: candle.high, low: candle.low, close: candle.close, open: candle.open };

      // In 'color' mode, enter immediately based on candle color
      if (mode === 'color') {
        if (candle.close > candle.open) {
          signals[i] = 'buy';
          inTrade = 'long';
        } else if (candle.close < candle.open) {
          signals[i] = 'sell';
          inTrade = 'short';
        }
        // doji → no trade today
      }
      continue;
    }

    // In 'breakout' mode, wait for close beyond reference candle's H/L
    if (refCandle && mode === 'breakout') {
      if (candle.close > refCandle.high) {
        signals[i] = 'buy';
        inTrade = 'long';
      } else if (candle.close < refCandle.low) {
        signals[i] = 'sell';
        inTrade = 'short';
      }
    }
  }

  return signals;
}

function generateSignals(
  closes: number[],
  strategyId: BacktestStrategyId,
  params: BacktestStrategyParams,
  extraData?: { filledSlots?: CandleSlot[]; swingPoints?: SwingPoint[] },
): SignalRow[] {
  switch (strategyId) {
    case 'ema_crossover':    return stratEmaCrossover(closes, params);
    case 'sma_crossover':    return stratSmaCrossover(closes, params);
    case 'ema_price_cross':  return stratEmaPriceCross(closes, params);
    case 'rsi_ob_os':        return stratRsiObOs(closes, params);
    case 'macd_signal_cross':return stratMacdSignalCross(closes, params);
    case 'overlay_swing_hl': {
      const slots   = extraData?.filledSlots ?? [];
      const sp      = extraData?.swingPoints  ?? [];
      const confirm = params.requireCloseConfirm !== false; // default true
      if (slots.length === 0 || sp.length === 0) return closes.map(() => 'hold');
      return stratOverlaySwingHL(slots, sp, confirm);
    }
    case 'overlay_swing_close': {
      const slots = extraData?.filledSlots ?? [];
      const sp    = extraData?.swingPoints  ?? [];
      if (slots.length === 0 || sp.length === 0) return closes.map(() => 'hold');
      return stratOverlaySwingClose(slots, sp);
    }
    case 'ny_10am_breakout': {
      const slots = extraData?.filledSlots ?? [];
      if (slots.length === 0) return closes.map(() => 'hold');
      return stratNy10amBreakout(slots, params);
    }
    default:                 return closes.map(() => 'hold');
  }
}

/**
 * Overlay Swing Close strategy
 * ─────────────────────────────
 * EVERY swing point (high or low) acts as a reference level:
 *   • First bar whose close > swing price  → BUY  at that close.
 *   • First bar whose close < swing price  → SELL at that close.
 *
 * Stop-loss is baked in (always active): the stop level = swing price used
 * for entry. A long exits on close < stop level; short exits on close > stop.
 * Exit at opposite swing point is handled by executeTrades' swing-exit logic.
 */
function stratOverlaySwingClose(
  filledSlots: CandleSlot[],
  swingPoints: SwingPoint[],
): SignalRow[] {
  // Map each pivot slotIndex → its pivot price
  const lookup = new Map<number, number>();
  for (const sp of swingPoints) {
    if (!lookup.has(sp.slotIndex)) lookup.set(sp.slotIndex, sp.price);
  }

  const signals: SignalRow[] = new Array(filledSlots.length).fill('hold');
  let watchLevel: number | null = null;

  for (let i = 0; i < filledSlots.length; i++) {
    const slot       = filledSlots[i];
    const c          = slot.candle!;
    const swingPrice = lookup.get(slot.slotIndex);

    if (swingPrice !== undefined) {
      // New pivot bar: update watch level, no entry on this bar.
      watchLevel = swingPrice;
      continue;
    }

    if (watchLevel !== null) {
      if (c.close > watchLevel) {
        signals[i] = 'buy';
        watchLevel = null; // consumed — next entry requires a new swing point
      } else if (c.close < watchLevel) {
        signals[i] = 'sell';
        watchLevel = null; // consumed — next entry requires a new swing point
      }
    }
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade execution
// ─────────────────────────────────────────────────────────────────────────────

interface OpenPosition {
  direction: 'long' | 'short';
  entryPrice: number;
  entryTimestamp: number;
  entrySlotIndex: number;
  entryBarIndex: number; // index into filledSlots
  swingStopLevel?: number; // price level: long stopped when close < this; short when close > this
}

function executeTrades(
  filledSlots: CandleSlot[],
  signals: SignalRow[],
  config: BacktestConfig,
  extraData?: { swingPoints?: SwingPoint[] },
): { trades: BacktestTrade[]; backtestSignals: BacktestSignal[] } {
  const trades: BacktestTrade[] = [];
  const backtestSignals: BacktestSignal[] = [];
  const comm        = config.commissionPct / 100;
  // ny_10am_breakout: use strategy param ny10amTpPct as effective TP if top-level TP not set
  const rawTp       = config.strategyId === 'ny_10am_breakout' && !config.takeProfitPct
                      ? (config.params.ny10amTpPct ?? 0) : (config.takeProfitPct ?? 0);
  const tp          = rawTp / 100; // 0 = disabled
  const sl          = (config.stopLossPct   ?? 0) / 100; // 0 = disabled
  const slDelay     = config.slDelayBars    ?? 0;         // bars before SL activates
  const dir         = config.tradeDirection ?? 'both';
  const canLong     = dir === 'both' || dir === 'long_only';
  const canShort    = dir === 'both' || dir === 'short_only';
  let equity = 100;
  let open: OpenPosition | null = null;
  let tradeIdCounter = 1;

  // Build swing-point lookup maps for immediate exit at pivot bars.
  // A swing HIGH bar exits an open LONG; a swing LOW bar exits an open SHORT.
  // These are only populated for the overlay_swing_hl strategy.
  const swingHighBars = new Set<number>();
  const swingLowBars  = new Set<number>();
  // Also keep an ordered array for O(n) look-back to find nearest swing stop level
  const swingsBySlot: { slotIndex: number; type: 'high' | 'low'; price: number }[] = [];
  if (extraData?.swingPoints?.length) {
    for (const sp of extraData.swingPoints) {
      if (sp.type === 'high') swingHighBars.add(sp.slotIndex);
      else                    swingLowBars.add(sp.slotIndex);
      swingsBySlot.push({ slotIndex: sp.slotIndex, type: sp.type, price: sp.price });
    }
    swingsBySlot.sort((a, b) => a.slotIndex - b.slotIndex);
  }

  const useSwingStop = !!(config.strategyId === 'overlay_swing_hl' && config.params?.swingStopLoss)
    || config.strategyId === 'overlay_swing_close'; // always on, stop = the entry swing level

  /** Find the price of the most recent swing of given type at or before slotIndex */
  function lastSwingPrice(slotIndex: number, type: 'high' | 'low'): number | undefined {
    for (let k = swingsBySlot.length - 1; k >= 0; k--) {
      const s = swingsBySlot[k];
      if (s.slotIndex <= slotIndex && s.type === type) return s.price;
    }
    return undefined;
  }

  /** Most recent swing of ANY type at or before slotIndex (used by overlay_swing_close) */
  function lastSwingPriceAny(slotIndex: number): number | undefined {
    for (let k = swingsBySlot.length - 1; k >= 0; k--) {
      if (swingsBySlot[k].slotIndex <= slotIndex) return swingsBySlot[k].price;
    }
    return undefined;
  }

  /** Shared helper: record a closed trade and reset `open`. */
  function closePosition(
    exitPrice: number,
    exitTs: number,
    exitSlotIndex: number,
    barIndex: number,
    reason: TradeExitReason,
  ) {
    if (!open) return;
    const raw =
      open.direction === 'long'
        ? (exitPrice - open.entryPrice) / open.entryPrice
        : (open.entryPrice - exitPrice) / open.entryPrice;
    const pnlPct    = (raw - 2 * comm) * 100;
    const pnlPoints = exitPrice - open.entryPrice;
    const bars      = barIndex - open.entryBarIndex;
    equity += equity * (pnlPct / 100);
    trades.push({
      id: String(tradeIdCounter++),
      direction:      open.direction,
      entryTimestamp: open.entryTimestamp,
      exitTimestamp:  exitTs,
      entryPrice:     open.entryPrice,
      exitPrice,
      entrySlotIndex: open.entrySlotIndex,
      exitSlotIndex:  exitSlotIndex,
      bars,
      pnlPct,
      pnlPoints,
      equityAfter: equity,
      signal: open.direction === 'long' ? 'sell' : 'buy',
      exitReason: reason,
    });
    open = null;
  }

  for (let i = 0; i < filledSlots.length; i++) {
    const slot   = filledSlots[i];
    const candle = slot.candle!;
    const sig    = signals[i];

    // ── Swing exit: immediately close opposite position at pivot bar ──────
    let swingExitFired = false;
    if (open) {
      const isSwingHigh = swingHighBars.has(slot.slotIndex);
      const isSwingLow  = swingLowBars.has(slot.slotIndex);

      if (config.strategyId === 'overlay_swing_close' && (isSwingHigh || isSwingLow)) {
        // overlay_swing_close: exit at the VERY NEXT swing of ANY type.
        // Entry fires on close crossing ANY pivot level; the ZigZag alternates
        // H→L→H, so the next pivot after entry is whichever type appears first.
        const exitSig = open.direction === 'long' ? 'sell' : 'buy';
        closePosition(candle.close, slot.timestamp, slot.slotIndex, i, 'signal');
        if (sig !== exitSig) {
          backtestSignals.push({ slotIndex: slot.slotIndex, timestamp: slot.timestamp, type: exitSig, price: candle.close, strategyId: config.strategyId });
        }
        swingExitFired = true;
      } else if (isSwingHigh && open.direction === 'long') {
        // Exit long at swing high
        closePosition(candle.close, slot.timestamp, slot.slotIndex, i, 'signal');
        if (sig !== 'sell') {
          backtestSignals.push({ slotIndex: slot.slotIndex, timestamp: slot.timestamp, type: 'sell', price: candle.close, strategyId: config.strategyId });
        }
        swingExitFired = true;
      } else if (isSwingLow && open.direction === 'short') {
        // Exit short at swing low
        closePosition(candle.close, slot.timestamp, slot.slotIndex, i, 'signal');
        if (sig !== 'buy') {
          backtestSignals.push({ slotIndex: slot.slotIndex, timestamp: slot.timestamp, type: 'buy', price: candle.close, strategyId: config.strategyId });
        }
        swingExitFired = true;
      }
    }

    if (sig === 'buy' || sig === 'sell') {
      backtestSignals.push({
        slotIndex:   slot.slotIndex,
        timestamp:   slot.timestamp,
        type:        sig,
        price:       candle.close,
        strategyId:  config.strategyId,
      });
    }

    // ── Check TP / SL on the current bar BEFORE checking the signal ──
    // We use intra-bar high/low so TP/SL are evaluated at realistic prices.
    // Priority: stop-loss is checked first (more conservative).
    // slDelay: SL is only active after the trade has been open for ≥ slDelay bars.
    if (open) {
      const entry       = open.entryPrice;
      const barsHeld    = i - open.entryBarIndex;
      const slActive    = sl > 0 && barsHeld >= slDelay;

      if (open.direction === 'long') {
        const slPrice = slActive ? entry * (1 - sl) : null;
        const tpPrice = tp > 0  ? entry * (1 + tp) : null;

        // Swing close-based stop: close back below the pivot low that set up the trade
        if (useSwingStop && open.swingStopLevel !== undefined && candle.close < open.swingStopLevel) {
          closePosition(candle.close, slot.timestamp, slot.slotIndex, i, 'stop_loss');
        // SL hit: candle low reached the stop price
        } else if (slPrice !== null && candle.low <= slPrice) {
          closePosition(slPrice, slot.timestamp, slot.slotIndex, i, 'stop_loss');
        // TP hit: candle high reached the target price
        } else if (tpPrice !== null && candle.high >= tpPrice) {
          closePosition(tpPrice, slot.timestamp, slot.slotIndex, i, 'take_profit');
        }
      } else {
        // Short position: SL above entry, TP below entry
        const slPrice = slActive ? entry * (1 + sl) : null;
        const tpPrice = tp > 0  ? entry * (1 - tp) : null;

        // Swing close-based stop: close back above the pivot high that set up the trade
        if (useSwingStop && open.swingStopLevel !== undefined && candle.close > open.swingStopLevel) {
          closePosition(candle.close, slot.timestamp, slot.slotIndex, i, 'stop_loss');
        } else if (slPrice !== null && candle.high >= slPrice) {
          closePosition(slPrice, slot.timestamp, slot.slotIndex, i, 'stop_loss');
        } else if (tpPrice !== null && candle.low <= tpPrice) {
          closePosition(tpPrice, slot.timestamp, slot.slotIndex, i, 'take_profit');
        }
      }
    }

    // ── Close on opposite strategy signal (if still open after TP/SL check) ──
    // When holdForTpSl is true and TP or SL is configured, signal exits are
    // suppressed — the position waits for the TP/SL price level instead.
    // Also skip if a swing exit already closed the position this bar.
    // For overlay_swing_close, NEVER close on opposite signal — the strategy
    // continuously updates watchLevel on each swing, which causes false opposite
    // signals mid-trade. Exits are exclusively via swing exit or swing stop.
    const holdForTpSl = config.holdForTpSl && (tp > 0 || sl > 0);
    const isSwingCloseStrategy = config.strategyId === 'overlay_swing_close';
    const isNy10am = config.strategyId === 'ny_10am_breakout';
    // ny_10am_breakout: always honour signal exits (session end + close-back stop)
    if (open && (!holdForTpSl || isNy10am) && !swingExitFired && !isSwingCloseStrategy) {
      const shouldClose =
        (open.direction === 'long'  && sig === 'sell') ||
        (open.direction === 'short' && sig === 'buy');
      if (shouldClose) {
        // NY 10am uses candle.close for session-end/close-back exits (exit on THIS bar)
        const exitPrice = isNy10am ? candle.close : candle.open;
        closePosition(exitPrice, slot.timestamp, slot.slotIndex, i, 'signal');
      }
    }

    // ── Open new position ──
    // tradeDirection gates which signals can open a trade.
    // For ny_10am_breakout, don't re-open on a bar that just closed a position (exit signals aren't entries)
    const canOpenLong  = sig === 'buy'  && canLong;
    const canOpenShort = sig === 'sell' && canShort;
    const justClosed = !open && trades.length > 0 && trades[trades.length - 1].exitSlotIndex === slot.slotIndex;
    if (!open && (canOpenLong || canOpenShort) && !(isNy10am && justClosed)) {
      const direction = sig === 'buy' ? 'long' : 'short';
      let swingStopLevel: number | undefined;
      if (config.strategyId === 'overlay_swing_close') {
        // Stop = the exact swing price that was the watch level (most recent swing before entry)
        swingStopLevel = lastSwingPriceAny(slot.slotIndex);
      } else if (useSwingStop) {
        swingStopLevel = direction === 'long'
          ? lastSwingPrice(slot.slotIndex, 'low')
          : lastSwingPrice(slot.slotIndex, 'high');
      }
      open = {
        direction,
        entryPrice:       candle.close,
        entryTimestamp:   slot.timestamp,
        entrySlotIndex:   slot.slotIndex,
        entryBarIndex:    i,
        swingStopLevel,
      };
    }
  }

  // Close any open position at end of data
  if (open && filledSlots.length > 0) {
    const last = filledSlots[filledSlots.length - 1];
    closePosition(last.candle!.close, last.timestamp, last.slotIndex, filledSlots.length - 1, 'end_of_data');
  }

  return { trades, backtestSignals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats computation
// ─────────────────────────────────────────────────────────────────────────────

function computeStats(
  trades: BacktestTrade[],
  filledSlots: CandleSlot[],
): Omit<BacktestStats, 'trades' | 'equityCurve'> {
  if (trades.length === 0) {
    return {
      netProfitPct: 0, netProfitPoints: 0,
      grossProfitPct: 0, grossLossPct: 0,
      buyHoldReturnPct: 0,
      maxDrawdownPct: 0, maxDrawdownBars: 0,
      totalTrades: 0, winningTrades: 0, losingTrades: 0,
      winRatePct: 0, avgWinPct: 0, avgLossPct: 0,
      profitFactor: 0, expectancyPct: 0,
      sharpeRatio: 0, sortinoRatio: 0, cagrPct: null,
      avgBarsInTrade: 0, maxBarsInTrade: 0, minBarsInTrade: 0,
      tpExits: 0, slExits: 0, signalExits: 0, eodExits: 0,
    };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pnlPct), 0);
  const netProfitPct = trades[trades.length - 1].equityAfter - 100;
  const netProfitPoints = trades.reduce((s, t) => s + t.pnlPoints, 0);

  // Buy-and-hold return
  const firstClose = filledSlots[0]?.candle?.close ?? 1;
  const lastClose = filledSlots[filledSlots.length - 1]?.candle?.close ?? 1;
  const buyHoldReturnPct = ((lastClose - firstClose) / firstClose) * 100;

  // Drawdown: track equity peak
  let peak = 100;
  let maxDd = 0;
  let ddStartBar = 0;
  let maxDdBars = 0;
  let ddActive = false;
  let ddStartBarIdx = 0;
  let eq = 100;
  for (let i = 0; i < trades.length; i++) {
    eq = trades[i].equityAfter;
    if (eq > peak) {
      if (ddActive) {
        maxDdBars = Math.max(maxDdBars, trades[i].exitSlotIndex - ddStartBar);
        ddActive = false;
      }
      peak = eq;
    } else {
      const dd = ((peak - eq) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
      if (!ddActive) { ddActive = true; ddStartBar = trades[i].entrySlotIndex; ddStartBarIdx = i; }
    }
  }
  if (ddActive) {
    maxDdBars = Math.max(maxDdBars, trades[trades.length - 1].exitSlotIndex - ddStartBar);
  }

  // Per-trade returns for Sharpe/Sortino
  const returns = trades.map(t => t.pnlPct / 100);
  const n = returns.length;
  const meanR = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, r) => a + (r - meanR) ** 2, 0) / n;
  const stdR = Math.sqrt(variance);
  const downsideVariance = returns.reduce((a, r) => a + (r < 0 ? r ** 2 : 0), 0) / n;
  const downsideStd = Math.sqrt(downsideVariance);

  const sharpeRatio = stdR === 0 ? 0 : meanR / stdR;
  const sortinoRatio = downsideStd === 0 ? 0 : meanR / downsideStd;

  // CAGR: rough approximation using bar count
  const totalBars = filledSlots.length;
  const barsPerYear = 252 * 78; // 5m bars in a year of regular sessions (approx)
  const years = totalBars / barsPerYear;
  const finalEquity = trades[trades.length - 1].equityAfter;
  const cagrPct = years > 0 ? ((Math.pow(finalEquity / 100, 1 / years) - 1) * 100) : null;

  const barCounts = trades.map(t => t.bars);

  const tpExits     = trades.filter(t => t.exitReason === 'take_profit').length;
  const slExits     = trades.filter(t => t.exitReason === 'stop_loss').length;
  const signalExits = trades.filter(t => t.exitReason === 'signal').length;
  const eodExits    = trades.filter(t => t.exitReason === 'end_of_data').length;

  return {
    netProfitPct,
    netProfitPoints,
    grossProfitPct: grossProfit,
    grossLossPct: grossLoss,
    buyHoldReturnPct,
    maxDrawdownPct: maxDd,
    maxDrawdownBars: maxDdBars,
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRatePct: (wins.length / trades.length) * 100,
    avgWinPct: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLossPct: losses.length > 0 ? grossLoss / losses.length : 0,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    expectancyPct:
      wins.length > 0 && losses.length > 0
        ? (wins.length / trades.length) * (grossProfit / wins.length) -
          (losses.length / trades.length) * (grossLoss / losses.length)
        : 0,
    sharpeRatio,
    sortinoRatio,
    cagrPct,
    avgBarsInTrade: Math.round(barCounts.reduce((a, b) => a + b, 0) / barCounts.length),
    maxBarsInTrade: Math.max(...barCounts),
    minBarsInTrade: Math.min(...barCounts),
    tpExits,
    slExits,
    signalExits,
    eodExits,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface BacktestRunResult {
  stats: BacktestStats;
  signals: BacktestSignal[];
}

/**
 * Run a backtest on the given slot array.
 *
 * Only filled (trading) slots with actual candles are sent through the
 * strategy; the slot indices on signals and trades reference the original
 * primarySlots array so the renderer can place arrows correctly.
 */
export function runBacktest(
  slots: CandleSlot[],
  config: BacktestConfig,
  extraData?: { swingPoints?: SwingPoint[] },
): BacktestRunResult {
  // Filter to candle-bearing slots only
  const filled = slots.filter(s => s.candle !== null);
  if (filled.length < 2) {
    const empty: BacktestStats = {
      netProfitPct: 0, netProfitPoints: 0,
      grossProfitPct: 0, grossLossPct: 0,
      buyHoldReturnPct: 0,
      maxDrawdownPct: 0, maxDrawdownBars: 0,
      totalTrades: 0, winningTrades: 0, losingTrades: 0,
      winRatePct: 0, avgWinPct: 0, avgLossPct: 0,
      profitFactor: 0, expectancyPct: 0,
      sharpeRatio: 0, sortinoRatio: 0, cagrPct: null,
      avgBarsInTrade: 0, maxBarsInTrade: 0, minBarsInTrade: 0,
      trades: [], equityCurve: [],
    };
    return { stats: empty, signals: [] };
  }

  const closes = filled.map(s => s.candle!.close);
  const rawSignals = generateSignals(closes, config.strategyId, config.params, {
    filledSlots: filled,
    swingPoints: extraData?.swingPoints,
  });
  const { trades, backtestSignals } = executeTrades(filled, rawSignals, config, extraData?.swingPoints ? { swingPoints: extraData.swingPoints } : undefined);

  const partialStats = computeStats(trades, filled);

  // Build equity curve
  const equityCurve: BacktestStats['equityCurve'] = [{ timestamp: filled[0].timestamp, equity: 100 }];
  for (const t of trades) {
    equityCurve.push({ timestamp: t.exitTimestamp, equity: t.equityAfter });
  }

  const stats: BacktestStats = { ...partialStats, trades, equityCurve };
  return { stats, signals: backtestSignals };
}

/**
 * Default configuration for each strategy — reasonable starting params
 * shown in the BacktestPanel picker.
 */
export const STRATEGY_DEFAULTS: Record<BacktestStrategyId, { label: string; params: BacktestStrategyParams }> = {
  ema_crossover:        { label: 'EMA Crossover',           params: { fastPeriod: 9,  slowPeriod: 21 } },
  sma_crossover:        { label: 'SMA Crossover',           params: { fastPeriod: 10, slowPeriod: 30 } },
  ema_price_cross:      { label: 'Price × EMA',             params: { period: 20 } },
  rsi_ob_os:            { label: 'RSI Overbought/Oversold', params: { rsiPeriod: 14, overbought: 70, oversold: 30 } },
  macd_signal_cross:    { label: 'MACD Signal Cross',       params: { fastEma: 12, slowEma: 26, signalPeriod: 9 } },
  overlay_swing_hl:     { label: 'Overlay Swing H/L',       params: { overlayId: '', swingHLLeftRight: 5 } },
  overlay_swing_close:  { label: 'Overlay Swing Close',     params: { overlayId: '', swingHLLeftRight: 5 } },
  ny_10am_breakout:     { label: 'NY 10am Breakout',        params: { ny10amMode: 'breakout', ny10amTpPct: 1, nyEntryHourUTC: 14, nySessionEndHourUTC: 20, ny10amCloseBack: true } },
};
