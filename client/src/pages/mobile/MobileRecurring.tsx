import { useState, useMemo, useEffect, useRef, memo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Repeat, Plus, X, ChevronDown, ChevronRight, Archive, Trash2,
  Pencil, ArrowRight,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LabelList, Cell, Legend,
} from "recharts";
import { useApi } from "@/hooks/useApi";
import {
  getRecurrenceRules, getRecurrenceRuleExpenses, getUpcomingRecurring,
  getRecurringHistory, deleteRecurrenceRule, archiveRecurrenceRule,
  updateRecurrenceRule, getAccounts, getFlatCategories,
  getTransferRules, createTransfer, updateTransferRule, archiveTransferRule,
  type LinkedExpense,
} from "@/api";
import { formatCurrency, formatDate, toDateInputValue, cn } from "@/lib/utils";
import type {
  RecurrenceRule, Account, Category, TransferRule,
  UpcomingExpenseItem, RecurringHistoryMonth,
} from "@/types";

// ── Frequency helpers ─────────────────────────────────────────────────────────

const frequencyUnit: Record<string, { singular: string; plural: string }> = {
  DAILY:   { singular: "day",   plural: "days"   },
  WEEKLY:  { singular: "week",  plural: "weeks"  },
  MONTHLY: { singular: "month", plural: "months" },
  YEARLY:  { singular: "year",  plural: "years"  },
};

function formatFrequency(frequency: string, interval: number): string {
  const unit = frequencyUnit[frequency];
  if (!unit) return frequency.toLowerCase();
  return interval === 1 ? `every ${unit.singular}` : `every ${interval} ${unit.plural}`;
}

function displayAmount(amount: string): string {
  const n = parseFloat(amount);
  return n < 0 ? `+${formatCurrency(Math.abs(n))}` : formatCurrency(n);
}

// ── Upcoming strip ────────────────────────────────────────────────────────────

const VENDOR_COLORS = [
  "bg-blue-500", "bg-violet-500", "bg-orange-500", "bg-teal-500",
  "bg-pink-500", "bg-indigo-500", "bg-amber-500", "bg-cyan-500",
];

function vendorColor(vendor: string): string {
  const hash = vendor.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return VENDOR_COLORS[hash % VENDOR_COLORS.length];
}

