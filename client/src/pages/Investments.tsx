import { useState, useEffect, useRef } from "react";
import { useNavigate, Link } from "react-router-dom";
import { TrendingUp, TrendingDown, Landmark, LineChart, ChevronRight, Pencil, Layers } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { useApi } from "@/hooks/useApi";
import { getInvestmentAccounts, refreshPrices, updateAccount } from "@/api";
import { formatCurrency } from "@/lib/utils";
import { isPriceRefreshNeeded } from "@/lib/priceUtils";
import { useNotifications } from "@/context/NotificationContext";
import type { InvestmentAccountSummary } from "@/types";

// ── Gain badge ──────────────────────────────────────────────────────────────

function GainBadge({ value, pct, className = "" }: { value: number; pct?: number | null; className?: string }) {
  const positive = value >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-sm font-medium ${
        positive ? "text-green-600" : "text-red-500"
      } ${className}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {formatCurrency(Math.abs(value))}
      {pct != null && (
        <span className="text-xs opacity-70">({Math.abs(pct).toFixed(2)}%)</span>
      )}
    </span>
  );
}

// ── Edit Balance Modal ───────────────────────────────────────────────────────

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
    await onSave(account.id, parseFloat(value) || 0);
    setSaving(false);
  };

  return (
    <Modal open={!!account} onClose={onClose} title="Edit Balance">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">
            Current Balance — {account?.name}
          </label>
          <input
            type="number"
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function Investments() {
  const navigate = useNavigate();
  const { data: accounts, refetch } = useApi(() => getInvestmentAccounts(), []);
  const refreshedRef = useRef(false);
  const [editingBalance, setEditingBalance] = useState<InvestmentAccountSummary | null>(null);
  const { notifications } = useNotifications();
  const pendingDividendAccountIds = new Set(
    notifications?.pendingDividends.map((g) => g.accountId) ?? []
  );

  useEffect(() => {
    if (!accounts || refreshedRef.current) return;
    const holdings = accounts.filter((a) => a.type === "INVESTMENT").flatMap((a) => a.holdings);
    if (isPriceRefreshNeeded(holdings)) {
      refreshedRef.current = true;
      refreshPrices("Investments")
        .then(() => refetch())
        .catch(() => { /* server logs the error */ });
    }
  }, [accounts, refetch]);

  const handleSaveBalance = async (id: string, balance: number) => {
    await updateAccount(id, { balance });
    setEditingBalance(null);
    refetch();
  };

  if (!accounts) return null;

  const investmentAccounts = accounts.filter((a) => a.type === "INVESTMENT");
  const bankingAccounts = accounts.filter(
    (a) => a.type === "CHECKING" || a.type === "SAVINGS"
  );

  const totalPortfolioValue = accounts.reduce((sum, a) => sum + a.totalMarketValue, 0);
  const totalGain = investmentAccounts.reduce((sum, a) => sum + a.totalGain, 0);
  const totalCost = investmentAccounts.reduce((sum, a) => sum + a.totalCost, 0);
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;

  const renderAccountRow = (account: InvestmentAccountSummary) => {
    const isBanking = account.type === "CHECKING" || account.type === "SAVINGS";
    return (
      <div
        key={account.id}
        role="button"
        tabIndex={0}
        onClick={() => navigate(`/investments/${account.id}`)}
        onKeyDown={(e) => e.key === "Enter" && navigate(`/investments/${account.id}`)}
        className="w-full text-left cursor-pointer"
      >
        <Card className="px-4 py-3 hover:shadow-md transition-shadow cursor-pointer">
          <div className="flex items-center gap-3">
            {/* Color dot */}
            <div
              className="h-8 w-8 flex-shrink-0 rounded-md flex items-center justify-center"
              style={account.color ? { backgroundColor: account.color } : { backgroundColor: "#e2e2df" }}
            >
              {isBanking ? (
                <Landmark className="h-4 w-4 text-gray-500" />
              ) : (
                <LineChart className="h-4 w-4 text-gray-500" />
              )}
            </div>

            {/* Name + meta */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <p className="font-medium text-sm truncate">{account.name}</p>
                {!isBanking && pendingDividendAccountIds.has(account.id) && (
                  <span className="shrink-0 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700 whitespace-nowrap">
                    Pending dividends
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {isBanking
                  ? account.type === "CHECKING" ? "Checking · Cash" : "Savings · Cash"
                  : (() => { const n = account.holdings.length + (account.manualCount ?? 0); return `${n} holding${n !== 1 ? "s" : ""}`; })()}
              </p>
            </div>

            {/* Value + gain */}
            <div className="text-right flex-shrink-0 mr-2">
              <p className="font-bold tabular-nums text-sm">
                {formatCurrency(account.totalMarketValue)}
              </p>
              {!isBanking && account.totalGain !== 0 && (
                <GainBadge value={account.totalGain} pct={account.totalGainPct} />
              )}
            </div>

            {isBanking ? (
              <button
                onClick={(e) => { e.stopPropagation(); setEditingBalance(account); }}
                className="rounded p-1 hover:bg-accent flex-shrink-0"
              >
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            )}
          </div>
        </Card>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Investments</h2>
        <Link
          to="/investments/securities"
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <Layers className="h-4 w-4" />
          Securities
        </Link>
      </div>

      {/* Portfolio summary card */}
      {accounts.length > 0 && (
        <Card className="p-4">
          <div className="grid grid-cols-3 divide-x divide-border text-center">
            <div className="px-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                Total Portfolio
              </p>
              <p className="text-xl font-bold">{formatCurrency(totalPortfolioValue)}</p>
            </div>
            <div className="px-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                Total Gain / Loss
              </p>
              {totalCost > 0 ? (
                <GainBadge value={totalGain} pct={totalGainPct} className="text-xl" />
              ) : (
                <p className="text-xl font-bold text-muted-foreground">—</p>
              )}
            </div>
            <div className="px-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                Cash
              </p>
              <p className="text-xl font-bold">
                {formatCurrency(bankingAccounts.reduce((s, a) => s + a.totalMarketValue, 0))}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Two-column layout: investment accounts left, banking right */}
      {(investmentAccounts.length > 0 || bankingAccounts.length > 0) && (
        <div className="flex flex-col lg:flex-row items-start gap-6">
          {/* Investment accounts */}
          {investmentAccounts.length > 0 && (
            <div className="min-w-0 basis-2/3 space-y-2">
              <div className="flex items-center gap-2 py-1">
                <LineChart className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Investment Accounts
                </span>
              </div>
              <div className="space-y-1.5">
                {investmentAccounts.map(renderAccountRow)}
              </div>
            </div>
          )}

          {/* Banking accounts */}
          {bankingAccounts.length > 0 && (
            <div className="min-w-0 basis-1/3 space-y-2">
              <div className="flex items-center gap-2 py-1">
                <Landmark className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Banking (Cash)
                </span>
              </div>
              <div className="space-y-1.5">
                {bankingAccounts.map(renderAccountRow)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {accounts.length === 0 && (
        <Card className="p-8 text-center">
          <LineChart className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="font-semibold text-lg mb-1">No investment or banking accounts</p>
          <p className="text-muted-foreground text-sm">
            Add accounts in{" "}
            <button
              className="text-primary underline"
              onClick={() => navigate("/accounts")}
            >
              Accounts
            </button>{" "}
            to get started.
          </p>
        </Card>
      )}

      <EditBalanceModal
        account={editingBalance}
        onClose={() => setEditingBalance(null)}
        onSave={handleSaveBalance}
      />
    </div>
  );
}
