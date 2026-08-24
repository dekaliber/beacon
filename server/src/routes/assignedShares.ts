import { Router } from "express";
import { prisma } from "../db/client.js";
import { getUserId } from "../middleware/auth.js";
import { legNetPremium } from "../lib/optionPremium.js";

export const assignedSharesRoutes = Router();

// batchKey = ticker | strike | expiry(YYYY-MM-DD) | accountId — identifies one
// CSP-assignment batch, shared by both endpoints below.
const batchKey = (ticker: string, strike: number, expiry: string, accountId: string) =>
  `${ticker}|${strike}|${expiry}|${accountId}`;

// Sum of legNetPremium across every CALL roll chain ever *realized* against
// each assignment batch. Legs sharing a groupId are one continuous covered-
// call position (rolled forward one or more times); a leg with no groupId is
// its own single-leg chain. A chain isn't realized until it concludes with no
// leg left OPEN — so a still-open final leg excludes the *entire* chain,
// including any already-closed predecessor legs that were rolled away (their
// premium isn't locked in independently; it's just an intermediate step in an
// ongoing position). assignedFromStrikePrice/Expiration propagate across the
// whole chain, so every leg maps to the same assignment batch.
async function ccPremiumByBatchForUser(userId: string) {
  const calls = await prisma.optionsPosition.findMany({
    where: {
      userId,
      optionType: "CALL",
      isActive: true,
      assignedFromStrikePrice: { not: null },
      assignedFromExpirationDate: { not: null },
    },
    select: {
      id: true,
      groupId: true,
      status: true,
      outcome: true,
      premiumPerShare: true,
      closePremiumPerShare: true,
      contracts: true,
      contractsAssigned: true,
      feesOpen: true,
      feesClose: true,
      investmentAccountId: true,
      assignedFromStrikePrice: true,
      assignedFromExpirationDate: true,
      ticker: { select: { symbol: true } },
    },
  });

  const chains = new Map<string, typeof calls>();
  for (const cc of calls) {
    if (cc.assignedFromStrikePrice == null || cc.assignedFromExpirationDate == null) continue;
    if (cc.investmentAccountId == null) continue;
    const chainKey = cc.groupId ?? `leg:${cc.id}`;
    const existing = chains.get(chainKey);
    if (existing) existing.push(cc);
    else chains.set(chainKey, [cc]);
  }

  const map = new Map<string, number>();
  for (const legs of chains.values()) {
    if (legs.some((leg) => leg.status === "OPEN")) continue;
    const first = legs[0];
    const key = batchKey(
      first.ticker.symbol,
      Number(first.assignedFromStrikePrice),
      first.assignedFromExpirationDate!.toISOString().slice(0, 10),
      first.investmentAccountId!
    );
    const chainPremium = legs.reduce((sum, leg) => sum + legNetPremium(leg), 0);
    map.set(key, (map.get(key) ?? 0) + chainPremium);
  }
  return map;
}