function toLocalDateKey(dateStr: string): string {
  const s = dateStr.replace(/-/g, "/").replace("T", " ").split(".")[0];
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function UpcomingStrip({ expenses }: { expenses: UpcomingExpenseItem[] }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    return d;
  });

  const byDate = new Map<string, UpcomingExpenseItem[]>();
  for (const e of expenses) {
    const key = toLocalDateKey(e.date);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(e);
  }

  return (
    <div>
      <div className="flex">
        {days.map((day, i) => {
          const key = localDateKey(day);
          const dayExpenses = byDate.get(key) ?? [];
          const debits  = dayExpenses.filter((e) => parseFloat(e.amount) > 0);
          const credits = dayExpenses.filter((e) => parseFloat(e.amount) < 0);
          const debitTotal  = debits.reduce((s, e) => s + parseFloat(e.amount), 0);
          const creditTotal = credits.reduce((s, e) => s + Math.abs(parseFloat(e.amount)), 0);
          const isToday = i === 0;
          const hasItems = dayExpenses.length > 0;

          return (
            <div
              key={key}
              className="flex min-w-[64px] flex-1 flex-col border-r border-border last:border-r-0"
            >
              <div className={`px-1 py-2 text-center ${isToday ? "text-red-500" : "text-muted-foreground"}`}>
                <div className="text-[10px] font-medium uppercase tracking-wide">
                  {isToday ? "Today" : DAY_NAMES[day.getDay()]}
                </div>
                <div className={`text-base font-semibold leading-tight ${isToday ? "text-red-500" : "text-foreground"}`}>
                  {day.getDate()}
                </div>
              </div>
              <div className="flex flex-1 flex-col items-center justify-start gap-1 px-0.5 pb-2">
                {hasItems && (
                  <>
                    {/* Stacked initials */}
                    <div className="flex justify-center">
                      <div className="flex -space-x-1.5">
                        {dayExpenses.slice(0, 2).map((e, idx) => {
                          const label = e.vendor || e.description;
                          return (
                            <div
                              key={idx}
                              className={`h-5 w-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white ring-1 ring-background ${vendorColor(label)}`}
                            >
                              {label.charAt(0).toUpperCase()}
                            </div>
                          );
                        })}
                        {dayExpenses.length > 2 && (
                          <div className="h-5 w-5 rounded-full flex items-center justify-center text-[8px] font-semibold bg-muted text-muted-foreground ring-1 ring-background">
                            +{dayExpenses.length - 2}
                          </div>
                        )}
                      </div>
                    </div>
                    {debits.length > 0 && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-foreground whitespace-nowrap">
                        {formatCurrency(debitTotal)}
                      </span>
                    )}
                    {credits.length > 0 && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-green-600 whitespace-nowrap">
                        +{formatCurrency(creditTotal)}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Annualized cost helpers ───────────────────────────────────────────────────

function annualizedAmount(rule: { amount: string; frequency: string; interval: number }): number {
  const abs = Math.abs(parseFloat(rule.amount));
  switch (rule.frequency) {
    case "DAILY":   return abs * (365 / rule.interval);
    case "WEEKLY":  return abs * (52  / rule.interval);
    case "MONTHLY": return abs * (12  / rule.interval);
    case "YEARLY":  return abs * (1   / rule.interval);
    default:        return 0;
  }
}

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function countOccurrences(
  ruleStart: Date, windowStart: Date, windowEnd: Date,
  frequency: string, interval: number,
): number {
  let current = new Date(ruleStart);
  let count = 0;
  switch (frequency) {
    case "DAILY": {
      if (current < windowStart) {
        const steps = Math.ceil((windowStart.getTime() - current.getTime()) / (86400000 * interval));
        current = new Date(ruleStart.getTime() + steps * interval * 86400000);
      }
      while (current <= windowEnd) { count++; current = new Date(current.getTime() + interval * 86400000); }
      break;
    }
    case "WEEKLY": {
      if (current < windowStart) {
        const steps = Math.ceil((windowStart.getTime() - current.getTime()) / (86400000 * 7 * interval));
        current = new Date(ruleStart.getTime() + steps * 7 * interval * 86400000);
      }
      while (current <= windowEnd) { count++; current = new Date(current.getTime() + 7 * interval * 86400000); }
      break;
    }
    case "MONTHLY": {
      while (current < windowStart) current = new Date(current.getFullYear(), current.getMonth() + interval, current.getDate());
      while (current <= windowEnd) { count++; current = new Date(current.getFullYear(), current.getMonth() + interval, current.getDate()); }
      break;
    }
    case "YEARLY": {
      while (current < windowStart) current = new Date(current.getFullYear() + interval, current.getMonth(), current.getDate());
      while (current <= windowEnd) { count++; current = new Date(current.getFullYear() + interval, current.getMonth(), current.getDate()); }
      break;
    }
  }
  return count;
}

function effectiveYearCost(rule: {
  amount: string; frequency: string; interval: number;
  startDate: string; endDate?: string | null;
}): { cost: number; proratedNote: string | null } {
  const abs = Math.abs(parseFloat(rule.amount));
  const year = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1);
  const yearEnd   = new Date(year, 11, 31);
  const ruleStart = parseLocalDate(rule.startDate);
  const ruleEnd   = rule.endDate ? parseLocalDate(rule.endDate) : null;
  const windowStart = ruleStart > yearStart ? ruleStart : yearStart;
  const windowEnd   = ruleEnd && ruleEnd < yearEnd ? ruleEnd : yearEnd;
  const count = countOccurrences(ruleStart, windowStart, windowEnd, rule.frequency, rule.interval);
  const effectiveCost = abs * count;
  const annualized    = annualizedAmount(rule);
  if (effectiveCost >= annualized) return { cost: annualized, proratedNote: null };
  const fmtD = (d: Date) => `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
  const note = `${count} payment${count !== 1 ? "s" : ""} from ${fmtD(windowStart)} to ${fmtD(windowEnd)}`;
  return { cost: effectiveCost, proratedNote: note };
}

// ── Annual cost chart ─────────────────────────────────────────────────────────

const CHART_EXPENSE_COLOR = "#6366f1";
const CHART_CREDIT_COLOR  = "#16a34a";
const CHART_PRIOR_PERIOD_COLOR = "rgba(99, 102, 241, 0.3)";
const CHART_LABEL_STYLE = { fontSize: 10, fill: "currentColor" } as const;

interface AnnualCostItem { description: string; annualized: number; isCredit: boolean; proratedNote: string | null; }
interface AnnualCostEntry { name: string; fullName: string; value: number; isCredit: boolean; items: AnnualCostItem[]; }

function AnnualCostTooltip({ active, payload }: { active?: boolean; payload?: { payload: AnnualCostEntry }[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-background p-2.5 shadow-md" style={{ fontSize: 11, minWidth: 160 }}>
      <p className="font-semibold text-foreground">{d.fullName}</p>
      <p className="mt-0.5 mb-2 text-muted-foreground">{formatCurrency(d.value)} / yr</p>
      <div className="space-y-1 border-t border-border pt-2">
        {d.items.map((item, i) => (
          <div key={i} className="flex items-start justify-between gap-2">
            <span className="truncate text-muted-foreground" style={{ maxWidth: 110 }}>{item.description}</span>
            <span className={`shrink-0 font-medium ${item.isCredit ? "text-green-600" : ""}`}>
              {formatCurrency(item.annualized)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const EMPTY_CATEGORIES: Category[] = [];

const AnnualCostPanel = memo(function AnnualCostPanel({
  rules,
  categories,
}: {
  rules: Pick<RecurrenceRule, "description" | "amount" | "frequency" | "interval" | "categoryId" | "startDate" | "endDate">[];
  categories: Category[];
}) {
  const catNameMap = new Map<string, string>(categories.map((c) => [c.id, c.name]));
  const ignoredCatIds = new Set(categories.filter((c) => c.ignoreInBudget).map((c) => c.id));
  const includedRules = rules.filter((r) => !ignoredCatIds.has(r.categoryId));

  const groupMap = new Map<string, { fullName: string; items: AnnualCostItem[] }>();
  for (const rule of includedRules) {
    const key      = rule.categoryId || "__none__";
    const fullName = catNameMap.get(rule.categoryId) ?? "Uncategorized";
    if (!groupMap.has(key)) groupMap.set(key, { fullName, items: [] });
    const { cost, proratedNote } = effectiveYearCost(rule);
    groupMap.get(key)!.items.push({ description: rule.description, annualized: cost, isCredit: parseFloat(rule.amount) < 0, proratedNote });
  }

  const data: AnnualCostEntry[] = Array.from(groupMap.values())
    .map(({ fullName, items }) => {
      const sorted   = [...items].sort((a, b) => b.annualized - a.annualized);
      const total    = sorted.reduce((s, i) => s + i.annualized, 0);
      const isCredit = sorted.every((i) => i.isCredit);
      return { name: fullName.length > 14 ? fullName.slice(0, 13) + "…" : fullName, fullName, value: total, isCredit, items: sorted };
    })
    .sort((a, b) => b.value - a.value);

  const totalCost = data.filter((d) => !d.isCredit).reduce((s, d) => s + d.value, 0);
  const chartHeight = Math.max(100, data.length * 32 + 16);

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Annual cost</p>
          <p className="mt-0.5 text-xl font-bold">{formatCurrency(totalCost)}</p>
        </div>
        <p className="text-xs text-muted-foreground">{includedRules.length} active</p>
      </div>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart layout="vertical" data={data} margin={{ top: 0, right: 72, left: 0, bottom: 0 }}>
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis type="category" dataKey="name" width={90} tick={CHART_LABEL_STYLE} tickLine={false} axisLine={false} />
          <Tooltip content={<AnnualCostTooltip />} cursor={{ fill: "transparent" }} />
          <Bar dataKey="value" radius={3} maxBarSize={16}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.isCredit ? CHART_CREDIT_COLOR : CHART_EXPENSE_COLOR} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: any) => formatCurrency(Number(v ?? 0))}
              style={CHART_LABEL_STYLE}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
});

// ── Year-over-year chart ──────────────────────────────────────────────────────

const currYear = new Date().getFullYear();
const prevYear = currYear - 1;

function YoYPanel({ history }: { history: RecurringHistoryMonth[] }) {
  const hasLastYear = history.some((m) => m.lastYear > 0);
  return (
    <div>
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Year over year</p>
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={history} margin={{ top: 4, right: 4, left: -18, bottom: 0 }} barCategoryGap="30%">
          <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 9 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`} />
          <Tooltip formatter={(v: number | undefined, key: string | undefined) => [formatCurrency(v ?? 0), (key ?? "") === "thisYear" ? String(currYear) : String(prevYear)]} contentStyle={{ fontSize: 11 }} />
          {hasLastYear && <Bar dataKey="lastYear" fill={CHART_PRIOR_PERIOD_COLOR} radius={[2,2,0,0]} name={String(prevYear)} />}
          <Bar dataKey="thisYear" fill={CHART_EXPENSE_COLOR} radius={[2,2,0,0]} name={String(currYear)} />
          {hasLastYear && <Legend iconType="square" iconSize={8} formatter={(v) => v} wrapperStyle={{ fontSize: 11, paddingTop: 4, textAlign: "center", width: "100%", left: 0 }} />}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Body scroll lock helper ───────────────────────────────────────────────────

function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
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
  }, [active]);
}

// ── Rule detail bottom sheet ──────────────────────────────────────────────────

function RuleDetailSheet({
  rule,
  accountMap,
  categoryMap,
  onClose,
  onEdit,
  onArchive,
}: {
  rule: RecurrenceRule | null;
  accountMap: Map<string, string>;
  categoryMap: Map<string, string>;
  onClose: () => void;
  onEdit: (rule: RecurrenceRule) => void;
  onArchive: (rule: RecurrenceRule) => void;
}) {
  const open = rule !== null;
  useBodyScrollLock(open);

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col bg-background rounded-t-2xl shadow-xl transition-transform duration-250 ease-out",
          open ? "translate-y-0" : "translate-y-[calc(100%+20px)]"
        )}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>

        {rule && (
          <>
            {/* Header */}
            <div className="flex items-start justify-between px-4 pb-3 shrink-0">
              <div className="min-w-0 pr-3">
                <h2 className="text-base font-semibold leading-tight">{rule.description}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{formatFrequency(rule.frequency, rule.interval)}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`text-lg font-bold ${parseFloat(rule.amount) < 0 ? "text-green-600" : ""}`}>
                  {displayAmount(rule.amount)}
                </span>
                <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Detail rows */}
            <div className="px-4 pb-3 space-y-2 border-t border-border pt-3">
              {[
                ["Account", accountMap.get(rule.accountId) ?? "—"],
                ["Category", rule.categoryId ? (categoryMap.get(rule.categoryId) ?? "—") : "—"],
                rule.group ? ["Group", rule.group] : null,
                ["Started", formatDate(rule.startDate)],
                ["Next", formatDate(rule.nextExpenseDate ?? rule.nextOccurrence)],
                rule.endDate ? ["Ends", formatDate(rule.endDate)] : null,
              ].filter(Boolean).map(([label, value]) => (
                <div key={label} className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{label}</span>
                  <span className="text-sm font-medium">{value}</span>
                </div>
              ))}
            </div>

            {/* Actions */}
            <div className="shrink-0 border-t border-border p-4">
              <div className="flex gap-3">
                <button
                  onClick={() => { onClose(); setTimeout(() => onArchive(rule), 200); }}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
                >
                  <Archive className="h-4 w-4" />
                  Archive
                </button>
                <button
                  onClick={() => { onClose(); setTimeout(() => onEdit(rule), 200); }}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── Edit rule full-screen modal ───────────────────────────────────────────────

interface EditForm {
  description: string;
  amount: string;
  accountId: string;
  categoryId: string;
  group: string;
  endDate: string;
}

function EditRuleModal({
  rule,
  accounts,
  categoryOptions,
  onClose,
  onSaved,
  onDeleteClick,
}: {
  rule: RecurrenceRule | null;
  accounts: Account[];
  categoryOptions: { id: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
  onDeleteClick: (rule: RecurrenceRule) => void;
}) {
  const open = rule !== null;
  const [form, setForm] = useState<EditForm>({ description: "", amount: "", accountId: "", categoryId: "", group: "", endDate: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useBodyScrollLock(open);

  useEffect(() => {
    if (rule) {
      const n = parseFloat(rule.amount);
      setForm({
        description: rule.description,
        amount: n.toFixed(2),
        accountId: rule.accountId,
        categoryId: rule.categoryId ?? "",
        group: rule.group ?? "",
        endDate: rule.endDate ? rule.endDate.slice(0, 10) : "",
      });
      setError(null);
    }
  }, [rule]);

  const set = (patch: Partial<EditForm>) => setForm((f) => ({ ...f, ...patch }));
  const todayStr = new Date().toLocaleDateString("en-CA");
  const endDateIsRetroactive = !!form.endDate && form.endDate < todayStr;

  const handleSave = async () => {
    if (!rule) return;
    const amountVal = parseFloat(form.amount);
    if (isNaN(amountVal) || amountVal === 0) { setError("Amount must be a non-zero number."); return; }
    setSaving(true);
    setError(null);
    try {
      await updateRecurrenceRule(rule.id, {
        description: form.description.trim() || rule.description,
        amount: amountVal,
        accountId: form.accountId,
        categoryId: form.categoryId || null,
        group: form.group.trim() || null,
        endDate: form.endDate || null,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none";

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-base font-semibold">Edit Recurring</h2>
        <button onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Scrollable form */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-4 p-4">
          {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

          <div>
            <label className="mb-1.5 block text-sm font-medium">Description</label>
            <input type="text" value={form.description} onChange={(e) => set({ description: e.target.value })} className={inputCls} />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Amount</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input type="text" inputMode="decimal" value={form.amount} onChange={(e) => set({ amount: e.target.value })} className={`${inputCls} pl-7`} />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Account</label>
            <div className="relative">
              <select value={form.accountId} onChange={(e) => set({ accountId: e.target.value })} className="w-full appearance-none rounded-md border border-border py-2.5 pl-2 pr-6 text-sm text-foreground">
                {(() => {
                  const current = accounts.find((a) => a.id === form.accountId);
                  return current?.isHidden ? <option key={current.id} value={current.id} disabled>{current.name}</option> : null;
                })()}
                {accounts.filter((a) => !a.isHidden).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Category</label>
            <div className="relative">
              <select value={form.categoryId} onChange={(e) => set({ categoryId: e.target.value })} className="w-full appearance-none rounded-md border border-border py-2.5 pl-2 pr-6 text-sm text-foreground">
                {categoryOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Group <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input type="text" value={form.group} onChange={(e) => set({ group: e.target.value })} placeholder="e.g. Subscriptions, Loans" className={inputCls} />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              End date <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input type="date" value={form.endDate} onChange={(e) => set({ endDate: e.target.value })} className={inputCls} />
            {endDateIsRetroactive && (
              <p className="mt-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                This end date is in the past. Any recorded expenses in this series after{" "}
                <span className="font-medium">{form.endDate}</span> will be permanently deleted.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-border p-4">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => { if (rule) { onClose(); setTimeout(() => onDeleteClick(rule), 200); } }}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md px-3 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={saving} className="rounded-md border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving} className="rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity hover:opacity-90">
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Confirm bottom sheet ──────────────────────────────────────────────────────

function ConfirmSheet({
  open,
  title,
  description,
  confirmLabel,
  confirmIcon,
  destructive,
  loading,
  onCancel,
  onConfirm,
  extra,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  confirmIcon?: React.ReactNode;
  destructive?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  extra?: React.ReactNode;
}) {
  useBodyScrollLock(open);
  return (
    <>
      <div className={cn("fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200", open ? "opacity-100" : "pointer-events-none opacity-0")} onClick={onCancel} />
      <div className={cn("fixed bottom-0 left-0 right-0 z-[60] flex flex-col bg-background rounded-t-2xl shadow-xl transition-transform duration-250 ease-out", open ? "translate-y-0" : "translate-y-[calc(100%+20px)]")}>
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>
        <div className="px-4 pt-2 pb-4 space-y-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <div className="text-sm text-muted-foreground">{description}</div>
          {extra}
          <div className="flex gap-3 pt-1">
            <button onClick={onCancel} disabled={loading} className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md py-2.5 text-sm font-medium transition-colors disabled:opacity-50",
                destructive ? "bg-destructive/10 text-destructive hover:bg-destructive/20" : "bg-primary text-primary-foreground hover:opacity-90"
              )}
            >
              {confirmIcon}
              {loading ? "Working…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Delete confirmation sheet ─────────────────────────────────────────────────

function DeleteRuleSheet({
  rule,
  linkedExpenses,
  loading,
  onCancel,
  onArchive,
  onDelete,
}: {
  rule: RecurrenceRule | null;
  linkedExpenses: LinkedExpense[] | "loading" | null;
  loading: boolean;
  onCancel: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const open = rule !== null;
  useBodyScrollLock(open);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const pastExpenses   = Array.isArray(linkedExpenses) ? linkedExpenses.filter((e) => new Date(e.date) <= today) : [];
  const futureExpenses = Array.isArray(linkedExpenses) ? linkedExpenses.filter((e) => new Date(e.date) > today)  : [];
  const totalLinked    = Array.isArray(linkedExpenses) ? linkedExpenses.length : 0;

  return (
    <>
      <div className={cn("fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200", open ? "opacity-100" : "pointer-events-none opacity-0")} onClick={onCancel} />
      <div className={cn("fixed bottom-0 left-0 right-0 z-[60] flex flex-col bg-background rounded-t-2xl shadow-xl transition-transform duration-250 ease-out max-h-[85vh] overflow-hidden", open ? "translate-y-0" : "translate-y-[calc(100%+20px)]")}>
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-4 space-y-3">
          <h2 className="text-base font-semibold">Delete recurring transaction?</h2>
          <p className="text-sm text-muted-foreground">
            This <em>permanently</em> removes the recurring transaction for{" "}
            <span className="font-medium text-foreground">"{rule?.description}"</span>.
            To gracefully end it instead, use <em>Archive</em>.
          </p>

          {/* Linked expenses summary */}
          {linkedExpenses === "loading" ? (
            <p className="text-xs text-muted-foreground italic">Loading linked transactions…</p>
          ) : totalLinked === 0 ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs">
              No linked transactions — deleting will not affect any expenses.
            </p>
          ) : (
            <div className="space-y-3">
              {pastExpenses.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-foreground">
                    Past transactions ({pastExpenses.length}) —{" "}
                    <span className="font-normal">will be kept as standalone expenses</span>
                  </p>
                  <div className="max-h-28 overflow-y-auto rounded-md border border-border divide-y divide-border text-xs">
                    {pastExpenses.map((e) => (
                      <div key={e.id} className="flex items-center gap-2 px-3 py-1.5">
                        <span className="shrink-0 text-muted-foreground">{formatDate(e.date)}</span>
                        <span className="flex-1 truncate">{e.description}</span>
                        <span className={`shrink-0 font-medium${parseFloat(e.amount) < 0 ? " text-green-600" : ""}`}>{displayAmount(e.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {futureExpenses.length > 0 && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-foreground">
                    Upcoming instances ({futureExpenses.length}) —{" "}
                    <span className="font-normal text-destructive">will be permanently deleted</span>
                  </p>
                  <div className="max-h-28 overflow-y-auto rounded-md border border-border divide-y divide-border text-xs">
                    {futureExpenses.map((e) => (
                      <div key={e.id} className="flex items-center gap-2 px-3 py-1.5">
                        <span className="shrink-0 text-muted-foreground">{formatDate(e.date)}</span>
                        <span className="flex-1 truncate">{e.description}</span>
                        <span className={`shrink-0 font-medium${parseFloat(e.amount) < 0 ? " text-green-600" : ""}`}>{displayAmount(e.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button onClick={onCancel} disabled={loading} className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button onClick={onArchive} disabled={loading} className="flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2.5 text-sm font-medium hover:bg-accent transition-colors disabled:opacity-50">
              <Archive className="h-3.5 w-3.5" />
              Archive
            </button>
            <button
              onClick={onDelete}
              disabled={loading || linkedExpenses === "loading"}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-destructive/10 py-2.5 text-sm font-medium text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {loading ? "Deleting…" : "Confirm Delete"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Transfer rule form (full-screen modal) ────────────────────────────────────

interface TransferRuleFormData {
  description?: string;
  amount?: string;
  fromAccountId?: string;
  toAccountId?: string;
  frequency?: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval?: number;
  startDate?: string;
  endDate?: string | null;
}

function TransferRuleModal({
  open,
  rule,
  accounts,
  onClose,
  onSave,
}: {
  open: boolean;
  rule: TransferRule | null;
  accounts: Account[];
  onClose: () => void;
  onSave: (data: TransferRuleFormData) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<TransferRuleFormData>({});
  const bankAccounts = accounts.filter((a) => a.type === "CHECKING" || a.type === "SAVINGS");
  useBodyScrollLock(open);

  useEffect(() => {
    if (open) {
      setForm(rule
        ? {
            description: rule.description, amount: rule.amount,
            fromAccountId: rule.fromAccountId, toAccountId: rule.toAccountId,
            frequency: rule.frequency, interval: rule.interval,
            startDate: toDateInputValue(rule.startDate),
            endDate: rule.endDate ? toDateInputValue(rule.endDate) : "",
          }
        : { frequency: "MONTHLY", interval: 1, startDate: toDateInputValue(new Date().toISOString()) }
      );
    }
  }, [open, rule]);

  const set = (patch: Partial<TransferRuleFormData>) => setForm((f) => ({ ...f, ...patch }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    await onSave({ ...form, endDate: form.endDate || null });
    setSaving(false);
  };

  const inputCls = "w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none";

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-base font-semibold">{rule ? "Edit Recurring Transfer" : "New Recurring Transfer"}</h2>
        <button onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <form id="transfer-rule-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-4 p-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Description</label>
            <input type="text" required value={form.description ?? ""} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. Monthly joint contribution" className={inputCls} />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Amount</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input type="text" inputMode="decimal" required value={form.amount ?? ""} onChange={(e) => set({ amount: e.target.value })} className={`${inputCls} pl-7`} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium">From</label>
              <div className="relative">
                <select required value={form.fromAccountId ?? ""} onChange={(e) => set({ fromAccountId: e.target.value })} className="w-full appearance-none rounded-md border border-border py-2.5 pl-2 pr-6 text-sm text-foreground">
                  <option value="">Select…</option>
                  {bankAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">To</label>
              <div className="relative">
                <select required value={form.toAccountId ?? ""} onChange={(e) => set({ toAccountId: e.target.value })} className="w-full appearance-none rounded-md border border-border py-2.5 pl-2 pr-6 text-sm text-foreground">
                  <option value="">Select…</option>
                  {bankAccounts.filter((a) => a.id !== form.fromAccountId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium">Frequency</label>
              <div className="relative">
                <select value={form.frequency ?? "MONTHLY"} onChange={(e) => set({ frequency: e.target.value as TransferRuleFormData["frequency"] })} className="w-full appearance-none rounded-md border border-border py-2.5 pl-2 pr-6 text-sm text-foreground">
                  <option value="DAILY">Daily</option>
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="YEARLY">Yearly</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Every</label>
              <input type="number" min={1} value={form.interval ?? 1} onChange={(e) => set({ interval: parseInt(e.target.value) || 1 })} className={inputCls} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium">Start Date</label>
              <input type="date" required={!rule} value={form.startDate ?? ""} onChange={(e) => set({ startDate: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                End Date <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <input type="date" value={form.endDate ?? ""} onChange={(e) => set({ endDate: e.target.value })} className={inputCls} />
            </div>
          </div>
        </div>
      </form>

      <div className="shrink-0 border-t border-border p-4">
        <div className="flex gap-3">
          <button type="button" onClick={onClose} disabled={saving} className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" form="transfer-rule-form" disabled={saving} className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity hover:opacity-90">
            {saving ? "Saving…" : rule ? "Save Changes" : "Create Transfer"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Transfer detail sheet ─────────────────────────────────────────────────────

function TransferDetailSheet({
  rule,
  onClose,
  onEdit,
  onArchive,
}: {
  rule: TransferRule | null;
  onClose: () => void;
  onEdit: (rule: TransferRule) => void;
  onArchive: (rule: TransferRule) => void;
}) {
  const open = rule !== null;
  useBodyScrollLock(open);

  return (
    <>
      <div className={cn("fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200", open ? "opacity-100" : "pointer-events-none opacity-0")} onClick={onClose} />
      <div className={cn("fixed bottom-0 left-0 right-0 z-[60] flex flex-col bg-background rounded-t-2xl shadow-xl transition-transform duration-250 ease-out", open ? "translate-y-0" : "translate-y-[calc(100%+20px)]")}>
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="h-1 w-10 rounded-full bg-border" />
        </div>
        {rule && (
          <>
            <div className="flex items-start justify-between px-4 pb-3 shrink-0">
              <div className="min-w-0 pr-3">
                <h2 className="text-base font-semibold leading-tight">{rule.description}</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{formatFrequency(rule.frequency, rule.interval)}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-lg font-bold">{formatCurrency(parseFloat(rule.amount))}</span>
                <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-accent" aria-label="Close">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="px-4 pb-3 space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">From</span>
                <span className="text-sm font-medium">{rule.fromAccount.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">To</span>
                <span className="text-sm font-medium">{rule.toAccount.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Started</span>
                <span className="text-sm font-medium">{formatDate(rule.startDate)}</span>
              </div>
              {rule.endDate && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Ends</span>
                  <span className="text-sm font-medium">{formatDate(rule.endDate)}</span>
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-border p-4">
              <div className="flex gap-3">
                <button onClick={() => { onClose(); setTimeout(() => onArchive(rule), 200); }} className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors">
                  <Archive className="h-4 w-4" />
                  Archive
                </button>
                <button onClick={() => { onClose(); setTimeout(() => onEdit(rule), 200); }} className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity">
                  <Pencil className="h-4 w-4" />
                  Edit
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function MobileRecurring() {
  const [activeTab, setActiveTab] = useState<"expenses" | "transfers">("expenses");
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get("highlight");

  const { data: rules, refetch } = useApi(() => getRecurrenceRules(), []);
  const { data: accounts } = useApi<Account[]>(() => getAccounts({ includeHidden: true }), []);
  const { data: categories } = useApi<Category[]>(() => getFlatCategories(), []);
  const { data: upcomingExpenses } = useApi(() => getUpcomingRecurring(14), []);
  const { data: recurringHistory } = useApi(() => getRecurringHistory(6), []);
  const { data: transferRules, refetch: refetchTransfers } = useApi<TransferRule[]>(() => getTransferRules(), []);

  // Past rules
  const [showPast, setShowPast] = useState(false);
  const { data: pastRules, refetch: refetchPast } = useApi(
    () => (showPast ? getRecurrenceRules({ includeInactive: true }) : Promise.resolve(null)),
    [showPast],
  );

  // Rule bottom sheet
  const [detailRule, setDetailRule] = useState<RecurrenceRule | null>(null);

  // Edit modal
  const [editRule, setEditRule] = useState<RecurrenceRule | null>(null);

  // Archive confirm
  const [archiveTarget, setArchiveTarget] = useState<RecurrenceRule | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<RecurrenceRule | null>(null);
  const [linkedExpenses, setLinkedExpenses] = useState<LinkedExpense[] | "loading" | null>(null);

  // Transfer sheet/modal state
  const [transferDetailRule, setTransferDetailRule] = useState<TransferRule | null>(null);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [editingTransferRule, setEditingTransferRule] = useState<TransferRule | null>(null);
  const [archiveTransferTarget, setArchiveTransferTarget] = useState<TransferRule | null>(null);
  const [transferActionLoading, setTransferActionLoading] = useState(false);

  // Scroll to highlighted rule
  const highlightRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [rules]);

  useEffect(() => {
    if (!deleteTarget) { setLinkedExpenses(null); return; }
    setLinkedExpenses("loading");
    getRecurrenceRuleExpenses(deleteTarget.id)
      .then(setLinkedExpenses)
      .catch(() => setLinkedExpenses([]));
  }, [deleteTarget]);

  const refetchAll = () => { refetch(); if (showPast) refetchPast(); };

  const accountMap = useMemo(
    () => new Map((accounts ?? []).map((a) => [a.id, a.name])),
    [accounts],
  );

  const categoryMap = useMemo(
    () => new Map((categories ?? []).map((c) => [c.id, c.name])),
    [categories],
  );

  const categoryOptions = useMemo(() => {
    const cats = categories ?? [];
    const parentNames = new Map(cats.filter((c) => !c.parentId).map((c) => [c.id, c.name]));
    return [
      { id: "", label: "No category" },
      ...cats.map((c) => ({
        id: c.id,
        label: c.parentId ? `${parentNames.get(c.parentId) ?? "?"} > ${c.name}` : c.name,
      })).sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [categories]);

  const ruleGroups = useMemo(() => {
    if (!rules) return [];
    const map = new Map<string | null, RecurrenceRule[]>();
    for (const rule of rules) {
      const key = rule.group ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(rule);
    }
    const named = [...map.entries()].filter(([k]) => k !== null).sort(([a], [b]) => (a as string).localeCompare(b as string));
    const ungrouped = map.has(null) ? [[null, map.get(null)!] as [null, RecurrenceRule[]]] : [];
    return [...named, ...ungrouped];
  }, [rules]);

  const handleArchiveConfirm = async () => {
    if (!archiveTarget) return;
    setActionLoading(true);
    await archiveRecurrenceRule(archiveTarget.id);
    setArchiveTarget(null);
    setActionLoading(false);
    refetchAll();
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setActionLoading(true);
    await deleteRecurrenceRule(deleteTarget.id);
    setDeleteTarget(null);
    setActionLoading(false);
    refetchAll();
  };

  return (
    <>
      <div className="space-y-0">
        <h1 className="px-0 pb-4 text-2xl font-bold">Recurring</h1>

        {/* Tab bar */}
        <div className="flex border-b border-border -mx-4 px-4">
          {(["expenses", "transfers"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* ── Expenses tab ── */}
        {activeTab === "expenses" && (
          <div className="space-y-5 pt-5">

            {/* Upcoming strip */}
            {upcomingExpenses && upcomingExpenses.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Next 2 weeks</p>
                <div className="-mx-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <UpcomingStrip expenses={upcomingExpenses} />
                </div>
              </div>
            )}

            {/* Active rules */}
            {rules && rules.length > 0 ? (
              <div className="space-y-5">
                {ruleGroups.map(([groupName, groupRules]) => (
                  <div key={groupName ?? "__ungrouped__"}>
                    {groupName && (
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{groupName}</p>
                    )}
                    <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
                      {groupRules.map((rule) => (
                        <div
                          key={rule.id}
                          ref={rule.id === highlightId ? highlightRef : undefined}
                          onClick={() => setDetailRule(rule)}
                          className={cn(
                            "flex cursor-pointer items-center gap-3 px-4 py-3 active:bg-accent transition-colors",
                            rule.id === highlightId && "bg-amber-50"
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-sm">{rule.description}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {formatFrequency(rule.frequency, rule.interval)}
                              {" · "}{accountMap.get(rule.accountId) ?? "—"}
                              {" · next "}{formatDate(rule.nextExpenseDate ?? rule.nextOccurrence)}
                            </p>
                          </div>
                          <span className={`shrink-0 font-semibold text-sm ${parseFloat(rule.amount) < 0 ? "text-green-600" : ""}`}>
                            {displayAmount(rule.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Repeat className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm font-medium">No recurring expenses</p>
                <p className="text-xs text-muted-foreground max-w-[260px]">
                  Create a recurring expense by toggling "Recurring expense" when adding a new expense.
                </p>
              </div>
            )}

            {/* Ended recurring */}
            <div>
              <button
                onClick={() => setShowPast((v) => !v)}
                className="flex items-center gap-1.5 text-sm text-muted-foreground"
              >
                {showPast ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Ended recurring transactions
              </button>

              {showPast && (
                <div className="mt-3">
                  {pastRules === null ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                  ) : pastRules.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No ended recurring transactions.</p>
                  ) : (
                    <div className="divide-y divide-border rounded-xl border border-border overflow-hidden opacity-60">
                      {pastRules.map((rule) => (
                        <div key={rule.id} className="flex items-center gap-3 px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-sm">{rule.description}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {formatFrequency(rule.frequency, rule.interval)}
                              {rule.endDate ? ` · ended ${formatDate(rule.endDate)}` : ""}
                            </p>
                          </div>
                          <span className={`shrink-0 font-semibold text-sm ${parseFloat(rule.amount) < 0 ? "text-green-600" : ""}`}>
                            {displayAmount(rule.amount)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Analytics */}
            {rules && rules.length > 0 && (
              <div className="space-y-6 border-t border-border pt-4">
                <AnnualCostPanel rules={rules} categories={categories ?? EMPTY_CATEGORIES} />
                {recurringHistory && recurringHistory.length > 0 && (
                  <YoYPanel history={recurringHistory} />
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Transfers tab ── */}
        {activeTab === "transfers" && (
          <div className="space-y-4 pt-5">
            {transferRules && transferRules.length > 0 ? (
              <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
                {transferRules.map((rule) => (
                  <div
                    key={rule.id}
                    onClick={() => setTransferDetailRule(rule)}
                    className="flex cursor-pointer items-center gap-3 px-4 py-3 active:bg-accent transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-sm">{rule.description}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <span className="truncate max-w-[90px]">{rule.fromAccount.name}</span>
                        <ArrowRight className="h-3 w-3 shrink-0" />
                        <span className="truncate max-w-[90px]">{rule.toAccount.name}</span>
                        <span>· {formatFrequency(rule.frequency, rule.interval)}</span>
                      </p>
                    </div>
                    <span className="shrink-0 font-semibold text-sm">
                      {formatCurrency(parseFloat(rule.amount))}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Repeat className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm font-medium">No recurring transfers</p>
                <p className="text-xs text-muted-foreground max-w-[260px]">
                  Set up automatic transfers between your accounts on a schedule.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transfers FAB */}
      {activeTab === "transfers" && (
        <button
          onClick={() => { setEditingTransferRule(null); setTransferModalOpen(true); }}
          className="fixed bottom-20 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90 transition-opacity"
          aria-label="New recurring transfer"
        >
          <Plus className="h-6 w-6" />
        </button>
      )}

      {/* Rule detail sheet */}
      <RuleDetailSheet
        rule={detailRule}
        accountMap={accountMap}
        categoryMap={categoryMap}
        onClose={() => setDetailRule(null)}
        onEdit={(rule) => setEditRule(rule)}
        onArchive={(rule) => setArchiveTarget(rule)}
      />

      {/* Edit rule modal */}
      <EditRuleModal
        rule={editRule}
        accounts={accounts ?? []}
        categoryOptions={categoryOptions}
        onClose={() => setEditRule(null)}
        onSaved={refetchAll}
        onDeleteClick={(rule) => { setEditRule(null); setDeleteTarget(rule); }}
      />

      {/* Archive rule confirm */}
      <ConfirmSheet
        open={!!archiveTarget}
        title="Archive recurring transaction?"
        description={
          <>
            This will end{" "}
            <span className="font-medium text-foreground">"{archiveTarget?.description}"</span> as
            of today. Future pending instances will be removed; past expenses will not be affected.
          </>
        }
        confirmLabel="Confirm Archive"
        confirmIcon={<Archive className="h-3.5 w-3.5" />}
        loading={actionLoading}
        onCancel={() => setArchiveTarget(null)}
        onConfirm={handleArchiveConfirm}
      />

      {/* Delete rule confirm */}
      <DeleteRuleSheet
        rule={deleteTarget}
        linkedExpenses={linkedExpenses}
        loading={actionLoading}
        onCancel={() => setDeleteTarget(null)}
        onArchive={() => { const r = deleteTarget; setDeleteTarget(null); setArchiveTarget(r); }}
        onDelete={handleDeleteConfirm}
      />

      {/* Transfer detail sheet */}
      <TransferDetailSheet
        rule={transferDetailRule}
        onClose={() => setTransferDetailRule(null)}
        onEdit={(rule) => { setEditingTransferRule(rule); setTransferModalOpen(true); }}
        onArchive={(rule) => setArchiveTransferTarget(rule)}
      />

      {/* Transfer create/edit modal */}
      <TransferRuleModal
        open={transferModalOpen}
        rule={editingTransferRule}
        accounts={(accounts ?? []).filter((a) => !a.isHidden)}
        onClose={() => { setTransferModalOpen(false); setEditingTransferRule(null); }}
        onSave={async (data) => {
          if (editingTransferRule) {
            await updateTransferRule(editingTransferRule.id, { ...data, amount: parseFloat(data.amount!) });
          } else {
            await createTransfer({
              description: data.description!,
              amount: parseFloat(data.amount!),
              date: data.startDate!,
              fromAccountId: data.fromAccountId!,
              toAccountId: data.toAccountId!,
              recurrence: { frequency: data.frequency!, interval: data.interval, endDate: data.endDate },
            });
          }
          setTransferModalOpen(false);
          setEditingTransferRule(null);
          refetchTransfers();
        }}
      />

      {/* Archive transfer confirm */}
      <ConfirmSheet
        open={!!archiveTransferTarget}
        title="Archive recurring transfer?"
        description={
          <>
            This will stop generating future transfers for{" "}
            <span className="font-medium text-foreground">"{archiveTransferTarget?.description}"</span>.
            Past confirmed transfers will not be affected.
          </>
        }
        confirmLabel="Confirm Archive"
        confirmIcon={<Archive className="h-3.5 w-3.5" />}
        loading={transferActionLoading}
        onCancel={() => setArchiveTransferTarget(null)}
        onConfirm={async () => {
          if (!archiveTransferTarget) return;
          setTransferActionLoading(true);
          await archiveTransferRule(archiveTransferTarget.id);
          setArchiveTransferTarget(null);
          setTransferActionLoading(false);
          refetchTransfers();
        }}
      />
    </>
  );
}
