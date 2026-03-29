import { useState, useMemo } from "react";
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
  CreditCard,
  ArrowDownLeft,
  ArrowUpRight,
  Sparkles,
  Pencil,
  Check,
  X,
  PlusCircle,
} from "lucide-react";
import { Card } from "@/components/Card";
import { useApi } from "@/hooks/useApi";
import { getCashFlow, upsertStatementOverride, deleteStatementOverride } from "@/api";
import { formatCurrency, cn } from "@/lib/utils";
import type { CashFlowProjection, CashFlowEvent, DailyBalance } from "@/types";

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
    case "EXPENSE":      return <TrendingDown className="h-3.5 w-3.5" />;
    case "CC_CHARGE":    return <CreditCard className="h-3.5 w-3.5" />;
    case "CC_PAYMENT":   return <CreditCard className="h-3.5 w-3.5" />;
    case "TRANSFER_IN":  return <ArrowDownLeft className="h-3.5 w-3.5" />;
    case "TRANSFER_OUT": return <ArrowUpRight className="h-3.5 w-3.5" />;
    case "DIVIDEND":     return <Sparkles className="h-3.5 w-3.5" />;
  }
}

// ── Balance chart ─────────────────────────────────────────────────────────────

interface BalanceChartProps {
  data: DailyBalance[];
  bridgeDate?: string;
  bridgeAmount?: number;
}

function BalanceChart({ data, bridgeDate, bridgeAmount }: BalanceChartProps) {
  const chartData = useMemo(() => {
    if (!bridgeDate || !bridgeAmount) return data;
    let added = false;
    let cumulative = 0;
    return data.map((d) => {
      if (!added && d.date >= bridgeDate) {
        added = true;
        cumulative += bridgeAmount;
      }
      return { ...d, balance: d.balance + cumulative };
    });
  }, [data, bridgeDate, bridgeAmount]);

  const minVal = Math.min(...chartData.map((d) => d.balance));
  const maxVal = Math.max(...chartData.map((d) => d.balance));
  const hasNegative = minVal < 0;

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
            <stop offset="5%" stopColor={hasNegative ? "#ef4444" : "#3b82f6"} stopOpacity={0.2} />
            <stop offset="95%" stopColor={hasNegative ? "#ef4444" : "#3b82f6"} stopOpacity={0} />
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
        <RechartsTooltip
          contentStyle={{
            fontSize: 12,
            background: "hsl(var(--background))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
          }}
          formatter={(v: number) => [formatCurrency(v), "Balance"]}
          labelFormatter={fmtDate}
        />
        {hasNegative && (
          <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 2" strokeWidth={1.5} />
        )}
        <Area
          type="monotone"
          dataKey="balance"
          stroke={hasNegative ? "#ef4444" : "#3b82f6"}
          strokeWidth={2}
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
}

function CCPaymentCells({ event, accountId, onSaved, amountClassName }: CCPaymentCellsProps) {
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

  const handleClear = async () => {
    if (!event.overrideId) return;
    setSaving(true);
    try {
      await deleteStatementOverride(event.overrideId);
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
        <td className={cn("py-2 pr-2 text-right tabular-nums font-medium", amountClassName)}>
          {event.amount >= 0 ? "+" : ""}
          {formatCurrency(event.amount)}
        </td>
        {/* Edit cell */}
        <td className="py-2 pr-4 w-7">
          <button
            onClick={() => { setValue(Math.abs(event.amount).toFixed(2)); setOpen(true); }}
            className="rounded p-0.5 hover:bg-accent text-muted-foreground"
            title="Override statement amount"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </td>
      </>
    );
  }

  return (
    <>
      {/* Amount cell — becomes inline input when editing */}
      <td className="py-2 pr-2 text-right">
        <span className="inline-flex items-center justify-end gap-1">
          <span className="text-xs text-muted-foreground">$</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-24 rounded border border-border bg-background px-1.5 py-0.5 text-xs tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setOpen(false); }}
          />
        </span>
      </td>
      {/* Edit cell — confirm / clear-override / cancel */}
      <td className="py-2 pr-4 w-7">
        <span className="inline-flex items-center gap-0.5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded p-0.5 hover:bg-accent text-green-600"
            title="Save"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          {event.overrideId && (
            <button
              onClick={handleClear}
              disabled={saving}
              className="rounded p-0.5 hover:bg-accent text-amber-600"
              title="Remove override"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            className="rounded p-0.5 hover:bg-accent text-muted-foreground"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </td>
    </>
  );
}

// ── Bridge inject row ─────────────────────────────────────────────────────────

interface BridgeInjectRowProps {
  defaultDate: string;
  onSimulate: (date: string, amount: number) => void;
  onClear: () => void;
  simulating: boolean;
}

