import React, { useState, useMemo, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
} from "recharts";
import {
  TrendingDown,
  TrendingUp,
  CreditCard,
  ArrowDownLeft,
  ArrowUpRight,
  Sparkles,
  Pencil,
  Check,
  X,
  List,
  PlusCircle,
  AlertTriangle,
  Trash2,
  Wallet,
  Landmark,
  SquareCheckBig,
  Info,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { DatePicker } from "@/components/DatePicker";
import { useApi } from "@/hooks/useApi";
import { ToastContainer, useToast } from "@/components/Toast";
import {
  getCashFlow,
  upsertStatementOverride,
  createBalanceAdjustment,
  updateBalanceAdjustment,
  deleteBalanceAdjustment,
  getInvestmentAccounts,
  updateAccount,
  getExpenses,
  confirmTransfer,
  updateTransfer,
  deleteTransfer,
} from "@/api";
import { formatCurrency, cn } from "@/lib/utils";
import type { CashFlowProjection, CashFlowEvent, DailyBalance, InvestmentAccountSummary, Expense } from "@/types";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel, ColumnHeader, StatValue, DisplayStat } from "@/components/Typography";

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fmtShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
  });
}

// ── Event type metadata ───────────────────────────────────────────────────────

function eventIcon(type: CashFlowEvent["type"]) {
  switch (type) {
    case "EXPENSE":            return <TrendingDown className="h-3.5 w-3.5" />;
    case "CC_CHARGE":          return <CreditCard className="h-3.5 w-3.5" />;
    case "CC_PAYMENT":         return <CreditCard className="h-3.5 w-3.5" />;
    case "TRANSFER_IN":        return <ArrowDownLeft className="h-3.5 w-3.5" />;
    case "TRANSFER_OUT":       return <ArrowUpRight className="h-3.5 w-3.5" />;
    case "DIVIDEND":           return <Sparkles className="h-3.5 w-3.5" />;
    case "INCOME":             return <TrendingUp className="h-3.5 w-3.5" />;
    case "BALANCE_ADJUSTMENT": return <Wallet className="h-3.5 w-3.5" />;
  }
}

// ── Balance chart ─────────────────────────────────────────────────────────────

function BalanceTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-background shadow-md px-3 py-2 text-xs space-y-0.5">
      <p className="font-semibold text-foreground">{fmtDate(label as string)}</p>
      <p className="text-muted-foreground">Balance: <StatValue className="text-foreground font-medium">{formatCurrency(payload[0].value ?? 0)}</StatValue></p>
    </div>
  );
}

interface BalanceChartProps {
  data: DailyBalance[];
}

