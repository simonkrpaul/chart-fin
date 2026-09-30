#!/usr/bin/env python3
"""
mt5_sync.py
──────────────────────────────────────────────────────────────────────────────
MetaTrader 5 → chart-fin sync (Windows-only, Pepperstone / any broker).

Fetches OHLC bars from a running MT5 terminal and writes them to
`public/data/markets/forex/<SYMBOL>_<TF>.csv` in the canonical schema.
Runs one-shot or on a loop. Safe to run alongside a manually-imported
`XAUUSD` / `XAUUSD_EVTL` symbol — MT5 data lands under a **separate**
symbol (default `XAUUSD_MT5`) so nothing else is touched.

Requirements
────────────
• Windows (the `MetaTrader5` PyPI package is Windows-only).
• Python 3.10+ (3.12 recommended).
• `pip install MetaTrader5` (in the same venv you use for the other scripts).
• MT5 terminal running AND logged in to your Pepperstone demo account
  (attach mode = no password stored in Python).

Auth model
──────────
Default = **attach mode**. `mt5.initialize()` with no args inherits the
already-logged-in session from the running MT5 terminal window. Nothing
sensitive touches the script.

Optional headless mode: pass --login, --server, --password if you want the
script to log in itself. Passwords should come from a `.env` file (see
`--env` flag) that is git-ignored, NEVER from the command line history.

Usage
─────
    # One-shot: fetch last 2000 bars for XAUUSD on 1m/5m/15m/1h/4h/1d/1w/1M
    python scripts/mt5_sync.py

    # Loop every 10 minutes (Ctrl-C to stop)
    python scripts/mt5_sync.py --loop 600

    # Only specific timeframes
    python scripts/mt5_sync.py --tf 5m 15m 1h

    # Pepperstone sometimes exposes the symbol with a suffix (`.raw`, `.i`,
    # `+`, etc.). Try alternates automatically or force one:
    python scripts/mt5_sync.py --mt5-symbol XAUUSD.raw

    # Custom output symbol (default XAUUSD_MT5 — DIFFERENT from XAUUSD /
    # XAUUSD_EVTL so each source's TF ladder stays self-consistent):
    python scripts/mt5_sync.py --symbol XAUUSD_PEPPERSTONE

    # Headless login (creds from environment)
    export MT5_LOGIN=12345678
    export MT5_SERVER=Pepperstone-Demo
    export MT5_PASSWORD=supersecret
    python scripts/mt5_sync.py --headless

Data quality
────────────
• MT5 timestamps are UTC seconds — converted to chart-fin ms.
• MT5 returns broker-mid or broker-bid depending on the broker's config.
  Pepperstone's default is broker-bid.
• Deduplication is by-timestamp; existing bars are kept, new bars appended.
  Re-running is idempotent.
"""
from __future__ import annotations

import argparse
import csv
import os
import pathlib
import sys
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKETS_ROOT = REPO_ROOT / "public" / "data" / "markets"
FOREX_DIR = MARKETS_ROOT / "forex"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _manifest import (  # noqa: E402
    rebuild_manifest as _rebuild_manifest,
    tf_to_filename_suffix as _tf_suffix,
    update_meta_source as _update_meta_source,
)
from _resample import (  # noqa: E402
    forex_daily_bucket_ts,
    forex_weekly_bucket_ts,
    resample_bars,
)

# ── Timeframe mapping ─────────────────────────────────────────────────────
# chart-fin TF  → MT5 constant. Filled in lazily after MT5 is imported.
TF_ALL = ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]


def _load_mt5():
    """Import MetaTrader5, exiting with a helpful error on non-Windows."""
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError as e:
        print(
            "\n[mt5_sync] MetaTrader5 package not installed.\n"
            "  Windows only. Install with:  pip install MetaTrader5\n"
            f"  (original error: {e})",
            file=sys.stderr,
        )
        sys.exit(2)
    return mt5


