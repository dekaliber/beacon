import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { fetchYahooMeta } from "../services/yahoo.js";

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

  // All assigned CSPs for this ticker + account. Match either by the CSP's
  // investmentAccountId (the original account) or by lot location (handles
  // cases where shares were transferred to a different account after assignment).
  const assignedCsps = await prisma.optionsPosition.findMany({
    where: {
      userId,
      optionType: "PUT",
      outcome: "ASSIGNED",
      isActive: true,
      ticker: { symbol: ticker },
      OR: [
        { investmentAccountId: accountId },
        { assignedLots: { some: { holding: { accountId, ticker } } } },
      ],
    },
    select: {
      id: true,
      strikePrice: true,
      expirationDate: true,
      contractsAssigned: true,
      contracts: true,
    },
  });

  if (assignedCsps.length === 0) return res.json([]);

  // Group by strikePrice + expirationDate, collecting position IDs per batch
  type BatchKey = string;
  const batchMap = new Map<BatchKey, {
    strikePrice: string;
    expirationDate: string;
    totalContracts: number;
    positionIds: string[];
  }>();

  for (const csp of assignedCsps) {
    const expStr = csp.expirationDate.toISOString().split("T")[0];
    const key: BatchKey = `${csp.strikePrice}|${expStr}`;
    const existing = batchMap.get(key);
    const contracts = csp.contractsAssigned ?? csp.contracts;
    if (existing) {
      existing.totalContracts += contracts;
      existing.positionIds.push(csp.id);
    } else {
      batchMap.set(key, {
        strikePrice: csp.strikePrice.toString(),
        expirationDate: expStr,
        totalContracts: contracts,
        positionIds: [csp.id],
      });
    }
  }

  // For each batch, count open CC contracts and compute weighted avg cost basis
  const batches = await Promise.all(
    Array.from(batchMap.values()).map(async (batch) => {
      const expDate = new Date(batch.expirationDate + "T20:00:00.000Z");

      const [openCcs, lots] = await Promise.all([
        prisma.optionsPosition.aggregate({
          where: {
            userId,
            optionType: "CALL",
            status: "OPEN",
            isActive: true,
            ticker: { symbol: ticker },
            assignedFromStrikePrice: parseFloat(batch.strikePrice),
            assignedFromExpirationDate: expDate,
          },
          _sum: { contracts: true },
        }),
        prisma.investmentLot.findMany({
          where: {
            fromOptionsPositionId: { in: batch.positionIds },
            holding: { accountId, ticker },
          },
          select: { quantity: true, costPerShare: true },
        }),
      ]);

      const contractsCovered = openCcs._sum.contracts ?? 0;

      // Weighted average: SUM(qty * cost) / SUM(qty)
      let weightedCostPerShare: number | null = null;
      let totalLotShares = 0;
      if (lots.length > 0) {
        let totalCost = 0;
        for (const lot of lots) {
          const qty = Number(lot.quantity);
          totalLotShares += qty;
          totalCost += qty * Number(lot.costPerShare);
        }
        weightedCostPerShare = totalLotShares > 0 ? totalCost / totalLotShares : null;
      }

      // Use actual lot shares as the cap — shares sold outside the normal CC
      // assignment flow (e.g. a CC that was subsequently assigned) will have
      // reduced/deleted the lot, so lot quantity is ground truth for availability.
      const lotBasedContracts = Math.floor(totalLotShares / 100);
      const contractsRemaining = Math.max(0, Math.min(lotBasedContracts, batch.totalContracts) - contractsCovered);

      if (contractsRemaining === 0 && contractsCovered === 0) return null;

      return {
        strikePrice: batch.strikePrice,
        expirationDate: batch.expirationDate,
        totalContracts: batch.totalContracts,
        totalShares: batch.totalContracts * 100,
        contractsCovered,
        contractsRemaining,
        weightedCostPerShare,
      };
    })
  );

  // Filter out batches with no shares remaining, then sort by strikePrice desc, expirationDate desc
  const activeBatches = batches.filter((b) => b !== null);
  activeBatches.sort((a, b) =>
    parseFloat(b.strikePrice) - parseFloat(a.strikePrice) ||
    b.expirationDate.localeCompare(a.expirationDate)
  );

  res.json(activeBatches);
});
