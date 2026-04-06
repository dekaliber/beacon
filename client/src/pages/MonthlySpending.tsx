import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, ArrowLeft } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { useApi } from "@/hooks/useApi";
import { getMonthlySpending } from "@/api";
import { formatCurrency } from "@/lib/utils";
import type { MonthlySpendingMonth, MonthlySpendingDay } from "@/types";

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

/** Pick a heat color using a log scale so low-spend days remain distinguishable
 *  even when a single outlier (e.g. rent) dominates the max. */
function heatColor(amount: number, maxAmount: number): string {
  if (amount <= 0 || maxAmount <= 0) return "transparent";
  // log1p avoids log(0) and gives a smooth curve from $1 upward
  const intensity = Math.min(Math.log1p(amount) / Math.log1p(maxAmount), 1);
  // Red scale using red-600 (#dc2626)
  if (intensity < 0.20) return "rgba(220, 38, 38, 0.10)";
  if (intensity < 0.35) return "rgba(220, 38, 38, 0.20)";
  if (intensity < 0.50) return "rgba(220, 38, 38, 0.35)";
  if (intensity < 0.65) return "rgba(220, 38, 38, 0.50)";
  if (intensity < 0.80) return "rgba(220, 38, 38, 0.65)";
  return "rgba(220, 38, 38, 0.80)";
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

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
  const filtered = expenses.filter((e) => {
    if (filter === "personal") return !e.isJoint;
    if (filter === "joint") return e.isJoint;
    return true;
  });
  if (filtered.length === 0) return null;

  const total = filtered.reduce(
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
        {filtered.map((e, i) => (
          <div key={i} className="flex justify-between gap-4">
            <span className="text-muted-foreground truncate max-w-[160px]">
              <span className="inline-block w-3 text-center font-medium text-muted-foreground/70">{e.isJoint ? "J" : "P"}</span>
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
  maxDaySpend,
}: {
  data: MonthlySpendingMonth;
  year: number;
  filter: FilterMode;
  splitRatio: number;
  isFuture: boolean;
  isCurrentMonth: boolean;
  todayDay: number;
  maxDaySpend: number;
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
    const bg = isDayFuture ? undefined : heatColor(spend, maxDaySpend);
    const hasExpenses = !isDayFuture && expenses && expenses.length > 0 &&
      expenses.some((e) =>
        filter === "total" || (filter === "personal" ? !e.isJoint : e.isJoint)
      );

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

  // Compute the max daily spend across the whole year for consistent heat scaling
  const maxDaySpend = useMemo(() => {
    if (!data) return 0;
    let max = 0;
    for (const m of data.months) {
      for (const [, expenses] of Object.entries(m.days)) {
        const total = dayTotal(expenses, filter, data.splitRatio);
        if (total > max) max = total;
      }
    }
    return max;
  }, [data, filter]);

  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1; // 1-indexed
  const todayDay = now.getDate();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
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
          <Button variant="ghost" size="sm" onClick={() => setYear((y) => y - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[4rem] text-center font-semibold">{year}</span>
          <Button variant="ghost" size="sm" onClick={() => setYear((y) => y + 1)}>
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

      {loading && (
        <div className="py-12 text-center text-muted-foreground">Loading...</div>
      )}

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
                maxDaySpend={maxDaySpend}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
