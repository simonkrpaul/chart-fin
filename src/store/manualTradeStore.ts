/**
 * Manual backtest – isolated store for account/fee settings and saved
 * sessions (named snapshots of hand-drawn Long/Short positions).
 * Persisted to localStorage; sessions can also be exported/imported as JSON.
 */
import { create } from 'zustand';
import type { PositionDrawing, Timeframe } from '../types';
import { BYBIT_DEFAULT_SETTINGS, type ManualTradeSettings } from '../engine/manualBacktest';

export const MANUAL_BACKTEST_KIND = 'chartfin.manual-backtest';

export interface ManualBacktestSession {
  kind: typeof MANUAL_BACKTEST_KIND;
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  series?: { market: string; symbol: string; timeframe: Timeframe };
  settings: ManualTradeSettings;
  positions: PositionDrawing[];
}

const LS_SETTINGS = 'chartfin.manualBacktest.settings.v1';
const LS_SESSIONS = 'chartfin.manualBacktest.sessions.v1';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
}

interface ManualTradeState {
  settings: ManualTradeSettings;
  sessions: ManualBacktestSession[];
  setSettings: (patch: Partial<ManualTradeSettings>) => void;
  resetSettings: () => void;
  upsertSession: (session: ManualBacktestSession) => void;
  deleteSession: (id: string) => void;
}

export const useManualTradeStore = create<ManualTradeState>((set) => ({
  settings: { ...BYBIT_DEFAULT_SETTINGS, ...load<Partial<ManualTradeSettings>>(LS_SETTINGS, {}) },
  sessions: load<ManualBacktestSession[]>(LS_SESSIONS, []),

  setSettings: (patch) => set(s => {
    const settings = { ...s.settings, ...patch };
    save(LS_SETTINGS, settings);
    return { settings };
  }),

  resetSettings: () => {
    save(LS_SETTINGS, BYBIT_DEFAULT_SETTINGS);
    set({ settings: { ...BYBIT_DEFAULT_SETTINGS } });
  },

  upsertSession: (session) => set(s => {
    const sessions = [session, ...s.sessions.filter(x => x.id !== session.id)];
    save(LS_SESSIONS, sessions);
    return { sessions };
  }),

  deleteSession: (id) => set(s => {
    const sessions = s.sessions.filter(x => x.id !== id);
    save(LS_SESSIONS, sessions);
    return { sessions };
  }),
}));

export function parseSessionFile(text: string): ManualBacktestSession {
  const data = JSON.parse(text);
  if (!data || data.kind !== MANUAL_BACKTEST_KIND || !Array.isArray(data.positions)) {
    throw new Error('Not a chart-fin manual backtest file');
  }
  const positions = (data.positions as PositionDrawing[]).filter(p =>
    (p.tool === 'long_position' || p.tool === 'short_position') &&
    Number.isFinite(p.entry?.price) && Number.isFinite(p.entry?.timestamp) &&
    Number.isFinite(p.tpPrice) && Number.isFinite(p.slPrice),
  );
  return {
    ...data,
    name: String(data.name ?? 'Imported'),
    settings: { ...BYBIT_DEFAULT_SETTINGS, ...(data.settings ?? {}) },
    positions,
  };
}

export function downloadSession(session: ManualBacktestSession) {
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${session.name.replace(/[^a-z0-9-_]+/gi, '_') || 'manual-backtest'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
