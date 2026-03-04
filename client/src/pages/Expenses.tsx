import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Plus, Pencil, Receipt, ChevronLeft, ChevronRight, AlertCircle,
  ArrowUpDown, ArrowUp, ArrowDown, X, Filter, ChevronDown, Trash2, Repeat,
  AlertTriangle, Undo2, CheckCircle2,
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
  getExpenseVendors, getVendorCategory, getUncategorizedCount,
} from "@/api";
import { formatCurrency, formatDate, toDateInputValue, localToday } from "@/lib/utils";
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
type SortState = { field: SortField; order: "asc" | "desc" } | null;

// ── Currency input helper ──
function CurrencyInput({ name, defaultValue, required }: { name: string; defaultValue?: string; required?: boolean }) {
  const [rawValue, setRawValue] = useState(() => {
    if (!defaultValue) return "";
    const num = Math.abs(parseFloat(defaultValue));
    return num ? num.toFixed(2) : "";
  });

  // Sync when defaultValue changes (e.g. modal reopened with different data)
  useEffect(() => {
    if (!defaultValue) { setRawValue(""); return; }
    const num = Math.abs(parseFloat(defaultValue));
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

// ── Vendor autocomplete ──
function VendorAutocomplete({
  name, defaultValue, vendors, onSelect, required,
}: {
  name: string;
  defaultValue?: string;
  vendors: string[];
  onSelect?: (vendor: string) => void;
  required?: boolean;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!value.trim()) return [];
    const terms = value.toLowerCase().split(/\s+/);
    return vendors.filter((v) => {
      const words = v.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    }).slice(0, 8);
  }, [value, vendors]);

  useEffect(() => { setFocusIdx(0); }, [filtered]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectItem = (v: string) => {
    setValue(v);
    setOpen(false);
    onSelect?.(v);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || filtered.length === 0) {
      if (e.key === "Enter" && value && filtered.length > 0) {
        e.preventDefault();
        selectItem(filtered[0]);
      }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { e.preventDefault(); selectItem(filtered[focusIdx]); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <input
        name={name}
        type="text"
        required={required}
        value={value}
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        placeholder="e.g. Amazon, Whole Foods, Netflix"
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-auto rounded-md border border-border bg-background shadow-lg">
          {filtered.map((v, i) => (
            <button
              key={v}
              type="button"
              className={`block w-full px-3 py-1.5 text-left text-sm ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
              onMouseDown={() => selectItem(v)}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Category typeahead select ──
function CategoryTypeahead({
  name, defaultValue, categories, required,
}: {
  name: string;
  defaultValue?: string;
  categories: Category[];
  required?: boolean;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Sync internal value when defaultValue changes (e.g. vendor-category autofill)
  useEffect(() => { setValue(defaultValue ?? ""); }, [defaultValue]);

  const parentCategories = categories.filter((c) => !c.parentId);
  const childCategories = categories.filter((c) => c.parentId);

  const flatOptions = useMemo(() => {
    const opts: { id: string; label: string; parentLabel?: string }[] = [];
    for (const parent of parentCategories) {
      const children = childCategories.filter((c) => c.parentId === parent.id);
      if (children.length === 0) {
        opts.push({ id: parent.id, label: parent.name });
      } else {
        for (const child of children) {
          opts.push({ id: child.id, label: child.name, parentLabel: parent.name });
        }
      }
    }
    return opts;
  }, [categories]);

  const filtered = useMemo(() => {
    if (!search.trim()) return flatOptions;
    const terms = search.toLowerCase().split(/\s+/);
    return flatOptions.filter((o) => {
      const text = (o.parentLabel ? o.parentLabel + " " : "") + o.label;
      const words = text.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    });
  }, [search, flatOptions]);

  useEffect(() => { setFocusIdx(0); }, [filtered]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectedLabel = useMemo(() => {
    if (!value) return "";
    const opt = flatOptions.find((o) => o.id === value);
    return opt ? (opt.parentLabel ? `${opt.parentLabel} > ${opt.label}` : opt.label) : "";
  }, [value, flatOptions]);

  const selectItem = (id: string) => {
    setValue(id);
    setOpen(false);
    setSearch("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { e.preventDefault(); selectItem(filtered[focusIdx].id); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <input type="hidden" name={name} value={value} />
      {required && !value && <input type="text" required value="" className="hidden" tabIndex={-1} onChange={() => {}} />}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full rounded-md border border-border px-3 py-2 text-left text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {selectedLabel || <span className="text-muted-foreground">Select category</span>}
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-background shadow-lg">
          <div className="border-b border-border p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type to filter..."
              className="w-full rounded border border-border px-2 py-1 text-sm focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
            ) : (
              filtered.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-sm ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
                  onMouseDown={() => selectItem(o.id)}
                >
                  {o.parentLabel && <span className="text-muted-foreground">{o.parentLabel} &gt; </span>}
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Account typeahead ──
function AccountTypeahead({
  name, defaultValue, accounts, required,
}: {
  name: string;
  defaultValue?: string;
  accounts: Account[];
  required?: boolean;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setValue(defaultValue ?? ""); }, [defaultValue]);

  const sortedAccounts = useMemo(() =>
    [...accounts].sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return sortedAccounts;
    const terms = search.toLowerCase().split(/\s+/);
    return sortedAccounts.filter((a) => {
      const words = a.name.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    });
  }, [search, sortedAccounts]);

  useEffect(() => { setFocusIdx(0); }, [filtered]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectedLabel = useMemo(() => {
    if (!value) return "";
    return sortedAccounts.find((a) => a.id === value)?.name ?? "";
  }, [value, sortedAccounts]);

  const selectItem = (id: string) => {
    setValue(id);
    setOpen(false);
    setSearch("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { e.preventDefault(); selectItem(filtered[focusIdx].id); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <input type="hidden" name={name} value={value} />
      {required && !value && <input type="text" required value="" className="hidden" tabIndex={-1} onChange={() => {}} />}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full rounded-md border border-border px-3 py-2 text-left text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {selectedLabel || <span className="text-muted-foreground">Select account</span>}
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-background shadow-lg">
          <div className="border-b border-border p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type to filter..."
              className="w-full rounded border border-border px-2 py-1 text-sm focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
            ) : (
              filtered.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-sm ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
                  onMouseDown={() => selectItem(a.id)}
                >
                  {a.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline editable cell ──
function EditableCell({
  value, onSave, type = "text", className = "",
}: {
  value: string;
  onSave: (newValue: string) => void;
  type?: "text" | "date";
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => {
    setEditing(false);
    if (editValue !== value) onSave(editValue);
  };

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
    <span
      onClick={() => { setEditValue(value); setEditing(true); }}
      className={`cursor-pointer border-b border-dotted border-transparent hover:border-gray-400 ${className}`}
    >
      {type === "date" ? formatDate(value) : value}
    </span>
  );
}

// ── Inline editable select cell ──
// ── Inline vendor cell with autocomplete ──
function EditableVendorCell({
  value, vendors, onSave,
}: {
  value: string;
  vendors: string[];
  onSave: (newValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const filtered = useMemo(() => {
    if (!editValue.trim()) return [];
    const terms = editValue.toLowerCase().split(/\s+/);
    return vendors.filter((v) => {
      if (v === value) return false;
      const words = v.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    }).slice(0, 6);
  }, [editValue, vendors, value]);

  useEffect(() => { setFocusIdx(0); }, [filtered]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        if (editValue !== value) onSave(editValue);
        setEditing(false);
      }
    };
    if (editing) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing, editValue, value, onSave]);

  const commit = (v?: string) => {
    const final = v ?? editValue;
    setEditing(false);
    if (final !== value) onSave(final);
  };

  if (editing) {
    return (
      <div ref={ref} className="relative">
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); if (filtered[focusIdx]) commit(filtered[focusIdx]); else commit(); }
            else if (e.key === "Escape") { setEditValue(value); setEditing(false); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
          }}
          className="w-full rounded border border-primary px-1 py-0.5 text-sm focus:outline-none"
        />
        {filtered.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-36 overflow-auto rounded-md border border-border bg-background shadow-lg">
            {filtered.map((v, i) => (
              <button
                key={v}
                type="button"
                className={`block w-full px-2 py-1 text-left text-sm ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
                onMouseDown={() => commit(v)}
              >
                {v}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <span
      onClick={() => { setEditValue(value); setEditing(true); }}
      className="cursor-pointer border-b border-dotted border-transparent hover:border-gray-400 text-muted-foreground"
    >
      {value || <span className="italic">—</span>}
    </span>
  );
}

// ── Inline category typeahead cell ──
function EditableCategoryCell({
  value, label, categories, isUncategorized, onSave,
}: {
  value: string | null;
  label: string;
  categories: Category[];
  isUncategorized: boolean;
  onSave: (newValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const parentCats = categories.filter((c) => !c.parentId);
  const childCats = categories.filter((c) => c.parentId);

  const flatOptions = useMemo(() => {
    const opts: { id: string; label: string; parentLabel?: string }[] = [];
    for (const parent of parentCats) {
      const children = childCats.filter((c) => c.parentId === parent.id);
      if (children.length === 0) {
        opts.push({ id: parent.id, label: parent.name });
      } else {
        for (const child of children) {
          opts.push({ id: child.id, label: child.name, parentLabel: parent.name });
        }
      }
    }
    return opts;
  }, [categories]);

  const filtered = useMemo(() => {
    if (!search.trim()) return flatOptions;
    const terms = search.toLowerCase().split(/\s+/);
    return flatOptions.filter((o) => {
      const text = (o.parentLabel ? o.parentLabel + " " : "") + o.label;
      const words = text.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    });
  }, [search, flatOptions]);

  useEffect(() => { setFocusIdx(0); }, [filtered]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      const handler = (e: MouseEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) {
          setEditing(false);
          setSearch("");
        }
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }
  }, [editing]);

  const selectItem = (id: string) => {
    setEditing(false);
    setSearch("");
    if (id !== value) onSave(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { e.preventDefault(); selectItem(filtered[focusIdx].id); }
    else if (e.key === "Escape") { setEditing(false); setSearch(""); }
  };

  if (editing) {
    return (
      <div ref={ref} className="relative">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type to filter..."
          className="w-full rounded border border-primary px-1 py-0.5 text-sm focus:outline-none"
        />
        <div className="absolute left-0 right-0 top-full z-50 mt-1 min-w-[220px] rounded-md border border-border bg-background shadow-lg">
          <div className="max-h-48 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
            ) : (
              filtered.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-sm ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
                  onMouseDown={() => selectItem(o.id)}
                >
                  {o.parentLabel && <span className="text-muted-foreground">{o.parentLabel} &gt; </span>}
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <span
      onClick={() => { setSearch(""); setEditing(true); }}
      className={`cursor-pointer border-b border-dotted border-transparent hover:border-gray-400 ${isUncategorized ? "text-red-500 font-medium" : ""}`}
    >
      {isUncategorized ? "[Uncategorized]" : label}
    </span>
  );
}

// ── Inline account typeahead cell ──
function EditableAccountCell({
  value, label, accounts, onSave,
}: {
  value: string;
  label: string;
  accounts: Account[];
  onSave: (newValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sortedAccounts = useMemo(() =>
    [...accounts].sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return sortedAccounts;
    const terms = search.toLowerCase().split(/\s+/);
    return sortedAccounts.filter((a) => {
      const words = a.name.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    });
  }, [search, sortedAccounts]);

  useEffect(() => { setFocusIdx(0); }, [filtered]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      const handler = (e: MouseEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) {
          setEditing(false);
          setSearch("");
        }
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }
  }, [editing]);

  const selectItem = (id: string) => {
    setEditing(false);
    setSearch("");
    if (id !== value) onSave(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { e.preventDefault(); selectItem(filtered[focusIdx].id); }
    else if (e.key === "Escape") { setEditing(false); setSearch(""); }
  };

  if (editing) {
    return (
      <div ref={ref} className="relative">
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type to filter..."
          className="w-full rounded border border-primary px-1 py-0.5 text-sm focus:outline-none"
        />
        <div className="absolute left-0 right-0 top-full z-50 mt-1 min-w-[180px] rounded-md border border-border bg-background shadow-lg">
          <div className="max-h-48 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
            ) : (
              filtered.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-sm ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
                  onMouseDown={() => selectItem(a.id)}
                >
                  {a.name}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <span
      onClick={() => { setSearch(""); setEditing(true); }}
      className="cursor-pointer border-b border-dotted border-transparent hover:border-gray-400"
    >
      {label}
    </span>
  );
}

// ── Inline amount cell ──
function EditableAmountCell({ value, onSave, isOffset }: { value: string; onSave: (v: string) => void; isOffset?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const absValue = Math.abs(parseFloat(value));

  const startEdit = () => {
    setEditValue(absValue.toFixed(2));
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const parsed = parseFloat(editValue);
    if (isNaN(parsed) || parsed === 0) return;
    const saveValue = isOffset ? (-parsed).toFixed(2) : parsed.toFixed(2);
    if (parseFloat(saveValue).toFixed(2) !== parseFloat(value).toFixed(2)) onSave(saveValue);
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
      {isOffset ? "+" : "-"}{formatCurrency(absValue)}
    </span>
  );
}

// ═══════════════ MAIN COMPONENT ═══════════════

export function Expenses() {
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [offsetParent, setOffsetParent] = useState<Expense | null>(null);
  const [sort, setSort] = useState<SortState>({ field: "date", order: "desc" });
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterAccountId, setFilterAccountId] = useState("");
  const [filterCategoryId, setFilterCategoryId] = useState("");
  const [filterTagId, setFilterTagId] = useState("");
  const [filterStartDate, setFilterStartDate] = useState("");
  const [filterEndDate, setFilterEndDate] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [showUncategorized, setShowUncategorized] = useState(false);

  // Today's date string for splitting upcoming vs regular (local timezone)
  const todayStr = useMemo(() => localToday(), []);
  const tomorrowStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const queryParams = useMemo(() => {
    const params: Record<string, string> = {
      page: page.toString(),
      limit: "20",
    };
    if (sort) {
      params.sortBy = sort.field;
      params.sortOrder = sort.order;
    }
    if (showUncategorized) {
      params.categoryId = "uncategorized";
    } else if (filterCategoryId) {
      params.categoryId = filterCategoryId;
    }
    if (filterAccountId) params.accountId = filterAccountId;
    if (filterTagId) params.tagId = filterTagId;
    if (filterStartDate) params.startDate = filterStartDate;
    // Cap main table at today to exclude future-dated (upcoming) expenses
    if (!filterEndDate || filterEndDate > todayStr) {
      params.endDate = todayStr;
    } else {
      params.endDate = filterEndDate;
    }
    return params;
  }, [page, sort, filterAccountId, filterCategoryId, filterTagId, filterStartDate, filterEndDate, showUncategorized, todayStr]);

  // Upcoming expenses query: future-dated, sorted ascending
  const upcomingParams = useMemo(() => {
    const params: Record<string, string> = {
      startDate: tomorrowStr,
      sortBy: "date",
      sortOrder: "asc",
      limit: "100",
    };
    if (showUncategorized) {
      params.categoryId = "uncategorized";
    } else if (filterCategoryId) {
      params.categoryId = filterCategoryId;
    }
    if (filterAccountId) params.accountId = filterAccountId;
    if (filterTagId) params.tagId = filterTagId;
    return params;
  }, [tomorrowStr, filterAccountId, filterCategoryId, filterTagId, showUncategorized]);

  const { data: expenseData, refetch } = useApi(() => getExpenses(queryParams), [queryParams]);
  const { data: upcomingData, refetch: refetchUpcoming } = useApi(() => getExpenses(upcomingParams), [upcomingParams]);
  const { data: categories } = useApi(() => getFlatCategories(), []);
  const { data: accounts } = useApi(() => getAccounts(), []);
  const { data: tags } = useApi(() => getTags(), []);
  const { data: groups } = useApi(() => getTransactionGroups(), []);
  const { data: vendorList, refetch: refetchVendors } = useApi(() => getExpenseVendors(), []);
  const { data: uncatData, refetch: refetchUncat } = useApi(() => getUncategorizedCount(), []);

  const eligibleAccounts = (accounts ?? []).filter((a) => EXPENSE_ACCOUNT_TYPES.includes(a.type));
  const hasActiveFilters = !!(filterAccountId || filterCategoryId || filterTagId || filterStartDate || filterEndDate);
  const uncategorizedCount = uncatData?.count ?? 0;

  const refetchAll = useCallback(() => {
    refetch();
    refetchUpcoming();
  }, [refetch, refetchUpcoming]);

  // ── Recurring confirmation state ──
  const [recurringConfirm, setRecurringConfirm] = useState<{
    mode: "edit" | "delete";
    expenseId: string;
    data?: Record<string, unknown>;
    field?: string;
  } | null>(null);

  const handleSave = async (formData: Record<string, unknown>, updateFuture?: boolean) => {
    if (editing) {
      await updateExpense(editing.id, formData, updateFuture);
    } else {
      await createExpense(formData);
    }
    setModalOpen(false);
    setEditing(null);
    setOffsetParent(null);
    refetchAll();
    refetchVendors();
    refetchUncat();
  };

  const handleDelete = async (id: string, deleteFuture?: boolean) => {
    await deleteExpense(id, deleteFuture);
    setModalOpen(false);
    setEditing(null);
    setOffsetParent(null);
    refetchAll();
    refetchUncat();
  };

  const handleCreateOffset = (expense: Expense) => {
    setEditing(null);
    setOffsetParent(expense);
    setModalOpen(true);
  };

  const handleInlineUpdate = useCallback(async (id: string, field: string, value: string) => {
    const data: Record<string, unknown> = {};
    if (field === "date") data.date = value;
    else if (field === "amount") data.amount = parseFloat(value);
    else data[field] = value;

    // Check if this expense is recurring — if so, show confirmation
    const allExpenses = [...(expenseData?.data ?? []), ...(upcomingData?.data ?? [])];
    const exp = allExpenses.find((e) => e.id === id)
      || allExpenses.flatMap((e) => e.offsets ?? []).find((e) => e.id === id);
    if (exp?.recurrenceRuleId) {
      setRecurringConfirm({ mode: "edit", expenseId: id, data, field });
      return;
    }

    await updateExpense(id, data);
    refetchAll();
    if (field === "vendor") refetchVendors();
    if (field === "categoryId") refetchUncat();
  }, [expenseData, upcomingData, refetchAll, refetchVendors, refetchUncat]);

  const handleRecurringConfirmChoice = async (updateFuture: boolean) => {
    if (!recurringConfirm) return;
    const { mode, expenseId, data, field } = recurringConfirm;
    setRecurringConfirm(null);
    if (mode === "edit" && data) {
      await updateExpense(expenseId, data, updateFuture);
      refetchAll();
      if (field === "vendor") refetchVendors();
      if (field === "categoryId") refetchUncat();
    } else if (mode === "delete") {
      await deleteExpense(expenseId, updateFuture);
      setModalOpen(false);
      setEditing(null);
      setOffsetParent(null);
      refetchAll();
      refetchUncat();
    }
  };

  const openEdit = (expense: Expense) => {
    setEditing(expense);
    setOffsetParent(null);
    setModalOpen(true);
  };

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
    setFilterAccountId("");
    setFilterCategoryId("");
    setFilterTagId("");
    setFilterStartDate("");
    setFilterEndDate("");
    setShowUncategorized(false);
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
    if (!sort || sort.field !== field) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    return sort.order === "asc"
      ? <ArrowUp className="ml-1 inline h-3 w-3" />
      : <ArrowDown className="ml-1 inline h-3 w-3" />;
  };

  const expenses = expenseData?.data ?? [];
  const pagination = expenseData?.pagination;
  const upcomingExpenses = upcomingData?.data ?? [];

  const { groupedRows, groupMap } = useMemo(() => {
    const gMap = new Map<string, Expense[]>();
    for (const e of expenses) {
      if (e.transactionGroupId) {
        const arr = gMap.get(e.transactionGroupId) ?? [];
        arr.push(e);
        gMap.set(e.transactionGroupId, arr);
      }
    }
    const seenGroups = new Set<string>();
    const rows: Array<{ type: "expense"; expense: Expense } | { type: "group-header"; groupId: string; expenses: Expense[] }> = [];
    for (const e of expenses) {
      if (e.transactionGroupId) {
        if (!seenGroups.has(e.transactionGroupId)) {
          seenGroups.add(e.transactionGroupId);
          rows.push({ type: "group-header", groupId: e.transactionGroupId, expenses: gMap.get(e.transactionGroupId)! });
        }
      } else {
        rows.push({ type: "expense", expense: e });
      }
    }
    const groupLookup = new Map<string, TransactionGroup>();
    for (const g of (groups ?? [])) groupLookup.set(g.id, g);
    return { groupedRows: rows, groupMap: groupLookup };
  }, [expenses, groups]);

  const parentCategories = (categories ?? []).filter((c) => !c.parentId);
  const childCategories = (categories ?? []).filter((c) => c.parentId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Expenses</h2>
        <div className="flex gap-2">
          {/* Uncategorized quick filter */}
          {uncategorizedCount > 0 && (
            <Button
              variant={showUncategorized ? "destructive" : "secondary"}
              size="sm"
              onClick={() => { setShowUncategorized(!showUncategorized); setPage(1); }}
            >
              <AlertTriangle className="h-4 w-4" />
              Show Uncategorized
              <span className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
                {uncategorizedCount}
              </span>
            </Button>
          )}
          <Button
            variant={filterOpen ? "primary" : "secondary"}
            size="sm"
            onClick={() => setFilterOpen(!filterOpen)}
          >
            <Filter className="h-4 w-4" />
            {hasActiveFilters && <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 text-xs">!</span>}
          </Button>
          <Button onClick={() => { setEditing(null); setOffsetParent(null); setModalOpen(true); }}>
            <Plus className="h-4 w-4" /> Add Expense
          </Button>
        </div>
      </div>

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
                {eligibleAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
              <select
                value={filterCategoryId}
                onChange={(e) => { setFilterCategoryId(e.target.value); setShowUncategorized(false); setPage(1); }}
                className="rounded-md border border-border px-2 py-1.5 text-sm"
              >
                <option value="">All categories</option>
                {parentCategories.map((parent) => {
                  const children = childCategories.filter((c) => c.parentId === parent.id);
                  if (children.length === 0) return <option key={parent.id} value={parent.id}>{parent.name}</option>;
                  return (
                    <optgroup key={parent.id} label={parent.name}>
                      {children.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
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
            {(hasActiveFilters || showUncategorized) && (
              <button onClick={clearFilters} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" /> Clear
              </button>
            )}
          </div>
        </Card>
      )}

      {/* Upcoming expenses table */}
      {upcomingExpenses.length > 0 && (
        <Card>
          <h3 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">Upcoming</h3>
          <div className="hidden md:block">
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="w-[70px] pb-3 pr-3 font-medium">Date</th>
                  <th className="pb-3 pr-3 font-medium">Description</th>
                  <th className="w-[170px] pb-3 pr-3 font-medium">Vendor</th>
                  <th className="w-[190px] pb-3 pr-3 font-medium">Category</th>
                  <th className="w-[140px] pb-3 pr-3 font-medium">Account</th>
                  <th className="w-[30px] pb-3"></th>
                  <th className="w-[100px] pb-3 text-right font-medium">Amount</th>
                  <th className="w-[60px] pb-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {upcomingExpenses.map((expense) => (
                  <ExpenseRowWithOffsets
                    key={expense.id}
                    expense={expense}
                    onEdit={openEdit}
                    onInlineUpdate={handleInlineUpdate}
                    onCreateOffset={handleCreateOffset}
                    vendors={vendorList ?? []}
                    accounts={eligibleAccounts}
                    categories={categories ?? []}
                    isUpcoming
                  />
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile upcoming */}
          <div className="divide-y divide-border md:hidden">
            {upcomingExpenses.map((expense) => (
              <div key={expense.id} className="flex items-center justify-between py-3 italic opacity-60">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{expense.description}</p>
                  <p className="text-sm text-muted-foreground">
                    {expense.vendor && <>{expense.vendor} &middot; </>}
                    {expense.category?.name ?? <span className="text-red-500">[Uncategorized]</span>} &middot; {formatDate(expense.date)}
                  </p>
                </div>
                <div className="ml-4 flex items-center gap-2">
                  <span className="font-semibold text-destructive">-{formatCurrency(expense.amount)}</span>
                  <button onClick={() => openEdit(expense)} className="rounded p-1 hover:bg-accent"><Pencil className="h-4 w-4 text-muted-foreground" /></button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        {expenses.length > 0 ? (
          <>
            <div className="hidden md:block">
              <table className="w-full table-fixed text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="w-[70px] cursor-pointer select-none pb-3 pr-3 font-medium" onClick={() => toggleSort("date")}>Date <SortIcon field="date" /></th>
                    <th className="cursor-pointer select-none pb-3 pr-3 font-medium" onClick={() => toggleSort("description")}>Description <SortIcon field="description" /></th>
                    <th className="w-[170px] cursor-pointer select-none pb-3 pr-3 font-medium" onClick={() => toggleSort("vendor")}>Vendor <SortIcon field="vendor" /></th>
                    <th className="w-[190px] cursor-pointer select-none pb-3 pr-3 font-medium" onClick={() => toggleSort("category")}>Category <SortIcon field="category" /></th>
                    <th className="w-[140px] cursor-pointer select-none pb-3 pr-3 font-medium" onClick={() => toggleSort("account")}>Account <SortIcon field="account" /></th>
                    <th className="w-[30px] pb-3"></th>
                    <th className="w-[100px] cursor-pointer select-none pb-3 text-right font-medium" onClick={() => toggleSort("amount")}>Amount <SortIcon field="amount" /></th>
                    <th className="w-[60px] pb-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groupedRows.map((row) => {
                    if (row.type === "expense") {
                      return (
                        <ExpenseRowWithOffsets
                          key={row.expense.id}
                          expense={row.expense}
                          onEdit={openEdit}
                          onInlineUpdate={handleInlineUpdate}
                          onCreateOffset={handleCreateOffset}
                          vendors={vendorList ?? []}
                          accounts={eligibleAccounts}
                          categories={categories ?? []}
                        />
                      );
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
                        onInlineUpdate={handleInlineUpdate}
                        onCreateOffset={handleCreateOffset}
                        firstExpense={firstByDate}
                        vendors={vendorList ?? []}
                        accounts={eligibleAccounts}
                        categories={categories ?? []}
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
                  className={`flex items-center justify-between py-3 ${
                    !expense.categoryId ? "bg-red-50/50" : expense.recurrenceRuleId ? "bg-blue-50/50" : expense.isReimbursementExpected ? "bg-amber-50/50" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1 flex items-start gap-2">
                    {expense.isReimbursementExpected && <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />}
                    <div className="min-w-0">
                      <p className="truncate font-medium">{expense.description}</p>
                      <p className="text-sm text-muted-foreground">
                        {expense.vendor && <>{expense.vendor} &middot; </>}
                        {expense.category?.name ?? <span className="text-red-500">[Uncategorized]</span>} &middot; {formatDate(expense.date)}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 flex items-center gap-2">
                    <span className="font-semibold text-destructive">-{formatCurrency(expense.amount)}</span>
                    <button onClick={() => openEdit(expense)} className="rounded p-1 hover:bg-accent"><Pencil className="h-4 w-4 text-muted-foreground" /></button>
                  </div>
                </div>
              ))}
            </div>

            {pagination && pagination.totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
                <p className="text-sm text-muted-foreground">{pagination.total} expense{pagination.total !== 1 ? "s" : ""}</p>
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
            icon={Receipt}
            title="No expenses yet"
            description={hasActiveFilters || showUncategorized
              ? "No expenses match your current filters."
              : "Start tracking your spending by adding your first expense."
            }
            action={
              hasActiveFilters || showUncategorized
                ? <Button variant="secondary" onClick={clearFilters}>Clear Filters</Button>
                : <Button onClick={() => { setEditing(null); setOffsetParent(null); setModalOpen(true); }}><Plus className="h-4 w-4" /> Add Expense</Button>
            }
          />
        )}
      </Card>

      <ExpenseModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); setOffsetParent(null); }}
        onSave={handleSave}
        onDelete={handleDelete}
        onRecurringDelete={(id) => setRecurringConfirm({ mode: "delete", expenseId: id })}
        expense={editing}
        offsetParent={offsetParent}
        categories={categories ?? []}
        accounts={eligibleAccounts}
        tags={tags ?? []}
        vendors={vendorList ?? []}
      />

      {/* Recurring action confirmation dialog */}
      {recurringConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg bg-background p-6 shadow-xl">
            <h3 className="text-base font-semibold">
              {recurringConfirm.mode === "edit" ? "Update Recurring Expense" : "Delete Recurring Expense"}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {recurringConfirm.mode === "edit"
                ? "Would you like to update only this instance, or all future pending instances?"
                : "Would you like to delete only this instance, or this and all future pending instances?"}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button
                variant="secondary"
                className="w-full justify-center"
                onClick={() => handleRecurringConfirmChoice(false)}
              >
                This instance only
              </Button>
              <Button
                className="w-full justify-center"
                onClick={() => handleRecurringConfirmChoice(true)}
              >
                {recurringConfirm.mode === "edit"
                  ? "Update all future pending instances"
                  : "Delete this and all future pending instances"}
              </Button>
              <button
                type="button"
                className="mt-1 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setRecurringConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Offset sub-row (lighter/smaller styling) ──
function OffsetRow({
  offset, onEdit, onInlineUpdate, accounts, categories, isUpcoming,
}: {
  offset: Expense;
  onEdit: (e: Expense) => void;
  onInlineUpdate: (id: string, field: string, value: string) => Promise<void>;
  accounts: Account[];
  categories: Category[];
  isUpcoming?: boolean;
}) {
  const upcomingClass = isUpcoming ? "italic opacity-60" : "";

  return (
    <tr className={`bg-muted/20 hover:bg-muted/30 ${upcomingClass}`}>
      <td className="w-[70px] py-2 pr-3 text-xs text-muted-foreground">
        <EditableCell value={offset.date} type="date" onSave={(v) => onInlineUpdate(offset.id, "date", v)} className="text-xs text-muted-foreground" />
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2 pl-6">
          <Undo2 className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
          <EditableCell
            value={offset.description}
            onSave={(v) => onInlineUpdate(offset.id, "description", v)}
            className="text-xs text-muted-foreground"
          />
        </div>
      </td>
      <td className="w-[170px] py-2 pr-3 text-xs text-muted-foreground">
        <EditableVendorCell value={offset.vendor} vendors={[]} onSave={(v) => onInlineUpdate(offset.id, "vendor", v)} />
      </td>
      <td className="w-[190px] py-2 pr-3 text-xs text-muted-foreground">
        <EditableCategoryCell
          value={offset.categoryId}
          label={offset.category?.name ?? ""}
          categories={categories}
          isUncategorized={!offset.categoryId}
          onSave={(v) => onInlineUpdate(offset.id, "categoryId", v)}
        />
      </td>
      <td className="w-[140px] py-2 pr-3 text-xs text-muted-foreground">
        <EditableAccountCell
          value={offset.accountId}
          label={offset.account.name}
          accounts={accounts}
          onSave={(v) => onInlineUpdate(offset.id, "accountId", v)}
        />
      </td>
      <td className="w-[30px] py-2 text-center">
        <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white ${offset.account.isJoint ? "bg-blue-500" : "bg-gray-400"}`}>
          {offset.account.isJoint ? "J" : "P"}
        </span>
      </td>
      <td className="w-[100px] py-2 text-right text-xs font-semibold text-green-600">
        <EditableAmountCell value={offset.amount} onSave={(v) => onInlineUpdate(offset.id, "amount", v)} isOffset />
      </td>
      <td className="w-[60px] py-2 text-right">
        <button onClick={() => onEdit(offset)} className="rounded p-1 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent">
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

// ── Parent row with offset sub-rows ──
function ExpenseRowWithOffsets({
  expense, onEdit, onInlineUpdate, onCreateOffset, vendors, accounts, categories, isUpcoming,
}: {
  expense: Expense;
  onEdit: (e: Expense) => void;
  onInlineUpdate: (id: string, field: string, value: string) => Promise<void>;
  onCreateOffset: (e: Expense) => void;
  isUpcoming?: boolean;
  vendors: string[];
  accounts: Account[];
  categories: Category[];
}) {
  const offsets = expense.offsets ?? [];
  const hasOffsets = offsets.length > 0;
  const offsetTotal = offsets.reduce((sum, o) => sum + Math.abs(parseFloat(o.amount)), 0);
  const parentAmount = parseFloat(expense.amount);
  const isFullyReimbursed = hasOffsets && offsetTotal >= parentAmount;

  const isUncategorized = !expense.categoryId;
  const isRecurring = !!expense.recurrenceRuleId;

  const rowBg = isUncategorized
    ? "bg-red-50/50 hover:bg-red-50"
    : isFullyReimbursed
    ? "bg-green-50/50 hover:bg-green-50"
    : isRecurring
    ? "bg-blue-50/50 hover:bg-blue-50"
    : expense.isReimbursementExpected
    ? "bg-amber-50/50 hover:bg-amber-50"
    : "hover:bg-muted/50";

  const upcomingClass = isUpcoming ? "italic opacity-60" : "";

  // Determine reimbursement status icon
  const StatusIcon = () => {
    if (isFullyReimbursed) {
      return <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-500" title="Fully reimbursed" />;
    }
    if (expense.isReimbursementExpected) {
      return <AlertCircle className="h-4 w-4 flex-shrink-0 text-amber-500" title={expense.reimbursementNote ?? "Reimbursement expected"} />;
    }
    return null;
  };

  return (
    <>
      <tr className={`${rowBg} ${upcomingClass}`}>
        <td className="w-[70px] py-3 pr-3">
          <EditableCell value={expense.date} type="date" onSave={(v) => onInlineUpdate(expense.id, "date", v)} />
        </td>
        <td className="py-3 pr-3">
          <div className="flex items-center gap-2">
            <StatusIcon />
            {isRecurring && <Repeat className="h-3.5 w-3.5 flex-shrink-0 text-blue-500" title="Recurring expense" />}
            <EditableCell value={expense.description} onSave={(v) => onInlineUpdate(expense.id, "description", v)} className="font-medium" />
            {expense.tags.length > 0 && (
              <div className="flex gap-1">
                {expense.tags.map(({ tag }) => (
                  <span key={tag.id} className="rounded-full px-1.5 py-0.5 text-xs font-medium" style={{ backgroundColor: tag.color ? `${tag.color}25` : "hsl(var(--muted))", color: tag.color ?? "inherit" }}>
                    {tag.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </td>
        <td className="w-[170px] py-3 pr-3">
          <EditableVendorCell value={expense.vendor} vendors={vendors} onSave={(v) => onInlineUpdate(expense.id, "vendor", v)} />
        </td>
        <td className="w-[190px] py-3 pr-3">
          <EditableCategoryCell value={expense.categoryId} label={expense.category?.name ?? ""} categories={categories} isUncategorized={isUncategorized} onSave={(v) => onInlineUpdate(expense.id, "categoryId", v)} />
        </td>
        <td className="w-[140px] py-3 pr-3">
          <EditableAccountCell value={expense.accountId} label={expense.account.name} accounts={accounts} onSave={(v) => onInlineUpdate(expense.id, "accountId", v)} />
        </td>
        <td className="w-[30px] py-3 text-center">
          <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white ${expense.account.isJoint ? "bg-blue-500" : "bg-gray-400"}`}>
            {expense.account.isJoint ? "J" : "P"}
          </span>
        </td>
        <td className="w-[100px] py-3 text-right font-semibold text-destructive">
          <EditableAmountCell value={expense.amount} onSave={(v) => onInlineUpdate(expense.id, "amount", v)} />
        </td>
        <td className="w-[60px] py-3 text-right">
          <div className="flex items-center justify-end gap-0.5">
            <button onClick={() => onCreateOffset(expense)} className="rounded p-1 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent" title="Add offset / reimbursement">
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => onEdit(expense)} className="rounded p-1 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent">
              <Pencil className="h-4 w-4" />
            </button>
          </div>
        </td>
      </tr>
      {offsets.map((offset) => (
        <OffsetRow
          key={offset.id}
          offset={offset}
          onEdit={onEdit}
          onInlineUpdate={onInlineUpdate}
          accounts={accounts}
          categories={categories}
          isUpcoming={isUpcoming}
        />
      ))}
    </>
  );
}

// ── Collapsible group ──
function GroupRows({
  groupName, expenses, collapsed, onToggle, onEdit, onInlineUpdate, onCreateOffset, firstExpense, vendors, accounts, categories,
}: {
  groupName: string;
  expenses: Expense[];
  collapsed: boolean;
  onToggle: () => void;
  onEdit: (e: Expense) => void;
  onInlineUpdate: (id: string, field: string, value: string) => Promise<void>;
  onCreateOffset: (e: Expense) => void;
  firstExpense: Expense;
  vendors: string[];
  accounts: Account[];
  categories: Category[];
}) {
  const totalAmount = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);

  if (collapsed) {
    return (
      <tr className="bg-muted/30 hover:bg-muted/50">
        <td className="w-[70px] py-3 pr-3">{formatDate(firstExpense.date)}</td>
        <td className="py-3 pr-3">
          <button onClick={onToggle} className="flex items-center gap-1.5 font-medium text-primary">
            <ChevronRight className="h-3.5 w-3.5" />
            {groupName}
            <span className="text-xs font-normal text-muted-foreground">({expenses.length} items)</span>
          </button>
        </td>
        <td className="w-[170px] py-3 pr-3 text-muted-foreground">{firstExpense.vendor}</td>
        <td className="w-[190px] py-3 pr-3">{firstExpense.category?.name ?? <span className="text-red-500">[Uncategorized]</span>}</td>
        <td className="w-[140px] py-3 pr-3">{firstExpense.account.name}</td>
        <td className="w-[30px] py-3 text-center">
          <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white ${firstExpense.account.isJoint ? "bg-blue-500" : "bg-gray-400"}`}>
            {firstExpense.account.isJoint ? "J" : "P"}
          </span>
        </td>
        <td className="w-[100px] py-3 text-right font-semibold text-destructive">-{formatCurrency(totalAmount)}</td>
        <td className="w-[60px] py-3 text-right">
          <button onClick={() => onEdit(firstExpense)} className="rounded p-1 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent"><Pencil className="h-4 w-4" /></button>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr className="bg-muted/30">
        <td colSpan={8} className="py-2">
          <button onClick={onToggle} className="flex items-center gap-1.5 font-medium text-primary text-sm">
            <ChevronDown className="h-3.5 w-3.5" />
            {groupName}
            <span className="text-xs font-normal text-muted-foreground">({expenses.length} items &middot; total: -{formatCurrency(totalAmount)})</span>
          </button>
        </td>
      </tr>
      {expenses.map((expense) => (
        <ExpenseRowWithOffsets key={expense.id} expense={expense} onEdit={onEdit} onInlineUpdate={onInlineUpdate} onCreateOffset={onCreateOffset} vendors={vendors} accounts={accounts} categories={categories} />
      ))}
    </>
  );
}

// ── Modal ──
interface ExpenseModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>, updateFuture?: boolean) => Promise<void>;
  onDelete: (id: string, deleteFuture?: boolean) => Promise<void>;
  onRecurringDelete: (id: string) => void;
  expense: Expense | null;
  offsetParent: Expense | null;
  categories: Category[];
  accounts: Account[];
  tags: Tag[];
  vendors: string[];
}

function ExpenseModal({ open, onClose, onSave, onDelete, onRecurringDelete, expense, offsetParent, categories, accounts, tags, vendors }: ExpenseModalProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isReimbursementExpected, setIsReimbursementExpected] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showOptional, setShowOptional] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>("");
  const [showRecurringConfirm, setShowRecurringConfirm] = useState(false);
  const [pendingSaveData, setPendingSaveData] = useState<Record<string, unknown> | null>(null);

  const isOffsetMode = !!offsetParent && !expense;

  useEffect(() => {
    if (open) {
      if (isOffsetMode) {
        // Offset mode: inherit parent's tags, category; no reimbursement/recurring
        setSelectedTagIds(offsetParent.tags.map((t) => t.tagId));
        setIsReimbursementExpected(false);
        setIsRecurring(false);
        setConfirmDelete(false);
        setSelectedCategoryId(offsetParent.categoryId ?? "");
        setShowOptional(false);
      } else {
        setSelectedTagIds(expense?.tags.map((t) => t.tagId) ?? []);
        setIsReimbursementExpected(expense?.isReimbursementExpected ?? false);
        setIsRecurring(!!expense?.recurrenceRuleId);
        setConfirmDelete(false);
        setSelectedCategoryId(expense?.categoryId ?? "");
        // Auto-expand optional if any optional fields have data
        setShowOptional(!!(expense?.notes || expense?.isReimbursementExpected || expense?.recurrenceRuleId));
        setShowRecurringConfirm(false);
        setPendingSaveData(null);
      }
    }
  }, [open, expense, offsetParent, isOffsetMode]);

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  };

  const handleVendorSelect = async (vendor: string) => {
    if (!expense && vendor) {
      try {
        const result = await getVendorCategory(vendor);
        if (result.categoryId) {
          setSelectedCategoryId(result.categoryId);
        }
      } catch { /* ignore */ }
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    const form = new FormData(e.currentTarget);

    const rawAmount = parseFloat(form.get("amount") as string);

    // Determine recurrenceRuleId
    let recurrenceRuleId: string | null | undefined = isOffsetMode
      ? null
      : isRecurring
        ? (expense?.recurrenceRuleId ?? null)
        : null;

    // If recurring is toggled on and no rule exists yet, create one first
    if (isRecurring && !recurrenceRuleId && !isOffsetMode) {
      try {
        const rule = await createRecurrenceRule({
          description: form.get("description") as string,
          vendor: form.get("vendor") as string,
          amount: rawAmount,
          frequency: form.get("frequency") as string,
          interval: parseInt(form.get("interval") as string) || 1,
          startDate: form.get("date") as string,
          endDate: (form.get("endDate") as string) || undefined,
          categoryId: form.get("categoryId") as string,
          accountId: form.get("accountId") as string,
        });
        recurrenceRuleId = rule.id;
      } catch { /* ignore */ }
    }

    const expenseData: Record<string, unknown> = {
      amount: isOffsetMode ? -Math.abs(rawAmount) : rawAmount,
      description: form.get("description") as string,
      vendor: form.get("vendor") as string,
      date: form.get("date") as string,
      categoryId: form.get("categoryId") as string || null,
      accountId: form.get("accountId") as string,
      notes: (form.get("notes") as string) || undefined,
      isReimbursementExpected: isOffsetMode ? false : isReimbursementExpected,
      reimbursementNote: isOffsetMode ? null : isReimbursementExpected
        ? (form.get("reimbursementNote") as string) || undefined
        : null,
      tagIds: selectedTagIds,
      recurrenceRuleId,
    };

    if (isOffsetMode) {
      expenseData.parentExpenseId = offsetParent.id;
    }

    // If editing a recurring expense, show confirmation dialog
    if (expense?.recurrenceRuleId) {
      setPendingSaveData(expenseData);
      setShowRecurringConfirm(true);
      setSaving(false);
      return;
    }

    await onSave(expenseData);
    setSaving(false);
  };

  const handleRecurringSaveChoice = async (updateFuture: boolean) => {
    if (!pendingSaveData) return;
    setSaving(true);
    await onSave(pendingSaveData, updateFuture);
    setSaving(false);
    setShowRecurringConfirm(false);
    setPendingSaveData(null);
  };

  const handleDeleteClick = async () => {
    if (!expense) return;
    // For recurring expenses, use the parent's recurring confirm dialog
    if (expense.recurrenceRuleId) {
      onRecurringDelete(expense.id);
      return;
    }
    // Non-recurring: two-click confirmation
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setDeleting(true);
    await onDelete(expense.id);
    setDeleting(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={isOffsetMode ? "Add Offset" : expense ? "Edit Expense" : "Add Expense"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {isOffsetMode && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            Offset for: <span className="font-medium text-foreground">{offsetParent.description}</span> ({formatCurrency(offsetParent.amount)})
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium">Amount</label>
          <CurrencyInput name="amount" defaultValue={isOffsetMode ? offsetParent.amount : expense?.amount} required />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Description</label>
          <input
            name="description"
            type="text"
            required
            defaultValue={isOffsetMode ? offsetParent.description : expense?.description ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="What did you spend on?"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Vendor</label>
          <VendorAutocomplete
            name="vendor"
            defaultValue={isOffsetMode ? offsetParent.vendor : expense?.vendor}
            vendors={vendors}
            onSelect={handleVendorSelect}
            required
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Date</label>
            <input
              name="date"
              type="date"
              required
              defaultValue={isOffsetMode ? toDateInputValue(offsetParent.date) : toDateInputValue(expense?.date)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Account</label>
            <AccountTypeahead
              name="accountId"
              required
              defaultValue={isOffsetMode ? "" : expense?.accountId ?? ""}
              accounts={accounts}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Category</label>
          <CategoryTypeahead
            name="categoryId"
            defaultValue={selectedCategoryId}
            categories={categories}
            required
          />
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

        {/* Collapsible optional section — hidden in offset mode */}
        {!isOffsetMode && (
          <div className="border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setShowOptional(!showOptional)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {showOptional ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              More options
            </button>
            {showOptional && (
              <div className="mt-3 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">Notes</label>
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
                  {isRecurring && !expense?.recurrenceRuleId && (
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">Frequency</label>
                        <select name="frequency" defaultValue="MONTHLY" className="w-full rounded-md border border-border px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary">
                          {Object.entries(FREQUENCY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">Interval</label>
                        <input name="interval" type="number" min="1" defaultValue="1" className="w-full rounded-md border border-border px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" />
                      </div>
                      <div className="col-span-2">
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">End Date</label>
                        <input name="endDate" type="date" className="w-full rounded-md border border-border px-2 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Notes field for offset mode (standalone, no reimbursement/recurring) */}
        {isOffsetMode && (
          <div>
            <label className="mb-1 block text-sm font-medium">Notes</label>
            <textarea
              name="notes"
              rows={2}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="e.g. Refund received, reimbursement from employer..."
            />
          </div>
        )}

        {showRecurringConfirm ? (
          <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
            <p className="text-sm font-medium">Update Recurring Expense</p>
            <p className="text-sm text-muted-foreground">
              Would you like to update only this instance, or all future pending instances?
            </p>
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="secondary"
                className="w-full justify-center"
                disabled={saving}
                onClick={() => handleRecurringSaveChoice(false)}
              >
                This instance only
              </Button>
              <Button
                type="button"
                className="w-full justify-center"
                disabled={saving}
                onClick={() => handleRecurringSaveChoice(true)}
              >
                {saving ? "Saving..." : "Update all future pending instances"}
              </Button>
              <button
                type="button"
                className="mt-1 text-sm text-muted-foreground hover:text-foreground"
                onClick={() => { setShowRecurringConfirm(false); setPendingSaveData(null); }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
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
                {saving ? "Saving..." : isOffsetMode ? "Add Offset" : expense ? "Update" : "Add Expense"}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}
