import { useState, useEffect } from "react";
import { Plus, Pencil, Trash2, Landmark, CreditCard, TrendingUp, EyeOff, ArrowRight, ChevronDown } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getAccounts, createAccount, updateAccount, deleteAccount, getInvestmentHoldings, getRecurrenceRules } from "@/api";
import type { Account, TaxAdvantageType } from "@/types";

const accountTypeLabels: Record<string, string> = {
  CHECKING: "Checking",
  SAVINGS: "Savings",
  CREDIT_CARD: "Credit Card",
  INVESTMENT: "Investment",
};

interface GroupDef {
  key: string;
  label: string;
  types: Account["type"][];
  icon: React.ComponentType<{ className?: string }>;
}

const ASSET_GROUPS: GroupDef[] = [
  { key: "banking", label: "Banking", types: ["CHECKING", "SAVINGS"], icon: Landmark },
  { key: "investments", label: "Investments", types: ["INVESTMENT"], icon: TrendingUp },
];

const LIABILITY_GROUPS: GroupDef[] = [
  { key: "credit_cards", label: "Credit Cards", types: ["CREDIT_CARD"], icon: CreditCard },
];

const ASSET_TYPES = new Set(ASSET_GROUPS.flatMap((g) => g.types));
const LIABILITY_TYPES = new Set(LIABILITY_GROUPS.flatMap((g) => g.types));

