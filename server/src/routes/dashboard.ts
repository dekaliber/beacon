import { Router } from "express";
import { prisma } from "../db/client.js";

export const dashboardRoutes = Router();

/** Return the effective monthly budget amount for a given month/year using the
 *  AnnualBudget + MonthlyBudget hierarchy. */
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

/**
 * Build a Prisma expense `where` fragment that excludes budget-ignored expenses:
 * rows with ignoreInBudget=true and rows whose category has ignoreInBudget=true.
 */
function budgetExpenseFilter(ignoredCategoryIds: string[]): Record<string, unknown> {
  const filter: Record<string, unknown> = { ignoreInBudget: false };
  if (ignoredCategoryIds.length > 0) {
    filter.OR = [
      { categoryId: null },
      { categoryId: { notIn: ignoredCategoryIds } },
    ];
  }
  return filter;
}

// Spending by category over 13 months (spaghetti chart data)
dashboardRoutes.get("/category-trend", async (req, res) => {
  const now = new Date();
  const year             = parseInt(req.query.year  as string) || now.getFullYear();
  const month            = parseInt(req.query.month as string) || now.getMonth() + 1;
  const parentCategoryId = req.query.parentCategoryId as string | undefined;

  // Window: 13 months ending with the given month
  const windowStart = new Date(Date.UTC(year, month - 13, 1));
  const windowEnd   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const [accounts, ignoredCategories, settings, allCats] = await Promise.all([
    prisma.account.findMany({ where: { isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { ignoreInBudget: true }, select: { id: true } }),
    prisma.budgetSettings.findFirst(),
    // Fetch all categories to determine which ones have children
    prisma.category.findMany({ select: { id: true, parentId: true } }),
  ]);

  const personalAccountIds = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointAccountIds    = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);
  const splitRatio         = settings ? Number(settings.jointSplitRatio) : 0.5;

  // Set of category IDs that have at least one child category
  const categoryIdsWithChildren = new Set(
    allCats.filter((c) => c.parentId !== null).map((c) => c.parentId!)
  );

  const expenseFilter = {
    date: { gte: windowStart, lte: windowEnd },
    ...budgetExpenseFilter(ignoredCategoryIds),
  };

  // Fetch all expenses in window (personal + joint) in two queries
  const [personalExpenses, jointExpenses] = await Promise.all([
    prisma.expense.findMany({
      where: { accountId: { in: personalAccountIds }, ...expenseFilter },
      select: { amount: true, date: true, categoryId: true },
    }),
    prisma.expense.findMany({
      where: { accountId: { in: jointAccountIds }, ...expenseFilter },
      select: { amount: true, date: true, categoryId: true },
    }),
  ]);

  // Resolve categories (with parent info for roll-up)
  const rawCategoryIds = [
    ...new Set([
      ...personalExpenses.map((e) => e.categoryId),
      ...jointExpenses.map((e) => e.categoryId),
    ]),
  ].filter((id): id is string => id !== null);

  const categories = await prisma.category.findMany({
    where: { id: { in: rawCategoryIds } },
    include: { parent: true },
  });
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  // Build ordered 13-month labels and keys
  const monthLabels: string[] = [];
  const monthKeys: string[]   = [];
  for (let i = 12; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    monthLabels.push(d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }));
    monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }

  // Aggregate spending: key = "groupId::YYYY-MM"
  const agg      = new Map<string, number>();
  const groupInfo = new Map<string, { name: string; color: string }>();

  function accumulateExpense(
    expense: { amount: unknown; date: Date; categoryId: string | null },
    scale: number,
  ) {
    const cat = expense.categoryId ? categoryMap.get(expense.categoryId) : undefined;

    let groupId: string;
    let groupName: string;
    let groupColor: string;

    if (parentCategoryId) {
      // Drill-down mode: only include expenses whose category is a direct child of
      // parentCategoryId, or expenses assigned directly to parentCategoryId itself.
      const isDirectChild = cat?.parentId === parentCategoryId;
      const isParent      = cat?.id       === parentCategoryId;
      if (!cat || (!isDirectChild && !isParent)) return;
      groupId    = cat.id;
      groupName  = cat.name;
      groupColor = cat.color ?? "#6B7280";
    } else {
      // Top-level mode: roll each expense up to its root category
      groupId    = cat?.parent?.id    ?? cat?.id    ?? "__unknown__";
      groupName  = cat?.parent?.name  ?? cat?.name  ?? "Unknown";
      groupColor = cat?.parent?.color ?? cat?.color ?? "#6B7280";
    }

    if (!groupInfo.has(groupId)) groupInfo.set(groupId, { name: groupName, color: groupColor });
    const d  = expense.date;
    const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const key = `${groupId}::${mk}`;
    agg.set(key, (agg.get(key) ?? 0) + Number(expense.amount) * scale);
  }

  for (const e of personalExpenses) accumulateExpense(e, 1);
  for (const e of jointExpenses)    accumulateExpense(e, splitRatio);

  // Build series sorted by total spend descending
  const series = [...groupInfo.entries()]
    .map(([categoryId, info]) => ({
      categoryId,
      name:        info.name,
      color:       info.color,
      hasChildren: categoryIdsWithChildren.has(categoryId),
      values:      monthKeys.map((mk) => agg.get(`${categoryId}::${mk}`) ?? 0),
    }))
    .sort((a, b) => b.values.reduce((s, v) => s + v, 0) - a.values.reduce((s, v) => s + v, 0));

  res.json({ months: monthLabels, series });
});

