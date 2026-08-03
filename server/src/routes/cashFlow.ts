import { Router } from "express";
import { prisma } from "../db/client.js";
import { getUserId } from "../middleware/auth.js";
import { generateUpcomingTransfers } from "./transfers.js";

export const cashFlowRoutes = Router();

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Returns the most recent occurrence of `day` on or before `ref` (UTC). */
function prevDayOfMonth(ref: Date, day: number): Date {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  const d = ref.getUTCDate();
  if (d >= day) return new Date(Date.UTC(y, m, day));
  // day hasn't occurred this month yet — use previous month
  const prev = new Date(Date.UTC(y, m - 1, day));
  return prev;
}

/** Returns the next occurrence of `day` strictly after `ref` (UTC). */
function nextDayOfMonth(ref: Date, day: number): Date {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  const d = ref.getUTCDate();
  if (d < day) return new Date(Date.UTC(y, m, day));
  // day has already occurred this month — use next month
  return new Date(Date.UTC(y, m + 1, day));
}

/**
 * Returns the due date for the statement that closed on `closeDate`.
 *
 * Rule: if dueDay > closingDay the payment falls in the *same* month as the
 * close (e.g. closes Apr 2, due Apr 24).  Otherwise it falls in the *next*
 * month (e.g. closes Mar 19, due Apr 16).
 */
function statementDueDate(closeDate: Date, dueDay: number, closingDay: number): Date {
  const monthOffset = dueDay > closingDay ? 0 : 1;
  return new Date(Date.UTC(
    closeDate.getUTCFullYear(),
    closeDate.getUTCMonth() + monthOffset,
    dueDay,
  ));
}

/** Advance a closing date by one billing cycle (next month, same day). */
function advanceClose(closeDate: Date): Date {
  return new Date(Date.UTC(
    closeDate.getUTCFullYear(),
    closeDate.getUTCMonth() + 1,
    closeDate.getUTCDate(),
  ));
}

type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** Advance a date by one rule interval. */
function advanceByFrequency(date: Date, frequency: Frequency, interval: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  switch (frequency) {
    case "DAILY":   return new Date(Date.UTC(y, m, d + interval));
    case "WEEKLY":  return new Date(Date.UTC(y, m, d + 7 * interval));
    case "MONTHLY": return new Date(Date.UTC(y, m + interval, d));
    case "YEARLY":  return new Date(Date.UTC(y + interval, m, d));
  }
}

/**
 * Generate all occurrences of a recurring rule within [windowStart, windowEnd].
 * Walks forward from `startFrom` (the rule's startDate or nextOccurrence) using
 * `advanceByFrequency` until past `windowEnd`.
 */
function generateRuleOccurrences(
  startFrom: Date,
  endDate: Date | null,
  frequency: Frequency,
  interval: number,
  windowStart: Date,
  windowEnd: Date,
): Date[] {
  const results: Date[] = [];
  const cap = endDate ? new Date(Math.min(endDate.getTime(), windowEnd.getTime())) : windowEnd;
  let cur = new Date(startFrom);
  // Fast-forward to window start if rule started before it
  while (cur < windowStart) {
    cur = advanceByFrequency(cur, frequency, interval);
  }
  for (let i = 0; i < 366 && cur <= cap; i++) {
    results.push(new Date(cur));
    cur = advanceByFrequency(cur, frequency, interval);
  }
  return results;
}

/** ISO date string (YYYY-MM-DD) from a UTC Date. */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Types ─────────────────────────────────────────────────────────────────────

type EventType =
  | "EXPENSE"
  | "CC_CHARGE"
  | "CC_PAYMENT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "DIVIDEND"
  | "INCOME"
  | "BALANCE_ADJUSTMENT";

type Confidence = "KNOWN" | "PROJECTED";

interface CashFlowEvent {
  id: string;
  date: string;
  description: string;
  amount: number;          // positive = credit, negative = debit
  type: EventType;
  confidence: Confidence;
  relatedAccountId?: string;
  relatedAccountName?: string;
  /** Present on CC_PAYMENT events so the UI can offer a statement override */
  periodStart?: string;
  periodEnd?: string;
  /** First day of expenses included in this billing period (day after previous close) */
  statementPeriodStart?: string;
  overrideId?: string;
  /** Present on BALANCE_ADJUSTMENT events so the UI can edit/delete */
  adjustmentId?: string;
  /** Present on TRANSFER_IN/TRANSFER_OUT events backed by a real Transfer record so the UI can confirm them */
  transferId?: string;
  runningBalance: number;  // filled in after sorting
}

