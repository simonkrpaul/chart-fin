/**
 * Hurst Cycles – domain types.
 *
 * Empirical cycle analysis per J.M. Hurst ("The Profit Magic of Stock
 * Transaction Timing", 1970; "Cyclic Analysis", 1973). *Not* a sine-wave
 * synthesizer — every value below is derived from the actual price series.
 *
 * Core tools:
 *   • CMA        – Centered Moving Average, period = cycle length.
 *   • Detrended  – close − CMA. The visible cycle at that period.
 *   • FLD        – Future Line of Demarcation: (H+L)/2 shifted forward by
 *                  period/2 bars. Price crossings give buy/sell signals.
 *   • Envelope   – ± amplitude bands around the CMA.
 *   • Troughs    – local minima in the detrended series, at least
 *                  period·(1 − tolerance) bars apart. Longer-cycle troughs
 *                  should coincide with shorter-cycle troughs (Hurst's
 *                  synchronicity principle).
 *   • Projection – forward window [last + (1-tol)·period, last + (1+tol)·period]
 *                  where the next trough is expected.
 *
 * Period is stored in BARS of the current chart, so the semantics adapt
 * naturally to the market:
 *   – Daily stock chart:  20 bars ≈ 4 trading weeks.
 *   – Daily crypto chart: 20 bars ≈ 3 calendar weeks.
 *   – 1h chart, 480 bars ≈ 20 days on either market.
 */

export interface HurstToolset {
  showCma: boolean;
  showFld: boolean;
  showEnvelope: boolean;
  showTroughs: boolean;
  showProjection: boolean;
}

export interface HurstCycleBand {
  id: string;
  label: string;
  periodBars: number;
  enabled: boolean;
  color: string;
}

export interface HurstConfig {
  visible: boolean;
  cycles: HurstCycleBand[];
  /** Trough spacing tolerance, as fraction (0.2 = ±20%). */
  tolerance: number;
  tools: HurstToolset;
}

export interface HurstCycleOutput {
  cma: (number | null)[];
  fld: (number | null)[];
  detrended: (number | null)[];
  amplitude: number;
  troughSlotIndices: number[];
  projection: { startSlotIndex: number; endSlotIndex: number } | null;
}

export interface HurstOutput {
  perCycle: Record<string, HurstCycleOutput>;
}
