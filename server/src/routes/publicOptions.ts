import { Router } from "express";
import { createHash, timingSafeEqual } from "crypto";
import { fetchFilteredChain, fetchUnderlyingPrices, todayET } from "../services/tradier.js";

// Read-only options-chain feed for external callers that can only issue a plain
// GET (no headers/cookies), so auth is a shared key in the query string
// (OPTIONS_FEED_KEY). Mounted ahead of the Clerk gate in index.ts. Unknown query
// params (e.g. a cache-busting &t=) are ignored.

export const publicOptionsRoutes = Router();

const MAX_ROWS = 100;
const MAX_EXPIRATIONS = 6;

// Hash both sides so timingSafeEqual gets equal-length buffers regardless of input.
function keyMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function csvCell(v: string | number | null): string {
  return v == null ? "" : String(v);
}

publicOptionsRoutes.get("/options-chain", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const q = req.query as Record<string, string | undefined>;
  const expectedKey = process.env.OPTIONS_FEED_KEY;
  if (!expectedKey) return res.status(503).json({ error: "Feed not configured" });
  if (typeof q.key !== "string" || !keyMatches(q.key, expectedKey)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const symbol = (q.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    return res.status(400).json({ error: "Invalid or missing symbol" });
  }

  const expiration = q.expiration?.trim() || undefined;
  if (expiration && !/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
    return res.status(400).json({ error: "expiration must be YYYY-MM-DD" });
  }
  const num = (v: string | undefined) => {
    if (v == null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  const minDte = num(q.minDte);
  const maxDte = num(q.maxDte);
  const minDelta = num(q.minDelta);
  const maxDelta = num(q.maxDelta);
  if ([minDte, maxDte, minDelta, maxDelta].some((n) => Number.isNaN(n))) {
    return res.status(400).json({ error: "minDte, maxDte, minDelta, maxDelta must be numbers" });
  }
  if (!expiration && maxDte == null) {
    return res.status(400).json({ error: "Provide expiration or maxDte" });
  }

  const typeParam = (q.type ?? "both").toLowerCase();
  const side = typeParam === "put" ? "PUT" : typeParam === "call" ? "CALL" : typeParam === "both" ? "BOTH" : null;
  if (!side) return res.status(400).json({ error: "type must be put, call, or both" });

  const format = (q.format ?? "csv").toLowerCase() === "json" ? "json" : "csv";

  try {
    const [underlyingMap, rows] = await Promise.all([
      fetchUnderlyingPrices([symbol]),
      fetchFilteredChain({
        symbol,
        expiration,
        minDte,
        maxDte,
        side,
        minAbsDelta: minDelta,
        maxAbsDelta: maxDelta,
        maxExpirations: MAX_EXPIRATIONS,
      }),
    ]);
    const underlying = underlyingMap.get(symbol) ?? null;
    const pulledAt = new Date().toISOString();
    const shown = rows.slice(0, MAX_ROWS);
    const truncated = rows.length > MAX_ROWS;

    if (format === "json") {
      return res.json({
        symbol,
        underlying,
        today: todayET(),
        pulledAt,
        count: shown.length,
        total: rows.length,
        truncated,
        rows: shown.map((r) => ({
          expiration: r.expiration,
          dte: r.dte,
          type: r.optionType.toLowerCase(),
          strike: r.strike,
          bid: r.bid,
          ask: r.ask,
          mid: r.mid,
          volume: r.volume,
          oi: r.openInterest,
          delta: r.delta,
          midIv: r.midIv,
          greeksUpdated: r.greeksUpdatedAt,
        })),
      });
    }

    const lines = ["symbol,underlying,expiration,dte,type,strike,bid,ask,mid,volume,oi,delta,mid_iv,greeks_updated_utc,pulled_utc"];
    for (const r of shown) {
      lines.push([
        symbol, underlying, r.expiration, r.dte, r.optionType.toLowerCase(), r.strike,
        r.bid, r.ask, r.mid, r.volume, r.openInterest, r.delta, r.midIv, r.greeksUpdatedAt, pulledAt,
      ].map(csvCell).join(","));
    }
    if (truncated) lines.push(`#truncated,${shown.length} of ${rows.length} rows`);
    res.type("text/csv").send(lines.join("\n") + "\n");
  } catch (e) {
    console.error("public options-chain failed:", e);
    res.status(502).json({ error: "Upstream quote fetch failed" });
  }
});
