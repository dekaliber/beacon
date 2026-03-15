import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { computeNextOccurrence } from "./recurrence.js";

export const budgetRoutes = Router();

// ── Helpers ────────────────────────────────────────────────────────────────────

function isLeapYear(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInYear(year: number) {
  return isLeapYear(year) ? 366 : 365;
}

/** Days elapsed from Jan 1 of `year` through `date` (1-indexed). */
function daysElapsedInYear(year: number, date: Date): number {
  const jan1 = Date.UTC(year, 0, 1);
  return Math.floor((date.getTime() - jan1) / 86_400_000) + 1;
}

/** Clamp a date to [lo, hi]. */
function clamp(date: Date, lo: Date, hi: Date): Date {
  if (date < lo) return lo;
  if (date > hi) return hi;
  return date;
}

/** ISO date string (YYYY-MM-DD) for a UTC Date. */
function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve the effective monthly budget for all 12 months of the year.
 * Monthly overrides take precedence; the rest fall back to annualAmount / 12.
 */
function resolveMonthlyAmounts(
  annualAmount: number | null,
  overrides: { month: number; amount: number }[],
): { month: number; amount: number; isOverride: boolean }[] {
  const overrideMap = new Map(overrides.map((o) => [o.month, o.amount]));
  const defaultMonthly = annualAmount != null ? annualAmount / 12 : 0;
  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    if (overrideMap.has(month)) return { month, amount: overrideMap.get(month)!, isOverride: true };
    return { month, amount: defaultMonthly, isOverride: false };
  });
}

/**
 * Effective annual budget = sum of all 12 resolved monthly amounts.
 * When there are no overrides this equals annualAmount exactly.
 */
function effectiveAnnual(
  annualAmount: number | null,
  overrides: { month: number; amount: number }[],
): number {
  if (overrides.length === 0) return annualAmount ?? 0;
  return resolveMonthlyAmounts(annualAmount, overrides).reduce((s, m) => s + m.amount, 0);
}

/**
 * Build a Prisma expense filter fragment that excludes expenses that should be
 * ignored in budget calculations: transactions with `ignoreInBudget = true`,
 * and transactions whose category has `ignoreInBudget = true`.
 */
function ignoredExpenseFilter(ignoredCategoryIds: string[]): Record<string, unknown> {
  const filter: Record<string, unknown> = { ignoreInBudget: false };
  if (ignoredCategoryIds.length > 0) {
    // Include expenses with no category or a category that isn't ignored.
    // Using OR so that NULL categoryId is preserved (SQL NOT IN excludes NULLs).
    filter.OR = [
      { categoryId: null },
      { categoryId: { notIn: ignoredCategoryIds } },
    ];
  }
  return filter;
}

// ── Core normalization ─────────────────────────────────────────────────────────

/**
 * Compute budget metrics for a set of account IDs within a calendar year.
 *
 * Run-rate normalization separates expenses into two buckets:
 *
 *  RECURRING (linked via recurrenceRuleId):
 *    For each rule, an expected_annual cost is built from:
 *      actual YTD payments + already-materialized pending rows
 *      + additional projected occurrences (walked from rule.nextOccurrence,
 *        skipping dates that already have a pending row — mirrors the
 *        deduplication logic in generateUpcomingExpenses).
 *
 *    Per-occurrence projection:
 *      • ≥ 2 actual payments → compute rolling average.
 *        - If the last completed amount equals rule.amount → permanent change
 *          was applied to the rule → use rule.amount going forward.
 *        - If last completed != rule.amount → one-time deviation → use
 *          rolling average for a more stable projection.
 *      • < 2 payments → fall back to rule.amount.
 *
 *    The expected_annual is then time-normalized within the rule's effective
 *    active period (start/end dates clamped to the year), so mid-year-ending
 *    expenses don't appear "over budget" after their final payment.
 *
 *  DISCRETIONARY (no recurrenceRuleId):
 *    Actual YTD spend used as-is; projected linearly to year-end.
 *
 *  normalizedYTD = normalized recurring YTD + raw discretionary YTD
 *  projectedAnnual = sum of recurring expected_annuals + linear discretionary
 */
