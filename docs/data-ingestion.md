# Data ingestion scripts

Every downloader script writes CSVs directly into the chart-fin **manifest
layout** and rebuilds `public/data/markets/manifest.json` before it exits.
The Chart Picker discovers new symbols on the next browser refresh and
pulls each CSV into IndexedDB **on demand** — no boot-time bulk load,
no wasted bandwidth.

## How chart-fin loads your data

```
                                 ┌───────────────────────┐
run a downloader script ─────▶   │ public/data/markets/  │
                                 │   crypto/BTCUSDT_1m…  │
                                 │   us_equity/AAPL_1d…  │
                                 │   metals/XAUUSD_1m…   │
                                 │   forex/EURUSD_1m…    │
                                 │   manifest.json       │  ← auto-rebuilt
                                 └───────────────────────┘
                                          │
                                          ▼
                              ⌘R refresh the browser
                                          │
                                 (boot is instant — no CSV ingest)
                                          ▼
                          Open Chart Picker  →  ↻ Rescan disk
                                          │
                 listMarketsForPicker() re-reads manifest.json
                                          │
                          New symbol → appears as "pending"
                                          │
                             Click the symbol → openSeries()
                                          │
                    ingestOne(csvUrl) fetches JUST that one CSV
                                          │
                        Parsed into IndexedDB, chart opens
```

**No hot-reload** — the browser can't watch the filesystem — but the
round-trip is under a second on typical data. If the picker was already
open when you ran the script, click **↻ Rescan disk** to re-read the
manifest without closing/reopening.

---

## TL;DR — one row per script

