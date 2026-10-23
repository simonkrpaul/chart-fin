import { useSyncExternalStore } from 'react';

// Phones in portrait, plus phones in landscape (short + touch).
const QUERY = '(max-width: 767px), (pointer: coarse) and (max-height: 500px)';

function subscribe(cb: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', cb);
  return () => mql.removeEventListener('change', cb);
}

export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(QUERY).matches;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobileViewport, () => false);
}
