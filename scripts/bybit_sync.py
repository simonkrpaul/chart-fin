#!/usr/bin/env python3
"""
bybit_sync.py
─────────────────────────────────────────────────────────────────────────────
Syncs BTCUSDT (or any Bybit pair) directly into the manifest-aware market
layout that the frontend auto-ingests on cold boot:

    public/data/markets/crypto/<SYMBOL>_1m.csv
    public/data/markets/crypto/<SYMBOL>_5m.csv
    …
    public/data/markets/manifest.json    (regenerated after write)

Because the manifest lists every CSV in `markets/`, the app streams the new
symbols straight into IndexedDB on the next reload — no UI ingestion step
needed. Idempotent: re-runs only fetch the gap since the last stored bar.

Features
────────
  • Up to 5 years of 1-minute history via Bybit v5 REST API
  • Incremental sync: only pulls new candles on repeat runs
  • Resamples to 5m / 1h / 1d / 1w in one pass
  • Rebuilds `manifest.json` so the app picks up the new series on boot
  • `--legacy` flag preserves the old flat `public/data/bybit_*.csv` layout

Usage
─────
  # Full historical sync (first run, ~20-40 min for 5 years)
  python scripts/bybit_sync.py

  # After being offline for a week — only fetches the gap
  python scripts/bybit_sync.py

  # Custom pair or history depth
  python scripts/bybit_sync.py --symbol ETHUSDT --years 2

  # Legacy flat layout (public/data/bybit_btcusdt_1m.csv, no manifest update)
  python scripts/bybit_sync.py --legacy
"""

import argparse
import pathlib
import sys
import time

try:
    import pandas as pd
except ImportError:
    sys.exit("pandas is required: pip install pandas")

try:
    import requests
except ImportError:
    sys.exit("requests is required: pip install requests")

from _manifest import rebuild_manifest

# ── CLI ────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Sync a Bybit pair into the manifest layout")
parser.add_argument("--symbol", default="BTCUSDT", help="Trading pair (default: BTCUSDT)")
parser.add_argument("--years", type=float, default=5.0, help="Years of history to fetch (default: 5)")
parser.add_argument("--category", default="linear", help="Bybit category: linear | inverse | spot (default: linear)")
parser.add_argument("--market", default="crypto", help="Market bucket under public/data/markets/ (default: crypto)")
parser.add_argument("--out-dir", default=None, help="Override output directory (advanced)")
parser.add_argument("--legacy", action="store_true", help="Write to the old flat public/data/ layout instead of markets/")
parser.add_argument("--no-manifest", action="store_true", help="Skip the manifest rebuild step at the end")
args = parser.parse_args()

# ── Paths ─────────────────────────────────────────────────────────────────

REPO_ROOT   = pathlib.Path(__file__).resolve().parent.parent
MARKETS_DIR = REPO_ROOT / "public" / "data" / "markets"

SYMBOL = args.symbol.upper()
if args.out_dir:
    OUT_DIR = pathlib.Path(args.out_dir)
    PREFIX  = SYMBOL.lower()
    NAME_1M, NAME_5M, NAME_1H, NAME_1D, NAME_1W = (
        f"{PREFIX}_1m.csv", f"{PREFIX}_5m.csv", f"{PREFIX}_1h.csv",
        f"{PREFIX}_1d.csv", f"{PREFIX}_1w.csv",
    )
elif args.legacy:
    OUT_DIR = REPO_ROOT / "public" / "data"
    PREFIX  = SYMBOL.lower()
    NAME_1M, NAME_5M, NAME_1H, NAME_1D, NAME_1W = (
        f"bybit_{PREFIX}_1m.csv", f"bybit_{PREFIX}_5m.csv",
        f"bybit_{PREFIX}_1h.csv", f"bybit_{PREFIX}_1d.csv",
        f"bybit_{PREFIX}_1w.csv",
    )
