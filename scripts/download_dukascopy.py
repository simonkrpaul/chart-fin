#!/usr/bin/env python3
"""
download_dukascopy.py
─────────────────────────────────────────────────────────────────────────────
Downloads historical forex / CFD data from Dukascopy Bank's free datafeed
and writes chart-fin-compatible CSVs into public/data/.

Default target is XAUUSD (Gold vs. USD).

Sources
───────
  Dukascopy publishes tick data as hourly LZMA-compressed .bi5 files at
      https://datafeed.dukascopy.com/datafeed/{SYMBOL}/{YYYY}/{MM0}/{DD}/{HH}h_ticks.bi5
  where MM0 is a ZERO-INDEXED month (Jan = 00 ... Dec = 11).

  Native OHLC candles (BID or ASK, no MID) are available at:
      Minute :  {SYMBOL}/{YYYY}/{MM0}/{DD}/{HH}h_{PRICE}_candle.bi5   (M1 bars, 24 per file)
      Hour   :  {SYMBOL}/{YYYY}/{MM0}/{PRICE}_candle.bi5              (H1 bars, one file/month)
      Day    :  {SYMBOL}/{YYYY}/{PRICE}_candle.bi5                    (D1 bars, one file/year)

Usage
─────
  # 1-minute native candles for the full year 2024 (fast, recommended default):
  python scripts/download_dukascopy.py --symbol XAUUSD --start 2024-01-01 --end 2024-12-31 --tf m1

  # Full history since Dukascopy began publishing XAUUSD (2003-05-05):
  python scripts/download_dukascopy.py --symbol XAUUSD --start 2003-05-05 --end today --tf m1

  # Tick data → aggregate to 5m bars:
  python scripts/download_dukascopy.py --symbol XAUUSD --start 2024-01-01 --end 2024-01-31 --tf 5m

  # Multiple timeframes in one run (native where possible, tick-derived otherwise):
  python scripts/download_dukascopy.py --symbol XAUUSD --start 2024-01-01 --end today \
      --tf m1 --tf 5m --tf 1h --tf 1d --tf 1w

  # Resume an interrupted run — state kept in .dukascopy_state.json next to output file:
  python scripts/download_dukascopy.py --symbol XAUUSD --start 2003-05-05 --end today --tf m1 --resume

Output
──────
  Writes to the chart-fin manifest layout that the browser's Chart Picker
  reads on refresh:

      public/data/markets/<market>/<SYMBOL>_<tf>.csv       – OHLCV bars
      public/data/markets/<market>/<SYMBOL>.meta.json      – exchange / description
      public/data/markets/manifest.json                    – rebuilt at end

  Market bucket is auto-picked from --symbol:
      XAUUSD / XAGUSD             → metals
      EURUSD / GBPUSD / USDJPY... → forex

  Column format:
      timestamp,open,high,low,close,volume
      timestamp: Unix milliseconds UTC (bar OPEN time)
      volume:    Dukascopy volume (millions of units for FX, contracts for CFDs)

Loading into chart-fin
──────────────────────
  1. Refresh the browser (⌘R). No CSVs are ingested at boot.
  2. Open the Chart Picker → Rescan disk. The new symbol shows up as "pending".
  3. Click the symbol → its single CSV is fetched into IndexedDB → chart opens.

Notes
─────
  • Dukascopy skips Saturdays entirely and much of Sunday for FX pairs.
  • Empty .bi5 files (HTTP 200 with 0 bytes) are legitimate — that just means
    "no ticks in that hour" (typical during weekends / market close). We tolerate them.
  • HTTP 404 also treated as empty (some old dates missing).
  • Be polite: default is 8 concurrent connections. Bump with --threads if needed.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import lzma
import pathlib
import struct
import sys
import time
from collections import defaultdict
from typing import Iterable

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Shared helper — writes the markets/manifest.json the browser reads on load.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
try:
    from _manifest import rebuild_manifest  # noqa: E402
except ImportError:
    rebuild_manifest = None  # type: ignore[assignment]

# ── Constants ─────────────────────────────────────────────────────────────

DUKA_BASE = "https://datafeed.dukascopy.com/datafeed"

# Divisor applied to raw integer prices in tick/candle .bi5 payloads.
# For most FX pairs this is 100000 (5-decimal quotes).
# For JPY pairs and metals like XAU/XAG (3-decimal quotes) it is 1000.
# For indices / CFDs it is usually 1000. Adjust here if adding new symbols.
POINT_VALUE: dict[str, float] = {
    "XAUUSD": 1000.0,
    "XAGUSD": 1000.0,
    "EURUSD": 100000.0,
    "GBPUSD": 100000.0,
    "AUDUSD": 100000.0,
    "NZDUSD": 100000.0,
    "USDCAD": 100000.0,
    "USDCHF": 100000.0,
    "USDJPY": 1000.0,
    "EURJPY": 1000.0,
    "GBPJPY": 1000.0,
}

# Earliest date Dukascopy publishes data for a symbol (approximate).
FIRST_AVAILABLE: dict[str, dt.date] = {
    "XAUUSD": dt.date(2003, 5, 5),
    "XAGUSD": dt.date(2003, 5, 5),
    "EURUSD": dt.date(2003, 5, 5),
}

TF_ALIASES = {
    "tick": "tick", "ticks": "tick",
    "m1": "1m", "1m": "1m",
    "m5": "5m", "5m": "5m",
    "m15": "15m", "15m": "15m",
    "m30": "30m", "30m": "30m",
    "h1": "1h", "1h": "1h",
    "h4": "4h", "4h": "4h",
    "d1": "1d", "1d": "1d",
    "w1": "1w", "1w": "1w",
}

TF_SECONDS = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400,
    "1w": 604800,
}

# ── HTTP session with retries ─────────────────────────────────────────────

def make_session() -> requests.Session:
    s = requests.Session()
    retry = Retry(
        total=6,
        backoff_factor=1.2,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=32, pool_maxsize=32)
    s.mount("https://", adapter)
    s.headers.update({
        "User-Agent": "Mozilla/5.0 (compatible; chart-fin/dukascopy-downloader)",
        "Accept": "*/*",
    })
    return s

# ── URL builders ──────────────────────────────────────────────────────────

def tick_url(sym: str, d: dt.date, hour: int) -> str:
    return f"{DUKA_BASE}/{sym}/{d.year:04d}/{d.month-1:02d}/{d.day:02d}/{hour:02d}h_ticks.bi5"

def m1_url(sym: str, d: dt.date, hour: int, price: str) -> str:
    return f"{DUKA_BASE}/{sym}/{d.year:04d}/{d.month-1:02d}/{d.day:02d}/{hour:02d}h_{price}_candle.bi5"

def h1_url(sym: str, year: int, month0: int, price: str) -> str:
    return f"{DUKA_BASE}/{sym}/{year:04d}/{month0:02d}/{price}_candle.bi5"

def d1_url(sym: str, year: int, price: str) -> str:
    return f"{DUKA_BASE}/{sym}/{year:04d}/{price}_candle.bi5"

# ── Binary parsers ────────────────────────────────────────────────────────

# Tick record: 20 bytes, big-endian: time_ms_from_hour, ask_int, bid_int, ask_vol_f, bid_vol_f
TICK_STRUCT = struct.Struct(">IIIff")
# Candle record: 24 bytes, big-endian: t_off, open_int, close_int, low_int, high_int, volume_f
CANDLE_STRUCT = struct.Struct(">IIIIIf")

def fetch_bi5(session: requests.Session, url: str) -> bytes:
    """GET a .bi5 file, LZMA-decompress, return raw bytes. Empty on 404 or empty body."""
    r = session.get(url, timeout=45)
    if r.status_code == 404:
        return b""
    r.raise_for_status()
    data = r.content
    if not data:
        return b""
    try:
        return lzma.decompress(data)
    except lzma.LZMAError:
        # Some files use raw LZMA1 stream — try alternative filter chain
        try:
            filters = [{"id": lzma.FILTER_LZMA1}]
            return lzma.decompress(data, format=lzma.FORMAT_RAW, filters=filters)
        except lzma.LZMAError as e:
            raise RuntimeError(f"LZMA decode failed for {url}: {e}") from e

def parse_ticks(raw: bytes, hour_epoch_ms: int, divisor: float) -> list[tuple[int, float, float, float, float]]:
    """Return list of (timestamp_ms, ask, bid, ask_vol, bid_vol)."""
    out = []
    for chunk in TICK_STRUCT.iter_unpack(raw):
        t_off, ask_i, bid_i, ask_v, bid_v = chunk
        ts = hour_epoch_ms + t_off
        out.append((ts, ask_i / divisor, bid_i / divisor, float(ask_v), float(bid_v)))
    return out

def parse_candles(raw: bytes, base_epoch_ms: int, step_ms: int, divisor: float) -> list[tuple[int, float, float, float, float, float]]:
    """Return list of (timestamp_ms, open, high, low, close, volume).

    base_epoch_ms is the epoch ms of the *file's* time origin.
    step_ms is the unit of the t_off field (60_000 for M1/H1, 86_400_000 for D1).
    """
    out = []
    for chunk in CANDLE_STRUCT.iter_unpack(raw):
        t_off, o_i, c_i, l_i, h_i, vol = chunk
        # Dukascopy fills gaps with synthetic records where OHLC are all identical
        # and volume is 0. We keep them (many datasets need continuous bars),
        # but you can skip them if you'd rather have sparse data.
        ts = base_epoch_ms + t_off * step_ms
        out.append((ts, o_i / divisor, h_i / divisor, l_i / divisor, c_i / divisor, float(vol)))
    return out

# ── Date iteration ────────────────────────────────────────────────────────

def daterange(start: dt.date, end: dt.date) -> Iterable[dt.date]:
    d = start
    one = dt.timedelta(days=1)
    while d <= end:
        yield d
        d += one

# ── Aggregation (tick → OHLC) ─────────────────────────────────────────────

def aggregate_ticks(
    ticks: Iterable[tuple[int, float, float, float, float]],
    tf_seconds: int,
    price: str,
) -> dict[int, list[float]]:
    """Aggregate ticks into OHLCV bars. price ∈ {'bid','ask','mid'}."""
    bar_ms = tf_seconds * 1000
    bars: dict[int, list[float]] = {}
    for ts, ask, bid, ask_v, bid_v in ticks:
        if price == "bid":
            p = bid
        elif price == "ask":
            p = ask
        else:
            p = (ask + bid) * 0.5
        v = ask_v + bid_v
        bucket = (ts // bar_ms) * bar_ms
        b = bars.get(bucket)
        if b is None:
            bars[bucket] = [p, p, p, p, v]
        else:
            if p > b[1]:
                b[1] = p
            if p < b[2]:
                b[2] = p
            b[3] = p
            b[4] += v
    return bars

# ── CSV writer ────────────────────────────────────────────────────────────

def write_csv(path: pathlib.Path, rows: Iterable[tuple[int, float, float, float, float, float]]) -> int:
    """Write timestamp,open,high,low,close,volume rows (already sorted). Returns row count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write("timestamp,open,high,low,close,volume\n")
        for ts, o, h, l, c, v in rows:
            f.write(f"{ts},{o},{h},{l},{c},{v}\n")
            n += 1
    return n

