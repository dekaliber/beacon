import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const budgetRoutes = Router();

const budgetSchema = z.object({
  amount: z.number().positive(),
  month: z.number().min(1).max(12),
  year: z.number().min(2000).max(2100),
});

// List budgets
budgetRoutes.get("/", async (req, res) => {
  const year = req.query.year ? parseInt(req.query.year as string) : undefined;
  const where = year ? { year } : {};

  const budgets = await prisma.budget.findMany({
    where,
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });
  res.json(budgets);
});

// Get budget for a specific month
budgetRoutes.get("/:year/:month", async (req, res) => {
  const month = parseInt(req.params.month);
  const year = parseInt(req.params.year);

  const budget = await prisma.budget.findUnique({
    where: { month_year: { month, year } },
  });

  // Also get spending for this month
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);

  const spending = await prisma.expense.aggregate({
    where: { date: { gte: startDate, lte: endDate } },
    _sum: { amount: true },
  });

  // Get spending by category for drill-down
  const byCategory = await prisma.expense.groupBy({
    by: ["categoryId"],
    where: { date: { gte: startDate, lte: endDate } },
    _sum: { amount: true },
    _count: true,
    orderBy: { _sum: { amount: "desc" } },
  });

  // Resolve category names
  const categoryIds = byCategory.map((c) => c.categoryId).filter((id): id is string => id !== null);
  const categories = await prisma.category.findMany({
    where: { id: { in: categoryIds } },
    include: { parent: true },
  });
  type CategoryWithParent = typeof categories[0];
  const categoryMap = new Map<string, CategoryWithParent>(categories.map((c) => [c.id, c]));

  const categoryBreakdown = byCategory.map((item) => {
    const cat = item.categoryId ? categoryMap.get(item.categoryId) : undefined;
    return {
      categoryId: item.categoryId,
      categoryName: cat?.name ?? "Unknown",
      parentCategoryName: cat?.parent?.name ?? null,
      color: cat?.color ?? cat?.parent?.color ?? "#6B7280",
      total: item._sum.amount,
      count: item._count,
    };
  });

  res.json({
    budget,
    totalSpent: spending._sum.amount ?? 0,
    categoryBreakdown,
  });
});

// Create or update budget
budgetRoutes.post("/", async (req, res) => {
  const parsed = budgetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const budget = await prisma.budget.upsert({
    where: { month_year: { month: parsed.data.month, year: parsed.data.year } },
    update: { amount: parsed.data.amount },
    create: parsed.data,
  });
  res.json(budget);
});

// Delete budget
budgetRoutes.delete("/:id", async (req, res) => {
  await prisma.budget.delete({ where: { id: req.params.id } });
  res.status(204).send();
});
