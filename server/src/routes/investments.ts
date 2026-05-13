import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getMetadata as getTiingoMeta, getDividendScanResult } from "../services/tiingo.js";
import { searchCoins, getPrices, getPrice as getCoinGeckoPrice, getMarketChart } from "../services/coingecko.js";
import { deactivateIfOrphaned } from "./instruments.js";
import { getUserId } from "../middleware/auth.js";

export const investmentRoutes = Router();

// ── Helper: fetch display name + type from Yahoo Finance ────────────────────

const QUOTE_TYPE_MAP: Record<string, string> = {
  EQUITY: "Equity",
  ETF: "ETF",
  MUTUALFUND: "Mutual Fund",
};

async function fetchYahooMeta(ticker: string): Promise<{ name: string; type: string | null }> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=5&newsCount=0&listsCount=0`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`[fetchYahooMeta] ${ticker}: HTTP ${res.status}`);
      return { name: ticker, type: null };
    }
    const data = await res.json() as any;
    const quotes: any[] = data?.quotes ?? [];
    // Prefer exact symbol match, fall back to first result
    const match =
      quotes.find((q) => q.symbol?.toUpperCase() === ticker.toUpperCase()) ??
      quotes[0];
    const name = (match?.longname || match?.shortname || ticker) as string;
    const type = match?.quoteType ? (QUOTE_TYPE_MAP[match.quoteType] ?? match.quoteType) : null;
    if (name === ticker) {
      console.warn(`[fetchYahooMeta] ${ticker}: no name found in results`, quotes.map((q) => q.symbol));
    }
    return { name, type };
  } catch (err) {
    console.warn(`[fetchYahooMeta] ${ticker}: exception`, err);
    return { name: ticker, type: null };
  }
}

// ── Helper: fetch price from Yahoo Finance ──────────────────────────────────

async function fetchYahooPrice(ticker: string): Promise<{ price: number; priceDate: Date } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const meta = result?.meta;
    const price: number | null = meta?.regularMarketPrice ?? null;
    const priceTs: number | null = meta?.regularMarketTime ?? null;
    if (price == null || priceTs == null) return null;
    const priceDate = new Date(priceTs * 1000);
    return { price, priceDate };
  } catch {
    return null;
  }
}

// ── Helper: fetch adjusted-close price history from Yahoo Finance ───────────
// Returns daily (date, closePrice) pairs for the given ticker and date range.
// Uses adjclose so that stock splits and dividends don't create artificial jumps.

async function fetchYahooHistory(
  ticker: string,
  fromDate: Date,
  toDate: Date = new Date()
): Promise<Array<{ date: Date; closePrice: number }>> {
  try {
    const period1 = Math.floor(fromDate.getTime() / 1000);
    const period2 = Math.floor(toDate.getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`[fetchYahooHistory] ${ticker}: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp ?? [];
    const adjCloses: (number | null)[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];

    const points: Array<{ date: Date; closePrice: number }> = [];
    for (let i = 0; i < timestamps.length; i++) {
      const price = adjCloses[i];
      if (price == null || price <= 0) continue;
      // Normalize to UTC midnight for consistent DATE storage
      const raw = new Date(timestamps[i] * 1000);
      const date = new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
      points.push({ date, closePrice: price });
    }
    return points;
  } catch (err) {
    console.warn(`[fetchYahooHistory] ${ticker}: exception`, err);
    return [];
  }
}

// ── Helper: fetch closing price for a specific date from Yahoo Finance ───────
// Looks back up to 7 calendar days to handle weekends and market holidays.
// Prefers adjClose (split/dividend-adjusted); falls back to unadjusted close.

async function fetchYahooClosingPrice(ticker: string, date: string): Promise<number | null> {
  try {
    // Use end-of-day UTC on the target date so the trading session is fully included,
    // and look back 7 days to handle weekends / holiday closures.
    const targetEnd = new Date(date + "T23:59:59Z");
    const rangeStart = new Date(targetEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    const period1 = Math.floor(rangeStart.getTime() / 1000);
    const period2 = Math.floor(targetEnd.getTime() / 1000);

    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
      `?interval=1d&period1=${period1}&period2=${period2}`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!res.ok) return null;

    const data = await res.json() as any;
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    // Prefer adjclose (accounts for splits); fall back to regular close
    const adjCloses: (number | null)[] = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];

    for (let i = adjCloses.length - 1; i >= 0; i--) {
      if (adjCloses[i] != null) return adjCloses[i]!;
    }
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) return closes[i]!;
    }

    return null;
  } catch {
    return null;
  }
}

// ── Helpers: trading-day calculations (Eastern time) ────────────────────────

// Returns the most recent Monday–Friday in Eastern time, with no regard for
// whether prices are available yet. Used for gap-fill staleness checks.
function lastWeekday(): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value);
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
  const dow = d.getUTCDay();
  const skip = dow === 0 ? 2 : dow === 6 ? 1 : 0;
  return new Date(d.getTime() - skip * 86400000);
}

// Returns the most recent trading day whose prices are considered finalized.
// Mutual fund NAVs and EOD prices settle by 8 PM ET, so before that cutoff
// we use the previous trading day's close, not today's.
//
// Examples (Eastern time):
//   Mon 3/23  6:30 PM → prices not yet settled → last finalized day = Fri 3/20
//   Mon 3/23  9:00 PM → prices settled         → last finalized day = Mon 3/23
//   Tue 3/24  3:30 AM → prices not yet settled → last finalized day = Mon 3/23
function effectiveLastTradingDay(): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)!.value);
  // Before 8 PM ET the current day's prices haven't settled — step back one day
  const etHour = get("hour");
  const d = new Date(Date.UTC(get("year"), get("month") - 1, etHour < 20 ? get("day") - 1 : get("day")));
  const dow = d.getUTCDay();
  const skip = dow === 0 ? 2 : dow === 6 ? 1 : 0;
  return new Date(d.getTime() - skip * 86400000);
}

// ── Helper: lazy gap-fill for TickerPriceHistory ────────────────────────────
// Fills any missing closing-price history up to (but NOT including) today's ET
// date. Today's data point is always owned by refreshPrices, which writes to
// both TickerPrice and TickerPriceHistory once closing prices have settled
// (after 8 PM ET). This ensures we never accidentally store a mid-day quote
// as a historical closing price.

async function fillPriceGaps(
  tickers: string[],
  coinGeckoIdByTicker: Map<string, string> = new Map(),
): Promise<number> {
  if (tickers.length === 0) return 0;

  // Only fill up to the last finalized trading day (8 PM ET cutoff). Before
  // that cutoff effectiveLastTradingDay() returns the previous trading day,
  // so we naturally never write a row for a day whose prices haven't settled.
  const targetDay = effectiveLastTradingDay();

  // Cap the Yahoo history fetch to the day after targetDay so we never receive
  // a partial/mid-day candle for an in-progress session.
  const fetchToDate = new Date(targetDay.getTime() + 24 * 60 * 60 * 1000);

  // Check the latest history date per ticker individually — a single cross-ticker
  // max would cause tickers with stale history to be silently skipped if any other
  // ticker is already current (e.g. a mutual fund whose NAV lags by a day).
  const latestRows = await prisma.tickerPriceHistory.findMany({
    where: { ticker: { in: tickers } },
    orderBy: { date: "desc" },
    distinct: ["ticker"],
    select: { ticker: true, date: true },
  });
  const latestByTicker = new Map(latestRows.map((r) => [r.ticker, r.date]));

  let totalInserted = 0;
  for (const ticker of tickers) {
    const latest = latestByTicker.get(ticker);
    if (latest && latest >= targetDay) continue; // already current through the finalized day

    const coinGeckoId = coinGeckoIdByTicker.get(ticker);
    let points: Array<{ date: Date; closePrice: number }> = [];

    if (coinGeckoId) {
      // Crypto: use CoinGecko market chart. Request enough days to cover the gap.
      const gapMs = targetDay.getTime() - (latest?.getTime() ?? (Date.now() - 90 * 24 * 60 * 60 * 1000));
      const days = Math.ceil(gapMs / (24 * 60 * 60 * 1000)) + 2;
      const allPoints = await getMarketChart(coinGeckoId, Math.min(days, 365));
      // Filter to only the dates we actually need
      const fromMs = latest ? latest.getTime() + 24 * 60 * 60 * 1000 : 0;
      points = allPoints.filter((p) => p.date.getTime() >= fromMs && p.date <= targetDay);
      await new Promise((r) => setTimeout(r, 200)); // be polite to CoinGecko
    } else {
      // Stocks/ETFs/funds: use Yahoo Finance
      const fromDate = latest
        ? new Date(latest.getTime() + 24 * 60 * 60 * 1000)
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      points = await fetchYahooHistory(ticker, fromDate, fetchToDate);
      await new Promise((r) => setTimeout(r, 150));
    }

    if (points.length === 0) continue;
    const result = await prisma.tickerPriceHistory.createMany({
      data: points.map((p) => ({ ticker, date: p.date, closePrice: p.closePrice })),
      skipDuplicates: true,
    });
    totalInserted += result.count;
  }
  return totalInserted;
}

// ── Helper: compute calculated fields for a holding ────────────────────────
// Lots with a null acquiredDate are treated as managed (robo-advisor) lots:
// quantity and cost are still accumulated, but they are excluded from the
// short/long-term unrealized gain split (since holding period is unknown).

function computeHoldingFields(
  lots: { quantity: any; costPerShare: any; acquiredDate: Date | null }[],
  currentPrice: number | null
) {
  const now = new Date();
  const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  let totalQuantity = 0;
  let totalCost = 0;
  let shortTermGain = 0;
  let longTermGain = 0;

  for (const lot of lots) {
    const qty = parseFloat(lot.quantity.toString());
    const cps = parseFloat(lot.costPerShare.toString());
    totalQuantity += qty;
    totalCost += qty * cps;

    if (currentPrice != null && lot.acquiredDate != null) {
      const gain = (currentPrice - cps) * qty;
      if (lot.acquiredDate > oneYearAgo) {
        shortTermGain += gain;
      } else {
        longTermGain += gain;
      }
    }
  }

  const marketValue = currentPrice != null ? totalQuantity * currentPrice : null;
  const totalGain = marketValue != null ? marketValue - totalCost : null;
  const totalGainPct = totalCost > 0 && totalGain != null ? (totalGain / totalCost) * 100 : null;

  // A holding is "managed" when all of its lots have no acquired date
  const isManaged = lots.length > 0 && lots.every((l) => l.acquiredDate == null);

  return { totalQuantity, totalCost, marketValue, totalGain, totalGainPct, shortTermGain, longTermGain, isManaged };
}

// ── GET /api/investments/allocation ─────────────────────────────────────────
// Computes actual vs. target asset allocation across all investment accounts.
//
// Display-level logic: for each top-level asset class, if any children have
// directly-set targets we show those children individually; otherwise we show
// the parent as a single unit. Children with NO target (when siblings have
// targets) and classes with no target at any level are treated as unclassified.
//
// Holdings are weighted through InstrumentAssetClassWeight. A portion of a
// holding's value that maps to a class with no display unit is added to the
// unclassified bucket.

