#!/usr/bin/env python3
"""
fill_gaps.py
────────────────────────────────────────────────────────────────────────────
Detect and repair missing bars in a 1-minute OHLCV CSV.

Two modes
─────────
  --report     Print the list of gaps and exit (no modifications).
  --fill       Rewrite the CSV in place with gaps filled. Supports four
               strategies:
                 forward   – repeat the previous close (default; safest for
                             continuous markets like crypto)
                 linear    – linearly interpolate open/high/low/close across
                             the gap
                 zero_vol  – forward-fill OHLC but set volume=0
                 amend     – read amendments from `--amendments <path.csv>`
                             (columns: timestamp,open,high,low,close,volume)
                             and merge them into the target series.

Session-aware filtering
───────────────────────
  For weekday-only markets you don't want to invent bars over weekends /
  holidays. Pass `--session <preset>` where preset is one of:
    crypto | us_equity | us_futures | forex | asx | lse
  and the script will only fill gaps that fall inside that session.

Usage
─────
  # Report gaps in the Bybit 1m file
  python scripts/fill_gaps.py --report public/data/bybit_btcusdt_1m.csv

  # Fill continuous crypto file with forward-fill
  python scripts/fill_gaps.py --fill forward --session crypto \\
      public/data/bybit_btcusdt_1m.csv

  # Amend a US equity series with manual corrections
  python scripts/fill_gaps.py --fill amend \\
      --amendments corrections.csv \\
      --session us_equity \\
      public/data/markets/us_equity/MOCKSPY_1m.csv
"""
from __future__ import annotations

import argparse
import csv
import pathlib
import sys
from datetime import datetime, timezone
try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    from backports.zoneinfo import ZoneInfo  # type: ignore

ONE_MIN_MS = 60_000

# ── Session presets ────────────────────────────────────────────────────────

SESSIONS = {
    "crypto":     {"tz": "UTC",                "days": {1,2,3,4,5,6,7}, "open": (0, 0),  "close": (23, 59)},
    "us_equity":  {"tz": "America/New_York",   "days": {1,2,3,4,5},     "open": (9, 30), "close": (16, 0)},
    "us_futures": {"tz": "America/Chicago",    "days": {1,2,3,4,5,7},   "open": (17, 0), "close": (16, 0)},
    "asx":        {"tz": "Australia/Sydney",   "days": {1,2,3,4,5},     "open": (10, 0), "close": (16, 0)},
    "lse":        {"tz": "Europe/London",      "days": {1,2,3,4,5},     "open": (8, 0),  "close": (16, 30)},
    "forex":      {"tz": "UTC",                "days": {1,2,3,4,5,7},   "open": (0, 0),  "close": (23, 59)},
}


def in_session(ts_ms: int, session: dict | None) -> bool:
    if session is None:
        return True
    d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    if session["tz"] == "UTC" and set(session["days"]) == {1,2,3,4,5,7} and session["open"] == (0,0):
        # Forex special case
        wd = d.isoweekday()
        if wd == 6: return False
        if wd == 7 and d.hour < 22: return False
        if wd == 5 and d.hour >= 22: return False
        return True

    local = d.astimezone(ZoneInfo(session["tz"]))
    if local.isoweekday() not in session["days"]:
        return False
    oh, om = session["open"]; ch, cm = session["close"]
    now_min = local.hour * 60 + local.minute
    return oh * 60 + om <= now_min < ch * 60 + cm

# ── CSV IO ─────────────────────────────────────────────────────────────────

REQUIRED_COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"]


