import { useState, useEffect, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { TrendingUp, TrendingDown, Landmark, LineChart, ChevronRight, Pencil, Layers, Target } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { useApi } from "@/hooks/useApi";
import { getInvestmentAccounts, getAllocationSummary, refreshPrices, updateAccount } from "@/api";
import { formatCurrency } from "@/lib/utils";
import { isPriceRefreshNeeded } from "@/lib/priceUtils";
import { useNotifications } from "@/context/NotificationContext";
import type { InvestmentAccountSummary, AllocationSummary, AllocationItem } from "@/types";

// ── Allocation card ──────────────────────────────────────────────────────────

const FALLBACK_COLORS = [
  "#4f46e5", "#0891b2", "#059669", "#d97706",
  "#dc2626", "#7c3aed", "#db2777", "#0284c7",
];

function itemColor(item: AllocationItem, index: number): string {
  return item.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

interface BarSegment {
  pct: number;
  color: string;
  name: string;
  targetPct: number | null;
  targetValue: number | null;
  actualPct: number;
  actualValue: number;
}

interface BarTooltipState {
  segment: BarSegment;
  x: number;
  y: number;
}

// A single stacked bar row: each segment is proportional to its percentage.
// Hovering a segment shows a tooltip with both target and actual figures.
function StackedBar({ segments }: { segments: BarSegment[] }) {
  const [tooltip, setTooltip] = useState<BarTooltipState | null>(null);

  return (
    <div className="relative flex h-5 w-full overflow-hidden rounded-md bg-muted">
      {segments.map((s, i) => (
        <div
          key={i}
          style={{ width: `${Math.max(s.pct, 0)}%`, backgroundColor: s.color }}
          className="h-full transition-all cursor-default"
          onMouseEnter={(e) => setTooltip({ segment: s, x: e.clientX, y: e.clientY })}
          onMouseMove={(e) => setTooltip((t) => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
          onMouseLeave={() => setTooltip(null)}
        />
      ))}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-white border border-border rounded-lg shadow-lg px-3 py-2 text-xs min-w-[160px]"
          style={{ left: tooltip.x + 14, top: tooltip.y - 8, transform: "translateY(-100%)" }}
        >
          <p className="font-semibold mb-1.5">{tooltip.segment.name}</p>
          <div className="space-y-1">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Target</span>
              <span className="font-medium tabular-nums">
                {tooltip.segment.targetPct != null
                  ? `${tooltip.segment.targetPct.toFixed(1)}%`
                  : "—"}
                {tooltip.segment.targetValue != null && (
                  <span className="text-muted-foreground ml-1.5">
                    {formatCurrency(tooltip.segment.targetValue)}
                  </span>
                )}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Actual</span>
              <span className="font-medium tabular-nums">
                {tooltip.segment.actualPct.toFixed(1)}%
                <span className="text-muted-foreground ml-1.5">
                  {formatCurrency(tooltip.segment.actualValue)}
                </span>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Deviation bar for a single row: fill = actual%, tick = target%.
// Scale is the shared max across all rows so widths are comparable.
function DeviationBar({ actualPct, targetPct, scale, color, name, targetValue, actualValue }: {
  actualPct: number;
  targetPct: number | null;
  scale: number;
  color: string;
  name: string;
  targetValue: number | null;
  actualValue: number;
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);

  const fillPct = scale > 0 ? Math.min((actualPct / scale) * 100, 100) : 0;
  const tickPct = targetPct != null && scale > 0
    ? Math.min((targetPct / scale) * 100, 100)
    : null;

  return (
    <div
      className="relative h-4 w-full overflow-hidden rounded bg-muted cursor-default"
      onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTooltip(null)}
    >
      {/* Actual fill */}
      <div
        className="absolute inset-y-0 left-0 h-full rounded transition-all"
        style={{ width: `${fillPct}%`, backgroundColor: color }}
      />
      {/* Target tick */}
      {tickPct != null && (
        <div
          className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.2)]"
          style={{ left: `${tickPct}%` }}
        />
      )}
      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-white border border-border rounded-lg shadow-lg px-3 py-2 text-xs min-w-[160px]"
          style={{ left: tooltip.x + 14, top: tooltip.y - 8, transform: "translateY(-100%)" }}
        >
          <p className="font-semibold mb-1.5">{name}</p>
          <div className="space-y-1">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Target</span>
              <span className="font-medium tabular-nums">
                {targetPct != null ? `${targetPct.toFixed(1)}%` : "—"}
                {targetValue != null && (
                  <span className="text-muted-foreground ml-1.5">{formatCurrency(targetValue)}</span>
                )}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Actual</span>
              <span className="font-medium tabular-nums">
                {actualPct.toFixed(1)}%
                <span className="text-muted-foreground ml-1.5">{formatCurrency(actualValue)}</span>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DeviationBadge({ delta }: { delta: number }) {
  if (Math.abs(delta) < 0.05) {
    return <span className="text-xs text-muted-foreground tabular-nums">on target</span>;
  }
  const over = delta > 0;
  return (
    <span className={`text-xs font-medium tabular-nums ${over ? "text-amber-600" : "text-blue-600"}`}>
      {over ? "+" : ""}{delta.toFixed(1)}%
    </span>
  );
}

const ALLOCATION_FILTERS: { value: AllocationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "taxable", label: "Taxable" },
  { value: "tax-advantaged", label: "Tax-Advantaged" },
];

function AllocationCard({
  data,
  filter,
  onFilterChange,
}: {
  data: AllocationSummary;
  filter: AllocationFilter;
  onFilterChange: (f: AllocationFilter) => void;
}) {
  const { items, topLevelItems = items, unclassifiedValue, classifiedValue, hasAnyTargets } = data;

  const filterButtons = (
    <div className="flex gap-1">
      {ALLOCATION_FILTERS.map((f) => (
        <button
          key={f.value}
          onClick={() => onFilterChange(f.value)}
          className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
            f.value === filter
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  );

  if (!hasAnyTargets) {
    return (
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Asset Allocation
            </span>
          </div>
          {filterButtons}
        </div>
        <p className="text-sm text-muted-foreground">
          No target allocation configured.{" "}
          <Link to="/settings/asset-allocation" className="text-primary underline underline-offset-2">
            Set targets
          </Link>{" "}
          to see how your portfolio compares.
        </p>
      </Card>
    );
  }

  // Shared scale for deviation bars: max of all targets and actuals, rounded up
  // to the next 5%, with a minimum of 10%.
  const allPcts = items.flatMap((i) => [i.actualPct, i.targetPct ?? 0]);
  const scale = Math.max(Math.ceil(Math.max(...allPcts, 10) / 5) * 5, 10);

  // Segments for the two stacked overview bars — always grouped at the top level.
  // Both bars carry the full item data so the shared tooltip can show
  // target and actual figures regardless of which bar is hovered.
  const toSegment = (i: AllocationItem, idx: number): BarSegment => ({
    pct: 0, // overridden per bar below
    color: itemColor(i, idx),
    name: i.name,
    targetPct: i.targetPct,
    targetValue: i.targetPct != null ? (i.targetPct / 100) * classifiedValue : null,
    actualPct: i.actualPct,
    actualValue: i.actualValue,
  });

  const targetSegments: BarSegment[] = topLevelItems
    .filter((i) => i.targetPct != null)
    .map((i, idx) => ({ ...toSegment(i, idx), pct: i.targetPct! }));
  const actualSegments: BarSegment[] = topLevelItems
    .map((i, idx) => ({ ...toSegment(i, idx), pct: i.actualPct }));

  return (
    <Card className="p-0 py-2 space-y-4 border-0 shadow-none">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Asset Allocation
          </span>
        </div>
        {filterButtons}
      </div>

      {/* Overview: paired stacked bars */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">Target</span>
          <StackedBar segments={targetSegments} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">Actual</span>
          <StackedBar segments={actualSegments} />
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Per-class deviation rows */}
      <div className="space-y-2">
        {items.map((item, idx) => {
          const delta = item.targetPct != null ? item.actualPct - item.targetPct : null;
          const deltaDollars = delta != null ? (delta / 100) * classifiedValue : null;
          const color = itemColor(item, idx);
          return (
            <div key={item.id} className="grid items-center gap-x-3 gap-y-0.5"
              style={{ gridTemplateColumns: "10px 160px 1fr 44px 48px 60px 90px" }}>
              {/* Color dot */}
              <span
                className="h-2 w-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: color }}
              />
              {/* Name */}
              <span className="text-sm font-medium truncate">{item.name}</span>
              {/* Deviation bar */}
              <DeviationBar
                actualPct={item.actualPct}
                targetPct={item.targetPct}
                scale={scale}
                color={color}
                name={item.name}
                targetValue={item.targetPct != null ? (item.targetPct / 100) * classifiedValue : null}
                actualValue={item.actualValue}
              />
              {/* Target % */}
              <span className="text-right text-xs text-muted-foreground tabular-nums">
                {item.targetPct != null ? `${item.targetPct.toFixed(1)}%` : "—"}
              </span>
              {/* Actual % */}
              <span className="text-right text-xs tabular-nums font-medium">
                {item.actualPct.toFixed(1)}%
              </span>
              {/* Delta % */}
              <span className="text-right">
                {delta != null ? <DeviationBadge delta={delta} /> : null}
              </span>
              {/* Delta $ */}
              <span className={`text-right text-xs tabular-nums ${
                deltaDollars == null ? "" :
                Math.abs(deltaDollars) < 1 ? "text-muted-foreground" :
                deltaDollars > 0 ? "text-amber-600" : "text-blue-600"
              }`}>
                {deltaDollars != null
                  ? `${deltaDollars >= 0 ? "+" : "−"}${formatCurrency(Math.abs(deltaDollars))}`
                  : null}
              </span>
            </div>
          );
        })}

        {/* Unclassified row */}
        {unclassifiedValue > 0 && (
          <div className="grid items-center gap-x-3 pt-1 border-t border-border"
            style={{ gridTemplateColumns: "10px 160px 1fr 44px 48px 60px 90px" }}>
            <span className="h-2 w-2 rounded-sm bg-muted-foreground/30 flex-shrink-0" />
            <span className="text-sm text-muted-foreground col-span-2 min-w-0">
              <span className="mr-1">Unclassified / Not Included</span>
              <span className="text-xs">({formatCurrency(unclassifiedValue)})</span>
              <span className="mx-1 text-muted-foreground/40">·</span>
              <Link
                to="/investments/securities"
                className="text-xs text-primary underline underline-offset-2 whitespace-nowrap"
              >
                Classify in Securities
              </Link>
            </span>
            <span />
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Gain badge ──────────────────────────────────────────────────────────────

function GainBadge({ value, pct, className = "" }: { value: number; pct?: number | null; className?: string }) {
  const positive = value >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-sm font-medium ${
        positive ? "text-green-600" : "text-red-500"
      } ${className}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {formatCurrency(Math.abs(value))}
      {pct != null && (
        <span className="text-xs opacity-70">({Math.abs(pct).toFixed(2)}%)</span>
      )}
    </span>
  );
}

// ── Edit Balance Modal ───────────────────────────────────────────────────────

function EditBalanceModal({
  account,
  onClose,
  onSave,
}: {
  account: InvestmentAccountSummary | null;
  onClose: () => void;
  onSave: (id: string, balance: number) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) setValue(String(parseFloat(account.balance) || 0));
  }, [account]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setSaving(true);
    await onSave(account.id, parseFloat(value) || 0);
    setSaving(false);
  };

  return (
    <Modal open={!!account} onClose={onClose} title="Edit Balance">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">
            Current Balance — {account?.name}
          </label>
          <input
            type="number"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

type AllocationFilter = "all" | "taxable" | "tax-advantaged";

export function Investments() {
  const navigate = useNavigate();
  const { data: accounts, refetch } = useApi(() => getInvestmentAccounts(), []);
  const [allocationFilter, setAllocationFilter] = useState<AllocationFilter>("all");
  const { data: allocation, refetch: refetchAllocation } = useApi(
    () => getAllocationSummary(allocationFilter),
    [allocationFilter]
  );
  const refreshedRef = useRef(false);
  const [editingBalance, setEditingBalance] = useState<InvestmentAccountSummary | null>(null);
  const { notifications } = useNotifications();
  const pendingDividendAccountIds = new Set(
    notifications?.pendingDividends.map((g) => g.accountId) ?? []
  );

  useEffect(() => {
    if (!accounts || refreshedRef.current) return;
    const holdings = accounts.filter((a) => a.type === "INVESTMENT").flatMap((a) => a.holdings);
    if (isPriceRefreshNeeded(holdings)) {
      refreshedRef.current = true;
      refreshPrices("Investments")
        .then(() => { refetch(); refetchAllocation(); })
        .catch(() => { /* server logs the error */ });
    }
  }, [accounts, refetch]);

  const handleSaveBalance = async (id: string, balance: number) => {
    await updateAccount(id, { balance });
    setEditingBalance(null);
    refetch();
  };

  if (!accounts) return null;

  const investmentAccounts = accounts.filter((a) => a.type === "INVESTMENT");
  const bankingAccounts = accounts.filter(
    (a) => a.type === "CHECKING" || a.type === "SAVINGS"
  );

  const totalPortfolioValue = accounts.reduce((sum, a) => sum + a.totalMarketValue, 0);
  const totalGain = investmentAccounts.reduce((sum, a) => sum + a.totalGain, 0);
  const totalCost = investmentAccounts.reduce((sum, a) => sum + a.totalCost, 0);
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;

  const renderAccountRow = (account: InvestmentAccountSummary) => {
    const isBanking = account.type === "CHECKING" || account.type === "SAVINGS";
    return (
      <div
        key={account.id}
        role="button"
        tabIndex={0}
        onClick={() => navigate(`/investments/${account.id}`)}
        onKeyDown={(e) => e.key === "Enter" && navigate(`/investments/${account.id}`)}
        className="w-full text-left cursor-pointer"
      >
        <Card className="px-4 py-3 hover:shadow-md transition-shadow cursor-pointer">
          <div className="flex items-center gap-3">
            {/* Color dot */}
            <div
              className="h-8 w-8 flex-shrink-0 rounded-md flex items-center justify-center"
              style={account.color ? { backgroundColor: account.color } : { backgroundColor: "#e2e2df" }}
            >
              {isBanking ? (
                <Landmark className="h-4 w-4 text-gray-500" />
              ) : (
                <LineChart className="h-4 w-4 text-gray-500" />
              )}
            </div>

            {/* Name + meta */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <p className="font-medium text-sm truncate">{account.name}</p>
                {!isBanking && pendingDividendAccountIds.has(account.id) && (
                  <span className="shrink-0 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700 whitespace-nowrap">
                    Pending dividends
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {isBanking
                  ? account.type === "CHECKING" ? "Checking · Cash" : "Savings · Cash"
                  : (() => { const n = account.holdings.length + (account.manualCount ?? 0); return `${n} holding${n !== 1 ? "s" : ""}`; })()}
              </p>
            </div>

            {/* Value + gain */}
            <div className="text-right flex-shrink-0 mr-2">
              <p className="font-bold tabular-nums text-sm">
                {formatCurrency(account.totalMarketValue)}
              </p>
              {!isBanking && account.totalGain !== 0 && (
                <GainBadge value={account.totalGain} pct={account.totalGainPct} />
              )}
            </div>

            {isBanking ? (
              <button
                onClick={(e) => { e.stopPropagation(); setEditingBalance(account); }}
                className="rounded p-1 hover:bg-accent flex-shrink-0"
              >
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
          </div>
        </Card>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Investments</h2>
        <Link
          to="/investments/securities"
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <Layers className="h-4 w-4" />
          Securities
        </Link>
      </div>

      {/* Top row: allocation (2/3) + portfolio summary (1/3) */}
      {(allocation || accounts.length > 0) && (
        <div className="flex flex-col lg:flex-row items-start gap-6">
          {allocation && (
            <div className="min-w-0 basis-2/3 w-full">
              <AllocationCard
                data={allocation}
                filter={allocationFilter}
                onFilterChange={setAllocationFilter}
              />
            </div>
          )}
          {accounts.length > 0 && (
            <div className={`min-w-0 w-full ${allocation ? "basis-1/3" : ""}`}>
              <Card className="p-4">
                <div className="divide-y divide-border">
                  <div className="pb-3">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                      Total Portfolio
                    </p>
                    <p className="text-xl font-bold">{formatCurrency(totalPortfolioValue)}</p>
                  </div>
                  <div className="py-3">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                      Total Gain / Loss
                    </p>
                    {totalCost > 0 ? (
                      <GainBadge value={totalGain} pct={totalGainPct} className="text-xl" />
                    ) : (
                      <p className="text-xl font-bold text-muted-foreground">—</p>
                    )}
                  </div>
                  <div className="pt-3">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                      Cash
                    </p>
                    <p className="text-xl font-bold">
                      {formatCurrency(bankingAccounts.reduce((s, a) => s + a.totalMarketValue, 0))}
                    </p>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* Two-column layout: investment accounts left, banking right */}
      {(investmentAccounts.length > 0 || bankingAccounts.length > 0) && (
        <div className="flex flex-col lg:flex-row items-start gap-6">
          {/* Investment accounts */}
          {investmentAccounts.length > 0 && (
            <div className="min-w-0 basis-2/3 space-y-2">
              <div className="flex items-center gap-2 py-1">
                <LineChart className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Investment Accounts
                </span>
              </div>
              <div className="space-y-1.5">
                {investmentAccounts.map(renderAccountRow)}
              </div>
            </div>
          )}

          {/* Banking accounts */}
          {bankingAccounts.length > 0 && (
            <div className="min-w-0 basis-1/3 space-y-2">
              <div className="flex items-center gap-2 py-1">
                <Landmark className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Banking (Cash)
                </span>
              </div>
              <div className="space-y-1.5">
                {bankingAccounts.map(renderAccountRow)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {accounts.length === 0 && (
        <Card className="p-8 text-center">
          <LineChart className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="font-semibold text-lg mb-1">No investment or banking accounts</p>
          <p className="text-muted-foreground text-sm">
            Add accounts in{" "}
            <button
              className="text-primary underline"
              onClick={() => navigate("/accounts")}
            >
              Accounts
            </button>{" "}
            to get started.
          </p>
        </Card>
      )}

      <EditBalanceModal
        account={editingBalance}
        onClose={() => setEditingBalance(null)}
        onSave={handleSaveBalance}
      />
    </div>
  );
}
