/**
 * Moon-Ketu/Rahu conjunction dates for Buy/Sell signals.
 * Source: Pine Script strategy "Backtest-Mo-Ra-BUY-345-Buy-335-KE-Strategy"
 *
 * Buy dates  = Moon-Ketu 25° before conjunction
 * Sell dates = Moon-Rahu 15° before conjunction
 */

/** UTC timestamps of BUY signal dates */
export const MOON_BUY_DATES: number[] = [
  Date.UTC(2020, 0, 20), Date.UTC(2020, 1, 16), Date.UTC(2020, 2, 14), Date.UTC(2020, 3, 11),
  Date.UTC(2020, 4, 8),  Date.UTC(2020, 5, 4),  Date.UTC(2020, 6, 2),  Date.UTC(2020, 6, 29),
  Date.UTC(2020, 7, 25), Date.UTC(2020, 8, 21), Date.UTC(2020, 9, 18), Date.UTC(2020, 10, 15),
  Date.UTC(2020, 11, 12),
  Date.UTC(2021, 0, 8),  Date.UTC(2021, 1, 5),  Date.UTC(2021, 2, 4),  Date.UTC(2021, 2, 31),
  Date.UTC(2021, 3, 27), Date.UTC(2021, 4, 24), Date.UTC(2021, 5, 21), Date.UTC(2021, 6, 18),
  Date.UTC(2021, 7, 14), Date.UTC(2021, 8, 10), Date.UTC(2021, 9, 7),  Date.UTC(2021, 10, 4),
  Date.UTC(2021, 11, 1), Date.UTC(2021, 11, 29),
  Date.UTC(2022, 0, 25), Date.UTC(2022, 1, 21), Date.UTC(2022, 2, 20), Date.UTC(2022, 3, 16),
  Date.UTC(2022, 4, 14), Date.UTC(2022, 5, 10), Date.UTC(2022, 6, 7),  Date.UTC(2022, 7, 3),
  Date.UTC(2022, 7, 30), Date.UTC(2022, 8, 26), Date.UTC(2022, 9, 24), Date.UTC(2022, 10, 20),
  Date.UTC(2022, 11, 17),
  Date.UTC(2023, 0, 14), Date.UTC(2023, 1, 10), Date.UTC(2023, 2, 9),  Date.UTC(2023, 3, 5),
  Date.UTC(2023, 4, 2),  Date.UTC(2023, 4, 30), Date.UTC(2023, 5, 26), Date.UTC(2023, 6, 23),
  Date.UTC(2023, 7, 19), Date.UTC(2023, 8, 15), Date.UTC(2023, 9, 12), Date.UTC(2023, 10, 9),
  Date.UTC(2023, 11, 6),
  Date.UTC(2024, 0, 2),  Date.UTC(2024, 0, 29), Date.UTC(2024, 1, 25), Date.UTC(2024, 2, 23),
  Date.UTC(2024, 3, 20), Date.UTC(2024, 4, 17), Date.UTC(2024, 5, 13), Date.UTC(2024, 6, 10),
  Date.UTC(2024, 7, 6),  Date.UTC(2024, 8, 2),  Date.UTC(2024, 8, 30), Date.UTC(2024, 9, 27),
  Date.UTC(2024, 10, 23), Date.UTC(2024, 11, 20),
  Date.UTC(2025, 0, 16), Date.UTC(2025, 1, 13), Date.UTC(2025, 2, 12), Date.UTC(2025, 3, 8),
  Date.UTC(2025, 4, 5),  Date.UTC(2025, 5, 1),  Date.UTC(2025, 5, 28), Date.UTC(2025, 6, 26),
  Date.UTC(2025, 7, 22), Date.UTC(2025, 8, 18), Date.UTC(2025, 9, 15), Date.UTC(2025, 10, 12),
  Date.UTC(2025, 11, 9),
  Date.UTC(2026, 0, 5),  Date.UTC(2026, 1, 1),  Date.UTC(2026, 2, 1),  Date.UTC(2026, 2, 28),
  Date.UTC(2026, 3, 24), Date.UTC(2026, 4, 21), Date.UTC(2026, 5, 17), Date.UTC(2026, 6, 15),
  Date.UTC(2026, 7, 11), Date.UTC(2026, 8, 7),  Date.UTC(2026, 9, 4),  Date.UTC(2026, 10, 1),
  Date.UTC(2026, 10, 28), Date.UTC(2026, 11, 25),
];

