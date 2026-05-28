import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { TrendingUp, TrendingDown, LineChart, ChevronRight, Library, Target, ArrowUpRight, Sliders } from "lucide-react";
import { Card } from "@/components/Card";
import { Modal } from "@/components/Modal";
import { useApi } from "@/hooks/useApi";
import { getInvestmentAccounts, getAllocationSummary, getWithdrawalSummary, getInvestmentSettings } from "@/api";
import { formatCurrency } from "@/lib/utils";
import { formatNextUpdateTime } from "@/lib/priceUtils";
import { usePriceRefresh } from "@/hooks/usePriceRefresh";
import { useNotifications } from "@/context/NotificationContext";
import { useDemo } from "@/context/DemoContext";
import { scaleInvestmentAccounts, scaleAllocationSummary } from "@/lib/demo";
import type { InvestmentAccountSummary, AllocationSummary, AllocationItem, WithdrawalSummary, InvestmentSettings } from "@/types";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel, StatValue, DisplayStat, FieldLabel } from "@/components/Typography";

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
              <span className="font-medium tabular-nums font-mono">
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
              <span className="font-medium tabular-nums font-mono">
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
              <span className="font-medium tabular-nums font-mono">
                {targetPct != null ? `${targetPct.toFixed(1)}%` : "—"}
                {targetValue != null && (
                  <span className="text-muted-foreground ml-1.5">{formatCurrency(targetValue)}</span>
                )}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Actual</span>
              <span className="font-medium tabular-nums font-mono">
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
    return <StatValue className="text-right tp-caption">on target</StatValue>;
  }
  const over = delta > 0;
  return (
    <span className={`text-right text-xs font-medium tabular-nums font-mono ${over ? "text-amber-600" : "text-blue-600"}`}>
      {over ? "+" : ""}{delta.toFixed(1)}%
    </span>
  );
}

// ── Rebalancing Simulator Modal ──────────────────────────────────────────────

type RebalanceTab = "manual" | "auto";

/** Fixed-point iteration to find per-class purchase amounts.
 *  For each under-allocated class, solves:
 *    (actualValue + addition) / (classifiedValue + totalAdded) = (targetPct - tolerancePct) / 100
 *  Over-allocated classes are never sold (addition = 0). Converges in < 30 steps. */
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

/** Fixed-total approximation for buy+sell rebalancing.
 *  Sells over-allocated classes down to (target + tolerance) and buys
 *  under-allocated classes up to (target − tolerance), using the current
 *  portfolio value as the fixed denominator (valid because sells fund buys
 *  and net cash is negligible relative to total). Returns negative values
 *  for sells, positive for buys. */
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
      // Over-allocated: sell to the upper tolerance boundary
      adjustments[item.id] = ((targetPct + tolerancePct) / 100) * S - item.actualValue;
    } else if (actualPct < targetPct - tolerancePct) {
      // Under-allocated: buy to the lower tolerance boundary
      adjustments[item.id] = ((targetPct - tolerancePct) / 100) * S - item.actualValue;
    } else {
      adjustments[item.id] = 0;
    }
  }
  return adjustments;
}