async function computeMetrics(
  year: number,
  accountIds: string[],
  today: Date,
  ignoredCategoryIds: string[] = [],
): Promise<{
  ytdCompletedMonths: number;   // actual spend in months prior to current month (display only)
  mtdTotal: number;             // actual spend in current month incl. pending (display only)
  normalizedYTD: number;        // timing-adjusted figure for the run-rate ratio
  projectedAnnual: number;      // expected full-year spend at current trajectory
}> {
  if (accountIds.length === 0) {
    return { ytdCompletedMonths: 0, mtdTotal: 0, normalizedYTD: 0, projectedAnnual: 0 };
  }

  const startOfYear  = new Date(Date.UTC(year, 0, 1));
  const endOfYear    = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const endOfMonth   = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  const elapsed      = daysElapsedInYear(year, today);
  const totalDays    = daysInYear(year);

  // ── 1. YTD completed months (display) ─────────────────────────────────────
  const completedRows = await prisma.expense.findMany({
    where: {
      accountId: { in: accountIds },
      date: { gte: startOfYear, lt: startOfMonth },
      ...ignoredExpenseFilter(ignoredCategoryIds),
    },
    select: { amount: true },
  });
  const ytdCompletedMonths = completedRows.reduce(
    (s, e) => s + Number(e.amount), 0,
  );

  // ── 2. MTD total including pending future-dated rows (display) ────────────
  const mtdRows = await prisma.expense.findMany({
    where: {
      accountId: { in: accountIds },
      date: { gte: startOfMonth, lte: endOfMonth },
      ...ignoredExpenseFilter(ignoredCategoryIds),
    },
    select: { amount: true },
  });
  const mtdTotal = mtdRows.reduce((s, e) => s + Number(e.amount), 0);

  // ── 3. Normalization ───────────────────────────────────────────────────────
  const rules = await prisma.recurrenceRule.findMany({
    where: {
      accountId: { in: accountIds },
      isActive: true,
      startDate: { lte: endOfYear },
      OR: [{ endDate: null }, { endDate: { gte: startOfYear } }],
    },
  });

  const ruleIds = rules.map((r) => r.id);

  const [ytdRecurring, futurePending] = await Promise.all([
    prisma.expense.findMany({
      where: {
        recurrenceRuleId: { in: ruleIds },
        date: { gte: startOfYear, lte: today },
        ...ignoredExpenseFilter(ignoredCategoryIds),
      },
      select: { recurrenceRuleId: true, amount: true, date: true },
      orderBy: { date: "desc" },
    }),
    prisma.expense.findMany({
      where: {
        recurrenceRuleId: { in: ruleIds },
        date: { gt: today, lte: endOfYear },
        ...ignoredExpenseFilter(ignoredCategoryIds),
      },
      select: { recurrenceRuleId: true, amount: true, date: true },
    }),
  ]);

  // Build per-rule lookup maps
  const ytdByRule     = new Map<string, typeof ytdRecurring>();
  const pendingByRule = new Map<string, typeof futurePending>();
  const pendingDates  = new Map<string, Set<string>>();

  for (const e of ytdRecurring) {
    if (!e.recurrenceRuleId) continue;
    if (!ytdByRule.has(e.recurrenceRuleId)) ytdByRule.set(e.recurrenceRuleId, []);
    ytdByRule.get(e.recurrenceRuleId)!.push(e);
  }
  for (const e of futurePending) {
    if (!e.recurrenceRuleId) continue;
    if (!pendingByRule.has(e.recurrenceRuleId)) pendingByRule.set(e.recurrenceRuleId, []);
    pendingByRule.get(e.recurrenceRuleId)!.push(e);
    if (!pendingDates.has(e.recurrenceRuleId)) pendingDates.set(e.recurrenceRuleId, new Set());
    pendingDates.get(e.recurrenceRuleId)!.add(toDateKey(e.date));
  }

  let normalizedRecurringYTD  = 0;
  let recurringExpectedAnnual = 0;

  for (const rule of rules) {
    // Skip rules whose category is ignored in budget calculations
    if (rule.categoryId && ignoredCategoryIds.includes(rule.categoryId)) continue;

    const ytdPayments     = ytdByRule.get(rule.id)     ?? [];
    const pendingPayments = pendingByRule.get(rule.id) ?? [];
    const pendingDateSet  = pendingDates.get(rule.id)  ?? new Set<string>();
    const ruleAmount      = Number(rule.amount);

    // ── Per-occurrence projection amount ──────────────────────────────────
    let projectedPerOccurrence = ruleAmount;

    if (ytdPayments.length >= 2) {
      const ytdSum     = ytdPayments.reduce((s, p) => s + Number(p.amount), 0);
      const rollingAvg = ytdSum / ytdPayments.length;

      // ytdPayments sorted DESC → index 0 is most recent completed payment.
      // Permanent vs. one-time detection: if the last completed payment matches
      // rule.amount, the rule is current and we project forward at rule.amount.
      // If it differs, this was a one-time edit; the rolling average is a more
      // accurate projection than extrapolating the anomaly forward.
      // Note: there is a brief window after a permanent change where the last
      // completed payment still shows the old amount (before the first payment
      // at the new rate posts). Self-corrects on next payment — acceptable.
      const lastCompleted = Number(ytdPayments[0].amount);
      if (Math.abs(lastCompleted - ruleAmount) < 0.01) {
        projectedPerOccurrence = ruleAmount;
      } else {
        projectedPerOccurrence = rollingAvg;
      }
    }

    // ── Effective active period within the year ───────────────────────────
    const effectiveStart = clamp(rule.startDate, startOfYear, endOfYear);
    const effectiveEnd   = rule.endDate
      ? clamp(rule.endDate, startOfYear, endOfYear)
      : endOfYear;
    const activeDays = Math.max(
      1,
      Math.floor((effectiveEnd.getTime() - effectiveStart.getTime()) / 86_400_000) + 1,
    );

    // ── Future occurrences not yet materialized as Expense rows ──────────
    // Walk from rule.nextOccurrence forward; skip dates already in the DB.
    // This mirrors the deduplication in generateUpcomingExpenses so we never
    // double-count a row that was pre-generated by the rolling-window logic.
    let additionalOccurrences = 0;
    let cur = new Date(rule.nextOccurrence);
    while (cur <= effectiveEnd) {
      if (cur > today && !pendingDateSet.has(toDateKey(cur))) {
        additionalOccurrences++;
      }
      cur = computeNextOccurrence(cur, rule.frequency, rule.interval);
    }

    // ── Expected annual and normalized YTD for this rule ─────────────────
    const ytdActual      = ytdPayments.reduce((s, p)    => s + Number(p.amount), 0);
    const pendingSum     = pendingPayments.reduce((s, p) => s + Number(p.amount), 0);
    const additionalProj = additionalOccurrences * projectedPerOccurrence;
    const expectedAnnual = ytdActual + pendingSum + additionalProj;
    recurringExpectedAnnual += expectedAnnual;

    // Normalize within active period rather than the full calendar year.
    // This prevents a rule that ends mid-year from appearing "over budget"
    // for the remainder of the year after its final payment posts.
    const daysElapsedInPeriod = Math.min(elapsed, activeDays);
    normalizedRecurringYTD += expectedAnnual * (daysElapsedInPeriod / activeDays);
  }

  // ── Discretionary (no recurrenceRuleId, completed only) ──────────────────
  const discretionaryRows = await prisma.expense.findMany({
    where: {
      accountId: { in: accountIds },
      recurrenceRuleId: null,
      date: { gte: startOfYear, lte: today },
      ...ignoredExpenseFilter(ignoredCategoryIds),
    },
    select: { amount: true },
  });
  const actualDiscretionaryYTD = discretionaryRows.reduce(
    (s, e) => s + Number(e.amount), 0,
  );

  const normalizedYTD = normalizedRecurringYTD + actualDiscretionaryYTD;

  const projectedDiscretionary =
    elapsed > 0 ? (actualDiscretionaryYTD / elapsed) * totalDays : 0;
  const projectedAnnual = recurringExpectedAnnual + projectedDiscretionary;

  return { ytdCompletedMonths, mtdTotal, normalizedYTD, projectedAnnual };
}

