# chart-fin Migration Guide

Unified data pipeline, DB-first chart loading, and TradingView-style layout persistence.

---

## TL;DR

- **One DB**: browser-native IndexedDB (`chart-fin-db`), optional DuckDB-WASM analytical layer on top.
- **One ingest path**: every source (Bybit, Alpaca-ready, Dukascopy-ready, CSV file, CSV URL, mock) implements `SourceAdapter`. `ingest(sourceId, params)` is the single write function.
- **One load surface**: `📈 Open chart` picker replaces four separate loaders.
- **Session-aware slots**: weekends/holidays render as empty-gap "underscore" slots; a toggle collapses them for markets like BTC.
- **TF-aware loads**: if a symbol only has `1d` in the DB, requesting `1w` transparently resamples from `1d`. The picker greys out anything not derivable.
- **Layouts persist series identity + indicators + drawings + viewport** and reopen the same view on server restart. Optional pin-as-default (★).

---

## Architecture at a glance

```
┌── Sources ─────────────────────────────┐
│ Bybit REST/WS  Alpaca*  Dukascopy*     │
│ CSV file  CSV URL  Mock generator      │   *scaffolded, plug-in per API
└──────────────┬─────────────────────────┘
               │  SourceAdapter.fetch()
               ▼
┌── Ingestion service ───────────────────┐
│ ingest(sourceId, params)               │
│ startStream(sourceId, params)          │
└──────────────┬─────────────────────────┘
               │  saveCandlesForSeries()
               ▼
┌── IndexedDB (chart-fin-db) ────────────┐
│ markets   symbols   ohlcv   layouts    │
│ settings                                │
└──────────────┬─────────────────────────┘
               │  loadInitialCandles() (TF-aware)
               │  loadCandlesBefore() (lazy backfill)
               ▼
┌── Chart store ─────────────────────────┐
│ session-aware slots · resample · gap   │
│ toggle · overlays · indicators         │
└──────────────┬─────────────────────────┘
               ▼
        Canvas renderer
```

---

## New files

### Database layer
| File | Purpose |
| --- | --- |
| [src/db/marketStore.ts](src/db/marketStore.ts) | IndexedDB schema (`markets`, `symbols`, `ohlcv`, `layouts`, `settings`), CRUD, `requestPersistentStorage()` |
| [src/db/marketDb.ts](src/db/marketDb.ts) | High-level facade: `ensureMarkets`, `ingestManifest`, `loadInitialCandles`, `loadCandlesBefore`, `selectableTimeframes`, `saveCandlesForSeries` |
| [src/db/duckdb.ts](src/db/duckdb.ts) | Optional DuckDB-WASM analytical layer, hydrated on demand from IndexedDB |

### Ingestion layer
| File | Purpose |
| --- | --- |
| [src/ingestion/types.ts](src/ingestion/types.ts) | `SourceAdapter`, `SourceParams`, `FieldDef` |
| [src/ingestion/registry.ts](src/ingestion/registry.ts) | `ADAPTERS` map — add a source = new file + one line |
| [src/ingestion/ingestionService.ts](src/ingestion/ingestionService.ts) | `ingest()` and `startStream()` — the single write path |
| [src/ingestion/adapters/csvFile.ts](src/ingestion/adapters/csvFile.ts) | Local file upload |
| [src/ingestion/adapters/csvUrl.ts](src/ingestion/adapters/csvUrl.ts) | Fetch a CSV/JSON from an HTTP URL |
| [src/ingestion/adapters/mock.ts](src/ingestion/adapters/mock.ts) | In-browser deterministic OHLCV generator |
| [src/ingestion/adapters/bybit.ts](src/ingestion/adapters/bybit.ts) | Public Bybit v5 REST paging + WebSocket kline stream |

### UI
| File | Purpose |
| --- | --- |
| [src/components/ChartPicker.tsx](src/components/ChartPicker.tsx) | Everyday "Open chart" modal (saved layouts + DB series) with default-layout pin |
| [src/components/IngestionPanel.tsx](src/components/IngestionPanel.tsx) | Admin dialog — adapter picker + auto-generated form from `paramsSchema` |

