import { useState, useEffect } from "react";
import { PERSONAL_COLOR, JOINT_COLOR } from "@/lib/accountColors";
import { Plus, X, ChevronDown, Landmark, CreditCard, TrendingUp, EyeOff, Eye, ArrowRight, Trash2, Check, Pencil } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { getAccounts, createAccount, updateAccount, deleteAccount, getInvestmentHoldings, getRecurrenceRules } from "@/api";
import { cn } from "@/lib/utils";
import { useDemo } from "@/context/DemoContext";
import type { Account, TaxAdvantageType } from "@/types";

const ACCOUNT_COLORS = [
  "#e2e2df", "#d2d2cf", "#e2cfc4", "#f7d9c4", "#faedcb",
  "#c9e4de", "#c6def1", "#dbcdf0", "#f2c6de", "#f9c6c9",
];

const accountTypeLabels: Record<string, string> = {
  CHECKING: "Checking",
  SAVINGS: "Savings",
  CREDIT_CARD: "Credit Card",
  INVESTMENT: "Investment",
};

function nextDayOfMonth(day: number): string {
  const today = new Date();
  const todayDay = today.getDate();
  let month = today.getMonth();
  let year = today.getFullYear();
  if (day <= todayDay) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  const d = new Date(year, month, day);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Account row ───────────────────────────────────────────────────────────────

function AccountRow({ account, allAccounts, onTap }: { account: Account; allAccounts: Account[]; onTap: () => void }) {
  return (
    <button
      type="button"
      onClick={onTap}
      className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left"
    >
      <div
        className="h-8 w-8 shrink-0 rounded-md"
        style={account.color ? { backgroundColor: account.color } : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium leading-snug">{account.name}</span>
          {account.isManaged && (
            <span className="rounded-full bg-blue-600 text-white text-[10px] font-semibold px-1.5 py-0.5 uppercase tracking-wide">
              Managed
            </span>
          )}
          {account.isTaxAdvantaged && (
            <span className="rounded-full bg-emerald-600 text-white text-[10px] font-semibold px-1.5 py-0.5 uppercase tracking-wide">
              {account.taxAdvantageType === "TRADITIONAL" ? "Traditional"
                : account.taxAdvantageType === "ROTH" ? "Roth"
                : account.taxAdvantageType === "HSA" ? "HSA"
                : account.taxAdvantageType === "PLAN_529" ? "529"
                : "Tax-Adv"}
            </span>
          )}
        </div>
        {account.type === "CREDIT_CARD" && (account.closingDay != null || account.dueDay != null) && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {account.closingDay != null && `Closes ${nextDayOfMonth(account.closingDay)}`}
            {account.closingDay != null && account.dueDay != null && " · "}
            {account.dueDay != null && `Due ${nextDayOfMonth(account.dueDay)}`}
          </p>
        )}
        {account.type === "INVESTMENT" && account.dividendElection && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            {account.dividendElection === "CASH" ? (
              <>
                <span>Cash</span>
                <ArrowRight className="h-3 w-3" />
                <span>
                  {account.defaultCashAccountId
                    ? (allAccounts.find((a) => a.id === account.defaultCashAccountId)?.name ?? "Unknown")
                    : "Unset"}
                </span>
              </>
            ) : account.dividendElection === "REINVEST" ? (
              <span>Reinvest</span>
            ) : (
              <span>Ask</span>
            )}
          </p>
        )}
      </div>
      {account.isHidden && <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />}
      <Pencil className="h-4 w-4 shrink-0 text-muted-foreground/40" />
    </button>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function MobileAccounts() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const { data: accounts, refetch } = useApi(() => getAccounts({ includeHidden: true }), []);
  const { isDemoMode, toggleDemoMode } = useDemo();

  const handleSave = async (data: Partial<Account>) => {
    if (editing) {
      await updateAccount(editing.id, data);
    } else {
      await createAccount(data);
    }
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const handleDelete = async (id: string) => {
    await deleteAccount(id);
    setModalOpen(false);
    setEditing(null);
    refetch();
  };

  const openAdd = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (account: Account) => { setEditing(account); setModalOpen(true); };

  if (!accounts) return null;

  const renderSection = (
    label: string,
    icon: React.ComponentType<{ className?: string }>,
    types: Account["type"][],
    isJoint: boolean,
  ) => {
    const Icon = icon;
    const items = accounts.filter((a) => (types as string[]).includes(a.type) && a.isJoint === isJoint);
    if (items.length === 0) return null;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          <span>{label}</span>
        </div>
        <div className="space-y-2">
          {items.map((a) => (
            <AccountRow key={a.id} account={a} allAccounts={accounts} onTap={() => openEdit(a)} />
          ))}
        </div>
      </div>
    );
  };

  const renderOwnership = (ownership: "Personal" | "Joint") => {
    const isJoint = ownership === "Joint";
    const sections = [
      renderSection("Banking", Landmark, ["CHECKING", "SAVINGS"], isJoint),
      renderSection("Investments", TrendingUp, ["INVESTMENT"], isJoint),
      renderSection("Credit Cards", CreditCard, ["CREDIT_CARD"], isJoint),
    ].filter(Boolean);
    if (sections.length === 0) return null;
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white" style={{ backgroundColor: isJoint ? JOINT_COLOR : PERSONAL_COLOR }}>
            {isJoint ? "J" : "P"}
          </span>
          <span className="text-sm font-semibold uppercase tracking-wider">{ownership}</span>
        </div>
        <div className="space-y-5">{sections}</div>
      </div>
    );
  };

  const hasPersonal = accounts.some((a) => !a.isJoint);
  const hasJoint = accounts.some((a) => a.isJoint);

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Accounts</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleDemoMode}
              title={isDemoMode ? "Disable demo mode" : "Enable demo mode"}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isDemoMode
                  ? "bg-amber-100 text-amber-700"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              {isDemoMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              Demo
            </button>
            <button
              type="button"
              onClick={openAdd}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            >
              <Plus className="h-4 w-4" />
              Add
            </button>
          </div>
        </div>

        {accounts.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-6 py-12 text-center">
            <Landmark className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">No accounts</p>
            <p className="mt-1 text-xs text-muted-foreground">Add your bank accounts, credit cards, and investments.</p>
            <button
              type="button"
              onClick={openAdd}
              className="mt-4 flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground mx-auto"
            >
              <Plus className="h-4 w-4" />
              Add Account
            </button>
          </div>
        ) : (
          <div className="space-y-8">
            {hasPersonal && renderOwnership("Personal")}
            {hasJoint && renderOwnership("Joint")}
          </div>
        )}
      </div>

      {modalOpen && (
        <MobileAccountModal
          account={editing}
          allAccounts={accounts}
          onClose={() => { setModalOpen(false); setEditing(null); }}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}
    </>
  );
}

