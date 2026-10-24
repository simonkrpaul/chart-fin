#!/usr/bin/env python3
r"""
import_daily_csv.py
────────────────────────────────────────────────────────────────────────────
Import daily (or weekly / monthly) OHLC exports (.csv or .txt) — e.g. a DJIA
history file — into chart-fin's market layout, merging with what is already stored.
Step-by-step guide: docs/data-ingestion.md, section 10.

Writes `public/data/markets/<market>/<SYMBOL>_<tf>.csv` with ISO dates
(`YYYY-MM-DD`, safe for history before 1970), updates `<SYMBOL>.meta.json`
and rebuilds `manifest.json`. Re-run it whenever you have a fresh export.

Input files
  • Header row with Date, Open, High, Low, Close and optionally Volume
    (any order, any case). An unnamed column after Close is read as volume.
  • Dates as MM/DD/YYYY (default), YYYY-MM-DD, or DD/MM/YYYY (--date-format dmy).
  • Several files may be given; later files win on the same date. Use this to
    patch gaps, e.g. a second export that covers only the missing period.

Merge rules (--mode)
  merge   (default) keep stored rows, add new dates, overwrite dates present
          in the input (amends corrected values).
  replace store exactly what the input files contain.

Examples — macOS / Linux (Terminal)
  python3 scripts/import_daily_csv.py ~/Downloads/Dow_1885_new.txt --market us_equity --symbol DJIA --dry-run
  python3 scripts/import_daily_csv.py ~/Downloads/Dow_1885_new.txt --market us_equity --symbol DJIA

Examples — Windows (PowerShell, from the chart-fin folder)
  python scripts\import_daily_csv.py "$HOME\Downloads\Dow_1885_new.txt" --market us_equity --symbol DJIA --dry-run
  python scripts\import_daily_csv.py "$HOME\Downloads\Dow_1885_new.txt" --market us_equity --symbol DJIA

  Command Prompt: use "%USERPROFILE%\Downloads\Dow_1885_new.txt" instead of "$HOME\...".

Patch a gap or wrong days with a second file (later files win on the same date):
  python3 scripts/import_daily_csv.py ~/Downloads/Dow_1885_new.txt ~/Downloads/dow_fixes.txt --market us_equity --symbol DJIA
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import os
import pathlib
import re
import sys
from typing import Tuple

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKETS_DIR = REPO_ROOT / "public" / "data" / "markets"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _manifest import rebuild_manifest, tf_to_filename_suffix, update_meta_source  # noqa: E402

DATE_FORMATS = {
    "mdy": ["%m/%d/%Y", "%Y-%m-%d"],
    "dmy": ["%d/%m/%Y", "%Y-%m-%d"],
    "ymd": ["%Y-%m-%d", "%Y/%m/%d"],
}
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")

Bar = Tuple[float, float, float, float, float]


def parse_date(text: str, formats: list[str]) -> dt.date | None:
    for fmt in formats:
        try:
            return dt.datetime.strptime(text.strip(), fmt).date()
        except ValueError:
            continue
    return None


def parse_number(text: str) -> float:
    return float(text.strip().replace(",", "").replace("$", ""))


def find_columns(header: list[str]) -> dict[str, int]:
    names = [h.strip().lower() for h in header]

    def idx(*aliases: str) -> int:
        for a in aliases:
            if a in names:
                return names.index(a)
        return -1

    cols = {
        "date": idx("date", "timestamp", "time", "datetime"),
        "open": idx("open", "o"),
        "high": idx("high", "h"),
        "low": idx("low", "l"),
        "close": idx("close", "c", "adj close"),
        "volume": idx("volume", "vol", "v"),
    }
    missing = [k for k in ("date", "open", "high", "low", "close") if cols[k] < 0]
    if missing:
        raise SystemExit(f"Missing column(s): {', '.join(missing)} — header was {header}")
    if cols["volume"] < 0:
        unnamed = [i for i, n in enumerate(names) if n == "" and i > cols["close"]]
        if unnamed:
            cols["volume"] = unnamed[0]
    return cols


def read_input(path: pathlib.Path, formats: list[str]) -> tuple[dict[dt.date, Bar], list[str]]:
    bars: dict[dt.date, Bar] = {}
    problems: list[str] = []
    with path.open(newline="", encoding="utf-8-sig") as f:
        rows = csv.reader(f)
        header = next(rows, None)
        if not header:
            raise SystemExit(f"{path}: empty file")
        cols = find_columns(header)
        for line_no, row in enumerate(rows, start=2):
            if not row or not "".join(row).strip():
                continue
            try:
                day = parse_date(row[cols["date"]], formats)
                if day is None:
                    raise ValueError("unrecognised date")
                o, h, l, c = (parse_number(row[cols[k]]) for k in ("open", "high", "low", "close"))
                vol_text = row[cols["volume"]] if 0 <= cols["volume"] < len(row) else ""
                v = parse_number(vol_text) if vol_text.strip() else 0.0
            except (ValueError, IndexError) as exc:
                problems.append(f"{path.name}:{line_no} skipped ({exc}): {','.join(row)}")
                continue
            if h < max(o, c) or l > min(o, c) or min(o, h, l, c) <= 0:
                problems.append(f"{path.name}:{line_no} skipped (inconsistent OHLC): {','.join(row)}")
                continue
            bars[day] = (o, h, l, c, v)
    return bars, problems


def read_existing(path: pathlib.Path) -> dict[dt.date, Bar]:
    if not path.exists():
        return {}
    bars: dict[dt.date, Bar] = {}
    with path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            ts = row["timestamp"]
            if re.fullmatch(r"-?\d+", ts):
                day = dt.datetime.fromtimestamp(int(ts) / 1000, dt.timezone.utc).date()
            else:
                day = dt.date.fromisoformat(ts[:10])
            bars[day] = tuple(float(row[k] or 0) for k in ("open", "high", "low", "close", "volume"))  # type: ignore[assignment]
    return bars


def report_gaps(days: list[dt.date], gap_days: int) -> list[str]:
    return [
        f"{a} → {b} ({(b - a).days} days, no data in between)"
        for a, b in zip(days, days[1:])
        if (b - a).days > gap_days
    ]


def main() -> None:
    # Windows consoles / redirected output may not be UTF-8; never crash on a report character.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("inputs", nargs="+", type=pathlib.Path, help="CSV export(s); later files win on the same date")
    p.add_argument("--market", required=True, help="chart-fin market id, e.g. us_equity, asx, forex")
    p.add_argument("--symbol", required=True, help="Symbol to store under, e.g. DJIA")
    p.add_argument("--timeframe", default="1d", choices=["1d", "1w", "1M"])
    p.add_argument("--date-format", default="mdy", choices=sorted(DATE_FORMATS))
    p.add_argument("--mode", default="merge", choices=["merge", "replace"])
    p.add_argument("--gap-days", type=int, default=10, help="Report calendar gaps longer than this (default 10)")
    p.add_argument("--exchange", default=None, help="Source label shown in the chart picker")
    p.add_argument("--description", default=None)
    p.add_argument("--dry-run", action="store_true", help="Validate and report only; write nothing")
    args = p.parse_args()

    for name in (args.market, args.symbol):
        if not SAFE_NAME.match(name):
            raise SystemExit(f"Invalid name {name!r}: use letters, digits, '.', '_' or '-'")

    market_dir = MARKETS_DIR / args.market
    out_path = market_dir / f"{args.symbol}_{tf_to_filename_suffix(args.timeframe)}.csv"
    formats = DATE_FORMATS[args.date_format]

    existing = read_existing(out_path) if args.mode == "merge" else {}
    incoming: dict[dt.date, Bar] = {}
    problems: list[str] = []
    for path in args.inputs:
        path = path.expanduser()
        if not path.exists():
            raise SystemExit(f"Input not found: {path}")
        bars, issues = read_input(path, formats)
        print(f"[read] {path}: {len(bars):,} valid rows, {len(issues)} skipped")
        incoming.update(bars)
        problems.extend(issues)

    added = sum(1 for d in incoming if d not in existing)
    changed = sum(1 for d, b in incoming.items() if d in existing and existing[d] != b)
    merged = {**existing, **incoming}
    days = sorted(merged)

    print(f"[plan] {args.market}/{args.symbol} {args.timeframe} · mode={args.mode} · "
          f"stored before={len(existing):,} · new dates={added:,} · amended={changed:,} · total={len(days):,}")
    if days:
        print(f"[range] {days[0]} → {days[-1]}")
    for msg in problems:
        print(f"[skip] {msg}")
    gaps = report_gaps(days, args.gap_days)
    for msg in gaps:
        print(f"[gap] {msg}")

    if args.dry_run:
        print("[dry-run] nothing written")
        return
    if not days:
        raise SystemExit("No valid rows — nothing written")

    market_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        for d in days:
            w.writerow([d.isoformat(), *(f"{x:.15g}" for x in merged[d])])
    os.replace(tmp, out_path)

    update_meta_source(
        market_dir, args.symbol, args.timeframe,
        exchange=args.exchange or f"CSV import ({', '.join(p.name for p in args.inputs)})",
        description=args.description,
    )
    rebuild_manifest(MARKETS_DIR, repo_root=REPO_ROOT, quiet=True)
    print(f"[done] wrote {out_path.relative_to(REPO_ROOT)} ({len(days):,} rows) and rebuilt the manifest")
    print("       In the app: Open chart → ↻ Rescan disk, then reopen the series to see amended values.")


if __name__ == "__main__":
    main()
