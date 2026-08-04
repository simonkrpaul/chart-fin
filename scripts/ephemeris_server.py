"""
Ephemeris API Server – lightweight Flask server that computes planetary dates
using pyswisseph and returns them as JSON for the chart-fin frontend.

Endpoints:
  POST /api/ephemeris/dates
    Request body:
      {
        "start_date": "2025-01-01",
        "end_date": "2025-12-31",
        "planet1": "Sun",
        "planet2": "Moon",
        "aspect": 0,          // degrees (0=conjunction, 90=square, 120=trine, 180=opposition)
        "orb": 1.0,           // tolerance in degrees
        "ayanamsa": "Lahiri", // or "Raman", "Krishnamurti", "Fagan/Bradley", "Tropical"
        "step_minutes": 60,   // calculation step (finer = more precise)
        "location": { "lat": 28.6139, "lon": 77.2090 }  // optional, for Ascendant
      }
    Response:
      {
        "dates": [
          { "timestamp": 1706745600000, "label": "Sun ☌ Moon", "planet1_deg": 12.34, "planet2_deg": 12.50 },
          ...
        ]
      }

  POST /api/ephemeris/rising
    Request body:
      {
        "start_date": "2025-05-01",
        "end_date": "2025-08-30",
        "node": "Rahu",       // or "Ketu"
        "orb": 1.0,
        "location": { "lat": 28.6139, "lon": 77.2090 },
        "ayanamsa": "Lahiri"
      }
    Response:
      {
        "dates": [
          { "timestamp": 1706745600000, "label": "Rahu Rising", "asc_deg": 45.2, "node_deg": 45.8 },
          ...
        ]
      }

Run:
  pip install flask flask-cors pyswisseph
  python scripts/ephemeris_server.py
"""

import sys
import os
from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime, timedelta, timezone

try:
    import swisseph as swe
except ImportError:
    print("ERROR: pyswisseph not installed. Run: pip install pyswisseph")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Try common ephemeris file paths
EPHE_PATHS = [
    os.path.expanduser('~/Dev/swisseph/ephe'),
    os.path.expanduser('~/swisseph/ephe'),
    '/usr/local/share/swisseph/ephe',
    '/usr/share/swisseph/ephe',
]

for path in EPHE_PATHS:
    if os.path.isdir(path):
        swe.set_ephe_path(path)
        break

# Planet name → Swiss Ephemeris constant
PLANETS = {
    "Sun": swe.SUN,
    "Moon": swe.MOON,
    "Mercury": swe.MERCURY,
    "Venus": swe.VENUS,
    "Mars": swe.MARS,
    "Jupiter": swe.JUPITER,
    "Saturn": swe.SATURN,
    "Uranus": swe.URANUS,
    "Neptune": swe.NEPTUNE,
    "Pluto": swe.PLUTO,
    "Rahu": swe.MEAN_NODE,
    "True Rahu": swe.TRUE_NODE,
}

AYANAMSAS = {
    "Lahiri": swe.SIDM_LAHIRI,
    "Raman": swe.SIDM_RAMAN,
    "Krishnamurti": swe.SIDM_KRISHNAMURTI,
    "Fagan/Bradley": swe.SIDM_FAGAN_BRADLEY,
    "Tropical": None,
}

