import type { CashBalanceSource, ManualValuationSource, Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { APP_TIMEZONE } from "./localDate.js";

// ── Dated history for values the app only stores as "latest" ───────────────────
// Account.cashBalance and ManualInvestment.marketValue are overwritten in place.
// Every write path also records the new value here, dated by the day it took
// effect, so past period-end values can be reconstructed later.

type Db = Prisma.TransactionClient | typeof prisma;

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day of a stored date-only value, e.g. a lot's acquiredDate or a
 *  transfer date. These are stored at Pacific midnight, 4 PM ET, or UTC midnight,
 *  all of which share their UTC date. */
export function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The client's "YYYY-MM-DD" when it sent a valid one; otherwise today in the
 *  app's timezone, for callers (or stale client bundles) that send no date. */
export function clientDayOr(value: unknown): string {
  if (typeof value === "string" && BARE_DATE.test(value)) return value;
  return new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE }).format(new Date());
}

/** "YYYY-MM-DD" → the UTC-midnight Date Prisma expects for a @db.Date column. */
function dateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * Records an investment account's current cashBalance as its balance on `day`.
 * Call after the account row has been updated, inside the same transaction.
 *
 * Keeps the invariant that the latest row matches Account.cashBalance: if a
 * later row already exists (a back-dated event processed after a newer balance
 * was recorded), the current balance lands on that latest row instead of being
 * written into the past, where it would contradict the newer observation.
 */
export async function recordCashBalance(
  db: Db,
  accountId: string,
  day: string,
  source: CashBalanceSource,
): Promise<void> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { type: true, cashBalance: true },
  });
  if (!account || account.type !== "INVESTMENT") return;

  const latest = await db.investmentCashBalance.findFirst({
    where: { accountId },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const latestDay = latest ? dayOf(latest.date) : null;
  const effectiveDay = latestDay && latestDay > day ? latestDay : day;

  // A cleared balance (null) means no settlement cash is tracked, which values as 0.
  const balance = account.cashBalance ?? 0;
  await db.investmentCashBalance.upsert({
    where: { accountId_date: { accountId, date: dateColumn(effectiveDay) } },
    create: { accountId, date: dateColumn(effectiveDay), balance, source },
    update: { balance, source },
  });
}

/** Records a manual investment's current value and cost as of `day`. */
export async function recordManualValuation(
  db: Db,
  manual: {
    id: string;
    accountId: string;
    instrumentId: string | null;
    name: string;
    marketValue: Prisma.Decimal | number;
    totalCost: Prisma.Decimal | number | null;
  },
  day: string,
  source: ManualValuationSource,
): Promise<void> {
  const data = {
    accountId: manual.accountId,
    instrumentId: manual.instrumentId,
    name: manual.name,
    marketValue: manual.marketValue,
    totalCost: manual.totalCost,
    source,
  };
  await db.manualInvestmentValuation.upsert({
    where: { manualInvestmentId_date: { manualInvestmentId: manual.id, date: dateColumn(day) } },
    create: { manualInvestmentId: manual.id, date: dateColumn(day), ...data },
    update: data,
  });
}
