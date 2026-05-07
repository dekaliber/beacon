import { useState, useMemo, useEffect, useRef } from "react";
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
import { AlertTriangle, TrendingDown, Landmark, Pencil, Info, X, TrendingUp, CreditCard, ArrowDownLeft, ArrowUpRight, Sparkles, Wallet, PlusCircle, Trash2 } from "lucide-react";
import { Card } from "@/components/Card";
import { useApi } from "@/hooks/useApi";
import { getCashFlow, getInvestmentAccounts, updateAccount, createBalanceAdjustment, updateBalanceAdjustment, deleteBalanceAdjustment, upsertStatementOverride, getExpenses } from "@/api";
import { formatCurrency, cn } from "@/lib/utils";
import type { CashFlowProjection, CashFlowEvent, DailyBalance, InvestmentAccountSummary, Expense } from "@/types";

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fmtDateLong(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
  });
}

// ── Balance chart ─────────────────────────────────────────────────────────────

function BalanceTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-background shadow-md px-3 py-2 text-xs space-y-0.5">
      <p className="font-semibold text-foreground">{fmtDate(label as string)}</p>
      <p className="text-muted-foreground">Balance: <span className="text-foreground font-medium tabular-nums">{formatCurrency(payload[0].value ?? 0)}</span></p>
    </div>
  );
}

