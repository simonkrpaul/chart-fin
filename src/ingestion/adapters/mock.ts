/**
 * Mock adapter — synthesises OHLCV bars in the browser using the market
 * preset's session config. Deterministic given the same seed so runs are
 * reproducible.
 */
import { fromZonedTime, toZonedTime } from '../../engine/tzUtils';
import { addDays, format, getDay, startOfDay } from 'date-fns';
import type { RawCandle, Timeframe } from '../../types';
import { TIMEFRAME_MINUTES } from '../../engine/calendarEngine';
import { getMarketPreset } from '../../engine/marketPresets';
import type { SourceAdapter } from '../types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseHHMM(s: string): [number, number] {
  const [h, m] = s.split(':').map(Number);
  return [h || 0, m || 0];
}

export const mockAdapter: SourceAdapter = {
  id: 'mock',
  label: 'Mock generator',
  description: 'In-browser synthetic OHLCV — no network.',
  sourceInfo:
    'Deterministic (seeded) Box–Muller random walk that respects the selected market ' +
    'preset: weekends and holidays are skipped for weekday-only markets, 24/7 for crypto. ' +
    'Useful for exercising gap rendering, resampling, and offset cycles without a live feed.',
  expectedFormat: 'Generated in memory — no input file needed.',
  kinds: ['crypto', 'us_equity', 'us_futures', 'forex', 'asx', 'lse', 'custom'],
  paramsSchema: [
    { name: 'days',       label: 'Days back',    kind: 'number', defaultValue: 30, required: true,
      help: 'How many calendar days of history to synthesise.' },
    { name: 'startPrice', label: 'Start price',  kind: 'number', defaultValue: 100, required: true },
    { name: 'dailyVol',   label: 'Daily σ (fraction)', kind: 'number', defaultValue: 0.02,
      help: 'Approximate daily volatility as a fraction of price (0.02 = 2%).' },
    { name: 'seed',       label: 'Seed',         kind: 'number', defaultValue: 42,
      help: 'Same seed → identical output. Change for a different path.' },
  ],
  async fetch(params) {
    const preset = getMarketPreset(params.market);
    if (!preset) throw new Error(`mock: unknown market ${params.market}`);
    const tfMin = TIMEFRAME_MINUTES[params.timeframe];
    const days = Number(params.extras?.days ?? 30);
    const startPrice = Number(params.extras?.startPrice ?? 100);
    const dailyVol = Number(params.extras?.dailyVol ?? 0.02);
    const seed = Number(params.extras?.seed ?? 42);

    const rng = mulberry32(seed);
    const tz = preset.timezone;
    const [openH, openM]   = parseHHMM(preset.session.regularOpen);
    const [closeH, closeM] = parseHHMM(preset.session.regularClose);
    const openMinuteOfDay  = openH * 60 + openM;
    const closeMinuteOfDay = closeH * 60 + closeM;
    const holidays = new Set(preset.session.holidays ?? []);

    const now = new Date();
    const nowLocal = toZonedTime(now, tz);
    const stepMs = tfMin * 60_000;
    const perDayMinutes = preset.continuous ? 24 * 60 : (closeMinuteOfDay - openMinuteOfDay);
    const perDaySlots = Math.max(1, Math.floor(perDayMinutes / tfMin));

    const candles: RawCandle[] = [];
    let price = startPrice;
    const sigmaPerBar = dailyVol / Math.sqrt(Math.max(1, perDaySlots));

    for (let d = days - 1; d >= 0; d--) {
      const dayLocal = addDays(startOfDay(nowLocal), -d);
      const dateStr = format(dayLocal, 'yyyy-MM-dd');
      const iso = getDay(dayLocal) || 7;
      if (!preset.continuous) {
        if (!preset.session.tradingDays.includes(iso)) continue;
        if (holidays.has(dateStr)) continue;
      }
      const dayOpenUtc = preset.continuous
        ? fromZonedTime(`${dateStr}T00:00:00`, tz).getTime()
        : fromZonedTime(`${dateStr}T${preset.session.regularOpen}:00`, tz).getTime();

      for (let i = 0; i < perDaySlots; i++) {
        const ts = dayOpenUtc + i * stepMs;
        if (ts > now.getTime()) break;
        // Gaussian-ish via Box–Muller
        const u1 = Math.max(1e-9, rng());
        const u2 = rng();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const drift = 0.00002;
        const ret = drift + sigmaPerBar * z;
        const open = price;
        const close = Math.max(0.01, price * (1 + ret));
        const high = Math.max(open, close) * (1 + Math.abs(sigmaPerBar * rng() * 0.5));
        const low  = Math.min(open, close) * (1 - Math.abs(sigmaPerBar * rng() * 0.5));
        const volume = 100 + rng() * 900;
        candles.push({ timestamp: ts, open, high, low, close, volume, symbol: params.symbol });
        price = close;
      }
    }

    candles.sort((a, b) => a.timestamp - b.timestamp);
    return { candles, meta: { description: `Mock ${preset.label}` } };
  },
};
