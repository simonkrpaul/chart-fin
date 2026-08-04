/**
 * Trade Log CSV Parser
 *
 * Supports two Bybit export formats:
 *
 * Format A (old – individual fills):
 *   Market, Order Type, Direction, Filled Value, Filled Price, Filled Quantity,
 *   Filled Type, Trading Fees, Fee Rate, Transaction Time, Transaction ID
 *
 * Format B (new – round-trip P&L):
 *   Market, Order Quantity, Entry Price, Traded Price, Realized P&L, Trade Type, Trade Time
 */
import type { TradeLogEntry, TradeLogDirection, TradeLogAction, TradeLogRoundTrip, CandleSlot } from '../types';

/**
 * Detect format and parse accordingly.
 * Returns { entries, roundTrips } — for Format B, entries are synthesized
 * (open + close pairs) so the renderer shows both.
 */
export function parseTradeLogCsv(csvText: string): TradeLogEntry[] {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase();
  if (header.includes('entry price') && header.includes('traded price') && header.includes('realized')) {
    return _parseFormatB(lines);
  }
  return _parseFormatA(lines);
}

// ─────────────────────────────────────────────────────────────────────────────
// Format B: Round-trip P&L CSV
// Each row = one complete trade. Synthesize open+close entries.
// ─────────────────────────────────────────────────────────────────────────────

function _parseFormatB(lines: string[]): TradeLogEntry[] {
  const entries: TradeLogEntry[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith(',')) continue;

    const cols = parseCsvLine(line);
    if (cols.length < 7) continue;

    const [_market, qtyRaw, entryPriceRaw, tradedPriceRaw, pnlRaw, tradeType, tradeTime] = cols;

    if (tradeType.trim().toLowerCase() !== 'trade') continue;

    const entryPrice = parseFloat(entryPriceRaw.replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
    const exitPrice = parseFloat(tradedPriceRaw.replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
    const pnl = parseFloat(pnlRaw.replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
    const quantity = parseFloat(qtyRaw.replace(/[^0-9.]/g, ''));
    if (isNaN(entryPrice) || isNaN(exitPrice) || isNaN(quantity)) continue;

    const exitTimestamp = parseTransactionTime(tradeTime.trim());
    if (!exitTimestamp) continue;

    // Determine direction from price movement vs P&L:
    // Long: profit when price goes up (traded > entry)
    // Short: profit when price goes down (traded < entry)
    const priceMove = exitPrice - entryPrice;
    let direction: TradeLogDirection;
    if (pnl === 0) {
      direction = priceMove >= 0 ? 'long' : 'short';
    } else {
      direction = (priceMove * pnl > 0) ? 'long' : 'short';
    }

    // We don't have the exact entry time — approximate as exit minus a small offset
    // so the entry appears before exit on the chart. Use 1 minute offset.
    const entryTimestamp = exitTimestamp - 60_000;

    const id = crypto.randomUUID();

    // Create open entry
    entries.push({
      id: `${id}-open`,
      timestamp: entryTimestamp,
      direction,
      action: 'open',
      price: entryPrice,
      quantity,
      fees: 0,
      orderType: 'Trade',
      transactionId: `${id}-open`,
      filledType: 'Trade',
    });

    // Create close entry
    entries.push({
      id: `${id}-close`,
      timestamp: exitTimestamp,
      direction,
      action: 'close',
      price: exitPrice,
      quantity,
      fees: 0,
      orderType: 'Trade',
      transactionId: `${id}-close`,
      filledType: 'Trade',
    });
  }

  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

// ─────────────────────────────────────────────────────────────────────────────
// Format A: Individual fills CSV (old format)
// ─────────────────────────────────────────────────────────────────────────────

function _parseFormatA(lines: string[]): TradeLogEntry[] {
  const entries: TradeLogEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith(',')) continue;

    const cols = parseCsvLine(line);
    if (cols.length < 11) continue;

    const [
      _market,
      orderType,
      direction,
      _filledValue,
      filledPriceRaw,
      filledQtyRaw,
      filledType,
      feesRaw,
      _feeRate,
      transactionTime,
      transactionId,
    ] = cols;

    if (filledType.trim().toLowerCase() === 'funding') continue;
    if (orderType.trim() === '--') continue;

    const dirLower = direction.trim().toLowerCase();
    let tradeDirection: TradeLogDirection;
    let tradeAction: TradeLogAction;

    if (dirLower.includes('long')) {
      tradeDirection = 'long';
    } else if (dirLower.includes('short')) {
      tradeDirection = 'short';
    } else {
      continue;
    }

    if (dirLower.includes('open')) {
      tradeAction = 'open';
    } else if (dirLower.includes('close')) {
      tradeAction = 'close';
    } else {
      continue;
    }

    const price = parseFloat(filledPriceRaw.replace(/,/g, '').replace(/[^0-9.]/g, ''));
    if (isNaN(price)) continue;

    const quantity = parseFloat(filledQtyRaw.replace(/[^0-9.]/g, ''));
    if (isNaN(quantity)) continue;

    const fees = parseFloat(feesRaw.replace(/[^0-9.]/g, '')) || 0;

    const timestamp = parseTransactionTime(transactionTime.trim());
    if (!timestamp) continue;

    entries.push({
      id: transactionId.trim() || crypto.randomUUID(),
      timestamp,
      direction: tradeDirection,
      action: tradeAction,
      price,
      quantity,
      fees,
      orderType: orderType.trim(),
      transactionId: transactionId.trim(),
      filledType: filledType.trim(),
    });
  }

  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Parse a CSV line respecting quoted fields (handles commas inside quotes).
 */
function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}

/**
 * Parse transaction time like "4/5/2026 20:45" → UTC ms.
 * Format: D/M/YYYY HH:mm (day/month/year, assumed UTC).
 */
function parseTransactionTime(timeStr: string): number | null {
  // Handle "4/5/2026 20:45" format (D/M/YYYY HH:mm)
  const match = timeStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const [, day, month, year, hour, minute] = match;
  const d = new Date(Date.UTC(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hour),
    parseInt(minute),
  ));
  return d.getTime();
}

