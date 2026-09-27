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
        repo_root = markets_dir.parent.parent  # public/ → repo root

    sources: list[dict] = []
    if markets_dir.exists():
        for csv_path in sorted(markets_dir.rglob("*.csv")):
            stem = csv_path.stem
            if "_" not in stem:
                continue
            symbol, _, tf = stem.rpartition("_")
            if tf not in VALID_TFS:
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
                    if meta.get("exchange"):
                        entry["exchange"] = meta["exchange"]
                    if meta.get("description"):
                        entry["description"] = meta["description"]
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
    return manifest_path
