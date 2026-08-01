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
    if (!res.ok) return null;
    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result?.meta;
    const price: number | null = meta?.regularMarketPrice ?? null;
    const priceTs: number | null = meta?.regularMarketTime ?? null;
    if (price == null || priceTs == null) return null;
    const priceDate = new Date(priceTs * 1000);
    return { price, priceDate };
  } catch {
    return null;
  }
}

// ── Fetch adjusted-close price history from Yahoo Finance ────────────────────
// Returns daily (date, closePrice) pairs for the given ticker and date range.
// Uses adjclose so that stock splits and dividends don't create artificial jumps.
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
    const adjCloses: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];

    const points: Array<{ date: Date; closePrice: number }> = [];
    for (let i = 0; i < timestamps.length; i++) {
      const price = adjCloses[i];
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

// ── Upcoming earnings dates (Yahoo Finance) ─────────────────────────────────
// Tradier has no corporate-events feed, so earnings dates come from Yahoo's
// quote endpoint. That endpoint requires a session cookie plus a matching
// crumb, so we mint a session once, reuse it, and re-mint on the first 401.

const YAHOO_UA = "Mozilla/5.0";

export type EarningsTiming = "BMO" | "AMC";

export interface EarningsInfo {
  /** Earnings date in ET, as YYYY-MM-DD. */
  date: string;
  /** Before market open vs. after market close, derived from the ET hour. */
  timing: EarningsTiming;
  /** True when Yahoo is projecting the date rather than quoting a confirmed one. */
  isEstimate: boolean;
}

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
    if (!cookie) return null;

    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": YAHOO_UA, Cookie: cookie, Accept: "text/plain" },
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    // A logged-out/blocked response comes back as HTML rather than a bare token.
    if (!crumb || crumb.includes("<")) return null;

    crumbSession = { cookie, crumb };
    return crumbSession;
  } catch {
    return null;
  }
}

// Batched v7 quotes. Returns null (rather than []) when the call fails, so
// callers can tell "no data" apart from "lookup failed" and skip caching.
async function fetchYahooQuotes(symbols: string[], retry = true): Promise<any[] | null> {
  const session = await getCrumbSession();
  if (!session) return null;
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
      if (!retry) return null;
      await getCrumbSession(true);
      return fetchYahooQuotes(symbols, false);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const raw = data?.quoteResponse?.result;
    return Array.isArray(raw) ? raw : [];
  } catch {
    return null;
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

// Earnings dates move rarely, so a few hours of staleness is harmless and keeps
// us well clear of Yahoo's rate limits. The raw timestamp is cached (not the
// derived EarningsInfo) so the "already passed" filter always uses a live date.
const EARNINGS_TTL_MS = 6 * 60 * 60 * 1000;
type EarningsEntry = { at: number; ts: number | null; isEstimate: boolean };
const earningsCache = new Map<string, EarningsEntry>();

// Symbols currently being fetched. The cache is only written once a request
// resolves, so without this two callers landing together (the Open Positions
// table and the Assigned Lots card both mount at page load, with overlapping
// tickers) would each miss the cache and each hit Yahoo for the same symbols.
const inFlight = new Map<string, Promise<EarningsEntry | null>>();

// One Yahoo round-trip for a batch of symbols. Never rejects: a failed lookup
// yields nulls and writes nothing, so the next call retries rather than
// caching the failure.
async function fetchEarningsBatch(batch: string[]): Promise<Map<string, EarningsEntry | null>> {
  const result = new Map<string, EarningsEntry | null>();
  const quotes = await fetchYahooQuotes(batch);
  if (quotes == null) {
    for (const sym of batch) result.set(sym, null);
    return result;
  }
  const now = Date.now();
  for (const q of quotes) {
    const sym = String(q?.symbol ?? "").toUpperCase();
    if (!sym) continue;
    // earningsTimestampStart is the forward-looking one; plain earningsTimestamp
    // can still point at the last reported quarter.
    const entry: EarningsEntry = {
      at: now,
      ts: q.earningsTimestampStart ?? q.earningsTimestamp ?? null,
      isEstimate: q.isEarningsDateEstimate === true,
    };
    earningsCache.set(sym, entry);
    result.set(sym, entry);
  }
  // Symbols Yahoo dropped from the response have no earnings coverage.
  for (const sym of batch) {
    if (result.has(sym)) continue;
    const entry: EarningsEntry = { at: now, ts: null, isEstimate: false };
    earningsCache.set(sym, entry);
    result.set(sym, entry);
  }
  return result;
}

// Next earnings date per symbol. `today` (YYYY-MM-DD) filters out dates that
// have already passed; symbols with no upcoming date map to null.
export async function fetchYahooEarnings(
  symbols: string[],
  today: string
): Promise<Map<string, EarningsInfo | null>> {
  const out = new Map<string, EarningsInfo | null>();
  const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return out;

  const now = Date.now();
  const toEarnings = (e: EarningsEntry | null): EarningsInfo | null => {
    if (e?.ts == null) return null;
    const { date, hour } = etDateAndHour(e.ts * 1000);
    if (date < today) return null;
    // Yahoo pins pre-market calls to their actual morning time; anything from
    // midday onward (typically a 4:00 PM ET placeholder) reads as after-close.
    return { date, timing: hour < 12 ? "BMO" : "AMC", isEstimate: e.isEstimate };
  };

  const pending: Promise<void>[] = [];
  const fresh: string[] = [];

  for (const sym of wanted) {
    const hit = earningsCache.get(sym);
    if (hit && now - hit.at < EARNINGS_TTL_MS) {
      out.set(sym, toEarnings(hit));
      continue;
    }
    const existing = inFlight.get(sym);
    if (existing) {
      pending.push(existing.then((e) => { out.set(sym, toEarnings(e)); }));
      continue;
    }
    fresh.push(sym);
  }

  for (let i = 0; i < fresh.length; i += 50) {
    const batch = fresh.slice(i, i + 50);
    const batchPromise = fetchEarningsBatch(batch);
    for (const sym of batch) {
      const p = batchPromise.then((m) => m.get(sym) ?? null);
      inFlight.set(sym, p);
      pending.push(p.then((e) => { out.set(sym, toEarnings(e)); }));
    }
    // Release the in-flight slots once settled; callers already hold the promise.
    void batchPromise.finally(() => { for (const sym of batch) inFlight.delete(sym); });
  }

  await Promise.all(pending);
  return out;
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
