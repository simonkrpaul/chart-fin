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
  clearDataset,
  type StoredPrefs,
} from '../db/persistence';
import { generateSampleCandles } from '../utils/sampleData';
import type { IndicatorConfig } from '../types';

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
      } else {
        // Nothing restored via IndexedDB. Show the built-in sample chart.
        //
        // The legacy `loadDataset()` path used to fetch a saved CSV URL and
        // parse the entire file into memory on the main thread. On a big
        // dataset (e.g. a 300 MB BTC 1m CSV persisted from a previous
        // session) that would OOM-crash the tab ("Aw Snap Error 5"). The
        // multi-market DB layer replaces it — real series come through
        // `restoreLastSession()`, and if that returns nothing we go
        // straight to lightweight sample data.
        applyPrefsToSampleData(prefs);
        // Best-effort: purge the stale dataset key so it can never fire
        // again on a subsequent boot.
        try { clearDataset(); } catch { /* ignore */ }
      }

      unsubStore = primaryChartStore.subscribe(scheduleSave);
    }

    restore().catch(err => {
      // Never let a persistence error bubble up to React — the page must
      // stay interactive even if IndexedDB was wiped or localStorage is
      // corrupt. Fall back to the built-in sample chart.
      console.error('[persistence] restore failed — loading sample data', err);
      try {
        applyPrefsToSampleData(null);
      } catch (fallbackErr) {
        console.error('[persistence] even sample-data fallback failed', fallbackErr);
      }
    });

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
