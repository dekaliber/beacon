import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import {
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  Landmark,
  CreditCard,
  Wallet,
} from "lucide-react";
import { Card } from "@/components/Card";
import { BeaconLoader } from "@/components/BeaconLoader";
import { PageHeadingMenu } from "@/components/PageHeadingMenu";
import { CategoryVsAverageChart } from "@/components/CategoryVsAverageChart";
import { OutlierTransactionsList } from "@/components/OutlierTransactionsList";
import { useApi } from "@/hooks/useApi";
import {
  getDashboard,
  getCategoryOutliers,
  getCategoryAverages,
  getMtdChart,
  getOutlierTransactions,
  getDataRange,
  getNetWorth,
} from "@/api";
import { formatCurrency } from "@/lib/utils";
import { formatNextUpdateTime } from "@/lib/priceUtils";
import { usePriceRefresh } from "@/hooks/usePriceRefresh";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import { useDemo } from "@/context/DemoContext";
import { SectionLabel, StatValue, DisplayStat } from "@/components/Typography";

type ChartView = "total" | "personal" | "joint";

function KpiAmount({ value, className }: { value: number; className: string }) {
  const s = formatCurrency(value);
  const i = s.indexOf('.');
  return (
    <DisplayStat as="p" className={className}>
      {i >= 0 ? <>{s.slice(0, i)}<span className="tp-kpi-cents">{s.slice(i)}</span></> : s}
    </DisplayStat>
  );
}

