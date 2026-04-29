import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { Plus, X, ChevronDown, ChevronRight, Check, ArrowUp, Trash2, Calendar, Search, Filter } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { getIncome, getAccounts, getFlatCategories, createIncome, updateIncome, deleteIncome } from "@/api";
import { formatCurrency, formatDate, localToday, cn } from "@/lib/utils";
import type { Account, Category, Income } from "@/types";

const INCOME_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "INVESTMENT"];

const DIVIDEND_TYPE_LABELS: Record<string, string> = {
  QUALIFIED: "Qualified",
  ORDINARY: "Ordinary",
  TAX_EXEMPT: "Tax-Exempt",
  RETURN_OF_CAPITAL: "Return of Capital",
  CAPITAL_GAIN: "Capital Gain",
};

const DIVIDEND_TYPE_CLASSES: Record<string, string> = {
  QUALIFIED: "bg-emerald-100 text-emerald-700",
  ORDINARY: "bg-slate-100 text-slate-600",
  TAX_EXEMPT: "bg-teal-100 text-teal-700",
  RETURN_OF_CAPITAL: "bg-amber-100 text-amber-700",
  CAPITAL_GAIN: "bg-blue-100 text-blue-700",
};

function TaxStatusBadge({ taxClassification }: { taxClassification: string | null }) {
  if (!taxClassification) return null;
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${DIVIDEND_TYPE_CLASSES[taxClassification] ?? "bg-slate-100 text-slate-600"}`}>
      {DIVIDEND_TYPE_LABELS[taxClassification] ?? taxClassification}
    </span>
  );
}

// ── Category picker with search ───────────────────────────────────────────────

function CategoryPicker({ categories, initialId = "" }: { categories: Category[]; initialId?: string }) {
  const [selectedId, setSelectedId] = useState(initialId);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

// ── Add / Edit Income Modal ────────────────────────────────────────────────────

function MobileIncomeModal({
  open,
  onClose,
  onSaved,
  accounts,
  categories,
  income = null,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  accounts: Account[];
  categories: Category[];
  income?: Income | null;
}) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taxClassification, setTaxClassification] = useState(income?.taxClassification ?? "");
  const [showMore, setShowMore] = useState(!!(income?.notes || income?.taxClassification));
  const today = localToday();
  const isEditing = income != null;
  const isActivityLinked = income?.activityId != null;

  useEffect(() => {
    if (open) {
      setConfirmDelete(false);
      setTaxClassification(income?.taxClassification ?? "");
      setShowMore(!!(income?.notes || income?.taxClassification));
      setError(null);
    }
  }, [open, income]);

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
      const data: Record<string, unknown> = {
        amount: parseFloat(fd.get("amount") as string),
        source: (fd.get("source") as string) || undefined,
        date: fd.get("date") as string,
        accountId: fd.get("accountId") as string,
        categoryId: (fd.get("categoryId") as string) || undefined,
        taxClassification: taxClassification || null,
        notes: (fd.get("notes") as string) || undefined,
      };
      if (isEditing) {
        await updateIncome(income.id, data);
      } else {
        await createIncome(data);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save income");
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-base font-semibold">{isEditing ? "Edit Income" : "Add Income"}</h2>
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
      <form id="mobile-income-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto overscroll-contain">
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
                  defaultValue={income ? parseFloat(income.amount).toFixed(2) : undefined}
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
                  defaultValue={income?.date?.slice(0, 10) ?? today}
                  className="w-full appearance-none rounded-md border border-border px-3 py-2.5 pr-8 text-sm text-foreground focus:border-primary focus:outline-none"
                />
                <Calendar className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Source <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              name="source"
              type="text"
              placeholder="e.g. ACME Corp dividends, Chase savings interest…"
              defaultValue={income?.source ?? ""}
              className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Category</label>
            <CategoryPicker categories={categories} initialId={income?.categoryId ?? ""} />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Account</label>
            <div className="relative">
              <select
                name="accountId"
                required
                defaultValue={income?.accountId ?? ""}
                className="appearance-none w-full rounded-md border border-border py-2.5 pl-2 pr-6 text-sm text-foreground"
              >
                <option value="" disabled>Select account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
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
              <div className="mt-4 space-y-4">
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Tax Status</label>
                  <div className="relative">
                    <select
                      value={taxClassification}
                      onChange={(e) => setTaxClassification(e.target.value)}
                      className="appearance-none w-full rounded-md border border-border py-2.5 pl-2 pr-6 text-sm text-foreground"
                    >
                      <option value="">Not specified</option>
                      <option value="CAPITAL_GAIN">Capital Gain</option>
                      <option value="ORDINARY">Ordinary</option>
                      <option value="QUALIFIED">Qualified</option>
                      <option value="RETURN_OF_CAPITAL">Return of Capital</option>
                      <option value="TAX_EXEMPT">Tax-Exempt</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Notes</label>
                  <textarea
                    name="notes"
                    rows={3}
                    placeholder="Additional notes…"
                    defaultValue={income?.notes ?? ""}
                    className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
                  />
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
                    await deleteIncome(income.id);
                    onSaved();
                    onClose();
                  } catch {
                    setError("Failed to delete income");
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
                onClick={() => { if (!isActivityLinked) setConfirmDelete(true); }}
                title={isActivityLinked ? "Investment-linked transactions cannot be manually deleted" : undefined}
                className={`rounded-md border border-border p-2.5 transition-colors ${
                  isActivityLinked
                    ? "cursor-not-allowed opacity-40 text-muted-foreground"
                    : "text-muted-foreground hover:border-destructive hover:text-destructive"
                }`}
                aria-label="Delete income"
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
            form="mobile-income-form"
            disabled={saving}
            className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity"
          >
            {saving ? "Saving…" : isEditing ? "Save Changes" : "Add Income"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Income row ─────────────────────────────────────────────────────────────────

function IncomeRow({
  income,
  upcoming = false,
  onTap,
}: {
  income: Income;
  upcoming?: boolean;
  onTap?: () => void;
}) {
  const notReceived = !upcoming && !income.isCashReceived;
  const primaryText = income.category?.name ?? "—";
  const secondaryText = income.source ? ` · ${income.source}` : "";

  return (
    <div
      className={`py-3 ${upcoming ? "italic opacity-60" : notReceived ? "bg-muted/40" : ""} ${onTap ? "cursor-pointer active:opacity-60" : ""}`}
      onClick={onTap}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <p className={`truncate font-medium ${notReceived ? "text-muted-foreground" : ""}`}>
            {primaryText}{secondaryText}
          </p>
          {income.subtype === "DIVIDEND" && (
            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-violet-100 text-violet-700">Dividend</span>
          )}
          {income.subtype === "CAPITAL_GAIN" && (
            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700">Sale</span>
          )}
        </div>
        <span className={`shrink-0 font-semibold ${!upcoming && income.isCashReceived ? "text-green-600" : "text-muted-foreground"}`}>
          +{formatCurrency(income.amount)}
        </span>
      </div>
      <div className={`mt-0.5 flex items-center gap-1.5 text-sm ${notReceived ? "text-muted-foreground/70" : "text-muted-foreground"}`}>
        <span>{formatDate(income.date)} · {income.account.name}</span>
        {income.taxClassification && <TaxStatusBadge taxClassification={income.taxClassification} />}
      </div>
    </div>
  );
}

// ── Filter state ──────────────────────────────────────────────────────────────

interface IncomeFilterState {
  accountIds: string[];
  categoryIds: string[];
  startDate: string;
  endDate: string;
  datePreset: string;
  showOnlyReceived: boolean;
}

const INCOME_DEFAULT_FILTERS: IncomeFilterState = {
  accountIds: [],
  categoryIds: [],
  startDate: `${new Date().getFullYear()}-01-01`,
  endDate: "",
  datePreset: "This year",
  showOnlyReceived: true,
};

function loadIncomeFilters(): IncomeFilterState {
  try {
    const get = (key: string) => {
      const item = localStorage.getItem(`beacon-income-${key}`);
      return item !== null ? JSON.parse(item) : null;
    };
    return {
      accountIds: get("accountIds") ?? INCOME_DEFAULT_FILTERS.accountIds,
      categoryIds: get("categoryIds") ?? INCOME_DEFAULT_FILTERS.categoryIds,
      startDate: get("startDate") ?? INCOME_DEFAULT_FILTERS.startDate,
      endDate: get("endDate") ?? INCOME_DEFAULT_FILTERS.endDate,
      datePreset: get("datePreset") ?? INCOME_DEFAULT_FILTERS.datePreset,
      showOnlyReceived: get("showOnlyReceived") ?? INCOME_DEFAULT_FILTERS.showOnlyReceived,
    };
  } catch {
    return { ...INCOME_DEFAULT_FILTERS };
  }
}

function saveIncomeFilters(filters: IncomeFilterState) {
  localStorage.setItem("beacon-income-accountIds", JSON.stringify(filters.accountIds));
  localStorage.setItem("beacon-income-categoryIds", JSON.stringify(filters.categoryIds));
  localStorage.setItem("beacon-income-startDate", JSON.stringify(filters.startDate));
  localStorage.setItem("beacon-income-endDate", JSON.stringify(filters.endDate));
  localStorage.setItem("beacon-income-datePreset", JSON.stringify(filters.datePreset));
  localStorage.setItem("beacon-income-showOnlyReceived", JSON.stringify(filters.showOnlyReceived));
}

// ── Filter sheet ──────────────────────────────────────────────────────────────

function MobileIncomeFilterSheet({
  open,
  onClose,
  staged,
  setStaged,
  onApply,
  onReset,
  accounts,
  categories,
  dateRangePresets,
  todayStr,
}: {
  open: boolean;
  onClose: () => void;
  staged: IncomeFilterState;
  setStaged: React.Dispatch<React.SetStateAction<IncomeFilterState>>;
  onApply: () => void;
  onReset: () => void;
  accounts: Account[];
  categories: Category[];
  dateRangePresets: { label: string; start: string; end: string }[];
  todayStr: string;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
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
          open ? "translate-y-0" : "translate-y-[110%]"
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

          {/* Show only received toggle */}
          <div className="flex items-center gap-3 px-4 py-3">
            <button
              type="button"
              role="switch"
              aria-checked={staged.showOnlyReceived}
              onClick={() => setStaged((s) => ({ ...s, showOnlyReceived: !s.showOnlyReceived }))}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${staged.showOnlyReceived ? "bg-primary" : "bg-muted"}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${staged.showOnlyReceived ? "translate-x-4" : "translate-x-0"}`} />
            </button>
            <span
              className="select-none cursor-pointer text-sm"
              onClick={() => setStaged((s) => ({ ...s, showOnlyReceived: !s.showOnlyReceived }))}
            >
              Show only received income
            </span>
          </div>

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
                          className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors ${sel ? "border-primary bg-primary/5" : "border-border"}`}
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
                          className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm transition-colors ${sel ? "border-primary bg-primary/5" : "border-border"}`}
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
                    className="appearance-none w-full rounded-md border border-border py-2.5 pl-2 pr-6 text-sm text-foreground focus:border-primary focus:outline-none"
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