function BalanceChart({ data }: BalanceChartProps) {
  const chartData = data;

  const minVal = Math.min(...chartData.map((d) => d.balance));
  const maxVal = Math.max(...chartData.map((d) => d.balance));
  const hasNegative = minVal < 0;

  // Position of the zero line within the gradient (0% = top = maxVal, 100% = bottom = minVal).
  // Recharts auto-pads the domain slightly, so we add the same proportional buffer to keep
  // the gradient split visually aligned with the zero reference line.
  const zeroGradientPct = useMemo(() => {
    if (!hasNegative) return "100%";
    if (maxVal <= 0) return "0%";
    const span = maxVal - minVal;
    return `${((maxVal / span) * 100).toFixed(2)}%`;
  }, [hasNegative, minVal, maxVal]);

  const tickInterval = Math.ceil(chartData.length / 6);

  const tickFormatter = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
  };

  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
            <stop offset={zeroGradientPct} stopColor="#3b82f6" stopOpacity={0.05} />
            {hasNegative && (
              <>
                <stop offset={zeroGradientPct} stopColor="var(--color-down)" stopOpacity={0.05} />
                <stop offset="100%" stopColor="var(--color-down)" stopOpacity={0.25} />
              </>
            )}
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={fmtShort}
          interval={tickInterval - 1}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickFormatter={tickFormatter}
          tickCount={5}
          width={52}
        />
        <RechartsTooltip content={<BalanceTooltip />} />
        {hasNegative && (
          <ReferenceLine y={0} stroke="var(--color-down)" strokeDasharray="4 2" strokeWidth={1.5} />
        )}
        <Area
          type="monotone"
          dataKey="balance"
          stroke="var(--color-chart-axis)"
          strokeWidth={1.5}
          fill="url(#balGrad)"
          dot={false}
          activeDot={{ r: 3 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Statement override inline edit ────────────────────────────────────────────
// Renders as a <> fragment of two adjacent <td> cells:
//   1. Amount cell  — plain amount (editing: text input)
//   2. Edit cell    — always-visible pencil (editing: confirm / clear / cancel)

interface CCPaymentCellsProps {
  event: CashFlowEvent;
  accountId: string;
  onSaved: () => void;
  amountClassName: string;
  onDetailClick?: (rowMidY: number) => void;
  isDetailOpen?: boolean;
}

function CCPaymentCells({ event, accountId, onSaved, amountClassName, onDetailClick, isDetailOpen }: CCPaymentCellsProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(Math.abs(event.amount).toFixed(2));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!event.periodStart || !event.periodEnd) return;
    setSaving(true);
    try {
      await upsertStatementOverride({
        accountId,
        periodStart: event.periodStart,
        periodEnd: event.periodEnd,
        amount: parseFloat(value),
      });
      onSaved();
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <>
        {/* Amount cell */}
        <td className={cn("py-2 pr-2 text-right tabular-nums font-mono font-medium", amountClassName)}>
          {event.amount > 0 ? "+" : event.amount === 0 ? "-" : ""}
          {formatCurrency(event.amount)}
        </td>
        {/* Edit cell */}
        <td className="py-2 pr-4 w-14">
          <div className="flex items-center gap-1">
            <button
              onClick={() => { setValue(Math.abs(event.amount).toFixed(2)); setOpen(true); }}
              className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"
              title="Override statement amount"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            {onDetailClick && (
              <button
                onClick={(e) => {
                  const rect = (e.currentTarget.closest("tr") as HTMLElement).getBoundingClientRect();
                  onDetailClick(rect.top + rect.height / 2);
                }}
                className={cn(
                  "rounded p-1.5 hover:bg-accent transition-colors",
                  isDetailOpen ? "text-primary" : "text-muted-foreground/40 hover:text-muted-foreground",
                )}
                title="View statement transactions"
              >
                <List className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </td>
      </>
    );
  }

  return (
    <>
      {/* Amount cell — becomes inline input when editing */}
      <td className="py-2 pr-2 text-right">
        <span className="inline-flex items-center justify-end gap-1">
          <span className="tp-caption">$</span>
          <input
            type="text"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24 rounded border border-border bg-background px-1.5 py-0.5 text-xs tabular-nums font-mono text-right focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setOpen(false); }}
          />
        </span>
      </td>
      {/* Edit cell — confirm / clear-override / cancel */}
      <td className="py-2 pr-4 w-14">
        <div className="flex items-center gap-1">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded p-0.5 hover:bg-accent text-up"
            title="Save"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded p-0.5 hover:bg-accent text-muted-foreground"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </>
  );
}

// ── New adjustment row (add cash injection) ───────────────────────────────────

interface NewAdjustmentRowProps {
  defaultDate: string;
  accountId: string;
  onSaved: () => void;
  variant?: "warning" | "neutral";
}

function NewAdjustmentRow({ defaultDate, accountId, onSaved, variant = "warning" }: NewAdjustmentRowProps) {
  const today = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(defaultDate);
  const [description, setDescription] = useState("Cash injection");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    setSaving(true);
    try {
      await createBalanceAdjustment({ accountId, date, amount: amt, description });
      onSaved();
      setOpen(false);
      setAmount("");
      setDescription("Cash injection");
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <tr className={cn("border-b border-dashed", variant === "warning" ? "border-down-line" : "border-border")}>
        <td colSpan={5} className="py-1.5 pl-4">
          <button
            onClick={() => { setDate(defaultDate); setOpen(true); }}
            className={cn(
              "flex items-center gap-1.5 tp-caption transition-colors",
              variant === "warning" ? "hover:text-down" : "hover:text-foreground",
            )}
          >
            <PlusCircle className="h-3.5 w-3.5" />
            Add cash injection
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className={cn("border-b border-dashed", variant === "warning" ? "border-down-line bg-down-soft/50" : "border-border bg-muted/20")}>
      <td className="py-2 pl-4 pr-4">
        <DatePicker
          compact
          value={date}
          min={today}
          onChange={setDate}
        />
      </td>
      <td className="py-2 pr-4">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="w-full rounded border border-border bg-background px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </td>
      <td className="py-2 pr-2 text-right">
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          autoFocus
          className="w-28 rounded border border-border bg-background px-2 py-0.5 text-xs tabular-nums font-mono text-right focus:outline-none focus:ring-1 focus:ring-primary"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") setOpen(false);
          }}
        />
      </td>
      <td className="py-2 pr-4 w-14" colSpan={2}>
        <div className="flex items-center gap-1">
          <button
            onClick={handleSave}
            disabled={saving || !amount || parseFloat(amount) <= 0}
            className="rounded p-0.5 hover:bg-accent text-up disabled:opacity-40"
            title="Save"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded p-0.5 hover:bg-accent text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Existing adjustment row (edit / delete) ───────────────────────────────────

