import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Cell, ResponsiveContainer,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  PieChart, Pie, LineChart, Line,
} from "recharts";
import { ChevronLeft, ChevronRight, TrendingUp, Landmark, CreditCard, Wallet } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { CategoryOutliersChart } from "@/components/CategoryOutliersChart";
import { CategoryVsAverageChart } from "@/components/CategoryVsAverageChart";
import { OutlierTransactionsList } from "@/components/OutlierTransactionsList";
import { useApi } from "@/hooks/useApi";
import { getDashboard, getCategoryOutliers, getCategoryAverages, getMtdChart, getOutlierTransactions, getDataRange, getNetWorth } from "@/api";
import { formatCurrency } from "@/lib/utils";
import { formatNextUpdateTime } from "@/lib/priceUtils";
import { usePriceRefresh } from "@/hooks/usePriceRefresh";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import { useDemo } from "@/context/DemoContext";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel, StatValue, DisplayStat, Caption } from "@/components/Typography";

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

export function Dashboard() {
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
  const { data: categoryAverages }   = useApi(() => getCategoryAverages(year, month),    [year, month]);
  const { data: mtdChart }           = useApi(() => getMtdChart(year, month),            [year, month]);
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
        previous:      series.previous[i]?.cumulative  ?? null,
        priorYear:     series.priorYear[i]?.cumulative ?? null,
        currentSolid:  todayDay == null || day <= todayDay ? current : null,
        currentFuture: todayDay != null  && day >= todayDay ? current : null,
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inputType = (target as HTMLInputElement).type;
      const isTextInput = (target.tagName === "INPUT" && inputType !== "checkbox" && inputType !== "radio")
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
        || target.isContentEditable;
      if (isTextInput) return;
      if (e.key === "ArrowLeft")  { if (!atMin) prevMonth(); }
      else if (e.key === "ArrowRight") { if (!atMax) nextMonth(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [atMin, atMax, month, year]);

  const monthLabel = new Date(year, month - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  if (loading) return <BeaconLoader />;

  if (!data) return null;

  const totalSpent    = Number(data.totalSpent);
  const personalSpent = Number(data.personalSpent ?? 0);
  const jointSpent    = Number(data.jointSpent    ?? 0);
  const budgetAmount  = data.budget         ? Number(data.budget)         : null;
  const personalBudget = data.personalBudget ? Number(data.personalBudget) : null;
  const jointBudget   = data.jointBudget    ? Number(data.jointBudget)    : null;
  const budgetPct     = budgetAmount ? Math.round((totalSpent / budgetAmount) * 100) : null;
  const isOverBudget  = budgetPct !== null && budgetPct > 100;

  const daysInMonth     = new Date(year, month, 0).getDate();
  const isCurrentMonth  = year === now.getFullYear() && month === now.getMonth() + 1;
  const isFutureMonth   = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
  const daysElapsed     = isCurrentMonth ? now.getDate() : isFutureMonth ? 0 : daysInMonth;

  const budgetRemaining    = budgetAmount !== null ? budgetAmount - totalSpent : null;
  const personalRemaining  = personalBudget !== null ? personalBudget - personalSpent : null;
  const jointRemaining     = jointBudget    !== null ? jointBudget    - jointSpent    : null;
  const prevMonthMtd       = data.prevMonthMtd ?? 0;
  const momDelta           = prevMonthMtd > 0 ? totalSpent - prevMonthMtd : null;
  const momDeltaPct        = momDelta !== null && prevMonthMtd > 0 ? Math.round((momDelta / prevMonthMtd) * 100) : null;
  const yearLabel = categoryAverages
    ? categoryAverages.earliestYear === year - 1
      ? `${year - 1}`
      : `${categoryAverages.earliestYear}–${year - 1}`
    : "";

  const chartRawMax = chartMergedData.length
    ? Math.max(0, ...chartMergedData.flatMap((d) => [d.current ?? 0, d.previous ?? 0, d.priorYear ?? 0]))
    : 0;
  const chartYMax       = Math.ceil((chartRawMax + 500) / 1000) * 1000 || 1000;
  const chartYIncrement = [500, 1000, 2000, 5000, 10000, 20000, 50000].find((i) => chartYMax / i <= 4) ?? 50000;
  const chartYTickCount = Math.round(chartYMax / chartYIncrement) + 1;

  const fmtWhole = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  const showPersonalJoint = personalSpent > 0 && jointSpent > 0;

  return (
    <div className="space-y-6">

      {/* ── Net Worth ──────────────────────────────────────────────────────── */}
      {scaledNetWorth && (
        <Card>
          <div className="grid grid-cols-6 gap-x-6 gap-y-3 items-center">
            {/* Headline — spans 2 cols */}
            <div className="col-span-6 sm:col-span-2 sm:border-r sm:border-border sm:pr-6">
              <SectionLabel>Net Worth</SectionLabel>
              <KpiAmount value={scaledNetWorth.total} className="tp-kpi" />
              <Caption className="mt-1">
                {refreshPhase === "running"
                  ? refreshTotal > 0
                    ? `Fetching latest prices… ${refreshCount} of ${refreshTotal} securities`
                    : "Fetching latest prices…"
                  : nextUpdateAt
                    ? `Next update: ${formatNextUpdateTime(nextUpdateAt)}`
                    : null}
              </Caption>
            </div>

            {/* Investments */}
            <div className="col-span-3 sm:col-span-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                <SectionLabel>Investments</SectionLabel>
              </div>
              <DisplayStat as="p" className="tp-stat">{formatCurrency(scaledNetWorth.investments)}</DisplayStat>
            </div>

            {/* Investment Cash */}
            <div className="col-span-3 sm:col-span-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                <SectionLabel>Inv. Cash</SectionLabel>
              </div>
              <DisplayStat as="p" className="tp-stat">{formatCurrency(scaledNetWorth.investmentCash)}</DisplayStat>
            </div>

            {/* Banking Cash */}
            <div className="col-span-3 sm:col-span-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
                <SectionLabel>Banking Cash</SectionLabel>
              </div>
              <DisplayStat as="p" className="tp-stat">{formatCurrency(scaledNetWorth.bankingCash)}</DisplayStat>
            </div>

            {/* Credit Cards */}
            <div className="col-span-3 sm:col-span-1">
              <div className="flex items-center gap-1.5 mb-0.5">
                <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                <SectionLabel>Credit Cards</SectionLabel>
              </div>
              <DisplayStat as="p" className="tp-stat text-down">−{formatCurrency(scaledNetWorth.creditCardDebt)}</DisplayStat>
            </div>
          </div>
        </Card>
      )}

      {/* Month selector */}
      <div className="flex items-start justify-between">
        <h2 className="tp-page-title">Monthly Summary</h2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={prevMonth} disabled={atMin}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[8rem] text-center font-display font-semibold text-17 text-ink">{monthLabel}</span>
          <Button variant="ghost" size="sm" onClick={nextMonth} disabled={atMax}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── Summary cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">

        {/* Card 1: MTD Spend with Personal/Joint pie and MoM comparison */}
        <Card>
          <div className="flex gap-4">
            {/* Left half */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div>
                <SectionLabel>MTD Spend</SectionLabel>
                <DisplayStat as="p" className="tp-kpi-l">{fmtWhole(totalSpent)}</DisplayStat>
                {budgetAmount !== null ? (
                  <Caption className="mt-0.5">of {fmtWhole(budgetAmount)} budget</Caption>
                ) : (
                  <button onClick={() => navigate("/budgets")} className="mt-0.5 text-xs text-primary hover:underline">
                    Set a budget
                  </button>
                )}
              </div>

              {/* MoM comparison */}
              {momDeltaPct !== null && (() => {
                const prevMonthNum = month === 1 ? 12 : month - 1;
                const prevMonthYear = month === 1 ? year - 1 : year;
                const prevMonthName = new Date(prevMonthYear, prevMonthNum - 1, 1).toLocaleDateString("en-US", { month: "short" });
                return (
                  <div className="mt-3 border-t border-border pt-3">
                    <Caption>vs last month</Caption>
                    <Caption className="mt-0.5">
                      <StatValue className="font-medium text-foreground">{fmtWhole(prevMonthMtd)}</StatValue>
                      {" in "}{prevMonthName}{isCurrentMonth ? ` 1–${daysElapsed}` : ""}
                    </Caption>
                    <p className="mt-0.5 text-xs font-medium">
                      <StatValue className={momDelta! > 0 ? "text-down" : "text-up"}>
                        {momDelta! > 0 ? "+" : "–"}{fmtWhole(Math.abs(momDelta!))}
                      </StatValue>{" "}
                      <Caption as="span">
                        ({momDelta! > 0 ? "↑" : "↓"}{Math.abs(momDeltaPct)}%)
                      </Caption>
                    </p>
                  </div>
                );
              })()}
            </div>

            {/* Right half: pie + legend */}
            {showPersonalJoint && totalSpent > 0 && (
              <div className="flex w-1/2 shrink-0 flex-col items-center justify-center border-l border-border pl-4">
                <PieChart width={96} height={96}>
                  <Pie
                    data={[
                      { name: "Personal", value: personalSpent },
                      { name: "Joint", value: jointSpent },
                    ]}
                    dataKey="value"
                    cx="50%"
                    cy="50%"
                    outerRadius={46}
                    startAngle={90}
                    endAngle={450}
                    strokeWidth={0}
                  >
                    <Cell fill={PERSONAL_COLOR} />
                    <Cell fill={JOINT_COLOR} />
                  </Pie>
                </PieChart>
                <div className="mt-2 space-y-1">
                  <div className="flex items-center gap-1.5 tp-fineprint">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PERSONAL_COLOR }} />
                    <span>Personal <StatValue className="font-medium text-ink">{fmtWhole(personalSpent)}</StatValue></span>
                  </div>
                  <div className="flex items-center gap-1.5 tp-fineprint">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: JOINT_COLOR }} />
                    <span>Joint <StatValue className="font-medium text-ink">{fmtWhole(jointSpent)}</StatValue></span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Card 2: Budget used % + remaining + Personal/Joint breakdown */}
        <Card>
          <div className="flex items-start gap-3">
            <svg className={`mt-0.5 h-9 w-9 shrink-0 ${isOverBudget ? "text-down" : "text-up"}`} viewBox="0 0 36 36">
              <rect x="0" y="0" width="36" height="36" rx="8" fill="currentColor" fillOpacity="0.1" />
              <circle cx="18" cy="18" r="11" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="5"
                transform="rotate(-90 18 18)" />
              {budgetPct !== null && (
                <circle cx="18" cy="18" r="11" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"
                  transform="rotate(-90 18 18)"
                  strokeDasharray={`${(Math.min(budgetPct, 100) / 100) * 2 * Math.PI * 11} ${2 * Math.PI * 11}`} />
              )}
            </svg>
            <div className="min-w-0 flex-1">
              <SectionLabel>Budget Used</SectionLabel>
              {budgetPct !== null ? (
                <DisplayStat as="p" className={`tp-kpi-l ${isOverBudget ? "text-down" : ""}`}>{budgetPct}%</DisplayStat>
              ) : (
                <p className="tp-caption">No budget set</p>
              )}
              {budgetRemaining !== null && (
                <Caption className={`mt-0.5 ${budgetRemaining < 0 ? "text-down" : ""}`}>
                  <StatValue className={`font-medium ${budgetRemaining < 0 ? "text-down" : "text-foreground"}`}>
                    {fmtWhole(Math.abs(budgetRemaining))}
                  </StatValue>
                  {" "}{budgetRemaining < 0 ? "over budget" : "remaining"}
                </Caption>
              )}
            </div>
          </div>

          {/* Personal + Joint budget progress rows */}
          {(personalBudget !== null || jointBudget !== null) && (
            <div className="mt-3 space-y-2.5 border-t border-border pt-3">
              {personalBudget !== null && (() => {
                const pct = Math.min(Math.round((personalSpent / personalBudget) * 100), 100);
                const over = personalSpent > personalBudget;
                return (
                  <div>
                    <div className="mb-1 flex items-center justify-between tp-fineprint">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PERSONAL_COLOR }} />
                        Personal
                      </span>
                      <span>
                        <StatValue className={`font-medium ${over ? "text-down" : "text-ink"}`}>{fmtWhole(personalSpent)}</StatValue>
                        {" / "}{fmtWhole(personalBudget)}
                        {personalRemaining !== null && (
                          <span className={over ? " text-down" : ""}>{" "}({over ? "+" : "−"}{fmtWhole(Math.abs(personalRemaining!))})</span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: over ? "var(--color-down)" : "var(--color-up)" }} />
                    </div>
                  </div>
                );
              })()}
              {jointBudget !== null && (() => {
                const pct = Math.min(Math.round((jointSpent / jointBudget) * 100), 100);
                const over = jointSpent > jointBudget;
                return (
                  <div>
                    <div className="mb-1 flex items-center justify-between tp-fineprint">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: JOINT_COLOR }} />
                        Joint
                      </span>
                      <span>
                        <StatValue className={`font-medium ${over ? "text-down" : "text-ink"}`}>{fmtWhole(jointSpent)}</StatValue>
                        {" / "}{fmtWhole(jointBudget)}
                        {jointRemaining !== null && (
                          <span className={over ? " text-down" : ""}>{" "}({over ? "+" : "−"}{fmtWhole(Math.abs(jointRemaining!))})</span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: over ? "var(--color-down)" : "var(--color-up)" }} />
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </Card>

        {/* Card 3: MTD spending chart with Total/Personal/Joint toggle */}
        <Card>
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <SectionLabel>Monthly Pace</SectionLabel>
            </div>
            <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5 text-xs font-medium">
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
              <ResponsiveContainer width="100%" height={112}>
                <LineChart data={chartMergedData} margin={{ top: 5, right: 4, bottom: 0, left: 2 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: "var(--color-muted-foreground)", style: { fontFamily: "var(--font-mono)" } }}
                    tickLine={false}
                    interval={4}
                  />
                  <YAxis
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                    tick={{ fontSize: 10, fill: "var(--color-muted-foreground)", style: { fontFamily: "var(--font-mono)" } }}
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
                        currentSolid:  mtdChart.monthNames.current,
                        currentFuture: mtdChart.monthNames.current,
                        previous:      mtdChart.monthNames.previous,
                        priorYear:     mtdChart.monthNames.priorYear,
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
                  <Line type="monotone" dataKey="currentSolid"  stroke="var(--color-primary)" strokeWidth={2}   dot={false} connectNulls />
                  <Line type="monotone" dataKey="currentFuture" stroke="var(--color-primary)" strokeWidth={2}   dot={false} connectNulls strokeDasharray="6 3" />
                  <Line type="monotone" dataKey="previous"      stroke="var(--color-muted-foreground)" strokeWidth={1.5} dot={false} connectNulls strokeOpacity={0.6} />
                  <Line type="monotone" dataKey="priorYear"     stroke="var(--color-primary)" strokeWidth={1.5} dot={false} connectNulls strokeOpacity={0.3} />
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
              <div className="mt-1.5 flex flex-wrap justify-center gap-3 tp-fineprint">
                <span className="flex items-center gap-1">
                  <svg width="20" height="8">
                    <line x1="0" y1="4" x2="10" y2="4" stroke="var(--color-primary)" strokeWidth="2" />
                    <line x1="10" y1="4" x2="20" y2="4" stroke="var(--color-primary)" strokeWidth="2" strokeDasharray="3 2" />
                  </svg>
                  {mtdChart.monthNames.current}
                </span>
                <span className="flex items-center gap-1">
                  <svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="var(--color-muted-foreground)" strokeWidth="1.5" strokeOpacity="0.6" /></svg>
                  {mtdChart.monthNames.previous}
                </span>
                <span className="flex items-center gap-1">
                  <svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="var(--color-primary)" strokeWidth="1.5" strokeOpacity="0.3" /></svg>
                  {mtdChart.monthNames.priorYear}
                </span>
              </div>
            </>
          ) : (
            <div className="flex h-[148px] items-center justify-center tp-caption">
              Loading…
            </div>
          )}
        </Card>
      </div>

      {/* ── Spending vs. Category Averages + Spending Outliers — combined ──── */}
      <Card>
        {categoryAverages && categoryAverages.categories.length === 0 ? (
          <div className="flex min-h-[120px] items-center justify-center tp-caption">
            Not enough history to compute averages
          </div>
        ) : (
          <div className="grid grid-cols-1 divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
            <div className="lg:pr-6">
              {categoryAverages ? (
                <CategoryVsAverageChart categories={categoryAverages.categories} yearLabel={yearLabel} compact />
              ) : (
                <div className="flex h-full min-h-[120px] items-center justify-center tp-caption">
                  Loading…
                </div>
              )}
            </div>
            <div className="pt-6 lg:pl-6 lg:pt-0">
              {outlierTransactions ? (
                <OutlierTransactionsList categories={outlierTransactions.categories} />
              ) : (
                <div className="flex min-h-[80px] items-center justify-center tp-caption">
                  Loading…
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ── Largest Changes by Category — full width ───────────────────────── */}
      <Card>
        {dashboardOutliers && (
          <CategoryOutliersChart
            data={dashboardOutliers}
            compact
            header={
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <h3 className="tp-card-title">Largest Changes by Category</h3>
                  <p className="mt-0.5 tp-caption">
                    Top 10 subcategory changes vs {dashboardOutliers.previousMonthLabel} · {dashboardOutliers.comparisonNote}
                  </p>
                </div>
                <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-xs font-medium">
                  <button
                    onClick={() => setOutlierComparison("mom")}
                    className={`rounded-md px-2.5 py-1 transition-colors ${outlierComparison === "mom" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    MoM
                  </button>
                  <button
                    onClick={() => setOutlierComparison("yoy")}
                    className={`rounded-md px-2.5 py-1 transition-colors ${outlierComparison === "yoy" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    YoY
                  </button>
                </div>
              </div>
            }
          />
        )}
      </Card>

    </div>
  );
}
