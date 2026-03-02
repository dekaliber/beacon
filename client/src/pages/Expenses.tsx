import { useState, useEffect, useMemo } from "react";
import {
  Plus, Pencil, Receipt, ChevronLeft, ChevronRight, AlertCircle,
  ArrowUpDown, ArrowUp, ArrowDown, X, Filter, ChevronDown, Trash2, Repeat,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import {
  getExpenses, getAccounts, getFlatCategories, getTags,
  createExpense, updateExpense, deleteExpense,
  createRecurrenceRule, getTransactionGroups,
} from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Expense, Category, Account, Tag, TransactionGroup } from "@/types";

const EXPENSE_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CREDIT_CARD", "CASH"];

const FREQUENCY_LABELS: Record<string, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  BIWEEKLY: "Biweekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  YEARLY: "Yearly",
};

type SortField = "date" | "description" | "vendor" | "category" | "account" | "amount";

export function Expenses() {
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [sortBy, setSortBy] = useState<SortField>("date");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterAccountId, setFilterAccountId] = useState("");
  const [filterCategoryId, setFilterCategoryId] = useState("");
  const [filterTagId, setFilterTagId] = useState("");
  const [filterStartDate, setFilterStartDate] = useState("");
  const [filterEndDate, setFilterEndDate] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const queryParams = useMemo(() => {
    const params: Record<string, string> = {
      page: page.toString(),
      limit: "20",
      sortBy,
      sortOrder,
    };
    if (filterAccountId) params.accountId = filterAccountId;
    if (filterCategoryId) params.categoryId = filterCategoryId;
    if (filterTagId) params.tagId = filterTagId;
    if (filterStartDate) params.startDate = filterStartDate;
    if (filterEndDate) params.endDate = filterEndDate;
    return params;
  }, [page, sortBy, sortOrder, filterAccountId, filterCategoryId, filterTagId, filterStartDate, filterEndDate]);

  const { data: expenseData, refetch } = useApi(() => getExpenses(queryParams), [queryParams]);
  const { data: categories } = useApi(() => getFlatCategories(), []);
  const { data: accounts } = useApi(() => getAccounts(), []);
  const { data: tags } = useApi(() => getTags(), []);
  const { data: groups } = useApi(() => getTransactionGroups(), []);

  const eligibleAccounts = (accounts ?? []).filter((a) => EXPENSE_ACCOUNT_TYPES.includes(a.type));
  const hasActiveFilters = !!(filterAccountId || filterCategoryId || filterTagId || filterStartDate || filterEndDate);

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
    await deleteExpense(id);
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const openEdit = (expense: Expense) => {
    setEditing(expense);
    setModalOpen(true);
  };

  const toggleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(field);
      setSortOrder(field === "date" || field === "amount" ? "desc" : "asc");
    }
    setPage(1);
  };

  const clearFilters = () => {
    setFilterAccountId("");
    setFilterCategoryId("");
    setFilterTagId("");
    setFilterStartDate("");
    setFilterEndDate("");
    setPage(1);
  };

  const toggleGroupCollapse = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortBy !== field) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    return sortOrder === "asc"
      ? <ArrowUp className="ml-1 inline h-3 w-3" />
      : <ArrowDown className="ml-1 inline h-3 w-3" />;
  };

  const expenses = expenseData?.data ?? [];
  const pagination = expenseData?.pagination;

  // Group expenses by transactionGroupId for collapsible display
  const { groupedRows, groupMap } = useMemo(() => {
    const gMap = new Map<string, Expense[]>();
    for (const e of expenses) {
      if (e.transactionGroupId) {
        const arr = gMap.get(e.transactionGroupId) ?? [];
        arr.push(e);
        gMap.set(e.transactionGroupId, arr);
      }
    }
    // Build ordered rows: maintain original order, but when we encounter a group for the first time,
    // insert the group header + members
    const seenGroups = new Set<string>();
    const rows: Array<{ type: "expense"; expense: Expense } | { type: "group-header"; groupId: string; expenses: Expense[] }> = [];
    for (const e of expenses) {
      if (e.transactionGroupId) {
        if (!seenGroups.has(e.transactionGroupId)) {
          seenGroups.add(e.transactionGroupId);
          const groupExpenses = gMap.get(e.transactionGroupId)!;
          rows.push({ type: "group-header", groupId: e.transactionGroupId, expenses: groupExpenses });
        }
      } else {
        rows.push({ type: "expense", expense: e });
      }
    }
    // Build a lookup from group id to group name
    const groupLookup = new Map<string, TransactionGroup>();
    for (const g of (groups ?? [])) {
      groupLookup.set(g.id, g);
    }
    return { groupedRows: rows, groupMap: groupLookup };
  }, [expenses, groups]);

  const parentCategories = (categories ?? []).filter((c) => !c.parentId);
  const childCategories = (categories ?? []).filter((c) => c.parentId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Expenses</h2>
        <div className="flex gap-2">
          <Button
            variant={filterOpen ? "primary" : "secondary"}
            size="sm"
            onClick={() => setFilterOpen(!filterOpen)}
          >
            <Filter className="h-4 w-4" />
            {hasActiveFilters && <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 text-xs">!</span>}
          </Button>
          <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
            <Plus className="h-4 w-4" /> Add Expense
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      {filterOpen && (
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Account</label>
              <select
                value={filterAccountId}
                onChange={(e) => { setFilterAccountId(e.target.value); setPage(1); }}
                className="rounded-md border border-border px-2 py-1.5 text-sm"
              >
                <option value="">All accounts</option>
                {eligibleAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
              <select
                value={filterCategoryId}
                onChange={(e) => { setFilterCategoryId(e.target.value); setPage(1); }}
                className="rounded-md border border-border px-2 py-1.5 text-sm"
              >
                <option value="">All categories</option>
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
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Tag</label>
              <select
                value={filterTagId}
                onChange={(e) => { setFilterTagId(e.target.value); setPage(1); }}
                className="rounded-md border border-border px-2 py-1.5 text-sm"
              >
                <option value="">All tags</option>
                {(tags ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
              <input
                type="date"
                value={filterStartDate}
                onChange={(e) => { setFilterStartDate(e.target.value); setPage(1); }}
                className="rounded-md border border-border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">To</label>
              <input
                type="date"
                value={filterEndDate}
                onChange={(e) => { setFilterEndDate(e.target.value); setPage(1); }}
                className="rounded-md border border-border px-2 py-1.5 text-sm"
              />
            </div>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            )}
          </div>
        </Card>
      )}

      <Card>
        {expenses.length > 0 ? (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="cursor-pointer select-none pb-3 font-medium" onClick={() => toggleSort("date")}>
                      Date <SortIcon field="date" />
                    </th>
                    <th className="cursor-pointer select-none pb-3 font-medium" onClick={() => toggleSort("description")}>
                      Description <SortIcon field="description" />
                    </th>
                    <th className="cursor-pointer select-none pb-3 font-medium" onClick={() => toggleSort("vendor")}>
                      Vendor <SortIcon field="vendor" />
                    </th>
                    <th className="cursor-pointer select-none pb-3 font-medium" onClick={() => toggleSort("category")}>
                      Category <SortIcon field="category" />
                    </th>
                    <th className="cursor-pointer select-none pb-3 font-medium" onClick={() => toggleSort("account")}>
                      Account <SortIcon field="account" />
                    </th>
                    <th className="cursor-pointer select-none pb-3 text-right font-medium" onClick={() => toggleSort("amount")}>
                      Amount <SortIcon field="amount" />
                    </th>
                    <th className="pb-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groupedRows.map((row) => {
                    if (row.type === "expense") {
                      return <ExpenseRow key={row.expense.id} expense={row.expense} onEdit={openEdit} />;
                    }
                    const group = groupMap.get(row.groupId);
                    const collapsed = collapsedGroups.has(row.groupId);
                    const firstByDate = [...row.expenses].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())[0];
                    return (
                      <GroupRows
                        key={`grp-${row.groupId}`}
                        groupName={group?.name ?? "Unnamed Group"}
                        expenses={row.expenses}
                        collapsed={collapsed}
                        onToggle={() => toggleGroupCollapse(row.groupId)}
                        onEdit={openEdit}
                        firstExpense={firstByDate}
                      />
                    );
                  })}
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
                        {expense.vendor && <>{expense.vendor} &middot; </>}
                        {expense.category.name} &middot; {formatDate(expense.date)}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <span className="font-semibold text-destructive">-{formatCurrency(expense.amount)}</span>
                    <button onClick={() => openEdit(expense)} className="rounded p-1 hover:bg-accent">
                      <Pencil className="h-4 w-4 text-muted-foreground" />
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
            description={hasActiveFilters
              ? "No expenses match your current filters. Try adjusting or clearing them."
              : "Start tracking your spending by adding your first expense."
            }
            action={
              hasActiveFilters
                ? <Button variant="secondary" onClick={clearFilters}>Clear Filters</Button>
                : <Button onClick={() => { setEditing(null); setModalOpen(true); }}><Plus className="h-4 w-4" /> Add Expense</Button>
            }
          />
        )}
      </Card>

      <ExpenseModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
        onDelete={handleDelete}
        expense={editing}
        categories={categories ?? []}
        accounts={eligibleAccounts}
        tags={tags ?? []}
      />
    </div>
  );
}

