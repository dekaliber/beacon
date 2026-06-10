import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { computeNextOccurrence } from "./recurrence.js";
import { getUserId } from "../middleware/auth.js";

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
  mtdActual: number;            // already-occurred MTD spend (date ≤ today) (display only)
  mtdFuture: number;            // known future MTD spend (date > today, within month) (display only)
  normalizedYTD: number;        // timing-adjusted figure for the run-rate ratio
  projectedAnnual: number;      // expected full-year spend at current trajectory
  recurringExpectedAnnual: number; // total known recurring costs for the full year
  actualDiscretionaryYTD: number;  // discretionary (non-recurring) spend so far
}> {
  if (accountIds.length === 0) {
    return { ytdCompletedMonths: 0, mtdTotal: 0, mtdActual: 0, mtdFuture: 0, normalizedYTD: 0, projectedAnnual: 0, recurringExpectedAnnual: 0, actualDiscretionaryYTD: 0 };
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
    select: { amount: true, date: true },
  });
  // Split into already-occurred (≤ today) vs known-future (> today) for display.
  const mtdActual = mtdRows.filter(e => e.date <= today).reduce((s, e) => s + Number(e.amount), 0);
  const mtdFuture = mtdRows.filter(e => e.date > today).reduce((s, e) => s + Number(e.amount), 0);
  const mtdTotal  = mtdActual + mtdFuture;

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
    //
    // Use days elapsed since the rule's own effectiveStart (not since Jan 1) so
    // that mid-year-starting rules aren't inflated. For rules that started
    // before this year, effectiveStart is already clamped to Jan 1 so the
    // result equals the overall `elapsed` value as expected.
    const ruleElapsedMs = today.getTime() >= effectiveStart.getTime()
      ? Math.min(today.getTime(), effectiveEnd.getTime()) - effectiveStart.getTime()
      : -1;
    const daysElapsedInPeriod = ruleElapsedMs < 0
      ? 0
      : Math.min(Math.floor(ruleElapsedMs / 86_400_000) + 1, activeDays);
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

  return { ytdCompletedMonths, mtdTotal, mtdActual, mtdFuture, normalizedYTD, projectedAnnual, recurringExpectedAnnual, actualDiscretionaryYTD };
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

