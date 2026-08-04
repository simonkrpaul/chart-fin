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
 * @param localDateTimeStr – "YYYY-MM-DDTHH:MM:SS"
 * @param tz – IANA timezone
 */
export function fromZonedTime(localDateTimeStr: string | Date, tz: string): Date {
  const target = localDateTimeStr instanceof Date ? localDateTimeStr : new Date(localDateTimeStr + 'Z');
  const targetLocal = toZonedTime(target, tz);
  const offsetMs = target.getTime() - new Date(
    targetLocal.getFullYear(),
    targetLocal.getMonth(),
    targetLocal.getDate(),
    targetLocal.getHours(),
    targetLocal.getMinutes(),
    targetLocal.getSeconds(),
  ).getTime();
  return new Date(target.getTime() - offsetMs);
}
