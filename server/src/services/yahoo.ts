// Yahoo Finance price helpers. Shared by the Investments routes (daily price
// refresh + history backfill) and the options basis-snapshot capture.

// ── Fetch the latest price from Yahoo Finance ───────────────────────────────
export async function fetchYahooPrice(ticker: string): Promise<{ price: number; priceDate: Date } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      // Distinguish throttling from a genuinely unknown ticker — a 429 means the
      // whole batch is likely being shed, which looks identical to "no data" at
      // the call site otherwise.
      console.warn(
        `[yahoo] ${ticker}: HTTP ${res.status}` +
          (res.status === 429 ? " — rate limited" : ""),
      );
      return null;
    }
    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result?.meta;
    const price: number | null = meta?.regularMarketPrice ?? null;
    const priceTs: number | null = meta?.regularMarketTime ?? null;
    if (price == null || priceTs == null) return null;
    const priceDate = new Date(priceTs * 1000);
    return { price, priceDate };
  } catch (err) {
    console.warn(`[yahoo] ${ticker}: request failed —`, err);
    return null;
  }
}

// ── Fetch closing price history from Yahoo Finance ───────────────────────────
// Returns daily (date, closePrice) pairs for the given ticker and date range.
// Uses `close`, which Yahoo already reports split-adjusted, rather than
// `adjclose`, which additionally discounts historical prices for every later
// dividend. These rows land in TickerPriceHistory alongside rows written by the
// price refresh from live quotes, so they have to be on the same footing: a
// dividend-adjusted baseline compared against an unadjusted current price turns
// the entire adjustment (2-4% on a dividend payer) into phantom gain.
export async function fetchYahooHistory(
  ticker: string,
  fromDate: Date,
  toDate: Date = new Date()
): Promise<Array<{ date: Date; closePrice: number }>> {
  try {
    const period1 = Math.floor(fromDate.getTime() / 1000);
    const period2 = Math.floor(toDate.getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`[fetchYahooHistory] ${ticker}: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    const adjCloses: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];

    const points: Array<{ date: Date; closePrice: number }> = [];
    for (let i = 0; i < timestamps.length; i++) {
      const price = closes[i] ?? adjCloses[i];
      if (price == null || price <= 0) continue;
      // Normalize to UTC midnight for consistent DATE storage
      const raw = new Date(timestamps[i] * 1000);
      const date = new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
      points.push({ date, closePrice: price });
    }
    return points;
  } catch (err) {
    console.warn(`[fetchYahooHistory] ${ticker}: exception`, err);
    return [];
  }
}

// ── Fetch the closing price for a specific date from Yahoo Finance ───────────
// Looks back up to 7 calendar days to handle weekends and market holidays.
// Prefers adjClose (split/dividend-adjusted); falls back to unadjusted close.
export async function fetchYahooClosingPrice(ticker: string, date: string): Promise<number | null> {
  try {
    // Use end-of-day UTC on the target date so the trading session is fully included,
    // and look back 7 days to handle weekends / holiday closures.
    const targetEnd = new Date(date + "T23:59:59Z");
    const rangeStart = new Date(targetEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    const period1 = Math.floor(rangeStart.getTime() / 1000);
    const period2 = Math.floor(targetEnd.getTime() / 1000);

    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?interval=1d&period1=${period1}&period2=${period2}`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) return null;

    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    // Prefer adjclose (accounts for splits); fall back to regular close
    const adjCloses: (number | null)[] = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];

    for (let i = adjCloses.length - 1; i >= 0; i--) {
      if (adjCloses[i] != null) return adjCloses[i]!;
    }
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) return closes[i]!;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Upcoming earnings dates (Yahoo Finance) — FALLBACK PROVIDER ─────────────
// Yahoo's quote endpoint requires a session cookie plus a matching crumb, and
// the crumb endpoint 429s from datacenter IP ranges — so this works in local
// development but not from a hosted deployment. Finnhub is the primary provider
// (see earnings.ts); this remains so local dev works without an API key.

