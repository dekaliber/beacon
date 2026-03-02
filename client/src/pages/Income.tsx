import { useState, useEffect } from "react";
import { Plus, Trash2, Pencil, TrendingUp, ChevronLeft, ChevronRight } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getIncome, getAccounts, getTags, createIncome, updateIncome, deleteIncome } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Account, Income, IncomeSource, Tag } from "@/types";

const SOURCE_LABELS: Record<IncomeSource, string> = {
  DIVIDENDS: "Dividends",
  INTEREST: "Interest",
  CAPITAL_GAINS: "Capital Gains",
  GIFTS: "Gifts",
  OTHER: "Other",
};

// Account types that support income
const INCOME_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "INVESTMENT"];

export function IncomePage() {
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Income | null>(null);

  const { data: incomeData, refetch } = useApi(() => getIncome({ page: page.toString(), limit: "20" }), [page]);
  const { data: accounts } = useApi(() => getAccounts(), []);
  const { data: tags } = useApi(() => getTags(), []);

  const eligibleAccounts = (accounts ?? []).filter((a) => INCOME_ACCOUNT_TYPES.includes(a.type));

  const handleSave = async (formData: Record<string, unknown>) => {
    if (editing) {
      await updateIncome(editing.id, formData);
    } else {
      await createIncome(formData);
    }
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const handleDelete = async (id: string) => {
    if (confirm("Delete this income entry?")) {
      await deleteIncome(id);
      refetch();
    }
  };

  const incomes = incomeData?.data ?? [];
  const pagination = incomeData?.pagination;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Income</h2>
        <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus className="h-4 w-4" /> Add Income
        </Button>
      </div>

      <Card>
        {incomes.length > 0 ? (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="pb-3 font-medium">Date</th>
                    <th className="pb-3 font-medium">Source</th>
                    <th className="pb-3 font-medium">Account</th>
                    <th className="pb-3 font-medium">Tags</th>
                    <th className="pb-3 text-right font-medium">Amount</th>
                    <th className="pb-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {incomes.map((income) => (
                    <tr key={income.id} className="hover:bg-muted/50">
                      <td className="py-3">{formatDate(income.date)}</td>
                      <td className="py-3 font-medium">{SOURCE_LABELS[income.source]}</td>
                      <td className="py-3">{income.account.name}</td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-1">
                          {income.tags.map(({ tag }) => (
                            <span
                              key={tag.id}
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                              style={{
                                backgroundColor: tag.color ? `${tag.color}20` : "hsl(var(--muted))",
                                color: tag.color ?? "inherit",
                              }}
                            >
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 text-right font-semibold text-green-600">
                        +{formatCurrency(income.amount)}
                      </td>
                      <td className="py-3 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => { setEditing(income); setModalOpen(true); }}
                            className="rounded p-1 hover:bg-accent"
                          >
                            <Pencil className="h-4 w-4 text-muted-foreground" />
                          </button>
                          <button onClick={() => handleDelete(income.id)} className="rounded p-1 hover:bg-accent">
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
              {incomes.map((income) => (
                <div key={income.id} className="flex items-center justify-between py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{SOURCE_LABELS[income.source]}</p>
                    <p className="text-sm text-muted-foreground">
                      {income.account.name} &middot; {formatDate(income.date)}
                    </p>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <span className="font-semibold text-green-600">+{formatCurrency(income.amount)}</span>
                    <button
                      onClick={() => { setEditing(income); setModalOpen(true); }}
                      className="rounded p-1 hover:bg-accent"
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </button>
                    <button onClick={() => handleDelete(income.id)} className="rounded p-1 hover:bg-accent">
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
                  {pagination.total} entr{pagination.total !== 1 ? "ies" : "y"}
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm">Page {page} of {pagination.totalPages}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page === pagination.totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            icon={TrendingUp}
            title="No income recorded"
            description="Track dividends, interest, capital gains, and other passive income."
            action={
              <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
                <Plus className="h-4 w-4" /> Add Income
              </Button>
            }
          />
        )}
      </Card>

      <IncomeModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
        income={editing}
        accounts={eligibleAccounts}
        tags={tags ?? []}
      />
    </div>
  );
}

interface IncomeModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  income: Income | null;
  accounts: Account[];
  tags: Tag[];
}

function IncomeModal({ open, onClose, onSave, income, accounts, tags }: IncomeModalProps) {
  const [saving, setSaving] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  useEffect(() => {
    if (open) setSelectedTagIds(income?.tags.map((t) => t.tagId) ?? []);
  }, [open, income]);

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
      source: form.get("source") as string,
      date: form.get("date") as string,
      accountId: form.get("accountId") as string,
      notes: (form.get("notes") as string) || undefined,
      tagIds: selectedTagIds,
    });
    setSaving(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={income ? "Edit Income" : "Add Income"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Amount</label>
          <input
            name="amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            defaultValue={income?.amount ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="0.00"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Source</label>
            <select
              name="source"
              required
              defaultValue={income?.source ?? "DIVIDENDS"}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Date</label>
            <input
              name="date"
              type="date"
              required
              defaultValue={
                income
                  ? new Date(income.date).toISOString().split("T")[0]
                  : new Date().toISOString().split("T")[0]
              }
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Account</label>
          <select
            name="accountId"
            required
            defaultValue={income?.accountId ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">Select account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
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
            defaultValue={income?.notes ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="Additional notes..."
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : income ? "Update" : "Add Income"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
