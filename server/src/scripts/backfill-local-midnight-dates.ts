/**
 * One-time backfill: shift income/expense records that were stored at UTC
 * midnight (the old `new Date("YYYY-MM-DD")` behavior) to midnight in the app's
 * local timezone (Pacific), matching the new `parseLocalDate` create path.
 *
 * Only records whose `date` time-of-day is exactly 00:00:00.000 UTC are touched:
 *   - the old date-string path produced exactly UTC midnight
 *   - the option-sale path uses 20:00Z, new records use 07:00/08:00Z
 * so this selector uniquely identifies records created by the old logic.
 *
 * The new timestamp is computed with the SAME helper the create path uses, so a
 * backfilled record is byte-identical to one freshly created with that date.
 *
 * Dry-run by default (prints what would change). Pass --apply to write.
 *
 * Run against a chosen database:
 *   DATABASE_URL='...' npx tsx src/scripts/backfill-local-midnight-dates.ts
 *   DATABASE_URL='...' npx tsx src/scripts/backfill-local-midnight-dates.ts --apply
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { parseLocalDate, APP_TIMEZONE } from "../lib/localDate.js";

const APPLY = process.argv.includes("--apply");

const prisma = new PrismaClient();

const fmtPT = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);

type Row = { id: string; date: Date };

/** Rows whose stored timestamp is exactly midnight UTC (old date-string path). */
async function midnightRows(table: "incomes" | "expenses"): Promise<Row[]> {
  // `date` is a Prisma DateTime → Postgres timestamp(3) storing UTC wall-clock.
  // `::time = '00:00:00'` matches exactly midnight (incl. .000).
  return prisma.$queryRawUnsafe<Row[]>(
    `SELECT id, "date" FROM ${table} WHERE "date"::time = '00:00:00' ORDER BY "date"`,
  );
}

async function processTable(
  label: "income" | "expense",
  table: "incomes" | "expenses",
  update: (id: string, date: Date) => Prisma.PrismaPromise<unknown>,
): Promise<number> {
  const rows = await midnightRows(table);
  console.log(`\n${label}: ${rows.length} record(s) at UTC midnight`);

  const sample = rows.slice(0, 5);
  for (const r of sample) {
    const next = parseLocalDate(r.date.toISOString().slice(0, 10));
    console.log(
      `  ${r.id}  ${r.date.toISOString()} (PT ${fmtPT(r.date)})  ->  ${next.toISOString()} (PT ${fmtPT(next)})`,
    );
  }
  if (rows.length > sample.length) console.log(`  … and ${rows.length - sample.length} more`);

  if (!APPLY) return rows.length;

  let updated = 0;
  // Chunked to keep transactions small on large tables.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await prisma.$transaction(
      chunk.map((r) => update(r.id, parseLocalDate(r.date.toISOString().slice(0, 10)))),
    );
    updated += chunk.length;
  }
  console.log(`  ✓ updated ${updated} ${label} record(s)`);
  return rows.length;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.replace(/^.*@/, "").replace(/\/.*$/, "") || "(unknown)";
  console.log(`DB host: ${host}`);
  console.log(`Mode:    ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);
  console.log(`Target:  midnight-UTC dates -> midnight ${APP_TIMEZONE}`);

  const inc = await processTable("income", "incomes", (id, date) =>
    prisma.income.update({ where: { id }, data: { date } }),
  );
  const exp = await processTable("expense", "expenses", (id, date) =>
    prisma.expense.update({ where: { id }, data: { date } }),
  );

  console.log(
    `\n${APPLY ? "Done." : "Dry-run complete."} ${inc} income + ${exp} expense record(s) ${APPLY ? "updated" : "would be updated"}.`,
  );
  if (!APPLY) console.log("Re-run with --apply to write these changes.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
