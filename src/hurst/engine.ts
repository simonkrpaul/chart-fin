/**
 * Hurst Cycles – engine (pure, no store deps).
 *
 * Given `primarySlots` (candle-per-slot with `.candle` possibly null on gap
 * bars) and a HurstConfig, produce per-cycle CMA, FLD, detrended series,
 * detected past troughs, and next-trough projection window.
 *
 * All computations are BAR-index based, which is why Hurst analysis works
 * on stock charts (5 bars/week) and crypto charts (7 bars/week) alike.
 */
import type { CandleSlot } from '../types';
import type { HurstConfig, HurstCycleBand, HurstCycleOutput, HurstOutput } from './types';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Centered simple moving average of `values` with window = `period`.
 * At index i the window covers [i − h, i + h] where h = floor(period/2).
 * Nulls in the source contribute nothing and shorten the effective window;
 * if fewer than 60% of bars are present in the window, the result is null.
 */
function centeredSMA(values: (number | null)[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period < 2) return out;
  const h = Math.floor(period / 2);
  const minValid = Math.ceil(period * 0.6);

  for (let i = h; i < n - h; i++) {
    let sum = 0, count = 0;
    for (let j = i - h; j <= i + h; j++) {
      const v = values[j];
      if (v !== null) { sum += v; count++; }
    }
    if (count >= minValid) out[i] = sum / count;
  }
  return out;
}

/**
 * FLD (Future Line of Demarcation).
 *
 * Hurst's definition: the median price `(H+L)/2` displaced forward by
 * `period/2` bars. So `fld[i]` is the median at bar `i − period/2`.
 *
 * Price crossing above its FLD is a Hurst buy signal; crossing below is a
 * sell signal. The distance between price and its FLD at the moment of the
 * crossover is (per Millard) the projected price target.
 */
function computeFld(slots: CandleSlot[], period: number): (number | null)[] {
  const n = slots.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period < 2) return out;
  const shift = Math.floor(period / 2);
  for (let i = shift; i < n; i++) {
    const c = slots[i - shift].candle;
    if (c) out[i] = (c.high + c.low) / 2;
  }
  return out;
}

/**
 * Detect trough slot indices in `detrended`.
 *
 * A slot i is a trough if:
 *   – detrended[i] is a local minimum within a symmetric ±h window,
 *     where h = floor(period/2) · (1 − tolerance).
 *   – The previously accepted trough is at least period·(1 − tolerance) bars
 *     behind (so we don't detect spurious dips inside one cycle).
 *
 * Longer-cycle troughs are found this way independently. The Hurst
 * "synchronicity principle" — that troughs align across cycles — is a
 * consequence, not an assumption.
 */
function detectTroughs(
  detrended: (number | null)[],
  period: number,
  tolerance: number,
): number[] {
  const n = detrended.length;
  const half = Math.max(2, Math.floor(period * (1 - tolerance) / 2));
  const minGap = Math.max(2, Math.floor(period * (1 - tolerance)));
  const troughs: number[] = [];

  for (let i = half; i < n - half; i++) {
    const v = detrended[i];
    if (v === null) continue;
    // Must be a local minimum within [i - half, i + half].
    let isMin = true;
    for (let j = i - half; j <= i + half; j++) {
      if (j === i) continue;
      const u = detrended[j];
      if (u !== null && u < v) { isMin = false; break; }
    }
    if (!isMin) continue;
    // Enforce minimum spacing from previous trough.
    if (troughs.length && i - troughs[troughs.length - 1] < minGap) {
      // Replace previous if this one is deeper.
      const prev = troughs[troughs.length - 1];
      const prevV = detrended[prev] ?? Infinity;
      if (v < prevV) troughs[troughs.length - 1] = i;
      continue;
    }
    troughs.push(i);
  }
  return troughs;
}

/**
 * Peak-to-peak amplitude estimate of the detrended series (used for the
 * ± envelope bands around the CMA). Robust against outliers by using the
 * 5th–95th percentile of |detrended|.
 */
function estimateAmplitude(detrended: (number | null)[]): number {
  const abs: number[] = [];
  for (const v of detrended) if (v !== null) abs.push(Math.abs(v));
  if (abs.length === 0) return 0;
  abs.sort((a, b) => a - b);
  const p95 = abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))];
  return p95;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Compute a single cycle's Hurst analysis. */
export function computeHurstCycle(
  slots: CandleSlot[],
  band: HurstCycleBand,
  tolerance: number,
): HurstCycleOutput {
  const closes: (number | null)[] = slots.map(s => s.candle ? s.candle.close : null);
  const cma = centeredSMA(closes, band.periodBars);
  const fld = computeFld(slots, band.periodBars);

  const n = slots.length;
  const detrended: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    const m = cma[i];
    if (c !== null && m !== null) detrended[i] = c - m;
  }

  const amplitude = estimateAmplitude(detrended);
  const troughSlotIndices = detectTroughs(detrended, band.periodBars, tolerance);

  let projection: HurstCycleOutput['projection'] = null;
  if (troughSlotIndices.length) {
    const last = troughSlotIndices[troughSlotIndices.length - 1];
    const lo = last + Math.floor(band.periodBars * (1 - tolerance));
    const hi = last + Math.ceil(band.periodBars * (1 + tolerance));
    projection = { startSlotIndex: lo, endSlotIndex: hi };
  }

  return { cma, fld, detrended, amplitude, troughSlotIndices, projection };
}

/** Compute Hurst analysis for every enabled cycle. */
export function computeHurst(slots: CandleSlot[], config: HurstConfig): HurstOutput {
  const perCycle: Record<string, HurstCycleOutput> = {};
  for (const band of config.cycles) {
    if (!band.enabled) continue;
    if (band.periodBars < 4 || band.periodBars * 2 > slots.length) continue;
    perCycle[band.id] = computeHurstCycle(slots, band, config.tolerance);
  }
  return { perCycle };
}
