import type { InvestmentHolding } from "@/types";

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

// Returns true if any holding has a stale price and a refresh should be triggered.
//
// For stock/fund holdings: prices are considered stale once it is past 8PM Eastern
// today and the last fetch predates that cutoff. Mutual fund NAVs are typically
// published 1-2 hours after the 4PM ET close, so 8PM gives them plenty of time.
//
// For crypto holdings: prices are considered stale if older than 5 minutes, since
// crypto trades continuously 24/7.
export function isPriceRefreshNeeded(holdings: InvestmentHolding[]): boolean {
  if (holdings.length === 0) return false;

  const now = new Date();
  const cutoff = cutoffToday8pmET(now);
  const prevCutoff = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);

  for (const holding of holdings) {
    if (!holding.priceUpdatedAt) return true;

    const lastUpdated = new Date(holding.priceUpdatedAt);

    if (holding.type === "Crypto") {
      // Crypto: refresh if price is older than 5 minutes
      if (now.getTime() - lastUpdated.getTime() > CRYPTO_PRICE_MAX_AGE_MS) return true;
    } else {
      // Stocks / funds: refresh once per day after 8PM ET
      if (lastUpdated < prevCutoff) return true;
      if (now >= cutoff && lastUpdated < cutoff) return true;
    }
  }

  return false;
}
