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

  const [lots, openCalls] = await Promise.all([
    prisma.investmentLot.findMany({
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
            account: { select: { name: true, color: true } },
          },
        },
        fromOptionsPosition: {
          select: { strikePrice: true, expirationDate: true },
        },
      },
      orderBy: { acquiredDate: "asc" },
    }),
    // Open covered calls written against an assigned batch, keyed by the original
    // CSP strike/expiry they recover (assignedFrom*). Used to show how much of a
    // lot is currently covered by an outstanding CC.
    prisma.optionsPosition.findMany({
      where: {
        userId,
        optionType: "CALL",
        status: "OPEN",
        isActive: true,
        assignedFromStrikePrice: { not: null },
        assignedFromExpirationDate: { not: null },
      },
      select: {
        contracts: true,
        investmentAccountId: true,
        assignedFromStrikePrice: true,
        assignedFromExpirationDate: true,
        ticker: { select: { symbol: true } },
      },
    }),
  ]);

  // batchKey = ticker | strike | expiry(YYYY-MM-DD) | accountId
  const batchKey = (ticker: string, strike: number, expiry: string, accountId: string) =>
    `${ticker}|${strike}|${expiry}|${accountId}`;

  const openCallContractsByBatch = new Map<string, number>();
  for (const cc of openCalls) {
    if (cc.assignedFromStrikePrice == null || cc.assignedFromExpirationDate == null) continue;
    if (cc.investmentAccountId == null) continue;
    const key = batchKey(
      cc.ticker.symbol,
      Number(cc.assignedFromStrikePrice),
      cc.assignedFromExpirationDate.toISOString().slice(0, 10),
      cc.investmentAccountId
    );
    openCallContractsByBatch.set(key, (openCallContractsByBatch.get(key) ?? 0) + cc.contracts);
  }

  const rows = lots
    .filter((l) => l.fromOptionsPosition !== null)
    .map((l) => {
      const assignmentStrike = Number(l.fromOptionsPosition!.strikePrice);
      const assignmentExpiration = l.fromOptionsPosition!.expirationDate.toISOString().slice(0, 10);
      const key = batchKey(l.holding.ticker, assignmentStrike, assignmentExpiration, l.holding.accountId);
      return {
        lotId: l.id,
        ticker: l.holding.ticker,
        accountId: l.holding.accountId,
        accountName: l.holding.account?.name ?? null,
        accountColor: l.holding.account?.color ?? null,
        shares: Number(l.quantity),
        assignmentStrike,
        assignmentExpiration,
        acquiredDate: l.acquiredDate ? l.acquiredDate.toISOString().slice(0, 10) : null,
        openCallContracts: openCallContractsByBatch.get(key) ?? 0,
        fromOptionsPositionId: l.fromOptionsPositionId,
      };
    });

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
