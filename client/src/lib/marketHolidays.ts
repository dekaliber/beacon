/**
 * NYSE market calendar: holidays, weekly options expirations, and trading-day
 * checks. Everything is anchored to Eastern Time — the market's timezone — so the
 * results don't drift for users in other timezones (a Friday-night Pacific user is
 * already on Saturday in ET, and the expiration math should reflect that).
 *
 * For the *bank* settlement calendar (T+1 cash settlement, which follows Federal
 * Reserve holidays — Columbus/Veterans Day closed, Good Friday open) see the
 * server-side server/src/lib/businessDays.ts. The two calendars deliberately
 * diverge on those days, so they are kept separate.
 */

// ── Eastern Time resolution ──────────────────────────────────────────────────
// Uses Intl.DateTimeFormat("America/New_York") so DST is handled automatically —
// no hardcoded UTC-4/UTC-5 offsets.

const _etDateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});
const _WDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface ETDateParts {
  year: number;
  month: number; // 1-indexed
  day: number;
  dow: number; // 0=Sun…6=Sat
}

/**
 * ET calendar components + weekday for any UTC timestamp. When converting a
 * UTC-midnight day marker, add ~12h first so the ET date lands on the intended
 * calendar day rather than the previous one.
 */
export function etDateParts(utcMs: number): ETDateParts {
  const parts = _etDateFmt.formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return {
    year: g("year"),
    month: g("month"),
    day: g("day"),
    dow: _WDAYS.indexOf(parts.find((p) => p.type === "weekday")!.value),
  };
}

/** Today's date in ET as YYYY-MM-DD. */
export function etToday(): string {
  const { year, month, day } = etDateParts(Date.now());
  return ymd(year, month, day);
}

// ── Date formatting helpers ──────────────────────────────────────────────────

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toYMD(d: Date): string {
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// ── Holiday calendar (NYSE) ──────────────────────────────────────────────────
// A calendar date's weekday is timezone-invariant, so the holiday set is computed
// with plain local-time Date arithmetic — the resulting YYYY-MM-DD keys are the
// same in every timezone.

/** Returns the nth occurrence of a weekday in a month (weekday: 0=Sun…6=Sat). */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): string {
  const d = new Date(year, month - 1, 1);
  let offset = (weekday - d.getDay() + 7) % 7;
  offset += 7 * (nth - 1);
  d.setDate(1 + offset);
  return toYMD(d);
}

/** Returns the last occurrence of a weekday in a month. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const d = new Date(year, month, 0); // last day of month
  const offset = (d.getDay() - weekday + 7) % 7;
  d.setDate(d.getDate() - offset);
  return toYMD(d);
}

/**
 * Observed NYSE holiday date: if the actual date falls on Saturday → previous Friday;
 * if Sunday → following Monday.
 */
function observedDate(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day);
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() - 1);
  if (dow === 0) d.setDate(d.getDate() + 1);
  return toYMD(d);
}

/** Easter Sunday via Meeus/Jones/Butcher algorithm. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function goodFriday(year: number): string {
  const easter = easterSunday(year);
  const fri = new Date(easter);
  fri.setDate(fri.getDate() - 2);
  return toYMD(fri);
}

const holidayCache = new Map<number, Set<string>>();

/** Returns the set of NYSE market holiday dates (YYYY-MM-DD) for a given year. */
function getMarketHolidays(year: number): Set<string> {
  if (holidayCache.has(year)) return holidayCache.get(year)!;
  const h = new Set<string>();
  h.add(observedDate(year, 1, 1));            // New Year's Day
  h.add(nthWeekdayOfMonth(year, 1, 1, 3));   // MLK Day (3rd Monday Jan)
  h.add(nthWeekdayOfMonth(year, 2, 1, 3));   // Presidents' Day (3rd Monday Feb)
  h.add(goodFriday(year));                    // Good Friday
  h.add(lastWeekdayOfMonth(year, 5, 1));      // Memorial Day (last Monday May)
  if (year >= 2021) h.add(observedDate(year, 6, 19)); // Juneteenth (first observed by NYSE June 18, 2021)
  h.add(observedDate(year, 7, 4));            // Independence Day
  h.add(nthWeekdayOfMonth(year, 9, 1, 1));   // Labor Day (1st Monday Sep)
  h.add(nthWeekdayOfMonth(year, 11, 4, 4));  // Thanksgiving (4th Thursday Nov)
  h.add(observedDate(year, 12, 25));          // Christmas
  holidayCache.set(year, h);
  return h;
}