interface DailyBalance {
  date: string;
  balance: number;
}

interface CashFlowProjection {
  accountId: string;
  accountName: string;
  accountType: "CHECKING";
  color: string | null;
  isJoint: boolean;
  startBalance: number;
  endBalance: number;
  minBalance: number;
  events: CashFlowEvent[];
  dailyBalances: DailyBalance[];
}

// ── Projection engine ─────────────────────────────────────────────────────────

async function buildProjection(
  account: {
    id: string;
    name: string;
    type: string;
    balance: object; // Prisma Decimal
    color: string | null;
    isJoint: boolean;
    closingDay: number | null;
    dueDay: number | null;
    linkedBankAccountId: string | null;
    balanceUpdatedAt: Date | null;
  },
  windowStart: Date,
  windowEnd: Date,
  allAccounts: Array<{ id: string; name: string; color: string | null; type: string }>,
  statementOverrides: Array<{
    id: string;
    accountId: string;
    periodStart: Date;
    periodEnd: Date;
    amount: object; // Decimal
  }>,
): Promise<CashFlowProjection> {
  const startBalance = parseFloat(account.balance.toString());
  const rawEvents: Omit<CashFlowEvent, "runningBalance">[] = [];

  // Events dated after balanceUpdatedAt have not yet been reflected in the
  // stored balance. Fall back to windowStart (today) when the user has never
  // manually updated the balance.
  const settledThrough = account.balanceUpdatedAt ?? windowStart;

  const accountName = (id: string) =>
    allAccounts.find((a) => a.id === id)?.name ?? "Unknown";

  // 1. Upcoming expenses charged to this account (already-generated records)
  const upcomingExpenses = await prisma.expense.findMany({
    where: {
      accountId: account.id,
      date: { gte: settledThrough, lte: windowEnd },
    },
    select: { id: true, date: true, description: true, vendor: true, amount: true, recurrenceRuleId: true },
  });

  // Track which recurrence rule IDs already have generated instances in the window
  const seenRecurrenceRuleDates = new Map<string, Set<string>>();
  for (const exp of upcomingExpenses) {
    rawEvents.push({
      id: `exp-${exp.id}`,
      date: toDateStr(exp.date),
      description: exp.description || exp.vendor || "Expense",
      amount: -parseFloat(exp.amount.toString()),
      type: "EXPENSE",
      confidence: (exp.recurrenceRuleId && toDateStr(exp.date) > toDateStr(windowStart)) ? "PROJECTED" : "KNOWN",
    });
    if (exp.recurrenceRuleId) {
      if (!seenRecurrenceRuleDates.has(exp.recurrenceRuleId)) {
        seenRecurrenceRuleDates.set(exp.recurrenceRuleId, new Set());
      }
      seenRecurrenceRuleDates.get(exp.recurrenceRuleId)!.add(toDateStr(exp.date));
    }
  }

  // 1b. Project future instances from active RecurrenceRules beyond already-generated range
  const activeRules = await prisma.recurrenceRule.findMany({
    where: {
      accountId: account.id,
      isActive: true,
      startDate: { lte: windowEnd },
      OR: [{ endDate: null }, { endDate: { gte: settledThrough } }],
    },
    select: { id: true, description: true, vendor: true, amount: true, frequency: true, interval: true, startDate: true, endDate: true, nextOccurrence: true },
  });

  for (const rule of activeRules) {
    const seenDates = seenRecurrenceRuleDates.get(rule.id) ?? new Set<string>();
    // Start from nextOccurrence — the first date the rule hasn't generated yet.
    // Using startDate would re-project already-generated occurrences whose dates
    // were later edited (the edited date wouldn't be in seenDates, causing duplicates).
    const occurrences = generateRuleOccurrences(
      rule.nextOccurrence,
      rule.endDate,
      rule.frequency as Frequency,
      rule.interval,
      settledThrough,
      windowEnd,
    );
    for (const occ of occurrences) {
      const ds = toDateStr(occ);
      if (seenDates.has(ds)) continue; // safety net: skip if already generated for this date
      rawEvents.push({
        id: `rule-${rule.id}-${ds}`,
        date: ds,
        description: rule.description || rule.vendor || "Recurring expense",
        amount: -parseFloat(rule.amount.toString()),
        type: "EXPENSE",
        confidence: "PROJECTED",
      });
    }
  }

  // 2. Transfers from this account (already-generated records)
  const transfersFrom = await prisma.transfer.findMany({
    where: { fromAccountId: account.id, date: { gte: settledThrough, lte: windowEnd } },
    select: { id: true, date: true, description: true, amount: true, isConfirmed: true, toAccountId: true, transferRuleId: true },
  });
  const seenTransferRuleDatesFrom = new Map<string, Set<string>>();
  for (const t of transfersFrom) {
    rawEvents.push({
      id: `txfr-out-${t.id}`,
      date: toDateStr(t.date),
      description: t.description,
      amount: -parseFloat(t.amount.toString()),
      type: "TRANSFER_OUT",
      confidence: t.isConfirmed ? "KNOWN" : "PROJECTED",
      relatedAccountId: t.toAccountId,
      relatedAccountName: accountName(t.toAccountId),
      transferId: t.id,
    });
    if (t.transferRuleId) {
      if (!seenTransferRuleDatesFrom.has(t.transferRuleId)) {
        seenTransferRuleDatesFrom.set(t.transferRuleId, new Set());
      }
      seenTransferRuleDatesFrom.get(t.transferRuleId)!.add(toDateStr(t.date));
    }
  }

  // 2b. Project future outgoing transfers from active TransferRules
  const activeTransferRulesFrom = await prisma.transferRule.findMany({
    where: {
      fromAccountId: account.id,
      isActive: true,
      startDate: { lte: windowEnd },
      OR: [{ endDate: null }, { endDate: { gte: settledThrough } }],
    },
    select: { id: true, description: true, amount: true, frequency: true, interval: true, startDate: true, endDate: true, nextOccurrence: true, toAccountId: true },
  });
  for (const rule of activeTransferRulesFrom) {
    const seenDates = seenTransferRuleDatesFrom.get(rule.id) ?? new Set<string>();
    // Start from nextOccurrence — the first date the rule hasn't generated yet.
    // Using startDate would re-project already-generated occurrences whose dates
    // were later edited (the edited date wouldn't be in seenDates, causing duplicates).
    const occurrences = generateRuleOccurrences(
      rule.nextOccurrence,
      rule.endDate,
      rule.frequency as Frequency,
      rule.interval,
      settledThrough,
      windowEnd,
    );
    for (const occ of occurrences) {
      const ds = toDateStr(occ);
      if (seenDates.has(ds)) continue;
      rawEvents.push({
        id: `trule-out-${rule.id}-${ds}`,
        date: ds,
        description: rule.description,
        amount: -parseFloat(rule.amount.toString()),
        type: "TRANSFER_OUT",
        confidence: "PROJECTED",
        relatedAccountId: rule.toAccountId,
        relatedAccountName: accountName(rule.toAccountId),
      });
    }
  }

  // 3. Transfers to this account (already-generated records)
  const transfersTo = await prisma.transfer.findMany({
    where: { toAccountId: account.id, date: { gte: settledThrough, lte: windowEnd } },
    select: { id: true, date: true, description: true, amount: true, isConfirmed: true, fromAccountId: true, transferRuleId: true },
  });
  const seenTransferRuleDatesTo = new Map<string, Set<string>>();
  for (const t of transfersTo) {
    rawEvents.push({
      id: `txfr-in-${t.id}`,
      date: toDateStr(t.date),
      description: t.description,
      amount: parseFloat(t.amount.toString()),
      type: "TRANSFER_IN",
      confidence: t.isConfirmed ? "KNOWN" : "PROJECTED",
      relatedAccountId: t.fromAccountId,
      relatedAccountName: accountName(t.fromAccountId),
      transferId: t.id,
    });
    if (t.transferRuleId) {
      if (!seenTransferRuleDatesTo.has(t.transferRuleId)) {
        seenTransferRuleDatesTo.set(t.transferRuleId, new Set());
      }
      seenTransferRuleDatesTo.get(t.transferRuleId)!.add(toDateStr(t.date));
    }
  }

  // 3b. Project future incoming transfers from active TransferRules
  const activeTransferRulesTo = await prisma.transferRule.findMany({
    where: {
      toAccountId: account.id,
      isActive: true,
      startDate: { lte: windowEnd },
      OR: [{ endDate: null }, { endDate: { gte: settledThrough } }],
    },
    select: { id: true, description: true, amount: true, frequency: true, interval: true, startDate: true, endDate: true, nextOccurrence: true, fromAccountId: true },
  });
  for (const rule of activeTransferRulesTo) {
    const seenDates = seenTransferRuleDatesTo.get(rule.id) ?? new Set<string>();
    // Start from nextOccurrence — the first date the rule hasn't generated yet.
    // Using startDate would re-project already-generated occurrences whose dates
    // were later edited (the edited date wouldn't be in seenDates, causing duplicates).
    const occurrences = generateRuleOccurrences(
      rule.nextOccurrence,
      rule.endDate,
      rule.frequency as Frequency,
      rule.interval,
      settledThrough,
      windowEnd,
    );
    for (const occ of occurrences) {
      const ds = toDateStr(occ);
      if (seenDates.has(ds)) continue;
      rawEvents.push({
        id: `trule-in-${rule.id}-${ds}`,
        date: ds,
        description: rule.description,
        amount: parseFloat(rule.amount.toString()),
        type: "TRANSFER_IN",
        confidence: "PROJECTED",
        relatedAccountId: rule.fromAccountId,
        relatedAccountName: accountName(rule.fromAccountId),
      });
    }
  }

  // 3c. Income records credited to this account (excludes DIVIDEND subtype —
  //     those are already projected from PendingDividend records in section 4)
  const incomeRecords = await prisma.income.findMany({
    where: {
      accountId: account.id,
      date: { gte: settledThrough, lte: windowEnd },
      isCashReceived: true,
      subtype: { not: "DIVIDEND" },
    },
    select: { id: true, date: true, source: true, amount: true },
  });
  for (const inc of incomeRecords) {
    rawEvents.push({
      id: `inc-${inc.id}`,
      date: toDateStr(inc.date),
      description: inc.source || "Income",
      amount: parseFloat(inc.amount.toString()),
      type: "INCOME",
      confidence: "KNOWN",
    });
  }

  // 4. Cash dividends deposited into this account (from investment accounts)
  const investmentAccountsUsingThis = allAccounts.filter(
    (a) => a.type === "INVESTMENT",
  );
  // We stored defaultCashAccountId on the account record; we need those
  const investorRows = await prisma.account.findMany({
    where: {
      type: "INVESTMENT",
      defaultCashAccountId: account.id,
      dividendElection: "CASH",
    },
    select: { id: true, name: true },
  });
  void investmentAccountsUsingThis; // suppress unused warning

  for (const inv of investorRows) {
    const dividends = await prisma.pendingDividend.findMany({
      include: { activity: { select: { date: true } } },
      where: {
        accountId: inv.id,
        status: { in: ["PENDING", "CONFIRMED"] },
        // Exclude confirmed dividends whose payment settled before the last
        // time the user updated their account balance — those are already
        // reflected in the stored balance and would be double-counted.
        // Fall back to windowStart (today) if the balance has never been
        // manually updated, so we don't surface stale historical dividends.
        NOT: { activityId: { not: null }, paymentDate: { lt: settledThrough } },
        // PENDING dividends always appear until the user confirms/dismisses
        // them. CONFIRMED dividends are date-windowed so settled ones drop off.
        OR: [
          { status: "PENDING" },
          { paymentDate: { gte: settledThrough, lte: windowEnd } },
          { paymentDate: null },
        ],
      },
    });
    for (const div of dividends) {
      // For dividends without a stored payment date, fall back to exDate + 4
      // calendar days — the same estimate used when the record is first created.
      const fallback = new Date(Date.UTC(
        div.exDate.getUTCFullYear(),
        div.exDate.getUTCMonth(),
        div.exDate.getUTCDate() + 4,
      ));
      const effectiveDate = div.activity?.date ?? div.paymentDate ?? fallback;
      rawEvents.push({
        id: `div-${div.id}`,
        date: toDateStr(effectiveDate),
        description: `${div.ticker} dividend`,
        amount: parseFloat(div.estimatedTotal.toString()),
        type: "DIVIDEND",
        confidence: div.status === "CONFIRMED" ? "KNOWN" : "PROJECTED",
        relatedAccountId: inv.id,
        relatedAccountName: inv.name,
      });
    }
  }

  // 5. CC payments debited from this checking account (for linked CC cards)
  {
    const linkedCards = await prisma.account.findMany({
      where: { linkedBankAccountId: account.id, type: "CREDIT_CARD" },
      select: { id: true, name: true, closingDay: true, dueDay: true },
    });

    for (const cc of linkedCards) {
      if (cc.closingDay == null || cc.dueDay == null) continue;

      const ccPaymentEvents = await computeCCPaymentEvents(
        cc as { id: string; name: string; closingDay: number; dueDay: number },
        settledThrough,
        windowEnd,
        statementOverrides.filter((o) => o.accountId === cc.id),
      );
      rawEvents.push(...ccPaymentEvents);
    }
  }

  // 6. User-entered balance adjustments (e.g. planned cash injections)
  const adjustments = await prisma.balanceAdjustment.findMany({
    where: { accountId: account.id, date: { gte: settledThrough, lte: windowEnd } },
    orderBy: { date: "asc" },
  });
  for (const adj of adjustments) {
    rawEvents.push({
      id: `adj-${adj.id}`,
      date: toDateStr(adj.date),
      description: adj.description,
      amount: parseFloat(adj.amount.toString()),
      type: "BALANCE_ADJUSTMENT",
      confidence: "KNOWN",
      adjustmentId: adj.id,
    });
  }

  // Drop any KNOWN-confidence event whose date falls on or before the last
  // time the user manually updated their account balance. Such events are
  // already reflected in the stored balance and would be double-counted.
  if (account.balanceUpdatedAt !== null) {
    const cutoff = toDateStr(account.balanceUpdatedAt);
    for (let i = rawEvents.length - 1; i >= 0; i--) {
      if (rawEvents[i].confidence === "KNOWN" && rawEvents[i].date <= cutoff) {
        rawEvents.splice(i, 1);
      }
    }
  }

  // Sort by date, then cash injections first, then debits before credits (conservative ordering)
  rawEvents.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const aIsAdj = a.type === "BALANCE_ADJUSTMENT" ? 0 : 1;
    const bIsAdj = b.type === "BALANCE_ADJUSTMENT" ? 0 : 1;
    if (aIsAdj !== bIsAdj) return aIsAdj - bIsAdj;
    return a.amount - b.amount; // debits (negative) first
  });

  // Compute running balance
  let balance = startBalance;
  const events: CashFlowEvent[] = rawEvents.map((e) => {
    balance += e.amount;
    return { ...e, runningBalance: balance };
  });

  // Daily balance series for chart
  const dailyBalances: DailyBalance[] = [];
  let runningBal = startBalance;
  let eIdx = 0;
  const cur = new Date(windowStart);
  while (cur <= windowEnd) {
    const ds = toDateStr(cur);
    while (eIdx < events.length && events[eIdx].date <= ds) {
      runningBal += events[eIdx].amount;
      eIdx++;
    }
    dailyBalances.push({ date: ds, balance: runningBal });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const endBalance = events.length > 0 ? events[events.length - 1].runningBalance : startBalance;
  const minBalance = dailyBalances.reduce((m, d) => Math.min(m, d.balance), startBalance);

  return {
    accountId: account.id,
    accountName: account.name,
    accountType: account.type as "CHECKING",
    color: account.color,
    isJoint: account.isJoint,
    startBalance,
    endBalance,
    minBalance,
    events,
    dailyBalances,
  };
}

