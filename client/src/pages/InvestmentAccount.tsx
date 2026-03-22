import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  LineChart,
  Landmark,
  Pencil,
  Check,
  X,
  Upload,
  FileText,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { useApi } from "@/hooks/useApi";
import {
  getInvestmentHoldings,
  getInvestmentActivity,
  getAccounts,
  createHolding,
  patchHolding,
  deleteHolding,
  createLot,
  updateLot,
  deleteLot,
  searchTickers,
  getTickerPrice,
  importInvestments,
  getManualInvestments,
  createManualInvestment,
  updateManualInvestment,
  deleteManualInvestment,
  previewSell,
  executeSell,
  getGainSnapshot,
  upsertGainSnapshot,
  deleteGainSnapshot,
} from "@/api";
import type { SellPreviewResult, SellRequest } from "@/api";
import { formatCurrency, formatDate, toDateInputValue, localToday } from "@/lib/utils";
import type { InvestmentHolding, InvestmentLot, RealizedGainSnapshot, TickerSearchResult, Account, ManualInvestment, InvestmentActivity } from "@/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function Tooltip({ content, children }: { content: React.ReactNode; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const handleMouseEnter = () => {
    if (triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: r.top });
    }
  };

  return (
    <span ref={triggerRef} className="inline-flex" onMouseEnter={handleMouseEnter} onMouseLeave={() => setPos(null)}>
      {children}
      {pos && createPortal(
        <div
          className="pointer-events-none fixed z-[9999]"
          style={{ left: pos.x, top: pos.y, transform: "translate(-50%, calc(-100% - 8px))" }}
        >
          <div className="rounded bg-card border border-border text-foreground text-xs shadow-lg px-2.5 py-1.5 whitespace-nowrap">
            {content}
          </div>
          <div className="w-2 h-2 bg-card border-b border-r border-border rotate-45 mx-auto -mt-[5px]" />
        </div>,
        document.body
      )}
    </span>
  );
}

function GainCell({
  value,
  pct,
  size = "sm",
  tooltip,
}: {
  value: number | null;
  pct?: number | null;
  size?: "sm" | "base";
  tooltip?: React.ReactNode;
}) {
  if (value == null) return <span className="text-muted-foreground tabular-nums">—</span>;
  const pos = value >= 0;
  const Icon = pos ? TrendingUp : TrendingDown;
  const cell = (
    <span
      className={`inline-flex items-center gap-1 font-medium tabular-nums ${
        pos ? "text-green-600" : "text-red-500"
      } text-${size}`}
    >
      <Icon className="h-3 w-3 flex-shrink-0" />
      {formatCurrency(Math.abs(value))}
      {pct != null && (
        <span className="text-xs opacity-60">({Math.abs(pct).toFixed(2)}%)</span>
      )}
    </span>
  );
  if (tooltip) return <Tooltip content={tooltip}>{cell}</Tooltip>;
  return cell;
}

// Hash a ticker string to a stable badge color
const BADGE_COLORS = [
  "#4f46e5", "#0891b2", "#059669", "#d97706",
  "#dc2626", "#7c3aed", "#db2777", "#0284c7",
];
function tickerBadgeColor(ticker: string) {
  let h = 0;
  for (const c of ticker) h = (h * 31 + c.charCodeAt(0)) & 0xffffff;
  return BADGE_COLORS[Math.abs(h) % BADGE_COLORS.length];
}

// ── Smart date input ──────────────────────────────────────────────────────────
// Keeps the native datepicker but also handles pasting MM/DD/YYYY wholesale.

