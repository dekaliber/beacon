import { Router } from "express";
import { prisma } from "../db/client.js";
import { scanForDividends } from "./pendingDividends.js";

export const notificationRoutes = Router();

/**
 * GET /api/notifications
 *
 * Scans all active instruments for new dividends, then returns a summary of
 * all pending items grouped by account. Called once on app load so the bell
 * badge is always current without requiring the user to visit a specific tab.
 */
notificationRoutes.get("/", async (_req, res) => {
  // 1. Scan all instruments for new dividends. Each unique ticker is queried
  //    from Tiingo exactly once regardless of how many accounts hold it.
  //    Per-instrument errors are swallowed inside scanForDividends so a single
  //    bad ticker can't prevent the rest from running or the response from returning.
  await scanForDividends();

  // 2. Count pending dividends per account
  const counts = await prisma.pendingDividend.groupBy({
    by: ["accountId"],
    where: { status: "PENDING" },
    _count: { id: true },
  });

  const countMap = new Map(counts.map((c) => [c.accountId, c._count.id]));

  // 3. Resolve account names for accounts that have pending dividends
  const accounts = await prisma.account.findMany({
    where: { id: { in: [...countMap.keys()] } },
    select: { id: true, name: true },
  });

  const pendingDividends = accounts.map((a) => ({
    accountId: a.id,
    accountName: a.name,
    count: countMap.get(a.id)!,
  }));

  const totalCount = pendingDividends.reduce((sum, g) => sum + g.count, 0);

  res.json({ pendingDividends, totalCount });
});
