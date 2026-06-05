/**
 * One-time backfill: link existing "Options Premium" Income rows to the
 * OptionsPosition leg that generated them, populating Income.optionsPositionId.
 *
 * Pre-split, the relationship was 1:1 and keyed on the deterministic source
 * string, so we re-derive each income-generating position's source, match it to
 * its income row (guarded by an amount check), set the FK, and normalize the
 * source back to the clean form (dropping any "· #id" display tag).
 *
 * Idempotent: positions already linked are skipped. Income rows with no backing
 * position (orphan historical premium) are left unlinked.
 *
 * Run (dry-run by default):
 *   npx tsx src/scripts/backfill-income-options-position-id.ts
 * Apply:
 *   npx tsx src/scripts/backfill-income-options-position-id.ts --apply
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = !process.argv.includes("--apply");

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

function buildSource(pos: {
  outcome: string | null;
  optionType: string;
  strikePrice: unknown;
  expirationDate: Date;
  contracts: number;
  contractsAssigned: number | null;
  ticker: { symbol: string };
}): string {
  const exp = pos.expirationDate;
  const yy = String(exp.getUTCFullYear()).slice(2);
  const mm = String(exp.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(exp.getUTCDate()).padStart(2, "0");
  const expStr = `${yy}.${mm}.${dd}`;
  const strike = Number(pos.strikePrice);
  const strikeStr = strike === Math.floor(strike) ? `$${Math.floor(strike)}` : `$${strike}`;
  const optionType = pos.optionType === "CALL" ? "Call" : "Put";
  const contracts =
    pos.outcome === "ASSIGNED"
      ? Number(pos.contractsAssigned ?? pos.contracts)
      : Number(pos.contracts);
  return `${pos.ticker.symbol} ${expStr} ${optionType} ${strikeStr} x${contracts}`;
}

async function main() {
  console.log(DRY ? "DRY RUN — pass --apply to write changes.\n" : "APPLY MODE — changes will be committed.\n");

  const positions = await prisma.optionsPosition.findMany({
    where: {
      isActive: true,
      outcome: { in: ["EXPIRED_WORTHLESS", "CLOSED_EARLY", "ASSIGNED"] },
    },
    include: { ticker: true },
  });

  console.log(`${DRY ? "[DRY RUN] " : ""}Income-generating positions: ${positions.length}`);

  let linked = 0;
  let alreadyLinked = 0;
  let noIncome = 0;
  const ambiguous: string[] = [];

  for (const pos of positions) {
    const category = await prisma.category.findFirst({
      where: { userId: pos.userId, name: "Options Premium", kind: "INCOME" },
    });
    if (!category) { noIncome++; continue; }

    // Already linked?
    const existing = await prisma.income.findFirst({
      where: { categoryId: category.id, optionsPositionId: pos.id },
    });
    if (existing) { alreadyLinked++; continue; }

    // Net premium (chain-aware), to guard the source match.
    let netAmount: number;
    if (pos.groupId) {
      const legs = await prisma.optionsPosition.findMany({ where: { groupId: pos.groupId } });
      netAmount = legs.reduce((s, l) => s + legNet(l), 0);
    } else {
      netAmount = legNet(pos);
    }
    if (netAmount <= 0) { noIncome++; continue; }

    const base = buildSource(pos);

    // Match unlinked income rows whose source is the clean base or base + display tag.
    const candidates = await prisma.income.findMany({
      where: {
        categoryId: category.id,
        optionsPositionId: null,
        OR: [{ source: base }, { source: { startsWith: `${base} · #` } }],
      },
    });
    const matches = candidates.filter((c) => Math.abs(Number(c.amount) - netAmount) < 0.005);

    if (matches.length === 0) { noIncome++; continue; }
    if (matches.length > 1) {
      ambiguous.push(`${pos.id} "${base}" → ${matches.length} candidate income rows: ${matches.map((m) => m.id).join(", ")}`);
      continue;
    }

    const inc = matches[0];
    console.log(`  ✓ ${base}  income=${inc.id}${inc.source !== base ? `  (normalize "${inc.source}" → "${base}")` : ""}`);
    if (!DRY) {
      await prisma.income.update({
        where: { id: inc.id },
        data: { optionsPositionId: pos.id, source: base },
      });
    }
    linked++;
  }

  const orphans = await prisma.income.count({
    where: {
      optionsPositionId: null,
      category: { name: "Options Premium", kind: "INCOME" },
    },
  });

  console.log(`\n${DRY ? "[DRY RUN] " : ""}Done.`);
  console.log(`  linked            : ${linked}`);
  console.log(`  already linked    : ${alreadyLinked}`);
  console.log(`  no income / <=0   : ${noIncome}`);
  console.log(`  ambiguous (>1)    : ${ambiguous.length}`);
  console.log(`  unlinked Options Premium income rows remaining (incl. orphans): ${orphans}`);
  if (ambiguous.length) {
    console.log("\n-- AMBIGUOUS (left untouched) --");
    ambiguous.forEach((a) => console.log(`  ${a}`));
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
