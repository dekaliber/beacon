import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const recurrenceRoutes = Router();

const recurrenceSchema = z.object({
  description: z.string().min(1),
  vendor: z.string().optional().default(""),
  amount: z.number().refine((v) => v !== 0, "Amount cannot be zero"),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
  interval: z.number().int().positive().default(1),
  startDate: z.string().transform((s) => new Date(s)),
  endDate: z.string().transform((s) => new Date(s)).optional(),
  categoryId: z.string(),
  accountId: z.string(),
});

// Separate schema for PATCH/PUT updates: categoryId and endDate may be null
// (to clear them), and endDate is kept as a raw string so the route handler
// can apply the null-passthrough logic itself.
const recurrenceUpdateSchema = recurrenceSchema
  .omit({ startDate: true, endDate: true, categoryId: true })
  .partial()
  .extend({
    categoryId: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
  });

/**
 * Compute the next occurrence date using UTC-only arithmetic.
 * date-fns uses local time which causes off-by-one errors when
 * JS Date strings ("2026-03-01") are parsed as UTC midnight.
 */
export function computeNextOccurrence(current: Date, frequency: string, interval: number): Date {
  const y = current.getUTCFullYear();
  const m = current.getUTCMonth();
  const d = current.getUTCDate();

  switch (frequency) {
    case "DAILY":
      return new Date(Date.UTC(y, m, d + interval));
    case "WEEKLY":
      return new Date(Date.UTC(y, m, d + 7 * interval));
    case "MONTHLY": {
      const target = new Date(Date.UTC(y, m + interval, d));
      // Handle month overflow (e.g. Jan 31 + 1 month → Feb has no 31st)
      if (target.getUTCDate() !== d) {
        return new Date(Date.UTC(y, m + interval + 1, 0)); // last day of target month
      }
      return target;
    }
    case "YEARLY": {
      const target = new Date(Date.UTC(y + interval, m, d));
      if (target.getUTCDate() !== d) {
        return new Date(Date.UTC(y + interval, m + 1, 0));
      }
      return target;
    }
    default: {
      const target = new Date(Date.UTC(y, m + interval, d));
      if (target.getUTCDate() !== d) {
        return new Date(Date.UTC(y, m + interval + 1, 0));
      }
      return target;
    }
  }
}

/**
 * Generate upcoming expenses from active recurrence rules through end of next month.
 * Idempotent: skips dates that already have a generated expense for the rule.
 */
export async function generateUpcomingExpenses() {
  const now = new Date();
  const endOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0, 23, 59, 59));

  // Fetch ALL active rules so that rules with distant next occurrences still get
  // at least one pending instance created (handled below the main window loop).
  const rules = await prisma.recurrenceRule.findMany({
    where: { isActive: true },
  });

  const created = [];

  for (const rule of rules) {
    // Validate that referenced category and account still exist
    const [category, account] = await Promise.all([
      rule.categoryId ? prisma.category.findUnique({ where: { id: rule.categoryId } }) : null,
      prisma.account.findUnique({ where: { id: rule.accountId } }),
    ]);
    if (!account || (rule.categoryId && !category)) {
      // Referenced record was deleted — deactivate the rule to prevent repeated failures
      await prisma.recurrenceRule.update({
        where: { id: rule.id },
        data: { isActive: false },
      });
      continue;
    }

    let current = new Date(rule.nextOccurrence);
    let lastAdvanced = current;

    if (current > endOfNextMonth) {
      // Next occurrence is beyond the normal window — create just one pending
      // instance so the upcoming section always has something to show.
      // Don't advance nextOccurrence so the normal loop picks it up later.
      try {
        const expense = await prisma.expense.create({
          data: {
            amount: rule.amount,
            description: rule.description,
            vendor: rule.vendor,
            date: current,
            categoryId: rule.categoryId,
            accountId: rule.accountId,
            recurrenceRuleId: rule.id,
          },
        });
        created.push(expense);
      } catch (err: unknown) {
        // P2002 = unique constraint violation — another concurrent call already
        // created this instance; treat as success and move on.
        if ((err as { code?: string }).code !== "P2002") {
          console.error(`Failed to create recurring expense for rule ${rule.id}:`, err);
        }
      }
      continue;
    }

    while (current <= endOfNextMonth) {
      // Check if past end date
      if (rule.endDate && current > rule.endDate) {
        await prisma.recurrenceRule.update({
          where: { id: rule.id },
          data: { isActive: false, nextOccurrence: current },
        });
        break;
      }

      try {
        // Attempt insert directly; the unique partial index on (recurrenceRuleId, date)
        // is the authoritative guard against duplicates and is safe under concurrent
        // execution. A P2002 violation means another call already created this
        // instance — not an error, just skip and advance.
        const expense = await prisma.expense.create({
          data: {
            amount: rule.amount,
            description: rule.description,
            vendor: rule.vendor,
            date: current,
            categoryId: rule.categoryId,
            accountId: rule.accountId,
            recurrenceRuleId: rule.id,
          },
        });
        created.push(expense);
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== "P2002") {
          console.error(`Failed to create recurring expense for rule ${rule.id}:`, err);
          break;
        }
        // P2002: duplicate — already exists, continue to next date
      }

      // Advance to next occurrence
      const next = computeNextOccurrence(current, rule.frequency, rule.interval);
      lastAdvanced = next;
      current = next;
    }

    // Update rule's nextOccurrence to point past the generated window
    if (lastAdvanced > rule.nextOccurrence) {
      await prisma.recurrenceRule.update({
        where: { id: rule.id },
        data: { nextOccurrence: lastAdvanced },
      });
    }
  }

  return created;
}

