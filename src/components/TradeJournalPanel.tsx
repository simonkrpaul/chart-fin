/**
 * TradeJournalPanel – upload/view trade log CSV, see matched round-trips,
 * and toggle visibility on the chart.
 */
import React, { useRef, useMemo } from 'react';
import { useChartStore } from '../store/chartStore';

export const TradeJournalPanel: React.FC = () => {
  const {
    tradeLogEntries,
    tradeLogRoundTrips,
    showTradeLog,
    loadTradeLog,
    clearTradeLog,
    toggleTradeLog,
    theme,
  } = useChartStore();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const bg     = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const text   = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#e0e3eb';
  const subtle = theme === 'dark' ? '#2a2e39' : '#e0e3eb';

  const stats = useMemo(() => {
    if (!tradeLogRoundTrips.length) return null;
    const wins = tradeLogRoundTrips.filter(t => t.pnlPct > 0);
    const losses = tradeLogRoundTrips.filter(t => t.pnlPct <= 0);
    const totalPnl = tradeLogRoundTrips.reduce((s, t) => s + t.pnlUsd, 0);
    const totalFees = tradeLogRoundTrips.reduce((s, t) => s + t.totalFees, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
    return {
      total: tradeLogRoundTrips.length,
      wins: wins.length,
      losses: losses.length,
      winRate: (wins.length / tradeLogRoundTrips.length) * 100,
      totalPnl,
      totalFees,
      netPnl: totalPnl - totalFees,
      avgWin,
      avgLoss,
    };
  }, [tradeLogRoundTrips]);

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const csvText = reader.result as string;
      loadTradeLog(csvText);
    };
    reader.readAsText(file);
    // Reset input so re-uploading same file works
    e.target.value = '';
  }

  return (
    <div style={{ background: bg, color: text, padding: 12, width: '100%', boxSizing: 'border-box', overflowY: 'auto', fontSize: 12, borderTop: `1px solid ${border}` }}>
      <div style={{ fontWeight: 600, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Trade Journal</span>
        {tradeLogEntries.length > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 400, cursor: 'pointer' }}>
            <input type="checkbox" checked={showTradeLog} onChange={toggleTradeLog} />
            Show
          </label>
        )}
      </div>

      {/* Upload button */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleUpload}
        style={{ display: 'none' }}
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        style={{
          width: '100%', marginBottom: 6, padding: '5px 0',
          background: '#2962ff', color: '#fff',
          border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
        }}
      >
        {tradeLogEntries.length > 0 ? 'Re-upload CSV' : 'Upload Trade Log CSV'}
      </button>

      {tradeLogEntries.length > 0 && (
        <button
          onClick={clearTradeLog}
          style={{
            width: '100%', marginBottom: 8, padding: '4px 0',
            background: 'transparent', color: '#ef5350',
            border: '1px solid #ef5350', borderRadius: 4, cursor: 'pointer', fontSize: 10,
          }}
        >
          Clear
        </button>
      )}

      {/* Stats summary */}
      {stats && (
        <div style={{ background: subtle, borderRadius: 4, padding: 8, marginBottom: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 11 }}>
            <span style={{ opacity: 0.6 }}>Trades:</span>
            <span style={{ fontWeight: 500 }}>{stats.total}</span>

            <span style={{ opacity: 0.6 }}>Win Rate:</span>
            <span style={{ fontWeight: 500, color: stats.winRate >= 50 ? '#26a69a' : '#ef5350' }}>
              {stats.winRate.toFixed(1)}% ({stats.wins}W / {stats.losses}L)
            </span>

            <span style={{ opacity: 0.6 }}>Net P&L:</span>
            <span style={{ fontWeight: 600, color: stats.netPnl >= 0 ? '#26a69a' : '#ef5350' }}>
              ${stats.netPnl.toFixed(2)}
            </span>

            <span style={{ opacity: 0.6 }}>Total Fees:</span>
            <span style={{ fontWeight: 500 }}>${stats.totalFees.toFixed(2)}</span>

            <span style={{ opacity: 0.6 }}>Avg Win:</span>
            <span style={{ fontWeight: 500, color: '#26a69a' }}>{stats.avgWin.toFixed(2)}%</span>

            <span style={{ opacity: 0.6 }}>Avg Loss:</span>
            <span style={{ fontWeight: 500, color: '#ef5350' }}>{stats.avgLoss.toFixed(2)}%</span>
          </div>
        </div>
      )}

      {/* Recent trades list */}
      {tradeLogRoundTrips.length > 0 && (
        <div>
          <div style={{ opacity: 0.6, fontSize: 10, marginBottom: 4 }}>
            Recent trades ({tradeLogRoundTrips.length} total)
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {tradeLogRoundTrips.slice(-20).reverse().map(t => (
              <div
                key={t.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '3px 6px', marginBottom: 2,
                  background: subtle, borderRadius: 3, fontSize: 10,
                }}
              >
                <span style={{
                  fontWeight: 600, fontSize: 9,
                  color: t.direction === 'long' ? '#26a69a' : '#ef5350',
                  minWidth: 28,
                }}>
                  {t.direction === 'long' ? 'LONG' : 'SHORT'}
                </span>
                <span style={{ flex: 1, opacity: 0.7 }}>
                  {new Date(t.entryTimestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                <span style={{ opacity: 0.7 }}>${t.entryPrice.toFixed(0)}</span>
                <span style={{ fontWeight: 600, color: t.pnlPct >= 0 ? '#26a69a' : '#ef5350' }}>
                  {t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tradeLogEntries.length === 0 && (
        <div style={{ opacity: 0.5, fontSize: 10, marginTop: 4 }}>
          Upload a CSV trade log to plot entries/exits on the chart.
          <br />Supports: Bybit-style trade history exports.
        </div>
      )}
    </div>
  );
};
