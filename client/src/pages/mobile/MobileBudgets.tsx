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
import {
  PiggyBank,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Pencil,
  Settings2,
  X,
  Info,
  Calendar,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { Button } from "@/components/Button";
import { BeaconLoader } from "@/components/BeaconLoader";
import { Card, CardHeader, CardTitle } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { PageHeadingMenu } from "@/components/PageHeadingMenu";
import { useApi } from "@/hooks/useApi";
import { getBudgetOverview, setAnnualBudget, getDataRange, getCategoryOutliersYtd, getCategoryTrend, getCategoryYearTrends } from "@/api";
import { formatCurrency, cn } from "@/lib/utils";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import type { BudgetPanel, MonthlyTotal, CategoryOutliersData, CategoryOutlier } from "@/types";
import { SectionLabel, DisplayStat } from "@/components/Typography";

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Budget settings sheet ─────────────────────────────────────────────────────

interface BudgetSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  personalBudget: number | null;
  jointBudget: number | null;
  jointSplitRatio: number;
  onSave: (personal: number | null, joint: number | null) => Promise<void>;
}

function BudgetSettingsSheet({
  open,
  onClose,
  personalBudget,
  jointBudget,
  jointSplitRatio,
  onSave,
}: BudgetSettingsSheetProps) {
  const [personal, setPersonal] = useState(personalBudget?.toString() ?? "");
  const [joint, setJoint]       = useState(jointBudget?.toString() ?? "");
  const [saving, setSaving]     = useState(false);

  useBodyScrollLock(open);

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
    "w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none";

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-[55] bg-black/40" onClick={onClose} />
      )}
      <div className={cn(
        "fixed inset-x-0 bottom-0 z-[60] rounded-t-2xl bg-background border-t border-border transition-transform duration-300",
        open ? "translate-y-0" : "translate-y-full",
      )}>
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="px-4 pb-8 space-y-5">
          <h2 className="tp-panel-title">Budget Settings</h2>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium">Personal Annual Budget</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={personal}
                onChange={(e) => setPersonal(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                placeholder="0.00"
                className={inputClass}
                autoFocus={open}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium">Joint Annual Budget</label>
            <p className="tp-caption">
              Enter your share of joint expenses. Actual joint spending is automatically
              divided by your {Math.round(jointSplitRatio * 100)}% split ratio.
            </p>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={joint}
                onChange={(e) => setJoint(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                placeholder="0.00"
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" className="flex-1" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Pace progress bar ─────────────────────────────────────────────────────────

function PaceBar({ normalizedYTD, budget, pctElapsed }: { normalizedYTD: number; budget: number; pctElapsed: number }) {
  if (budget <= 0) return null;

  const spentPct   = Math.min((normalizedYTD / budget) * 100, 100);
  const overBudget = normalizedYTD > budget;
  const overPace   = normalizedYTD / budget > pctElapsed;

  return (
    <div className="space-y-1">
      <div className="relative h-3 overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full rounded-full transition-all ${
            overBudget ? "bg-down" : overPace ? "bg-warn" : "bg-up"
          }`}
          style={{ width: `${spentPct}%` }}
        />
        <div
          className="absolute top-0 h-full w-0.5 bg-foreground/40"
          style={{ left: `${Math.min(pctElapsed * 100, 100)}%` }}
          title={`${Math.round(pctElapsed * 100)}% of year elapsed`}
        />
      </div>
      <div className="flex justify-between tp-caption">
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

        <h3 className="mb-1 tp-panel-title">How the annual projection works</h3>
        <p className="mb-5 tp-caption">
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

// ── Forecast range explanation modal ─────────────────────────────────────

function ForecastRangeModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
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

        <h3 className="mb-1 tp-panel-title">How the forecast range works</h3>
        <p className="mb-5 tp-caption">
          The range shows a statistical confidence band for your annual spend, based on how variable your monthly spending has been so far this year.
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
              The spread is the standard deviation of your completed monthly totals, scaled by the square root of the number of months remaining. The final range is the annual projection ± that spread.
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
  plain,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  valueClass?: string;
  plain?: boolean;
}) {
  return (
    <div className={plain ? "py-2.5" : "rounded-lg bg-muted/40 px-3 py-2.5"}>
      <p className="tp-caption">{label}</p>
      <p className={`mt-0.5 tp-stat leading-tight whitespace-nowrap ${valueClass ?? ""}`}>{value}</p>
      {sub && <p className="mt-0.5 tp-caption">{sub}</p>}
    </div>
  );
}

// ── Band separator ────────────────────────────────────────────────────────────

function BandLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <SectionLabel as="span" className="whitespace-nowrap">
        {children}
      </SectionLabel>
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
  today: Date;
  monthlyTotals: MonthlyTotal[];
}

function BudgetPanelSection({
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
  today,
  monthlyTotals,
}: PanelProps) {
  const [showModal, setShowModal] = useState(false);
  const [showForecastModal, setShowForecastModal] = useState(false);
  const [showSubtitleTip, setShowSubtitleTip] = useState(false);

  const isCompletedYear = completedMonthCount === 12;
  const fullYearTotal = panel.ytdCompletedMonths + panel.mtdTotal;

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

  const avgMonthly =
    completedMonthCount > 0
      ? (isCompletedYear ? fullYearTotal : panel.ytdCompletedMonths) / completedMonthCount
      : null;

  const paceVariance =
    panel.effectiveAnnualBudget > 0 && avgMonthly != null
      ? avgMonthly - panel.effectiveAnnualBudget / 12
      : null;

  const remainingValue = showDiscretionary ? panel.remaining : panel.remainingFull;
  const monthlyTarget  = monthsRemaining > 0 ? remainingValue / monthsRemaining : null;

  // Remaining spend target for current month
  const thisMonthBudget = panel.effectiveAnnualBudget > 0
    ? (panel.monthlyBudgets
        ? panel.monthlyBudgets[today.getMonth()].amount
        : panel.effectiveAnnualBudget / 12)
    : null;
  const remainingMonthly = thisMonthBudget !== null ? thisMonthBudget - panel.mtdTotal : null;
  const remainingDaily   = remainingMonthly !== null && daysLeft > 0 ? remainingMonthly / daysLeft : null;

  // Forecast range: std-dev of completed monthly totals × √months remaining
  const completedMonthlyAmounts = monthlyTotals
    .filter((m) => m.month <= completedMonthCount)
    .map((m) => m.personalSpent + m.jointSpent)
    .filter((v) => v > 0);

  let projectionLow: number | null = null;
  let projectionHigh: number | null = null;
  if (completedMonthlyAmounts.length >= 2 && !isNoBudget && !isCompletedYear) {
    const avg      = completedMonthlyAmounts.reduce((a, b) => a + b, 0) / completedMonthlyAmounts.length;
    const variance = completedMonthlyAmounts.reduce((sum, x) => sum + Math.pow(x - avg, 2), 0) / completedMonthlyAmounts.length;
    const spread   = Math.sqrt(variance) * Math.sqrt(Math.max(monthsRemaining, 0));
    projectionLow  = Math.max(0, panel.projectedAnnual - spread);
    projectionHigh = panel.projectedAnnual + spread;
  }

  const completedLabel =
    completedMonthCount === 0
      ? "No completed months"
      : completedMonthCount === 12
        ? "Jan–Dec"
        : completedMonthCount === 1
          ? "January"
          : `Jan–${SHORT_MONTHS[completedMonthCount - 1]}`;

  const pastBand = (
    <div className="space-y-2">
      <BandLabel>{isCompletedYear ? "Year Summary" : "Past"}</BandLabel>
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-3">
          <div className="min-w-[125px]">
            <Metric
              plain
              label={completedLabel}
              value={completedMonthCount > 0 ? fmt(isCompletedYear ? fullYearTotal : panel.ytdCompletedMonths) : "—"}
              sub="completed months"
            />
          </div>
          <div className="min-w-[125px]">
            <Metric
              plain
              label="Avg monthly"
              value={avgMonthly != null ? fmt(avgMonthly) : "—"}
              sub={
                completedMonthCount > 0
                  ? `over ${completedMonthCount} month${completedMonthCount !== 1 ? "s" : ""}`
                  : "no completed months"
              }
            />
          </div>
          <div className="min-w-[125px]">
            <Metric
              plain
              label="vs budget pace"
              value={
                paceVariance != null
                  ? (paceVariance > 0 ? "+" : "−") + fmt(paceVariance) + "/mo"
                  : "—"
              }
              valueClass={
                paceVariance != null
                  ? paceVariance > 0 ? "text-down" : "text-up"
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
      </div>
    </div>
  );

  const thisMonthBand = (
    <div className="space-y-2">
      <BandLabel>This month</BandLabel>
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-3">
          <div className="min-w-[125px]">
            <Metric
              plain
              label={`${mtdMonthLabel} so far`}
              value={completedMonthCount > 0 || isCurrentYear ? fmt(panel.mtdTotal) : "—"}
              valueClass={
                panel.effectiveAnnualBudget > 0 && (completedMonthCount > 0 || isCurrentYear)
                  ? panel.mtdTotal > panel.effectiveAnnualBudget / 12
                    ? "text-down"
                    : "text-up"
                  : undefined
              }
              sub={isCurrentYear && daysLeft > 0 ? `${daysLeft} days remaining` : "month complete"}
            />
          </div>
          <div className="min-w-[125px]">
            <Metric
              plain
              label="Remaining spend target"
              value={remainingDaily !== null ? fmt(remainingDaily) : "—"}
              valueClass={remainingDaily !== null && remainingDaily < 0 ? "text-down" : undefined}
              sub={daysLeft > 0 ? "per day" : isCurrentYear ? "month complete" : undefined}
            />
          </div>
        </div>
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
          <div className="flex items-center gap-0.5 rounded-lg bg-secondary p-0.5 text-xs font-medium">
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
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-3">
          <div className="min-w-[125px]">
            <Metric
              plain
              label="Annual projection"
              value={fmt(panel.projectedAnnual)}
              valueClass={
                panel.effectiveAnnualBudget > 0 && panel.projectedAnnual > panel.effectiveAnnualBudget
                  ? "text-down"
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
          </div>
          <div className="min-w-[125px]">
            <Metric
              plain
              label={showDiscretionary ? "Discretionary left" : "Remaining budget"}
              value={
                panel.effectiveAnnualBudget > 0
                  ? (remainingValue < 0 ? "−" : "") + fmt(remainingValue)
                  : "—"
              }
              sub={remainingValue < 0 ? "over budget" : "available to spend"}
            />
          </div>
          <div className="min-w-[125px]">
            <Metric
              plain
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
          {projectionLow !== null && projectionHigh !== null && (
            <div className="min-w-[140px]">
              <Metric
                plain
                label="Forecast range"
                value={`${fmtK(projectionLow)} – ${fmtK(projectionHigh)}`}
                sub="annual range"
              />
            </div>
          )}
        </div>
      </div>
      {projectionLow !== null && projectionHigh !== null && (() => {
        const scaleMax  = Math.max(projectionHigh, panel.effectiveAnnualBudget) * 1.15;
        const lowPct    = Math.min((projectionLow  / scaleMax) * 100, 100);
        const centerPct = Math.min((panel.projectedAnnual / scaleMax) * 100, 100);
        const highPct   = Math.min((projectionHigh / scaleMax) * 100, 100);
        const budgetPct = Math.min((panel.effectiveAnnualBudget / scaleMax) * 100, 100);
        return (
          <div>
            <div className="mb-1 flex items-center gap-1">
              <p className="tp-caption">Annual forecast range</p>
              <button
                onClick={() => setShowForecastModal(true)}
                className="inline-flex items-center text-muted-foreground hover:text-foreground"
                title="How is this calculated?"
              >
                <Info className="h-3 w-3" />
              </button>
            </div>
            <div className="relative h-4">
              <span
                className="absolute -translate-x-1/2 whitespace-nowrap text-10 text-muted-foreground"
                style={{ left: `${centerPct}%` }}
              >
                <span className="font-medium text-foreground">{fmtK(projectionLow)}</span>
                {" – "}
                <span className="font-medium text-foreground">{fmtK(projectionHigh)}</span>
              </span>
            </div>
            <div className="relative h-2 rounded-full bg-secondary">
              <div className="absolute top-0 h-full rounded-full bg-primary/20" style={{ left: `${lowPct}%`, width: `${highPct - lowPct}%` }} />
              <div className="absolute top-0 h-full w-0.5 rounded-full bg-primary" style={{ left: `${centerPct}%` }} />
              <div className="absolute top-0 h-full w-0.5 rounded-full bg-down/60" style={{ left: `${budgetPct}%` }} />
            </div>
            <div className="relative mt-1 h-4">
              <span
                className="absolute -translate-x-1/2 whitespace-nowrap text-10 text-muted-foreground"
                style={{ left: `${budgetPct}%` }}
              >
                Budget {fmtK(panel.effectiveAnnualBudget)}
              </span>
            </div>
          </div>
        );
      })()}
    </div>
  );

  const header = (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="tp-card-title">{title}</span>
          {subtitle && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowSubtitleTip((v) => !v)}
                className="flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                aria-label="More info"
              >
                <Info className="h-3.5 w-3.5" />
              </button>
              {showSubtitleTip && (
                <div className="absolute left-full top-1/2 z-10 ml-2 w-max max-w-[200px] -translate-y-1/2 rounded-lg border border-border bg-card px-3 py-2 tp-caption shadow-md">
                  {subtitle}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mt-1">
          <p className="tp-fineprint mb-0.5">{budgetLabel}</p>
          <DisplayStat as="p" className="tp-kpi-l">
            {panel.effectiveAnnualBudget > 0 ? fmt(panel.effectiveAnnualBudget) : "—"}
          </DisplayStat>
        </div>
      </div>
      {!isNoBudget && (
        <div
          className={`tp-delta-pill flex-shrink-0 ${isOverPace ? "down" : "up"}`}
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
      <div className="flex flex-col gap-5">
        {header}
        {bands}
      </div>
    </>
  );
}

// ── Personal / Joint split ────────────────────────────────────────────────────

function SplitSection({ personal, joint }: { personal: BudgetPanel; joint: BudgetPanel }) {
  const personalYTD = personal.ytdCompletedMonths + personal.mtdTotal;
  const jointYTD    = joint.ytdCompletedMonths    + joint.mtdTotal;
  const grandTotal  = personalYTD + jointYTD;

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
    const overTarget  = targetPct != null && actualPct > targetPct;
    const underTarget = targetPct != null && actualPct < targetPct;
    return (
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <SectionLabel as="span">{label}</SectionLabel>
        </div>
        <DisplayStat as="p" className="tp-stat leading-tight">{fmt(ytd)}</DisplayStat>
        <div className="space-y-0.5 text-xs font-mono">
          <p className={overTarget ? "text-down font-medium" : underTarget ? "text-up font-medium" : "text-muted-foreground"}>
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
        <p className="mt-0.5 tp-caption">YTD spend composition</p>
      </CardHeader>
      <div className="mb-4 space-y-1">
        <div className="relative h-5 overflow-hidden rounded-sm">
          <div className="absolute inset-0 flex">
            <div className="h-full shrink-0" style={{ width: `${actualPersonalPct * 100}%`, backgroundColor: PERSONAL_COLOR }} />
            <div className="h-full flex-1" style={{ backgroundColor: JOINT_COLOR }} />
          </div>
          {targetPersonalPct != null && (
            <div className="absolute top-0 h-full w-px bg-foreground/60" style={{ left: `${targetPersonalPct * 100}%` }} />
          )}
        </div>
        {targetPersonalPct != null && (
          <div className="relative h-4">
            <span
              className="absolute -translate-x-1/2 whitespace-nowrap tp-caption"
              style={{ left: `${targetPersonalPct * 100}%` }}
            >
              target {Math.round(targetPersonalPct * 100)}% / {Math.round(targetJointPct! * 100)}%
            </span>
          </div>
        )}
      </div>
      <div className="flex gap-6">
        <StreamCol label="Personal" color={PERSONAL_COLOR} ytd={personalYTD} actualPct={actualPersonalPct} targetPct={targetPersonalPct} />
        <div className="w-px shrink-0 bg-border" />
        <StreamCol label="Joint" color={JOINT_COLOR} ytd={jointYTD} actualPct={actualJointPct} targetPct={targetJointPct} />
      </div>
    </Card>
  );
}

// ── Monthly trend ─────────────────────────────────────────────────────────────

function MonthlyTrendSection({ monthlyTotals, monthlyBudget }: { monthlyTotals: MonthlyTotal[]; monthlyBudget: number | null }) {
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
            <ReferenceLine y={monthlyBudget} stroke="var(--color-down)" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.5} />
          )}
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex items-center justify-center gap-4">
        <div className="flex items-center gap-1.5">
          <svg width={10} height={10}><rect width={10} height={10} rx={2} fill={PERSONAL_COLOR} /></svg>
          <span className="tp-caption">Personal</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg width={10} height={10}><rect width={10} height={10} rx={2} fill={JOINT_COLOR} /></svg>
          <span className="tp-caption">Joint</span>
        </div>
        {monthlyBudget != null && monthlyBudget > 0 && (
          <div className="flex items-center gap-1.5">
            <svg width={16} height={8}>
              <line x1="0" y1="4" x2="16" y2="4" stroke="var(--color-down)" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.5" />
            </svg>
            <span className="tp-caption">Monthly budget</span>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── Category pacing table ─────────────────────────────────────────────────────

function CategoryPacingTable({ outliers, year }: { outliers: CategoryOutliersData; year: number }) {
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

  return (
    <Card>
      <div className="mb-3">
        <p className="tp-panel-title">Category Pacing</p>
        <p className="tp-caption">YTD spend vs same period {year - 1}</p>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="pb-1.5 text-left font-medium">Category</th>
            <th className="px-2 pb-1.5 text-right font-medium">{year} YTD</th>
            <th className="px-2 pb-1.5 text-right font-medium">{year - 1}</th>
            <th className="pb-1.5 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {visibleItems.map((item: CategoryOutlier, i: number) => {
            const pct   = item.previousAmount > 0 ? item.currentAmount / item.previousAmount - 1 : null;
            const over  = pct !== null && pct > 0;
            const changeColor = over ? "text-down" : item.currentAmount > 0 ? "text-up" : "text-muted-foreground";
            return (
              <tr
                key={item.categoryId ?? `__cat${i}__`}
                className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-muted/15" : ""}`}
              >
                <td className="py-1.5 pr-2">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color ?? "#9CA3AF" }} />
                    {item.categoryName}
                  </span>
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums font-mono">{formatCurrency(item.currentAmount)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums font-mono text-muted-foreground">
                  {item.previousAmount > 0 ? formatCurrency(item.previousAmount) : "—"}
                </td>
                <td className={`py-1.5 pl-2 text-right tabular-nums font-mono font-semibold ${changeColor}`}>
                  {pct !== null
                    ? `${over ? "+" : ""}${Math.round(pct * 100)}%`
                    : item.previousAmount === 0 ? "new" : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {minorItems.length > 0 && (
        <button
          className="mt-2 text-xs text-primary hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Show less" : `Show ${minorItems.length} more (within ±5%)`}
        </button>
      )}
    </Card>
  );
}

