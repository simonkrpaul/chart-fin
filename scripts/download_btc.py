#!/usr/bin/env python3
"""
download_btc.py
─────────────────────────────────────────────────────────────────────────────
Downloads the Bitcoin historical OHLCV dataset and converts it into
chart-fin-compatible CSV files in public/data/.

Sources
───────
  --binance       Download latest data from Binance REST API (no API key needed)
  --local FILE    Use a locally downloaded CSV (e.g. from Kaggle)
  (default)       Download from Kaggle via kagglehub

Binance mode
────────────
  Fetches up to 1000 bars per request from the /api/v3/klines endpoint.
  Uses pagination to get historical data. Writes all timeframes.
  No libraries beyond `requests` + `pandas` required.

  python scripts/download_btc.py --binance
  python scripts/download_btc.py --binance --days 365

Output files written to public/data/
──────────────────────────────────────
  btc_1m.csv   – 1-minute bars
  btc_5m.csv   – 5-minute OHLCV
  btc_1h.csv   – 1-hour  OHLCV
  btc_1d.csv   – 1-day   OHLCV
  btc_1w.csv   – 1-week  OHLCV

Column format expected by chart-fin
──────────────────────────────────────
  timestamp,open,high,low,close,volume

  timestamp: Unix milliseconds UTC
  volume:    BTC volume
"""

import sys
import argparse
import pathlib
import time
import pandas as pd

# ── CLI ────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="Download BTC data for chart-fin")
parser.add_argument(
    "--local", metavar="FILE",
    help="Path to a locally downloaded CSV (skips network download). "
         "e.g. ~/Downloads/btcusd_1-min_data.csv",
)
parser.add_argument(
    "--binance", action="store_true",
    help="Fetch latest data from the Binance REST API (no API key needed).",
)
parser.add_argument(
    "--days", type=int, default=365,
    help="Number of days of history to fetch in Binance mode (default: 365).",
)
args = parser.parse_args()

# ── Paths ─────────────────────────────────────────────────────────────────
REPO_ROOT = pathlib.Path(__file__).parent.parent
OUT_DIR = REPO_ROOT / "public" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

DATASET = "mczielinski/bitcoin-historical-data"

# ── Binance API download ──────────────────────────────────────────────────

def fetch_binance(symbol: str, interval: str, days: int) -> pd.DataFrame:
    """Fetch OHLCV data from Binance REST API using pagination."""
    import requests

    url = "https://api.binance.com/api/v3/klines"
    limit = 1000
    end_time = int(time.time() * 1000)  # now in ms
    start_time = end_time - (days * 24 * 60 * 60 * 1000)

    all_rows = []
    current_start = start_time

    print(f"Fetching {symbol} {interval} from Binance ({days} days) …")
    while current_start < end_time:
        params = {
            "symbol": symbol,
            "interval": interval,
            "startTime": current_start,
            "endTime": end_time,
            "limit": limit,
        }
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        if not data:
            break

        for k in data:
            all_rows.append({
                "timestamp": int(k[0]),  # open time in ms
                "open": float(k[1]),
                "high": float(k[2]),
                "low": float(k[3]),
                "close": float(k[4]),
                "volume": float(k[5]),
            })

        # Move start to after the last candle
        current_start = int(data[-1][0]) + 1

        if len(data) < limit:
            break

        # Rate limit: Binance allows ~1200 requests/min, be polite
        time.sleep(0.1)

    df = pd.DataFrame(all_rows)
    df = df.drop_duplicates("timestamp").sort_values("timestamp").reset_index(drop=True)
    print(f"  Fetched {len(df):,} bars")
    return df


if args.binance:
    # ── Fetch from Binance and write all timeframes ──
    clean = fetch_binance("BTCUSDT", "1m", args.days)

    if clean.empty:
        sys.exit("No data received from Binance.")

elif args.local:
    csv_file = pathlib.Path(args.local).expanduser().resolve()
    if not csv_file.exists():
        sys.exit(f"File not found: {csv_file}")
    print(f"Reading local file: {csv_file}")
    csv_file_to_parse = csv_file
