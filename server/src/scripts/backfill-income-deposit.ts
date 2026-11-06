/**
 * One-time backfill: fill Income.depositAccountId / depositDate on rows written
 * before those fields existed, and move options premium and sale proceeds onto
 * the new meaning of accountId/date (where income originated, when it was earned).
 *
 * Only rows with depositAccountId IS NULL are touched, so it is safe to re-run.
 * Every changed row keeps its old accountId/date in the deposit fields or in the
 * apply log, so the backfill can be reverted.
 *
 * Rules, first match wins:
 *   1. Options premium (linked to a position, or in the "Options Premium" category)
 *      a. linked, position has a brokerage (investmentAccountId):
 *         deposit ← current account + date; accountId ← brokerage; date ← close date
 *      b. linked, no brokerage: deposit ← current account + date; date ← close date
 *      c. not linked to a position, PYPL recorded through April 2026 (traded in
 *         Vanguard 73679387 before positions were tracked in the app):
 *         deposit ← current account + date; accountId ← that brokerage. The close
 *         date isn't recorded, so date stays as it is.
 *      d. any other option not linked to a position: deposit ← current account + date
 *      Close date = position closedAt, or expirationDate for one that expired.
 *   2. Sale proceeds (linked SALE activity):
 *         deposit ← current account + date; accountId ← the sale's account
 *   3. Dividends (linked DIVIDEND activity), and
 *   4. Other income in an investment account (interest, money-market dividends,
 *      Fundrise distributions):
 *         cash received → deposit ← the account's cash destination (when it pays
 *         dividends as cash and has one), else the account itself; reinvested →
 *         the account itself. depositDate ← date.
 *   5. Everything else (income into a bank account): deposit ← current account + date.
 *
 * Dry-run by default: prints per-rule counts, samples, and warnings. Pass --apply
 * to write; it also saves a JSON log of every change (old and new values).
 *
 *   npx tsx src/scripts/backfill-income-deposit.ts                 # dry run
 *   npx tsx src/scripts/backfill-income-deposit.ts --apply         # write
 *   DATABASE_URL='...' npx tsx src/scripts/backfill-income-deposit.ts [--apply]
 */

import { writeFileSync } from "fs";
import { PrismaClient } from "@prisma/client";
import { parseLocalDate } from "../lib/localDate.js";
import { defaultDepositAccountId } from "../lib/incomeDeposit.js";

const APPLY = process.argv.includes("--apply");
const SAMPLES = 5;
// An options transfer this long after (or any time before) the close is worth a look.
const LAG_WARN_DAYS = 20;
// Rule 1c: options premium recorded before positions were tracked in the app.
const UNLINKED_OPTIONS = { ticker: "PYPL", through: "2026-04-30", brokerage: "Vanguard 73679387" };

const prisma = new PrismaClient();

type Rule = "1a" | "1b" | "1c" | "1d" | "2" | "3" | "4" | "5";
const RULE_LABEL: Record<Rule, string> = {
  "1a": "Options premium → brokerage origin, close date",
  "1b": "Options premium, no brokerage on position → close date only",
  "1c": `Options premium, unlinked ${UNLINKED_OPTIONS.ticker} through ${UNLINKED_OPTIONS.through} → origin ${UNLINKED_OPTIONS.brokerage}`,
  "1d": "Options premium, not linked to a position → deposit = current",
  "2": "Sale proceeds → origin = sale's account",
  "3": "Dividends → deposit by account's dividend setting",
  "4": "Other income in an investment account → deposit by account's dividend setting",
  "5": "Bank-account income → deposit = current",
};

type Change = {
  id: string;
  rule: Rule;
  source: string | null;
  amount: string;
  before: { accountId: string; date: string };
  after: { accountId: string; date: string; depositAccountId: string; depositDate: string };
};

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

