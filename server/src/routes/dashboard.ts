import { Router } from "express";
import { prisma } from "../db/client.js";
import { getUserId } from "../middleware/auth.js";

export const dashboardRoutes = Router();

dashboardRoutes.get("/data-range", async (req, res) => {
  const userId = getUserId(req);
  const today = new Date();
  const [expenseMin, expenseMax, incomeMin, incomeMax] = await Promise.all([
    prisma.expense.findFirst({ where: { account: { userId }, parentExpenseId: null }, orderBy: { date: "asc" }, select: { date: true } }),
    prisma.expense.findFirst({ where: { account: { userId }, parentExpenseId: null, date: { lte: today } }, orderBy: { date: "desc" }, select: { date: true } }),
    prisma.income.findFirst({ where: { account: { userId } }, orderBy: { date: "asc" }, select: { date: true } }),
    prisma.income.findFirst({ where: { account: { userId }, date: { lte: today } }, orderBy: { date: "desc" }, select: { date: true } }),
  ]);

  const minDates = [expenseMin?.date, incomeMin?.date].filter(Boolean) as Date[];
  const maxDates = [expenseMax?.date, incomeMax?.date].filter(Boolean) as Date[];
  if (minDates.length === 0) {
    return res.json({ minYear: today.getUTCFullYear(), minMonth: today.getUTCMonth() + 1, maxYear: today.getUTCFullYear(), maxMonth: today.getUTCMonth() + 1 });
  }

  const min = new Date(Math.min(...minDates.map((d) => d.getTime())));
  const max = new Date(Math.max(...maxDates.map((d) => d.getTime())));

  res.json({
    minYear: min.getUTCFullYear(),
    minMonth: min.getUTCMonth() + 1,
    maxYear: max.getUTCFullYear(),
    maxMonth: max.getUTCMonth() + 1,
  });
});

/** Return the effective monthly budget amount for a given month/year using the
 *  AnnualBudget + MonthlyBudget hierarchy. */
async function getEffectiveMonthlyBudget(
  userId: string,
  type: "PERSONAL" | "JOINT",
  year: number,
  month: number,
): Promise<number | null> {
  const annual = await prisma.annualBudget.findUnique({
    where: { userId_type_year: { userId, type, year } },
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

// Category spend vs 12-month historical average
dashboardRoutes.get("/category-averages", async (req, res) => {
  const userId = getUserId(req);
  const now = new Date();
  const year  = parseInt(req.query.year  as string) || now.getUTCFullYear();
  const month = parseInt(req.query.month as string) || now.getUTCMonth() + 1;

  // Historical window: the 12 complete months ending before the current month
  const histStart = new Date(Date.UTC(year, month - 13, 1));
  const histEnd   = new Date(Date.UTC(year, month - 1, 0, 23, 59, 59, 999));

  // Current month window
  const curStart = new Date(Date.UTC(year, month - 1, 1));
  const curEnd   = new Date(Date.UTC(year, month,     0, 23, 59, 59, 999));

  const [accounts, ignoredCategories, settings] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { userId, ignoreInBudget: true }, select: { id: true } }),
    prisma.budgetSettings.findFirst({ where: { userId } }),
  ]);

  const personalIds        = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointIds           = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);
  const splitRatio         = settings ? Number(settings.jointSplitRatio) : 0.5;

  const expFilter = budgetExpenseFilter(ignoredCategoryIds);
  const sel = {
    amount:     true,
    categoryId: true,
    category: {
      select: {
        id: true, name: true, color: true, parentId: true,
        parent: { select: { id: true, name: true, color: true } },
      },
    },
  } as const;

  const [histP, histJ, curP, curJ] = await Promise.all([
    personalIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: personalIds }, date: { gte: histStart, lte: histEnd }, ...expFilter }, select: sel })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: jointIds },    date: { gte: histStart, lte: histEnd }, ...expFilter }, select: sel })
      : Promise.resolve([]),
    personalIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: personalIds }, date: { gte: curStart,  lte: curEnd  }, ...expFilter }, select: sel })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: jointIds },    date: { gte: curStart,  lte: curEnd  }, ...expFilter }, select: sel })
      : Promise.resolve([]),
  ]);

  type ExpRow = typeof histP[number];
  const categoryInfo = new Map<string, { name: string; color: string }>();
  const histAgg      = new Map<string, number>();
  const curAgg       = new Map<string, number>();

  function rollUp(rows: ExpRow[], scale: number, target: Map<string, number>) {
    for (const e of rows) {
      const cat      = e.category;
      const topId    = cat?.parent?.id    ?? cat?.id    ?? "__unknown__";
      const topName  = cat?.parent?.name  ?? cat?.name  ?? "Unknown";
      const topColor = cat?.parent?.color ?? cat?.color ?? "#6B7280";
      if (!categoryInfo.has(topId)) categoryInfo.set(topId, { name: topName, color: topColor });
      target.set(topId, (target.get(topId) ?? 0) + Number(e.amount) * scale);
    }
  }

  rollUp(histP, 1,          histAgg);
  rollUp(histJ, splitRatio, histAgg);
  rollUp(curP,  1,          curAgg);
  rollUp(curJ,  splitRatio, curAgg);

  const HIST_MONTHS = 12;
  const allKeys = new Set([...histAgg.keys(), ...curAgg.keys()]);

  const categories = Array.from(allKeys)
    .map((key) => {
      const info        = categoryInfo.get(key)!;
      const histTotal   = histAgg.get(key) ?? 0;
      const curAmount   = curAgg.get(key)  ?? 0;
      const avgAmount   = histTotal / HIST_MONTHS;
      const delta       = curAmount - avgAmount;
      const deltaPercent = avgAmount > 1 ? Math.round((delta / avgAmount) * 100) : null;
      return {
        categoryId:    key === "__unknown__" ? null : key,
        categoryName:  info.name,
        color:         info.color,
        currentAmount: Math.round(curAmount * 100) / 100,
        avgAmount:     Math.round(avgAmount * 100) / 100,
        delta:         Math.round(delta     * 100) / 100,
        deltaPercent,
      };
    })
    .filter((o) => o.avgAmount > 0 || o.currentAmount > 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 12);

  res.json({ categories });
});

