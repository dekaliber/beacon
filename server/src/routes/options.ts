import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";

export const optionsRoutes = Router();

// ── Yahoo Finance crumb cache ──────────────────────────────────────────────────
// Yahoo requires a crumb+cookie pair obtained by first hitting fc.yahoo.com.
// We cache it for 30 minutes to avoid re-authing on every quote request.

type YahooCred = { crumb: string; cookie: string; fetchedAt: number };
let _yahooCred: YahooCred | null = null;
const CRUMB_TTL_MS = 30 * 60 * 1000;

async function getYahooCred(): Promise<YahooCred> {
  if (_yahooCred && Date.now() - _yahooCred.fetchedAt < CRUMB_TTL_MS) {
    return _yahooCred;
  }

  // Step 1: hit fc.yahoo.com to get auth cookies
  const initRes = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": "Mozilla/5.0" },
    redirect: "follow",
  });
  const rawCookies: string[] = initRes.headers.getSetCookie?.() ?? [];
  const cookie = rawCookies.map((c) => c.split(";")[0]).join("; ");

  // Step 2: exchange cookies for a crumb
  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie },
  });
  if (!crumbRes.ok) throw new Error(`Failed to get Yahoo crumb: ${crumbRes.status}`);
  const crumb = await crumbRes.text();
  if (!crumb || crumb.includes("error")) throw new Error("Invalid crumb response");

  _yahooCred = { crumb, cookie, fetchedAt: Date.now() };
  return _yahooCred;
}

// ── Settings ───────────────────────────────────────────────────────────────────

const settingsSchema = z.object({
  startingBasis: z.coerce.number().positive(),
  targetReturn: z.coerce.number().positive(),
  startingWeek: z.string().nullable().optional(),
});

optionsRoutes.get("/settings", async (req, res) => {
  const userId = getUserId(req);
  const settings = await prisma.optionsSettings.findUnique({ where: { userId } });
  res.json(settings ?? null);
});

optionsRoutes.put("/settings", async (req, res) => {
  const userId = getUserId(req);
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await prisma.optionsSettings.upsert({
    where: { userId },
    create: { userId, ...parsed.data },
    update: parsed.data,
  });
  res.json(settings);
});

// ── Tickers ────────────────────────────────────────────────────────────────────

const tickerSchema = z.object({
  symbol: z.string().min(1).max(10).toUpperCase(),
  opportunityCostStartDate: z.string().nullable().optional(),
  opportunityCostStartPrice: z.coerce.number().positive().nullable().optional(),
});

optionsRoutes.get("/tickers", async (req, res) => {
  const userId = getUserId(req);
  const tickers = await prisma.optionsTicker.findMany({
    where: { userId, isActive: true },
    orderBy: { symbol: "asc" },
  });
  res.json(tickers);
});

optionsRoutes.post("/tickers", async (req, res) => {
  const userId = getUserId(req);
  const parsed = tickerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.optionsTicker.findFirst({
    where: { userId, symbol: parsed.data.symbol },
  });
  if (existing) {
    if (!existing.isActive) {
      const restored = await prisma.optionsTicker.update({
        where: { id: existing.id },
        data: { isActive: true, ...parsed.data },
      });
      return res.status(201).json(restored);
    }
    return res.status(409).json({ error: "Ticker already exists" });
  }

  const ticker = await prisma.optionsTicker.create({
    data: { userId, ...parsed.data },
  });
  res.status(201).json(ticker);
});

optionsRoutes.put("/tickers/:id", async (req, res) => {
  const userId = getUserId(req);
  const parsed = tickerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ticker = await prisma.optionsTicker.updateMany({
    where: { id: req.params.id, userId },
    data: parsed.data,
  });
  if (ticker.count === 0) return res.status(404).json({ error: "Not found" });
  res.json(await prisma.optionsTicker.findUnique({ where: { id: req.params.id } }));
});

// ── Position Groups ────────────────────────────────────────────────────────────

const groupSchema = z.object({
  label: z.string().nullable().optional(),
});

