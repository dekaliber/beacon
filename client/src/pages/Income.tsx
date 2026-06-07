import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import {
  Plus, Pencil, TrendingUp, ChevronRight, Calculator,
  ArrowUpDown, ArrowUp, ArrowDown, Filter, Trash2, ChevronDown, Search,
  Upload, FileText, Check, CheckCircle2, AlertCircle,
} from "lucide-react";
import { BulkEditBar } from "@/components/BulkEditBar";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { MultiSelectDropdown } from "@/components/MultiSelectDropdown";
import type { MultiSelectOption, MultiSelectGroup } from "@/components/MultiSelectDropdown";
import { useApi, getApiCache } from "@/hooks/useApi";
import { getIncome, getAccounts, getFlatCategories, createIncome, updateIncome, deleteIncome, importIncome, bulkUpdateIncome, bulkDeleteIncome } from "@/api";
import { formatCurrency, formatDate, toDateInputValue, localToday } from "@/lib/utils";
import type { Account, Category, Income } from "@/types";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel, ColumnHeader } from "@/components/Typography";
import { ItemTypeahead } from "@/components/ItemTypeahead";
import { CategoryTypeahead } from "@/components/CategoryTypeahead";

const INCOME_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "INVESTMENT"];

type SortField = "date" | "category" | "account" | "amount";
type SortState = { field: SortField; order: "asc" | "desc" } | null;

// ── Currency input ──
function CurrencyInput({ name, defaultValue, autoFocus, error, onValidChange }: { name: string; defaultValue?: string; required?: boolean; autoFocus?: boolean; error?: boolean; onValidChange?: () => void }) {
  const [rawValue, setRawValue] = useState(() => {
    if (!defaultValue) return "";
    const num = parseFloat(defaultValue);
    return num ? num.toFixed(2) : "";
  });

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
      if (parseFloat(val) > 0) onValidChange?.();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    const cleaned = pasted.replace(/[$,\s]/g, "");
    if (cleaned === "" || /^\d*\.?\d{0,2}$/.test(cleaned)) {
      e.preventDefault();
      setRawValue(cleaned);
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
          onPaste={handlePaste}
          onBlur={handleBlur}
          autoFocus={autoFocus}
          className={`w-full rounded-md border pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-1 ${error ? "border-down focus:border-down focus:ring-down/30" : "border-border focus:border-primary focus:ring-primary"}`}
          placeholder="0.00"
          inputMode="text"
        />
      </div>
      <input type="hidden" name={name} value={numericValue.toFixed(2)} />
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

  if (type === "date") {
    if (editing) {
      return (
        <DatePicker
          variant="ghost"
          autoFocus
          autoOpen
          confirmOnEnter
          hideIcon
          value={toDateInputValue(value)}
          onChange={(v) => { if (v && v !== toDateInputValue(value)) onSave(v); }}
          onDismiss={() => setEditing(false)}
          className={className}
        />
      );
    }
    return (
      <span onClick={() => setEditing(true)} className={`cursor-pointer border-b border-dotted border-transparent hover:border-ink-4 ${className}`}>
        {formatDate(value)}
      </span>
    );
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setEditValue(value); setEditing(false); } }}
        className="w-full rounded border border-primary px-1 py-0.5 text-sm focus:outline-none"
      />
    );
  }

  return (
    <span onClick={() => { setEditValue(value); setEditing(true); }} className={`cursor-pointer border-b border-dotted border-transparent hover:border-ink-4 ${className}`}>
      {value || <span className="text-muted-foreground italic">—</span>}
    </span>
  );
}

// ── Inline typeahead cell (shared for category, account, etc.) ──
function EditableTypeaheadCell({
  value, label, color, items, onSave,
}: {
  value: string | null;
  label: string;
  color?: string | null;
  items: { id: string; name: string }[];
  onSave: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ top?: number; bottom?: number; left: number; minWidth: number }>({ left: 0, minWidth: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(() =>
    [...items].sort((a, b) => a.name.localeCompare(b.name)),
    [items],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return sorted;
    const terms = search.toLowerCase().split(/\s+/);
    return sorted.filter((item) => {
      const words = item.name.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    });
  }, [search, sorted]);

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

  const startEditing = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      if (window.innerHeight - rect.bottom < 220) {
        setDropdownPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, minWidth: rect.width });
      } else {
        setDropdownPos({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
      }
    }
    setSearch("");
    setEditing(true);
  };

  return (
    <div ref={ref}>
      {editing ? (
        <>
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type to filter..."
            className="w-full rounded border border-primary px-1 py-0.5 text-sm focus:outline-none"
          />
          <div
            style={{ position: "fixed", top: dropdownPos.top, bottom: dropdownPos.bottom, left: dropdownPos.left, minWidth: Math.max(dropdownPos.minWidth, 180), zIndex: 9999 }}
            className="rounded-md border border-border bg-background shadow-lg"
          >
            <div className="max-h-48 overflow-auto">
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
              ) : (
                filtered.map((item, i) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`block w-full px-3 py-1.5 text-left text-13 ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted"}`}
                    onMouseDown={() => selectItem(item.id)}
                  >
                    {item.name}
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      ) : color != null ? (
        <span
          onClick={startEditing}
          className="inline-block cursor-pointer whitespace-nowrap rounded-md px-2 py-0.5 text-13 text-foreground"
          style={{ backgroundColor: color }}
        >
          {label}
        </span>
      ) : (
        <span onClick={startEditing} className="cursor-pointer border-b border-dotted border-transparent hover:border-ink-4">
          {label || <span className="text-muted-foreground italic">—</span>}
        </span>
      )}
    </div>
  );
}

// ── Inline category typeahead cell (two-level hierarchy) ──
function EditableCategoryCell({
  value, label, categories, onSave,
}: {
  value: string | null;
  label: string;
  categories: Category[];
  onSave: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ top?: number; bottom?: number; left: number; minWidth: number }>({ left: 0, minWidth: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
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
        const target = e.target as Node;
        if (
          ref.current && !ref.current.contains(target) &&
          dropdownRef.current && !dropdownRef.current.contains(target)
        ) {
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

  const startEditing = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      if (window.innerHeight - rect.bottom < 220) {
        setDropdownPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, minWidth: rect.width });
      } else {
        setDropdownPos({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
      }
    }
    setSearch("");
    setEditing(true);
  };

  return (
    <div ref={ref}>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type to filter..."
          className="w-full rounded border border-primary px-1 py-0.5 text-sm focus:outline-none"
        />
      ) : (
        <span onClick={startEditing} className="cursor-pointer border-b border-dotted border-transparent hover:border-ink-4">
          {label || <span className="text-muted-foreground italic">—</span>}
        </span>
      )}
      {editing && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: "fixed", top: dropdownPos.top, bottom: dropdownPos.bottom, left: dropdownPos.left, minWidth: Math.max(dropdownPos.minWidth, 220), zIndex: 9999 }}
          className="rounded-md border border-border bg-background shadow-lg"
        >
          <div className="max-h-48 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
            ) : (
              filtered.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-sm ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted"}`}
                  onMouseDown={() => selectItem(o.id)}
                >
                  {o.parentLabel && <span className="text-muted-foreground">{o.parentLabel} &gt; </span>}
                  {o.label}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
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
          inputMode="text"
        />
      </div>
    );
  }

  return (
    <span onClick={startEdit} className="cursor-pointer border-b border-dotted border-transparent hover:border-ink-4">
      {positive ? "+" : "-"}{formatCurrency(value)}
    </span>
  );
}

