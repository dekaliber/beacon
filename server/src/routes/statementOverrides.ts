import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";

export const statementOverrideRoutes = Router();

const overrideSchema = z.object({
  accountId: z.string(),
  periodStart: z.string(), // YYYY-MM-DD
  periodEnd: z.string(),   // YYYY-MM-DD
  amount: z.number().nonnegative(),
  notes: z.string().optional().nullable(),
});

// List all overrides for a given CC account
statementOverrideRoutes.get("/:accountId", async (req, res) => {
  const userId = getUserId(req);
  const account = await prisma.account.findFirst({ where: { id: req.params.accountId, userId } });
  if (!account) return res.status(404).json({ error: "Account not found" });
  const overrides = await prisma.statementOverride.findMany({
    where: { accountId: req.params.accountId },
    orderBy: { periodStart: "desc" },
  });
  res.json(overrides);
});

// Create an override
statementOverrideRoutes.post("/", async (req, res) => {
  const userId = getUserId(req);
  const parsed = overrideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { periodStart, periodEnd, ...rest } = parsed.data;

  const account = await prisma.account.findFirst({ where: { id: rest.accountId, userId } });
  if (!account) return res.status(400).json({ error: "Account not found" });

  const override = await prisma.statementOverride.upsert({
    where: {
      accountId_periodStart: {
        accountId: rest.accountId,
        periodStart: new Date(periodStart),
      },
    },
    create: {
      ...rest,
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
    },
    update: {
      periodEnd: new Date(periodEnd),
      amount: rest.amount,
      notes: rest.notes ?? null,
    },
  });

  res.status(201).json(override);
});

// Update an override
statementOverrideRoutes.put("/:id", async (req, res) => {
  const userId = getUserId(req);
  const parsed = overrideSchema.partial().omit({ accountId: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.statementOverride.findFirst({ where: { id: req.params.id, account: { userId } } });
  if (!existing) return res.status(404).json({ error: "Override not found" });

  const { periodStart, periodEnd, ...rest } = parsed.data;
  const override = await prisma.statementOverride.update({
    where: { id: req.params.id },
    data: {
      ...rest,
      ...(periodStart !== undefined && { periodStart: new Date(periodStart) }),
      ...(periodEnd !== undefined && { periodEnd: new Date(periodEnd) }),
    },
  });

  res.json(override);
});

// Delete an override
statementOverrideRoutes.delete("/:id", async (req, res) => {
  const userId = getUserId(req);
  await prisma.statementOverride.deleteMany({ where: { id: req.params.id, account: { userId } } });
  res.status(204).send();
});
