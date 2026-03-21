import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { Trash2, Pencil, Archive, ChevronDown, ChevronRight, Repeat } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LabelList,
  Cell,
  Legend,
} from "recharts";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { useApi } from "@/hooks/useApi";
import {
  getRecurrenceRules,
  getRecurrenceRuleExpenses,
  getUpcomingRecurring,
  getRecurringHistory,
  deleteRecurrenceRule,
  archiveRecurrenceRule,
  updateRecurrenceRule,
  getAccounts,
  getFlatCategories,
  type LinkedExpense,
} from "@/api";
import type { UpcomingExpenseItem, RecurringHistoryMonth } from "@/types";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { RecurrenceRule, Account, Category } from "@/types";

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
  "bg-blue-500",
  "bg-violet-500",
  "bg-orange-500",
  "bg-teal-500",
  "bg-pink-500",
  "bg-indigo-500",
  "bg-amber-500",
  "bg-cyan-500",
];

function vendorColor(vendor: string): string {
  const hash = vendor.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return VENDOR_COLORS[hash % VENDOR_COLORS.length];
}

// Convert a stored UTC date string to a local YYYY-MM-DD key, matching
// the same timezone shift that formatDate() applies for display.
function toLocalDateKey(dateStr: string): string {
  const s = dateStr.replace(/-/g, "/").replace("T", " ").split(".")[0];
  const d = new Date(s);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Single bubble with a portal-based tooltip that escapes overflow containers.
function VendorBubble({ item }: { item: UpcomingExpenseItem }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const label  = item.vendor || item.description;
  const amt    = parseFloat(item.amount);
  const sign   = amt < 0 ? "+" : "";
  const amtStr = `${sign}${formatCurrency(Math.abs(amt))}`;

  return (
    <>
      <div
        className={`h-7 w-7 cursor-default rounded-full flex items-center justify-center text-[11px] font-bold text-white ring-2 ring-background ${vendorColor(label)}`}
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ x: r.left + r.width / 2, y: r.top });
        }}
        onMouseLeave={() => setPos(null)}
      >
        {label.charAt(0).toUpperCase()}
      </div>

      {pos && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] rounded-md border border-border bg-card px-2.5 py-1.5 shadow-md"
          style={{ left: pos.x, top: pos.y - 8, transform: "translate(-50%, -100%)" }}
        >
          <p className="whitespace-nowrap text-xs font-medium text-card-foreground">{label}</p>
          <p className={`whitespace-nowrap text-xs ${amt < 0 ? "text-green-600" : "text-muted-foreground"}`}>
            {amtStr}
          </p>
        </div>,
        document.body,
      )}
    </>
  );
}

function VendorBubbles({ items }: { items: UpcomingExpenseItem[] }) {
  const MAX_VISIBLE = 3;
  const visible  = items.slice(0, MAX_VISIBLE);
  const overflow = items.length - MAX_VISIBLE;
  return (
    <div className="flex justify-center">
      <div className="flex -space-x-2">
        {visible.map((e, i) => <VendorBubble key={i} item={e} />)}
        {overflow > 0 && (
          <div className="h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-semibold bg-muted text-muted-foreground ring-2 ring-background">
            +{overflow}
          </div>
        )}
      </div>
    </div>
  );
}