### Session / market model
| File | Purpose |
| --- | --- |
| [src/engine/marketPresets.ts](src/engine/marketPresets.ts) | CRYPTO / US_EQUITY / US_FUTURES / FOREX / ASX / LSE session configs |
| [src/store/chartSession.ts](src/store/chartSession.ts) | `openSeries`, `openLayout`, `restoreLastSession`, `setDefaultLayout` |
| [src/hooks/useLazyBackfill.ts](src/hooks/useLazyBackfill.ts) | Pan-left → prepend older bars from DB (TF-aware) |

### Python (data ops)
| File | Purpose |
| --- | --- |
| [scripts/mock_data.py](scripts/mock_data.py) | Generates 4 mock markets (crypto, us_eq, asx, forex) + rewrites manifest |
| [scripts/import_market.py](scripts/import_market.py) | Move any CSV into `public/data/markets/<market>/<symbol>_<tf>.csv` |
| [scripts/fill_gaps.py](scripts/fill_gaps.py) | Detect / repair missing bars; session-aware; forward/linear/zero_vol/amend |

---

## Removed files

| Deleted | Replaced by |
| --- | --- |
| `src/components/BybitLiveLoader.tsx` | `ingestion/adapters/bybit.ts` + `IngestionPanel` |
| `src/components/MarketDbLoader.tsx` | `ChartPicker` |
| `src/components/RemoteLoader.tsx` | `ingestion/adapters/csvUrl.ts` + `IngestionPanel` |
| `src/components/DataLoader.tsx` | `ingestion/adapters/csvFile.ts` + `IngestionPanel` |

---

## Data model changes

### `SymbolRecord` (breaking, additive)
```ts
interface SymbolRecord {
  market: string;
  symbol: string;
  exchange?: string;
  description?: string;
  baseTimeframe: Timeframe;              // finest TF ever ingested
  availableTimeframes: Timeframe[];      // NEW — set updated on every saveCandles
  firstTs?: number;
  lastTs?: number;
  candleCount?: number;
  updatedAt: number;
}
```

### `ChartLayout` (breaking, additive)
```ts
interface ChartLayout {
  ...existing fields...
  series?: {                             // NEW — series identity so reopens re-load data
    market: string;
    symbol: string;
    timeframe: Timeframe;
    sourceTimeframe?: Timeframe;
  };
}
```
Older layouts without `series` still open; they just don't auto-load data.

### `settings` object store — new keys
| Key | Value |
| --- | --- |
| `lastOpen` | `{ kind: 'series' \| 'layout', … }` — set on every open, used by `restoreLastSession()` |
| `defaultLayoutId` | string — pinned default; wins over `lastOpen` on boot |

---

## Key API surface

### Read path
```ts
// TF-aware; resamples from finest stored TF when the exact TF is missing.
const { candles, sourceTimeframe, resampled } =
  await loadInitialCandles(market, symbol, tf, 2000);

// Same behaviour, older-than-cursor. Used by useLazyBackfill.
const { candles } =
  await loadCandlesBefore(market, symbol, tf, cursorMs, 2000);

// Which TFs the picker should show for a symbol.
selectableTimeframes(symbolRecord);   // → ['1d', '1w', '1M'] etc.
```

### Write path
```ts
// One entry point for every source.
await ingest('bybit', {
  market: 'crypto', symbol: 'BTCUSDT', timeframe: '1m',
  extras: { category: 'linear', days: 14 },
});

// Live streaming (adapters that support it).
const unsubscribe = startStream('bybit', { market, symbol, timeframe, extras });
```

### Session orchestration
```ts
await openSeries(market, symbol, tf);           // load + mark lastOpen
await openLayout(layout);                       // apply + load series
await restoreLastSession();                     // call on boot
await setDefaultLayout(id | null);              // ★ pin
```

---

## TF-aware loading — how it decides

For each request `(market, symbol, tf)`:

1. If `tf` is in `symbol.availableTimeframes` → tail query returns rows directly. Fast path.
2. Else pick the **finest** stored TF that can resample up to `tf` (`canResample(source, tf)`). Query `count * ratio` rows, resample, return with `resampled: true`.
3. Else return `{ candles: [] }` and the picker shows an error.

Bundle overhead: none. Everything reuses the existing `resampleEngine`.

