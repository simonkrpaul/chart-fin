/**
 * Hurst Cycles – sidebar panel.
 *
 * Fully self-contained: reads/writes only the isolated useHurstStore.
 * The panel also syncs the current chart's primarySlots into the store
 * so the engine has data to work on. It does *not* mutate chartStore.
 */
import React, { useEffect, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { useHurstStore } from './hurstStore';

const NEW_CYCLE_COLORS = ['#43a047', '#00acc1', '#3949ab', '#8e24aa', '#d81b60', '#f57c00'];

export const HurstCyclesPanel: React.FC = () => {
  const { primarySlots, theme, themeTokens } = useChartStore();
  const isDark = theme === 'dark';
  const border = themeTokens.gridLine;
  const text = themeTokens.axisText;
  const subtle = isDark ? '#1c2333' : '#f0f2f7';

  const config = useHurstStore(s => s.config);
  const output = useHurstStore(s => s.output);
  const syncFromSlots = useHurstStore(s => s.syncFromSlots);
  const setVisible = useHurstStore(s => s.setVisible);
  const setTolerance = useHurstStore(s => s.setTolerance);
  const setTool = useHurstStore(s => s.setTool);
  const addCycle = useHurstStore(s => s.addCycle);
  const updateCycle = useHurstStore(s => s.updateCycle);
  const removeCycle = useHurstStore(s => s.removeCycle);
  const toggleCycle = useHurstStore(s => s.toggleCycle);
  const resetToNominal = useHurstStore(s => s.resetToNominal);

  const [newLabel, setNewLabel] = useState('');
  const [newPeriod, setNewPeriod] = useState('');

  // Sync the store's cached slots whenever the active chart's primarySlots
  // changes. This is the ONLY point of contact with chartStore.
  useEffect(() => {
    syncFromSlots(primarySlots);
  }, [primarySlots, syncFromSlots]);

  const inp: React.CSSProperties = {
    background: subtle, color: text,
    border: `1px solid ${border}`, borderRadius: 3,
    padding: '3px 6px', fontSize: 11, boxSizing: 'border-box',
  };

  const handleAdd = () => {
    const p = parseInt(newPeriod);
    if (!Number.isFinite(p) || p < 4) return;
    const label = newLabel.trim() || `${p}-bar`;
    const color = NEW_CYCLE_COLORS[config.cycles.length % NEW_CYCLE_COLORS.length];
    addCycle({ label, periodBars: p, enabled: true, color });
    setNewLabel('');
    setNewPeriod('');
  };

  const totalTroughs = output
    ? Object.values(output.perCycle).reduce((n, c) => n + c.troughSlotIndices.length, 0)
    : 0;

  return (
    <div style={{ padding: 12, fontSize: 12, color: text }}>
      {/* ── Header + master toggle ────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>Hurst Cycles</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={config.visible}
            onChange={e => setVisible(e.target.checked)}
          />
          Show
        </label>
      </div>

      {/* ── Intro (visible once, small) ───────────────────────────────── */}
      <div style={{ fontSize: 10, opacity: 0.6, lineHeight: 1.4, marginBottom: 10 }}>
        Empirical nested-cycle analysis (J.M. Hurst). Periods are in <b>chart bars</b>,
        so on a daily chart 20 bars ≈ 4 trading weeks (stocks) or 3 calendar weeks (crypto).
      </div>

      {/* ── Tool toggles ──────────────────────────────────────────────── */}
      <div
        style={{
          border: `1px solid ${border}`,
          borderRadius: 4,
          padding: '6px 8px',
          marginBottom: 10,
          background: subtle,
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 600, opacity: 0.7, marginBottom: 4 }}>Overlays</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 8px' }}>
          {([
            ['showCma',        'CMA line'],
            ['showFld',        'FLD line'],
            ['showEnvelope',   'Envelope'],
            ['showTroughs',    'Troughs ▽'],
            ['showProjection', 'Projection'],
          ] as const).map(([k, lbl]) => (
            <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={config.tools[k]}
                onChange={e => setTool(k, e.target.checked)}
              />
              {lbl}
            </label>
          ))}
        </div>

        {/* Tolerance slider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <span style={{ fontSize: 10, opacity: 0.7 }}>Tolerance</span>
          <input
            type="range"
            min={0.05}
            max={0.35}
            step={0.01}
            value={config.tolerance}
            onChange={e => setTolerance(parseFloat(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 10, fontFamily: 'monospace', width: 34, textAlign: 'right' }}>
            ±{Math.round(config.tolerance * 100)}%
          </span>
        </div>
      </div>

      {/* ── Cycles table ──────────────────────────────────────────────── */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.7 }}>Cycles ({config.cycles.length})</span>
          <button
            onClick={resetToNominal}
            style={{ fontSize: 9, padding: '1px 6px', background: 'transparent', color: text, border: `1px solid ${border}`, borderRadius: 3, cursor: 'pointer' }}
            title="Reset to Hurst's Nominal Model presets"
          >
            Reset to Nominal
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {config.cycles.map(cy => {
            const per = output?.perCycle[cy.id];
            return (
              <div
                key={cy.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '18px 12px 1fr 52px 36px 16px',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 4px',
                  background: cy.enabled ? subtle : 'transparent',
                  border: `1px solid ${border}`,
                  borderRadius: 3,
                  opacity: cy.enabled ? 1 : 0.55,
                }}
              >
                <input
                  type="checkbox"
                  checked={cy.enabled}
                  onChange={() => toggleCycle(cy.id)}
                />
                <input
                  type="color"
                  value={cy.color}
                  onChange={e => updateCycle(cy.id, { color: e.target.value })}
                  style={{ width: 12, height: 12, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                  title="Color"
                />
                <input
                  type="text"
                  value={cy.label}
                  onChange={e => updateCycle(cy.id, { label: e.target.value })}
                  style={{ ...inp, padding: '2px 4px', fontSize: 10 }}
                />
                <input
                  type="number"
                  min={4}
                  value={cy.periodBars}
                  onChange={e => updateCycle(cy.id, { periodBars: Math.max(4, parseInt(e.target.value) || 4) })}
                  style={{ ...inp, padding: '2px 4px', fontSize: 10, textAlign: 'right' }}
                  title="Period in bars"
                />
                <span
                  style={{ fontSize: 9, opacity: 0.7, textAlign: 'right', fontFamily: 'monospace' }}
                  title={per ? `${per.troughSlotIndices.length} past troughs; projection ${per.projection ? 'yes' : 'no'}` : 'not computed'}
                >
                  {per ? per.troughSlotIndices.length : '—'}▽
                </span>
                <button
                  onClick={() => removeCycle(cy.id)}
                  style={{ background: 'transparent', border: 'none', color: '#ef5350', cursor: 'pointer', fontSize: 12, padding: 0 }}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Add cycle row ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Label"
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          style={{ ...inp, flex: 1 }}
        />
        <input
          type="number"
          placeholder="Bars"
          value={newPeriod}
          onChange={e => setNewPeriod(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          style={{ ...inp, width: 60 }}
        />
        <button
          onClick={handleAdd}
          style={{ padding: '3px 8px', background: '#2962ff', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
        >
          Add
        </button>
      </div>

      {/* ── Status ────────────────────────────────────────────────────── */}
      <div style={{ fontSize: 10, opacity: 0.6, borderTop: `1px solid ${border}`, paddingTop: 6 }}>
        {output
          ? `Detected ${totalTroughs} past troughs across ${Object.keys(output.perCycle).length} cycles.`
          : primarySlots.length === 0
            ? 'Load a chart to run analysis.'
            : 'Analysis disabled or no cycle fits the loaded bar count.'}
      </div>
    </div>
  );
};
