/**
 * Tiingo API service — used exclusively for dividend detection.
 *
 * The free-tier daily prices endpoint embeds a `divCash` field on the
 * ex-date row, providing full-precision per-share dividend amounts
 * (e.g. 0.331063) that Yahoo Finance truncates to 2–3 decimal places.
 *
 * API key is read from TIINGO_API_TOKEN in the server environment.
 */

const TIINGO_BASE = "https://api.tiingo.com/tiingo/daily";

interface TiingoDailyRow {
  date: string;     // ISO 8601, e.g. "2026-03-17T00:00:00.000Z"
  divCash: number;  // 0.0 on non-dividend days
  adjClose: number; // adjusted closing price (accounts for splits/dividends)
  close: number;    // unadjusted closing price
}

export interface DividendEvent {
  /** Ex-date in YYYY-MM-DD format */
  exDate: string;
  /** Per-share dividend amount at full Tiingo precision (up to 6 dp) */
  perShareAmount: number;
}

/**
 * Fetch the closing price for a ticker on or before the given date.
 * Searches up to 7 calendar days back to find the nearest prior trading day.
 * Returns `adjClose` (adjusted for splits/dividends) or falls back to `close`.
 * Returns null if no data is found.
 *
 * @throws if the API token is missing or the request fails with a non-404 error
 */
export async function getClosingPrice(
  ticker: string,
  date: string, // YYYY-MM-DD
): Promise<number | null> {
  const token = process.env.TIINGO_API_TOKEN;
  if (!token) {
    throw new Error("TIINGO_API_TOKEN is not set in the server environment");
  }

  // Fetch the week leading up to (and including) the requested date so we
  // always land on a valid trading day even if the date falls on a weekend.
  const dt = new Date(date + "T00:00:00Z");
  const startDt = new Date(dt.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startDate = startDt.toISOString().slice(0, 10);

  const url =
    `${TIINGO_BASE}/${encodeURIComponent(ticker)}/prices` +
    `?startDate=${startDate}&endDate=${date}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(
      `Tiingo API error for ${ticker}: ${res.status} ${res.statusText}`,
    );
  }

  const rows: TiingoDailyRow[] = await res.json();
  if (!rows.length) return null;

  // Last row is the most recent trading day on or before the requested date
  const last = rows[rows.length - 1];
  return last.adjClose ?? last.close ?? null;
}

/**
 * Fetch dividend events for a ticker between startDate and endDate (inclusive).
 * Returns only rows where divCash > 0.
 *
 * @throws if the API token is missing or the request fails
 */
export async function getDividendEvents(
  ticker: string,
  startDate: string,
  endDate: string,
): Promise<DividendEvent[]> {
  const token = process.env.TIINGO_API_TOKEN;
  if (!token) {
    throw new Error("TIINGO_API_TOKEN is not set in the server environment");
  }

  const url = `${TIINGO_BASE}/${encodeURIComponent(ticker)}/prices` +
    `?startDate=${startDate}&endDate=${endDate}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Token ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    // 404 typically means the ticker isn't in Tiingo's database
    if (res.status === 404) return [];
    throw new Error(
      `Tiingo API error for ${ticker}: ${res.status} ${res.statusText}`,
    );
  }

  const rows: TiingoDailyRow[] = await res.json();

  return rows
    .filter((row) => row.divCash > 0)
    .map((row) => ({
      exDate: row.date.slice(0, 10), // "2026-03-17T00:00:00.000Z" → "2026-03-17"
      perShareAmount: row.divCash,
    }));
}
