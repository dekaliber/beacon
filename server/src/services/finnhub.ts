// Finnhub earnings calendar — the primary earnings-date provider.
//
// Unlike Yahoo's scraped quote endpoint this is a real API contract: an API key,
// a documented 60 req/min free tier, and an `hour` field that states the
// reporting slot directly instead of leaving it to be inferred from a timestamp.

import type { ProviderResult, RawEarnings, EarningsTiming } from "./earnings.js";

const BASE = "https://finnhub.io/api/v1";

// How far ahead to ask for. Comfortably past a quarter, so the next report is
// always in range even right after one lands.
const WINDOW_DAYS = 120;

// The free tier allows 60 req/min. We issue one request per symbol, so cap
// concurrency well under that — a screener run can ask for a few dozen tickers
// at once, and the 6h cache means this happens rarely.
const CONCURRENCY = 5;

export function finnhubConfigured(): boolean {
  return !!process.env.FINNHUB_API_KEY;
}

function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Finnhub reports "bmo" / "amc" / "dmh", but leaves `hour` empty for a
// meaningful share of symbols. Unknown must NOT collapse to AMC: after-close is
// the one value that suppresses a same-day warning (an after-close call on
// expiration day lands after settlement), so guessing it silently hides real
// risk. UNK warns and says only the date.
function toTiming(hour: unknown): EarningsTiming {
  switch (String(hour ?? "").toLowerCase()) {
    case "bmo": return "BMO";
    case "amc": return "AMC";
    case "dmh": return "DMH";
    default: return "UNK";
  }
}

async function fetchOne(
  symbol: string,
  from: string,
  to: string,
  token: string
): Promise<{ ok: true; value: RawEarnings } | { ok: false; reason: string }> {
  try {
    const url =
      `${BASE}/calendar/earnings?from=${from}&to=${to}` +
      `&symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      // 401/403 = bad key; 429 = rate limited.
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as any;
    const rows: any[] = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
    // The window can span more than one report; take the earliest upcoming.
    const dated = rows
      .filter((r) => typeof r?.date === "string" && r.date >= from)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const next = dated[0];
    if (!next) return { ok: true, value: { date: null, timing: "AMC", isEstimate: false } };
    return {
      ok: true,
      value: {
        date: next.date as string,
        timing: toTiming(next.hour),
        // Finnhub's calendar carries no confirmed-vs-projected flag.
        isEstimate: false,
      },
    };
  } catch (err) {
    return { ok: false, reason: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function fetchFinnhubEarningsRaw(symbols: string[]): Promise<ProviderResult> {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) return { ok: false, reason: "FINNHUB_API_KEY is not set" };

  const from = new Date().toISOString().slice(0, 10);
  const to = addDays(from, WINDOW_DAYS);

  const entries = new Map<string, RawEarnings>();
  let failure: string | null = null;

  // Simple fixed-size worker pool over the symbol list.
  const queue = [...symbols];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const sym = queue.shift();
      if (sym === undefined) return;
      const r = await fetchOne(sym, from, to, token);
      if (r.ok) entries.set(sym, r.value);
      else if (failure == null) failure = r.reason;
    }
  });
  await Promise.all(workers);

  // Treat the batch as failed only when nothing came back — a single bad symbol
  // shouldn't discard the rest, but a bad key or a rate limit should surface.
  if (entries.size === 0 && failure != null) {
    console.warn(`[finnhub] earnings lookup failed for ${symbols.length} symbol(s): ${failure}`);
    return { ok: false, reason: failure };
  }
  if (failure != null) {
    console.warn(`[finnhub] partial earnings failure (${entries.size}/${symbols.length} ok): ${failure}`);
  }
  return { ok: true, entries };
}
