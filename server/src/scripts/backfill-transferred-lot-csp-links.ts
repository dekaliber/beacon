/**
 * One-time backfill: restore fromOptionsPositionId on investment lots that lost
 * their CSP back-link when shares were transferred between accounts.
 *
 * Background: before the transfer fix, POST /api/investments/transfer created
 * destination lots without copying fromOptionsPositionId from the source lot.
 * This means any "Written Against Assigned Lot" CC association breaks for the
 * new account. This script re-links those orphaned lots using the confirmed
 * PendingBuy record (which stores the exact costPerShare and acquiredDate used
 * when the original lot was created).
 *
 * Matching logic (per confirmed PendingBuy):
 *   1. Find TRANSFER activities from the PendingBuy's source account for that ticker.
 *   2. For each destination account, find lots that:
 *        – belong to that account + ticker
 *        – have the same acquiredDate as the PendingBuy
 *        – have costPerShare within 0.000001 of the PendingBuy's costPerShare
 *        – have fromOptionsPositionId = null
 *   3. Update them to set fromOptionsPositionId = pendingBuy.optionsPositionId.
 *
 * Ambiguous matches (multiple PendingBuys map to the same lot key in the same
 * destination account) are skipped with a warning — fix those manually.
 *
 * Run (dry-run by default):
 *   npx tsx src/scripts/backfill-transferred-lot-csp-links.ts
 *
 * Apply changes:
 *   npx tsx src/scripts/backfill-transferred-lot-csp-links.ts --apply
 *
 * Optionally scope to a single user:
 *   CLERK_USER_ID=user_xxx npx tsx src/scripts/backfill-transferred-lot-csp-links.ts --apply
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes("--apply");
const SCOPE_USER = process.env.CLERK_USER_ID;

const TOLERANCE = 0.000001;

async function main() {
  if (DRY_RUN) {
    console.log("DRY RUN — pass --apply to write changes.\n");
  } else {
    console.log("APPLY MODE — changes will be committed.\n");
  }
  if (SCOPE_USER) console.log(`Scoped to userId=${SCOPE_USER}\n`);

  // 1. Load all confirmed PendingBuys (these know the exact costPerShare/acquiredDate
  //    used when the assignment lot was created, plus the originating CSP id).
  const confirmedBuys = await prisma.pendingBuy.findMany({
    where: {
      status: "CONFIRMED",
      ...(SCOPE_USER ? { userId: SCOPE_USER } : {}),
    },
    select: {
      id: true,
      userId: true,
      accountId: true,
      ticker: true,
      optionsPositionId: true,
      costPerShare: true,
      acquiredDate: true,
    },
  });

  // Resolve account names for readable output
  const accountIds = [...new Set(confirmedBuys.map((b) => b.accountId))];
  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, name: true },
  });
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;

  console.log(`Found ${confirmedBuys.length} confirmed PendingBuy(s):\n`);
  for (const buy of confirmedBuys) {
    console.log(
      `  • id=${buy.id}  ticker=${buy.ticker}  account="${accountName(buy.accountId)}"` +
        `  acqDate=${buy.acquiredDate.toISOString().split("T")[0]}` +
        `  cps=${parseFloat(buy.costPerShare.toString())}` +
        `  cspId=${buy.optionsPositionId}`
    );
  }
  console.log("");

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const buy of confirmedBuys) {
    const cps = parseFloat(buy.costPerShare.toString());
    const acqDate = buy.acquiredDate;
    const label = `ticker=${buy.ticker} acqDate=${acqDate.toISOString().split("T")[0]} cps=${cps} srcAccount="${accountName(buy.accountId)}"`;

    // 2. Find all TRANSFER activities out of this source account for this ticker.
    const transfers = await prisma.investmentActivity.findMany({
      where: {
        accountId: buy.accountId,
        ticker: buy.ticker,
        type: "TRANSFER",
        transferAccountId: { not: null },
      },
      select: { transferAccountId: true, date: true },
    });

    if (transfers.length === 0) {
      console.log(`  SKIP (no TRANSFER activities) — ${label}`);
      continue;
    }

    // Resolve destination account names
    const destIds = [...new Set(transfers.map((t) => t.transferAccountId!))];
    const destAccounts = await prisma.account.findMany({
      where: { id: { in: destIds } },
      select: { id: true, name: true },
    });
    const destName = (id: string) => destAccounts.find((a) => a.id === id)?.name ?? id;
    console.log(`  Found ${transfers.length} TRANSFER(s) from "${accountName(buy.accountId)}" → [${destIds.map(destName).join(", ")}] for ${label}`);

    const destAccountIds = [...new Set(transfers.map((t) => t.transferAccountId!))];

    for (const destAccountId of destAccountIds) {
      const dName = destAccountIds.length > 0
        ? (await prisma.account.findUnique({ where: { id: destAccountId }, select: { name: true } }))?.name ?? destAccountId
        : destAccountId;

      // 3a. All unlinked lots in dest account for this ticker+date (before cps filter).
      // InvestmentLot.acquiredDate is DateTime (not @db.Date) and is stored as
      // T20:00:00.000Z by the pending-buy confirmation flow, while PendingBuy.acquiredDate
      // is @db.Date (returned as T00:00:00.000Z). Match the whole calendar day.
      const dateStr = acqDate.toISOString().split("T")[0];
      const dayStart = new Date(dateStr + "T00:00:00.000Z");
      const dayEnd   = new Date(dateStr + "T23:59:59.999Z");
      const candidates = await prisma.investmentLot.findMany({
        where: {
          fromOptionsPositionId: null,
          holding: { accountId: destAccountId, ticker: buy.ticker },
          acquiredDate: { gte: dayStart, lte: dayEnd },
        },
        select: { id: true, costPerShare: true },
      });

      if (candidates.length === 0) {
        console.log(`    → "${dName}": no unlinked lots for ${buy.ticker} on ${acqDate.toISOString().split("T")[0]}`);
        continue;
      }

      // 3b. Filter by costPerShare match
      const matches = candidates.filter(
        (l) => Math.abs(parseFloat(l.costPerShare.toString()) - cps) < TOLERANCE
      );

      if (matches.length === 0) {
        const cpsList = candidates.map((l) => parseFloat(l.costPerShare.toString())).join(", ");
        console.log(`    → "${dName}": ${candidates.length} unlinked lot(s) found but none match cps=${cps} (found: ${cpsList})`);
        continue;
      }

      // Check for ambiguity: does any other PendingBuy for the same dest account
      // produce the same (ticker, acquiredDate, costPerShare) key?
      const sameKeyBuys = confirmedBuys.filter(
        (b) =>
          b.id !== buy.id &&
          b.ticker === buy.ticker &&
          b.acquiredDate.getTime() === acqDate.getTime() &&
          Math.abs(parseFloat(b.costPerShare.toString()) - cps) < TOLERANCE &&
          // source account must also transfer to destAccountId
          true // will be verified below — flag ambiguity conservatively
      );

      // Conservative ambiguity check: if multiple PendingBuys share the same
      // (ticker, acquiredDate, costPerShare) key across ALL source accounts,
      // skip rather than guess which CSP the destination lot belongs to.
      if (sameKeyBuys.length > 0) {
        console.warn(
          `  SKIP (ambiguous) lot(s) for ticker=${buy.ticker} acqDate=${acqDate.toISOString().split("T")[0]} ` +
            `cps=${cps} in destAccount=${destAccountId} — ${sameKeyBuys.length + 1} matching PendingBuy(s). Fix manually.`
        );
        totalSkipped += matches.length;
        continue;
      }

      const lotIds = matches.map((l) => l.id);
      console.log(
        `    → "${dName}": ${DRY_RUN ? "[DRY RUN] would update" : "updating"} ${matches.length} lot(s)` +
          ` → fromOptionsPositionId=${buy.optionsPositionId}`
      );

      if (!DRY_RUN) {
        await prisma.investmentLot.updateMany({
          where: { id: { in: lotIds } },
          data: { fromOptionsPositionId: buy.optionsPositionId },
        });
      }

      totalUpdated += matches.length;
    }
  }

  console.log(`\nDone. Lots ${DRY_RUN ? "that would be" : ""} updated: ${totalUpdated}, skipped (ambiguous): ${totalSkipped}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
