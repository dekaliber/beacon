/**
 * Surgical correction for confirmed-dividend per-share values.
 *
 * Background: Tiingo rounds some dividend rates to ~3 decimal places (e.g.
 * 0.855000, 0.860000). When a confirmed dividend's `amount` is later corrected
 * to the actual payment record, the activity's `pricePerShare` is left at that
 * rounded rate. This script helps find those rounded rates and replace them with
 * the exact per-share figure from your brokerage.
 *
 * Review lists confirmed dividends whose stored per-share has 3 or fewer
 * decimal places of real precision (trailing zeros ignored) — i.e. the values
 * that look rounded — sorted by date. As a sanity-check reference it also shows
 * `amount / shares`, but the apply path takes an EXPLICIT value (--set); it
 * never auto-computes, because penny-rounding of `amount` on low share counts
 * makes amount/shares unreliable.
 *
 * This script ONLY touches DIVIDEND InvestmentActivity rows. It never changes
 * `amount` or `shares`, never touches Income, lots, or cost basis, and never
 * touches the PendingDividend estimate (that retains the original Tiingo value
 * by design).
 *
 * Read-only by default. Writes only with --apply --set, and only the ID you name.
 *
 *   Review (no writes) — rounded-looking per-share values, newest first:
 *     NEON_DATABASE_URL='postgresql://...' npx tsx src/scripts/fix-dividend-pershare.ts
 *
 *   Review more rows / filter by ticker:
 *     ... npx tsx src/scripts/fix-dividend-pershare.ts --limit 100 --ticker VNQ
 *
 *   Inspect specific rows (bypasses the precision filter):
 *     ... npx tsx src/scripts/fix-dividend-pershare.ts --ids <id1>,<id2>
 *
 *   Apply an exact per-share to ONE row:
 *     ... npx tsx src/scripts/fix-dividend-pershare.ts --apply --ids <id> --set 0.855400
 */

import { PrismaClient, Prisma } from "@prisma/client";

// Connect to the DB named by NEON_DATABASE_URL if provided (prod), otherwise the
// local DATABASE_URL from .env. Explicit so a prod run is always intentional.
const databaseUrl = process.env.NEON_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl } },
});

// ── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string): boolean {
  return args.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const APPLY = flag("apply");
const LIMIT = Number(opt("limit") ?? 40);
const TICKER = opt("ticker")?.toUpperCase();
const SET = opt("set");
const IDS = (opt("ids") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Decimal places of real precision, trailing zeros ignored (decimal.js drops
// them internally, so 0.855000 → 3, 0.860000 → 2, 0.855385 → 6).
function precision(d: Prisma.Decimal): number {
  return d.decimalPlaces();
}

function impliedPerShare(amount: Prisma.Decimal, shares: Prisma.Decimal): Prisma.Decimal {
  return amount.div(shares).toDecimalPlaces(6);
}

function hostOf(url?: string): string {
  if (!url) return "(unset)";
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

async function main() {
  console.log(`Connected to: ${hostOf(databaseUrl)}`);
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "REVIEW (read-only)"}\n`);

  // Confirmed dividends = DIVIDEND activities linked from a CONFIRMED pending row.
  const rows = await prisma.investmentActivity.findMany({
    where: {
      type: "DIVIDEND",
      pendingDividend: { status: "CONFIRMED" },
      ...(TICKER ? { ticker: TICKER } : {}),
      ...(IDS.length ? { id: { in: IDS } } : {}),
      shares: { not: null },
      pricePerShare: { not: null },
    },
    select: {
      id: true,
      ticker: true,
      date: true,
      amount: true,
      shares: true,
      pricePerShare: true,
      pendingDividend: { select: { perShareAmount: true } },
    },
    orderBy: { date: "desc" },
  });

  type Row = {
    id: string;
    ticker: string;
    date: Date;
    amount: Prisma.Decimal;
    shares: Prisma.Decimal;
    current: Prisma.Decimal;
    implied: Prisma.Decimal;
    tiingoEstimate: Prisma.Decimal | null;
    precision: number;
  };

  const mapped: Row[] = rows.map((r) => {
    const amount = r.amount as Prisma.Decimal;
    const shares = r.shares as Prisma.Decimal;
    const current = r.pricePerShare as Prisma.Decimal;
    return {
      id: r.id,
      ticker: r.ticker,
      date: r.date,
      amount,
      shares,
      current,
      implied: impliedPerShare(amount, shares),
      tiingoEstimate: r.pendingDividend?.perShareAmount ?? null,
      precision: precision(current),
    };
  });

  // When IDs are named, show exactly those (bypass the precision filter so the
  // user can inspect/apply any row). Otherwise show rounded-looking values only.
  const candidates = IDS.length
    ? mapped
    : mapped.filter((r) => r.precision <= 3).slice(0, LIMIT);

  if (candidates.length === 0) {
    console.log("No matching confirmed dividend activities found.");
    return;
  }

  const fmt = (d: Prisma.Decimal | null, p = 6) => (d === null ? "—" : d.toFixed(p));
  for (const r of candidates) {
    console.log(
      `${r.date.toISOString().slice(0, 10)} ${r.ticker.padEnd(6)} id=${r.id}\n` +
        `        per-share=${fmt(r.current)} (${r.precision}dp)  ` +
        `amount=${fmt(r.amount, 2)}  shares=${fmt(r.shares)}  ` +
        `amount/shares=${fmt(r.implied)}  tiingo=${fmt(r.tiingoEstimate)}`
    );
  }

  if (!APPLY) {
    console.log(
      `\n${candidates.length} row(s) shown` +
        (IDS.length ? "" : " (per-share ≤3dp of precision)") +
        ".\nReview only — no writes made. To correct one row, re-run with:\n" +
        "  --apply --ids <activity id> --set <exact per-share>"
    );
    return;
  }

  // ── Apply path: explicit value, single row ───────────────────────────────────
  if (SET === undefined) {
    console.log("\n--apply requires --set <exact per-share>. Refusing to write without an explicit value.");
    process.exitCode = 1;
    return;
  }
  if (IDS.length !== 1) {
    console.log("\n--apply --set targets exactly one row; pass a single --ids <id>.");
    process.exitCode = 1;
    return;
  }

  let setValue: Prisma.Decimal;
  try {
    setValue = new Prisma.Decimal(SET);
  } catch {
    console.log(`\n--set value '${SET}' is not a valid number.`);
    process.exitCode = 1;
    return;
  }
  if (setValue.lessThanOrEqualTo(0) || setValue.decimalPlaces() > 6) {
    console.log(`\n--set value '${SET}' must be positive with at most 6 decimal places.`);
    process.exitCode = 1;
    return;
  }

  const target = candidates.find((r) => r.id === IDS[0]);
  if (!target) {
    console.log(`\nActivity ${IDS[0]} not found among confirmed dividends.`);
    process.exitCode = 1;
    return;
  }

  await prisma.investmentActivity.update({
    where: { id: target.id },
    data: { pricePerShare: setValue },
  });
  console.log(
    `\nUpdated ${target.ticker} ${target.id}: per-share ${target.current.toFixed(6)} → ${setValue.toFixed(6)}`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