// Day-by-day cumulative spend for the viewed month (spending velocity)
dashboardRoutes.get("/spending-velocity", async (req, res) => {
  const userId = getUserId(req);
  const now    = new Date();
  const year   = parseInt(req.query.year  as string) || now.getUTCFullYear();
  const month  = parseInt(req.query.month as string) || now.getUTCMonth() + 1;

  const startOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const endOfMonth   = new Date(Date.UTC(year, month,     0, 23, 59, 59, 999));
  const daysInMonth  = new Date(year, month, 0).getDate();

  // Use the client's local date (YYYY-MM-DD) to avoid UTC vs. local-time skew,
  // matching the pattern used by the category-outliers endpoint.
  const todayParam = req.query.today as string | undefined;
  const refDate    = todayParam ? new Date(`${todayParam}T00:00:00Z`) : now;
  const refYear    = refDate.getUTCFullYear();
  const refMonth   = refDate.getUTCMonth() + 1;
  const refDay     = refDate.getUTCDate();

  const [accounts, ignoredCategories, settings] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { userId, ignoreInBudget: true }, select: { id: true } }),
    prisma.budgetSettings.findFirst({ where: { userId } }),
  ]);

  const personalIds        = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointIds           = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);
  const splitRatio         = settings ? Number(settings.jointSplitRatio) : 0.5;
  const expFilter          = budgetExpenseFilter(ignoredCategoryIds);

  const [personalExpenses, jointExpenses, personalBudget, jointBudget] = await Promise.all([
    personalIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: personalIds }, date: { gte: startOfMonth, lte: endOfMonth }, ...expFilter }, select: { amount: true, date: true } })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: jointIds },    date: { gte: startOfMonth, lte: endOfMonth }, ...expFilter }, select: { amount: true, date: true } })
      : Promise.resolve([]),
    getEffectiveMonthlyBudget(userId, "PERSONAL", year, month),
    getEffectiveMonthlyBudget(userId, "JOINT",    year, month),
  ]);

  const totalBudget =
    personalBudget !== null || jointBudget !== null
      ? (personalBudget ?? 0) + (jointBudget ?? 0)
      : null;

  // Aggregate spend per day-of-month
  const daySpend = new Map<number, number>();
  for (const e of personalExpenses) {
    const d = e.date.getUTCDate();
    daySpend.set(d, (daySpend.get(d) ?? 0) + Number(e.amount));
  }
  for (const e of jointExpenses) {
    const d = e.date.getUTCDate();
    daySpend.set(d, (daySpend.get(d) ?? 0) + Number(e.amount) * splitRatio);
  }

  const isCurrentMonth = year === refYear && month === refMonth;
  const isFutureMonth  = year > refYear || (year === refYear && month > refMonth);
  const lastKnownDay   = isCurrentMonth ? refDay : isFutureMonth ? 0 : daysInMonth;

  const days: { day: number; spend: number | null; cumulative: number | null }[] = [];
  let cumulative = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (d <= lastKnownDay) {
      const spend = daySpend.get(d) ?? 0;
      cumulative += spend;
      days.push({ day: d, spend: Math.round(spend * 100) / 100, cumulative: Math.round(cumulative * 100) / 100 });
    } else {
      days.push({ day: d, spend: null, cumulative: null });
    }
  }

  res.json({ days, totalBudget, daysInMonth, lastKnownDay });
});

