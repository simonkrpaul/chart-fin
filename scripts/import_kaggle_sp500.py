#!/usr/bin/env python3
"""
import_kaggle_sp500.py
────────────────────────────────────────────────────────────────────────────
Split a Kaggle S&P 500 master CSV (~2.9 M rows across ~500 symbols) into
one file per symbol under public/data/markets/us_equity/<SYMBOL>_1d.csv
in the canonical chart-fin schema and rebuild the manifest.

Expected input schema (Kaggle "andrewmvd/sp-500-stocks" style)
─────────────────────────────────────────────────────────────
    date,open,high,low,close,volume,symbol
    2000-01-03,46.87,46.99,40.10,42.86,4674353.0,A
    …

Output schema
─────────────
    timestamp,open,high,low,close,volume,symbol
    946857600000,46.87,46.99,40.10,42.86,4674353.0,A
    …

Usage
─────
    # First-time full import (default: skip files that already exist)
    python scripts/import_kaggle_sp500.py \\
        --companies public/data/usstock/sp500_companies.csv

    # ★ Daily update — only writes rows newer than each file's last ts.
    # This is the fast path for re-running against a refreshed Kaggle dump.
    python scripts/import_kaggle_sp500.py --mode append \\
        --input public/data/usstock/sp500_stocks.csv

    # Rewrite everything (use after schema changes or corrupted files)
    python scripts/import_kaggle_sp500.py --mode overwrite

    # Just rebuild manifest.json (after moving files around)
    python scripts/import_kaggle_sp500.py --rebuild-manifest-only

Modes
─────
    skip       (default) Existing per-symbol files are left untouched. Only
               brand-new symbols get written. Safe to run on a partial import.
    append     For each symbol, reads the last row of the existing CSV,
               then only appends rows with a strictly greater timestamp.
               Cheap tail-read (~4 KB per file); typically < 5 s for a full
               daily update of the S&P 500.
    overwrite  Every symbol file is rewritten from scratch. Use for schema
               changes, adjustment fixes, or when you don't trust the current
               files.

Notes
─────
  • Streams the master CSV row-by-row so the 288 MB file never sits in
    memory as one DataFrame. Peak memory ≈ 50 MB.
  • Timestamps are converted to Unix milliseconds UTC. Daily bars keep
    their ISO date and get anchored to 00:00 UTC.
  • Filenames replace '.'/'-' with underscores; symbol column keeps the
    original ticker (e.g. BRK.B stays BRK.B).
"""
from __future__ import annotations

import argparse
import csv
import json
import pathlib
import resource
import sys
import time
from datetime import datetime, timezone
from typing import IO

REPO_ROOT     = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_INPUT = REPO_ROOT / "public" / "data" / "usstock" / "sp500_stocks.csv"
MARKETS_DIR   = REPO_ROOT / "public" / "data" / "markets"
US_EQUITY_DIR = MARKETS_DIR / "us_equity"
MANIFEST_PATH = MARKETS_DIR / "manifest.json"

CANONICAL_HEADER = "timestamp,open,high,low,close,volume,symbol\n"


def _raise_fd_limit(target: int = 4096) -> None:
    """
    macOS defaults to 256 open files per process; we open ~500 for S&P 500.
    Raise the soft limit — no sudo needed up to the hard limit.
    """
    try:
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        want = min(target, hard) if hard != resource.RLIM_INFINITY else target
        if soft < want:
            resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
    except (ValueError, OSError):
        pass


def _resolve_input_path(path: pathlib.Path | None) -> pathlib.Path | None:
    """
    Accept both cwd-relative and repo-root-relative paths so the script works
    whether the user runs it from repo root or from scripts/.
    """
    if path is None:
        return None
    if path.is_absolute() or path.exists():
        return path
    alt = REPO_ROOT / path
    return alt if alt.exists() else path


# ── Timestamp normalisation ────────────────────────────────────────────────

def to_unix_ms(date_str: str) -> int | None:
    """Accept 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'. Return Unix ms UTC."""
    s = date_str.strip()
    if not s:
        return None
    try:
        if " " in s or "T" in s:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        else:
            dt = datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _safe_filename(symbol: str) -> str:
    return symbol.replace("/", "").replace("-", "").upper()


# ── Companies sidecar (optional) ───────────────────────────────────────────

def load_companies(path: pathlib.Path | None) -> dict[str, dict]:
    if not path or not path.exists():
        return {}
    meta: dict[str, dict] = {}
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sym = (row.get("symbol") or row.get("Symbol") or "").strip()
            if not sym:
                continue
            meta[sym] = {
                "sector":       (row.get("sector") or row.get("Sector") or "").strip(),
                "sub_industry": (row.get("sub_industry") or row.get("Sub_Industry") or "").strip(),
                "company":      (row.get("company") or row.get("Company") or row.get("shortname") or "").strip(),
                "headquarters": (row.get("headquarters") or row.get("Headquarters") or "").strip(),
                "founded":      (row.get("founded") or "").strip(),
            }
    return meta


