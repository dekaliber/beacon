// Upcoming earnings dates — provider-agnostic cache, request coalescing, and
// provider selection.
//
// Finnhub is primary: it's a real API contract (key, documented rate limit) and
// reports the before-open / after-close slot natively, rather than leaving it to
// be inferred from a timestamp. Yahoo stays as an automatic fallback so local
// development works without a key — but Yahoo blocks datacenter IPs at the crumb
// endpoint, so it is not viable in production (see fetchYahooEarningsRaw).

import { fetchFinnhubEarningsRaw, finnhubConfigured } from "./finnhub.js";
import { fetchYahooEarningsRaw } from "./yahoo.js";

/**
 * Before market open, after market close, during market hours, or unknown —
 * providers often carry the date without the slot.
 */
export type EarningsTiming = "BMO" | "AMC" | "DMH" | "UNK";

export interface EarningsInfo {
  /** Earnings date in ET, as YYYY-MM-DD. */
  date: string;
  timing: EarningsTiming;
  /** True when the provider is projecting the date rather than confirming it. */
  isEstimate: boolean;
}

/** One symbol's result from a provider, before caching. */
export interface RawEarnings {
  /** Next earnings date (YYYY-MM-DD, ET), or null when the provider has none. */
  date: string | null;
  timing: EarningsTiming;
  isEstimate: boolean;
}

export type ProviderResult =
  // `entries` must contain an entry for every symbol the provider actually
  // resolved — including `date: null` for "resolved, no upcoming earnings".
  // Symbols whose own request errored go in `failedSymbols` (or are simply
  // absent) so they are never cached as a negative result.
  | { ok: true; entries: Map<string, RawEarnings>; failedSymbols?: string[] }
  | { ok: false; reason: string };

export interface EarningsLookup {
  earnings: Map<string, EarningsInfo | null>;
  /** Symbols whose upstream lookup errored — distinct from having no date. */
  failed: string[];
  /** Why the lookup failed, when it did. */
  failureReason: string | null;
}

// Earnings dates move rarely, so a few hours of staleness is harmless and keeps
// us well clear of any provider's rate limit. The date is cached rather than the
// derived EarningsInfo so the "already passed" filter always uses a live date.
const TTL_MS = 6 * 60 * 60 * 1000;
type CacheEntry = RawEarnings & { at: number };
const cache = new Map<string, CacheEntry>();

// Symbols currently being fetched. The cache is only written once a request
// resolves, so without this two callers landing together (the Open Positions
// table and the Assigned Lots card both mount at page load, with overlapping
// tickers) would each miss the cache and each hit the provider.
const inFlight = new Map<string, Promise<CacheEntry | null>>();

// Reason the most recent upstream lookup failed, or null when it succeeded.
// Reported by the route so a blocked host is visible from the response instead
// of masquerading as "no upcoming earnings".
let lastFailure: string | null = null;

const PROVIDERS = [
  { name: "finnhub", available: finnhubConfigured, fetch: fetchFinnhubEarningsRaw },
  { name: "yahoo", available: () => true, fetch: fetchYahooEarningsRaw },
];

// Try each configured provider in order, falling through on failure. Returns the
// first success, or the accumulated reasons when every provider failed.
async function fetchFromProviders(batch: string[]): Promise<ProviderResult> {
  const reasons: string[] = [];
  for (const p of PROVIDERS) {
    if (!p.available()) {
      reasons.push(`${p.name}: not configured`);
      continue;
    }
    const r = await p.fetch(batch);
    if (r.ok) {
      if (reasons.length > 0) {
        console.warn(`[earnings] served by ${p.name} after: ${reasons.join("; ")}`);
      }
      return r;
    }
    reasons.push(`${p.name}: ${r.reason}`);
  }
  return { ok: false, reason: reasons.join("; ") || "no providers configured" };
}

// One provider round-trip for a batch of symbols. Never rejects: a failed lookup
// yields nulls and writes nothing, so the next call retries rather than caching
// the failure.
async function fetchBatch(batch: string[]): Promise<Map<string, CacheEntry | null>> {
  const result = new Map<string, CacheEntry | null>();
  const r = await fetchFromProviders(batch);
  if (!r.ok) {
    lastFailure = r.reason;
    for (const sym of batch) result.set(sym, null);
    return result;
  }
  const now = Date.now();
  const failedSymbols = new Set(r.failedSymbols ?? []);
  let anyFailed = false;
  for (const sym of batch) {
    const raw = r.entries.get(sym);
    // Absent or explicitly failed means *that symbol's* lookup errored — the
    // providers fill in an explicit `date: null` for a symbol they resolved but
    // have no earnings for. Caching an error as "no earnings" would blank the
    // warning for a full TTL on one ticker while every other ticker worked, so
    // leave it uncached and let the next call retry.
    if (raw === undefined || failedSymbols.has(sym)) {
      anyFailed = true;
      result.set(sym, null);
      continue;
    }
    const entry: CacheEntry = { ...raw, at: now };
    cache.set(sym, entry);
    result.set(sym, entry);
  }
  if (!anyFailed) lastFailure = null;
  return result;
}

// Next earnings date per symbol. `today` (YYYY-MM-DD) filters out dates that
// have already passed; symbols with no upcoming date map to null.
export async function fetchUpcomingEarnings(
  symbols: string[],
  today: string
): Promise<EarningsLookup> {
  const out = new Map<string, EarningsInfo | null>();
  const failed: string[] = [];
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return { earnings: out, failed, failureReason: null };

  const now = Date.now();
  const toInfo = (e: CacheEntry | null): EarningsInfo | null => {
    if (e?.date == null || e.date < today) return null;
    return { date: e.date, timing: e.timing, isEstimate: e.isEstimate };
  };

  const pending: Promise<void>[] = [];
  const fresh: string[] = [];

  for (const sym of wanted) {
    const hit = cache.get(sym);
    if (hit && now - hit.at < TTL_MS) {
      out.set(sym, toInfo(hit));
      continue;
    }
    const existing = inFlight.get(sym);
    if (existing) {
      pending.push(existing.then((e) => {
        if (e == null) failed.push(sym);
        out.set(sym, toInfo(e));
      }));
      continue;
    }
    fresh.push(sym);
  }

  for (let i = 0; i < fresh.length; i += 50) {
    const batch = fresh.slice(i, i + 50);
    const batchPromise = fetchBatch(batch);
    for (const sym of batch) {
      const p = batchPromise.then((m) => m.get(sym) ?? null);
      inFlight.set(sym, p);
      // A null entry means the upstream call errored — an unknown-but-reachable
      // symbol still gets a real entry with date: null.
      pending.push(p.then((e) => {
        if (e == null) failed.push(sym);
        out.set(sym, toInfo(e));
      }));
    }
    // Release the in-flight slots once settled; callers already hold the promise.
    void batchPromise.finally(() => { for (const sym of batch) inFlight.delete(sym); });
  }

  await Promise.all(pending);
  return { earnings: out, failed, failureReason: failed.length > 0 ? lastFailure : null };
}
