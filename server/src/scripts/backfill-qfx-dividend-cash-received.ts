/**
 * One-time backfill: set isCashReceived=false on Income records that were
 * created by the QFX dividend import for tickers that are NOT an active
 * holding on the account (e.g. money market sweep funds like TIMXX).
 *
 * Run with:  npx tsx src/scripts/backfill-qfx-dividend-cash-received.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Fetch all Income records that were created via QFX import:
  // - linked to an InvestmentActivity whose notes starts with "QFX:"
  // - currently marked isCashReceived=true (only these need updating)
  const candidates = await prisma.income.findMany({
    where: {
      isCashReceived: true,
      subtype: "DIVIDEND",
      activity: {
        notes: { startsWith: "QFX:" },
      },
    },
    select: {
      id: true,
      accountId: true,
      source: true, // ticker stored here at import time
    },
  });

  console.log(`Found ${candidates.length} QFX dividend income records to evaluate.`);

  // Build a set of (accountId, ticker) pairs that DO have a holding row
  const accountIds = [...new Set(candidates.map((c) => c.accountId).filter(Boolean))] as string[];
  const holdings = await prisma.investmentHolding.findMany({
    where: { accountId: { in: accountIds } },
    select: { accountId: true, ticker: true },
  });
  const holdingSet = new Set(holdings.map((h) => `${h.accountId}:${h.ticker}`));

  const toUpdate = candidates.filter((c) => {
    if (!c.accountId || !c.source) return false;
    return !holdingSet.has(`${c.accountId}:${c.source}`);
  });

  console.log(`${toUpdate.length} records need isCashReceived set to false (no active holding).`);

  if (toUpdate.length === 0) {
    console.log("Nothing to update.");
    return;
  }

  const ids = toUpdate.map((r) => r.id);
  const { count } = await prisma.income.updateMany({
    where: { id: { in: ids } },
    data: { isCashReceived: false },
  });

  console.log(`Updated ${count} records.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
