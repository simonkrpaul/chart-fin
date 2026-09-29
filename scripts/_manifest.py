"""
_manifest.py — shared helper for reading / rebuilding
`public/data/markets/manifest.json`.

The chart-fin frontend reads this manifest on every cold boot and streams
every listed CSV straight into IndexedDB (see `src/db/marketDb.ts →
ingestManifest`). Ingest is idempotent and cache-aware: as long as we
bump `generatedAt` after writing new CSVs, the app will pick up the new
symbols on next reload — **no UI import needed**.

Any Python ingestion script (Bybit, Alpaca, Kaggle, Dukascopy, custom
CSV drop) should call `rebuild_manifest()` at the end of its run.
"""
from __future__ import annotations

import json
import pathlib
from datetime import datetime, timezone


VALID_TFS = {"1m", "5m", "10m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1M"}

# Filename suffix ↔ TF mapping.
#
# macOS APFS and Windows NTFS are case-insensitive by default, so writing
# both `<SYM>_1m.csv` and `<SYM>_1M.csv` into the same directory silently
# collapses them into the same file. We work around this by using `1mo`
# on disk for the monthly timeframe, while keeping the app-side `Timeframe`
# type unchanged as `'1M'`. The manifest still emits `"timeframe": "1M"`
# — only the URL points at `<SYM>_1mo.csv`.
_FILENAME_SUFFIX_TO_TF = {
    "1m": "1m", "5m": "5m", "10m": "10m", "15m": "15m", "30m": "30m",
    "1h": "1h", "2h": "2h", "4h": "4h",
    "1d": "1d", "1w": "1w",
    "1mo": "1M",  # case-safe monthly suffix
    # `1M` is intentionally NOT accepted here — see `rebuild_manifest`
    # for the legacy warning path.
}


def tf_to_filename_suffix(tf: str) -> str:
    """Return the on-disk filename suffix for a chart-fin TF code.

    Use this when constructing `<SYMBOL>_<suffix>.csv` in any importer /
    downloader so monthly bars land in a case-safe filename.
    """
    return "1mo" if tf == "1M" else tf


def update_meta_source(
    market_dir: pathlib.Path,
    symbol: str,
    timeframe: str,
    exchange: str,
    description: str | None = None,
    extra: dict | None = None,
) -> None:
    """Merge a per-timeframe provenance entry into `<symbol>.meta.json`.

    Reads the existing meta file (if any), adds/overwrites the entry under
    `sources[timeframe]`, and writes it back. Other timeframes' entries and
    top-level fields are preserved so one XAUUSD.meta.json can advertise
    Kaggle for 1m + evtradelabs for 5m + resampled-from-1m for the rest.
    """
    meta_path = market_dir / f"{symbol}.meta.json"
    meta: dict = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text()) or {}
        except json.JSONDecodeError:
            meta = {}

    sources = meta.get("sources")
    if not isinstance(sources, dict):
        sources = {}
    entry: dict = {"exchange": exchange}
    if description:
        entry["description"] = description
    if extra:
        entry.update(extra)
    sources[timeframe] = entry
    meta["sources"] = sources

    # Keep a top-level exchange/description too so pre-per-TF code still
    # has something to display. Uses the newest write.
    meta.setdefault("exchange", exchange)
    if description:
        meta.setdefault("description", description)

    market_dir.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, indent=2))


def rebuild_manifest(
    markets_dir: pathlib.Path,
    repo_root: pathlib.Path | None = None,
    quiet: bool = False,
) -> pathlib.Path:
    """Scan `markets_dir` recursively for `<SYMBOL>_<TF>.csv` files and
    write a fresh `manifest.json`. Sidecar `<SYMBOL>.meta.json` files
    (if present) contribute optional `exchange` / `description` fields.

    Returns the path of the written manifest file.
    """
    manifest_path = markets_dir / "manifest.json"
    if repo_root is None:
        # markets_dir = <repo>/public/data/markets → three .parent hops
        # get us back to the repo root.
        repo_root = markets_dir.parent.parent.parent

    sources: list[dict] = []
    legacy_1M_files: list[pathlib.Path] = []
    if markets_dir.exists():
        for csv_path in sorted(markets_dir.rglob("*.csv")):
            stem = csv_path.stem
            if "_" not in stem:
                continue
            symbol, _, suffix = stem.rpartition("_")

            # Legacy filename detection: `_1M.csv` collides with `_1m.csv`
            # on case-insensitive filesystems (macOS APFS, Windows NTFS).
            # We accept it for backward compatibility but warn.
            if suffix == "1M":
                legacy_1M_files.append(csv_path)
                tf = "1M"
            else:
                tf = _FILENAME_SUFFIX_TO_TF.get(suffix)
                if tf is None:
                    continue

            market = csv_path.parent.name
            entry: dict = {
                "market": market,
                "symbol": symbol,
                "timeframe": tf,
                "url": "/" + csv_path.relative_to(repo_root / "public").as_posix(),
            }
            meta_file = csv_path.parent / f"{symbol}.meta.json"
            if meta_file.exists():
                try:
                    meta = json.loads(meta_file.read_text())
                    # Per-TF override wins; symbol-level exchange/description
                    # is the fallback. Lets one symbol expose multiple sources
                    # (e.g. Kaggle 1m + evtradelabs 5m under one XAUUSD).
                    per_tf = (meta.get("sources") or {}).get(tf) or {}
                    exchange = per_tf.get("exchange") or meta.get("exchange")
                    description = per_tf.get("description") or meta.get("description")
                    if exchange:
                        entry["exchange"] = exchange
                    if description:
                        entry["description"] = description
                except json.JSONDecodeError:
                    pass
            sources.append(entry)

    manifest = {
        "version": 1,
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "sources": sources,
    }
    markets_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2))
    if not quiet:
        print(f"[manifest] rebuilt · {len(sources)} series · {manifest_path.relative_to(repo_root)}")
        if legacy_1M_files:
            print(
                f"[manifest] warning: {len(legacy_1M_files)} legacy '_1M.csv' file(s) "
                "still on disk. Rename to '_1mo.csv' — on case-insensitive "
                "filesystems they collide with '_1m.csv':"
            )
            for p in legacy_1M_files[:5]:
                print(f"           - {p.relative_to(repo_root)}")
            if len(legacy_1M_files) > 5:
                print(f"           …and {len(legacy_1M_files) - 5} more.")
    return manifest_path
