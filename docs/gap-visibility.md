# Trading Days vs Calendar Days (Gap Visibility)

The toolbar has **two** gap-visibility modes for intraday and daily
charts. The setting looks cosmetic but silently changes the *slot index
space* every overlay, indicator, offset calculator and cycle engine
operates on. This note explains what happens under the hood and how each
feature responds.

- **Default:** Calendar Days (weekends + holidays visible as spacer
  columns; overnight periods still removed).
- **Toolbar button:** upper toolbar — click to toggle
  `Calendar Days ↔ Trading Days`.
- **State keys** in `chartStore.ts`:
  - `gapVisibility: 'session_trading_days' | 'session_calendar_days'` — source of truth.
  - `showEmptyGapSlots: boolean` — legacy alias, `true` when
    `gapVisibility === 'session_calendar_days'` (used by the renderer's
    underscore-glyph logic and weekend/holiday shading).

## The two modes

### `session_calendar_days` — Calendar Days *(default)*

- **Keeps:** trading-hour candles (`trading`, `halfday`, `gap`) **plus**
  the weekend/holiday placeholder columns *inside the session hours*.
- **Drops:** overnight (`outside_session`) on trading days — so US-equity
  16:00 is still followed by 09:30 next-trading-day rather than 400
  empty overnight columns.
- **Result:** Fri close → Sat placeholder (session-hour width) → Sun
  placeholder (session-hour width) → Mon open. Each weekend day has the
  same visual width as a trading day, so day-to-day alignment is
  preserved without wasting space on nights.

### `session_trading_days` — Trading Days

- **Keeps:** only real trading-session candles.
- **Drops:** overnight (`outside_session`), weekend, holiday, and any
  real mid-session data gaps.
- **Result:** Friday 16:00 close is followed immediately by Monday 09:30
  open in the same visual column. Zero empty columns anywhere.

## How it works

Both modes start from the same **generated slot array**. For any
intraday timeframe on a non-24/7 market (US equities, ASX, futures) the
calendar engine (`src/engine/calendarEngine.ts` → `generateIntradaySlots`)
fills every calendar day with a full 24-hour ladder at the timeframe
cadence and tags each slot with a status:

| Status              | Meaning                                            |
| ------------------- | -------------------------------------------------- |
| `trading`           | Inside session hours, has (or could have) a candle |
| `halfday`           | Early close (e.g. NYSE day-after-Thanksgiving)     |
| `outside_session`   | Between session close and next open                |
| `weekend`           | Sat / Sun                                          |
| `holiday`           | Full-day market closure                            |
| `gap`               | Real data gap (missing bar inside a trading day)   |

The filter (`src/store/chartStore.ts` → `_applyGapVisibility`) picks
which of these survive:

```ts
function _applyGapVisibility(slots, mode, session, timeframe) {
  if (mode === 'session_trading_days') {
    return slots.filter(s => s.candle !== null)
                .map((s, i) => ({ ...s, slotIndex: i }));
  }
  // session_calendar_days
  const openMin  = toMinutes(session.regularOpen);
  const closeMin = toMinutes(session.regularClose);
  const tfMin    = TIMEFRAME_MINUTES[timeframe];
  return slots.filter(s => {
    if (s.status === 'outside_session') return false;
    if (s.status === 'trading' || s.status === 'halfday' || s.status === 'gap') return true;
    if (s.status === 'weekend' || s.status === 'holiday') {
      // Overlap check: the slot bucket [start, start+tf) overlaps the
      // session window [open, close). Uses LOCAL wall-clock fields —
      // never getUTCHours() — because toZonedTime() returns a Date whose
      // local fields carry the wall-clock time in the target tz.
      const local = toZonedTime(new Date(s.timestamp), session.timezone);
      const startMin = local.getHours() * 60 + local.getMinutes();
      const endMin   = startMin + tfMin;
      return startMin < closeMin && endMin > openMin;
    }
    return true;
  }).map((s, i) => ({ ...s, slotIndex: i }));
}
```

### Session-boundary overlap semantics

The intraday slot generator uses the same overlap rule so a slot that
partly overlaps the session window is marked `trading`:

```ts
// generateIntradaySlots — slot at ts covers [ts, ts+tfMs)
if (ts < sessionCloseMs && ts + tfMs > sessionOpenMs) status = 'trading';
```

Why this matters: on a **1h chart with a 09:30 session open**, the slot
at 09:00 covers 09:00–10:00 and therefore captures the aggregated
09:30–09:59 opening bar. Without the overlap rule the 09:00 slot would
be marked `outside_session`, its candle would be dropped in both modes,
and the entire opening hour would disappear from the chart.

The same overlap rule is applied to weekend/holiday placeholders in
Calendar Days mode, so their slot count exactly matches the trading-day
slot count at every timeframe (e.g. 7 slots per day on 1h with a 09:30–
16:00 session).

## Slot space semantics

| Aspect                                       | Trading Days                              | Calendar Days                                              |
| -------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| **x-axis** is                                | Ordinal trading sequence                  | Session-hour packed, weekends as spacers                    |
| **1 slot = ...**                             | 1 trading bar                             | 1 timeframe unit during session hours                       |
| **Bars per day (US eq 1m, session 6.5h)**    | ~390 on trading days                      | ~390 on every calendar day (trading OR weekend placeholder) |
| **Bars per 30 days (US eq 1m)**              | ~8 200                                    | ~11 700 (adds ~9 weekend days of placeholders)              |
| **Overnight (post-close) columns visible**   | No                                        | No                                                          |
| **Weekend columns visible**                  | No                                        | Yes (as session-hour-wide empty spacer)                     |
| **Fri close → Mon open distance**            | 1 column                                  | ~780 empty spacer columns (2 × session bars)                |
| **Wall-clock alignment across days**         | Not preserved                             | Preserved within session hours                              |

