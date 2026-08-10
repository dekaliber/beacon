// Earnings-date risk helpers, shared by the Options Trading page and the
// Assigned Lots table. An earnings call is the main gap-risk event for a short
// option or an assigned stock lot, so we flag when one is coming up.

import type { EarningsInfo } from "@/api";
import { localToday } from "@/lib/utils";

// How far ahead an open-ended holding (an assigned lot, with no expiration to
// measure against) counts earnings as "upcoming". Covers about a month of
// covered-call cycles — long enough to matter when deciding whether to write a
// call, short enough that the indicator stays meaningful rather than always-on.
export const EARNINGS_SOON_DAYS = 30;

// Inside this window earnings are imminent enough to escalate the indicator
// from warn to down, separating "right around the corner" from "sometime this
// month".
export const EARNINGS_IMMINENT_DAYS = 7;

// True when the earnings call lands before the option expires. Same-day earnings
// only count when they land before the 4pm close — an after-close call on
// expiration day happens once the contract has already settled. An unknown slot
// counts, deliberately: suppressing a same-day warning on a guess would hide
// real risk, and over-warning by a few hours is the cheaper error.
export function earningsBeforeExpiry(
  e: EarningsInfo | null | undefined,
  expiration: string
): boolean {
  if (!e) return false;
  const exp = expiration.split("T")[0];
  return e.date < exp || (e.date === exp && e.timing !== "AMC");
}

// True when the earnings call falls within `days` of today. Used where there's
// no expiration to compare against, so proximity is the only signal available.
export function earningsWithinDays(
  e: EarningsInfo | null | undefined,
  days: number = EARNINGS_SOON_DAYS,
  today: string = localToday()
): boolean {
  if (!e || e.date < today) return false;
  const horizon = new Date(today + "T00:00:00");
  horizon.setDate(horizon.getDate() + days);
  const h = `${horizon.getFullYear()}-${String(horizon.getMonth() + 1).padStart(2, "0")}-${String(horizon.getDate()).padStart(2, "0")}`;
  return e.date <= h;
}

// "Earnings expected after close on 8/4", or just "Earnings expected on 8/4"
// when the provider gave a date but no reporting slot.
export function earningsWarningText(e: EarningsInfo): string {
  const [, m, d] = e.date.split("-").map(Number);
  const when =
    e.timing === "BMO" ? "before open " :
    e.timing === "AMC" ? "after close " :
    e.timing === "DMH" ? "during market hours " :
    "";
  return `Earnings expected ${when}on ${m}/${d}`;
}