async function main() {
  const accounts = await prisma.account.findMany({
    select: { id: true, name: true, type: true, dividendElection: true, defaultCashAccountId: true },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const name = (id: string) => byId.get(id)?.name ?? id;
  const unlinkedBrokerage = accounts.filter((a) => a.name === UNLINKED_OPTIONS.brokerage);

  const rows = await prisma.income.findMany({
    where: { depositAccountId: null },
    select: {
      id: true, accountId: true, date: true, amount: true, source: true, isCashReceived: true,
      optionsPositionId: true,
      category: { select: { name: true } },
      activity: { select: { type: true, accountId: true } },
      optionsPosition: { select: { investmentAccountId: true, closedAt: true, expirationDate: true } },
    },
    orderBy: { date: "asc" },
  });

  const changes: Change[] = [];
  const warnings: string[] = [];
  if (unlinkedBrokerage.length !== 1) {
    warnings.push(`Found ${unlinkedBrokerage.length} accounts named "${UNLINKED_OPTIONS.brokerage}"; rule 1c skipped`);
  }
  const throughEnd = new Date(`${UNLINKED_OPTIONS.through}T23:59:59.999Z`);

  for (const r of rows) {
    let rule: Rule;
    let accountId = r.accountId;
    let date = r.date;
    let depositAccountId = r.accountId;
    const depositDate = r.date;

    const isOptions = r.optionsPositionId != null || r.category?.name === "Options Premium";
    if (isOptions) {
      const pos = r.optionsPosition;
      if (pos) {
        const closed = pos.closedAt ?? pos.expirationDate;
        date = parseLocalDate(day(closed));
        if (pos.investmentAccountId) {
          rule = "1a";
          accountId = pos.investmentAccountId;
        } else {
          rule = "1b";
        }
        const lag = daysBetween(date, depositDate);
        if (lag < 0 || lag > LAG_WARN_DAYS) {
          warnings.push(`${r.id} ${r.source ?? ""}: transferred ${day(depositDate)} is ${lag} days from close ${day(date)}`);
        }
      } else if (
        unlinkedBrokerage.length === 1 &&
        (r.source ?? "").trim().toUpperCase().startsWith(`${UNLINKED_OPTIONS.ticker} `) &&
        r.date <= throughEnd
      ) {
        rule = "1c";
        accountId = unlinkedBrokerage[0].id;
      } else {
        rule = "1d";
      }
    } else if (r.activity?.type === "SALE") {
      rule = "2";
      accountId = r.activity.accountId;
    } else if (r.activity?.type === "DIVIDEND") {
      rule = "3";
      accountId = r.activity.accountId;
      depositAccountId = defaultDepositAccountId(byId.get(accountId) ?? { id: accountId, dividendElection: null, defaultCashAccountId: null }, r.isCashReceived);
    } else if (byId.get(r.accountId)?.type === "INVESTMENT") {
      rule = "4";
      depositAccountId = defaultDepositAccountId(byId.get(r.accountId)!, r.isCashReceived);
    } else {
      rule = "5";
    }

    if (r.activity && r.activity.type !== "SALE" && r.activity.type !== "DIVIDEND" && !isOptions) {
      warnings.push(`${r.id} ${r.source ?? ""}: linked to a ${r.activity.type} activity; treated as rule ${rule}`);
    }

    changes.push({
      id: r.id,
      rule,
      source: r.source,
      amount: r.amount.toString(),
      before: { accountId: r.accountId, date: r.date.toISOString() },
      after: {
        accountId,
        date: date.toISOString(),
        depositAccountId,
        depositDate: depositDate.toISOString(),
      },
    });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} income rows without a deposit account\n`);
  for (const rule of Object.keys(RULE_LABEL) as Rule[]) {
    const mine = changes.filter((c) => c.rule === rule);
    if (mine.length === 0) continue;
    const moved = mine.filter((c) => c.after.accountId !== c.before.accountId).length;
    const redated = mine.filter((c) => c.after.date !== c.before.date).length;
    const elsewhere = mine.filter((c) => c.after.depositAccountId !== c.after.accountId).length;
    console.log(`Rule ${rule}: ${RULE_LABEL[rule]}`);
    console.log(`  ${mine.length} rows · origin changed ${moved} · date changed ${redated} · deposited elsewhere ${elsewhere}`);
    const transitions = new Map<string, number>();
    for (const c of mine) {
      const k = `${name(c.before.accountId)} ⇒ origin ${name(c.after.accountId)}, deposit ${name(c.after.depositAccountId)}`;
      transitions.set(k, (transitions.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...transitions].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
    for (const c of mine.slice(-SAMPLES)) {
      console.log(
        `    e.g. ${c.source ?? "—"} $${c.amount}: ${day(new Date(c.before.date))} → earned ${day(new Date(c.after.date))}, ` +
          `transferred ${day(new Date(c.after.depositDate))}`,
      );
    }
    console.log("");
  }
  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  ! ${w}`);
    console.log("");
  }

  if (!APPLY) {
    console.log("Dry run only. Re-run with --apply to write.");
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const logPath = `backfill-income-deposit.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(logPath, JSON.stringify(changes, null, 2));
  console.log(`Wrote change log to ${logPath}`);

  const BATCH = 200;
  let written = 0;
  for (let i = 0; i < changes.length; i += BATCH) {
    const batch = changes.slice(i, i + BATCH);
    await prisma.$transaction(
      batch.map((c) =>
        prisma.income.updateMany({
          // Re-check the guard so a row filled since the read is left alone.
          where: { id: c.id, depositAccountId: null },
          data: {
            accountId: c.after.accountId,
            date: new Date(c.after.date),
            depositAccountId: c.after.depositAccountId,
            depositDate: new Date(c.after.depositDate),
          },
        }),
      ),
    );
    written += batch.length;
  }
  console.log(`Updated ${written} rows.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
