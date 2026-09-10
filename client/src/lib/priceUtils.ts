import type { InvestmentHolding } from "@/types";
import { etDateParts, isMarketHolidayYMD } from "./marketHolidays";

// The most recent 8 PM ET cutoff that has already passed. Used to decide whether
// a completed refresh is still current: anything captured before the last cutoff
// is a batch behind, anything after it is up to date.
export function lastStockCutoff(now: Date): Date {
  const cutoff = cutoffToday8pmET(now);
  return now >= cutoff ? cutoff : new Date(cutoff.getTime() - DAY_MS);
}

// The next 8 PM ET cutoff that a refresh will actually run at — skipping weekends
// and market holidays, since the server won't fetch quotes on those days. Without
// the skip the status line advertises a Saturday update that never comes.
export function nextStockCutoff(now: Date): Date {
  const cutoff = cutoffToday8pmET(now);
  let ms = now < cutoff ? cutoff.getTime() : cutoff.getTime() + DAY_MS;
  while (!isTradingDay(ms)) ms += DAY_MS;
  return new Date(ms);
}

/**
 * Format a share/unit quantity for display.
 *
 * Shows up to 8 decimal places with no trailing zeros — correctly handles
 * both whole-share stock quantities (e.g. 100) and high-precision crypto
 * amounts (e.g. 0.11080827).
 */
export function formatQuantity(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

// Returns the UTC ms timestamp for a given hour/minute ET, on the ET calendar
// day containing refMs. Uses the current ET UTC offset (via shortOffset) so
// DST is handled automatically.
function etTimeOnDay(refMs: number, hour: number, minute = 0): number {
  const d = new Date(refMs);
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const get = (type: string) => dateParts.find((p) => p.type === type)!.value;

  const tzPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(d).find((p) => p.type === "timeZoneName")!.value;

  const offsetMatch = tzPart.match(/GMT([+-])(\d+)/)!;
  const offsetStr = `${offsetMatch[1]}${offsetMatch[2].padStart(2, "0")}:00`;

  return new Date(`${get("year")}-${get("month")}-${get("day")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offsetStr}`).getTime();
}

// Returns a Date representing 8:00 PM Eastern today.
function cutoffToday8pmET(now: Date): Date {
  return new Date(etTimeOnDay(now.getTime(), 20));
}

function currentHourET(now: Date): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })
      .formatToParts(now)
      .find((p) => p.type === "hour")!.value,
    10,
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

// True if the ET calendar day containing refMs is an NYSE trading day
// (not a weekend, not a market holiday).
function isTradingDay(refMs: number): boolean {
  const { year, month, day, dow } = etDateParts(refMs);
  return dow !== 0 && dow !== 6 && !isMarketHolidayYMD(year, month, day);
}

// UTC ms timestamp of 4:15 PM ET — market close (4 PM) plus a short buffer for
// late-arriving closing prints, the latest time we'd expect an updated quote —
// on the ET calendar day containing refMs.
function etCloseBoundary(refMs: number): number {
  return etTimeOnDay(refMs, 16, 15);
}

// Returns the UTC ms timestamp of the most recent NYSE market close (4:15 PM ET)
// that has already occurred as of `nowMs`, walking back over weekends and
// holidays as needed (e.g. a Monday-holiday week resolves back to the
// preceding Friday's close).
function mostRecentTradingClose(nowMs: number): number {
  if (isTradingDay(nowMs) && nowMs >= etCloseBoundary(nowMs)) {
    return etCloseBoundary(nowMs);
  }
  let cursorMs = nowMs - DAY_MS;
  while (!isTradingDay(cursorMs)) {
    cursorMs -= DAY_MS;
  }
  return etCloseBoundary(cursorMs);
}

