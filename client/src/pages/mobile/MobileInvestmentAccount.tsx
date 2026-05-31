import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { AreaChart, Area, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import {
  ArrowLeft, LineChart, Plus, Trash2, Pencil, X,
  TrendingUp, TrendingDown, Banknote, Clock, ChevronRight,
} from "lucide-react";
import { useApi } from "@/hooks/useApi";
import {
  getInvestmentHoldings, getInvestmentActivity, getAccounts, updateAccount,
  createHolding, deleteHolding, createLot, updateLot, deleteLot,
  searchTickers, resolveTicker, getTickerPrice,
  getManualInvestments, createManualInvestment, updateManualInvestment,
  getInvestmentGrowth, getPendingDividends, dismissPendingDividend, refreshPrices,
} from "@/api";
import { ApiError } from "@/api/client";
import { formatCurrency, formatDate, toDateInputValue, localToday, cn } from "@/lib/utils";
import { isPriceRefreshNeeded } from "@/lib/priceUtils";
import { useNotifications } from "@/context/NotificationContext";
import { useDemo } from "@/context/DemoContext";
import { scaleGrowthPoints, scaleHolding, scaleManuals } from "@/lib/demo";
import type {
  InvestmentHolding, InvestmentLot, TickerSearchResult,
  ManualInvestment, InvestmentActivity, GrowthPoint,
} from "@/types";
import { BeaconLoader } from "@/components/BeaconLoader";
import { SectionLabel, StatValue, DisplayStat } from "@/components/Typography";

// ── Constants & types ─────────────────────────────────────────────────────────


type ChartDuration = "WTD" | "MTD" | "YTD";

interface LotFormRow {
  quantity: string;
  costPerShare: string;
  acquiredDate: string;
}

// ── Utility functions ─────────────────────────────────────────────────────────

function durationStartDate(duration: ChartDuration): string {
  const now = new Date();
  if (duration === "WTD") {
    const diff = (now.getDay() + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diff);
    return monday.toLocaleDateString("en-CA");
  }
  if (duration === "MTD")
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return `${now.getFullYear()}-01-01`;
}

function easternTZAbbr(dateStr: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "short",
    }).formatToParts(new Date(dateStr + "T17:00:00Z"));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "ET";
  } catch {
    return "ET";
  }
}

function computeLotGains(
  quantity: string,
  costPerShare: string,
  acquiredDate: string | null,
  currentPrice: number | null,
) {
  const qty = parseFloat(quantity.replace(/,/g, ""));
  const cps = parseFloat(costPerShare.replace(/,/g, ""));
  const totalCost = qty * cps;
  if (currentPrice == null) return { totalCost, marketValue: null, totalGain: null };
  const marketValue = qty * currentPrice;
  const totalGain = marketValue - totalCost;
  if (acquiredDate == null) return { totalCost, marketValue, totalGain, shortTermGain: null, longTermGain: null };
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const isShortTerm = new Date(acquiredDate) > oneYearAgo;
  const gain = (currentPrice - cps) * qty;
  return {
    totalCost,
    marketValue,
    totalGain,
    shortTermGain: isShortTerm ? gain : null,
    longTermGain: isShortTerm ? null : gain,
  };
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
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
  }, [active]);
}

// ── Shared presentational helpers ─────────────────────────────────────────────

function GainText({ value, pct, size = "sm" }: { value: number | null; pct?: number | null; size?: "sm" | "base" }) {
  if (value == null) return <StatValue className="text-muted-foreground">—</StatValue>;
  const positive = value >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  const sizeClass = size === "base" ? "text-base font-semibold" : "text-sm font-medium";
  return (
    <span className={`inline-flex items-center gap-1 tabular-nums font-mono ${positive ? "text-up" : "text-down"} ${sizeClass}`}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {formatCurrency(Math.abs(value))}
      {pct != null && <span className="text-xs opacity-70">({Math.abs(pct).toFixed(2)}%)</span>}
    </span>
  );
}

// ── Ghost chart (empty-state placeholder) ─────────────────────────────────────

