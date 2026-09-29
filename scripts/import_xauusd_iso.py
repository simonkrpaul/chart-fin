#!/usr/bin/env python3
"""
import_xauusd_iso.py
──────────────────────────────────────────────────────────────────────────────
Importer for the ISO-timestamp XAUUSD 1-minute CSV format:

    timestamp,Open,High,Low,Close
    2020-04-06 06:40:00+00:00,1626.83997,1628.030029,1626.83997,1627.89001

Contrasts with:
  - `import_kaggle_xauusd.py` — Metatrader (semicolon + dotted-date + Volume)
  - `import_market.py`        — already-canonical `timestamp,open,high,low,close,volume`

Pipeline:
  1. Stream-parse the source, convert timestamps to Unix ms UTC, set volume=0.
  2. Merge (or replace) with existing XAUUSD_1m.csv.
     Merge: union of timestamps; on collision the new row wins.
  3. Resample the 1m stream to 5m, 15m, 1h, 4h, 1d, 1w, 1mo canonical CSVs.
  4. Rewrite XAUUSD.meta.json and rebuild manifest.json.

Usage
─────
  # Replace (default): overwrite existing XAUUSD_1m.csv with this file's bars.
  python scripts/import_xauusd_iso.py "~/Downloads/xauusd_1min.csv"

  # Merge (recommended if the file only covers 2020-onward and you want to
  # keep the older Kaggle history): union timestamps, new wins on collision.
  python scripts/import_xauusd_iso.py "~/Downloads/xauusd_1min.csv" --mode merge
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import pathlib
import sys
from collections import defaultdict
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

# ── Resample targets (all coarser than 1m) ─────────────────────────────────
# Bucket size in minutes for TFs that are pure minute-multiples. 1w and 1mo
# are handled with calendar arithmetic below.
_MINUTE_TFS: dict[str, int] = {
    "5m":  5,
    "15m": 15,
    "1h":  60,
    "4h":  240,
    "1d":  60 * 24,
}


def _iter_source(src: pathlib.Path) -> Iterator[tuple[int, float, float, float, float, float]]:
    """Yield (ts_ms, o, h, l, c, v) tuples. Volume forced to 0 (absent)."""
    with src.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader, None)
        if header is None or len(header) < 5:
            raise SystemExit(f"source has no header: {src}")
        for row in reader:
            if len(row) < 5:
                continue
            try:
                ts = int(dt.datetime.fromisoformat(row[0]).timestamp() * 1000)
                o = float(row[1]); h = float(row[2])
                lo = float(row[3]); c = float(row[4])
            except (ValueError, KeyError):
                continue
            yield ts, o, h, lo, c, 0.0


def _load_existing_1m(path: pathlib.Path) -> dict[int, tuple[float, float, float, float, float]]:
    """Load the existing canonical 1m file into {ts: (o,h,l,c,v)}. Empty on miss."""
    if not path.exists():
        return {}
    out: dict[int, tuple[float, float, float, float, float]] = {}
    with path.open("r", encoding="utf-8", newline="") as fh:
        r = csv.reader(fh)
        next(r, None)  # header
        for row in r:
            if len(row) < 6:
                continue
            try:
                ts = int(row[0])
                o = float(row[1]); h = float(row[2])
                lo = float(row[3]); c = float(row[4]); v = float(row[5])
            except ValueError:
                continue
            out[ts] = (o, h, lo, c, v)
    return out


def _write_canonical_1m(path: pathlib.Path, merged: dict[int, tuple[float, float, float, float, float]]) -> int:
    """Write {ts: (o,h,l,c,v)} sorted by ts to path. Returns row count."""
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        for ts in sorted(merged):
            o, h, lo, c, v = merged[ts]
            w.writerow([ts, o, h, lo, c, v])
    return len(merged)


# ── Resampling (single pass per target) ────────────────────────────────────

def _resample_minute(
    sorted_1m: list[tuple[int, float, float, float, float, float]],
    bucket_min: int,
) -> Iterator[tuple[int, float, float, float, float, float]]:
    """Fixed-minute bucket resample. Buckets align to UTC epoch boundaries."""
    bucket_ms = bucket_min * 60_000
    cur_key = None
    o = h = lo = c = 0.0
    v = 0.0
    for ts, o1, h1, l1, c1, v1 in sorted_1m:
        key = (ts // bucket_ms) * bucket_ms
        if key != cur_key:
            if cur_key is not None:
                yield cur_key, o, h, lo, c, v
            cur_key = key
            o, h, lo, c, v = o1, h1, l1, c1, v1
        else:
            if h1 > h: h = h1
            if l1 < lo: lo = l1
            c = c1
            v += v1
    if cur_key is not None:
        yield cur_key, o, h, lo, c, v


def _resample_week(
    sorted_1m: list[tuple[int, float, float, float, float, float]],
) -> Iterator[tuple[int, float, float, float, float, float]]:
    """ISO-week bucket. Bucket key = Unix ms of the Monday 00:00 UTC of that week."""
    cur_key = None
    o = h = lo = c = 0.0; v = 0.0
    for ts, o1, h1, l1, c1, v1 in sorted_1m:
        d = dt.datetime.fromtimestamp(ts / 1000, tz=dt.timezone.utc)
        monday = d - dt.timedelta(days=d.weekday())
        monday_mid = dt.datetime(monday.year, monday.month, monday.day, tzinfo=dt.timezone.utc)
        key = int(monday_mid.timestamp() * 1000)
        if key != cur_key:
            if cur_key is not None:
                yield cur_key, o, h, lo, c, v
            cur_key = key
            o, h, lo, c, v = o1, h1, l1, c1, v1
        else:
            if h1 > h: h = h1
            if l1 < lo: lo = l1
            c = c1
            v += v1
    if cur_key is not None:
        yield cur_key, o, h, lo, c, v


def _resample_month(
    sorted_1m: list[tuple[int, float, float, float, float, float]],
) -> Iterator[tuple[int, float, float, float, float, float]]:
    """Calendar-month bucket. Key = first-of-month 00:00 UTC in ms."""
    cur_key = None
    o = h = lo = c = 0.0; v = 0.0
    for ts, o1, h1, l1, c1, v1 in sorted_1m:
        d = dt.datetime.fromtimestamp(ts / 1000, tz=dt.timezone.utc)
        first = dt.datetime(d.year, d.month, 1, tzinfo=dt.timezone.utc)
        key = int(first.timestamp() * 1000)
        if key != cur_key:
            if cur_key is not None:
                yield cur_key, o, h, lo, c, v
            cur_key = key
            o, h, lo, c, v = o1, h1, l1, c1, v1
        else:
            if h1 > h: h = h1
            if l1 < lo: lo = l1
            c = c1
            v += v1
    if cur_key is not None:
        yield cur_key, o, h, lo, c, v


def _write_bars(
    path: pathlib.Path,
    bars: Iterator[tuple[int, float, float, float, float, float]],
) -> int:
    n = 0
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        for row in bars:
            w.writerow(row)
            n += 1
    return n


def _write_meta(sym: str, wrote_resampled: bool) -> None:
    _update_meta_source(
        FOREX_DIR, sym, "1m",
        exchange="Kaggle + ISO 1m merged",
        description="Gold (spot) vs US Dollar — Kaggle Metatrader + ISO-format 1m feed",
    )
    if wrote_resampled:
        for tf in ("5m", "15m", "1h", "4h", "1d", "1w", "1M"):
            _update_meta_source(
                FOREX_DIR, sym, tf,
                exchange="resampled from 1m",
                description="Derived from the merged 1m file at import time",
            )


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("src", help="Path to xauusd_1min.csv (ISO timestamps, comma-delimited, no volume).")
    p.add_argument("--symbol", default="XAUUSD")
    p.add_argument("--mode", choices=("replace", "merge"), default="replace",
                   help="replace: overwrite existing 1m file. merge: union timestamps, new wins on collision.")
    p.add_argument("--skip-resample", action="store_true",
                   help="Don't rewrite the 5m/15m/1h/4h/1d/1w/1mo derivatives.")
    args = p.parse_args()

    src = pathlib.Path(args.src).expanduser().resolve()
    if not src.exists():
        print(f"source not found: {src}", file=sys.stderr); return 2

    FOREX_DIR.mkdir(parents=True, exist_ok=True)
    dst_1m = FOREX_DIR / f"{args.symbol}_1m.csv"

    print(f"src        : {src}  ({src.stat().st_size/1024/1024:.1f} MB)")
    print(f"symbol     : {args.symbol}")
    print(f"mode       : {args.mode}")
    print(f"output dir : {FOREX_DIR.relative_to(REPO_ROOT)}\n")

    print(f"→ streaming source rows…")
    new_rows: dict[int, tuple[float, float, float, float, float]] = {}
    for ts, o, h, lo, c, v in _iter_source(src):
        new_rows[ts] = (o, h, lo, c, v)
    print(f"  {len(new_rows):,} unique timestamps in source")

    if args.mode == "replace":
        merged = new_rows
    else:
        print(f"→ loading existing {dst_1m.name}…")
        existing = _load_existing_1m(dst_1m)
        print(f"  {len(existing):,} existing rows")
        merged = existing | new_rows  # new wins on collision
        print(f"  merged: {len(merged):,} rows")

    print(f"→ writing {dst_1m.name}…")
    n = _write_canonical_1m(dst_1m, merged)
    print(f"  ✓ {n:,} rows")

    if not args.skip_resample:
        sorted_1m = [(ts, *v) for ts, v in sorted(merged.items())]
        print(f"\n→ resampling to coarser TFs (single-pass)…")
        for tf, bucket in _MINUTE_TFS.items():
            path = FOREX_DIR / f"{args.symbol}_{_tf_suffix(tf)}.csv"
            n = _write_bars(path, _resample_minute(sorted_1m, bucket))
            print(f"  ✓ {tf:>4}  {n:>10,} rows  →  {path.name}")

        path = FOREX_DIR / f"{args.symbol}_{_tf_suffix('1w')}.csv"
        n = _write_bars(path, _resample_week(sorted_1m))
        print(f"  ✓  1w  {n:>10,} rows  →  {path.name}")

        path = FOREX_DIR / f"{args.symbol}_{_tf_suffix('1M')}.csv"
        n = _write_bars(path, _resample_month(sorted_1m))
        print(f"  ✓  1M  {n:>10,} rows  →  {path.name}")

    _write_meta(args.symbol, wrote_resampled=not args.skip_resample)
    print(f"\n→ rebuilding manifest…")
    _rebuild_manifest(MARKETS_ROOT, repo_root=REPO_ROOT)

    print(f"\nDone. Refresh browser → Chart Picker → forex → {args.symbol} → any TF.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
