import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Plus, Pencil, TrendingUp, ChevronLeft, ChevronRight,
  ArrowUpDown, ArrowUp, ArrowDown, X, Filter, Trash2, ChevronDown,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getIncome, getAccounts, getTags, createIncome, updateIncome, deleteIncome } from "@/api";
import { formatCurrency, formatDate, toDateInputValue } from "@/lib/utils";
import type { Account, Income, IncomeSource, Tag } from "@/types";

const SOURCE_LABELS: Record<IncomeSource, string> = {
  DIVIDENDS: "Dividends",
  INTEREST: "Interest",
  CAPITAL_GAINS: "Capital Gains",
  GIFTS: "Gifts",
  OTHER: "Other",
};

const INCOME_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "INVESTMENT"];

type SortField = "date" | "source" | "account" | "amount";
type SortState = { field: SortField; order: "asc" | "desc" } | null;

// ── Currency input ──
function CurrencyInput({ name, defaultValue, required }: { name: string; defaultValue?: string; required?: boolean }) {
  const [rawValue, setRawValue] = useState(() => {
    if (!defaultValue) return "";
    const num = parseFloat(defaultValue);
    return num ? num.toFixed(2) : "";
  });

  // Sync when defaultValue changes (e.g. modal reopened with different data)
  useEffect(() => {
    if (!defaultValue) { setRawValue(""); return; }
    const num = parseFloat(defaultValue);
    setRawValue(num ? num.toFixed(2) : "");
  }, [defaultValue]);

  const numericValue = parseFloat(rawValue) || 0;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || /^\d*\.?\d{0,2}$/.test(val)) {
      setRawValue(val);
    }
  };

  const handleBlur = () => {
    if (rawValue && !isNaN(parseFloat(rawValue))) {
      setRawValue(parseFloat(rawValue).toFixed(2));
    }
  };

  return (
    <>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        <input
          type="text"
          value={rawValue}
          onChange={handleChange}
          onBlur={handleBlur}
          className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="0.00"
          inputMode="decimal"
        />
      </div>
      <input type="hidden" name={name} value={numericValue.toFixed(2)} />
      {required && numericValue === 0 && <input type="text" required value="" className="hidden" tabIndex={-1} onChange={() => {}} />}
    </>
  );
}

// ── Inline editable cell ──
function EditableCell({ value, onSave, type = "text", className = "" }: { value: string; onSave: (v: string) => void; type?: "text" | "date"; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => { setEditing(false); if (editValue !== value) onSave(editValue); };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        value={type === "date" ? toDateInputValue(editValue) : editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setEditValue(value); setEditing(false); } }}
        className="w-full rounded border border-primary px-1 py-0.5 text-sm focus:outline-none"
      />
    );
  }

  return (
    <span onClick={() => { setEditValue(value); setEditing(true); }} className={`cursor-pointer border-b border-dotted border-transparent hover:border-gray-400 ${className}`}>
      {type === "date" ? formatDate(value) : value}
    </span>
  );
}

function EditableSelectCell({ value, label, options, onSave }: { value: string; label: string; options: { id: string; name: string }[]; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);

  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  if (editing) {
    return (
      <select ref={ref} value={value} onChange={(e) => { onSave(e.target.value); setEditing(false); }} onBlur={() => setEditing(false)} className="w-full rounded border border-primary px-1 py-0.5 text-sm focus:outline-none">
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    );
  }

  return (
    <span onClick={() => setEditing(true)} className="cursor-pointer border-b border-dotted border-transparent hover:border-gray-400">{label}</span>
  );
}

