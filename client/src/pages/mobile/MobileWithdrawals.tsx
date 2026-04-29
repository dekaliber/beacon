import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ArrowLeft,
  Plus,
  Settings2,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  ChevronRight as ChevronRightIcon,
  ArrowUpRight,
} from "lucide-react";
import { Button } from "@/components/Button";
import { useApi } from "@/hooks/useApi";
import {
  getWithdrawals,
  getWithdrawalSummary,
  getAccounts,
  getInvestmentAccounts,
  getInvestmentSettings,
  updateInvestmentSettings,
  createTransfer,
  updateTransfer,
  deleteTransfer,
  getDataRange,
} from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useDemo } from "@/context/DemoContext";
import { cn } from "@/lib/utils";
import type { WithdrawalEvent, WithdrawalType, InvestmentSettings } from "@/types";

const CURRENT_YEAR = new Date().getFullYear();

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<WithdrawalType, string> = {
  dividend: "Dividend",
  interest: "Interest",
  cap_gains_dist: "Cap Gains Dist.",
  sale_proceeds: "Sale Proceeds",
  return_of_capital: "Return of Capital",
  transfer: "Transfer",
  reinvestment: "Reinvestment",
};

const TYPE_COLORS: Record<WithdrawalType, string> = {
  dividend: "bg-violet-100 text-violet-700",
  interest: "bg-sky-100 text-sky-700",
  cap_gains_dist: "bg-blue-100 text-blue-700",
  sale_proceeds: "bg-amber-100 text-amber-700",
  return_of_capital: "bg-orange-100 text-orange-700",
  transfer: "bg-emerald-100 text-emerald-700",
  reinvestment: "bg-rose-100 text-rose-700",
};

function annualizedRate(total: number, months: number, denominator: number): number | null {
  if (denominator <= 0 || months <= 0) return null;
  return (total * (12 / months)) / denominator;
}

