/**
 * Imports dated history the app has no screen for yet: past settlement-cash
 * balances, past manual-investment values, and prices for days a ticker has no
 * market close (e.g. a private fund's NAV before it listed). Used for the
 * statement backfill; safe to re-run, so one file can be applied to each
 * environment in turn.
 *
 * Run with:  npx tsx src/scripts/import-investment-history.ts <file.json> [--dry-run]
 *
 * File shape (every section optional):
 *   {
 *     "cash":   [{ "account": "Robinhood", "date": "2026-03-31", "balance": 0 }],
 *     "manual": [{ "account": "Fundrise", "name": "Flagship Real Estate Fund",
 *                  "date": "2025-12-31", "marketValue": 41000, "totalCost": 42000 }],
 *     "prices": [{ "ticker": "VCX", "from": "2025-12-01", "to": "2026-03-18", "price": 18.97 }]
 *   }
 *
 * Cash and manual rows are recorded as STATEMENT observations and never touch
 * the account's current balance or value, so a row may not be dated after the
 * latest one already recorded (that would make history disagree with today) —
 * unless, for cash, it equals the current balance.
 * Prices are written for each NYSE session in the range and only fill days
 * with no close — a real close is never overwritten.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { isTradingDay } from "../lib/marketHolidays.js";
import { writeTickerHistory } from "../routes/investments.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const fileSchema = z.object({
  cash: z.array(z.object({ account: z.string(), date: day, balance: z.number() })).default([]),
  manual: z
    .array(z.object({
      account: z.string(),
      name: z.string(),
      date: day,
      marketValue: z.number().nonnegative(),
      totalCost: z.number().nonnegative().nullable().optional(),
    }))
    .default([]),
  prices: z
    .array(z.object({ ticker: z.string(), from: day, to: day, price: z.number().positive() }))
    .default([]),
});

const path = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
if (!path) {
  console.error("usage: npx tsx src/scripts/import-investment-history.ts <file.json> [--dry-run]");
  process.exit(1);
}

const dateColumn = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

async function accountId(name: string): Promise<string> {
  const matches = await prisma.account.findMany({ where: { name, type: "INVESTMENT" }, select: { id: true } });
  if (matches.length !== 1) throw new Error(`expected one investment account named "${name}", found ${matches.length}`);
  return matches[0].id;
}

async function importCash(rows: z.infer<typeof fileSchema>["cash"]) {
  for (const r of rows) {
    const id = await accountId(r.account);
    const [latest, account] = await Promise.all([
      prisma.investmentCashBalance.findFirst({
        where: { accountId: id },
        orderBy: { date: "desc" },
        select: { date: true },
      }),
      prisma.account.findUnique({ where: { id }, select: { cashBalance: true } }),
    ]);
    // A row after the latest one becomes the new latest, which is only safe when
    // it agrees with the current balance (e.g. a $0 month-end on a $0 account).
    const matchesCurrent = Math.abs(Number(account?.cashBalance ?? 0) - r.balance) < 0.005;
    if (latest && r.date > dayOf(latest.date) && !matchesCurrent) {
      console.log(`cash   SKIP  ${r.account} ${r.date}: after the latest recorded balance (${dayOf(latest.date)})`);
      continue;
    }
    console.log(`cash   ${dryRun ? "would " : ""}set  ${r.account} ${r.date} = ${r.balance}`);
    if (dryRun) continue;
    await prisma.investmentCashBalance.upsert({
      where: { accountId_date: { accountId: id, date: dateColumn(r.date) } },
      create: { accountId: id, date: dateColumn(r.date), balance: r.balance, source: "STATEMENT" },
      update: { balance: r.balance, source: "STATEMENT" },
    });
  }
}

async function importManual(rows: z.infer<typeof fileSchema>["manual"]) {
  for (const r of rows) {
    const id = await accountId(r.account);
    const manual = await prisma.manualInvestment.findFirst({ where: { accountId: id, name: r.name } });
    if (!manual) throw new Error(`no manual investment "${r.name}" in ${r.account}`);
    const latest = await prisma.manualInvestmentValuation.findFirst({
      where: { manualInvestmentId: manual.id },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    if (latest && r.date > dayOf(latest.date)) {
      console.log(`manual SKIP  ${r.name} ${r.date}: after the latest recorded value (${dayOf(latest.date)})`);
      continue;
    }
    console.log(`manual ${dryRun ? "would " : ""}set  ${r.name} ${r.date} = ${r.marketValue} (cost ${r.totalCost ?? "—"})`);
    if (dryRun) continue;
    const data = {
      accountId: id,
      instrumentId: manual.instrumentId,
      name: manual.name,
      marketValue: r.marketValue,
      totalCost: r.totalCost ?? null,
      source: "STATEMENT" as const,
    };
    await prisma.manualInvestmentValuation.upsert({
      where: { manualInvestmentId_date: { manualInvestmentId: manual.id, date: dateColumn(r.date) } },
      create: { manualInvestmentId: manual.id, date: dateColumn(r.date), ...data },
      update: data,
    });
  }
}

async function importPrices(rows: z.infer<typeof fileSchema>["prices"]) {
  for (const r of rows) {
    const points: Array<{ date: Date; closePrice: number }> = [];
    for (let d = dateColumn(r.from); dayOf(d) <= r.to; d = new Date(d.getTime() + 86_400_000)) {
      // Midday UTC so the ET calendar day resolves to this date.
      if (isTradingDay(d.getTime() + 16 * 3_600_000)) points.push({ date: d, closePrice: r.price });
    }
    const existing = await prisma.tickerPriceHistory.count({
      where: { ticker: r.ticker, date: { gte: dateColumn(r.from), lte: dateColumn(r.to) } },
    });
    console.log(
      `price  ${dryRun ? "would " : ""}fill ${r.ticker} ${r.from}→${r.to} @ ${r.price}: ` +
      `${points.length} sessions, ${existing} already have a close`,
    );
    if (dryRun) continue;
    const written = await writeTickerHistory(r.ticker, points, { isCrypto: false, mode: "fill" });
    console.log(`       wrote ${written}`);
  }
}

async function main() {
  const file = fileSchema.parse(JSON.parse(readFileSync(path!, "utf8")));
  if (dryRun) console.log("Dry run — nothing will be written.\n");
  await importCash(file.cash);
  await importManual(file.manual);
  await importPrices(file.prices);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