/**
 * Build daily cumulative spend for a given month, filtered to specific accounts.
 * Returns { day, cumulative }[] for every day 1–N in the month.
 * For historical months, includes all transactions; for the current month,
 * only includes transactions up to today (we never project within the chart).
 */
async function buildMonthlyComparison(
  year: number,
  month: number,
  accountIds: string[],
  ignoredCategoryIds: string[] = [],
): Promise<{ day: number; cumulative: number }[]> {
  if (accountIds.length === 0) return [];

  const startDate = new Date(Date.UTC(year, month - 1, 1));
  const endDate   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  const daysInMonth = endDate.getUTCDate();

  // For the current and future months cap at today so we don't show $0 days
  // beyond the present as part of the line.
  const now = new Date();
  const effectiveEnd = endDate < now ? endDate : now;

  const rows = await prisma.expense.findMany({
    where: {
      accountId: { in: accountIds },
      date: { gte: startDate, lte: effectiveEnd },
      ...ignoredExpenseFilter(ignoredCategoryIds),
    },
    select: { date: true, amount: true },
    orderBy: { date: "asc" },
  });

  const daily = new Array<number>(daysInMonth).fill(0);
  for (const row of rows) {
    const idx = row.date.getUTCDate() - 1;
    daily[idx] += Number(row.amount);
  }

  let cum = 0;
  return Array.from({ length: daysInMonth }, (_, i) => {
    cum += daily[i];
    return { day: i + 1, cumulative: Math.round(cum * 100) / 100 };
  });
}

