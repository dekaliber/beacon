import { Router } from "express";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getDividendEvents } from "../services/tiingo.js";

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

// How long to wait before re-querying Tiingo for a holding that was already scanned.
const SCAN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Scan all active holdings for an account and create PendingDividend records
 * for any new dividend events found in Tiingo's daily price data.
 *
 * Holdings scanned within the last 24 hours are skipped entirely — Tiingo is
 * only queried once per holding per day to stay within free-tier rate limits.
 * Already-seen (holdingId, exDate) pairs are also skipped via the unique constraint.
 * Events where shares-at-ex-date = 0 are skipped.
 */
export async function scanForDividends(accountId: string): Promise<void> {
  const holdings = await prisma.investmentHolding.findMany({
    where: { accountId },
    select: { id: true, ticker: true, createdAt: true, lastDividendScanAt: true },
  });

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const cutoff = new Date(today.getTime() - SCAN_TTL_MS);

  await Promise.all(
    holdings.map(async (holding) => {
      const tag = `[dividend-scan] ${holding.ticker}`;

      // Skip if scanned recently — avoids unnecessary Tiingo API calls
      if (holding.lastDividendScanAt && holding.lastDividendScanAt > cutoff) {
        const nextAt = new Date(holding.lastDividendScanAt.getTime() + SCAN_TTL_MS);
        console.log(`${tag}: skipped (TTL — next scan after ${nextAt.toLocaleString()})`);
        return;
      }

      const startDate = holding.createdAt.toISOString().slice(0, 10);
      console.log(`${tag}: querying Tiingo (${startDate} → ${todayStr})`);

      let events;
      try {
        events = await getDividendEvents(holding.ticker, startDate, todayStr);
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

      // Stamp the holding as scanned regardless of whether new dividends were found
      await prisma.investmentHolding.update({
        where: { id: holding.id },
        data: { lastDividendScanAt: today },
      });

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

        // Upsert — the unique constraint on (holdingId, exDate) prevents duplicates
        // but a concurrent scan could race; upsert handles that cleanly.
        await prisma.pendingDividend.upsert({
          where: { holdingId_exDate: { holdingId: holding.id, exDate } },
          create: {
            holdingId: holding.id,
            accountId,
            ticker: holding.ticker,
            exDate,
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

  res.json(pending);
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
  dividendType: z
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

  const {
    date,
    perShareAmount,
    shares,
    totalAmount,
    categoryId,
    dividendType,
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

    // 2. Create the linked Income record
    const income = await tx.income.create({
      data: {
        amount: totalAmount,
        source: source ?? pending.ticker,
        date: payableDate,
        accountId: pending.accountId,
        subtype: "DIVIDEND",
        dividendType: dividendType ?? null,
        taxableAmount: dividendType === "RETURN_OF_CAPITAL" ? 0 : totalAmount,
        categoryId: categoryId ?? null,
        notes: notes ?? null,
        activityId: activity.id,
      },
      include: INCOME_INCLUDE,
    });

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
// linked PURCHASE activity. No Income record is created — the dividend is
// treated as a non-cash event that increases the holding's cost basis.

const confirmReinvestSchema = z.object({
  exDate: z.string(),              // ISO date of the ex-dividend date
  reinvestDate: z.string(),        // ISO date when the shares were actually purchased
  perShareAmount: z.number().positive(),
  shares: z.number().positive(),   // shares held at ex-date
  totalAmount: z.number().positive(),
  reinvestPrice: z.number().positive(),
  reinvestQuantity: z.number().positive(),
  dividendType: z
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

  const {
    exDate,
    reinvestDate,
    perShareAmount,
    shares,
    totalAmount,
    reinvestPrice,
    reinvestQuantity,
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

    // 4. Mark the pending dividend as confirmed
    const confirmedPending = await tx.pendingDividend.update({
      where: { id },
      data: {
        status: "CONFIRMED",
        confirmedAt: new Date(),
        activityId: dividendActivity.id,
      },
    });

    return { dividendActivity, purchaseActivity, lot, pendingDividend: confirmedPending };
  });

  res.status(201).json(result);
});