/**
 * Compute CC payment events within the window.
 * When `creditSide` is true, the event is a positive amount (payment received on the CC).
 * When false (default), it's a negative amount (debit from the linked bank account).
 */
async function computeCCPaymentEvents(
  cc: { id: string; name: string; closingDay: number; dueDay: number },
  windowStart: Date,
  windowEnd: Date,
  overrides: Array<{ id: string; accountId: string; periodStart: Date; periodEnd: Date; amount: object }>,
  creditSide = false,
): Promise<Omit<CashFlowEvent, "runningBalance">[]> {
  const events: Omit<CashFlowEvent, "runningBalance">[] = [];
  const today = new Date(Date.UTC(
    windowStart.getUTCFullYear(),
    windowStart.getUTCMonth(),
    windowStart.getUTCDate(),
  ));

  // Walk billing periods, starting from the most recent close on or before today
  let closeDate = prevDayOfMonth(today, cc.closingDay);

  for (let i = 0; i < 24; i++) {
    const dueDate = statementDueDate(closeDate, cc.dueDay, cc.closingDay);
    if (dueDate > windowEnd) break;

    if (dueDate >= windowStart) {
      const override = overrides.find(
        (o) => toDateStr(o.periodStart) === toDateStr(closeDate),
      );

      let paymentAmount: number;
      let overrideId: string | undefined;
      let confidence: Confidence;

      // The billing period spans (prevClose, closeDate] — expenses strictly
      // after the previous close date through and including the current close.
      const prevClose = new Date(Date.UTC(
        closeDate.getUTCFullYear(),
        closeDate.getUTCMonth() - 1,
        cc.closingDay,
      ));

      // Expense dates are stored at local (Pacific) midnight — 07:00/08:00Z —
      // so UTC-midnight bounds land mid-day and slide the window a day early.
      // Use half-open whole-day bounds, matching the expense list endpoint, so
      // the sum covers exactly the rows the statement detail view lists.
      const periodStart = new Date(Date.UTC(
        prevClose.getUTCFullYear(),
        prevClose.getUTCMonth(),
        prevClose.getUTCDate() + 1,
      ));
      const periodEndExclusive = new Date(Date.UTC(
        closeDate.getUTCFullYear(),
        closeDate.getUTCMonth(),
        closeDate.getUTCDate() + 1,
      ));

      if (override) {
        paymentAmount = parseFloat(override.amount.toString());
        overrideId = override.id;
        confidence = "KNOWN";
      } else {
        // Sum all expenses charged to this CC during the billing period.
        // Always PROJECTED: the bank debit is a future event regardless of
        // whether the statement has already closed.
        const periodExpenses = await prisma.expense.aggregate({
          _sum: { amount: true },
          where: { accountId: cc.id, date: { gte: periodStart, lt: periodEndExclusive } },
        });
        paymentAmount = parseFloat(periodExpenses._sum.amount?.toString() ?? "0");
        confidence = "PROJECTED";
      }

      // Always emit the event — a $0 amount means the balance hasn't been
      // updated yet but the payment date is still meaningful.
      const sign = creditSide ? 1 : -1;
      events.push({
        id: `cc-pmt-${cc.id}-${toDateStr(closeDate)}`,
        date: toDateStr(dueDate),
        description: creditSide ? `Payment applied` : `CC payment`,
        amount: sign * paymentAmount,
        type: "CC_PAYMENT",
        confidence,
        relatedAccountId: cc.id,
        relatedAccountName: cc.name,
        periodStart: toDateStr(closeDate),
        periodEnd: toDateStr(dueDate),
        statementPeriodStart: toDateStr(periodStart),
        overrideId,
      });
    }

    closeDate = advanceClose(closeDate);
  }

  return events;
}

