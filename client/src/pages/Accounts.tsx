import { useState, useEffect } from "react";
import { Plus, Pencil, Trash2, Landmark, CreditCard, TrendingUp, EyeOff } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { useApi } from "@/hooks/useApi";
import { getAccounts, createAccount, updateAccount, deleteAccount, getInvestmentHoldings, getRecurrenceRules } from "@/api";
import { formatCurrency } from "@/lib/utils";
import type { Account } from "@/types";

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

function sumAccounts(accounts: Account[]) {
  return accounts.reduce((sum, a) => sum + parseFloat(a.balance), 0);
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

  const totalAssets = sumAccounts(accounts.filter((a) => ASSET_TYPES.has(a.type)));
  const totalLiabilities = sumAccounts(accounts.filter((a) => LIABILITY_TYPES.has(a.type)));
  const netWorth = totalAssets - totalLiabilities;

  const renderGroup = (group: GroupDef, isJoint: boolean) => {
    const groupAccounts = accounts.filter(
      (a) => (group.types as string[]).includes(a.type) && a.isJoint === isJoint
    );
    if (groupAccounts.length === 0) return null;
    const Icon = group.icon;
    const total = sumAccounts(groupAccounts);
    return (
      <div key={`${group.key}-${isJoint}`} className="space-y-2">
        <div className="flex items-center justify-between py-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            <Icon className="h-4 w-4" />
            <span>{group.label}</span>
          </div>
          <span className="text-sm font-semibold">{formatCurrency(total)}</span>
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
                    Tax-Advantaged
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="font-bold tabular-nums">{formatCurrency(account.balance)}</span>
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
          {/* Net Worth Summary */}
          <Card className="p-4">
            <div className="grid grid-cols-3 divide-x divide-border text-center">
              <div className="px-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Total Assets</p>
                <p className="text-xl font-bold text-green-600">{formatCurrency(totalAssets)}</p>
              </div>
              <div className="px-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Total Liabilities</p>
                <p className="text-xl font-bold text-red-500">{formatCurrency(totalLiabilities)}</p>
              </div>
              <div className="px-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Net Worth</p>
                <p className={`text-xl font-bold ${netWorth >= 0 ? "text-green-600" : "text-red-500"}`}>
                  {formatCurrency(netWorth)}
                </p>
              </div>
            </div>
          </Card>

          {/* Column headers */}
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            <h3 className="text-base font-semibold border-b border-border pb-2">Assets</h3>
            <h3 className="text-base font-semibold border-b border-border pb-2">Liabilities</h3>
          </div>

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
}

interface HideWarning {
  hasBalance: boolean;
  activeRecurringCount: number;
  pendingData: Partial<Account>;
}

function AccountModal({ open, onClose, onSave, onDelete, account }: AccountModalProps) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isJoint, setIsJoint] = useState(false);
  const [isManaged, setIsManaged] = useState(false);
  const [isTaxAdvantaged, setIsTaxAdvantaged] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [accountType, setAccountType] = useState<Account["type"]>(account?.type ?? "CHECKING");
  const [selectedColor, setSelectedColor] = useState(account?.color ?? ACCOUNT_COLORS[0]);
  // True when the account already has holdings with real lot dates — managed toggle is locked off
  const [hasTrackedHoldings, setHasTrackedHoldings] = useState(false);
  const [hideWarning, setHideWarning] = useState<HideWarning | null>(null);

  useEffect(() => {
    if (open) {
      setIsJoint(account?.isJoint ?? false);
      setIsManaged(account?.isManaged ?? false);
      setIsTaxAdvantaged(account?.isTaxAdvantaged ?? false);
      setIsHidden(account?.isHidden ?? false);
      setAccountType(account?.type ?? "CHECKING");
      setSelectedColor(account?.color ?? ACCOUNT_COLORS[0]);
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
      isHidden,
    };
    if (!account) {
      data.balance = parseFloat(form.get("balance") as string) || 0;
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
          <select
            name="type"
            required
            value={accountType}
            onChange={(e) => {
              const t = e.target.value as Account["type"];
              setAccountType(t);
              if (t !== "INVESTMENT") setIsManaged(false);
            }}
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {Object.entries(accountTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>

        {!account && (
          <div>
            <label className="mb-1 block text-sm font-medium">Balance</label>
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
                onChange={(e) => setIsTaxAdvantaged(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span className="text-sm font-medium">Tax-advantaged account</span>
            </label>
            <p className="mt-1 ml-6 text-xs text-muted-foreground">
              IRA, 401(k), HSA, 529, or similar. Investment sales and dividends will not generate income records.
            </p>
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