investmentRoutes.get("/allocation", async (req, res) => {
  try {
    const userId = getUserId(req);
    // 1. Asset class hierarchy with targets ──────────────────────────────────
    const topLevelClasses = await prisma.assetClass.findMany({
      where: { parentId: null, OR: [{ userId: null }, { userId }] },
      include: {
        targets: { where: { userId } },
        children: {
          where: { OR: [{ userId: null }, { userId }] },
          include: { targets: { where: { userId } } },
          orderBy: { displayOrder: "asc" },
        },
      },
      orderBy: { displayOrder: "asc" },
    });

    // 2. Build display-unit map ───────────────────────────────────────────────
    // displayUnitOrder preserves the render sequence.
    // classToDisplayUnit maps every known assetClassId → its display-unit id
    // (or "UNCLASSIFIED" when it has no target home).
    // duToTopLevelId maps each display-unit back to its top-level ancestor,
    // used to aggregate values for the overview stacked bars.
    type DisplayUnit = { id: string; name: string; color: string | null; targetPct: number | null };
    const displayUnitOrder: string[] = [];
    const displayUnitInfo = new Map<string, DisplayUnit>();
    const classToDisplayUnit = new Map<string, string>(); // assetClassId → duId | "UNCLASSIFIED"
    const duToTopLevelId = new Map<string, string>();     // duId → top-level assetClassId

    for (const top of topLevelClasses) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const children = (top as any).children ?? [];
      const topTarget = (top as any).targets?.[0] ?? null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const childrenWithTarget = children.filter((c: any) => c.targets?.[0] != null);

      if (childrenWithTarget.length > 0) {
        // Show each child that has a target as its own display unit.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const child of childrenWithTarget as any[]) {
          const duId = child.id;
          displayUnitOrder.push(duId);
          displayUnitInfo.set(duId, {
            id: duId,
            name: child.name,
            color: child.color ?? top.color,
            targetPct: parseFloat(child.targets[0].targetPct.toString()),
          });
          classToDisplayUnit.set(child.id, duId);
          duToTopLevelId.set(duId, top.id);
        }
        // Children without a target, and the parent itself, are unclassified.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const child of children.filter((c: any) => c.targets?.[0] == null)) {
          classToDisplayUnit.set(child.id, "UNCLASSIFIED");
        }
        classToDisplayUnit.set(top.id, "UNCLASSIFIED");
      } else if (topTarget) {
        // No children with targets → show the parent as the display unit.
        const duId = top.id;
        displayUnitOrder.push(duId);
        displayUnitInfo.set(duId, {
          id: duId,
          name: top.name,
          color: top.color,
          targetPct: parseFloat(topTarget.targetPct.toString()),
        });
        classToDisplayUnit.set(top.id, duId);
        for (const child of children) {
          classToDisplayUnit.set(child.id, duId);
        }
        duToTopLevelId.set(duId, top.id);
      } else {
        // No target anywhere in this branch — everything here is unclassified.
        classToDisplayUnit.set(top.id, "UNCLASSIFIED");
        for (const child of children) {
          classToDisplayUnit.set(child.id, "UNCLASSIFIED");
        }
      }
    }

    // 3. Fetch all investment holdings ───────────────────────────────────────
    const filter = req.query.filter as string | undefined;
    const taxFilter =
      filter === "taxable" ? false :
      filter === "tax-advantaged" ? true :
      undefined; // "all" or omitted → no filter

    const investmentAccounts = await prisma.account.findMany({
      where: {
        type: "INVESTMENT",
        isActive: true,
        userId,
        ...(taxFilter !== undefined && { isTaxAdvantaged: taxFilter }),
      },
      select: { id: true, cashBalance: true },
    });
    const accountIds = investmentAccounts.map((a) => a.id);

    const holdings = await prisma.investmentHolding.findMany({
      where: { accountId: { in: accountIds } },
      include: {
        lots: { select: { quantity: true } },
        instrument: {
          include: {
            weights: { select: { assetClassId: true, weight: true } },
          },
        },
      },
    });

    const manualInvestments = await prisma.manualInvestment.findMany({
      where: { accountId: { in: accountIds } },
      include: {
        instrument: {
          include: {
            weights: { select: { assetClassId: true, weight: true } },
          },
        },
      },
    });

    // Fetch prices for all tickers in one query (same pattern as /accounts route).
    const allTickers = [...new Set(holdings.map((h) => h.ticker))];
    const cachedPrices = await prisma.tickerPrice.findMany({
      where: { ticker: { in: allTickers } },
      select: { ticker: true, price: true },
    });
    const priceMap = new Map(cachedPrices.map((p) => [p.ticker, parseFloat(p.price.toString())]));

    // 4. Accumulate values per display unit ──────────────────────────────────
    const duValues = new Map<string, number>(); // duId → $
    let unclassifiedValue = 0;
    let totalValue = 0;

    const creditWeight = (marketValue: number, weights: { assetClassId: string; weight: any }[]) => {
      if (weights.length === 0) {
        unclassifiedValue += marketValue;
        return;
      }
      let credited = 0;
      for (const w of weights) {
        const pct = parseFloat(w.weight.toString()) / 100;
        const portion = marketValue * pct;
        const duId = classToDisplayUnit.get(w.assetClassId);
        if (duId && duId !== "UNCLASSIFIED" && displayUnitInfo.has(duId)) {
          duValues.set(duId, (duValues.get(duId) ?? 0) + portion);
          credited += portion;
        }
        // Portions mapping to no display unit fall through to unclassified below.
      }
      unclassifiedValue += marketValue - credited;
    };

    for (const holding of holdings) {
      const price = priceMap.get(holding.ticker) ?? null;
      if (price == null) continue;

      const qty = holding.lots.reduce(
        (s, l) => s + parseFloat(l.quantity.toString()),
        0
      );
      const mv = qty * price;
      if (mv <= 0) continue;

      totalValue += mv;
      creditWeight(mv, holding.instrument?.weights ?? []);
    }

    for (const mi of manualInvestments) {
      const mv = parseFloat(mi.marketValue.toString());
      if (mv <= 0) continue;

      totalValue += mv;
      creditWeight(mv, mi.instrument?.weights ?? []);
    }

    // Credit settlement cash balances — look for a display unit named "Cash" (case-insensitive);
    // if found, the cash counts toward it; otherwise it falls into unclassified.
    const cashDuId = [...displayUnitInfo.entries()]
      .find(([, du]) => du.name.toLowerCase() === "cash")?.[0];
    for (const acct of investmentAccounts) {
      if (acct.cashBalance == null) continue;
      const cb = parseFloat(acct.cashBalance.toString());
      if (cb <= 0) continue;
      totalValue += cb;
      if (cashDuId) {
        duValues.set(cashDuId, (duValues.get(cashDuId) ?? 0) + cb);
      } else {
        unclassifiedValue += cb;
      }
    }

    // Credit banking (checking/savings) balances — consistent with how the
    // Asset Composition section on the client counts them as cash.
    const bankingAccounts = await prisma.account.findMany({
      where: { type: { in: ["CHECKING", "SAVINGS"] }, isActive: true, userId },
      select: { balance: true },
    });
    for (const acct of bankingAccounts) {
      const bal = parseFloat(acct.balance.toString());
      if (bal <= 0) continue;
      totalValue += bal;
      if (cashDuId) {
        duValues.set(cashDuId, (duValues.get(cashDuId) ?? 0) + bal);
      } else {
        unclassifiedValue += bal;
      }
    }

    // 5. Build ordered response ───────────────────────────────────────────────
    // actualPct is computed relative to classifiedValue so that unclassified
    // holdings are excluded from the denominator, making target vs. actual
    // percentages directly comparable on the same 100% base.
    const classifiedValue = totalValue - unclassifiedValue;

    const items = displayUnitOrder.map((duId) => {
      const du = displayUnitInfo.get(duId)!;
      const actualValue = duValues.get(duId) ?? 0;
      return {
        id: du.id,
        name: du.name,
        color: du.color,
        targetPct: du.targetPct,
        actualPct: classifiedValue > 0 ? (actualValue / classifiedValue) * 100 : 0,
        actualValue,
      };
    });

    // Top-level rollup for the overview stacked bars.
    // Each top-level class aggregates the actual values of all its display units,
    // and derives its effective target from child targets (when set) or its own.
    const topLevelActualValues = new Map<string, number>();
    for (const [duId, value] of duValues) {
      const topId = duToTopLevelId.get(duId);
      if (topId) topLevelActualValues.set(topId, (topLevelActualValues.get(topId) ?? 0) + value);
    }

    const topLevelIdsWithDus = new Set(duToTopLevelId.values());
    const topLevelItems = topLevelClasses
      .filter((top) => topLevelIdsWithDus.has(top.id))
      .map((top) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const children = (top as any).children ?? [];
        const topTarget = (top as any).targets?.[0] ?? null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const childrenWithTarget = children.filter((c: any) => c.targets?.[0] != null);
        const effectiveTargetPct = childrenWithTarget.length > 0
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? childrenWithTarget.reduce((sum: number, c: any) => sum + parseFloat(c.targets[0].targetPct.toString()), 0)
          : topTarget ? parseFloat(topTarget.targetPct.toString()) : null;
        const actualValue = topLevelActualValues.get(top.id) ?? 0;
        return {
          id: top.id,
          name: top.name,
          color: top.color,
          targetPct: effectiveTargetPct,
          actualPct: classifiedValue > 0 ? (actualValue / classifiedValue) * 100 : 0,
          actualValue,
        };
      })
      .filter((top) => top.targetPct != null || top.actualValue > 0);

    res.json({
      items,
      topLevelItems,
      unclassifiedValue,
      unclassifiedPct: totalValue > 0 ? (unclassifiedValue / totalValue) * 100 : 0,
      totalValue,
      classifiedValue,
      hasAnyTargets: displayUnitInfo.size > 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to compute allocation" } });
  }
});

// ── GET /api/investments/accounts ──────────────────────────────────────────
// Returns INVESTMENT, CHECKING, SAVINGS accounts with portfolio summaries

