import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db/client.js";
import { z } from "zod";
import { getUserId } from "../middleware/auth.js";
import { nextBusinessDay } from "../lib/businessDays.js";
import { fetchYahooClosingPrice, fetchYahooEarnings } from "../services/yahoo.js";

export const optionsRoutes = Router();

// Position with the includes needed by the close side-effects routine.
type ClosedPositionWithRelations = Prisma.OptionsPositionGetPayload<{
  include: { ticker: true; group: true; pendingBuy: true; pendingSale: true };
}>;

// Effective contract count used in the income source string (assigned legs key
// on the assigned count).
function effectiveContracts(leg: { outcome: string | null; contracts: number; contractsAssigned: number | null }) {
  return leg.outcome === "ASSIGNED"
    ? Number(leg.contractsAssigned ?? leg.contracts)
    : Number(leg.contracts);
}

// Clean, human-readable "Options Premium" income source for a closed leg, e.g.
// "QXO 26.06.05 Put $16 x3". This is display-only — income rows are synced by
// the stable optionsPositionId FK, not by this string.
function optionsBaseSource(leg: {
  ticker: { symbol: string };
  expirationDate: Date;
  optionType: string;
  strikePrice: unknown;
  outcome: string | null;
  contracts: number;
  contractsAssigned: number | null;
}) {
  const exp = leg.expirationDate;
  const yy = String(exp.getUTCFullYear()).slice(2);
  const mm = String(exp.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(exp.getUTCDate()).padStart(2, "0");
  const expStr = `${yy}.${mm}.${dd}`;
  const strike = Number(leg.strikePrice);
  const strikeStr = strike === Math.floor(strike) ? `$${Math.floor(strike)}` : `$${strike}`;
  const optionType = leg.optionType === "CALL" ? "Call" : "Put";
  return `${leg.ticker.symbol} ${expStr} ${optionType} ${strikeStr} x${effectiveContracts(leg)}`;
}

// Apply the income / PendingBuy / PendingSale side-effects of closing (or
// assigning) a position leg. Shared by the full-close PUT handler and the
// partial-close split endpoint so both produce identical accounting records.
async function applyCloseSideEffects(
  userId: string,
  updated: ClosedPositionWithRelations,
  bankingAccountId: string | null,
) {
  // When a PUT is assigned and has an investment account linked,
  // create a PendingBuy (if one doesn't already exist for this position).
  if (
    updated.outcome === "ASSIGNED" &&
    updated.optionType === "PUT" &&
    updated.investmentAccountId &&
    !updated.pendingBuy
  ) {
    const shares = (updated.contractsAssigned ?? updated.contracts) * 100;
    const totalFees = (Number(updated.feesOpen) || 0) + (Number(updated.feesClose) || 0);
    const costPerShare =
      Number(updated.strikePrice) -
      Number(updated.premiumPerShare) +
      totalFees / shares;

    await prisma.pendingBuy.upsert({
      where: { optionsPositionId: updated.id },
      create: {
        userId,
        accountId: updated.investmentAccountId,
        optionsPositionId: updated.id,
        ticker: updated.ticker.symbol,
        quantity: shares,
        costPerShare: Math.max(0, costPerShare),
        acquiredDate: updated.closedAt ?? updated.expirationDate,
      },
      update: {},
    });
  }

  // Keep a still-PENDING buy in sync with the position while it awaits confirmation:
  // refresh the derived cost basis, quantity, acquired date, and account from the
  // (possibly edited) position — e.g. a fee/premium correction made via "Edit Position
  // Details". Once the buy is confirmed into a lot the basis is committed and is NOT
  // touched here; adjust it directly on the lot (PUT /investments/lots/:id) if needed.
  if (
    updated.pendingBuy &&
    updated.pendingBuy.status === "PENDING" &&
    updated.investmentAccountId
  ) {
    const shares = (updated.contractsAssigned ?? updated.contracts) * 100;
    const totalFees = (Number(updated.feesOpen) || 0) + (Number(updated.feesClose) || 0);
    const costPerShare =
      Number(updated.strikePrice) - Number(updated.premiumPerShare) + totalFees / shares;
    await prisma.pendingBuy.update({
      where: { id: updated.pendingBuy.id },
      data: {
        accountId: updated.investmentAccountId,
        quantity: shares,
        costPerShare: Math.max(0, costPerShare),
        acquiredDate: updated.closedAt ?? updated.expirationDate,
      },
    });
  }

  // When a CALL is assigned and has an investment account linked,
  // create a PendingSale so the user can review and confirm the lot disposition.
  // pricePerShare = strike + premium − fees/share (the full "amount realized" per share
  // for tax purposes; the premium's own income record has taxableAmount = 0).
  if (
    updated.outcome === "ASSIGNED" &&
    updated.optionType === "CALL" &&
    updated.investmentAccountId &&
    !updated.pendingSale
  ) {
    const shares = (updated.contractsAssigned ?? updated.contracts) * 100;
    const totalFees = (Number(updated.feesOpen) || 0) + (Number(updated.feesClose) || 0);
    const pricePerShare =
      Number(updated.strikePrice) +
      Number(updated.premiumPerShare) -
      totalFees / shares;

    await prisma.pendingSale.upsert({
      where: { optionsPositionId: updated.id },
      create: {
        userId,
        accountId: updated.investmentAccountId,
        optionsPositionId: updated.id,
        ticker: updated.ticker.symbol,
        quantity: shares,
        pricePerShare: Math.max(0, pricePerShare),
        saleDate: updated.expirationDate,
      },
      update: {},
    });
  }

  // Keep a still-PENDING sale in sync with the position while it awaits confirmation:
  // refresh the derived sale price (amount realized/share), quantity, date, and account
  // from the (possibly edited) position. Once the sale is confirmed into a SALE activity
  // the realized gain is committed and is NOT touched here.
  if (
    updated.pendingSale &&
    updated.pendingSale.status === "PENDING" &&
    updated.investmentAccountId
  ) {
    const shares = (updated.contractsAssigned ?? updated.contracts) * 100;
    const totalFees = (Number(updated.feesOpen) || 0) + (Number(updated.feesClose) || 0);
    const pricePerShare =
      Number(updated.strikePrice) + Number(updated.premiumPerShare) - totalFees / shares;
    await prisma.pendingSale.update({
      where: { id: updated.pendingSale.id },
      data: {
        accountId: updated.investmentAccountId,
        quantity: shares,
        pricePerShare: Math.max(0, pricePerShare),
        saleDate: updated.expirationDate,
      },
    });
  }

  // Sync the "Options Premium" Income record for income-generating close outcomes.
  // Note we do NOT gate on bankingAccountId here: an already-linked income row must
  // re-sync whenever the position's economics change (e.g. correcting open/close fees
  // via "Edit Position Details", which sends no bankingAccountId) — otherwise the row's
  // amount/taxableAmount silently drift from the position. A banking account is only
  // required to *create* a brand-new income row (see the create branch below).
  if (
    updated.outcome === "EXPIRED_WORTHLESS" ||
    updated.outcome === "CLOSED_EARLY" ||
    updated.outcome === "ASSIGNED"
  ) {
    // Helper: net premium for a single position leg
    const legNet = (pos: {
      outcome: string | null;
      premiumPerShare: unknown;
      closePremiumPerShare: unknown;
      contracts: number;
      contractsAssigned: number | null;
      feesOpen: unknown;
      feesClose: unknown;
    }) => {
      const c = pos.outcome === "ASSIGNED"
        ? Number(pos.contractsAssigned ?? pos.contracts)
        : Number(pos.contracts);
      return (Number(pos.premiumPerShare) - Number(pos.closePremiumPerShare ?? 0)) * c * 100
        - Number(pos.feesOpen ?? 0)
        - Number(pos.feesClose ?? 0);
    };

    // For roll chains, sum net premium across all legs so the income record
    // reflects the economics of the entire chain, not just the final leg.
    let netAmount: number;
    if (updated.groupId) {
      const allLegs = await prisma.optionsPosition.findMany({
        where: { groupId: updated.groupId },
      });
      netAmount = allLegs.reduce((sum, leg) => sum + legNet(leg), 0);
    } else {
      netAmount = legNet(updated);
    }

    if (netAmount > 0) {
      // Find or create "Options Premium" income category for this user
      let category = await prisma.category.findFirst({
        where: { userId, name: "Options Premium", kind: "INCOME" },
      });
      if (!category) {
        category = await prisma.category.create({
          data: { userId, name: "Options Premium", kind: "INCOME" },
        });
      }

      // Display-only source string. Income rows are synced by the stable
      // optionsPositionId FK, so split siblings sharing ticker/expiry/strike/count
      // may legitimately render identical strings — that's fine for the user.
      const source = optionsBaseSource(updated);

      // Settlement date = T+1 business day after close (OCC equity option settlement rule).
      // Fall back to expiration date for EXPIRED_WORTHLESS (no explicit closedAt).
      // Skip weekends and US Federal Reserve bank holidays so the settlement date always
      // lands on a valid banking day.
      const rawDate = updated.closedAt ?? updated.expirationDate;
      const closeDay = new Date(Date.UTC(rawDate.getUTCFullYear(), rawDate.getUTCMonth(), rawDate.getUTCDate()));
      const incomeDate = nextBusinessDay(closeDay);

      // Option premium is short-term capital gain/loss for a retail writer (IRS
      // Pub 550): writing an option that expires worthless, or closing/rolling a
      // written option, realizes STCG/STCL regardless of holding period. So the
      // income record is booked as CAPITAL_GAIN below, not ordinary income.
      //
      // The lone exception is the *assigned* leg: its premium folds into the stock
      // leg instead (reduces cost basis for puts, increases sale proceeds for calls)
      // and surfaces as capital gain on the sale — so we exclude only that leg's own
      // net premium from taxableAmount. Intermediate rolled/closed legs in the chain
      // (bought to close at a gain or loss) remain independently taxable; zeroing the
      // whole chain would silently drop those roll gains/losses from the estimator.
      const taxableAmount = updated.outcome === "ASSIGNED"
        ? round2(netAmount - legNet(updated))
        : netAmount;

      // Sync key: the stable optionsPositionId FK. Fall back to a legacy match by
      // clean source + amount (only on rows not yet linked) so any position whose
      // income predates the backfill self-heals on edit instead of duplicating;
      // the amount guard avoids hijacking an unrelated orphan income row.
      let existingIncome = await prisma.income.findFirst({
        where: { categoryId: category.id, optionsPositionId: updated.id },
      });
      if (!existingIncome) {
        const legacy = await prisma.income.findFirst({
          where: { categoryId: category.id, source, optionsPositionId: null },
        });
        if (legacy && Math.abs(Number(legacy.amount) - netAmount) < 0.005) {
          existingIncome = legacy;
        }
      }

      if (existingIncome) {
        // Re-sync the linked row. Keep its existing account unless the caller
        // supplied a new bankingAccountId (accountId is non-nullable, so never
        // overwrite it with null when editing position details).
        await prisma.income.update({
          where: { id: existingIncome.id },
          data: {
            amount: netAmount,
            taxableAmount,
            subtype: "CAPITAL_GAIN",
            taxClassification: "CAPITAL_GAIN",
            accountId: bankingAccountId ?? existingIncome.accountId,
            source,
            optionsPositionId: updated.id,
          },
        });
      } else if (bankingAccountId) {
        // Only create a new row when we have an account to attach it to. Without
        // one (e.g. a position-details edit on a position that never had its
        // premium banked), there is nothing to create and nothing to update.
        await prisma.income.create({
          data: {
            amount: netAmount,
            categoryId: category.id,
            source,
            date: incomeDate,
            accountId: bankingAccountId,
            subtype: "CAPITAL_GAIN",
            taxClassification: "CAPITAL_GAIN",
            taxableAmount,
            optionsPositionId: updated.id,
          },
        });
      }
    }
  }
}

// ── Tradier API helpers ────────────────────────────────────────────────────────

const TRADIER_BASE = "https://api.tradier.com/v1";

function tradierHeaders(): Record<string, string> {
  const token = process.env.TRADIER_API_TOKEN;
  if (!token) throw new Error("TRADIER_API_TOKEN is not set in the server environment");
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

// ── Yahoo Finance helper (benchmark indices) ────────────────────────────────────
// Tradier/Tiingo don't serve raw index symbols (^SP500TR, ^IXIC), but Yahoo does.
// Returns the total-return % change of `symbol` from the first trading day on/after
// `startDate` (YYYY-MM-DD) through the latest available daily close. Uses adjclose
// so index total-return series (which already bake in dividends) are used as-is.
async function fetchYahooReturnSince(
  symbol: string,
  startDate: string
): Promise<{ startPrice: number; currentPrice: number; pctChange: number; asOf: string } | null> {
  try {
    // Start a week early so the first trading day on/after startDate is included
    // even when startDate falls on a weekend or market holiday.
    const period1 = Math.floor(new Date(startDate + "T00:00:00Z").getTime() / 1000) - 7 * 86400;
    const period2 = Math.floor(Date.now() / 1000);
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=1d&period1=${period1}&period2=${period2}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps: number[] = result.timestamp ?? [];
    const adjClose: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];
    const close: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];

    const startMs = new Date(startDate + "T00:00:00Z").getTime();
    const priceAt = (i: number): number | null => adjClose[i] ?? close[i] ?? null;

    // First valid close on/after the start date
    let startPrice: number | null = null;
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] * 1000 < startMs) continue;
      const p = priceAt(i);
      if (p != null && p > 0) { startPrice = p; break; }
    }
    // Latest valid close
    let currentPrice: number | null = null;
    let asOf = new Date().toISOString();
    for (let i = timestamps.length - 1; i >= 0; i--) {
      const p = priceAt(i);
      if (p != null && p > 0) { currentPrice = p; asOf = new Date(timestamps[i] * 1000).toISOString(); break; }
    }
    if (startPrice == null || currentPrice == null) return null;

    return { startPrice, currentPrice, pctChange: (currentPrice / startPrice - 1) * 100, asOf };
  } catch {
    return null;
  }
}

