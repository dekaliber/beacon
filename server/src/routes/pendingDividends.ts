import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getDividendScanResult, type DividendEvent } from "../services/tiingo.js";
import { backfillUnlinkedHoldings, reactivateMislinkedInstruments } from "./instruments.js";
import { getUserId } from "../middleware/auth.js";

export const pendingDividendRoutes = Router();

const INCOME_INCLUDE = {
  account: true,
  category: true,
  tags: { include: { tag: true } },
  transactionGroup: true,
  activity: true,
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns shares owned for a holding on a given date.
 *
 * Primary source: InvestmentActivity records (PURCHASE/SALE), which are created
 * when the user records buys/sells through the app's sell flow.
 *
 * Fallback: InvestmentLot records, which are what most holdings use — lots are
 * created directly via the Add Lot UI or the import flow without a corresponding
 * activity record. Lots with acquiredDate <= exDate are counted; lots with no
 * acquiredDate (managed/robo-advisor) are always counted since we have no timing info.
 */
async function getSharesAtDate(holdingId: string, date: Date): Promise<number> {
  // Try activity-based count first (accurate for holdings with full buy/sell history)
  const activities = await prisma.investmentActivity.findMany({
    where: {
      holdingId,
      date: { lte: date },
      type: { in: ["PURCHASE", "SALE"] },
    },
    select: { type: true, shares: true },
  });

  const activityTotal = activities.reduce((sum, a) => {
    if (!a.shares) return sum;
    return a.type === "PURCHASE"
      ? sum + Number(a.shares)
      : sum - Number(a.shares);
  }, 0);

  if (activityTotal > 0) return activityTotal;

  // Fall back to lot quantities (covers holdings added via Add Lot / import)
  const lots = await prisma.investmentLot.findMany({
    where: {
      holdingId,
      OR: [
        { acquiredDate: { lte: date } },
        { acquiredDate: null },
      ],
    },
    select: { quantity: true },
  });

  const lotTotal = lots.reduce((sum, lot) => sum + Number(lot.quantity), 0);
  return Math.max(0, lotTotal);
}

// How long to wait before retrying a holding whose last attempt was rate-limited or errored.
const ATTEMPT_RETRY_MS = 60 * 60 * 1000; // 1 hour

const ts = () => new Date().toLocaleString();

// In-memory guard: prevents two concurrent scans from racing through the
// lastDividendAttemptAt check before either has had a chance to stamp it.
// Handles React StrictMode's double-invoked effects in development, and
// protects against concurrent requests from multiple browser tabs in production.
let scanInProgress = false;

/**
 * Returns the most recent 8 PM Eastern cutoff as a UTC Date.
 * If it is currently past 8 PM ET today, returns today's 8 PM ET.
 * If it is before 8 PM ET today, returns yesterday's 8 PM ET.
 *
 * This mirrors the logic in client/src/lib/priceUtils.ts so dividend scans
 * trigger on the same daily schedule as price refreshes.
 */
function lastCutoff8pmET(now: Date): Date {
  // Resolve today's date in ET and the current ET UTC offset (handles DST).
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => dateParts.find((p) => p.type === type)!.value;

  const tzPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(now).find((p) => p.type === "timeZoneName")!.value;
  const offsetMatch = tzPart.match(/GMT([+-])(\d+)/)!;
  const offsetStr = `${offsetMatch[1]}${offsetMatch[2].padStart(2, "0")}:00`;

  const todayCutoff = new Date(`${get("year")}-${get("month")}-${get("day")}T20:00:00${offsetStr}`);

  // If we haven't reached tonight's cutoff yet, use yesterday's.
  return now >= todayCutoff
    ? todayCutoff
    : new Date(todayCutoff.getTime() - 24 * 60 * 60 * 1000);
}

/**
 * Scan all active instruments for new dividend events and create PendingDividend
 * records for each linked holding that qualifies.
 *
 * Scan timing mirrors price refreshes: an instrument is eligible once per day,
 * starting from the first app load after 8 PM ET (when mutual fund NAVs have
 * settled). Instruments that were rate-limited or errored are retried no sooner
 * than 1 hour after the last attempt (tracked via lastDividendAttemptAt).
 *
 * Scanning at the instrument level means each unique ticker is queried from
 * Tiingo exactly once, regardless of how many accounts hold it.
 */
export async function scanForDividends(): Promise<void> {
  if (scanInProgress) {
    console.log(`[${ts()}] [dividend-scan]: skipped (scan already in progress)`);
    return;
  }
  scanInProgress = true;
  try {
    await runScan();
  } finally {
    scanInProgress = false;
  }
}

async function runScan(): Promise<void> {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const cutoff = lastCutoff8pmET(now);
  const lookbackMs = 14 * 24 * 60 * 60 * 1000;

  // Ensure all holdings have an instrumentId before querying instruments.
  // Holdings created via the lot import flow before today's fix may have
  // instrumentId = null and would otherwise be invisible to this scan.
  await backfillUnlinkedHoldings();

  // Self-heal any instrument left marked inactive while it is still held — a
  // state the old transfer bug could produce. Without this, such a ticker stays
  // invisible to the scan (which filters isActive) until someone happens to load
  // the Securities page. Running it here makes the scan self-sufficient.
  await reactivateMislinkedInstruments();

  // Fetch all active, non-manual instruments. For each we will scan its
  // primary ticker AND every alias ticker registered in InstrumentTicker.
  // Holdings are queried per-ticker below so that alias-ticker holdings are
  // found regardless of which instrument their instrumentId points to.
  const instruments = await prisma.instrument.findMany({
    where: { isActive: true, isManual: false },
    select: {
      id: true,
      primaryTicker: true,
      lastDividendScanAt: true,
      lastDividendAttemptAt: true,
      tickers: { select: { ticker: true } },
    },
  });

  await Promise.all(
    instruments.map(async (instrument) => {
      const tag = `[dividend-scan] ${instrument.primaryTicker}`;
      const aliasSuffix = instrument.tickers.length > 0
        ? ` + aliases [${instrument.tickers.map((t) => t.ticker).join(", ")}]`
        : "";

      // Skip if already successfully scanned since the last 8 PM ET cutoff.
      if (instrument.lastDividendScanAt && instrument.lastDividendScanAt >= cutoff) {
        console.log(`[${ts()}] ${tag}: skipped (already scanned since last 8 PM ET cutoff)${aliasSuffix}`);
        return;
      }

      // Skip if the last attempt FAILED (error or rate-limit) and is within the
      // retry window. A failed attempt is one where lastDividendAttemptAt is newer
      // than lastDividendScanAt (i.e. the scan never completed successfully after
      // that attempt).
      const lastAttemptFailed =
        instrument.lastDividendAttemptAt &&
        (!instrument.lastDividendScanAt ||
          instrument.lastDividendAttemptAt > instrument.lastDividendScanAt);
      if (
        lastAttemptFailed &&
        now.getTime() - instrument.lastDividendAttemptAt!.getTime() < ATTEMPT_RETRY_MS
      ) {
        const nextAt = new Date(instrument.lastDividendAttemptAt!.getTime() + ATTEMPT_RETRY_MS);
        console.log(`[${ts()}] ${tag}: skipped (rate-limit backoff — next attempt after ${nextAt.toLocaleString()})${aliasSuffix}`);
        return;
      }

      // Stamp the attempt time before calling Tiingo so that even a failure is
      // recorded and the 1-hour retry backoff applies.
      await prisma.instrument.update({
        where: { id: instrument.id },
        data: { lastDividendAttemptAt: now },
      });

      // Build the full ticker list: primary ticker + every alias ticker.
      // Each ticker is scanned independently — alias tickers are separate
      // securities with their own dividend amounts, not duplicates.
      const allTickers = [
        instrument.primaryTicker,
        ...instrument.tickers.map((t) => t.ticker),
      ];

      let anyTickerErrored = false;

      for (const ticker of allTickers) {
        // Find all holdings for this specific ticker across all active accounts.
        // Querying by ticker directly (rather than through instrument.holdings)
        // ensures we catch holdings regardless of which instrument they're linked to.
        // Exclude crypto holdings (coinGeckoId set): Tiingo has no crypto dividends
        // and crypto tickers collide with stock tickers (e.g. LTC = Litecoin vs the
        // stock LTC), which would otherwise create bogus pending dividends.
        const holdings = await prisma.investmentHolding.findMany({
          where: { ticker, coinGeckoId: null, account: { isActive: true, type: "INVESTMENT" } },
          select: { id: true, ticker: true, accountId: true, createdAt: true },
        });

        if (holdings.length === 0) continue;

        // Look back 14 days before the earliest holding was created so we catch
        // dividends whose ex-date fell just before the user added the holding.
        const earliestCreatedAt = holdings.reduce(
          (min, h) => (h.createdAt < min ? h.createdAt : min),
          holdings[0].createdAt,
        );
        const startDate = new Date(earliestCreatedAt.getTime() - lookbackMs)
          .toISOString()
          .slice(0, 10);

        const tickerLabel = ticker === instrument.primaryTicker
          ? ticker
          : `${ticker} (alias of ${instrument.primaryTicker})`;
        console.log(`[${ts()}] ${tag}: querying Tiingo for ${tickerLabel} (${startDate} → ${todayStr})`);

        let events: DividendEvent[];
        try {
          ({ dividends: events } = await getDividendScanResult(ticker, startDate, todayStr));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("429")) {
            console.warn(`[${ts()}] ${tag}: RATE LIMITED on ${tickerLabel} — ${msg}`);
          } else {
            console.warn(`[${ts()}] ${tag}: API ERROR on ${tickerLabel} — ${msg}`);
          }
          anyTickerErrored = true;
          continue; // Try remaining tickers instead of aborting the entire instrument
        }

        if (events.length === 0) {
          console.log(`[${ts()}] ${tag}: no dividend events for ${tickerLabel}`);
        } else {
          const latest = events[events.length - 1];
          console.log(
            `[${ts()}] ${tag}: ${events.length} event(s) for ${tickerLabel}. ` +
            `Latest → ex-date ${latest.exDate}, $${latest.perShareAmount}/share`,
          );
        }

        // Fan out: create PendingDividend records for each qualifying holding.
        for (const event of events) {
          const exDate = new Date(event.exDate);

          for (const holding of holdings) {
            // Check if we already have a pending dividend for this holding + ex-date.
            const existing = await prisma.pendingDividend.findUnique({
              where: { holdingId_exDate: { holdingId: holding.id, exDate } },
            });
            if (existing) {
              console.log(`[${ts()}] ${tag} [${event.exDate}] ${tickerLabel}@${holding.accountId}: skipped — PendingDividend already exists (status: ${existing.status})`);
              continue;
            }

            // Check if a DIVIDEND activity already exists for this holding near this
            // date (±3 days to account for minor date discrepancies).
            const threeDays = 3 * 24 * 60 * 60 * 1000;
            const existingActivity = await prisma.investmentActivity.findFirst({
              where: {
                holdingId: holding.id,
                type: "DIVIDEND",
                date: {
                  gte: new Date(exDate.getTime() - threeDays),
                  lte: new Date(exDate.getTime() + threeDays),
                },
              },
            });
            if (existingActivity) {
              console.log(`[${ts()}] ${tag} [${event.exDate}] ${tickerLabel}@${holding.accountId}: skipped — DIVIDEND activity already recorded (id: ${existingActivity.id})`);
              continue;
            }

            const shares = await getSharesAtDate(holding.id, exDate);
            if (shares <= 0) {
              console.log(`[${ts()}] ${tag} [${event.exDate}] ${tickerLabel}@${holding.accountId}: skipped — 0 shares at ex-date`);
              continue;
            }

            const estimatedTotal = parseFloat((shares * event.perShareAmount).toFixed(2));

            // Estimate payment date as ex-date + 4 calendar days.
            // Tiingo's daily price endpoint does not include payment dates, so this
            // is a best-effort estimate. The UI communicates this as tentative.
            const paymentDate = new Date(exDate.getTime() + 4 * 24 * 60 * 60 * 1000);

            // Upsert — the unique constraint on (holdingId, exDate) prevents duplicates
            // but a concurrent scan could race; upsert handles that cleanly.
            await prisma.pendingDividend.upsert({
              where: { holdingId_exDate: { holdingId: holding.id, exDate } },
              create: {
                holdingId: holding.id,
                accountId: holding.accountId,
                ticker: holding.ticker,
                exDate,
                paymentDate,
                perShareAmount: event.perShareAmount,
                sharesAtExDate: shares,
                estimatedTotal,
              },
              update: {}, // No-op if it already exists
            });
            console.log(
              `[${ts()}] ${tag} [${event.exDate}] ${tickerLabel}@${holding.accountId}: created PendingDividend — ` +
              `${shares} shares × $${event.perShareAmount} = $${estimatedTotal}`,
            );
          }
        }
      }

      // Only stamp success if every ticker was scanned without error, so that
      // failed tickers are retried on the next scan cycle.
      if (!anyTickerErrored) {
        await prisma.instrument.update({
          where: { id: instrument.id },
          data: { lastDividendScanAt: now },
        });
      }
    }),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the confirmed dividend activity was a DRIP reinvestment.
 * Primary signal: linked Income record has isCashReceived=false.
 * Fallback for tax-advantaged accounts (no Income record): look for a PURCHASE
 * activity with a lot on the same holding within 60 days after the dividend.
 */
async function isDripDividend(activityId: string): Promise<boolean> {
  const income = await prisma.income.findFirst({
    where: { activityId },
    select: { isCashReceived: true },
  });
  if (income !== null) return income.isCashReceived === false;

  const dividendActivity = await prisma.investmentActivity.findUnique({
    where: { id: activityId },
    select: { holdingId: true, date: true },
  });
  if (!dividendActivity?.holdingId) return false;

  const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
  const drip = await prisma.investmentActivity.findFirst({
    where: {
      holdingId: dividendActivity.holdingId,
      type: "PURCHASE",
      lotId: { not: null },
      date: {
        gte: dividendActivity.date,
        lte: new Date(dividendActivity.date.getTime() + sixtyDaysMs),
      },
    },
  });
  return drip !== null;
}

// ── GET /confirmed/:activityId — fetch confirmed dividend info ────────────────

pendingDividendRoutes.get("/confirmed/:activityId", async (req, res) => {
  const userId = getUserId(req);
  const { activityId } = req.params;

  const pending = await prisma.pendingDividend.findFirst({
    where: { activityId, account: { userId } },
  });
  if (!pending || pending.status !== "CONFIRMED" || !pending.activityId) {
    return res.status(404).json({ error: "Confirmed dividend not found" });
  }

  const activity = await prisma.investmentActivity.findUnique({
    where: { id: activityId },
    select: { date: true, amount: true, notes: true, pricePerShare: true, shares: true },
  });
  if (!activity) return res.status(404).json({ error: "Activity not found" });

  const drip = await isDripDividend(activityId);

  res.json({
    pendingDividendId: pending.id,
    isDrip: drip,
    paymentDate: activity.date.toISOString(),
    amount: Number(activity.amount),
    notes: activity.notes,
    exDate: pending.exDate.toISOString(),
    ticker: pending.ticker,
    // Confirmed per-share/shares live on the activity (the user may have
    // corrected the Tiingo estimate at confirmation). Fall back to the pending
    // row's original estimate only if the activity columns are unset.
    perShareAmount: Number(activity.pricePerShare ?? pending.perShareAmount),
    sharesAtExDate: Number(activity.shares ?? pending.sharesAtExDate),
  });
});

// ── PATCH /:id — edit paymentDate / amount for confirmed non-DRIP dividends ──

const updateConfirmedSchema = z.object({
  paymentDate: z.string().optional(),
  amount: z.number().positive().optional(),
  notes: z.string().nullable().optional(),
});

pendingDividendRoutes.patch("/:id", async (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;
  const parsed = updateConfirmedSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { paymentDate, amount, notes } = parsed.data;
  if (!paymentDate && amount === undefined && notes === undefined) {
    return res.status(400).json({ error: "At least one field must be provided" });
  }

  const pending = await prisma.pendingDividend.findFirst({ where: { id, account: { userId } } });
  if (!pending) return res.status(404).json({ error: "Pending dividend not found" });
  if (pending.status !== "CONFIRMED" || !pending.activityId) {
    return res.status(400).json({ error: "Dividend is not confirmed" });
  }

  const drip = await isDripDividend(pending.activityId);
  if (drip) {
    return res.status(400).json({ error: "DRIP dividends cannot be edited after confirmation" });
  }

  const newDate = paymentDate ? new Date(paymentDate) : undefined;

  const result = await prisma.$transaction(async (tx) => {
    const updatedPending = await tx.pendingDividend.update({
      where: { id },
      data: { ...(newDate && { paymentDate: newDate }) },
    });

    const updatedActivity = await tx.investmentActivity.update({
      where: { id: pending.activityId! },
      data: {
        ...(newDate && { date: newDate }),
        ...(amount !== undefined && { amount }),
        ...(notes !== undefined && { notes: notes ?? null }),
      },
    });

    let updatedIncome = null;
    const income = await tx.income.findFirst({
      where: { activityId: pending.activityId! },
      select: { id: true, taxClassification: true },
    });
    if (income) {
      const incomeData: Record<string, unknown> = {};
      if (newDate) incomeData.date = newDate;
      if (amount !== undefined) {
        incomeData.amount = amount;
        incomeData.taxableAmount = income.taxClassification === "RETURN_OF_CAPITAL" ? 0 : amount;
      }
      if (notes !== undefined) incomeData.notes = notes ?? null;
      updatedIncome = await tx.income.update({
        where: { id: income.id },
        data: incomeData,
        include: INCOME_INCLUDE,
      });
    }

    return { pendingDividend: updatedPending, activity: updatedActivity, income: updatedIncome };
  });

  res.json(result);
});

// ── GET /:accountId — scan + return pending dividends ────────────────────────

pendingDividendRoutes.get("/:accountId", async (req, res) => {
  const userId = getUserId(req);
  const { accountId } = req.params;

  // Verify account exists and belongs to user
  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });
  if (!account) return res.status(404).json({ error: "Account not found" });

  const pending = await prisma.pendingDividend.findMany({
    where: { accountId, status: "PENDING" },
    orderBy: { exDate: "desc" },
  });

  // Enrich each pending dividend with the most recently used taxClassification
  // for that ticker (source match on confirmed income records).
  const tickers = [...new Set(pending.map((p) => p.ticker))];
  const lastClassifications = await Promise.all(
    tickers.map((ticker) =>
      prisma.income.findFirst({
        where: { source: { equals: ticker, mode: "insensitive" }, taxClassification: { not: null } },
        orderBy: { date: "desc" },
        select: { source: true, taxClassification: true },
      })
    )
  );
  const classificationByTicker = new Map(
    lastClassifications
      .filter((r) => r !== null)
      .map((r) => [r!.source!.toUpperCase(), r!.taxClassification])
  );

  res.json(
    pending.map((p) => ({
      ...p,
      lastTaxClassification: classificationByTicker.get(p.ticker.toUpperCase()) ?? null,
    }))
  );
});