interface AdjustmentEventRowProps {
  event: CashFlowEvent;
  onSaved: () => void;
}

function AdjustmentEventRow({ event, onSaved }: AdjustmentEventRowProps) {
  const today = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(event.date);
  const [description, setDescription] = useState(event.description);
  const [amount, setAmount] = useState(Math.abs(event.amount).toFixed(2));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!event.adjustmentId) return;
    setSaving(true);
    try {
      await updateBalanceAdjustment(event.adjustmentId, {
        date,
        amount: parseFloat(amount),
        description,
      });
      onSaved();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!event.adjustmentId) return;
    setSaving(true);
    try {
      await deleteBalanceAdjustment(event.adjustmentId);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <tr className="group border-b border-border/50 bg-warn-soft/50 hover:bg-warn-soft transition-colors last:border-b-0">
        <td className="py-2 pl-4 pr-4 tp-fineprint whitespace-nowrap">{fmtDate(event.date)}</td>
        <td className="py-2 pr-4">
          <div className="flex items-center gap-2">
            <span className="text-up shrink-0">{eventIcon(event.type)}</span>
            <span className="font-medium">{event.description}</span>
          </div>
        </td>
        <td className="py-2 pr-2 text-right tabular-nums font-mono font-medium text-up">
          +{formatCurrency(event.amount)}
        </td>
        <td className="py-2 pr-4">
          <div className="flex items-center gap-1 h-[26px]">
            <button
              onClick={() => setEditing(true)}
              className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={handleDelete}
              disabled={saving}
              className="rounded p-1.5 text-muted-foreground/40 hover:text-down hover:bg-down/10 transition-colors disabled:opacity-40"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </td>
        <td className={cn(
          "py-2 pr-4 text-right tabular-nums font-mono font-semibold",
          event.runningBalance < 0 ? "text-down" : "text-foreground",
        )}>
          {formatCurrency(event.runningBalance)}
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-border/50 bg-warn-soft last:border-b-0">
      <td className="py-2 pl-4 pr-4">
        <DatePicker
          compact
          value={date}
          min={today}
          onChange={setDate}
        />
      </td>
      <td className="py-2 pr-4">
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoFocus
          className="w-full rounded border border-border bg-background px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
        />
      </td>
      <td className="py-2 pr-2 text-right">
        <span className="inline-flex items-center justify-end gap-1">
          <span className="tp-caption">$</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-24 rounded border border-border bg-background px-1.5 py-0.5 text-xs tabular-nums font-mono text-right focus:outline-none focus:ring-1 focus:ring-primary"
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setEditing(false); }}
          />
        </span>
      </td>
      <td className="py-2 pr-4 w-14">
        <div className="flex items-center gap-1">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded p-0.5 hover:bg-accent text-up disabled:opacity-40"
            title="Save"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setEditing(false)}
            className="rounded p-0.5 hover:bg-accent text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
      <td className={cn(
        "py-2 pr-4 text-right tabular-nums font-mono font-semibold",
        event.runningBalance < 0 ? "text-down" : "text-foreground",
      )}>
        {formatCurrency(event.runningBalance)}
      </td>
    </tr>
  );
}

// ── Statement detail panel ────────────────────────────────────────────────────

