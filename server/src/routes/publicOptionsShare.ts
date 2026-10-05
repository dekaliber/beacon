import { Router, type Request, type Response, type NextFunction } from "express";
import { fetchUpcomingEarnings } from "../services/earnings.js";
import {
  resolveShareToken,
  buildSharedOptionsData,
  shareEarningsSymbols,
  benchmarkAnchorDate,
} from "../services/optionsShare.js";
import { fetchBenchmarks } from "./options.js";

// Public, read-only feed behind an Options Trading share link. Mounted ahead of
// the Clerk gate in index.ts; the unguessable token in the path is the only
// credential. GET only — there is deliberately no way to mutate anything from
// here, and no handler takes a free-form symbol, so the link can't be used to
// proxy arbitrary market-data lookups.

export const publicOptionsShareRoutes = Router();

// ── Rate limit ────────────────────────────────────────────────────────────────
// Fixed one-minute window per client IP. Behind a proxy every visitor may share
// one address, which only makes this stricter.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const hits = new Map<string, { windowStart: number; count: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = req.ip ?? "unknown";
  const entry = hits.get(key);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    if (hits.size > 5000) hits.clear(); // bound memory under a spray of addresses
    hits.set(key, { windowStart: now, count: 1 });
    return next();
  }
  if (++entry.count > MAX_PER_WINDOW) {
    res.set("Retry-After", String(Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000)));
    return res.status(429).json({ error: "rate_limited" });
  }
  next();
}

publicOptionsShareRoutes.use(rateLimit);
publicOptionsShareRoutes.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex, nofollow");
  next();
});

// Unknown and revoked tokens are indistinguishable: both are a bare 404.
async function ownerOf(req: Request, res: Response): Promise<string | null> {
  const token = req.params.token;
  const userId = typeof token === "string" ? await resolveShareToken(token) : null;
  if (!userId) res.status(404).json({ error: "not_found" });
  return userId;
}

publicOptionsShareRoutes.get("/:token", async (req, res) => {
  try {
    const userId = await ownerOf(req, res);
    if (!userId) return;
    res.json(await buildSharedOptionsData(userId));
  } catch (e) {
    console.error("options share feed failed:", e);
    res.status(500).json({ error: "server_error" });
  }
});

// Upcoming earnings for the shared account's open and held tickers. Served from the
// earnings service's own 6-hour cache, so repeat views cost nothing upstream.
publicOptionsShareRoutes.get("/:token/earnings", async (req, res) => {
  const today = req.query.today;
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return res.status(400).json({ error: "Missing or invalid today (expected YYYY-MM-DD)" });
  }
  try {
    const userId = await ownerOf(req, res);
    if (!userId) return;
    const symbols = await shareEarningsSymbols(userId);
    if (symbols.length === 0) return res.json({});
    const { earnings } = await fetchUpcomingEarnings(symbols, today);
    res.json(Object.fromEntries(earnings));
  } catch (e) {
    console.error("options share earnings failed:", e);
    res.status(502).json({ error: "upstream_failed" });
  }
});

// Benchmark returns since the account's start. `start` is computed client-side
// in the viewer's timezone (week-start of the anchor), so it's accepted only
// within a week of the anchor the server derives itself; results are cached so
// visitors can't drive repeated Yahoo calls.
const BENCHMARK_TTL_MS = 15 * 60_000;
const benchmarkCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof fetchBenchmarks>> }>();

const dayMs = (ymd: string) => Date.parse(ymd + "T00:00:00Z");

publicOptionsShareRoutes.get("/:token/benchmark", async (req, res) => {
  const start = req.query.start;
  if (typeof start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(dayMs(start))) {
    return res.status(400).json({ error: "Missing or invalid start (expected YYYY-MM-DD)" });
  }
  try {
    const userId = await ownerOf(req, res);
    if (!userId) return;
    const anchor = await benchmarkAnchorDate(userId);
    if (!anchor || Math.abs(dayMs(start) - dayMs(anchor)) > 8 * 86_400_000) {
      return res.json({ benchmarks: [] });
    }
    const hit = benchmarkCache.get(start);
    if (hit && Date.now() - hit.at < BENCHMARK_TTL_MS) return res.json({ benchmarks: hit.value });
    const value = await fetchBenchmarks(start);
    if (benchmarkCache.size > 200) benchmarkCache.clear();
    benchmarkCache.set(start, { at: Date.now(), value });
    res.json({ benchmarks: value });
  } catch (e) {
    console.error("options share benchmark failed:", e);
    res.status(502).json({ error: "upstream_failed" });
  }
});
