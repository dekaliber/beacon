import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const expenseRoutes = Router();

const expenseSchema = z.object({
  amount: z.number().positive(),
  description: z.string().min(1),
  date: z.string().transform((s) => new Date(s)),
  notes: z.string().optional(),
  categoryId: z.string(),
  accountId: z.string(),
});

// List expenses with filtering and pagination
expenseRoutes.get("/", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};

  if (req.query.categoryId) where.categoryId = req.query.categoryId;
  if (req.query.accountId) where.accountId = req.query.accountId;
  if (req.query.startDate || req.query.endDate) {
    where.date = {
      ...(req.query.startDate ? { gte: new Date(req.query.startDate as string) } : {}),
      ...(req.query.endDate ? { lte: new Date(req.query.endDate as string) } : {}),
    };
  }

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: { category: true, account: true },
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
    include: { category: true, account: true, recurrenceRule: true },
  });
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  res.json(expense);
});

// Create expense
expenseRoutes.post("/", async (req, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const expense = await prisma.expense.create({
    data: parsed.data,
    include: { category: true, account: true },
  });
  res.status(201).json(expense);
});

// Update expense
expenseRoutes.put("/:id", async (req, res) => {
  const parsed = expenseSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };
  if (typeof req.body.date === "string") {
    data.date = new Date(req.body.date);
  }

  const expense = await prisma.expense.update({
    where: { id: req.params.id },
    data,
    include: { category: true, account: true },
  });
  res.json(expense);
});

// Delete expense
expenseRoutes.delete("/:id", async (req, res) => {
  await prisma.expense.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
