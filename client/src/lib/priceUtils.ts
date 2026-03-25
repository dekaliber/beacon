import type { InvestmentHolding } from "@/types";

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

// Returns true if any holding has a stale price and a refresh should be triggered.
// Prices are considered stale once it is past 8PM Eastern today and the last fetch
// predates that cutoff. Mutual fund NAVs are typically published 1-2 hours after
// the 4PM ET close, so 8PM gives them plenty of time to settle.
export function isPriceRefreshNeeded(holdings: InvestmentHolding[]): boolean {
  if (holdings.length === 0) return false;

  const now = new Date();
  const cutoff = cutoffToday8pmET(now);
  const prevCutoff = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);

  for (const holding of holdings) {
    if (!holding.priceUpdatedAt) return true;

    const lastUpdated = new Date(holding.priceUpdatedAt);

    // Price is from a previous calendar day (ET) — always refresh
    if (lastUpdated < prevCutoff) return true;

    // It's past 8PM ET and the last update predates today's cutoff — refresh
    if (now >= cutoff && lastUpdated < cutoff) return true;
  }

  return false;
}
