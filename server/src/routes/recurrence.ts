import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { addDays, addWeeks, addMonths, addYears } from "date-fns";

export const recurrenceRoutes = Router();

const recurrenceSchema = z.object({
  description: z.string().min(1),
  vendor: z.string().optional().default(""),
  amount: z.number().positive(),
  frequency: z.enum(["DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"]),
  interval: z.number().int().positive().default(1),
  startDate: z.string().transform((s) => new Date(s)),
  endDate: z.string().transform((s) => new Date(s)).optional(),
  categoryId: z.string(),
  accountId: z.string(),
});

export function computeNextOccurrence(current: Date, frequency: string, interval: number): Date {
  switch (frequency) {
    case "DAILY": return addDays(current, interval);
    case "WEEKLY": return addWeeks(current, interval);
    case "BIWEEKLY": return addWeeks(current, interval * 2);
    case "MONTHLY": return addMonths(current, interval);
    case "QUARTERLY": return addMonths(current, interval * 3);
    case "YEARLY": return addYears(current, interval);
    default: return addMonths(current, interval);
  }
}

/**
 * Generate upcoming expenses from active recurrence rules through end of next month.
 * Idempotent: skips dates that already have a generated expense for the rule.
 */
export async function generateUpcomingExpenses() {
  const now = new Date();
  const endOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59);

  const rules = await prisma.recurrenceRule.findMany({
    where: {
      isActive: true,
      nextOccurrence: { lte: endOfNextMonth },
    },
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
  today.setHours(0, 0, 0, 0);
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