# ── Downloaders per timeframe ─────────────────────────────────────────────

def download_ticks_range(
    session: requests.Session,
    sym: str,
    start: dt.date,
    end: dt.date,
    threads: int,
    state_path: pathlib.Path | None,
    resume_state: set[str],
) -> list[tuple[int, float, float, float, float]]:
    """Download all hourly tick files between start and end (inclusive)."""
    divisor = POINT_VALUE.get(sym.upper(), 100000.0)
    jobs: list[tuple[dt.date, int, str]] = []
    for d in daterange(start, end):
        # Dukascopy has no data on Saturdays; skip to save requests.
        if d.weekday() == 5:
            continue
        for h in range(24):
            key = f"tick:{d.isoformat()}T{h:02d}"
            if key in resume_state:
                continue
            jobs.append((d, h, key))

    all_ticks: list[tuple[int, float, float, float, float]] = []
    epoch = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    done = 0
    total = len(jobs)
    if total == 0:
        print(f"  [ticks] Nothing to do for {sym} {start}..{end}")
        return all_ticks

    print(f"  [ticks] {sym}: {total} hourly files to fetch ({threads} threads)")
    lock_save_every = max(200, total // 40)

    with cf.ThreadPoolExecutor(max_workers=threads) as pool:
        fut_to_meta = {
            pool.submit(fetch_bi5, session, tick_url(sym, d, h)): (d, h, key)
            for d, h, key in jobs
        }
        for fut in cf.as_completed(fut_to_meta):
            d, h, key = fut_to_meta[fut]
            try:
                raw = fut.result()
            except Exception as e:
                print(f"  ! {d} {h:02d}h failed: {e}", file=sys.stderr)
                continue
            if raw:
                hour_dt = dt.datetime(d.year, d.month, d.day, h, tzinfo=dt.timezone.utc)
                hour_ms = int((hour_dt - epoch).total_seconds() * 1000)
                all_ticks.extend(parse_ticks(raw, hour_ms, divisor))
            resume_state.add(key)
            done += 1
            if done % 50 == 0 or done == total:
                pct = 100.0 * done / total
                print(f"    {done}/{total} ({pct:.1f}%)  ticks={len(all_ticks):,}", end="\r")
            if state_path and done % lock_save_every == 0:
                state_path.write_text(json.dumps(sorted(resume_state)))
    print()
    all_ticks.sort(key=lambda x: x[0])
    return all_ticks

def download_native_m1(
    session: requests.Session,
    sym: str,
    start: dt.date,
    end: dt.date,
    price: str,
    threads: int,
) -> list[tuple[int, float, float, float, float, float]]:
    """Download native M1 OHLC candles (24 per hourly .bi5 file)."""
    divisor = POINT_VALUE.get(sym.upper(), 100000.0)
    jobs: list[tuple[dt.date, int]] = []
    for d in daterange(start, end):
        if d.weekday() == 5:
            continue
        for h in range(24):
            jobs.append((d, h))
    total = len(jobs)
    if total == 0:
        return []

    print(f"  [m1-native] {sym}: {total} hourly candle files to fetch ({threads} threads)")
    epoch = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    all_bars: list[tuple[int, float, float, float, float, float]] = []
    done = 0
    with cf.ThreadPoolExecutor(max_workers=threads) as pool:
        fut_to_meta = {
            pool.submit(fetch_bi5, session, m1_url(sym, d, h, price)): (d, h)
            for d, h in jobs
        }
        for fut in cf.as_completed(fut_to_meta):
            d, h = fut_to_meta[fut]
            try:
                raw = fut.result()
            except Exception as e:
                print(f"  ! {d} {h:02d}h failed: {e}", file=sys.stderr)
                continue
            if raw:
                hour_dt = dt.datetime(d.year, d.month, d.day, h, tzinfo=dt.timezone.utc)
                hour_ms = int((hour_dt - epoch).total_seconds() * 1000)
                # M1 candle t_off is in seconds since file start
                all_bars.extend(parse_candles(raw, hour_ms, 1000, divisor))
            done += 1
            if done % 50 == 0 or done == total:
                pct = 100.0 * done / total
                print(f"    {done}/{total} ({pct:.1f}%)  bars={len(all_bars):,}", end="\r")
    print()
    all_bars.sort(key=lambda x: x[0])
    return all_bars

def download_native_h1(
    session: requests.Session, sym: str, start: dt.date, end: dt.date, price: str, threads: int,
) -> list[tuple[int, float, float, float, float, float]]:
    """Download native H1 candles — one file per month."""
    divisor = POINT_VALUE.get(sym.upper(), 100000.0)
    jobs: list[tuple[int, int]] = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        jobs.append((y, m))
        m += 1
        if m > 12:
            m = 1
            y += 1
    total = len(jobs)
    print(f"  [h1-native] {sym}: {total} monthly candle files to fetch")
    epoch = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    all_bars = []
    with cf.ThreadPoolExecutor(max_workers=threads) as pool:
        fut_to_meta = {
            pool.submit(fetch_bi5, session, h1_url(sym, y, m - 1, price)): (y, m)
            for y, m in jobs
        }
        done = 0
        for fut in cf.as_completed(fut_to_meta):
            y, m = fut_to_meta[fut]
            try:
                raw = fut.result()
            except Exception as e:
                print(f"  ! {y}-{m:02d} failed: {e}", file=sys.stderr)
                continue
            if raw:
                base_dt = dt.datetime(y, m, 1, tzinfo=dt.timezone.utc)
                base_ms = int((base_dt - epoch).total_seconds() * 1000)
                # H1 candle t_off is in seconds since month start
                all_bars.extend(parse_candles(raw, base_ms, 1000, divisor))
            done += 1
            print(f"    {done}/{total}  bars={len(all_bars):,}", end="\r")
    print()
    all_bars.sort(key=lambda x: x[0])
    # Trim to [start, end]
    start_ms = int((dt.datetime(start.year, start.month, start.day, tzinfo=dt.timezone.utc)
                    - epoch).total_seconds() * 1000)
    end_ms = int((dt.datetime(end.year, end.month, end.day, 23, 59, 59, tzinfo=dt.timezone.utc)
                  - epoch).total_seconds() * 1000)
    return [b for b in all_bars if start_ms <= b[0] <= end_ms]

def download_native_d1(
    session: requests.Session, sym: str, start: dt.date, end: dt.date, price: str, threads: int,
) -> list[tuple[int, float, float, float, float, float]]:
    """Download native D1 candles — one file per year."""
    divisor = POINT_VALUE.get(sym.upper(), 100000.0)
    years = list(range(start.year, end.year + 1))
    print(f"  [d1-native] {sym}: {len(years)} yearly candle files to fetch")
    epoch = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    all_bars = []
    with cf.ThreadPoolExecutor(max_workers=threads) as pool:
        fut_to_meta = {
            pool.submit(fetch_bi5, session, d1_url(sym, y, price)): y for y in years
        }
        for fut in cf.as_completed(fut_to_meta):
            y = fut_to_meta[fut]
            try:
                raw = fut.result()
            except Exception as e:
                print(f"  ! {y} failed: {e}", file=sys.stderr)
                continue
            if raw:
                base_dt = dt.datetime(y, 1, 1, tzinfo=dt.timezone.utc)
                base_ms = int((base_dt - epoch).total_seconds() * 1000)
                # D1 candle t_off is in days since year start
                all_bars.extend(parse_candles(raw, base_ms, 86_400_000, divisor))
    all_bars.sort(key=lambda x: x[0])
    start_ms = int((dt.datetime(start.year, start.month, start.day, tzinfo=dt.timezone.utc)
                    - epoch).total_seconds() * 1000)
    end_ms = int((dt.datetime(end.year, end.month, end.day, 23, 59, 59, tzinfo=dt.timezone.utc)
                  - epoch).total_seconds() * 1000)
    return [b for b in all_bars if start_ms <= b[0] <= end_ms]

# ── Main orchestration ───────────────────────────────────────────────────

def parse_date(s: str) -> dt.date:
    if s.lower() == "today":
        return dt.date.today()
    return dt.date.fromisoformat(s)

def main() -> int:
    p = argparse.ArgumentParser(
        description="Download Dukascopy historical data for chart-fin.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--symbol", default="XAUUSD", help="Instrument symbol (e.g. XAUUSD, EURUSD).")
    p.add_argument("--start", default=None, help="Start date YYYY-MM-DD (default: earliest known).")
    p.add_argument("--end", default="today", help="End date YYYY-MM-DD or 'today'.")
    p.add_argument("--tf", action="append", default=None,
                   help="Timeframe(s) to produce. Repeat flag for multiple. "
                        "Choices: tick, m1, 5m, 15m, 30m, 1h, 4h, 1d, 1w. Default: m1.")
    p.add_argument("--price", default="bid", choices=("bid", "ask", "mid"),
                   help="Price side. Dukascopy natively serves BID and ASK; 'mid' requires tick source.")
    p.add_argument("--source", default="auto", choices=("auto", "native", "tick"),
                   help="'native' uses Dukascopy OHLC files (fast, m1/1h/1d only). "
                        "'tick' downloads ticks and aggregates. 'auto' picks the best per TF.")
    p.add_argument("--threads", type=int, default=8, help="Parallel HTTP connections.")
    p.add_argument("--out-dir", default=None,
                   help="Output directory (default: <repo>/public/data/markets/<market>/, "
                        "which is where the chart-fin picker looks). "
                        "Pass an explicit path to override.")
    p.add_argument("--market", default=None,
                   help="Market bucket under public/data/markets/. "
                        "Auto-inferred from --symbol: XAU/XAG → 'metals', */USD FX pairs → 'forex', "
                        "everything else → 'forex'. Ignored when --out-dir is set.")
    p.add_argument("--resume", action="store_true",
                   help="Skip hourly tick files already recorded in the state file.")
    args = p.parse_args()

    sym = args.symbol.upper()
    tfs_raw = args.tf or ["1m"]
    tfs = []
    for t in tfs_raw:
        key = TF_ALIASES.get(t.lower())
        if not key:
            print(f"Unknown timeframe: {t}", file=sys.stderr)
            return 2
        tfs.append(key)

    if args.price == "mid" and args.source == "native":
        print("--price mid requires --source tick (Dukascopy has no MID candles).", file=sys.stderr)
        return 2

    start = parse_date(args.start) if args.start else FIRST_AVAILABLE.get(sym, dt.date(2003, 5, 5))
    end = parse_date(args.end)
    if end < start:
        print(f"end ({end}) before start ({start})", file=sys.stderr)
        return 2

    repo_root = pathlib.Path(__file__).resolve().parent.parent
    markets_root = repo_root / "public" / "data" / "markets"
    # Auto-pick a market bucket if the user didn't override it. Metals
    # (XAU/XAG) trade on the same session grid as FX, and the app only
    # defines a `forex` preset — so metals live under `forex/` too.
    if args.market:
        market = args.market
    else:
        market = "forex"
    if args.out_dir:
        out_dir = pathlib.Path(args.out_dir)
    else:
        out_dir = markets_root / market
    out_dir.mkdir(parents=True, exist_ok=True)

    session = make_session()

    print(f"Symbol      : {sym}")
    print(f"Date range  : {start} → {end}  ({(end - start).days + 1} days)")
    print(f"Timeframes  : {', '.join(tfs)}")
    print(f"Price side  : {args.price}")
    print(f"Source      : {args.source}")
    print(f"Threads     : {args.threads}")
    print(f"Market      : {market}")
    print(f"Output dir  : {out_dir}")
    print()

    # Decide, for each requested TF, whether we go native or via ticks.
    def pick_source(tf: str) -> str:
        if args.source != "auto":
            return args.source
        if tf in ("1m", "1h", "1d") and args.price in ("bid", "ask"):
            return "native"
        return "tick"

    need_ticks = any(pick_source(tf) == "tick" or tf == "tick" for tf in tfs)

    t0 = time.time()

    # ── Bulk fetch shared tick pool (if any TF needs it) ─────────────────
    ticks: list[tuple[int, float, float, float, float]] = []
    if need_ticks:
        state_path = out_dir / f".dukascopy_{sym.lower()}_ticks.state.json"
        resume_state: set[str] = set()
        if args.resume and state_path.exists():
            try:
                resume_state = set(json.loads(state_path.read_text()))
                print(f"  [resume] {len(resume_state):,} hourly files already downloaded")
            except Exception as e:
                print(f"  [resume] state file unreadable ({e}), starting fresh")
        ticks = download_ticks_range(session, sym, start, end, args.threads, state_path, resume_state)
        state_path.write_text(json.dumps(sorted(resume_state)))
        print(f"  [ticks] total ticks: {len(ticks):,}")

    # ── Emit each requested timeframe ────────────────────────────────────
    written_tfs: list[str] = []
    for tf in tfs:
        src = pick_source(tf)
        # Use the SYMBOL (upper-case) + timeframe naming that _manifest.py
        # (and marketDb.ts) expect — <SYMBOL>_<TF>.csv.
        out_path = out_dir / f"{sym}_{tf}.csv"
        print(f"\n→ {tf}  (source={src})  →  {out_path.name}")

        if tf == "tick":
            # Emit raw ticks as pseudo-OHLC (o=h=l=c=price, volume=ask_v+bid_v)
            rows = []
            for ts, ask, bid, av, bv in ticks:
                if args.price == "bid":
                    px = bid
                elif args.price == "ask":
                    px = ask
                else:
                    px = (ask + bid) * 0.5
                rows.append((ts, px, px, px, px, av + bv))
            n = write_csv(out_path, rows)
        elif src == "native" and tf == "1m":
            bars = download_native_m1(session, sym, start, end, args.price, args.threads)
            n = write_csv(out_path, bars)
        elif src == "native" and tf == "1h":
            bars = download_native_h1(session, sym, start, end, args.price, args.threads)
            n = write_csv(out_path, bars)
        elif src == "native" and tf == "1d":
            bars = download_native_d1(session, sym, start, end, args.price, args.threads)
            n = write_csv(out_path, bars)
        else:
            # Aggregate ticks
            if not ticks:
                print(f"  ! no ticks available to build {tf}, skipping")
                continue
            secs = TF_SECONDS[tf]
            bars_map = aggregate_ticks(ticks, secs, args.price)
            bars = [(ts, *ohlcv) for ts, ohlcv in sorted(bars_map.items())]
            # (unpack: bars_map value is [o,h,l,c,v])
            bars = [(ts, o, h, l, c, v) for ts, (o, h, l, c, v) in
                    ((ts, tuple(bars_map[ts])) for ts in sorted(bars_map))]
            n = write_csv(out_path, bars)

        if n > 0:
            written_tfs.append(tf)
        print(f"  ✓ {n:,} rows written")

    # ── Sidecar meta.json + manifest rebuild ─────────────────────────────
    if written_tfs:
        meta_path = out_dir / f"{sym}.meta.json"
        meta = {
            "exchange": "Dukascopy",
            "description": {
                "XAUUSD": "Gold (spot)",
                "XAGUSD": "Silver (spot)",
                "EURUSD": "Euro / US Dollar",
                "GBPUSD": "British Pound / US Dollar",
                "USDJPY": "US Dollar / Japanese Yen",
            }.get(sym, sym),
            "sector": "Metals" if sym in ("XAUUSD", "XAGUSD") else "Forex",
            "industry": "Spot",
            "source": "Dukascopy Bank SA",
        }
        meta_path.write_text(json.dumps(meta, indent=2))
        print(f"  ✓ meta.json written → {meta_path.relative_to(repo_root)}")

    if written_tfs and rebuild_manifest is not None:
        rebuild_manifest(markets_root)
        print("  ✓ manifest.json rebuilt — refresh browser & open picker to see the new series.")
    elif rebuild_manifest is None:
        print("  ! _manifest.py not found — manifest NOT rebuilt.")

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
