import { useState, useCallback } from "react";
import { useApi } from "@/hooks/useApi";
import {
  getOptionsSettings,
  getOptionsPositions,
  getOptionsTickers,
  getOptionsGroups,
  updateOptionsSettings,
  createOptionsTicker,
  createOptionsPosition,
  updateOptionsPosition,
  closeOptionsPosition,
  deleteOptionsPosition,
  createOptionsGroup,
  type OptionsPosition,
  type OptionsTicker,
  type OptionsPositionGroup,
  type OptionsSettings,
  type OptionsPositionInput,
  type OptionsCloseInput,
  type OptionOutcome,
} from "@/api";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { TrendingUp, Plus, X, ChevronDown, ChevronUp, Settings, Link } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmt = (n: number | null | undefined, decimals = 2, prefix = "") =>
  n == null ? "—" : `${prefix}${n.toFixed(decimals)}`;

const fmtDollar = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${n < 0 ? " loss" : ""}`;

const fmtPct = (n: number | null | undefined, decimals = 1) =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(decimals)}%`;

/** Convert a local ET datetime string (YYYY-MM-DDTHH:mm) to UTC ISO string */
function etToUtc(localEtString: string): string {
  // The user's machine may not be in ET. We treat the input as an ET wall-clock
  // time and compute UTC by using the ET offset. For now we use a fixed -4 (EDT)
  // offset; Phase 3 can do a proper IANA lookup. The displayed value converts back
  // to local time for the user.
  const [datePart, timePart] = localEtString.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);
  const etOffsetHours = 4; // EDT; TODO Phase 3: check DST
  const utc = new Date(Date.UTC(y, mo - 1, d, h + etOffsetHours, mi));
  return utc.toISOString();
}