function ExpenseRow({ expense, onEdit }: { expense: Expense; onEdit: (e: Expense) => void }) {
  return (
    <tr className={expense.isReimbursementExpected ? "bg-amber-50/50 hover:bg-amber-50" : "hover:bg-muted/50"}>
      <td className="py-3">{formatDate(expense.date)}</td>
      <td className="py-3">
        <div className="flex items-center gap-2">
          {expense.isReimbursementExpected && (
            <AlertCircle className="h-4 w-4 flex-shrink-0 text-amber-500" title={expense.reimbursementNote ?? "Reimbursement expected"} />
          )}
          {expense.recurrenceRuleId && (
            <Repeat className="h-3.5 w-3.5 flex-shrink-0 text-blue-500" title="Recurring expense" />
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
      <td className="py-3 text-muted-foreground">{expense.vendor}</td>
      <td className="py-3">{expense.category.name}</td>
      <td className="py-3">{expense.account.name}</td>
      <td className="py-3 text-right font-semibold text-destructive">-{formatCurrency(expense.amount)}</td>
      <td className="py-3 text-right">
        <button onClick={() => onEdit(expense)} className="rounded p-1 hover:bg-accent">
          <Pencil className="h-4 w-4 text-muted-foreground" />
        </button>
      </td>
    </tr>
  );
}

function GroupRows({
  groupName, expenses, collapsed, onToggle, onEdit, firstExpense,
}: {
  groupName: string;
  expenses: Expense[];
  collapsed: boolean;
  onToggle: () => void;
  onEdit: (e: Expense) => void;
  firstExpense: Expense;
}) {
  const totalAmount = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);

  if (collapsed) {
    return (
      <tr className="bg-muted/30 hover:bg-muted/50">
        <td className="py-3">{formatDate(firstExpense.date)}</td>
        <td className="py-3">
          <button onClick={onToggle} className="flex items-center gap-1.5 font-medium text-primary">
            <ChevronRight className="h-3.5 w-3.5" />
            {groupName}
            <span className="text-xs font-normal text-muted-foreground">({expenses.length} items)</span>
          </button>
        </td>
        <td className="py-3 text-muted-foreground">{firstExpense.vendor}</td>
        <td className="py-3">{firstExpense.category.name}</td>
        <td className="py-3">{firstExpense.account.name}</td>
        <td className="py-3 text-right font-semibold text-destructive">-{formatCurrency(totalAmount)}</td>
        <td className="py-3 text-right">
          <button onClick={() => onEdit(firstExpense)} className="rounded p-1 hover:bg-accent">
            <Pencil className="h-4 w-4 text-muted-foreground" />
          </button>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr className="bg-muted/30">
        <td colSpan={7} className="py-2">
          <button onClick={onToggle} className="flex items-center gap-1.5 font-medium text-primary text-sm">
            <ChevronDown className="h-3.5 w-3.5" />
            {groupName}
            <span className="text-xs font-normal text-muted-foreground">
              ({expenses.length} items &middot; total: -{formatCurrency(totalAmount)})
            </span>
          </button>
        </td>
      </tr>
      {expenses.map((expense) => (
        <ExpenseRow key={expense.id} expense={expense} onEdit={onEdit} />
      ))}
    </>
  );
}

interface ExpenseModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  expense: Expense | null;
  categories: Category[];
  accounts: Account[];
  tags: Tag[];
}

function ExpenseModal({ open, onClose, onSave, onDelete, expense, categories, accounts, tags }: ExpenseModalProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isReimbursementExpected, setIsReimbursementExpected] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedTagIds(expense?.tags.map((t) => t.tagId) ?? []);
      setIsReimbursementExpected(expense?.isReimbursementExpected ?? false);
      setIsRecurring(false);
      setConfirmDelete(false);
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

    const expenseData: Record<string, unknown> = {
      amount: parseFloat(form.get("amount") as string),
      description: form.get("description") as string,
      vendor: form.get("vendor") as string,
      date: form.get("date") as string,
      categoryId: form.get("categoryId") as string,
      accountId: form.get("accountId") as string,
      notes: (form.get("notes") as string) || undefined,
      isReimbursementExpected,
      reimbursementNote: isReimbursementExpected
        ? (form.get("reimbursementNote") as string) || undefined
        : null,
      tagIds: selectedTagIds,
    };

    await onSave(expenseData);

    // If recurring is toggled on for a new expense, also create a recurrence rule
    if (!expense && isRecurring) {
      try {
        await createRecurrenceRule({
          description: form.get("description") as string,
          vendor: form.get("vendor") as string,
          amount: parseFloat(form.get("amount") as string),
          frequency: form.get("frequency") as string,
          interval: parseInt(form.get("interval") as string) || 1,
          startDate: form.get("date") as string,
          endDate: (form.get("endDate") as string) || undefined,
          categoryId: form.get("categoryId") as string,
          accountId: form.get("accountId") as string,
        });
      } catch {
        // Expense was created but rule failed
      }
    }

    setSaving(false);
  };

  const handleDeleteClick = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (!expense) return;
    setDeleting(true);
    await onDelete(expense.id);
    setDeleting(false);
  };

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

        <div>
          <label className="mb-1 block text-sm font-medium">Vendor</label>
          <input
            name="vendor"
            type="text"
            required
            defaultValue={expense?.vendor ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. Amazon, Whole Foods, Netflix"
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

        {/* Recurring expense toggle — only for new expenses */}
        {!expense && (
          <div className="rounded-md border border-border p-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={isRecurring}
                onChange={(e) => setIsRecurring(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span className="text-sm font-medium">Recurring expense</span>
            </label>
            {isRecurring && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Frequency</label>
                  <select
                    name="frequency"
                    defaultValue="MONTHLY"
                    className="w-full rounded-md border border-border px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {Object.entries(FREQUENCY_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Interval</label>
                  <input
                    name="interval"
                    type="number"
                    min="1"
                    defaultValue="1"
                    className="w-full rounded-md border border-border px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">End Date (optional)</label>
                  <input
                    name="endDate"
                    type="date"
                    className="w-full rounded-md border border-border px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <div>
            {expense && (
              <button
                type="button"
                onClick={handleDeleteClick}
                disabled={deleting}
                className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "Deleting..." : confirmDelete ? "Confirm Delete" : "Delete"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : expense ? "Update" : "Add Expense"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
