# chart-fin

A professional financial charting application with candlestick charts, technical indicators, drawing tools, and historical offset comparison (overlay past price action against the present chart).

## Prerequisites

- **Node.js** (v18+) — managed via [nvm](https://github.com/nvm-sh/nvm) (Linux/macOS) or [nvm-windows](https://github.com/coreybutler/nvm-windows) (Windows)
- **pnpm** package manager

---

## Getting Started — Linux / macOS

### 1. Install Node.js via nvm

```bash
# Install nvm (if not already installed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Reload shell
source ~/.bashrc   # or ~/.zshrc on macOS

# Install and use latest LTS
nvm install --lts
nvm use --lts
```

### 2. Install pnpm

```bash
npm install -g pnpm
```

### 3. Clone the repository

```bash
git clone <repo-url> chart-fin
cd chart-fin
```

### 4. Install dependencies

```bash
pnpm install
```

### 5. Start the dev server

```bash
pnpm dev
```

The app will be available at **http://localhost:5173**

To expose it on the local network (e.g. access from another device):

```bash
pnpm dev -- --host
```

### 6. Production build

```bash
pnpm build
```

Output goes to `dist/`. Preview the production build with:

```bash
pnpm preview
```

---

## Getting Started — Windows

### 1. Install Node.js via nvm-windows

1. Download the installer from [nvm-windows releases](https://github.com/coreybutler/nvm-windows/releases).
2. Run the installer (accept defaults).
3. Open a **new** Command Prompt or PowerShell and run:

```cmd
nvm install lts
nvm use lts
node --version
```

### 2. Install pnpm

```cmd
npm install -g pnpm
```

### 3. Clone the repository

```cmd
git clone <repo-url> chart-fin
cd chart-fin
```

### 4. Install dependencies

```cmd
pnpm install
```

### 5. Start the dev server

```cmd
pnpm dev
```

The app will be available at **http://localhost:5173**

To expose it on the local network:

```cmd
pnpm dev -- --host
```

### 6. Production build

```cmd
pnpm build
```

Output goes to `dist\`. Preview the production build with:

```cmd
pnpm preview
```

### Troubleshooting (Windows)

- **"pnpm is not recognized"** — Close and reopen your terminal after installing pnpm, or add `%APPDATA%\npm` to your PATH.
- **Long path errors** — Enable long paths: run `git config --system core.longpaths true` in an admin terminal.
- **Permission errors** — Run PowerShell as Administrator, or use `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`.

---

---

## Loading BTC price data

The app can display real Bitcoin OHLCV data converted from the
[Kaggle BTC historical dataset](https://www.kaggle.com/datasets/mczielinski/bitcoin-historical-data).

### Prerequisites

```bash
pip install pandas
```

### Option A — download directly from Kaggle

1. Create a Kaggle API token at **kaggle.com → Account → API → Create New Token** (downloads `kaggle.json`).
2. Place it at `~/.kaggle/kaggle.json` (or export `KAGGLE_USERNAME` / `KAGGLE_KEY`).
3. Install the Kaggle hub client:

   ```bash
   pip install 'kagglehub[pandas-datasets]'
   ```

4. Run the script:

   ```bash
   python3 scripts/download_btc.py
   ```

### Option B — use a locally downloaded CSV

1. Download `btcusd_1-min_data.csv` manually from:  
   <https://www.kaggle.com/datasets/mczielinski/bitcoin-historical-data>
2. Place it anywhere (e.g. `public/data/apr2026/btcusd_1-min_data.csv`).
3. Run:

   ```bash
   python3 scripts/download_btc.py --local public/data/apr2026/btcusd_1-min_data.csv
   ```

### What gets generated

Both options write the following files to `public/data/`:

| File | Timeframe | ~Rows |
|------|-----------|-------|
| `btc_1m.csv` | 1-minute | 7.5 M |
| `btc_5m.csv` | 5-minute | 1.5 M |
| `btc_1h.csv` | 1-hour | 125 k |
| `btc_1d.csv` | 1-day | 5 k |
| `btc_1w.csv` | 1-week | 750 |

Column format: `timestamp` (Unix ms UTC), `open`, `high`, `low`, `close`, `volume`.

### Load the data in the chart

After generating the files, open the app and either:

- Click **↑ Load data** in the toolbar and pick a file from `public/data/`, **or**
- Use the **Remote Loader** quick-load button (pre-wired to `/data/btc_1d.csv`).

---

## Bybit Live Data Sync

The app can stream real-time BTCUSDT data from the [Bybit](https://bybit.com) public API.
There are two approaches: a **backend Python sync** for bulk historical data (5 years),
and a **frontend live feed** for real-time updates.

### Prerequisites

```bash
pip install pandas requests
```

### Backend sync (5 years of 1-minute candles)

The `scripts/bybit_sync.py` script downloads full BTCUSDT 1-minute history from Bybit
and saves it to `public/data/`. On the first run it fetches up to 5 years; on subsequent
runs it only fetches the gap since the last sync.

```bash
# Full sync (first time — takes ~20-40 minutes for 5 years)
python scripts/bybit_sync.py

# After being offline for a week — only syncs the missing gap
python scripts/bybit_sync.py

# Custom history depth (e.g. 2 years)
python scripts/bybit_sync.py --years 2
```

Output files written to `public/data/`:

| File | Timeframe |
|------|-----------|
| `bybit_btcusdt_1m.csv` | 1-minute |
| `bybit_btcusdt_5m.csv` | 5-minute |
| `bybit_btcusdt_1h.csv` | 1-hour |
| `bybit_btcusdt_1d.csv` | 1-day |
| `bybit_btcusdt_1w.csv` | 1-week |

Load these via the **Remote Loader** buttons (`Bybit 1m`, `Bybit 1h`, `Bybit 1d`) in the toolbar.

### Frontend live feed

Click the **◉ Live Feed** button in the toolbar. The live feed has three phases:

1. **Connection probe** — checks if Bybit API is reachable (green/red dot indicator).
2. **Gap sync** — paginated REST fetch fills any missing 1-minute candles since last session.
3. **WebSocket stream** — real-time 1m candle updates via `wss://stream.bybit.com`.

**Connection indicator:**
- 🟢 Green dot = Bybit reachable, click to connect
- 🔴 Red dot = Bybit unreachable, button is greyed out and disabled
- Glow effect = WebSocket actively streaming

When the dev server has been offline (e.g. a weekend), clicking **Live Feed** on Monday
will automatically sync all missing candles before connecting the live stream.

---

## Swiss Ephemeris (swisseph) Setup

The ephemeris server (`scripts/ephemeris_server.py`) uses [pyswisseph](https://pypi.org/project/pyswisseph/) which requires the Swiss Ephemeris library and data files.

### Python binding (all platforms)

```bash
pip install pyswisseph
```

This installs the pre-built wheel which includes the C library. If no wheel is available for your platform, you'll need the C library installed first (see below).

### Ephemeris data files

Download the planetary ephemeris files from the official repository:

```bash
git clone https://github.com/aloistr/swisseph.git
```

The data files are in the `ephe/` folder. Copy them to a location the library can find:

| Platform | Default search path |
|----------|-------------------|
| **Windows** | `C:\sweph\ephe` |
| **Linux / macOS** | `.:/users/ephe2/:/users/ephe/` |

Or set a custom path in your code with `swe_set_ephe_path()` / environment variable.

---

### Linux setup

#### Install build dependencies (if building from source)

```bash
# Debian / Ubuntu
sudo apt-get install build-essential gcc make

# Fedora / RHEL
sudo dnf install gcc make
```

#### Build the C library from source

```bash
git clone https://github.com/aloistr/swisseph.git
cd swisseph
make
```

This produces:
- `libswe.a` — static library
- `libswe.so` — shared library
- `swetest` — command-line test tool

#### Install the shared library system-wide (optional)

```bash
sudo cp libswe.so /usr/local/lib/
sudo ldconfig
```

#### Set up ephemeris data files

```bash
sudo mkdir -p /users/ephe
sudo cp ephe/*.se1 /users/ephe/
```

Or use a custom path:

```bash
mkdir -p ~/sweph/ephe
cp ephe/*.se1 ~/sweph/ephe/
export SE_EPHE_PATH=~/sweph/ephe
```

---

### Windows setup

#### Option A — Pre-built DLLs

1. Clone or download the repository:
   ```
   git clone https://github.com/aloistr/swisseph.git
   ```
2. Extract `windows/sweph.zip` — it contains pre-built 32-bit and 64-bit DLLs in `sweph/bin/`.
3. Copy the appropriate DLL (`swedll32.dll` or `swedll64.dll`) to your project or system PATH.

#### Option B — Build from source with Visual Studio

1. Open the solution/project files in `windows/sweph.zip → sweph/src/projects/`.
2. Build the desired configuration (Release x64 recommended).

#### Option C — Build with MinGW / MSYS2

```bash
pacman -S mingw-w64-x86_64-gcc make
cd swisseph
make
```

#### Set up ephemeris data files

```cmd
mkdir C:\sweph\ephe
copy ephe\*.se1 C:\sweph\ephe\
```

Or set the environment variable:

```cmd
set SE_EPHE_PATH=C:\path\to\your\ephe
```

---

### Verify the installation

```bash
# Test the C library
./swetest -p0 -b1.1.2025 -fPl -head

# Test pyswisseph
python3 -c "import swisseph as swe; swe.set_ephe_path('./ephe'); print(swe.calc_ut(2460676.5, 0))"
```

---

## Features

Everything is native TypeScript + a single custom canvas renderer — no
charting library — so the pipeline is inspectable end-to-end.

### Charts & data

- **Candlestick chart** with volume sub-pane, price scale (autoFit + manual pan/scale), hover crosshair with persistent OHLC tooltip.
- **Timeframes** — `1m`, `5m`, `10m`, `15m`, `1h`, `4h`, `1d`, `1w`, `1M`. Coarse timeframes auto-resample from the finest loaded base data.
- **Multi-market ingestion** via a unified `ingestionService` with 6 adapters:
  - **Bybit** REST + WebSocket (BTC/USDT etc., minute-to-week bulk sync in [`scripts/bybit_sync.py`](scripts/bybit_sync.py))
  - **Alpaca** stocks + crypto (SDK-based, S&P 500 + crypto majors via [`scripts/download_alpaca.py`](scripts/download_alpaca.py))
  - **Dukascopy** forex + CFDs (self-contained LZMA/.bi5 downloader for XAUUSD etc., see [`scripts/download_dukascopy.py`](scripts/download_dukascopy.py))
  - **Kaggle** bulk S&P 500 daily (skip / append / overwrite modes, [`scripts/import_kaggle_sp500.py`](scripts/import_kaggle_sp500.py))
  - **CSV** file / URL loader
  - **Mock** deterministic random-walk generator including a full Alpaca-schema equity generator ([`scripts/mock_alpaca.py`](scripts/mock_alpaca.py))
- **On-demand ingest** — no boot-time manifest sweep. `listMarketsForPicker()` overlays the manifest on the DB view so unimported symbols show as **pending**; clicking one triggers a single-CSV `ingestOne()` fetch. Zero wasted bandwidth, no double-work when re-downloading from a script.
- **IndexedDB persistence** (`chart-fin-db`, via `idb`) — markets, symbols, OHLCV, layouts, settings. Manifest-cache-aware ingest, single-flight write locks, ~50 k-candle chunking with fire-and-forget puts.
- **Chart picker** listing all locally-cached series and pending manifest entries. Refresh button re-reads the manifest so newly-added CSVs from Python scripts appear immediately.
- **TF-aware loader** — picking `1d` when the store has `1m` transparently resamples on the fly.

### Time & calendar engine

- **UTC-first daily / weekly / monthly slot generation** — every raw daily bar (Kaggle 00:00 UTC, Bybit 00:00 UTC, Alpaca 00:00 UTC) maps 1-to-1 to a slot regardless of the user's session timezone. Slot timestamps are anchored at 12:00 UTC so any display tz (Sydney, NY, LA, UTC) renders the correct calendar date.
- **Session-tz-aware intraday** — 5 m / 15 m / 1 h grids know NYSE 09:30–16:00 ET, half-day early closes, ASX / LSE / futures sessions.
- **Uniform 24 h intraday grid for non-continuous markets** — US equities and other session markets fill the overnight window with `outside_session` placeholder slots which are then removed by the gap-visibility filter, so intraday charts never carry 16:00→08:00 empty air.
- **Two gap-visibility modes** (toolbar toggle):
  - **Calendar Days** *(default)* — real trading-session candles + session-hour-wide placeholder columns for weekends and holidays. Fri close → Sat spacer → Sun spacer → Mon open. Overnight always removed.
  - **Trading Days** — only real trading-session candles, packed contiguously. Fri close is directly adjacent to Mon open.
  - Both modes use overlap semantics for session boundaries, so mid-hour session opens (e.g. 09:30 on a 1h chart) show up correctly on the aligned 09:00 slot.
  - Details in [`docs/gap-visibility.md`](docs/gap-visibility.md).
- **Gap handling** — weekends, market holidays and half-days are separate slot statuses with underscore-glyph placeholders (D/W/M) that never collapse silently. Missing trading bars (real data gaps such as a stranded Kaggle row) are treated identically.

### Indicators

Configured & rendered live via the `IndicatorPanel`. Each indicator persists in the current layout.

| Indicator | Notes |
|---|---|
| **SMA / EMA / VWAP** | Multiple simultaneous instances, per-instance period + color |
| **RSI / MACD / ATR** | Rendered in a sub-pane |
| **Bollinger Bands** | Configurable period + std-dev |
| **SWING_HL** | Pivot swing highs / lows with configurable L/R window and %-move labels |
| **SUPPORT_RESISTANCE** | Cluster detection from historic pivots |
| **SESSIONS** | Tokyo / London / New York / Sydney overlay bands |
| **MOON_SIGNALS** | Buy/Sell markers from Moon-Ketu / Moon-Rahu conjunction dates; **rolls forward through gaps** so a signal on a weekend / market holiday attaches to the next trading candle |
| **HIGH_LOW_LEVELS** | Previous-day / previous-week / previous-month H/L lines labelled **PDH / PDL / PWH / PWL / PMH / PML**, plotted **on the next period's bar range** (yesterday's H/L on today, this week's H/L trailing off past the last bar). Sessions render on their own day |
| **DYNAMIC_GRID** | Horizontal grid at price multiples of `n`; diagonals between two anchor dates |
| **WICK_REVERSAL** | Wick-rejection buy/sell signals |
| **TRADE_SIGNALS** | Import from CSV / trade log |

### Historical offset overlays (Anchored Comparison)

- Overlay any prior window of the same series (or a **cross-market series**) on top of the current chart at an arbitrary calendar-day offset.
- **UTC-date matching** on D/W/M so overlays are exact bar-to-bar, no session-open drift.
- **Continuous across weekend / holiday placeholders** — a Sat/Sun/Labor-Day bar from a 24/7 overlay (BTC) renders on the primary equity chart's placeholder column, so the overlay is visually unbroken.
- Multiple simultaneous overlays with per-overlay color, dashed / line-only styles, normalization modes (`raw`, `percent`, `index=100`, `normalized`).
- **Correlation coefficient** shown per overlay — computed from returns **between consecutive slot indices only**, so Fri→Mon and other gap crossings never pollute the statistic.

### Correlation Scanner

- Scans **1 – 5000 day** offsets to find the best-correlating historical window against the current chart's last N days.
- Returns / swing-point modes.
- Independent min/max offset controls (skip trivially-similar recent offsets, cap the search space).
- One-click "apply as overlay" from any scanner result.

### Backtest engine

- Per-strategy config UI (`BacktestPanel`) — pick timeframe, capital, position sizing, entry / exit rules.
- Signals rendered on the main pane; equity curve + drawdown in the report drawer.
- Trade log stream integrates with the imported CSV Trade Journal.

### Bar replay

- Scrub / play / step through history bar-by-bar at 1× – 60× speed.
- Indicators and overlays recompute against the replay cursor so signals look exactly as they did in real time.

### Cycle Combiner

- Sum / product of arbitrary sine cycles + astronomical cycles; forward-project a synthetic price series to compare against the primary.
- Cycles are added / edited in the [`CycleCombinerPanel`](src/components/CycleCombinerPanel.tsx).

### Hurst Cycles

Empirical nested-cycle analysis per J.M. Hurst (1970 / 1973 — *not* a sine-wave synthesizer). Everything is computed from the actual price series.

- **CMA** (Centered Moving Average) — length = period. Trend estimate; stops period/2 bars before the last bar (Hurst's "half-span problem").
- **Detrended** — `close − CMA`. Exposes the cycle at that period.
- **FLD** (Future Line of Demarcation) — `(H+L)/2` shifted forward by period/2 bars. Price crossings give buy/sell signals with target = distance-at-crossover.
- **Troughs** — local minima in the detrended series, at least period·(1 − tolerance) bars apart. Longer-cycle troughs align with shorter-cycle troughs (Hurst synchronicity emerges).
- **Projection window** — shaded band `[last + (1−tol)·period, last + (1+tol)·period]` marks where the next trough is expected.
- **Envelope** — optional ±amplitude bands around the CMA.
- Ships with Hurst's classical **Nominal Model** presets (18y / 9y / 4.5y / 54w / 18w / 9w / 20d / 10d / 5d) in bars.
- Fully isolated in [`src/hurst/`](src/hurst/) — its own Zustand store, engine, renderer, and panel. Doesn't touch `chartStore` at all. Docs / rationale in the file headers.

### Ephemeris integration

Requires the local ephemeris server ([`scripts/ephemeris_server.py`](scripts/ephemeris_server.py), pyswisseph + `.se1` data files).

- **Aspect scanner** — any two planets, orb, ayanamsa (Lahiri / Raman / Krishnamurti / Fagan-Bradley / Tropical). Markers appear on the primary chart at each hit.
- **Retrograde periods** — turns each retrograde window into a coloured transit zone.
- **Ascendant aspects** for **Rahu / Ketu** — intraday scanner detects **8 standard aspects to the Ascendant** (0° Conjunction / Rising, 60° Sextile, 90° Square, 120° Trine, 180° Opposition, 240° / 270° / 300° reflex angles) at any lat/lon. Independent orb-state per aspect; markers land at exact UTC intraday times with `Rahu Square (R) ASC` style labels.
- **Helio-transit scanner** — Sun-relative heliocentric planet angles for cycle work.

### Drawings

- Trendline, horizontal / vertical line, rectangle, Fibonacci retracement, measurement tool.
- Full **undo / redo history** (⌘Z / ⌘⇧Z).
- **Range measurement overlay** shows price / time / bars / % move / annualised return between two clicks.

### Multi-panel layouts (TradingView-style)

- Split the workspace into `1`, `2` or `4` chart panels via the `LayoutGrid` / `LayoutManager`.
- Each panel is an independent chart store — different symbol, timeframe, indicators.
- **Save / load layouts** — series identity, indicators, overlays, drawings, viewport, price scale, theme all round-trip through IndexedDB.
- **Auto-restore last session** on boot; single-flight guards protect against StrictMode double-mounts.

### Sidebar

The left column is a **vertical icon rail + single active panel** so long forms (Ephemeris, Offset Overlays with many entries) never push the others off-screen. See [`src/components/Sidebar.tsx`](src/components/Sidebar.tsx).

- 📈 **Indicators**
- ⚡ **Strategy Tester** (backtest)
- 📊 **Offset Overlays**
- 📝 **Trade Journal**
- ○□△ **Ephemeris** (Gann circle-square-triangle glyph)
- 🌀 **Cycle Combiner**
- 〰️ **Hurst Cycles**

Only one panel is mounted at a time. Click the active tab again to collapse and reclaim chart width. The `«` / `»` button at the bottom of the rail also collapses. Active tab + collapsed state persist to `localStorage`.

### Timezone

- IANA `TimezoneSelector` — change display tz on the fly for intraday; D/W/M always render as UTC calendar dates for consistency across users.

### Data ingestion utilities

Scripts in `scripts/`:

| Script | Purpose |
|---|---|
| `bybit_sync.py` | Bulk Bybit BTC/USDT + append-only incremental daily update |
| `download_btc.py` | Kaggle BTC historical → normalized `btc_*.csv` |
| `download_alpaca.py` | Alpaca stock (S&P 500) & crypto majors → `public/data/markets/…` |
| `download_dukascopy.py` | Dukascopy forex / CFDs (XAUUSD, EURUSD, …) via LZMA `.bi5` datafeed; native M1/H1/D1 or tick-derived custom TFs; resume + concurrency + XAUUSD-aware point value |
| `mock_alpaca.py` | Synthetic 1-minute equity bars in exact Alpaca schema; NYSE session hours; auto-updates the manifest |
| `import_kaggle_sp500.py` | Kaggle S&P 500 daily → per-symbol CSVs; skip / append / overwrite modes; auto raises OS fd limit on macOS |
| `import_market.py` | Generic per-market normalized import |
| `mock_data.py` | Deterministic OHLCV walk for offline demo (4 market profiles) |
| `fill_gaps.py` | Bybit-only gap-filler for historical holes |
| `download_kaggle_btc.py` | Kaggle Bitcoin dataset downloader |
| `compute_all_transits.py` | Batch precompute planetary transit windows |

### Offline commit transport (PDF round-trip)

For environments where `git push` is blocked by corporate proxy / DLP scanners and only PDF attachments are allowed. All three scripts are byte-for-byte identical after round-trip — see [`docs/patch-round-trip.md`](docs/patch-round-trip.md).

| Script | Direction | Platform |
|---|---|---|
| [`scripts/patch-to-pdf.sh`](scripts/patch-to-pdf.sh) | commits → base64 PDF | macOS / Linux |
| [`scripts/pdf-to-patch.sh`](scripts/pdf-to-patch.sh) | PDF → `git am` | macOS / Linux |
| [`scripts/pdf_to_patch.py`](scripts/pdf_to_patch.py) | PDF → `git am` | Cross-platform (Windows / macOS / Linux, auto-installs `pypdf`) |

### Theming

- Dark / light theme toggle in the toolbar; canvas theme tokens picked up by every renderer pass; theme is layout-persisted.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Escape` | Switch to cursor |
| `T` | Trendline tool |
| `H` | Horizontal line |
| `R` | Rectangle |
| `M` | Measurement tool |
| `⌘Z` | Undo |
| `⌘⇧Z` | Redo |

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — module map & data-flow diagrams.
- [MIGRATION.md](MIGRATION.md) — feature-by-feature engineering log.
- [docs/data-ingestion.md](docs/data-ingestion.md) — Bybit / Alpaca / Kaggle ingestion cookbook.
- [docs/patch-round-trip.md](docs/patch-round-trip.md) — corporate-safe commit transport.


## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
