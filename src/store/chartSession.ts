/**
 * chartSession — orchestrates opening a series or a saved layout end-to-end.
 *
 * A single entry point so ChartPicker, LayoutManager, and the auto-restore
 * hook on boot all share the same load logic.
 *
 * Also tracks the "last open" pointer so the app can reopen the same view
 * on restart, TradingView-style.
 */
import { primaryChartStore } from '../store/chartStore';
import { loadInitialCandles, presetFor } from '../db/marketDb';
import { getLayoutDb, setSetting, getSetting } from '../db/marketStore';
import type { ChartLayout, Timeframe } from '../types';

const KEY_LAST_OPEN = 'lastOpen';
const KEY_DEFAULT_LAYOUT = 'defaultLayoutId';

export interface LastOpen {
  kind: 'series' | 'layout';
  id?: string;                     // layout id
  market?: string;                 // series identity
  symbol?: string;
  timeframe?: Timeframe;
  savedAt: number;
}

export interface OpenResult {
  ok: boolean;
  rows: number;
  sourceTimeframe?: Timeframe;
  resampled?: boolean;
  message?: string;
}

// Single-flight guard: if the same (market, symbol, tf, count) is requested
// while a load is already in flight, share the result. Prevents React 19
// StrictMode double-invocation from doing two full IDB reads + resamples of
// a 1.5 M-row series.
const _openInFlight = new Map<string, Promise<OpenResult>>();

/** Load a series into the chart store and mark it as the last open item. */
export async function openSeries(
  market: string,
  symbol: string,
  tf: Timeframe,
  count = 2000,
): Promise<OpenResult> {
  const key = `${market}::${symbol}::${tf}::${Number.isFinite(count) ? count : 'all'}`;
  const existing = _openInFlight.get(key);
  if (existing) {
    // eslint-disable-next-line no-console
    console.info('[openSeries] joining in-flight run', { key });
    return existing;
  }
  const p = (async (): Promise<OpenResult> => {
    const t0 = performance.now();
    // eslint-disable-next-line no-console
    console.info('[openSeries] start', { market, symbol, tf, count });
    const { candles, sourceTimeframe, resampled } = await loadInitialCandles(market, symbol, tf, count);
    // eslint-disable-next-line no-console
    console.info('[openSeries] loaded', {
      market, symbol, tf, rows: candles.length,
      sourceTimeframe, resampled,
      firstTs: candles[0]?.timestamp, lastTs: candles[candles.length - 1]?.timestamp,
      ms: (performance.now() - t0).toFixed(0),
    });
    if (candles.length === 0) return { ok: false, rows: 0, message: 'No candles in DB' };

    const store = primaryChartStore.getState();
    const preset = presetFor(market);
    if (preset) store.setSession(preset.session);
    store.setTimeframe(tf);
    store.loadCandles(candles, candles[0].timestamp, candles[candles.length - 1].timestamp);
    store.setCurrentSeries({ market, symbol, timeframe: tf });

    await setSetting(KEY_LAST_OPEN, {
      kind: 'series', market, symbol, timeframe: tf, savedAt: Date.now(),
    } satisfies LastOpen);
    return { ok: true, rows: candles.length, sourceTimeframe, resampled };
  })();
  _openInFlight.set(key, p);
  try {
    return await p;
  } finally {
    _openInFlight.delete(key);
  }
}

/** Apply a saved layout, including loading its series if present. */
export async function openLayout(layout: ChartLayout): Promise<OpenResult> {
  const store = primaryChartStore.getState();
  // Apply drawings/indicators/theme/etc first so viewport lands correctly.
  store.importLayout(layout);

  let rows = 0;
  let sourceTf: Timeframe | undefined;
  let resampled = false;
  if (layout.series) {
    const res = await loadInitialCandles(
      layout.series.market,
      layout.series.symbol,
      layout.series.timeframe,
      2000,
    );
    if (res.candles.length > 0) {
      const preset = presetFor(layout.series.market);
      if (preset) store.setSession(preset.session);
      store.setTimeframe(layout.series.timeframe);
      store.loadCandles(res.candles, res.candles[0].timestamp, res.candles[res.candles.length - 1].timestamp);
      store.setCurrentSeries({
        market: layout.series.market,
        symbol: layout.series.symbol,
        timeframe: layout.series.timeframe,
      });
      rows = res.candles.length;
      sourceTf = res.sourceTimeframe;
      resampled = res.resampled;
    }
  }

  await setSetting(KEY_LAST_OPEN, {
    kind: 'layout', id: layout.id, savedAt: Date.now(),
  } satisfies LastOpen);
  return { ok: true, rows, sourceTimeframe: sourceTf, resampled };
}

/**
 * On boot: reopen the default layout if one is pinned, otherwise the last
 * series/layout the user had open. Silently no-ops if nothing is recorded.
 */
export async function restoreLastSession(): Promise<OpenResult | null> {
  const defaultId = await getSetting<string>(KEY_DEFAULT_LAYOUT);
  if (defaultId) {
    const layout = await getLayoutDb(defaultId);
    if (layout) return openLayout(layout);
  }
  const last = await getSetting<LastOpen>(KEY_LAST_OPEN);
  if (!last) return null;
  if (last.kind === 'series' && last.market && last.symbol && last.timeframe) {
    // For coarse TFs, load the full stored history — even 25 years of 1d
    // is only ~6 k rows. Intraday TFs stick to the 2 000-bar default.
    const coarse = last.timeframe === '1d' || last.timeframe === '1w' || last.timeframe === '1M';
    return openSeries(last.market, last.symbol, last.timeframe, coarse ? Infinity : 2000);
  }
  if (last.kind === 'layout' && last.id) {
    const layout = await getLayoutDb(last.id);
    if (layout) return openLayout(layout);
  }
  return null;
}

// Boot-ready barrier. `useBootRestore()` sets this; anything that would
// otherwise race with the initial series load (e.g. usePersistence's legacy
// dataset/sample-data restore) can `await bootReady` before touching the
// store.
let _resolveBootReady: (() => void) | null = null;
export const bootReady: Promise<void> = new Promise(res => { _resolveBootReady = res; });
export function markBootReady(): void { _resolveBootReady?.(); _resolveBootReady = null; }

/** Pin a layout id as the boot-time default (or clear it). */
export async function setDefaultLayout(id: string | null): Promise<void> {
  await setSetting(KEY_DEFAULT_LAYOUT, id);
}

export async function getDefaultLayoutId(): Promise<string | undefined> {
  return getSetting<string>(KEY_DEFAULT_LAYOUT);
}
