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
import { Link } from "react-router-dom";
import {
  PiggyBank,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Check,
  X,
  Info,
  CalendarDays,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getBudgetOverview, getCategoryOutliersYtd, setAnnualBudget } from "@/api";
import { CategoryOutliersChart } from "@/components/CategoryOutliersChart";
import { formatCurrency } from "@/lib/utils";
import type { BudgetPanel, BudgetOverview, CategoryOutliersData, ChartDay } from "@/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

const SHORT_MONTHS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

function fmt(n: number) {
  return formatCurrency(Math.abs(n));
}

function pctLabel(v: number): string {
  return `${Math.abs(Math.round(v * 1000) / 10).toFixed(1)}%`;
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
  helperText?: string;
}

function BudgetEditor({ value, onSave, helperText }: BudgetEditorProps) {
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
      <div className="space-y-1.5">
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
            className="w-36 rounded-md border border-border px-2 py-1 text-xl font-bold focus:border-primary focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
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
        {helperText && (
          <p className="text-xs text-muted-foreground">{helperText}</p>
        )}
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

// ── Projection explanation modal ──────────────────────────────────────────────

function ProjectionModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded-sm p-1 text-muted-foreground opacity-70 hover:opacity-100 hover:bg-accent"
        >
          <X className="h-4 w-4" />
        </button>

        <h3 className="mb-1 text-base font-semibold">How the annual projection works</h3>
        <p className="mb-5 text-xs text-muted-foreground">
          The projected annual spend, % vs pace, and progress bar use adjusted figures — not raw
          totals — to give you a stable view of your trajectory throughout the year.
        </p>

        <div className="space-y-5 text-sm">
          <section>
            <h4 className="mb-1.5 font-semibold text-foreground">Why raw totals can be misleading</h4>
            <p className="text-muted-foreground leading-relaxed">
              If you check your budget on January 2nd after paying a $4,000 rent on January 1st,
              your raw spend would suggest you're on pace for over $700,000 a year. The projection
              smooths this out by treating each recurring expense as if it were spread evenly
              across time, rather than hitting all at once.
            </p>
          </section>

          <section>
            <h4 className="mb-1.5 font-semibold text-foreground">How recurring expenses are normalized</h4>
            <p className="text-muted-foreground leading-relaxed">
              For any expense linked to a recurring rule — rent, utilities, subscriptions, and so
              on — the projection first estimates the full-year cost by adding up what you've
              actually paid, any upcoming payments already scheduled, and any remaining occurrences
              projected through year-end. It then spreads that estimated annual cost evenly over
              time, so the pace calculation reflects a steady accrual rather than lumpy payment
              dates.
            </p>
          </section>

          <section>
            <h4 className="mb-1.5 font-semibold text-foreground">When amounts vary month to month</h4>
            <p className="text-muted-foreground leading-relaxed">
              If a recurring payment has come through at least twice this year, the projection
              checks whether the most recent payment matches the rule's expected amount:
            </p>
            <ul className="mt-2 space-y-1.5 text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-0.5 shrink-0 text-foreground">•</span>
                <span>
                  <strong className="text-foreground">If it matches</strong>, the rule amount is
                  used going forward — the change was likely permanent (e.g. a rent increase).
                </span>
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 shrink-0 text-foreground">•</span>
                <span>
                  <strong className="text-foreground">If it doesn't match</strong>, the average of
                  all payments so far is used instead — the deviation was likely a one-time
                  adjustment, like a slightly different utility bill.
                </span>
              </li>
            </ul>
          </section>

          <section>
            <h4 className="mb-1.5 font-semibold text-foreground">Expenses that end before year-end</h4>
            <p className="text-muted-foreground leading-relaxed">
              If a recurring expense has an end date before December 31st, the projection only
              counts the portion of the year it's active — and the pace calculation only measures
              you against the budget for that window. For example, a $100/month subscription
              ending in June projects to $600 for the year, and the pace bar treats $600 as the
              relevant target while it's active, rather than $1,200.
            </p>
          </section>

          <section>
            <h4 className="mb-1.5 font-semibold text-foreground">One-off purchases</h4>
            <p className="text-muted-foreground leading-relaxed">
              Anything not linked to a recurring rule is treated as discretionary spend. These are
              projected linearly based on your average daily spending so far this year, so a large
              one-time purchase like a TV does move the run rate — by design, since it reflects
              real money spent.
            </p>
          </section>
        </div>
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
  /** Day-of-month for "today" — splits current line into solid (past) + dashed (future). */
  todayDay?: number;
}