// ── POST /:id/dismiss ────────────────────────────────────────────────────────

pendingDividendRoutes.post("/:id/dismiss", async (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;

  const existing = await prisma.pendingDividend.findFirst({ where: { id, account: { userId } } });
  if (!existing) return res.status(404).json({ error: "Pending dividend not found" });

  const updated = await prisma.pendingDividend.update({
    where: { id },
    data: { status: "DISMISSED", dismissedAt: new Date() },
  });

  res.json(updated);
});

// ── POST /:id/confirm ────────────────────────────────────────────────────────

const confirmSchema = z.object({
  date: z.string(), // payable date chosen by user (ISO date string)
  perShareAmount: z.number().positive(),
  shares: z.number().positive(),
  totalAmount: z.number().positive(),
  categoryId: z.string().optional().nullable(),
  taxClassification: z
    .enum(["QUALIFIED", "ORDINARY", "TAX_EXEMPT", "RETURN_OF_CAPITAL"])
    .optional()
    .nullable(),
  notes: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
});

pendingDividendRoutes.post("/:id/confirm", async (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const pending = await prisma.pendingDividend.findFirst({ where: { id, account: { userId } } });
  if (!pending) return res.status(404).json({ error: "Pending dividend not found" });
  if (pending.status !== "PENDING") {
    return res.status(400).json({ error: "Dividend has already been confirmed or dismissed" });
  }

  const account = await prisma.account.findUnique({
    where: { id: pending.accountId },
    select: { isTaxAdvantaged: true },
  });

  const {
    date,
    perShareAmount,
    shares,
    totalAmount,
    categoryId,
    taxClassification,
    notes,
    source,
  } = parsed.data;

  const payableDate = new Date(date);

  const result = await prisma.$transaction(async (tx) => {
    // 1. Create the InvestmentActivity
    const activity = await tx.investmentActivity.create({
      data: {
        accountId: pending.accountId,
        holdingId: pending.holdingId,
        ticker: pending.ticker,
        type: "DIVIDEND",
        date: payableDate,
        shares,
        pricePerShare: perShareAmount,
        amount: totalAmount,
        notes: notes ?? null,
      },
    });

    // 2. Create the linked Income record (skipped for tax-advantaged accounts)
    let income = null;
    if (!account?.isTaxAdvantaged) {
      income = await tx.income.create({
        data: {
          amount: totalAmount,
          source: source ?? pending.ticker,
          date: payableDate,
          accountId: pending.accountId,
          subtype: "DIVIDEND",
          taxClassification: taxClassification ?? null,
          taxableAmount: taxClassification === "RETURN_OF_CAPITAL" ? 0 : totalAmount,
          categoryId: categoryId ?? null,
          notes: notes ?? null,
          activityId: activity.id,
        },
        include: INCOME_INCLUDE,
      });
    }

    // 3. Mark the pending dividend as confirmed, updating paymentDate to the
    // user-provided date. The original paymentDate was a system estimate
    // (ex-date + 4 days); the date entered at confirmation is the actual one.
    // The pending row's perShareAmount/sharesAtExDate intentionally retain the
    // original Tiingo estimate; the user-confirmed values live on the activity.
    const confirmedPending = await tx.pendingDividend.update({
      where: { id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        activityId: activity.id,
        paymentDate: payableDate,
      },
    });

    return { activity, income, pendingDividend: confirmedPending };
  });

  res.status(201).json(result);
});