export function MobileDashboard() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [outlierComparison, setOutlierComparison] = useState<"mom" | "yoy">("mom");
  const [chartView, setChartView] = useState<ChartView>("total");
  const navigate = useNavigate();

  const { data, loading } = useApi(() => getDashboard(year, month), [year, month]);
  const { data: dashboardOutliers } = useApi(
    () => getCategoryOutliers(year, month, outlierComparison),
    [year, month, outlierComparison],
  );
  const { data: categoryAverages } = useApi(() => getCategoryAverages(year, month), [year, month]);
  const { data: mtdChart } = useApi(() => getMtdChart(year, month), [year, month]);
  const { data: outlierTransactions } = useApi(() => getOutlierTransactions(year, month), [year, month]);
  const { data: dataRange } = useApi(() => getDataRange(), []);
  const { data: netWorth, refetch: refetchNetWorth } = useApi(() => getNetWorth(), []);
  const { isDemoMode, demoFactor } = useDemo();

  const { phase: refreshPhase, count: refreshCount, total: refreshTotal, nextUpdateAt } =
    usePriceRefresh({ source: "Dashboard" });

  const prevRefreshPhaseRef = useRef(refreshPhase);
  useEffect(() => {
    if (prevRefreshPhaseRef.current !== "done" && refreshPhase === "done") {
      refetchNetWorth();
    }
    prevRefreshPhaseRef.current = refreshPhase;
  }, [refreshPhase, refetchNetWorth]);

  const scaledNetWorth = useMemo(() => {
    if (!netWorth) return null;
    if (!isDemoMode) return netWorth;
    const investments = netWorth.investments * demoFactor;
    const investmentCash = netWorth.investmentCash * demoFactor;
    const delta = (investments - netWorth.investments) + (investmentCash - netWorth.investmentCash);
    return { ...netWorth, investments, investmentCash, total: netWorth.total + delta };
  }, [netWorth, isDemoMode, demoFactor]);

  const chartMergedData = useMemo(() => {
    if (!mtdChart) return [];
    const series = mtdChart[chartView];
    const todayDay = mtdChart.todayDay;
    const len = Math.max(series.current.length, series.previous.length, series.priorYear.length);
    return Array.from({ length: len }, (_, i) => {
      const day = i + 1;
      const current = series.current[i]?.cumulative ?? null;
      return {
        day,
        current,
        previous: series.previous[i]?.cumulative ?? null,
        priorYear: series.priorYear[i]?.cumulative ?? null,
        currentSolid: todayDay == null || day <= todayDay ? current : null,
        currentFuture: todayDay != null && day >= todayDay ? current : null,
      };
    });
  }, [mtdChart, chartView]);

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(year - 1); }
    else setMonth(month - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(year + 1); }
    else setMonth(month + 1);
  };

  const atMin = dataRange ? year * 12 + month <= dataRange.minYear * 12 + dataRange.minMonth : false;
  const atMax = dataRange ? year * 12 + month >= dataRange.maxYear * 12 + dataRange.maxMonth : false;

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  const monthsByYear = useMemo(() => {
    if (!dataRange) return [];
    const groups = new Map<number, Array<{ month: number; label: string }>>();
    let y = dataRange.maxYear, m = dataRange.maxMonth;
    while (y > dataRange.minYear || (y === dataRange.minYear && m >= dataRange.minMonth)) {
      if (!groups.has(y)) groups.set(y, []);
      groups.get(y)!.push({
        month: m,
        label: new Date(y, m - 1).toLocaleDateString("en-US", { month: "long" }),
      });
      if (m === 1) { m = 12; y--; } else m--;
    }
    return Array.from(groups.entries()).sort(([a], [b]) => b - a);
  }, [dataRange]);

  const abbrYear = (label: string) => label.replace(/\b(\d{2})(\d{2})\b/, "'$2");

  const monthLabel = new Date(year, month - 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });


  if (loading) return <BeaconLoader />;

  if (!data) return null;

  const totalSpent = Number(data.totalSpent);
  const personalSpent = Number(data.personalSpent ?? 0);
  const jointSpent = Number(data.jointSpent ?? 0);
  const budgetAmount = data.budget ? Number(data.budget) : null;
  const personalBudget = data.personalBudget ? Number(data.personalBudget) : null;
  const jointBudget = data.jointBudget ? Number(data.jointBudget) : null;
  const budgetPct = budgetAmount ? Math.round((totalSpent / budgetAmount) * 100) : null;
  const isOverBudget = budgetPct !== null && budgetPct > 100;

  const daysInMonth = new Date(year, month, 0).getDate();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const isFutureMonth =
    year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
  const daysElapsed = isCurrentMonth ? now.getDate() : isFutureMonth ? 0 : daysInMonth;

  const budgetRemaining = budgetAmount !== null ? budgetAmount - totalSpent : null;
  const personalRemaining = personalBudget !== null ? personalBudget - personalSpent : null;
  const jointRemaining = jointBudget !== null ? jointBudget - jointSpent : null;
  const prevMonthMtd = data.prevMonthMtd ?? 0;
  const momDelta = prevMonthMtd > 0 ? totalSpent - prevMonthMtd : null;
  const momDeltaPct =
    momDelta !== null && prevMonthMtd > 0
      ? Math.round((momDelta / prevMonthMtd) * 100)
      : null;

  const yearLabel = categoryAverages
    ? categoryAverages.earliestYear === year - 1
      ? `${year - 1}`
      : `${categoryAverages.earliestYear}–${year - 1}`
    : "";

  const chartRawMax = chartMergedData.length
    ? Math.max(0, ...chartMergedData.flatMap((d) => [d.current ?? 0, d.previous ?? 0, d.priorYear ?? 0]))
    : 0;
  const chartYMax = Math.ceil((chartRawMax + 500) / 1000) * 1000 || 1000;
  const chartYIncrement =
    [500, 1000, 2000, 5000, 10000, 20000, 50000].find((i) => chartYMax / i <= 4) ?? 50000;
  const chartYTickCount = Math.round(chartYMax / chartYIncrement) + 1;

  const fmtWhole = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n);

  const showPersonalJoint = personalSpent > 0 && jointSpent > 0;

  return (
    <div>
      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <PageHeadingMenu title="Monthly Summary" items={[]} />
        <div className="mt-3 flex items-center justify-center gap-1">
          <button
            onClick={prevMonth}
            disabled={atMin}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="relative" ref={pickerRef}>
            <button
              onClick={() => setPickerOpen((o) => !o)}
              className="min-w-[7.5rem] text-center text-sm font-semibold hover:text-primary transition-colors"
            >
              {monthLabel}
            </button>
            {pickerOpen && (
              <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-[60] max-h-72 overflow-y-auto rounded-lg border border-border bg-background shadow-lg py-1 min-w-[7.5rem]">
                {monthsByYear.map(([yr, months]) => (
                  <div key={yr}>
                    <div className="px-3 pt-2 pb-1.5 text-xs font-semibold text-muted-foreground">{yr}</div>
                    {months.map((opt) => {
                      const isSelected = opt.month === month && yr === year;
                      return (
                        <button
                          key={opt.month}
                          onClick={() => { setYear(yr); setMonth(opt.month); setPickerOpen(false); }}
                          className={`w-full text-left px-4 py-1 text-sm transition-colors ${isSelected ? "bg-accent font-medium" : "hover:bg-muted"}`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={nextMonth}
            disabled={atMax}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="space-y-4">

        {/* ── Net Worth ──────────────────────────────────────────────────────── */}
        {scaledNetWorth && (
          <Card>
            <SectionLabel>Net Worth</SectionLabel>
            <KpiAmount value={scaledNetWorth.total} className="mt-0.5 tp-kpi-l" />
            <p className="tp-fineprint mt-1">
              {refreshPhase === "running"
                ? refreshTotal > 0
                  ? `Fetching latest prices… ${refreshCount} of ${refreshTotal} securities`
                  : "Fetching latest prices…"
                : nextUpdateAt
                  ? `Next update: ${formatNextUpdateTime(nextUpdateAt)}`
                  : null}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3">
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                  <SectionLabel>Investments</SectionLabel>
                </div>
                <StatValue as="p" className="text-sm font-semibold">{formatCurrency(scaledNetWorth.investments)}</StatValue>
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                  <SectionLabel>Inv. Cash</SectionLabel>
                </div>
                <StatValue as="p" className="text-sm font-semibold">{formatCurrency(scaledNetWorth.investmentCash)}</StatValue>
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
                  <SectionLabel>Banking Cash</SectionLabel>
                </div>
                <StatValue as="p" className="text-sm font-semibold">{formatCurrency(scaledNetWorth.bankingCash)}</StatValue>
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                  <SectionLabel>Credit Cards</SectionLabel>
                </div>
                <StatValue as="p" className="text-sm font-semibold text-down">−{formatCurrency(scaledNetWorth.creditCardDebt)}</StatValue>
              </div>
            </div>
          </Card>
        )}

        {/* ── MTD Spend ─────────────────────────────────────────────────────── */}
        <Card>
          <div>
            <p className="tp-eyebrow">MTD Spend</p>
            <DisplayStat as="p" className="tp-kpi-l">{fmtWhole(totalSpent)}</DisplayStat>
            {budgetAmount !== null ? (
              <p className="mt-0.5 tp-fineprint">of {fmtWhole(budgetAmount)} budget</p>
            ) : (
              <button
                onClick={() => navigate("/budgets")}
                className="mt-0.5 text-xs text-primary hover:underline"
              >
                Set a budget
              </button>
            )}
          </div>

          {/* Personal / Joint rows */}
          {showPersonalJoint && totalSpent > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-border pt-3">
              <div className="flex items-center justify-between text-sm font-mono">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PERSONAL_COLOR }} />
                  Personal
                </span>
                <StatValue className="font-medium">{fmtWhole(personalSpent)}</StatValue>
              </div>
              <div className="flex items-center justify-between text-sm font-mono">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: JOINT_COLOR }} />
                  Joint
                </span>
                <StatValue className="font-medium">{fmtWhole(jointSpent)}</StatValue>
              </div>
            </div>
          )}

          {/* MoM comparison */}
          {momDeltaPct !== null && (() => {
            const prevMonthNum = month === 1 ? 12 : month - 1;
            const prevMonthYear = month === 1 ? year - 1 : year;
            const prevMonthName = new Date(prevMonthYear, prevMonthNum - 1, 1).toLocaleDateString("en-US", { month: "short" });
            return (
              <div className="mt-3 border-t border-border pt-3">
                <p className="tp-fineprint">vs last month</p>
                <p className="mt-0.5 tp-fineprint">
                  <span className="font-medium text-foreground font-mono">{fmtWhole(prevMonthMtd)}</span>
                  {" in "}{prevMonthName}{isCurrentMonth ? ` 1–${daysElapsed}` : ""}
                </p>
                <p className="mt-0.5 text-xs font-medium">
                  <span className={`font-mono ${momDelta! > 0 ? "text-down" : "text-up"}`}>
                    {momDelta! > 0 ? "+" : "–"}{fmtWhole(Math.abs(momDelta!))}
                  </span>{" "}
                  <span className="tp-fineprint">
                    ({momDelta! > 0 ? "↑" : "↓"}{Math.abs(momDeltaPct)}%)
                  </span>
                </p>
              </div>
            );
          })()}
        </Card>

        {/* ── Budget Used ───────────────────────────────────────────────────── */}
        <Card>
          <div className="flex items-start gap-3">
            <svg
              className={`mt-0.5 h-9 w-9 shrink-0 ${isOverBudget ? "text-down" : "text-up"}`}
              viewBox="0 0 36 36"
            >
              <rect x="0" y="0" width="36" height="36" rx="8" fill="currentColor" fillOpacity="0.1" />
              <circle
                cx="18" cy="18" r="11"
                fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="5"
                transform="rotate(-90 18 18)"
              />
              {budgetPct !== null && (
                <circle
                  cx="18" cy="18" r="11"
                  fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"
                  transform="rotate(-90 18 18)"
                  strokeDasharray={`${(Math.min(budgetPct, 100) / 100) * 2 * Math.PI * 11} ${2 * Math.PI * 11}`}
                />
              )}
            </svg>
            <div className="min-w-0 flex-1">
              <p className="tp-eyebrow">Budget Used</p>
              {budgetPct !== null ? (
                <DisplayStat as="p" className={`tp-kpi-l ${isOverBudget ? "text-down" : ""}`}>{budgetPct}%</DisplayStat>
              ) : (
                <p className="text-sm text-muted-foreground">No budget set</p>
              )}
              {budgetRemaining !== null && (
                <p className={`mt-0.5 text-xs font-mono ${budgetRemaining < 0 ? "text-down" : "text-muted-foreground"}`}>
                  <span className={`font-medium font-mono ${budgetRemaining < 0 ? "text-down" : "text-foreground"}`}>
                    {fmtWhole(Math.abs(budgetRemaining))}
                  </span>{" "}
                  {budgetRemaining < 0 ? "over budget" : "remaining"}
                </p>
              )}
            </div>
          </div>

          {(personalBudget !== null || jointBudget !== null) && (
            <div className="mt-3 space-y-2.5 border-t border-border pt-3">
              {personalBudget !== null && (() => {
                const pct = Math.min(Math.round((personalSpent / personalBudget) * 100), 100);
                const over = personalSpent > personalBudget;
                return (
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs font-mono">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PERSONAL_COLOR }} />
                        Personal
                      </span>
                      <span className="text-muted-foreground">
                        <span className={`font-medium font-mono ${over ? "text-down" : "text-foreground"}`}>{fmtWhole(personalSpent)}</span>
                        {" / "}{fmtWhole(personalBudget)}
                        {personalRemaining !== null && (
                          <span className={over ? " text-down" : ""}>
                            {" "}({over ? "+" : "−"}{fmtWhole(Math.abs(personalRemaining!))})
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: over ? "var(--color-down)" : "var(--color-up)",
                        }}
                      />
                    </div>
                  </div>
                );
              })()}
              {jointBudget !== null && (() => {
                const pct = Math.min(Math.round((jointSpent / jointBudget) * 100), 100);
                const over = jointSpent > jointBudget;
                return (
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs font-mono">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: JOINT_COLOR }} />
                        Joint
                      </span>
                      <span className="text-muted-foreground">
                        <span className={`font-medium font-mono ${over ? "text-down" : "text-foreground"}`}>{fmtWhole(jointSpent)}</span>
                        {" / "}{fmtWhole(jointBudget)}
                        {jointRemaining !== null && (
                          <span className={over ? " text-down" : ""}>
                            {" "}({over ? "+" : "−"}{fmtWhole(Math.abs(jointRemaining!))})
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: over ? "var(--color-down)" : "var(--color-up)",
                        }}
                      />
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </Card>

        {/* ── Monthly Pace ──────────────────────────────────────────────────── */}
        <Card>
          <div className="mb-3 flex items-start justify-between gap-2">
            <p className="tp-eyebrow">Monthly Pace</p>
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-secondary p-0.5 text-xs font-medium">
              {(["total", "personal", "joint"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setChartView(v)}
                  className={`rounded-md px-2 py-1 capitalize transition-colors ${
                    chartView === v
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {mtdChart ? (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={chartMergedData} margin={{ top: 5, right: 4, bottom: 0, left: 2 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                    tickLine={false}
                    interval={4}
                  />
                  <YAxis
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                    tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    width={34}
                    domain={[0, chartYMax]}
                    tickCount={chartYTickCount}
                    interval={0}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const labels: Record<string, string> = {
                        currentSolid: mtdChart.monthNames.current,
                        currentFuture: mtdChart.monthNames.current,
                        previous: mtdChart.monthNames.previous,
                        priorYear: mtdChart.monthNames.priorYear,
                      };
                      const items = payload.filter((p) => p.dataKey !== "currentFuture");
                      return (
                        <div className="rounded border border-border bg-background p-2 text-xs shadow-md">
                          <p className="mb-1.5 font-medium">Day {label}</p>
                          {items.map((p) => (
                            <p key={p.dataKey as string} className="mt-1" style={{ color: p.stroke as string }}>
                              {labels[p.dataKey as string] ?? p.dataKey}: {formatCurrency(p.value as number)}
                            </p>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Line type="monotone" dataKey="currentSolid" stroke="var(--color-primary)" strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="currentFuture" stroke="var(--color-primary)" strokeWidth={2} dot={false} connectNulls strokeDasharray="6 3" />
                  <Line type="monotone" dataKey="previous" stroke="var(--color-muted-foreground)" strokeWidth={1.5} dot={false} connectNulls strokeOpacity={0.6} />
                  <Line type="monotone" dataKey="priorYear" stroke="var(--color-primary)" strokeWidth={1.5} dot={false} connectNulls strokeOpacity={0.3} />
                  <ReferenceLine y={0} stroke="var(--color-border)" />
                  {mtdChart.monthlyBudget[chartView] > 0 && (
                    <ReferenceLine
                      y={mtdChart.monthlyBudget[chartView]}
                      stroke="var(--color-down)"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      strokeOpacity={0.5}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
              <div className="mt-2 flex flex-wrap justify-center gap-3 tp-fineprint">
                <span className="flex items-center gap-1">
                  <svg width="20" height="8">
                    <line x1="0" y1="4" x2="10" y2="4" stroke="var(--color-primary)" strokeWidth="2" />
                    <line x1="10" y1="4" x2="20" y2="4" stroke="var(--color-primary)" strokeWidth="2" strokeDasharray="3 2" />
                  </svg>
                  {mtdChart.monthNames.current}
                </span>
                <span className="flex items-center gap-1">
                  <svg width="16" height="8">
                    <line x1="0" y1="4" x2="16" y2="4" stroke="var(--color-muted-foreground)" strokeWidth="1.5" strokeOpacity="0.6" />
                  </svg>
                  {mtdChart.monthNames.previous}
                </span>
                <span className="flex items-center gap-1">
                  <svg width="16" height="8">
                    <line x1="0" y1="4" x2="16" y2="4" stroke="var(--color-primary)" strokeWidth="1.5" strokeOpacity="0.3" />
                  </svg>
                  {mtdChart.monthNames.priorYear}
                </span>
              </div>
            </>
          ) : (
            <div className="flex h-[172px] items-center justify-center tp-caption">
              Loading…
            </div>
          )}
        </Card>

        {/* ── Spending vs. Category Averages ────────────────────────────────── */}
        <Card>
          {categoryAverages && categoryAverages.categories.length === 0 ? (
            <div className="flex min-h-[120px] items-center justify-center tp-caption">
              Not enough history to compute averages
            </div>
          ) : categoryAverages ? (
            <CategoryVsAverageChart
              categories={categoryAverages.categories}
              yearLabel={yearLabel}
              compact
            />
          ) : (
            <div className="flex min-h-[120px] items-center justify-center tp-caption">
              Loading…
            </div>
          )}
        </Card>

        {/* ── Spending Outliers ─────────────────────────────────────────────── */}
        {(!categoryAverages || categoryAverages.categories.length > 0) && (
          <Card>
            {outlierTransactions ? (
              <OutlierTransactionsList categories={outlierTransactions.categories} />
            ) : (
              <div className="flex min-h-[80px] items-center justify-center tp-caption">
                Loading…
              </div>
            )}
          </Card>
        )}

        {/* ── Largest Changes by Category ───────────────────────────────────── */}
        {dashboardOutliers && dashboardOutliers.outliers.length > 0 && (
          <Card>
            {/* Header */}
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="tp-panel-title">Largest Changes</p>
                <p className="tp-fineprint">
                  vs {dashboardOutliers.previousMonthLabel} · {dashboardOutliers.comparisonNote}
                </p>
              </div>
              <div className="flex items-center gap-0.5 rounded-lg bg-secondary p-0.5 text-xs font-medium">
                <button
                  onClick={() => setOutlierComparison("mom")}
                  className={`rounded-md px-2.5 py-1 transition-colors ${
                    outlierComparison === "mom"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  MoM
                </button>
                <button
                  onClick={() => setOutlierComparison("yoy")}
                  className={`rounded-md px-2.5 py-1 transition-colors ${
                    outlierComparison === "yoy"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  YoY
                </button>
              </div>
            </div>

            {/* Table */}
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="pb-1.5 text-left font-medium">Category</th>
                  <th className="pb-1.5 text-right font-medium">{abbrYear(dashboardOutliers.currentMonthLabel)}</th>
                  <th className="pb-1.5 text-right font-medium">{abbrYear(dashboardOutliers.previousMonthLabel)}</th>
                  <th className="pb-1.5 text-right font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {dashboardOutliers.outliers.map((o, i) => {
                  const increase = o.delta > 0;
                  const deltaColor = increase ? "text-down" : "text-up";
                  const deltaSign = increase ? "+" : "−";
                  return (
                    <tr
                      key={o.categoryId ?? `__cat${i}__`}
                      className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-muted" : ""}`}
                    >
                      <td className="py-1.5 text-muted-foreground">{o.categoryName}</td>
                      <td className="py-1.5 text-right tabular-nums font-mono">{fmtWhole(o.currentAmount)}</td>
                      <td className="py-1.5 text-right tabular-nums font-mono text-muted-foreground">{fmtWhole(o.previousAmount)}</td>
                      <td className={`py-1.5 text-right tabular-nums font-mono font-semibold ${deltaColor}`}>
                        {deltaSign}{fmtWhole(Math.abs(o.delta))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}

      </div>
    </div>
  );
}
