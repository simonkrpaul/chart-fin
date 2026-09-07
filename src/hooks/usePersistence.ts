/**
 * usePersistence – handles ALL chart initialisation on mount.
 *
 * Restore order (when a saved dataset URL exists):
 *   1. Apply saved theme immediately (no flash)
 *   2. Add saved indicators (series computed when candles arrive)
 *   3. Restore drawings
 *   4. Fetch saved CSV → loadCandles → recomputes indicators automatically
 *   5. Rebuild each saved overlay from rawCandles + saved config
 *   6. Switch to saved timeframe (triggers resample if needed)
 *
 * When no saved dataset URL exists (first visit or upload-only session):
 *   → Loads built-in sample candlestick data with default indicators.
 *
 * Auto-save:
 *   Subscribes to the Zustand store after restore; debounces writes to
 *   localStorage at most once per 500 ms.
 */
import { useEffect } from 'react';
import { primaryChartStore } from '../store/chartStore';
import { bootReady } from '../store/chartSession';
import {
  savePrefs,
  loadPrefs,
  loadDataset,
  type StoredPrefs,
} from '../db/persistence';
import { parseOHLCVFile, detectTimeframe } from '../utils/dataParser';
import { generateSampleCandles } from '../utils/sampleData';
import type { IndicatorConfig, RawCandle } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Debounced save (called from Zustand subscription)
// ─────────────────────────────────────────────────────────────────────────────

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const s = primaryChartStore.getState();
    savePrefs({
      theme:            s.theme,
      timeframe:        s.timeframe,
      indicatorConfigs: s.indicatorConfigs,
      drawings:         s.drawings,
      overlayConfigs:   s.overlayConfigs,
    });
  }, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// Default sample data (used when nothing is persisted)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_INDICATORS: IndicatorConfig[] = [
  {
    id: 'ema-50',
    type: 'EMA',
    params: { period: 50 },
    color: '#ff9800',
    lineWidth: 1.5,
    visible: true,
    pane: 'main',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function usePersistence(): void {
  useEffect(() => {
    let unsubStore: (() => void) | null = null;

    async function restore(): Promise<void> {
      // Wait for the new session-restore path to finish so we don't overwrite
      // an already-loaded series with a stale localStorage snapshot.
      await bootReady;

      const prefs = loadPrefs();
      const ds    = loadDataset();
      const store = primaryChartStore.getState();

      // 1. Theme – apply immediately so no dark→light flash
      if (prefs?.theme) store.setTheme(prefs.theme);

      // If the new session-restore path (chartSession.restoreLastSession)
      // has already loaded a real series into the store, DO NOT touch
      // rawCandles. This legacy dataset+sample restore existed before the
      // multi-market DB layer and would overwrite the freshly-loaded series
      // with a stale MOCKBTC / sample-data snapshot.
      const alreadyLoaded = !!primaryChartStore.getState().currentSeries;

      if (alreadyLoaded) {
        // Just apply the prefs bits that don't touch candles.
        for (const cfg of prefs?.indicatorConfigs ?? []) {
          store.addIndicator(cfg);
        }
        if (prefs?.drawings?.length) {
          primaryChartStore.setState({ drawings: prefs.drawings });
        }
      } else if (ds?.url) {
        // ── Legacy: saved dataset URL, no new-style series restored ────────
        try {
          const resp = await fetch(ds.url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

          const text = await resp.text();
          const file = new File([text], ds.url.split('/').pop()!, { type: 'text/csv' });
          const { candles } = await parseOHLCVFile(file);
          if (!candles.length) throw new Error('empty');

          const baseTf = detectTimeframe(candles);

          // 2. Set timeframe to the base TF first so loadCandles records it correctly
          store.setTimeframe(baseTf);

          // 3. Load candles (also calls recomputeAllIndicators on any pre-added indicators)
          store.loadCandles(candles, candles[0].timestamp, candles[candles.length - 1].timestamp);

          // 4. Restore indicators
          for (const cfg of prefs?.indicatorConfigs ?? []) {
            store.addIndicator(cfg);
          }

          // 5. Restore drawings
          if (prefs?.drawings?.length) {
            primaryChartStore.setState({ drawings: prefs.drawings });
          }

          // 6. Rebuild overlays – re-derive historical candles from rawCandles
          const rawCandles: RawCandle[] = primaryChartStore.getState().rawCandles;
          for (const cfg of prefs?.overlayConfigs ?? []) {
            const hist = rawCandles.filter(
              c => c.timestamp >= cfg.sourceStartTimestamp &&
                   c.timestamp <= cfg.sourceEndTimestamp,
            );
            store.addOverlay(cfg, hist);
          }

          // 7. Switch to saved timeframe (resamples if different from base)
          if (prefs?.timeframe && prefs.timeframe !== baseTf) {
            store.setTimeframe(prefs.timeframe);
          }
        } catch {
          applyPrefsToSampleData(prefs);
        }
      } else {
        // No saved dataset AND no new-style series → load sample data.
        applyPrefsToSampleData(prefs);
      }

      unsubStore = primaryChartStore.subscribe(scheduleSave);
    }

    restore();

    return () => {
      if (unsubStore) unsubStore();
      if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Load the built-in sample data, then overlay any saved indicators / drawings.
 * Called when no dataset URL was persisted.
 */
function applyPrefsToSampleData(prefs: StoredPrefs | null): void {
  const store = primaryChartStore.getState();
  const endMs   = Date.now();
  const startMs = endMs - 365 * 24 * 60 * 60 * 1000;
  const candles = generateSampleCandles(startMs, endMs, '1d', 500);
  store.loadCandles(candles, startMs, endMs);

  // Use saved indicators if available; otherwise fall back to the single default
  const indicators = prefs?.indicatorConfigs?.length ? prefs.indicatorConfigs : DEFAULT_INDICATORS;
  for (const cfg of indicators) store.addIndicator(cfg);

  if (prefs?.drawings?.length) primaryChartStore.setState({ drawings: prefs.drawings });
}
