/**
 * One-time backfill: reclassify existing "Options Premium" Income rows from
 * ordinary income to short-term capital gain/loss, and repair the taxable amount
 * on rows tied to an *assigned* position leg.
 *
 * Why: option premium was originally booked as ordinary income (a convenient
 * default when auto-create-on-close was added). For a retail writer the IRS
 * treats writing/closing equity options as short-term capital gain/loss
 * (Pub 550), so these rows should be subtype=CAPITAL_GAIN /
 * taxClassification=CAPITAL_GAIN and flow through the estimator's capital-loss
 * netting, not the ordinary bucket.
 *
 * Taxable-amount repair (assigned legs only): previously the ENTIRE roll chain's
 * taxable amount was zeroed when the final leg was assigned, silently dropping
 * the gains/losses of intermediate rolled/closed legs. The assigned leg's own
 * premium still belongs in the stock sale (basis for puts, proceeds for calls),
 * so the row's taxable amount becomes (chain net − assigned leg's own net) — i.e.
 * just the intermediate roll P&L. Non-assigned rows already carry the full net
 * premium as their taxable amount; only their classification changes.
 *
 * Idempotent: re-running produces the same values.
 *
 * Run (dry-run by default):
 *   npx tsx src/scripts/backfill-options-premium-capital-gain.ts
 * Apply:
 *   npx tsx src/scripts/backfill-options-premium-capital-gain.ts --apply
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
    where: { category: { name: "Options Premium", kind: "INCOME" } },
    include: { optionsPosition: true },
  });

  console.log(`Options Premium income rows: ${rows.length}`);

  let reclassified = 0;
  let taxableRepaired = 0;
  let orphans = 0;

  for (const inc of rows) {
    const pos = inc.optionsPosition;
    if (!pos) orphans++;

    // Repair taxable amount for rows whose linked leg was assigned; leave the
    // stored value for non-assigned rows (already the full net premium) and for
    // orphans (no leg to recompute the assigned split from).
    let newTaxable = inc.taxableAmount != null ? Number(inc.taxableAmount) : Number(inc.amount);
    if (pos && pos.outcome === "ASSIGNED") {
      newTaxable = round2(Number(inc.amount) - legNet(pos));
    }

    const needsReclass =
      inc.subtype !== "CAPITAL_GAIN" || inc.taxClassification !== "CAPITAL_GAIN";
    const needsTaxable =
      inc.taxableAmount == null || Math.abs(Number(inc.taxableAmount) - newTaxable) >= 0.005;

    if (!needsReclass && !needsTaxable) continue;

    if (needsReclass) reclassified++;
    if (needsTaxable) taxableRepaired++;

    console.log(
      `  ${needsReclass ? "reclass" : "       "} ${needsTaxable ? "taxable" : "       "}  ` +
        `${inc.source ?? inc.id}  taxable ${inc.taxableAmount ?? "null"} → ${newTaxable}`
    );

    if (!DRY) {
      await prisma.income.update({
        where: { id: inc.id },
        data: {
          subtype: "CAPITAL_GAIN",
          taxClassification: "CAPITAL_GAIN",
          taxableAmount: newTaxable,
        },
      });
    }
  }

  console.log(`\n${DRY ? "[DRY RUN] " : ""}Done.`);
  console.log(`  rows reclassified (subtype/taxClass) : ${reclassified}`);
  console.log(`  rows with taxable amount repaired    : ${taxableRepaired}`);
  console.log(`  orphan rows (no linked leg)          : ${orphans}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
