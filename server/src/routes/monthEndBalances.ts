import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getUserId } from "../middleware/auth.js";
import { computePerformance, editableMonthEnds } from "../services/performance.js";
import { dayOf, recordCashBalance, recordManualValuation } from "../lib/cashHistory.js";

// ── Month-end balances ──────────────────────────────────────────────────────────
// Settlement cash and manual-investment values at each finished month's close:
// the values statements report and the app can't derive. Edits land in the same
// dated history the account pages write (InvestmentCashBalance and
// ManualInvestmentValuation) as STATEMENT rows. Deleting one falls back to what
// the surrounding records work out to.
//
// The open month isn't editable here: today's values are set on the account
// pages, which keep the latest history row equal to the current balance. Every
// write below restores that invariant if a past edit or delete disturbed it.

export const monthEndBalanceRoutes = Router();

type Db = Prisma.TransactionClient;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().finite().refine((n) => Math.abs(n) < 1e10, "out of range");
const cashBody = z.object({ accountId: z.string(), date: day, balance: money, today: day });
const cashDelete = z.object({ accountId: z.string(), date: day, today: day });
const manualBody = z.object({ seriesId: z.string(), date: day, marketValue: money.refine((n) => n >= 0, "must be ≥ 0"), today: day });
const manualDelete = z.object({ seriesId: z.string(), date: day, today: day });

const dateColumn = (d: string) => new Date(`${d}T00:00:00.000Z`);
const DETACHED = /^detached:([^:]+):(.*)$/s;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function assertEditable(date: string, today: string) {
  if (!editableMonthEnds(today).includes(date)) {
    throw new HttpError(400, "Only the closes of finished months can be edited here");
  }
}

async function ownedAccount(db: Db, userId: string, accountId: string) {
  const account = await db.account.findFirst({ where: { id: accountId, userId, type: "INVESTMENT" }, select: { id: true } });
  if (!account) throw new HttpError(404, "Account not found");
}

/** Keeps the latest cash row equal to Account.cashBalance: if a past edit made
 *  the latest row disagree (or deleted the only one), today's balance is
 *  recorded as an observation of its own. */
async function keepLatestCash(db: Db, accountId: string, today: string) {
  const [account, latest] = await Promise.all([
    db.account.findUnique({ where: { id: accountId }, select: { cashBalance: true } }),
    db.investmentCashBalance.findFirst({ where: { accountId }, orderBy: { date: "desc" }, select: { balance: true } }),
  ]);
  const current = Number(account?.cashBalance ?? 0);
  if (!latest || Math.abs(Number(latest.balance) - current) >= 0.005) {
    await recordCashBalance(db, accountId, today, "MANUAL");
  }
}

/** A manual-investment series: a live investment, or the history a deleted one
 *  left behind (detached rows keyed by account and name). */
async function resolveSeries(db: Db, userId: string, seriesId: string) {
  const detached = DETACHED.exec(seriesId);
  if (detached) {
    const [, accountId, name] = detached;
    await ownedAccount(db, userId, accountId);
    return { manualInvestmentId: null, accountId, name, manual: null };
  }
  const manual = await db.manualInvestment.findFirst({ where: { id: seriesId, account: { userId } } });
  if (!manual) throw new HttpError(404, "Investment not found");
  return { manualInvestmentId: manual.id, accountId: manual.accountId, name: manual.name, manual };
}
type Series = Awaited<ReturnType<typeof resolveSeries>>;

const seriesWhere = (s: Series): Prisma.ManualInvestmentValuationWhereInput =>
  s.manualInvestmentId
    ? { manualInvestmentId: s.manualInvestmentId }
    : { manualInvestmentId: null, accountId: s.accountId, name: s.name };

/** Same invariant for a live manual investment; a deleted one ends on its
 *  REMOVED row, which edits here never touch. */
async function keepLatestManual(db: Db, s: Series, today: string) {
  if (!s.manual) return;
  const latest = await db.manualInvestmentValuation.findFirst({
    where: { manualInvestmentId: s.manual.id },
    orderBy: { date: "desc" },
  });
  const same = (a: unknown, b: unknown) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005);
  if (!latest || !same(latest.marketValue, s.manual.marketValue) || !same(latest.totalCost, s.manual.totalCost)) {
    await recordManualValuation(db, s.manual, today, "MANUAL");
  }
}

function send(res: import("express").Response, err: unknown, fallback: string) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: { message: err.message } });
  console.error(err);
  res.status(500).json({ error: { message: fallback } });
}

