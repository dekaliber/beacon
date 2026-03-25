import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const incomeRoutes = Router();

const INCOME_ALLOWED_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "INVESTMENT"];

const INCOME_INCLUDE = {
  account: true,
  category: true,
  tags: { include: { tag: true } },
  transactionGroup: true,
  activity: true,
} as const;

const incomeSchema = z.object({
  amount: z.number().positive(),
  categoryId: z.string().optional(),
  source: z.string().optional(),
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
  if (req.query.accountIds) {
    const ids = (req.query.accountIds as string).split(",").filter(Boolean);
    where.accountId = ids.length === 1 ? ids[0] : { in: ids };
  } else if (req.query.accountId) {
    where.accountId = req.query.accountId;
  }
  if (req.query.categoryId) where.categoryId = req.query.categoryId;
  if (req.query.tagIds) {
    const ids = (req.query.tagIds as string).split(",").filter(Boolean);
    where.tags = { some: { tagId: ids.length === 1 ? ids[0] : { in: ids } } };
  } else if (req.query.tagId) {
    where.tags = { some: { tagId: req.query.tagId } };
  }
  if (req.query.search) {
    const searchStr = req.query.search as string;
    const asNumber = parseFloat(searchStr);
    const orConditions: Record<string, unknown>[] = [
      { source: { contains: searchStr, mode: "insensitive" } },
    ];
    if (!isNaN(asNumber) && asNumber > 0) {
      orConditions.push({ amount: { equals: asNumber } });
    }
    where.OR = orConditions;
  }
  if (req.query.startDate || req.query.endDate) {
    where.date = {
      ...(req.query.startDate ? { gte: new Date(req.query.startDate as string) } : {}),
      ...(req.query.endDate ? { lte: new Date(req.query.endDate as string) } : {}),
    };
  }

  // Sorting
  const sortBy = req.query.sortBy as string | undefined;
  const sortOrder = (req.query.sortOrder as string) === "asc" ? "asc" : "desc";

  let orderBy: Record<string, unknown>[];
  if (!sortBy || sortBy === "date") {
    orderBy = [{ date: sortOrder }, { createdAt: "asc" }];
  } else if (sortBy === "account") {
    orderBy = [{ account: { name: sortOrder } }, { date: "desc" }];
  } else if (sortBy === "category") {
    orderBy = [{ category: { name: sortOrder } }, { date: "desc" }];
  } else {
    orderBy = [{ [sortBy]: sortOrder }, { date: "desc" }];
  }

  const [incomes, total] = await Promise.all([
    prisma.income.findMany({
      where,
      include: INCOME_INCLUDE,
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
    include: INCOME_INCLUDE,
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
    include: INCOME_INCLUDE,
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
    include: INCOME_INCLUDE,
  });
  res.json(income);
});

// Delete income
incomeRoutes.delete("/:id", async (req, res) => {
  await prisma.income.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// Bulk edit income (source, category)
const bulkEditIncomeSchema = z.object({
  ids: z.array(z.string()).min(1),
  source: z.string().min(1).optional(),
  categoryId: z.string().nullable().optional(),
});

incomeRoutes.patch("/bulk", async (req, res) => {
  const parsed = bulkEditIncomeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { ids, source, categoryId } = parsed.data;

  const scalarUpdate: Record<string, unknown> = {};
  if (source !== undefined) scalarUpdate.source = source;
  if (categoryId !== undefined) scalarUpdate.categoryId = categoryId;

  if (Object.keys(scalarUpdate).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  await prisma.income.updateMany({ where: { id: { in: ids } }, data: scalarUpdate });
  res.json({ updated: ids.length });
});

// Bulk delete income
incomeRoutes.delete("/bulk", async (req, res) => {
  const parsed = z.object({ ids: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { ids } = parsed.data;
  await prisma.income.deleteMany({ where: { id: { in: ids } } });
  res.json({ deleted: ids.length });
});

// Bulk import income
const importRowSchema = z.object({
  amount: z.number().positive("Amount must be positive"),
  categoryId: z.string().optional(),
  source: z.string().optional(),
  date: z.string().transform((s) => new Date(s)),
  accountId: z.string(),
});

const importSchema = z.object({
  incomes: z.array(importRowSchema),
});

incomeRoutes.post("/import", async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const rows = parsed.data.incomes;
  let imported = 0;
  const errors: Array<{ row: number; message: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    try {
      const row = rows[i];
      const account = await prisma.account.findUnique({ where: { id: row.accountId } });
      if (!account || !INCOME_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
        errors.push({ row: i + 1, message: `Invalid account` });
        continue;
      }
      // Validate category is an income category if provided
      if (row.categoryId) {
        const category = await prisma.category.findUnique({ where: { id: row.categoryId } });
        if (!category || category.kind !== "INCOME") {
          errors.push({ row: i + 1, message: `Invalid income category` });
          continue;
        }
      }
      await prisma.income.create({ data: row });
      imported++;
    } catch (err) {
      errors.push({ row: i + 1, message: err instanceof Error ? err.message : "Unknown error" });
    }
  }

  res.json({ imported, errors });
});