else:
    # ── Try to import kagglehub ──────────────────────────────────────────
    try:
        import kagglehub
    except ImportError:
        sys.exit(
            "kagglehub not installed.\n"
            "Run: pip install 'kagglehub[pandas-datasets]' pandas\n\n"
            "If Kaggle is blocked by your network, download the CSV manually from\n"
            "  https://www.kaggle.com/datasets/mczielinski/bitcoin-historical-data\n"
            "and re-run with:  python3 scripts/download_btc.py --local /path/to/file.csv"
        )
    print(f"Downloading {DATASET} from Kaggle …")
    try:
        dataset_path = pathlib.Path(kagglehub.dataset_download(DATASET))
    except Exception as e:
        sys.exit(
            f"Kaggle download failed: {e}\n\n"
            "If Kaggle is blocked by your network, download the CSV manually from\n"
            "  https://www.kaggle.com/datasets/mczielinski/bitcoin-historical-data\n"
            "and re-run with:  python3 scripts/download_btc.py --local /path/to/file.csv"
        )
    print(f"  Dataset cached at: {dataset_path}")
    csv_files = list(dataset_path.glob("*.csv"))
    if not csv_files:
        sys.exit(f"No CSV files found in {dataset_path}. Files: {list(dataset_path.iterdir())}")
    csv_file_to_parse = csv_files[0]
    print(f"  Reading: {csv_file_to_parse.name}")

# ── Parse CSV for local/Kaggle paths ─────────────────────────────────────
if not args.binance:
    df = pd.read_csv(csv_file_to_parse)
    print(f"  Raw rows: {len(df):,}  columns: {list(df.columns)}")

    # Normalise columns
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    close_col = "close" if "close" in df.columns else "weighted_price"
    vol_col   = "volume_(btc)" if "volume_(btc)" in df.columns else \
                "volume_(currency)" if "volume_(currency)" in df.columns else \
                "volume" if "volume" in df.columns else None

    # Legacy local BTC CSVs commonly use "Timestamp" in Unix seconds.
    local_timestamp_col = "timestamp" if "timestamp" in df.columns else "time" if "time" in df.columns else "t"

    rows = {
        "timestamp_raw": pd.to_numeric(df[local_timestamp_col], errors="coerce"),
        "open":          pd.to_numeric(df["open"],        errors="coerce"),
        "high":          pd.to_numeric(df["high"],        errors="coerce"),
        "low":           pd.to_numeric(df["low"],         errors="coerce"),
        "close":         pd.to_numeric(df[close_col],      errors="coerce"),
        "volume":        pd.to_numeric(df[vol_col],        errors="coerce") if vol_col else 0.0,
    }
    clean = pd.DataFrame(rows).dropna(subset=["timestamp_raw", "open", "high", "low", "close"])
    clean = clean.drop_duplicates("timestamp_raw").sort_values("timestamp_raw")

    # Normalize any local dataset to the same Unix-ms contract used by live Bybit candles.
    # Seconds-based inputs are 10-digit (~1.3e9), millisecond-based inputs are 13-digit (~1.3e12).
    clean["timestamp"] = clean["timestamp_raw"].apply(
        lambda v: int(v * 1000) if abs(v) < 1e11 else int(v)
    )
    clean = clean[["timestamp", "open", "high", "low", "close", "volume"]].reset_index(drop=True)
    print(f"  Clean rows: {len(clean):,}")

# ── OHLCV resampler ───────────────────────────────────────────────────────
def resample(df_ms: pd.DataFrame, rule: str, label: str = "left") -> pd.DataFrame:
    """Resample a millisecond-timestamped OHLCV frame to a pandas freq rule."""
    idx = pd.to_datetime(df_ms["timestamp"], unit="ms", utc=True)
    df2 = df_ms.set_index(idx)
    ohlcv = df2[["open", "high", "low", "close", "volume"]].resample(rule, label=label).agg({
        "open":   "first",
        "high":   "max",
        "low":    "min",
        "close":  "last",
        "volume": "sum",
    }).dropna(subset=["open", "close"])
    # Preserve the millisecond epoch exactly. `astype("int64")` on a datetime64[ms, UTC]
    # index already yields the correct Unix-ms value; dividing by 1_000_000 corrupts it.
    ohlcv["timestamp"] = ohlcv.index.astype("int64")
    return ohlcv[["timestamp", "open", "high", "low", "close", "volume"]].reset_index(drop=True)

# ── Write files ───────────────────────────────────────────────────────────
configs = [
    ("btc_1m.csv",  None,   clean),          # raw 1-min, no resample
    ("btc_5m.csv",  "5min", None),
    ("btc_1h.csv",  "1h",   None),
    ("btc_1d.csv",  "1D",   None),
    ("btc_1w.csv",  "1W",   None),
]

for fname, rule, frame in configs:
    df_out = frame if frame is not None else resample(clean, rule)
    path = OUT_DIR / fname
    df_out.to_csv(path, index=False)
    size_kb = path.stat().st_size // 1024
    print(f"  Written {path.relative_to(REPO_ROOT)}  ({len(df_out):,} rows, {size_kb:,} KB)")

print("\nDone. Files are in public/data/ — open the chart and click '↑ Load data'.")
