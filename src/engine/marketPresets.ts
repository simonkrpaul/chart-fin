/**
 * Market presets – session/timezone/trading-day configs per asset class.
 *
 * Every preset produces a `SessionConfig` compatible with `calendarEngine`.
 * These are the canonical "profiles" a user selects when loading data for
 * a specific instrument. They also inform the slot generator so that
 * weekend/holiday gaps render correctly for weekday-only markets and
 * disappear for 24/7 crypto.
 */
import type { SessionConfig } from '../types';

export type MarketKind = 'crypto' | 'us_equity' | 'us_futures' | 'forex' | 'asx' | 'lse' | 'custom';

export interface MarketPreset {
  /** Stable id used as DB key */
  id: string;
  /** Human label */
  label: string;
  kind: MarketKind;
  /** True when instrument trades 24/7 (no weekend/holiday gaps). */
  continuous: boolean;
  /** IANA timezone the session times are expressed in. */
  timezone: string;
  session: SessionConfig;
  /** Suggested example symbols shown in pickers. */
  suggestedSymbols: string[];
}

/** Crypto – 24/7, no session breaks. Display tz defaults to NY to match
 *  the chart's forex/futures convention; underlying data is UTC. */
const CRYPTO: MarketPreset = {
  id: 'crypto',
  label: 'Crypto (24/7)',
  kind: 'crypto',
  continuous: true,
  timezone: 'America/New_York',
  session: {
    timezone: 'America/New_York',
    regularOpen: '00:00',
    regularClose: '23:59',
    tradingDays: [1, 2, 3, 4, 5, 6, 7],
    holidays: [],
    halfDays: {},
  },
  suggestedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
};

/** US equity (NYSE/NASDAQ) – 09:30–16:00 America/New_York, Mon–Fri. */
const US_EQUITY: MarketPreset = {
  id: 'us_equity',
  label: 'US Equities (NYSE/NASDAQ)',
  kind: 'us_equity',
  continuous: false,
  timezone: 'America/New_York',
  session: {
    timezone: 'America/New_York',
    regularOpen: '09:30',
    regularClose: '16:00',
    tradingDays: [1, 2, 3, 4, 5],
    holidays: [
      // 2026 US market holidays
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
      '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
      '2026-11-26', '2026-12-25',
    ],
    halfDays: {
      '2026-07-02': { close: '13:00' },
      '2026-11-27': { close: '13:00' },
      '2026-12-24': { close: '13:00' },
    },
  },
  suggestedSymbols: ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA'],
};

/** CME futures (NQ, ES) – near 23-hour session with a 1-hour maintenance break. */
const US_FUTURES: MarketPreset = {
  id: 'us_futures',
  label: 'US Futures (CME – NQ/ES)',
  kind: 'us_futures',
  continuous: false,
  timezone: 'America/Chicago',
  session: {
    timezone: 'America/Chicago',
    // CME globex: Sun 17:00 CT → Fri 16:00 CT with daily 16:00–17:00 CT halt.
    // We model each trading day as 17:00 → 16:00 next day; simplest close
    // repr for the slot engine is 16:00 close each weekday. The one-hour
    // maintenance break is skipped naturally because open > close crossover
    // is handled by treating each weekday as its own session.
    regularOpen: '17:00',
    regularClose: '16:00',
    tradingDays: [1, 2, 3, 4, 5, 7], // Sun (7) evening opens the week
    holidays: [
      '2026-01-01', '2026-04-03', '2026-05-25',
      '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    ],
    halfDays: {},
  },
  suggestedSymbols: ['NQ', 'ES', 'CL', 'GC'],
};

/** Forex – Sunday 17:00 NY → Friday 17:00 NY continuous. */
const FOREX: MarketPreset = {
  id: 'forex',
  label: 'Forex (FX week)',
  kind: 'forex',
  continuous: false,
  timezone: 'America/New_York',
  session: {
    // NY tz matches the forex trading-day convention (TradingView / MT5
    // / CME all anchor the daily bar at 17:00 NY). Users can override via
    // the toolbar's Timezone selector.
    timezone: 'America/New_York',
    regularOpen: '00:00',
    regularClose: '23:59',
    // Mon-Fri only. Both Saturday and Sunday render as weekend spacers
    // in calendar-day mode. Real Sunday-evening ticks (if the dataset has
    // them, e.g. Dukascopy 22:00 UTC Asia open) are still kept because
    // `_applyGapVisibility` unconditionally keeps any slot with a candle.
    tradingDays: [1, 2, 3, 4, 5],
    holidays: [
      '2026-01-01', '2026-12-25', '2026-12-26',
    ],
    halfDays: {},
  },
  suggestedSymbols: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD'],
};

/** ASX – 10:00–16:00 Australia/Sydney, Mon–Fri. */
const ASX: MarketPreset = {
  id: 'asx',
  label: 'ASX (Sydney)',
  kind: 'asx',
  continuous: false,
  timezone: 'Australia/Sydney',
  session: {
    timezone: 'Australia/Sydney',
    regularOpen: '10:00',
    regularClose: '16:00',
    tradingDays: [1, 2, 3, 4, 5],
    holidays: [
      // 2026 ASX holidays (approximate)
      '2026-01-01', '2026-01-26', '2026-04-03', '2026-04-06',
      '2026-04-25', '2026-06-08', '2026-12-25', '2026-12-28',
    ],
    halfDays: {
      '2026-12-24': { close: '14:10' },
      '2026-12-31': { close: '14:10' },
    },
  },
  suggestedSymbols: ['XJO', 'BHP.AX', 'CBA.AX', 'CSL.AX', 'WES.AX'],
};

/** LSE – 08:00–16:30 Europe/London, Mon–Fri. */
const LSE: MarketPreset = {
  id: 'lse',
  label: 'LSE (London)',
  kind: 'lse',
  continuous: false,
  timezone: 'Europe/London',
  session: {
    timezone: 'Europe/London',
    regularOpen: '08:00',
    regularClose: '16:30',
    tradingDays: [1, 2, 3, 4, 5],
    holidays: [],
    halfDays: {},
  },
  suggestedSymbols: ['UKX', 'HSBA.L', 'BP.L', 'AZN.L'],
};

export const MARKET_PRESETS: Record<string, MarketPreset> = {
  crypto: CRYPTO,
  us_equity: US_EQUITY,
  us_futures: US_FUTURES,
  forex: FOREX,
  asx: ASX,
  lse: LSE,
};

export const MARKET_PRESET_LIST: MarketPreset[] = Object.values(MARKET_PRESETS);

export function getMarketPreset(id: string): MarketPreset | null {
  return MARKET_PRESETS[id] ?? null;
}

/** Return true when the preset represents a 24/7 continuous market. */
export function isContinuousMarket(id: string): boolean {
  return getMarketPreset(id)?.continuous ?? false;
}