function BalanceChart({ data }: { data: DailyBalance[] }) {
  const minVal = Math.min(...data.map((d) => d.balance));
  const maxVal = Math.max(...data.map((d) => d.balance));
  const hasNegative = minVal < 0;

  const zeroGradientPct = useMemo(() => {
    if (!hasNegative) return "100%";
    if (maxVal <= 0) return "0%";
    const span = maxVal - minVal;
    return `${((maxVal / span) * 100).toFixed(2)}%`;
  }, [hasNegative, minVal, maxVal]);

  const tickInterval = Math.ceil(data.length / 6);

  const tickFormatter = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
  };

  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="balGradMobile" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
            <stop offset={zeroGradientPct} stopColor="#3b82f6" stopOpacity={0.05} />
            {hasNegative && (
              <>
                <stop offset={zeroGradientPct} stopColor="#ef4444" stopOpacity={0.05} />
                <stop offset="100%" stopColor="#ef4444" stopOpacity={0.25} />
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
          <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1.5} />
        )}
        <Area
          type="monotone"
          dataKey="balance"
          stroke="#94a3b8"
          strokeWidth={1.5}
          fill="url(#balGradMobile)"
          dot={false}
          activeDot={{ r: 3 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Edit balance bottom sheet ─────────────────────────────────────────────────

function EditBalanceSheet({
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (account) {
      setValue(String(parseFloat(account.balance) || 0));
      // Small delay so the sheet animation completes before focusing
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [account]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setSaving(true);
    await onSave(account.id, parseFloat(value.replace(/,/g, "")) || 0);
    setSaving(false);
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          account ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />
      {/* Sheet */}
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col rounded-t-2xl bg-background shadow-xl transition-transform duration-250 ease-out",
          account ? "translate-y-0" : "translate-y-full"
        )}
      >
        {/* Handle */}
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />

        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-border">
          <h2 className="text-base font-semibold">Edit Balance</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <form id="edit-balance-form" onSubmit={handleSubmit} className="px-4 pt-4 pb-2 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">
              Current Balance — {account?.name}
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <input
                ref={inputRef}
                type="text"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {account?.balanceUpdatedAt && (
              <p className="mt-1 text-xs text-muted-foreground">
                Last updated {fmtDateLong(account.balanceUpdatedAt.slice(0, 10))}
              </p>
            )}
          </div>

          <div className="flex items-start gap-2 rounded-md bg-blue-50 px-3 py-2.5 text-xs text-blue-800">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <p>
              Confirmed transactions on or before this date are assumed to be
              reflected in the balance and will be excluded from the projection.
            </p>
          </div>
        </form>

        {/* Footer buttons */}
        <div className="shrink-0 border-t border-border p-4">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="edit-balance-form"
              disabled={saving}
              className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Add cash injection bottom sheet ──────────────────────────────────────────

interface AddCashInjectionSheetProps {
  open: boolean;
  accountId: string | null;
  defaultDate: string;
  onClose: () => void;
  onSaved: () => void;
  editingEvent?: CashFlowEvent | null;
}

function AddCashInjectionSheet({ open, accountId, defaultDate, onClose, onSaved, editingEvent }: AddCashInjectionSheetProps) {
  const today = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const isEditing = !!editingEvent;
  const isOpen = open || isEditing;
  const [date, setDate] = useState(defaultDate);
  const [description, setDescription] = useState("Cash injection");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingEvent) {
      setDate(editingEvent.date);
      setDescription(editingEvent.description);
      setAmount(Math.abs(editingEvent.amount).toFixed(2));
      setConfirmDelete(false);
      setTimeout(() => amountRef.current?.focus(), 80);
    } else if (open) {
      setDate(defaultDate);
      setDescription("Cash injection");
      setAmount("");
      setConfirmDelete(false);
      setTimeout(() => amountRef.current?.focus(), 80);
    }
  }, [open, editingEvent?.id, defaultDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    setSaving(true);
    try {
      if (isEditing && editingEvent?.adjustmentId) {
        await updateBalanceAdjustment(editingEvent.adjustmentId, {
          date,
          amount: amt,
          description: description.trim() || "Cash injection",
        });
      } else {
        if (!accountId) return;
        await createBalanceAdjustment({ accountId, date, amount: amt, description: description.trim() || "Cash injection" });
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col rounded-t-2xl bg-background shadow-xl transition-transform duration-250 ease-out",
          isOpen ? "translate-y-0" : "translate-y-full"
        )}
      >
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />

        <div className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-border">
          <h2 className="text-base font-semibold">{isEditing ? "Edit Cash Injection" : "Add Cash Injection"}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form id="cash-injection-form" onSubmit={handleSubmit} className="px-4 pt-4 pb-2 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Date</label>
            <input
              type="date"
              value={date}
              min={today}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Cash injection"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Amount</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                ref={amountRef}
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        </form>

        <div className="shrink-0 border-t border-border p-4">
          <div className="flex gap-3">
            {isEditing && (
              confirmDelete ? (
                <button
                  type="button"
                  disabled={deleting}
                  onClick={async () => {
                    if (!editingEvent?.adjustmentId) return;
                    setDeleting(true);
                    try {
                      await deleteBalanceAdjustment(editingEvent.adjustmentId);
                      onSaved();
                      onClose();
                    } finally {
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
                  aria-label="Delete cash injection"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => { onClose(); setConfirmDelete(false); }}
              disabled={saving}
              className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="cash-injection-form"
              disabled={saving || !amount || parseFloat(amount) <= 0}
              className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── CC payment bottom sheet ───────────────────────────────────────────────────

function CCPaymentSheet({
  event,
  onClose,
  onSaved,
}: {
  event: CashFlowEvent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loadingExpenses, setLoadingExpenses] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!event) return;
    setValue(Math.abs(event.amount).toFixed(2));
    setTimeout(() => inputRef.current?.focus(), 80);

    if (!event.statementPeriodStart || !event.periodStart || !event.relatedAccountId) {
      setExpenses([]);
      return;
    }
    setLoadingExpenses(true);
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
      .finally(() => setLoadingExpenses(false));
  }, [event?.id]);

  const handleConfirm = async () => {
    if (!event?.periodStart || !event?.periodEnd) return;
    setSaving(true);
    try {
      await upsertStatementOverride({
        accountId: event.relatedAccountId ?? "",
        periodStart: event.periodStart,
        periodEnd: event.periodEnd,
        amount: parseFloat(value),
      });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const isConfirmed = !!event?.overrideId;
  const periodLabel =
    event?.statementPeriodStart && event?.periodStart
      ? `${fmtDate(event.statementPeriodStart)} – ${fmtDate(event.periodStart)}`
      : null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          event ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />
      {/* Sheet */}
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col rounded-t-2xl bg-background shadow-xl transition-transform duration-250 ease-out max-h-[85vh]",
          event ? "translate-y-0" : "translate-y-full"
        )}
      >
        {/* Handle */}
        <div className="mx-auto mt-3 mb-4 h-1 w-10 rounded-full bg-muted-foreground/30 shrink-0" />

        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">{event?.description ?? "CC Payment"}</h2>
            {periodLabel && (
              <p className="text-xs text-muted-foreground mt-0.5">Statement period: {periodLabel}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-muted-foreground hover:bg-accent"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 pt-4 pb-2 space-y-5">
          {/* Amount field */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium">Payment Amount</label>
              {isConfirmed ? (
                <span className="rounded-full bg-green-100 text-green-700 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                  Confirmed
                </span>
              ) : (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                  Estimated
                </span>
              )}
            </div>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                $
              </span>
              <input
                ref={inputRef}
                type="text"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Statement transactions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Statement Transactions
                {event?.relatedAccountName && (
                  <span className="font-normal normal-case ml-1">· {event.relatedAccountName}</span>
                )}
              </p>
            </div>

            {loadingExpenses ? (
              <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
            ) : expenses.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No transactions found</p>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                {expenses.map((exp, i) => (
                  <div
                    key={exp.id}
                    className={cn(
                      "flex items-center justify-between gap-3 px-3 py-2.5 text-xs",
                      i < expenses.length - 1 && "border-b border-border/50"
                    )}
                  >
                    <span className="text-muted-foreground shrink-0 w-10">
                      {fmtMD(exp.date.slice(0, 10))}
                    </span>
                    <span className="flex-1 truncate">{exp.vendor}</span>
                    <span className="tabular-nums text-red-500 shrink-0">
                      {formatCurrency(Math.abs(parseFloat(exp.amount)))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-border p-4">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={saving || !value || parseFloat(value) <= 0}
              className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? "Saving…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Banking tile ──────────────────────────────────────────────────────────────

function BankingTile({
  account,
  onEdit,
}: {
  account: InvestmentAccountSummary;
  onEdit: () => void;
}) {
  return (
    <Card className="px-4 py-3 mt-4">
      <div className="flex items-center gap-3">
        <div
          className="h-8 w-8 flex-shrink-0 rounded-md flex items-center justify-center"
          style={account.color ? { backgroundColor: account.color } : { backgroundColor: "#e2e2df" }}
        >
          <Landmark className="h-4 w-4 text-gray-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{account.name}</p>
          <p className="text-xs text-muted-foreground">
            {account.type === "CHECKING" ? "Checking · Cash" : "Savings · Cash"}
          </p>
        </div>
        <div className="text-right flex-shrink-0 mr-2">
          <p className="font-bold tabular-nums text-sm">
            {formatCurrency(account.totalMarketValue)}
          </p>
        </div>
        <button
          onClick={onEdit}
          className="rounded p-1 hover:bg-accent flex-shrink-0"
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    </Card>
  );
}

// ── Events ledger ─────────────────────────────────────────────────────────────

function fmtMD(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
}

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

function MobileEventsLedger({
  events,
  onCCPaymentTap,
  onInjectionTap,
  onAddInjection,
  showAddInjection,
}: {
  events: CashFlowEvent[];
  onCCPaymentTap?: (event: CashFlowEvent) => void;
  onInjectionTap?: (event: CashFlowEvent) => void;
  onAddInjection?: () => void;
  showAddInjection?: boolean;
}) {
  if (events.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No projected events in this window.
      </p>
    );
  }

  return (
    <div className="mt-4 border-t border-border">
      {events.map((event) => {
        const isCCPayment = event.type === "CC_PAYMENT";
        const isInjection = event.type === "BALANCE_ADJUSTMENT";
        const isTappable = isCCPayment || isInjection;
        const Wrapper = isTappable ? "button" : "div";
        return (
          <Wrapper
            key={event.id}
            {...(isTappable
              ? {
                  type: "button" as const,
                  onClick: () => isCCPayment ? onCCPaymentTap?.(event) : onInjectionTap?.(event),
                  className: cn(
                    "w-full text-left border-b border-border/50 py-2.5 active:bg-muted/40 transition-colors",
                    isInjection && "bg-amber-50/50 active:bg-amber-100/60",
                  ),
                }
              : {
                  className: "border-b border-border/50 py-2.5",
                })}
          >
            {/* Line 1: icon + description + amount + chevron for CC_PAYMENT */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-1.5">
                <span className={cn("mt-0.5 shrink-0", event.amount > 0 ? "text-green-600" : "text-red-500")}>
                  {eventIcon(event.type)}
                </span>
                <p className="truncate font-medium">{event.description}</p>
              </div>
              <span className={cn(
                "shrink-0 tabular-nums font-medium",
                event.amount > 0 ? "text-green-600" : "text-red-500",
              )}>
                {event.amount > 0 ? "+" : ""}{formatCurrency(event.amount)}
              </span>
            </div>

            {/* Line 2: date · secondary info + running balance */}
            <div className="mt-0.5 flex items-start justify-between gap-3 pl-5">
              <p className="text-sm text-muted-foreground">
                {fmtMD(event.date)}
                {event.relatedAccountName && event.type !== "CC_CHARGE" && (
                  <> · {event.type === "TRANSFER_IN" ? "from " : event.type === "TRANSFER_OUT" ? "to " : ""}{event.relatedAccountName}</>
                )}
                {event.confidence === "KNOWN" && event.type !== "CC_PAYMENT" && (
                  <span className="ml-1.5 rounded-full bg-green-100 text-green-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                    Confirmed
                  </span>
                )}
                {event.type === "CC_PAYMENT" && !event.overrideId && (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                    Estimated
                  </span>
                )}
                {event.overrideId && (
                  <span className="ml-1.5 rounded-full bg-green-100 text-green-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                    Confirmed
                  </span>
                )}
              </p>
              <span className={cn(
                "shrink-0 text-sm tabular-nums font-semibold",
                event.runningBalance < 0 ? "text-red-600" : "text-muted-foreground",
              )}>
                {formatCurrency(event.runningBalance)}
              </span>
            </div>
          </Wrapper>
        );
      })}
      {showAddInjection && (
        <button
          type="button"
          onClick={onAddInjection}
          className="w-full flex items-center gap-1.5 py-2.5 text-xs text-muted-foreground hover:text-foreground border-b border-dashed border-border transition-colors"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          Add cash injection
        </button>
      )}
    </div>
  );
}

// ── Projection section ────────────────────────────────────────────────────────

function ProjectionSection({
  projection,
  windowEnd,
  bankingAccount,
  onEditBalance,
  onAddInjection,
  onCCPaymentTap,
  onInjectionTap,
}: {
  projection: CashFlowProjection;
  windowEnd: string;
  bankingAccount: InvestmentAccountSummary | null;
  onEditBalance: () => void;
  onAddInjection: (defaultDate: string) => void;
  onCCPaymentTap?: (event: CashFlowEvent) => void;
  onInjectionTap?: (event: CashFlowEvent) => void;
}) {
  const firstNegativeEntry = projection.dailyBalances.find((d) => d.balance < 0);
  const firstNegativeDate = firstNegativeEntry?.date;
  const shortfall = firstNegativeEntry ? firstNegativeEntry.balance : 0;

  return (
    <div className="space-y-4">
      {/* Balance summary */}
      <div className="space-y-2">
        <div className="flex items-center gap-6">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Today</p>
            <p className="text-xl font-bold tabular-nums">{formatCurrency(projection.startBalance)}</p>
          </div>
          <div className="text-muted-foreground">→</div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">{fmtDate(windowEnd)}</p>
            <p className={cn(
              "text-xl font-bold tabular-nums",
              projection.endBalance < 0 ? "text-red-600" : "text-foreground"
            )}>
              {formatCurrency(projection.endBalance)}
            </p>
          </div>
        </div>
      </div>

      {/* Chart */}
      <BalanceChart data={projection.dailyBalances} />

      {/* Shortfall card */}
      {firstNegativeDate && (
        <Card className="px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 flex-shrink-0 rounded-md bg-red-100 flex items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-red-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm text-red-600">Projected shortfall</p>
              <p className="text-xs text-muted-foreground">
                {formatCurrency(shortfall)} starting {fmtDate(firstNegativeDate)}
              </p>
            </div>
            <button
              onClick={() => onAddInjection(firstNegativeDate)}
              className="flex shrink-0 items-center gap-1 rounded-md bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 transition-colors"
            >
              <PlusCircle className="h-3.5 w-3.5" />
              Add injection
            </button>
          </div>
        </Card>
      )}

      {/* Banking tile */}
      {bankingAccount && (
        <BankingTile account={bankingAccount} onEdit={onEditBalance} />
      )}

      {/* Ledger */}
      <MobileEventsLedger
        events={projection.events}
        onCCPaymentTap={onCCPaymentTap}
        onInjectionTap={onInjectionTap}
        showAddInjection={!firstNegativeDate && projection.events.length > 0}
        onAddInjection={() => onAddInjection(windowEnd)}
      />
    </div>
  );
}

// ── Tab button ────────────────────────────────────────────────────────────────

function TabButton({
  p,
  isActive,
  onClick,
}: {
  p: CashFlowProjection;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap shrink-0",
        isActive
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      )}
    >
      <span>{p.accountName}</span>
      {p.minBalance < 0 && (
        <AlertTriangle className="h-3 w-3 text-red-500 shrink-0" aria-label="Projected negative balance" />
      )}
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function MobileCashFlow() {
  const { data, refetch }                           = useApi(getCashFlow);
  const { data: accounts, refetch: refetchAccounts } = useApi(getInvestmentAccounts);
  const [activeTab, setActiveTab]                   = useState<string | null>(null);
  const [editingAccount, setEditingAccount]         = useState<InvestmentAccountSummary | null>(null);
  const [injectionOpen, setInjectionOpen]           = useState(false);
  const [injectionDefaultDate, setInjectionDefaultDate] = useState("");
  const [ccPaymentEvent, setCCPaymentEvent]         = useState<CashFlowEvent | null>(null);
  const [editingInjection, setEditingInjection]     = useState<CashFlowEvent | null>(null);

  const projections = data?.projections ?? [];
  const personal = projections.filter((p) => !p.isJoint).sort((a, b) => b.startBalance - a.startBalance);
  const joint    = projections.filter((p) =>  p.isJoint).sort((a, b) => b.startBalance - a.startBalance);
  const sorted   = [...personal, ...joint];

  const selectedId         = activeTab ?? sorted[0]?.accountId ?? null;
  const selectedProjection = sorted.find((p) => p.accountId === selectedId) ?? null;

  const bankingAccounts = (accounts ?? []).filter(
    (a) => a.type === "CHECKING" || a.type === "SAVINGS"
  );
  const selectedBankingAccount = bankingAccounts.find((a) => a.id === selectedId) ?? null;

  const handleSaveBalance = async (id: string, balance: number) => {
    const d = new Date();
    const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await updateAccount(id, { balance: String(balance), balanceUpdatedAt: `${localDate}T00:00:00.000Z` });
    setEditingAccount(null);
    refetchAccounts();
    refetch();
  };

  return (
    <div>
      {/* Page header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Cash Flow</h2>
        {data && (
          <p className="text-sm text-muted-foreground mt-0.5">
            {fmtDate(data.windowStart)} – {fmtDate(data.windowEnd)} · {data.windowDays}-day projection
          </p>
        )}
      </div>

      {/* Account tabs */}
      {sorted.length > 0 && (
        <div className="border-b border-border mb-6">
          <div className="flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {sorted.map((p) => (
              <TabButton
                key={p.accountId}
                p={p}
                isActive={p.accountId === selectedId}
                onClick={() => setActiveTab(p.accountId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Projection + banking tile */}
      {selectedProjection && data && (
        <ProjectionSection
          projection={selectedProjection}
          windowEnd={data.windowEnd}
          bankingAccount={selectedBankingAccount}
          onEditBalance={() => setEditingAccount(selectedBankingAccount)}
          onAddInjection={(defaultDate) => { setInjectionDefaultDate(defaultDate); setInjectionOpen(true); }}
          onCCPaymentTap={(event) => setCCPaymentEvent(event)}
          onInjectionTap={(event) => setEditingInjection(event)}
        />
      )}

      {/* Edit balance sheet */}
      <EditBalanceSheet
        account={editingAccount}
        onClose={() => setEditingAccount(null)}
        onSave={handleSaveBalance}
      />

      {/* Add / edit cash injection sheet */}
      <AddCashInjectionSheet
        open={injectionOpen}
        accountId={selectedId}
        defaultDate={injectionDefaultDate}
        onClose={() => { setInjectionOpen(false); setEditingInjection(null); }}
        onSaved={() => { refetch(); refetchAccounts(); }}
        editingEvent={editingInjection}
      />

      {/* CC payment sheet */}
      <CCPaymentSheet
        event={ccPaymentEvent}
        onClose={() => setCCPaymentEvent(null)}
        onSaved={() => { refetch(); }}
      />
    </div>
  );
}
