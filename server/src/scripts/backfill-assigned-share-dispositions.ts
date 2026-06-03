/**
 * One-time backfill: reconstruct AssignedShareDisposition rows for sales of
 * CSP-originated stock that happened before the disposition ledger existed.
 *
 * Premium-excluded realized P&L on assigned stock =
 *   (salePricePerShare − assignmentStrike) × shares
 *
 * Two sources:
 *
 *   Source A — covered-call assignments (reliable).
 *     Every CONFIRMED PendingSale links to its SALE activity (activityId) and to
 *     the CC position (optionsPositionId). The CC records the original assignment
 *     strike/expiry via assignedFromStrikePrice / assignedFromExpirationDate.
 *       assignmentStrike     = CC.assignedFromStrikePrice
 *       assignmentExpiration = CC.assignedFromExpirationDate
 *       salePricePerShare    = CC.strikePrice
 *       shares               = pendingSale.quantity
 *       soldViaPositionId    = CC.id
 *     CCs without assignedFrom* (not written through the recovery flow) are skipped.
 *
 *   Source B — historical direct sales (best-effort, lossy).
 *     A direct SALE activity (no linked PendingSale) does not persist which lots
 *     it consumed. We can only attribute it when the holding has a SINGLE distinct
 *     assignment strike among its current CSP-originated lots. Anything ambiguous
 *     (multiple strikes, or no surviving CSP lots) is skipped with a warning.
 *
 * Idempotent: skips any sale activity that already has a disposition row.
 *
 * Run (dry-run by default):
 *   npx tsx src/scripts/backfill-assigned-share-dispositions.ts
 * Apply:
 *   npx tsx src/scripts/backfill-assigned-share-dispositions.ts --apply
 * Scope to one user:
 *   CLERK_USER_ID=user_xxx npx tsx src/scripts/backfill-assigned-share-dispositions.ts --apply
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes("--apply");
const SCOPE_USER = process.env.CLERK_USER_ID;

type NewRow = {
  userId: string;
  saleActivityId: string;
  fromOptionsPositionId: string | null;
  soldViaPositionId: string | null;
  ticker: string;
  accountId: string;
  assignmentStrike: number;
  assignmentExpiration: Date;
  shares: number;
  salePricePerShare: number;
  saleDate: Date;
};

async function main() {
  console.log(DRY_RUN ? "DRY RUN — pass --apply to write changes.\n" : "APPLY MODE — changes will be committed.\n");
  if (SCOPE_USER) console.log(`Scoped to userId=${SCOPE_USER}\n`);

  const userFilter = SCOPE_USER ? { userId: SCOPE_USER } : {};

  // Activities that already have a disposition → skip (idempotency).
  const existing = await prisma.assignedShareDisposition.findMany({
    select: { saleActivityId: true },
  });
  const alreadyDone = new Set(existing.map((e) => e.saleActivityId));

  const rows: NewRow[] = [];
  let skippedA = 0;
  let skippedB = 0;

  // ── Source A — confirmed covered-call assignments ─────────────────────────
  const confirmedSales = await prisma.pendingSale.findMany({
    where: { status: "CONFIRMED", activityId: { not: null }, ...userFilter },
    include: { optionsPosition: true },
  });

  console.log(`Source A: ${confirmedSales.length} confirmed PendingSale(s)\n`);
  for (const ps of confirmedSales) {
    const cc = ps.optionsPosition;
    if (!ps.activityId) continue;
    if (alreadyDone.has(ps.activityId)) continue;
    if (cc.assignedFromStrikePrice == null || cc.assignedFromExpirationDate == null) {
      console.warn(`  SKIP (CC has no assignedFrom*) ticker=${ps.ticker} ccId=${cc.id}`);
      skippedA++;
      continue;
    }

    // Optional reference link: a CSP at the recorded strike/expiry in this account.
    const csp = await prisma.optionsPosition.findFirst({
      where: {
        userId: ps.userId,
        optionType: "PUT",
        outcome: "ASSIGNED",
        isActive: true,
        investmentAccountId: ps.accountId,
        ticker: { symbol: ps.ticker },
        strikePrice: cc.assignedFromStrikePrice,
        expirationDate: cc.assignedFromExpirationDate,
      },
      select: { id: true },
    });

    rows.push({
      userId: ps.userId,
      saleActivityId: ps.activityId,
      fromOptionsPositionId: csp?.id ?? null,
      soldViaPositionId: cc.id,
      ticker: ps.ticker,
      accountId: ps.accountId,
      assignmentStrike: Number(cc.assignedFromStrikePrice),
      assignmentExpiration: cc.assignedFromExpirationDate,
      shares: Number(ps.quantity),
      salePricePerShare: Number(cc.strikePrice),
      saleDate: ps.saleDate,
    });
    alreadyDone.add(ps.activityId);
  }

  // ── Source B — historical direct sales (best-effort) ──────────────────────
  const directSales = await prisma.investmentActivity.findMany({
    where: {
      type: "SALE",
      pendingSale: null,
      ...(SCOPE_USER ? { account: { userId: SCOPE_USER } } : {}),
    },
    select: {
      id: true,
      accountId: true,
      ticker: true,
      date: true,
      shares: true,
      pricePerShare: true,
      account: { select: { userId: true } },
    },
  });

  console.log(`Source B: ${directSales.length} direct SALE activit(ies)\n`);
  for (const sale of directSales) {
    if (alreadyDone.has(sale.id)) continue;
    const saleUserId = sale.account.userId;
    if (!saleUserId) continue;

    // Current CSP-originated lots in this holding (ticker + account).
    const cspLots = await prisma.investmentLot.findMany({
      where: {
        fromOptionsPositionId: { not: null },
        holding: { accountId: sale.accountId, ticker: sale.ticker },
      },
      select: { fromOptionsPosition: { select: { id: true, strikePrice: true, expirationDate: true } } },
    });
    if (cspLots.length === 0) {
      // No surviving CSP lots → can't attribute. (Either never a CSP holding, or
      // fully sold and the link is gone.) Skip quietly unless it clearly was one.
      continue;
    }

    const distinct = new Map<string, { id: string; strikePrice: any; expirationDate: Date }>();
    for (const l of cspLots) {
      if (l.fromOptionsPosition) {
        const key = `${Number(l.fromOptionsPosition.strikePrice)}|${l.fromOptionsPosition.expirationDate.toISOString()}`;
        distinct.set(key, l.fromOptionsPosition);
      }
    }
    if (distinct.size !== 1) {
      console.warn(
        `  SKIP (ambiguous: ${distinct.size} assignment strikes) ticker=${sale.ticker} activityId=${sale.id}`
      );
      skippedB++;
      continue;
    }

    const csp = [...distinct.values()][0];
    rows.push({
      userId: saleUserId,
      saleActivityId: sale.id,
      fromOptionsPositionId: csp.id,
      soldViaPositionId: null,
      ticker: sale.ticker,
      accountId: sale.accountId,
      assignmentStrike: Number(csp.strikePrice),
      assignmentExpiration: csp.expirationDate,
      shares: Number(sale.shares ?? 0),
      salePricePerShare: Number(sale.pricePerShare ?? 0),
      saleDate: sale.date,
    });
    alreadyDone.add(sale.id);
  }

  // ── Report + apply ────────────────────────────────────────────────────────
  console.log(`\nReconstructed ${rows.length} disposition row(s):`);
  for (const r of rows) {
    const pnl = (r.salePricePerShare - r.assignmentStrike) * r.shares;
    console.log(
      `  • ${r.ticker}  ${r.shares} sh  strike=$${r.assignmentStrike}  sale=$${r.salePricePerShare}` +
        `  P&L=${pnl < 0 ? "-" : ""}$${Math.abs(pnl).toFixed(2)}  ${r.soldViaPositionId ? "(CC)" : "(direct)"}` +
        `  ${r.saleDate.toISOString().slice(0, 10)}`
    );
  }
  console.log(`\nSkipped — Source A: ${skippedA}, Source B (ambiguous): ${skippedB}`);

  if (!DRY_RUN && rows.length > 0) {
    await prisma.assignedShareDisposition.createMany({ data: rows });
    console.log(`\nInserted ${rows.length} row(s).`);
  } else if (DRY_RUN) {
    console.log(`\n[DRY RUN] No rows written.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
