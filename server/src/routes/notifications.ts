import { Router } from "express";
import { prisma } from "../db/client.js";
import { scanForDividends } from "./pendingDividends.js";
import type { DividendScanResult } from "../services/tiingo.js";

export const notificationRoutes = Router();

/**
 * GET /api/notifications
 *
 * Scans all investment accounts for new dividends, then returns a summary of
 * all pending items grouped by account.  Called once on app load so the bell
 * badge is always current without requiring the user to visit a specific tab.
 */
notificationRoutes.get("/", async (_req, res) => {
  // 1. Find every investment account
  const accounts = await prisma.account.findMany({
    where: { type: "INVESTMENT", isActive: true },
    select: { id: true, name: true },
  });

  // 2. Scan each account for new dividends (errors are swallowed per-account
  //    so a single bad ticker/account can't break the whole response).
  //    A shared tickerCache ensures each unique ticker is only fetched from
  //    Tiingo once per session, even when the same fund appears in multiple accounts.
  const tickerCache = new Map<string, Promise<DividendScanResult>>();
  await Promise.allSettled(
    accounts.map((account) => scanForDividends(account, tickerCache)),
  );

  // 3. Count pending dividends per account
  const counts = await prisma.pendingDividend.groupBy({
    by: ["accountId"],
    where: { status: "PENDING" },
    _count: { id: true },
  });

  const countMap = new Map(counts.map((c) => [c.accountId, c._count.id]));

  const pendingDividends = accounts
    .filter((a) => (countMap.get(a.id) ?? 0) > 0)
    .map((a) => ({
      accountId: a.id,
      accountName: a.name,
      count: countMap.get(a.id)!,
    }));

  const totalCount = pendingDividends.reduce((sum, g) => sum + g.count, 0);

  res.json({ pendingDividends, totalCount });
});
