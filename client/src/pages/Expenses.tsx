import { useState, useEffect } from "react";
import { Plus, Trash2, Pencil, Receipt, ChevronLeft, ChevronRight, AlertCircle } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getExpenses, getAccounts, getFlatCategories, getTags, createExpense, updateExpense, deleteExpense } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Expense, Category, Account, Tag } from "@/types";

// Investment accounts cannot have expenses
const EXPENSE_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CREDIT_CARD", "CASH"];

export function Expenses() {
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);

  const { data: expenseData, refetch } = useApi(() => getExpenses({ page: page.toString(), limit: "20" }), [page]);
  const { data: categories } = useApi(() => getFlatCategories(), []);
  const { data: accounts } = useApi(() => getAccounts(), []);
  const { data: tags } = useApi(() => getTags(), []);

  const eligibleAccounts = (accounts ?? []).filter((a) => EXPENSE_ACCOUNT_TYPES.includes(a.type));

  const handleSave = async (formData: Record<string, unknown>) => {
    if (editing) {
      await updateExpense(editing.id, formData);
    } else {
      await createExpense(formData);
    }
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const handleDelete = async (id: string) => {
    if (confirm("Delete this expense?")) {
      await deleteExpense(id);
      refetch();
    }
  };

  const openEdit = (expense: Expense) => {
    setEditing(expense);
    setModalOpen(true);
  };

  const expenses = expenseData?.data ?? [];
  const pagination = expenseData?.pagination;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Expenses</h2>
        <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus className="h-4 w-4" /> Add Expense
        </Button>
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
                    <th className="pb-3 text-right font-medium">Amount</th>
                    <th className="pb-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {expenses.map((expense) => (
                    <tr
                      key={expense.id}
                      className={expense.isReimbursementExpected ? "bg-amber-50/50 hover:bg-amber-50" : "hover:bg-muted/50"}
                    >
                      <td className="py-3">{formatDate(expense.date)}</td>
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          {expense.isReimbursementExpected && (
                            <AlertCircle className="h-4 w-4 flex-shrink-0 text-amber-500" title={expense.reimbursementNote ?? "Reimbursement expected"} />
                          )}
                          <span className="font-medium">{expense.description}</span>
                          {expense.tags.length > 0 && (
                            <div className="flex gap-1">
                              {expense.tags.map(({ tag }) => (
                                <span
                                  key={tag.id}
                                  className="rounded-full px-1.5 py-0.5 text-xs font-medium"
                                  style={{
                                    backgroundColor: tag.color ? `${tag.color}25` : "hsl(var(--muted))",
                                    color: tag.color ?? "inherit",
                                  }}
                                >
                                  {tag.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="py-3">{expense.category.name}</td>
                      <td className="py-3">{expense.account.name}</td>
                      <td className="py-3 text-right font-semibold text-destructive">
                        -{formatCurrency(expense.amount)}
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex justify-end gap-1">
                          <button onClick={() => openEdit(expense)} className="rounded p-1 hover:bg-accent">
                            <Pencil className="h-4 w-4 text-muted-foreground" />
                          </button>
                          <button onClick={() => handleDelete(expense.id)} className="rounded p-1 hover:bg-accent">
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile list */}
            <div className="divide-y divide-border md:hidden">
              {expenses.map((expense) => (
                <div
                  key={expense.id}
                  className={`flex items-center justify-between py-3 ${expense.isReimbursementExpected ? "bg-amber-50/50" : ""}`}
                >
                  <div className="min-w-0 flex-1 flex items-start gap-2">
                    {expense.isReimbursementExpected && (
                      <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium">{expense.description}</p>
                      <p className="text-sm text-muted-foreground">
                        {expense.category.name} &middot; {formatDate(expense.date)}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <span className="font-semibold text-destructive">-{formatCurrency(expense.amount)}</span>
                    <button onClick={() => openEdit(expense)} className="rounded p-1 hover:bg-accent">
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </button>
                    <button onClick={() => handleDelete(expense.id)} className="rounded p-1 hover:bg-accent">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {pagination && pagination.totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
                <p className="text-sm text-muted-foreground">
                  {pagination.total} expense{pagination.total !== 1 ? "s" : ""}
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm">
                    Page {page} of {pagination.totalPages}
                  </span>
                  <Button variant="ghost" size="sm" disabled={page === pagination.totalPages} onClick={() => setPage(page + 1)}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            icon={Receipt}
            title="No expenses yet"
            description="Start tracking your spending by adding your first expense."
            action={
              <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
                <Plus className="h-4 w-4" /> Add Expense
              </Button>
            }
          />
        )}
      </Card>

      <ExpenseModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
        expense={editing}
        categories={categories ?? []}
        accounts={eligibleAccounts}
        tags={tags ?? []}
      />
    </div>
  );
}

interface ExpenseModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  expense: Expense | null;
  categories: Category[];
  accounts: Account[];
  tags: Tag[];
}

function ExpenseModal({ open, onClose, onSave, expense, categories, accounts, tags }: ExpenseModalProps) {
  const [saving, setSaving] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isReimbursementExpected, setIsReimbursementExpected] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedTagIds(expense?.tags.map((t) => t.tagId) ?? []);
      setIsReimbursementExpected(expense?.isReimbursementExpected ?? false);
    }
  }, [open, expense]);

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    await onSave({
      amount: parseFloat(form.get("amount") as string),
      description: form.get("description") as string,
      date: form.get("date") as string,
      categoryId: form.get("categoryId") as string,
      accountId: form.get("accountId") as string,
      notes: (form.get("notes") as string) || undefined,
      isReimbursementExpected,
      reimbursementNote: isReimbursementExpected
        ? (form.get("reimbursementNote") as string) || undefined
        : null,
      tagIds: selectedTagIds,
    });
    setSaving(false);
  };

  // Group subcategories under parents for the select
  const parentCategories = categories.filter((c) => !c.parentId);
  const childCategories = categories.filter((c) => c.parentId);

  return (
    <Modal open={open} onClose={onClose} title={expense ? "Edit Expense" : "Add Expense"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Amount</label>
          <input
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            defaultValue={expense?.amount ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="0.00"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Description</label>
          <input
            name="description"
            type="text"
            required
            defaultValue={expense?.description ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="What did you spend on?"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Date</label>
            <input
              name="date"
              type="date"
              required
              defaultValue={expense ? new Date(expense.date).toISOString().split("T")[0] : new Date().toISOString().split("T")[0]}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Account</label>
            <select
              name="accountId"
              required
              defaultValue={expense?.accountId ?? ""}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Select account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Category</label>
          <select
            name="categoryId"
            required
            defaultValue={expense?.categoryId ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">Select category</option>
            {parentCategories.map((parent) => {
              const children = childCategories.filter((c) => c.parentId === parent.id);
              if (children.length === 0) {
                return <option key={parent.id} value={parent.id}>{parent.name}</option>;
              }
              return (
                <optgroup key={parent.id} label={parent.name}>
                  {children.map((child) => (
                    <option key={child.id} value={child.id}>{child.name}</option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </div>

        {tags.length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium">Tags</label>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const selected = selectedTagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className="rounded-full border px-3 py-1 text-xs font-medium transition-colors"
                    style={
                      selected && tag.color
                        ? { backgroundColor: tag.color, borderColor: tag.color, color: "#fff" }
                        : selected
                        ? { backgroundColor: "hsl(var(--primary))", borderColor: "hsl(var(--primary))", color: "#fff" }
                        : {}
                    }
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium">Notes (optional)</label>
          <textarea
            name="notes"
            rows={2}
            defaultValue={expense?.notes ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="Additional notes..."
          />
        </div>

        <div className="rounded-md border border-border p-3">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={isReimbursementExpected}
              onChange={(e) => setIsReimbursementExpected(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-sm font-medium">Expecting reimbursement or refund</span>
          </label>
          {isReimbursementExpected && (
            <div className="mt-2">
              <input
                name="reimbursementNote"
                type="text"
                defaultValue={expense?.reimbursementNote ?? ""}
                className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="e.g. Return pending, or expecting $25 from John"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : expense ? "Update" : "Add Expense"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