# ── Streaming split ────────────────────────────────────────────────────────

MODE_SKIP     = "skip"       # default: existing files untouched, only new symbols written
MODE_APPEND   = "append"     # per-symbol: append rows with ts > last existing ts
MODE_OVERWRITE = "overwrite"  # rewrite every symbol file from scratch


def _last_ts_of(csv_path: pathlib.Path) -> int | None:
    """Read the last data line of a per-symbol CSV to get its max timestamp.
    Returns None for missing/empty/malformed files."""
    if not csv_path.exists():
        return None
    try:
        with csv_path.open("rb") as f:
            f.seek(0, 2)                       # end of file
            size = f.tell()
            if size == 0:
                return None
            # Read back in 4 KB chunks until we find at least one newline
            # before EOF. Tail parse is O(1) regardless of file size.
            block = min(4096, size)
            f.seek(-block, 2)
            tail = f.read().decode("utf-8", errors="ignore").rstrip("\n\r")
            if not tail:
                return None
            last_line = tail.splitlines()[-1]
            first_col = last_line.split(",", 1)[0]
            return int(first_col)
    except (OSError, ValueError):
        return None


def split_master(input_path: pathlib.Path, mode: str,
                 companies: dict[str, dict]) -> tuple[int, int, int]:
    """
    Stream the master CSV; open a per-symbol writer lazily. Returns
    (symbols_written, rows_written, rows_skipped_older).
    """
    if not input_path.exists():
        raise SystemExit(f"Input not found: {input_path}")

    US_EQUITY_DIR.mkdir(parents=True, exist_ok=True)

    # Discover header columns.
    with input_path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        cols   = {name.strip().lower(): i for i, name in enumerate(header)}

        needed = ("date", "open", "high", "low", "close", "volume", "symbol")
        missing = [c for c in needed if c not in cols]
        # 'date' can also be 'timestamp' in some Kaggle exports.
        if "date" in missing and "timestamp" in cols:
            missing.remove("date")
            cols["date"] = cols["timestamp"]
        if missing:
            raise SystemExit(
                f"Missing column(s) {missing} in {input_path.name}.\n"
                f"Header seen: {header}"
            )

        # Per-symbol state:  (file handle, rows appended in this run, cutoff ts for append mode)
        writers: dict[str, tuple[IO[str], int, int | None]] = {}
        skipped_symbols: set[str] = set()
        rows_ok = 0
        rows_bad = 0
        rows_older = 0     # rows skipped because ts <= existing last ts (append mode)
        t0 = time.time()

        try:
            for row in reader:
                if not row:
                    continue
                try:
                    date_str = row[cols["date"]]
                    sym      = row[cols["symbol"]].strip()
                    if not sym:
                        continue
                    if sym in skipped_symbols:
                        continue

                    # Lazily open writer for this symbol.
                    if sym not in writers:
                        dst = US_EQUITY_DIR / f"{_safe_filename(sym)}_1d.csv"
                        cutoff: int | None = None
                        if dst.exists():
                            if mode == MODE_SKIP:
                                skipped_symbols.add(sym)
                                continue
                            if mode == MODE_APPEND:
                                cutoff = _last_ts_of(dst)
                                fh = dst.open("a", newline="", encoding="utf-8")
                            else:  # overwrite
                                fh = dst.open("w", newline="", encoding="utf-8")
                                fh.write(CANONICAL_HEADER)
                        else:
                            fh = dst.open("w", newline="", encoding="utf-8")
                            fh.write(CANONICAL_HEADER)
                        writers[sym] = (fh, 0, cutoff)

                    ts = to_unix_ms(date_str)
                    if ts is None:
                        rows_bad += 1
                        continue

                    fh, n, cutoff = writers[sym]
                    if cutoff is not None and ts <= cutoff:
                        rows_older += 1
                        continue

                    open_v   = row[cols["open"]]
                    high_v   = row[cols["high"]]
                    low_v    = row[cols["low"]]
                    close_v  = row[cols["close"]]
                    volume_v = row[cols["volume"]] or "0"
                    # Skip rows where OHLC parse fails.
                    if not open_v or open_v == "nan" or not close_v or close_v == "nan":
                        rows_bad += 1
                        continue
                    fh.write(f"{ts},{open_v},{high_v},{low_v},{close_v},{volume_v},{sym}\n")
                    writers[sym] = (fh, n + 1, cutoff)
                    rows_ok += 1
                    if rows_ok % 500_000 == 0:
                        elapsed = time.time() - t0
                        print(f"[progress] {rows_ok:,} rows · {len(writers)} symbols · "
                              f"{elapsed:.1f}s elapsed", file=sys.stderr)
                except (IndexError, ValueError):
                    rows_bad += 1
                    continue
        finally:
            for _, (fh, _n, _cutoff) in writers.items():
                fh.close()

    # Write sidecar meta so the manifest can pick up sector/company.
    for sym, (_, n, _cutoff) in writers.items():
        info = companies.get(sym) or companies.get(sym.replace(".", "-")) or {}
        if info:
            (US_EQUITY_DIR / f"{_safe_filename(sym)}.meta.json").write_text(
                json.dumps({
                    "exchange":    "US Equity",
                    "description": info.get("company") or sym,
                    "sector":      info.get("sector"),
                    "industry":    info.get("sub_industry"),
                    "headquarters": info.get("headquarters"),
                    "founded":     info.get("founded"),
                    "row_count":   n,
                }, indent=2)
            )

    if skipped_symbols:
        print(f"[skip] {len(skipped_symbols)} symbols already had CSVs "
              f"(use --mode append to update, or --mode overwrite to replace)",
              file=sys.stderr)
    if rows_bad:
        print(f"[warn] {rows_bad} rows skipped (bad dates / NaN prices)", file=sys.stderr)
    if rows_older:
        print(f"[append] {rows_older:,} rows skipped (older than existing last ts)",
              file=sys.stderr)

    return len(writers), rows_ok, rows_older


