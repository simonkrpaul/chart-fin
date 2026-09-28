#!/usr/bin/env python3
"""
import_market.py
────────────────────────────────────────────────────────────────────────────
Move / rename an OHLCV CSV into the multi-market layout the frontend expects.

The browser reads `public/data/markets/manifest.json` on startup and
hot-imports every listed CSV into IndexedDB. The manifest is regenerated
from disk by this script (and by `mock_data.py`) so any CSV placed under
`public/data/markets/<market>/<symbol>_<timeframe>.csv` is auto-picked up.

Usage
─────
  # Import Bybit data as the "crypto" market's BTCUSDT series (1m)
  python scripts/import_market.py public/data/bybit_btcusdt_1m.csv \\
      --market crypto --symbol BTCUSDT --timeframe 1m

  # Rebuild the manifest without importing (after manual file edits)
  python scripts/import_market.py --rebuild-manifest-only

  # Bulk import all Bybit files
  for tf in 1m 5m 1h 1d; do
    python scripts/import_market.py public/data/bybit_btcusdt_${tf}.csv \\
        --market crypto --symbol BTCUSDT --timeframe $tf
  done
"""
from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKETS_DIR = REPO_ROOT / "public" / "data" / "markets"
MANIFEST_PATH = MARKETS_DIR / "manifest.json"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _manifest import (  # noqa: E402
    VALID_TFS,
    rebuild_manifest as _rebuild_manifest,
    tf_to_filename_suffix,
)


def import_csv(src: pathlib.Path, market: str, symbol: str, timeframe: str,
               exchange: str | None, description: str | None,
               copy: bool) -> pathlib.Path:
    if not src.exists():
        raise FileNotFoundError(src)
    if timeframe not in VALID_TFS:
        raise ValueError(f"unsupported timeframe: {timeframe}")

    dst_dir = MARKETS_DIR / market
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / f"{symbol}_{tf_to_filename_suffix(timeframe)}.csv"

    if dst.exists() and dst.resolve() == src.resolve():
        # already in place
        pass
    elif copy:
        shutil.copy2(src, dst)
    else:
        # Prefer hard-link when possible so the file remains discoverable
        # under its original path too. Fall back to copy on cross-fs.
        try:
            if dst.exists():
                dst.unlink()
            dst.hardlink_to(src)
        except (OSError, NotImplementedError):
            shutil.copy2(src, dst)

    # Optional sidecar meta for the manifest entry
    if exchange or description:
        meta = {"exchange": exchange, "description": description}
        (dst_dir / f"{symbol}.meta.json").write_text(json.dumps(meta, indent=2))
    return dst


def rebuild_manifest() -> None:
    _rebuild_manifest(MARKETS_DIR, repo_root=REPO_ROOT)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("path", type=pathlib.Path, nargs="?")
    p.add_argument("--market",    help="Market id (e.g. crypto, us_equity, asx, forex)")
    p.add_argument("--symbol",    help="Symbol (e.g. BTCUSDT, SPY, XJO)")
    p.add_argument("--timeframe", help="Timeframe: 1m|5m|1h|1d|…")
    p.add_argument("--exchange", default=None)
    p.add_argument("--description", default=None)
    p.add_argument("--copy", action="store_true",
                   help="Copy the source file instead of hard-linking")
    p.add_argument("--rebuild-manifest-only", action="store_true",
                   help="Skip import and only rewrite manifest.json")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    if args.rebuild_manifest_only:
        rebuild_manifest()
        return
    if not (args.path and args.market and args.symbol and args.timeframe):
        raise SystemExit("Missing arguments. See --help.")

    dst = import_csv(args.path, args.market, args.symbol, args.timeframe,
                     args.exchange, args.description, args.copy)
    print(f"→ {dst.relative_to(REPO_ROOT)}")
    rebuild_manifest()


if __name__ == "__main__":
    main()