// ── Settings ───────────────────────────────────────────────────────────────────

const settingsSchema = z.object({
  startingBasis: z.coerce.number().positive(),
  targetReturn: z.coerce.number().positive(),
  startingWeek: z.string().nullable().optional(),
  defaultCashAccountId: z.string().nullable().optional(),
});

optionsRoutes.get("/settings", async (req, res) => {
  const userId = getUserId(req);
  const settings = await prisma.optionsSettings.findUnique({ where: { userId } });
  res.json(settings ?? null);
});

optionsRoutes.put("/settings", async (req, res) => {
  const userId = getUserId(req);
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const settings = await prisma.optionsSettings.upsert({
    where: { userId },
    create: { userId, ...parsed.data },
    update: parsed.data,
  });
  res.json(settings);
});

// ── Capital Changes ────────────────────────────────────────────────────────────

const capitalChangeSchema = z.object({
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  delta: z.coerce.number().refine((v) => v !== 0, { message: "Delta cannot be zero" }),
  note: z.string().nullable().optional(),
  // Client local date, used to decide whether the boundary is "live" (include the
  // open-option mark) or back-dated (assigned-share marks only).
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

// Batched live stock quotes from Tradier → { SYMBOL: last (or close) }.
async function fetchTradierStockQuotes(symbols: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (symbols.length === 0) return out;
  const url = `${TRADIER_BASE}/markets/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}`;
  const r = await fetch(url, { headers: tradierHeaders() });
  if (!r.ok) return out;
  const data = (await r.json()) as any;
  const raw = data?.quotes?.quote;
  if (!raw) return out;
  for (const q of Array.isArray(raw) ? raw : [raw]) {
    if (q?.symbol) out.set(String(q.symbol).toUpperCase(), q.last ?? q.close ?? null);
  }
  return out;
}

// Live option chain for one (symbol, expiration) from Tradier.
async function fetchTradierChain(symbol: string, expiration: string): Promise<any[]> {
  const url = `${TRADIER_BASE}/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(expiration)}&greeks=false`;
  const r = await fetch(url, { headers: tradierHeaders() });
  if (!r.ok) return [];
  const data = (await r.json()) as any;
  const chain = data?.options?.option;
  return Array.isArray(chain) ? chain : chain ? [chain] : [];
}

type SnapshotDetail = {
  capturedVia: "tradier-live" | "yahoo-historical";
  effectiveDate: string;
  isLive: boolean;
  assignedLots: { ticker: string; shares: number; costBasis: number; price: number; source: string; unrealized: number; ccStrike: number | null; coveredShares: number }[];
  openOptions: {
    positionId: string; symbol: string; optionType: string; strike: number; expiration: string;
    contracts: number; premiumReceived: number; currentMark: number; source: string; mark: number;
  }[];
  totals: { assignedUnrealized: number; openOptionMark: number; unrealizedSnapshot: number };
};

// Mark-to-market of all holdings as of `effectiveDate`, used to pin NAV at a
// basis-change boundary so "Return on basis" can be chained as a true
// time-weighted return.
//
// Live boundaries (effectiveDate >= clientToday) fire a FRESH Tradier refresh:
// assigned shares are valued at the live underlying quote and each open option
// is re-marked from the Tradier chain (and its current price persisted), so the
// snapshot matches what the page shows. Back-dated boundaries fall back to the
// Tiingo historical close for assigned shares and exclude open options.
async function captureBasisSnapshot(
  userId: string,
  effectiveDate: string,
  clientToday: string,
): Promise<{ unrealizedSnapshot: number; excludesOptions: boolean; detail: SnapshotDetail }> {
  const isLive = effectiveDate >= clientToday;

  const lots = await prisma.investmentLot.findMany({
    where: { fromOptionsPositionId: { not: null }, holding: { account: { userId } } },
    select: {
      quantity: true,
      holding: { select: { ticker: true, accountId: true } },
      fromOptionsPosition: { select: { strikePrice: true, expirationDate: true } },
    },
  });

  // Open covered calls written against assigned batches, keyed by the original
  // CSP strike/expiry they recover — mirrors GET /assigned-shares/active so the
  // snapshot caps covered-share gains at the CC strike exactly like the page.
  const openCalls = await prisma.optionsPosition.findMany({
    where: {
      userId, optionType: "CALL", status: "OPEN", isActive: true,
      assignedFromStrikePrice: { not: null }, assignedFromExpirationDate: { not: null },
    },
    select: {
      contracts: true, strikePrice: true, investmentAccountId: true,
      assignedFromStrikePrice: true, assignedFromExpirationDate: true,
      ticker: { select: { symbol: true } },
    },
  });
  const batchKey = (ticker: string, strike: number, expiry: string, accountId: string) =>
    `${ticker}|${strike}|${expiry}|${accountId}`;
  const ccContractsByBatch = new Map<string, number>();
  const ccStrikeWeightedByBatch = new Map<string, number>();
  for (const cc of openCalls) {
    if (cc.assignedFromStrikePrice == null || cc.assignedFromExpirationDate == null || cc.investmentAccountId == null) continue;
    const key = batchKey(
      cc.ticker.symbol, Number(cc.assignedFromStrikePrice),
      cc.assignedFromExpirationDate.toISOString().slice(0, 10), cc.investmentAccountId,
    );
    ccContractsByBatch.set(key, (ccContractsByBatch.get(key) ?? 0) + cc.contracts);
    ccStrikeWeightedByBatch.set(key, (ccStrikeWeightedByBatch.get(key) ?? 0) + Number(cc.strikePrice) * cc.contracts);
  }

  const assignedLots: SnapshotDetail["assignedLots"] = [];
  const openOptions: SnapshotDetail["openOptions"] = [];
  let assignedUnrealized = 0;
  let openOptionMark = 0;

  // ── Assigned-share unrealized ───────────────────────────────────────────────
  // Resolve each ticker's price with a layered fallback (source recorded in the
  // detail). Live: fresh Tradier → last stored TickerPrice → Yahoo EOD close.
  // Back-dated: stored daily close (TickerPriceHistory) → Yahoo EOD close.
  const tickers = [...new Set(lots.map((l) => l.holding.ticker))];
  const priceForTicker = new Map<string, { price: number; source: string } | null>();

  if (isLive) {
    const live = await fetchTradierStockQuotes(tickers);
    const cachedRows = await prisma.tickerPrice.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, price: true },
    });
    const cache = new Map(cachedRows.map((c) => [c.ticker, Number(c.price)]));
    for (const t of tickers) {
      const tradier = live.get(t.toUpperCase());
      if (tradier != null) { priceForTicker.set(t, { price: tradier, source: "tradier-live" }); continue; }
      const stored = cache.get(t);
      if (stored != null) { priceForTicker.set(t, { price: stored, source: "ticker-price-cache" }); continue; }
      const eod = await fetchYahooClosingPrice(t, effectiveDate);
      priceForTicker.set(t, eod != null ? { price: eod, source: "yahoo-eod" } : null);
    }
  } else {
    const effDate = new Date(effectiveDate + "T00:00:00.000Z");
    for (const t of tickers) {
      const hist = await prisma.tickerPriceHistory.findFirst({
        where: { ticker: t, date: { lte: effDate } },
        orderBy: { date: "desc" },
        select: { closePrice: true },
      });
      if (hist != null) { priceForTicker.set(t, { price: Number(hist.closePrice), source: "ticker-price-history" }); continue; }
      const eod = await fetchYahooClosingPrice(t, effectiveDate);
      priceForTicker.set(t, eod != null ? { price: eod, source: "yahoo-eod" } : null);
    }
  }

  for (const l of lots) {
    if (l.fromOptionsPosition == null) continue;
    const ticker = l.holding.ticker;
    const resolved = priceForTicker.get(ticker);
    if (resolved == null) continue;
    const price = resolved.price;
    const shares = Number(l.quantity);
    const costBasis = Number(l.fromOptionsPosition.strikePrice);

    // Cap covered shares at the open covered-call strike when the CC is ITM —
    // those shares are effectively called away at the CC strike. Mirrors the
    // client's totalUnrealizedPnl so U(boundary) and U(now) use one methodology.
    const key = batchKey(ticker, costBasis, l.fromOptionsPosition.expirationDate.toISOString().slice(0, 10), l.holding.accountId);
    const ccContracts = ccContractsByBatch.get(key) ?? 0;
    const ccStrike = ccContracts > 0 ? (ccStrikeWeightedByBatch.get(key) ?? 0) / ccContracts : null;
    const coveredShares = Math.min(ccContracts * 100, shares);
    const uncoveredShares = shares - coveredShares;
    const ccIsItm = ccStrike != null && price > ccStrike && coveredShares > 0;

    const unrealized = round2(
      ccIsItm && ccStrike != null
        ? (ccStrike - costBasis) * coveredShares + (price - costBasis) * uncoveredShares
        : (price - costBasis) * shares,
    );
    assignedUnrealized += unrealized;
    assignedLots.push({
      ticker, shares, costBasis, price, source: resolved.source, unrealized,
      ccStrike: ccIsItm ? ccStrike : null, coveredShares: ccIsItm ? coveredShares : 0,
    });
  }

  // ── Open-option mark (live boundaries only) ────────────────────────────────
  if (isLive) {
    const openPositions = await prisma.optionsPosition.findMany({
      where: { userId, status: "OPEN", isActive: true, isDraft: false },
      select: {
        id: true, optionType: true, strikePrice: true, expirationDate: true, contracts: true,
        premiumPerShare: true, feesOpen: true, currentPremiumPerShare: true,
        ticker: { select: { symbol: true } },
      },
    });

    // Fetch each (symbol, expiration) chain once.
    const chainCache = new Map<string, any[]>();
    for (const p of openPositions) {
      const symbol = p.ticker.symbol;
      const expiration = p.expirationDate.toISOString().slice(0, 10);
      const key = `${symbol}|${expiration}`;
      if (!chainCache.has(key)) chainCache.set(key, await fetchTradierChain(symbol, expiration));

      const wantType = p.optionType === "CALL" ? "call" : "put";
      const strike = Number(p.strikePrice);
      const match = chainCache.get(key)!.find(
        (o: any) => (o.option_type ?? "").toLowerCase() === wantType && Math.abs(Number(o.strike) - strike) < 0.001,
      );
      const freshLast: number | null = match?.last ?? null;

      // Persist the fresh price so the page's live P&L stays in sync with the snapshot.
      if (freshLast != null) {
        await prisma.optionsPosition.update({ where: { id: p.id }, data: { currentPremiumPerShare: freshLast } });
      }
      const currentMark = freshLast ?? (p.currentPremiumPerShare != null ? Number(p.currentPremiumPerShare) : null);
      if (currentMark == null) continue; // no price anywhere → skip this leg

      const premiumReceived = Number(p.premiumPerShare);
      const mark = round2((premiumReceived - currentMark) * 100 * p.contracts - Number(p.feesOpen ?? 0));
      openOptionMark += mark;
      openOptions.push({
        positionId: p.id, symbol, optionType: p.optionType, strike, expiration, contracts: p.contracts,
        premiumReceived, currentMark, source: freshLast != null ? "tradier-live" : "stored", mark,
      });
    }
  }

  assignedUnrealized = round2(assignedUnrealized);
  openOptionMark = round2(openOptionMark);
  const unrealizedSnapshot = round2(assignedUnrealized + openOptionMark);

  const detail: SnapshotDetail = {
    capturedVia: isLive ? "tradier-live" : "yahoo-historical",
    effectiveDate,
    isLive,
    assignedLots,
    openOptions,
    totals: { assignedUnrealized, openOptionMark, unrealizedSnapshot },
  };
  return { unrealizedSnapshot, excludesOptions: !isLive, detail };
}

