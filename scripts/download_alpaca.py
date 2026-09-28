#!/usr/bin/env python3
"""
download_alpaca.py
────────────────────────────────────────────────────────────────────────────
Bulk-download historical OHLCV bars from Alpaca Market Data and write them
into the chart-fin multi-market layout the browser auto-ingests.

Uses Alpaca's official Python SDK (`alpaca-py`), which is the recommended
path documented at
    https://docs.alpaca.markets/us/docs/getting-started-with-alpaca-market-data

Two asset classes are supported:

  --asset stock  (default)   US equities         requires API key + secret
  --asset crypto             Crypto pairs        no keys required

Outputs
───────
  Stocks : public/data/markets/us_equity/<SYMBOL>_<timeframe>.csv
  Crypto : public/data/markets/crypto/<SYMBOL>_<timeframe>.csv    (BTC/USD → BTCUSD)
  Manifest: public/data/markets/manifest.json                      (rebuilt at end)

Install
───────
  pip install alpaca-py

Usage
─────
  # ── STOCKS ────────────────────────────────────────────────────────────
  # Alpaca dashboard → API Keys → Generate New Keys, then export:
  export APCA_API_KEY_ID=PKxxxxxxxxxxxxxxxx           # "API Key ID"
  export APCA_API_SECRET_KEY=xxxxxxxxxxxxxxxxxxxx     # "Secret Key"

  # Sanity check (3 tickers, 1 year daily)
  python scripts/download_alpaca.py --asset stock \\
      --symbols AAPL,MSFT,NVDA --timeframe 1d --years 1

  # Top 50 most-traded US stocks, 1-minute bars, 2 years back
  python scripts/download_alpaca.py --asset stock \\
      --universe top50 --timeframe 1m --years 2 --resume

  # Whole S&P 500, daily bars, 5 years back
  python scripts/download_alpaca.py --asset stock \\
      --universe sp500 --timeframe 1d --years 5

  # Resume a partial run
  python scripts/download_alpaca.py --asset stock \\
      --universe sp500 --timeframe 1h --resume

  # ── CRYPTO (no keys) ──────────────────────────────────────────────────
  python scripts/download_alpaca.py --asset crypto \\
      --symbols BTC/USD,ETH/USD --timeframe 1d --years 3

  # ── Manifest only ─────────────────────────────────────────────────────
  python scripts/download_alpaca.py --rebuild-manifest-only

Timeframes
──────────
  1m  → TimeFrame(1, Minute)    5m  → (5, Minute)   15m → (15, Minute)
  1h  → TimeFrame.Hour          4h  → (4, Hour)
  1d  → TimeFrame.Day           1w  → TimeFrame.Week
  1M  → TimeFrame.Month
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from typing import Iterable

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKETS_DIR = REPO_ROOT / "public" / "data" / "markets"
US_EQUITY_DIR = MARKETS_DIR / "us_equity"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _manifest import (  # noqa: E402
    rebuild_manifest as _shared_rebuild_manifest,
    tf_to_filename_suffix as _tf_to_filename_suffix,
)
CRYPTO_DIR    = MARKETS_DIR / "crypto"

SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"

# Symbols the SDK accepts per request (both stocks and crypto pass a list).
# We batch to keep memory sane on the DataFrame return.
BATCH_SIZE = 100
# Free stock tier is 200 req/min → sleep a small amount between batches.
BATCH_SLEEP_S = 0.5


# ── SDK import (lazy, so --rebuild-manifest-only still works without pip) ──

def _import_sdk():
    try:
        from alpaca.data.historical import StockHistoricalDataClient, CryptoHistoricalDataClient
        from alpaca.data.requests import StockBarsRequest, CryptoBarsRequest
        from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
        return {
            "StockHistoricalDataClient": StockHistoricalDataClient,
            "CryptoHistoricalDataClient": CryptoHistoricalDataClient,
            "StockBarsRequest": StockBarsRequest,
            "CryptoBarsRequest": CryptoBarsRequest,
            "TimeFrame": TimeFrame,
            "TimeFrameUnit": TimeFrameUnit,
        }
    except ImportError as e:
        raise SystemExit(
            "Alpaca SDK not installed. Install it with:\n"
            "    pip install alpaca-py\n"
            f"(original error: {e})"
        )


# ── Timeframe translation ──────────────────────────────────────────────────

def make_timeframe(tf: str, sdk):
    TimeFrame = sdk["TimeFrame"]
    TimeFrameUnit = sdk["TimeFrameUnit"]
    table = {
        "1m":  TimeFrame(1, TimeFrameUnit.Minute),
        "5m":  TimeFrame(5, TimeFrameUnit.Minute),
        "15m": TimeFrame(15, TimeFrameUnit.Minute),
        "1h":  TimeFrame(1, TimeFrameUnit.Hour),
        "4h":  TimeFrame(4, TimeFrameUnit.Hour),
        "1d":  TimeFrame(1, TimeFrameUnit.Day),
        "1w":  TimeFrame(1, TimeFrameUnit.Week),
        "1M":  TimeFrame(1, TimeFrameUnit.Month),
    }
    if tf not in table:
        raise ValueError(f"Unsupported timeframe: {tf}. Choose from {list(table.keys())}")
    return table[tf]

VALID_TFS = {"1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"}


# ── S&P 500 constituent list (stocks only) ─────────────────────────────────

# ── Preset universes (stocks only) ─────────────────────────────────────────

# Top 50 US equities by typical daily dollar volume — a curated blend of the
# high-liquidity mega-caps plus a few actively-traded mid-caps. Stable enough
# to hardcode; refresh periodically.
TOP50_US = [
    # Mega-cap tech (11)
    "NVDA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "GOOG", "TSLA", "AVGO", "AMD", "NFLX",
    # Semis / hardware (5)
    "TSM", "INTC", "QCOM", "MU", "ORCL",
    # Financials (8)
    "JPM", "BAC", "WFC", "V", "MA", "GS", "MS", "SCHW",
    # Healthcare / pharma (7)
    "LLY", "UNH", "JNJ", "PFE", "ABBV", "MRK", "TMO",
    # Consumer (7)
    "WMT", "COST", "HD", "MCD", "KO", "PEP", "NKE",
    # Energy (3)
    "XOM", "CVX", "COP",
    # Communication / media (3)
    "DIS", "CMCSA", "T",
    # ETFs (frequently traded, useful proxies) (6)
    "SPY", "QQQ", "IWM", "DIA", "VOO", "VTI",
]

_FALLBACK_SP500 = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "AVGO", "BRK.B",
    "JPM", "V", "UNH", "XOM", "MA", "PG", "COST", "HD", "JNJ", "WMT",
    "ABBV", "CVX", "MRK", "LLY", "PEP", "KO", "BAC", "TMO", "ADBE", "PFE",
    "CRM", "MCD", "NFLX", "ORCL", "CSCO", "ACN", "ABT", "NKE", "DHR", "TXN",
]

def fetch_sp500_symbols() -> list[str]:
    try:
        req = urllib.request.Request(SP500_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"[warn] Wikipedia unreachable: {e} — using fallback list", file=sys.stderr)
        return _FALLBACK_SP500

    m = re.search(r'<table class="wikitable[^"]*"[^>]*>(.*?)</table>', html, re.S)
    if not m:
        return _FALLBACK_SP500

    symbols: list[str] = []
    for row_m in re.finditer(r"<tr>(.*?)</tr>", m.group(1), re.S):
        cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row_m.group(1), re.S)
        if not cells:
            continue
        first = re.sub(r"<[^>]+>", "", cells[0]).strip()
        if first.lower() in ("symbol", "ticker"):
            continue
        if not first or len(first) > 6:
            continue
        symbols.append(first)
    return symbols or _FALLBACK_SP500


# ── DataFrame → CSV in our schema ──────────────────────────────────────────

def _safe_filename(symbol: str) -> str:
    """
    Convert 'BTC/USD' → 'BTCUSD' for filename use. Stocks pass through.
    """
    return symbol.replace("/", "").replace("-", "").upper()


def write_symbol_csv(dst_dir: pathlib.Path, symbol: str, timeframe: str, df) -> pathlib.Path:
    """
    df is Alpaca's returned DataFrame. Its index is a (symbol, timestamp)
    MultiIndex; each symbol's slice contains open/high/low/close/volume.
    """
    dst_dir.mkdir(parents=True, exist_ok=True)
    file_symbol = _safe_filename(symbol)
    dst = dst_dir / f"{file_symbol}_{_tf_to_filename_suffix(timeframe)}.csv"

    # Slice the DF for this symbol only.
    if symbol in df.index.get_level_values(0):
        sub = df.xs(symbol, level=0)
    else:
        # Symbol may be missing from the multi-symbol response entirely.
        return dst

    # Convert to CSV in our canonical schema:
    # timestamp,open,high,low,close,volume,symbol
    with dst.open("w", newline="") as f:
        f.write("timestamp,open,high,low,close,volume,symbol\n")
        for ts, row in sub.iterrows():
            unix_ms = int(ts.timestamp() * 1000)
            f.write(
                f"{unix_ms},{row['open']},{row['high']},{row['low']},"
                f"{row['close']},{row['volume']},{file_symbol}\n"
            )
    return dst


# ── Manifest rebuild ───────────────────────────────────────────────────────

def rebuild_manifest() -> None:
    _shared_rebuild_manifest(MARKETS_DIR, repo_root=REPO_ROOT)


# ── Main fetch loop ────────────────────────────────────────────────────────

def batched(seq: list[str], n: int) -> Iterable[list[str]]:
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def run_stocks(args, sdk) -> None:
    key = args.key_id
    secret = args.secret_key
    if not key or not secret:
        raise SystemExit(
            "Missing Alpaca stock credentials.\n"
            "From https://app.alpaca.markets/brokerage/dashboard/overview → API Keys → Generate New Keys, then:\n"
            "    export APCA_API_KEY_ID=PKxxxxxxxxxxxxxxxx        # \"API Key ID\"\n"
            "    export APCA_API_SECRET_KEY=xxxxxxxxxxxxxxxxxxxx  # \"Secret Key\"\n"
            "or pass --key-id and --secret-key on the command line."
        )

    client = sdk["StockHistoricalDataClient"](key, secret)

    if args.universe == "sp500":
        symbols = fetch_sp500_symbols()
    elif args.universe == "top50":
        symbols = list(TOP50_US)
    elif args.symbols:
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    else:
        raise SystemExit("Provide --symbols or --universe sp500 for stocks.")

    if args.resume:
        symbols = [s for s in symbols
                   if not (US_EQUITY_DIR / f"{_safe_filename(s)}_{args.timeframe}.csv").exists()]

    end_dt, start_dt = _resolve_window(args)
    tf = make_timeframe(args.timeframe, sdk)
    print(f"[plan] stock · {len(symbols)} symbols · {args.timeframe} · "
          f"{start_dt.date()} → {end_dt.date()} · feed={args.feed}")
    if not symbols:
        print("[plan] nothing to fetch")
        rebuild_manifest(); return

    written = 0
    total_bars = 0
    for batch in batched(symbols, BATCH_SIZE):
        t0 = time.time()
        req = sdk["StockBarsRequest"](
            symbol_or_symbols=batch,
            timeframe=tf,
            start=start_dt,
            end=end_dt,
            feed=args.feed,
            adjustment=args.adjustment,
        )
        try:
            bars = client.get_stock_bars(req)
            df = bars.df
        except Exception as e:
            print(f"[error] batch {batch[0]}…{batch[-1]} failed: {e}", file=sys.stderr)
            continue

        if df is None or df.empty:
            print(f"[skip] batch {batch[0]}…{batch[-1]} returned no bars")
            continue

        for sym in batch:
            if sym not in df.index.get_level_values(0):
                print(f"[skip] {sym}: no bars")
                continue
            n = len(df.xs(sym, level=0))
            dst = write_symbol_csv(US_EQUITY_DIR, sym, args.timeframe, df)
            written += 1
            total_bars += n
            print(f"[ok] {sym:<6} {n:>7} bars → {dst.relative_to(REPO_ROOT)}")

        dt = time.time() - t0
        print(f"[batch] {len(batch)} symbols in {dt:.1f}s")
        time.sleep(BATCH_SLEEP_S)

    print(f"[done] {written} symbols · {total_bars:,} bars total")
    rebuild_manifest()


def run_crypto(args, sdk) -> None:
    # Alpaca crypto endpoint requires no API keys.
    client = sdk["CryptoHistoricalDataClient"]()

    if args.symbols:
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    else:
        raise SystemExit("Provide --symbols for crypto (e.g. BTC/USD,ETH/USD).")

    if args.resume:
        symbols = [s for s in symbols
                   if not (CRYPTO_DIR / f"{_safe_filename(s)}_{args.timeframe}.csv").exists()]

    end_dt, start_dt = _resolve_window(args)
    tf = make_timeframe(args.timeframe, sdk)
    print(f"[plan] crypto · {len(symbols)} symbols · {args.timeframe} · "
          f"{start_dt.date()} → {end_dt.date()}")
    if not symbols:
        print("[plan] nothing to fetch")
        rebuild_manifest(); return

    written = 0
    total_bars = 0
    for batch in batched(symbols, BATCH_SIZE):
        t0 = time.time()
        req = sdk["CryptoBarsRequest"](
            symbol_or_symbols=batch,
            timeframe=tf,
            start=start_dt,
            end=end_dt,
        )
        try:
            bars = client.get_crypto_bars(req)
            df = bars.df
        except Exception as e:
            print(f"[error] batch {batch[0]}…{batch[-1]} failed: {e}", file=sys.stderr)
            continue

        if df is None or df.empty:
            print(f"[skip] batch {batch[0]}…{batch[-1]} returned no bars")
            continue

        for sym in batch:
            if sym not in df.index.get_level_values(0):
                print(f"[skip] {sym}: no bars")
                continue
            n = len(df.xs(sym, level=0))
            dst = write_symbol_csv(CRYPTO_DIR, sym, args.timeframe, df)
            written += 1
            total_bars += n
            print(f"[ok] {sym:<10} {n:>7} bars → {dst.relative_to(REPO_ROOT)}")

        dt = time.time() - t0
        print(f"[batch] {len(batch)} symbols in {dt:.1f}s")
        time.sleep(BATCH_SLEEP_S)

    print(f"[done] {written} symbols · {total_bars:,} bars total")
    rebuild_manifest()


def _resolve_window(args) -> tuple[datetime, datetime]:
    end_dt = (datetime.fromisoformat(args.end) if args.end
              else datetime.now(timezone.utc))
    if end_dt.tzinfo is None:
        end_dt = end_dt.replace(tzinfo=timezone.utc)
    start_dt = (datetime.fromisoformat(args.start).replace(tzinfo=timezone.utc)
                if args.start else end_dt - timedelta(days=int(365 * args.years)))
    return end_dt, start_dt


# ── CLI ────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--asset", choices=["stock", "crypto"], default="stock",
                   help="Asset class. Crypto needs no keys.")
    p.add_argument("--symbols", type=str,
                   help='Comma-separated list. Stocks: "AAPL,MSFT". Crypto: "BTC/USD,ETH/USD"')
    p.add_argument("--universe", choices=["sp500", "top50"],
                   help="Preset symbol list (stocks only). 'top50' = curated top-50 by dollar volume.")
    p.add_argument("--timeframe", type=str, default="1d",
                   choices=sorted(VALID_TFS))
    p.add_argument("--years", type=int, default=5,
                   help="Look-back window in years (default 5)")
    p.add_argument("--start", type=str, help="ISO date, overrides --years")
    p.add_argument("--end",   type=str, help="ISO date, defaults to now")
    p.add_argument("--feed",  type=str, default="iex", choices=["iex", "sip"],
                   help="Stock feed (default iex — free, 15-min delayed)")
    p.add_argument("--adjustment", type=str, default="raw",
                   choices=["raw", "split", "dividend", "all"],
                   help="Stock price adjustment (default raw)")
    p.add_argument("--resume", action="store_true",
                   help="Skip symbols whose CSV already exists on disk")
    p.add_argument("--key-id",
                   default=os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY_ID"),
                   help='API Key ID (env $APCA_API_KEY_ID). Not needed for crypto.')
    p.add_argument("--secret-key",
                   default=os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_API_SECRET_KEY"),
                   help='Secret Key (env $APCA_API_SECRET_KEY). Not needed for crypto.')
    p.add_argument("--rebuild-manifest-only", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    if args.rebuild_manifest_only:
        rebuild_manifest()
        return

    sdk = _import_sdk()

    if args.asset == "stock":
        run_stocks(args, sdk)
    elif args.asset == "crypto":
        run_crypto(args, sdk)


if __name__ == "__main__":
    main()
