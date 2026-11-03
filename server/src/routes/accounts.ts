import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { clientDayOr, recordCashBalance } from "../lib/cashHistory.js";

export const accountRoutes = Router();

const accountSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["CHECKING", "SAVINGS", "CREDIT_CARD", "INVESTMENT"]),
  balance: z.coerce.number().default(0),
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
  cashBalance: z.coerce.number().nonnegative().optional().nullable(),
  // Client's local "YYYY-MM-DD" the cashBalance is as of; dates its history row.
  // Not an Account column.
  cashBalanceAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ── Account routes ──

// List all accounts
accountRoutes.get("/", async (req, res) => {
  const userId = getUserId(req);
  const includeHidden = req.query.includeHidden === "true";
  const accounts = await prisma.account.findMany({
    where: { userId, isActive: true, ...(includeHidden ? {} : { isHidden: false }) },
    orderBy: { createdAt: "asc" },
  });
  res.json(accounts);
});

// Get single account
accountRoutes.get("/:id", async (req, res) => {
  const userId = getUserId(req);
  const account = await prisma.account.findFirst({
    where: { id: req.params.id, userId },
  });
  if (!account) return res.status(404).json({ error: "Account not found" });
  res.json(account);
});

// Create account
accountRoutes.post("/", async (req, res) => {
  const userId = getUserId(req);
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { cashBalanceAsOf, ...fields } = parsed.data;
  const account = await prisma.$transaction(async (tx) => {
    const created = await tx.account.create({ data: { ...fields, userId } });
    if (fields.cashBalance != null) {
      await recordCashBalance(tx, created.id, clientDayOr(cashBalanceAsOf), "MANUAL");
    }
    return created;
  });
  res.status(201).json(account);
});

// Update account
accountRoutes.put("/:id", async (req, res) => {
  const userId = getUserId(req);
  const parsed = accountSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { cashBalanceAsOf, ...fields } = parsed.data;
  const data: Record<string, unknown> = { ...fields };

  // Auto-stamp balanceUpdatedAt whenever the balance field is explicitly updated,
  // but only if the client did not supply its own value. Clients should send the
  // local calendar date as midnight UTC (YYYY-MM-DDT00:00:00.000Z) so that the
  // cutoff comparison in the Cash Flow projection uses the user's local date
  // rather than the server's UTC date (which can differ by a day for users west
  // of UTC updating their balance in the evening).
  if (parsed.data.balance !== undefined && parsed.data.balanceUpdatedAt === undefined) {
    data.balanceUpdatedAt = new Date();
  }

  // Auto-stamp cashBalanceUpdatedAt whenever cashBalance is explicitly updated
  if (parsed.data.cashBalance !== undefined) {
    data.cashBalanceUpdatedAt = new Date();
  }

  // The prior cash balance, so an edit that leaves it unchanged adds no history row.
  const before = fields.cashBalance !== undefined
    ? await prisma.account.findFirst({
        where: { id: req.params.id, userId },
        select: { cashBalance: true },
      })
    : null;

  const updated = await prisma.$transaction(async (tx) => {
    const account = await tx.account.updateMany({
      where: { id: req.params.id, userId },
      data,
    });
    if (account.count === 0) return null;
    const prevCash = before?.cashBalance != null ? Number(before.cashBalance) : null;
    if (before && prevCash !== (fields.cashBalance ?? null)) {
      await recordCashBalance(tx, req.params.id, clientDayOr(cashBalanceAsOf), "MANUAL");
    }
    return tx.account.findUnique({ where: { id: req.params.id } });
  });
  if (!updated) return res.status(404).json({ error: "Account not found" });
  res.json(updated);
});

// Delete (soft) account
accountRoutes.delete("/:id", async (req, res) => {
  const userId = getUserId(req);
  await prisma.account.updateMany({
    where: { id: req.params.id, userId },
    data: { isActive: false },
  });
  res.status(204).send();
});
