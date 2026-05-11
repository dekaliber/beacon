import { Router } from "express";
import { prisma } from "../db/client.js";
import { scanForDividends } from "./pendingDividends.js";
import { getUserId } from "../middleware/auth.js";

export const notificationRoutes = Router();

/**
 * GET /api/notifications
 *
 * Scans all active instruments for new dividends, then returns a summary of
 * all pending items grouped by account. Called once on app load so the bell
 * badge is always current without requiring the user to visit a specific tab.
 */
notificationRoutes.get("/", async (req, res) => {
  const userId = getUserId(req);
  // 1. Scan all instruments for new dividends. Each unique ticker is queried
  //    from Tiingo exactly once regardless of how many accounts hold it.
  //    Per-instrument errors are swallowed inside scanForDividends so a single
  //    bad ticker can't prevent the rest from running or the response from returning.
  await scanForDividends();

  // 2. Count pending dividends per account (scoped to user's accounts)
  const userAccounts = await prisma.account.findMany({
    where: { userId },
    select: { id: true },
  });
  const userAccountIds = userAccounts.map((a) => a.id);

  const [dividendCounts, buyCounts] = await Promise.all([
    prisma.pendingDividend.groupBy({
      by: ["accountId"],
      where: { status: "PENDING", accountId: { in: userAccountIds } },
      _count: { id: true },
    }),
    prisma.pendingBuy.groupBy({
      by: ["accountId"],
      where: { status: "PENDING", accountId: { in: userAccountIds } },
      _count: { id: true },
    }),
  ]);

  const dividendCountMap = new Map(dividendCounts.map((c) => [c.accountId, c._count.id]));
  const buyCountMap = new Map(buyCounts.map((c) => [c.accountId, c._count.id]));

  // 3. Resolve account names for all accounts that have any pending items
  const accountIdsWithPending = new Set([
    ...dividendCountMap.keys(),
    ...buyCountMap.keys(),
  ]);
  const accounts = await prisma.account.findMany({
    where: { id: { in: [...accountIdsWithPending] }, userId },
    select: { id: true, name: true },
  });

  type AccountGroup = { accountId: string; accountName: string; count: number };

  const pendingDividends: AccountGroup[] = [];
  const pendingBuys: AccountGroup[] = [];

  for (const a of accounts) {
    const dc = dividendCountMap.get(a.id);
    const bc = buyCountMap.get(a.id);
    if (dc) pendingDividends.push({ accountId: a.id, accountName: a.name, count: dc });
    if (bc) pendingBuys.push({ accountId: a.id, accountName: a.name, count: bc });
  }

  const totalCount =
    pendingDividends.reduce((s, g) => s + g.count, 0) +
    pendingBuys.reduce((s, g) => s + g.count, 0);

  res.json({ pendingDividends, pendingBuys, totalCount });
});
