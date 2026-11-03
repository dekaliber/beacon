/**
 * One-time seed: give every investment account's settlement cash and every
 * manual investment one starting history row, from the latest value stored
 * before history was recorded.
 *
 * Cash: dated the last day the stored balance changed — the later of the last
 * edit (cashBalanceUpdatedAt) and any option assignment / call-away confirmed
 * after it, since those adjust the balance without re-stamping that edit time.
 * Manual investments: dated their last update.
 *
 * Accounts or investments that already have history rows are skipped, so it is
 * safe to re-run. Hidden and inactive accounts are included: the performance
 * history counts them for the periods they held value.
 *
 * Run with:  npx tsx src/scripts/seed-investment-history.ts [--dry-run]
 */

import { PrismaClient } from "@prisma/client";
import { APP_TIMEZONE } from "../lib/localDate.js";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

const appDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(d);
const dateDay = (d: Date) => d.toISOString().slice(0, 10); // @db.Date columns
const dateColumn = (day: string) => new Date(`${day}T00:00:00.000Z`);

async function seedCash() {
  const accounts = await prisma.account.findMany({
    where: { type: "INVESTMENT", cashBalance: { not: null } },
    select: {
      id: true,
      name: true,
      cashBalance: true,
      cashBalanceUpdatedAt: true,
      updatedAt: true,
      _count: { select: { cashBalanceHistory: true } },
    },
  });

  for (const a of accounts) {
    if (a._count.cashBalanceHistory > 0) {
      console.log(`cash   skip  ${a.name}: already has history`);
      continue;
    }
    const editedAt = a.cashBalanceUpdatedAt ?? a.updatedAt;
    let day = appDay(editedAt);
    let reason = "last edit";

    const after = { status: "CONFIRMED" as const, accountId: a.id, confirmedAt: { gt: editedAt } };
    const [buys, sales] = await Promise.all([
      prisma.pendingBuy.findMany({ where: after, select: { acquiredDate: true } }),
      prisma.pendingSale.findMany({ where: after, select: { saleDate: true } }),
    ]);
    for (const d of [...buys.map((b) => b.acquiredDate), ...sales.map((s) => s.saleDate)]) {
      if (dateDay(d) > day) {
        day = dateDay(d);
        reason = "assignment after last edit";
      }
    }

    console.log(`cash   seed  ${a.name}: ${a.cashBalance} on ${day} (${reason})`);
    if (!dryRun) {
      await prisma.investmentCashBalance.create({
        data: { accountId: a.id, date: dateColumn(day), balance: a.cashBalance!, source: "SEED" },
      });
    }
  }
}

async function seedManual() {
  const manuals = await prisma.manualInvestment.findMany({
    include: { _count: { select: { valuations: true } } },
  });
  for (const m of manuals) {
    if (m._count.valuations > 0) {
      console.log(`manual skip  ${m.name}: already has history`);
      continue;
    }
    const day = appDay(m.updatedAt);
    console.log(`manual seed  ${m.name}: ${m.marketValue} (cost ${m.totalCost ?? "—"}) on ${day}`);
    if (!dryRun) {
      await prisma.manualInvestmentValuation.create({
        data: {
          manualInvestmentId: m.id,
          accountId: m.accountId,
          instrumentId: m.instrumentId,
          name: m.name,
          date: dateColumn(day),
          marketValue: m.marketValue,
          totalCost: m.totalCost,
          source: "SEED",
        },
      });
    }
  }
}

async function main() {
  if (dryRun) console.log("Dry run — nothing will be written.\n");
  await seedCash();
  await seedManual();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