// ── Tax status badge + inline-editable cell ──
const DIVIDEND_TYPE_LABELS: Record<string, string> = {
  QUALIFIED: "Qualified",
  ORDINARY: "Ordinary",
  TAX_EXEMPT: "Tax-Exempt",
  RETURN_OF_CAPITAL: "Return of Capital",
  CAPITAL_GAIN: "Capital Gain",
};
const DIVIDEND_TYPE_CLASSES: Record<string, string> = {
  QUALIFIED: "bg-up-soft text-up-deep",
  ORDINARY: "bg-slate-soft text-slate-deep",
  TAX_EXEMPT: "bg-teal-soft text-teal-deep",
  RETURN_OF_CAPITAL: "bg-warn-soft text-warn-deep",
  CAPITAL_GAIN: "bg-blue-soft text-blue-deep",
};
const DIVIDEND_TYPE_OPTIONS = [
  { value: "", label: "Not specified" },
  { value: "CAPITAL_GAIN", label: "Capital Gain" },
  { value: "ORDINARY", label: "Ordinary" },
  { value: "QUALIFIED", label: "Qualified" },
  { value: "RETURN_OF_CAPITAL", label: "Return of Capital" },
  { value: "TAX_EXEMPT", label: "Tax-Exempt" },
];

function TaxStatusBadge({ taxClassification }: { taxClassification: string | null }) {
  if (!taxClassification) return null;
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-10 font-medium ${DIVIDEND_TYPE_CLASSES[taxClassification] ?? "bg-slate-soft text-slate-deep"}`}>
      {DIVIDEND_TYPE_LABELS[taxClassification] ?? taxClassification}
    </span>
  );
}

function EditableTaxStatusCell({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top?: number; bottom?: number; left: number; minWidth: number }>({ left: 0, minWidth: 0 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setEditing(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing]);

  const startEditing = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      if (window.innerHeight - rect.bottom < 220) {
        setDropdownPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, minWidth: Math.max(rect.width, 160) });
      } else {
        setDropdownPos({ top: rect.bottom + 4, left: rect.left, minWidth: Math.max(rect.width, 160) });
      }
    }
    setEditing(true);
  };

  const selectValue = (v: string) => {
    setEditing(false);
    const next = v || null;
    if (next !== value) onSave(next);
  };

  return (
    <div ref={ref}>
      {editing ? (
        <div
          style={{ position: "fixed", top: dropdownPos.top, bottom: dropdownPos.bottom, left: dropdownPos.left, minWidth: dropdownPos.minWidth, zIndex: 9999 }}
          className="rounded-md border border-border bg-background shadow-lg"
        >
          {DIVIDEND_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted ${opt.value === (value ?? "") ? "bg-primary/10" : ""}`}
              onClick={() => selectValue(opt.value)}
            >
              {opt.value ? <TaxStatusBadge taxClassification={opt.value} /> : <span className="text-muted-foreground italic">Not specified</span>}
            </button>
          ))}
        </div>
      ) : null}
      <span onClick={startEditing} className="cursor-pointer">
        {value
          ? <TaxStatusBadge taxClassification={value} />
          : <span className="border-b border-dotted border-transparent text-muted-foreground hover:border-ink-4">—</span>
        }
      </span>
    </div>
  );
}


// ═══════════════ MAIN COMPONENT ═══════════════

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

// Compute the cache key for the first page of income using the same logic as the filterParams
// useMemo + queryParams useMemo in the component. Used to pre-populate allIncomes from cache
// on mount so the list is visible on the very first render (no empty-state flash on navigation).
function getInitialIncomeData(): Income[] {
  try {
    const applied = loadIncomeFilters();
    const todayStr = localToday();
    const params: Record<string, string> = { limit: "50", sortBy: "date", sortOrder: "desc" };
    if (applied.accountIds.length > 0) params.accountIds = applied.accountIds.join(",");
    if (applied.categoryIds.length > 0) params.categoryIds = applied.categoryIds.join(",");
    params.startDate = applied.startDate || INCOME_DEFAULT_FILTERS.startDate;
    const endDate = applied.endDate || todayStr;
    params.endDate = endDate > todayStr ? todayStr : endDate;
    if (!applied.showOnlyReceived) params.showOnlyReceived = "false";
    params.page = "1";
    return getApiCache<{ data: Income[] }>(`income-${JSON.stringify(params)}`)?.data ?? [];
  } catch {
    return [];
  }
}

