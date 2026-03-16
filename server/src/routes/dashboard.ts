import { Router } from "express";
import { prisma } from "../db/client.js";

export const dashboardRoutes = Router();

/** Return the effective monthly budget amount for a given month/year using the
 *  new AnnualBudget + MonthlyBudget hierarchy. */
async function getEffectiveMonthlyBudget(
  type: "PERSONAL" | "JOINT",
  year: number,
  month: number,
): Promise<number | null> {
  const annual = await prisma.annualBudget.findUnique({
    where: { type_year: { type, year } },
    include: { monthlyOverrides: { where: { month } } },
  });
  if (!annual) return null;
  if (annual.monthlyOverrides.length > 0) {
    return Number(annual.monthlyOverrides[0].amount);
  }
  if (annual.annualAmount !== null) {
    return Number(annual.annualAmount) / 12;
  }
  return null;
}

// Main dashboard data
dashboardRoutes.get("/", async (req, res) => {
  const now = new Date();
  const year = parseInt(req.query.year as string) || now.getFullYear();
  const month = parseInt(req.query.month as string) || now.getMonth() + 1;

  const startOfMonth = new Date(year, month - 1, 1);
  const endOfMonth = new Date(year, month, 0, 23, 59, 59);

  // Current month spending
  const monthSpending = await prisma.expense.aggregate({
    where: { date: { gte: startOfMonth, lte: endOfMonth } },
    _sum: { amount: true },
    _count: true,
  });

  // Budget for current month (Personal + Joint × splitRatio → Total)
  const settings = await prisma.budgetSettings.findFirst();
  const splitRatio = settings ? Number(settings.jointSplitRatio) : 0.5;

  const [personalMonthly, jointMonthly] = await Promise.all([
    getEffectiveMonthlyBudget("PERSONAL", year, month),
    getEffectiveMonthlyBudget("JOINT", year, month),
  ]);

  let totalBudget: number | null = null;
  if (personalMonthly !== null || jointMonthly !== null) {
    totalBudget = (personalMonthly ?? 0) + (jointMonthly ?? 0) * splitRatio;
  }

  // Spending by category (for pie chart)
  const byCategory = await prisma.expense.groupBy({
    by: ["categoryId"],
    where: { date: { gte: startOfMonth, lte: endOfMonth } },
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
  });

  const categoryIds = byCategory.map((c) => c.categoryId).filter((id): id is string => id !== null);
  const categories = await prisma.category.findMany({
    where: { id: { in: categoryIds } },
    include: { parent: true },
  });
  type CategoryWithParent = typeof categories[0];
  const categoryMap = new Map<string, CategoryWithParent>(categories.map((c) => [c.id, c]));

  const spendingByCategory = byCategory.map((item) => {
    const cat = item.categoryId ? categoryMap.get(item.categoryId) : undefined;
    return {
      categoryId: item.categoryId,
      name: cat?.parent ? `${cat.parent.name} > ${cat.name}` : cat?.name ?? "Unknown",
      shortName: cat?.name ?? "Unknown",
      color: cat?.color ?? cat?.parent?.color ?? "#6B7280",
      amount: item._sum.amount,
    };
  });

  // Monthly trend (last 6 months)
  const monthlyTrend = [];
  for (let i = 5; i >= 0; i--) {
    const trendDate = new Date(year, month - 1 - i, 1);
    const trendEnd = new Date(trendDate.getFullYear(), trendDate.getMonth() + 1, 0, 23, 59, 59);
    const trendMonth = trendDate.getMonth() + 1;
    const trendYear = trendDate.getFullYear();

    const spending = await prisma.expense.aggregate({
      where: { date: { gte: trendDate, lte: trendEnd } },
      _sum: { amount: true },
    });

    const [trendPersonal, trendJoint] = await Promise.all([
      getEffectiveMonthlyBudget("PERSONAL", trendYear, trendMonth),
      getEffectiveMonthlyBudget("JOINT", trendYear, trendMonth),
    ]);

    let trendBudget: number | null = null;
    if (trendPersonal !== null || trendJoint !== null) {
      trendBudget = (trendPersonal ?? 0) + (trendJoint ?? 0) * splitRatio;
    }

    monthlyTrend.push({
      month: trendMonth,
      year: trendYear,
      label: trendDate.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      spent: spending._sum.amount ?? 0,
      budget: trendBudget,
    });
  }

  // Recent transactions
  const recentTransactions = await prisma.expense.findMany({
    include: { category: true, account: true },
    orderBy: { date: "desc" },
    take: 10,
  });

  // Upcoming recurring expenses (next 30 days)
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  const upcomingRecurring = await prisma.recurrenceRule.findMany({
    where: {
      isActive: true,
      nextOccurrence: { lte: thirtyDaysFromNow },
    },
    orderBy: { nextOccurrence: "asc" },
    take: 5,
  });

  res.json({
    currentMonth: { month, year },
    totalSpent: monthSpending._sum.amount ?? 0,
    transactionCount: monthSpending._count,
    budget: totalBudget,
    spendingByCategory,
    monthlyTrend,
    recentTransactions,
    upcomingRecurring,
  });
});
