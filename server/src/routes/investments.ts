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

function computeHoldingFields(
  lots: { quantity: any; costPerShare: any; acquiredDate: Date }[],
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

    if (currentPrice != null) {
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

  return { totalQuantity, totalCost, marketValue, totalGain, totalGainPct, shortTermGain, longTermGain };
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
        currentPrice,
        priceDate: priceRecord?.priceDate ?? null,
        priceUpdatedAt: priceRecord?.updatedAt ?? null,
        lots: holding.lots.map((lot) => ({
          id: lot.id,
          holdingId: lot.holdingId,
          quantity: lot.quantity.toString(),
          costPerShare: lot.costPerShare.toString(),
          acquiredDate: lot.acquiredDate.toISOString(),
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
  acquiredDate: z.string().transform((s) => new Date(s)),
});

investmentRoutes.post("/lots", async (req, res) => {
  try {
    const body = createLotSchema.parse(req.body);
    const lot = await prisma.investmentLot.create({ data: body });
    res.status(201).json({
      ...lot,
      quantity: lot.quantity.toString(),
      costPerShare: lot.costPerShare.toString(),
      acquiredDate: lot.acquiredDate.toISOString(),
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
  acquiredDate: z.string().transform((s) => new Date(s)).optional(),
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
      acquiredDate: lot.acquiredDate.toISOString(),
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
  id: string; accountId: string; name: string;
  totalCost: any; marketValue: any; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: m.id,
    accountId: m.accountId,
    name: m.name,
    totalCost: m.totalCost != null ? parseFloat(m.totalCost.toString()) : null,
    marketValue: parseFloat(m.marketValue.toString()),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

const createManualSchema = z.object({
  accountId: z.string(),
  name: z.string().min(1).max(200),
  totalCost: z.number().nonnegative().nullable().optional(),
  marketValue: z.number().nonnegative(),
});

const updateManualSchema = z.object({
  name: z.string().min(1).max(200).optional(),
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
