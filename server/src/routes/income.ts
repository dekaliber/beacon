import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const incomeRoutes = Router();

const INCOME_ALLOWED_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "INVESTMENT"];

const incomeSchema = z.object({
  amount: z.number().positive(),
  source: z.enum(["DIVIDENDS", "INTEREST", "CAPITAL_GAINS", "GIFTS", "OTHER"]),
  date: z.string().transform((s) => new Date(s)),
  notes: z.string().optional(),
  accountId: z.string(),
  tagIds: z.array(z.string()).optional(),
  transactionGroupId: z.string().nullable().optional(),
});

// List incomes with optional filtering and pagination
incomeRoutes.get("/", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (req.query.accountId) where.accountId = req.query.accountId;
  if (req.query.source) where.source = req.query.source;
  if (req.query.tagId) where.tags = { some: { tagId: req.query.tagId } };
  if (req.query.startDate || req.query.endDate) {
    where.date = {
      ...(req.query.startDate ? { gte: new Date(req.query.startDate as string) } : {}),
      ...(req.query.endDate ? { lte: new Date(req.query.endDate as string) } : {}),
    };
  }

  // Sorting
  const sortBy = (req.query.sortBy as string) || "date";
  const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";
  const orderBy: Record<string, unknown> = {};
  if (sortBy === "account") {
    orderBy.account = { name: sortOrder };
  } else {
    orderBy[sortBy] = sortOrder;
  }

  const [incomes, total] = await Promise.all([
    prisma.income.findMany({
      where,
      include: { account: true, tags: { include: { tag: true } }, transactionGroup: true },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.income.count({ where }),
  ]);

  res.json({
    data: incomes,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// Get single income
incomeRoutes.get("/:id", async (req, res) => {
  const income = await prisma.income.findUnique({
    where: { id: req.params.id },
    include: { account: true, tags: { include: { tag: true } }, transactionGroup: true },
  });
  if (!income) return res.status(404).json({ error: "Income not found" });
  res.json(income);
});

// Create income
incomeRoutes.post("/", async (req, res) => {
  const parsed = incomeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { tagIds, ...data } = parsed.data;

  // Validate account type allows income
  const account = await prisma.account.findUnique({ where: { id: data.accountId } });
  if (!account) return res.status(400).json({ error: "Account not found" });
  if (!INCOME_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
    return res.status(400).json({
      error: `Account type '${account.type}' cannot receive income. Allowed types: Checking, Savings, Investment.`,
    });
  }

  const income = await prisma.income.create({
    data: {
      ...data,
      ...(tagIds?.length ? { tags: { create: tagIds.map((id) => ({ tagId: id })) } } : {}),
    },
    include: { account: true, tags: { include: { tag: true } }, transactionGroup: true },
  });
  res.status(201).json(income);
});

// Update income
incomeRoutes.put("/:id", async (req, res) => {
  const parsed = incomeSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { tagIds, ...data } = parsed.data;

  // Validate account type if accountId is being changed
  if (data.accountId) {
    const account = await prisma.account.findUnique({ where: { id: data.accountId } });
    if (!account) return res.status(400).json({ error: "Account not found" });
    if (!INCOME_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
      return res.status(400).json({
        error: `Account type '${account.type}' cannot receive income. Allowed types: Checking, Savings, Investment.`,
      });
    }
  }

  const income = await prisma.income.update({
    where: { id: req.params.id },
    data: {
      ...data,
      ...(tagIds !== undefined
        ? {
            tags: {
              deleteMany: {},
              create: tagIds.map((id) => ({ tagId: id })),
            },
          }
        : {}),
    },
    include: { account: true, tags: { include: { tag: true } }, transactionGroup: true },
  });
  res.json(income);
});

// Delete income
incomeRoutes.delete("/:id", async (req, res) => {
  await prisma.income.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
