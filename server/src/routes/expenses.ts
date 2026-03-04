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

  // Get original expense to check recurrence rule linkage
  const original = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!original) return res.status(404).json({ error: "Expense not found" });

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

  // Sync changes to recurrence rule and future pending expenses
  if (original.recurrenceRuleId) {
    const rule = await prisma.recurrenceRule.findUnique({
      where: { id: original.recurrenceRuleId },
    });
    if (rule && rule.isActive) {
      const syncFields = ["amount", "description", "vendor", "categoryId", "accountId"] as const;
      const ruleUpdate: Record<string, unknown> = {};
      for (const field of syncFields) {
        if (field in data) {
          ruleUpdate[field] = (data as Record<string, unknown>)[field];
        }
      }
      if (Object.keys(ruleUpdate).length > 0) {
        // Match ALL sync fields against old rule values so that any
        // manually edited pending expense is excluded from the bulk update.
        const matchUnedited: Record<string, unknown> = {};
        for (const field of syncFields) {
          matchUnedited[field] = rule[field];
        }

        await prisma.recurrenceRule.update({
          where: { id: original.recurrenceRuleId },
          data: ruleUpdate,
        });
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        await prisma.expense.updateMany({
          where: {
            recurrenceRuleId: original.recurrenceRuleId,
            date: { gt: today },
            id: { not: original.id },
            ...matchUnedited,
          },
          data: ruleUpdate,
        });
      }
    }
  }

  res.json(expense);
});

// Delete expense
expenseRoutes.delete("/:id", async (req, res) => {
  const expense = await prisma.expense.findUnique({ where: { id: req.params.id } });
  if (!expense) return res.status(404).json({ error: "Expense not found" });

  // If linked to a recurrence rule and this is a past/present expense,
  // deactivate the rule and remove future pending instances that haven't
  // been manually edited. Manually edited ones are unlinked and preserved.
  // If it's a future expense, just delete this single instance (skip occurrence).
  if (expense.recurrenceRuleId) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (expense.date <= today) {
      const rule = await prisma.recurrenceRule.findUnique({
        where: { id: expense.recurrenceRuleId },
      });
      await prisma.recurrenceRule.update({
        where: { id: expense.recurrenceRuleId },
        data: { isActive: false },
      });
      if (rule) {
        // Build match criteria for unmodified expenses
        const syncFields = ["amount", "description", "vendor", "categoryId", "accountId"] as const;
        const matchUnedited: Record<string, unknown> = {};
        for (const field of syncFields) {
          matchUnedited[field] = rule[field];
        }
        // Delete unmodified future expenses
        await prisma.expense.deleteMany({
          where: {
            recurrenceRuleId: expense.recurrenceRuleId,
            date: { gt: today },
            ...matchUnedited,
          },
        });
        // Unlink manually edited future expenses so they remain as standalone
        await prisma.expense.updateMany({
          where: {
            recurrenceRuleId: expense.recurrenceRuleId,
            date: { gt: today },
          },
          data: { recurrenceRuleId: null },
        });
      }
    }
  }

  await prisma.expense.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