export function IncomePage() {
  const [currentPage, setCurrentPage] = useState(1);
  const [allIncomes, setAllIncomes] = useState<Income[]>(getInitialIncomeData);
  const [hasMore, setHasMore] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const isFirstMount = useRef(true);
  // Tracks which page number we're expecting next; discards stale out-of-order responses
  // that fire when filterParams changes but currentPage hasn't reset to 1 yet.
  const expectedPageRef = useRef(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [editing, setEditing] = useState<Income | null>(null);
  const [sort, setSort] = useState<SortState>({ field: "date", order: "desc" });
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState(""); // raw input value
  const [appliedSearch, setAppliedSearch] = useState(""); // committed on Enter, drives API
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [staged, setStaged] = useState<IncomeFilterState>(loadIncomeFilters);
  const [applied, setApplied] = useState<IncomeFilterState>(loadIncomeFilters);

  const todayStr = useMemo(() => localToday(), []);

  const dateRangePresets = useMemo(() => {
    const today = new Date();
    const year = today.getFullYear();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const pastYear = new Date(today); pastYear.setFullYear(pastYear.getFullYear() - 1); pastYear.setDate(pastYear.getDate() + 1);
    const past90 = new Date(today); past90.setDate(past90.getDate() - 90);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    return [
      { label: "This year", start: `${year}-01-01`, end: "" },
      { label: String(year - 1), start: `${year - 1}-01-01`, end: `${year - 1}-12-31` },
      { label: "Past year", start: fmt(pastYear), end: "" },
      { label: "Past 90 days", start: fmt(past90), end: "" },
      { label: "This month", start: `${year}-${pad(today.getMonth() + 1)}-01`, end: "" },
      { label: "Last month", start: fmt(lastMonthStart), end: fmt(lastMonthEnd) },
    ];
  }, []);
  const tomorrowStr = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const filterParams = useMemo(() => {
    const params: Record<string, string> = { limit: "50" };
    if (sort) {
      params.sortBy = sort.field;
      params.sortOrder = sort.order;
    }
    if (applied.accountIds.length > 0) params.accountIds = applied.accountIds.join(",");
    if (applied.categoryIds.length > 0) params.categoryIds = applied.categoryIds.join(",");
    if (appliedSearch.trim()) params.search = appliedSearch.trim();
    const isDefaultDateFilter = (
      applied.startDate === INCOME_DEFAULT_FILTERS.startDate &&
      applied.endDate === INCOME_DEFAULT_FILTERS.endDate
    );
    if (appliedSearch.trim() && isDefaultDateFilter) {
      // Search overrides default date range — return all matching transactions
      params.endDate = todayStr;
    } else {
      params.startDate = applied.startDate || INCOME_DEFAULT_FILTERS.startDate;
      const endDate = applied.endDate || todayStr;
      params.endDate = endDate > todayStr ? todayStr : endDate;
    }
    if (!applied.showOnlyReceived) params.showOnlyReceived = "false";
    return params;
  }, [sort, applied, todayStr, appliedSearch]);

  const queryParams = useMemo(() => ({
    ...filterParams,
    page: currentPage.toString(),
  }), [filterParams, currentPage]);

  const upcomingParams = useMemo(() => ({
    startDate: tomorrowStr,
    sortBy: "date",
    sortOrder: "asc",
    limit: "100",
  }), [tomorrowStr]);

  const { data: incomeData, loading } = useApi(() => getIncome(queryParams), [queryParams], `income-${JSON.stringify(queryParams)}`);
  const { data: upcomingData, refetch: refetchUpcoming } = useApi(() => getIncome(upcomingParams), [upcomingParams], `income-upcoming-${JSON.stringify(upcomingParams)}`);
  const { data: accounts } = useApi(() => getAccounts({ includeHidden: true }), [], "accounts");
  const { data: incomeCategories } = useApi(() => getFlatCategories("INCOME"), [], "categories-INCOME");

  // Reset accumulated data when filters/sort change (skip on initial mount to preserve cached data)
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return; }
    expectedPageRef.current = 1;
    setCurrentPage(1);
    setAllIncomes([]);
    setHasMore(false);
    loadingMoreRef.current = false;
  }, [filterParams]);

  // Accumulate income pages as they load
  useEffect(() => {
    if (!incomeData) return;
    const { data, pagination: pag } = incomeData;
    // Discard stale responses: when filterParams changes, currentPage resets to 1
    // asynchronously (via useEffect), causing an intermediate render where queryParams
    // briefly becomes newFilter+oldPage. That spurious request's response would otherwise
    // append out-of-order data and skip intermediate pages.
    if (pag.page !== expectedPageRef.current) return;
    if (pag.page === 1) {
      setAllIncomes(data ?? []);
    } else {
      setAllIncomes((prev) => [...prev, ...(data ?? [])]);
    }
    expectedPageRef.current = pag.page + 1;
    setHasMore(pag.page < pag.totalPages);
    loadingMoreRef.current = false;
  }, [incomeData]);

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
      { rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore]);

  useEffect(() => {
    const handleScroll = () => setShowBackToTop(window.scrollY > 2500);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // "a" keyboard shortcut to open Add Income modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (modalOpen || importModalOpen) return;
      const target = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
      if (e.key === "a" || e.key === "A") {
        setEditing(null);
        setModalOpen(true);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen, importModalOpen]);

  const eligibleAccounts = (accounts ?? []).filter((a) => INCOME_ACCOUNT_TYPES.includes(a.type) && !a.isHidden);
  const categories = incomeCategories ?? [];

  const categoryFilterOptions = useMemo<MultiSelectOption[]>(() => {
    const opts: MultiSelectOption[] = [];
    const parents = categories.filter((c) => !c.parentId);
    const children = categories.filter((c) => c.parentId);
    for (const parent of parents) {
      const kids = children.filter((c) => c.parentId === parent.id);
      if (kids.length === 0) {
        opts.push({ id: parent.id, label: parent.name });
      } else {
        for (const child of kids) {
          opts.push({ id: child.id, label: `${parent.name} > ${child.name}` });
        }
      }
    }
    return opts;
  }, [categories]);

  const hasActiveFilters = !!(
    applied.accountIds.length > 0 ||
    applied.categoryIds.length > 0 ||
    applied.startDate !== INCOME_DEFAULT_FILTERS.startDate ||
    (applied.endDate && applied.endDate !== todayStr)
  );

  const refreshLoaded = useCallback(async () => {
    const pagesToRefresh = Math.max(currentPage, 1);
    const freshItems: Income[] = [];
    let moreAvailable = false;

    for (let p = 1; p <= pagesToRefresh; p++) {
      const result = await getIncome({ ...filterParams, page: String(p) });
      if (!result) break;
      freshItems.push(...(result.data ?? []));
      moreAvailable = p < result.pagination.totalPages;
      if (p >= result.pagination.totalPages) break;
    }

    setAllIncomes(freshItems);
    setHasMore(moreAvailable);
    // Keep expectedPageRef in sync since we bypassed the accumulate effect
    expectedPageRef.current = pagesToRefresh + 1;
  }, [currentPage, filterParams]);

  const refetchAll = useCallback(() => {
    refreshLoaded();
    refetchUpcoming();
  }, [refreshLoaded, refetchUpcoming]);

  const handleSave = async (formData: Record<string, unknown>) => {
    if (editing) { await updateIncome(editing.id, formData); }
    else { await createIncome(formData); }
    setModalOpen(false);
    setEditing(null);
    refetchAll();
  };

  const handleDelete = async (id: string) => {
    await deleteIncome(id);
    setModalOpen(false);
    setEditing(null);
    refetchAll();
  };

  const handleInlineUpdate = useCallback(async (id: string, field: string, value: string | null) => {
    const data: Record<string, unknown> = {};
    if (field === "date") data.date = value;
    else if (field === "amount") data.amount = parseFloat(value as string);
    else data[field] = value;
    await updateIncome(id, data);
    refetchAll();
  }, [refetchAll]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleSort = (field: SortField) => {
    setSort((prev) => {
      const defaultDesc = field === "date" || field === "amount";
      const first = defaultDesc ? "desc" : "asc";
      const second = defaultDesc ? "asc" : "desc";
      if (!prev || prev.field !== field) return { field, order: first };
      if (prev.order === first) return { field, order: second };
      return null;
    });
  };

  const applyFilters = () => {
    setApplied({ ...staged });
    saveIncomeFilters(staged);
  };


  const resetFilters = () => {
    setStaged({ ...INCOME_DEFAULT_FILTERS });
    setApplied({ ...INCOME_DEFAULT_FILTERS });
    saveIncomeFilters(INCOME_DEFAULT_FILTERS);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (!sort || sort.field !== field) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    return sort.order === "asc" ? <ArrowUp className="ml-1 inline h-3 w-3" /> : <ArrowDown className="ml-1 inline h-3 w-3" />;
  };

  const incomes = useMemo(() => {
    if (!appliedSearch.trim()) return allIncomes;
    const q = appliedSearch.toLowerCase();
    return allIncomes.filter((inc) =>
      (inc.category?.name ?? "").toLowerCase().includes(q) ||
      (inc.source ?? "").toLowerCase().includes(q) ||
      parseFloat(inc.amount).toFixed(2).includes(q)
    );
  }, [allIncomes, appliedSearch]);

  const anchorIdxRef = useRef<number | null>(null);
  const anchorUpcomingIdxRef = useRef<number | null>(null);

  const handleCheckboxChange = useCallback((id: string, idx: number, e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey && anchorIdxRef.current !== null) {
      const anchor = anchorIdxRef.current;
      // Apply the clicked item's toggled state to the entire anchor→clicked range
      const newState = !selectedIds.has(id);
      const start = Math.min(anchor, idx);
      const end = Math.max(anchor, idx);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        incomes.slice(start, end + 1).forEach((item) => {
          if (newState) next.add(item.id);
          else next.delete(item.id);
        });
        return next;
      });
    } else {
      toggleSelect(id);
    }
    anchorIdxRef.current = idx;
  }, [incomes, toggleSelect, selectedIds]);

  const upcomingIncomes = useMemo(() => {
    const all = upcomingData?.data ?? [];
    if (!appliedSearch.trim()) return all;
    const q = appliedSearch.toLowerCase();
    return all.filter((inc) =>
      (inc.category?.name ?? "").toLowerCase().includes(q) ||
      (inc.source ?? "").toLowerCase().includes(q) ||
      parseFloat(inc.amount).toFixed(2).includes(q)
    );
  }, [upcomingData, appliedSearch]);

  const allUpcomingIncomeIds = useMemo(() => upcomingIncomes.map((i) => i.id), [upcomingIncomes]);

  const handleUpcomingCheckboxChange = useCallback((id: string, idx: number, e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey && anchorUpcomingIdxRef.current !== null) {
      const anchor = anchorUpcomingIdxRef.current;
      const newState = !selectedIds.has(id);
      const start = Math.min(anchor, idx);
      const end = Math.max(anchor, idx);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        upcomingIncomes.slice(start, end + 1).forEach((item) => {
          if (newState) next.add(item.id);
          else next.delete(item.id);
        });
        return next;
      });
    } else {
      toggleSelect(id);
    }
    anchorUpcomingIdxRef.current = idx;
  }, [upcomingIncomes, toggleSelect, selectedIds]);

  const accountFilterOptions = useMemo<MultiSelectOption[]>(() => {
    const personal = eligibleAccounts
      .filter((a) => !a.isJoint)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({ id: a.id, label: a.name, groupKey: "personal" }));
    const joint = eligibleAccounts
      .filter((a) => a.isJoint)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({ id: a.id, label: a.name, groupKey: "joint" }));
    return [...personal, ...joint];
  }, [eligibleAccounts]);

  const accountGroups = useMemo<MultiSelectGroup[]>(() =>
    [
      { key: "personal", label: "Personal" },
      { key: "joint", label: "Joint" },
    ].filter((g) => accountFilterOptions.some((o) => o.groupKey === g.key)),
  [accountFilterOptions]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <h2 className="tp-page-title">Income</h2>
        <div className="flex items-center gap-2">
          <Link
            to="/income/tax-estimator"
            className="tp-nav-link hover:bg-muted hover:text-ink"
          >
            <Calculator className="h-4 w-4" />
            Tax Estimator
          </Link>
          <div className="h-5 w-px bg-border" />
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); if (!e.target.value.trim()) setAppliedSearch(""); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") setAppliedSearch(searchQuery);
                if (e.key === "Escape") { setSearchQuery(""); setAppliedSearch(""); }
              }}
              placeholder="Search..."
              className="h-9 w-44 rounded-md border border-border bg-background pl-8 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <Button variant={filterOpen ? "primary" : "secondary"} className={filterOpen ? "" : "border border-border"} onClick={() => setFilterOpen(!filterOpen)}>
            <Filter className="h-4 w-4" />
            {hasActiveFilters && <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 text-xs">!</span>}
          </Button>
          <Button variant="secondary" className="border border-border" onClick={() => setImportModalOpen(true)}>
            <Upload className="h-4 w-4" /> Import
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
              <label className="block text-xs font-medium mb-1">Account</label>
              <MultiSelectDropdown
                options={accountFilterOptions}
                selected={staged.accountIds}
                onChange={(ids) => setStaged((s) => ({ ...s, accountIds: ids }))}
                placeholder="All Accounts"
                groups={accountGroups}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Category</label>
              <MultiSelectDropdown
                options={categoryFilterOptions}
                selected={staged.categoryIds}
                onChange={(ids) => setStaged((s) => ({ ...s, categoryIds: ids }))}
                placeholder="Categories"
                searchable
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Date Range</label>
              <div className="flex items-center gap-1.5">
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
                    className="appearance-none rounded-md border border-border py-2 pl-2 pr-6 text-sm text-foreground"
                  >
                    {dateRangePresets.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
                    <option value="Custom">Custom</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
                </div>
                <DatePicker value={staged.startDate} onChange={(v) => setStaged((s) => ({ ...s, startDate: v, datePreset: "Custom" }))} className="w-[136px]" />
                <span className="tp-caption">→</span>
                <DatePicker value={staged.endDate || todayStr} onChange={(v) => setStaged((s) => ({ ...s, endDate: v, datePreset: "Custom" }))} className="w-[136px]" />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs invisible select-none" aria-hidden="true">x</label>
              <div className="flex h-8 items-center gap-3">
                <button onClick={resetFilters} className="text-13 text-muted-foreground hover:text-foreground hover:underline">
                  Reset to defaults
                </button>
                <Button size="sm" onClick={applyFilters}>Apply</Button>
              </div>
            </div>
          </div>
          <div className="mt-3 border-t border-border pt-3 flex items-center gap-3">
            <button
              role="switch"
              aria-checked={staged.showOnlyReceived}
              onClick={() => setStaged((s) => ({ ...s, showOnlyReceived: !s.showOnlyReceived }))}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${staged.showOnlyReceived ? "bg-primary" : "bg-border"}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${staged.showOnlyReceived ? "translate-x-4" : "translate-x-0"}`} />
            </button>
            <span className="text-sm select-none cursor-pointer" onClick={() => setStaged((s) => ({ ...s, showOnlyReceived: !s.showOnlyReceived }))}>
              Show only received income
            </span>
          </div>
        </Card>
      )}

      {/* Upcoming income table */}
      {upcomingIncomes.length > 0 && (
        <Card>
          <SectionLabel as="h3" className="mb-3 text-sm">Upcoming</SectionLabel>
          <div className="hidden md:block">
            <table className="w-full table-fixed text-13">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="w-[44px] pb-3 pr-2 text-center">
                    <input
                      type="checkbox"
                      ref={(el) => { if (el) { el.indeterminate = allUpcomingIncomeIds.some((id) => selectedIds.has(id)) && !allUpcomingIncomeIds.every((id) => selectedIds.has(id)); } }}
                      checked={allUpcomingIncomeIds.length > 0 && allUpcomingIncomeIds.every((id) => selectedIds.has(id))}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedIds((prev) => new Set([...prev, ...allUpcomingIncomeIds]));
                        } else {
                          setSelectedIds((prev) => { const next = new Set(prev); allUpcomingIncomeIds.forEach((id) => next.delete(id)); return next; });
                        }
                      }}
                      className="h-4 w-4 rounded border-border align-text-top"
                    />
                  </th>
                  <ColumnHeader className="w-[70px] pb-3 pr-3">Date</ColumnHeader>
                  <ColumnHeader className="pb-3 pr-3">Source</ColumnHeader>
                  <ColumnHeader className="w-[130px] pb-3 pr-3">Category</ColumnHeader>
                  <ColumnHeader className="w-[115px] pb-3 pr-3">Tax Status</ColumnHeader>
                  <ColumnHeader className="w-[185px] pb-3 pr-3">Account</ColumnHeader>
                  <th className="w-[30px] pb-3"></th>
                  <ColumnHeader className="w-[90px] pb-3 text-right">Amount</ColumnHeader>
                  <th className="w-[40px] pb-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {upcomingIncomes.map((income, idx) => (
                  <tr key={income.id} className={`italic ${selectedIds.has(income.id) ? "bg-primary/5 opacity-80" : "opacity-60 hover:opacity-80"}`}>
                    <td className="w-[44px] py-2 pr-2 text-center">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(income.id)}
                        onChange={(e) => handleUpcomingCheckboxChange(income.id, idx, e)}
                        className="h-4 w-4 rounded border-border align-text-top"
                      />
                    </td>
                    <td className="w-[70px] py-2 pr-3">
                      <EditableCell value={income.date} type="date" onSave={(v) => handleInlineUpdate(income.id, "date", v)} />
                    </td>
                    <td className="py-2 pr-3">
                      <EditableCell value={income.source ?? ""} onSave={(v) => handleInlineUpdate(income.id, "source", v)} className="tp-row-label" />
                    </td>
                    <td className="w-[130px] py-2 pr-3">
                      <EditableCategoryCell
                        value={income.categoryId}
                        label={income.category?.name ?? ""}
                        categories={categories}
                        onSave={(v) => handleInlineUpdate(income.id, "categoryId", v)}
                      />
                    </td>
                    <td className="w-[115px] py-2 pr-3">
                      <TaxStatusBadge taxClassification={income.taxClassification} />
                    </td>
                    <td className="w-[185px] py-2 pr-3">
                      <EditableTypeaheadCell
                        value={income.accountId}
                        label={income.account.name}
                        items={eligibleAccounts}
                        onSave={(v) => handleInlineUpdate(income.id, "accountId", v)}
                      />
                    </td>
                    <td className="w-[30px] py-2 text-center">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded text-10 font-bold text-white" style={{ backgroundColor: income.account.isJoint ? JOINT_COLOR : PERSONAL_COLOR }}>
                        {income.account.isJoint ? "J" : "P"}
                      </span>
                    </td>
                    <td className="w-[90px] py-2 text-right tp-numeric text-up">
                      <EditableAmountCell
                        value={income.amount}
                        positive
                        onSave={(v) => handleInlineUpdate(income.id, "amount", v)}
                      />
                    </td>
                    <td className="w-[40px] py-2 text-right">
                      <button onClick={() => { setEditing(income); setModalOpen(true); }} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted transition-colors">
                        <Pencil className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile upcoming */}
          <div className="divide-y divide-border md:hidden">
            {upcomingIncomes.map((income) => (
              <div key={income.id} className="flex items-center justify-between py-3 italic opacity-60">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{income.category?.name ?? "—"}{income.source ? ` · ${income.source}` : ""}</p>
                  <p className="text-sm text-muted-foreground">{income.account.name} &middot; {formatDate(income.date)}</p>
                </div>
                <div className="ml-4 flex items-center gap-2">
                  <span className="font-semibold text-up">+{formatCurrency(income.amount)}</span>
                  <button onClick={() => { setEditing(income); setModalOpen(true); }} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted transition-colors"><Pencil className="h-4 w-4" /></button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        {incomes.length > 0 ? (
          <>
            <div className="hidden md:block">
              <table className="w-full table-fixed text-13">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="w-[44px] pb-3 pr-2 text-center">
                      <input
                        type="checkbox"
                        ref={(el) => { if (el) { el.indeterminate = incomes.some((i) => selectedIds.has(i.id)) && !incomes.every((i) => selectedIds.has(i.id)); } }}
                        checked={incomes.length > 0 && incomes.every((i) => selectedIds.has(i.id))}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedIds((prev) => new Set([...prev, ...incomes.map((i) => i.id)]));
                          } else {
                            setSelectedIds((prev) => { const next = new Set(prev); incomes.forEach((i) => next.delete(i.id)); return next; });
                          }
                        }}
                        className="h-4 w-4 rounded border-border align-text-top"
                      />
                    </th>
                    <ColumnHeader className="w-[70px] cursor-pointer select-none pb-3 pr-3" onClick={() => toggleSort("date")}>Date <SortIcon field="date" /></ColumnHeader>
                    <ColumnHeader className="pb-3 pr-3">Source</ColumnHeader>
                    <ColumnHeader className="w-[130px] cursor-pointer select-none pb-3 pr-3" onClick={() => toggleSort("category")}>Category <SortIcon field="category" /></ColumnHeader>
                    <ColumnHeader className="w-[115px] pb-3 pr-3">Tax Status</ColumnHeader>
                    <ColumnHeader className="w-[185px] cursor-pointer select-none pb-3 pr-3" onClick={() => toggleSort("account")}>Account <SortIcon field="account" /></ColumnHeader>
                    <th className="w-[30px] pb-3"></th>
                    <ColumnHeader className="w-[90px] cursor-pointer select-none pb-3 text-right" onClick={() => toggleSort("amount")}>Amount <SortIcon field="amount" /></ColumnHeader>
                    <th className="w-[40px] pb-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {incomes.map((income, idx) => (
                    <tr key={income.id} className={`${selectedIds.has(income.id) ? "bg-primary/5" : !income.isCashReceived ? "bg-muted hover:bg-muted-hover" : "hover:bg-muted"}`}>
                      <td className="w-[44px] py-2 pr-2 text-center">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(income.id)}
                          onChange={(e) => handleCheckboxChange(income.id, idx, e)}
                          className="h-4 w-4 rounded border-border align-text-top"
                        />
                      </td>
                      <td className={`w-[70px] py-2 pr-3 ${!income.isCashReceived ? "text-muted-foreground" : ""}`}>
                        <EditableCell value={income.date} type="date" onSave={(v) => handleInlineUpdate(income.id, "date", v)} />
                      </td>
                      <td className={`py-2 pr-3 ${!income.isCashReceived ? "text-muted-foreground" : ""}`}>
                        <div className="flex items-center gap-1.5">
                          <EditableCell value={income.source ?? ""} onSave={(v) => handleInlineUpdate(income.id, "source", v)} className="tp-row-label" />
                          {income.subtype === "DIVIDEND" && (
                            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-10 font-medium bg-violet-soft text-violet-deep">Dividend</span>
                          )}
                          {income.subtype === "CAPITAL_GAIN" && (
                            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-10 font-medium bg-blue-soft text-blue-deep">Sale</span>
                          )}
                        </div>
                      </td>
                      <td className={`w-[130px] py-2 pr-3 ${!income.isCashReceived ? "text-muted-foreground" : ""}`}>
                        <EditableCategoryCell
                          value={income.categoryId}
                          label={income.category?.name ?? ""}
                          categories={categories}
                          onSave={(v) => handleInlineUpdate(income.id, "categoryId", v)}
                        />
                      </td>
                      <td className="w-[115px] py-2 pr-3">
                        <EditableTaxStatusCell value={income.taxClassification} onSave={(v) => handleInlineUpdate(income.id, "taxClassification", v)} />
                      </td>
                      <td className={`w-[185px] py-2 pr-3 ${!income.isCashReceived ? "text-muted-foreground" : ""}`}>
                        <EditableTypeaheadCell
                          value={income.accountId}
                          label={income.account.name}
                          color={income.account.color}
                          items={eligibleAccounts}
                          onSave={(v) => handleInlineUpdate(income.id, "accountId", v)}
                        />
                      </td>
                      <td className="w-[30px] py-2 text-center">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded text-10 font-bold text-white" style={{ backgroundColor: income.account.isJoint ? JOINT_COLOR : PERSONAL_COLOR }}>
                          {income.account.isJoint ? "J" : "P"}
                        </span>
                      </td>
                      <td className={`w-[90px] py-2 text-right tp-numeric ${!income.isCashReceived ? "text-muted-foreground" : "text-up"}`}>
                        <EditableAmountCell
                          value={income.amount}
                          positive
                          onSave={(v) => handleInlineUpdate(income.id, "amount", v)}
                        />
                      </td>
                      <td className="w-[40px] py-2 text-right">
                        <button onClick={() => { setEditing(income); setModalOpen(true); }} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted transition-colors">
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
                <div key={income.id} className={`flex items-center gap-2 py-3 ${!income.isCashReceived ? "bg-muted" : ""}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate">
                      <p className={`truncate font-medium ${!income.isCashReceived ? "text-muted-foreground" : ""}`}>{income.category?.name ?? "—"}{income.source ? ` · ${income.source}` : ""}</p>
                      {income.subtype === "DIVIDEND" && (
                        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-10 font-medium bg-violet-soft text-violet-deep">Dividend</span>
                      )}
                      {income.subtype === "CAPITAL_GAIN" && (
                        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-10 font-medium bg-blue-soft text-blue-deep">Sale</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <span>{income.account.name} &middot; {formatDate(income.date)}</span>
                      {income.taxClassification && <TaxStatusBadge taxClassification={income.taxClassification} />}
                    </div>
                  </div>
                  <div className="ml-2 flex items-center gap-2">
                    <span className={`font-semibold ${!income.isCashReceived ? "text-muted-foreground" : "text-up"}`}>+{formatCurrency(income.amount)}</span>
                    <button onClick={() => { setEditing(income); setModalOpen(true); }} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted transition-colors"><Pencil className="h-4 w-4" /></button>
                  </div>
                </div>
              ))}
            </div>

            {loading && currentPage > 1 && (
              <div className="py-4 text-center text-sm text-muted-foreground">Loading more...</div>
            )}
            <div ref={sentinelRef} className="h-1" />
          </>
        ) : loading && currentPage === 1 ? (
          <BeaconLoader />
        ) : (
          <EmptyState
            icon={TrendingUp}
            title="No income recorded"
            description={hasActiveFilters ? "No income entries match your current filters." : "Track your income by adding entries and organizing them with categories."}
            action={
              hasActiveFilters
                ? <Button variant="secondary" onClick={resetFilters}>Reset Filters</Button>
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
        categories={categories}
      />

      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onComplete={() => { setImportModalOpen(false); refetchAll(); }}
        accounts={eligibleAccounts}
        categories={categories}
      />

      {showBackToTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg transition-opacity hover:opacity-90"
          aria-label="Back to top"
        >
          <ArrowUp className="h-4 w-4" />
          <span>Back to Top</span>
        </button>
      )}

      {selectedIds.size > 0 && (
        <div className="hidden md:block">
        <BulkEditBar
          ids={[...selectedIds]}
          categories={categories}
          textFieldLabel="Edit Source"
          textFieldKey="source"
          onApply={(patch) => bulkUpdateIncome([...selectedIds], patch)}
          onBulkDelete={() => bulkDeleteIncome([...selectedIds])}
          onClear={() => setSelectedIds(new Set())}
          onSuccess={() => { setSelectedIds(new Set()); refetchAll(); }}
          deleteDisabled={[...allIncomes, ...upcomingIncomes].some((i) => selectedIds.has(i.id) && i.activityId != null)}
          showTaxStatus
          deleteDisabledTitle="Deselect investment-linked transactions (Div / Sale) to enable delete"
          selectedTransactions={[...allIncomes, ...upcomingIncomes]
            .filter((i) => selectedIds.has(i.id))
            .map((i) => ({ amount: i.amount, isJoint: i.account.isJoint }))}
        />
        </div>
      )}
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
  categories: Category[];
}

