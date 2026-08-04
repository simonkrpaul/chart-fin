/**
 * LayoutGrid – renders ChartPanel instances in the CSS grid arrangement
 * dictated by the current layoutType from layoutStore.
 *
 * Layout grid templates:
 *   '1'    1 column, 1 row
 *   '2h'   2 columns, 1 row  (side-by-side)
 *   '2v'   1 column, 2 rows  (stacked)
 *   '3h'   3 columns, 1 row
 *   '2x2'  2 columns, 2 rows
 */
import React from 'react';
import { useLayoutStore, LAYOUT_PANEL_IDS } from '../store/layoutStore';
import type { LayoutType } from '../store/layoutStore';
import { ChartPanel } from './ChartPanel';

const GRID_STYLE: Record<LayoutType, React.CSSProperties> = {
  '1':   { gridTemplateColumns: '1fr',      gridTemplateRows: '1fr' },
  '2h':  { gridTemplateColumns: '1fr 1fr',  gridTemplateRows: '1fr' },
  '2v':  { gridTemplateColumns: '1fr',      gridTemplateRows: '1fr 1fr' },
  '3h':  { gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr' },
  '2x2': { gridTemplateColumns: '1fr 1fr',  gridTemplateRows: '1fr 1fr' },
};

export const LayoutGrid: React.FC = () => {
  const { layoutType, activePanelId } = useLayoutStore();
  // In single-panel mode, show whichever panel was active (TradingView behavior)
  const panelIds = layoutType === '1' ? [activePanelId] : LAYOUT_PANEL_IDS[layoutType];

  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        ...GRID_STYLE[layoutType],
        overflow: 'hidden',
        gap: 2,
      }}
    >
      {panelIds.map((id) => (
        <ChartPanel key={id} panelId={id} />
      ))}
    </div>
  );
};