/** True if the given ET calendar date (1-indexed month) is an NYSE market holiday. */
export function isMarketHolidayYMD(year: number, month: number, day: number): boolean {
  return getMarketHolidays(year).has(ymd(year, month, day));
}

export function isMarketHoliday(date: Date): boolean {
  return isMarketHolidayYMD(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/**
 * True if the calendar day containing `utcMs` (resolved in ET) is a weekend or
 * NYSE market holiday. Pass a UTC timestamp; ET midday resolution is applied
 * internally so a UTC-midnight day marker still resolves to the right ET date.
 */
export function isNonTradingDay(utcMs: number): boolean {
  const { year, month, day, dow } = etDateParts(utcMs + 12 * 3600_000);
  return dow === 0 || dow === 6 || isMarketHolidayYMD(year, month, day);
}

// ── Weekly options expirations ───────────────────────────────────────────────

/**
 * Given a Friday date, returns the NYSE weekly options expiration date for that
 * week: Friday unless it's a market holiday, in which case Thursday.
 */
function expirationForFriday(friday: Date): string {
  if (isMarketHoliday(friday)) {
    const thursday = new Date(friday);
    thursday.setDate(thursday.getDate() - 1);
    return toYMD(thursday);
  }
  return toYMD(friday);
}

/**
 * Given any expiration date (which may be Thursday due to a holiday), returns the
 * canonical Friday of that expiration week.
 */
function canonicalFriday(expirationYMD: string): Date {
  const [y, m, d] = expirationYMD.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  if (dow === 5) return dt;
  if (dow === 4) { // Thursday (holiday-adjusted week)
    const fri = new Date(dt);
    fri.setDate(fri.getDate() + 1);
    return fri;
  }
  // Fallback: advance to next Friday
  const daysToFri = (5 - dow + 7) % 7 || 7;
  const fri = new Date(dt);
  fri.setDate(fri.getDate() + daysToFri);
  return fri;
}

/**
 * Returns the default weekly options expiration date for the upcoming Friday of
 * the current (or, on a Saturday, the next) week, adjusted for market holidays.
 * Anchored to ET "today" unless an explicit reference date is supplied.
 */
export function getWeeklyExpiration(referenceDate?: Date): string {
  let y: number;
  let mo: number;
  let d: number;
  let dow: number;
  if (referenceDate) {
    y = referenceDate.getFullYear();
    mo = referenceDate.getMonth() + 1;
    d = referenceDate.getDate();
    dow = referenceDate.getDay();
  } else {
    ({ year: y, month: mo, day: d, dow } = etDateParts(Date.now()));
  }
  const daysToFriday = dow <= 5 ? 5 - dow : 6;
  const fri = new Date(y, mo - 1, d + daysToFriday);
  return expirationForFriday(fri);
}

/** Returns the expiration date for the week after the given expiration date. */
export function nextWeekExpiration(currentExpYMD: string): string {
  const fri = canonicalFriday(currentExpYMD);
  fri.setDate(fri.getDate() + 7);
  return expirationForFriday(fri);
}

/** Returns the expiration date for the week before the given expiration date. */
export function prevWeekExpiration(currentExpYMD: string): string {
  const fri = canonicalFriday(currentExpYMD);
  fri.setDate(fri.getDate() - 7);
  return expirationForFriday(fri);
}

/** Calendar days from ET today to the expiration date (negative if past). */
export function calcDTE(expirationYMD: string): number {
  const [ty, tm, td] = etToday().split("-").map(Number);
  const [ey, em, ed] = expirationYMD.split("-").map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const expMs = Date.UTC(ey, em - 1, ed);
  return Math.round((expMs - todayMs) / 86400000);
}