investmentRoutes.get("/accounts", async (req, res) => {
  try {
    const userId = getUserId(req);
    // Find all asset class ids whose name is "Cash" (case-insensitive) so we can
    // identify cash-classified holdings via their instrument weights.
    const cashAssetClasses = await prisma.assetClass.findMany({
      where: { name: { equals: "Cash", mode: "insensitive" } },
      select: { id: true },
    });
    const cashAssetClassIds = new Set(cashAssetClasses.map((c) => c.id));

    const accounts = await prisma.account.findMany({
      where: {
        isActive: true,
        isHidden: false,
        type: { in: ["INVESTMENT", "CHECKING", "SAVINGS"] },
        userId,
      },
      include: {
        holdings: {
          include: {
            lots: true,
            instrument: {
              include: {
                weights: { select: { assetClassId: true, weight: true } },
              },
            },
          },
        },
        manualInvestments: {
          include: {
            instrument: {
              include: {
                weights: { select: { assetClassId: true, weight: true } },
              },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    // Gather unique tickers to fetch prices
    const allTickers = [...new Set(
      accounts.flatMap((a) => a.holdings.map((h) => h.ticker))
    )];

    // Load cached prices
    const cachedPrices = await prisma.tickerPrice.findMany({
      where: { ticker: { in: allTickers } },
    });
    const priceMap = new Map(cachedPrices.map((p) => [p.ticker, p]));

    // Load the two most recent closing prices per ticker from TickerPriceHistory
    // to compute 1-day change. Using a 7-day window is enough to cover any weekend
    // or holiday gap while keeping the query small.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentHistory = await prisma.tickerPriceHistory.findMany({
      where: { ticker: { in: allTickers }, date: { gte: sevenDaysAgo } },
      orderBy: { date: "desc" },
      select: { ticker: true, date: true, closePrice: true },
    });
    // Keep only the two most recent entries per ticker (already desc-sorted)
    const historyByTicker = new Map<string, { closePrice: number }[]>();
    for (const row of recentHistory) {
      const entries = historyByTicker.get(row.ticker) ?? [];
      if (entries.length < 2) {
        entries.push({ closePrice: parseFloat(row.closePrice.toString()) });
        historyByTicker.set(row.ticker, entries);
      }
    }
    // prevCloseMap: ticker → previous trading day's close price
    const prevCloseMap = new Map<string, number>();
    for (const [ticker, entries] of historyByTicker) {
      if (entries.length >= 2) prevCloseMap.set(ticker, entries[1].closePrice);
    }

    // Helper: given a market value and an instrument's weights, compute how much
    // of that value is classified as Cash vs. unclassified (no weights at all).
    const classifyCashAndUntracked = (
      mv: number,
      weights: { assetClassId: string; weight: any }[],
    ): { cashValue: number; untrackedValue: number } => {
      if (weights.length === 0) return { cashValue: 0, untrackedValue: mv };
      const cashValue = weights.reduce((sum, w) => {
        if (!cashAssetClassIds.has(w.assetClassId)) return sum;
        return sum + mv * (parseFloat(w.weight.toString()) / 100);
      }, 0);
      return { cashValue, untrackedValue: 0 };
    };

    const result = accounts.map((account) => {
      let totalMarketValue = 0;
      let totalCost = 0;
      let totalGain = 0;
      let classifiedCashValue = 0;
      let untrackedValue = 0;
      // 1-day change accumulators: null until at least one holding has prev-close data
      let totalDayGain: number | null = null;
      let prevDayValue = 0; // sum of prevClose * quantity for holdings with history

      const holdingsSummary = account.holdings.map((holding) => {
        const priceRecord = priceMap.get(holding.ticker);
        const currentPrice = priceRecord ? parseFloat(priceRecord.price.toString()) : null;
        const fields = computeHoldingFields(holding.lots, currentPrice);

        if (fields.marketValue != null) {
          totalMarketValue += fields.marketValue;
          const { cashValue, untrackedValue: uv } = classifyCashAndUntracked(
            fields.marketValue,
            holding.instrument?.weights ?? [],
          );
          classifiedCashValue += cashValue;
          untrackedValue += uv;
        }
        totalCost += fields.totalCost;
        if (fields.totalGain != null) totalGain += fields.totalGain;

        // Accumulate 1-day gain using the previous trading day's close price
        const prevClose = prevCloseMap.get(holding.ticker);
        if (prevClose != null && currentPrice != null && fields.totalQuantity > 0) {
          const dayGain = (currentPrice - prevClose) * fields.totalQuantity;
          totalDayGain = (totalDayGain ?? 0) + dayGain;
          prevDayValue += prevClose * fields.totalQuantity;
        }

        return {
          id: holding.id,
          ticker: holding.ticker,
          name: holding.name,
          group: holding.assetClass ?? null,
          currentPrice,
          priceDate: priceRecord?.priceDate ?? null,
          priceUpdatedAt: priceRecord?.updatedAt ?? null,
          lotCount: holding.lots.length,
          ...fields,
        };
      });

      // Add manual investment totals
      for (const m of account.manualInvestments) {
        const mv = parseFloat(m.marketValue.toString());
        const tc = m.totalCost != null ? parseFloat(m.totalCost.toString()) : 0;
        totalMarketValue += mv;
        totalCost += tc;
        totalGain += mv - tc;
        const { cashValue, untrackedValue: uv } = classifyCashAndUntracked(
          mv,
          m.instrument?.weights ?? [],
        );
        classifiedCashValue += cashValue;
        untrackedValue += uv;
      }

      // For banking accounts, use the stored balance as market value
      if (account.type === "CHECKING" || account.type === "SAVINGS") {
        totalMarketValue = parseFloat(account.balance.toString());
      }

      // Add settlement cash to investment account totals (no cost basis — cash has no gain)
      const cashBalance = account.type === "INVESTMENT" && account.cashBalance != null
        ? parseFloat(account.cashBalance.toString())
        : null;
      if (cashBalance != null) {
        totalMarketValue += cashBalance;
      }

      return {
        id: account.id,
        name: account.name,
        type: account.type,
        balance: account.balance,
        balanceUpdatedAt: account.balanceUpdatedAt,
        color: account.color,
        isJoint: account.isJoint,
        holdings: holdingsSummary,
        manualCount: account.manualInvestments.length,
        totalMarketValue,
        totalCost,
        totalGain,
        totalGainPct: totalCost > 0 ? (totalGain / totalCost) * 100 : 0,
        totalDayGain,
        totalDayGainPct: totalDayGain != null && prevDayValue > 0
          ? (totalDayGain / prevDayValue) * 100
          : null,
        cashBalance,
        cashBalanceUpdatedAt: account.cashBalanceUpdatedAt,
        isTaxAdvantaged: account.isTaxAdvantaged,
        taxAdvantageType: account.taxAdvantageType,
        isManaged: account.isManaged,
        // Composition helpers (investment accounts only; 0 for banking accounts)
        classifiedCashValue,
        untrackedValue,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch investment accounts" } });
  }
});

// ── GET /api/investments/holdings/:accountId ───────────────────────────────

investmentRoutes.get("/holdings/:accountId", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    const account = await prisma.account.findFirst({
      where: { id: accountId, isActive: true, userId },
    });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    const holdings = await prisma.investmentHolding.findMany({
      where: { accountId },
      include: { lots: { orderBy: { acquiredDate: "asc" } } },
      orderBy: { ticker: "asc" },
    });

    const tickers = holdings.map((h) => h.ticker);
    const cachedPrices = await prisma.tickerPrice.findMany({
      where: { ticker: { in: tickers } },
    });
    const priceMap = new Map(cachedPrices.map((p) => [p.ticker, p]));

    const result = holdings.map((holding) => {
      const priceRecord = priceMap.get(holding.ticker);
      const currentPrice = priceRecord ? parseFloat(priceRecord.price.toString()) : null;
      const fields = computeHoldingFields(holding.lots, currentPrice);

      return {
        id: holding.id,
        accountId: holding.accountId,
        ticker: holding.ticker,
        name: holding.name,
        type: holding.type ?? null,
        group: holding.assetClass ?? null,
        currentPrice,
        priceDate: priceRecord?.priceDate ?? null,
        priceUpdatedAt: priceRecord?.updatedAt ?? null,
        lots: holding.lots.map((lot) => ({
          id: lot.id,
          holdingId: lot.holdingId,
          quantity: lot.quantity.toString(),
          costPerShare: lot.costPerShare.toString(),
          acquiredDate: lot.acquiredDate ? lot.acquiredDate.toISOString() : null,
        })),
        ...fields,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch holdings" } });
  }
});

// ── Instrument resolution helper ──────────────────────────────────────────
// Resolves the Instrument id for a ticker: checks alias tickers first, then
// upserts on primaryTicker, then reactivates in case it was soft-deleted.
// Shared by the manual add-holding route and the lot import route so both
// paths always produce a holding with a valid instrumentId.

async function resolveInstrumentId(ticker: string, name: string): Promise<string> {
  const alias = await prisma.instrumentTicker.findUnique({
    where: { ticker },
    select: { instrumentId: true },
  });
  const id = alias
    ? alias.instrumentId
    : (
        await prisma.instrument.upsert({
          where: { primaryTicker: ticker },
          update: {},
          create: { primaryTicker: ticker, name },
          select: { id: true },
        })
      ).id;
  await prisma.instrument.update({ where: { id }, data: { isActive: true } });
  return id;
}

// ── POST /api/investments/holdings ────────────────────────────────────────

const createHoldingSchema = z.object({
  accountId: z.string(),
  ticker: z.string().min(1).max(20).transform((s) => s.toUpperCase().trim()),
  name: z.string().min(1).max(200),
  type: z.string().max(50).nullable().optional(),
  group: z.string().max(100).nullable().optional(),
  coinGeckoId: z.string().max(100).nullable().optional(),
});

investmentRoutes.post("/holdings", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = createHoldingSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: body.accountId, isActive: true, type: "INVESTMENT", userId },
    });
    if (!account) return res.status(404).json({ error: { message: "Investment account not found" } });

    const instrumentId = await resolveInstrumentId(body.ticker, body.name);

    const holding = await prisma.investmentHolding.create({
      data: {
        accountId: body.accountId,
        ticker: body.ticker,
        name: body.name,
        type: body.type ?? null,
        assetClass: body.group ?? null,
        coinGeckoId: body.coinGeckoId ?? null,
        instrumentId,
      },
      include: { lots: true },
    });

    res.status(201).json({ ...holding, group: holding.assetClass ?? null });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    const e = err as any;
    if (e?.code === "P2002") return res.status(409).json({ error: { message: "This ticker already exists in this account" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to create holding" } });
  }
});

// ── PATCH /api/investments/holdings/:id ───────────────────────────────────
// Update mutable holding fields: group label (and optionally name).

const patchHoldingSchema = z.object({
  group: z.string().max(100).nullable().optional(),
  name: z.string().min(1).max(200).optional(),
});

investmentRoutes.patch("/holdings/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = patchHoldingSchema.parse(req.body);

    const existing = await prisma.investmentHolding.findFirst({
      where: { id: req.params.id, account: { userId } },
    });
    if (!existing) return res.status(404).json({ error: { message: "Holding not found" } });

    const holding = await prisma.investmentHolding.update({
      where: { id: req.params.id },
      data: { name: body.name, assetClass: body.group },
      include: { lots: true },
    });
    res.json({ ...holding, group: holding.assetClass ?? null });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    const e = err as any;
    if (e?.code === "P2025") return res.status(404).json({ error: { message: "Holding not found" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update holding" } });
  }
});

// ── DELETE /api/investments/holdings/:id ──────────────────────────────────
// ?force=true bypasses the HAS_SALES warning.

investmentRoutes.delete("/holdings/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const holdingId = req.params.id;
    const force = req.query.force === "true";

    const saleCount = await prisma.investmentActivity.count({
      where: { holdingId, type: "SALE" },
    });

    if (saleCount > 0 && !force) {
      return res.status(409).json({
        code: "HAS_SALES",
        message:
          "This holding has recorded sales. Deleting it will orphan sale history. " +
          "Consider keeping the holding or confirm deletion with ?force=true.",
      });
    }

    const holding = await prisma.investmentHolding.findFirst({
      where: { id: holdingId, account: { userId } },
      select: { instrumentId: true },
    });
    if (!holding) return res.status(404).json({ error: { message: "Holding not found" } });

    await prisma.$transaction(async (tx) => {
      // If no sales, delete the associated purchase activities (user correcting a mistake)
      if (saleCount === 0) {
        await tx.investmentActivity.deleteMany({
          where: { holdingId, type: "PURCHASE" },
        });
      }
      await tx.investmentHolding.delete({ where: { id: holdingId } });
      await deactivateIfOrphaned(tx, holding?.instrumentId);
    });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete holding" } });
  }
});

// ── POST /api/investments/lots ────────────────────────────────────────────

const createLotSchema = z.object({
  holdingId: z.string(),
  quantity: z.number().positive(),
  costPerShare: z.number().nonnegative(),
  // Null for managed holdings where the acquisition date is unavailable
  acquiredDate: z.string().nullable().optional().transform((s) => s != null ? new Date(s) : null),
});

investmentRoutes.post("/lots", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = createLotSchema.parse(req.body);

    const holding = await prisma.investmentHolding.findFirst({
      where: { id: body.holdingId, account: { userId } },
      select: { accountId: true, ticker: true },
    });
    if (!holding) return res.status(404).json({ error: { message: "Holding not found" } });

    const lot = await prisma.$transaction(async (tx) => {
      // For managed lots (no acquiredDate), replace any existing null-date lots
      // so the position is updated rather than accumulated.
      if (body.acquiredDate == null) {
        await tx.investmentLot.deleteMany({
          where: { holdingId: body.holdingId, acquiredDate: null },
        });
      }

      const newLot = await tx.investmentLot.create({
        data: { ...body, acquiredDate: body.acquiredDate ?? null },
      });
      if (body.acquiredDate) {
        await tx.investmentActivity.create({
          data: {
            accountId: holding.accountId,
            holdingId: body.holdingId,
            lotId: newLot.id,
            ticker: holding.ticker,
            type: "PURCHASE",
            date: body.acquiredDate,
            shares: body.quantity,
            pricePerShare: body.costPerShare,
            amount: Math.round(body.quantity * body.costPerShare * 100) / 100,
            updatedAt: new Date(),
          },
        });
      }
      return newLot;
    });

    res.status(201).json({
      ...lot,
      quantity: lot.quantity.toString(),
      costPerShare: lot.costPerShare.toString(),
      acquiredDate: lot.acquiredDate ? lot.acquiredDate.toISOString() : null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to create lot" } });
  }
});

// ── PUT /api/investments/lots/:id ─────────────────────────────────────────

const updateLotSchema = z.object({
  quantity: z.number().positive().optional(),
  costPerShare: z.number().nonnegative().optional(),
  acquiredDate: z.string().nullable().optional().transform((s) => s != null ? new Date(s) : null),
});

investmentRoutes.put("/lots/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const lotId = req.params.id;
    const body = updateLotSchema.parse(req.body);

    // Fetch the current lot and its holding so we can sync the activity
    const existingLot = await prisma.investmentLot.findFirst({
      where: { id: lotId, holding: { account: { userId } } },
      select: {
        holdingId: true,
        acquiredDate: true,
        quantity: true,
        costPerShare: true,
        holding: { select: { accountId: true, ticker: true } },
      },
    });
    if (!existingLot) return res.status(404).json({ error: { message: "Lot not found" } });

    // Find any linked PURCHASE activity (created when the lot was originally added)
    const existingActivity = await prisma.investmentActivity.findFirst({
      where: { lotId, type: "PURCHASE" },
      select: { id: true },
    });

    // Effective acquiredDate after the update
    const newAcquiredDate =
      body.acquiredDate !== undefined ? body.acquiredDate : existingLot.acquiredDate;

    const lot = await prisma.$transaction(async (tx) => {
      // 1. Update the lot itself
      const updated = await tx.investmentLot.update({
        where: { id: lotId },
        data: body,
      });

      // Resolved numeric values after the update
      const quantity = parseFloat(updated.quantity.toString());
      const costPerShare = parseFloat(updated.costPerShare.toString());
      const amount = Math.round(quantity * costPerShare * 100) / 100;

      // 2. Sync the linked PURCHASE activity
      if (existingActivity) {
        if (newAcquiredDate == null) {
          // Date was cleared — the activity no longer makes sense, remove it
          await tx.investmentActivity.delete({ where: { id: existingActivity.id } });
        } else {
          // Update to match the new lot values
          await tx.investmentActivity.update({
            where: { id: existingActivity.id },
            data: {
              date: newAcquiredDate,
              shares: quantity,
              pricePerShare: costPerShare,
              amount,
            },
          });
        }
      } else if (newAcquiredDate != null) {
        // Lot now has a date but never had an activity (e.g. date added after the fact)
        await tx.investmentActivity.create({
          data: {
            accountId: existingLot.holding.accountId,
            holdingId: existingLot.holdingId,
            lotId,
            ticker: existingLot.holding.ticker,
            type: "PURCHASE",
            date: newAcquiredDate,
            shares: quantity,
            pricePerShare: costPerShare,
            amount,
            updatedAt: new Date(),
          },
        });
      }
      // else: no activity and still no date — nothing to do

      return updated;
    });

    res.json({
      ...lot,
      quantity: lot.quantity.toString(),
      costPerShare: lot.costPerShare.toString(),
      acquiredDate: lot.acquiredDate ? lot.acquiredDate.toISOString() : null,
    });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update lot" } });
  }
});

// ── DELETE /api/investments/lots/:id ─────────────────────────────────────
// ?force=true bypasses the HAS_SALES warning.

investmentRoutes.delete("/lots/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const lotId = req.params.id;
    const force = req.query.force === "true";

    // Find the lot + its holding (to scope sale check to this holding)
    const lot = await prisma.investmentLot.findFirst({
      where: { id: lotId, holding: { account: { userId } } },
      select: { holdingId: true },
    });
    if (!lot) return res.status(404).json({ error: { message: "Lot not found" } });

    if (!force) {
      const saleCount = await prisma.investmentActivity.count({
        where: { holdingId: lot.holdingId, type: "SALE" },
      });
      if (saleCount > 0) {
        return res.status(409).json({
          code: "HAS_SALES",
          message:
            "This holding has recorded sales. Deleting a lot when sales exist may produce incorrect history. " +
            "Use the sell function to reduce a position, or confirm deletion with ?force=true.",
        });
      }
    }

    // Delete the linked PURCHASE activity first (user-initiated deletion cleans up history)
    await prisma.investmentActivity.deleteMany({ where: { lotId } });
    await prisma.investmentLot.delete({ where: { id: lotId } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete lot" } });
  }
});

// ── GET /api/investments/search?q= ────────────────────────────────────────
// Proxy Yahoo Finance ticker search

investmentRoutes.get("/search", async (req, res) => {
  try {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 1) return res.json([]);

    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`;
    const yahooRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
    });

    if (!yahooRes.ok) return res.json([]);

    const data = await yahooRes.json() as any;
    const quotes = data?.quotes ?? [];

    const ALLOWED_TYPES = new Set(["EQUITY", "ETF", "MUTUALFUND"]);

    const results = quotes
      .filter((q: any) => ALLOWED_TYPES.has(q.quoteType))
      .map((q: any) => ({
        ticker: q.symbol as string,
        name: (q.longname || q.shortname || q.symbol) as string,
        type: q.quoteType === "MUTUALFUND" ? "Mutual Fund" : q.quoteType === "ETF" ? "ETF" : "Equity",
        exchange: (q.exchDisp || q.exchange || "") as string,
      }));

    res.json(results);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// ── GET /api/investments/search/resolve?q= ────────────────────────────────
// Resolve a single exact ticker via Tiingo. Called only when the user
// explicitly submits a ticker that returned zero Yahoo search results.
// Returns { ticker, name, type, exchange } on success, 404 if unknown.

investmentRoutes.get("/search/resolve", async (req, res) => {
  try {
    const ticker = ((req.query.q as string) ?? "").trim().toUpperCase();
    if (!ticker) return res.status(400).json({ error: "Missing q parameter" });

    const meta = await getTiingoMeta(ticker);
    if (!meta) return res.status(404).json({ error: "Ticker not found" });

    // Tiingo's exchangeCode "NMFQS" identifies NASDAQ Money Market Fund
    // Quotation System instruments — i.e. money market funds.
    const isMmf = meta.exchangeCode === "NMFQS";
    const type = isMmf ? "Money Market" : "Mutual Fund";

    res.json({ ticker, name: meta.name, type, exchange: meta.exchangeCode });
  } catch (err) {
    console.error("[search/resolve]", err);
    res.status(500).json({ error: "Failed to resolve ticker" });
  }
});

// ── GET /api/investments/search/crypto?q= ─────────────────────────────────
// Proxy CoinGecko coin search. Returns results shaped identically to the
// Yahoo Finance search endpoint so the client can use the same TickerSearchResult type.

investmentRoutes.get("/search/crypto", async (req, res) => {
  try {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 1) return res.json([]);

    const coins = await searchCoins(q);

    const results = coins.map((c) => ({
      ticker: c.symbol,
      name: c.name,
      type: "Crypto",
      exchange: "CoinGecko",
      coinGeckoId: c.id,
    }));

    res.json(results);
  } catch (err) {
    console.error("[search/crypto]", err);
    res.json([]);
  }
});

// ── POST /api/investments/holdings/backfill-meta ──────────────────────────
// One-time: populate name/type for holdings where type is null.
// Deduplicates API calls across all accounts sharing the same ticker.

investmentRoutes.post("/holdings/backfill-meta", async (_req, res) => {
  try {
    const holdings = await prisma.investmentHolding.findMany({
      where: { type: null },
      select: { id: true, ticker: true, name: true },
    });

    if (holdings.length === 0) return res.json({ updated: 0, details: [] });

    // Deduplicate: one API call per unique ticker
    const uniqueTickers = [...new Set(holdings.map((h) => h.ticker))];
    const metaByTicker = new Map<string, { name: string; type: string | null }>();
    for (const ticker of uniqueTickers) {
      metaByTicker.set(ticker, await fetchYahooMeta(ticker));
    }

    let updated = 0;
    const details: Array<{ ticker: string; name: string; type: string | null }> = [];

    for (const holding of holdings) {
      const meta = metaByTicker.get(holding.ticker)!;
      const updates: Record<string, string | null> = {};
      if (holding.name === holding.ticker && meta.name !== holding.ticker) updates.name = meta.name;
      if (meta.type !== null) updates.type = meta.type;
      if (Object.keys(updates).length > 0) {
        await prisma.investmentHolding.update({ where: { id: holding.id }, data: updates });
        updated++;
        details.push({ ticker: holding.ticker, name: meta.name, type: meta.type });
      }
    }

    res.json({ updated, details });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to backfill holding metadata" } });
  }
});

// ── Price refresh helpers ─────────────────────────────────────────────────

// Server-side mirror of the client's cutoffToday8pmET — needed for staleness checks.
function cutoffToday8pmET(now: Date): Date {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => dateParts.find((p) => p.type === type)!.value;
  const tzPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(now).find((p) => p.type === "timeZoneName")!.value;
  const offsetMatch = tzPart.match(/GMT([+-])(\d+)/)!;
  const offsetStr = `${offsetMatch[1]}${offsetMatch[2].padStart(2, "0")}:00`;
  return new Date(`${get("year")}-${get("month")}-${get("day")}T20:00:00${offsetStr}`);
}

function currentHourET(now: Date): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false })
      .formatToParts(now)
      .find((p) => p.type === "hour")!.value,
    10,
  );
}

function isTickerStale(updatedAt: Date | null, isCrypto: boolean, now: Date): boolean {
  if (!updatedAt) return true;
  if (isCrypto) return now.getTime() - updatedAt.getTime() > 5 * 60 * 1000;
  // After 5 PM ET, markets are closed and stock/option prices won't change.
  if (currentHourET(now) >= 17) return false;
  const cutoff = cutoffToday8pmET(now);
  const prevCutoff = new Date(cutoff.getTime() - 24 * 60 * 60 * 1000);
  if (updatedAt < prevCutoff) return true;
  if (now >= cutoff && updatedAt < cutoff) return true;
  return false;
}

// Upserts a price into both TickerPrice (current) and TickerPriceHistory (daily).
// The history date is normalized to ET calendar date stored as UTC midnight.
async function upsertTickerPrice(
  ticker: string,
  price: number,
  priceDate: Date,
  priceSource: string,
): Promise<void> {
  const etDateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(priceDate);
  const [etMonth, etDay, etYear] = etDateStr.split("/");
  const historyDate = new Date(Date.UTC(Number(etYear), Number(etMonth) - 1, Number(etDay)));

  await prisma.tickerPrice.upsert({
    where: { ticker },
    create: { ticker, price, priceDate, priceSource },
    update: { price, priceDate, priceSource },
  });

  await prisma.tickerPriceHistory.upsert({
    where: { ticker_date: { ticker, date: historyDate } },
    create: { ticker, date: historyDate, closePrice: price },
    update: { closePrice: price },
  });
}

// ── POST /api/investments/prices/refresh ──────────────────────────────────
// Fetch latest prices for all tracked tickers and upsert into both TickerPrice
// and TickerPriceHistory. TickerPrice is always kept current (live quote during
// the day, closing price after 8 PM ET). TickerPriceHistory is also written
// here so that the chart's most-recent data point always matches the header
// value — both come from the same Yahoo quote fetch rather than two different
// endpoints that can disagree slightly.

investmentRoutes.post("/prices/refresh", async (req, res) => {
  try {
    const userId = getUserId(req);
    const source: string = req.body?.source ?? "unknown";

    const userAccounts = await prisma.account.findMany({
      where: { type: "INVESTMENT", userId },
      select: { id: true },
    });
    const userAccountIds = userAccounts.map((a) => a.id);

    const holdings = await prisma.investmentHolding.findMany({
      where: { accountId: { in: userAccountIds } },
      select: { ticker: true, coinGeckoId: true },
    });

    const tickers = [...new Set(holdings.map((h) => h.ticker))];
    if (tickers.length === 0) return res.json({ updated: 0, tickers: [] });

    // Build a ticker → coinGeckoId map for crypto holdings (deduplicated by ticker).
    const coinGeckoIdByTicker = new Map<string, string>();
    for (const h of holdings) {
      if (h.coinGeckoId && !coinGeckoIdByTicker.has(h.ticker)) {
        coinGeckoIdByTicker.set(h.ticker, h.coinGeckoId);
      }
    }
    const cryptoTickers = new Set(coinGeckoIdByTicker.keys());

    // Identify tickers already known to require Tiingo (e.g. money market funds).
    // These skip Yahoo entirely — no wasted request, no misleading null warning.
    const tiingoRows = await prisma.tickerPrice.findMany({
      where: { ticker: { in: tickers }, priceSource: "TIINGO" },
      select: { ticker: true },
    });
    const tiingoTickers = new Set(tiingoRows.map((r) => r.ticker));

    console.log(
      `[price-refresh] triggered from ${source} — ${tickers.length} ticker(s)` +
      (cryptoTickers.size > 0 ? ` (${cryptoTickers.size} crypto via CoinGecko)` : "") +
      (tiingoTickers.size > 0 ? ` (${tiingoTickers.size} via Tiingo)` : ""),
    );

    // Batch-fetch all crypto prices in one CoinGecko call.
    const cryptoCoinIds = [...cryptoTickers].map((t) => coinGeckoIdByTicker.get(t)!);
    const cryptoPriceMap = cryptoCoinIds.length > 0 ? await getPrices(cryptoCoinIds) : new Map();

    let updated = 0;
    const results: string[] = [];

    for (const ticker of tickers) {
      let price: number | null = null;
      let priceDate: Date | null = null;
      let priceSource: string;

      if (cryptoTickers.has(ticker)) {
        // Crypto: price was already fetched in the batch call above.
        const coinGeckoId = coinGeckoIdByTicker.get(ticker)!;
        const cryptoPrice = cryptoPriceMap.get(coinGeckoId);
        if (cryptoPrice) {
          price = cryptoPrice.price;
          priceDate = cryptoPrice.updatedAt;
        } else {
          console.warn(`[price-refresh] ${ticker}: no data returned from CoinGecko (id: ${coinGeckoId})`);
        }
        priceSource = "COINGECKO";
      } else if (tiingoTickers.has(ticker)) {
        // Tiingo-sourced ticker: use close (unadjusted), correct for MMFs.
        // Scan window: just the last 7 days to get today's NAV efficiently.
        const today = new Date().toISOString().slice(0, 10);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const result = await getDividendScanResult(ticker, weekAgo, today);
        if (result.latestClose != null && result.latestCloseDate != null) {
          price = result.latestClose;
          priceDate = new Date(result.latestCloseDate + "T00:00:00Z");
        }
        priceSource = "TIINGO";
      } else {
        // Yahoo path: try first; if it fails and no existing row exists,
        // the dividend scan will handle Tiingo promotion when it runs.
        const priceData = await fetchYahooPrice(ticker);
        if (priceData) {
          price = priceData.price;
          priceDate = priceData.priceDate;
        } else {
          console.warn(`[price-refresh] ${ticker}: no data returned from Yahoo Finance`);
        }
        priceSource = "YAHOO";
        // Small delay to be polite to Yahoo's servers
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      if (price != null && priceDate != null) {
        const dateStr = priceDate.toISOString().slice(0, 10);
        console.log(`[price-refresh] ${ticker}: $${price} (${dateStr}) [${priceSource}]`);

        // Normalize to the ET calendar date, then store as UTC midnight.
        // We use ET here because regularMarketTime for a 4 PM ET close is 8 PM
        // UTC, which can roll over to the next UTC date — so UTC date extraction
        // would produce an off-by-one (e.g. April 1 instead of March 31).
        const etDateStr = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          year: "numeric", month: "2-digit", day: "2-digit",
        }).format(priceDate);
        const [etMonth, etDay, etYear] = etDateStr.split("/");
        const historyDate = new Date(Date.UTC(Number(etYear), Number(etMonth) - 1, Number(etDay)));

        await prisma.tickerPrice.upsert({
          where: { ticker },
          create: { ticker, price, priceDate, priceSource },
          update: { price, priceDate, priceSource },
        });

        await prisma.tickerPriceHistory.upsert({
          where: { ticker_date: { ticker, date: historyDate } },
          create: { ticker, date: historyDate, closePrice: price },
          update: { closePrice: price },
        });

        updated++;
        results.push(ticker);
      }
    }

    console.log(`[price-refresh] done — ${updated}/${tickers.length} updated`);
    res.json({ updated, tickers: results });
  } catch (err) {
    console.error("[price-refresh] ERROR:", err);
    res.status(500).json({ error: { message: "Failed to refresh prices" } });
  }
});

// ── GET /api/investments/prices/refresh/stream ────────────────────────────
// SSE endpoint that streams per-ticker price refresh progress.
// Performs a server-side staleness check and skips up-to-date tickers so that
// both the Dashboard and Investments pages can call this safely on every load.
//
// Events: { type:"start", total } | { type:"progress", count, total } | { type:"done", updated, total }

investmentRoutes.get("/prices/refresh/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const userId = getUserId(req);
    const source: string = (req.query.source as string) ?? "unknown";

    const userAccounts = await prisma.account.findMany({
      where: { type: "INVESTMENT", userId },
      select: { id: true },
    });
    const userAccountIds = userAccounts.map((a) => a.id);

    const holdings = await prisma.investmentHolding.findMany({
      where: { accountId: { in: userAccountIds } },
      select: { ticker: true, coinGeckoId: true },
    });

    const tickers = [...new Set(holdings.map((h) => h.ticker))];

    const coinGeckoIdByTicker = new Map<string, string>();
    for (const h of holdings) {
      if (h.coinGeckoId && !coinGeckoIdByTicker.has(h.ticker)) {
        coinGeckoIdByTicker.set(h.ticker, h.coinGeckoId);
      }
    }
    const cryptoTickers = new Set(coinGeckoIdByTicker.keys());

    // Server-side staleness check — skip tickers whose prices are still fresh.
    const now = new Date();
    const priceRows = await prisma.tickerPrice.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, updatedAt: true },
    });
    const priceUpdatedAtMap = new Map(priceRows.map((r) => [r.ticker, r.updatedAt]));

    const staleTickers = tickers.filter((t) =>
      isTickerStale(priceUpdatedAtMap.get(t) ?? null, cryptoTickers.has(t), now),
    );

    if (staleTickers.length === 0) {
      send({ type: "done", updated: 0, total: 0 });
      res.end();
      return;
    }

    const tiingoRows = await prisma.tickerPrice.findMany({
      where: { ticker: { in: staleTickers }, priceSource: "TIINGO" },
      select: { ticker: true },
    });
    const tiingoTickers = new Set(tiingoRows.map((r) => r.ticker));

    const staleCrypto = staleTickers.filter((t) => cryptoTickers.has(t));
    const staleOther = staleTickers.filter((t) => !cryptoTickers.has(t));
    const total = staleTickers.length;

    console.log(
      `[price-refresh/stream] triggered from ${source} — ${total} stale ticker(s)` +
        (staleCrypto.length > 0 ? ` (${staleCrypto.length} crypto)` : ""),
    );

    send({ type: "start", total });

    let count = 0;

    // Batch-fetch all crypto in one CoinGecko call.
    if (staleCrypto.length > 0) {
      const coinIds = staleCrypto.map((t) => coinGeckoIdByTicker.get(t)!);
      const cryptoPriceMap = await getPrices(coinIds);

      for (const ticker of staleCrypto) {
        const entry = cryptoPriceMap.get(coinGeckoIdByTicker.get(ticker)!);
        if (entry) {
          await upsertTickerPrice(ticker, entry.price, entry.updatedAt, "COINGECKO");
          console.log(`[price-refresh/stream] ${ticker}: $${entry.price} [COINGECKO]`);
        }
        send({ type: "progress", count: ++count, total });
      }
    }

    // Sequential fetch for stocks/funds.
    for (const ticker of staleOther) {
      let price: number | null = null;
      let priceDate: Date | null = null;
      let priceSource: string;

      if (tiingoTickers.has(ticker)) {
        const today = new Date().toISOString().slice(0, 10);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const result = await getDividendScanResult(ticker, weekAgo, today);
        if (result.latestClose != null && result.latestCloseDate != null) {
          price = result.latestClose;
          priceDate = new Date(result.latestCloseDate + "T00:00:00Z");
        }
        priceSource = "TIINGO";
      } else {
        const priceData = await fetchYahooPrice(ticker);
        if (priceData) {
          price = priceData.price;
          priceDate = priceData.priceDate;
        } else {
          console.warn(`[price-refresh/stream] ${ticker}: no data from Yahoo Finance`);
        }
        priceSource = "YAHOO";
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      if (price != null && priceDate != null) {
        await upsertTickerPrice(ticker, price, priceDate, priceSource);
        console.log(`[price-refresh/stream] ${ticker}: $${price} [${priceSource}]`);
      }

      send({ type: "progress", count: ++count, total });
    }

    console.log(`[price-refresh/stream] done — ${count} of ${total} processed`);
    send({ type: "done", updated: count, total });
    res.end();
  } catch (err) {
    console.error("[price-refresh/stream] ERROR:", err);
    if (!res.writableEnded) {
      send({ type: "error", message: "Failed to refresh prices" });
      res.end();
    }
  }
});

// ── POST /api/investments/import ──────────────────────────────────────────
// Bulk-import lots from CSV. Groups by symbol, creates holdings as needed.

const importInvestmentsSchema = z.object({
  accountId: z.string(),
  rows: z.array(
    z.object({
      symbol: z.string().min(1).max(20).transform((s) => s.toUpperCase().trim()),
      purchaseDate: z.string(),
      price: z.number().nonnegative(),
      quantity: z.number().positive(),
    })
  ),
});

investmentRoutes.post("/import", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = importInvestmentsSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: body.accountId, isActive: true, type: "INVESTMENT", userId },
    });
    if (!account)
      return res.status(404).json({ error: { message: "Investment account not found" } });

    let imported = 0;
    const errors: Array<{ row: number; message: string }> = [];

    // Group rows by symbol (preserving original index for error reporting)
    const bySymbol = new Map<string, Array<{ row: typeof body.rows[0]; idx: number }>>();
    body.rows.forEach((row, idx) => {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
      bySymbol.get(row.symbol)!.push({ row, idx });
    });

    // Cache symbol → meta to avoid duplicate API calls for the same ticker
    const metaCache = new Map<string, { name: string; type: string | null }>();

    for (const [symbol, entries] of bySymbol) {
      try {
        let holding = await prisma.investmentHolding.findFirst({
          where: { accountId: body.accountId, ticker: symbol },
        });
        if (!holding) {
          // Fetch meta only for new symbols not already in cache
          if (!metaCache.has(symbol)) {
            metaCache.set(symbol, await fetchYahooMeta(symbol));
          }
          const { name, type } = metaCache.get(symbol)!;
          const instrumentId = await resolveInstrumentId(symbol, name);
          holding = await prisma.investmentHolding.create({
            data: { accountId: body.accountId, ticker: symbol, name, type, instrumentId },
          });
        } else if (holding.name === holding.ticker || holding.type === null || !holding.instrumentId) {
          // Holding exists but name/type was never resolved, or instrumentId is missing — fix it
          if (!metaCache.has(symbol)) {
            metaCache.set(symbol, await fetchYahooMeta(symbol));
          }
          const { name, type } = metaCache.get(symbol)!;
          const updates: Record<string, string | null> = {};
          if (holding.name === holding.ticker && name !== symbol) updates.name = name;
          if (holding.type === null && type !== null) updates.type = type;
          if (!holding.instrumentId) updates.instrumentId = await resolveInstrumentId(symbol, name);
          if (Object.keys(updates).length > 0) {
            holding = await prisma.investmentHolding.update({
              where: { id: holding.id },
              data: updates,
            });
          }
        }

        for (const { row, idx } of entries) {
          try {
            const acquiredDate = new Date(row.purchaseDate);
            await prisma.$transaction(async (tx) => {
              const newLot = await tx.investmentLot.create({
                data: {
                  holdingId: holding.id,
                  quantity: row.quantity,
                  costPerShare: row.price,
                  acquiredDate,
                },
              });
              await tx.investmentActivity.create({
                data: {
                  accountId: body.accountId,
                  holdingId: holding.id,
                  lotId: newLot.id,
                  ticker: holding.ticker,
                  type: "PURCHASE",
                  date: acquiredDate,
                  shares: row.quantity,
                  pricePerShare: row.price,
                  amount: Math.round(row.quantity * row.price * 100) / 100,
                  updatedAt: new Date(),
                },
              });
            });
            imported++;
          } catch (e) {
            errors.push({
              row: idx + 1,
              message: `Failed to create lot: ${e instanceof Error ? e.message : "Unknown error"}`,
            });
          }
        }
      } catch (e) {
        for (const { idx } of entries) {
          errors.push({
            row: idx + 1,
            message: `Failed to process ${symbol}: ${e instanceof Error ? e.message : "Unknown error"}`,
          });
        }
      }
    }

    res.json({ imported, errors });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to import investments" } });
  }
});

// ── POST /api/investments/prices/backfill-history ─────────────────────────
// Re-runnable backfill: fetches YTD adjusted-close price history for every
// tracked ticker and upserts rows into TickerPriceHistory. Uses upsert (not
// skipDuplicates) so re-running this corrects any stale or mid-day rows that
// were accidentally written earlier. Only fills up to effectiveLastTradingDay
// so we never store a partial/mid-day candle for an in-progress session.
// NOTE: must be declared before /prices/:ticker to avoid route conflict

investmentRoutes.post("/prices/backfill-history", async (_req, res) => {
  try {
    const year = new Date().getUTCFullYear();
    const fromDate = new Date(Date.UTC(year, 0, 1)); // Jan 1 of current year (UTC)

    // Cap at the last finalized trading day — same rule as fillPriceGaps
    const targetDay = effectiveLastTradingDay();
    const toDate = new Date(targetDay.getTime() + 24 * 60 * 60 * 1000);

    const holdings = await prisma.investmentHolding.findMany({
      select: { ticker: true },
      distinct: ["ticker"],
    });
    const tickers = holdings.map((h) => h.ticker);
    if (tickers.length === 0) return res.json({ upserted: 0, tickers: [] });

    const summary: Array<{ ticker: string; upserted: number }> = [];
    let totalUpserted = 0;

    for (const ticker of tickers) {
      const points = await fetchYahooHistory(ticker, fromDate, toDate);
      if (points.length === 0) {
        summary.push({ ticker, upserted: 0 });
        continue;
      }
      // Upsert each point individually so existing rows are overwritten with
      // the correct adjusted-close rather than silently skipped.
      let count = 0;
      for (const p of points) {
        await prisma.tickerPriceHistory.upsert({
          where: { ticker_date: { ticker, date: p.date } },
          create: { ticker, date: p.date, closePrice: p.closePrice },
          update: { closePrice: p.closePrice },
        });
        count++;
      }
      totalUpserted += count;
      summary.push({ ticker, upserted: count });
      await new Promise((r) => setTimeout(r, 200));
    }

    res.json({ upserted: totalUpserted, tickers: summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to backfill price history" } });
  }
});

// ── GET /api/investments/prices/status ────────────────────────────────────
// Returns current price cache status for all tracked tickers
// NOTE: must be declared before /prices/:ticker to avoid route conflict

investmentRoutes.get("/prices/status", async (_req, res) => {
  try {
    const prices = await prisma.tickerPrice.findMany({
      orderBy: { ticker: "asc" },
    });
    res.json(prices.map((p) => ({
      ticker: p.ticker,
      price: parseFloat(p.price.toString()),
      priceDate: p.priceDate,
      updatedAt: p.updatedAt,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch price status" } });
  }
});

// ── GET /api/investments/prices/:ticker ───────────────────────────────────
// Returns the current (or historical) price for a single ticker.
// Optional ?date=YYYY-MM-DD returns the closing price for that date via Tiingo.
// Without ?date, returns the live/cached price from Yahoo Finance.

investmentRoutes.get("/prices/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const dateParam = (req.query.date as string | undefined)?.trim();
  // Optional: caller can supply the CoinGecko ID directly (e.g. before a holding
  // is saved to the DB) so we never accidentally fall back to Yahoo Finance.
  const coinGeckoIdParam = (req.query.coinGeckoId as string | undefined)?.trim() || null;

  // ── Historical price lookup (Yahoo Finance) ───────────────────────────────
  if (dateParam) {
    const price = await fetchYahooClosingPrice(ticker, dateParam);
    if (price == null) {
      return res.status(404).json({
        error: { message: `No price data found for ${ticker} on or before ${dateParam}` },
      });
    }
    return res.json({ ticker, price, priceDate: dateParam });
  }

  // ── Current price (cached or live) ───────────────────────────────────────
  try {
    // Resolve whether this is a crypto ticker.
    // Priority: explicit coinGeckoId query param → DB lookup on existing holding.
    // The query param path handles the "add new holding" flow where no DB row
    // exists yet and we must not fall through to Yahoo Finance (which would
    // return a completely unrelated asset with the same symbol, e.g. "BTC" →
    // Grayscale Bitcoin Mini Trust).
    const resolvedCoinGeckoId =
      coinGeckoIdParam ??
      (await prisma.investmentHolding.findFirst({
        where: { ticker, coinGeckoId: { not: null } },
        select: { coinGeckoId: true },
      }))?.coinGeckoId ??
      null;

    const isCrypto = !!resolvedCoinGeckoId;
    const cacheMaxAgeMs = isCrypto ? 5 * 60 * 1000 : 60 * 60 * 1000;

    // Return cached price if it's still fresh
    const existing = await prisma.tickerPrice.findUnique({ where: { ticker } });
    if (existing) {
      const ageMs = Date.now() - existing.updatedAt.getTime();
      if (ageMs < cacheMaxAgeMs) {
        return res.json({
          ticker,
          price: parseFloat(existing.price.toString()),
          priceDate: existing.priceDate,
        });
      }
    }

    let price: number;
    let priceDate: Date;
    let priceSource: string;

    if (isCrypto && resolvedCoinGeckoId) {
      // Fetch live from CoinGecko
      const coinPrice = await getCoinGeckoPrice(resolvedCoinGeckoId);
      if (!coinPrice) {
        return res.status(404).json({ error: { message: "Price not available for " + ticker } });
      }
      price = coinPrice.price;
      priceDate = coinPrice.updatedAt;
      priceSource = "COINGECKO";
    } else {
      // Fetch live from Yahoo Finance
      const priceData = await fetchYahooPrice(ticker);
      if (!priceData) {
        return res.status(404).json({ error: { message: "Price not available for " + ticker } });
      }
      price = priceData.price;
      priceDate = priceData.priceDate;
      priceSource = "YAHOO";
    }

    const record = await prisma.tickerPrice.upsert({
      where: { ticker },
      create: { ticker, price, priceDate, priceSource, updatedAt: new Date() },
      update: { price, priceDate, priceSource, updatedAt: new Date() },
    });

    res.json({
      ticker,
      price: parseFloat(record.price.toString()),
      priceDate: record.priceDate,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch price" } });
  }
});

// ── POST /api/investments/qfx-import/:accountId ──────────────────────────
// Accepts a list of parsed QFX transactions (parsed client-side via DOMParser)
// and upserts them into QfxTransaction using FITID for deduplication so
// overlapping date-range re-imports are safe. Only valid for managed accounts.
// Also accepts an optional cashBalance to update the account's settlement cash.

const qfxTransactionSchema = z.object({
  fitId: z.string().min(1),
  ticker: z.string().min(1),
  type: z.enum(["BUY", "SELL", "REINVEST"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shares: z.number().nonnegative(),
  pricePerShare: z.number().nonnegative(), // 0 is valid for stock splits
  total: z.number(),
});

const qfxImportSchema = z.object({
  transactions: z.array(qfxTransactionSchema),
  cashBalance: z.number().nullable().optional(),
});

investmentRoutes.post("/qfx-import/:accountId", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const account = await prisma.account.findFirst({
      where: { id: accountId, isActive: true, type: "INVESTMENT", isManaged: true, userId },
    });
    if (!account) {
      return res.status(404).json({ error: { message: "Managed investment account not found" } });
    }

    const body = qfxImportSchema.parse(req.body);
    const { transactions, cashBalance } = body;

    // Upsert all transactions — skip duplicates by (accountId, fitId)
    const rows = transactions.map((t) => ({
      accountId,
      fitId: t.fitId,
      ticker: t.ticker,
      type: t.type as "BUY" | "SELL" | "REINVEST",
      date: new Date(t.date),
      shares: t.shares,
      pricePerShare: t.pricePerShare,
      total: t.total,
    }));

    const result = await prisma.qfxTransaction.createMany({
      data: rows,
      skipDuplicates: true,
    });

    // Optionally update the account's settlement cash balance
    if (cashBalance != null) {
      await prisma.account.update({
        where: { id: accountId },
        data: { cashBalance, cashBalanceUpdatedAt: new Date() },
      });
    }

    // Sync managed lots from the full QFX transaction history so the holdings
    // table always reflects the current cumulative position. We read all records
    // (not just the new ones) so that re-importing a duplicate file still repairs
    // any stale lots.
    const allQfxTxns = await prisma.qfxTransaction.findMany({ where: { accountId } });
    const netSharesMap = new Map<string, number>();
    for (const t of allQfxTxns) {
      const prev = netSharesMap.get(t.ticker) ?? 0;
      const delta = parseFloat(t.shares.toString()) * (t.type === "SELL" ? -1 : 1);
      netSharesMap.set(t.ticker, prev + delta);
    }

    for (const [ticker, netShares] of netSharesMap) {
      if (netShares < 0.000001) continue;

      const existing = await prisma.investmentHolding.findFirst({
        where: { accountId, ticker },
        include: { lots: { where: { acquiredDate: null }, take: 1 } },
      });

      let holdingId: string;
      let costPerShare = 0;

      if (existing) {
        holdingId = existing.id;
        if (existing.lots[0]) {
          costPerShare = parseFloat(existing.lots[0].costPerShare.toString());
        }
      } else {
        const instrumentId = await resolveInstrumentId(ticker, ticker);
        const created = await prisma.investmentHolding.create({
          data: { accountId, ticker, name: ticker, instrumentId },
        });
        holdingId = created.id;
      }

      await prisma.$transaction([
        prisma.investmentLot.deleteMany({ where: { holdingId, acquiredDate: null } }),
        prisma.investmentLot.create({ data: { holdingId, quantity: netShares, costPerShare, acquiredDate: null } }),
      ]);
    }

    res.json({ imported: result.count, total: transactions.length });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    }
    console.error(err);
    res.status(500).json({ error: { message: "Failed to import QFX transactions" } });
  }
});

// ── GET /api/investments/qfx-last-date/:accountId ────────────────────────
// Returns the date of the most recent QFX transaction for the account so the
// UI can tell the user what date range to export from Wealthfront next time.

investmentRoutes.get("/qfx-last-date/:accountId", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const account = await prisma.account.findFirst({
      where: { id: accountId, isActive: true, type: "INVESTMENT", isManaged: true, userId },
    });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    const latest = await prisma.qfxTransaction.findFirst({
      where: { accountId },
      orderBy: { date: "desc" },
      select: { date: true },
    });

    res.json({ lastDate: latest ? latest.date.toISOString() : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch last QFX date" } });
  }
});

// ── GET /api/investments/growth/:accountId ────────────────────────────────
// Returns a daily time-series of portfolio market value for an investment
// account. Triggers a lazy gap-fill before computing so the series always
// extends through the most recent trading day.
//
// Self-directed accounts: reconstructs positions from lot-level purchase
// history + SALE activities. Returns both marketValue and costBasis.
//   For each date D: position = remaining lots acquired ≤ D + shares from
//   future sales added back (handles partial/full liquidations).
//
// Managed accounts (isManaged = true): reconstructs positions from imported
// QFX transactions using a forward-accumulation approach. Returns marketValue
// only (costBasis is omitted — lot matching is unreliable for robo accounts).
//   For each date D: position = cumulative buys/reinvests - cumulative sells ≤ D.

investmentRoutes.get("/growth/:accountId", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;

    const account = await prisma.account.findFirst({
      where: { id: accountId, isActive: true, type: "INVESTMENT", userId },
    });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    // ── Managed account path ──────────────────────────────────────────────
    if (account.isManaged) {
      const qfxTxns = await prisma.qfxTransaction.findMany({
        where: { accountId },
        orderBy: { date: "asc" },
      });

      if (qfxTxns.length === 0) return res.json({ points: [] });

      const allTickers = [...new Set(qfxTxns.map((t) => t.ticker))];
      await fillPriceGaps(allTickers);

      const earliestDate = qfxTxns[0].date;
      const priceRows = await prisma.tickerPriceHistory.findMany({
        where: { ticker: { in: allTickers }, date: { gte: earliestDate } },
        orderBy: { date: "asc" },
      });
      if (priceRows.length === 0) return res.json({ points: [] });

      const pricesByTicker = new Map<string, Array<{ date: Date; closePrice: number }>>();
      for (const row of priceRows) {
        if (!pricesByTicker.has(row.ticker)) pricesByTicker.set(row.ticker, []);
        pricesByTicker.get(row.ticker)!.push({
          date: row.date,
          closePrice: parseFloat(row.closePrice.toString()),
        });
      }

      const effectiveDate = effectiveLastTradingDay();
      const dateSet = new Set<string>();
      for (const rows of pricesByTicker.values()) {
        for (const r of rows) {
          if (r.date <= effectiveDate) dateSet.add(r.date.toISOString());
        }
      }
      const sortedDates = [...dateSet].sort();

      function priceAsOf(ticker: string, asOf: Date): number | null {
        const prices = pricesByTicker.get(ticker);
        if (!prices) return null;
        let best: number | null = null;
        for (const p of prices) {
          if (p.date <= asOf) best = p.closePrice;
          else break;
        }
        return best;
      }

      // Parse transactions once into typed objects with numeric shares
      type QfxTxn = { date: Date; ticker: string; type: "BUY" | "SELL" | "REINVEST"; shares: number; pricePerShare: number; total: number };
      const parsedTxns: QfxTxn[] = qfxTxns.map((t) => ({
        date: t.date,
        ticker: t.ticker,
        type: t.type as "BUY" | "SELL" | "REINVEST",
        shares: parseFloat(t.shares.toString()),
        pricePerShare: parseFloat(t.pricePerShare.toString()),
        total: parseFloat(t.total.toString()),
      }));

      type ManagedEventRecord = { type: "BUY" | "SELL"; ticker: string; shares: number; pricePerShare: number | null; netAmount: number };
      const rawEventsByDate = new Map<string, ManagedEventRecord[]>();
      for (const t of parsedTxns) {
        const dateKey = t.date.toISOString().split("T")[0];
        if (!rawEventsByDate.has(dateKey)) rawEventsByDate.set(dateKey, []);
        rawEventsByDate.get(dateKey)!.push({
          type: t.type === "SELL" ? "SELL" : "BUY",
          ticker: t.ticker,
          shares: t.shares,
          pricePerShare: t.pricePerShare,
          netAmount: Math.abs(t.total),
        });
      }

      const points: Array<{
        date: string;
        marketValue: number;
        costBasis: null;
        unrealizedGain: null;
        unrealizedGainPct: null;
        events?: ManagedEventRecord[];
      }> = [];

      // Pre-sort transactions by date and build a running-shares map so we
      // don't re-scan all transactions for every chart date (O(n) not O(n²)).
      let txnIdx = 0;
      const runningShares = new Map<string, number>(); // ticker → cumulative shares
      for (const ticker of allTickers) runningShares.set(ticker, 0);

      for (const dateStr of sortedDates) {
        const asOf = new Date(dateStr);

        // Advance the running totals for all transactions up to this date
        while (txnIdx < parsedTxns.length && parsedTxns[txnIdx].date <= asOf) {
          const t = parsedTxns[txnIdx];
          const prev = runningShares.get(t.ticker) ?? 0;
          runningShares.set(t.ticker, prev + (t.type === "SELL" ? -t.shares : t.shares));
          txnIdx++;
        }

        let marketValue = 0;
        let hasPrice = false;

        for (const ticker of allTickers) {
          const qty = runningShares.get(ticker) ?? 0;
          if (qty <= 0.000001) continue;

          const price = priceAsOf(ticker, asOf);
          if (price == null) continue;
          hasPrice = true;
          marketValue += qty * price;
        }

        if (!hasPrice) continue;

        points.push({
          date: asOf.toISOString().split("T")[0],
          marketValue: Math.round(marketValue * 100) / 100,
          costBasis: null,
          unrealizedGain: null,
          unrealizedGainPct: null,
        });
      }

      // Snap events to chart dates
      const chartDateList = points.map((p) => p.date).sort();
      const chartDateSet = new Set(chartDateList);
      const eventsByChartDate = new Map<string, ManagedEventRecord[]>();
      for (const [eventDate, events] of rawEventsByDate) {
        let snapDate: string | undefined;
        if (chartDateSet.has(eventDate)) {
          snapDate = eventDate;
        } else {
          for (const d of chartDateList) {
            if (d <= eventDate) snapDate = d;
            else break;
          }
        }
        if (!snapDate) continue;
        if (!eventsByChartDate.has(snapDate)) eventsByChartDate.set(snapDate, []);
        eventsByChartDate.get(snapDate)!.push(...events);
      }
      for (const point of points) {
        const events = eventsByChartDate.get(point.date);
        if (events?.length) point.events = events;
      }

      return res.json({ points });
    }

    // ── Self-directed account path ────────────────────────────────────────

    // Load holdings with only dated lots (managed lots have null acquiredDate)
    const holdings = await prisma.investmentHolding.findMany({
      where: { accountId },
      include: {
        lots: {
          where: { acquiredDate: { not: null } },
          orderBy: { acquiredDate: "asc" },
        },
      },
    });

    // Load all SALE activities for this account
    const saleActivities = await prisma.investmentActivity.findMany({
      where: { accountId, type: "SALE" },
      orderBy: { date: "asc" },
    });

    // Group sales by ticker
    type SaleRecord = { date: Date; shares: number; costBasis: number };
    const salesByTicker = new Map<string, SaleRecord[]>();
    for (const act of saleActivities) {
      if (act.shares == null) continue;
      if (!salesByTicker.has(act.ticker)) salesByTicker.set(act.ticker, []);
      salesByTicker.get(act.ticker)!.push({
        date: act.date,
        shares: parseFloat(act.shares.toString()),
        costBasis: act.costBasis ? parseFloat(act.costBasis.toString()) : 0,
      });
    }

    // All tickers to chart: those with remaining lots OR past sale activities
    const holdingsWithLots = holdings.filter((h) => h.lots.length > 0);
    const allTickers = [
      ...new Set([
        ...holdingsWithLots.map((h) => h.ticker),
        ...salesByTicker.keys(),
      ]),
    ];

    if (allTickers.length === 0) return res.json({ points: [] });

    // Build coinGeckoId map for crypto holdings in this account
    const coinGeckoIdByTickerGrowth = new Map<string, string>();
    for (const h of holdings) {
      if (h.coinGeckoId) coinGeckoIdByTickerGrowth.set(h.ticker, h.coinGeckoId);
    }

    // Lazy gap-fill: bring price history current before computing
    await fillPriceGaps(allTickers, coinGeckoIdByTickerGrowth);

    // Earliest date: min of first lot acquisition and first sale date
    const allLots = holdingsWithLots.flatMap((h) => h.lots);
    const firstLotDate = allLots.length > 0
      ? allLots.reduce((min, l) => (l.acquiredDate! < min ? l.acquiredDate! : min), allLots[0].acquiredDate!)
      : null;
    const firstSaleDate = saleActivities.length > 0 ? saleActivities[0].date : null;
    const earliestDate = firstLotDate && firstSaleDate
      ? (firstLotDate < firstSaleDate ? firstLotDate : firstSaleDate)
      : (firstLotDate ?? firstSaleDate);

    if (!earliestDate) return res.json({ points: [] });

    // Load all relevant price history from DB
    const priceRows = await prisma.tickerPriceHistory.findMany({
      where: { ticker: { in: allTickers }, date: { gte: earliestDate } },
      orderBy: { date: "asc" },
    });

    if (priceRows.length === 0) return res.json({ points: [] });

    // Build per-ticker sorted price series
    const pricesByTicker = new Map<string, Array<{ date: Date; closePrice: number }>>();
    for (const row of priceRows) {
      if (!pricesByTicker.has(row.ticker)) pricesByTicker.set(row.ticker, []);
      pricesByTicker.get(row.ticker)!.push({
        date: row.date,
        closePrice: parseFloat(row.closePrice.toString()),
      });
    }

    // The effective last trading day is the most recent day whose prices have
    // settled (i.e. it's past 8 PM ET). Before that cutoff, today's prices
    // aren't considered final, so we stop the chart at the previous trading day.
    // TickerPriceHistory is always consistent with this: fillPriceGaps only
    // writes up to effectiveLastTradingDay, and refreshPrices upserts today's
    // row into TickerPriceHistory at the same time as TickerPrice, so the chart
    // and header are always reading from the same source of truth.
    const effectiveDate = effectiveLastTradingDay();

    // Build per-ticker current lot data
    type LotData = { acquiredDate: Date; quantity: number; costPerShare: number };
    const lotsByTicker = new Map<string, LotData[]>();
    for (const holding of holdingsWithLots) {
      lotsByTicker.set(
        holding.ticker,
        holding.lots.map((l) => ({
          acquiredDate: l.acquiredDate!,
          quantity: parseFloat(l.quantity.toString()),
          costPerShare: parseFloat(l.costPerShare.toString()),
        }))
      );
    }

    // Union of all dates across all tickers, capped at the effective last trading
    // day so we never render data points for days whose prices haven't settled yet.
    const dateSet = new Set<string>();
    for (const rows of pricesByTicker.values()) {
      for (const r of rows) {
        if (r.date <= effectiveDate) dateSet.add(r.date.toISOString());
      }
    }
    const sortedDates = [...dateSet].sort();

    // Returns the most recent known price for a ticker on or before `asOf`
    function priceAsOf(ticker: string, asOf: Date): number | null {
      const prices = pricesByTicker.get(ticker);
      if (!prices) return null;
      let best: number | null = null;
      for (const p of prices) {
        if (p.date <= asOf) best = p.closePrice;
        else break;
      }
      return best;
    }

    // Transaction event records (buy/sell markers on the chart)
    type EventRecord = {
      type: "BUY" | "SELL";
      ticker: string;
      shares: number;
      pricePerShare: number | null;
      netAmount: number;
    };

    // Compute the series
    const points: Array<{
      date: string;
      marketValue: number;
      costBasis: number;
      unrealizedGain: number;
      unrealizedGainPct: number;
      events?: EventRecord[];
    }> = [];

    for (const dateStr of sortedDates) {
      const asOf = new Date(dateStr);
      let marketValue = 0;
      let totalCostBasis = 0;
      let hasPrice = false;

      for (const ticker of allTickers) {
        // Current remaining lots acquired by this date
        const lots = lotsByTicker.get(ticker) ?? [];
        const activeLots = lots.filter((l) => l.acquiredDate <= asOf);

        // Sales that happened strictly after this date — add those shares back
        const sales = salesByTicker.get(ticker) ?? [];
        const futureSales = sales.filter((s) => s.date > asOf);

        const qty =
          activeLots.reduce((s, l) => s + l.quantity, 0) +
          futureSales.reduce((s, sale) => s + sale.shares, 0);
        const basis =
          activeLots.reduce((s, l) => s + l.quantity * l.costPerShare, 0) +
          futureSales.reduce((s, sale) => s + sale.costBasis, 0);

        if (qty <= 0) continue;

        const price = priceAsOf(ticker, asOf);
        if (price == null) continue;
        hasPrice = true;

        marketValue += qty * price;
        totalCostBasis += basis;
      }

      if (!hasPrice) continue;

      const unrealizedGain = marketValue - totalCostBasis;
      const unrealizedGainPct = totalCostBasis > 0 ? (unrealizedGain / totalCostBasis) * 100 : 0;

      points.push({
        date: asOf.toISOString().split("T")[0],
        marketValue: Math.round(marketValue * 100) / 100,
        costBasis: Math.round(totalCostBasis * 100) / 100,
        unrealizedGain: Math.round(unrealizedGain * 100) / 100,
        unrealizedGainPct: Math.round(unrealizedGainPct * 100) / 100,
      });
    }

    // ── Attach transaction events to chart points ─────────────────────────
    // Buy events come from PURCHASE activities (persisted on lot creation, survive lot deletion).
    // Sell events come from SALE activities. Events on non-trading days are snapped to the
    // nearest preceding chart date.
    const purchaseActivities = await prisma.investmentActivity.findMany({
      where: { accountId, type: "PURCHASE" },
      orderBy: { date: "asc" },
    });

    const rawEventsByDate = new Map<string, EventRecord[]>();

    for (const act of purchaseActivities) {
      if (act.shares == null) continue;
      const dateKey = act.date.toISOString().split("T")[0];
      if (!rawEventsByDate.has(dateKey)) rawEventsByDate.set(dateKey, []);
      rawEventsByDate.get(dateKey)!.push({
        type: "BUY",
        ticker: act.ticker,
        shares: parseFloat(act.shares.toString()),
        pricePerShare: act.pricePerShare ? parseFloat(act.pricePerShare.toString()) : null,
        netAmount: parseFloat(act.amount.toString()),
      });
    }

    for (const act of saleActivities) {
      if (act.shares == null) continue;
      const dateKey = act.date.toISOString().split("T")[0];
      if (!rawEventsByDate.has(dateKey)) rawEventsByDate.set(dateKey, []);
      rawEventsByDate.get(dateKey)!.push({
        type: "SELL",
        ticker: act.ticker,
        shares: parseFloat(act.shares.toString()),
        pricePerShare: act.pricePerShare ? parseFloat(act.pricePerShare.toString()) : null,
        netAmount: parseFloat(act.amount.toString()) - (act.fees ? parseFloat(act.fees.toString()) : 0),
      });
    }

    // Snap off-market-day events to nearest preceding chart date
    const chartDateList = points.map((p) => p.date).sort();
    const chartDateSet = new Set(chartDateList);
    const eventsByChartDate = new Map<string, EventRecord[]>();

    for (const [eventDate, events] of rawEventsByDate) {
      let snapDate: string | undefined;
      if (chartDateSet.has(eventDate)) {
        snapDate = eventDate;
      } else {
        for (const d of chartDateList) {
          if (d <= eventDate) snapDate = d;
          else break;
        }
      }
      if (!snapDate) continue; // event predates entire chart range
      if (!eventsByChartDate.has(snapDate)) eventsByChartDate.set(snapDate, []);
      eventsByChartDate.get(snapDate)!.push(...events);
    }

    for (const point of points) {
      const events = eventsByChartDate.get(point.date);
      if (events?.length) point.events = events;
    }

    res.json({ points });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to compute growth data" } });
  }
});

// ── POST /api/investments/qfx-dividends/:accountId ───────────────────────
// Creates InvestmentActivity (DIVIDEND) + Income records from QFX INCOME
// entries for a managed account. Uses a two-layer dedup strategy:
//   1. FITID check: activity notes field stores "QFX:{fitId}" — prevents
//      re-importing the same dividend from an overlapping QFX file.
//   2. Date proximity check: skips any dividend where a DIVIDEND activity
//      already exists for the same ticker within ±5 days — prevents creating
//      duplicates against records already confirmed via the Tiingo scan.

const qfxDividendSchema = z.object({
  fitId: z.string().min(1),
  ticker: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total: z.number().positive(),
});

const qfxDividendsSchema = z.object({
  dividends: z.array(qfxDividendSchema),
});

investmentRoutes.post("/qfx-dividends/:accountId", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const account = await prisma.account.findFirst({
      where: { id: accountId, isActive: true, type: "INVESTMENT", isManaged: true, userId },
    });
    if (!account) {
      return res.status(404).json({ error: { message: "Managed investment account not found" } });
    }

    const { dividends } = qfxDividendsSchema.parse(req.body);

    // Build ticker → holdingId map (null is valid — e.g. TIMXX has no holding row)
    const holdings = await prisma.investmentHolding.findMany({
      where: { accountId },
      select: { id: true, ticker: true },
    });
    const holdingByTicker = new Map(holdings.map((h) => [h.ticker, h.id]));

    let imported = 0;
    let skipped = 0;

    for (const div of dividends) {
      const paymentDate = new Date(div.date);
      const fiveDays = 5 * 24 * 60 * 60 * 1000;

      // Layer 1: FITID check — was this exact QFX record already imported?
      const fitIdNote = `QFX:${div.fitId}`;
      const byFitId = await prisma.investmentActivity.findFirst({
        where: { accountId, ticker: div.ticker, type: "DIVIDEND", notes: fitIdNote },
      });
      if (byFitId) { skipped++; continue; }

      // Layer 2: date proximity check — does a DIVIDEND record already exist
      // within ±5 days for this ticker (catches Tiingo-confirmed records)?
      const byDate = await prisma.investmentActivity.findFirst({
        where: {
          accountId,
          ticker: div.ticker,
          type: "DIVIDEND",
          date: {
            gte: new Date(paymentDate.getTime() - fiveDays),
            lte: new Date(paymentDate.getTime() + fiveDays),
          },
        },
      });
      if (byDate) { skipped++; continue; }

      const holdingId = holdingByTicker.get(div.ticker) ?? null;

      await prisma.$transaction(async (tx) => {
        const activity = await tx.investmentActivity.create({
          data: {
            accountId,
            holdingId,
            ticker: div.ticker,
            type: "DIVIDEND",
            date: paymentDate,
            amount: div.total,
            notes: fitIdNote,
            updatedAt: new Date(),
          },
        });
        await tx.income.create({
          data: {
            accountId,
            amount: div.total,
            date: paymentDate,
            source: div.ticker,
            subtype: "DIVIDEND",
            isCashReceived: holdingId !== null,
            activityId: activity.id,
            updatedAt: new Date(),
          },
        });
      });

      imported++;
    }

    res.json({ imported, skipped });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    }
    console.error(err);
    res.status(500).json({ error: { message: "Failed to import QFX dividends" } });
  }
});

// ── Manual Investments CRUD ────────────────────────────────────────────────
// Non-public / private securities stored as a single market-value entry
// (no lots, no ticker lookup).

function serializeManual(m: {
  id: string; accountId: string; name: string; assetClass: string | null;
  totalCost: any; marketValue: any; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: m.id,
    accountId: m.accountId,
    name: m.name,
    group: m.assetClass ?? null,
    totalCost: m.totalCost != null ? parseFloat(m.totalCost.toString()) : null,
    marketValue: parseFloat(m.marketValue.toString()),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

const createManualSchema = z.object({
  accountId: z.string(),
  name: z.string().min(1).max(200),
  group: z.string().max(100).nullable().optional(),
  totalCost: z.number().nonnegative().nullable().optional(),
  marketValue: z.number().nonnegative(),
});

const updateManualSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  group: z.string().max(100).nullable().optional(),
  totalCost: z.number().nonnegative().nullable().optional(),
  marketValue: z.number().nonnegative().optional(),
});

// GET /api/investments/manual/:accountId
investmentRoutes.get("/manual/:accountId", async (req, res) => {
  try {
    const userId = getUserId(req);
    const account = await prisma.account.findFirst({
      where: { id: req.params.accountId, userId },
    });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    const entries = await prisma.manualInvestment.findMany({
      where: { accountId: req.params.accountId },
      orderBy: { createdAt: "asc" },
    });
    res.json(entries.map(serializeManual));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch manual investments" } });
  }
});

// POST /api/investments/manual
investmentRoutes.post("/manual", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = createManualSchema.parse(req.body);
    const account = await prisma.account.findFirst({
      where: { id: body.accountId, isActive: true, type: "INVESTMENT", userId },
    });
    if (!account)
      return res.status(404).json({ error: { message: "Investment account not found" } });
    const entry = await prisma.manualInvestment.create({
      data: {
        accountId: body.accountId,
        name: body.name,
        assetClass: body.group ?? null,
        totalCost: body.totalCost ?? null,
        marketValue: body.marketValue,
      },
    });
    res.status(201).json(serializeManual(entry));
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to create manual investment" } });
  }
});

// PUT /api/investments/manual/:id
investmentRoutes.put("/manual/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = updateManualSchema.parse(req.body);

    const existing = await prisma.manualInvestment.findFirst({
      where: { id: req.params.id, account: { userId } },
    });
    if (!existing) return res.status(404).json({ error: { message: "Manual investment not found" } });

    const entry = await prisma.manualInvestment.update({
      where: { id: req.params.id },
      data: {
        name: body.name,
        assetClass: body.group,
        totalCost: body.totalCost,
        marketValue: body.marketValue,
      },
    });
    res.json(serializeManual(entry));
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    const e = err as any;
    if (e?.code === "P2025")
      return res.status(404).json({ error: { message: "Manual investment not found" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update manual investment" } });
  }
});

// DELETE /api/investments/manual/:id
investmentRoutes.delete("/manual/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const manual = await prisma.manualInvestment.findFirst({
      where: { id: req.params.id, account: { userId } },
      select: { instrumentId: true },
    });
    if (!manual) return res.status(404).json({ error: { message: "Manual investment not found" } });

    await prisma.$transaction(async (tx) => {
      await tx.manualInvestment.delete({ where: { id: req.params.id } });
      await deactivateIfOrphaned(tx, manual?.instrumentId);
    });
    res.json({ success: true });
  } catch (err) {
    const e = err as any;
    if (e?.code === "P2025")
      return res.status(404).json({ error: { message: "Manual investment not found" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete manual investment" } });
  }
});

// ── GET /api/investments/activity/:accountId ───────────────────────────────
// Returns all investment activity events for an account (sales, dividends)

function serializeActivity(a: any) {
  return {
    id: a.id,
    accountId: a.accountId,
    holdingId: a.holdingId,
    ticker: a.ticker,
    type: a.type,
    date: a.date,
    shares: a.shares != null ? parseFloat(a.shares.toString()) : null,
    pricePerShare: a.pricePerShare != null ? parseFloat(a.pricePerShare.toString()) : null,
    amount: parseFloat(a.amount.toString()),
    fees: a.fees != null ? parseFloat(a.fees.toString()) : null,
    costBasis: a.costBasis != null ? parseFloat(a.costBasis.toString()) : null,
    shortTermGain: a.shortTermGain != null ? parseFloat(a.shortTermGain.toString()) : null,
    longTermGain: a.longTermGain != null ? parseFloat(a.longTermGain.toString()) : null,
    notes: a.notes,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

// PATCH /api/investments/activity/:id — correct pricePerShare and/or fees on a SALE activity.
// All other fields (shares, date, cost basis) are locked because the original lot breakdown is
// no longer available after the sale commits, making an exact re-computation impossible.
const patchSaleActivitySchema = z.object({
  pricePerShare: z.number().positive(),
  fees: z.number().nonnegative().optional(),
});

investmentRoutes.patch("/activity/:id", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;
    const body = patchSaleActivitySchema.parse(req.body);

    const activity = await prisma.investmentActivity.findFirst({
      where: { id, account: { userId } },
      include: { incomes: true },
    });
    if (!activity) return res.status(404).json({ error: { message: "Activity not found" } });
    if (activity.type !== "SALE")
      return res.status(400).json({ error: { message: "Only SALE activities can be edited" } });
    if (activity.shares == null)
      return res.status(400).json({ error: { message: "Activity is missing share count" } });

    const shares = parseFloat(activity.shares.toString());
    const costBasis = activity.costBasis != null ? parseFloat(activity.costBasis.toString()) : 0;
    const oldStGain = activity.shortTermGain != null ? parseFloat(activity.shortTermGain.toString()) : 0;
    const oldLtGain = activity.longTermGain != null ? parseFloat(activity.longTermGain.toString()) : 0;

    const newFees = body.fees ?? 0;
    const newGrossProceeds = Math.round(shares * body.pricePerShare * 100) / 100;
    const newNetProceeds = Math.round((newGrossProceeds - newFees) * 100) / 100;
    const newTotalGain = Math.round((newNetProceeds - costBasis) * 100) / 100;

    // Split newTotalGain into ST/LT using the same proportion as the original sale.
    // The per-lot share breakdown is not stored, so this proportional approach is the
    // best approximation available. For small price/fee corrections it is effectively exact.
    const oldTotalGain = oldStGain + oldLtGain;
    let newStGain: number;
    let newLtGain: number;
    if (Math.abs(oldTotalGain) < 0.005) {
      // Original was break-even — assign entirely to short-term as a safe default
      newStGain = newTotalGain;
      newLtGain = 0;
    } else {
      newStGain = Math.round((newTotalGain * (oldStGain / oldTotalGain)) * 100) / 100;
      newLtGain = Math.round((newTotalGain - newStGain) * 100) / 100;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const act = await tx.investmentActivity.update({
        where: { id },
        data: {
          pricePerShare: body.pricePerShare,
          amount: newGrossProceeds,
          fees: newFees > 0 ? newFees : null,
          shortTermGain: newStGain,
          longTermGain: newLtGain,
          updatedAt: new Date(),
        },
      });

      // Keep linked Income records in sync (typically exactly one per SALE)
      for (const income of activity.incomes) {
        await tx.income.update({
          where: { id: income.id },
          data: {
            amount: newNetProceeds,
            taxableAmount: newTotalGain,
            updatedAt: new Date(),
          },
        });
      }

      return act;
    });

    res.json(serializeActivity(updated));
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to update activity" } });
  }
});

investmentRoutes.get("/activity/:accountId", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const account = await prisma.account.findFirst({ where: { id: accountId, userId } });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    const activities = await prisma.investmentActivity.findMany({
      where: { accountId },
      orderBy: { date: "desc" },
    });

    res.json(activities.map(serializeActivity));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch investment activity" } });
  }
});

// ── Shared sell logic ──────────────────────────────────────────────────────

const sellInputSchema = z.object({
  holdingId: z.string(),
  sharesToSell: z.number().positive(),
  pricePerShare: z.number().positive(),
  saleDate: z.string().transform((s) => new Date(s)),
  fees: z.number().nonnegative().default(0),
  // Either costBasisMethod OR lotAllocations must be provided (validated in handler)
  costBasisMethod: z.enum(["FIFO", "LIFO", "MIN_TAX", "MAX_GAIN"]).optional(),
  lotAllocations: z.array(z.object({
    lotId: z.string(),
    shares: z.number().positive(),
  })).optional(),
});

interface LotAllocation {
  lotId: string;
  acquiredDate: Date | null;
  shares: number;
  costPerShare: number;
  termType: "SHORT" | "LONG";
  proceeds: number;
  costBasis: number;
  gain: number;
}

interface SellCalculation {
  lotBreakdown: LotAllocation[];
  grossProceeds: number;
  fees: number;
  netProceeds: number;
  totalCostBasis: number;
  stShares: number;
  ltShares: number;
  stGain: number;
  ltGain: number;
  totalGain: number;
}

function computeSell(
  lots: { id: string; quantity: any; costPerShare: any; acquiredDate: Date | null }[],
  sharesToSell: number,
  pricePerShare: number,
  saleDate: Date,
  fees: number,
  costBasisMethod: "FIFO" | "LIFO" | "MIN_TAX" | "MAX_GAIN" | undefined,
  lotAllocations?: { lotId: string; shares: number }[]
): SellCalculation {
  const oneYearBeforeSale = new Date(
    saleDate.getFullYear() - 1,
    saleDate.getMonth(),
    saleDate.getDate()
  );

  // Build the ordered list of (lot, sharesFromLot) pairs
  type LotShare = { lot: typeof lots[0]; shares: number };
  let orderedAllocations: LotShare[];

  if (lotAllocations) {
    // Lot-level selection: use caller-specified allocations directly
    const lotMap = new Map(lots.map((l) => [l.id, l]));
    orderedAllocations = lotAllocations
      .filter((a) => a.shares > 0 && lotMap.has(a.lotId))
      .map((a) => ({ lot: lotMap.get(a.lotId)!, shares: a.shares }));
  } else {
    // Method-based: sort lots, then allocate greedily
    const sorted = [...lots].sort((a, b) => {
      const aCps = parseFloat(a.costPerShare.toString());
      const bCps = parseFloat(b.costPerShare.toString());
      switch (costBasisMethod) {
        case "FIFO": return (a.acquiredDate?.getTime() ?? Infinity) - (b.acquiredDate?.getTime() ?? Infinity);
        case "LIFO": return (b.acquiredDate?.getTime() ?? -Infinity) - (a.acquiredDate?.getTime() ?? -Infinity);
        case "MIN_TAX": return bCps - aCps;
        case "MAX_GAIN": return aCps - bCps;
        default: return 0;
      }
    });
    orderedAllocations = [];
    let remaining = sharesToSell;
    for (const lot of sorted) {
      if (remaining <= 0) break;
      const shares = Math.min(parseFloat(lot.quantity.toString()), remaining);
      orderedAllocations.push({ lot, shares });
      remaining -= shares;
    }
  }

  const lotBreakdown: LotAllocation[] = [];
  let stShares = 0;
  let ltShares = 0;
  let stCostBasis = 0;
  let ltCostBasis = 0;

  for (const { lot, shares } of orderedAllocations) {
    const lotCps = parseFloat(lot.costPerShare.toString());
    const isLongTerm = lot.acquiredDate != null && lot.acquiredDate <= oneYearBeforeSale;
    const lotProceeds = shares * pricePerShare;
    const lotCostBasis = shares * lotCps;
    const lotGain = lotProceeds - lotCostBasis;

    lotBreakdown.push({
      lotId: lot.id,
      acquiredDate: lot.acquiredDate,
      shares,
      costPerShare: lotCps,
      termType: isLongTerm ? "LONG" : "SHORT",
      proceeds: lotProceeds,
      costBasis: lotCostBasis,
      gain: lotGain,
    });

    if (isLongTerm) {
      ltShares += shares;
      ltCostBasis += lotCostBasis;
    } else {
      stShares += shares;
      stCostBasis += lotCostBasis;
    }
  }

  const totalSoldShares = lotAllocations
    ? orderedAllocations.reduce((s, a) => s + a.shares, 0)
    : sharesToSell;
  const grossProceeds = totalSoldShares * pricePerShare;
  const netProceeds = grossProceeds - fees;
  const totalCostBasis = stCostBasis + ltCostBasis;

  const stFees = totalSoldShares > 0 ? fees * (stShares / totalSoldShares) : 0;
  const ltFees = fees - stFees;
  const stGain = stShares > 0
    ? (stShares / totalSoldShares) * grossProceeds - stCostBasis - stFees
    : 0;
  const ltGain = ltShares > 0
    ? (ltShares / totalSoldShares) * grossProceeds - ltCostBasis - ltFees
    : 0;
  const totalGain = stGain + ltGain;

  return {
    lotBreakdown,
    grossProceeds,
    fees,
    netProceeds,
    totalCostBasis,
    stShares,
    ltShares,
    stGain,
    ltGain,
    totalGain,
  };
}

// ── POST /api/investments/sell/preview ────────────────────────────────────
// Computes the lot breakdown for a proposed sale without writing anything

investmentRoutes.post("/sell/preview", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = sellInputSchema.parse(req.body);
    if (!body.costBasisMethod && !body.lotAllocations) {
      return res.status(400).json({ error: { message: "Either costBasisMethod or lotAllocations must be provided" } });
    }

    const holding = await prisma.investmentHolding.findFirst({
      where: { id: body.holdingId, account: { userId } },
      include: { lots: true },
    });
    if (!holding) return res.status(404).json({ error: { message: "Holding not found" } });

    // Only lots acquired on or before the sale date are eligible
    const eligibleLots = holding.lots.filter(
      (l) => l.acquiredDate == null || l.acquiredDate <= body.saleDate
    );

    if (body.lotAllocations) {
      const eligibleIds = new Set(eligibleLots.map((l) => l.id));
      if (body.lotAllocations.some((a) => !eligibleIds.has(a.lotId))) {
        return res.status(400).json({
          error: { message: "One or more selected lots were purchased after the sale date and cannot be included in this sale." },
        });
      }
    }

    const totalQty = eligibleLots.reduce(
      (sum, l) => sum + parseFloat(l.quantity.toString()),
      0
    );
    const sharesToSell = body.lotAllocations
      ? body.lotAllocations.reduce((s, a) => s + a.shares, 0)
      : body.sharesToSell;
    if (sharesToSell > totalQty + 0.000001) {
      return res.status(400).json({
        error: { message: `Cannot sell ${sharesToSell} shares; only ${totalQty} available from lots acquired on or before the sale date` },
      });
    }

    const calc = computeSell(
      eligibleLots,
      sharesToSell,
      body.pricePerShare,
      body.saleDate,
      body.fees,
      body.costBasisMethod,
      body.lotAllocations
    );

    res.json({
      lotBreakdown: calc.lotBreakdown.map((l) => ({
        ...l,
        acquiredDate: l.acquiredDate?.toISOString() ?? null,
      })),
      grossProceeds: Math.round(calc.grossProceeds * 100) / 100,
      fees: Math.round(calc.fees * 100) / 100,
      netProceeds: Math.round(calc.netProceeds * 100) / 100,
      stShares: calc.stShares,
      ltShares: calc.ltShares,
      stGain: Math.round(calc.stGain * 100) / 100,
      ltGain: Math.round(calc.ltGain * 100) / 100,
      totalGain: Math.round(calc.totalGain * 100) / 100,
    });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to compute sell preview" } });
  }
});

// ── POST /api/investments/sell ────────────────────────────────────────────
// Commits a sale: reduces lots, creates InvestmentActivity, creates Income record

const sellCommitSchema = sellInputSchema.extend({
  destinationAccountId: z.string(),
  notes: z.string().optional(),
});

investmentRoutes.post("/sell", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = sellCommitSchema.parse(req.body);
    if (!body.costBasisMethod && !body.lotAllocations) {
      return res.status(400).json({ error: { message: "Either costBasisMethod or lotAllocations must be provided" } });
    }

    // Validate holding exists
    const holding = await prisma.investmentHolding.findFirst({
      where: { id: body.holdingId, account: { userId } },
      include: { lots: true, account: { select: { isTaxAdvantaged: true } } },
    });
    if (!holding) return res.status(404).json({ error: { message: "Holding not found" } });

    // Validate destination account
    const destAccount = await prisma.account.findFirst({
      where: { id: body.destinationAccountId, userId },
    });
    if (!destAccount)
      return res.status(404).json({ error: { message: "Destination account not found" } });
    if (destAccount.type === "CREDIT_CARD")
      return res.status(400).json({ error: { message: "Destination account cannot be a credit card" } });

    // Only lots acquired on or before the sale date are eligible
    const eligibleLots = holding.lots.filter(
      (l) => l.acquiredDate == null || l.acquiredDate <= body.saleDate
    );

    if (body.lotAllocations) {
      const eligibleIds = new Set(eligibleLots.map((l) => l.id));
      if (body.lotAllocations.some((a) => !eligibleIds.has(a.lotId))) {
        return res.status(400).json({
          error: { message: "One or more selected lots were purchased after the sale date and cannot be included in this sale." },
        });
      }
    }

    const sharesToSell = body.lotAllocations
      ? body.lotAllocations.reduce((s, a) => s + a.shares, 0)
      : body.sharesToSell;
    const totalQty = eligibleLots.reduce(
      (sum, l) => sum + parseFloat(l.quantity.toString()),
      0
    );
    if (sharesToSell > totalQty + 0.000001) {
      return res.status(400).json({
        error: { message: `Cannot sell ${sharesToSell} shares; only ${totalQty} available from lots acquired on or before the sale date` },
      });
    }

    // Compute lot breakdown (re-computed server-side, never trust client preview)
    const calc = computeSell(
      eligibleLots,
      sharesToSell,
      body.pricePerShare,
      body.saleDate,
      body.fees,
      body.costBasisMethod,
      body.lotAllocations
    );

    const grossProceeds = Math.round(calc.grossProceeds * 100) / 100;
    const netProceeds = Math.round(calc.netProceeds * 100) / 100;
    const stGain = Math.round(calc.stGain * 100) / 100;
    const ltGain = Math.round(calc.ltGain * 100) / 100;
    const totalGain = stGain + ltGain; // avoid drift: sum after rounding
    const feesStored = body.fees > 0 ? Math.round(body.fees * 100) / 100 : null;

    // Build lot mutation maps
    const lotSharesMap = new Map<string, number>();
    for (const alloc of calc.lotBreakdown) {
      lotSharesMap.set(alloc.lotId, alloc.shares);
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Mutate lots
      const holdingLots = await tx.investmentLot.findMany({ where: { holdingId: holding.id } });
      for (const lot of holdingLots) {
        const soldShares = lotSharesMap.get(lot.id) ?? 0;
        if (soldShares === 0) continue;
        const remaining = parseFloat(lot.quantity.toString()) - soldShares;
        if (remaining < 0.000001) {
          await tx.investmentLot.delete({ where: { id: lot.id } });
        } else {
          await tx.investmentLot.update({
            where: { id: lot.id },
            data: { quantity: remaining },
          });
        }
      }

      // 2. Check if holding is now empty; delete if so
      const remainingLots = await tx.investmentLot.count({ where: { holdingId: holding.id } });
      const holdingDeleted = remainingLots === 0;
      if (holdingDeleted) {
        await tx.investmentHolding.delete({ where: { id: holding.id } });
        await deactivateIfOrphaned(tx, holding.instrumentId);
      }

      // 3. Create InvestmentActivity (holdingId set to null if holding was deleted)
      const activity = await tx.investmentActivity.create({
        data: {
          accountId: holding.accountId,
          holdingId: holdingDeleted ? null : holding.id,
          ticker: holding.ticker,
          type: "SALE",
          date: body.saleDate,
          shares: sharesToSell,
          pricePerShare: body.pricePerShare,
          amount: grossProceeds,
          fees: feesStored,
          costBasis: Math.round(calc.totalCostBasis * 100) / 100,
          shortTermGain: stGain,
          longTermGain: ltGain,
          notes: body.notes ?? null,
          updatedAt: new Date(),
        },
      });

      // 4. Create Income record only for taxable accounts
      let income = null;
      if (!holding.account.isTaxAdvantaged) {
        income = await tx.income.create({
          data: {
            amount: netProceeds,
            subtype: "CAPITAL_GAIN",
            taxClassification: "CAPITAL_GAIN",
            taxableAmount: totalGain,
            source: holding.ticker,
            date: body.saleDate,
            accountId: body.destinationAccountId,
            activityId: activity.id,
            notes: body.notes ?? null,
            updatedAt: new Date(),
          },
          include: {
            account: true,
            category: true,
            tags: { include: { tag: true } },
            transactionGroup: true,
            activity: true,
          },
        });
      }

      return { activity: serializeActivity(activity), income, holdingDeleted };
    });

    // Fetch updated holding (if not deleted)
    let updatedHolding = null;
    if (!result.holdingDeleted) {
      const h = await prisma.investmentHolding.findUnique({
        where: { id: holding.id },
        include: { lots: true },
      });
      if (h) {
        // Fetch current price for gain computation
        const tp = await prisma.tickerPrice.findUnique({ where: { ticker: h.ticker } });
        const price = tp ? parseFloat(tp.price.toString()) : null;
        const computed = computeHoldingFields(h.lots, price);
        updatedHolding = {
          id: h.id,
          accountId: h.accountId,
          ticker: h.ticker,
          name: h.name,
          type: h.type,
          currentPrice: price,
          priceDate: tp?.priceDate ?? null,
          priceUpdatedAt: tp?.updatedAt ?? null,
          lots: h.lots.map((l) => ({
            id: l.id,
            holdingId: l.holdingId,
            quantity: l.quantity.toString(),
            costPerShare: l.costPerShare.toString(),
            acquiredDate: l.acquiredDate ? l.acquiredDate.toISOString() : null,
          })),
          ...computed,
        };
      }
    }

    res.json({
      activity: result.activity,
      income: result.income,
      holding: updatedHolding,
    });
  } catch (err) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to record sale" } });
  }
});

// ── POST /api/investments/transfer ───────────────────────────────────────────
// Moves investment lots from one account to another, preserving cost basis and
// acquisition dates. No taxable event — no gain/loss is recorded.
//
// If the destination account already holds the same ticker, the transferred lots
// are added to the existing holding. If the source holding becomes empty after
// the transfer, it is deleted (sale history on InvestmentActivity is preserved
// since those records carry their own accountId).
//
// Both accounts receive a TRANSFER InvestmentActivity record with transferAccountId
// pointing to the other side for display purposes.

const transferSchema = z.object({
  holdingId: z.string(),
  destinationAccountId: z.string(),
  // Either sharesToTransfer + costBasisMethod OR lotAllocations (validated below)
  sharesToTransfer: z.number().positive().optional(),
  costBasisMethod: z.enum(["FIFO", "LIFO", "MIN_TAX", "MAX_GAIN"]).optional(),
  lotAllocations: z
    .array(z.object({ lotId: z.string(), shares: z.number().positive() }))
    .optional(),
  transferDate: z.string().transform((s) => new Date(s)),
  notes: z.string().optional(),
});

investmentRoutes.post("/transfer", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = transferSchema.parse(req.body);

    const hasMethod = !!body.costBasisMethod;
    const hasAllocations = !!body.lotAllocations?.length;
    if (!hasMethod && !hasAllocations) {
      return res.status(400).json({
        error: { message: "Either costBasisMethod or lotAllocations must be provided" },
      });
    }
    if (hasMethod && !body.sharesToTransfer) {
      return res.status(400).json({
        error: { message: "sharesToTransfer is required when using costBasisMethod" },
      });
    }

    const holding = await prisma.investmentHolding.findFirst({
      where: { id: body.holdingId, account: { userId } },
      include: { lots: true, account: { select: { isTaxAdvantaged: true } } },
    });
    if (!holding) return res.status(404).json({ error: { message: "Holding not found" } });

    const destAccount = await prisma.account.findFirst({
      where: { id: body.destinationAccountId, userId },
    });
    if (!destAccount)
      return res.status(404).json({ error: { message: "Destination account not found" } });
    if (destAccount.type !== "INVESTMENT")
      return res.status(400).json({ error: { message: "Destination account must be an investment account" } });
    if (destAccount.id === holding.accountId)
      return res.status(400).json({ error: { message: "Source and destination accounts must be different" } });

    // Determine which lots to transfer and how many shares from each
    type LotShare = { lotId: string; shares: number; costPerShare: number; acquiredDate: Date | null };
    let lotAllocations: LotShare[];

    if (body.lotAllocations) {
      const lotMap = new Map(holding.lots.map((l) => [l.id, l]));
      const invalid = body.lotAllocations.find((a) => !lotMap.has(a.lotId));
      if (invalid)
        return res.status(400).json({ error: { message: "One or more lot IDs do not belong to this holding" } });
      lotAllocations = body.lotAllocations.map((a) => {
        const lot = lotMap.get(a.lotId)!;
        const available = parseFloat(lot.quantity.toString());
        if (a.shares > available + 0.000001)
          throw Object.assign(new Error(`Lot ${a.lotId}: cannot transfer ${a.shares} shares, only ${available} available`), { status: 400 });
        return { lotId: lot.id, shares: a.shares, costPerShare: parseFloat(lot.costPerShare.toString()), acquiredDate: lot.acquiredDate };
      });
    } else {
      const sharesToTransfer = body.sharesToTransfer!;
      const totalQty = holding.lots.reduce((s, l) => s + parseFloat(l.quantity.toString()), 0);
      if (sharesToTransfer > totalQty + 0.000001)
        return res.status(400).json({ error: { message: `Cannot transfer ${sharesToTransfer} shares; only ${totalQty} available` } });

      const sorted = [...holding.lots].sort((a, b) => {
        const aCps = parseFloat(a.costPerShare.toString());
        const bCps = parseFloat(b.costPerShare.toString());
        switch (body.costBasisMethod) {
          case "FIFO":    return (a.acquiredDate?.getTime() ?? Infinity) - (b.acquiredDate?.getTime() ?? Infinity);
          case "LIFO":    return (b.acquiredDate?.getTime() ?? -Infinity) - (a.acquiredDate?.getTime() ?? -Infinity);
          case "MIN_TAX": return bCps - aCps;
          case "MAX_GAIN": return aCps - bCps;
          default:        return 0;
        }
      });

      lotAllocations = [];
      let remaining = sharesToTransfer;
      for (const lot of sorted) {
        if (remaining <= 0.000001) break;
        const shares = Math.min(parseFloat(lot.quantity.toString()), remaining);
        lotAllocations.push({ lotId: lot.id, shares, costPerShare: parseFloat(lot.costPerShare.toString()), acquiredDate: lot.acquiredDate });
        remaining -= shares;
      }
    }

    const totalTransferredShares = lotAllocations.reduce((s, a) => s + a.shares, 0);
    const totalTransferredCostBasis = Math.round(
      lotAllocations.reduce((s, a) => s + a.shares * a.costPerShare, 0) * 100
    ) / 100;

    // Resolve instrument before opening the transaction — this may hit the network
    // (Yahoo Finance lookup) and would time out the 5 s interactive transaction.
    const instrumentId = await resolveInstrumentId(holding.ticker, holding.name);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Reduce or delete source lots
      for (const alloc of lotAllocations) {
        const lot = holding.lots.find((l) => l.id === alloc.lotId)!;
        const remaining = parseFloat(lot.quantity.toString()) - alloc.shares;
        if (remaining < 0.000001) {
          await tx.investmentLot.delete({ where: { id: alloc.lotId } });
        } else {
          await tx.investmentLot.update({ where: { id: alloc.lotId }, data: { quantity: remaining } });
        }
      }

      // 2. Delete source holding if now empty
      const remainingLots = await tx.investmentLot.count({ where: { holdingId: holding.id } });
      const sourceHoldingDeleted = remainingLots === 0;
      if (sourceHoldingDeleted) {
        await tx.investmentHolding.delete({ where: { id: holding.id } });
        await deactivateIfOrphaned(tx, holding.instrumentId);
      }

      // 3. Upsert destination holding (create if ticker not yet held there)
      let destHolding = await tx.investmentHolding.findUnique({
        where: { accountId_ticker: { accountId: body.destinationAccountId, ticker: holding.ticker } },
      });
      if (!destHolding) {
        destHolding = await tx.investmentHolding.create({
          data: {
            accountId: body.destinationAccountId,
            ticker: holding.ticker,
            name: holding.name,
            type: holding.type,
            assetClass: holding.assetClass,
            instrumentId,
          },
        });
      }

      // 4. Create destination lots with original cost basis and acquisition dates
      for (const alloc of lotAllocations) {
        await tx.investmentLot.create({
          data: {
            holdingId: destHolding.id,
            quantity: alloc.shares,
            costPerShare: alloc.costPerShare,
            acquiredDate: alloc.acquiredDate,
          },
        });
      }

      // 5. Record TRANSFER activity on source account
      const sourceActivity = await tx.investmentActivity.create({
        data: {
          accountId: holding.accountId,
          holdingId: sourceHoldingDeleted ? null : holding.id,
          ticker: holding.ticker,
          type: "TRANSFER",
          date: body.transferDate,
          shares: totalTransferredShares,
          amount: totalTransferredCostBasis,
          costBasis: totalTransferredCostBasis,
          transferAccountId: body.destinationAccountId,
          notes: body.notes ?? null,
          updatedAt: new Date(),
        },
      });

      // 6. Record TRANSFER activity on destination account
      const destActivity = await tx.investmentActivity.create({
        data: {
          accountId: body.destinationAccountId,
          holdingId: destHolding.id,
          ticker: holding.ticker,
          type: "TRANSFER",
          date: body.transferDate,
          shares: totalTransferredShares,
          amount: totalTransferredCostBasis,
          costBasis: totalTransferredCostBasis,
          transferAccountId: holding.accountId,
          notes: body.notes ?? null,
          updatedAt: new Date(),
        },
      });

      return { sourceActivity, destActivity, sourceHoldingDeleted, destHoldingId: destHolding.id };
    });

    // Fetch updated holdings for the response
    const [updatedSource, updatedDest] = await Promise.all([
      result.sourceHoldingDeleted
        ? Promise.resolve(null)
        : prisma.investmentHolding.findUnique({ where: { id: holding.id }, include: { lots: true } }),
      prisma.investmentHolding.findUnique({ where: { id: result.destHoldingId }, include: { lots: true } }),
    ]);

    function serializeHoldingWithPrice(h: any, price: number | null, priceDate: any, priceUpdatedAt: any) {
      if (!h) return null;
      return {
        id: h.id,
        accountId: h.accountId,
        ticker: h.ticker,
        name: h.name,
        type: h.type,
        currentPrice: price,
        priceDate: priceDate ?? null,
        priceUpdatedAt: priceUpdatedAt ?? null,
        lots: h.lots.map((l: any) => ({
          id: l.id,
          holdingId: l.holdingId,
          quantity: l.quantity.toString(),
          costPerShare: l.costPerShare.toString(),
          acquiredDate: l.acquiredDate ? l.acquiredDate.toISOString() : null,
        })),
        ...computeHoldingFields(h.lots, price),
      };
    }

    const tp = await prisma.tickerPrice.findUnique({ where: { ticker: holding.ticker } });
    const price = tp ? parseFloat(tp.price.toString()) : null;

    res.json({
      sourceActivity: serializeActivity(result.sourceActivity),
      destActivity: serializeActivity(result.destActivity),
      sourceHolding: serializeHoldingWithPrice(updatedSource, price, tp?.priceDate, tp?.updatedAt),
      destHolding: serializeHoldingWithPrice(updatedDest, price, tp?.priceDate, tp?.updatedAt),
    });
  } catch (err: any) {
    if (err instanceof z.ZodError)
      return res.status(400).json({ error: { message: err.errors[0]?.message } });
    if (err.status === 400)
      return res.status(400).json({ error: { message: err.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to transfer holding" } });
  }
});

// ── Realized Gain Snapshots ────────────────────────────────────────────────
// Stores YTD realized gain/loss totals pasted in from a robo-advisor dashboard.
// One row per account per year; GET returns the snapshot for the requested year
// (defaults to current year), PUT upserts it.

function serializeSnapshot(s: any) {
  return {
    id: s.id,
    accountId: s.accountId,
    year: s.year,
    longTermGain: s.longTermGain != null ? parseFloat(s.longTermGain.toString()) : null,
    shortTermGain: s.shortTermGain != null ? parseFloat(s.shortTermGain.toString()) : null,
    longTermLoss: s.longTermLoss != null ? parseFloat(s.longTermLoss.toString()) : null,
    shortTermLoss: s.shortTermLoss != null ? parseFloat(s.shortTermLoss.toString()) : null,
    snapshotDate: s.snapshotDate,
    notes: s.notes,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// GET /api/investments/gain-snapshots?year=2026 — all snapshots for a given year
investmentRoutes.get("/gain-snapshots", async (req, res) => {
  try {
    const userId = getUserId(req);
    const year = req.query.year ? parseInt(req.query.year as string, 10) : new Date().getFullYear();
    const snapshots = await prisma.realizedGainSnapshot.findMany({
      where: { year, account: { userId } },
      include: { account: { select: { id: true, name: true, color: true } } },
      orderBy: { account: { name: "asc" } },
    });
    res.json(snapshots.map((s) => ({ ...serializeSnapshot(s), account: s.account })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch gain snapshots" } });
  }
});

// GET /api/investments/gain-snapshot/:accountId?year=2026
investmentRoutes.get("/gain-snapshot/:accountId", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { accountId } = req.params;
    const year = req.query.year ? parseInt(req.query.year as string, 10) : new Date().getFullYear();
    if (isNaN(year)) return res.status(400).json({ error: { message: "Invalid year" } });

    // Verify account ownership
    const account = await prisma.account.findFirst({ where: { id: accountId, userId } });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    const snapshot = await prisma.realizedGainSnapshot.findUnique({
      where: { accountId_year: { accountId, year } },
    });

    if (!snapshot) return res.json(null);
    res.json(serializeSnapshot(snapshot));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: "Failed to fetch gain snapshot" } });
  }
});

// PUT /api/investments/gain-snapshot — upsert for a given account+year
const upsertSnapshotSchema = z.object({
  accountId: z.string(),
  year: z.number().int().min(2000).max(2100),
  longTermGain: z.number().nullable().optional(),
  shortTermGain: z.number().nullable().optional(),
  longTermLoss: z.number().nonnegative().nullable().optional(),
  shortTermLoss: z.number().nonnegative().nullable().optional(),
  snapshotDate: z.string().transform((s) => new Date(s)),
  notes: z.string().max(500).nullable().optional(),
});

investmentRoutes.put("/gain-snapshot", async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = upsertSnapshotSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: body.accountId, isActive: true, userId },
    });
    if (!account) return res.status(404).json({ error: { message: "Account not found" } });

    const { accountId, year, ...fields } = body;

    const snapshot = await prisma.realizedGainSnapshot.upsert({
      where: { accountId_year: { accountId, year } },
      create: { id: `${accountId}_${year}`, accountId, year, ...fields },
      update: { ...fields, updatedAt: new Date() },
    });

    res.json(serializeSnapshot(snapshot));
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: { message: err.errors[0]?.message } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to save gain snapshot" } });
  }
});

// DELETE /api/investments/gain-snapshot/:accountId/:year
investmentRoutes.delete("/gain-snapshot/:accountId/:year", async (req, res) => {
  try {
    const userId = getUserId(req);
    const year = parseInt(req.params.year, 10);
    if (isNaN(year)) return res.status(400).json({ error: { message: "Invalid year" } });

    // Verify account ownership before deleting
    const account = await prisma.account.findFirst({ where: { id: req.params.accountId, userId } });
    if (!account) return res.status(404).json({ error: { message: "Snapshot not found" } });

    await prisma.realizedGainSnapshot.delete({
      where: { accountId_year: { accountId: req.params.accountId, year } },
    });
    res.status(204).send();
  } catch (err) {
    const e = err as any;
    if (e?.code === "P2025") return res.status(404).json({ error: { message: "Snapshot not found" } });
    console.error(err);
    res.status(500).json({ error: { message: "Failed to delete gain snapshot" } });
  }
});