// ── Inline amount cell ──
function EditableAmountCell({ value, onSave, positive }: { value: string; onSave: (v: string) => void; positive?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const startEdit = () => {
    setEditValue(parseFloat(value).toFixed(2));
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const parsed = parseFloat(editValue);
    if (isNaN(parsed) || parsed === 0) return;
    const newValue = parsed.toFixed(2);
    if (newValue !== parseFloat(value).toFixed(2)) onSave(newValue);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || /^\d*\.?\d{0,2}$/.test(val)) {
      setEditValue(val);
    }
  };

  if (editing) {
    return (
      <div className="relative">
        <span className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-sm font-semibold">$</span>
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={handleChange}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-full rounded border border-primary pl-4 pr-1 py-0.5 text-right text-sm font-semibold focus:outline-none"
          inputMode="decimal"
        />
      </div>
    );
  }

  return (
    <span onClick={startEdit} className="cursor-pointer border-b border-dotted border-transparent hover:border-gray-400">
      {positive ? "+" : "-"}{formatCurrency(value)}
    </span>
  );
}

// ═══════════════ MAIN COMPONENT ═══════════════

export function IncomePage() {
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Income | null>(null);
  const [sort, setSort] = useState<SortState>({ field: "date", order: "desc" });
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterAccountId, setFilterAccountId] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [filterTagId, setFilterTagId] = useState("");
  const [filterStartDate, setFilterStartDate] = useState("");
  const [filterEndDate, setFilterEndDate] = useState("");

  const queryParams = useMemo(() => {
    const params: Record<string, string> = { page: page.toString(), limit: "20" };
    if (sort) {
      params.sortBy = sort.field;
      params.sortOrder = sort.order;
    }
    if (filterAccountId) params.accountId = filterAccountId;
    if (filterSource) params.source = filterSource;
    if (filterTagId) params.tagId = filterTagId;
    if (filterStartDate) params.startDate = filterStartDate;
    if (filterEndDate) params.endDate = filterEndDate;
    return params;
  }, [page, sort, filterAccountId, filterSource, filterTagId, filterStartDate, filterEndDate]);

  const { data: incomeData, refetch } = useApi(() => getIncome(queryParams), [queryParams]);
  const { data: accounts } = useApi(() => getAccounts(), []);
  const { data: tags } = useApi(() => getTags(), []);

  const eligibleAccounts = (accounts ?? []).filter((a) => INCOME_ACCOUNT_TYPES.includes(a.type));
  const hasActiveFilters = !!(filterAccountId || filterSource || filterTagId || filterStartDate || filterEndDate);

  const handleSave = async (formData: Record<string, unknown>) => {
    if (editing) { await updateIncome(editing.id, formData); }
    else { await createIncome(formData); }
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const handleDelete = async (id: string) => {
    await deleteIncome(id);
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const handleInlineUpdate = useCallback(async (id: string, field: string, value: string) => {
    const data: Record<string, unknown> = {};
    if (field === "date") data.date = value;
    else if (field === "amount") data.amount = parseFloat(value);
    else data[field] = value;
    await updateIncome(id, data);
    refetch();
  }, [refetch]);

  const toggleSort = (field: SortField) => {
    setSort((prev) => {
      const defaultDesc = field === "date" || field === "amount";
      const first = defaultDesc ? "desc" : "asc";
      const second = defaultDesc ? "asc" : "desc";
      if (!prev || prev.field !== field) return { field, order: first };
      if (prev.order === first) return { field, order: second };
      return null;
    });
    setPage(1);
  };

  const clearFilters = () => {
    setFilterAccountId(""); setFilterSource(""); setFilterTagId(""); setFilterStartDate(""); setFilterEndDate(""); setPage(1);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (!sort || sort.field !== field) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    return sort.order === "asc" ? <ArrowUp className="ml-1 inline h-3 w-3" /> : <ArrowDown className="ml-1 inline h-3 w-3" />;
  };

  const incomes = incomeData?.data ?? [];
  const pagination = incomeData?.pagination;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Income</h2>
        <div className="flex gap-2">
          <Button variant={filterOpen ? "primary" : "secondary"} size="sm" onClick={() => setFilterOpen(!filterOpen)}>
            <Filter className="h-4 w-4" />
            {hasActiveFilters && <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 text-xs">!</span>}
          </Button>
          <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
            <Plus className="h-4 w-4" /> Add Income
          </Button>
        </div>
      </div>

      {filterOpen && (
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Account</label>
              <select value={filterAccountId} onChange={(e) => { setFilterAccountId(e.target.value); setPage(1); }} className="rounded-md border border-border px-2 py-1.5 text-sm">
                <option value="">All accounts</option>
                {eligibleAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Source</label>
              <select value={filterSource} onChange={(e) => { setFilterSource(e.target.value); setPage(1); }} className="rounded-md border border-border px-2 py-1.5 text-sm">
                <option value="">All sources</option>
                {Object.entries(SOURCE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Tag</label>
              <select value={filterTagId} onChange={(e) => { setFilterTagId(e.target.value); setPage(1); }} className="rounded-md border border-border px-2 py-1.5 text-sm">
                <option value="">All tags</option>
                {(tags ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
              <input type="date" value={filterStartDate} onChange={(e) => { setFilterStartDate(e.target.value); setPage(1); }} className="rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">To</label>
              <input type="date" value={filterEndDate} onChange={(e) => { setFilterEndDate(e.target.value); setPage(1); }} className="rounded-md border border-border px-2 py-1.5 text-sm" />
            </div>
            {hasActiveFilters && (
              <button onClick={clearFilters} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /> Clear</button>
            )}
          </div>
        </Card>
      )}

      <Card>
        {incomes.length > 0 ? (
          <>
            <div className="hidden md:block">
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="w-[70px] cursor-pointer select-none pb-3 pr-3 font-medium" onClick={() => toggleSort("date")}>Date <SortIcon field="date" /></th>
                    <th className="w-[130px] cursor-pointer select-none pb-3 pr-3 font-medium" onClick={() => toggleSort("source")}>Source <SortIcon field="source" /></th>
                    <th className="w-[170px] cursor-pointer select-none pb-3 pr-3 font-medium" onClick={() => toggleSort("account")}>Account <SortIcon field="account" /></th>
                    <th className="pb-3 pr-3 font-medium">Tags</th>
                    <th className="w-[30px] pb-3"></th>
                    <th className="w-[100px] cursor-pointer select-none pb-3 text-right font-medium" onClick={() => toggleSort("amount")}>Amount <SortIcon field="amount" /></th>
                    <th className="w-[40px] pb-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {incomes.map((income) => (
                    <tr key={income.id} className="hover:bg-muted/50">
                      <td className="w-[70px] py-3 pr-3">
                        <EditableCell value={income.date} type="date" onSave={(v) => handleInlineUpdate(income.id, "date", v)} />
                      </td>
                      <td className="w-[130px] py-3 pr-3">
                        <EditableSelectCell
                          value={income.source}
                          label={SOURCE_LABELS[income.source]}
                          options={Object.entries(SOURCE_LABELS).map(([id, name]) => ({ id, name }))}
                          onSave={(v) => handleInlineUpdate(income.id, "source", v)}
                        />
                      </td>
                      <td className="w-[170px] py-3 pr-3">
                        <EditableSelectCell
                          value={income.accountId}
                          label={income.account.name}
                          options={eligibleAccounts.map((a) => ({ id: a.id, name: a.name }))}
                          onSave={(v) => handleInlineUpdate(income.id, "accountId", v)}
                        />
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {income.tags.map(({ tag }) => (
                            <span key={tag.id} className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: tag.color ? `${tag.color}20` : "hsl(var(--muted))", color: tag.color ?? "inherit" }}>
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="w-[30px] py-3 text-center">
                        <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white ${income.account.isJoint ? "bg-blue-500" : "bg-gray-400"}`}>
                          {income.account.isJoint ? "J" : "P"}
                        </span>
                      </td>
                      <td className="w-[100px] py-3 text-right font-semibold text-green-600">
                        <EditableAmountCell
                          value={income.amount}
                          positive
                          onSave={(v) => handleInlineUpdate(income.id, "amount", v)}
                        />
                      </td>
                      <td className="w-[40px] py-3 text-right">
                        <button onClick={() => { setEditing(income); setModalOpen(true); }} className="rounded p-1 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent">
                          <Pencil className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-border md:hidden">
              {incomes.map((income) => (
                <div key={income.id} className="flex items-center justify-between py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{SOURCE_LABELS[income.source]}</p>
                    <p className="text-sm text-muted-foreground">{income.account.name} &middot; {formatDate(income.date)}</p>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <span className="font-semibold text-green-600">+{formatCurrency(income.amount)}</span>
                    <button onClick={() => { setEditing(income); setModalOpen(true); }} className="rounded p-1 hover:bg-accent"><Pencil className="h-4 w-4 text-muted-foreground" /></button>
                  </div>
                </div>
              ))}
            </div>

            {pagination && pagination.totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
                <p className="text-sm text-muted-foreground">{pagination.total} entr{pagination.total !== 1 ? "ies" : "y"}</p>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                  <span className="text-sm">Page {page} of {pagination.totalPages}</span>
                  <Button variant="ghost" size="sm" disabled={page === pagination.totalPages} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <EmptyState
            icon={TrendingUp}
            title="No income recorded"
            description={hasActiveFilters ? "No income entries match your current filters." : "Track dividends, interest, capital gains, and other passive income."}
            action={
              hasActiveFilters
                ? <Button variant="secondary" onClick={clearFilters}>Clear Filters</Button>
                : <Button onClick={() => { setEditing(null); setModalOpen(true); }}><Plus className="h-4 w-4" /> Add Income</Button>
            }
          />
        )}
      </Card>

      <IncomeModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
        onDelete={handleDelete}
        income={editing}
        accounts={eligibleAccounts}
        tags={tags ?? []}
      />
    </div>
  );
}

// ── Modal ──
interface IncomeModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  income: Income | null;
  accounts: Account[];
  tags: Tag[];
}

function IncomeModal({ open, onClose, onSave, onDelete, income, accounts, tags }: IncomeModalProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showOptional, setShowOptional] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedTagIds(income?.tags.map((t) => t.tagId) ?? []);
      setConfirmDelete(false);
      setShowOptional(!!income?.notes);
    }
  }, [open, income]);

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) => prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]);
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

  const handleDeleteClick = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    if (!income) return;
    setDeleting(true);
    await onDelete(income.id);
    setDeleting(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={income ? "Edit Income" : "Add Income"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Amount</label>
          <CurrencyInput name="amount" defaultValue={income?.amount} required />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Source</label>
            <select name="source" required defaultValue={income?.source ?? "DIVIDENDS"} className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary">
              {Object.entries(SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Date</label>
            <input name="date" type="date" required defaultValue={toDateInputValue(income?.date)} className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Account</label>
          <select name="accountId" required defaultValue={income?.accountId ?? ""} className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary">
            <option value="">Select account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>

        {tags.length > 0 && (
          <div>
            <label className="mb-2 block text-sm font-medium">Tags</label>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const selected = selectedTagIds.includes(tag.id);
                return (
                  <button key={tag.id} type="button" onClick={() => toggleTag(tag.id)} className="rounded-full border px-3 py-1 text-xs font-medium transition-colors" style={selected && tag.color ? { backgroundColor: tag.color, borderColor: tag.color, color: "#fff" } : selected ? { backgroundColor: "hsl(var(--primary))", borderColor: "hsl(var(--primary))", color: "#fff" } : {}}>
                    {tag.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Collapsible optional section */}
        <div className="border-t border-border pt-3">
          <button type="button" onClick={() => setShowOptional(!showOptional)} className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
            {showOptional ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            More options
          </button>
          {showOptional && (
            <div className="mt-3">
              <label className="mb-1 block text-sm font-medium">Notes</label>
              <textarea name="notes" rows={2} defaultValue={income?.notes ?? ""} className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" placeholder="Additional notes..." />
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <div>
            {income && (
              <button type="button" onClick={handleDeleteClick} disabled={deleting} className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors">
                <Trash2 className="h-4 w-4" />
                {deleting ? "Deleting..." : confirmDelete ? "Confirm Delete" : "Delete"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving..." : income ? "Update" : "Add Income"}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
