import type React from 'react';
import { IndicatorPanel } from './IndicatorPanel';
import { BacktestPanel } from './BacktestPanel';
import { OverlayPanel } from './OverlayPanel';
import { TradeJournalPanel } from './TradeJournalPanel';
import { EphemerisPanel } from './EphemerisPanel';
import { CycleCombinerPanel } from './CycleCombinerPanel';
import { HurstCyclesPanel } from '../hurst/HurstCyclesPanel';
import { ScriptsPanel } from './ScriptsPanel';

export type TabKey = 'indicators' | 'backtest' | 'overlays' | 'journal' | 'ephemeris' | 'cycles' | 'hurst' | 'scripts';

export interface TabDef {
  key: TabKey;
  label: string;
  icon: string;
  render: () => React.ReactNode;
}

export const TABS: TabDef[] = [
  { key: 'indicators', label: 'Indicators',     icon: '📈', render: () => <IndicatorPanel /> },
  { key: 'backtest',   label: 'Strategy Tester', icon: '⚡', render: () => <BacktestPanel /> },
  { key: 'overlays',   label: 'Offset Overlays', icon: '📊', render: () => <OverlayPanel /> },
  { key: 'journal',    label: 'Trade Journal',   icon: '📝', render: () => <TradeJournalPanel /> },
  { key: 'ephemeris',  label: 'Ephemeris',       icon: '○□△', render: () => <EphemerisPanel /> },
  { key: 'cycles',     label: 'Cycle Combiner',  icon: '🌀', render: () => <CycleCombinerPanel /> },
  { key: 'hurst',      label: 'Hurst Cycles',    icon: '〰️', render: () => <HurstCyclesPanel /> },
  { key: 'scripts',    label: 'Data Scripts',    icon: '⟳', render: () => <ScriptsPanel /> },
];
