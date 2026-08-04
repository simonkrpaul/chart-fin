#!/usr/bin/env python3
"""
Tokyo Session Open Analysis
----------------------------
Analyzes BTC 1-min data over the past 5 years to determine how often
price moves UP vs DOWN in the first 30-40 minutes of the Tokyo session.

Tokyo session open: 9:00 AM JST = 00:00 UTC
Window analyzed: first 30 and 40 minutes after open.
"""

import csv
import os
from datetime import datetime, timezone, timedelta
from collections import defaultdict

DATA_FILE = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'btc_1m.csv')

# Tokyo session opens at 9:00 JST = 00:00 UTC
TOKYO_OPEN_HOUR_UTC = 0
TOKYO_OPEN_MINUTE_UTC = 0

# Only look at last 5 years
CUTOFF = datetime(2021, 7, 1, tzinfo=timezone.utc)

def main():
    print("Loading BTC 1-min data (last 5 years)...")
    print(f"Data file: {os.path.abspath(DATA_FILE)}")
    
    # Group candles by date, only keep 00:00 - 00:39 UTC window
    # Key: date string -> list of (minute_offset, open, high, low, close)
    sessions = defaultdict(list)
    
    cutoff_ms = int(CUTOFF.timestamp() * 1000)
    
    with open(DATA_FILE, 'r') as f:
        reader = csv.reader(f)
        header = next(reader)  # skip header
        
        for row in reader:
            ts_ms = int(row[0])
            if ts_ms < cutoff_ms:
                continue
            
            dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
            
            # Only keep candles in the 00:00 - 00:39 UTC window (Tokyo 9:00 - 9:39)
            if dt.hour == 0 and dt.minute < 40:
                date_key = dt.strftime('%Y-%m-%d')
                sessions[date_key].append({
                    'minute': dt.minute,
                    'open': float(row[1]),
                    'high': float(row[2]),
                    'low': float(row[3]),
                    'close': float(row[4]),
                })
    
    print(f"Found {len(sessions)} Tokyo session days in the data.\n")
    
    # Analyze each session
    results_30 = {'up': 0, 'down': 0, 'flat': 0}
    results_40 = {'up': 0, 'down': 0, 'flat': 0}
    
    moves_30 = []  # (date, pct_change)
    moves_40 = []
    
    # Year-by-year breakdown
    yearly_30 = defaultdict(lambda: {'up': 0, 'down': 0, 'flat': 0})
    yearly_40 = defaultdict(lambda: {'up': 0, 'down': 0, 'flat': 0})
    
    # Day-of-week breakdown
    dow_30 = defaultdict(lambda: {'up': 0, 'down': 0, 'flat': 0})
    
    for date_key in sorted(sessions.keys()):
        candles = sorted(sessions[date_key], key=lambda c: c['minute'])
        
        if not candles or candles[0]['minute'] != 0:
            continue  # skip if we don't have the opening candle
        
        open_price = candles[0]['open']
        year = date_key[:4]
        dt = datetime.strptime(date_key, '%Y-%m-%d')
        dow = dt.strftime('%A')
        
        # 30-min window
        candles_30 = [c for c in candles if c['minute'] < 30]
        if len(candles_30) >= 25:  # need at least ~25 candles for valid 30-min window
            close_30 = candles_30[-1]['close']
            pct_30 = ((close_30 - open_price) / open_price) * 100
            moves_30.append((date_key, pct_30))
            
            if pct_30 > 0.01:
                results_30['up'] += 1
                yearly_30[year]['up'] += 1
                dow_30[dow]['up'] += 1
            elif pct_30 < -0.01:
                results_30['down'] += 1
                yearly_30[year]['down'] += 1
                dow_30[dow]['down'] += 1
            else:
                results_30['flat'] += 1
                yearly_30[year]['flat'] += 1
                dow_30[dow]['flat'] += 1
        
        # 40-min window
        candles_40 = [c for c in candles if c['minute'] < 40]
        if len(candles_40) >= 35:  # need at least ~35 candles for valid 40-min window
            close_40 = candles_40[-1]['close']
            pct_40 = ((close_40 - open_price) / open_price) * 100
            moves_40.append((date_key, pct_40))
            
            if pct_40 > 0.01:
                results_40['up'] += 1
                yearly_40[year]['up'] += 1
            elif pct_40 < -0.01:
                results_40['down'] += 1
                yearly_40[year]['down'] += 1
            else:
                results_40['flat'] += 1
                yearly_40[year]['flat'] += 1
    
    # Print results
    print("=" * 70)
    print("  TOKYO SESSION OPEN ANALYSIS (9:00 JST / 00:00 UTC)")
    print("  Period: Last 5 years (July 2021 – July 2026)")
    print("=" * 70)
    
    total_30 = results_30['up'] + results_30['down'] + results_30['flat']
    total_40 = results_40['up'] + results_40['down'] + results_40['flat']
    
    print(f"\n{'─' * 70}")
    print(f"  FIRST 30 MINUTES (9:00 – 9:30 JST)")
    print(f"{'─' * 70}")
    print(f"  Total sessions analyzed: {total_30}")
    print(f"  UP   (price rose):   {results_30['up']:>5}  ({results_30['up']/total_30*100:.1f}%)")
    print(f"  DOWN (price fell):   {results_30['down']:>5}  ({results_30['down']/total_30*100:.1f}%)")
    print(f"  FLAT (< 0.01%):      {results_30['flat']:>5}  ({results_30['flat']/total_30*100:.1f}%)")
    
    if moves_30:
        avg_up = [m[1] for m in moves_30 if m[1] > 0]
        avg_dn = [m[1] for m in moves_30 if m[1] < 0]
        print(f"\n  Avg UP move:   +{sum(avg_up)/len(avg_up):.3f}%")
        print(f"  Avg DOWN move: {sum(avg_dn)/len(avg_dn):.3f}%")
        print(f"  Max UP:   +{max(m[1] for m in moves_30):.3f}%")
        print(f"  Max DOWN: {min(m[1] for m in moves_30):.3f}%")
    
    print(f"\n{'─' * 70}")
    print(f"  FIRST 40 MINUTES (9:00 – 9:40 JST)")
    print(f"{'─' * 70}")
    print(f"  Total sessions analyzed: {total_40}")
    print(f"  UP   (price rose):   {results_40['up']:>5}  ({results_40['up']/total_40*100:.1f}%)")
    print(f"  DOWN (price fell):   {results_40['down']:>5}  ({results_40['down']/total_40*100:.1f}%)")
    print(f"  FLAT (< 0.01%):      {results_40['flat']:>5}  ({results_40['flat']/total_40*100:.1f}%)")
    
    if moves_40:
        avg_up = [m[1] for m in moves_40 if m[1] > 0]
        avg_dn = [m[1] for m in moves_40 if m[1] < 0]
        print(f"\n  Avg UP move:   +{sum(avg_up)/len(avg_up):.3f}%")
        print(f"  Avg DOWN move: {sum(avg_dn)/len(avg_dn):.3f}%")
        print(f"  Max UP:   +{max(m[1] for m in moves_40):.3f}%")
        print(f"  Max DOWN: {min(m[1] for m in moves_40):.3f}%")
    
    # Year-by-year breakdown
    print(f"\n{'─' * 70}")
    print(f"  YEAR-BY-YEAR BREAKDOWN (30-min window)")
    print(f"{'─' * 70}")
    print(f"  {'Year':<6} {'UP':>6} {'DOWN':>6} {'FLAT':>6} {'UP%':>7} {'DOWN%':>7}")
    for year in sorted(yearly_30.keys()):
        y = yearly_30[year]
        t = y['up'] + y['down'] + y['flat']
        print(f"  {year:<6} {y['up']:>6} {y['down']:>6} {y['flat']:>6} {y['up']/t*100:>6.1f}% {y['down']/t*100:>6.1f}%")
    
    # Day-of-week breakdown
    print(f"\n{'─' * 70}")
    print(f"  DAY-OF-WEEK BREAKDOWN (30-min window)")
    print(f"{'─' * 70}")
    print(f"  {'Day':<12} {'UP':>6} {'DOWN':>6} {'FLAT':>6} {'UP%':>7} {'DOWN%':>7}")
    for day in ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']:
        d = dow_30[day]
        t = d['up'] + d['down'] + d['flat']
        if t > 0:
            print(f"  {day:<12} {d['up']:>6} {d['down']:>6} {d['flat']:>6} {d['up']/t*100:>6.1f}% {d['down']/t*100:>6.1f}%")
    
    print(f"\n{'─' * 70}")
    print("  NOTE: 'flat' = price moved less than 0.01% (essentially no direction)")
    print(f"{'─' * 70}")


if __name__ == '__main__':
    main()