def _tf_map(mt5) -> dict[str, int]:
    return {
        "1m":  mt5.TIMEFRAME_M1,
        "5m":  mt5.TIMEFRAME_M5,
        "15m": mt5.TIMEFRAME_M15,
        "1h":  mt5.TIMEFRAME_H1,
        "4h":  mt5.TIMEFRAME_H4,
        "1d":  mt5.TIMEFRAME_D1,
        "1w":  mt5.TIMEFRAME_W1,
        "1M":  mt5.TIMEFRAME_MN1,
    }


def _connect(args) -> None:
    mt5 = _load_mt5()
    if args.headless:
        login = int(args.login or os.environ.get("MT5_LOGIN") or 0)
        server = args.server or os.environ.get("MT5_SERVER") or ""
        password = args.password or os.environ.get("MT5_PASSWORD") or ""
        if not login or not server or not password:
            print("[mt5_sync] headless mode needs MT5_LOGIN, MT5_SERVER, MT5_PASSWORD.", file=sys.stderr)
            sys.exit(2)
        ok = mt5.initialize(login=login, server=server, password=password)
    else:
        ok = mt5.initialize()
    if not ok:
        print(f"[mt5_sync] mt5.initialize() failed: {mt5.last_error()}", file=sys.stderr)
        print("[mt5_sync] Is the MT5 terminal running & logged in?", file=sys.stderr)
        sys.exit(2)

    info = mt5.account_info()
    if info is not None:
        print(f"[mt5_sync] connected to {info.server}  account={info.login}  currency={info.currency}")


def _log_broker_offset(mt5_symbol: str, tz_name: str) -> None:
    """Compare our --broker-tz assumption with MT5's actual server clock and
    warn if they disagree by more than an hour. Uses the current tick time
    (or a recent 1m bar) as the reference."""
    mt5 = _load_mt5()
    tick = mt5.symbol_info_tick(mt5_symbol)
    server_epoch = int(tick.time) if tick else None
    if not server_epoch:
        # Fall back to the most recent 1m bar's time.
        rates = mt5.copy_rates_from_pos(mt5_symbol, mt5.TIMEFRAME_M1, 0, 1)
        if rates is not None and len(rates) > 0:
            server_epoch = int(rates[0]["time"])
    if not server_epoch:
        return

    now_utc_epoch = int(time.time())
    actual_offset_hours = round((server_epoch - now_utc_epoch) / 3600)

    tz = ZoneInfo(tz_name)
    assumed_offset = datetime.now(tz).utcoffset()
    assumed_hours = int(assumed_offset.total_seconds() / 3600) if assumed_offset else 0

    tag = "✓" if actual_offset_hours == assumed_hours else "⚠"
    print(f"[mt5_sync] {tag} broker clock offset: MT5 reports UTC{actual_offset_hours:+d}h, "
          f"--broker-tz {tz_name} = UTC{assumed_hours:+d}h")
    if actual_offset_hours != assumed_hours:
        print(f"[mt5_sync]   Timestamps will be off by {actual_offset_hours - assumed_hours}h. "
              f"Fix with --broker-tz Etc/GMT{-actual_offset_hours:+d} for a fixed offset.")


def _resolve_symbol(preferred: str) -> str:
    """Return the actual broker-side symbol name. Tries a few common suffixes."""
    mt5 = _load_mt5()
    candidates = [
        preferred,
        f"{preferred}.a",     # Pepperstone demo (and some other cTrader-linked feeds)
        f"{preferred}.raw",   # Pepperstone Razor / ECN
        f"{preferred}.i",     # some cent / inversed accounts
        f"{preferred}+",      # a few STP accounts
    ]
    if preferred == "XAUUSD":
        candidates.extend(["GOLD", "XAUUSDm"])
    for cand in candidates:
        info = mt5.symbol_info(cand)
        if info is not None:
            if not info.visible:
                mt5.symbol_select(cand, True)
            print(f"[mt5_sync] using MT5 symbol: {cand}")
            return cand
    print(f"[mt5_sync] symbol '{preferred}' not found on this broker. Tried: {candidates}", file=sys.stderr)
    print("[mt5_sync] Open MT5 → Market Watch → right-click → Show All to enable it, then retry.", file=sys.stderr)
    sys.exit(2)