---

## Empty-gap slots (fixed during migration)

The `_ Gaps: On/Off` toggle now really collapses / restores weekend + holiday slots:

- **On** → session-aware grid (weekends kept, shaded band + underscore glyph).
- **Off** → weekend/holiday slots stripped and re-indexed, candles pack together.
- Works on all timeframes (1m through 1M). The previous bug where daily/weekly bypassed the calendar grid is fixed in `setTimeframe`.

Offset-cycle math still counts through the underlying calendar, so cycles are stable across the toggle.

---

## Restart / persistence guarantees

- IndexedDB is scoped by browser origin (`http://localhost:5173`). Same URL on restart → same data.
- On boot, [src/App.tsx](src/App.tsx) runs, in order:
  1. `requestPersistentStorage()` — asks the browser to mark our DB "persistent" (evict-resistant).
  2. `ensureMarkets()` — idempotent preset seed.
  3. `ingestManifest()` — imports any new CSV in `public/data/markets/manifest.json` that isn't yet loaded (per-TF check).
  4. `restoreLastSession()` — pinned default layout wins; otherwise last `openSeries` / `openLayout` reloads.

Nothing is refetched from external APIs on restart. Fully offline after first sync.

---

## User-facing flow (after migration)

1. Boot → last chart auto-loads (or empty state if first run).
2. `📈 Open chart` on the toolbar → modal with two panes:
   - **Saved layouts** — click to load; ☆/★ to pin default.
   - **Series in DB** — market → symbol → timeframe (with `(derived)` suffix when resampled).
3. `+ Ingest data` (top-right of the modal) → adapter form:
   - Pick a source, fill fields, submit.
   - On success, series appears in the picker immediately.
4. `⊞ Layouts` → save named snapshots. They're stored in both localStorage (legacy) and the IndexedDB `layouts` store (new), so they show up in `ChartPicker`.

---

## Migration steps for a fresh checkout

```bash
pnpm install
python scripts/mock_data.py --days 60   # optional: seed all 4 mock markets
pnpm dev
```

On first launch the manifest is ingested into IndexedDB automatically. No admin action required.

### Python env note
`mock_data.py` and `fill_gaps.py` use `zoneinfo` (stdlib on Python 3.9+). On 3.8:

```bash
pip install "backports.zoneinfo;python_version<'3.9'" tzdata
```

---

## Extending — adding a new data source (Alpaca example)

1. Create `src/ingestion/adapters/alpaca.ts` exporting a `SourceAdapter`:
    ```ts
    export const alpacaAdapter: SourceAdapter = {
      id: 'alpaca',
      label: 'Alpaca (US Equities)',
      kinds: ['us_equity'],
      paramsSchema: [
        { name: 'apiKey',    label: 'API Key',    kind: 'password', required: true },
        { name: 'apiSecret', label: 'API Secret', kind: 'password', required: true },
        { name: 'feed',      label: 'Feed',       kind: 'select',
          options: [{ label: 'IEX (free)', value: 'iex' }, { label: 'SIP', value: 'sip' }],
          defaultValue: 'iex' },
        { name: 'days',      label: 'History (days)', kind: 'number', defaultValue: 30 },
      ],
      async fetch(params) { /* … page /v2/stocks/bars … */
        return { candles, meta: { exchange: 'Alpaca' } };
      },
    };
    ```
2. Register it in [src/ingestion/registry.ts](src/ingestion/registry.ts):
    ```ts
    import { alpacaAdapter } from './adapters/alpaca';
    export const ADAPTERS = { ..., [alpacaAdapter.id]: alpacaAdapter };
    ```
3. That's it — no UI, no DB, no picker code touched.

The same shape works for Dukascopy (static tick/bar files), Kraken, Polygon, etc.

---

## Testing scenarios

| Scenario | Expected |
| --- | --- |
| Load BTCUSDT `1m` from Bybit, wait 5 min, refresh browser | Historical + streamed bars persisted; auto-restore reopens same view |
| Ingest US equity daily via mock, request `1m` in picker | Not selectable (grey); tooltip hints to ingest `1m` |
| Ingest US equity daily, request `1w` | Loads with `resampled from 1d` note in status |
| Toggle `_ Gaps: Off` on daily US equity | Weekends collapse; candles pack together |
| Toggle `_ Gaps: On` | Weekend shaded band + `_` glyph reappears |
| Save layout with drawings + indicators | Star it → restart Vite → app opens straight into that layout |
| Kill Vite, restart, open app | IndexedDB survives; last chart auto-restores |

