/**
 * chartRegistry – lightweight registry of active chart panel action handles.
 *
 * Used exclusively for sync-lock broadcast: when one panel pans/zooms,
 * all other registered panels receive the same delta.
 *
 * Intentionally has NO imports from chartStore.ts to avoid circular deps.
 */

interface PanelActions {
  pan: (delta: number) => void;
  zoom: (delta: number, anchor: number) => void;
}

const _panels = new Map<string, PanelActions>();

/** Prevents re-entrant broadcasts when the broadcast itself triggers pan/zoom. */
let _broadcasting = false;

export const chartRegistry = {
  register(id: string, actions: PanelActions): void {
    _panels.set(id, actions);
  },

  unregister(id: string): void {
    _panels.delete(id);
  },

  broadcastPan(sourceId: string, delta: number): void {
    if (_broadcasting) return;
    _broadcasting = true;
    try {
      _panels.forEach((actions, id) => {
        if (id !== sourceId) actions.pan(delta);
      });
    } finally {
      _broadcasting = false;
    }
  },

  broadcastZoom(sourceId: string, delta: number, anchor: number): void {
    if (_broadcasting) return;
    _broadcasting = true;
    try {
      _panels.forEach((actions, id) => {
        if (id !== sourceId) actions.zoom(delta, anchor);
      });
    } finally {
      _broadcasting = false;
    }
  },
};
