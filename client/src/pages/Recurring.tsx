import { useState, useMemo, useEffect, useRef, memo } from"react";
import { useSearchParams } from"react-router-dom";
import { createPortal } from"react-dom";
import { Trash2, Pencil, Archive, ChevronDown, ChevronRight, Repeat, Plus, ArrowRight } from"lucide-react";
import {
 BarChart,
 Bar,
 XAxis,
 YAxis,
 Tooltip as RechartsTooltip,
 ResponsiveContainer,
 LabelList,
 Cell,
 Legend,
} from"recharts";
import { Card } from"@/components/Card";
import { EmptyState } from"@/components/EmptyState";
import { Tooltip } from"@/components/Tooltip";
import { Modal } from"@/components/Modal";
import { Button } from"@/components/Button";
import { DatePicker } from"@/components/DatePicker";
import { useApi } from"@/hooks/useApi";
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
 getTransferRules,
 createTransfer,
 updateTransferRule,
 archiveTransferRule,
 type LinkedExpense,
} from"@/api";
import type { UpcomingExpenseItem, RecurringHistoryMonth } from"@/types";
import { formatCurrency, formatDate, toDateInputValue, parseAmount } from"@/lib/utils";
import type { RecurrenceRule, Account, Category, TransferRule } from"@/types";
import { BeaconLoader } from"@/components/BeaconLoader";
import { SectionLabel, DisplayStat, ColumnHeader } from"@/components/Typography";
import { ItemTypeahead } from"@/components/ItemTypeahead";
import { CategoryTypeahead } from"@/components/CategoryTypeahead";

// ── Frequency helpers ─────────────────────────────────────────────────────────

const frequencyUnit: Record<string, { singular: string; plural: string }> = {
 DAILY: { singular:"day", plural:"days" },
 WEEKLY: { singular:"week", plural:"weeks" },
 MONTHLY: { singular:"month", plural:"months" },
 YEARLY: { singular:"year", plural:"years" },
};

function formatFrequency(frequency: string, interval: number): string {
 const unit = frequencyUnit[frequency];
 if (!unit) return frequency.toLowerCase();
 return interval === 1 ?`every ${unit.singular}` :`every ${interval} ${unit.plural}`;
}

function displayAmount(amount: string): string {
 const n = parseFloat(amount);
 return n < 0 ?`+${formatCurrency(Math.abs(n))}` : formatCurrency(n);
}

// ── Upcoming strip ────────────────────────────────────────────────────────────

// Decorative vendor-avatar palette (not §04 tags) — raw shades; revisit in §06 swatches.
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
 const s = dateStr.replace(/-/g,"/").replace("T","").split(".")[0];
 const d = new Date(s);
 const y = d.getFullYear();
 const m = String(d.getMonth() + 1).padStart(2,"0");
 const day = String(d.getDate()).padStart(2,"0");
 return`${y}-${m}-${day}`;
}

