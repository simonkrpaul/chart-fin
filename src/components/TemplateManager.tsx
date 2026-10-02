/**
 * TemplateManager — save / apply / export / import / delete chart templates.
 *
 * A template is a series-agnostic analysis preset (indicators, overlays,
 * cycle combiner, transits, display toggles). See `src/db/templateManager.ts`
 * for the data layer.
 */
import React, { useState, useRef, useEffect } from 'react';
import { useChartStore } from '../store/chartStore';
import {
  saveCurrentAsTemplate,
  applyTemplateById,
  exportTemplateJSON,
  importTemplateJSON,
  listTemplatesDb,
  deleteTemplateDb,
} from '../db/templateManager';
import type { ChartTemplate } from '../types';

export const TemplateManager: React.FC = () => {
  const { theme, currentSeries } = useChartStore();

  const [open, setOpen]           = useState(false);
  const [name, setName]           = useState('');
  const [description, setDesc]    = useState('');
  const [templates, setTemplates] = useState<ChartTemplate[]>([]);
  const [status, setStatus]       = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const text   = theme === 'dark' ? '#d1d4dc' : '#131722';
  const bg     = theme === 'dark' ? '#1e222d' : '#ffffff';
  const border = theme === 'dark' ? '#2a2e39' : '#e0e3eb';
  const hover  = theme === 'dark' ? '#2a2e39' : '#f0f3fa';
  const sub    = theme === 'dark' ? '#787b86' : '#787b86';
  const accent = '#2962ff';
  const danger = '#ef5350';

  // Refresh list on open.
  useEffect(() => {
    if (open) {
      listTemplatesDb()
        .then(setTemplates)
        .catch(err => {
          console.warn('[TemplateManager] listTemplatesDb failed', err);
          setTemplates([]);
        });
    }
  }, [open]);

  // Close when clicking outside.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) { setStatus('⚠ Please enter a name'); return; }
    try {
      const tpl = await saveCurrentAsTemplate(trimmed, description);
      setTemplates(await listTemplatesDb());
      setName('');
      setDesc('');
      setStatus(`✓ Saved "${tpl.name}"`);
      setTimeout(() => setStatus(''), 2500);
    } catch (err) {
      setStatus(`✗ ${(err as Error).message}`);
    }
  }

  async function handleApply(tpl: ChartTemplate) {
    if (!currentSeries) {
      setStatus('⚠ Open a chart first — templates apply on top of a loaded series.');
      return;
    }
    try {
      await applyTemplateById(tpl.id);
      setStatus(`✓ Applied "${tpl.name}"`);
      setTimeout(() => { setStatus(''); setOpen(false); }, 1200);
    } catch (err) {
      setStatus(`✗ ${(err as Error).message}`);
    }
  }

  function handleExport(tpl: ChartTemplate) {
    try {
      exportTemplateJSON(tpl);
      setStatus(`⬇ Downloaded "${tpl.name}.json"`);
      setTimeout(() => setStatus(''), 2500);
    } catch (err) {
      setStatus(`✗ ${(err as Error).message}`);
    }
  }

  async function handleDelete(tpl: ChartTemplate) {
    if (!confirm(`Delete template "${tpl.name}"? This cannot be undone.`)) return;
    try {
      await deleteTemplateDb(tpl.id);
      setTemplates(await listTemplatesDb());
      setStatus(`🗑 Deleted "${tpl.name}"`);
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      setStatus(`✗ ${(err as Error).message}`);
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-import of the same file
    if (!file) return;
    try {
      const txt = await file.text();
      const tpl = await importTemplateJSON(txt);
      setTemplates(await listTemplatesDb());
      setStatus(`✓ Imported "${tpl.name}"`);
      setTimeout(() => setStatus(''), 2500);
    } catch (err) {
      setStatus(`✗ Import failed: ${(err as Error).message}`);
    }
  }

  const btnStyle: React.CSSProperties = {
    background: 'transparent', color: text, border: `1px solid ${border}`,
    borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
  };

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={btnStyle}
        title="Save / apply chart templates (indicators, overlays, cycle combiner, transits)"
      >
        📋 Templates
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4,
            background: bg, color: text, border: `1px solid ${border}`,
            borderRadius: 6, boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
            width: 360, maxHeight: 500, overflowY: 'auto', zIndex: 1000,
            padding: 10, fontSize: 12,
          }}
        >
          {/* ── Save current ──────────────────────────────────────────── */}
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Save current chart as template</div>
          <input
            type="text"
            placeholder="Template name"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleSave(); }}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'transparent', color: text, border: `1px solid ${border}`,
              borderRadius: 4, padding: '4px 8px', fontSize: 12, marginBottom: 4,
            }}
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={description}
            onChange={e => setDesc(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'transparent', color: text, border: `1px solid ${border}`,
              borderRadius: 4, padding: '4px 8px', fontSize: 12, marginBottom: 6,
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <button
              onClick={() => void handleSave()}
              style={{ ...btnStyle, background: accent, color: '#fff', borderColor: accent, flex: 1 }}
            >
              💾 Save
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              style={btnStyle}
              title="Import a template from a .json file"
            >
              📂 Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={e => void handleImport(e)}
              style={{ display: 'none' }}
            />
          </div>

          {/* ── Status row ────────────────────────────────────────────── */}
          {status && (
            <div
              style={{
                fontSize: 11, marginBottom: 8, padding: '4px 6px',
                background: hover, borderRadius: 3,
                color: status.startsWith('✗') || status.startsWith('⚠') ? danger : text,
              }}
            >
              {status}
            </div>
          )}

          {/* ── Templates list ────────────────────────────────────────── */}
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Saved templates</div>
          {templates.length === 0 && (
            <div style={{ fontSize: 11, color: sub, padding: 8, textAlign: 'center' }}>
              No templates yet. Build a chart setup you like and save it above.
            </div>
          )}
          {templates.map(tpl => (
            <div
              key={tpl.id}
              style={{
                border: `1px solid ${border}`, borderRadius: 4,
                padding: '6px 8px', marginBottom: 4,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                <div style={{ fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tpl.name}
                </div>
                <div style={{ fontSize: 10, color: sub }}>
                  {new Date(tpl.updatedAt).toLocaleDateString()}
                </div>
              </div>
              {tpl.description && (
                <div style={{ fontSize: 10, color: sub, marginTop: 2, marginBottom: 4 }}>
                  {tpl.description}
                </div>
              )}
              <div style={{ fontSize: 10, color: sub, marginTop: 2, marginBottom: 6 }}>
                {_summary(tpl)}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={() => void handleApply(tpl)}
                  style={{ ...btnStyle, flex: 1, padding: '3px 8px', fontSize: 11 }}
                  title="Apply this template to the currently-loaded chart"
                >
                  ✓ Apply
                </button>
                <button
                  onClick={() => handleExport(tpl)}
                  style={{ ...btnStyle, padding: '3px 8px', fontSize: 11 }}
                  title="Download as .json (drop into public/data/templates/ to commit)"
                >
                  ⬇ Export
                </button>
                <button
                  onClick={() => void handleDelete(tpl)}
                  style={{ ...btnStyle, padding: '3px 8px', fontSize: 11, color: danger, borderColor: danger }}
                  title="Delete this template"
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function _summary(tpl: ChartTemplate): string {
  const p = tpl.payload;
  const parts: string[] = [];
  if (p.indicatorConfigs?.length)  parts.push(`${p.indicatorConfigs.length} ind`);
  if (p.overlayConfigs?.length)    parts.push(`${p.overlayConfigs.length} overlay`);
  if (p.cycleCombinerConfig?.cycles?.length) parts.push(`${p.cycleCombinerConfig.cycles.length} cycle`);
  if (p.transitZoneGroups?.length) parts.push(`${p.transitZoneGroups.length} transit`);
  if (p.timeframe)                 parts.push(p.timeframe);
  return parts.join(' · ') || 'empty payload';
}
