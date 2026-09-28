#!/usr/bin/env python3
"""
import_kaggle_xauusd.py
─────────────────────────────────────────────────────────────────────────────
One-shot importer for the Kaggle "XAUUSD Gold" dataset (Metatrader export
schema with semicolon delimiters and dotted-date timestamps).

Source layout (as shipped by Kaggle):
    XAU_1m_data.csv        Date;Open;High;Low;Close;Volume
    XAU_5m_data.csv        rows like: 2004.06.11 07:18;384;384.1;384;384;3
    XAU_15m_data.csv
    XAU_30m_data.csv       ← skipped (not a chart-fin timeframe)
    XAU_1h_data.csv
    XAU_4h_data.csv
    XAU_1d_data.csv
    XAU_1w_data.csv
    XAU_1Month_data.csv

Output layout (chart-fin manifest-ready):
    public/data/markets/forex/XAUUSD_1m.csv
    public/data/markets/forex/XAUUSD_5m.csv
    public/data/markets/forex/XAUUSD_15m.csv
    public/data/markets/forex/XAUUSD_1h.csv
    public/data/markets/forex/XAUUSD_4h.csv
    public/data/markets/forex/XAUUSD_1d.csv
    public/data/markets/forex/XAUUSD_1w.csv
    public/data/markets/forex/XAUUSD_1M.csv
    public/data/markets/forex/XAUUSD.meta.json
    public/data/markets/manifest.json  ← rebuilt at end

Column format (all output files):
    timestamp,open,high,low,close,volume
    timestamp: Unix milliseconds UTC

Usage
─────
    python scripts/import_kaggle_xauusd.py "~/Downloads/archive (9)"

    # If the source timestamps are in a broker timezone (common: EET,
    # UTC+2 or UTC+3 depending on DST), pass --tz to correct them:
    python scripts/import_kaggle_xauusd.py "~/Downloads/archive (9)" --tz EET

    # Skip files that would produce an identical output (default: skip)
    python scripts/import_kaggle_xauusd.py "~/Downloads/archive (9)" --mode overwrite

    # Custom symbol name (default XAUUSD)
    python scripts/import_kaggle_xauusd.py "~/Downloads/archive (9)" --symbol XAGUSD

Loading into chart-fin
──────────────────────
    1. Refresh the browser (⌘R).
    2. Open Chart Picker → click ↻ Rescan disk if it's already open.
    3. Under 'forex' → pick XAUUSD → chart opens (single CSV fetch).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import pathlib
import sys
from typing import Iterator

try:
    from zoneinfo import ZoneInfo
except ImportError:
    print("Python 3.9+ required (zoneinfo).", file=sys.stderr)
    sys.exit(1)

# ── Paths ──────────────────────────────────────────────────────────────────
REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKETS_ROOT = REPO_ROOT / "public" / "data" / "markets"
FOREX_DIR = MARKETS_ROOT / "forex"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
try:
    from _manifest import (  # noqa: E402
        rebuild_manifest as _rebuild_manifest,
        tf_to_filename_suffix as _tf_to_filename_suffix,
    )
except ImportError:
    _rebuild_manifest = None  # type: ignore[assignment]
    def _tf_to_filename_suffix(tf: str) -> str:  # local fallback
        return "1mo" if tf == "1M" else tf

# ── TF map: Kaggle filename fragment → chart-fin TF code ───────────────────
TF_MAP: dict[str, str | None] = {
    "1m":     "1m",
    "5m":     "5m",
    "15m":    "15m",
    "30m":    None,       # not in chart-fin's TIMEFRAME_MINUTES; skipped
    "1h":     "1h",
    "4h":     "4h",
    "1d":     "1d",
    "1w":     "1w",
    "1Month": "1M",
}

# ── Row conversion ─────────────────────────────────────────────────────────

def _parse_dotted_ts(raw: str, tz: dt.tzinfo) -> int:
    """`2004.06.11 07:18` → Unix ms UTC."""
    # Normalise: dots → dashes for the date part.
    date_part, _, time_part = raw.strip().partition(" ")
    y, m, d = date_part.split(".")
    hh, mm = time_part.split(":") if time_part else ("00", "00")
    naive = dt.datetime(int(y), int(m), int(d), int(hh), int(mm), tzinfo=tz)
    return int(naive.astimezone(dt.timezone.utc).timestamp() * 1000)


def _iter_rows(src_path: pathlib.Path, tz: dt.tzinfo) -> Iterator[dict]:
    """Yield canonical dicts from a Kaggle-format CSV."""
    with src_path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh, delimiter=";")
        for row in reader:
            date_raw = row.get("Date") or row.get("date") or row.get("Time") or row.get("time")
            if not date_raw:
                continue
            try:
                ts_ms = _parse_dotted_ts(date_raw, tz)
            except (ValueError, KeyError):
                continue
            try:
                o = float(row["Open"]); h = float(row["High"])
                lo = float(row["Low"]); c = float(row["Close"])
                v = float(row.get("Volume", "0") or 0)
            except (KeyError, ValueError):
                continue
            yield {
                "timestamp": ts_ms,
                "open": o, "high": h, "low": lo, "close": c, "volume": v,
            }


def _write_canonical(dst: pathlib.Path, rows: Iterator[dict]) -> int:
    """Stream rows straight to disk. Assumes source is chronologically
    ordered (Kaggle files are). Deduplicates only against the immediately-
    preceding row to keep memory O(1) even on ~500 MB source files.
    """
    n = 0
    last_ts = -1
    with dst.open("w", encoding="utf-8", newline="") as out:
        w = csv.writer(out)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        for r in rows:
            ts = r["timestamp"]
            if ts <= last_ts:
                continue
            w.writerow([ts, r["open"], r["high"], r["low"], r["close"], r["volume"]])
            last_ts = ts
            n += 1
    return n

# ── Meta ────────────────────────────────────────────────────────────────────

def _write_meta(sym: str) -> None:
    import json
    meta = {
        "exchange": "Kaggle Gold XAUUSD (Metatrader)",
        "description": "Gold (spot) vs US Dollar",
        "sector": "Metals",
        "industry": "Spot",
    }
    (FOREX_DIR / f"{sym}.meta.json").write_text(json.dumps(meta, indent=2))

# ── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(
        description="Import a Kaggle XAUUSD Metatrader dump into chart-fin.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("src_dir", help="Directory containing XAU_<TF>_data.csv files.")
    p.add_argument("--symbol", default="XAUUSD",
                   help="Symbol to store under (goes into <symbol>_<tf>.csv).")
    p.add_argument("--tz", default="UTC",
                   help="Timezone of the source timestamps. Kaggle FX dumps are often "
                        "UTC or broker time (EET). Use IANA name like 'UTC' or 'EET'.")
    p.add_argument("--mode", choices=("skip", "overwrite"), default="skip",
                   help="skip: leave existing output files alone. overwrite: replace them.")
    p.add_argument("--rebuild-manifest-only", action="store_true",
                   help="Skip import and just rebuild manifest.json from files on disk.")
    args = p.parse_args()

    if args.rebuild_manifest_only:
        if _rebuild_manifest is None:
            print("_manifest.py not importable — cannot rebuild manifest.", file=sys.stderr)
            return 2
        _rebuild_manifest(MARKETS_ROOT, repo_root=REPO_ROOT)
        return 0

    src_dir = pathlib.Path(args.src_dir).expanduser().resolve()
    if not src_dir.is_dir():
        print(f"source directory not found: {src_dir}", file=sys.stderr)
        return 2

    try:
        tz = ZoneInfo(args.tz)
    except Exception as e:
        print(f"invalid --tz {args.tz!r}: {e}", file=sys.stderr)
        return 2

    FOREX_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Source dir  : {src_dir}")
    print(f"Symbol      : {args.symbol}")
    print(f"Timezone    : {args.tz}  (source timestamps interpreted in this tz, converted to UTC)")
    print(f"Mode        : {args.mode}")
    print(f"Output dir  : {FOREX_DIR.relative_to(REPO_ROOT)}")
    print()

    processed = 0
    for src_name in sorted(src_dir.glob("XAU_*_data.csv")):
        # Extract the TF fragment: "XAU_1m_data.csv" → "1m"
        stem = src_name.stem  # "XAU_1m_data"
        parts = stem.split("_")
        if len(parts) < 3:
            continue
        tf_fragment = parts[1]
        tf = TF_MAP.get(tf_fragment)
        if tf is None:
            print(f"  ↷ skipping {src_name.name} (unsupported TF {tf_fragment!r})")
            continue

        dst = FOREX_DIR / f"{args.symbol}_{_tf_to_filename_suffix(tf)}.csv"
        if dst.exists() and args.mode == "skip":
            print(f"  ↷ skipping {src_name.name} → {dst.name} already exists (use --mode overwrite)")
            continue

        print(f"  → {src_name.name}  ({src_name.stat().st_size / (1024*1024):.1f} MB)")
        rows = _iter_rows(src_name, tz)
        n = _write_canonical(dst, rows)
        print(f"    ✓ {dst.relative_to(REPO_ROOT)}  ({n:,} rows)")
        processed += 1

    if processed == 0:
        print("Nothing to import. Are the XAU_<TF>_data.csv files in that directory?")
        return 1

    _write_meta(args.symbol)
    print(f"  ✓ {args.symbol}.meta.json")

    if _rebuild_manifest is not None:
        _rebuild_manifest(MARKETS_ROOT, repo_root=REPO_ROOT)
        print("  ✓ manifest.json rebuilt.")
    else:
        print("  ! _manifest.py not found — manifest NOT rebuilt.")

    print(f"\nDone. Refresh browser → open Chart Picker → forex → {args.symbol} → any TF.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