// ── GET /api/assigned-shares/active ────────────────────────────────────────
// Stock currently held that was acquired via an assigned cash-secured put.
// One row per surviving CSP-originated lot. Current price is fetched
// client-side via the existing quotes endpoint; P&L is premium-excluded:
// (currentPrice - assignmentStrike) * shares.
assignedSharesRoutes.get("/active", async (req, res) => {
  const userId = getUserId(req);

  const [lots, openCalls, ccPremiumByBatch] = await Promise.all([
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
          select: {
            groupId: true,
            strikePrice: true,
            expirationDate: true,
            stockPriceAtClose: true,
            outcome: true,
            premiumPerShare: true,
            closePremiumPerShare: true,
            contracts: true,
            contractsAssigned: true,
            feesOpen: true,
            feesClose: true,
          },
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
        strikePrice: true,
        investmentAccountId: true,
        assignedFromStrikePrice: true,
        assignedFromExpirationDate: true,
        ticker: { select: { symbol: true } },
      },
    }),
    ccPremiumByBatchForUser(userId),
  ]);

  const openCallContractsByBatch = new Map<string, number>();
  // Σ(callStrike × contracts) per batch; divided by contracts below to get the
  // contracts-weighted average strike of the open covered calls on that lot.
  const openCallStrikeWeightedByBatch = new Map<string, number>();
  // Per-strike contract counts per batch. The average strike is fine for display
  // but wrong for capping upside: with a $80 and a $81 call on 200 shares, each
  // 100-share block is capped at its own strike, not at the $80.50 average.
  const openCallLegsByBatch = new Map<string, Map<number, number>>();
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
    openCallStrikeWeightedByBatch.set(
      key,
      (openCallStrikeWeightedByBatch.get(key) ?? 0) + Number(cc.strikePrice) * cc.contracts
    );
    const legs = openCallLegsByBatch.get(key) ?? new Map<number, number>();
    const strike = Number(cc.strikePrice);
    legs.set(strike, (legs.get(strike) ?? 0) + cc.contracts);
    openCallLegsByBatch.set(key, legs);
  }

  // A CSP rolled one or more times before assignment shares its groupId across
  // every leg, so the chain's total premium (used below) is the sum of all of
  // them, not just the final assigned leg.
  const groupIds = [...new Set(
    lots.map((l) => l.fromOptionsPosition?.groupId).filter((g): g is string => g != null)
  )];
  const chainLegs = groupIds.length > 0
    ? await prisma.optionsPosition.findMany({
        where: { groupId: { in: groupIds } },
        select: {
          groupId: true,
          outcome: true,
          premiumPerShare: true,
          closePremiumPerShare: true,
          contracts: true,
          contractsAssigned: true,
          feesOpen: true,
          feesClose: true,
        },
      })
    : [];
  const cspChainPremiumByGroup = new Map<string, number>();
  for (const leg of chainLegs) {
    if (!leg.groupId) continue;
    cspChainPremiumByGroup.set(
      leg.groupId,
      (cspChainPremiumByGroup.get(leg.groupId) ?? 0) + legNetPremium(leg)
    );
  }

  // A batch's CC premium total must be attributed to exactly one lot row (not
  // repeated on every lot sharing the batch) so summing across grouped rows
  // client-side doesn't double-count — e.g. two separate lots landing in the
  // same ticker/strike/expiry/account.
  const ccBatchAttributed = new Set<string>();

  const rows = lots
    .filter((l) => l.fromOptionsPosition !== null)
    .map((l) => {
      const assignmentStrike = Number(l.fromOptionsPosition!.strikePrice);
      const assignmentExpiration = l.fromOptionsPosition!.expirationDate.toISOString().slice(0, 10);
      const key = batchKey(l.holding.ticker, assignmentStrike, assignmentExpiration, l.holding.accountId);
      const openCallContracts = openCallContractsByBatch.get(key) ?? 0;
      const openCallAvgStrike =
        openCallContracts > 0
          ? (openCallStrikeWeightedByBatch.get(key) ?? 0) / openCallContracts
          : null;
      const openCallLegs = [...(openCallLegsByBatch.get(key) ?? new Map<number, number>())]
        .map(([strike, contracts]) => ({ strike, contracts }))
        .sort((a, b) => a.strike - b.strike);

      const cspPremium = l.fromOptionsPosition!.groupId
        ? cspChainPremiumByGroup.get(l.fromOptionsPosition!.groupId) ?? 0
        : legNetPremium(l.fromOptionsPosition!);

      let ccPremiumSinceAssignment = 0;
      if (!ccBatchAttributed.has(key)) {
        ccBatchAttributed.add(key);
        ccPremiumSinceAssignment = ccPremiumByBatch.get(key) ?? 0;
      }

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
        openCallContracts,
        openCallAvgStrike,
        openCallLegs,
        stockPriceAtAssignment: l.fromOptionsPosition!.stockPriceAtClose != null
          ? Number(l.fromOptionsPosition!.stockPriceAtClose)
          : null,
        fromOptionsPositionId: l.fromOptionsPositionId,
        cspPremium: Math.round(cspPremium * 100) / 100,
        ccPremiumSinceAssignment: Math.round(ccPremiumSinceAssignment * 100) / 100,
      };
    });

  res.json(rows);
});