// Categories exceeding their historical monthly average, with the transactions driving the excess
dashboardRoutes.get("/outlier-transactions", async (req, res) => {
  const userId = getUserId(req);
  const now    = new Date();
  const year   = parseInt(req.query.year  as string) || now.getUTCFullYear();
  const month  = parseInt(req.query.month as string) || now.getUTCMonth() + 1;

  const [accounts, ignoredCategories, settings] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { userId, ignoreInBudget: true }, select: { id: true } }),
    prisma.budgetSettings.findFirst({ where: { userId } }),
  ]);

  const personalIds        = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointIds           = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);
  const splitRatio         = settings ? Number(settings.jointSplitRatio) : 0.5;
  const expFilter          = budgetExpenseFilter(ignoredCategoryIds);

  // Find earliest expense before this year to establish the historical baseline span.
  // The avg = sum(all prior years) / ((year - earliestYear) * 12).
  const earliest = await prisma.expense.findFirst({
    where: { account: { userId }, date: { lt: new Date(Date.UTC(year, 0, 1)) } },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  if (!earliest) return res.json({ categories: [] });

  const earliestYear = earliest.date.getUTCFullYear();
  const histMonths   = (year - earliestYear) * 12;
  if (histMonths <= 0) return res.json({ categories: [] });

  const histStart = new Date(Date.UTC(earliestYear, 0, 1));
  const histEnd   = new Date(Date.UTC(year, 0, 0, 23, 59, 59, 999)); // Dec 31 of year-1
  const curStart  = new Date(Date.UTC(year, month - 1, 1));
  const curEnd    = new Date(Date.UTC(year, month,     0, 23, 59, 59, 999));

  const catSel = {
    select: {
      id: true, name: true, color: true, parentId: true,
      parent: { select: { id: true, name: true, color: true } },
    },
  } as const;
  const histSel  = { amount: true, category: catSel } as const;
  const curSel   = { id: true, amount: true, date: true, description: true, vendor: true, category: catSel } as const;

  const [histP, histJ, curP, curJ] = await Promise.all([
    personalIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: personalIds }, date: { gte: histStart, lte: histEnd }, ...expFilter }, select: histSel })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: jointIds },    date: { gte: histStart, lte: histEnd }, ...expFilter }, select: histSel })
      : Promise.resolve([]),
    personalIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: personalIds }, date: { gte: curStart, lte: curEnd }, ...expFilter }, select: curSel })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: jointIds },    date: { gte: curStart, lte: curEnd }, ...expFilter }, select: curSel })
      : Promise.resolve([]),
  ]);

  type CatShape = { id: string; name: string; color: string | null; parentId: string | null; parent: { id: string; name: string; color: string | null } | null } | null;
  function topLevel(cat: CatShape) {
    return {
      topId:    cat?.parent?.id    ?? cat?.id    ?? "__unknown__",
      topName:  cat?.parent?.name  ?? cat?.name  ?? "Unknown",
      topColor: cat?.parent?.color ?? cat?.color ?? "#6B7280",
    };
  }

  // Accumulate historical totals by top-level category
  type CatInfo = { name: string; color: string };
  const catInfo   = new Map<string, CatInfo>();
  const histTotals = new Map<string, number>();

  for (const e of histP) {
    const { topId, topName, topColor } = topLevel(e.category);
    if (!catInfo.has(topId)) catInfo.set(topId, { name: topName, color: topColor });
    histTotals.set(topId, (histTotals.get(topId) ?? 0) + Number(e.amount));
  }
  for (const e of histJ) {
    const { topId, topName, topColor } = topLevel(e.category);
    if (!catInfo.has(topId)) catInfo.set(topId, { name: topName, color: topColor });
    histTotals.set(topId, (histTotals.get(topId) ?? 0) + Number(e.amount) * splitRatio);
  }

  // Accumulate current-month totals and collect transactions by top-level category
  const curTotals = new Map<string, number>();
  type TxnEntry = { id: string; description: string; vendor: string; date: string; effectiveAmount: number };
  const curTxns = new Map<string, TxnEntry[]>();

  function accumulateCurrent(e: typeof curP[number], scale: number) {
    const { topId, topName, topColor } = topLevel(e.category);
    if (!catInfo.has(topId)) catInfo.set(topId, { name: topName, color: topColor });
    const effective = Number(e.amount) * scale;
    curTotals.set(topId, (curTotals.get(topId) ?? 0) + effective);
    if (!curTxns.has(topId)) curTxns.set(topId, []);
    curTxns.get(topId)!.push({
      id:              e.id,
      description:     e.description,
      vendor:          e.vendor,
      date:            e.date.toISOString().slice(0, 10),
      effectiveAmount: effective,
    });
  }

  for (const e of curP) accumulateCurrent(e, 1);
  for (const e of curJ) accumulateCurrent(e, splitRatio);

  // Build outlier list: categories where current month > historical monthly avg
  const outliers: {
    categoryId: string | null;
    categoryName: string;
    categoryColor: string;
    currentMonthTotal: number;
    historicalAvgMonthly: number;
    excess: number;
    transactions: { id: string; description: string; vendor: string; date: string; amount: number }[];
  }[] = [];

  for (const [topId, histTotal] of histTotals) {
    const avgMonthly = histTotal / histMonths;
    const curTotal   = curTotals.get(topId) ?? 0;
    const excess     = curTotal - avgMonthly;
    if (excess <= 0) continue;

    // Greedy: take transactions sorted highest-to-lowest until their sum >= excess
    const sorted = (curTxns.get(topId) ?? []).sort((a, b) => b.effectiveAmount - a.effectiveAmount);
    let running = 0;
    const selected: TxnEntry[] = [];
    for (const t of sorted) {
      selected.push(t);
      running += t.effectiveAmount;
      if (running >= excess) break;
    }

    outliers.push({
      categoryId:           topId === "__unknown__" ? null : topId,
      categoryName:         catInfo.get(topId)!.name,
      categoryColor:        catInfo.get(topId)!.color,
      currentMonthTotal:    Math.round(curTotal   * 100) / 100,
      historicalAvgMonthly: Math.round(avgMonthly * 100) / 100,
      excess:               Math.round(excess     * 100) / 100,
      transactions: selected.map((t) => ({
        id:          t.id,
        description: t.description,
        vendor:      t.vendor,
        date:        t.date,
        amount:      Math.round(t.effectiveAmount * 100) / 100,
      })),
    });
  }

  outliers.sort((a, b) => b.excess - a.excess);

  res.json({ categories: outliers.slice(0, 5) });
});

