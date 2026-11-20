// Benchmark index closes for the portfolio performance chart.
//
// The S&P 500 Total Return index (dividends reinvested) from Yahoo's chart
// endpoint, which, unlike the quote endpoint, needs no crumb and works from a
// hosted deployment. One daily series serves every user and both cadences, so
// it is cached in memory and refetched at most every half hour.

import { fetchYahooHistory } from "./yahoo.js";

export const BENCHMARK = { symbol: "^SP500TR", name: "S&P 500 TR" } as const;

type Day = string; // YYYY-MM-DD

const TTL_MS = 30 * 60 * 1000;
let cache: { from: Day; fetchedAt: number; closes: Array<{ day: Day; close: number }> } | null = null;
let inflight: Promise<Array<{ day: Day; close: number }>> | null = null;

async function dailyCloses(from: Day): Promise<Array<{ day: Day; close: number }>> {
  if (cache && cache.from <= from && Date.now() - cache.fetchedAt < TTL_MS) return cache.closes;
  if (inflight) return inflight;
  inflight = (async () => {
    // Yahoo's daily bars are stamped at the 9:30 ET open, so the UTC date is the session's ET date.
    const points = await fetchYahooHistory(BENCHMARK.symbol, new Date(`${from}T00:00:00Z`), new Date());
    const closes = points.map((p) => ({ day: p.date.toISOString().slice(0, 10), close: p.closePrice }));
    // An empty answer (throttled, outage) keeps whatever was cached before.
    if (closes.length) cache = { from, fetchedAt: Date.now(), closes };
    return closes.length ? closes : cache?.closes ?? [];
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** The benchmark's close on or before each given day (the last session that had
 *  closed by then), or null where the series doesn't reach back that far.
 *  Returns null altogether when the series can't be fetched. */
export async function benchmarkClosesAt(days: Day[]): Promise<
  { symbol: string; name: string; closes: Record<Day, number | null> } | null
> {
  if (days.length === 0) return null;
  const sorted = [...days].sort();
  // A week of slack so the first day can fall back across a holiday weekend.
  const from = new Date(Date.parse(`${sorted[0]}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10);
  const series = await dailyCloses(from);
  if (series.length === 0) return null;

  const closes: Record<Day, number | null> = {};
  let i = 0;
  let last: number | null = null;
  for (const day of sorted) {
    while (i < series.length && series[i].day <= day) last = series[i++].close;
    closes[day] = last;
  }
  return { symbol: BENCHMARK.symbol, name: BENCHMARK.name, closes };
}
