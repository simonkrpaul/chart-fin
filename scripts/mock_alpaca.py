#!/usr/bin/env python3
"""
mock_alpaca.py
────────────────────────────────────────────────────────────────────────────
Generate synthetic 1-minute OHLCV bars in the exact schema produced by
scripts/download_alpaca.py, so chart-fin can load them offline while your
network can't reach Alpaca.

What it writes
──────────────
  public/data/markets/us_equity/<SYMBOL>_1m.csv       – OHLCV bars
  public/data/markets/us_equity/<SYMBOL>.meta.json    – symbol metadata
  public/data/markets/manifest.json                   – rebuilt index

CSV columns:      timestamp,open,high,low,close,volume,symbol
timestamp:        Unix milliseconds UTC
Session:          Mon–Fri 09:30–16:00 America/New_York (NYSE regular hours)
                  ~390 bars/day × 21 trading days ≈ 8 200 rows / month.

Usage
─────
  # Default: MOCKAPL, ends today, 30 calendar days back
  python scripts/mock_alpaca.py

  # Custom symbol, start price, days
  python scripts/mock_alpaca.py --symbol MOCKMSFT --start-price 420 --days 30

  # End on a fixed date
  python scripts/mock_alpaca.py --end 2024-12-31

  # Only rebuild the manifest (after manually editing files)
  python scripts/mock_alpaca.py --rebuild-manifest-only

Load into chart-fin
───────────────────
  1. Restart / hard-refresh the dev server:
         pnpm dev       (or your usual command)
  2. In the browser, hard-reload (Cmd-Shift-R). The ingester reads
     `manifest.json`, finds the new series, and imports it into IndexedDB.
  3. Open the Chart Picker (top-left symbol dropdown) → Market: **US Equity**
     → pick your mock symbol → Timeframe: **1m**.

If the symbol doesn't show up:
  – Confirm public/data/markets/manifest.json contains an entry for it.
  – Open DevTools → Application → IndexedDB → delete `chart-fin-db` and reload
    (the ingester dedupes; a stale entry can hide new files if you renamed).
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import random
import sys
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:
    print("Python 3.9+ required (zoneinfo).", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKETS_DIR = REPO_ROOT / "public" / "data" / "markets"
US_EQUITY_DIR = MARKETS_DIR / "us_equity"
MANIFEST_PATH = MARKETS_DIR / "manifest.json"

NY_TZ = ZoneInfo("America/New_York")
SESSION_OPEN_MIN  = 9 * 60 + 30    # 09:30 local
SESSION_CLOSE_MIN = 16 * 60        # 16:00 local


def _in_session(dt_local: datetime) -> bool:
    """True if `dt_local` (America/New_York) is inside NYSE regular hours."""
    if dt_local.weekday() >= 5:  # Sat / Sun
        return False
    minute_of_day = dt_local.hour * 60 + dt_local.minute
    return SESSION_OPEN_MIN <= minute_of_day < SESSION_CLOSE_MIN


def _generate_bars(symbol: str, start_price: float, start: datetime, end: datetime, seed: int) -> list[dict]:
    """Random-walk 1-minute OHLCV bars from `start` to `end` (both UTC-aware)."""
    rng = random.Random(seed)
    price = float(start_price)
    rows: list[dict] = []

    # Walk through every UTC minute; keep the ones inside NY regular hours.
    minute = start.replace(second=0, microsecond=0)
    step = timedelta(minutes=1)
    intraday_bar = 0

    while minute < end:
        local = minute.astimezone(NY_TZ)
        if _in_session(local):
            # New trading day → tiny gap open
            if intraday_bar == 0:
                price *= 1 + rng.gauss(0, 0.001)  # ~0.1% overnight drift
            intraday_bar += 1

            # Per-minute return: mean 0, std ~0.05%
            r = rng.gauss(0, 0.0005)
            close = price * (1 + r)
            # Intra-bar range from a lognormal wick
            wick = abs(rng.gauss(0, 0.0004)) * price
            o = price
            c = close
            h = max(o, c) + wick * rng.random()
            l = min(o, c) - wick * rng.random()
            # Volume: log-normal-ish, higher near open/close
            base_vol = 800 + 4000 * math.exp(-((intraday_bar - 195) ** 2) / 12000)
            vol = base_vol * (1 + rng.random() * 1.2)

            ts_ms = int(minute.timestamp() * 1000)
            rows.append({
                "timestamp": ts_ms,
                "open":  round(o, 4),
                "high":  round(h, 4),
                "low":   round(l, 4),
                "close": round(c, 4),
                "volume": round(vol, 2),
                "symbol": symbol,
            })
            price = c

            # Reset intraday counter at close
            if local.hour == 15 and local.minute >= 59:
                intraday_bar = 0
        else:
            intraday_bar = 0
        minute += step

    return rows


def _write_csv(path: pathlib.Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        f.write("timestamp,open,high,low,close,volume,symbol\n")
        for r in rows:
            f.write(f'{r["timestamp"]},{r["open"]},{r["high"]},{r["low"]},'
                    f'{r["close"]},{r["volume"]},{r["symbol"]}\n')


def _write_meta(path: pathlib.Path, symbol: str, row_count: int) -> None:
    meta = {
        "exchange": "US Equity",
        "description": f"{symbol} (mock)",
        "sector": "Mock",
        "industry": "Synthetic Data",
        "headquarters": "n/a",
        "founded": "n/a",
        "row_count": row_count,
    }
    path.write_text(json.dumps(meta, indent=2))


def rebuild_manifest() -> None:
    """Rescan public/data/markets/**/*.csv and rewrite manifest.json."""
    sources: list[dict] = []
    if MARKETS_DIR.exists():
        for csv in sorted(MARKETS_DIR.rglob("*.csv")):
            rel = csv.relative_to(REPO_ROOT / "public").as_posix()
            parts = csv.stem.split("_")
            if len(parts) < 2:
                continue
            timeframe = parts[-1]
            symbol = "_".join(parts[:-1])
            market = csv.parent.name
            sources.append({
                "market": market,
                "symbol": symbol,
                "timeframe": timeframe,
                "url": "/" + rel,
            })
    MARKETS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps({
        "version": 1,
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "sources": sources,
    }, indent=2))
    print(f"  → manifest.json rewritten with {len(sources)} series")


def main() -> int:
    p = argparse.ArgumentParser(
        description="Generate 1-minute Alpaca-style mock OHLCV bars.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--symbol", default="MOCKAPL", help="Ticker symbol to write.")
    p.add_argument("--start-price", type=float, default=180.0, help="Starting price.")
    p.add_argument("--days", type=int, default=30, help="Number of calendar days of history.")
    p.add_argument("--end", default=None, help="End date YYYY-MM-DD (default: today UTC).")
    p.add_argument("--seed", type=int, default=42, help="RNG seed for reproducibility.")
    p.add_argument("--rebuild-manifest-only", action="store_true",
                   help="Skip generation and just rebuild manifest.json.")
    args = p.parse_args()

    if args.rebuild_manifest_only:
        rebuild_manifest()
        return 0

    symbol = args.symbol.upper()
    end = (datetime.fromisoformat(args.end).replace(tzinfo=timezone.utc)
           if args.end else datetime.now(tz=timezone.utc)).replace(second=0, microsecond=0)
    start = end - timedelta(days=args.days)

    print(f"Symbol       : {symbol}")
    print(f"Range        : {start.isoformat()} → {end.isoformat()}  ({args.days} days)")
    print(f"Session      : Mon–Fri 09:30–16:00 America/New_York")
    print(f"Start price  : {args.start_price}")
    print()

    rows = _generate_bars(symbol, args.start_price, start, end, args.seed)
    csv_path  = US_EQUITY_DIR / f"{symbol}_1m.csv"
    meta_path = US_EQUITY_DIR / f"{symbol}.meta.json"
    _write_csv(csv_path, rows)
    _write_meta(meta_path, symbol, len(rows))
    print(f"  ✓ {csv_path.relative_to(REPO_ROOT)}   ({len(rows):,} rows)")
    print(f"  ✓ {meta_path.relative_to(REPO_ROOT)}")

    rebuild_manifest()
    print("\nDone. Restart your dev server and hard-reload the browser (Cmd-Shift-R).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
