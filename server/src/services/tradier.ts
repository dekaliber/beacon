// Tradier market-data helpers. Only /markets/* endpoints are ever called — the
// token may be a brokerage-account token, so nothing here touches /accounts or
// /orders.

import { etDateParts } from "../lib/marketHolidays.js";

export const TRADIER_BASE = "https://api.tradier.com/v1";

export function tradierHeaders(): Record<string, string> {
  const token = process.env.TRADIER_API_TOKEN;
  if (!token) throw new Error("TRADIER_API_TOKEN is not set in the server environment");
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// Tradier returns a bare object instead of a one-element array for single results.
function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Today's calendar date in America/New_York as "YYYY-MM-DD" (the options-market day). */
export function todayET(): string {
  const { year, month, day } = etDateParts(Date.now());
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Calendar days between two bare YYYY-MM-DD dates (timezone-free date arithmetic).
function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split("-").map(Number);
  const [ty, tm, td] = toYmd.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/** Underlying last (or close) per symbol, uppercased keys. */
export async function fetchUnderlyingPrices(symbols: string[]): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (symbols.length === 0) return map;
  const url = `${TRADIER_BASE}/markets/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}&greeks=false`;
  const r = await fetch(url, { headers: tradierHeaders() });
  if (!r.ok) return map;
  const data = await r.json() as any;
  for (const q of asArray<any>(data?.quotes?.quote)) {
    if (q?.symbol) map.set(String(q.symbol).toUpperCase(), q.last ?? q.close ?? null);
  }
  return map;
}

export interface ChainFilter {
  symbol: string;
  /** Exact expiration (YYYY-MM-DD). When set, the DTE range is ignored. */
  expiration?: string;
  minDte?: number | null;
  maxDte?: number | null;
  side: "CALL" | "PUT" | "BOTH";
  /** Absolute-delta bounds. When either is set, rows with no delta are excluded. */
  minAbsDelta?: number | null;
  maxAbsDelta?: number | null;
  strikeMin?: number | null;
  strikeMax?: number | null;
  minOI?: number | null;
  minVolume?: number | null;
  /** Fetch at most this many (nearest) eligible expirations. */
  maxExpirations?: number;
}

export interface ChainRow {
  symbol: string;
  expiration: string;
  dte: number;
  optionType: "CALL" | "PUT";
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  mid: number | null;
  volume: number | null;
  openInterest: number | null;
  inTheMoney: boolean | null;
  delta: number | null;
  midIv: number | null;
  smvVol: number | null;
  /** ISO UTC time Tradier last refreshed the greeks (they lag quotes, ~hourly). */
  greeksUpdatedAt: string | null;
}

/**
 * Filtered option chain rows for one underlying, sorted expiration → type → strike.
 * DTE is counted from today's date in America/New_York, so it doesn't depend on
 * the server's timezone.
 */
export async function fetchFilteredChain(f: ChainFilter): Promise<ChainRow[]> {
  const headers = tradierHeaders();
  const today = todayET();

  let expirations: string[];
  if (f.expiration) {
    expirations = [f.expiration];
  } else {
    const expUrl = `${TRADIER_BASE}/markets/options/expirations?symbol=${encodeURIComponent(f.symbol)}&includeAllRoots=false`;
    const expRes = await fetch(expUrl, { headers });
    if (!expRes.ok) return [];
    const expData = await expRes.json() as any;
    expirations = asArray<string>(expData?.expirations?.date)
      .filter((d) => {
        const dte = daysBetween(today, d);
        if (f.minDte != null && dte < f.minDte) return false;
        if (f.maxDte != null && dte > f.maxDte) return false;
        return true;
      })
      .sort();
  }
  if (f.maxExpirations != null) expirations = expirations.slice(0, f.maxExpirations);

  const hasDeltaBound = f.minAbsDelta != null || f.maxAbsDelta != null;
  const rows: ChainRow[] = [];

  for (const expiration of expirations) {
    const chainUrl = `${TRADIER_BASE}/markets/options/chains?symbol=${encodeURIComponent(f.symbol)}&expiration=${encodeURIComponent(expiration)}&greeks=true`;
    const chainRes = await fetch(chainUrl, { headers });
    if (!chainRes.ok) continue;
    const chainData = await chainRes.json() as any;
    const dte = daysBetween(today, expiration);

    for (const opt of asArray<any>(chainData?.options?.option)) {
      const optionType: "CALL" | "PUT" = String(opt.option_type ?? "").toLowerCase() === "call" ? "CALL" : "PUT";
      if (f.side !== "BOTH" && optionType !== f.side) continue;

      const strike: number = opt.strike;
      if (f.strikeMin != null && strike < f.strikeMin) continue;
      if (f.strikeMax != null && strike > f.strikeMax) continue;

      const delta: number | null = opt.greeks?.delta ?? null;
      if (hasDeltaBound) {
        if (delta == null) continue;
        const absDelta = Math.abs(delta);
        if (f.minAbsDelta != null && absDelta < f.minAbsDelta) continue;
        if (f.maxAbsDelta != null && absDelta > f.maxAbsDelta) continue;
      }

      const openInterest: number | null = opt.open_interest ?? null;
      if (f.minOI != null && openInterest != null && openInterest < f.minOI) continue;
      const volume: number | null = opt.volume ?? null;
      if (f.minVolume != null && volume != null && volume < f.minVolume) continue;

      const bid: number | null = opt.bid ?? null;
      const ask: number | null = opt.ask ?? null;
      // Tradier's greeks.updated_at is a bare "YYYY-MM-DD HH:MM:SS" in UTC.
      const rawGreekTime: string | null = opt.greeks?.updated_at ?? null;

      rows.push({
        symbol: f.symbol,
        expiration,
        dte,
        optionType,
        strike,
        bid,
        ask,
        last: opt.last ?? null,
        mid: bid != null && ask != null && ask > 0 ? Math.round(((bid + ask) / 2) * 10000) / 10000 : null,
        volume,
        openInterest,
        inTheMoney: opt.in_the_money ?? null,
        delta,
        midIv: opt.greeks?.mid_iv ?? null,
        smvVol: opt.greeks?.smv_vol ?? null,
        greeksUpdatedAt: rawGreekTime ? new Date(rawGreekTime.replace(" ", "T") + "Z").toISOString() : null,
      });
    }
  }

  rows.sort((a, b) =>
    a.expiration.localeCompare(b.expiration) ||
    a.optionType.localeCompare(b.optionType) ||
    a.strike - b.strike,
  );
  return rows;
}
