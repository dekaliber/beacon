/**
 * CoinGecko API service — used for crypto asset search, live prices,
 * and daily price history.
 *
 * Key design notes:
 *
 * - All public endpoints used here require no API key on the free tier.
 *   Rate limit is ~30 req/min; batch price fetching keeps call count low.
 *
 * - CoinGecko identifies coins by a stable string ID (e.g. "bitcoin",
 *   "icon", "tether") rather than symbol. Symbols are NOT unique across
 *   the ecosystem. The coinGeckoId is stored on InvestmentHolding and used
 *   as the lookup key for all price/history requests.
 *
 * - Prices are stored in TickerPrice under the coin's symbol (e.g. "BTC")
 *   with priceSource = "COINGECKO". The coinGeckoId → symbol mapping lives
 *   on the holding record, not in TickerPrice.
 */

const BASE = "https://api.coingecko.com/api/v3";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CoinSearchResult {
  /** Stable CoinGecko identifier, e.g. "bitcoin" */
  id: string;
  /** Uppercase trading symbol, e.g. "BTC" */
  symbol: string;
  /** Display name, e.g. "Bitcoin" */
  name: string;
  /** Market cap rank, null for unranked coins */
  marketCapRank: number | null;
}

export interface CoinPrice {
  /** USD price */
  price: number;
  /** Timestamp of the last price update from CoinGecko */
  updatedAt: Date;
}

// ── Shared fetch helper ───────────────────────────────────────────────────────

async function cgFetch(path: string): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  return res;
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Search CoinGecko for coins matching the given query string.
 * Supports partial/fuzzy matching (e.g. "BT" returns Bitcoin).
 * Returns up to 20 results ranked by market cap.
 */
export async function searchCoins(query: string): Promise<CoinSearchResult[]> {
  try {
    const res = await cgFetch(`/search?query=${encodeURIComponent(query)}`);
    if (!res.ok) {
      console.warn(`[coingecko/search] HTTP ${res.status} for query "${query}"`);
      return [];
    }
    const data = await res.json() as any;
    const coins: any[] = data?.coins ?? [];

    return coins.slice(0, 20).map((c) => ({
      id: c.id as string,
      symbol: (c.symbol as string).toUpperCase(),
      name: c.name as string,
      marketCapRank: c.market_cap_rank ?? null,
    }));
  } catch (err) {
    console.warn(`[coingecko/search] exception for query "${query}":`, err);
    return [];
  }
}

// ── Batch price fetch ─────────────────────────────────────────────────────────

/**
 * Fetch the current USD price for one or more coins by their CoinGecko IDs.
 * Returns a map of coinId → CoinPrice. Missing/failed coins are omitted.
 *
 * Uses the /simple/price endpoint which accepts comma-separated IDs —
 * one API call regardless of how many coins are requested.
 */
export async function getPrices(coinIds: string[]): Promise<Map<string, CoinPrice>> {
  const result = new Map<string, CoinPrice>();
  if (coinIds.length === 0) return result;

  try {
    const ids = coinIds.join(",");
    const res = await cgFetch(
      `/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_last_updated_at=true`,
    );
    if (!res.ok) {
      console.warn(`[coingecko/prices] HTTP ${res.status}`);
      return result;
    }
    const data = await res.json() as any;
    for (const coinId of coinIds) {
      const entry = data?.[coinId];
      if (entry?.usd != null) {
        result.set(coinId, {
          price: entry.usd as number,
          updatedAt: entry.last_updated_at
            ? new Date(entry.last_updated_at * 1000)
            : new Date(),
        });
      }
    }
  } catch (err) {
    console.warn(`[coingecko/prices] exception:`, err);
  }

  return result;
}

// ── Single live price ─────────────────────────────────────────────────────────

/**
 * Fetch the current USD price for a single coin by its CoinGecko ID.
 * Returns null if the coin is not found or the request fails.
 */
export async function getPrice(coinId: string): Promise<CoinPrice | null> {
  const map = await getPrices([coinId]);
  return map.get(coinId) ?? null;
}

// ── Daily price history ───────────────────────────────────────────────────────

/**
 * Fetch daily closing prices for a coin over the given number of past days.
 * Uses the /market_chart endpoint with daily interval.
 * Returns an array of (UTC-midnight date, close price) pairs sorted oldest-first.
 *
 * CoinGecko returns hourly data for ≤90 days and daily data for >90 days.
 * We always request daily by using `interval=daily` (available for any range
 * on the free tier when days > 1).
 */
export async function getMarketChart(
  coinId: string,
  days: number,
): Promise<Array<{ date: Date; closePrice: number }>> {
  try {
    const res = await cgFetch(
      `/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
    );
    if (!res.ok) {
      console.warn(`[coingecko/chart] HTTP ${res.status} for ${coinId}`);
      return [];
    }
    const data = await res.json() as any;
    const prices: [number, number][] = data?.prices ?? [];

    return prices.map(([ts, price]) => {
      // Normalize to UTC midnight for consistent DATE storage
      const raw = new Date(ts);
      const date = new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
      return { date, closePrice: price };
    });
  } catch (err) {
    console.warn(`[coingecko/chart] exception for ${coinId}:`, err);
    return [];
  }
}
