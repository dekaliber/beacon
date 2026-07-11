/**
 * Date parsing for user-entered calendar dates.
 *
 * The app is used from a single locale (US Pacific). When a user picks a date
 * like "2026-07-10" we want to store midnight *in Pacific time*, not UTC —
 * otherwise `new Date("2026-07-10")` yields UTC midnight, which renders as the
 * previous day (7/9, 5pm) anywhere the client formats dates in local time.
 *
 * See the "Always pass client local date" convention: a bare calendar date is
 * a wall-clock day, not a UTC instant.
 */

export const APP_TIMEZONE = "America/Los_Angeles";

/**
 * Returns the timezone's offset (localWallClock − UTC) in milliseconds at the
 * given instant. Negative for zones west of UTC (e.g. −7h for PDT). DST-aware
 * because it reads the actual wall-clock parts the zone reports for that instant.
 */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asIfUtc - instant.getTime();
}

/** UTC instant of midnight on `year-month-day` in `timeZone` (DST-aware). */
function zonedMidnightToUtc(year: number, month: number, day: number, timeZone: string): Date {
  const utcMidnight = Date.UTC(year, month - 1, day);
  // localMidnight = utcMidnight − offset. Recompute the offset at the corrected
  // instant so days that straddle a DST transition resolve to the right offset.
  const offset = tzOffsetMs(new Date(utcMidnight), timeZone);
  let utc = utcMidnight - offset;
  const offset2 = tzOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset) utc = utcMidnight - offset2;
  return new Date(utc);
}

/**
 * Parse a user-supplied date. A bare "YYYY-MM-DD" is interpreted as midnight in
 * the app's timezone (Pacific). Any string that already carries a time or offset
 * is parsed as-is, so callers that send a full ISO instant are unaffected.
 */
export function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return new Date(s);
  return zonedMidnightToUtc(Number(m[1]), Number(m[2]), Number(m[3]), APP_TIMEZONE);
}
