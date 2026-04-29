import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  TrendingUp, TrendingDown, LineChart, ChevronRight,
  Library, Target, ArrowUpRight, Sliders, X,
} from "lucide-react";
import { PageHeadingMenu } from "@/components/PageHeadingMenu";
import { useApi } from "@/hooks/useApi";
import {
  getInvestmentAccounts, getAllocationSummary, refreshPrices,
  getWithdrawalSummary, getInvestmentSettings,
} from "@/api";
import { formatCurrency, cn } from "@/lib/utils";
import { isPriceRefreshNeeded } from "@/lib/priceUtils";
import { useNotifications } from "@/context/NotificationContext";
import { useDemo } from "@/context/DemoContext";
import { scaleInvestmentAccounts, scaleAllocationSummary } from "@/lib/demo";
import type {
  InvestmentAccountSummary, AllocationSummary, AllocationItem,
  WithdrawalSummary, InvestmentSettings,
} from "@/types";

type AllocationFilter = "all" | "taxable" | "tax-advantaged";
type RebalanceTab = "manual" | "auto";

const FALLBACK_COLORS = [
  "#4f46e5", "#0891b2", "#059669", "#d97706",
  "#dc2626", "#7c3aed", "#db2777", "#0284c7",
];

function itemColor(item: AllocationItem, index: number): string {
  return item.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function annualizedRate(total: number, months: number, denominator: number): number | null {
  if (denominator <= 0 || months <= 0) return null;
  return (total * (12 / months)) / denominator;
}

const NO_SPINNER = "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const scrollY = window.scrollY;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function GainBadge({
  value, pct, label, className = "",
}: {
  value: number; pct?: number | null; label?: string; className?: string;
}) {
  const positive = value >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${positive ? "text-green-600" : "text-red-500"} ${className}`}>
      <Icon className="h-3.5 w-3.5" />
      {formatCurrency(Math.abs(value))}
      {pct != null && <span className="text-xs opacity-70">({Math.abs(pct).toFixed(2)}%)</span>}
      {label != null && <span className="text-xs opacity-50">{label}</span>}
    </span>
  );
}

function SummaryRow({
  label, value, total, muted = false,
}: {
  label: string; value: number; total: number; muted?: boolean;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className={`flex items-center justify-between gap-3 ${muted ? "text-muted-foreground" : ""}`}>
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-2 tabular-nums">
        <span className="text-sm font-medium">{formatCurrency(value)}</span>
        <span className="text-xs text-muted-foreground w-8 text-right">{pct.toFixed(0)}%</span>
      </div>
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

// ── Stacked bar (hover-free; mobile taps not supported on these overview bars) ──

interface BarSegment {
  pct: number;
  color: string;
  name: string;
  targetPct: number | null;
  actualPct: number;
  actualValue: number;
}

function StackedBar({ segments }: { segments: BarSegment[] }) {
  return (
    <div className="flex h-5 w-full overflow-hidden rounded-md bg-muted">
      {segments.map((s, i) => (
        <div
          key={i}
          style={{ width: `${Math.max(s.pct, 0)}%`, backgroundColor: s.color }}
          className="h-full transition-all"
        />
      ))}
    </div>
  );
}

// ── Tax breakdown bottom sheet ─────────────────────────────────────────────────

function TaxSheet({
  open, onClose,
  investedValue, taxableValue, taxableCostBasisPct,
  traditionalValue, rothValue, hsaValue, plan529Value,
}: {
  open: boolean; onClose: () => void;
  investedValue: number; taxableValue: number; taxableCostBasisPct: number | null;
  traditionalValue: number; rothValue: number; hsaValue: number; plan529Value: number;
}) {
  useBodyScrollLock(open);
  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col rounded-t-2xl bg-background shadow-xl transition-transform duration-250 ease-out",
          open ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">Tax Buckets</h2>
            <p className="text-xs text-muted-foreground">of invested value</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 space-y-2 pb-8">
          <div>
            <SummaryRow label="Taxable" value={taxableValue} total={investedValue} />
            {taxableCostBasisPct != null && taxableCostBasisPct > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5 text-right pr-10">
                {taxableCostBasisPct.toFixed(0)}% cost basis
              </p>
            )}
          </div>
          {traditionalValue > 0 && <SummaryRow label="Traditional" value={traditionalValue} total={investedValue} />}
          {rothValue > 0 && <SummaryRow label="Roth" value={rothValue} total={investedValue} />}
          {hsaValue > 0 && <SummaryRow label="HSA" value={hsaValue} total={investedValue} />}
          {plan529Value > 0 && <SummaryRow label="529 Plan" value={plan529Value} total={investedValue} />}
        </div>
      </div>
    </>
  );
}

// ── Withdrawal history bottom sheet ───────────────────────────────────────────

function WithdrawalSheet({
  open, onClose, summary, settings, portfolioValue,
}: {
  open: boolean; onClose: () => void;
  summary: WithdrawalSummary | null | undefined;
  settings: InvestmentSettings | null | undefined;
  portfolioValue: number;
}) {
  useBodyScrollLock(open);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const effectiveDenominator = settings?.withdrawalRateDenominator ?? portfolioValue;
  const targetRate = settings?.withdrawalRateTarget ?? null;

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;
  const monthMap = Object.fromEntries(
    (summary?.monthlySummaries ?? []).map((m) => [m.month, m.total]),
  );
  const allMonths = Array.from({ length: 12 }, (_, i) => {
    const key = `${currentYear}-${String(i + 1).padStart(2, "0")}`;
    return {
      month: key,
      total: monthMap[key] ?? 0,
      isFuture: i + 1 > currentMonth,
      label: new Date(`${key}-01T12:00:00`).toLocaleDateString("en-US", { month: "short" }),
    };
  });

  const maxMonthTotal = Math.max(...allMonths.map((m) => m.total), 1);
  const chartMax = maxMonthTotal * 1.25;
  const targetMonthlyAmount = targetRate != null ? (targetRate * effectiveDenominator) / 12 : null;
  const targetLinePct = targetMonthlyAmount != null ? Math.min(targetMonthlyAmount / chartMax, 1) : null;

  const selectedData = selectedMonth ? allMonths.find((m) => m.month === selectedMonth) ?? null : null;
  const selectedRate = selectedData ? annualizedRate(selectedData.total, 1, effectiveDenominator) : null;

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col rounded-t-2xl bg-background shadow-xl transition-transform duration-250 ease-out",
          open ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-border">
          <h2 className="text-base font-semibold">Monthly Withdrawals</h2>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4">
          {/* Bar chart */}
          <div className="relative flex items-end gap-0" style={{ height: "130px" }}>
            {targetLinePct != null && (
              <div
                className="absolute inset-x-0 border-t border-dashed border-destructive opacity-50 pointer-events-none z-10"
                style={{ bottom: `${13 + targetLinePct * 104}px` }}
              />
            )}
            {allMonths.map((m) => {
              const heightPct = m.total > 0 ? (m.total / chartMax) * 100 : 0;
              const isSelected = selectedMonth === m.month;
              return (
                <div
                  key={m.month}
                  className="flex-1 flex flex-col items-center cursor-pointer"
                  style={{ gap: "4px" }}
                  onClick={() => setSelectedMonth(isSelected ? null : m.month)}
                >
                  <div className="w-full flex items-end justify-center" style={{ height: "104px" }}>
                    <div
                      className={`w-[60%] rounded-t-sm transition-colors ${
                        m.isFuture
                          ? "bg-muted"
                          : isSelected
                          ? "bg-primary"
                          : "bg-primary/50"
                      }`}
                      style={{ height: heightPct > 0 ? `${heightPct}%` : m.isFuture ? "3px" : "2px" }}
                    />
                  </div>
                  <span className={`text-[9px] leading-none tabular-nums text-center w-full ${
                    isSelected ? "text-foreground font-semibold" : m.isFuture ? "text-muted-foreground/40" : "text-muted-foreground"
                  }`}>
                    {m.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Selected month detail */}
          {selectedData ? (
            <div className="mt-4 rounded-lg bg-muted/50 px-4 py-3 space-y-1.5">
              <p className="text-sm font-semibold">{selectedData.label} {currentYear}</p>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Withdrawn</span>
                <span className="font-medium tabular-nums">{formatCurrency(selectedData.total)}</span>
              </div>
              {!selectedData.isFuture && selectedRate !== null && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Ann. rate</span>
                  <span className="font-medium tabular-nums">{(selectedRate * 100).toFixed(2)}%</span>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-3 text-center text-xs text-muted-foreground">Tap a bar to see details</p>
          )}
        </div>

        <div className="px-4 pb-8 shrink-0">
          <Link
            to="/investments/withdrawals"
            className="flex items-center justify-center gap-1 text-sm text-primary"
            onClick={onClose}
          >
            View full history
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </>
  );
}

// ── Rebalancing simulator (full-screen modal) ─────────────────────────────────

function computeAutoAdditions(
  items: AllocationItem[],
  classifiedValue: number,
  customTargetPcts: Record<string, number>,
  tolerancePct: number,
): Record<string, number> {
  const additions: Record<string, number> = {};
  items.forEach((i) => { additions[i.id] = 0; });
  for (let iter = 0; iter < 40; iter++) {
    const totalAdded = Object.values(additions).reduce((s, v) => s + v, 0);
    const newTotal = classifiedValue + totalAdded;
    let changed = false;
    for (const item of items) {
      const targetPct = customTargetPcts[item.id] ?? item.targetPct ?? 0;
      const effectiveTarget = Math.max(0, (targetPct - tolerancePct) / 100);
      const needed = Math.max(0, effectiveTarget * newTotal - item.actualValue);
      if (Math.abs(needed - additions[item.id]) > 0.01) changed = true;
      additions[item.id] = needed;
    }
    if (!changed) break;
  }
  return additions;
}

function computeAutoRebalance(
  items: AllocationItem[],
  classifiedValue: number,
  customTargetPcts: Record<string, number>,
  tolerancePct: number,
): Record<string, number> {
  const S = classifiedValue;
  const adjustments: Record<string, number> = {};
  for (const item of items) {
    const targetPct = customTargetPcts[item.id] ?? item.targetPct ?? 0;
    const actualPct = S > 0 ? (item.actualValue / S) * 100 : 0;
    if (actualPct > targetPct + tolerancePct) {
      adjustments[item.id] = ((targetPct + tolerancePct) / 100) * S - item.actualValue;
    } else if (actualPct < targetPct - tolerancePct) {
      adjustments[item.id] = ((targetPct - tolerancePct) / 100) * S - item.actualValue;
    } else {
      adjustments[item.id] = 0;
    }
  }
  return adjustments;
}

function RebalanceModal({
  data, isOpen, onClose,
}: {
  data: AllocationSummary; isOpen: boolean; onClose: () => void;
}) {
  useBodyScrollLock(isOpen);
  const { items, classifiedValue } = data;
  const [tab, setTab] = useState<RebalanceTab>("manual");
  const [manualAdj, setManualAdj] = useState<Record<string, string>>(() => {
    try {
      const stored = localStorage.getItem("rebalance-manual-adj");
      return stored ? JSON.parse(stored) : {};
    } catch { return {}; }
  });
  const [tolerancePct, setTolerancePct] = useState(0.5);
  const [rebalanceMode, setRebalanceMode] = useState<"buy-only" | "buy-sell">("buy-only");

  useEffect(() => {
    try { localStorage.setItem("rebalance-manual-adj", JSON.stringify(manualAdj)); } catch {}
  }, [manualAdj]);

  useEffect(() => {
    if (!isOpen) return;
    setTab("manual");
    setTolerancePct(0.5);
    setRebalanceMode("buy-only");
  }, [isOpen]);

  if (!isOpen) return null;

  const manualDelta = items.reduce((s, item) => s + (parseFloat(manualAdj[item.id] ?? "0") || 0), 0);
  const manualNewTotal = classifiedValue + manualDelta;

  const autoTargets: Record<string, number> = {};
  items.forEach((i) => { autoTargets[i.id] = i.targetPct ?? 0; });

  const autoAdjustments = rebalanceMode === "buy-only"
    ? computeAutoAdditions(items, classifiedValue, autoTargets, tolerancePct)
    : computeAutoRebalance(items, classifiedValue, autoTargets, tolerancePct);
  const autoNetCash = Object.values(autoAdjustments).reduce((s, v) => s + v, 0);
  const autoNewTotal = classifiedValue + autoNetCash;

  const toSeg = (item: AllocationItem, idx: number, pct: number): BarSegment => ({
    pct,
    color: itemColor(item, idx),
    name: item.name,
    targetPct: item.targetPct,
    actualPct: item.actualPct,
    actualValue: item.actualValue,
  });

  const currentSegments = items.map((item, idx) => toSeg(item, idx, item.actualPct));
  const manualProjectedSegments = items.map((item, idx) => {
    const adj = parseFloat(manualAdj[item.id] ?? "0") || 0;
    const newValue = Math.max(0, item.actualValue + adj);
    const newPct = manualNewTotal > 0 ? (newValue / manualNewTotal) * 100 : 0;
    return toSeg(item, idx, Math.max(newPct, 0));
  });
  const autoProjectedSegments = items.map((item, idx) => {
    const adj = autoAdjustments[item.id] ?? 0;
    const newPct = autoNewTotal > 0 ? ((item.actualValue + adj) / autoNewTotal) * 100 : 0;
    return toSeg(item, idx, Math.max(newPct, 0));
  });

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-base font-semibold">Rebalancing Simulator</h2>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 border-b border-border px-4 pt-1">
        {(["manual", "auto"] as RebalanceTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`mr-4 pb-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground"
            }`}
          >
            {t === "manual" ? "Manual" : "Auto-Calculate"}
          </button>
        ))}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="p-4 space-y-5">

          {tab === "manual" && (
            <>
              {/* Overview bars */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Projected Allocation</p>
                <div className="flex items-center gap-2">
                  <span className="w-11 shrink-0 text-right text-xs text-muted-foreground">After</span>
                  <StackedBar segments={manualProjectedSegments} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-11 shrink-0 text-right text-xs text-muted-foreground">Before</span>
                  <StackedBar segments={currentSegments} />
                </div>
              </div>

              {/* Per-item rows */}
              <div className="divide-y divide-border">
                {items.map((item, idx) => {
                  const adj = parseFloat(manualAdj[item.id] ?? "0") || 0;
                  const newValue = Math.max(0, item.actualValue + adj);
                  const newPct = manualNewTotal > 0 ? (newValue / manualNewTotal) * 100 : 0;
                  const delta = item.targetPct != null ? newPct - item.targetPct : null;
                  const color = itemColor(item, idx);
                  return (
                    <div key={item.id} className="py-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                        <span className="text-sm font-medium flex-1 truncate">{item.name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">now {item.actualPct.toFixed(1)}%</span>
                      </div>
                      <div className="flex items-center gap-2 pl-[18px]">
                        <div className="relative flex-1">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none select-none">$</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={manualAdj[item.id] ?? ""}
                            onChange={(e) => setManualAdj((prev) => ({ ...prev, [item.id]: e.target.value }))}
                            placeholder="0"
                            className={`w-full rounded-md border border-border bg-background pl-6 pr-3 py-2 text-sm text-right tabular-nums focus:outline-none focus:border-primary ${NO_SPINNER}`}
                          />
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`text-sm tabular-nums font-medium ${
                            delta == null ? "" : Math.abs(delta) < 0.5 ? "text-green-600" : delta > 0 ? "text-amber-600" : "text-blue-600"
                          }`}>
                            → {newPct.toFixed(1)}%
                          </span>
                          {delta != null && <DeviationBadge delta={delta} />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {tab === "auto" && (
            <>
              {/* Controls */}
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Mode</p>
                  <div className="flex gap-1 rounded-lg bg-secondary p-1 w-fit">
                    {(["buy-only", "buy-sell"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setRebalanceMode(m)}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                          rebalanceMode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                        }`}
                      >
                        {m === "buy-only" ? "Buy only" : "Buy & sell"}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tolerance</p>
                    <span className="text-sm tabular-nums font-semibold text-primary">±{tolerancePct.toFixed(1)}%</span>
                  </div>
                  <input
                    type="range" min={0} max={5} step={0.1}
                    value={tolerancePct}
                    onChange={(e) => setTolerancePct(parseFloat(e.target.value))}
                    className="w-full accent-primary"
                  />
                  <p className="text-xs text-muted-foreground">
                    {rebalanceMode === "buy-only"
                      ? <>Buy into under-allocated classes until each is within{" "}
                          <span className="font-medium">{tolerancePct.toFixed(1)}%</span> of target.</>
                      : <>Buy under-allocated and sell over-allocated to bring each within{" "}
                          <span className="font-medium">{tolerancePct.toFixed(1)}%</span> of target.</>
                    }
                  </p>
                </div>
              </div>

              {/* Overview bars */}
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Projected Allocation</p>
                <div className="flex items-center gap-2">
                  <span className="w-11 shrink-0 text-right text-xs text-muted-foreground">After</span>
                  <StackedBar segments={autoProjectedSegments} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-11 shrink-0 text-right text-xs text-muted-foreground">Before</span>
                  <StackedBar segments={currentSegments} />
                </div>
              </div>

              {/* Per-item rows */}
              <div className="divide-y divide-border">
                {items.map((item, idx) => {
                  const adj = autoAdjustments[item.id] ?? 0;
                  const newValue = item.actualValue + adj;
                  const newPct = autoNewTotal > 0 ? (newValue / autoNewTotal) * 100 : 0;
                  const delta = item.targetPct != null ? newPct - item.targetPct : null;
                  const isBuy = adj > 1;
                  const isSell = adj < -1;
                  const deltaColor = delta == null ? "text-muted-foreground"
                    : Math.abs(delta) < tolerancePct ? "text-green-600"
                    : delta > 0 ? "text-amber-600"
                    : "text-blue-600";
                  const color = itemColor(item, idx);
                  return (
                    <div key={item.id} className="py-3">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                        <span className="text-sm font-medium flex-1 truncate">{item.name}</span>
                        <span className={`text-sm font-semibold tabular-nums ${
                          isBuy ? "text-blue-600" : isSell ? "text-amber-600" : "text-muted-foreground"
                        }`}>
                          {isBuy ? `+${formatCurrency(adj)}` : isSell ? `−${formatCurrency(Math.abs(adj))}` : "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 pl-[18px] mt-1 text-xs">
                        <span className="tabular-nums text-muted-foreground">{item.actualPct.toFixed(1)}%</span>
                        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className={`tabular-nums font-medium ${deltaColor}`}>{newPct.toFixed(1)}%</span>
                        {delta != null && (
                          <span className={`tabular-nums ${deltaColor}`}>
                            ({delta >= 0 ? "+" : ""}{delta.toFixed(1)}%)
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Sticky footer */}
      <div className="shrink-0 border-t border-border px-4 py-4">
        {tab === "manual" && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Net cash deployed</span>
            <span className={`text-sm font-semibold tabular-nums ${
              manualDelta > 0 ? "text-green-600" : manualDelta < 0 ? "text-red-500" : "text-muted-foreground"
            }`}>
              {manualDelta >= 0 ? "+" : "−"}{formatCurrency(Math.abs(manualDelta))}
            </span>
          </div>
        )}
        {tab === "auto" && (
          <div className="flex items-center justify-between">
            {rebalanceMode === "buy-only" ? (
              <>
                <span className="text-sm text-muted-foreground">Total cash to deploy</span>
                <span className="text-sm font-semibold tabular-nums text-blue-600">
                  {autoNetCash > 1 ? `+${formatCurrency(autoNetCash)}` : formatCurrency(0)}
                </span>
              </>
            ) : autoNetCash > 1 ? (
              <>
                <span className="text-sm text-muted-foreground">Net cash to deploy</span>
                <span className="text-sm font-semibold tabular-nums text-blue-600">+{formatCurrency(autoNetCash)}</span>
              </>
            ) : autoNetCash < -1 ? (
              <>
                <span className="text-sm text-muted-foreground">Net cash proceeds</span>
                <span className="text-sm font-semibold tabular-nums text-amber-600">−{formatCurrency(Math.abs(autoNetCash))}</span>
              </>
            ) : (
              <>
                <span className="text-sm text-muted-foreground">Net cash</span>
                <span className="text-sm font-semibold tabular-nums text-muted-foreground">{formatCurrency(0)}</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

const ALLOCATION_FILTERS: { value: AllocationFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "taxable", label: "Taxable" },
  { value: "tax-advantaged", label: "Tax-Adv." },
];

export function MobileInvestments() {
  const navigate = useNavigate();
  const { data: accounts, refetch } = useApi(() => getInvestmentAccounts(), []);
  const [allocationFilter, setAllocationFilter] = useState<AllocationFilter>("all");
  const [showTaxSheet, setShowTaxSheet] = useState(false);
  const [showWithdrawalSheet, setShowWithdrawalSheet] = useState(false);
  const [showRebalance, setShowRebalance] = useState(false);
  const { data: allocation, refetch: refetchAllocation } = useApi(
    () => getAllocationSummary(allocationFilter),
    [allocationFilter],
  );
  const { data: withdrawalSummary } = useApi(
    () => getWithdrawalSummary(new Date().getFullYear()),
    [],
  );
  const { data: investmentSettings } = useApi(() => getInvestmentSettings(), []);
  const refreshedRef = useRef(false);
  const { notifications } = useNotifications();
  const pendingDividendAccountIds = new Set(
    notifications?.pendingDividends.map((g) => g.accountId) ?? [],
  );
  const { isDemoMode, demoFactor } = useDemo();
  const displayAccounts = useMemo(() => {
    const all = isDemoMode && accounts ? scaleInvestmentAccounts(accounts, demoFactor) : accounts;
    return all?.filter((a) => a.type === "INVESTMENT") ?? null;
  }, [accounts, isDemoMode, demoFactor]);
  const displayAllocation = useMemo(
    () => isDemoMode && allocation ? scaleAllocationSummary(allocation, demoFactor) : allocation,
    [allocation, isDemoMode, demoFactor],
  );

  useEffect(() => {
    if (!accounts || refreshedRef.current) return;
    const holdings = accounts.filter((a) => a.type === "INVESTMENT").flatMap((a) => a.holdings);
    if (isPriceRefreshNeeded(holdings)) {
      refreshedRef.current = true;
      refreshPrices("Investments")
        .then(() => { refetch(); refetchAllocation(); })
        .catch(() => {});
    }
  }, [accounts, refetch]);

  if (!displayAccounts) return null;

  const investmentAccounts = displayAccounts;

  const totalPortfolioValue = displayAccounts.reduce((sum, a) => sum + a.totalMarketValue, 0);
  const totalDayGain = investmentAccounts.reduce((sum, a) => sum + (a.totalDayGain ?? 0), 0);
  const totalDayGainPct = totalPortfolioValue > 0 ? (totalDayGain / totalPortfolioValue) * 100 : null;

  const settlementCash = investmentAccounts.reduce((sum, a) => sum + (a.cashBalance ?? 0), 0);
  const classifiedCashHoldings = investmentAccounts.reduce((sum, a) => sum + a.classifiedCashValue, 0);
  const totalCashValue = settlementCash + classifiedCashHoldings;
  const untrackedValue = investmentAccounts.reduce((sum, a) => sum + a.untrackedValue, 0);
  const investedValue = totalPortfolioValue - totalCashValue - untrackedValue;

  const nonCashValue = (a: InvestmentAccountSummary) =>
    a.totalMarketValue - (a.cashBalance ?? 0) - a.classifiedCashValue - a.untrackedValue;
  const taxableAccts = investmentAccounts.filter((a) => !a.isTaxAdvantaged);
  const taxableValue = taxableAccts.reduce((sum, a) => sum + nonCashValue(a), 0);
  const taxableCostBasis = taxableAccts.reduce((sum, a) => sum + a.totalCost, 0);
  const taxableCostBasisPct = taxableValue > 0 ? (taxableCostBasis / taxableValue) * 100 : null;
  const traditionalValue = investmentAccounts
    .filter((a) => a.taxAdvantageType === "TRADITIONAL").reduce((sum, a) => sum + nonCashValue(a), 0);
  const rothValue = investmentAccounts
    .filter((a) => a.taxAdvantageType === "ROTH").reduce((sum, a) => sum + nonCashValue(a), 0);
  const hsaValue = investmentAccounts
    .filter((a) => a.taxAdvantageType === "HSA").reduce((sum, a) => sum + nonCashValue(a), 0);
  const plan529Value = investmentAccounts
    .filter((a) => a.taxAdvantageType === "PLAN_529").reduce((sum, a) => sum + nonCashValue(a), 0);
  const hasTaxData = taxableValue > 0 || traditionalValue > 0 || rothValue > 0 || hsaValue > 0 || plan529Value > 0;

  const effectiveDenominator = investmentSettings?.withdrawalRateDenominator ?? totalPortfolioValue;
  const targetRate = investmentSettings?.withdrawalRateTarget ?? null;
  const ytdTotal = withdrawalSummary?.ytdTotal ?? 0;
  const ytdMonths = withdrawalSummary?.ytdMonths ?? 1;
  const ytdRate = annualizedRate(ytdTotal, ytdMonths, effectiveDenominator);
  const hasRate = ytdRate !== null && effectiveDenominator > 0;
  const rateStr = hasRate ? `${(ytdRate! * 100).toFixed(2)}%` : "—";

  const renderAccountCard = (account: InvestmentAccountSummary) => (
    <div
      key={account.id}
      className="flex items-center gap-3 py-3 cursor-pointer active:opacity-60"
      onClick={() => navigate(`/investments/${account.id}`)}
    >
      <div
        className="h-9 w-9 flex-shrink-0 rounded-md flex items-center justify-center"
        style={account.color ? { backgroundColor: account.color } : { backgroundColor: "#e2e2df" }}
      >
        <LineChart className="h-4 w-4 text-gray-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <p className="font-medium text-sm truncate">{account.name}</p>
          {pendingDividendAccountIds.has(account.id) && (
            <span className="shrink-0 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700 whitespace-nowrap">
              Pending
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {(() => {
            const n = account.holdings.length + (account.manualCount ?? 0);
            return `${n} holding${n !== 1 ? "s" : ""}`;
          })()}
        </p>
      </div>
      <div className="text-right flex-shrink-0">
        <p className="font-bold tabular-nums text-sm">{formatCurrency(account.totalMarketValue)}</p>
        {account.totalDayGain != null && account.totalDayGain !== 0 && (
          <GainBadge value={account.totalDayGain} pct={account.totalDayGainPct} label="1d" className="text-xs" />
        )}
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
    </div>
  );

  return (
    <>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <PageHeadingMenu
            title="Investments"
            items={[
              { label: "Securities", icon: <Library className="h-4 w-4 text-muted-foreground" />, to: "/investments/securities" },
              { label: "Withdrawal Rate", icon: <Target className="h-4 w-4 text-muted-foreground" />, to: "/investments/withdrawals" },
            ]}
          />
        </div>

        {/* Empty state */}
        {displayAccounts.length === 0 && (
          <div className="rounded-xl border border-border p-8 text-center">
            <LineChart className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="font-semibold mb-1">No investment accounts</p>
            <p className="text-sm text-muted-foreground">
              Add accounts in{" "}
              <button className="text-primary underline" onClick={() => navigate("/accounts")}>
                Accounts
              </button>{" "}
              to get started.
            </p>
          </div>
        )}

        {displayAccounts.length > 0 && (
          <>
            {/* Portfolio Summary */}
            <div className="rounded-xl border border-border p-4 space-y-4">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Total Portfolio</p>
                <p className="text-2xl font-bold tabular-nums mt-0.5">{formatCurrency(totalPortfolioValue)}</p>
                {totalDayGain !== 0 && (
                  <GainBadge value={totalDayGain} pct={totalDayGainPct} label="1-day" className="mt-1" />
                )}
              </div>

              <div className="border-t border-border pt-3 space-y-1.5">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Asset Composition
                </p>
                <SummaryRow label="Invested" value={investedValue} total={totalPortfolioValue} />
                <SummaryRow label="Cash" value={totalCashValue} total={totalPortfolioValue} />
                {untrackedValue > 1 && (
                  <SummaryRow label="Untracked" value={untrackedValue} total={totalPortfolioValue} muted />
                )}
              </div>

              {hasTaxData && (
                <button
                  type="button"
                  onClick={() => setShowTaxSheet(true)}
                  className="flex w-full items-center justify-between border-t border-border pt-3 text-sm text-muted-foreground active:opacity-60"
                >
                  <span>Tax breakdown</span>
                  <ChevronRight className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Investment Accounts */}
            {investmentAccounts.length > 0 && (
              <div className="rounded-xl border border-border px-4 divide-y divide-border">
                <div className="flex items-center gap-2 py-3">
                  <LineChart className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    Investment Accounts
                  </span>
                </div>
                {investmentAccounts.map(renderAccountCard)}
              </div>
            )}

            {/* Withdrawal Rate */}
            <div className="rounded-xl border border-border p-4">
              <div className="flex items-center gap-2 mb-3">
                <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Withdrawal Rate
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-3">
                <div>
                  <p className="text-2xl font-bold tabular-nums">{rateStr}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">annualized (YTD)</p>
                </div>
                <div>
                  <p className="text-2xl font-bold tabular-nums">{formatCurrency(ytdTotal)}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">withdrawn YTD</p>
                </div>
              </div>

              {targetRate !== null && ytdRate !== null && effectiveDenominator > 0 && (
                <p className={`text-xs font-medium tabular-nums mb-1.5 ${ytdRate <= targetRate ? "text-green-600" : "text-red-500"}`}>
                  {ytdRate <= targetRate
                    ? `▼ ${((targetRate - ytdRate) * 100).toFixed(2)}% under target`
                    : `▲ ${((ytdRate - targetRate) * 100).toFixed(2)}% over target`}
                </p>
              )}

              <p className="text-xs text-muted-foreground mb-3">
                {investmentSettings?.withdrawalRateDenominator
                  ? `vs. ${formatCurrency(investmentSettings.withdrawalRateDenominator)} (fixed)`
                  : `vs. ${formatCurrency(totalPortfolioValue)} portfolio`}
              </p>

              <button
                type="button"
                onClick={() => setShowWithdrawalSheet(true)}
                className="flex w-full items-center justify-between border-t border-border pt-3 text-sm text-muted-foreground active:opacity-60"
              >
                <span>View monthly history</span>
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {/* Asset Allocation */}
            {displayAllocation && (
              <div className="rounded-xl border border-border p-4">
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Target className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Asset Allocation
                    </span>
                  </div>
                  <button
                    onClick={() => setShowRebalance(true)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-muted-foreground border border-border hover:bg-muted/60 transition-colors"
                  >
                    <Sliders className="h-3 w-3" />
                    Rebalance
                  </button>
                </div>

                {/* Filter chips */}
                <div className="flex gap-1.5 mb-4">
                  {ALLOCATION_FILTERS.map((f) => (
                    <button
                      key={f.value}
                      onClick={() => setAllocationFilter(f.value)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                        f.value === allocationFilter
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                {!displayAllocation.hasAnyTargets ? (
                  <p className="text-sm text-muted-foreground">
                    No target allocation configured.{" "}
                    <Link to="/settings/asset-allocation" className="text-primary underline underline-offset-2">
                      Set targets
                    </Link>{" "}
                    to see how your portfolio compares.
                  </p>
                ) : (
                  <>
                    {/* Stacked overview bars */}
                    {(() => {
                      const { items, topLevelItems = items } = displayAllocation;
                      const toSeg = (i: AllocationItem, idx: number): BarSegment => ({
                        pct: 0,
                        color: itemColor(i, idx),
                        name: i.name,
                        targetPct: i.targetPct,
                        actualPct: i.actualPct,
                        actualValue: i.actualValue,
                      });
                      const targetSegments = topLevelItems
                        .filter((i) => i.targetPct != null)
                        .map((i, idx) => ({ ...toSeg(i, idx), pct: i.targetPct! }));
                      const actualSegments = topLevelItems
                        .map((i, idx) => ({ ...toSeg(i, idx), pct: i.actualPct }));
                      return (
                        <div className="space-y-2 mb-4">
                          <div className="flex items-center gap-2">
                            <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">Target</span>
                            <StackedBar segments={targetSegments} />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">Actual</span>
                            <StackedBar segments={actualSegments} />
                          </div>
                        </div>
                      );
                    })()}

                    {/* Per-class rows */}
                    <div className="divide-y divide-border border-t border-border">
                      {displayAllocation.items.map((item, idx) => {
                        const delta = item.targetPct != null ? item.actualPct - item.targetPct : null;
                        const deltaDollars = delta != null
                          ? (delta / 100) * displayAllocation.classifiedValue
                          : null;
                        const color = itemColor(item, idx);
                        return (
                          <div key={item.id} className="py-3">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                              <span className="text-sm font-medium flex-1 truncate">{item.name}</span>
                              <span className="text-sm font-medium tabular-nums">{item.actualPct.toFixed(1)}%</span>
                              {delta != null && <DeviationBadge delta={delta} />}
                            </div>
                            <div className="flex items-center justify-between pl-[18px] mt-0.5">
                              <span className="text-xs text-muted-foreground">
                                {item.targetPct != null ? `target ${item.targetPct.toFixed(1)}%` : "no target"}
                              </span>
                              {deltaDollars != null && Math.abs(deltaDollars) >= 1 && (
                                <span className={`text-xs tabular-nums ${
                                  deltaDollars > 0 ? "text-amber-600" : "text-blue-600"
                                }`}>
                                  {deltaDollars >= 0 ? "+" : "−"}{formatCurrency(Math.abs(deltaDollars))}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {displayAllocation.unclassifiedValue > 0 && (
                        <div className="py-3 flex items-center gap-2">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-muted-foreground/30" />
                          <span className="text-sm text-muted-foreground flex-1 min-w-0 truncate">
                            Unclassified ({formatCurrency(displayAllocation.unclassifiedValue)})
                          </span>
                          <Link
                            to="/investments/securities"
                            className="text-xs text-primary underline underline-offset-2 shrink-0"
                          >
                            Classify
                          </Link>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Overlays */}
      <TaxSheet
        open={showTaxSheet}
        onClose={() => setShowTaxSheet(false)}
        investedValue={investedValue}
        taxableValue={taxableValue}
        taxableCostBasisPct={taxableCostBasisPct}
        traditionalValue={traditionalValue}
        rothValue={rothValue}
        hsaValue={hsaValue}
        plan529Value={plan529Value}
      />
      <WithdrawalSheet
        open={showWithdrawalSheet}
        onClose={() => setShowWithdrawalSheet(false)}
        summary={withdrawalSummary}
        settings={investmentSettings}
        portfolioValue={totalPortfolioValue}
      />
      {displayAllocation && (
        <RebalanceModal
          data={displayAllocation}
          isOpen={showRebalance}
          onClose={() => setShowRebalance(false)}
        />
      )}
    </>
  );
}
