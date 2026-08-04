"""
Compute transit dates for all planetary events:
- Mercury Helio single-planet transits
- Mercury-Sun Helio angular difference transits  
- Moon-N.Node angular difference transits
- Venus Helio (already computed)

Outputs JSON for embedding as presets.
"""

import os
import sys
import json
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

# ─────────────────────────────────────────────────────────────────────────────
# Sign offsets
# ─────────────────────────────────────────────────────────────────────────────

SIGNS = {
    'Ari': 0, 'Tau': 30, 'Gem': 60, 'Can': 90, 'Canc': 90,
    'Leo': 120, 'Vir': 150, 'Lib': 180, 'Sco': 210, 'Sc': 210,
    'Sag': 240, 'Cap': 270, 'Aq': 300, 'Aqu': 300, 'Pis': 330,
    'Ar': 0,
}


def sign_deg_to_lon(deg, minutes, sign):
    """Convert sign + degrees + minutes to absolute longitude."""
    offset = SIGNS.get(sign)
    if offset is None:
        raise ValueError(f"Unknown sign: {sign}")
    return offset + deg + minutes / 60.0


def datetime_to_jd(dt):
    return swe.julday(dt.year, dt.month, dt.day,
                      dt.hour + dt.minute / 60.0 + dt.second / 3600.0)


def helio_longitude(jd, planet_id):
    """Heliocentric tropical longitude."""
    flags = swe.FLG_SWIEPH | swe.FLG_HELCTR
    pos = swe.calc_ut(jd, planet_id, flags)
    return pos[0][0]


def geo_longitude(jd, planet_id, sidereal=False):
    """Geocentric longitude (tropical or sidereal)."""
    flags = swe.FLG_SWIEPH
    if sidereal:
        flags |= swe.FLG_SIDEREAL
    pos = swe.calc_ut(jd, planet_id, flags)
    return pos[0][0]


def angle_in_range(angle, start_lon, end_lon):
    """Check if angle is in [start, end], handling wrap-around through 360°."""
    angle = angle % 360
    start_lon = start_lon % 360
    end_lon = end_lon % 360
    if start_lon <= end_lon:
        return start_lon <= angle <= end_lon
    else:
        # wraps through 0°
        return angle >= start_lon or angle <= end_lon


def find_single_planet_transits(planet_id, start_lon, end_lon, start_date, end_date,
                                 helio=True, sidereal=False, step_hours=4):
    """Find date ranges when a single planet's longitude is within [start_lon, end_lon]."""
    results = []
    current = start_date
    step = timedelta(hours=step_hours)
    in_range = False
    entry_dt = None

    while current <= end_date:
        jd = datetime_to_jd(current)
        if helio:
            lon = helio_longitude(jd, planet_id)
        else:
            lon = geo_longitude(jd, planet_id, sidereal)

        if angle_in_range(lon, start_lon, end_lon):
            if not in_range:
                entry_dt = current
                in_range = True
        else:
            if in_range and entry_dt:
                results.append((entry_dt.strftime('%Y-%m-%d'), current.strftime('%Y-%m-%d')))
                in_range = False
        current += step

    if in_range and entry_dt:
        results.append((entry_dt.strftime('%Y-%m-%d'), current.strftime('%Y-%m-%d')))

    return results


def find_angular_diff_transits(planet1_id, planet2_id, start_angle, end_angle,
                                start_date, end_date, helio=True, sidereal=False,
                                step_hours=4):
    """
    Find date ranges when the angular difference (planet1 - planet2) mod 360
    is within [start_angle, end_angle].
    """
    results = []
    current = start_date
    step = timedelta(hours=step_hours)
    in_range = False
    entry_dt = None

    while current <= end_date:
        jd = datetime_to_jd(current)
        if helio:
            lon1 = helio_longitude(jd, planet1_id)
            lon2 = helio_longitude(jd, planet2_id)
        else:
            lon1 = geo_longitude(jd, planet1_id, sidereal)
            lon2 = geo_longitude(jd, planet2_id, sidereal)

        diff = (lon1 - lon2) % 360

        if angle_in_range(diff, start_angle, end_angle):
            if not in_range:
                entry_dt = current
                in_range = True
        else:
            if in_range and entry_dt:
                results.append((entry_dt.strftime('%Y-%m-%d'), current.strftime('%Y-%m-%d')))
                in_range = False
        current += step

    if in_range and entry_dt:
        results.append((entry_dt.strftime('%Y-%m-%d'), current.strftime('%Y-%m-%d')))

    return results


# ─────────────────────────────────────────────────────────────────────────────
# Events to compute
# ─────────────────────────────────────────────────────────────────────────────

START = datetime(2020, 1, 1, tzinfo=timezone.utc)
END = datetime(2027, 12, 31, tzinfo=timezone.utc)

# For Mercury-Sun helio: "Sun" in heliocentric = Earth's position
# Swiss Ephemeris: use swe.EARTH for Earth's heliocentric longitude
EARTH_ID = swe.EARTH if hasattr(swe, 'EARTH') else swe.SUN