optionsRoutes.get("/capital-changes", async (req, res) => {
  const userId = getUserId(req);
  const changes = await prisma.optionsCapitalChange.findMany({
    where: { userId },
    orderBy: { effectiveDate: "asc" },
  });
  res.json(changes);
});

optionsRoutes.post("/capital-changes", async (req, res) => {
  const userId = getUserId(req);
  const parsed = capitalChangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { today, ...changeData } = parsed.data;
  const change = await prisma.optionsCapitalChange.create({
    data: { userId, ...changeData },
  });

  // Capture the boundary NAV snapshot so "Return on basis" can chain a true
  // time-weighted return. Best-effort: a market-data failure must not block the
  // adjustment — the snapshot stays null and the metric falls back to a ratio.
  try {
    const { unrealizedSnapshot, excludesOptions, detail } = await captureBasisSnapshot(
      userId,
      change.effectiveDate,
      today ?? change.effectiveDate,
    );
    const updated = await prisma.optionsCapitalChange.update({
      where: { id: change.id },
      data: {
        unrealizedSnapshot,
        snapshotCapturedAt: new Date(),
        snapshotExcludesOptions: excludesOptions,
        snapshotDetail: detail,
      },
    });
    return res.status(201).json(updated);
  } catch (err) {
    console.error("Failed to capture basis snapshot:", err);
    return res.status(201).json(change);
  }
});

