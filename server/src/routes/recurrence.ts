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

function computeNextOccurrence(current: Date, frequency: string, interval: number): Date {
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

  const rule = await prisma.recurrenceRule.create({
    data: {
      ...parsed.data,
      nextOccurrence: parsed.data.startDate,
    },
  });
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
  await prisma.recurrenceRule.update({
    where: { id: req.params.id },
    data: { isActive: false },
  });
  res.status(204).send();
});

// Process due recurring expenses (generates expense records)
recurrenceRoutes.post("/process", async (_req, res) => {
  const now = new Date();
  const dueRules = await prisma.recurrenceRule.findMany({
    where: {
      isActive: true,
      nextOccurrence: { lte: now },
    },
  });

  const created = [];
  for (const rule of dueRules) {
    // Create expense from rule
    const expense = await prisma.expense.create({
      data: {
        amount: rule.amount,
        description: rule.description,
        vendor: rule.vendor,
        date: rule.nextOccurrence,
        categoryId: rule.categoryId,
        accountId: rule.accountId,
        recurrenceRuleId: rule.id,
      },
    });
    created.push(expense);

    // Compute next occurrence
    const next = computeNextOccurrence(rule.nextOccurrence, rule.frequency, rule.interval);

    // Deactivate if past end date
    const isExpired = rule.endDate && next > rule.endDate;

    await prisma.recurrenceRule.update({
      where: { id: rule.id },
      data: {
        nextOccurrence: next,
        isActive: !isExpired,
      },
    });
  }

  res.json({ processed: created.length, expenses: created });
});