function BridgeInjectRow({ defaultDate, onSimulate, onClear, simulating }: BridgeInjectRowProps) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(defaultDate);
  const [amount, setAmount] = useState("");

  if (!open) {
    return (
      <tr className="border-b border-dashed border-red-200 dark:border-red-900/40">
        <td colSpan={5} className="py-1.5 px-1">
          <button
            onClick={() => { setDate(defaultDate); setOpen(true); }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-red-600 transition-colors"
          >
            <PlusCircle className="h-3.5 w-3.5" />
            Simulate cash injection
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-dashed border-red-300 dark:border-red-900/60 bg-red-50/50 dark:bg-red-950/20">
      <td className="py-2 pr-4">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded border border-border bg-background px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary w-32"
        />
      </td>
      <td className="py-2 pr-4">
        <span className="text-xs text-muted-foreground italic">Cash injection (simulation only)</span>
      </td>
      <td className="py-2 pr-2 text-right">
        <input
          type="number"
          step="100"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          autoFocus
          className="w-28 rounded border border-border bg-background px-2 py-0.5 text-xs tabular-nums text-right focus:outline-none focus:ring-1 focus:ring-primary"
          onKeyDown={(e) => {
            if (e.key === "Enter" && parseFloat(amount) > 0) {
              onSimulate(date, parseFloat(amount));
            }
            if (e.key === "Escape") setOpen(false);
          }}
        />
      </td>
      {/* Edit column — confirm / clear / cancel */}
      <td className="py-2 pr-4 w-7" colSpan={2}>
        <span className="inline-flex items-center gap-0.5">
          <button
            onClick={() => { if (parseFloat(amount) > 0) onSimulate(date, parseFloat(amount)); }}
            disabled={!amount || parseFloat(amount) <= 0}
            className="rounded p-0.5 hover:bg-accent text-green-600 disabled:opacity-40"
            title="Apply simulation"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          {simulating && (
            <button
              onClick={() => { onClear(); setAmount(""); }}
              className="rounded p-0.5 hover:bg-accent text-muted-foreground"
              title="Clear simulation"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            className="rounded p-0.5 hover:bg-accent text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </td>
    </tr>
  );
}

// ── Events ledger ─────────────────────────────────────────────────────────────

interface LedgerProps {
  events: CashFlowEvent[];
  accountId: string;
  onOverrideSaved: () => void;
  bridgeDate?: string;
  bridgeAmount?: number;
  onSimulate: (date: string, amount: number) => void;
  onClear: () => void;
  simulating: boolean;
}

function EventsLedger({
  events,
  accountId,
  onOverrideSaved,
  onSimulate,
  onClear,
  simulating,
}: LedgerProps) {
  // Index of the first event where running balance goes negative
  const firstNegativeIdx = events.findIndex((e) => e.runningBalance < 0);

  if (events.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No projected events in this window.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="py-2 pr-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide w-24">Date</th>
            <th className="py-2 pr-4 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Description</th>
            <th className="py-2 pr-2 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide w-36">Amount</th>
            <th className="py-2 pr-4 w-7" />
            <th className="py-2 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide w-32">Balance</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event, idx) => (
            <>
              {/* Bridge inject row appears just before the first negative-balance event */}
              {idx === firstNegativeIdx && (
                <BridgeInjectRow
                  key={`bridge-${event.id}`}
                  defaultDate={event.date}
                  onSimulate={onSimulate}
                  onClear={onClear}
                  simulating={simulating}
                />
              )}
              <tr key={event.id} className="group border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">{fmtDate(event.date)}</td>
                <td className="py-2 pr-4">
                  <div className="flex items-center gap-2">
                    <span className={cn("shrink-0", event.amount >= 0 ? "text-green-600" : "text-red-500")}>
                      {eventIcon(event.type)}
                    </span>
                    <span className="font-medium">{event.description}</span>
                    {event.relatedAccountName && event.type !== "CC_CHARGE" && (
                      <span className="text-xs text-muted-foreground">
                        {event.type === "TRANSFER_IN" ? "from" : event.type === "TRANSFER_OUT" ? "to" : "·"}{" "}
                        {event.relatedAccountName}
                      </span>
                    )}
                    {event.confidence === "PROJECTED" && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        Projected
                      </span>
                    )}
                    {event.overrideId && (
                      <span className="rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                        Override
                      </span>
                    )}
                  </div>
                </td>
                {/* Amount + edit columns */}
                {event.type === "CC_PAYMENT" ? (
                  <CCPaymentCells
                    event={event}
                    accountId={event.relatedAccountId ?? accountId}
                    onSaved={onOverrideSaved}
                    amountClassName={event.amount >= 0 ? "text-green-600" : "text-red-500"}
                  />
                ) : (
                  <>
                    <td className={cn(
                      "py-2 pr-2 text-right tabular-nums font-medium",
                      event.amount >= 0 ? "text-green-600" : "text-red-500",
                    )}>
                      {event.amount >= 0 ? "+" : ""}
                      {formatCurrency(event.amount)}
                    </td>
                    <td className="py-2 pr-4 w-7" />
                  </>
                )}
                <td className={cn(
                  "py-2 text-right tabular-nums font-semibold",
                  event.runningBalance < 0 ? "text-red-600" : "text-foreground"
                )}>
                  {formatCurrency(event.runningBalance)}
                </td>
              </tr>
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Account panel ─────────────────────────────────────────────────────────────

interface AccountPanelProps {
  projection: CashFlowProjection;
  windowEnd: string;
  onRefetch: () => void;
}

function AccountPanel({ projection, windowEnd, onRefetch }: AccountPanelProps) {
  const [bridgeDate, setBridgeDate] = useState<string | undefined>();
  const [bridgeAmount, setBridgeAmount] = useState<number | undefined>();

  const firstNegativeEntry = projection.dailyBalances.find((d) => d.balance < 0);
  const firstNegativeDate = firstNegativeEntry?.date;
  const shortfall = firstNegativeEntry ? Math.abs(firstNegativeEntry.balance) : 0;

  return (
    <div className="space-y-4">
      {/* Balance summary row */}
      <div className="flex items-center gap-6">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">Today</p>
          <p className="text-xl font-bold tabular-nums">{formatCurrency(projection.startBalance)}</p>
        </div>
        <div className="text-muted-foreground">→</div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-0.5">
            {fmtDate(windowEnd)}
          </p>
          <p className={cn(
            "text-xl font-bold tabular-nums",
            projection.endBalance < 0 ? "text-red-600" : "text-foreground"
          )}>
            {formatCurrency(projection.endBalance)}
          </p>
        </div>
        {firstNegativeDate && (
          <div className="ml-2 flex items-center gap-1.5 text-sm text-red-600">
            <TrendingDown className="h-4 w-4 shrink-0" />
            <span>
              Projected shortfall of {formatCurrency(shortfall)} starting {fmtDate(firstNegativeDate)}
            </span>
          </div>
        )}
      </div>

      {/* Chart */}
      <Card className="p-3">
        <BalanceChart
          data={projection.dailyBalances}
          bridgeDate={bridgeDate}
          bridgeAmount={bridgeAmount}
        />
      </Card>

      {/* Events ledger */}
      <EventsLedger
        events={projection.events}
        accountId={projection.accountId}
        onOverrideSaved={onRefetch}
        bridgeDate={bridgeDate}
        bridgeAmount={bridgeAmount}
        onSimulate={(d, a) => { setBridgeDate(d); setBridgeAmount(a); }}
        onClear={() => { setBridgeDate(undefined); setBridgeAmount(undefined); }}
        simulating={bridgeDate != null}
      />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function CashFlow() {
  const { data, refetch } = useApi(() => getCashFlow(45), []);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  const projections = data?.projections ?? [];

  const selectedId = activeTab ?? projections[0]?.accountId ?? null;
  const selectedProjection = projections.find((p) => p.accountId === selectedId) ?? null;

  const personal = projections.filter((p) => !p.isJoint);
  const joint = projections.filter((p) => p.isJoint);

  function TabButton({ p }: { p: CashFlowProjection }) {
    const isActive = p.accountId === selectedId;
    const hasNegative = p.minBalance < 0;
    return (
      <button
        onClick={() => setActiveTab(p.accountId)}
        className={cn(
          "flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
          isActive
            ? "border-primary text-foreground"
            : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
        )}
      >
        {p.color && (
          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
        )}
        <span>{p.accountName}</span>
        {hasNegative && (
          <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" title="Projected negative balance" />
        )}
      </button>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Cash Flow</h2>
        <Card className="p-8 text-center text-sm text-muted-foreground">Loading projection…</Card>
      </div>
    );
  }

  if (projections.length === 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Cash Flow</h2>
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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Cash Flow</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {fmtDate(data.windowStart)} – {fmtDate(data.windowEnd)} · {data.windowDays}-day projection
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b border-border">
        <div className="flex items-center gap-0 overflow-x-auto">
          {personal.length > 0 && joint.length > 0 && (
            <span className="mr-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
              Personal
            </span>
          )}
          {personal.map((p) => <TabButton key={p.accountId} p={p} />)}
          {joint.length > 0 && (
            <>
              <span className="mx-3 text-border">|</span>
              <span className="mr-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
                Joint
              </span>
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
        />
      )}
    </div>
  );
}