function nextDayOfMonth(day: number): string {
  const today = new Date();
  const todayDay = today.getDate();
  let month = today.getMonth(); // 0-indexed
  let year = today.getFullYear();
  if (day <= todayDay) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  // Use Date to handle invalid days (e.g., day=31 in a 30-day month)
  const d = new Date(year, month, day);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function Accounts() {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const { data: accounts, refetch } = useApi(() => getAccounts({ includeHidden: true }), []);

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

  const openEdit = (account: Account) => {
    setEditing(account);
    setModalOpen(true);
  };

  if (!accounts) return null;

  const renderGroup = (group: GroupDef, isJoint: boolean) => {
    const groupAccounts = accounts.filter(
      (a) => (group.types as string[]).includes(a.type) && a.isJoint === isJoint
    );
    if (groupAccounts.length === 0) return null;
    const Icon = group.icon;
    return (
      <div key={`${group.key}-${isJoint}`} className="space-y-2">
        <div className="flex items-center justify-between py-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            <Icon className="h-4 w-4" />
            <span>{group.label}</span>
          </div>
        </div>
        <div className="space-y-1.5">
          {groupAccounts.map((account) => (
            <Card key={account.id} className="py-3 px-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="h-7 w-7 flex-shrink-0 rounded-md"
                  style={account.color ? { backgroundColor: account.color } : undefined}
                />
                <span className="font-medium text-sm">{account.name}</span>
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
                      : "Tax-Advantaged"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {account.type === "INVESTMENT" && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Dividend election">
                    {account.dividendElection === "CASH" ? (
                      <>
                        <span>Cash</span>
                        <ArrowRight className="h-3 w-3" />
                        <span>
                          {account.defaultCashAccountId
                            ? (accounts.find((a) => a.id === account.defaultCashAccountId)?.name ?? "Unknown")
                            : "Unset"}
                        </span>
                      </>
                    ) : account.dividendElection === "REINVEST" ? (
                      <span>Reinvest</span>
                    ) : (
                      <span>Ask</span>
                    )}
                  </div>
                )}
                {account.type === "CREDIT_CARD" && (account.closingDay != null || account.dueDay != null) && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {account.closingDay != null && (
                      <span title="Statement closes">Closes {nextDayOfMonth(account.closingDay)}</span>
                    )}
                    {account.closingDay != null && account.dueDay != null && (
                      <span className="text-border">·</span>
                    )}
                    {account.dueDay != null && (
                      <span title="Payment due">Due {nextDayOfMonth(account.dueDay)}</span>
                    )}
                  </div>
                )}
                {account.isHidden && (
                  <span title="Hidden" className="inline-flex flex-shrink-0">
                    <EyeOff className="h-3.5 w-3.5 text-gray-300" />
                  </span>
                )}
                <button onClick={() => openEdit(account)} className="rounded p-1 hover:bg-accent">
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    );
  };

  const renderOwnershipBlock = (ownership: "Personal" | "Joint") => {
    const isJoint = ownership === "Joint";
    const assetGroups = ASSET_GROUPS.map((g) => renderGroup(g, isJoint)).filter(Boolean);
    const liabilityGroups = LIABILITY_GROUPS.map((g) => renderGroup(g, isJoint)).filter(Boolean);
    if (assetGroups.length === 0 && liabilityGroups.length === 0) return null;
    return (
      <div key={ownership} className="space-y-4">
        <div className="flex items-center gap-2">
          <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white ${isJoint ? "bg-blue-500" : "bg-gray-400"}`}>
            {isJoint ? "J" : "P"}
          </span>
          <span className="text-sm font-semibold uppercase tracking-wider">{ownership}</span>
        </div>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div className="space-y-5">{assetGroups}</div>
          <div className="space-y-5">{liabilityGroups}</div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Accounts</h2>
        <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
          <Plus className="h-4 w-4" /> Add Account
        </Button>
      </div>

      {accounts.length > 0 ? (
        <>
          {/* Personal & Joint blocks */}
          <div className="space-y-8">
            {renderOwnershipBlock("Personal")}
            {renderOwnershipBlock("Joint")}
          </div>
        </>
      ) : (
        <Card>
          <EmptyState
            icon={Landmark}
            title="No accounts"
            description="Add your bank accounts, credit cards, and investments."
            action={
              <Button onClick={() => { setEditing(null); setModalOpen(true); }}>
                <Plus className="h-4 w-4" /> Add Account
              </Button>
            }
          />
        </Card>
      )}

      <AccountModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditing(null); }}
        onSave={handleSave}
        onDelete={handleDelete}
        account={editing}
        allAccounts={accounts}
      />
    </div>
  );
}

// ── Account color palette ──

const ACCOUNT_COLORS = [
  "#e2e2df", "#d2d2cf", "#e2cfc4", "#f7d9c4", "#faedcb",
  "#c9e4de", "#c6def1", "#dbcdf0", "#f2c6de", "#f9c6c9",
];

interface AccountModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<Account>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  account: Account | null;
  allAccounts: Account[];
}

interface HideWarning {
  hasBalance: boolean;
  activeRecurringCount: number;
  pendingData: Partial<Account>;
}

function AccountModal({ open, onClose, onSave, onDelete, account, allAccounts }: AccountModalProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isJoint, setIsJoint] = useState(false);
  const [isManaged, setIsManaged] = useState(false);
  const [isTaxAdvantaged, setIsTaxAdvantaged] = useState(false);
  const [taxAdvantageType, setTaxAdvantageType] = useState<TaxAdvantageType | "">("");
  const [isHidden, setIsHidden] = useState(false);
  const [accountType, setAccountType] = useState<Account["type"]>(account?.type ?? "CHECKING");
  const [selectedColor, setSelectedColor] = useState(account?.color ?? ACCOUNT_COLORS[0]);
  // Credit card settings
  const [closingDay, setClosingDay] = useState<string>(account?.closingDay?.toString() ?? "");
  const [dueDay, setDueDay] = useState<string>(account?.dueDay?.toString() ?? "");
  const [linkedBankAccountId, setLinkedBankAccountId] = useState<string>(account?.linkedBankAccountId ?? "");
  // Investment dividend settings
  const [dividendElection, setDividendElection] = useState<string>(account?.dividendElection ?? "");
  const [defaultCashAccountId, setDefaultCashAccountId] = useState<string>(account?.defaultCashAccountId ?? "");
  // True when the account already has holdings with real lot dates — managed toggle is locked off
  const [hasTrackedHoldings, setHasTrackedHoldings] = useState(false);
  const [hideWarning, setHideWarning] = useState<HideWarning | null>(null);

  // Bank accounts available as link targets for CC and investment settings
  const bankAccounts = allAccounts.filter(
    (a) => (a.type === "CHECKING" || a.type === "SAVINGS") && a.isActive && !a.isHidden && a.id !== account?.id
  );

  useEffect(() => {
    if (open) {
      setIsJoint(account?.isJoint ?? false);
      setIsManaged(account?.isManaged ?? false);
      setIsTaxAdvantaged(account?.isTaxAdvantaged ?? false);
      setTaxAdvantageType(account?.taxAdvantageType ?? "");
      setIsHidden(account?.isHidden ?? false);
      setAccountType(account?.type ?? "CHECKING");
      setSelectedColor(account?.color ?? ACCOUNT_COLORS[0]);
      setClosingDay(account?.closingDay?.toString() ?? "");
      setDueDay(account?.dueDay?.toString() ?? "");
      setLinkedBankAccountId(account?.linkedBankAccountId ?? "");
      setDividendElection(account?.dividendElection ?? "");
      setDefaultCashAccountId(account?.defaultCashAccountId ?? "");
      setConfirmDelete(false);
      setHasTrackedHoldings(false);
      setHideWarning(null);
      // For existing investment accounts, check whether any holdings have real lot dates
      if (account?.type === "INVESTMENT") {
        getInvestmentHoldings(account.id).then((holdings) => {
          setHasTrackedHoldings(holdings.some((h) => !h.isManaged));
        }).catch(() => setHasTrackedHoldings(false));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    if (!account && (accountType === "CHECKING" || accountType === "SAVINGS")) {
      data.balance = parseFloat(form.get("balance") as string) || 0;
    }
    // Credit card settings
    if (accountType === "CREDIT_CARD") {
      data.closingDay = closingDay ? parseInt(closingDay) : null;
      data.dueDay = dueDay ? parseInt(dueDay) : null;
      data.linkedBankAccountId = linkedBankAccountId || null;
    } else {
      data.closingDay = null;
      data.dueDay = null;
      data.linkedBankAccountId = null;
    }
    // Investment dividend settings
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

    // When hiding an existing account for the first time, check for warnings
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

  if (hideWarning) {
    const messages: string[] = [];
    if (hideWarning.hasBalance) messages.push("a non-zero balance");
    if (hideWarning.activeRecurringCount > 0)
      messages.push(`${hideWarning.activeRecurringCount} active recurring transaction${hideWarning.activeRecurringCount > 1 ? "s" : ""}`);
    return (
      <Modal open={open} onClose={() => setHideWarning(null)} title="Hide Account">
        <div className="space-y-4">
          <p className="text-sm">
            This account has {messages.join(" and ")}. Are you sure you want to hide it?
          </p>
          <p className="text-sm text-muted-foreground">
            The account will be hidden from dropdowns and the Investments page, but all existing data will be preserved.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setHideWarning(null)}>Cancel</Button>
            <Button type="button" disabled={saving} onClick={confirmHide}>
              {saving ? "Saving..." : "Hide Anyway"}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={account ? "Edit Account" : "Add Account"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Name</label>
          <input
            name="name"
            type="text"
            required
            defaultValue={account?.name ?? ""}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            placeholder="e.g. Chase Checking"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Type</label>
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
              className="w-full appearance-none rounded-md border border-border py-1.5 pl-2 pr-6 text-sm text-foreground"
            >
              {Object.entries(accountTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
          </div>
        </div>

        {!account && (accountType === "CHECKING" || accountType === "SAVINGS") && (
          <div>
            <label className="mb-1 block text-sm font-medium">Starting Balance</label>
            <input
              name="balance"
              type="number"
              step="0.01"
              defaultValue="0"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium">Color</label>
          <input type="hidden" name="color" value={selectedColor} />
          <div className="grid w-fit grid-cols-10 gap-2">
            {ACCOUNT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setSelectedColor(color)}
                style={{ backgroundColor: color }}
                className={`h-7 w-7 rounded-md transition-transform hover:scale-110 ${
                  selectedColor === color
                    ? "scale-110 ring-2 ring-border ring-offset-1"
                    : ""
                }`}
              />
            ))}
          </div>
        </div>

        <div className="rounded-md border border-border p-3">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={isJoint}
              onChange={(e) => setIsJoint(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            <span className="text-sm font-medium">Joint account</span>
          </label>
          <p className="mt-1 ml-6 text-xs text-muted-foreground">
            Transactions from joint accounts are shared expenses/income
          </p>
        </div>

        {accountType !== "CREDIT_CARD" && (
          <div className="rounded-md border border-border p-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={isTaxAdvantaged}
                onChange={(e) => {
                  setIsTaxAdvantaged(e.target.checked);
                  if (!e.target.checked) setTaxAdvantageType("");
                }}
                className="h-4 w-4 rounded border-border"
              />
              <span className="text-sm font-medium">Tax-advantaged account</span>
            </label>
            <p className="mt-1 ml-6 text-xs text-muted-foreground">
              IRA, 401(k), HSA, 529, or similar. Investment sales and dividends will not generate income records.
            </p>
            {isTaxAdvantaged && (
              <div className="mt-3 ml-6">
                <label className="block text-xs font-medium text-muted-foreground mb-1">Account type</label>
                <div className="relative">
                  <select
                    value={taxAdvantageType}
                    onChange={(e) => setTaxAdvantageType(e.target.value as TaxAdvantageType | "")}
                    className="w-full appearance-none rounded-md border border-border py-1.5 pl-2 pr-6 text-sm text-foreground bg-background"
                  >
                    <option value="">Select type…</option>
                    <option value="TRADITIONAL">Traditional IRA / 401(k)</option>
                    <option value="ROTH">Roth IRA / 401(k)</option>
                    <option value="HSA">HSA</option>
                    <option value="PLAN_529">529</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                </div>
              </div>
            )}
          </div>
        )}

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
                : "Lot-level acquisition dates are unavailable. Enter total shares and total cost basis per holding — cost per share is calculated automatically."}
            </p>
          </div>
        )}

        {/* Credit card settings */}
        {accountType === "CREDIT_CARD" && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Credit Card Settings</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium">Closing Day</label>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={closingDay}
                  onChange={(e) => setClosingDay(e.target.value)}
                  placeholder="e.g. 15"
                  className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p className="mt-1 text-xs text-muted-foreground">Day of month billing cycle closes</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Due Day</label>
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={dueDay}
                  onChange={(e) => setDueDay(e.target.value)}
                  placeholder="e.g. 8"
                  className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <p className="mt-1 text-xs text-muted-foreground">Day of month payment is due</p>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Paid from Account</label>
              <div className="relative">
                <select
                  value={linkedBankAccountId}
                  onChange={(e) => setLinkedBankAccountId(e.target.value)}
                  className="w-full appearance-none rounded-md border border-border py-1.5 pl-2 pr-6 text-sm text-foreground"
                >
                  <option value="">— None selected —</option>
                  {bankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Which bank account pays this card</p>
            </div>
          </div>
        )}

        {/* Investment dividend settings */}
        {accountType === "INVESTMENT" && (
          <div className="space-y-3 rounded-md border border-border p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dividend Settings</p>
            <div>
              <label className="mb-1 block text-sm font-medium">Default Election</label>
              <div className="relative">
                <select
                  value={dividendElection}
                  onChange={(e) => setDividendElection(e.target.value)}
                  className="w-full appearance-none rounded-md border border-border py-1.5 pl-2 pr-6 text-sm text-foreground"
                >
                  <option value="">Ask each time</option>
                  <option value="REINVEST">Always reinvest (DRIP)</option>
                  <option value="CASH">Always pay as cash</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
              </div>
            </div>
            {dividendElection === "CASH" && (
              <div>
                <label className="mb-1 block text-sm font-medium">Deposit to Account</label>
                <div className="relative">
                  <select
                    value={defaultCashAccountId}
                    onChange={(e) => setDefaultCashAccountId(e.target.value)}
                    className="w-full appearance-none rounded-md border border-border py-1.5 pl-2 pr-6 text-sm text-foreground"
                  >
                    <option value="">— None selected —</option>
                    {bankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Where cash dividends are deposited</p>
              </div>
            )}
          </div>
        )}

        {account && (
          <div className="rounded-md border border-border p-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={isHidden}
                onChange={(e) => setIsHidden(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span className="text-sm font-medium">Hide account</span>
            </label>
            <p className="mt-1 ml-6 text-xs text-muted-foreground">
              Hidden accounts are excluded from dropdowns and the Investments page, but all data is preserved.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <div>
            {account && (
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
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : account ? "Update" : "Add Account"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
