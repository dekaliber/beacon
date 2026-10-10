import { Router } from "express";
import { prisma } from "../db/client.js";
import { getUserId } from "../middleware/auth.js";
import { legNetPremium } from "../lib/optionPremium.js";

export const assignedSharesRoutes = Router();

// batchKey = ticker | strike | expiry(YYYY-MM-DD) | accountId — identifies one
// CSP-assignment batch, shared by both endpoints below.
const batchKey = (ticker: string, strike: number, expiry: string, accountId: string) =>
  `${ticker}|${strike}|${expiry}|${accountId}`;

// openedAt is an instant; sale dates are bare dates. Compare date-to-date in ET
// (the market's calendar) rather than anchoring the bare date to an instant.
const etDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
const etDate = (d: Date) => etDateFmt.format(d);

const premiumSelect = {
  outcome: true,
  premiumPerShare: true,
  closePremiumPerShare: true,
  contracts: true,
  contractsAssigned: true,
  feesOpen: true,
  feesClose: true,
} as const;

// A slice of an assignment batch's shares: either still held (a lot) or sold
// (a disposition). Premium is attributed per share across these.
interface ShareBlock {
  kind: "lot" | "disposition";
  id: string;
  shares: number;
  batch: string;
  cspId: string | null;
  saleDate: string | null; // dispositions only
  soldViaPositionId: string | null; // dispositions only
}

export interface AttributedPremium {
  cspPremium: number;
  ccPremium: number;
}