---

## Known follow-ups

- Alpaca / Dukascopy adapters: harness ready, ~50–100 lines each; not built (needs credentials + API-specific paging).
- Bundle size ~684 kB; DuckDB-WASM is the main contributor. Can be dynamic-imported to drop ~300 kB.
- `LayoutManager` currently double-writes (localStorage + IndexedDB) for backward compat; a follow-up can drop the legacy path once existing users' layouts are migrated.
- FastAPI local server: not needed as long as IndexedDB (tens of GB) is sufficient. Add only if you want cross-device sync.

---

## Files touched summary

| Category | Count | Notes |
| --- | --- | --- |
| New TS files | 14 | 7 ingestion, 3 DB, 1 session, 2 components, 1 hook |
| Modified TS files | 5 | `App.tsx`, `Toolbar.tsx`, `LayoutManager.tsx`, `ChartCanvas.tsx`, `chartStore.ts`, `types/index.ts`, `renderer/canvasRenderer.ts` |
| Deleted TS files | 4 | Old loaders |
| New Python scripts | 3 | mock / import / fill-gaps |

All changes verified with `pnpm tsc -b` and `pnpm build` (dist ≈ 684 kB gzip 187 kB).

---

## Ingestion UX pass (follow-up)

### Fixed
- **CSV/large-file ingest hang.** `saveCandles` no longer awaits every single `put`. It pipelines writes inside each transaction and splits arrays > 50 000 rows into chunked transactions. Effect: 500k-row CSVs go from "hangs indefinitely" to a few seconds.
- **No visible progress.** `ingest()` now takes an `onProgress` callback with four phases: `fetching → validating → saving → done`. The panel renders a progress bar during `saving` and a live phase message on the button.

### Added
- **Adapter self-description.** `SourceAdapter` gained three fields:
  - `sourceInfo` — plain-English explanation of what the adapter fetches and from where. Rendered as a "Where the data comes from" note block.
  - `expectedFormat` — verbatim example of the input shape. Toggled with a `▸ Show accepted format` button, rendered as a `<pre>` block.
  - `docsUrl` — optional link.
  All four in-tree adapters (csv-file, csv-url, bybit, mock) now populate these.
