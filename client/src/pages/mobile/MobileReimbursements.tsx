import { useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { getExpenses, updateExpense } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { BeaconLoader } from "@/components/BeaconLoader";
import { StatValue } from "@/components/Typography";

export function MobileReimbursements() {
  const { data: expenseData, refetch } = useApi(
    () => getExpenses({ isReimbursementExpected: "true", limit: "200" }),
    []
  );
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const expenses = expenseData?.data ?? [];
  const total = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);

  const openResolve = (id: string) => {
    setResolvingId(id);
    setConfirming(true);
  };

  const closeSheet = () => {
    setConfirming(false);
    setResolvingId(null);
  };

  const confirmResolve = async () => {
    if (!resolvingId) return;
    await updateExpense(resolvingId, { isReimbursementExpected: false, reimbursementNote: null });
    closeSheet();
    refetch();
  };

  if (!expenseData) return <BeaconLoader />;

  return (
    <>
      <div className="space-y-6">
        <div>
          <h1 className="tp-page-title">Pending Reimbursements</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Expenses you're expecting money back on.
          </p>
        </div>

        {expenses.length > 0 && (
          <div className="flex items-center justify-between rounded-xl border border-warn-line bg-warn-soft px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-medium text-warn-deep">
              <AlertCircle className="h-4 w-4" />
              {expenses.length} pending
            </span>
            <StatValue className="text-sm font-semibold text-warn-deep">
              {formatCurrency(total)}
            </StatValue>
          </div>
        )}

        {expenses.length === 0 ? (
          <div className="rounded-xl border border-border px-4 py-12 text-center">
            <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No pending reimbursements</p>
            <p className="mt-1 tp-caption">
              Flag an expense as expecting reimbursement from the Expenses page to track it here.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border divide-y divide-border">
            {expenses.map((expense) => (
              <div key={expense.id} className="flex items-start gap-3 px-4 py-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{expense.description}</p>
                  <p className="tp-caption">
                    {expense.category?.name
                      ? `${expense.category.name} · `
                      : ""}{formatDate(expense.date)}
                  </p>
                  {expense.reimbursementNote && (
                    <p className="mt-0.5 tp-caption">{expense.reimbursementNote}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <StatValue className="text-sm font-semibold text-down">
                    -{formatCurrency(expense.amount)}
                  </StatValue>
                  <button
                    type="button"
                    onClick={() => openResolve(expense.id)}
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent transition-colors"
                  >
                    Resolve
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          confirming ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={closeSheet}
      />

      {/* Bottom sheet */}
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col rounded-t-2xl bg-background shadow-xl transition-transform duration-250 ease-out",
          confirming ? "translate-y-0" : "translate-y-full"
        )}
      >
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-border">
          <h2 className="tp-panel-title">Mark as resolved?</h2>
          <button type="button" onClick={closeSheet} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 pb-8 space-y-4">
          <p className="text-sm text-muted-foreground">
            This will clear the reimbursement flag on this transaction.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={closeSheet}
              className="flex-1 rounded-md border border-border py-3 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmResolve}
              className="flex-1 rounded-md bg-up py-3 text-sm font-semibold text-white hover:bg-up transition-colors"
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