// Splits each batch's option premium across the shares it was earned on, so a
// partially-sold batch doesn't report the full premium on both its open and its
// closed half:
//
//  • CSP premium (the originating put + any pre-assignment roll chain) is
//    per-share: pro rata over every share that came from that assignment,
//    held or since sold.
//  • A covered-call chain that ended in assignment belongs to the shares it
//    called away (dispositions sold via one of its legs).
//  • Any other realized covered-call chain isn't tied to specific shares —
//    lots are fungible — so it's split pro rata over the batch's shares that
//    were held for the chain's whole life. Shares sold before it was opened
//    get none of it, and neither do shares sold while it was still running:
//    a call that outlived a sale was, by then, covering what remained.
//
// Legs sharing a groupId are one continuous covered-call position (rolled
// forward one or more times); a leg with no groupId is its own single-leg
// chain. A chain isn't realized until it concludes with no leg left OPEN — so a
// still-open final leg excludes the *entire* chain, including any already-
// closed predecessor legs that were rolled away (their premium isn't locked in
// independently; it's just an intermediate step in an ongoing position).
// assignedFromStrikePrice/Expiration propagate across the whole chain, so
// every leg maps to the same assignment batch.
async function attributePremiumForUser(userId: string) {
  const [lots, dispositions, calls] = await Promise.all([
    prisma.investmentLot.findMany({
      where: {
        fromOptionsPositionId: { not: null },
        holding: { account: { userId } },
      },
      select: {
        id: true,
        quantity: true,
        fromOptionsPositionId: true,
        holding: { select: { ticker: true, accountId: true } },
        fromOptionsPosition: { select: { strikePrice: true, expirationDate: true } },
      },
    }),
    prisma.assignedShareDisposition.findMany({ where: { userId } }),
    prisma.optionsPosition.findMany({
      where: {
        userId,
        optionType: "CALL",
        isActive: true,
        assignedFromStrikePrice: { not: null },
        assignedFromExpirationDate: { not: null },
      },
      select: {
        ...premiumSelect,
        id: true,
        groupId: true,
        status: true,
        openedAt: true,
        closedAt: true,
        expirationDate: true,
        investmentAccountId: true,
        assignedFromStrikePrice: true,
        assignedFromExpirationDate: true,
        ticker: { select: { symbol: true } },
      },
    }),
  ]);

  const blocks: ShareBlock[] = [];
  for (const l of lots) {
    if (!l.fromOptionsPosition) continue;
    blocks.push({
      kind: "lot",
      id: l.id,
      shares: Number(l.quantity),
      batch: batchKey(
        l.holding.ticker,
        Number(l.fromOptionsPosition.strikePrice),
        l.fromOptionsPosition.expirationDate.toISOString().slice(0, 10),
        l.holding.accountId
      ),
      cspId: l.fromOptionsPositionId,
      saleDate: null,
      soldViaPositionId: null,
    });
  }
  for (const d of dispositions) {
    blocks.push({
      kind: "disposition",
      id: d.id,
      shares: Number(d.shares),
      batch: batchKey(
        d.ticker,
        Number(d.assignmentStrike),
        d.assignmentExpiration.toISOString().slice(0, 10),
        d.accountId
      ),
      cspId: d.fromOptionsPositionId,
      saleDate: d.saleDate.toISOString().slice(0, 10),
      soldViaPositionId: d.soldViaPositionId,
    });
  }

  const result = new Map<string, AttributedPremium>();
  const blockKey = (b: Pick<ShareBlock, "kind" | "id">) => `${b.kind}:${b.id}`;
  const allocate = (targets: ShareBlock[], amount: number, field: keyof AttributedPremium) => {
    const totalShares = targets.reduce((sum, b) => sum + b.shares, 0);
    if (totalShares <= 0) return;
    for (const b of targets) {
      const entry = result.get(blockKey(b)) ?? { cspPremium: 0, ccPremium: 0 };
      entry[field] += amount * (b.shares / totalShares);
      result.set(blockKey(b), entry);
    }
  };

  // ── CSP premium ─────────────────────────────────────────────────────────
  // A CSP rolled one or more times before assignment shares its groupId across
  // every leg, so the chain's total premium is the sum of all of them, not just
  // the final assigned leg.
  const cspIds = [...new Set(blocks.map((b) => b.cspId).filter((id): id is string => id != null))];
  const cspPositions = cspIds.length > 0
    ? await prisma.optionsPosition.findMany({
        where: { id: { in: cspIds } },
        select: { ...premiumSelect, id: true, groupId: true },
      })
    : [];
  const groupIds = [...new Set(cspPositions.map((p) => p.groupId).filter((g): g is string => g != null))];
  const chainLegs = groupIds.length > 0
    ? await prisma.optionsPosition.findMany({
        where: { groupId: { in: groupIds } },
        select: { ...premiumSelect, groupId: true },
      })
    : [];
  // Pool = one CSP chain (or one standalone CSP), so a chain's premium is
  // spread once over all the shares it produced.
  const cspPoolPremium = new Map<string, number>();
  const cspPoolById = new Map<string, string>();
  for (const p of cspPositions) {
    const pool = p.groupId ?? `leg:${p.id}`;
    cspPoolById.set(p.id, pool);
    if (!p.groupId) cspPoolPremium.set(pool, legNetPremium(p));
  }
  for (const leg of chainLegs) {
    if (!leg.groupId) continue;
    cspPoolPremium.set(leg.groupId, (cspPoolPremium.get(leg.groupId) ?? 0) + legNetPremium(leg));
  }
  const blocksByCspPool = new Map<string, ShareBlock[]>();
  for (const b of blocks) {
    const pool = b.cspId ? cspPoolById.get(b.cspId) : undefined;
    if (!pool) continue;
    const list = blocksByCspPool.get(pool);
    if (list) list.push(b);
    else blocksByCspPool.set(pool, [b]);
  }
  for (const [pool, poolBlocks] of blocksByCspPool) {
    allocate(poolBlocks, cspPoolPremium.get(pool) ?? 0, "cspPremium");
  }

  // ── Covered-call premium ────────────────────────────────────────────────
  const blocksByBatch = new Map<string, ShareBlock[]>();
  for (const b of blocks) {
    const list = blocksByBatch.get(b.batch);
    if (list) list.push(b);
    else blocksByBatch.set(b.batch, [b]);
  }

  const chains = new Map<string, typeof calls>();
  for (const cc of calls) {
    if (cc.assignedFromStrikePrice == null || cc.assignedFromExpirationDate == null) continue;
    if (cc.investmentAccountId == null) continue;
    const chainKey = cc.groupId ?? `leg:${cc.id}`;
    const existing = chains.get(chainKey);
    if (existing) existing.push(cc);
    else chains.set(chainKey, [cc]);
  }

  for (const legs of chains.values()) {
    if (legs.some((leg) => leg.status === "OPEN")) continue;
    const first = legs[0];
    const batchBlocks = blocksByBatch.get(batchKey(
      first.ticker.symbol,
      Number(first.assignedFromStrikePrice),
      first.assignedFromExpirationDate!.toISOString().slice(0, 10),
      first.investmentAccountId!
    )) ?? [];
    const chainPremium = legs.reduce((sum, leg) => sum + legNetPremium(leg), 0);

    const legIds = new Set(legs.map((leg) => leg.id));
    const calledAway = batchBlocks.filter(
      (b) => b.soldViaPositionId != null && legIds.has(b.soldViaPositionId)
    );
    if (calledAway.length > 0) {
      allocate(calledAway, chainPremium, "ccPremium");
      continue;
    }

    const openedOn = etDate(new Date(Math.min(...legs.map((leg) => leg.openedAt.getTime()))));
    // A leg that expired has no closedAt — it ran to its expiration date.
    const endedOn = legs
      .map((leg) => (leg.closedAt ? etDate(leg.closedAt) : leg.expirationDate.toISOString().slice(0, 10)))
      .reduce((latest, d) => (d > latest ? d : latest));
    const heldThroughout = batchBlocks.filter(
      (b) => b.saleDate == null || (b.saleDate > openedOn && b.saleDate >= endedOn)
    );
    // Nothing on record was held throughout (e.g. a lot removed outside a
    // sale): fall back to the whole batch rather than dropping the premium.
    allocate(heldThroughout.length > 0 ? heldThroughout : batchBlocks, chainPremium, "ccPremium");
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const get = (kind: ShareBlock["kind"], id: string): AttributedPremium => {
    const entry = result.get(blockKey({ kind, id }));
    return {
      cspPremium: round(entry?.cspPremium ?? 0),
      ccPremium: round(entry?.ccPremium ?? 0),
    };
  };
  return {
    forLot: (id: string) => get("lot", id),
    forDisposition: (id: string) => get("disposition", id),
  };
}

// ── GET /api/assigned-shares/active ────────────────────────────────────────
// Stock currently held that was acquired via an assigned cash-secured put.
// One row per surviving CSP-originated lot. Current price is fetched
// client-side via the existing quotes endpoint; P&L is premium-excluded:
// (currentPrice - assignmentStrike) * shares.
assignedSharesRoutes.get("/active", async (req, res) => {
  res.json(await getActiveAssignedRows(getUserId(req)));
});

// Shared with the public read-only share feed (services/optionsShare.ts).
export async function getActiveAssignedRows(userId: string) {
  const [lots, openCalls, premium] = await Promise.all([
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
            strikePrice: true,
            expirationDate: true,
            stockPriceAtClose: true,
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
    attributePremiumForUser(userId),
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

      // This lot's own share of the batch's premium — the rest sits on any
      // sibling lots and on shares already sold (see attributePremiumForUser).
      const { cspPremium, ccPremium } = premium.forLot(l.id);

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
        cspPremium,
        ccPremiumSinceAssignment: ccPremium,
      };
    });

  return rows;
}

