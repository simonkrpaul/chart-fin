#!/usr/bin/env python3
"""
Tokyo Session Backtest: Mean-Reversion Strategy
-------------------------------------------------
Strategy:
  - Look at the 30 minutes BEFORE Tokyo open (23:30–00:00 UTC / 8:30–9:00 JST)
  - If that pre-session window is UP → SHORT at Tokyo open, hold for 35 min
  - If that pre-session window is DOWN → LONG at Tokyo open, hold for 35 min

This tests the hypothesis that a pre-session move tends to reverse at session open.
"""

import csv
import os
from datetime import datetime, timezone, timedelta
from collections import defaultdict

DATA_FILE = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'btc_1m.csv')

# Only look at last 10 years
CUTOFF = datetime(2016, 7, 1, tzinfo=timezone.utc)

# Parameters
PRE_SESSION_MINUTES = 30    # look-back window before Tokyo open
HOLD_MINUTES = 35           # how long to hold the trade after open
FLAT_THRESHOLD = 0.01       # % — ignore if pre-session move is < this


def main():
    print("Loading BTC 1-min data (last 5 years)...")
    
    cutoff_ms = int(CUTOFF.timestamp() * 1000)
    
    # We need candles from 23:30–00:34 UTC each day
    # 23:30-23:59 = pre-session (30 min before 00:00 UTC Tokyo open)
    # 00:00-00:34 = trade window (35 min hold)
    
    # Group by date: for pre-session we use the PREVIOUS calendar day's 23:xx candles
    # and the current day's 00:xx candles for the trade
    
    # Store all relevant candles indexed by (date, hour, minute)
    candles_by_time = {}
    
    with open(DATA_FILE, 'r') as f:
        reader = csv.reader(f)
        next(reader)  # skip header
        
        for row in reader:
            ts_ms = int(row[0])
            if ts_ms < cutoff_ms - 86400000:  # need day before cutoff too
                continue
            
            dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
            
            # Only keep 23:30-23:59 and 00:00-00:34
            if (dt.hour == 23 and dt.minute >= 30) or (dt.hour == 0 and dt.minute < 35):
                key = (dt.year, dt.month, dt.day, dt.hour, dt.minute)
                candles_by_time[key] = {
                    'open': float(row[1]),
                    'high': float(row[2]),
                    'low': float(row[3]),
                    'close': float(row[4]),
                }
    
    print(f"Loaded relevant candles. Analyzing trades...\n")
    
    # Now iterate through dates
    start_date = CUTOFF.date()
    end_date = datetime(2026, 7, 3, tzinfo=timezone.utc).date()
    
    trades = []
    
    current = start_date
    while current <= end_date:
        # Pre-session: previous day 23:30–23:59 UTC
        prev_day = current - timedelta(days=1)
        
        # Get pre-session candles (23:30 to 23:59 of previous day)
        pre_candles = []
        for m in range(30, 60):
            key = (prev_day.year, prev_day.month, prev_day.day, 23, m)
            if key in candles_by_time:
                pre_candles.append((m, candles_by_time[key]))
        
        # Get trade window candles (00:00 to 00:34 of current day)
        trade_candles = []
        for m in range(0, 35):
            key = (current.year, current.month, current.day, 0, m)
            if key in candles_by_time:
                trade_candles.append((m, candles_by_time[key]))
        
        # Need sufficient data in both windows
        if len(pre_candles) >= 25 and len(trade_candles) >= 30:
            pre_open = pre_candles[0][1]['open']
            pre_close = pre_candles[-1][1]['close']
            pre_move_pct = ((pre_close - pre_open) / pre_open) * 100
            
            # Entry at Tokyo open
            entry_price = trade_candles[0][1]['open']
            exit_price = trade_candles[-1][1]['close']
            
            # Track high/low during trade for drawdown
            trade_high = max(c[1]['high'] for c in trade_candles)
            trade_low = min(c[1]['low'] for c in trade_candles)
            
            if abs(pre_move_pct) >= FLAT_THRESHOLD:
                if pre_move_pct > 0:
                    # Pre-session UP → SHORT
                    direction = 'SHORT'
                    pnl_pct = ((entry_price - exit_price) / entry_price) * 100
                    max_adverse = ((trade_high - entry_price) / entry_price) * 100  # worst case for short
                    max_favorable = ((entry_price - trade_low) / entry_price) * 100
                else:
                    # Pre-session DOWN → LONG
                    direction = 'LONG'
                    pnl_pct = ((exit_price - entry_price) / entry_price) * 100
                    max_adverse = ((entry_price - trade_low) / entry_price) * 100  # worst case for long
                    max_favorable = ((trade_high - entry_price) / entry_price) * 100
                
                trades.append({
                    'date': current.isoformat(),
                    'direction': direction,
                    'pre_move_pct': pre_move_pct,
                    'entry': entry_price,
                    'exit': exit_price,
                    'pnl_pct': pnl_pct,
                    'max_adverse': max_adverse,
                    'max_favorable': max_favorable,
                    'year': current.year,
                    'dow': current.strftime('%A'),
                })
        
        current += timedelta(days=1)
    
    # ─── RESULTS ───────────────────────────────────────────────────────────────
    
    total = len(trades)
    winners = [t for t in trades if t['pnl_pct'] > 0]
    losers = [t for t in trades if t['pnl_pct'] < 0]
    
    shorts = [t for t in trades if t['direction'] == 'SHORT']
    longs = [t for t in trades if t['direction'] == 'LONG']
    
    short_winners = [t for t in shorts if t['pnl_pct'] > 0]
    long_winners = [t for t in longs if t['pnl_pct'] > 0]
    
    print("=" * 70)
    print("  TOKYO OPEN MEAN-REVERSION BACKTEST")
    print("  Strategy: Fade the 30-min pre-session move, hold 35 min")
    print(f"  Period: July 2016 – July 2026 ({total} trades)")
    print("=" * 70)
    
    print(f"\n{'─' * 70}")
    print(f"  OVERALL RESULTS")
    print(f"{'─' * 70}")
    print(f"  Total trades:       {total}")
    print(f"  Winners:            {len(winners)} ({len(winners)/total*100:.1f}%)")
    print(f"  Losers:             {len(losers)} ({len(losers)/total*100:.1f}%)")
    print(f"  Win rate:           {len(winners)/total*100:.1f}%")
    
    total_pnl = sum(t['pnl_pct'] for t in trades)
    avg_pnl = total_pnl / total
    avg_win = sum(t['pnl_pct'] for t in winners) / len(winners) if winners else 0
    avg_loss = sum(t['pnl_pct'] for t in losers) / len(losers) if losers else 0
    
    print(f"\n  Total PnL:          {total_pnl:+.2f}%")
    print(f"  Avg trade:          {avg_pnl:+.4f}%")
    print(f"  Avg winner:         {avg_win:+.4f}%")
    print(f"  Avg loser:          {avg_loss:+.4f}%")
    print(f"  Profit factor:      {abs(sum(t['pnl_pct'] for t in winners) / sum(t['pnl_pct'] for t in losers)):.2f}" if losers else "  Profit factor:      ∞")
    print(f"  Expectancy/trade:   {avg_pnl:+.4f}%")
    
    print(f"  Best trade:         {max(t['pnl_pct'] for t in trades):+.3f}%")
    print(f"  Worst trade:        {min(t['pnl_pct'] for t in trades):+.3f}%")
    print(f"  Avg max adverse:    -{sum(t['max_adverse'] for t in trades)/total:.3f}%")
    print(f"  Avg max favorable:  +{sum(t['max_favorable'] for t in trades)/total:.3f}%")
    
    # ─── SHORT vs LONG breakdown ──────────────────────────────────────────────
    print(f"\n{'─' * 70}")
    print(f"  SHORT TRADES (pre-session was UP → fade with short)")
    print(f"{'─' * 70}")
    print(f"  Total:    {len(shorts)}")
    print(f"  Winners:  {len(short_winners)} ({len(short_winners)/len(shorts)*100:.1f}%)")
    print(f"  Avg PnL:  {sum(t['pnl_pct'] for t in shorts)/len(shorts):+.4f}%")
    print(f"  Total PnL:{sum(t['pnl_pct'] for t in shorts):+.2f}%")
    short_wins = [t for t in shorts if t['pnl_pct'] > 0]
    short_losses = [t for t in shorts if t['pnl_pct'] < 0]
    if short_wins:
        print(f"  Avg win:  {sum(t['pnl_pct'] for t in short_wins)/len(short_wins):+.4f}%")
    if short_losses:
        print(f"  Avg loss: {sum(t['pnl_pct'] for t in short_losses)/len(short_losses):+.4f}%")
    
    print(f"\n{'─' * 70}")
    print(f"  LONG TRADES (pre-session was DOWN → fade with long)")
    print(f"{'─' * 70}")
    print(f"  Total:    {len(longs)}")
    print(f"  Winners:  {len(long_winners)} ({len(long_winners)/len(longs)*100:.1f}%)")
    print(f"  Avg PnL:  {sum(t['pnl_pct'] for t in longs)/len(longs):+.4f}%")
    print(f"  Total PnL:{sum(t['pnl_pct'] for t in longs):+.2f}%")
    long_wins = [t for t in longs if t['pnl_pct'] > 0]
    long_losses = [t for t in longs if t['pnl_pct'] < 0]
    if long_wins:
        print(f"  Avg win:  {sum(t['pnl_pct'] for t in long_wins)/len(long_wins):+.4f}%")
    if long_losses:
        print(f"  Avg loss: {sum(t['pnl_pct'] for t in long_losses)/len(long_losses):+.4f}%")
    
    # ─── YEAR-BY-YEAR ─────────────────────────────────────────────────────────
    print(f"\n{'─' * 70}")
    print(f"  YEAR-BY-YEAR BREAKDOWN")
    print(f"{'─' * 70}")
    print(f"  {'Year':<6} {'Trades':>7} {'Wins':>6} {'WR%':>7} {'Total PnL':>10} {'Avg PnL':>9}")
    
    years = sorted(set(t['year'] for t in trades))
    for year in years:
        yt = [t for t in trades if t['year'] == year]
        yw = [t for t in yt if t['pnl_pct'] > 0]
        y_pnl = sum(t['pnl_pct'] for t in yt)
        print(f"  {year:<6} {len(yt):>7} {len(yw):>6} {len(yw)/len(yt)*100:>6.1f}% {y_pnl:>+9.2f}% {y_pnl/len(yt):>+8.4f}%")
    
    # ─── DAY-OF-WEEK ──────────────────────────────────────────────────────────
    print(f"\n{'─' * 70}")
    print(f"  DAY-OF-WEEK BREAKDOWN")
    print(f"{'─' * 70}")
    print(f"  {'Day':<12} {'Trades':>7} {'Wins':>6} {'WR%':>7} {'Total PnL':>10} {'Avg PnL':>9}")
    
    for day in ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']:
        dt_trades = [t for t in trades if t['dow'] == day]
        if dt_trades:
            dw = [t for t in dt_trades if t['pnl_pct'] > 0]
            d_pnl = sum(t['pnl_pct'] for t in dt_trades)
            print(f"  {day:<12} {len(dt_trades):>7} {len(dw):>6} {len(dw)/len(dt_trades)*100:>6.1f}% {d_pnl:>+9.2f}% {d_pnl/len(dt_trades):>+8.4f}%")
    
    # ─── FILTER: Only trade when pre-move is strong ───────────────────────────
    print(f"\n{'─' * 70}")
    print(f"  FILTERED: Only when pre-session move > 0.1%")
    print(f"{'─' * 70}")
    
    strong = [t for t in trades if abs(t['pre_move_pct']) > 0.1]
    strong_w = [t for t in strong if t['pnl_pct'] > 0]
    if strong:
        strong_pnl = sum(t['pnl_pct'] for t in strong)
        print(f"  Trades:    {len(strong)}")
        print(f"  Win rate:  {len(strong_w)/len(strong)*100:.1f}%")
        print(f"  Total PnL: {strong_pnl:+.2f}%")
        print(f"  Avg PnL:   {strong_pnl/len(strong):+.4f}%")
    
    very_strong = [t for t in trades if abs(t['pre_move_pct']) > 0.2]
    very_strong_w = [t for t in very_strong if t['pnl_pct'] > 0]
    if very_strong:
        vs_pnl = sum(t['pnl_pct'] for t in very_strong)
        print(f"\n  FILTERED: Only when pre-session move > 0.2%")
        print(f"  Trades:    {len(very_strong)}")
        print(f"  Win rate:  {len(very_strong_w)/len(very_strong)*100:.1f}%")
        print(f"  Total PnL: {vs_pnl:+.2f}%")
        print(f"  Avg PnL:   {vs_pnl/len(very_strong):+.4f}%")
    
    extra_strong = [t for t in trades if abs(t['pre_move_pct']) > 0.3]
    extra_strong_w = [t for t in extra_strong if t['pnl_pct'] > 0]
    if extra_strong:
        es_pnl = sum(t['pnl_pct'] for t in extra_strong)
        print(f"\n  FILTERED: Only when pre-session move > 0.3%")
        print(f"  Trades:    {len(extra_strong)}")
        print(f"  Win rate:  {len(extra_strong_w)/len(extra_strong)*100:.1f}%")
        print(f"  Total PnL: {es_pnl:+.2f}%")
        print(f"  Avg PnL:   {es_pnl/len(extra_strong):+.4f}%")
    
    print(f"\n{'─' * 70}")
    print(f"  CONSECUTIVE WINS/LOSSES")
    print(f"{'─' * 70}")
    
    max_consec_wins = 0
    max_consec_losses = 0
    curr_wins = 0
    curr_losses = 0
    for t in trades:
        if t['pnl_pct'] > 0:
            curr_wins += 1
            curr_losses = 0
            max_consec_wins = max(max_consec_wins, curr_wins)
        else:
            curr_losses += 1
            curr_wins = 0
            max_consec_losses = max(max_consec_losses, curr_losses)
    
    print(f"  Max consecutive wins:   {max_consec_wins}")
    print(f"  Max consecutive losses: {max_consec_losses}")
    
    # Equity curve summary
    print(f"\n{'─' * 70}")
    print(f"  EQUITY CURVE (cumulative % PnL by quarter)")
    print(f"{'─' * 70}")
    
    cumulative = 0
    quarter_pnl = defaultdict(float)
    for t in trades:
        q = f"{t['year']}Q{(int(t['date'][5:7])-1)//3 + 1}"
        quarter_pnl[q] += t['pnl_pct']
    
    running = 0
    for q in sorted(quarter_pnl.keys()):
        running += quarter_pnl[q]
        bar_len = int(abs(quarter_pnl[q]) * 10)
        bar = ('█' * bar_len) if quarter_pnl[q] > 0 else ('░' * bar_len)
        sign = '+' if quarter_pnl[q] > 0 else ''
        print(f"  {q}  {sign}{quarter_pnl[q]:>6.2f}%  cum: {running:>+7.2f}%  {bar}")
    
    print(f"\n{'=' * 70}")


if __name__ == '__main__':
    main()
