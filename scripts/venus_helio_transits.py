"""
Compute dates when Venus (heliocentric) transits through specific zodiac degree ranges.
Uses pyswisseph with the heliocentric flag.

Events:
  82% DOWN Venus Helio 28°11' Gem -> 17°35' Leo
  78% DOWN Venus Helio 01°33' Vir -> 26°19' Lib
  94% UP   Venus Helio 02°46' Sc  -> 18°56' Sag
  79% DOWN Venus Helio 13°25' Aq  -> 24°42' Aq
  89% UP   Venus Helio 11°53' Pis -> 15°11' Ar

Usage:
  python scripts/venus_helio_transits.py
"""

import os
import sys
from datetime import datetime, timedelta, timezone

try:
    import swisseph as swe
except ImportError:
    print("ERROR: pyswisseph not installed. Run: pip install pyswisseph")
    sys.exit(1)

# Ephemeris path
EPHE_PATHS = [
    r'/Users/rajanpsi/repos/personal/swisseph/ephe',
    os.path.expanduser('~/swisseph/ephe'),
    '/usr/local/share/swisseph/ephe',
    '/usr/share/swisseph/ephe',
]
for path in EPHE_PATHS:
    if os.path.isdir(path):
        swe.set_ephe_path(path)
        break

# ---------------------------------------------------------------------------
# Zodiac sign offsets (tropical ecliptic longitude start of each sign)
# ---------------------------------------------------------------------------
SIGNS = {
    'Ar': 0, 'Ari': 0, 'Aries': 0,
    'Ta': 30, 'Tau': 30, 'Taurus': 30,
    'Ge': 60, 'Gem': 60, 'Gemini': 60,
    'Ca': 90, 'Can': 90, 'Cancer': 90,
    'Le': 120, 'Leo': 120,
    'Vi': 150, 'Vir': 150, 'Virgo': 150,
    'Li': 180, 'Lib': 180, 'Libra': 180,
    'Sc': 210, 'Sco': 210, 'Scorpio': 210,
    'Sa': 240, 'Sag': 240, 'Sagittarius': 240,
    'Ca': 270, 'Cap': 270, 'Capricorn': 270,
    'Aq': 300, 'Aqu': 300, 'Aquarius': 300,
    'Pi': 330, 'Pis': 330, 'Pisces': 330,
    'Ar': 0,   # Aries again for wrap
}

def parse_dms(deg_str, sign_str):
    """Parse '28°11'' + 'Gem' -> absolute ecliptic longitude in degrees."""
    # Handle formats like "28°11'" or "02°46'"
    deg_str = deg_str.strip().replace("'", "").replace("'", "")
    parts = deg_str.split('°')
    degrees = int(parts[0])
    minutes = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    sign_offset = SIGNS.get(sign_str.strip(), None)
    if sign_offset is None:
        raise ValueError(f"Unknown sign: {sign_str}")
    return sign_offset + degrees + minutes / 60.0


def datetime_to_jd(dt):
    """Convert datetime to Julian date."""
    return swe.julday(dt.year, dt.month, dt.day,
                      dt.hour + dt.minute / 60.0 + dt.second / 3600.0)


def venus_helio_longitude(jd):
    """Get Venus heliocentric tropical longitude."""
    flags = swe.FLG_SWIEPH | swe.FLG_HELCTR
    pos = swe.calc_ut(jd, swe.VENUS, flags)
    return pos[0][0]


def normalize_angle(a):
    return a % 360


def angle_in_range(angle, start_lon, end_lon):
    """Check if angle is within [start_lon, end_lon] accounting for wrap-around."""
    angle = normalize_angle(angle)
    start_lon = normalize_angle(start_lon)
    end_lon = normalize_angle(end_lon)
    if start_lon <= end_lon:
        return start_lon <= angle <= end_lon
    else:
        # Wraps through 0°
        return angle >= start_lon or angle <= end_lon


def find_transit_dates(start_lon, end_lon, start_date, end_date, step_hours=6):
    """
    Find all date ranges when Venus helio is between start_lon and end_lon.
    Returns list of (entry_date, exit_date) tuples.
    """
    results = []
    current = start_date
    step = timedelta(hours=step_hours)
    in_range = False
    entry_date = None

    while current <= end_date:
        jd = datetime_to_jd(current)
        lon = venus_helio_longitude(jd)

        if angle_in_range(lon, start_lon, end_lon):
            if not in_range:
                # Refine entry to ~1 minute precision
                entry_date = refine_boundary(current - step, current, start_lon, end_lon, entering=True)
                in_range = True
        else:
            if in_range:
                # Refine exit
                exit_date = refine_boundary(current - step, current, start_lon, end_lon, entering=False)
                results.append((entry_date, exit_date))
                in_range = False

        current += step

    # If still in range at end of scan
    if in_range and entry_date:
        results.append((entry_date, current))

    return results


