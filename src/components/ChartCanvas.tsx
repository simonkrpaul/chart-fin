/**
 * ChartCanvas – the main canvas element that wires viewport, slots, indicators,
 * overlays, drawings, and crosshair together into a single render loop.
 *
 * Uses requestAnimationFrame-based rendering with dirty-flag optimization:
 * only re-renders when relevant state changes.
 */
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { useChartStore } from '../store/chartStore';
import type { Drawing, DrawingPoint } from '../types';
import { measureRange } from '../engine/measurementEngine';
import {
  renderBackground,
  renderHourLabels,
  renderCandles,
  renderVolume,
  renderCycleCombiner,
  renderIndicators,
  renderOverlays,
  renderDrawings,
  renderCrosshair,
  renderReplayCursor,
  renderPriceAxis,
  renderTimeAxis,
  hitTestDrawings,
  hitTestPositionPart,
  hitTestFibPart,
  renderBacktestSignals,
  renderTradeLog,
  renderEphemerisMarkers,
  renderTransitZones,
} from '../renderer/canvasRenderer';

interface Props {
  width: number;
  height: number;
}

let nextDrawingId = () => crypto.randomUUID();

export const ChartCanvas: React.FC<Props> = ({ width, height }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const {
    primarySlots,
    viewport,
    priceScale,
    timeframe,
    session,
    indicatorConfigs,
    indicatorSeries,
    overlayConfigs,
    overlays,
    drawings,
    drawingInProgress,
    activeDrawingTool,
    crosshair,
    themeTokens,
    showIndicatorsAndDrawings,
    replay,
    setViewport,
    setCrosshair,
    zoom,
    pan,
    startDrawing,
    updateDrawingInProgress,
    commitDrawing,
    cancelDrawing,
    addBarPatternOverlay,
    startReplay,
    setDrawingTool,
    deleteDrawing,
    updateDrawing,
    measureSelectedRange,
    backtestSignals,
    backtestResult,
    showBacktestSignals,
    tradeLogRoundTrips,
    showTradeLog,
    ephemerisMarkers,
    showEphemerisMarkers,
    transitZoneGroups,
    cycleCombinerConfig,
    cycleCombinerOutput,
    panPrice,
    scalePrice,
    setPriceScale,
    resetPriceScale,
  } = useChartStore();

  // Bar-pattern drag state (ref to avoid re-renders mid-drag)
  const patternDragStart = useRef<number | null>(null);
  const patternDragEnd   = useRef<number | null>(null);

  // Drawing hover and context-menu state
  const hoveredDrawingId = useRef<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  type ContextMenu = { x: number; y: number; drawingId: string };
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  // Drag-to-pan state
  const dragPan = useRef<{ startX: number; startY: number; accumulated: number; onPriceAxis: boolean } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Prevents mouseup from committing a drawing on the same click that started it
  const justStartedDrawing = useRef(false);

  // Track hovered position part for cursor
  const hoveredPositionPart = useRef<'tp' | 'sl' | 'entry' | null>(null);

  // Drag-to-adjust committed drawings
  const draggingDrawing = useRef<{
    id: string;
    tool: string;
    anchor: 'start' | 'end' | 'entry' | 'body' | 'tp' | 'sl';
    startPrice: number;
    startSlotIndex: number;
    origDrawing: any;
  } | null>(null);

  useEffect(() => {
    if (!showIndicatorsAndDrawings) {
      hoveredDrawingId.current = null;
      setHoveredId(null);
      setContextMenu(null);
    }
  }, [showIndicatorsAndDrawings]);

  // Keep viewport size in sync with container
  useEffect(() => {
    const ph = height - 30 - 120; // subtract timeAxisHeight, subPaneHeight
    setViewport({ width, mainPaneHeight: ph });
  }, [width, height]);

  // ── Render loop ──────────────────────────────────────────────────────────

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d')!;
    ctx.save();
    ctx.scale(dpr, dpr);

    const rc = { ctx, viewport, priceScale, theme: themeTokens, dpr, timeframe, timezone: session.timezone, replayIndex: replay.active ? replay.index : undefined };
    const slotW = (viewport.width - viewport.priceAxisWidth) / viewport.visibleSlotCount;
    const allDrawings = showIndicatorsAndDrawings
      ? (drawingInProgress ? [...drawings, drawingInProgress] : drawings)
      : [];
    const visibleOverlays = showIndicatorsAndDrawings
      ? overlayConfigs
        .filter(c => c.visible)
        .map(c => overlays[c.id])
        .filter(Boolean)
      : [];
    const visibleIndicators = showIndicatorsAndDrawings
      ? indicatorConfigs
        .filter(c => c.visible)
        .map(c => indicatorSeries[c.id])
        .filter(Boolean)
      : [];

    renderBackground(rc, primarySlots);
    renderHourLabels(rc, primarySlots);
    renderCandles(rc, primarySlots);
    renderVolume(rc, primarySlots);
    if (cycleCombinerConfig.visible && cycleCombinerOutput) {
      renderCycleCombiner(rc, cycleCombinerOutput, cycleCombinerConfig.color);
    }
    renderOverlays(rc, visibleOverlays as any);
    renderIndicators(rc, visibleIndicators as any, primarySlots);
    renderDrawings(rc, allDrawings as Drawing[], primarySlots, hoveredId ?? undefined);

    // Backtest buy/sell arrows + P&L bands
    if (showBacktestSignals && backtestSignals.length > 0) {
      renderBacktestSignals(rc, backtestSignals, primarySlots, backtestResult?.trades);
    }

    // Trade journal markers + P&L bands
    if (showTradeLog && tradeLogRoundTrips.length > 0) {
      renderTradeLog(rc, tradeLogRoundTrips, primarySlots);
    }

    // Ephemeris planetary event markers
    if (showEphemerisMarkers && ephemerisMarkers.length > 0) {
      renderEphemerisMarkers(rc, ephemerisMarkers);
    }

    // Custom transit zone shading
    if (transitZoneGroups.length > 0) {
      renderTransitZones(rc, transitZoneGroups);
    }

    // Bar-pattern selection highlight
    if (
      activeDrawingTool === 'bar_pattern' &&
      patternDragStart.current !== null &&
      patternDragEnd.current !== null
    ) {
      const lo = Math.min(patternDragStart.current, patternDragEnd.current);
      const hi = Math.max(patternDragStart.current, patternDragEnd.current);
      const x1 = (lo - viewport.firstSlotIndex) * slotW;
      const x2 = (hi - viewport.firstSlotIndex + 1) * slotW;
      ctx.fillStyle = 'rgba(41,98,255,0.15)';
      ctx.fillRect(x1, 0, x2 - x1, viewport.mainPaneHeight + viewport.subPaneHeight);
      ctx.strokeStyle = '#2962ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1, 0, x2 - x1, viewport.mainPaneHeight + viewport.subPaneHeight);
      ctx.setLineDash([]);
    }

    renderReplayCursor(rc);
    renderPriceAxis(rc);
    renderTimeAxis(rc, primarySlots);
    renderCrosshair(rc, crosshair);

    ctx.restore();
  }, [
    primarySlots,
    viewport,
    priceScale,
    indicatorConfigs,
    indicatorSeries,
    overlayConfigs,
    overlays,
    drawings,
    drawingInProgress,
    crosshair,
    themeTokens,
    activeDrawingTool,
    replay,
    showIndicatorsAndDrawings,
    hoveredId,
    backtestSignals,
    showBacktestSignals,
  ]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, [render]);

  // ── Canvas sizing (HiDPI) ────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }, [width, height]);

  // ── Pointer helpers ──────────────────────────────────────────────────────

  const sw = (viewport.width - viewport.priceAxisWidth) / viewport.visibleSlotCount;

  function screenXToSlotIndex(x: number): number {
    return Math.floor(x / sw) + viewport.firstSlotIndex;
  }

  function screenYToPrice(y: number): number {
    const { min, max } = priceScale;
    return max - (y / viewport.mainPaneHeight) * (max - min);
  }

  function snapToSlot(slotIndex: number): DrawingPoint {
    const clamped = Math.max(0, Math.min(primarySlots.length - 1, slotIndex));
    const slot = primarySlots[clamped];
    return {
      slotIndex: clamped,
      timestamp: slot?.timestamp ?? 0,
      price: slot?.candle?.close ?? screenYToPrice(crosshair.y),
    };
  }

  // ── Mouse / touch events ─────────────────────────────────────────────────

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const si = screenXToSlotIndex(x);
      const price = screenYToPrice(y);

      // Resolve timestamp: for virtual future slots (beyond last primary slot) extrapolate
      const slots = primarySlots;
      let ts: number;
      if (si >= 0 && si < slots.length) {
        ts = slots[si].timestamp;
      } else if (slots.length > 1) {
        const avgMs = (slots[slots.length - 1].timestamp - slots[0].timestamp) / (slots.length - 1);
        ts = slots[slots.length - 1].timestamp + (si - slots.length + 1) * avgMs;
      } else {
        ts = slots[slots.length - 1]?.timestamp ?? 0;
      }

      setCrosshair({ visible: true, slotIndex: si, timestamp: ts, price, x, y });

      if (activeDrawingTool === 'bar_pattern') {
        if (patternDragStart.current !== null) {
          patternDragEnd.current = si;
        }
        return;
      }

      // Drag-to-pan: accumulate pixel delta and pan in whole-slot increments
      if (dragPan.current !== null) {
        const yDelta = dragPan.current.startY - y; // positive = dragged up = prices shift up

        if (dragPan.current.onPriceAxis) {
          // Vertical drag on price axis → scale price range
          if (Math.abs(yDelta) > 0) {
            const factor = 1 + yDelta / viewport.mainPaneHeight;
            scalePrice(Math.max(0.05, factor));
            dragPan.current.startY = y;
          }
          return;
        }

        // Horizontal pan
        const pixelDelta = dragPan.current.startX - x; // positive = pan right (older bars)
        dragPan.current.accumulated += pixelDelta / sw;
        const slots = Math.round(dragPan.current.accumulated);
        if (slots !== 0) {
          pan(slots);
          dragPan.current.accumulated -= slots;
        }
        dragPan.current.startX = x;

        // Vertical pan
        if (Math.abs(yDelta) > 0) {
          const range = priceScale.max - priceScale.min;
          panPrice((yDelta / viewport.mainPaneHeight) * range);
          dragPan.current.startY = y;
        }
        return;
      }

      // Hit-test drawings for hover highlight + cursor change (cursor mode only)
      if (showIndicatorsAndDrawings && activeDrawingTool === 'none' && !draggingDrawing.current) {
        const hit = hitTestDrawings(x, y, drawings, viewport, priceScale);
        if (hit !== hoveredDrawingId.current) {
          hoveredDrawingId.current = hit;
          setHoveredId(hit);
        }
        // Detect position part for cursor
        if (hit) {
          const d = drawings.find(dr => dr.id === hit);
          if (d && (d.tool === 'long_position' || d.tool === 'short_position')) {
            hoveredPositionPart.current = hitTestPositionPart(y, d, viewport, priceScale);
          } else {
            hoveredPositionPart.current = null;
          }
        } else {
          hoveredPositionPart.current = null;
        }
      } else if (hoveredDrawingId.current !== null && !draggingDrawing.current) {
        hoveredDrawingId.current = null;
        hoveredPositionPart.current = null;
        setHoveredId(null);
      }

      // Drag-to-adjust a committed drawing
      if (draggingDrawing.current) {
        const dd = draggingDrawing.current;
        const orig = dd.origDrawing;
        const priceDelta = price - dd.startPrice;
        const slotDelta = si - dd.startSlotIndex;

        switch (dd.tool) {
          case 'trendline': {
            const newStart = { ...orig.start, price: orig.start.price + priceDelta, slotIndex: orig.start.slotIndex + slotDelta };
            const newEnd = { ...orig.end, price: orig.end.price + priceDelta, slotIndex: orig.end.slotIndex + slotDelta };
            newStart.timestamp = primarySlots[newStart.slotIndex]?.timestamp ?? newStart.timestamp;
            newEnd.timestamp = primarySlots[newEnd.slotIndex]?.timestamp ?? newEnd.timestamp;
            updateDrawing(dd.id, { start: newStart, end: newEnd } as any);
            break;
          }
          case 'horizontal': {
            updateDrawing(dd.id, { price: orig.price + priceDelta } as any);
            break;
          }
          case 'vertical': {
            const newSi = orig.slotIndex + slotDelta;
            updateDrawing(dd.id, { slotIndex: newSi, timestamp: primarySlots[newSi]?.timestamp ?? orig.timestamp } as any);
            break;
          }
          case 'rectangle': {
            const newTL = { ...orig.topLeft, price: orig.topLeft.price + priceDelta, slotIndex: orig.topLeft.slotIndex + slotDelta };
            const newBR = { ...orig.bottomRight, price: orig.bottomRight.price + priceDelta, slotIndex: orig.bottomRight.slotIndex + slotDelta };
            newTL.timestamp = primarySlots[newTL.slotIndex]?.timestamp ?? newTL.timestamp;
            newBR.timestamp = primarySlots[newBR.slotIndex]?.timestamp ?? newBR.timestamp;
            updateDrawing(dd.id, { topLeft: newTL, bottomRight: newBR } as any);
            break;
          }
          case 'measurement': {
            const newStart = { ...orig.start, price: orig.start.price + priceDelta, slotIndex: orig.start.slotIndex + slotDelta };
            const newEnd = { ...orig.end, price: orig.end.price + priceDelta, slotIndex: orig.end.slotIndex + slotDelta };
            newStart.timestamp = primarySlots[newStart.slotIndex]?.timestamp ?? newStart.timestamp;
            newEnd.timestamp = primarySlots[newEnd.slotIndex]?.timestamp ?? newEnd.timestamp;
            updateDrawing(dd.id, { start: newStart, end: newEnd } as any);
            break;
          }
          case 'fibonacci': {
            if (dd.anchor === 'start') {
              // Drag only the start anchor
              const newStart = { ...orig.start, price: orig.start.price + priceDelta, slotIndex: orig.start.slotIndex + slotDelta };
              newStart.timestamp = primarySlots[newStart.slotIndex]?.timestamp ?? newStart.timestamp;
              updateDrawing(dd.id, { start: newStart } as any);
            } else if (dd.anchor === 'end') {
              // Drag only the end anchor
              const newEnd = { ...orig.end, price: orig.end.price + priceDelta, slotIndex: orig.end.slotIndex + slotDelta };
              newEnd.timestamp = primarySlots[newEnd.slotIndex]?.timestamp ?? newEnd.timestamp;
              updateDrawing(dd.id, { end: newEnd } as any);
            } else {
              // Move entire drawing
              const newStart = { ...orig.start, price: orig.start.price + priceDelta, slotIndex: orig.start.slotIndex + slotDelta };
              const newEnd = { ...orig.end, price: orig.end.price + priceDelta, slotIndex: orig.end.slotIndex + slotDelta };
              newStart.timestamp = primarySlots[newStart.slotIndex]?.timestamp ?? newStart.timestamp;
              newEnd.timestamp = primarySlots[newEnd.slotIndex]?.timestamp ?? newEnd.timestamp;
              updateDrawing(dd.id, { start: newStart, end: newEnd } as any);
            }
            break;
          }
          case 'long_position':
          case 'short_position': {
            if (dd.anchor === 'tp') {
              // Drag only TP price independently
              updateDrawing(dd.id, { tpPrice: orig.tpPrice + priceDelta } as any);
            } else if (dd.anchor === 'sl') {
              // Drag only SL price independently
              updateDrawing(dd.id, { slPrice: orig.slPrice + priceDelta } as any);
            } else if (dd.anchor === 'entry') {
              // Move entry, keep TP/SL distances the same
              const newEntry = { ...orig.entry, price: orig.entry.price + priceDelta, slotIndex: orig.entry.slotIndex + slotDelta };
              newEntry.timestamp = primarySlots[newEntry.slotIndex]?.timestamp ?? newEntry.timestamp;
              updateDrawing(dd.id, {
                entry: newEntry,
                tpPrice: orig.tpPrice + priceDelta,
                slPrice: orig.slPrice + priceDelta,
              } as any);
            } else {
              // Move the whole drawing
              const newEntry = { ...orig.entry, price: orig.entry.price + priceDelta, slotIndex: orig.entry.slotIndex + slotDelta };
              const newEnd = { ...orig.end, price: orig.end.price + priceDelta, slotIndex: orig.end.slotIndex + slotDelta };
              newEntry.timestamp = primarySlots[newEntry.slotIndex]?.timestamp ?? newEntry.timestamp;
              newEnd.timestamp = primarySlots[newEnd.slotIndex]?.timestamp ?? newEnd.timestamp;
              updateDrawing(dd.id, {
                entry: newEntry,
                end: newEnd,
                tpPrice: orig.tpPrice + priceDelta,
                slPrice: orig.slPrice + priceDelta,
              } as any);
            }
            // Recompute R:R
            const d = drawings.find(dr => dr.id === dd.id) as any;
            if (d) {
              const risk = Math.abs(d.entry.price - d.slPrice);
              const reward = Math.abs(d.tpPrice - d.entry.price);
              if (risk > 0) updateDrawing(dd.id, { riskReward: reward / risk } as any);
            }
            break;
          }
        }
        return;
      }

      if (drawingInProgress && activeDrawingTool !== 'none') {
        const p = { slotIndex: si, timestamp: primarySlots[si]?.timestamp ?? 0, price };
        const updated = { ...drawingInProgress } as any;
        switch (activeDrawingTool) {
          case 'trendline':
          case 'measurement':
          case 'fibonacci':
            updated.end = p;
            break;
          case 'rectangle':
            updated.bottomRight = p;
            break;
          case 'long_position':
          case 'short_position':
            updated.end = p;
            {
              const entry = updated.entry.price;
              const isLong = activeDrawingTool === 'long_position';
              // Drag determines TP directly; SL is on the opposite side
              // For LONG: drag above entry = TP, SL mirrors below
              // For SHORT: drag below entry = TP, SL mirrors above
              const dragPrice = price;
              let tp: number;
              let sl: number;
              if (isLong) {
                tp = Math.max(dragPrice, entry); // TP above entry
                sl = entry - Math.abs(tp - entry); // SL same distance below
              } else {
                tp = Math.min(dragPrice, entry); // TP below entry
                sl = entry + Math.abs(entry - tp); // SL same distance above
              }
              updated.tpPrice = tp;
              updated.slPrice = sl;
              const risk = Math.abs(entry - sl);
              const reward = Math.abs(tp - entry);
              updated.riskReward = risk > 0 ? reward / risk : 0;
            }
            break;
        }
        // For measurement: embed live stats so the canvas badge renders during drag
        if (activeDrawingTool === 'measurement' && updated.start) {
          updated.result = measureRange(
            primarySlots,
            updated.start.slotIndex,
            si,
            'UTC',
          );
          // Also update status bar live
          measureSelectedRange(updated.start.slotIndex, si);
        }
        updateDrawingInProgress(updated);
      }
    },
    [drawingInProgress, activeDrawingTool, primarySlots, viewport, priceScale, sw, showIndicatorsAndDrawings, updateDrawing, drawings],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const si = screenXToSlotIndex(x);
      const price = screenYToPrice(y);

      // In cursor mode, left-click drag = pan (unless over a drawing)
      if (activeDrawingTool === 'none' && e.button === 0) {
        const hit = hitTestDrawings(x, y, drawings, viewport, priceScale);
        if (showIndicatorsAndDrawings && hit) {
          // Start dragging a committed drawing
          const d = drawings.find(dr => dr.id === hit) as any;
          if (d && !d.locked) {
            // For position drawings, detect which part was hit (tp/sl/entry)
            let anchor: 'body' | 'tp' | 'sl' | 'entry' | 'start' | 'end' = 'body';
            if (d.tool === 'long_position' || d.tool === 'short_position') {
              const part = hitTestPositionPart(y, d, viewport, priceScale);
              if (part) anchor = part;
            } else if (d.tool === 'fibonacci') {
              const part = hitTestFibPart(x, y, d, viewport, priceScale);
              if (part) anchor = part;
            }
            draggingDrawing.current = {
              id: hit,
              tool: d.tool,
              anchor,
              startPrice: price,
              startSlotIndex: si,
              origDrawing: JSON.parse(JSON.stringify(d)),
            };
            setIsDragging(true);
            return;
          }
        }
        if (!showIndicatorsAndDrawings || !hit) {
          const onPriceAxis = x >= viewport.width - viewport.priceAxisWidth;
          dragPan.current = { startX: x, startY: y, accumulated: 0, onPriceAxis };
          setIsDragging(true);
          return;
        }
      }

      if (activeDrawingTool === 'none') return;

      if (activeDrawingTool === 'replay') {
        startReplay(si);
        setDrawingTool('none');
        return;
      }

      if (activeDrawingTool === 'bar_pattern') {
        patternDragStart.current = si;
        patternDragEnd.current = si;
        return;
      }

      // If a drawing is already in progress, the second click finalizes it
      if (drawingInProgress) {
        // Update the end point one last time
        const p = { slotIndex: si, timestamp: primarySlots[si]?.timestamp ?? 0, price };
        const updated = { ...drawingInProgress } as any;
        switch (activeDrawingTool) {
          case 'trendline':
          case 'measurement':
          case 'fibonacci':
            updated.end = p;
            break;
          case 'rectangle':
            updated.bottomRight = p;
            break;
          case 'long_position':
          case 'short_position': {
            updated.end = p;
            const entry = updated.entry.price;
            const isLong = activeDrawingTool === 'long_position';
            const dragPrice = price;
            let tp: number;
            let sl: number;
            if (isLong) {
              tp = Math.max(dragPrice, entry);
              sl = entry - Math.abs(tp - entry);
            } else {
              tp = Math.min(dragPrice, entry);
              sl = entry + Math.abs(entry - tp);
            }
            updated.tpPrice = tp;
            updated.slPrice = sl;
            const risk = Math.abs(entry - sl);
            const reward = Math.abs(tp - entry);
            updated.riskReward = risk > 0 ? reward / risk : 0;
            break;
          }
        }
        updateDrawingInProgress(updated);
        commitDrawing();
        setDrawingTool('none');
        justStartedDrawing.current = false;
        return;
      }

      const p: DrawingPoint = { slotIndex: si, timestamp: primarySlots[si]?.timestamp ?? 0, price };

      const base = {
        id: nextDrawingId(),
        color: '#f5c518',
        lineWidth: 1,
        visible: true,
        locked: false,
        zIndex: 0,
      };

      switch (activeDrawingTool) {
        case 'horizontal':
          startDrawing({ ...base, tool: 'horizontal', price });
          commitDrawing();
          setDrawingTool('none');
          break;
        case 'vertical':
          startDrawing({ ...base, tool: 'vertical', timestamp: p.timestamp, slotIndex: p.slotIndex });
          commitDrawing();
          setDrawingTool('none');
          break;
        case 'trendline':
          startDrawing({ ...base, tool: 'trendline', start: p, end: p, extendLeft: false, extendRight: false });
          justStartedDrawing.current = true;
          break;
        case 'rectangle':
          startDrawing({ ...base, tool: 'rectangle', topLeft: p, bottomRight: p, fillOpacity: 0.07 });
          justStartedDrawing.current = true;
          break;
        case 'measurement':
          startDrawing({ ...base, tool: 'measurement', start: p, end: p });
          justStartedDrawing.current = true;
          break;
        case 'fibonacci':
          startDrawing({ ...base, tool: 'fibonacci', start: p, end: p, levels: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1], extendRight: true });
          justStartedDrawing.current = true;
          break;
        case 'long_position':
          startDrawing({ ...base, tool: 'long_position', entry: p, end: p, tpPrice: price, slPrice: price, riskReward: 0 });
          justStartedDrawing.current = true;
          break;
        case 'short_position':
          startDrawing({ ...base, tool: 'short_position', entry: p, end: p, tpPrice: price, slPrice: price, riskReward: 0 });
          justStartedDrawing.current = true;
          break;
      }
    },
    [activeDrawingTool, primarySlots, viewport, priceScale, sw, showIndicatorsAndDrawings, drawingInProgress, commitDrawing, updateDrawingInProgress, setDrawingTool],
  );

  const handleMouseUp = useCallback(() => {
    // Stop drag-pan
    if (dragPan.current !== null) {
      dragPan.current = null;
      setIsDragging(false);
      return;
    }

    // Stop dragging a committed drawing
    if (draggingDrawing.current !== null) {
      draggingDrawing.current = null;
      setIsDragging(false);
      return;
    }

    if (activeDrawingTool === 'bar_pattern') {
      const start = patternDragStart.current;
      const end   = patternDragEnd.current;
      if (start !== null && end !== null && Math.abs(end - start) >= 2) {
        addBarPatternOverlay(start, end);
      }
      patternDragStart.current = null;
      patternDragEnd.current   = null;
      return;
    }

    // Don't commit on the same click that started the drawing
    if (justStartedDrawing.current) {
      justStartedDrawing.current = false;
      return;
    }

    if (drawingInProgress) {
      commitDrawing();
      setDrawingTool('none');
    }
  }, [drawingInProgress, activeDrawingTool, addBarPatternOverlay, setDrawingTool]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const onPriceAxis = x >= viewport.width - viewport.priceAxisWidth;

      if (onPriceAxis) {
        // Wheel on price axis → zoom price scale around the hovered price
        const anchorPrice = screenYToPrice(y);
        const factor = e.deltaY > 0 ? 1.1 : 0.9;
        const { min, max } = priceScale;
        const newMin = anchorPrice + (min - anchorPrice) * factor;
        const newMax = anchorPrice + (max - anchorPrice) * factor;
        setPriceScale({ min: newMin, max: newMax, autoFit: false });
      } else if (e.ctrlKey || e.metaKey) {
        // Zoom time axis
        const si = screenXToSlotIndex(x);
        zoom(e.deltaY > 0 ? 1 : -1, si);
      } else {
        // Pan horizontally
        const delta = Math.round((e.deltaX || e.deltaY) / sw);
        pan(delta);
      }
    },
    [viewport, sw, priceScale],
  );

  const handleMouseLeave = useCallback(() => {
    setCrosshair({ visible: false });
    patternDragStart.current = null;
    patternDragEnd.current   = null;
    hoveredDrawingId.current = null;
    setHoveredId(null);
    dragPan.current = null;
    setIsDragging(false);
  }, []);

  const handleDblClick = useCallback(
    (e: React.MouseEvent) => {
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x >= viewport.width - viewport.priceAxisWidth) {
        resetPriceScale();
      }
    },
    [viewport, resetPriceScale],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (activeDrawingTool !== 'none') return;
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = showIndicatorsAndDrawings
        ? hitTestDrawings(x, y, drawings, viewport, priceScale)
        : null;
      if (hit) {
        setContextMenu({ x: e.clientX, y: e.clientY, drawingId: hit });
      } else {
        setContextMenu(null);
      }
    },
    [activeDrawingTool, drawings, viewport, priceScale, showIndicatorsAndDrawings],
  );

  return (
    <>
      <canvas
        ref={canvasRef}
        data-chart-canvas
        style={{
          display: 'block',
          cursor: (activeDrawingTool === 'long_position' || activeDrawingTool === 'short_position') && drawingInProgress
            ? 'ns-resize'
            : activeDrawingTool !== 'none'
              ? 'crosshair'
              : isDragging
                ? (draggingDrawing.current?.anchor === 'tp' || draggingDrawing.current?.anchor === 'sl')
                  ? 'ns-resize'
                  : 'grabbing'
                : hoveredId
                  ? (hoveredPositionPart.current === 'tp' || hoveredPositionPart.current === 'sl')
                    ? 'ns-resize'
                    : 'move'
                  : 'grab',
        }}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onMouseLeave={handleMouseLeave}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
      />

      {/* Right-click context menu for drawings */}
      {contextMenu && (
        <>
          {/* Backdrop – closes menu on outside click */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onPointerDown={() => setContextMenu(null)}
          />
          <div
            style={{
              position: 'fixed',
              left: contextMenu.x,
              top:  contextMenu.y,
              zIndex: 200,
              background: '#1e222d',
              border: '1px solid #2a2e39',
              borderRadius: 5,
              boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
              overflow: 'hidden',
              minWidth: 140,
            }}
          >
            <button
              style={{
                display: 'block',
                width: '100%',
                padding: '8px 14px',
                background: 'transparent',
                color: '#ef5350',
                border: 'none',
                textAlign: 'left',
                fontSize: 13,
                cursor: 'pointer',
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => {
                deleteDrawing(contextMenu.drawingId);
                setContextMenu(null);
                setHoveredId(null);
                hoveredDrawingId.current = null;
              }}
            >
              🗑 Delete drawing
            </button>
          </div>
        </>
      )}
    </>
  );
};
