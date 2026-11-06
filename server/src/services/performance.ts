import { prisma } from "../db/client.js";
import { isTradingDay } from "../lib/marketHolidays.js";
import { effectiveLastTradingDay, isPinnedPrice, writeTickerHistory } from "../routes/investments.js";
import { fetchYahooHistory } from "./yahoo.js";
import { getMarketChart } from "./coingecko.js";
import { PERFORMANCE_HISTORY_START } from "../lib/performanceWindow.js";

// ── Portfolio performance attribution ───────────────────────────────────────────
// Rebuilds every investment account at week-end or month-end closes and explains
// each period's change:
//
//   Δvalue = Σ market change (per asset class, dividends included)
//          + deposits − withdrawals
//          − fees (advisory/account fees taken from cash)
//          + options premium held (earned in a brokerage, not yet transferred)
//          + unreconciled cash
//
// Buys and sells are internal: a holding's market change is its change in value
// net of the cash traded for it, and that cash is expected to show up in the
// account's settlement cash. Settlement cash is known only at dated observations
// (InvestmentCashBalance); between them it is rolled forward through recorded
// trades, income, and transfers, so whatever an observation shows that the
// records don't explain surfaces as "unreconciled" in the period it lands in,
// rather than being absorbed into a gain or loss.
//
// Options are out of scope; only their effect on shares and cash counts.
// Assignment buys are priced at strike × shares, not the premium-adjusted lot cost.

export type Cadence = "weekly" | "monthly";

/** History starts at the last close of 2025. */
const HISTORY_START = PERFORMANCE_HISTORY_START;
const UNTRACKED = "untracked";
const CASH_FALLBACK = "cash";
const EPS = 1e-6;

type Day = string; // YYYY-MM-DD

const dayOf = (d: Date): Day => d.toISOString().slice(0, 10);
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round2 = (n: number) => Math.round(n * 100) / 100;

function addDays(day: Day, n: number): Day {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayOf(d);
}

// ── Period calendar ─────────────────────────────────────────────────────────────

/** NYSE sessions from `from` through `to` inclusive. */
function tradingDays(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    // Midday UTC so the ET calendar day resolves to `d` itself.
    if (isTradingDay(Date.parse(`${d}T16:00:00Z`))) out.push(d);
  }
  return out;
}

function periodKey(day: Day, cadence: Cadence): string {
  if (cadence === "monthly") return day.slice(0, 7);
  // Week starting Monday.
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return addDays(day, -back);
}

/** Baseline close plus each period's closing session, oldest first. */
function periodEnds(cadence: Cadence, lastDay: Day): { baseline: Day; ends: Day[] } {
  const baseline = tradingDays(addDays(HISTORY_START, -10), addDays(HISTORY_START, -1)).pop()!;
  const days = tradingDays(HISTORY_START, lastDay);
  const ends: Day[] = [];
  for (let i = 0; i < days.length; i++) {
    const next = days[i + 1];
    if (!next || periodKey(next, cadence) !== periodKey(days[i], cadence)) ends.push(days[i]);
  }
  return { baseline, ends };
}

/** Last day valued: the latest settled session, or `today` if earlier. */
function lastValuedDay(today: Day): Day {
  const settled = dayOf(effectiveLastTradingDay());
  return settled < today ? settled : today;
}

/** Month-end closes that can be edited: the baseline close and each finished
 *  month's last session. The month `today` falls in is still open, so its
 *  values belong on the account pages, not here. */
export function editableMonthEnds(today: Day): Day[] {
  const { baseline, ends } = periodEnds("monthly", lastValuedDay(today));
  const open = today.slice(0, 7);
  return [baseline, ...ends].filter((d) => d.slice(0, 7) < open);
}

// ── Response shape ──────────────────────────────────────────────────────────────

export type ClassInfo = { key: string; name: string; color: string | null };

export type PeriodClass = {
  key: string;
  startValue: number;
  endValue: number;
  marketChange: number; // price change, net of trades
  income: number;       // dividends and interest
  holdings: Array<{ label: string; marketChange: number; income: number }>;
};

export type PerformancePeriod = {
  start: Day;
  end: Day;
  partial: boolean;
  startValue: number;
  endValue: number;
  classes: PeriodClass[];
  deposits: number;
  withdrawals: number; // positive number
  unreconciled: number;
  flows: Array<{ date: Day; account: string; amount: number; description: string }>;
  fees: number; // positive number
  feeItems: Array<{ date: Day; account: string; amount: number; description: string }>; // amount positive
  unreconciledByAccount: Array<{ account: string; amount: number }>;
  // Options premium is left out of the return and the flows: it is earned in the
  // brokerage on the close date and transferred to a bank later. What was earned
  // but not yet transferred at a close still sits in the brokerage's cash, so the
  // period's change in that amount is its own step (premium earned − transferred).
  optionsPremiumHeld: number;
  optionsPremiumItems: Array<{ date: Day; account: string; amount: number; description: string }>; // + earned, − transferred
};

/** One month-end value: what's recorded on that close, if anything, and what
 *  the records work out to without it (what deleting it would fall back to).
 *  `calculated` is null where there's nothing to value (a removed investment). */
export type MonthEndCell = { recorded: number | null; source: string | null; calculated: number | null };

export type MonthEndBalances = {
  months: Day[];
  accounts: Array<{
    id: string;
    name: string;
    cash: MonthEndCell[]; // aligned with months
    manual: Array<{ id: string; name: string; removedOn: Day | null; cells: MonthEndCell[] }>;
  }>;
};

export type PerformanceResult = {
  cadence: Cadence;
  baseline: Day;
  baselineValue: number;
  asOf: Day;
  classes: ClassInfo[];
  periods: PerformancePeriod[];
  notes: {
    estimatedPrices: string[];             // tickers valued from a neighbouring close
    inconsistentPositions: string[];       // "Account TICKER" whose records roll below zero
    negativeCash: Array<{ account: string; date: Day; amount: number }>; // lowest rolled cash below zero
    managedDataThrough: Array<{ account: string; date: Day | null }>;
    cashObservations: Array<{ account: string; count: number; first: Day | null }>;
  };
  balances?: MonthEndBalances; // only when asked for
};

