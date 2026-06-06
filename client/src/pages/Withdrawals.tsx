import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  Plus,
  ArrowUpRight,
  Pencil,
  Trash2,
  ExternalLink,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Settings2,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { DatePicker } from "@/components/DatePicker";
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
import type { WithdrawalEvent, WithdrawalType, InvestmentSettings } from "@/types";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel, StatValue, DisplayStat } from "@/components/Typography";

const CURRENT_YEAR = new Date().getFullYear();

// ── Type label helpers ────────────────────────────────────────────────────────

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
  dividend: "bg-violet-soft text-violet-deep",
  interest: "bg-sky-soft text-sky-deep",
  cap_gains_dist: "bg-blue-soft text-blue-deep",
  sale_proceeds: "bg-warn-soft text-warn-deep",
  return_of_capital: "bg-orange-soft text-orange-deep",
  transfer: "bg-up-soft text-up-deep",
  reinvestment: "bg-rose-soft text-rose-deep",
};

// ── Rate calculation ──────────────────────────────────────────────────────────

function annualizedRate(total: number, months: number, denominator: number): number | null {
  if (denominator <= 0 || months <= 0) return null;
  return (total * (12 / months)) / denominator;
}

function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(2)}%`;
}

// ── Withdrawal Settings Modal ─────────────────────────────────────────────────
// Edits both the portfolio denominator and the target withdrawal rate in one place.

function WithdrawalSettingsModal({
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
    const targetVal = targetPct !== ""
      ? (parseFloat(targetPct) / 100 || null)
      : null;
    await onSave({
      withdrawalRateDenominator: denominatorVal,
      withdrawalRateTarget: targetVal,
    });
    setSaving(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Withdrawal Rate Settings">
      <div className="space-y-6">
        {/* Portfolio denominator */}
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium mb-0.5">Portfolio Denominator</p>
            <p className="tp-caption">
              The value used as the denominator when calculating your withdrawal rate. Override
              with your portfolio value at retirement to track against a fixed baseline.
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              checked={!useOverride}
              onChange={() => setUseOverride(false)}
              className="accent-primary"
            />
            <span className="text-sm">Use current portfolio value ({formatCurrency(portfolioValue)})</span>
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
                type="text"
                inputMode="decimal"
                value={denominator}
                onChange={(e) => setDenominator(e.target.value)}
                autoFocus
                className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="e.g. 2500000"
              />
            </div>
          )}
        </div>

        <div className="border-t border-border" />

        {/* Target withdrawal rate */}
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium mb-0.5">Target Withdrawal Rate</p>
            <p className="tp-caption">
              Your desired annual withdrawal rate as a percentage. Leave blank to track without
              a target. The common guideline is 4%.
            </p>
          </div>
          <div className="relative w-36">
            <input
              type="text"
              inputMode="decimal"
              value={targetPct}
              onChange={(e) => setTargetPct(e.target.value)}
              className="w-full rounded-md border border-border pl-3 pr-7 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="e.g. 4.0"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Add / Edit Transfer Modal ─────────────────────────────────────────────────

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

function TransferModal({
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
  const [errors, setErrors] = useState<{ fromAccountId?: string; toAccountId?: string; amount?: string; date?: string }>({});
  const [saveError, setSaveError] = useState<string | null>(null);

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
      setErrors({});
      setSaveError(null);
    }
  }, [open, initialData]);

  const selectedFromAccount = allAccounts.find((a) => a.id === form.fromAccountId);
  const selectedToAccount = allAccounts.find((a) => a.id === form.toAccountId);
  // Managed notice applies to whichever side is the investment account
  const managedInvestmentAccount =
    selectedFromAccount?.type === "INVESTMENT" && selectedFromAccount.isManaged
      ? selectedFromAccount
      : selectedToAccount?.type === "INVESTMENT" && selectedToAccount.isManaged
      ? selectedToAccount
      : null;
  const isPastOrToday = form.date <= today;

  const set = (field: keyof TransferFormData) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setErrors((er) => ({ ...er, [field]: undefined }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: typeof errors = {};
    if (!form.fromAccountId) newErrors.fromAccountId = "Select a source account";
    if (!form.toAccountId) newErrors.toAccountId = "Select a destination account";
    const amount = parseFloat(form.amount);
    if (!form.amount || isNaN(amount) || amount <= 0) newErrors.amount = "Enter a valid amount";
    if (!form.date) newErrors.date = "Date is required";
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setSaving(true);
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
        // Past/today → immediately confirmed, no balance impact
        // Future → unconfirmed, balance impact applied when date arrives
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
      setSaveError("Failed to save transfer. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingTransferId ? "Edit Transfer" : "Record Portfolio Withdrawal"}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {/* From account */}
        <div>
          <label className="block text-xs font-medium mb-1">From Account</label>
          <div className="relative">
            <select
              value={form.fromAccountId}
              onChange={set("fromAccountId")}
              className="w-full appearance-none rounded-md border py-2 pl-2 pr-6 text-sm text-foreground"
              style={errors.fromAccountId ? { borderColor: "var(--color-down)" } : undefined}
            >
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
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
          </div>
          {errors.fromAccountId && <p className="mt-1 text-xs text-down">{errors.fromAccountId}</p>}
        </div>

        {/* To account */}
        <div>
          <label className="block text-xs font-medium mb-1">To Account</label>
          <div className="relative">
            <select
              value={form.toAccountId}
              onChange={set("toAccountId")}
              className="w-full appearance-none rounded-md border py-2 pl-2 pr-6 text-sm text-foreground"
              style={errors.toAccountId ? { borderColor: "var(--color-down)" } : undefined}
            >
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
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
          </div>
          {errors.toAccountId && <p className="mt-1 text-xs text-down">{errors.toAccountId}</p>}
        </div>

        {/* Amount + Date */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={form.amount}
                onChange={set("amount")}
                className={`w-full rounded-md border pl-7 pr-3 py-2 text-sm focus:outline-none focus:ring-1 ${errors.amount ? "border-down focus:border-down focus:ring-down/30" : "border-border focus:border-primary focus:ring-primary"}`}
                placeholder="0.00"
              />
            </div>
            {errors.amount && <p className="mt-1 text-xs text-down">{errors.amount}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Date</label>
            <DatePicker
              value={form.date}
              onChange={(v) => { setForm((f) => ({ ...f, date: v })); setErrors((er) => ({ ...er, date: undefined })); }}
              invalid={!!errors.date}
              className="w-full"
            />
            {errors.date && <p className="mt-1 text-xs text-down">{errors.date}</p>}
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-medium mb-1">Description <span className="font-normal text-muted-foreground">(optional)</span></label>
          <input
            type="text"
            value={form.description}
            onChange={set("description")}
            placeholder="Portfolio withdrawal"
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium mb-1">Notes <span className="font-normal text-muted-foreground">(optional)</span></label>
          <textarea
            value={form.notes}
            onChange={set("notes")}
            rows={2}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        </div>

        {/* Managed account notice */}
        {managedInvestmentAccount && (
          <div className="rounded-md bg-warn-soft border border-warn-line px-3 py-2 text-sm text-warn-deep">
            Since <strong>{managedInvestmentAccount.name}</strong> is a managed account, its balance
            won't be adjusted automatically. Update it manually once the transfer is complete.
          </div>
        )}

        {/* Future transfer notice */}
        {!isPastOrToday && !editingTransferId && (
          <div className="rounded-md bg-sky-soft border border-sky-soft px-3 py-2 text-sm text-sky-deep">
            This is a future transfer. Account balances will be updated automatically when the
            date arrives.
          </div>
        )}

        {saveError && <p className="text-sm text-down">{saveError}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : editingTransferId ? "Save Changes" : "Record Transfer"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Row components ────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: WithdrawalType }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-10 font-semibold whitespace-nowrap ${TYPE_COLORS[type]}`}>
      {TYPE_LABELS[type]}
    </span>
  );
}

