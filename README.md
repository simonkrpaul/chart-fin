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



- Candlestick chart with volume sub-pane
- Timeframes: 5m, 10m, 15m, 1h, 4h
- Indicators: SMA, EMA, VWAP, RSI, MACD, Bollinger Bands, ATR
- Drawing tools: trendline, horizontal line, vertical line, rectangle, measurement tool
- Undo / redo for drawings (`⌘Z` / `⌘⇧Z`)
- Historical offset overlays — overlay 10/20/30/40/50-day-ago price action on the current chart
- Calendar-day alignment (weekends and holidays are preserved, not collapsed)
- Dark / light theme toggle

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

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system design.

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