import type { ProviderResult, RawEarnings, EarningsTiming } from "./earnings.js";

const YAHOO_UA = "Mozilla/5.0";

type CrumbSession = { cookie: string; crumb: string };

let crumbSession: CrumbSession | null = null;
// Concurrent callers share one mint — two tables loading at once shouldn't cost
// two cookie + crumb round-trips.
let crumbMint: Promise<CrumbSession | null> | null = null;

async function getCrumbSession(force = false): Promise<CrumbSession | null> {
  if (crumbSession && !force) return crumbSession;
  if (crumbMint && !force) return crumbMint;
  crumbMint = mintCrumbSession();
  try {
    return await crumbMint;
  } finally {
    crumbMint = null;
  }
}

// Why the last mint failed, surfaced so a blocked deployment is diagnosable
// from the API response rather than looking like "no upcoming earnings".
let lastCrumbFailure: string | null = null;

async function mintCrumbSession(): Promise<CrumbSession | null> {
  crumbSession = null;
  try {
    // fc.yahoo.com answers with an error body but sets the A3 consent cookie,
    // which is what the crumb is issued against.
    const cookieRes = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": YAHOO_UA } });
    const setCookies =
      typeof (cookieRes.headers as any).getSetCookie === "function"
        ? (cookieRes.headers as any).getSetCookie() as string[]
        : [cookieRes.headers.get("set-cookie") ?? ""];
    const cookie = setCookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
    if (!cookie) {
      lastCrumbFailure = `no set-cookie from fc.yahoo.com (HTTP ${cookieRes.status})`;
      console.warn(`[yahoo:crumb] ${lastCrumbFailure}`);
      return null;
    }

    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": YAHOO_UA, Cookie: cookie, Accept: "text/plain" },
    });
    if (!crumbRes.ok) {
      lastCrumbFailure = `getcrumb HTTP ${crumbRes.status}`;
      console.warn(`[yahoo:crumb] ${lastCrumbFailure}`);
      return null;
    }
    const crumb = (await crumbRes.text()).trim();
    // A logged-out/blocked response comes back as HTML rather than a bare token
    // — this is what a rate-limited or geo/IP-blocked host typically gets.
    if (!crumb || crumb.includes("<")) {
      lastCrumbFailure = crumb ? "getcrumb returned HTML, not a token (likely IP-blocked)" : "getcrumb returned empty";
      console.warn(`[yahoo:crumb] ${lastCrumbFailure}`);
      return null;
    }

    lastCrumbFailure = null;
    crumbSession = { cookie, crumb };
    return crumbSession;
  } catch (err) {
    lastCrumbFailure = `mint threw: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[yahoo:crumb] ${lastCrumbFailure}`);
    return null;
  }
}

type QuoteResult =
  | { ok: true; quotes: any[] }
  | { ok: false; reason: string };

