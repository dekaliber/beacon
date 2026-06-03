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
const fmtDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });

const pnlColor = (n: number) =>
  n > 0 ? "text-emerald-600" : n < 0 ? "text-rose-600" : "text-muted-foreground";

const thClass =
  "px-3 py-2 text-left font-mono text-10 font-medium tracking-[0.11em] uppercase text-[var(--color-ink-3)] whitespace-nowrap";
const tdClass = "px-3 py-2 text-13 font-mono tabular-nums whitespace-nowrap";

interface ActiveGroup {
  key: string;
  ticker: string;
  accountName: string | null;
  assignmentStrike: number;
  assignmentExpiration: string;
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
    } else {
      map.set(key, {
        key,
        ticker: r.ticker,
        accountName: r.accountName,
        assignmentStrike: r.assignmentStrike,
        assignmentExpiration: r.assignmentExpiration,
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

export function AssignedSharesCard() {
  const [tab, setTab] = useState<"active" | "realized">("active");
  const { data: active } = useApi(getActiveAssignedHoldings, []);
  const { data: realized } = useApi(getRealizedDispositions, []);

  const [quotes, setQuotes] = useState<Record<string, { price: number }>>({});
  const activeTickers = useMemo(
    () => [...new Set((active ?? []).map((r) => r.ticker))],
    [active]
  );
  useEffect(() => {
    if (activeTickers.length === 0) return;
    let cancelled = false;
    getUnderlyingQuotes(activeTickers)
      .then((q) => {
        if (!cancelled) setQuotes(q);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTickers.join(",")]);

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

  // Active portfolio totals (only for groups with a known quote)
  let totalUnrealized = 0;
  let totalMarketValue = 0;
  for (const g of activeGroups) {
    const price = quotes[g.ticker]?.price;
    if (price != null) {
      totalMarketValue += price * g.shares;
      totalUnrealized += (price - g.assignmentStrike) * g.shares;
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-border px-4">
        <div className="flex">
          <button className={tabClass(tab === "active")} onClick={() => setTab("active")}>
            Assigned Holdings
            {activeCount > 0 && (
              <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-xs px-1.5 py-0.5 font-medium">
                {activeCount}
              </span>
            )}
          </button>
          <button className={tabClass(tab === "realized")} onClick={() => setTab("realized")}>
            Realized
            {realizedCount > 0 && (
              <span className="ml-2 inline-flex items-center justify-center rounded-full bg-border text-muted-foreground text-xs px-1.5 py-0.5 font-medium">
                {realizedCount}
              </span>
            )}
          </button>
        </div>
        <span className="text-xs text-muted-foreground pr-1">Premium excluded · vs. assignment strike</span>
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
                  <th className={cn(thClass, "text-right")}>Shares</th>
                  <th className={cn(thClass, "text-right")}>Assign Strike</th>
                  <th className={cn(thClass, "text-right")}>Current</th>
                  <th className={cn(thClass, "text-right")}>Mkt Value</th>
                  <th className={cn(thClass, "text-right")}>Unrealized</th>
                  <th className={cn(thClass, "text-right")}>%</th>
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
                  return (
                    <tr key={g.key} className="border-b border-border/50 hover:bg-[#F5F8FC]">
                      <td className={cn(tdClass, "font-semibold")}>{g.ticker}</td>
                      <td className={cn(tdClass, "text-muted-foreground text-xs")}>
                        {g.accountName ?? "—"}
                      </td>
                      <td className={cn(tdClass, "text-right")}>{fmtShares(g.shares)}</td>
                      <td className={cn(tdClass, "text-right")}>${fmtUSD(g.assignmentStrike)}</td>
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
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className={tdClass} colSpan={5}>
                    Total
                  </td>
                  <td className={cn(tdClass, "text-right")}>${fmtUSD(totalMarketValue)}</td>
                  <td className={cn(tdClass, "text-right", pnlColor(totalUnrealized))}>
                    {fmtSigned(totalUnrealized)}
                  </td>
                  <td className={tdClass} />
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
                <th className={cn(thClass, "text-right")}>Shares Sold</th>
                <th className={cn(thClass, "text-right")}>Assign Strike</th>
                <th className={cn(thClass, "text-right")}>Avg Sale</th>
                <th className={cn(thClass, "text-right")}>Realized</th>
                <th className={cn(thClass, "text-right")}>%</th>
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
                  <tr key={g.key} className="border-b border-border/50 hover:bg-[#F5F8FC]">
                    <td className={cn(tdClass, "font-semibold")}>{g.ticker}</td>
                    <td className={cn(tdClass, "text-right")}>{fmtShares(g.shares)}</td>
                    <td className={cn(tdClass, "text-right")}>${fmtUSD(g.assignmentStrike)}</td>
                    <td className={cn(tdClass, "text-right")}>${fmtUSD(avgSale)}</td>
                    <td className={cn(tdClass, "text-right", pnlColor(g.realizedPnl))}>
                      {fmtSigned(g.realizedPnl)}
                    </td>
                    <td className={cn(tdClass, "text-right", pnlColor(pct))}>{fmtPct(pct)}</td>
                    <td className={cn(tdClass, "text-right text-muted-foreground text-xs")}>
                      {fmtDate(g.latestSaleDate)}
                    </td>
                    <td className={tdClass}>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                          g.via === "CC"
                            ? "bg-primary/10 text-primary"
                            : g.via === "Direct"
                            ? "bg-border text-muted-foreground"
                            : "bg-amber-100 text-amber-700"
                        )}
                      >
                        {g.via === "CC" ? "Covered call" : g.via}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold">
                <td className={tdClass} colSpan={4}>
                  Net realized
                </td>
                <td
                  className={cn(
                    tdClass,
                    "text-right",
                    pnlColor(realized?.netRealizedPnl ?? 0)
                  )}
                >
                  {fmtSigned(realized?.netRealizedPnl ?? 0)}
                </td>
                <td className={tdClass} colSpan={3} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </Card>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="px-6 py-10 text-center text-sm text-muted-foreground">{text}</div>;
}