// ── Monthly average by category ───────────────────────────────────────────────

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
      up ? "bg-down/10 text-down" : "bg-up/10 text-up"
    }`}>
      <div className="flex items-center gap-1">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="tp-panel-title leading-none">{abs}%</span>
      </div>
      <p className="mt-1 text-xs opacity-75">vs {year - 1}</p>
    </div>
  );
}

function CategoryAvgMonthlyGrid({ year, completedMonths }: { year: number; completedMonths: number }) {
  const { data }         = useApi(() => getCategoryTrend(year, completedMonths), [year, completedMonths]);
  const { data: trends } = useApi(() => getCategoryYearTrends(), []);
  if (!data || data.series.length === 0) return null;

  const trendsMap = new Map(trends?.series.map((s: { categoryId: string; avgByYear: number[] }) => [s.categoryId, s]) ?? []);
  const items = data.series.map((s: { categoryId: string; name: string; color: string; values: number[] }) => ({
    categoryId: s.categoryId,
    name:       s.name,
    color:      s.color,
    avgMonthly: s.values.reduce((sum: number, v: number) => sum + v, 0) / completedMonths,
    trend:      trendsMap.get(s.categoryId),
  }));

  const monthLabel = completedMonths === 12 ? "all 12 months" : `first ${completedMonths} months`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly Average by Category</CardTitle>
        <p className="mt-0.5 tp-caption">Average monthly spend across {monthLabel}</p>
      </CardHeader>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {items.map((item: { categoryId: string; name: string; color: string; avgMonthly: number; trend: { avgByYear: number[] } | undefined }) => (
          <div key={item.categoryId} className="bg-muted/40 px-3 py-2.5 border-t border-border">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
              <p className="truncate tp-caption">{item.name}</p>
            </div>
            <div className="flex items-center mt-0.5">
              <div className="w-1/2">
                <p className="tp-stat leading-tight">{formatCurrency(item.avgMonthly)}</p>
                <p className="mt-0.5 tp-caption">avg / month</p>
              </div>
              <div className="w-1/2 flex justify-center">
                {item.trend && trends && (
                  <YoYBadge avgByYear={(item.trend as { avgByYear: number[] }).avgByYear} years={trends.years} year={year} />
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

export function MobileBudgets() {
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

  const { data: dataRange }    = useApi(() => getDataRange(), []);
  const { data: outliersData } = useApi(() => getCategoryOutliersYtd(year), [year]);

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
  const curMonthIdx = now.getMonth();

  const completedMonthCount =
    year < curYear ? 12 :
    year > curYear ? 0  :
    curMonthIdx;

  const monthsRemaining =
    year < curYear ? 0  :
    year > curYear ? 12 :
    11 - curMonthIdx;

  const chartMonthIdx = year < curYear ? 11 : year > curYear ? 0 : curMonthIdx;
  const chartYear     = year < curYear ? year : year > curYear ? year : curYear;

  const currentMonthName = `${SHORT_MONTHS[chartMonthIdx]} ${chartYear}`;

  const sharedPanelProps = {
    completedMonthCount,
    monthsRemaining,
    showDiscretionary,
    onToggleDiscretionary: () => setShowDiscretionary((v) => !v),
    currentMonthName,
    today: now,
  };

  const hasAnyBudget =
    data && (data.personal.annualBudget != null || data.joint.annualBudget != null);


  if (loading) return <BeaconLoader />;

  return (
    <div>
      {/* Page header */}
      <div className="mb-6 flex items-center gap-3">
        <PageHeadingMenu
          title="Budget"
          items={[
            { label: "Monthly Spending", icon: <Calendar className="h-4 w-4 text-muted-foreground" />, to: "/budgets/monthly-spending" },
          ]}
        />
        <div className="flex flex-1 items-center justify-end gap-1">
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
          <button
            onClick={() => setBudgetModalOpen(true)}
            className="ml-1 rounded-full p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Settings2 className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>

      <div className="space-y-9">

      {!hasAnyBudget && (
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

      {data && (
        <>
          <BudgetPanelSection
            title="Total"
            subtitle={`Personal + ${Math.round(data.settings.jointSplitRatio * 100)}% of Joint`}
            panel={data.total}
            pctElapsed={data.pctElapsed}
            budgetLabel="Annual Budget (derived)"
            monthlyTotals={data.monthlyTotals}
            {...sharedPanelProps}
          />

          {/* Secondary navigation */}
          <div className="flex flex-col gap-2">
            <button
              onClick={toggleBreakdown}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-ink transition-colors"
            >
              <span>{showBreakdown ? "Hide" : "Show"} Personal & Joint breakdown</span>
              <ChevronDown
                className={`h-4 w-4 transition-transform duration-200 ${showBreakdown ? "rotate-180" : ""}`}
              />
            </button>
          </div>

          {showBreakdown && (
            <div className="space-y-9">
              <BudgetPanelSection
                title="Personal"
                panel={data.personal}
                pctElapsed={data.pctElapsed}
                monthlyTotals={data.monthlyTotals.map((m) => ({ ...m, jointSpent: 0 }))}
                {...sharedPanelProps}
              />
              <div className="h-px bg-border" />
              <BudgetPanelSection
                title="Joint"
                subtitle={`your ${Math.round(data.settings.jointSplitRatio * 100)}% share`}
                panel={data.joint}
                pctElapsed={data.pctElapsed}
                monthlyTotals={data.monthlyTotals.map((m) => ({ ...m, personalSpent: 0 }))}
                {...sharedPanelProps}
              />
            </div>
          )}

          {/* Personal vs. Joint split */}
          <SplitSection personal={data.personal} joint={data.joint} />

          {/* Monthly Trend */}
          <MonthlyTrendSection
            monthlyTotals={data.monthlyTotals.map((m) =>
              year < curYear || m.month <= curMonthIdx + 1
                ? m
                : { ...m, personalSpent: 0, jointSpent: 0 }
            )}
            monthlyBudget={data.total.effectiveAnnualBudget > 0 ? data.total.effectiveAnnualBudget / 12 : null}
          />

          {/* Category Pacing */}
          {outliersData && outliersData.outliers.length > 0 && (
            <CategoryPacingTable outliers={outliersData} year={year} />
          )}

          {/* Monthly Average by Category */}
          {completedMonthCount > 0 && (
            <CategoryAvgMonthlyGrid year={year} completedMonths={completedMonthCount} />
          )}
        </>
      )}

      <BudgetSettingsSheet
        open={budgetModalOpen}
        onClose={() => setBudgetModalOpen(false)}
        personalBudget={data?.personal.annualBudget ?? null}
        jointBudget={data?.joint.annualBudget ?? null}
        jointSplitRatio={data?.settings.jointSplitRatio ?? 0.5}
        onSave={handleSaveBudgets}
      />
      </div>
    </div>
  );
}
