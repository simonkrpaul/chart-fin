# chart-fin – Architecture & Product Design

## Overview

A professional financial charting application built on **React 19 + TypeScript + Vite**, rendering with a layered **Canvas 2D** strategy. Calendar-day alignment and historical offset comparison are first-class features.

---

## Folder Structure

```
src/
  types/
    index.ts              All TypeScript interfaces and type definitions
  engine/
    tzUtils.ts            Timezone-aware date arithmetic (no external tz dep)
    calendarEngine.ts     Slot generation, shiftByCalendarDays, gap detection
    normalizationEngine.ts  Merge raw OHLCV into slot arrays
    offsetEngine.ts       Historical overlay projection engine
    indicatorEngine.ts    SMA, EMA, VWAP, RSI, MACD, BBands, ATR
    measurementEngine.ts  Range statistics (bars, calendar days, %, volume)
  renderer/
    canvasRenderer.ts     Layered Canvas 2D render functions (pure, no React)
  store/
    chartStore.ts         Zustand store – all chart state + actions
  workers/
    chartWorker.ts        Web Worker that runs engine computations off-thread
  components/
    ChartCanvas.tsx       Canvas element + mouse/wheel interaction controller
    Toolbar.tsx           Timeframe switcher + drawing tool selector
    CandleTooltip.tsx     OHLCV readout at crosshair position
    OverlayPanel.tsx      Add/manage/configure historical offset overlays
    IndicatorPanel.tsx    Add/manage/configure indicator series
    MeasurementOverlay.tsx  Floating badge showing last measurement result
  hooks/
    useResizeObserver.ts  ResizeObserver hook for responsive canvas sizing
    useKeyboardShortcuts.ts  Global keyboard shortcut bindings
  utils/
    sampleData.ts         Synthetic OHLCV generator (development/demo only)
  App.tsx                 Root layout component
  main.tsx                React DOM entry
```

---

## Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Rendering | Canvas 2D | Fastest path to 60fps for large datasets; full pixel control; beats SVG at scale |
| State | Zustand + Immer | Minimal boilerplate; React-safe mutable drafts; no Redux ceremony |
| Dates | `date-fns` + native `Intl` | date-fns for arithmetic; Intl for TZ conversion without a multi-MB dep |
| Heavy compute | Web Worker | Slot generation, indicator math, overlay projection off main thread |
| Build | Vite 8 + Rolldown | Sub-2s hot reload; native ESM; sub-1.5s production build |
| Framework | React 19 | Concurrent features; hooks ergonomics; team familiarity |

**Why Canvas 2D over WebGL?**  
WebGL would allow larger datasets with GPU batching but adds substantial complexity (shaders, buffer management, picking logic). Canvas 2D comfortably handles 200k+ visible candles with viewport culling and typed arrays. A WebGL upgrade path exists by swapping out only `canvasRenderer.ts`.

**Why Canvas over SVG?**  
SVG DOM nodes per candle destroy performance above ~1000 candles. Canvas owns the pixel buffer and renders everything in one pass.

---

## Core Algorithms

### 1. Calendar Slot Generation (`calendarEngine.ts`)

```
generateSlots(startMs, endMs, timeframe, session) → CandleSlot[]

for each calendar day d in [startMs..endMs]:
  if d is weekend → emit ONE placeholder slot (status: 'weekend')
  if d is holiday → emit ONE placeholder slot (status: 'holiday')
  else:
    slotMs = session.open for d in tz
    closeMs = session.close for d in tz  (or half-day close)
    while slotMs < closeMs:
      emit CandleSlot { timestamp: slotMs, status: 'trading', candle: null }
      slotMs += timeframeMinutes * 60_000
```

Weekend/holiday placeholders use midnight local time as timestamp. They occupy one visual slot on the time axis and are shaded differently. They are **never collapsed** – this is the mechanism that makes "20 calendar days ago" mean exactly 20 calendar days.

### 2. Data Normalization (`normalizationEngine.ts`)

```
normalizeCandles(slots, raw) → CandleSlot[]

Build Map<timestamp, slotIndex> from slots  // O(n)
for each raw candle:
  if timestamp in map → slots[map[ts]].candle = candle  // O(1) lookup
  else → discard  // outside window
```

### 3. Historical Offset Projection (`offsetEngine.ts`)

