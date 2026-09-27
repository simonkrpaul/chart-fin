/**
 * Hurst Cycles – isolated Zustand store.
 *
 * This module owns *its own* state and does not touch chartStore. It stays
 * in sync with the active chart via `syncFromSlots()`, which callers invoke
 * with the current `primarySlots` when they change. The panel and renderer
 * read from this store only.
 */
import { create } from 'zustand';
import type { CandleSlot } from '../types';
import type { HurstConfig, HurstCycleBand, HurstOutput, HurstToolset } from './types';
import { computeHurst } from './engine';

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_TOOLS: HurstToolset = {
  showCma: true,
  showFld: true,
  showEnvelope: false,
  showTroughs: true,
  showProjection: true,
};

/**
 * Hurst's classical "Nominal Model" for stocks (18Y / 9Y / 4.5Y / 54w / 18w
 * / 9w / 4.5w / 20d / 10d / 5d), expressed in TRADING DAYS. On a daily bar
 * this maps directly to bar count. On other timeframes users can scale up
 * (e.g. 1h chart: multiply by 6.5 for US regular hours).
 *
 * By default only the four shorter cycles are enabled — the multi-year
 * cycles require decades of history to detect properly.
 */
export const HURST_NOMINAL_DEFAULT: HurstCycleBand[] = [
  { id: 'h-18y',  label: '18-year',    periodBars: 4680, enabled: false, color: '#b71c1c' },
  { id: 'h-9y',   label: '9-year',     periodBars: 2340, enabled: false, color: '#e64a19' },
  { id: 'h-4y',   label: '4.5-year',   periodBars: 1170, enabled: false, color: '#f9a825' },
  { id: 'h-54w',  label: '54-week',    periodBars: 270,  enabled: true,  color: '#43a047' },
  { id: 'h-18w',  label: '18-week',    periodBars: 90,   enabled: true,  color: '#00acc1' },
  { id: 'h-9w',   label: '9-week',     periodBars: 45,   enabled: true,  color: '#3949ab' },
  { id: 'h-20d',  label: '20-day',     periodBars: 20,   enabled: true,  color: '#8e24aa' },
  { id: 'h-10d',  label: '10-day',     periodBars: 10,   enabled: false, color: '#d81b60' },
  { id: 'h-5d',   label: '5-day',      periodBars: 5,    enabled: false, color: '#546e7a' },
];

const DEFAULT_CONFIG: HurstConfig = {
  visible: false,
  cycles: HURST_NOMINAL_DEFAULT,
  tolerance: 0.15,
  tools: DEFAULT_TOOLS,
};

// ── LocalStorage persistence (config only, not output) ──────────────────────

const LS_KEY = 'chartfin.hurst.config.v1';

function loadConfig(): HurstConfig {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as HurstConfig;
    // Trust-but-verify: merge with defaults in case fields were added.
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      tools: { ...DEFAULT_TOOLS, ...(parsed.tools ?? {}) },
      cycles: Array.isArray(parsed.cycles) && parsed.cycles.length ? parsed.cycles : DEFAULT_CONFIG.cycles,
    };
  } catch { return DEFAULT_CONFIG; }
}

function saveConfig(cfg: HurstConfig) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

// ── Store ───────────────────────────────────────────────────────────────────

interface HurstState {
  config: HurstConfig;
  output: HurstOutput | null;
  /** Last slots reference passed to syncFromSlots; kept for recompute. */
  _slots: CandleSlot[];

  // Config setters
  setVisible: (v: boolean) => void;
  setTolerance: (t: number) => void;
  setTool: <K extends keyof HurstToolset>(k: K, v: HurstToolset[K]) => void;

  // Cycle CRUD
  addCycle: (band: Omit<HurstCycleBand, 'id'>) => void;
  updateCycle: (id: string, patch: Partial<HurstCycleBand>) => void;
  removeCycle: (id: string) => void;
  toggleCycle: (id: string) => void;
  resetToNominal: () => void;

  // Data + recompute
  syncFromSlots: (slots: CandleSlot[]) => void;
  recompute: () => void;
}

let uid = 0;
const nextId = () => `cy-${Date.now().toString(36)}-${(uid++).toString(36)}`;

export const useHurstStore = create<HurstState>((set, get) => ({
  config: loadConfig(),
  output: null,
  _slots: [],

  setVisible: (v) => set(s => {
    const config = { ...s.config, visible: v };
    saveConfig(config);
    return { config };
  }),

  setTolerance: (t) => {
    const clamped = Math.max(0, Math.min(0.4, t));
    set(s => {
      const config = { ...s.config, tolerance: clamped };
      saveConfig(config);
      return { config };
    });
    get().recompute();
  },

  setTool: (k, v) => set(s => {
    const config = { ...s.config, tools: { ...s.config.tools, [k]: v } };
    saveConfig(config);
    return { config };
  }),

  addCycle: (band) => {
    set(s => {
      const config = { ...s.config, cycles: [...s.config.cycles, { ...band, id: nextId() }] };
      saveConfig(config);
      return { config };
    });
    get().recompute();
  },

  updateCycle: (id, patch) => {
    set(s => {
      const config = {
        ...s.config,
        cycles: s.config.cycles.map(c => c.id === id ? { ...c, ...patch } : c),
      };
      saveConfig(config);
      return { config };
    });
    get().recompute();
  },

  removeCycle: (id) => {
    set(s => {
      const config = { ...s.config, cycles: s.config.cycles.filter(c => c.id !== id) };
      saveConfig(config);
      return { config };
    });
    get().recompute();
  },

  toggleCycle: (id) => {
    set(s => {
      const config = {
        ...s.config,
        cycles: s.config.cycles.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c),
      };
      saveConfig(config);
      return { config };
    });
    get().recompute();
  },

  resetToNominal: () => {
    set(s => {
      const config = { ...s.config, cycles: HURST_NOMINAL_DEFAULT.map(c => ({ ...c })) };
      saveConfig(config);
      return { config };
    });
    get().recompute();
  },

  syncFromSlots: (slots) => {
    set({ _slots: slots });
    get().recompute();
  },

  recompute: () => {
    const { config, _slots } = get();
    if (!config.visible || _slots.length === 0) {
      set({ output: null });
      return;
    }
    const output = computeHurst(_slots, config);
    set({ output });
  },
}));
