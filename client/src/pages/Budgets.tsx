import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { PiggyBank, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getBudgetDetail, saveBudget } from "@/api";
import { formatCurrency } from "@/lib/utils";

export function Budgets() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");

  const { data, refetch } = useApi(() => getBudgetDetail(year, month), [year, month]);

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(year - 1); }
    else setMonth(month - 1);
  };
  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(year + 1); }
    else setMonth(month + 1);
  };

  const handleSaveBudget = async () => {
    const amount = parseFloat(budgetInput);
    if (isNaN(amount) || amount <= 0) return;
    await saveBudget({ amount, month, year });
    setEditingBudget(false);
    refetch();
  };

  const monthLabel = new Date(year, month - 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const totalSpent = Number(data?.totalSpent ?? 0);
  const budgetAmount = data?.budget ? Number(data.budget.amount) : null;
  const remaining = budgetAmount !== null ? budgetAmount - totalSpent : null;
  const pct = budgetAmount ? Math.round((totalSpent / budgetAmount) * 100) : null;

  const categoryData = (data?.categoryBreakdown ?? []).map((c) => ({
    name: c.parentCategoryName ? `${c.parentCategoryName} > ${c.categoryName}` : c.categoryName,
    shortName: c.categoryName,
    amount: Number(c.total),
    color: c.color,
    count: c.count,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Budgets</h2>
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

      {/* Budget overview card */}
      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-muted-foreground">Monthly Budget</p>
            {editingBudget ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-lg">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveBudget()}
                  className="w-32 rounded-md border border-border px-2 py-1 text-lg focus:border-primary focus:outline-none"
                  autoFocus
                />
                <Button size="sm" onClick={handleSaveBudget}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingBudget(false)}>Cancel</Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <p className="text-3xl font-bold">
                  {budgetAmount !== null ? formatCurrency(budgetAmount) : "Not set"}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setBudgetInput(budgetAmount?.toString() ?? "");
                    setEditingBudget(true);
                  }}
                >
                  {budgetAmount !== null ? "Edit" : "Set Budget"}
                </Button>
              </div>
            )}
          </div>

          {budgetAmount !== null && (
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Spent / Remaining</p>
              <p className="text-lg">
                <span className="font-bold">{formatCurrency(totalSpent)}</span>
                {" / "}
                <span className={remaining !== null && remaining < 0 ? "font-bold text-destructive" : "text-success"}>
                  {formatCurrency(remaining ?? 0)}
                </span>
              </p>
              <div className="mt-2 h-3 w-48 overflow-hidden rounded-full bg-secondary">
                <div
                  className={`h-full rounded-full transition-all ${pct && pct > 100 ? "bg-destructive" : pct && pct > 80 ? "bg-warning" : "bg-success"}`}
                  style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
                />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{pct}% used</p>
            </div>
          )}
        </div>
      </Card>

      {/* Category breakdown */}
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

            {/* Category table */}
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
    </div>
  );
}
