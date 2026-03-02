import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const expenseRoutes = Router();

const EXPENSE_ALLOWED_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CREDIT_CARD", "CASH"];

const expenseSchema = z.object({
  amount: z.number().positive(),
  description: z.string().min(1),
  date: z.string().transform((s) => new Date(s)),
  notes: z.string().optional(),
  categoryId: z.string(),
  accountId: z.string(),
  isReimbursementExpected: z.boolean().optional(),
  reimbursementNote: z.string().nullable().optional(),
  tagIds: z.array(z.string()).optional(),
  transactionGroupId: z.string().nullable().optional(),
});

// List expenses with filtering and pagination
expenseRoutes.get("/", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};

  if (req.query.categoryId) where.categoryId = req.query.categoryId;
  if (req.query.accountId) where.accountId = req.query.accountId;
  if (req.query.isReimbursementExpected === "true") where.isReimbursementExpected = true;
  if (req.query.tagId) where.tags = { some: { tagId: req.query.tagId } };
  if (req.query.startDate || req.query.endDate) {
    where.date = {
      ...(req.query.startDate ? { gte: new Date(req.query.startDate as string) } : {}),
      ...(req.query.endDate ? { lte: new Date(req.query.endDate as string) } : {}),
    };
  }

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: {
        category: true,
        account: true,
        tags: { include: { tag: true } },
        transactionGroup: true,
      },
      orderBy: { date: "desc" },
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
    },
  });
  res.json(expense);
});

// Delete expense
expenseRoutes.delete("/:id", async (req, res) => {
  await prisma.expense.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
