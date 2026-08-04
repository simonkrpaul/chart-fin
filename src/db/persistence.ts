/**
 * Persistence helpers – lightweight localStorage wrappers.
 *
 * Stored keys:
 *   chart-fin:prefs:v1         – theme, timeframe, indicatorConfigs, drawings, overlayConfigs
 *   chart-fin:dataset:v1       – last quick-loaded dataset URL (for auto-reload on start)
 *   chart-fin:layouts:v1       – JSON array of all saved ChartLayout objects
 *
 * Large data (rawCandles) is intentionally NOT persisted here; only the URL is
 * saved so the CSV can be re-fetched on the next page load.
 */
import type { ChartLayout, Drawing, IndicatorConfig, OffsetOverlayConfig, Timeframe } from '../types';

const KEY_PREFS   = 'chart-fin:prefs:v1';
const KEY_DATASET = 'chart-fin:dataset:v1';
const KEY_LAYOUTS = 'chart-fin:layouts:v1';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StoredPrefs {
  theme: 'dark' | 'light';
  timeframe: Timeframe;
  indicatorConfigs: IndicatorConfig[];
  drawings: Drawing[];
  overlayConfigs: OffsetOverlayConfig[];
}

export interface StoredDataset {
  /** Public URL of the CSV file (e.g. "/data/btc_5m.csv"). */
  url: string;
  symbol: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preferences
// ─────────────────────────────────────────────────────────────────────────────

export function savePrefs(prefs: StoredPrefs): void {
  try {
    localStorage.setItem(KEY_PREFS, JSON.stringify(prefs));
  } catch {
    // Quota exceeded or private browsing mode – silently ignore
  }
}

export function loadPrefs(): StoredPrefs | null {
  try {
    const raw = localStorage.getItem(KEY_PREFS);
    if (!raw) return null;
    return JSON.parse(raw) as StoredPrefs;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dataset (last loaded URL)
// ─────────────────────────────────────────────────────────────────────────────

export function saveDataset(ds: StoredDataset): void {
  try {
    localStorage.setItem(KEY_DATASET, JSON.stringify(ds));
  } catch {
    /* ignore */
  }
}

export function loadDataset(): StoredDataset | null {
  try {
    const raw = localStorage.getItem(KEY_DATASET);
    if (!raw) return null;
    return JSON.parse(raw) as StoredDataset;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clear all persisted data
// ─────────────────────────────────────────────────────────────────────────────

export function clearPersisted(): void {
  localStorage.removeItem(KEY_PREFS);
  localStorage.removeItem(KEY_DATASET);
  localStorage.removeItem(KEY_LAYOUTS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Named layouts
// ─────────────────────────────────────────────────────────────────────────────

function readLayouts(): ChartLayout[] {
  try {
    const raw = localStorage.getItem(KEY_LAYOUTS);
    return raw ? (JSON.parse(raw) as ChartLayout[]) : [];
  } catch {
    return [];
  }
}

function writeLayouts(layouts: ChartLayout[]): void {
  try {
    localStorage.setItem(KEY_LAYOUTS, JSON.stringify(layouts));
  } catch {
    /* quota – ignore */
  }
}

/** Return all saved layouts sorted by most-recently updated first. */
export function listLayouts(): ChartLayout[] {
  return readLayouts().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Save or overwrite a layout (matched by `layout.name`, case-insensitive). */
export function saveLayout(layout: ChartLayout): void {
  const layouts = readLayouts();
  const idx = layouts.findIndex(l => l.name.toLowerCase() === layout.name.toLowerCase());
  if (idx >= 0) {
    layouts[idx] = { ...layout, id: layouts[idx].id, createdAt: layouts[idx].createdAt, updatedAt: Date.now() };
  } else {
    layouts.push({ ...layout, updatedAt: Date.now() });
  }
  writeLayouts(layouts);
}

/** Load a layout by name (case-insensitive). Returns null if not found. */
export function getLayout(name: string): ChartLayout | null {
  return readLayouts().find(l => l.name.toLowerCase() === name.toLowerCase()) ?? null;
}

/** Delete a layout by id. */
export function deleteLayout(id: string): void {
  writeLayouts(readLayouts().filter(l => l.id !== id));
}