def _fetch_bars(
    mt5_symbol: str,
    tf_code: str,
    bar_count: int,
    broker_tz: ZoneInfo,
    from_ts_ms: int | None = None,
) -> list[tuple[int, float, float, float, float, float]]:
    """Fetch OHLC bars from MT5, converting broker-local bar times to UTC.

    MT5 returns bar `time` as broker-server local time, encoded as Unix-epoch
    seconds (a quirk of the API). For a Pepperstone MT5 server on Athens time
    that means UTC+2 in winter / UTC+3 in summer. Left uncorrected, bars
    land 2-3 hours ahead of the same wallclock candle in a UTC-sourced feed
    (evtradelabs / Kaggle), which causes the "overlap" the user sees when
    seeding from those files.

    • from_ts_ms=None  → last `bar_count` bars from now (initial sync).
    • from_ts_ms=N     → every bar from N through now, capped at `bar_count`.
      N is UTC; it's converted to broker-local for the MT5 call.
    """
    mt5 = _load_mt5()
    tf_const = _tf_map(mt5)[tf_code]
    if from_ts_ms is None:
        rates = mt5.copy_rates_from_pos(mt5_symbol, tf_const, 0, bar_count)
    else:
        utc_dt = datetime.fromtimestamp(from_ts_ms / 1000, tz=timezone.utc)
        broker_naive = utc_dt.astimezone(broker_tz).replace(tzinfo=None)
        rates = mt5.copy_rates_from(mt5_symbol, tf_const, broker_naive, bar_count)
    if rates is None or len(rates) == 0:
        print(f"[mt5_sync]   {tf_code:>4}  no bars returned ({mt5.last_error()})", file=sys.stderr)
        return []
    out: list[tuple[int, float, float, float, float, float]] = []
    for r in rates:
        # Reinterpret the "epoch seconds" value as a naive broker-local
        # datetime, attach broker_tz, convert to true UTC.
        broker_naive = datetime.utcfromtimestamp(int(r["time"]))
        aware_broker = broker_naive.replace(tzinfo=broker_tz)
        ts_ms = int(aware_broker.astimezone(timezone.utc).timestamp() * 1000)
        # tick_volume for FX; real_volume is often 0 on demo accounts.
        v = float(r["tick_volume"] or r.get("real_volume", 0) or 0)
        out.append((ts_ms, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), v))
    return out


def _last_ts_in_csv(path: pathlib.Path) -> int | None:
    """Return the last row's timestamp (Unix ms), or None if the file is empty."""
    if not path.exists():
        return None
    last_ts: int | None = None
    with path.open("r", encoding="utf-8", newline="") as fh:
        r = csv.reader(fh); next(r, None)
        for row in r:
            if not row:
                continue
            try:
                last_ts = int(row[0])
            except ValueError:
                continue
    return last_ts


def _merge_into_csv(
    path: pathlib.Path,
    new_bars: list[tuple[int, float, float, float, float, float]],
) -> tuple[int, int]:
    """Return (existing_count, appended_count). New bars overwrite same-ts existing bars."""
    existing: dict[int, tuple[float, float, float, float, float]] = {}
    if path.exists():
        with path.open("r", encoding="utf-8", newline="") as fh:
            r = csv.reader(fh); next(r, None)
            for row in r:
                if len(row) < 6:
                    continue
                try:
                    ts = int(row[0])
                    existing[ts] = (float(row[1]), float(row[2]), float(row[3]), float(row[4]), float(row[5]))
                except ValueError:
                    continue
    before = len(existing)
    for ts, o, h, lo, c, v in new_bars:
        existing[ts] = (o, h, lo, c, v)
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        for ts in sorted(existing):
            o, h, lo, c, v = existing[ts]
            w.writerow([ts, o, h, lo, c, v])
    return before, len(existing) - before


# TF → minutes per bar. Used to size gap-fills.
_TF_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080, "1M": 43200}


