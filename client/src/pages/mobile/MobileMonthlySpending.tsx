import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { getMonthlySpending, getDataRange } from "@/api";
import { formatCurrency } from "@/lib/utils";
import type { MonthlySpendingMonth, MonthlySpendingDay } from "@/types";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

type FilterMode = "total" | "personal" | "joint";

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function startDayOfWeek(year: number, month: number): number {
  return new Date(year, month - 1, 1).getDay();
}

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

function heatColor(amount: number, absMax: number): string {
  if (absMax <= 0 || amount === 0) return "transparent";
  const intensity = Math.min(Math.sqrt(Math.abs(amount)) / Math.sqrt(absMax), 1);
  if (amount < 0) {
    if (intensity < 0.125) return "rgba(22, 163, 74, 0.07)";
    if (intensity < 0.250) return "rgba(22, 163, 74, 0.20)";
    if (intensity < 0.375) return "rgba(22, 163, 74, 0.33)";
    if (intensity < 0.500) return "rgba(22, 163, 74, 0.47)";
    if (intensity < 0.625) return "rgba(22, 163, 74, 0.60)";
    if (intensity < 0.750) return "rgba(22, 163, 74, 0.73)";
    if (intensity < 0.875) return "rgba(22, 163, 74, 0.87)";
    return "rgba(22, 163, 74, 1.00)";
  }
  if (intensity < 0.125) return "rgba(220, 38, 38, 0.07)";
  if (intensity < 0.250) return "rgba(220, 38, 38, 0.20)";
  if (intensity < 0.375) return "rgba(220, 38, 38, 0.33)";
  if (intensity < 0.500) return "rgba(220, 38, 38, 0.47)";
  if (intensity < 0.625) return "rgba(220, 38, 38, 0.60)";
  if (intensity < 0.750) return "rgba(220, 38, 38, 0.73)";
  if (intensity < 0.875) return "rgba(220, 38, 38, 0.87)";
  return "rgba(220, 38, 38, 1.00)";
}

function buildDetailRows(
  expenses: MonthlySpendingDay[],
  filter: FilterMode,
): MonthlySpendingDay[] {
  const filtered = expenses.filter((e) => {
    if (filter === "personal") return !e.isJoint;
    if (filter === "joint") return e.isJoint;
    return true;
  });
  if (filtered.length === 0) return [];

  const idSet = new Set(filtered.map((e) => e.id));
  const offsetsByParent = new Map<string, MonthlySpendingDay[]>();
  const offsetIds = new Set<string>();

  for (const e of filtered) {
    if (e.parentExpenseId && idSet.has(e.parentExpenseId)) {
      if (!offsetsByParent.has(e.parentExpenseId)) offsetsByParent.set(e.parentExpenseId, []);
      offsetsByParent.get(e.parentExpenseId)!.push(e);
      offsetIds.add(e.id);
    }
  }

  const clusters: MonthlySpendingDay[][] = [];
  for (const e of filtered) {
    if (offsetIds.has(e.id)) continue;
    const offsets = offsetsByParent.get(e.id) ?? [];
    const net = e.amount + offsets.reduce((s, o) => s + o.amount, 0);
    if (Math.abs(net) < 0.005) continue;
    clusters.push([e, ...offsets]);
  }

  clusters.sort((a, b) => {
    const tgA = a[0].transactionGroupId ?? "￿";
    const tgB = b[0].transactionGroupId ?? "￿";
    return tgA < tgB ? -1 : tgA > tgB ? 1 : 0;
  });

  return clusters.flat();
}

// ── Month card ────────────────────────────────────────────────────────────────