| Script | Source | Market bucket | What it downloads |
| --- | --- | --- | --- |
| [download_alpaca.py](../scripts/download_alpaca.py) | Alpaca Market Data v2 (SDK) | `us_equity`, `crypto` | S&P 500 or your list; stocks + crypto |
| [download_btc.py](../scripts/download_btc.py) | Binance REST (default) or Kaggle | `crypto` | BTCUSDT 1m + resampled to `1w` |
| [download_dukascopy.py](../scripts/download_dukascopy.py) | Dukascopy `.bi5` datafeed | `metals`, `forex` | Native M1/H1/D1 or tick-derived custom TFs (XAUUSD, EURUSD, etc.) |
| [download_kaggle_btc.py](../scripts/download_kaggle_btc.py) | Kaggle `mczielinski/bitcoin-historical-data` | `crypto` | Bitcoin 1m history (~10 years) resampled to full TF ladder |
| [bybit_sync.py](../scripts/bybit_sync.py) | Bybit v5 public REST | `crypto` | Any pair; 1m + resampled to `1w`. Incremental gap-only re-runs |
| [import_kaggle_sp500.py](../scripts/import_kaggle_sp500.py) | Local Kaggle master CSV | `us_equity` | Splits ~500 symbols into per-symbol daily CSVs |
| [import_kaggle_xauusd.py](../scripts/import_kaggle_xauusd.py) | Kaggle XAUUSD Metatrader dump | `forex` | Gold 1m/5m/15m/1h/4h/1d/1w/1M from a semicolon+dotted-date archive |
| [import_xauusd_iso.py](../scripts/import_xauusd_iso.py) | ISO-timestamp 1m CSV (any provider) | `forex` | Gold 1m + all resampled TFs; supports **merge** with existing 1m history |
| [import_evtradelabs_xauusd.py](../scripts/import_evtradelabs_xauusd.py) | [evtradelabs.com](https://evtradelabs.com/) XAUUSD JSON archive | `forex` | Gold 5m bid/ask/mid (23 years, per-year JSON files) |
| [import_market.py](../scripts/import_market.py) | Any CSV file | any | Generic promoter — moves an existing CSV into the market layout |
| [mock_alpaca.py](../scripts/mock_alpaca.py) | Synthetic (Alpaca schema) | `us_equity` | 1-min OHLCV, NYSE session hours, no network needed |
| [mock_data.py](../scripts/mock_data.py) | Synthetic | 4 profiles | Crypto / US equity / ASX / forex — deterministic random-walk |
| [mt5_sync.py](../scripts/mt5_sync.py) | MetaTrader 5 terminal (Pepperstone etc.) | `forex` | **Windows-only**. Live broker bars — one-shot or loop every N seconds |
| [fill_gaps.py](../scripts/fill_gaps.py) | Existing Bybit CSV | `crypto` | Detects + backfills missing bars |

All of these use the same helper — [`scripts/_manifest.py`](../scripts/_manifest.py) —
so the manifest schema stays consistent no matter which script you run.

## The manifest layout

Every downloader writes to:

```
public/data/markets/
├── manifest.json                   ← rebuilt at end of each script
├── crypto/
│   ├── BTCUSDT_1m.csv              ← <SYMBOL>_<tf>.csv
│   ├── BTCUSDT_5m.csv
│   ├── BTCUSDT_1h.csv
│   ├── BTCUSDT_1d.csv
│   ├── BTCUSDT_1w.csv
│   └── BTCUSDT.meta.json           ← sidecar: exchange, description, sector
├── us_equity/
│   ├── AAPL_1d.csv
│   ├── AAPL_1m.csv
│   └── AAPL.meta.json
├── metals/
│   ├── XAUUSD_1m.csv               ← Dukascopy
│   ├── XAUUSD_1h.csv
│   └── XAUUSD.meta.json
└── forex/
    ├── EURUSD_1m.csv               ← Dukascopy
    └── EURUSD.meta.json
```

CSV schema (all downloaders, all timeframes):

```
timestamp,open,high,low,close,volume
1695945600000,58432.1,58500.0,58390.5,58471.0,1234.5678
```

- `timestamp` — Unix **milliseconds** UTC, `open` of the bar
- `volume` — asset volume (BTC for crypto, shares for stocks, millions of units for FX)

The sidecar `<SYMBOL>.meta.json` is optional and adds `exchange`, `description`,
`sector`, `industry` fields to the Chart Picker's display.

## Troubleshooting: "No candles in DB" and friends

The Chart Picker's status bar shows one of a few actionable messages when it
can't open a series. Each one tells you exactly what to do next.

### `No candles in DB for <market>/<symbol> @ <tf>. Symbol not in IndexedDB. …`

**Cause:** the CSV exists on disk but the browser hasn't ingested it yet.

**Fix (in order):**

1. **Refresh the page** (⌘R). The Chart Picker re-reads `manifest.json` on open.
2. Open the picker → **↻ Rescan disk**. If the symbol is listed as **"pending"**, that's normal — clicking it fetches the CSV.
3. Click the symbol. `ingestOne()` pulls the one CSV into IndexedDB.
4. If the symbol still doesn't appear at all:
   - Check `public/data/markets/manifest.json` — does the symbol have an entry?
   - Check `public/data/markets/<market>/<SYMBOL>_<tf>.csv` exists on disk.
   - If not, re-run the downloader script that owns that symbol (see the tables above).
5. If the manifest and CSV both exist but the error persists, the local IndexedDB may be stale. Wipe it and reload:
   ```
   DevTools → Application → IndexedDB → chart-fin-db → Delete database → ⌘R
   ```
   The next open of the picker will re-ingest fresh from the CSVs on disk.

### `No candles in DB for <market>/<symbol> @ <tf> (finest stored: <tf2>). Cannot resample UP from <tf2> to a finer timeframe. …`

**Cause:** you're asking for a finer TF than what was downloaded. E.g. picking `1m` for a symbol whose finest stored TF is `1d`. The resample engine can only aggregate (1m → 5m → 1h → 1d), not subdivide.

**Fix:**

- Pick the finest stored TF **or coarser**.
- Or re-run the downloader script with the finer TF:
  ```bash
  # e.g. add 1-minute AAPL bars
  python scripts/download_alpaca.py --symbols AAPL --timeframe 1m --years 2 --resume
  ```

### The picker shows the symbol but clicking it hangs at "Loading…"

- Open the browser console. Look for `[openSeries]` log lines with timing.
- If `[openSeries] loaded` shows `rows: 0` and no error, the DB probably has the row but the `availableTimeframes` list is stale. Wipe IndexedDB (as above) and refresh.
- If the request stalls with no logs at all, check DevTools → Network for the `/data/markets/.../<SYMBOL>_<tf>.csv` request. A 404 means the manifest points at a file that doesn't exist — re-run the downloader.

### The chart opens but is empty (no candles visible)

- Almost always a gap-visibility filter issue, not a "no candles" issue. Check the toolbar's **Session Only ↔ Show 24h** and the **🕒 session-hours badge**.
  - If the badge shows a very narrow session (e.g. `15:30–15:55 New_York`), an earlier auto-detect likely mis-fired. Click the badge → **↺ Reset to market default**.
  - If it shows `09:30–16:00 New_York` and you still see nothing, try toggling **Session Only → Show 24h** to reveal whether the bars are landing on non-session slots.

### "Rescan disk" button doesn't pick up the new symbol

`↻ Rescan disk` re-reads `public/data/markets/manifest.json`. If the symbol isn't there, the downloader didn't rebuild the manifest. Two things to try:

1. Re-run the downloader — the manifest step runs at the end.
2. Rebuild the manifest by hand for any script:
   ```bash
   python scripts/mock_alpaca.py --rebuild-manifest-only
   # or
   python scripts/import_market.py --rebuild-manifest-only
   ```
   Both scripts import the same `_manifest.py` helper and scan the whole `public/data/markets/` tree.

---

## 1. Alpaca — US equities (S&P 500)

### Prerequisites

- Free Alpaca account: https://app.alpaca.markets/signup
- API key + secret from **Dashboard → API Keys → Generate New Keys**
- Python 3.8+
- One package: `pip install alpaca-py` (Alpaca's official SDK, used by the script exactly as shown in the [official docs](https://docs.alpaca.markets/us/docs/getting-started-with-alpaca-market-data))

Save the **Secret Key** when it's shown — Alpaca only reveals it once. If you lose it, regenerate the pair on the same dashboard page.

### What Alpaca gives you

On the dashboard the "Generate New Keys" dialog shows two values:

| Alpaca label       | Example value                        | Env var to export           |
| ------------------ | ------------------------------------ | --------------------------- |
| **API Key ID**     | `PK7GX8...` (paper) or `AK...` (live) | `APCA_API_KEY_ID`           |
| **Secret Key**     | `abCD12...` (long random string)     | `APCA_API_SECRET_KEY`       |

Env-var names match Alpaca's own convention (they mirror the HTTP headers `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY` documented in the [Alpaca docs](https://docs.alpaca.markets/us/docs/getting-started-with-alpaca-market-data)).

### Setup

```bash
cd /Users/rajanpsi/Dev/simonkrpaul/chart-fin

# "API Key ID" from the Alpaca dashboard (public, starts with PK or AK)
export APCA_API_KEY_ID=PKxxxxxxxxxxxxxxxx

# "Secret Key" from the Alpaca dashboard (long random string)
export APCA_API_SECRET_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

If you'd rather pass them per invocation:
```bash
python scripts/download_alpaca.py --key-id PK... --secret-key ab... \
    --universe sp500 --timeframe 1d
```

### First run — smoke test

Always verify keys with 2–3 tickers before kicking off the full 500.

```bash
python scripts/download_alpaca.py --asset stock \
    --symbols AAPL,MSFT,NVDA --timeframe 1d --years 1
```

Expected output:
```
[plan] stock · 3 symbols · 1d · 2025-09-06 → 2026-09-06 · feed=iex
[ok] AAPL      252 bars → public/data/markets/us_equity/AAPL_1d.csv
[ok] MSFT      252 bars → public/data/markets/us_equity/MSFT_1d.csv
[ok] NVDA      252 bars → public/data/markets/us_equity/NVDA_1d.csv
[batch] 3 symbols in 1.4s
[done] 3 symbols · 756 bars total
[manifest] rebuilt · N series
```

### Top 50 most-traded US stocks — 1-minute bars

Best starter universe: 50 mega-caps + high-volume ETFs (curated in the script — mostly stable across quarters). 1-minute bars are the finest granularity Alpaca provides for stocks.

```bash
# 2 years of 1m bars for the top-50 universe (~1 GB on disk, ~20 min)
python scripts/download_alpaca.py --asset stock \
    --universe top50 --timeframe 1m --years 2 --resume

# 5 years of 1m — bigger, run overnight
python scripts/download_alpaca.py --asset stock \
    --universe top50 --timeframe 1m --years 5 --resume
```

What `top50` covers (curated list in [scripts/download_alpaca.py](../scripts/download_alpaca.py)):

- **Tech (11)** NVDA · AAPL · MSFT · AMZN · META · GOOGL · GOOG · TSLA · AVGO · AMD · NFLX
- **Semis / hardware (5)** TSM · INTC · QCOM · MU · ORCL
- **Financials (8)** JPM · BAC · WFC · V · MA · GS · MS · SCHW
- **Healthcare (7)** LLY · UNH · JNJ · PFE · ABBV · MRK · TMO
- **Consumer (7)** WMT · COST · HD · MCD · KO · PEP · NKE
- **Energy (3)** XOM · CVX · COP
- **Media / comms (3)** DIS · CMCSA · T
- **ETFs (6)** SPY · QQQ · IWM · DIA · VOO · VTI

#### Expected output for `--universe top50 --timeframe 1m --years 2`

- ~50 symbols × ~500 trading days × ~390 bars/day = ~10 M rows total
- On disk: 50 files, ~15–25 MB each in `public/data/markets/us_equity/`
- Wall time: **≈ 15–30 min** on a normal broadband connection

#### Recommended flow for large 1m downloads

```bash
# 1. Run inside tmux/screen so a laptop lid-close doesn't kill it
tmux new -s alpaca

# 2. Smoke test on 3 symbols first
python scripts/download_alpaca.py --asset stock \
    --symbols AAPL,MSFT,NVDA --timeframe 1m --years 1

# 3. Full download with --resume so retries pick up where they left off
python scripts/download_alpaca.py --asset stock \
    --universe top50 --timeframe 1m --years 2 --resume

# 4. Detach: Ctrl-B then D. Reattach later with `tmux attach -t alpaca`
```

### Full S&P 500

```bash
# Daily bars, 5 years  (~2 min)
python scripts/download_alpaca.py --asset stock --universe sp500 --timeframe 1d --years 5

# Hourly bars, 2 years (~10 min)
python scripts/download_alpaca.py --asset stock --universe sp500 --timeframe 1h --years 2

# 1-minute bars, 1 year — slow (≈ 2 hours). Always use --resume.
python scripts/download_alpaca.py --asset stock --universe sp500 --timeframe 1m --years 1 --resume
```

### Alpaca crypto (no keys needed)

Alpaca also serves free crypto bars via `CryptoHistoricalDataClient` — no API key required. Use `--asset crypto`:

```bash
python scripts/download_alpaca.py --asset crypto \
    --symbols "BTC/USD,ETH/USD,SOL/USD" --timeframe 1d --years 3
```

Files land in `public/data/markets/crypto/BTCUSD_1d.csv` etc. (the `/` is stripped for the filename).

### Common flags

| Flag | Purpose |
| --- | --- |
| `--asset stock \| crypto` | Which client to use (default `stock`) |
| `--universe top50` | Curated top 50 most-traded US stocks (mega-caps + high-volume ETFs) |
| `--universe sp500` | Scrape current S&P 500 list from Wikipedia (stocks only; falls back to 40 majors) |
| `--symbols AAPL,MSFT,NVDA` | Explicit list. Crypto uses `BTC/USD,ETH/USD` |
| `--timeframe 1d` | `1m 5m 15m 1h 4h 1d 1w 1M` |
| `--years 5` | Look-back window (default 5) |
| `--start 2020-01-01 --end 2024-12-31` | Overrides `--years` |
| `--feed iex` | Stocks only. Free tier default. `sip` requires a paid plan |
| `--adjustment raw` | Stocks only. `raw` (default), `split`, `dividend`, `all` |
| `--resume` | Skip symbols whose CSV already exists — safe to re-run |
| `--rebuild-manifest-only` | Rewrite `manifest.json` from files on disk (no download) |

### After the run

1. `pnpm dev` (or refresh the tab).
2. **📈 Open chart → ↻ Rescan disk** — new symbols show up.
3. Pick one → timeframes not stored are marked `(derived)` and resample from the finest stored TF.

### Time estimates (free IEX feed, ~150 req/min throttle)

| Query | Rows | Approx. duration |
| --- | --- | --- |
| Top 50 · `1d` · 5 years   | 60 k    | < 1 min |
| Top 50 · `1h` · 2 years   | 200 k   | 2 min  |
| **Top 50 · `1m` · 2 years** | **10 M**  | **15–30 min** |
| Top 50 · `1m` · 5 years   | 25 M    | 45 min – 1 h |
| S&P 500 · `1d` · 5 years  | 600 k   | 2 min |
| S&P 500 · `1h` · 2 years  | 2 M     | 10 min |
| S&P 500 · `1m` · 1 year   | 50 M    | ≈ 2 hours |

### Alpaca specifics

| Concern | Answer |
| --- | --- |
| Free feed | `iex` — 15-min delayed but unlimited historical depth for equities |
| Real-time | `sip` — paid subscription required |
| Rate limit | 200 req/min. Script sleeps 400 ms between pages |
| Batch cap | 100 symbols per `symbols=…` call (Alpaca limit) |
| Auth | Headers `APCA-API-KEY-ID` + `APCA-API-SECRET-KEY` |
| Symbols with dots | Wikipedia writes `BRK.B`; Alpaca wants `BRK-B`. Script converts automatically |
| Adjustments | Choose once at download; you can re-download later with a different `--adjustment` |

### Troubleshooting

| Error | Fix |
| --- | --- |
| `Alpaca SDK not installed. Install it with: pip install alpaca-py` | Do exactly that. In a pyenv env: `pyenv activate AI && pip install alpaca-py` |
| `Missing Alpaca credentials.` | Re-run the two `export` commands in the *same* shell you're running the script in |
| `401 Unauthorized` / `forbidden` | Wrong key/secret — regenerate on the Alpaca dashboard |
| `subscription does not permit querying recent SIP` | Drop `--feed sip` (default is `iex`) |
| `invalid symbol` | Check the symbol exists on Alpaca (delisted tickers, dots vs dashes) — script prints `[skip]` and moves on |
| `[warn] Wikipedia unreachable` | Script falls back to 40 hard-coded majors and keeps going |
| Wrong Python interpreter | `pyenv activate AI` (or your env) then `python --version` → must be 3.8+ |

---

## 2. Bybit — crypto (BTCUSDT etc.)

### Prerequisites

- No API key required (public market data)
- Python 3.8+
- Extra packages: `pip install pandas requests`

### Setup

```bash
cd /Users/rajanpsi/Dev/simonkrpaul/chart-fin
pip install pandas requests
```

### First run — 5 years of BTCUSDT 1m

```bash
python scripts/bybit_sync.py
```

Fetches 1-minute BTCUSDT bars from Bybit's v5 REST API. On subsequent runs it only fetches bars since the last stored candle, so weekend/offline gaps fill automatically.

Output files (chart-fin manifest layout, picker sees them on refresh):

```
public/data/markets/crypto/BTCUSDT_1m.csv       ← full 1m history
public/data/markets/crypto/BTCUSDT_5m.csv       ← resampled from 1m
public/data/markets/crypto/BTCUSDT_1h.csv       ← resampled
public/data/markets/crypto/BTCUSDT_1d.csv       ← resampled
public/data/markets/crypto/BTCUSDT_1w.csv       ← resampled
public/data/markets/crypto/BTCUSDT.meta.json    ← exchange / description
public/data/markets/manifest.json               ← rebuilt at end
```

### Common flags

| Flag | Purpose |
| --- | --- |
| `--symbol BTCUSDT` | Trading pair (default `BTCUSDT`) |
| `--years 5` | Look-back window (default 5, ≈ 20–40 min for full run) |
| `--category linear` | Bybit market: `linear` perp, `inverse`, `spot` |
| `--market crypto` | Which `markets/<bucket>/` folder to write into (default `crypto`) |
| `--out-dir <dir>` | Override the output directory entirely (bypasses `markets/`) |
| `--legacy` | Write to the old flat `public/data/bybit_<symbol>_<tf>.csv` layout |
| `--no-manifest` | Skip the manifest rebuild step |

### Examples

```bash
# 2 years of ETHUSDT perp
python scripts/bybit_sync.py --symbol ETHUSDT --years 2

# BTC spot instead of perp
python scripts/bybit_sync.py --symbol BTCUSDT --category spot

# Custom output location (also skips manifest rebuild — this is a raw dump)
python scripts/bybit_sync.py --out-dir /tmp/bybit-dump --no-manifest
```

### After the run

1. Refresh the browser (⌘R).
2. **📈 Open chart → ↻ Rescan disk**.
3. Pick `Crypto (24/7 UTC) → BTCUSDT → 1m` — everything up to `1M` is available (resampled from 1m where needed).

### Bybit specifics

| Concern | Answer |
| --- | --- |
| Auth | None — public REST |
| Rate limit | 120 req/min. Script sleeps between requests |
| Timeframes | `1 3 5 15 30 60 240 D W M` (script uses `1` and resamples the rest) |
| Category | `linear` = USDT-margined perps; `inverse` = coin-margined; `spot` = spot pairs |
| History depth | ~5 years for major pairs; less for newer listings |
| Live streaming | Not in this script. Use the Bybit adapter in the UI (WebSocket) for real-time |

### Troubleshooting

| Error | Fix |
| --- | --- |
| `pandas is required: pip install pandas` | `pip install pandas` — same for `requests` |
| `Bybit REST 429` | Rate-limited — script waits and retries; nothing to do |
| Weekly gaps appearing | Re-run the script — it fetches only the gap since the last candle |
| Symbol not found | Check https://www.bybit.com/en/trade for the exact ticker |

---

## 3. Dukascopy — forex + metals (XAUUSD, EURUSD, …)

Free tick / native-candle datafeed from Dukascopy Bank SA. No account needed.

### Setup

```bash
cd /Users/rajanpsi/Dev/simonkrpaul/chart-fin
pip install requests
```

### First run — 1 year of XAUUSD 1-minute

```bash
python scripts/download_dukascopy.py \
    --symbol XAUUSD --start 2025-01-01 --end today --tf 1m
```

Output files (auto-picks `metals` for XAU/XAG, `forex` for FX pairs):

```
public/data/markets/metals/XAUUSD_1m.csv
public/data/markets/metals/XAUUSD.meta.json
public/data/markets/manifest.json               ← rebuilt at end
```

### Multi-timeframe run

```bash
# Native M1/H1/D1 from Dukascopy (fast — no tick download needed)
python scripts/download_dukascopy.py \
    --symbol XAUUSD --start 2024-01-01 --end today \
    --tf 1m --tf 1h --tf 1d --tf 1w
```

### Full history since Dukascopy began publishing

```bash
python scripts/download_dukascopy.py \
    --symbol XAUUSD --start 2003-05-05 --end today \
    --tf 1m --resume
```

Uses a state file so you can Ctrl-C and resume.

### Common flags

| Flag | Purpose |
| --- | --- |
| `--symbol XAUUSD` | Any Dukascopy instrument (XAUUSD, EURUSD, GBPJPY, etc.) |
| `--start 2024-01-01` | Start date (default: earliest known for the symbol) |
| `--end today` | End date or ISO date |
| `--tf 1m --tf 1h --tf 1d` | One or more timeframes (repeat the flag) |
| `--price bid \| ask \| mid` | Which side to write (`mid` requires tick source, slower) |
| `--source auto \| native \| tick` | `native` = Dukascopy's OHLC files (fast). `tick` = raw ticks aggregated (slower, needed for custom TFs) |
| `--threads 8` | Parallel HTTP connections (default 8) |
| `--market metals` | Override the auto-picked market bucket |
| `--resume` | Skip hourly `.bi5` files already recorded in the state file |

### Dukascopy specifics

| Concern | Answer |
| --- | --- |
| Auth | None — public datafeed |
| File format | Hourly `.bi5` files (LZMA-compressed 20-byte tick records or 24-byte candles) |
| Point value | 5-decimal for most FX; 3-decimal for XAU/XAG and JPY pairs — script handles automatically |
| Weekends | Dukascopy skips Saturdays entirely for FX; empty hourly files are legitimate |
| DST | Timestamps are UTC — handled correctly regardless of your local tz |

### After the run

1. Refresh the browser (⌘R).
2. **📈 Open chart → ↻ Rescan disk**.
3. Pick `metals → XAUUSD` (or `forex → EURUSD` etc.) → any TF.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| "no ticks in that hour" during weekend | Expected — Dukascopy has no weekend data for FX |
| Same-symbol re-run overwrites | Use `--resume` — the state file records completed hourly files |
| Prices look 1000× too big | Point value mis-detected — add the symbol to `POINT_VALUE` in the script |
| DNS timeout on `datafeed.dukascopy.com` | Corporate firewall / VPN blocking port 53 or Dukascopy's CDN |

---

## 4. Kaggle Bitcoin — 10 years of BTC/USD 1-minute bars

Handles the [mczielinski/bitcoin-historical-data](https://www.kaggle.com/datasets/mczielinski/bitcoin-historical-data) Kaggle dataset (~330 MB, ~5 M 1-minute rows going back to 2012).

### Setup

```bash
pip install kagglehub pandas
export KAGGLE_API_TOKEN=KGAT_...      # from https://www.kaggle.com/settings/account
```

### Usage

```bash
python scripts/download_kaggle_btc.py

# Skip re-download if the staged CSV already exists
python scripts/download_kaggle_btc.py --use-cached
```

Output files:

```
public/data/kaggle/btcusd_1-min_data.csv        ← staged raw file (cached, reused with --use-cached)
public/data/markets/crypto/BTCUSDT_1m.csv       ← reformatted
public/data/markets/crypto/BTCUSDT_5m.csv       ← resampled from 1m
public/data/markets/crypto/BTCUSDT_1h.csv
public/data/markets/crypto/BTCUSDT_1d.csv
public/data/markets/crypto/BTCUSDT_1w.csv
public/data/markets/crypto/BTCUSDT.meta.json
public/data/markets/manifest.json               ← rebuilt at end
```

### After the run

1. Refresh the browser (⌘R).
2. **📈 Open chart → ↻ Rescan disk**.
3. Pick `crypto → BTCUSDT → 1m` — 10 years of history immediately available.

**Note:** If you also run `download_btc.py --binance`, both scripts write to
the same files. The last one to run wins. `download_kaggle_btc.py` gives
you deeper history (back to 2012); `download_btc.py --binance` gives you
the freshest bars (right up to now). You can chain them by running Kaggle
first, then `download_btc.py --binance --days 30` to top-up the tail.

---

## 5. Mock Alpaca — synthetic US equity 1-minute bars

Offline generator that produces a full month of NYSE-hours 1-minute bars in the exact Alpaca CSV schema. Perfect for demos, tests, or working while your VPN blocks Alpaca / Dukascopy.

### Usage

```bash
python scripts/mock_alpaca.py                             # 30 days of MOCKAPL
python scripts/mock_alpaca.py --symbol MOCKMSFT --days 30
python scripts/mock_alpaca.py --end 2024-12-31 --days 90
python scripts/mock_alpaca.py --rebuild-manifest-only     # just refresh manifest.json
```

Output:

```
public/data/markets/us_equity/MOCKAPL_1m.csv     ← 8,190 rows / 30 days
public/data/markets/us_equity/MOCKAPL.meta.json
public/data/markets/manifest.json                ← rebuilt at end
```

Symbols starting with `MOCK` are safe to use anywhere — they can't collide with real tickers on Alpaca.

---

## Related scripts

| Script | Purpose |
| --- | --- |
| [scripts/_manifest.py](../scripts/_manifest.py) | Shared helper — rebuilds `public/data/markets/manifest.json`. All downloaders call this |
| [scripts/import_market.py](../scripts/import_market.py) | Promote an arbitrary CSV into `public/data/markets/<market>/<symbol>_<tf>.csv` and rebuild manifest |
| [scripts/import_kaggle_sp500.py](../scripts/import_kaggle_sp500.py) | Split a Kaggle S&P 500 master CSV (~500 symbols in one file) into per-symbol daily CSVs |
| [scripts/mock_data.py](../scripts/mock_data.py) | Generate synthetic OHLCV for 4 profiles (crypto / us_eq / asx / forex) — no keys needed |
| [scripts/mock_alpaca.py](../scripts/mock_alpaca.py) | Alpaca-schema equity mock (offline demo) |
| [scripts/fill_gaps.py](../scripts/fill_gaps.py) | Detect and repair missing bars in an existing CSV (forward-fill / linear / amendments) |

---

## 6. Kaggle S&P 500 dataset — daily bars for all 500 symbols

Handles Kaggle datasets like [andrewmvd/sp-500-stocks](https://www.kaggle.com/datasets/andrewmvd/sp-500-stocks) that ship a single master CSV with every symbol's daily prices concatenated (~288 MB, ~2.9 M rows).

### Expected files

```
public/data/usstock/sp500_stocks.csv       # required — master price file
public/data/usstock/sp500_companies.csv    # optional — sector/industry metadata
```

### Expected schema

```
date,open,high,low,close,volume,symbol
2000-01-03,46.87,46.99,40.10,42.86,4674353.0,A
```

`date` may be `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`. Column named `timestamp` also works.

### Modes

| `--mode` | Behaviour | When to use |
| --- | --- | --- |
| `skip` (default) | Existing per-symbol files are left untouched. New symbols added. | First-time import; guard against accidental overwrites |
| **`append`** | For each symbol, reads its file's last timestamp, then only writes rows with a strictly greater ts. | **Daily updates** against a refreshed Kaggle dump |
| `overwrite` | Every symbol file rewritten from scratch. | Schema changes, adjustment fixes, corrupt files |

### Run

```bash
# First-time import — split, enrich with companies metadata, rebuild manifest
python scripts/import_kaggle_sp500.py \
    --companies public/data/usstock/sp500_companies.csv

# ★ Daily update — appends only new rows since the last run
python scripts/import_kaggle_sp500.py --mode append \
    --input public/data/usstock/sp500_stocks.csv

# Full rewrite (e.g. after adjustment change)
python scripts/import_kaggle_sp500.py --mode overwrite

# Just rebuild manifest.json (after moving files around)
python scripts/import_kaggle_sp500.py --rebuild-manifest-only
```

### Daily update flow

Once the initial import is done, this becomes your **one-command daily routine**:

```bash
# 1. Refresh the Kaggle dataset (however you download it)
#    e.g. kaggle datasets download andrewmvd/sp-500-stocks --path public/data/usstock/ -o
#         unzip public/data/usstock/sp-500-stocks.zip -d public/data/usstock/

# 2. Append-only import — writes only new bars per symbol
python scripts/import_kaggle_sp500.py --mode append

# 3. In the running app: 📈 Open chart → ↻ Rescan disk
#    The browser's manifest re-ingest is ALSO delta-aware: it checks the
#    existing (firstTs, lastTs) per series and only writes rows outside that
#    range. So an unchanged file is a no-op; a file with 1 new row is a 1-row
#    write. No re-parsing of 25 years of data.
```

Expected output for a typical daily update (~500 symbols × 1 new row each):

```
[plan] splitting public/data/usstock/sp500_stocks.csv → public/data/markets/us_equity/  (mode=append)
[append] 2,942,867 rows skipped (older than existing last ts)
[done] 500 symbols touched · 502 new rows written · 6.4s
[manifest] rebuilt · 500 series
```

### What happens

- Streams the master CSV row-by-row (peak memory ≈ 50 MB — the 288 MB file never sits in RAM as one DataFrame).
- Writes one file per symbol: `public/data/markets/us_equity/<SYMBOL>_1d.csv` in the canonical `timestamp,open,high,low,close,volume,symbol` schema.
- Drops a sidecar `<SYMBOL>.meta.json` with sector/industry/founded from `sp500_companies.csv` if provided (the manifest picks up the `description` field for the picker).
- Rebuilds `public/data/markets/manifest.json`.

Typical run: **≈ 30 seconds** for the full ~500 symbols, ~2.9 M rows.

### Progress output

```
[plan] splitting public/data/usstock/sp500_stocks.csv → public/data/markets/us_equity/  (mode=skip)
[progress] 500,000 rows · 500 symbols · 6.2s elapsed
[progress] 1,000,000 rows · 500 symbols · 12.4s elapsed
…
[done] 500 symbols touched · 2,943,369 new rows written · 31.8s
[manifest] rebuilt · 500 series
```

### After the run

1. `pnpm dev` (or refresh the tab).
2. **📈 Open chart → ↻ Rescan disk**.
3. `US Equities` in the market dropdown now lists every S&P 500 symbol. Timeframe picker shows `1d 1w 1M` (all coarser TFs derive from 1d).

Combines nicely with the Alpaca 1m downloader — daily bars come from Kaggle (deeper history, back to 2000), 1m bars from Alpaca (from ~2016). The app's TF-aware loader picks the right source per timeframe automatically.

---

## Recommended workflows

**Fresh S&P 500 setup**
```bash
pip install alpaca-py
export APCA_API_KEY_ID=PKxxxxxx           # "API Key ID"  from Alpaca dashboard
export APCA_API_SECRET_KEY=xxxxxxxxxxxxx  # "Secret Key"  from Alpaca dashboard
python scripts/download_alpaca.py --asset stock --symbols AAPL,MSFT --timeframe 1d --years 1     # smoke test
python scripts/download_alpaca.py --asset stock --universe sp500 --timeframe 1d --years 5
python scripts/download_alpaca.py --asset stock --universe sp500 --timeframe 1h --years 2 --resume
```

**Fresh crypto setup**
```bash
pip install pandas requests
python scripts/bybit_sync.py --symbol BTCUSDT --years 5
python scripts/bybit_sync.py --symbol ETHUSDT --years 5
for pair in BTCUSDT ETHUSDT; do
  for tf in 1m 5m 1h 1d 1w; do
    python scripts/import_market.py public/data/bybit_$(echo $pair | tr '[:upper:]' '[:lower:]')_${tf}.csv \
        --market crypto --symbol $pair --timeframe $tf
  done
done
```

**After any script run**
1. `pnpm dev` (or refresh).
2. **📈 Open chart → ↻ Rescan disk**.
3. Data is in the picker.

---

## 7. evtradelabs — XAUUSD 5-minute archive

Handles the XAUUSD 5-minute dataset published by [evtradelabs.com](https://evtradelabs.com/) — one JSON file per calendar year with both bid **and** ask sides in a single record. Covers 2004 → present (~1.6 M rows, ~200 MB uncompressed).

The importer writes to a **separate symbol** (default `XAUUSD_EVTL`) so its 5m ↔ 1d ladder stays fully self-consistent and never gets mixed with the Kaggle + ISO `XAUUSD` source. The picker shows the two symbols side-by-side under `forex`, and each timeframe carries its own provenance label (see [Section 8](#8-per-timeframe-provenance-in-metajson)).

### Expected files

Unzip `evtradelabs-data-YYYY-MM-DD.zip` anywhere; you should end up with:

```
<somewhere>/XAUUSD/M5/
├── 2004.json
├── 2005.json
├── …
└── 2026.json
```

Each file is a JSON array of records with **Unix-seconds** timestamps and both sides of the book:

```json
[
  {
    "ts": 1072915200,     // Unix seconds UTC
    "o":  414.92, "h": 414.92, "l": 414.43, "c": 414.64,   // bid OHLC
    "ao": 415.33, "ah": 415.33, "al": 414.92, "ac": 415.15, // ask OHLC
    "v":  0.01801                                          // volume (lots)
  }
]
```

### Run

```bash
# Default: import as XAUUSD_EVTL (mid price) + full resampled ladder
python3.12 scripts/import_evtradelabs_xauusd.py "~/Downloads/evtradelabs-xauusd/XAUUSD/M5"

# Use bid or ask instead of mid (default)
python3.12 scripts/import_evtradelabs_xauusd.py <dir> --price bid
python3.12 scripts/import_evtradelabs_xauusd.py <dir> --price ask

# Merge with existing XAUUSD_EVTL_5m.csv (union timestamps; new wins on collision)
python3.12 scripts/import_evtradelabs_xauusd.py <dir> --mode merge

# Store under a custom symbol (e.g. keep both mid and ask side-by-side)
python3.12 scripts/import_evtradelabs_xauusd.py <dir> --symbol XAUUSD_EVTL_ASK --price ask
```

### What happens

- Reads every `YYYY.json` file under the source dir.
- Converts Unix seconds → Unix milliseconds; **mid** = `(bid + ask) / 2` for each of `o/h/l/c` (unless `--price bid|ask`).
- Writes canonical `public/data/markets/forex/<SYMBOL>_5m.csv`.
- **Resamples the 5m stream in a single in-memory pass** to `15m / 1h / 4h / 1d / 1w / 1mo` — one file per TF, so the whole `<SYMBOL>` ladder shares a single source.
- Updates `<SYMBOL>.meta.json` with per-TF `sources[]` entries — the 5m row is tagged `evtradelabs XAUUSD (<price> price)`, everything else is tagged `evtradelabs XAUUSD (<price>), resampled from 5m`.
- Rebuilds `public/data/markets/manifest.json` via the shared `_manifest.py` helper.
- Does **not** touch any other symbol's files.

Typical run: **≈ 15 seconds** for the full 23 years, ~1.6 M rows + full ladder.

### Two-symbol layout — why the `_EVTL` suffix?

Prior to this split the evtradelabs 5m file was written to the shared `XAUUSD_5m.csv`, next to Kaggle+ISO-derived `XAUUSD_1m/15m/1h/4h/1d/…`. Selecting `5m` gave you evtradelabs mid; switching to `1d` silently jumped to a differently-priced source (Kaggle bid-ish, different timestamps). Signals looked inconsistent.

The `XAUUSD_EVTL` split fixes that:

```
forex/
├── XAUUSD_1m.csv          ← Kaggle + ISO merged
├── XAUUSD_5m.csv          ← resampled from 1m (Kaggle+ISO)
├── XAUUSD_15m … XAUUSD_1mo.csv   ← resampled from 1m
├── XAUUSD.meta.json
├── XAUUSD_EVTL_5m.csv     ← evtradelabs mid
├── XAUUSD_EVTL_15m … XAUUSD_EVTL_1mo.csv   ← resampled from 5m
└── XAUUSD_EVTL.meta.json
```

The picker groups by symbol, so you see two separate entries under `forex`. Each row of the timeframe dropdown carries its own source label (see below).

### Data-quality expectations

- Timestamps aligned to the 5-minute grid (no drift).
- ~99 % strict 5-minute cadence; remaining gaps are weekend / holiday windows (~54 per year).
- OHLC always internally consistent (`H ≥ max(O,C)`, `L ≤ min(O,C)`).
- Coverage stretches through **September 2026** — currently the freshest XAUUSD source we have wired up.

### After the run

1. `pnpm dev` (or refresh the tab).
2. **📈 Open chart → ↻ Rescan disk**.
3. Under `forex` you now see both `XAUUSD` and `XAUUSD_EVTL`. Pick either; every TF inside that symbol stays inside that source.

---

## 8. Per-timeframe provenance in meta.json

Every `<symbol>.meta.json` now supports a `sources` map so a single meta file can advertise different sources for different timeframes without one importer clobbering another's entries.

Schema:

```json
{
  "sources": {
    "1m":  { "exchange": "Kaggle + ISO 1m merged",       "description": "…" },
    "5m":  { "exchange": "evtradelabs XAUUSD (mid)",     "description": "…" },
    "15m": { "exchange": "resampled from 1m",            "description": "…" },
    "1h":  { "exchange": "resampled from 1m",            "description": "…" }
  },
  "exchange":    "Kaggle + ISO 1m merged",
  "description": "…"
}
```

- `sources[<tf>]` wins per timeframe.
- Top-level `exchange` / `description` are the fallback for TFs not listed under `sources`.

Every importer writes its rows via the shared helper:

```python
from _manifest import update_meta_source

_update_meta_source(
    market_dir,          # pathlib.Path to `public/data/markets/<market>/`
    "XAUUSD",            # symbol
    "5m",                # timeframe
    exchange="evtradelabs XAUUSD (mid price)",
    description="Gold (spot) vs USD — evtradelabs M5 archive",
)
```

`update_meta_source` reads the existing meta file, merges the entry into `sources[<tf>]`, and writes it back — other TFs' entries and top-level fields are preserved.

The [ChartPicker](../src/components/ChartPicker.tsx) reads the per-TF exchange back through `PickerSymbol.exchangeByTf` and renders it next to each option in the Timeframe dropdown, e.g.:

```
1m — Kaggle + ISO 1m merged
5m — Kaggle + ISO, resampled from 1m
15m — resampled from 1m
```

For `XAUUSD_EVTL`:

```
5m — evtradelabs XAUUSD (mid price)
15m — evtradelabs XAUUSD (mid), resampled from 5m
1d — evtradelabs XAUUSD (mid), resampled from 5m
```

---

## 9. MetaTrader 5 live sync (Pepperstone demo, Windows)

Pulls OHLC bars straight from a running MT5 terminal and writes them to `public/data/markets/forex/XAUUSD_MT5_<tf>.csv`. Runs one-shot or on a fixed loop (every 10–15 min is typical), so the chart-fin app always sees fresh bars after a **↻ Rescan disk**.

Follows the "one symbol per source" convention — MT5 data lands under a **separate** symbol (default `XAUUSD_MT5`) so it never touches the existing `XAUUSD` (Kaggle+ISO) or `XAUUSD_EVTL` (evtradelabs) files.

### Requirements

- **Windows** — the `MetaTrader5` PyPI package is Windows-only. macOS/Linux users have to run this script on a Windows box (VM, VPS, or the same physical Windows machine as MT5).
- **Python 3.10+** (3.12 recommended).
- `pip install MetaTrader5`.
- The **MT5 terminal** installed and **logged in** to your Pepperstone (or any broker) demo/live account. The Python package attaches to the running terminal — you don't ship credentials in the script.

### Auth model (safe by default)

Two modes:

| Mode | How | When to use | Where the password lives |
| --- | --- | --- | --- |
| **Attach** (default) | `mt5.initialize()` with no args — inherits the running MT5 terminal's session | You already have MT5 open + logged in | Nowhere in Python. MT5 remembers it. |
| **Headless** | `--headless` with `MT5_LOGIN` / `MT5_SERVER` / `MT5_PASSWORD` env vars | Running the script on a headless box (VPS) where no one is at the keyboard | Environment variables sourced from a git-ignored `.env` file |

**Recommendation for a demo account on your desktop**: use attach mode. Nothing sensitive touches disk or git.

### First run — check the connection

Open the MT5 terminal, log in to your Pepperstone demo, and confirm XAUUSD is in the Market Watch panel. Then:

```powershell
# From the chart-fin project folder on Windows
python scripts/mt5_sync.py
```

Expected output:

```
[mt5_sync] connected to Pepperstone-Demo  account=12345678  currency=USD
[mt5_sync] using MT5 symbol: XAUUSD

[mt5_sync] cycle @ 2026-09-29T14:22:11+00:00
  ✓   1m  fetched= 2000  existing=       0  new= 2000  →  XAUUSD_MT5_1m.csv
  ✓   5m  fetched= 2000  existing=       0  new= 2000  →  XAUUSD_MT5_5m.csv
  ✓  15m  fetched= 2000  existing=       0  new= 2000  →  XAUUSD_MT5_15m.csv
  ✓   1h  fetched= 2000  existing=       0  new= 2000  →  XAUUSD_MT5_1h.csv
  ✓   4h  fetched= 2000  existing=       0  new= 2000  →  XAUUSD_MT5_4h.csv
  ✓   1d  fetched= 2000  existing=       0  new= 2000  →  XAUUSD_MT5_1d.csv
  ✓   1w  fetched= 2000  existing=       0  new= 2000  →  XAUUSD_MT5_1w.csv
  ✓   1M  fetched= 2000  existing=       0  new= 2000  →  XAUUSD_MT5_1mo.csv
```

Then in the browser: **📈 Open chart → ↻ Rescan disk**. `forex → XAUUSD_MT5` is now available at every TF, each labelled `MetaTrader5 live (XAUUSD)` in the picker's Timeframe dropdown.

### Loop mode (every 10–15 min)

```powershell
# Every 10 minutes
python scripts/mt5_sync.py --loop 600

# Every 15 minutes, only intraday TFs (skip 1w / 1M which barely change)
python scripts/mt5_sync.py --loop 900 --tf 1m 5m 15m 1h 4h 1d
```

The loop is resumable — Ctrl-C to stop, restart with the same command, dedup is by-timestamp so no duplicates.

Run it as a **Windows Scheduled Task** for unattended sync:

1. Task Scheduler → Create Basic Task
2. Trigger: `Daily`, then `Repeat task every 10 minutes`
3. Action: `python.exe` with argument `C:\path\to\chart-fin\scripts\mt5_sync.py`
4. Start in: `C:\path\to\chart-fin`

Or install [nssm](https://nssm.cc/) and register `python.exe scripts/mt5_sync.py --loop 600` as a service.

### Common flags

| Flag | Purpose |
| --- | --- |
| `--symbol XAUUSD_MT5` | chart-fin symbol name for output. Keep DIFFERENT from other XAUUSD sources |
| `--mt5-symbol XAUUSD` | Broker-side symbol. Auto-tries `.raw` / `.i` / `GOLD` if the plain name isn't found |
| `--tf 5m 15m 1h` | Restrict to specific TFs (default: all 8) |
| `--bars 2000` | Bars per TF per cycle. MT5 caps around 100 k; 2 000 is plenty for a 10 min loop |
| `--loop 600` | Repeat every 600 s. `0` = one-shot (default) |
| `--headless` | Log in from the script instead of attaching |

### Pepperstone symbol names

Different broker accounts advertise XAUUSD under slightly different names. `mt5_sync.py` probes automatically — you'll see one of:

```
[mt5_sync] using MT5 symbol: XAUUSD
[mt5_sync] using MT5 symbol: XAUUSD.raw     ← Pepperstone Razor (ECN) account
[mt5_sync] using MT5 symbol: XAUUSD.i       ← some cent accounts
[mt5_sync] using MT5 symbol: GOLD           ← some brokers
```

If none match, open MT5 → View → Symbols → find the actual name → pass with `--mt5-symbol <name>`.

### Seeding `XAUUSD_MT5` with existing history (evtradelabs / any other source)

Fresh `mt5_sync.py` runs only give you the last ~2 000 bars per TF that MT5 returns. If you want the full multi-year evtradelabs history behind you and just want MT5 to extend the tail from now on, copy the files once — the sync script's merge is timestamp-keyed and is happy to append to a pre-populated CSV.

**Mac / Linux:**

```bash
cd /Users/rajanpsi/Dev/simonkrpaul/chart-fin

# Seed a single TF (5m)
cp public/data/markets/forex/XAUUSD_EVTL_5m.csv \
   public/data/markets/forex/XAUUSD_MT5_5m.csv

# Or seed the whole ladder in one shot
for tf in 5m 15m 1h 4h 1d 1w 1mo; do
  cp public/data/markets/forex/XAUUSD_EVTL_${tf}.csv \
     public/data/markets/forex/XAUUSD_MT5_${tf}.csv
done

# Refresh the manifest so the picker sees XAUUSD_MT5 before the first sync
python3.12 -c "import sys,pathlib; sys.path.insert(0,'scripts'); from _manifest import rebuild_manifest; p=pathlib.Path('.').resolve(); rebuild_manifest(p/'public'/'data'/'markets', repo_root=p)"
```

**Windows PowerShell:**

```powershell
cd C:\path\to\chart-fin

# One TF
Copy-Item public\data\markets\forex\XAUUSD_EVTL_5m.csv `
          public\data\markets\forex\XAUUSD_MT5_5m.csv

# Whole ladder
foreach ($tf in @('5m','15m','1h','4h','1d','1w','1mo')) {
  Copy-Item "public\data\markets\forex\XAUUSD_EVTL_${tf}.csv" `
            "public\data\markets\forex\XAUUSD_MT5_${tf}.csv"
}

python scripts\mt5_sync.py --tf 5m 15m 1h 4h 1d 1w 1M   # first sync — appends only new bars
python scripts\mt5_sync.py --loop 600                   # keep it live
```

Expected first-cycle output after seeding:

```
[mt5_sync]   5m  fetched= 2000  existing=1,627,794  new= <few hundred>  →  XAUUSD_MT5_5m.csv
```

`existing` = your seeded history, `new` = only the bars whose timestamps are past the last row in the seed. Subsequent cycles add only whatever MT5 has generated since the previous run.

**Trade-offs to know about:**

- Historical bars use whatever price side the seed source stored (evtradelabs = mid). Fresh MT5 bars use whatever your broker publishes (Pepperstone = broker-bid). There will be a small price seam wherever the switchover happens — cosmetic on the chart, a few pips on XAUUSD.
- Every cycle overwrites `XAUUSD_MT5.meta.json → sources[<tf>]` with `"MetaTrader5 live (XAUUSD)"` even though most of the rows are actually from the seed source. If you want a truer label, edit that field manually once — the sync script only touches the per-TF entry it's writing, so hand-edits to _other_ TFs stick.
- After copying you can safely delete `XAUUSD_EVTL_*` files if you don't need the second symbol — the seeded rows already live in `XAUUSD_MT5_*`.

### Cross-platform notes

The chart-fin **Vite app** itself runs identically on Windows and macOS — `pnpm install && pnpm dev` from the project folder just works. All the ingestion scripts (`import_*`, `download_*`) use `pathlib.Path`, so paths port cleanly.

The **only** OS-locked piece is `mt5_sync.py` (blocked by the MT5 Python package). Everything else you've ingested from a Mac keeps working when you clone the repo on Windows.

### What NOT to do

- **Don't commit credentials.** If you use headless mode, put the env vars in `.env` and add `.env` to `.gitignore`.
- **Don't share the MT5 investor password with headless mode by accident** — the investor password grants read-only account access, but the main password grants trading. Use the read-only one if MT5's `INVESTOR_PASSWORD_MODE` flag suits your broker.
- **Don't run the loop while manually importing** (`import_evtradelabs_xauusd.py --symbol XAUUSD_MT5 …`) — the two would fight over the same files. Different symbols keep them out of each other's way.
