import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";

export const optionsRoutes = Router();

// ── Settings ───────────────────────────────────────────────────────────────────

const settingsSchema = z.object({
  startingBasis: z.coerce.number().positive(),
  targetReturn: z.coerce.number().positive(),
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
  openedAt: z.string(), // ISO datetime string in UTC (client converts from ET)
  contracts: z.coerce.number().int().positive(),
  premiumPerShare: z.coerce.number().positive(),
  feesOpen: z.coerce.number().nonnegative().nullable().optional(),
  shareCostBasis: z.coerce.number().positive().nullable().optional(),
  stockPriceAtOpen: z.coerce.number().positive().nullable().optional(),
  notes: z.string().nullable().optional(),
  assignedFromPositionId: z.string().nullable().optional(),
});

const positionCloseSchema = z.object({
  status: z.enum(["CLOSED", "EXPIRED", "ASSIGNED"]),
  outcome: z.enum(["EXPIRED_WORTHLESS", "CLOSED_EARLY", "ROLLED", "ASSIGNED"]),
  closedAt: z.string().nullable().optional(),
  closePremiumPerShare: z.coerce.number().nonnegative().nullable().optional(),
  feesClose: z.coerce.number().nonnegative().nullable().optional(),
  contractsAssigned: z.coerce.number().int().nonnegative().nullable().optional(),
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

  // Auto-set opportunity cost start date to first position date if not set
  if (!ticker.opportunityCostStartDate) {
    await prisma.optionsTicker.update({
      where: { id: ticker.id },
      data: { opportunityCostStartDate: new Date(parsed.data.openedAt) },
    });
  }

  const position = await prisma.optionsPosition.create({
    data: { userId, ...parsed.data },
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
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No valid fields provided" });
  }

  const result = await prisma.optionsPosition.updateMany({
    where: { id: req.params.id, userId },
    data,
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.json(
    await prisma.optionsPosition.findUnique({
      where: { id: req.params.id },
      include: { ticker: true, group: true },
    })
  );
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
