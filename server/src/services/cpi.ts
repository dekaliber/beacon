// Monthly CPI for the performance chart's inflation line.
//
// CPI-U, all items, not seasonally adjusted (BLS series CUUR0000SA0): the
// headline index used for inflation adjustments. Read from BLS's public API,
// which needs no key (v1 allows 25 requests a day per IP), with FRED's CSV of
// the same series (CPIAUCNS) as the fallback. A month's figure is published
// around the middle of the next month, so the newest month or two are missing.
// The series changes once a month, so it's cached in memory for 12 hours.

export const CPI_SERIES = { id: "CUUR0000SA0", name: "CPI-U" } as const;

type Month = string; // YYYY-MM
type Day = string; // YYYY-MM-DD

const TTL_MS = 12 * 60 * 60 * 1000;
let cache: { fromYear: number; fetchedAt: number; values: Map<Month, number> } | null = null;
let inflight: Promise<Map<Month, number>> | null = null;

async function fromBls(fromYear: number, toYear: number): Promise<Map<Month, number>> {
  const out = new Map<Month, number>();
  // v1 serves at most 10 years per request; the history starts in 2025, so one is plenty for years to come.
  const url = `https://api.bls.gov/publicAPI/v1/timeseries/data/${CPI_SERIES.id}?startyear=${fromYear}&endyear=${toYear}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`BLS HTTP ${res.status}`);
  const data = (await res.json()) as any;
  if (data?.status !== "REQUEST_SUCCEEDED") throw new Error(`BLS ${data?.status}: ${(data?.message ?? []).join("; ")}`);
  for (const row of data?.Results?.series?.[0]?.data ?? []) {
    // M13 is the annual average; "-" marks a month BLS didn't publish
    const m = /^M(0[1-9]|1[0-2])$/.exec(row.period ?? "");
    const v = Number(row.value);
    if (m && Number.isFinite(v) && v > 0) out.set(`${row.year}-${m[1]}`, v);
  }
  return out;
}

async function fromFred(fromYear: number): Promise<Map<Month, number>> {
  const out = new Map<Month, number>();
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCNS&cosd=${fromYear}-01-01`);
  if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
  for (const line of (await res.text()).split("\n").slice(1)) {
    const [date, value] = line.trim().split(",");
    const v = Number(value);
    if (/^\d{4}-\d{2}-01$/.test(date ?? "") && Number.isFinite(v) && v > 0) out.set(date.slice(0, 7), v);
  }
  return out;
}

async function monthlyCpi(fromYear: number): Promise<Map<Month, number>> {
  if (cache && cache.fromYear <= fromYear && Date.now() - cache.fetchedAt < TTL_MS) return cache.values;
  if (inflight) return inflight;
  inflight = (async () => {
    const toYear = new Date().getUTCFullYear();
    let values = new Map<Month, number>();
    try {
      values = await fromBls(fromYear, toYear);
    } catch (err) {
      console.warn("[cpi] BLS failed, trying FRED —", err);
    }
    if (values.size === 0) {
      try {
        values = await fromFred(fromYear);
      } catch (err) {
        console.warn("[cpi] FRED failed —", err);
      }
    }
    // An empty answer keeps whatever was cached before.
    if (values.size) cache = { fromYear, fetchedAt: Date.now(), values };
    return values.size ? values : cache?.values ?? new Map();
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** CPI for the month each given day falls in (so a month-end close carries its
 *  own month's index), or null where that month isn't published yet. Returns
 *  null altogether when the series can't be fetched. */
export async function cpiAt(days: Day[]): Promise<{ series: string; name: string; values: Record<Day, number | null> } | null> {
  if (days.length === 0) return null;
  const fromYear = Number([...days].sort()[0].slice(0, 4));
  const cpi = await monthlyCpi(fromYear);
  if (cpi.size === 0) return null;
  const values: Record<Day, number | null> = {};
  for (const d of days) values[d] = cpi.get(d.slice(0, 7)) ?? null;
  return { series: CPI_SERIES.id, name: CPI_SERIES.name, values };
}