export function MobileIncome() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingIncome, setEditingIncome] = useState<Income | null>(null);
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [allIncomes, setAllIncomes] = useState<Income[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [loadingIncome, setLoadingIncome] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const appliedSearchRef = useRef("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [staged, setStaged] = useState<IncomeFilterState>(() => loadIncomeFilters());
  const [applied, setApplied] = useState<IncomeFilterState>(() => loadIncomeFilters());
  const appliedFiltersRef = useRef<IncomeFilterState>(loadIncomeFilters());
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

  const upcomingParams = useMemo(() => ({
    startDate: tomorrow,
    sortBy: "date",
    sortOrder: "asc",
    limit: "100",
  }), [tomorrow]);

  useEffect(() => {
    let cancelled = false;
    setLoadingIncome(true);
    const q = appliedSearchRef.current;
    const f = appliedFiltersRef.current;
    const isDefaultDateFilter = (
      f.startDate === INCOME_DEFAULT_FILTERS.startDate &&
      f.endDate === INCOME_DEFAULT_FILTERS.endDate
    );
    const params: Record<string, string> = {
      sortBy: "date", sortOrder: "desc",
      limit: q ? "100" : "50",
      page: currentPage.toString(),
      ...(q ? { search: q } : {}),
    };
    if (f.categoryIds.length > 0) params.categoryIds = f.categoryIds.join(",");
    if (f.accountIds.length > 0) params.accountIds = f.accountIds.join(",");
    if (q && isDefaultDateFilter) {
      params.endDate = today;
    } else {
      params.startDate = f.startDate || INCOME_DEFAULT_FILTERS.startDate;
      const endDate = f.endDate || today;
      params.endDate = endDate > today ? today : endDate;
    }
    if (!f.showOnlyReceived) params.showOnlyReceived = "false";
    getIncome(params)
      .then((result) => {
        if (cancelled || !result) return;
        const { data, pagination: pag } = result;
        if (pag.page === 1) {
          setAllIncomes(data ?? []);
        } else {
          setAllIncomes((prev) => [...prev, ...(data ?? [])]);
        }
        setHasMore(pag.page < pag.totalPages);
        loadingMoreRef.current = false;
        setLoadingIncome(false);
      })
      .catch(() => {
        if (!cancelled) {
          loadingMoreRef.current = false;
          setLoadingIncome(false);
        }
      });
    return () => { cancelled = true; };
  }, [today, currentPage, refreshKey]);

  const { data: upcomingData, refetch: refetchUpcoming } = useApi(
    () => getIncome(upcomingParams),
    [upcomingParams],
    `mobile-income-upcoming-${JSON.stringify(upcomingParams)}`
  );
  const { data: accounts } = useApi(() => getAccounts({ includeHidden: true }), [], "accounts");
  const { data: incomeCategories } = useApi(() => getFlatCategories("INCOME"), [], "categories-INCOME");

  const eligibleAccounts = useMemo(
    () => (accounts ?? []).filter((a) => INCOME_ACCOUNT_TYPES.includes(a.type)),
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

  const upcomingIncomes = upcomingData?.data ?? [];
  const visibleUpcoming = upcomingExpanded ? upcomingIncomes : upcomingIncomes.slice(0, UPCOMING_PREVIEW);
  const hiddenUpcomingCount = upcomingIncomes.length - UPCOMING_PREVIEW;

  const commitSearch = useCallback((q: string) => {
    appliedSearchRef.current = q;
    setAppliedSearch(q);
    setCurrentPage(1);
    setAllIncomes([]);
    setHasMore(false);
    loadingMoreRef.current = false;
    setRefreshKey((k) => k + 1);
  }, []);

  const applyFilters = useCallback((filters: IncomeFilterState) => {
    appliedFiltersRef.current = filters;
    setApplied(filters);
    saveIncomeFilters(filters);
    setCurrentPage(1);
    setAllIncomes([]);
    setHasMore(false);
    loadingMoreRef.current = false;
    setRefreshKey((k) => k + 1);
  }, []);

  const resetFilters = useCallback(() => {
    const defaults = { ...INCOME_DEFAULT_FILTERS };
    appliedFiltersRef.current = defaults;
    setApplied(defaults);
    setStaged(defaults);
    saveIncomeFilters(defaults);
    setCurrentPage(1);
    setAllIncomes([]);
    setHasMore(false);
    loadingMoreRef.current = false;
    setRefreshKey((k) => k + 1);
  }, []);

  const hasActiveFilters = !!(
    applied.accountIds.length > 0 ||
    applied.categoryIds.length > 0 ||
    applied.startDate !== INCOME_DEFAULT_FILTERS.startDate ||
    (applied.endDate && applied.endDate !== today) ||
    !applied.showOnlyReceived
  );

  const handleSaved = useCallback(() => {
    setCurrentPage(1);
    setAllIncomes([]);
    setHasMore(false);
    loadingMoreRef.current = false;
    setRefreshKey((k) => k + 1);
    refetchUpcoming();
  }, [refetchUpcoming]);

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-2xl font-bold">Income</h1>
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

        {upcomingIncomes.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Upcoming
            </h2>
            <div className="relative">
              <div className="divide-y divide-border">
                {visibleUpcoming.map((income) => (
                  <IncomeRow key={income.id} income={income} upcoming />
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
                {upcomingExpanded ? "Show less" : `Show ${hiddenUpcomingCount} more`}
              </button>
            )}
          </section>
        )}

        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            All Income
          </h2>
          {allIncomes.length === 0 && !loadingIncome ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No income this period.</p>
          ) : (
            <div className="divide-y divide-border">
              {allIncomes.map((income) => (
                <IncomeRow
                  key={income.id}
                  income={income}
                  onTap={() => setEditingIncome(income)}
                />
              ))}
            </div>
          )}
        </section>

        {loadingIncome && currentPage > 1 && (
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
        aria-label="Add income"
      >
        <Plus className="h-6 w-6" />
      </button>

      <MobileIncomeModal
        key={editingIncome?.id ?? "new"}
        open={modalOpen || editingIncome != null}
        onClose={() => { setModalOpen(false); setEditingIncome(null); }}
        onSaved={handleSaved}
        accounts={eligibleAccounts}
        categories={incomeCategories ?? []}
        income={editingIncome}
      />

      <MobileIncomeFilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        staged={staged}
        setStaged={setStaged}
        onApply={() => applyFilters(staged)}
        onReset={resetFilters}
        accounts={eligibleAccounts}
        categories={incomeCategories ?? []}
        dateRangePresets={dateRangePresets}
        todayStr={today}
      />
    </>
  );
}
