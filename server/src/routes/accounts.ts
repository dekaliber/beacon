import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";

export const accountRoutes = Router();

const accountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["CHECKING", "SAVINGS", "CREDIT_CARD", "INVESTMENT"]),
  balance: z.number().default(0),
  currency: z.string().default("USD"),
  color: z.string().optional(),
  isJoint: z.boolean().optional(),
  isManaged: z.boolean().optional(),
  isTaxAdvantaged: z.boolean().optional(),
  taxAdvantageType: z.enum(["TRADITIONAL", "ROTH", "HSA", "PLAN_529"]).optional().nullable(),
  isHidden: z.boolean().optional(),
  // Balance tracking
  balanceUpdatedAt: z.string().datetime({ offset: true }).optional().nullable(),
  // Credit card settings
  closingDay: z.number().int().min(1).max(28).optional().nullable(),
  dueDay: z.number().int().min(1).max(31).optional().nullable(),
  linkedBankAccountId: z.string().optional().nullable(),
  // Investment dividend settings
  dividendElection: z.enum(["REINVEST", "CASH"]).optional().nullable(),
  defaultCashAccountId: z.string().optional().nullable(),
  // Settlement cash (investment accounts only)
  cashBalance: z.number().nonnegative().optional().nullable(),
});

// ── Account routes ──

// List all accounts
accountRoutes.get("/", async (req, res) => {
  const includeHidden = req.query.includeHidden === "true";
  const accounts = await prisma.account.findMany({
    where: { isActive: true, ...(includeHidden ? {} : { isHidden: false }) },
    orderBy: { createdAt: "asc" },
  });
  res.json(accounts);
});

// Get single account
accountRoutes.get("/:id", async (req, res) => {
  const account = await prisma.account.findUnique({
    where: { id: req.params.id },
  });
  if (!account) return res.status(404).json({ error: "Account not found" });
  res.json(account);
});

// Create account
accountRoutes.post("/", async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const account = await prisma.account.create({ data: parsed.data });
  res.status(201).json(account);
});

// Update account
accountRoutes.put("/:id", async (req, res) => {
  const parsed = accountSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const data: Record<string, unknown> = { ...parsed.data };

  // Auto-stamp balanceUpdatedAt whenever the balance field is explicitly updated
  if (parsed.data.balance !== undefined) {
    data.balanceUpdatedAt = new Date();
  }

  // Auto-stamp cashBalanceUpdatedAt whenever cashBalance is explicitly updated
  if (parsed.data.cashBalance !== undefined) {
    data.cashBalanceUpdatedAt = new Date();
  }

  const account = await prisma.account.update({
    where: { id: req.params.id },
    data,
  });
  res.json(account);
});

// Delete (soft) account
accountRoutes.delete("/:id", async (req, res) => {
  await prisma.account.update({
    where: { id: req.params.id },
    data: { isActive: false },
  });
  res.status(204).send();
});
