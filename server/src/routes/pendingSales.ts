import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { deactivateIfOrphaned } from "./instruments.js";
import { computeSell, serializeActivity } from "./investments.js";

export const pendingSaleRoutes = Router();

// ── List ───────────────────────────────────────────────────────────────────────

pendingSaleRoutes.get("/:accountId", async (req, res) => {
  const userId = getUserId(req);
  const { accountId } = req.params;

  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });
  if (!account) return res.status(404).json({ error: "Account not found" });

  const pendingSales = await prisma.pendingSale.findMany({
    where: { accountId, userId, status: "PENDING" },
    include: { optionsPosition: { include: { ticker: true } } },
    orderBy: { createdAt: "asc" },
  });

  res.json(pendingSales);
});

// ── Confirm ────────────────────────────────────────────────────────────────────

const confirmSchema = z.object({
  saleDate: z.string(), // YYYY-MM-DD
  pricePerShare: z.coerce.number().positive(),
  // Either costBasisMethod OR lotAllocations must be provided
  costBasisMethod: z.enum(["FIFO", "LIFO", "MIN_TAX", "MAX_GAIN"]).optional(),
  lotAllocations: z.array(z.object({
    lotId: z.string(),
    shares: z.number().positive(),
  })).optional(),
  destinationAccountId: z.string(),
  notes: z.string().optional(),
});

