import { useState } from "react";
import { Plus, Trash2, Pencil, Link2, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import {
  getTransactionGroups,
  createTransactionGroup,
  updateTransactionGroup,
  deleteTransactionGroup,
} from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { TransactionGroup } from "@/types";

export function TransactionGroupsPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<TransactionGroup | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const { data: groups, refetch } = useApi(() => getTransactionGroups(), []);

  const handleSave = async (data: { name: string; notes?: string }) => {
    if (editing) {
      await updateTransactionGroup(editing.id, data);
    } else {
      await createTransactionGroup(data);
    }
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const handleDelete = async (id: string) => {
    if (confirm("Delete this group? The linked transactions will not be deleted.")) {
      await deleteTransactionGroup(id);
      refetch();
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Transaction Groups</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Link related transactions that offset each other — refunds, reimbursements, joint expenses, and transfers.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus className="h-4 w-4" /> New Group
        </Button>
      </div>

      <div className="space-y-4">
        {groups && groups.length > 0 ? (
          groups.map((group) => {
            const expenses = group.expenses ?? [];
            const incomes = group.incomes ?? [];
            const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);
            const totalIncome = incomes.reduce((sum, i) => sum + parseFloat(i.amount), 0);
            const net = totalIncome - totalExpenses;
            const expanded = expandedIds.has(group.id);

            return (
              <Card key={group.id}>
                <div className="flex items-start justify-between">
                  <div className="flex flex-1 items-start gap-3">
                    <button
                      onClick={() => toggleExpand(group.id)}
                      className="mt-0.5 rounded p-0.5 hover:bg-accent"
                    >
                      {expanded
                        ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      }
                    </button>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold">{group.name}</p>
                        <span className="text-xs text-muted-foreground">
                          {expenses.length + incomes.length} transaction{expenses.length + incomes.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      {group.notes && (
                        <p className="mt-0.5 text-sm text-muted-foreground">{group.notes}</p>
                      )}
                      <div className="mt-2 flex gap-4 text-sm">
                        {expenses.length > 0 && (
                          <span className="text-destructive">
                            -{formatCurrency(totalExpenses)} expenses
                          </span>
                        )}
                        {incomes.length > 0 && (
                          <span className="text-green-600">
                            +{formatCurrency(totalIncome)} income
                          </span>
                        )}
                        {expenses.length > 0 && incomes.length > 0 && (
                          <span className={net >= 0 ? "text-green-600 font-medium" : "text-destructive font-medium"}>
                            Net: {net >= 0 ? "+" : ""}{formatCurrency(Math.abs(net))}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => { setEditing(group); setModalOpen(true); }}
                      className="rounded p-1 hover:bg-accent"
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </button>
                    <button onClick={() => handleDelete(group.id)} className="rounded p-1 hover:bg-accent">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </button>
                  </div>
                </div>

                {expanded && (expenses.length > 0 || incomes.length > 0) && (
                  <div className="mt-4 border-t border-border pt-4">
                    <table className="w-full text-sm">
                      <tbody className="divide-y divide-border">
                        {expenses.map((e) => (
                          <tr key={`e-${e.id}`}>
                            <td className="py-2 text-muted-foreground">{formatDate(e.date)}</td>
                            <td className="py-2">{e.description}</td>
                            <td className="py-2 text-muted-foreground">{e.category?.name}</td>
                            <td className="py-2 text-muted-foreground">{e.account?.name}</td>
                            <td className="py-2 text-right text-destructive">
                              -{formatCurrency(e.amount)}
                            </td>
                          </tr>
                        ))}
                        {incomes.map((i) => (
                          <tr key={`i-${i.id}`}>
                            <td className="py-2 text-muted-foreground">{formatDate(i.date)}</td>
                            <td className="py-2">{i.source}</td>
                            <td className="py-2 text-muted-foreground"></td>
                            <td className="py-2 text-muted-foreground">{i.account?.name}</td>
                            <td className="py-2 text-right text-green-600">
                              +{formatCurrency(i.amount)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })
        ) : (
          <Card>
            <EmptyState
              icon={Link2}
              title="No transaction groups"
              description="Group related transactions that offset each other — refunds, reimbursements, joint expenses, and account transfers."
              action={
                <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
                  <Plus className="h-4 w-4" /> New Group
                </Button>
              }
            />
          </Card>
        )}
      </div>

      <GroupModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
        group={editing}
      />
    </div>
  );
}

interface GroupModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name: string; notes?: string }) => Promise<void>;
  group: TransactionGroup | null;
}

function GroupModal({ open, onClose, onSave, group }: GroupModalProps) {
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    await onSave({
      name: form.get("name") as string,
      notes: (form.get("notes") as string) || undefined,
    });
    setSaving(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={group ? "Edit Group" : "New Transaction Group"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Group Name</label>
          <input
            name="name"
            type="text"
            required
            defaultValue={group?.name ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. Dinner reimbursement, Joint expense Mar 2026"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Notes (optional)</label>
          <textarea
            name="notes"
            rows={2}
            defaultValue={group?.notes ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="Context about why these transactions are linked..."
          />
        </div>

        <p className="text-xs text-muted-foreground">
          After creating the group, link transactions to it from the Expenses or Income pages.
        </p>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : group ? "Update" : "Create Group"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
