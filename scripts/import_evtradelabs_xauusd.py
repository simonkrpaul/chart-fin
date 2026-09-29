#!/usr/bin/env python3
"""
import_evtradelabs_xauusd.py
──────────────────────────────────────────────────────────────────────────────
Importer for the evtradelabs XAUUSD dataset (JSON, per-year, M5 only).

Writes a SEPARATE symbol (default `XAUUSD_EVTL`) so its 5m ↔ 1d ladder
stays self-consistent instead of getting mixed with a different source's
1m-derived TFs.

Source layout (as unpacked from evtradelabs-data-YYYY-MM-DD.zip):
    XAUUSD/M5/2004.json … XAUUSD/M5/2026.json

Each file: JSON array of {ts, o,h,l,c, ao,ah,al,ac, v}  (bid + ask sides).

Output layout (chart-fin canonical schema):
    public/data/markets/forex/XAUUSD_EVTL_5m.csv       ← source 5m
    public/data/markets/forex/XAUUSD_EVTL_15m.csv      ← resampled from 5m
    public/data/markets/forex/XAUUSD_EVTL_1h.csv       ← resampled
    public/data/markets/forex/XAUUSD_EVTL_4h.csv       ← resampled
    public/data/markets/forex/XAUUSD_EVTL_1d.csv       ← resampled
    public/data/markets/forex/XAUUSD_EVTL_1w.csv       ← resampled
    public/data/markets/forex/XAUUSD_EVTL_1mo.csv      ← resampled
    public/data/markets/forex/XAUUSD_EVTL.meta.json

Columns: timestamp,open,high,low,close,volume  (Unix ms UTC, mid = (bid+ask)/2).

Usage
─────
    # Default: import as XAUUSD_EVTL with full resample ladder
    python3.12 scripts/import_evtradelabs_xauusd.py "~/Downloads/evtradelabs-xauusd/XAUUSD/M5"

    # Use bid or ask instead of mid
    python3.12 scripts/import_evtradelabs_xauusd.py <dir> --price bid

    # Merge with existing XAUUSD_EVTL_5m.csv instead of replace
    python3.12 scripts/import_evtradelabs_xauusd.py <dir> --mode merge

    # Import under a custom symbol name
    python3.12 scripts/import_evtradelabs_xauusd.py <dir> --symbol XAUUSD_ASK --price ask
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import pathlib
import sys
from typing import Iterator

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKETS_ROOT = REPO_ROOT / "public" / "data" / "markets"
FOREX_DIR = MARKETS_ROOT / "forex"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _manifest import (  # noqa: E402
    rebuild_manifest as _rebuild_manifest,
    tf_to_filename_suffix as _tf_suffix,
    update_meta_source as _update_meta_source,
)

_MINUTE_TFS: dict[str, int] = {
    "15m": 15,
    "1h":  60,
    "4h":  240,
    "1d":  60 * 24,
}


def _iter_year(path: pathlib.Path, price_mode: str) -> Iterator[tuple[int, float, float, float, float, float]]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise SystemExit(f"{path.name}: expected a JSON array, got {type(data).__name__}")

    for row in data:
        try:
            ts_ms = int(row["ts"]) * 1000
            bo = float(row["o"]);  bh = float(row["h"]);  bl = float(row["l"]);  bc = float(row["c"])
            ao = float(row["ao"]); ah = float(row["ah"]); al = float(row["al"]); ac = float(row["ac"])
            v = float(row.get("v", 0.0) or 0.0)
        except (KeyError, TypeError, ValueError):
            continue
        if price_mode == "bid":
            o, h, lo, c = bo, bh, bl, bc
        elif price_mode == "ask":
            o, h, lo, c = ao, ah, al, ac
        else:
            o  = (bo + ao) / 2
            h  = (bh + ah) / 2
            lo = (bl + al) / 2
            c  = (bc + ac) / 2
        yield ts_ms, o, h, lo, c, v


def _load_existing(path: pathlib.Path) -> dict[int, tuple[float, float, float, float, float]]:
    if not path.exists():
        return {}
    out: dict[int, tuple[float, float, float, float, float]] = {}
    with path.open("r", encoding="utf-8", newline="") as fh:
        r = csv.reader(fh); next(r, None)
        for row in r:
            if len(row) < 6:
                continue
            try:
                ts = int(row[0])
                out[ts] = (float(row[1]), float(row[2]), float(row[3]), float(row[4]), float(row[5]))
            except ValueError:
                continue
    return out


def _write_canonical(path: pathlib.Path, rows: dict[int, tuple[float, float, float, float, float]]) -> int:
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        for ts in sorted(rows):
            o, h, lo, c, v = rows[ts]
            w.writerow([ts, o, h, lo, c, v])
    return len(rows)


# ── Resampling from a sorted 5m bar stream ─────────────────────────────────

def _resample_minute(
    sorted_bars: list[tuple[int, float, float, float, float, float]],
    bucket_min: int,
) -> Iterator[tuple[int, float, float, float, float, float]]:
    bucket_ms = bucket_min * 60_000
    cur_key = None
    o = h = lo = c = 0.0; v = 0.0
    for ts, o1, h1, l1, c1, v1 in sorted_bars:
        key = (ts // bucket_ms) * bucket_ms
        if key != cur_key:
            if cur_key is not None:
                yield cur_key, o, h, lo, c, v
            cur_key = key
            o, h, lo, c, v = o1, h1, l1, c1, v1
        else:
            if h1 > h:  h = h1
            if l1 < lo: lo = l1
            c = c1
            v += v1
    if cur_key is not None:
        yield cur_key, o, h, lo, c, v


def _resample_week(
    sorted_bars: list[tuple[int, float, float, float, float, float]],
) -> Iterator[tuple[int, float, float, float, float, float]]:
    cur_key = None
    o = h = lo = c = 0.0; v = 0.0
    for ts, o1, h1, l1, c1, v1 in sorted_bars:
        d = dt.datetime.fromtimestamp(ts / 1000, tz=dt.timezone.utc)
        monday = d - dt.timedelta(days=d.weekday())
        mon_mid = dt.datetime(monday.year, monday.month, monday.day, tzinfo=dt.timezone.utc)
        key = int(mon_mid.timestamp() * 1000)
        if key != cur_key:
            if cur_key is not None:
                yield cur_key, o, h, lo, c, v
            cur_key = key
            o, h, lo, c, v = o1, h1, l1, c1, v1
        else:
            if h1 > h:  h = h1
            if l1 < lo: lo = l1
            c = c1
            v += v1
    if cur_key is not None:
        yield cur_key, o, h, lo, c, v


def _resample_month(
    sorted_bars: list[tuple[int, float, float, float, float, float]],
) -> Iterator[tuple[int, float, float, float, float, float]]:
    cur_key = None
    o = h = lo = c = 0.0; v = 0.0
    for ts, o1, h1, l1, c1, v1 in sorted_bars:
        d = dt.datetime.fromtimestamp(ts / 1000, tz=dt.timezone.utc)
        first = dt.datetime(d.year, d.month, 1, tzinfo=dt.timezone.utc)
        key = int(first.timestamp() * 1000)
        if key != cur_key:
            if cur_key is not None:
                yield cur_key, o, h, lo, c, v
            cur_key = key
            o, h, lo, c, v = o1, h1, l1, c1, v1
        else:
            if h1 > h:  h = h1
            if l1 < lo: lo = l1
            c = c1
            v += v1
    if cur_key is not None:
        yield cur_key, o, h, lo, c, v


def _write_bars(path: pathlib.Path, bars: Iterator[tuple[int, float, float, float, float, float]]) -> int:
    n = 0
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        for row in bars:
            w.writerow(row)
            n += 1
    return n


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("src_dir", help="Path to XAUUSD/M5 directory containing YYYY.json files.")
    p.add_argument("--symbol", default="XAUUSD_EVTL",
                   help="Symbol to store under. Keep DIFFERENT from other XAUUSD sources "
                        "so each source's TF ladder stays self-consistent.")
    p.add_argument("--price", choices=("mid", "bid", "ask"), default="mid",
                   help="Which side of the book to store. mid = (bid+ask)/2 (default).")
    p.add_argument("--mode", choices=("replace", "merge"), default="replace",
                   help="replace: overwrite <symbol>_5m.csv. merge: union with existing.")
    p.add_argument("--skip-resample", action="store_true",
                   help="Don't rewrite the 15m/1h/4h/1d/1w/1mo derivatives.")
    args = p.parse_args()

    src = pathlib.Path(args.src_dir).expanduser().resolve()
    if not src.is_dir():
        print(f"source directory not found: {src}", file=sys.stderr); return 2

    year_files = sorted(src.glob("*.json"))
    if not year_files:
        print(f"no *.json year files under {src}", file=sys.stderr); return 2

    FOREX_DIR.mkdir(parents=True, exist_ok=True)
    dst_5m = FOREX_DIR / f"{args.symbol}_5m.csv"

    print(f"src        : {src}")
    print(f"year files : {len(year_files)}  ({year_files[0].stem} … {year_files[-1].stem})")
    print(f"symbol     : {args.symbol}")
    print(f"price      : {args.price}")
    print(f"mode       : {args.mode}")
    print(f"output dir : {FOREX_DIR.relative_to(REPO_ROOT)}\n")

    new_rows: dict[int, tuple[float, float, float, float, float]] = {}
    total = 0
    for yf in year_files:
        n = 0
        for ts, o, h, lo, c, v in _iter_year(yf, args.price):
            new_rows[ts] = (o, h, lo, c, v)
            n += 1
        print(f"  ✓ {yf.name}  {n:>7,} rows")
        total += n
    print(f"\nparsed {total:,} rows, {len(new_rows):,} unique timestamps")

    if args.mode == "merge":
        existing = _load_existing(dst_5m)
        print(f"existing {dst_5m.name}: {len(existing):,} rows")
        merged = existing | new_rows
        print(f"merged  : {len(merged):,} rows")
    else:
        merged = new_rows

    print(f"\n→ writing {dst_5m.name}…")
    n = _write_canonical(dst_5m, merged)
    print(f"  ✓ {n:,} rows")

    _update_meta_source(
        FOREX_DIR, args.symbol, "5m",
        exchange=f"evtradelabs XAUUSD ({args.price} price)",
        description="Gold (spot) vs US Dollar — evtradelabs M5 archive",
    )

    if not args.skip_resample:
        sorted_5m = [(ts, *v) for ts, v in sorted(merged.items())]
        print(f"\n→ resampling to coarser TFs (single-pass from 5m)…")
        for tf, bucket in _MINUTE_TFS.items():
            path = FOREX_DIR / f"{args.symbol}_{_tf_suffix(tf)}.csv"
            n = _write_bars(path, _resample_minute(sorted_5m, bucket))
            print(f"  ✓ {tf:>4}  {n:>10,} rows  →  {path.name}")
            _update_meta_source(
                FOREX_DIR, args.symbol, tf,
                exchange=f"evtradelabs XAUUSD ({args.price}), resampled from 5m",
                description="Derived from evtradelabs 5m at import time",
            )

        for tf, resampler in (("1w", _resample_week), ("1M", _resample_month)):
            path = FOREX_DIR / f"{args.symbol}_{_tf_suffix(tf)}.csv"
            n = _write_bars(path, resampler(sorted_5m))
            print(f"  ✓ {tf:>4}  {n:>10,} rows  →  {path.name}")
            _update_meta_source(
                FOREX_DIR, args.symbol, tf,
                exchange=f"evtradelabs XAUUSD ({args.price}), resampled from 5m",
                description="Derived from evtradelabs 5m at import time",
            )

    print(f"\n→ rebuilding manifest…")
    _rebuild_manifest(MARKETS_ROOT, repo_root=REPO_ROOT)

    print(f"\nDone. Refresh browser → Chart Picker → forex → {args.symbol} → any TF.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
