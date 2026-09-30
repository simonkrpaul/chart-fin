"""
_resample.py — shared resample helpers for chart-fin importers.

The forex week convention (as used by TradingView, MT5, IG, OANDA, CME, …):
    Trading day starts at 17:00 New York.
    A bar timestamped Sunday 22:00 UTC (= Sunday 18:00 EDT) already belongs
    to Monday's daily candle. Ditto for the weekly bar.

`forex_daily_bucket_ts` and `forex_weekly_bucket_ts` implement that rule so
resamplers don't produce a stub Sunday candle that splits Monday's price
action.

Non-forex users can call `simple_daily_bucket_ts` (UTC-midnight floor) or
`simple_weekly_bucket_ts` (ISO Monday-UTC).
"""
from __future__ import annotations

import datetime as dt
from typing import Callable, Iterable, Iterator, Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError as e:  # Python < 3.9
    raise SystemExit(f"Python 3.9+ required (zoneinfo). Got: {e}")

Bar = Tuple[int, float, float, float, float, float]  # ts_ms, o, h, l, c, v

_UTC = dt.timezone.utc


# ── Bucket-key computers ───────────────────────────────────────────────────

def forex_daily_bucket_ts(
    ts_ms: int,
    boundary_tz: ZoneInfo,
    boundary_hour: int = 17,
) -> int:
    """Trading day = day whose `boundary_hour` in `boundary_tz` most recently
    passed. Returns midnight UTC of that day (so the label matches TradingView).

    e.g. Sun 2026-09-06 22:00 UTC → NY 18:00 EDT ≥ 17:00 → trading day = Sep 7
         → returns Sep 7 00:00 UTC.
    """
    local = dt.datetime.fromtimestamp(ts_ms / 1000, tz=_UTC).astimezone(boundary_tz)
    day = local.date()
    if local.hour >= boundary_hour:
        day = day + dt.timedelta(days=1)
    midnight_utc = dt.datetime(day.year, day.month, day.day, tzinfo=_UTC)
    return int(midnight_utc.timestamp() * 1000)


def forex_weekly_bucket_ts(
    ts_ms: int,
    boundary_tz: ZoneInfo,
    boundary_hour: int = 17,
) -> int:
    """Trading week starts at Sunday `boundary_hour` (17:00 NY = start of Monday
    trading day). Returns midnight UTC of that Monday.
    """
    daily_key = forex_daily_bucket_ts(ts_ms, boundary_tz, boundary_hour)
    d = dt.datetime.fromtimestamp(daily_key / 1000, tz=_UTC)
    # weekday(): Mon=0 … Sun=6. Trading day is one of Mon-Fri (Sunday afternoon
    # already got shifted to Monday). Roll back to that Monday.
    monday = d - dt.timedelta(days=d.weekday())
    return int(monday.timestamp() * 1000)


def simple_daily_bucket_ts(ts_ms: int, *_ignored) -> int:
    """UTC-midnight floor. Use for non-forex markets."""
    day_ms = 86_400_000
    return (ts_ms // day_ms) * day_ms


def simple_weekly_bucket_ts(ts_ms: int, *_ignored) -> int:
    """ISO week (Monday 00:00 UTC). Use for non-forex markets."""
    d = dt.datetime.fromtimestamp(ts_ms / 1000, tz=_UTC)
    monday = d - dt.timedelta(days=d.weekday())
    mon = dt.datetime(monday.year, monday.month, monday.day, tzinfo=_UTC)
    return int(mon.timestamp() * 1000)


# ── Generic single-pass bucket aggregator ──────────────────────────────────

def resample_bars(
    sorted_bars: Iterable[Bar],
    key_fn: Callable[[int], int],
) -> Iterator[Bar]:
    """Group `sorted_bars` by `key_fn(ts_ms)` and yield one OHLCV bar per key.

    Assumes input is chronologically ordered — same assumption every importer
    already relies on. Memory usage is O(1) per output bar.
    """
    cur_key = None
    o = h = lo = c = 0.0
    v = 0.0
    for ts, o1, h1, l1, c1, v1 in sorted_bars:
        key = key_fn(ts)
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


def minute_bucket(bucket_min: int) -> Callable[[int], int]:
    """Return a key_fn that floors `ts_ms` to a fixed-minute bucket."""
    bucket_ms = bucket_min * 60_000
    def _f(ts_ms: int) -> int:
        return (ts_ms // bucket_ms) * bucket_ms
    return _f


def month_bucket() -> Callable[[int], int]:
    """First-of-month 00:00 UTC bucket."""
    def _f(ts_ms: int) -> int:
        d = dt.datetime.fromtimestamp(ts_ms / 1000, tz=_UTC)
        first = dt.datetime(d.year, d.month, 1, tzinfo=_UTC)
        return int(first.timestamp() * 1000)
    return _f
