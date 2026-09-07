# Data ingestion scripts

Two Python scripts fetch historical OHLCV data and drop it where the browser can auto-load it. Same pattern for both: run the script → refresh the app → the new series show up in the chart picker.

---

## TL;DR

| Script | Source | What it downloads | Layout |
| --- | --- | --- | --- |
| [scripts/download_alpaca.py](../scripts/download_alpaca.py) | Alpaca Market Data v2 | US equities (S&P 500 or your list) | `public/data/markets/us_equity/<SYMBOL>_<tf>.csv` |
| [scripts/bybit_sync.py](../scripts/bybit_sync.py) | Bybit v5 public API | Crypto (e.g. BTCUSDT), 1m + resampled | `public/data/bybit_<symbol>_<tf>.csv` |

Both rewrite [public/data/markets/manifest.json](../public/data/markets/manifest.json) when they finish (the Alpaca script directly, Bybit indirectly via `import_market.py`). The frontend calls `ingestManifest()` on boot and via the **↻ Rescan disk** button in the chart picker.

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

Output files:

```
public/data/bybit_btcusdt_1m.csv    ← full 1m history
public/data/bybit_btcusdt_5m.csv    ← resampled from 1m
public/data/bybit_btcusdt_1h.csv    ← resampled
public/data/bybit_btcusdt_1d.csv    ← resampled
public/data/bybit_btcusdt_1w.csv    ← resampled
```

### Common flags

| Flag | Purpose |
| --- | --- |
| `--symbol BTCUSDT` | Trading pair (default `BTCUSDT`) |
| `--years 5` | Look-back window (default 5, ≈ 20–40 min for full run) |
| `--category linear` | Bybit market: `linear` perp, `inverse`, `spot` |
| `--out-dir public/data/` | Where to write CSVs |

### Examples

```bash
# 2 years of ETHUSDT perp
python scripts/bybit_sync.py --symbol ETHUSDT --years 2

# BTC spot instead of perp
python scripts/bybit_sync.py --symbol BTCUSDT --category spot

# Custom output location
python scripts/bybit_sync.py --out-dir /tmp/bybit-dump
```

### Promote Bybit files to the multi-market layout

`bybit_sync.py` writes into `public/data/` directly, not into the market layout. To make them appear under `crypto` in the chart picker, run the promoter script:

```bash
for tf in 1m 5m 1h 1d 1w; do
  python scripts/import_market.py public/data/bybit_btcusdt_${tf}.csv \
      --market crypto --symbol BTCUSDT --timeframe $tf
done
```

`import_market.py` moves (or hard-links) each CSV into `public/data/markets/crypto/BTCUSDT_<tf>.csv` and rewrites `manifest.json`.

### After the run

1. `pnpm dev` (or refresh the tab).
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

## Related scripts

| Script | Purpose |
| --- | --- |
| [scripts/import_market.py](../scripts/import_market.py) | Move any CSV into `public/data/markets/<market>/<symbol>_<tf>.csv` and rebuild manifest |
| [scripts/import_kaggle_sp500.py](../scripts/import_kaggle_sp500.py) | Split a Kaggle S&P 500 master CSV (~500 symbols in one file) into per-symbol daily CSVs |
| [scripts/mock_data.py](../scripts/mock_data.py) | Generate synthetic OHLCV for 4 profiles (crypto / us_eq / asx / forex) — no keys needed |
| [scripts/fill_gaps.py](../scripts/fill_gaps.py) | Detect and repair missing bars in an existing CSV (forward-fill / linear / amendments) |

---

## 3. Kaggle S&P 500 dataset — daily bars for all 500 symbols

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
