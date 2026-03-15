import { useState, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  PiggyBank,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Check,
  X,
  Info,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getBudgetOverview, setAnnualBudget } from "@/api";
import { formatCurrency } from "@/lib/utils";
import type { BudgetPanel, ChartDay } from "@/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function fmt(n: number) {
  return formatCurrency(Math.abs(n));
}

function pctLabel(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}${Math.abs(Math.round(v * 1000) / 10).toFixed(1)}%`;
}

/** Merge current/previous/priorYear series into a single recharts data array. */
function mergeChartData(
  current: ChartDay[],
  previous: ChartDay[],
  priorYear: ChartDay[],
) {
  const len = Math.max(current.length, previous.length, priorYear.length);
  return Array.from({ length: len }, (_, i) => ({
    day: i + 1,
    current:   current[i]?.cumulative   ?? null,
    previous:  previous[i]?.cumulative  ?? null,
    priorYear: priorYear[i]?.cumulative ?? null,
  }));
}

// ── Inline budget editor ──────────────────────────────────────────────────────

interface BudgetEditorProps {
  value: number | null;
  onSave: (v: number) => void;
}

function BudgetEditor({ value, onSave }: BudgetEditorProps) {
  const [editing, setEditing] = useState(false);
  const [input, setInput]     = useState("");

  const handleSave = () => {
    const n = parseFloat(input);
    if (!isNaN(n) && n >= 0) {
      onSave(n);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-lg text-muted-foreground">$</span>
        <input
          type="number"
          min="0"
          step="100"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-36 rounded-md border border-border px-2 py-1 text-xl font-bold focus:border-primary focus:outline-none"
          autoFocus
        />
        <button
          onClick={handleSave}
          className="rounded p-1 text-success hover:bg-success/10"
          title="Save"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={() => setEditing(false)}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
          title="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-2xl font-bold">
        {value != null ? fmt(value) : "Not set"}
      </span>
      <button
        onClick={() => {
          setInput(value?.toString() ?? "");
          setEditing(true);
        }}
        className="rounded p-1 text-muted-foreground hover:bg-accent"
        title="Edit budget"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Pace progress bar ─────────────────────────────────────────────────────────

interface PaceBarProps {
  normalizedYTD: number;
  budget: number;
  pctElapsed: number;
}

function PaceBar({ normalizedYTD, budget, pctElapsed }: PaceBarProps) {
  if (budget <= 0) return null;

  const spentPct   = Math.min((normalizedYTD / budget) * 100, 100);
  const overBudget = normalizedYTD > budget;
  const overPace   = normalizedYTD / budget > pctElapsed;

  return (
    <div className="space-y-1">
      <div className="relative h-3 overflow-hidden rounded-full bg-secondary">
        {/* Spent fill */}
        <div
          className={`h-full rounded-full transition-all ${
            overBudget ? "bg-destructive" : overPace ? "bg-warning" : "bg-success"
          }`}
          style={{ width: `${spentPct}%` }}
        />
        {/* Pace marker */}
        <div
          className="absolute top-0 h-full w-0.5 bg-foreground/40"
          style={{ left: `${Math.min(pctElapsed * 100, 100)}%` }}
          title={`${Math.round(pctElapsed * 100)}% of year elapsed`}
        />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{Math.round(spentPct)}% of budget used</span>
        <span>↑ {Math.round(pctElapsed * 100)}% of year elapsed</span>
      </div>
    </div>
  );
}

// ── Monthly comparison chart ──────────────────────────────────────────────────

interface ComparisonChartProps {
  chart: BudgetPanel["chart"];
  currentMonthName: string;
  prevMonthName: string;
  priorYearMonthName: string;
}

function ComparisonChart({
  chart,
  currentMonthName,
  prevMonthName,
  priorYearMonthName,
}: ComparisonChartProps) {
  const data = useMemo(
    () => mergeChartData(chart.current, chart.previous, chart.priorYear),
    [chart],
  );

  const hasData = data.some((d) => d.current || d.previous || d.priorYear);
  if (!hasData) return null;

  return (
    <div className="mt-4">
      <p className="mb-3 text-sm font-medium text-card-foreground">Monthly Spending</p>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            interval={4}
          />
          <YAxis
            tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            formatter={(value: number, name: string) => {
              const labels: Record<string, string> = {
                current:   currentMonthName,
                previous:  prevMonthName,
                priorYear: priorYearMonthName,
              };
              return [formatCurrency(value), labels[name] ?? name];
            }}
            labelFormatter={(day) => `Day ${day}`}
            contentStyle={{ fontSize: 12 }}
          />
          {/* Current month — solid primary */}
          <Line
            type="monotone"
            dataKey="current"
            stroke="var(--primary)"
            strokeWidth={2}
            dot={false}
            connectNulls
            strokeDasharray="6 3"
            name="current"
          />
          {/* Previous month — muted solid */}
          <Line
            type="monotone"
            dataKey="previous"
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            dot={false}
            connectNulls
            strokeOpacity={0.6}
            name="previous"
          />
          {/* Same month prior year — muted lighter */}
          <Line
            type="monotone"
            dataKey="priorYear"
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            connectNulls
            strokeOpacity={0.35}
            name="priorYear"
          />
          <ReferenceLine y={0} stroke="var(--border)" />
        </LineChart>
      </ResponsiveContainer>
      {/* Legend */}
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded" style={{ background: "var(--primary)", borderTop: "2px dashed var(--primary)" }} />
          {currentMonthName}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded bg-current opacity-60" />
          {prevMonthName}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 rounded bg-current opacity-35" style={{ borderTop: "2px dashed currentColor" }} />
          {priorYearMonthName}
        </span>
      </div>
    </div>
  );
}

// ── Budget panel ──────────────────────────────────────────────────────────────

interface PanelProps {
  title: string;
  subtitle?: string;
  panel: BudgetPanel;
  pctElapsed: number;
  editable?: boolean;
  onSaveBudget?: (amount: number) => void;
  currentMonthName: string;
  prevMonthName: string;
  priorYearMonthName: string;
  today: Date;
}

function BudgetPanelCard({
  title,
  subtitle,
  panel,
  pctElapsed,
  editable = false,
  onSaveBudget,
  currentMonthName,
  prevMonthName,
  priorYearMonthName,
  today,
}: PanelProps) {
  const { percentAboveBelow, projectedAnnual, remaining } = panel;
  const isOverPace  = percentAboveBelow > 0;
  const isNoBudget  = panel.effectiveAnnualBudget === 0;
  const daysLeft    = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate();

  return (
    <Card className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {title}
            </p>
            {subtitle && (
              <span className="text-xs text-muted-foreground">· {subtitle}</span>
            )}
          </div>
          {editable && onSaveBudget ? (
            <div className="mt-1">
              <p className="text-xs text-muted-foreground mb-0.5">Annual Budget</p>
              <BudgetEditor value={panel.annualBudget} onSave={onSaveBudget} />
            </div>
          ) : (
            <div className="mt-1">
              <p className="text-xs text-muted-foreground mb-0.5">Annual Budget (derived)</p>
              <p className="text-2xl font-bold">
                {panel.effectiveAnnualBudget > 0 ? fmt(panel.effectiveAnnualBudget) : "—"}
              </p>
            </div>
          )}
        </div>

        {/* Run-rate badge */}
        {!isNoBudget && (
          <div
            className={`flex-shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${
              isOverPace
                ? "bg-destructive/10 text-destructive"
                : "bg-success/10 text-success"
            }`}
          >
            {pctLabel(percentAboveBelow)} vs pace
          </div>
        )}
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label={`Jan–${MONTH_NAMES[today.getMonth() - 1] ?? "Dec"} total`}
          value={fmt(panel.ytdCompletedMonths)}
          sub="completed months"
        />
        <Metric
          label={`${currentMonthName} so far`}
          value={fmt(panel.mtdTotal)}
          sub={`${daysLeft} days remaining`}
        />
        <Metric
          label="Proj. annual spend"
          value={fmt(projectedAnnual)}
          valueClass={
            panel.effectiveAnnualBudget > 0 && projectedAnnual > panel.effectiveAnnualBudget
              ? "text-destructive"
              : undefined
          }
          sub={
            <span className="flex items-center gap-1">
              adjusted rate
              <span
                title="Recurring expenses are normalized to their expected annual cost so that large payments on a single day (e.g. rent on the 1st) don't distort the projection."
                className="cursor-help text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3 w-3" />
              </span>
            </span>
          }
        />
        <Metric
          label="Remaining budget"
          value={
            panel.effectiveAnnualBudget > 0
              ? (remaining < 0 ? "−" : "") + fmt(remaining)
              : "—"
          }
          valueClass={remaining < 0 ? "text-destructive" : "text-success"}
          sub={remaining < 0 ? "projected over budget" : "projected headroom"}
        />
      </div>

      {/* Progress bar */}
      {!isNoBudget && (
        <PaceBar
          normalizedYTD={panel.normalizedYTD}
          budget={panel.effectiveAnnualBudget}
          pctElapsed={pctElapsed}
        />
      )}

      {/* Monthly comparison chart */}
      <ComparisonChart
        chart={panel.chart}
        currentMonthName={currentMonthName}
        prevMonthName={prevMonthName}
        priorYearMonthName={priorYearMonthName}
      />
    </Card>
  );
}

// ── Metric tile ───────────────────────────────────────────────────────────────

function Metric({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-bold leading-tight ${valueClass ?? ""}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function Budgets() {
  const now       = new Date();
  const [year, setYear] = useState(now.getFullYear());

  const { data, loading, refetch } = useApi(
    () => getBudgetOverview(year),
    [year],
  );

  const handleSaveBudget = async (type: "personal" | "joint", amount: number) => {
    await setAnnualBudget(year, type, amount);
    refetch();
  };

  // Chart month labels
  const curMonth         = now.getMonth();      // 0-indexed
  const curYear          = now.getFullYear();
  const prevMonthIdx     = curMonth === 0 ? 11 : curMonth - 1;
  const prevMonthYear    = curMonth === 0 ? curYear - 1 : curYear;
  const currentMonthName = `${MONTH_NAMES[curMonth]} ${curYear}`;
  const prevMonthName    = `${MONTH_NAMES[prevMonthIdx]} ${prevMonthYear}`;
  const priorYearMonthName = `${MONTH_NAMES[curMonth]} ${curYear - 1}`;

  const sharedChartProps = { currentMonthName, prevMonthName, priorYearMonthName, today: now };

  const hasAnyBudget =
    data && (data.personal.annualBudget != null || data.joint.annualBudget != null);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Budget</h2>
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

      {loading && (
        <div className="py-12 text-center text-muted-foreground">Loading…</div>
      )}

      {!loading && !hasAnyBudget && (
        <EmptyState
          icon={PiggyBank}
          title="No budget set"
          description="Set a Personal or Joint annual budget below to start tracking your spending."
        />
      )}

      {!loading && data && (
        <>
          {/* Total — full width, most prominent */}
          <BudgetPanelCard
            title="Total"
            subtitle={`Personal + ${Math.round(data.settings.jointSplitRatio * 100)}% of Joint`}
            panel={data.total}
            pctElapsed={data.pctElapsed}
            editable={false}
            {...sharedChartProps}
          />

          {/* Personal + Joint — side by side */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <BudgetPanelCard
              title="Personal"
              panel={data.personal}
              pctElapsed={data.pctElapsed}
              editable
              onSaveBudget={(amount) => handleSaveBudget("personal", amount)}
              {...sharedChartProps}
            />
            <BudgetPanelCard
              title="Joint"
              subtitle={`your ${Math.round(data.settings.jointSplitRatio * 100)}% share`}
              panel={data.joint}
              pctElapsed={data.pctElapsed}
              editable
              onSaveBudget={(amount) => handleSaveBudget("joint", amount)}
              {...sharedChartProps}
            />
          </div>
        </>
      )}

      {/* ── Category breakdown (commented out — will be revisited in a later iteration) ──

      <Card>
        <CardHeader>
          <CardTitle>Spending by Category</CardTitle>
        </CardHeader>
        {categoryData.length > 0 ? (
          <div className="space-y-6">
            <ResponsiveContainer width="100%" height={Math.max(250, categoryData.length * 40)}>
              <BarChart data={categoryData} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis type="number" tickFormatter={(v) => `$${v}`} fontSize={12} />
                <YAxis type="category" dataKey="shortName" width={120} fontSize={12} />
                <Tooltip
                  formatter={(value: number) => formatCurrency(value)}
                  labelFormatter={(label) => {
                    const item = categoryData.find((c) => c.shortName === label);
                    return item?.name ?? label;
                  }}
                />
                <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
                  {categoryData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="divide-y divide-border">
              {categoryData.map((cat) => (
                <div key={cat.name} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full" style={{ backgroundColor: cat.color }} />
                    <span className="text-sm">{cat.name}</span>
                    <span className="text-xs text-muted-foreground">({cat.count} transactions)</span>
                  </div>
                  <div className="text-right">
                    <span className="font-medium">{formatCurrency(cat.amount)}</span>
                    {budgetAmount && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({Math.round((cat.amount / budgetAmount) * 100)}%)
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyState
            icon={PiggyBank}
            title="No spending data"
            description="Add expenses to see how your spending breaks down by category."
          />
        )}
      </Card>

      ── End category breakdown ── */}
    </div>
  );
}
