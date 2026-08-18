import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { BanknoteArrowUp, BanknoteX, CircleAlert, CalendarDays } from "lucide-react";
import { Card } from "@/components/Card";
import { Tooltip } from "@/components/Tooltip";
import { cn, localToday } from "@/lib/utils";
import { earningsWithinDays, earningsWarningText, EARNINGS_IMMINENT_DAYS } from "@/lib/earnings";
import {
  getUnderlyingQuotes,
  getOptionsEarnings,
  type ActiveAssignedHolding,
  type RealizedDisposition,
  type EarningsInfo,
} from "@/api";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtShares = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const fmtSigned = (n: number) => `${n < 0 ? "−" : ""}$${fmtUSD(Math.abs(n))}`;
const fmtPct = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(1)}%`;
const fmtMDY = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });

// >= 0 is a positive outcome (selling assigned stock at/above the strike).
const pnlColor = (n: number) => (n < 0 ? "text-down" : "text-up");

// ROR color: red below 0%, amber between 0% and the user's target annual
// return (OptionsSettings.targetReturn, a fraction), green at or above it.
const rorColor = (ror: number, targetReturn: number | null | undefined) => {
  if (ror < 0) return "text-down";
  const targetPct = (targetReturn ?? 0) * 100;
  return ror >= targetPct ? "text-up" : "text-warn";
};

const thClass =
  "px-3 py-2 text-left font-mono text-10 font-medium tracking-[0.11em] uppercase text-[var(--color-ink-3)] whitespace-nowrap";
const tdClass = "px-3 py-2 text-13 font-mono tabular-nums whitespace-nowrap";
// Body-text cell (non-mono) for account, dates, and the Via badge.
const tdBody = "px-3 py-2 text-13 whitespace-nowrap";

// ── ITM CC cap tooltip (portal-based to escape overflow-x-auto clipping) ──────
interface CcCapTipData {
  x: number;
  y: number;
  mode: "amount" | "pct";
  ccStrike: number;
  cappedUnreal: number;
  uncappedUnreal: number;
  missedUpside: number;
  cappedPct: number;
  uncappedPct: number;
  missedPct: number;
}
function CcCapTooltipPortal({ x, y, mode, ccStrike, cappedUnreal, uncappedUnreal, missedUpside, cappedPct, uncappedPct, missedPct }: CcCapTipData) {
  return createPortal(
    <div
      className="fixed z-[70] pointer-events-none w-64 rounded-md border border-border bg-background px-3 py-2.5 text-xs shadow-md"
      style={{ left: x, top: y - 6, transform: "translateX(-50%) translateY(-100%)" }}
    >
      <p className="font-medium text-foreground mb-2">
        Upside capped by CC at ${fmtUSD(ccStrike)}
      </p>
      {mode === "amount" ? (
        <span className="flex flex-col gap-1 font-mono tabular-nums">
          <span className="flex justify-between gap-4">
            <span className="text-muted-foreground font-sans">Max gain at strike</span>
            <span className={cappedUnreal >= 0 ? "text-up" : "text-down"}>{fmtSigned(cappedUnreal)}</span>
          </span>
          <span className="flex justify-between gap-4">
            <span className="text-muted-foreground font-sans">Value at current price</span>
            <span className={uncappedUnreal >= 0 ? "text-up" : "text-down"}>{fmtSigned(uncappedUnreal)}</span>
          </span>
          <span className="flex justify-between gap-4 border-t border-border pt-1 mt-0.5">
            <span className="text-muted-foreground font-sans">Foregone upside</span>
            <span className="text-warn">${fmtUSD(missedUpside)}</span>
          </span>
        </span>
      ) : (
        <span className="flex flex-col gap-1 font-mono tabular-nums">
          <span className="flex justify-between gap-4">
            <span className="text-muted-foreground font-sans">Max gain at strike</span>
            <span className={cappedPct >= 0 ? "text-up" : "text-down"}>{fmtPct(cappedPct)}</span>
          </span>
          <span className="flex justify-between gap-4">
            <span className="text-muted-foreground font-sans">Gain at current price</span>
            <span className={uncappedPct >= 0 ? "text-up" : "text-down"}>{fmtPct(uncappedPct)}</span>
          </span>
          <span className="flex justify-between gap-4 border-t border-border pt-1 mt-0.5">
            <span className="text-muted-foreground font-sans">Foregone upside</span>
            <span className="text-warn">{fmtPct(missedPct)}</span>
          </span>
        </span>
      )}
    </div>,
    document.body,
  );
}

interface ActiveGroup {
  key: string;
  ticker: string;
  accountId: string;
  assignmentStrike: number;
  assignmentExpiration: string;
  acquiredDate: string | null;
  openCallContracts: number;
  openCallAvgStrike: number | null;
  stockPriceAtAssignment: number | null;
  shares: number;
  cspPremium: number;
  ccPremiumSinceAssignment: number;
}

interface RealizedGroup {
  key: string;
  ticker: string;
  assignmentStrike: number;
  assignmentExpiration: string;
  shares: number;
  proceeds: number; // Σ salePricePerShare × shares
  realizedPnl: number;
  latestSaleDate: string;
  via: "CC" | "Direct" | "Mixed";
  cspPremium: number;
  ccPremiumSinceAssignment: number;
}

function groupActive(rows: ActiveAssignedHolding[]): ActiveGroup[] {
  const map = new Map<string, ActiveGroup>();
  for (const r of rows) {
    const key = `${r.ticker}|${r.assignmentStrike}|${r.assignmentExpiration}|${r.accountId}`;
    const existing = map.get(key);
    if (existing) {
      existing.shares += r.shares;
      // Keep the earliest acquisition date (server already sorts asc).
      if (r.acquiredDate && (!existing.acquiredDate || r.acquiredDate < existing.acquiredDate)) {
        existing.acquiredDate = r.acquiredDate;
      }
      existing.cspPremium += r.cspPremium;
      existing.ccPremiumSinceAssignment += r.ccPremiumSinceAssignment;
    } else {
      map.set(key, {
        key,
        ticker: r.ticker,
        accountId: r.accountId,
        assignmentStrike: r.assignmentStrike,
        assignmentExpiration: r.assignmentExpiration,
        acquiredDate: r.acquiredDate,
        // Same across the batch (matched by ticker|strike|expiry|account).
        openCallContracts: r.openCallContracts,
        openCallAvgStrike: r.openCallAvgStrike,
        stockPriceAtAssignment: r.stockPriceAtAssignment,
        shares: r.shares,
        cspPremium: r.cspPremium,
        ccPremiumSinceAssignment: r.ccPremiumSinceAssignment,
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.ticker.localeCompare(b.ticker) || a.assignmentStrike - b.assignmentStrike
  );
}

function groupRealized(rows: RealizedDisposition[]): RealizedGroup[] {
  const map = new Map<string, RealizedGroup & { hasCC: boolean; hasDirect: boolean }>();
  for (const r of rows) {
    const key = `${r.ticker}|${r.assignmentStrike}|${r.assignmentExpiration}`;
    const existing = map.get(key);
    if (existing) {
      existing.shares += r.shares;
      existing.proceeds += r.salePricePerShare * r.shares;
      existing.realizedPnl += r.realizedPnl;
      if (r.saleDate > existing.latestSaleDate) existing.latestSaleDate = r.saleDate;
      if (r.viaCoveredCall) existing.hasCC = true;
      else existing.hasDirect = true;
      existing.cspPremium += r.cspPremium;
      existing.ccPremiumSinceAssignment += r.ccPremiumSinceAssignment;
    } else {
      map.set(key, {
        key,
        ticker: r.ticker,
        assignmentStrike: r.assignmentStrike,
        assignmentExpiration: r.assignmentExpiration,
        shares: r.shares,
        proceeds: r.salePricePerShare * r.shares,
        realizedPnl: r.realizedPnl,
        latestSaleDate: r.saleDate,
        via: "Direct",
        hasCC: r.viaCoveredCall,
        hasDirect: !r.viaCoveredCall,
        cspPremium: r.cspPremium,
        ccPremiumSinceAssignment: r.ccPremiumSinceAssignment,
      });
    }
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      via: (g.hasCC && g.hasDirect ? "Mixed" : g.hasCC ? "CC" : "Direct") as RealizedGroup["via"],
    }))
    .sort((a, b) => (a.latestSaleDate < b.latestSaleDate ? 1 : -1));
}

// Per-row derived metrics for the Assigned Lots (active) tab — pulled out of
// the row renderer so the summary footer can reduce over the exact same
// numbers rather than recomputing (and risking drift from) its own copy.
function computeActiveRowMetrics(g: ActiveGroup, price: number | null, todayLocalMidnight: Date) {
  const mktValue = price != null ? price * g.shares : null;
  const unreal = price != null ? (price - g.assignmentStrike) * g.shares : null;
  const pct =
    price != null ? ((price - g.assignmentStrike) / g.assignmentStrike) * 100 : null;
  const coveredShares = Math.min(g.openCallContracts * 100, g.shares);
  const uncoveredShares = g.shares - coveredShares;
  const canSellCC = uncoveredShares >= 100;

  // CC cap: when the covered call is ITM (price > CC strike), the covered
  // shares will be called away at the strike — cap their upside.
  const ccStrike = g.openCallAvgStrike;
  const ccIsItm = price != null && ccStrike != null && price > ccStrike && coveredShares > 0;
  const cappedUnreal = ccIsItm && price != null && ccStrike != null
    ? (ccStrike - g.assignmentStrike) * coveredShares + (price - g.assignmentStrike) * uncoveredShares
    : null;
  const cappedPct = ccIsItm && cappedUnreal != null
    ? (cappedUnreal / (g.assignmentStrike * g.shares)) * 100
    : null;
  const missedUpside = ccIsItm && unreal != null && cappedUnreal != null ? unreal - cappedUnreal : null;

  const costBasis = g.assignmentStrike * g.shares;
  const uncappedPct = pct ?? 0;
  const missedPct = missedUpside != null && costBasis > 0 ? (missedUpside / costBasis) * 100 : 0;

  // Realized premium since assignment: the original CSP's (+ any pre-assignment
  // roll chain) premium plus any CC premium already locked in (closed/expired/
  // assigned) against this lot — a still-open CC's premium isn't counted until
  // it closes. ROR annualizes it against the same capital-at-risk / elapsed-time
  // convention used for a single option's return elsewhere on this page.
  const totPrem = g.cspPremium + g.ccPremiumSinceAssignment;
  // Whole calendar days (today's local midnight vs. the assignment's), not live
  // wall-clock time — otherwise this would drift downward throughout the day
  // and jump back up at midnight.
  const daysElapsed = g.acquiredDate
    ? (todayLocalMidnight.getTime() - new Date(g.acquiredDate + "T00:00:00").getTime()) / 86_400_000
    : null;
  const ror = costBasis > 0 && daysElapsed != null && daysElapsed > 0
    ? (totPrem / costBasis) * (365 / daysElapsed) * 100
    : null;

  return {
    price, mktValue, unreal, pct, coveredShares, uncoveredShares, canSellCC,
    ccStrike, ccIsItm, cappedUnreal, cappedPct, missedUpside,
    costBasis, uncappedPct, missedPct, totPrem, daysElapsed, ror,
  };
}

// Renders a right-aligned P&L value with a fixed-width icon slot to its right.
// The slot is always present (empty spacer when no icon) so numbers stay
// column-aligned across rows regardless of whether the icon is showing.
function PnlCell({
  value,
  colorClass,
  iconTipData,
  onTipEnter,
  onTipLeave,
}: {
  value: string;
  colorClass: string;
  iconTipData: Omit<CcCapTipData, "x" | "y"> | null;
  onTipEnter: (e: React.MouseEvent, data: Omit<CcCapTipData, "x" | "y">) => void;
  onTipLeave: () => void;
}) {
  return (
    <td className={cn(tdClass, "text-right", colorClass)}>
      <span className="inline-flex items-center justify-end">
        {value}
        {/* Fixed-width slot: always rendered so the number edge never shifts */}
        <span className="ml-1 w-3.5 shrink-0 inline-flex items-center justify-center">
          {iconTipData && (
            <span
              className="cursor-default inline-flex"
              onMouseEnter={(e) => onTipEnter(e, iconTipData)}
              onMouseLeave={onTipLeave}
            >
              <CircleAlert className="h-3.5 w-3.5 text-warn" />
            </span>
          )}
        </span>
      </span>
    </td>
  );
}

export interface SellCoveredCallSeed {
  ticker: string;
  accountId: string;
  assignmentStrike: number;
  assignmentExpiration: string; // YYYY-MM-DD
}

export function AssignedSharesCard({
  externalQuotes,
  active,
  realized,
  onSellCoveredCall,
  targetReturn,
}: {
  externalQuotes?: Record<string, { price: number }>;
  // The parent owns this data (and its refresh), so the card stays in sync when
  // a covered call is opened/closed without an independent refetch.
  active: ActiveAssignedHolding[] | null;
  realized: { rows: RealizedDisposition[] } | null;
  // Opens the position modal pre-filled to write a CC against this lot. Shown
  // per row only when the lot has uncovered shares.
  onSellCoveredCall?: (seed: SellCoveredCallSeed) => void;
  // Fraction (e.g. 0.15 for 15%), from OptionsSettings — the ROR color threshold.
  targetReturn?: number | null;
}) {
  const [tab, setTab] = useState<"active" | "realized">("active");

  // Portal-based tooltip state — avoids overflow-x-auto clipping.
  const [ccTip, setCcTip] = useState<CcCapTipData | null>(null);

  const [ownQuotes, setOwnQuotes] = useState<Record<string, { price: number }>>({});
  const activeTickers = useMemo(
    () => [...new Set((active ?? []).map((r) => r.ticker))],
    [active]
  );
  // Only fetch independently when the parent hasn't supplied prices.
  useEffect(() => {
    if (externalQuotes !== undefined || activeTickers.length === 0) return;
    let cancelled = false;
    getUnderlyingQuotes(activeTickers)
      .then((q) => { if (!cancelled) setOwnQuotes(q); })
      .catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalQuotes, activeTickers.join(",")]);
  const quotes = externalQuotes ?? ownQuotes;

  // Upcoming earnings per held ticker. Unlike an option row there's no
  // expiration to measure against here, so proximity is the trigger — see
  // EARNINGS_SOON_DAYS.
  const [earningsMap, setEarningsMap] = useState<Record<string, EarningsInfo | null>>({});
  useEffect(() => {
    if (activeTickers.length === 0) return;
    let cancelled = false;
    getOptionsEarnings(activeTickers, localToday())
      .then((e) => { if (!cancelled) setEarningsMap(e); })
      .catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTickers.join(",")]);

  const activeGroups = useMemo(() => groupActive(active ?? []), [active]);
  const realizedGroups = useMemo(() => groupRealized(realized?.rows ?? []), [realized]);
  // Today's local midnight — the reference point for "days since assignment" on
  // the active tab, so ROR is a stable whole-day count rather than one that
  // drifts as the current wall-clock time ticks forward through the day.
  // Recomputed (not memoized) each render — trivial cost, and avoids going
  // stale if the page is left open across a midnight boundary.
  const todayLocalMidnight = new Date();
  todayLocalMidnight.setHours(0, 0, 0, 0);

  const activeRows = activeGroups.map((g) => ({
    g,
    ...computeActiveRowMetrics(g, quotes[g.ticker]?.price ?? null, todayLocalMidnight),
  }));

  // Summary footer for the Assigned Lots tab: Mkt Value / Unrealized P&L are
  // plain sums; % Gain is total unrealized P&L over total original cost (not
  // market value); ROR is weighted by each position's original cost, so e.g.
  // a $10k position at 50% counts the same as a $20k position at 25%.
  const activeTotals = activeRows.reduce(
    (acc, r) => {
      acc.mktValue += r.mktValue ?? 0;
      acc.unreal += r.cappedUnreal ?? r.unreal ?? 0;
      acc.cost += r.costBasis;
      acc.totPrem += r.totPrem;
      if (r.ror != null) {
        acc.rorNumer += r.ror * r.costBasis;
        acc.rorDenom += r.costBasis;
      }
      return acc;
    },
    { mktValue: 0, unreal: 0, cost: 0, totPrem: 0, rorNumer: 0, rorDenom: 0 }
  );
  const activeTotalPct = activeTotals.cost > 0 ? (activeTotals.unreal / activeTotals.cost) * 100 : null;
  const activeWeightedRor = activeTotals.rorDenom > 0 ? activeTotals.rorNumer / activeTotals.rorDenom : null;

  const realizedRows = realizedGroups.map((g) => {
    const avgSale = g.shares > 0 ? g.proceeds / g.shares : 0;
    const costBasis = g.assignmentStrike * g.shares;
    const pct = costBasis > 0 ? (g.realizedPnl / costBasis) * 100 : 0;
    // Same premium + ROR convention as the Assigned Lots tab: total realized
    // premium (originating CSP chain + any CC already closed/expired/assigned
    // against this batch) annualized against cost at the assigned strike,
    // elapsed from assignment to the final sale in this batch.
    const totPrem = g.cspPremium + g.ccPremiumSinceAssignment;
    const daysElapsed =
      (new Date(g.latestSaleDate + "T00:00:00").getTime() -
        new Date(g.assignmentExpiration + "T00:00:00").getTime()) / 86_400_000;
    const ror = costBasis > 0 && daysElapsed > 0
      ? (totPrem / costBasis) * (365 / daysElapsed) * 100
      : null;
    return { g, avgSale, costBasis, pct, totPrem, ror };
  });

  // Summary footer for the Closed Lots tab: same weighting convention as above.
  const realizedTotals = realizedRows.reduce(
    (acc, r) => {
      acc.realizedPnl += r.g.realizedPnl;
      acc.cost += r.costBasis;
      acc.totPrem += r.totPrem;
      if (r.ror != null) {
        acc.rorNumer += r.ror * r.costBasis;
        acc.rorDenom += r.costBasis;
      }
      return acc;
    },
    { realizedPnl: 0, cost: 0, totPrem: 0, rorNumer: 0, rorDenom: 0 }
  );
  const realizedTotalPct = realizedTotals.cost > 0 ? (realizedTotals.realizedPnl / realizedTotals.cost) * 100 : null;
  const realizedWeightedRor = realizedTotals.rorDenom > 0 ? realizedTotals.rorNumer / realizedTotals.rorDenom : null;

  const tabClass = (isActive: boolean) =>
    cn(
      "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
      isActive
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground"
    );

  const activeCount = activeGroups.length;
  const realizedCount = realizedGroups.length;

  const handleTipEnter = (e: React.MouseEvent, data: Omit<CcCapTipData, "x" | "y">) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setCcTip({ x: rect.left + rect.width / 2, y: rect.top, ...data });
  };
  const handleTipLeave = () => setCcTip(null);

  return (
    <Card>
      <div className="flex border-b border-border px-4">
        <button className={tabClass(tab === "active")} onClick={() => setTab("active")}>
          Assigned Lots
          {activeCount > 0 && (
            <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-xs px-1.5 py-0.5 font-medium">
              {activeCount}
            </span>
          )}
        </button>
        <button className={tabClass(tab === "realized")} onClick={() => setTab("realized")}>
          Closed Lots
          {realizedCount > 0 && (
            <span className="ml-2 inline-flex items-center justify-center rounded-full bg-border text-muted-foreground text-xs px-1.5 py-0.5 font-medium">
              {realizedCount}
            </span>
          )}
        </button>
      </div>

      <div className="p-0 overflow-x-auto">
        {tab === "active" ? (
          activeGroups.length === 0 ? (
            <EmptyState text="No stock currently held from an assigned put." />
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Ticker</th>
                  <th className={thClass}>Assigned</th>
                  <th className={cn(thClass, "text-right")}>@ Strike</th>
                  <th className={cn(thClass, "text-right")}>Sh</th>
                  <th className={cn(thClass, "text-right")}>Open CC</th>
                  <th className={cn(thClass, "text-right")}>Avg Strike</th>
                  <th className={cn(thClass, "text-right")}>@ Assign</th>
                  <th className={cn(thClass, "text-right")}>Current</th>
                  <th className={cn(thClass, "text-right")}>Mkt Value</th>
                  <th className={cn(thClass, "text-right")}>
                    <span className="inline-flex items-center justify-end">
                      Unrealized P&amp;L
                      <span className="ml-1 w-3.5 shrink-0" />
                    </span>
                  </th>
                  <th className={cn(thClass, "text-right")}>
                    <span className="inline-flex items-center justify-end">
                      % Gain
                      <span className="ml-1 w-3.5 shrink-0" />
                    </span>
                  </th>
                  <th className={cn(thClass, "text-right border-l border-border/50")}>Tot Prem</th>
                  <th className={cn(thClass, "text-right")}>ROR</th>
                  <th className={cn(thClass.replace("px-3", "pr-3"), "text-right")}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {activeRows.map(({
                  g, price, mktValue, unreal, pct, coveredShares, uncoveredShares, canSellCC,
                  ccStrike, ccIsItm, cappedUnreal, cappedPct, missedUpside,
                  uncappedPct, missedPct, totPrem, ror,
                }) => {
                  const baseTipData =
                    ccIsItm && ccStrike != null && cappedUnreal != null && cappedPct != null && missedUpside != null
                      ? { ccStrike, cappedUnreal, uncappedUnreal: unreal!, missedUpside, cappedPct, uncappedPct, missedPct }
                      : null;
                  const amountTipData = baseTipData ? { ...baseTipData, mode: "amount" as const } : null;
                  const pctTipData = baseTipData ? { ...baseTipData, mode: "pct" as const } : null;
                  const earnings = earningsMap[g.ticker.toUpperCase()] ?? null;
                  const earningsSoon = earningsWithinDays(earnings);
                  const earningsImminent = earningsWithinDays(earnings, EARNINGS_IMMINENT_DAYS);

                  return (
                    <tr
                      key={g.key}
                      className={cn(
                        "border-b border-border",
                        uncoveredShares > 0 ? "bg-row-warn hover:bg-row-warn-hover" : "hover:bg-muted"
                      )}
                    >
                      <td className={cn(tdClass, "font-bold font-mono")}>
                        <div className="flex items-center gap-1.5">
                          <span>{g.ticker}</span>
                          {earningsSoon && (
                            <Tooltip content={earningsWarningText(earnings!)}>
                              <span className={cn("inline-flex items-center", earningsImminent ? "text-down" : "text-warn")}>
                                <CalendarDays className="h-3 w-3" />
                              </span>
                            </Tooltip>
                          )}
                        </div>
                      </td>
                      <td className={tdBody}>
                        {g.acquiredDate ? fmtMDY(g.acquiredDate) : "—"}
                      </td>
                      <td className={cn(tdClass, "text-right")}>${fmtUSD(g.assignmentStrike)}</td>
                      <td className={cn(tdClass, "text-right")}>{fmtShares(g.shares)}</td>
                      <td className={cn(tdClass, "text-right")}>
                        {coveredShares > 0 ? (
                          fmtShares(Math.min(coveredShares, g.shares))
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className={cn(tdClass, "text-right")}>
                        {g.openCallAvgStrike != null ? (
                          `$${fmtUSD(g.openCallAvgStrike)}`
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className={cn(tdClass, "text-right")}>
                        {g.stockPriceAtAssignment != null ? (
                          `$${fmtUSD(g.stockPriceAtAssignment)}`
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className={cn(tdClass, "text-right")}>
                        {price != null ? `$${fmtUSD(price)}` : "—"}
                      </td>
                      <td className={cn(tdClass, "text-right")}>
                        {mktValue != null ? `$${fmtUSD(mktValue)}` : "—"}
                      </td>
                      <PnlCell
                        value={unreal != null ? fmtSigned(cappedUnreal ?? unreal) : "—"}
                        colorClass={(cappedUnreal ?? unreal) != null ? pnlColor(cappedUnreal ?? unreal!) : ""}
                        iconTipData={unreal != null ? amountTipData : null}
                        onTipEnter={handleTipEnter}
                        onTipLeave={handleTipLeave}
                      />
                      <PnlCell
                        value={pct != null ? fmtPct(cappedPct ?? pct) : "—"}
                        colorClass={(cappedPct ?? pct) != null ? pnlColor(cappedPct ?? pct!) : ""}
                        iconTipData={pct != null ? pctTipData : null}
                        onTipEnter={handleTipEnter}
                        onTipLeave={handleTipLeave}
                      />
                      <td className={cn(tdClass, "text-right border-l border-border/50", pnlColor(totPrem))}>
                        {fmtSigned(totPrem)}
                      </td>
                      <td className={cn(tdClass, "text-right", ror != null ? rorColor(ror, targetReturn) : "")}>
                        {ror != null ? fmtPct(ror) : "—"}
                      </td>
                      <td className={cn(tdClass.replace("px-3", "pr-3"), "text-right")}>
                        {onSellCoveredCall != null && (
                          canSellCC ? (
                            <Tooltip content="Sell covered call">
                              <button
                                onClick={() =>
                                  onSellCoveredCall({
                                    ticker: g.ticker,
                                    accountId: g.accountId,
                                    assignmentStrike: g.assignmentStrike,
                                    assignmentExpiration: g.assignmentExpiration,
                                  })
                                }
                                className="p-1.5 inline-flex rounded text-muted-foreground/40 hover:text-primary hover:bg-primary/10 transition-colors"
                              >
                                <BanknoteArrowUp className="h-3.5 w-3.5" />
                              </button>
                            </Tooltip>
                          ) : (
                            <Tooltip content="All shares used as collateral">
                              <span className="p-1.5 inline-flex">
                                <BanknoteX className="h-3.5 w-3.5 text-muted-foreground/20" />
                              </span>
                            </Tooltip>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className={cn(tdBody, "font-semibold")} colSpan={8}>Total</td>
                  <td className={cn(tdClass, "text-right")}>
                    ${fmtUSD(activeTotals.mktValue)}
                  </td>
                  <PnlCell
                    value={fmtSigned(activeTotals.unreal)}
                    colorClass={pnlColor(activeTotals.unreal)}
                    iconTipData={null}
                    onTipEnter={handleTipEnter}
                    onTipLeave={handleTipLeave}
                  />
                  <PnlCell
                    value={activeTotalPct != null ? fmtPct(activeTotalPct) : "—"}
                    colorClass={activeTotalPct != null ? pnlColor(activeTotalPct) : ""}
                    iconTipData={null}
                    onTipEnter={handleTipEnter}
                    onTipLeave={handleTipLeave}
                  />
                  <td className={cn(tdClass, "text-right border-l border-border/50", pnlColor(activeTotals.totPrem))}>
                    {fmtSigned(activeTotals.totPrem)}
                  </td>
                  <td className={cn(tdClass, "text-right", activeWeightedRor != null ? rorColor(activeWeightedRor, targetReturn) : "")}>
                    {activeWeightedRor != null ? fmtPct(activeWeightedRor) : "—"}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )
        ) : realizedGroups.length === 0 ? (
          <EmptyState text="No assigned shares have been sold yet." />
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className={thClass}>Ticker</th>
                <th className={thClass}>Assigned</th>
                <th className={cn(thClass, "text-right")}>Assign Strike</th>
                <th className={cn(thClass, "text-right")}>Shares Sold</th>
                <th className={cn(thClass, "text-right")}>Avg Sale Price</th>
                <th className={cn(thClass, "text-right")}>Realized</th>
                <th className={cn(thClass, "text-right")}>% Gain</th>
                <th className={cn(thClass, "text-right")}>Last Sale</th>
                <th className={thClass}>Via</th>
                <th className={cn(thClass, "text-right border-l border-border/50")}>Tot Prem</th>
                <th className={cn(thClass, "text-right")}>ROR</th>
              </tr>
            </thead>
            <tbody>
              {realizedRows.map(({ g, avgSale, pct, totPrem, ror }) => {
                return (
                  <tr key={g.key} className="border-b border-border hover:bg-muted">
                    <td className={cn(tdClass, "font-bold font-mono")}>{g.ticker}</td>
                    <td className={tdBody}>{fmtMDY(g.assignmentExpiration)}</td>
                    <td className={cn(tdClass, "text-right")}>${fmtUSD(g.assignmentStrike)}</td>
                    <td className={cn(tdClass, "text-right")}>{fmtShares(g.shares)}</td>
                    <td className={cn(tdClass, "text-right")}>${fmtUSD(avgSale)}</td>
                    <td className={cn(tdClass, "text-right", pnlColor(g.realizedPnl))}>
                      {fmtSigned(g.realizedPnl)}
                    </td>
                    <td className={cn(tdClass, "text-right", pnlColor(pct))}>{fmtPct(pct)}</td>
                    <td className={cn(tdBody, "text-right")}>{fmtMDY(g.latestSaleDate)}</td>
                    <td className={tdBody}>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          g.via === "CC"
                            ? "bg-blue-soft text-blue-deep"
                            : g.via === "Direct"
                            ? "bg-secondary text-muted-foreground"
                            : "bg-warn-soft text-warn-deep"
                        )}
                      >
                        {g.via === "CC" ? "Covered call" : g.via}
                      </span>
                    </td>
                    <td className={cn(tdClass, "text-right border-l border-border/50", pnlColor(totPrem))}>
                      {fmtSigned(totPrem)}
                    </td>
                    <td className={cn(tdClass, "text-right", ror != null ? rorColor(ror, targetReturn) : "")}>
                      {ror != null ? fmtPct(ror) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border font-semibold">
                <td className={cn(tdBody, "font-semibold")} colSpan={5}>Total</td>
                <td className={cn(tdClass, "text-right", pnlColor(realizedTotals.realizedPnl))}>
                  {fmtSigned(realizedTotals.realizedPnl)}
                </td>
                <td className={cn(tdClass, "text-right", realizedTotalPct != null ? pnlColor(realizedTotalPct) : "")}>
                  {realizedTotalPct != null ? fmtPct(realizedTotalPct) : "—"}
                </td>
                <td colSpan={2} />
                <td className={cn(tdClass, "text-right border-l border-border/50", pnlColor(realizedTotals.totPrem))}>
                  {fmtSigned(realizedTotals.totPrem)}
                </td>
                <td className={cn(tdClass, "text-right", realizedWeightedRor != null ? rorColor(realizedWeightedRor, targetReturn) : "")}>
                  {realizedWeightedRor != null ? fmtPct(realizedWeightedRor) : "—"}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Portal tooltip — rendered into document.body to escape overflow clipping */}
      {ccTip !== null && <CcCapTooltipPortal {...ccTip} />}
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="px-6 py-10 text-center text-sm text-muted-foreground">{text}</div>;
}