/** Get or create the per-user BudgetSettings row. */
async function getOrCreateSettings(userId: string) {
  const existing = await prisma.budgetSettings.findFirst({ where: { userId } });
  if (existing) return existing;
  return prisma.budgetSettings.create({ data: { userId } });
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// GET /api/budgets/settings
budgetRoutes.get("/settings", async (req, res) => {
  const userId = getUserId(req);
  const settings = await getOrCreateSettings(userId);
  res.json({ jointSplitRatio: Number(settings.jointSplitRatio) });
});

// PUT /api/budgets/settings
budgetRoutes.put("/settings", async (req, res) => {
  const userId = getUserId(req);
  const schema = z.object({ jointSplitRatio: z.number().min(0).max(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await getOrCreateSettings(userId);
  const updated = await prisma.budgetSettings.update({
    where: { id: settings.id },
    data: { jointSplitRatio: parsed.data.jointSplitRatio },
  });
  res.json({ jointSplitRatio: Number(updated.jointSplitRatio) });
});

// GET /api/budgets/:year  — full budget overview (Personal, Joint, Total panels)
budgetRoutes.get("/:year", async (req, res) => {
  const userId = getUserId(req);
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: "Invalid year" });

  // Prefer the client's local date (YYYY-MM-DD) to avoid UTC vs. local-time skew.
  const todayParam = req.query.today as string | undefined;
  const today = todayParam ? new Date(`${todayParam}T00:00:00Z`) : new Date();
  // Clamp the reference point to within the requested year so historical and
  // future-year queries stay fully contained in that year.
  const effectiveToday =
    year < today.getUTCFullYear()
      ? new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)) // Dec 31 EOD of past year
      : year > today.getUTCFullYear()
        ? new Date(Date.UTC(year, 0, 1))                  // Jan 1 of future year
        : today;

  const elapsed  = daysElapsedInYear(year, effectiveToday);
  const totalDays = daysInYear(year);
  const pctElapsed = totalDays > 0 ? elapsed / totalDays : 0;

  // Account IDs split by isJoint
  const [accounts, ignoredCategories] = await Promise.all([
    prisma.account.findMany({
      where: { userId, isActive: true },
      select: { id: true, isJoint: true },
    }),
    prisma.category.findMany({
      where: { userId, ignoreInBudget: true },
      select: { id: true },
    }),
  ]);
  const personalIds        = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointIds           = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);

  // Budget records and settings
  const [settings, annualBudgets] = await Promise.all([
    getOrCreateSettings(userId),
    prisma.annualBudget.findMany({
      where: { userId, year },
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
  // The joint budget the user enters is already their intended share (e.g. they
  // set $24 000 meaning "I want to spend at most $24 000 on my half of joint
  // expenses"). splitRatio is applied only to the raw spend figures so the
  // dollar amounts displayed match what the user is actually responsible for.
  const effTotal    = effPersonal + effJoint;

  // Compute spend metrics for both account sets in parallel
  const [personalMetrics, jointMetrics] = await Promise.all([
    computeMetrics(year, personalIds, effectiveToday, ignoredCategoryIds),
    computeMetrics(year, jointIds,    effectiveToday, ignoredCategoryIds),
  ]);

  // Scale joint metrics to the user's share before building the joint panel
  // and rolling into total. This keeps the joint panel self-consistent at the
  // user's split fraction rather than showing the full joint pool.
  const scaledJoint = {
    ytdCompletedMonths:      jointMetrics.ytdCompletedMonths      * splitRatio,
    mtdTotal:                jointMetrics.mtdTotal                * splitRatio,
    mtdActual:               jointMetrics.mtdActual               * splitRatio,
    mtdFuture:               jointMetrics.mtdFuture               * splitRatio,
    normalizedYTD:           jointMetrics.normalizedYTD           * splitRatio,
    projectedAnnual:         jointMetrics.projectedAnnual         * splitRatio,
    recurringExpectedAnnual: jointMetrics.recurringExpectedAnnual * splitRatio,
    actualDiscretionaryYTD:  jointMetrics.actualDiscretionaryYTD  * splitRatio,
  };

  // Total = personal + already-scaled joint (no further multiplier)
  const totalMetrics = {
    ytdCompletedMonths:      personalMetrics.ytdCompletedMonths      + scaledJoint.ytdCompletedMonths,
    mtdTotal:                personalMetrics.mtdTotal                + scaledJoint.mtdTotal,
    mtdActual:               personalMetrics.mtdActual               + scaledJoint.mtdActual,
    mtdFuture:               personalMetrics.mtdFuture               + scaledJoint.mtdFuture,
    normalizedYTD:           personalMetrics.normalizedYTD           + scaledJoint.normalizedYTD,
    projectedAnnual:         personalMetrics.projectedAnnual         + scaledJoint.projectedAnnual,
    recurringExpectedAnnual: personalMetrics.recurringExpectedAnnual + scaledJoint.recurringExpectedAnnual,
    actualDiscretionaryYTD:  personalMetrics.actualDiscretionaryYTD  + scaledJoint.actualDiscretionaryYTD,
  };

  /** Derive run-rate stats from raw metrics + the effective annual budget. */
  function panelStats(metrics: typeof personalMetrics, budget: number) {
    // percentAboveBelow: positive = over budget, negative = under budget
    //   = projectedAnnual / budget - 1
    // Using the projection rather than a pace ratio (normalizedYTD / pctElapsed)
    // ensures partial-year recurring rules are handled correctly: rules with known
    // end dates contribute only their actual expected annual cost, not an
    // extrapolated rate as if they ran all year.
    const percentAboveBelow =
      budget > 0
        ? metrics.projectedAnnual / budget - 1
        : 0;
    // Remaining (discretionary) = budget minus all known recurring costs for
    // the year minus discretionary spend that has already happened.  This tells
    // the user how much they can still freely spend.
    const remaining = budget - metrics.recurringExpectedAnnual - metrics.actualDiscretionaryYTD;
    // Remaining (full) = budget minus everything actually spent so far
    // (completed months + MTD).  Dividing by months remaining gives the user a
    // concrete total-spend cap per future month, including upcoming recurring.
    const totalActualSpend = metrics.ytdCompletedMonths + metrics.mtdTotal;
    const remainingFull = budget - totalActualSpend;
    return {
      ytdCompletedMonths: Math.round(metrics.ytdCompletedMonths * 100) / 100,
      mtdTotal:           Math.round(metrics.mtdTotal           * 100) / 100,
      mtdActual:          Math.round(metrics.mtdActual          * 100) / 100,
      mtdFuture:          Math.round(metrics.mtdFuture          * 100) / 100,
      normalizedYTD:      Math.round(metrics.normalizedYTD      * 100) / 100,
      projectedAnnual:    Math.round(metrics.projectedAnnual    * 100) / 100,
      remaining:          Math.round(remaining                  * 100) / 100,
      remainingFull:      Math.round(remainingFull              * 100) / 100,
      percentAboveBelow:  Math.round(percentAboveBelow          * 10000) / 10000, // 4dp
    };
  }

  // Monthly comparison chart data — anchor to effectiveToday so historical
  // years show the last month of that year rather than the current real month.
  const curYear  = effectiveToday.getUTCFullYear();
  const curMonth = effectiveToday.getUTCMonth() + 1;
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

  // Per-month actual spend for the full year (used by the completed-year Monthly Spend chart).
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const endOfYear   = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  const [personalYearRows, jointYearRows] = await Promise.all([
    personalIds.length > 0
      ? prisma.expense.findMany({
          where: { accountId: { in: personalIds }, date: { gte: startOfYear, lte: endOfYear }, ...ignoredExpenseFilter(ignoredCategoryIds) },
          select: { date: true, amount: true },
        })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({
          where: { accountId: { in: jointIds }, date: { gte: startOfYear, lte: endOfYear }, ...ignoredExpenseFilter(ignoredCategoryIds) },
          select: { date: true, amount: true },
        })
      : Promise.resolve([]),
  ]);
  const personalByMonth = new Array(12).fill(0);
  const jointByMonth    = new Array(12).fill(0);
  for (const e of personalYearRows) personalByMonth[new Date(e.date).getUTCMonth()] += Number(e.amount);
  for (const e of jointYearRows)    jointByMonth[new Date(e.date).getUTCMonth()]    += Number(e.amount) * splitRatio;
  const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthlyTotals = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    label: MONTH_LABELS[i],
    personalSpent: Math.round(personalByMonth[i] * 100) / 100,
    jointSpent:    Math.round(jointByMonth[i]    * 100) / 100,
  }));

  // Number of calendar months fully completed within the year as of effectiveToday.
  // For a past year Dec-31 is used as the anchor, and getUTCMonth() returns 11 (Dec index),
  // but all 12 months are complete — so clamp to 12 for any finished year.
  const completedMonths =
    year < today.getUTCFullYear() ? 12 : effectiveToday.getUTCMonth();

  res.json({
    year,
    daysElapsed: elapsed,
    daysInYear: totalDays,
    pctElapsed: Math.round(pctElapsed * 10000) / 10000,
    completedMonths,
    monthlyTotals,
    settings: { jointSplitRatio: splitRatio },
    personal: {
      annualBudget: personalAnnualRaw,
      effectiveAnnualBudget: Math.round(effPersonal * 100) / 100,
      monthlyBudgets: resolveMonthlyAmounts(personalAnnualRaw, personalOverrides),
      ...panelStats(personalMetrics, effPersonal),
      chart: personalChart,
    },
    joint: {
      annualBudget: jointAnnualRaw,   // what the user entered (already their share)
      effectiveAnnualBudget: Math.round(effJoint * 100) / 100,
      monthlyBudgets: resolveMonthlyAmounts(jointAnnualRaw, jointOverrides),
      ...panelStats(scaledJoint, effJoint),  // spend is scaled; budget is not
      chart: jointChart,                     // chart was already scaled by splitRatio
    },
    total: {
      annualBudget: null, // always derived: personal + joint (joint already reflects user's share)
      effectiveAnnualBudget: Math.round(effTotal * 100) / 100,
      ...panelStats(totalMetrics, effTotal),
      chart: totalChart,
    },
  });
});

