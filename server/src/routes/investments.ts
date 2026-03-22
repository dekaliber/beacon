import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client.js";

export const investmentRoutes = Router();

// ── Helper: fetch display name + type from Yahoo Finance ────────────────────

const QUOTE_TYPE_MAP: Record<string, string> = {
  EQUITY: "Equity",
  ETF: "ETF",
  MUTUALFUND: "Mutual Fund",
};

async function fetchYahooMeta(ticker: string): Promise<{ name: string; type: string | null }> {
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

// ── Helper: fetch price from Yahoo Finance ──────────────────────────────────

async function fetchYahooPrice(ticker: string): Promise<{ price: number; priceDate: Date } | null> {
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
    const closes: number[] = result?.indicators?.quote?.[0]?.close ?? [];
    const timestamps: number[] = result?.timestamp ?? [];
    // Find the last non-null close
    let price: number | null = null;
    let priceDate: Date | null = null;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) {
        price = closes[i];
        priceDate = new Date(timestamps[i] * 1000);
        break;
      }
    }
    if (price == null || priceDate == null) return null;
    return { price, priceDate };
  } catch {
    return null;
  }
}

// ── Helper: compute calculated fields for a holding ────────────────────────
// Lots with a null acquiredDate are treated as managed (robo-advisor) lots:
// quantity and cost are still accumulated, but they are excluded from the
// short/long-term unrealized gain split (since holding period is unknown).

function computeHoldingFields(
  lots: { quantity: any; costPerShare: any; acquiredDate: Date | null }[],
  currentPrice: number | null
) {
  const now = new Date();
  const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  let totalQuantity = 0;
  let totalCost = 0;
  let shortTermGain = 0;
  let longTermGain = 0;

  for (const lot of lots) {
    const qty = parseFloat(lot.quantity.toString());
    const cps = parseFloat(lot.costPerShare.toString());
    totalQuantity += qty;
    totalCost += qty * cps;

    if (currentPrice != null && lot.acquiredDate != null) {
      const gain = (currentPrice - cps) * qty;
      if (lot.acquiredDate > oneYearAgo) {
        shortTermGain += gain;
      } else {
        longTermGain += gain;
      }
    }
  }

  const marketValue = currentPrice != null ? totalQuantity * currentPrice : null;
  const totalGain = marketValue != null ? marketValue - totalCost : null;
  const totalGainPct = totalCost > 0 && totalGain != null ? (totalGain / totalCost) * 100 : null;

  // A holding is "managed" when all of its lots have no acquired date
  const isManaged = lots.length > 0 && lots.every((l) => l.acquiredDate == null);

  return { totalQuantity, totalCost, marketValue, totalGain, totalGainPct, shortTermGain, longTermGain, isManaged };
}

// ── GET /api/investments/accounts ──────────────────────────────────────────
// Returns INVESTMENT, CHECKING, SAVINGS accounts with portfolio summaries

