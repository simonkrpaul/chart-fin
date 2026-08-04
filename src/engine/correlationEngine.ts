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
 * Scan offsets from 1..maxDays to find the best-correlating historical period.
 *
 * @param mode - 'returns' for close-to-close returns, 'swing' for swing-point % moves
 * @param swingLR - Left/Right bars for swing detection (used when mode='swing')
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
  const totalSteps = Math.floor(maxDays / stepDays);

  for (let step = 1; step <= totalSteps; step++) {
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
      onProgress(step / totalSteps);
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
  // Build aligned close-price pairs
  const pairs: [number, number][] = [];
  for (const pc of projectedCandles) {
    const idx = pc.projectedSlotIndex;
    if (idx < 0 || idx >= primarySlots.length) continue;
    const slot = primarySlots[idx];
    if (!slot || !slot.candle) continue;
    pairs.push([slot.candle.close, pc.candle.close]);
  }

  if (pairs.length < 3) return null; // need enough points

  // Convert to percent-change (returns) series for meaningful correlation
  const primaryReturns: number[] = [];
  const overlayReturns: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    const pRet = (pairs[i][0] - pairs[i - 1][0]) / pairs[i - 1][0];
    const oRet = (pairs[i][1] - pairs[i - 1][1]) / pairs[i - 1][1];
    primaryReturns.push(pRet);
    overlayReturns.push(oRet);
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
