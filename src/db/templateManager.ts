/**
 * templateManager — CRUD + apply + import/export for ChartTemplate.
 *
 * A template is a series-agnostic analysis preset (indicators, overlays,
 * cycle combiner, transits, display toggles). Templates live in IndexedDB
 * and can be exported/imported as JSON files for in-repo distribution via
 * `public/data/templates/` (seeded on boot — see `seedTemplatesFromManifest`).
 */
import { primaryChartStore } from '../store/chartStore';
import {
  saveTemplateDb,
  getTemplateDb,
  listTemplatesDb,
  deleteTemplateDb,
  getSetting,
  setSetting,
} from './marketStore';
import type { ChartTemplate, ChartTemplatePayload } from '../types';

const KEY_SEEDED_TEMPLATES = 'templatesManifestSeeded';
const MANIFEST_URL_DEFAULT = '/data/markets/manifest.json';

// ─────────────────────────────────────────────────────────────────────────────
// Build a payload from the live store
// ─────────────────────────────────────────────────────────────────────────────

export function buildPayloadFromStore(): ChartTemplatePayload {
  const s = primaryChartStore.getState();
  return {
    timeframe: s.timeframe,
    showOverlays: s.showOverlays,
    offsetConfluenceHighlight: s.offsetConfluenceHighlight,
    gapVisibility: s.gapVisibility,
    indicatorConfigs: s.indicatorConfigs.map(c => ({ ...c })),
    overlayConfigs: s.overlayConfigs.map(c => ({ ...c })),
    cycleCombinerConfig: {
      ...s.cycleCombinerConfig,
      cycles: s.cycleCombinerConfig.cycles.map(c => ({ ...c })),
    },
    transitZoneGroups: s.transitZoneGroups.map(g => ({
      ...g,
      zones: g.zones.map(z => ({ ...z })),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply a payload to the live store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a template payload on top of the currently-loaded chart.
 *
 * Does NOT touch currentSeries/viewport/drawings — those are not part of a
 * template. All existing indicators / overlays / transits are cleared first
 * so the user gets exactly what the template describes.
 */
export function applyTemplatePayload(payload: ChartTemplatePayload): void {
  const store = primaryChartStore.getState();

  // 1. Toggles & scalar state (safe to set unconditionally).
  if (typeof payload.showOverlays === 'boolean'
      && payload.showOverlays !== store.showOverlays) {
    store.toggleShowOverlays();
  }
  if (typeof payload.offsetConfluenceHighlight === 'boolean'
      && payload.offsetConfluenceHighlight !== store.offsetConfluenceHighlight) {
    store.toggleOffsetConfluenceHighlight();
  }
  if (payload.gapVisibility && payload.gapVisibility !== store.gapVisibility) {
    store.setGapVisibility(payload.gapVisibility);
  }
  if (payload.timeframe && payload.timeframe !== store.timeframe) {
    store.setTimeframe(payload.timeframe);
  }

  // 2. Indicators: wipe & reinstall (IDs regenerated to avoid colliding
  //    with any prior persisted ones from a layout).
  for (const cfg of [...store.indicatorConfigs]) {
    store.removeIndicator(cfg.id);
  }
  for (const cfg of payload.indicatorConfigs ?? []) {
    store.addIndicator({ ...cfg, id: _freshId('ind') });
  }

  // 3. Overlays: wipe & reinstall. addOverlay re-resolves historical candles
  //    from rawCandles when passed [], so the overlay re-anchors against
  //    whatever series is currently loaded.
  for (const cfg of [...store.overlayConfigs]) {
    store.removeOverlay(cfg.id);
  }
  for (const cfg of payload.overlayConfigs ?? []) {
    store.addOverlay({ ...cfg, id: _freshId('ov') }, []);
  }

  // 4. Cycle combiner — direct patch.
  if (payload.cycleCombinerConfig) {
    store.setCycleCombinerConfig({
      ...payload.cycleCombinerConfig,
      cycles: payload.cycleCombinerConfig.cycles.map(c => ({ ...c })),
    });
  }

  // 5. Transit zone groups — wipe & reinstall.
  store.clearAllTransitZones();
  for (const g of payload.transitZoneGroups ?? []) {
    const { id: _id, ...rest } = g;
    store.addTransitZoneGroup(rest);
  }
}

function _freshId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Save current chart state as a new template
// ─────────────────────────────────────────────────────────────────────────────

export async function saveCurrentAsTemplate(
  name: string,
  description?: string,
): Promise<ChartTemplate> {
  const payload = buildPayloadFromStore();
  const now = Date.now();
  const tpl: ChartTemplate = {
    schemaVersion: 1,
    id: _freshId('tmpl'),
    name: name.trim(),
    description: description?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    payload,
  };
  await saveTemplateDb(tpl);
  return tpl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply a stored template by id
// ─────────────────────────────────────────────────────────────────────────────

export async function applyTemplateById(id: string): Promise<ChartTemplate | null> {
  const tpl = await getTemplateDb(id);
  if (!tpl) return null;
  applyTemplatePayload(tpl.payload);
  return tpl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export (download as .json)
// ─────────────────────────────────────────────────────────────────────────────

export function exportTemplateJSON(tpl: ChartTemplate): void {
  const json = JSON.stringify(tpl, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${_slugify(tpl.name)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke after the click handler has had a chance to pick it up.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'template';
}

// ─────────────────────────────────────────────────────────────────────────────
// Import a JSON file
// ─────────────────────────────────────────────────────────────────────────────

export async function importTemplateJSON(fileText: string): Promise<ChartTemplate> {
  const parsed = JSON.parse(fileText);
  const tpl = _validateTemplate(parsed);
  // Fresh id so an import can't clobber an existing template with the same id.
  tpl.id = _freshId('tmpl');
  tpl.updatedAt = Date.now();
  await saveTemplateDb(tpl);
  return tpl;
}

function _validateTemplate(raw: unknown): ChartTemplate {
  if (!raw || typeof raw !== 'object') throw new Error('Not a JSON object');
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) {
    throw new Error(`Unsupported template schemaVersion: ${r.schemaVersion}`);
  }
  if (typeof r.name !== 'string' || !r.name.trim()) {
    throw new Error('Template is missing a name');
  }
  if (!r.payload || typeof r.payload !== 'object') {
    throw new Error('Template is missing a payload');
  }
  return {
    schemaVersion: 1,
    id: typeof r.id === 'string' ? r.id : _freshId('tmpl'),
    name: r.name.trim(),
    description: typeof r.description === 'string' ? r.description : undefined,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    updatedAt: Date.now(),
    payload: r.payload as ChartTemplatePayload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot-time seed from the main manifest
// ─────────────────────────────────────────────────────────────────────────────

interface ManifestTemplateEntry {
  id?: string;
  name: string;
  url: string;
}

/**
 * On first boot, fetch any templates listed under `manifest.templates`
 * (produced by `scripts/_manifest.py`) and upsert them into IDB. Idempotent:
 * uses a settings flag + per-template name match to avoid duplicates.
 */
export async function seedTemplatesFromManifest(
  manifestUrl: string = MANIFEST_URL_DEFAULT,
): Promise<void> {
  try {
    const seeded = await getSetting<string[]>(KEY_SEEDED_TEMPLATES);
    const seededUrls = new Set(seeded ?? []);
    const resp = await fetch(manifestUrl);
    if (!resp.ok) return;
    const manifest = await resp.json() as { templates?: ManifestTemplateEntry[] };
    const entries = manifest.templates ?? [];
    if (entries.length === 0) return;

    const existing = await listTemplatesDb();
    const existingNames = new Set(existing.map(t => t.name));
    const touched: string[] = [...seededUrls];

    for (const entry of entries) {
      if (seededUrls.has(entry.url)) continue;
      if (existingNames.has(entry.name)) {
        touched.push(entry.url);
        continue;
      }
      try {
        const r = await fetch(entry.url);
        if (!r.ok) continue;
        const text = await r.text();
        await importTemplateJSON(text);
        touched.push(entry.url);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[templates] failed to seed ${entry.url}`, err);
      }
    }

    await setSetting(KEY_SEEDED_TEMPLATES, touched);
  } catch (err) {
    // Non-fatal: templates are a nicety, never block boot on them.
    // eslint-disable-next-line no-console
    console.warn('[templates] seed from manifest failed', err);
  }
}

// Re-export the raw list helper so UI code only needs one import source.
export { listTemplatesDb, deleteTemplateDb };
