import { useState, useMemo, useEffect } from "react";
import { Card } from "@/components/Card";
import { cn } from "@/lib/utils";
import { useApi } from "@/hooks/useApi";
import {
  getActiveAssignedHoldings,
  getRealizedDispositions,
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

interface ActiveGroup {
  key: string;
  ticker: string;
  accountName: string | null;
  accountColor: string | null;
  assignmentStrike: number;
  assignmentExpiration: string;
  acquiredDate: string | null;
  openCallContracts: number;
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
        accountName: r.accountName,
        accountColor: r.accountColor,
        assignmentStrike: r.assignmentStrike,
        assignmentExpiration: r.assignmentExpiration,
        acquiredDate: r.acquiredDate,
        // Same across the batch (matched by ticker|strike|expiry|account).
        openCallContracts: r.openCallContracts,
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

export function AssignedSharesCard({ externalQuotes }: { externalQuotes?: Record<string, { price: number }> }) {
  const [tab, setTab] = useState<"active" | "realized">("active");
  const { data: active } = useApi(getActiveAssignedHoldings, []);
  const { data: realized } = useApi(getRealizedDispositions, []);

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
                  <th className={cn(thClass, "text-right")}>Current</th>
                  <th className={cn(thClass, "text-right")}>Mkt Value</th>
                  <th className={cn(thClass, "text-right")}>Unrealized P&amp;L</th>
                  <th className={cn(thClass, "text-right")}>% Gain</th>
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
                  const coveredShares = g.openCallContracts * 100;
                  return (
                    <tr key={g.key} className="border-b border-border/50 hover:bg-muted">
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
                          <span>
                            {fmtShares(Math.min(coveredShares, g.shares))} / {fmtShares(g.shares)} sh
                          </span>
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
                      <td className={cn(tdClass, "text-right", unreal != null && pnlColor(unreal))}>
                        {unreal != null ? fmtSigned(unreal) : "—"}
                      </td>
                      <td className={cn(tdClass, "text-right", pct != null && pnlColor(pct))}>
                        {pct != null ? fmtPct(pct) : "—"}
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
                  <tr key={g.key} className="border-b border-border/50 hover:bg-muted">
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
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="px-6 py-10 text-center text-sm text-muted-foreground">{text}</div>;
}
