import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  PieChart, Pie, Cell, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from "recharts";
import { ArrowRight, TrendingUp, Receipt, PiggyBank, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getDashboard } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";

export function Dashboard() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const navigate = useNavigate();

  const { data, loading } = useApi(() => getDashboard(year, month), [year, month]);

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

  const trendData = data.monthlyTrend.map((t) => ({
    ...t,
    spent: Number(t.spent),
    budget: t.budget ? Number(t.budget) : undefined,
  }));

  const pieData = data.spendingByCategory.map((c) => ({
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
        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <Receipt className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Spent</p>
              <p className="text-2xl font-bold">{formatCurrency(totalSpent)}</p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <PiggyBank className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Budget</p>
              {budgetAmount !== null ? (
                <p className="text-2xl font-bold">{formatCurrency(budgetAmount)}</p>
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
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className={`rounded-lg p-2 ${isOverBudget ? "bg-destructive/10" : "bg-success/10"}`}>
              <TrendingUp className={`h-5 w-5 ${isOverBudget ? "text-destructive" : "text-success"}`} />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Budget Status</p>
              {budgetPct !== null ? (
                <>
                  <p className={`text-2xl font-bold ${isOverBudget ? "text-destructive" : ""}`}>
                    {budgetPct}%
                  </p>
                  <div className="mt-1 h-2 w-32 overflow-hidden rounded-full bg-secondary">
                    <div
                      className={`h-full rounded-full transition-all ${isOverBudget ? "bg-destructive" : "bg-success"}`}
                      style={{ width: `${Math.min(budgetPct, 100)}%` }}
                    />
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No budget set</p>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Spending by category */}
        <Card>
          <CardHeader>
            <CardTitle>Spending by Category</CardTitle>
          </CardHeader>
          {pieData.length > 0 ? (
            <div className="flex flex-col items-center gap-4 md:flex-row">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="amount"
                    nameKey="shortName"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={90}
                    paddingAngle={2}
                  >
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-1.5 text-sm">
                {pieData.slice(0, 6).map((item) => (
                  <div key={item.categoryId} className="flex items-center gap-2">
                    <div
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-muted-foreground">{item.shortName}</span>
                    <span className="ml-auto font-medium">{formatCurrency(item.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
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

        {/* Monthly trend */}
        <Card>
          <CardHeader>
            <CardTitle>Monthly Trend</CardTitle>
          </CardHeader>
          {trendData.some((t) => t.spent > 0) ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="label" fontSize={12} />
                <YAxis fontSize={12} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Bar dataKey="spent" name="Spent" fill="#4F46E5" radius={[4, 4, 0, 0]} />
                {trendData.some((t) => t.budget) && (
                  <ReferenceLine
                    y={Number(trendData[trendData.length - 1]?.budget ?? 0)}
                    stroke="#EF4444"
                    strokeDasharray="5 5"
                    label={{ value: "Budget", position: "right", fontSize: 12 }}
                  />
                )}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState
              icon={TrendingUp}
              title="No trend data"
              description="Spending trends will appear as you add expenses."
            />
          )}
        </Card>
      </div>

      {/* Recent transactions */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent Transactions</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => navigate("/expenses")}>
            View all <ArrowRight className="h-4 w-4" />
          </Button>
        </CardHeader>
        {data.recentTransactions.length > 0 ? (
          <div className="divide-y divide-border">
            {data.recentTransactions.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">{tx.description}</p>
                  <p className="text-sm text-muted-foreground">
                    {tx.category.name} &middot; {tx.account.name} &middot; {formatDate(tx.date)}
                  </p>
                </div>
                <span className="font-semibold text-destructive">
                  -{formatCurrency(tx.amount)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Receipt}
            title="No transactions"
            description="Your recent transactions will show up here."
          />
        )}
      </Card>
    </div>
  );
}