/** Get or create the singleton BudgetSettings row. */
async function getOrCreateSettings() {
  const existing = await prisma.budgetSettings.findFirst();
  if (existing) return existing;
  return prisma.budgetSettings.create({ data: {} });
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/budgets/settings
budgetRoutes.get("/settings", async (_req, res) => {
  const settings = await getOrCreateSettings();
  res.json({ jointSplitRatio: Number(settings.jointSplitRatio) });
});

// PUT /api/budgets/settings
budgetRoutes.put("/settings", async (req, res) => {
  const schema = z.object({ jointSplitRatio: z.number().min(0).max(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await getOrCreateSettings();
  const updated = await prisma.budgetSettings.update({
    where: { id: settings.id },
    data: { jointSplitRatio: parsed.data.jointSplitRatio },
  });
  res.json({ jointSplitRatio: Number(updated.jointSplitRatio) });
});

// GET /api/budgets/:year  — full budget overview (Personal, Joint, Total panels)
budgetRoutes.get("/:year", async (req, res) => {
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: "Invalid year" });

  const today    = new Date();
  const elapsed  = daysElapsedInYear(year, today);
  const totalDays = daysInYear(year);
  const pctElapsed = totalDays > 0 ? elapsed / totalDays : 0;

  // Account IDs split by isJoint
  const [accounts, ignoredCategories] = await Promise.all([
    prisma.account.findMany({
      where: { isActive: true },
      select: { id: true, isJoint: true },
    }),
    prisma.category.findMany({
      where: { ignoreInBudget: true },
      select: { id: true },
    }),
  ]);
  const personalIds        = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointIds           = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);

  // Budget records and settings
  const [settings, annualBudgets] = await Promise.all([
    getOrCreateSettings(),
    prisma.annualBudget.findMany({
      where: { year },
      include: { monthlyOverrides: true },
    }),
  ]);

  const splitRatio     = Number(settings.jointSplitRatio);
  const personalBudget = annualBudgets.find((b) => b.type === "PERSONAL") ?? null;
  const jointBudget    = annualBudgets.find((b) => b.type === "JOINT")    ?? null;

  const personalAnnualRaw = personalBudget?.annualAmount != null ? Number(personalBudget.annualAmount) : null;
  const jointAnnualRaw    = jointBudget?.annualAmount    != null ? Number(jointBudget.annualAmount)    : null;

  const personalOverrides = (personalBudget?.monthlyOverrides ?? []).map((o) => ({
    month: o.month, amount: Number(o.amount),
  }));
  const jointOverrides = (jointBudget?.monthlyOverrides ?? []).map((o) => ({
    month: o.month, amount: Number(o.amount),
  }));

  const effPersonal = effectiveAnnual(personalAnnualRaw, personalOverrides);
  const effJoint    = effectiveAnnual(jointAnnualRaw,    jointOverrides);
  const effTotal    = effPersonal + effJoint * splitRatio;

  // Compute spend metrics for both account sets in parallel
  const [personalMetrics, jointMetrics] = await Promise.all([
    computeMetrics(year, personalIds, today, ignoredCategoryIds),
    computeMetrics(year, jointIds,    today, ignoredCategoryIds),
  ]);

  // Total metrics = personal + joint × splitRatio (applied per field)
  const totalMetrics = {
    ytdCompletedMonths: personalMetrics.ytdCompletedMonths + jointMetrics.ytdCompletedMonths * splitRatio,
    mtdTotal:           personalMetrics.mtdTotal           + jointMetrics.mtdTotal           * splitRatio,
    normalizedYTD:      personalMetrics.normalizedYTD      + jointMetrics.normalizedYTD      * splitRatio,
    projectedAnnual:    personalMetrics.projectedAnnual    + jointMetrics.projectedAnnual    * splitRatio,
  };

  /** Derive run-rate stats from raw metrics + the effective annual budget. */
  function panelStats(metrics: typeof personalMetrics, budget: number) {
    // percentAboveBelow: positive = over pace, negative = under pace
    //   = (normalizedYTD / budget) / (daysElapsed / daysInYear) - 1
    const percentAboveBelow =
      budget > 0 && pctElapsed > 0
        ? (metrics.normalizedYTD / budget) / pctElapsed - 1
        : 0;
    const remaining = budget - metrics.projectedAnnual;
    return {
      ytdCompletedMonths: Math.round(metrics.ytdCompletedMonths * 100) / 100,
      mtdTotal:           Math.round(metrics.mtdTotal           * 100) / 100,
      normalizedYTD:      Math.round(metrics.normalizedYTD      * 100) / 100,
      projectedAnnual:    Math.round(metrics.projectedAnnual    * 100) / 100,
      remaining:          Math.round(remaining                  * 100) / 100,
      percentAboveBelow:  Math.round(percentAboveBelow          * 10000) / 10000, // 4dp
    };
  }

  // Monthly comparison chart data (current, previous, same month last year)
  const now      = today;
  const curYear  = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;
  const prevMonth     = curMonth === 1 ? 12 : curMonth - 1;
  const prevMonthYear = curMonth === 1 ? curYear - 1 : curYear;

  async function buildChartForAccounts(ids: string[], ratio = 1) {
    const [current, previous, priorYear] = await Promise.all([
      buildMonthlyComparison(curYear,       curMonth,  ids, ignoredCategoryIds),
      buildMonthlyComparison(prevMonthYear, prevMonth, ids, ignoredCategoryIds),
      buildMonthlyComparison(curYear - 1,   curMonth,  ids, ignoredCategoryIds),
    ]);
    if (ratio === 1) return { current, previous, priorYear };
    const scale = (arr: { day: number; cumulative: number }[]) =>
      arr.map((d) => ({ ...d, cumulative: Math.round(d.cumulative * ratio * 100) / 100 }));
    return { current: scale(current), previous: scale(previous), priorYear: scale(priorYear) };
  }

  function mergeChartSeries(
    a: { day: number; cumulative: number }[],
    b: { day: number; cumulative: number }[],
  ) {
    const len = Math.max(a.length, b.length);
    return Array.from({ length: len }, (_, i) => ({
      day: i + 1,
      cumulative: Math.round(((a[i]?.cumulative ?? 0) + (b[i]?.cumulative ?? 0)) * 100) / 100,
    }));
  }

  const [personalChart, jointChart] = await Promise.all([
    buildChartForAccounts(personalIds, 1),
    buildChartForAccounts(jointIds, splitRatio),
  ]);

  const totalChart = {
    current:   mergeChartSeries(personalChart.current,   jointChart.current),
    previous:  mergeChartSeries(personalChart.previous,  jointChart.previous),
    priorYear: mergeChartSeries(personalChart.priorYear, jointChart.priorYear),
  };

  res.json({
    year,
    daysElapsed: elapsed,
    daysInYear: totalDays,
    pctElapsed: Math.round(pctElapsed * 10000) / 10000,
    settings: { jointSplitRatio: splitRatio },
    personal: {
      annualBudget: personalAnnualRaw,
      effectiveAnnualBudget: Math.round(effPersonal * 100) / 100,
      monthlyBudgets: resolveMonthlyAmounts(personalAnnualRaw, personalOverrides),
      ...panelStats(personalMetrics, effPersonal),
      chart: personalChart,
    },
    joint: {
      annualBudget: jointAnnualRaw,
      effectiveAnnualBudget: Math.round(effJoint * 100) / 100,
      monthlyBudgets: resolveMonthlyAmounts(jointAnnualRaw, jointOverrides),
      ...panelStats(jointMetrics, effJoint),
      chart: jointChart,
    },
    total: {
      annualBudget: null, // always derived: personal + joint × splitRatio
      effectiveAnnualBudget: Math.round(effTotal * 100) / 100,
      ...panelStats(totalMetrics, effTotal),
      chart: totalChart,
    },
  });
});

// PUT /api/budgets/:year/personal  |  PUT /api/budgets/:year/joint
// Set or update the annual budget for a budget type.
budgetRoutes.put("/:year/:type(personal|joint)", async (req, res) => {
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: "Invalid year" });

  const type   = (req.params as Record<string, string>).type.toUpperCase() as "PERSONAL" | "JOINT";
  const schema = z.object({ annualAmount: z.number().nonnegative() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const budget = await prisma.annualBudget.upsert({
    where:  { type_year: { type, year } },
    update: { annualAmount: parsed.data.annualAmount },
    create: { type, year, annualAmount: parsed.data.annualAmount },
    include: { monthlyOverrides: true },
  });

  res.json({
    id:          budget.id,
    type:        budget.type,
    year:        budget.year,
    annualAmount: Number(budget.annualAmount),
    monthlyOverrides: budget.monthlyOverrides.map((o) => ({
      id: o.id, month: o.month, amount: Number(o.amount),
    })),
  });
});

// PUT /api/budgets/:year/:type/monthly/:month  — add or update a monthly override
budgetRoutes.put("/:year/:type(personal|joint)/monthly/:month", async (req, res) => {
  const year  = parseInt(req.params.year);
  const month = parseInt(req.params.month);
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: "Invalid year or month" });
  }

  const type   = (req.params as Record<string, string>).type.toUpperCase() as "PERSONAL" | "JOINT";
  const schema = z.object({ amount: z.number().nonnegative() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Ensure the parent AnnualBudget exists (create with null annualAmount if not)
  const annualBudget = await prisma.annualBudget.upsert({
    where:  { type_year: { type, year } },
    update: {},
    create: { type, year, annualAmount: null },
  });

  const override = await prisma.monthlyBudget.upsert({
    where:  { annualBudgetId_month: { annualBudgetId: annualBudget.id, month } },
    update: { amount: parsed.data.amount },
    create: { annualBudgetId: annualBudget.id, month, amount: parsed.data.amount },
  });

  res.json({ id: override.id, month: override.month, amount: Number(override.amount) });
});

// DELETE /api/budgets/:year/:type/monthly/:month  — remove a monthly override
budgetRoutes.delete("/:year/:type(personal|joint)/monthly/:month", async (req, res) => {
  const year  = parseInt(req.params.year);
  const month = parseInt(req.params.month);
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: "Invalid year or month" });
  }

  const type         = (req.params as Record<string, string>).type.toUpperCase() as "PERSONAL" | "JOINT";
  const annualBudget = await prisma.annualBudget.findUnique({
    where: { type_year: { type, year } },
  });
  if (!annualBudget) return res.status(404).json({ error: "Budget not found" });

  await prisma.monthlyBudget.deleteMany({
    where: { annualBudgetId: annualBudget.id, month },
  });

  res.status(204).send();
});

// ── Legacy stubs ───────────────────────────────────────────────────────────────
// The old per-month Budget table has been removed.  These stubs prevent 404s
// from any callers that haven't been updated yet.
budgetRoutes.get("/", (_req, res) => res.json([]));
budgetRoutes.post("/", (_req, res) =>
  res.status(410).json({
    error: "Deprecated. Use PUT /api/budgets/:year/personal or /joint instead.",
  }),
);