function ComparisonChart({
  chart,
  currentMonthName,
  prevMonthName,
  priorYearMonthName,
  todayDay,
}: ComparisonChartProps) {
  const rawData = useMemo(
    () => mergeChartData(chart.current, chart.previous, chart.priorYear),
    [chart],
  );

  // Split current month into solid (days 1–today) and dashed (today–end).
  // Both series include todayDay so the segments connect visually; the custom
  // tooltip content renderer below drops `currentFuture` from the payload to
  // avoid showing the same value twice.
  const data = useMemo(() => {
    if (!todayDay) {
      return rawData.map((d) => ({ ...d, currentSolid: d.current, currentFuture: null }));
    }
    return rawData.map((d) => ({
      ...d,
      currentSolid:  d.day <= todayDay ? d.current : null,
      currentFuture: d.day >= todayDay ? d.current : null,
    }));
  }, [rawData, todayDay]);

  const hasData = rawData.some((d) => d.current || d.previous || d.priorYear);
  if (!hasData) return null;

  // Tailwind v4 defines colors as --color-* with full hex values, so
  // reference them directly without an hsl() wrapper.
  const colorPrimary = "var(--color-primary)";
  const colorMuted   = "var(--color-muted-foreground)";

  return (
    <div className="mt-4">
      <p className="mb-3 text-sm font-medium text-card-foreground">Monthly Spending</p>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 11, fill: colorMuted }}
            tickLine={false}
            interval={4}
          />
          <YAxis
            tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
            tick={{ fontSize: 11, fill: colorMuted }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const labels: Record<string, string> = {
                currentSolid:  currentMonthName,
                currentFuture: currentMonthName,
                previous:      prevMonthName,
                priorYear:     priorYearMonthName,
              };
              // Drop `currentFuture` — it duplicates `currentSolid` at the pivot day.
              const items = payload.filter((p) => p.dataKey !== "currentFuture");
              return (
                <div className="rounded border border-border bg-background p-3 text-xs shadow-md">
                  <p className="mb-2 font-medium">Day {label}</p>
                  {items.map((p) => (
                    <p key={p.dataKey as string} className="mt-1.5" style={{ color: p.stroke as string }}>
                      {labels[p.dataKey as string] ?? p.dataKey} : {formatCurrency(p.value as number)}
                    </p>
                  ))}
                </div>
              );
            }}
          />
          {/* Current month (past) — primary solid */}
          <Line
            type="monotone"
            dataKey="currentSolid"
            stroke={colorPrimary}
            strokeWidth={2}
            dot={false}
            connectNulls
            name="currentSolid"
          />
          {/* Current month (future) — primary dashed */}
          <Line
            type="monotone"
            dataKey="currentFuture"
            stroke={colorPrimary}
            strokeWidth={2}
            dot={false}
            connectNulls
            strokeDasharray="6 3"
            name="currentFuture"
          />
          {/* Previous month — muted solid */}
          <Line
            type="monotone"
            dataKey="previous"
            stroke={colorMuted}
            strokeWidth={1.5}
            dot={false}
            connectNulls
            strokeOpacity={0.6}
            name="previous"
          />
          {/* Same month prior year — primary at 30% opacity */}
          <Line
            type="monotone"
            dataKey="priorYear"
            stroke={colorPrimary}
            strokeWidth={1.5}
            dot={false}
            connectNulls
            strokeOpacity={0.3}
            name="priorYear"
          />
          <ReferenceLine y={0} stroke="var(--color-border)" />
        </LineChart>
      </ResponsiveContainer>
      {/* Legend */}
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {/* Solid segment + dashed segment to represent split current line */}
          <svg width="28" height="8">
            <line x1="0" y1="4" x2="14" y2="4" stroke={colorPrimary} strokeWidth="2" />
            <line x1="14" y1="4" x2="28" y2="4" stroke={colorPrimary} strokeWidth="2" strokeDasharray="4 3" />
          </svg>
          {currentMonthName}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={colorMuted} strokeWidth="1.5" strokeOpacity="0.6" /></svg>
          {prevMonthName}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={colorPrimary} strokeWidth="1.5" strokeOpacity="0.3" /></svg>
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
  completedMonthCount: number;
  monthsRemaining: number;
  editable?: boolean;
  budgetHelperText?: string;
  onSaveBudget?: (amount: number) => void;
  currentMonthName: string;
  prevMonthName: string;
  priorYearMonthName: string;
  today: Date;
  /** Day-of-month for the current viewing year (undefined for past/future years). */
  todayDay?: number;
  outliers?: CategoryOutliersData;
}

