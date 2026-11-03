import type { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { refreshAllPrices } from "../routes/investments.js";
import { takeNetWorthSnapshot } from "./netWorthSnapshot.js";

// ── Daily update: prices, then the net-worth snapshot ───────────────────────
// Runs inside the web process. A fixed-time cron fires once, so a deploy or a
// restart at that minute loses the day; this instead asks every few minutes
// whether a run is *owed*, so a missed evening is caught up the next time the
// process is up. Writes are idempotent, which is what makes catching up safe.
//
// The free Neon database suspends when idle, so most ticks must not touch it:
// whether a run could be owed is decided from the clock and an in-memory note
// first, and the database is only asked once that says "maybe".

const JOB = "daily-update";

// Runs start at 8:30 PM ET, half an hour past the 8 PM cutoff the prices settle
// by — mutual fund NAVs land up to two hours after the 4 PM close, and crypto's
// 00:00 UTC snapshot is only seconds old at 8 PM under EDT.
const RUN_AFTER_ET_MINUTES = 20 * 60 + 30;

const TICK_MS = 10 * 60 * 1000;
const FIRST_TICK_MS = 60 * 1000;
// A run with failed tickers is retried, but not on every tick: a delisted
// ticker would otherwise cost a full refresh every ten minutes until midnight.
const RETRY_AFTER_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;

type EtDay = { year: number; month: number; day: number };

const etClockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  // hourCycle, not hour12: false — Node 20 renders midnight as "24" under the
  // latter. See effectiveLastTradingDay in routes/investments.ts.
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

// The ET day a run at `now` is for: today once 8:30 PM ET has passed, otherwise
// yesterday. A run at 1 AM is therefore the previous evening's, caught up late.
export function runDayFor(now: Date): EtDay {
  const parts = etClockFmt.formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value);
  const minutes = (get("hour") % 24) * 60 + get("minute");
  const back = minutes >= RUN_AFTER_ET_MINUTES ? 0 : 1;
  // Date.UTC normalizes day 0 into the previous month.
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day") - back));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function runDayKey(d: EtDay): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

// What this process already knows, so ticks can skip the database. Lost on
// restart, which only costs one query on the next tick.
let settledDay: string | null = null; // run day needing nothing more
let retryNotBefore = 0; // epoch ms; ticks before it skip the database
let running = false;

// Whether a run is owed for `day`, per job_runs. Settles the in-memory note
// when the answer is no for good.
async function isRunOwed(key: string, day: Date): Promise<boolean> {
  const attempts = await prisma.jobRun.findMany({
    where: { job: JOB, runDay: day },
    orderBy: { startedAt: "desc" },
    select: { status: true, startedAt: true, finishedAt: true },
  });
  if (attempts.some((a) => a.status === "SUCCESS") || attempts.length >= MAX_ATTEMPTS) {
    settledDay = key;
    return false;
  }
  const last = attempts[0];
  if (last) {
    // RUNNING with no finish is a run a restart cut short; it still counts as
    // an attempt, and its start stands in for the finish it never recorded.
    const lastAt = (last.finishedAt ?? last.startedAt).getTime();
    if (Date.now() - lastAt < RETRY_AFTER_MS) {
      retryNotBefore = lastAt + RETRY_AFTER_MS;
      return false;
    }
  }
  return true;
}

// One attempt: refresh every holding's price, then snapshot net worth from those
// prices. The snapshot runs even when some tickers failed — a stale price for one
// holding beats no snapshot for the day — but not when the refresh threw.
export async function runDailyUpdate(trigger: string): Promise<void> {
  if (running) {
    console.log(`[daily-update] ${trigger}: already running, skipped`);
    return;
  }
  running = true;
  const etDay = runDayFor(new Date());
  const key = runDayKey(etDay);
  const runDay = new Date(`${key}T00:00:00Z`);
  // Recorded before any work, so a restart mid-run still counts as an attempt.
  let run: { id: string };
  try {
    run = await prisma.jobRun.create({
      data: { job: JOB, runDay, status: "RUNNING", detail: { trigger } },
    });
  } catch (err) {
    running = false;
    throw err;
  }
  let status = "FAILED";
  const detail: Record<string, unknown> = { trigger };
  try {
    const prices = await refreshAllPrices({ source: `job:${trigger}` });
    detail.prices = {
      tickers: prices.tickerCount,
      updated: prices.updated.length,
      failed: prices.failed,
      historyRowsFilled: prices.historyRowsFilled,
      tradingDay: prices.tradingDay,
    };
    await takeNetWorthSnapshot(etDay);
    status = prices.failed.length > 0 ? "PARTIAL" : "SUCCESS";
  } catch (err) {
    console.error(`[daily-update] ${key} failed:`, err);
    detail.error = err instanceof Error ? err.message : String(err);
  } finally {
    await prisma.jobRun
      .update({
        where: { id: run.id },
        data: { status, finishedAt: new Date(), detail: detail as Prisma.InputJsonValue },
      })
      .catch((err) => console.error("[daily-update] could not record run:", err));
    running = false;
    if (status === "SUCCESS") settledDay = key;
    else retryNotBefore = Date.now() + RETRY_AFTER_MS;
    console.log(`[daily-update] ${key} ${status} (${trigger})`);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  const now = new Date();
  const key = runDayKey(runDayFor(now));
  if (key === settledDay || now.getTime() < retryNotBefore) return;
  if (!(await isRunOwed(key, new Date(`${key}T00:00:00Z`)))) return;
  await runDailyUpdate("schedule");
}

// Production only by default: a dev server restarts on every save and has its
// own database, which a prod sync overwrites anyway. DAILY_UPDATE_ENABLED=true
// turns it on anywhere; =false turns it off in production.
export function startDailyUpdateScheduler(): void {
  const flag = process.env.DAILY_UPDATE_ENABLED;
  const enabled = flag != null ? flag === "true" : process.env.NODE_ENV === "production";
  if (!enabled) return;
  const safeTick = () => {
    tick().catch((err) => console.error("[daily-update] tick failed:", err));
  };
  setTimeout(safeTick, FIRST_TICK_MS);
  setInterval(safeTick, TICK_MS);
  console.log("[daily-update] scheduler started");
}