// ── GET /api/investments/month-end-balances?today=YYYY-MM-DD ─────────────────────
monthEndBalanceRoutes.get("/", async (req, res) => {
  const parsed = z.object({ today: day }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: { message: "today must be YYYY-MM-DD" } });
  try {
    const result = await computePerformance(getUserId(req), "monthly", parsed.data.today, { balances: true });
    res.json(result.balances);
  } catch (err) {
    send(res, err, "Failed to load month-end balances");
  }
});

// ── PUT /api/investments/month-end-balances/cash ─────────────────────────────────
monthEndBalanceRoutes.put("/cash", async (req, res) => {
  const parsed = cashBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { message: "Invalid balance" } });
  const { accountId, date, balance, today } = parsed.data;
  try {
    assertEditable(date, today);
    await prisma.$transaction(async (tx) => {
      await ownedAccount(tx, getUserId(req), accountId);
      await tx.investmentCashBalance.upsert({
        where: { accountId_date: { accountId, date: dateColumn(date) } },
        create: { accountId, date: dateColumn(date), balance, source: "STATEMENT" },
        update: { balance, source: "STATEMENT" },
      });
      await keepLatestCash(tx, accountId, today);
    });
    res.status(204).end();
  } catch (err) {
    send(res, err, "Failed to save balance");
  }
});

// ── DELETE /api/investments/month-end-balances/cash ──────────────────────────────
monthEndBalanceRoutes.delete("/cash", async (req, res) => {
  const parsed = cashDelete.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { message: "Invalid request" } });
  const { accountId, date, today } = parsed.data;
  try {
    assertEditable(date, today);
    await prisma.$transaction(async (tx) => {
      await ownedAccount(tx, getUserId(req), accountId);
      await tx.investmentCashBalance.deleteMany({ where: { accountId, date: dateColumn(date) } });
      await keepLatestCash(tx, accountId, today);
    });
    res.status(204).end();
  } catch (err) {
    send(res, err, "Failed to delete balance");
  }
});

// ── PUT /api/investments/month-end-balances/manual ───────────────────────────────
// Only the value is edited. A new row carries the cost recorded nearest before
// it (or after, or the investment's current cost), so it reads as market change
// rather than a contribution; an existing row keeps its own cost.
monthEndBalanceRoutes.put("/manual", async (req, res) => {
  const parsed = manualBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { message: "Invalid value" } });
  const { seriesId, date, marketValue, today } = parsed.data;
  try {
    assertEditable(date, today);
    await prisma.$transaction(async (tx) => {
      const s = await resolveSeries(tx, getUserId(req), seriesId);
      const rows = await tx.manualInvestmentValuation.findMany({ where: seriesWhere(s), orderBy: { date: "asc" } });
      const removed = rows.find((r) => r.source === "REMOVED");
      if (removed && dayOf(removed.date) <= date) throw new HttpError(400, "The investment was removed by then");

      const existing = rows.find((r) => dayOf(r.date) === date);
      if (existing) {
        await tx.manualInvestmentValuation.update({ where: { id: existing.id }, data: { marketValue, source: "STATEMENT" } });
      } else {
        const before = rows.filter((r) => dayOf(r.date) < date && r.source !== "REMOVED").pop();
        const after = rows.find((r) => dayOf(r.date) > date && r.source !== "REMOVED");
        const template = before ?? after;
        await tx.manualInvestmentValuation.create({
          data: {
            manualInvestmentId: s.manualInvestmentId,
            accountId: s.accountId,
            name: s.name,
            instrumentId: s.manual?.instrumentId ?? template?.instrumentId ?? null,
            date: dateColumn(date),
            marketValue,
            totalCost: template ? template.totalCost : s.manual?.totalCost ?? null,
            source: "STATEMENT",
          },
        });
      }
      await keepLatestManual(tx, s, today);
    });
    res.status(204).end();
  } catch (err) {
    send(res, err, "Failed to save value");
  }
});

// ── DELETE /api/investments/month-end-balances/manual ────────────────────────────
monthEndBalanceRoutes.delete("/manual", async (req, res) => {
  const parsed = manualDelete.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: { message: "Invalid request" } });
  const { seriesId, date, today } = parsed.data;
  try {
    assertEditable(date, today);
    await prisma.$transaction(async (tx) => {
      const s = await resolveSeries(tx, getUserId(req), seriesId);
      await tx.manualInvestmentValuation.deleteMany({
        where: { ...seriesWhere(s), date: dateColumn(date), source: { not: "REMOVED" } },
      });
      await keepLatestManual(tx, s, today);
    });
    res.status(204).end();
  } catch (err) {
    send(res, err, "Failed to delete value");
  }
});