// List expenses linked to a specific recurrence rule.
// Returns minimal fields needed for the delete-confirmation modal:
// id, date, amount, description, and the account name.
// Ordered by date ascending so the caller can split past vs. future easily.
recurrenceRoutes.get("/:id/expenses", async (req, res) => {
  const expenses = await prisma.expense.findMany({
    where: { recurrenceRuleId: req.params.id },
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      account: { select: { id: true, name: true } },
    },
    orderBy: { date: "asc" },
  });
  res.json(expenses);
});

// Recurring expense history for YoY comparison.
// Returns monthly totals for the last `months` calendar months (default 6) and
// the same months one year prior, using only expenses linked to a recurrence rule.
// Only positive (debit/cost) amounts are included so the chart reflects spend.
recurrenceRoutes.get("/history", async (req, res) => {
  const months = Math.min(parseInt(req.query.months as string) || 6, 24);
  const now = new Date();

  // Build date ranges (UTC-based month boundaries)
  const startThisYear = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const endThisYear   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  const startLastYear = new Date(Date.UTC(startThisYear.getUTCFullYear() - 1, startThisYear.getUTCMonth(), 1));
  const endLastYear   = new Date(Date.UTC(endThisYear.getUTCFullYear() - 1, endThisYear.getUTCMonth() + 1, 0, 23, 59, 59));

  // Shared category filter: exclude categories marked ignoreInBudget.
  // Expenses with no category (categoryId null) are always included.
  const notIgnored = {
    OR: [
      { categoryId: null },
      { category: { ignoreInBudget: false } },
    ],
  };

  const [thisYearRows, lastYearRows] = await Promise.all([
    prisma.expense.findMany({
      where: { recurrenceRuleId: { not: null }, date: { gte: startThisYear, lte: endThisYear }, ...notIgnored },
      select: { date: true, amount: true },
    }),
    prisma.expense.findMany({
      where: { recurrenceRuleId: { not: null }, date: { gte: startLastYear, lte: endLastYear }, ...notIgnored },
      select: { date: true, amount: true },
    }),
  ]);

  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Sum amounts per (year, month) bucket — debits only (amount > 0)
  const sumByYearMonth = (rows: { date: Date; amount: unknown }[]) => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const n = parseFloat(r.amount as string);
      if (n <= 0) continue;
      const k = `${r.date.getUTCFullYear()}-${r.date.getUTCMonth()}`;
      map.set(k, (map.get(k) ?? 0) + n);
    }
    return map;
  };

  const thisMap = sumByYearMonth(thisYearRows);
  const lastMap = sumByYearMonth(lastYearRows);

  // Build result ordered oldest → newest for the `months` window
  const result = Array.from({ length: months }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1 - i), 1));
    const thisKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const lastKey = `${d.getUTCFullYear() - 1}-${d.getUTCMonth()}`;
    return {
      month: MONTH_NAMES[d.getUTCMonth()],
      thisYear: Math.round((thisMap.get(thisKey) ?? 0) * 100) / 100,
      lastYear: Math.round((lastMap.get(lastKey) ?? 0) * 100) / 100,
    };
  });

  res.json(result);
});

// Upcoming recurring expenses for the next N days (default 14).
// Returns only the scalar fields needed by the UpcomingStrip component.
// Must be declared before the parameterised /:id routes.
recurrenceRoutes.get("/upcoming", async (req, res) => {
  const days = Math.min(parseInt(req.query.days as string) || 14, 60);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + days - 1);
  end.setUTCHours(23, 59, 59, 999);

  const expenses = await prisma.expense.findMany({
    where: {
      date: { gte: today, lte: end },
      recurrenceRuleId: { not: null },
    },
    select: {
      id: true,
      date: true,
      amount: true,
      vendor: true,
      description: true,
    },
    orderBy: { date: "asc" },
  });

  res.json(expenses);
});