# ── Manifest ───────────────────────────────────────────────────────────────

VALID_TFS = {"1m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"}


def rebuild_manifest() -> None:
    sources: list[dict] = []
    if MARKETS_DIR.exists():
        for csv_path in sorted(MARKETS_DIR.rglob("*.csv")):
            stem = csv_path.stem
            if "_" not in stem:
                continue
            symbol, _, tf = stem.rpartition("_")
            if tf not in VALID_TFS:
                continue
            market = csv_path.parent.name
            entry = {
                "market": market,
                "symbol": symbol,
                "timeframe": tf,
                "url": "/" + csv_path.relative_to(REPO_ROOT / "public").as_posix(),
            }
            meta_file = csv_path.parent / f"{symbol}.meta.json"
            if meta_file.exists():
                try:
                    m = json.loads(meta_file.read_text())
                    if m.get("exchange"):    entry["exchange"] = m["exchange"]
                    if m.get("description"): entry["description"] = m["description"]
                except json.JSONDecodeError:
                    pass
            sources.append(entry)
    manifest = {
        "version": 1,
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "sources": sources,
    }
    MARKETS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
    print(f"[manifest] rebuilt · {len(sources)} series")


# ── CLI ────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--input", type=pathlib.Path, default=DEFAULT_INPUT,
                   help=f"Kaggle prices CSV (default: {DEFAULT_INPUT.relative_to(REPO_ROOT)})")
    p.add_argument("--companies", type=pathlib.Path, default=None,
                   help="Optional Kaggle companies CSV for sector/industry sidecar metadata")
    p.add_argument("--mode", choices=[MODE_SKIP, MODE_APPEND, MODE_OVERWRITE],
                   default=MODE_SKIP,
                   help="skip: leave existing files alone (default) · "
                        "append: only write rows newer than each file's last ts "
                        "(fast daily-update path) · "
                        "overwrite: rewrite every symbol file from scratch")
    # Backwards-compat alias.
    p.add_argument("--overwrite", action="store_true",
                   help="Deprecated alias for --mode overwrite")
    p.add_argument("--rebuild-manifest-only", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    if args.rebuild_manifest_only:
        rebuild_manifest()
        return

    _raise_fd_limit()
    args.input = _resolve_input_path(args.input) or args.input
    args.companies = _resolve_input_path(args.companies)

    mode = args.mode
    if args.overwrite and mode == MODE_SKIP:
        mode = MODE_OVERWRITE

    companies = load_companies(args.companies)
    if args.companies and not companies:
        print(f"[warn] no rows parsed from {args.companies}", file=sys.stderr)

    print(f"[plan] splitting {args.input.relative_to(REPO_ROOT)} → "
          f"{US_EQUITY_DIR.relative_to(REPO_ROOT)}/  (mode={mode})")
    t0 = time.time()
    n_syms, n_rows, n_older = split_master(args.input, mode, companies)
    tail = f" · {n_older:,} older rows skipped" if n_older else ""
    print(f"[done] {n_syms} symbols touched · {n_rows:,} new rows written{tail} · {time.time()-t0:.1f}s")
    rebuild_manifest()


if __name__ == "__main__":
    main()