/** UTC timestamps of SELL signal dates */
export const MOON_SELL_DATES: number[] = [
  Date.UTC(2020, 0, 8),  Date.UTC(2020, 1, 5),  Date.UTC(2020, 2, 3),  Date.UTC(2020, 2, 30),
  Date.UTC(2020, 3, 26), Date.UTC(2020, 4, 23), Date.UTC(2020, 5, 19), Date.UTC(2020, 6, 17),
  Date.UTC(2020, 7, 13), Date.UTC(2020, 8, 9),  Date.UTC(2020, 9, 6),  Date.UTC(2020, 10, 2),
  Date.UTC(2020, 10, 29), Date.UTC(2020, 11, 27),
  Date.UTC(2021, 0, 23), Date.UTC(2021, 1, 19), Date.UTC(2021, 2, 18), Date.UTC(2021, 3, 14),
  Date.UTC(2021, 4, 11), Date.UTC(2021, 5, 8),  Date.UTC(2021, 6, 5),  Date.UTC(2021, 7, 1),
  Date.UTC(2021, 7, 28), Date.UTC(2021, 8, 24), Date.UTC(2021, 9, 22), Date.UTC(2021, 10, 18),
  Date.UTC(2021, 11, 15),
  Date.UTC(2022, 0, 11), Date.UTC(2022, 1, 7),  Date.UTC(2022, 2, 6),  Date.UTC(2022, 3, 3),
  Date.UTC(2022, 3, 30), Date.UTC(2022, 4, 27), Date.UTC(2022, 5, 23), Date.UTC(2022, 6, 20),
  Date.UTC(2022, 7, 17), Date.UTC(2022, 8, 13), Date.UTC(2022, 9, 10), Date.UTC(2022, 10, 6),
  Date.UTC(2022, 11, 4), Date.UTC(2022, 11, 31),
  Date.UTC(2023, 0, 27), Date.UTC(2023, 1, 23), Date.UTC(2023, 2, 22), Date.UTC(2023, 3, 19),
  Date.UTC(2023, 4, 16), Date.UTC(2023, 5, 12), Date.UTC(2023, 6, 9),  Date.UTC(2023, 7, 5),
  Date.UTC(2023, 8, 2),  Date.UTC(2023, 8, 29), Date.UTC(2023, 9, 26), Date.UTC(2023, 10, 23),
  Date.UTC(2023, 11, 20),
  Date.UTC(2024, 0, 16), Date.UTC(2024, 1, 12), Date.UTC(2024, 2, 10), Date.UTC(2024, 3, 7),
  Date.UTC(2024, 4, 4),  Date.UTC(2024, 4, 31), Date.UTC(2024, 5, 27), Date.UTC(2024, 6, 24),
  Date.UTC(2024, 7, 21), Date.UTC(2024, 8, 17), Date.UTC(2024, 9, 15), Date.UTC(2024, 10, 11),
  Date.UTC(2024, 11, 8),
  Date.UTC(2025, 0, 4),  Date.UTC(2025, 0, 31), Date.UTC(2025, 1, 28), Date.UTC(2025, 2, 27),
  Date.UTC(2025, 3, 23), Date.UTC(2025, 4, 21), Date.UTC(2025, 5, 17), Date.UTC(2025, 6, 14),
  Date.UTC(2025, 7, 10), Date.UTC(2025, 8, 6),  Date.UTC(2025, 9, 4),  Date.UTC(2025, 9, 31),
  Date.UTC(2025, 10, 27), Date.UTC(2025, 11, 24),
  Date.UTC(2026, 0, 20), Date.UTC(2026, 1, 16), Date.UTC(2026, 2, 16), Date.UTC(2026, 3, 12),
  Date.UTC(2026, 4, 9),  Date.UTC(2026, 5, 5),
  Date.UTC(2026, 6, 5),  Date.UTC(2026, 7, 1),  Date.UTC(2026, 7, 28), Date.UTC(2026, 8, 24),
  Date.UTC(2026, 9, 22), Date.UTC(2026, 10, 18), Date.UTC(2026, 11, 15),
];