function SmartDateInput({
  value,
  onChange,
  max,
  required,
  autoFocus,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  max?: string;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").trim();
    // MM/DD/YYYY or M/D/YYYY → YYYY-MM-DD
    const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      e.preventDefault();
      onChange(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`);
    }
  };

  return (
    <input
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={handlePaste}
      max={max}
      required={required}
      autoFocus={autoFocus}
      className={className}
    />
  );
}

// ── Dollar-prefix input ───────────────────────────────────────────────────────
// Absolute-positioned $ so it visually lines up with other inputs' left padding.

function DollarInput({
  value,
  onChange,
  placeholder,
  required,
  className,
  inputClassName,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  className?: string;
  inputClassName?: string;
}) {
  return (
    <div className={`relative ${className ?? ""}`}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none select-none">
        $
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        step="0.0001"
        min="0"
        placeholder={placeholder ?? "0.00"}
        required={required}
        className={
          inputClassName ??
          "w-full rounded border border-border pl-7 pr-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        }
      />
    </div>
  );
}

// ── Ticker search autocomplete ────────────────────────────────────────────────

function TickerSearch({
  onSelect,
  onCancel,
}: {
  onSelect: (r: TickerSearchResult) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TickerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        setResults(await searchTickers(q));
        setHighlighted(0);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 300);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted(h => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && results[highlighted]) onSelect(results[highlighted]);
    else if (e.key === "Escape") onCancel();
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); search(e.target.value); }}
        onKeyDown={handleKeyDown}
        placeholder="Search ticker or name (e.g. AAPL, Vanguard S&P)"
        className="w-full rounded-md border border-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      {loading && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">Searching…</div>
      )}
      {results.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border border-border bg-background shadow-lg max-h-64 overflow-y-auto">
          {results.map((r, i) => (
            <button
              key={r.ticker}
              className={`w-full flex items-center justify-between px-3 py-2 text-left hover:bg-accent transition-colors ${i === highlighted ? "bg-accent" : ""}`}
              onMouseEnter={() => setHighlighted(i)}
              onClick={() => onSelect(r)}
            >
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-sm leading-tight">{r.ticker}</span>
                <span className="text-xs text-muted-foreground truncate">{r.name}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0 ml-3">
                <span className="rounded bg-muted px-1.5 py-0.5">{r.type}</span>
                <span>{r.exchange}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {!loading && query.length > 1 && results.length === 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border border-border bg-background shadow-lg px-3 py-4 text-sm text-muted-foreground text-center">
          No results for "{query}"
        </div>
      )}
    </div>
  );
}

// ── Lot form row (modal) ──────────────────────────────────────────────────────

interface LotFormRow {
  quantity: string;
  costPerShare: string;
  acquiredDate: string;
}

function LotFormEntry({
  lot,
  onChange,
  onRemove,
  canRemove,
  hideDate = false,
}: {
  lot: LotFormRow;
  onChange: (field: keyof LotFormRow, value: string) => void;
  onRemove: () => void;
  canRemove: boolean;
  hideDate?: boolean;
}) {
  return (
    <div className="flex gap-3 items-end">
      {!hideDate && (
        <div className="flex-1 min-w-0">
          <label className="text-xs text-muted-foreground block mb-0.5">Acquired Date</label>
          <SmartDateInput
            value={lot.acquiredDate}
            onChange={(v) => onChange("acquiredDate", v)}
            max={localToday()}
            required
            className="w-full rounded border border-border px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <label className="text-xs text-muted-foreground block mb-0.5">{hideDate ? "Total Shares" : "Quantity (shares)"}</label>
        <input
          type="number"
          value={lot.quantity}
          onChange={(e) => onChange("quantity", e.target.value)}
          step="0.000001"
          min="0"
          placeholder="0.00"
          required
          className="w-full rounded border border-border px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex-1 min-w-0">
        <label className="text-xs text-muted-foreground block mb-0.5">{hideDate ? "Total Cost" : "Cost Per Share"}</label>
        <DollarInput
          value={lot.costPerShare}
          onChange={(v) => onChange("costPerShare", v)}
          required
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        className="flex-shrink-0 pb-1 p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Remove lot"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

// ── Add investment modal ──────────────────────────────────────────────────────

function AddInvestmentModal({
  accountId,
  accountName,
  existingHoldings,
  open,
  onClose,
  onSaved,
  managed = false,
}: {
  accountId: string;
  accountName: string;
  existingHoldings: InvestmentHolding[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  managed?: boolean;
}) {
  const [step, setStep] = useState<"search" | "lots">("search");
  const [selectedTicker, setSelectedTicker] = useState<TickerSearchResult | null>(null);
  const [assetClass, setAssetClass] = useState("");
  const [lots, setLots] = useState<LotFormRow[]>([
    { quantity: "", costPerShare: "", acquiredDate: localToday() },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedPrice, setFetchedPrice] = useState<number | null>(null);
  const [fetchingPrice, setFetchingPrice] = useState(false);

  // Reset to search step whenever the modal opens
  useEffect(() => {
    if (open) {
      setStep("search");
      setSelectedTicker(null);
      setAssetClass("");
      setLots([{ quantity: "", costPerShare: "", acquiredDate: localToday() }]);
      setError(null);
      setFetchedPrice(null);
    }
  }, [open]);

  const resetToSearch = () => {
    setStep("search");
    setSelectedTicker(null);
    setAssetClass("");
    setLots([{ quantity: "", costPerShare: "", acquiredDate: localToday() }]);
    setError(null);
    setFetchedPrice(null);
  };

  const handleTickerSelect = async (result: TickerSearchResult) => {
    setSelectedTicker(result);
    setStep("lots");
    setFetchedPrice(null);

    // Fetch live price if not already tracked in holdings
    const existing = existingHoldings.find((h) => h.ticker === result.ticker);
    if (existing?.currentPrice != null) {
      setFetchedPrice(existing.currentPrice);
    } else {
      setFetchingPrice(true);
      try {
        const data = await getTickerPrice(result.ticker);
        setFetchedPrice(data.price);
      } catch {
        // Price fetch is non-fatal; just don't show it
      } finally {
        setFetchingPrice(false);
      }
    }
  };

  const updateLotRow = (i: number, field: keyof LotFormRow, value: string) =>
    setLots((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  const addLotRow = () =>
    setLots((prev) => [...prev, { quantity: "", costPerShare: "", acquiredDate: localToday() }]);
  const removeLotRow = (i: number) =>
    setLots((prev) => prev.filter((_, idx) => idx !== i));

  const doSave = async (): Promise<boolean> => {
    if (!selectedTicker) return false;
    setError(null);
    setSaving(true);
    try {
      const holding = await createHolding({
        accountId,
        ticker: selectedTicker.ticker,
        name: selectedTicker.name,
        type: selectedTicker.type,
        assetClass: assetClass.trim() || null,
      });
      for (const lot of lots) {
        const qty = parseFloat(lot.quantity);
        const rawCost = parseFloat(lot.costPerShare);
        if (isNaN(qty) || isNaN(rawCost) || qty <= 0) continue;
        // Managed mode: field holds total cost — derive cost-per-share automatically
        const costPerShare = managed ? rawCost / qty : rawCost;
        await createLot({
          holdingId: holding.id,
          quantity: qty,
          costPerShare,
          acquiredDate: managed ? null : lot.acquiredDate,
        });
      }
      return true;
    } catch (err: any) {
      setError(err?.message ?? "Failed to save. Please try again.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await doSave()) { onSaved(); onClose(); }
  };

  const handleSaveAndAddAnother = async () => {
    if (await doSave()) { onSaved(); resetToSearch(); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add to ${accountName}`}
      // Narrower width; no max-h so dropdown isn't clipped during search
      className={step === "search" ? "max-w-xl" : "max-w-xl max-h-[90vh]"}
      // During search: no overflow clipping (dropdown is absolutely positioned)
      // During lots: scrollable for multi-lot forms
      contentClassName={step === "search" ? "px-6 pb-6" : "overflow-y-auto px-6 pb-6"}
    >
      {step === "search" ? (
        <TickerSearch onSelect={handleTickerSelect} onCancel={onClose} />
      ) : (
        <form onSubmit={handleSave} className="space-y-5">
          {/* Ticker header card */}
          <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted/20">
            <button
              type="button"
              onClick={resetToSearch}
              className="text-muted-foreground hover:text-foreground flex-shrink-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div
              className="h-9 w-9 rounded flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
              style={{ backgroundColor: tickerBadgeColor(selectedTicker?.ticker ?? "") }}
            >
              {(selectedTicker?.ticker ?? "").slice(0, 3)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-bold text-sm">{selectedTicker?.ticker}</span>
                <span className="text-sm text-muted-foreground truncate">{selectedTicker?.name}</span>
              </div>
              {fetchingPrice ? (
                <p className="text-xs text-muted-foreground mt-0.5">Fetching price…</p>
              ) : fetchedPrice != null ? (
                <p className="text-xs text-muted-foreground mt-0.5">{formatCurrency(fetchedPrice)}</p>
              ) : null}
            </div>
          </div>

          {/* Asset class */}
          <div>
            <label className="text-xs text-muted-foreground block mb-0.5">Asset Class <span className="italic">(optional)</span></label>
            <input
              type="text"
              value={assetClass}
              onChange={(e) => setAssetClass(e.target.value)}
              placeholder="e.g. US Stocks, Commodities"
              className="w-full rounded border border-border px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {managed && (
            <p className="text-xs text-muted-foreground bg-muted/40 rounded px-3 py-2">
              Managed account: enter total shares and total cost basis — cost per share is calculated automatically. Short/long-term gain breakdown will come from the realized gains panel.
            </p>
          )}

          {/* Lot form rows */}
          <div className="space-y-3">
            {lots.map((lot, i) => (
              <LotFormEntry
                key={i}
                lot={lot}
                onChange={(field, value) => updateLotRow(i, field, value)}
                onRemove={() => removeLotRow(i)}
                canRemove={lots.length > 1}
                hideDate={managed}
              />
            ))}
          </div>

          {!managed && (
            <button
              type="button"
              onClick={addLotRow}
              className="flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <Plus className="h-3.5 w-3.5" />
              More purchases of {selectedTicker?.ticker}
            </button>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={handleSaveAndAddAnother}
            >
              {saving ? "Saving…" : "Save & add another"}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ── Lot-level gain calculations ───────────────────────────────────────────────

function computeLotGains(
  quantity: string,
  costPerShare: string,
  acquiredDate: string | null,
  currentPrice: number | null
) {
  const qty = parseFloat(quantity);
  const cps = parseFloat(costPerShare);
  const totalCost = qty * cps;
  if (currentPrice == null)
    return { totalCost, marketValue: null, totalGain: null, shortTermGain: null, longTermGain: null };
  const marketValue = qty * currentPrice;
  const totalGain = marketValue - totalCost;
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : null;
  // No date = managed lot; short/long-term split unavailable
  if (acquiredDate == null)
    return { totalCost, marketValue, totalGain, totalGainPct, shortTermGain: null, longTermGain: null };
  const now = new Date();
  const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const acquired = new Date(acquiredDate);
  const gain = (currentPrice - cps) * qty;
  const isShortTerm = acquired > oneYearAgo;
  return {
    totalCost,
    marketValue,
    totalGain,
    totalGainPct,
    shortTermGain: isShortTerm ? gain : null,
    longTermGain: isShortTerm ? null : gain,
  };
}

// ── Inline lot editor ─────────────────────────────────────────────────────────

function LotRow({
  lot,
  currentPrice,
  onDeleted,
  onUpdated,
}: {
  lot: InvestmentLot;
  currentPrice: number | null;
  onDeleted: () => void;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState(lot.quantity);
  const [cps, setCps] = useState(lot.costPerShare);
  const [date, setDate] = useState(lot.acquiredDate ? toDateInputValue(lot.acquiredDate) : "");
  const [saving, setSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateLot(lot.id, {
        quantity: parseFloat(qty),
        costPerShare: parseFloat(cps),
        acquiredDate: date || null,
      });
      setEditing(false);
      onUpdated();
    } finally { setSaving(false); }
  };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      await deleteLot(lot.id);
      onDeleted();
    } finally {
      setDeleting(false);
      setShowDeleteModal(false);
    }
  };

  const gains = computeLotGains(lot.quantity, lot.costPerShare, lot.acquiredDate, currentPrice);

  if (editing) {
    const editTotalCost = parseFloat(qty || "0") * parseFloat(cps || "0");
    return (
      <tr className="bg-primary/5 text-xs">
        {/* Cols 1-2: date spans Symbol + Name */}
        <td colSpan={2} className="py-2 pl-4 pr-2">
          <SmartDateInput
            value={date}
            max={localToday()}
            onChange={setDate}
            className="rounded border border-border px-2 py-1 text-xs w-[120px] focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </td>
        {/* Col 3: cost/share */}
        <td className="py-2 px-2">
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs pointer-events-none select-none">$</span>
            <input
              type="number"
              value={cps}
              step="0.0001"
              onChange={(e) => setCps(e.target.value)}
              className="w-full rounded border border-border pl-5 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary tabular-nums"
            />
          </div>
        </td>
        {/* Col 4: quantity */}
        <td className="py-2 px-2">
          <input
            type="number"
            value={qty}
            step="0.000001"
            onChange={(e) => setQty(e.target.value)}
            className="w-full rounded border border-border px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </td>
        {/* Col 5: computed total cost */}
        <td className="py-2 px-2 tabular-nums text-muted-foreground">{formatCurrency(editTotalCost)}</td>
        {/* Cols 6–8: save/cancel */}
        <td colSpan={3} className="py-2 px-2">
          <div className="flex items-center gap-2">
            <button onClick={handleSave} disabled={saving} className="text-green-600 hover:text-green-700">
              <Check className="h-4 w-4" />
            </button>
            <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr className="text-xs text-muted-foreground hover:bg-muted/30 group">
        <td colSpan={2} className="py-2 pl-4 pr-2">
          {lot.acquiredDate ? formatDate(lot.acquiredDate) : <span className="italic text-muted-foreground/60">Managed</span>}
        </td>
        <td className="py-2 px-2 tabular-nums">{formatCurrency(lot.costPerShare)}</td>
        <td className="py-2 px-2 tabular-nums">
          {parseFloat(lot.quantity).toLocaleString(undefined, { maximumFractionDigits: 6 })}
        </td>
        <td className="py-2 px-2 tabular-nums">{formatCurrency(gains.totalCost)}</td>
        <td className="py-2 px-2 tabular-nums">
          {gains.marketValue != null ? formatCurrency(gains.marketValue) : "—"}
        </td>
        <td className="py-2 pl-2 pr-2 tabular-nums">
          <GainCell value={gains.totalGain} pct={gains.totalGainPct} />
        </td>
        <td className="py-2 pr-3">
          <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => setEditing(true)} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setShowDeleteModal(true)} className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </td>
      </tr>
      {showDeleteModal && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg bg-background text-foreground p-6 shadow-xl">
            <h3 className="text-base font-semibold">Delete {lot.acquiredDate ? formatDate(lot.acquiredDate) : "managed"} lot?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete this lot? This action cannot be undone.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? "Deleting..." : "Confirm Delete"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ── Add lot inline ────────────────────────────────────────────────────────────

function AddLotRow({
  holdingId,
  defaultDate,
  onSaved,
  onCancel,
  managed = false,
  initialAssetClass = null,
}: {
  holdingId: string;
  defaultDate: string | null;
  onSaved: () => void;
  onCancel: () => void;
  managed?: boolean;
  initialAssetClass?: string | null;
}) {
  const [qty, setQty] = useState("");
  const [cps, setCps] = useState("");
  const [date, setDate] = useState(defaultDate ?? localToday());
  const [assetClass, setAssetClass] = useState(initialAssetClass ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const quantity = parseFloat(qty);
    const rawCost = parseFloat(cps);
    if (isNaN(quantity) || isNaN(rawCost) || quantity <= 0) return;
    // Managed mode: field holds total cost — derive cost-per-share automatically
    const costPerShare = managed ? rawCost / quantity : rawCost;
    setSaving(true);
    try {
      await createLot({ holdingId, quantity, costPerShare, acquiredDate: managed ? null : date });
      // Also persist the asset class if it changed
      if (managed) {
        const newClass = assetClass.trim() || null;
        if (newClass !== initialAssetClass) {
          await patchHolding(holdingId, { assetClass: newClass });
        }
      }
      onSaved();
    } finally { setSaving(false); }
  };

  // For managed mode the form is rendered inline (not as a table row)
  if (managed) {
    return (
      <form onSubmit={handleSave} className="flex gap-3 items-end">
        <div className="flex-1 min-w-0">
          <label className="text-xs text-muted-foreground block mb-0.5">Total Shares</label>
          <input
            type="number"
            value={qty}
            step="0.000001"
            min="0"
            placeholder="0.00"
            autoFocus
            onChange={(e) => setQty(e.target.value)}
            className="w-full rounded border border-border px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex-1 min-w-0">
          <label className="text-xs text-muted-foreground block mb-0.5">Total Cost</label>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs pointer-events-none select-none">$</span>
            <input
              type="number"
              value={cps}
              step="0.01"
              min="0"
              placeholder="0.00"
              onChange={(e) => setCps(e.target.value)}
              className="w-full rounded border border-border pl-5 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary tabular-nums"
            />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <label className="text-xs text-muted-foreground block mb-0.5">Asset Class <span className="italic font-normal">(optional)</span></label>
          <input
            type="text"
            value={assetClass}
            onChange={(e) => setAssetClass(e.target.value)}
            placeholder="e.g. US Stocks"
            className="w-full rounded border border-border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex items-center gap-2 pb-0.5">
          <Button type="submit" disabled={saving} className="h-7 text-xs px-2 py-0">
            {saving ? "Saving…" : "Save"}
          </Button>
          <button type="button" onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <tr className="bg-muted text-xs">
      <td colSpan={2} className="py-2 pl-4 pr-2">
        <SmartDateInput
          value={date}
          max={localToday()}
          onChange={setDate}
          autoFocus
          className="rounded border border-border px-2 py-1 text-xs w-[120px] focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </td>
      <td className="py-2 px-2">
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs pointer-events-none select-none">$</span>
          <input
            type="number"
            value={cps}
            step="0.0001"
            min="0"
            placeholder="0.00"
            onChange={(e) => setCps(e.target.value)}
            className="w-full rounded border border-border pl-5 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary tabular-nums"
          />
        </div>
      </td>
      <td className="py-2 px-2">
        <input
          type="number"
          value={qty}
          step="0.000001"
          min="0"
          placeholder="0.00"
          onChange={(e) => setQty(e.target.value)}
          className="w-full rounded border border-border px-2 py-1 text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </td>
      <td colSpan={4} className="py-2 px-2">
        <form onSubmit={handleSave} className="flex items-center gap-2">
          <Button type="submit" disabled={saving} className="h-7 text-xs px-2 py-0">
            {saving ? "Saving…" : "Save"}
          </Button>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Cancel
          </button>
        </form>
      </td>
    </tr>
  );
}

// ── Holding row ───────────────────────────────────────────────────────────────

function HoldingRow({
  holding,
  expanded,
  onToggle,
  onDeleted,
  onUpdated,
  onSell,
  rowRef,
}: {
  holding: InvestmentHolding;
  expanded: boolean;
  onToggle: () => void;
  onDeleted: () => void;
  onUpdated: () => void;
  onSell: () => void;
  rowRef?: (el: HTMLTableRowElement | null) => void;
}) {
  const [addingLot, setAddingLot] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editingAssetClass, setEditingAssetClass] = useState(false);
  const [assetClassDraft, setAssetClassDraft] = useState(holding.assetClass ?? "");
  const [savingAssetClass, setSavingAssetClass] = useState(false);

  const handleAssetClassSave = async () => {
    setSavingAssetClass(true);
    try {
      await patchHolding(holding.id, { assetClass: assetClassDraft.trim() || null });
      setEditingAssetClass(false);
      onUpdated();
    } finally { setSavingAssetClass(false); }
  };

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      await deleteHolding(holding.id);
      onDeleted();
    } finally {
      setDeleting(false);
      setShowDeleteModal(false);
    }
  };

  return (
    <>
      <tr
        ref={rowRef}
        className="hover:bg-muted/30 cursor-pointer border-b border-border"
        onClick={onToggle}
      >
        <td className="py-3 pl-4 pr-2">
          <span className="font-bold text-sm">{holding.ticker}</span>
        </td>
        <td className="py-3 px-2 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-muted-foreground truncate">{holding.name}</span>
          </div>
        </td>
        <td className="py-3 px-2 text-sm tabular-nums">
          {holding.currentPrice != null ? formatCurrency(holding.currentPrice) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="py-3 px-2 text-sm tabular-nums">
          {holding.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
        </td>
        <td className="py-3 px-2 text-sm tabular-nums">{formatCurrency(holding.totalCost)}</td>
        <td className="py-3 px-2 text-sm tabular-nums font-medium">
          {holding.marketValue != null ? formatCurrency(holding.marketValue) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="py-3 pl-2 pr-2 text-sm relative z-10">
          <GainCell
            value={holding.totalGain}
            pct={holding.totalGainPct}
            tooltip={
              holding.totalGain != null ? (
                <span className="flex flex-col gap-0.5">
                  <span className="text-muted-foreground">Short-term: <span className="font-medium text-foreground">{holding.shortTermGain ? formatCurrency(holding.shortTermGain) : "—"}</span></span>
                  <span className="text-muted-foreground">Long-term: <span className="font-medium text-foreground">{holding.longTermGain ? formatCurrency(holding.longTermGain) : "—"}</span></span>
                </span>
              ) : undefined
            }
          />
        </td>
        <td className="py-3 pr-3" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1 justify-end">
            {holding.totalQuantity > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); onSell(); }}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors text-[11px] font-medium"
                title="Record a sale"
              >
                Sell
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setShowDeleteModal(true); }}
              className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title="Delete holding"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              className="p-1.5 rounded text-muted-foreground hover:bg-accent transition-colors"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          </div>
        </td>
      </tr>

      {expanded && (
        <>
          {holding.isManaged ? (
            /* Managed holding: show aggregate info + asset class editor instead of lots */
            <tr className="border-b border-border bg-muted/10">
              <td colSpan={8} className="py-3 pl-4 pr-4">
                <div className="flex flex-wrap items-start gap-6 text-sm">
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-0.5">Total Shares</p>
                    <p className="font-medium tabular-nums">
                      {holding.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-0.5">Avg Cost / Share</p>
                    <p className="font-medium tabular-nums">
                      {holding.totalQuantity > 0 ? formatCurrency(holding.totalCost / holding.totalQuantity) : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-0.5">Asset Class</p>
                    <p className="font-medium">
                      {holding.assetClass ?? <span className="italic text-muted-foreground text-xs">None set</span>}
                    </p>
                  </div>
                  <div className="ml-auto self-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); setAddingLot(true); }}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      title="Update aggregate position"
                    >
                      <Pencil className="h-3 w-3" />
                      Update position
                    </button>
                  </div>
                </div>
                {addingLot && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <p className="text-xs text-muted-foreground mb-2">Replace aggregate position (total shares + total cost basis):</p>
                    <AddLotRow
                      holdingId={holding.id}
                      defaultDate={null}
                      onSaved={() => { setAddingLot(false); onUpdated(); }}
                      onCancel={() => setAddingLot(false)}
                      managed
                      initialAssetClass={holding.assetClass}
                    />
                  </div>
                )}
              </td>
            </tr>
          ) : (
            <>
              {/* Lot sub-header: "Purchase Date" spans Symbol+Name so it never wraps */}
              <tr className="bg-muted/20 text-[11px] text-muted-foreground uppercase tracking-wide">
                <th colSpan={2} className="py-1.5 pl-4 pr-2 text-left font-medium whitespace-nowrap">
                  Purchase Date
                </th>
                <th className="py-1.5 px-2 text-left font-medium">Price</th>
                <th className="py-1.5 px-2 text-left font-medium">Quantity</th>
                <th className="py-1.5 px-2 text-left font-medium">Total Cost</th>
                <th className="py-1.5 px-2 text-left font-medium">Market Value</th>
                <th className="py-1.5 pl-2 pr-2 text-left font-medium">Total Gain</th>
                <th className="py-1.5 pr-3" />
              </tr>

              {holding.lots.map((lot) => (
                <LotRow
                  key={lot.id}
                  lot={lot}
                  currentPrice={holding.currentPrice}
                  onDeleted={onUpdated}
                  onUpdated={onUpdated}
                />
              ))}

              {addingLot && (
                <AddLotRow
                  holdingId={holding.id}
                  defaultDate={
                    holding.lots.length > 0 && holding.lots[holding.lots.length - 1].acquiredDate
                      ? toDateInputValue(holding.lots[holding.lots.length - 1].acquiredDate!)
                      : localToday()
                  }
                  onSaved={() => { setAddingLot(false); onUpdated(); }}
                  onCancel={() => setAddingLot(false)}
                />
              )}

              {!addingLot && (
                <tr>
                  <td colSpan={8} className="py-2 pl-4 pr-4">
                    <button
                      onClick={(e) => { e.stopPropagation(); setAddingLot(true); }}
                      className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Record another purchase
                    </button>
                  </td>
                </tr>
              )}

              {/* Asset class editor — always editable regardless of managed status */}
              <tr className="border-b border-border bg-muted/5">
                <td colSpan={8} className="py-2 pl-4 pr-4">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="uppercase tracking-wide font-medium">Asset Class</span>
                    <span className="text-border">·</span>
                    {editingAssetClass ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={assetClassDraft}
                          onChange={(e) => setAssetClassDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleAssetClassSave(); if (e.key === "Escape") setEditingAssetClass(false); }}
                          autoFocus
                          placeholder="e.g. US Stocks"
                          className="rounded border border-border px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary w-36"
                        />
                        <button onClick={handleAssetClassSave} disabled={savingAssetClass} className="text-green-600 hover:text-green-700">
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setEditingAssetClass(false)} className="text-muted-foreground hover:text-foreground">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setAssetClassDraft(holding.assetClass ?? ""); setEditingAssetClass(true); }}
                        className="flex items-center gap-1 hover:text-foreground transition-colors group"
                      >
                        {holding.assetClass
                          ? <span className="font-medium text-foreground">{holding.assetClass}</span>
                          : <span className="italic">None set</span>
                        }
                        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity ml-0.5" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            </>
          )}
        </>
      )}
      {showDeleteModal && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg bg-background text-foreground p-6 shadow-xl">
            <h3 className="text-base font-semibold">Delete {holding.ticker}?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete this investment? This action cannot be undone.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? "Deleting..." : "Confirm Delete"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ── Investment import modal ───────────────────────────────────────────────────

interface ImportRow {
  raw: string[];
  symbol: string;
  purchaseDate: string;
  price: number;
  quantity: number;
  errors: string[];
}

function parseImportDate(s: string): string | null {
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

function parseImportCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === delimiter) { fields.push(current.trim()); current = ""; }
      else { current += ch; }
    }
  }
  fields.push(current.trim());
  return fields;
}