/**
 * Match entries into round-trip trades by pairing opens with closes.
 *
 * Strategy (LIFO with quantity matching):
 * - Process entries in chronological order.
 * - Opens accumulate into a stack per direction.
 * - When a Close arrives, consume opens from the stack (MOST RECENT first)
 *   until the close quantity is fully matched.
 * - LIFO is correct for exchange scalp logs where stale opens from earlier
 *   dates may not have closes in the exported file.
 */
export function matchRoundTrips(
  entries: TradeLogEntry[],
  primarySlots: CandleSlot[],
): TradeLogRoundTrip[] {
  if (!entries.length || !primarySlots.length) return [];

  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const roundTrips: TradeLogRoundTrip[] = [];

  // Stack of pending opens: { entry, remainingQty }
  type OpenPosition = { entry: TradeLogEntry; remainingQty: number };
  const openLongs: OpenPosition[] = [];
  const openShorts: OpenPosition[] = [];

  for (const fill of sorted) {
    if (fill.action === 'open') {
      const pos: OpenPosition = { entry: fill, remainingQty: fill.quantity };
      if (fill.direction === 'long') openLongs.push(pos);
      else openShorts.push(pos);
    } else {
      // Close — consume from the TOP of stack (most recent open first = LIFO)
      const pool = fill.direction === 'long' ? openLongs : openShorts;
      let closeQtyRemaining = fill.quantity;

      while (closeQtyRemaining > 0.0001 && pool.length > 0) {
        const newest = pool[pool.length - 1]; // LIFO: take from end
        const matchQty = Math.min(closeQtyRemaining, newest.remainingQty);

        const entrySlotIndex = findNearestSlotIndex(primarySlots, newest.entry.timestamp);
        const exitSlotIndex = findNearestSlotIndex(primarySlots, fill.timestamp);

        const direction = fill.direction;
        const pnlPoints = direction === 'long'
          ? fill.price - newest.entry.price
          : newest.entry.price - fill.price;
        const pnlPct = (pnlPoints / newest.entry.price) * 100;
        const pnlUsd = pnlPoints * matchQty;
        const totalFees = (newest.entry.fees * matchQty / newest.entry.quantity) +
                          (fill.fees * matchQty / fill.quantity);

        roundTrips.push({
          id: `${newest.entry.id}-${fill.id}-${roundTrips.length}`,
          direction,
          entryTimestamp: newest.entry.timestamp,
          exitTimestamp: fill.timestamp,
          entryPrice: newest.entry.price,
          exitPrice: fill.price,
          entrySlotIndex,
          exitSlotIndex,
          quantity: matchQty,
          pnlPct,
          pnlUsd,
          totalFees,
        });

        newest.remainingQty -= matchQty;
        closeQtyRemaining -= matchQty;

        // Remove fully consumed open
        if (newest.remainingQty < 0.0001) {
          pool.pop(); // LIFO: remove from end
        }
      }
    }
  }

  return roundTrips.sort((a, b) => a.entryTimestamp - b.entryTimestamp);
}

/** Find nearest slot index for a given timestamp. */
function findNearestSlotIndex(slots: CandleSlot[], targetMs: number): number {
  if (slots.length === 0) return 0;

  let lo = 0;
  let hi = slots.length - 1;
  let bestIdx = 0;
  let bestDiff = Infinity;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const diff = Math.abs(slots[mid].timestamp - targetMs);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = mid; }
    if (slots[mid].timestamp < targetMs) lo = mid + 1;
    else hi = mid - 1;
  }

  return slots[bestIdx].slotIndex;
}