// Batched v7 quotes. Reports *why* a lookup failed rather than collapsing every
// failure to null, so a failed lookup stays distinguishable from "no data".
async function fetchYahooQuotes(symbols: string[], retry = true): Promise<QuoteResult> {
  const session = await getCrumbSession();
  if (!session) return { ok: false, reason: lastCrumbFailure ?? "no crumb session" };
  try {
    const url =
      `https://query1.finance.yahoo.com/v7/finance/quote` +
      `?symbols=${symbols.map(encodeURIComponent).join(",")}` +
      `&crumb=${encodeURIComponent(session.crumb)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": YAHOO_UA, Cookie: session.cookie, Accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) {
      // Cookie/crumb pair went stale — mint a fresh one and try once more.
      if (!retry) {
        console.warn(`[yahoo:quote] HTTP ${res.status} after crumb refresh — giving up`);
        return { ok: false, reason: `quote HTTP ${res.status} after crumb refresh` };
      }
      await getCrumbSession(true);
      return fetchYahooQuotes(symbols, false);
    }
    if (!res.ok) {
      // 429 here is the signature of a rate-limited / datacenter-blocked host.
      console.warn(`[yahoo:quote] HTTP ${res.status} for ${symbols.length} symbol(s)`);
      return { ok: false, reason: `quote HTTP ${res.status}` };
    }
    const data = (await res.json()) as any;
    const raw = data?.quoteResponse?.result;
    return { ok: true, quotes: Array.isArray(raw) ? raw : [] };
  } catch (err) {
    console.warn(`[yahoo:quote] threw: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: `quote threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ET calendar date + hour for an instant, used to bucket an earnings call into
// before-open vs. after-close.
function etDateAndHour(ms: number): { date: string; hour: number } {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(d),
    10
  );
  return { date, hour };
}

// Yahoo earnings provider. Caching, request coalescing and the today-filter all
// live in earnings.ts — this just turns a batch of symbols into raw results.
export async function fetchYahooEarningsRaw(symbols: string[]): Promise<ProviderResult> {
  const entries = new Map<string, RawEarnings>();

  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    const r = await fetchYahooQuotes(batch);
    if (!r.ok) return { ok: false, reason: r.reason };

    for (const q of r.quotes) {
      const sym = String(q?.symbol ?? "").toUpperCase();
      if (!sym) continue;
      // earningsTimestampStart is the forward-looking one; plain earningsTimestamp
      // can still point at the last reported quarter.
      const ts: number | null = q.earningsTimestampStart ?? q.earningsTimestamp ?? null;
      if (ts == null) {
        entries.set(sym, { date: null, timing: "UNK", isEstimate: false });
        continue;
      }
      const { date, hour } = etDateAndHour(ts * 1000);
      // Yahoo pins pre-market calls to their actual morning time; anything from
      // midday onward (typically a 4:00 PM ET placeholder) reads as after-close.
      // Yahoo has no during-market-hours signal, so DMH never comes from here.
      const timing: EarningsTiming = hour < 12 ? "BMO" : "AMC";
      entries.set(sym, { date, timing, isEstimate: q.isEarningsDateEstimate === true });
    }

    // The quote call is batched, so a symbol missing from a successful response
    // is one Yahoo doesn't cover — a real answer, not a failure. Record it
    // explicitly, otherwise the caller would treat the gap as an error and
    // re-query it forever.
    for (const sym of batch) {
      if (!entries.has(sym)) entries.set(sym, { date: null, timing: "UNK", isEstimate: false });
    }
  }

  return { ok: true, entries };
}

// ── Fetch display name + instrument type from Yahoo Finance ──────────────────
// Used when creating a holding so it shows the company name (not just the
// ticker). Falls back to the ticker symbol when the lookup yields no name.
const QUOTE_TYPE_MAP: Record<string, string> = {
  EQUITY: "Equity",
  ETF: "ETF",
  MUTUALFUND: "Mutual Fund",
};

export async function fetchYahooMeta(ticker: string): Promise<{ name: string; type: string | null }> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=5&newsCount=0&listsCount=0`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`[fetchYahooMeta] ${ticker}: HTTP ${res.status}`);
      return { name: ticker, type: null };
    }
    const data = await res.json() as any;
    const quotes: any[] = data?.quotes ?? [];
    // Prefer exact symbol match, fall back to first result
    const match =
      quotes.find((q) => q.symbol?.toUpperCase() === ticker.toUpperCase()) ??
      quotes[0];
    const name = (match?.longname || match?.shortname || ticker) as string;
    const type = match?.quoteType ? (QUOTE_TYPE_MAP[match.quoteType] ?? match.quoteType) : null;
    if (name === ticker) {
      console.warn(`[fetchYahooMeta] ${ticker}: no name found in results`, quotes.map((q) => q.symbol));
    }
    return { name, type };
  } catch (err) {
    console.warn(`[fetchYahooMeta] ${ticker}: exception`, err);
    return { name: ticker, type: null };
  }
}
