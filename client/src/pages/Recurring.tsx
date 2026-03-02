import { useState } from "react";
import { Plus, Trash2, Repeat, Play } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import {
  getRecurrenceRules, createRecurrenceRule, deleteRecurrenceRule,
  processRecurringExpenses, getAccounts, getFlatCategories,
} from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Category, Account } from "@/types";

const frequencyLabels: Record<string, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  BIWEEKLY: "Biweekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  YEARLY: "Yearly",
};

export function Recurring() {
  const [modalOpen, setModalOpen] = useState(false);
  const [processing, setProcessing] = useState(false);

  const { data: rules, refetch } = useApi(() => getRecurrenceRules(), []);
  const { data: categories } = useApi(() => getFlatCategories(), []);
  const { data: accounts } = useApi(() => getAccounts(), []);

  const handleCreate = async (data: Record<string, unknown>) => {
    await createRecurrenceRule(data);
    setModalOpen(false);
    refetch();
  };

  const handleDelete = async (id: string) => {
    if (confirm("Delete this recurring rule?")) {
      await deleteRecurrenceRule(id);
      refetch();
    }
  };

  const handleProcess = async () => {
    setProcessing(true);
    try {
      const result = await processRecurringExpenses();
      alert(`Processed ${result.processed} recurring expense(s).`);
      refetch();
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Recurring Expenses</h2>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={handleProcess} disabled={processing}>
            <Play className="h-4 w-4" /> {processing ? "Processing..." : "Process Due"}
          </Button>
          <Button onClick={() => setModalOpen(true)}>
            <Plus className="h-4 w-4" /> Add Rule
          </Button>
        </div>
      </div>

      <Card>
        {rules && rules.length > 0 ? (
          <div className="divide-y divide-border">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">{rule.description}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatCurrency(rule.amount)} &middot; {frequencyLabels[rule.frequency]}
                    {rule.interval > 1 ? ` (every ${rule.interval})` : ""}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Next: {formatDate(rule.nextOccurrence)}
                    {rule.endDate ? ` &middot; Ends: ${formatDate(rule.endDate)}` : ""}
                  </p>
                </div>
                <button onClick={() => handleDelete(rule.id)} className="rounded p-1 hover:bg-accent">
                  <Trash2 className="h-4 w-4 text-destructive" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Repeat}
            title="No recurring expenses"
            description="Set up recurring rules for rent, subscriptions, and other regular expenses."
            action={
              <Button onClick={() => setModalOpen(true)}>
                <Plus className="h-4 w-4" /> Add Rule
              </Button>
            }
          />
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How it works</CardTitle>
        </CardHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>1. Create a recurring rule with the amount, frequency, and category.</p>
          <p>2. Click "Process Due" to generate expense entries for any rules that are due.</p>
          <p>3. The system will automatically advance the next occurrence date after processing.</p>
        </div>
      </Card>

      <RecurrenceModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleCreate}
        categories={categories ?? []}
        accounts={accounts ?? []}
      />
    </div>
  );
}

interface RecurrenceModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  categories: Category[];
  accounts: Account[];
}

function RecurrenceModal({ open, onClose, onSave, categories, accounts }: RecurrenceModalProps) {
  const [saving, setSaving] = useState(false);

  const parentCategories = categories.filter((c) => !c.parentId);
  const childCategories = categories.filter((c) => c.parentId);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);
    await onSave({
      description: form.get("description") as string,
      amount: parseFloat(form.get("amount") as string),
      frequency: form.get("frequency") as string,
      interval: parseInt(form.get("interval") as string) || 1,
      startDate: form.get("startDate") as string,
      endDate: (form.get("endDate") as string) || undefined,
      categoryId: form.get("categoryId") as string,
      accountId: form.get("accountId") as string,
    });
    setSaving(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Add Recurring Expense">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="mb-1 block text-sm font-medium">Description</label>
            <input
              name="description"
              type="text"
              required
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="e.g. Monthly rent"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Amount</label>
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              required
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Frequency</label>
            <select
              name="frequency"
              required
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {Object.entries(frequencyLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Start Date</label>
            <input
              name="startDate"
              type="date"
              required
              defaultValue={new Date().toISOString().split("T")[0]}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">End Date (optional)</label>
            <input
              name="endDate"
              type="date"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Category</label>
            <select
              name="categoryId"
              required
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Select</option>
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

          <div>
            <label className="mb-1 block text-sm font-medium">Account</label>
            <select
              name="accountId"
              required
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Select</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Interval</label>
            <input
              name="interval"
              type="number"
              min="1"
              defaultValue="1"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Create Rule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