function RebalanceModal({
  data,
  isOpen,
  onClose,
}: {
  data: AllocationSummary;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { items, classifiedValue } = data;
  const [tab, setTab] = useState<RebalanceTab>("manual");
  const [manualAdj, setManualAdj] = useState<Record<string, string>>(() => {
    try {
      const stored = localStorage.getItem("rebalance-manual-adj");
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const [tolerancePct, setTolerancePct] = useState(0.5);
  const [rebalanceMode, setRebalanceMode] = useState<"buy-only" | "buy-sell">("buy-only");

  // Persist manual adjustments across modal sessions
  useEffect(() => {
    try {
      localStorage.setItem("rebalance-manual-adj", JSON.stringify(manualAdj));
    } catch {}
  }, [manualAdj]);

  useEffect(() => {
    if (!isOpen) return;
    setTab("manual");
    setTolerancePct(0.5);
    setRebalanceMode("buy-only");
  }, [isOpen]);

  // ── Manual ────────────────────────────────────────────────────────────────
  const manualDelta = items.reduce((s, item) => s + (parseFloat(manualAdj[item.id] ?? "0") || 0), 0);
  const manualNewTotal = classifiedValue + manualDelta;

  // Base scale is anchored to the static current + target percentages so it
  // never shrinks as adjustments are entered. It can only grow if a projected
  // value genuinely exceeds the current maximum.
  const manualBaseScale = Math.max(
    Math.ceil(Math.max(
      ...items.map((i) => i.actualPct),
      ...items.map((i) => i.targetPct ?? 0),
      10,
    ) / 5) * 5,
    10,
  );
  const manualScale = Math.max(
    Math.ceil(Math.max(
      ...items.map((item) => {
        const adj = parseFloat(manualAdj[item.id] ?? "0") || 0;
        const v = Math.max(0, item.actualValue + adj);
        return manualNewTotal > 0 ? (v / manualNewTotal) * 100 : 0;
      }),
      10,
    ) / 5) * 5,
    manualBaseScale,
  );

  // ── Auto ──────────────────────────────────────────────────────────────────
  const autoTargets: Record<string, number> = {};
  items.forEach((i) => { autoTargets[i.id] = i.targetPct ?? 0; });

  const autoAdjustments = rebalanceMode === "buy-only"
    ? computeAutoAdditions(items, classifiedValue, autoTargets, tolerancePct)
    : computeAutoRebalance(items, classifiedValue, autoTargets, tolerancePct);
  const autoNetCash = Object.values(autoAdjustments).reduce((s, v) => s + v, 0);
  const autoNewTotal = classifiedValue + autoNetCash;

  const autoBaseScale = Math.max(
    Math.ceil(Math.max(
      ...items.map((i) => i.actualPct),
      ...items.map((i) => i.targetPct ?? 0),
      10,
    ) / 5) * 5,
    10,
  );
  const autoScale = Math.max(
    Math.ceil(Math.max(
      ...items.map((item) => {
        const adj = autoAdjustments[item.id] ?? 0;
        return autoNewTotal > 0 ? ((item.actualValue + adj) / autoNewTotal) * 100 : 0;
      }),
      10,
    ) / 5) * 5,
    autoBaseScale,
  );

  // ── Shared stacked-bar data ────────────────────────────────────────────────
  const toSeg = (item: AllocationItem, idx: number, pct: number): BarSegment => ({
    pct,
    color: itemColor(item, idx),
    name: item.name,
    targetPct: item.targetPct,
    targetValue: item.targetPct != null ? (item.targetPct / 100) * classifiedValue : null,
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

  // Column templates — identical between header row and data rows so alignment is guaranteed
  // dot | name | bar | adjustment | current% | after% | vs.target
  const MANUAL_COLS = "10px 160px 1fr 76px 48px 48px 60px";
  // dot | name | bar | trade | current% | after% | vs.target
  const AUTO_COLS   = "10px 160px 1fr 88px 48px 48px 60px";

  const rowCls = "grid items-center gap-x-3";
  const hdrCls = "text-xs font-medium text-muted-foreground";

  return (
    <Modal open={isOpen} onClose={onClose} title="Rebalancing Simulator" className="max-w-2xl">
      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-border -mx-6 px-6">
        {(["manual", "auto"] as RebalanceTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "manual" ? "Manual" : "Auto-Calculate"}
          </button>
        ))}
      </div>

      {/* ── Manual tab ────────────────────────────────────────────────────── */}
      {tab === "manual" && (
        <div>
          {/* Overview bars */}
          <div className="mb-5 space-y-1.5">
            <SectionLabel className="mb-3">
              Projected Allocation
            </SectionLabel>
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-right tp-caption">After</span>
              <StackedBar segments={manualProjectedSegments} />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-right tp-caption">Before</span>
              <StackedBar segments={currentSegments} />
            </div>
          </div>

          {/* Header */}
          <div className={`mb-2 ${rowCls}`} style={{ gridTemplateColumns: MANUAL_COLS }}>
            <span />
            <span className={hdrCls}>Asset Class</span>
            <span />
            <span className={`${hdrCls} text-right`}>Adjustment</span>
            <span className={`${hdrCls} text-right`}>Current</span>
            <span className={`${hdrCls} text-right`}>After</span>
            <span className={`${hdrCls} text-right`}>vs. Target</span>
          </div>

          <div className="border-t border-border" />

          {/* Data rows */}
          <div className="py-2 space-y-1.5">
            {items.map((item, idx) => {
              const adj = parseFloat(manualAdj[item.id] ?? "0") || 0;
              const newValue = Math.max(0, item.actualValue + adj);
              const newPct = manualNewTotal > 0 ? (newValue / manualNewTotal) * 100 : 0;
              const delta = item.targetPct != null ? newPct - item.targetPct : null;
              const color = itemColor(item, idx);
              return (
                <div key={item.id} className={rowCls} style={{ gridTemplateColumns: MANUAL_COLS }}>
                  <span className="h-2 w-2 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
                  <span className="tp-row-label truncate">{item.name}</span>
                  <DeviationBar
                    actualPct={newPct}
                    targetPct={item.targetPct}
                    scale={manualScale}
                    color={color}
                    name={item.name}
                    targetValue={item.targetPct != null ? (item.targetPct / 100) * classifiedValue : null}
                    actualValue={newValue}
                  />
                  <div className="relative">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 tp-caption pointer-events-none select-none">$</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={manualAdj[item.id] ?? ""}
                      onChange={(e) => setManualAdj((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      placeholder="0"
                      className="w-full rounded border border-border bg-background pl-5 pr-2 py-1 text-xs text-right tabular-nums font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <StatValue className="text-right tp-caption">
                    {item.actualPct.toFixed(1)}%
                  </StatValue>
                  <span className={`text-right text-xs tabular-nums font-mono font-medium ${
                    delta == null ? "" : Math.abs(delta) < 0.5 ? "text-green-600" : delta > 0 ? "text-amber-600" : "text-blue-600"
                  }`}>
                    {newPct.toFixed(1)}%
                  </span>
                  <span className={`text-right text-xs tabular-nums font-mono ${
                    delta == null ? "text-muted-foreground"
                      : Math.abs(delta) < 0.5 ? "text-green-600"
                      : delta > 0 ? "text-amber-600"
                      : "text-blue-600"
                  }`}>
                    {delta != null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%` : "—"}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm text-muted-foreground">Net cash deployed</span>
            <span className={`tp-numeric font-semibold ${
              manualDelta > 0 ? "text-green-600" : manualDelta < 0 ? "text-red-500" : "text-ink-3"
            }`}>
              {manualDelta >= 0 ? "+" : "−"}{formatCurrency(Math.abs(manualDelta))}
            </span>
          </div>
        </div>
      )}

      {/* ── Auto-Calculate tab ────────────────────────────────────────────── */}
      {tab === "auto" && (
        <div>
          {/* Controls: mode toggle + tolerance slider, 50/50 */}
          <div className="grid grid-cols-3 gap-5">
            {/* Mode toggle */}
            <div className="space-y-1.5">
              <FieldLabel className="block">Mode</FieldLabel>
              <div className="flex gap-1 rounded-lg bg-secondary p-1 w-fit">
                {(["buy-only", "buy-sell"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setRebalanceMode(m)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      rebalanceMode === m
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {m === "buy-only" ? "Buy only" : "Buy & sell"}
                  </button>
                ))}
              </div>
            </div>

            {/* Tolerance slider */}
            <div className="col-span-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <FieldLabel>Tolerance</FieldLabel>
                <StatValue className="text-13 font-semibold text-primary">
                  ±{tolerancePct.toFixed(1)}%
                </StatValue>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                step={0.1}
                value={tolerancePct}
                onChange={(e) => setTolerancePct(parseFloat(e.target.value))}
                className="w-full accent-primary"
              />
              <p className="tp-caption">
                {rebalanceMode === "buy-only" ? (
                  <>Buy into under-allocated classes until each is within{" "}
                  <span className="font-medium">{tolerancePct.toFixed(1)}%</span> of target.
                  Over-allocated classes are not sold.</>
                ) : (
                  <>Buy under-allocated and sell over-allocated classes to bring each within{" "}
                  <span className="font-medium">{tolerancePct.toFixed(1)}%</span> of target.</>
                )}
              </p>
            </div>
          </div>

          {/* Overview bars */}
          <div className="mb-5 mt-5 space-y-1.5">
            <SectionLabel className="mb-3">
              Projected Allocation
            </SectionLabel>
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-right tp-caption">After</span>
              <StackedBar segments={autoProjectedSegments} />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-right tp-caption">Before</span>
              <StackedBar segments={currentSegments} />
            </div>
          </div>

          {/* Header */}
          <div className={`mb-2 ${rowCls}`} style={{ gridTemplateColumns: AUTO_COLS }}>
            <span />
            <span className={hdrCls}>Asset Class</span>
            <span />
            <span className={`${hdrCls} text-right`}>{rebalanceMode === "buy-only" ? "Buy" : "Trade"}</span>
            <span className={`${hdrCls} text-right`}>Current</span>
            <span className={`${hdrCls} text-right`}>After</span>
            <span className={`${hdrCls} text-right`}>vs. Target</span>
          </div>

          <div className="border-t border-border" />

          {/* Data rows */}
          <div className="py-2 space-y-3">
            {items.map((item, idx) => {
              const adj = autoAdjustments[item.id] ?? 0;
              const newValue = item.actualValue + adj;
              const newPct = autoNewTotal > 0 ? (newValue / autoNewTotal) * 100 : 0;
              const delta = item.targetPct != null ? newPct - item.targetPct : null;
              const color = itemColor(item, idx);
              const isBuy = adj > 1;
              const isSell = adj < -1;
              const deltaColor = delta == null ? "text-muted-foreground"
                : Math.abs(delta) < tolerancePct ? "text-green-600"
                : delta > 0 ? "text-amber-600"
                : "text-blue-600";
              return (
                <div key={item.id} className={rowCls} style={{ gridTemplateColumns: AUTO_COLS }}>
                  <span className="h-2 w-2 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
                  <span className="tp-row-label truncate">{item.name}</span>
                  <DeviationBar
                    actualPct={newPct}
                    targetPct={item.targetPct}
                    scale={autoScale}
                    color={color}
                    name={item.name}
                    targetValue={item.targetPct != null ? (item.targetPct / 100) * classifiedValue : null}
                    actualValue={newValue}
                  />
                  <span className={`text-right text-xs tabular-nums font-mono font-medium ${
                    isBuy ? "text-blue-600" : isSell ? "text-amber-600" : "text-muted-foreground"
                  }`}>
                    {isBuy ? `+${formatCurrency(adj)}` : isSell ? `−${formatCurrency(Math.abs(adj))}` : "—"}
                  </span>
                  <StatValue className="text-right tp-caption">
                    {item.actualPct.toFixed(1)}%
                  </StatValue>
                  <span className={`text-right text-xs tabular-nums font-mono font-medium ${deltaColor}`}>
                    {newPct.toFixed(1)}%
                  </span>
                  <span className={`text-right text-xs tabular-nums font-mono ${deltaColor}`}>
                    {delta != null ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%` : "—"}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border pt-3">
            {rebalanceMode === "buy-only" ? (
              <>
                <span className="text-sm text-muted-foreground">Total cash to deploy</span>
                <StatValue className="text-13 font-semibold text-blue-600">
                  {autoNetCash > 1 ? `+${formatCurrency(autoNetCash)}` : formatCurrency(0)}
                </StatValue>
              </>
            ) : autoNetCash > 1 ? (
              <>
                <span className="text-sm text-muted-foreground">Net cash to deploy</span>
                <StatValue className="text-13 font-semibold text-blue-600">
                  +{formatCurrency(autoNetCash)}
                </StatValue>
              </>
            ) : autoNetCash < -1 ? (
              <>
                <span className="text-sm text-muted-foreground">Net cash proceeds</span>
                <StatValue className="text-13 font-semibold text-amber-600">
                  −{formatCurrency(Math.abs(autoNetCash))}
                </StatValue>
              </>
            ) : (
              <>
                <span className="text-sm text-muted-foreground">Net cash</span>
                <StatValue className="text-13 font-semibold text-muted-foreground">
                  {formatCurrency(0)}
                </StatValue>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
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
  onRebalance,
}: {
  data: AllocationSummary;
  filter: AllocationFilter;
  onFilterChange: (f: AllocationFilter) => void;
  onRebalance: () => void;
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
            <SectionLabel as="span" className="text-sm">
              Asset Allocation
            </SectionLabel>
          </div>
          <div className="flex items-center gap-2">
            {filterButtons}
          </div>
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
    <Card className="p-0 py-2 space-y-4 border-0 shadow-none bg-transparent">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-muted-foreground" />
          <SectionLabel as="span" className="text-sm">
            Asset Allocation
          </SectionLabel>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRebalance}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <Sliders className="h-3 w-3" />
            Rebalance
          </button>
          <div className="w-px h-3.5 bg-border" />
          {filterButtons}
        </div>
      </div>

      {/* Overview: paired stacked bars */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-right tp-caption">Target</span>
          <StackedBar segments={targetSegments} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-right tp-caption">Actual</span>
          <StackedBar segments={actualSegments} />
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Per-class deviation rows */}
      <div className="space-y-3">
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
              <span className="tp-row-label truncate">{item.name}</span>
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
              <StatValue className="text-right tp-caption">
                {item.targetPct != null ? `${item.targetPct.toFixed(1)}%` : "—"}
              </StatValue>
              {/* Actual % */}
              <StatValue className="text-right text-xs font-medium">
                {item.actualPct.toFixed(1)}%
              </StatValue>
              {/* Delta % */}
              {delta != null ? <DeviationBadge delta={delta} /> : <span className="text-right" />}
              {/* Delta $ */}
              <span className={`text-right text-xs tabular-nums font-mono ${
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
            <span className="text-sm text-muted-foreground col-span-6 min-w-0 flex items-center gap-x-1 flex-wrap">
              <span>Unclassified / Not Included</span>
              <span className="text-xs">({formatCurrency(unclassifiedValue)})</span>
              <span className="text-muted-foreground/40">·</span>
              <Link
                to="/investments/securities"
                className="text-xs text-primary underline underline-offset-2 whitespace-nowrap"
              >
                Classify in Securities
              </Link>
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Summary row ─────────────────────────────────────────────────────────────

function SummaryRow({
  label,
  value,
  total,
  muted = false,
}: {
  label: string;
  value: number;
  total: number;
  muted?: boolean;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className={`flex items-center justify-between gap-3 ${muted ? "text-muted-foreground" : ""}`}>
      <span className="text-13">{label}</span>
      <div className="flex items-center gap-2 tabular-nums font-mono">
        <span className="text-13 font-medium">{formatCurrency(value)}</span>
        <span className="tp-caption w-8 text-right">{pct.toFixed(0)}%</span>
      </div>
    </div>
  );
}

// ── Gain badge ──────────────────────────────────────────────────────────────

function GainBadge({ value, pct, label, className = "" }: { value: number; pct?: number | null; label?: string; className?: string }) {
  const positive = value >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-13 font-medium ${
        positive ? "text-green-600" : "text-red-500"
      } ${className}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {formatCurrency(Math.abs(value))}
      {pct != null && (
        <span className="text-xs opacity-70">({Math.abs(pct).toFixed(2)}%)</span>
      )}
      {label != null && (
        <span className="text-xs opacity-50">{label}</span>
      )}
    </span>
  );
}


// ── Withdrawal Rate card ─────────────────────────────────────────────────────

function annualizedRate(total: number, months: number, denominator: number): number | null {
  if (denominator <= 0 || months <= 0) return null;
  return (total * (12 / months)) / denominator;
}

function WithdrawalRateCard({
  summary,
  settings,
  portfolioValue,
}: {
  summary: WithdrawalSummary | null | undefined;
  settings: InvestmentSettings | null | undefined;
  portfolioValue: number;
}) {
  const navigate = useNavigate();
  const [barTooltip, setBarTooltip] = useState<{
    month: string;
    total: number;
    rate: number | null;
    x: number;
    y: number;
  } | null>(null);

  const effectiveDenominator = settings?.withdrawalRateDenominator ?? portfolioValue;
  const targetRate = settings?.withdrawalRateTarget ?? null;

  const ytdTotal = summary?.ytdTotal ?? 0;
  const ytdMonths = summary?.ytdMonths ?? 1;
  const ytdRate = annualizedRate(ytdTotal, ytdMonths, effectiveDenominator);

  const hasRate = ytdRate !== null && effectiveDenominator > 0;
  const rateStr = hasRate ? `${(ytdRate! * 100).toFixed(2)}%` : "—";

  // Build all 12 months for the current year; months without data default to 0.
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1; // 1-indexed
  const monthMap = Object.fromEntries(
    (summary?.monthlySummaries ?? []).map((m) => [m.month, m.total])
  );
  const allMonths = Array.from({ length: 12 }, (_, i) => {
    const key = `${currentYear}-${String(i + 1).padStart(2, "0")}`;
    return {
      month: key,
      total: monthMap[key] ?? 0,
      isFuture: i + 1 > currentMonth,
    };
  });

  const maxMonthTotal = Math.max(...allMonths.map((m) => m.total), 1);
  // Scale the y-axis so the tallest bar reaches ~80% of the chart height, leaving headroom at the top
  const chartMax = maxMonthTotal * 1.25;

  // Target monthly withdrawal dollar amount (used to draw the reference line on the chart)
  const targetMonthlyAmount = targetRate != null ? (targetRate * effectiveDenominator) / 12 : null;
  const targetLinePct = targetMonthlyAmount != null ? Math.min(targetMonthlyAmount / chartMax, 1) : null;

  return (
    <Card className="p-6">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_1px_2fr]">

        {/* Left: numbers */}
        <div className="flex flex-col gap-4 md:pr-5">
          <div className="flex items-center gap-2">
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
            <SectionLabel as="span" className="text-sm">
              Withdrawal Rate
            </SectionLabel>
          </div>

          <div className="grid grid-cols-2 gap-x-4">
            <div>
              <DisplayStat as="p" className="tp-kpi-l">{rateStr}</DisplayStat>
              <p className="tp-fineprint mt-0.5">annualized (YTD)</p>
            </div>
            <div>
              <DisplayStat as="p" className="tp-kpi-l">{formatCurrency(ytdTotal)}</DisplayStat>
              <p className="tp-fineprint mt-0.5">withdrawn YTD</p>
            </div>
          </div>

          <div className="mt-auto space-y-1.5">
            {targetRate !== null && ytdRate !== null && effectiveDenominator > 0 && (
              <p className={`text-xs font-medium tabular-nums font-mono ${
                ytdRate <= targetRate ? "text-green-600" : "text-red-500"
              }`}>
                {ytdRate <= targetRate
                  ? `▼ ${((targetRate - ytdRate) * 100).toFixed(2)}% under target`
                  : `▲ ${((ytdRate - targetRate) * 100).toFixed(2)}% over target`}
              </p>
            )}
            <p className="tp-fineprint">
              {settings?.withdrawalRateDenominator
                ? `vs. ${formatCurrency(settings.withdrawalRateDenominator)} (fixed)`
                : `vs. ${formatCurrency(portfolioValue)} portfolio`}
            </p>
            <button
              onClick={() => navigate("/investments/withdrawals")}
              className="flex items-center gap-1 text-xs text-primary hover:underline underline-offset-2"
            >
              View history
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Divider */}
        <div className="hidden md:block bg-border" />

        {/* Right: bar chart */}
        <div className="flex flex-col md:pl-5">
          <SectionLabel className="mb-3">
            Monthly Withdrawals
          </SectionLabel>

          {/* Bars */}
          <div className="relative flex items-end gap-0" style={{ height: "125px" }}>
            {/* Target withdrawal rate line */}
            {targetLinePct != null && (
              <div
                className="absolute inset-x-0 border-t border-dashed border-destructive opacity-50 pointer-events-none z-10"
                style={{ bottom: `${13 + targetLinePct * 104}px` }}
              />
            )}
            {allMonths.map((m) => {
              const heightPct = m.total > 0 ? (m.total / chartMax) * 100 : 0;
              const monthLabel = new Date(`${m.month}-01T12:00:00`).toLocaleDateString("en-US", {
                month: "short",
              });
              const monthRate = annualizedRate(m.total, 1, effectiveDenominator);

              return (
                <div
                  key={m.month}
                  className="flex-1 flex flex-col items-center"
                  style={{ gap: "4px" }}
                >
                  {/* Bar area */}
                  <div className="w-full flex items-end justify-center" style={{ height: "104px" }}>
                    <div
                      className={`w-[55%] rounded-t-sm transition-colors cursor-default ${
                        m.isFuture
                          ? "bg-muted"
                          : "bg-primary/50 hover:bg-primary/80"
                      }`}
                      style={{ height: heightPct > 0 ? `${heightPct}%` : m.isFuture ? "3px" : "2px" }}
                      onMouseEnter={(e) =>
                        setBarTooltip({
                          month: monthLabel,
                          total: m.total,
                          rate: m.isFuture ? null : monthRate,
                          x: e.clientX,
                          y: e.clientY,
                        })
                      }
                      onMouseMove={(e) =>
                        setBarTooltip((t) =>
                          t ? { ...t, x: e.clientX, y: e.clientY } : null
                        )
                      }
                      onMouseLeave={() => setBarTooltip(null)}
                    />
                  </div>
                  {/* Month label */}
                  <span
                    className={`text-[9px] leading-none tabular-nums font-mono text-center w-full ${
                      m.isFuture ? "text-muted-foreground/40" : "text-muted-foreground"
                    }`}
                  >
                    {monthLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Hover tooltip (portal-style, fixed position) */}
      {barTooltip && (
        <div
          className="fixed z-50 pointer-events-none bg-white border border-border rounded-lg shadow-lg px-3 py-2 text-xs min-w-[150px]"
          style={{
            left: barTooltip.x + 14,
            top: barTooltip.y - 8,
            transform: "translateY(-100%)",
          }}
        >
          <p className="font-semibold mb-1.5">{barTooltip.month}</p>
          <div className="space-y-1">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Withdrawn</span>
              <StatValue className="font-medium">{formatCurrency(barTooltip.total)}</StatValue>
            </div>
            {barTooltip.rate !== null && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">Ann. rate</span>
                <StatValue className="font-medium">
                  {`${(barTooltip.rate * 100).toFixed(2)}%`}
                </StatValue>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

type AllocationFilter = "all" | "taxable" | "tax-advantaged";

export function Investments() {
  const navigate = useNavigate();
  const { data: accounts, refetch } = useApi(() => getInvestmentAccounts(), []);
  const [allocationFilter, setAllocationFilter] = useState<AllocationFilter>("all");
  const [showRebalance, setShowRebalance] = useState(false);
  const { data: allocation, refetch: refetchAllocation } = useApi(
    () => getAllocationSummary(allocationFilter),
    [allocationFilter]
  );
  const { data: withdrawalSummary } = useApi(
    () => getWithdrawalSummary(new Date().getFullYear()),
    []
  );
  const { data: investmentSettings } = useApi(() => getInvestmentSettings(), []);
  const { notifications } = useNotifications();
  const pendingDividendAccountIds = new Set(
    notifications?.pendingDividends.map((g) => g.accountId) ?? []
  );
  const { isDemoMode, demoFactor } = useDemo();
  const displayAccounts = useMemo(() => {
    const all = isDemoMode && accounts ? scaleInvestmentAccounts(accounts, demoFactor) : accounts;
    return all?.filter((a) => a.type === "INVESTMENT") ?? null;
  }, [accounts, isDemoMode, demoFactor]);
  const displayAllocation = useMemo(
    () => isDemoMode && allocation ? scaleAllocationSummary(allocation, demoFactor) : allocation,
    [allocation, isDemoMode, demoFactor]
  );

  const investmentHoldings = useMemo(
    () => accounts?.filter((a) => a.type === "INVESTMENT").flatMap((a) => a.holdings) ?? null,
    [accounts],
  );

  const { phase: refreshPhase, count: refreshCount, total: refreshTotal, nextUpdateAt } =
    usePriceRefresh({ holdings: investmentHoldings, source: "Investments" });

  // Reload data once the price refresh completes.
  const prevRefreshPhaseRef = useRef(refreshPhase);
  useEffect(() => {
    if (prevRefreshPhaseRef.current !== "done" && refreshPhase === "done") {
      refetch();
      refetchAllocation();
    }
    prevRefreshPhaseRef.current = refreshPhase;
  }, [refreshPhase, refetch, refetchAllocation]);

if (!displayAccounts) return <BeaconLoader />;

  const investmentAccounts = displayAccounts;

  const totalPortfolioValue = displayAccounts.reduce((sum, a) => sum + a.totalMarketValue, 0);
  const totalDayGain = investmentAccounts.reduce((sum, a) => sum + (a.totalDayGain ?? 0), 0);
  const totalDayGainPct = totalPortfolioValue > 0 ? (totalDayGain / totalPortfolioValue) * 100 : null;

  // ── Asset Composition breakdown ──────────────────────────────────────────
  // Settlement cash + holdings classified as Cash via instrument weights
  const settlementCash = investmentAccounts.reduce((sum, a) => sum + (a.cashBalance ?? 0), 0);
  const classifiedCashHoldings = investmentAccounts.reduce((sum, a) => sum + a.classifiedCashValue, 0);
  const totalCashValue = settlementCash + classifiedCashHoldings;

  // Untracked = holdings with no instrument weights assigned in the Securities page
  const untrackedValue = investmentAccounts.reduce((sum, a) => sum + a.untrackedValue, 0);

  // Invested = classified non-cash only, so Invested + Cash + Untracked === Total Portfolio
  const investedValue = totalPortfolioValue - totalCashValue - untrackedValue;

  // ── Tax Buckets breakdown (investment accounts only, excluding cash + untracked) ──
  // Subtracts settlement cash, cash-classified holdings, AND untracked so that
  // Taxable + Traditional + Roth (+ HSA + 529) === Invested.
  const nonCashValue = (a: InvestmentAccountSummary) =>
    a.totalMarketValue - (a.cashBalance ?? 0) - a.classifiedCashValue - a.untrackedValue;

  const taxableAccounts = investmentAccounts.filter((a) => !a.isTaxAdvantaged);
  const taxableValue = taxableAccounts.reduce((sum, a) => sum + nonCashValue(a), 0);
  const taxableCostBasis = taxableAccounts.reduce((sum, a) => sum + a.totalCost, 0);
  const taxableCostBasisPct = taxableValue > 0 ? (taxableCostBasis / taxableValue) * 100 : null;

  const traditionalValue = investmentAccounts
    .filter((a) => a.taxAdvantageType === "TRADITIONAL")
    .reduce((sum, a) => sum + nonCashValue(a), 0);
  const rothValue = investmentAccounts
    .filter((a) => a.taxAdvantageType === "ROTH")
    .reduce((sum, a) => sum + nonCashValue(a), 0);
  const hsaValue = investmentAccounts
    .filter((a) => a.taxAdvantageType === "HSA")
    .reduce((sum, a) => sum + nonCashValue(a), 0);
  const plan529Value = investmentAccounts
    .filter((a) => a.taxAdvantageType === "PLAN_529")
    .reduce((sum, a) => sum + nonCashValue(a), 0);

  const renderAccountRow = (account: InvestmentAccountSummary) => (
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
          <div
            className="h-8 w-8 flex-shrink-0 rounded-md flex items-center justify-center"
            style={account.color ? { backgroundColor: account.color } : { backgroundColor: "#e2e2df" }}
          >
            <LineChart className="h-4 w-4 text-gray-500" />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <p className="tp-row-label truncate">{account.name}</p>
              {pendingDividendAccountIds.has(account.id) && (
                <span className="shrink-0 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700 whitespace-nowrap">
                  Pending dividends
                </span>
              )}
            </div>
            <p className="tp-caption">
              {(() => { const n = account.holdings.length + (account.manualCount ?? 0); return `${n} holding${n !== 1 ? "s" : ""}`; })()}
            </p>
          </div>

          <div className="text-right flex-shrink-0 mr-2">
            <StatValue as="p" className="font-bold text-sm">
              {formatCurrency(account.totalMarketValue)}
            </StatValue>
            {account.totalDayGain != null && account.totalDayGain !== 0 && (
              <GainBadge value={account.totalDayGain} pct={account.totalDayGainPct} label="1-day" />
            )}
          </div>

          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        </div>
      </Card>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="tp-page-title">Investments</h2>
        <Link
          to="/investments/securities"
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <Library className="h-4 w-4" />
          Securities
        </Link>
      </div>

      {/* Portfolio summary */}
      {displayAccounts.length > 0 && (
        <Card className="p-6">
          {/*
            Outer grid: Total Portfolio | divider | [Asset Composition + connector + Tax Buckets]
            The two right sections share one outer cell so we can place a dotted connector
            line between them using a dedicated middle column with absolute positioning.
          */}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_1px_2fr]">
            {/* Total Portfolio */}
            <div className="flex flex-col gap-0.5 md:pr-5">
              <SectionLabel>
                Total Portfolio
              </SectionLabel>
              <DisplayStat as="p" className="tp-kpi-l">{formatCurrency(totalPortfolioValue)}</DisplayStat>
              {totalDayGain !== 0 && (
                <GainBadge value={totalDayGain} pct={totalDayGainPct} label="1-day" className="mt-0.5" />
              )}
              <p className="tp-caption mt-1">
                {refreshPhase === "running"
                  ? refreshTotal > 0
                    ? `Fetching latest prices… ${refreshCount} of ${refreshTotal} securities`
                    : "Fetching latest prices…"
                  : nextUpdateAt
                    ? `Next update: ${formatNextUpdateTime(nextUpdateAt)}`
                    : null}
              </p>
            </div>

            {/* Divider */}
            <div className="hidden md:block bg-border" />

            {/*
              Inner grid: Asset Composition | connector column | Tax Buckets
              The connector column is `relative` so we can absolutely-position a dotted
              line at the vertical midpoint of the first data row (header ≈ 26px + half
              of a text-sm row ≈ 10px → top: 36px).
            */}
            <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_2rem_1fr] md:gap-4 md:pl-5">
              {/* Asset Composition */}
              <div>
                <SectionLabel className="mb-2.5">
                  Asset Composition
                </SectionLabel>
                <div className="space-y-1.5">
                  <SummaryRow label="Invested" value={investedValue} total={totalPortfolioValue} />
                  <SummaryRow label="Cash" value={totalCashValue} total={totalPortfolioValue} />
                  {untrackedValue > 1 && (
                    <SummaryRow label="Untracked" value={untrackedValue} total={totalPortfolioValue} muted />
                  )}
                </div>
              </div>

              {/* Connector column — dotted line sits at the Invested row's vertical center */}
              <div className="hidden md:block relative">
                <div className="absolute inset-x-0 top-[36px] border-t border-dashed border-border" />
              </div>

              {/* Tax Buckets */}
              <div>
                <div className="flex items-baseline gap-1.5 mb-2.5">
                  <SectionLabel>
                    Tax Buckets
                  </SectionLabel>
                  <p className="tp-caption/60 italic">of Invested</p>
                </div>
                <div className="space-y-1.5">
                  <div>
                    <SummaryRow label="Taxable" value={taxableValue} total={investedValue} />
                    {taxableCostBasisPct != null && taxableCostBasisPct > 0 && (
                      <p className="tp-caption mt-0.5 text-right pr-10">
                        {taxableCostBasisPct.toFixed(0)}% cost basis
                      </p>
                    )}
                  </div>
                  {traditionalValue > 0 && (
                    <SummaryRow label="Traditional" value={traditionalValue} total={investedValue} />
                  )}
                  {rothValue > 0 && (
                    <SummaryRow label="Roth" value={rothValue} total={investedValue} />
                  )}
                  {hsaValue > 0 && (
                    <SummaryRow label="HSA" value={hsaValue} total={investedValue} />
                  )}
                  {plan529Value > 0 && (
                    <SummaryRow label="529" value={plan529Value} total={investedValue} />
                  )}
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Withdrawal Rate */}
      {displayAccounts.length > 0 && (
        <WithdrawalRateCard
          summary={withdrawalSummary}
          settings={investmentSettings}
          portfolioValue={totalPortfolioValue}
        />
      )}

      {/* Two-column: accounts list (left) + asset allocation (right) */}
      {(investmentAccounts.length > 0 || displayAllocation) && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left: Investment accounts */}
          {investmentAccounts.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 py-1">
                <LineChart className="h-4 w-4 text-muted-foreground" />
                <SectionLabel as="span" className="text-sm">
                  Investment Accounts
                </SectionLabel>
              </div>
              <div className="space-y-1.5">
                {investmentAccounts.map(renderAccountRow)}
              </div>
            </div>
          )}

          {/* Right: Asset Allocation */}
          {displayAllocation && (
            <>
              <AllocationCard
                data={displayAllocation}
                filter={allocationFilter}
                onFilterChange={setAllocationFilter}
                onRebalance={() => setShowRebalance(true)}
              />
              <RebalanceModal
                data={displayAllocation}
                isOpen={showRebalance}
                onClose={() => setShowRebalance(false)}
              />
            </>
          )}
        </div>
      )}

      {/* Empty state */}
      {displayAccounts.length === 0 && (
        <Card className="p-8 text-center">
          <LineChart className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="font-semibold text-lg mb-1">No investment accounts</p>
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


    </div>
  );
}