```
buildOffsetOverlay(primarySlots, config, historicalCandles, session, tf):
  histSlots = generateSlots(config.sourceStartMs, config.sourceEndMs, tf, session)
  filled    = normalizeCandles(histSlots, historicalCandles)
  primaryIdx = Map<timestamp, slotIndex> from primarySlots

  for each slot in filled where slot.candle exists:
    projectedTs       = shiftByCalendarDays(slot.timestamp, config.calendarDayOffset, tz)
    projectedSlotIdx  = primaryIdx.get(projectedTs) ?? -1   // -1 = off-chart
    emit ProjectedCandle { originalTs, projectedTs, projectedSlotIdx, candle }
```

`shiftByCalendarDays` uses `date-fns/addDays` on the **local wall-clock** date in the exchange timezone, then converts back to UTC. This preserves intraday time correctly across DST transitions.

### 4. Indicator Computation

All indicators operate on `CandleSlot[]`. Null candles are handled per-type:
- SMA: skips nulls (window only counts real bars)
- EMA: carries forward the last valid EMA across null gaps
- VWAP: resets at each new calendar day boundary
- RSI/ATR/BBands: skip nulls, carry forward last value

### 5. Viewport Culling

```
firstSlot = viewport.firstSlotIndex
lastSlot  = firstSlot + viewport.visibleSlotCount - 1
// renderer only iterates slots[firstSlot..lastSlot]
// ProjectedCandles where projectedSlotIndex < firstSlot or > lastSlot are skipped
```

This ensures O(visible) render cost regardless of total dataset size.

---

## Data Model

### Primary vs. Derived Data

```
Raw provider data:  RawCandle[]          (timestamps from provider)
         ↓ generateSlots
Calendar grid:      CandleSlot[]         (every calendar interval exists)
         ↓ normalizeCandles
Filled grid:        CandleSlot[]         (candle filled where data exists)
         ↓ computeIndicator
Indicator series:   IndicatorSeries[]    (one value per slot)
         ↓ buildOffsetOverlay
Projected overlay:  ProjectedCandle[]    (original candles + shifted timestamps)
```

### Key Types

```typescript
// A single slot – always exists even for weekends/holidays
interface CandleSlot {
  slotIndex:  number;        // 0-based monotonic index
  timestamp:  number;        // UTC ms (canonical slot time)
  status:     SlotStatus;    // 'trading' | 'weekend' | 'holiday' | ...
  candle:     RawCandle | null;
}

// A historical candle projected to the present timeline
interface ProjectedCandle {
  originalTimestamp:   number;
  projectedTimestamp:  number;
  projectedSlotIndex:  number; // index into primarySlots (-1 if off-chart)
  candle:              RawCandle;
  normalizedValue?:    number;  // for percent/index modes
}
```

---

## Rendering Strategy

Six functional layers rendered in order during each frame:

```
1. renderBackground   – fills bg, draws grid lines, shades non-trading slots
2. renderCandles      – draws wicks + bodies using slotIndex→screenX projection
3. renderVolume       – draws volume bars in sub-pane
4. renderOverlays     – draws projected historical candles (hollow or line-only)
5. renderIndicators   – draws MA/VWAP lines connecting non-null indicator points
6. renderDrawings     – draws trendlines, rectangles, horizontals, measurements
7. renderCrosshair    – draws dashed crosshair + price/time labels
8. renderPriceAxis    – right axis with price labels
9. renderTimeAxis     – bottom axis with time/date labels
```

All functions are **pure** (`(RenderContext, data) → void`). The React component holds the `useCallback`-memoized render function that fires via `requestAnimationFrame`.

HiDPI: canvas physical size = logical size × `devicePixelRatio`. All coordinates are in logical pixels; the canvas context is scaled once at frame start.

---

## Overlay Visibility Strategy

For N simultaneous offset overlays:
- Each overlay uses a distinct color from the `OVERLAY_PALETTE`
- Opacity decreases slightly per overlay: `0.70, 0.62, 0.54, ...`
- Overlays are rendered as **hollow candles** (outline only, no fill) so the primary candles below remain visible
- `lineOnly` mode reduces to a dot/line trace, maximizing data density
- Each overlay has independent z-order control
- The `stacked` mode (future) renders each overlay in its own vertical lane below the main pane

---

## Performance Plan