// ── Balance adjustment CRUD ───────────────────────────────────────────────────

cashFlowRoutes.post("/adjustments", async (req, res) => {
  const userId = getUserId(req);
  try {
    const { accountId, date, amount, description, notes } = req.body as {
      accountId: string;
      date: string;
      amount: number;
      description?: string;
      notes?: string;
    };

    if (!accountId || !date || amount == null) {
      return res.status(400).json({ error: "accountId, date, and amount are required" });
    }

    const account = await prisma.account.findFirst({ where: { id: accountId, userId } });
    if (!account) return res.status(400).json({ error: "Account not found" });

    const today = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    ));
    const adjDate = new Date(date);
    if (adjDate < today) {
      return res.status(400).json({ error: "date cannot be before today" });
    }

    const adjustment = await prisma.balanceAdjustment.create({
      data: {
        accountId,
        date: adjDate,
        amount,
        description: description ?? "Cash injection",
        notes,
      },
    });
    return res.status(201).json(adjustment);
  } catch (err) {
    console.error("Create balance adjustment error:", err);
    return res.status(500).json({ error: "Failed to create balance adjustment" });
  }
});

cashFlowRoutes.patch("/adjustments/:id", async (req, res) => {
  const userId = getUserId(req);
  try {
    const { id } = req.params;
    const { date, amount, description, notes } = req.body as {
      date?: string;
      amount?: number;
      description?: string;
      notes?: string;
    };

    const existing = await prisma.balanceAdjustment.findFirst({ where: { id, account: { userId } } });
    if (!existing) return res.status(404).json({ error: "Adjustment not found" });

    if (date !== undefined) {
      const today = new Date(Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      ));
      const adjDate = new Date(date);
      if (adjDate < today) {
        return res.status(400).json({ error: "date cannot be before today" });
      }
    }

    const adjustment = await prisma.balanceAdjustment.update({
      where: { id },
      data: {
        ...(date !== undefined && { date: new Date(date) }),
        ...(amount !== undefined && { amount }),
        ...(description !== undefined && { description }),
        ...(notes !== undefined && { notes }),
      },
    });
    return res.json(adjustment);
  } catch (err) {
    console.error("Update balance adjustment error:", err);
    return res.status(500).json({ error: "Failed to update balance adjustment" });
  }
});

