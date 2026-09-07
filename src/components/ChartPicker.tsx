/**
 * ChartPicker — the everyday "open a chart" surface.
 *
 * Reads only from IndexedDB. Two lists side-by-side:
 *   • Saved layouts    – click to load with drawings/indicators/viewport.
 *   • Series in DB     – market/symbol/timeframe. TF list is derived from
 *                        availableTimeframes + resample fallback.
 *
 * If nothing is selectable yet the user is nudged toward "+ Ingest data",
 * which opens the IngestionPanel.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import {
  ensureMarkets,
  ingestManifest,
  ingestOne,
  listMarketsForPicker,
  selectableTimeframes,
  type PickerMarket,
} from '../db/marketDb';
import { listLayoutsDb } from '../db/marketStore';
import { openSeries, openLayout, setDefaultLayout, getDefaultLayoutId } from '../store/chartSession';
import type { ChartLayout, Timeframe } from '../types';
import { IngestionPanel } from './IngestionPanel';

export const ChartPicker: React.FC = () => {
  const { theme } = useChartStore();
  const [open, setOpen]         = useState(false);
  const [ingestOpen, setIngest] = useState(false);
  const [markets, setMarkets]   = useState<PickerMarket[]>([]);
  const [layouts, setLayouts]   = useState<ChartLayout[]>([]);
  const [defaultId, setDefaultId] = useState<string | undefined>(undefined);
  const [marketId, setMarketId] = useState<string>('crypto');
  const [symbol, setSymbol]     = useState<string>('');
  const [tf, setTf]             = useState<Timeframe>('1d');
  const [loadAll, setLoadAll]   = useState(false);
  const [status, setStatus]     = useState<string>('');
  const [busy, setBusy]         = useState(false);

  const bg     = theme === 'dark' ? '#1e222d' : '#f0f3fa';
  const bgCard = theme === 'dark' ? '#131722' : '#ffffff';
  const text   = theme === 'dark' ? '#d1d4dc' : '#131722';
  const border = theme === 'dark' ? '#2a2e39' : '#c8cad5';
  const accent = '#2962ff';

  const refresh = useCallback(async () => {
    const [m, l, d] = await Promise.all([
      listMarketsForPicker(),
      listLayoutsDb(),
      getDefaultLayoutId(),
    ]);
    setMarkets(m);
    setLayouts(l);
    setDefaultId(d);
  }, []);

  useEffect(() => {
    if (!open) return;
    (async () => {
      await ensureMarkets();
      await refresh();
    })();
  }, [open, refresh]);

  // Auto-refresh the picker as background ingest progresses so newly-ready
  // symbols flip from "pending" → "ready" without a manual reopen.
  useEffect(() => {
    if (!open) return;
    let lastRefresh = 0;
    const handler = () => {
      const now = performance.now();
      if (now - lastRefresh < 800) return; // throttle
      lastRefresh = now;
      void refresh();
    };
    window.addEventListener('manifest-ingest-progress', handler);
    return () => window.removeEventListener('manifest-ingest-progress', handler);
  }, [open, refresh]);

  const currentMarket = useMemo(
    () => markets.find(m => m.id === marketId),
    [markets, marketId],
  );
  const currentSymbolRecord = useMemo(
    () => currentMarket?.symbols.find(s => s.symbol === symbol),
    [currentMarket, symbol],
  );
  const tfOptions = useMemo(
    () => selectableTimeframes(currentSymbolRecord),
    [currentSymbolRecord],
  );

  // Auto-pick first symbol/TF when market changes.
  useEffect(() => {
    if (!currentMarket) return;
    if (currentMarket.symbols.length === 0) { setSymbol(''); return; }
    if (!currentMarket.symbols.find(s => s.symbol === symbol)) {
      const first = currentMarket.symbols[0];
      setSymbol(first.symbol);
      setTf(first.baseTimeframe);
    }
  }, [currentMarket, symbol]);

  useEffect(() => {
    if (tfOptions.length === 0) return;
    if (!tfOptions.includes(tf)) setTf(tfOptions[tfOptions.length - 1]);
  }, [tfOptions, tf]);

  // Auto-toggle "Load entire history" based on TF: 25 years of daily bars
  // is ~6 k rows and loads in <100 ms, so default to on. Minute/hour TFs
  // can be millions of rows so default to off (last 2 000).
  useEffect(() => {
    const coarse = tf === '1d' || tf === '1w' || tf === '1M';
    setLoadAll(coarse);
  }, [tf]);

  const handleOpenSeries = useCallback(async () => {
    if (!symbol) { setStatus('No symbol selected'); return; }
    setBusy(true);
    const t0 = performance.now();
    try {
      // Priority ingest: if the picked symbol is still "pending" in the
      // manifest (background ingest hasn't reached it yet), fetch just that
      // one CSV now so the user doesn't wait for the whole queue.
      if (currentSymbolRecord && currentSymbolRecord.status === 'pending' && currentSymbolRecord.manifestUrl) {
        setStatus(`Fetching ${symbol}…`);
        try {
          const written = await ingestOne({
            market: marketId,
            symbol,
            timeframe: currentSymbolRecord.baseTimeframe,
            url: currentSymbolRecord.manifestUrl,
          });
          setStatus(`Fetched ${written.toLocaleString()} rows, opening…`);
        } catch (e) {
          setStatus(`✗ Priority fetch failed: ${(e as Error).message}`);
          setBusy(false);
          return;
        }
      } else {
        setStatus(loadAll ? 'Loading everything…' : 'Loading…');
      }

      const res = await openSeries(marketId, symbol, tf, loadAll ? Infinity : 2000);
      if (!res.ok) { setStatus(res.message ?? 'Failed'); setBusy(false); return; }
      const dt = (performance.now() - t0).toFixed(1);
      setStatus(`✓ ${res.rows.toLocaleString()} bars · ${dt} ms${res.resampled ? ` · resampled from ${res.sourceTimeframe}` : ''}`);
      setOpen(false);
    } catch (e) {
      setStatus(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [marketId, symbol, tf, loadAll, currentSymbolRecord]);

  const handleOpenLayout = useCallback(async (layout: ChartLayout) => {
    setBusy(true); setStatus(`Loading "${layout.name}"…`);
    try {
      const res = await openLayout(layout);
      setStatus(res.rows > 0
        ? `✓ Loaded "${layout.name}" · ${res.rows} bars`
        : `✓ Loaded "${layout.name}" (no series)`);
      setOpen(false);
    } catch (e) {
      setStatus(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRescan = useCallback(async () => {
    setStatus('Rescan started — badge shows progress. Pick any symbol to jump the queue.');
    // Fire-and-forget in the background. The progress badge tracks it via
    // `manifest-ingest-progress` events, and the picker auto-refreshes as
    // symbols become ready.
    void ingestManifest(undefined, { force: true, background: true, concurrency: 3 });
    await refresh();
  }, [refresh]);

  const handleTogglePin = useCallback(async (e: React.MouseEvent, layout: ChartLayout) => {
    e.stopPropagation();
    const next = defaultId === layout.id ? null : layout.id;
    await setDefaultLayout(next);
    setDefaultId(next ?? undefined);
  }, [defaultId]);

  const btnStyle: React.CSSProperties = {
    background: 'transparent', color: text, border: `1px solid ${border}`,
    borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
  };

  return (
    <>
      <button style={btnStyle} onClick={() => setOpen(true)} title="Open a chart from the local DB or a saved layout">
        📈 Open chart
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: bg, color: text, border: `1px solid ${border}`, borderRadius: 8,
              padding: 16, width: 720, maxHeight: '80vh', overflow: 'auto',
              boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Open chart</h3>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btnStyle} onClick={handleRescan} disabled={busy}
                        title="Re-read public/data/markets/manifest.json — picks up files added by Python scripts.">
                  ↻ Rescan disk
                </button>
                <button style={btnStyle} onClick={() => { setIngest(true); }}>+ Ingest data</button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {/* Saved layouts */}
              <section>
                <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>Saved layouts</div>
                {layouts.length === 0
                  ? <div style={{ opacity: 0.5, fontSize: 12 }}>None yet.</div>
                  : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {layouts.map(l => {
                        const pinned = defaultId === l.id;
                        return (
                          <div
                            key={l.id}
                            style={{ display: 'flex', gap: 4 }}
                          >
                            <button
                              onClick={() => handleOpenLayout(l)}
                              style={{ ...btnStyle, textAlign: 'left', background: bgCard, flex: 1 }}
                            >
                              <div style={{ fontSize: 12 }}>
                                {pinned ? '★ ' : ''}{l.name}
                              </div>
                              <div style={{ fontSize: 10, opacity: 0.6 }}>
                                {l.timeframe}
                                {l.series ? ` · ${l.series.market}/${l.series.symbol}` : ''}
                                {' · '}{new Date(l.updatedAt).toLocaleString()}
                              </div>
                            </button>
                            <button
                              onClick={e => handleTogglePin(e, l)}
                              title={pinned ? 'Unpin default' : 'Pin as default (loads on boot)'}
                              style={{ ...btnStyle, padding: '4px 8px' }}
                            >
                              {pinned ? '★' : '☆'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )
                }
              </section>

              {/* Series in DB */}
              <section>
                <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>Series in DB</div>
                <label style={{ fontSize: 11, opacity: 0.7 }}>Market</label>
                <select
                  value={marketId}
                  onChange={e => setMarketId(e.target.value)}
                  style={{ ...btnStyle, width: '100%', marginBottom: 6 }}
                >
                  {markets.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>

                <label style={{ fontSize: 11, opacity: 0.7 }}>Symbol</label>
                <select
                  value={symbol}
                  onChange={e => setSymbol(e.target.value)}
                  style={{ ...btnStyle, width: '100%', marginBottom: 6 }}
                >
                  {(currentMarket?.symbols ?? []).map(s => {
                    const suffix = s.status === 'pending'
                      ? '(pending)'
                      : ((s.availableTimeframes ?? []).join(', ') || 'no data');
                    return (
                      <option key={s.symbol} value={s.symbol}>
                        {s.symbol} ({suffix})
                      </option>
                    );
                  })}
                  {(currentMarket?.symbols.length ?? 0) === 0 && <option value="">(none)</option>}
                </select>

                <label style={{ fontSize: 11, opacity: 0.7 }}>Timeframe</label>
                <select
                  value={tf}
                  onChange={e => setTf(e.target.value as Timeframe)}
                  disabled={tfOptions.length === 0}
                  style={{ ...btnStyle, width: '100%', marginBottom: 10 }}
                >
                  {tfOptions.map(o => {
                    const stored = (currentSymbolRecord?.availableTimeframes ?? []).includes(o);
                    return <option key={o} value={o}>{o}{stored ? '' : ' (derived)'}</option>;
                  })}
                </select>

                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, opacity: 0.9, marginBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={loadAll} onChange={e => setLoadAll(e.target.checked)} />
                  Load entire history
                  {currentSymbolRecord?.candleCount && (
                    <span style={{ opacity: 0.6 }}>
                      ({currentSymbolRecord.candleCount.toLocaleString()} bars)
                    </span>
                  )}
                </label>

                <button
                  onClick={handleOpenSeries}
                  disabled={busy || !symbol}
                  style={{
                    ...btnStyle,
                    background: symbol ? accent : 'transparent',
                    color: symbol ? '#fff' : text,
                    borderColor: symbol ? accent : border,
                    width: '100%',
                    opacity: (busy || !symbol) ? 0.6 : 1,
                  }}
                >
                  {busy ? 'Loading…' : (loadAll ? 'Open (all bars)' : 'Open (last 2 000)')}
                </button>
              </section>
            </div>

            {status && <div style={{ marginTop: 12, fontSize: 11, opacity: 0.8 }}>{status}</div>}
          </div>
        </div>
      )}

      {ingestOpen && (
        <IngestionPanel
          initial={{ market: marketId, symbol, timeframe: tf }}
          onClose={async (didIngest) => {
            setIngest(false);
            if (didIngest) await refresh();
          }}
        />
      )}
    </>
  );
};