## Impact per subsystem

### 1. Plotting

- **Candles / volume**: same numeric OHLCV; the packing differs.
- **Session shading**: renders correctly in both modes.
- **Indicators** (SMA, EMA, RSI, MACD, BBANDS, ATR, Swing HL, S/R, Sessions,
  Moon Signals, etc.) iterate over slots, not clock time. Their computed
  values do **not** change when you toggle. Their visual span does.
- **Drawings**: anchored by timestamp, snap to the correct slot in either
  mode.

### 2. Offset Overlays (offset calculator)

The offset engine (`src/engine/offsetEngine.ts`) shifts a historical
window forward by a timestamp delta and lands each projected candle on
the nearest live slot.

| Question                                  | Trading Days                                       | Calendar Days                                                              |
| ----------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| Where does the overlay bar land?          | Nearest trading slot to the projected timestamp    | Same, but a weekend placeholder counts as a valid landing slot             |
| "N days ago" comparison feel              | N × ~390 slots forward (irregular clock time)      | N × ~390 slots forward (clock-aligned within session hours)                |
| Weekend projection                        | Snaps to Fri close or Mon open                     | Renders on the corresponding weekend placeholder column                    |
| Best for                                  | "N trading bars later" pattern comparison          | Same-clock-time comparison across a longer wall-clock window (with weekends) |

### 3. Cycle Combiner

Values come from timestamp lookups on `rawCandles`; identical numbers in
both modes. The forward projection buffer length is measured in slots.
Since Calendar Days has more slots per calendar day (adds weekend
spacers), the same forward duration projects into fewer *trading* slots
but the same wall-clock window.

### 4. Hurst Cycles

Periods are measured in **bars**. On a 1m US-equity chart with a 6.5-hour
session:

| Concept                             | Trading Days                               | Calendar Days                                            |
| ----------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| 20-bar period                       | 20 trading bars ≈ 3 % of a trading day     | 20 slots ≈ 3 % of a calendar day (session-hour scale)    |
| Hurst 54-week Nominal Model (270 d) | Interpretable as 270 trading days on 1d TF | Same on 1d TF; on 1m TF add weekend padding when scaling |

For intraday charts stick with Trading Days when running Hurst analysis —
it makes 5-day / 10-day / 20-day / 45-day periods map cleanly to the
Nominal Model.

### 5. Ephemeris markers & Custom Transit Zones

Timestamp-anchored — the marker always lands on the slot whose timestamp
is closest. Events during overnight windows can't be shown at all
because overnight is dropped in both modes. Events that happen on a
Saturday snap to the nearest trading slot in Trading Days (Fri close or
Mon open) but land on the weekend spacer column in Calendar Days.

### 6. Backtest engine

Iterates over slots. In both modes the strategy only ever sees real
trading candles — Trading Days drops all null-candle slots, Calendar
Days keeps weekend spacers as null-candle slots that the built-in
strategies skip. P&L is identical. Custom strategies that read
`slots[i]` unconditionally should guard with
`if (!slots[i].candle) continue`.

### 7. Trade Journal

Uses timestamps only. Both modes render identically because entries and
exits snap by nearest timestamp.

## Memory & performance

- Trading Days: ~8 200 slots for 30 days of 1m equities.
- Calendar Days: ~11 700 slots for the same range (~40 % more).
- Both easily fit under 100 k slots for months of data, so pan/zoom
  performance is virtually identical.

## Decision matrix

| Scenario                                                       | Recommended         |
| -------------------------------------------------------------- | ------------------- |
| Everyday intraday chart, focus on trading action               | Trading Days        |
| Pattern comparison across trading days (no weekend distractions) | Trading Days        |
| Offset comparisons in trading-bar units                        | Trading Days        |
| Weekly / cyclical visualisation where weekends matter          | Calendar Days       |
| Wall-clock alignment across weeks with weekend spacers         | Calendar Days       |
| Correlating trading action with a 24/7 asset (BTC/EUR)         | Calendar Days       |
| Hurst analysis on intraday equities                            | Trading Days        |
| Backtesting a strategy that trades only regular hours          | Either              |

## Under-the-hood references

- Slot generation: [src/engine/calendarEngine.ts](../src/engine/calendarEngine.ts) → `generateIntradaySlots`, `generateDailySlots`.
- Filter: [src/store/chartStore.ts](../src/store/chartStore.ts) → `_applyGapVisibility` (two-mode filter, session-aware).
- Toolbar toggle: [src/components/Toolbar.tsx](../src/components/Toolbar.tsx) → `gapVisibility` button.
- Default: [src/store/chartStore.ts](../src/store/chartStore.ts) → initial state `gapVisibility: 'session_trading_days'`.
- Programmatic setter: `useChartStore().setGapVisibility(mode)`.
- Offset math: [src/engine/offsetEngine.ts](../src/engine/offsetEngine.ts) → `buildOffsetOverlay`.
- Cycle combiner math: [src/store/chartStore.ts](../src/store/chartStore.ts) → `recomputeCycleCombiner`.
- Hurst engine: [src/hurst/engine.ts](../src/hurst/engine.ts) → `centeredSMA`, `computeFld`, `detectTroughs`.
