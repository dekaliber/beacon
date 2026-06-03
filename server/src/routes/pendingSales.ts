import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { deactivateIfOrphaned } from "./instruments.js";
import { computeSell, serializeActivity, recordAssignedShareDispositions } from "./investments.js";

export const pendingSaleRoutes = Router();

// ── List ───────────────────────────────────────────────────────────────────────

pendingSaleRoutes.get("/:accountId", async (req, res) => {
  const userId = getUserId(req);
  const { accountId } = req.params;

  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });
  if (!account) return res.status(404).json({ error: "Account not found" });

  const pendingSales = await prisma.pendingSale.findMany({
    where: { accountId, userId, status: "PENDING" },
    include: {
      optionsPosition: {
        include: { ticker: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // For each pending sale whose covered call was written against a specific assigned
  // lot batch, resolve the InvestmentLot IDs so the review modal can pre-select them.
  const enriched = await Promise.all(
    pendingSales.map(async (ps) => {
      const pos = ps.optionsPosition;
      const { assignedFromStrikePrice, assignedFromExpirationDate } = pos;

      let suggestedLotIds: string[] = [];

      if (assignedFromStrikePrice != null && assignedFromExpirationDate != null) {
        // Find the CSP position(s) that created the underlying batch
        const cspPositions = await prisma.optionsPosition.findMany({
          where: {
            userId,
            optionType: "PUT",
            outcome: "ASSIGNED",
            isActive: true,
            investmentAccountId: accountId,
            ticker: { symbol: ps.ticker },
            strikePrice: assignedFromStrikePrice,
            expirationDate: assignedFromExpirationDate,
          },
          select: { id: true },
        });
        const cspIds = cspPositions.map((c) => c.id);

        if (cspIds.length > 0) {
          const lots = await prisma.investmentLot.findMany({
            where: {
              fromOptionsPositionId: { in: cspIds },
              holding: { accountId, ticker: ps.ticker },
            },
            select: { id: true },
          });
          suggestedLotIds = lots.map((l) => l.id);
        }
      }

      return {
        ...ps,
        optionsPosition: {
          ...pos,
          assignedFromStrikePrice: pos.assignedFromStrikePrice?.toString() ?? null,
          assignedFromExpirationDate: pos.assignedFromExpirationDate
            ? pos.assignedFromExpirationDate.toISOString().split("T")[0]
            : null,
        },
        suggestedLotIds,
      };
    })
  );

  res.json(enriched);
});

// ── Confirm ────────────────────────────────────────────────────────────────────

const confirmSchema = z.object({
  saleDate: z.string(), // YYYY-MM-DD
  pricePerShare: z.coerce.number().positive(),
  fees: z.coerce.number().nonnegative().default(0),
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

  const { saleDate: saleDateStr, pricePerShare, fees: saleFees, costBasisMethod, lotAllocations, destinationAccountId, notes } = parsed.data;
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

  // pricePerShare is the composite (strike + premiumNet). Pass actual saleFees so
  // computeSell correctly deducts them from the gain.
  const calc = computeSell(
    eligibleLots,
    sharesToSell,
    pricePerShare,
    saleDate,
    saleFees,
    costBasisMethod,
    lotAllocations
  );

  // Gross proceeds for the SALE activity = strike × shares only (option premium
  // was already recorded as a separate "Options Premium" income entry).
  const strikeGrossProceeds = Math.round(Number(pendingSale.optionsPosition.strikePrice) * sharesToSell * 100) / 100;
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
    const feesStored = saleFees > 0 ? Math.round(saleFees * 100) / 100 : null;
    const activity = await tx.investmentActivity.create({
      data: {
        accountId: holding.accountId,
        holdingId: holdingDeleted ? null : holding.id,
        ticker: holding.ticker,
        type: "SALE",
        date: saleDate,
        shares: sharesToSell,
        pricePerShare,
        amount: strikeGrossProceeds,
        fees: feesStored,
        costBasis: Math.round(calc.totalCostBasis * 100) / 100,
        shortTermGain: stGain,
        longTermGain: ltGain,
        notes: notes ?? null,
        updatedAt: new Date(),
      },
    });

    // 3b. Record assigned-share dispositions for any CSP-originated lots called
    // away. Premium-excluded sale price = the covered-call strike (NOT
    // pendingSale.pricePerShare, which is the composite incl. premium).
    await recordAssignedShareDispositions(tx, {
      userId,
      saleActivityId: activity.id,
      accountId: holding.accountId,
      ticker: holding.ticker,
      saleDate,
      soldViaPositionId: pendingSale.optionsPositionId,
      salePricePerShare: Number(pendingSale.optionsPosition.strikePrice),
      lotBreakdown: calc.lotBreakdown,
      lots: holding.lots,
    });

    // 4. Create Income record for taxable accounts.
    // amount  = strike × shares − saleFees  (cash-flow view: excludes the option
    //           premium since that was already recorded as a separate income entry)
    // taxableAmount = totalGain = (composite × shares − saleFees) − costBasis
    //   where composite = strike + premiumPerShare − optionFees/share
    //   This equals (strike×shares − saleFees − costBasis) + (premium×shares − optionFees),
    //   i.e. net proceeds minus cost basis plus option premium net of option fees. ✓
    const saleProceeds = Math.round((Number(pendingSale.optionsPosition.strikePrice) * sharesToSell - saleFees) * 100) / 100;
    let income = null;
    if (!holding.account.isTaxAdvantaged) {
      income = await tx.income.create({
        data: {
          amount: saleProceeds,
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
