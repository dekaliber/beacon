import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, ArrowLeft } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { useApi } from "@/hooks/useApi";
import { getMonthlySpending, getDataRange } from "@/api";
import { formatCurrency } from "@/lib/utils";
import type { MonthlySpendingMonth, MonthlySpendingDay } from "@/types";
import { BeaconLoader } from "@/components/BeaconLoader";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type FilterMode = "total" | "personal" | "joint";

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** First day of the week (0=Sun) for the 1st of a month. */
function startDayOfWeek(year: number, month: number): number {
  return new Date(year, month - 1, 1).getDay();
}

/** Get the spend amount for a day given the filter mode and split ratio. */
function dayTotal(
  expenses: MonthlySpendingDay[] | undefined,
  filter: FilterMode,
  splitRatio: number,
): number {
  if (!expenses || expenses.length === 0) return 0;
  return expenses.reduce((sum, e) => {
    if (filter === "personal" && e.isJoint) return sum;
    if (filter === "joint" && !e.isJoint) return sum;
    const amt = e.isJoint ? e.amount * splitRatio : e.amount;
    return sum + amt;
  }, 0);
}

/** Pick a heat color using a square-root scale.
 *
 *  sqrt gives a gentler curve than log — it still boosts visibility of
 *  low-spend days but doesn't compress the top end as aggressively, keeping
 *  high-spend days clearly distinguishable from each other.
 *
 *  Both scales share a single symmetric anchor — absMax — which is the larger
 *  of |maxDaySpend| and |minDaySpend|. This means a -$100 day on a year where
 *  the biggest positive day is $3000 will appear faint green, not dark green. */