def _rebuild_daily_from_5m(sym: str, boundary_tz_name: str, boundary_hour: int) -> None:
    """After a sync cycle, regenerate 1d and 1w from <sym>_5m.csv using the
    forex trading-day boundary (default 17:00 NY). MT5's native 1d bars are
    stamped at broker midnight (Athens ≈ 21 UTC in summer) which reads as
    the wrong calendar day on our chart — deriving from 5m fixes that.
    """
    src = FOREX_DIR / f"{sym}_5m.csv"
    if not src.exists():
        return
    boundary_tz = ZoneInfo(boundary_tz_name)
    with src.open("r", encoding="utf-8", newline="") as fh:
        r = csv.reader(fh); next(r, None)
        bars = [(int(row[0]), float(row[1]), float(row[2]), float(row[3]),
                 float(row[4]), float(row[5])) for row in r if len(row) >= 6]
    if not bars:
        return
    for tf, key_fn in (
        ("1d", lambda ts: forex_daily_bucket_ts(ts, boundary_tz, boundary_hour)),
        ("1w", lambda ts: forex_weekly_bucket_ts(ts, boundary_tz, boundary_hour)),
    ):
        path = FOREX_DIR / f"{sym}_{_tf_suffix(tf)}.csv"
        n = 0
        with path.open("w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
            for row in resample_bars(bars, key_fn):
                w.writerow(row); n += 1
        print(f"  ↻ {tf:>4}  derived from 5m ({boundary_hour:02d}:00 {boundary_tz_name})  {n:>6,} rows  →  {path.name}")
        _update_meta_source(
            FOREX_DIR, sym, tf,
            exchange=f"MetaTrader5 5m → resampled ({boundary_hour:02d}:00 {boundary_tz_name})",
            description="Derived from MT5 5m stream using forex trading-day boundary",
        )


def _one_cycle(args, mt5_symbol: str, broker_tz: ZoneInfo) -> None:
    now_utc = datetime.now(tz=timezone.utc)
    print(f"\n[mt5_sync] cycle @ {now_utc.isoformat(timespec='seconds')}")
    now_ms = int(now_utc.timestamp() * 1000)

    # Skip 1d / 1w on the MT5 fetch — they'll be derived from 5m below to
    # avoid the broker-midnight labeling mismatch. Runs anyway if the user
    # explicitly whittled --tf to only include 1d/1w.
    intraday_tfs = [t for t in args.tf if t not in ("1d", "1w")]
    fetch_tfs = intraday_tfs or args.tf
    derive_daily = ("1d" in args.tf or "1w" in args.tf) and "5m" in fetch_tfs

    for tf in fetch_tfs:
        path = FOREX_DIR / f"{args.symbol}_{_tf_suffix(tf)}.csv"
        last_ts = _last_ts_in_csv(path)

        # Decide how to fetch:
        #   • empty file / --full-refresh   → last `--bars` bars from now
        #   • gap > `--bars` × TF minutes   → gap-fill from last_ts, capped at --max-backfill
        #   • small / no gap                → last `--bars` bars from now (cheap keep-alive)
        if last_ts is None or args.full_refresh:
            bars = _fetch_bars(mt5_symbol, tf, args.bars, broker_tz)
            mode = "tail"
        else:
            gap_min = (now_ms - last_ts) / 60_000
            expected_bars = gap_min / _TF_MINUTES[tf]
            if expected_bars > args.bars:
                # Overlap the last kept bar by one interval so nothing slips through.
                from_ts = last_ts - _TF_MINUTES[tf] * 60_000
                bars = _fetch_bars(mt5_symbol, tf, args.max_backfill, broker_tz, from_ts_ms=from_ts)
                mode = f"gap-fill ~{expected_bars:.0f}"
            else:
                bars = _fetch_bars(mt5_symbol, tf, args.bars, broker_tz)
                mode = "tail"

        if not bars:
            continue
        before, appended = _merge_into_csv(path, bars)
        print(f"  ✓ {tf:>4}  {mode:>18}  fetched={len(bars):>6}  existing={before:>9,}  new={appended:>6}  →  {path.name}")
        _update_meta_source(
            FOREX_DIR, args.symbol, tf,
            exchange=f"MetaTrader5 live ({mt5_symbol}, tz={args.broker_tz})",
            description="MT5 broker feed via mt5_sync.py, converted to UTC",
        )

    if derive_daily:
        _rebuild_daily_from_5m(args.symbol, args.boundary_tz, args.boundary_hour)

    _rebuild_manifest(MARKETS_ROOT, repo_root=REPO_ROOT, quiet=True)


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--symbol", default="XAUUSD_MT5",
                   help="chart-fin symbol to store under (default: XAUUSD_MT5 — keep DIFFERENT from other XAUUSD sources).")
    p.add_argument("--mt5-symbol", default="XAUUSD",
                   help="Broker-side symbol name. Auto-tries .raw / .i / GOLD variants.")
    p.add_argument("--tf", nargs="+", default=TF_ALL, choices=TF_ALL,
                   help="Timeframes to fetch each cycle.")
    p.add_argument("--bars", type=int, default=2000,
                   help="Bars-per-cycle to fetch per TF for keep-alive (small-gap) cycles.")
    p.add_argument("--max-backfill", type=int, default=100_000,
                   help="Hard cap for a gap-fill fetch when the CSV's tail is older than "
                        "--bars * TF minutes. MT5 usually accepts ~100k bars per request.")
    p.add_argument("--full-refresh", action="store_true",
                   help="Ignore the CSV's last row and re-pull the last --bars bars for every TF. "
                        "Useful if you suspect corrupt/stale rows in the tail.")
    p.add_argument("--broker-tz", default="Europe/Athens",
                   help="IANA timezone of the MT5 broker's server clock. "
                        "Pepperstone = Europe/Athens (EEST/EET, DST-aware). "
                        "Fixed-offset examples: 'Etc/GMT-3' (=UTC+3), 'Etc/GMT-2' (=UTC+2). "
                        "Bar timestamps are converted from this tz to UTC before writing.")
    p.add_argument("--boundary-tz", default="America/New_York",
                   help="IANA timezone whose --boundary-hour defines the daily/weekly "
                        "bar boundary. Forex convention: America/New_York with hour=17.")
    p.add_argument("--boundary-hour", type=int, default=17,
                   help="Hour of --boundary-tz that opens the trading day. "
                        "17 = forex (5 pm NY, matches TradingView / MT5). "
                        "1d and 1w are always derived from 5m at this boundary "
                        "instead of fetched natively (which uses broker midnight).")
    p.add_argument("--loop", type=int, default=0, metavar="SECONDS",
                   help="Run forever, sleeping SECONDS between cycles. 0 = one-shot (default).")
    p.add_argument("--headless", action="store_true",
                   help="Log in via login/server/password instead of attaching to a running terminal.")
    p.add_argument("--login", type=int, default=0)
    p.add_argument("--server", default="")
    p.add_argument("--password", default="")
    args = p.parse_args()

    try:
        broker_tz = ZoneInfo(args.broker_tz)
    except Exception as e:
        print(f"[mt5_sync] invalid --broker-tz {args.broker_tz!r}: {e}", file=sys.stderr)
        return 2

    FOREX_DIR.mkdir(parents=True, exist_ok=True)
    _connect(args)

    mt5_symbol = _resolve_symbol(args.mt5_symbol)

    # One-time sanity log: compare our broker_tz assumption vs MT5's server clock.
    _log_broker_offset(mt5_symbol, args.broker_tz)

    try:
        if args.loop <= 0:
            _one_cycle(args, mt5_symbol, broker_tz)
        else:
            print(f"[mt5_sync] loop mode: every {args.loop}s (Ctrl-C to stop)")
            while True:
                try:
                    _one_cycle(args, mt5_symbol, broker_tz)
                except Exception as e:  # keep the loop alive across transient errors
                    print(f"[mt5_sync] cycle error: {e}", file=sys.stderr)
                time.sleep(args.loop)
    finally:
        mt5 = _load_mt5()
        mt5.shutdown()

    return 0


if __name__ == "__main__":
    sys.exit(main())
