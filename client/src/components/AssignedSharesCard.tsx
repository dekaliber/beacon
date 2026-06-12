import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { BanknoteArrowUp, BanknoteX, CircleAlert } from "lucide-react";
import { Card } from "@/components/Card";
import { Tooltip } from "@/components/Tooltip";
import { cn } from "@/lib/utils";
import {
  getUnderlyingQuotes,
  type ActiveAssignedHolding,
  type RealizedDisposition,
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
        Upside capped by covered call at ${fmtUSD(ccStrike)}
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
  accountName: string | null;
  accountColor: string | null;
  assignmentStrike: number;
  assignmentExpiration: string;
  acquiredDate: string | null;
  openCallContracts: number;
  openCallAvgStrike: number | null;
  shares: number;
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
    } else {
      map.set(key, {
        key,
        ticker: r.ticker,
        accountId: r.accountId,
        accountName: r.accountName,
        accountColor: r.accountColor,
        assignmentStrike: r.assignmentStrike,
        assignmentExpiration: r.assignmentExpiration,
        acquiredDate: r.acquiredDate,
        // Same across the batch (matched by ticker|strike|expiry|account).
        openCallContracts: r.openCallContracts,
        openCallAvgStrike: r.openCallAvgStrike,
        shares: r.shares,
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

function AccountChip({ name, color }: { name: string | null; color: string | null }) {
  return (
    <span
      className="inline-block rounded-md px-2 py-0.5 text-13 text-foreground"
      style={{ backgroundColor: color ?? "var(--color-swatch-1)" }}
    >
      {name ?? "—"}
    </span>
  );
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
}: {
  externalQuotes?: Record<string, { price: number }>;
  // The parent owns this data (and its refresh), so the card stays in sync when
  // a covered call is opened/closed without an independent refetch.
  active: ActiveAssignedHolding[] | null;
  realized: { rows: RealizedDisposition[] } | null;
  // Opens the position modal pre-filled to write a CC against this lot. Shown
  // per row only when the lot has uncovered shares.
  onSellCoveredCall?: (seed: SellCoveredCallSeed) => void;
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

  const activeGroups = useMemo(() => groupActive(active ?? []), [active]);
  const realizedGroups = useMemo(() => groupRealized(realized?.rows ?? []), [realized]);

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
                  <th className={thClass}>Account</th>
                  <th className={thClass}>Assigned</th>
                  <th className={cn(thClass, "text-right")}>Assign Strike</th>
                  <th className={cn(thClass, "text-right")}>Shares</th>
                  <th className={thClass}>Open CC</th>
                  <th className={cn(thClass, "text-right")}>Avg CC Strike</th>
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
                  <th className={cn(thClass, "text-right")}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {activeGroups.map((g) => {
                  const price = quotes[g.ticker]?.price ?? null;
                  const mktValue = price != null ? price * g.shares : null;
                  const unreal =
                    price != null ? (price - g.assignmentStrike) * g.shares : null;
                  const pct =
                    price != null
                      ? ((price - g.assignmentStrike) / g.assignmentStrike) * 100
                      : null;
                  const coveredShares = Math.min(g.openCallContracts * 100, g.shares);
                  const uncoveredShares = g.shares - coveredShares;
                  const canSellCC = uncoveredShares >= 100;

                  // CC cap: when the covered call is ITM (price > CC strike), the
                  // covered shares will be called away at the strike — cap their upside.
                  const ccStrike = g.openCallAvgStrike;
                  const ccIsItm = price != null && ccStrike != null && price > ccStrike && coveredShares > 0;
                  const cappedUnreal = ccIsItm && price != null && ccStrike != null
                    ? (ccStrike - g.assignmentStrike) * coveredShares
                      + (price - g.assignmentStrike) * uncoveredShares
                    : null;
                  const cappedPct = ccIsItm && cappedUnreal != null
                    ? (cappedUnreal / (g.assignmentStrike * g.shares)) * 100
                    : null;
                  const missedUpside = ccIsItm && unreal != null && cappedUnreal != null
                    ? unreal - cappedUnreal
                    : null;

                  const costBasis = g.assignmentStrike * g.shares;
                  const uncappedPct = pct ?? 0;
                  const missedPct = missedUpside != null && costBasis > 0
                    ? (missedUpside / costBasis) * 100
                    : 0;
                  const baseTipData =
                    ccIsItm && ccStrike != null && cappedUnreal != null && cappedPct != null && missedUpside != null
                      ? { ccStrike, cappedUnreal, uncappedUnreal: unreal!, missedUpside, cappedPct, uncappedPct, missedPct }
                      : null;
                  const amountTipData = baseTipData ? { ...baseTipData, mode: "amount" as const } : null;
                  const pctTipData = baseTipData ? { ...baseTipData, mode: "pct" as const } : null;

                  return (
                    <tr key={g.key} className="border-b border-border hover:bg-muted">
                      <td className={cn(tdClass, "font-bold font-mono")}>{g.ticker}</td>
                      <td className={tdBody}>
                        <AccountChip name={g.accountName} color={g.accountColor} />
                      </td>
                      <td className={tdBody}>
                        {g.acquiredDate ? fmtMDY(g.acquiredDate) : "—"}
                      </td>
                      <td className={cn(tdClass, "text-right")}>${fmtUSD(g.assignmentStrike)}</td>
                      <td className={cn(tdClass, "text-right")}>{fmtShares(g.shares)}</td>
                      <td className={tdClass}>
                        {coveredShares > 0 ? (
                          <span>{fmtShares(Math.min(coveredShares, g.shares))} sh</span>
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
                      <td className={cn(tdClass, "text-right")}>
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
              </tr>
            </thead>
            <tbody>
              {realizedGroups.map((g) => {
                const avgSale = g.shares > 0 ? g.proceeds / g.shares : 0;
                const costBasis = g.assignmentStrike * g.shares;
                const pct = costBasis > 0 ? (g.realizedPnl / costBasis) * 100 : 0;
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
                  </tr>
                );
              })}
            </tbody>
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
