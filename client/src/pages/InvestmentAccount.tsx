import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
} from "recharts";
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
  Tag,
  Clock,
  ChevronRight,
  Banknote,
} from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { useApi } from "@/hooks/useApi";
import {
  getInvestmentHoldings,
  getInvestmentActivity,
  getAccounts,
  updateAccount,
  createHolding,
  patchHolding,
  deleteHolding,
  createLot,
  updateLot,
  deleteLot,
  searchTickers,
  searchCryptoTickers,
  resolveTicker,
  getTickerPrice,
  importInvestments,
  getManualInvestments,
  createManualInvestment,
  updateManualInvestment,
  deleteManualInvestment,
  previewSell,
  executeSell,
  executeTransfer,
  getGainSnapshot,
  upsertGainSnapshot,
  deleteGainSnapshot,
  getInvestmentGrowth,
  importQfx,
  importQfxDividends,
  getQfxLastDate,
  updateSaleActivity,
  refreshPrices,
  getPendingDividends,
  confirmPendingDividend,
  confirmReinvestDividend,
  dismissPendingDividend,
  getConfirmedDividend,
  updateConfirmedDividend,
  getFlatCategories,
  getPendingBuys,
  confirmPendingBuy,
  dismissPendingBuy,
  getPendingSales,
  confirmPendingSale,
  dismissPendingSale,
} from "@/api";
import type { SellPreviewResult } from "@/api";
import { ApiError } from "@/api/client";
import { formatCurrency, formatDate, toDateInputValue, localToday } from "@/lib/utils";
import { useNotifications } from "@/context/NotificationContext";
import { isPriceRefreshNeeded, formatQuantity } from "@/lib/priceUtils";
import { useDemo } from "@/context/DemoContext";
import { scaleGrowthPoints, scaleManuals, scaleHolding } from "@/lib/demo";
import type { InvestmentHolding, InvestmentLot, RealizedGainSnapshot, TickerSearchResult, Account, ManualInvestment, InvestmentActivity, GrowthPoint, GrowthEvent, PendingDividend, TaxClassification, Category, ConfirmedDividendInfo, PendingBuy, PendingSale } from "@/types";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel, StatValue, DisplayStat } from "@/components/Typography";

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
  if (value == null) return <StatValue className="text-muted-foreground">—</StatValue>;
  const pos = value >= 0;
  const Icon = pos ? TrendingUp : TrendingDown;
  const cell = (
    <span
      className={`inline-flex font-medium tabular-nums font-mono ${
        pos ? "text-up" : "text-down"
      } text-${size} ${size === "base" && pct != null ? "flex-col items-start" : "flex-row items-center gap-1"}`}
    >
      <span className="inline-flex items-center gap-1">
        <Icon className="h-3 w-3 flex-shrink-0" />
        {formatCurrency(Math.abs(value))}
        {pct != null && size !== "base" && (
          <span className="text-xs opacity-60">({Math.abs(pct).toFixed(2)}%)</span>
        )}
      </span>
      {pct != null && size === "base" && (
        <span className="text-xs opacity-60 pl-4">({Math.abs(pct).toFixed(2)}%)</span>
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
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
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

type SearchMode = "stocks" | "crypto";

function TickerSearch({
  onSelect,
  onCancel,
}: {
  onSelect: (r: TickerSearchResult) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<SearchMode>("stocks");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TickerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  // Track the query that produced the current empty result so we only show
  // the fallback option when the search has settled on a stable empty state.
  const [emptyQuery, setEmptyQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Re-run the search whenever the mode changes (if there's already a query)
  useEffect(() => {
    if (query.trim()) search(query, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const search = useCallback((q: string, currentMode: SearchMode) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setEmptyQuery(""); // clear fallback while typing
    if (!q.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = currentMode === "crypto"
          ? await searchCryptoTickers(q)
          : await searchTickers(q);
        setResults(r);
        setHighlighted(0);
        if (r.length === 0) setEmptyQuery(q.trim());
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 300);
  }, []);

  const handleModeChange = (newMode: SearchMode) => {
    setMode(newMode);
    setResults([]);
    setEmptyQuery("");
  };

  const handleResolve = async () => {
    const ticker = emptyQuery.toUpperCase();
    setResolving(true);
    try {
      const result = await resolveTicker(ticker);
      onSelect(result);
    } catch {
      // Tiingo also couldn't resolve it — fall back to a bare-minimum result
      // so the user can still add the ticker manually with its symbol as the name.
      onSelect({ ticker, name: ticker, type: "Mutual Fund", exchange: "" });
    } finally {
      setResolving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted(h => Math.min(h + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && results[highlighted]) onSelect(results[highlighted]);
    else if (e.key === "Escape") onCancel();
  };

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div className="flex rounded-md border border-border overflow-hidden text-sm">
        <button
          type="button"
          onClick={() => handleModeChange("stocks")}
          className={`flex-1 px-3 py-1.5 font-medium transition-colors ${mode === "stocks" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent"}`}
        >
          Stocks &amp; Funds
        </button>
        <button
          type="button"
          onClick={() => handleModeChange("crypto")}
          className={`flex-1 px-3 py-1.5 font-medium transition-colors border-l border-border ${mode === "crypto" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent"}`}
        >
          Crypto
        </button>
      </div>

      {/* Search input */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); search(e.target.value, mode); }}
          onKeyDown={handleKeyDown}
          placeholder={mode === "crypto" ? "Search coin name or symbol (e.g. BTC, Bitcoin)" : "Search ticker or name (e.g. AAPL, Vanguard S&P)"}
          className="w-full rounded-md border border-primary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2 tp-caption">Searching…</div>
        )}
        {results.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border border-border bg-background shadow-lg max-h-64 overflow-y-auto">
            {results.map((r, i) => (
              <button
                key={r.coinGeckoId ?? r.ticker}
                className={`w-full flex items-center justify-between px-3 py-2 text-left hover:bg-accent transition-colors ${i === highlighted ? "bg-accent" : ""}`}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => onSelect(r)}
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-semibold text-13 leading-tight">{r.ticker}</span>
                  <span className="tp-caption truncate">{r.name}</span>
                </div>
                <div className="flex items-center gap-2 tp-caption flex-shrink-0 ml-3">
                  <span className="rounded bg-muted px-1.5 py-0.5">{r.type}</span>
                  {mode === "stocks" && <span>{r.exchange}</span>}
                </div>
              </button>
            ))}
          </div>
        )}
        {!loading && emptyQuery.length > 0 && results.length === 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-md border border-border bg-background shadow-lg">
            <div className="px-3 py-2.5 text-sm text-muted-foreground border-b border-border">
              No results for "{emptyQuery}"
            </div>
            {mode === "stocks" && (
              <button
                onClick={handleResolve}
                disabled={resolving}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-accent transition-colors disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                <span className="text-sm">
                  {resolving
                    ? `Looking up ${emptyQuery.toUpperCase()}…`
                    : `Add "${emptyQuery.toUpperCase()}" as a ticker`}
                </span>
              </button>
            )}
          </div>
        )}
      </div>
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
          <label className="block text-xs font-medium mb-1">Acquired Date</label>
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
        <label className="block text-xs font-medium mb-1">{hideDate ? "Total Shares" : "Quantity (shares)"}</label>
        <input
          type="text"
          inputMode="decimal"
          value={lot.quantity}
          onChange={(e) => onChange("quantity", e.target.value)}
          placeholder="0.00"
          required
          className="w-full rounded border border-border px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex-1 min-w-0">
        <label className="block text-xs font-medium mb-1">{hideDate ? "Total Cost" : "Cost Per Share"}</label>
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
        className="flex-shrink-0 pb-1 p-1.5 text-muted-foreground hover:text-down disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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
  const [group, setGroup] = useState("");
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
      setGroup("");
      setLots([{ quantity: "", costPerShare: "", acquiredDate: localToday() }]);
      setError(null);
      setFetchedPrice(null);
    }
  }, [open]);

  const resetToSearch = () => {
    setStep("search");
    setSelectedTicker(null);
    setGroup("");
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
        const data = await getTickerPrice(result.ticker, undefined, result.coinGeckoId);
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
        group: group.trim() || null,
        coinGeckoId: selectedTicker.coinGeckoId ?? null,
      });
      for (const lot of lots) {
        const qty = parseFloat(lot.quantity.replace(/,/g, ""));
        const rawCost = parseFloat(lot.costPerShare.replace(/,/g, ""));
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
                <span className="font-bold text-13">{selectedTicker?.ticker}</span>
                <span className="text-sm text-muted-foreground truncate">{selectedTicker?.name}</span>
              </div>
              {fetchingPrice ? (
                <p className="tp-caption mt-0.5">Fetching price…</p>
              ) : fetchedPrice != null ? (
                <p className="tp-caption mt-0.5">{formatCurrency(fetchedPrice)}</p>
              ) : null}
            </div>
          </div>

          {/* Group */}
          <div>
            <label className="block text-xs font-medium mb-1">Group <span className="font-normal text-muted-foreground">(optional)</span></label>
            <input
              type="text"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="e.g. US Stocks, Commodities"
              className="w-full rounded border border-border px-3 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {managed && (
            <p className="tp-caption bg-muted/40 rounded px-3 py-2">
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

          {error && <p className="text-sm text-down">{error}</p>}

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
  const qty = parseFloat(quantity.replace(/,/g, ""));
  const cps = parseFloat(costPerShare.replace(/,/g, ""));
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
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateLot(lot.id, {
        quantity: parseFloat(qty.replace(/,/g, "")),
        costPerShare: parseFloat(cps.replace(/,/g, "")),
        acquiredDate: date || null,
      });
      setEditing(false);
      onUpdated();
    } finally { setSaving(false); }
  };

  const handleDeleteRequest = () => {
    setDeleteWarning(null);
    setShowDeleteModal(true);
  };

  const handleDeleteConfirm = async (force = false) => {
    setDeleting(true);
    try {
      await deleteLot(lot.id, force);
      onDeleted();
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409 && (e.data as any)?.code === "HAS_SALES") {
        setDeleteWarning((e.data as any).message ?? "This lot has associated sales.");
      } else {
        setDeleteWarning(e instanceof Error ? e.message : "Failed to delete lot.");
      }
    } finally {
      setDeleting(false);
    }
  };

  const gains = computeLotGains(lot.quantity, lot.costPerShare, lot.acquiredDate, currentPrice);

  if (editing) {
    const editTotalCost = parseFloat((qty || "0").replace(/,/g, "")) * parseFloat((cps || "0").replace(/,/g, ""));
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
              type="text"
              inputMode="decimal"
              value={cps}
              onChange={(e) => setCps(e.target.value)}
              className="w-full rounded border border-border pl-5 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary tabular-nums font-mono"
            />
          </div>
        </td>
        {/* Col 4: quantity */}
        <td className="py-2 px-2">
          <input
            type="text"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="w-full rounded border border-border px-2 py-1 text-xs tabular-nums font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </td>
        {/* Col 5: computed total cost */}
        <td className="py-2 px-2 tabular-nums font-mono text-muted-foreground">{formatCurrency(editTotalCost)}</td>
        {/* Cols 6–8: save/cancel */}
        <td colSpan={3} className="py-2 px-2">
          <div className="flex items-center gap-2">
            <button onClick={handleSave} disabled={saving} className="text-up hover:text-up-deep">
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
      <tr className="tp-caption hover:bg-muted/30 group">
        <td colSpan={2} className="py-2 pl-4 pr-2">
          {lot.acquiredDate ? formatDate(lot.acquiredDate) : <span className="italic text-muted-foreground/60">Managed</span>}
        </td>
        <td className="py-2 px-2 tabular-nums font-mono">{formatCurrency(lot.costPerShare)}</td>
        <td className="py-2 px-2 tabular-nums font-mono">
          {parseFloat(lot.quantity).toLocaleString(undefined, { maximumFractionDigits: 8 })}
        </td>
        <td className="py-2 px-2 tabular-nums font-mono">{formatCurrency(gains.totalCost)}</td>
        <td className="py-2 px-2 tabular-nums font-mono">
          {gains.marketValue != null ? formatCurrency(gains.marketValue) : "—"}
        </td>
        <td className="py-2 pl-2 pr-2 tabular-nums font-mono">
          <GainCell value={gains.totalGain} pct={gains.totalGainPct} />
        </td>
        <td className="py-2 pr-3">
          <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => setEditing(true)} className="p-1.5 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button onClick={handleDeleteRequest} className="p-1.5 rounded text-muted-foreground/40 hover:text-down hover:bg-down/10 transition-colors">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </td>
      </tr>
      {showDeleteModal && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg bg-background text-foreground p-6 shadow-xl">
            <h3 className="tp-panel-title">Delete {lot.acquiredDate ? formatDate(lot.acquiredDate) : "managed"} lot?</h3>
            {deleteWarning ? (
              <>
                <p className="mt-2 text-sm text-warn">{deleteWarning}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  If you recorded this purchase by mistake, you can force-delete. Otherwise, use the <strong>Sell</strong> function to properly record a sale.
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowDeleteModal(false); setDeleteWarning(null); }}
                    disabled={deleting}
                    className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteConfirm(true)}
                    disabled={deleting}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-down/10 px-3 py-2 text-sm font-medium text-down hover:bg-down/20 transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleting ? "Deleting..." : "Delete Anyway"}
                  </button>
                </div>
              </>
            ) : (
              <>
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
                    onClick={() => handleDeleteConfirm(false)}
                    disabled={deleting}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-down/10 px-3 py-2 text-sm font-medium text-down hover:bg-down/20 transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleting ? "Deleting..." : "Confirm Delete"}
                  </button>
                </div>
              </>
            )}
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
  initialQty = null,
  initialCost = null,
}: {
  holdingId: string;
  defaultDate: string | null;
  onSaved: () => void;
  onCancel: () => void;
  managed?: boolean;
  initialAssetClass?: string | null;
  initialQty?: number | null;
  initialCost?: number | null;
}) {
  const [qty, setQty] = useState(initialQty != null ? String(initialQty) : "");
  const [cps, setCps] = useState(initialCost != null ? initialCost.toFixed(2) : "");
  const [date, setDate] = useState(defaultDate ?? localToday());
  const [group, setGroup] = useState(initialAssetClass ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const quantity = parseFloat(qty.replace(/,/g, ""));
    const rawCost = parseFloat(cps.replace(/,/g, ""));
    if (isNaN(quantity) || isNaN(rawCost) || quantity <= 0) return;
    // Managed mode: field holds total cost — derive cost-per-share automatically
    const costPerShare = managed ? rawCost / quantity : rawCost;
    setSaving(true);
    try {
      await createLot({ holdingId, quantity, costPerShare, acquiredDate: managed ? null : date });
      // Also persist the asset class if it changed
      if (managed) {
        const newClass = group.trim() || null;
        if (newClass !== initialAssetClass) {
          await patchHolding(holdingId, { group: newClass });
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
          <label className="block text-xs font-medium mb-1">Total Shares</label>
          <input
            type="text"
            inputMode="decimal"
            value={qty}
            placeholder="0.00"
            autoFocus
            onChange={(e) => setQty(e.target.value)}
            className="w-full rounded border border-border px-2 py-1 text-xs tabular-nums font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex-1 min-w-0">
          <label className="block text-xs font-medium mb-1">Total Cost</label>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs pointer-events-none select-none">$</span>
            <input
              type="text"
              inputMode="decimal"
              value={cps}
              placeholder="0.00"
              onChange={(e) => setCps(e.target.value)}
              className="w-full rounded border border-border pl-5 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary tabular-nums font-mono"
            />
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <label className="block text-xs font-medium mb-1">Group <span className="font-normal text-muted-foreground">(optional)</span></label>
          <input
            type="text"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="e.g. US Stocks"
            className="w-full rounded border border-border px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex items-center gap-2 pb-0.5">
          <Button type="submit" disabled={saving} className="h-7 text-xs px-2 py-0">
            {saving ? "Saving…" : "Save"}
          </Button>
          <button type="button" onClick={onCancel} className="tp-caption hover:text-foreground hover:underline">
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
            type="text"
            inputMode="decimal"
            value={cps}
            placeholder="0.00"
            onChange={(e) => setCps(e.target.value)}
            className="w-full rounded border border-border pl-5 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary tabular-nums font-mono"
          />
        </div>
      </td>
      <td className="py-2 px-2">
        <input
          type="text"
          inputMode="decimal"
          value={qty}
          placeholder="0.00"
          onChange={(e) => setQty(e.target.value)}
          className="w-full rounded border border-border px-2 py-1 text-xs tabular-nums font-mono focus:outline-none focus:ring-1 focus:ring-primary"
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
            className="tp-caption hover:text-foreground hover:underline"
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
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editingGroup, setEditingGroup] = useState(false);
  const [groupDraft, setGroupDraft] = useState(holding.group ?? "");
  const [savingGroup, setSavingGroup] = useState(false);

  const handleGroupSave = async () => {
    setSavingGroup(true);
    try {
      await patchHolding(holding.id, { group: groupDraft.trim() || null });
      setEditingGroup(false);
      onUpdated();
    } finally { setSavingGroup(false); }
  };

  const handleDeleteRequest = () => {
    setDeleteWarning(null);
    setShowDeleteModal(true);
  };

  const handleDeleteConfirm = async (force = false) => {
    setDeleting(true);
    try {
      await deleteHolding(holding.id, force);
      onDeleted();
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409 && (e.data as any)?.code === "HAS_SALES") {
        setDeleteWarning((e.data as any).message ?? "This holding has associated sales.");
      } else {
        setDeleteWarning(e instanceof Error ? e.message : "Failed to delete holding.");
      }
    } finally {
      setDeleting(false);
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
          <span className="font-bold text-13">{holding.ticker}</span>
        </td>
        <td className="py-3 px-2 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-muted-foreground truncate">{holding.name}</span>
          </div>
        </td>
        <td className="py-3 px-2 tp-numeric">
          {holding.currentPrice != null ? formatCurrency(holding.currentPrice) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="py-3 px-2 tp-numeric">
          {holding.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 8 })}
        </td>
        <td className="py-3 px-2 tp-numeric">{formatCurrency(holding.totalCost)}</td>
        <td className="py-3 px-2 tp-numeric font-semibold">
          {holding.marketValue != null ? formatCurrency(holding.marketValue) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="py-3 pl-2 pr-2 text-13 relative z-10">
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
              <Tooltip content="Record a sale or transfer">
                <button
                  onClick={(e) => { e.stopPropagation(); onSell(); }}
                  className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Tag className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
            <Tooltip content="Delete this investment">
              <button
                onClick={(e) => { e.stopPropagation(); handleDeleteRequest(); }}
                className="p-1.5 rounded hover:bg-down/10 text-muted-foreground hover:text-down transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            <Tooltip content="See lot details">
              <button
                onClick={(e) => { e.stopPropagation(); onToggle(); }}
                className="p-1.5 rounded text-muted-foreground hover:bg-accent transition-colors"
              >
                {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
            </Tooltip>
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
                    <SectionLabel className="text-[11px] mb-0.5">Total Shares</SectionLabel>
                    <StatValue as="p" className="font-medium">
                      {holding.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                    </StatValue>
                  </div>
                  <div>
                    <SectionLabel className="text-[11px] mb-0.5">Avg Cost / Share</SectionLabel>
                    <StatValue as="p" className="font-medium">
                      {holding.totalQuantity > 0 ? formatCurrency(holding.totalCost / holding.totalQuantity) : "—"}
                    </StatValue>
                  </div>
                  <div>
                    <SectionLabel className="text-[11px] mb-0.5">Group</SectionLabel>
                    <p className="font-medium">
                      {holding.group ?? <span className="italic text-muted-foreground text-xs">None set</span>}
                    </p>
                  </div>
                  <div className="ml-auto self-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); setAddingLot(true); }}
                      className="flex items-center gap-1 tp-caption hover:text-foreground transition-colors"
                      title="Update aggregate position"
                    >
                      <Pencil className="h-3 w-3" />
                      Update position
                    </button>
                  </div>
                </div>
                {addingLot && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <p className="tp-caption mb-2">Replace aggregate position (total shares + total cost basis):</p>
                    <AddLotRow
                      holdingId={holding.id}
                      defaultDate={null}
                      onSaved={() => { setAddingLot(false); onUpdated(); }}
                      onCancel={() => setAddingLot(false)}
                      managed
                      initialAssetClass={holding.group}
                      initialQty={holding.totalQuantity > 0 ? holding.totalQuantity : null}
                      initialCost={holding.totalCost > 0 ? holding.totalCost : null}
                    />
                  </div>
                )}
              </td>
            </tr>
          ) : (
            <>
              {/* Lot sub-header: "Purchase Date" spans Symbol+Name so it never wraps */}
              <tr className="bg-muted/20 text-[11px] text-muted-foreground uppercase tracking-[1px] font-mono">
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

              {/* Group editor — always editable regardless of managed status */}
              <tr className="border-b border-border bg-muted/5">
                <td colSpan={8} className="py-2 pl-4 pr-4">
                  <div className="flex items-center gap-2 tp-caption">
                    <SectionLabel as="span">Group</SectionLabel>
                    <span className="text-border">·</span>
                    {editingGroup ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={groupDraft}
                          onChange={(e) => setGroupDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleGroupSave(); if (e.key === "Escape") setEditingGroup(false); }}
                          autoFocus
                          placeholder="e.g. US Stocks"
                          className="rounded border border-border px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary w-36"
                        />
                        <button onClick={handleGroupSave} disabled={savingGroup} className="text-up hover:text-up-deep">
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setEditingGroup(false)} className="text-muted-foreground hover:text-foreground">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setGroupDraft(holding.group ?? ""); setEditingGroup(true); }}
                        className="flex items-center gap-1 hover:text-foreground transition-colors group"
                      >
                        {holding.group
                          ? <span className="font-medium text-foreground">{holding.group}</span>
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
            <h3 className="tp-panel-title">Delete {holding.ticker}?</h3>
            {deleteWarning ? (
              <>
                <p className="mt-2 text-sm text-warn">{deleteWarning}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Deleting this holding will orphan its sale history (the records will be preserved but unlinked). If you still want to proceed, confirm below.
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowDeleteModal(false); setDeleteWarning(null); }}
                    disabled={deleting}
                    className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteConfirm(true)}
                    disabled={deleting}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-down/10 px-3 py-2 text-sm font-medium text-down hover:bg-down/20 transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleting ? "Deleting..." : "Delete Anyway"}
                  </button>
                </div>
              </>
            ) : (
              <>
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
                    onClick={() => handleDeleteConfirm(false)}
                    disabled={deleting}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-down/10 px-3 py-2 text-sm font-medium text-down hover:bg-down/20 transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleting ? "Deleting..." : "Confirm Delete"}
                  </button>
                </div>
              </>
            )}
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
          <p className="tp-caption">
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
                    ? "bg-down/15 text-down font-medium"
                    : "text-down hover:bg-down/10"
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
                      className={`border-b border-border ${row.errors.length > 0 ? "bg-down/5" : ""}`}
                    >
                      <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-1.5 font-semibold">{row.symbol || "—"}</td>
                      <td className="px-2 py-1.5">{row.purchaseDate}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-mono">
                        {row.price > 0 ? formatCurrency(row.price) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-mono">
                        {row.quantity > 0
                          ? row.quantity.toLocaleString(undefined, { maximumFractionDigits: 8 })
                          : "—"}
                      </td>
                      <td className="px-2 py-1.5">
                        {row.errors.length > 0 ? (
                          <span className="text-down" title={row.errors.join("; ")}>
                            <AlertCircle className="inline h-3 w-3" /> {row.errors[0]}
                          </span>
                        ) : (
                          <span className="text-up">
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
            <CheckCircle2 className="h-6 w-6 text-up shrink-0" />
            <div>
              <p className="text-sm font-medium">
                {result.imported} lot{result.imported !== 1 ? "s" : ""} imported successfully
              </p>
              {result.errors.length > 0 && (
                <p className="text-xs text-down mt-1">
                  {result.errors.length} row{result.errors.length !== 1 ? "s" : ""} failed
                </p>
              )}
            </div>
          </div>

          {result.errors.length > 0 && (
            <div className="max-h-[150px] overflow-auto rounded-md border border-border p-2 text-xs text-down">
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
  const [group, setGroup] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [marketValue, setMarketValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setGroup(editing?.group ?? "");
      setTotalCost(editing?.totalCost != null ? String(editing.totalCost) : "");
      setMarketValue(editing ? String(editing.marketValue) : "");
      setError(null);
    }
  }, [open, editing]);

  const parsedCost = totalCost !== "" ? parseFloat(totalCost.replace(/,/g, "")) : null;
  const parsedMV = marketValue !== "" ? parseFloat(marketValue.replace(/,/g, "")) : NaN;
  const totalGain = parsedCost != null && !isNaN(parsedMV) ? parsedMV - parsedCost : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data = {
        name: name.trim(),
        group: group.trim() || null,
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
            <label className="block text-xs font-medium mb-1">Name</label>
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
            <label className="block text-xs font-medium mb-1">
              Group <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              type="text"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="e.g. Private Equity"
              className="w-full rounded border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">
              Total Cost{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <DollarInput value={totalCost} onChange={setTotalCost} placeholder="0.00" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Market Value</label>
            <DollarInput value={marketValue} onChange={setMarketValue} placeholder="0.00" required />
          </div>
        </div>

        {totalGain != null && (
          <div className="rounded-md bg-muted/40 border border-border px-4 py-2.5 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total Gain</span>
            <GainCell value={totalGain} />
          </div>
        )}

        {error && <p className="text-sm text-down">{error}</p>}

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
        <td className="py-3 pl-4 pr-2 text-13 text-muted-foreground">—</td>
        {/* Name */}
        <td className="py-3 px-2 text-13 max-w-0">
          <span className="block truncate">{entry.name}</span>
        </td>
        {/* Price — blank */}
        <td className="py-3 px-2 text-13 text-muted-foreground">—</td>
        {/* Quantity — blank */}
        <td className="py-3 px-2 text-13 text-muted-foreground">—</td>
        {/* Total Cost */}
        <td className="py-3 px-2 tp-numeric">
          {entry.totalCost != null
            ? formatCurrency(entry.totalCost)
            : <span className="text-muted-foreground">—</span>}
        </td>
        {/* Market Value */}
        <td className="py-3 px-2 tp-numeric">{formatCurrency(entry.marketValue)}</td>
        {/* Total Gain */}
        <td className="py-3 pl-2 pr-2 text-13"><GainCell value={gain} /></td>
        {/* Actions: edit + delete (replaces the expand chevron used by regular rows) */}
        <td className="py-3 pr-3">
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={onEdit}
              className="p-1.5 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"
              title="Edit"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="p-1.5 rounded text-muted-foreground/40 hover:text-down hover:bg-down/10 transition-colors"
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
            <h3 className="tp-panel-title">Delete {entry.name}?</h3>
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
                className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-down/10 px-3 py-2 text-sm font-medium text-down hover:bg-down/20 transition-colors disabled:opacity-50"
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
      <div className="relative w-60 h-40">
        <svg viewBox="0 0 211 141" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
          <ellipse cx="106" cy="71" rx="88" ry="66" fill="#f1f5f9" />
          <line x1="39" y1="79" x2="173" y2="79" stroke="#cbd5e1" strokeWidth="1" />
          <path d="M39 79 C56 43 72 43 89 79 C97 108 114 108 122 79 C139 17 155 17 173 79" stroke="#93c5fd" strokeWidth="1" strokeDasharray="4 3" fill="none" />
          <circle cx="39" cy="79" r="4" fill="#94a3b8" />
          <circle cx="89" cy="79" r="4" fill="#94a3b8" />
          <circle cx="122" cy="79" r="4" fill="#94a3b8" />
          <circle cx="173" cy="79" r="4" fill="#94a3b8" />
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
    <div style={{ position: "fixed", top: 72, left: 0, right: 0, zIndex: 40 }}>
      <div className="mx-auto max-w-7xl px-4 md:px-6">
        <div className="border-x border-b border-border bg-background">
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
                      <span className="font-bold text-13">{holding.ticker}</span>
                    </td>
                    <td className="py-3 px-2 overflow-hidden">
                      <span className="text-sm text-muted-foreground truncate block">{holding.name}</span>
                    </td>
                    <td className="py-3 px-2 tp-numeric">
                      {holding.currentPrice != null ? formatCurrency(holding.currentPrice) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 px-2 tp-numeric">
                      {holding.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                    </td>
                    <td className="py-3 px-2 tp-numeric">{formatCurrency(holding.totalCost)}</td>
                    <td className="py-3 px-2 tp-numeric font-semibold">
                      {holding.marketValue != null ? formatCurrency(holding.marketValue) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 pl-2 pr-2 text-13">
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
  onTransferred,
}: {
  holding: InvestmentHolding;
  accounts: Account[];
  onClose: () => void;
  onSold: () => void;
  onTransferred: () => void;
}) {
  const [mode, setMode] = useState<"sell" | "transfer">("sell");
  const [step, setStep] = useState<"input" | "preview">("input");
  const [selectionMode, setSelectionMode] = useState<"method" | "lots">("method");
  const [shares, setShares] = useState("");
  const [price, setPrice] = useState(
    holding.currentPrice != null ? holding.currentPrice.toFixed(4) : ""
  );
  const [actionDate, setActionDate] = useState(localToday());
  const [fees, setFees] = useState("");
  const [method, setMethod] = useState<"FIFO" | "LIFO" | "MIN_TAX" | "MAX_GAIN">("MIN_TAX");
  const [lotInputs, setLotInputs] = useState<Record<string, string>>({});
  const [destAccountId, setDestAccountId] = useState("");
  const [preview, setPreview] = useState<SellPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sellEligibleAccounts = accounts.filter((a) => a.type !== "CREDIT_CARD");
  const transferEligibleAccounts = accounts.filter(
    (a) => a.type === "INVESTMENT" && a.id !== holding.accountId
  );
  const eligibleAccounts = mode === "sell" ? sellEligibleAccounts : transferEligibleAccounts;
  const maxShares = holding.totalQuantity;
  const methodInfo = COST_BASIS_METHODS.find((m) => m.value === method)!;

  const sortedLots = [...holding.lots].sort((a, b) => {
    if (!a.acquiredDate) return 1;
    if (!b.acquiredDate) return -1;
    return a.acquiredDate < b.acquiredDate ? -1 : 1;
  });

  const lotAllocations = sortedLots
    .map((lot) => ({ lotId: lot.id, shares: parseFloat((lotInputs[lot.id] || "0").replace(/,/g, "")) || 0 }))
    .filter((a) => a.shares > 0);
  const lotTotalShares = lotAllocations.reduce((s, a) => s + a.shares, 0);

  // For the transfer confirm step: compute which lots are affected client-side
  const transferLotBreakdown = useMemo(() => {
    if (mode !== "transfer") return [];
    if (selectionMode === "lots") {
      return lotAllocations.map((a) => {
        const lot = sortedLots.find((l) => l.id === a.lotId)!;
        return { lotId: lot.id, acquiredDate: lot.acquiredDate, shares: a.shares, costPerShare: parseFloat(lot.costPerShare) };
      });
    }
    const sharesToMove = parseFloat(shares.replace(/,/g, "")) || 0;
    const sorted = [...holding.lots].sort((a, b) => {
      const aCps = parseFloat(a.costPerShare);
      const bCps = parseFloat(b.costPerShare);
      switch (method) {
        case "FIFO":    return (a.acquiredDate ? new Date(a.acquiredDate).getTime() : Infinity) - (b.acquiredDate ? new Date(b.acquiredDate).getTime() : Infinity);
        case "LIFO":    return (b.acquiredDate ? new Date(b.acquiredDate).getTime() : -Infinity) - (a.acquiredDate ? new Date(a.acquiredDate).getTime() : -Infinity);
        case "MIN_TAX": return bCps - aCps;
        case "MAX_GAIN": return aCps - bCps;
        default:        return 0;
      }
    });
    const result: { lotId: string; acquiredDate: string | null; shares: number; costPerShare: number }[] = [];
    let remaining = sharesToMove;
    for (const lot of sorted) {
      if (remaining <= 0.000001) break;
      const available = parseFloat(lot.quantity);
      const take = Math.min(available, remaining);
      result.push({ lotId: lot.id, acquiredDate: lot.acquiredDate, shares: take, costPerShare: parseFloat(lot.costPerShare) });
      remaining -= take;
    }
    return result;
  }, [mode, selectionMode, lotAllocations, shares, method, sortedLots, holding.lots]);

  const transferTotalCostBasis = transferLotBreakdown.reduce((s, l) => s + l.shares * l.costPerShare, 0);

  const handleNext = async () => {
    setError(null);

    if (mode === "transfer") {
      if (!destAccountId) return setError("Select a destination account.");
      if (selectionMode === "method") {
        const sharesToMove = parseFloat(shares.replace(/,/g, ""));
        if (isNaN(sharesToMove) || sharesToMove <= 0) return setError("Enter a valid number of shares.");
        if (sharesToMove > maxShares + 0.000001) return setError(`Cannot transfer more than ${maxShares.toLocaleString(undefined, { maximumFractionDigits: 8 })} shares.`);
      } else {
        if (lotAllocations.length === 0) return setError("Enter shares to transfer for at least one lot.");
        for (const lot of sortedLots) {
          const requested = parseFloat((lotInputs[lot.id] || "0").replace(/,/g, "")) || 0;
          const available = parseFloat(lot.quantity);
          if (requested > available + 0.000001) {
            return setError(`Lot ${lot.acquiredDate ? formatDate(lot.acquiredDate) : "unknown"}: cannot transfer ${requested} shares, only ${available} available.`);
          }
        }
      }
      setStep("preview");
      return;
    }

    // Sell mode — compute preview via API
    const pricePerShare = parseFloat(price.replace(/,/g, ""));
    if (isNaN(pricePerShare) || pricePerShare <= 0) return setError("Enter a valid sale price.");
    if (!destAccountId) return setError("Select a destination account.");
    if (selectionMode === "method") {
      const sharesToSell = parseFloat(shares.replace(/,/g, ""));
      if (isNaN(sharesToSell) || sharesToSell <= 0) return setError("Enter a valid number of shares.");
      if (sharesToSell > maxShares + 0.000001) return setError(`Cannot sell more than ${maxShares.toLocaleString(undefined, { maximumFractionDigits: 8 })} shares.`);
    } else {
      if (lotAllocations.length === 0) return setError("Enter shares to sell for at least one lot.");
      if (lotTotalShares > maxShares + 0.000001) return setError(`Total shares (${lotTotalShares.toLocaleString(undefined, { maximumFractionDigits: 8 })}) exceeds available ${maxShares.toLocaleString(undefined, { maximumFractionDigits: 8 })}.`);
      for (const lot of sortedLots) {
        const requested = parseFloat((lotInputs[lot.id] || "0").replace(/,/g, "")) || 0;
        const available = parseFloat(lot.quantity);
        if (requested > available + 0.000001) {
          return setError(`Lot ${lot.acquiredDate ? formatDate(lot.acquiredDate) : "unknown"}: cannot sell ${requested} shares, only ${available} available.`);
        }
      }
    }

    setLoading(true);
    try {
      const baseRequest = {
        holdingId: holding.id,
        sharesToSell: selectionMode === "method" ? parseFloat(shares.replace(/,/g, "")) : lotTotalShares,
        pricePerShare,
        saleDate: actionDate,
        fees: parseFloat(fees.replace(/,/g, "")) || 0,
      };
      const result = await previewSell(
        selectionMode === "method"
          ? { ...baseRequest, costBasisMethod: method }
          : { ...baseRequest, lotAllocations }
      );
      setPreview(result);
      setStep("preview");
    } catch (e: any) {
      setError(e?.message ?? "Failed to preview sale.");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "transfer") {
        const baseRequest = {
          holdingId: holding.id,
          destinationAccountId: destAccountId,
          transferDate: actionDate,
        };
        await executeTransfer(
          selectionMode === "method"
            ? { ...baseRequest, sharesToTransfer: parseFloat(shares.replace(/,/g, "")), costBasisMethod: method }
            : { ...baseRequest, lotAllocations }
        );
        onTransferred();
        onClose();
      } else {
        if (!preview) return;
        const baseRequest = {
          holdingId: holding.id,
          sharesToSell: selectionMode === "method" ? parseFloat(shares.replace(/,/g, "")) : lotTotalShares,
          pricePerShare: parseFloat(price.replace(/,/g, "")),
          saleDate: actionDate,
          fees: parseFloat(fees.replace(/,/g, "")) || 0,
          destinationAccountId: destAccountId,
        };
        await executeSell(
          selectionMode === "method"
            ? { ...baseRequest, costBasisMethod: method }
            : { ...baseRequest, lotAllocations }
        );
        onSold();
        onClose();
      }
    } catch (e: any) {
      setError(e?.message ?? mode === "transfer" ? "Failed to transfer holding." : "Failed to record sale.");
      setStep("input");
    } finally {
      setSubmitting(false);
    }
  };

  const gainColor = (v: number) =>
    v >= 0 ? "text-up" : "text-down";

  const destAccount = eligibleAccounts.find((a) => a.id === destAccountId);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Sell or Transfer ${holding.ticker}`}
      className={step === "preview" && mode === "sell" ? "max-w-3xl" : "max-w-lg"}
    >
      {step === "input" ? (
        <div className="space-y-4">
          {/* Sell / Transfer mode toggle */}
          <div className="flex rounded border border-border overflow-hidden text-xs font-medium">
            <button
              type="button"
              onClick={() => { setMode("sell"); setDestAccountId(""); setError(null); }}
              className={`flex-1 py-2 transition-colors ${mode === "sell" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted/60"}`}
            >
              Sell
            </button>
            <button
              type="button"
              onClick={() => { setMode("transfer"); setDestAccountId(""); setError(null); }}
              className={`flex-1 py-2 transition-colors border-l border-border ${mode === "transfer" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted/60"}`}
            >
              Transfer to another account
            </button>
          </div>

          <p className="text-sm text-muted-foreground">
            Available: <span className="font-medium text-foreground">{maxShares.toLocaleString(undefined, { maximumFractionDigits: 8 })} shares</span>
          </p>

          {/* Lot selection mode toggle */}
          <div className="flex rounded border border-border overflow-hidden text-xs font-medium">
            <button
              type="button"
              onClick={() => setSelectionMode("method")}
              className={`flex-1 py-2 transition-colors ${selectionMode === "method" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted/60"}`}
            >
              By cost basis method
            </button>
            <button
              type="button"
              onClick={() => setSelectionMode("lots")}
              className={`flex-1 py-2 transition-colors border-l border-border ${selectionMode === "lots" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted/60"}`}
            >
              Specific lots
            </button>
          </div>

          {selectionMode === "method" ? (
            <>
              <div className={`grid gap-3 ${mode === "sell" ? "grid-cols-2" : "grid-cols-1"}`}>
                <div>
                  <label className="block text-xs font-medium mb-1">{mode === "sell" ? "Shares to Sell" : "Shares to Transfer"}</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={shares}
                    placeholder="0.000000"
                    onChange={(e) => setShares(e.target.value)}
                    className="w-full rounded border border-border px-3 py-2 tp-numeric focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                {mode === "sell" && (
                  <div>
                    <label className="block text-xs font-medium mb-1">Sale Price / Share</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={price}
                        placeholder="0.00"
                        onChange={(e) => setPrice(e.target.value)}
                        className="w-full rounded border border-border pl-7 pr-3 py-2 tp-numeric focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Cost Basis Method</label>
                <div className="relative">
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value as typeof method)}
                    className="w-full appearance-none rounded-md border border-border py-2 pl-2 pr-6 text-sm text-foreground"
                  >
                    {COST_BASIS_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
                </div>
                <p className="mt-1.5 tp-caption">{methodInfo.description}</p>
              </div>
            </>
          ) : (
            <>
              {/* Lot selection table */}
              <div>
                <div className="mb-1">
                  <label className="text-xs font-medium">Lots — enter shares to {mode === "sell" ? "sell" : "transfer"} from each</label>
                </div>
                <div className="max-h-52 overflow-y-auto rounded border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-100 z-10">
                      <tr className="text-muted-foreground uppercase tracking-[1px] font-mono">
                        <th className="py-2 px-3 text-left font-medium">Acquired</th>
                        <th className="py-2 px-3 text-right font-medium">Available</th>
                        <th className="py-2 px-3 text-right font-medium">Cost/Share</th>
                        <th className="py-2 px-3 text-right font-medium" style={{ width: "130px" }}>Shares</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedLots.map((lot) => {
                        const available = parseFloat(lot.quantity);
                        return (
                          <tr key={lot.id} className="border-t border-border hover:bg-muted/20">
                            <td className="py-2 px-3 tabular-nums font-mono">
                              {lot.acquiredDate ? formatDate(lot.acquiredDate) : "—"}
                            </td>
                            <td className="py-2 px-3 text-right tabular-nums font-mono">
                              {available.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                            </td>
                            <td className="py-2 px-3 text-right tabular-nums font-mono">
                              {formatCurrency(parseFloat(lot.costPerShare))}
                            </td>
                            <td className="py-2 px-3">
                              <div className="flex items-center justify-end gap-1">
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={lotInputs[lot.id] ?? ""}
                                  placeholder="0"
                                  onChange={(e) => setLotInputs((prev) => ({ ...prev, [lot.id]: e.target.value }))}
                                  className="w-14 rounded border border-border px-2 py-1 text-left tabular-nums font-mono focus:outline-none focus:ring-1 focus:ring-primary text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={() => setLotInputs((prev) => ({ ...prev, [lot.id]: String(available) }))}
                                  className="shrink-0 rounded border border-border px-2 py-1 text-xs bg-background hover:bg-muted transition-colors"
                                >
                                  all
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Total shares row for lot mode (sell also shows price) */}
              <div className={`grid gap-3 ${mode === "sell" ? "grid-cols-2" : "grid-cols-1"}`}>
                <div>
                  <label className="block text-xs font-medium mb-1">Total Shares</label>
                  <input
                    type="text"
                    readOnly
                    value={lotTotalShares > 0 ? lotTotalShares.toLocaleString(undefined, { maximumFractionDigits: 8 }) : ""}
                    placeholder="0"
                    className="w-full rounded border border-border px-3 py-2 tp-numeric bg-muted text-muted-foreground cursor-default"
                  />
                </div>
                {mode === "sell" && (
                  <div>
                    <label className="block text-xs font-medium mb-1">Sale Price / Share</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={price}
                        placeholder="0.00"
                        onChange={(e) => setPrice(e.target.value)}
                        className="w-full rounded border border-border pl-7 pr-3 py-2 tp-numeric focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          <div className={`grid gap-3 ${mode === "sell" ? "grid-cols-2" : "grid-cols-1"}`}>
            <div>
              <label className="block text-xs font-medium mb-1">{mode === "sell" ? "Sale Date" : "Transfer Date"}</label>
              <SmartDateInput
                value={actionDate}
                max={localToday()}
                onChange={setActionDate}
                className="w-full rounded border border-border px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {mode === "sell" && (
              <div>
                <label className="block text-xs font-medium mb-1">Fees <span className="font-normal text-muted-foreground">(optional)</span></label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={fees}
                    placeholder="0.00"
                    onChange={(e) => setFees(e.target.value)}
                    className="w-full rounded border border-border pl-7 pr-3 py-2 tp-numeric focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">{mode === "sell" ? "Proceeds Go To" : "Transfer To"}</label>
            <div className="relative">
              <select
                value={destAccountId}
                onChange={(e) => setDestAccountId(e.target.value)}
                className="w-full appearance-none rounded-md border border-border py-2 pl-2 pr-6 text-sm text-foreground"
              >
                <option value="">Select account…</option>
                {eligibleAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
            </div>
            {mode === "transfer" && transferEligibleAccounts.length === 0 && (
              <p className="mt-1 tp-caption">No other investment accounts found.</p>
            )}
          </div>

          {error && <p className="text-sm text-down">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
            <Button onClick={handleNext} disabled={loading || (mode === "transfer" && transferEligibleAccounts.length === 0)} className="flex-1">
              {loading ? "Calculating…" : mode === "sell" ? "Preview Sale →" : "Review Transfer →"}
            </Button>
          </div>
        </div>
      ) : mode === "sell" ? (
        <div className="space-y-4">
          {/* Sell — lot breakdown table */}
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground uppercase tracking-[1px] font-mono">
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
                    <td className="py-2 px-3 tabular-nums font-mono">{formatDate(lot.acquiredDate)}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-mono">
                      {lot.shares.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums font-mono">{formatCurrency(lot.costPerShare)}</td>
                    <td className="py-2 px-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        lot.termType === "LONG"
                          ? "bg-up-soft text-up-deep"
                          : "bg-warn-soft text-warn-deep"
                      }`}>
                        {lot.termType === "LONG" ? "Long-term" : "Short-term"}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums font-mono">{formatCurrency(lot.proceeds)}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-mono">{formatCurrency(lot.costBasis)}</td>
                    <td className={`py-2 px-3 text-right tabular-nums font-mono font-medium ${gainColor(lot.gain)}`}>
                      {lot.gain >= 0 ? "+" : ""}{formatCurrency(lot.gain)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Sell — summary */}
          <div className="rounded border border-border bg-muted/20 p-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Gross Proceeds</span>
              <StatValue className="font-medium">{formatCurrency(preview!.grossProceeds)}</StatValue>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Fees</span>
              <StatValue className="font-medium">{preview!.fees > 0 ? `(${formatCurrency(preview!.fees)})` : "—"}</StatValue>
            </div>
            <div className="flex justify-between border-t border-border pt-2 col-span-2">
              <span className="font-medium">Net Proceeds</span>
              <StatValue className="font-bold">{formatCurrency(preview!.netProceeds)}</StatValue>
            </div>
            {preview!.stShares > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Short-Term Gain</span>
                <span className={`tabular-nums font-mono font-medium ${gainColor(preview!.stGain)}`}>
                  {preview!.stGain >= 0 ? "+" : ""}{formatCurrency(preview!.stGain)}
                </span>
              </div>
            )}
            {preview!.ltShares > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Long-Term Gain</span>
                <span className={`tabular-nums font-mono font-medium ${gainColor(preview!.ltGain)}`}>
                  {preview!.ltGain >= 0 ? "+" : ""}{formatCurrency(preview!.ltGain)}
                </span>
              </div>
            )}
            <div className={`flex justify-between border-t border-border pt-2 ${preview!.stShares > 0 && preview!.ltShares > 0 ? "col-span-2" : ""}`}>
              <span className="font-medium">Total Taxable Gain</span>
              <span className={`tabular-nums font-mono font-bold ${gainColor(preview!.totalGain)}`}>
                {preview!.totalGain >= 0 ? "+" : ""}{formatCurrency(preview!.totalGain)}
              </span>
            </div>
          </div>

          {error && <p className="text-sm text-down">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={() => { setStep("input"); setError(null); }} className="flex-1">
              ← Back
            </Button>
            <Button onClick={handleConfirm} disabled={submitting} className="flex-1">
              {submitting ? "Recording…" : "Confirm Sale"}
            </Button>
          </div>
        </div>
      ) : (
        /* Transfer — confirm summary (no server round-trip needed, no taxable gain) */
        <div className="space-y-4">
          <div className="rounded border border-border bg-muted/20 p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">From</span>
              <span className="font-medium">This account</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">To</span>
              <span className="font-medium">{destAccount?.name ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Ticker</span>
              <StatValue className="font-medium">{holding.ticker}</StatValue>
            </div>
            <div className="flex justify-between border-t border-border pt-2 mt-1">
              <span className="text-muted-foreground">Total Shares</span>
              <StatValue className="font-medium">
                {(selectionMode === "method" ? parseFloat(shares) : lotTotalShares).toLocaleString(undefined, { maximumFractionDigits: 8 })}
              </StatValue>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total Cost Basis</span>
              <StatValue className="font-medium">{formatCurrency(transferTotalCostBasis)}</StatValue>
            </div>
          </div>

          {transferLotBreakdown.length > 0 && (
            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/40 text-muted-foreground uppercase tracking-[1px] font-mono">
                    <th className="py-2 px-3 text-left font-medium">Lot Date</th>
                    <th className="py-2 px-3 text-right font-medium">Shares</th>
                    <th className="py-2 px-3 text-right font-medium">Cost/Share</th>
                    <th className="py-2 px-3 text-right font-medium">Cost Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {transferLotBreakdown.map((lot, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-2 px-3 tabular-nums font-mono">{lot.acquiredDate ? formatDate(lot.acquiredDate) : "—"}</td>
                      <td className="py-2 px-3 text-right tabular-nums font-mono">
                        {lot.shares.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums font-mono">{formatCurrency(lot.costPerShare)}</td>
                      <td className="py-2 px-3 text-right tabular-nums font-mono">{formatCurrency(lot.shares * lot.costPerShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="tp-caption">
            Cost basis and acquisition dates are preserved in the destination account. No taxable event is recorded.
          </p>

          {error && <p className="text-sm text-down">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" onClick={() => { setStep("input"); setError(null); }} className="flex-1">
              ← Back
            </Button>
            <Button onClick={handleConfirm} disabled={submitting} className="flex-1">
              {submitting ? "Transferring…" : "Confirm Transfer"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Activity tab ───────────────────────────────────────────────────────────────

// ── Edit Sale Activity Modal ──────────────────────────────────────────────────

function EditSaleActivityModal({
  activity,
  onClose,
  onSaved,
}: {
  activity: InvestmentActivity;
  onClose: () => void;
  onSaved: (updated: InvestmentActivity) => void;
}) {
  const [price, setPrice] = useState(activity.pricePerShare?.toString() ?? "");
  const [fees, setFees] = useState(activity.fees?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceNum = parseFloat(price.replace(/,/g, "")) || 0;
  const feesNum = parseFloat(fees.replace(/,/g, "")) || 0;
  const grossProceeds = priceNum * (activity.shares ?? 0);
  const netProceeds = grossProceeds - feesNum;
  const gain = netProceeds - (activity.costBasis ?? 0);

  const handleSave = async () => {
    const p = parseFloat(price.replace(/,/g, ""));
    const f = parseFloat(fees.replace(/,/g, "")) || 0;
    if (!p || p <= 0) { setError("Price per share must be a positive number."); return; }
    if (f < 0) { setError("Fees cannot be negative."); return; }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateSaleActivity(activity.id, { pricePerShare: p, ...(f > 0 ? { fees: f } : {}) });
      onSaved(updated);
    } catch (e: any) {
      setError(e.message ?? "Failed to save.");
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Edit Sale">
      {/* Explanation */}
      <div className="flex gap-2.5 rounded-md bg-muted/60 border border-border p-3 mb-5">
        <AlertCircle className="shrink-0 mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
        <p className="tp-caption leading-relaxed">
          Only <strong className="text-foreground">price per share</strong> and <strong className="text-foreground">fees</strong> can be corrected here.
          Shares, date, and cost basis are locked because the original per-lot breakdown is not
          retained after a sale commits — editing those fields would produce incorrect gain figures.
        </p>
      </div>

      {/* Read-only context */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {[
          { label: "Date", value: formatDate(activity.date) },
          { label: "Symbol", value: activity.ticker, mono: true },
          {
            label: "Shares",
            value: activity.shares != null
              ? activity.shares.toLocaleString(undefined, { maximumFractionDigits: 8 })
              : "—",
          },
        ].map(({ label, value, mono }) => (
          <div key={label}>
            <label className="block text-xs font-medium mb-1">{label}</label>
            <div className={`rounded border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground select-none ${mono ? "font-mono font-bold" : ""}`}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Editable fields */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-xs font-medium mb-1">Price / Share</label>
          <input
            type="text"
            inputMode="decimal"
            value={price}
            placeholder="0.000000"
            onChange={(e) => setPrice(e.target.value)}
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Fees</label>
          <input
            type="text"
            inputMode="decimal"
            value={fees}
            placeholder="0.00"
            onChange={(e) => setFees(e.target.value)}
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      {/* Live recomputed preview */}
      {priceNum > 0 && (
        <div className="rounded-md border border-border bg-muted/20 px-4 py-3 mb-4 grid grid-cols-3 gap-2 text-xs">
          <div>
            <p className="text-muted-foreground mb-0.5">Gross</p>
            <StatValue as="p" className="font-medium">{formatCurrency(grossProceeds)}</StatValue>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">Net</p>
            <StatValue as="p" className="font-medium">{formatCurrency(netProceeds)}</StatValue>
          </div>
          <div>
            <p className="text-muted-foreground mb-0.5">Gain / Loss</p>
            <p className={`font-medium tabular-nums font-mono ${gain >= 0 ? "text-up" : "text-down"}`}>
              {gain >= 0 ? "+" : ""}{formatCurrency(gain)}
            </p>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-down mb-3">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </Modal>
  );
}

// ── Review Dividend Modal ─────────────────────────────────────────────────────

function ReviewDividendModal({
  dividend,
  categories,
  onClose,
  onConfirmed,
  onDismissed,
}: {
  dividend: PendingDividend;
  categories: Category[];
  onClose: () => void;
  onConfirmed: (wasReinvest?: boolean) => void;
  onDismissed: () => void;
}) {
  // Normalize ex-date — Prisma serializes @db.Date as a full ISO timestamp, so
  // we strip the time portion before parsing to avoid NaN from "15T00:00:00.000Z".
  const exDateStr = useMemo(() => dividend.exDate.split("T")[0], [dividend.exDate]);

  // Default income payment date: ex-date + 4 business days
  const defaultPayableDate = useMemo(() => {
    const [y, m, d] = exDateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + 4);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }, [exDateStr]);

  // ── Common fields ──────────────────────────────────────────────────────────
  const [perShareAmount, setPerShareAmount] = useState(parseFloat(dividend.perShareAmount).toFixed(6));
  const [shares, setShares] = useState(parseFloat(dividend.sharesAtExDate).toString());
  const [totalAmount, setTotalAmount] = useState(
    (parseFloat(dividend.perShareAmount) * parseFloat(dividend.sharesAtExDate)).toFixed(2)
  );
  const [taxClassification, setTaxClassification] = useState<TaxClassification | "">(
    dividend.lastTaxClassification ?? ""
  );
  const [notes, setNotes] = useState("");

  // ── Disposition ───────────────────────────────────────────────────────────
  const [disposition, setDisposition] = useState<"income" | "reinvest">("income");

  // ── Income-path fields ────────────────────────────────────────────────────
  const [paymentDate, setPaymentDate] = useState(defaultPayableDate);
  const [categoryId, setCategoryId] = useState(
    () => categories.find(c => c.name.toLowerCase() === "dividend")?.id ?? ""
  );

  // ── Reinvest-path fields ──────────────────────────────────────────────────
  const [reinvestDate, setReinvestDate] = useState(exDateStr);
  const [reinvestPrice, setReinvestPrice] = useState("");
  const [reinvestQuantity, setReinvestQuantity] = useState("");
  const [reinvestPriceFetching, setReinvestPriceFetching] = useState(false);

  // Keep a ref to totalAmount so the price-fetch effect always reads the
  // current value without being a dep that re-triggers the fetch.
  const totalAmountRef = useRef(totalAmount);
  useEffect(() => { totalAmountRef.current = totalAmount; }, [totalAmount]);

  // ── Auto-fetch closing price when switching to reinvest or date changes ───
  useEffect(() => {
    if (disposition !== "reinvest") return;
    let cancelled = false;
    // Clear fields immediately so the user sees the inputs update for the new date
    setReinvestPrice("");
    setReinvestQuantity("");
    setReinvestPriceFetching(true);
    getTickerPrice(dividend.ticker, reinvestDate)
      .then((result) => {
        if (cancelled) return;
        const p = result.price.toFixed(4);
        setReinvestPrice(p);
        const total = parseFloat(totalAmountRef.current);
        const price = parseFloat(p);
        if (!isNaN(total) && total > 0 && !isNaN(price) && price > 0) {
          setReinvestQuantity((total / price).toFixed(8));
        }
      })
      .catch(() => { /* price stays blank; user can enter manually */ })
      .finally(() => { if (!cancelled) setReinvestPriceFetching(false); });
    return () => { cancelled = true; };
  }, [disposition, reinvestDate, dividend.ticker]);

  // ── Status ────────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Field change handlers ─────────────────────────────────────────────────
  const handlePerShareChange = (val: string) => {
    setPerShareAmount(val);
    const psa = parseFloat(val.replace(/,/g, ""));
    const sh = parseFloat(shares.replace(/,/g, ""));
    if (!isNaN(psa) && psa > 0 && !isNaN(sh) && sh > 0) {
      setTotalAmount((psa * sh).toFixed(2));
    }
  };

  const handleSharesChange = (val: string) => {
    setShares(val);
    const sh = parseFloat(val.replace(/,/g, ""));
    const psa = parseFloat(perShareAmount.replace(/,/g, ""));
    if (!isNaN(sh) && sh > 0 && !isNaN(psa) && psa > 0) {
      setTotalAmount((psa * sh).toFixed(2));
    }
  };

  const handleReinvestPriceChange = (val: string) => {
    setReinvestPrice(val);
    const p = parseFloat(val.replace(/,/g, ""));
    const total = parseFloat(totalAmount.replace(/,/g, ""));
    if (!isNaN(p) && p > 0 && !isNaN(total) && total > 0) {
      setReinvestQuantity((total / p).toFixed(8));
    }
  };

  // Discrepancy between price × quantity and total (for reinvest path)
  const reinvestDiscrepancy = useMemo(() => {
    const p = parseFloat(reinvestPrice.replace(/,/g, ""));
    const q = parseFloat(reinvestQuantity.replace(/,/g, ""));
    const total = parseFloat(totalAmount.replace(/,/g, ""));
    if (isNaN(p) || isNaN(q) || isNaN(total)) return 0;
    return Math.abs(p * q - total);
  }, [reinvestPrice, reinvestQuantity, totalAmount]);

  // ── Confirm handlers ──────────────────────────────────────────────────────
  const handleConfirm = async () => {
    const psa = parseFloat(perShareAmount.replace(/,/g, ""));
    const sh = parseFloat(shares.replace(/,/g, ""));
    const total = parseFloat(totalAmount.replace(/,/g, ""));
    setError(null);

    if (isNaN(psa) || psa <= 0 || isNaN(sh) || sh <= 0 || isNaN(total) || total <= 0) {
      setError("Please fill in all required fields with valid values.");
      return;
    }

    setSaving(true);
    try {
      if (disposition === "income") {
        if (!paymentDate) { setError("Payment date is required."); setSaving(false); return; }
        await confirmPendingDividend(dividend.id, {
          date: paymentDate,
          perShareAmount: psa,
          shares: sh,
          totalAmount: total,
          categoryId: categoryId || null,
          taxClassification: (taxClassification as TaxClassification) || null,
          notes: notes || null,
          source: dividend.ticker,
        });
      } else {
        const rPrice = parseFloat(reinvestPrice.replace(/,/g, ""));
        const rQty = parseFloat(reinvestQuantity.replace(/,/g, ""));
        if (!reinvestDate || isNaN(rPrice) || rPrice <= 0 || isNaN(rQty) || rQty <= 0) {
          setError("Please fill in reinvest date, price, and quantity.");
          setSaving(false);
          return;
        }
        await confirmReinvestDividend(dividend.id, {
          exDate: exDateStr,
          reinvestDate,
          perShareAmount: psa,
          shares: sh,
          totalAmount: total,
          reinvestPrice: rPrice,
          reinvestQuantity: rQty,
          taxClassification: (taxClassification as TaxClassification) || null,
          notes: notes || null,
        });
      }
      onConfirmed(disposition === "reinvest");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to confirm dividend");
      setSaving(false);
    }
  };

  const handleDismiss = async () => {
    setDismissing(true);
    setError(null);
    try {
      await dismissPendingDividend(dividend.id);
      onDismissed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to dismiss dividend");
      setDismissing(false);
    }
  };

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-background";

  return (
    <Modal open onClose={onClose} title="Review Pending Dividend">
      <div className="space-y-4">
        {/* Summary row — ticker left, ex-date right */}
        <div className="flex items-center justify-between p-3 bg-muted/40 rounded-lg">
          <p className="text-sm font-semibold">{dividend.ticker}</p>
          <p className="text-sm text-muted-foreground">Ex-date: {formatDate(dividend.exDate)}</p>
        </div>

        {/* Verification warning */}
        <div className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-3 py-2.5 text-xs text-warn-deep">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>Please verify all amounts against your actual payment record before confirming.</p>
        </div>

        {/* Per-share amount + shares at ex-date */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Per Share Amount</label>
            <input
              type="text"
              inputMode="decimal"
              value={perShareAmount}
              placeholder="0.000000"
              onChange={(e) => handlePerShareChange(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Shares at Ex-Date</label>
            <input
              type="text"
              inputMode="decimal"
              value={shares}
              placeholder="0.000000"
              onChange={(e) => handleSharesChange(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        {/* Total amount */}
        <div>
          <label className="block text-xs font-medium mb-1">Total Amount</label>
          <input
            type="text"
            inputMode="decimal"
            value={totalAmount}
            placeholder="0.00"
            onChange={(e) => setTotalAmount(e.target.value)}
            className={inputCls}
          />
        </div>

        {/* Disposition toggle */}
        <div>
          <label className="block text-xs font-medium mb-2">Disposition</label>
          <div className="flex gap-2">
            {(["income", "reinvest"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDisposition(d)}
                className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  disposition === d
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {d === "income" ? "Received as income" : "Reinvested (DRIP)"}
              </button>
            ))}
          </div>
        </div>

        {/* ── Income path fields ──────────────────────────────────────────── */}
        {disposition === "income" && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1">Payment Date</label>
              <input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                Category <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <div className="relative">
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full appearance-none rounded-md border border-border py-2 pl-2 pr-6 text-sm text-foreground"
                >
                  <option value="">No category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
              </div>
            </div>
          </>
        )}

        {/* ── Reinvest path fields ────────────────────────────────────────── */}
        {disposition === "reinvest" && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1">Reinvest Date</label>
              <input
                type="date"
                value={reinvestDate}
                onChange={(e) => setReinvestDate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">
                  Reinvest Price / Share
                  {reinvestPriceFetching && (
                    <span className="ml-1 font-normal opacity-60">fetching…</span>
                  )}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={reinvestPrice}
                  placeholder="0.0000"
                  onChange={(e) => handleReinvestPriceChange(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Shares Reinvested</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={reinvestQuantity}
                  placeholder="0.000000"
                  onChange={(e) => setReinvestQuantity(e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>
            {reinvestDiscrepancy > 0.05 && (
              <div className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn-deep">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <p>
                  Price × shares ({formatCurrency(parseFloat(reinvestPrice) * parseFloat(reinvestQuantity))}) differs
                  from the total amount ({formatCurrency(parseFloat(totalAmount))}) by{" "}
                  {formatCurrency(reinvestDiscrepancy)}. Adjust values as needed.
                </p>
              </div>
            )}
          </>
        )}

        {/* Dividend type — applies to both paths */}
        <div>
          <label className="block text-xs font-medium mb-1">
            Dividend Type <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <div className="relative">
            <select
              value={taxClassification}
              onChange={(e) => setTaxClassification(e.target.value as TaxClassification | "")}
              className="w-full appearance-none rounded-md border border-border py-2 pl-2 pr-6 text-sm text-foreground"
            >
              <option value="">Not specified</option>
              <option value="CAPITAL_GAIN">Capital Gain</option>
              <option value="ORDINARY">Ordinary</option>
              <option value="QUALIFIED">Qualified</option>
              <option value="RETURN_OF_CAPITAL">Return of Capital</option>
              <option value="TAX_EXEMPT">Tax-Exempt</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
          </div>
        </div>

        {/* Notes — applies to both paths */}
        <div>
          <label className="block text-xs font-medium mb-1">
            Notes <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. Q1 dividend"
            className={`${inputCls} resize-none`}
          />
        </div>

        {error && <p className="text-sm text-down">{error}</p>}

        <div className="flex justify-between">
          <Button
            variant="ghost"
            onClick={handleDismiss}
            disabled={saving || dismissing}
            className="text-muted-foreground hover:text-foreground"
          >
            {dismissing ? "Dismissing…" : "Dismiss"}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving || dismissing}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={saving || dismissing}>
              {saving
                ? "Confirming…"
                : disposition === "income"
                ? "Confirm Dividend"
                : "Confirm Reinvestment"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Edit Confirmed Dividend Modal ─────────────────────────────────────────────

function EditConfirmedDividendModal({
  activityId,
  onClose,
  onSaved,
}: {
  activityId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [dividendInfo, setDividendInfo] = useState<ConfirmedDividendInfo | null>(null);
  const [paymentDate, setPaymentDate] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getConfirmedDividend(activityId)
      .then((info) => {
        setDividendInfo(info);
        setPaymentDate(info.paymentDate.split("T")[0]);
        setAmount(info.amount.toFixed(2));
        setNotes(info.notes ?? "");
      })
      .catch(() => setFetchError("Failed to load dividend information."))
      .finally(() => setLoading(false));
  }, [activityId]);

  const handleSave = async () => {
    if (!dividendInfo) return;
    const parsedAmount = parseFloat(amount.replace(/,/g, ""));
    if (!paymentDate || isNaN(parsedAmount) || parsedAmount <= 0) {
      setError("Please enter a valid payment date and amount.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateConfirmedDividend(dividendInfo.pendingDividendId, { paymentDate, amount: parsedAmount, notes: notes || null });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save changes.");
      setSaving(false);
    }
  };

  const inputCls = "w-full border border-border rounded-md px-3 py-2 text-sm bg-background";
  const readonlyCls = `${inputCls} opacity-60 cursor-default`;

  return (
    <Modal open onClose={onClose} title="Edit Confirmed Dividend">
      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
      ) : fetchError ? (
        <div className="space-y-4">
          <p className="text-sm text-down">{fetchError}</p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : dividendInfo ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-muted/40 rounded-lg">
            <p className="text-sm font-semibold">{dividendInfo.ticker}</p>
            <p className="text-sm text-muted-foreground">Ex-date: {formatDate(dividendInfo.exDate)}</p>
          </div>

          {dividendInfo.isDrip && (
            <div className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-soft px-3 py-2.5 text-xs text-warn-deep">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <p>DRIP reinvestments cannot be edited after confirmation. Dismiss and re-confirm to make changes.</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Per Share Amount</label>
              <input readOnly value={dividendInfo.perShareAmount.toFixed(6)} className={readonlyCls} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Shares at Ex-Date</label>
              <input readOnly value={dividendInfo.sharesAtExDate.toLocaleString(undefined, { maximumFractionDigits: 8 })} className={readonlyCls} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">
              {dividendInfo.isDrip ? "Reinvest Date" : "Payment Date"}
            </label>
            <input
              type={dividendInfo.isDrip ? "text" : "date"}
              value={dividendInfo.isDrip ? paymentDate : paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              readOnly={dividendInfo.isDrip}
              className={dividendInfo.isDrip ? readonlyCls : inputCls}
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Total Amount</label>
            <input
              type={dividendInfo.isDrip ? "text" : "number"}
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              readOnly={dividendInfo.isDrip}
              className={dividendInfo.isDrip ? readonlyCls : inputCls}
            />
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">
              Notes <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              readOnly={dividendInfo.isDrip}
              className={dividendInfo.isDrip ? readonlyCls : inputCls}
              placeholder="e.g. Q1 dividend"
            />
          </div>

          {error && <p className="text-sm text-down">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {dividendInfo.isDrip ? "Close" : "Cancel"}
            </Button>
            {!dividendInfo.isDrip && (
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save Changes"}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

// ── Pending Buy Review Modal ───────────────────────────────────────────────────

interface PendingBuyModalProps {
  pendingBuy: PendingBuy;
  onClose: () => void;
  onSaved: () => void;
}

function PendingBuyModal({ pendingBuy, onClose, onSaved }: PendingBuyModalProps) {
  const pos = pendingBuy.optionsPosition;
  const defaultAcquiredDate = pendingBuy.acquiredDate.split("T")[0];
  const defaultQuantity = Number(pendingBuy.quantity);
  const defaultCostPerShare = Number(pendingBuy.costPerShare);

  const [acquiredDate, setAcquiredDate] = useState(defaultAcquiredDate);
  const [quantity, setQuantity] = useState(defaultQuantity.toString());
  const [costPerShare, setCostPerShare] = useState(defaultCostPerShare.toFixed(6).replace(/\.?0+$/, ""));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const totalCost = (parseFloat(quantity.replace(/,/g, "")) || 0) * (parseFloat(costPerShare.replace(/,/g, "")) || 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await confirmPendingBuy(pendingBuy.id, {
        acquiredDate,
        quantity: parseFloat(quantity.replace(/,/g, "")),
        costPerShare: parseFloat(costPerShare.replace(/,/g, "")),
        notes: notes || null,
      });
      onSaved();
    } catch {
      setError("Failed to confirm buy.");
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
  const dollarInputClass = "w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <Modal open onClose={onClose} title={`Review Pending Buy — ${pendingBuy.ticker}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Origin summary */}
        <div className="rounded-md bg-muted/30 px-3 py-2 text-sm space-y-0.5">
          <div className="flex items-center gap-3">
            <span className="font-medium text-foreground">{pos.ticker.symbol}</span>
            <span className="text-muted-foreground">${Number(pos.strikePrice).toFixed(2)} {pos.optionType} · {pos.contracts} contract{pos.contracts !== 1 ? "s" : ""}</span>
          </div>
          <div className="tp-caption">
            Assigned from options position · Premium ${Number(pos.premiumPerShare).toFixed(4)}/share
            {(Number(pos.feesOpen) || Number(pos.feesClose)) ? ` · Fees $${((Number(pos.feesOpen) || 0) + (Number(pos.feesClose) || 0)).toFixed(2)}` : ""}
          </div>
        </div>

        <div className="rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn-deep flex gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>Verify all amounts against your brokerage confirmation before confirming.</span>
        </div>

        {/* Acquired Date */}
        <div>
          <label className="block text-xs font-medium mb-1">Acquired Date</label>
          <input
            type="date" required
            value={acquiredDate} onChange={(e) => setAcquiredDate(e.target.value)}
            className={inputClass}
          />
        </div>

        {/* Quantity / Cost per Share */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">Shares Acquired</label>
            <input
              type="text" inputMode="numeric" required
              placeholder="0"
              value={quantity} onChange={(e) => setQuantity(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Cost Per Share</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="text" inputMode="decimal" required
                placeholder="0.000000"
                value={costPerShare} onChange={(e) => setCostPerShare(e.target.value)}
                className={dollarInputClass}
              />
            </div>
          </div>
        </div>

        {/* Total cost */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Total Cost</span>
          <span className="font-semibold">{formatCurrency(totalCost)}</span>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium mb-1">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
          <textarea
            rows={2}
            value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. CSP assigned"
            className="w-full rounded-md border border-border px-3 py-2 text-sm resize-none focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {error && <p className="text-sm text-down">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Confirming…" : "Confirm Purchase"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Pending Sale Modal ────────────────────────────────────────────────────────

interface PendingSaleModalProps {
  pendingSale: PendingSale;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}

function PendingSaleModal({ pendingSale, accounts, onClose, onSaved }: PendingSaleModalProps) {
  const pos = pendingSale.optionsPosition;
  const defaultSaleDate = pendingSale.saleDate.split("T")[0];
  const defaultShares = Number(pendingSale.quantity);
  const defaultPricePerShare = Number(pendingSale.pricePerShare);

  const [saleDate, setSaleDate] = useState(defaultSaleDate);
  const [shares, setShares] = useState(defaultShares.toString());
  const [pricePerShare, setPricePerShare] = useState(defaultPricePerShare.toFixed(4).replace(/\.?0+$/, ""));
  const hasSuggestedLots = pendingSale.suggestedLotIds.length > 0;
  const [selectionMode, setSelectionMode] = useState<"method" | "lots">(hasSuggestedLots ? "lots" : "method");
  const [method, setMethod] = useState<"FIFO" | "LIFO" | "MIN_TAX" | "MAX_GAIN">("FIFO");
  const [lotInputs, setLotInputs] = useState<Record<string, string>>({});
  const [fees, setFees] = useState("");
  const [destAccountId, setDestAccountId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Fetch lots for the holding so user can pick specific ones
  const { data: holdings } = useApi(
    () => getInvestmentHoldings(pendingSale.accountId),
    [pendingSale.accountId]
  );
  const holding = holdings?.find(h => h.ticker === pendingSale.ticker) ?? null;
  const sortedLots = holding
    ? [...holding.lots].sort((a, b) => {
        if (!a.acquiredDate) return 1;
        if (!b.acquiredDate) return -1;
        return a.acquiredDate < b.acquiredDate ? -1 : 1;
      })
    : [];

  // Once lots load, pre-fill suggested lot quantities (full lot quantity for each suggested lot)
  const [suggestedApplied, setSuggestedApplied] = useState(false);
  useEffect(() => {
    if (suggestedApplied || !hasSuggestedLots || sortedLots.length === 0) return;
    const inputs: Record<string, string> = {};
    for (const lot of sortedLots) {
      if (pendingSale.suggestedLotIds.includes(lot.id)) {
        inputs[lot.id] = parseFloat(lot.quantity).toString();
      }
    }
    if (Object.keys(inputs).length > 0) {
      setLotInputs(inputs);
      setSuggestedApplied(true);
    }
  }, [sortedLots, hasSuggestedLots, pendingSale.suggestedLotIds, suggestedApplied]);

  const lotAllocations = sortedLots
    .map(lot => ({ lotId: lot.id, shares: parseFloat((lotInputs[lot.id] || "0").replace(/,/g, "")) || 0 }))
    .filter(a => a.shares > 0);
  const lotTotalShares = lotAllocations.reduce((s, a) => s + a.shares, 0);

  const eligibleAccounts = accounts.filter(a => a.type !== "CREDIT_CARD");
  const sharesNum = parseFloat(shares.replace(/,/g, "")) || 0;
  const priceNum = parseFloat(pricePerShare.replace(/,/g, "")) || 0;
  const feesNum = parseFloat(fees.replace(/,/g, "")) || 0;
  const grossProceeds = sharesNum * priceNum;
  const netProceeds = grossProceeds - feesNum;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!destAccountId) { setError("Select an account to receive proceeds."); return; }
    const sharesVal = parseFloat(shares.replace(/,/g, ""));
    if (isNaN(sharesVal) || sharesVal <= 0) { setError("Enter a valid number of shares."); return; }
    const priceVal = parseFloat(pricePerShare.replace(/,/g, ""));
    if (isNaN(priceVal) || priceVal <= 0) { setError("Enter a valid price per share."); return; }
    if (selectionMode === "lots" && lotAllocations.length === 0) {
      setError("Specify shares for at least one lot."); return;
    }

    setSaving(true);
    try {
      const feesVal = parseFloat(fees.replace(/,/g, "")) || 0;
      const base = { saleDate, pricePerShare: priceVal, fees: feesVal, destinationAccountId: destAccountId, notes: notes || null };
      await confirmPendingSale(pendingSale.id, selectionMode === "method"
        ? { ...base, costBasisMethod: method }
        : { ...base, lotAllocations }
      );
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? "Failed to confirm sale.");
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
  const dollarInputClass = "w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

  return (
    <Modal open onClose={onClose} title={`Review Pending Sale — ${pendingSale.ticker}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Origin summary */}
        <div className="rounded-md bg-muted/30 px-3 py-2 text-sm space-y-0.5">
          <div className="flex items-center gap-3">
            <span className="font-medium text-foreground">{pos.ticker.symbol}</span>
            <span className="text-muted-foreground">${Number(pos.strikePrice).toFixed(2)} Call · {pos.contracts} contract{pos.contracts !== 1 ? "s" : ""}</span>
          </div>
          <div className="tp-caption">
            Shares called away — assigned from covered call · Premium ${Number(pos.premiumPerShare).toFixed(4)}/share
            {(Number(pos.feesOpen) || Number(pos.feesClose)) ? ` · Fees $${((Number(pos.feesOpen) || 0) + (Number(pos.feesClose) || 0)).toFixed(2)}` : ""}
          </div>
        </div>

        <div className="rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn-deep flex gap-2">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>Price per share is pre-filled as strike + premium − fees (your tax-basis "amount realized"). Verify against your brokerage confirmation before confirming.</span>
        </div>

        {/* Sale Date */}
        <div>
          <label className="block text-xs font-medium mb-1">Sale Date</label>
          <input
            type="date" required
            value={saleDate} onChange={e => setSaleDate(e.target.value)}
            className={inputClass}
          />
        </div>

        {/* Shares / Price per Share */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">Shares Sold</label>
            <input
              type="text" inputMode="numeric" required
              placeholder="0"
              value={shares} onChange={e => setShares(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Price Per Share</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="text" inputMode="decimal" required
                placeholder="0.0000"
                value={pricePerShare} onChange={e => setPricePerShare(e.target.value)}
                className={dollarInputClass}
              />
            </div>
          </div>
        </div>

        {/* Proceeds summary */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Gross Proceeds</span>
            <span className="font-medium">{formatCurrency(grossProceeds)}</span>
          </div>
          {feesNum > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Net Proceeds (after fees)</span>
              <span className="font-semibold">{formatCurrency(netProceeds)}</span>
            </div>
          )}
        </div>

        {/* Lot Selection */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium">Lot Selection</label>
            <div className="flex gap-1">
              <button type="button" onClick={() => setSelectionMode("method")}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${selectionMode === "method" ? "bg-primary text-white" : "text-muted-foreground hover:text-foreground"}`}>
                Method
              </button>
              <button type="button" onClick={() => setSelectionMode("lots")}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${selectionMode === "lots" ? "bg-primary text-white" : "text-muted-foreground hover:text-foreground"}`}>
                Specific Lots
              </button>
            </div>
          </div>

          {selectionMode === "method" ? (
            <select
              value={method}
              onChange={e => setMethod(e.target.value as typeof method)}
              className="appearance-none w-full rounded-md border border-border px-3 py-2 pl-2 pr-6 text-sm text-foreground"
            >
              <option value="FIFO">FIFO — First In, First Out</option>
              <option value="LIFO">LIFO — Last In, First Out</option>
              <option value="MIN_TAX">Min Tax — Highest Cost Basis First</option>
              <option value="MAX_GAIN">Max Gain — Lowest Cost Basis First</option>
            </select>
          ) : (
            <div className="space-y-1">
              {sortedLots.length === 0 && (
                <p className="text-xs text-muted-foreground">No lots found for {pendingSale.ticker}.</p>
              )}
              {sortedLots.map(lot => (
                <div key={lot.id} className="flex items-center gap-3 py-1">
                  <div className="flex-1 text-xs">
                    <span className="font-medium">{lot.acquiredDate ? formatDate(lot.acquiredDate) : "Unknown date"}</span>
                    <span className="text-muted-foreground ml-2">{parseFloat(lot.quantity)} shares @ ${parseFloat(lot.costPerShare).toFixed(4)}</span>
                    {pendingSale.suggestedLotIds.includes(lot.id) && (
                      <span className="ml-1.5 text-[10px] font-medium text-primary bg-primary/10 px-1 py-0.5 rounded">assigned lot</span>
                    )}
                  </div>
                  <input
                    type="text" inputMode="decimal"
                    placeholder="0"
                    value={lotInputs[lot.id] || ""}
                    onChange={e => setLotInputs(prev => ({ ...prev, [lot.id]: e.target.value }))}
                    className="w-20 rounded-md border border-border px-2 py-1 text-xs text-right focus:border-primary focus:outline-none"
                  />
                </div>
              ))}
              {selectionMode === "lots" && lotTotalShares > 0 && (
                <div className="flex justify-between text-xs font-medium pt-1 border-t border-border">
                  <span>Total shares selected</span>
                  <span>{lotTotalShares.toLocaleString()}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sale Fees */}
        <div>
          <label className="block text-xs font-medium mb-1">
            Fees <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="text" inputMode="decimal"
              placeholder="0.00"
              value={fees} onChange={e => setFees(e.target.value)}
              className={dollarInputClass}
            />
          </div>
        </div>

        {/* Destination Account */}
        <div>
          <label className="block text-xs font-medium mb-1">Proceeds To</label>
          <select
            required
            value={destAccountId}
            onChange={e => setDestAccountId(e.target.value)}
            className="appearance-none w-full rounded-md border border-border px-3 py-2 pl-2 pr-6 text-sm text-foreground"
          >
            <option value="">Select account…</option>
            {eligibleAccounts.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium mb-1">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
          <textarea
            rows={2}
            value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="e.g. CC assigned"
            className="w-full rounded-md border border-border px-3 py-2 text-sm resize-none focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {error && <p className="text-sm text-down">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Confirming…" : "Confirm Sale"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Activity Tab ──────────────────────────────────────────────────────────────

function ActivityTab({ accountId, accounts, onHoldingsChanged, onAccountChanged }: { accountId: string; accounts: Account[]; onHoldingsChanged?: () => void; onAccountChanged?: () => void }) {
  const { data: activities, loading: activitiesLoading, refetch: refetchActivities } = useApi(
    () => getInvestmentActivity(accountId),
    [accountId]
  );
  const { data: pendingDividends, loading: dividendsLoading, refetch: refetchDividends } = useApi(
    () => getPendingDividends(accountId),
    [accountId]
  );
  const { data: pendingBuys, loading: buysLoading, refetch: refetchBuys } = useApi(
    () => getPendingBuys(accountId),
    [accountId]
  );
  const { data: pendingSales, loading: salesLoading, refetch: refetchSales } = useApi(
    () => getPendingSales(accountId),
    [accountId]
  );
  const { data: allCategories } = useApi(() => getFlatCategories("INCOME"), []);
  const { refetch: refetchNotifications } = useNotifications();

  const [editingActivity, setEditingActivity] = useState<InvestmentActivity | null>(null);
  const [editingDividendActivityId, setEditingDividendActivityId] = useState<string | null>(null);
  const [reviewingDividend, setReviewingDividend] = useState<PendingDividend | null>(null);
  const [reviewingBuy, setReviewingBuy] = useState<PendingBuy | null>(null);
  const [reviewingSale, setReviewingSale] = useState<PendingSale | null>(null);

  // Filter state — empty Set means "no filter / show all"
  const [selectedTickers, setSelectedTickers] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

  const toggleTicker = useCallback((ticker: string) => {
    setSelectedTickers(prev => {
      const next = new Set(prev);
      next.has(ticker) ? next.delete(ticker) : next.add(ticker);
      return next;
    });
  }, []);

  const toggleType = useCallback((type: string) => {
    setSelectedTypes(prev => {
      const next = new Set(prev);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedTickers(new Set());
    setSelectedTypes(new Set());
  }, []);

  const hasActiveFilters = selectedTickers.size > 0 || selectedTypes.size > 0;

  // Unique sorted tickers present in the activity list
  const uniqueTickers = useMemo(
    () => [...new Set(activities?.map(a => a.ticker) ?? [])].sort(),
    [activities]
  );

  // Types that actually appear in the data (skip showing a type button if no rows exist)
  const presentTypes = useMemo(
    () => new Set(activities?.map(a => a.type) ?? []),
    [activities]
  );

  const filteredActivities = useMemo(() => {
    if (!activities) return [];
    return activities.filter(a => {
      const tickerMatch = selectedTickers.size === 0 || selectedTickers.has(a.ticker);
      const typeMatch = selectedTypes.size === 0 || selectedTypes.has(a.type);
      return tickerMatch && typeMatch;
    });
  }, [activities, selectedTickers, selectedTypes]);

  const loading = activitiesLoading || dividendsLoading || buysLoading || salesLoading;
  const hasPendingDividends = pendingDividends && pendingDividends.length > 0;
  const hasPendingBuys = pendingBuys && pendingBuys.length > 0;
  const hasPendingSales = pendingSales && pendingSales.length > 0;
  const hasPending = hasPendingDividends || hasPendingBuys || hasPendingSales;

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

  if (!hasPending && (!activities || activities.length === 0)) {
    return (
      <Card className="p-8 text-center">
        <p className="text-sm font-medium text-muted-foreground">No activity yet</p>
        <p className="tp-caption mt-1">
          Purchases, sales, and dividends will appear here once recorded.
        </p>
      </Card>
    );
  }

  return (
    <>
      {/* Pending Buys card */}
      {hasPendingBuys && (
        <Card className="overflow-hidden mb-4">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Clock className="h-4 w-4 text-warn" />
            <h3 className="font-semibold text-sm">Pending Buys</h3>
            <span className="ml-1 inline-flex items-center justify-center rounded-full bg-warn-soft text-warn-deep text-[10px] font-semibold px-1.5 py-0.5">
              {pendingBuys!.length}
            </span>
            <span className="ml-auto text-sm font-semibold text-warn">
              {formatCurrency(pendingBuys!.reduce((sum, pb) => sum + Number(pb.quantity) * Number(pb.costPerShare), 0))}
            </span>
          </div>
          <div className="divide-y divide-border">
            {pendingBuys!.map((pb) => {
              const shares = Number(pb.quantity);
              const cps = Number(pb.costPerShare);
              const acquired = pb.acquiredDate.split("T")[0];
              return (
                <div key={pb.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-xs">{pb.ticker}</span>
                      <span className="tp-caption">from options assignment · {acquired}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="tp-caption">
                        {shares.toLocaleString()} shares @ ${cps.toFixed(4)}/share
                      </span>
                      <span className="text-xs font-medium">≈ {formatCurrency(shares * cps)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-7 px-2 text-muted-foreground"
                      onClick={async () => {
                        try {
                          await dismissPendingBuy(pb.id);
                          refetchBuys();
                          refetchNotifications();
                        } catch { /* ignore */ }
                      }}
                    >
                      Dismiss
                    </Button>
                    <Button
                      size="sm"
                      className="text-xs h-7 px-3 flex items-center gap-1"
                      onClick={() => setReviewingBuy(pb)}
                    >
                      Review
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Pending Sales card */}
      {hasPendingSales && (
        <Card className="overflow-hidden mb-4">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Clock className="h-4 w-4 text-down" />
            <h3 className="font-semibold text-sm">Pending Sales</h3>
            <span className="ml-1 inline-flex items-center justify-center rounded-full bg-down-soft text-down text-[10px] font-semibold px-1.5 py-0.5">
              {pendingSales!.length}
            </span>
            <span className="ml-auto text-sm font-semibold text-down">
              {formatCurrency(pendingSales!.reduce((sum, ps) => sum + Number(ps.quantity) * Number(ps.pricePerShare), 0))}
            </span>
          </div>
          <div className="divide-y divide-border">
            {pendingSales!.map((ps) => {
              const shares = Number(ps.quantity);
              const pps = Number(ps.pricePerShare);
              const saleDate = ps.saleDate.split("T")[0];
              return (
                <div key={ps.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-xs">{ps.ticker}</span>
                      <span className="tp-caption">from covered call assignment · {saleDate}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="tp-caption">
                        {shares.toLocaleString()} shares @ ${pps.toFixed(4)}/share
                      </span>
                      <span className="text-xs font-medium">≈ {formatCurrency(shares * pps)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-xs h-7 px-2 text-muted-foreground"
                      onClick={async () => {
                        try {
                          await dismissPendingSale(ps.id);
                          refetchSales();
                          refetchNotifications();
                        } catch { /* ignore */ }
                      }}
                    >
                      Dismiss
                    </Button>
                    <Button
                      size="sm"
                      className="text-xs h-7 px-3 flex items-center gap-1"
                      onClick={() => setReviewingSale(ps)}
                    >
                      Review
                      <ChevronRight className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Pending Dividends card */}
      {hasPendingDividends && (
        <Card className="overflow-hidden mb-4">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Clock className="h-4 w-4 text-violet-deep" />
            <h3 className="font-semibold text-sm">Pending Dividends</h3>
            <span className="ml-1 inline-flex items-center justify-center rounded-full bg-violet-soft text-violet-deep text-[10px] font-semibold px-1.5 py-0.5">
              {pendingDividends!.length}
            </span>
            <span className="ml-auto text-sm font-semibold text-violet-deep">
              {formatCurrency(pendingDividends!.reduce((sum, pd) => sum + parseFloat(pd.estimatedTotal), 0))}
            </span>
          </div>
          <div className="divide-y divide-border">
            {pendingDividends!.map((pd) => (
              <div key={pd.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-xs">{pd.ticker}</span>
                    <span className="tp-caption">Ex-date: {formatDate(pd.exDate)}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="tp-caption">
                      ${parseFloat(pd.perShareAmount).toFixed(6)}/share
                      {" × "}
                      {parseFloat(pd.sharesAtExDate).toLocaleString(undefined, { maximumFractionDigits: 4 })} shares
                    </span>
                    <span className="text-xs font-medium">
                      ≈ {formatCurrency(parseFloat(pd.estimatedTotal))}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-xs h-7 px-2 text-muted-foreground"
                    onClick={async () => {
                      try {
                        await dismissPendingDividend(pd.id);
                        refetchDividends();
                        refetchNotifications();
                      } catch {
                        // silently ignore
                      }
                    }}
                  >
                    Dismiss
                  </Button>
                  <Button
                    size="sm"
                    className="text-xs h-7 px-3 flex items-center gap-1"
                    onClick={() => setReviewingDividend(pd)}
                  >
                    Review
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Activity table */}
      {activities && activities.length > 0 && (
        <Card className="overflow-hidden">
          {/* Header + filters */}
          <div className="px-4 pt-3 pb-3 border-b border-border space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm">Activity</h3>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="tp-caption hover:text-foreground underline"
                >
                  Clear filters
                </button>
              )}
            </div>

            {/* Filters: Symbol left, Type right — side-by-side when space allows, stacked on small screens */}
            <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
              {/* Holding filter — only shown when multiple tickers are present */}
              {uniqueTickers.length > 1 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <SectionLabel as="span" className="text-[11px] shrink-0 pr-1">Symbol</SectionLabel>
                  {uniqueTickers.map((ticker) => {
                    const active = selectedTickers.has(ticker);
                    return (
                      <button
                        key={ticker}
                        onClick={() => toggleTicker(ticker)}
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-mono font-medium transition-colors ${
                          active
                            ? "bg-muted text-foreground border-foreground/30"
                            : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                        }`}
                      >
                        {ticker}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Type filter */}
              <div className="flex items-center gap-2 flex-wrap">
                <SectionLabel as="span" className="text-[11px] shrink-0 pr-1">Type</SectionLabel>
                {(["PURCHASE", "SALE", "DIVIDEND", "TRANSFER"] as const).filter(t => presentTypes.has(t)).map((type) => {
                  const active = selectedTypes.has(type);
                  const colorClass = type === "PURCHASE"
                    ? active ? "bg-up-soft text-up-deep border-up-line" : "border-border text-muted-foreground hover:border-up-line hover:text-up-deep"
                    : type === "SALE"
                    ? active ? "bg-blue-100 text-blue-700 border-blue-300" : "border-border text-muted-foreground hover:border-blue-300 hover:text-blue-700"
                    : type === "TRANSFER"
                    ? active ? "bg-warn-soft text-warn-deep border-warn-line" : "border-border text-muted-foreground hover:border-warn-line hover:text-warn-deep"
                    : active ? "bg-violet-soft text-violet-deep border-violet-soft" : "border-border text-muted-foreground hover:border-violet-soft hover:text-violet-deep";
                  const label = type === "PURCHASE" ? "Purchase" : type === "SALE" ? "Sale" : type === "TRANSFER" ? "Transfer" : "Dividend";
                  return (
                    <button
                      key={type}
                      onClick={() => toggleType(type)}
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${colorClass}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-13" style={{ tableLayout: "fixed", minWidth: "900px" }}>
              <thead>
                <tr className="text-[11px] text-muted-foreground uppercase tracking-[1px] font-mono bg-muted/30 border-b border-border">
                  <th style={{ width: "110px" }} className="py-2 pl-4 pr-2 text-left font-medium">Date</th>
                  <th style={{ width: "90px" }} className="py-2 px-2 text-left font-medium">Type</th>
                  <th style={{ width: "80px" }} className="py-2 px-2 text-left font-medium">Symbol</th>
                  <th style={{ width: "110px" }} className="py-2 px-2 text-right font-medium">Shares</th>
                  <th style={{ width: "110px" }} className="py-2 px-2 text-right font-medium">Price/Share</th>
                  <th style={{ width: "120px" }} className="py-2 px-2 text-right font-medium">Gross</th>
                  <th style={{ width: "90px" }} className="py-2 px-2 text-right font-medium">Fees</th>
                  <th style={{ width: "120px" }} className="py-2 px-2 text-right font-medium">Net</th>
                  <th className="py-2 px-2 text-right font-medium">Gain / Loss</th>
                  <th style={{ width: "120px" }} className="py-2 px-2 text-left font-medium">Notes</th>
                  <th style={{ width: "40px" }} className="py-2 pl-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {filteredActivities.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-8 text-center text-sm text-muted-foreground">
                      No activity matches the current filters.
                    </td>
                  </tr>
                ) : filteredActivities.map((a) => {
                  const fees = a.fees ?? 0;
                  const net = a.amount - fees;
                  const gain = (a.shortTermGain ?? 0) + (a.longTermGain ?? 0);
                  const isGainPositive = gain >= 0;
                  const isPurchase = a.type === "PURCHASE";
                  const isSale = a.type === "SALE";
                  const isTransfer = a.type === "TRANSFER";

                  const badgeClass = isSale
                    ? "bg-blue-100 text-blue-700"
                    : isPurchase
                    ? "bg-up-soft text-up-deep"
                    : isTransfer
                    ? "bg-warn-soft text-warn-deep"
                    : "bg-violet-soft text-violet-deep";
                  const badgeLabel = isSale ? "Sale" : isPurchase ? "Purchase" : isTransfer ? "Transfer" : "Dividend";

                  return (
                    <tr key={a.id} className="border-b border-border hover:bg-muted/20 group">
                      <td className="py-3 pl-4 pr-2 tabular-nums font-mono">{formatDate(a.date)}</td>
                      <td className="py-3 px-2">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${badgeClass}`}>
                          {badgeLabel}
                        </span>
                      </td>
                      <td className="py-3 px-2 font-mono font-bold text-xs">{a.ticker}</td>
                      <td className="py-3 px-2 text-right tabular-nums font-mono">
                        {a.shares != null
                          ? a.shares.toLocaleString(undefined, { maximumFractionDigits: 8 })
                          : "—"}
                      </td>
                      <td className="py-3 px-2 text-right tabular-nums font-mono">
                        {a.pricePerShare != null ? formatCurrency(a.pricePerShare) : "—"}
                      </td>
                      {/* Gross / total cost */}
                      <td className="py-3 px-2 text-right tabular-nums font-mono">{formatCurrency(a.amount)}</td>
                      {/* Fees — not applicable for purchases */}
                      <td className="py-3 px-2 text-right tabular-nums font-mono text-muted-foreground">
                        {!isPurchase && fees > 0 ? `(${formatCurrency(fees)})` : "—"}
                      </td>
                      {/* Net proceeds — show for sales; show cost for purchases */}
                      <td className="py-3 px-2 text-right tabular-nums font-mono font-medium">
                        {isPurchase ? formatCurrency(a.amount) : formatCurrency(net)}
                      </td>
                      {/* Gain / loss — only for sales */}
                      <td className={`py-3 px-2 text-right tabular-nums font-mono font-medium ${
                        isSale
                          ? isGainPositive
                            ? "text-up"
                            : "text-down"
                          : "text-muted-foreground"
                      }`}>
                        {isSale
                          ? `${isGainPositive ? "+" : ""}${formatCurrency(gain)}`
                          : "—"}
                      </td>
                      <td className="py-3 px-2 text-muted-foreground truncate">
                        {a.notes ?? ""}
                      </td>
                      <td className="py-3 pl-2 pr-4 text-right">
                        {(isSale || (!isSale && !isPurchase && !isTransfer)) && (
                          <button
                            onClick={() => isSale
                              ? setEditingActivity(a)
                              : setEditingDividendActivityId(a.id)
                            }
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                            title={isSale ? "Edit sale" : "Edit dividend"}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editingActivity && (
        <EditSaleActivityModal
          activity={editingActivity}
          onClose={() => setEditingActivity(null)}
          onSaved={() => {
            setEditingActivity(null);
            refetchActivities();
          }}
        />
      )}

      {editingDividendActivityId && (
        <EditConfirmedDividendModal
          activityId={editingDividendActivityId}
          onClose={() => setEditingDividendActivityId(null)}
          onSaved={() => {
            setEditingDividendActivityId(null);
            refetchActivities();
          }}
        />
      )}

      {reviewingDividend && (
        <ReviewDividendModal
          dividend={reviewingDividend}
          categories={allCategories ?? []}
          onClose={() => setReviewingDividend(null)}
          onConfirmed={(wasReinvest?: boolean) => {
            setReviewingDividend(null);
            refetchDividends();
            refetchActivities();
            refetchNotifications();
            if (wasReinvest) onHoldingsChanged?.();
          }}
          onDismissed={() => {
            setReviewingDividend(null);
            refetchDividends();
            refetchNotifications();
          }}
        />
      )}

      {reviewingBuy && (
        <PendingBuyModal
          pendingBuy={reviewingBuy}
          onClose={() => setReviewingBuy(null)}
          onSaved={() => {
            setReviewingBuy(null);
            refetchBuys();
            refetchActivities();
            refetchNotifications();
            onHoldingsChanged?.();
            onAccountChanged?.();
          }}
        />
      )}
      {reviewingSale && (
        <PendingSaleModal
          pendingSale={reviewingSale}
          accounts={accounts}
          onClose={() => setReviewingSale(null)}
          onSaved={() => {
            setReviewingSale(null);
            refetchSales();
            refetchActivities();
            refetchNotifications();
            onHoldingsChanged?.();
            onAccountChanged?.();
          }}
        />
      )}
    </>
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
        longTermGain: form.longTermGain !== "" ? parseFloat(form.longTermGain.replace(/,/g, "")) : null,
        shortTermGain: form.shortTermGain !== "" ? parseFloat(form.shortTermGain.replace(/,/g, "")) : null,
        longTermLoss: form.longTermLoss !== "" ? parseFloat(form.longTermLoss.replace(/,/g, "")) : null,
        shortTermLoss: form.shortTermLoss !== "" ? parseFloat(form.shortTermLoss.replace(/,/g, "")) : null,
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
            <table className="w-full max-w-sm text-13">
              <thead>
                <tr className="text-[11px] text-muted-foreground uppercase tracking-[1px] font-mono">
                  <th className="text-left font-medium pb-1.5 pr-8" />
                  <th className="text-right font-medium pb-1.5 pr-6">Long-Term</th>
                  <th className="text-right font-medium pb-1.5">Short-Term</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <td className="py-1.5 pr-8 text-muted-foreground">Gains</td>
                  <td className="py-1.5 pr-6 text-right tabular-nums font-mono text-up font-medium">
                    {snapshot.longTermGain != null ? formatCurrency(snapshot.longTermGain) : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums font-mono text-up font-medium">
                    {snapshot.shortTermGain != null ? formatCurrency(snapshot.shortTermGain) : "—"}
                  </td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-8 text-muted-foreground">Losses</td>
                  <td className="py-1.5 pr-6 text-right tabular-nums font-mono text-down font-medium">
                    {snapshot.longTermLoss != null ? formatCurrency(snapshot.longTermLoss) : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums font-mono text-down font-medium">
                    {snapshot.shortTermLoss != null ? formatCurrency(snapshot.shortTermLoss) : "—"}
                  </td>
                </tr>
                <tr className="font-semibold">
                  <td className="py-1.5 pr-8">Net</td>
                  <td className={`py-1.5 pr-6 text-right tabular-nums font-mono ${netLT >= 0 ? "text-up" : "text-down"}`}>
                    {netLT >= 0 ? "+" : "−"}{formatCurrency(Math.abs(netLT))}
                  </td>
                  <td className={`py-1.5 text-right tabular-nums font-mono ${netST >= 0 ? "text-up" : "text-down"}`}>
                    {netST >= 0 ? "+" : "−"}{formatCurrency(Math.abs(netST))}
                  </td>
                </tr>
              </tbody>
            </table>
            {snapshot.notes && (
              <p className="tp-caption italic">{snapshot.notes}</p>
            )}
            <div className="flex items-center gap-4 pt-1">
              <button onClick={startEdit} className="flex items-center gap-1 text-xs text-primary hover:underline">
                <Pencil className="h-3 w-3" /> Edit
              </button>
              {!showDeleteConfirm ? (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center gap-1 tp-caption hover:text-down transition-colors"
                >
                  <Trash2 className="h-3 w-3" /> Clear
                </button>
              ) : (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Clear this snapshot?</span>
                  <button onClick={handleDelete} disabled={deleting} className="text-down hover:underline font-medium">
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
      <p className="tp-caption">
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
            <label className="block text-xs font-medium mb-1">{label}</label>
            <DollarInput
              value={form[key as keyof typeof form]}
              onChange={(v) => setForm((prev) => ({ ...prev, [key]: v }))}
              placeholder="0.00"
            />
          </div>
        ))}
      </div>
      <div className="max-w-sm">
        <label className="block text-xs font-medium mb-1">Notes <span className="font-normal text-muted-foreground">(optional)</span></label>
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

// ── QFX Import Panel ──────────────────────────────────────────────────────────

interface QfxParsedSummary {
  transactions: import("@/types").QfxTransactionInput[];
  dividends: import("@/types").QfxDividendInput[];
  cashBalance: number | null;
  tickers: string[];
  netShares: Record<string, number>;
  buyCount: number;
  sellCount: number;
  reinvestCount: number;
  splitCount: number;
  transferCount: number;
  dividendCount: number;
}

function parseQfxDate(dtStr: string): string {
  const clean = dtStr.replace(/\..+$/, "").replace(/\[.+$/, "");
  return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
}

function parseQfxFile(content: string): QfxParsedSummary {
  const xmlStart = content.indexOf("<OFX>");
  if (xmlStart === -1) throw new Error("Could not find <OFX> section in file");
  const doc = new DOMParser().parseFromString(content.slice(xmlStart), "text/xml");
  const parseErr = doc.querySelector("parsererror");
  if (parseErr) throw new Error("File is not valid XML: " + parseErr.textContent?.slice(0, 100));

  // Build CUSIP → ticker map; identify money market fund tickers
  const cusipToTicker = new Map<string, string>();
  const mmTickers = new Set<string>();
  for (const info of Array.from(doc.querySelectorAll("STOCKINFO, MFINFO"))) {
    const cusip = info.querySelector("UNIQUEID")?.textContent?.trim();
    const ticker = info.querySelector("TICKER")?.textContent?.trim();
    if (cusip && ticker) {
      cusipToTicker.set(cusip, ticker);
      if (info.tagName === "MFINFO") mmTickers.add(ticker);
    }
  }

  function getTicker(el: Element): string | null {
    const cusip = el.querySelector("SECID > UNIQUEID")?.textContent?.trim();
    return cusip ? (cusipToTicker.get(cusip) ?? null) : null;
  }
  function txt(el: Element, tag: string): string {
    return el.querySelector(tag)?.textContent?.trim() ?? "";
  }

  const transactions: import("@/types").QfxTransactionInput[] = [];
  let splitCount = 0;
  let transferCount = 0;

  // BUYSTOCK / BUYMF
  for (const el of Array.from(doc.querySelectorAll("BUYSTOCK, BUYMF"))) {
    const inner = el.querySelector("INVBUY")!;
    const ticker = getTicker(inner);
    if (!ticker) continue;
    const units = parseFloat(txt(inner, "UNITS"));
    const unitPrice = parseFloat(txt(inner, "UNITPRICE"));
    const total = parseFloat(txt(inner, "TOTAL"));
    // Skip money market fund purchases (treated as cash)
    if (mmTickers.has(ticker) && Math.abs(unitPrice - 1.0) < 0.02) continue;
    transactions.push({
      fitId: txt(inner, "FITID"),
      ticker,
      type: "BUY",
      date: parseQfxDate(txt(inner, "DTTRADE")),
      shares: Math.abs(units),
      pricePerShare: unitPrice,
      total,
    });
  }

  // SELLSTOCK / SELLMF
  for (const el of Array.from(doc.querySelectorAll("SELLSTOCK, SELLMF"))) {
    const inner = el.querySelector("INVSELL")!;
    const ticker = getTicker(inner);
    if (!ticker) continue;
    const units = parseFloat(txt(inner, "UNITS"));
    const unitPrice = parseFloat(txt(inner, "UNITPRICE"));
    const total = parseFloat(txt(inner, "TOTAL"));
    // Skip money market fund sales (treated as cash)
    if (mmTickers.has(ticker) && Math.abs(unitPrice - 1.0) < 0.02) continue;
    transactions.push({
      fitId: txt(inner, "FITID"),
      ticker,
      type: "SELL",
      date: parseQfxDate(txt(inner, "DTTRADE")),
      shares: Math.abs(units),
      pricePerShare: Math.abs(unitPrice),
      total,
    });
  }

  // REINVEST (dividend reinvestment — creates new shares)
  for (const el of Array.from(doc.querySelectorAll("REINVEST"))) {
    const ticker = getTicker(el);
    if (!ticker) continue;
    const units = parseFloat(txt(el, "UNITS"));
    const unitPrice = parseFloat(txt(el, "UNITPRICE"));
    const total = parseFloat(txt(el, "TOTAL"));
    transactions.push({
      fitId: txt(el, "FITID"),
      ticker,
      type: "REINVEST",
      date: parseQfxDate(txt(el, "DTTRADE")),
      shares: Math.abs(units),
      pricePerShare: Math.abs(unitPrice),
      total,
    });
  }

  // SPLIT — treated as a share grant (BUY at $0 cost so share count is correct).
  // NEWUNITS is the total shares after the split; OLDUNITS is the total before.
  // The net new shares added = NEWUNITS - OLDUNITS.
  for (const el of Array.from(doc.querySelectorAll("SPLIT"))) {
    const inner = el.querySelector("INVTRAN");
    const ticker = getTicker(el);
    if (!ticker || !inner) continue;
    const newUnits = parseFloat(txt(el, "NEWUNITS"));
    const oldUnits = parseFloat(txt(el, "OLDUNITS")) || 0;
    const deltaUnits = newUnits - oldUnits;
    if (isNaN(deltaUnits) || deltaUnits <= 0) continue;
    splitCount++;
    transactions.push({
      fitId: txt(inner, "FITID"),
      ticker,
      type: "BUY",
      date: parseQfxDate(txt(inner, "DTTRADE")),
      shares: deltaUnits,
      pricePerShare: 0,
      total: 0,
    });
  }

  // TRANSFER (shares transferred in/out of the account, e.g. ACATS)
  // Use the sign of UNITS as the source of truth for direction — TFERACTION can be IN
  // even when UNITS is negative (e.g. POSTYPE=SHORT records that reduce net shares).
  for (const el of Array.from(doc.querySelectorAll("TRANSFER"))) {
    const inner = el.querySelector("INVTRAN")!;
    const ticker = getTicker(el);
    if (!ticker) continue;
    const units = parseFloat(txt(el, "UNITS"));
    const avgCost = parseFloat(txt(el, "AVGCOSTBASIS"));
    if (isNaN(units) || units === 0) continue;
    // Skip money market fund transfers (treated as cash)
    if (mmTickers.has(ticker)) continue;
    const absUnits = Math.abs(units);
    const price = isNaN(avgCost) ? 0 : Math.abs(avgCost);
    transferCount++;
    transactions.push({
      fitId: txt(inner, "FITID"),
      ticker,
      type: units < 0 ? "SELL" : "BUY",
      date: parseQfxDate(txt(inner, "DTTRADE")),
      shares: absUnits,
      pricePerShare: price,
      total: absUnits * price,
    });
  }

  // Derive cash balance from INVPOS snapshot (most accurate — avoids running total drift)
  let cashBalance: number | null = null;
  for (const pos of Array.from(doc.querySelectorAll("INVPOS"))) {
    const cusip = pos.querySelector("SECID > UNIQUEID")?.textContent?.trim();
    const ticker = cusip ? cusipToTicker.get(cusip) : null;
    if (!ticker || !mmTickers.has(ticker)) continue;
    const units = parseFloat(txt(pos, "UNITS"));
    const unitPrice = parseFloat(txt(pos, "UNITPRICE"));
    if (!isNaN(units) && !isNaN(unitPrice) && Math.abs(unitPrice - 1.0) < 0.02) {
      cashBalance = Math.round(units * unitPrice * 100) / 100;
    }
  }

  // Extract INCOME records (dividend payments)
  const dividends: import("@/types").QfxDividendInput[] = [];
  for (const el of Array.from(doc.querySelectorAll("INCOME"))) {
    const cusip = el.querySelector("SECID > UNIQUEID")?.textContent?.trim();
    const ticker = cusip ? cusipToTicker.get(cusip) : null;
    if (!ticker) continue;
    const fitId = txt(el, "FITID");
    const dtTrade = txt(el, "DTTRADE");
    const total = parseFloat(txt(el, "TOTAL"));
    if (!fitId || !dtTrade || isNaN(total) || total <= 0) continue;
    dividends.push({
      fitId,
      ticker,
      date: parseQfxDate(dtTrade),
      total,
    });
  }

  const tickers = [...new Set(transactions.map((t) => t.ticker))].sort();

  // Forward-accumulate net shares per ticker (what the growth chart will use)
  const netShares: Record<string, number> = {};
  for (const t of transactions) {
    netShares[t.ticker] = (netShares[t.ticker] ?? 0) + (t.type === "SELL" ? -t.shares : t.shares);
  }

  return {
    transactions,
    dividends,
    cashBalance,
    tickers,
    netShares,
    buyCount: transactions.filter((t) => t.type === "BUY").length - transferCount,
    sellCount: transactions.filter((t) => t.type === "SELL").length,
    reinvestCount: transactions.filter((t) => t.type === "REINVEST").length,
    splitCount,
    transferCount,
    dividendCount: dividends.length,
  };
}

function QfxImportPanel({ accountId, onImported }: { accountId: string; onImported: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<QfxParsedSummary | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; total: number; dividendsImported: number; dividendsSkipped: number } | null>(null);
  const [importDividends, setImportDividends] = useState(true);
  const [dividendStartDate, setDividendStartDate] = useState(`${new Date().getFullYear()}-01-01`);
  const { data: lastDateData, refetch: refetchLastDate } = useApi(() => getQfxLastDate(accountId), [accountId]);
  const filteredDividends = parsed && importDividends
    ? parsed.dividends.filter((d) => d.date >= dividendStartDate)
    : [];

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsed(null);
    setParseError(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const content = evt.target?.result as string;
        setParsed(parseQfxFile(content));
      } catch (err) {
        setParseError(err instanceof Error ? err.message : "Failed to parse file");
      }
    };
    reader.readAsText(file);
    // Reset so the same file can be re-selected
    e.target.value = "";
  }

  async function handleImport() {
    if (!parsed) return;
    setImporting(true);
    try {
      const [txnRes, divRes] = await Promise.all([
        importQfx(accountId, parsed.transactions, parsed.cashBalance),
        filteredDividends.length > 0
          ? importQfxDividends(accountId, filteredDividends)
          : Promise.resolve({ imported: 0, skipped: 0 }),
      ]);
      setResult({ ...txnRes, dividendsImported: divRes.imported, dividendsSkipped: divRes.skipped });
      setParsed(null);
      refetchLastDate();
      onImported();
      const parts = [];
      if (txnRes.imported > 0) parts.push(`${txnRes.imported} transaction${txnRes.imported !== 1 ? "s" : ""}`);
      if (divRes.imported > 0) parts.push(`${divRes.imported} dividend${divRes.imported !== 1 ? "s" : ""}`);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="px-4 py-4 space-y-3">
      <input
        ref={fileInputRef}
        type="file"
        accept=".qfx,.ofx"
        className="hidden"
        onChange={handleFileChange}
      />

      {!parsed && !result && (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            className="h-8 text-xs px-3 gap-1.5"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" />
            Select QFX file
          </Button>
          <div className="tp-caption">
            <span>Export from Wealthfront → Documents → Export to Quicken</span>
            {lastDateData?.lastDate && (
              <span className="ml-3 text-foreground/60">
                · Last transaction: <span className="font-medium">{formatDate(lastDateData.lastDate)}</span>
              </span>
            )}
          </div>
        </div>
      )}

      {parseError && (
        <div className="flex items-center gap-2 text-xs text-down">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {parseError}
        </div>
      )}

      {parsed && (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs space-y-2">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
              <span className="font-medium text-foreground">Ready to import</span>
              <span>{parsed.buyCount} buy{parsed.buyCount !== 1 ? "s" : ""}</span>
              <span>{parsed.sellCount} sell{parsed.sellCount !== 1 ? "s" : ""}</span>
              <span>{parsed.reinvestCount} reinvestment{parsed.reinvestCount !== 1 ? "s" : ""}</span>
              {parsed.splitCount > 0 && <span>{parsed.splitCount} split{parsed.splitCount !== 1 ? "s" : ""}</span>}
              {parsed.transferCount > 0 && <span>{parsed.transferCount} transfer{parsed.transferCount !== 1 ? "s" : ""}</span>}
              {parsed.dividendCount > 0 && (
                <span>
                  {importDividends ? filteredDividends.length : 0}/{parsed.dividendCount} dividend{parsed.dividendCount !== 1 ? "s" : ""}
                </span>
              )}
              {parsed.cashBalance != null && <span>Cash balance: {formatCurrency(parsed.cashBalance)}</span>}
            </div>
            {/* Per-ticker net share table */}
            <div className="grid gap-x-6 gap-y-0.5 pt-0.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
              {parsed.tickers.map((ticker) => {
                const shares = parsed.netShares[ticker] ?? 0;
                return (
                  <div key={ticker} className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[11px] text-foreground">{ticker}</span>
                    <StatValue className="text-muted-foreground">
                      {shares.toLocaleString(undefined, { maximumFractionDigits: 8 })} sh
                    </StatValue>
                  </div>
                );
              })}
            </div>
          </div>
          {parsed.dividendCount > 0 && (
            <div className="flex items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={importDividends}
                  onChange={(e) => setImportDividends(e.target.checked)}
                  className="h-3.5 w-3.5 rounded accent-primary"
                />
                <span className="text-foreground">Import dividends</span>
              </label>
              {importDividends && (
                <label className="flex items-center gap-1.5 text-muted-foreground">
                  Starting
                  <input
                    type="date"
                    value={dividendStartDate}
                    onChange={(e) => setDividendStartDate(e.target.value)}
                    className="h-6 rounded border border-border bg-background px-1.5 text-xs text-foreground"
                  />
                </label>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              className="h-8 text-xs px-3"
              disabled={importing}
              onClick={handleImport}
            >
              {importing ? "Importing…" : "Confirm import"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="h-8 text-xs px-3"
              onClick={() => { setParsed(null); setParseError(null); }}
            >
              Cancel
            </Button>
            <p className="tp-caption">
              {parsed.transactions.length} total transactions · duplicate FITIDs will be skipped
            </p>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-up-deep">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>
              {result.imported} new transaction{result.imported !== 1 ? "s" : ""}
              {result.dividendsImported > 0 && `, ${result.dividendsImported} dividend${result.dividendsImported !== 1 ? "s" : ""}`}
              {" "}imported
              {(result.total - result.imported) > 0 && ` · ${result.total - result.imported} transaction${result.total - result.imported !== 1 ? "s" : ""} already existed`}
              {result.dividendsSkipped > 0 && ` · ${result.dividendsSkipped} dividend${result.dividendsSkipped !== 1 ? "s" : ""} already existed`}
            </span>
          </div>
          <Button
            type="button"
            variant="secondary"
            className="h-8 text-xs px-3 gap-1.5"
            onClick={() => { setResult(null); fileInputRef.current?.click(); }}
          >
            <Upload className="h-3.5 w-3.5" />
            Import another file
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

// ── Growth chart ──────────────────────────────────────────────────────────────

function formatAxisDate(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type ChartDuration = "WTD" | "MTD" | "YTD";

function durationStartDate(duration: ChartDuration): string {
  const now = new Date();
  if (duration === "WTD") {
    const diff = (now.getDay() + 6) % 7; // days since Monday
    const monday = new Date(now);
    monday.setDate(now.getDate() - diff);
    return monday.toLocaleDateString("en-CA");
  } else if (duration === "MTD") {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  } else {
    return `${now.getFullYear()}-01-01`;
  }
}

function easternTZAbbr(dateStr: string): string {
  try {
    // Use the browser's IANA timezone database — always returns "EST" or "EDT" correctly
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "short",
    }).formatToParts(new Date(dateStr + "T17:00:00Z")); // ~noon Eastern; avoids DST boundary
    return parts.find(p => p.type === "timeZoneName")?.value ?? "ET";
  } catch {
    return "ET";
  }
}

function eventDotColor(events: GrowthEvent[]) {
  const hasBuy = events.some((e) => e.type === "BUY");
  const hasSell = events.some((e) => e.type === "SELL");
  if (hasBuy && hasSell) return "#6366f1"; // indigo — mixed date
  if (hasSell) return "#f59e0b";           // amber — sell
  return "#22c55e";                        // green — buy
}

function GhostGrowthChart() {
  return (
    <div className="select-none">
      <div className="flex gap-1 mb-3">
        {["WTD", "MTD", "YTD"].map((d) => (
          <span key={d} className="px-2 py-0.5 rounded text-xs font-medium text-muted-foreground/30">{d}</span>
        ))}
      </div>
      <div className="relative h-[168px] overflow-hidden">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full opacity-[0.15]"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="ghost-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.6} />
              <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path
            d="M 0,75 C 8,70 12,60 20,55 C 28,50 32,65 42,52 C 52,39 56,48 68,32 C 78,18 88,22 100,12 L 100,100 L 0,100 Z"
            fill="url(#ghost-grad)"
          />
          <path
            d="M 0,75 C 8,70 12,60 20,55 C 28,50 32,65 42,52 C 52,39 56,48 68,32 C 78,18 88,22 100,12"
            fill="none"
            stroke="#4f46e5"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-muted-foreground text-center px-6">
            No data yet. Add dated lots to track growth over time.
          </p>
        </div>
      </div>
    </div>
  );
}

function GrowthChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as GrowthPoint;
  const hasCostBasis = d.costBasis != null && d.unrealizedGain != null;
  const pos = hasCostBasis ? d.unrealizedGain! >= 0 : true;
  return (
    <div className="rounded-lg border border-border bg-background shadow-md px-3 py-2 text-xs space-y-1 min-w-[210px]">
      <p className="font-semibold text-foreground mb-1">{formatAxisDate(label)}</p>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Market value</span>
        <StatValue className="font-medium">{formatCurrency(d.marketValue)}</StatValue>
      </div>
      {hasCostBasis && (
        <>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Cost basis</span>
            <StatValue className="font-medium">{formatCurrency(d.costBasis!)}</StatValue>
          </div>
          <div className="flex justify-between gap-4 pt-1 border-t border-border">
            <span className="text-muted-foreground">Unrealized gain</span>
            <span className={`font-medium tabular-nums font-mono ${pos ? "text-up" : "text-down"}`}>
              {pos ? "+" : ""}{formatCurrency(d.unrealizedGain!)} ({pos ? "+" : ""}{d.unrealizedGainPct!.toFixed(2)}%)
            </span>
          </div>
        </>
      )}
      {d.events?.length ? (() => {
        // Roll up multiple transactions on the same day into one row per ticker+type
        const rolled = new Map<string, { type: string; ticker: string; shares: number; netAmount: number }>();
        for (const ev of d.events) {
          const key = `${ev.type}:${ev.ticker}`;
          const existing = rolled.get(key);
          if (existing) {
            existing.shares += ev.shares;
            existing.netAmount += ev.netAmount;
          } else {
            rolled.set(key, { ...ev });
          }
        }
        return (
          <div className="pt-1 border-t border-border space-y-0.5">
            {[...rolled.values()].map((ev, i) => {
              const isSell = ev.type === "SELL";
              const sharesStr = ev.shares.toLocaleString(undefined, { maximumFractionDigits: 4 });
              return (
                <div key={i} className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {isSell ? "Sold" : "Bought"} {sharesStr} {ev.ticker}
                  </span>
                  <span className={`font-medium tabular-nums font-mono ${isSell ? "text-warn" : "text-up"}`}>
                    {isSell ? "-" : "+"}{formatCurrency(ev.netAmount)}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })() : null}
    </div>
  );
}

// Defined outside GrowthChart so the component reference is stable (no remount churn).
// Captures the bottom panel's active tooltip state via useEffect to avoid setState-during-render,
// then renders nothing — the actual tooltip is drawn as an overlay on the top panel.

function GrowthChart({ accountId, isManaged, onImportClick, onDayGain }: { accountId: string; isManaged?: boolean; onImportClick?: () => void; onDayGain?: (gain: number | null) => void }) {
  const [duration, setDuration] = useState<ChartDuration>("YTD");
  const { data, loading, error } = useApi(() => getInvestmentGrowth(accountId), [accountId]);
  const { isDemoMode, demoFactor } = useDemo();
  const rawPoints = data?.points ?? [];
  const allPoints = useMemo(
    () => isDemoMode ? scaleGrowthPoints(rawPoints, demoFactor) : rawPoints,
    [rawPoints, isDemoMode, demoFactor]
  );

  // Filter to the selected duration window
  const points = useMemo(() => {
    if (!allPoints.length) return allPoints;
    const start = durationStartDate(duration);
    const idx = allPoints.findIndex(p => p.date >= start);
    if (idx === -1) return [];
    if (idx === 0) return allPoints;
    return allPoints.slice(idx);
  }, [allPoints, duration]);

  // Notify parent of day-over-day gain (always from full dataset's last two points)
  useEffect(() => {
    if (!onDayGain) return;
    const gain = allPoints.length >= 2
      ? allPoints[allPoints.length - 1].marketValue - allPoints[allPoints.length - 2].marketValue
      : null;
    onDayGain(gain);
  }, [allPoints, onDayGain]);

  // Period gain over the selected duration
  const periodGain = points.length >= 2
    ? points[points.length - 1].marketValue - points[0].marketValue
    : null;
  const periodGainPct = periodGain != null && points[0]?.marketValue > 0
    ? (periodGain / points[0].marketValue) * 100
    : null;

  const header = (
    <div className="flex items-center justify-between mb-3">
      <div className="flex gap-1">
        {(["WTD", "MTD", "YTD"] as ChartDuration[]).map(d => (
          <button
            key={d}
            onClick={() => setDuration(d)}
            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
              d === duration
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {d}
          </button>
        ))}
      </div>
      {periodGain != null && (
        <div className={`text-right tp-numeric font-semibold ${periodGain >= 0 ? "text-up" : "text-down"}`}>
          <div>{periodGain >= 0 ? "+" : "−"}{formatCurrency(Math.abs(periodGain))}
            {periodGainPct != null && (
              <span className="text-xs ml-1 opacity-70">({Math.abs(periodGainPct).toFixed(2)}%)</span>
            )}
          </div>
          {points[0] && (
            <div className="text-[11px] font-normal text-muted-foreground">since {formatDate(points[0].date)}</div>
          )}
        </div>
      )}
    </div>
  );

  if (loading) {
    return (
      <>
        {header}
        <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">Loading growth data…</div>
      </>
    );
  }

  if (error) {
    return (
      <>
        {header}
        <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground text-center px-4">
          Failed to load growth data.
        </div>
      </>
    );
  }

  if (allPoints.length === 0) {
    if (isManaged) {
      return (
        <>
          {header}
          <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground text-center px-4">
            <span>{"No transaction history yet. "}{onImportClick
                ? <button onClick={onImportClick} className="text-primary underline underline-offset-2 hover:no-underline">Import a QFX file</button>
                : "Import a QFX file"
              }{" to enable the growth chart."}</span>
          </div>
        </>
      );
    }
    return <GhostGrowthChart />;
  }

  if (points.length === 0) {
    return (
      <>
        {header}
        <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground text-center px-4">
          No data for this period.
        </div>
      </>
    );
  }

  const tickEvery = Math.max(1, Math.floor(points.length / 6));
  const ticks = points.filter((_, i) => i % tickEvery === 0 || i === points.length - 1).map(p => p.date);

  const hasCostBasis = !isManaged && points.some(p => p.costBasis != null);

  const mvMin = Math.min(...points.map(p => p.marketValue));
  const mvMax = Math.max(...points.map(p => p.marketValue));
  const mvPad = Math.max((mvMax - mvMin) * 0.08, 100);
  const cbMin = hasCostBasis ? Math.min(...points.map(p => p.costBasis ?? 0)) : 0;
  const cbMax = hasCostBasis ? Math.max(...points.map(p => p.costBasis ?? 0)) : 0;
  const cbPad = Math.max((cbMax - cbMin) * 0.08, 100);

  // Shared axis config
  const MARGIN_TOP = { top: 4, right: 8, bottom: 0, left: 8 };
  const MARGIN_BTM = { top: 0, right: 8, bottom: 0, left: 8 };
  const Y_WIDTH = 52;
  const yAxisProps = { tick: { fontSize: 11 }, axisLine: false, tickLine: false, width: Y_WIDTH,
    tickFormatter: (v: number) => `$${(v / 1000).toFixed(0)}k` };

  const legend = (
    <div className="flex items-center gap-4 mt-2 tp-caption">
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-6 h-0.5 bg-indigo-600" />
        Market value
      </span>
      {hasCostBasis && (
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 border-t border-dashed border-slate-400" />
          Cost basis
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-up" />
        Buy
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-warn" />
        Sell
      </span>
    </div>
  );

  const gradDefs = (
    <defs>
      <linearGradient id="growthGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.18} />
        <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
      </linearGradient>
    </defs>
  );

  const mvDots = (props: any) => {
    const events: GrowthEvent[] | undefined = props.payload?.events;
    if (!events?.length) return <g key={props.key} />;
    return (
      <circle key={props.key} cx={props.cx} cy={props.cy} r={5}
        fill={eventDotColor(events)} stroke="white" strokeWidth={1.5} />
    );
  };

  return (
    <>
      {header}

      {/* Top panel — market value, tight domain. z-10 ensures its tooltip floats above the bottom panel. */}
      <div className="relative z-10">
      <ResponsiveContainer width="100%" height={hasCostBasis ? 130 : 168}>
        <ComposedChart data={points} margin={MARGIN_TOP} syncId="growth">
          {gradDefs}
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="date" hide />
          <YAxis {...yAxisProps} domain={[mvMin - mvPad, mvMax + mvPad]} />
          <RechartsTooltip content={<GrowthChartTooltip />} cursor={{ stroke: "#e2e8f0", strokeWidth: 1 }} />
          <Area type="monotone" dataKey="marketValue" stroke="#4f46e5" strokeWidth={2}
            fill="url(#growthGradient)" dot={mvDots} activeDot={{ r: 4, fill: "#4f46e5" }} />
        </ComposedChart>
      </ResponsiveContainer>
      </div>

      {hasCostBasis && (
        <>
          {/* Scale break indicator — two dashed lines offset from the Y-axis */}
          <div className="flex flex-col gap-[5px] my-[3px]" style={{ paddingLeft: Y_WIDTH + MARGIN_TOP.left, paddingRight: MARGIN_TOP.right }}>
            <div className="border-t border-dashed border-border" />
            <div className="border-t border-dashed border-border" />
          </div>

          {/* Bottom panel — cost basis, tight domain */}
          <ResponsiveContainer width="100%" height={80}>
            <ComposedChart data={points} margin={MARGIN_BTM} syncId="growth">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="date" ticks={ticks} tickFormatter={formatAxisDate}
                tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis {...yAxisProps} domain={[cbMin - cbPad, cbMax + cbPad]} />
              <RechartsTooltip cursor={{ stroke: "#e2e8f0", strokeWidth: 1 }} content={() => null} />
              <Line type="monotone" dataKey="costBasis" stroke="#94a3b8"
                strokeWidth={1.5} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, fill: "#94a3b8" }} />
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}

      {/* X-axis date labels — shown on top panel when cost basis panel is hidden */}
      {!hasCostBasis && (
        <ResponsiveContainer width="100%" height={24}>
          <ComposedChart data={points} margin={MARGIN_BTM} syncId="growth">
            <XAxis dataKey="date" ticks={ticks} tickFormatter={formatAxisDate}
              tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {legend}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function InvestmentAccount() {
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<"holdings" | "activity">(
    searchParams.get("tab") === "activity" ? "activity" : "holdings"
  );
  const { notifications } = useNotifications();
  const hasActivityNotification = notifications?.pendingDividends.some(
    (g) => g.accountId === accountId
  ) ?? false;

  const [modalOpen, setModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [editingManual, setEditingManual] = useState<ManualInvestment | undefined>(undefined);
  const [sellModalHolding, setSellModalHolding] = useState<InvestmentHolding | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const holdingRowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const [stickyHolding, setStickyHolding] = useState<InvestmentHolding | null>(null);
  const [dayGain, setDayGain] = useState<number | null>(null);
  const handleDayGain = useCallback((gain: number | null) => setDayGain(gain), []);
  const [chartKey, setChartKey] = useState(0);
  const refreshChart = useCallback(() => setChartKey((k) => k + 1), []);

  // Cash balance editing
  const [editingCash, setEditingCash] = useState(false);
  const [cashInput, setCashInput] = useState("");
  const [savingCash, setSavingCash] = useState(false);

  const toggleHolding = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [snapshotYear, setSnapshotYear] = useState(new Date().getFullYear());

  const { data: accounts, refetch: refetchAccounts } = useApi(() => getAccounts(), []);
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

  const priceRefreshedRef = useRef(false);
  useEffect(() => {
    if (!holdings || priceRefreshedRef.current) return;
    if (isPriceRefreshNeeded(holdings)) {
      priceRefreshedRef.current = true;
      refreshPrices("InvestmentAccount")
        .then(() => refetch())
        .catch(() => { /* server logs the error */ });
    }
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

  const { isDemoMode, demoFactor } = useDemo();

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

  // manuals must be defined before the early return so holdingGroups can depend on it
  const manuals = useMemo(
    () => [...(manualInvestments ?? [])].sort((a, b) => b.marketValue - a.marketValue),
    [manualInvestments]
  );

  // Scaled versions for display — dollar amounts multiplied by demoFactor when demo mode is on
  const displayHoldings = useMemo(
    () => isDemoMode ? sortedHoldings.map((h) => scaleHolding(h, demoFactor)) : sortedHoldings,
    [sortedHoldings, isDemoMode, demoFactor]
  );
  const displayManuals = useMemo(
    () => isDemoMode ? scaleManuals(manuals, demoFactor) : manuals,
    [manuals, isDemoMode, demoFactor]
  );

  // Build ordered list of groups: each unique group across holdings AND manuals (null → "Other")
  const holdingGroups = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const h of displayHoldings) {
      const key = h.group ?? "";
      if (!seen.has(key)) { seen.add(key); order.push(key); }
    }
    for (const m of displayManuals) {
      const key = m.group ?? "";
      if (!seen.has(key)) { seen.add(key); order.push(key); }
    }
    return order;
  }, [displayHoldings, displayManuals]);

  const account = accounts?.find((a: Account) => a.id === accountId);
  if (!account || !holdings) return <BeaconLoader />;

  const isBanking = account.type === "CHECKING" || account.type === "SAVINGS";
  const isInvestment = account.type === "INVESTMENT";

  const cashBalance = account.cashBalance != null ? parseFloat(account.cashBalance) : null;

  const handleSaveCash = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingCash(true);
    const parsed = parseFloat(cashInput.replace(/,/g, ""));
    const value = cashInput.trim() === "" || isNaN(parsed) ? null : parsed;
    await updateAccount(account.id, { cashBalance: value } as Partial<Account>);
    setSavingCash(false);
    setEditingCash(false);
    refetchAccounts();
  };

  const manualMV = displayManuals.reduce((s, m) => s + m.marketValue, 0);
  const manualCost = displayManuals.reduce((s, m) => s + (m.totalCost ?? 0), 0);
  const manualGain = displayManuals.reduce((s, m) => m.totalCost != null ? s + (m.marketValue - m.totalCost) : s, 0);

  const totalMarketValue = displayHoldings.reduce((s, h) => s + (h.marketValue ?? 0), 0) + manualMV + ((cashBalance ?? 0) * (isDemoMode ? demoFactor : 1));
  const totalCost = displayHoldings.reduce((s, h) => s + h.totalCost, 0) + manualCost;
  const totalGain = displayHoldings.reduce((s, h) => s + (h.totalGain ?? 0), 0) + manualGain;
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;
  const shortTermGain = displayHoldings.reduce((s, h) => s + h.shortTermGain, 0);
  const longTermGain = displayHoldings.reduce((s, h) => s + h.longTermGain, 0);
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
            <h2 className="tp-card-title leading-tight">{account.name}</h2>
            <p className="tp-caption">
              {isBanking
                ? account.type === "CHECKING" ? "Checking Account" : "Savings Account"
                : "Investment Account"}
              {account.isJoint && " · Joint"}
              {account.isManaged && " · Managed"}
            </p>
          </div>
        </div>
      </div>

      {/* Investment: prominent market value + chart + performance summary (shown above tab nav) */}
      {isInvestment && (
        <>
          {/* Prominent market value — only when there's something to total */}
          {(holdings.length > 0 || manuals.length > 0 || cashBalance != null) && (
            <DisplayStat as="p" className="tp-kpi-l">{formatCurrency(totalMarketValue)}</DisplayStat>
          )}

          {/* Chart + summary row */}
          <div className="flex flex-col lg:flex-row items-start gap-6">
            {/* Growth chart — 2/3 width */}
            <div className="min-w-0 basis-2/3 py-2 flex flex-col w-full">
              {(holdings.length > 0 || manuals.length > 0) ? (
                <GrowthChart key={chartKey} accountId={accountId!} isManaged={account.isManaged} onImportClick={account.isManaged ? () => document.getElementById("qfx-import")?.scrollIntoView({ behavior: "smooth" }) : undefined} onDayGain={handleDayGain} />
              ) : (
                <GhostGrowthChart />
              )}
            </div>
            {/* Performance summary — 1/3 width */}
            <Card className="min-w-0 basis-1/3 w-full p-4">
              {(holdings.length > 0 || manuals.length > 0 || cashBalance != null) && (
                <>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <div>
                      <SectionLabel className="mb-1">
                        1 Day {dayGain == null ? "Gain/Loss" : dayGain >= 0 ? "Gain" : "Loss"}
                      </SectionLabel>
                      <GainCell value={dayGain} size="base" />
                    </div>
                    <div>
                      <SectionLabel className="mb-1">
                        Total {totalGain == null ? "Gain/Loss" : totalGain >= 0 ? "Gain" : "Loss"}
                      </SectionLabel>
                      <GainCell value={totalGain} pct={totalGainPct} size="base" />
                    </div>
                    <div>
                      <SectionLabel className="mb-1">
                        Short-Term {shortTermGain == null ? "Gain/Loss" : shortTermGain >= 0 ? "Gain" : "Loss"}
                      </SectionLabel>
                      <GainCell value={shortTermGain} size="base" />
                    </div>
                    <div>
                      <SectionLabel className="mb-1">
                        Long-Term {longTermGain == null ? "Gain/Loss" : longTermGain >= 0 ? "Gain" : "Loss"}
                      </SectionLabel>
                      <GainCell value={longTermGain} size="base" />
                    </div>
                  </div>
                  {priceDate && (
                    <p className="text-[11px] text-muted-foreground pt-3 border-t border-border mt-3">
                      Prices as of {formatDate(priceDate)} at 4:00 PM {easternTZAbbr(priceDate)}
                    </p>
                  )}
                </>
              )}

              {/* Settlement cash — always visible so it's editable on empty accounts */}
              <div className={(holdings.length > 0 || manuals.length > 0 || cashBalance != null) ? "pt-3 border-t border-border mt-3" : ""}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5">
                    <Banknote className="h-3.5 w-3.5 text-muted-foreground" />
                    <SectionLabel>
                      Settlement Cash
                    </SectionLabel>
                  </div>
                  {!editingCash && (
                    <button
                      onClick={() => {
                        setCashInput(cashBalance != null ? String(cashBalance) : "");
                        setEditingCash(true);
                      }}
                      className="rounded p-0.5 hover:bg-accent transition-colors"
                      aria-label="Edit cash balance"
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </button>
                  )}
                </div>
                {editingCash ? (
                  <form onSubmit={handleSaveCash} className="flex items-center gap-1.5 mt-1.5">
                    <div className="relative w-full">
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <input
                        type="text"
                        inputMode="text"
                        value={cashInput}
                        onChange={(e) => setCashInput(e.target.value)}
                        autoFocus
                        placeholder="0.00"
                        className="w-full rounded border border-border pl-5 pr-2 py-1 tp-numeric focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={savingCash}
                      className="rounded p-1.5 hover:bg-accent transition-colors"
                      aria-label="Save"
                    >
                      <Check className="h-3.5 w-3.5 text-up" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingCash(false)}
                      className="rounded p-1.5 text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"
                      aria-label="Cancel"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </form>
                ) : cashBalance != null ? (
                  <div>
                    <DisplayStat as="p" className="tp-stat">{formatCurrency(cashBalance)}</DisplayStat>
                    {account.cashBalanceUpdatedAt && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Updated {new Date(account.cashBalanceUpdatedAt).toLocaleDateString("en-US", {
                          month: "short", day: "numeric", year: "numeric",
                        })}
                      </p>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => { setCashInput(""); setEditingCash(true); }}
                    className="text-sm text-primary underline underline-offset-2 hover:opacity-80 transition-opacity"
                  >
                    Add cash balance
                  </button>
                )}
              </div>
            </Card>
          </div>
        </>
      )}

      {/* Tab bar — investment accounts only (below chart + summary) */}
      {isInvestment && (
        <div className="flex border-b border-border">
          {(["holdings", "activity"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                if (tab === "holdings") setStickyHolding(null);
              }}
              className={`relative px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab}
              {tab === "activity" && hasActivityNotification && (
                <span className="absolute top-1.5 right-1 h-1.5 w-1.5 rounded-full bg-down" />
              )}
            </button>
          ))}
        </div>
      )}

      {/* Banking: cash balance only */}
      {isBanking && (
        <Card className="p-6">
          <SectionLabel className="mb-1">Current Balance</SectionLabel>
          <DisplayStat as="p" className="tp-kpi-l">{formatCurrency(account.balance)}</DisplayStat>
          <p className="tp-fineprint mt-2">
            Cash position — balance managed in{" "}
            <button className="text-primary underline" onClick={() => navigate("/accounts")}>
              Accounts
            </button>
          </p>
        </Card>
      )}

      {/* Investment account — Activity tab */}
      {isInvestment && activeTab === "activity" && (
        <ActivityTab accountId={accountId!} accounts={accounts ?? []} onHoldingsChanged={refetch} onAccountChanged={refetchAccounts} />
      )}

      {/* Sell modal */}
      {sellModalHolding && accounts && (
        <SellModal
          holding={sellModalHolding}
          accounts={accounts}
          onClose={() => setSellModalHolding(null)}
          onSold={() => {
            refetch();
            refreshChart();
            setActiveTab("activity");
            setSellModalHolding(null);
          }}
          onTransferred={() => {
            refetch();
            refreshChart();
            setActiveTab("activity");
            setSellModalHolding(null);
          }}
        />
      )}

      {/* Investment account — Holdings tab */}
      {isInvestment && activeTab === "holdings" && (
        <>
          {/* Add investment modal */}
          <AddInvestmentModal
            accountId={accountId!}
            accountName={account.name}
            existingHoldings={holdings}
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            onSaved={() => { refetch(); refreshChart(); }}
            managed={account.isManaged}
          />

          {/* Import investments modal */}
          <ImportInvestmentsModal
            accountId={accountId!}
            open={importModalOpen}
            onClose={() => setImportModalOpen(false)}
            onComplete={() => { refetch(); refreshChart(); }}
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
                    <tr className="text-[11px] text-muted-foreground uppercase tracking-[1px] font-mono bg-muted/30 border-b border-border">
                      <th
                        style={{ width: "80px" }}
                        className="py-2 pl-4 pr-2 text-left font-medium"
                      >
                        Symbol
                      </th>
                      <th className="py-2 px-2 text-left font-medium">Name</th>
                      <th style={{ width: "100px" }} className="py-2 px-2 text-left font-medium">Price</th>
                      <th style={{ width: "110px" }} className="py-2 px-2 text-left font-medium">Quantity</th>
                      <th style={{ width: "120px" }} className="py-2 px-2 text-left font-medium">Total Cost</th>
                      <th style={{ width: "120px" }} className="py-2 px-2 text-left font-medium">Market Value</th>
                      <th style={{ width: "190px" }} className="py-2 pl-2 pr-2 text-left font-medium">Total Gain</th>
                      <th style={{ width: "105px" }} className="py-2 pr-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {holdingGroups.length > 1
                      ? /* Grouped view — insert a header row between groups */
                        holdingGroups.flatMap((group) => {
                          const groupHoldings = displayHoldings.filter(
                            (h) => (h.group ?? "") === group
                          );
                          const groupManuals = displayManuals.filter(
                            (m) => (m.group ?? "") === group
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
                                <SectionLabel as="span" className="text-foreground">
                                  {group || "Other"}
                                </SectionLabel>
                              </td>
                              <td className="py-1.5 px-2 text-xs font-semibold tabular-nums font-mono">
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
                                onSell={() => setSellModalHolding(sortedHoldings.find(h => h.id === holding.id) ?? holding)}
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
                                onEdit={() => { setEditingManual(manuals.find(m => m.id === entry.id)); setManualModalOpen(true); }}
                                onDeleted={refetchManual}
                              />
                            )),
                          ];
                        })
                      : /* Flat view — no group headers when all in one group */
                        [
                          ...displayHoldings.map((holding) => (
                            <HoldingRow
                              key={holding.id}
                              holding={holding}
                              expanded={expandedIds.has(holding.id)}
                              onToggle={() => toggleHolding(holding.id)}
                              onDeleted={refetch}
                              onUpdated={refetch}
                              onSell={() => setSellModalHolding(sortedHoldings.find(h => h.id === holding.id) ?? holding)}
                              rowRef={(el) => {
                                if (el) holdingRowRefs.current.set(holding.id, el);
                                else holdingRowRefs.current.delete(holding.id);
                              }}
                            />
                          )),
                          ...displayManuals.map((entry) => (
                            <ManualHoldingRow
                              key={entry.id}
                              entry={entry}
                              onEdit={() => { setEditingManual(manuals.find(m => m.id === entry.id)); setManualModalOpen(true); }}
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

          {/* QFX import panel — shown for managed/robo-advisor accounts */}
          {account.isManaged && (
            <div id="qfx-import">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <h3 className="font-semibold text-sm">Transaction History</h3>
                </div>
                <p className="tp-caption">Import QFX to enable the growth chart</p>
              </div>
              <QfxImportPanel accountId={accountId!} onImported={() => { refetch(); refreshChart(); }} />
            </Card>
            </div>
          )}

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
                  <span className="tp-caption">
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
          {stickyHolding && (() => {
            const sh = displayHoldings.find(h => h.id === stickyHolding.id) ?? stickyHolding;
            return (
              <StickyHoldingRow
                holding={sh}
                expanded={expandedIds.has(sh.id)}
                onToggle={() => toggleHolding(sh.id)}
              />
            );
          })()}
        </>
      )}
    </div>
  );
}
