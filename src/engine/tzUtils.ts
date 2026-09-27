/**
 * Thin wrappers around date-fns-tz-style operations using the Intl API.
 * We avoid date-fns-tz as a dep and implement the two functions we need.
 */

/**
 * Convert a UTC Date to a "fake local" Date that represents the wall-clock time
 * in the given IANA timezone.  The numeric value of the returned Date is NOT
 * a valid UTC timestamp – it is only suitable for calendar arithmetic.
 */
export function toZonedTime(utcDate: Date, tz: string): Date {
  // Use Intl to get year/month/day/hour/minute/second in the target tz
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(utcDate);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10);
  return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/**
 * Convert a "wall-clock" date-time string (no tz info) in the given IANA
 * timezone to a proper UTC Date.
 *
 * All intermediate arithmetic is done through `Date.UTC(...)`, never
 * through the JS `new Date(y, m, d, h, mn, s)` constructor which uses the
 * browser's own timezone. That distinction matters: the previous
 * implementation double-counted the browser's tz offset, producing results
 * that were correct only for browsers running in America/New_York (or
 * whatever tz the input string was already in).
 *
 * @param localDateTimeStr – "YYYY-MM-DDTHH:MM:SS"
 * @param tz – IANA timezone
 */
export function fromZonedTime(localDateTimeStr: string | Date, tz: string): Date {
  // Resolve the target wall-clock fields, whatever form the input took.
  let y: number, mo: number, d: number, h: number, mi: number, se: number;
  if (localDateTimeStr instanceof Date) {
    y = localDateTimeStr.getFullYear();
    mo = localDateTimeStr.getMonth();
    d = localDateTimeStr.getDate();
    h = localDateTimeStr.getHours();
    mi = localDateTimeStr.getMinutes();
    se = localDateTimeStr.getSeconds();
  } else {
    const [datePart, timePart = '00:00:00'] = localDateTimeStr.split('T');
    const [ys, ms, ds] = datePart.split('-');
    const [hs, mis, ses = '00'] = timePart.split(':');
    y  = parseInt(ys, 10);
    mo = parseInt(ms, 10) - 1;
    d  = parseInt(ds, 10);
    h  = parseInt(hs, 10);
    mi = parseInt(mis, 10);
    se = parseInt(ses, 10) || 0;
  }

  // 1. Assume the target fields are UTC to get an initial guess.
  const guessMs = Date.UTC(y, mo, d, h, mi, se);
  // 2. Ask "what wall-clock time does that guess actually display in `tz`?"
  const actualLocal = toZonedTime(new Date(guessMs), tz);
  const actualMs = Date.UTC(
    actualLocal.getFullYear(),
    actualLocal.getMonth(),
    actualLocal.getDate(),
    actualLocal.getHours(),
    actualLocal.getMinutes(),
    actualLocal.getSeconds(),
  );
  // 3. Shift the guess by the mismatch — the sign flips because we need
  //    `guessMs + shift` to produce a wall-clock equal to (y,mo,d,h,mi,se).
  const shift = guessMs - actualMs;
  return new Date(guessMs + shift);
}