// Spending by category over 13 months (spaghetti chart data)
dashboardRoutes.get("/category-trend", async (req, res) => {
  const userId = getUserId(req);
  const now = new Date();
  const year             = parseInt(req.query.year  as string) || now.getUTCFullYear();
  const month            = parseInt(req.query.month as string) || now.getUTCMonth() + 1;
  const parentCategoryId = req.query.parentCategoryId as string | undefined;

  // Window: Jan 1 through end of given month within the selected year
  const windowStart = new Date(Date.UTC(year, 0, 1));
  const windowEnd   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const [accounts, ignoredCategories, settings, allCats] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { userId, ignoreInBudget: true }, select: { id: true } }),
    prisma.budgetSettings.findFirst({ where: { userId } }),
    // Fetch all categories to determine which ones have children
    prisma.category.findMany({ where: { userId }, select: { id: true, parentId: true } }),
  ]);

  const personalAccountIds = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointAccountIds    = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);
  const splitRatio         = settings ? Number(settings.jointSplitRatio) : 0.5;

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

  // Build ordered month labels and keys: Jan through given month
  const monthLabels: string[] = [];
  const monthKeys: string[]   = [];
  for (let i = month - 1; i >= 0; i--) {
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
  const userId = getUserId(req);
  const now = new Date();
  const year = parseInt(req.query.year as string) || now.getUTCFullYear();
  const month = parseInt(req.query.month as string) || now.getUTCMonth() + 1;

  const startOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const endOfMonth = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  // ── Shared setup: accounts, ignored categories, split ratio ──────────────
  const [accounts, ignoredCategories, settings] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { userId, ignoreInBudget: true }, select: { id: true } }),
    prisma.budgetSettings.findFirst({ where: { userId } }),
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
    getEffectiveMonthlyBudget(userId, "PERSONAL", year, month),
    getEffectiveMonthlyBudget(userId, "JOINT", year, month),
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
      getEffectiveMonthlyBudget(userId, "PERSONAL", trendYear, trendMonth),
      getEffectiveMonthlyBudget(userId, "JOINT", trendYear, trendMonth),
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

  // ── Previous-month same-date MTD (for MoM comparison in summary card) ──────
  const isCurrentMonthReq = year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;
  const daysInCurMonth    = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const compareDay        = isCurrentMonthReq ? now.getUTCDate() : daysInCurMonth;
  const prevMonthYear2    = month === 1 ? year - 1 : year;
  const prevMonthNum2     = month === 1 ? 12 : month - 1;
  const daysInPrevMonth2  = new Date(prevMonthYear2, prevMonthNum2, 0).getDate();
  const prevCompareDay    = Math.min(compareDay, daysInPrevMonth2);

  const prevMtdStart = new Date(Date.UTC(prevMonthYear2, prevMonthNum2 - 1, 1));
  const prevMtdEnd   = new Date(Date.UTC(prevMonthYear2, prevMonthNum2 - 1, prevCompareDay, 23, 59, 59, 999));

  const [prevPMtd, prevJMtd] = await Promise.all([
    personalAccountIds.length > 0
      ? prisma.expense.aggregate({ where: { accountId: { in: personalAccountIds }, date: { gte: prevMtdStart, lte: prevMtdEnd }, ...budgetExpenseFilter(ignoredCategoryIds) }, _sum: { amount: true } })
      : Promise.resolve({ _sum: { amount: null as unknown } }),
    jointAccountIds.length > 0
      ? prisma.expense.aggregate({ where: { accountId: { in: jointAccountIds },    date: { gte: prevMtdStart, lte: prevMtdEnd }, ...budgetExpenseFilter(ignoredCategoryIds) }, _sum: { amount: true } })
      : Promise.resolve({ _sum: { amount: null as unknown } }),
  ]);

  const prevMonthMtd = Number(prevPMtd._sum.amount ?? 0) + Number(prevJMtd._sum.amount ?? 0) * splitRatio;

  // ── Category trend (13 months) ── see /category-trend route below ──────────

  // ── Recent expenses — completed only (no future-dated recurring instances) ──
  const recentTransactions = await prisma.expense.findMany({
    where: {
      account: { userId },
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
    personalSpent: Number(personalMonthSpend._sum.amount ?? 0),
    jointSpent: Number(jointMonthSpend._sum.amount ?? 0) * splitRatio,
    budget: totalBudget,
    personalBudget: personalMonthly,
    jointBudget: jointMonthly,
    prevMonthMtd,
    spendingByCategory,
    monthlyTrend,
    recentTransactions,
  });
});
