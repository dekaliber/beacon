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