// ── POST /:id/confirm-reinvest ────────────────────────────────────────────────
// DRIP reinvestment path: creates a DIVIDEND activity + new InvestmentLot +
// linked PURCHASE activity + an Income record with isCashReceived=false.
// The income record captures tax liability even though no cash was received.

const confirmReinvestSchema = z.object({
  exDate: z.string(),              // ISO date of the ex-dividend date
  reinvestDate: z.string(),        // ISO date when the shares were actually purchased
  perShareAmount: z.number().positive(),
  shares: z.number().positive(),   // shares held at ex-date
  totalAmount: z.number().positive(),
  reinvestPrice: z.number().positive(),
  reinvestQuantity: z.number().positive(),
  taxClassification: z
    .enum(["QUALIFIED", "ORDINARY", "TAX_EXEMPT", "RETURN_OF_CAPITAL"])
    .optional()
    .nullable(),
  notes: z.string().optional().nullable(),
});

pendingDividendRoutes.post("/:id/confirm-reinvest", async (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;
  const parsed = confirmReinvestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const pending = await prisma.pendingDividend.findFirst({ where: { id, account: { userId } } });
  if (!pending) return res.status(404).json({ error: "Pending dividend not found" });
  if (pending.status !== "PENDING") {
    return res.status(400).json({ error: "Dividend has already been confirmed or dismissed" });
  }

  const account = await prisma.account.findUnique({
    where: { id: pending.accountId },
    select: { isTaxAdvantaged: true },
  });

  const {
    exDate,
    reinvestDate,
    perShareAmount,
    shares,
    totalAmount,
    reinvestPrice,
    reinvestQuantity,
    taxClassification,
    notes,
  } = parsed.data;

  const exDateObj = new Date(exDate);
  const reinvestDateObj = new Date(reinvestDate);
  const purchaseAmount = Math.round(reinvestQuantity * reinvestPrice * 100) / 100;

  const result = await prisma.$transaction(async (tx) => {
    // 1. Create the DIVIDEND InvestmentActivity (records the dividend event)
    const dividendActivity = await tx.investmentActivity.create({
      data: {
        accountId: pending.accountId,
        holdingId: pending.holdingId,
        ticker: pending.ticker,
        type: "DIVIDEND",
        date: exDateObj,
        shares,
        pricePerShare: perShareAmount,
        amount: totalAmount,
        notes: notes ?? null,
        updatedAt: new Date(),
      },
    });

    // 2. Create the new InvestmentLot for the reinvested shares
    const lot = await tx.investmentLot.create({
      data: {
        holdingId: pending.holdingId!,
        quantity: reinvestQuantity,
        costPerShare: reinvestPrice,
        acquiredDate: reinvestDateObj,
      },
    });

    // 3. Create the linked PURCHASE InvestmentActivity for the new lot
    const purchaseActivity = await tx.investmentActivity.create({
      data: {
        accountId: pending.accountId,
        holdingId: pending.holdingId,
        lotId: lot.id,
        ticker: pending.ticker,
        type: "PURCHASE",
        date: reinvestDateObj,
        shares: reinvestQuantity,
        pricePerShare: reinvestPrice,
        amount: purchaseAmount,
        notes: notes ? `DRIP: ${notes}` : "DRIP reinvestment",
        updatedAt: new Date(),
      },
    });

    // 4. Create Income record to capture tax liability (skipped for tax-advantaged accounts)
    let income = null;
    if (!account?.isTaxAdvantaged) {
      const taxableAmount = taxClassification === "RETURN_OF_CAPITAL" ? 0 : totalAmount;
      income = await tx.income.create({
        data: {
          amount: totalAmount,
          source: pending.ticker,
          date: exDateObj,
          accountId: pending.accountId,
          subtype: "DIVIDEND",
          taxClassification: taxClassification ?? null,
          taxableAmount,
          isCashReceived: false,
          activityId: dividendActivity.id,
          notes: notes ?? null,
        },
      });
    }

    // 5. Mark the pending dividend as confirmed, updating paymentDate to the
    // reinvestment date. For a DRIP the reinvestment date is the economic
    // equivalent of the cash payment date. The pending row's
    // perShareAmount/sharesAtExDate intentionally retain the original Tiingo
    // estimate; the user-confirmed values live on the activity.
    const confirmedPending = await tx.pendingDividend.update({
      where: { id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        activityId: dividendActivity.id,
        paymentDate: reinvestDateObj,
      },
    });

    return { dividendActivity, purchaseActivity, lot, income, pendingDividend: confirmedPending };
  });

  res.status(201).json(result);
});