function localDateKey(d: Date): string {
 return`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// Single bubble with a portal-based tooltip that escapes overflow containers.
function VendorBubble({ item }: { item: UpcomingExpenseItem }) {
 const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
 const label = item.vendor || item.description;
 const amt = parseFloat(item.amount);
 const sign = amt < 0 ?"+" :"";
 const amtStr =`${sign}${formatCurrency(Math.abs(amt))}`;

 return (
 <>
 <div
 className={`h-7 w-7 cursor-default rounded-full flex items-center justify-center text-11 font-bold text-white ring-2 ring-background ${vendorColor(label)}`}
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
 style={{ left: pos.x, top: pos.y - 8, transform:"translate(-50%, -100%)" }}
 >
 <p className="whitespace-nowrap text-xs font-medium text-card-foreground">{label}</p>
 <p className={`whitespace-nowrap text-xs ${amt < 0 ?"text-up" :"text-muted-foreground"}`}>
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
 const visible = items.slice(0, MAX_VISIBLE);
 const overflow = items.length - MAX_VISIBLE;
 return (
 <div className="flex justify-center">
 <div className="flex -space-x-2">
 {visible.map((e, i) => <VendorBubble key={i} item={e} />)}
 {overflow > 0 && (
 <div className="h-7 w-7 rounded-full flex items-center justify-center text-10 font-semibold bg-secondary text-muted-foreground ring-2 ring-background">
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

 // Group by local calendar date, sorted highest amount to lowest within each day
 const byDate = new Map<string, UpcomingExpenseItem[]>();
 for (const e of expenses) {
 const key = toLocalDateKey(e.date);
 if (!byDate.has(key)) byDate.set(key, []);
 byDate.get(key)!.push(e);
 }
 for (const items of byDate.values()) {
 items.sort((a, b) => Math.abs(parseFloat(b.amount)) - Math.abs(parseFloat(a.amount)));
 }

 return (
 <div className="overflow-x-auto">
 <div className="flex">
 {days.map((day, i) => {
 const key = localDateKey(day);
 const dayExpenses = byDate.get(key) ?? [];
 const debits = dayExpenses.filter((e) => parseFloat(e.amount) > 0);
 const credits = dayExpenses.filter((e) => parseFloat(e.amount) < 0);
 const debitTotal = debits.reduce((s, e) => s + parseFloat(e.amount), 0);
 const creditTotal = credits.reduce((s, e) => s + Math.abs(parseFloat(e.amount)), 0);
 const isToday = i === 0;
 const hasItems = dayExpenses.length > 0;

 return (
 <div
 key={key}
 className="flex min-w-[72px] flex-1 flex-col border-r border-border last:border-r-0"
 >
 {/* Day header */}
 <div className={`px-1 py-2 text-center ${isToday ?"text-down" :"text-muted-foreground"}`}>
 <SectionLabel as="div" className="text-11">
 {isToday ?"Today" : DAY_NAMES[day.getDay()]}
 </SectionLabel>
 <div className={`tp-card-title leading-tight ${isToday ?"text-down" :""}`}>
 {day.getDate()}
 </div>
 </div>

 {/* Content */}
 <div className="flex flex-1 flex-col items-center justify-start gap-1.5 px-1 py-2.5">
 {hasItems && (
 <>
 <VendorBubbles items={dayExpenses} />
 {debits.length > 0 && (
 <span className="rounded-md bg-secondary px-1.5 py-0.5 text-11 font-medium text-foreground whitespace-nowrap">
 {formatCurrency(debitTotal)}
 </span>
 )}
 {credits.length > 0 && (
 <span className="rounded-md bg-secondary px-1.5 py-0.5 text-11 font-medium text-up whitespace-nowrap">
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
 case"DAILY": return abs * (365 / rule.interval);
 case"WEEKLY": return abs * (52 / rule.interval);
 case"MONTHLY": return abs * (12 / rule.interval);
 case"YEARLY": return abs * (1 / rule.interval);
 default: return 0;
 }
}

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fmtShortDate(d: Date): string {
 return`${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// Parse a date string (ISO timestamp or"YYYY-MM-DD") as local midnight to
// avoid UTC-offset shifts. Slices to the date portion before parsing.
function parseLocalDate(s: string): Date {
 const [y, m, d] = s.slice(0, 10).split("-").map(Number);
 return new Date(y, m - 1, d);
}

// Count payment occurrences from ruleStart (on the rule's billing cycle) that
// fall within [windowStart, windowEnd] inclusive.
function countOccurrences(
 ruleStart: Date,
 windowStart: Date,
 windowEnd: Date,
 frequency: string,
 interval: number,
): number {
 let current = new Date(ruleStart);
 let count = 0;
 switch (frequency) {
 case"DAILY": {
 if (current < windowStart) {
 const steps = Math.ceil((windowStart.getTime() - current.getTime()) / (86400000 * interval));
 current = new Date(ruleStart.getTime() + steps * interval * 86400000);
 }
 while (current <= windowEnd) { count++; current = new Date(current.getTime() + interval * 86400000); }
 break;
 }
 case"WEEKLY": {
 if (current < windowStart) {
 const steps = Math.ceil((windowStart.getTime() - current.getTime()) / (86400000 * 7 * interval));
 current = new Date(ruleStart.getTime() + steps * 7 * interval * 86400000);
 }
 while (current <= windowEnd) { count++; current = new Date(current.getTime() + 7 * interval * 86400000); }
 break;
 }
 case"MONTHLY": {
 while (current < windowStart) {
 current = new Date(current.getFullYear(), current.getMonth() + interval, current.getDate());
 }
 while (current <= windowEnd) {
 count++;
 current = new Date(current.getFullYear(), current.getMonth() + interval, current.getDate());
 }
 break;
 }
 case"YEARLY": {
 while (current < windowStart) {
 current = new Date(current.getFullYear() + interval, current.getMonth(), current.getDate());
 }
 while (current <= windowEnd) {
 count++;
 current = new Date(current.getFullYear() + interval, current.getMonth(), current.getDate());
 }
 break;
 }
 }
 return count;
}

// Returns the total cost for this rule within the current calendar year,
// counting actual payment occurrences. When the rule's start or end date
// constrains the year window, also returns a human-readable note.
function effectiveYearCost(rule: {
 amount: string; frequency: string; interval: number;
 startDate: string; endDate?: string | null;
}): { cost: number; proratedNote: string | null } {
 const abs = Math.abs(parseFloat(rule.amount));
 const year = new Date().getFullYear();
 const yearStart = new Date(year, 0, 1);
 const yearEnd = new Date(year, 11, 31);
 const ruleStart = parseLocalDate(rule.startDate);
 const ruleEnd = rule.endDate ? parseLocalDate(rule.endDate) : null;

 const windowStart = ruleStart > yearStart ? ruleStart : yearStart;
 const windowEnd = ruleEnd && ruleEnd < yearEnd ? ruleEnd : yearEnd;

 const count = countOccurrences(ruleStart, windowStart, windowEnd, rule.frequency, rule.interval);
 const effectiveCost = abs * count;
 const annualized = annualizedAmount(rule);

 if (effectiveCost >= annualized) return { cost: annualized, proratedNote: null };

 const note =`${count} payment${count !== 1 ?"s" :""} from ${fmtShortDate(windowStart)} to ${fmtShortDate(windowEnd)}`;
 return { cost: effectiveCost, proratedNote: note };
}

// ── Annualized cost chart ─────────────────────────────────────────────────────

const EMPTY_CATEGORIES: Category[] = [];

const CHART_EXPENSE_COLOR ="var(--color-chart-1)"; // chart series 1
const CHART_CREDIT_COLOR ="var(--color-up)"; // positive / credit
// Semantic tokens shared across all multi-period charts in the app.
// Prior-period series: primary accent hue at 30% opacity, baked directly into
// the color value so recharts legend icons inherit the same appearance as the
// bars (fillOpacity is not forwarded to legend icons by recharts).
// Matches the"last year" line style used in the Budget page monthly chart.
const CHART_PRIOR_PERIOD_COLOR ="color-mix(in oklab, var(--color-chart-1) 30%, transparent)"; // chart-1 @ 30%
// Hover highlight: matches the cursor fill used in Dashboard trend / category charts.
const CHART_HOVER_FILL ="var(--color-chart-hover)";
const CHART_LABEL_STYLE = { fontSize: 11, fill:"currentColor" } as const;

interface AnnualCostItem {
 description: string;
 annualized: number;
 isCredit: boolean;
 proratedNote: string | null;
}
interface AnnualCostEntry {
 name: string; // truncated for Y-axis
 fullName: string; // full category name for tooltip header
 value: number; // total annualized for the bar
 isCredit: boolean; // true when every rule in the group is a credit
 items: AnnualCostItem[];
}

function AnnualCostTooltip({ active, payload }: { active?: boolean; payload?: { payload: AnnualCostEntry }[] }) {
 if (!active || !payload?.length) return null;
 const d = payload[0].payload;
 return (
 <div className="rounded-md border border-border bg-background p-2.5 shadow-md" style={{ fontSize: 12, minWidth: 180 }}>
 <p className="font-semibold text-foreground">{d.fullName}</p>
 <p className="mt-0.5 mb-2 text-muted-foreground">{formatCurrency(d.value)} expected this year</p>
 <div className="space-y-1.5 border-t border-border pt-2">
 {d.items.map((item, i) => (
 <div key={i} className="flex items-start justify-between gap-3">
 <div className="min-w-0">
 <span className="truncate text-muted-foreground block" style={{ maxWidth: 140 }}>{item.description}</span>
 {item.proratedNote && (
 <span className="tp-caption/70">* {item.proratedNote}</span>
 )}
 </div>
 <span className={`shrink-0 font-medium ${item.isCredit ?"text-up" :""}`}>
 {formatCurrency(item.annualized)}
 </span>
 </div>
 ))}
 </div>
 </div>
 );
}

const AnnualCostPanel = memo(function AnnualCostPanel({
 rules,
 categories,
}: {
 rules: Pick<RecurrenceRule,"description" |"amount" |"frequency" |"interval" |"categoryId" |"startDate" |"endDate">[];
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
 const key = rule.categoryId ||"__none__";
 const fullName = catNameMap.get(rule.categoryId) ??"Uncategorized";
 if (!groupMap.has(key)) groupMap.set(key, { fullName, items: [] });
 const { cost, proratedNote } = effectiveYearCost(rule);
 groupMap.get(key)!.items.push({
 description: rule.description,
 annualized: cost,
 isCredit: parseFloat(rule.amount) < 0,
 proratedNote,
 });
 }

 const data: AnnualCostEntry[] = Array.from(groupMap.values())
 .map(({ fullName, items }) => {
 const sorted = [...items].sort((a, b) => b.annualized - a.annualized);
 const total = sorted.reduce((s, i) => s + i.annualized, 0);
 const isCredit = sorted.every((i) => i.isCredit);
 return {
 name: fullName.length > 15 ? fullName.slice(0, 14) +"…" : fullName,
 fullName,
 value: total,
 isCredit,
 items: sorted,
 };
 })
 .sort((a, b) => b.value - a.value);

 const totalCost = data.filter((d) => !d.isCredit).reduce((s, d) => s + d.value, 0);
 const chartHeight = Math.max(120, data.length * 36 + 16);

 return (
 <div>
 <SectionLabel>Annual cost</SectionLabel>
 <DisplayStat as="p" className="mt-0.5 tp-kpi-l">{formatCurrency(totalCost)}</DisplayStat>
 <p className="mb-3 tp-fineprint">{includedRules.length} active recurring transactions</p>
 <ResponsiveContainer width="100%" height={chartHeight}>
 <BarChart layout="vertical" data={data} margin={{ top: 0, right: 88, left: 0, bottom: 0 }}>
 <XAxis type="number" hide domain={[0,"dataMax"]} />
 <YAxis
 type="category"
 dataKey="name"
 width={100}
 tick={CHART_LABEL_STYLE}
 tickLine={false}
 axisLine={false}
 />
 <RechartsTooltip content={<AnnualCostTooltip />} cursor={{ fill:"transparent" }} />
 <Bar dataKey="value" radius={3} maxBarSize={18}>
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
 <SectionLabel className="mb-3">
 Year over year
 </SectionLabel>
 <ResponsiveContainer width="100%" height={160}>
 <BarChart data={history} margin={{ top: 4, right: 4, left: -18, bottom: 0 }} barCategoryGap="30%">
 <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
 <YAxis
 tick={{ fontSize: 10 }}
 tickLine={false}
 axisLine={false}
 tickFormatter={(v: number) =>`$${v >= 1000 ?`${(v / 1000).toFixed(1)}k` : v}`}
 />
 <RechartsTooltip
 content={({ active, payload, label }) => {
 if (!active || !payload?.length) return null;
 return (
 <div className="rounded border border-border bg-background p-2 text-xs shadow-md">
 <p className="mb-1.5 font-medium">{label}</p>
 {payload.map((p) => (
 <p key={p.dataKey as string} className="mt-1 text-foreground">
 {(p.dataKey as string) ==="thisYear" ? currYear : prevYear}: {formatCurrency(p.value as number)}
 </p>
 ))}
 </div>
 );
 }}
 cursor={{ fill: CHART_HOVER_FILL }}
 />
 {hasLastYear && (
 <Bar dataKey="lastYear" fill={CHART_PRIOR_PERIOD_COLOR} radius={[2, 2, 0, 0]} name={String(prevYear)} />
 )}
 <Bar dataKey="thisYear" fill={CHART_EXPENSE_COLOR} radius={[2, 2, 0, 0]} name={String(currYear)} />
 {hasLastYear && (
 // Legend formatter receives the Bar's`name` prop (the year string), not the dataKey.
 // No transformation needed — pass the value through as-is.
 <Legend
 iconType="square"
 iconSize={8}
 formatter={(v) => v}
 wrapperStyle={{ fontSize: 11, paddingTop: 4, textAlign:"center", width:"100%", left: 0 }}
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
// [Description / freq subline] [Next] [Started] [Ends] [Account] [Amount] [Actions]
//
// The past-rules table omits"Next" content (showNextColumn=false) but still
// renders a same-width column so the remaining columns stay aligned.

function RuleTable({
 rules,
 accountMap,
 onEdit,
 onArchive,
 onDelete,
 showNextColumn = true,
 dimmed = false,
 highlightId,
 highlightFading,
 highlightRowRef,
}: {
 rules: RecurrenceRule[];
 accountMap: Map<string, string>;
 onEdit?: (rule: RecurrenceRule) => void;
 onArchive?: (rule: RecurrenceRule) => void;
 onDelete?: (rule: RecurrenceRule) => void;
 showNextColumn?: boolean;
 dimmed?: boolean;
 highlightId?: string | null;
 highlightFading?: boolean;
 highlightRowRef?: (el: HTMLTableRowElement | null) => void;
}) {
 const hasActions = !!(onEdit || onArchive || onDelete);

 return (
 <table className="w-full table-fixed text-13">
 <colgroup>
 {/* Description takes all remaining space */}
 <col />
 {/* Next */}<col className="w-[72px]" />
 {/* Started */}<col className="w-[72px]" />
 {/* Ends */}<col className="w-[72px]" />
 {/* Account */}<col className="w-[140px]" />
 {/* Amount */}<col className="w-[88px]" />
 {/* Actions (always present for alignment) */}<col className="w-[72px]" />
 </colgroup>
 <thead>
 <tr className="border-b border-border">
 <ColumnHeader className="pb-2 text-left">{/* Description — self-explanatory, no heading needed */}</ColumnHeader>
 <ColumnHeader className="pb-2 text-left">{showNextColumn ?"Next" : null}</ColumnHeader>
 <ColumnHeader className="pb-2 text-left">Started</ColumnHeader>
 <ColumnHeader className="pb-2 text-left">{showNextColumn ?"Ends" :"Ended"}</ColumnHeader>
 <ColumnHeader className="pb-2 text-left">Account</ColumnHeader>
 <ColumnHeader className="pb-2 pr-3 text-right">Amount</ColumnHeader>
 {/* Actions — always rendered for column alignment */}<th className="pb-2" />
 </tr>
 </thead>
 <tbody className="divide-y divide-border">
 {rules.map((rule) => (
 <tr
 key={rule.id}
 ref={rule.id === highlightId ? highlightRowRef : undefined}
 className={`${dimmed ?"opacity-60" :""} ${rule.id === highlightId ?`transition-colors duration-1000${highlightFading ?"" :" bg-warn-soft"}` :""}`}
 >
 <td className="py-3 pr-4">
 <p className="font-medium">{rule.description}</p>
 <p className="tp-caption">
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
 {rule.endDate ? formatDate(rule.endDate) :"—"}
 </td>
 <td className="py-3 pr-4 truncate text-muted-foreground">
 {accountMap.get(rule.accountId) ??"—"}
 </td>
 <td className={`py-3 pr-3 text-right tp-numeric${parseFloat(rule.amount) < 0 ?" text-up" :""}`}>
 {displayAmount(rule.amount)}
 </td>
 <td className="py-3">
 {hasActions && (
 <div className="flex items-center justify-end gap-1">
 {onEdit && (
 <Tooltip content="Edit recurring transaction">
 <button
 onClick={() => onEdit(rule)}
 className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted-hover transition-colors"
 >
 <Pencil className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
 )}
 {onArchive && (
 <Tooltip content="Archive recurring transaction">
 <button
 onClick={() => onArchive(rule)}
 className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted-hover transition-colors"
 >
 <Archive className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
 )}
 {onDelete && (
 <Tooltip content="Permanently delete recurring transaction">
 <button
 onClick={() => onDelete(rule)}
 className="rounded p-1.5 text-muted-foreground/40 hover:text-down hover:bg-down-soft transition-colors"
 >
 <Trash2 className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
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
 group: string;
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
 <div className={`w-full ${wide ?"max-w-lg" :"max-w-sm"} rounded-lg bg-background p-6 shadow-xl text-foreground`}>
 <h3 className="tp-panel-title">{title}</h3>
 <div className="mt-2 text-muted-foreground">{children}</div>
 <div className="mt-4 flex gap-2">{actions}</div>
 </div>
 </div>
 );
}

// ── Transfer rule modal ───────────────────────────────────────────────────────

interface TransferRuleFormData {
 description?: string;
 amount?: string;
 fromAccountId?: string;
 toAccountId?: string;
 frequency?:"DAILY" |"WEEKLY" |"MONTHLY" |"YEARLY";
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
 const [errors, setErrors] = useState<{ description?: string; amount?: string; fromAccountId?: string; toAccountId?: string; startDate?: string }>({});
 const bankAccounts = accounts.filter((a) => a.type ==="CHECKING" || a.type ==="SAVINGS");

 useEffect(() => {
 if (open) {
 setErrors({});
 setForm(
 rule
 ? {
 description: rule.description,
 amount: rule.amount,
 fromAccountId: rule.fromAccountId,
 toAccountId: rule.toAccountId,
 frequency: rule.frequency,
 interval: rule.interval,
 startDate: toDateInputValue(rule.startDate),
 endDate: rule.endDate ? toDateInputValue(rule.endDate) :"",
 }
 : {
 frequency:"MONTHLY",
 interval: 1,
 startDate: toDateInputValue(new Date().toISOString()),
 }
 );
 }
 }, [open, rule]);

 const set = (patch: Partial<TransferRuleFormData>) => setForm((f) => ({ ...f, ...patch }));

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 const newErrors: typeof errors = {};
 if (!form.description?.trim()) newErrors.description ="Description is required";
 const amt = parseFloat(String(form.amount ??""));
 if (!form.amount || isNaN(amt) || amt <= 0) newErrors.amount ="Enter a valid amount";
 if (!form.fromAccountId) newErrors.fromAccountId ="Select a source account";
 if (!form.toAccountId) newErrors.toAccountId ="Select a destination account";
 if (!rule && !form.startDate) newErrors.startDate ="Start date is required";
 if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
 setSaving(true);
 await onSave({ ...form, endDate: form.endDate || null });
 setSaving(false);
 };

 const inputCls ="w-full rounded-md border border-border px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
 const errCls ="w-full rounded-md border border-down px-3 py-2 focus:border-down focus:outline-none focus:ring-1 focus:ring-down/30";

 return (
 <Modal open={open} onClose={onClose} title={rule ?"Edit Recurring Transfer" :"New Recurring Transfer"}>
 <form onSubmit={handleSubmit} noValidate className="space-y-4">
 <div>
 <label className="block text-xs font-medium mb-1">Description</label>
 <input
 type="text"
 value={form.description ??""}
 onChange={(e) => { set({ description: e.target.value }); setErrors((er) => ({ ...er, description: undefined })); }}
 placeholder="e.g. Monthly joint contribution"
 className={errors.description ? errCls : inputCls}
 />
 {errors.description && <p className="mt-1 text-xs text-down">{errors.description}</p>}
 </div>

 <div>
 <label className="block text-xs font-medium mb-1">Amount</label>
 <div className="relative">
 <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text"
 inputMode="decimal"
 placeholder="0.00"
 value={form.amount ??""}
 onChange={(e) => { set({ amount: e.target.value }); setErrors((er) => ({ ...er, amount: undefined })); }}
 className={`${errors.amount ? errCls : inputCls} pl-7`}
 />
 </div>
 {errors.amount && <p className="mt-1 text-xs text-down">{errors.amount}</p>}
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div>
 <label className="block text-xs font-medium mb-1">From</label>
 <div className="relative">
 <select
 value={form.fromAccountId ??""}
 onChange={(e) => { set({ fromAccountId: e.target.value }); setErrors((er) => ({ ...er, fromAccountId: undefined })); }}
 className="w-full appearance-none rounded-md border py-2 pl-2 pr-6 text-foreground"
 style={errors.fromAccountId ? { borderColor:"var(--color-down)" } : undefined}
 >
 <option value="">— Select account —</option>
 {bankAccounts.map((a) => (
 <option key={a.id} value={a.id}>{a.name}</option>
 ))}
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 {errors.fromAccountId && <p className="mt-1 text-xs text-down">{errors.fromAccountId}</p>}
 </div>
 <div>
 <label className="block text-xs font-medium mb-1">To</label>
 <div className="relative">
 <select
 value={form.toAccountId ??""}
 onChange={(e) => { set({ toAccountId: e.target.value }); setErrors((er) => ({ ...er, toAccountId: undefined })); }}
 className="w-full appearance-none rounded-md border py-2 pl-2 pr-6 text-foreground"
 style={errors.toAccountId ? { borderColor:"var(--color-down)" } : undefined}
 >
 <option value="">— Select account —</option>
 {bankAccounts.filter((a) => a.id !== form.fromAccountId).map((a) => (
 <option key={a.id} value={a.id}>{a.name}</option>
 ))}
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 {errors.toAccountId && <p className="mt-1 text-xs text-down">{errors.toAccountId}</p>}
 </div>
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div>
 <label className="block text-xs font-medium mb-1">Frequency</label>
 <div className="relative">
 <select
 value={form.frequency ??"MONTHLY"}
 onChange={(e) => set({ frequency: e.target.value as TransferRuleFormData["frequency"] })}
 className="w-full appearance-none rounded-md border border-border py-2 pl-2 pr-6 text-foreground"
 >
 <option value="DAILY">Daily</option>
 <option value="WEEKLY">Weekly</option>
 <option value="MONTHLY">Monthly</option>
 <option value="YEARLY">Yearly</option>
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 </div>
 <div>
 <label className="block text-xs font-medium mb-1">Every</label>
 <input
 type="text"
 inputMode="numeric"
 value={form.interval ?? 1}
 onChange={(e) => set({ interval: parseInt(e.target.value) || 1 })}
 className={inputCls}
 />
 </div>
 </div>

 <div className="grid grid-cols-2 gap-3">
 <div>
 <label className="block text-xs font-medium mb-1">Start Date</label>
 <DatePicker
 value={form.startDate ??""}
 onChange={(v) => { set({ startDate: v }); setErrors((er) => ({ ...er, startDate: undefined })); }}
 invalid={!!errors.startDate}
 className="w-full"
 />
 {errors.startDate && <p className="mt-1 text-xs text-down">{errors.startDate}</p>}
 </div>
 <div>
 <label className="block text-xs font-medium mb-1">
 End Date <span className="font-normal text-muted-foreground">(optional)</span>
 </label>
 <DatePicker
 value={form.endDate ??""}
 onChange={(v) => set({ endDate: v })}
 className="w-full"
 />
 </div>
 </div>

 <div className="flex justify-end gap-2 pt-2">
 <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
 <Button type="submit" disabled={saving}>{saving ?"Saving…" : rule ?"Save Changes" :"Create Transfer"}</Button>
 </div>
 </form>
 </Modal>
 );
}

// ── Main component ────────────────────────────────────────────────────────────

export function Recurring() {
 const [activeTab, setActiveTab] = useState<"expenses" |"transfers">("expenses");
 const [searchParams] = useSearchParams();
 const [highlightId, setHighlightId] = useState<string | null>(
 searchParams.get("highlight")
 );
 const [highlightFading, setHighlightFading] = useState(false);
 const highlightRowRef = useRef<HTMLTableRowElement | null>(null);

 // When the highlighted row mounts (after rules load), scroll it into view.
 // After 1.5 s begin the fade by removing the colour class (transition-colors
 // keeps the CSS transition running); after a further 1 s clean up state.
 const setHighlightRowRef = (el: HTMLTableRowElement | null) => {
 highlightRowRef.current = el;
 if (el) {
 el.scrollIntoView({ behavior:"smooth", block:"center" });
 const fadeTimer = setTimeout(() => setHighlightFading(true), 1500);
 const clearTimer = setTimeout(() => { setHighlightId(null); setHighlightFading(false); }, 2500);
 return () => { clearTimeout(fadeTimer); clearTimeout(clearTimer); };
 }
 };

 const { data: rules, refetch } = useApi(() => getRecurrenceRules(), []);
 const { data: accounts } = useApi<Account[]>(() => getAccounts({ includeHidden: true }), []);
 const { data: categories } = useApi<Category[]>(() => getFlatCategories(), []);
 const { data: upcomingExpenses } = useApi(() => getUpcomingRecurring(14), []);
 const { data: recurringHistory } = useApi(() => getRecurringHistory(6), []);

 // ── Transfer rules ──
 const { data: transferRules, refetch: refetchTransfers } = useApi<TransferRule[]>(() => getTransferRules(), []);
 const [transferModalOpen, setTransferModalOpen] = useState(false);
 const [editingTransferRule, setEditingTransferRule] = useState<TransferRule | null>(null);
 const [archiveTransferTarget, setArchiveTransferTarget] = useState<TransferRule | null>(null);
 const [transferActionLoading, setTransferActionLoading] = useState(false);

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
 // null = not yet loaded,"loading" = in flight, array = loaded
 const [linkedExpenses, setLinkedExpenses] = useState<LinkedExpense[] |"loading" | null>(null);

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
 description:"",
 amount:"",
 accountId:"",
 categoryId:"",
 group:"",
 endDate:"",
 });
 const [saving, setSaving] = useState(false);
 const [editError, setEditError] = useState<string | null>(null);

 // ── Lookup maps ──
 const accountMap = useMemo(
 () => new Map((accounts ?? []).map((a) => [a.id, a.name])),
 [accounts],
 );

 // Group active rules by their group field. Named groups sorted alphabetically;
 // ungrouped rules (group === null) collected under a null key at the end.
 const ruleGroups = useMemo(() => {
 if (!rules) return [];
 const map = new Map<string | null, RecurrenceRule[]>();
 for (const rule of rules) {
 const key = rule.group ?? null;
 if (!map.has(key)) map.set(key, []);
 map.get(key)!.push(rule);
 }
 const named = [...map.entries()]
 .filter(([k]) => k !== null)
 .sort(([a], [b]) => (a as string).localeCompare(b as string));
 const ungrouped = map.has(null) ? [[null, map.get(null)!] as [null, RecurrenceRule[]]] : [];
 return [...named, ...ungrouped];
 }, [rules]);


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

 // Switch from delete confirm → archive confirm (user clicked"Archive" in the delete modal)
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
 categoryId: rule.categoryId ??"",
 group: rule.group ??"",
 endDate: rule.endDate ? rule.endDate.slice(0, 10) :"",
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

 const todayStr = new Date().toLocaleDateString("en-CA");
 const endDateIsRetroactive = !!editForm.endDate && editForm.endDate < todayStr;

 const handleEditSave = async () => {
 if (!editTarget) return;
 const amountVal = parseAmount(editForm.amount);
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
 group: editForm.group.trim() || null,
 endDate: editForm.endDate || null,
 });
 setEditTarget(null);
 refetchAll();
 } catch (err) {
 setEditError(err instanceof Error ? err.message :"Failed to save.");
 } finally {
 setSaving(false);
 }
 };

 // ── Render ────────────────────────────────────────────────────────────────

 if (!rules) return <BeaconLoader />;

 return (
 <div className="space-y-6">
 <div>
 <h2 className="tp-page-title">Recurring</h2>
 </div>

 {/* ── Tab bar ── */}
 <div className="flex border-b border-border">
 {(["expenses","transfers"] as const).map((tab) => (
 <button
 key={tab}
 onClick={() => setActiveTab(tab)}
 className={`px-4 py-2 font-medium capitalize transition-colors border-b-2 -mb-px ${
 activeTab === tab
 ?"border-primary text-foreground"
 :"border-transparent text-muted-foreground hover:text-foreground"
 }`}
 >
 {tab}
 </button>
 ))}
 </div>

 {activeTab ==="expenses" && <>

 {/* ── Upcoming 14-day strip ── */}
 {upcomingExpenses && upcomingExpenses.length > 0 && (
 <div>
 <SectionLabel className="mb-2">
 Next 2 weeks
 </SectionLabel>
 <UpcomingStrip expenses={upcomingExpenses} />
 </div>
 )}

 {/* ── Table + charts side-by-side ── */}
 <div className="flex items-start gap-6">

 {/* Left: active table + ended section — 2/3 width */}
 <div className="min-w-0 basis-2/3 space-y-6">
 {rules && rules.length > 0 ? (
 <div className="space-y-6">
 {ruleGroups.map(([groupName, groupRules]) => (
 <div key={groupName ??"__ungrouped__"}>
 {groupName && (
 <p className="mb-2 tp-card-title">{groupName}</p>
 )}
 <Card>
 <RuleTable
 rules={groupRules}
 accountMap={accountMap}
 onEdit={handleEditOpen}
 onArchive={setArchiveTarget}
 highlightId={highlightId}
 highlightFading={highlightFading}
 highlightRowRef={setHighlightRowRef}
 />
 </Card>
 </div>
 ))}
 </div>
 ) : (
 <Card>
 <EmptyState
 icon={Repeat}
 title="No recurring expenses"
 description="Create a recurring expense by toggling'Recurring expense' when adding a new expense."
 />
 </Card>
 )}

 <div>
 <button
 onClick={() => setShowPast((v) => !v)}
 className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
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
 <p className="text-muted-foreground">Loading…</p>
 ) : pastRules.length === 0 ? (
 <p className="text-muted-foreground">No ended recurring transactions.</p>
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
 <AnnualCostPanel rules={rules} categories={categories ?? EMPTY_CATEGORIES} />
 </Card>
 {recurringHistory && recurringHistory.length > 0 && (
 <Card className="p-5">
 <YoYPanel history={recurringHistory} />
 </Card>
 )}
 </div>
 )}

 </div>

 </> /* end expenses tab */}

 {/* ── Transfers tab ── */}
 {activeTab ==="transfers" && (
 <div className="space-y-6">
 <div className="flex items-center justify-between">
 <p className="text-muted-foreground">
 Recurring transfers move funds between your bank accounts on a schedule.
 </p>
 <Button onClick={() => { setEditingTransferRule(null); setTransferModalOpen(true); }}>
 <Plus className="h-4 w-4" /> New Transfer
 </Button>
 </div>

 <Card>
 {transferRules && transferRules.length > 0 ? (
 <table className="w-full table-fixed text-13">
 <colgroup>
 <col />{/* Description */}
 <col className="w-[110px]" />{/* Frequency */}
 <col className="w-[80px]" />{/* Next */}
 <col className="w-[80px]" />{/* Started */}
 <col className="w-[28%]" />{/* From → To */}
 <col className="w-[88px]" />{/* Amount */}
 <col className="w-[72px]" />{/* Actions */}
 </colgroup>
 <thead>
 <tr className="border-b border-border">
 <ColumnHeader className="pb-2 text-left">Description</ColumnHeader>
 <ColumnHeader className="pb-2 text-left">Frequency</ColumnHeader>
 <ColumnHeader className="pb-2 text-left">Next</ColumnHeader>
 <ColumnHeader className="pb-2 text-left">Started</ColumnHeader>
 <ColumnHeader className="pb-2 text-left">From → To</ColumnHeader>
 <ColumnHeader className="pb-2 pr-3 text-right">Amount</ColumnHeader>
 <th className="pb-2" />
 </tr>
 </thead>
 <tbody className="divide-y divide-border">
 {transferRules.map((rule) => (
 <tr key={rule.id} className="hover:bg-muted transition-colors">
 <td className="py-3 pr-4 font-medium truncate">{rule.description}</td>
 <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
 {formatFrequency(rule.frequency, rule.interval)}
 </td>
 <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
 {formatDate(rule.nextTransferDate ?? rule.nextOccurrence)}
 </td>
 <td className="py-3 pr-4 whitespace-nowrap text-muted-foreground">
 {formatDate(rule.startDate)}
 </td>
 <td className="py-3 pr-4">
 <span className="flex items-center gap-1.5 tp-caption">
 <span className="truncate">{rule.fromAccount.name}</span>
 <ArrowRight className="h-3 w-3 shrink-0" />
 <span className="truncate">{rule.toAccount.name}</span>
 </span>
 </td>
 <td className="py-3 pr-3 text-right tp-numeric">
 {formatCurrency(parseFloat(rule.amount))}
 </td>
 <td className="py-3">
 <div className="flex items-center justify-end gap-1">
 <Tooltip content="Edit">
 <button
 onClick={() => { setEditingTransferRule(rule); setTransferModalOpen(true); }}
 className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted-hover transition-colors"
 >
 <Pencil className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
 <Tooltip content="Archive">
 <button
 onClick={() => setArchiveTransferTarget(rule)}
 className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted-hover transition-colors"
 >
 <Archive className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
 </div>
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 ) : (
 <EmptyState
 icon={Repeat}
 title="No recurring transfers"
 description="Set up automatic transfers between your bank accounts, like a monthly contribution to a joint account."
 action={
 <Button onClick={() => { setEditingTransferRule(null); setTransferModalOpen(true); }}>
 <Plus className="h-4 w-4" /> New Transfer
 </Button>
 }
 />
 )}
 </Card>
 </div>
 )}

 {/* ── Transfer create/edit modal ── */}
 {transferModalOpen && (
 <TransferRuleModal
 open={transferModalOpen}
 rule={editingTransferRule}
 accounts={(accounts ?? []).filter((a) => !a.isHidden)}
 onClose={() => { setTransferModalOpen(false); setEditingTransferRule(null); }}
 onSave={async (data) => {
 if (editingTransferRule) {
 await updateTransferRule(editingTransferRule.id, { ...data, amount: parseAmount(data.amount!) });
 } else {
 await createTransfer({
 description: data.description!,
 amount: parseAmount(data.amount!),
 date: data.startDate!,
 fromAccountId: data.fromAccountId!,
 toAccountId: data.toAccountId!,
 recurrence: {
 frequency: data.frequency!,
 interval: data.interval,
 endDate: data.endDate,
 },
 });
 }
 setTransferModalOpen(false);
 setEditingTransferRule(null);
 refetchTransfers();
 }}
 />
 )}

 {/* ── Archive transfer confirmation ── */}
 <ConfirmModal
 open={!!archiveTransferTarget}
 title="Archive recurring transfer?"
 actions={
 <>
 <Button
 variant="secondary" className="flex-1"
 onClick={() => setArchiveTransferTarget(null)}
 disabled={transferActionLoading}
 >
 Cancel
 </Button>
 <button
 onClick={async () => {
 if (!archiveTransferTarget) return;
 setTransferActionLoading(true);
 await archiveTransferRule(archiveTransferTarget.id);
 setArchiveTransferTarget(null);
 setTransferActionLoading(false);
 refetchTransfers();
 }}
 disabled={transferActionLoading}
 className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
 >
 <Archive className="h-3.5 w-3.5" />
 {transferActionLoading ?"Archiving…" :"Confirm Archive"}
 </button>
 </>
 }
 >
 <p>
 This will stop generating future transfers for{""}
 <span className="font-medium text-foreground">"{archiveTransferTarget?.description}"</span>.
 Past confirmed transfers will not be affected.
 </p>
 </ConfirmModal>

 {/* ── Archive confirmation modal ── */}
 <ConfirmModal
 open={!!archiveTarget}
 title="Archive recurring transaction?"
 actions={
 <>
 <Button
 variant="secondary" className="flex-1"
 onClick={() => setArchiveTarget(null)}
 disabled={actionLoading}
 >
 Cancel
 </Button>
 <button
 onClick={handleArchiveConfirm}
 disabled={actionLoading}
 className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
 >
 <Archive className="h-3.5 w-3.5" />
 {actionLoading ?"Archiving…" :"Confirm Archive"}
 </button>
 </>
 }
 >
 <p>
 This will end{""}
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
 <Button
 variant="secondary" className="flex-1"
 onClick={() => setDeleteTarget(null)}
 disabled={actionLoading}
 >
 Cancel
 </Button>
 <button
 onClick={handleSwitchToArchive}
 disabled={actionLoading}
 className="flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 font-medium hover:bg-muted transition-colors disabled:opacity-50"
 >
 <Archive className="h-3.5 w-3.5" />
 Archive
 </button>
 <button
 onClick={handleDeleteConfirm}
 disabled={actionLoading || linkedExpenses ==="loading"}
 className="flex items-center justify-center gap-1.5 rounded-md bg-down/10 px-3 py-2 text-13 font-normal text-down hover:bg-down/20 transition-colors disabled:opacity-50"
 >
 <Trash2 className="h-3.5 w-3.5" />
 {actionLoading ?"Deleting…" :"Confirm Delete"}
 </button>
 </>
 }
 >
 <p>
 This <em>permanently</em> removes the recurring transaction for{""}
 <span className="font-medium text-foreground">"{deleteTarget?.description}"</span>.
 To gracefully end a series instead, use <em>Archive</em>.
 </p>

 {/* Linked transaction summary */}
 <div className="mt-3">
 {linkedExpenses ==="loading" ? (
 <p className="tp-caption italic">Loading linked transactions…</p>
 ) : totalLinked === 0 ? (
 <p className="rounded-md bg-muted px-3 py-2 text-xs">
 No transactions are linked to this recurring transaction — deleting it will not affect any expenses.
 </p>
 ) : (
 <div className="space-y-3">
 {pastExpenses.length > 0 && (
 <div>
 <p className="mb-1.5 text-xs font-medium text-foreground">
 Past transactions ({pastExpenses.length}) —{""}
 <span className="font-normal">will be preserved as standalone expenses</span>
 </p>
 <div className="max-h-36 overflow-y-auto rounded-md border border-border divide-y divide-border text-xs">
 {pastExpenses.map((e) => (
 <div key={e.id} className="flex items-center gap-3 px-3 py-1.5">
 <span className="w-16 shrink-0 text-muted-foreground">{formatDate(e.date)}</span>
 <span className="flex-1 truncate">{e.description}</span>
 <span className="w-24 shrink-0 truncate text-muted-foreground">{e.account.name}</span>
 <span className={`shrink-0 font-medium${parseFloat(e.amount) < 0 ?" text-up" :""}`}>{displayAmount(e.amount)}</span>
 </div>
 ))}
 </div>
 </div>
 )}
 {futureExpenses.length > 0 && (
 <div>
 <p className="mb-1.5 text-xs font-medium text-foreground">
 Upcoming instances ({futureExpenses.length}) —{""}
 <span className="font-normal">will be permanently deleted</span>
 </p>
 <div className="max-h-36 overflow-y-auto rounded-md border border-border divide-y divide-border text-xs">
 {futureExpenses.map((e) => (
 <div key={e.id} className="flex items-center gap-3 px-3 py-1.5">
 <span className="w-16 shrink-0 text-muted-foreground">{formatDate(e.date)}</span>
 <span className="flex-1 truncate">{e.description}</span>
 <span className="w-24 shrink-0 truncate text-muted-foreground">{e.account.name}</span>
 <span className={`shrink-0 font-medium${parseFloat(e.amount) < 0 ?" text-up" :""}`}>{displayAmount(e.amount)}</span>
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
 <label className="block text-xs font-medium mb-1">Description</label>
 <input
 type="text"
 value={editForm.description}
 onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
 className="w-full rounded-md border border-border px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>

 {/* Amount */}
 <div>
 <label className="block text-xs font-medium mb-1">Amount</label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text"
 inputMode="text"
 value={editForm.amount}
 onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
 className="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 </div>

 {/* Account */}
 <div>
 <label className="block text-xs font-medium mb-1">Account</label>
 <ItemTypeahead
 name="accountId"
 defaultValue={editForm.accountId}
 items={(accounts ?? []).map((a) => ({ id: a.id, name: a.name, isHidden: a.isHidden }))}
 placeholder="Select account"
 onChange={(id) => setEditForm((f) => ({ ...f, accountId: id }))}
 />
 </div>

 {/* Category */}
 <div>
 <label className="block text-xs font-medium mb-1">Category</label>
 <CategoryTypeahead
 name="categoryId"
 defaultValue={editForm.categoryId}
 categories={categories ?? []}
 onChange={(id) => setEditForm((f) => ({ ...f, categoryId: id }))}
 />
 </div>

 {/* Group */}
 <div>
 <label className="block text-xs font-medium mb-1">
 Group{""}
 <span className="font-normal text-muted-foreground">(optional)</span>
 </label>
 <input
 type="text"
 value={editForm.group}
 onChange={(e) => setEditForm((f) => ({ ...f, group: e.target.value }))}
 placeholder="e.g. Subscriptions, Loans"
 className="w-full rounded-md border border-border px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>

 {/* End date */}
 <div>
 <label className="block text-xs font-medium mb-1">
 End date{""}
 <span className="font-normal text-muted-foreground">(optional)</span>
 </label>
 <DatePicker
 value={editForm.endDate}
 onChange={(v) => setEditForm((f) => ({ ...f, endDate: v }))}
 className="w-full"
 />
 {endDateIsRetroactive && (
 <p className="mt-1.5 rounded-md bg-warn-soft px-3 py-2 text-xs text-warn-deep">
 This end date is in the past. Any recorded expenses in this series after{""}
 <span className="font-medium">{editForm.endDate}</span> will be permanently
 deleted.
 </p>
 )}
 </div>

 {editError && <p className="text-xs text-down">{editError}</p>}

 {/* Footer: Delete (left) · Cancel + Save (right) */}
 <div className="flex items-center justify-between gap-2 pt-1">
 <button
 type="button"
 onClick={handleEditDeleteClick}
 disabled={saving}
 className="flex items-center gap-1.5 rounded-md px-3 py-2 text-13 font-normal text-down hover:bg-down/10 transition-colors disabled:opacity-50"
 >
 <Trash2 className="h-3.5 w-3.5" />
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
 {saving ?"Saving…" :"Save Changes"}
 </Button>
 </div>
 </div>
 </div>
 </Modal>
 </div>
 );
}
