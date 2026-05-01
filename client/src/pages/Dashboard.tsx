import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Cell, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, LabelList,
  PieChart, Pie,
} from "recharts";
import { Receipt, ChevronLeft, ChevronRight, Zap } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { CategoryOutliersChart } from "@/components/CategoryOutliersChart";
import { CategoryVsAverageChart } from "@/components/CategoryVsAverageChart";
import { SpendingVelocitySparkline } from "@/components/SpendingVelocitySparkline";
import { OutlierTransactionsList } from "@/components/OutlierTransactionsList";
import { useApi } from "@/hooks/useApi";
import { getDashboard, getFlatCategories, getCategoryOutliers, getCategoryAverages, getSpendingVelocity, getOutlierTransactions, getDataRange } from "@/api";
import { formatCurrency } from "@/lib/utils";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import type { Category } from "@/types";

const FullWidthCursor = (props: any) => (
  <rect x={0} y={props.y} width="100%" height={props.height} fill="#F8FAFC" style={{ pointerEvents: "none" }} />
);

export function Dashboard() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [outlierComparison, setOutlierComparison] = useState<"mom" | "yoy">("mom");
  const navigate = useNavigate();

  const { data, loading } = useApi(() => getDashboard(year, month), [year, month]);
  const { data: allCategories } = useApi(() => getFlatCategories(), []);
  const { data: dashboardOutliers } = useApi(
    () => getCategoryOutliers(year, month, outlierComparison),
    [year, month, outlierComparison],
  );
  const { data: categoryAverages }   = useApi(() => getCategoryAverages(year, month),    [year, month]);
  const { data: spendingVelocity }   = useApi(() => getSpendingVelocity(year, month),    [year, month]);
  const { data: outlierTransactions } = useApi(() => getOutlierTransactions(year, month), [year, month]);
  const { data: dataRange } = useApi(() => getDataRange(), []);

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

  const monthLabel = new Date(year, month - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-muted-foreground">Loading...</div>;
  }

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

  const dailyRate       = daysElapsed > 0 ? totalSpent / daysElapsed : null;
  const budgetDailyRate = budgetAmount ? budgetAmount / daysInMonth : null;
  const paceRatio       = dailyRate !== null && budgetDailyRate ? dailyRate / budgetDailyRate : null;
  const paceOffPct      = paceRatio !== null ? Math.round((paceRatio - 1) * 100) : null;

  const budgetRemaining    = budgetAmount !== null ? budgetAmount - totalSpent : null;
  const personalRemaining  = personalBudget !== null ? personalBudget - personalSpent : null;
  const jointRemaining     = jointBudget    !== null ? jointBudget    - jointSpent    : null;
  const prevMonthMtd       = data.prevMonthMtd ?? 0;
  const momDelta           = prevMonthMtd > 0 ? totalSpent - prevMonthMtd : null;
  const momDeltaPct        = momDelta !== null && prevMonthMtd > 0 ? Math.round((momDelta / prevMonthMtd) * 100) : null;

  const fmtWhole = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  const pad = (n: number) => String(n).padStart(2, "0");
  const goToExpenses = (opts: { categoryIds?: string[]; y: number; m: number }) => {
    const lastDay = new Date(opts.y, opts.m, 0).getDate();
    const cats: Category[] = allCategories ?? [];
    const expandedIds = (opts.categoryIds ?? []).flatMap((id) => {
      const children = cats.filter((c) => c.parentId === id).map((c) => c.id);
      return children.length > 0 ? [id, ...children] : [id];
    });
    navigate("/expenses", {
      state: {
        tempFilters: {
          categoryIds: expandedIds,
          tagIds: [],
          accountIds: [],
          startDate: `${opts.y}-${pad(opts.m)}-01`,
          endDate: `${opts.y}-${pad(opts.m)}-${pad(lastDay)}`,
          datePreset: "Custom",
        },
      },
    });
  };

  const showPersonalJoint = personalSpent > 0 && jointSpent > 0;

  return (
    <div className="space-y-6">
      {/* Month selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={prevMonth} disabled={atMin}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[8rem] text-center font-semibold">{monthLabel}</span>
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
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg bg-primary/10 p-2 shrink-0">
                  <Receipt className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">MTD Spend</p>
                  <p className="text-2xl font-bold">{fmtWhole(totalSpent)}</p>
                  {budgetAmount !== null ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">of {fmtWhole(budgetAmount)} budget</p>
                  ) : (
                    <button onClick={() => navigate("/budgets")} className="mt-0.5 text-xs text-primary hover:underline">
                      Set a budget
                    </button>
                  )}
                </div>
              </div>

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
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PERSONAL_COLOR }} />
                    <span>Personal <span className="font-medium text-foreground">{fmtWhole(personalSpent)}</span></span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: JOINT_COLOR }} />
                    <span>Joint <span className="font-medium text-foreground">{fmtWhole(jointSpent)}</span></span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Card 2: Budget used % + remaining + Personal/Joint breakdown */}
        <Card>
          <div className="flex items-start gap-3">
            <svg className={`mt-0.5 h-9 w-9 shrink-0 ${isOverBudget ? "text-destructive" : "text-success"}`} viewBox="0 0 36 36">
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
                  </span>
                  {" "}{budgetRemaining < 0 ? "over budget" : "remaining"}
                </p>
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
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PERSONAL_COLOR }} />
                        Personal
                      </span>
                      <span className="text-muted-foreground">
                        <span className={`font-medium ${over ? "text-destructive" : "text-foreground"}`}>{fmtWhole(personalSpent)}</span>
                        {" / "}{fmtWhole(personalBudget)}
                        {personalRemaining !== null && (
                          <span className={over ? " text-destructive" : ""}>{" "}({over ? "+" : "−"}{fmtWhole(Math.abs(personalRemaining!))})</span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: over ? "var(--color-destructive)" : "var(--color-success)" }} />
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
                          <span className={over ? " text-destructive" : ""}>{" "}({over ? "+" : "−"}{fmtWhole(Math.abs(jointRemaining!))})</span>
                        )}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: over ? "var(--color-destructive)" : "var(--color-success)" }} />
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </Card>

        {/* Card 3: Pace — daily run rate vs budget-implied daily rate + velocity sparkline */}
        <Card>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2 shrink-0">
              <Zap className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-muted-foreground">Daily Pace</p>
              {dailyRate !== null ? (
                <p className="text-2xl font-bold">{fmtWhole(dailyRate)}<span className="text-base font-normal text-muted-foreground">/day</span></p>
              ) : (
                <p className="text-2xl font-bold text-muted-foreground">—</p>
              )}
              {budgetDailyRate !== null && dailyRate !== null && paceOffPct !== null && (
                <p className={`mt-1 text-xs ${Math.abs(paceOffPct) <= 10 ? "text-muted-foreground" : paceOffPct > 0 ? "text-destructive" : "text-success"}`}>
                  {Math.abs(paceOffPct) <= 10
                    ? <span>On pace · budget {fmtWhole(budgetDailyRate)}/day</span>
                    : paceOffPct > 0
                      ? <span><span className="font-medium">{paceOffPct}% over pace</span> · budget {fmtWhole(budgetDailyRate)}/day</span>
                      : <span><span className="font-medium">{Math.abs(paceOffPct)}% under pace</span> · budget {fmtWhole(budgetDailyRate)}/day</span>
                  }
                </p>
              )}
              {budgetDailyRate === null && (
                <button onClick={() => navigate("/budgets")} className="mt-1 text-xs text-primary hover:underline">
                  Set a budget
                </button>
              )}
              {dailyRate === null && daysElapsed === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">No data yet this month</p>
              )}
            </div>
          </div>
          {/* Velocity sparkline — cumulative spend vs budget pace */}
          {spendingVelocity && spendingVelocity.lastKnownDay > 0 && (
            <div className="mt-3">
              <SpendingVelocitySparkline data={spendingVelocity} height={68} />
              <div className="mt-1 flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <svg width={16} height={8}>
                    <line x1="0" y1="4" x2="16" y2="4" stroke={paceOffPct !== null && paceOffPct > 0 ? "var(--color-destructive)" : "var(--color-primary)"} strokeWidth="1.5" />
                  </svg>
                  <span className="text-xs text-muted-foreground">Actual</span>
                </div>
                {spendingVelocity.totalBudget !== null && (
                  <div className="flex items-center gap-1.5">
                    <svg width={16} height={8}>
                      <line x1="0" y1="4" x2="16" y2="4" stroke="var(--color-muted-foreground)" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.6" />
                    </svg>
                    <span className="text-xs text-muted-foreground">Budget pace</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* ── Analysis: Largest Changes + Category vs Average ───────────────── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Largest Changes by Category — with MoM / YoY toggle */}
        <Card>
          {dashboardOutliers && (
            <CategoryOutliersChart
              data={dashboardOutliers}
              compact
              header={
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-card-foreground">Largest Changes by Category</p>
                    <p className="text-xs text-muted-foreground">
                      vs {dashboardOutliers.previousMonthLabel} · {dashboardOutliers.comparisonNote}
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

        {/* Right column: Category vs Average + Outlier Transactions */}
        <div className="flex flex-col gap-4">
          <Card>
            {categoryAverages && (
              <CategoryVsAverageChart categories={categoryAverages.categories} compact />
            )}
            {!categoryAverages && (
              <div className="flex h-full min-h-[120px] items-center justify-center text-xs text-muted-foreground">
                Loading…
              </div>
            )}
          </Card>
          <Card>
            {outlierTransactions && (
              <OutlierTransactionsList categories={outlierTransactions.categories} />
            )}
            {!outlierTransactions && (
              <div className="flex min-h-[80px] items-center justify-center text-xs text-muted-foreground">
                Loading…
              </div>
            )}
          </Card>
        </div>
      </div>

    </div>
  );
}