interface StatementDetailPanelProps {
  event: CashFlowEvent;
  rowMidY: number;
  onClose: () => void;
}

function StatementDetailPanel({ event, rowMidY, onClose }: StatementDetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [notchTop, setNotchTop] = useState(24);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!event.statementPeriodStart || !event.periodStart || !event.relatedAccountId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    getExpenses({
      accountId: event.relatedAccountId,
      startDate: event.statementPeriodStart,
      endDate: event.periodStart,
      limit: "200",
      sortBy: "date",
      sortOrder: "asc",
    })
      .then((res) => setExpenses(res.data))
      .catch(() => setExpenses([]))
      .finally(() => setLoading(false));
  }, [event.id, event.statementPeriodStart, event.periodStart, event.relatedAccountId]);

  const measureNotch = () => {
    if (!panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    const offset = rowMidY - rect.top;
    setNotchTop(Math.max(12, Math.min(offset, rect.height - 12)));
  };

  useLayoutEffect(measureNotch, [rowMidY]);
  useEffect(measureNotch, [loading, rowMidY]);

  return (
    <div ref={panelRef} className="relative mt-4">
      {/* Arrow notch - border */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: -12,
          top: notchTop - 8,
          width: 0,
          height: 0,
          borderTop: "8px solid transparent",
          borderBottom: "8px solid transparent",
          borderRight: "12px solid hsl(var(--border))",
          zIndex: 10,
        }}
      />
      {/* Arrow notch - fill */}
      <div
        className="absolute pointer-events-none"
        style={{
          left: -10,
          top: notchTop - 8,
          width: 0,
          height: 0,
          borderTop: "8px solid transparent",
          borderBottom: "8px solid transparent",
          borderRight: "11px solid hsl(var(--card))",
          zIndex: 11,
        }}
      />

      <Card className="p-3 overflow-hidden">
        <div className="flex items-center justify-between mb-2.5">
          <SectionLabel as="div">
            {event.relatedAccountName}
            {event.statementPeriodStart && event.periodStart && (
              <span className="font-normal normal-case ml-1">
                · {fmtShort(event.statementPeriodStart)} – {fmtShort(event.periodStart)}
              </span>
            )}
          </SectionLabel>
          <button
            onClick={onClose}
            className="rounded p-0.5 hover:bg-accent text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {loading ? (
          <p className="py-3 text-center tp-caption">Loading…</p>
        ) : expenses.length === 0 ? (
          <p className="py-3 text-center tp-caption">No transactions found</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <ColumnHeader className="pb-1.5 pr-3 text-left whitespace-nowrap">Date</ColumnHeader>
                <ColumnHeader className="pb-1.5 pr-2 text-left">Vendor</ColumnHeader>
                <ColumnHeader className="pb-1.5 text-right">Amount</ColumnHeader>
              </tr>
            </thead>
            <tbody>
              {expenses.map((exp) => (
                <tr key={exp.id} className="border-b border-border/40">
                  <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">
                    {fmtShort(exp.date.slice(0, 10))}
                  </td>
                  <td className="py-1.5 pr-2 max-w-[90px] truncate">{exp.vendor}</td>
                  <td className="py-1.5 text-right tabular-nums font-mono text-down">
                    {formatCurrency(Math.abs(parseFloat(exp.amount)))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ── Events ledger ─────────────────────────────────────────────────────────────

interface LedgerProps {
  events: CashFlowEvent[];
  accountId: string;
  onRefetch: () => void;
  selectedCCPaymentId?: string | null;
  onCCPaymentClick?: (event: CashFlowEvent, rowMidY: number) => void;
  onEditTransfer?: (event: CashFlowEvent) => void;
  pendingDeleteTransferIds?: Set<string>;
}

function EventsLedger({ events: rawEvents, accountId, onRefetch, selectedCCPaymentId, onCCPaymentClick, onEditTransfer, pendingDeleteTransferIds }: LedgerProps) {
  const events = pendingDeleteTransferIds?.size
    ? rawEvents.filter((e) => !e.transferId || !pendingDeleteTransferIds.has(e.transferId))
    : rawEvents;
  const firstNegativeIdx = events.findIndex((e) => e.runningBalance < 0);

  if (events.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No projected events in this window.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden bg-[rgba(255,255,255,0.55)]">
      <div className="overflow-x-auto">
        <table className="w-full text-13">
          <thead>
            <tr className="border-b border-border bg-[rgba(15,22,48,0.03)]">
              <ColumnHeader className="py-2 pl-4 pr-4 text-left w-24">Date</ColumnHeader>
              <ColumnHeader className="py-2 pr-4 text-left">Description</ColumnHeader>
              <ColumnHeader className="py-2 pr-2 text-right w-24">Amount</ColumnHeader>
              <th className="py-2 pr-4 w-14" />
              <ColumnHeader className="py-2 pr-4 text-right w-24">Balance</ColumnHeader>
            </tr>
          </thead>
          <tbody>
            {events.map((event, idx) => (
              <React.Fragment key={`event-${event.id}`}>
                {idx === firstNegativeIdx && firstNegativeIdx !== -1 && (
                  <NewAdjustmentRow
                    defaultDate={event.date}
                    accountId={accountId}
                    onSaved={onRefetch}
                  />
                )}
                {event.type === "BALANCE_ADJUSTMENT" ? (
                  <AdjustmentEventRow event={event} onSaved={onRefetch} />
                ) : (
                  <tr className="group border-b border-border/50 hover:bg-muted/30 transition-colors last:border-b-0">
                    <td className="py-2 pl-4 pr-4 tp-fineprint whitespace-nowrap">{fmtDate(event.date)}</td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-2">
                        <span className={cn("shrink-0", event.amount > 0 ? "text-up" : "text-down")}>
                          {eventIcon(event.type)}
                        </span>
                        <span className="font-medium">{event.description}</span>
                        {event.relatedAccountName && event.type !== "CC_CHARGE" && (
                          <span className="tp-caption">
                            {event.type === "TRANSFER_IN" ? "from" : event.type === "TRANSFER_OUT" ? "to" : "·"}{" "}
                            {event.relatedAccountName}
                          </span>
                        )}
                        {event.confidence === "KNOWN" && event.type !== "CC_PAYMENT" && (
                          <SectionLabel as="span" className="rounded-full bg-up-soft text-up-deep px-1.5 py-0.5 text-10">
                            Confirmed
                          </SectionLabel>
                        )}
                        {event.type === "CC_PAYMENT" && !event.overrideId && (
                          <SectionLabel as="span" className="rounded-full bg-border px-1.5 py-0.5 text-10">
                            Estimated
                          </SectionLabel>
                        )}
                        {event.overrideId && (
                          <SectionLabel as="span" className="rounded-full bg-up-soft text-up-deep px-1.5 py-0.5 text-10">
                            Confirmed
                          </SectionLabel>
                        )}
                      </div>
                    </td>
                    {event.type === "CC_PAYMENT" ? (
                      <CCPaymentCells
                        event={event}
                        accountId={event.relatedAccountId ?? accountId}
                        onSaved={onRefetch}
                        amountClassName={event.amount > 0 ? "text-up" : "text-down"}
                        onDetailClick={onCCPaymentClick ? (rowMidY) => onCCPaymentClick(event, rowMidY) : undefined}
                        isDetailOpen={event.id === selectedCCPaymentId}
                      />
                    ) : (
                      <>
                        <td className={cn(
                          "py-2 pr-2 text-right tabular-nums font-mono font-medium",
                          event.amount > 0 ? "text-up" : "text-down",
                        )}>
                          {event.amount > 0 ? "+" : event.amount === 0 ? "-" : ""}
                          {formatCurrency(event.amount)}
                        </td>
                        <td className="py-2 pr-4 w-14">
                          <div className="flex items-center gap-1 h-[26px]">
                            {(event.type === "TRANSFER_IN" || event.type === "TRANSFER_OUT") &&
                              event.transferId && (
                              <>
                                <button
                                  onClick={() => onEditTransfer?.(event)}
                                  className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"
                                  title="Edit transfer"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                {event.confidence === "PROJECTED" && (
                                  <button
                                    onClick={async () => { await confirmTransfer(event.transferId!); onRefetch(); }}
                                    className="rounded p-1.5 text-muted-foreground/40 hover:text-up hover:bg-accent transition-colors"
                                    title="Confirm transfer"
                                  >
                                    <SquareCheckBig className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                    <td className={cn(
                      "py-2 pr-4 text-right tabular-nums font-mono font-semibold",
                      event.runningBalance < 0 ? "text-down" : "text-foreground",
                    )}>
                      {formatCurrency(event.runningBalance)}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {firstNegativeIdx === -1 && events.length > 0 && (
              <NewAdjustmentRow
                defaultDate={events[events.length - 1].date}
                accountId={accountId}
                onSaved={onRefetch}
                variant="neutral"
              />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Account panel ─────────────────────────────────────────────────────────────

interface AccountPanelProps {
  projection: CashFlowProjection;
  windowEnd: string;
  onRefetch: () => void;
  selectedCCPaymentId?: string | null;
  onCCPaymentClick?: (event: CashFlowEvent, rowMidY: number) => void;
  onEditTransfer?: (event: CashFlowEvent) => void;
  pendingDeleteTransferIds?: Set<string>;
}

function AccountPanel({ projection, windowEnd, onRefetch, selectedCCPaymentId, onCCPaymentClick, onEditTransfer, pendingDeleteTransferIds }: AccountPanelProps) {
  const firstNegativeEntry = projection.dailyBalances.find((d) => d.balance < 0);
  const firstNegativeDate = firstNegativeEntry?.date;
  const shortfall = firstNegativeEntry ? Math.abs(firstNegativeEntry.balance) : 0;

  return (
    <div className="space-y-4">
      {/* Balance summary row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div>
            <SectionLabel className="mb-0.5">Today</SectionLabel>
            <DisplayStat as="p" className="tp-kpi-m">{formatCurrency(projection.startBalance)}</DisplayStat>
          </div>
          <div className="text-muted-foreground">→</div>
          <div>
            <SectionLabel className="mb-0.5">
              {fmtDate(windowEnd)}
            </SectionLabel>
            <DisplayStat as="p" className={cn("tp-kpi-m", projection.endBalance < 0 ? "text-down" : "text-foreground")}>
              {formatCurrency(projection.endBalance)}
            </DisplayStat>
          </div>
        </div>
        {firstNegativeDate && (
          <div className="flex items-center gap-1.5 text-sm text-down">
            <TrendingDown className="h-4 w-4 shrink-0" />
            <span>
              Projected shortfall of {formatCurrency(shortfall)} starting {fmtDate(firstNegativeDate)}
            </span>
          </div>
        )}
      </div>

      {/* Chart */}
      <Card className="p-3">
        <BalanceChart data={projection.dailyBalances} />
      </Card>

      {/* Events ledger */}
      <EventsLedger
        events={projection.events}
        accountId={projection.accountId}
        onRefetch={onRefetch}
        selectedCCPaymentId={selectedCCPaymentId}
        onCCPaymentClick={onCCPaymentClick}
        onEditTransfer={onEditTransfer}
        pendingDeleteTransferIds={pendingDeleteTransferIds}
      />
    </div>
  );
}

// ── Edit transfer instance modal ─────────────────────────────────────────────

interface EditTransferTarget {
  transferId: string;
  date: string;
  amount: number;
  description: string;
}

function EditTransferModal({
  target,
  onClose,
  onSaved,
  onDelete,
}: {
  target: EditTransferTarget | null;
  onClose: () => void;
  onSaved: () => void;
  onDelete: (transferId: string) => void;
}) {
  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target) {
      setDate(target.date);
      setAmount(Math.abs(target.amount).toFixed(2));
    }
  }, [target]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setSaving(true);
    try {
      await updateTransfer(target.transferId, {
        date,
        amount: parseFloat(amount.replace(/,/g, "")) || 0,
      });
      onClose();
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={!!target} onClose={onClose} title="Edit Transfer">
      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1">Description</label>
          <p className="text-sm text-muted-foreground">{target?.description}</p>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Date</label>
          <DatePicker
            value={date}
            onChange={setDate}
            className="w-full"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Amount</label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={() => { onClose(); onDelete(target!.transferId); }}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-down hover:bg-down/10 transition-colors disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ── Edit balance modal ────────────────────────────────────────────────────────

function EditBalanceModal({
  account,
  onClose,
  onSave,
}: {
  account: InvestmentAccountSummary | null;
  onClose: () => void;
  onSave: (id: string, balance: number) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) setValue(String(parseFloat(account.balance) || 0));
  }, [account]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setSaving(true);
    await onSave(account.id, parseFloat(value.replace(/,/g, "")) || 0);
    setSaving(false);
  };

  return (
    <Modal open={!!account} onClose={onClose} title="Edit Balance">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1">
            Current Balance — {account?.name}
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="text"
              inputMode="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {account?.balanceUpdatedAt && (
            <p className="mt-1 tp-caption">
              Last updated {(([y, m, d]) => new Date(+y, +m - 1, +d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))(account.balanceUpdatedAt.slice(0, 10).split("-"))}
            </p>
          )}
        </div>
        <div className="flex items-start gap-2 rounded-md bg-blue-soft px-3 py-2.5 text-xs text-blue-deep">
          <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <p>
            Confirmed transactions on or before this date are assumed to be
            reflected in the balance and will be excluded from the projection.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function CashFlow() {
  const { data, refetch } = useApi(() => getCashFlow(45), []);
  const { data: accounts, refetch: refetchAccounts } = useApi(() => getInvestmentAccounts(), []);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [editingBalance, setEditingBalance] = useState<InvestmentAccountSummary | null>(null);
  const [selectedCCPayment, setSelectedCCPayment] = useState<{ event: CashFlowEvent; rowMidY: number } | null>(null);
  const [editingTransfer, setEditingTransfer] = useState<EditTransferTarget | null>(null);
  const { toasts, addToast, dismissToast } = useToast();

  // Transfers awaiting optimistic deletion (hidden in UI; API call deferred 8 s)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const pendingDeleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => () => { pendingDeleteTimers.current.forEach(clearTimeout); }, []);

  const handleDeleteTransfer = useCallback((transferId: string) => {
    setPendingDeleteIds((prev) => new Set([...prev, transferId]));

    const timerId = setTimeout(async () => {
      await deleteTransfer(transferId);
      setPendingDeleteIds((prev) => { const s = new Set(prev); s.delete(transferId); return s; });
      pendingDeleteTimers.current.delete(transferId);
      refetch();
    }, 8000);

    pendingDeleteTimers.current.set(transferId, timerId);

    addToast({
      message: "Transfer deleted",
      onUndo: () => {
        clearTimeout(timerId);
        pendingDeleteTimers.current.delete(transferId);
        setPendingDeleteIds((prev) => { const s = new Set(prev); s.delete(transferId); return s; });
      },
      duration: 8000,
    });
  }, [addToast, refetch]);

  const handleEditTransfer = (event: CashFlowEvent) => {
    if (!event.transferId) return;
    setEditingTransfer({
      transferId: event.transferId,
      date: event.date,
      amount: event.amount,
      description: event.description,
    });
  };

  const handleCCPaymentClick = (event: CashFlowEvent, rowMidY: number) => {
    setSelectedCCPayment((prev) =>
      prev?.event.id === event.id ? null : { event, rowMidY }
    );
  };

  const bankingAccounts = (accounts ?? []).filter(
    (a) => a.type === "CHECKING" || a.type === "SAVINGS"
  );

  const handleSaveBalance = async (id: string, balance: number) => {
    // Send the user's local calendar date as midnight UTC so the Cash Flow
    // cutoff comparison uses the correct local date instead of the server's
    // UTC date, which can be a day ahead for users west of UTC in the evening.
    const d = new Date();
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await updateAccount(id, { balance: String(balance), balanceUpdatedAt: `${localDate}T00:00:00.000Z` });
    setEditingBalance(null);
    refetchAccounts();
    refetch();
  };

  const renderBankingTile = (account: InvestmentAccountSummary) => (
    <div key={account.id}>
      <Card className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className="h-8 w-8 flex-shrink-0 rounded-md flex items-center justify-center"
            style={account.color ? { backgroundColor: account.color } : { backgroundColor: "#e2e2df" }}
          >
            <Landmark className="h-4 w-4 text-ink-4" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="tp-row-label truncate">{account.name}</p>
            <p className="tp-caption">
              {account.type === "CHECKING" ? "Checking · Cash" : "Savings · Cash"}
            </p>
          </div>
          <div className="text-right flex-shrink-0 mr-2">
            <StatValue as="p" className="font-bold text-sm">
              {formatCurrency(account.totalMarketValue)}
            </StatValue>
          </div>
          <button
            onClick={() => setEditingBalance(account)}
            className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors flex-shrink-0"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      </Card>
    </div>
  );

  const projections = data?.projections ?? [];

  const personal = projections.filter((p) => !p.isJoint).sort((a, b) => b.startBalance - a.startBalance);
  const joint = projections.filter((p) => p.isJoint).sort((a, b) => b.startBalance - a.startBalance);
  const sortedProjections = [...personal, ...joint];

  const selectedId = activeTab ?? sortedProjections[0]?.accountId ?? null;
  const selectedProjection = projections.find((p) => p.accountId === selectedId) ?? null;

  function TabButton({ p }: { p: CashFlowProjection }) {
    const isActive = p.accountId === selectedId;
    const hasNegative = p.minBalance < 0;
    return (
      <button
        onClick={() => { setActiveTab(p.accountId); setSelectedCCPayment(null); }}
        className={cn(
          "flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
          isActive
            ? "border-primary text-foreground"
            : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
        )}
      >
        <span>{p.accountName}</span>
        {hasNegative && (
          <AlertTriangle className="h-3 w-3 text-down shrink-0" aria-label="Projected negative balance" />
        )}
      </button>
    );
  }

  if (!data) return <BeaconLoader />;

  if (projections.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="tp-page-title">Cash Flow</h2>
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No checking accounts found. Add accounts to see projections.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="tp-page-title">Cash Flow</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {fmtDate(data.windowStart)} – {fmtDate(data.windowEnd)} · {data.windowDays}-day projection
        </p>
      </div>

      <div className="flex flex-col lg:flex-row items-start gap-6">
        {/* Left 2/3: tab bar + account panel */}
        <div className="min-w-0 basis-2/3 w-full space-y-4">
          {/* Tab bar */}
          <div className="border-b border-border">
            <div className="flex items-center gap-0 overflow-x-auto">
              {personal.length > 0 && joint.length > 0 && (
                <SectionLabel as="span" className="mr-2 text-10 px-1">
                  Personal
                </SectionLabel>
              )}
              {personal.map((p) => <TabButton key={p.accountId} p={p} />)}
              {joint.length > 0 && (
                <>
                  <span className="mx-3 text-border">|</span>
                  <SectionLabel as="span" className="mr-2 text-10 px-1">
                    Joint
                  </SectionLabel>
                  {joint.map((p) => <TabButton key={p.accountId} p={p} />)}
                </>
              )}
            </div>
          </div>

          {selectedProjection && (
            <AccountPanel
              key={selectedProjection.accountId}
              projection={selectedProjection}
              windowEnd={data.windowEnd}
              onRefetch={refetch}
              selectedCCPaymentId={selectedCCPayment?.event.id}
              onCCPaymentClick={handleCCPaymentClick}
              onEditTransfer={handleEditTransfer}
              pendingDeleteTransferIds={pendingDeleteIds}
            />
          )}
        </div>

        {/* Right 1/3: banking accounts + statement detail */}
        {bankingAccounts.length > 0 && (
          <div className="min-w-0 basis-1/3 w-full space-y-2">
            <div className="flex items-center gap-2 py-1">
              <Landmark className="h-4 w-4 text-muted-foreground" />
              <SectionLabel as="span" className="text-sm">
                Banking (Cash)
              </SectionLabel>
            </div>
            <div className="space-y-1.5">
              {bankingAccounts.map(renderBankingTile)}
            </div>
            {selectedCCPayment && (
              <StatementDetailPanel
                event={selectedCCPayment.event}
                rowMidY={selectedCCPayment.rowMidY}
                onClose={() => setSelectedCCPayment(null)}
              />
            )}
          </div>
        )}
      </div>

      <EditTransferModal
        target={editingTransfer}
        onClose={() => setEditingTransfer(null)}
        onSaved={() => { refetch(); }}
        onDelete={handleDeleteTransfer}
      />
      <EditBalanceModal
        account={editingBalance}
        onClose={() => setEditingBalance(null)}
        onSave={handleSaveBalance}
      />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