def refine_boundary(t1, t2, start_lon, end_lon, entering=True):
    """Binary search to refine transition to ~1 minute precision."""
    for _ in range(20):  # 20 iterations = sub-minute precision from 6h steps
        mid = t1 + (t2 - t1) / 2
        jd = datetime_to_jd(mid)
        lon = venus_helio_longitude(jd)
        is_in = angle_in_range(lon, start_lon, end_lon)
        if entering:
            if is_in:
                t2 = mid
            else:
                t1 = mid
        else:
            if is_in:
                t1 = mid
            else:
                t2 = mid
    return t1 + (t2 - t1) / 2


# ---------------------------------------------------------------------------
# Define the 5 events
# ---------------------------------------------------------------------------
EVENTS = [
    {
        'label': '82% DOWN Venus Helio 28°11\' Gem -> 17°35\' Leo',
        'start_deg': '28°11', 'start_sign': 'Gem',
        'end_deg': '17°35', 'end_sign': 'Leo',
        'direction': 'DOWN',
        'probability': '82%',
    },
    {
        'label': '78% DOWN Venus Helio 01°33\' Vir -> 26°19\' Lib',
        'start_deg': '01°33', 'start_sign': 'Vir',
        'end_deg': '26°19', 'end_sign': 'Lib',
        'direction': 'DOWN',
        'probability': '78%',
    },
    {
        'label': '94% UP Venus Helio 02°46\' Sc -> 18°56\' Sag',
        'start_deg': '02°46', 'start_sign': 'Sc',
        'end_deg': '18°56', 'end_sign': 'Sag',
        'direction': 'UP',
        'probability': '94%',
    },
    {
        'label': '79% DOWN Venus Helio 13°25\' Aq -> 24°42\' Aq',
        'start_deg': '13°25', 'start_sign': 'Aq',
        'end_deg': '24°42', 'end_sign': 'Aq',
        'direction': 'DOWN',
        'probability': '79%',
    },
    {
        'label': '89% UP Venus Helio 11°53\' Pis -> 15°11\' Ar',
        'start_deg': '11°53', 'start_sign': 'Pis',
        'end_deg': '15°11', 'end_sign': 'Ar',
        'direction': 'UP',
        'probability': '89%',
    },
]


def main():
    # Scan range: 2020-01-01 to 2027-12-31
    start_date = datetime(2020, 1, 1, tzinfo=timezone.utc)
    end_date = datetime(2027, 12, 31, tzinfo=timezone.utc)

    print("=" * 90)
    print("Venus Heliocentric Transit Dates (Tropical)")
    print(f"Scan range: {start_date.strftime('%Y-%m-%d')} to {end_date.strftime('%Y-%m-%d')}")
    print("=" * 90)

    for event in EVENTS:
        start_lon = parse_dms(event['start_deg'], event['start_sign'])
        end_lon = parse_dms(event['end_deg'], event['end_sign'])

        print(f"\n{'─' * 90}")
        print(f"  {event['label']}")
        print(f"  Longitude range: {start_lon:.3f}° → {end_lon:.3f}° (tropical)")
        print(f"{'─' * 90}")

        transits = find_transit_dates(start_lon, end_lon, start_date, end_date, step_hours=4)

        if not transits:
            print("  No transits found in scan range.")
        else:
            print(f"  {'#':<4} {'Entry Date':<22} {'Exit Date':<22} {'Duration'}")
            print(f"  {'─'*4} {'─'*22} {'─'*22} {'─'*12}")
            for i, (entry, exit_d) in enumerate(transits, 1):
                duration = exit_d - entry
                days = duration.total_seconds() / 86400
                print(f"  {i:<4} {entry.strftime('%Y-%m-%d %H:%M UTC'):<22} {exit_d.strftime('%Y-%m-%d %H:%M UTC'):<22} {days:.1f} days")

    print(f"\n{'=' * 90}")


if __name__ == '__main__':
    main()