function GhostMobileGrowthChart() {
  return (
    <div className="select-none">
      <div className="flex gap-1 mb-2">
        {["WTD", "MTD", "YTD"].map((d) => (
          <span key={d} className="px-2 py-0.5 rounded text-xs font-medium text-muted-foreground/30">{d}</span>
        ))}
      </div>
      <div className="relative h-[120px] overflow-hidden">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full opacity-[0.15]"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="ghost-grad-mobile" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.6} />
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path
            d="M 0,75 C 8,70 12,60 20,55 C 28,50 32,65 42,52 C 52,39 56,48 68,32 C 78,18 88,22 100,12 L 100,100 L 0,100 Z"
            fill="url(#ghost-grad-mobile)"
          />
          <path
            d="M 0,75 C 8,70 12,60 20,55 C 28,50 32,65 42,52 C 52,39 56,48 68,32 C 78,18 88,22 100,12"
            fill="none"
            stroke="#6366f1"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="tp-caption text-center px-6">
            No data yet. Add dated lots to track growth over time.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Growth chart (simplified, market value only) ──────────────────────────────

function MobileGrowthChart({ accountId }: { accountId: string }) {
  const [duration, setDuration] = useState<ChartDuration>("YTD");
  const { data, loading } = useApi(() => getInvestmentGrowth(accountId), [accountId]);
  const { isDemoMode, demoFactor } = useDemo();

  const rawPoints = data?.points ?? [];
  const allPoints = useMemo(
    () => (isDemoMode ? scaleGrowthPoints(rawPoints, demoFactor) : rawPoints),
    [rawPoints, isDemoMode, demoFactor],
  );

  const points = useMemo(() => {
    if (!allPoints.length) return allPoints;
    const start = durationStartDate(duration);
    const idx = allPoints.findIndex((p: GrowthPoint) => p.date >= start);
    return idx <= 0 ? allPoints : allPoints.slice(idx);
  }, [allPoints, duration]);

  const periodGain = points.length >= 2
    ? points[points.length - 1].marketValue - points[0].marketValue
    : null;
  const periodGainPct = periodGain != null && points[0]?.marketValue > 0
    ? (periodGain / points[0].marketValue) * 100
    : null;

  if (!loading && allPoints.length === 0) return <GhostMobileGrowthChart />;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex gap-1">
          {(["WTD", "MTD", "YTD"] as ChartDuration[]).map((d) => (
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
          <span className={`text-13 font-semibold tabular-nums font-mono ${periodGain >= 0 ? "text-up" : "text-down"}`}>
            {periodGain >= 0 ? "+" : "−"}{formatCurrency(Math.abs(periodGain))}
            {periodGainPct != null && (
              <span className="text-xs ml-1 opacity-70">({Math.abs(periodGainPct).toFixed(2)}%)</span>
            )}
          </span>
        )}
      </div>

      {loading ? (
        <div className="h-[120px] flex items-center justify-center tp-caption">
          Loading…
        </div>
      ) : points.length === 0 ? (
        <div className="h-[120px] flex items-center justify-center tp-caption text-center px-4">
          No data for this period.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="mv-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis
              hide
              domain={[
                (dataMin: number) => dataMin * 0.97,
                (dataMax: number) => dataMax * 1.03,
              ]}
            />
            <Tooltip
              cursor={{ stroke: "#6366f1", strokeWidth: 1, strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const pt = payload[0].payload as GrowthPoint;
                return (
                  <div className="rounded-lg border border-border bg-background px-2.5 py-1.5 shadow-md text-xs">
                    <p className="text-muted-foreground mb-0.5">{formatDate(pt.date)}</p>
                    <StatValue as="p" className="font-semibold">{formatCurrency(pt.marketValue)}</StatValue>
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="marketValue"
              stroke="#6366f1"
              strokeWidth={1.5}
              fill="url(#mv-grad)"
              dot={false}
              isAnimationActive={false}
              baseValue="dataMin"
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── Cash edit sheet ───────────────────────────────────────────────────────────

function CashEditSheet({
  open,
  onClose,
  initialValue,
  updatedAt,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initialValue: number | null;
  updatedAt?: string | null;
  onSaved: (value: number | null) => Promise<void>;
}) {
  useBodyScrollLock(open);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setInput(initialValue != null ? String(initialValue) : "");
      setTimeout(() => inputRef.current?.focus(), 250);
    }
  }, [open, initialValue]);

  const handleSave = async () => {
    setSaving(true);
    const parsed = parseFloat(input.replace(/,/g, ""));
    const value = input.trim() === "" || isNaN(parsed) ? null : parsed;
    await onSaved(value);
    setSaving(false);
    onClose();
  };

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col rounded-t-2xl bg-background shadow-xl transition-transform duration-250 ease-out",
          open ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-border">
          <div>
            <h2 className="tp-panel-title">Settlement Cash</h2>
            {updatedAt && (
              <p className="tp-caption">
                Updated {new Date(updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-4 space-y-4 pb-8">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <input
              ref={inputRef}
              type="text"
              inputMode="decimal"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-md border border-border pl-7 pr-3 py-3 text-sm tabular-nums font-mono focus:border-primary focus:outline-none"
            />
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md border border-border bg-white/[.62] shadow-soft backdrop-blur-sm backdrop-saturate-[130%] py-3 text-sm font-medium text-muted-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex-1 rounded-md bg-gradient-to-b from-primary to-primary-deep py-3 text-sm font-medium border border-primary/60 shadow-accent text-white hover:brightness-105 active:brightness-95 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {initialValue != null && (
            <button
              type="button"
              onClick={() => onSaved(null).then(onClose)}
              className="w-full text-center tp-caption hover:text-down"
            >
              Clear cash balance
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ── Lot edit / add full-screen modal ──────────────────────────────────────────

function LotEditScreen({
  open,
  onClose,
  onSaved,
  lot,
  holdingId,
  currentPrice,
  managed,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  lot?: InvestmentLot;
  holdingId: string;
  currentPrice: number | null;
  managed: boolean;
}) {
  useBodyScrollLock(open);
  const [qty, setQty] = useState("");
  const [cps, setCps] = useState("");
  const [date, setDate] = useState(localToday());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setQty(lot ? lot.quantity : "");
      setCps(lot ? lot.costPerShare : "");
      setDate(lot?.acquiredDate ? toDateInputValue(lot.acquiredDate) : localToday());
      setError(null);
    }
  }, [open, lot]);

  const gains = useMemo(
    () => qty && cps ? computeLotGains(qty, cps, managed ? null : date || null, currentPrice) : null,
    [qty, cps, date, currentPrice, managed],
  );

  const handleSave = async () => {
    const qtyNum = parseFloat(qty.replace(/,/g, ""));
    const cpsNum = parseFloat(cps.replace(/,/g, ""));
    if (isNaN(qtyNum) || isNaN(cpsNum) || qtyNum <= 0 || cpsNum < 0) {
      setError("Enter a valid quantity and cost per share.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (lot) {
        await updateLot(lot.id, { quantity: qtyNum, costPerShare: cpsNum, acquiredDate: managed ? null : date || null });
      } else {
        await createLot({ holdingId, quantity: qtyNum, costPerShare: cpsNum, acquiredDate: managed ? null : date || null });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="tp-panel-title">{lot ? "Edit Lot" : "Add Purchase"}</h2>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
        {!managed && (
          <div>
            <label className="mb-1.5 block text-sm font-medium">Purchase Date</label>
            <input
              type="date"
              value={date}
              max={localToday()}
              onChange={(e) => setDate(e.target.value)}
              className="w-full appearance-none rounded-md border border-border px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none"
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Shares</label>
            <input
              type="text"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
              className={`w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none`}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Cost / Share</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={cps}
                onChange={(e) => setCps(e.target.value)}
                placeholder="0.00"
                className={`w-full rounded-md border border-border pl-7 pr-3 py-2.5 text-sm focus:border-primary focus:outline-none`}
              />
            </div>
          </div>
        </div>

        {gains && gains.totalCost > 0 && (
          <div className="rounded-md bg-muted/50 px-4 py-3 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total Cost</span>
              <StatValue className="font-medium">{formatCurrency(gains.totalCost)}</StatValue>
            </div>
            {gains.marketValue != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Market Value</span>
                <StatValue className="font-medium">{formatCurrency(gains.marketValue)}</StatValue>
              </div>
            )}
            {gains.totalGain != null && (
              <div className="flex justify-between border-t border-border pt-1.5 mt-1">
                <span className="text-muted-foreground">Unrealized Gain</span>
                <GainText value={gains.totalGain} />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-down">{error}</p>}
      </div>

      <div className="shrink-0 border-t border-border p-4 flex gap-3">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-md border border-border bg-white/[.62] shadow-soft backdrop-blur-sm backdrop-saturate-[130%] py-3 text-sm font-medium text-muted-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex-1 rounded-md bg-gradient-to-b from-primary to-primary-deep py-3 text-sm font-medium border border-primary/60 shadow-accent text-white hover:brightness-105 active:brightness-95 disabled:opacity-50"
        >
          {saving ? "Saving…" : lot ? "Save Changes" : "Add Purchase"}
        </button>
      </div>
    </div>
  );
}

// ── Holding detail bottom sheet ───────────────────────────────────────────────

function HoldingDetailSheet({
  holding,
  onClose,
  onUpdated,
  onDeleted,
}: {
  holding: InvestmentHolding | null;
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  useBodyScrollLock(holding != null);
  const [editingLot, setEditingLot] = useState<InvestmentLot | null>(null);
  const [addingLot, setAddingLot] = useState(false);
  const [deletingLotId, setDeletingLotId] = useState<string | null>(null);
  const [lotDeleteError, setLotDeleteError] = useState<string | null>(null);
  const [deletingHolding, setDeletingHolding] = useState(false);
  const [holdingDeleteError, setHoldingDeleteError] = useState<string | null>(null);
  const [confirmDeleteHolding, setConfirmDeleteHolding] = useState(false);

  useEffect(() => {
    if (!holding) {
      setEditingLot(null);
      setAddingLot(false);
      setDeletingLotId(null);
      setLotDeleteError(null);
      setDeletingHolding(false);
      setHoldingDeleteError(null);
      setConfirmDeleteHolding(false);
    }
  }, [holding]);

  const handleDeleteLot = async (lotId: string, force = false) => {
    setLotDeleteError(null);
    try {
      await deleteLot(lotId, force);
      onUpdated();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.data as any)?.code === "HAS_SALES") {
        setLotDeleteError((e.data as any).message ?? "This lot has associated sales.");
      } else {
        setLotDeleteError(e instanceof Error ? e.message : "Failed to delete lot.");
      }
    }
  };

  const handleDeleteHolding = async (force = false) => {
    setDeletingHolding(true);
    setHoldingDeleteError(null);
    try {
      await deleteHolding(holding!.id, force);
      onDeleted();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.data as any)?.code === "HAS_SALES") {
        setHoldingDeleteError((e.data as any).message ?? "This holding has associated sales.");
      } else {
        setHoldingDeleteError(e instanceof Error ? e.message : "Failed to delete holding.");
      }
      setDeletingHolding(false);
    }
  };

  const avgCostPerShare =
    holding && holding.totalQuantity > 0 && holding.totalCost > 0
      ? holding.totalCost / holding.totalQuantity
      : null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          holding ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col rounded-t-2xl bg-background shadow-xl transition-transform duration-250 ease-out max-h-[90vh]",
          holding ? "translate-y-0" : "translate-y-full",
        )}
      >
        {/* Drag handle */}
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />

        {/* Header */}
        <div className="flex items-start justify-between px-4 pb-3 shrink-0 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg">{holding?.ticker}</span>
              {holding?.type && (
                <span className="rounded bg-muted px-1.5 py-0.5 tp-caption">
                  {holding.type}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground truncate max-w-[260px]">{holding?.name}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent shrink-0">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable body */}
        {holding && (
          <div className="flex-1 overflow-y-auto overscroll-contain">
            <div className="p-4 space-y-4">

              {/* Key stats */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <div>
                  <SectionLabel className="mb-0.5">Price</SectionLabel>
                  <StatValue as="p" className="text-sm font-medium">
                    {holding.currentPrice != null ? formatCurrency(holding.currentPrice) : "—"}
                  </StatValue>
                </div>
                <div>
                  <SectionLabel className="mb-0.5">Shares</SectionLabel>
                  <StatValue as="p" className="text-sm font-medium">
                    {holding.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                  </StatValue>
                </div>
                <div>
                  <SectionLabel className="mb-0.5">Market Value</SectionLabel>
                  <StatValue as="p" className="text-sm font-medium">
                    {holding.marketValue != null ? formatCurrency(holding.marketValue) : "—"}
                  </StatValue>
                </div>
                <div>
                  <SectionLabel className="mb-0.5">Total Cost</SectionLabel>
                  <StatValue as="p" className="text-sm font-medium">{formatCurrency(holding.totalCost)}</StatValue>
                </div>
                <div>
                  <SectionLabel className="mb-0.5">Total Gain</SectionLabel>
                  <GainText value={holding.totalGain} pct={holding.totalGainPct} />
                </div>
                {avgCostPerShare != null && (
                  <div>
                    <SectionLabel className="mb-0.5">Avg Cost / Share</SectionLabel>
                    <StatValue as="p" className="text-sm font-medium">{formatCurrency(avgCostPerShare)}</StatValue>
                  </div>
                )}
              </div>

              {/* ST / LT gain breakdown */}
              {(holding.shortTermGain !== 0 || holding.longTermGain !== 0) && (
                <div className="rounded-md bg-muted/50 px-4 py-3 flex gap-6 text-sm">
                  <div>
                    <p className="tp-caption mb-0.5">Short-Term</p>
                    <GainText value={holding.shortTermGain} />
                  </div>
                  <div>
                    <p className="tp-caption mb-0.5">Long-Term</p>
                    <GainText value={holding.longTermGain} />
                  </div>
                </div>
              )}

              {/* Managed: aggregate-only view */}
              {holding.isManaged && (
                <button
                  type="button"
                  onClick={() => setAddingLot(true)}
                  className="w-full rounded-md border border-border py-2.5 text-sm font-medium text-foreground hover:bg-accent transition-colors"
                >
                  Update position
                </button>
              )}

              {/* Unmanaged: lot list */}
              {!holding.isManaged && (
                <div className="space-y-0">
                  <SectionLabel className="mb-2">Lots</SectionLabel>
                  <div className="divide-y divide-border border-t border-border">
                    {holding.lots.map((lot) => {
                      const gains = computeLotGains(lot.quantity, lot.costPerShare, lot.acquiredDate, holding.currentPrice);
                      const isDeletingThis = deletingLotId === lot.id;
                      return (
                        <div key={lot.id} className="py-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              {lot.acquiredDate && (
                                <p className="tp-caption mb-0.5">{formatDate(lot.acquiredDate)}</p>
                              )}
                              <div className="flex items-center gap-2 flex-wrap">
                                <StatValue className="text-sm">
                                  {parseFloat(lot.quantity).toLocaleString(undefined, { maximumFractionDigits: 8 })} sh
                                </StatValue>
                                <span className="tp-caption">
                                  @ {formatCurrency(parseFloat(lot.costPerShare))}/sh
                                </span>
                                <span className="tp-caption">
                                  = {formatCurrency(gains.totalCost)}
                                </span>
                              </div>
                              {gains.totalGain != null && (
                                <div className="mt-0.5">
                                  <GainText value={gains.totalGain} />
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                type="button"
                                onClick={() => setEditingLot(lot)}
                                className="rounded p-1.5 text-muted-foreground hover:bg-accent transition-colors"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setDeletingLotId(isDeletingThis ? null : lot.id);
                                  setLotDeleteError(null);
                                }}
                                className="rounded p-1.5 text-muted-foreground hover:text-down hover:bg-down/10 transition-colors"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>

                          {/* Lot delete confirmation */}
                          {isDeletingThis && (
                            <div className="mt-2 rounded-md bg-down/10 px-3 py-2.5 space-y-2">
                              {lotDeleteError ? (
                                <>
                                  <p className="text-xs text-down">{lotDeleteError}</p>
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      onClick={() => { setDeletingLotId(null); setLotDeleteError(null); }}
                                      className="flex-1 rounded border border-border py-1.5 text-xs font-medium"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteLot(lot.id, true)}
                                      className="flex-1 rounded bg-down py-1.5 text-xs font-medium text-white"
                                    >
                                      Delete Anyway
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <p className="text-xs font-medium">Delete this lot?</p>
                                  <div className="flex gap-2">
                                    <button
                                      type="button"
                                      onClick={() => setDeletingLotId(null)}
                                      className="flex-1 rounded border border-border py-1.5 text-xs font-medium"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteLot(lot.id)}
                                      className="flex-1 rounded bg-down py-1.5 text-xs font-medium text-white"
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => setAddingLot(true)}
                    className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                    Add purchase
                  </button>
                </div>
              )}

              {/* Delete holding */}
              <div className="border-t border-border pt-4">
                {!confirmDeleteHolding ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteHolding(true)}
                    className="w-full rounded-md border border-down/30 py-2.5 text-sm font-medium text-down hover:bg-down/10 transition-colors"
                  >
                    Delete holding
                  </button>
                ) : (
                  <div className="rounded-md bg-down/10 px-3 py-3 space-y-2">
                    {holdingDeleteError && (
                      <p className="text-xs text-down">{holdingDeleteError}</p>
                    )}
                    <p className="text-xs font-medium">
                      {holdingDeleteError ? "Delete anyway? This will orphan sale history." : `Delete ${holding.ticker} and all its lots?`}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => { setConfirmDeleteHolding(false); setHoldingDeleteError(null); }}
                        className="flex-1 rounded border border-border py-2 text-sm font-medium"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={deletingHolding}
                        onClick={() => handleDeleteHolding(!!holdingDeleteError)}
                        className="flex-1 rounded bg-down py-2 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {deletingHolding ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Lot add / edit full-screen */}
      <LotEditScreen
        open={addingLot || editingLot != null}
        onClose={() => { setAddingLot(false); setEditingLot(null); }}
        onSaved={() => { setAddingLot(false); setEditingLot(null); onUpdated(); }}
        lot={editingLot ?? undefined}
        holdingId={holding?.id ?? ""}
        currentPrice={holding?.currentPrice ?? null}
        managed={holding?.isManaged ?? false}
      />
    </>
  );
}

// ── Activity detail bottom sheet ──────────────────────────────────────────────

function ActivityDetailSheet({
  activity,
  onClose,
}: {
  activity: InvestmentActivity | null;
  onClose: () => void;
}) {
  useBodyScrollLock(activity != null);

  const a = activity;
  const isPurchase = a?.type === "PURCHASE";
  const isSale = a?.type === "SALE";
  const fees = a?.fees ?? 0;
  const net = a ? a.amount - fees : 0;
  const gain = a ? (a.shortTermGain ?? 0) + (a.longTermGain ?? 0) : 0;

  const badgeClass = isSale
    ? "bg-blue-soft text-blue-deep"
    : isPurchase
    ? "bg-up-soft text-up-deep"
    : "bg-violet-soft text-violet-deep";
  const badgeLabel = isSale ? "Sale" : isPurchase ? "Purchase" : "Dividend";

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-[55] bg-black/40 transition-opacity duration-200",
          activity ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] flex flex-col rounded-t-2xl bg-background shadow-xl transition-transform duration-250 ease-out max-h-[80vh]",
          activity ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="mx-auto mt-3 mb-6 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div className="flex items-center justify-between px-4 pb-3 shrink-0 border-b border-border">
          <div className="flex items-center gap-2">
            {a && <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeClass}`}>{badgeLabel}</span>}
            {a && <span className="font-mono font-bold text-sm">{a.ticker}</span>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
            <X className="h-5 w-5" />
          </button>
        </div>

        {a && (
          <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-2.5 pb-8">
            <Row label="Date" value={formatDate(a.date)} />
            {a.shares != null && (
              <Row label="Shares" value={a.shares.toLocaleString(undefined, { maximumFractionDigits: 8 })} />
            )}
            {a.pricePerShare != null && (
              <Row label="Price / Share" value={formatCurrency(a.pricePerShare)} />
            )}
            <Row label="Gross" value={formatCurrency(a.amount)} />
            {!isPurchase && fees > 0 && (
              <Row label="Fees" value={`(${formatCurrency(fees)})`} muted />
            )}
            <Row
              label={isPurchase ? "Total Cost" : "Net Proceeds"}
              value={formatCurrency(isPurchase ? a.amount : net)}
              bold
            />
            {isSale && (
              <div className="flex items-center justify-between py-2 border-t border-border">
                <span className="text-sm text-muted-foreground">Gain / Loss</span>
                <GainText value={gain} size="base" />
              </div>
            )}
            {isSale && a.shortTermGain != null && a.longTermGain != null && (
              <div className="rounded-md bg-muted/50 px-3 py-2.5 flex gap-6 text-sm">
                <div>
                  <p className="tp-caption mb-0.5">Short-Term</p>
                  <GainText value={a.shortTermGain} />
                </div>
                <div>
                  <p className="tp-caption mb-0.5">Long-Term</p>
                  <GainText value={a.longTermGain} />
                </div>
              </div>
            )}
            {a.notes && (
              <div className="pt-1">
                <p className="tp-caption mb-0.5">Notes</p>
                <p className="text-sm">{a.notes}</p>
              </div>
            )}
            {(isSale || (!isPurchase && !isSale)) && (
              <p className="tp-caption pt-2 border-t border-border">
                To edit this transaction, use the desktop app.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function Row({ label, value, muted, bold }: { label: string; value: string; muted?: boolean; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm tabular-nums font-mono ${muted ? "text-muted-foreground" : ""} ${bold ? "font-semibold" : ""}`}>
        {value}
      </span>
    </div>
  );
}

// ── Ticker search (same behaviour as desktop) ─────────────────────────────────

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
  const [resolving, setResolving] = useState(false);
  const [emptyQuery, setEmptyQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setEmptyQuery("");
    if (!q.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await searchTickers(q);
        setResults(r);
        if (r.length === 0) setEmptyQuery(q.trim());
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 300);
  }, []);

  const handleResolve = async () => {
    const ticker = emptyQuery.toUpperCase();
    setResolving(true);
    try {
      const result = await resolveTicker(ticker);
      onSelect(result);
    } catch {
      onSelect({ ticker, name: ticker, type: "Mutual Fund", exchange: "" });
    } finally { setResolving(false); }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); search(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Search ticker or name (e.g. AAPL, Vanguard S&P)"
        className="w-full rounded-md border border-primary px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      {loading && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 tp-caption">Searching…</span>
      )}
      {results.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 rounded-md border border-border bg-background shadow-lg max-h-72 overflow-y-auto">
          {results.map((r) => (
            <button
              key={r.ticker}
              className="w-full flex items-center justify-between px-3 py-3 text-left hover:bg-accent transition-colors"
              onClick={() => onSelect(r)}
            >
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-sm">{r.ticker}</span>
                <span className="tp-caption truncate">{r.name}</span>
              </div>
              <div className="flex items-center gap-2 tp-caption shrink-0 ml-3">
                <span className="rounded bg-muted px-1.5 py-0.5">{r.type}</span>
              </div>
            </button>
          ))}
        </div>
      )}
      {!loading && emptyQuery.length > 0 && results.length === 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 rounded-md border border-border bg-background shadow-lg">
          <div className="px-3 py-2.5 text-sm text-muted-foreground border-b border-border">
            No results for "{emptyQuery}"
          </div>
          <button
            onClick={handleResolve}
            disabled={resolving}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-accent transition-colors disabled:opacity-60"
          >
            <Plus className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="text-sm">
              {resolving ? `Looking up ${emptyQuery.toUpperCase()}…` : `Add "${emptyQuery.toUpperCase()}" as a ticker`}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Add investment full-screen modal ──────────────────────────────────────────

function AddInvestmentFullscreen({
  open,
  onClose,
  onSaved,
  accountId,
  existingHoldings,
  managed,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  accountId: string;
  existingHoldings: InvestmentHolding[];
  managed: boolean;
}) {
  useBodyScrollLock(open);
  const [step, setStep] = useState<"search" | "lots">("search");
  const [selected, setSelected] = useState<TickerSearchResult | null>(null);
  const [fetchedPrice, setFetchedPrice] = useState<number | null>(null);
  const [lots, setLots] = useState<LotFormRow[]>([{ quantity: "", costPerShare: "", acquiredDate: localToday() }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setStep("search");
      setSelected(null);
      setFetchedPrice(null);
      setLots([{ quantity: "", costPerShare: "", acquiredDate: localToday() }]);
      setError(null);
    }
  }, [open]);

  const handleSelect = async (r: TickerSearchResult) => {
    setSelected(r);
    setStep("lots");
    const existing = existingHoldings.find((h) => h.ticker === r.ticker);
    if (existing?.currentPrice != null) {
      setFetchedPrice(existing.currentPrice);
    } else {
      try {
        const data = await getTickerPrice(r.ticker);
        setFetchedPrice(data.price);
      } catch { /* non-fatal */ }
    }
  };

  const updateLot = (i: number, field: keyof LotFormRow, val: string) =>
    setLots((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: val } : l)));

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const holding = await createHolding({
        accountId,
        ticker: selected.ticker,
        name: selected.name,
        type: selected.type,
        group: null,
      });
      for (const lot of lots) {
        const qty = parseFloat(lot.quantity.replace(/,/g, ""));
        const cps = parseFloat(lot.costPerShare.replace(/,/g, ""));
        if (isNaN(qty) || isNaN(cps)) continue;
        await createLot({
          holdingId: holding.id,
          quantity: qty,
          costPerShare: cps,
          acquiredDate: managed ? null : (lot.acquiredDate || null),
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="tp-panel-title">
          {step === "search" ? "Add Investment" : `Add ${selected?.ticker}`}
        </h2>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
        {step === "search" && (
          <TickerSearch onSelect={handleSelect} onCancel={onClose} />
        )}

        {step === "lots" && selected && (
          <>
            {/* Ticker header */}
            <div className="flex items-center gap-3 rounded-md bg-muted/50 px-3 py-2.5">
              <button type="button" onClick={() => setStep("search")} className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <p className="font-semibold text-sm">{selected.ticker}</p>
                <p className="tp-caption truncate">{selected.name}</p>
              </div>
              {fetchedPrice != null && (
                <StatValue className="ml-auto text-sm text-muted-foreground shrink-0">
                  {formatCurrency(fetchedPrice)}
                </StatValue>
              )}
            </div>

            {/* Lot entries */}
            {lots.map((lot, i) => (
              <div key={i} className="space-y-3 rounded-md border border-border p-3">
                {lots.length > 1 && (
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground">Lot {i + 1}</p>
                    <button
                      type="button"
                      onClick={() => setLots((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-muted-foreground hover:text-down"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
                {!managed && (
                  <div>
                    <label className="mb-1 block text-sm font-medium">Purchase Date</label>
                    <input
                      type="date"
                      value={lot.acquiredDate}
                      max={localToday()}
                      onChange={(e) => updateLot(i, "acquiredDate", e.target.value)}
                      className="w-full appearance-none rounded-md border border-border px-3 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none"
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-sm font-medium">Shares</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={lot.quantity}
                      onChange={(e) => updateLot(i, "quantity", e.target.value)}
                      placeholder="0"
                      className={`w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none`}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Cost / Share</label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={lot.costPerShare}
                        onChange={(e) => updateLot(i, "costPerShare", e.target.value)}
                        placeholder="0.00"
                        className={`w-full rounded-md border border-border pl-7 pr-3 py-2.5 text-sm focus:border-primary focus:outline-none`}
                      />
                    </div>
                  </div>
                </div>
                {/* Gain preview per lot */}
                {lot.quantity && lot.costPerShare && fetchedPrice != null && (() => {
                  const g = computeLotGains(lot.quantity, lot.costPerShare, managed ? null : lot.acquiredDate || null, fetchedPrice);
                  if (!g.totalGain) return null;
                  return (
                    <div className="flex items-center justify-between tp-caption pt-1 border-t border-border">
                      <span>Unrealized gain</span>
                      <GainText value={g.totalGain} />
                    </div>
                  );
                })()}
              </div>
            ))}

            {!managed && (
              <button
                type="button"
                onClick={() => setLots((prev) => [...prev, { quantity: "", costPerShare: "", acquiredDate: localToday() }])}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
              >
                <Plus className="h-4 w-4" />
                Add another lot
              </button>
            )}

            {error && <p className="text-sm text-down">{error}</p>}
          </>
        )}
      </div>

      {step === "lots" && (
        <div className="shrink-0 border-t border-border p-4 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-border bg-white/[.62] shadow-soft backdrop-blur-sm backdrop-saturate-[130%] py-3 text-sm font-medium text-muted-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex-1 rounded-md bg-gradient-to-b from-primary to-primary-deep py-3 text-sm font-medium border border-primary/60 shadow-accent text-white hover:brightness-105 active:brightness-95 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Add Investment"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Add / edit manual investment full-screen modal ────────────────────────────

function AddManualFullscreen({
  open,
  onClose,
  onSaved,
  accountId,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  accountId: string;
  editing?: ManualInvestment;
}) {
  useBodyScrollLock(open);
  const [name, setName] = useState("");
  const [marketValue, setMarketValue] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setMarketValue(editing ? String(editing.marketValue) : "");
      setTotalCost(editing?.totalCost != null ? String(editing.totalCost) : "");
      setError(null);
    }
  }, [open, editing]);

  const parsedMV = parseFloat(marketValue.replace(/,/g, ""));
  const parsedCost = totalCost !== "" ? parseFloat(totalCost.replace(/,/g, "")) : null;
  const totalGain = parsedCost != null && !isNaN(parsedMV) ? parsedMV - parsedCost : null;

  const handleSave = async () => {
    if (!name.trim() || isNaN(parsedMV)) {
      setError("Name and market value are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = { name: name.trim(), group: null, totalCost: parsedCost, marketValue: parsedMV };
      if (editing) {
        await updateManualInvestment(editing.id, data);
      } else {
        await createManualInvestment({ accountId, ...data });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save.");
    } finally { setSaving(false); }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="tp-panel-title">{editing ? "Edit Manual Investment" : "Add Manual Investment"}</h2>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-muted-foreground hover:bg-accent">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Corp Series B"
            autoFocus
            className="w-full rounded-md border border-border px-3 py-2.5 text-sm focus:border-primary focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium">
              Total Cost <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
                placeholder="0.00"
                className={`w-full rounded-md border border-border pl-7 pr-3 py-2.5 text-sm focus:border-primary focus:outline-none`}
              />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">Market Value</label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={marketValue}
                onChange={(e) => setMarketValue(e.target.value)}
                placeholder="0.00"
                className={`w-full rounded-md border border-border pl-7 pr-3 py-2.5 text-sm focus:border-primary focus:outline-none`}
              />
            </div>
          </div>
        </div>

        {totalGain != null && (
          <div className="rounded-md bg-muted/50 px-4 py-2.5 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Total Gain</span>
            <GainText value={totalGain} />
          </div>
        )}

        {error && <p className="text-sm text-down">{error}</p>}
      </div>

      <div className="shrink-0 border-t border-border p-4 flex gap-3">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-md border border-border bg-white/[.62] shadow-soft backdrop-blur-sm backdrop-saturate-[130%] py-3 text-sm font-medium text-muted-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex-1 rounded-md bg-gradient-to-b from-primary to-primary-deep py-3 text-sm font-medium border border-primary/60 shadow-accent text-white hover:brightness-105 active:brightness-95 disabled:opacity-50"
        >
          {saving ? "Saving…" : editing ? "Save Changes" : "Add Investment"}
        </button>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export function MobileInvestmentAccount() {
  const { accountId } = useParams<{ accountId: string }>();
  const { notifications, refetch: refetchNotifications } = useNotifications();
  const hasActivityNotification = notifications?.pendingDividends.some((g) => g.accountId === accountId) ?? false;

  const [activeTab, setActiveTab] = useState<"holdings" | "activity">("holdings");

  // Sheet / modal state
  const [selectedHolding, setSelectedHolding] = useState<InvestmentHolding | null>(null);
  const [selectedActivity, setSelectedActivity] = useState<InvestmentActivity | null>(null);
  const [addInvestmentOpen, setAddInvestmentOpen] = useState(false);
  const [addManualOpen, setAddManualOpen] = useState(false);
  const [editingManual, setEditingManual] = useState<ManualInvestment | undefined>(undefined);
  const [cashSheetOpen, setCashSheetOpen] = useState(false);

  // Activity filters
  const [selectedTickers, setSelectedTickers] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

  // Data
  const { data: accounts, refetch: refetchAccounts } = useApi(() => getAccounts(), []);
  const { data: holdings, refetch: refetchHoldings } = useApi(
    () => getInvestmentHoldings(accountId!),
    [accountId],
  );
  const { data: manualInvestments, refetch: refetchManual } = useApi(
    () => getManualInvestments(accountId!),
    [accountId],
  );
  const { data: activities } = useApi(
    () => getInvestmentActivity(accountId!),
    [accountId],
  );
  const { data: pendingDividends, refetch: refetchDividends } = useApi(
    () => getPendingDividends(accountId!),
    [accountId],
  );

  // Auto-fetch missing prices
  const fetchedMissingRef = useRef<string>("");
  useEffect(() => {
    if (!holdings) return;
    const missing = holdings.filter((h) => h.currentPrice == null).map((h) => h.ticker);
    if (!missing.length) return;
    const key = [...missing].sort().join(",");
    if (fetchedMissingRef.current === key) return;
    fetchedMissingRef.current = key;
    Promise.allSettled(missing.map((t) => getTickerPrice(t))).then(() => refetchHoldings());
  }, [holdings, refetchHoldings]);

  const priceRefreshedRef = useRef(false);
  useEffect(() => {
    if (!holdings || priceRefreshedRef.current) return;
    if (isPriceRefreshNeeded(holdings)) {
      priceRefreshedRef.current = true;
      refreshPrices("MobileInvestmentAccount")
        .then(() => refetchHoldings())
        .catch(() => {});
    }
  }, [holdings, refetchHoldings]);

  const { isDemoMode, demoFactor } = useDemo();

  const sortedHoldings = useMemo(() => {
    if (!holdings) return [];
    const TYPE_ORDER: Record<string, number> = { "Mutual Fund": 0, "ETF": 1 };
    return [...holdings].sort((a, b) => {
      const rankDiff = (TYPE_ORDER[a.type ?? ""] ?? 2) - (TYPE_ORDER[b.type ?? ""] ?? 2);
      return rankDiff !== 0 ? rankDiff : (a.ticker ?? "").localeCompare(b.ticker ?? "");
    });
  }, [holdings]);

  const displayHoldings = useMemo(
    () => (isDemoMode ? sortedHoldings.map((h) => scaleHolding(h, demoFactor)) : sortedHoldings),
    [sortedHoldings, isDemoMode, demoFactor],
  );
  const displayManuals = useMemo(
    () => (isDemoMode && manualInvestments ? scaleManuals([...manualInvestments].sort((a, b) => b.marketValue - a.marketValue), demoFactor) : [...(manualInvestments ?? [])].sort((a, b) => b.marketValue - a.marketValue)),
    [manualInvestments, isDemoMode, demoFactor],
  );

  // Activity filter helpers — must be above early return to satisfy Rules of Hooks
  const uniqueTickers = useMemo(
    () => [...new Set(activities?.map((a) => a.ticker) ?? [])].sort(),
    [activities],
  );
  const presentTypes = useMemo(() => new Set(activities?.map((a) => a.type) ?? []), [activities]);
  const filteredActivities = useMemo(() => {
    if (!activities) return [];
    return activities.filter((a) => {
      const tm = selectedTickers.size === 0 || selectedTickers.has(a.ticker);
      const tp = selectedTypes.size === 0 || selectedTypes.has(a.type);
      return tm && tp;
    });
  }, [activities, selectedTickers, selectedTypes]);

  // Keep the holding detail sheet in sync when holdings refresh — must be above early return
  useEffect(() => {
    if (selectedHolding && holdings) {
      const fresh = holdings.find((h) => h.id === selectedHolding.id);
      if (fresh) setSelectedHolding(isDemoMode ? scaleHolding(fresh, demoFactor) : fresh);
    }
  }, [holdings, isDemoMode, demoFactor]);

  const account = accounts?.find((a) => a.id === accountId);
  if (!account || !holdings) return <BeaconLoader />;

  const cashBalance = account.cashBalance != null ? parseFloat(account.cashBalance) : null;

  const manualMV = displayManuals.reduce((s, m) => s + m.marketValue, 0);
  const manualCost = displayManuals.reduce((s, m) => s + (m.totalCost ?? 0), 0);
  const manualGain = displayManuals.reduce((s, m) => m.totalCost != null ? s + (m.marketValue - m.totalCost) : s, 0);

  const totalMarketValue = displayHoldings.reduce((s, h) => s + (h.marketValue ?? 0), 0)
    + manualMV
    + (cashBalance ?? 0) * (isDemoMode ? demoFactor : 1);
  const totalCost = displayHoldings.reduce((s, h) => s + h.totalCost, 0) + manualCost;
  const totalGain = displayHoldings.reduce((s, h) => s + (h.totalGain ?? 0), 0) + manualGain;
  const totalGainPct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;
  const shortTermGain = displayHoldings.reduce((s, h) => s + h.shortTermGain, 0);
  const longTermGain = displayHoldings.reduce((s, h) => s + h.longTermGain, 0);
  const priceDate = holdings.find((h) => h.priceDate)?.priceDate;

  const hasHoldings = displayHoldings.length > 0 || displayManuals.length > 0 || cashBalance != null;

  const toggleTicker = (t: string) =>
    setSelectedTickers((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });
  const toggleType = (t: string) =>
    setSelectedTypes((prev) => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; });

  const handleSaveCash = async (value: number | null) => {
    await updateAccount(account.id, { cashBalance: value } as any);
    refetchAccounts();
  };

  return (
    <>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div
            className="h-8 w-8 shrink-0 rounded-md flex items-center justify-center"
            style={account.color ? { backgroundColor: account.color } : { backgroundColor: "#e2e2df" }}
          >
            <LineChart className="h-4 w-4 text-ink-4" />
          </div>
          <div className="min-w-0">
            <h1 className="tp-card-title leading-tight truncate">{account.name}</h1>
            <p className="tp-caption">
              Investment Account
              {account.isJoint && " · Joint"}
              {account.isManaged && " · Managed"}
            </p>
          </div>
        </div>

        {/* Market value — only when there's something to total */}
        {hasHoldings && (
          <div>
            <DisplayStat as="p" className="tp-kpi-l">{formatCurrency(totalMarketValue)}</DisplayStat>
          </div>
        )}

        {/* Chart — ghost when no holdings, real when data exists */}
        {(displayHoldings.length > 0 || displayManuals.length > 0) ? (
          <MobileGrowthChart accountId={accountId!} />
        ) : (
          <GhostMobileGrowthChart />
        )}

        {/* Stats — only when there's something to show */}
        {hasHoldings && (
          <div className="space-y-3">
            <div>
              <SectionLabel className="mb-0.5">Total Gain</SectionLabel>
              <GainText value={totalGain} pct={totalGainPct} size="sm" />
            </div>
            <div className="grid grid-cols-2 gap-x-4">
              <div>
                <SectionLabel className="mb-0.5">Short-Term</SectionLabel>
                <GainText value={shortTermGain} size="sm" />
              </div>
              <div>
                <SectionLabel className="mb-0.5">Long-Term</SectionLabel>
                <GainText value={longTermGain} size="sm" />
              </div>
            </div>
            {priceDate && (
              <p className="text-10 text-muted-foreground leading-tight">
                Prices as of {formatDate(priceDate)} · 4:00 PM {easternTZAbbr(priceDate)}
              </p>
            )}
          </div>
        )}

        {/* Settlement cash — always visible so it's editable on empty accounts */}
        <button
          type="button"
          onClick={() => setCashSheetOpen(true)}
          className="flex w-full items-center justify-between rounded-xl border border-border bg-card px-4 py-3 text-sm"
        >
          <div className="flex items-center gap-2 text-muted-foreground">
            <Banknote className="h-4 w-4" />
            <span>Settlement Cash</span>
          </div>
          <div className="flex items-center gap-2">
            <StatValue className="font-medium">
              {cashBalance != null ? formatCurrency(cashBalance) : "—"}
            </StatValue>
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
        </button>

        {/* Tab bar */}
        <div className="flex border-b border-border">
          {(["holdings", "activity"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
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

        {/* ── Holdings tab ── */}
        {activeTab === "holdings" && (
          <div className="space-y-1">
            {!hasHoldings && (
              <div className="py-10 text-center space-y-4">
                <p className="text-sm text-muted-foreground">No holdings yet.</p>
                <div className="flex flex-col items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAddInvestmentOpen(true)}
                    className="flex items-center gap-2 rounded-md bg-gradient-to-b from-primary to-primary-deep px-4 py-2.5 text-sm font-medium border border-primary/60 shadow-accent text-white hover:brightness-105 active:brightness-95"
                  >
                    <Plus className="h-4 w-4" />
                    Add investment
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddManualOpen(true)}
                    className="flex items-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm font-medium text-foreground"
                  >
                    <Plus className="h-4 w-4" />
                    Add manual investment
                  </button>
                </div>
              </div>
            )}

            {/* Holding rows */}
            {displayHoldings.map((holding) => (
              <button
                key={holding.id}
                type="button"
                onClick={() => setSelectedHolding(holding)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left hover:bg-accent/50 transition-colors active:opacity-60"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm">{holding.ticker}</span>
                    <span className="tp-caption truncate">{holding.name}</span>
                  </div>
                  <p className="tp-caption mt-0.5">
                    {holding.totalQuantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <StatValue as="p" className="text-sm font-semibold">
                    {holding.marketValue != null ? formatCurrency(holding.marketValue) : "—"}
                  </StatValue>
                  <GainText value={holding.totalGain} />
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            ))}

            {/* Manual investment rows */}
            {displayManuals.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { setEditingManual(m); setAddManualOpen(true); }}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left hover:bg-accent/50 transition-colors active:opacity-60"
              >
                <div className="flex-1 min-w-0">
                  <p className="tp-row-label truncate">{m.name}</p>
                  <p className="tp-caption">Manual</p>
                </div>
                <div className="text-right shrink-0">
                  <StatValue as="p" className="text-sm font-semibold">{formatCurrency(m.marketValue)}</StatValue>
                  {m.totalCost != null && <GainText value={m.marketValue - m.totalCost} />}
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            ))}

            {/* Add actions (shown when there are existing holdings) */}
            {hasHoldings && (
              <div className="pt-2 space-y-2">
                <button
                  type="button"
                  onClick={() => setAddInvestmentOpen(true)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  Add investment
                </button>
                <button
                  type="button"
                  onClick={() => { setEditingManual(undefined); setAddManualOpen(true); }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2.5 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  Add manual investment
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Activity tab ── */}
        {activeTab === "activity" && (
          <div className="space-y-4">
            {/* Pending dividends */}
            {pendingDividends && pendingDividends.length > 0 && (
              <div className="rounded-xl border border-border overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
                  <Clock className="h-4 w-4 text-violet-deep" />
                  <span className="text-sm font-semibold">Pending Dividends</span>
                  <span className="ml-1 inline-flex items-center justify-center rounded-full bg-violet-soft text-violet-deep text-10 font-semibold px-1.5 py-0.5">
                    {pendingDividends.length}
                  </span>
                  <StatValue className="ml-auto text-sm font-semibold text-violet-deep">
                    {formatCurrency(pendingDividends.reduce((s, pd) => s + parseFloat(pd.estimatedTotal), 0))}
                  </StatValue>
                </div>
                <div className="divide-y divide-border">
                  {pendingDividends.map((pd) => (
                    <div key={pd.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-xs">{pd.ticker}</span>
                            <span className="tp-caption">Ex-date: {formatDate(pd.exDate)}</span>
                          </div>
                          <p className="tp-caption mt-0.5">
                            ${parseFloat(pd.perShareAmount).toFixed(4)}/sh × {parseFloat(pd.sharesAtExDate).toLocaleString(undefined, { maximumFractionDigits: 4 })} sh
                            {" ≈ "}<span className="font-medium text-foreground">{formatCurrency(parseFloat(pd.estimatedTotal))}</span>
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await dismissPendingDividend(pd.id);
                              refetchDividends();
                              refetchNotifications();
                            } catch { /* ignore */ }
                          }}
                          className="shrink-0 tp-caption hover:text-foreground border border-border rounded-md px-2 py-1"
                        >
                          Dismiss
                        </button>
                      </div>
                      <p className="tp-caption mt-1.5">
                        To confirm this dividend, use the desktop app.
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Filters */}
            {activities && activities.length > 0 && (
              <div className="space-y-2">
                {/* Type filter chips */}
                <div className="flex items-center gap-2 flex-wrap">
                  {(["PURCHASE", "SALE", "DIVIDEND"] as const).filter((t) => presentTypes.has(t)).map((type) => {
                    const active = selectedTypes.has(type);
                    const cls = type === "PURCHASE"
                      ? active ? "bg-up-soft text-up-deep border-up-line" : "border-border text-muted-foreground"
                      : type === "SALE"
                      ? active ? "bg-blue-soft text-blue-deep border-blue-soft" : "border-border text-muted-foreground"
                      : active ? "bg-violet-soft text-violet-deep border-violet-soft" : "border-border text-muted-foreground";
                    return (
                      <button
                        key={type}
                        onClick={() => toggleType(type)}
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${cls}`}
                      >
                        {type === "PURCHASE" ? "Purchase" : type === "SALE" ? "Sale" : "Dividend"}
                      </button>
                    );
                  })}
                  {uniqueTickers.length > 1 && uniqueTickers.map((ticker) => {
                    const active = selectedTickers.has(ticker);
                    return (
                      <button
                        key={ticker}
                        onClick={() => toggleTicker(ticker)}
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-mono font-medium transition-colors ${
                          active ? "bg-muted text-foreground border-foreground/30" : "border-border text-muted-foreground"
                        }`}
                      >
                        {ticker}
                      </button>
                    );
                  })}
                  {(selectedTickers.size > 0 || selectedTypes.size > 0) && (
                    <button
                      onClick={() => { setSelectedTickers(new Set()); setSelectedTypes(new Set()); }}
                      className="tp-caption underline"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Activity list */}
            {filteredActivities.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No activity yet.</p>
            )}
            <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
              {filteredActivities.map((a) => {
                const isPurchase = a.type === "PURCHASE";
                const isSale = a.type === "SALE";
                const badgeClass = isSale
                  ? "bg-blue-soft text-blue-deep"
                  : isPurchase
                  ? "bg-up-soft text-up-deep"
                  : "bg-violet-soft text-violet-deep";
                const badgeLabel = isSale ? "Sale" : isPurchase ? "Purchase" : "Dividend";
                const gain = (a.shortTermGain ?? 0) + (a.longTermGain ?? 0);

                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setSelectedActivity(a)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`rounded-full px-2 py-0.5 text-10 font-medium shrink-0 ${badgeClass}`}>
                          {badgeLabel}
                        </span>
                        <span className="font-mono font-bold text-xs">{a.ticker}</span>
                        <span className="tp-caption">{formatDate(a.date)}</span>
                      </div>
                      {a.shares != null && (
                        <p className="tp-caption">
                          {a.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} sh
                          {a.pricePerShare != null && ` @ ${formatCurrency(a.pricePerShare)}`}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <StatValue as="p" className="text-sm font-semibold">{formatCurrency(a.amount)}</StatValue>
                      {isSale && <GainText value={gain} />}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Overlays ── */}
      <CashEditSheet
        open={cashSheetOpen}
        onClose={() => setCashSheetOpen(false)}
        initialValue={cashBalance}
        updatedAt={account.cashBalanceUpdatedAt}
        onSaved={handleSaveCash}
      />

      <HoldingDetailSheet
        holding={selectedHolding}
        onClose={() => setSelectedHolding(null)}
        onUpdated={refetchHoldings}
        onDeleted={refetchHoldings}
      />

      <ActivityDetailSheet
        activity={selectedActivity}
        onClose={() => setSelectedActivity(null)}
      />

      <AddInvestmentFullscreen
        open={addInvestmentOpen}
        onClose={() => setAddInvestmentOpen(false)}
        onSaved={() => { setAddInvestmentOpen(false); refetchHoldings(); }}
        accountId={accountId!}
        existingHoldings={holdings}
        managed={account.isManaged ?? false}
      />

      <AddManualFullscreen
        open={addManualOpen || editingManual != null}
        onClose={() => { setAddManualOpen(false); setEditingManual(undefined); }}
        onSaved={() => { setAddManualOpen(false); setEditingManual(undefined); refetchManual(); }}
        accountId={accountId!}
        editing={editingManual}
      />
    </>
  );
}