- **Auto-detect on file pick.** Selecting a CSV/JSON in the ingest panel probes the file and pre-fills `symbol` (from the CSV's `symbol`/`ticker` column) and `timeframe` (via `detectTimeframe`). Removes typing work and misconfiguration.
- **Timeframe mismatch warnings.** `ingest()` runs `detectTimeframe` after fetch. If the file's real cadence differs from the selected TF, a yellow warning bullet appears — ingest still proceeds under the selected TF but the user knows.
- **"↻ Rescan disk" in ChartPicker.** Re-reads `public/data/markets/manifest.json` on demand so files added by `mock_data.py` / `import_market.py` show up without a page reload.

### Accepted format (canonical)

Displayed inside the CSV file adapter. The Python scripts write files matching this same shape.

```
CSV (comma, semicolon, or tab-separated; first row = header):

  timestamp,open,high,low,close,volume        ← minimal
  time,open,high,low,close,volume,symbol
  date,open,high,low,close,vol

Accepted column aliases (case-insensitive):
  timestamp: timestamp | time | date | datetime | t | ts | open_time
  open:      open | o
  high:      high | h
  low:       low  | l
  close:     close | c | weighted_price
  volume:    volume | vol | v | volume_(btc) | volume_(currency)  (optional)
  symbol:    symbol | ticker | sym                                (optional)

Timestamp formats:
  Unix seconds       1700000000
  Unix milliseconds  1700000000000
  ISO 8601           2024-01-02T09:30:00Z
  ISO no timezone    2024-01-02 09:30:00     (treated as UTC)
  US date            01/02/2024 09:30
```

### Where validation happens

| Concern | Where | Behaviour |
| --- | --- | --- |
| File format (columns present, timestamps parseable) | `parseOHLCVFile` in [src/utils/dataParser.ts](src/utils/dataParser.ts) | Returns `{ candles, errors[] }`. Adapter surfaces first error verbatim if 0 rows. |
| Selectable timeframes for a symbol | `selectableTimeframes()` in [src/db/marketDb.ts](src/db/marketDb.ts) | Combines `availableTimeframes` (stored) + `resampleEngine.canResample` (derivable). Picker greys out invalid. |
| Ingest-time timeframe cadence check | `ingest()` in [src/ingestion/ingestionService.ts](src/ingestion/ingestionService.ts) | Runs `detectTimeframe(candles)`; if it differs from the selected TF, adds a warning to the summary. |
| Timeframe change on already-loaded data | `setTimeframe()` in [src/store/chartStore.ts](src/store/chartStore.ts) | Uses `canResample(base, target)`; falls back to base if not resamplable. |

### Symbol auto-discovery

- **Python-generated files**: dropped under `public/data/markets/<market>/<symbol>_<tf>.csv`. On boot `ingestManifest()` imports them into IndexedDB automatically. No UI action needed.
- **Manual runs mid-session**: click **↻ Rescan disk** in the ChartPicker after running any Python script.
- **CSV upload in the UI**: `symbol` field is auto-filled from the CSV's own `symbol` column when present.

### Files touched in this pass

| File | Change |
| --- | --- |
| [src/db/marketStore.ts](src/db/marketStore.ts) | Batched + chunked `saveCandles` with `SaveProgress` callback |
| [src/db/marketDb.ts](src/db/marketDb.ts) | `saveCandlesForSeries` accepts `onProgress` |
| [src/ingestion/types.ts](src/ingestion/types.ts) | `sourceInfo`, `expectedFormat`, `docsUrl` on `SourceAdapter` |
| [src/ingestion/ingestionService.ts](src/ingestion/ingestionService.ts) | `IngestProgress` type, phase callback, TF mismatch warning |
| [src/ingestion/adapters/csvFile.ts](src/ingestion/adapters/csvFile.ts) | Full `expectedFormat` block, better errors |
| [src/ingestion/adapters/csvUrl.ts](src/ingestion/adapters/csvUrl.ts) | Populates new fields |
| [src/ingestion/adapters/bybit.ts](src/ingestion/adapters/bybit.ts) | Populates new fields |
| [src/ingestion/adapters/mock.ts](src/ingestion/adapters/mock.ts) | Populates new fields |
| [src/components/IngestionPanel.tsx](src/components/IngestionPanel.tsx) | Progress bar, format toggle, auto-detect, warnings list |
| [src/components/ChartPicker.tsx](src/components/ChartPicker.tsx) | "↻ Rescan disk" button |

---

## Delta ingest + entire-history load + symbol on cursor (follow-up)

### Delta ingest — no more full-file rewrites

`ingest()` now accepts a `mode`:

| Mode | Behaviour | Speed |
| --- | --- | --- |
| **append-only** (default) | Skip rows whose timestamp is already inside the stored `[firstTs..lastTs]` range. Only truly new head/tail rows are written. | Re-ingesting the same file is nearly instant. |
| **overwrite** | Put every row unconditionally. Existing rows with matching timestamps are replaced. | Slower — one `put` per row. Use when the file has mid-range corrections. |

Under the hood the service calls `getSeriesRange()` first and filters incoming candles. The `IngestSummary` now reports:

```ts
{
  rows,             // rows actually written
  newRows,          // rows outside the existing range
  skippedRows,      // rows already in DB (append-only mode)
  overwrittenRows,  // rows inside the existing range (overwrite mode)
  ...
}
```

The IngestionPanel exposes a **Write mode** radio group and the summary line reads e.g.:
```
✓ 4 320 written · 195 680 skipped (already in DB) in 812 ms
```

### Entire-history load

`loadInitialCandles` now treats `count = Infinity` as "no limit" and streams every stored bar. The ChartPicker gained a **Load entire history** checkbox with a live bar count next to it (`Load entire history (204 320 bars)`). The Open button label switches between `Open (last 2 000)` and `Open (all bars)` accordingly. Lazy backfill continues to work when you use the 2 000 window and pan left.

### Symbol on cursor / chart header

`CandleTooltip` now:

- **Always renders** a small header at the top-left of the chart showing `MARKET · SYMBOL · TIMEFRAME`, even when the crosshair isn't over a bar. Source of the label:
  1. `currentSeries` from the store (set by any open-from-DB path).
  2. Fallback: `rawCandles[0].symbol` — so freshly-parsed CSVs with a `symbol` column still show the label.
- **Extends** the crosshair tooltip with the same header, so hovering keeps the label visible while showing OHLCV underneath.

### Files touched in this pass

| File | Change |
| --- | --- |
| [src/ingestion/types.ts](src/ingestion/types.ts) | `IngestMode`, enriched `IngestSummary` |
| [src/ingestion/ingestionService.ts](src/ingestion/ingestionService.ts) | `IngestOptions` (mode + onProgress), delta filter via `getSeriesRange` |
| [src/db/marketDb.ts](src/db/marketDb.ts) | `loadInitialCandles` treats `Infinity` as unbounded |
| [src/components/IngestionPanel.tsx](src/components/IngestionPanel.tsx) | Write mode radio group, richer summary line |
| [src/components/ChartPicker.tsx](src/components/ChartPicker.tsx) | "Load entire history" checkbox + adaptive Open label |
| [src/components/CandleTooltip.tsx](src/components/CandleTooltip.tsx) | Persistent symbol · TF header |

---

## Diagnostics & visibility pass (follow-up)

### Preview before you commit
The IngestionPanel now has a **Preview** button that runs the adapter's `fetch()` and shows:
- Row count
- Detected timeframe + detected symbol
- First and last row (timestamp / OHLCV)

Nothing is written to the DB. It also auto-fires when a CSV file / URL is picked so you immediately see what was parsed. Removes the "is it stuck or is it silently failing?" ambiguity.

### Distinct outcome banners
The one-liner status is replaced by a bordered banner styled per outcome:

| Kind | Colour | Trigger |
| --- | --- | --- |
| ✓ Ingested | green | rows > 0 written |
| ⚠ Nothing new | amber | all rows skipped because they're already in the DB (append-only mode) |
| ✗ Failed | red | adapter threw, or 0 rows returned |

The amber banner explicitly nudges you to switch to **Amend + overwrite** when the file has corrections. This is the case the user hit with `bybit_btcusdt_1h.csv` — "not storing anything" was really the delta filter dropping already-seen timestamps.

### Console diagnostics
Every ingest logs to DevTools:

```
[ingest] start        { adapter, market, symbol, tf, mode, extras }
[ingest] fetched      { adapter, rows, firstTs, lastTs, warnings }
[ingest] existing range { firstTs, lastTs, count, mode }
[ingest] done         <IngestSummary>
```

Failures log with `console.error('[ingest] failed', error)`. Preview logs `[ingest:preview]`.

### ChartPicker no longer re-scans on every open
`ingestManifest()` used to fire every time the picker opened. Now the initial ingest happens once on app boot (in `App.tsx`) and the picker only refreshes what's already in IndexedDB when opened. Manual re-scan is still available via the **↻ Rescan disk** button.

### Bundle warning silenced
Bumped `build.chunkSizeWarningLimit` in [vite.config.ts](vite.config.ts) to 800 kB. The bundle is 697 kB, dominated by `@duckdb/duckdb-wasm` (~300 kB). Since the app is a single-page desktop-style tool that loads once and is cached, the default 500 kB warning was noise, not a real problem. Nothing about the runtime changed.

### Files touched in this pass

| File | Change |
| --- | --- |
| [src/components/IngestionPanel.tsx](src/components/IngestionPanel.tsx) | Preview button + auto-preview, outcome banners (success / skipped / error), console diagnostics on every step |
| [src/ingestion/ingestionService.ts](src/ingestion/ingestionService.ts) | `console.info` at each phase; existing-range diagnostic |
| [src/components/ChartPicker.tsx](src/components/ChartPicker.tsx) | Dropped per-open `ingestManifest`; boot handles it |
| [vite.config.ts](vite.config.ts) | `chunkSizeWarningLimit: 800` |
