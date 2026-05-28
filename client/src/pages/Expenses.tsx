import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { createPortal } from "react-dom";
import {
  Plus, Pencil, Receipt, AlertCircle, Tag as TagIcon,
  ArrowUpDown, ArrowUp, ArrowDown, Filter, Trash2, Repeat,
  AlertTriangle, Undo2, CheckCircle2, Upload, FileText, Check, GripVertical,
  ChevronRight, ChevronDown, Search, EyeOff,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { BeaconLoader } from "@/components/BeaconLoader";
import { ToastContainer, useToast } from "@/components/Toast";
import { MultiSelectDropdown } from "@/components/MultiSelectDropdown";
import type { MultiSelectOption, MultiSelectGroup } from "@/components/MultiSelectDropdown";
import { BulkEditBar } from "@/components/BulkEditBar";
import type { GroupAction } from "@/components/BulkEditBar";
import { useApi, getApiCache } from "@/hooks/useApi";
import {
  getExpenses, getAccounts, getFlatCategories, getTags,
  createExpense, updateExpense, deleteExpense, importExpenses,
  createRecurrenceRule, createTransactionGroup, updateTransactionGroup,
  getExpenseVendors, getVendorCategory, getVendorAccount, getUncategorizedCount,
  updateExpenseParent, createTag,
} from "@/api";
import { formatCurrency, formatDate, toDateInputValue, localToday } from "@/lib/utils";
import type { Expense, Category, Account, Tag } from "@/types";
import { SectionLabel, ColumnHeader } from "@/components/Typography";

const EXPENSE_ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CREDIT_CARD", "CASH"];

// ── Drag-and-drop helpers ──
const DRAG_THRESHOLD = 5; // px of movement before drag activates
const INTERACTIVE_TAGS = new Set(["INPUT", "TEXTAREA", "BUTTON", "SELECT", "A"]);

function isInteractiveElement(el: EventTarget | null): boolean {
  let node = el as HTMLElement | null;
  while (node && node !== document.body) {
    if (INTERACTIVE_TAGS.has(node.tagName)) return true;
    if (node.getAttribute("contenteditable") === "true") return true;
    if (node.getAttribute("role") === "option") return true;
    node = node.parentElement;
  }
  return false;
}

function getTargetIdAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  let node = el as HTMLElement | null;
  while (node && node !== document.body) {
    const expId = (node as HTMLElement).dataset?.expenseId;
    if (expId) return expId;
    const dz = (node as HTMLElement).dataset?.dropzone;
    if (dz) return `__dz__${dz}`;
    node = node.parentElement;
  }
  return null;
}

interface DragState {
  sourceId: string;
  sourceType: "negative" | "offset";
  sourceParentId: string | null;
  startPos: { x: number; y: number };
  mousePos: { x: number; y: number };
  started: boolean;
  targetId: string | null;
}

const FREQUENCY_OPTIONS = [
  { value: "DAILY",   singular: "day",   plural: "days"   },
  { value: "WEEKLY",  singular: "week",  plural: "weeks"  },
  { value: "MONTHLY", singular: "month", plural: "months" },
  { value: "YEARLY",  singular: "year",  plural: "years"  },
];

type SortField = "date" | "description" | "vendor" | "category" | "account" | "amount";
type SortState = { field: SortField; order: "asc" | "desc" } | null;

interface GroupMeta {
  groupId: string;
  isPrimary: boolean;
  primaryExpenseId: string | null;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
}

// Returns the bottom edge of the nearest ancestor that clips overflow (auto/scroll/hidden).
// Used by typeaheads to decide whether to flip their dropdown upward.
function getScrollParentBottom(el: Element): number {
  let parent = el.parentElement;
  while (parent && parent !== document.documentElement) {
    const { overflow, overflowY } = window.getComputedStyle(parent);
    if (/(auto|scroll|hidden)/.test(overflow) || /(auto|scroll|hidden)/.test(overflowY)) {
      return parent.getBoundingClientRect().bottom;
    }
    parent = parent.parentElement;
  }
  return window.innerHeight;
}

