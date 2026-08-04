# chart-fin

A professional financial charting application with candlestick charts, technical indicators, drawing tools, and historical offset comparison (overlay past price action against the present chart).

## Prerequisites

- **Node.js** managed via [nvm](https://github.com/nvm-sh/nvm)
- **pnpm** package manager

> Node.js is not on the system PATH by default — you must activate it via nvm first.

## Getting started

### 1. Activate Node.js

```bash
export NVM_DIR="$HOME/.nvm"
source "$(brew --prefix nvm)/nvm.sh"
nvm use node
```

Or add the lines above to your `~/.zshrc` so Node is available in every new terminal session.

### 2. Install dependencies (first time only)

```bash
pnpm install
```

### 3. Start the dev server

```bash
./node_modules/.bin/vite
```

The app will be available at **http://localhost:5173**

To expose it on the local network (e.g. access from another device):

```bash
./node_modules/.bin/vite --host
```

### 4. Production build

```bash
./node_modules/.bin/vite build
```

Output goes to `dist/`.

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
