import type { InvestmentHolding } from "@/types";
import { etDateParts, isMarketHolidayYMD } from "./marketHolidays";

// Next 8 PM ET cutoff for stocks/funds — same logic used client and server side.
export function nextStockCutoff(now: Date): Date {
  const cutoff = cutoffToday8pmET(now);
  return now < cutoff ? cutoff : new Date(cutoff.getTime() + 24 * 60 * 60 * 1000);
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

// Crypto markets trade 24/7. Refresh crypto prices if they are older than this.
const CRYPTO_PRICE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

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
// For stock/fund holdings: prices are considered stale once it is past 8PM Eastern
// today and the last fetch predates that cutoff. Mutual fund NAVs are typically
// published 1-2 hours after the 4PM ET close, so 8PM gives them plenty of time.
// No refreshes are triggered after 4:15PM ET — markets are closed and prices won't change.
//
// For crypto holdings: prices are considered stale if older than 5 minutes, since
// crypto trades continuously 24/7.
export function isPriceRefreshNeeded(holdings: InvestmentHolding[]): boolean {
  if (holdings.length === 0) return false;

  const now = new Date();
  const cutoff = cutoffToday8pmET(now);
  const prevCutoff = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);
  const afterMarketClose = now.getTime() >= etCloseBoundary(now.getTime());

  for (const holding of holdings) {
    if (!holding.priceUpdatedAt) return true;

    const lastUpdated = new Date(holding.priceUpdatedAt);

    if (holding.type === "Crypto") {
      // Crypto: refresh if price is older than 5 minutes
      if (now.getTime() - lastUpdated.getTime() > CRYPTO_PRICE_MAX_AGE_MS) return true;
    } else {
      // Stocks / funds: no refreshes after 4:15PM ET (market closed, prices frozen)
      if (afterMarketClose) continue;
      if (lastUpdated < prevCutoff) return true;
      if (now >= cutoff && lastUpdated < cutoff) return true;
    }
  }

  return false;
}

// Returns when prices will next become stale for the given holdings.
// For crypto: 5 minutes after the oldest crypto priceUpdatedAt.
// For stocks: the next 8 PM ET cutoff.
export function getNextUpdateTime(holdings: InvestmentHolding[]): Date | null {
  if (holdings.length === 0) return null;

  const now = new Date();
  const candidates: Date[] = [];

  const cryptoUpdates = holdings
    .filter((h) => h.type === "Crypto" && h.priceUpdatedAt)
    .map((h) => new Date(h.priceUpdatedAt!).getTime());

  if (cryptoUpdates.length > 0) {
    const oldest = Math.min(...cryptoUpdates);
    candidates.push(new Date(oldest + CRYPTO_PRICE_MAX_AGE_MS));
  }

  const hasStocks = holdings.some((h) => h.type !== "Crypto");
  if (hasStocks) {
    candidates.push(nextStockCutoff(now));
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
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
