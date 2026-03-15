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
      const existing = await prisma.expense.findFirst({
        where: { recurrenceRuleId: rule.id, date: current },
      });
      if (!existing) {
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
        } catch (err) {
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

      // Check for existing expense to prevent duplicates
      const existing = await prisma.expense.findFirst({
        where: {
          recurrenceRuleId: rule.id,
          date: current,
        },
      });

      if (!existing) {
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
        } catch (err) {
          console.error(`Failed to create recurring expense for rule ${rule.id}:`, err);
          break;
        }
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

// List recurrence rules
recurrenceRoutes.get("/", async (_req, res) => {
  const rules = await prisma.recurrenceRule.findMany({
    where: { isActive: true },
    orderBy: { nextOccurrence: "asc" },
  });
  res.json(rules);
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
  const parsed = recurrenceSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };
  if (typeof req.body.startDate === "string") data.startDate = new Date(req.body.startDate);
  if (typeof req.body.endDate === "string") data.endDate = new Date(req.body.endDate);

  const rule = await prisma.recurrenceRule.update({
    where: { id: req.params.id },
    data,
  });

  // If endDate was changed, remove future expenses past the new end date
  if (data.endDate) {
    await prisma.expense.deleteMany({
      where: {
        recurrenceRuleId: rule.id,
        date: { gt: data.endDate as Date },
      },
    });
  }

  // Regenerate upcoming expenses (fills any gaps if end date was extended)
  await generateUpcomingExpenses();

  res.json(rule);
});

// Delete (deactivate) recurrence rule
recurrenceRoutes.delete("/:id", async (req, res) => {
  // Deactivate the rule
  await prisma.recurrenceRule.update({
    where: { id: req.params.id },
    data: { isActive: false },
  });

  // Delete any future pending expenses generated from this rule
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  await prisma.expense.deleteMany({
    where: {
      recurrenceRuleId: req.params.id,
      date: { gt: today },
    },
  });

  res.status(204).send();
});

// Process recurring expenses (generates upcoming instances)
recurrenceRoutes.post("/process", async (_req, res) => {
  const created = await generateUpcomingExpenses();
  res.json({ processed: created.length, expenses: created });
});
