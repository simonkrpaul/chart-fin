import { runCycleBacktest, type CycleBacktestInput, type CycleBacktestResult } from '../engine/cycleBacktestEngine';

export type CycleWorkerResponse =
  | { type: 'progress'; pct: number; label: string }
  | { type: 'done'; result: CycleBacktestResult }
  | { type: 'error'; message: string };

self.onmessage = (evt: MessageEvent<CycleBacktestInput>) => {
  const post = (msg: CycleWorkerResponse) => self.postMessage(msg);
  try {
    const result = runCycleBacktest(evt.data, (pct, label) => post({ type: 'progress', pct, label }));
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
