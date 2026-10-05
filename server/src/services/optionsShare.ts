// Read-only data feed behind a public Options Trading share link.
//
// Everything a visitor receives is built here from explicit field lists, so
// nothing leaks by default: no userId, no real account ids or names, no notes,
// no drafts, no snapshot audit detail. Adding a column to a model does NOT
// expose it — it has to be added to a select below on purpose.

import { prisma } from "../db/client.js";
import { getActiveAssignedRows, getRealizedAssigned } from "../routes/assignedShares.js";

const POSITION_SELECT = {
  id: true,
  tickerId: true,
  groupId: true,
  sequenceInGroup: true,
  optionType: true,
  side: true,
  strikePrice: true,
  expirationDate: true,
  openedAt: true,
  contracts: true,
  premiumPerShare: true,
  feesOpen: true,
  shareCostBasis: true,
  stockPriceAtOpen: true,
  currentPremiumPerShare: true,
  currentDelta: true,
  currentDeltaAsOf: true,
  excludeFromLivePnl: true,
  deltaAtOpen: true,
  deltaAtOpenCapturedAt: true,
  status: true,
  outcome: true,
  closedAt: true,
  closePremiumPerShare: true,
  feesClose: true,
  contractsAssigned: true,
  stockPriceAtClose: true,
  assignedFromStrikePrice: true,
  assignedFromExpirationDate: true,
  splitGroupId: true,
  isDraft: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  ticker: {
    select: { id: true, symbol: true, opportunityCostStartDate: true, opportunityCostStartPrice: true },
  },
  group: { select: { id: true, label: true } },
} as const;

/** Resolves a share token to its owner, or null when unknown/revoked. */
export async function resolveShareToken(token: string): Promise<string | null> {
  // Tokens are 32 random bytes, base64url (43 chars). Reject anything else
  // before it reaches the database.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const link = await prisma.optionsShareLink.findUnique({ where: { token }, select: { userId: true } });
  return link?.userId ?? null;
}

export async function buildSharedOptionsData(userId: string) {
  const [settings, positions, capitalChanges, active, realized, snapshot] = await Promise.all([
    prisma.optionsSettings.findUnique({
      where: { userId },
      select: { startingBasis: true, targetReturn: true, startingWeek: true },
    }),
    prisma.optionsPosition.findMany({
      where: { userId, isActive: true, isDraft: false },
      select: POSITION_SELECT,
      orderBy: { openedAt: "desc" },
    }),
    prisma.optionsCapitalChange.findMany({
      where: { userId },
      select: {
        id: true,
        effectiveDate: true,
        delta: true,
        unrealizedSnapshot: true,
        snapshotCapturedAt: true,
        snapshotExcludesOptions: true,
      },
      orderBy: { effectiveDate: "asc" },
    }),
    getActiveAssignedRows(userId),
    getRealizedAssigned(userId),
    prisma.optionsPriceSnapshot.findUnique({
      where: { userId },
      select: { prices: true, refreshedAt: true },
    }),
  ]);

  // The assigned-lot tables group rows by account, so the id has to stay
  // distinct per account — but it doesn't have to be the real one. Swap each
  // for a label that only means something within this response.
  const accountAlias = new Map<string, string>();
  const alias = (accountId: string) => {
    let a = accountAlias.get(accountId);
    if (!a) {
      a = `account-${accountAlias.size + 1}`;
      accountAlias.set(accountId, a);
    }
    return a;
  };

  return {
    settings,
    positions,
    capitalChanges,
    activeHoldings: active.map((r) => ({
      ...r,
      accountId: alias(r.accountId),
      accountName: null,
      accountColor: null,
    })),
    realized: {
      rows: realized.rows.map((r) => ({ ...r, accountId: alias(r.accountId) })),
      netRealizedPnl: realized.netRealizedPnl,
    },
    prices: snapshot
      ? { refreshedAt: snapshot.refreshedAt, quotes: snapshot.prices as Record<string, { price: number; ts: number }> }
      : null,
  };
}

/**
 * Symbols a visitor can see earnings for: open (non-draft) positions plus
 * assigned stock still held — the same tickers the page flags.
 */
export async function shareEarningsSymbols(userId: string): Promise<string[]> {
  const [open, lots] = await Promise.all([
    prisma.optionsPosition.findMany({
      where: { userId, isActive: true, isDraft: false, status: "OPEN" },
      select: { ticker: { select: { symbol: true } } },
    }),
    prisma.investmentLot.findMany({
      where: { fromOptionsPositionId: { not: null }, holding: { account: { userId } } },
      select: { holding: { select: { ticker: true } } },
    }),
  ]);
  return [...new Set([...open.map((r) => r.ticker.symbol), ...lots.map((l) => l.holding.ticker)])];
}

/**
 * Earliest date a visitor's benchmark window can legitimately start: the
 * configured starting week, else the first closed position. Mirrors the page's
 * annReturnFirstDate so a visitor can't use the feed to query arbitrary ranges.
 */
export async function benchmarkAnchorDate(userId: string): Promise<string | null> {
  const settings = await prisma.optionsSettings.findUnique({ where: { userId }, select: { startingWeek: true } });
  if (settings?.startingWeek) return settings.startingWeek;
  const first = await prisma.optionsPosition.findFirst({
    where: { userId, isActive: true, isDraft: false, status: { not: "OPEN" } },
    orderBy: { openedAt: "asc" },
    select: { openedAt: true },
  });
  return first ? first.openedAt.toISOString().slice(0, 10) : null;
}
