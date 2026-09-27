/**
 * Sidebar – vertical icon rail + single active panel container.
 *
 * Replaces the previous stack of six always-expanded panels. Each panel
 * (Indicators, Backtest, Overlays, Journal, Ephemeris, Cycles) is now
 * reached through an icon tab on the left rail; only the active panel is
 * mounted at a time. A collapse button hides the content pane entirely.
 *
 * Panel internals are unchanged — this is pure layout / navigation.
 */
import React, { useEffect, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import { IndicatorPanel } from './IndicatorPanel';
import { BacktestPanel } from './BacktestPanel';
import { OverlayPanel } from './OverlayPanel';
import { TradeJournalPanel } from './TradeJournalPanel';
import { EphemerisPanel } from './EphemerisPanel';
import { CycleCombinerPanel } from './CycleCombinerPanel';
import { HurstCyclesPanel } from '../hurst/HurstCyclesPanel';

type TabKey = 'indicators' | 'backtest' | 'overlays' | 'journal' | 'ephemeris' | 'cycles' | 'hurst';

interface TabDef {
  key: TabKey;
  label: string;
  icon: string;
  render: () => React.ReactNode;
}

const TABS: TabDef[] = [
  { key: 'indicators', label: 'Indicators',     icon: '📈', render: () => <IndicatorPanel /> },
  { key: 'backtest',   label: 'Strategy Tester', icon: '⚡', render: () => <BacktestPanel /> },
  { key: 'overlays',   label: 'Offset Overlays', icon: '📊', render: () => <OverlayPanel /> },
  { key: 'journal',    label: 'Trade Journal',   icon: '📝', render: () => <TradeJournalPanel /> },
  { key: 'ephemeris',  label: 'Ephemeris',       icon: '○□△', render: () => <EphemerisPanel /> },
  { key: 'cycles',     label: 'Cycle Combiner',  icon: '🌀', render: () => <CycleCombinerPanel /> },
  { key: 'hurst',      label: 'Hurst Cycles',    icon: '〰️', render: () => <HurstCyclesPanel /> },
];

const LS_TAB = 'chartfin.sidebar.activeTab';
const LS_COLLAPSED = 'chartfin.sidebar.collapsed';

function readTab(): TabKey {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_TAB) : null;
  return (TABS.find(t => t.key === v)?.key) ?? 'indicators';
}
function readCollapsed(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(LS_COLLAPSED) === '1';
}

export const Sidebar: React.FC = () => {
  const { theme, themeTokens } = useChartStore();
  const isDark = theme === 'dark';
  const border = themeTokens.gridLine;
  const bg = themeTokens.background;
  const text = themeTokens.axisText;
  const railBg = isDark ? '#0f1420' : '#f5f6f9';
  const activeBg = isDark ? '#1c2333' : '#e6ebf5';
  const accent = '#2962ff';

  const [tab, setTab] = useState<TabKey>(() => readTab());
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());

  useEffect(() => { localStorage.setItem(LS_TAB, tab); }, [tab]);
  useEffect(() => { localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0'); }, [collapsed]);

  const activeTab = TABS.find(t => t.key === tab) ?? TABS[0];

  return (
    <div style={{ display: 'flex', height: '100%', borderRight: `1px solid ${border}`, flexShrink: 0 }}>
      {/* ── Icon rail ───────────────────────────────────────────────── */}
      <div
        style={{
          width: 44,
          flexShrink: 0,
          background: railBg,
          borderRight: collapsed ? 'none' : `1px solid ${border}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          padding: '6px 0',
          gap: 2,
        }}
      >
        {TABS.map(t => {
          const isActive = !collapsed && t.key === tab;
          return (
            <button
              key={t.key}
              onClick={() => {
                // Clicking the active tab toggles collapse; otherwise switch.
                if (t.key === tab && !collapsed) {
                  setCollapsed(true);
                } else {
                  setTab(t.key);
                  setCollapsed(false);
                }
              }}
              title={t.label}
              aria-label={t.label}
              aria-pressed={isActive}
              style={{
                position: 'relative',
                height: 40,
                border: 'none',
                background: isActive ? activeBg : 'transparent',
                color: isActive ? (isDark ? '#fff' : '#111') : text,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: t.icon.length > 2 ? 11 : 18,
                letterSpacing: t.icon.length > 2 ? 1 : 0,
                padding: 0,
                margin: '0 4px',
                borderRadius: 4,
              }}
              onMouseEnter={e => {
                if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = isDark ? '#161c29' : '#ecedf1';
              }}
              onMouseLeave={e => {
                if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              {isActive && (
                <span
                  style={{
                    position: 'absolute',
                    left: -4,
                    top: 6,
                    bottom: 6,
                    width: 3,
                    background: accent,
                    borderRadius: 2,
                  }}
                />
              )}
              <span aria-hidden="true">{t.icon}</span>
            </button>
          );
        })}

        {/* Spacer + collapse toggle at the bottom of the rail */}
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            height: 32,
            border: 'none',
            background: 'transparent',
            color: text,
            cursor: 'pointer',
            fontSize: 14,
            margin: '0 4px',
            borderRadius: 4,
          }}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {/* ── Active panel content ─────────────────────────────────────── */}
      {!collapsed && (
        <div
          style={{
            width: 260,
            flexShrink: 0,
            background: bg,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
          }}
        >
          {/* Panel header strip so the user always knows what section is active */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              borderBottom: `1px solid ${border}`,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.3,
              textTransform: 'uppercase',
              color: text,
              background: railBg,
              flexShrink: 0,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: activeTab.icon.length > 2 ? 10 : 13, letterSpacing: activeTab.icon.length > 2 ? 1 : 0 }}>{activeTab.icon}</span>
            <span>{activeTab.label}</span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {activeTab.render()}
          </div>
        </div>
      )}
    </div>
  );
};