optionsRoutes.get("/groups", async (req, res) => {
  const userId = getUserId(req);
  const groups = await prisma.optionsPositionGroup.findMany({
    where: { userId, isActive: true },
    include: { positions: { where: { isActive: true }, orderBy: { sequenceInGroup: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(groups);
});

optionsRoutes.post("/groups", async (req, res) => {
  const userId = getUserId(req);
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const group = await prisma.optionsPositionGroup.create({
    data: { userId, ...parsed.data },
  });
  res.status(201).json(group);
});

optionsRoutes.put("/groups/:id", async (req, res) => {
  const userId = getUserId(req);
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await prisma.optionsPositionGroup.updateMany({
    where: { id: req.params.id, userId },
    data: parsed.data,
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.json(await prisma.optionsPositionGroup.findUnique({ where: { id: req.params.id } }));
});

// ── Positions ──────────────────────────────────────────────────────────────────

const positionOpenSchema = z.object({
  tickerId: z.string(),
  groupId: z.string().nullable().optional(),
  sequenceInGroup: z.coerce.number().int().positive().nullable().optional(),
  optionType: z.enum(["CALL", "PUT"]),
  side: z.enum(["BUY", "SELL"]).default("SELL"),
  strikePrice: z.coerce.number().positive(),
  expirationDate: z.string(), // ISO date string YYYY-MM-DD
  openedAt: z.string().optional(), // ISO datetime string in UTC (client converts from ET); optional for drafts
  contracts: z.coerce.number().int().positive(),
  premiumPerShare: z.coerce.number().positive(),
  feesOpen: z.coerce.number().nonnegative().nullable().optional(),
  shareCostBasis: z.coerce.number().positive().nullable().optional(),
  stockPriceAtOpen: z.coerce.number().positive().nullable().optional(),
  currentPremiumPerShare: z.coerce.number().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional(),
  assignedFromStrikePrice: z.coerce.number().positive().nullable().optional(),
  assignedFromExpirationDate: z.string().nullable().optional(), // YYYY-MM-DD
  investmentAccountId: z.string().nullable().optional(),
  isDraft: z.boolean().optional(),
});

const positionCloseSchema = z.object({
  status: z.enum(["CLOSED", "EXPIRED", "ASSIGNED"]),
  outcome: z.enum(["EXPIRED_WORTHLESS", "CLOSED_EARLY", "ROLLED", "ASSIGNED"]),
  closedAt: z.string().nullable().optional(),
  closePremiumPerShare: z.coerce.number().nonnegative().nullable().optional(),
  feesClose: z.coerce.number().nonnegative().nullable().optional(),
  contractsAssigned: z.coerce.number().int().nonnegative().nullable().optional(),
  stockPriceAtClose: z.coerce.number().positive().nullable().optional(),
  bankingAccountId: z.string().nullable().optional(),
});

optionsRoutes.get("/positions", async (req, res) => {
  const userId = getUserId(req);
  const { status } = req.query;

  const where: Record<string, unknown> = { userId, isActive: true };
  if (status === "open") where.status = "OPEN";
  if (status === "closed") where.status = { in: ["CLOSED", "EXPIRED", "ASSIGNED"] };

  const positions = await prisma.optionsPosition.findMany({
    where,
    include: {
      ticker: true,
      group: true,
    },
    orderBy: { openedAt: "desc" },
  });
  res.json(positions);
});

optionsRoutes.post("/positions", async (req, res) => {
  const userId = getUserId(req);
  const parsed = positionOpenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Verify ticker belongs to user
  const ticker = await prisma.optionsTicker.findFirst({
    where: { id: parsed.data.tickerId, userId },
  });
  if (!ticker) return res.status(400).json({ error: "Invalid ticker" });

  const openedAt = parsed.data.openedAt ? new Date(parsed.data.openedAt) : new Date();

  // Auto-set opportunity cost start date to first non-draft position date if not set
  if (!ticker.opportunityCostStartDate && !parsed.data.isDraft) {
    await prisma.optionsTicker.update({
      where: { id: ticker.id },
      data: { opportunityCostStartDate: openedAt },
    });
  }

  const { openedAt: _openedAt, assignedFromExpirationDate, ...restData } = parsed.data;
  const position = await prisma.optionsPosition.create({
    data: {
      userId,
      ...restData,
      openedAt,
      expirationDate: new Date(parsed.data.expirationDate + "T20:00:00.000Z"),
      assignedFromExpirationDate: assignedFromExpirationDate
        ? new Date(assignedFromExpirationDate + "T20:00:00.000Z")
        : null,
    },
    include: { ticker: true, group: true },
  });
  res.status(201).json(position);
});

optionsRoutes.put("/positions/:id", async (req, res) => {
  const userId = getUserId(req);

  // Allow updating open fields or close fields
  const openParsed = positionOpenSchema.partial().safeParse(req.body);
  const closeParsed = positionCloseSchema.partial().safeParse(req.body);

  const data: Record<string, unknown> = {};
  if (openParsed.success) Object.assign(data, openParsed.data);
  if (closeParsed.success) Object.assign(data, closeParsed.data);
  if (typeof data.expirationDate === "string") {
    data.expirationDate = new Date(data.expirationDate + "T20:00:00.000Z");
  }
  if (typeof data.assignedFromExpirationDate === "string") {
    data.assignedFromExpirationDate = new Date(data.assignedFromExpirationDate + "T20:00:00.000Z");
  }
  // bankingAccountId is not a position field — extract before updating
  const bankingAccountId = typeof data.bankingAccountId === "string" ? data.bankingAccountId : null;
  delete data.bankingAccountId;

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No valid fields provided" });
  }

  const result = await prisma.optionsPosition.updateMany({
    where: { id: req.params.id, userId },
    data,
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });

  const updated = await prisma.optionsPosition.findUnique({
    where: { id: req.params.id },
    include: { ticker: true, group: true, pendingBuy: true },
  });

  // When a position is being assigned and has an investment account linked,
  // create a PendingBuy (if one doesn't already exist for this position).
  if (
    updated &&
    updated.outcome === "ASSIGNED" &&
    updated.investmentAccountId &&
    !updated.pendingBuy
  ) {
    const shares = (updated.contractsAssigned ?? updated.contracts) * 100;
    const totalFees = (Number(updated.feesOpen) || 0) + (Number(updated.feesClose) || 0);
    const costPerShare =
      Number(updated.strikePrice) -
      Number(updated.premiumPerShare) +
      totalFees / shares;

    await prisma.pendingBuy.upsert({
      where: { optionsPositionId: updated.id },
      create: {
        userId,
        accountId: updated.investmentAccountId,
        optionsPositionId: updated.id,
        ticker: updated.ticker.symbol,
        quantity: shares,
        costPerShare: Math.max(0, costPerShare),
        acquiredDate: updated.expirationDate,
      },
      update: {},
    });
  }

  // If a PENDING buy already exists but the investment account changed, redirect it to the new account.
  if (
    updated &&
    updated.pendingBuy &&
    updated.pendingBuy.status === "PENDING" &&
    updated.investmentAccountId &&
    updated.pendingBuy.accountId !== updated.investmentAccountId
  ) {
    await prisma.pendingBuy.update({
      where: { id: updated.pendingBuy.id },
      data: { accountId: updated.investmentAccountId },
    });
  }

  // Auto-create an Income record for income-generating close outcomes
  if (
    updated &&
    bankingAccountId &&
    (updated.outcome === "EXPIRED_WORTHLESS" ||
      updated.outcome === "CLOSED_EARLY" ||
      updated.outcome === "ASSIGNED")
  ) {
    const contracts =
      updated.outcome === "ASSIGNED"
        ? Number(updated.contractsAssigned ?? updated.contracts)
        : Number(updated.contracts);
    const shares = contracts * 100;
    const premiumPerShare = Number(updated.premiumPerShare);
    const closePremiumPerShare =
      updated.outcome === "CLOSED_EARLY" ? Number(updated.closePremiumPerShare ?? 0) : 0;
    const feesOpen = Number(updated.feesOpen ?? 0);
    const feesClose = Number(updated.feesClose ?? 0);
    const netAmount = (premiumPerShare - closePremiumPerShare) * shares - feesOpen - feesClose;

    if (netAmount > 0) {
      // Find or create "Options Premium" income category for this user
      let category = await prisma.category.findFirst({
        where: { userId, name: "Options Premium", kind: "INCOME" },
      });
      if (!category) {
        category = await prisma.category.create({
          data: { userId, name: "Options Premium", kind: "INCOME" },
        });
      }

      // Format expiration date as YY.MM.DD for the source string
      const exp = updated.expirationDate;
      const yy = String(exp.getUTCFullYear()).slice(2);
      const mm = String(exp.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(exp.getUTCDate()).padStart(2, "0");
      const expStr = `${yy}.${mm}.${dd}`;

      const strike = Number(updated.strikePrice);
      const strikeStr = strike === Math.floor(strike) ? `$${Math.floor(strike)}` : `$${strike}`;
      const optionType = updated.optionType === "CALL" ? "Call" : "Put";
      const source = `${updated.ticker.symbol} ${expStr} ${optionType} ${strikeStr} x${contracts}`;

      // Use close date as transaction date; fall back to expiration for EXPIRED_WORTHLESS
      const incomeDate = updated.closedAt ?? updated.expirationDate;

      await prisma.income.create({
        data: {
          amount: netAmount,
          categoryId: category.id,
          source,
          date: incomeDate,
          accountId: bankingAccountId,
          taxClassification: "ORDINARY",
          taxableAmount: netAmount,
        },
      });
    }
  }

  res.json(updated);
});

// Roll a position: close it with outcome=ROLLED, open a new one, link both via a group
const rollSchema = z.object({
  // Close side
  closedAt: z.string().nullable().optional(),
  closePremiumPerShare: z.coerce.number().nonnegative().nullable().optional(),
  feesClose: z.coerce.number().nonnegative().nullable().optional(),
  // New position side
  newPremiumPerShare: z.coerce.number().positive(),
  newStrikePrice: z.coerce.number().positive(),
  newExpirationDate: z.string(), // YYYY-MM-DD
  newStockPriceAtOpen: z.coerce.number().positive().nullable().optional(),
  newFeesOpen: z.coerce.number().nonnegative().nullable().optional(),
});

optionsRoutes.post("/positions/:id/roll", async (req, res) => {
  const userId = getUserId(req);
  const parsed = rollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.optionsPosition.findFirst({
    where: { id: req.params.id, userId, isActive: true, status: "OPEN" },
  });
  if (!existing) return res.status(404).json({ error: "Position not found or already closed" });

  const {
    closedAt, closePremiumPerShare, feesClose,
    newPremiumPerShare, newStrikePrice, newExpirationDate, newStockPriceAtOpen, newFeesOpen,
  } = parsed.data;

  const result = await prisma.$transaction(async (tx) => {
    // Determine group: reuse existing or create a new one
    let groupId = existing.groupId;
    if (!groupId) {
      const group = await tx.optionsPositionGroup.create({
        data: { userId },
      });
      groupId = group.id;
      // Assign the original position to the group as sequence 1
      await tx.optionsPosition.update({
        where: { id: existing.id },
        data: { groupId, sequenceInGroup: 1 },
      });
    }

    // Find next sequence number
    const maxSeq = await tx.optionsPosition.aggregate({
      where: { groupId, isActive: true },
      _max: { sequenceInGroup: true },
    });
    const nextSeq = (maxSeq._max.sequenceInGroup ?? 1) + 1;

    // Close the existing position
    const closed = await tx.optionsPosition.update({
      where: { id: existing.id },
      data: {
        status: "CLOSED",
        outcome: "ROLLED",
        closedAt: closedAt ? new Date(closedAt) : new Date(),
        closePremiumPerShare: closePremiumPerShare ?? null,
        feesClose: feesClose ?? null,
      },
      include: { ticker: true, group: true },
    });

    // Open the new position
    const opened = await tx.optionsPosition.create({
      data: {
        userId,
        tickerId: existing.tickerId,
        groupId,
        sequenceInGroup: nextSeq,
        optionType: existing.optionType,
        side: existing.side,
        strikePrice: newStrikePrice,
        expirationDate: new Date(newExpirationDate + "T20:00:00.000Z"),
        openedAt: closedAt ? new Date(closedAt) : new Date(),
        contracts: existing.contracts,
        premiumPerShare: newPremiumPerShare,
        feesOpen: newFeesOpen ?? null,
        stockPriceAtOpen: newStockPriceAtOpen ?? null,
      },
      include: { ticker: true, group: true },
    });

    return { closed, opened };
  });

  res.status(201).json(result);
});

optionsRoutes.delete("/positions/:id", async (req, res) => {
  const userId = getUserId(req);
  const result = await prisma.optionsPosition.updateMany({
    where: { id: req.params.id, userId },
    data: { isActive: false },
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

// ── Option Quote (Yahoo Finance) ───────────────────────────────────────────────

optionsRoutes.get("/option-quote", async (req, res) => {
  const { symbol, type, strike, expiration } = req.query;

  if (!symbol || !type || !strike || !expiration) {
    return res.status(400).json({ error: "Missing required params: symbol, type, strike, expiration" });
  }

  // Convert expiration YYYY-MM-DD to Unix timestamp for Yahoo Finance
  const expDate = new Date((expiration as string) + "T00:00:00.000Z");
  const expTimestamp = Math.floor(expDate.getTime() / 1000);
  const strikeNum = parseFloat(strike as string);
  const optionSide = (type as string).toUpperCase();

  try {
    const fetchWithCred = async (cred: YahooCred) => {
      const url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol as string)}?date=${expTimestamp}&crumb=${encodeURIComponent(cred.crumb)}`;
      return fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json", Cookie: cred.cookie },
      });
    };

    let cred = await getYahooCred();
    let yahooRes = await fetchWithCred(cred);

    // Crumb may have expired — refresh once and retry
    if (yahooRes.status === 401) {
      _yahooCred = null;
      cred = await getYahooCred();
      yahooRes = await fetchWithCred(cred);
    }

    if (!yahooRes.ok) {
      return res.status(502).json({ error: `Yahoo Finance returned ${yahooRes.status}` });
    }

    const data = await yahooRes.json() as any;
    const optionData = data?.optionChain?.result?.[0];
    if (!optionData) return res.status(404).json({ error: "No option chain data found" });

    const optionExp = optionData.options?.[0];
    if (!optionExp) return res.status(404).json({ error: "No options for that expiration" });

    const chain: any[] = optionSide === "CALL" ? (optionExp.calls ?? []) : (optionExp.puts ?? []);

    // Find closest strike in case of floating-point mismatch
    const option = chain.reduce((best: any, o: any) => {
      if (!best) return o;
      return Math.abs(o.strike - strikeNum) < Math.abs(best.strike - strikeNum) ? o : best;
    }, null);

    if (!option || Math.abs(option.strike - strikeNum) > 1) {
      return res.status(404).json({ error: "No matching option found for that strike" });
    }

    const bid: number | null = option.bid ?? null;
    const ask: number | null = option.ask ?? null;
    const lastPrice: number | null = option.lastPrice ?? null;
    const mark = bid != null && ask != null ? (bid + ask) / 2 : lastPrice;

    res.json({
      bid,
      ask,
      lastPrice,
      mark,
      impliedVolatility: option.impliedVolatility ?? null,
      volume: option.volume ?? null,
      openInterest: option.openInterest ?? null,
      inTheMoney: option.inTheMoney ?? null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Import ─────────────────────────────────────────────────────────────────────

const importRowSchema = z.object({
  tickerSymbol: z.string().min(1).max(10).toUpperCase(),
  optionType: z.enum(["CALL", "PUT"]),
  strikePrice: z.coerce.number().positive(),
  expirationDate: z.string(),
  openedAt: z.string(),
  premiumPerShare: z.coerce.number().positive(),
  contracts: z.coerce.number().int().positive(),
  shareCostBasis: z.coerce.number().positive().nullable().optional(),
  stockPriceAtOpen: z.coerce.number().positive().nullable().optional(),
  feesOpen: z.coerce.number().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional(),
});

optionsRoutes.post("/positions/import", async (req, res) => {
  const userId = getUserId(req);
  const rows: unknown[] = Array.isArray(req.body.positions) ? req.body.positions : [];

  let imported = 0;
  const errors: Array<{ row: number; message: string }> = [];

  // Cache tickers looked up/created during this import
  const tickerCache = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const parsed = importRowSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push({ row: i + 1, message: parsed.error.errors[0]?.message ?? "Invalid row" });
      continue;
    }

    const d = parsed.data;

    try {
      // Find or create ticker
      let tickerId = tickerCache.get(d.tickerSymbol);
      if (!tickerId) {
        let ticker = await prisma.optionsTicker.findFirst({
          where: { userId, symbol: d.tickerSymbol },
        });
        if (!ticker) {
          ticker = await prisma.optionsTicker.create({
            data: { userId, symbol: d.tickerSymbol },
          });
        } else if (!ticker.isActive) {
          ticker = await prisma.optionsTicker.update({
            where: { id: ticker.id },
            data: { isActive: true },
          });
        }
        tickerId = ticker.id;
        tickerCache.set(d.tickerSymbol, tickerId);
      }

      const position = await prisma.optionsPosition.create({
        data: {
          userId,
          tickerId,
          optionType: d.optionType,
          side: "SELL",
          strikePrice: d.strikePrice,
          expirationDate: new Date(d.expirationDate + "T20:00:00.000Z"),
          openedAt: new Date(d.openedAt),
          contracts: d.contracts,
          premiumPerShare: d.premiumPerShare,
          shareCostBasis: d.shareCostBasis ?? null,
          stockPriceAtOpen: d.stockPriceAtOpen ?? null,
          feesOpen: d.feesOpen ?? null,
          notes: d.notes ?? null,
        },
      });

      // Auto-set opportunity cost start date if not yet set
      await prisma.optionsTicker.updateMany({
        where: { id: tickerId, opportunityCostStartDate: null },
        data: { opportunityCostStartDate: new Date(d.openedAt) },
      });

      imported++;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      errors.push({ row: i + 1, message });
    }
  }

  res.json({ imported, errors });
});