else:
    OUT_DIR = MARKETS_DIR / args.market
    NAME_1M, NAME_5M, NAME_1H, NAME_1D, NAME_1W = (
        f"{SYMBOL}_1m.csv", f"{SYMBOL}_5m.csv", f"{SYMBOL}_1h.csv",
        f"{SYMBOL}_1d.csv", f"{SYMBOL}_1w.csv",
    )

OUT_DIR.mkdir(parents=True, exist_ok=True)
FILE_1M = OUT_DIR / NAME_1M
FILE_5M = OUT_DIR / NAME_5M
FILE_1H = OUT_DIR / NAME_1H
FILE_1D = OUT_DIR / NAME_1D
FILE_1W = OUT_DIR / NAME_1W

# Canonical column order for the manifest-aware layout (matches the Kaggle
# and Alpaca importers). The optional `symbol` column keeps per-row identity
# so the frontend picker can label bars even when the CSV path isn't known.
INCLUDE_SYMBOL_COL = not args.legacy

# ── Bybit REST API ────────────────────────────────────────────────────────

BYBIT_KLINE_URL = "https://api.bybit.com/v5/market/kline"
LIMIT = 1000          # max per request
ONE_MIN_MS = 60_000
RATE_LIMIT_SLEEP = 0.12  # ~8 requests/sec to stay well under Bybit limits


def fetch_bybit_klines(symbol: str, interval: str, start_ms: int, end_ms: int, category: str = "linear") -> pd.DataFrame:
    """
    Paginate through Bybit v5 kline endpoint.
    Bybit returns newest-first, so we paginate backwards from end_ms.
    """
    all_rows: list[dict] = []
    cursor_end = end_ms
    request_count = 0
    last_progress = -1

    total_span = end_ms - start_ms
    print(f"Fetching {symbol} {interval} from Bybit ({category}) …")
    print(f"  Range: {pd.Timestamp(start_ms, unit='ms', tz='UTC')} → {pd.Timestamp(end_ms, unit='ms', tz='UTC')}")

    while cursor_end > start_ms:
        params = {
            "category": category,
            "symbol": symbol,
            "interval": interval,
            "limit": LIMIT,
            "end": cursor_end,
            "start": start_ms,
        }

        try:
            resp = requests.get(BYBIT_KLINE_URL, params=params, timeout=30)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"\n  ⚠ Request error: {e}. Retrying in 5s …")
            time.sleep(5)
            continue

        data = resp.json()
        result_list = data.get("result", {}).get("list", [])

        if not result_list:
            break

        for row in result_list:
            # Bybit v5 kline fields: [startTime, open, high, low, close, volume, turnover]
            ts = int(row[0])
            if ts < start_ms:
                continue
            all_rows.append({
                "timestamp": ts,
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
                "volume": float(row[5]),
            })

        # Bybit returns newest first — the last element has the oldest timestamp
        oldest_in_batch = int(result_list[-1][0])
        # Move cursor to before the oldest bar we just received
        cursor_end = oldest_in_batch - 1

        request_count += 1
        # Progress reporting
        fetched_span = end_ms - cursor_end
        pct = min(100, int(fetched_span * 100 / total_span)) if total_span > 0 else 100
        if pct != last_progress:
            last_progress = pct
            print(f"\r  Progress: {pct}% ({len(all_rows):,} bars, {request_count} requests)", end="", flush=True)

        if len(result_list) < LIMIT:
            break

        time.sleep(RATE_LIMIT_SLEEP)

    print(f"\n  Total: {len(all_rows):,} bars in {request_count} requests")

    if not all_rows:
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])

    df = pd.DataFrame(all_rows)
    df = df.drop_duplicates("timestamp").sort_values("timestamp").reset_index(drop=True)
    return df


def load_existing(filepath: pathlib.Path) -> pd.DataFrame:
    """Load existing CSV if present."""
    if not filepath.exists():
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
    try:
        df = pd.read_csv(filepath)
        df["timestamp"] = df["timestamp"].astype(int)
        return df.sort_values("timestamp").reset_index(drop=True)
    except Exception as e:
        print(f"  ⚠ Could not read {filepath}: {e}. Starting fresh.")
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])


