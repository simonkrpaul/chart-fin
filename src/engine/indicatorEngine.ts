/**
 * Indicator Computation Engine
 *
 * Computes indicator series over CandleSlot arrays.
 * Null candles are treated as gaps – indicators either skip them or
 * carry forward depending on type.
 *
 * Design: all functions are pure and operate on slot arrays so they
 * work identically on primary series, historical overlay series, and
 * projected overlay series.
 */
import type { CandleSlot, IndicatorConfig, IndicatorPoint, IndicatorSeries, SwingPoint, SRZone, SessionZone, WeekendMarker, SignalMarker, TradeMarker, GridDiagonalData, HighLowLevel } from '../types';
import { MOON_BUY_DATES, MOON_SELL_DATES } from './moonSignalData';

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

export function computeIndicator(
  slots: CandleSlot[],
  config: IndicatorConfig,
): IndicatorSeries {
  switch (config.type) {
    case 'SMA':    return sma(slots, config);
    case 'EMA':    return ema(slots, config);
    case 'VOLUME': return volumeSeries(slots, config);
    case 'VWAP':   return vwap(slots, config);
    case 'RSI':    return rsi(slots, config);
    case 'MACD':   return macd(slots, config);
    case 'BBANDS': return bollingerBands(slots, config);
    case 'ATR':    return atr(slots, config);
    case 'SWING_HL': return swingHL(slots, config);
    case 'SUPPORT_RESISTANCE': return supportResistance(slots, config);
    case 'SESSIONS': return sessions(slots, config);
    case 'MOON_SIGNALS': return moonSignals(slots, config);
    case 'DYNAMIC_GRID': return dynamicGrid(slots, config);
    case 'WICK_REVERSAL': return wickReversal(slots, config);
    case 'TRADE_SIGNALS': return tradeSignals(slots, config);
    case 'HIGH_LOW_LEVELS': return highLowLevels(slots, config);
    default:
      return { config, points: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function closes(slots: CandleSlot[]): (number | null)[] {
  return slots.map(s => s.candle?.close ?? null);
}

function point(slot: CandleSlot, value: number | null): IndicatorPoint {
  return { slotIndex: slot.slotIndex, timestamp: slot.timestamp, value };
}

// ─────────────────────────────────────────────────────────────────────────────
// SMA – skip null candles (do not carry forward)
// ─────────────────────────────────────────────────────────────────────────────

function sma(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const period = (config.params.period as number) ?? 20;
  const src = closes(slots);
  const points: IndicatorPoint[] = [];
  let windowVals: number[] = [];
  let windowSlots: number[] = []; // slot indices of the values in window

  for (let i = 0; i < slots.length; i++) {
    const v = src[i];
    if (v !== null) {
      windowVals.push(v);
      windowSlots.push(i);
    }
    // Expire old values beyond period
    while (windowVals.length > period) {
      windowVals.shift();
      windowSlots.shift();
    }
    const val = windowVals.length === period
      ? windowVals.reduce((a, b) => a + b, 0) / period
      : null;
    points.push(point(slots[i], val));
  }

  return { config, points };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMA
// ─────────────────────────────────────────────────────────────────────────────

function ema(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const period = (config.params.period as number) ?? 20;
  const k = 2 / (period + 1);
  const src = closes(slots);
  const points: IndicatorPoint[] = [];
  let prevEma: number | null = null;
  let seedCount = 0;
  let seedSum = 0;

  for (let i = 0; i < slots.length; i++) {
    const v = src[i];
    if (v === null) {
      points.push(point(slots[i], prevEma)); // carry forward across gaps
      continue;
    }
    if (prevEma === null) {
      seedCount++;
      seedSum += v;
      if (seedCount >= period) {
        prevEma = seedSum / period;
      }
      points.push(point(slots[i], prevEma));
    } else {
      prevEma = v * k + prevEma * (1 - k);
      points.push(point(slots[i], prevEma));
    }
  }

  return { config, points };
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume series (for sub-pane)
// ─────────────────────────────────────────────────────────────────────────────

function volumeSeries(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const points: IndicatorPoint[] = slots.map(s =>
    point(s, s.candle?.volume ?? null),
  );
  return { config, points };
}

// ─────────────────────────────────────────────────────────────────────────────
// VWAP – resets at session open each day
// ─────────────────────────────────────────────────────────────────────────────

function vwap(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const points: IndicatorPoint[] = [];
  let cumulativePV = 0;
  let cumulativeV = 0;
  let prevDate = '';

  for (const slot of slots) {
    const c = slot.candle;
    const slotDate = new Date(slot.timestamp).toISOString().slice(0, 10);

    // Reset at new session day
    if (slotDate !== prevDate) {
      cumulativePV = 0;
      cumulativeV = 0;
      prevDate = slotDate;
    }

    if (!c) {
      points.push(point(slot, null));
      continue;
    }

    const typical = (c.high + c.low + c.close) / 3;
    cumulativePV += typical * c.volume;
    cumulativeV += c.volume;
    points.push(point(slot, cumulativeV === 0 ? null : cumulativePV / cumulativeV));
  }

  return { config, points };
}

// ─────────────────────────────────────────────────────────────────────────────
// RSI
// ─────────────────────────────────────────────────────────────────────────────

function rsi(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const period = (config.params.period as number) ?? 14;
  const src = closes(slots);
  const points: IndicatorPoint[] = [];
  let avgGain = 0, avgLoss = 0;
  let prev: number | null = null;
  let count = 0;

  for (let i = 0; i < slots.length; i++) {
    const v = src[i];
    if (v === null) { points.push(point(slots[i], null)); continue; }
    if (prev === null) { prev = v; points.push(point(slots[i], null)); continue; }

    const change = v - prev;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    count++;

    if (count < period) {
      avgGain += gain;
      avgLoss += loss;
      points.push(point(slots[i], null));
    } else if (count === period) {
      avgGain = (avgGain + gain) / period;
      avgLoss = (avgLoss + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      points.push(point(slots[i], 100 - 100 / (1 + rs)));
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      points.push(point(slots[i], 100 - 100 / (1 + rs)));
    }

    prev = v;
  }

  return { config, points };
}

// ─────────────────────────────────────────────────────────────────────────────
// MACD
// ─────────────────────────────────────────────────────────────────────────────

function macd(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const fastPeriod = (config.params.fast as number) ?? 12;
  const slowPeriod = (config.params.slow as number) ?? 26;
  const signalPeriod = (config.params.signal as number) ?? 9;

  const fastEmaConfig: IndicatorConfig = { ...config, id: '__fast', type: 'EMA', params: { period: fastPeriod } };
  const slowEmaConfig: IndicatorConfig = { ...config, id: '__slow', type: 'EMA', params: { period: slowPeriod } };

  const fastSeries = ema(slots, fastEmaConfig);
  const slowSeries = ema(slots, slowEmaConfig);

  // Build macd line = fast - slow
  const macdValues: (number | null)[] = slots.map((_, i) => {
    const f = fastSeries.points[i].value;
    const s = slowSeries.points[i].value;
    return f !== null && s !== null ? f - s : null;
  });

  // Signal line = EMA(macdLine, signalPeriod)
  const syntheticSlots: CandleSlot[] = slots.map((s, i) => ({
    ...s,
    candle: macdValues[i] !== null
      ? { timestamp: s.timestamp, open: macdValues[i]!, high: macdValues[i]!, low: macdValues[i]!, close: macdValues[i]!, volume: 0 }
      : null,
  }));
  const signalConfig: IndicatorConfig = { ...config, id: '__signal', type: 'EMA', params: { period: signalPeriod } };
  const signalSeries = ema(syntheticSlots, signalConfig);

  const points: IndicatorPoint[] = slots.map((s, i) => {
    const macdVal = macdValues[i];
    const signalVal = signalSeries.points[i].value;
    const hist = macdVal !== null && signalVal !== null ? macdVal - signalVal : null;
    return {
      slotIndex: s.slotIndex,
      timestamp: s.timestamp,
      value: macdVal,
      values: { macd: macdVal, signal: signalVal, histogram: hist },
    };
  });

  return { config, points };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bollinger Bands
// ─────────────────────────────────────────────────────────────────────────────

function bollingerBands(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const period = (config.params.period as number) ?? 20;
  const stdDevMult = (config.params.stddev as number) ?? 2;
  const smaSeries = sma(slots, { ...config, id: '__bb_sma', type: 'SMA', params: { period } });
  const src = closes(slots);

  const points: IndicatorPoint[] = slots.map((s, i) => {
    const mid = smaSeries.points[i].value;
    if (mid === null) return { slotIndex: s.slotIndex, timestamp: s.timestamp, value: null };

    // Collect last `period` non-null closes ending at i
    const window: number[] = [];
    for (let j = i; j >= 0 && window.length < period; j--) {
      const v = src[j];
      if (v !== null) window.push(v);
    }
    if (window.length < period) {
      return { slotIndex: s.slotIndex, timestamp: s.timestamp, value: null };
    }
    const variance = window.reduce((acc, v) => acc + (v - mid) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    const upper = mid + stdDevMult * sd;
    const lower = mid - stdDevMult * sd;
    return {
      slotIndex: s.slotIndex, timestamp: s.timestamp, value: mid,
      values: { upper, middle: mid, lower },
    };
  });

  return { config, points };
}

// ─────────────────────────────────────────────────────────────────────────────
// ATR
// ─────────────────────────────────────────────────────────────────────────────

function atr(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const period = (config.params.period as number) ?? 14;
  const points: IndicatorPoint[] = [];
  let prevClose: number | null = null;
  let prevAtr: number | null = null;
  let seedCount = 0;
  let seedSum = 0;

  for (const slot of slots) {
    const c = slot.candle;
    if (!c) { points.push(point(slot, prevAtr)); continue; }

    let tr: number;
    if (prevClose === null) {
      tr = c.high - c.low;
    } else {
      tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    }

    if (prevAtr === null) {
      seedCount++;
      seedSum += tr;
      if (seedCount >= period) {
        prevAtr = seedSum / period;
      }
      points.push(point(slot, prevAtr));
    } else {
      prevAtr = (prevAtr * (period - 1) + tr) / period;
      points.push(point(slot, prevAtr));
    }
    prevClose = c.close;
  }

  return { config, points };
}

// ─────────────────────────────────────────────────────────────────────────────
// SWING_HL – Swing High / Low zigzag connector (mirrors Pine's ta.pivothigh/pivotlow)
//
// Algorithm:
//  1. A pivot high at index i means high[i] is strictly the greatest high in
//     the window [i-lr .. i+lr].
//  2. A pivot low at index i means low[i] is strictly the lowest low in that
//     same window.
//  3. Apply the "dominant swing" rule: two consecutive highs → keep only the
//     higher one; two consecutive lows → keep only the lower one.
// ─────────────────────────────────────────────────────────────────────────────

/** Generic bar-descriptor used by detectSwingPoints so it can work on both
 *  CandleSlot[] (primary chart) and ProjectedCandle[] (offset overlays). */
export interface SwingBar {
  slotIndex: number;
  timestamp: number;
  high: number;
  low: number;
}

/**
 * Detect swing pivot highs/lows on any array of bar descriptors.
 * `leftRight` = look-ahead / look-behind window size (default 5).
 * Returns confirmed swing points with the dominant-swing rule applied.
 */
export function detectSwingPoints(bars: SwingBar[], leftRight: number): SwingPoint[] {
  const lr = Math.max(1, leftRight);
  if (bars.length < lr * 2 + 1) return [];

  type RawPivot = { type: 'high' | 'low'; price: number; slotIndex: number; timestamp: number };
  const raw: RawPivot[] = [];

  for (let i = lr; i < bars.length - lr; i++) {
    const b = bars[i];

    let isPH = true;
    for (let j = i - lr; j <= i + lr; j++) {
      if (j === i) continue;
      if (bars[j].high >= b.high) { isPH = false; break; }
    }
    if (isPH) {
      raw.push({ type: 'high', price: b.high, slotIndex: b.slotIndex, timestamp: b.timestamp });
      continue;
    }

    let isPL = true;
    for (let j = i - lr; j <= i + lr; j++) {
      if (j === i) continue;
      if (bars[j].low <= b.low) { isPL = false; break; }
    }
    if (isPL) {
      raw.push({ type: 'low', price: b.low, slotIndex: b.slotIndex, timestamp: b.timestamp });
    }
  }

  // Dominant-swing merge
  const swingPoints: SwingPoint[] = [];
  for (const p of raw) {
    if (swingPoints.length === 0) {
      swingPoints.push({ slotIndex: p.slotIndex, timestamp: p.timestamp, price: p.price, type: p.type });
      continue;
    }
    const last = swingPoints[swingPoints.length - 1];
    if (last.type === p.type) {
      if ((p.type === 'high' && p.price > last.price) ||
          (p.type === 'low'  && p.price < last.price)) {
        swingPoints[swingPoints.length - 1] = {
          slotIndex: p.slotIndex, timestamp: p.timestamp, price: p.price, type: p.type,
        };
      }
    } else {
      swingPoints.push({ slotIndex: p.slotIndex, timestamp: p.timestamp, price: p.price, type: p.type });
    }
  }

  return swingPoints;
}

function swingHL(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const lr = Math.max(1, Number(config.params.leftRight ?? 5));
  const filled = slots.filter(s => s.candle !== null);
  if (filled.length < lr * 2 + 1) return { config, points: [], swingPoints: [] };

  const bars: SwingBar[] = filled.map(s => ({
    slotIndex: s.slotIndex,
    timestamp: s.timestamp,
    high: s.candle!.high,
    low: s.candle!.low,
  }));

  return { config, points: [], swingPoints: detectSwingPoints(bars, lr) };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT_RESISTANCE – pivot-cluster zones (TradingView-style)
//
// Algorithm (mirrors Pine Script by @ebecihalil):
//  1. Compute 14-period ATR for clustering threshold.
//  2. Find pivot highs and pivot lows using `pivotStrength` look-left/right.
//  3. Only scan the last `backBars` bars.
//  4. Cluster nearby pivots: if adding a pivot keeps the zone span ≤ ATR,
//     merge it. Otherwise start a new cluster.
//  5. Emit zones that have ≥ `minTouches` confirming pivots.
//  6. Color each zone based on the last bar's close relative to the zone:
//     above → support (green side=1), below → resistance (side=-1), inside → neutral (side=0).
// ─────────────────────────────────────────────────────────────────────────────

function supportResistance(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const backBars      = (config.params.backBars as number)      ?? 300;
  const pivotStrength = (config.params.pivotStrength as number) ?? 10;
  const minTouches    = (config.params.minTouches as number)    ?? 2;

  const filled = slots.filter(s => s.candle !== null);
  if (filled.length < pivotStrength * 2 + 1) {
    return { config, points: [], srZones: [] };
  }

  // ── 1. Compute ATR(14) on all filled bars ──────────────────────────────
  const atrPeriod = 14;
  let atrVal = 0;
  {
    let prevClose: number | null = null;
    let seedSum = 0;
    let seedCount = 0;
    let runningAtr: number | null = null;
    for (const s of filled) {
      const c = s.candle!;
      let tr: number;
      if (prevClose === null) {
        tr = c.high - c.low;
      } else {
        tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      }
      if (runningAtr === null) {
        seedCount++;
        seedSum += tr;
        if (seedCount >= atrPeriod) runningAtr = seedSum / atrPeriod;
      } else {
        runningAtr = (runningAtr * (atrPeriod - 1) + tr) / atrPeriod;
      }
      prevClose = c.close;
    }
    atrVal = runningAtr ?? (seedSum / Math.max(1, seedCount));
  }
  const threshold = atrVal * 1.0;

  // ── 2. Restrict to last `backBars` filled bars ─────────────────────────
  const startIdx = Math.max(0, filled.length - backBars);
  const recentBars = filled.slice(startIdx);

  // ── 3. Detect pivot highs and pivot lows ───────────────────────────────
  const ps = pivotStrength;
  type Pivot = { price: number; slotIndex: number };
  const pivots: Pivot[] = [];

  for (let i = ps; i < recentBars.length - ps; i++) {
    const bar = recentBars[i];
    const h = bar.candle!.high;
    const l = bar.candle!.low;

    // Pivot high check
    let isPH = true;
    for (let j = i - ps; j <= i + ps; j++) {
      if (j === i) continue;
      if (recentBars[j].candle!.high >= h) { isPH = false; break; }
    }
    if (isPH) pivots.push({ price: h, slotIndex: bar.slotIndex });

    // Pivot low check
    let isPL = true;
    for (let j = i - ps; j <= i + ps; j++) {
      if (j === i) continue;
      if (recentBars[j].candle!.low <= l) { isPL = false; break; }
    }
    if (isPL) pivots.push({ price: l, slotIndex: bar.slotIndex });
  }

  // ── 4. Cluster pivots into zones (Pine Script logic) ──────────────────
  interface Cluster {
    anchor: number;
    top: number;
    bottom: number;
    leftSlotIndex: number;
    count: number;
  }
  const clusters: Cluster[] = [];

  for (const pv of pivots) {
    let foundMatch = false;

    for (const cl of clusters) {
      const potentialTop = Math.max(cl.top, pv.price);
      const potentialBot = Math.min(cl.bottom, pv.price);

      if (potentialTop - potentialBot <= threshold) {
        foundMatch = true;
        cl.count++;
        cl.top = potentialTop;
        cl.bottom = potentialBot;
        break;
      }
    }

    if (!foundMatch) {
      clusters.push({
        anchor: pv.price,
        top: pv.price,
        bottom: pv.price,
        leftSlotIndex: pv.slotIndex,
        count: 1,
      });
    }
  }

  // ── 5. Filter by minTouches and determine side state ───────────────────
  const lastBar = filled[filled.length - 1];
  const lastClose = lastBar?.candle?.close ?? 0;

  const srZones: SRZone[] = clusters
    .filter(cl => cl.count >= minTouches)
    .map(cl => {
      let side: 1 | -1 | 0;
      if (lastClose > cl.top) side = 1;       // above = support
      else if (lastClose < cl.bottom) side = -1; // below = resistance
      else side = 0;                             // inside
      return {
        top: cl.top,
        bottom: cl.bottom,
        touches: cl.count,
        leftBarSlotIndex: cl.leftSlotIndex,
        side,
      };
    });

  return { config, points: [], srZones };
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSIONS – Marks trading sessions (New York, London, Tokyo, Sydney) with
// colored range boxes showing session high/low, similar to LuxAlgo Sessions.
//
// Each session is defined by a UTC start/end hour pair. When a bar's UTC time
// falls within the window, it belongs to that session. The indicator outputs
// SessionZone[] containing the start/end slot indices plus high/low.
// ─────────────────────────────────────────────────────────────────────────────

/** Default session definitions (UTC hours) */
const DEFAULT_SESSIONS: { name: string; startHour: number; endHour: number; color: string }[] = [
  { name: 'New York', startHour: 13, endHour: 22, color: '#ff5d00' },
  { name: 'London',   startHour: 7,  endHour: 16, color: '#2157f3' },
  { name: 'Tokyo',    startHour: 0,  endHour: 9,  color: '#e91e63' },
  { name: 'Sydney',   startHour: 21, endHour: 6,  color: '#ffeb3b' },
];

function sessions(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const showNY     = (config.params.showNY as boolean) ?? true;
  const showLondon = (config.params.showLondon as boolean) ?? true;
  const showTokyo  = (config.params.showTokyo as boolean) ?? true;
  const showSydney = (config.params.showSydney as boolean) ?? true;

  const activeSessions = DEFAULT_SESSIONS.filter((s, i) => {
    if (i === 0) return showNY;
    if (i === 1) return showLondon;
    if (i === 2) return showTokyo;
    if (i === 3) return showSydney;
    return true;
  });

  const sessionZones: SessionZone[] = [];

  for (const sesDef of activeSessions) {
    const { name, startHour, endHour, color } = sesDef;
    const wrapsOverMidnight = endHour <= startHour; // e.g. Sydney 21:00-06:00

    // Track the current open session instance
    let currentZone: { startSlotIndex: number; endSlotIndex: number; high: number; low: number } | null = null;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot.candle) continue;

      const d = new Date(slot.timestamp);
      const utcHour = d.getUTCHours();
      const utcMin = d.getUTCMinutes();
      const timeDecimal = utcHour + utcMin / 60;

      let inSession: boolean;
      if (wrapsOverMidnight) {
        inSession = timeDecimal >= startHour || timeDecimal < endHour;
      } else {
        inSession = timeDecimal >= startHour && timeDecimal < endHour;
      }

      if (inSession) {
        if (currentZone === null) {
          // Start a new session instance
          currentZone = {
            startSlotIndex: slot.slotIndex,
            endSlotIndex: slot.slotIndex,
            high: slot.candle.high,
            low: slot.candle.low,
          };
        } else {
          // Extend current session
          currentZone.endSlotIndex = slot.slotIndex;
          if (slot.candle.high > currentZone.high) currentZone.high = slot.candle.high;
          if (slot.candle.low < currentZone.low) currentZone.low = slot.candle.low;
        }
      } else {
        // Bar is outside session – close current zone if open
        if (currentZone !== null) {
          sessionZones.push({ name, color, ...currentZone });
          currentZone = null;
        }
      }
    }

    // Close any trailing open session
    if (currentZone !== null) {
      sessionZones.push({ name, color, ...currentZone });
    }
  }

  // ── Detect day-of-week boundaries ──────────────────────────────────────
  const weekendMarkers: WeekendMarker[] = [];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let prevDayOfWeek = -1;

  for (const slot of slots) {
    if (!slot.candle) continue;
    const d = new Date(slot.timestamp);
    const dow = d.getUTCDay(); // 0=Sunday, 6=Saturday

    if (dow !== prevDayOfWeek) {
      weekendMarkers.push({
        slotIndex: slot.slotIndex,
        label: DAYS[dow],
      });
      prevDayOfWeek = dow;
    }
  }

  return { config, points: [], sessionZones, weekendMarkers };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOON_SIGNALS – Buy/Sell markers from Moon-Ketu/Rahu conjunction dates
// ─────────────────────────────────────────────────────────────────────────────

function moonSignals(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const markers: SignalMarker[] = [];

  if (slots.length === 0) return { config, points: [], signalMarkers: markers };

  // Convert date arrays into Sets for O(1) lookup by date string
  const buySet = new Set(MOON_BUY_DATES.map(ts => dateKey(ts)));
  const sellSet = new Set(MOON_SELL_DATES.map(ts => dateKey(ts)));

  // Track which signal dates have already been marked (first candle only)
  const buyUsed = new Set<string>();
  const sellUsed = new Set<string>();

  // Last known price for future projections
  let lastPrice = 0;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (slots[i].candle) { lastPrice = slots[i].candle!.close; break; }
  }

  // Average slot interval for future projection
  const avgInterval = slots.length > 1
    ? (slots[slots.length - 1].timestamp - slots[0].timestamp) / (slots.length - 1)
    : 86400000;
  const lastSlotTs = slots[slots.length - 1].timestamp;
  const lastSlotIdx = slots[slots.length - 1].slotIndex;

  // Mark existing candle data
  for (const slot of slots) {
    if (!slot.candle) continue;
    lastPrice = slot.candle.close;
    const key = dateKey(slot.timestamp);

    if (buySet.has(key) && !buyUsed.has(key)) {
      buyUsed.add(key);
      markers.push({
        slotIndex: slot.slotIndex,
        timestamp: slot.timestamp,
        price: slot.candle.low,
        type: 'buy',
      });
    }
    if (sellSet.has(key) && !sellUsed.has(key)) {
      sellUsed.add(key);
      markers.push({
        slotIndex: slot.slotIndex,
        timestamp: slot.timestamp,
        price: slot.candle.high,
        type: 'sell',
      });
    }
  }

  // Project future dates that don't have candle data yet
  const allFutureBuys = MOON_BUY_DATES.filter(ts => ts > lastSlotTs && !buyUsed.has(dateKey(ts)));
  const allFutureSells = MOON_SELL_DATES.filter(ts => ts > lastSlotTs && !sellUsed.has(dateKey(ts)));

  for (const ts of allFutureBuys) {
    const futureSlotIdx = lastSlotIdx + Math.round((ts - lastSlotTs) / avgInterval);
    markers.push({
      slotIndex: futureSlotIdx,
      timestamp: ts,
      price: lastPrice,
      type: 'buy',
    });
  }

  for (const ts of allFutureSells) {
    const futureSlotIdx = lastSlotIdx + Math.round((ts - lastSlotTs) / avgInterval);
    markers.push({
      slotIndex: futureSlotIdx,
      timestamp: ts,
      price: lastPrice,
      type: 'sell',
    });
  }

  return { config, points: [], signalMarkers: markers };
}

/** Convert a UTC timestamp to a YYYY-MM-DD key for date comparison */
function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC_GRID – horizontal lines at multiples of interval from 0,
// vertical lines at two configurable dates, diagonal lines connecting
// consecutive levels between the two dates.
// ─────────────────────────────────────────────────────────────────────────────

function dynamicGrid(_slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const interval = (config.params.interval as number) ?? 1618;
  const numLines = (config.params.numLines as number) ?? 5;
  const date1 = (config.params.date1 as number) ?? Date.UTC(2026, 3, 13); // Apr 13 2026
  const date2 = (config.params.date2 as number) ?? Date.UTC(2027, 3, 13); // Apr 13 2027

  const gridData: GridDiagonalData = { date1, date2, interval, numLines };
  return { config, points: [], gridData };
}

// ─────────────────────────────────────────────────────────────────────────────
// WICK_REVERSAL – identifies candles with abnormally long wicks relative to
// their total range, which often signal reversals.
//
// Logic:
//   upperWickRatio = (high - max(open,close)) / (high - low)
//   lowerWickRatio = (min(open,close) - low) / (high - low)
//
//   If lowerWickRatio >= threshold → bullish reversal (buy marker below candle)
//   If upperWickRatio >= threshold → bearish reversal (sell marker above candle)
//
// Params:
//   wickRatio       – minimum wick % of total range (default 60 = 60%)
//   minAtrMultiple  – candle range must be >= N × ATR(14) to filter dojis (default 1)
// ─────────────────────────────────────────────────────────────────────────────

function wickReversal(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const markers: SignalMarker[] = [];
  const threshold = ((config.params.wickRatio as number) ?? 60) / 100;
  const minAtrMult = (config.params.minAtrMultiple as number) ?? 1;
  const atrPeriod = 14;

  if (slots.length === 0) return { config, points: [], signalMarkers: markers };

  // Compute ATR for filtering
  const trueRanges: number[] = [];
  let prevClose: number | null = null;
  for (const slot of slots) {
    if (!slot.candle) { trueRanges.push(0); continue; }
    const c = slot.candle;
    if (prevClose === null) {
      trueRanges.push(c.high - c.low);
    } else {
      trueRanges.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
    }
    prevClose = c.close;
  }

  // Running ATR (simple moving average of TR)
  const atr: number[] = new Array(slots.length).fill(0);
  let trSum = 0;
  for (let i = 0; i < slots.length; i++) {
    trSum += trueRanges[i];
    if (i >= atrPeriod) trSum -= trueRanges[i - atrPeriod];
    const count = Math.min(i + 1, atrPeriod);
    atr[i] = trSum / count;
  }

  for (let i = atrPeriod; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot.candle) continue;
    const c = slot.candle;
    const range = c.high - c.low;
    if (range <= 0) continue;

    // Filter: candle range must be meaningful (>= minAtrMult × ATR)
    if (range < minAtrMult * atr[i]) continue;

    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;

    const upperRatio = upperWick / range;
    const lowerRatio = lowerWick / range;
    const bodyRatio = body / range;

    // Pin bar detection: small body + long wick + tiny opposite wick
    const pinBodyMax = 0.33;   // body < 1/3 of range
    const pinWickMin = 0.60;   // main wick >= 60% of range
    const pinOppMax  = 0.10;   // opposite wick < 10% of range

    // Bullish pin bar: long lower wick, body near top, tiny upper wick
    if (bodyRatio <= pinBodyMax && lowerRatio >= pinWickMin && upperRatio <= pinOppMax) {
      markers.push({
        slotIndex: slot.slotIndex,
        timestamp: slot.timestamp,
        price: c.low,
        type: 'buy',
        label: 'PIN',
      });
      continue; // pin bar takes priority over generic wick
    }

    // Bearish pin bar: long upper wick, body near bottom, tiny lower wick
    if (bodyRatio <= pinBodyMax && upperRatio >= pinWickMin && lowerRatio <= pinOppMax) {
      markers.push({
        slotIndex: slot.slotIndex,
        timestamp: slot.timestamp,
        price: c.high,
        type: 'sell',
        label: 'PIN',
      });
      continue;
    }

    // Long lower wick → bullish reversal
    if (lowerRatio >= threshold) {
      markers.push({
        slotIndex: slot.slotIndex,
        timestamp: slot.timestamp,
        price: c.low,
        type: 'buy',
        label: 'W',
      });
    }

    // Long upper wick → bearish reversal
    if (upperRatio >= threshold) {
      markers.push({
        slotIndex: slot.slotIndex,
        timestamp: slot.timestamp,
        price: c.high,
        type: 'sell',
        label: 'W',
      });
    }
  }

  return { config, points: [], signalMarkers: markers };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADE_SIGNALS – generates Long/Short trade markers using configurable
// strategies. Displays entry/exit arrows with PnL labels like TradingView.
//
// Strategy: 'tokyo_reversal' (default)
//   - Look at the 30 minutes before Tokyo open (23:30–00:00 UTC)
//   - If pre-session is UP → SHORT at 00:00 UTC, exit after holdMinutes
//   - If pre-session is DOWN → LONG at 00:00 UTC, exit after holdMinutes
//
// Params:
//   preMinutes     – lookback window in minutes (default 30)
//   holdMinutes    – how long to hold after entry (default 35)
//   minMovePct     – minimum pre-session move % to trigger (default 0.01)
// ─────────────────────────────────────────────────────────────────────────────

function tradeSignals(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const tradeMarkers: TradeMarker[] = [];

  if (slots.length === 0) return { config, points: [], tradeMarkers };

  const preMinutes = (config.params.preMinutes as number) ?? 30;
  const holdMinutes = (config.params.holdMinutes as number) ?? 35;
  const minMovePct = (config.params.minMovePct as number) ?? 0.01;

  // Group slots by day and find Tokyo session opens (00:00 UTC)
  const processedDays = new Set<string>();

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot.candle) continue;

    const dt = new Date(slot.timestamp);
    const hour = dt.getUTCHours();
    const minute = dt.getUTCMinutes();

    // Only trigger at 00:00 UTC (Tokyo open)
    if (hour !== 0 || minute !== 0) continue;

    const dayKey = `${dt.getUTCFullYear()}-${dt.getUTCMonth()}-${dt.getUTCDate()}`;
    if (processedDays.has(dayKey)) continue;
    processedDays.add(dayKey);

    // Find pre-session candles (previous preMinutes before 00:00 UTC)
    const preStartMs = slot.timestamp - preMinutes * 60_000;
    const preEndMs = slot.timestamp - 60_000;

    let preOpen: number | null = null;
    let preClose: number | null = null;
    let preCount = 0;

    for (let j = Math.max(0, i - preMinutes - 5); j < i; j++) {
      const ps = slots[j];
      if (!ps.candle) continue;
      if (ps.timestamp >= preStartMs && ps.timestamp <= preEndMs) {
        if (preOpen === null) preOpen = ps.candle.open;
        preClose = ps.candle.close;
        preCount++;
      }
    }

    if (preOpen === null || preClose === null || preCount < preMinutes * 0.8) continue;

    const preMovePct = ((preClose - preOpen) / preOpen) * 100;
    if (Math.abs(preMovePct) < minMovePct) continue;

    // Entry at Tokyo open
    const entryPrice = slot.candle.open;
    const entrySlotIndex = slot.slotIndex;

    // Find exit candle (holdMinutes later)
    const exitMs = slot.timestamp + holdMinutes * 60_000;
    let exitPrice: number | null = null;
    let exitSlotIndex: number | null = null;

    for (let j = i + 1; j < Math.min(slots.length, i + holdMinutes + 5); j++) {
      const es = slots[j];
      if (!es.candle) continue;
      if (es.timestamp >= exitMs) {
        exitPrice = es.candle.close;
        exitSlotIndex = es.slotIndex;
        break;
      }
    }

    if (exitPrice === null) {
      for (let j = Math.min(slots.length - 1, i + holdMinutes + 5); j > i; j--) {
        const es = slots[j];
        if (!es.candle) continue;
        if (es.timestamp <= exitMs + 60_000) {
          exitPrice = es.candle.close;
          exitSlotIndex = es.slotIndex;
          break;
        }
      }
    }

    if (exitPrice === null || exitSlotIndex === null) continue;

    const direction: 'long' | 'short' = preMovePct > 0 ? 'short' : 'long';
    const pnlPct = direction === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

    tradeMarkers.push({
      entrySlotIndex,
      exitSlotIndex,
      entryPrice,
      exitPrice,
      direction,
      pnlPct,
      win: pnlPct > 0,
    });
  }

  return { config, points: [], tradeMarkers };
}

// ─────────────────────────────────────────────────────────────────────────────
// HIGH_LOW_LEVELS – marks high & low for daily, weekly, monthly, and session
// periods with horizontal lines spanning only the period they belong to.
//
// Params:
//   showDaily    – mark daily high/low (default true)
//   showWeekly   – mark weekly high/low (default true)
//   showMonthly  – mark monthly high/low (default true)
//   showSession  – mark session high/low (default true)
//   dailyColor   – color for daily lines (default '#2196f3')
//   weeklyColor  – color for weekly lines (default '#ff9800')
//   monthlyColor – color for monthly lines (default '#9c27b0')
//   sessionColor – color for session lines (default '#e91e63')
// ─────────────────────────────────────────────────────────────────────────────

function highLowLevels(slots: CandleSlot[], config: IndicatorConfig): IndicatorSeries {
  const levels: HighLowLevel[] = [];
  if (slots.length === 0) return { config, points: [], highLowLevels: levels };

  const showDaily = (config.params.showDaily as boolean) ?? true;
  const showWeekly = (config.params.showWeekly as boolean) ?? true;
  const showMonthly = (config.params.showMonthly as boolean) ?? true;
  const showSession = (config.params.showSession as boolean) ?? true;
  const dailyColor = (config.params.dailyColor as string) || '#2196f3';
  const weeklyColor = (config.params.weeklyColor as string) || '#ff9800';
  const monthlyColor = (config.params.monthlyColor as string) || '#9c27b0';
  const sessionColor = (config.params.sessionColor as string) || '#e91e63';

  function flushPeriod(
    startIdx: number, endIdx: number,
    high: number, low: number,
    period: 'daily' | 'weekly' | 'monthly' | 'session',
    color: string,
    label?: string,
  ) {
    levels.push({ startSlotIndex: startIdx, endSlotIndex: endIdx, price: high, type: 'high', period, color, label: label ? `${label} H` : undefined });
    levels.push({ startSlotIndex: startIdx, endSlotIndex: endIdx, price: low, type: 'low', period, color, label: label ? `${label} L` : undefined });
  }

  // ── DAILY HIGH/LOW ─────────────────────────────────────────────────────
  if (showDaily) {
    let dayKey = '';
    let dayStart = 0;
    let dayEnd = 0;
    let dayHigh = -Infinity;
    let dayLow = Infinity;

    for (const slot of slots) {
      if (!slot.candle) continue;
      const d = new Date(slot.timestamp);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      if (key !== dayKey) {
        if (dayKey && dayHigh !== -Infinity) {
          flushPeriod(dayStart, dayEnd, dayHigh, dayLow, 'daily', dailyColor, 'D');
        }
        dayKey = key;
        dayStart = slot.slotIndex;
        dayHigh = slot.candle.high;
        dayLow = slot.candle.low;
      }
      dayEnd = slot.slotIndex;
      if (slot.candle.high > dayHigh) dayHigh = slot.candle.high;
      if (slot.candle.low < dayLow) dayLow = slot.candle.low;
    }
    if (dayKey && dayHigh !== -Infinity) {
      flushPeriod(dayStart, dayEnd, dayHigh, dayLow, 'daily', dailyColor, 'D');
    }
  }

  // ── WEEKLY HIGH/LOW (Mon 00:00 UTC – Sun 23:59:59 UTC) ────────────────
  if (showWeekly) {
    let weekKey = '';
    let weekStart = 0;
    let weekEnd = 0;
    let weekHigh = -Infinity;
    let weekLow = Infinity;

    for (const slot of slots) {
      if (!slot.candle) continue;
      const d = new Date(slot.timestamp);
      // Compute Monday-based week: shift so Monday=0, compute week start timestamp
      const dow = d.getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
      const mondayOffset = dow === 0 ? 6 : dow - 1; // days since Monday
      const mondayTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayOffset);
      const key = `${mondayTs}`;
      if (key !== weekKey) {
        if (weekKey && weekHigh !== -Infinity) {
          flushPeriod(weekStart, weekEnd, weekHigh, weekLow, 'weekly', weeklyColor, 'W');
        }
        weekKey = key;
        weekStart = slot.slotIndex;
        weekHigh = slot.candle.high;
        weekLow = slot.candle.low;
      }
      weekEnd = slot.slotIndex;
      if (slot.candle.high > weekHigh) weekHigh = slot.candle.high;
      if (slot.candle.low < weekLow) weekLow = slot.candle.low;
    }
    if (weekKey && weekHigh !== -Infinity) {
      flushPeriod(weekStart, weekEnd, weekHigh, weekLow, 'weekly', weeklyColor, 'W');
    }
  }

  // ── MONTHLY HIGH/LOW ───────────────────────────────────────────────────
  if (showMonthly) {
    let monthKey = '';
    let monthStart = 0;
    let monthEnd = 0;
    let monthHigh = -Infinity;
    let monthLow = Infinity;

    for (const slot of slots) {
      if (!slot.candle) continue;
      const d = new Date(slot.timestamp);
      const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      if (key !== monthKey) {
        if (monthKey && monthHigh !== -Infinity) {
          flushPeriod(monthStart, monthEnd, monthHigh, monthLow, 'monthly', monthlyColor, 'M');
        }
        monthKey = key;
        monthStart = slot.slotIndex;
        monthHigh = slot.candle.high;
        monthLow = slot.candle.low;
      }
      monthEnd = slot.slotIndex;
      if (slot.candle.high > monthHigh) monthHigh = slot.candle.high;
      if (slot.candle.low < monthLow) monthLow = slot.candle.low;
    }
    if (monthKey && monthHigh !== -Infinity) {
      flushPeriod(monthStart, monthEnd, monthHigh, monthLow, 'monthly', monthlyColor, 'M');
    }
  }

  // ── SESSION HIGH/LOW (Tokyo, London, New York, Sydney) ─────────────────
  if (showSession) {
    const SESSION_DEFS = [
      { name: 'Tokyo',    startHour: 0,  endHour: 9 },
      { name: 'London',   startHour: 7,  endHour: 16 },
      { name: 'New York', startHour: 13, endHour: 22 },
      { name: 'Sydney',   startHour: 21, endHour: 6 },
    ];

    for (const ses of SESSION_DEFS) {
      const wraps = ses.endHour <= ses.startHour;
      let sesStart = -1;
      let sesEnd = -1;
      let sesHigh = -Infinity;
      let sesLow = Infinity;

      for (const slot of slots) {
        if (!slot.candle) continue;
        const d = new Date(slot.timestamp);
        const h = d.getUTCHours() + d.getUTCMinutes() / 60;

        let inSession: boolean;
        if (wraps) {
          inSession = h >= ses.startHour || h < ses.endHour;
        } else {
          inSession = h >= ses.startHour && h < ses.endHour;
        }

        if (inSession) {
          if (sesStart === -1) sesStart = slot.slotIndex;
          sesEnd = slot.slotIndex;
          if (slot.candle.high > sesHigh) sesHigh = slot.candle.high;
          if (slot.candle.low < sesLow) sesLow = slot.candle.low;
        } else {
          if (sesStart !== -1 && sesHigh !== -Infinity) {
            flushPeriod(sesStart, sesEnd, sesHigh, sesLow, 'session', sessionColor, ses.name);
            sesStart = -1;
            sesHigh = -Infinity;
            sesLow = Infinity;
          }
        }
      }
      if (sesStart !== -1 && sesHigh !== -Infinity) {
        flushPeriod(sesStart, sesEnd, sesHigh, sesLow, 'session', sessionColor, ses.name);
      }
    }
  }

  return { config, points: [], highLowLevels: levels };
}
