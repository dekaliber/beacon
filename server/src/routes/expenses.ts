import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { generateUpcomingExpenses } from "./recurrence.js";

export const expenseRoutes = Router();

const EXPENSE_ALLOWED_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CREDIT_CARD", "CASH"];

const expenseSchema = z.object({
  amount: z.number().refine((v) => v !== 0, "Amount cannot be zero"),
  description: z.string().min(1),
  vendor: z.string().min(1),
  date: z.string().transform((s) => new Date(s)),
  notes: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  accountId: z.string(),
  isReimbursementExpected: z.boolean().optional(),
  reimbursementNote: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  transactionGroupId: z.string().nullable().optional(),
  recurrenceRuleId: z.string().nullable().optional(),
  parentExpenseId: z.string().nullable().optional(),
});

// List expenses with filtering and pagination
expenseRoutes.get("/", async (req, res) => {
  // Auto-generate upcoming recurring expenses (best-effort, don't block listing)
  try {
    await generateUpcomingExpenses();
  } catch (err) {
    console.error("Failed to generate upcoming expenses:", err);
  }

  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {
    parentExpenseId: null, // Exclude offset rows from main list
  };

  if (req.query.categoryId === "uncategorized") {
    where.categoryId = null;
  } else if (req.query.categoryId) {
    where.categoryId = req.query.categoryId;
  }
  if (req.query.accountId) where.accountId = req.query.accountId;
  if (req.query.isReimbursementExpected === "true") where.isReimbursementExpected = true;
  if (req.query.tagId) where.tags = { some: { tagId: req.query.tagId } };
  if (req.query.vendor) where.vendor = { contains: req.query.vendor as string, mode: "insensitive" };
  if (req.query.search) {
    where.OR = [
      { description: { contains: req.query.search as string, mode: "insensitive" } },
      { vendor: { contains: req.query.search as string, mode: "insensitive" } },
    ];
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

  // Build orderBy array: primary sort + secondary tiebreakers
  let orderBy: Record<string, unknown>[];
  if (!sortBy || sortBy === "date") {
    // Default or explicit date sort: date, then recurring first, then creation order
    orderBy = [
      { date: sortOrder },
      { recurrenceRuleId: { sort: "asc", nulls: "last" } },
      { createdAt: "asc" },
    ];
  } else if (sortBy === "category") {
    orderBy = [{ category: { name: sortOrder } }, { date: "desc" }];
  } else if (sortBy === "account") {
    orderBy = [{ account: { name: sortOrder } }, { date: "desc" }];
  } else {
    orderBy = [{ [sortBy]: sortOrder }, { date: "desc" }];
  }

  const expenseInclude = {
    category: true,
    account: true,
    tags: { include: { tag: true } },
    transactionGroup: true,
  };

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: {
        ...expenseInclude,
        offsets: {
          include: expenseInclude,
          orderBy: { createdAt: "asc" as const },
        },
      },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.expense.count({ where }),
  ]);

  res.json({
    data: expenses,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

// Get distinct vendors for autocomplete
expenseRoutes.get("/vendors", async (_req, res) => {
  const expenses = await prisma.expense.findMany({
    where: { vendor: { not: "" } },
    select: { vendor: true },
    distinct: ["vendor"],
    orderBy: { vendor: "asc" },
  });
  res.json(expenses.map((e) => e.vendor));
});

// Get the last-used categoryId for a given vendor
expenseRoutes.get("/vendor-category", async (req, res) => {
  const vendor = req.query.vendor as string;
  if (!vendor) return res.json({ categoryId: null });

  const expense = await prisma.expense.findFirst({
    where: { vendor: { equals: vendor, mode: "insensitive" } },
    orderBy: { date: "desc" },
    select: { categoryId: true },
  });
  res.json({ categoryId: expense?.categoryId ?? null });
});

// Count uncategorized expenses (exclude offsets)
expenseRoutes.get("/uncategorized-count", async (_req, res) => {
  const count = await prisma.expense.count({
    where: { categoryId: null, parentExpenseId: null },
  });
  res.json({ count });
});

// Get single expense
expenseRoutes.get("/:id", async (req, res) => {
  const expense = await prisma.expense.findUnique({
    where: { id: req.params.id },
    include: {
      category: true,
      account: true,
      recurrenceRule: true,
      tags: { include: { tag: true } },
      transactionGroup: true,
      offsets: {
        include: {
          category: true,
          account: true,
          tags: { include: { tag: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  res.json(expense);
});

// Create expense
expenseRoutes.post("/", async (req, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { tagIds, ...data } = parsed.data;

  // Validate account type allows expenses
  const account = await prisma.account.findUnique({ where: { id: data.accountId } });
  if (!account) return res.status(400).json({ error: "Account not found" });
  if (!EXPENSE_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
    return res.status(400).json({
      error: `Account type '${account.type}' cannot have expenses. Allowed types: Checking, Savings, Credit Card, Cash.`,
    });
  }

  const expense = await prisma.expense.create({
    data: {
      ...data,
      ...(tagIds?.length ? { tags: { create: tagIds.map((id) => ({ tagId: id })) } } : {}),
    },
    include: {
      category: true,
      account: true,
      tags: { include: { tag: true } },
      transactionGroup: true,
      offsets: {
        include: { category: true, account: true, tags: { include: { tag: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  res.status(201).json(expense);
});

// Update expense
expenseRoutes.put("/:id", async (req, res) => {
  const parsed = expenseSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { tagIds, ...data } = parsed.data;

  // Validate account type if accountId is being changed
  if (data.accountId) {
    const account = await prisma.account.findUnique({ where: { id: data.accountId } });
    if (!account) return res.status(400).json({ error: "Account not found" });
    if (!EXPENSE_ALLOWED_ACCOUNT_TYPES.includes(account.type)) {
      return res.status(400).json({
        error: `Account type '${account.type}' cannot have expenses. Allowed types: Checking, Savings, Credit Card, Cash.`,
      });
    }
  }

  const expense = await prisma.expense.update({
    where: { id: req.params.id },
    data: {
      ...data,
      ...(tagIds !== undefined
        ? { tags: { deleteMany: {}, create: tagIds.map((id) => ({ tagId: id })) } }
        : {}),
    },
    include: {
      category: true,
      account: true,
      tags: { include: { tag: true } },
      transactionGroup: true,
      offsets: {
        include: { category: true, account: true, tags: { include: { tag: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  res.json(expense);
});

// Delete expense
expenseRoutes.delete("/:id", async (req, res) => {
  await prisma.expense.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
