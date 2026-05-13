import type { InvestmentHolding } from "@/types";

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

// Returns a Date representing 8:00 PM Eastern today.
// Uses the current ET UTC offset (via shortOffset) so DST is handled automatically.
function cutoffToday8pmET(now: Date): Date {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const get = (type: string) => dateParts.find((p) => p.type === type)!.value;

  const tzPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(now).find((p) => p.type === "timeZoneName")!.value;

  const offsetMatch = tzPart.match(/GMT([+-])(\d+)/)!;
  const offsetStr = `${offsetMatch[1]}${offsetMatch[2].padStart(2, "0")}:00`;

  return new Date(`${get("year")}-${get("month")}-${get("day")}T20:00:00${offsetStr}`);
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

// Returns true if any holding has a stale price and a refresh should be triggered.
//
// For stock/fund holdings: prices are considered stale once it is past 8PM Eastern
// today and the last fetch predates that cutoff. Mutual fund NAVs are typically
// published 1-2 hours after the 4PM ET close, so 8PM gives them plenty of time.
// No refreshes are triggered after 5PM ET — markets are closed and prices won't change.
//
// For crypto holdings: prices are considered stale if older than 5 minutes, since
// crypto trades continuously 24/7.
export function isPriceRefreshNeeded(holdings: InvestmentHolding[]): boolean {
  if (holdings.length === 0) return false;

  const now = new Date();
  const cutoff = cutoffToday8pmET(now);
  const prevCutoff = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);
  const afterMarketClose = currentHourET(now) >= 17;

  for (const holding of holdings) {
    if (!holding.priceUpdatedAt) return true;

    const lastUpdated = new Date(holding.priceUpdatedAt);

    if (holding.type === "Crypto") {
      // Crypto: refresh if price is older than 5 minutes
      if (now.getTime() - lastUpdated.getTime() > CRYPTO_PRICE_MAX_AGE_MS) return true;
    } else {
      // Stocks / funds: no refreshes after 5PM ET (market closed, prices frozen)
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