investmentRoutes.get("/accounts", async (_req, res) => {
  try {
    const accounts = await prisma.account.findMany({
      where: {
        isActive: true,
        type: { in: ["INVESTMENT", "CHECKING", "SAVINGS"] },
      },
      include: {
        holdings: {
          include: { lots: true },
        },
        manualInvestments: true,
      },
      orderBy: { name: "asc" },
    });

    // Gather unique tickers to fetch prices
    const allTickers = [...new Set(
      accounts.flatMap((a) => a.holdings.map((h) => h.ticker))
    )];

    // Load cached prices
    const cachedPrices = await prisma.tickerPrice.findMany({
      where: { ticker: { in: allTickers } },
    });
    const priceMap = new Map(cachedPrices.map((p) => [p.ticker, p]));

    const result = accounts.map((account) => {
      let totalMarketValue = 0;
      let totalCost = 0;
      let totalGain = 0;

      const holdingsSummary = account.holdings.map((holding) => {
        const priceRecord = priceMap.get(holding.ticker);
        const currentPrice = priceRecord ? parseFloat(priceRecord.price.toString()) : null;
        const fields = computeHoldingFields(holding.lots, currentPrice);

        if (fields.marketValue != null) totalMarketValue += fields.marketValue;
        totalCost += fields.totalCost;
        if (fields.totalGain != null) totalGain += fields.totalGain;

        return {
          id: holding.id,
          ticker: holding.ticker,
          name: holding.name,
          assetClass: holding.assetClass ?? null,
          currentPrice,
          priceDate: priceRecord?.priceDate ?? null,
          priceUpdatedAt: priceRecord?.updatedAt ?? null,
          lotCount: holding.lots.length,
          ...fields,
        };
      });

      // Add manual investment totals
      for (const m of account.manualInvestments) {
        const mv = parseFloat(m.marketValue.toString());
        const tc = m.totalCost != null ? parseFloat(m.totalCost.toString()) : 0;
        totalMarketValue += mv;
        totalCost += tc;
        totalGain += mv - tc;
      }

      // For banking accounts, use the stored balance as market value
      if (account.type === "CHECKING" || account.type === "SAVINGS") {
        totalMarketValue = parseFloat(account.balance.toString());
      }

      return {
        id: account.id,
        name: account.name,
        type: account.type,
        balance: account.balance,
        color: account.color,
        isJoint: account.isJoint,
        holdings: holdingsSummary,
        manualCount: account.manualInvestments.length,
        totalMarketValue,
        totalCost,
        totalGain,
        totalGainPct: totalCost > 0 ? (totalGain / totalCost) * 100 : 0,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch investment accounts" } });
  }
});

// ── GET /api/investments/holdings/:accountId ───────────────────────────────

investmentRoutes.get("/holdings/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params;

    const account = await prisma.account.findFirst({
      where: { id: accountId, isActive: true },
    });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    const holdings = await prisma.investmentHolding.findMany({
      where: { accountId },
      include: { lots: { orderBy: { acquiredDate: "asc" } } },
      orderBy: { ticker: "asc" },
    });

    const tickers = holdings.map((h) => h.ticker);
    const cachedPrices = await prisma.tickerPrice.findMany({
      where: { ticker: { in: tickers } },
    });
    const priceMap = new Map(cachedPrices.map((p) => [p.ticker, p]));

    const result = holdings.map((holding) => {
      const priceRecord = priceMap.get(holding.ticker);
      const currentPrice = priceRecord ? parseFloat(priceRecord.price.toString()) : null;
      const fields = computeHoldingFields(holding.lots, currentPrice);

      return {
        id: holding.id,
        accountId: holding.accountId,
        ticker: holding.ticker,
        name: holding.name,
        type: holding.type ?? null,
        assetClass: holding.assetClass ?? null,
        currentPrice,
        priceDate: priceRecord?.priceDate ?? null,
        priceUpdatedAt: priceRecord?.updatedAt ?? null,
        lots: holding.lots.map((lot) => ({
          id: lot.id,
          holdingId: lot.holdingId,
          quantity: lot.quantity.toString(),
          costPerShare: lot.costPerShare.toString(),
          acquiredDate: lot.acquiredDate ? lot.acquiredDate.toISOString() : null,
        })),
        ...fields,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch holdings" } });
  }
});

// ── POST /api/investments/holdings ────────────────────────────────────────

const createHoldingSchema = z.object({
  accountId: z.string(),
  ticker: z.string().min(1).max(20).transform((s) => s.toUpperCase().trim()),
  name: z.string().min(1).max(200),
  type: z.string().max(50).nullable().optional(),
  assetClass: z.string().max(100).nullable().optional(),
});

investmentRoutes.post("/holdings", async (req, res) => {
  try {
    const body = createHoldingSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: body.accountId, isActive: true, type: "INVESTMENT" },
    });
    if (!account) return res.status(404).json({ error: { message: "Investment account not found" } });

    const holding = await prisma.investmentHolding.create({
      data: body,
      include: { lots: true },
    });

    res.status(201).json(holding);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    const e = err as any;
    if (e?.code === "P2002") return res.status(409).json({ error: { message: "This ticker already exists in this account" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to create holding" } });
  }
});

// ── PATCH /api/investments/holdings/:id ───────────────────────────────────
// Update mutable holding fields: assetClass (and optionally name).

const patchHoldingSchema = z.object({
  assetClass: z.string().max(100).nullable().optional(),
  name: z.string().min(1).max(200).optional(),
});

investmentRoutes.patch("/holdings/:id", async (req, res) => {
  try {
    const body = patchHoldingSchema.parse(req.body);
    const holding = await prisma.investmentHolding.update({
      where: { id: req.params.id },
      data: body,
      include: { lots: true },
    });
    res.json({ ...holding, assetClass: holding.assetClass ?? null });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    const e = err as any;
    if (e?.code === "P2025") return res.status(404).json({ error: { message: "Holding not found" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update holding" } });
  }
});

// ── DELETE /api/investments/holdings/:id ──────────────────────────────────

investmentRoutes.delete("/holdings/:id", async (req, res) => {
  try {
    await prisma.investmentHolding.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete holding" } });
  }
});

// ── POST /api/investments/lots ────────────────────────────────────────────

const createLotSchema = z.object({
  holdingId: z.string(),
  quantity: z.number().positive(),
  costPerShare: z.number().nonnegative(),
  // Null for managed holdings where the acquisition date is unavailable
  acquiredDate: z.string().nullable().optional().transform((s) => s != null ? new Date(s) : null),
});

investmentRoutes.post("/lots", async (req, res) => {
  try {
    const body = createLotSchema.parse(req.body);
    const lot = await prisma.investmentLot.create({ data: { ...body, acquiredDate: body.acquiredDate ?? null } });
    res.status(201).json({
      ...lot,
      quantity: lot.quantity.toString(),
      costPerShare: lot.costPerShare.toString(),
      acquiredDate: lot.acquiredDate ? lot.acquiredDate.toISOString() : null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to create lot" } });
  }
});

// ── PUT /api/investments/lots/:id ─────────────────────────────────────────

const updateLotSchema = z.object({
  quantity: z.number().positive().optional(),
  costPerShare: z.number().nonnegative().optional(),
  acquiredDate: z.string().nullable().optional().transform((s) => s != null ? new Date(s) : null),
});

investmentRoutes.put("/lots/:id", async (req, res) => {
  try {
    const body = updateLotSchema.parse(req.body);
    const lot = await prisma.investmentLot.update({
      where: { id: req.params.id },
      data: body,
    });
    res.json({
      ...lot,
      quantity: lot.quantity.toString(),
      costPerShare: lot.costPerShare.toString(),
      acquiredDate: lot.acquiredDate ? lot.acquiredDate.toISOString() : null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update lot" } });
  }
});

// ── DELETE /api/investments/lots/:id ─────────────────────────────────────

investmentRoutes.delete("/lots/:id", async (req, res) => {
  try {
    await prisma.investmentLot.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete lot" } });
  }
});

// ── GET /api/investments/search?q= ────────────────────────────────────────
// Proxy Yahoo Finance ticker search

investmentRoutes.get("/search", async (req, res) => {
  try {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 1) return res.json([]);

    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
    const yahooRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    });

    if (!yahooRes.ok) return res.json([]);

    const data = await yahooRes.json() as any;
    const quotes = data?.quotes ?? [];

    const ALLOWED_TYPES = new Set(["EQUITY", "ETF", "MUTUALFUND"]);

    const results = quotes
      .filter((q: any) => ALLOWED_TYPES.has(q.quoteType))
      .map((q: any) => ({
        ticker: q.symbol as string,
        name: (q.longname || q.shortname || q.symbol) as string,
        type: q.quoteType === "MUTUALFUND" ? "Mutual Fund" : q.quoteType === "ETF" ? "ETF" : "Equity",
        exchange: (q.exchDisp || q.exchange || "") as string,
      }));

    res.json(results);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ── POST /api/investments/holdings/backfill-meta ──────────────────────────
// One-time: populate name/type for holdings where type is null.
// Deduplicates API calls across all accounts sharing the same ticker.

investmentRoutes.post("/holdings/backfill-meta", async (_req, res) => {
  try {
    const holdings = await prisma.investmentHolding.findMany({
      where: { type: null },
      select: { id: true, ticker: true, name: true },
    });

    if (holdings.length === 0) return res.json({ updated: 0, details: [] });

    // Deduplicate: one API call per unique ticker
    const uniqueTickers = [...new Set(holdings.map((h) => h.ticker))];
    const metaByTicker = new Map<string, { name: string; type: string | null }>();
    for (const ticker of uniqueTickers) {
      metaByTicker.set(ticker, await fetchYahooMeta(ticker));
    }

    let updated = 0;
    const details: Array<{ ticker: string; name: string; type: string | null }> = [];

    for (const holding of holdings) {
      const meta = metaByTicker.get(holding.ticker)!;
      const updates: Record<string, string | null> = {};
      if (holding.name === holding.ticker && meta.name !== holding.ticker) updates.name = meta.name;
      if (meta.type !== null) updates.type = meta.type;
      if (Object.keys(updates).length > 0) {
        await prisma.investmentHolding.update({ where: { id: holding.id }, data: updates });
        updated++;
        details.push({ ticker: holding.ticker, name: meta.name, type: meta.type });
      }
    }

    res.json({ updated, details });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to backfill holding metadata" } });
  }
});

// ── POST /api/investments/prices/refresh ──────────────────────────────────
// Fetch latest EOD prices for all tracked tickers and upsert TickerPrice records

investmentRoutes.post("/prices/refresh", async (_req, res) => {
  try {
    const holdings = await prisma.investmentHolding.findMany({
      select: { ticker: true },
    });

    const tickers = [...new Set(holdings.map((h) => h.ticker))];
    if (tickers.length === 0) return res.json({ updated: 0, tickers: [] });

    let updated = 0;
    const results: string[] = [];

    // Fetch prices with a small delay to be polite to Yahoo's servers
    for (const ticker of tickers) {
      const priceData = await fetchYahooPrice(ticker);
      if (priceData) {
        await prisma.tickerPrice.upsert({
          where: { ticker },
          create: {
            ticker,
            price: priceData.price,
            priceDate: priceData.priceDate,
            updatedAt: new Date(),
          },
          update: {
            price: priceData.price,
            priceDate: priceData.priceDate,
            updatedAt: new Date(),
          },
        });
        updated++;
        results.push(ticker);
      }
      // Small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    res.json({ updated, tickers: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to refresh prices" } });
  }
});

// ── POST /api/investments/import ──────────────────────────────────────────
// Bulk-import lots from CSV. Groups by symbol, creates holdings as needed.

const importInvestmentsSchema = z.object({
  accountId: z.string(),
  rows: z.array(
    z.object({
      symbol: z.string().min(1).max(20).transform((s) => s.toUpperCase().trim()),
      purchaseDate: z.string(),
      price: z.number().nonnegative(),
      quantity: z.number().positive(),
    })
  ),
});

investmentRoutes.post("/import", async (req, res) => {
  try {
    const body = importInvestmentsSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: body.accountId, isActive: true, type: "INVESTMENT" },
    });
    if (!account)
      return res.status(404).json({ error: { message: "Investment account not found" } });

    let imported = 0;
    const errors: Array<{ row: number; message: string }> = [];

    // Group rows by symbol (preserving original index for error reporting)
    const bySymbol = new Map<string, Array<{ row: typeof body.rows[0]; idx: number }>>();
    body.rows.forEach((row, idx) => {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
      bySymbol.get(row.symbol)!.push({ row, idx });
    });

    // Cache symbol → meta to avoid duplicate API calls for the same ticker
    const metaCache = new Map<string, { name: string; type: string | null }>();

    for (const [symbol, entries] of bySymbol) {
      try {
        let holding = await prisma.investmentHolding.findFirst({
          where: { accountId: body.accountId, ticker: symbol },
        });
        if (!holding) {
          // Fetch meta only for new symbols not already in cache
          if (!metaCache.has(symbol)) {
            metaCache.set(symbol, await fetchYahooMeta(symbol));
          }
          const { name, type } = metaCache.get(symbol)!;
          holding = await prisma.investmentHolding.create({
            data: { accountId: body.accountId, ticker: symbol, name, type },
          });
        } else if (holding.name === holding.ticker || holding.type === null) {
          // Holding exists but name/type was never resolved — fix it
          if (!metaCache.has(symbol)) {
            metaCache.set(symbol, await fetchYahooMeta(symbol));
          }
          const { name, type } = metaCache.get(symbol)!;
          const updates: Record<string, string | null> = {};
          if (holding.name === holding.ticker && name !== symbol) updates.name = name;
          if (holding.type === null && type !== null) updates.type = type;
          if (Object.keys(updates).length > 0) {
            holding = await prisma.investmentHolding.update({
              where: { id: holding.id },
              data: updates,
            });
          }
        }

        for (const { row, idx } of entries) {
          try {
            await prisma.investmentLot.create({
              data: {
                holdingId: holding.id,
                quantity: row.quantity,
                costPerShare: row.price,
                acquiredDate: new Date(row.purchaseDate),
              },
            });
            imported++;
          } catch (e) {
            errors.push({
              row: idx + 1,
              message: `Failed to create lot: ${e instanceof Error ? e.message : "Unknown error"}`,
            });
          }
        }
      } catch (e) {
        for (const { idx } of entries) {
          errors.push({
            row: idx + 1,
            message: `Failed to process ${symbol}: ${e instanceof Error ? e.message : "Unknown error"}`,
          });
        }
      }
    }

    res.json({ imported, errors });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to import investments" } });
  }
});

// ── GET /api/investments/prices/status ────────────────────────────────────
// Returns current price cache status for all tracked tickers
// NOTE: must be declared before /prices/:ticker to avoid route conflict

investmentRoutes.get("/prices/status", async (_req, res) => {
  try {
    const prices = await prisma.tickerPrice.findMany({
      orderBy: { ticker: "asc" },
    });
    res.json(prices.map((p) => ({
      ticker: p.ticker,
      price: parseFloat(p.price.toString()),
      priceDate: p.priceDate,
      updatedAt: p.updatedAt,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch price status" } });
  }
});

// ── GET /api/investments/prices/:ticker ───────────────────────────────────
// Returns the current price for a single ticker, fetching live if not cached today.

investmentRoutes.get("/prices/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    // Return cached price if updated within the last hour
    const existing = await prisma.tickerPrice.findUnique({ where: { ticker } });
    if (existing) {
      const ageMs = Date.now() - existing.updatedAt.getTime();
      if (ageMs < 60 * 60 * 1000) {
        return res.json({
          ticker,
          price: parseFloat(existing.price.toString()),
          priceDate: existing.priceDate,
        });
      }
    }

    // Fetch live from Yahoo Finance
    const priceData = await fetchYahooPrice(ticker);
    if (!priceData) {
      return res.status(404).json({ error: { message: "Price not available for " + ticker } });
    }

    const record = await prisma.tickerPrice.upsert({
      where: { ticker },
      create: { ticker, price: priceData.price, priceDate: priceData.priceDate, updatedAt: new Date() },
      update: { price: priceData.price, priceDate: priceData.priceDate, updatedAt: new Date() },
    });

    res.json({
      ticker,
      price: parseFloat(record.price.toString()),
      priceDate: record.priceDate,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch price" } });
  }
});

// ── Manual Investments CRUD ────────────────────────────────────────────────
// Non-public / private securities stored as a single market-value entry
// (no lots, no ticker lookup).

function serializeManual(m: {
  id: string; accountId: string; name: string; assetClass: string | null;
  totalCost: any; marketValue: any; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: m.id,
    accountId: m.accountId,
    name: m.name,
    assetClass: m.assetClass ?? null,
    totalCost: m.totalCost != null ? parseFloat(m.totalCost.toString()) : null,
    marketValue: parseFloat(m.marketValue.toString()),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

const createManualSchema = z.object({
  accountId: z.string(),
  name: z.string().min(1).max(200),
  assetClass: z.string().max(100).nullable().optional(),
  totalCost: z.number().nonnegative().nullable().optional(),
  marketValue: z.number().nonnegative(),
});

const updateManualSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  assetClass: z.string().max(100).nullable().optional(),
  totalCost: z.number().nonnegative().nullable().optional(),
  marketValue: z.number().nonnegative().optional(),
});

// GET /api/investments/manual/:accountId
investmentRoutes.get("/manual/:accountId", async (req, res) => {
  try {
    const entries = await prisma.manualInvestment.findMany({
      where: { accountId: req.params.accountId },
      orderBy: { createdAt: "asc" },
    });
    res.json(entries.map(serializeManual));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch manual investments" } });
  }
});

// POST /api/investments/manual
investmentRoutes.post("/manual", async (req, res) => {
  try {
    const body = createManualSchema.parse(req.body);
    const account = await prisma.account.findFirst({
      where: { id: body.accountId, isActive: true, type: "INVESTMENT" },
    });
    if (!account)
      return res.status(404).json({ error: { message: "Investment account not found" } });
    const entry = await prisma.manualInvestment.create({
      data: {
        accountId: body.accountId,
        name: body.name,
        assetClass: body.assetClass ?? null,
        totalCost: body.totalCost ?? null,
        marketValue: body.marketValue,
      },
    });
    res.status(201).json(serializeManual(entry));
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to create manual investment" } });
  }
});

// PUT /api/investments/manual/:id
investmentRoutes.put("/manual/:id", async (req, res) => {
  try {
    const body = updateManualSchema.parse(req.body);
    const entry = await prisma.manualInvestment.update({
      where: { id: req.params.id },
      data: body,
    });
    res.json(serializeManual(entry));
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    const e = err as any;
    if (e?.code === "P2025")
      return res.status(404).json({ error: { message: "Manual investment not found" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update manual investment" } });
  }
});

// DELETE /api/investments/manual/:id
investmentRoutes.delete("/manual/:id", async (req, res) => {
  try {
    await prisma.manualInvestment.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    const e = err as any;
    if (e?.code === "P2025")
      return res.status(404).json({ error: { message: "Manual investment not found" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete manual investment" } });
  }
});

// ── GET /api/investments/activity/:accountId ───────────────────────────────
// Returns all investment activity events for an account (sales, dividends)

function serializeActivity(a: any) {
  return {
    id: a.id,
    accountId: a.accountId,
    holdingId: a.holdingId,
    ticker: a.ticker,
    type: a.type,
    date: a.date,
    shares: a.shares != null ? parseFloat(a.shares.toString()) : null,
    pricePerShare: a.pricePerShare != null ? parseFloat(a.pricePerShare.toString()) : null,
    amount: parseFloat(a.amount.toString()),
    fees: a.fees != null ? parseFloat(a.fees.toString()) : null,
    costBasis: a.costBasis != null ? parseFloat(a.costBasis.toString()) : null,
    shortTermGain: a.shortTermGain != null ? parseFloat(a.shortTermGain.toString()) : null,
    longTermGain: a.longTermGain != null ? parseFloat(a.longTermGain.toString()) : null,
    notes: a.notes,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

investmentRoutes.get("/activity/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params;
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    const activities = await prisma.investmentActivity.findMany({
      where: { accountId },
      orderBy: { date: "desc" },
    });

    res.json(activities.map(serializeActivity));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch investment activity" } });
  }
});

// ── Shared sell logic ──────────────────────────────────────────────────────

const sellInputSchema = z.object({
  holdingId: z.string(),
  sharesToSell: z.number().positive(),
  pricePerShare: z.number().positive(),
  saleDate: z.string().transform((s) => new Date(s)),
  fees: z.number().nonnegative().default(0),
  costBasisMethod: z.enum(["FIFO", "LIFO", "MIN_TAX", "MAX_GAIN"]),
});

interface LotAllocation {
  lotId: string;
  acquiredDate: Date;
  shares: number;
  costPerShare: number;
  termType: "SHORT" | "LONG";
  proceeds: number;
  costBasis: number;
  gain: number;
}

interface SellCalculation {
  lotBreakdown: LotAllocation[];
  grossProceeds: number;
  fees: number;
  netProceeds: number;
  totalCostBasis: number;
  stShares: number;
  ltShares: number;
  stGain: number;
  ltGain: number;
  totalGain: number;
}

function computeSell(
  lots: { id: string; quantity: any; costPerShare: any; acquiredDate: Date }[],
  sharesToSell: number,
  pricePerShare: number,
  saleDate: Date,
  fees: number,
  costBasisMethod: "FIFO" | "LIFO" | "MIN_TAX" | "MAX_GAIN"
): SellCalculation {
  // Determine the one-year cutoff relative to the sale date (not today)
  const oneYearBeforeSale = new Date(
    saleDate.getFullYear() - 1,
    saleDate.getMonth(),
    saleDate.getDate()
  );

  // Sort lots by chosen method
  const sorted = [...lots].sort((a, b) => {
    const aQty = parseFloat(a.quantity.toString());
    const bQty = parseFloat(b.quantity.toString());
    const aCps = parseFloat(a.costPerShare.toString());
    const bCps = parseFloat(b.costPerShare.toString());
    // For sort, gain per share = pricePerShare - costPerShare (direction depends on method)
    switch (costBasisMethod) {
      case "FIFO": return a.acquiredDate.getTime() - b.acquiredDate.getTime();
      case "LIFO": return b.acquiredDate.getTime() - a.acquiredDate.getTime();
      case "MIN_TAX": return bCps - aCps; // highest cost basis first → smallest gain
      case "MAX_GAIN": return aCps - bCps; // lowest cost basis first → largest gain
    }
  });

  const lotBreakdown: LotAllocation[] = [];
  let sharesRemaining = sharesToSell;
  let stShares = 0;
  let ltShares = 0;
  let stCostBasis = 0;
  let ltCostBasis = 0;

  for (const lot of sorted) {
    if (sharesRemaining <= 0) break;
    const lotQty = parseFloat(lot.quantity.toString());
    const lotCps = parseFloat(lot.costPerShare.toString());
    const sharesFromLot = Math.min(lotQty, sharesRemaining);
    const isLongTerm = lot.acquiredDate <= oneYearBeforeSale;
    const lotProceeds = sharesFromLot * pricePerShare;
    const lotCostBasis = sharesFromLot * lotCps;
    const lotGain = lotProceeds - lotCostBasis;

    lotBreakdown.push({
      lotId: lot.id,
      acquiredDate: lot.acquiredDate,
      shares: sharesFromLot,
      costPerShare: lotCps,
      termType: isLongTerm ? "LONG" : "SHORT",
      proceeds: lotProceeds,
      costBasis: lotCostBasis,
      gain: lotGain,
    });

    if (isLongTerm) {
      ltShares += sharesFromLot;
      ltCostBasis += lotCostBasis;
    } else {
      stShares += sharesFromLot;
      stCostBasis += lotCostBasis;
    }

    sharesRemaining -= sharesFromLot;
  }

  const grossProceeds = sharesToSell * pricePerShare;
  const netProceeds = grossProceeds - fees;
  const totalCostBasis = stCostBasis + ltCostBasis;

  // Allocate fees proportionally by shares, compute net gains per term
  const stFees = sharesToSell > 0 ? fees * (stShares / sharesToSell) : 0;
  const ltFees = fees - stFees;
  const stGain = stShares > 0
    ? (stShares / sharesToSell) * grossProceeds - stCostBasis - stFees
    : 0;
  const ltGain = ltShares > 0
    ? ltShares / sharesToSell * grossProceeds - ltCostBasis - ltFees
    : 0;
  const totalGain = stGain + ltGain;

  return {
    lotBreakdown,
    grossProceeds,
    fees,
    netProceeds,
    totalCostBasis,
    stShares,
    ltShares,
    stGain,
    ltGain,
    totalGain,
  };
}

// ── POST /api/investments/sell/preview ────────────────────────────────────
// Computes the lot breakdown for a proposed sale without writing anything

investmentRoutes.post("/sell/preview", async (req, res) => {
  try {
    const body = sellInputSchema.parse(req.body);

    const holding = await prisma.investmentHolding.findUnique({
      where: { id: body.holdingId },
      include: { lots: true },
    });
    if (!holding) return res.status(404).json({ error: { message: "Holding not found" } });

    const totalQty = holding.lots.reduce(
      (sum, l) => sum + parseFloat(l.quantity.toString()),
      0
    );
    if (body.sharesToSell > totalQty + 0.000001) {
      return res.status(400).json({
        error: { message: `Cannot sell ${body.sharesToSell} shares; only ${totalQty} available` },
      });
    }

    const calc = computeSell(
      holding.lots,
      body.sharesToSell,
      body.pricePerShare,
      body.saleDate,
      body.fees,
      body.costBasisMethod
    );

    res.json({
      lotBreakdown: calc.lotBreakdown.map((l) => ({
        ...l,
        acquiredDate: l.acquiredDate.toISOString(),
      })),
      grossProceeds: Math.round(calc.grossProceeds * 100) / 100,
      fees: Math.round(calc.fees * 100) / 100,
      netProceeds: Math.round(calc.netProceeds * 100) / 100,
      stShares: calc.stShares,
      ltShares: calc.ltShares,
      stGain: Math.round(calc.stGain * 100) / 100,
      ltGain: Math.round(calc.ltGain * 100) / 100,
      totalGain: Math.round(calc.totalGain * 100) / 100,
    });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to compute sell preview" } });
  }
});

// ── POST /api/investments/sell ────────────────────────────────────────────
// Commits a sale: reduces lots, creates InvestmentActivity, creates Income record

const sellCommitSchema = sellInputSchema.extend({
  destinationAccountId: z.string(),
  notes: z.string().optional(),
});

investmentRoutes.post("/sell", async (req, res) => {
  try {
    const body = sellCommitSchema.parse(req.body);

    // Validate holding exists
    const holding = await prisma.investmentHolding.findUnique({
      where: { id: body.holdingId },
      include: { lots: true },
    });
    if (!holding) return res.status(404).json({ error: { message: "Holding not found" } });

    // Validate destination account
    const destAccount = await prisma.account.findUnique({
      where: { id: body.destinationAccountId },
    });
    if (!destAccount)
      return res.status(404).json({ error: { message: "Destination account not found" } });
    if (destAccount.type === "CREDIT_CARD")
      return res.status(400).json({ error: { message: "Destination account cannot be a credit card" } });

    const totalQty = holding.lots.reduce(
      (sum, l) => sum + parseFloat(l.quantity.toString()),
      0
    );
    if (body.sharesToSell > totalQty + 0.000001) {
      return res.status(400).json({
        error: { message: `Cannot sell ${body.sharesToSell} shares; only ${totalQty} available` },
      });
    }

    // Compute lot breakdown (re-computed server-side, never trust client preview)
    const calc = computeSell(
      holding.lots,
      body.sharesToSell,
      body.pricePerShare,
      body.saleDate,
      body.fees,
      body.costBasisMethod
    );

    const grossProceeds = Math.round(calc.grossProceeds * 100) / 100;
    const netProceeds = Math.round(calc.netProceeds * 100) / 100;
    const stGain = Math.round(calc.stGain * 100) / 100;
    const ltGain = Math.round(calc.ltGain * 100) / 100;
    const totalGain = stGain + ltGain; // avoid drift: sum after rounding
    const feesStored = body.fees > 0 ? Math.round(body.fees * 100) / 100 : null;

    // Build lot mutation maps
    const lotSharesMap = new Map<string, number>();
    for (const alloc of calc.lotBreakdown) {
      lotSharesMap.set(alloc.lotId, alloc.shares);
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Mutate lots
      const holdingLots = await tx.investmentLot.findMany({ where: { holdingId: holding.id } });
      for (const lot of holdingLots) {
        const soldShares = lotSharesMap.get(lot.id) ?? 0;
        if (soldShares === 0) continue;
        const remaining = parseFloat(lot.quantity.toString()) - soldShares;
        if (remaining < 0.000001) {
          await tx.investmentLot.delete({ where: { id: lot.id } });
        } else {
          await tx.investmentLot.update({
            where: { id: lot.id },
            data: { quantity: remaining },
          });
        }
      }

      // 2. Check if holding is now empty; delete if so
      const remainingLots = await tx.investmentLot.count({ where: { holdingId: holding.id } });
      const holdingDeleted = remainingLots === 0;
      if (holdingDeleted) {
        await tx.investmentHolding.delete({ where: { id: holding.id } });
      }

      // 3. Create InvestmentActivity (holdingId set to null if holding was deleted)
      const activity = await tx.investmentActivity.create({
        data: {
          accountId: holding.accountId,
          holdingId: holdingDeleted ? null : holding.id,
          ticker: holding.ticker,
          type: "SALE",
          date: body.saleDate,
          shares: body.sharesToSell,
          pricePerShare: body.pricePerShare,
          amount: grossProceeds,
          fees: feesStored,
          costBasis: Math.round(calc.totalCostBasis * 100) / 100,
          shortTermGain: stGain,
          longTermGain: ltGain,
          notes: body.notes ?? null,
          updatedAt: new Date(),
        },
      });

      // 4. Create one Income record (total net proceeds; taxableAmount = total net gain)
      const income = await tx.income.create({
        data: {
          amount: netProceeds,
          subtype: "CAPITAL_GAIN",
          taxableAmount: totalGain,
          source: holding.ticker,
          date: body.saleDate,
          accountId: body.destinationAccountId,
          activityId: activity.id,
          notes: body.notes ?? null,
          updatedAt: new Date(),
        },
        include: {
          account: true,
          category: true,
          tags: { include: { tag: true } },
          transactionGroup: true,
          activity: true,
        },
      });

      return { activity: serializeActivity(activity), income, holdingDeleted };
    });

    // Fetch updated holding (if not deleted)
    let updatedHolding = null;
    if (!result.holdingDeleted) {
      const h = await prisma.investmentHolding.findUnique({
        where: { id: holding.id },
        include: { lots: true },
      });
      if (h) {
        // Fetch current price for gain computation
        const tp = await prisma.tickerPrice.findUnique({ where: { ticker: h.ticker } });
        const price = tp ? parseFloat(tp.price.toString()) : null;
        const computed = computeHoldingFields(h.lots, price);
        updatedHolding = {
          id: h.id,
          accountId: h.accountId,
          ticker: h.ticker,
          name: h.name,
          type: h.type,
          currentPrice: price,
          priceDate: tp?.priceDate ?? null,
          priceUpdatedAt: tp?.updatedAt ?? null,
          lots: h.lots.map((l) => ({
            id: l.id,
            holdingId: l.holdingId,
            quantity: l.quantity.toString(),
            costPerShare: l.costPerShare.toString(),
            acquiredDate: l.acquiredDate ? l.acquiredDate.toISOString() : null,
          })),
          ...computed,
        };
      }
    }

    res.json({
      activity: result.activity,
      income: result.income,
      holding: updatedHolding,
    });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to record sale" } });
  }
});

// ── Realized Gain Snapshots ────────────────────────────────────────────────
// Stores YTD realized gain/loss totals pasted in from a robo-advisor dashboard.
// One row per account per year; GET returns the snapshot for the requested year
// (defaults to current year), PUT upserts it.

function serializeSnapshot(s: any) {
  return {
    id: s.id,
    accountId: s.accountId,
    year: s.year,
    longTermGain: s.longTermGain != null ? parseFloat(s.longTermGain.toString()) : null,
    shortTermGain: s.shortTermGain != null ? parseFloat(s.shortTermGain.toString()) : null,
    longTermLoss: s.longTermLoss != null ? parseFloat(s.longTermLoss.toString()) : null,
    shortTermLoss: s.shortTermLoss != null ? parseFloat(s.shortTermLoss.toString()) : null,
    snapshotDate: s.snapshotDate,
    notes: s.notes,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// GET /api/investments/gain-snapshot/:accountId?year=2026
investmentRoutes.get("/gain-snapshot/:accountId", async (req, res) => {
  try {
    const { accountId } = req.params;
    const year = req.query.year ? parseInt(req.query.year as string, 10) : new Date().getFullYear();
    if (isNaN(year)) return res.status(400).json({ error: { message: "Invalid year" } });

    const snapshot = await prisma.realizedGainSnapshot.findUnique({
      where: { accountId_year: { accountId, year } },
    });

    if (!snapshot) return res.json(null);
    res.json(serializeSnapshot(snapshot));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch gain snapshot" } });
  }
});

// PUT /api/investments/gain-snapshot — upsert for a given account+year
const upsertSnapshotSchema = z.object({
  accountId: z.string(),
  year: z.number().int().min(2000).max(2100),
  longTermGain: z.number().nullable().optional(),
  shortTermGain: z.number().nullable().optional(),
  longTermLoss: z.number().nonnegative().nullable().optional(),
  shortTermLoss: z.number().nonnegative().nullable().optional(),
  snapshotDate: z.string().transform((s) => new Date(s)),
  notes: z.string().max(500).nullable().optional(),
});

investmentRoutes.put("/gain-snapshot", async (req, res) => {
  try {
    const body = upsertSnapshotSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: body.accountId, isActive: true },
    });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    const { accountId, year, ...fields } = body;

    const snapshot = await prisma.realizedGainSnapshot.upsert({
      where: { accountId_year: { accountId, year } },
      create: { id: `${accountId}_${year}`, accountId, year, ...fields },
      update: { ...fields, updatedAt: new Date() },
    });

    res.json(serializeSnapshot(snapshot));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to save gain snapshot" } });
  }
});

// DELETE /api/investments/gain-snapshot/:accountId/:year
investmentRoutes.delete("/gain-snapshot/:accountId/:year", async (req, res) => {
  try {
    const year = parseInt(req.params.year, 10);
    if (isNaN(year)) return res.status(400).json({ error: { message: "Invalid year" } });

    await prisma.realizedGainSnapshot.delete({
      where: { accountId_year: { accountId: req.params.accountId, year } },
    });
    res.status(204).send();
  } catch (err) {
    const e = err as any;
    if (e?.code === "P2025") return res.status(404).json({ error: { message: "Snapshot not found" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete gain snapshot" } });
  }
});