function IncomeModal({ open, onClose, onSave, onDelete, income, accounts, categories }: IncomeModalProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showOptional, setShowOptional] = useState(false);
  const [taxClassification, setTaxClassification] = useState<string>("");
  const [dateVal, setDateVal] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; accountId?: string; date?: string }>({});
  const categoryTriggerRef = useRef<HTMLButtonElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const submitBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setConfirmDelete(false);
      setTaxClassification(income?.taxClassification ?? "");
      setShowOptional(!!(income?.notes || income?.taxClassification));
      setDateVal(toDateInputValue(income?.date));
      setErrors({});
    }
  }, [open, income]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const amount = parseFloat(form.get("amount") as string);
    const accountId = form.get("accountId") as string;

    const newErrors: typeof errors = {};
    if (!amount || amount <= 0) newErrors.amount = "Amount is required";
    if (!accountId) newErrors.accountId = "Account is required";
    if (!(form.get("date") as string)) newErrors.date = "Date is required";
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSaving(true);
    setErrors({});
    const categoryId = form.get("categoryId") as string;
    await onSave({
      amount,
      categoryId: categoryId || undefined,
      source: (form.get("source") as string) || undefined,
      date: form.get("date") as string,
      accountId,
      taxClassification: taxClassification || null,
      notes: (form.get("notes") as string) || undefined,
    });
    setSaving(false);
  };

  const isActivityLinked = income?.activityId != null;

  const handleDeleteClick = async () => {
    if (isActivityLinked) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    if (!income) return;
    setDeleting(true);
    await onDelete(income.id);
    setDeleting(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={income ? "Edit Income" : "Add Income"}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1">Amount</label>
          <CurrencyInput
            name="amount"
            defaultValue={income?.amount}
            required
            autoFocus
            error={!!errors.amount}
            onValidChange={() => setErrors((e) => ({ ...e, amount: undefined }))}
          />
          {errors.amount && <p className="mt-1 text-xs text-down">{errors.amount}</p>}
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Source</label>
          <input
            name="source"
            type="text"
            defaultValue={income?.source ?? ""}
            placeholder="e.g. ACME Corp dividends, Chase savings interest..."
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Date</label>
          <DatePicker name="date" value={dateVal} onChange={(v) => { setDateVal(v); setErrors((er) => ({ ...er, date: undefined })); }} invalid={!!errors.date} className="w-full" />
          {errors.date && <p className="mt-1 text-xs text-down">{errors.date}</p>}
          {/* Relay: captures focus as it exits the date field and forwards to Category, but not on Shift+Tab backwards from Category */}
          <span tabIndex={0} className="sr-only" onFocus={(e) => { if (e.relatedTarget !== categoryTriggerRef.current) categoryTriggerRef.current?.focus(); }} />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Category</label>
          <CategoryTypeahead
            name="categoryId"
            defaultValue={income?.categoryId ?? ""}
            categories={categories}
            triggerRef={categoryTriggerRef}
            onTabFromSearch={() => accountTriggerRef.current?.focus()}
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Account</label>
          <ItemTypeahead
            name="accountId"
            required
            defaultValue={income?.accountId ?? ""}
            items={accounts}
            placeholder="Select account"
            triggerRef={accountTriggerRef}
            onTabFromSearch={() => submitBtnRef.current?.focus()}
            error={!!errors.accountId}
            onSelect={() => setErrors((e) => ({ ...e, accountId: undefined }))}
          />
          {errors.accountId && <p className="mt-1 text-xs text-down">{errors.accountId}</p>}
        </div>

        {/* Collapsible optional section */}
        <div className="border-t border-border pt-3">
          <button type="button" tabIndex={-1} onClick={() => setShowOptional(!showOptional)} className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
            {showOptional ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            More options
          </button>
          {showOptional && (
            <div className="mt-3 space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1">Tax Status</label>
                <div className="relative">
                  <select
                    value={taxClassification}
                    onChange={(e) => setTaxClassification(e.target.value)}
                    className="w-full appearance-none rounded-md border border-border py-2 pl-2 pr-6 text-sm text-foreground"
                  >
                    <option value="">Not specified</option>
                    <option value="CAPITAL_GAIN">Capital Gain</option>
                    <option value="ORDINARY">Ordinary</option>
                    <option value="QUALIFIED">Qualified</option>
                    <option value="RETURN_OF_CAPITAL">Return of Capital</option>
                    <option value="TAX_EXEMPT">Tax-Exempt</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Notes</label>
                <textarea name="notes" rows={2} defaultValue={income?.notes ?? ""} className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary" placeholder="Additional notes..." />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <div>
            {income && (
              <button
                type="button"
                tabIndex={-1}
                onClick={handleDeleteClick}
                disabled={deleting}
                title={isActivityLinked ? "This transaction was generated by an investment activity and cannot be manually deleted" : undefined}
                className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-13 font-normal transition-colors ${isActivityLinked ? "opacity-40 cursor-not-allowed text-down" : "text-down hover:bg-down/10"}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? "Deleting..." : confirmDelete ? "Confirm Delete" : "Delete"}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" tabIndex={-1} onClick={onClose}>Cancel</Button>
            <Button ref={submitBtnRef} type="submit" disabled={saving}>{saving ? "Saving..." : income ? "Update" : "Add Income"}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ── Import Modal ──

interface ParsedIncomeRow {
  raw: string[];
  date: string;
  source: string;
  categoryName: string;
  accountName: string;
  amount: number;
  categoryId: string | null;
  accountId: string | null;
  errors: string[];
}

function parseDate(s: string): string | null {
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === delimiter) { fields.push(current.trim()); current = ""; }
      else { current += ch; }
    }
  }
  fields.push(current.trim());
  return fields;
}

function ImportModal({
  open, onClose, onComplete, accounts, categories,
}: {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
  accounts: Account[];
  categories: Category[];
}) {
  const [step, setStep] = useState<"upload" | "preview" | "result">("upload");
  const [rows, setRows] = useState<ParsedIncomeRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: Array<{ row: number; message: string }> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setStep("upload");
      setRows([]);
      setResult(null);
      setImporting(false);
    }
  }, [open]);

  const accountMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) map.set(a.name.toLowerCase(), a.id);
    return map;
  }, [accounts]);

  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.name.toLowerCase(), c.id);
    return map;
  }, [categories]);

  const categoryNames = useMemo(() =>
    [...categories].sort((a, b) => a.name.localeCompare(b.name)).map((c) => c.name),
    [categories],
  );

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return;

      const delimiter = lines[0].includes("\t") ? "\t" : ",";
      const parsed: ParsedIncomeRow[] = [];

      for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i], delimiter);
        if (fields.length < 5) continue;

        // Columns: Date, Source, Category, Account, Amount
        const [rawDate, src, rawCategory, acctName, rawAmt] = fields;
        const errors: string[] = [];

        const date = parseDate(rawDate);
        if (!date) errors.push("Invalid date");

        const source = src?.trim() || "";

        const categoryName = rawCategory?.trim() || "";
        let categoryId: string | null = null;
        if (!categoryName) {
          errors.push("Missing category");
        } else {
          categoryId = categoryMap.get(categoryName.toLowerCase()) ?? null;
          if (!categoryId) errors.push(`Unknown category "${categoryName}"`);
        }

        const accountName = acctName?.trim() || "";
        let accountId: string | null = null;
        if (!accountName) {
          errors.push("Missing account");
        } else {
          accountId = accountMap.get(accountName.toLowerCase()) ?? null;
          if (!accountId) errors.push(`Unknown account "${accountName}"`);
        }

        const cleanAmt = rawAmt?.replace(/[$,]/g, "") ?? "";
        const amount = parseFloat(cleanAmt);
        if (isNaN(amount)) errors.push("Invalid amount");
        else if (amount <= 0) errors.push("Amount must be positive");

        parsed.push({
          raw: fields,
          date: date || rawDate,
          source,
          categoryName,
          accountName,
          amount: isNaN(amount) ? 0 : amount,
          categoryId,
          accountId,
          errors,
        });
      }
      setRows(parsed);
      setStep("preview");
    };
    reader.readAsText(file);
  };

  const validRows = rows.filter((r) => r.errors.length === 0);

  const handleImport = async () => {
    setImporting(true);
    try {
      const payload = validRows.map((r) => ({
        amount: r.amount,
        categoryId: r.categoryId ?? undefined,
        source: r.source || undefined,
        date: r.date,
        accountId: r.accountId,
      }));
      const res = await importIncome(payload);
      setResult(res);
      setStep("result");
    } catch {
      setResult({ imported: 0, errors: [{ row: 0, message: "Import request failed" }] });
      setStep("result");
    }
    setImporting(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Import Income">
      {step === "upload" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload a CSV or TSV file with these columns in order:
          </p>
          <div className="rounded-md border border-border bg-card px-3 py-2 text-xs font-mono">
            Date, Source, Category, Account, Amount
          </div>
          <p className="tp-caption">
            First row should be a header (it will be skipped). Dates can be YYYY-MM-DD or M/D/YYYY.
            {categoryNames.length > 0
              ? ` Category must match one of your income categories (e.g. ${categoryNames.slice(0, 3).join(", ")}${categoryNames.length > 3 ? "…" : ""}).`
              : " Category must match an existing income category."
            }
            {" "}Account name must match an existing Checking, Savings, or Investment account.
            Source is optional.
          </p>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt"
              onChange={handleFile}
              className="hidden"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              className="w-full justify-center"
            >
              <FileText className="h-4 w-4" /> Choose File
            </Button>
          </div>
          <div className="flex justify-end pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {validRows.length} of {rows.length} rows valid
            </p>
            {rows.length > validRows.length && (
              <p className="text-xs text-down">
                {rows.length - validRows.length} row{rows.length - validRows.length !== 1 ? "s" : ""} with errors
              </p>
            )}
          </div>

          <div className="max-h-[50vh] overflow-auto rounded-md border border-border bg-white">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr className="border-b border-border text-left text-muted-foreground">
                  <ColumnHeader className="px-2 py-1.5">#</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Date</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Source</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Category</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Account</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5 text-right">Amount</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Status</ColumnHeader>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className={`border-b border-border ${row.errors.length > 0 ? "bg-down/5" : ""}`}>
                    <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1.5">{row.date ? new Date(row.date).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", year: "2-digit" }) : "—"}</td>
                    <td className="px-2 py-1.5 max-w-[120px] truncate">{row.source || "—"}</td>
                    <td className="px-2 py-1.5">{row.categoryId ? (categories.find((c) => c.id === row.categoryId)?.name ?? row.categoryName) : row.categoryName}</td>
                    <td className="px-2 py-1.5 max-w-[100px] truncate">{row.accountName}</td>
 <td className="px-2 py-1.5 text-right tp-numeric text-up">
                      {row.amount === 0 ? "—" : `+${formatCurrency(row.amount)}`}
                    </td>
                    <td className="px-2 py-1.5">
                      {row.errors.length > 0 ? (
                        <span className="text-down" title={row.errors.join("; ")}>
                          <AlertCircle className="inline h-3 w-3" /> {row.errors[0]}
                        </span>
                      ) : (
                        <span className="text-up"><Check className="inline h-3 w-3" /></span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button type="button" variant="secondary" onClick={() => { setStep("upload"); setRows([]); if (fileRef.current) fileRef.current.value = ""; }}>
              Back
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button
                type="button"
                disabled={validRows.length === 0 || importing}
                onClick={handleImport}
              >
                {importing ? "Importing..." : `Import ${validRows.length} Income${validRows.length !== 1 ? "s" : ""}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === "result" && result && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-md border border-border bg-muted p-4">
            <CheckCircle2 className="h-6 w-6 text-up shrink-0" />
            <div>
              <p className="text-sm font-medium">
                {result.imported} income{result.imported !== 1 ? "s" : ""} imported successfully
              </p>
              {result.errors.length > 0 && (
                <p className="text-xs text-down mt-1">
                  {result.errors.length} row{result.errors.length !== 1 ? "s" : ""} failed on server
                </p>
              )}
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="max-h-[150px] overflow-auto rounded-md border border-border p-2 text-xs text-down">
              {result.errors.map((e, i) => (
                <div key={i}>Row {e.row}: {e.message}</div>
              ))}
            </div>
          )}

          <div className="flex justify-end pt-2">
            <Button type="button" onClick={onComplete}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
