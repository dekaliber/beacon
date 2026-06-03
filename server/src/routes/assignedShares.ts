import { Router } from "express";
import { prisma } from "../db/client.js";
import { getUserId } from "../middleware/auth.js";

export const assignedSharesRoutes = Router();

// ── GET /api/assigned-shares/active ────────────────────────────────────────
// Stock currently held that was acquired via an assigned cash-secured put.
// One row per surviving CSP-originated lot. Current price is fetched
// client-side via the existing quotes endpoint; P&L is premium-excluded:
// (currentPrice - assignmentStrike) * shares.
assignedSharesRoutes.get("/active", async (req, res) => {
  const userId = getUserId(req);

  const lots = await prisma.investmentLot.findMany({
    where: {
      fromOptionsPositionId: { not: null },
      holding: { account: { userId } },
    },
    select: {
      id: true,
      quantity: true,
      acquiredDate: true,
      fromOptionsPositionId: true,
      holding: {
        select: {
          ticker: true,
          accountId: true,
          account: { select: { name: true } },
        },
      },
      fromOptionsPosition: {
        select: { strikePrice: true, expirationDate: true },
      },
    },
    orderBy: { acquiredDate: "asc" },
  });

  const rows = lots
    .filter((l) => l.fromOptionsPosition !== null)
    .map((l) => ({
      lotId: l.id,
      ticker: l.holding.ticker,
      accountId: l.holding.accountId,
      accountName: l.holding.account?.name ?? null,
      shares: Number(l.quantity),
      assignmentStrike: Number(l.fromOptionsPosition!.strikePrice),
      assignmentExpiration: l.fromOptionsPosition!.expirationDate
        .toISOString()
        .slice(0, 10),
      acquiredDate: l.acquiredDate ? l.acquiredDate.toISOString().slice(0, 10) : null,
      fromOptionsPositionId: l.fromOptionsPositionId,
    }));

  res.json(rows);
});

// ── GET /api/assigned-shares/realized ──────────────────────────────────────
// Sales of CSP-originated shares (covered-call assignment OR direct sale).
// Premium-excluded realized P&L = (salePricePerShare - assignmentStrike) * shares.
assignedSharesRoutes.get("/realized", async (req, res) => {
  const userId = getUserId(req);

  const dispositions = await prisma.assignedShareDisposition.findMany({
    where: { userId },
    orderBy: { saleDate: "desc" },
  });

  let netRealizedPnl = 0;
  const rows = dispositions.map((d) => {
    const shares = Number(d.shares);
    const assignmentStrike = Number(d.assignmentStrike);
    const salePricePerShare = Number(d.salePricePerShare);
    const realizedPnl =
      Math.round((salePricePerShare - assignmentStrike) * shares * 100) / 100;
    netRealizedPnl += realizedPnl;
    return {
      id: d.id,
      ticker: d.ticker,
      accountId: d.accountId,
      shares,
      assignmentStrike,
      assignmentExpiration: d.assignmentExpiration.toISOString().slice(0, 10),
      salePricePerShare,
      realizedPnl,
      saleDate: d.saleDate.toISOString().slice(0, 10),
      viaCoveredCall: d.soldViaPositionId !== null,
    };
  });

  res.json({
    rows,
    netRealizedPnl: Math.round(netRealizedPnl * 100) / 100,
  });
});
