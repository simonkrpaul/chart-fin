/**
 * Correlation Engine
 *
 * Computes Pearson correlation coefficient between an offset overlay's
 * projected candles and the primary series over overlapping slot indices.
 * Supports two modes: returns-based and swing-point-based.
 */
import type { CandleSlot, ProjectedCandle, RawCandle } from '../types';
import { detectSwingPoints } from './indicatorEngine';
import type { SwingBar } from './indicatorEngine';

export interface CorrelationResult {
  /** Pearson r in range [-1, 1] */
  r: number;
  /** Number of overlapping data points used */
  n: number;
}

export interface ScanResult {
  offsetDays: number;
  r: number;
  n: number;
}

export type ScanMode = 'returns' | 'swing';

export interface ScanOutput {
  positive: ScanResult[];
  negative: ScanResult[];
}

/**
 * Extract % moves between consecutive swing points.
 * Returns an array of signed percent changes: positive = up swing, negative = down swing.
 */
function swingMoves(candles: RawCandle[], leftRight: number): number[] {
  const bars: SwingBar[] = candles.map((c, i) => ({
    slotIndex: i,
    timestamp: c.timestamp,
    high: c.high,
    low: c.low,
  }));

  const swings = detectSwingPoints(bars, leftRight);
  if (swings.length < 3) return [];

  const moves: number[] = [];
  for (let i = 1; i < swings.length; i++) {
    const prev = swings[i - 1].price;
    if (prev === 0) continue;
    moves.push((swings[i].price - prev) / prev);
  }
  return moves;
}

/**
 * Scan offsets from `minDays..maxDays` to find the best-correlating historical
 * period.
 *
 * @param mode - 'returns' for close-to-close returns, 'swing' for swing-point % moves
 * @param swingLR - Left/Right bars for swing detection (used when mode='swing')
 * @param minDays - Lowest offset to try (default 1)
 */
export function scanBestCorrelation(
  rawCandles: RawCandle[],
  anchorMs: number,
  windowMs: number,
  maxDays: number,
  stepDays = 1,
  topN = 10,
  onProgress?: (pct: number) => void,
  mode: ScanMode = 'returns',
  swingLR = 5,
  minDays = 1,
): ScanOutput {
  const dayMs = 24 * 60 * 60 * 1000;

  // Extract "current window" candles: from (anchorMs - windowMs) to anchorMs
  const currentCandles = rawCandles.filter(
    c => c.timestamp >= anchorMs - windowMs && c.timestamp <= anchorMs,
  );

  if (currentCandles.length < 10) return { positive: [], negative: [] };

  // Compute current series based on mode
  let currentSeries: number[];
  if (mode === 'swing') {
    currentSeries = swingMoves(currentCandles, swingLR);
  } else {
    currentSeries = [];
    for (let i = 1; i < currentCandles.length; i++) {
      if (currentCandles[i - 1].close === 0) continue;
      currentSeries.push(
        (currentCandles[i].close - currentCandles[i - 1].close) / currentCandles[i - 1].close,
      );
    }
  }

  if (currentSeries.length < 3) return { positive: [], negative: [] };

  const results: ScanResult[] = [];
  const startStep = Math.max(1, Math.floor(minDays / stepDays));
  const endStep   = Math.floor(maxDays / stepDays);
  const totalSteps = Math.max(1, endStep - startStep + 1);

  for (let step = startStep; step <= endStep; step++) {
    const offsetDays = step * stepDays;
    const shiftMs = offsetDays * dayMs;

    // Historical window: same duration, shifted back by offset
    const histStart = anchorMs - windowMs - shiftMs;
    const histEnd = anchorMs - shiftMs;

    const histCandles = rawCandles.filter(
      c => c.timestamp >= histStart && c.timestamp <= histEnd,
    );

    if (histCandles.length < 10) continue;

    // Compute historical series based on mode
    let histSeries: number[];
    if (mode === 'swing') {
      histSeries = swingMoves(histCandles, swingLR);
    } else {
      histSeries = [];
      for (let i = 1; i < histCandles.length; i++) {
        if (histCandles[i - 1].close === 0) continue;
        histSeries.push(
          (histCandles[i].close - histCandles[i - 1].close) / histCandles[i - 1].close,
        );
      }
    }

    // Align lengths (take min length from both)
    const len = Math.min(currentSeries.length, histSeries.length);
    if (len < 3) continue;

    const r = pearson(currentSeries.slice(0, len), histSeries.slice(0, len));
    results.push({ offsetDays, r, n: len });

    if (onProgress && step % 50 === 0) {
      onProgress((step - startStep + 1) / totalSteps);
    }
  }

  // Split into positive and negative, sort each, return top N of each
  const positive = results.filter(r => r.r > 0);
  positive.sort((a, b) => b.r - a.r);
  const negative = results.filter(r => r.r < 0);
  negative.sort((a, b) => a.r - b.r); // most negative first
  return { positive: positive.slice(0, topN), negative: negative.slice(0, topN) };
}

/**
 * Compute Pearson correlation between primary close prices and overlay close prices
 * over the overlapping slot indices.
 *
 * Uses percent-change series (returns) for a more meaningful price correlation
 * that isn't dominated by absolute price levels.
 */
export function computeCorrelation(
  primarySlots: CandleSlot[],
  projectedCandles: ProjectedCandle[],
): CorrelationResult | null {
  // Build aligned pairs, keeping the primary slot index so we can enforce
  // that returns are computed between *consecutive* slots. Without this,
  // a Fri→Mon pair on a US equity chart is treated as a single-bar return
  // (and any misalignment across markets with different calendars silently
  // pollutes the sum with garbage returns).
  const pairs: Array<{ primary: number; overlay: number; idx: number }> = [];
  for (const pc of projectedCandles) {
    const idx = pc.projectedSlotIndex;
    if (idx < 0 || idx >= primarySlots.length) continue;
    // projectedSlotIndex may be fractional for extrapolated future slots;
    // only integer indices correspond to real slot data.
    if (!Number.isInteger(idx)) continue;
    const slot = primarySlots[idx];
    if (!slot || !slot.candle) continue;
    pairs.push({ primary: slot.candle.close, overlay: pc.candle.close, idx });
  }

  if (pairs.length < 3) return null;

  // Only compute a return when both series have data for two consecutive
  // slot indices; skip across any gap (weekend, holiday, missing bar).
  const primaryReturns: number[] = [];
  const overlayReturns: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i].idx !== pairs[i - 1].idx + 1) continue;
    if (pairs[i - 1].primary === 0 || pairs[i - 1].overlay === 0) continue;
    primaryReturns.push((pairs[i].primary - pairs[i - 1].primary) / pairs[i - 1].primary);
    overlayReturns.push((pairs[i].overlay - pairs[i - 1].overlay) / pairs[i - 1].overlay);
  }

  if (primaryReturns.length < 2) return null;

  return {
    r: pearson(primaryReturns, overlayReturns),
    n: primaryReturns.length,
  };
}

/** Standard Pearson correlation coefficient */
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }
  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}