def main():
    # Set Lahiri ayanamsa for sidereal computations
    swe.set_sid_mode(swe.SIDM_LAHIRI, 0, 0)

    all_results = {}

    print("Computing Mercury Helio transits...")
    mercury_helio_events = [
        ("72% DOWN Mercury Helio 14°10' Canc → 26°39' Canc", 'DOWN', '72%',
         sign_deg_to_lon(14, 10, 'Canc'), sign_deg_to_lon(26, 39, 'Canc')),
        ("62% DOWN Mercury Helio 00°08' Lib → 29°26' Sco", 'DOWN', '62%',
         sign_deg_to_lon(0, 8, 'Lib'), sign_deg_to_lon(29, 26, 'Sco')),
        ("76% UP Mercury Helio 22°07' Aqu → 26°34' Pis", 'UP', '76%',
         sign_deg_to_lon(22, 7, 'Aqu'), sign_deg_to_lon(26, 34, 'Pis')),
        ("76% UP Mercury Helio 02°04' Leo → 15°55' Leo", 'UP', '76%',
         sign_deg_to_lon(2, 4, 'Leo'), sign_deg_to_lon(15, 55, 'Leo')),
    ]

    for label, direction, prob, s_lon, e_lon in mercury_helio_events:
        print(f"  {label} [{s_lon:.2f}° → {e_lon:.2f}°]")
        dates = find_single_planet_transits(swe.MERCURY, s_lon, e_lon, START, END,
                                            helio=True, step_hours=2)
        all_results[label] = {
            'direction': direction, 'probability': prob,
            'start_lon': round(s_lon, 3), 'end_lon': round(e_lon, 3),
            'dates': dates, 'count': len(dates),
        }
        print(f"    Found {len(dates)} transits")

    print("\nComputing Mercury-Sun Helio (angular diff) transits...")
    # Mercury-Sun helio = (Mercury helio lon - Earth helio lon) mod 360
    mercury_sun_events = [
        ("74% DOWN Mercury-Sun Helio 249°28' → 268°25'", 'DOWN', '74%',
         249 + 28/60.0, 268 + 25/60.0),
        ("68% DOWN Mercury-Sun Helio 187°26' → 216°46'", 'DOWN', '68%',
         187 + 26/60.0, 216 + 46/60.0),
        ("83% UP Mercury-Sun Helio 61°07' → 146°21'", 'UP', '83%',
         61 + 7/60.0, 146 + 21/60.0),
        ("74% UP Mercury-Sun Helio 03°09' → 27°23'", 'UP', '74%',
         3 + 9/60.0, 27 + 23/60.0),
    ]

    for label, direction, prob, s_angle, e_angle in mercury_sun_events:
        print(f"  {label} [{s_angle:.2f}° → {e_angle:.2f}°]")
        dates = find_angular_diff_transits(swe.MERCURY, EARTH_ID, s_angle, e_angle,
                                           START, END, helio=True, step_hours=2)
        all_results[label] = {
            'direction': direction, 'probability': prob,
            'start_angle': round(s_angle, 3), 'end_angle': round(e_angle, 3),
            'dates': dates, 'count': len(dates),
        }
        print(f"    Found {len(dates)} transits")

    print("\nComputing Moon-N.Node (geocentric) transit...")
    # Moon - North Node angular difference, geocentric tropical
    moon_node_events = [
        ("59% DOWN Moon-N.Node 221°17' → 95°18'", 'DOWN', '59%',
         221 + 17/60.0, 95 + 18/60.0),  # wraps through 0°
    ]

    for label, direction, prob, s_angle, e_angle in moon_node_events:
        print(f"  {label} [{s_angle:.2f}° → {e_angle:.2f}°]")
        dates = find_angular_diff_transits(swe.MOON, swe.MEAN_NODE, s_angle, e_angle,
                                           START, END, helio=False, sidereal=False,
                                           step_hours=1)
        all_results[label] = {
            'direction': direction, 'probability': prob,
            'start_angle': round(s_angle, 3), 'end_angle': round(e_angle, 3),
            'dates': dates, 'count': len(dates),
        }
        print(f"    Found {len(dates)} transits")

    # Print as formatted output for embedding
    print("\n" + "=" * 90)
    print("RESULTS FOR EMBEDDING AS PRESETS")
    print("=" * 90)

    for label, data in all_results.items():
        print(f"\n{'─' * 80}")
        print(f"  {data['probability']} {data['direction']} {label}")
        if 'start_lon' in data:
            print(f"  Longitude: {data['start_lon']}° → {data['end_lon']}°")
        else:
            print(f"  Angular diff: {data['start_angle']}° → {data['end_angle']}°")
        print(f"  Transits: {data['count']}")
        print(f"  dates: [")
        for entry, exit_d in data['dates']:
            print(f"    ['{entry}', '{exit_d}'],")
        print(f"  ]")

    # Also write JSON file
    output_path = os.path.join(os.path.dirname(__file__), 'transit_presets.json')
    with open(output_path, 'w') as f:
        json.dump(all_results, f, indent=2)
    print(f"\nJSON written to: {output_path}")


if __name__ == '__main__':
    main()
