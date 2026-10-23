/**
 * MobileShell – phone layout: slim top bar, scrolling timeframe chips,
 * full-bleed chart, bottom tab bar, and panels in slide-up sheets.
 * Reuses the desktop panels and chart store unchanged.
 */
import React, { useCallback, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { useResizeObserver } from '../hooks/useResizeObserver';
import { ChartCanvas } from './ChartCanvas';
import { CandleTooltip } from './CandleTooltip';
import { ChartControls } from './ChartControls';
import { ReplayControls } from './ReplayControls';
import { MeasurementOverlay } from './MeasurementOverlay';
import { BacktestReport } from './BacktestReport';
import { ChartPicker } from './ChartPicker';
import { TimezoneNativeSelect } from './TimezoneSelector';
import { TIMEFRAMES, TOOLS } from './toolbarConfig';
import { TABS, type TabKey } from './sidebarTabs';

type Sheet = null | 'draw' | 'more' | TabKey;

const ACCENT = '#2962ff';
const TOUCH = 44;
const NAV_HEIGHT = 56;
// Panels that need the desktop machine (loopback-only API) are hidden on phones.
const MOBILE_PANELS = TABS.filter(t => t.key !== 'scripts');

export const MobileShell: React.FC = () => {
  const {
    theme, setTheme, themeTokens,
    timeframe, setTimeframe,
    activeDrawingTool, setDrawingTool,
    showIndicatorsAndDrawings, toggleIndicatorsAndDrawingsVisibility,
    gapVisibility, toggleEmptyGapSlots,
    undoDrawing, redoDrawing, past, future,
    currentSeries,
  } = useChartStore();
  const { ref, width, height } = useResizeObserver<HTMLDivElement>();
  const [sheet, setSheet] = useState<Sheet>(null);

  const isDark = theme === 'dark';
  const bg = themeTokens.background;
  const barBg = isDark ? '#1e222d' : '#f0f3fa';
  const text = isDark ? '#d1d4dc' : '#131722';
  const muted = isDark ? '#787b86' : '#6a6d78';
  const border = isDark ? '#2a2e39' : '#e0e3eb';

  const close = useCallback(() => setSheet(null), []);

  const handleScreenshot = useCallback(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-chart-canvas]');
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `chart-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }, []);

  const iconBtn = (disabled = false): React.CSSProperties => ({
    minWidth: TOUCH, height: TOUCH, border: 'none', background: 'transparent',
    color: text, fontSize: 18, opacity: disabled ? 0.35 : 1, cursor: 'pointer', padding: '0 8px',
  });

  const chip = (active: boolean): React.CSSProperties => ({
    flexShrink: 0, height: 32, padding: '0 14px', borderRadius: 16, fontSize: 13,
    border: `1px solid ${active ? ACCENT : border}`,
    background: active ? ACCENT : 'transparent',
    color: active ? '#fff' : text, cursor: 'pointer',
  });

  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    minHeight: TOUCH, padding: '0 4px', borderBottom: `1px solid ${border}`, fontSize: 14, color: text,
  };

  const rowBtn: React.CSSProperties = {
    ...row, width: '100%', background: 'transparent', border: 'none',
    borderBottom: `1px solid ${border}`, textAlign: 'left', cursor: 'pointer',
  };

  const seriesLabel = currentSeries ? currentSeries.symbol : 'Open chart';
  const panel = MOBILE_PANELS.find(t => t.key === sheet);
  const sheetTitle = sheet === 'draw' ? 'Drawing tools' : sheet === 'more' ? 'More' : panel?.label ?? '';

  const navItems: { key: Sheet; icon: string; label: string }[] = [
    { key: null, icon: '📈', label: 'Chart' },
    { key: 'draw', icon: '✎', label: 'Draw' },
    { key: 'indicators', icon: 'ƒx', label: 'Indicators' },
    { key: 'more', icon: '☰', label: 'More' },
  ];
  const navActive = (key: Sheet) =>
    key === sheet || (key === 'more' && sheet !== null && sheet !== 'draw' && sheet !== 'indicators');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: bg, color: text }}>
      {/* Top bar */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 4, background: barBg,
          borderBottom: `1px solid ${border}`, flexShrink: 0,
          paddingTop: 'env(safe-area-inset-top)',
          paddingLeft: 'max(6px, env(safe-area-inset-left))',
          paddingRight: 'max(6px, env(safe-area-inset-right))',
        }}
      >
        <ChartPicker
          triggerLabel={<><b>{seriesLabel}</b> <span style={{ opacity: 0.6 }}>▾</span></>}
          triggerStyle={{ height: 36, fontSize: 15, border: 'none', padding: '0 8px', maxWidth: '50vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        />
        <div style={{ flex: 1 }} />
        <button style={iconBtn(past.length === 0)} disabled={past.length === 0} onClick={undoDrawing} aria-label="Undo">↩</button>
        <button style={iconBtn(future.length === 0)} disabled={future.length === 0} onClick={redoDrawing} aria-label="Redo">↪</button>
        <button style={iconBtn()} onClick={() => setTheme(isDark ? 'light' : 'dark')} aria-label="Toggle theme">
          {isDark ? '☀' : '☾'}
        </button>
      </div>

      {/* Timeframe chips */}
      <div
        style={{
          display: 'flex', gap: 6, overflowX: 'auto', padding: '6px 8px', flexShrink: 0,
          borderBottom: `1px solid ${border}`, background: barBg, scrollbarWidth: 'none',
        }}
      >
        {TIMEFRAMES.map(tf => (
          <button key={tf} style={chip(timeframe === tf)} onClick={() => setTimeframe(tf)}>{tf}</button>
        ))}
      </div>

      {/* Active drawing tool hint */}
      {activeDrawingTool !== 'none' && (
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
            padding: '4px 10px', fontSize: 12, background: ACCENT, color: '#fff',
          }}
        >
          <span>{TOOLS.find(t => t.key === activeDrawingTool)?.label} — tap the chart to draw</span>
          <button
            onClick={() => setDrawingTool('none')}
            style={{ background: 'transparent', border: '1px solid #fff', color: '#fff', borderRadius: 4, padding: '2px 10px' }}
          >
            Done
          </button>
        </div>
      )}

      {/* Chart */}
      <div ref={ref} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {width > 0 && height > 0 && (
          <>
            <ChartCanvas width={width} height={height} />
            <CandleTooltip />
            <ChartControls />
            <ReplayControls />
            <MeasurementOverlay />
          </>
        )}
      </div>
      <BacktestReport />

      {/* Bottom tab bar */}
      <nav
        style={{
          display: 'flex', flexShrink: 0, background: barBg, borderTop: `1px solid ${border}`,
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        {navItems.map(item => {
          const active = navActive(item.key);
          return (
            <button
              key={item.label}
              onClick={() => setSheet(active && item.key !== null ? null : item.key)}
              style={{
                flex: 1, height: NAV_HEIGHT, border: 'none', background: 'transparent', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                color: active ? ACCENT : muted,
              }}
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>{item.icon}</span>
              <span style={{ fontSize: 11 }}>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom sheet */}
      {sheet !== null && (
        <div
          onClick={close}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: `calc(${NAV_HEIGHT}px + env(safe-area-inset-bottom))`,
            background: 'rgba(0,0,0,0.35)', zIndex: 900,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80%',
              display: 'flex', flexDirection: 'column', background: barBg,
              borderTopLeftRadius: 14, borderTopRightRadius: 14, boxShadow: '0 -8px 30px rgba(0,0,0,0.4)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 6 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, background: border }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', borderBottom: `1px solid ${border}` }}>
              {panel && panel.key !== 'indicators' && (
                <button style={iconBtn()} onClick={() => setSheet('more')} aria-label="Back">‹</button>
              )}
              <span style={{ flex: 1, fontWeight: 600, fontSize: 15, paddingLeft: 6 }}>{sheetTitle}</span>
              <button style={iconBtn()} onClick={close} aria-label="Close">✕</button>
            </div>

            <div style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1, padding: sheet === 'draw' || sheet === 'more' ? 10 : 0 }}>
              {sheet === 'draw' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                    {TOOLS.map(t => {
                      const active = activeDrawingTool === t.key;
                      return (
                        <button
                          key={t.key}
                          onClick={() => { setDrawingTool(t.key); close(); }}
                          style={{
                            minHeight: 56, borderRadius: 8, fontSize: 13, cursor: 'pointer',
                            border: `1px solid ${active ? ACCENT : border}`,
                            background: active ? ACCENT : 'transparent',
                            color: active ? '#fff' : text,
                          }}
                        >
                          {t.label}
                        </button>
                      );
                    })}
                  </div>
                  <button style={{ ...rowBtn, marginTop: 10 }} onClick={toggleIndicatorsAndDrawingsVisibility}>
                    <span>Show indicators & drawings</span>
                    <span>{showIndicatorsAndDrawings ? 'On' : 'Off'}</span>
                  </button>
                </>
              )}

              {sheet === 'more' && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
                    {MOBILE_PANELS.filter(t => t.key !== 'indicators').map(t => (
                      <button
                        key={t.key}
                        onClick={() => setSheet(t.key)}
                        style={{
                          minHeight: 64, borderRadius: 8, border: `1px solid ${border}`, background: 'transparent',
                          color: text, cursor: 'pointer', display: 'flex', flexDirection: 'column',
                          alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 11,
                        }}
                      >
                        <span style={{ fontSize: t.icon.length > 2 ? 12 : 20 }}>{t.icon}</span>
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <button style={rowBtn} onClick={() => { close(); window.dispatchEvent(new Event('open-goto-date')); }}>
                    <span>Go to date</span><span>›</span>
                  </button>
                  <button style={rowBtn} onClick={toggleEmptyGapSlots}>
                    <span>Gaps</span>
                    <span>{gapVisibility === 'session_trading_days' ? 'Trading days' : 'Calendar days'}</span>
                  </button>
                  <div style={row}>
                    <span>Timezone</span>
                    <TimezoneNativeSelect
                      style={{
                        height: 34, fontSize: 14, maxWidth: '60%', borderRadius: 6, padding: '0 6px',
                        background: 'transparent', color: text, border: `1px solid ${border}`,
                      }}
                    />
                  </div>
                  <button style={rowBtn} onClick={handleScreenshot}>
                    <span>Save screenshot</span><span>›</span>
                  </button>
                </>
              )}

              {panel && panel.render()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
