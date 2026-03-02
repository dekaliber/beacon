import { AlertCircle } from "lucide-react";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getExpenses, updateExpense } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";

export function ReimbursementsPage() {
  const { data: expenseData, refetch } = useApi(
    () => getExpenses({ isReimbursementExpected: "true", limit: "200" }),
    []
  );

  const handleResolve = async (id: string) => {
    if (confirm("Mark this as resolved? This will clear the reimbursement flag.")) {
      await updateExpense(id, { isReimbursementExpected: false, reimbursementNote: null });
      refetch();
    }
  };

  const expenses = expenseData?.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Pending Reimbursements</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Expenses you're expecting money back on — returns awaiting refunds, group expenses awaiting payment, etc.
        </p>
      </div>

      <Card>
        {expenses.length > 0 ? (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-3 font-medium">Date</th>
                    <th className="pb-3 font-medium">Description</th>
                    <th className="pb-3 font-medium">Category</th>
                    <th className="pb-3 font-medium">Account</th>
                    <th className="pb-3 font-medium">Note</th>
                    <th className="pb-3 text-right font-medium">Amount</th>
                    <th className="pb-3 text-right font-medium">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {expenses.map((expense) => (
                    <tr key={expense.id} className="bg-amber-50/50 hover:bg-amber-50">
                      <td className="py-3">{formatDate(expense.date)}</td>
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 flex-shrink-0 text-amber-500" />
                          <span className="font-medium">{expense.description}</span>
                        </div>
                      </td>
                      <td className="py-3">{expense.category.name}</td>
                      <td className="py-3">{expense.account.name}</td>
                      <td className="py-3 text-muted-foreground">
                        {expense.reimbursementNote ?? <span className="text-border">—</span>}
                      </td>
                      <td className="py-3 text-right font-semibold text-destructive">
                        -{formatCurrency(expense.amount)}
                      </td>
                      <td className="py-3 text-right">
                        <button
                          onClick={() => handleResolve(expense.id)}
                          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                        >
                          Resolve
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile list */}
            <div className="divide-y divide-border md:hidden">
              {expenses.map((expense) => (
                <div key={expense.id} className="flex items-start justify-between py-3">
                  <div className="flex min-w-0 flex-1 gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{expense.description}</p>
                      <p className="text-sm text-muted-foreground">
                        {expense.category.name} &middot; {formatDate(expense.date)}
                      </p>
                      {expense.reimbursementNote && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{expense.reimbursementNote}</p>
                      )}
                    </div>
                  </div>
                  <div className="ml-4 flex flex-col items-end gap-1">
                    <span className="font-semibold text-destructive">-{formatCurrency(expense.amount)}</span>
                    <button
                      onClick={() => handleResolve(expense.id)}
                      className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                    >
                      Resolve
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 border-t border-border pt-4 text-sm text-muted-foreground">
              {expenses.length} pending reimbursement{expenses.length !== 1 ? "s" : ""}
            </div>
          </>
        ) : (
          <EmptyState
            icon={AlertCircle}
            title="No pending reimbursements"
            description="Flag an expense as expecting reimbursement from the Expenses page to track it here."
          />
        )}
      </Card>
    </div>
  );
}