function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(2)}%`;
}

function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const y = window.scrollY;
    document.body.style.position = "fixed";
    document.body.style.top = `-${y}px`;
    document.body.style.width = "100%";
    return () => {
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      window.scrollTo(0, y);
    };
  }, [active]);
}

// ── Type badge ────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: WithdrawalType }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
      TYPE_COLORS[type],
    )}>
      {TYPE_LABELS[type]}
    </span>
  );
}

// ── Settings bottom sheet ─────────────────────────────────────────────────────

function SettingsSheet({
  open,
  settings,
  portfolioValue,
  onClose,
  onSave,
}: {
  open: boolean;
  settings: InvestmentSettings | null | undefined;
  portfolioValue: number;
  onClose: () => void;
  onSave: (patch: Partial<InvestmentSettings>) => Promise<void>;
}) {
  const [useOverride, setUseOverride] = useState(false);
  const [denominator, setDenominator] = useState("");
  const [targetPct, setTargetPct] = useState("");
  const [saving, setSaving] = useState(false);

  useBodyScrollLock(open);

  useEffect(() => {
    if (open) {
      const d = settings?.withdrawalRateDenominator;
      setUseOverride(d != null);
      setDenominator(d != null ? String(d) : "");
      const t = settings?.withdrawalRateTarget;
      setTargetPct(t != null ? String((t * 100).toFixed(2)) : "");
    }
  }, [open, settings]);

  const handleSave = async () => {
    setSaving(true);
    const denominatorVal = useOverride
      ? (parseFloat(denominator) > 0 ? parseFloat(denominator) : null)
      : null;
    const targetVal = targetPct !== "" ? (parseFloat(targetPct) / 100 || null) : null;
    await onSave({ withdrawalRateDenominator: denominatorVal, withdrawalRateTarget: targetVal });
    setSaving(false);
    onClose();
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-[55] bg-black/40"
          onClick={onClose}
        />
      )}
      <div id="sheet-settings" className={cn(
        "fixed inset-x-0 bottom-0 z-[60] flex flex-col rounded-t-2xl bg-background border-t border-border transition-transform duration-300",
        open ? "translate-y-0" : "translate-y-full",
      )}>
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="px-4 pb-8 space-y-5">
          <h2 className="text-base font-semibold">Withdrawal Rate Settings</h2>

          {/* Portfolio denominator */}
          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium mb-0.5">Portfolio Denominator</p>
              <p className="text-xs text-muted-foreground">
                Override with your portfolio value at retirement to track against a fixed baseline.
              </p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={!useOverride}
                onChange={() => setUseOverride(false)}
                className="accent-primary"
              />
              <span className="text-sm">Current portfolio value ({formatCurrency(portfolioValue)})</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={useOverride}
                onChange={() => setUseOverride(true)}
                className="accent-primary"
              />
              <span className="text-sm">Use a fixed value</span>
            </label>
            {useOverride && (
              <div className="ml-6 relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <input
                  type="number"
                  step="1000"
                  min="1"
                  value={denominator}
                  onChange={(e) => setDenominator(e.target.value)}
                  autoFocus
                  className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none"
                  placeholder="e.g. 2500000"
                />
              </div>
            )}
          </div>

          <div className="border-t border-border" />

          {/* Target rate */}
          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium mb-0.5">Target Withdrawal Rate</p>
              <p className="text-xs text-muted-foreground">
                Your desired annual withdrawal rate. Leave blank for no target. Common guideline: 4%.
              </p>
            </div>
            <div className="relative w-36">
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={targetPct}
                onChange={(e) => setTargetPct(e.target.value)}
                className="w-full rounded-md border border-border pl-3 pr-7 py-2 text-sm focus:border-primary focus:outline-none"
                placeholder="e.g. 4.0"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="button" variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button type="button" className="flex-1" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Month detail bottom sheet ─────────────────────────────────────────────────

function MonthDetailSheet({
  open,
  month,
  events,
  onClose,
  onEdit,
  onDelete,
}: {
  open: boolean;
  month: string | null;
  events: WithdrawalEvent[];
  onClose: () => void;
  onEdit: (event: WithdrawalEvent) => void;
  onDelete: (event: WithdrawalEvent) => void;
}) {
  useBodyScrollLock(open);

  const label = month
    ? new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : "";

  const total = events.reduce(
    (s, e) => s + (e.type === "reinvestment" ? -1 : 1) * parseFloat(e.amount),
    0,
  );

  return (
    <>
      {open && <div className="fixed inset-0 z-[55] bg-black/40" onClick={onClose} />}
      <div id="sheet-month-detail" className={cn(
        "fixed inset-x-0 bottom-0 z-[60] rounded-t-2xl bg-background border-t border-border transition-transform duration-300 max-h-[85vh] flex flex-col",
        open ? "translate-y-0" : "translate-y-full",
      )}>
        <div className="mx-auto mt-3 mb-1 h-1 w-10 rounded-full bg-muted-foreground/30 flex-shrink-0" />

        {/* Sheet header */}
        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0 border-b border-border">
          <div>
            <p className="font-semibold">{label}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{formatCurrency(total)} total</p>
          </div>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground px-2 py-1">
            Done
          </button>
        </div>

        {/* Event list */}
        <div className="overflow-y-auto flex-1 divide-y divide-border/60">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No events this month.</p>
          ) : (
            events.map((event) => {
              const isIncome = !event.isEditable;
              const amount = (event.type === "reinvestment" ? -1 : 1) * parseFloat(event.amount);
              return (
                <div key={event.id} className="px-4 py-3 space-y-1.5">
                  {/* Top row: badge + amount */}
                  <div className="flex items-center justify-between gap-2">
                    <TypeBadge type={event.type} />
                    <span className={cn(
                      "text-sm font-semibold tabular-nums",
                      amount < 0 ? "text-green-600" : "text-foreground",
                    )}>
                      {amount < 0 ? "−" : ""}{formatCurrency(Math.abs(amount))}
                    </span>
                  </div>

                  {/* Description + date */}
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("text-sm truncate", isIncome ? "text-muted-foreground" : "font-medium")}>
                      {event.description || "—"}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                      {formatDate(event.date)}
                    </span>
                  </div>

                  {/* Account */}
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    {event.type === "transfer" && event.toAccount ? (
                      <>
                        <span className="truncate">{event.account.name}</span>
                        <ArrowUpRight className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{event.toAccount.name}</span>
                      </>
                    ) : (
                      <span className="truncate">{event.account.name}</span>
                    )}
                  </div>

                  {/* Actions */}
                  {isIncome ? (
                    <p className="text-[11px] text-muted-foreground/70 italic">Recorded in Income</p>
                  ) : (
                    <div className="flex items-center gap-3 pt-0.5">
                      <button
                        onClick={() => { onClose(); setTimeout(() => onEdit(event), 200); }}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                      <button
                        onClick={() => { onClose(); setTimeout(() => onDelete(event), 200); }}
                        className="flex items-center gap-1 text-xs text-destructive/70 hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

// ── Transfer fullscreen modal ─────────────────────────────────────────────────

interface TransferFormData {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  date: string;
  description: string;
  notes: string;
}

interface ModalAccount {
  id: string;
  name: string;
  type: string;
  isManaged: boolean;
}

function TransferFullscreen({
  open,
  editingTransferId,
  initialData,
  allAccounts,
  onClose,
  onSaved,
}: {
  open: boolean;
  editingTransferId: string | null;
  initialData: Partial<TransferFormData> | null;
  allAccounts: ModalAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  useBodyScrollLock(open);

  const investmentAccounts = allAccounts.filter((a) => a.type === "INVESTMENT");
  const bankingAccounts = allAccounts.filter((a) => a.type !== "INVESTMENT");
  const today = new Date().toLocaleDateString("en-CA");

  const [form, setForm] = useState<TransferFormData>({
    fromAccountId: "",
    toAccountId: "",
    amount: "",
    date: today,
    description: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm({
        fromAccountId: initialData?.fromAccountId ?? "",
        toAccountId: initialData?.toAccountId ?? "",
        amount: initialData?.amount ?? "",
        date: initialData?.date ?? today,
        description: initialData?.description ?? "",
        notes: initialData?.notes ?? "",
      });
      setError(null);
    }
  }, [open, initialData]);

  const set = (field: keyof TransferFormData) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const selectedFromAccount = allAccounts.find((a) => a.id === form.fromAccountId);
  const selectedToAccount = allAccounts.find((a) => a.id === form.toAccountId);
  const managedInvestmentAccount =
    selectedFromAccount?.type === "INVESTMENT" && selectedFromAccount.isManaged
      ? selectedFromAccount
      : selectedToAccount?.type === "INVESTMENT" && selectedToAccount.isManaged
      ? selectedToAccount
      : null;
  const isPastOrToday = form.date <= today;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.fromAccountId || !form.toAccountId || !form.amount || !form.date) {
      setError("Please fill in all required fields.");
      return;
    }
    const amount = parseFloat(form.amount);
    if (isNaN(amount) || amount <= 0) {
      setError("Amount must be a positive number.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingTransferId) {
        await updateTransfer(editingTransferId, {
          fromAccountId: form.fromAccountId,
          toAccountId: form.toAccountId,
          amount,
          date: form.date,
          description: form.description || "Portfolio withdrawal",
          notes: form.notes || null,
        });
      } else {
        await createTransfer({
          fromAccountId: form.fromAccountId,
          toAccountId: form.toAccountId,
          amount,
          date: form.date,
          description: form.description || "Portfolio withdrawal",
          notes: form.notes || null,
          isConfirmed: isPastOrToday,
        });
      }
      onSaved();
      onClose();
    } catch {
      setError("Failed to save transfer. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none bg-background";

  return (
    <div id="sheet-transfer" className={cn(
      "fixed inset-0 z-[60] bg-background flex flex-col transition-transform duration-300",
      open ? "translate-y-0" : "translate-y-full",
    )}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-border flex-shrink-0">
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h2 className="text-base font-semibold flex-1">
          {editingTransferId ? "Edit Transfer" : "Record Withdrawal"}
        </h2>
        <button
          form="transfer-form"
          type="submit"
          disabled={saving}
          className="text-sm font-semibold text-primary disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* Form */}
      <div className="overflow-y-auto flex-1 px-4 py-5">
        <form id="transfer-form" onSubmit={handleSubmit} className="space-y-4">
          {/* From */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">
              From Account <span className="text-destructive">*</span>
            </label>
            <select value={form.fromAccountId} onChange={set("fromAccountId")} required className={inputClass}>
              <option value="">Select account…</option>
              <optgroup label="Investment Accounts">
                {investmentAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </optgroup>
              <optgroup label="Banking Accounts">
                {bankingAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </optgroup>
            </select>
          </div>

          {/* To */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">
              To Account <span className="text-destructive">*</span>
            </label>
            <select value={form.toAccountId} onChange={set("toAccountId")} required className={inputClass}>
              <option value="">Select account…</option>
              <optgroup label="Investment Accounts">
                {investmentAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </optgroup>
              <optgroup label="Banking Accounts">
                {bankingAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </optgroup>
            </select>
          </div>

          {/* Amount + Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Amount <span className="text-destructive">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={form.amount}
                  onChange={set("amount")}
                  required
                  className={cn(inputClass, "pl-7")}
                  placeholder="0.00"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">
                Date <span className="text-destructive">*</span>
              </label>
              <input
                type="date"
                value={form.date}
                onChange={set("date")}
                required
                className={inputClass}
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">Description</label>
            <input
              type="text"
              value={form.description}
              onChange={set("description")}
              placeholder="Portfolio withdrawal"
              className={inputClass}
            />
          </div>

          {/* Notes */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-muted-foreground">Notes</label>
            <textarea
              value={form.notes}
              onChange={set("notes")}
              rows={3}
              className={cn(inputClass, "resize-none")}
            />
          </div>

          {/* Notices */}
          {managedInvestmentAccount && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-800">
              <strong>{managedInvestmentAccount.name}</strong> is a managed account — its balance
              won't be adjusted automatically. Update it manually once complete.
            </div>
          )}
          {!isPastOrToday && !editingTransferId && (
            <div className="rounded-md bg-sky-50 border border-sky-200 px-3 py-2.5 text-sm text-sky-800">
              This is a future transfer. Account balances will be updated automatically when the
              date arrives.
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </div>
    </div>
  );
}

// ── Delete confirmation sheet ─────────────────────────────────────────────────

function DeleteConfirmSheet({
  event,
  onClose,
  onConfirm,
}: {
  event: WithdrawalEvent | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const open = event != null;
  useBodyScrollLock(open);

  const handleConfirm = async () => {
    setDeleting(true);
    await onConfirm();
    setDeleting(false);
  };

  return (
    <>
      {open && <div className="fixed inset-0 z-[55] bg-black/40" onClick={onClose} />}
      <div id="sheet-delete-confirm" className={cn(
        "fixed inset-x-0 bottom-0 z-[60] flex flex-col rounded-t-2xl bg-background border-t border-border transition-transform duration-300",
        open ? "translate-y-0" : "translate-y-full",
      )}>
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="px-4 pb-8 space-y-4">
          <h2 className="text-base font-semibold">Delete Transfer</h2>
          <p className="text-sm text-muted-foreground">
            This removes the record from Beacon but does not reverse any account balance changes.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button variant="destructive" className="flex-1" onClick={handleConfirm} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function MobileWithdrawals() {
  const [year, setYear] = useState(CURRENT_YEAR);

  const { data: settings, refetch: refetchSettings } = useApi(() => getInvestmentSettings(), []);
  const { data: events, refetch } = useApi(() => getWithdrawals(year), [year]);
  const { data: summary, refetch: refetchSummary } = useApi(() => getWithdrawalSummary(year), [year]);
  const { data: investmentAccountsData } = useApi(() => getInvestmentAccounts(), []);
  const { data: allAccountsData } = useApi(() => getAccounts(), []);
  const { data: dataRange } = useApi(() => getDataRange(), []);
  const { isDemoMode, demoFactor } = useDemo();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<WithdrawalEvent | null>(null);
  const [deletingEvent, setDeletingEvent] = useState<WithdrawalEvent | null>(null);

  const currentPortfolioValue = useMemo(() => {
    const raw = (investmentAccountsData ?? []).reduce((sum, a) => sum + a.totalMarketValue, 0);
    return isDemoMode ? raw * demoFactor : raw;
  }, [investmentAccountsData, isDemoMode, demoFactor]);

  const modalAccounts = useMemo<ModalAccount[]>(
    () =>
      (allAccountsData ?? [])
        .filter(
          (a) =>
            !a.isJoint &&
            a.isActive &&
            (a.type === "INVESTMENT" || a.type === "CHECKING" || a.type === "SAVINGS"),
        )
        .map((a) => ({ id: a.id, name: a.name, type: a.type, isManaged: a.isManaged ?? false })),
    [allAccountsData],
  );

  const monthGroups = useMemo(() => {
    if (!events) return [];
    const groups: Record<string, WithdrawalEvent[]> = {};
    for (const e of events) {
      const key = e.date.slice(0, 7);
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [events]);

  const ytdTotal = summary?.ytdTotal ?? 0;
  const ytdMonths = summary?.ytdMonths ?? 1;
  const effectiveDenominator = settings?.withdrawalRateDenominator ?? currentPortfolioValue;
  const ytdRate = annualizedRate(ytdTotal, ytdMonths, effectiveDenominator);
  const targetRate = settings?.withdrawalRateTarget ?? null;

  const selectedMonthEvents = useMemo(
    () => (selectedMonth ? (monthGroups.find(([m]) => m === selectedMonth)?.[1] ?? []) : []),
    [selectedMonth, monthGroups],
  );

  const handleSettingsSave = useCallback(async (patch: Partial<InvestmentSettings>) => {
    await updateInvestmentSettings(patch);
    refetchSettings();
  }, [refetchSettings]);

  const handleEdit = useCallback((event: WithdrawalEvent) => {
    setEditingEvent(event);
    setTransferOpen(true);
  }, []);

  const handleDelete = useCallback((event: WithdrawalEvent) => {
    setDeletingEvent(event);
  }, []);

  const confirmDelete = async () => {
    if (!deletingEvent?.transferId) return;
    await deleteTransfer(deletingEvent.transferId);
    setDeletingEvent(null);
    refetch();
    refetchSummary();
  };

  const handleTransferSaved = () => {
    refetch();
    refetchSummary();
  };

  const currentMonth = new Date().toLocaleDateString("en-CA").slice(0, 7);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Withdrawals</h1>
        <div className="flex flex-1 items-center justify-end gap-1">
          <button
            onClick={() => setYear((y) => y - 1)}
            disabled={dataRange ? year <= dataRange.minYear : false}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[3rem] text-center text-sm font-semibold">{year}</span>
          <button
            onClick={() => setYear((y) => y + 1)}
            disabled={dataRange ? year >= dataRange.maxYear : false}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="ml-1 rounded-full p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Settings2 className="h-4.5 w-4.5" />
          </button>
        </div>
      </div>

      {/* Summary card */}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
              YTD Total
            </p>
            <p className="text-2xl font-bold tabular-nums">{formatCurrency(ytdTotal)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
              Annualized Rate
            </p>
            <p className="text-2xl font-bold tabular-nums">
              {effectiveDenominator > 0 ? formatRate(ytdRate) : "—"}
            </p>
          </div>
        </div>

        {targetRate !== null && effectiveDenominator > 0 && ytdRate !== null && (
          <div className={cn(
            "rounded-lg px-3 py-2 text-sm font-medium",
            ytdRate <= targetRate
              ? "bg-green-50 text-green-700"
              : "bg-red-50 text-red-600",
          )}>
            {ytdRate <= targetRate
              ? `▼ ${((targetRate - ytdRate) * 100).toFixed(2)}% under target (${(targetRate * 100).toFixed(2)}%)`
              : `▲ ${((ytdRate - targetRate) * 100).toFixed(2)}% over target (${(targetRate * 100).toFixed(2)}%)`}
          </div>
        )}

        {effectiveDenominator === 0 && investmentAccountsData !== undefined && (
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-xs text-primary underline underline-offset-2"
          >
            Configure withdrawal rate settings
          </button>
        )}
      </div>

      {/* Month list */}
      {events === undefined ? (
        <p className="text-sm text-muted-foreground text-center py-8">Loading…</p>
      ) : monthGroups.length === 0 ? (
        <div className="rounded-xl border border-border p-6 text-center space-y-3">
          <ArrowUpRight className="h-8 w-8 text-muted-foreground mx-auto opacity-40" />
          <p className="font-semibold text-sm">No withdrawals recorded for {year}</p>
          <p className="text-xs text-muted-foreground">
            Dividends and interest appear here automatically. Add a transfer to record a brokerage withdrawal.
          </p>
          <Button
            size="sm"
            onClick={() => { setEditingEvent(null); setTransferOpen(true); }}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add Transfer
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
          {/* Add transfer row */}
          <button
            type="button"
            onClick={() => { setEditingEvent(null); setTransferOpen(true); }}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground hover:bg-accent/50 transition-colors border-b border-dashed"
          >
            <Plus className="h-4 w-4" />
            <span>Record withdrawal transfer</span>
          </button>

          {monthGroups.map(([month, monthEvents]) => {
            const monthTotal = monthEvents.reduce(
              (s, e) => s + (e.type === "reinvestment" ? -1 : 1) * parseFloat(e.amount),
              0,
            );
            const monthRate = effectiveDenominator > 0
              ? annualizedRate(monthTotal, 1, effectiveDenominator)
              : null;
            const monthLabel = new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", {
              month: "long",
              year: "numeric",
            });
            const isCurrent = month === currentMonth;

            return (
              <button
                key={month}
                type="button"
                onClick={() => setSelectedMonth(month)}
                className={cn(
                  "w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-accent/40 transition-colors",
                  isCurrent && "bg-muted/30",
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{monthLabel}</p>
                  {monthRate !== null && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {formatRate(monthRate)} annualized
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                  <span className="text-sm font-semibold tabular-nums">{formatCurrency(monthTotal)}</span>
                  <ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Month detail sheet */}
      <MonthDetailSheet
        open={selectedMonth != null}
        month={selectedMonth}
        events={selectedMonthEvents}
        onClose={() => setSelectedMonth(null)}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      {/* Settings sheet */}
      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        portfolioValue={currentPortfolioValue}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSettingsSave}
      />

      {/* Transfer fullscreen */}
      <TransferFullscreen
        open={transferOpen}
        editingTransferId={editingEvent?.transferId ?? null}
        initialData={
          editingEvent
            ? {
                fromAccountId: editingEvent.account.id,
                toAccountId: editingEvent.toAccount?.id,
                amount: editingEvent.amount,
                date: editingEvent.date.slice(0, 10),
                description: editingEvent.description,
              }
            : null
        }
        allAccounts={modalAccounts}
        onClose={() => { setTransferOpen(false); setEditingEvent(null); }}
        onSaved={handleTransferSaved}
      />

      {/* Delete confirmation */}
      <DeleteConfirmSheet
        event={deletingEvent}
        onClose={() => setDeletingEvent(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