/** Format a UTC ISO datetime in the user's local timezone */
function fmtLocalDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtDate(iso: string) {
  // date-only strings (YYYY-MM-DD) should not be timezone-shifted
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Calculations ───────────────────────────────────────────────────────────────

function calcPosition(p: OptionsPosition) {
  const totalPremiumGross = p.premiumPerShare * 100 * p.contracts;
  const totalPremiumNet = totalPremiumGross - (p.feesOpen ?? 0);

  const capitalAtRisk =
    p.optionType === "CALL"
      ? (p.shareCostBasis ?? 0) * 100 * p.contracts
      : p.strikePrice * 100 * p.contracts - totalPremiumNet;

  const breakeven =
    p.optionType === "CALL"
      ? p.strikePrice + p.premiumPerShare
      : p.strikePrice - p.premiumPerShare;

  const pctOtmAtOpen =
    p.stockPriceAtOpen != null
      ? p.optionType === "CALL"
        ? ((p.strikePrice - p.stockPriceAtOpen) / p.stockPriceAtOpen) * 100
        : ((p.stockPriceAtOpen - p.strikePrice) / p.stockPriceAtOpen) * 100
      : null;

  // Expiry = expiration date at 4 pm ET = 20:00 UTC (approximation, EDT)
  const [ey, em, ed] = p.expirationDate.split("T")[0].split("-").map(Number);
  const expiryUtc = new Date(Date.UTC(ey, em - 1, ed, 20, 0, 0));

  const openedMs = new Date(p.openedAt).getTime();
  const durationDays = (expiryUtc.getTime() - openedMs) / 86_400_000;
  const daysLeft = (expiryUtc.getTime() - Date.now()) / 86_400_000;

  const annReturnAtExpiry =
    capitalAtRisk > 0 && durationDays > 0
      ? (totalPremiumNet / capitalAtRisk) * (365 / durationDays) * 100
      : null;

  // Closed-position fields
  const totalFees = (p.feesOpen ?? 0) + (p.feesClose ?? 0);
  const closedPremiumNet =
    p.outcome === "EXPIRED_WORTHLESS"
      ? 0
      : (p.closePremiumPerShare ?? 0) * 100 * p.contracts + (p.feesClose ?? 0);

  const pnl =
    p.status !== "OPEN"
      ? totalPremiumGross - closedPremiumNet - (p.feesOpen ?? 0)
      : null;

  const closeMs = p.closedAt
    ? new Date(p.closedAt).getTime()
    : p.status !== "OPEN"
    ? expiryUtc.getTime()
    : null;
  const daysInTrade = closeMs != null ? (closeMs - openedMs) / 86_400_000 : null;

  const closedAnnReturn =
    pnl != null && capitalAtRisk > 0 && daysInTrade != null && daysInTrade > 0
      ? (pnl / capitalAtRisk) * (365 / daysInTrade) * 100
      : null;

  return {
    totalPremiumNet,
    capitalAtRisk,
    breakeven,
    pctOtmAtOpen,
    durationDays,
    daysLeft,
    annReturnAtExpiry,
    totalFees,
    pnl,
    daysInTrade,
    closedAnnReturn,
  };
}

// ── Open Position Modal ────────────────────────────────────────────────────────

interface PositionModalProps {
  tickers: OptionsTicker[];
  groups: OptionsPositionGroup[];
  editing: OptionsPosition | null;
  onClose: () => void;
  onSaved: () => void;
  onTickerCreated: () => void;
}

function PositionModal({ tickers, groups, editing, onClose, onSaved, onTickerCreated }: PositionModalProps) {
  const [tickerId, setTickerId] = useState(editing?.tickerId ?? "");
  const [newTicker, setNewTicker] = useState("");
  const [showNewTicker, setShowNewTicker] = useState(false);
  const [optionType, setOptionType] = useState<"CALL" | "PUT">(editing?.optionType ?? "CALL");
  const [strikePrice, setStrikePrice] = useState(editing?.strikePrice?.toString() ?? "");
  const [expirationDate, setExpirationDate] = useState(
    editing?.expirationDate ? editing.expirationDate.split("T")[0] : ""
  );
  // openedAt is stored as UTC; show in ET (subtract 4h for EDT)
  const [openedAt, setOpenedAt] = useState(() => {
    if (!editing?.openedAt) return "";
    const d = new Date(editing.openedAt);
    d.setHours(d.getHours() - 4); // UTC → EDT approximation
    return d.toISOString().slice(0, 16);
  });
  const [contracts, setContracts] = useState(editing?.contracts?.toString() ?? "");
  const [premiumPerShare, setPremiumPerShare] = useState(editing?.premiumPerShare?.toString() ?? "");
  const [feesOpen, setFeesOpen] = useState(editing?.feesOpen?.toString() ?? "");
  const [shareCostBasis, setShareCostBasis] = useState(editing?.shareCostBasis?.toString() ?? "");
  const [stockPriceAtOpen, setStockPriceAtOpen] = useState(editing?.stockPriceAtOpen?.toString() ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [groupId, setGroupId] = useState(editing?.groupId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isCoveredCall = optionType === "CALL";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      let resolvedTickerId = tickerId;

      if (showNewTicker && newTicker.trim()) {
        const created = await createOptionsTicker({ symbol: newTicker.trim().toUpperCase() });
        resolvedTickerId = created.id;
        onTickerCreated();
      }

      if (!resolvedTickerId) {
        setError("Please select or create a ticker.");
        setSaving(false);
        return;
      }

      const data: OptionsPositionInput = {
        tickerId: resolvedTickerId,
        groupId: groupId || null,
        optionType,
        side: "SELL",
        strikePrice: parseFloat(strikePrice),
        expirationDate,
        openedAt: etToUtc(openedAt),
        contracts: parseInt(contracts, 10),
        premiumPerShare: parseFloat(premiumPerShare),
        feesOpen: feesOpen ? parseFloat(feesOpen) : null,
        shareCostBasis: isCoveredCall && shareCostBasis ? parseFloat(shareCostBasis) : null,
        stockPriceAtOpen: stockPriceAtOpen ? parseFloat(stockPriceAtOpen) : null,
        notes: notes || null,
      };

      if (editing) {
        await updateOptionsPosition(editing.id, data);
      } else {
        await createOptionsPosition(data);
      }
      onSaved();
    } catch {
      setError("Failed to save position.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={editing ? "Edit Position" : "Open New Position"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Ticker */}
        <div>
          <label className="block text-sm font-medium mb-1">Underlying Ticker</label>
          {!showNewTicker ? (
            <div className="flex gap-2">
              <select
                value={tickerId}
                onChange={(e) => setTickerId(e.target.value)}
                className="appearance-none flex-1 rounded-md border border-input bg-background pl-2 pr-6 py-1.5 text-sm text-foreground"
                required={!showNewTicker}
              >
                <option value="">Select ticker…</option>
                {tickers.map((t) => (
                  <option key={t.id} value={t.id}>{t.symbol}</option>
                ))}
              </select>
              <Button type="button" variant="outline" size="sm" onClick={() => { setShowNewTicker(true); setTickerId(""); }}>
                <Plus className="h-3.5 w-3.5 mr-1" /> New
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                value={newTicker}
                onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
                placeholder="e.g. AAPL"
                className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                required
              />
              <Button type="button" variant="outline" size="sm" onClick={() => { setShowNewTicker(false); setNewTicker(""); }}>
                Cancel
              </Button>
            </div>
          )}
        </div>

        {/* Type */}
        <div>
          <label className="block text-sm font-medium mb-1">Option Type</label>
          <div className="flex gap-2">
            {(["CALL", "PUT"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setOptionType(t)}
                className={cn(
                  "flex-1 rounded-md border py-1.5 text-sm font-medium transition-colors",
                  optionType === t
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background hover:bg-accent"
                )}
              >
                {t === "CALL" ? "Covered Call" : "Cash-Secured Put"}
              </button>
            ))}
          </div>
        </div>

        {/* Strike / Expiration */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">Strike Price</label>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.01" min="0" required
                value={strikePrice} onChange={(e) => setStrikePrice(e.target.value)}
                className="w-full rounded-md border border-input bg-background pl-6 pr-2 py-1.5 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Expiration Date</label>
            <input
              type="date" required
              value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        {/* Opened At */}
        <div>
          <label className="block text-sm font-medium mb-1">Date & Time Opened <span className="text-muted-foreground font-normal">(ET)</span></label>
          <input
            type="datetime-local" required
            value={openedAt} onChange={(e) => setOpenedAt(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>

        {/* Contracts / Premium */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1"># Contracts</label>
            <input
              type="number" min="1" step="1" required
              value={contracts} onChange={(e) => setContracts(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Premium / Share</label>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.0001" min="0" required
                value={premiumPerShare} onChange={(e) => setPremiumPerShare(e.target.value)}
                className="w-full rounded-md border border-input bg-background pl-6 pr-2 py-1.5 text-sm"
              />
            </div>
          </div>
        </div>

        {/* Stock Price at Open */}
        <div>
          <label className="block text-sm font-medium mb-1">Stock Price at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.0001" min="0"
              value={stockPriceAtOpen} onChange={(e) => setStockPriceAtOpen(e.target.value)}
              className="w-full rounded-md border border-input bg-background pl-6 pr-2 py-1.5 text-sm"
            />
          </div>
        </div>

        {/* Share Cost Basis — CC only */}
        {isCoveredCall && (
          <div>
            <label className="block text-sm font-medium mb-1">Share Cost Basis / Share <span className="text-muted-foreground font-normal">(covered call)</span></label>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.01" min="0"
                value={shareCostBasis} onChange={(e) => setShareCostBasis(e.target.value)}
                className="w-full rounded-md border border-input bg-background pl-6 pr-2 py-1.5 text-sm"
              />
            </div>
          </div>
        )}

        {/* Fees */}
        <div>
          <label className="block text-sm font-medium mb-1">Fees at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.01" min="0"
              value={feesOpen} onChange={(e) => setFeesOpen(e.target.value)}
              className="w-full rounded-md border border-input bg-background pl-6 pr-2 py-1.5 text-sm"
            />
          </div>
        </div>

        {/* Group (roll/chain) */}
        {groups.length > 0 && (
          <div>
            <label className="block text-sm font-medium mb-1">Position Group <span className="text-muted-foreground font-normal">(for rolls / chains)</span></label>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="appearance-none w-full rounded-md border border-input bg-background pl-2 pr-6 py-1.5 text-sm text-foreground"
            >
              <option value="">None (standalone)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.label ?? `Group ${g.id.slice(-6)}`}</option>
              ))}
            </select>
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="block text-sm font-medium mb-1">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
          <textarea
            value={notes} onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm resize-none"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Save Changes" : "Open Position"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Close Position Modal ───────────────────────────────────────────────────────

interface CloseModalProps {
  position: OptionsPosition;
  onClose: () => void;
  onSaved: () => void;
}

function ClosePositionModal({ position, onClose, onSaved }: CloseModalProps) {
  const [outcome, setOutcome] = useState<OptionOutcome>("EXPIRED_WORTHLESS");
  const [closedAt, setClosedAt] = useState("");
  const [closePremiumPerShare, setClosePremiumPerShare] = useState("");
  const [feesClose, setFeesClose] = useState("");
  const [contractsAssigned, setContractsAssigned] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isExpired = outcome === "EXPIRED_WORTHLESS";
  const isAssigned = outcome === "ASSIGNED";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const statusMap: Record<OptionOutcome, Exclude<import("@/api").OptionStatus, "OPEN">> = {
        EXPIRED_WORTHLESS: "EXPIRED",
        CLOSED_EARLY: "CLOSED",
        ROLLED: "CLOSED",
        ASSIGNED: "ASSIGNED",
      };

      const data: OptionsCloseInput = {
        status: statusMap[outcome],
        outcome,
        closedAt: isExpired ? null : closedAt ? etToUtc(closedAt) : null,
        closePremiumPerShare: isExpired ? 0 : closePremiumPerShare ? parseFloat(closePremiumPerShare) : null,
        feesClose: feesClose ? parseFloat(feesClose) : null,
        contractsAssigned: isAssigned && contractsAssigned ? parseInt(contractsAssigned, 10) : null,
      };

      await closeOptionsPosition(position.id, data);
      onSaved();
    } catch {
      setError("Failed to close position.");
    } finally {
      setSaving(false);
    }
  };

  const outcomeOptions: { value: OptionOutcome; label: string }[] = [
    { value: "EXPIRED_WORTHLESS", label: "Expired Worthless" },
    { value: "CLOSED_EARLY", label: "Closed Early" },
    { value: "ROLLED", label: "Rolled to New Position" },
    { value: "ASSIGNED", label: "Assigned" },
  ];

  return (
    <Modal onClose={onClose} title={`Close: ${position.ticker.symbol} $${position.strikePrice} ${position.optionType}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Outcome</label>
          <div className="grid grid-cols-2 gap-2">
            {outcomeOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setOutcome(o.value)}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm text-left transition-colors",
                  outcome === o.value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background hover:bg-accent"
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {!isExpired && (
          <div>
            <label className="block text-sm font-medium mb-1">Date Closed <span className="text-muted-foreground font-normal">(ET)</span></label>
            <input
              type="datetime-local"
              value={closedAt} onChange={(e) => setClosedAt(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
          </div>
        )}

        {!isExpired && (
          <div>
            <label className="block text-sm font-medium mb-1">Close Premium / Share</label>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.0001" min="0"
                value={closePremiumPerShare} onChange={(e) => setClosePremiumPerShare(e.target.value)}
                className="w-full rounded-md border border-input bg-background pl-6 pr-2 py-1.5 text-sm"
              />
            </div>
          </div>
        )}

        {isAssigned && (
          <div>
            <label className="block text-sm font-medium mb-1">Contracts Assigned</label>
            <input
              type="number" min="1" step="1"
              value={contractsAssigned} onChange={(e) => setContractsAssigned(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">Fees at Close <span className="text-muted-foreground font-normal">(optional)</span></label>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.01" min="0"
              value={feesClose} onChange={(e) => setFeesClose(e.target.value)}
              className="w-full rounded-md border border-input bg-background pl-6 pr-2 py-1.5 text-sm"
            />
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Close Position"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Settings Modal ─────────────────────────────────────────────────────────────

interface SettingsModalProps {
  current: OptionsSettings | null;
  onClose: () => void;
  onSaved: () => void;
}

function SettingsModal({ current, onClose, onSaved }: SettingsModalProps) {
  const [startingBasis, setStartingBasis] = useState(current?.startingBasis?.toString() ?? "");
  const [targetReturn, setTargetReturn] = useState(
    current ? (current.targetReturn * 100).toFixed(1) : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await updateOptionsSettings({
        startingBasis: parseFloat(startingBasis),
        targetReturn: parseFloat(targetReturn) / 100,
      });
      onSaved();
    } catch {
      setError("Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Options Trading Settings">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Starting Basis</label>
          <p className="text-xs text-muted-foreground mb-2">Total capital allocated to options trading — used as the denominator for aggregate return calculations.</p>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.01" min="0" required
              value={startingBasis} onChange={(e) => setStartingBasis(e.target.value)}
              className="w-full rounded-md border border-input bg-background pl-6 pr-2 py-1.5 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Target Annual Return</label>
          <p className="text-xs text-muted-foreground mb-2">Used for premium target charts and performance benchmarking.</p>
          <div className="relative">
            <input
              type="number" step="0.1" min="0" max="999" required
              value={targetReturn} onChange={(e) => setTargetReturn(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 pr-7 py-1.5 text-sm"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save Settings"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Open Positions Table ───────────────────────────────────────────────────────

interface OpenPositionsTableProps {
  positions: OptionsPosition[];
  onEdit: (p: OptionsPosition) => void;
  onClose: (p: OptionsPosition) => void;
  onDelete: (p: OptionsPosition) => void;
}

function OpenPositionsTable({ positions, onEdit, onClose, onDelete }: OpenPositionsTableProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  if (positions.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No open positions. Click "Open Position" to add one.
      </div>
    );
  }

  const toggleGroup = (id: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Group positions by their groupId, standalone positions come last
  const grouped = new Map<string | null, OptionsPosition[]>();
  for (const p of positions) {
    const key = p.groupId ?? null;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(p);
  }

  const thClass = "px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap";
  const tdClass = "px-3 py-2 text-sm whitespace-nowrap";

  const renderRow = (p: OptionsPosition, isGrouped = false) => {
    const c = calcPosition(p);
    const isExpiring = c.daysLeft >= 0 && c.daysLeft <= 7;
    return (
      <tr key={p.id} className={cn("border-b border-border hover:bg-muted/30", isGrouped && "bg-muted/10")}>
        <td className={cn(tdClass, isGrouped && "pl-8")}>
          <div className="flex items-center gap-1.5">
            {p.group && <Link className="h-3 w-3 text-muted-foreground shrink-0" />}
            <span className="font-medium">{p.ticker.symbol}</span>
          </div>
        </td>
        <td className={tdClass}>
          <span className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
            p.optionType === "CALL" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
          )}>
            {p.optionType === "CALL" ? "CC" : "CSP"}
          </span>
        </td>
        <td className={tdClass}>${p.strikePrice.toFixed(2)}</td>
        <td className={tdClass}>
          <span className={cn(isExpiring && "text-amber-600 font-medium")}>
            {fmtDate(p.expirationDate)}
          </span>
        </td>
        <td className={tdClass}>{fmtLocalDateTime(p.openedAt)}</td>
        <td className={tdClass}>{fmt(p.stockPriceAtOpen, 2, "$")}</td>
        <td className={tdClass}>{p.contracts}</td>
        <td className={tdClass}>${p.premiumPerShare.toFixed(4)}</td>
        <td className={tdClass}>${c.totalPremiumNet.toFixed(2)}</td>
        <td className={tdClass}>{c.capitalAtRisk > 0 ? `$${c.capitalAtRisk.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—"}</td>
        <td className={tdClass}>${c.breakeven.toFixed(2)}</td>
        <td className={tdClass}>
          {c.pctOtmAtOpen != null
            ? <span className={cn(c.pctOtmAtOpen >= 0 ? "text-green-600" : "text-red-600")}>{fmtPct(c.pctOtmAtOpen)}</span>
            : "—"}
        </td>
        <td className={tdClass}>{Math.round(c.durationDays)}d</td>
        <td className={tdClass}>
          <span className={cn(isExpiring && "text-amber-600 font-medium")}>
            {c.daysLeft < 0 ? "Expired" : `${Math.ceil(c.daysLeft)}d`}
          </span>
        </td>
        <td className={tdClass}>
          {c.annReturnAtExpiry != null
            ? <span className={cn(c.annReturnAtExpiry >= 0 ? "text-green-600" : "text-red-600")}>{fmtPct(c.annReturnAtExpiry)}</span>
            : "—"}
        </td>
        {/* Phase 3: live fields */}
        <td className={tdClass + " text-muted-foreground"}>—</td>
        <td className={tdClass + " text-muted-foreground"}>—</td>
        <td className={tdClass + " text-muted-foreground"}>—</td>
        <td className={tdClass + " text-muted-foreground"}>—</td>
        <td className={tdClass}>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => onClose(p)}>Close</Button>
            <Button variant="ghost" size="sm" onClick={() => onEdit(p)}>Edit</Button>
            <button
              onClick={() => onDelete(p)}
              className="p-1 text-muted-foreground hover:text-destructive"
              aria-label="Delete"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse min-w-[1400px]">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className={thClass}>Ticker</th>
            <th className={thClass}>Type</th>
            <th className={thClass}>Strike</th>
            <th className={thClass}>Expiration</th>
            <th className={thClass}>Opened (local)</th>
            <th className={thClass}>Stock @ Open</th>
            <th className={thClass}>Contracts</th>
            <th className={thClass}>Prem/sh</th>
            <th className={thClass}>Total Prem</th>
            <th className={thClass}>Capital @ Risk</th>
            <th className={thClass}>Breakeven</th>
            <th className={thClass}>% OTM @ Open</th>
            <th className={thClass}>Duration</th>
            <th className={thClass}>Days Left</th>
            <th className={thClass}>Ann. Return @ Exp</th>
            <th className={cn(thClass, "text-muted-foreground/60")}>Stock Now ③</th>
            <th className={cn(thClass, "text-muted-foreground/60")}>Cur. Prem ③</th>
            <th className={cn(thClass, "text-muted-foreground/60")}>% OTM Now ③</th>
            <th className={cn(thClass, "text-muted-foreground/60")}>Cur. Ann. Ret ③</th>
            <th className={thClass}></th>
          </tr>
        </thead>
        <tbody>
          {Array.from(grouped.entries()).map(([gid, grpPositions]) => {
            if (gid === null) {
              return grpPositions.map((p) => renderRow(p));
            }
            const group = grpPositions[0].group;
            const groupLabel = group?.label ?? `Group ${gid.slice(-6)}`;
            const isExpanded = expandedGroups.has(gid);
            return [
              <tr
                key={`group-${gid}`}
                className="border-b border-border bg-muted/20 cursor-pointer hover:bg-muted/40"
                onClick={() => toggleGroup(gid)}
              >
                <td colSpan={20} className="px-3 py-1.5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    <Link className="h-3.5 w-3.5 text-muted-foreground" />
                    {groupLabel}
                    <span className="text-muted-foreground font-normal">· {grpPositions.length} position{grpPositions.length !== 1 ? "s" : ""}</span>
                  </div>
                </td>
              </tr>,
              ...(isExpanded ? grpPositions.map((p) => renderRow(p, true)) : []),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Closed Positions Table ─────────────────────────────────────────────────────

interface ClosedPositionsTableProps {
  positions: OptionsPosition[];
  onDelete: (p: OptionsPosition) => void;
}

function ClosedPositionsTable({ positions, onDelete }: ClosedPositionsTableProps) {
  if (positions.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No closed positions yet.
      </div>
    );
  }

  const outcomeLabel: Record<string, string> = {
    EXPIRED_WORTHLESS: "Expired Worthless",
    CLOSED_EARLY: "Closed Early",
    ROLLED: "Rolled",
    ASSIGNED: "Assigned",
  };

  const thClass = "px-3 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap";
  const tdClass = "px-3 py-2 text-sm whitespace-nowrap";

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse min-w-[1100px]">
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className={thClass}>Ticker</th>
            <th className={thClass}>Type</th>
            <th className={thClass}>Strike</th>
            <th className={thClass}>Expiration</th>
            <th className={thClass}>Opened</th>
            <th className={thClass}>Closed / Expired</th>
            <th className={thClass}>Contracts</th>
            <th className={thClass}>Open Prem</th>
            <th className={thClass}>Close Prem</th>
            <th className={thClass}>Total Fees</th>
            <th className={thClass}>P/L</th>
            <th className={thClass}>Days in Trade</th>
            <th className={thClass}>Ann. Return</th>
            <th className={thClass}>Outcome</th>
            <th className={thClass}></th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const c = calcPosition(p);
            return (
              <tr key={p.id} className="border-b border-border hover:bg-muted/30">
                <td className={tdClass}><span className="font-medium">{p.ticker.symbol}</span></td>
                <td className={tdClass}>
                  <span className={cn(
                    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                    p.optionType === "CALL" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                  )}>
                    {p.optionType === "CALL" ? "CC" : "CSP"}
                  </span>
                </td>
                <td className={tdClass}>${p.strikePrice.toFixed(2)}</td>
                <td className={tdClass}>{fmtDate(p.expirationDate)}</td>
                <td className={tdClass}>{fmtLocalDateTime(p.openedAt)}</td>
                <td className={tdClass}>{p.closedAt ? fmtLocalDateTime(p.closedAt) : fmtDate(p.expirationDate)}</td>
                <td className={tdClass}>{p.contracts}</td>
                <td className={tdClass}>${p.premiumPerShare.toFixed(4)}</td>
                <td className={tdClass}>
                  {p.outcome === "EXPIRED_WORTHLESS" ? "$0.00" : fmt(p.closePremiumPerShare, 4, "$")}
                </td>
                <td className={tdClass}>${c.totalFees.toFixed(2)}</td>
                <td className={tdClass}>
                  {c.pnl != null ? (
                    <span className={cn("font-medium", c.pnl >= 0 ? "text-green-600" : "text-red-600")}>
                      {c.pnl >= 0 ? "+" : "−"}${Math.abs(c.pnl).toFixed(2)}
                    </span>
                  ) : "—"}
                </td>
                <td className={tdClass}>{c.daysInTrade != null ? `${Math.round(c.daysInTrade)}d` : "—"}</td>
                <td className={tdClass}>
                  {c.closedAnnReturn != null ? (
                    <span className={cn(c.closedAnnReturn >= 0 ? "text-green-600" : "text-red-600")}>
                      {fmtPct(c.closedAnnReturn)}
                    </span>
                  ) : "—"}
                </td>
                <td className={tdClass}>
                  <span className={cn(
                    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                    p.outcome === "EXPIRED_WORTHLESS" ? "bg-green-100 text-green-700" :
                    p.outcome === "ASSIGNED" ? "bg-amber-100 text-amber-700" :
                    p.outcome === "ROLLED" ? "bg-blue-100 text-blue-700" :
                    "bg-muted text-muted-foreground"
                  )}>
                    {p.outcome ? outcomeLabel[p.outcome] : "—"}
                  </span>
                </td>
                <td className={tdClass}>
                  <button
                    onClick={() => onDelete(p)}
                    className="p-1 text-muted-foreground hover:text-destructive"
                    aria-label="Delete"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Summary Cards ──────────────────────────────────────────────────────────────

function SummaryCards({
  openPositions,
  closedPositions,
  settings,
}: {
  openPositions: OptionsPosition[];
  closedPositions: OptionsPosition[];
  settings: OptionsSettings | null;
}) {
  const totalCapitalAtRisk = openPositions.reduce((sum, p) => {
    return sum + calcPosition(p).capitalAtRisk;
  }, 0);

  const cumulativePremium = closedPositions.reduce((sum, p) => {
    const c = calcPosition(p);
    return sum + (c.pnl ?? 0);
  }, 0);

  // Tickers with open positions
  const openTickers = new Map<string, number>();
  for (const p of openPositions) {
    openTickers.set(p.ticker.symbol, (openTickers.get(p.ticker.symbol) ?? 0) + p.contracts);
  }

  // Premium earned since last Monday
  const lastMonday = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return d;
  })();

  const premiumThisWeek = closedPositions
    .filter((p) => p.closedAt && new Date(p.closedAt) >= lastMonday)
    .reduce((sum, p) => sum + (calcPosition(p).pnl ?? 0), 0);

  // Annualized rate: cumulative pnl / basis over time elapsed
  const annReturn = (() => {
    if (!settings?.startingBasis || cumulativePremium === 0) return null;
    const allDates = closedPositions.map((p) => new Date(p.openedAt).getTime());
    if (allDates.length === 0) return null;
    const firstDate = Math.min(...allDates);
    const elapsedDays = (Date.now() - firstDate) / 86_400_000;
    if (elapsedDays < 1) return null;
    return (cumulativePremium / settings.startingBasis) * (365 / elapsedDays) * 100;
  })();

  const cards = [
    {
      label: "Capital at Risk",
      value: totalCapitalAtRisk > 0 ? `$${totalCapitalAtRisk.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—",
      sub: openPositions.length > 0 ? `${openPositions.length} open position${openPositions.length !== 1 ? "s" : ""}` : "No open positions",
    },
    {
      label: "Open Tickers",
      value: openTickers.size > 0 ? Array.from(openTickers.keys()).join(", ") : "—",
      sub: openTickers.size > 0
        ? Array.from(openTickers.entries()).map(([sym, ct]) => `${sym} ×${ct}`).join(" · ")
        : "No open positions",
    },
    {
      label: "Premium This Week",
      value: premiumThisWeek !== 0 ? `$${premiumThisWeek.toFixed(2)}` : "$0.00",
      sub: "Since Monday",
      valueClass: premiumThisWeek >= 0 ? "text-green-600" : "text-red-600",
    },
    {
      label: "Cumulative Premium",
      value: `$${cumulativePremium.toFixed(2)}`,
      sub: settings ? `Basis: $${settings.startingBasis.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "Set starting basis in settings",
      valueClass: cumulativePremium >= 0 ? "text-green-600" : "text-red-600",
    },
    {
      label: "Ann. Rate of Return",
      value: annReturn != null ? fmtPct(annReturn) : "—",
      sub: settings?.targetReturn ? `Target: ${(settings.targetReturn * 100).toFixed(1)}%` : "Set target in settings",
      valueClass: annReturn != null ? (annReturn >= (settings?.targetReturn ?? 0) * 100 ? "text-green-600" : "text-amber-600") : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-5 gap-4">
      {cards.map((c) => (
        <Card key={c.label} className="p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{c.label}</p>
          <p className={cn("text-xl font-semibold mt-1 truncate", c.valueClass)}>{c.value}</p>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{c.sub}</p>
        </Card>
      ))}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function OptionsTrading() {
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [positionModal, setPositionModal] = useState<"new" | OptionsPosition | null>(null);
  const [closeModal, setCloseModal] = useState<OptionsPosition | null>(null);
  const [settingsModal, setSettingsModal] = useState(false);

  const { data: settings, refetch: refetchSettings } = useApi(getOptionsSettings, []);
  const { data: allPositions, refetch: refetchPositions } = useApi(getOptionsPositions, []);
  const { data: tickers, refetch: refetchTickers } = useApi(getOptionsTickers, []);
  const { data: groups, refetch: refetchGroups } = useApi(getOptionsGroups, []);

  const openPositions = (allPositions ?? []).filter((p) => p.status === "OPEN");
  const closedPositions = (allPositions ?? []).filter((p) => p.status !== "OPEN");

  const refetchAll = useCallback(() => {
    refetchPositions();
    refetchTickers();
  }, [refetchPositions, refetchTickers]);

  const handleDelete = async (p: OptionsPosition) => {
    if (!confirm(`Delete ${p.ticker.symbol} $${p.strikePrice} ${p.optionType} position?`)) return;
    await deleteOptionsPosition(p.id);
    refetchPositions();
  };

  const tabClass = (active: boolean) =>
    cn(
      "px-4 py-2 text-sm font-medium border-b-2 transition-colors",
      active
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground"
    );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold">Options Trading</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSettingsModal(true)}>
            <Settings className="h-4 w-4 mr-1.5" />
            Settings
          </Button>
          <Button size="sm" onClick={() => setPositionModal("new")}>
            <Plus className="h-4 w-4 mr-1.5" />
            Open Position
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <SummaryCards
        openPositions={openPositions}
        closedPositions={closedPositions}
        settings={settings ?? null}
      />

      {/* Tabs */}
      <Card>
        <div className="flex border-b border-border px-4">
          <button className={tabClass(tab === "open")} onClick={() => setTab("open")}>
            Open Positions
            {openPositions.length > 0 && (
              <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-xs px-1.5 py-0.5 font-medium">
                {openPositions.length}
              </span>
            )}
          </button>
          <button className={tabClass(tab === "closed")} onClick={() => setTab("closed")}>
            Closed / Expired
            {closedPositions.length > 0 && (
              <span className="ml-2 inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground text-xs px-1.5 py-0.5 font-medium">
                {closedPositions.length}
              </span>
            )}
          </button>
        </div>
        <div className="p-0">
          {tab === "open" ? (
            <OpenPositionsTable
              positions={openPositions}
              onEdit={(p) => setPositionModal(p)}
              onClose={(p) => setCloseModal(p)}
              onDelete={handleDelete}
            />
          ) : (
            <ClosedPositionsTable
              positions={closedPositions}
              onDelete={handleDelete}
            />
          )}
        </div>
      </Card>

      {/* Modals */}
      {(positionModal !== null) && (
        <PositionModal
          tickers={tickers ?? []}
          groups={groups ?? []}
          editing={positionModal === "new" ? null : positionModal}
          onClose={() => setPositionModal(null)}
          onSaved={() => { setPositionModal(null); refetchAll(); }}
          onTickerCreated={refetchTickers}
        />
      )}

      {closeModal && (
        <ClosePositionModal
          position={closeModal}
          onClose={() => setCloseModal(null)}
          onSaved={() => { setCloseModal(null); refetchPositions(); }}
        />
      )}

      {settingsModal && (
        <SettingsModal
          current={settings ?? null}
          onClose={() => setSettingsModal(false)}
          onSaved={() => { setSettingsModal(false); refetchSettings(); }}
        />
      )}
    </div>
  );
}
