import { useState, useCallback, useEffect, useRef, useMemo } from "react";
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
  rollOptionsPosition,
  editClosedPosition,
  deleteOptionsPosition,
  createOptionsGroup,
  importOptionsPositions,
  getOptionQuote,
  searchTickers,
  getTickerPrice,
  getInvestmentAccounts,
  getOptionAssignedBatches,
  type AssignmentBatch,
  type OptionsPosition,
  type OptionsTicker,
  type OptionsPositionGroup,
  type OptionsSettings,
  type OptionsPositionInput,
  type OptionsCloseInput,
  type OptionOutcome,
} from "@/api";
import type { TickerSearchResult } from "@/types";
import { useNotifications } from "@/context/NotificationContext";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Plus, ChevronDown, ChevronUp, Settings, Link, Pencil, Trash2, CircleCheck, Upload, FileText, AlertCircle, Check, CheckCircle2, PlayCircle, RefreshCw } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
} from "recharts";

// Captured once at module load; used as the "opened at" time for draft positions.
const PAGE_LOAD_TIME = new Date().toISOString();

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmt = (n: number | null | undefined, decimals = 2, prefix = "") =>
  n == null ? "—" : `${prefix}${n.toFixed(decimals)}`;

const fmtDollar = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${n < 0 ? " loss" : ""}`;

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

function fmtDate(iso: string) {
  // date-only strings (YYYY-MM-DD) should not be timezone-shifted
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  return `${m}/${d}/${String(y).slice(2)}`;
}

function fmtDateTimeShort(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

function fmtDateTimeFull(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
    timeZone: "America/New_York", timeZoneName: "short",
  });
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function getTradingWeekLabel(): string {
  const today = new Date();
  const day = today.getDay(); // 0=Sun … 6=Sat
  const monday = new Date(today);
  monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const monLabel = `${MONTH_NAMES[monday.getMonth()]} ${monday.getDate()}`;
  const friLabel = `${MONTH_NAMES[friday.getMonth()]} ${friday.getDate()}`;
  return `${monLabel} - ${friLabel}, ${friday.getFullYear()}`;
}

// ── Normalization ──────────────────────────────────────────────────────────────

// Prisma Decimal fields serialize as strings over JSON; coerce them to numbers.
function normalizePosition(p: OptionsPosition): OptionsPosition {
  return {
    ...p,
    strikePrice: Number(p.strikePrice),
    premiumPerShare: Number(p.premiumPerShare),
    contracts: Number(p.contracts),
    feesOpen: p.feesOpen != null ? Number(p.feesOpen) : null,
    shareCostBasis: p.shareCostBasis != null ? Number(p.shareCostBasis) : null,
    stockPriceAtOpen: p.stockPriceAtOpen != null ? Number(p.stockPriceAtOpen) : null,
    closePremiumPerShare: p.closePremiumPerShare != null ? Number(p.closePremiumPerShare) : null,
    feesClose: p.feesClose != null ? Number(p.feesClose) : null,
    contractsAssigned: p.contractsAssigned != null ? Number(p.contractsAssigned) : null,
    stockPriceAtClose: p.stockPriceAtClose != null ? Number(p.stockPriceAtClose) : null,
    currentPremiumPerShare: p.currentPremiumPerShare != null ? Number(p.currentPremiumPerShare) : null,
    isDraft: p.isDraft ?? false,
  };
}

// ── Calculations ───────────────────────────────────────────────────────────────

function calcPosition(p: OptionsPosition) {
  const totalPremiumGross = p.premiumPerShare * 100 * p.contracts;
  const totalPremiumNet = totalPremiumGross - (p.feesOpen ?? 0);

  const capitalAtRisk =
    p.optionType === "CALL"
      ? (p.shareCostBasis ?? 0) * 100 * p.contracts
      : p.strikePrice * 100 * p.contracts;

  const breakeven =
    p.optionType === "CALL"
      ? p.strikePrice + p.premiumPerShare
      : p.strikePrice - p.premiumPerShare;

  // Negative = stock must fall to reach strike (CSP); positive = must rise (CC)
  const pctOtmAtOpen =
    p.stockPriceAtOpen != null
      ? p.optionType === "CALL"
        ? ((p.strikePrice - p.stockPriceAtOpen) / p.stockPriceAtOpen) * 100
        : ((p.strikePrice - p.stockPriceAtOpen) / p.stockPriceAtOpen) * 100
      : null;

  // Expiry = expiration date at 4 pm ET = 20:00 UTC (approximation, EDT)
  const [ey, em, ed] = p.expirationDate.split("T")[0].split("-").map(Number);
  const expiryUtc = new Date(Date.UTC(ey, em - 1, ed, 20, 0, 0));

  const openedMs = new Date(p.openedAt).getTime();
  const durationDays = (expiryUtc.getTime() - openedMs) / 86_400_000;
  const daysLeft = (expiryUtc.getTime() - Date.now()) / 86_400_000;

  // Calendar days until expiry counted in ET so the display flips at midnight ET,
  // not at 4 pm ET (which is when daysLeft crosses integers).
  const ET_OFFSET_MS = 4 * 3600 * 1000; // EDT approximation
  const expiryEtDay = Math.floor((Date.UTC(ey, em - 1, ed) + ET_OFFSET_MS) / 86_400_000);
  const todayEtDay  = Math.floor((Date.now()               - ET_OFFSET_MS) / 86_400_000);
  const calDaysLeft = expiryEtDay - todayEtDay;

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
    calDaysLeft,
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

function getDefaultExpirationDate() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun … 6=Sat
  const daysToFriday = day <= 5 ? 5 - day : 6;
  d.setDate(d.getDate() + daysToFriday);
  // Use local date parts to avoid UTC timezone shift from toISOString()
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function getDefaultOpenedAt() {
  // Return current wall-clock time expressed as an ET datetime-local string
  // (EDT = UTC-4; etToUtc will add 4h back when converting to UTC for storage)
  const etNow = new Date(Date.now() - 4 * 60 * 60 * 1000);
  return etNow.toISOString().slice(0, 16);
}

type TickerDropdownItem =
  | { kind: "existing"; id: string; symbol: string }
  | { kind: "new"; result: TickerSearchResult };

function PositionModal({ tickers, groups, editing, onClose, onSaved, onTickerCreated }: PositionModalProps) {
  const [tickerQuery, setTickerQuery] = useState(editing?.ticker?.symbol ?? "");
  const [selectedExistingId, setSelectedExistingId] = useState<string | null>(editing?.tickerId ?? null);
  const [dropdownItems, setDropdownItems] = useState<TickerDropdownItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const tickerInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { tickerInputRef.current?.focus(); }, []);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [optionType, setOptionType] = useState<"CALL" | "PUT">(editing?.optionType ?? "CALL");
  const [strikePrice, setStrikePrice] = useState(editing?.strikePrice?.toString() ?? "");
  const [expirationDate, setExpirationDate] = useState(
    editing?.expirationDate ? editing.expirationDate.split("T")[0] : getDefaultExpirationDate()
  );
  // openedAt is stored as UTC; show in ET (subtract 4h for EDT)
  const [openedAt, setOpenedAt] = useState(() => {
    if (editing?.openedAt) {
      const d = new Date(editing.openedAt);
      d.setHours(d.getHours() - 4); // UTC → EDT approximation
      return d.toISOString().slice(0, 16);
    }
    return getDefaultOpenedAt();
  });
  const [isDraft, setIsDraft] = useState(editing?.isDraft ?? false);
  const [contracts, setContracts] = useState(editing?.contracts?.toString() ?? "");
  const [premiumPerShare, setPremiumPerShare] = useState(editing?.premiumPerShare?.toString() ?? "");
  const [feesOpen, setFeesOpen] = useState(editing?.feesOpen?.toString() ?? "");
  const [shareCostBasis, setShareCostBasis] = useState(editing?.shareCostBasis?.toString() ?? "");
  const [stockPriceAtOpen, setStockPriceAtOpen] = useState(editing?.stockPriceAtOpen?.toString() ?? "");
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [groupId, setGroupId] = useState(editing?.groupId ?? "");
  const [investmentAccountId, setInvestmentAccountId] = useState(editing?.investmentAccountId ?? "");
  const [selectedBatchKey, setSelectedBatchKey] = useState<string>(() => {
    if (editing?.assignedFromStrikePrice != null && editing?.assignedFromExpirationDate) {
      const expDate = editing.assignedFromExpirationDate.split("T")[0];
      return `${editing.assignedFromStrikePrice}|${expDate}`;
    }
    return "";
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isCoveredCall = optionType === "CALL";

  // Investment accounts for account selector
  const { data: investmentAccounts } = useApi(() => getInvestmentAccounts(), []);

  // Assignment batches for CC lot picker: load when ticker + account are both selected
  const selectedTicker = selectedExistingId
    ? tickers.find((t) => t.id === selectedExistingId)?.symbol ?? tickerQuery
    : tickerQuery;
  const { data: assignedBatches } = useApi(
    () =>
      isCoveredCall && selectedTicker && investmentAccountId
        ? getOptionAssignedBatches(selectedTicker, investmentAccountId)
        : Promise.resolve([]),
    [isCoveredCall, selectedTicker, investmentAccountId]
  );
  const hasAssignedBatches = assignedBatches && assignedBatches.length > 0;
  const assignedFromBatch = useMemo(
    () => selectedBatchKey && assignedBatches
      ? assignedBatches.find((b) => `${parseFloat(b.strikePrice)}|${b.expirationDate}` === selectedBatchKey) ?? null
      : null,
    [selectedBatchKey, assignedBatches]
  );

  const fetchPrice = useCallback(async (symbol: string) => {
    try {
      const result = await getTickerPrice(symbol);
      setStockPriceAtOpen(result.price.toFixed(2));
    } catch { /* ignore — user can fill manually */ }
  }, []);

  // Auto-fetch option quote when ticker + type + strike + expiration are all set
  const [quoteFetching, setQuoteFetching] = useState(false);
  const [quoteAutoFilled, setQuoteAutoFilled] = useState(false);
  const quoteDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    // Don't auto-fill premium for existing open positions — the transaction already occurred
    if (editing) return;
    if (quoteDebounce.current) clearTimeout(quoteDebounce.current);
    const strikeNum = parseFloat(strikePrice);
    if (!selectedTicker || !strikePrice || isNaN(strikeNum) || strikeNum <= 0 || !expirationDate) {
      return;
    }
    quoteDebounce.current = setTimeout(async () => {
      setQuoteFetching(true);
      try {
        const quote = await getOptionQuote({ symbol: selectedTicker, type: optionType, strike: strikeNum, expiration: expirationDate });
        if (quote.lastPrice != null) {
          setPremiumPerShare(quote.lastPrice.toFixed(4));
          setQuoteAutoFilled(true);
        }
      } catch { /* ignore — user can fill manually */ }
      finally { setQuoteFetching(false); }
    }, 600);
    return () => { if (quoteDebounce.current) clearTimeout(quoteDebounce.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, selectedTicker, optionType, strikePrice, expirationDate]);

  const handleTickerSearch = (q: string) => {
    const upper = q.toUpperCase();
    setTickerQuery(upper);
    setSelectedExistingId(null);
    setDropdownOpen(true);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!upper.trim()) { setDropdownItems([]); setSearchLoading(false); setHighlightedIndex(-1); return; }

    // Immediately show matching existing tickers
    const existingMatches = tickers
      .filter((t) => t.symbol.startsWith(upper))
      .map((t): TickerDropdownItem => ({ kind: "existing", id: t.id, symbol: t.symbol }));
    setDropdownItems(existingMatches);
    setHighlightedIndex(existingMatches.length > 0 ? 0 : -1);

    searchDebounce.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const results = await searchTickers(q);
        const existingSymbols = new Set(tickers.map((t) => t.symbol));
        const newItems = results
          .filter((r) => !existingSymbols.has(r.ticker))
          .map((r): TickerDropdownItem => ({ kind: "new", result: r }));
        const merged = [
          ...tickers.filter((t) => t.symbol.startsWith(upper)).map((t): TickerDropdownItem => ({ kind: "existing", id: t.id, symbol: t.symbol })),
          ...newItems,
        ];
        setDropdownItems(merged);
        setHighlightedIndex(merged.length > 0 ? 0 : -1);
      } catch { /* keep existing matches */ }
      finally { setSearchLoading(false); }
    }, 300);
  };

  const handleDropdownSelect = (item: TickerDropdownItem) => {
    const symbol = item.kind === "existing" ? item.symbol : item.result.ticker;
    setTickerQuery(symbol);
    setSelectedExistingId(item.kind === "existing" ? item.id : null);
    setDropdownItems([]);
    setDropdownOpen(false);
    setHighlightedIndex(-1);
    if (!editing) fetchPrice(symbol);
  };

  const handleTickerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!dropdownOpen || dropdownItems.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, dropdownItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && highlightedIndex >= 0) {
      e.preventDefault();
      handleDropdownSelect(dropdownItems[highlightedIndex]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      let resolvedTickerId = selectedExistingId;

      if (!resolvedTickerId) {
        const symbol = tickerQuery.trim().toUpperCase();
        if (!symbol) {
          setError("Please select a ticker.");
          setSaving(false);
          return;
        }
        const created = await createOptionsTicker({ symbol });
        resolvedTickerId = created.id;
        onTickerCreated();
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
        investmentAccountId: investmentAccountId || null,
        assignedFromStrikePrice: selectedBatchKey ? parseFloat(selectedBatchKey.split("|")[0]) : null,
        assignedFromExpirationDate: selectedBatchKey ? selectedBatchKey.split("|")[1] : null,
        isDraft: isDraft,
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
    <Modal open onClose={onClose} title={editing ? "Edit Position" : "Open New Position / Draft"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Ticker */}
        <div>
          <label className="block text-xs font-medium mb-1">Underlying Ticker</label>
          <div className="relative">
            <input
              ref={tickerInputRef}
              value={tickerQuery}
              onChange={(e) => handleTickerSearch(e.target.value)}
              onFocus={() => { if (tickerQuery) setDropdownOpen(true); }}
              onBlur={() => setTimeout(() => setDropdownOpen(false), 150)}
              onKeyDown={handleTickerKeyDown}
              placeholder="Search ticker… (e.g. AAPL)"
              autoComplete="off"
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              required
            />
            {dropdownOpen && (dropdownItems.length > 0 || searchLoading) && (
              <ul className="absolute z-10 mt-1 w-full rounded-md border border-border bg-background shadow-lg text-sm max-h-52 overflow-y-auto">
                {searchLoading && dropdownItems.length === 0 && (
                  <li className="px-3 py-2 text-muted-foreground">Searching…</li>
                )}
                {dropdownItems.map((item, i) =>
                  item.kind === "existing" ? (
                    <li
                      key={`existing-${item.id}`}
                      onMouseDown={(e) => { e.preventDefault(); handleDropdownSelect(item); }}
                      onMouseEnter={() => setHighlightedIndex(i)}
                      className={cn("flex items-center justify-between px-3 py-2 cursor-pointer", i === highlightedIndex ? "bg-muted/60" : "hover:bg-muted/60")}
                    >
                      <span className="font-medium">{item.symbol}</span>
                      <span className="text-xs text-primary/70 font-medium">tracked</span>
                    </li>
                  ) : (
                    <li
                      key={`new-${item.result.ticker}`}
                      onMouseDown={(e) => { e.preventDefault(); handleDropdownSelect(item); }}
                      onMouseEnter={() => setHighlightedIndex(i)}
                      className={cn("flex items-center justify-between px-3 py-2 cursor-pointer", i === highlightedIndex ? "bg-muted/60" : "hover:bg-muted/60")}
                    >
                      <span className="font-medium">{item.result.ticker}</span>
                      <span className="text-muted-foreground truncate ml-3">{item.result.name}</span>
                    </li>
                  )
                )}
              </ul>
            )}
          </div>
        </div>

        {/* Type */}
        <div>
          <label className="block text-xs font-medium mb-1">Option Type</label>
          <div className="flex rounded-md border border-border overflow-hidden text-sm font-medium">
            <button
              type="button"
              onClick={() => setOptionType("CALL")}
              className={`flex-1 py-2 transition-colors ${optionType === "CALL" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted/60"}`}
            >
              Covered Call
            </button>
            <button
              type="button"
              onClick={() => setOptionType("PUT")}
              className={`flex-1 py-2 transition-colors border-l border-border ${optionType === "PUT" ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-muted/60"}`}
            >
              Cash-Secured Put
            </button>
          </div>
        </div>

        {/* Investment Account */}
        {(() => {
          const eligibleAccounts = (investmentAccounts ?? []).filter(
            (a) => a.type === "INVESTMENT" && !a.isManaged
          );
          return eligibleAccounts.length > 0 ? (
            <div>
              <label className="block text-xs font-medium mb-1">
                Investment Account
              </label>
              <select
                value={investmentAccountId}
                onChange={(e) => setInvestmentAccountId(e.target.value)}
                className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-sm text-foreground"
              >
                <option value="">None</option>
                {eligibleAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          ) : null;
        })()}

        {/* Assignment batch picker — CC only, appears once ticker + account are selected */}
        {isCoveredCall && hasAssignedBatches && (
          <div>
            <label className="block text-xs font-medium mb-1">
              Written Against Assigned Lot <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <select
              value={selectedBatchKey}
              onChange={(e) => {
                const key = e.target.value;
                setSelectedBatchKey(key);
                if (!key) return;
                const [strike, expiry] = key.split("|");
                const batch = assignedBatches!.find(
                  (b) => `${parseFloat(b.strikePrice)}|${b.expirationDate}` === `${parseFloat(strike)}|${expiry}`
                ) ?? null;
                if (batch) {
                  setContracts(batch.contractsRemaining.toString());
                  if (batch.weightedCostPerShare != null)
                    setShareCostBasis(batch.weightedCostPerShare.toFixed(6).replace(/\.?0+$/, ""));
                }
              }}
              className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-sm text-foreground"
            >
              <option value="">None / not from an assignment</option>
              {assignedBatches!.map((batch) => {
                const expLabel = new Date(batch.expirationDate + "T12:00:00Z").toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
                return (
                  <option key={`${batch.strikePrice}|${batch.expirationDate}`} value={`${batch.strikePrice}|${batch.expirationDate}`}>
                    ${parseFloat(batch.strikePrice).toFixed(2)} · {expLabel} expiry · {batch.contractsRemaining} of {batch.totalContracts} contracts remaining
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* Strike / Expiration */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1">Strike Price</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.01" min="0" required
                value={strikePrice} onChange={(e) => setStrikePrice(e.target.value)}
                className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Expiration Date</label>
            <input
              type="date" required
              value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* Opened At / Draft */}
        <div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">Date & Time Opened <span className="text-muted-foreground font-normal">(ET)</span></label>
              <input
                type="datetime-local"
                required={!isDraft}
                disabled={isDraft}
                value={isDraft ? "" : openedAt}
                onChange={(e) => setOpenedAt(e.target.value)}
                className={cn(
                  "w-full rounded-md border border-border px-3 py-2 text-sm",
                  isDraft
                    ? "bg-muted/40 text-muted-foreground cursor-not-allowed"
                    : "focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                )}
              />
            </div>
            <div className="flex flex-col justify-end pb-[1px]">
              <label className="flex items-center gap-2 cursor-pointer select-none rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/40 transition-colors">
                <input
                  type="checkbox"
                  checked={isDraft}
                  onChange={(e) => {
                    setIsDraft(e.target.checked);
                    if (!e.target.checked && editing?.isDraft) {
                      setOpenedAt(getDefaultOpenedAt());
                    }
                  }}
                  className="h-3.5 w-3.5 rounded border-border accent-primary"
                />
                Draft
                <span className="ml-auto text-xs text-muted-foreground font-normal">plan / limit order</span>
              </label>
            </div>
          </div>
          {isDraft && (
            <p className="mt-1 text-xs text-muted-foreground">Date confirmed when you open the position.</p>
          )}
        </div>

        {/* Contracts / Premium */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1"># Contracts</label>
            <input
              type="number" min="1" step="1" required
              value={contracts} onChange={(e) => setContracts(e.target.value)}
              className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">
              Premium / Share{" "}
              <span className="text-muted-foreground font-normal">
                {quoteFetching ? "(fetching…)" : ""}
              </span>
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.0001" min="0" required
                value={premiumPerShare}
                onChange={(e) => { setPremiumPerShare(e.target.value); setQuoteAutoFilled(false); }}
                placeholder={quoteFetching ? "Fetching…" : ""}
                className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          </div>
        </div>

        {/* Stock Price at Open */}
        <div>
          <label className="block text-xs font-medium mb-1">Stock Price at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.0001" min="0"
              value={stockPriceAtOpen} onChange={(e) => setStockPriceAtOpen(e.target.value)}
              className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        </div>

        {/* Share Cost Basis — CC only */}
        {isCoveredCall && (
          <div>
            <label className="block text-xs font-medium mb-1">Cost Basis / Share</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.000001" min="0"
                value={shareCostBasis} onChange={(e) => setShareCostBasis(e.target.value)}
                className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          </div>
        )}

        {/* Fees */}
        <div>
          <label className="block text-xs font-medium mb-1">Fees at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.01" min="0"
              value={feesOpen} onChange={(e) => setFeesOpen(e.target.value)}
              className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs font-medium mb-1">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
          <textarea
            value={notes} onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-border px-3 py-2 text-sm resize-none focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : editing ? (editing.isDraft && !isDraft ? "Open Position" : "Save Changes") : isDraft ? "Save Draft" : "Open Position"}
          </Button>
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

function addOneWeek(dateIso: string): string {
  const dateOnly = dateIso.split("T")[0];
  const [y, m, d] = dateOnly.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 7);
  return dt.toISOString().split("T")[0];
}

function ClosePositionModal({ position, onClose, onSaved }: CloseModalProps) {
  const expirationDateStr = position.expirationDate.split("T")[0]; // YYYY-MM-DD
  const defaultAssignedClosedAt = expirationDateStr + "T16:00"; // 4pm ET market close

  const [outcome, setOutcome] = useState<OptionOutcome>("EXPIRED_WORTHLESS");
  const [closedAt, setClosedAt] = useState(getDefaultOpenedAt());
  const [closePremiumPerShare, setClosePremiumPerShare] = useState("");
  const [feesClose, setFeesClose] = useState("");
  const [contractsAssigned, setContractsAssigned] = useState("");
  const [stockPriceAtClose, setStockPriceAtClose] = useState("");
  const [investmentAccountId, setInvestmentAccountId] = useState(position.investmentAccountId ?? "");

  const { data: investmentAccounts } = useApi(() => getInvestmentAccounts(), []);

  // Roll-specific: new position fields
  const [newPremiumPerShare, setNewPremiumPerShare] = useState("");
  const [newStrikePrice, setNewStrikePrice] = useState(position.strikePrice.toFixed(2));
  const [newExpirationDate, setNewExpirationDate] = useState(() => addOneWeek(position.expirationDate));
  const [newStockPriceAtOpen, setNewStockPriceAtOpen] = useState("");
  const [newFeesOpen, setNewFeesOpen] = useState("");
  const [priceFetching, setPriceFetching] = useState(false);
  const [assignedPriceFetching, setAssignedPriceFetching] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isExpired = outcome === "EXPIRED_WORTHLESS";
  const isAssigned = outcome === "ASSIGNED";
  const isRolled = outcome === "ROLLED";

  // When switching to ASSIGNED, default closedAt to expiration date at 4pm ET
  // and pre-fill contracts assigned to the full position size
  useEffect(() => {
    if (isAssigned) {
      setClosedAt(defaultAssignedClosedAt);
      setContractsAssigned(position.contracts.toString());
    }
  }, [isAssigned]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch stock price when outcome is ASSIGNED (using expiration date)
  useEffect(() => {
    if (!isAssigned) return;
    let cancelled = false;
    setAssignedPriceFetching(true);
    getTickerPrice(position.ticker.symbol, expirationDateStr)
      .then((r) => { if (!cancelled) setStockPriceAtClose(r.price.toFixed(2)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAssignedPriceFetching(false); });
    return () => { cancelled = true; };
  }, [isAssigned, expirationDateStr, position.ticker.symbol]);

  // Auto-fetch stock price when closedAt changes and outcome is ROLLED
  useEffect(() => {
    if (!isRolled || !closedAt) return;
    const dateStr = closedAt.split("T")[0];
    if (!dateStr) return;
    let cancelled = false;
    setPriceFetching(true);
    getTickerPrice(position.ticker.symbol, dateStr)
      .then((r) => { if (!cancelled) setNewStockPriceAtOpen(r.price.toFixed(2)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPriceFetching(false); });
    return () => { cancelled = true; };
  }, [isRolled, closedAt, position.ticker.symbol]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (isRolled) {
        await rollOptionsPosition(position.id, {
          closedAt: closedAt ? etToUtc(closedAt) : null,
          closePremiumPerShare: closePremiumPerShare ? parseFloat(closePremiumPerShare) : null,
          feesClose: feesClose ? parseFloat(feesClose) : null,
          newPremiumPerShare: parseFloat(newPremiumPerShare),
          newStrikePrice: parseFloat(newStrikePrice),
          newExpirationDate,
          newStockPriceAtOpen: newStockPriceAtOpen ? parseFloat(newStockPriceAtOpen) : null,
          newFeesOpen: newFeesOpen ? parseFloat(newFeesOpen) : null,
        });
      } else {
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
          closePremiumPerShare: isExpired || isAssigned ? null : closePremiumPerShare ? parseFloat(closePremiumPerShare) : null,
          feesClose: feesClose ? parseFloat(feesClose) : null,
          contractsAssigned: isAssigned && contractsAssigned ? parseInt(contractsAssigned, 10) : null,
          stockPriceAtClose: isAssigned && stockPriceAtClose ? parseFloat(stockPriceAtClose) : null,
          investmentAccountId: isAssigned ? (investmentAccountId || null) : undefined,
        };
        await closeOptionsPosition(position.id, data);
      }
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

  const inputClass = "w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
  const dollarInputClass = "w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

  return (
    <Modal open onClose={onClose} title={`Close: ${position.ticker.symbol} $${position.strikePrice} ${position.optionType}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Outcome selector */}
        <div>
          <label className="block text-xs font-medium mb-1">Outcome</label>
          <div className="grid grid-cols-2 rounded-md border border-border overflow-hidden text-sm font-medium">
            {outcomeOptions.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setOutcome(o.value)}
                className={cn(
                  "py-2 px-3 text-left transition-colors",
                  i % 2 !== 0 && "border-l border-border",
                  i >= 2 && "border-t border-border",
                  outcome === o.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-foreground hover:bg-muted/60"
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Close fields ── */}
        {!isExpired && (
          <div>
            <label className="block text-xs font-medium mb-1">
              {isRolled ? "Date / Time Rolled" : "Date Closed"}{" "}
              <span className="text-muted-foreground font-normal">(ET)</span>
            </label>
            <input
              type="datetime-local" required
              value={closedAt} onChange={(e) => setClosedAt(e.target.value)}
              className={inputClass}
            />
          </div>
        )}

        {!isExpired && !isAssigned && (
          <div>
            <label className="block text-xs font-medium mb-1">
              {isRolled ? "Buy-back Premium / Share" : "Close Premium / Share"}
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.0001" min="0"
                value={closePremiumPerShare} onChange={(e) => setClosePremiumPerShare(e.target.value)}
                className={dollarInputClass}
              />
            </div>
          </div>
        )}

        {isAssigned && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1">Contracts Assigned</label>
              <input
                type="number" min="1" step="1"
                value={contractsAssigned} onChange={(e) => setContractsAssigned(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                Stock Price at Assignment{" "}
                <span className="text-muted-foreground font-normal">
                  {assignedPriceFetching ? "(fetching…)" : "(from Yahoo Finance)"}
                </span>
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <input
                  type="number" step="0.0001" min="0"
                  value={stockPriceAtClose} onChange={(e) => setStockPriceAtClose(e.target.value)}
                  placeholder={assignedPriceFetching ? "Fetching…" : ""}
                  className={dollarInputClass}
                />
              </div>
            </div>
            {(() => {
              const eligible = (investmentAccounts ?? []).filter((a) => a.type === "INVESTMENT" && !a.isManaged);
              return eligible.length > 0 ? (
                <div>
                  <label className="block text-xs font-medium mb-1">
                    Investment Account <span className="text-muted-foreground font-normal">(where shares will be purchased)</span>
                  </label>
                  <select
                    value={investmentAccountId}
                    onChange={(e) => setInvestmentAccountId(e.target.value)}
                    className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-sm text-foreground"
                  >
                    <option value="">None</option>
                    {eligible.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              ) : null;
            })()}
          </>
        )}

        <div>
          <label className="block text-xs font-medium mb-1">
            {isRolled ? "Fees at Close (buy-back)" : "Fees at Close"}{" "}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.01" min="0"
              value={feesClose} onChange={(e) => setFeesClose(e.target.value)}
              className={dollarInputClass}
            />
          </div>
        </div>

        {/* ── New position fields (roll only) ── */}
        {isRolled && (
          <>
            <div className="border-t border-border pt-4">
              <p className="text-sm font-semibold mb-3">New Position</p>
              <div className="rounded-md bg-muted/30 px-3 py-2 text-sm text-muted-foreground mb-3 space-y-0.5">
                <div><span className="font-medium text-foreground">{position.ticker.symbol}</span> · {position.contracts} contract{position.contracts !== 1 ? "s" : ""} · {position.optionType === "CALL" ? "Covered Call" : "Cash-Secured Put"}</div>
              </div>

              <div className="space-y-4">
                {/* Premium / share */}
                <div>
                  <label className="block text-xs font-medium mb-1">Premium / Share</label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <input
                      type="number" step="0.0001" min="0" required
                      value={newPremiumPerShare} onChange={(e) => setNewPremiumPerShare(e.target.value)}
                      className={dollarInputClass}
                    />
                  </div>
                </div>

                {/* Strike / Expiration */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium mb-1">Strike Price</label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <input
                        type="number" step="0.01" min="0" required
                        value={newStrikePrice} onChange={(e) => setNewStrikePrice(e.target.value)}
                        className={dollarInputClass}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Expiration Date</label>
                    <input
                      type="date" required
                      value={newExpirationDate} onChange={(e) => setNewExpirationDate(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>

                {/* Stock price (auto-fetched, editable) */}
                <div>
                  <label className="block text-xs font-medium mb-1">
                    Stock Price at Open{" "}
                    <span className="text-muted-foreground font-normal">
                      {priceFetching ? "(fetching…)" : "(from Yahoo Finance)"}
                    </span>
                  </label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <input
                      type="number" step="0.0001" min="0"
                      value={newStockPriceAtOpen} onChange={(e) => setNewStockPriceAtOpen(e.target.value)}
                      placeholder={priceFetching ? "Fetching…" : ""}
                      className={dollarInputClass}
                    />
                  </div>
                </div>

                {/* Fees at open for the new position */}
                <div>
                  <label className="block text-xs font-medium mb-1">Fees at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <input
                      type="number" step="0.01" min="0"
                      value={newFeesOpen} onChange={(e) => setNewFeesOpen(e.target.value)}
                      className={dollarInputClass}
                    />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : isRolled ? "Roll Position" : "Close Position"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Edit Close Details Modal ───────────────────────────────────────────────────

interface EditCloseModalProps {
  position: OptionsPosition;
  onClose: () => void;
  onSaved: () => void;
  onEditPositionDetails: () => void;
}

function EditCloseModal({ position, onClose, onSaved, onEditPositionDetails }: EditCloseModalProps) {
  const isRolled = position.outcome === "ROLLED";
  const isPartOfChain = !!position.groupId;
  const lockTimestamp = isRolled && isPartOfChain;

  const expirationDateStr = position.expirationDate.split("T")[0]; // YYYY-MM-DD
  const defaultAssignedClosedAt = expirationDateStr + "T16:00"; // 4pm ET market close

  const [outcome, setOutcome] = useState<OptionOutcome>(position.outcome ?? "EXPIRED_WORTHLESS");
  const [closedAt, setClosedAt] = useState(() => {
    if (!position.closedAt) return "";
    const d = new Date(position.closedAt);
    d.setHours(d.getHours() - 4); // UTC → EDT approximation
    return d.toISOString().slice(0, 16);
  });
  const [closePremiumPerShare, setClosePremiumPerShare] = useState(
    position.closePremiumPerShare?.toString() ?? ""
  );
  const [feesClose, setFeesClose] = useState(position.feesClose?.toString() ?? "");
  const [contractsAssigned, setContractsAssigned] = useState(
    position.contractsAssigned?.toString() ?? ""
  );
  const [stockPriceAtClose, setStockPriceAtClose] = useState(
    position.stockPriceAtClose?.toString() ?? ""
  );
  const [investmentAccountId, setInvestmentAccountId] = useState(position.investmentAccountId ?? "");
  const [assignedPriceFetching, setAssignedPriceFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const { data: investmentAccounts } = useApi(() => getInvestmentAccounts(), []);

  const isExpired = outcome === "EXPIRED_WORTHLESS";
  const isAssigned = outcome === "ASSIGNED";

  // When switching to ASSIGNED, default closedAt to expiration date at 4pm ET
  useEffect(() => {
    if (isAssigned && !closedAt) setClosedAt(defaultAssignedClosedAt);
  }, [isAssigned]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch stock price when newly switching to ASSIGNED and no price recorded yet
  useEffect(() => {
    if (!isAssigned || stockPriceAtClose) return;
    let cancelled = false;
    setAssignedPriceFetching(true);
    getTickerPrice(position.ticker.symbol, expirationDateStr)
      .then((r) => { if (!cancelled) setStockPriceAtClose(r.price.toFixed(2)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAssignedPriceFetching(false); });
    return () => { cancelled = true; };
  }, [isAssigned, expirationDateStr, position.ticker.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusMap: Record<OptionOutcome, Exclude<import("@/api").OptionStatus, "OPEN">> = {
    EXPIRED_WORTHLESS: "EXPIRED",
    CLOSED_EARLY: "CLOSED",
    ROLLED: "CLOSED",
    ASSIGNED: "ASSIGNED",
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await editClosedPosition(position.id, {
        outcome,
        status: statusMap[outcome],
        closedAt: isExpired ? null : lockTimestamp ? undefined : closedAt ? etToUtc(closedAt) : null,
        closePremiumPerShare: isExpired || isAssigned ? null : closePremiumPerShare ? parseFloat(closePremiumPerShare) : null,
        feesClose: feesClose ? parseFloat(feesClose) : null,
        contractsAssigned: isAssigned && contractsAssigned ? parseInt(contractsAssigned, 10) : null,
        stockPriceAtClose: isAssigned && stockPriceAtClose ? parseFloat(stockPriceAtClose) : null,
        investmentAccountId: isAssigned ? (investmentAccountId || null) : undefined,
      });
      onSaved();
    } catch {
      setError("Failed to save changes.");
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

  const inputClass = "w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
  const dollarInputClass = "w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

  return (
    <Modal open onClose={onClose} title={`Edit Close: ${position.ticker.symbol} $${position.strikePrice} ${position.optionType}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1">Outcome</label>
          <div className="grid grid-cols-2 rounded-md border border-border overflow-hidden text-sm font-medium">
            {outcomeOptions.map((o, i) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setOutcome(o.value)}
                className={cn(
                  "py-2 px-3 text-left transition-colors",
                  i % 2 !== 0 && "border-l border-border",
                  i >= 2 && "border-t border-border",
                  outcome === o.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-foreground hover:bg-muted/60"
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {!isExpired && (
          <div>
            <label className="block text-xs font-medium mb-1">
              Date Closed <span className="text-muted-foreground font-normal">(ET)</span>
            </label>
            {lockTimestamp ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                {closedAt || "—"}
                <span className="ml-2 text-xs">(locked — part of a roll chain)</span>
              </div>
            ) : (
              <input
                type="datetime-local"
                value={closedAt} onChange={(e) => setClosedAt(e.target.value)}
                className={inputClass}
              />
            )}
          </div>
        )}

        {!isExpired && !isAssigned && (
          <div>
            <label className="block text-xs font-medium mb-1">Close Premium / Share</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.0001" min="0"
                value={closePremiumPerShare} onChange={(e) => setClosePremiumPerShare(e.target.value)}
                className={dollarInputClass}
              />
            </div>
          </div>
        )}

        {isAssigned && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1">Contracts Assigned</label>
              <input
                type="number" min="1" step="1"
                value={contractsAssigned} onChange={(e) => setContractsAssigned(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                Stock Price at Assignment{" "}
                <span className="text-muted-foreground font-normal">
                  {assignedPriceFetching ? "(fetching…)" : "(from Yahoo Finance)"}
                </span>
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <input
                  type="number" step="0.0001" min="0"
                  value={stockPriceAtClose} onChange={(e) => setStockPriceAtClose(e.target.value)}
                  placeholder={assignedPriceFetching ? "Fetching…" : ""}
                  className={dollarInputClass}
                />
              </div>
            </div>
            {(() => {
              const eligible = (investmentAccounts ?? []).filter((a) => a.type === "INVESTMENT" && !a.isManaged);
              return eligible.length > 0 ? (
                <div>
                  <label className="block text-xs font-medium mb-1">
                    Investment Account <span className="text-muted-foreground font-normal">(where shares will be purchased)</span>
                  </label>
                  <select
                    value={investmentAccountId}
                    onChange={(e) => setInvestmentAccountId(e.target.value)}
                    className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-sm text-foreground"
                  >
                    <option value="">None</option>
                    {eligible.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              ) : null;
            })()}
          </>
        )}

        <div>
          <label className="block text-xs font-medium mb-1">Fees at Close <span className="text-muted-foreground font-normal">(optional)</span></label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.01" min="0"
              value={feesClose} onChange={(e) => setFeesClose(e.target.value)}
              className={dollarInputClass}
            />
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={onEditPositionDetails}
            className="text-sm text-primary hover:underline underline-offset-2 transition-colors"
          >
            Edit Position Details
          </button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save Changes"}</Button>
          </div>
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

/** Returns Monday ISO strings for every week of the current year through today. */
function getYearWeeks(): { monIso: string; label: string }[] {
  const now = new Date();
  const year = now.getFullYear();
  // Start from the Monday of the week containing Jan 1
  const jan1 = new Date(year, 0, 1);
  const jan1Day = jan1.getDay(); // 0=Sun
  const firstMonday = new Date(jan1);
  firstMonday.setDate(jan1.getDate() - (jan1Day === 0 ? 6 : jan1Day - 1));

  const currentMonday = new Date(now);
  currentMonday.setHours(0, 0, 0, 0);
  const nowDay = now.getDay();
  currentMonday.setDate(now.getDate() - (nowDay === 0 ? 6 : nowDay - 1));

  const weeks: { monIso: string; label: string }[] = [];
  const cursor = new Date(firstMonday);
  while (cursor <= currentMonday) {
    const fri = new Date(cursor);
    fri.setDate(cursor.getDate() + 4);
    const monLabel = `${cursor.getMonth() + 1}/${cursor.getDate()}`;
    const friLabel = `${fri.getMonth() + 1}/${fri.getDate()}`;
    const monIso = cursor.toISOString().split("T")[0];
    weeks.push({ monIso, label: `${monLabel}-${friLabel}` });
    cursor.setDate(cursor.getDate() + 7);
  }
  return weeks;
}

function SettingsModal({ current, onClose, onSaved }: SettingsModalProps) {
  const [startingBasis, setStartingBasis] = useState(current?.startingBasis?.toString() ?? "");
  const [targetReturn, setTargetReturn] = useState(
    current ? (current.targetReturn * 100).toFixed(1) : ""
  );
  const [startingWeek, setStartingWeek] = useState(current?.startingWeek ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const yearWeeks = useMemo(() => getYearWeeks(), []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await updateOptionsSettings({
        startingBasis: parseFloat(startingBasis),
        targetReturn: parseFloat(targetReturn) / 100,
        startingWeek: startingWeek || null,
      });
      onSaved();
    } catch {
      setError("Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Options Trading Settings">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium mb-1">Starting Basis</label>
          <p className="text-xs text-muted-foreground mb-2">Total capital allocated to options trading — used as the denominator for aggregate return calculations.</p>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.01" min="0" required
              value={startingBasis} onChange={(e) => setStartingBasis(e.target.value)}
              className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Starting Week</label>
          <p className="text-xs text-muted-foreground mb-2">First week counted toward performance. Sets the origin for charts and annualized return.</p>
          <select
            value={startingWeek}
            onChange={(e) => setStartingWeek(e.target.value)}
            className="w-full appearance-none rounded-md border border-border pl-2 pr-6 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
          >
            <option value="">— Use first week with closed positions —</option>
            {yearWeeks.map((w) => (
              <option key={w.monIso} value={w.monIso}>{w.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Target Annual Return</label>
          <p className="text-xs text-muted-foreground mb-2">Used for premium target charts and performance benchmarking.</p>
          <div className="relative">
            <input
              type="number" step="0.1" min="0" max="999" required
              value={targetReturn} onChange={(e) => setTargetReturn(e.target.value)}
              className="w-full rounded-md border border-border px-3 pr-8 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save Settings"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Confirm Draft Modal ────────────────────────────────────────────────────────

interface ConfirmDraftModalProps {
  position: OptionsPosition;
  onClose: () => void;
  onSaved: () => void;
}

function ConfirmDraftModal({ position, onClose, onSaved }: ConfirmDraftModalProps) {
  const [confirmedAt, setConfirmedAt] = useState(getDefaultOpenedAt);
  const [contracts, setContracts] = useState(position.contracts.toString());
  const [premiumPerShare, setPremiumPerShare] = useState(position.premiumPerShare.toString());
  const [stockPriceAtOpen, setStockPriceAtOpen] = useState(position.stockPriceAtOpen?.toString() ?? "");
  const [feesOpen, setFeesOpen] = useState(position.feesOpen?.toString() ?? "");
  const [priceFetching, setPriceFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setPriceFetching(true);
    getTickerPrice(position.ticker.symbol)
      .then((r) => { if (!cancelled) setStockPriceAtOpen(r.price.toFixed(2)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPriceFetching(false); });
    return () => { cancelled = true; };
  }, [position.ticker.symbol]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await updateOptionsPosition(position.id, {
        isDraft: false,
        openedAt: etToUtc(confirmedAt),
        contracts: parseInt(contracts, 10),
        premiumPerShare: parseFloat(premiumPerShare),
        feesOpen: feesOpen ? parseFloat(feesOpen) : null,
        stockPriceAtOpen: stockPriceAtOpen ? parseFloat(stockPriceAtOpen) : null,
      });
      onSaved();
    } catch {
      setError("Failed to confirm position.");
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
  const dollarInputClass = "w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

  return (
    <Modal open onClose={onClose} title={`Confirm: ${position.ticker.symbol} $${position.strikePrice} ${position.optionType}`}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-muted-foreground">Confirm the details for this position. All fields are pre-filled with defaults — edit as needed.</p>

        <div>
          <label className="block text-xs font-medium mb-1">Date & Time Opened <span className="text-muted-foreground font-normal">(ET)</span></label>
          <input
            type="datetime-local" required
            value={confirmedAt} onChange={(e) => setConfirmedAt(e.target.value)}
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium mb-1"># Contracts</label>
            <input
              type="number" min="1" step="1" required
              value={contracts} onChange={(e) => setContracts(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Premium / Share</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number" step="0.0001" min="0" required
                value={premiumPerShare} onChange={(e) => setPremiumPerShare(e.target.value)}
                className={dollarInputClass}
              />
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">
            Stock Price at Open{" "}
            <span className="text-muted-foreground font-normal">
              {priceFetching ? "(fetching…)" : "(from Yahoo Finance)"}
            </span>
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.0001" min="0"
              value={stockPriceAtOpen} onChange={(e) => setStockPriceAtOpen(e.target.value)}
              placeholder={priceFetching ? "Fetching…" : ""}
              className={dollarInputClass}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium mb-1">Fees at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              type="number" step="0.01" min="0"
              value={feesOpen} onChange={(e) => setFeesOpen(e.target.value)}
              className={dollarInputClass}
            />
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Confirm & Open"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Open Positions Table ───────────────────────────────────────────────────────

interface OpenPositionsTableProps {
  positions: OptionsPosition[];
  draftPositions: OptionsPosition[];
  chainPnlMap: Map<string, number>;
  chainFirstOpenedMap: Map<string, number>;
  onEdit: (p: OptionsPosition) => void;
  onClose: (p: OptionsPosition) => void;
  onConfirm: (p: OptionsPosition) => void;
  onDelete: (p: OptionsPosition) => void;
  onPositionUpdated: () => void;
}

const COL_GROUPS = [
  { key: "details", label: "Details", count: 4 },
  { key: "return",  label: "Return",  count: 3 },
  { key: "risk",    label: "Risk",    count: 4 },
  { key: "live",    label: "Live",  count: 5 },
] as const;
type ColGroupKey = (typeof COL_GROUPS)[number]["key"];

function OpenPositionsTable({ positions, draftPositions, chainPnlMap, chainFirstOpenedMap, onEdit, onClose, onConfirm, onDelete, onPositionUpdated }: OpenPositionsTableProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<OptionsPosition | null>(null);
  // Trade Details and Live collapsed by default; Return and Risk visible
  const [openColGroups, setOpenColGroups] = useState<Set<ColGroupKey>>(new Set(["return", "risk"]));
  // Live data: auto-fetched stock prices; editing buffer for the inline prem field
  const [livePrices, setLivePrices] = useState<Map<string, number>>(new Map());
  const [editingPremId, setEditingPremId] = useState<string | null>(null);
  const [editingPremValue, setEditingPremValue] = useState("");
  const [fetchingQuotes, setFetchingQuotes] = useState<Set<string>>(new Set());
  const [quoteErrors, setQuoteErrors] = useState<Map<string, string>>(new Map());

  const fetchAllStockPrices = () => {
    const uniqueTickers = [...new Set([...positions, ...draftPositions].map((p) => p.ticker.symbol))];
    for (const ticker of uniqueTickers) {
      getTickerPrice(ticker)
        .then((r) => setLivePrices((prev) => new Map(prev).set(ticker, r.price)))
        .catch(() => {});
    }
  };

  const tickerKey = [...positions, ...draftPositions].map((p) => p.ticker.symbol).join(",");
  useEffect(() => {
    fetchAllStockPrices();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickerKey]);

  const isColOpen = (g: ColGroupKey) => openColGroups.has(g);
  const toggleColGroup = (g: ColGroupKey) =>
    setOpenColGroups((prev) => {
      const next = new Set(prev);
      next.has(g) ? next.delete(g) : next.add(g);
      return next;
    });

  const fetchQuoteForPosition = async (p: OptionsPosition) => {
    if (calcPosition(p).daysLeft < 0) return; // no chain data for expired options
    const expDate = new Date(p.expirationDate).toISOString().slice(0, 10);
    setFetchingQuotes((prev) => new Set(prev).add(p.id));
    setQuoteErrors((prev) => { const m = new Map(prev); m.delete(p.id); return m; });
    try {
      const quote = await getOptionQuote({
        symbol: p.ticker.symbol,
        type: p.optionType,
        strike: Number(p.strikePrice),
        expiration: expDate,
      });
      const lastPrice = quote.lastPrice;
      if (lastPrice != null) {
        await updateOptionsPosition(p.id, { currentPremiumPerShare: lastPrice });
        onPositionUpdated();
      } else {
        setQuoteErrors((prev) => new Map(prev).set(p.id, "No price available"));
      }
    } catch (e: any) {
      const msg = e?.message ?? "Failed to fetch";
      setQuoteErrors((prev) => new Map(prev).set(p.id, msg));
    } finally {
      setFetchingQuotes((prev) => { const s = new Set(prev); s.delete(p.id); return s; });
    }
  };

  const [refreshingAll, setRefreshingAll] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const fetchAllQuotes = async () => {
    setRefreshingAll(true);
    fetchAllStockPrices();
    const open = [...positions, ...draftPositions].filter((p) => p.status === "OPEN" && calcPosition(p).daysLeft >= 0);
    for (let i = 0; i < open.length; i++) {
      await fetchQuoteForPosition(open[i]);
      if (i < open.length - 1) await new Promise((r) => setTimeout(r, 150));
    }
    setLastFetchedAt(new Date());
    setRefreshingAll(false);
  };

  // Auto-fetch quotes once when positions first load
  const positionIdsKey = [...positions, ...draftPositions].filter((p) => p.status === "OPEN").map((p) => p.id).join(",");
  useEffect(() => {
    if (!positionIdsKey) return;
    fetchAllQuotes();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionIdsKey]);

  if (positions.length === 0 && draftPositions.length === 0) {
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

  // Sort drafts: expired first, then expiration asc, ticker asc, strike asc, premium asc
  const sortedDrafts = [...draftPositions].sort((a, b) => {
    const ca = calcPosition({ ...a, openedAt: PAGE_LOAD_TIME });
    const cb = calcPosition({ ...b, openedAt: PAGE_LOAD_TIME });
    const aExpired = ca.daysLeft < 0, bExpired = cb.daysLeft < 0;
    if (aExpired !== bExpired) return aExpired ? -1 : 1;
    const expDiff = a.expirationDate.localeCompare(b.expirationDate);
    if (expDiff !== 0) return expDiff;
    const tickerDiff = a.ticker.symbol.localeCompare(b.ticker.symbol);
    if (tickerDiff !== 0) return tickerDiff;
    const strikeDiff = Number(a.strikePrice) - Number(b.strikePrice);
    if (strikeDiff !== 0) return strikeDiff;
    return Number(a.premiumPerShare) - Number(b.premiumPerShare);
  });

  // Sort: expired first, then expiration asc, ticker asc, strike asc, premium asc
  const sorted = [...positions].sort((a, b) => {
    const ca = calcPosition(a), cb = calcPosition(b);
    const aExpired = ca.daysLeft < 0, bExpired = cb.daysLeft < 0;
    if (aExpired !== bExpired) return aExpired ? -1 : 1;
    const expDiff = a.expirationDate.localeCompare(b.expirationDate);
    if (expDiff !== 0) return expDiff;
    const tickerDiff = a.ticker.symbol.localeCompare(b.ticker.symbol);
    if (tickerDiff !== 0) return tickerDiff;
    const strikeDiff = Number(a.strikePrice) - Number(b.strikePrice);
    if (strikeDiff !== 0) return strikeDiff;
    return Number(a.premiumPerShare) - Number(b.premiumPerShare);
  });

  // Group positions by their groupId (order preserved from sort above)
  const grouped = new Map<string | null, OptionsPosition[]>();
  for (const p of sorted) {
    const key = p.groupId ?? null;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(p);
  }

  // Total columns = 4 (position) + each group (expanded=full, collapsed=1) + 1 (actions)
  const totalCols =
    4 +
    COL_GROUPS.reduce((sum, g) => sum + (isColOpen(g.key) ? g.count : 1), 0) +
    1;

  const thClass = "px-2 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap";
  const renderRow = (p: OptionsPosition, isGrouped = false, isDraftRow = false) => {
    // For draft rows, substitute page-load time so duration/ann-return calculations are meaningful
    const calcP = isDraftRow ? { ...p, openedAt: PAGE_LOAD_TIME } : p;
    const c = calcPosition(calcP);
    const isExpired = c.daysLeft < 0;
    const priorPnl = p.groupId ? (chainPnlMap.get(p.groupId) ?? 0) : 0;
    const hasChain = p.groupId != null && priorPnl !== 0;
    const tdClass = hasChain ? "px-2 pt-2 pb-1 text-sm whitespace-nowrap" : "px-2 py-2 text-sm whitespace-nowrap";
    const chainNet = hasChain ? priorPnl + c.totalPremiumNet : null;

    // Live section
    const isEditingThisPrem = editingPremId === p.id;
    const curPrem = isEditingThisPrem
      ? (editingPremValue !== "" ? parseFloat(editingPremValue) : null)
      : p.currentPremiumPerShare ?? null;
    const stockNow = livePrices.get(p.ticker.symbol) ?? null;
    const livePnl = curPrem != null
      ? (p.premiumPerShare - curPrem) * 100 * p.contracts - (p.feesOpen ?? 0)
      : null;
    const chainLivePnl = hasChain && livePnl != null ? priorPnl + livePnl : null;
    const pctOtmNow = stockNow != null
      ? (p.strikePrice - stockNow) / stockNow * 100
      : null;
    const daysInTrade = (Date.now() - new Date(p.openedAt).getTime()) / 86_400_000;
    const curAnnRet = livePnl != null && c.capitalAtRisk > 0 && daysInTrade > 0
      ? (livePnl / c.capitalAtRisk) * (365 / daysInTrade) * 100
      : null;

    // Chain-level metrics
    const realBreakeven = hasChain ? c.breakeven - priorPnl / (p.contracts * 100) : null;
    const chainFirstMs = hasChain
      ? Math.min(chainFirstOpenedMap.get(p.groupId!) ?? Infinity, new Date(p.openedAt).getTime())
      : null;
    const chainDaysInTrade = chainFirstMs != null ? (Date.now() - chainFirstMs) / 86_400_000 : null;
    const chainCurAnnRet =
      chainLivePnl != null && c.capitalAtRisk > 0 && chainDaysInTrade != null && chainDaysInTrade > 0
        ? (chainLivePnl / c.capitalAtRisk) * (365 / chainDaysInTrade) * 100
        : null;

    const ctd = "px-2 pb-2 text-xs whitespace-nowrap text-muted-foreground";

    // Opaque equivalents of the tr's semi-transparent bg colors over white (#FFFFFF):
    //   bg-amber-50/50 → #FFFDF5; bg-muted/10 → #FEFEFE; bg-muted/30 → #FDFDFE
    const stickyBg = isExpired ? "bg-[#FFFDF5]" : isGrouped ? "bg-[#FEFEFE]" : "bg-white";
    const stickyTd = (leftPx: number, extra?: string) =>
      cn(tdClass, "sticky z-[2] group-hover:bg-[#FDFDFE]", stickyBg, extra);

    const primaryRow = (
      <tr key={p.id} className={cn("group", hasChain ? "" : "border-b border-border", "hover:bg-muted/30", isGrouped && "bg-muted/10", isExpired && "bg-amber-50/50", isDraftRow && "italic opacity-60")}>
        {/* ── Group 1: Position (always visible, frozen) ── */}
        <td style={{ left: 0 }}   className={stickyTd(0, isGrouped ? "pl-8 pr-2" : "pl-4 pr-2")}>
          <div className="flex items-center gap-1.5">
            <span className="font-medium">{p.ticker.symbol}</span>
            {p.group && <Link className="h-3 w-3 text-muted-foreground shrink-0" />}
          </div>
        </td>
        <td style={{ left: 80 }}  className={stickyTd(80)}>
          <span className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
            p.optionType === "CALL" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
          )}>
            {p.optionType === "CALL" ? "CC" : "CSP"}
          </span>
        </td>
        <td style={{ left: 152 }} className={stickyTd(152)}>${fmtUSD(p.strikePrice)}</td>
        <td style={{ left: 232 }} className={stickyTd(232, "border-r border-border/40")}>{fmtDate(p.expirationDate)}</td>

        {/* ── Group 2: Trade Details ── */}
        {isColOpen("details") ? (
          <>
            <td className={cn(tdClass, "border-l border-border/50")}>{p.contracts}</td>
            <td className={tdClass}>${fmtUSD(p.premiumPerShare)}</td>
            <td className={tdClass} title={isDraftRow ? undefined : fmtDateTimeFull(p.openedAt)}>
              {isDraftRow ? <span className="text-muted-foreground italic text-xs">Draft</span> : fmtDateTimeShort(p.openedAt)}
            </td>
            <td className={tdClass}>{fmt(p.stockPriceAtOpen, 2, "$")}</td>
          </>
        ) : (
          <td className={cn(tdClass, "border-l border-border/50 text-muted-foreground text-xs")}>
            {p.contracts} @ ${fmtUSD(p.premiumPerShare)}
          </td>
        )}

        {/* ── Group 3: Return ── */}
        {isColOpen("return") ? (
          <>
            <td className={cn(tdClass, "border-l border-border/50")}>${fmtUSD(c.totalPremiumNet)}</td>
            <td className={tdClass}>
              {c.daysLeft < 0 ? "Expired" : c.calDaysLeft === 0 ? "Today" : `${c.calDaysLeft}d`}
            </td>
            <td className={tdClass}>
              {c.annReturnAtExpiry != null
                ? <span className={cn(c.annReturnAtExpiry >= 0 ? "text-green-600" : "text-red-600")}>{fmtPct(c.annReturnAtExpiry)}</span>
                : "—"}
            </td>
          </>
        ) : (
          <td className={cn(tdClass, "border-l border-border/50 text-xs text-muted-foreground")}>
            ${fmtUSD(c.totalPremiumNet)}
            <span className="mx-1">·</span>
            {c.daysLeft < 0 ? "Exp" : c.calDaysLeft === 0 ? "Today" : `${c.calDaysLeft}d`}
          </td>
        )}

        {/* ── Group 4: Risk & Structure ── */}
        {isColOpen("risk") ? (
          <>
            <td className={cn(tdClass, "border-l border-border/50")}>{Math.round(c.durationDays)}d</td>
            <td className={tdClass}>{c.capitalAtRisk > 0 ? `$${c.capitalAtRisk.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "—"}</td>
            <td className={tdClass}>${fmtUSD(c.breakeven)}</td>
            <td className={tdClass}>
              {c.pctOtmAtOpen != null
                ? <span className={cn(c.pctOtmAtOpen <= 0 ? "text-green-600" : "text-red-600")}>{fmtPct(c.pctOtmAtOpen)}</span>
                : "—"}
            </td>
          </>
        ) : (
          <td className={cn(tdClass, "border-l border-border/50")}>
            {c.pctOtmAtOpen != null
              ? <span className={cn(c.pctOtmAtOpen <= 0 ? "text-green-600" : "text-red-600")}>{fmtPct(c.pctOtmAtOpen)}</span>
              : "—"}
          </td>
        )}

        {/* ── Group 5: Live ── */}
        {isColOpen("live") ? (
          <>
            <td className={cn(tdClass, "border-l border-border/50")}>
              {stockNow != null
                ? `$${fmtUSD(stockNow)}`
                : <span className="text-muted-foreground">—</span>}
            </td>
            <td className={tdClass}>
              <div className="flex items-center gap-1">
                {isEditingThisPrem ? (
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    autoFocus
                    value={editingPremValue}
                    onChange={(e) => setEditingPremValue(e.target.value)}
                    onBlur={async () => {
                      const val = editingPremValue !== "" ? parseFloat(editingPremValue) : null;
                      await updateOptionsPosition(p.id, { currentPremiumPerShare: val });
                      setEditingPremId(null);
                      onPositionUpdated();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") { setEditingPremId(null); }
                    }}
                    className="w-20 rounded border border-primary px-1 py-0.5 text-sm focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                ) : (
                  <span
                    onClick={() => { setEditingPremId(p.id); setEditingPremValue(p.currentPremiumPerShare?.toString() ?? ""); }}
                    className="cursor-pointer border-b border-dotted border-transparent hover:border-muted-foreground/50 text-sm"
                    title={quoteErrors.get(p.id) ? `Error: ${quoteErrors.get(p.id)}` : undefined}
                  >
                    {p.currentPremiumPerShare != null
                      ? <span className={quoteErrors.get(p.id) ? "text-red-500" : ""}>${fmtUSD(p.currentPremiumPerShare)}</span>
                      : <span className="text-muted-foreground">{quoteErrors.get(p.id) ? "err" : "—"}</span>}
                  </span>
                )}
                {!isExpired && (
                  <button
                    onClick={() => fetchQuoteForPosition(p)}
                    disabled={fetchingQuotes.has(p.id)}
                    title="Fetch live price from Yahoo Finance (delayed)"
                    className="p-0.5 rounded text-muted-foreground/30 hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
                  >
                    <RefreshCw className={cn("h-3 w-3", fetchingQuotes.has(p.id) && "animate-spin")} />
                  </button>
                )}
              </div>
            </td>
            <td className={tdClass}>
              {pctOtmNow != null
                ? <span className={cn(pctOtmNow <= 0 ? "text-green-600" : "text-red-600")}>{fmtPct(pctOtmNow)}</span>
                : <span className="text-muted-foreground">—</span>}
            </td>
            <td className={tdClass}>
              {curAnnRet != null
                ? <span className={cn(curAnnRet >= 0 ? "text-green-600" : "text-red-600")}>{fmtPct(curAnnRet)}</span>
                : <span className="text-muted-foreground">—</span>}
            </td>
            <td className={tdClass}>
              {livePnl != null
                ? <span className={cn("font-medium", livePnl >= 0 ? "text-green-600" : "text-red-600")}>
                    {livePnl >= 0 ? "+" : "−"}${fmtUSD(Math.abs(livePnl))}
                  </span>
                : <span className="text-muted-foreground">—</span>}
            </td>
          </>
        ) : (
          <td className={cn(tdClass, "border-l border-border/50")}>
            {livePnl != null
              ? <span className={cn("font-medium", livePnl >= 0 ? "text-green-600" : "text-red-600")}>
                  {livePnl >= 0 ? "+" : "−"}${fmtUSD(Math.abs(livePnl))}
                </span>
              : <span className="text-muted-foreground">—</span>}
          </td>
        )}

        {/* ── Actions ── */}
        <td className={tdClass}>
          <div className="flex items-center gap-0.5">
            {isDraftRow ? (
              <button onClick={() => onConfirm(p)} className="p-1.5 rounded text-primary/50 hover:text-primary hover:bg-primary/10 transition-colors" title="Confirm & open position">
                <PlayCircle className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button onClick={() => onClose(p)} className={cn("p-1.5 rounded transition-colors", isExpired ? "text-amber-500 hover:text-amber-600 hover:bg-amber-100/60" : "text-muted-foreground/40 hover:text-primary hover:bg-primary/10")} title="Close position">
                <CircleCheck className="h-3.5 w-3.5" />
              </button>
            )}
            <button onClick={() => onEdit(p)} className="p-1.5 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors" title="Edit">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setConfirmDelete(p)} className="p-1.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors" title="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </td>
      </tr>
    );

    const chainRow = hasChain ? (
      <tr key={`${p.id}-chain`} className={cn("group", "border-b border-border", isGrouped && "bg-muted/10", isExpired && "bg-amber-50/50")}>
        {/* Label — frozen */}
        <td style={{ left: 0 }}   className={cn(ctd, "sticky z-[2] group-hover:bg-[#FDFDFE]", stickyBg, isGrouped ? "pl-8 pr-2" : "pl-4 pr-2", "font-medium text-muted-foreground/60 uppercase tracking-wide text-[10px]")}>chain</td>
        <td style={{ left: 80 }}  className={cn(ctd, "sticky z-[2] group-hover:bg-[#FDFDFE]", stickyBg)} />
        <td style={{ left: 152 }} className={cn(ctd, "sticky z-[2] group-hover:bg-[#FDFDFE]", stickyBg)} />
        <td style={{ left: 232 }} className={cn(ctd, "sticky z-[2] group-hover:bg-[#FDFDFE] border-r border-border/40", stickyBg)} />

        {/* Details group — chain net per-share in Premium column */}
        {isColOpen("details") ? (
          <>
            <td className={cn(ctd, "border-l border-border/50")} />
            <td className={ctd}>
              {chainNet != null && `$${fmtUSD(chainNet / (p.contracts * 100))} net`}
            </td>
            <td className={ctd} />
            <td className={ctd} />
          </>
        ) : (
          <td className={cn(ctd, "border-l border-border/50")}>
            {chainNet != null && `${p.contracts} @ $${fmtUSD(chainNet / (p.contracts * 100))} net`}
          </td>
        )}

        {/* Return group — chain net total prem */}
        {isColOpen("return") ? (
          <>
            <td className={cn(ctd, "border-l border-border/50")}>
              {chainNet != null && (
                <span className={cn(chainNet >= 0 ? "text-green-600" : "text-red-600")}>
                  {chainNet >= 0 ? "+" : "−"}${fmtUSD(Math.abs(chainNet))}
                </span>
              )}
            </td>
            <td className={ctd} />
            <td className={ctd} />
          </>
        ) : (
          <td className={cn(ctd, "border-l border-border/50")}>
            {chainNet != null && (
              <span className={cn(chainNet >= 0 ? "text-green-600" : "text-red-600")}>
                {chainNet >= 0 ? "+" : "−"}${fmtUSD(Math.abs(chainNet))}
              </span>
            )}
          </td>
        )}

        {/* Risk group — real breakeven */}
        {isColOpen("risk") ? (
          <>
            <td className={cn(ctd, "border-l border-border/50")} />
            <td className={ctd} />
            <td className={ctd}>
              {realBreakeven != null && (
                <span>${fmtUSD(realBreakeven)}</span>
              )}
            </td>
            <td className={ctd} />
          </>
        ) : (
          <td className={cn(ctd, "border-l border-border/50")} />
        )}

        {/* Live group — chain ann. ret + chain live P&L */}
        {isColOpen("live") ? (
          <>
            <td className={cn(ctd, "border-l border-border/50")} />
            <td className={ctd} />
            <td className={ctd} />
            <td className={ctd}>
              {chainCurAnnRet != null && (
                <span className={cn("font-medium", chainCurAnnRet >= 0 ? "text-green-600" : "text-red-600")}>
                  {fmtPct(chainCurAnnRet)}
                </span>
              )}
            </td>
            <td className={ctd}>
              {chainLivePnl != null && (
                <span className={cn("font-medium", chainLivePnl >= 0 ? "text-green-600" : "text-red-600")}>
                  {chainLivePnl >= 0 ? "+" : "−"}${fmtUSD(Math.abs(chainLivePnl))}
                </span>
              )}
            </td>
          </>
        ) : (
          <td className={cn(ctd, "border-l border-border/50")}>
            {chainLivePnl != null && (
              <span className={cn("font-medium", chainLivePnl >= 0 ? "text-green-600" : "text-red-600")}>
                {chainLivePnl >= 0 ? "+" : "−"}${fmtUSD(Math.abs(chainLivePnl))}
              </span>
            )}
          </td>
        )}

        {/* Actions — empty */}
        <td className={ctd} />
      </tr>
    ) : null;

    return <>{primaryRow}{chainRow}</>;
  };

  return (
    <>
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse min-w-[700px]">
        <colgroup>
          <col style={{ width: '80px', minWidth: '80px' }} />{/* Ticker — sticky */}
          <col style={{ width: '72px', minWidth: '72px' }} />{/* Type — sticky */}
          <col style={{ width: '80px', minWidth: '80px' }} />{/* Strike — sticky */}
          <col style={{ width: '96px', minWidth: '96px' }} />{/* Expiration — sticky */}
        </colgroup>
        <thead className="bg-white">
          {/* ── Row 1: group headers ── */}
          <tr className="bg-muted/20">
            {/* Position — always visible, no toggle */}
            <th colSpan={4} style={{ left: 0 }} className="sticky z-[3] bg-[#FEFEFE] px-3 pt-2 pb-1 text-left text-[11px] font-medium text-muted-foreground/60 tracking-wide uppercase" />
            {/* Collapsible groups */}
            {COL_GROUPS.map(({ key, label, count }) => (
              <th
                key={key}
                colSpan={isColOpen(key) ? count : 1}
                onClick={() => toggleColGroup(key)}
                className={cn(
                  "px-3 pt-2 pb-1 text-left text-[11px] font-medium tracking-wide uppercase cursor-pointer select-none transition-colors",
                  "border-l border-border/50",
                  isColOpen(key)
                    ? "text-muted-foreground/70 hover:text-muted-foreground"
                    : "text-muted-foreground/50 hover:text-muted-foreground/80"
                )}
              >
                <div className="flex items-center gap-1">
                  {label}
                  {isColOpen(key)
                    ? <ChevronUp className="h-3 w-3 shrink-0" />
                    : <ChevronDown className="h-3 w-3 shrink-0" />}
                </div>
              </th>
            ))}
            <th className="pt-2 pb-1" />
          </tr>
          {/* ── Row 2: column headers ── */}
          <tr className="border-b border-border bg-muted/30">
            <th style={{ left: 0 }}   className={cn(thClass, "sticky z-[3] bg-[#FDFDFE] pl-4 pr-2")}>Ticker</th>
            <th style={{ left: 80 }}  className={cn(thClass, "sticky z-[3] bg-[#FDFDFE]")}>Type</th>
            <th style={{ left: 152 }} className={cn(thClass, "sticky z-[3] bg-[#FDFDFE]")}>Strike</th>
            <th style={{ left: 232 }} className={cn(thClass, "sticky z-[3] bg-[#FDFDFE] border-r border-border/40")}>Expiration</th>
            {isColOpen("details") ? (
              <>
                <th className={cn(thClass, "border-l border-border/50")}>Contracts</th>
                <th className={thClass}>Premium</th>
                <th className={thClass}>Opened</th>
                <th className={thClass}>Stock @ Open</th>
              </>
            ) : (
              <th className={cn(thClass, "border-l border-border/50 text-muted-foreground/40 italic")}>Contracts</th>
            )}
            {isColOpen("return") ? (
              <>
                <th className={cn(thClass, "border-l border-border/50")}>Total Prem</th>
                <th className={thClass}>Days Left</th>
                <th className={thClass}>Ann. Return</th>
              </>
            ) : (
              <th className={cn(thClass, "border-l border-border/50 text-muted-foreground/40 italic")}>Total Prem</th>
            )}
            {isColOpen("risk") ? (
              <>
                <th className={cn(thClass, "border-l border-border/50")}>Duration</th>
                <th className={thClass}>Capital @ Risk</th>
                <th className={thClass}>Breakeven</th>
                <th className={thClass}>% to Strike</th>
              </>
            ) : (
              <th className={cn(thClass, "border-l border-border/50 text-muted-foreground/40 italic")}>% to Strike</th>
            )}
            {isColOpen("live") ? (
              <>
                <th className={cn(thClass, "border-l border-border/50")}>Stock Now</th>
                <th className={thClass}>Cur. Prem</th>
                <th className={thClass}>% OTM Now</th>
                <th className={thClass}>Cur. Ann. Ret</th>
                <th className={thClass}>Live P&L</th>
              </>
            ) : (
              <th className={cn(thClass, "border-l border-border/50 text-muted-foreground/40 italic")}>Live P&L</th>
            )}
            <th className={thClass} />
          </tr>
        </thead>
        <tbody>
          {/* ── Draft section ── */}
          {sortedDrafts.length > 0 && (
            <tr className="bg-muted/40 border-y border-border">
              <td colSpan={4} className="py-1.5 pl-4 sticky left-0 z-[2] bg-[#FCFDFE]">
                <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Draft Positions</span>
              </td>
              <td colSpan={totalCols - 4} className="py-1.5 pr-4 text-right">
                <span className="text-xs text-muted-foreground font-normal">Not included in totals · click <PlayCircle className="inline h-3 w-3 mb-0.5" /> to confirm &amp; open</span>
              </td>
            </tr>
          )}
          {sortedDrafts.map((p) => renderRow(p, false, true))}

          {/* ── Open section header (only when both sections are non-empty) ── */}
          {sortedDrafts.length > 0 && sorted.length > 0 && (
            <tr className="bg-muted/40 border-y border-border">
              <td colSpan={4} className="py-1.5 pl-4 sticky left-0 z-[2] bg-[#FCFDFE]">
                <span className="text-xs font-semibold text-foreground uppercase tracking-wide">Open Positions</span>
              </td>
              <td colSpan={totalCols - 4} />
            </tr>
          )}

          {/* ── Open positions ── */}
          {Array.from(grouped.entries()).map(([gid, grpPositions]) => {
            if (gid === null) {
              return grpPositions.map((p) => renderRow(p));
            }
            // Single open position in a group: render inline (no collapsible header)
            if (grpPositions.length === 1) {
              return renderRow(grpPositions[0]);
            }
            // Multiple open positions in the same group: collapsible group header
            const group = grpPositions[0].group;
            const groupLabel = group?.label ?? null;
            const isExpanded = expandedGroups.has(gid);
            return [
              <tr
                key={`group-${gid}`}
                className="border-b border-border bg-muted/20 cursor-pointer hover:bg-muted/40"
                onClick={() => toggleGroup(gid)}
              >
                <td colSpan={totalCols} className="px-3 py-1.5">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    <Link className="h-3.5 w-3.5 text-muted-foreground" />
                    {groupLabel ?? grpPositions[0].ticker.symbol}
                    <span className="text-muted-foreground font-normal">· {grpPositions.length} positions</span>
                  </div>
                </td>
              </tr>,
              ...(isExpanded ? grpPositions.map((p) => renderRow(p, true)) : []),
            ];
          })}
        </tbody>
      </table>
    </div>
    <div className="flex items-center justify-end gap-2 px-4 py-2 border-t border-border/50">
      <span className="text-xs text-muted-foreground">
        {lastFetchedAt != null ? (
          <>
            Prices as of{" "}
            {lastFetchedAt.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit", timeZone: "America/New_York" })}
            {" "}
            {lastFetchedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
            {" ET from Yahoo Finance (delayed)"}
          </>
        ) : (
          "Prices from Yahoo Finance (delayed)"
        )}
      </span>
      <button
        onClick={fetchAllQuotes}
        disabled={refreshingAll}
        className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 disabled:opacity-50 transition-colors"
      >
        <RefreshCw className={cn("h-3 w-3", refreshingAll && "animate-spin")} />
        Refresh all premiums
      </button>
    </div>
    {confirmDelete && createPortal(
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-sm rounded-lg bg-background text-foreground p-6 shadow-xl">
          <h3 className="text-base font-semibold">Delete position?</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Delete {confirmDelete.ticker.symbol} ${confirmDelete.strikePrice} {confirmDelete.optionType}? This cannot be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { onDelete(confirmDelete); setConfirmDelete(null); }}>Delete</Button>
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
}

// ── Closed Positions Table ─────────────────────────────────────────────────────

interface ClosedPositionsTableProps {
  positions: OptionsPosition[];
  onEdit: (p: OptionsPosition) => void;
  onDelete: (p: OptionsPosition) => void;
}

const CLOSED_COL_GROUPS = [
  { key: "dates", label: "Dates", count: 3 },
  { key: "pnl",   label: "P&L",   count: 4 },
] as const;
type ClosedColGroupKey = (typeof CLOSED_COL_GROUPS)[number]["key"];

function ClosedPositionsTable({ positions, onEdit, onDelete }: ClosedPositionsTableProps) {
  const [confirmDelete, setConfirmDelete] = useState<OptionsPosition | null>(null);
  const [openColGroups, setOpenColGroups] = useState<Set<ClosedColGroupKey>>(new Set(["pnl"]));

  const isColOpen = (g: ClosedColGroupKey) => openColGroups.has(g);
  const toggleColGroup = (g: ClosedColGroupKey) =>
    setOpenColGroups((prev) => {
      const next = new Set(prev);
      next.has(g) ? next.delete(g) : next.add(g);
      return next;
    });

  if (positions.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No closed positions yet.
      </div>
    );
  }

  const sorted = [...positions].sort((a, b) => {
    const expDiff = a.expirationDate.localeCompare(b.expirationDate);
    if (expDiff !== 0) return expDiff;
    const tickerDiff = a.ticker.symbol.localeCompare(b.ticker.symbol);
    if (tickerDiff !== 0) return tickerDiff;
    const strikeDiff = Number(a.strikePrice) - Number(b.strikePrice);
    if (strikeDiff !== 0) return strikeDiff;
    return Number(a.premiumPerShare) - Number(b.premiumPerShare);
  });

  const outcomeLabel: Record<string, string> = {
    EXPIRED_WORTHLESS: "Expired Worthless",
    CLOSED_EARLY: "Closed Early",
    ROLLED: "Rolled",
    ASSIGNED: "Assigned",
  };

  const thClass = "px-2 py-2 text-left text-xs font-medium text-muted-foreground whitespace-nowrap";
  const tdClass = "px-2 py-2 text-sm whitespace-nowrap";

  return (
    <>
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse min-w-[700px]">
        <colgroup>
          <col style={{ width: '80px', minWidth: '80px' }} />{/* Ticker — sticky */}
          <col style={{ width: '72px', minWidth: '72px' }} />{/* Type — sticky */}
          <col style={{ width: '80px', minWidth: '80px' }} />{/* Strike — sticky */}
          <col style={{ width: '96px', minWidth: '96px' }} />{/* Expiration — sticky */}
          <col style={{ width: '72px', minWidth: '72px' }} />{/* Contracts — sticky */}
        </colgroup>
        <thead className="bg-white">
          {/* ── Row 1: group headers ── */}
          <tr className="bg-muted/20">
            {/* Position + Contracts — always, no toggle */}
            <th colSpan={5} style={{ left: 0 }} className="sticky z-[3] bg-[#FEFEFE] px-3 pt-2 pb-1" />
            {/* Collapsible groups */}
            {CLOSED_COL_GROUPS.map(({ key, label, count }) => (
              <th
                key={key}
                colSpan={isColOpen(key) ? count : 1}
                onClick={() => toggleColGroup(key)}
                className={cn(
                  "px-3 pt-2 pb-1 text-left text-[11px] font-medium tracking-wide uppercase cursor-pointer select-none transition-colors",
                  "border-l border-border/50",
                  isColOpen(key)
                    ? "text-muted-foreground/70 hover:text-muted-foreground"
                    : "text-muted-foreground/50 hover:text-muted-foreground/80"
                )}
              >
                <div className="flex items-center gap-1">
                  {label}
                  {isColOpen(key) ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                </div>
              </th>
            ))}
            {/* Ann. Return, Outcome, Actions — always */}
            <th colSpan={3} className="pt-2 pb-1" />
          </tr>
          {/* ── Row 2: column headers ── */}
          <tr className="border-b border-border bg-muted/30">
            <th style={{ left: 0 }}   className={cn(thClass, "sticky z-[3] bg-[#FDFDFE] pl-4 pr-2")}>Ticker</th>
            <th style={{ left: 80 }}  className={cn(thClass, "sticky z-[3] bg-[#FDFDFE]")}>Type</th>
            <th style={{ left: 152 }} className={cn(thClass, "sticky z-[3] bg-[#FDFDFE]")}>Strike</th>
            <th style={{ left: 232 }} className={cn(thClass, "sticky z-[3] bg-[#FDFDFE]")}>Expiration</th>
            <th style={{ left: 328 }} className={cn(thClass, "sticky z-[3] bg-[#FDFDFE] border-r border-border/40")}>Contracts</th>
            {/* Dates group */}
            {isColOpen("dates") ? (
              <>
                <th className={cn(thClass, "border-l border-border/50")}>Opened</th>
                <th className={thClass}>Closed</th>
                <th className={thClass}>Days in Trade</th>
              </>
            ) : (
              <th className={cn(thClass, "border-l border-border/50 text-muted-foreground/40 italic")}>Days in Trade</th>
            )}
            {/* P&L group */}
            {isColOpen("pnl") ? (
              <>
                <th className={cn(thClass, "border-l border-border/50")}>Open Prem</th>
                <th className={thClass}>Close Prem</th>
                <th className={thClass}>Total Fees</th>
                <th className={thClass}>P/L</th>
              </>
            ) : (
              <th className={cn(thClass, "border-l border-border/50 text-muted-foreground/40 italic")}>P/L</th>
            )}
            <th className={thClass}>Ann. Return</th>
            <th className={thClass}>Outcome</th>
            <th className={thClass} />
          </tr>
        </thead>
        <tbody>
          {(() => {
            // Group sorted rows by close week (keyed by Monday of that week).
            // Use closedAt when present; fall back to expirationDate for expired-worthless positions.
            const weekGroups: Array<{ monday: string; label: string; positions: typeof sorted }> = [];
            for (const p of sorted) {
              const closeDateStr = p.closedAt ? p.closedAt.split("T")[0] : p.expirationDate.split("T")[0];
              const expDay = new Date(closeDateStr + "T00:00:00Z");
              const dow = expDay.getUTCDay(); // 0=Sun … 6=Sat
              const monday = new Date(expDay);
              monday.setUTCDate(expDay.getUTCDate() - (dow === 0 ? 6 : dow - 1));
              const friday = new Date(monday);
              friday.setUTCDate(monday.getUTCDate() + 4);
              const key = monday.toISOString().slice(0, 10);
              const monLabel = monday.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
              const friLabel = friday.toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" });
              const year = friday.getUTCFullYear();
              const label = `${monLabel} – ${friLabel}, ${year}`;
              const existing = weekGroups.find((g) => g.monday === key);
              if (existing) existing.positions.push(p);
              else weekGroups.push({ monday: key, label, positions: [p] });
            }

            return weekGroups.flatMap(({ label, positions }) => {
              const weekPnl = positions.reduce((sum, p) => sum + (calcPosition(p).pnl ?? 0), 0);
              return [
              <tr key={`week-${label}`} className="bg-muted/40 border-y border-border">
                <td colSpan={5} className="py-1.5 pl-4 sticky left-0 z-[2] bg-[#FCFDFE]">
                  <span className="text-xs font-semibold text-foreground uppercase tracking-wide">{label}</span>
                </td>
                <td colSpan={15} className="py-1.5 pr-4 text-right">
                  <span className={cn("text-xs font-semibold tabular-nums", weekPnl >= 0 ? "text-green-600" : "text-red-600")}>
                    {weekPnl >= 0 ? "+" : "−"}${Math.abs(weekPnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </td>
              </tr>,
              ...positions.map((p) => {
            const c = calcPosition(p);
            return (
              <tr key={p.id} className="group border-b border-border hover:bg-muted/30">
                {/* Position + Contracts — frozen */}
                <td style={{ left: 0 }}   className={cn(tdClass, "sticky z-[2] bg-white group-hover:bg-[#FDFDFE] pl-4 pr-2")}>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{p.ticker.symbol}</span>
                    {p.outcome === "ROLLED" && <Link className="h-3 w-3 text-muted-foreground shrink-0" />}
                  </div>
                </td>
                <td style={{ left: 80 }}  className={cn(tdClass, "sticky z-[2] bg-white group-hover:bg-[#FDFDFE]")}>
                  <span className={cn(
                    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                    p.optionType === "CALL" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                  )}>
                    {p.optionType === "CALL" ? "CC" : "CSP"}
                  </span>
                </td>
                <td style={{ left: 152 }} className={cn(tdClass, "sticky z-[2] bg-white group-hover:bg-[#FDFDFE]")}>${fmtUSD(p.strikePrice)}</td>
                <td style={{ left: 232 }} className={cn(tdClass, "sticky z-[2] bg-white group-hover:bg-[#FDFDFE]")}>{fmtDate(p.expirationDate)}</td>
                <td style={{ left: 328 }} className={cn(tdClass, "sticky z-[2] bg-white group-hover:bg-[#FDFDFE] border-r border-border/40")}>{p.contracts}</td>
                {/* Dates group */}
                {isColOpen("dates") ? (
                  <>
                    <td className={cn(tdClass, "border-l border-border/50")} title={fmtDateTimeFull(p.openedAt)}>{fmtDateTimeShort(p.openedAt)}</td>
                    <td className={tdClass} title={p.closedAt ? fmtDateTimeFull(p.closedAt) : undefined}>{p.closedAt ? fmtDateTimeShort(p.closedAt) : fmtDate(p.expirationDate)}</td>
                    <td className={tdClass}>{c.daysInTrade != null ? `${Math.round(c.daysInTrade)}d` : "—"}</td>
                  </>
                ) : (
                  <td className={cn(tdClass, "border-l border-border/50")}>
                    {c.daysInTrade != null ? `${Math.round(c.daysInTrade)}d` : "—"}
                  </td>
                )}
                {/* P&L group */}
                {isColOpen("pnl") ? (
                  <>
                    <td className={cn(tdClass, "border-l border-border/50")}>${fmtUSD(p.premiumPerShare)}</td>
                    <td className={tdClass}>
                      {p.outcome === "EXPIRED_WORTHLESS" || p.outcome === "ASSIGNED" ? "—" : fmt(p.closePremiumPerShare, 2, "$")}
                    </td>
                    <td className={tdClass}>${fmtUSD(c.totalFees)}</td>
                    <td className={tdClass}>
                      {c.pnl != null ? (
                        <span className={cn("font-medium", c.pnl >= 0 ? "text-green-600" : "text-red-600")}>
                          {c.pnl >= 0 ? "+" : "−"}${fmtUSD(Math.abs(c.pnl))}
                        </span>
                      ) : "—"}
                    </td>
                  </>
                ) : (
                  <td className={cn(tdClass, "border-l border-border/50")}>
                    {c.pnl != null ? (
                      <span className={cn("font-medium", c.pnl >= 0 ? "text-green-600" : "text-red-600")}>
                        {c.pnl >= 0 ? "+" : "−"}${fmtUSD(Math.abs(c.pnl))}
                      </span>
                    ) : "—"}
                  </td>
                )}
                {/* Always-visible trailing columns */}
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
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => onEdit(p)}
                      className="p-1.5 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"
                      title="Edit close details"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setConfirmDelete(p)}
                      className="p-1.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })];
            });
          })()}
        </tbody>
      </table>
    </div>
    {confirmDelete && createPortal(
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-sm rounded-lg bg-background text-foreground p-6 shadow-xl">
          <h3 className="text-base font-semibold">Delete position?</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Delete {confirmDelete.ticker.symbol} ${confirmDelete.strikePrice} {confirmDelete.optionType}? This cannot be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { onDelete(confirmDelete); setConfirmDelete(null); }}>Delete</Button>
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
}

// ── Performance Charts ─────────────────────────────────────────────────────────

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)); // back to Monday
  return d;
}

// Label a week by its Friday: M/D (e.g. "5/8")
function weekFridayLabel(mondayMs: number): string {
  const fri = new Date(mondayMs + 4 * 86_400_000);
  return `${fri.getMonth() + 1}/${fri.getDate()}`;
}

function PerformanceCharts({
  closedPositions,
  settings,
}: {
  closedPositions: OptionsPosition[];
  settings: OptionsSettings | null;
}) {
  const targetAnnual = settings ? settings.startingBasis * settings.targetReturn : null;
  const targetWeekly = targetAnnual != null ? targetAnnual / 52 : null;

  // Shared week-bucketed PnL map used by both charts
  const weekPnlMap = useMemo(() => {
    const map = new Map<number, number>(); // weekStartMs -> total pnl
    for (const p of closedPositions) {
      const closeDate = p.closedAt ? new Date(p.closedAt) : new Date(p.expirationDate.split("T")[0]);
      const ms = getWeekStart(closeDate).getTime();
      map.set(ms, (map.get(ms) ?? 0) + (calcPosition(p).pnl ?? 0));
    }
    return map;
  }, [closedPositions]);

  // First trade week: use the setting if provided, otherwise first week with a close
  const firstTradeWeekMs = useMemo(() => {
    if (settings?.startingWeek) {
      return getWeekStart(new Date(settings.startingWeek + "T12:00:00")).getTime();
    }
    if (weekPnlMap.size === 0) return null;
    return Math.min(...weekPnlMap.keys());
  }, [settings?.startingWeek, weekPnlMap]);

  const currentWeekMs = getWeekStart(new Date()).getTime();
  const projectionEndMs = currentWeekMs + 12 * 7 * 86_400_000;

  // Bar chart: W1 → current week + 12
  const weeklyData = useMemo(() => {
    if (firstTradeWeekMs == null) return [];
    const weeks: { week: string; premium: number; isFuture: boolean }[] = [];
    let weekNum = 0;
    for (let ms = firstTradeWeekMs; ms <= projectionEndMs; ms += 7 * 86_400_000) {
      weekNum++;
      weeks.push({
        week: weekFridayLabel(ms),
        premium: weekPnlMap.get(ms) ?? 0,
        isFuture: ms > currentWeekMs,
      });
    }
    return weeks;
  }, [firstTradeWeekMs, weekPnlMap, currentWeekMs, projectionEndMs]);

  // Cumulative chart: W1 → current week + 12
  // actual is null for future weeks so the line stops at the current week
  // target uses 1-based week number so W1 target = 1 × targetWeekly (not zero)
  const cumulativeData = useMemo(() => {
    if (firstTradeWeekMs == null) return [];
    let cumulative = 0;
    const points: { week: string; actual: number | null; target: number }[] = [];
    let weekNum = 0;
    for (let ms = firstTradeWeekMs; ms <= projectionEndMs; ms += 7 * 86_400_000) {
      weekNum++;
      const isPast = ms <= currentWeekMs;
      if (isPast) cumulative += weekPnlMap.get(ms) ?? 0;
      points.push({
        week: weekFridayLabel(ms),
        actual: isPast ? cumulative : null,
        target: targetAnnual != null ? (weekNum / 52) * targetAnnual : 0,
      });
    }
    return points;
  }, [firstTradeWeekMs, weekPnlMap, targetAnnual, currentWeekMs, projectionEndMs]);

  // Delta for the header: actual vs target at the last week with real data
  const lastDataPoint = [...cumulativeData].reverse().find((d) => d.actual != null);
  const delta = lastDataPoint != null ? lastDataPoint.actual! - lastDataPoint.target : null;

  if (closedPositions.length === 0) return null;

  const dollarTick = (v: number) =>
    v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;

  return (
    <div className="grid grid-cols-2 gap-4">
      {/* Weekly Premium Bar Chart */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Weekly Premium Collected</p>
          {targetWeekly != null && (
            <div className="flex items-center gap-1.5">
              <svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="var(--color-muted-foreground)" strokeWidth="1.5" strokeDasharray="4 3" strokeOpacity="0.7" /></svg>
              <span className="text-xs text-muted-foreground">Target ${fmtUSD(targetWeekly)}/wk</span>
            </div>
          )}
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={weeklyData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
            <XAxis
              dataKey="week"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={dollarTick}
              width={36}
            />
            <RechartsTooltip
              cursor={{ fill: "var(--color-muted)" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const val = payload[0].value as number;
                return (
                  <div className="rounded border border-border bg-background p-2 text-xs shadow-md">
                    <p className="mb-1 font-medium">{label}</p>
                    <p style={{ color: "var(--color-primary)" }}>Premium: ${fmtUSD(val)}</p>
                    {targetWeekly != null && (
                      <p className="mt-0.5 text-muted-foreground">Target: ${fmtUSD(targetWeekly)}</p>
                    )}
                  </div>
                );
              }}
            />
            <Bar
              dataKey="premium"
              radius={[3, 3, 0, 0]}
              maxBarSize={32}
              fill="var(--color-primary)"
              shape={(props: Record<string, unknown>) => {
                const { x, y, width, height, fill, isFuture } = props as {
                  x: number; y: number; width: number; height: number; fill: string; isFuture: boolean;
                };
                if (height <= 0) return <rect x={x} y={y} width={width} height={0} fill={fill} />;
                return <rect x={x} y={y} width={width} height={height} fill={fill} fillOpacity={isFuture ? 0 : 1} rx={3} />;
              }}
            />
            {targetWeekly != null && (
              <ReferenceLine
                y={targetWeekly}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 3"
                strokeWidth={1.5}
                strokeOpacity={0.7}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Cumulative Performance Chart */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cumulative Performance vs Target</p>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke="var(--color-primary)" strokeWidth="2" /></svg>
              <span className="text-xs text-muted-foreground">Actual</span>
            </div>
            {targetAnnual != null && (
              <div className="flex items-center gap-1.5">
                <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke="var(--color-muted-foreground)" strokeWidth="1.5" strokeDasharray="4 3" strokeOpacity="0.7" /></svg>
                <span className="text-xs text-muted-foreground">Target</span>
              </div>
            )}
          </div>
        </div>
        {delta != null && (
          <p className={cn("text-xs font-medium mb-2", delta >= 0 ? "text-green-600" : "text-red-600")}>
            {delta >= 0 ? "Ahead" : "Behind"} of target by ${fmtUSD(Math.abs(delta))}
          </p>
        )}
        <ResponsiveContainer width="100%" height={delta != null ? 164 : 180}>
          <ComposedChart data={cumulativeData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="cumulativeFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.2} />
                <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
            <XAxis
              dataKey="week"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={dollarTick}
              width={44}
            />
            <RechartsTooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const actual = payload.find((p) => p.dataKey === "actual");
                const target = payload.find((p) => p.dataKey === "target");
                return (
                  <div className="rounded border border-border bg-background p-2 text-xs shadow-md">
                    <p className="mb-1 font-medium">{label}</p>
                    {actual?.value != null && (
                      <p style={{ color: "var(--color-primary)" }}>Actual: ${fmtUSD(actual.value as number)}</p>
                    )}
                    {target?.value != null && (
                      <p className="mt-0.5 text-muted-foreground">Target: ${fmtUSD(target.value as number)}</p>
                    )}
                  </div>
                );
              }}
            />
            {/* Target line drawn first so actual renders on top */}
            <Line
              type="linear"
              dataKey="target"
              stroke="var(--color-muted-foreground)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              strokeOpacity={0.7}
              dot={false}
              connectNulls
            />
            {/* Actual: area fill + line with dots at each past week */}
            <Area
              type="linear"
              dataKey="actual"
              stroke="var(--color-primary)"
              strokeWidth={2}
              fill="url(#cumulativeFill)"
              dot={{ r: 3, fill: "var(--color-primary)", strokeWidth: 0 }}
              activeDot={{ r: 4, fill: "var(--color-primary)", strokeWidth: 0 }}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>
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

  // Annualized rate: cumulative pnl / basis over time elapsed since the starting week
  const annReturnFirstDate = (() => {
    if (settings?.startingWeek) {
      return getWeekStart(new Date(settings.startingWeek + "T12:00:00")).getTime();
    }
    const allDates = closedPositions.map((p) => new Date(p.openedAt).getTime());
    return allDates.length > 0 ? Math.min(...allDates) : null;
  })();
  const annReturn = (() => {
    if (!settings?.startingBasis || cumulativePremium === 0 || annReturnFirstDate == null) return null;
    const elapsedDays = (Date.now() - annReturnFirstDate) / 86_400_000;
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
      label: "Premium This Week",
      value: premiumThisWeek !== 0 ? `$${fmtUSD(premiumThisWeek)}` : "$0.00",
      sub: "Since Monday",
      valueClass: premiumThisWeek >= 0 ? "text-green-600" : "text-red-600",
    },
    {
      label: "Cumulative Premium",
      value: `$${fmtUSD(cumulativePremium)}`,
      sub: settings ? `Basis: $${Number(settings.startingBasis).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "Set starting basis in settings",
      valueClass: cumulativePremium >= 0 ? "text-green-600" : "text-red-600",
    },
    {
      label: "Ann. Rate of Return",
      value: annReturn != null ? fmtPct(annReturn) : "—",
      sub: annReturnFirstDate != null ? `since ${fmtDateTimeShort(new Date(annReturnFirstDate).toISOString())}` : "—",
      valueClass: annReturn != null ? (annReturn >= (settings?.targetReturn ?? 0) * 100 ? "text-green-600" : "text-amber-600") : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-4">
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
  const [editCloseModal, setEditCloseModal] = useState<OptionsPosition | null>(null);
  const [confirmDraftModal, setConfirmDraftModal] = useState<OptionsPosition | null>(null);
  const [settingsModal, setSettingsModal] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);

  const { refetch: refetchNotifications } = useNotifications();
  const { data: settings, refetch: refetchSettings } = useApi(getOptionsSettings, []);
  const { data: allPositions, refetch: refetchPositions } = useApi(getOptionsPositions, []);
  const { data: tickers, refetch: refetchTickers } = useApi(getOptionsTickers, []);
  const { data: groups, refetch: refetchGroups } = useApi(getOptionsGroups, []);

  const normalizedPositions = (allPositions ?? []).map(normalizePosition);
  const draftPositions = normalizedPositions.filter((p) => p.isDraft);
  const openPositions = normalizedPositions.filter((p) => p.status === "OPEN" && !p.isDraft);
  const closedPositions = normalizedPositions.filter((p) => p.status !== "OPEN");

  // Sum P&L and track earliest open date of all closed legs per group — used for chain metrics on open rolled positions
  const chainPnlMap = new Map<string, number>();
  const chainFirstOpenedMap = new Map<string, number>();
  for (const p of closedPositions) {
    if (!p.groupId) continue;
    const pnl = calcPosition(p).pnl;
    if (pnl != null) chainPnlMap.set(p.groupId, (chainPnlMap.get(p.groupId) ?? 0) + pnl);
    const ms = new Date(p.openedAt).getTime();
    const prev = chainFirstOpenedMap.get(p.groupId);
    if (prev == null || ms < prev) chainFirstOpenedMap.set(p.groupId, ms);
  }

  const openTickerMap = new Map<string, number>();
  for (const p of openPositions) {
    openTickerMap.set(p.ticker.symbol, (openTickerMap.get(p.ticker.symbol) ?? 0) + p.contracts);
  }
  const tradingWeekLabel = getTradingWeekLabel();
  const tickerSuffix = Array.from(openTickerMap.entries())
    .map(([sym, ct]) => `${sym} x${ct}`)
    .join(" · ");

  const refetchAll = useCallback(() => {
    refetchPositions();
    refetchTickers();
  }, [refetchPositions, refetchTickers]);

  const handleDelete = async (p: OptionsPosition) => {
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">Options Trading</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            <span>{tradingWeekLabel}</span>
            {tickerSuffix && <span className="ml-6">{tickerSuffix}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSettingsModal(true)}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Settings className="h-4 w-4" />
            Settings
          </button>
          <Button variant="secondary" className="border border-border" onClick={() => setImportModalOpen(true)}>
            <Upload className="h-4 w-4" /> Import
          </Button>
          <Button onClick={() => setPositionModal("new")}>
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

      {/* Performance Charts */}
      <PerformanceCharts
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
              draftPositions={draftPositions}
              chainPnlMap={chainPnlMap}
              chainFirstOpenedMap={chainFirstOpenedMap}
              onEdit={(p) => setPositionModal(p)}
              onClose={(p) => setCloseModal(p)}
              onConfirm={(p) => setConfirmDraftModal(p)}
              onDelete={handleDelete}
              onPositionUpdated={refetchPositions}
            />
          ) : (
            <ClosedPositionsTable
              positions={closedPositions}
              onEdit={(p) => setEditCloseModal(p)}
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
          onSaved={() => { setCloseModal(null); refetchPositions(); refetchGroups(); refetchNotifications(); }}
        />
      )}

      {editCloseModal && (
        <EditCloseModal
          position={editCloseModal}
          onClose={() => setEditCloseModal(null)}
          onSaved={() => { setEditCloseModal(null); refetchPositions(); refetchNotifications(); }}
          onEditPositionDetails={() => { setPositionModal(editCloseModal); setEditCloseModal(null); }}
        />
      )}

      {settingsModal && (
        <SettingsModal
          current={settings ?? null}
          onClose={() => setSettingsModal(false)}
          onSaved={() => { setSettingsModal(false); refetchSettings(); }}
        />
      )}

      {confirmDraftModal && (
        <ConfirmDraftModal
          position={confirmDraftModal}
          onClose={() => setConfirmDraftModal(null)}
          onSaved={() => { setConfirmDraftModal(null); refetchPositions(); }}
        />
      )}

      <ImportOptionsModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onComplete={() => { setImportModalOpen(false); refetchPositions(); refetchTickers(); }}
      />
    </div>
  );
}

// ── Import Modal ───────────────────────────────────────────────────────────────

interface ParsedOptionsRow {
  raw: string[];
  ticker: string;
  optionType: "CALL" | "PUT";
  strikePrice: number;
  expirationDate: string;
  openedAt: string;
  premiumPerShare: number;
  contracts: number;
  shareCostBasis: number | null;
  stockPriceAtOpen: number | null;
  feesOpen: number | null;
  notes: string | null;
  errors: string[];
}

// Returns { date: "YYYY-MM-DD", time: "HH:MM" | null } or null if unparseable.
// Handles YYYY-MM-DD, M/D/YYYY, M/D/YY, and optional " H:MM AM/PM" suffix.
function parseOpenedDate(s: string): { date: string; time: string | null } | null {
  s = s.trim();

  // Split off optional time suffix: "H:MM AM" / "HH:MM AM" / "H:MM" (24h)
  let datePart = s;
  let time: string | null = null;
  const timeMatch = s.match(/^(.+?)\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i);
  if (timeMatch) {
    datePart = timeMatch[1].trim();
    const rawTime = timeMatch[2].trim();
    const ampm = rawTime.match(/([AP]M)$/i);
    const [hStr, mStr] = rawTime.replace(/\s*[AP]M$/i, "").split(":");
    let h = parseInt(hStr, 10);
    const min = parseInt(mStr, 10);
    if (ampm) {
      if (ampm[1].toUpperCase() === "PM" && h !== 12) h += 12;
      if (ampm[1].toUpperCase() === "AM" && h === 12) h = 0;
    }
    time = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  // Parse date portion
  let date: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    date = datePart;
  } else {
    const m = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) {
      let year = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      date = `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
  }
  if (!date) return null;
  return { date, time };
}

function parseOptionDate(s: string): string | null {
  const r = parseOpenedDate(s);
  return r ? r.date : null;
}

function parseOptionCSVLine(line: string, delimiter: string): string[] {
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

function parseOptionType(s: string): "CALL" | "PUT" | null {
  const v = s.trim().toLowerCase();
  if (v === "call" || v === "c" || v === "cc") return "CALL";
  if (v === "put" || v === "p" || v === "csp") return "PUT";
  return null;
}

function ImportOptionsModal({ open, onClose, onComplete }: {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<"upload" | "preview" | "result">("upload");
  const [rows, setRows] = useState<ParsedOptionsRow[]>([]);
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
      const parsed: ParsedOptionsRow[] = [];

      for (let i = 1; i < lines.length; i++) {
        const fields = parseOptionCSVLine(lines[i], delimiter);
        if (fields.length < 7) continue;

        // Columns: Ticker, Type, Strike Price, Expiration, Date Opened, Premium, Contracts,
        //          Cost Basis (opt), Stock Price (opt), Fees (opt), Notes (opt)
        const [rawTicker, rawType, rawStrike, rawExp, rawDate, rawPremium, rawContracts,
          rawCostBasis, rawStockPrice, rawFees, rawNotes] = fields;
        const errors: string[] = [];

        const ticker = rawTicker?.trim().toUpperCase() || "";
        if (!ticker) errors.push("Missing ticker");
        else if (!/^[A-Z]{1,10}$/.test(ticker)) errors.push(`Invalid ticker "${ticker}"`);

        const optionType = parseOptionType(rawType ?? "");
        if (!optionType) errors.push(`Invalid type "${rawType?.trim()}" (expected CALL or PUT)`);

        const strikeStr = (rawStrike ?? "").replace(/[$,]/g, "");
        const strikePrice = parseFloat(strikeStr);
        if (isNaN(strikePrice) || strikePrice <= 0) errors.push("Invalid strike price");

        const expirationDate = parseOptionDate(rawExp ?? "");
        if (!expirationDate) errors.push("Invalid expiration date");

        const parsedOpened = parseOpenedDate(rawDate ?? "");
        if (!parsedOpened) errors.push("Invalid date opened");
        // If a time was provided treat it as ET wall-clock; otherwise default to noon ET (16:00 UTC)
        const openedAt = parsedOpened
          ? parsedOpened.time
            ? etToUtc(`${parsedOpened.date}T${parsedOpened.time}`)
            : `${parsedOpened.date}T16:00:00.000Z`
          : "";

        const premStr = (rawPremium ?? "").replace(/[$,]/g, "");
        const premiumPerShare = parseFloat(premStr);
        if (isNaN(premiumPerShare) || premiumPerShare <= 0) errors.push("Invalid premium");

        const contracts = parseInt((rawContracts ?? "").replace(/,/g, ""), 10);
        if (isNaN(contracts) || contracts <= 0) errors.push("Invalid contracts (must be positive integer)");

        const parsedCostBasis = rawCostBasis?.trim()
          ? parseFloat(rawCostBasis.replace(/[$,]/g, ""))
          : null;
        const shareCostBasis = parsedCostBasis != null && !isNaN(parsedCostBasis) && parsedCostBasis > 0
          ? parsedCostBasis : null;

        const parsedStockPrice = rawStockPrice?.trim()
          ? parseFloat(rawStockPrice.replace(/[$,]/g, ""))
          : null;
        const stockPriceAtOpen = parsedStockPrice != null && !isNaN(parsedStockPrice) && parsedStockPrice > 0
          ? parsedStockPrice : null;

        const parsedFees = rawFees?.trim()
          ? parseFloat(rawFees.replace(/[$,]/g, ""))
          : null;
        const feesOpen = parsedFees != null && !isNaN(parsedFees) && parsedFees !== 0
          ? Math.abs(parsedFees) : null;

        const notes = rawNotes?.trim() || null;

        parsed.push({
          raw: fields,
          ticker,
          optionType: optionType ?? "CALL",
          strikePrice: isNaN(strikePrice) ? 0 : strikePrice,
          expirationDate: expirationDate || (rawExp?.trim() ?? ""),
          openedAt,
          premiumPerShare: isNaN(premiumPerShare) ? 0 : premiumPerShare,
          contracts: isNaN(contracts) ? 0 : contracts,
          shareCostBasis,
          stockPriceAtOpen,
          feesOpen,
          notes,
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
      const payload = validRows.map((r) => ({
        tickerSymbol: r.ticker,
        optionType: r.optionType,
        strikePrice: r.strikePrice,
        expirationDate: r.expirationDate,
        openedAt: r.openedAt,
        premiumPerShare: r.premiumPerShare,
        contracts: r.contracts,
        shareCostBasis: r.shareCostBasis,
        stockPriceAtOpen: r.stockPriceAtOpen,
        feesOpen: r.feesOpen,
        notes: r.notes,
      }));
      const res = await importOptionsPositions(payload);
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
    <Modal open={open} onClose={onClose} title="Import Options">
      {step === "upload" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload a CSV or TSV file with these columns in order:
          </p>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono leading-relaxed">
            Ticker, Type, Strike Price, Expiration, Date Opened, Premium, Contracts,
            Cost Basis, Stock Price, Fees, Notes
          </div>
          <p className="text-xs text-muted-foreground">
            First row should be a header (it will be skipped). Dates can be YYYY-MM-DD or M/D/YYYY.
            Type accepts CALL, PUT, CC, or CSP. Cost Basis, Stock Price, Fees, and Notes are optional.
            Dates without a time are treated as noon Eastern Time.
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
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide">#</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide">Ticker</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide">Type</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide text-right">Strike</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide">Expiration</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide">Opened</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide text-right">Premium</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide text-right">Qty</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide text-right">Cost Basis</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide text-right">Stock Price</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide text-right">Fees</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide">Notes</th>
                  <th className="px-2 py-1.5 font-medium uppercase tracking-wide">Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const i = rows.indexOf(row);
                  return (
                    <tr key={i} className={`border-b border-border ${row.errors.length > 0 ? "bg-destructive/5" : ""}`}>
                      <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-1.5 font-medium">{row.ticker || "—"}</td>
                      <td className="px-2 py-1.5">{row.optionType}</td>
                      <td className="px-2 py-1.5 text-right">{row.strikePrice > 0 ? `$${row.strikePrice.toFixed(2)}` : "—"}</td>
                      <td className="px-2 py-1.5">{row.expirationDate || "—"}</td>
                      <td className="px-2 py-1.5">{row.openedAt ? new Date(row.openedAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric", year: "2-digit" }) : "—"}</td>
                      <td className="px-2 py-1.5 text-right">{row.premiumPerShare > 0 ? `$${row.premiumPerShare.toFixed(4)}` : "—"}</td>
                      <td className="px-2 py-1.5 text-right">{row.contracts > 0 ? row.contracts : "—"}</td>
                      <td className="px-2 py-1.5 text-right">{row.shareCostBasis != null ? `$${row.shareCostBasis.toFixed(2)}` : "—"}</td>
                      <td className="px-2 py-1.5 text-right">{row.stockPriceAtOpen != null ? `$${row.stockPriceAtOpen.toFixed(2)}` : "—"}</td>
                      <td className="px-2 py-1.5 text-right">{row.feesOpen != null ? `$${row.feesOpen.toFixed(2)}` : "—"}</td>
                      <td className="px-2 py-1.5 max-w-[120px] truncate text-muted-foreground">{row.notes || "—"}</td>
                      <td className="px-2 py-1.5">
                        {row.errors.length > 0 ? (
                          <span className="text-destructive" title={row.errors.join("; ")}>
                            <AlertCircle className="inline h-3 w-3" /> {row.errors[0]}
                          </span>
                        ) : (
                          <span className="text-green-600"><Check className="inline h-3 w-3" /></span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button type="button" variant="secondary" onClick={() => { setStep("upload"); setRows([]); }}>
              Back
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button
                type="button"
                disabled={validRows.length === 0 || importing}
                onClick={handleImport}
              >
                {importing ? "Importing..." : `Import ${validRows.length} Position${validRows.length !== 1 ? "s" : ""}`}
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
                {result.imported} position{result.imported !== 1 ? "s" : ""} imported successfully
              </p>
              {result.errors.length > 0 && (
                <p className="text-xs text-destructive mt-1">
                  {result.errors.length} row{result.errors.length !== 1 ? "s" : ""} failed on server
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

          <div className="flex justify-end pt-2">
            <Button type="button" onClick={onComplete}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
