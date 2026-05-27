/**
 * US Federal Reserve bank holiday calendar + business-day utilities.
 *
 * The Fed holiday list governs options cash settlement (T+1 for equity options
 * per OCC rules). Holidays that fall on Saturday are observed on Friday; holidays
 * that fall on Sunday are observed on Monday.
 */

// ── Holiday helpers ────────────────────────────────────────────────────────────

/** nth occurrence of a weekday (0=Sun…6=Sat) in a given month (0-indexed). */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const d = new Date(Date.UTC(year, month, 1));
  const first = d.getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

/** Last occurrence of a weekday in a given month. */
function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0)); // last day of month
  const diff = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - diff));
}

/** Observed date for a fixed holiday: Sat→Fri, Sun→Mon. */
function observed(year: number, month: number, day: number): Date {
  const d = new Date(Date.UTC(year, month, day));
  const dow = d.getUTCDay();
  if (dow === 6) return new Date(Date.UTC(year, month, day - 1)); // Saturday → Friday
  if (dow === 0) return new Date(Date.UTC(year, month, day + 1)); // Sunday → Monday
  return d;
}

/** Returns the set of Fed holiday dates (as "YYYY-MM-DD" strings) for a given year. */
function fedHolidaysForYear(year: number): Set<string> {
  const toKey = (d: Date) => d.toISOString().slice(0, 10);
  const holidays: Date[] = [
    observed(year, 0, 1),                        // New Year's Day
    nthWeekday(year, 0, 1, 3),                   // MLK Day — 3rd Monday of January
    nthWeekday(year, 1, 1, 3),                   // Presidents' Day — 3rd Monday of February
    lastWeekday(year, 4, 1),                     // Memorial Day — last Monday of May
    observed(year, 5, 19),                       // Juneteenth — June 19
    observed(year, 6, 4),                        // Independence Day — July 4
    nthWeekday(year, 8, 1, 1),                   // Labor Day — 1st Monday of September
    nthWeekday(year, 9, 1, 2),                   // Columbus Day — 2nd Monday of October
    observed(year, 10, 11),                      // Veterans Day — November 11
    nthWeekday(year, 10, 4, 4),                  // Thanksgiving — 4th Thursday of November
    observed(year, 11, 25),                      // Christmas Day — December 25
  ];
  return new Set(holidays.map(toKey));
}

// Cache holiday sets by year so we don't recompute on every call.
const holidayCache = new Map<number, Set<string>>();

function isHoliday(d: Date): boolean {
  const year = d.getUTCFullYear();
  if (!holidayCache.has(year)) holidayCache.set(year, fedHolidaysForYear(year));
  return holidayCache.get(year)!.has(d.toISOString().slice(0, 10));
}

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns the next US business day after `date` (T+1), skipping weekends and
 * Fed bank holidays. Input should be a UTC midnight Date; output is also UTC midnight.
 */
export function nextBusinessDay(date: Date): Date {
  const result = new Date(date);
  do {
    result.setUTCDate(result.getUTCDate() + 1);
  } while (isWeekend(result) || isHoliday(result));
  return result;
}