// ── Engine ──────────────────────────────────────────────────────────────────────

export async function computePerformance(
  userId: string,
  cadence: Cadence,
  today: Day,
  opts: { balances?: boolean } = {},
): Promise<PerformanceResult> {
  const lastDay = lastValuedDay(today);
  const { baseline, ends } = periodEnds(cadence, lastDay);
  const valuationDays = [baseline, ...ends];

  // Every investment account, hidden and closed ones included: they count for
  // the periods they held value.
  const accounts = await prisma.account.findMany({
    where: { userId, type: "INVESTMENT" },
    select: { id: true, name: true, isManaged: true, cashBalance: true },
  });
  const accountIds = accounts.map((a) => a.id);
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const managedIds = new Set(accounts.filter((a) => a.isManaged).map((a) => a.id));

  const [
    holdings, activities, qfx, cashRows, manuals, valuations, pendingBuys,
    looseIncome, transfers, assetClasses,
  ] = await Promise.all([
    prisma.investmentHolding.findMany({
      where: { accountId: { in: accountIds } },
      select: {
        accountId: true, ticker: true, name: true, coinGeckoId: true, instrumentId: true,
        lots: { select: { quantity: true, acquiredDate: true } },
      },
    }),
    prisma.investmentActivity.findMany({
      where: { accountId: { in: accountIds }, type: { in: ["SALE", "PURCHASE", "DIVIDEND", "TRANSFER", "FEE"] } },
      select: {
        id: true, accountId: true, ticker: true, type: true, date: true, createdAt: true,
        shares: true, amount: true, fees: true, transferAccountId: true, notes: true,
        incomes: { select: { accountId: true, amount: true, isCashReceived: true, depositAccountId: true, depositDate: true } },
      },
    }),
    prisma.qfxTransaction.findMany({
      where: { accountId: { in: [...managedIds] } },
      select: { accountId: true, ticker: true, type: true, date: true, shares: true, total: true },
    }),
    prisma.investmentCashBalance.findMany({
      where: { accountId: { in: accountIds } },
      orderBy: { date: "asc" },
    }),
    prisma.manualInvestment.findMany({ where: { accountId: { in: accountIds } } }),
    prisma.manualInvestmentValuation.findMany({
      where: { accountId: { in: accountIds } },
      orderBy: { date: "asc" },
    }),
    prisma.pendingBuy.findMany({
      where: { accountId: { in: accountIds }, status: "CONFIRMED" },
      select: {
        accountId: true, ticker: true, acquiredDate: true, quantity: true,
        optionsPosition: { select: { strikePrice: true } },
      },
    }),
    // Income booked straight to an investment account with no activity behind
    // it: interest, money-market dividends, Fundrise distributions, and options
    // premium earned in a brokerage.
    prisma.income.findMany({
      where: { accountId: { in: accountIds }, activityId: null },
      select: {
        accountId: true, amount: true, date: true, source: true, isCashReceived: true,
        depositAccountId: true, depositDate: true, optionsPositionId: true,
        category: { select: { name: true } },
      },
    }),
    prisma.transfer.findMany({
      where: {
        date: { lte: new Date(`${today}T23:59:59Z`) },
        OR: [{ fromAccountId: { in: accountIds } }, { toAccountId: { in: accountIds } }],
      },
      select: { fromAccountId: true, toAccountId: true, amount: true, date: true, description: true },
    }),
    prisma.assetClass.findMany({
      where: { OR: [{ userId: null }, { userId }] },
      select: { id: true, name: true, color: true, parentId: true, displayOrder: true },
    }),
  ]);

  // ── Asset classes: weights map to top-level classes; anything unweighted is Untracked.
  const topOf = new Map<string, string>();
  for (const c of assetClasses) topOf.set(c.id, c.parentId ?? c.id);
  const topClasses = assetClasses
    .filter((c) => c.parentId == null)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const cashClass = topClasses.find((c) => c.name.toLowerCase() === "cash");
  const cashKey = cashClass?.id ?? CASH_FALLBACK;
  const classes: ClassInfo[] = [
    ...topClasses.map((c) => ({ key: c.id, name: c.name, color: c.color })),
    ...(cashClass ? [] : [{ key: CASH_FALLBACK, name: "Cash", color: null }]),
    { key: UNTRACKED, name: "Untracked", color: null },
  ];

  const tickers = new Set<string>([
    ...holdings.map((h) => h.ticker),
    ...activities.map((a) => a.ticker),
    ...qfx.map((q) => q.ticker),
  ]);
  const instrumentIds = new Set<string>([
    ...holdings.map((h) => h.instrumentId).filter((x): x is string => !!x),
    ...manuals.map((m) => m.instrumentId).filter((x): x is string => !!x),
    ...valuations.map((v) => v.instrumentId).filter((x): x is string => !!x),
  ]);
  const instruments = await prisma.instrument.findMany({
    where: {
      OR: [
        { id: { in: [...instrumentIds] } },
        { primaryTicker: { in: [...tickers] } },
        { tickers: { some: { ticker: { in: [...tickers] } } } },
      ],
    },
    select: {
      id: true, primaryTicker: true,
      tickers: { select: { ticker: true } },
      weights: { select: { assetClassId: true, weight: true } },
    },
  });

  // Class split as fractions summing to 1; the unmapped remainder is Untracked.
  type Split = Array<[string, number]>;
  const splitOfInstrument = new Map<string, Split>();
  for (const inst of instruments) {
    const parts = new Map<string, number>();
    let mapped = 0;
    for (const w of inst.weights) {
      const top = topOf.get(w.assetClassId);
      if (!top) continue;
      const f = num(w.weight) / 100;
      parts.set(top, (parts.get(top) ?? 0) + f);
      mapped += f;
    }
    if (mapped < 1 - EPS) parts.set(UNTRACKED, (parts.get(UNTRACKED) ?? 0) + (1 - mapped));
    splitOfInstrument.set(inst.id, [...parts]);
  }
  const instrumentOfTicker = new Map<string, string>();
  for (const inst of instruments) {
    instrumentOfTicker.set(inst.primaryTicker, inst.id);
    for (const t of inst.tickers) instrumentOfTicker.set(t.ticker, inst.id);
  }
  for (const h of holdings) if (h.instrumentId) instrumentOfTicker.set(h.ticker, h.instrumentId);
  const untrackedSplit: Split = [[UNTRACKED, 1]];
  const splitOfTicker = (t: string): Split => {
    const id = instrumentOfTicker.get(t);
    return (id && splitOfInstrument.get(id)) || untrackedSplit;
  };

  // ── Positions: (account, ticker) → quantity on a given day ──────────────────
  // Self-directed: today's shares (current lots) rolled back through every later
  // purchase, sale, and in-kind transfer. Rolling back matters: a lot bought and
  // fully sold after the day was never held on it, but its lot is gone, so
  // "lots acquired by then + shares sold since" would count those shares anyway.
  // Managed: cumulative QFX transactions (their lots carry no dates).
  type PosKey = string; // `${accountId}|${ticker}`
  const posKey = (a: string, t: string) => `${a}|${t}`;
  const nowByPos = new Map<PosKey, number>();
  for (const h of holdings) {
    if (managedIds.has(h.accountId)) continue;
    const k = posKey(h.accountId, h.ticker);
    nowByPos.set(k, (nowByPos.get(k) ?? 0) + h.lots.reduce((s, l) => s + num(l.quantity), 0));
  }
  // Signed share changes: + purchase / transfer in, − sale / transfer out.
  const changesByPos = new Map<PosKey, Array<{ day: Day; shares: number; transfer: boolean }>>();
  const addChange = (k: PosKey, day: Day, shares: number, transfer: boolean) =>
    (changesByPos.get(k) ?? changesByPos.set(k, []).get(k)!).push({ day, shares, transfer });
  for (const a of activities) {
    if (a.shares == null || managedIds.has(a.accountId)) continue;
    if (a.type === "PURCHASE") addChange(posKey(a.accountId, a.ticker), dayOf(a.date), num(a.shares), false);
    if (a.type === "SALE") addChange(posKey(a.accountId, a.ticker), dayOf(a.date), -num(a.shares), false);
  }
  // A transfer writes one row on each side, source first; pair them to know which
  // way the shares went.
  const transferGroups = new Map<string, typeof activities>();
  for (const a of activities) {
    if (a.type !== "TRANSFER" || a.shares == null || !a.transferAccountId) continue;
    const pair = [a.accountId, a.transferAccountId].sort().join("|");
    const key = `${dayOf(a.date)}|${a.ticker}|${num(a.shares)}|${pair}`;
    (transferGroups.get(key) ?? transferGroups.set(key, []).get(key)!).push(a);
  }
  for (const rows of transferGroups.values()) {
    rows.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const [out, into] = [rows[i], rows[i + 1]];
      const day = dayOf(out.date);
      if (!managedIds.has(out.accountId)) addChange(posKey(out.accountId, out.ticker), day, -num(out.shares), true);
      if (!managedIds.has(into.accountId)) addChange(posKey(into.accountId, into.ticker), day, num(into.shares), true);
    }
  }
  const qfxByPos = new Map<PosKey, Array<{ day: Day; shares: number }>>();
  for (const q of qfx) {
    const k = posKey(q.accountId, q.ticker);
    const signed = num(q.shares) * (q.type === "SELL" ? -1 : 1);
    (qfxByPos.get(k) ?? qfxByPos.set(k, []).get(k)!).push({ day: dayOf(q.date), shares: signed });
  }
  const positions = new Set<PosKey>([...nowByPos.keys(), ...changesByPos.keys(), ...qfxByPos.keys()]);

  // Records that roll a position below zero (a sale or transfer with no matching
  // purchase, a lot edited down) are clamped to zero and reported.
  const inconsistent = new Set<string>();
  const qtyAt = (k: PosKey, day: Day): number => {
    let q: number;
    if (qfxByPos.has(k)) {
      q = 0;
      for (const t of qfxByPos.get(k)!) if (t.day <= day) q += t.shares;
    } else {
      q = nowByPos.get(k) ?? 0;
      for (const c of changesByPos.get(k) ?? []) if (c.day > day) q -= c.shares;
    }
    if (q < -EPS) {
      const sep = k.indexOf("|");
      inconsistent.add(`${accountName.get(k.slice(0, sep))} ${k.slice(sep + 1)}`);
      return 0;
    }
    return Math.abs(q) < EPS ? 0 : q;
  };

  // ── Prices ───────────────────────────────────────────────────────────────────
  const coinGeckoIdOf = new Map<string, string>();
  for (const h of holdings) if (h.coinGeckoId) coinGeckoIdOf.set(h.ticker, h.coinGeckoId);

  const heldTickers = new Set<string>();
  const firstHeld = new Map<string, Day>();
  for (const k of positions) {
    const t = k.slice(k.indexOf("|") + 1);
    for (const d of valuationDays) {
      if (qtyAt(k, d) > 0) {
        heldTickers.add(t);
        if (!firstHeld.has(t) || d < firstHeld.get(t)!) firstHeld.set(t, d);
        break;
      }
    }
  }
  await backfillPriceHeads([...heldTickers], firstHeld, coinGeckoIdOf);

  const [historyRows, currentPrices] = await Promise.all([
    prisma.tickerPriceHistory.findMany({
      where: { ticker: { in: [...heldTickers] }, date: { gte: new Date(`${addDays(baseline, -10)}T00:00:00Z`) } },
      orderBy: { date: "asc" },
      select: { ticker: true, date: true, closePrice: true },
    }),
    prisma.tickerPrice.findMany({
      where: { ticker: { in: [...heldTickers] } },
      select: { ticker: true, price: true, priceSource: true },
    }),
  ]);
  const seriesOf = new Map<string, Array<{ day: Day; price: number }>>();
  for (const r of historyRows) {
    (seriesOf.get(r.ticker) ?? seriesOf.set(r.ticker, []).get(r.ticker)!).push({ day: dayOf(r.date), price: num(r.closePrice) });
  }
  const current = new Map(currentPrices.map((p) => [p.ticker, p]));
  const estimated = new Set<string>();

  const priceAt = (ticker: string, day: Day): number => {
    const cur = current.get(ticker);
    if (cur && isPinnedPrice(ticker, cur.priceSource)) return num(cur.price);
    const series = seriesOf.get(ticker);
    if (series && series.length > 0) {
      let best: number | null = null;
      for (const p of series) {
        if (p.day <= day) best = p.price;
        else break;
      }
      if (best != null) return best;
      estimated.add(ticker); // held before its earliest known close
      return series[0].price;
    }
    estimated.add(ticker);
    return cur ? num(cur.price) : 0;
  };

  // ── Cash observations (cashAt is defined once the dated events are known) ──
  const cashObsByAccount = new Map<string, Array<{ day: Day; balance: number; statement: boolean }>>();
  for (const r of cashRows) {
    (cashObsByAccount.get(r.accountId) ?? cashObsByAccount.set(r.accountId, []).get(r.accountId)!)
      .push({ day: dayOf(r.date), balance: num(r.balance), statement: r.source === "STATEMENT" });
  }

  type ManualSeries = {
    accountId: string;
    label: string;
    split: Split;
    obs: Array<{ day: Day; value: number; cost: number | null; removed: boolean }>;
  };
  const manualSeries = new Map<string, ManualSeries>(); // by manualInvestmentId, or valuation id when detached
  for (const v of valuations) {
    const id = v.manualInvestmentId ?? `detached:${v.accountId}:${v.name}`;
    const s = manualSeries.get(id) ?? {
      accountId: v.accountId,
      label: v.name,
      split: (v.instrumentId && splitOfInstrument.get(v.instrumentId)) || untrackedSplit,
      obs: [],
    };
    s.obs.push({ day: dayOf(v.date), value: num(v.marketValue), cost: v.totalCost == null ? null : num(v.totalCost), removed: v.source === "REMOVED" });
    manualSeries.set(id, s);
  }
  for (const m of manuals) {
    const s = manualSeries.get(m.id);
    const split = (m.instrumentId && splitOfInstrument.get(m.instrumentId)) || untrackedSplit;
    if (s) {
      s.split = split; // current classification wins
      s.label = m.name;
    } else {
      // No history yet: the current value, as of always.
      manualSeries.set(m.id, {
        accountId: m.accountId, label: m.name, split,
        obs: [{ day: baseline, value: num(m.marketValue), cost: m.totalCost == null ? null : num(m.totalCost), removed: false }],
      });
    }
  }
  const manualAt = (s: ManualSeries, day: Day) => {
    let best = s.obs[0];
    for (const o of s.obs) {
      if (o.day <= day) best = o;
      else break;
    }
    return best;
  };

  // ── Dated events ───────────────────────────────────────────────────────────
  // Assignment buys, keyed so their PURCHASE activity can be repriced at strike.
  const strikeOf = new Map<string, number>();
  for (const b of pendingBuys) {
    strikeOf.set(`${b.accountId}|${b.ticker}|${dayOf(b.acquiredDate)}|${num(b.quantity)}`, num(b.optionsPosition.strikePrice));
  }

  type Trade = { day: Day; shares: number; cash: number };
  const buysByPos = new Map<PosKey, Trade[]>();
  const sellsByPos = new Map<PosKey, Trade[]>();
  type IncomeEvt = { day: Day; accountId: string; amount: number; ticker: string | null; label: string };
  const incomeEvents: IncomeEvt[] = [];
  type FlowEvt = { day: Day; accountId: string; amount: number; description: string };
  const flowEvents: FlowEvt[] = []; // + deposit, − withdrawal
  // Fees leave the account's cash but stay out of the flows: they're a cost
  // against the return, not money moved in or out.
  const feeEvents: FlowEvt[] = []; // amount positive
  for (const a of activities) {
    if (a.type !== "FEE") continue;
    const note = (a.notes ?? "").replace(/^QFX:\S+( · )?/, "");
    feeEvents.push({ day: dayOf(a.date), accountId: a.accountId, amount: num(a.amount), description: note || "Fee" });
  }

  // Where income's cash went. Rows with a deposit account say so: it left the
  // portfolio (a withdrawal on the deposit date) when that account is outside it,
  // moved between accounts when it's another investment account, and stayed put
  // otherwise. Rows from before the deposit fields existed fall back to the old
  // per-record test, which the Withdrawals page shares: a bank in accountId sent
  // it there; otherwise cash-received (isCashReceived) income left the portfolio
  // the day it was paid, and reinvested income stayed. Tax-advantaged accounts
  // write no Income rows, so their dividends stay.
  type IncomeCash = {
    accountId: string; amount: unknown; isCashReceived: boolean;
    depositAccountId: string | null; depositDate: Date | null;
  };
  const internalMoves: Array<{ day: Day; from: string; to: string; amount: number }> = [];
  const routeIncomeCash = (
    i: IncomeCash, origin: string, day: Day, amount: number, label: string,
  ) => {
    if (i.depositAccountId != null) {
      const depositDay = i.depositDate ? dayOf(i.depositDate) : day;
      if (!accountName.has(i.depositAccountId)) {
        flowEvents.push({ day: depositDay, accountId: origin, amount: -amount, description: `${label} transferred to bank` });
      } else if (i.depositAccountId !== origin) {
        internalMoves.push({ day: depositDay, from: origin, to: i.depositAccountId, amount });
      }
    } else if (!accountName.has(i.accountId)) {
      flowEvents.push({ day, accountId: origin, amount: -amount, description: `${label} transferred to bank` });
    } else if (i.isCashReceived) {
      flowEvents.push({ day, accountId: origin, amount: -amount, description: `${label} transferred to bank` });
    }
  };
  const isOptionsPremium = (i: { optionsPositionId: string | null; category: { name: string } | null }) =>
    i.optionsPositionId != null || i.category?.name === "Options Premium";
  type PremiumEvt = { day: Day; accountId: string; amount: number; description: string };
  const premiumEvents: PremiumEvt[] = []; // + earned in the brokerage, − transferred out

  for (const a of activities) {
    const day = dayOf(a.date);
    const k = posKey(a.accountId, a.ticker);
    if (a.type === "PURCHASE" && !managedIds.has(a.accountId) && a.shares != null) {
      const shares = num(a.shares);
      const strike = strikeOf.get(`${a.accountId}|${a.ticker}|${day}|${shares}`);
      const cash = strike != null ? strike * shares : num(a.amount);
      (buysByPos.get(k) ?? buysByPos.set(k, []).get(k)!).push({ day, shares, cash });
    } else if (a.type === "SALE" && !managedIds.has(a.accountId) && a.shares != null) {
      const net = num(a.amount) - num(a.fees);
      (sellsByPos.get(k) ?? sellsByPos.set(k, []).get(k)!).push({ day, shares: num(a.shares), cash: net });
      // Proceeds sent to a bank leave the portfolio; kept as settlement cash, they
      // stay (a legacy row's isCashReceived doesn't mean "withdrawn" for a sale).
      for (const i of a.incomes) {
        if (i.depositAccountId == null && accountName.has(i.accountId)) continue;
        routeIncomeCash({ ...i, isCashReceived: false }, a.accountId, day, num(i.amount), `${a.ticker} sale proceeds`);
      }
    } else if (a.type === "DIVIDEND") {
      incomeEvents.push({ day, accountId: a.accountId, amount: num(a.amount), ticker: a.ticker, label: a.ticker });
      const income = a.incomes[0];
      if (income) routeIncomeCash(income, a.accountId, day, num(a.amount), `${a.ticker} dividend`);
    }
  }
  for (const q of qfx) {
    const k = posKey(q.accountId, q.ticker);
    const t: Trade = { day: dayOf(q.date), shares: Math.abs(num(q.shares)), cash: Math.abs(num(q.total)) };
    if (q.type === "SELL") (sellsByPos.get(k) ?? sellsByPos.set(k, []).get(k)!).push(t);
    else (buysByPos.get(k) ?? buysByPos.set(k, []).get(k)!).push(t);
  }
  for (const i of looseIncome) {
    if (!i.accountId) continue;
    const day = dayOf(i.date);
    const amount = num(i.amount);
    // Options premium passes through the brokerage: it is in the cash from the
    // close until it's transferred, but counts toward neither return nor flows.
    // One kept in an investment account would never leave, so it's ordinary income.
    if (isOptionsPremium(i) && i.depositAccountId != null && !accountName.has(i.depositAccountId)) {
      const label = i.source ?? "Options premium";
      premiumEvents.push({ day, accountId: i.accountId, amount, description: label });
      premiumEvents.push({ day: dayOf(i.depositDate ?? i.date), accountId: i.accountId, amount: -amount, description: label });
      continue;
    }
    const source = i.source?.trim().toUpperCase() ?? "";
    const ticker = tickers.has(source) ? source : null;
    incomeEvents.push({ day, accountId: i.accountId, amount, ticker, label: i.source ?? "Income" });
    routeIncomeCash(i, i.accountId, day, amount, i.source ?? "Income");
  }
  for (const t of transfers) {
    const day = dayOf(t.date);
    const amount = num(t.amount);
    if (accountName.has(t.toAccountId) && !accountName.has(t.fromAccountId)) {
      flowEvents.push({ day, accountId: t.toAccountId, amount, description: t.description });
    } else if (accountName.has(t.fromAccountId) && !accountName.has(t.toAccountId)) {
      flowEvents.push({ day, accountId: t.fromAccountId, amount: -amount, description: t.description });
    }
  }

  // ── Settlement cash between observations ──────────────────────────────────
  // Every recorded event's effect on an account's cash, dated.
  const cashDeltas = new Map<string, Array<{ day: Day; amount: number }>>();
  const addDelta = (accountId: string, day: Day, amount: number) =>
    (cashDeltas.get(accountId) ?? cashDeltas.set(accountId, []).get(accountId)!).push({ day, amount });
  for (const [k, trades] of sellsByPos) for (const t of trades) addDelta(k.slice(0, k.indexOf("|")), t.day, t.cash);
  for (const [k, trades] of buysByPos) for (const t of trades) addDelta(k.slice(0, k.indexOf("|")), t.day, -t.cash);
  for (const e of incomeEvents) addDelta(e.accountId, e.day, e.amount);
  for (const f of flowEvents) addDelta(f.accountId, f.day, f.amount);
  for (const f of feeEvents) addDelta(f.accountId, f.day, -f.amount);
  for (const m of internalMoves) {
    addDelta(m.from, m.day, -m.amount);
    addDelta(m.to, m.day, m.amount);
  }
  for (const e of premiumEvents) addDelta(e.accountId, e.day, e.amount);
  for (const s of manualSeries.values()) {
    for (let i = 1; i < s.obs.length; i++) {
      const [a, b] = [s.obs[i - 1], s.obs[i]];
      const traded = b.removed ? -(a.removed ? 0 : a.value) : (b.cost ?? 0) - (a.removed ? 0 : a.cost ?? 0);
      addDelta(s.accountId, b.day, -traded);
    }
  }

  // Statements report settled cash, but trades count on their trade date. A
  // trade on a statement's closing session settles the next business day (T+1),
  // after the statement date, so add its cash back to put the balance on the
  // same footing as everything else. Money market funds (pinned at $1) settle
  // the same day and need no adjustment. Not at the baseline: trades dated on or
  // before it are the starting position (opening lots), never counted in a period.
  const tradeCashOn = new Map<string, number>(); // `${accountId}|${day}` → net trade cash
  const addTradeCash = (k: PosKey, trades: Trade[], sign: number) => {
    const accountId = k.slice(0, k.indexOf("|"));
    const ticker = k.slice(k.indexOf("|") + 1);
    const cur = current.get(ticker);
    if (cur && isPinnedPrice(ticker, cur.priceSource)) return;
    for (const t of trades) {
      const key = `${accountId}|${t.day}`;
      tradeCashOn.set(key, (tradeCashOn.get(key) ?? 0) + sign * t.cash);
    }
  };
  for (const [k, trades] of sellsByPos) addTradeCash(k, trades, 1);
  for (const [k, trades] of buysByPos) addTradeCash(k, trades, -1);
  for (const [accountId, obs] of cashObsByAccount) {
    for (const o of obs) if (o.statement && o.day > baseline) o.balance += tradeCashOn.get(`${accountId}|${o.day}`) ?? 0;
  }
  // Today's balance is itself an observation: the account's current cash, so
  // the latest period ends on the same value the Investments page shows.
  for (const a of accounts) {
    const obs = cashObsByAccount.get(a.id) ?? cashObsByAccount.set(a.id, []).get(a.id)!;
    if (obs.length === 0 || obs[obs.length - 1].day < lastDay) {
      obs.push({ day: lastDay, balance: num(a.cashBalance), statement: false });
    }
  }

  // Cash on a day = the nearest observation before it, rolled forward through
  // the events since; before the first observation, rolled back from it. An
  // observation that disagrees with where the events led is what surfaces as
  // unreconciled.
  type CashObs = { day: Day; balance: number; statement: boolean };
  const rollCash = (obs: CashObs[], deltas: Array<{ day: Day; amount: number }>, day: Day): number => {
    if (obs.length === 0) return 0;
    let anchor = obs[0];
    for (const o of obs) {
      if (o.day <= day) anchor = o;
      else break;
    }
    let cash = anchor.balance;
    if (anchor.day <= day) {
      for (const d of deltas) if (d.day > anchor.day && d.day <= day) cash += d.amount;
    } else {
      for (const d of deltas) if (d.day > day && d.day <= anchor.day) cash -= d.amount;
    }
    return cash;
  };
  const cashAt = (accountId: string, day: Day): number =>
    rollCash(cashObsByAccount.get(accountId)!, cashDeltas.get(accountId) ?? [], day);

  // Income with no ticker: an account holding only manual investments (Fundrise)
  // earns on those; anything else (interest) is a return on cash.
  const accountsWithPositions = new Set([...positions].map((k) => k.slice(0, k.indexOf("|"))));
  const incomeSplit = (e: IncomeEvt): { split: Split; label: string } => {
    if (e.ticker) return { split: splitOfTicker(e.ticker), label: e.ticker };
    if (!accountsWithPositions.has(e.accountId)) {
      const mine = [...manualSeries.values()].filter((s) => s.accountId === e.accountId);
      const total = mine.reduce((sum, s) => sum + manualAt(s, e.day).value, 0);
      if (total > 0) {
        const parts = new Map<string, number>();
        for (const s of mine) {
          const share = manualAt(s, e.day).value / total;
          for (const [c, f] of s.split) parts.set(c, (parts.get(c) ?? 0) + share * f);
        }
        return { split: [...parts], label: `${accountName.get(e.accountId)} distributions` };
      }
    }
    return { split: [[cashKey, 1]], label: "Interest" };
  };

  // ── Valuation ────────────────────────────────────────────────────────────────
  type Snapshot = { total: number; byClass: Map<string, number> };
  // Cash rolled through the records below zero means a flow is missing or
  // recorded against the wrong account; report each account's lowest point.
  const lowestCash = new Map<string, { day: Day; amount: number }>();
  const valueAt = (day: Day): Snapshot => {
    const byClass = new Map<string, number>();
    const add = (c: string, v: number) => byClass.set(c, (byClass.get(c) ?? 0) + v);
    let total = 0;
    for (const k of positions) {
      const q = qtyAt(k, day);
      if (q === 0) continue;
      const t = k.slice(k.indexOf("|") + 1);
      const v = q * priceAt(t, day);
      total += v;
      for (const [c, f] of splitOfTicker(t)) add(c, v * f);
    }
    for (const s of manualSeries.values()) {
      const o = manualAt(s, day);
      if (o.removed) continue;
      total += o.value;
      for (const [c, f] of s.split) add(c, o.value * f);
    }
    for (const a of accounts) {
      const c = cashAt(a.id, day);
      total += c;
      add(cashKey, c);
      if (c < -1 && (!lowestCash.has(a.id) || c < lowestCash.get(a.id)!.amount)) lowestCash.set(a.id, { day, amount: c });
    }
    return { total, byClass };
  };

  const inPeriod = (day: Day, start: Day, end: Day) => day > start && day <= end;
  const sum = <T>(xs: T[] | undefined, f: (x: T) => number) => (xs ?? []).reduce((s, x) => s + f(x), 0);

  const periods: PerformancePeriod[] = [];
  let prev = valueAt(baseline);
  const baselineValue = prev.total;

  for (let i = 0; i < ends.length; i++) {
    const start = i === 0 ? baseline : ends[i - 1];
    const end = ends[i];
    const cur = valueAt(end);

    const classMc = new Map<string, number>();
    const classIncome = new Map<string, number>();
    const holdingRows = new Map<string, Map<string, { mc: number; inc: number }>>(); // class → label → amounts
    const credit = (split: Split, label: string, mc: number, inc: number) => {
      for (const [c, f] of split) {
        classMc.set(c, (classMc.get(c) ?? 0) + mc * f);
        classIncome.set(c, (classIncome.get(c) ?? 0) + inc * f);
        const rows = holdingRows.get(c) ?? holdingRows.set(c, new Map()).get(c)!;
        const r = rows.get(label) ?? { mc: 0, inc: 0 };
        r.mc += mc * f;
        r.inc += inc * f;
        rows.set(label, r);
      }
    };

    // Expected change in each account's cash from what was recorded.
    const expectedCash = new Map<string, number>();
    const expect = (a: string, v: number) => expectedCash.set(a, (expectedCash.get(a) ?? 0) + v);

    for (const k of positions) {
      const accountId = k.slice(0, k.indexOf("|"));
      const t = k.slice(k.indexOf("|") + 1);
      const q0 = qtyAt(k, start);
      const q1 = qtyAt(k, end);
      const sells = (sellsByPos.get(k) ?? []).filter((s) => inPeriod(s.day, start, end));
      const buys = (buysByPos.get(k) ?? []).filter((b) => inPeriod(b.day, start, end));
      if (q0 === 0 && q1 === 0 && sells.length === 0 && buys.length === 0) continue;

      // Prices only where shares are held, so a round trip inside one period
      // (bought and sold between closes) needs none: its result is just the cash.
      const p1 = q1 !== 0 ? priceAt(t, end) : 0;
      const p0 = q0 !== 0 ? priceAt(t, start) : 0;
      const sellCash = sum(sells, (s) => s.cash);
      let buyCash = sum(buys, (b) => b.cash);
      // Shares that arrived without a matching purchase record (an edited lot,
      // say) are valued at this close, so they carry no market change. In-kind
      // transfers move shares without cash and are excluded.
      const transferred = sum(
        (changesByPos.get(k) ?? []).filter((c) => c.transfer && inPeriod(c.day, start, end)),
        (c) => c.shares,
      );
      const impliedBuyShares = q1 - q0 + sum(sells, (s) => s.shares) - transferred;
      const unrecordedShares = impliedBuyShares - sum(buys, (b) => b.shares);
      if (Math.abs(unrecordedShares) > EPS) buyCash += unrecordedShares * (q1 !== 0 ? p1 : priceAt(t, end));

      const mc = q1 * p1 - q0 * p0 - buyCash + sellCash;
      credit(splitOfTicker(t), t, mc, 0);
      expect(accountId, sellCash - buyCash);
    }

    for (const e of incomeEvents) {
      if (!inPeriod(e.day, start, end)) continue;
      const { split, label } = incomeSplit(e);
      credit(split, label, 0, e.amount);
      expect(e.accountId, e.amount);
    }

    for (const s of manualSeries.values()) {
      const a = manualAt(s, start);
      const b = manualAt(s, end);
      if (a === b) continue;
      const v0 = a.removed ? 0 : a.value;
      // A removal is an exit at the last recorded value; otherwise a rise in total
      // cost is a contribution and the rest is market change.
      const traded = b.removed ? -v0 : (b.cost ?? 0) - (a.removed ? 0 : a.cost ?? 0);
      const v1 = b.removed ? 0 : b.value;
      credit(s.split, s.label, v1 - v0 - traded, 0);
      expect(s.accountId, -traded);
    }

    const flows = flowEvents.filter((f) => inPeriod(f.day, start, end));
    for (const f of flows) expect(f.accountId, f.amount);
    const fees = feeEvents.filter((f) => inPeriod(f.day, start, end));
    for (const f of fees) expect(f.accountId, -f.amount);
    for (const m of internalMoves) {
      if (!inPeriod(m.day, start, end)) continue;
      expect(m.from, -m.amount);
      expect(m.to, m.amount);
    }
    const premium = premiumEvents.filter((e) => inPeriod(e.day, start, end));
    for (const e of premium) expect(e.accountId, e.amount);

    const unreconciledByAccount: PerformancePeriod["unreconciledByAccount"] = [];
    let unreconciled = 0;
    for (const a of accounts) {
      const u = cashAt(a.id, end) - cashAt(a.id, start) - (expectedCash.get(a.id) ?? 0);
      if (Math.abs(u) < 0.005) continue;
      unreconciled += u;
      unreconciledByAccount.push({ account: a.name, amount: round2(u) });
    }
    unreconciledByAccount.sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));

    const periodClasses: PeriodClass[] = classes
      .map((c) => ({
        key: c.key,
        startValue: round2(prev.byClass.get(c.key) ?? 0),
        endValue: round2(cur.byClass.get(c.key) ?? 0),
        marketChange: round2(classMc.get(c.key) ?? 0),
        income: round2(classIncome.get(c.key) ?? 0),
        holdings: [...(holdingRows.get(c.key) ?? new Map()).entries()]
          .map(([label, r]) => ({ label, marketChange: round2(r.mc), income: round2(r.inc) }))
          .filter((r) => Math.abs(r.marketChange) + Math.abs(r.income) >= 0.5)
          .sort((x, y) => Math.abs(y.marketChange + y.income) - Math.abs(x.marketChange + x.income)),
      }))
      .filter((c) => c.startValue !== 0 || c.endValue !== 0 || c.marketChange !== 0 || c.income !== 0);

    periods.push({
      start,
      end,
      partial: i === ends.length - 1 && end !== periodLastSession(end, cadence),
      startValue: round2(prev.total),
      endValue: round2(cur.total),
      classes: periodClasses,
      deposits: round2(sum(flows.filter((f) => f.amount > 0), (f) => f.amount)),
      withdrawals: round2(-sum(flows.filter((f) => f.amount < 0), (f) => f.amount)),
      unreconciled: round2(unreconciled),
      flows: flows
        .sort((x, y) => x.day.localeCompare(y.day))
        .map((f) => ({ date: f.day, account: accountName.get(f.accountId)!, amount: round2(f.amount), description: f.description })),
      fees: round2(sum(fees, (f) => f.amount)),
      feeItems: fees
        .sort((x, y) => x.day.localeCompare(y.day))
        .map((f) => ({ date: f.day, account: accountName.get(f.accountId)!, amount: round2(f.amount), description: f.description })),
      unreconciledByAccount,
      optionsPremiumHeld: round2(sum(premium, (e) => e.amount)),
      optionsPremiumItems: premium
        .sort((x, y) => x.day.localeCompare(y.day))
        .map((e) => ({ date: e.day, account: accountName.get(e.accountId)!, amount: round2(e.amount), description: e.description })),
    });
    prev = cur;
  }

  // ── Month-end balances, for editing ─────────────────────────────────────────
  let balances: MonthEndBalances | undefined;
  if (opts.balances) {
    const months = editableMonthEnds(today);
    const cashRow = new Map(cashRows.map((r) => [`${r.accountId}|${dayOf(r.date)}`, r]));
    const seriesId = (v: { manualInvestmentId: string | null; accountId: string; name: string }) =>
      v.manualInvestmentId ?? `detached:${v.accountId}:${v.name}`;
    const valuationRow = new Map(valuations.map((v) => [`${seriesId(v)}|${dayOf(v.date)}`, v]));

    balances = {
      months,
      accounts: accounts
        .map((a) => {
          const obs = cashObsByAccount.get(a.id)!;
          const deltas = cashDeltas.get(a.id) ?? [];
          const cash = months.map((d): MonthEndCell => {
            const row = cashRow.get(`${a.id}|${d}`);
            // Statement terms (settled cash), like the values typed in: undo the
            // T+1 add-back that puts observations on a trade-date footing.
            const settle = d > baseline ? tradeCashOn.get(`${a.id}|${d}`) ?? 0 : 0;
            const without = rollCash(obs.filter((o) => o.day !== d || !row), deltas, d) - settle;
            return {
              recorded: row ? num(row.balance) : null,
              source: row?.source ?? null,
              calculated: round2(without),
            };
          });
          const manual = [...manualSeries.entries()]
            .filter(([, ms]) => ms.accountId === a.id)
            .map(([id, ms]) => {
              const removedOn = ms.obs.find((o) => o.removed)?.day ?? null;
              const cells = months.map((d): MonthEndCell => {
                const row = valuationRow.get(`${id}|${d}`);
                if (removedOn && d >= removedOn) return { recorded: null, source: row?.source ?? null, calculated: null };
                const rest = { ...ms, obs: ms.obs.filter((o) => o.day !== d || !row) };
                return {
                  recorded: row ? num(row.marketValue) : null,
                  source: row?.source ?? null,
                  calculated: rest.obs.length ? round2(manualAt(rest, d).value) : null,
                };
              });
              return { id, name: ms.label, removedOn, cells };
            })
            .sort((x, y) => x.name.localeCompare(y.name));
          return { id: a.id, name: a.name, cash, manual };
        })
        // Leave out accounts with nothing ever recorded or held here
        .filter((a) => a.manual.length > 0 || a.cash.some((c) => c.recorded != null || Math.abs(c.calculated ?? 0) >= 0.005))
        .sort((x, y) => x.name.localeCompare(y.name)),
    };
  }

  return {
    balances,
    cadence,
    baseline,
    baselineValue: round2(baselineValue),
    asOf: lastDay,
    classes,
    periods,
    notes: {
      estimatedPrices: [...estimated].sort(),
      inconsistentPositions: [...inconsistent].sort(),
      negativeCash: [...lowestCash].map(([id, v]) => ({ account: accountName.get(id)!, date: v.day, amount: round2(v.amount) })),
      managedDataThrough: accounts
        .filter((a) => a.isManaged)
        .map((a) => {
          const days = qfx.filter((q) => q.accountId === a.id).map((q) => dayOf(q.date)).sort();
          return { account: a.name, date: days.length ? days[days.length - 1] : null };
        }),
      cashObservations: accounts.map((a) => {
        // Recorded balances only, not today's balance appended above
        const obs = cashRows.filter((r) => r.accountId === a.id);
        return { account: a.name, count: obs.length, first: obs[0] ? dayOf(obs[0].date) : null };
      }),
    },
  };
}

