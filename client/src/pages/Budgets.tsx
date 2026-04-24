import { useState, useMemo, useEffect } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
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
  ChevronDown,
  Pencil,
  X,
  Info,
  CalendarDays,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getBudgetOverview, getCategoryOutliersYtd, setAnnualBudget } from "@/api";
import { CategoryOutliersChart } from "@/components/CategoryOutliersChart";
import { formatCurrency } from "@/lib/utils";
import type { BudgetPanel, CategoryOutliersData, ChartDay, MonthlyTotal } from "@/types";

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

// ── Budget settings modal ─────────────────────────────────────────────────────

interface BudgetSettingsModalProps {
  open: boolean;
  onClose: () => void;
  personalBudget: number | null;
  jointBudget: number | null;
  jointSplitRatio: number;
  onSave: (personal: number | null, joint: number | null) => Promise<void>;
}

function BudgetSettingsModal({
  open,
  onClose,
  personalBudget,
  jointBudget,
  jointSplitRatio,
  onSave,
}: BudgetSettingsModalProps) {
  const [personal, setPersonal] = useState(personalBudget?.toString() ?? "");
  const [joint, setJoint]       = useState(jointBudget?.toString() ?? "");
  const [saving, setSaving]     = useState(false);

  useEffect(() => {
    if (open) {
      setPersonal(personalBudget?.toString() ?? "");
      setJoint(jointBudget?.toString() ?? "");
    }
  }, [open, personalBudget, jointBudget]);

  const handleSave = async () => {
    const p = personal.trim() === "" ? null : parseFloat(personal);
    const j = joint.trim() === ""    ? null : parseFloat(joint);
    if ((p !== null && (isNaN(p) || p < 0)) || (j !== null && (isNaN(j) || j < 0))) return;
    setSaving(true);
    try {
      await onSave(p, j);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

  return (
    <Modal open={open} onClose={onClose} title="Edit Budget">
      <div className="space-y-5">
        <div className="space-y-1.5">
          <label className="mb-1 block text-sm font-medium">Personal Annual Budget</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number"
              min="0"
              step="100"
              value={personal}
              onChange={(e) => setPersonal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              placeholder="0"
              className={inputClass}
              autoFocus
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="mb-1 block text-sm font-medium">Joint Annual Budget</label>
          <p className="text-xs text-muted-foreground">
            Enter your share of joint expenses. Actual joint spending is automatically
            divided by your {Math.round(jointSplitRatio * 100)}% split ratio.
          </p>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number"
              min="0"
              step="100"
              value={joint}
              onChange={(e) => setJoint(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              placeholder="0"
              className={inputClass}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
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
        <div
          className={`h-full rounded-full transition-all ${
            overBudget ? "bg-destructive" : overPace ? "bg-warning" : "bg-success"
          }`}
          style={{ width: `${spentPct}%` }}
        />
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
              you against the budget for that window.
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
  todayDay?: number;
  /** Monthly budget target — draws a horizontal reference line when set. */
  monthlyBudget?: number;
}

function ComparisonChart({
  chart,
  currentMonthName,
  prevMonthName,
  priorYearMonthName,
  todayDay,
  monthlyBudget,
}: ComparisonChartProps) {
  const rawData = useMemo(
    () => mergeChartData(chart.current, chart.previous, chart.priorYear),
    [chart],
  );

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

  // Compute a clean Y-axis domain and tick count so gridlines always land on
  // whole $1k/$2k/etc. boundaries. The key is to drive both the axis labels and
  // CartesianGrid from the same recharts-generated tick set (via tickCount +
  // domain) rather than passing explicit ticks — recharts uses explicit ticks
  // only for labels but generates gridlines from its own internal set, so the
  // two can diverge and produce missing or misaligned guidelines.
  const rawDataMax = Math.max(
    0,
    ...rawData.flatMap((d) => [d.current ?? 0, d.previous ?? 0, d.priorYear ?? 0]),
  );
  const yMax = Math.ceil((rawDataMax + 500) / 1000) * 1000;
  // Smallest increment where yMax / increment ≤ 5 (at most 5 intervals / 6 ticks).
  const yIncrement = [1000, 2000, 5000, 10000, 20000, 50000].find((i) => yMax / i <= 5) ?? 50000;
  // tickCount drives recharts' internal D3 tick generator, which also feeds
  // CartesianGrid. With a clean domain (yMax = N × yIncrement) D3 reliably
  // produces exactly these N+1 evenly-spaced values.
  const yTickCount = Math.round(yMax / yIncrement) + 1;

  const colorPrimary = "var(--color-primary)";
  const colorMuted   = "var(--color-muted-foreground)";

  return (
    <div>
      <ResponsiveContainer width="100%" height={160}>
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
            domain={[0, yMax]}
            tickCount={yTickCount}
            interval={0}
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
          <Line type="monotone" dataKey="currentSolid"  stroke={colorPrimary} strokeWidth={2}   dot={false} connectNulls name="currentSolid" />
          <Line type="monotone" dataKey="currentFuture" stroke={colorPrimary} strokeWidth={2}   dot={false} connectNulls strokeDasharray="6 3" name="currentFuture" />
          <Line type="monotone" dataKey="previous"      stroke={colorMuted}   strokeWidth={1.5} dot={false} connectNulls strokeOpacity={0.6} name="previous" />
          <Line type="monotone" dataKey="priorYear"     stroke={colorPrimary} strokeWidth={1.5} dot={false} connectNulls strokeOpacity={0.3} name="priorYear" />
          <ReferenceLine y={0} stroke="var(--color-border)" />
          {monthlyBudget != null && monthlyBudget > 0 && (
            <ReferenceLine
              y={monthlyBudget}
              stroke="var(--color-destructive)"
              strokeWidth={1}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap justify-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
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

// ── Band separator ────────────────────────────────────────────────────────────

function BandLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
        {children}
      </span>
      <div className="flex-1 h-px bg-border" />
      {action}
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
  showDiscretionary: boolean;
  onToggleDiscretionary: () => void;
  budgetLabel?: string;
  currentMonthName: string;
  prevMonthName: string;
  priorYearMonthName: string;
  today: Date;
  todayDay?: number;
  outliers?: CategoryOutliersData;
  monthlyTotals: MonthlyTotal[];
  panelType: "total" | "personal" | "joint";
}

function BudgetPanelCard({
  title,
  subtitle,
  panel,
  pctElapsed,
  completedMonthCount,
  monthsRemaining,
  showDiscretionary,
  onToggleDiscretionary,
  budgetLabel = "Annual Budget",
  currentMonthName,
  prevMonthName,
  priorYearMonthName,
  today,
  todayDay,
  outliers,
  monthlyTotals,
  panelType,
}: PanelProps) {
  const [showModal, setShowModal] = useState(false);

  const isCompletedYear = completedMonthCount === 12;

  // For a completed year the actual full-year total = Jan–Nov completed + December MTD.
  const fullYearTotal = panel.ytdCompletedMonths + panel.mtdTotal;

  // For a completed year, use actual spend vs budget instead of the projection-based ratio.
  const actualPctAboveBelow =
    panel.effectiveAnnualBudget > 0
      ? fullYearTotal / panel.effectiveAnnualBudget - 1
      : 0;

  const displayPctAboveBelow = isCompletedYear ? actualPctAboveBelow : panel.percentAboveBelow;
  const isOverPace = displayPctAboveBelow > 0;
  const isNoBudget = panel.effectiveAnnualBudget === 0;
  const isCurrentYear = today.getFullYear() === parseInt(currentMonthName.split(" ")[1]);
  const mtdMonthLabel = currentMonthName.split(" ")[0];
  const daysLeft = isCurrentYear
    ? new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate()
    : 0;

  // ── Derived metrics ──────────────────────────────────────────────────────
  // For a completed year, average over all 12 months (use fullYearTotal).
  const avgMonthly =
    completedMonthCount > 0
      ? (isCompletedYear ? fullYearTotal : panel.ytdCompletedMonths) / completedMonthCount
      : null;

  const paceVariance =
    panel.effectiveAnnualBudget > 0 && avgMonthly != null
      ? avgMonthly - panel.effectiveAnnualBudget / 12
      : null;

  // Toggle between full remaining (default) and discretionary-only
  const remainingValue = showDiscretionary ? panel.remaining : panel.remainingFull;
  const monthlyTarget  = monthsRemaining > 0 ? remainingValue / monthsRemaining : null;

  const completedLabel =
    completedMonthCount === 0
      ? "No completed months"
      : completedMonthCount === 12
        ? "Jan–Dec"
        : completedMonthCount === 1
          ? "January"
          : `Jan–${SHORT_MONTHS[completedMonthCount - 1]}`;

  // ── Bands ────────────────────────────────────────────────────────────────

  const pastBand = (
    <div className="space-y-2">
      <BandLabel>{isCompletedYear ? "Year Summary" : "Past"}</BandLabel>
      <div className="grid grid-cols-3 gap-3">
        <Metric
          label={completedLabel}
          value={completedMonthCount > 0 ? fmt(isCompletedYear ? fullYearTotal : panel.ytdCompletedMonths) : "—"}
          sub="completed months"
        />
        <Metric
          label="Avg monthly"
          value={avgMonthly != null ? fmt(avgMonthly) : "—"}
          sub={
            completedMonthCount > 0
              ? `over ${completedMonthCount} month${completedMonthCount !== 1 ? "s" : ""}`
              : "no completed months"
          }
        />
        <Metric
          label="vs budget pace"
          value={
            paceVariance != null
              ? (paceVariance > 0 ? "+" : "−") + fmt(paceVariance) + "/mo"
              : "—"
          }
          valueClass={
            paceVariance != null
              ? paceVariance > 0 ? "text-destructive" : "text-success"
              : undefined
          }
          sub={
            paceVariance != null
              ? paceVariance > 0 ? "running over" : "running under"
              : isNoBudget ? "no budget set" : "no completed months"
          }
        />
      </div>
    </div>
  );

  const thisMonthBand = (
    <div className="space-y-2">
      <BandLabel>This month</BandLabel>
      <div className="flex gap-4 items-start">
        <div className="w-40 shrink-0">
          <Metric
            label={`${mtdMonthLabel} so far`}
            value={completedMonthCount > 0 || isCurrentYear ? fmt(panel.mtdTotal) : "—"}
            valueClass={
              panel.effectiveAnnualBudget > 0 && (completedMonthCount > 0 || isCurrentYear)
                ? panel.mtdTotal > panel.effectiveAnnualBudget / 12
                  ? "text-destructive"
                  : "text-success"
                : undefined
            }
            sub={isCurrentYear && daysLeft > 0 ? `${daysLeft} days remaining` : "month complete"}
          />
        </div>
        <div className="flex-1 min-w-0">
          <ComparisonChart
            chart={panel.chart}
            currentMonthName={currentMonthName}
            prevMonthName={prevMonthName}
            priorYearMonthName={priorYearMonthName}
            todayDay={todayDay}
            monthlyBudget={panel.effectiveAnnualBudget > 0 ? panel.effectiveAnnualBudget / 12 : undefined}
          />
        </div>
      </div>
    </div>
  );

  // For a completed year: month-by-month stacked bar chart replacing "This Month"
  const showPersonalBar = panelType === "total" || panelType === "personal";
  const showJointBar    = panelType === "total" || panelType === "joint";
  const monthlySpendBand = (
    <div className="space-y-2">
      <BandLabel>Monthly Spend</BandLabel>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={monthlyTotals} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="label" fontSize={12} axisLine={false} tickLine={false} />
          <YAxis
            fontSize={12}
            tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <div className="rounded border border-border bg-background p-3 text-xs shadow-md">
                  <p className="mb-2 font-medium">{label}</p>
                  {payload.map((p) => (
                    <p key={p.dataKey as string} className="mt-1.5" style={{ color: p.fill as string }}>
                      {p.name} : {formatCurrency(p.value as number)}
                    </p>
                  ))}
                </div>
              );
            }}
            cursor={{ fill: "var(--color-muted)" }}
          />
          {showPersonalBar && (
            <Bar dataKey="personalSpent" name="Personal" stackId="a" fill="#9CA3AF" />
          )}
          {showJointBar && (
            <Bar dataKey="jointSpent" name="Joint" stackId="a" fill="#3B82F6" radius={[4, 4, 0, 0]} />
          )}
          {panel.effectiveAnnualBudget > 0 && (
            <ReferenceLine
              y={panel.effectiveAnnualBudget / 12}
              stroke="#EF4444"
              strokeWidth={1}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-1 flex items-center justify-center gap-5">
        {showPersonalBar && (
          <div className="flex items-center gap-1.5">
            <svg width={12} height={12}><rect width={12} height={12} rx={2} fill="#9CA3AF" /></svg>
            <span className="text-xs text-muted-foreground">Personal</span>
          </div>
        )}
        {showJointBar && (
          <div className="flex items-center gap-1.5">
            <svg width={12} height={12}><rect width={12} height={12} rx={2} fill="#3B82F6" /></svg>
            <span className="text-xs text-muted-foreground">Joint</span>
          </div>
        )}
        {panel.effectiveAnnualBudget > 0 && (
          <div className="flex items-center gap-1.5">
            <svg width={20} height={8}>
              <line x1="0" y1="4" x2="20" y2="4" stroke="#EF4444" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.5" />
            </svg>
            <span className="text-xs text-muted-foreground">Avg monthly budget</span>
          </div>
        )}
      </div>
    </div>
  );

  const restOfYearBand = (
    <div className="space-y-2">
      <BandLabel
        action={
          <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => showDiscretionary && onToggleDiscretionary()}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                !showDiscretionary
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Total remaining
            </button>
            <button
              type="button"
              onClick={() => !showDiscretionary && onToggleDiscretionary()}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                showDiscretionary
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Discretionary only
            </button>
          </div>
        }
      >
        Rest of year
      </BandLabel>
      <div className="grid grid-cols-3 gap-3">
        <Metric
          label="Annual projection"
          value={fmt(panel.projectedAnnual)}
          valueClass={
            panel.effectiveAnnualBudget > 0 && panel.projectedAnnual > panel.effectiveAnnualBudget
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
          label={showDiscretionary ? "Discretionary left" : "Remaining budget"}
          value={
            panel.effectiveAnnualBudget > 0
              ? (remainingValue < 0 ? "−" : "") + fmt(remainingValue)
              : "—"
          }
          sub={remainingValue < 0 ? "over budget" : "available to spend"}
        />
        <Metric
          label={showDiscretionary ? "Discretionary / mo" : "Monthly target"}
          value={
            monthlyTarget != null && panel.effectiveAnnualBudget > 0
              ? (monthlyTarget < 0 ? "−" : "") + fmt(monthlyTarget) + "/mo"
              : "—"
          }
          sub={
            monthsRemaining > 0
              ? `${monthsRemaining} month${monthsRemaining !== 1 ? "s" : ""} remaining`
              : "year complete"
          }
        />
      </div>
      {!isNoBudget && (
        <PaceBar
          normalizedYTD={panel.normalizedYTD}
          budget={panel.effectiveAnnualBudget}
          pctElapsed={pctElapsed}
        />
      )}
    </div>
  );

  const header = (
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
        <div className="mt-1">
          <p className="text-xs text-muted-foreground mb-0.5">{budgetLabel}</p>
          <p className="text-2xl font-bold">
            {panel.effectiveAnnualBudget > 0 ? fmt(panel.effectiveAnnualBudget) : "—"}
          </p>
        </div>
      </div>
      {!isNoBudget && (
        <div
          className={`flex-shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${
            isOverPace
              ? "bg-destructive/10 text-destructive"
              : "bg-success/10 text-success"
          }`}
        >
          {pctLabel(displayPctAboveBelow)} {isOverPace ? "over" : "under"} budget
        </div>
      )}
    </div>
  );

  const completedYearPaceBar = isCompletedYear && !isNoBudget && (
    <PaceBar
      normalizedYTD={fullYearTotal}
      budget={panel.effectiveAnnualBudget}
      pctElapsed={1}
    />
  );

  const bands = isCompletedYear ? (
    <>
      {pastBand}
      {completedYearPaceBar}
      {monthlySpendBand}
    </>
  ) : (
    <>
      {pastBand}
      {thisMonthBand}
      {restOfYearBand}
    </>
  );

  return (
    <>
      {showModal && <ProjectionModal onClose={() => setShowModal(false)} />}

      {outliers ? (
        <Card className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="flex flex-col gap-5">
              {header}
              {bands}
            </div>
            <div className="flex flex-col justify-center">
              <CategoryOutliersChart data={outliers} />
            </div>
          </div>
        </Card>
      ) : (
        <Card className="flex flex-col gap-5">
          {header}
          {bands}
        </Card>
      )}
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function Budgets() {
  const now   = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [showDiscretionary, setShowDiscretionary] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(
    () => localStorage.getItem("budget-show-breakdown") === "true",
  );
  const [budgetModalOpen, setBudgetModalOpen] = useState(false);

  const { data, loading, refetch } = useApi(
    () => getBudgetOverview(year),
    [year],
  );

  const { data: outliersData } = useApi(
    () => getCategoryOutliersYtd(year),
    [year],
  );

  const handleSaveBudgets = async (personal: number | null, joint: number | null) => {
    const promises: Promise<unknown>[] = [];
    if (personal !== null) promises.push(setAnnualBudget(year, "personal", personal));
    if (joint !== null)    promises.push(setAnnualBudget(year, "joint", joint));
    await Promise.all(promises);
    refetch();
  };

  const toggleBreakdown = () => {
    const next = !showBreakdown;
    setShowBreakdown(next);
    localStorage.setItem("budget-show-breakdown", String(next));
  };

  const curYear     = now.getFullYear();
  const curMonthIdx = now.getMonth(); // 0-indexed

  const completedMonthCount =
    year < curYear ? 12 :
    year > curYear ? 0  :
    curMonthIdx;

  // Exclude the current in-progress month: remaining full months are those
  // strictly after the current one (e.g. April → May–Dec = 8 months).
  const monthsRemaining =
    year < curYear ? 0  :
    year > curYear ? 12 :
    11 - curMonthIdx;

  const chartMonthIdx    = year < curYear ? 11 : year > curYear ? 0 : curMonthIdx;
  const chartYear        = year < curYear ? year : year > curYear ? year : curYear;
  const prevChartIdx     = chartMonthIdx === 0 ? 11 : chartMonthIdx - 1;
  const prevChartYear    = chartMonthIdx === 0 ? chartYear - 1 : chartYear;

  const currentMonthName   = `${SHORT_MONTHS[chartMonthIdx]} ${chartYear}`;
  const prevMonthName      = `${SHORT_MONTHS[prevChartIdx]} ${prevChartYear}`;
  const priorYearMonthName = `${SHORT_MONTHS[chartMonthIdx]} ${chartYear - 1}`;

  const todayDay = year === curYear ? now.getDate() : undefined;

  const sharedPanelProps = {
    completedMonthCount,
    monthsRemaining,
    showDiscretionary,
    onToggleDiscretionary: () => setShowDiscretionary((v) => !v),
    currentMonthName,
    prevMonthName,
    priorYearMonthName,
    today: now,
    todayDay,
  };

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
          <button
            onClick={() => setBudgetModalOpen(true)}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Pencil className="h-4 w-4" />
            Edit Budget
          </button>
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
          description="Set a Personal or Joint annual budget to start tracking your spending."
          action={
            <Button onClick={() => setBudgetModalOpen(true)}>
              <Pencil className="h-4 w-4" />
              Set Budget
            </Button>
          }
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
            budgetLabel="Annual Budget (derived)"
            outliers={outliersData ?? undefined}
            monthlyTotals={data.monthlyTotals}
            panelType="total"
            {...sharedPanelProps}
          />

          {/* Personal & Joint breakdown toggle */}
          <button
            onClick={toggleBreakdown}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <span>{showBreakdown ? "Hide" : "Show"} Personal & Joint breakdown</span>
            <ChevronDown
              className={`h-4 w-4 transition-transform duration-200 ${showBreakdown ? "rotate-180" : ""}`}
            />
          </button>

          {/* Personal + Joint side by side when expanded */}
          {showBreakdown && (
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <BudgetPanelCard
                title="Personal"
                panel={data.personal}
                pctElapsed={data.pctElapsed}
                monthlyTotals={data.monthlyTotals.map((m) => ({ ...m, jointSpent: 0 }))}
                panelType="personal"
                {...sharedPanelProps}
              />
              <BudgetPanelCard
                title="Joint"
                subtitle={`your ${Math.round(data.settings.jointSplitRatio * 100)}% share`}
                panel={data.joint}
                pctElapsed={data.pctElapsed}
                monthlyTotals={data.monthlyTotals.map((m) => ({ ...m, personalSpent: 0 }))}
                panelType="joint"
                {...sharedPanelProps}
              />
            </div>
          )}
        </>
      )}

      <BudgetSettingsModal
        open={budgetModalOpen}
        onClose={() => setBudgetModalOpen(false)}
        personalBudget={data?.personal.annualBudget ?? null}
        jointBudget={data?.joint.annualBudget ?? null}
        jointSplitRatio={data?.settings.jointSplitRatio ?? 0.5}
        onSave={handleSaveBudgets}
      />
    </div>
  );
}
