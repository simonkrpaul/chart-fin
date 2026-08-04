/**
 * layoutStore – manages chart panel layout and sync-lock state.
 *
 * Layout types (TradingView-style):
 *   '1'    – single panel
 *   '2h'   – two panels side by side (horizontal split)
 *   '2v'   – two panels stacked (vertical split)
 *   '3h'   – three panels side by side
 *   '2x2'  – 2×2 grid (four panels)
 */
import { create } from 'zustand';

export type LayoutType = '1' | '2h' | '2v' | '3h' | '2x2';

/** How many panels each layout has, in reading order. */
export const LAYOUT_PANEL_IDS: Record<LayoutType, string[]> = {
  '1':   ['p1'],
  '2h':  ['p1', 'p2'],
  '2v':  ['p1', 'p2'],
  '3h':  ['p1', 'p2', 'p3'],
  '2x2': ['p1', 'p2', 'p3', 'p4'],
};

interface LayoutState {
  layoutType: LayoutType;
  activePanelId: string;
  /** When true, panning / zooming any panel pans / zooms all others by the same amount */
  syncLock: boolean;
}

interface LayoutActions {
  setLayout: (type: LayoutType) => void;
  setActivePanel: (id: string) => void;
  closePanel: (id: string) => void;
  toggleSyncLock: () => void;
}

export const useLayoutStore = create<LayoutState & LayoutActions>()((set) => ({
  layoutType: '1',
  activePanelId: 'p1',
  syncLock: false,

  setLayout: (type) => set((s) => {
    // Single layout should show the currently active chart full-screen.
    if (type === '1') {
      return { layoutType: type, activePanelId: s.activePanelId };
    }
    const newPanels = LAYOUT_PANEL_IDS[type];
    // Keep the current active panel if it exists in the new layout,
    // otherwise use the first panel.
    const active = newPanels.includes(s.activePanelId)
      ? s.activePanelId
      : newPanels[0];
    return { layoutType: type, activePanelId: active };
  }),
  setActivePanel: (id) => set({ activePanelId: id }),
  closePanel: (id) => set((s) => {
    const currentPanels = LAYOUT_PANEL_IDS[s.layoutType];
    if (currentPanels.length <= 1) return s;

    // Closing any panel in a multi-layout collapses to single view
    // showing one of the remaining visible panels.
    const remaining = currentPanels.filter(p => p !== id);
    const nextActive = remaining.includes(s.activePanelId)
      ? s.activePanelId
      : (remaining[0] ?? s.activePanelId);

    return {
      layoutType: '1',
      activePanelId: nextActive,
    };
  }),
  toggleSyncLock: () => set((s) => ({ syncLock: !s.syncLock })),
}));