// ── Currency input helper ──
function CurrencyInput({ name, defaultValue, required, onChange, autoFocus }: { name: string; defaultValue?: string; required?: boolean; onChange?: (value: number) => void; autoFocus?: boolean }) {
  const [rawValue, setRawValue] = useState(() => {
    if (!defaultValue) return "";
    const num = parseFloat(defaultValue);
    return isNaN(num) || num === 0 ? "" : num.toFixed(2);
  });

  // Sync when defaultValue changes (e.g. modal reopened with different data)
  useEffect(() => {
    if (!defaultValue) { setRawValue(""); return; }
    const num = parseFloat(defaultValue);
    setRawValue(isNaN(num) || num === 0 ? "" : num.toFixed(2));
  }, [defaultValue]);

  const numericValue = parseFloat(rawValue) || 0;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || val === "-" || /^-?\d*\.?\d{0,2}$/.test(val)) {
      setRawValue(val);
      const parsed = parseFloat(val);
      if (!isNaN(parsed)) onChange?.(parsed);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    const cleaned = pasted.replace(/[$,\s]/g, "");
    if (cleaned === "" || cleaned === "-" || /^-?\d*\.?\d{0,2}$/.test(cleaned)) {
      e.preventDefault();
      setRawValue(cleaned);
      const parsed = parseFloat(cleaned);
      if (!isNaN(parsed)) onChange?.(parsed);
    }
  };

  const handleBlur = () => {
    if (rawValue === "-") {
      setRawValue("");
      onChange?.(0);
    } else if (rawValue && !isNaN(parseFloat(rawValue))) {
      const formatted = parseFloat(rawValue).toFixed(2);
      setRawValue(formatted);
      onChange?.(parseFloat(formatted));
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
          className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="0.00"
          inputMode="text"
        />
      </div>
      <input type="hidden" name={name} value={numericValue.toFixed(2)} />
      {required && numericValue === 0 && <input type="text" required value="" style={{ opacity: 0, position: "absolute", pointerEvents: "none", width: 0, height: 0 }} tabIndex={-1} onChange={() => {}} />}
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
  const [flipUp, setFlipUp] = useState(false);
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
        onChange={(e) => {
          setValue(e.target.value);
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setFlipUp(getScrollParentBottom(ref.current) - rect.bottom < 240);
          }
          setOpen(true);
        }}
        onFocus={() => {
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setFlipUp(getScrollParentBottom(ref.current) - rect.bottom < 240);
          }
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
        className="w-full rounded-md border border-border px-3 py-2 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        placeholder="e.g. Amazon, Whole Foods, Netflix"
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div className={`absolute left-0 right-0 z-50 max-h-48 overflow-auto rounded-md border border-border bg-background shadow-lg ${flipUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
          {filtered.map((v, i) => (
            <button
              key={v}
              type="button"
              tabIndex={-1}
              className={`block w-full px-3 py-1.5 text-left text-[13px] ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
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
  name, defaultValue, categories, required, triggerRef: externalTriggerRef, onTabFromSearch,
}: {
  name: string;
  defaultValue?: string;
  categories: Category[];
  required?: boolean;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  onTabFromSearch?: () => void;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const clickingRef = useRef(false);
  const justSelectedRef = useRef(false);

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
      const words = text.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^a-z]+/, ""));
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
    justSelectedRef.current = true;
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      setOpen(false);
      setSearch("");
      onTabFromSearch?.();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { e.preventDefault(); selectItem(filtered[focusIdx].id); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <input type="hidden" name={name} value={value} />
      {required && !value && <input type="text" required value="" style={{ opacity: 0, position: "absolute", pointerEvents: "none", width: 0, height: 0 }} tabIndex={-1} onChange={() => {}} />}
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={() => { clickingRef.current = true; }}
        onFocus={(e) => {
          if (justSelectedRef.current || clickingRef.current) {
            justSelectedRef.current = false;
            clickingRef.current = false;
            return;
          }
          // Only auto-open when tabbing forward (related target precedes this button in DOM)
          const related = e.relatedTarget as Element | null;
          if (related && !(related.compareDocumentPosition(e.currentTarget) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setFlipUp(getScrollParentBottom(ref.current) - rect.bottom < 240);
          }
          setOpen(true);
        }}
        onClick={() => {
          if (!open && ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setFlipUp(getScrollParentBottom(ref.current) - rect.bottom < 240);
          }
          setOpen((o) => !o);
        }}
        className="w-full relative rounded-md border border-border bg-[rgba(255,255,255,0.78)] shadow-[var(--shadow-input)] px-3 py-2 pr-7 text-left text-[13px] text-foreground hover:border-primary/30 focus:border-primary/30 focus:outline-none transition-[border-color] duration-[120ms]"
      >
        {selectedLabel || <span className="text-muted-foreground">Select category</span>}
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
      </button>
      {open && (
        <div className={`absolute left-0 right-0 z-50 rounded-md border border-border bg-background shadow-lg ${flipUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
          <div className="border-b border-border p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type to filter..."
              className="w-full rounded border border-border px-2 py-1 text-[13px] focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">No matches</p>
            ) : (
              filtered.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  tabIndex={-1}
                  className={`block w-full px-3 py-1.5 text-left text-[13px] ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
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
  name, defaultValue, accounts, required, onTabFromSearch, triggerRef: externalTriggerRef,
}: {
  name: string;
  defaultValue?: string;
  accounts: Account[];
  required?: boolean;
  onTabFromSearch?: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const clickingRef = useRef(false);
  const justSelectedRef = useRef(false);

  useEffect(() => { setValue(defaultValue ?? ""); }, [defaultValue]);

  const sortedAccounts = useMemo(() =>
    [...accounts].sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  );

  const filtered = useMemo(() => {
    const visible = sortedAccounts.filter((a) => !a.isHidden);
    if (!search.trim()) return visible;
    const terms = search.toLowerCase().split(/\s+/);
    return visible.filter((a) => {
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
    justSelectedRef.current = true;
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      setOpen(false);
      setSearch("");
      onTabFromSearch?.();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && filtered[focusIdx]) { e.preventDefault(); selectItem(filtered[focusIdx].id); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <input type="hidden" name={name} value={value} />
      {required && !value && <input type="text" required value="" style={{ opacity: 0, position: "absolute", pointerEvents: "none", width: 0, height: 0 }} tabIndex={-1} onChange={() => {}} />}
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={() => { clickingRef.current = true; }}
        onFocus={(e) => {
          if (justSelectedRef.current || clickingRef.current) {
            justSelectedRef.current = false;
            clickingRef.current = false;
            return;
          }
          // Only auto-open when tabbing forward (related target precedes this button in DOM)
          const related = e.relatedTarget as Element | null;
          if (related && !(related.compareDocumentPosition(e.currentTarget) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setFlipUp(getScrollParentBottom(ref.current) - rect.bottom < 240);
          }
          setOpen(true);
        }}
        onClick={() => {
          if (!open && ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setFlipUp(getScrollParentBottom(ref.current) - rect.bottom < 240);
          }
          setOpen((o) => !o);
        }}
        className="w-full relative rounded-md border border-border bg-[rgba(255,255,255,0.78)] shadow-[var(--shadow-input)] px-3 py-2 pr-7 text-left text-[13px] text-foreground hover:border-primary/30 focus:border-primary/30 focus:outline-none transition-[border-color] duration-[120ms]"
      >
        {selectedLabel || <span className="text-muted-foreground">Select account</span>}
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
      </button>
      {open && (
        <div className={`absolute left-0 right-0 z-50 rounded-md border border-border bg-background shadow-lg ${flipUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
          <div className="border-b border-border p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type to filter..."
              className="w-full rounded border border-border px-2 py-1 text-[13px] focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">No matches</p>
            ) : (
              filtered.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  tabIndex={-1}
                  className={`block w-full px-3 py-1.5 text-left text-[13px] ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
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

// ── Tag typeahead (multi-select) ──
function TagTypeahead({
  tags, selectedIds, onChange, onCreateTag, triggerRef: externalTriggerRef, onTabFromSearch,
}: {
  tags: Tag[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onCreateTag: (name: string) => Promise<Tag>;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  onTabFromSearch?: () => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  const [localTags, setLocalTags] = useState<Tag[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = externalTriggerRef ?? internalTriggerRef;
  const clickingRef = useRef(false);

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
  const totalOptions = filtered.length + (showCreate ? 1 : 0);

  useEffect(() => { setFocusIdx(0); }, [filtered]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      setOpen(false);
      setSearch("");
      onTabFromSearch?.();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusIdx((i) => Math.min(i + 1, totalOptions - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (showCreate) { handleCreate(); }
      else if (filtered[focusIdx]) { toggleTag(filtered[focusIdx].id); }
    }
    else if (e.key === "Escape") setOpen(false);
  };

  const selectedTags = sortedTags.filter((t) => selectedIds.includes(t.id));

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={() => { clickingRef.current = true; }}
        onFocus={(e) => {
          if (clickingRef.current) { clickingRef.current = false; return; }
          // Only auto-open when tabbing forward
          const related = e.relatedTarget as Element | null;
          if (related && !(related.compareDocumentPosition(e.currentTarget) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setFlipUp(getScrollParentBottom(ref.current) - rect.bottom < 240);
          }
          setOpen(true);
        }}
        onClick={() => {
          if (!open && ref.current) {
            const rect = ref.current.getBoundingClientRect();
            setFlipUp(getScrollParentBottom(ref.current) - rect.bottom < 240);
          }
          setOpen((o) => !o);
        }}
        className="w-full relative rounded-md border border-border bg-[rgba(255,255,255,0.78)] shadow-[var(--shadow-input)] px-3 py-2 pr-7 text-left text-[13px] text-foreground hover:border-primary/30 focus:border-primary/30 focus:outline-none transition-[border-color] duration-[120ms] min-h-[38px]"
      >
        {selectedTags.length === 0 ? (
          <span className="text-muted-foreground">Select tags</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {selectedTags.map((t) => (
              <span
                key={t.id}
                className="rounded-full px-2 py-0.5 text-xs font-medium"
                style={t.color ? { backgroundColor: t.color, color: "#fff" } : { backgroundColor: "var(--color-gray-400)", color: "#fff" }}
              >
                {t.name}
              </span>
            ))}
          </div>
        )}
        <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
      </button>
      {open && (
        <div className={`absolute left-0 right-0 z-50 rounded-md border border-border bg-background shadow-lg ${flipUp ? "bottom-full mb-1" : "top-full mt-1"}`}>
          <div className="border-b border-border p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type to filter or create..."
              className="w-full rounded border border-border px-2 py-1 text-[13px] focus:outline-none"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-auto">
            {showCreate ? (
              <button
                type="button"
                tabIndex={-1}
                className={`block w-full px-3 py-1.5 text-left text-[13px] ${focusIdx === 0 ? "bg-primary/10" : "hover:bg-muted/50"}`}
                onMouseDown={handleCreate}
                disabled={creating}
              >
                {creating ? "Creating..." : `Create tag: "${search.trim()}"`}
              </button>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">No tags yet</p>
            ) : (
              filtered.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  tabIndex={-1}
                  className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-[13px] ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
                  onMouseDown={() => toggleTag(t.id)}
                >
                  <span className={`h-4 w-4 flex-shrink-0 rounded border flex items-center justify-center ${selectedIds.includes(t.id) ? "bg-primary border-primary" : "border-border"}`}>
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
  value, vendors, onSave, className = "text-muted-foreground",
}: {
  value: string;
  vendors: string[];
  onSave: (newValue: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [focusIdx, setFocusIdx] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ top?: number; bottom?: number; left: number; minWidth: number }>({ left: 0, minWidth: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
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
      const target = e.target as Node;
      if (
        ref.current && !ref.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
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

  const startEditing = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      if (window.innerHeight - rect.bottom < 220) {
        setDropdownPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left, minWidth: rect.width });
      } else {
        setDropdownPos({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
      }
    }
    setEditValue(value);
    setEditing(true);
  };

  return (
    <div ref={ref}>
      {editing ? (
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
      ) : (
        <span
          onClick={startEditing}
          className={`cursor-pointer border-b border-dotted border-transparent hover:border-gray-400 ${className}`}
        >
          {value || <span className="italic">—</span>}
        </span>
      )}
      {editing && filtered.length > 0 && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: "fixed", top: dropdownPos.top, bottom: dropdownPos.bottom, left: dropdownPos.left, minWidth: Math.max(dropdownPos.minWidth, 150), zIndex: 9999 }}
          className="max-h-36 overflow-auto rounded-md border border-border bg-background shadow-lg"
        >
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
        </div>,
        document.body
      )}
    </div>
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
      const words = text.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^a-z]+/, ""));
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
        <span
          onClick={startEditing}
          className={`cursor-pointer border-b border-dotted border-transparent hover:border-gray-400 ${isUncategorized ? "text-red-500 font-medium" : ""}`}
        >
          {isUncategorized ? "[Uncategorized]" : label}
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
                  className={`block w-full px-3 py-1.5 text-left text-sm ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
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

// ── Inline account typeahead cell ──
function EditableAccountCell({
  value, label, color, accounts, onSave,
}: {
  value: string;
  label: string;
  color?: string | null;
  accounts: Account[];
  onSave: (newValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [focusIdx, setFocusIdx] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ top?: number; bottom?: number; left: number; minWidth: number }>({ left: 0, minWidth: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sortedAccounts = useMemo(() =>
    [...accounts].sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  );

  const filtered = useMemo(() => {
    const visible = sortedAccounts.filter((a) => !a.isHidden);
    if (!search.trim()) return visible;
    const terms = search.toLowerCase().split(/\s+/);
    return visible.filter((a) => {
      const words = a.name.toLowerCase().split(/\s+/);
      return terms.every((t) => words.some((w) => w.startsWith(t)));
    });
  }, [search, sortedAccounts]);

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
        <span
          onClick={startEditing}
          className="inline-block cursor-pointer whitespace-nowrap rounded-md px-2 py-0.5 text-13 text-foreground"
          style={{ backgroundColor: color ?? "#e2e2df" }}
        >
          {label}
        </span>
      )}
      {editing && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: "fixed", top: dropdownPos.top, bottom: dropdownPos.bottom, left: dropdownPos.left, minWidth: Math.max(dropdownPos.minWidth, 180), zIndex: 9999 }}
          className="rounded-md border border-border bg-background shadow-lg"
        >
          <div className="max-h-48 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
            ) : (
              filtered.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  className={`block w-full px-3 py-1.5 text-left text-13 ${i === focusIdx ? "bg-primary/10" : "hover:bg-muted/50"}`}
                  onMouseDown={() => selectItem(a.id)}
                >
                  {a.name}
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
function EditableAmountCell({ value, onSave, isOffset }: { value: string; onSave: (v: string) => void; isOffset?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const numericValue = parseFloat(value);
  const absValue = Math.abs(numericValue);
  // Treat as "negative" (credit/income) if it's an offset child OR a standalone negative amount
  const isNegative = isOffset || numericValue < 0;

  const startEdit = () => {
    setEditValue(numericValue.toFixed(2));
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const parsed = parseFloat(editValue);
    if (isNaN(parsed) || parsed === 0) return;
    const saveValue = parsed.toFixed(2);
    if (parseFloat(saveValue).toFixed(2) !== parseFloat(value).toFixed(2)) onSave(saveValue);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val === "" || val === "-" || /^-?\d*\.?\d{0,2}$/.test(val)) {
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
      {isNegative ? `+${formatCurrency(absValue)}` : formatCurrency(absValue)}
    </span>
  );
}

// ═══════════════ MAIN COMPONENT ═══════════════

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

// Compute the cache key for the first page of expenses using the same logic as the filterParams
// useMemo + queryParams useMemo in the component. Used to pre-populate allExpenses from cache
// on mount so the list is visible on the very first render (no empty-state flash on navigation).
function getInitialExpenseData(): Expense[] {
  try {
    const applied = loadExpenseFilters();
    const todayStr = localToday();
    const params: Record<string, string> = { limit: "50", sortBy: "date", sortOrder: "desc" };
    if (applied.categoryIds.length > 0) params.categoryIds = applied.categoryIds.join(",");
    if (applied.accountIds.length > 0) params.accountIds = applied.accountIds.join(",");
    if (applied.tagIds.length > 0) params.tagIds = applied.tagIds.join(",");
    params.startDate = applied.startDate || EXPENSE_DEFAULT_FILTERS.startDate;
    const endDate = applied.endDate || todayStr;
    params.endDate = endDate > todayStr ? todayStr : endDate;
    params.page = "1";
    return getApiCache<{ data: Expense[] }>(`expenses-${JSON.stringify(params)}`)?.data ?? [];
  } catch {
    return [];
  }
}

export function Expenses() {
  const location = useLocation();
  const { toasts, addToast, dismissToast } = useToast();
  // Expenses awaiting optimistic deletion (hidden in UI; API call deferred 8 s)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const pendingDeleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Clear all pending delete timers on unmount to avoid state updates on an unmounted component
  useEffect(() => () => { pendingDeleteTimers.current.forEach(clearTimeout); }, []);

  const [currentPage, setCurrentPage] = useState(1);
  const [allExpenses, setAllExpenses] = useState<Expense[]>(getInitialExpenseData);
  const [hasMore, setHasMore] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const isFirstMount = useRef(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [offsetParent, setOffsetParent] = useState<Expense | null>(null);
  const [sort, setSort] = useState<SortState>({ field: "date", order: "desc" });
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState(""); // raw input value
  const [appliedSearch, setAppliedSearch] = useState(""); // committed on Enter, drives API
  const [showUncategorized, setShowUncategorized] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);
  const dragStateRef = useRef<DragState | null>(null);
  dragStateRef.current = dragState;

  // Staged = what the filter panel shows (being edited by user)
  // Applied = what actually drives the API query (committed on Apply click)
  // If navigation state carries tempFilters (set by chart deep-links), use those for this
  // session only — they are never written to localStorage, so a page refresh reverts to
  // whatever the user last explicitly saved.
  const [staged, setStaged] = useState<ExpenseFilterState>(
    () => (location.state as any)?.tempFilters ?? loadExpenseFilters()
  );
  const [applied, setApplied] = useState<ExpenseFilterState>(
    () => (location.state as any)?.tempFilters ?? loadExpenseFilters()
  );

  // Today's date string for splitting upcoming vs regular (local timezone)
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
    if (showUncategorized) {
      params.categoryId = "uncategorized";
    } else if (applied.categoryIds.length > 0) {
      params.categoryIds = applied.categoryIds.join(",");
    }
    if (applied.accountIds.length > 0) params.accountIds = applied.accountIds.join(",");
    if (applied.tagIds.length > 0) params.tagIds = applied.tagIds.join(",");
    if (appliedSearch.trim()) params.search = appliedSearch.trim();
    const isDefaultDateFilter = (
      applied.startDate === EXPENSE_DEFAULT_FILTERS.startDate &&
      applied.endDate === EXPENSE_DEFAULT_FILTERS.endDate
    );
    if (appliedSearch.trim() && isDefaultDateFilter) {
      // Search overrides default date range — return all matching transactions
      // Still cap at today so upcoming (future) expenses stay in their own section
      params.endDate = todayStr;
    } else {
      params.startDate = applied.startDate || EXPENSE_DEFAULT_FILTERS.startDate;
      // Cap main table at today to exclude future-dated (upcoming) expenses
      const endDate = applied.endDate || todayStr;
      params.endDate = endDate > todayStr ? todayStr : endDate;
    }
    return params;
  }, [sort, applied, showUncategorized, todayStr, appliedSearch]);

  const queryParams = useMemo(() => ({
    ...filterParams,
    page: currentPage.toString(),
  }), [filterParams, currentPage]);

  // Upcoming expenses query: future-dated, sorted ascending — mirrors applied filters
  const upcomingParams = useMemo(() => {
    const params: Record<string, string> = {
      startDate: tomorrowStr,
      sortBy: "date",
      sortOrder: "asc",
      limit: "100",
    };
    if (showUncategorized) {
      params.categoryId = "uncategorized";
    } else if (applied.categoryIds.length > 0) {
      params.categoryIds = applied.categoryIds.join(",");
    }
    if (applied.accountIds.length > 0) params.accountIds = applied.accountIds.join(",");
    if (applied.tagIds.length > 0) params.tagIds = applied.tagIds.join(",");
    return params;
  }, [tomorrowStr, applied, showUncategorized]);

  const { data: expenseData, loading } = useApi(() => getExpenses(queryParams), [queryParams], `expenses-${JSON.stringify(queryParams)}`);
  const { data: upcomingData, refetch: refetchUpcoming } = useApi(() => getExpenses(upcomingParams), [upcomingParams], `expenses-upcoming-${JSON.stringify(upcomingParams)}`);
  const { data: categories } = useApi(() => getFlatCategories("EXPENSE"), [], "categories-EXPENSE");
  const { data: accounts } = useApi(() => getAccounts({ includeHidden: true }), [], "accounts");
  const { data: tags, refetch: refetchTags } = useApi(() => getTags(), [], "tags");
  const { data: vendorList, refetch: refetchVendors } = useApi(() => getExpenseVendors(), [], "expense-vendors");
  const { data: uncatData, refetch: refetchUncat } = useApi(() => getUncategorizedCount(), [], "expense-uncategorized-count");
  // Note: transaction group metadata is now embedded in each expense's `transactionGroup` field;
  // no separate groups query is needed.

  // Reset accumulated data when filters/sort change (skip on initial mount to preserve cached data)
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return; }
    setCurrentPage(1);
    setAllExpenses([]);
    setHasMore(false);
    loadingMoreRef.current = false;
    setUpcomingExpanded(false);
  }, [filterParams]);

  // Accumulate expense pages as they load
  useEffect(() => {
    if (!expenseData) return;
    const { data, pagination: pag } = expenseData;
    if (pag.page === 1) {
      setAllExpenses(data ?? []);
    } else {
      setAllExpenses((prev) => [...prev, ...(data ?? [])]);
    }
    setHasMore(pag.page < pag.totalPages);
    loadingMoreRef.current = false;
  }, [expenseData]);

  // Infinite scroll: load next page when sentinel enters viewport
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

  // Back to top button: show after ~50 rows scrolled
  useEffect(() => {
    const handleScroll = () => setShowBackToTop(window.scrollY > 2500);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const eligibleAccounts = (accounts ?? []).filter((a) => EXPENSE_ACCOUNT_TYPES.includes(a.type));
  const hasActiveFilters = !!(
    applied.accountIds.length > 0 ||
    applied.categoryIds.length > 0 ||
    applied.tagIds.length > 0 ||
    applied.startDate !== EXPENSE_DEFAULT_FILTERS.startDate ||
    (applied.endDate && applied.endDate !== todayStr) ||
    showUncategorized
  );
  const uncategorizedCount = uncatData?.count ?? 0;

  // Re-fetch every page that has already been loaded so mutations are visible
  // without losing scroll position or truncating the list.
  const refreshLoaded = useCallback(async () => {
    const pagesToRefresh = Math.max(currentPage, 1);
    const freshItems: Expense[] = [];
    let moreAvailable = false;

    for (let p = 1; p <= pagesToRefresh; p++) {
      const result = await getExpenses({ ...filterParams, page: String(p) });
      if (!result) break;
      freshItems.push(...(result.data ?? []));
      moreAvailable = p < result.pagination.totalPages;
      if (p >= result.pagination.totalPages) break;
    }

    setAllExpenses(freshItems);
    setHasMore(moreAvailable);
  }, [currentPage, filterParams]);

  const refetchAll = useCallback(() => {
    refreshLoaded();
    refetchUpcoming();
  }, [refreshLoaded, refetchUpcoming]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleSetGroupPrimary = useCallback(
    async (groupId: string, expenseId: string) => {
      await updateTransactionGroup(groupId, { primaryExpenseId: expenseId });
      refetchAll();
    },
    [refetchAll],
  );

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
    setModalOpen(false);
    setEditing(null);
    setOffsetParent(null);

    if (deleteFuture) {
      // Deleting all future recurring instances — too complex to undo, do it immediately.
      await deleteExpense(id, true);
      refetchAll();
      refetchUncat();
      return;
    }

    // Optimistic single deletion: hide the expense immediately, then actually
    // delete after 8 seconds unless the user hits Undo.
    setPendingDeleteIds((prev) => new Set([...prev, id]));

    const timerId = setTimeout(async () => {
      await deleteExpense(id);
      setPendingDeleteIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
      pendingDeleteTimers.current.delete(id);
      refetchAll();
      refetchUncat();
    }, 8000);

    pendingDeleteTimers.current.set(id, timerId);

    addToast({
      message: "Expense deleted",
      onUndo: () => {
        clearTimeout(timerId);
        pendingDeleteTimers.current.delete(id);
        setPendingDeleteIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
      },
      duration: 8000,
    });
  };

  const handleCreateOffset = (expense: Expense) => {
    setEditing(null);
    setOffsetParent(expense);
    setModalOpen(true);
  };

  const handleDragStart = useCallback((e: React.MouseEvent, expense: Expense, sourceType: "negative" | "offset") => {
    if (e.button !== 0) return;
    if (isInteractiveElement(e.target)) return;
    e.preventDefault();
    setDragState({
      sourceId: expense.id,
      sourceType,
      sourceParentId: expense.parentExpenseId,
      startPos: { x: e.clientX, y: e.clientY },
      mousePos: { x: e.clientX, y: e.clientY },
      started: false,
      targetId: null,
    });
  }, []);

  const executeDrop = useCallback(async (state: DragState) => {
    if (state.sourceType === "offset") {
      if (!state.targetId?.startsWith("__dz__")) return;
      await updateExpenseParent(state.sourceId, null);
    } else {
      const targetId = state.targetId!;
      if (targetId === state.sourceId) return;
      await updateExpenseParent(state.sourceId, targetId);
    }
    refetchAll();
    refetchUncat();
  }, [refetchAll, refetchUncat]);

  const executeDropRef = useRef(executeDrop);
  executeDropRef.current = executeDrop;

  useEffect(() => {
    if (!dragState) return;

    function onMove(e: MouseEvent) {
      setDragState((prev) => {
        if (!prev) return null;
        const dx = e.clientX - prev.startPos.x;
        const dy = e.clientY - prev.startPos.y;
        const started = prev.started || Math.hypot(dx, dy) > DRAG_THRESHOLD;
        const targetId = started ? getTargetIdAtPoint(e.clientX, e.clientY) : prev.targetId;
        return { ...prev, mousePos: { x: e.clientX, y: e.clientY }, started, targetId };
      });
    }

    async function onUp() {
      const latest = dragStateRef.current;
      if (latest?.started && latest?.targetId) {
        await executeDropRef.current(latest);
      }
      setDragState(null);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragState?.sourceId]);

  const handleInlineUpdate = useCallback(async (id: string, field: string, value: string) => {
    const data: Record<string, unknown> = {};
    if (field === "date") data.date = value;
    else if (field === "amount") data.amount = parseFloat(value);
    else data[field] = value;

    // Check if this expense is recurring — if so, show confirmation
    const allVisible = [...allExpenses, ...(upcomingData?.data ?? [])];
    const exp = allVisible.find((e) => e.id === id)
      || allVisible.flatMap((e) => e.offsets ?? []).find((e) => e.id === id);
    if (exp?.recurrenceRuleId) {
      setRecurringConfirm({ mode: "edit", expenseId: id, data, field });
      return;
    }

    await updateExpense(id, data);
    refetchAll();
    if (field === "vendor") refetchVendors();
    if (field === "categoryId") refetchUncat();
  }, [allExpenses, upcomingData, refetchAll, refetchVendors, refetchUncat]);

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
      await handleDelete(expenseId, updateFuture);
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
  };

  const applyFilters = () => {
    setApplied({ ...staged });
    saveExpenseFilters(staged);
    clearSelection();
  };


  const resetFilters = () => {
    setStaged({ ...EXPENSE_DEFAULT_FILTERS });
    setApplied({ ...EXPENSE_DEFAULT_FILTERS });
    saveExpenseFilters(EXPENSE_DEFAULT_FILTERS);
    setShowUncategorized(false);
    clearSelection();
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (!sort || sort.field !== field) return <ArrowUpDown className="ml-1 inline h-3 w-3 opacity-40" />;
    return sort.order === "asc"
      ? <ArrowUp className="ml-1 inline h-3 w-3" />
      : <ArrowDown className="ml-1 inline h-3 w-3" />;
  };

  const expenses = allExpenses.filter((e) => !pendingDeleteIds.has(e.id));

  // Upcoming expenses are a small fixed set (future-dated), so client-side filtering
  // is fine here. Mirror the server logic: text contains OR exact amount match.
  const upcomingExpenses = useMemo(() => {
    // For recurring expenses, show only the next (earliest) instance per rule.
    // Data is sorted ascending by date, so the first seen per ruleId is the nearest.
    // Also hide any expenses that are awaiting optimistic deletion.
    const seenRuleIds = new Set<string>();
    const all = (upcomingData?.data ?? [])
      .filter((e) => !pendingDeleteIds.has(e.id))
      .filter((e) => {
        if (!e.recurrenceRuleId) return true;
        if (seenRuleIds.has(e.recurrenceRuleId)) return false;
        seenRuleIds.add(e.recurrenceRuleId);
        return true;
      });
    if (!appliedSearch.trim()) return all;
    const q = appliedSearch.trim().toLowerCase();
    const asNumber = parseFloat(appliedSearch.trim());
    return all.filter((e) =>
      e.description.toLowerCase().includes(q) ||
      e.vendor.toLowerCase().includes(q) ||
      (!isNaN(asNumber) && asNumber > 0 && Math.abs(parseFloat(e.amount)) === asNumber)
    );
  }, [upcomingData, appliedSearch, pendingDeleteIds]);

  // ── Group action derivation ─────────────────────────────────────────────
  // Determines whether the bulk-edit bar should show "Group Transactions" or
  // "Remove from Group" based on the selected expenses' group memberships.
  const { groupAction, targetGroupId } = useMemo((): {
    groupAction: GroupAction;
    targetGroupId: string | null;
  } => {
    if (selectedIds.size === 0) return { groupAction: "group", targetGroupId: null };
    const selected = expenses.filter((e) => selectedIds.has(e.id));
    const distinctGroupIds = [
      ...new Set(selected.filter((e) => e.transactionGroupId).map((e) => e.transactionGroupId!)),
    ];
    const hasUngrouped = selected.some((e) => !e.transactionGroupId);

    if (distinctGroupIds.length === 0) {
      // All ungrouped → create new group
      return { groupAction: "group", targetGroupId: null };
    }
    if (distinctGroupIds.length === 1 && hasUngrouped) {
      // Exactly one existing group + some ungrouped → add ungrouped to existing
      return { groupAction: "group", targetGroupId: distinctGroupIds[0] };
    }
    if (distinctGroupIds.length === 1 && !hasUngrouped) {
      // All in the same group → offer to remove
      return { groupAction: "ungroup", targetGroupId: distinctGroupIds[0] };
    }
    // 2+ distinct groups (with or without ungrouped) → must remove first
    return { groupAction: "ungroup", targetGroupId: null };
  }, [selectedIds, expenses]);

  const upcomingExpenseIdSet = useMemo(
    () => new Set(upcomingExpenses.map((e) => e.id)),
    [upcomingExpenses],
  );
  const groupActionDisabled = useMemo(() => {
    if (selectedIds.size === 0) return false;
    const hasUpcoming = [...selectedIds].some((id) => upcomingExpenseIdSet.has(id));
    const hasRegular = [...selectedIds].some((id) => !upcomingExpenseIdSet.has(id));
    return hasUpcoming && hasRegular;
  }, [selectedIds, upcomingExpenseIdSet]);

  const handleGroupAction = useCallback(async () => {
    const selectedArr = [...selectedIds];
    if (groupAction === "group") {
      if (targetGroupId) {
        // Add only the ungrouped expenses to the existing group
        const ungroupedIds = expenses
          .filter((e) => selectedIds.has(e.id) && !e.transactionGroupId)
          .map((e) => e.id);
        await updateTransactionGroup(targetGroupId, { addExpenseIds: ungroupedIds });
      } else {
        await createTransactionGroup({ expenseIds: selectedArr });
      }
    } else {
      // Remove selected from their respective groups
      const byGroup = new Map<string, string[]>();
      for (const e of expenses.filter((e) => selectedIds.has(e.id) && e.transactionGroupId)) {
        const arr = byGroup.get(e.transactionGroupId!) ?? [];
        arr.push(e.id);
        byGroup.set(e.transactionGroupId!, arr);
      }
      await Promise.all(
        [...byGroup.entries()].map(([gId, ids]) =>
          updateTransactionGroup(gId, { removeExpenseIds: ids }),
        ),
      );
    }
    clearSelection();
    refetchAll();
    refetchUncat();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, expenses, groupAction, targetGroupId]);

  // "Set as primary": shown only when exactly one non-primary grouped expense is selected
  const setAsPrimaryTarget = useMemo((): { expenseId: string; groupId: string } | null => {
    if (selectedIds.size !== 1) return null;
    const [id] = [...selectedIds];
    const expense = expenses.find((e) => e.id === id);
    if (!expense?.transactionGroupId) return null;
    if (expense.transactionGroup?.primaryExpenseId === id) return null;
    return { expenseId: id, groupId: expense.transactionGroupId };
  }, [selectedIds, expenses]);

  const handleSetAsPrimary = useCallback(async () => {
    if (!setAsPrimaryTarget) return;
    await handleSetGroupPrimary(setAsPrimaryTarget.groupId, setAsPrimaryTarget.expenseId);
    clearSelection();
  }, [setAsPrimaryTarget, handleSetGroupPrimary, clearSelection]);

  // Keyboard shortcuts (placed after handleGroupAction, setAsPrimaryTarget, handleSetAsPrimary)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (modalOpen || importModalOpen) return;
      const target = e.target as HTMLElement;
      const inputType = (target as HTMLInputElement).type;
      const isTextInput = (target.tagName === "INPUT" && inputType !== "checkbox" && inputType !== "radio")
        || target.tagName === "TEXTAREA"
        || target.tagName === "SELECT"
        || target.isContentEditable;
      if (isTextInput) return;
      if (e.key === "a" || e.key === "A") {
        setEditing(null);
        setOffsetParent(null);
        setModalOpen(true);
      } else if (e.key === "g" || e.key === "G") {
        if (selectedIds.size > 1) handleGroupAction();
      } else if (e.key === "p" || e.key === "P") {
        if (setAsPrimaryTarget) handleSetAsPrimary();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen, importModalOpen, selectedIds, setAsPrimaryTarget, handleGroupAction, handleSetAsPrimary]);

  const dragSource = useMemo(() => {
    if (!dragState) return null;
    const all = expenses.flatMap((e) => [e, ...(e.offsets ?? [])]);
    return all.find((e) => e.id === dragState.sourceId) ?? null;
  }, [dragState?.sourceId, expenses]);

  // Flat rows with optional group metadata. Grouped expenses are emitted together the
  // first time any member is encountered (server already sorted them by primary date).
  const groupedRows = useMemo(() => {
    const seenGroupIds = new Set<string>();

    // Collect all members per group, in the order they appear in `expenses`
    const groupMembersInOrder = new Map<string, Expense[]>();
    for (const e of expenses) {
      if (e.transactionGroupId) {
        const arr = groupMembersInOrder.get(e.transactionGroupId) ?? [];
        arr.push(e);
        groupMembersInOrder.set(e.transactionGroupId, arr);
      }
    }

    const rows: Array<{ expense: Expense; groupMeta?: GroupMeta }> = [];
    for (const e of expenses) {
      if (!e.transactionGroupId) {
        rows.push({ expense: e });
        continue;
      }
      const groupId = e.transactionGroupId;
      if (seenGroupIds.has(groupId)) continue; // already emitted by first encounter
      seenGroupIds.add(groupId);

      const members = groupMembersInOrder.get(groupId) ?? [e];
      const primaryExpenseId = e.transactionGroup?.primaryExpenseId ?? null;

      // Sort members: primary first, then non-fully-offset (date desc), then fully-offset (date desc)
      const isFullyOffset = (m: Expense) => {
        if (!m.offsets?.length) return false;
        const offsetTotal = m.offsets.reduce((sum, o) => sum + Math.abs(parseFloat(o.amount)), 0);
        return offsetTotal >= Math.abs(parseFloat(m.amount));
      };
      const sortedMembers = [...members].sort((a, b) => {
        const aIsPrimary = primaryExpenseId ? a.id === primaryExpenseId : false;
        const bIsPrimary = primaryExpenseId ? b.id === primaryExpenseId : false;
        if (aIsPrimary !== bIsPrimary) return aIsPrimary ? -1 : 1;
        const aFullyOffset = isFullyOffset(a);
        const bFullyOffset = isFullyOffset(b);
        if (aFullyOffset !== bFullyOffset) return aFullyOffset ? 1 : -1;
        // Tiebreak: date descending
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      });

      sortedMembers.forEach((member, idx) => {
        rows.push({
          expense: member,
          groupMeta: {
            groupId,
            isPrimary: primaryExpenseId ? member.id === primaryExpenseId : idx === 0,
            primaryExpenseId,
            isFirstInGroup: idx === 0,
            isLastInGroup: idx === sortedMembers.length - 1,
          },
        });
      });
    }
    return rows;
  }, [expenses]);

  const anchorIdxRef = useRef<number | null>(null);
  const handleCheckboxChange = useCallback((id: string, idx: number, e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey && anchorIdxRef.current !== null) {
      const anchor = anchorIdxRef.current;
      // Apply the clicked item's toggled state to the entire anchor→clicked range
      const newState = !selectedIds.has(id);
      const start = Math.min(anchor, idx);
      const end = Math.max(anchor, idx);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        groupedRows.slice(start, end + 1).forEach((row) => {
          if (newState) next.add(row.expense.id);
          else next.delete(row.expense.id);
        });
        return next;
      });
    } else {
      toggleSelect(id);
    }
    anchorIdxRef.current = idx;
  }, [groupedRows, toggleSelect, selectedIds]);

  const UPCOMING_PAGE_SIZE = 5;
  const visibleUpcoming = useMemo(
    () => upcomingExpanded ? upcomingExpenses : upcomingExpenses.slice(0, UPCOMING_PAGE_SIZE),
    [upcomingExpanded, upcomingExpenses],
  );

  const anchorUpcomingIdxRef = useRef<number | null>(null);
  const handleUpcomingCheckboxChange = useCallback((id: string, idx: number, e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey && anchorUpcomingIdxRef.current !== null) {
      const anchor = anchorUpcomingIdxRef.current;
      const newState = !selectedIds.has(id);
      const start = Math.min(anchor, idx);
      const end = Math.max(anchor, idx);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        visibleUpcoming.slice(start, end + 1).forEach((exp) => {
          if (newState) next.add(exp.id);
          else next.delete(exp.id);
        });
        return next;
      });
    } else {
      toggleSelect(id);
    }
    anchorUpcomingIdxRef.current = idx;
  }, [visibleUpcoming, toggleSelect, selectedIds]);

  const parentCategories = (categories ?? []).filter((c) => !c.parentId);
  const childCategories = (categories ?? []).filter((c) => c.parentId);

  // Multi-select filter options
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

  const categoryFilterOptions = useMemo<MultiSelectOption[]>(() => {
    const opts: MultiSelectOption[] = [];
    for (const parent of parentCategories) {
      const children = childCategories.filter((c) => c.parentId === parent.id);
      if (children.length === 0) {
        opts.push({ id: parent.id, label: parent.name });
      } else {
        for (const child of children) {
          opts.push({ id: child.id, label: `${parent.name} > ${child.name}` });
        }
      }
    }
    return opts;
  }, [parentCategories, childCategories]);

  const tagFilterOptions = useMemo<MultiSelectOption[]>(() =>
    (tags ?? []).map((t) => ({ id: t.id, label: t.name })),
  [tags]);

  const allRegularExpenseIds = useMemo(
    () => groupedRows.map((row) => row.expense.id),
    [groupedRows],
  );

  const allUpcomingExpenseIds = useMemo(
    () => upcomingExpenses.map((e) => e.id),
    [upcomingExpenses],
  );



  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <h2 className="tp-page-title">Expenses</h2>
        <div className="flex items-center gap-2">
          {/* Uncategorized quick filter */}
          {uncategorizedCount > 0 && (
            <Button
              variant={showUncategorized ? "destructive" : "secondary"}
              size="sm"
              onClick={() => { setShowUncategorized(!showUncategorized); }}
            >
              <AlertTriangle className="h-4 w-4" />
              Show Uncategorized
              <span className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs font-bold text-white">
                {uncategorizedCount}
              </span>
            </Button>
          )}
          <Link
            to="/expenses/reimbursements"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <AlertCircle className="h-4 w-4" />
            Reimbursements
          </Link>
          <Link
            to="/expenses/tags"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <TagIcon className="h-4 w-4" />
            Tags
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
          <Button
            variant={filterOpen ? "primary" : "secondary"}
            className={filterOpen ? "" : "border border-border"}
            onClick={() => setFilterOpen(!filterOpen)}
          >
            <Filter className="h-4 w-4" />
            {hasActiveFilters && <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 text-xs">!</span>}
          </Button>
          <Button variant="secondary" className="border border-border" onClick={() => setImportModalOpen(true)}>
            <Upload className="h-4 w-4" /> Import
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
                placeholder="All Categories"
                searchable
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Tag</label>
              <MultiSelectDropdown
                options={tagFilterOptions}
                selected={staged.tagIds}
                onChange={(ids) => setStaged((s) => ({ ...s, tagIds: ids }))}
                placeholder="All Tags"
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
                <input type="date" value={staged.startDate} onChange={(e) => setStaged((s) => ({ ...s, startDate: e.target.value, datePreset: "Custom" }))} className="rounded-md border border-border px-2 py-2 text-sm" />
                <span className="tp-caption">→</span>
                <input type="date" value={staged.endDate || todayStr} onChange={(e) => setStaged((s) => ({ ...s, endDate: e.target.value, datePreset: "Custom" }))} className="rounded-md border border-border px-2 py-2 text-sm" />
              </div>
            </div>
            {/* Invisible label spacer keeps Reset + Apply vertically aligned with the filter fields */}
            <div>
              <label className="mb-1 block text-xs invisible select-none" aria-hidden="true">x</label>
              <div className="flex h-8 items-center gap-3">
                <button onClick={resetFilters} className="text-[13px] text-muted-foreground hover:text-foreground hover:underline">
                  Reset to defaults
                </button>
                <Button size="sm" onClick={applyFilters}>Apply</Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Upcoming expenses table */}
      {upcomingExpenses.length > 0 && (
        <Card>
          <SectionLabel as="h3" className="mb-3 text-sm">Upcoming</SectionLabel>
          {(() => {
            const hasMore = upcomingExpenses.length > UPCOMING_PAGE_SIZE;
            return (
              <>
                <div className="hidden md:block">
                  <div className="relative">
                    <table className="w-full table-fixed text-13">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="w-[44px] pb-3 pr-2 border-l-[3px] border-l-transparent text-center">
                            <input
                              type="checkbox"
                              ref={(el) => { if (el) { el.indeterminate = allUpcomingExpenseIds.some((id) => selectedIds.has(id)) && !allUpcomingExpenseIds.every((id) => selectedIds.has(id)); } }}
                              checked={allUpcomingExpenseIds.length > 0 && allUpcomingExpenseIds.every((id) => selectedIds.has(id))}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedIds((prev) => new Set([...prev, ...allUpcomingExpenseIds]));
                                } else {
                                  setSelectedIds((prev) => { const next = new Set(prev); allUpcomingExpenseIds.forEach((id) => next.delete(id)); return next; });
                                }
                              }}
                              className="h-4 w-4 rounded accent-primary"
                            />
                          </th>
                          <ColumnHeader className="w-[70px] pb-3 pr-3">Date</ColumnHeader>
                          <ColumnHeader className="pb-3 pr-3">Description</ColumnHeader>
                          <th className="w-[60px] pb-3"></th>
                          <ColumnHeader className="w-[170px] pb-3 pr-3">Vendor</ColumnHeader>
                          <ColumnHeader className="w-[190px] pb-3 pr-3">Category</ColumnHeader>
                          <ColumnHeader className="w-[155px] pb-3 pr-3">Account</ColumnHeader>
                          <th className="w-[30px] pb-3"></th>
                          <ColumnHeader className="w-[90px] pb-3 text-right">Amount</ColumnHeader>
                          <th className="w-[60px] pb-3"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {visibleUpcoming.map((expense, idx) => (
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
                            isSelected={selectedIds.has(expense.id)}
                            onToggleSelect={(id, e) => handleUpcomingCheckboxChange(id, idx, e)}
                          />
                        ))}
                      </tbody>
                    </table>
                    {hasMore && !upcomingExpanded && (
                      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-card to-transparent" />
                    )}
                  </div>
                </div>
                {/* Mobile upcoming */}
                <div className="md:hidden">
                  <div className="relative">
                    <div className="divide-y divide-border">
                      {visibleUpcoming.map((expense) => (
                        <div key={expense.id} className="flex items-center justify-between py-3 italic opacity-60">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{expense.description}</p>
                            <p className="text-sm text-muted-foreground">
                              {expense.vendor && <>{expense.vendor} &middot; </>}
                              {expense.category?.name ?? <span className="text-red-500">[Uncategorized]</span>} &middot; {formatDate(expense.date)}
                            </p>
                          </div>
                          <div className="ml-4 flex items-center gap-2">
                            <span className={`font-semibold ${parseFloat(expense.amount) < 0 ? "text-green-600" : ""}`}>{formatCurrency(expense.amount)}</span>
                            <button onClick={() => openEdit(expense)} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"><Pencil className="h-4 w-4" /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {hasMore && !upcomingExpanded && (
                      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-card to-transparent" />
                    )}
                  </div>
                </div>
                {hasMore && (
                  <button
                    onClick={() => setUpcomingExpanded((v) => !v)}
                    className="mt-2 flex w-full items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                  >
                    {upcomingExpanded ? (
                      <><ChevronDown className="h-4 w-4 rotate-180" /> Collapse</>
                    ) : (
                      <><ChevronDown className="h-4 w-4" /> Show {upcomingExpenses.length - UPCOMING_PAGE_SIZE} more</>
                    )}
                  </button>
                )}
              </>
            );
          })()}
        </Card>
      )}

      <Card>
        {expenses.length > 0 ? (
          <>
            <div className="hidden md:block">
              <table className="w-full table-fixed text-13">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="w-[44px] pb-3 pr-2 border-l-[3px] border-l-transparent text-center">
                      <input
                        type="checkbox"
                        ref={(el) => { if (el) { el.indeterminate = allRegularExpenseIds.some((id) => selectedIds.has(id)) && !allRegularExpenseIds.every((id) => selectedIds.has(id)); } }}
                        checked={allRegularExpenseIds.length > 0 && allRegularExpenseIds.every((id) => selectedIds.has(id))}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedIds((prev) => new Set([...prev, ...allRegularExpenseIds]));
                          } else {
                            setSelectedIds((prev) => { const next = new Set(prev); allRegularExpenseIds.forEach((id) => next.delete(id)); return next; });
                          }
                        }}
                        className="h-4 w-4 rounded accent-primary"
                      />
                    </th>
                    <ColumnHeader className="w-[70px] cursor-pointer select-none pb-3 pr-3" onClick={() => toggleSort("date")}>Date <SortIcon field="date" /></ColumnHeader>
                    <ColumnHeader className="cursor-pointer select-none pb-3 pr-3" onClick={() => toggleSort("description")}>Description <SortIcon field="description" /></ColumnHeader>
                    <th className="w-[60px] pb-3"></th>
                    <ColumnHeader className="w-[170px] cursor-pointer select-none pb-3 pr-3" onClick={() => toggleSort("vendor")}>Vendor <SortIcon field="vendor" /></ColumnHeader>
                    <ColumnHeader className="w-[190px] cursor-pointer select-none pb-3 pr-3" onClick={() => toggleSort("category")}>Category <SortIcon field="category" /></ColumnHeader>
                    <ColumnHeader className="w-[155px] cursor-pointer select-none pb-3 pr-3" onClick={() => toggleSort("account")}>Account <SortIcon field="account" /></ColumnHeader>
                    <th className="w-[30px] pb-3"></th>
                    <ColumnHeader className="w-[90px] cursor-pointer select-none pb-3 text-right" onClick={() => toggleSort("amount")}>Amount <SortIcon field="amount" /></ColumnHeader>
                    <th className="w-[60px] pb-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {groupedRows.map((row, idx) => (
                    <ExpenseRowWithOffsets
                      key={row.expense.id}
                      expense={row.expense}
                      onEdit={openEdit}
                      onInlineUpdate={handleInlineUpdate}
                      onCreateOffset={handleCreateOffset}
                      vendors={vendorList ?? []}
                      accounts={eligibleAccounts}
                      categories={categories ?? []}
                      isSelected={selectedIds.has(row.expense.id)}
                      onToggleSelect={(id, e) => handleCheckboxChange(id, idx, e)}
                      dragState={dragState}
                      onDragStart={handleDragStart}
                      groupMeta={row.groupMeta}
                    />
                  ))}
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
                    <span className={`font-semibold ${parseFloat(expense.amount) < 0 ? "text-green-600" : ""}`}>
                      {parseFloat(expense.amount) < 0
                        ? `+${formatCurrency(Math.abs(parseFloat(expense.amount)))}`
                        : formatCurrency(parseFloat(expense.amount))}
                    </span>
                    <button onClick={() => openEdit(expense)} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"><Pencil className="h-4 w-4" /></button>
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
            icon={Receipt}
            title="No expenses yet"
            description={hasActiveFilters || showUncategorized
              ? "No expenses match your current filters."
              : "Start tracking your spending by adding your first expense."
            }
            action={
              hasActiveFilters || showUncategorized
                ? <Button variant="secondary" onClick={resetFilters}>Clear Filters</Button>
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
        onCreateTag={async (name) => { const t = await createTag({ name }); refetchTags(); return t; }}
      />

      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onComplete={() => { setImportModalOpen(false); refetchAll(); refetchVendors(); refetchUncat(); }}
        categories={categories ?? []}
        accounts={eligibleAccounts}
      />

      {selectedIds.size > 0 && (
        <BulkEditBar
          ids={[...selectedIds]}
          categories={categories ?? []}
          tags={tags ?? []}
          initialTagIds={[...new Set(
            expenses
              .filter((e) => selectedIds.has(e.id))
              .flatMap((e) => e.tags.map((et) => et.tagId))
          )]}
          groupAction={groupAction}
          setAsPrimaryTarget={setAsPrimaryTarget}
          onClear={clearSelection}
          onSuccess={() => {
            clearSelection();
            refetchAll();
            refetchUncat();
          }}
          onGroupAction={handleGroupAction}
          onSetAsPrimary={handleSetAsPrimary}
          onCreateTag={async (name) => { const t = await createTag({ name }); refetchTags(); return t; }}
          groupActionDisabled={groupActionDisabled}
          groupActionDisabledTitle="Cannot group upcoming and posted transactions together"
          selectedTransactions={[...expenses, ...upcomingExpenses]
            .filter((e) => selectedIds.has(e.id))
            .map((e) => {
              const rawOffsetSum = (e.offsets ?? []).reduce((s, o) => s + parseFloat(o.amount), 0);
              const net = parseFloat(e.amount) + rawOffsetSum;
              return { amount: String(net), isJoint: e.account.isJoint };
            })}
        />
      )}

      {/* Recurring action confirmation dialog */}
      {recurringConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg bg-background p-6 shadow-xl">
            <h3 className="tp-panel-title">
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

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* Floating drag follower */}
      {dragState?.started && dragSource && (
        <div
          style={{
            position: "fixed",
            left: dragState.mousePos.x + 14,
            top: dragState.mousePos.y - 12,
            pointerEvents: "none",
            zIndex: 9999,
          }}
          className="flex items-center gap-2 rounded border border-border bg-white px-3 py-1.5 text-sm shadow-lg opacity-95"
        >
          <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">{dragSource.vendor}</span>
          <span className="text-green-600 font-semibold">
            +{formatCurrency(Math.abs(parseFloat(dragSource.amount)))}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Offset sub-row (lighter/smaller styling) ──
function OffsetRow({
  offset, onEdit, onInlineUpdate, accounts, categories, isUpcoming, dragState, onDragStart, isGrouped, isFullyOffset,
}: {
  offset: Expense;
  onEdit: (e: Expense) => void;
  onInlineUpdate: (id: string, field: string, value: string) => Promise<void>;
  accounts: Account[];
  categories: Category[];
  isUpcoming?: boolean;
  dragState?: DragState | null;
  onDragStart?: (e: React.MouseEvent, expense: Expense, sourceType: "negative" | "offset") => void;
  isGrouped?: boolean;
  isFullyOffset?: boolean;
}) {
  const upcomingClass = isUpcoming ? "italic opacity-60" : "";
  const textClass = isFullyOffset ? "text-gray-300" : "text-muted-foreground";
  const isBeingDragged = dragState?.started && dragState?.sourceId === offset.id;
  const isDraggable = !isUpcoming;

  return (
    <tr
      className={`bg-muted/20 hover:bg-muted/30 ${upcomingClass} ${isDraggable ? "cursor-grab" : ""} ${isBeingDragged ? "opacity-40" : ""}`}
      onMouseDown={isDraggable ? (e) => onDragStart?.(e, offset, "offset") : undefined}
    >
      <td className={`w-[44px] py-2 pr-2 border-l-[3px] text-center ${isGrouped ? "border-primary/30" : "border-transparent"}`}></td>
      <td className={`w-[70px] py-2 pr-3 ${textClass}`}>
        <EditableCell value={offset.date} type="date" onSave={(v) => onInlineUpdate(offset.id, "date", v)} className={textClass} />
      </td>
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <Undo2 className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
          <EditableCell
            value={offset.description}
            onSave={(v) => onInlineUpdate(offset.id, "description", v)}
            className={textClass}
          />
        </div>
      </td>
      <td className="w-[60px] py-2"></td>
      <td className={`w-[170px] py-2 pr-3 ${textClass}`}>
        <EditableVendorCell value={offset.vendor} vendors={[]} onSave={(v) => onInlineUpdate(offset.id, "vendor", v)} className={textClass} />
      </td>
      <td className={`w-[190px] py-2 pr-3 ${textClass}`}>
        <EditableCategoryCell
          value={offset.categoryId}
          label={offset.category?.name ?? ""}
          categories={categories}
          isUncategorized={!offset.categoryId}
          onSave={(v) => onInlineUpdate(offset.id, "categoryId", v)}
        />
      </td>
      <td className={`w-[195px] py-2 pr-3 ${textClass}`}>
        <EditableAccountCell
          value={offset.accountId}
          label={offset.account.name}
          color={offset.account.color}
          accounts={accounts}
          onSave={(v) => onInlineUpdate(offset.id, "accountId", v)}
        />
      </td>
      <td className="w-[30px] py-2 text-center">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white" style={{ backgroundColor: offset.account.isJoint ? JOINT_COLOR : PERSONAL_COLOR }}>
          {offset.account.isJoint ? "J" : "P"}
        </span>
      </td>
      <td className="w-[90px] py-2 text-right font-semibold font-mono tabular-nums text-green-600">
        <EditableAmountCell value={offset.amount} onSave={(v) => onInlineUpdate(offset.id, "amount", v)} isOffset />
      </td>
      <td className="w-[60px] py-2 text-right">
        <button onClick={() => onEdit(offset)} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors">
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

// ── Parent row with offset sub-rows ──
function ExpenseRowWithOffsets({
  expense, onEdit, onInlineUpdate, onCreateOffset, vendors, accounts, categories, isUpcoming,
  isSelected, onToggleSelect, dragState, onDragStart, groupMeta,
}: {
  expense: Expense;
  onEdit: (e: Expense) => void;
  onInlineUpdate: (id: string, field: string, value: string) => Promise<void>;
  onCreateOffset: (e: Expense) => void;
  isUpcoming?: boolean;
  vendors: string[];
  accounts: Account[];
  categories: Category[];
  isSelected?: boolean;
  onToggleSelect?: (id: string, e: React.ChangeEvent<HTMLInputElement>) => void;
  dragState?: DragState | null;
  onDragStart?: (e: React.MouseEvent, expense: Expense, sourceType: "negative" | "offset") => void;
  groupMeta?: GroupMeta;
}) {
  const navigate = useNavigate();
  const offsets = expense.offsets ?? [];
  const hasOffsets = offsets.length > 0;
  const offsetTotal = offsets.reduce((sum, o) => sum + Math.abs(parseFloat(o.amount)), 0);
  const parentAmount = parseFloat(expense.amount);
  const isFullyReimbursed = hasOffsets && offsetTotal >= parentAmount;
  const rawOffsetSum = offsets.reduce((s, o) => s + parseFloat(o.amount), 0);
  const isFullyOffset = hasOffsets && Math.abs(parentAmount + rawOffsetSum) < 0.005;

  const isUncategorized = !expense.categoryId;
  const isRecurring = !!expense.recurrenceRuleId;
  const isNegativeStandalone = parentAmount < 0 && !isUpcoming;
  const isBeingDragged = dragState?.started && dragState?.sourceId === expense.id;
  const isDragTarget = dragState?.started && dragState?.targetId === expense.id && dragState?.sourceId !== expense.id;
  const showOffsetDropZone = dragState?.started && dragState?.sourceType === "offset" && dragState?.sourceParentId === expense.id;

  const rowBg = isUncategorized
    ? "bg-red-50/50 hover:bg-red-50"
    : isRecurring
    ? "bg-blue-50/50 hover:bg-blue-50"
    : expense.isReimbursementExpected && !isFullyReimbursed
    ? "bg-amber-50/50 hover:bg-amber-50"
    : "hover:bg-muted/50";

  const upcomingClass = isUpcoming ? "italic opacity-60" : "";
  const dragTargetClass = isDragTarget ? "ring-2 ring-blue-400 ring-inset bg-blue-50/60" : "";
  const dragGhostClass = isBeingDragged ? "opacity-40" : "";
  const dragCursorClass = isNegativeStandalone ? "cursor-grab" : "";

  // Determine reimbursement status icon
  const StatusIcon = () => {
    if (isFullyReimbursed) {
      return <span title="Fully reimbursed" className="inline-flex flex-shrink-0"><CheckCircle2 className="h-4 w-4 text-green-500" /></span>;
    }
    if (expense.isReimbursementExpected) {
      return <span title={expense.reimbursementNote ?? "Reimbursement expected"} className="inline-flex flex-shrink-0"><AlertCircle className="h-4 w-4 text-amber-500" /></span>;
    }
    return null;
  };

  return (
    <>
      <tr
        data-expense-id={expense.id}
        className={`group/row ${rowBg} ${upcomingClass} ${dragTargetClass} ${dragGhostClass} ${dragCursorClass}`}
        onMouseDown={isNegativeStandalone ? (e) => onDragStart?.(e, expense, "negative") : undefined}
      >
        <td
          className={`w-[44px] py-2 pr-2 border-l-[3px] text-center ${
            groupMeta
              ? groupMeta.isPrimary ? "border-primary" : "border-primary/30"
              : "border-transparent"
          }`}
        >
          <input
            type="checkbox"
            checked={isSelected ?? false}
            onChange={(e) => onToggleSelect?.(expense.id, e)}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 rounded accent-primary"
          />
        </td>
        <td className={`w-[70px] py-2 pr-3 ${isFullyOffset ? "text-gray-300" : (groupMeta && !groupMeta.isPrimary) ? "text-muted-foreground" : ""}`}>
          <EditableCell value={expense.date} type="date" onSave={(v) => onInlineUpdate(expense.id, "date", v)} />
        </td>
        <td className="py-2 pr-3">
          <EditableCell value={expense.description} onSave={(v) => onInlineUpdate(expense.id, "description", v)} className={`font-medium${isFullyOffset ? " text-gray-300" : ""}`} />
          {expense.tags.length > 0 && (
            <div className="mt-0.5 flex flex-wrap gap-1">
              {expense.tags.map(({ tag }) => (
                <span key={tag.id} className="whitespace-nowrap rounded-full px-1.5 py-0.5 text-xs font-medium" style={{ backgroundColor: tag.color ? `${tag.color}25` : "var(--color-gray-400)", color: tag.color ?? "#fff" }}>
                  {tag.name}
                </span>
              ))}
            </div>
          )}
        </td>
        <td className="w-[60px] py-2 pr-3">
          <div className="flex items-center justify-end gap-1.5">
            <StatusIcon />
            {isRecurring && (
              <button
                title="View recurring rule"
                className="inline-flex flex-shrink-0 rounded hover:bg-blue-100 transition-colors p-0.5 -m-0.5"
                onClick={(e) => { e.stopPropagation(); navigate(`/recurring?highlight=${expense.recurrenceRuleId}`); }}
              >
                <Repeat className="h-3.5 w-3.5 text-blue-500" />
              </button>
            )}
            {expense.ignoreInBudget && <span title="Ignored in budget" className="inline-flex flex-shrink-0"><EyeOff className="h-3.5 w-3.5 text-gray-300" /></span>}
          </div>
        </td>
        <td className={`w-[170px] py-2 pr-3${isFullyOffset ? " text-gray-300" : ""}`}>
          <EditableVendorCell value={expense.vendor} vendors={vendors} onSave={(v) => onInlineUpdate(expense.id, "vendor", v)} className={isFullyOffset ? "text-gray-300" : undefined} />
        </td>
        <td className={`w-[190px] py-2 pr-3${isFullyOffset ? " text-gray-300" : ""}`}>
          <EditableCategoryCell value={expense.categoryId} label={expense.category?.name ?? ""} categories={categories} isUncategorized={isUncategorized} onSave={(v) => onInlineUpdate(expense.id, "categoryId", v)} />
        </td>
        <td className={`w-[195px] py-2 pr-3${isFullyOffset ? " text-gray-300" : ""}`}>
          <EditableAccountCell value={expense.accountId} label={expense.account.name} color={expense.account.color} accounts={accounts} onSave={(v) => onInlineUpdate(expense.id, "accountId", v)} />
        </td>
        <td className="w-[30px] py-2 text-center">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white" style={{ backgroundColor: expense.account.isJoint ? JOINT_COLOR : PERSONAL_COLOR }}>
            {expense.account.isJoint ? "J" : "P"}
          </span>
        </td>
        <td className={`w-[90px] py-2 text-right font-semibold font-mono tabular-nums ${parseFloat(expense.amount) < 0 ? "text-green-600" : ""}`}>
          <EditableAmountCell value={expense.amount} onSave={(v) => onInlineUpdate(expense.id, "amount", v)} />
        </td>
        <td className="w-[60px] py-2 text-right">
          <div className="flex items-center justify-end gap-0.5">
            {parseFloat(expense.amount) >= 0 && (
              <button onClick={() => onCreateOffset(expense)} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors" title="Add offset / reimbursement">
                <Undo2 className="h-3.5 w-3.5" />
              </button>
            )}
            <button onClick={() => onEdit(expense)} className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors">
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
          dragState={dragState}
          onDragStart={onDragStart}
          isGrouped={!!groupMeta}
          isFullyOffset={isFullyOffset}
        />
      ))}
      {showOffsetDropZone && (
        <tr
          data-dropzone={expense.id}
          className={`transition-colors ${
            dragState?.targetId === `__dz__${expense.id}`
              ? "bg-blue-50"
              : ""
          }`}
        >
          <td
            colSpan={9}
            className={`py-2 px-4 text-sm text-center border-2 border-dashed rounded transition-colors ${
              dragState?.targetId === `__dz__${expense.id}`
                ? "border-blue-400 text-blue-600"
                : "border-gray-300 text-muted-foreground"
            }`}
          >
            Drop here to make independent
          </td>
        </tr>
      )}
    </>
  );
}

// ── Import Modal ──

interface ParsedRow {
  raw: string[];
  date: string;
  description: string;
  vendor: string;
  categoryName: string;
  accountName: string;
  amount: number;
  categoryId: string | null;
  accountId: string | null;
  errors: string[];
}

function parseDate(s: string): string | null {
  s = s.trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // M/D/YYYY or MM/DD/YYYY
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
  open, onClose, onComplete, categories, accounts,
}: {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
  categories: Category[];
  accounts: Account[];
}) {
  const [step, setStep] = useState<"upload" | "preview" | "result">("upload");
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [showErrorsOnly, setShowErrorsOnly] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: Array<{ row: number; message: string }> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setStep("upload");
      setRows([]);
      setResult(null);
      setImporting(false);
      setShowErrorsOnly(false);
    }
  }, [open]);

  // Build lookup maps
  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    // Add top-level categories first, then subcategories so subcategories win on name collision
    for (const c of (categories ?? []).filter((c) => !c.parentId))
      map.set(c.name.toLowerCase(), c.id);
    for (const c of (categories ?? []).filter((c) => c.parentId))
      map.set(c.name.toLowerCase(), c.id);
    return map;
  }, [categories]);

  const accountMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) {
      map.set(a.name.toLowerCase(), a.id);
    }
    return map;
  }, [accounts]);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return;

      // Detect delimiter from first line
      const delimiter = lines[0].includes("\t") ? "\t" : ",";

      // Skip header, parse data rows
      const parsed: ParsedRow[] = [];
      for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i], delimiter);
        if (fields.length < 6) continue;

        // Columns: Date, Description, Vendor, Category, Account, Amount, Tags
        const [rawDate, desc, vendor, catName, acctName, rawAmt] = fields;
        const errors: string[] = [];

        const date = parseDate(rawDate);
        if (!date) errors.push("Invalid date");

        const description = desc?.trim() || "";
        if (!description) errors.push("Missing description");

        const vendorVal = vendor?.trim() || "";
        if (!vendorVal) errors.push("Missing vendor");

        const categoryName = catName?.trim() || "";
        let categoryId: string | null = null;
        if (categoryName) {
          categoryId = categoryMap.get(categoryName.toLowerCase()) ?? null;
          if (!categoryId) errors.push(`Unknown category "${categoryName}"`);
        }

        const accountName = acctName?.trim() || "";
        let accountId: string | null = null;
        if (accountName) {
          accountId = accountMap.get(accountName.toLowerCase()) ?? null;
          if (!accountId) errors.push(`Unknown account "${accountName}"`);
        } else {
          errors.push("Missing account");
        }

        const cleanAmt = rawAmt?.replace(/[$,]/g, "") ?? "";
        const amount = parseFloat(cleanAmt);
        if (isNaN(amount)) errors.push("Invalid amount");
        else if (amount === 0) errors.push("Amount cannot be zero");

        parsed.push({
          raw: fields,
          date: date || rawDate,
          description,
          vendor: vendorVal,
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
  const errorRows = rows.filter((r) => r.errors.length > 0);
  const visibleRows = showErrorsOnly ? errorRows : rows;

  const handleImport = async () => {
    setImporting(true);
    try {
      const payload = validRows.map((r) => ({
        amount: r.amount,
        description: r.description,
        vendor: r.vendor,
        date: r.date,
        categoryId: r.categoryId,
        accountId: r.accountId,
      }));
      const res = await importExpenses(payload);
      setResult(res);
      setStep("result");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Import request failed";
      setResult({ imported: 0, errors: [{ row: 0, message }] });
      setStep("result");
    }
    setImporting(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Import Expenses">
      {step === "upload" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload a CSV or TSV file with these columns in order:
          </p>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono">
            Date, Description, Vendor, Category, Account, Amount
          </div>
          <p className="tp-caption">
            First row should be a header (it will be skipped). Dates can be YYYY-MM-DD or M/D/YYYY.
            Amounts can be negative (e.g. -25.00) to record income-offsetting entries.
            Category and account names must match existing entries.
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
            {errorRows.length > 0 && (
              <button
                type="button"
                onClick={() => setShowErrorsOnly((v) => !v)}
                className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${
                  showErrorsOnly
                    ? "bg-destructive/15 text-destructive font-medium"
                    : "text-destructive hover:bg-destructive/10"
                }`}
              >
                <AlertCircle className="h-3 w-3" />
                {errorRows.length} error{errorRows.length !== 1 ? "s" : ""}
                {showErrorsOnly ? " — show all" : " — show only"}
              </button>
            )}
          </div>

          <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border text-left text-muted-foreground">
                  <ColumnHeader className="px-2 py-1.5">#</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Date</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Description</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Vendor</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Category</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Account</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5 text-right">Amount</ColumnHeader>
                  <ColumnHeader className="px-2 py-1.5">Status</ColumnHeader>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const i = rows.indexOf(row);
                  return (
                  <tr key={i} className={`border-b border-border ${row.errors.length > 0 ? "bg-destructive/5" : ""}`}>
                    <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
                    <td className="px-2 py-1.5">{row.date}</td>
                    <td className="px-2 py-1.5 max-w-[150px] truncate">{row.description}</td>
                    <td className="px-2 py-1.5 max-w-[120px] truncate">{row.vendor}</td>
                    <td className="px-2 py-1.5 max-w-[120px] truncate">{row.categoryName || "—"}</td>
                    <td className="px-2 py-1.5 max-w-[100px] truncate">{row.accountName}</td>
                    <td className={`px-2 py-1.5 text-right font-medium font-mono tabular-nums ${row.amount < 0 ? "text-green-600" : ""}`}>
                      {row.amount === 0 ? "—" : row.amount < 0 ? `+${formatCurrency(Math.abs(row.amount))}` : formatCurrency(row.amount)}
                    </td>
                    <td className="px-2 py-1.5">
                      {row.errors.length > 0 ? (
                        <span className="text-destructive" title={row.errors.join("; ")}>
                          <AlertCircle className="inline h-3 w-3" /> {row.errors[0]}
                        </span>
                      ) : (
                        <span className="text-green-600"><Check className="inline h-3 w-3" /></span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button type="button" variant="secondary" onClick={() => { setStep("upload"); setRows([]); }}>
              Back
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button
                type="button"
                disabled={validRows.length === 0 || importing}
                onClick={handleImport}
              >
                {importing ? "Importing..." : `Import ${validRows.length} Expense${validRows.length !== 1 ? "s" : ""}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === "result" && result && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 p-4">
            <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0" />
            <div>
              <p className="text-sm font-medium">
                {result.imported} expense{result.imported !== 1 ? "s" : ""} imported successfully
              </p>
              {result.errors.length > 0 && (
                <p className="text-xs text-destructive mt-1">
                  {result.errors.length} row{result.errors.length !== 1 ? "s" : ""} failed on server
                </p>
              )}
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="max-h-[150px] overflow-auto rounded-md border border-border p-2 text-xs text-destructive">
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
  onCreateTag: (name: string) => Promise<Tag>;
}

function ExpenseModal({ open, onClose, onSave, onDelete, onRecurringDelete, expense, offsetParent, categories, accounts, tags, vendors, onCreateTag }: ExpenseModalProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isReimbursementExpected, setIsReimbursementExpected] = useState(false);
  const [ignoreInBudget, setIgnoreInBudget] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringInterval, setRecurringInterval] = useState("");
  const [showEndDate, setShowEndDate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showOptional, setShowOptional] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>("");
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [showRecurringConfirm, setShowRecurringConfirm] = useState(false);
  const [pendingSaveData, setPendingSaveData] = useState<Record<string, unknown> | null>(null);
  const [amountIsNegative, setAmountIsNegative] = useState(false);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const categoryTriggerRef = useRef<HTMLButtonElement>(null);
  const tagsTriggerRef = useRef<HTMLButtonElement>(null);
  const submitBtnRef = useRef<HTMLButtonElement>(null);

  const isOffsetMode = !!offsetParent && !expense;

  useEffect(() => {
    if (open) {
      if (isOffsetMode) {
        // Offset mode: inherit parent's tags, category; no reimbursement/recurring
        setSelectedTagIds(offsetParent.tags.map((t) => t.tagId));
        setIsReimbursementExpected(false);
        setIsRecurring(false);
        setRecurringInterval("");
        setShowEndDate(false);
        setConfirmDelete(false);
        setSelectedCategoryId(offsetParent.categoryId ?? "");
        setSelectedAccountId("");
        setShowOptional(false);
      } else {
        setSelectedTagIds(expense?.tags.map((t) => t.tagId) ?? []);
        setIsReimbursementExpected(expense?.isReimbursementExpected ?? false);
        setIgnoreInBudget(expense?.ignoreInBudget ?? false);
        setIsRecurring(!!expense?.recurrenceRuleId);
        setRecurringInterval("");
        setShowEndDate(false);
        setConfirmDelete(false);
        setSelectedCategoryId(expense?.categoryId ?? "");
        setSelectedAccountId(expense?.accountId ?? "");
        // Auto-expand optional if any optional fields have data
        setShowOptional(!!(expense?.notes || expense?.isReimbursementExpected || expense?.recurrenceRuleId || expense?.ignoreInBudget));
        setShowRecurringConfirm(false);
        setPendingSaveData(null);
        setAmountIsNegative(!!(expense && parseFloat(expense.amount) < 0));
      }
    }
  }, [open, expense, offsetParent, isOffsetMode]);

  const handleVendorSelect = async (vendor: string) => {
    if (!expense && vendor) {
      try {
        const [catResult, acctResult] = await Promise.all([
          getVendorCategory(vendor, localToday()),
          getVendorAccount(vendor, localToday()),
        ]);
        if (catResult.categoryId) setSelectedCategoryId(catResult.categoryId);
        if (acctResult.accountId) setSelectedAccountId(acctResult.accountId);
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
      ignoreInBudget: isOffsetMode ? false : ignoreInBudget,
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
          <label className="block text-xs font-medium mb-1">Amount</label>
          <CurrencyInput name="amount" defaultValue={isOffsetMode ? String(-Math.abs(parseFloat(offsetParent.amount))) : expense?.amount} required autoFocus onChange={(v) => !isOffsetMode && setAmountIsNegative(v < 0)} />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Description</label>
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
          <label className="block text-xs font-medium mb-1">Vendor</label>
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
            <label className="block text-xs font-medium mb-1">Date</label>
            <input
              name="date"
              type="date"
              required
              defaultValue={isOffsetMode ? toDateInputValue(offsetParent.date) : toDateInputValue(expense?.date)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {/* Relay: captures focus as it exits the date field and forwards to Account, but not on Shift+Tab backwards from Account */}
            <span tabIndex={0} className="sr-only" onFocus={(e) => { if (e.relatedTarget !== accountTriggerRef.current) accountTriggerRef.current?.focus(); }} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Account</label>
            <AccountTypeahead
              name="accountId"
              required
              defaultValue={isOffsetMode ? "" : selectedAccountId}
              accounts={accounts}
              triggerRef={accountTriggerRef}
              onTabFromSearch={() => categoryTriggerRef.current?.focus()}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Category</label>
          <CategoryTypeahead
            name="categoryId"
            defaultValue={selectedCategoryId}
            categories={categories}
            required
            triggerRef={categoryTriggerRef}
            onTabFromSearch={() => tagsTriggerRef.current?.focus()}
          />
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Tags</label>
          <TagTypeahead
            tags={tags}
            selectedIds={selectedTagIds}
            onChange={setSelectedTagIds}
            onCreateTag={onCreateTag}
            triggerRef={tagsTriggerRef}
            onTabFromSearch={() => submitBtnRef.current?.focus()}
          />
        </div>

        {/* Collapsible optional section — hidden in offset mode */}
        {!isOffsetMode && (
          <div className="border-t border-border pt-3">
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowOptional(!showOptional)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {showOptional ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              More options
            </button>
            {showOptional && (
              <div className="mt-3 space-y-4">
                <div>
                  <label className="block text-xs font-medium mb-1">Notes</label>
                  <textarea
                    name="notes"
                    rows={2}
                    defaultValue={expense?.notes ?? ""}
                    className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="Additional notes..."
                  />
                </div>

                {!amountIsNegative && (
                  <div className="rounded-md border border-border p-3">
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isReimbursementExpected}
                        onChange={(e) => setIsReimbursementExpected(e.target.checked)}
                        className="h-4 w-4 rounded border-border"
                      />
                      <span className="text-[13px] font-normal">Expecting reimbursement or refund</span>
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
                )}

                <div className="rounded-md border border-border p-3">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={ignoreInBudget}
                      onChange={(e) => setIgnoreInBudget(e.target.checked)}
                      className="h-4 w-4 rounded border-border"
                    />
                    <span className="text-[13px] font-normal">Ignore in budget</span>
                  </label>
                </div>

                {!expense?.parentExpenseId && (
                <div className="rounded-md border border-border p-3">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isRecurring}
                      onChange={(e) => setIsRecurring(e.target.checked)}
                      className="h-4 w-4 rounded border-border"
                    />
                    <span className="text-[13px] font-normal">Recurring expense</span>
                  </label>
                  {isRecurring && !expense?.recurrenceRuleId && (
                    <div className="mt-3">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 text-sm">
                        <span className="text-muted-foreground">Repeats every</span>
                        <input
                          name="interval"
                          type="text"
                          inputMode="numeric"
                          value={recurringInterval}
                          onChange={(e) => setRecurringInterval(e.target.value)}
                          placeholder="1"
                          className="w-14 rounded-md border border-border px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <div className="relative">
                          <select
                            name="frequency"
                            defaultValue="MONTHLY"
                            className="appearance-none rounded-md border border-border py-2 pl-2 pr-6 text-sm text-foreground"
                          >
                            {FREQUENCY_OPTIONS.map(({ value, singular, plural }) => {
                              const n = parseInt(recurringInterval) || 1;
                              return <option key={value} value={value}>{n === 1 ? singular : plural}</option>;
                            })}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
                        </div>
                        {!showEndDate && (
                          <button type="button" onClick={() => setShowEndDate(true)} className="text-xs text-primary hover:underline">
                            + Add end date
                          </button>
                        )}
                        {showEndDate && (
                          <>
                            <span className="text-muted-foreground">until</span>
                            <span className="flex items-center gap-1">
                              <input
                                name="endDate"
                                type="date"
                                className="w-[7.75rem] rounded-md border border-border px-2 py-1 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                              />
                              <button
                                type="button"
                                onClick={() => setShowEndDate(false)}
                                className="text-sm leading-none text-muted-foreground hover:text-foreground"
                                aria-label="Remove end date"
                              >
                                ×
                              </button>
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Notes field for offset mode (standalone, no reimbursement/recurring) */}
        {isOffsetMode && (
          <div>
            <label className="block text-xs font-medium mb-1">Notes</label>
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
              <Button type="button" variant="secondary" tabIndex={-1} onClick={onClose}>Cancel</Button>
              <Button ref={submitBtnRef} type="submit" disabled={saving}>
                {saving ? "Saving..." : isOffsetMode ? "Add Offset" : expense ? "Update" : "Add Expense"}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}