/** The final session of the period `day` falls in, ignoring the settled cutoff. */
function periodLastSession(day: Day, cadence: Cadence): Day {
  const key = periodKey(day, cadence);
  let last = day;
  for (let d = addDays(day, 1); periodKey(d, cadence) === key; d = addDays(d, 1)) {
    if (isTradingDay(Date.parse(`${d}T16:00:00Z`))) last = d;
  }
  return last;
}

// ── Price history head-fill ────────────────────────────────────────────────────
// fillPriceGaps only extends history forward, so a ticker first charted after it
// was bought has no closes for the start of the window. Fetch the missing head
// once per process; a ticker that simply has no older data (a recent IPO) is
// then valued from its earliest close and reported as estimated.
const headFillAttempted = new Set<string>();

async function backfillPriceHeads(
  tickers: string[],
  firstHeld: Map<string, Day>,
  coinGeckoIdOf: Map<string, string>,
): Promise<void> {
  if (tickers.length === 0) return;
  const [earliestRows, prices] = await Promise.all([
    prisma.tickerPriceHistory.findMany({
      where: { ticker: { in: tickers } },
      orderBy: { date: "asc" },
      distinct: ["ticker"],
      select: { ticker: true, date: true },
    }),
    prisma.tickerPrice.findMany({
      where: { ticker: { in: tickers } },
      select: { ticker: true, priceSource: true },
    }),
  ]);
  const earliest = new Map(earliestRows.map((r) => [r.ticker, dayOf(r.date)]));
  const source = new Map(prices.map((p) => [p.ticker, p.priceSource]));

  for (const ticker of tickers) {
    const src = source.get(ticker) ?? "YAHOO";
    if (isPinnedPrice(ticker, src) || src === "TIINGO") continue;
    const need = addDays(firstHeld.get(ticker)!, -7);
    const have = earliest.get(ticker);
    if (have && have <= need) continue;
    const key = `${ticker}|${need}`;
    if (headFillAttempted.has(key)) continue;
    headFillAttempted.add(key);

    const to = have ?? addDays(dayOf(new Date()), 1);
    try {
      const coinGeckoId = coinGeckoIdOf.get(ticker);
      let points: Array<{ date: Date; closePrice: number }>;
      if (coinGeckoId) {
        const span = Math.ceil((Date.now() - Date.parse(`${need}T00:00:00Z`)) / 86_400_000) + 2;
        points = (await getMarketChart(coinGeckoId, Math.min(span, 365)))
          .filter((p) => dayOf(p.date) >= need && dayOf(p.date) < to);
      } else if (["BTC", "ETH", "LTC"].includes(ticker)) {
        continue; // Yahoo serves these symbols as unrelated equities
      } else {
        points = (await fetchYahooHistory(ticker, new Date(`${need}T00:00:00Z`), new Date(`${to}T00:00:00Z`)))
          .filter((p) => dayOf(p.date) < to);
      }
      await writeTickerHistory(ticker, points, { isCrypto: coinGeckoId != null, mode: "fill" });
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      console.warn(`[performance] head-fill failed for ${ticker}:`, err);
    }
  }
}
