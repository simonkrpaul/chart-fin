/**
 * useLazyBackfill – subscribes to the active chart's viewport and prepends
 * older candles from the DB when the user pans within `triggerSlots` of the
 * left edge of the loaded history.
 *
 * Suppresses re-entry with `backfillInFlight`. If the DB has no data older
 * than what's already loaded, the hook naturally goes quiet.
 */
import { useEffect } from 'react';
import { useChartStore } from '../store/chartStore';
import { loadCandlesBefore } from '../db/marketDb';

const TRIGGER_SLOTS = 100;
const BACKFILL_BAR_COUNT = 2000;

export function useLazyBackfill(): void {
  const {
    currentSeries,
    backfillInFlight,
    setBackfillInFlight,
    prependCandles,
    viewport,
    primarySlots,
  } = useChartStore();
  const firstSlotIndex = viewport.firstSlotIndex;

  useEffect(() => {
    if (!currentSeries) return;
    if (backfillInFlight) return;
    if (primarySlots.length === 0) return;
    if (firstSlotIndex > TRIGGER_SLOTS) return;

    const oldestTs = primarySlots[0]?.timestamp;
    if (oldestTs === undefined) return;

    let cancelled = false;
    setBackfillInFlight(true);
    (async () => {
      try {
        const { candles } = await loadCandlesBefore(
          currentSeries.market,
          currentSeries.symbol,
          currentSeries.timeframe,
          oldestTs,
          BACKFILL_BAR_COUNT,
        );
        if (!cancelled && candles.length > 0) {
          prependCandles(candles);
        }
      } finally {
        if (!cancelled) setBackfillInFlight(false);
      }
    })();

    return () => { cancelled = true; };
  }, [currentSeries, backfillInFlight, firstSlotIndex, primarySlots, setBackfillInFlight, prependCandles]);
}
