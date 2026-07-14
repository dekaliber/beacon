/**
 * Re-sync every linked "Options Premium" Income row to its backing position(s),
 * recomputing both `amount` (net premium) and `taxableAmount` straight from the
 * position economics — the same computation `applyCloseSideEffects` performs.
 *
 * Why this exists: before the PUT /positions/:id fix, editing a position's fees or
 * premium via "Edit Position Details" (which sends no bankingAccountId) skipped the
 * income re-sync, so the linked income row's amount/taxableAmount could drift from
 * the position (e.g. a $0.01 open-fee correction left taxableAmount one cent stale,
 * which then spuriously triggered the assigned-premium explainer tooltip on a
 * non-assigned row). This authoritatively realigns the rows.
 *
 * Net amount is chain-aware (sums all legs in a roll group). Taxable amount excludes
 * only the assigned leg's own net premium (which folds into the stock leg); every
 * other outcome is fully taxable as short-term capital. Orphan rows (no linked leg)
 * are skipped — there is no position to recompute them from.
 *
 * Idempotent. Run (dry-run by default):
 *   npx tsx src/scripts/resync-options-premium-income.ts
 * Apply:
 *   npx tsx src/scripts/resync-options-premium-income.ts --apply
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = !process.argv.includes("--apply");
const round2 = (n: number) => Math.round(n * 100) / 100;

function legNet(pos: {
  outcome: string | null;
  premiumPerShare: unknown;
  closePremiumPerShare: unknown;
  contracts: number;
  contractsAssigned: number | null;
  feesOpen: unknown;
  feesClose: unknown;
}): number {
  const c =
    pos.outcome === "ASSIGNED"
      ? Number(pos.contractsAssigned ?? pos.contracts)
      : Number(pos.contracts);
  return (
    (Number(pos.premiumPerShare) - Number(pos.closePremiumPerShare ?? 0)) * c * 100 -
    Number(pos.feesOpen ?? 0) -
    Number(pos.feesClose ?? 0)
  );
}

async function main() {
  console.log(DRY ? "DRY RUN — pass --apply to write changes.\n" : "APPLY MODE — changes will be committed.\n");

  const rows = await prisma.income.findMany({
    where: { category: { name: "Options Premium", kind: "INCOME" }, optionsPositionId: { not: null } },
    include: { optionsPosition: true },
    orderBy: { date: "asc" },
  });

  let changed = 0;
  let orphanOrGone = 0;

  for (const inc of rows) {
    const pos = inc.optionsPosition;
    if (!pos) { orphanOrGone++; continue; }

    // Chain-aware net premium.
    let netAmount: number;
    if (pos.groupId) {
      const legs = await prisma.optionsPosition.findMany({ where: { groupId: pos.groupId } });
      netAmount = round2(legs.reduce((s, l) => s + legNet(l), 0));
    } else {
      netAmount = round2(legNet(pos));
    }

    const taxableAmount =
      pos.outcome === "ASSIGNED" ? round2(netAmount - legNet(pos)) : netAmount;

    const curAmount = Number(inc.amount);
    const curTaxable = inc.taxableAmount != null ? Number(inc.taxableAmount) : NaN;
    const amountDrift = Math.abs(curAmount - netAmount) >= 0.005;
    const taxableDrift = !(Math.abs(curTaxable - taxableAmount) < 0.005);

    if (!amountDrift && !taxableDrift) continue;
    changed++;

    console.log(
      `  ${(inc.source ?? inc.id).padEnd(32)} ` +
        `amount ${curAmount.toFixed(2)}→${netAmount.toFixed(2)}  ` +
        `taxable ${Number.isNaN(curTaxable) ? "null" : curTaxable.toFixed(2)}→${taxableAmount.toFixed(2)}  (${pos.outcome})`
    );

    if (!DRY) {
      await prisma.income.update({
        where: { id: inc.id },
        data: { amount: netAmount, taxableAmount, subtype: "CAPITAL_GAIN", taxClassification: "CAPITAL_GAIN" },
      });
    }
  }

  console.log(`\n${DRY ? "[DRY RUN] " : ""}Done.`);
  console.log(`  linked rows scanned : ${rows.length}`);
  console.log(`  rows re-synced      : ${changed}`);
  console.log(`  skipped (no leg)    : ${orphanOrGone}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
