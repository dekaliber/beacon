import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Cell, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, LabelList,
  LineChart, Line,
} from "recharts";
import { ArrowRight, TrendingUp, Receipt, Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { CategoryOutliersChart } from "@/components/CategoryOutliersChart";
import { useApi } from "@/hooks/useApi";
import { getDashboard, getFlatCategories, getCategoryTrend, getCategoryOutliers } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Category } from "@/types";

const FullWidthCursor = (props: any) => (
  <rect x={0} y={props.y} width="100%" height={props.height} fill="#F8FAFC" style={{ pointerEvents: "none" }} />
);

function fmtCompact(v: number) {
  if (v === 0) return "";
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

// Perceptually distinct palette (Tableau10-derived) used for subcategory drill-down
const DRILL_PALETTE = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
];

function SpendingOverTimeChart({ year, month }: { year: number; month: number }) {
  const [drillCategory, setDrillCategory] = useState<{ id: string; name: string } | null>(null);
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);

  const { data: categoryTrend } = useApi(
    () => getCategoryTrend(year, month, drillCategory?.id),
    [year, month, drillCategory?.id],
  );

  if (!categoryTrend || categoryTrend.series.length === 0) return null;

  // In drill-down mode override colors with a distinct palette; top-level uses stored category colors
  const series = drillCategory
    ? categoryTrend.series.map((s, i) => ({ ...s, color: DRILL_PALETTE[i % DRILL_PALETTE.length] }))
    : categoryTrend.series;

  const chartData = categoryTrend.months.map((label, i) => {
    const point: Record<string, unknown> = { label };
    for (const s of series) {
      point[s.name] = s.values[i];
    }
    return point;
  });

  const handleDrillIn = (s: { categoryId: string; name: string; hasChildren: boolean }) => {
    if (!s.hasChildren) return;
    setDrillCategory({ id: s.categoryId, name: s.name });
    setHoveredCategory(null);
  };

  const handleDrillOut = () => {
    setDrillCategory(null);
    setHoveredCategory(null);
  };

  const yTickFormatter = (v: number) => {
    const sign = v < 0 ? "-" : "";
    const abs = Math.abs(v);
    if (abs >= 1000) {
      const k = abs / 1000;
      return `${sign}$${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
    }
    return `${sign}$${Math.round(abs)}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Spending by Category Over Time</CardTitle>
        {drillCategory && (
          <div className="flex items-center gap-1 text-sm mt-0.5">
            <button onClick={handleDrillOut} className="text-primary hover:underline">
              All categories
            </button>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">{drillCategory.name}</span>
          </div>
        )}
      </CardHeader>
      <div className="w-full" onMouseLeave={() => setHoveredCategory(null)}>
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={chartData} margin={{ top: 32, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
            <XAxis dataKey="label" fontSize={12} axisLine={false} tickLine={false} />
            <YAxis fontSize={12} tickFormatter={yTickFormatter} axisLine={false} tickLine={false} width={48} />
            <Tooltip content={() => null} cursor={{ stroke: "#E2E8F0", strokeWidth: 1 }} />
            {series.map((s) => {
              const isHovered = hoveredCategory === s.name;
              const anyHovered = hoveredCategory !== null;
              return (
                <Line
                  key={s.categoryId}
                  type="monotone"
                  dataKey={s.name}
                  stroke={s.color}
                  strokeWidth={isHovered ? 2.5 : 1.5}
                  strokeOpacity={anyHovered ? (isHovered ? 1 : 0.15) : 0.35}
                  isAnimationActive={false}
                  style={{ cursor: s.hasChildren ? "pointer" : "default" }}
                  onClick={() => handleDrillIn(s)}
                  dot={
                    isHovered
                      ? (props: any) => {
                          const { cx, cy, value, index } = props;
                          if (!value) return <g key={`d-${index}`} />;
                          return (
                            <g key={`d-${index}`}>
                              <circle cx={cx} cy={cy} r={3} fill={s.color} stroke="white" strokeWidth={1.5} />
                              <text x={cx} y={cy - 10} textAnchor="middle" fontSize={10} fill={s.color} fontWeight="600">
                                {fmtCompact(value)}
                              </text>
                            </g>
                          );
                        }
                      : false
                  }
                  activeDot={isHovered ? { r: 4, fill: s.color, stroke: "white", strokeWidth: 1.5 } : false}
                  onMouseEnter={() => setHoveredCategory(s.name)}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
        <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 px-4 pb-2">
          {series.map((s) => (
            <button
              key={s.categoryId}
              className="flex items-center gap-1.5 text-xs transition-opacity"
              style={{
                opacity: hoveredCategory === null || hoveredCategory === s.name ? 1 : 0.35,
                cursor: s.hasChildren ? "pointer" : "default",
              }}
              onMouseEnter={() => setHoveredCategory(s.name)}
              onMouseLeave={() => setHoveredCategory(null)}
              onClick={() => handleDrillIn(s)}
            >
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
              <span className={s.hasChildren ? "hover:underline" : ""}>{s.name}</span>
              {s.hasChildren && <ChevronRight className="h-3 w-3 opacity-50" />}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

export function Dashboard() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const navigate = useNavigate();

  const { data, loading } = useApi(() => getDashboard(year, month), [year, month]);
  const { data: allCategories } = useApi(() => getFlatCategories(), []);
  const { data: dashboardOutliers } = useApi(() => getCategoryOutliers(year, month), [year, month]);

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(year - 1); }
    else setMonth(month - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(year + 1); }
    else setMonth(month + 1);
  };

  const monthLabel = new Date(year, month - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-muted-foreground">Loading...</div>;
  }

  if (!data) return null;

  const totalSpent = Number(data.totalSpent);
  const budgetAmount = data.budget ? Number(data.budget) : null;
  const budgetPct = budgetAmount ? Math.round((totalSpent / budgetAmount) * 100) : null;
  const isOverBudget = budgetPct !== null && budgetPct > 100;

  const daysInMonth = new Date(year, month, 0).getDate();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  const isFutureMonth = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
  const daysRemaining = isCurrentMonth ? daysInMonth - now.getDate() : isFutureMonth ? daysInMonth : 0;

  const budgetRemaining = budgetAmount !== null ? budgetAmount - totalSpent : null;
  const dailyRemaining = budgetRemaining !== null && daysRemaining > 0 ? budgetRemaining / daysRemaining : null;

  const fmtWhole = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

  const pad = (n: number) => String(n).padStart(2, "0");
  const goToExpenses = (opts: { categoryIds?: string[]; y: number; m: number }) => {
    const lastDay = new Date(opts.y, opts.m, 0).getDate();
    // Expand any parent category IDs to also include their direct children
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

  const trendData = data.monthlyTrend.map((t) => ({
    ...t,
    personalSpent: Number(t.personalSpent),
    jointSpent: Number(t.jointSpent),
    budget: t.budget ? Number(t.budget) : undefined,
  }));

  const categoryData = data.spendingByCategory.map((c) => ({
    ...c,
    amount: Number(c.amount),
  }));


  return (
    <div className="space-y-6">
      {/* Month selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Dashboard</h2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={prevMonth}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[160px] text-center font-medium">{monthLabel}</span>
          <Button variant="ghost" size="sm" onClick={nextMonth}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Card 1: MTD Spend + MTD Budget */}
        <Card>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2">
              <Receipt className="h-5 w-5 text-primary" />
            </div>
            <div className="flex items-end gap-4">
              <div>
                <p className="text-sm text-muted-foreground">MTD Spend</p>
                <p className="text-2xl font-bold">{fmtWhole(totalSpent)}</p>
              </div>
              <p className="mb-1 text-sm text-muted-foreground">of</p>
              <div>
                <p className="text-sm text-muted-foreground">MTD Budget</p>
                {budgetAmount !== null ? (
                  <p className="text-2xl font-bold">{fmtWhole(budgetAmount)}</p>
                ) : (
                  <button
                    onClick={() => navigate("/budgets")}
                    className="text-sm text-primary hover:underline"
                  >
                    Set a budget
                  </button>
                )}
              </div>
            </div>
          </div>
        </Card>

        {/* Card 2: Budget Used + Budget Remaining (circular progress replaces icon) */}
        <Card>
          <div className="flex items-start gap-3">
            {/* Circular progress in place of icon — uses currentColor via text-* for reliable SVG rendering */}
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
            <div className="flex items-end gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Budget Used</p>
                {budgetPct !== null ? (
                  <p className={`text-2xl font-bold ${isOverBudget ? "text-destructive" : ""}`}>
                    {budgetPct}%
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">No budget set</p>
                )}
              </div>
              {budgetRemaining !== null && (
                <>
                  <p className="mb-1 text-sm text-muted-foreground">·</p>
                  <div>
                    <p className="text-sm text-muted-foreground">Budget Remaining</p>
                    <p className={`text-2xl font-bold ${budgetRemaining < 0 ? "text-destructive" : ""}`}>
                      {fmtWhole(budgetRemaining)}
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>
        </Card>

        {/* Card 3: Days Remaining + Daily Remaining */}
        <Card>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-lg bg-primary/10 p-2">
              <Calendar className="h-5 w-5 text-primary" />
            </div>
            <div className="flex items-end gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Days Remaining</p>
                <p className="text-2xl font-bold">{daysRemaining}</p>
              </div>
              {dailyRemaining !== null && (
                <>
                  <p className="mb-1 text-sm text-muted-foreground">·</p>
                  <div>
                    <p className="text-sm text-muted-foreground">Daily Remaining</p>
                    <p className={`text-2xl font-bold ${dailyRemaining < 0 ? "text-destructive" : ""}`}>
                      {fmtWhole(dailyRemaining)}
                    </p>
                  </div>
                </>
              )}
              {dailyRemaining === null && daysRemaining > 0 && (
                <>
                  <p className="mb-1 text-sm text-muted-foreground">·</p>
                  <div>
                    <p className="text-sm text-muted-foreground">Daily Remaining</p>
                    <button
                      onClick={() => navigate("/budgets")}
                      className="text-sm text-primary hover:underline"
                    >
                      Set a budget
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Spending by category - horizontal ranked bar chart */}
        <Card>
          <CardHeader>
            <CardTitle>Spending by Category</CardTitle>
          </CardHeader>
          {categoryData.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(200, categoryData.length * 28 + 16)}>
              <BarChart
                data={categoryData}
                layout="vertical"
                barSize={18}
                barCategoryGap={10}
                margin={{ top: 4, right: 76, left: 0, bottom: 4 }}
              >
                <XAxis type="number" hide axisLine={false} tickLine={false} />
                <YAxis
                  type="category"
                  dataKey="shortName"
                  width={112}
                  fontSize={12}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: string) => v.length > 14 ? v.slice(0, 13) + "…" : v}
                />
                <Tooltip cursor={<FullWidthCursor />} content={() => null} />
                <Bar
                  dataKey="amount"
                  radius={[0, 4, 4, 0]}
                  className="cursor-pointer"
                  onClick={(data: any) => {
                    if (data?.categoryId) goToExpenses({ categoryIds: [data.categoryId], y: year, m: month });
                  }}
                >
                  {categoryData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                  <LabelList
                    dataKey="amount"
                    position="right"
                    formatter={(v: any) => formatCurrency(Number(v ?? 0))}
                    style={{ fontSize: 12 }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState
              icon={Receipt}
              title="No expenses yet"
              description="Add some expenses to see your spending breakdown."
              action={
                <Button size="sm" onClick={() => navigate("/expenses")}>
                  Add Expense
                </Button>
              }
            />
          )}
        </Card>

        {/* Right column: largest changes + monthly trend stacked */}
        <div className="flex flex-col gap-4">
          {/* Largest Changes by Category — month-over-month */}
          {dashboardOutliers && (
            <Card>
              <CategoryOutliersChart data={dashboardOutliers} compact />
            </Card>
          )}

          {/* Monthly trend - stacked personal/joint bars with budget reference line */}
          <Card>
            <CardHeader>
              <CardTitle>Monthly Trend</CardTitle>
            </CardHeader>
            {trendData.some((t) => t.personalSpent > 0 || t.jointSpent > 0) ? (
              <div className="cursor-pointer">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={trendData}
                  margin={{ top: 4, right: 48, left: 0, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                  <XAxis dataKey="label" fontSize={12} axisLine={false} tickLine={false} />
                  <YAxis
                    fontSize={12}
                    tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip formatter={(value: number | undefined, name: string | undefined) => [formatCurrency(value ?? 0), name ?? ""]} cursor={{ fill: "#F8FAFC" }} />
                  <Legend
                    align="center"
                    wrapperStyle={{ paddingTop: 12 }}
                    formatter={(value: string) => <span style={{ paddingLeft: 2, paddingRight: 16, color: "#0F172A" }}>{value}</span>}
                  />
                  <Bar
                    dataKey="personalSpent"
                    name="Personal"
                    stackId="a"
                    fill="#9CA3AF"
                    onClick={(data: any) => { if (data?.year && data?.month) goToExpenses({ y: data.year, m: data.month }); }}
                  />
                  <Bar
                    dataKey="jointSpent"
                    name="Joint"
                    stackId="a"
                    fill="#3B82F6"
                    radius={[4, 4, 0, 0]}
                    onClick={(data: any) => { if (data?.year && data?.month) goToExpenses({ y: data.year, m: data.month }); }}
                  />
                  {budgetAmount !== null && (
                    <ReferenceLine
                      y={budgetAmount}
                      stroke="#EF4444"
                      strokeDasharray="5 5"
                      strokeWidth={2}
                      label={{ value: "Budget", position: "right", fontSize: 11, fill: "#EF4444" }}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState
                icon={TrendingUp}
                title="No trend data"
                description="Spending trends will appear as you add expenses."
              />
            )}
          </Card>
        </div>
      </div>

      {/* Spending by Category over time — spaghetti chart */}
      <SpendingOverTimeChart year={year} month={month} />

      {/* Recent expenses */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent Expenses</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => navigate("/expenses")}>
            View all <ArrowRight className="h-4 w-4" />
          </Button>
        </CardHeader>
        {data.recentTransactions.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-3 pr-4 font-medium whitespace-nowrap">Date</th>
                  <th className="pb-3 pr-4 font-medium">Description</th>
                  <th className="pb-3 pr-4 font-medium">Vendor</th>
                  <th className="pb-3 pr-4 font-medium">Category</th>
                  <th className="pb-3 pr-4 font-medium">Account</th>
                  <th className="pb-3 pr-4 font-medium"></th>
                  <th className="pb-3 text-right font-medium whitespace-nowrap">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.recentTransactions.map((tx) => {
                  const amt = Number(tx.amount);
                  const isCredit = amt < 0;
                  return (
                    <tr key={tx.id}>
                      <td className="py-2.5 pr-4 text-muted-foreground whitespace-nowrap">{formatDate(tx.date)}</td>
                      <td className="py-2.5 pr-4 font-medium">{tx.description}</td>
                      <td className="py-2.5 pr-4 text-muted-foreground">{tx.vendor || "—"}</td>
                      <td className="py-2.5 pr-4 text-muted-foreground">{tx.category?.name ?? "—"}</td>
                      <td className="py-2.5 pr-4 text-muted-foreground">{tx.account.name}</td>
                      <td className="py-2.5 pr-4">
                        <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white ${tx.account.isJoint ? "bg-blue-500" : "bg-gray-400"}`}>
                          {tx.account.isJoint ? "J" : "P"}
                        </span>
                      </td>
                      <td className={`py-2.5 text-right font-semibold ${isCredit ? "text-success" : ""}`}>
                        {isCredit ? `+${formatCurrency(Math.abs(amt))}` : formatCurrency(amt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Receipt}
            title="No expenses yet"
            description="Your recent expenses will show up here."
          />
        )}
      </Card>
    </div>
  );
}