function WithdrawalRow({
  event,
  onEdit,
  onDelete,
}: {
  event: WithdrawalEvent;
  onEdit: (event: WithdrawalEvent) => void;
  onDelete: (event: WithdrawalEvent) => void;
}) {
  const isIncome = !event.isEditable;

  return (
    <tr className="group bg-white hover:bg-muted">
      {/* Date */}
      <td className="py-2.5 pl-6 pr-2 text-13 whitespace-nowrap">
        <span className={isIncome ? "text-muted-foreground" : ""}>
          {formatDate(event.date)}
        </span>
      </td>

      {/* Type */}
      <td className="py-2.5 px-2">
        <TypeBadge type={event.type} />
      </td>

      {/* Description */}
      <td className="py-2.5 px-2 text-13 min-w-0 max-w-[200px] truncate">
        <span className={isIncome ? "text-muted-foreground" : "font-medium"}>
          {event.description || "—"}
        </span>
      </td>

      {/* Account */}
      <td className="py-2.5 px-2 text-13">
        <span className={isIncome ? "text-muted-foreground" : ""}>
          {event.type === "transfer" && event.toAccount ? (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <span className="truncate max-w-[160px]">{event.account.name}</span>
              <ArrowUpRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
              <span className="truncate max-w-[160px]">{event.toAccount.name}</span>
            </span>
          ) : (
            event.account.name
          )}
        </span>
      </td>

      {/* Amount */}
      <td className="py-2.5 px-2 text-right tp-numeric font-semibold whitespace-nowrap">
        <span className={
          isIncome
            ? "text-muted-foreground"
            : parseFloat(event.amount) > 0 && event.type !== "reinvestment"
            ? "text-foreground"
            : "text-up"
        }>
          {event.type === "reinvestment" ? "−" : ""}{formatCurrency(event.amount)}
        </span>
      </td>

      {/* Actions */}
      <td className="py-2.5 pl-2 pr-4 text-right">
        {isIncome ? (
          event.incomeId && (
            <Link
              to="/income"
              title="Recorded in Income — click to view"
              className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )
        ) : (
          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={() => onEdit(event)}
              className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Edit transfer"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onDelete(event)}
              className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-down"
              title="Delete transfer"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ── Month section ─────────────────────────────────────────────────────────────

function MonthSection({
  month,
  events,
  denominator,
  defaultCollapsed,
  onEdit,
  onDelete,
}: {
  month: string; // "YYYY-MM"
  events: WithdrawalEvent[];
  denominator: number | null;
  defaultCollapsed: boolean;
  onEdit: (event: WithdrawalEvent) => void;
  onDelete: (event: WithdrawalEvent) => void;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const total = events.reduce(
    (s, e) => s + (e.type === "reinvestment" ? -1 : 1) * parseFloat(e.amount),
    0
  );

  const label = new Date(`${month}-01T12:00:00`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  // For monthly annualized rate we use 1 month (the display is per-month annualized)
  const rate = denominator ? annualizedRate(total, 1, denominator) : null;

  const ChevronIcon = collapsed ? ChevronRight : ChevronDown;

  return (
    <div>
      {/* Month header */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center pl-6 pr-2 py-2 bg-muted border-b border-border hover:bg-muted-hover transition-colors text-left"
      >
        <span className="tp-panel-title flex-1">{label}</span>
        {rate !== null && (
          <StatValue className="tp-caption mr-4">
            {formatRate(rate)} annualized
          </StatValue>
        )}
        <StatValue className="w-[110px] text-right">{formatCurrency(total)}</StatValue>
        <span className="w-[72px] flex items-center justify-center">
          <ChevronIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      </button>

      {/* Rows */}
      {!collapsed && (
        <table className="w-full table-fixed text-13">
          <colgroup>
            <col className="w-[90px]" />
            <col className="w-[130px]" />
            {/* Description – flexible */}<col />
            <col className="w-[320px]" />
            <col className="w-[110px]" />
            <col className="w-[72px]" />
          </colgroup>
          <tbody className="divide-y divide-border/50">
            {events.map((event) => (
              <WithdrawalRow
                key={event.id}
                event={event}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function WithdrawalsPage() {
  const navigate = useNavigate();
  const [year, setYear] = useState(CURRENT_YEAR);

  const { data: settings, refetch: refetchSettings } = useApi(
    () => getInvestmentSettings(),
    []
  );
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);

  // Transfer modal state
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<WithdrawalEvent | null>(null);

  // Delete confirmation
  const [deletingEvent, setDeletingEvent] = useState<WithdrawalEvent | null>(null);

  const { data: events, refetch } = useApi(() => getWithdrawals(year), [year]);
  const { data: summary, refetch: refetchSummary } = useApi(
    () => getWithdrawalSummary(year),
    [year]
  );
  const { data: investmentAccountsData } = useApi(() => getInvestmentAccounts(), []);
  const { isDemoMode, demoFactor } = useDemo();
  const currentPortfolioValue = useMemo(
    () => {
      const raw = (investmentAccountsData ?? []).reduce((sum, a) => sum + a.totalMarketValue, 0);
      return isDemoMode ? raw * demoFactor : raw;
    },
    [investmentAccountsData, isDemoMode, demoFactor]
  );

  // Accounts for the transfer modal (non-joint investment + banking only)
  const { data: allAccountsData } = useApi(() => getAccounts(), []);
  const { data: dataRange } = useApi(() => getDataRange(), []);
  const modalAccounts = useMemo<ModalAccount[]>(
    () =>
      (allAccountsData ?? [])
        .filter(
          (a) =>
            !a.isJoint &&
            a.isActive &&
            (a.type === "INVESTMENT" || a.type === "CHECKING" || a.type === "SAVINGS")
        )
        .map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          isManaged: a.isManaged ?? false,
        })),
    [allAccountsData]
  );

  // Keyboard shortcut: "a" to open add transfer modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === "a" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLSelectElement)
      ) {
        setEditingEvent(null);
        setTransferModalOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleSettingsSave = async (patch: Partial<InvestmentSettings>) => {
    await updateInvestmentSettings(patch);
    refetchSettings();
  };

  const handleEdit = useCallback((event: WithdrawalEvent) => {
    setEditingEvent(event);
    setTransferModalOpen(true);
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

  // Group events by month, descending
  const monthGroups = useMemo(() => {
    if (!events) return [];
    const groups: Record<string, WithdrawalEvent[]> = {};
    for (const e of events) {
      const key = e.date.slice(0, 7); // "YYYY-MM"
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [events]);

  // YTD metrics
  const ytdTotal = summary?.ytdTotal ?? 0;
  const ytdMonths = summary?.ytdMonths ?? 1;

  const effectiveDenominator =
    settings?.withdrawalRateDenominator ?? currentPortfolioValue;
  const ytdRate = annualizedRate(ytdTotal, ytdMonths, effectiveDenominator);
  const targetRate = settings?.withdrawalRateTarget ?? null;

  if (!events) return <BeaconLoader />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/investments")}
            className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2 className="tp-page-title">Withdrawals</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSettingsModalOpen(true)}
            className="tp-nav-link hover:bg-muted hover:text-ink"
            title="Withdrawal rate settings"
          >
            <Settings2 className="h-4 w-4" />
            Settings
          </button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setYear((y) => y - 1)} disabled={dataRange ? year <= dataRange.minYear : false}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[4rem] text-center font-semibold">{year}</span>
            <Button variant="ghost" size="sm" onClick={() => setYear((y) => y + 1)} disabled={dataRange ? year >= dataRange.maxYear : false}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <Button onClick={() => { setEditingEvent(null); setTransferModalOpen(true); }}>
            <Plus className="h-4 w-4" />
            Add Transfer
          </Button>
        </div>
      </div>

      {/* Summary row */}
      <Card className="p-6">
        <div className="flex items-start gap-9 flex-wrap">
          <div>
            <SectionLabel className="mb-0.5">
              YTD Total
            </SectionLabel>
            <DisplayStat as="p" className="tp-kpi-l">{formatCurrency(ytdTotal)}</DisplayStat>
          </div>
          <div className="w-px self-stretch bg-border hidden sm:block" />
          <div>
            <SectionLabel className="mb-0.5">
              Annualized Rate (YTD)
            </SectionLabel>
            <div className="flex items-baseline gap-2">
              <DisplayStat as="p" className="tp-kpi-l">
                {effectiveDenominator > 0 ? formatRate(ytdRate) : "—"}
              </DisplayStat>
              {targetRate !== null && effectiveDenominator > 0 && ytdRate !== null && (
                <span className={`text-sm font-medium tabular-nums font-mono ${
                  ytdRate <= targetRate ? "text-up" : "text-down"
                }`}>
                  {ytdRate <= targetRate
                    ? `▼ ${((targetRate - ytdRate) * 100).toFixed(2)}% under target`
                    : `▲ ${((ytdRate - targetRate) * 100).toFixed(2)}% over target`}
                </span>
              )}
            </div>
            {targetRate !== null && (
              <p className="tp-caption mt-0.5">
                target: {(targetRate * 100).toFixed(2)}%
              </p>
            )}
          </div>
        </div>
        {effectiveDenominator === 0 && investmentAccountsData !== undefined && (
          <p className="mt-2 tp-caption">
            <button
              onClick={() => setSettingsModalOpen(true)}
              className="text-primary underline underline-offset-2"
            >
              Configure withdrawal rate settings
            </button>{" "}
            to calculate your withdrawal rate.
          </p>
        )}
      </Card>

      {/* Month-grouped table */}
      {events === undefined ? (
        <Card className="p-8 text-center text-muted-foreground text-sm">Loading…</Card>
      ) : monthGroups.length === 0 ? (
        <Card className="p-8 text-center">
          <ArrowUpRight className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="font-semibold mb-1">No withdrawals recorded for {year}</p>
          <p className="text-sm text-muted-foreground mb-4">
            Dividends and interest will appear here automatically. Add a transfer to record a
            brokerage withdrawal.
          </p>
          <Button onClick={() => { setEditingEvent(null); setTransferModalOpen(true); }}>
            <Plus className="h-4 w-4" />
            Add Transfer
          </Button>
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden divide-y divide-border">
          {/* Table header */}
          <SectionLabel as="div" className="hidden md:grid py-2"
            style={{ gridTemplateColumns: "90px 130px 1fr 320px 110px 72px" }}>
            <span className="pl-6 pr-2">Date</span>
            <span className="px-2">Type</span>
            <span className="px-2">Description</span>
            <span className="px-2">Account</span>
            <span className="px-2 text-right">Amount</span>
            <span />
          </SectionLabel>

          {monthGroups.map(([month, monthEvents]) => {
            const currentMonth = new Date().toLocaleDateString("en-CA").slice(0, 7);
            return (
              <MonthSection
                key={month}
                month={month}
                events={monthEvents}
                denominator={effectiveDenominator > 0 ? effectiveDenominator : null}
                defaultCollapsed={month !== currentMonth}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            );
          })}
        </Card>
      )}

      {/* Modals */}
      <WithdrawalSettingsModal
        open={settingsModalOpen}
        settings={settings}
        portfolioValue={currentPortfolioValue}
        onClose={() => setSettingsModalOpen(false)}
        onSave={handleSettingsSave}
      />

      <TransferModal
        open={transferModalOpen}
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
        onClose={() => { setTransferModalOpen(false); setEditingEvent(null); }}
        onSaved={handleTransferSaved}
      />

      {/* Delete confirmation */}
      <Modal
        open={!!deletingEvent}
        onClose={() => setDeletingEvent(null)}
        title="Delete Transfer"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete this transfer record? This only removes the record
            from Beacon — it does not reverse any account balance changes.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeletingEvent(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
            >
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