optionsRoutes.delete("/capital-changes/:id", async (req, res) => {
  const userId = getUserId(req);
  const result = await prisma.optionsCapitalChange.deleteMany({
    where: { id: req.params.id, userId },
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.status(204).send();
});

// ── Tickers ────────────────────────────────────────────────────────────────────

const tickerSchema = z.object({
  symbol: z.string().min(1).max(10).toUpperCase(),
  opportunityCostStartDate: z.string().nullable().optional(),
  opportunityCostStartPrice: z.coerce.number().positive().nullable().optional(),
});

optionsRoutes.get("/tickers", async (req, res) => {
  const userId = getUserId(req);
  const tickers = await prisma.optionsTicker.findMany({
    where: { userId, isActive: true },
    orderBy: { symbol: "asc" },
  });
  res.json(tickers);
});

optionsRoutes.post("/tickers", async (req, res) => {
  const userId = getUserId(req);
  const parsed = tickerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.optionsTicker.findFirst({
    where: { userId, symbol: parsed.data.symbol },
  });
  if (existing) {
    if (!existing.isActive) {
      const restored = await prisma.optionsTicker.update({
        where: { id: existing.id },
        data: { isActive: true, ...parsed.data },
      });
      return res.status(201).json(restored);
    }
    return res.status(409).json({ error: "Ticker already exists" });
  }

  const ticker = await prisma.optionsTicker.create({
    data: { userId, ...parsed.data },
  });
  res.status(201).json(ticker);
});

optionsRoutes.put("/tickers/:id", async (req, res) => {
  const userId = getUserId(req);
  const parsed = tickerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ticker = await prisma.optionsTicker.updateMany({
    where: { id: req.params.id, userId },
    data: parsed.data,
  });
  if (ticker.count === 0) return res.status(404).json({ error: "Not found" });
  res.json(await prisma.optionsTicker.findUnique({ where: { id: req.params.id } }));
});

// ── Position Groups ────────────────────────────────────────────────────────────

const groupSchema = z.object({
  label: z.string().nullable().optional(),
});

optionsRoutes.get("/groups", async (req, res) => {
  const userId = getUserId(req);
  const groups = await prisma.optionsPositionGroup.findMany({
    where: { userId, isActive: true },
    include: { positions: { where: { isActive: true }, orderBy: { sequenceInGroup: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(groups);
});

optionsRoutes.post("/groups", async (req, res) => {
  const userId = getUserId(req);
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const group = await prisma.optionsPositionGroup.create({
    data: { userId, ...parsed.data },
  });
  res.status(201).json(group);
});

optionsRoutes.put("/groups/:id", async (req, res) => {
  const userId = getUserId(req);
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await prisma.optionsPositionGroup.updateMany({
    where: { id: req.params.id, userId },
    data: parsed.data,
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });
  res.json(await prisma.optionsPositionGroup.findUnique({ where: { id: req.params.id } }));
});

// ── Positions ──────────────────────────────────────────────────────────────────

const positionOpenSchema = z.object({
  tickerId: z.string(),
  groupId: z.string().nullable().optional(),
  sequenceInGroup: z.coerce.number().int().positive().nullable().optional(),
  optionType: z.enum(["CALL", "PUT"]),
  side: z.enum(["BUY", "SELL"]).default("SELL"),
  strikePrice: z.coerce.number().positive(),
  expirationDate: z.string(), // ISO date string YYYY-MM-DD
  openedAt: z.string().optional(), // ISO datetime string in UTC (client converts from ET); optional for drafts
  contracts: z.coerce.number().int().positive(),
  premiumPerShare: z.coerce.number().positive(),
  feesOpen: z.coerce.number().nonnegative().nullable().optional(),
  shareCostBasis: z.coerce.number().positive().nullable().optional(),
  stockPriceAtOpen: z.coerce.number().positive().nullable().optional(),
  currentPremiumPerShare: z.coerce.number().nonnegative().nullable().optional(),
  currentDelta: z.coerce.number().nullable().optional(),
  currentDeltaAsOf: z.string().nullable().optional(), // ISO datetime string (Tradier greek time)
  excludeFromLivePnl: z.boolean().optional(),
  deltaAtOpen: z.coerce.number().nullable().optional(),
  deltaAtOpenCapturedAt: z.string().nullable().optional(), // ISO datetime string
  notes: z.string().nullable().optional(),
  assignedFromStrikePrice: z.coerce.number().positive().nullable().optional(),
  assignedFromExpirationDate: z.string().nullable().optional(), // YYYY-MM-DD
  investmentAccountId: z.string().nullable().optional(),
  isDraft: z.boolean().optional(),
});

const positionCloseSchema = z.object({
  status: z.enum(["CLOSED", "EXPIRED", "ASSIGNED"]),
  outcome: z.enum(["EXPIRED_WORTHLESS", "CLOSED_EARLY", "ROLLED", "ASSIGNED"]),
  closedAt: z.string().nullable().optional(),
  closePremiumPerShare: z.coerce.number().nonnegative().nullable().optional(),
  feesClose: z.coerce.number().nonnegative().nullable().optional(),
  contractsAssigned: z.coerce.number().int().nonnegative().nullable().optional(),
  stockPriceAtClose: z.coerce.number().positive().nullable().optional(),
  bankingAccountId: z.string().nullable().optional(),
});

optionsRoutes.get("/positions", async (req, res) => {
  const userId = getUserId(req);
  const { status } = req.query;

  const where: Record<string, unknown> = { userId, isActive: true };
  if (status === "open") where.status = "OPEN";
  if (status === "closed") where.status = { in: ["CLOSED", "EXPIRED", "ASSIGNED"] };

  const positions = await prisma.optionsPosition.findMany({
    where,
    include: {
      ticker: true,
      group: true,
    },
    orderBy: { openedAt: "desc" },
  });
  res.json(positions);
});

optionsRoutes.post("/positions", async (req, res) => {
  const userId = getUserId(req);
  const parsed = positionOpenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Verify ticker belongs to user
  const ticker = await prisma.optionsTicker.findFirst({
    where: { id: parsed.data.tickerId, userId },
  });
  if (!ticker) return res.status(400).json({ error: "Invalid ticker" });

  const openedAt = parsed.data.openedAt ? new Date(parsed.data.openedAt) : new Date();

  // Auto-set opportunity cost start date to first non-draft position date if not set
  if (!ticker.opportunityCostStartDate && !parsed.data.isDraft) {
    await prisma.optionsTicker.update({
      where: { id: ticker.id },
      data: { opportunityCostStartDate: openedAt },
    });
  }

  const { openedAt: _openedAt, assignedFromExpirationDate, deltaAtOpenCapturedAt, ...restData } = parsed.data;
  const position = await prisma.optionsPosition.create({
    data: {
      userId,
      ...restData,
      openedAt,
      expirationDate: new Date(parsed.data.expirationDate + "T20:00:00.000Z"),
      assignedFromExpirationDate: assignedFromExpirationDate
        ? new Date(assignedFromExpirationDate + "T20:00:00.000Z")
        : null,
      deltaAtOpenCapturedAt: deltaAtOpenCapturedAt ? new Date(deltaAtOpenCapturedAt) : null,
    },
    include: { ticker: true, group: true },
  });
  res.status(201).json(position);
});

optionsRoutes.put("/positions/:id", async (req, res) => {
  const userId = getUserId(req);

  // Allow updating open fields or close fields
  const openParsed = positionOpenSchema.partial().safeParse(req.body);
  const closeParsed = positionCloseSchema.partial().safeParse(req.body);

  const data: Record<string, unknown> = {};
  if (openParsed.success) Object.assign(data, openParsed.data);
  if (closeParsed.success) Object.assign(data, closeParsed.data);
  if (typeof data.expirationDate === "string") {
    data.expirationDate = new Date(data.expirationDate + "T20:00:00.000Z");
  }
  if (typeof data.assignedFromExpirationDate === "string") {
    data.assignedFromExpirationDate = new Date(data.assignedFromExpirationDate + "T20:00:00.000Z");
  }
  if (typeof data.deltaAtOpenCapturedAt === "string") {
    data.deltaAtOpenCapturedAt = new Date(data.deltaAtOpenCapturedAt);
  }
  if (typeof data.currentDeltaAsOf === "string") {
    data.currentDeltaAsOf = new Date(data.currentDeltaAsOf);
  }
  // Extract bankingAccountId: persist it on the position so edit modal can re-populate it,
  // and also use it below to create/update the Income record.
  const bankingAccountId = typeof data.bankingAccountId === "string" ? data.bankingAccountId : null;
  // Keep it in `data` so Prisma saves it; it is a valid position field.

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No valid fields provided" });
  }

  const result = await prisma.optionsPosition.updateMany({
    where: { id: req.params.id, userId },
    data,
  });
  if (result.count === 0) return res.status(404).json({ error: "Not found" });

  const updated = await prisma.optionsPosition.findUnique({
    where: { id: req.params.id },
    include: { ticker: true, group: true, pendingBuy: true, pendingSale: true },
  });

  if (updated) {
    await applyCloseSideEffects(userId, updated, bankingAccountId);
  }

  res.json(updated);
});

// Partial close: split N contracts off an OPEN position into a new closed leg,
// leaving the remainder open. Supports EXPIRED_WORTHLESS / CLOSED_EARLY / ASSIGNED.
// Rolls go through the roll endpoint (which opens a replacement leg).
//
// Two code paths, chosen by whether the position is part of a roll chain:
//  • Standalone (no groupId): shrink the original, spin off one closed leg.
//  • Chained (groupId set): clone the ENTIRE chain into a fresh group, scaled to
//    N contracts, and close that clone's final leg. Every original leg shrinks
//    by N, so both the shrunken original chain and the spun-off clone chain stay
//    internally uniform (all legs same contract count) — which every chain-rollup
//    stat relies on. Because the slice is a real chain, it inherits the prior
//    rolls' premium: its P&L is (chain net premium − close cost) per share, not
//    just the final leg's economics.
//
// Fee policy (both paths): all pre-existing fees stay on the originals; the
// spun-off leg carries only the freshly-entered close fee. Keeps per-share
// premium math clean and conserves total fees across the split.
const partialCloseSchema = z.object({
  contracts: z.coerce.number().int().positive(),
  outcome: z.enum(["EXPIRED_WORTHLESS", "CLOSED_EARLY", "ASSIGNED"]),
  closedAt: z.string().nullable().optional(),
  closePremiumPerShare: z.coerce.number().nonnegative().nullable().optional(),
  feesClose: z.coerce.number().nonnegative().nullable().optional(),
  stockPriceAtClose: z.coerce.number().positive().nullable().optional(),
  investmentAccountId: z.string().nullable().optional(),
  bankingAccountId: z.string().nullable().optional(),
});

const OUTCOME_STATUS: Record<"EXPIRED_WORTHLESS" | "CLOSED_EARLY" | "ASSIGNED", "EXPIRED" | "CLOSED" | "ASSIGNED"> = {
  EXPIRED_WORTHLESS: "EXPIRED",
  CLOSED_EARLY: "CLOSED",
  ASSIGNED: "ASSIGNED",
};

optionsRoutes.post("/positions/:id/partial-close", async (req, res) => {
  const userId = getUserId(req);
  const parsed = partialCloseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const {
    contracts: n, outcome, closedAt, closePremiumPerShare, feesClose,
    stockPriceAtClose, investmentAccountId, bankingAccountId,
  } = parsed.data;

  const original = await prisma.optionsPosition.findFirst({
    where: { id: req.params.id, userId, isActive: true, status: "OPEN", isDraft: false },
  });
  if (!original) return res.status(404).json({ error: "Position not found or already closed" });

  if (n >= original.contracts) {
    return res.status(409).json({ error: "Use a full close when closing all contracts." });
  }

  // Close-side fields for the leg that actually closes (the final leg of the
  // split). Identical for both the standalone and chained paths.
  const closeData = {
    status: OUTCOME_STATUS[outcome],
    outcome,
    closedAt: outcome === "EXPIRED_WORTHLESS" ? null : closedAt ? new Date(closedAt) : new Date(),
    closePremiumPerShare: outcome === "ASSIGNED" ? null : closePremiumPerShare ?? null,
    feesClose: feesClose ?? null,
    contractsAssigned: outcome === "ASSIGNED" ? n : null,
    stockPriceAtClose: outcome === "ASSIGNED" ? stockPriceAtClose ?? null : null,
  };

  const newLeg = await prisma.$transaction(async (tx): Promise<ClosedPositionWithRelations> => {
    if (original.groupId) {
      // ── Chained: clone the whole roll chain (scaled to N) into a new group ──
      const chainLegs = await tx.optionsPosition.findMany({
        where: { groupId: original.groupId, isActive: true },
        orderBy: { sequenceInGroup: "asc" },
      });
      // Shared split group ties the shrunken original chain to the spun-off clone
      // so the UI can relate them (and offer an "undo split"). Keyed on the chain.
      const splitGroupId = original.splitGroupId ?? `split_${original.groupId}`;
      const newGroup = await tx.optionsPositionGroup.create({ data: { userId } });

      let finalClone: ClosedPositionWithRelations | undefined;
      for (const leg of chainLegs) {
        // Shrink the original leg; stamp the split group (idempotent).
        await tx.optionsPosition.update({
          where: { id: leg.id },
          data: { contracts: leg.contracts - n, splitGroupId },
        });

        const isFinal = leg.id === original.id;
        const clone = await tx.optionsPosition.create({
          data: {
            userId,
            tickerId: leg.tickerId,
            groupId: newGroup.id,
            sequenceInGroup: leg.sequenceInGroup,
            splitGroupId,
            optionType: leg.optionType,
            side: leg.side,
            strikePrice: leg.strikePrice,
            expirationDate: leg.expirationDate,
            openedAt: leg.openedAt,
            contracts: n,
            premiumPerShare: leg.premiumPerShare,
            feesOpen: null,
            shareCostBasis: leg.shareCostBasis,
            stockPriceAtOpen: leg.stockPriceAtOpen,
            deltaAtOpen: leg.deltaAtOpen,
            deltaAtOpenCapturedAt: leg.deltaAtOpenCapturedAt,
            assignedFromStrikePrice: leg.assignedFromStrikePrice,
            assignedFromExpirationDate: leg.assignedFromExpirationDate,
            investmentAccountId: isFinal
              ? (outcome === "ASSIGNED" ? (investmentAccountId ?? leg.investmentAccountId) : leg.investmentAccountId)
              : leg.investmentAccountId,
            bankingAccountId: isFinal ? (bankingAccountId ?? null) : null,
            // Prior (already-rolled) legs copy their existing close terms; the
            // final leg takes the freshly-entered close details.
            ...(isFinal ? closeData : {
              status: leg.status,
              outcome: leg.outcome,
              closedAt: leg.closedAt,
              closePremiumPerShare: leg.closePremiumPerShare,
              feesClose: null,
              contractsAssigned: leg.contractsAssigned,
              stockPriceAtClose: leg.stockPriceAtClose,
            }),
          },
          include: { ticker: true, group: true, pendingBuy: true, pendingSale: true },
        });
        if (isFinal) finalClone = clone;
      }
      return finalClone!;
    }

    // ── Standalone: shrink the original, spin off one closed leg ──
    const splitGroupId = original.splitGroupId ?? `split_${original.id}`;
    if (!original.splitGroupId) {
      await tx.optionsPosition.update({ where: { id: original.id }, data: { splitGroupId } });
    }
    await tx.optionsPosition.update({
      where: { id: original.id },
      data: { contracts: original.contracts - n },
    });

    return tx.optionsPosition.create({
      data: {
        userId,
        tickerId: original.tickerId,
        splitGroupId,
        optionType: original.optionType,
        side: original.side,
        strikePrice: original.strikePrice,
        expirationDate: original.expirationDate,
        openedAt: original.openedAt,
        contracts: n,
        premiumPerShare: original.premiumPerShare,
        feesOpen: null,
        shareCostBasis: original.shareCostBasis,
        stockPriceAtOpen: original.stockPriceAtOpen,
        deltaAtOpen: original.deltaAtOpen,
        deltaAtOpenCapturedAt: original.deltaAtOpenCapturedAt,
        assignedFromStrikePrice: original.assignedFromStrikePrice,
        assignedFromExpirationDate: original.assignedFromExpirationDate,
        investmentAccountId: outcome === "ASSIGNED" ? (investmentAccountId ?? original.investmentAccountId) : original.investmentAccountId,
        bankingAccountId: bankingAccountId ?? null,
        ...closeData,
      },
      include: { ticker: true, group: true, pendingBuy: true, pendingSale: true },
    });
  });

  await applyCloseSideEffects(userId, newLeg, bankingAccountId ?? null);

  res.status(201).json(newLeg);
});

// Roll a position: close it with outcome=ROLLED, open a new one, link both via a group
const rollSchema = z.object({
  // Close side
  closedAt: z.string().nullable().optional(),
  closePremiumPerShare: z.coerce.number().nonnegative().nullable().optional(),
  feesClose: z.coerce.number().nonnegative().nullable().optional(),
  // New position side
  newPremiumPerShare: z.coerce.number().positive(),
  newStrikePrice: z.coerce.number().positive(),
  newExpirationDate: z.string(), // YYYY-MM-DD
  newStockPriceAtOpen: z.coerce.number().positive().nullable().optional(),
  newFeesOpen: z.coerce.number().nonnegative().nullable().optional(),
  // Partial roll: roll only N of the position's contracts, leaving the rest open.
  // Omitted or equal to the full size = roll the whole position (legacy behavior).
  contracts: z.coerce.number().int().positive().optional(),
});

optionsRoutes.post("/positions/:id/roll", async (req, res) => {
  const userId = getUserId(req);
  const parsed = rollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.optionsPosition.findFirst({
    where: { id: req.params.id, userId, isActive: true, status: "OPEN" },
  });
  if (!existing) return res.status(404).json({ error: "Position not found or already closed" });

  const {
    closedAt, closePremiumPerShare, feesClose,
    newPremiumPerShare, newStrikePrice, newExpirationDate, newStockPriceAtOpen, newFeesOpen,
    contracts: rollContracts,
  } = parsed.data;

  const isPartial = rollContracts != null && rollContracts < existing.contracts;
  if (rollContracts != null && rollContracts > existing.contracts) {
    return res.status(409).json({ error: "Cannot roll more contracts than the position holds." });
  }
  // A partial roll splits the position; like partial-close, that is incompatible
  // with a position that is already part of a roll chain (breaks chain stats).
  if (isPartial && existing.groupId) {
    return res.status(409).json({ error: "Cannot partially roll a position that is already part of a roll chain." });
  }

  const closeAt = closedAt ? new Date(closedAt) : new Date();
  const openAt = closedAt ? new Date(closedAt) : new Date();
  const newExpiry = new Date(newExpirationDate + "T20:00:00.000Z");

  const result = await prisma.$transaction(async (tx) => {
    if (isPartial) {
      const n = rollContracts!;
      // Fresh roll chain for the rolled-off slice. The original stays OPEN with the
      // remaining contracts and is NOT placed in the chain, so it can still be
      // partially closed/rolled later.
      const group = await tx.optionsPositionGroup.create({ data: { userId } });
      const splitGroupId = existing.splitGroupId ?? `split_${existing.id}`;

      // Reduce the original; stamp split group so the UI can relate the slices.
      await tx.optionsPosition.update({
        where: { id: existing.id },
        data: { contracts: existing.contracts - n, splitGroupId },
      });

      // Spin off the rolled-closed leg (seq 1). All open fees stay on the original.
      const closed = await tx.optionsPosition.create({
        data: {
          userId,
          tickerId: existing.tickerId,
          groupId: group.id,
          sequenceInGroup: 1,
          splitGroupId,
          optionType: existing.optionType,
          side: existing.side,
          strikePrice: existing.strikePrice,
          expirationDate: existing.expirationDate,
          openedAt: existing.openedAt,
          contracts: n,
          premiumPerShare: existing.premiumPerShare,
          feesOpen: null,
          shareCostBasis: existing.shareCostBasis,
          stockPriceAtOpen: existing.stockPriceAtOpen,
          assignedFromStrikePrice: existing.assignedFromStrikePrice,
          assignedFromExpirationDate: existing.assignedFromExpirationDate,
          investmentAccountId: existing.investmentAccountId,
          status: "CLOSED",
          outcome: "ROLLED",
          closedAt: closeAt,
          closePremiumPerShare: closePremiumPerShare ?? null,
          feesClose: feesClose ?? null,
        },
        include: { ticker: true, group: true },
      });

      // Open the replacement leg (seq 2) for the same N contracts.
      const opened = await tx.optionsPosition.create({
        data: {
          userId,
          tickerId: existing.tickerId,
          groupId: group.id,
          sequenceInGroup: 2,
          optionType: existing.optionType,
          side: existing.side,
          strikePrice: newStrikePrice,
          expirationDate: newExpiry,
          openedAt: openAt,
          contracts: n,
          premiumPerShare: newPremiumPerShare,
          feesOpen: newFeesOpen ?? null,
          stockPriceAtOpen: newStockPriceAtOpen ?? null,
          shareCostBasis: existing.shareCostBasis,
          assignedFromStrikePrice: existing.assignedFromStrikePrice,
          assignedFromExpirationDate: existing.assignedFromExpirationDate,
          investmentAccountId: existing.investmentAccountId,
        },
        include: { ticker: true, group: true },
      });

      return { closed, opened };
    }

    // ── Full roll (legacy behavior) ──────────────────────────────────────────
    // Determine group: reuse existing or create a new one
    let groupId = existing.groupId;
    if (!groupId) {
      const group = await tx.optionsPositionGroup.create({
        data: { userId },
      });
      groupId = group.id;
      // Assign the original position to the group as sequence 1
      await tx.optionsPosition.update({
        where: { id: existing.id },
        data: { groupId, sequenceInGroup: 1 },
      });
    }

    // Find next sequence number
    const maxSeq = await tx.optionsPosition.aggregate({
      where: { groupId, isActive: true },
      _max: { sequenceInGroup: true },
    });
    const nextSeq = (maxSeq._max.sequenceInGroup ?? 1) + 1;

    // Close the existing position
    const closed = await tx.optionsPosition.update({
      where: { id: existing.id },
      data: {
        status: "CLOSED",
        outcome: "ROLLED",
        closedAt: closeAt,
        closePremiumPerShare: closePremiumPerShare ?? null,
        feesClose: feesClose ?? null,
      },
      include: { ticker: true, group: true },
    });

    // Open the new position
    const opened = await tx.optionsPosition.create({
      data: {
        userId,
        tickerId: existing.tickerId,
        groupId,
        sequenceInGroup: nextSeq,
        optionType: existing.optionType,
        side: existing.side,
        strikePrice: newStrikePrice,
        expirationDate: newExpiry,
        openedAt: openAt,
        contracts: existing.contracts,
        premiumPerShare: newPremiumPerShare,
        feesOpen: newFeesOpen ?? null,
        stockPriceAtOpen: newStockPriceAtOpen ?? null,
        shareCostBasis: existing.shareCostBasis,
        assignedFromStrikePrice: existing.assignedFromStrikePrice,
        assignedFromExpirationDate: existing.assignedFromExpirationDate,
        investmentAccountId: existing.investmentAccountId,
      },
      include: { ticker: true, group: true },
    });

    return { closed, opened };
  });

  res.status(201).json(result);
});

optionsRoutes.delete("/positions/:id", async (req, res) => {
  const userId = getUserId(req);

  const leg = await prisma.optionsPosition.findFirst({
    where: { id: req.params.id, userId, isActive: true },
    include: { ticker: true, pendingBuy: true, pendingSale: true },
  });
  if (!leg) return res.status(404).json({ error: "Not found" });

  // A closed split leg is "undone" by returning its N contracts to the still-open
  // sibling it was split from, then removing its accounting side-effects. The
  // still-open sibling is found via the shared splitGroupId. Two shapes:
  //  • Standalone split → `leg` has no chain; sibling is a single open leg.
  //  • Chained split → `leg` is the terminal leg (outcome !== ROLLED) of a
  //    spun-off clone chain; sibling is the still-open ORIGINAL chain (a
  //    different, non-null group). Undo restores N to every leg of that chain
  //    and tears down the whole clone chain.
  //
  // The two lookups are kept distinct — never a single findFirst on splitGroupId
  // alone — because a chain born from a partial *roll* shares its splitGroupId
  // with the standalone position it rolled off of, so an unqualified match could
  // return the wrong sibling. The chained lookup pins groupId (not null, not this
  // leg's own group); the standalone lookup only runs when `leg` has no group.
  const splittable = !!leg.splitGroupId && leg.status !== "OPEN";

  const chainUndoSibling = splittable && leg.groupId != null && leg.outcome !== "ROLLED"
    ? await prisma.optionsPosition.findFirst({
        where: {
          userId, splitGroupId: leg.splitGroupId!, status: "OPEN", isActive: true,
          groupId: { not: null }, NOT: { groupId: leg.groupId },
        },
      })
    : null;
  const isChainUndo = chainUndoSibling != null;

  const mergeTarget = splittable && leg.groupId == null
    ? await prisma.optionsPosition.findFirst({
        where: { userId, splitGroupId: leg.splitGroupId!, status: "OPEN", isActive: true },
      })
    : null;

  if (mergeTarget || isChainUndo) {
    // Refuse to silently undo an assignment that has already been converted into a
    // lot — the user must revert that downstream record first.
    if (leg.pendingBuy && leg.pendingBuy.status !== "PENDING") {
      return res.status(409).json({ error: "This assignment was already processed into a purchase. Revert the pending buy first." });
    }
    if (leg.pendingSale && leg.pendingSale.status !== "PENDING") {
      return res.status(409).json({ error: "This assignment was already processed into a sale. Revert the pending sale first." });
    }
  }

  let returnedContracts = 0;
  await prisma.$transaction(async (tx) => {
    if (chainUndoSibling) {
      const n = leg.contracts; // clone chains are uniform: every leg holds N
      returnedContracts = n;
      // Return N contracts to every leg of the still-open original chain.
      const siblingLegs = await tx.optionsPosition.findMany({
        where: { groupId: chainUndoSibling.groupId!, isActive: true },
      });
      for (const s of siblingLegs) {
        await tx.optionsPosition.update({ where: { id: s.id }, data: { contracts: s.contracts + n } });
      }
      // Tear down the spun-off clone chain and its accounting side-effects.
      const cloneLegs = await tx.optionsPosition.findMany({
        where: { groupId: leg.groupId!, isActive: true },
      });
      await tx.income.deleteMany({ where: { optionsPositionId: { in: cloneLegs.map((l) => l.id) } } });
      if (leg.pendingBuy) await tx.pendingBuy.delete({ where: { id: leg.pendingBuy.id } });
      if (leg.pendingSale) await tx.pendingSale.delete({ where: { id: leg.pendingSale.id } });
      for (const cl of cloneLegs) {
        await tx.optionsPosition.update({ where: { id: cl.id }, data: { isActive: false } });
      }
      return;
    }

    if (mergeTarget) {
      returnedContracts = leg.contracts;
      await tx.optionsPosition.update({
        where: { id: mergeTarget.id },
        data: { contracts: mergeTarget.contracts + leg.contracts },
      });
      if (leg.pendingBuy) await tx.pendingBuy.delete({ where: { id: leg.pendingBuy.id } });
      if (leg.pendingSale) await tx.pendingSale.delete({ where: { id: leg.pendingSale.id } });

      // Remove this leg's income row, keyed on the stable FK.
      await tx.income.deleteMany({ where: { optionsPositionId: leg.id } });
    }

    await tx.optionsPosition.update({
      where: { id: leg.id },
      data: { isActive: false },
    });
  });

  res.json({ merged: mergeTarget != null || isChainUndo, returnedContracts });
});

// ── Stock Quote (Tradier) ──────────────────────────────────────────────────────

optionsRoutes.get("/stock-quote/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const url = `${TRADIER_BASE}/markets/quotes?symbols=${encodeURIComponent(symbol)}`;
    const tradierRes = await fetch(url, { headers: tradierHeaders() });
    if (!tradierRes.ok) {
      return res.status(502).json({ error: `Tradier returned ${tradierRes.status}` });
    }
    const data = await tradierRes.json() as any;
    const quote = data?.quotes?.quote;
    if (!quote || quote.last == null) {
      return res.status(404).json({ error: "No quote data found" });
    }
    res.json({ price: Number(quote.last), priceDate: quote.trade_date ?? new Date().toISOString() });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Batch Stock Quotes ────────────────────────────────────────────────────────
// GET /stock-quotes?symbols=CCJ,PYPL,GLW  →  { CCJ: { price, priceDate }, … }

optionsRoutes.get("/stock-quotes", async (req, res) => {
  const { symbols } = req.query;
  if (!symbols || typeof symbols !== "string") {
    return res.status(400).json({ error: "Missing symbols" });
  }
  const symbolList = symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbolList.length === 0) {
    return res.status(400).json({ error: "No valid symbols provided" });
  }
  try {
    const url = `${TRADIER_BASE}/markets/quotes?symbols=${symbolList.map(encodeURIComponent).join(",")}`;
    const tradierRes = await fetch(url, { headers: tradierHeaders() });
    if (!tradierRes.ok) {
      return res.status(502).json({ error: `Tradier returned ${tradierRes.status}` });
    }
    const data = await tradierRes.json() as any;
    const raw = data?.quotes?.quote;
    if (!raw) return res.status(404).json({ error: "No quote data found" });
    const quotesArr: any[] = Array.isArray(raw) ? raw : [raw];
    const result: Record<string, { price: number; priceDate: string }> = {};
    for (const q of quotesArr) {
      if (q?.symbol && q.last != null) {
        result[q.symbol] = { price: Number(q.last), priceDate: q.trade_date ?? new Date().toISOString() };
      }
    }
    res.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Upcoming Earnings (Yahoo) ─────────────────────────────────────────────────
// GET /earnings?symbols=NVDA,CEG&today=YYYY-MM-DD
//   →  { NVDA: { date, timing, isEstimate } | null, … }
// Tradier serves no corporate-events data, so earnings dates come from Yahoo.

optionsRoutes.get("/earnings", async (req, res) => {
  const { symbols, today } = req.query as Record<string, string | undefined>;
  if (!symbols) return res.status(400).json({ error: "Missing symbols" });
  if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return res.status(400).json({ error: "Missing or invalid today (expected YYYY-MM-DD)" });
  }

  const symbolList = symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbolList.length === 0) return res.status(400).json({ error: "No valid symbols provided" });

  try {
    const earnings = await fetchYahooEarnings(symbolList, today);
    res.json(Object.fromEntries(earnings));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Benchmark Performance (Yahoo indices) ─────────────────────────────────────
// GET /benchmark?start=YYYY-MM-DD  →  total-return % of S&P 500 TR and Nasdaq
// Composite since the user's start date, for side-by-side comparison with the
// account's marked return.
const BENCHMARKS: { symbol: string; label: string }[] = [
  { symbol: "^SP500TR", label: "S&P 500 TR" },
  { symbol: "^IXIC", label: "Nasdaq Comp" },
  { symbol: "^PUT", label: "S&P 500 PutWrite" },
  { symbol: "^BXM", label: "S&P 500 BuyWrite" },
];

optionsRoutes.get("/benchmark", async (req, res) => {
  const { start } = req.query;
  if (!start || typeof start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return res.status(400).json({ error: "Missing or invalid start (expected YYYY-MM-DD)" });
  }
  try {
    const benchmarks = await Promise.all(
      BENCHMARKS.map(async ({ symbol, label }) => {
        const r = await fetchYahooReturnSince(symbol, start);
        return { symbol, label, pctChange: r?.pctChange ?? null, asOf: r?.asOf ?? null };
      })
    );
    res.json({ benchmarks });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Stock Price at Open (Tradier timesales) ───────────────────────────────────

optionsRoutes.get("/stock-price-at-open", async (req, res) => {
  const { symbol, openedAt } = req.query;
  if (!symbol || !openedAt) {
    return res.status(400).json({ error: "Missing symbol or openedAt" });
  }

  try {
    // openedAt is "YYYY-MM-DDTHH:mm" in ET — Tradier timesales accepts ET strings natively
    const [datePart, timePart] = (openedAt as string).split("T");
    const [h, m] = timePart.split(":").map(Number);
    const startStr = `${datePart} ${timePart}:00`;

    // End = start + 3 minutes (handles hour rollover)
    const endTotalMin = h * 60 + m + 3;
    const endH = Math.floor(endTotalMin / 60) % 24;
    const endM = endTotalMin % 60;
    const endDatePart = endTotalMin >= 24 * 60
      ? new Date(new Date(datePart).getTime() + 86_400_000).toISOString().slice(0, 10)
      : datePart;
    const endStr = `${endDatePart} ${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00`;

    const url =
      `${TRADIER_BASE}/markets/timesales` +
      `?symbol=${encodeURIComponent(symbol as string)}` +
      `&interval=1min` +
      `&start=${encodeURIComponent(startStr)}` +
      `&end=${encodeURIComponent(endStr)}` +
      `&session_filter=open`;

    const tradierRes = await fetch(url, { headers: tradierHeaders() });
    if (!tradierRes.ok) {
      return res.status(502).json({ error: `Tradier returned ${tradierRes.status}` });
    }

    const data = await tradierRes.json() as any;
    // Tradier returns a single object (not array) when there's only one candle
    const raw = data?.series?.data;
    if (!raw) return res.status(404).json({ error: "No price data found" });
    const candles: any[] = Array.isArray(raw) ? raw : [raw];
    if (candles.length === 0) return res.status(404).json({ error: "No price data found" });

    const candle = candles[0];
    const price: number = candle.open;
    const candleDate = new Date(candle.timestamp * 1000);
    const timeLabel =
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(candleDate) + " ET";

    res.json({ price, timeLabel });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Option Quote (Tradier) ─────────────────────────────────────────────────────

optionsRoutes.get("/option-quote", async (req, res) => {
  const { symbol, type, strike, expiration } = req.query;

  if (!symbol || !type || !strike || !expiration) {
    return res.status(400).json({ error: "Missing required params: symbol, type, strike, expiration" });
  }

  const strikeNum = parseFloat(strike as string);
  const optionSide = (type as string).toUpperCase();

  try {
    const url = `${TRADIER_BASE}/markets/options/chains?symbol=${encodeURIComponent(symbol as string)}&expiration=${encodeURIComponent(expiration as string)}&greeks=true`;
    const tradierRes = await fetch(url, { headers: tradierHeaders() });
    if (!tradierRes.ok) {
      return res.status(502).json({ error: `Tradier returned ${tradierRes.status}` });
    }

    const data = await tradierRes.json() as any;
    const chain: any[] = data?.options?.option ?? [];
    if (chain.length === 0) {
      return res.status(404).json({ error: "No option chain data found" });
    }

    // Filter to the requested side, then find the closest strike
    const sideChain = chain.filter((o: any) =>
      (o.option_type ?? "").toUpperCase() === (optionSide === "CALL" ? "call" : "put").toUpperCase()
    );
    const option = sideChain.reduce((best: any, o: any) => {
      if (!best) return o;
      return Math.abs(o.strike - strikeNum) < Math.abs(best.strike - strikeNum) ? o : best;
    }, null);

    if (!option || Math.abs(option.strike - strikeNum) > 1) {
      return res.status(404).json({ error: "No matching option found for that strike" });
    }

    const bid: number | null = option.bid ?? null;
    const ask: number | null = option.ask ?? null;
    const lastPrice: number | null = option.last ?? null;
    const mark = bid != null && ask != null ? (bid + ask) / 2 : lastPrice;
    const delta: number | null = option.greeks?.delta ?? null;
    // Tradier's greeks.updated_at is a bare "YYYY-MM-DD HH:MM:SS" string in UTC
    // (an ET reading lands in the future). Normalize to ISO so the client can
    // format it and show how stale the delta actually is.
    const rawGreekTime: string | null = option.greeks?.updated_at ?? null;
    const deltaUpdatedAt = rawGreekTime
      ? new Date(rawGreekTime.replace(" ", "T") + "Z").toISOString()
      : null;

    res.json({
      bid,
      ask,
      lastPrice,
      mark,
      impliedVolatility: option.greeks?.mid_iv ?? option.greeks?.smv_vol ?? null,
      volume: option.volume ?? null,
      openInterest: option.open_interest ?? null,
      inTheMoney: option.in_the_money ?? null,
      delta,
      deltaUpdatedAt,
      capturedAt: new Date().toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Option Screener (Tradier) ──────────────────────────────────────────────────

optionsRoutes.get("/screener", async (req, res) => {
  const {
    tickers: tickersParam,
    optionType = "BOTH",
    minDTE,
    maxDTE,
    minDelta,
    maxDelta,
    minOI,
    minVolume,
    strikeMin,
    strikeMax,
  } = req.query as Record<string, string | undefined>;

  if (!tickersParam) {
    return res.status(400).json({ error: "Missing required param: tickers" });
  }

  const symbols = tickersParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) return res.status(400).json({ error: "No tickers provided" });

  const minDTEn = minDTE != null ? parseInt(minDTE, 10) : null;
  const maxDTEn = maxDTE != null ? parseInt(maxDTE, 10) : null;
  const minDeltaN = minDelta != null ? parseFloat(minDelta) : null;
  const maxDeltaN = maxDelta != null ? parseFloat(maxDelta) : null;
  const minOIn = minOI != null ? parseInt(minOI, 10) : null;
  const minVolumeN = minVolume != null ? parseInt(minVolume, 10) : null;
  const strikeMinN = strikeMin != null ? parseFloat(strikeMin) : null;
  const strikeMaxN = strikeMax != null ? parseFloat(strikeMax) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const results: Array<{
    ticker: string;
    expiration: string;
    dte: number;
    strike: number;
    optionType: "CALL" | "PUT";
    underlyingPrice: number | null;
    delta: number | null;
    iv: number | null;
    bid: number | null;
    ask: number | null;
    last: number | null;
    openInterest: number | null;
    volume: number | null;
    inTheMoney: boolean | null;
  }> = [];

  try {
    const headers = tradierHeaders();

    // Batch-fetch current underlying prices for all tickers upfront
    const quoteUrl = `${TRADIER_BASE}/markets/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}&greeks=false`;
    const quoteRes = await fetch(quoteUrl, { headers });
    const underlyingPriceMap = new Map<string, number | null>();
    if (quoteRes.ok) {
      const quoteData = await quoteRes.json() as any;
      const rawQuotes = quoteData?.quotes?.quote ?? [];
      const quotesArr = Array.isArray(rawQuotes) ? rawQuotes : [rawQuotes];
      for (const q of quotesArr) {
        underlyingPriceMap.set((q.symbol as string).toUpperCase(), q.last ?? q.close ?? null);
      }
    }

    for (const symbol of symbols) {
      // 1. Fetch available expirations
      const expUrl = `${TRADIER_BASE}/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=false`;
      const expRes = await fetch(expUrl, { headers });
      if (!expRes.ok) continue;
      const expData = await expRes.json() as any;
      const dates: string[] = expData?.expirations?.date ?? [];
      if (dates.length === 0) continue;

      // 2. Filter by DTE range
      const eligibleDates = dates.filter((d) => {
        const exp = new Date(d + "T00:00:00");
        const dte = Math.round((exp.getTime() - today.getTime()) / 86400000);
        if (minDTEn != null && dte < minDTEn) return false;
        if (maxDTEn != null && dte > maxDTEn) return false;
        return true;
      });

      // 3. For each eligible expiration, fetch chains and filter
      for (const expDate of eligibleDates) {
        const exp = new Date(expDate + "T00:00:00");
        const dte = Math.round((exp.getTime() - today.getTime()) / 86400000);

        const chainUrl = `${TRADIER_BASE}/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${expDate}&greeks=true`;
        const chainRes = await fetch(chainUrl, { headers });
        if (!chainRes.ok) continue;
        const chainData = await chainRes.json() as any;
        const chain: any[] = chainData?.options?.option ?? [];

        for (const opt of chain) {
          const side: "CALL" | "PUT" = (opt.option_type ?? "").toLowerCase() === "call" ? "CALL" : "PUT";
          if (optionType !== "BOTH" && side !== optionType) continue;

          const strike: number = opt.strike;
          if (strikeMinN != null && strike < strikeMinN) continue;
          if (strikeMaxN != null && strike > strikeMaxN) continue;

          const delta: number | null = opt.greeks?.delta ?? null;
          const absDelta = delta != null ? Math.abs(delta) : null;
          if (minDeltaN != null && absDelta != null && absDelta < minDeltaN) continue;
          if (maxDeltaN != null && absDelta != null && absDelta > maxDeltaN) continue;

          const oi: number | null = opt.open_interest ?? null;
          if (minOIn != null && oi != null && oi < minOIn) continue;

          const volume: number | null = opt.volume ?? null;
          if (minVolumeN != null && volume != null && volume < minVolumeN) continue;

          const bid: number | null = opt.bid ?? null;
          const ask: number | null = opt.ask ?? null;
          const last: number | null = opt.last ?? null;

          results.push({
            ticker: symbol,
            expiration: expDate,
            dte,
            strike,
            optionType: side,
            underlyingPrice: underlyingPriceMap.get(symbol) ?? null,
            delta,
            iv: opt.greeks?.mid_iv ?? opt.greeks?.smv_vol ?? null,
            bid,
            ask,
            last,
            openInterest: oi,
            volume: opt.volume ?? null,
            inTheMoney: opt.in_the_money ?? null,
          });
        }
      }
    }

    // Sort by ticker → expiration → strike
    results.sort((a, b) => {
      const t = a.ticker.localeCompare(b.ticker);
      if (t !== 0) return t;
      const e = a.expiration.localeCompare(b.expiration);
      if (e !== 0) return e;
      return a.strike - b.strike;
    });

    res.json(results);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

// ── Import ─────────────────────────────────────────────────────────────────────

const importRowSchema = z.object({
  tickerSymbol: z.string().min(1).max(10).toUpperCase(),
  optionType: z.enum(["CALL", "PUT"]),
  strikePrice: z.coerce.number().positive(),
  expirationDate: z.string(),
  openedAt: z.string(),
  premiumPerShare: z.coerce.number().positive(),
  contracts: z.coerce.number().int().positive(),
  shareCostBasis: z.coerce.number().positive().nullable().optional(),
  stockPriceAtOpen: z.coerce.number().positive().nullable().optional(),
  feesOpen: z.coerce.number().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional(),
});

optionsRoutes.post("/positions/import", async (req, res) => {
  const userId = getUserId(req);
  const rows: unknown[] = Array.isArray(req.body.positions) ? req.body.positions : [];

  let imported = 0;
  const errors: Array<{ row: number; message: string }> = [];

  // Cache tickers looked up/created during this import
  const tickerCache = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const parsed = importRowSchema.safeParse(rows[i]);
    if (!parsed.success) {
      errors.push({ row: i + 1, message: parsed.error.errors[0]?.message ?? "Invalid row" });
      continue;
    }

    const d = parsed.data;

    try {
      // Find or create ticker
      let tickerId = tickerCache.get(d.tickerSymbol);
      if (!tickerId) {
        let ticker = await prisma.optionsTicker.findFirst({
          where: { userId, symbol: d.tickerSymbol },
        });
        if (!ticker) {
          ticker = await prisma.optionsTicker.create({
            data: { userId, symbol: d.tickerSymbol },
          });
        } else if (!ticker.isActive) {
          ticker = await prisma.optionsTicker.update({
            where: { id: ticker.id },
            data: { isActive: true },
          });
        }
        tickerId = ticker.id;
        tickerCache.set(d.tickerSymbol, tickerId);
      }

      const position = await prisma.optionsPosition.create({
        data: {
          userId,
          tickerId,
          optionType: d.optionType,
          side: "SELL",
          strikePrice: d.strikePrice,
          expirationDate: new Date(d.expirationDate + "T20:00:00.000Z"),
          openedAt: new Date(d.openedAt),
          contracts: d.contracts,
          premiumPerShare: d.premiumPerShare,
          shareCostBasis: d.shareCostBasis ?? null,
          stockPriceAtOpen: d.stockPriceAtOpen ?? null,
          feesOpen: d.feesOpen ?? null,
          notes: d.notes ?? null,
        },
      });

      // Auto-set opportunity cost start date if not yet set
      await prisma.optionsTicker.updateMany({
        where: { id: tickerId, opportunityCostStartDate: null },
        data: { opportunityCostStartDate: new Date(d.openedAt) },
      });

      imported++;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      errors.push({ row: i + 1, message });
    }
  }

  res.json({ imported, errors });
});
