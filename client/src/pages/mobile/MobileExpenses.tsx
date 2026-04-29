import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Plus, X, ChevronDown, ChevronRight, AlertCircle, Check, CornerDownRight, ArrowUp, Trash2, Calendar, Search, Filter, Tag as TagIcon } from "lucide-react";
import { PageHeadingMenu } from "@/components/PageHeadingMenu";
import { useApi } from "@/hooks/useApi";
import { getExpenses, getAccounts, getFlatCategories, createExpense, updateExpense, deleteExpense, getExpenseVendors, getTags, createTag, createRecurrenceRule } from "@/api";
import { formatCurrency, formatDate, localToday, cn } from "@/lib/utils";
import type { Account, Category, Expense, Tag } from "@/types";

const EXPENSE_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CREDIT_CARD", "CASH"];

const FREQUENCY_OPTIONS = [
  { value: "DAILY",   singular: "day",   plural: "days"   },
  { value: "WEEKLY",  singular: "week",  plural: "weeks"  },
  { value: "MONTHLY", singular: "month", plural: "months" },
  { value: "YEARLY",  singular: "year",  plural: "years"  },
];

// ── Vendor input with suggestions ─────────────────────────────────────────────

function VendorInput({ vendors, initialValue = "" }: { vendors: string[]; initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const suggestions = useMemo(() => {
    if (!value.trim()) return [];
    const terms = value.toLowerCase().split(/\s+/);
    return vendors.filter((v) => {
      const words = v.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    }).slice(0, 8);
  }, [value, vendors]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <input
        name="vendor"
        type="text"
        value={value}
        autoComplete="off"
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        placeholder="Store or merchant name"
        className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
      />
      {open && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-background shadow-md">
          {suggestions.map((vendor) => (
            <button
              key={vendor}
              type="button"
              className="flex w-full items-center px-3 py-2.5 text-left text-sm hover:bg-accent"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setValue(vendor); setOpen(false); }}
            >
              {vendor}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Category picker with search ───────────────────────────────────────────────

function CategoryPicker({ categories, initialId = "" }: { categories: Category[]; initialId?: string }) {
  const [selectedId, setSelectedId] = useState(initialId);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Mirror desktop flatOptions logic: parents with no children appear directly;
  // parents with children are expanded into child entries carrying parentLabel.
  const flatOptions = useMemo(() => {
    const parents = categories.filter((c) => !c.parentId);
    const children = categories.filter((c) => c.parentId);
    const opts: { id: string; label: string; parentLabel?: string }[] = [];
    for (const parent of parents) {
      const kids = children.filter((c) => c.parentId === parent.id);
      if (kids.length === 0) {
        opts.push({ id: parent.id, label: parent.name });
      } else {
        for (const child of kids) {
          opts.push({ id: child.id, label: child.name, parentLabel: parent.name });
        }
      }
    }
    return opts;
  }, [categories]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return flatOptions;
    return flatOptions.filter((o) => {
      const text = (o.parentLabel ? o.parentLabel + " " : "") + o.label;
      return text.toLowerCase().includes(q);
    });
  }, [search, flatOptions]);

  const selectedOption = flatOptions.find((o) => o.id === selectedId);
  const selectedLabel = selectedOption
    ? selectedOption.parentLabel
      ? `${selectedOption.parentLabel} › ${selectedOption.label}`
      : selectedOption.label
    : null;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleOpen = () => {
    setOpen(true);
    setTimeout(() => searchRef.current?.focus(), 50);
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setOpen(false);
    setSearch("");
  };

  return (
    <div className="relative" ref={ref}>
      <input type="hidden" name="categoryId" value={selectedId} />
      <button
        type="button"
        onClick={handleOpen}
        className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2.5 text-sm"
      >
        <span className={selectedLabel ? "text-foreground" : "text-muted-foreground"}>
          {selectedLabel ?? "No category"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-border bg-background shadow-md">
          <div className="border-b border-border p-2">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search categories…"
              className="w-full rounded-md bg-muted px-3 py-1.5 text-sm focus:outline-none"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            <button
              type="button"
              className={`flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-accent ${!selectedId ? "font-medium text-primary" : "text-muted-foreground"}`}
              onClick={() => handleSelect("")}
            >
              No category
              {!selectedId && <Check className="h-4 w-4 shrink-0" />}
            </button>
            {filtered.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-accent ${selectedId === o.id ? "bg-primary/5" : ""}`}
                onClick={() => handleSelect(o.id)}
              >
                <span className="flex flex-col">
                  {o.parentLabel && (
                    <span className="text-xs text-muted-foreground leading-tight">{o.parentLabel}</span>
                  )}
                  <span className={`text-sm ${selectedId === o.id ? "font-medium text-primary" : ""}`}>
                    {o.label}
                  </span>
                </span>
                {selectedId === o.id && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tag picker (multi-select) ─────────────────────────────────────────────────

function TagPicker({
  tags,
  selectedIds,
  onChange,
  onCreateTag,
}: {
  tags: Tag[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onCreateTag: (name: string) => Promise<Tag>;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [localTags, setLocalTags] = useState<Tag[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const allTags = useMemo(() => {
    const ids = new Set(tags.map((t) => t.id));
    return [...tags, ...localTags.filter((t) => !ids.has(t.id))];
  }, [tags, localTags]);

  const sortedTags = useMemo(() => [...allTags].sort((a, b) => a.name.localeCompare(b.name)), [allTags]);

  const filtered = useMemo(() => {
    if (!search.trim()) return sortedTags;
    const terms = search.toLowerCase().split(/\s+/);
    return sortedTags.filter((t) => {
      const words = t.name.toLowerCase().split(/\s+/);
      return terms.every((term) => words.some((w) => w.startsWith(term)));
    });
  }, [search, sortedTags]);

  const showCreate = !!search.trim() && filtered.length === 0;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleTag = (id: string) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  const handleCreate = async () => {
    const name = search.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const newTag = await onCreateTag(name);
      setLocalTags((prev) => [...prev, newTag]);
      onChange([...selectedIds, newTag.id]);
      setSearch("");
    } finally {
      setCreating(false);
    }
  };

  const selectedTags = sortedTags.filter((t) => selectedIds.includes(t.id));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => { setOpen(true); setTimeout(() => searchRef.current?.focus(), 50); }}
        className="flex w-full min-h-[42px] items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
      >
        {selectedTags.length === 0 ? (
          <span className="text-muted-foreground">No tags</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {selectedTags.map((t) => (
              <span
                key={t.id}
                className="rounded-full px-2 py-0.5 text-xs font-medium"
                style={t.color ? { backgroundColor: t.color, color: "#fff" } : { backgroundColor: "hsl(var(--primary))", color: "#fff" }}
              >
                {t.name}
              </span>
            ))}
          </div>
        )}
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-border bg-background shadow-md">
          <div className="border-b border-border p-2">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search or create tag…"
              className="w-full rounded-md bg-muted px-3 py-1.5 text-sm focus:outline-none"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {showCreate ? (
              <button
                type="button"
                className="block w-full px-3 py-2.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                onClick={handleCreate}
                disabled={creating}
              >
                {creating ? "Creating…" : `Create tag: "${search.trim()}"`}
              </button>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-2.5 text-sm text-muted-foreground">No tags yet</p>
            ) : (
              filtered.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-accent"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleTag(t.id)}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selectedIds.includes(t.id) ? "bg-primary border-primary" : "border-border"}`}>
                    {selectedIds.includes(t.id) && <Check className="h-3 w-3 text-white" />}
                  </span>
                  {t.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Add / Edit Expense Modal ───────────────────────────────────────────────────

function MobileExpenseModal({
  open,
  onClose,
  onSaved,
  accounts,
  categories,
  vendors,
  tags,
  onCreateTag,
  expense = null,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  accounts: Account[];
  categories: Category[];
  vendors: string[];
  tags: Tag[];
  onCreateTag: (name: string) => Promise<Tag>;
  expense?: Expense | null;
}) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(() => expense?.tags.map((t) => t.tagId) ?? []);
  const [isReimbursementExpected, setIsReimbursementExpected] = useState(expense?.isReimbursementExpected ?? false);
  const [ignoreInBudget, setIgnoreInBudget] = useState(expense?.ignoreInBudget ?? false);
  const [isRecurring, setIsRecurring] = useState(!!expense?.recurrenceRuleId);
  const [recurringInterval, setRecurringInterval] = useState("1");
  const [recurringFrequency, setRecurringFrequency] = useState("MONTHLY");
  const [showEndDate, setShowEndDate] = useState(false);
  const [showMore, setShowMore] = useState(
    !!(expense?.notes || expense?.isReimbursementExpected || expense?.recurrenceRuleId || expense?.ignoreInBudget)
  );
  const today = localToday();
  const isEditing = expense != null;

  // Lock body scroll while open — prevents iOS Safari from scrolling the page
  // underneath when the address bar retracts.
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    setSaving(true);
    try {
      let recurrenceRuleId: string | null | undefined = isRecurring
        ? (expense?.recurrenceRuleId ?? null)
        : null;
      if (isRecurring && !recurrenceRuleId) {
        const rule = await createRecurrenceRule({
          description: fd.get("description") as string,
          vendor: fd.get("vendor") as string,
          amount: parseFloat(fd.get("amount") as string),
          frequency: recurringFrequency,
          interval: parseInt(recurringInterval) || 1,
          startDate: fd.get("date") as string,
          endDate: (fd.get("endDate") as string) || undefined,
          categoryId: (fd.get("categoryId") as string) || undefined,
          accountId: fd.get("accountId") as string,
        });
        recurrenceRuleId = rule.id;
      }
      const data: Record<string, unknown> = {
        amount: parseFloat(fd.get("amount") as string),
        description: fd.get("description") as string,
        vendor: fd.get("vendor") as string,
        date: fd.get("date") as string,
        accountId: fd.get("accountId") as string,
        categoryId: (fd.get("categoryId") as string) || null,
        notes: (fd.get("notes") as string) || undefined,
        tagIds: selectedTagIds,
        isReimbursementExpected,
        reimbursementNote: isReimbursementExpected ? (fd.get("reimbursementNote") as string) || undefined : null,
        ignoreInBudget,
        recurrenceRuleId,
      };
      if (isEditing) {
        await updateExpense(expense.id, data);
      } else {
        await createExpense(data);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save expense");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-base font-semibold">{isEditing ? "Edit Expense" : "Add Expense"}</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-muted-foreground hover:bg-accent"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Scrollable form */}
      <form id="mobile-expense-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-5 p-4">
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium">Amount</label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <input
                  name="amount"
                  type="number"
                  step="0.01"
                  required
                  inputMode="decimal"
                  placeholder="0.00"
                  defaultValue={expense ? parseFloat(expense.amount).toFixed(2) : undefined}
                  className="w-full rounded-md border border-border py-2.5 pl-7 pr-3 text-sm focus:border-primary focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Date</label>
              <div className="relative">
                <input
                  name="date"
                  type="date"
                  required
                  defaultValue={expense?.date?.slice(0, 10) ?? today}
                  className="w-full appearance-none rounded-md border border-border px-3 py-2.5 pr-8 text-sm text-foreground focus:border-primary focus:outline-none"
                />
                <Calendar className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Description</label>
            <input
              name="description"
              type="text"
              required
              placeholder="What did you spend on?"
              defaultValue={expense?.description ?? ""}
              className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Vendor</label>
            <VendorInput vendors={vendors} initialValue={expense?.vendor ?? ""} />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Account</label>
            <div className="relative">
              <select
                name="accountId"
                required
                defaultValue={expense?.accountId ?? ""}
                className="appearance-none w-full rounded-md border border-border py-2.5 pl-3 pr-8 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                <option value="" disabled>Select account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Category</label>
            <CategoryPicker categories={categories} initialId={expense?.categoryId ?? ""} />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Tags</label>
            <TagPicker
              tags={tags}
              selectedIds={selectedTagIds}
              onChange={setSelectedTagIds}
              onCreateTag={onCreateTag}
            />
          </div>

          {/* Collapsible "More options" section */}
          <div className="border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setShowMore((v) => !v)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
            >
              {showMore
                ? <ChevronDown className="h-4 w-4" />
                : <ChevronRight className="h-4 w-4" />}
              More options
            </button>

            {showMore && (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Notes</label>
                  <textarea
                    name="notes"
                    rows={3}
                    placeholder="Additional notes…"
                    defaultValue={expense?.notes ?? ""}
                    className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
                  />
                </div>

                {/* Toggle tiles */}
                <div className="space-y-2">
                  {/* Reimbursement tile */}
                  <div>
                    <button
                      type="button"
                      onClick={() => setIsReimbursementExpected((v) => !v)}
                      className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm transition-colors ${
                        isReimbursementExpected
                          ? "border-primary bg-primary/5"
                          : "border-border"
                      }`}
                    >
                      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                        isReimbursementExpected ? "border-primary bg-primary" : "border-border"
                      }`}>
                        {isReimbursementExpected && <Check className="h-3 w-3 text-white" />}
                      </span>
                      <span className={isReimbursementExpected ? "text-primary" : ""}>
                        Expecting reimbursement or refund
                      </span>
                    </button>
                    {isReimbursementExpected && (
                      <input
                        name="reimbursementNote"
                        type="text"
                        defaultValue={expense?.reimbursementNote ?? ""}
                        placeholder="e.g. Return pending, or expecting $25 from John"
                        className="mt-2 w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
                      />
                    )}
                  </div>

                  {/* Ignore in budget tile */}
                  <button
                    type="button"
                    onClick={() => setIgnoreInBudget((v) => !v)}
                    className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm transition-colors ${
                      ignoreInBudget ? "border-primary bg-primary/5" : "border-border"
                    }`}
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                      ignoreInBudget ? "border-primary bg-primary" : "border-border"
                    }`}>
                      {ignoreInBudget && <Check className="h-3 w-3 text-white" />}
                    </span>
                    <span className={ignoreInBudget ? "text-primary" : ""}>
                      Ignore in budget
                    </span>
                  </button>

                  {/* Recurring tile — hidden for offset children */}
                  {!expense?.parentExpenseId && (
                    <div>
                      <button
                        type="button"
                        onClick={() => !expense?.recurrenceRuleId && setIsRecurring((v) => !v)}
                        className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm transition-colors ${
                          isRecurring ? "border-primary bg-primary/5" : "border-border"
                        }`}
                      >
                        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                          isRecurring ? "border-primary bg-primary" : "border-border"
                        }`}>
                          {isRecurring && <Check className="h-3 w-3 text-white" />}
                        </span>
                        <span className={isRecurring ? "text-primary" : ""}>
                          Recurring expense
                        </span>
                      </button>

                      {/* Frequency picker — only for new recurring expenses */}
                      {isRecurring && !expense?.recurrenceRuleId && (
                        <div className="mt-2 rounded-md border border-border p-3">
                          {/*
                            Single grid: col 1 = label (auto, sized to widest),
                            col 2 = w-14 number input, col 3 = 1fr select/date, col 4 = auto dismiss.
                            Both rows share these columns so inputs align naturally.
                          */}
                          <div className="grid items-center gap-x-2 gap-y-2" style={{ gridTemplateColumns: "auto 3.5rem 1fr auto" }}>
                            {/* Row 1: Repeats every [n] [freq] */}
                            <span className="text-sm text-muted-foreground">Repeats every</span>
                            <input
                              type="number"
                              min="1"
                              max="99"
                              value={recurringInterval}
                              onChange={(e) => setRecurringInterval(e.target.value)}
                              placeholder="1"
                              className="w-full rounded-md border border-border px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
                            />
                            <div className="relative">
                              <select
                                name="frequency"
                                value={recurringFrequency}
                                onChange={(e) => setRecurringFrequency(e.target.value)}
                                className="appearance-none w-full rounded-md border border-border py-1.5 pl-2 pr-6 text-sm text-foreground"
                              >
                                {FREQUENCY_OPTIONS.map(({ value, singular, plural }) => {
                                  const n = parseInt(recurringInterval) || 1;
                                  return <option key={value} value={value}>{n === 1 ? singular : plural}</option>;
                                })}
                              </select>
                              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            </div>
                            <div /> {/* placeholder for col 4 */}

                            {/* Row 2: Until [date] or "+ Add end date" link */}
                            {!showEndDate ? (
                              <button
                                type="button"
                                onClick={() => setShowEndDate(true)}
                                className="col-span-4 justify-self-start text-xs text-primary"
                              >
                                + Add end date
                              </button>
                            ) : (
                              <>
                                <span className="text-right text-sm text-muted-foreground">Until</span>
                                <div className="relative col-span-2">
                                  <input
                                    name="endDate"
                                    type="date"
                                    className="w-full appearance-none rounded-md border border-border px-2 py-1.5 pr-8 text-sm text-foreground focus:border-primary focus:outline-none"
                                  />
                                  <Calendar className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setShowEndDate(false)}
                                  className="text-muted-foreground hover:text-foreground"
                                  aria-label="Remove end date"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </form>

      {/* Sticky footer */}
      <div className="shrink-0 border-t border-border p-4">
        <div className="flex gap-3">
          {isEditing && (
            confirmDelete ? (
              <button
                type="button"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await deleteExpense(expense.id);
                    onSaved();
                    onClose();
                  } catch {
                    setError("Failed to delete expense");
                    setDeleting(false);
                    setConfirmDelete(false);
                  }
                }}
                className="rounded-md bg-destructive px-3 py-2.5 text-sm font-medium text-destructive-foreground disabled:opacity-50 transition-colors"
              >
                {deleting ? "Deleting…" : "Confirm?"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-md border border-border p-2.5 text-muted-foreground hover:border-destructive hover:text-destructive transition-colors"
                aria-label="Delete expense"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )
          )}
          <button
            type="button"
            onClick={() => { onClose(); setConfirmDelete(false); }}
            className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="mobile-expense-form"
            disabled={saving}
            className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity"
          >
            {saving ? "Saving…" : isEditing ? "Save Changes" : "Add Expense"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Expense row ────────────────────────────────────────────────────────────────

type RenderItem =
  | { type: "single"; expense: Expense }
  | { type: "group"; members: { expense: Expense; isPrimary: boolean }[] };

function buildRenderItems(expenses: Expense[]): RenderItem[] {
  const groupMembers = new Map<string, Expense[]>();
  for (const e of expenses) {
    if (e.transactionGroupId) {
      const arr = groupMembers.get(e.transactionGroupId) ?? [];
      arr.push(e);
      groupMembers.set(e.transactionGroupId, arr);
    }
  }
  const items: RenderItem[] = [];
  const rendered = new Set<string>();
  for (const e of expenses) {
    if (e.transactionGroupId) {
      if (rendered.has(e.transactionGroupId)) continue;
      rendered.add(e.transactionGroupId);
      const members = groupMembers.get(e.transactionGroupId) ?? [];
      const primaryId = e.transactionGroup?.primaryExpenseId ?? null;
      items.push({
        type: "group",
        members: members.map((m, idx) => ({
          expense: m,
          isPrimary: primaryId ? m.id === primaryId : idx === 0,
        })),
      });
    } else {
      items.push({ type: "single", expense: e });
    }
  }
  return items;
}

function isFullyOffset(expense: Expense): boolean {
  const offsets = expense.offsets ?? [];
  if (offsets.length === 0) return false;
  const total = offsets.reduce((sum, o) => sum + parseFloat(o.amount), 0);
  return Math.abs(parseFloat(expense.amount) + total) < 0.005;
}

function ExpenseRow({
  expense,
  upcoming = false,
  isOffset = false,
  parentFullyOffset = false,
  onTap,
}: {
  expense: Expense;
  upcoming?: boolean;
  isOffset?: boolean;
  parentFullyOffset?: boolean;
  onTap?: () => void;
}) {
  const fullyOffset = isFullyOffset(expense);
  const isNegative = parseFloat(expense.amount) < 0;

  const rowBg = upcoming || isOffset || fullyOffset ? "" :
    !expense.categoryId ? "bg-red-50/50" :
    expense.recurrenceRuleId ? "bg-blue-50/50" :
    expense.isReimbursementExpected ? "bg-amber-50/50" : "";

  const mutedText = fullyOffset ? "text-gray-300" : "";

  if (isOffset) {
    const gray = parentFullyOffset ? "text-gray-300" : "text-muted-foreground";
    const grayDim = parentFullyOffset ? "text-gray-300/70" : "text-muted-foreground/70";
    return (
      <div className="flex items-start gap-2 py-2">
        <CornerDownRight className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${gray}`} />
        <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={`truncate text-xs ${gray}`}>{expense.description}</p>
            <p className={`text-xs ${grayDim}`}>
              {expense.vendor && <>{expense.vendor} &middot; </>}
              {expense.account.name}
            </p>
          </div>
          <span className={`shrink-0 text-xs font-medium ${parentFullyOffset ? gray : isNegative ? "text-green-600" : gray}`}>
            {isNegative
              ? `+${formatCurrency(Math.abs(parseFloat(expense.amount)))}`
              : formatCurrency(parseFloat(expense.amount))}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`py-3 ${upcoming ? "italic opacity-60" : ""} ${rowBg} ${onTap ? "cursor-pointer active:opacity-60" : ""}`}
      onClick={onTap}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-1.5">
          {!upcoming && expense.isReimbursementExpected && (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          )}
          <p className={`truncate font-medium ${mutedText}`}>{expense.description}</p>
        </div>
        <span className={`shrink-0 font-semibold ${fullyOffset ? "text-gray-300" : isNegative ? "text-green-600" : ""}`}>
          {isNegative
            ? `+${formatCurrency(Math.abs(parseFloat(expense.amount)))}`
            : formatCurrency(parseFloat(expense.amount))}
        </span>
      </div>
      <p className={`mt-0.5 text-sm ${fullyOffset ? "text-gray-300" : "text-muted-foreground"}`}>
        {!isOffset && <>{formatDate(expense.date)} &middot; </>}
        {expense.vendor && <>{expense.vendor} &middot; </>}
        {expense.account.name}
        {!fullyOffset && expense.tags.length > 0 && (
          <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle">
            {expense.tags.slice(0, 4).map(({ tag }) => (
              <span
                key={tag.id}
                className="inline-flex h-3.5 w-3.5 items-center justify-center rounded font-bold leading-none text-white"
                style={{ backgroundColor: tag.color ?? "hsl(var(--primary))", fontSize: "8px" }}
              >
                {tag.name.charAt(0).toUpperCase()}
              </span>
            ))}
          </span>
        )}
      </p>
    </div>
  );
}

// ── Filter state ─────────────────────────────────────────────────────────────

interface ExpenseFilterState {
  accountIds: string[];
  categoryIds: string[];
  tagIds: string[];
  startDate: string;
  endDate: string;
  datePreset: string;
}

const EXPENSE_DEFAULT_FILTERS: ExpenseFilterState = {
  accountIds: [],
  categoryIds: [],
  tagIds: [],
  startDate: `${new Date().getFullYear()}-01-01`,
  endDate: "",
  datePreset: "This year",
};

function loadExpenseFilters(): ExpenseFilterState {
  try {
    const get = (key: string) => {
      const item = localStorage.getItem(`beacon-expenses-${key}`);
      return item !== null ? JSON.parse(item) : null;
    };
    return {
      accountIds: get("accountIds") ?? EXPENSE_DEFAULT_FILTERS.accountIds,
      categoryIds: get("categoryIds") ?? EXPENSE_DEFAULT_FILTERS.categoryIds,
      tagIds: get("tagIds") ?? EXPENSE_DEFAULT_FILTERS.tagIds,
      startDate: get("startDate") ?? EXPENSE_DEFAULT_FILTERS.startDate,
      endDate: get("endDate") ?? EXPENSE_DEFAULT_FILTERS.endDate,
      datePreset: get("datePreset") ?? EXPENSE_DEFAULT_FILTERS.datePreset,
    };
  } catch {
    return { ...EXPENSE_DEFAULT_FILTERS };
  }
}

function saveExpenseFilters(filters: ExpenseFilterState) {
  localStorage.setItem("beacon-expenses-accountIds", JSON.stringify(filters.accountIds));
  localStorage.setItem("beacon-expenses-categoryIds", JSON.stringify(filters.categoryIds));
  localStorage.setItem("beacon-expenses-tagIds", JSON.stringify(filters.tagIds));
  localStorage.setItem("beacon-expenses-startDate", JSON.stringify(filters.startDate));
  localStorage.setItem("beacon-expenses-endDate", JSON.stringify(filters.endDate));
  localStorage.setItem("beacon-expenses-datePreset", JSON.stringify(filters.datePreset));
}

// ── Filter sheet ──────────────────────────────────────────────────────────────

function MobileFilterSheet({
  open,
  onClose,
  staged,
  setStaged,
  onApply,
  onReset,
  accounts,
  categories,
  tags,
  dateRangePresets,
  todayStr,
}: {
  open: boolean;
  onClose: () => void;
  staged: ExpenseFilterState;
  setStaged: React.Dispatch<React.SetStateAction<ExpenseFilterState>>;
  onApply: () => void;
  onReset: () => void;
  accounts: Account[];
  categories: Category[];
  tags: Tag[];
  dateRangePresets: { label: string; start: string; end: string }[];
  todayStr: string;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(true);
  const [catSearch, setCatSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = "";
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  const personalAccounts = accounts.filter((a) => !a.isJoint);
  const jointAccounts = accounts.filter((a) => a.isJoint);

  const flatCatOptions = useMemo(() => {
    const parents = categories.filter((c) => !c.parentId);
    const children = categories.filter((c) => c.parentId);
    const opts: { id: string; label: string; parentLabel?: string }[] = [];
    for (const parent of parents) {
      const kids = children.filter((c) => c.parentId === parent.id);
      if (kids.length === 0) {
        opts.push({ id: parent.id, label: parent.name });
      } else {
        for (const child of kids) {
          opts.push({ id: child.id, label: child.name, parentLabel: parent.name });
        }
      }
    }
    return opts;
  }, [categories]);

  const filteredCats = useMemo(() => {
    const q = catSearch.toLowerCase().trim();
    if (!q) return flatCatOptions;
    return flatCatOptions.filter((o) => {
      const text = (o.parentLabel ? o.parentLabel + " " : "") + o.label;
      return text.toLowerCase().includes(q);
    });
  }, [catSearch, flatCatOptions]);

  const toggleAccount = (id: string) =>
    setStaged((s) => ({
      ...s,
      accountIds: s.accountIds.includes(id)
        ? s.accountIds.filter((x) => x !== id)
        : [...s.accountIds, id],
    }));

  const toggleCategory = (id: string) =>
    setStaged((s) => ({
      ...s,
      categoryIds: s.categoryIds.includes(id)
        ? s.categoryIds.filter((x) => x !== id)
        : [...s.categoryIds, id],
    }));

  const toggleTag = (id: string) =>
    setStaged((s) => ({
      ...s,
      tagIds: s.tagIds.includes(id)
        ? s.tagIds.filter((x) => x !== id)
        : [...s.tagIds, id],
    }));

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col bg-background rounded-t-2xl max-h-[85vh] overflow-hidden shadow-xl transition-transform duration-250 ease-out",
          open ? "translate-y-0" : "translate-y-full"
        )}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-border">
          <h2 className="text-base font-semibold">Filters</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent"
            aria-label="Close filters"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto overscroll-contain divide-y divide-border">

          {/* Account */}
          <div>
            <div
              className="flex cursor-pointer items-center px-4 py-3"
              onClick={() => setAccountOpen((v) => !v)}
            >
              <span className="flex-1 text-sm font-medium">Account</span>
              {accountOpen && (
                <div className="mr-3 flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button type="button" onClick={() => setStaged((s) => ({ ...s, accountIds: accounts.map((a) => a.id) }))} className="text-xs text-primary">All</button>
                  <span className="text-xs text-muted-foreground/40">·</span>
                  <button type="button" onClick={() => setStaged((s) => ({ ...s, accountIds: [] }))} className="text-xs text-muted-foreground">None</button>
                </div>
              )}
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-150 ${accountOpen ? "rotate-180" : ""}`} />
            </div>
            {accountOpen && (
              <div className="px-4 pb-3">
                <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                  <div className="space-y-1.5">
                    {personalAccounts.length > 0 && (
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Personal</p>
                    )}
                    {personalAccounts.map((a) => {
                      const sel = staged.accountIds.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => toggleAccount(a.id)}
                          className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors ${
                            sel ? "border-primary bg-primary/5" : "border-border"
                          }`}
                        >
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${sel ? "border-primary bg-primary" : "border-border"}`}>
                            {sel && <Check className="h-2.5 w-2.5 text-white" />}
                          </span>
                          <span className={`truncate text-xs ${sel ? "font-medium text-primary" : ""}`}>{a.name}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="space-y-1.5">
                    {jointAccounts.length > 0 && (
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Joint</p>
                    )}
                    {jointAccounts.map((a) => {
                      const sel = staged.accountIds.includes(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => toggleAccount(a.id)}
                          className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors ${
                            sel ? "border-primary bg-primary/5" : "border-border"
                          }`}
                        >
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${sel ? "border-primary bg-primary" : "border-border"}`}>
                            {sel && <Check className="h-2.5 w-2.5 text-white" />}
                          </span>
                          <span className={`truncate text-xs ${sel ? "font-medium text-primary" : ""}`}>{a.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Categories */}
          <div>
            <div
              className="flex cursor-pointer items-center px-4 py-3"
              onClick={() => setCategoryOpen((v) => !v)}
            >
              <span className="flex-1 text-sm font-medium">Categories</span>
              {categoryOpen && (
                <div className="mr-3 flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button type="button" onClick={() => setStaged((s) => ({ ...s, categoryIds: flatCatOptions.map((o) => o.id) }))} className="text-xs text-primary">All</button>
                  <span className="text-xs text-muted-foreground/40">·</span>
                  <button type="button" onClick={() => setStaged((s) => ({ ...s, categoryIds: [] }))} className="text-xs text-muted-foreground">None</button>
                </div>
              )}
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-150 ${categoryOpen ? "rotate-180" : ""}`} />
            </div>
            {categoryOpen && (
              <div className="px-4 pb-3 space-y-2">
                <input
                  type="text"
                  value={catSearch}
                  onChange={(e) => setCatSearch(e.target.value)}
                  placeholder="Search categories…"
                  className="w-full rounded-md bg-muted px-3 py-2 text-sm focus:outline-none"
                />
                <div className="max-h-44 overflow-y-auto rounded-md border border-border">
                  {filteredCats.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-muted-foreground">No categories found</p>
                  ) : (
                    filteredCats.map((o) => {
                      const sel = staged.categoryIds.includes(o.id);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => toggleCategory(o.id)}
                          className={`flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent ${sel ? "bg-primary/5" : ""}`}
                        >
                          <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${sel ? "border-primary bg-primary" : "border-border"}`}>
                            {sel && <Check className="h-2.5 w-2.5 text-white" />}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            {o.parentLabel && (
                              <span className="text-xs leading-tight text-muted-foreground">{o.parentLabel}</span>
                            )}
                            <span className={`text-sm ${sel ? "font-medium text-primary" : ""}`}>{o.label}</span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Tags */}
          <div>
            <div
              className="flex cursor-pointer items-center px-4 py-3"
              onClick={() => setTagOpen((v) => !v)}
            >
              <span className="flex-1 text-sm font-medium">Tag</span>
              {tagOpen && (
                <div className="mr-3 flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button type="button" onClick={() => setStaged((s) => ({ ...s, tagIds: tags.map((t) => t.id) }))} className="text-xs text-primary">All</button>
                  <span className="text-xs text-muted-foreground/40">·</span>
                  <button type="button" onClick={() => setStaged((s) => ({ ...s, tagIds: [] }))} className="text-xs text-muted-foreground">None</button>
                </div>
              )}
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-150 ${tagOpen ? "rotate-180" : ""}`} />
            </div>
            {tagOpen && (
              <div className="px-4 pb-3">
                {tags.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tags available</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {tags.map((t) => {
                      const sel = staged.tagIds.includes(t.id);
                      const color = t.color ?? "hsl(var(--primary))";
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => toggleTag(t.id)}
                          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-opacity"
                          style={{
                            backgroundColor: sel ? color : "transparent",
                            color: sel ? "#fff" : color,
                            border: `1.5px solid ${color}`,
                            opacity: sel ? 1 : 0.55,
                          }}
                        >
                          {t.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Date Range */}
          <div>
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3"
              onClick={() => setDateOpen((v) => !v)}
            >
              <span className="text-sm font-medium">Date Range</span>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-150 ${dateOpen ? "rotate-180" : ""}`} />
            </button>
            {dateOpen && (
              <div className="px-4 pb-3 space-y-3">
                <div className="relative">
                  <select
                    value={staged.datePreset}
                    onChange={(e) => {
                      const label = e.target.value;
                      if (label === "Custom") {
                        setStaged((s) => ({ ...s, datePreset: "Custom" }));
                      } else {
                        const preset = dateRangePresets.find((p) => p.label === label);
                        if (preset) setStaged((s) => ({ ...s, datePreset: label, startDate: preset.start, endDate: preset.end }));
                      }
                    }}
                    className="appearance-none w-full rounded-md border border-border py-2.5 pl-3 pr-8 text-sm text-foreground focus:border-primary focus:outline-none"
                  >
                    {dateRangePresets.map((p) => (
                      <option key={p.label} value={p.label}>{p.label}</option>
                    ))}
                    <option value="Custom">Custom</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="relative">
                    <input
                      type="date"
                      value={staged.startDate}
                      onChange={(e) => setStaged((s) => ({ ...s, startDate: e.target.value, datePreset: "Custom" }))}
                      className="w-full appearance-none rounded-md border border-border px-3 py-2.5 pr-8 text-sm text-foreground focus:border-primary focus:outline-none"
                    />
                    <Calendar className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                  <div className="relative">
                    <input
                      type="date"
                      value={staged.endDate || todayStr}
                      onChange={(e) => setStaged((s) => ({ ...s, endDate: e.target.value, datePreset: "Custom" }))}
                      className="w-full appearance-none rounded-md border border-border px-3 py-2.5 pr-8 text-sm text-foreground focus:border-primary focus:outline-none"
                    />
                    <Calendar className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>

        {/* Bottom action buttons */}
        <div className="shrink-0 border-t border-border p-4">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { onReset(); onClose(); }}
              className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent"
            >
              Reset to defaults
            </button>
            <button
              type="button"
              onClick={() => { onApply(); onClose(); }}
              className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const UPCOMING_PREVIEW = 4;

export function MobileExpenses() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [allExpenses, setAllExpenses] = useState<Expense[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [loadingExpenses, setLoadingExpenses] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  // Ref keeps applied search available inside the fetch effect without adding it
  // to deps (which would cause a double-fetch when committing a new search).
  const appliedSearchRef = useRef("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [staged, setStaged] = useState<ExpenseFilterState>(() => loadExpenseFilters());
  const [applied, setApplied] = useState<ExpenseFilterState>(() => loadExpenseFilters());
  // Mirrors applied state for use inside the fetch effect (same pattern as appliedSearchRef).
  const appliedFiltersRef = useRef<ExpenseFilterState>(loadExpenseFilters());
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const today = localToday();
  const tomorrow = useMemo(() => {
    const d = new Date(today.replace(/-/g, "/"));
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }, [today]);

  const dateRangePresets = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const pastYear = new Date(now); pastYear.setFullYear(pastYear.getFullYear() - 1); pastYear.setDate(pastYear.getDate() + 1);
    const past90 = new Date(now); past90.setDate(past90.getDate() - 90);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    return [
      { label: "This year", start: `${year}-01-01`, end: "" },
      { label: String(year - 1), start: `${year - 1}-01-01`, end: `${year - 1}-12-31` },
      { label: "Past year", start: fmt(pastYear), end: "" },
      { label: "Past 90 days", start: fmt(past90), end: "" },
      { label: "This month", start: `${year}-${pad(now.getMonth() + 1)}-01`, end: "" },
      { label: "Last month", start: fmt(lastMonthStart), end: fmt(lastMonthEnd) },
    ];
  }, []);

  const upcomingParams = useMemo(() => {
    const params: Record<string, string> = { startDate: tomorrow, sortBy: "date", sortOrder: "asc", limit: "100" };
    if (applied.categoryIds.length > 0) params.categoryIds = applied.categoryIds.join(",");
    if (applied.accountIds.length > 0) params.accountIds = applied.accountIds.join(",");
    if (applied.tagIds.length > 0) params.tagIds = applied.tagIds.join(",");
    if (appliedSearch.trim()) params.search = appliedSearch.trim();
    return params;
  }, [tomorrow, applied, appliedSearch]);

  // Direct fetch with cancellation — avoids useApi's object-reference instability
  // under React 18 concurrent mode which can cause duplicate page appends.
  // appliedSearch is read via ref so we don't add it to deps (commitSearch bumps
  // refreshKey and resets page, which is what actually triggers a re-fetch).
  useEffect(() => {
    let cancelled = false;
    setLoadingExpenses(true);
    const q = appliedSearchRef.current;
    const f = appliedFiltersRef.current;
    const isDefaultDateFilter = (
      f.startDate === EXPENSE_DEFAULT_FILTERS.startDate &&
      f.endDate === EXPENSE_DEFAULT_FILTERS.endDate
    );
    const params: Record<string, string> = {
      sortBy: "date", sortOrder: "desc",
      limit: q ? "100" : "50",
      page: currentPage.toString(),
      ...(q ? { search: q } : {}),
    };
    if (f.categoryIds.length > 0) params.categoryIds = f.categoryIds.join(",");
    if (f.accountIds.length > 0) params.accountIds = f.accountIds.join(",");
    if (f.tagIds.length > 0) params.tagIds = f.tagIds.join(",");
    if (q && isDefaultDateFilter) {
      params.endDate = today;
    } else {
      params.startDate = f.startDate || EXPENSE_DEFAULT_FILTERS.startDate;
      const endDate = f.endDate || today;
      params.endDate = endDate > today ? today : endDate;
    }
    getExpenses(params)
      .then((result) => {
        if (cancelled || !result) return;
        const { data, pagination: pag } = result;
        if (pag.page === 1) {
          setAllExpenses(data ?? []);
        } else {
          setAllExpenses((prev) => [...prev, ...(data ?? [])]);
        }
        setHasMore(pag.page < pag.totalPages);
        loadingMoreRef.current = false;
        setLoadingExpenses(false);
      })
      .catch(() => {
        if (!cancelled) {
          loadingMoreRef.current = false;
          setLoadingExpenses(false);
        }
      });
    return () => { cancelled = true; };
  }, [today, currentPage, refreshKey]);

  const { data: upcomingData, refetch: refetchUpcoming } = useApi(
    () => getExpenses(upcomingParams),
    [upcomingParams],
    `mobile-expenses-upcoming-${JSON.stringify(upcomingParams)}`
  );
  const { data: accounts } = useApi(() => getAccounts({ includeHidden: true }), [], "accounts");
  const { data: categories } = useApi(() => getFlatCategories("EXPENSE"), [], "categories-EXPENSE");
  const { data: vendors } = useApi(() => getExpenseVendors(), [], "expense-vendors");
  const { data: tags, refetch: refetchTags } = useApi(() => getTags(), [], "tags");

  const eligibleAccounts = useMemo(
    () => (accounts ?? []).filter((a) => EXPENSE_ACCOUNT_TYPES.includes(a.type)),
    [accounts]
  );

  // Infinite scroll sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadingMoreRef.current) {
          loadingMoreRef.current = true;
          setCurrentPage((p) => p + 1);
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore]);

  // Back to top button
  useEffect(() => {
    const handleScroll = () => setShowBackToTop(window.scrollY > 2500);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Mirror desktop logic: deduplicate recurring to next instance only, then
  // apply the same client-side search filter (description/vendor contains OR
  // exact amount match) that desktop uses for the upcoming section.
  const upcomingExpenses = useMemo(() => {
    const seenRuleIds = new Set<string>();
    const deduped = (upcomingData?.data ?? []).filter((e) => {
      if (!e.recurrenceRuleId) return true;
      if (seenRuleIds.has(e.recurrenceRuleId)) return false;
      seenRuleIds.add(e.recurrenceRuleId);
      return true;
    });
    if (!appliedSearch.trim()) return deduped;
    const q = appliedSearch.trim().toLowerCase();
    const asNumber = parseFloat(appliedSearch.trim());
    return deduped.filter((e) =>
      e.description.toLowerCase().includes(q) ||
      e.vendor.toLowerCase().includes(q) ||
      (!isNaN(asNumber) && asNumber > 0 && Math.abs(parseFloat(e.amount)) === asNumber)
    );
  }, [upcomingData, appliedSearch]);
  const visibleUpcoming = upcomingExpanded ? upcomingExpenses : upcomingExpenses.slice(0, UPCOMING_PREVIEW);
  const hiddenUpcomingCount = upcomingExpenses.length - UPCOMING_PREVIEW;

  const commitSearch = useCallback((q: string) => {
    appliedSearchRef.current = q;
    setAppliedSearch(q);
    setCurrentPage(1);
    setAllExpenses([]);
    setHasMore(false);
    loadingMoreRef.current = false;
    setRefreshKey((k) => k + 1);
  }, []);

  const applyFilters = useCallback((filters: ExpenseFilterState) => {
    appliedFiltersRef.current = filters;
    setApplied(filters);
    saveExpenseFilters(filters);
    setCurrentPage(1);
    setAllExpenses([]);
    setHasMore(false);
    loadingMoreRef.current = false;
    setRefreshKey((k) => k + 1);
  }, []);

  const resetFilters = useCallback(() => {
    const defaults = { ...EXPENSE_DEFAULT_FILTERS };
    appliedFiltersRef.current = defaults;
    setApplied(defaults);
    setStaged(defaults);
    saveExpenseFilters(defaults);
    setCurrentPage(1);
    setAllExpenses([]);
    setHasMore(false);
    loadingMoreRef.current = false;
    setRefreshKey((k) => k + 1);
  }, []);

  const hasActiveFilters = !!(
    applied.accountIds.length > 0 ||
    applied.categoryIds.length > 0 ||
    applied.tagIds.length > 0 ||
    applied.startDate !== EXPENSE_DEFAULT_FILTERS.startDate ||
    (applied.endDate && applied.endDate !== today)
  );

  const handleSaved = useCallback(() => {
    setCurrentPage(1);
    setAllExpenses([]);
    setHasMore(false);
    loadingMoreRef.current = false;
    setRefreshKey((k) => k + 1);
    refetchUpcoming();
  }, [refetchUpcoming]);

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <PageHeadingMenu
              title="Expenses"
              items={[
                { label: "Reimbursements", icon: <AlertCircle className="h-4 w-4 text-muted-foreground" />, to: "/expenses/reimbursements" },
                { label: "Tags", icon: <TagIcon className="h-4 w-4 text-muted-foreground" />, to: "/expenses/tags" },
              ]}
            />
          </div>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (!e.target.value.trim()) commitSearch("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitSearch(searchQuery);
                if (e.key === "Escape") { setSearchQuery(""); commitSearch(""); }
              }}
              placeholder="Search…"
              className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm focus:border-primary focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => setFilterOpen(true)}
            aria-label="Filters"
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors ${
              hasActiveFilters
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground"
            }`}
          >
            <Filter className="h-4 w-4" />
          </button>
        </div>

        {upcomingExpenses.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Upcoming
            </h2>
            <div className="relative">
              <div className="divide-y divide-border">
                {visibleUpcoming.map((expense) => (
                  <React.Fragment key={expense.id}>
                    <ExpenseRow expense={expense} upcoming />
                    {expense.offsets?.map((offset) => (
                      <ExpenseRow key={offset.id} expense={offset} upcoming isOffset parentFullyOffset={isFullyOffset(expense)} />
                    ))}
                  </React.Fragment>
                ))}
              </div>
              {!upcomingExpanded && hiddenUpcomingCount > 0 && (
                <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-muted/30 to-transparent" />
              )}
            </div>
            {hiddenUpcomingCount > 0 && (
              <button
                onClick={() => setUpcomingExpanded((v) => !v)}
                className="mt-2 flex w-full items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                {upcomingExpanded
                  ? "Show less"
                  : `Show ${hiddenUpcomingCount} more`}
              </button>
            )}
          </section>
        )}

        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            All Expenses
          </h2>
          {allExpenses.length === 0 && !loadingExpenses ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No expenses this month.</p>
          ) : (
            <div className="divide-y divide-border">
              {buildRenderItems(allExpenses).map((item) => {
                if (item.type === "single") {
                  return (
                    <React.Fragment key={item.expense.id}>
                      <ExpenseRow expense={item.expense} onTap={() => setEditingExpense(item.expense)} />
                      {item.expense.offsets?.map((offset) => (
                        <ExpenseRow key={offset.id} expense={offset} isOffset parentFullyOffset={isFullyOffset(item.expense)} />
                      ))}
                    </React.Fragment>
                  );
                }
                // Group: wrapper carries the left border so inner divide-y lines
                // start inside the padding and never touch the left border.
                return (
                  <div key={item.members[0].expense.id} className="-ml-4 pl-4 border-l-2 border-primary">
                    <div className="divide-y divide-border">
                      {item.members.map(({ expense }) => (
                        <React.Fragment key={expense.id}>
                          <ExpenseRow expense={expense} onTap={() => setEditingExpense(expense)} />
                          {expense.offsets?.map((offset) => (
                            <ExpenseRow key={offset.id} expense={offset} isOffset parentFullyOffset={isFullyOffset(expense)} />
                          ))}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {loadingExpenses && currentPage > 1 && (
          <p className="py-4 text-center text-sm text-muted-foreground">Loading more...</p>
        )}
        <div ref={sentinelRef} className="h-1" />
      </div>

      {showBackToTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-22 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition-opacity hover:opacity-90"
          aria-label="Back to top"
        >
          <ArrowUp className="h-4 w-4" />
          Back to top
        </button>
      )}

      {/* Floating add button */}
      <button
        onClick={() => setModalOpen(true)}
        className="fixed bottom-20 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90 transition-opacity"
        aria-label="Add expense"
      >
        <Plus className="h-6 w-6" />
      </button>

      <MobileExpenseModal
        key={editingExpense?.id ?? "new"}
        open={modalOpen || editingExpense != null}
        onClose={() => { setModalOpen(false); setEditingExpense(null); }}
        onSaved={handleSaved}
        accounts={eligibleAccounts}
        categories={categories ?? []}
        vendors={vendors ?? []}
        tags={tags ?? []}
        onCreateTag={async (name) => { const t = await createTag({ name }); refetchTags(); return t; }}
        expense={editingExpense}
      />

      <MobileFilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        staged={staged}
        setStaged={setStaged}
        onApply={() => applyFilters(staged)}
        onReset={resetFilters}
        accounts={eligibleAccounts}
        categories={categories ?? []}
        tags={tags ?? []}
        dateRangePresets={dateRangePresets}
        todayStr={today}
      />
    </>
  );
}
