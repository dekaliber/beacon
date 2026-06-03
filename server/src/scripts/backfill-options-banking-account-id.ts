/**
 * One-time backfill: populate bankingAccountId on closed OptionsPosition rows
 * that were closed before the field existed by matching each position against its
 * corresponding Income record (keyed on the deterministic source string + amount).
 *
 * Run with:  npx tsx src/scripts/backfill-options-banking-account-id.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ── Helpers (mirrors the logic in routes/options.ts) ────────────────────────

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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // All closed positions that don't yet have a bankingAccountId
  const positions = await prisma.optionsPosition.findMany({
    where: {
      isActive: true,
      status: { in: ["CLOSED", "EXPIRED", "ASSIGNED"] },
      bankingAccountId: null,
      outcome: { in: ["EXPIRED_WORTHLESS", "CLOSED_EARLY", "ASSIGNED"] },
    },
    include: {
      ticker: true,
    },
  });

  console.log(`Found ${positions.length} closed positions without a bankingAccountId.`);

  let updated = 0;
  let skipped = 0;

  for (const pos of positions) {
    // Find the "Options Premium" category for this user
    const category = await prisma.category.findFirst({
      where: { userId: pos.userId, name: "Options Premium", kind: "INCOME" },
    });
    if (!category) {
      skipped++;
      continue;
    }

    // Compute net amount (for grouped roll chains, sum all legs)
    let netAmount: number;
    if (pos.groupId) {
      const allLegs = await prisma.optionsPosition.findMany({
        where: { groupId: pos.groupId },
      });
      netAmount = allLegs.reduce((sum, leg) => sum + legNet(leg), 0);
    } else {
      netAmount = legNet(pos);
    }

    if (netAmount <= 0) {
      skipped++;
      continue;
    }

    const source = buildSource(pos);

    // Find a matching income record by source + category, with amount within $0.005
    const incomeRecord = await prisma.income.findFirst({
      where: { categoryId: category.id, source },
    });

    if (!incomeRecord || Math.abs(Number(incomeRecord.amount) - netAmount) >= 0.005) {
      skipped++;
      continue;
    }

    if (!incomeRecord.accountId) {
      skipped++;
      continue;
    }

    await prisma.optionsPosition.update({
      where: { id: pos.id },
      data: { bankingAccountId: incomeRecord.accountId },
    });

    console.log(`  ✓ ${source} → account ${incomeRecord.accountId}`);
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}, Skipped: ${skipped}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