// ── GET /api/assigned-shares/realized ──────────────────────────────────────
// Sales of CSP-originated shares (covered-call assignment OR direct sale).
// Premium-excluded realized P&L = (salePricePerShare - assignmentStrike) * shares.
assignedSharesRoutes.get("/realized", async (req, res) => {
  res.json(await getRealizedAssigned(getUserId(req)));
});

// Shared with the public read-only share feed (services/optionsShare.ts).
export async function getRealizedAssigned(userId: string) {
  const [dispositions, premium] = await Promise.all([
    prisma.assignedShareDisposition.findMany({
      where: { userId },
      orderBy: { saleDate: "desc" },
    }),
    attributePremiumForUser(userId),
  ]);

  let netRealizedPnl = 0;
  const rows = dispositions.map((d) => {
    const shares = Number(d.shares);
    const assignmentStrike = Number(d.assignmentStrike);
    const salePricePerShare = Number(d.salePricePerShare);
    const realizedPnl =
      Math.round((salePricePerShare - assignmentStrike) * shares * 100) / 100;
    netRealizedPnl += realizedPnl;

    // Only the premium earned on the shares this sale disposed of — shares
    // from the same batch that are still held keep their own portion.
    const { cspPremium, ccPremium } = premium.forDisposition(d.id);

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
      cspPremium,
      ccPremiumSinceAssignment: ccPremium,
    };
  });

  return {
    rows,
    netRealizedPnl: Math.round(netRealizedPnl * 100) / 100,
  };
}
