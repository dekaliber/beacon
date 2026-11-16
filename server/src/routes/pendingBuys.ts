import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { recordCashBalance } from "../lib/cashHistory.js";
import { fetchYahooMeta } from "../services/yahoo.js";
import { getAssignedBatches } from "../lib/assignedBatches.js";

export const pendingBuyRoutes = Router();

// ── List ───────────────────────────────────────────────────────────────────────

pendingBuyRoutes.get("/:accountId", async (req, res) => {
  const userId = getUserId(req);

  // Verify account belongs to user
  const account = await prisma.account.findFirst({
    where: { id: req.params.accountId, userId },
  });
  if (!account) return res.status(404).json({ error: "Account not found" });

  const pendingBuys = await prisma.pendingBuy.findMany({
    where: { accountId: req.params.accountId, status: "PENDING" },
    include: { optionsPosition: { include: { ticker: true } } },
    orderBy: { createdAt: "desc" },
  });

  res.json(pendingBuys);
});

// ── Confirm ────────────────────────────────────────────────────────────────────

const confirmSchema = z.object({
  acquiredDate: z.string(), // YYYY-MM-DD
  quantity: z.coerce.number().positive(),
  costPerShare: z.coerce.number().nonnegative(),
  notes: z.string().nullable().optional(),
});

pendingBuyRoutes.post("/:id/confirm", async (req, res) => {
  const userId = getUserId(req);
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const pendingBuy = await prisma.pendingBuy.findFirst({
    where: { id: req.params.id, userId, status: "PENDING" },
    include: { optionsPosition: { include: { ticker: true } } },
  });
  if (!pendingBuy) return res.status(404).json({ error: "Pending buy not found" });

  const { acquiredDate, quantity, costPerShare, notes } = parsed.data;
  const acquiredAt = new Date(acquiredDate + "T20:00:00.000Z"); // treat as date-only (4pm ET)
  const amount = Math.round(quantity * costPerShare * 100) / 100;

  // Resolve the display name/type up front (outside the transaction, since it's a
  // network call) so a holding created from this assignment shows the company name
  // rather than just the ticker. Only needed when the holding doesn't already exist.
  const existingHolding = await prisma.investmentHolding.findFirst({
    where: { accountId: pendingBuy.accountId, ticker: pendingBuy.ticker },
    select: { id: true },
  });
  const meta = existingHolding ? null : await fetchYahooMeta(pendingBuy.ticker);

  const result = await prisma.$transaction(async (tx) => {
    // Find or create holding for this ticker in this account
    let holding = await tx.investmentHolding.findFirst({
      where: { accountId: pendingBuy.accountId, ticker: pendingBuy.ticker },
    });
    if (!holding) {
      holding = await tx.investmentHolding.create({
        data: {
          accountId: pendingBuy.accountId,
          ticker: pendingBuy.ticker,
          name: meta?.name ?? pendingBuy.ticker,
          type: meta?.type ?? null,
        },
      });
    }

    // Create the lot (with back-link to the options position)
    const lot = await tx.investmentLot.create({
      data: {
        holdingId: holding.id,
        quantity,
        costPerShare,
        acquiredDate: acquiredAt,
        fromOptionsPositionId: pendingBuy.optionsPositionId,
      },
    });

    // Create the linked PURCHASE activity
    const activity = await tx.investmentActivity.create({
      data: {
        accountId: pendingBuy.accountId,
        holdingId: holding.id,
        lotId: lot.id,
        ticker: pendingBuy.ticker,
        type: "PURCHASE",
        date: acquiredAt,
        shares: quantity,
        pricePerShare: costPerShare,
        amount,
        notes: notes ?? null,
      },
    });

    // Confirm the pending buy
    const confirmed = await tx.pendingBuy.update({
      where: { id: pendingBuy.id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        lotId: lot.id,
        quantity,
        costPerShare,
        acquiredDate: acquiredAt,
      },
      include: { optionsPosition: { include: { ticker: true } } },
    });

    // Adjust settlement balance if it predates the assignment date.
    // Use strike × shares (not cost basis) since the premium is already captured on
    // the options side. Use the user-confirmed share count so the deduction matches
    // the "Amount Deducted from Cash" figure shown in the review modal.
    const account = await tx.account.findUnique({
      where: { id: pendingBuy.accountId },
      select: { cashBalance: true, cashBalanceUpdatedAt: true },
    });
    const pos = pendingBuy.optionsPosition;
    if (
      account?.cashBalance != null &&
      account.cashBalanceUpdatedAt != null &&
      account.cashBalanceUpdatedAt < pos.expirationDate
    ) {
      const deduction = Number(pos.strikePrice) * quantity;
      await tx.account.update({
        where: { id: pendingBuy.accountId },
        data: { cashBalance: { decrement: deduction } },
      });
      await recordCashBalance(tx, pendingBuy.accountId, acquiredDate, "OPTION_ASSIGNMENT");
    }

    return { pendingBuy: confirmed, lot, activity };
  });

  res.json(result);
});

// ── Dismiss ────────────────────────────────────────────────────────────────────

pendingBuyRoutes.post("/:id/dismiss", async (req, res) => {
  const userId = getUserId(req);

  const pendingBuy = await prisma.pendingBuy.findFirst({
    where: { id: req.params.id, userId, status: "PENDING" },
  });
  if (!pendingBuy) return res.status(404).json({ error: "Pending buy not found" });

  const dismissed = await prisma.pendingBuy.update({
    where: { id: req.params.id },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });

  res.json(dismissed);
});

// ── Lots from options assignments (for CC position modal) ──────────────────────

pendingBuyRoutes.get("/lots/by-assignment", async (req, res) => {
  const userId = getUserId(req);
  const { ticker, accountId } = req.query as { ticker?: string; accountId?: string };

  if (!ticker || !accountId) {
    return res.status(400).json({ error: "ticker and accountId are required" });
  }

  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });
  if (!account) return res.status(404).json({ error: "Account not found" });

  res.json(await getAssignedBatches(prisma, userId, ticker, accountId));
});