// Main dashboard data
dashboardRoutes.get("/", async (req, res) => {
  const now = new Date();
  const year = parseInt(req.query.year as string) || now.getFullYear();
  const month = parseInt(req.query.month as string) || now.getMonth() + 1;

  const startOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const endOfMonth = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  // ── Shared setup: accounts, ignored categories, split ratio ──────────────
  const [accounts, ignoredCategories, settings] = await Promise.all([
    prisma.account.findMany({ where: { isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { ignoreInBudget: true }, select: { id: true } }),
    prisma.budgetSettings.findFirst(),
  ]);

  const personalAccountIds  = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointAccountIds     = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds  = ignoredCategories.map((c) => c.id);
  const splitRatio          = settings ? Number(settings.jointSplitRatio) : 0.5;

  // ── MTD spend: personal (full) + joint (× splitRatio), budget-eligible only ──
  // Mirrors the Budgets page's totalMetrics.mtdTotal calculation.
  // Note: joint budget is entered as the user's intended share, so splitRatio
  // is applied to joint *spending* but NOT to the budget amount (see below).
  const [personalMonthSpend, jointMonthSpend] = await Promise.all([
    prisma.expense.aggregate({
      where: {
        accountId: { in: personalAccountIds },
        date: { gte: startOfMonth, lte: endOfMonth },
        ...budgetExpenseFilter(ignoredCategoryIds),
      },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: {
        accountId: { in: jointAccountIds },
        date: { gte: startOfMonth, lte: endOfMonth },
        ...budgetExpenseFilter(ignoredCategoryIds),
      },
      _sum: { amount: true },
    }),
  ]);

  const totalSpent =
    Number(personalMonthSpend._sum.amount ?? 0) +
    Number(jointMonthSpend._sum.amount ?? 0) * splitRatio;

  // ── Monthly budget: personal + joint (NO splitRatio applied) ────────────
  // The joint budget entered by the user is already their intended share.
  // splitRatio is applied only to raw spend figures (see budgets.ts line 440-444).
  const [personalMonthly, jointMonthly] = await Promise.all([
    getEffectiveMonthlyBudget("PERSONAL", year, month),
    getEffectiveMonthlyBudget("JOINT", year, month),
  ]);

  let totalBudget: number | null = null;
  if (personalMonthly !== null || jointMonthly !== null) {
    totalBudget = (personalMonthly ?? 0) + (jointMonthly ?? 0);
  }

  // ── Spending by category — aggregate by TOP-LEVEL parent, budget-eligible ──
  // Queries personal and joint separately so joint amounts can be scaled by
  // splitRatio before rollup, consistent with MTD spend and the trend chart.
  const categoryFilter = {
    date: { gte: startOfMonth, lte: endOfMonth },
    ...budgetExpenseFilter(ignoredCategoryIds),
  };
  const [byCategoryPersonal, byCategoryJoint] = await Promise.all([
    prisma.expense.groupBy({
      by: ["categoryId"],
      where: { accountId: { in: personalAccountIds }, ...categoryFilter },
      _sum: { amount: true },
    }),
    prisma.expense.groupBy({
      by: ["categoryId"],
      where: { accountId: { in: jointAccountIds }, ...categoryFilter },
      _sum: { amount: true },
    }),
  ]);

  const categoryIds = [
    ...new Set([
      ...byCategoryPersonal.map((c) => c.categoryId),
      ...byCategoryJoint.map((c) => c.categoryId),
    ]),
  ].filter((id): id is string => id !== null);

  const categories = await prisma.category.findMany({
    where: { id: { in: categoryIds } },
    include: { parent: true },
  });
  type CategoryWithParent = typeof categories[0];
  const categoryMap = new Map<string, CategoryWithParent>(categories.map((c) => [c.id, c]));

  // Roll up subcategory amounts to their parent, applying splitRatio to joint
  const parentAgg = new Map<string, { name: string; color: string; amount: number }>();

  function rollUpCategory(item: { categoryId: string | null; _sum: { amount: unknown } }, scale: number) {
    const cat = item.categoryId ? categoryMap.get(item.categoryId) : undefined;
    const amount = Number(item._sum.amount ?? 0) * scale;
    const topId    = cat?.parent?.id    ?? cat?.id    ?? "__unknown__";
    const topName  = cat?.parent?.name  ?? cat?.name  ?? "Unknown";
    const topColor = cat?.parent?.color ?? cat?.color ?? "#6B7280";
    const existing = parentAgg.get(topId);
    if (existing) {
      existing.amount += amount;
    } else {
      parentAgg.set(topId, { name: topName, color: topColor, amount });
    }
  }

  for (const item of byCategoryPersonal) rollUpCategory(item, 1);
  for (const item of byCategoryJoint)    rollUpCategory(item, splitRatio);

  const spendingByCategory = [...parentAgg.entries()]
    .map(([categoryId, data]) => ({
      categoryId,
      name: data.name,
      shortName: data.name,
      color: data.color,
      amount: data.amount,
    }))
    .filter((c) => c.amount > 0)   // exclude net-credit categories (refunds > purchases)
    .sort((a, b) => b.amount - a.amount);

  // ── Monthly trend (last 6 months): personal + joint×ratio, budget-eligible ─
  const monthlyTrend = [];
  for (let i = 5; i >= 0; i--) {
    const trendDate  = new Date(Date.UTC(year, month - 1 - i, 1));
    const trendEnd   = new Date(Date.UTC(trendDate.getUTCFullYear(), trendDate.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    const trendMonth = trendDate.getUTCMonth() + 1;
    const trendYear  = trendDate.getUTCFullYear();

    const [pSpend, jSpend, trendPersonal, trendJoint] = await Promise.all([
      prisma.expense.aggregate({
        where: {
          accountId: { in: personalAccountIds },
          date: { gte: trendDate, lte: trendEnd },
          ...budgetExpenseFilter(ignoredCategoryIds),
        },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: {
          accountId: { in: jointAccountIds },
          date: { gte: trendDate, lte: trendEnd },
          ...budgetExpenseFilter(ignoredCategoryIds),
        },
        _sum: { amount: true },
      }),
      getEffectiveMonthlyBudget("PERSONAL", trendYear, trendMonth),
      getEffectiveMonthlyBudget("JOINT", trendYear, trendMonth),
    ]);

    // Budget: personal + joint (no ratio — joint budget is already user's share)
    let trendBudget: number | null = null;
    if (trendPersonal !== null || trendJoint !== null) {
      trendBudget = (trendPersonal ?? 0) + (trendJoint ?? 0);
    }

    monthlyTrend.push({
      month: trendMonth,
      year: trendYear,
      label: trendDate.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" }),
      // Joint is scaled to the user's share so it's comparable to the budget line.
      // Floor at 0: a net-credit month (refunds > purchases) should show as $0,
      // not a negative bar that inverts the stacked chart.
      personalSpent: Math.max(0, Number(pSpend._sum.amount ?? 0)),
      jointSpent:    Math.max(0, Number(jSpend._sum.amount ?? 0) * splitRatio),
      budget: trendBudget,
    });
  }

  // ── Category trend (13 months) ── see /category-trend route below ──────────

  // ── Recent expenses — completed only (no future-dated recurring instances) ──
  const recentTransactions = await prisma.expense.findMany({
    where: {
      parentExpenseId: null,          // exclude offset children
      date: { lte: new Date() },      // completed only — excludes future recurring instances
    },
    include: { category: true, account: true },
    orderBy: { date: "desc" },
    take: 10,
  });

  res.json({
    currentMonth: { month, year },
    totalSpent,
    budget: totalBudget,
    spendingByCategory,
    monthlyTrend,
    recentTransactions,
  });
});