ASPECT_SYMBOLS = {
    0: "☌",    # conjunction
    60: "⚹",   # sextile
    90: "□",   # square
    120: "△",  # trine
    180: "☍",  # opposition
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def datetime_to_jd(dt):
    """Convert datetime to Julian date."""
    return swe.julday(dt.year, dt.month, dt.day,
                      dt.hour + dt.minute / 60.0 + dt.second / 3600.0)


def calc_position(jd, planet_id, sidereal=True):
    """Calculate planet longitude."""
    flags = swe.FLG_SWIEPH
    if sidereal:
        flags |= swe.FLG_SIDEREAL
    pos = swe.calc_ut(jd, planet_id, flags)
    return pos[0][0]


def angular_diff(a, b):
    """Shortest angular difference between two angles."""
    d = abs(a - b) % 360
    return min(d, 360 - d)


def parse_date(s):
    """Parse ISO date string to datetime."""
    for fmt in ('%Y-%m-%d', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M:%SZ'):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise ValueError(f"Cannot parse date: {s}")


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------

app = Flask(__name__)
CORS(app)


@app.route('/api/ephemeris/dates', methods=['POST'])
def find_aspect_dates():
    """Find dates when two planets form a specific aspect."""
    body = request.get_json(force=True)

    start = parse_date(body['start_date'])
    end = parse_date(body['end_date'])
    planet1_name = body.get('planet1', 'Sun')
    planet2_name = body.get('planet2', 'Moon')
    aspect_angle = float(body.get('aspect', 0))
    orb = float(body.get('orb', 1.0))
    ayanamsa = body.get('ayanamsa', 'Lahiri')
    step_minutes = int(body.get('step_minutes', 60))

    # Set ayanamsa
    sidereal = True
    if ayanamsa == 'Tropical':
        sidereal = False
    else:
        ay_id = AYANAMSAS.get(ayanamsa, swe.SIDM_LAHIRI)
        swe.set_sid_mode(ay_id, 0, 0)

    # Resolve planet IDs (handle Ketu specially)
    def resolve_planet(name):
        if name == 'Ketu':
            return 'Ketu'
        if name not in PLANETS:
            return None
        return PLANETS[name]

    p1_id = resolve_planet(planet1_name)
    p2_id = resolve_planet(planet2_name)

    if p1_id is None or p2_id is None:
        return jsonify({'error': f'Unknown planet: {planet1_name} or {planet2_name}'}), 400

    # Scan
    results = []
    current = start
    step = timedelta(minutes=step_minutes)
    prev_diff = None
    in_orb = False

    while current <= end:
        jd = datetime_to_jd(current)

        # Get positions
        if p1_id == 'Ketu':
            rahu_pos = calc_position(jd, swe.MEAN_NODE, sidereal)
            pos1 = (rahu_pos + 180) % 360
        else:
            pos1 = calc_position(jd, p1_id, sidereal)

        if p2_id == 'Ketu':
            rahu_pos = calc_position(jd, swe.MEAN_NODE, sidereal)
            pos2 = (rahu_pos + 180) % 360
        else:
            pos2 = calc_position(jd, p2_id, sidereal)

        diff = angular_diff(pos1, pos2)
        within = abs(diff - aspect_angle) <= orb

        # Detect entry into aspect (avoid duplicate entries for same aspect event)
        if within and not in_orb:
            symbol = ASPECT_SYMBOLS.get(int(aspect_angle), f"{int(aspect_angle)}°")
            results.append({
                'timestamp': int(current.timestamp() * 1000),
                'date': current.strftime('%Y-%m-%d %H:%M UTC'),
                'label': f"{planet1_name} {symbol} {planet2_name}",
                'planet1_deg': round(pos1, 4),
                'planet2_deg': round(pos2, 4),
                'exact_diff': round(diff, 4),
            })
            in_orb = True
        elif not within:
            in_orb = False

        current += step

    return jsonify({'dates': results})


@app.route('/api/ephemeris/rising', methods=['POST'])
def find_rising_dates():
    """Find dates when Rahu/Ketu is on the Ascendant."""
    body = request.get_json(force=True)

    start = parse_date(body['start_date'])
    end = parse_date(body['end_date'])
    node = body.get('node', 'Rahu')
    orb = float(body.get('orb', 1.0))
    location = body.get('location', {'lat': 28.6139, 'lon': 77.2090})
    ayanamsa = body.get('ayanamsa', 'Lahiri')
    step_minutes = int(body.get('step_minutes', 10))

    lat = float(location['lat'])
    lon = float(location['lon'])

    # Set ayanamsa
    sidereal = True
    if ayanamsa == 'Tropical':
        sidereal = False
    else:
        ay_id = AYANAMSAS.get(ayanamsa, swe.SIDM_LAHIRI)
        swe.set_sid_mode(ay_id, 0, 0)

    results = []
    current = start
    step = timedelta(minutes=step_minutes)
    in_orb = False

    while current <= end:
        jd = datetime_to_jd(current)

        # Ascendant
        cusps, ascmc = swe.houses(jd, lat, lon, b'P')
        asc_tropical = ascmc[0]
        if sidereal:
            ayan_val = swe.get_ayanamsa_ut(jd)
            asc = (asc_tropical - ayan_val) % 360
        else:
            asc = asc_tropical

        # Node position
        rahu_pos = calc_position(jd, swe.MEAN_NODE, sidereal)
        if node == 'Ketu':
            node_pos = (rahu_pos + 180) % 360
        else:
            node_pos = rahu_pos

        diff = angular_diff(asc, node_pos)
        within = diff <= orb

        if within and not in_orb:
            results.append({
                'timestamp': int(current.timestamp() * 1000),
                'date': current.strftime('%Y-%m-%d %H:%M UTC'),
                'label': f"{node} Rising",
                'asc_deg': round(asc, 4),
                'node_deg': round(node_pos, 4),
            })
            in_orb = True
        elif not within:
            in_orb = False

        current += step

    return jsonify({'dates': results})


@app.route('/api/ephemeris/planets', methods=['GET'])
def list_planets():
    """Return available planets."""
    planets = list(PLANETS.keys()) + ['Ketu']
    return jsonify({'planets': planets})


@app.route('/api/ephemeris/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


# ─────────────────────────────────────────────────────────────────────────────
# Heliocentric Transit Zone computation
# ─────────────────────────────────────────────────────────────────────────────

SIGN_OFFSETS = {
    'Ari': 0, 'Tau': 30, 'Gem': 60, 'Can': 90, 'Leo': 120, 'Vir': 150,
    'Lib': 180, 'Sco': 210, 'Sag': 240, 'Cap': 270, 'Aqu': 300, 'Pis': 330,
}


def parse_dms_sign(deg_min_str, sign_str):
    """Parse '28°11' + 'Gem' -> absolute ecliptic longitude."""
    s = deg_min_str.strip().replace("'", "").replace("\u2019", "")
    parts = s.split('\u00b0') if '\u00b0' in s else s.split('.')
    degrees = int(parts[0])
    minutes = int(parts[1]) if len(parts) > 1 and parts[1] else 0
    sign_offset = SIGN_OFFSETS.get(sign_str.strip()[:3], None)
    if sign_offset is None:
        raise ValueError(f"Unknown sign: {sign_str}")
    return sign_offset + degrees + minutes / 60.0


def helio_longitude(jd, planet_id):
    """Get heliocentric tropical longitude."""
    flags = swe.FLG_SWIEPH | swe.FLG_HELCTR
    pos = swe.calc_ut(jd, planet_id, flags)
    return pos[0][0]


def angle_in_range(angle, start_lon, end_lon):
    """Check if angle is in [start, end] with wrap-around."""
    angle = angle % 360
    start_lon = start_lon % 360
    end_lon = end_lon % 360
    if start_lon <= end_lon:
        return start_lon <= angle <= end_lon
    else:
        return angle >= start_lon or angle <= end_lon


@app.route('/api/ephemeris/helio-transit', methods=['POST'])
def find_helio_transit():
    """
    Find date ranges when a planet's longitude (or angular difference between two
    planets) is within a degree range.

    Supports:
      - Heliocentric (tropical)
      - Sidereal (Lahiri)
      - Tropical (geocentric)
      - Angular difference mode (planet2 specified)

    Request body:
      {
        "planet": "Venus",
        "planet2": "",              // if set, computes (planet1 - planet2) angular diff
        "coordinate": "heliocentric",  // "heliocentric" | "sidereal_lahiri" | "tropical"
        "start_deg": 28, "start_min": 11, "start_sign": "Gem",
        "end_deg": 17, "end_min": 35, "end_sign": "Leo",
        "start_angle": null,        // for angular diff mode (raw degrees, overrides sign-based)
        "end_angle": null,
        "scan_start": "2020-01-01",
        "scan_end": "2027-12-31",
        "step_hours": 4
      }
    """
    body = request.get_json(force=True)

    planet_name = body.get('planet', 'Venus')
    # Handle N.Node
    if planet_name == 'N.Node' or planet_name == 'Rahu' or planet_name == 'Rahu (Mean Node)':
        planet_id = swe.MEAN_NODE
    elif planet_name == 'True Rahu' or planet_name == 'Rahu (True Node)':
        planet_id = swe.TRUE_NODE
    elif planet_name == 'Ketu':
        planet_id = 'Ketu'  # handled specially below
    else:
        planet_id = PLANETS.get(planet_name)
    if planet_id is None:
        return jsonify({'error': f'Unknown planet: {planet_name}'}), 400

    planet2_name = body.get('planet2', '') or ''
    planet2_id = None
    if planet2_name:
        if planet2_name == 'N.Node' or planet2_name == 'Rahu' or planet2_name == 'Rahu (Mean Node)':
            planet2_id = swe.MEAN_NODE
        elif planet2_name == 'True Rahu' or planet2_name == 'Rahu (True Node)':
            planet2_id = swe.TRUE_NODE
        elif planet2_name == 'Ketu':
            planet2_id = 'Ketu'
        else:
            planet2_id = PLANETS.get(planet2_name)
        if planet2_id is None:
            return jsonify({'error': f'Unknown planet2: {planet2_name}'}), 400

    coordinate = body.get('coordinate', 'heliocentric')

    # Determine start/end angles
    start_angle_raw = body.get('start_angle')
    end_angle_raw = body.get('end_angle')

    if start_angle_raw is not None and end_angle_raw is not None:
        # Angular diff mode with raw degree values
        start_lon = float(start_angle_raw)
        end_lon = float(end_angle_raw)
    else:
        start_deg = int(body.get('start_deg', 0))
        start_min = int(body.get('start_min', 0))
        start_sign = body.get('start_sign', 'Ari') or 'Ari'
        end_deg = int(body.get('end_deg', 0))
        end_min = int(body.get('end_min', 0))
        end_sign = body.get('end_sign', 'Ari') or 'Ari'
        start_lon = SIGN_OFFSETS.get(start_sign[:3], 0) + start_deg + start_min / 60.0
        end_lon = SIGN_OFFSETS.get(end_sign[:3], 0) + end_deg + end_min / 60.0

    scan_start = parse_date(body.get('scan_start', '2020-01-01'))
    scan_end = parse_date(body.get('scan_end', '2027-12-31'))
    step_hours = int(body.get('step_hours', 4))

    # Set up ayanamsa for sidereal
    use_helio = (coordinate == 'heliocentric')
    use_sidereal = (coordinate == 'sidereal_lahiri')
    if use_sidereal:
        swe.set_sid_mode(swe.SIDM_LAHIRI, 0, 0)

    def get_longitude(jd, pid):
        if pid == 'Ketu':
            # Ketu is 180° opposite Rahu (Mean Node)
            rahu_lon = get_longitude(jd, swe.MEAN_NODE)
            return (rahu_lon + 180) % 360
        if use_helio:
            flags = swe.FLG_SWIEPH | swe.FLG_HELCTR
        elif use_sidereal:
            flags = swe.FLG_SWIEPH | swe.FLG_SIDEREAL
        else:
            flags = swe.FLG_SWIEPH
        pos = swe.calc_ut(jd, pid, flags)
        return pos[0][0]

    step = timedelta(hours=step_hours)
    results = []
    current = scan_start
    in_range = False
    entry_dt = None

    while current <= scan_end:
        jd = datetime_to_jd(current)

        if planet2_id is not None:
            # Angular difference mode
            lon1 = get_longitude(jd, planet_id)
            lon2 = get_longitude(jd, planet2_id)
            lon = (lon1 - lon2) % 360
        else:
            lon = get_longitude(jd, planet_id)

        if angle_in_range(lon, start_lon, end_lon):
            if not in_range:
                entry_dt = current
                in_range = True
        else:
            if in_range and entry_dt:
                results.append({
                    'entry': entry_dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
                    'exit': current.strftime('%Y-%m-%dT%H:%M:%SZ'),
                    'entry_ts': int(entry_dt.timestamp() * 1000),
                    'exit_ts': int(current.timestamp() * 1000),
                })
                in_range = False
        current += step

    # Flush trailing
    if in_range and entry_dt:
        results.append({
            'entry': entry_dt.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'exit': current.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'entry_ts': int(entry_dt.timestamp() * 1000),
            'exit_ts': int(current.timestamp() * 1000),
        })

    return jsonify({
        'zones': results,
        'start_lon': round(start_lon, 3),
        'end_lon': round(end_lon, 3),
        'count': len(results),
        'coordinate': coordinate,
        'planet': planet_name,
        'planet2': planet2_name or None,
    })


if __name__ == '__main__':
    print("Ephemeris API Server starting on http://127.0.0.1:5050")
    print("Endpoints:")
    print("  POST /api/ephemeris/dates         – find aspect dates")
    print("  POST /api/ephemeris/rising        – find node rising dates")
    print("  POST /api/ephemeris/helio-transit  – find helio transit zones")
    print("  GET  /api/ephemeris/planets       – list available planets")
    app.run(host='127.0.0.1', port=5050, debug=True)
