import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getDividendScanResult, type DividendScanResult } from "../services/tiingo.js";

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
 * Scan all active holdings for an account and create PendingDividend records
 * for any new dividend events found in Tiingo's daily price data.
 *
 * Scan timing mirrors price refreshes: a holding is eligible once per day,
 * starting from the first app load after 8 PM ET (when mutual fund NAVs have
 * settled). Holdings that were rate-limited or errored are retried no sooner
 * than 1 hour after the last attempt (tracked via lastDividendAttemptAt).
 * Already-seen (holdingId, exDate) pairs are also skipped via the unique constraint.
 * Events where shares-at-ex-date = 0 are skipped.
 *
 * @param tickerCache  Optional shared cache (ticker → in-flight or resolved Promise)
 *                     passed in when scanning multiple accounts in the same session.
 *                     Ensures each unique ticker is only fetched from Tiingo once,
 *                     even when the same fund appears in several accounts.
 */
export async function scanForDividends(
  account: { id: string; name: string },
  tickerCache?: Map<string, Promise<DividendScanResult>>,
): Promise<void> {
  const { id: accountId, name: accountName } = account;

  const holdings = await prisma.investmentHolding.findMany({
    where: { accountId },
    select: { id: true, ticker: true, createdAt: true, lastDividendScanAt: true, lastDividendAttemptAt: true },
  });

  await Promise.all(
    holdings.map(async (holding) => {
      const tag = `[dividend-scan] ${accountName} / ${holding.ticker}`;

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const cutoff = lastCutoff8pmET(now);

      // Skip if already successfully scanned since the last 8 PM ET cutoff.
      if (holding.lastDividendScanAt && holding.lastDividendScanAt >= cutoff) {
        console.log(`${tag}: skipped (already scanned since last 8 PM ET cutoff)`);
        return;
      }

      // Skip if the last attempt (success or failure) was within the past hour —
      // prevents hammering Tiingo when rate-limited during a multi-load session.
      if (holding.lastDividendAttemptAt &&
          now.getTime() - holding.lastDividendAttemptAt.getTime() < ATTEMPT_RETRY_MS) {
        const nextAt = new Date(holding.lastDividendAttemptAt.getTime() + ATTEMPT_RETRY_MS);
        console.log(`${tag}: skipped (rate-limit backoff — next attempt after ${nextAt.toLocaleString()})`);
        return;
      }

      // Look back 14 days before the holding was created so we catch dividends
      // whose ex-date fell just before the user added the holding but whose
      // payable date lands after — a common pattern for mutual funds.
      const lookbackMs = 14 * 24 * 60 * 60 * 1000;
      const startDate = new Date(holding.createdAt.getTime() - lookbackMs)
        .toISOString()
        .slice(0, 10);

      // Stamp the attempt time before calling Tiingo so that even a failure is
      // recorded and the 1-hour retry backoff applies.
      await prisma.investmentHolding.update({
        where: { id: holding.id },
        data: { lastDividendAttemptAt: now },
      });

      // Deduplicate Tiingo API calls across accounts: if another account already
      // queued or completed a fetch for this ticker this session, reuse that
      // Promise rather than issuing a second identical request.
      let scanPromise: Promise<DividendScanResult>;
      if (tickerCache?.has(holding.ticker)) {
        console.log(`${tag}: skipped API call — ticker already queried this session`);
        scanPromise = tickerCache.get(holding.ticker)!;
      } else {
        console.log(`${tag}: querying Tiingo (${startDate} → ${todayStr})`);
        scanPromise = getDividendScanResult(holding.ticker, startDate, todayStr);
        tickerCache?.set(holding.ticker, scanPromise);
      }

      let scanResult: DividendScanResult;
      try {
        scanResult = await scanPromise;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = msg.includes("429");
        if (isRateLimit) {
          console.warn(`${tag}: RATE LIMITED — ${msg}`);
        } else {
          console.warn(`${tag}: API ERROR — ${msg}`);
        }
        return;
      }

      const { dividends: events, latestClose, latestCloseDate } = scanResult;

      // Log the raw API response before any business logic is applied
      if (events.length === 0) {
        console.log(`${tag}: no dividend events returned`);
      } else {
        // Events are in ascending date order from Tiingo
        const latest = events[events.length - 1];
        console.log(
          `${tag}: ${events.length} event(s) from API. ` +
          `Latest → ex-date ${latest.exDate}, $${latest.perShareAmount}/share`,
        );
      }

      // Stamp the holding as successfully scanned so it is skipped until the
      // next 8 PM ET daily cutoff.
      await prisma.investmentHolding.update({
        where: { id: holding.id },
        data: { lastDividendScanAt: now },
      });

      // Piggyback: update TickerPrice with the latest close from this response.
      // Avoids a redundant Tiingo call during price refresh for Tiingo-sourced tickers.
      // Only write if this is the first call for this ticker (not a cache hit) so we
      // don't redundantly upsert for every account that holds the same fund.
      if (latestClose != null && latestCloseDate != null && !tickerCache?.has(holding.ticker + "__written")) {
        tickerCache?.set(holding.ticker + "__written", Promise.resolve(scanResult));
        const priceDate = new Date(latestCloseDate + "T00:00:00Z");
        const historyDate = new Date(Date.UTC(
          priceDate.getUTCFullYear(), priceDate.getUTCMonth(), priceDate.getUTCDate(),
        ));
        await prisma.tickerPrice.upsert({
          where: { ticker: holding.ticker },
          create: { ticker: holding.ticker, price: latestClose, priceDate, priceSource: "TIINGO" },
          update: { price: latestClose, priceDate, priceSource: "TIINGO" },
        });
        await prisma.tickerPriceHistory.upsert({
          where: { ticker_date: { ticker: holding.ticker, date: historyDate } },
          create: { ticker: holding.ticker, date: historyDate, closePrice: latestClose },
          update: { closePrice: latestClose },
        });
        console.log(`${tag}: piggybacked price update — $${latestClose} (${latestCloseDate})`);
      }

      for (const event of events) {
        const exDate = new Date(event.exDate);

        // Check if we already have a pending dividend for this holding + ex-date
        const existing = await prisma.pendingDividend.findUnique({
          where: { holdingId_exDate: { holdingId: holding.id, exDate } },
        });
        if (existing) {
          console.log(`${tag} [${event.exDate}]: skipped — PendingDividend already exists (status: ${existing.status})`);
          continue;
        }

        // Check if a DIVIDEND activity already exists for this holding near this date
        // (±3 days to account for minor date discrepancies)
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
          console.log(`${tag} [${event.exDate}]: skipped — DIVIDEND activity already recorded (id: ${existingActivity.id})`);
          continue;
        }

        const shares = await getSharesAtDate(holding.id, exDate);
        if (shares <= 0) {
          console.log(`${tag} [${event.exDate}]: skipped — 0 shares at ex-date`);
          continue;
        }

        const estimatedTotal = parseFloat(
          (shares * event.perShareAmount).toFixed(2),
        );

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
            accountId,
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
          `${tag} [${event.exDate}]: created PendingDividend — ` +
          `${shares} shares × $${event.perShareAmount} = $${estimatedTotal}`,
        );
      }
    }),
  );
}

// ── GET /:accountId — scan + return pending dividends ────────────────────────

pendingDividendRoutes.get("/:accountId", async (req, res) => {
  const { accountId } = req.params;

  // Verify account exists
  const account = await prisma.account.findUnique({ where: { id: accountId } });
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
  const { id } = req.params;

  const existing = await prisma.pendingDividend.findUnique({ where: { id } });
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
  const { id } = req.params;
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const pending = await prisma.pendingDividend.findUnique({ where: { id } });
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

    // 3. Mark the pending dividend as confirmed
    const confirmedPending = await tx.pendingDividend.update({
      where: { id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        activityId: activity.id,
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
  const { id } = req.params;
  const parsed = confirmReinvestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const pending = await prisma.pendingDividend.findUnique({ where: { id } });
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

    // 5. Mark the pending dividend as confirmed
    const confirmedPending = await tx.pendingDividend.update({
      where: { id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        activityId: dividendActivity.id,
      },
    });

    return { dividendActivity, purchaseActivity, lot, income, pendingDividend: confirmedPending };
  });

  res.status(201).json(result);
});
