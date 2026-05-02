import { useState, useMemo } from "react";
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
  Receipt,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  Landmark,
  CreditCard,
  Wallet,
} from "lucide-react";
import { Card } from "@/components/Card";
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
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";

type ChartView = "total" | "personal" | "joint";

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
  const { data: netWorth } = useApi(() => getNetWorth(), []);

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

  const abbrYear = (label: string) => label.replace(/\b(\d{2})(\d{2})\b/, "'$2");

  const monthLabel = new Date(year, month - 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });


  if (loading) {
    return (
      <div>
        <div className="mb-6 flex items-center gap-3">
          <PageHeadingMenu title="Dashboard" items={[]} />
        </div>
        <div className="py-12 text-center text-muted-foreground">Loading…</div>
      </div>
    );
  }

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
      <div className="mb-6 flex items-center gap-3">
        <PageHeadingMenu title="Dashboard" items={[]} />
        <div className="flex flex-1 items-center justify-end gap-1">
          <button
            onClick={prevMonth}
            disabled={atMin}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[7.5rem] text-center text-sm font-semibold">{monthLabel}</span>
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
        {netWorth && (
          <Card>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Net Worth</p>
            <p className="mt-0.5 text-3xl font-bold tabular-nums">{formatCurrency(netWorth.total)}</p>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3">
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Investments</p>
                </div>
                <p className="text-sm font-semibold tabular-nums">{formatCurrency(netWorth.investments)}</p>
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Inv. Cash</p>
                </div>
                <p className="text-sm font-semibold tabular-nums">{formatCurrency(netWorth.investmentCash)}</p>
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Banking Cash</p>
                </div>
                <p className="text-sm font-semibold tabular-nums">{formatCurrency(netWorth.bankingCash)}</p>
              </div>
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Credit Cards</p>
                </div>
                <p className="text-sm font-semibold tabular-nums text-destructive">−{formatCurrency(netWorth.creditCardDebt)}</p>
              </div>
            </div>
          </Card>
        )}

        {/* ── MTD Spend ─────────────────────────────────────────────────────── */}
        <Card>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2 shrink-0">
              <Receipt className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-muted-foreground">MTD Spend</p>
              <p className="text-2xl font-bold">{fmtWhole(totalSpent)}</p>
              {budgetAmount !== null ? (
                <p className="mt-0.5 text-xs text-muted-foreground">of {fmtWhole(budgetAmount)} budget</p>
              ) : (
                <button
                  onClick={() => navigate("/budgets")}
                  className="mt-0.5 text-xs text-primary hover:underline"
                >
                  Set a budget
                </button>
              )}
            </div>
          </div>

          {/* Personal / Joint rows */}
          {showPersonalJoint && totalSpent > 0 && (
            <div className="mt-3 space-y-1.5 border-t border-border pt-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PERSONAL_COLOR }} />
                  Personal
                </span>
                <span className="font-medium tabular-nums">{fmtWhole(personalSpent)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: JOINT_COLOR }} />
                  Joint
                </span>
                <span className="font-medium tabular-nums">{fmtWhole(jointSpent)}</span>
              </div>
            </div>
          )}

          {/* MoM comparison */}
          {momDeltaPct !== null && (
            <div className="mt-3 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                vs last month (day 1–{daysElapsed > 0 ? daysElapsed : daysInMonth})
              </p>
              <p className="mt-0.5 text-sm font-medium">
                {fmtWhole(prevMonthMtd)}{" "}
                <span className={momDelta! > 0 ? "text-destructive" : "text-success"}>
                  {momDelta! > 0 ? "↑" : "↓"}{Math.abs(momDeltaPct)}%
                </span>
              </p>
            </div>
          )}
        </Card>

        {/* ── Budget Used ───────────────────────────────────────────────────── */}
        <Card>
          <div className="flex items-start gap-3">
            <svg
              className={`mt-0.5 h-9 w-9 shrink-0 ${isOverBudget ? "text-destructive" : "text-success"}`}
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
              <p className="text-sm text-muted-foreground">Budget Used</p>
              {budgetPct !== null ? (
                <p className={`text-2xl font-bold ${isOverBudget ? "text-destructive" : ""}`}>{budgetPct}%</p>
              ) : (
                <p className="text-sm text-muted-foreground">No budget set</p>
              )}
              {budgetRemaining !== null && (
                <p className={`mt-0.5 text-xs ${budgetRemaining < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                  <span className={`font-medium ${budgetRemaining < 0 ? "text-destructive" : "text-foreground"}`}>
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
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PERSONAL_COLOR }} />
                        Personal
                      </span>
                      <span className="text-muted-foreground">
                        <span className={`font-medium ${over ? "text-destructive" : "text-foreground"}`}>{fmtWhole(personalSpent)}</span>
                        {" / "}{fmtWhole(personalBudget)}
                        {personalRemaining !== null && (
                          <span className={over ? " text-destructive" : ""}>
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
                          backgroundColor: over ? "var(--color-destructive)" : "var(--color-success)",
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
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: JOINT_COLOR }} />
                        Joint
                      </span>
                      <span className="text-muted-foreground">
                        <span className={`font-medium ${over ? "text-destructive" : "text-foreground"}`}>{fmtWhole(jointSpent)}</span>
                        {" / "}{fmtWhole(jointBudget)}
                        {jointRemaining !== null && (
                          <span className={over ? " text-destructive" : ""}>
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
                          backgroundColor: over ? "var(--color-destructive)" : "var(--color-success)",
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
            <p className="text-sm text-muted-foreground">Monthly Pace</p>
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
                      stroke="var(--color-destructive)"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                      strokeOpacity={0.5}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
              <div className="mt-2 flex flex-wrap justify-center gap-3 text-xs text-muted-foreground">
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
            <div className="flex h-[172px] items-center justify-center text-xs text-muted-foreground">
              Loading…
            </div>
          )}
        </Card>

        {/* ── Largest Changes by Category ───────────────────────────────────── */}
        {dashboardOutliers && dashboardOutliers.outliers.length > 0 && (
          <Card>
            {/* Header */}
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-card-foreground">Largest Changes</p>
                <p className="text-xs text-muted-foreground">
                  vs {dashboardOutliers.previousMonthLabel} · {dashboardOutliers.comparisonNote}
                </p>
              </div>
              <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-xs font-medium">
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
                  const deltaColor = increase ? "text-destructive" : "text-success";
                  const deltaSign = increase ? "+" : "−";
                  return (
                    <tr
                      key={o.categoryId ?? `__cat${i}__`}
                      className={`border-b border-border last:border-0 ${i % 2 === 0 ? "bg-muted/15" : ""}`}
                    >
                      <td className="py-1.5 pr-2 text-muted-foreground">{o.categoryName}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{fmtWhole(o.currentAmount)}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{fmtWhole(o.previousAmount)}</td>
                      <td className={`py-1.5 pl-2 text-right tabular-nums font-semibold ${deltaColor}`}>
                        {deltaSign}{fmtWhole(Math.abs(o.delta))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}

        {/* ── Spending vs. Category Averages ────────────────────────────────── */}
        <Card>
          {categoryAverages ? (
            <CategoryVsAverageChart
              categories={categoryAverages.categories}
              yearLabel={yearLabel}
              compact
            />
          ) : (
            <div className="flex min-h-[120px] items-center justify-center text-xs text-muted-foreground">
              Loading…
            </div>
          )}
        </Card>

        {/* ── Spending Outliers ─────────────────────────────────────────────── */}
        <Card>
          {outlierTransactions ? (
            <OutlierTransactionsList categories={outlierTransactions.categories} />
          ) : (
            <div className="flex min-h-[80px] items-center justify-center text-xs text-muted-foreground">
              Loading…
            </div>
          )}
        </Card>

      </div>
    </div>
  );
}