// GET /api/budgets/:year/category-outliers
// Returns the top-10 categories by absolute month-over-month spend change,
// comparing current-month-to-date vs the same day range in the prior month.
// Applies the same joint split-ratio and ignoreInBudget filters as the main route.
budgetRoutes.get("/:year/category-outliers", async (req, res) => {
  const userId = getUserId(req);
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: "Invalid year" });

  // Prefer the client's local date (YYYY-MM-DD) to avoid UTC vs. local-time skew.
  const todayParam = req.query.today as string | undefined;
  const today = todayParam ? new Date(`${todayParam}T00:00:00Z`) : new Date();
  const effectiveToday =
    year < today.getUTCFullYear()
      ? new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999))
      : year > today.getUTCFullYear()
        ? new Date(Date.UTC(year, 0, 1))
        : today;

  const [accounts, ignoredCategories, settings, annualBudgets] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { userId, ignoreInBudget: true }, select: { id: true } }),
    getOrCreateSettings(userId),
    prisma.annualBudget.findMany({ where: { userId, year }, include: { monthlyOverrides: true } }),
  ]);

  const splitRatio        = Number(settings.jointSplitRatio);
  const personalIds       = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointIds          = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);

  // Compute scale cap = 30% of effective monthly total budget
  const pBudget = annualBudgets.find((b) => b.type === "PERSONAL") ?? null;
  const jBudget = annualBudgets.find((b) => b.type === "JOINT")    ?? null;
  const toOverrides = (b: typeof pBudget) =>
    (b?.monthlyOverrides ?? []).map((o) => ({ month: o.month, amount: Number(o.amount) }));
  const effTotal = effectiveAnnual(
    pBudget ? Number(pBudget.annualAmount) : null, toOverrides(pBudget),
  ) + effectiveAnnual(
    jBudget ? Number(jBudget.annualAmount) : null, toOverrides(jBudget),
  );
  const scaleCap: number | null = effTotal > 0 ? Math.round(effTotal / 12 * 0.30) : null;

  const curYear  = effectiveToday.getUTCFullYear();
  const curMonth = effectiveToday.getUTCMonth() + 1; // 1-indexed
  const curDay   = effectiveToday.getUTCDate();

  const comparison = (req.query.comparison as string) ?? "mom";
  let prevMonth: number, prevMonthYear: number, prevDay: number;
  if (comparison === "yoy") {
    prevMonth     = curMonth;
    prevMonthYear = curYear - 1;
    const daysInPrevMonth = new Date(Date.UTC(curYear - 1, curMonth, 0)).getUTCDate();
    prevDay = Math.min(curDay, daysInPrevMonth);
  } else {
    prevMonth     = curMonth === 1 ? 12 : curMonth - 1;
    prevMonthYear = curMonth === 1 ? curYear - 1 : curYear;
    const daysInPrevMonth = new Date(Date.UTC(prevMonthYear, prevMonth, 0)).getUTCDate();
    prevDay = Math.min(curDay, daysInPrevMonth);
  }

  const curStart  = new Date(Date.UTC(curYear,       curMonth - 1, 1));
  const curEnd    = new Date(Date.UTC(curYear,       curMonth - 1, curDay, 23, 59, 59, 999));
  const prevStart = new Date(Date.UTC(prevMonthYear, prevMonth - 1, 1));
  const prevEnd   = new Date(Date.UTC(prevMonthYear, prevMonth - 1, prevDay, 23, 59, 59, 999));

  const expFilter = ignoredExpenseFilter(ignoredCategoryIds);
  const sel = {
    amount: true,
    categoryId: true,
    category: { select: { name: true, color: true } },
  } as const;

  const [curPersonal, curJoint, prevPersonal, prevJoint] = await Promise.all([
    personalIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: personalIds }, date: { gte: curStart,  lte: curEnd  }, ...expFilter }, select: sel })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: jointIds  }, date: { gte: curStart,  lte: curEnd  }, ...expFilter }, select: sel })
      : Promise.resolve([]),
    personalIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: personalIds }, date: { gte: prevStart, lte: prevEnd }, ...expFilter }, select: sel })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: jointIds  }, date: { gte: prevStart, lte: prevEnd }, ...expFilter }, select: sel })
      : Promise.resolve([]),
  ]);

  type Row = typeof curPersonal[number];

  const categoryInfo = new Map<string, { name: string; color: string | null }>();
  const curMap  = new Map<string, number>();
  const prevMap = new Map<string, number>();

  function accumulate(rows: Row[], scale: number, target: Map<string, number>) {
    for (const row of rows) {
      const key = row.categoryId ?? "__uncategorized__";
      if (!categoryInfo.has(key)) {
        categoryInfo.set(key, { name: row.category?.name ?? "Uncategorized", color: row.category?.color ?? null });
      }
      target.set(key, (target.get(key) ?? 0) + Number(row.amount) * scale);
    }
  }

  accumulate(curPersonal,  1,          curMap);
  accumulate(curJoint,     splitRatio, curMap);
  accumulate(prevPersonal, 1,          prevMap);
  accumulate(prevJoint,    splitRatio, prevMap);

  const SRV_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const allKeys = new Set([...curMap.keys(), ...prevMap.keys()]);

  const outliers = Array.from(allKeys)
    .map((key) => {
      const cur   = curMap.get(key)  ?? 0;
      const prev  = prevMap.get(key) ?? 0;
      const delta = cur - prev;
      const info  = categoryInfo.get(key)!;
      return {
        categoryId:     key === "__uncategorized__" ? null : key,
        categoryName:   info.name,
        color:          info.color,
        currentAmount:  Math.round(cur  * 100) / 100,
        previousAmount: Math.round(prev * 100) / 100,
        delta:          Math.round(delta * 100) / 100,
      };
    })
    .filter((o) => o.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);

  res.json({
    outliers,
    currentMonthLabel:  `${SRV_MONTHS[curMonth - 1]} ${curYear}`,
    previousMonthLabel: `${SRV_MONTHS[prevMonth - 1]} ${prevMonthYear}`,
    comparisonNote: `Day 1–${curDay}`,
    scaleCap,
  });
});

