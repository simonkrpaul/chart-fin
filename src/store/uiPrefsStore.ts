import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiPrefs {
  showInfoBar: boolean;
  setShowInfoBar: (v: boolean) => void;
}

export const useUiPrefs = create<UiPrefs>()(
  persist(
    set => ({
      showInfoBar: true,
      setShowInfoBar: v => set({ showInfoBar: v }),
    }),
    { name: 'chartfin.uiPrefs' },
  ),
);
