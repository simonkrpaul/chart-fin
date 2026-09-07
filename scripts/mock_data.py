#!/usr/bin/env python3
"""
mock_data.py
────────────────────────────────────────────────────────────────────────────
Generate synthetic 1-minute OHLCV data for four market profiles so you can
exercise the chart-fin gap/session/offset logic without a live data feed.

Profiles
────────
  crypto   – 24/7 continuous (BTC/USDT-style)
  us_eq    – Mon–Fri 09:30–16:00 America/New_York (SPY-style)
  asx      – Mon–Fri 10:00–16:00 Australia/Sydney (XJO-style)
  forex    – Sun 22:00 UTC → Fri 22:00 UTC continuous (EURUSD-style)

Outputs
───────
  public/data/markets/<market>/<symbol>_<timeframe>.csv     (bar data)
  public/data/markets/manifest.json                         (index)

The frontend's `ingestManifest()` reads the manifest on startup and hot-loads
each series into IndexedDB. Deletes and re-runs are safe — the browser
ingestor upserts by (market, symbol, timeframe, timestamp).

Usage
─────
  python scripts/mock_data.py                    # all profiles, 30 days
  python scripts/mock_data.py --profile crypto   # only crypto
  python scripts/mock_data.py --days 90
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterable
try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    from backports.zoneinfo import ZoneInfo  # type: ignore

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKETS_DIR = REPO_ROOT / "public" / "data" / "markets"

# ── Types ──────────────────────────────────────────────────────────────────

@dataclass
class ProfileSpec:
    market: str
    label: str
    symbol: str
    timezone: str
    session_open: str   # "HH:MM" in `timezone`
    session_close: str  # "HH:MM" in `timezone`
    trading_days: set[int]   # ISO weekdays 1=Mon..7=Sun
    continuous: bool         # True → ignore session times, produce 24h data
    start_price: float
    daily_vol: float         # approximate daily σ as a fraction of price
    volume_scale: float      # per-minute volume multiplier
    holidays: list[str] = field(default_factory=list)   # "YYYY-MM-DD" in tz

# ── Profiles ───────────────────────────────────────────────────────────────

PROFILES: dict[str, ProfileSpec] = {
    "crypto": ProfileSpec(
        market="crypto", label="Crypto (24/7)",
        symbol="MOCKBTC",
        timezone="UTC",
        session_open="00:00", session_close="23:59",
        trading_days={1, 2, 3, 4, 5, 6, 7},
        continuous=True,
        start_price=65_000.0, daily_vol=0.025, volume_scale=1.5,
    ),
    "us_eq": ProfileSpec(
        market="us_equity", label="US Equity (NYSE session)",
        symbol="MOCKSPY",
        timezone="America/New_York",
        session_open="09:30", session_close="16:00",
        trading_days={1, 2, 3, 4, 5},
        continuous=False,
        start_price=500.0, daily_vol=0.011, volume_scale=40.0,
    ),
    "asx": ProfileSpec(
        market="asx", label="ASX (Sydney session)",
        symbol="MOCKXJO",
        timezone="Australia/Sydney",
        session_open="10:00", session_close="16:00",
        trading_days={1, 2, 3, 4, 5},
        continuous=False,
        start_price=7_800.0, daily_vol=0.009, volume_scale=15.0,
    ),
    "forex": ProfileSpec(
        market="forex", label="Forex (FX week)",
        symbol="MOCKEURUSD",
        timezone="UTC",
        session_open="00:00", session_close="23:59",
        # Trades Sun 22:00 UTC → Fri 22:00 UTC. We approximate by treating
        # Sun (7), Mon–Fri (1–5) as trading; a downstream filter drops
        # the pre-22:00 Sun candles and post-22:00 Fri candles.
        trading_days={1, 2, 3, 4, 5, 7},
        continuous=False,
        start_price=1.0850, daily_vol=0.006, volume_scale=100.0,
    ),
}

# ── Session filter ─────────────────────────────────────────────────────────

def _hm(s: str) -> tuple[int, int]:
    h, m = s.split(":")
    return int(h), int(m)


def _in_session(ts_utc: datetime, spec: ProfileSpec) -> bool:
    if spec.continuous:
        return True

    if spec.market == "forex":
        # Sun 22:00 UTC → Fri 22:00 UTC
        wd = ts_utc.isoweekday()
        if wd == 6:  # Saturday
            return False
        if wd == 7 and ts_utc.hour < 22:
            return False
        if wd == 5 and ts_utc.hour >= 22:
            return False
        return True

    local = ts_utc.astimezone(ZoneInfo(spec.timezone))
    wd = local.isoweekday()
    if wd not in spec.trading_days:
        return False
    if local.strftime("%Y-%m-%d") in spec.holidays:
        return False
    oh, om = _hm(spec.session_open)
    ch, cm = _hm(spec.session_close)
    open_min = oh * 60 + om
    close_min = ch * 60 + cm
    now_min = local.hour * 60 + local.minute
    return open_min <= now_min < close_min

# ── Random-walk price generator (deterministic per profile) ────────────────

def _random_walk(spec: ProfileSpec, minutes: int) -> Iterable[tuple[float, float, float, float, float]]:
    """Yield (open, high, low, close, volume) for `minutes` bars."""
    rng = random.Random(hash(spec.market + spec.symbol) & 0xFFFFFFFF)
    # Convert daily volatility → per-minute stdev assuming 1440 mins/day
    minute_sigma = spec.daily_vol / math.sqrt(1440)
    price = spec.start_price
    for _ in range(minutes):
        drift = rng.gauss(0, minute_sigma) * price
        open_ = price
        close_ = max(0.01, price + drift)
        # Wick amplitude scales with volatility
        wick = abs(drift) * (1 + rng.random() * 2)
        high_ = max(open_, close_) + wick * 0.6
        low_ = max(0.01, min(open_, close_) - wick * 0.6)
        volume = max(0.0, rng.gauss(1.0, 0.3)) * spec.volume_scale
        yield (open_, high_, low_, close_, volume)
        price = close_

# ── Writers ────────────────────────────────────────────────────────────────

def _profile_dir(spec: ProfileSpec) -> pathlib.Path:
    p = MARKETS_DIR / spec.market
    p.mkdir(parents=True, exist_ok=True)
    return p


def _resample(rows: list[dict], step_minutes: int) -> list[dict]:
    """Aggregate 1m rows into `step_minutes` bars using UTC-aligned buckets."""
    out: list[dict] = []
    if not rows:
        return out
    bucket_ms = step_minutes * 60_000
    current_start: int | None = None
    o = h = l = c = 0.0
    v = 0.0
    for row in rows:
        ts = row["timestamp"]
        b = (ts // bucket_ms) * bucket_ms
        if current_start is None:
            current_start = b
            o = row["open"]; h = row["high"]; l = row["low"]; c = row["close"]; v = row["volume"]
            continue
        if b == current_start:
            h = max(h, row["high"])
            l = min(l, row["low"])
            c = row["close"]
            v += row["volume"]
            continue
        out.append({"timestamp": current_start, "open": o, "high": h, "low": l, "close": c, "volume": v})
        current_start = b
        o = row["open"]; h = row["high"]; l = row["low"]; c = row["close"]; v = row["volume"]
    if current_start is not None:
        out.append({"timestamp": current_start, "open": o, "high": h, "low": l, "close": c, "volume": v})
    return out


def _write_csv(path: pathlib.Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as f:
        f.write("timestamp,open,high,low,close,volume\n")
        for r in rows:
            f.write(
                f'{r["timestamp"]},{r["open"]:.6f},{r["high"]:.6f},{r["low"]:.6f},{r["close"]:.6f},{r["volume"]:.4f}\n'
            )

# ── Manifest ───────────────────────────────────────────────────────────────

MANIFEST_PATH = MARKETS_DIR / "manifest.json"


def rebuild_manifest() -> None:
    """Scan public/data/markets/**/*.csv and rewrite manifest.json."""
    sources: list[dict] = []
    if MARKETS_DIR.exists():
        for csv in sorted(MARKETS_DIR.rglob("*.csv")):
            rel = csv.relative_to(REPO_ROOT / "public").as_posix()
            parts = csv.stem.split("_")
            if len(parts) < 2:
                continue
            timeframe = parts[-1]
            symbol = "_".join(parts[:-1])
            market = csv.parent.name
            sources.append({
                "market": market,
                "symbol": symbol,
                "timeframe": timeframe,
                "url": "/" + rel,
            })
    manifest = {
        "version": 1,
        "generatedAt": datetime.now(tz=timezone.utc).isoformat(),
        "sources": sources,
    }
    MARKETS_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
    print(f"  → manifest.json ({len(sources)} series)")

# ── Main ───────────────────────────────────────────────────────────────────

def generate(spec: ProfileSpec, days: int, extra_tfs: list[int]) -> None:
    end = datetime.now(tz=timezone.utc).replace(second=0, microsecond=0)
    start = end - timedelta(days=days)
    print(f"[{spec.market}/{spec.symbol}] {start:%Y-%m-%d %H:%M} → {end:%Y-%m-%d %H:%M} UTC")

    # First produce candidate ticks per minute, then filter for session.
    total_minutes = int((end - start).total_seconds() // 60)
    walk = list(_random_walk(spec, total_minutes))
    rows_1m: list[dict] = []
    ts = int(start.timestamp() * 1000)
    for i, (o, h, l, c, v) in enumerate(walk):
        bar_time = start + timedelta(minutes=i)
        if not _in_session(bar_time, spec):
            continue
        rows_1m.append({
            "timestamp": ts + i * 60_000,
            "open": o, "high": h, "low": l, "close": c, "volume": v,
        })

    out_dir = _profile_dir(spec)
    _write_csv(out_dir / f"{spec.symbol}_1m.csv", rows_1m)
    print(f"  → {spec.symbol}_1m.csv ({len(rows_1m)} bars)")

    for tf_min in extra_tfs:
        aggregated = _resample(rows_1m, tf_min)
        tf_label = _tf_label(tf_min)
        _write_csv(out_dir / f"{spec.symbol}_{tf_label}.csv", aggregated)
        print(f"  → {spec.symbol}_{tf_label}.csv ({len(aggregated)} bars)")


def _tf_label(m: int) -> str:
    if m < 60:
        return f"{m}m"
    if m < 1440:
        return f"{m // 60}h"
    if m == 1440:
        return "1d"
    if m == 10080:
        return "1w"
    return f"{m}m"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--profile", choices=list(PROFILES.keys()) + ["all"], default="all")
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--tfs", default="5,15,60,240,1440",
                   help="Comma-separated additional TFs (minutes) to resample to")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    extras = [int(x) for x in args.tfs.split(",") if x.strip()]
    keys = list(PROFILES.keys()) if args.profile == "all" else [args.profile]

    for key in keys:
        generate(PROFILES[key], args.days, extras)

    rebuild_manifest()


if __name__ == "__main__":
    main()