// ── Add / Edit modal ──────────────────────────────────────────────────────────

interface HideWarning {
  hasBalance: boolean;
  activeRecurringCount: number;
  pendingData: Partial<Account>;
}

function MobileAccountModal({
  account,
  allAccounts,
  onClose,
  onSave,
  onDelete,
}: {
  account: Account | null;
  allAccounts: Account[];
  onClose: () => void;
  onSave: (data: Partial<Account>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [accountType, setAccountType] = useState<Account["type"]>(account?.type ?? "CHECKING");
  const [selectedColor, setSelectedColor] = useState(account?.color ?? ACCOUNT_COLORS[0]);
  const [isJoint, setIsJoint] = useState(account?.isJoint ?? false);
  const [isTaxAdvantaged, setIsTaxAdvantaged] = useState(account?.isTaxAdvantaged ?? false);
  const [taxAdvantageType, setTaxAdvantageType] = useState<TaxAdvantageType | "">(account?.taxAdvantageType ?? "");
  const [isManaged, setIsManaged] = useState(account?.isManaged ?? false);
  const [isHidden, setIsHidden] = useState(account?.isHidden ?? false);
  const [closingDay, setClosingDay] = useState(account?.closingDay?.toString() ?? "");
  const [dueDay, setDueDay] = useState(account?.dueDay?.toString() ?? "");
  const [linkedBankAccountId, setLinkedBankAccountId] = useState(account?.linkedBankAccountId ?? "");
  const [dividendElection, setDividendElection] = useState(account?.dividendElection ?? "");
  const [defaultCashAccountId, setDefaultCashAccountId] = useState(account?.defaultCashAccountId ?? "");
  const [hasTrackedHoldings, setHasTrackedHoldings] = useState(false);
  const [hideWarning, setHideWarning] = useState<HideWarning | null>(null);

  const bankAccounts = allAccounts.filter(
    (a) => (a.type === "CHECKING" || a.type === "SAVINGS") && a.isActive && !a.isHidden && a.id !== account?.id
  );

  // Lock body scroll while open
  useEffect(() => {
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
  }, []);

  useEffect(() => {
    if (account?.type === "INVESTMENT") {
      getInvestmentHoldings(account.id).then((holdings) => {
        setHasTrackedHoldings(holdings.some((h) => !h.isManaged));
      }).catch(() => setHasTrackedHoldings(false));
    }
  }, [account]);

  const buildData = (form: FormData): Partial<Account> => {
    const data: Partial<Account> = {
      name: form.get("name") as string,
      type: accountType,
      color: selectedColor,
      isJoint,
      isManaged: accountType === "INVESTMENT" ? isManaged : false,
      isTaxAdvantaged: accountType !== "CREDIT_CARD" ? isTaxAdvantaged : false,
      taxAdvantageType: accountType !== "CREDIT_CARD" && isTaxAdvantaged ? (taxAdvantageType || null) : null,
      isHidden,
    };
    if (accountType === "CREDIT_CARD") {
      data.closingDay = closingDay ? parseInt(closingDay) : null;
      data.dueDay = dueDay ? parseInt(dueDay) : null;
      data.linkedBankAccountId = linkedBankAccountId || null;
    } else {
      data.closingDay = null;
      data.dueDay = null;
      data.linkedBankAccountId = null;
    }
    if (accountType === "INVESTMENT") {
      data.dividendElection = (dividendElection as Account["dividendElection"]) || null;
      data.defaultCashAccountId = dividendElection === "CASH" ? (defaultCashAccountId || null) : null;
    } else {
      data.dividendElection = null;
      data.defaultCashAccountId = null;
    }
    return data;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const data = buildData(form);

    if (account && isHidden && !account.isHidden) {
      const hasBalance = parseFloat(account.balance) !== 0;
      const rules = await getRecurrenceRules();
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const activeRecurringCount = rules.filter(
        (r) => r.accountId === account.id && r.isActive && (!r.endDate || new Date(r.endDate) > today)
      ).length;
      if (hasBalance || activeRecurringCount > 0) {
        setHideWarning({ hasBalance, activeRecurringCount, pendingData: data });
        return;
      }
    }

    setSaving(true);
    await onSave(data);
    setSaving(false);
  };

  const confirmHide = async () => {
    if (!hideWarning) return;
    setSaving(true);
    setHideWarning(null);
    await onSave(hideWarning.pendingData);
    setSaving(false);
  };

  const handleDeleteClick = async () => {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    if (!account) return;
    setDeleting(true);
    await onDelete(account.id);
    setDeleting(false);
  };

  // Hide warning overlay
  if (hideWarning) {
    const messages: string[] = [];
    if (hideWarning.hasBalance) messages.push("a non-zero balance");
    if (hideWarning.activeRecurringCount > 0)
      messages.push(`${hideWarning.activeRecurringCount} active recurring transaction${hideWarning.activeRecurringCount > 1 ? "s" : ""}`);
    return (
      <div className="fixed inset-0 z-[60] flex flex-col bg-background">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="text-base font-semibold">Hide Account</h2>
          <button type="button" onClick={() => setHideWarning(null)} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
          <p className="text-sm">
            This account has {messages.join(" and ")}. Are you sure you want to hide it?
          </p>
          <p className="text-sm text-muted-foreground">
            The account will be hidden from dropdowns and the Investments page, but all existing data will be preserved.
          </p>
        </div>
        <div className="shrink-0 border-t border-border p-4">
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setHideWarning(null)}
              className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={confirmHide}
              className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity"
            >
              {saving ? "Saving…" : "Hide Anyway"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-base font-semibold">{account ? "Edit Account" : "Add Account"}</h2>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Scrollable form */}
      <form id="mobile-account-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-5 p-4">

          {/* Name */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">Name</label>
            <input
              name="name"
              type="text"
              required
              defaultValue={account?.name ?? ""}
              placeholder="e.g. Chase Checking"
              className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>

          {/* Type */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">Type</label>
            <div className="relative">
              <select
                name="type"
                required
                value={accountType}
                onChange={(e) => {
                  const t = e.target.value as Account["type"];
                  setAccountType(t);
                  if (t !== "INVESTMENT") setIsManaged(false);
                }}
                className="w-full appearance-none rounded-md border border-border py-2.5 pl-3 pr-8 text-sm text-foreground"
              >
                {Object.entries(accountTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            </div>
          </div>


          {/* Color */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">Color</label>
            <div className="grid grid-cols-10 gap-2">
              {ACCOUNT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setSelectedColor(color)}
                  style={{ backgroundColor: color }}
                  className={`aspect-square w-full rounded-md transition-transform ${
                    selectedColor === color ? "scale-110 ring-2 ring-border ring-offset-1" : ""
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Joint */}
          <button
            type="button"
            onClick={() => setIsJoint((v) => !v)}
            className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm transition-colors ${
              isJoint ? "border-primary bg-primary/5" : "border-border"
            }`}
          >
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
              isJoint ? "border-primary bg-primary" : "border-border"
            }`}>
              {isJoint && <Check className="h-3 w-3 text-white" />}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className={isJoint ? "text-primary" : ""}>Joint account</span>
              <span className="text-xs text-muted-foreground">Transactions from joint accounts are shared expenses/income</span>
            </span>
          </button>

          {/* Tax-advantaged */}
          {accountType !== "CREDIT_CARD" && (
            <div>
              <button
                type="button"
                onClick={() => { setIsTaxAdvantaged((v) => !v); if (isTaxAdvantaged) setTaxAdvantageType(""); }}
                className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm transition-colors ${
                  isTaxAdvantaged ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                  isTaxAdvantaged ? "border-primary bg-primary" : "border-border"
                }`}>
                  {isTaxAdvantaged && <Check className="h-3 w-3 text-white" />}
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className={isTaxAdvantaged ? "text-primary" : ""}>Tax-advantaged account</span>
                  <span className="text-xs text-muted-foreground">IRA, 401(k), HSA, 529, or similar. Investment sales and dividends will not generate income records.</span>
                </span>
              </button>
              {isTaxAdvantaged && (
                <div className="relative mt-2">
                  <select
                    value={taxAdvantageType}
                    onChange={(e) => setTaxAdvantageType(e.target.value as TaxAdvantageType | "")}
                    className="w-full appearance-none rounded-md border border-border py-2.5 pl-3 pr-8 text-sm text-foreground"
                  >
                    <option value="">Select type…</option>
                    <option value="TRADITIONAL">Traditional IRA / 401(k)</option>
                    <option value="ROTH">Roth IRA / 401(k)</option>
                    <option value="HSA">HSA</option>
                    <option value="PLAN_529">529</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              )}
            </div>
          )}

          {/* Managed (investment only) */}
          {accountType === "INVESTMENT" && (
            <div className={`rounded-md border border-border p-3 ${hasTrackedHoldings ? "opacity-60" : ""}`}>
              <label className={`flex items-center gap-2 ${hasTrackedHoldings ? "cursor-not-allowed" : "cursor-pointer"}`}>
                <input
                  type="checkbox"
                  checked={isManaged}
                  disabled={hasTrackedHoldings}
                  onChange={(e) => setIsManaged(e.target.checked)}
                  className="h-4 w-4 rounded border-border disabled:cursor-not-allowed"
                />
                <span className="text-sm font-medium">Managed / robo-advisor account</span>
              </label>
              <p className="mt-1 ml-6 text-xs text-muted-foreground">
                {hasTrackedHoldings
                  ? "Cannot enable — this account already has holdings with lot-level purchase dates."
                  : "Lot-level acquisition dates are unavailable. Enter total shares and cost basis per holding."}
              </p>
            </div>
          )}

          {/* Credit card settings */}
          {accountType === "CREDIT_CARD" && (
            <div className="space-y-4 rounded-md border border-border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Credit Card Settings</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Closing Day</label>
                  <input
                    type="number"
                    min={1}
                    max={28}
                    value={closingDay}
                    onChange={(e) => setClosingDay(e.target.value)}
                    inputMode="numeric"
                    placeholder="e.g. 15"
                    className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Day billing cycle closes</p>
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Due Day</label>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={dueDay}
                    onChange={(e) => setDueDay(e.target.value)}
                    inputMode="numeric"
                    placeholder="e.g. 8"
                    className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Day payment is due</p>
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Paid from Account</label>
                <div className="relative">
                  <select
                    value={linkedBankAccountId}
                    onChange={(e) => setLinkedBankAccountId(e.target.value)}
                    className="w-full appearance-none rounded-md border border-border py-2.5 pl-3 pr-8 text-sm text-foreground"
                  >
                    <option value="">— None selected —</option>
                    {bankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Which bank account pays this card</p>
              </div>
            </div>
          )}

          {/* Dividend settings (investment only) */}
          {accountType === "INVESTMENT" && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dividend Settings</p>
              <div>
                <label className="mb-1.5 block text-sm font-medium">Default Election</label>
                <div className="relative">
                  <select
                    value={dividendElection}
                    onChange={(e) => setDividendElection(e.target.value)}
                    className="w-full appearance-none rounded-md border border-border py-2.5 pl-3 pr-8 text-sm text-foreground"
                  >
                    <option value="">Ask each time</option>
                    <option value="REINVEST">Always reinvest (DRIP)</option>
                    <option value="CASH">Always pay as cash</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
              {dividendElection === "CASH" && (
                <div>
                  <label className="mb-1.5 block text-sm font-medium">Deposit to Account</label>
                  <div className="relative">
                    <select
                      value={defaultCashAccountId}
                      onChange={(e) => setDefaultCashAccountId(e.target.value)}
                      className="w-full appearance-none rounded-md border border-border py-2.5 pl-3 pr-8 text-sm text-foreground"
                    >
                      <option value="">— None selected —</option>
                      {bankAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Where cash dividends are deposited</p>
                </div>
              )}
            </div>
          )}

          {/* Hide account (edit only) */}
          {account && (
            <button
              type="button"
              onClick={() => setIsHidden((v) => !v)}
              className={`flex w-full items-center gap-3 rounded-md border px-3 py-3 text-left text-sm transition-colors ${
                isHidden ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                isHidden ? "border-primary bg-primary" : "border-border"
              }`}>
                {isHidden && <Check className="h-3 w-3 text-white" />}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className={isHidden ? "text-primary" : ""}>Hide account</span>
                <span className="text-xs text-muted-foreground">Hidden accounts are excluded from dropdowns and the Investments page, but all data is preserved.</span>
              </span>
            </button>
          )}
        </div>
      </form>

      {/* Sticky footer */}
      <div className="shrink-0 border-t border-border p-4">
        <div className="flex gap-3">
          {account && (
            confirmDelete ? (
              <button
                type="button"
                disabled={deleting}
                onClick={handleDeleteClick}
                className="rounded-md bg-destructive px-3 py-2.5 text-sm font-medium text-destructive-foreground disabled:opacity-50 transition-colors"
              >
                {deleting ? "Deleting…" : "Confirm?"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-md border border-border p-2.5 text-muted-foreground hover:border-destructive hover:text-destructive transition-colors"
                aria-label="Delete account"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-border py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="mobile-account-form"
            disabled={saving}
            className="flex-1 rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50 transition-opacity"
          >
            {saving ? "Saving…" : account ? "Save Changes" : "Add Account"}
          </button>
        </div>
      </div>
    </div>
  );
}
