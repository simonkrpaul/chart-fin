/**
 * CycleCombinerPanel – UI for combining multiple offset day cycles into a
 * single weighted composite oscillator.
 *
 * Each cycle = an offset in calendar days. The combiner looks back N days for
 * each cycle, takes the percent-change, multiplies by weight, sums, and applies
 * EMA smoothing. Output is rendered as a green/red sub-pane oscillator.
 */
import React, { useState } from 'react';
import { useChartStore } from '../store/chartStore';

const QUICK_CYCLES = [7, 14, 28, 60, 90, 121, 180, 273, 343, 365];

export const CycleCombinerPanel: React.FC = () => {
  const {
    cycleCombinerConfig,
    cycleCombinerOutput,
    setCycleCombinerConfig,
    addCycleInput,
    removeCycleInput,
    updateCycleInput,
    recomputeCycleCombiner,
    theme,
  } = useChartStore();

  const [customDays, setCustomDays] = useState('');
  const isDark = theme === 'dark';

  const handleAddCycle = (days: number) => {
    addCycleInput({ offsetDays: days, weight: 1.0, enabled: true });
  };

  const handleAddCustom = () => {
    const d = parseInt(customDays);
    if (d > 0) {
      handleAddCycle(d);
      setCustomDays('');
    }
  };

  return (
    <div style={{ padding: 12, fontSize: 13, color: isDark ? '#e0e0e0' : '#222' }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Cycle Combiner</h3>

      {/* Visibility + Color */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="checkbox"
            checked={cycleCombinerConfig.visible}
            onChange={() => setCycleCombinerConfig({ visible: !cycleCombinerConfig.visible })}
          />
          Visible
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Color:
          <input
            type="color"
            value={cycleCombinerConfig.color}
            onChange={e => setCycleCombinerConfig({ color: e.target.value })}
            style={{ width: 28, height: 20, border: 'none', cursor: 'pointer' }}
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Smooth:
          <input
            type="number"
            min={0}
            max={200}
            value={cycleCombinerConfig.smoothing}
            onChange={e => setCycleCombinerConfig({ smoothing: parseInt(e.target.value) || 0 })}
            style={{ width: 48, background: isDark ? '#333' : '#fff', color: isDark ? '#fff' : '#000', border: '1px solid #555', borderRadius: 3, padding: '2px 4px' }}
          />
        </label>
      </div>

      {/* Quick-add buttons */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Quick Add (days):</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {QUICK_CYCLES.map(d => (
            <button
              key={d}
              onClick={() => handleAddCycle(d)}
              style={{
                padding: '2px 6px',
                fontSize: 11,
                background: isDark ? '#444' : '#ddd',
                color: isDark ? '#fff' : '#000',
                border: '1px solid #666',
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Custom days input */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        <input
          type="number"
          min={1}
          placeholder="Custom days"
          value={customDays}
          onChange={e => setCustomDays(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAddCustom()}
          style={{ flex: 1, background: isDark ? '#333' : '#fff', color: isDark ? '#fff' : '#000', border: '1px solid #555', borderRadius: 3, padding: '3px 6px' }}
        />
        <button
          onClick={handleAddCustom}
          style={{ padding: '3px 8px', background: '#1976d2', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}
        >
          Add
        </button>
      </div>

      {/* Active cycles list */}
      {cycleCombinerConfig.cycles.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Active Cycles:</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #555' }}>
                <th style={{ textAlign: 'left', padding: '2px 4px' }}>On</th>
                <th style={{ textAlign: 'left', padding: '2px 4px' }}>Days</th>
                <th style={{ textAlign: 'left', padding: '2px 4px' }}>Weight</th>
                <th style={{ padding: '2px 4px' }}></th>
              </tr>
            </thead>
            <tbody>
              {cycleCombinerConfig.cycles.map((cycle, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid #333' }}>
                  <td style={{ padding: '3px 4px' }}>
                    <input
                      type="checkbox"
                      checked={cycle.enabled}
                      onChange={() => updateCycleInput(idx, { enabled: !cycle.enabled })}
                    />
                  </td>
                  <td style={{ padding: '3px 4px', fontFamily: 'monospace' }}>
                    {cycle.offsetDays}
                  </td>
                  <td style={{ padding: '3px 4px' }}>
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      value={cycle.weight}
                      onChange={e => updateCycleInput(idx, { weight: parseFloat(e.target.value) || 0 })}
                      style={{ width: 50, background: isDark ? '#333' : '#fff', color: isDark ? '#fff' : '#000', border: '1px solid #555', borderRadius: 3, padding: '1px 3px' }}
                    />
                  </td>
                  <td style={{ padding: '3px 4px', textAlign: 'center' }}>
                    <button
                      onClick={() => removeCycleInput(idx)}
                      style={{ background: 'none', border: 'none', color: '#ef5350', cursor: 'pointer', fontSize: 14 }}
                      title="Remove"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recompute button */}
      <button
        onClick={recomputeCycleCombiner}
        style={{
          width: '100%',
          padding: '6px 0',
          background: '#388e3c',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 12,
        }}
      >
        Recompute
      </button>

      {/* Status */}
      {cycleCombinerOutput && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
          Output range: {cycleCombinerOutput.min.toFixed(3)} to {cycleCombinerOutput.max.toFixed(3)}
        </div>
      )}
    </div>
  );
};