function UpcomingStrip({ expenses }: { expenses: UpcomingExpenseItem[] }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    return d;
  });

  // Group by local calendar date
  const byDate = new Map<string, UpcomingExpenseItem[]>();
  for (const e of expenses) {
    const key = toLocalDateKey(e.date);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(e);
  }

  return (
    <div className="overflow-x-auto">
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
              className="flex min-w-[72px] flex-1 flex-col border-r border-border last:border-r-0"
            >
              {/* Day header */}
              <div className={`px-1 py-2 text-center ${isToday ? "text-red-500" : "text-muted-foreground"}`}>
                <div className="text-[11px] font-medium uppercase tracking-wide">
                  {isToday ? "Today" : DAY_NAMES[day.getDay()]}
                </div>
                <div className={`text-lg font-semibold leading-tight ${isToday ? "text-red-500" : "text-foreground"}`}>
                  {day.getDate()}
                </div>
              </div>

              {/* Content */}
              <div className="flex flex-1 flex-col items-center justify-start gap-1.5 px-1 py-2.5">
                {hasItems && (
                  <>
                    <VendorBubbles items={dayExpenses} />
                    {debits.length > 0 && (
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground whitespace-nowrap">
                        {formatCurrency(debitTotal)}
                      </span>
                    )}
                    {credits.length > 0 && (
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-green-600 whitespace-nowrap">
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

// ── Annualized cost chart ─────────────────────────────────────────────────────

const CHART_EXPENSE_COLOR = "#6366f1"; // indigo-500
const CHART_CREDIT_COLOR  = "#16a34a"; // green-600
// Semantic tokens shared across all multi-period charts in the app.
// Prior-period series: primary accent hue at 30% opacity, baked directly into
// the color value so recharts legend icons inherit the same appearance as the
// bars (fillOpacity is not forwarded to legend icons by recharts).
// Matches the "last year" line style used in the Budget page monthly chart.
const CHART_PRIOR_PERIOD_COLOR = "rgba(99, 102, 241, 0.3)"; // #6366f1 @ 30%
// Hover highlight: matches the cursor fill used in Dashboard trend / category charts.
const CHART_HOVER_FILL = "#F8FAFC";
const CHART_LABEL_STYLE   = { fontSize: 11, fill: "currentColor" } as const;

interface AnnualCostItem {
  description: string;
  annualized: number;
  isCredit: boolean;
}
interface AnnualCostEntry {
  name: string;       // truncated for Y-axis
  fullName: string;   // full category name for tooltip header
  value: number;      // total annualized for the bar
  isCredit: boolean;  // true when every rule in the group is a credit
  items: AnnualCostItem[];
}

function AnnualCostTooltip({ active, payload }: { active?: boolean; payload?: { payload: AnnualCostEntry }[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-background p-2.5 shadow-md" style={{ fontSize: 12, minWidth: 180 }}>
      <p className="font-semibold text-foreground">{d.fullName}</p>
      <p className="mt-0.5 mb-2 text-muted-foreground">{formatCurrency(d.value)} / year</p>
      <div className="space-y-1 border-t border-border pt-2">
        {d.items.map((item, i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <span className="truncate text-muted-foreground" style={{ maxWidth: 140 }}>{item.description}</span>
            <span className={`shrink-0 font-medium ${item.isCredit ? "text-green-600" : ""}`}>
              {formatCurrency(item.annualized)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnnualCostPanel({
  rules,
  categories,
}: {
  rules: Pick<RecurrenceRule, "description" | "amount" | "frequency" | "interval" | "categoryId">[];
  categories: Category[];
}) {
  // categoryId → leaf name (just the child name keeps Y-axis labels short)
  const catNameMap = new Map<string, string>(categories.map((c) => [c.id, c.name]));

  // Exclude rules whose category is flagged ignoreInBudget
  const ignoredCatIds = new Set(categories.filter((c) => c.ignoreInBudget).map((c) => c.id));
  const includedRules = rules.filter((r) => !ignoredCatIds.has(r.categoryId));

  // Group included rules by category, accumulating annualized amounts
  const groupMap = new Map<string, { fullName: string; items: AnnualCostItem[] }>();
  for (const rule of includedRules) {
    const key      = rule.categoryId || "__none__";
    const fullName = catNameMap.get(rule.categoryId) ?? "Uncategorized";
    if (!groupMap.has(key)) groupMap.set(key, { fullName, items: [] });
    groupMap.get(key)!.items.push({
      description: rule.description,
      annualized:  annualizedAmount(rule),
      isCredit:    parseFloat(rule.amount) < 0,
    });
  }

  const data: AnnualCostEntry[] = Array.from(groupMap.values())
    .map(({ fullName, items }) => {
      const sorted   = [...items].sort((a, b) => b.annualized - a.annualized);
      const total    = sorted.reduce((s, i) => s + i.annualized, 0);
      const isCredit = sorted.every((i) => i.isCredit);
      return {
        name:     fullName.length > 15 ? fullName.slice(0, 14) + "…" : fullName,
        fullName,
        value:    total,
        isCredit,
        items:    sorted,
      };
    })
    .sort((a, b) => b.value - a.value);

  const totalCost = data.filter((d) => !d.isCredit).reduce((s, d) => s + d.value, 0);
  const chartHeight = Math.max(120, data.length * 36 + 16);

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Annual cost</p>
      <p className="mt-0.5 text-2xl font-bold">{formatCurrency(totalCost)}</p>
      <p className="mb-3 text-xs text-muted-foreground">{includedRules.length} active recurring transactions</p>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart layout="vertical" data={data} margin={{ top: 0, right: 88, left: 0, bottom: 0 }}>
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis
            type="category"
            dataKey="name"
            width={100}
            tick={CHART_LABEL_STYLE}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip content={<AnnualCostTooltip />} cursor={{ fill: "transparent" }} />
          <Bar dataKey="value" radius={3} maxBarSize={18}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.isCredit ? CHART_CREDIT_COLOR : CHART_EXPENSE_COLOR} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: number) => formatCurrency(v)}
              style={CHART_LABEL_STYLE}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Year-over-year chart ──────────────────────────────────────────────────────

const currYear = new Date().getFullYear();
const prevYear = currYear - 1;

function YoYPanel({ history }: { history: RecurringHistoryMonth[] }) {
  const hasLastYear = history.some((m) => m.lastYear > 0);
  return (
    <div>
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Year over year
      </p>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={history} margin={{ top: 4, right: 4, left: -18, bottom: 0 }} barCategoryGap="30%">
          <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis
            tick={{ fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
          />
          <Tooltip
            formatter={(v: number, key: string) => [
              formatCurrency(v),
              key === "thisYear" ? String(currYear) : String(prevYear),
            ]}
            contentStyle={{ fontSize: 12 }}
            cursor={{ fill: CHART_HOVER_FILL }}
          />
          {hasLastYear && (
            <Bar dataKey="lastYear" fill={CHART_PRIOR_PERIOD_COLOR} radius={[2, 2, 0, 0]} name={String(prevYear)} />
          )}
          <Bar dataKey="thisYear" fill={CHART_EXPENSE_COLOR} radius={[2, 2, 0, 0]} name={String(currYear)} />
          {hasLastYear && (
            // Legend formatter receives the Bar's `name` prop (the year string), not the dataKey.
            // No transformation needed — pass the value through as-is.
            <Legend
              iconType="square"
              iconSize={8}
              formatter={(v) => v}
              wrapperStyle={{ fontSize: 11, paddingTop: 4, textAlign: "center", width: "100%", left: 0 }}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Shared rule table ─────────────────────────────────────────────────────────
//
// Column layout (fixed widths so active + past tables share the same grid):
//   [Description / freq subline] [Next] [Started] [Ends] [Account] [Amount] [Actions]
//
// The past-rules table omits "Next" content (showNextColumn=false) but still
// renders a same-width column so the remaining columns stay aligned.

function RuleTable({
  rules,
  accountMap,
  onEdit,
  onArchive,
  onDelete,
  showNextColumn = true,
  dimmed = false,
}: {
  rules: RecurrenceRule[];
  accountMap: Map<string, string>;
  onEdit?: (rule: RecurrenceRule) => void;
  onArchive?: (rule: RecurrenceRule) => void;
  onDelete?: (rule: RecurrenceRule) => void;
  showNextColumn?: boolean;
  dimmed?: boolean;
}) {
  const hasActions = !!(onEdit || onArchive || onDelete);
  const colHdr = "pb-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground";

  return (
    <table className="w-full table-fixed text-sm">
      <colgroup>
        {/* Description takes all remaining space */}
        <col />
        <col className="w-[72px]" /> {/* Next */}
        <col className="w-[72px]" /> {/* Started */}
        <col className="w-[72px]" /> {/* Ends */}
        <col className="w-[140px]" /> {/* Account */}
        <col className="w-[88px]" /> {/* Amount */}
        <col className="w-[72px]" /> {/* Actions (always present for alignment) */}
      </colgroup>
      <thead>
        <tr className="border-b border-border">
          <th className={colHdr}>{/* Description — self-explanatory, no heading needed */}</th>
          <th className={showNextColumn ? colHdr : "pb-2"}>
            {showNextColumn ? "Next" : null}
          </th>
          <th className={colHdr}>Started</th>
          <th className={colHdr}>{showNextColumn ? "Ends" : "Ended"}</th>
          <th className={colHdr}>Account</th>
          <th className={`${colHdr} pr-3 text-right`}>Amount</th>
          <th className="pb-2" /> {/* Actions — always rendered for column alignment */}
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rules.map((rule) => (
          <tr key={rule.id} className={dimmed ? "opacity-60" : ""}>
            <td className="py-3 pr-4">
              <p className="font-medium">{rule.description}</p>
              <p className="text-xs text-muted-foreground">
                {formatFrequency(rule.frequency, rule.interval)}
              </p>
            </td>
            <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
              {showNextColumn
                ? formatDate(rule.nextExpenseDate ?? rule.nextOccurrence)
                : null}
            </td>
            <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
              {formatDate(rule.startDate)}
            </td>
            <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
              {rule.endDate ? formatDate(rule.endDate) : "—"}
            </td>
            <td className="py-3 pr-4 truncate text-muted-foreground">
              {accountMap.get(rule.accountId) ?? "—"}
            </td>
            <td className={`py-3 pr-3 text-right font-medium${parseFloat(rule.amount) < 0 ? " text-green-600" : ""}`}>
              {displayAmount(rule.amount)}
            </td>
            <td className="py-3">
              {hasActions && (
                <div className="flex items-center justify-end gap-1">
                  {onEdit && (
                    <button
                      onClick={() => onEdit(rule)}
                      className="rounded p-1 hover:bg-accent"
                      title="Edit recurring transaction"
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </button>
                  )}
                  {onArchive && (
                    <button
                      onClick={() => onArchive(rule)}
                      className="rounded p-1 hover:bg-accent"
                      title="Archive recurring transaction"
                    >
                      <Archive className="h-4 w-4 text-muted-foreground" />
                    </button>
                  )}
                  {onDelete && (
                    <button
                      onClick={() => onDelete(rule)}
                      className="rounded p-1 hover:bg-accent"
                      title="Permanently delete recurring transaction"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </button>
                  )}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Edit form state ───────────────────────────────────────────────────────────

interface EditForm {
  description: string;
  amount: string;
  accountId: string;
  categoryId: string;
  endDate: string;
}

// ── Shared confirm modal ──────────────────────────────────────────────────────

function ConfirmModal({
  open,
  title,
  children,
  actions,
  wide = false,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className={`w-full ${wide ? "max-w-lg" : "max-w-sm"} rounded-lg bg-background p-6 shadow-xl text-foreground`}>
        <h3 className="text-base font-semibold">{title}</h3>
        <div className="mt-2 text-sm text-muted-foreground">{children}</div>
        <div className="mt-4 flex gap-2">{actions}</div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function Recurring() {
  const { data: rules, refetch } = useApi(() => getRecurrenceRules(), []);
  const { data: accounts } = useApi<Account[]>(() => getAccounts(), []);
  const { data: categories } = useApi<Category[]>(() => getFlatCategories(), []);
  const { data: upcomingExpenses } = useApi(() => getUpcomingRecurring(14), []);
  const { data: recurringHistory } = useApi(() => getRecurringHistory(6), []);

  // Past rules: lazy-fetched when the user expands the section.
  // Going forward only naturally-expired/archived rules appear here since
  // deleted rules are hard-deleted from the DB.
  const [showPast, setShowPast] = useState(false);
  const { data: pastRules, refetch: refetchPast } = useApi(
    () => (showPast ? getRecurrenceRules({ includeInactive: true }) : Promise.resolve(null)),
    [showPast],
  );

  // ── Action targets ──
  const [archiveTarget, setArchiveTarget] = useState<RecurrenceRule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecurrenceRule | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // ── Linked expenses for delete modal ──
  // null = not yet loaded, "loading" = in flight, array = loaded
  const [linkedExpenses, setLinkedExpenses] = useState<LinkedExpense[] | "loading" | null>(null);

  useEffect(() => {
    if (!deleteTarget) {
      setLinkedExpenses(null);
      return;
    }
    setLinkedExpenses("loading");
    getRecurrenceRuleExpenses(deleteTarget.id)
      .then(setLinkedExpenses)
      .catch(() => setLinkedExpenses([]));
  }, [deleteTarget]);

  // ── Edit state ──
  const [editTarget, setEditTarget] = useState<RecurrenceRule | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    description: "",
    amount: "",
    accountId: "",
    categoryId: "",
    endDate: "",
  });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // ── Lookup maps ──
  const accountMap = useMemo(
    () => new Map((accounts ?? []).map((a) => [a.id, a.name])),
    [accounts],
  );

  const categoryOptions = useMemo(() => {
    const cats = categories ?? [];
    const parentNames = new Map(
      cats.filter((c) => !c.parentId).map((c) => [c.id, c.name]),
    );
    return [
      { id: "", label: "No category" },
      ...cats
        .map((c) => ({
          id: c.id,
          label: c.parentId
            ? `${parentNames.get(c.parentId) ?? "?"} > ${c.name}`
            : c.name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
  }, [categories]);

  // ── Helpers ──

  const refetchAll = () => {
    refetch();
    if (showPast) refetchPast();
  };

  // ── Archive handler ──

  const handleArchiveConfirm = async () => {
    if (!archiveTarget) return;
    setActionLoading(true);
    await archiveRecurrenceRule(archiveTarget.id);
    setArchiveTarget(null);
    setActionLoading(false);
    refetchAll();
  };

  // ── Delete handler ──

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setActionLoading(true);
    await deleteRecurrenceRule(deleteTarget.id);
    setDeleteTarget(null);
    setActionLoading(false);
    refetchAll();
  };

  // Switch from delete confirm → archive confirm (user clicked "Archive" in the delete modal)
  const handleSwitchToArchive = () => {
    const rule = deleteTarget;
    setDeleteTarget(null);
    setArchiveTarget(rule);
  };

  // ── Edit handlers ──

  const handleEditOpen = (rule: RecurrenceRule) => {
    const n = parseFloat(rule.amount);
    setEditForm({
      description: rule.description,
      amount: n.toFixed(2),
      accountId: rule.accountId,
      categoryId: rule.categoryId ?? "",
      endDate: rule.endDate ? rule.endDate.slice(0, 10) : "",
    });
    setEditError(null);
    setEditTarget(rule);
  };

  // Delete button inside the edit modal — close edit first, then show delete confirm.
  const handleEditDeleteClick = () => {
    const rule = editTarget;
    setEditTarget(null);
    setDeleteTarget(rule);
  };

  const todayStr = new Date().toISOString().slice(0, 10);
  const endDateIsRetroactive = !!editForm.endDate && editForm.endDate < todayStr;

  const handleEditSave = async () => {
    if (!editTarget) return;
    const amountVal = parseFloat(editForm.amount);
    if (isNaN(amountVal) || amountVal === 0) {
      setEditError("Amount must be a non-zero number.");
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      await updateRecurrenceRule(editTarget.id, {
        description: editForm.description.trim() || editTarget.description,
        amount: amountVal,
        accountId: editForm.accountId,
        categoryId: editForm.categoryId || null,
        endDate: editForm.endDate || null,
      });
      setEditTarget(null);
      refetchAll();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Recurring Expenses</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Recurring expenses are created from the Add Expense form. This page shows all active
          recurring transactions.
        </p>
      </div>

      {/* ── Upcoming 14-day strip ── */}
      {upcomingExpenses && upcomingExpenses.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Next 2 weeks
          </p>
          <UpcomingStrip expenses={upcomingExpenses} />
        </div>
      )}

      {/* ── Table + charts side-by-side ── */}
      <div className="flex items-start gap-6">

        {/* Left: active table + ended section — 2/3 width */}
        <div className="min-w-0 basis-2/3 space-y-6">
          <Card>
            {rules && rules.length > 0 ? (
              <RuleTable
                rules={rules}
                accountMap={accountMap}
                onEdit={handleEditOpen}
                onArchive={setArchiveTarget}
              />
            ) : (
              <EmptyState
                icon={Repeat}
                title="No recurring expenses"
                description="Create a recurring expense by toggling 'Recurring expense' when adding a new expense."
              />
            )}
          </Card>

          <div>
            <button
              onClick={() => setShowPast((v) => !v)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {showPast ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              Ended recurring transactions
            </button>

            {showPast && (
              <div className="mt-3">
                {pastRules === null ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : pastRules.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No ended recurring transactions.</p>
                ) : (
                  <Card>
                    <RuleTable
                      rules={pastRules}
                      accountMap={accountMap}
                      showNextColumn={false}
                      dimmed
                    />
                  </Card>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: analytics panel */}
        {rules && rules.length > 0 && (
          <div className="min-w-0 basis-1/3 space-y-6">
            <Card className="p-5">
              <AnnualCostPanel rules={rules} categories={categories ?? []} />
            </Card>
            {recurringHistory && recurringHistory.length > 0 && (
              <Card className="p-5">
                <YoYPanel history={recurringHistory} />
              </Card>
            )}
          </div>
        )}

      </div>

      {/* ── Archive confirmation modal ── */}
      <ConfirmModal
        open={!!archiveTarget}
        title="Archive recurring transaction?"
        actions={
          <>
            <button
              onClick={() => setArchiveTarget(null)}
              disabled={actionLoading}
              className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleArchiveConfirm}
              disabled={actionLoading}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Archive className="h-3.5 w-3.5" />
              {actionLoading ? "Archiving…" : "Confirm Archive"}
            </button>
          </>
        }
      >
        <p>
          This will end{" "}
          <span className="font-medium text-foreground">"{archiveTarget?.description}"</span> as
          of today. Future pending instances will be removed, and no new instances will be
          generated. Past recorded expenses will not be affected.
        </p>
      </ConfirmModal>

      {/* ── Delete confirmation modal ── */}
      {(() => {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const pastExpenses = Array.isArray(linkedExpenses)
          ? linkedExpenses.filter((e) => new Date(e.date) <= today)
          : [];
        const futureExpenses = Array.isArray(linkedExpenses)
          ? linkedExpenses.filter((e) => new Date(e.date) > today)
          : [];
        const totalLinked = Array.isArray(linkedExpenses) ? linkedExpenses.length : 0;

        return (
          <ConfirmModal
            open={!!deleteTarget}
            wide
            title="Permanently delete recurring transaction?"
            actions={
              <>
                <button
                  onClick={() => setDeleteTarget(null)}
                  disabled={actionLoading}
                  className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSwitchToArchive}
                  disabled={actionLoading}
                  className="flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Archive
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  disabled={actionLoading || linkedExpenses === "loading"}
                  className="flex items-center justify-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {actionLoading ? "Deleting…" : "Confirm Delete"}
                </button>
              </>
            }
          >
            <p>
              This <em>permanently</em> removes the recurring transaction for{" "}
              <span className="font-medium text-foreground">"{deleteTarget?.description}"</span>.
              To gracefully end a series instead, use <em>Archive</em>.
            </p>

            {/* Linked transaction summary */}
            <div className="mt-3">
              {linkedExpenses === "loading" ? (
                <p className="text-xs text-muted-foreground italic">Loading linked transactions…</p>
              ) : totalLinked === 0 ? (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                  No transactions are linked to this recurring transaction — deleting it will not affect any expenses.
                </p>
              ) : (
                <div className="space-y-3">
                  {pastExpenses.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-foreground">
                        Past transactions ({pastExpenses.length}) —{" "}
                        <span className="font-normal">will be preserved as standalone expenses</span>
                      </p>
                      <div className="max-h-36 overflow-y-auto rounded-md border border-border divide-y divide-border text-xs">
                        {pastExpenses.map((e) => (
                          <div key={e.id} className="flex items-center gap-3 px-3 py-1.5">
                            <span className="w-16 shrink-0 text-muted-foreground">{formatDate(e.date)}</span>
                            <span className="flex-1 truncate">{e.description}</span>
                            <span className="w-24 shrink-0 truncate text-muted-foreground">{e.account.name}</span>
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
                        <span className="font-normal">will be permanently deleted</span>
                      </p>
                      <div className="max-h-36 overflow-y-auto rounded-md border border-border divide-y divide-border text-xs">
                        {futureExpenses.map((e) => (
                          <div key={e.id} className="flex items-center gap-3 px-3 py-1.5">
                            <span className="w-16 shrink-0 text-muted-foreground">{formatDate(e.date)}</span>
                            <span className="flex-1 truncate">{e.description}</span>
                            <span className="w-24 shrink-0 truncate text-muted-foreground">{e.account.name}</span>
                            <span className={`shrink-0 font-medium${parseFloat(e.amount) < 0 ? " text-green-600" : ""}`}>{displayAmount(e.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </ConfirmModal>
        );
      })()}

      {/* ── Edit modal ── */}
      <Modal open={!!editTarget} onClose={() => setEditTarget(null)} title="Edit Recurring Transaction">
        <div className="space-y-4">
          {/* Description */}
          <div>
            <label className="mb-1 block text-sm font-medium">Description</label>
            <input
              type="text"
              value={editForm.description}
              onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Amount */}
          <div>
            <label className="mb-1 block text-sm font-medium">Amount</label>
            <input
              type="number"
              step="0.01"
              value={editForm.amount}
              onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Account */}
          <div>
            <label className="mb-1 block text-sm font-medium">Account</label>
            <select
              value={editForm.accountId}
              onChange={(e) => setEditForm((f) => ({ ...f, accountId: e.target.value }))}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {(accounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          {/* Category */}
          <div>
            <label className="mb-1 block text-sm font-medium">Category</label>
            <select
              value={editForm.categoryId}
              onChange={(e) => setEditForm((f) => ({ ...f, categoryId: e.target.value }))}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {categoryOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* End date */}
          <div>
            <label className="mb-1 block text-sm font-medium">
              End date{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              type="date"
              value={editForm.endDate}
              onChange={(e) => setEditForm((f) => ({ ...f, endDate: e.target.value }))}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {endDateIsRetroactive && (
              <p className="mt-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
                This end date is in the past. Any recorded expenses in this series after{" "}
                <span className="font-medium">{editForm.endDate}</span> will be permanently
                deleted.
              </p>
            )}
          </div>

          {editError && <p className="text-xs text-destructive">{editError}</p>}

          {/* Footer: Delete (left) · Cancel + Save (right) */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={handleEditDeleteClick}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => setEditTarget(null)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button onClick={handleEditSave} disabled={saving}>
                {saving ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