// GET /api/budgets/:year/category-outliers-ytd
// Returns the top-10 categories by absolute YTD spend change,
// comparing Jan 1–today of :year vs Jan 1–same-day of :year-1.
// Applies the same joint split-ratio and ignoreInBudget filters as the main route.
budgetRoutes.get("/:year/category-outliers-ytd", async (req, res) => {
  const userId = getUserId(req);
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: "Invalid year" });

  // Prefer the client's local date (YYYY-MM-DD) to avoid UTC vs. local-time skew.
  const todayParam = req.query.today as string | undefined;
  const today = todayParam ? new Date(`${todayParam}T00:00:00Z`) : new Date();
  const effectiveToday =
    year < today.getUTCFullYear()
      ? new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999))
      : year > today.getUTCFullYear()
        ? new Date(Date.UTC(year, 0, 1))
        : today;

  const [accounts, ignoredCategories, settings, annualBudgets] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { userId, ignoreInBudget: true }, select: { id: true } }),
    getOrCreateSettings(userId),
    prisma.annualBudget.findMany({ where: { userId, year }, include: { monthlyOverrides: true } }),
  ]);

  const splitRatio         = Number(settings.jointSplitRatio);
  const personalIds        = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointIds           = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);

  // Scale cap = 20% of the pro-rated YTD budget (annual × months_elapsed / 12)
  const pBudget = annualBudgets.find((b) => b.type === "PERSONAL") ?? null;
  const jBudget = annualBudgets.find((b) => b.type === "JOINT")    ?? null;
  const toOverrides = (b: typeof pBudget) =>
    (b?.monthlyOverrides ?? []).map((o) => ({ month: o.month, amount: Number(o.amount) }));
  const effTotal = effectiveAnnual(
    pBudget ? Number(pBudget.annualAmount) : null, toOverrides(pBudget),
  ) + effectiveAnnual(
    jBudget ? Number(jBudget.annualAmount) : null, toOverrides(jBudget),
  );
  const curYear      = effectiveToday.getUTCFullYear();
  const curMonthIdx  = effectiveToday.getUTCMonth(); // 0-indexed
  const curDay       = effectiveToday.getUTCDate();
  const monthsElapsed = curMonthIdx + 1;
  const scaleCap: number | null = effTotal > 0
    ? Math.round(effTotal * (monthsElapsed / 12) * 0.20)
    : null;

  const prevYear = curYear - 1;
  // Cap comparison day at the number of days in the same month of prior year
  const daysInPrevYearMonth = new Date(Date.UTC(prevYear, curMonthIdx + 1, 0)).getUTCDate();
  const prevDay = Math.min(curDay, daysInPrevYearMonth);

  const curStart  = new Date(Date.UTC(curYear,  0, 1));
  const curEnd    = new Date(Date.UTC(curYear,  curMonthIdx, curDay, 23, 59, 59, 999));
  const prevStart = new Date(Date.UTC(prevYear, 0, 1));
  const prevEnd   = new Date(Date.UTC(prevYear, curMonthIdx, prevDay, 23, 59, 59, 999));

  const expFilter = ignoredExpenseFilter(ignoredCategoryIds);
  const sel = {
    amount: true,
    categoryId: true,
    category: { select: { name: true, color: true, parentId: true, parent: { select: { id: true, name: true, color: true } } } },
  } as const;

  const [curPersonal, curJoint, prevPersonal, prevJoint] = await Promise.all([
    personalIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: personalIds }, date: { gte: curStart,  lte: curEnd  }, ...expFilter }, select: sel })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: jointIds  }, date: { gte: curStart,  lte: curEnd  }, ...expFilter }, select: sel })
      : Promise.resolve([]),
    personalIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: personalIds }, date: { gte: prevStart, lte: prevEnd }, ...expFilter }, select: sel })
      : Promise.resolve([]),
    jointIds.length > 0
      ? prisma.expense.findMany({ where: { accountId: { in: jointIds  }, date: { gte: prevStart, lte: prevEnd }, ...expFilter }, select: sel })
      : Promise.resolve([]),
  ]);

  type Row = typeof curPersonal[number];

  const categoryInfo = new Map<string, { name: string; color: string | null }>();
  const curMap  = new Map<string, number>();
  const prevMap = new Map<string, number>();

  function accumulate(rows: Row[], scale: number, target: Map<string, number>) {
    for (const row of rows) {
      // Roll up to parent category when one exists
      const parent = row.category?.parent;
      const key    = parent ? parent.id : (row.categoryId ?? "__uncategorized__");
      if (!categoryInfo.has(key)) {
        categoryInfo.set(key, {
          name:  parent ? parent.name : (row.category?.name ?? "Uncategorized"),
          color: parent ? parent.color : (row.category?.color ?? null),
        });
      }
      target.set(key, (target.get(key) ?? 0) + Number(row.amount) * scale);
    }
  }

  accumulate(curPersonal,  1,          curMap);
  accumulate(curJoint,     splitRatio, curMap);
  accumulate(prevPersonal, 1,          prevMap);
  accumulate(prevJoint,    splitRatio, prevMap);

  const SRV_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const allKeys = new Set([...curMap.keys(), ...prevMap.keys()]);

  const outliers = Array.from(allKeys)
    .map((key) => {
      const cur   = curMap.get(key)  ?? 0;
      const prev  = prevMap.get(key) ?? 0;
      const delta = cur - prev;
      const info  = categoryInfo.get(key)!;
      return {
        categoryId:     key === "__uncategorized__" ? null : key,
        categoryName:   info.name,
        color:          info.color,
        currentAmount:  Math.round(cur  * 100) / 100,
        previousAmount: Math.round(prev * 100) / 100,
        delta:          Math.round(delta * 100) / 100,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  res.json({
    outliers,
    currentMonthLabel:  `YTD ${curYear}`,
    previousMonthLabel: `YTD ${prevYear}`,
    comparisonNote: `Jan 1 – ${SRV_MONTHS[curMonthIdx]} ${curDay}`,
    scaleCap,
  });
});

// PUT /api/budgets/:year/personal  |  PUT /api/budgets/:year/joint
// Set or update the annual budget for a budget type.
budgetRoutes.put("/:year/:type(personal|joint)", async (req, res) => {
  const userId = getUserId(req);
  const year = parseInt(req.params.year);
  if (isNaN(year)) return res.status(400).json({ error: "Invalid year" });

  const type   = (req.params as Record<string, string>).type.toUpperCase() as "PERSONAL" | "JOINT";
  const schema = z.object({ annualAmount: z.number().nonnegative() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const budget = await prisma.annualBudget.upsert({
    where:  { userId_type_year: { userId, type, year } },
    update: { annualAmount: parsed.data.annualAmount },
    create: { userId, type, year, annualAmount: parsed.data.annualAmount },
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
  const userId = getUserId(req);
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
    where:  { userId_type_year: { userId, type, year } },
    update: {},
    create: { userId, type, year, annualAmount: null },
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
  const userId = getUserId(req);
  const year  = parseInt(req.params.year);
  const month = parseInt(req.params.month);
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: "Invalid year or month" });
  }

  const type         = (req.params as Record<string, string>).type.toUpperCase() as "PERSONAL" | "JOINT";
  const annualBudget = await prisma.annualBudget.findUnique({
    where: { userId_type_year: { userId, type, year } },
  });
  if (!annualBudget) return res.status(404).json({ error: "Budget not found" });

  await prisma.monthlyBudget.deleteMany({
    where: { annualBudgetId: annualBudget.id, month },
  });

  res.status(204).send();
});

// ── Monthly spending heatmap ──────────────────────────────────────────────────

budgetRoutes.get("/:year/monthly-spending", async (req, res) => {
  try {
    const userId = getUserId(req);
    const year = Number(req.params.year);
    if (!Number.isFinite(year)) return res.status(400).json({ error: "Invalid year" });

    const todayParam = typeof req.query.today === "string" ? req.query.today : undefined;
    const effectiveToday = todayParam ? new Date(`${todayParam}T00:00:00Z`) : new Date();

    const startOfYear = new Date(Date.UTC(year, 0, 1));
    const endOfYear   = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

    // Cap at end-of-today so future-dated recurring instances in the current
    // month are excluded — consistent with how the Dashboard MTD figure is computed.
    const todayEndOfDay = new Date(Date.UTC(
      effectiveToday.getUTCFullYear(),
      effectiveToday.getUTCMonth(),
      effectiveToday.getUTCDate(),
      23, 59, 59, 999,
    ));
    const queryEnd = todayEndOfDay < endOfYear ? todayEndOfDay : endOfYear;

    const [accounts, ignoredCategories, settings, annualBudgets] = await Promise.all([
      prisma.account.findMany({
        where: { userId, isActive: true },
        select: { id: true, isJoint: true },
      }),
      prisma.category.findMany({
        where: { userId, ignoreInBudget: true },
        select: { id: true },
      }),
      getOrCreateSettings(userId),
      prisma.annualBudget.findMany({
        where: { userId, year },
        include: { monthlyOverrides: true },
      }),
    ]);

    const personalIds        = accounts.filter((a) => !a.isJoint).map((a) => a.id);
    const jointIds           = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
    const allIds             = accounts.map((a) => a.id);
    const ignoredCategoryIds = ignoredCategories.map((c) => c.id);
    const splitRatio         = Number(settings.jointSplitRatio);

    // Budget amounts per month
    const personalBudget = annualBudgets.find((b) => b.type === "PERSONAL") ?? null;
    const jointBudget    = annualBudgets.find((b) => b.type === "JOINT")    ?? null;
    const personalMonthly = resolveMonthlyAmounts(
      personalBudget?.annualAmount != null ? Number(personalBudget.annualAmount) : null,
      (personalBudget?.monthlyOverrides ?? []).map((o) => ({ month: o.month, amount: Number(o.amount) })),
    );
    const jointMonthly = resolveMonthlyAmounts(
      jointBudget?.annualAmount != null ? Number(jointBudget.annualAmount) : null,
      (jointBudget?.monthlyOverrides ?? []).map((o) => ({ month: o.month, amount: Number(o.amount) })),
    );

    // Fetch all expenses for the year with vendor and account info.
    // Offsets (parentExpenseId != null) are included so they net against
    // their parent in totals and can be surfaced in the tooltip.
    const expenses = await prisma.expense.findMany({
      where: {
        accountId: { in: allIds },
        date: { gte: startOfYear, lte: queryEnd },
        ...ignoredExpenseFilter(ignoredCategoryIds),
      },
      select: {
        id: true,
        amount: true,
        vendor: true,
        description: true,
        date: true,
        accountId: true,
        parentExpenseId: true,
        transactionGroupId: true,
        recurrenceRuleId: true,
      },
      // Sort by date, then group transaction-linked rows together, parents
      // before their offsets within each transaction group / standalone cluster.
      orderBy: [{ date: "asc" }, { transactionGroupId: "asc" }, { id: "asc" }],
    });

    // Build a set of joint account IDs for fast lookup
    const jointIdSet = new Set(jointIds);

    // Group expenses by month → day
    type DayExpense = {
      id: string;
      vendor: string;
      amount: number;
      isJoint: boolean;
      isRecurring: boolean;
      parentExpenseId: string | null;
      transactionGroupId: string | null;
    };
    const months: {
      month: number;
      days: Record<number, DayExpense[]>;
      personalTotal: number;
      jointTotal: number;
    }[] = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      days: {},
      personalTotal: 0,
      jointTotal: 0,
    }));

    for (const exp of expenses) {
      const d = new Date(exp.date);
      const m = d.getUTCMonth(); // 0-indexed
      const day = d.getUTCDate();
      const amount = Number(exp.amount);
      const isJoint = jointIdSet.has(exp.accountId);

      if (!months[m].days[day]) months[m].days[day] = [];
      months[m].days[day].push({
        id: exp.id,
        vendor: exp.vendor || exp.description,
        amount,
        isJoint,
        isRecurring: !!exp.recurrenceRuleId,
        parentExpenseId: exp.parentExpenseId,
        transactionGroupId: exp.transactionGroupId,
      });

      if (isJoint) {
        months[m].jointTotal += amount;
      } else {
        months[m].personalTotal += amount;
      }
    }

    // Build response
    const result = months.map((m) => {
      const personalBudgetAmt = personalMonthly[m.month - 1].amount;
      const jointBudgetAmt    = jointMonthly[m.month - 1].amount;
      const scaledJoint       = m.jointTotal * splitRatio;
      return {
        month: m.month,
        days: m.days,
        personalTotal:  Math.round(m.personalTotal * 100) / 100,
        jointTotal:     Math.round(scaledJoint * 100) / 100,
        combinedTotal:  Math.round((m.personalTotal + scaledJoint) * 100) / 100,
        personalBudget: Math.round(personalBudgetAmt * 100) / 100,
        jointBudget:    Math.round(jointBudgetAmt * 100) / 100,
        combinedBudget: Math.round((personalBudgetAmt + jointBudgetAmt) * 100) / 100,
      };
    });

    res.json({ year, splitRatio, months: result });
  } catch (err) {
    console.error("monthly-spending error", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/budgets/:year/monthly-chart?month=N&today=YYYY-MM-DD
// Returns daily cumulative spend for the specified month across personal, joint, total views.
budgetRoutes.get("/:year/monthly-chart", async (req, res) => {
  const userId = getUserId(req);
  const year  = parseInt(req.params.year);
  const month = parseInt(req.query.month as string);
  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: "Invalid year or month" });
  }

  const todayParam = req.query.today as string | undefined;
  const today = todayParam ? new Date(`${todayParam}T00:00:00Z`) : new Date();

  const [accounts, ignoredCategories, settings, annualBudgets] = await Promise.all([
    prisma.account.findMany({ where: { userId, isActive: true }, select: { id: true, isJoint: true } }),
    prisma.category.findMany({ where: { userId, ignoreInBudget: true }, select: { id: true } }),
    getOrCreateSettings(userId),
    prisma.annualBudget.findMany({ where: { userId, year }, include: { monthlyOverrides: true } }),
  ]);

  const splitRatio         = Number(settings.jointSplitRatio);
  const personalIds        = accounts.filter((a) => !a.isJoint).map((a) => a.id);
  const jointIds           = accounts.filter((a) =>  a.isJoint).map((a) => a.id);
  const ignoredCategoryIds = ignoredCategories.map((c) => c.id);

  const prevMonth     = month === 1 ? 12 : month - 1;
  const prevMonthYear = month === 1 ? year - 1 : year;

  async function buildChartForIds(ids: string[], ratio = 1) {
    const [current, previous, priorYear] = await Promise.all([
      buildMonthlyComparison(year,           month,     ids, ignoredCategoryIds),
      buildMonthlyComparison(prevMonthYear,  prevMonth, ids, ignoredCategoryIds),
      buildMonthlyComparison(year - 1,       month,     ids, ignoredCategoryIds),
    ]);
    if (ratio === 1) return { current, previous, priorYear };
    const scale = (arr: { day: number; cumulative: number }[]) =>
      arr.map((d) => ({ ...d, cumulative: Math.round(d.cumulative * ratio * 100) / 100 }));
    return { current: scale(current), previous: scale(previous), priorYear: scale(priorYear) };
  }

  function mergeSeries(
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
    buildChartForIds(personalIds, 1),
    buildChartForIds(jointIds, splitRatio),
  ]);

  const totalChart = {
    current:   mergeSeries(personalChart.current,   jointChart.current),
    previous:  mergeSeries(personalChart.previous,  jointChart.previous),
    priorYear: mergeSeries(personalChart.priorYear, jointChart.priorYear),
  };

  const personalBudget = annualBudgets.find((b) => b.type === "PERSONAL") ?? null;
  const jointBudget    = annualBudgets.find((b) => b.type === "JOINT")    ?? null;
  const toOverrides = (b: typeof personalBudget) =>
    (b?.monthlyOverrides ?? []).map((o) => ({ month: o.month, amount: Number(o.amount) }));
  const personalMonthly = resolveMonthlyAmounts(
    personalBudget?.annualAmount != null ? Number(personalBudget.annualAmount) : null,
    toOverrides(personalBudget),
  );
  const jointMonthly = resolveMonthlyAmounts(
    jointBudget?.annualAmount != null ? Number(jointBudget.annualAmount) : null,
    toOverrides(jointBudget),
  );
  const personalMonthlyBudget = personalMonthly[month - 1].amount;
  const jointMonthlyBudget    = jointMonthly[month - 1].amount;

  const SRV_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const isCurrentMonth =
    today.getUTCFullYear() === year && today.getUTCMonth() + 1 === month;

  res.json({
    personal: personalChart,
    joint:    jointChart,
    total:    totalChart,
    monthlyBudget: {
      personal: personalMonthlyBudget,
      joint:    jointMonthlyBudget,
      total:    personalMonthlyBudget + jointMonthlyBudget,
    },
    monthNames: {
      current:   `${SRV_MONTHS[month - 1]} ${year}`,
      previous:  `${SRV_MONTHS[prevMonth - 1]} ${prevMonthYear}`,
      priorYear: `${SRV_MONTHS[month - 1]} ${year - 1}`,
    },
    todayDay: isCurrentMonth ? today.getUTCDate() : null,
  });
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