function ImportInvestmentsModal({
  accountId,
  open,
  onClose,
  onComplete,
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<"upload" | "preview" | "result">("upload");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [showErrorsOnly, setShowErrorsOnly] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; errors: Array<{ row: number; message: string }> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setStep("upload");
      setRows([]);
      setResult(null);
      setImporting(false);
      setShowErrorsOnly(false);
    }
  }, [open]);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return;

      const delimiter = lines[0].includes("\t") ? "\t" : ",";
      const parsed: ImportRow[] = [];

      for (let i = 1; i < lines.length; i++) {
        const fields = parseImportCSVLine(lines[i], delimiter);
        if (fields.length < 4) continue;

        const [rawSymbol, rawDate, rawPrice, rawQty] = fields;
        const errors: string[] = [];

        const symbol = rawSymbol?.trim().toUpperCase() || "";
        if (!symbol) errors.push("Missing symbol");

        const purchaseDate = parseImportDate(rawDate ?? "");
        if (!purchaseDate) errors.push("Invalid date");

        const cleanPrice = rawPrice?.replace(/[$,]/g, "") ?? "";
        const price = parseFloat(cleanPrice);
        if (isNaN(price) || price < 0) errors.push("Invalid price");

        const cleanQty = rawQty?.replace(/,/g, "") ?? "";
        const quantity = parseFloat(cleanQty);
        if (isNaN(quantity) || quantity <= 0) errors.push("Invalid quantity");

        parsed.push({
          raw: fields,
          symbol,
          purchaseDate: purchaseDate || rawDate?.trim() || "",
          price: isNaN(price) ? 0 : price,
          quantity: isNaN(quantity) ? 0 : quantity,
          errors,
        });
      }

      setRows(parsed);
      setStep("preview");
    };
    reader.readAsText(file);
  };

  const validRows = useMemo(() => rows.filter((r) => r.errors.length === 0), [rows]);
  const errorRows = useMemo(() => rows.filter((r) => r.errors.length > 0), [rows]);
  const visibleRows = showErrorsOnly ? errorRows : rows;

  const handleImport = async () => {
    setImporting(true);
    try {
      const res = await importInvestments(
        accountId,
        validRows.map((r) => ({
          symbol: r.symbol,
          purchaseDate: r.purchaseDate,
          price: r.price,
          quantity: r.quantity,
        }))
      );
      setResult(res);
      setStep("result");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Import request failed";
      setResult({ imported: 0, errors: [{ row: 0, message }] });
      setStep("result");
    }
    setImporting(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Import Investments">
      {step === "upload" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload a CSV or TSV file with these columns in order:
          </p>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono">
            Symbol, Purchase Date, Price, Quantity
          </div>
          <p className="text-xs text-muted-foreground">
            First row should be a header (it will be skipped). Dates can be YYYY-MM-DD or M/D/YYYY.
            Symbols are case-insensitive. If a holding for a symbol doesn't exist yet, it will be
            created automatically.
          </p>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt"
              onChange={handleFile}
              className="hidden"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              className="w-full justify-center"
            >
              <FileText className="h-4 w-4" /> Choose File
            </Button>
          </div>
          <div className="flex justify-end pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {validRows.length} of {rows.length} rows valid
            </p>
            {errorRows.length > 0 && (
              <button
                type="button"
                onClick={() => setShowErrorsOnly((v) => !v)}
                className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${
                  showErrorsOnly
                    ? "bg-destructive/15 text-destructive font-medium"
                    : "text-destructive hover:bg-destructive/10"
                }`}
              >
                <AlertCircle className="h-3 w-3" />
                {errorRows.length} error{errorRows.length !== 1 ? "s" : ""}
                {showErrorsOnly ? " — show all" : " — show only"}
              </button>
            )}
          </div>

          <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-2 py-1.5 font-medium">#</th>
                  <th className="px-2 py-1.5 font-medium">Symbol</th>
                  <th className="px-2 py-1.5 font-medium">Purchase Date</th>
                  <th className="px-2 py-1.5 font-medium text-right">Price</th>
                  <th className="px-2 py-1.5 font-medium text-right">Quantity</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const i = rows.indexOf(row);
                  return (
                    <tr
                      key={i}
                      className={`border-b border-border ${row.errors.length > 0 ? "bg-destructive/5" : ""}`}
                    >
                      <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-1.5 font-semibold">{row.symbol || "—"}</td>
                      <td className="px-2 py-1.5">{row.purchaseDate}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {row.price > 0 ? formatCurrency(row.price) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {row.quantity > 0
                          ? row.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })
                          : "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        {row.errors.length > 0 ? (
                          <span className="text-destructive" title={row.errors.join("; ")}>
                            <AlertCircle className="inline h-3 w-3" /> {row.errors[0]}
                          </span>
                        ) : (
                          <span className="text-green-600">
                            <Check className="inline h-3 w-3" />
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setStep("upload");
                setRows([]);
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              Back
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button
                type="button"
                disabled={validRows.length === 0 || importing}
                onClick={handleImport}
              >
                {importing
                  ? "Importing..."
                  : `Import ${validRows.length} Lot${validRows.length !== 1 ? "s" : ""}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === "result" && result && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 p-4">
            <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0" />
            <div>
              <p className="text-sm font-medium">
                {result.imported} lot{result.imported !== 1 ? "s" : ""} imported successfully
              </p>
              {result.errors.length > 0 && (
                <p className="text-xs text-destructive mt-1">
                  {result.errors.length} row{result.errors.length !== 1 ? "s" : ""} failed
                </p>
              )}
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="max-h-[150px] overflow-auto rounded-md border border-border p-2 text-xs text-destructive">
              {result.errors.map((e, i) => (
                <div key={i}>Row {e.row}: {e.message}</div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={() => { onComplete(); onClose(); }}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Add / Edit manual investment modal ────────────────────────────────────────

function AddManualInvestmentModal({
  accountId,
  open,
  onClose,
  onSaved,
  editing,
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editing?: ManualInvestment;
}) {
  const [name, setName] = useState("");
  const [assetClass, setAssetClass] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [marketValue, setMarketValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setAssetClass(editing?.assetClass ?? "");
      setTotalCost(editing?.totalCost != null ? String(editing.totalCost) : "");
      setMarketValue(editing ? String(editing.marketValue) : "");
      setError(null);
    }
  }, [open, editing]);

  const parsedCost = totalCost !== "" ? parseFloat(totalCost) : null;
  const parsedMV = marketValue !== "" ? parseFloat(marketValue) : NaN;
  const totalGain = parsedCost != null && !isNaN(parsedMV) ? parsedMV - parsedCost : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data = {
        name: name.trim(),
        assetClass: assetClass.trim() || null,
        totalCost: parsedCost,
        marketValue: parsedMV,
      };
      if (editing) {
        await updateManualInvestment(editing.id, data);
      } else {
        await createManualInvestment({ accountId, ...data });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit Manual Investment" : "Add Manual Investment"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium block mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Corp Series B"
              required
              autoFocus
              className="w-full rounded border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">
              Asset Class <span className="text-muted-foreground font-normal text-xs">(optional)</span>
            </label>
            <input
              type="text"
              value={assetClass}
              onChange={(e) => setAssetClass(e.target.value)}
              placeholder="e.g. Private Equity"
              className="w-full rounded border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium block mb-1">
              Total Cost{" "}
              <span className="text-muted-foreground font-normal text-xs">(optional)</span>
            </label>
            <DollarInput value={totalCost} onChange={setTotalCost} placeholder="0.00" />
          </div>
          <div>
            <label className="text-sm font-medium block mb-1">Market Value</label>
            <DollarInput value={marketValue} onChange={setMarketValue} placeholder="0.00" required />
          </div>
        </div>

        {totalGain != null && (
          <div className="rounded-md bg-muted/40 border border-border px-4 py-2.5 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total Gain</span>
            <GainCell value={totalGain} />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : editing ? "Save changes" : "Add investment"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Manual holding row (renders inside the main Holdings table) ───────────────

function ManualHoldingRow({
  entry,
  onEdit,
  onDeleted,
}: {
  entry: ManualInvestment;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const gain = entry.totalCost != null ? entry.marketValue - entry.totalCost : null;

  const handleDeleteConfirm = async () => {
    setDeleting(true);
    try {
      await deleteManualInvestment(entry.id);
      onDeleted();
    } finally {
      setDeleting(false);
      setShowDeleteModal(false);
    }
  };

  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
        {/* Symbol — blank for manual entries */}
        <td className="py-3 pl-4 pr-2 text-sm text-muted-foreground">—</td>
        {/* Name */}
        <td className="py-3 px-2 text-sm max-w-0">
          <span className="block truncate">{entry.name}</span>
        </td>
        {/* Price — blank */}
        <td className="py-3 px-2 text-sm text-muted-foreground">—</td>
        {/* Quantity — blank */}
        <td className="py-3 px-2 text-sm text-muted-foreground">—</td>
        {/* Total Cost */}
        <td className="py-3 px-2 text-sm tabular-nums">
          {entry.totalCost != null
            ? formatCurrency(entry.totalCost)
            : <span className="text-muted-foreground">—</span>}
        </td>
        {/* Market Value */}
        <td className="py-3 px-2 text-sm tabular-nums">{formatCurrency(entry.marketValue)}</td>
        {/* Total Gain */}
        <td className="py-3 pl-2 pr-2 text-sm"><GainCell value={gain} /></td>
        {/* Actions: edit + delete (replaces the expand chevron used by regular rows) */}
        <td className="py-3 pr-3">
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={onEdit}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="Delete manual investment"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </td>
      </tr>
      {showDeleteModal && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg bg-background text-foreground p-6 shadow-xl">
            <h3 className="text-base font-semibold">Delete {entry.name}?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete this investment? This action cannot be undone.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                disabled={deleting}
                className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? "Deleting..." : "Confirm Delete"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyPortfolio({
  onAdd,
  onImport,
  onAddManual,
}: {
  onAdd: () => void;
  onImport: () => void;
  onAddManual: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-5">
      <div className="relative w-48 h-32">
        <svg viewBox="0 0 192 128" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
          <ellipse cx="96" cy="64" rx="80" ry="60" fill="#f1f5f9" />
          <line x1="32" y1="64" x2="160" y2="64" stroke="#cbd5e1" strokeWidth="1" />
          <circle cx="32" cy="64" r="4" fill="#94a3b8" />
          <circle cx="80" cy="64" r="4" fill="#94a3b8" />
          <circle cx="112" cy="64" r="4" fill="#94a3b8" />
          <circle cx="160" cy="64" r="4" fill="#94a3b8" />
          <path d="M32 64 Q48 40 80 50 Q96 55 112 64 Q136 74 160 48" stroke="#93c5fd" strokeWidth="2" strokeDasharray="6 4" fill="none" />
        </svg>
      </div>
      <div className="text-center">
        <p className="font-semibold text-lg">Nothing in this portfolio yet</p>
        <p className="text-muted-foreground text-sm mt-1">
          Add investments to see performance and track returns
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={onAdd} className="px-6">
          <Plus className="h-4 w-4" />
          Add investments
        </Button>
        <Button variant="secondary" onClick={onImport} className="px-6">
          <Upload className="h-4 w-4" />
          Import
        </Button>
        <Button variant="secondary" onClick={onAddManual} className="px-6">
          <Pencil className="h-4 w-4" />
          Add manual
        </Button>
      </div>
    </div>
  );
}

// ── Sticky holding row portal ─────────────────────────────────────────────────

function StickyHoldingRow({
  holding,
  expanded,
  onToggle,
}: {
  holding: InvestmentHolding;
  expanded: boolean;
  onToggle: () => void;
}) {
  return createPortal(
    <div style={{ position: "fixed", top: 56, left: 0, right: 0, zIndex: 40 }}>
      <div className="mx-auto max-w-7xl px-4 md:px-6">
        <div className="border-x border-b border-border bg-card">
          <div className="overflow-x-auto">
            <div className="px-6">
              <table style={{ tableLayout: "fixed", width: "100%", minWidth: "1080px" }}>
                <colgroup>
                  <col style={{ width: "80px" }} />
                  <col style={{ width: "400px" }} />
                  <col style={{ width: "100px" }} />
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "120px" }} />
                  <col style={{ width: "120px" }} />
                  <col />
                  <col style={{ width: "60px" }} />
                </colgroup>
                <tbody>
                  <tr
                    className="hover:bg-muted/30 cursor-pointer"
                    onClick={onToggle}
                  >
                    <td className="py-3 pl-4 pr-2">
                      <span className="font-bold text-sm">{holding.ticker}</span>
                    </td>
                    <td className="py-3 px-2 overflow-hidden">
                      <span className="text-sm text-muted-foreground truncate block">{holding.name}</span>
                    </td>
                    <td className="py-3 px-2 text-sm tabular-nums">
                      {holding.currentPrice != null ? formatCurrency(holding.currentPrice) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 px-2 text-sm tabular-nums">
                      {holding.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </td>
                    <td className="py-3 px-2 text-sm tabular-nums">{formatCurrency(holding.totalCost)}</td>
                    <td className="py-3 px-2 text-sm tabular-nums font-medium">
                      {holding.marketValue != null ? formatCurrency(holding.marketValue) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 pl-2 pr-2 text-sm">
                      <GainCell value={holding.totalGain} pct={holding.totalGainPct} />
                    </td>
                    <td className="py-3 pr-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={(e) => { e.stopPropagation(); onToggle(); }}
                          className="p-1.5 rounded text-muted-foreground hover:bg-accent transition-colors"
                          title={expanded ? "Collapse" : "Expand"}
                        >
                          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Sell Modal ────────────────────────────────────────────────────────────────

const COST_BASIS_METHODS = [
  { value: "FIFO", label: "FIFO — First In, First Out", description: "Sells oldest lots first. Simple and predictable." },
  { value: "LIFO", label: "LIFO — Last In, First Out", description: "Sells newest lots first. May maximize short-term activity." },
  { value: "MIN_TAX", label: "Min Tax — Highest Cost Basis First", description: "Sells lots with the highest purchase price first, minimizing your taxable gain." },
  { value: "MAX_GAIN", label: "Max Gain — Lowest Cost Basis First", description: "Sells lots with the lowest purchase price first, maximizing your realized gain." },
] as const;

function SellModal({
  holding,
  accounts,
  onClose,
  onSold,
}: {
  holding: InvestmentHolding;
  accounts: Account[];
  onClose: () => void;
  onSold: () => void;
}) {
  const [step, setStep] = useState<"input" | "preview">("input");
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState(
    holding.currentPrice != null ? holding.currentPrice.toFixed(4) : ""
  );
  const [saleDate, setSaleDate] = useState(localToday());
  const [fees, setFees] = useState("");
  const [method, setMethod] = useState<"FIFO" | "LIFO" | "MIN_TAX" | "MAX_GAIN">("MIN_TAX");
  const [destAccountId, setDestAccountId] = useState("");
  const [preview, setPreview] = useState<SellPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eligibleAccounts = accounts.filter((a) => a.type !== "CREDIT_CARD");
  const maxShares = holding.totalQuantity;
  const methodInfo = COST_BASIS_METHODS.find((m) => m.value === method)!;

  const handlePreview = async () => {
    setError(null);
    const sharesToSell = parseFloat(shares);
    const pricePerShare = parseFloat(price);
    if (isNaN(sharesToSell) || sharesToSell <= 0) return setError("Enter a valid number of shares.");
    if (isNaN(pricePerShare) || pricePerShare <= 0) return setError("Enter a valid sale price.");
    if (sharesToSell > maxShares + 0.000001) return setError(`Cannot sell more than ${maxShares.toLocaleString(undefined, { maximumFractionDigits: 6 })} shares.`);
    if (!destAccountId) return setError("Select a destination account.");

    setLoading(true);
    try {
      const result = await previewSell({
        holdingId: holding.id,
        sharesToSell,
        pricePerShare,
        saleDate,
        fees: parseFloat(fees) || 0,
        costBasisMethod: method,
      });
      setPreview(result);
      setStep("preview");
    } catch (e: any) {
      setError(e?.message ?? "Failed to preview sale.");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setSubmitting(true);
    setError(null);
    try {
      await executeSell({
        holdingId: holding.id,
        sharesToSell: parseFloat(shares),
        pricePerShare: parseFloat(price),
        saleDate,
        fees: parseFloat(fees) || 0,
        costBasisMethod: method,
        destinationAccountId: destAccountId,
      });
      onSold();
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "Failed to record sale.");
      setStep("input");
    } finally {
      setSubmitting(false);
    }
  };

  const gainColor = (v: number) =>
    v >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-500 dark:text-red-400";

  return (
    <Modal
      open
      onClose={onClose}
      title={`Sell ${holding.ticker}`}
      className={step === "preview" ? "max-w-3xl" : "max-w-lg"}
    >
      {step === "input" ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Available: <span className="font-medium text-foreground">{maxShares.toLocaleString(undefined, { maximumFractionDigits: 6 })} shares</span>
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Shares to Sell</label>
              <input
                type="number"
                value={shares}
                step="0.000001"
                min="0.000001"
                max={maxShares}
                placeholder="0.000000"
                onChange={(e) => setShares(e.target.value)}
                className="w-full rounded border border-border px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Sale Price / Share</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                <input
                  type="number"
                  value={price}
                  step="0.0001"
                  min="0"
                  placeholder="0.00"
                  onChange={(e) => setPrice(e.target.value)}
                  className="w-full rounded border border-border pl-7 pr-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Sale Date</label>
              <SmartDateInput
                value={saleDate}
                max={localToday()}
                onChange={setSaleDate}
                className="w-full rounded border border-border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Fees (optional)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                <input
                  type="number"
                  value={fees}
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  onChange={(e) => setFees(e.target.value)}
                  className="w-full rounded border border-border pl-7 pr-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Cost Basis Method</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              className="w-full rounded border border-border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary bg-background"
            >
              {COST_BASIS_METHODS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{methodInfo.description}</p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Proceeds Go To</label>
            <select
              value={destAccountId}
              onChange={(e) => setDestAccountId(e.target.value)}
              className="w-full rounded border border-border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary bg-background"
            >
              <option value="">Select account…</option>
              {eligibleAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
            <Button onClick={handlePreview} disabled={loading} className="flex-1">
              {loading ? "Calculating…" : "Preview Sale →"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Lot breakdown table */}
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground uppercase tracking-wide">
                  <th className="py-2 px-3 text-left font-medium">Lot Date</th>
                  <th className="py-2 px-3 text-right font-medium">Shares</th>
                  <th className="py-2 px-3 text-right font-medium">Cost/Share</th>
                  <th className="py-2 px-3 text-left font-medium">Term</th>
                  <th className="py-2 px-3 text-right font-medium">Proceeds</th>
                  <th className="py-2 px-3 text-right font-medium">Cost Basis</th>
                  <th className="py-2 px-3 text-right font-medium">Gain / Loss</th>
                </tr>
              </thead>
              <tbody>
                {preview!.lotBreakdown.map((lot, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-2 px-3 tabular-nums">{formatDate(lot.acquiredDate)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {lot.shares.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(lot.costPerShare)}</td>
                    <td className="py-2 px-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        lot.termType === "LONG"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                          : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      }`}>
                        {lot.termType === "LONG" ? "Long-term" : "Short-term"}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(lot.proceeds)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(lot.costBasis)}</td>
                    <td className={`py-2 px-3 text-right tabular-nums font-medium ${gainColor(lot.gain)}`}>
                      {lot.gain >= 0 ? "+" : ""}{formatCurrency(lot.gain)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Summary */}
          <div className="rounded border border-border bg-muted/20 p-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Gross Proceeds</span>
              <span className="tabular-nums font-medium">{formatCurrency(preview!.grossProceeds)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fees</span>
              <span className="tabular-nums font-medium">{preview!.fees > 0 ? `(${formatCurrency(preview!.fees)})` : "—"}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 col-span-2">
              <span className="font-medium">Net Proceeds</span>
              <span className="tabular-nums font-bold">{formatCurrency(preview!.netProceeds)}</span>
            </div>
            {preview!.stShares > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Short-Term Gain</span>
                <span className={`tabular-nums font-medium ${gainColor(preview!.stGain)}`}>
                  {preview!.stGain >= 0 ? "+" : ""}{formatCurrency(preview!.stGain)}
                </span>
              </div>
            )}
            {preview!.ltShares > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Long-Term Gain</span>
                <span className={`tabular-nums font-medium ${gainColor(preview!.ltGain)}`}>
                  {preview!.ltGain >= 0 ? "+" : ""}{formatCurrency(preview!.ltGain)}
                </span>
              </div>
            )}
            <div className={`flex justify-between border-t border-border pt-2 ${preview!.stShares > 0 && preview!.ltShares > 0 ? "col-span-2" : ""}`}>
              <span className="font-medium">Total Taxable Gain</span>
              <span className={`tabular-nums font-bold ${gainColor(preview!.totalGain)}`}>
                {preview!.totalGain >= 0 ? "+" : ""}{formatCurrency(preview!.totalGain)}
              </span>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={() => { setStep("input"); setError(null); }} className="flex-1">
              ← Back
            </Button>
            <Button onClick={handleConfirm} disabled={submitting} className="flex-1">
              {submitting ? "Recording…" : "Confirm Sale"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Activity tab ───────────────────────────────────────────────────────────────

function ActivityTab({ accountId }: { accountId: string }) {
  const { data: activities, loading } = useApi(
    () => getInvestmentActivity(accountId),
    [accountId]
  );

  if (loading) {
    return (
      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="font-semibold text-sm">Activity</h3>
        </div>
        <div className="p-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 bg-muted/40 rounded animate-pulse" />
          ))}
        </div>
      </Card>
    );
  }

  if (!activities || activities.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm font-medium text-muted-foreground">No activity yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Sales and dividends will appear here once recorded.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="font-semibold text-sm">Activity</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ tableLayout: "fixed", minWidth: "860px" }}>
          <thead>
            <tr className="text-[11px] text-muted-foreground uppercase tracking-wide bg-muted/30 border-b border-border">
              <th style={{ width: "110px" }} className="py-2 pl-4 pr-2 text-left font-medium">Date</th>
              <th style={{ width: "90px" }} className="py-2 px-2 text-left font-medium">Type</th>
              <th style={{ width: "80px" }} className="py-2 px-2 text-left font-medium">Symbol</th>
              <th style={{ width: "110px" }} className="py-2 px-2 text-right font-medium">Shares</th>
              <th style={{ width: "110px" }} className="py-2 px-2 text-right font-medium">Price/Share</th>
              <th style={{ width: "120px" }} className="py-2 px-2 text-right font-medium">Gross</th>
              <th style={{ width: "90px" }} className="py-2 px-2 text-right font-medium">Fees</th>
              <th style={{ width: "120px" }} className="py-2 px-2 text-right font-medium">Net</th>
              <th className="py-2 px-2 text-right font-medium">Gain / Loss</th>
              <th style={{ width: "120px" }} className="py-2 pl-2 pr-4 text-left font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {activities.map((a) => {
              const fees = a.fees ?? 0;
              const net = a.amount - fees;
              const gain = (a.shortTermGain ?? 0) + (a.longTermGain ?? 0);
              const isGainPositive = gain >= 0;

              return (
                <tr key={a.id} className="border-b border-border hover:bg-muted/20">
                  <td className="py-3 pl-4 pr-2 tabular-nums">{formatDate(a.date)}</td>
                  <td className="py-3 px-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      a.type === "SALE"
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                        : "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
                    }`}>
                      {a.type === "SALE" ? "Sale" : "Dividend"}
                    </span>
                  </td>
                  <td className="py-3 px-2 font-mono font-bold text-xs">{a.ticker}</td>
                  <td className="py-3 px-2 text-right tabular-nums">
                    {a.shares != null
                      ? a.shares.toLocaleString(undefined, { maximumFractionDigits: 6 })
                      : "—"}
                  </td>
                  <td className="py-3 px-2 text-right tabular-nums">
                    {a.pricePerShare != null ? formatCurrency(a.pricePerShare) : "—"}
                  </td>
                  <td className="py-3 px-2 text-right tabular-nums">{formatCurrency(a.amount)}</td>
                  <td className="py-3 px-2 text-right tabular-nums text-muted-foreground">
                    {fees > 0 ? `(${formatCurrency(fees)})` : "—"}
                  </td>
                  <td className="py-3 px-2 text-right tabular-nums font-medium">{formatCurrency(net)}</td>
                  <td className={`py-3 px-2 text-right tabular-nums font-medium ${
                    a.type === "SALE"
                      ? isGainPositive
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-500 dark:text-red-400"
                      : "text-muted-foreground"
                  }`}>
                    {a.type === "SALE"
                      ? `${isGainPositive ? "+" : ""}${formatCurrency(gain)}`
                      : "—"}
                  </td>
                  <td className="py-3 pl-2 pr-4 text-muted-foreground truncate">
                    {a.notes ?? ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── Realized Gain Snapshot panel ─────────────────────────────────────────────

function RealizedGainSnapshotPanel({
  accountId,
  year,
  snapshot,
  onSaved,
  onDeleted,
}: {
  accountId: string;
  year: number;
  snapshot: RealizedGainSnapshot | null | undefined;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [form, setForm] = useState({
    longTermGain: "",
    shortTermGain: "",
    longTermLoss: "",
    shortTermLoss: "",
    notes: "",
  });

  // Reset editing state when year or snapshot changes
  useEffect(() => { setEditing(false); setShowDeleteConfirm(false); }, [year, snapshot]);

  const startEdit = () => {
    setForm({
      longTermGain: snapshot?.longTermGain != null ? snapshot.longTermGain.toFixed(2) : "",
      shortTermGain: snapshot?.shortTermGain != null ? snapshot.shortTermGain.toFixed(2) : "",
      longTermLoss: snapshot?.longTermLoss != null ? snapshot.longTermLoss.toFixed(2) : "",
      shortTermLoss: snapshot?.shortTermLoss != null ? snapshot.shortTermLoss.toFixed(2) : "",
      notes: snapshot?.notes ?? "",
    });
    setEditing(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await upsertGainSnapshot({
        accountId,
        year,
        longTermGain: form.longTermGain !== "" ? parseFloat(form.longTermGain) : null,
        shortTermGain: form.shortTermGain !== "" ? parseFloat(form.shortTermGain) : null,
        longTermLoss: form.longTermLoss !== "" ? parseFloat(form.longTermLoss) : null,
        shortTermLoss: form.shortTermLoss !== "" ? parseFloat(form.shortTermLoss) : null,
        snapshotDate: new Date().toISOString(),
        notes: form.notes.trim() || null,
      });
      setEditing(false);
      onSaved();
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteGainSnapshot(accountId, year);
      setShowDeleteConfirm(false);
      onDeleted();
    } finally { setDeleting(false); }
  };

  const netLT = (snapshot?.longTermGain ?? 0) - (snapshot?.longTermLoss ?? 0);
  const netST = (snapshot?.shortTermGain ?? 0) - (snapshot?.shortTermLoss ?? 0);

  if (!editing) {
    return (
      <div className="px-4 py-4">
        {snapshot ? (
          <div className="space-y-3">
            <table className="w-full max-w-sm text-sm">
              <thead>
                <tr className="text-[11px] text-muted-foreground uppercase tracking-wide">
                  <th className="text-left font-medium pb-1.5 pr-8" />
                  <th className="text-right font-medium pb-1.5 pr-6">Long-Term</th>
                  <th className="text-right font-medium pb-1.5">Short-Term</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <td className="py-1.5 pr-8 text-muted-foreground">Gains</td>
                  <td className="py-1.5 pr-6 text-right tabular-nums text-green-600 font-medium">
                    {snapshot.longTermGain != null ? formatCurrency(snapshot.longTermGain) : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-green-600 font-medium">
                    {snapshot.shortTermGain != null ? formatCurrency(snapshot.shortTermGain) : "—"}
                  </td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-8 text-muted-foreground">Losses</td>
                  <td className="py-1.5 pr-6 text-right tabular-nums text-red-500 font-medium">
                    {snapshot.longTermLoss != null ? formatCurrency(snapshot.longTermLoss) : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-red-500 font-medium">
                    {snapshot.shortTermLoss != null ? formatCurrency(snapshot.shortTermLoss) : "—"}
                  </td>
                </tr>
                <tr className="font-semibold">
                  <td className="py-1.5 pr-8">Net</td>
                  <td className={`py-1.5 pr-6 text-right tabular-nums ${netLT >= 0 ? "text-green-600" : "text-red-500"}`}>
                    {netLT >= 0 ? "+" : "−"}{formatCurrency(Math.abs(netLT))}
                  </td>
                  <td className={`py-1.5 text-right tabular-nums ${netST >= 0 ? "text-green-600" : "text-red-500"}`}>
                    {netST >= 0 ? "+" : "−"}{formatCurrency(Math.abs(netST))}
                  </td>
                </tr>
              </tbody>
            </table>
            {snapshot.notes && (
              <p className="text-xs text-muted-foreground italic">{snapshot.notes}</p>
            )}
            <div className="flex items-center gap-4 pt-1">
              <button onClick={startEdit} className="flex items-center gap-1 text-xs text-primary hover:underline">
                <Pencil className="h-3 w-3" /> Edit
              </button>
              {!showDeleteConfirm ? (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="h-3 w-3" /> Clear
                </button>
              ) : (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Clear this snapshot?</span>
                  <button onClick={handleDelete} disabled={deleting} className="text-destructive hover:underline font-medium">
                    {deleting ? "Clearing…" : "Confirm"}
                  </button>
                  <button onClick={() => setShowDeleteConfirm(false)} className="text-muted-foreground hover:text-foreground">
                    Cancel
                  </button>
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">No realized gain data for {year}.</p>
            <button onClick={startEdit} className="flex items-center gap-1 text-sm text-primary hover:underline">
              <Plus className="h-3.5 w-3.5" /> Add snapshot
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="px-4 py-4 space-y-4">
      <p className="text-xs text-muted-foreground">
        Paste in the YTD realized gain/loss totals from your account dashboard (e.g. Wealthfront).
      </p>
      <div className="grid grid-cols-2 gap-3 max-w-sm">
        {[
          { label: "Long-Term Gain", key: "longTermGain" },
          { label: "Short-Term Gain", key: "shortTermGain" },
          { label: "Long-Term Loss", key: "longTermLoss" },
          { label: "Short-Term Loss", key: "shortTermLoss" },
        ].map(({ label, key }) => (
          <div key={key}>
            <label className="text-xs text-muted-foreground block mb-0.5">{label}</label>
            <DollarInput
              value={form[key as keyof typeof form]}
              onChange={(v) => setForm((prev) => ({ ...prev, [key]: v }))}
              placeholder="0.00"
            />
          </div>
        ))}
      </div>
      <div className="max-w-sm">
        <label className="text-xs text-muted-foreground block mb-0.5">Notes <span className="italic">(optional)</span></label>
        <input
          type="text"
          value={form.notes}
          onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
          placeholder="e.g. from Wealthfront dashboard"
          className="w-full rounded border border-border px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={saving} className="h-8 text-xs px-3">
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setEditing(false)} className="h-8 text-xs px-3">
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function InvestmentAccount() {
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<"holdings" | "activity">("holdings");
  const [modalOpen, setModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [editingManual, setEditingManual] = useState<ManualInvestment | undefined>(undefined);
  const [sellModalHolding, setSellModalHolding] = useState<InvestmentHolding | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const holdingRowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const [stickyHolding, setStickyHolding] = useState<InvestmentHolding | null>(null);

  const toggleHolding = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [snapshotYear, setSnapshotYear] = useState(new Date().getFullYear());

  const { data: accounts } = useApi(() => getAccounts(), []);
  const { data: holdings, refetch } = useApi(
    () => getInvestmentHoldings(accountId!),
    [accountId]
  );
  const { data: manualInvestments, refetch: refetchManual } = useApi(
    () => getManualInvestments(accountId!),
    [accountId]
  );
  const { data: gainSnapshot, refetch: refetchSnapshot } = useApi(
    () => getGainSnapshot(accountId!, snapshotYear),
    [accountId, snapshotYear]
  );

  // When holdings load, auto-fetch prices for any ticker missing a current price.
  // Fires once per unique set of missing tickers; after all fetches complete,
  // refetch holdings so the table shows the newly-cached prices.
  const fetchedMissingRef = useRef<string>("");
  useEffect(() => {
    if (!holdings) return;
    const missing = holdings
      .filter((h) => h.currentPrice == null)
      .map((h) => h.ticker);
    if (missing.length === 0) return;
    const key = [...missing].sort().join(",");
    if (fetchedMissingRef.current === key) return; // already in-flight or done
    fetchedMissingRef.current = key;
    Promise.allSettled(missing.map((t) => getTickerPrice(t))).then(() => {
      refetch();
    });
  }, [holdings, refetch]);

  // Sticky parent row: track which holding row has scrolled above the nav bar
  useEffect(() => {
    const NAV_HEIGHT = 56;
    const handleScroll = () => {
      if (!holdings || holdings.length === 0) return;
      let activeHolding: InvestmentHolding | null = null;
      let bestTop = -Infinity;
      for (const h of holdings) {
        const el = holdingRowRefs.current.get(h.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top < NAV_HEIGHT && rect.top > bestTop) {
          bestTop = rect.top;
          activeHolding = h;
        }
      }
      setStickyHolding(prev => prev?.id === activeHolding?.id ? prev : activeHolding);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [holdings]);

  const sortedHoldings = useMemo(() => {
    if (!holdings) return [];
    const TYPE_ORDER: Record<string, number> = { "Mutual Fund": 0, "ETF": 1 };
    const typeRank = (t: string | null) => (t != null && t in TYPE_ORDER ? TYPE_ORDER[t] : 2);
    return [...holdings].sort((a, b) => {
      const rankDiff = typeRank(a.type) - typeRank(b.type);
      if (rankDiff !== 0) return rankDiff;
      return (a.ticker ?? "").localeCompare(b.ticker ?? "");
    });
  }, [holdings]);

  // manuals must be defined before the early return so assetClassGroups can depend on it
  const manuals = useMemo(
    () => [...(manualInvestments ?? [])].sort((a, b) => b.marketValue - a.marketValue),
    [manualInvestments]
  );

  // Build ordered list of groups: each unique assetClass across holdings AND manuals (null → "Other")
  const assetClassGroups = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const h of sortedHoldings) {
      const key = h.assetClass ?? "";
      if (!seen.has(key)) { seen.add(key); order.push(key); }
    }
    for (const m of manuals) {
      const key = m.assetClass ?? "";
      if (!seen.has(key)) { seen.add(key); order.push(key); }
    }
    return order;
  }, [sortedHoldings, manuals]);

  const account = accounts?.find((a: Account) => a.id === accountId);
  if (!account || !holdings) return null;

  const isBanking = account.type === "CHECKING" || account.type === "SAVINGS";
  const isInvestment = account.type === "INVESTMENT";

  const manualMV = manuals.reduce((s, m) => s + m.marketValue, 0);
  const manualCost = manuals.reduce((s, m) => s + (m.totalCost ?? 0), 0);
  const manualGain = manuals.reduce((s, m) => m.totalCost != null ? s + (m.marketValue - m.totalCost) : s, 0);

  const totalMarketValue = holdings.reduce((s, h) => s + (h.marketValue ?? 0), 0) + manualMV;
  const totalCost = holdings.reduce((s, h) => s + h.totalCost, 0) + manualCost;
  const totalGain = holdings.reduce((s, h) => s + (h.totalGain ?? 0), 0) + manualGain;
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;
  const shortTermGain = holdings.reduce((s, h) => s + h.shortTermGain, 0);
  const longTermGain = holdings.reduce((s, h) => s + h.longTermGain, 0);
  const priceDate = holdings.find((h) => h.priceDate)?.priceDate;

  return (
    <div className="space-y-6">
      {/* Back + account header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/investments")}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2">
          <div
            className="h-8 w-8 rounded-md flex items-center justify-center"
            style={account.color ? { backgroundColor: account.color } : { backgroundColor: "#e2e2df" }}
          >
            {isBanking ? (
              <Landmark className="h-4 w-4 text-gray-500" />
            ) : (
              <LineChart className="h-4 w-4 text-gray-500" />
            )}
          </div>
          <div>
            <h2 className="text-xl font-bold leading-tight">{account.name}</h2>
            <p className="text-xs text-muted-foreground">
              {isBanking
                ? account.type === "CHECKING" ? "Checking Account" : "Savings Account"
                : "Investment Account"}
              {account.isJoint && " · Joint"}
              {account.isManaged && " · Managed"}
            </p>
          </div>
        </div>
      </div>

      {/* Tab bar — investment accounts only */}
      {isInvestment && (
        <div className="flex border-b border-border">
          {(["holdings", "activity"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                if (tab === "holdings") setStickyHolding(null);
              }}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      {/* Banking: cash balance only */}
      {isBanking && (
        <Card className="p-6">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Current Balance</p>
          <p className="text-3xl font-bold">{formatCurrency(account.balance)}</p>
          <p className="text-xs text-muted-foreground mt-2">
            Cash position — balance managed in{" "}
            <button className="text-primary underline" onClick={() => navigate("/accounts")}>
              Accounts
            </button>
          </p>
        </Card>
      )}

      {/* Investment account — Activity tab */}
      {isInvestment && activeTab === "activity" && (
        <ActivityTab accountId={accountId!} />
      )}

      {/* Sell modal */}
      {sellModalHolding && accounts && (
        <SellModal
          holding={sellModalHolding}
          accounts={accounts}
          onClose={() => setSellModalHolding(null)}
          onSold={() => {
            refetch();
            setActiveTab("activity");
            setSellModalHolding(null);
          }}
        />
      )}

      {/* Investment account — Holdings tab */}
      {isInvestment && activeTab === "holdings" && (
        <>
          {/* Summary stats */}
          {(holdings.length > 0 || manuals.length > 0) && (
            <Card className="p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border text-center">
                <div className="px-4 py-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Market Value</p>
                  <p className="text-lg font-bold">{formatCurrency(totalMarketValue)}</p>
                </div>
                <div className="px-4 py-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Total Gain / Loss</p>
                  <GainCell value={totalGain} pct={totalGainPct} size="base" />
                </div>
                <div className="px-4 py-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Short-Term</p>
                  <GainCell value={shortTermGain} size="base" />
                </div>
                <div className="px-4 py-1">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Long-Term</p>
                  <GainCell value={longTermGain} size="base" />
                </div>
              </div>
              {priceDate && (
                <p className="text-[11px] text-muted-foreground text-center mt-3">
                  Prices as of {formatDate(priceDate)}
                </p>
              )}
            </Card>
          )}

          {/* Add investment modal */}
          <AddInvestmentModal
            accountId={accountId!}
            accountName={account.name}
            existingHoldings={holdings}
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            onSaved={refetch}
            managed={account.isManaged}
          />

          {/* Import investments modal */}
          <ImportInvestmentsModal
            accountId={accountId!}
            open={importModalOpen}
            onClose={() => setImportModalOpen(false)}
            onComplete={refetch}
          />

          {/* Add / edit manual investment modal */}
          <AddManualInvestmentModal
            accountId={accountId!}
            open={manualModalOpen}
            onClose={() => { setManualModalOpen(false); setEditingManual(undefined); }}
            onSaved={() => { refetchManual(); setManualModalOpen(false); setEditingManual(undefined); }}
            editing={editingManual}
          />

          {/* Empty state or holdings table */}
          {holdings.length === 0 && manuals.length === 0 ? (
            <Card>
              <EmptyPortfolio
                onAdd={() => setModalOpen(true)}
                onImport={() => setImportModalOpen(true)}
                onAddManual={() => { setEditingManual(undefined); setManualModalOpen(true); }}
              />
            </Card>
          ) : (holdings.length > 0 || manuals.length > 0) ? (
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <h3 className="font-semibold text-sm">Holdings</h3>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setImportModalOpen(true)}
                    className="h-8 text-xs px-3"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    Import
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => { setEditingManual(undefined); setManualModalOpen(true); }}
                    className="h-8 text-xs px-3"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Add manual
                  </Button>
                  <Button onClick={() => setModalOpen(true)} className="h-8 text-xs px-3">
                    <Plus className="h-3.5 w-3.5" />
                    Add investment
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full" style={{ tableLayout: "fixed", minWidth: "1080px" }}>
                  <thead>
                    <tr className="text-[11px] text-muted-foreground uppercase tracking-wide bg-muted/30 border-b border-border">
                      <th
                        style={{ width: "80px" }}
                        className="py-2 pl-4 pr-2 text-left font-medium"
                      >
                        Symbol
                      </th>
                      <th
                        style={{ width: "400px" }}
                        className="py-2 px-2 text-left font-medium"
                      >
                        Name
                      </th>
                      <th style={{ width: "100px" }} className="py-2 px-2 text-left font-medium">Price</th>
                      <th style={{ width: "110px" }} className="py-2 px-2 text-left font-medium">Quantity</th>
                      <th style={{ width: "120px" }} className="py-2 px-2 text-left font-medium">Total Cost</th>
                      <th style={{ width: "120px" }} className="py-2 px-2 text-left font-medium">Market Value</th>
                      <th className="py-2 pl-2 pr-2 text-left font-medium">Total Gain</th>
                      <th style={{ width: "60px" }} className="py-2 pr-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {assetClassGroups.length > 1
                      ? /* Grouped view — insert a header row between asset classes */
                        assetClassGroups.flatMap((group) => {
                          const groupHoldings = sortedHoldings.filter(
                            (h) => (h.assetClass ?? "") === group
                          );
                          const groupManuals = manuals.filter(
                            (m) => (m.assetClass ?? "") === group
                          );
                          const groupMV =
                            groupHoldings.reduce((s, h) => s + (h.marketValue ?? 0), 0) +
                            groupManuals.reduce((s, m) => s + m.marketValue, 0);
                          const groupGain =
                            groupHoldings.reduce((s, h) => s + (h.totalGain ?? 0), 0) +
                            groupManuals.reduce((s, m) => m.totalCost != null ? s + (m.marketValue - m.totalCost) : s, 0);
                          const groupCost =
                            groupHoldings.reduce((s, h) => s + h.totalCost, 0) +
                            groupManuals.reduce((s, m) => s + (m.totalCost ?? 0), 0);
                          const groupGainPct = groupCost > 0 ? (groupGain / groupCost) * 100 : null;
                          return [
                            <tr key={`group-${group}`} className="bg-muted/40 border-y border-border">
                              <td colSpan={5} className="py-1.5 pl-4 pr-2">
                                <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
                                  {group || "Other"}
                                </span>
                              </td>
                              <td className="py-1.5 px-2 text-xs font-semibold tabular-nums">
                                {formatCurrency(groupMV)}
                              </td>
                              <td className="py-1.5 pl-2 pr-2">
                                <GainCell value={groupGain} pct={groupGainPct} />
                              </td>
                              <td />
                            </tr>,
                            ...groupHoldings.map((holding) => (
                              <HoldingRow
                                key={holding.id}
                                holding={holding}
                                expanded={expandedIds.has(holding.id)}
                                onToggle={() => toggleHolding(holding.id)}
                                onDeleted={refetch}
                                onUpdated={refetch}
                                onSell={() => setSellModalHolding(holding)}
                                rowRef={(el) => {
                                  if (el) holdingRowRefs.current.set(holding.id, el);
                                  else holdingRowRefs.current.delete(holding.id);
                                }}
                              />
                            )),
                            ...groupManuals.map((entry) => (
                              <ManualHoldingRow
                                key={entry.id}
                                entry={entry}
                                onEdit={() => { setEditingManual(entry); setManualModalOpen(true); }}
                                onDeleted={refetchManual}
                              />
                            )),
                          ];
                        })
                      : /* Flat view — no group headers when all in one group */
                        [
                          ...sortedHoldings.map((holding) => (
                            <HoldingRow
                              key={holding.id}
                              holding={holding}
                              expanded={expandedIds.has(holding.id)}
                              onToggle={() => toggleHolding(holding.id)}
                              onDeleted={refetch}
                              onUpdated={refetch}
                              onSell={() => setSellModalHolding(holding)}
                              rowRef={(el) => {
                                if (el) holdingRowRefs.current.set(holding.id, el);
                                else holdingRowRefs.current.delete(holding.id);
                              }}
                            />
                          )),
                          ...manuals.map((entry) => (
                            <ManualHoldingRow
                              key={entry.id}
                              entry={entry}
                              onEdit={() => { setEditingManual(entry); setManualModalOpen(true); }}
                              onDeleted={refetchManual}
                            />
                          )),
                        ]
                    }
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          {/* Realized gain snapshot panel — shown for managed/robo-advisor accounts */}
          {account.isManaged && (
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <div className="flex items-center gap-3">
                  <h3 className="font-semibold text-sm">Realized Gains &amp; Losses</h3>
                  <div className="flex items-center gap-1">
                    {[snapshotYear - 1, snapshotYear, snapshotYear + 1 > new Date().getFullYear() ? null : snapshotYear + 1]
                      .filter((y): y is number => y != null && y <= new Date().getFullYear())
                      .map((y) => (
                        <button
                          key={y}
                          onClick={() => setSnapshotYear(y)}
                          className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                            y === snapshotYear
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                          }`}
                        >
                          {y}
                        </button>
                      ))}
                  </div>
                </div>
                {gainSnapshot && (
                  <span className="text-xs text-muted-foreground">
                    Updated {formatDate(gainSnapshot.snapshotDate)}
                  </span>
                )}
              </div>
              <RealizedGainSnapshotPanel
                accountId={accountId!}
                year={snapshotYear}
                snapshot={gainSnapshot}
                onSaved={refetchSnapshot}
                onDeleted={refetchSnapshot}
              />
            </Card>
          )}

          {/* Sticky holding row — appears below nav when a parent row scrolls out of view */}
          {stickyHolding && (
            <StickyHoldingRow
              holding={stickyHolding}
              expanded={expandedIds.has(stickyHolding.id)}
              onToggle={() => toggleHolding(stickyHolding.id)}
            />
          )}
        </>
      )}
    </div>
  );
}