def load_rows(path: pathlib.Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            try:
                rows.append({
                    "timestamp": int(float(r["timestamp"])),
                    "open":  float(r["open"]),
                    "high":  float(r["high"]),
                    "low":   float(r["low"]),
                    "close": float(r["close"]),
                    "volume": float(r.get("volume", 0.0) or 0.0),
                })
            except (KeyError, TypeError, ValueError):
                continue
    rows.sort(key=lambda r: r["timestamp"])
    return rows


def save_rows(path: pathlib.Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        f.write(",".join(REQUIRED_COLUMNS) + "\n")
        for r in rows:
            f.write(
                f'{r["timestamp"]},{r["open"]:.6f},{r["high"]:.6f},{r["low"]:.6f},{r["close"]:.6f},{r["volume"]:.4f}\n'
            )

# ── Gap detection ──────────────────────────────────────────────────────────

def find_gaps(rows: list[dict], session: dict | None) -> list[tuple[int, int]]:
    """Return list of (gap_start_ts, gap_end_ts) where at least one 1m bar is missing."""
    gaps: list[tuple[int, int]] = []
    for i in range(1, len(rows)):
        prev = rows[i - 1]["timestamp"]
        curr = rows[i]["timestamp"]
        if curr - prev <= ONE_MIN_MS:
            continue
        # Enumerate missing minutes; keep only those inside session.
        cursor = prev + ONE_MIN_MS
        start_missing: int | None = None
        while cursor < curr:
            if in_session(cursor, session):
                if start_missing is None:
                    start_missing = cursor
                last_missing = cursor
            else:
                if start_missing is not None:
                    gaps.append((start_missing, last_missing))
                    start_missing = None
            cursor += ONE_MIN_MS
        if start_missing is not None:
            gaps.append((start_missing, last_missing))
    return gaps

# ── Fill strategies ────────────────────────────────────────────────────────

def fill_forward(rows: list[dict], gaps: list[tuple[int, int]], zero_vol: bool = False) -> list[dict]:
    if not gaps:
        return rows
    by_ts = {r["timestamp"]: r for r in rows}
    for start_ts, end_ts in gaps:
        prev_row = _last_row_before(rows, start_ts)
        if prev_row is None:
            continue
        ts = start_ts
        while ts <= end_ts:
            by_ts[ts] = {
                "timestamp": ts,
                "open":  prev_row["close"],
                "high":  prev_row["close"],
                "low":   prev_row["close"],
                "close": prev_row["close"],
                "volume": 0.0 if zero_vol else prev_row["volume"],
            }
            ts += ONE_MIN_MS
    return sorted(by_ts.values(), key=lambda r: r["timestamp"])


def fill_linear(rows: list[dict], gaps: list[tuple[int, int]]) -> list[dict]:
    if not gaps:
        return rows
    by_ts = {r["timestamp"]: r for r in rows}
    for start_ts, end_ts in gaps:
        prev_row = _last_row_before(rows, start_ts)
        next_row = _first_row_after(rows, end_ts)
        if prev_row is None or next_row is None:
            continue
        span = next_row["timestamp"] - prev_row["timestamp"]
        ts = start_ts
        while ts <= end_ts:
            r = (ts - prev_row["timestamp"]) / span
            c = prev_row["close"] + (next_row["close"] - prev_row["close"]) * r
            by_ts[ts] = {
                "timestamp": ts,
                "open":  c, "high": c, "low": c, "close": c, "volume": 0.0,
            }
            ts += ONE_MIN_MS
    return sorted(by_ts.values(), key=lambda r: r["timestamp"])


def fill_from_amendments(rows: list[dict], amendments: list[dict]) -> list[dict]:
    by_ts = {r["timestamp"]: r for r in rows}
    for a in amendments:
        by_ts[a["timestamp"]] = a
    return sorted(by_ts.values(), key=lambda r: r["timestamp"])


def _last_row_before(rows: list[dict], ts: int) -> dict | None:
    lo, hi = 0, len(rows) - 1
    result: dict | None = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if rows[mid]["timestamp"] < ts:
            result = rows[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    return result


def _first_row_after(rows: list[dict], ts: int) -> dict | None:
    lo, hi = 0, len(rows) - 1
    result: dict | None = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if rows[mid]["timestamp"] > ts:
            result = rows[mid]
            hi = mid - 1
        else:
            lo = mid + 1
    return result

# ── CLI ────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("path", type=pathlib.Path)
    p.add_argument("--report", action="store_true", help="Report gaps and exit")
    p.add_argument("--fill", choices=["forward", "linear", "zero_vol", "amend"],
                   help="Fill strategy")
    p.add_argument("--session", choices=list(SESSIONS.keys()),
                   help="Only detect/fill gaps inside this session")
    p.add_argument("--amendments", type=pathlib.Path,
                   help="Amendment CSV for --fill amend")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    if not args.path.exists():
        sys.exit(f"file not found: {args.path}")

    session = SESSIONS.get(args.session) if args.session else None
    rows = load_rows(args.path)
    if not rows:
        sys.exit("no rows loaded")

    gaps = find_gaps(rows, session)
    print(f"Loaded {len(rows):,} rows · detected {len(gaps)} gap(s)")

    total_missing = 0
    for i, (s, e) in enumerate(gaps[:20]):
        s_iso = datetime.fromtimestamp(s / 1000, tz=timezone.utc).isoformat()
        e_iso = datetime.fromtimestamp(e / 1000, tz=timezone.utc).isoformat()
        span_min = (e - s) // ONE_MIN_MS + 1
        total_missing += span_min
        print(f"  gap {i+1:>3}: {s_iso} → {e_iso}  ({span_min} min)")
    if len(gaps) > 20:
        remaining = sum(((e - s) // ONE_MIN_MS + 1) for s, e in gaps[20:])
        total_missing += remaining
        print(f"  … and {len(gaps) - 20} more gap(s), {remaining} extra missing minutes")
    print(f"  total missing minutes: {total_missing:,}")

    if args.report or not args.fill:
        return

    if args.fill == "forward":
        rows = fill_forward(rows, gaps, zero_vol=False)
    elif args.fill == "zero_vol":
        rows = fill_forward(rows, gaps, zero_vol=True)
    elif args.fill == "linear":
        rows = fill_linear(rows, gaps)
    elif args.fill == "amend":
        if not args.amendments or not args.amendments.exists():
            sys.exit("--fill amend requires --amendments <file>")
        amendments = load_rows(args.amendments)
        rows = fill_from_amendments(rows, amendments)

    save_rows(args.path, rows)
    print(f"✓ wrote {len(rows):,} rows to {args.path}")


if __name__ == "__main__":
    main()