def resample(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    """Resample 1m DataFrame to a coarser timeframe."""
    dfc = df.copy()
    dfc["dt"] = pd.to_datetime(dfc["timestamp"], unit="ms", utc=True)
    dfc = dfc.set_index("dt")
    ohlcv = dfc.resample(rule, label="left", closed="left").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna(subset=["open"])
    # Preserve the true millisecond epoch from the resampled datetime index.
    # Dividing by 10**6 collapses the 13-digit Unix ms value into a 7-digit
    # seconds-like value and breaks the frontend timestamp contract.
    ohlcv["timestamp"] = ohlcv.index.astype("int64")
    return ohlcv[["timestamp", "open", "high", "low", "close", "volume"]].reset_index(drop=True)


def save_csv(df: pd.DataFrame, path: pathlib.Path) -> None:
    if INCLUDE_SYMBOL_COL:
        # Manifest layout carries the `symbol` column so per-row identity
        # survives concat / regrouping in the frontend picker.
        df = df.assign(symbol=SYMBOL)
    df.to_csv(path, index=False)
    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"  Wrote {path.name}: {len(df):,} rows ({size_mb:.1f} MB)")


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    now_ms = int(time.time() * 1000)
    years_ms = int(args.years * 365.25 * 24 * 60 * 60 * 1000)
    earliest_ms = now_ms - years_ms

    # Load existing data for incremental sync
    existing = load_existing(FILE_1M)

    if existing.empty:
        print(f"No existing data found. Full sync from {args.years} years ago.")
        start_ms = earliest_ms
    else:
        last_ts = int(existing["timestamp"].max())
        gap_hours = (now_ms - last_ts) / (3600 * 1000)
        print(f"Existing data: {len(existing):,} bars, last at {pd.Timestamp(last_ts, unit='ms', tz='UTC')}")
        print(f"Gap to fill: {gap_hours:.1f} hours")
        # Start from the last known candle (will deduplicate)
        start_ms = last_ts

    # Fetch new data
    new_data = fetch_bybit_klines(
        symbol=SYMBOL,
        interval="1",  # 1 minute
        start_ms=start_ms,
        end_ms=now_ms,
        category=args.category,
    )

    if new_data.empty and existing.empty:
        sys.exit("No data fetched from Bybit. Check your network connection.")

    # Merge with existing
    if not existing.empty and not new_data.empty:
        merged = pd.concat([existing, new_data], ignore_index=True)
        merged = merged.drop_duplicates("timestamp").sort_values("timestamp").reset_index(drop=True)
        print(f"Merged: {len(existing):,} existing + {len(new_data):,} new → {len(merged):,} total")
    elif not new_data.empty:
        merged = new_data
    else:
        merged = existing

    # Trim to max history window
    merged = merged[merged["timestamp"] >= earliest_ms].reset_index(drop=True)

    # Save all timeframes
    print("\nWriting output files …")
    save_csv(merged, FILE_1M)
    save_csv(resample(merged, "5min"), FILE_5M)
    save_csv(resample(merged, "1h"), FILE_1H)
    save_csv(resample(merged, "1D"), FILE_1D)
    save_csv(resample(merged, "1W"), FILE_1W)

    # Summary
    first_date = pd.Timestamp(int(merged["timestamp"].min()), unit="ms", tz="UTC")
    last_date = pd.Timestamp(int(merged["timestamp"].max()), unit="ms", tz="UTC")
    print(f"\n✓ Sync complete: {first_date.date()} → {last_date.date()}")
    print(f"  {len(merged):,} 1-minute candles")

    # Rebuild manifest so the frontend auto-ingests the new / updated CSVs
    # on the next cold boot. Skip when writing to a custom out-dir or the
    # legacy flat layout — those files aren't under markets/.
    if not args.legacy and not args.out_dir and not args.no_manifest:
        print()
        rebuild_manifest(MARKETS_DIR, repo_root=REPO_ROOT)
        print("  → reload the app in the browser to pick up the new bars")
    elif args.legacy:
        print("\n[legacy] flat layout written; use the UI 'Load data' button to ingest.")


if __name__ == "__main__":
    main()