pendingSaleRoutes.post("/:id/confirm", async (req, res) => {
  const userId = getUserId(req);
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!parsed.data.costBasisMethod && !parsed.data.lotAllocations) {
    return res.status(400).json({ error: { message: "Either costBasisMethod or lotAllocations must be provided" } });
  }

  const pendingSale = await prisma.pendingSale.findFirst({
    where: { id: req.params.id, userId, status: "PENDING" },
    include: { optionsPosition: { include: { ticker: true } } },
  });
  if (!pendingSale) return res.status(404).json({ error: "Pending sale not found" });

  const { saleDate: saleDateStr, pricePerShare, costBasisMethod, lotAllocations, destinationAccountId, notes } = parsed.data;
  const saleDate = new Date(saleDateStr + "T20:00:00.000Z");
  const sharesToSell = Number(pendingSale.quantity);

  // Validate destination account
  const destAccount = await prisma.account.findFirst({ where: { id: destinationAccountId, userId } });
  if (!destAccount) return res.status(404).json({ error: { message: "Destination account not found" } });
  if (destAccount.type === "CREDIT_CARD") return res.status(400).json({ error: { message: "Destination account cannot be a credit card" } });

  // Find holding for this ticker in the investment account
  const holding = await prisma.investmentHolding.findFirst({
    where: { accountId: pendingSale.accountId, ticker: pendingSale.ticker },
    include: { lots: true, account: { select: { isTaxAdvantaged: true } } },
  });
  if (!holding) return res.status(404).json({ error: { message: `No holding found for ${pendingSale.ticker} in this account` } });

  // Only lots acquired on or before the sale date are eligible
  const eligibleLots = holding.lots.filter(
    (l) => l.acquiredDate == null || l.acquiredDate <= saleDate
  );

  if (lotAllocations) {
    const eligibleIds = new Set(eligibleLots.map((l) => l.id));
    if (lotAllocations.some((a) => !eligibleIds.has(a.lotId))) {
      return res.status(400).json({ error: { message: "One or more selected lots were purchased after the sale date." } });
    }
  }

  const totalQty = eligibleLots.reduce((sum, l) => sum + parseFloat(l.quantity.toString()), 0);
  if (sharesToSell > totalQty + 0.000001) {
    return res.status(400).json({
      error: { message: `Cannot sell ${sharesToSell} shares; only ${totalQty} available from lots acquired on or before the sale date` },
    });
  }

  const calc = computeSell(
    eligibleLots,
    sharesToSell,
    pricePerShare,
    saleDate,
    0, // fees already baked into pricePerShare (strike + premium − fees/share)
    costBasisMethod,
    lotAllocations
  );

  const grossProceeds = Math.round(calc.grossProceeds * 100) / 100;
  const netProceeds = Math.round(calc.netProceeds * 100) / 100;
  const stGain = Math.round(calc.stGain * 100) / 100;
  const ltGain = Math.round(calc.ltGain * 100) / 100;
  const totalGain = stGain + ltGain;

  const lotSharesMap = new Map<string, number>();
  for (const alloc of calc.lotBreakdown) {
    lotSharesMap.set(alloc.lotId, alloc.shares);
  }

  const result = await prisma.$transaction(async (tx) => {
    // 1. Mutate lots
    const holdingLots = await tx.investmentLot.findMany({ where: { holdingId: holding.id } });
    for (const lot of holdingLots) {
      const soldShares = lotSharesMap.get(lot.id) ?? 0;
      if (soldShares === 0) continue;
      const remaining = parseFloat(lot.quantity.toString()) - soldShares;
      if (remaining < 0.000001) {
        await tx.investmentLot.delete({ where: { id: lot.id } });
      } else {
        await tx.investmentLot.update({
          where: { id: lot.id },
          data: { quantity: remaining },
        });
      }
    }

    // 2. Check if holding is now empty; delete if so
    const remainingLots = await tx.investmentLot.count({ where: { holdingId: holding.id } });
    const holdingDeleted = remainingLots === 0;
    if (holdingDeleted) {
      await tx.investmentHolding.delete({ where: { id: holding.id } });
      await deactivateIfOrphaned(tx, holding.instrumentId);
    }

    // 3. Create InvestmentActivity (SALE)
    const activity = await tx.investmentActivity.create({
      data: {
        accountId: holding.accountId,
        holdingId: holdingDeleted ? null : holding.id,
        ticker: holding.ticker,
        type: "SALE",
        date: saleDate,
        shares: sharesToSell,
        pricePerShare,
        amount: grossProceeds,
        costBasis: Math.round(calc.totalCostBasis * 100) / 100,
        shortTermGain: stGain,
        longTermGain: ltGain,
        notes: notes ?? null,
        updatedAt: new Date(),
      },
    });

    // 4. Create Income record for taxable accounts.
    // taxableAmount = totalGain (already includes the option premium since pricePerShare
    // was pre-filled as strike + premiumPerShare). The premium's own income record
    // has taxableAmount = 0 so there is no double-counting.
    let income = null;
    if (!holding.account.isTaxAdvantaged) {
      income = await tx.income.create({
        data: {
          amount: netProceeds,
          subtype: "CAPITAL_GAIN",
          taxClassification: "CAPITAL_GAIN",
          taxableAmount: totalGain,
          source: holding.ticker,
          date: saleDate,
          accountId: destinationAccountId,
          activityId: activity.id,
          notes: notes ?? null,
          updatedAt: new Date(),
        },
        include: {
          account: true,
          category: true,
          tags: { include: { tag: true } },
          transactionGroup: true,
          activity: true,
        },
      });
    }

    // 5. Confirm the pending sale
    const confirmed = await tx.pendingSale.update({
      where: { id: pendingSale.id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        activityId: activity.id,
        pricePerShare,
        saleDate,
      },
      include: { optionsPosition: { include: { ticker: true } } },
    });

    // 6. Adjust cash balance if it predates the sale date.
    // Proceeds = strikePrice × shares (the premium was settled at contract open).
    const account = await tx.account.findUnique({
      where: { id: pendingSale.accountId },
      select: { cashBalance: true, cashBalanceUpdatedAt: true },
    });
    const pos = pendingSale.optionsPosition;
    if (
      account?.cashBalance != null &&
      account.cashBalanceUpdatedAt != null &&
      account.cashBalanceUpdatedAt < pos.expirationDate
    ) {
      const shares = (pos.contractsAssigned ?? pos.contracts) * 100;
      const proceeds = Number(pos.strikePrice) * shares;
      await tx.account.update({
        where: { id: pendingSale.accountId },
        data: { cashBalance: { increment: proceeds } },
      });
    }

    return { pendingSale: confirmed, activity: serializeActivity(activity), income, holdingDeleted };
  });

  res.json(result);
});

// ── Dismiss ────────────────────────────────────────────────────────────────────

pendingSaleRoutes.post("/:id/dismiss", async (req, res) => {
  const userId = getUserId(req);

  const pendingSale = await prisma.pendingSale.findFirst({
    where: { id: req.params.id, userId, status: "PENDING" },
  });
  if (!pendingSale) return res.status(404).json({ error: "Pending sale not found" });

  const dismissed = await prisma.pendingSale.update({
    where: { id: pendingSale.id },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });

  res.json(dismissed);
});
