/**
 * Web Worker – receives WorkerRequest messages, runs heavy computation
 * off the main thread, and posts WorkerResponse messages back.
 *
 * Handles: slot generation, normalization, indicator computation,
 * overlay projection, range measurement.
 */
import type { WorkerRequest, WorkerResponse } from '../types';
import { generateSlots } from '../engine/calendarEngine';
import { normalizeCandles } from '../engine/normalizationEngine';
import { computeIndicator } from '../engine/indicatorEngine';
import { buildOffsetOverlay } from '../engine/offsetEngine';
import { measureRange } from '../engine/measurementEngine';

self.onmessage = (evt: MessageEvent<WorkerRequest>) => {
  const req = evt.data;
  try {
    switch (req.type) {
      case 'GENERATE_SLOTS': {
        const { id, startMs, endMs, timeframe, session } = req.payload;
        const slots = generateSlots(startMs, endMs, timeframe, session);
        const resp: WorkerResponse = { type: 'SLOTS_READY', id, slots };
        self.postMessage(resp);
        break;
      }

      case 'NORMALIZE': {
        const { id, slots, raw } = req.payload;
        const normalized = normalizeCandles(slots, raw);
        const resp: WorkerResponse = { type: 'NORMALIZED_READY', id, slots: normalized };
        self.postMessage(resp);
        break;
      }

      case 'COMPUTE_INDICATOR': {
        const { id, slots, config } = req.payload;
        const series = computeIndicator(slots, config);
        const resp: WorkerResponse = { type: 'INDICATOR_READY', id, series };
        self.postMessage(resp);
        break;
      }

      case 'PROJECT_OVERLAY': {
        const { id, primarySlots, overlayConfig, historicalCandles, session, timeframe } = req.payload;
        const overlay = buildOffsetOverlay(
          primarySlots,
          overlayConfig,
          historicalCandles,
          session,
          timeframe,
        );
        const resp: WorkerResponse = { type: 'OVERLAY_READY', id, overlay };
        self.postMessage(resp);
        break;
      }

      case 'MEASURE_RANGE': {
        const { id, slots, startSlotIndex, endSlotIndex } = req.payload;
        // Use UTC as default tz for worker (primary tz passed in store)
        const result = measureRange(slots, startSlotIndex, endSlotIndex, 'America/New_York');
        const resp: WorkerResponse = { type: 'MEASURE_RESULT', id, result };
        self.postMessage(resp);
        break;
      }

      default:
        break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errResp: WorkerResponse = { type: 'ERROR', id: (req as any).payload?.id ?? 'unknown', message: msg };
    self.postMessage(errResp);
  }
};
