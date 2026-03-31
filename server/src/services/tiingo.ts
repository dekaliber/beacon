/**
 * Tiingo API service — used for dividend detection, name/metadata resolution,
 * and price fallback for tickers Yahoo Finance does not support (e.g. money
 * market funds traded on NMFQS such as VUSXX, VMFXX).
 *
 * Key design notes:
 *
 * - All price data uses `close` (unadjusted NAV), NOT `adjClose`.
 *   For money market funds the NAV is always $1.00; adjClose is
 *   backward-adjusted for dividends and therefore meaningless here.
 *   For normal mutual funds and ETFs, using close is also safe because
 *   Tiingo is only invoked as a fallback for tickers Yahoo can't resolve,
 *   and those are overwhelmingly stable-NAV instruments.
 *
 * - getDividendScanResult returns both dividend events AND the latest
 *   closing price from the same API call so the price refresh pipeline
 *   can piggyback on the dividend scan without a second round-trip.
 *
 * API key is read from TIINGO_API_TOKEN in the server environment.
 */

const TIINGO_BASE = "https://api.tiingo.com/tiingo/daily";

function tiingoToken(): string {
  const token = process.env.TIINGO_API_TOKEN;
  if (!token) throw new Error("TIINGO_API_TOKEN is not set in the server environment");
  return token;
}

interface TiingoDailyRow {
  date: string;     // ISO 8601, e.g. "2026-03-17T00:00:00.000Z"
  close: number;    // unadjusted closing price / NAV (always 1.00 for MMFs)
  adjClose: number; // adjusted close — do NOT use for money market funds
  divCash: number;  // 0.0 on non-dividend days
}

interface TiingoMetaResponse {
  ticker: string;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  exchangeCode: string;
}

export interface TiingoMeta {
  /** Display name, e.g. "VANGUARD TREASURY MONEY MARKET FUND INVESTOR SHARES" */
  name: string;
  /** Exchange code, e.g. "NMFQS" for NASDAQ Money Market Fund Quotation System */
  exchangeCode: string;
}

export interface DividendEvent {
  /** Ex-date in YYYY-MM-DD format */
  exDate: string;
  /** Per-share dividend amount at full Tiingo precision (up to 6 dp) */
  perShareAmount: number;
}

export interface DividendScanResult {
  /** Dividend events in the requested date window */
  dividends: DividendEvent[];
  /**
   * Most recent closing price from the same API response.
   * Uses `close` (unadjusted) — correct for money market funds and safe for
   * all other Tiingo-sourced tickers. Null only if the rows array was empty.
   */
  latestClose: number | null;
  /** ISO date string (YYYY-MM-DD) of the latestClose row, or null */
  latestCloseDate: string | null;
}

/** Shared fetch helper — avoids repeating headers/error handling. */
async function tiingoFetch(path: string): Promise<Response> {
  const res = await fetch(`${TIINGO_BASE}/${path}`, {
    headers: {
      Authorization: `Token ${tiingoToken()}`,
      "Content-Type": "application/json",
    },
  });
  return res;
}

/**
 * Resolve a ticker to its display name and exchange code.
 * Returns null if the ticker is not in Tiingo's database (404).
 *
 * @throws on non-404 HTTP errors or missing API token
 */
export async function getMetadata(ticker: string): Promise<TiingoMeta | null> {
  const res = await tiingoFetch(encodeURIComponent(ticker));

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Tiingo metadata error for ${ticker}: ${res.status} ${res.statusText}`);
  }

  const data: TiingoMetaResponse = await res.json();
  return { name: data.name, exchangeCode: data.exchangeCode };
}

/**
 * Fetch dividend events AND the latest closing price for a ticker
 * between startDate and endDate (inclusive) in a single API call.
 *
 * This is the preferred function to use during the dividend scan so
 * that the price refresh pipeline can piggyback on the same request.
 *
 * @throws if the API token is missing or the request fails with a non-404 error
 */
export async function getDividendScanResult(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<DividendScanResult> {
  const res = await tiingoFetch(
    `${encodeURIComponent(ticker)}/prices?startDate=${startDate}&endDate=${endDate}`,
  );

  if (!res.ok) {
    if (res.status === 404) return { dividends: [], latestClose: null, latestCloseDate: null };
    throw new Error(`Tiingo API error for ${ticker}: ${res.status} ${res.statusText}`);
  }

  const rows: TiingoDailyRow[] = await res.json();

  const dividends: DividendEvent[] = rows
    .filter((row) => row.divCash > 0)
    .map((row) => ({
      exDate: row.date.slice(0, 10),
      perShareAmount: row.divCash,
    }));

  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const latestClose = last?.close ?? null;
  const latestCloseDate = last ? last.date.slice(0, 10) : null;

  return { dividends, latestClose, latestCloseDate };
}

/**
 * Fetch dividend events for a ticker between startDate and endDate (inclusive).
 * Returns only rows where divCash > 0.
 *
 * Prefer getDividendScanResult() when you also need the latest price —
 * it returns both from the same API call.
 *
 * @throws if the API token is missing or the request fails
 */
export async function getDividendEvents(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<DividendEvent[]> {
  const result = await getDividendScanResult(ticker, startDate, endDate);
  return result.dividends;
}

/**
 * Fetch the closing price for a ticker on or before the given date.
 * Searches up to 7 calendar days back to find the nearest prior trading day.
 * Uses `close` (unadjusted NAV) — correct for money market funds.
 * Returns null if no data is found.
 *
 * @throws if the API token is missing or the request fails with a non-404 error
 */
export async function getClosingPrice(
  ticker: string,
  date: string, // YYYY-MM-DD
): Promise<number | null> {
  const dt = new Date(date + "T00:00:00Z");
  const startDt = new Date(dt.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startDate = startDt.toISOString().slice(0, 10);

  const res = await tiingoFetch(
    `${encodeURIComponent(ticker)}/prices?startDate=${startDate}&endDate=${date}`,
  );

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Tiingo API error for ${ticker}: ${res.status} ${res.statusText}`);
  }

  const rows: TiingoDailyRow[] = await res.json();
  if (!rows.length) return null;

  // Last row is the most recent trading day on or before the requested date.
  // Use close (unadjusted), not adjClose — safe for all Tiingo-sourced tickers
  // and essential for money market funds where adjClose != 1.00.
  return rows[rows.length - 1].close;
}