// List recurrence rules.
// ?includeInactive=true → return only inactive (ended) rules, sorted by endDate desc.
// Default → return only active rules, sorted by startDate desc (most recently started first).
//
// Active rules include a `nextExpenseDate` field — the date of the earliest
// already-generated pending expense for that rule. This is the correct date to
// show in the "Next" column because `nextOccurrence` is advanced past the
// generation window after expenses are created, which would cause the UI to
// skip the already-generated (but not-yet-occurred) instances.
recurrenceRoutes.get("/", async (req, res) => {
  const includeInactive = req.query.includeInactive === "true";

  if (includeInactive) {
    const rules = await prisma.recurrenceRule.findMany({
      where: { isActive: false },
      orderBy: { endDate: "desc" },
    });
    return res.json(rules);
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const rules = await prisma.recurrenceRule.findMany({
    where: { isActive: true },
    orderBy: { startDate: "desc" },
    include: {
      expenses: {
        where: { date: { gte: today } },
        orderBy: { date: "asc" },
        take: 1,
        select: { date: true },
      },
    },
  });

  // Expose the earliest pending expense date as `nextExpenseDate` and strip the
  // full expenses array from the response (client only needs the scalar).
  const result = rules.map(({ expenses, ...rule }) => ({
    ...rule,
    nextExpenseDate: expenses[0]?.date?.toISOString() ?? null,
  }));

  res.json(result);
});

// Create recurrence rule
recurrenceRoutes.post("/", async (req, res) => {
  const parsed = recurrenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Set nextOccurrence to the first occurrence AFTER startDate,
  // since the initial expense for startDate is created separately.
  const firstNext = computeNextOccurrence(
    parsed.data.startDate,
    parsed.data.frequency,
    parsed.data.interval ?? 1,
  );

  const rule = await prisma.recurrenceRule.create({
    data: {
      ...parsed.data,
      nextOccurrence: firstNext,
    },
  });

  // Immediately generate upcoming expenses for this new rule
  await generateUpcomingExpenses();

  res.status(201).json(rule);
});

// Update recurrence rule
recurrenceRoutes.put("/:id", async (req, res) => {
  const parsed = recurrenceUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };
  if (typeof req.body.startDate === "string") data.startDate = new Date(req.body.startDate);
  if (typeof req.body.endDate === "string") data.endDate = new Date(req.body.endDate);
  // Allow explicitly clearing the end date by passing null
  if (req.body.endDate === null) data.endDate = null;

  const rule = await prisma.recurrenceRule.update({
    where: { id: req.params.id },
    data,
  });

  // Propagate description/amount/account/category changes to future pending expenses
  // so auto-generated instances stay in sync with the updated rule.
  const futurePatch: Record<string, unknown> = {};
  if (data.description !== undefined) futurePatch.description = data.description;
  if (data.amount !== undefined) futurePatch.amount = data.amount;
  if (data.accountId !== undefined) futurePatch.accountId = data.accountId;
  if (data.categoryId !== undefined) futurePatch.categoryId = data.categoryId;

  if (Object.keys(futurePatch).length > 0) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await prisma.expense.updateMany({
      where: { recurrenceRuleId: rule.id, date: { gt: today } },
      data: futurePatch,
    });
  }

  // If endDate was set, remove all expenses (past or future) after the new end date.
  // The client warns the user before submitting if this would affect past expenses.
  if (data.endDate) {
    await prisma.expense.deleteMany({
      where: {
        recurrenceRuleId: rule.id,
        date: { gt: data.endDate as Date },
      },
    });
  }

  // Regenerate upcoming expenses (fills any gaps if end date was extended or cleared)
  await generateUpcomingExpenses();

  res.json(rule);
});

// Archive a recurrence rule — ends it as of today without deleting history.
// Sets endDate = today and isActive = false, removes future pending expenses,
// and leaves past recorded expenses intact and linked.
recurrenceRoutes.post("/:id/archive", async (req, res) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  await prisma.recurrenceRule.update({
    where: { id: req.params.id },
    data: { endDate: today, isActive: false },
  });

  await prisma.expense.deleteMany({
    where: { recurrenceRuleId: req.params.id, date: { gt: today } },
  });

  res.status(204).send();
});

// Hard-delete a recurrence rule and clean up associated expenses.
// Past expenses are preserved but detached (recurrenceRuleId set to null).
// Future pending expenses are permanently removed.
// PostgreSQL's default Restrict FK means we must unlink expenses before deleting the rule.
recurrenceRoutes.delete("/:id", async (req, res) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // 1. Remove future pending instances — they should not exist without an active rule.
  await prisma.expense.deleteMany({
    where: { recurrenceRuleId: req.params.id, date: { gt: today } },
  });

  // 2. Detach past expenses — they represent real spending and must be preserved.
  await prisma.expense.updateMany({
    where: { recurrenceRuleId: req.params.id },
    data: { recurrenceRuleId: null },
  });

  // 3. Hard-delete the rule itself.
  await prisma.recurrenceRule.delete({ where: { id: req.params.id } });

  res.status(204).send();
});

// Process recurring expenses (generates upcoming instances)
recurrenceRoutes.post("/process", async (_req, res) => {
  const created = await generateUpcomingExpenses();
  res.json({ processed: created.length, expenses: created });
});