/**
 * Returns true if cached options prices from `lastFetchedAt` are still fresh —
 * i.e. no new market close has occurred since they were captured, and we're
 * not currently inside the trading window (where prices are live and should
 * always be refreshed on load).
 *
 * This is anchored to "has a trading-day close happened since the last fetch"
 * rather than "what day of the week was the last fetch", so it's stable no
 * matter what day the last fetch itself happened to run on — including a
 * fetch that ran on a weekend/holiday (e.g. catching up on Friday's close
 * data on Saturday). Holidays are taken into account via marketHolidays.ts,
 * so e.g. a Monday holiday correctly pushes "the next trading day" to Tuesday.
 */
export function optionsPricesAreFresh(lastFetchedAt: Date): boolean {
  if (isWithinOptionsTradingWindow()) return false;
  return lastFetchedAt.getTime() >= mostRecentTradingClose(Date.now());
}

/**
 * Returns true if the current wall-clock time falls within the options trading
 * window: trading days, 8 AM – 4:15 PM ET (regular market hours are 9:30 AM –
 * 4 PM, with a 1 h buffer before open for pre-market quotes Tradier may have
 * available, and a short buffer after close for late-arriving closing prints).
 * Weekends and NYSE holidays are never within the window.
 *
 * Used to gate automatic page-load quote refreshes on the Options page so we
 * don't burn Tradier API calls on nights, weekends, or holidays when prices
 * won't change. Manual refreshes are NOT gated by this function.
 */
export function isWithinOptionsTradingWindow(): boolean {
  const now = new Date();
  if (!isTradingDay(now.getTime())) return false;
  return currentHourET(now) >= 8 && now.getTime() < etCloseBoundary(now.getTime());
}

// Returns true if any holding has a stale price and a refresh should be triggered.
//
// One cadence for every holding, crypto included: prices go stale once it is past
// 8 PM Eastern and the last fetch predates that cutoff. Mutual fund NAVs are
// typically published 1-2 hours after the 4 PM ET close, so 8 PM gives them time
// to settle — fetching earlier risks capturing a stale or partial NAV.
//
// Between 4:15 PM and 8 PM nothing is requested: a price fetched earlier the same
// day is newer than the previous cutoff, so no holding reports stale. Before 4:15
// PM the same is true, until a whole cutoff has been missed — which is the
// catch-up path for a portfolio nobody opened last night.
export function isPriceRefreshNeeded(holdings: InvestmentHolding[]): boolean {
  if (holdings.length === 0) return false;

  const now = new Date();

  // On a non-trading day the server fetches no quotes, but it does check for a
  // session that was never captured — Friday's close, if nobody opened the app
  // that evening. Ask anyway so it gets that chance; the refresh singleton keeps
  // it to once per session.
  if (!isTradingDay(now.getTime())) return true;

  const cutoff = cutoffToday8pmET(now);
  const prevCutoff = new Date(cutoff.getTime() - DAY_MS);

  for (const holding of holdings) {
    if (!holding.priceUpdatedAt) return true;

    const lastUpdated = new Date(holding.priceUpdatedAt);
    if (lastUpdated < prevCutoff) return true;
    if (now >= cutoff && lastUpdated < cutoff) return true;
  }

  return false;
}

// Returns when prices will next become stale — the next 8 PM ET cutoff, for every
// holding alike. Crypto used to pull this as low as 5 minutes out, which made the
// "Next update" caption advertise a refresh that had nothing to do with the daily
// batch the rest of the page runs on.
export function getNextUpdateTime(holdings: InvestmentHolding[]): Date | null {
  if (holdings.length === 0) return null;
  return nextStockCutoff(new Date());
}

// Formats a next-update Date as a friendly string like "Today at 8 PM EDT" or "May 10 at 8 PM EDT".
export function formatNextUpdateTime(date: Date): string {
  const now = new Date();
  const toDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const timePart = date.toLocaleString("en-US", {
    hour: "numeric",
    minute: date.getMinutes() > 0 ? "2-digit" : undefined,
    timeZoneName: "short",
  });

  if (toDay(date) === toDay(now)) return `Today at ${timePart}`;
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (toDay(date) === toDay(tomorrow)) return `Tomorrow at ${timePart}`;

  const datePart = date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${datePart} at ${timePart}`;
}