// ── GET /api/assigned-shares/realized ──────────────────────────────────────
// Sales of CSP-originated shares (covered-call assignment OR direct sale).
// Premium-excluded realized P&L = (salePricePerShare - assignmentStrike) * shares.
assignedSharesRoutes.get("/realized", async (req, res) => {
  const userId = getUserId(req);

  const [dispositions, ccPremiumByBatch] = await Promise.all([
    prisma.assignedShareDisposition.findMany({
      where: { userId },
      orderBy: { saleDate: "desc" },
    }),
    ccPremiumByBatchForUser(userId),
  ]);

  // ── CSP (roll-chain) premium per originating assignment ─────────────────
  const cspPositionIds = [...new Set(
    dispositions.map((d) => d.fromOptionsPositionId).filter((id): id is string => id != null)
  )];
  const cspPositions = cspPositionIds.length > 0
    ? await prisma.optionsPosition.findMany({
        where: { id: { in: cspPositionIds } },
        select: {
          id: true,
          groupId: true,
          outcome: true,
          premiumPerShare: true,
          closePremiumPerShare: true,
          contracts: true,
          contractsAssigned: true,
          feesOpen: true,
          feesClose: true,
        },
      })
    : [];
  const groupIds = [...new Set(cspPositions.map((p) => p.groupId).filter((g): g is string => g != null))];
  const chainLegs = groupIds.length > 0
    ? await prisma.optionsPosition.findMany({
        where: { groupId: { in: groupIds } },
        select: {
          groupId: true,
          outcome: true,
          premiumPerShare: true,
          closePremiumPerShare: true,
          contracts: true,
          contractsAssigned: true,
          feesOpen: true,
          feesClose: true,
        },
      })
    : [];
  const cspChainPremiumByGroup = new Map<string, number>();
  for (const leg of chainLegs) {
    if (!leg.groupId) continue;
    cspChainPremiumByGroup.set(
      leg.groupId,
      (cspChainPremiumByGroup.get(leg.groupId) ?? 0) + legNetPremium(leg)
    );
  }
  const cspPremiumByPositionId = new Map<string, number>();
  for (const p of cspPositions) {
    cspPremiumByPositionId.set(
      p.id,
      p.groupId ? cspChainPremiumByGroup.get(p.groupId) ?? 0 : legNetPremium(p)
    );
  }

  // Same "attribute once" rule as /active — a disposition's own account is part
  // of the batch key, so two accounts sharing a ticker/strike/expiry are kept
  // distinct (both attributed) while two dispositions from one account/batch
  // (e.g. sold in tranches) don't double-count.
  const cspAttributed = new Set<string>();
  const ccBatchAttributed = new Set<string>();

  let netRealizedPnl = 0;
  const rows = dispositions.map((d) => {
    const shares = Number(d.shares);
    const assignmentStrike = Number(d.assignmentStrike);
    const salePricePerShare = Number(d.salePricePerShare);
    const realizedPnl =
      Math.round((salePricePerShare - assignmentStrike) * shares * 100) / 100;
    netRealizedPnl += realizedPnl;

    let cspPremium = 0;
    if (d.fromOptionsPositionId && !cspAttributed.has(d.fromOptionsPositionId)) {
      cspAttributed.add(d.fromOptionsPositionId);
      cspPremium = cspPremiumByPositionId.get(d.fromOptionsPositionId) ?? 0;
    }

    const assignmentExpiration = d.assignmentExpiration.toISOString().slice(0, 10);
    const key = batchKey(d.ticker, assignmentStrike, assignmentExpiration, d.accountId);
    let ccPremiumSinceAssignment = 0;
    if (!ccBatchAttributed.has(key)) {
      ccBatchAttributed.add(key);
      ccPremiumSinceAssignment = ccPremiumByBatch.get(key) ?? 0;
    }

    return {
      id: d.id,
      ticker: d.ticker,
      accountId: d.accountId,
      shares,
      assignmentStrike,
      assignmentExpiration,
      salePricePerShare,
      realizedPnl,
      saleDate: d.saleDate.toISOString().slice(0, 10),
      viaCoveredCall: d.soldViaPositionId !== null,
      cspPremium: Math.round(cspPremium * 100) / 100,
      ccPremiumSinceAssignment: Math.round(ccPremiumSinceAssignment * 100) / 100,
    };
  });

  res.json({
    rows,
    netRealizedPnl: Math.round(netRealizedPnl * 100) / 100,
  });
});