cashFlowRoutes.delete("/adjustments/:id", async (req, res) => {
  const userId = getUserId(req);
  try {
    await prisma.balanceAdjustment.deleteMany({ where: { id: req.params.id, account: { userId } } });
    return res.status(204).send();
  } catch (err) {
    console.error("Delete balance adjustment error:", err);
    return res.status(500).json({ error: "Failed to delete balance adjustment" });
  }
});

// ── Projection route ──────────────────────────────────────────────────────────

cashFlowRoutes.get("/", async (req, res) => {
  const userId = getUserId(req);

  // Auto-generate upcoming recurring transfer instances (best-effort, don't block projection)
  try {
    await generateUpcomingTransfers();
  } catch (err) {
    console.error("Failed to generate upcoming transfers:", err);
  }

  try {
    const windowDays = Math.min(
      parseInt((req.query.windowDays as string) ?? "45", 10) || 45,
      180,
    );

    // Prefer the client-supplied local date (YYYY-MM-DD) so the window starts
    // on the user's "today" rather than the server's UTC date.
    const dateParam = req.query.date as string | undefined;
    const windowStart = (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam))
      ? (() => { const [y, m, d] = dateParam.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); })()
      : (() => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); })();
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + windowDays - 1);

    // Fetch all non-hidden checking accounts
    const accounts = await prisma.account.findMany({
      where: {
        userId,
        isHidden: false,
        isActive: true,
        type: "CHECKING",
      },
      select: {
        id: true,
        name: true,
        type: true,
        balance: true,
        color: true,
        isJoint: true,
        closingDay: true,
        dueDay: true,
        linkedBankAccountId: true,
        balanceUpdatedAt: true,
      },
      orderBy: [{ isJoint: "asc" }, { type: "asc" }, { name: "asc" }],
    });

    const allAccounts = await prisma.account.findMany({
      where: { userId },
      select: { id: true, name: true, color: true, type: true },
    });

    // Fetch overrides for all CC accounts that are linked to any of the
    // checking accounts in this window (not just the checking accounts themselves).
    const linkedCcIds = await prisma.account.findMany({
      where: {
        userId,
        type: "CREDIT_CARD",
        linkedBankAccountId: { in: accounts.map((a) => a.id) },
      },
      select: { id: true },
    });
    const statementOverrides = await prisma.statementOverride.findMany({
      where: {
        accountId: { in: linkedCcIds.map((a) => a.id) },
        periodStart: { lte: windowEnd },
      },
    });

    const projections = await Promise.all(
      accounts.map((a) =>
        buildProjection(a, windowStart, windowEnd, allAccounts, statementOverrides),
      ),
    );

    res.json({
      windowDays,
      windowStart: toDateStr(windowStart),
      windowEnd: toDateStr(windowEnd),
      projections,
    });
  } catch (err) {
    console.error("Cash flow projection error:", err);
    res.status(500).json({ error: "Failed to compute cash flow projection" });
  }
});
