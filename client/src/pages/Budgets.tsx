import { useState, useEffect } from "react";
import {
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
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getBudgetOverview, getCategoryOutliersYtd, setAnnualBudget, getDataRange, getCategoryTrend, getCategoryYearTrends } from "@/api";
import { SpendingOverTimeChart } from "@/components/SpendingOverTimeChart";
import { formatCurrency } from "@/lib/utils";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import type { BudgetPanel, CategoryOutliersData, CategoryOutlier, MonthlyTotal } from "@/types";

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

function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000) return `$${Math.round(abs / 1000)}K`;
  if (abs >= 1_000)  return `$${(abs / 1000).toFixed(1)}K`;
  return `$${Math.round(abs)}`;
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
          <label className="block text-xs font-medium mb-1">Personal Annual Budget</label>
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
          <label className="block text-xs font-medium mb-1">Joint Annual Budget</label>
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

// ── Forecast range explanation modal ─────────────────────────────────────────

function ForecastRangeModal({ onClose }: { onClose: () => void }) {
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

        <h3 className="mb-1 text-base font-semibold">How the forecast range works</h3>
        <p className="mb-5 text-xs text-muted-foreground">
          The shaded band shows a statistical confidence range for your annual spend, based on how variable your monthly spending has been so far this year.
        </p>

        <div className="space-y-5 text-sm">
          <section>
            <h4 className="mb-1.5 font-semibold text-foreground">The core idea</h4>
            <p className="text-muted-foreground leading-relaxed">
              Your past monthly spend has a center (the average) and a spread (how much it varies month to month). The range projects that variability forward: the more erratic your spending has been, the wider the band.
            </p>
          </section>

          <section>
            <h4 className="mb-1.5 font-semibold text-foreground">How it's calculated</h4>
            <p className="text-muted-foreground leading-relaxed">
              The spread is the standard deviation of your completed monthly totals, scaled by the square root of the number of months remaining. This follows the standard rule for summing independent random variables: if each month has uncertainty σ, then N remaining months contribute σ√N of combined uncertainty.
            </p>
            <p className="mt-2 text-muted-foreground leading-relaxed">
              The final range is the annual projection ± that spread — the same projection shown to the left.
            </p>
          </section>

          <section>
            <h4 className="mb-1.5 font-semibold text-foreground">What it assumes</h4>
            <p className="text-muted-foreground leading-relaxed">
              The range assumes future months will vary similarly to how past months have varied. It doesn't predict what causes the variation, only how much. Consistent monthly spending produces a tight band; lumpy or irregular months produce a wide one.
            </p>
          </section>

          <section>
            <h4 className="mb-1.5 font-semibold text-foreground">When it appears</h4>
            <p className="text-muted-foreground leading-relaxed">
              The forecast range is shown once you have at least two completed months of data and a budget is set.
            </p>
          </section>
        </div>
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
  monthlyTotals: MonthlyTotal[];
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
  monthlyTotals,
}: PanelProps) {
  const [showModal, setShowModal] = useState(false);
  const [showForecastModal, setShowForecastModal] = useState(false);

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

  // ── Projection confidence range ────────────────────────────────────────
  // Compute std-dev spread of completed monthly totals, then project uncertainty
  // over remaining months (σ × √n_remaining). Only meaningful with ≥2 data points.
  const completedMonthlyAmounts = monthlyTotals
    .filter((m) => m.month <= completedMonthCount)
    .map((m) => m.personalSpent + m.jointSpent)
    .filter((v) => v > 0);

  let projectionLow: number | null = null;
  let projectionHigh: number | null = null;
  if (completedMonthlyAmounts.length >= 2 && !isNoBudget && !isCompletedYear) {
    const avg = completedMonthlyAmounts.reduce((a, b) => a + b, 0) / completedMonthlyAmounts.length;
    const variance = completedMonthlyAmounts.reduce((sum, x) => sum + Math.pow(x - avg, 2), 0) / completedMonthlyAmounts.length;
    const spread = Math.sqrt(variance) * Math.sqrt(Math.max(monthsRemaining, 0));
    projectionLow  = Math.max(0, panel.projectedAnnual - spread);
    projectionHigh = panel.projectedAnnual + spread;
  }

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

  const thisMonthBudget = panel.effectiveAnnualBudget > 0
    ? (panel.monthlyBudgets
        ? panel.monthlyBudgets[today.getMonth()].amount
        : panel.effectiveAnnualBudget / 12)
    : null;
  const remainingMonthly = thisMonthBudget !== null ? thisMonthBudget - panel.mtdTotal : null;
  const remainingDaily   = remainingMonthly !== null && daysLeft > 0 ? remainingMonthly / daysLeft : null;

  const thisMonthBand = (
    <div className="space-y-2">
      <BandLabel>This month</BandLabel>
      <div className="grid grid-cols-3 gap-3">
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
        <Metric
          label="Remaining spend target"
          value={remainingDaily !== null ? fmt(remainingDaily) : "—"}
          valueClass={remainingDaily !== null && remainingDaily < 0 ? "text-destructive" : undefined}
          sub={daysLeft > 0 ? "per day" : isCurrentYear ? "month complete" : undefined}
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

      {/* Row 1: Annual projection + forecast range */}
      <div className="rounded-lg bg-muted/40 px-3 py-2.5">
        <div className="flex gap-4 items-start">
          {/* Left 1/3: projection metric */}
          <div className="w-1/3 shrink-0">
            <p className="text-xs text-muted-foreground">Annual projection</p>
            <p className={`mt-0.5 text-lg font-bold leading-tight ${
              panel.effectiveAnnualBudget > 0 && panel.projectedAnnual > panel.effectiveAnnualBudget
                ? "text-destructive"
                : ""
            }`}>
              {fmt(panel.projectedAnnual)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
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
            </p>
          </div>

          {/* Right 2/3: forecast range */}
          {projectionLow !== null && projectionHigh !== null && (() => {
            const scaleMax  = Math.max(projectionHigh, panel.effectiveAnnualBudget) * 1.15;
            const lowPct    = Math.min((projectionLow  / scaleMax) * 100, 100);
            const centerPct = Math.min((panel.projectedAnnual / scaleMax) * 100, 100);
            const highPct   = Math.min((projectionHigh / scaleMax) * 100, 100);
            const budgetPct = Math.min((panel.effectiveAnnualBudget / scaleMax) * 100, 100);
            return (
              <div className="flex-1 min-w-0">
                <div className="mb-1 flex items-center gap-1">
                  <p className="text-xs text-muted-foreground">Annual forecast range</p>
                  <button
                    onClick={() => setShowForecastModal(true)}
                    className="inline-flex items-center text-muted-foreground hover:text-foreground"
                    title="How is this calculated?"
                  >
                    <Info className="h-3 w-3" />
                  </button>
                </div>
                {/* Forecast range label above bar, centered on projection mark */}
                <div className="relative h-4">
                  <span
                    className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground"
                    style={{ left: `${centerPct}%` }}
                  >
                    <span className="font-medium text-foreground">{fmtK(projectionLow)}</span>
                    {" – "}
                    <span className="font-medium text-foreground">{fmtK(projectionHigh)}</span>
                  </span>
                </div>
                {/* Bar */}
                <div className="relative h-2 rounded-full bg-secondary">
                  <div
                    className="absolute top-0 h-full rounded-full bg-primary/20"
                    style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }}
                  />
                  <div
                    className="absolute top-0 h-full w-0.5 rounded-full bg-primary"
                    style={{ left: `${centerPct}%` }}
                  />
                  <div
                    className="absolute top-0 h-full w-0.5 rounded-full bg-destructive/60"
                    style={{ left: `${budgetPct}%` }}
                  />
                </div>
                {/* Budget label below bar, centered on budget mark */}
                <div className="relative mt-1 h-4">
                  <span
                    className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-muted-foreground"
                    style={{ left: `${budgetPct}%` }}
                  >
                    Budget {fmtK(panel.effectiveAnnualBudget)}
                  </span>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Row 2: Remaining budget + monthly target */}
      <div className="grid grid-cols-3 gap-3">
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
      {showForecastModal && <ForecastRangeModal onClose={() => setShowForecastModal(false)} />}

      <Card className="flex flex-col gap-5">
        {header}
        {bands}
      </Card>
    </>
  );
}

// ── Category pacing ───────────────────────────────────────────────────────────

interface CategoryPacingCardProps {
  outliers: CategoryOutliersData;
  year: number;
}

function CategoryPacingCard({ outliers, year }: CategoryPacingCardProps) {
  const [showAll, setShowAll] = useState(false);

  const items = [...outliers.outliers]
    .filter((o) => o.currentAmount > 0 || o.previousAmount > 0)
    .sort((a, b) => {
      const aDev = a.previousAmount > 0 ? Math.abs(a.currentAmount / a.previousAmount - 1) : 1;
      const bDev = b.previousAmount > 0 ? Math.abs(b.currentAmount / b.previousAmount - 1) : 1;
      return bDev - aDev;
    });

  if (items.length === 0) return null;

  const significantItems = items.filter((o) => {
    if (o.previousAmount === 0) return true;
    return Math.abs(o.currentAmount / o.previousAmount - 1) >= 0.05;
  });
  const minorItems = items.filter((o) => {
    if (o.previousAmount === 0) return false;
    return Math.abs(o.currentAmount / o.previousAmount - 1) < 0.05;
  });

  const visibleItems = showAll ? items : significantItems;
  const maxAmount = Math.max(...visibleItems.map((i) => Math.max(i.currentAmount, i.previousAmount)));

  function renderRow(item: CategoryOutlier) {
    const pct = item.previousAmount > 0 ? item.currentAmount / item.previousAmount - 1 : null;
    const over = pct !== null && pct > 0;
    const barPct = maxAmount > 0 ? Math.min((item.currentAmount / maxAmount) * 100, 100) : 0;
    const refPct = maxAmount > 0 ? Math.min((item.previousAmount / maxAmount) * 100, 100) : 0;
    return (
      <div key={item.categoryId ?? item.categoryName} className="flex items-center gap-3">
        <div className="flex w-32 shrink-0 items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: item.color ?? "#9CA3AF" }}
          />
          <span className="truncate text-xs text-foreground">{item.categoryName}</span>
        </div>
        <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-secondary">
          <div
            className={`absolute top-0 h-full rounded-full ${over ? "bg-destructive/70" : "bg-success/70"}`}
            style={{ width: `${barPct}%` }}
          />
          {item.previousAmount > 0 && (
            <div
              className="absolute top-0 h-full w-0.5 bg-foreground/40"
              style={{ left: `${refPct}%` }}
            />
          )}
        </div>
        <div className="w-20 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
          {formatCurrency(item.currentAmount)}
        </div>
        <div className="w-20 shrink-0 text-right tabular-nums text-xs text-muted-foreground">
          {item.previousAmount > 0 ? formatCurrency(item.previousAmount) : "—"}
        </div>
        <div className={`w-12 shrink-0 text-right tabular-nums text-xs font-medium ${over ? "text-destructive" : item.currentAmount > 0 ? "text-success" : "text-muted-foreground"}`}>
          {pct !== null
            ? `${over ? "+" : ""}${Math.round(pct * 100)}%`
            : item.previousAmount === 0 ? "new" : "—"
          }
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Category Pacing</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          YTD spend vs same period {year - 1}
        </p>
      </CardHeader>
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-32 shrink-0" />
          <div className="flex-1" />
          <div className="w-20 shrink-0 text-right text-xs text-muted-foreground">{year} YTD</div>
          <div className="w-20 shrink-0 text-right text-xs text-muted-foreground">{year - 1}</div>
          <div className="w-12 shrink-0 text-right text-xs text-muted-foreground">vs {year - 1}</div>
        </div>
        {visibleItems.map(renderRow)}
        {minorItems.length > 0 && (
          <button
            className="text-xs text-primary hover:underline"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show less" : `Show ${minorItems.length} more (within ±5%)`}
          </button>
        )}
        <div className="flex items-center gap-4 border-t border-border pt-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-success/70" />
            Under prior year pace
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-destructive/70" />
            Over prior year pace
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-0.5 rounded-full bg-foreground/40" />
            {year - 1} baseline
          </span>
        </div>
      </div>
    </Card>
  );
}

// ── Monthly trend card ────────────────────────────────────────────────────────

interface MonthlyTrendCardProps {
  monthlyTotals: MonthlyTotal[];
  monthlyBudget: number | null;
}

function MonthlyTrendCard({ monthlyTotals, monthlyBudget }: MonthlyTrendCardProps) {
  const hasData = monthlyTotals.some((m) => m.personalSpent + m.jointSpent > 0);
  if (!hasData) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly Trend</CardTitle>
      </CardHeader>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={monthlyTotals} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="label" fontSize={10} axisLine={false} tickLine={false} />
          <YAxis
            fontSize={10}
            tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const total = payload.reduce((s, p) => s + (p.value as number), 0);
              return (
                <div className="rounded border border-border bg-background p-2 text-xs shadow-md">
                  <p className="mb-1.5 font-medium">{label}</p>
                  {payload.map((p) => (
                    <p key={p.dataKey as string} className="mt-1" style={{ color: p.fill as string }}>
                      {p.name}: {formatCurrency(p.value as number)}
                    </p>
                  ))}
                  <p className="mt-1.5 border-t border-border pt-1 font-medium text-foreground">
                    Total: {formatCurrency(total)}
                  </p>
                </div>
              );
            }}
            cursor={{ fill: "var(--color-muted)" }}
          />
          <Bar dataKey="personalSpent" name="Personal" stackId="a" fill={PERSONAL_COLOR} />
          <Bar dataKey="jointSpent" name="Joint" stackId="a" fill={JOINT_COLOR} radius={[3, 3, 0, 0]} />
          {monthlyBudget != null && monthlyBudget > 0 && (
            <ReferenceLine
              y={monthlyBudget}
              stroke="var(--color-destructive)"
              strokeWidth={1}
              strokeDasharray="3 3"
              strokeOpacity={0.5}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex items-center justify-center gap-4">
        <div className="flex items-center gap-1.5">
          <svg width={10} height={10}><rect width={10} height={10} rx={2} fill={PERSONAL_COLOR} /></svg>
          <span className="text-xs text-muted-foreground">Personal</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg width={10} height={10}><rect width={10} height={10} rx={2} fill={JOINT_COLOR} /></svg>
          <span className="text-xs text-muted-foreground">Joint</span>
        </div>
        {monthlyBudget != null && monthlyBudget > 0 && (
          <div className="flex items-center gap-1.5">
            <svg width={16} height={8}>
              <line x1="0" y1="4" x2="16" y2="4" stroke="var(--color-destructive)" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.5" />
            </svg>
            <span className="text-xs text-muted-foreground">Monthly budget</span>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Personal / Joint split card ───────────────────────────────────────────────

interface SplitCardProps {
  personal: BudgetPanel;
  joint: BudgetPanel;
}

function SplitCard({ personal, joint }: SplitCardProps) {
  const personalYTD   = personal.ytdCompletedMonths + personal.mtdTotal;
  const jointYTD      = joint.ytdCompletedMonths    + joint.mtdTotal;
  const grandTotal    = personalYTD + jointYTD;

  if (grandTotal === 0) return null;

  const actualPersonalPct = personalYTD / grandTotal;
  const actualJointPct    = 1 - actualPersonalPct;

  const totalBudget       = personal.effectiveAnnualBudget + joint.effectiveAnnualBudget;
  const hasBudgets        = totalBudget > 0;
  const targetPersonalPct = hasBudgets ? personal.effectiveAnnualBudget / totalBudget : null;
  const targetJointPct    = targetPersonalPct != null ? 1 - targetPersonalPct : null;

  function StreamCol({ label, color, ytd, actualPct, targetPct }: {
    label: string; color: string; ytd: number;
    actualPct: number; targetPct: number | null;
  }) {
    const overTarget = targetPct != null && actualPct > targetPct;
    const underTarget = targetPct != null && actualPct < targetPct;
    return (
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        </div>
        <p className="text-xl font-bold leading-tight">{fmt(ytd)}</p>
        <div className="space-y-0.5 text-xs">
          <p className={overTarget ? "text-destructive font-medium" : underTarget ? "text-success font-medium" : "text-muted-foreground"}>
            {Math.round(actualPct * 100)}% of actual spend
          </p>
          {targetPct != null && (
            <p className="text-muted-foreground">{Math.round(targetPct * 100)}% budget share</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Personal vs. Joint</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">YTD spend composition</p>
      </CardHeader>

      {/* Stacked composition bar — marker shows where the split should be per budget */}
      <div className="mb-4 space-y-1">
        <div className="relative h-5 overflow-hidden rounded-sm">
          <div className="absolute inset-0 flex">
            <div
              className="h-full shrink-0"
              style={{ width: `${actualPersonalPct * 100}%`, backgroundColor: PERSONAL_COLOR }}
            />
            <div className="h-full flex-1" style={{ backgroundColor: JOINT_COLOR }} />
          </div>
          {targetPersonalPct != null && (
            <div
              className="absolute top-0 h-full w-px bg-foreground/60"
              style={{ left: `${targetPersonalPct * 100}%` }}
            />
          )}
        </div>
        {targetPersonalPct != null && (
          <div className="relative h-4">
            <span
              className="absolute -translate-x-1/2 whitespace-nowrap text-xs text-muted-foreground"
              style={{ left: `${targetPersonalPct * 100}%` }}
            >
              target {Math.round(targetPersonalPct * 100)}% / {Math.round(targetJointPct! * 100)}%
            </span>
          </div>
        )}
      </div>

      <div className="flex gap-6">
        <StreamCol
          label="Personal"
          color={PERSONAL_COLOR}
          ytd={personalYTD}
          actualPct={actualPersonalPct}
          targetPct={targetPersonalPct}
        />
        <div className="w-px shrink-0 bg-border" />
        <StreamCol
          label="Joint"
          color={JOINT_COLOR}
          ytd={jointYTD}
          actualPct={actualJointPct}
          targetPct={targetJointPct}
        />
      </div>
    </Card>
  );
}

// ── Category avg monthly grid (completed years only) ─────────────────────────

function YoYBadge({ avgByYear, years, year }: { avgByYear: number[]; years: number[]; year: number }) {
  const curIdx  = years.indexOf(year);
  const prevIdx = years.indexOf(year - 1);
  if (curIdx === -1 || prevIdx === -1) return null;
  const cur  = avgByYear[curIdx];
  const prev = avgByYear[prevIdx];
  if (!prev) return null;

  const pct  = (cur - prev) / Math.abs(prev);
  const up   = pct > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  const abs  = Math.abs(Math.round(pct * 100));

  return (
    <div className={`w-20 flex flex-col items-center rounded-md p-2 ${
      up ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"
    }`}>
      <div className="flex items-center gap-1">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="text-base font-semibold leading-none">{abs}%</span>
      </div>
      <p className="mt-1 text-xs opacity-75">vs {year - 1}</p>
    </div>
  );
}

function CategoryAvgMonthlyGrid({ year, completedMonths }: { year: number; completedMonths: number }) {
  const { data }       = useApi(() => getCategoryTrend(year, completedMonths), [year, completedMonths]);
  const { data: trends } = useApi(() => getCategoryYearTrends(), []);
  if (!data || data.series.length === 0) return null;

  const trendsMap = new Map(trends?.series.map((s) => [s.categoryId, s]) ?? []);

  const items = data.series.map((s) => ({
    categoryId: s.categoryId,
    name:       s.name,
    color:      s.color,
    avgMonthly: s.values.reduce((sum, v) => sum + v, 0) / completedMonths,
    trend:      trendsMap.get(s.categoryId),
  }));

  const monthLabel = completedMonths === 12 ? "all 12 months" : `first ${completedMonths} months`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly Average by Category</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">Average monthly spend across {monthLabel}</p>
      </CardHeader>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => (
          <div key={item.categoryId} className="bg-muted/40 px-3 py-2.5 border-t border-border">
            <div className="flex items-center gap-1.5 mb-1">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <p className="truncate text-xs text-muted-foreground">{item.name}</p>
            </div>
            <div className="flex items-center mt-0.5">
              <div className="w-1/2">
                <p className="text-base font-bold leading-tight">{formatCurrency(item.avgMonthly)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">avg / month</p>
              </div>
              <div className="w-1/2 flex justify-center">
                {item.trend && trends && (
                  <YoYBadge avgByYear={item.trend.avgByYear} years={trends.years} year={year} />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
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

  const { data: dataRange } = useApi(() => getDataRange(), []);

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

  // SpendingOverTime: Jan–Dec for completed years, Jan–current month for current year.
  const trendMonth = year < curYear ? 12 : curMonthIdx + 1;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between">
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
            <Button variant="ghost" size="sm" onClick={() => setYear((y) => y - 1)} disabled={dataRange ? year <= dataRange.minYear : false}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[4rem] text-center font-semibold">{year}</span>
            <Button variant="ghost" size="sm" onClick={() => setYear((y) => y + 1)} disabled={dataRange ? year >= dataRange.maxYear : false}>
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
          {/* Total + split/trend right column */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <BudgetPanelCard
              title="Total"
              subtitle={`Personal + ${Math.round(data.settings.jointSplitRatio * 100)}% of Joint`}
              panel={data.total}
              pctElapsed={data.pctElapsed}
              budgetLabel="Annual Budget (derived)"
              monthlyTotals={data.monthlyTotals}
              {...sharedPanelProps}
            />
            <div className="flex flex-col gap-4">
              <SplitCard personal={data.personal} joint={data.joint} />
              <MonthlyTrendCard
                monthlyTotals={data.monthlyTotals.map((m) =>
                  year < curYear || m.month <= curMonthIdx + 1
                    ? m
                    : { ...m, personalSpent: 0, jointSpent: 0 }
                )}
                monthlyBudget={data.total.effectiveAnnualBudget > 0 ? data.total.effectiveAnnualBudget / 12 : null}
              />
            </div>
          </div>

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
                {...sharedPanelProps}
              />
              <BudgetPanelCard
                title="Joint"
                subtitle={`your ${Math.round(data.settings.jointSplitRatio * 100)}% share`}
                panel={data.joint}
                pctElapsed={data.pctElapsed}
                monthlyTotals={data.monthlyTotals.map((m) => ({ ...m, personalSpent: 0 }))}
                {...sharedPanelProps}
              />
            </div>
          )}

          {/* Category Pacing */}
          {outliersData && outliersData.outliers.length > 0 && (
            <CategoryPacingCard outliers={outliersData} year={year} />
          )}

          {/* Spending by Category Over Time — full width */}
          <SpendingOverTimeChart year={year} month={trendMonth} />

          {/* Monthly avg by category — completed months only */}
          {completedMonthCount > 0 && <CategoryAvgMonthlyGrid year={year} completedMonths={completedMonthCount} />}
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