function heatColor(amount: number, absMax: number): string {
  if (absMax <= 0 || amount === 0) return "transparent";
  const intensity = Math.min(Math.sqrt(Math.abs(amount)) / Math.sqrt(absMax), 1);
  // 8 evenly-spaced opacity buckets from ~0 to 1
  if (amount < 0) {
    // Green scale using green-600 (#16a34a)
    if (intensity < 0.125) return "rgba(22, 163, 74, 0.07)";
    if (intensity < 0.250) return "rgba(22, 163, 74, 0.20)";
    if (intensity < 0.375) return "rgba(22, 163, 74, 0.33)";
    if (intensity < 0.500) return "rgba(22, 163, 74, 0.47)";
    if (intensity < 0.625) return "rgba(22, 163, 74, 0.60)";
    if (intensity < 0.750) return "rgba(22, 163, 74, 0.73)";
    if (intensity < 0.875) return "rgba(22, 163, 74, 0.87)";
    return "rgba(22, 163, 74, 1.00)";
  }
  // Red scale using red-600 (#dc2626)
  if (intensity < 0.125) return "rgba(220, 38, 38, 0.07)";
  if (intensity < 0.250) return "rgba(220, 38, 38, 0.20)";
  if (intensity < 0.375) return "rgba(220, 38, 38, 0.33)";
  if (intensity < 0.500) return "rgba(220, 38, 38, 0.47)";
  if (intensity < 0.625) return "rgba(220, 38, 38, 0.60)";
  if (intensity < 0.750) return "rgba(220, 38, 38, 0.73)";
  if (intensity < 0.875) return "rgba(220, 38, 38, 0.87)";
  return "rgba(220, 38, 38, 1.00)";
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

/**
 * Build the ordered list of expenses to display in the tooltip.
 *
 * Rules:
 * - Apply the current filter (personal / joint / total).
 * - Group each parent expense with its offsets. If the net of a parent+offsets
 *   cluster rounds to zero, omit the whole cluster (fully reimbursed).
 * - Expenses sharing a transactionGroupId are kept adjacent.
 * - Order: transaction-grouped clusters first (by tgId), then standalone.
 */
function buildTooltipRows(
  expenses: MonthlySpendingDay[],
  filter: FilterMode,
): MonthlySpendingDay[] {
  // 1. Apply filter
  const filtered = expenses.filter((e) => {
    if (filter === "personal") return !e.isJoint;
    if (filter === "joint") return e.isJoint;
    return true;
  });
  if (filtered.length === 0) return [];

  // 2. Build lookup structures
  const idSet = new Set(filtered.map((e) => e.id));

  // Map parentId -> offset expenses (only offsets whose parent is in the filtered set)
  const offsetsByParent = new Map<string, MonthlySpendingDay[]>();
  const offsetIds = new Set<string>();

  for (const e of filtered) {
    if (e.parentExpenseId && idSet.has(e.parentExpenseId)) {
      if (!offsetsByParent.has(e.parentExpenseId)) offsetsByParent.set(e.parentExpenseId, []);
      offsetsByParent.get(e.parentExpenseId)!.push(e);
      offsetIds.add(e.id);
    }
  }

  // 3. Build clusters: each top-level expense + its offsets
  // Cluster = [parent, ...offsets]; fully-zeroed clusters are dropped.
  const clusters: MonthlySpendingDay[][] = [];

  for (const e of filtered) {
    if (offsetIds.has(e.id)) continue; // handled as part of a parent cluster

    const offsets = offsetsByParent.get(e.id) ?? [];
    const net = e.amount + offsets.reduce((s, o) => s + o.amount, 0);
    if (Math.abs(net) < 0.005) continue; // fully zeroed out — omit both

    clusters.push([e, ...offsets]);
  }

  // 4. Sort clusters: transaction-grouped ones together (by tgId), nulls last
  clusters.sort((a, b) => {
    const tgA = a[0].transactionGroupId ?? "\uffff";
    const tgB = b[0].transactionGroupId ?? "\uffff";
    return tgA < tgB ? -1 : tgA > tgB ? 1 : 0;
  });

  return clusters.flat();
}

function DayTooltip({
  expenses,
  filter,
  splitRatio,
  x,
  y,
}: {
  expenses: MonthlySpendingDay[];
  filter: FilterMode;
  splitRatio: number;
  x: number;
  y: number;
}) {
  const rows = buildTooltipRows(expenses, filter);
  if (rows.length === 0) return null;

  const total = rows.reduce(
    (sum, e) => sum + (e.isJoint ? e.amount * splitRatio : e.amount),
    0,
  );

  return (
    <div
      className="pointer-events-none fixed z-50 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-lg"
      style={{ left: x + 12, top: y - 8 }}
    >
      <div className="flex justify-between gap-4 mb-1 pb-1 border-b border-border">
        <span className="font-semibold text-foreground">Total</span>
        <span className="font-semibold text-foreground">{formatCurrency(total)}</span>
      </div>
      <div className="space-y-0.5">
        {rows.map((e) => (
          <div
            key={e.id}
            className="flex justify-between gap-4"
            style={e.isRecurring ? { color: "var(--color-blue-400)" } : undefined}
          >
            <span className="truncate max-w-[160px]" style={e.isRecurring ? undefined : { color: "var(--color-muted-foreground)" }}>
              <span className="inline-block w-3 text-center font-medium opacity-70">{e.isJoint ? "J" : "P"}</span>
              {" "}{e.vendor}
            </span>
            <span className="font-medium whitespace-nowrap">
              {formatCurrency(e.amount)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Month Calendar ───────────────────────────────────────────────────────────

function MonthCalendar({
  data,
  year,
  filter,
  splitRatio,
  isFuture,
  isCurrentMonth,
  todayDay,
  absMaxDaySpend,
}: {
  data: MonthlySpendingMonth;
  year: number;
  filter: FilterMode;
  splitRatio: number;
  isFuture: boolean;
  isCurrentMonth: boolean;
  todayDay: number;
  absMaxDaySpend: number;
}) {
  const [tooltip, setTooltip] = useState<{
    expenses: MonthlySpendingDay[];
    x: number;
    y: number;
  } | null>(null);

  const numDays = daysInMonth(year, data.month);
  const offset = startDayOfWeek(year, data.month);

  const total = filter === "personal" ? data.personalTotal
    : filter === "joint" ? data.jointTotal
    : data.combinedTotal;
  const budget = filter === "personal" ? data.personalBudget
    : filter === "joint" ? data.jointBudget
    : data.combinedBudget;
  const isOver = budget > 0 && total > budget;

  // Build calendar grid cells — only the cells the month needs (leading
  // offset blanks + actual days). The outer CSS grid's default stretch
  // alignment ensures cards in the same row match the tallest sibling.
  const cells: React.ReactNode[] = [];

  // Empty leading cells for the weekday offset
  for (let i = 0; i < offset; i++) {
    cells.push(<div key={`empty-${i}`} className="aspect-square" />);
  }

  for (let day = 1; day <= numDays; day++) {
    const isDayFuture = isFuture || (isCurrentMonth && day > todayDay);
    const expenses = data.days[day];
    const spend = isDayFuture ? 0 : dayTotal(expenses, filter, splitRatio);
    const bg = isDayFuture ? undefined : heatColor(spend, absMaxDaySpend);
    const tooltipRows = !isDayFuture && expenses ? buildTooltipRows(expenses, filter) : [];
    const hasExpenses = tooltipRows.length > 0;
    const hasRecurring = hasExpenses && tooltipRows.some((e) => e.isRecurring);

    cells.push(
      <div
        key={day}
        className={`relative flex items-center justify-center rounded text-[11px] aspect-square ${
          isDayFuture ? "text-muted-foreground/40" : "text-foreground"
        } ${hasExpenses ? "cursor-default" : ""}`}
        style={bg ? { backgroundColor: bg } : undefined}
        onMouseEnter={(e) => {
          if (hasExpenses) {
            setTooltip({ expenses: expenses!, x: e.clientX, y: e.clientY });
          }
        }}
        onMouseMove={(e) => {
          if (tooltip) {
            setTooltip((prev) => prev ? { ...prev, x: e.clientX, y: e.clientY } : null);
          }
        }}
        onMouseLeave={() => setTooltip(null)}
      >
        {day}
        {hasRecurring && (
          <span
            className="absolute left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
            style={{ backgroundColor: "var(--color-blue-400)", bottom: "calc(var(--spacing) * 1.5)" }}
          />
        )}
      </div>
    );
  }

  return (
    <div className={`${isFuture ? "opacity-40" : ""} h-full`}>
      <Card className="p-4 h-full">
        <div className="mb-3 flex items-start justify-between">
          <h3 className="text-sm font-semibold">{MONTH_NAMES[data.month - 1]}</h3>
          {!isFuture && (
            <div className="text-right space-y-0.5">
              {filter === "total" ? (
                <>
                  <div className="text-xs text-muted-foreground">
                    Personal: <span className={`font-medium ${data.personalBudget > 0 && data.personalTotal > data.personalBudget ? "text-destructive" : "text-foreground"}`}>{formatCurrency(data.personalTotal)}</span>
                    {data.personalBudget > 0 && <span> / {formatCurrency(data.personalBudget)}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Joint: <span className={`font-medium ${data.jointBudget > 0 && data.jointTotal > data.jointBudget ? "text-destructive" : "text-foreground"}`}>{formatCurrency(data.jointTotal)}</span>
                    {data.jointBudget > 0 && <span> / {formatCurrency(data.jointBudget)}</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Total: <span className={`font-medium ${isOver ? "text-destructive" : "text-foreground"}`}>{formatCurrency(data.combinedTotal)}</span>
                    {data.combinedBudget > 0 && <span> / {formatCurrency(data.combinedBudget)}</span>}
                  </div>
                </>
              ) : (
                <div className="text-xs text-muted-foreground">
                  <span className={`font-medium ${isOver ? "text-destructive" : "text-foreground"}`}>{formatCurrency(total)}</span>
                  {budget > 0 && <span> / {formatCurrency(budget)}</span>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Day-of-week headers */}
        <div className="grid grid-cols-7 gap-0.5 mb-0.5">
          {DAY_LABELS.map((d) => (
            <div key={d} className="text-center text-[10px] text-muted-foreground font-medium">
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-0.5">
          {cells}
        </div>
      </Card>

      {tooltip && (
        <DayTooltip
          expenses={tooltip.expenses}
          filter={filter}
          splitRatio={splitRatio}
          x={tooltip.x}
          y={tooltip.y}
        />
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function MonthlySpending() {
  const navigate = useNavigate();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [filter, setFilter] = useState<FilterMode>("total");

  const { data, loading } = useApi(
    () => getMonthlySpending(year),
    [year],
  );

  const { data: dataRange } = useApi(() => getDataRange(), []);

  // Compute a single symmetric anchor for both color scales. Using the larger
  // of |max| and |min| ensures positive and negative shades are directly
  // comparable in magnitude across the whole year.
  const absMaxDaySpend = useMemo(() => {
    if (!data) return 0;
    let absMax = 0;
    for (const m of data.months) {
      for (const [, expenses] of Object.entries(m.days)) {
        const total = dayTotal(expenses, filter, data.splitRatio);
        if (Math.abs(total) > absMax) absMax = Math.abs(total);
      }
    }
    return absMax;
  }, [data, filter]);

  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1; // 1-indexed
  const todayDay = now.getDate();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/budgets")}
            className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2 className="text-2xl font-bold">Monthly Spending</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setYear((y) => y - 1)} disabled={dataRange ? year <= dataRange.minYear : false}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[4rem] text-center font-semibold">{year}</span>
          <Button variant="ghost" size="sm" onClick={() => setYear((y) => y + 1)} disabled={dataRange ? year >= dataRange.maxYear : false}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 rounded-lg bg-secondary p-1 w-fit">
        {(["total", "personal", "joint"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setFilter(mode)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === mode
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>

      {loading && <BeaconLoader className="h-64" />}

      {!loading && data && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.months.map((m) => {
            const isFuture = year > curYear || (year === curYear && m.month > curMonth);
            const isCurrentMonth = year === curYear && m.month === curMonth;
            return (
              <MonthCalendar
                key={m.month}
                data={m}
                year={year}
                filter={filter}
                splitRatio={data.splitRatio}
                isFuture={isFuture}
                isCurrentMonth={isCurrentMonth}
                todayDay={todayDay}
                absMaxDaySpend={absMaxDaySpend}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