function BudgetPanelCard({
  title,
  subtitle,
  panel,
  pctElapsed,
  completedMonthCount,
  monthsRemaining,
  editable = false,
  budgetHelperText,
  onSaveBudget,
  currentMonthName,
  prevMonthName,
  priorYearMonthName,
  today,
  todayDay,
  outliers,
}: PanelProps) {
  const [showModal, setShowModal] = useState(false);
  const { projectedAnnual, remaining } = panel;
  const isOverPace = panel.percentAboveBelow > 0;
  const isNoBudget = panel.effectiveAnnualBudget === 0;
  // For historical/future years use the chart month (Dec / Jan); for the
  // current year use today so days-remaining stays accurate.
  const isCurrentYear = today.getFullYear() === parseInt(currentMonthName.split(" ")[1]);
  const mtdMonthLabel = currentMonthName.split(" ")[0];   // e.g. "Mar", "Dec"
  const daysLeft = isCurrentYear
    ? new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate()
    : 0;

  // ── Derived metrics ────────────────────────────────────────────────────────
  const avgMonthly =
    completedMonthCount > 0
      ? panel.ytdCompletedMonths / completedMonthCount
      : null;

  const remainingPerMonth =
    panel.effectiveAnnualBudget > 0 && monthsRemaining > 0
      ? remaining / monthsRemaining
      : null;

  // Completed months label: "Jan–Feb" / "Jan–Nov" / "Full year" / "Jan"
  const completedLabel =
    completedMonthCount === 0
      ? "No completed months yet"
      : completedMonthCount === 12
        ? "Full year"
        : completedMonthCount === 1
          ? "January"
          : `Jan–${SHORT_MONTHS[completedMonthCount - 1]}`;

  // Core metrics + pace bar block, shared between layouts
  const metricsBlock = (
    <>
      {/* Metrics — 3 columns × 2 rows */}
      <div className="grid grid-cols-3 gap-3">
        {/* Row 1 */}
        <Metric
          label={`${mtdMonthLabel} so far`}
          value={completedMonthCount > 0 || isCurrentYear ? fmt(panel.mtdTotal) : "—"}
          sub={isCurrentYear && daysLeft > 0 ? `${daysLeft} days remaining` : "month complete"}
        />
        <Metric
          label={completedLabel}
          value={completedMonthCount > 0 ? fmt(panel.ytdCompletedMonths) : "—"}
          sub="completed months"
        />
        <Metric
          label="Avg monthly spend"
          value={avgMonthly != null ? fmt(avgMonthly) : "—"}
          sub={completedMonthCount > 0 ? `over ${completedMonthCount} month${completedMonthCount !== 1 ? "s" : ""}` : "no completed months"}
        />

        {/* Row 2 */}
        <Metric
          label="Annual projection"
          value={fmt(projectedAnnual)}
          valueClass={
            panel.effectiveAnnualBudget > 0 && projectedAnnual > panel.effectiveAnnualBudget
              ? "text-destructive"
              : undefined
          }
          sub={
            <span className="flex items-center gap-1">
              adjusted rate
              <button
                onClick={() => setShowModal(true)}
                className="inline-flex items-center text-muted-foreground hover:text-foreground"
                title="How is this calculated?"
              >
                <Info className="h-3 w-3" />
              </button>
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
          valueClass={
            panel.effectiveAnnualBudget > 0
              ? remaining < 0
                ? "text-destructive"
                : "text-success"
              : undefined
          }
          sub={remaining < 0 ? "over budget" : "available to spend"}
        />
        <Metric
          label="Remaining / month"
          value={
            remainingPerMonth != null
              ? (remainingPerMonth < 0 ? "−" : "") + fmt(remainingPerMonth)
              : "—"
          }
          valueClass={
            remainingPerMonth != null
              ? remainingPerMonth < 0
                ? "text-destructive"
                : "text-success"
              : undefined
          }
          sub={
            monthsRemaining > 0
              ? `${monthsRemaining} month${monthsRemaining !== 1 ? "s" : ""} remaining`
              : "year complete"
          }
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
    </>
  );

  // Shared header block
  const headerBlock = (
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
            <BudgetEditor value={panel.annualBudget} onSave={onSaveBudget} helperText={budgetHelperText} />
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
          {pctLabel(panel.percentAboveBelow)} {isOverPace ? "over" : "under"} budget
        </div>
      )}
    </div>
  );

  return (
    <>
      {showModal && <ProjectionModal onClose={() => setShowModal(false)} />}

      {outliers ? (
        /* ── Total panel: 2-column layout ── */
        <Card className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Left: budget summary + monthly chart (half-width, matching Personal/Joint) */}
            <div className="flex flex-col gap-5">
              {headerBlock}
              {metricsBlock}
              <ComparisonChart
                chart={panel.chart}
                currentMonthName={currentMonthName}
                prevMonthName={prevMonthName}
                priorYearMonthName={priorYearMonthName}
                todayDay={todayDay}
              />
            </div>
            {/* Right: category outliers, vertically centered */}
            <div className="flex flex-col justify-center">
              <CategoryOutliersChart data={outliers} />
            </div>
          </div>
        </Card>
      ) : (
        /* ── Personal / Joint panel: original single-column layout ── */
        <Card className="flex flex-col gap-5">
          {headerBlock}
          {metricsBlock}
          <ComparisonChart
            chart={panel.chart}
            currentMonthName={currentMonthName}
            prevMonthName={prevMonthName}
            priorYearMonthName={priorYearMonthName}
            todayDay={todayDay}
          />
        </Card>
      )}
    </>
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
  const now   = new Date();
  const [year, setYear] = useState(now.getFullYear());

  const { data, loading, refetch } = useApi(
    () => getBudgetOverview(year),
    [year],
  );

  const { data: outliersData } = useApi(
    () => getCategoryOutliersYtd(year),
    [year],
  );

  const handleSaveBudget = async (type: "personal" | "joint", amount: number) => {
    await setAnnualBudget(year, type, amount);
    refetch();
  };

  // Completed-month / months-remaining counts derived from the viewed year
  const curYear      = now.getFullYear();
  const curMonthIdx  = now.getMonth();                      // 0-indexed

  const completedMonthCount =
    year < curYear ? 12 :
    year > curYear ? 0  :
    curMonthIdx;                                            // e.g. March → 2

  const monthsRemaining =
    year < curYear ? 0  :
    year > curYear ? 12 :
    12 - curMonthIdx;                                       // e.g. March → 10

  // Chart month labels — anchored to the same month used on the server
  const chartMonthIdx    = year < curYear ? 11 : year > curYear ? 0 : curMonthIdx;
  const chartYear        = year < curYear ? year : year > curYear ? year : curYear;
  const prevChartIdx     = chartMonthIdx === 0 ? 11 : chartMonthIdx - 1;
  const prevChartYear    = chartMonthIdx === 0 ? chartYear - 1 : chartYear;

  const currentMonthName   = `${SHORT_MONTHS[chartMonthIdx]} ${chartYear}`;
  const prevMonthName      = `${SHORT_MONTHS[prevChartIdx]} ${prevChartYear}`;
  const priorYearMonthName = `${SHORT_MONTHS[chartMonthIdx]} ${chartYear - 1}`;

  // todayDay is only meaningful when viewing the current year
  const todayDay = year === curYear ? now.getDate() : undefined;
  const sharedChartProps = { currentMonthName, prevMonthName, priorYearMonthName, today: now, todayDay };
  const sharedPanelProps = { completedMonthCount, monthsRemaining, ...sharedChartProps };

  const hasAnyBudget =
    data && (data.personal.annualBudget != null || data.joint.annualBudget != null);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Budget</h2>
        <div className="flex items-center gap-3">
          <Link
            to="/budgets/monthly-spending"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <CalendarDays className="h-4 w-4" />
            Monthly Spending
          </Link>
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
            outliers={outliersData ?? undefined}
            {...sharedPanelProps}
          />

          {/* Personal + Joint — side by side */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <BudgetPanelCard
              title="Personal"
              panel={data.personal}
              pctElapsed={data.pctElapsed}
              editable
              onSaveBudget={(amount) => handleSaveBudget("personal", amount)}
              {...sharedPanelProps}
            />
            <BudgetPanelCard
              title="Joint"
              subtitle={`your ${Math.round(data.settings.jointSplitRatio * 100)}% share`}
              panel={data.joint}
              pctElapsed={data.pctElapsed}
              editable
              budgetHelperText={`Enter your share of joint expenses. Actual joint spending is automatically divided by your ${Math.round(data.settings.jointSplitRatio * 100)}% split ratio.`}
              onSaveBudget={(amount) => handleSaveBudget("joint", amount)}
              {...sharedPanelProps}
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