| Technique | Applied |
|---|---|
| Viewport culling | Only iterate visible slots in all render loops |
| Canvas 2D pixel batching | One path per candle; no DOM per candle |
| HiDPI scaling | Single `ctx.scale(dpr,dpr)` per frame |
| `requestAnimationFrame` | Renders only when dirty state changes |
| `useCallback` memoization | Render fn not recreated unless data changes |
| Zustand shallow selectors | Components re-render only when their slice changes |
| Web Worker | Slot generation + indicator math off main thread |
| Immer draft mutations | No accidental object allocation in store updates |
| Typed Arrays (upgrade path) | Float64Array for price data; Int32Array for slot indices |

For 100k+ candle datasets: implement a `SlabCache` (circular buffer of slot arrays per slab of 10k candles) loaded on demand from the worker. Only the active viewport slab + adjacent slabs stay in memory.

---

## Interaction Model

| Action | Mechanism |
|---|---|
| Pan | `wheel` deltaX or deltaY → `pan(slotDelta)` |
| Zoom | `wheel` + Ctrl/Meta → `zoom(direction, anchorSlot)` |
| Draw trendline | mousedown → `startDrawing`, mousemove → `updateDrawingInProgress`, mouseup → `commitDrawing` |
| Draw horizontal | mousedown only → `startDrawing` + immediate `commitDrawing` |
| Undo/Redo | `past[]`/`future[]` snapshot stacks; ⌘Z / ⌘⇧Z |
| Crosshair | `mousemove` → `setCrosshair` → rerenders overlay layer |
| Measurement | rectangle draw → on commit, `measureRange` populates `lastMeasurement` |

---

## Edge Case Handling

| Edge Case | Solution |
|---|---|
| DST transition | `shiftByCalendarDays` converts to local wall-clock before adding days, then back to UTC – DST is absorbed transparently |
| Duplicate timestamps | `normalizeCandles` last-write-wins; dedup in `appendCandles` |
| Missing candles | `candle: null` – renderer skips body/wick; indicators respect null rules |
| Offset series off-chart | `projectedSlotIndex = -1`; renderer skips when out of viewport bounds |
| Extremely large datasets | Viewport culling + future SlabCache keeps memory flat |
| Timeframe switch with drawings | Drawings store `slotIndex` which becomes stale; recalculate by re-mapping stored `timestamp` → new slot index after regeneration |
| Multiple volatile regimes in overlay | Separate price scale per overlay in `percent`/`index100` mode; auto-fit excludes overlays when those modes are active |
| Half trading days | `halfDays: Record<string, {close: string}>` in `SessionConfig`; `slotsForDay` uses the early close time |

---

## API Contracts (future backend integration)

```
GET /api/ohlcv?symbol=SPY&tf=5m&start=<ms>&end=<ms>
→ { candles: RawCandle[] }

GET /api/ohlcv?symbol=SPY&tf=5m&start=<ms>&end=<ms>&offset=20d
→ { candles: RawCandle[], offsetCandles: RawCandle[] }

POST /api/layouts
Body: ChartLayout
→ { id: string }

GET /api/layouts/:id
→ ChartLayout

WS  /ws/ohlcv?symbol=SPY&tf=5m
→ streams RawCandle on each new bar close
```

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Escape` | Cancel drawing / switch to cursor |
| `T` | Trendline tool |
| `H` | Horizontal line |
| `R` | Rectangle |
| `M` | Measurement tool |
| `⌘Z` | Undo last drawing |
| `⌘⇧Z` | Redo |
| `⌘Y` | Redo (alt) |

---

## Future Enhancements

1. **WebGL renderer** – swap `canvasRenderer.ts` for a WebGL backend when >500k candles are needed
2. **SlabCache** – demand-loaded slot slabs for very long histories
3. **Plugin architecture** – `IndicatorPlugin` interface; community indicator registry
4. **Replay mode** – step forward bar-by-bar through historical data
5. **Multi-symbol comparison** – overlay different instruments
6. **Backend persistence** – REST API for layouts, drawings, watchlists
7. **Export** – PNG snapshot (`canvas.toDataURL`), CSV data export
8. **Accessibility** – keyboard navigation for crosshair, screen-reader OHLCV announcements
9. **Stacked lane mode** – each offset overlay in its own horizontal panel with synchronized scroll
10. **Alert engine** – price level alerts that trigger from the horizontal line drawing tool