function MonthCard({
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
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  // Reset selection when filter or month changes
  const handleDayTap = (day: number, hasExpenses: boolean) => {
    if (!hasExpenses) { setSelectedDay(null); return; }
    setSelectedDay((prev) => (prev === day ? null : day));
  };

  const numDays = daysInMonth(year, data.month);
  const offset = startDayOfWeek(year, data.month);

  const total = filter === "personal" ? data.personalTotal
    : filter === "joint" ? data.jointTotal
    : data.combinedTotal;
  const budget = filter === "personal" ? data.personalBudget
    : filter === "joint" ? data.jointBudget
    : data.combinedBudget;
  const isOver = budget > 0 && total > budget;

  const cells: React.ReactNode[] = [];

  for (let i = 0; i < offset; i++) {
    cells.push(<div key={`empty-${i}`} className="aspect-square" />);
  }

  for (let day = 1; day <= numDays; day++) {
    const isDayFuture = isFuture || (isCurrentMonth && day > todayDay);
    const expenses = data.days[day];
    const spend = isDayFuture ? 0 : dayTotal(expenses, filter, splitRatio);
    const bg = isDayFuture ? undefined : heatColor(spend, absMaxDaySpend);
    const rows = !isDayFuture && expenses ? buildDetailRows(expenses, filter) : [];
    const hasExpenses = rows.length > 0;
    const hasRecurring = hasExpenses && rows.some((e) => e.isRecurring);
    const isSelected = selectedDay === day;

    cells.push(
      <button
        key={day}
        type="button"
        onClick={() => handleDayTap(day, hasExpenses)}
        className={`relative flex items-center justify-center rounded text-[11px] aspect-square transition-opacity ${
          isDayFuture ? "text-muted-foreground/40" : "text-foreground"
        } ${isSelected ? "ring-1 ring-primary" : ""}`}
        style={bg ? { backgroundColor: bg } : undefined}
      >
        {day}
        {hasRecurring && (
          <span
            className="absolute left-1/2 -translate-x-1/2 w-1 h-1 rounded-full"
            style={{ backgroundColor: "var(--color-blue-400)", bottom: "calc(var(--spacing) * 1.5)" }}
          />
        )}
      </button>,
    );
  }

  const selectedRows = selectedDay != null && data.days[selectedDay]
    ? buildDetailRows(data.days[selectedDay], filter)
    : [];
  const selectedTotal = selectedRows.reduce(
    (sum, e) => sum + (e.isJoint ? e.amount * splitRatio : e.amount),
    0,
  );

  return (
    <div className={isFuture ? "opacity-40" : ""}>
      <div className="rounded-xl border border-border bg-card p-4">
        {/* Card header */}
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
          {DAY_LABELS.map((d, i) => (
            <div key={i} className="text-center text-[10px] text-muted-foreground font-medium">
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-0.5">
          {cells}
        </div>

        {/* Tapped day detail */}
        {selectedDay != null && selectedRows.length > 0 && (
          <div className="mt-3 pt-3 border-t border-border">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-muted-foreground">
                {MONTH_NAMES[data.month - 1]} {selectedDay}
              </span>
              <span className="text-xs font-semibold">{formatCurrency(selectedTotal)}</span>
            </div>
            <div className="space-y-1.5">
              {selectedRows.map((e) => (
                <div
                  key={e.id}
                  className="flex items-center justify-between gap-3"
                  style={e.isRecurring ? { color: "var(--color-blue-400)" } : undefined}
                >
                  <span
                    className="text-xs truncate min-w-0"
                    style={e.isRecurring ? undefined : { color: "var(--color-muted-foreground)" }}
                  >
                    <span className="inline-block w-3 text-center font-medium opacity-70">{e.isJoint ? "J" : "P"}</span>
                    {" "}{e.vendor}
                  </span>
                  <span className="text-xs font-medium whitespace-nowrap">{formatCurrency(e.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function MobileMonthlySpending() {
  const navigate = useNavigate();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [filter, setFilter] = useState<FilterMode>("total");

  const { data, loading } = useApi(() => getMonthlySpending(year), [year]);
  const { data: dataRange } = useApi(() => getDataRange(), []);

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
  const curMonth = now.getMonth() + 1;
  const todayDay = now.getDate();

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/budgets")}
          className="rounded-full p-1.5 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-2xl font-bold flex-1">Monthly Spending</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setYear((y) => y - 1)}
            disabled={dataRange ? year <= dataRange.minYear : false}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[3rem] text-center text-sm font-semibold">{year}</span>
          <button
            onClick={() => setYear((y) => y + 1)}
            disabled={dataRange ? year >= dataRange.maxYear : false}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 rounded-lg bg-secondary p-1">
        {(["total", "personal", "joint"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setFilter(mode)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
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
        <div className="py-12 text-center text-muted-foreground">Loading…</div>
      )}

      {!loading && data && (
        <div className="space-y-3">
          {data.months.map((m) => {
            const isFuture = year > curYear || (year === curYear && m.month > curMonth);
            const isCurrentMonth = year === curYear && m.month === curMonth;
            return (
              <MonthCard
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
