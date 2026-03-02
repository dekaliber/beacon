import { useState } from "react";
import { Trash2, Repeat, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getRecurrenceRules, deleteRecurrenceRule } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";

const frequencyLabels: Record<string, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  BIWEEKLY: "Biweekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  YEARLY: "Yearly",
};

export function Recurring() {
  const { data: rules, refetch } = useApi(() => getRecurrenceRules(), []);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const handleDelete = async (id: string) => {
    if (confirm("Delete this recurring rule? Future expenses will no longer be generated from it.")) {
      await deleteRecurrenceRule(id);
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
      <div>
        <h2 className="text-2xl font-bold">Recurring Expenses</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Recurring expenses are created from the Add Expense form. This page shows all active recurring rules.
        </p>
      </div>

      <Card>
        {rules && rules.length > 0 ? (
          <div className="divide-y divide-border">
            {rules.map((rule) => {
              const expanded = expandedIds.has(rule.id);
              return (
                <div key={rule.id} className="py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <button onClick={() => toggleExpand(rule.id)} className="rounded p-0.5 hover:bg-accent">
                        {expanded
                          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        }
                      </button>
                      <div>
                        <p className="font-medium">{rule.description}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatCurrency(rule.amount)} &middot; {frequencyLabels[rule.frequency]}
                          {rule.interval > 1 ? ` (every ${rule.interval})` : ""}
                        </p>
                      </div>
                    </div>
                    <button onClick={() => handleDelete(rule.id)} className="rounded p-1 hover:bg-accent">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </button>
                  </div>
                  {expanded && (
                    <div className="ml-8 mt-2 space-y-1 text-sm text-muted-foreground">
                      <p>Next occurrence: {formatDate(rule.nextOccurrence)}</p>
                      <p>Started: {formatDate(rule.startDate)}</p>
                      {rule.endDate && <p>Ends: {formatDate(rule.endDate)}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={Repeat}
            title="No recurring expenses"
            description="Create a recurring expense by toggling 'Recurring expense' when adding a new expense."
          />
        )}
      </Card>
    </div>
  );
}
