import { isMobileViewport } from '../hooks/useIsMobile';

type Paint = (ctx: CanvasRenderingContext2D, scale: number) => void;

interface Exporter {
  paint: Paint;
  width: number;
  height: number;
}

// Keyed by the panel's chart store so the toolbar exports the active panel.
const exporters = new Map<object, Exporter>();

// Keeps exports under iOS Safari's ~16.7 MP canvas cap; desktop allows more but this is plenty.
const MAX_PIXELS = 16_000_000;
const MAX_SCALE = 4;

export function registerChartExporter(store: object, exporter: Exporter): () => void {
  exporters.set(store, exporter);
  return () => {
    if (exporters.get(store) === exporter) exporters.delete(store);
  };
}

export async function downloadChartPng(store: object | null): Promise<void> {
  const exp = (store && exporters.get(store)) ?? exporters.values().next().value;
  if (!exp || exp.width <= 0 || exp.height <= 0) return;

  const fit = Math.sqrt(MAX_PIXELS / (exp.width * exp.height));
  const scale = Math.max(1, Math.min(MAX_SCALE, fit));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(exp.width * scale);
  canvas.height = Math.floor(exp.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  exp.paint(ctx, scale);

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return;
  const name = `chart-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`;
  const file = new File([blob], name, { type: 'image/png' });

  if (isMobileViewport() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = name;
  link.href = url;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
