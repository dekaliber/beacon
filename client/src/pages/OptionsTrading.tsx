import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo } from"react";
import { useApi } from"@/hooks/useApi";
import {
 getOptionsSettings,
 getOptionsPositions,
 getOptionsTickers,
 getOptionsGroups,
 updateOptionsSettings,
 getOptionsCapitalChanges,
 createOptionsCapitalChange,
 deleteOptionsCapitalChange,
 createOptionsTicker,
 createOptionsPosition,
 updateOptionsPosition,
 closeOptionsPosition,
 rollOptionsPosition,
 partialCloseOptionsPosition,
 editClosedPosition,
 deleteOptionsPosition,
 importOptionsPositions,
 getOptionQuote,
 getUnderlyingQuote,
 getUnderlyingQuotes,
 getStockPriceAtOpen,
 searchTickers,
 getAccounts,
 getInvestmentAccounts,
 getOptionAssignedBatches,
 runOptionsScreener,
 getOptionsEarnings,
 getActiveAssignedHoldings,
 getRealizedDispositions,
 getOptionsBenchmark,
 type OptionsPosition,
 type OptionsTicker,
 type OptionsPositionGroup,
 type OptionsSettings,
 type OptionsCapitalChange,
 type RealizedDisposition,
 type OptionsPositionInput,
 type OptionsCloseInput,
 type OptionOutcome,
 type ScreenerResult,
 type ScreenerParams,
 type EarningsInfo,
} from"@/api";
import type { TickerSearchResult } from"@/types";
import { useNotifications } from"@/context/NotificationContext";
import { Card } from"@/components/Card";
import { Tooltip } from"@/components/Tooltip";
import { AssignedSharesCard, type SellCoveredCallSeed } from"@/components/AssignedSharesCard";
import { Button } from"@/components/Button";
import { Modal } from"@/components/Modal";
import { DatePicker } from"@/components/DatePicker";
import { Plus, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Settings, Link, Pencil, Trash2, CircleCheck, Upload, FileText, AlertCircle, Check, CheckCircle2, PlayCircle, RefreshCw, Search, X, ScanSearch, BookmarkPlus, BookmarkCheck, Info, CircleQuestionMark, EyeOff, CornerDownRight, AlertTriangle } from"lucide-react";
import { createPortal } from"react-dom";
import { cn, parseAmount, localToday } from"@/lib/utils";
import { earningsBeforeExpiry, earningsWarningText } from"@/lib/earnings";
import { getWeeklyExpiration, nextWeekExpiration, prevWeekExpiration, calcDTE, isNonTradingDay, etDateParts } from"@/lib/marketHolidays";
import { SectionLabel, ColumnHeader, StatValue } from"@/components/Typography";
import { optionsPricesAreFresh } from"@/lib/priceUtils";
import { BeaconLoader } from"@/components/BeaconLoader";
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
} from"recharts";

// Captured once at module load; used as the"opened at" time for draft positions.
const PAGE_LOAD_TIME = new Date().toISOString();

// ── Helpers ────────────────────────────────────────────────────────────────────

const fmt = (n: number | null | undefined, decimals = 2, prefix ="") =>
 n == null ?"—" :`${prefix}${n.toFixed(decimals)}`;


const fmtUSD = (n: number) =>
 n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (n: number | null | undefined, decimals = 1) =>
 n == null ?"—" :`${n >= 0 ?"+" :""}${n.toFixed(decimals)}%`;

// Like fmtPct, but abbreviates magnitudes beyond ±1000% as"K" (e.g. +1.5K%).
// Live annualized returns get exaggerated over short durations, so less precision is fine.
const fmtPctLive = (n: number | null | undefined) => {
 if (n == null) return"—";
 if (Math.abs(n) > 1000) return`${n >= 0 ?"+" :"-"}${(Math.abs(n) / 1000).toFixed(1)}K%`;
 return fmtPct(n);
};

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
 return`${m}/${d}/${String(y).slice(2)}`;
}

function fmtDateTimeShort(iso: string) {
 const d = new Date(iso);
 return`${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

// Compact "time ago" from a past instant. Minutes under an hour, then h/m,
// then days — enough to signal how stale a delta quote is at a glance.
function fmtAgo(fromMs: number, nowMs: number = Date.now()): string {
 const mins = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
 if (mins < 1) return"just now";
 if (mins < 60) return`${mins} min ago`;
 const hrs = Math.floor(mins / 60), rem = mins % 60;
 if (hrs < 24) return rem ?`${hrs}h ${rem}m ago` :`${hrs}h ago`;
 return`${Math.round(hrs / 24)}d ago`;
}

function fmtDateTimeFull(iso: string): string {
 return new Date(iso).toLocaleString("en-US", {
 month:"short", day:"numeric", year:"numeric",
 hour:"numeric", minute:"2-digit",
 timeZone:"America/New_York", timeZoneName:"short",
 });
}

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function getTradingWeekLabel(): string {
 const today = new Date();
 const day = today.getDay(); // 0=Sun … 6=Sat
 const monday = new Date(today);
 monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
 const friday = new Date(monday);
 friday.setDate(monday.getDate() + 4);
 const monLabel =`${MONTH_NAMES[monday.getMonth()]} ${monday.getDate()}`;
 const friLabel =`${MONTH_NAMES[friday.getMonth()]} ${friday.getDate()}`;
 return`${monLabel} - ${friLabel}, ${friday.getFullYear()}`;
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
 currentDelta: p.currentDelta != null ? Number(p.currentDelta) : null,
 excludeFromLivePnl: p.excludeFromLivePnl ?? false,
 isDraft: p.isDraft ?? false,
 };
}

// ── Calculations ───────────────────────────────────────────────────────────────

function calcPosition(p: OptionsPosition) {
 const totalPremiumGross = p.premiumPerShare * 100 * p.contracts;
 const totalPremiumNet = totalPremiumGross - (p.feesOpen ?? 0);

 const capitalAtRisk =
 p.optionType ==="CALL"
 ? (p.shareCostBasis ?? p.stockPriceAtOpen ?? p.strikePrice) * 100 * p.contracts
 : p.strikePrice * 100 * p.contracts;

 const breakeven =
 p.optionType ==="CALL"
 ? p.strikePrice + p.premiumPerShare
 : p.strikePrice - p.premiumPerShare;

 // Negative = stock must fall to reach strike (CSP); positive = must rise (CC)
 const pctOtmAtOpen =
 p.stockPriceAtOpen != null
 ? p.optionType ==="CALL"
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
 const todayEtDay = Math.floor((Date.now() - ET_OFFSET_MS) / 86_400_000);
 const calDaysLeft = expiryEtDay - todayEtDay;

 const annReturnAtExpiry =
 capitalAtRisk > 0 && durationDays > 0
 ? (totalPremiumNet / capitalAtRisk) * (365 / durationDays) * 100
 : null;

 // Closed-position fields
 const totalFees = (p.feesOpen ?? 0) + (p.feesClose ?? 0);
 const closedPremiumNet =
 p.outcome ==="EXPIRED_WORTHLESS"
 ? 0
 : (p.closePremiumPerShare ?? 0) * 100 * p.contracts + (p.feesClose ?? 0);

 const pnl =
 p.status !=="OPEN"
 ? totalPremiumGross - closedPremiumNet - (p.feesOpen ?? 0)
 : null;

 const closeMs = p.closedAt
 ? new Date(p.closedAt).getTime()
 : p.status !=="OPEN"
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

// ── Performance Metrics ────────────────────────────────────────────────────────

interface PerformanceMetrics {
 tradeCount: number;
 contractCount: number;
 closedCount: number;
 winRate: number | null;
 assignmentRate: number | null;
 avgActualDays: number | null;
 avgExpectedDays: number | null;
 totalPremium: number;
 ccPremium: number;
 cspPremium: number;
 weightedArr: number | null;
}

function computePerformanceMetrics(positions: OptionsPosition[]): PerformanceMetrics {
 // ── Separate into chains vs leg-by-leg accounting ────────────────────────────
 // Fully-closed chains (every leg closed) → counted as one logical trade.
 // Chains with any open leg → each leg counted individually (same as today);
 // we don't roll up partial results until the chain is complete.
 // Standalone positions (no groupId) → always counted individually.

 const chainMap = new Map<string, OptionsPosition[]>();
 for (const p of positions) {
 if (!p.groupId) continue;
 const legs = chainMap.get(p.groupId) ?? [];
 legs.push(p);
 chainMap.set(p.groupId, legs);
 }

 // groupIds that still have at least one open leg — account per-leg
 const openChainIds = new Set<string>();
 const closedChainLegs: OptionsPosition[][] = [];

 for (const [groupId, legs] of chainMap) {
 if (legs.every((p) => p.status !=="OPEN")) {
 // Sort by sequence / openedAt so legs[0] is always the first leg
 closedChainLegs.push(
 [...legs].sort((a, b) =>
 a.sequenceInGroup != null && b.sequenceInGroup != null
 ? a.sequenceInGroup - b.sequenceInGroup
 : new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime()
 )
 );
 } else {
 openChainIds.add(groupId);
 }
 }

 //"Flat" pool: only truly standalone (ungrouped) closed positions.
 // Closed legs of partially-open chains are excluded — they'll be rolled up
 // into the chain once the final leg closes. Fully-closed chain legs are
 // already captured in closedChainLegs above.
 const closedFlat = positions.filter((p) => p.status !=="OPEN" && !p.groupId);

 // ── Trade & contract counts ───────────────────────────────────────────────────
 // Closed-only: consistent with every other column in the Performance Details table.
 // Open positions are already shown in the positions table above.
 const tradeCount = closedFlat.length + closedChainLegs.length;
 const contractCount =
 closedFlat.reduce((s, p) => s + p.contracts, 0) +
 closedChainLegs.reduce((s, legs) => s + legs[0].contracts, 0);

 // ── Win rate ─────────────────────────────────────────────────────────────────
 const isLegWin = (p: OptionsPosition) => {
 if (p.outcome ==="EXPIRED_WORTHLESS") return true;
 if (p.outcome ==="ASSIGNED") return false;
 return (p.closePremiumPerShare ?? 0) < p.premiumPerShare;
 };

 let winContracts = 0, winDenomContracts = 0;

 for (const p of closedFlat.filter((p) => p.outcome != null)) {
 winDenomContracts += p.contracts;
 if (isLegWin(p)) winContracts += p.contracts;
 }
 for (const legs of closedChainLegs) {
 const finalLeg = legs[legs.length - 1];
 const chainPnl = legs.reduce((s, p) => s + (calcPosition(p).pnl ?? 0), 0);
 winDenomContracts += legs[0].contracts;
 if (chainPnl > 0 && finalLeg.outcome !=="ASSIGNED") winContracts += legs[0].contracts;
 }

 const winRate = winDenomContracts > 0 ? (winContracts / winDenomContracts) * 100 : null;

 // ── Assignment rate ───────────────────────────────────────────────────────────
 // For chains: assigned if the final leg was assigned.
 let assignedContracts = 0, closedContracts = 0;

 for (const p of closedFlat) {
 closedContracts += p.contracts;
 if (p.outcome ==="ASSIGNED") assignedContracts += p.contracts;
 }
 for (const legs of closedChainLegs) {
 const finalLeg = legs[legs.length - 1];
 closedContracts += legs[0].contracts;
 if (finalLeg.outcome ==="ASSIGNED") assignedContracts += legs[0].contracts;
 }

 const assignmentRate = closedContracts > 0 ? (assignedContracts / closedContracts) * 100 : null;

 // ── Premium / days / ARR ──────────────────────────────────────────────────────
 let sumActual = 0, sumExpected = 0, daysN = 0;
 let totalPremium = 0, ccPremium = 0, cspPremium = 0;
 let arrNumer = 0, arrDenom = 0;

 // Flat (standalone + open-chain legs)
 for (const p of closedFlat) {
 const c = calcPosition(p);
 const pnl = c.pnl ?? 0;
 totalPremium += pnl;
 if (p.optionType ==="CALL") ccPremium += pnl;
 else if (p.optionType ==="PUT") cspPremium += pnl;
 if (c.daysInTrade != null) {
 sumActual += c.daysInTrade * p.contracts;
 sumExpected += c.durationDays * p.contracts;
 daysN += p.contracts;
 }
 if (c.closedAnnReturn != null && c.capitalAtRisk > 0) {
 arrNumer += c.closedAnnReturn * c.capitalAtRisk;
 arrDenom += c.capitalAtRisk;
 }
 }

 // Helper: resolve the effective close timestamp for a closed leg
 const getCloseMs = (p: OptionsPosition): number => {
 if (p.closedAt) return new Date(p.closedAt).getTime();
 const [ey, em, ed] = p.expirationDate.split("T")[0].split("-").map(Number);
 return Date.UTC(ey, em - 1, ed, 20, 0, 0);
 };

 // Fully-closed chains
 for (const legs of closedChainLegs) {
 const firstLeg = legs[0];
 const finalLeg = legs[legs.length - 1];
 const chainPnl = legs.reduce((s, p) => s + (calcPosition(p).pnl ?? 0), 0);

 totalPremium += chainPnl;
 if (firstLeg.optionType ==="CALL") ccPremium += chainPnl;
 else if (firstLeg.optionType ==="PUT") cspPremium += chainPnl;

 // Capital at risk: max across legs (handles rolling up to a higher strike)
 const chainCapitalAtRisk = Math.max(...legs.map((p) => calcPosition(p).capitalAtRisk));

 // Actual duration: first open → last close
 const firstOpenMs = new Date(firstLeg.openedAt).getTime();
 const lastCloseMs = Math.max(...legs.map(getCloseMs));
 const chainDaysInTrade = (lastCloseMs - firstOpenMs) / 86_400_000;

 // Expected duration: first open → final leg's expiry
 const [ey, em, ed] = finalLeg.expirationDate.split("T")[0].split("-").map(Number);
 const finalExpiryMs = Date.UTC(ey, em - 1, ed, 20, 0, 0);
 const chainExpectedDays = (finalExpiryMs - firstOpenMs) / 86_400_000;

 const w = firstLeg.contracts;
 sumActual += chainDaysInTrade * w;
 sumExpected += chainExpectedDays * w;
 daysN += w;

 if (chainCapitalAtRisk > 0 && chainDaysInTrade > 0) {
 const chainArr = (chainPnl / chainCapitalAtRisk) * (365 / chainDaysInTrade) * 100;
 arrNumer += chainArr * chainCapitalAtRisk;
 arrDenom += chainCapitalAtRisk;
 }
 }

 return {
 tradeCount,
 contractCount,
 closedCount: closedFlat.length + closedChainLegs.length,
 winRate,
 assignmentRate,
 avgActualDays: daysN > 0 ? sumActual / daysN : null,
 avgExpectedDays: daysN > 0 ? sumExpected / daysN : null,
 totalPremium,
 ccPremium,
 cspPremium,
 weightedArr: arrDenom > 0 ? arrNumer / arrDenom : null,
 };
}

// ── Open Position Modal ────────────────────────────────────────────────────────

// Seed values for opening the modal in create mode pre-filled — e.g. the
// "Sell covered call" shortcut on an assigned lot. Contracts and cost basis are
// not seeded here; once the batch loads they're applied from its authoritative
// contractsRemaining / weightedCostPerShare (same as picking the lot manually).
export interface PositionPrefill {
 kind: "prefill";
 tickerId: string | null;
 tickerSymbol: string;
 investmentAccountId: string;
 assignedBatchKey: string; // `${strike}|${expiry(YYYY-MM-DD)}`
}

interface PositionModalProps {
 tickers: OptionsTicker[];
 groups: OptionsPositionGroup[];
 editing: OptionsPosition | null;
 prefill?: PositionPrefill;
 onClose: () => void;
 onSaved: () => void;
 onDelete: () => Promise<void>;
 onTickerCreated: () => void;
}

function getDefaultExpirationDate() {
 return getWeeklyExpiration();
}

function getDefaultOpenedAt() {
 // Return current wall-clock time expressed as an ET datetime-local string
 // (EDT = UTC-4; etToUtc will add 4h back when converting to UTC for storage)
 const etNow = new Date(Date.now() - 4 * 60 * 60 * 1000);
 return etNow.toISOString().slice(0, 16);
}

type TickerDropdownItem =
 | { kind:"existing"; id: string; symbol: string }
 | { kind:"new"; result: TickerSearchResult };

function PositionModal({ tickers, editing, prefill, onClose, onSaved, onDelete, onTickerCreated }: PositionModalProps) {
 const [tickerQuery, setTickerQuery] = useState(editing?.ticker?.symbol ?? prefill?.tickerSymbol ??"");
 const [selectedExistingId, setSelectedExistingId] = useState<string | null>(editing?.tickerId ?? prefill?.tickerId ?? null);
 const [dropdownItems, setDropdownItems] = useState<TickerDropdownItem[]>([]);
 const [searchLoading, setSearchLoading] = useState(false);
 const [dropdownOpen, setDropdownOpen] = useState(false);
 const [highlightedIndex, setHighlightedIndex] = useState(-1);
 const tickerInputRef = useRef<HTMLInputElement>(null);
 useEffect(() => { tickerInputRef.current?.focus(); }, []);
 const searchDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 const [optionType, setOptionType] = useState<"CALL" |"PUT">(editing?.optionType ??"CALL");
 const [strikePrice, setStrikePrice] = useState(editing?.strikePrice?.toString() ??"");
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
 const [contracts, setContracts] = useState(editing?.contracts?.toString() ??"");
 const [premiumPerShare, setPremiumPerShare] = useState(editing?.premiumPerShare?.toString() ??"");
 const [feesOpen, setFeesOpen] = useState(editing?.feesOpen?.toString() ??"");
 const [shareCostBasis, setShareCostBasis] = useState(editing?.shareCostBasis?.toString() ??"");
 const [stockPriceAtOpen, setStockPriceAtOpen] = useState(editing?.stockPriceAtOpen?.toString() ??"");
 const [deltaAtOpenStr, setDeltaAtOpenStr] = useState<string>(editing?.deltaAtOpen != null ? String(Number(editing.deltaAtOpen)) :"");
 const [deltaAtOpenCapturedAt, setDeltaAtOpenCapturedAt] = useState<string | null>(editing?.deltaAtOpenCapturedAt ?? null);
 const [deltaAtOpenStatus, setDeltaAtOpenStatus] = useState<"idle" |"fetching" |"success" |"error">("idle");
 const [notes, setNotes] = useState(editing?.notes ??"");
 const [excludeFromLivePnl, setExcludeFromLivePnl] = useState(editing?.excludeFromLivePnl ?? false);
 const [groupId] = useState(editing?.groupId ??"");
 const [investmentAccountId, setInvestmentAccountId] = useState(editing?.investmentAccountId ?? prefill?.investmentAccountId ??"");
 const [selectedBatchKey, setSelectedBatchKey] = useState<string>(() => {
 if (editing?.assignedFromStrikePrice != null && editing?.assignedFromExpirationDate) {
 const expDate = editing.assignedFromExpirationDate.split("T")[0];
 return`${editing.assignedFromStrikePrice}|${expDate}`;
 }
 return"";
 });
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");
 const [confirmDelete, setConfirmDelete] = useState(false);
 const [deleting, setDeleting] = useState(false);
 const [priceAtOpenStatus, setPriceAtOpenStatus] = useState<"idle" |"fetching" |"success" |"error">("idle");
 const [priceAtOpenLabel, setPriceAtOpenLabel] = useState("");

 const isCoveredCall = optionType ==="CALL";

 // Investment accounts for account selector
 const { data: investmentAccounts, loading: accountsLoading } = useApi(() => getInvestmentAccounts(), []);

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

 // Upcoming earnings for the selected ticker, so the expiration field can flag
 // an expiry that straddles the call. selectedTicker falls back to the raw input,
 // so debounce it — otherwise every keystroke fires a lookup on a partial symbol.
 const [earningsSymbol, setEarningsSymbol] = useState("");
 useEffect(() => {
 const sym = selectedTicker.trim().toUpperCase();
 const t = setTimeout(() => setEarningsSymbol(sym), 400);
 return () => clearTimeout(t);
 }, [selectedTicker]);
 const { data: earningsMap } = useApi(
 () =>
 earningsSymbol
 ? getOptionsEarnings([earningsSymbol], localToday())
 : Promise.resolve({} as Record<string, EarningsInfo | null>),
 [earningsSymbol]
 );
 // Keyed on the symbol the data was fetched for, so a stale map can't warn
 // against the wrong ticker while a new lookup is in flight.
 const earnings = earningsSymbol ? earningsMap?.[earningsSymbol] ?? null : null;
 const showEarningsWarning = earningsBeforeExpiry(earnings, expirationDate);

 // Prefill path ("Sell covered call" shortcut): once the assigned batches load,
 // select the originating lot and pull its contractsRemaining / cost basis —
 // mirroring what choosing the lot from the picker would set. Runs once.
 const prefillApplied = useRef(false);
 useEffect(() => {
 if (!prefill || prefillApplied.current || !assignedBatches || assignedBatches.length === 0) return;
 const [strike, expiry] = prefill.assignedBatchKey.split("|");
 const batch = assignedBatches.find(
 (b) =>`${parseFloat(b.strikePrice)}|${b.expirationDate}` ===`${parseFloat(strike)}|${expiry}`
 );
 if (!batch) return;
 setSelectedBatchKey(`${batch.strikePrice}|${batch.expirationDate}`);
 setContracts(batch.contractsRemaining.toString());
 if (batch.weightedCostPerShare != null)
 setShareCostBasis(batch.weightedCostPerShare.toFixed(6).replace(/\.?0+$/,""));
 prefillApplied.current = true;
 }, [prefill, assignedBatches]);

 const fetchPrice = useCallback(async (symbol: string) => {
 try {
 const result = await getUnderlyingQuote(symbol);
 setStockPriceAtOpen(result.price.toFixed(2));
 } catch { /* ignore — user can fill manually */ }
 }, []);

 // Only fires for new positions or drafts being opened (not already-open positions)
 const fetchStockPriceAtOpen = useCallback(async (symbol: string, openedAtVal: string) => {
 if (!symbol || !openedAtVal) return;

 // Fetch stock price (timesales)
 setPriceAtOpenStatus("fetching");
 try {
 const result = await getStockPriceAtOpen(symbol, openedAtVal);
 setStockPriceAtOpen(result.price.toFixed(2));
 setPriceAtOpenLabel(result.timeLabel);
 setPriceAtOpenStatus("success");
 } catch {
 setPriceAtOpenStatus("error");
 }

 // Also fetch delta via option quote if we have all required option params
 const strikeNum = parseAmount(strikePrice);
 if (symbol && optionType && !isNaN(strikeNum) && strikeNum > 0 && expirationDate) {
 setDeltaAtOpenStatus("fetching");
 try {
 const quote = await getOptionQuote({ symbol, type: optionType, strike: strikeNum, expiration: expirationDate });
 if (quote.delta != null) {
 setDeltaAtOpenStr(quote.delta.toFixed(6));
 setDeltaAtOpenCapturedAt(quote.capturedAt);
 setDeltaAtOpenStatus("success");
 } else {
 setDeltaAtOpenStatus("error");
 }
 } catch {
 setDeltaAtOpenStatus("error");
 }
 }
 }, [strikePrice, optionType, expirationDate]);

 // Auto-fetch option quote when ticker + type + strike + expiration are all set
 const [quoteFetching, setQuoteFetching] = useState(false);
 const [, setQuoteAutoFilled] = useState(false);
 const quoteDebounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

 useEffect(() => {
 // Don't auto-fill premium for existing open positions — the transaction already occurred
 if (editing) return;
 if (quoteDebounce.current) clearTimeout(quoteDebounce.current);
 const strikeNum = parseAmount(strikePrice);
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
 if (quote.delta != null) {
 setDeltaAtOpenStr(quote.delta.toFixed(6));
 setDeltaAtOpenCapturedAt(quote.capturedAt);
 }
 } catch { /* ignore — user can fill manually */ }
 finally { setQuoteFetching(false); }
 }, 600);
 return () => { if (quoteDebounce.current) clearTimeout(quoteDebounce.current); };
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
 .map((t): TickerDropdownItem => ({ kind:"existing", id: t.id, symbol: t.symbol }));
 setDropdownItems(existingMatches);
 setHighlightedIndex(existingMatches.length > 0 ? 0 : -1);

 searchDebounce.current = setTimeout(async () => {
 setSearchLoading(true);
 try {
 const results = await searchTickers(q);
 const existingSymbols = new Set(tickers.map((t) => t.symbol));
 const newItems = results
 .filter((r) => !existingSymbols.has(r.ticker))
 .map((r): TickerDropdownItem => ({ kind:"new", result: r }));
 const merged = [
 ...tickers.filter((t) => t.symbol.startsWith(upper)).map((t): TickerDropdownItem => ({ kind:"existing", id: t.id, symbol: t.symbol })),
 ...newItems,
];
 setDropdownItems(merged);
 setHighlightedIndex(merged.length > 0 ? 0 : -1);
 } catch { /* keep existing matches */ }
 finally { setSearchLoading(false); }
 }, 300);
 };

 const handleDropdownSelect = (item: TickerDropdownItem) => {
 const symbol = item.kind ==="existing" ? item.symbol : item.result.ticker;
 setTickerQuery(symbol);
 setSelectedExistingId(item.kind ==="existing" ? item.id : null);
 setDropdownItems([]);
 setDropdownOpen(false);
 setHighlightedIndex(-1);
 if (!editing) fetchPrice(symbol);
 };

 const handleTickerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
 if (!dropdownOpen || dropdownItems.length === 0) return;
 if (e.key ==="ArrowDown") {
 e.preventDefault();
 setHighlightedIndex((i) => Math.min(i + 1, dropdownItems.length - 1));
 } else if (e.key ==="ArrowUp") {
 e.preventDefault();
 setHighlightedIndex((i) => Math.max(i - 1, 0));
 } else if (e.key ==="Enter" && highlightedIndex >= 0) {
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
 side:"SELL",
 strikePrice: parseAmount(strikePrice),
 expirationDate,
 openedAt: etToUtc(openedAt),
 contracts: parseInt(contracts, 10),
 premiumPerShare: parseAmount(premiumPerShare),
 feesOpen: feesOpen ? parseAmount(feesOpen) : null,
 shareCostBasis: isCoveredCall && shareCostBasis ? parseAmount(shareCostBasis) : null,
 stockPriceAtOpen: stockPriceAtOpen ? parseAmount(stockPriceAtOpen) : null,
 deltaAtOpen: deltaAtOpenStr ? parseFloat(deltaAtOpenStr) : null,
 deltaAtOpenCapturedAt: deltaAtOpenCapturedAt ?? null,
 notes: notes || null,
 excludeFromLivePnl,
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

 const handleDeleteClick = async () => {
 if (!editing) return;
 if (!confirmDelete) { setConfirmDelete(true); return; }
 setDeleting(true);
 try {
 await onDelete();
 } catch {
 setError("Failed to delete position.");
 setDeleting(false);
 setConfirmDelete(false);
 }
 };

 return (
 <Modal open onClose={onClose} title={editing ?"Edit Position" :"Open New Position / Draft"}>
 <form onSubmit={handleSubmit} noValidate className="space-y-4">
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
 className="w-full rounded-md border border-border px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 required
 />
 {dropdownOpen && (dropdownItems.length > 0 || searchLoading) && (
 <ul className="absolute z-10 mt-1 w-full rounded-md border border-border bg-background shadow-lg max-h-52 overflow-y-auto">
 {searchLoading && dropdownItems.length === 0 && (
 <li className="px-3 py-2 text-muted-foreground">Searching…</li>
 )}
 {dropdownItems.map((item, i) =>
 item.kind ==="existing" ? (
 <li
 key={`existing-${item.id}`}
 onMouseDown={(e) => { e.preventDefault(); handleDropdownSelect(item); }}
 onMouseEnter={() => setHighlightedIndex(i)}
 className={cn("flex items-center justify-between px-3 py-2 cursor-pointer", i === highlightedIndex ?"bg-muted" :"hover:bg-muted")}
 >
 <span className="font-medium">{item.symbol}</span>
 <span className="text-xs text-primary/70 font-medium">tracked</span>
 </li>
 ) : (
 <li
 key={`new-${item.result.ticker}`}
 onMouseDown={(e) => { e.preventDefault(); handleDropdownSelect(item); }}
 onMouseEnter={() => setHighlightedIndex(i)}
 className={cn("flex items-center justify-between px-3 py-2 cursor-pointer", i === highlightedIndex ?"bg-muted" :"hover:bg-muted")}
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
 <div className="flex rounded-md border border-border overflow-hidden text-13 font-medium">
 <button
 type="button"
 onClick={() => setOptionType("CALL")}
 className={`flex-1 py-2 px-3 transition-colors ${optionType ==="CALL" ?"bg-primary text-primary-foreground" :"bg-background text-foreground hover:bg-muted"}`}
 >
 Covered Call
 </button>
 <button
 type="button"
 onClick={() => setOptionType("PUT")}
 className={`flex-1 py-2 px-3 transition-colors border-l border-border ${optionType ==="PUT" ?"bg-primary text-primary-foreground" :"bg-background text-foreground hover:bg-muted"}`}
 >
 Cash-Secured Put
 </button>
 </div>
 </div>

 {/* Investment Account */}
 {(() => {
 const eligibleAccounts = (investmentAccounts ?? []).filter(
 (a) => a.type ==="INVESTMENT" && !a.isManaged
 );
 if (!accountsLoading && eligibleAccounts.length === 0) return null;
 return (
 <div>
 <label className="block text-xs font-medium mb-1">
 Investment Account
 </label>
 <div className="relative">
 <select
 disabled={accountsLoading}
 value={investmentAccountId}
 onChange={(e) => setInvestmentAccountId(e.target.value)}
 className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-foreground disabled:text-muted-foreground disabled:bg-muted"
 >
 {accountsLoading
 ? <option value="">Loading…</option>
 : <>
 <option value="">None</option>
 {eligibleAccounts.map((a) => (
 <option key={a.id} value={a.id}>{a.name}</option>
 ))}
 </>
 }
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 </div>
 );
 })()}

 {/* Assignment batch picker — CC only, appears once ticker + account are selected */}
 {isCoveredCall && hasAssignedBatches && (
 <div>
 <label className="block text-xs font-medium mb-1">
 Written Against Assigned Lot <span className="text-muted-foreground font-normal">(optional)</span>
 </label>
 <div className="relative">
 <select
 value={selectedBatchKey}
 onChange={(e) => {
 const key = e.target.value;
 setSelectedBatchKey(key);
 if (!key) return;
 const [strike, expiry] = key.split("|");
 const batch = assignedBatches!.find(
 (b) =>`${parseFloat(b.strikePrice)}|${b.expirationDate}` ===`${parseFloat(strike)}|${expiry}`
 ) ?? null;
 if (batch) {
 setContracts(batch.contractsRemaining.toString());
 if (batch.weightedCostPerShare != null)
 setShareCostBasis(batch.weightedCostPerShare.toFixed(6).replace(/\.?0+$/,""));
 }
 }}
 className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-foreground"
 >
 <option value="">None / not from an assignment</option>
 {assignedBatches!.map((batch) => {
 const expLabel = new Date(batch.expirationDate +"T12:00:00Z").toLocaleDateString("en-US", { month:"numeric", day:"numeric", year:"2-digit" });
 return (
 <option key={`${batch.strikePrice}|${batch.expirationDate}`} value={`${batch.strikePrice}|${batch.expirationDate}`}>
 ${parseFloat(batch.strikePrice).toFixed(2)} · {expLabel} expiry · {batch.contractsRemaining} of {batch.totalContracts} contracts remaining
 </option>
 );
 })}
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 </div>
 )}

 {/* Strike / Expiration */}
 <div className="grid grid-cols-2 gap-4">
 <div>
 <label className="block text-xs font-medium mb-1">Strike Price</label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal" required
 value={strikePrice} onChange={(e) => setStrikePrice(e.target.value)}
 className="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 </div>
 <div>
 <label className="flex items-center gap-1 text-xs font-medium mb-1">
 Expiration Date
 {showEarningsWarning && (
 <Tooltip content={earningsWarningText(earnings!)}>
 <span className="inline-flex items-center text-warn">
 <AlertTriangle className="h-3 w-3" />
 </span>
 </Tooltip>
 )}
 </label>
 <div className="flex items-center w-full">
 <DatePicker
 required
 value={expirationDate} onChange={setExpirationDate}
 className="w-[120px] shrink-0"
 />
 <div className="ml-auto flex items-center gap-0.5">
 {expirationDate && (
 <span className="mr-1 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
 {calcDTE(expirationDate)} DTE
 </span>
 )}
 <button
 type="button"
 aria-label="Previous week"
 onClick={() => setExpirationDate(prevWeekExpiration(expirationDate))}
 className="rounded p-1 text-ink-3 hover:bg-muted-hover hover:text-ink transition-colors"
 >
 <ChevronLeft className="h-3.5 w-3.5" />
 </button>
 <button
 type="button"
 aria-label="Next week"
 onClick={() => setExpirationDate(nextWeekExpiration(expirationDate))}
 className="rounded p-1 text-ink-3 hover:bg-muted-hover hover:text-ink transition-colors"
 >
 <ChevronRight className="h-3.5 w-3.5" />
 </button>
 </div>
 </div>
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
 value={isDraft ?"" : openedAt}
 onChange={(e) => { setOpenedAt(e.target.value); setPriceAtOpenStatus("idle"); }}
 onBlur={() => {
 if ((!editing || editing.isDraft) && !isDraft) {
 fetchStockPriceAtOpen(selectedTicker, openedAt);
 }
 }}
 className={cn(
"w-full rounded-md border border-border px-3 py-2",
 isDraft
 ?"bg-muted text-muted-foreground cursor-not-allowed"
 :"focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 )}
 />
 </div>
 <div className="flex flex-col justify-end pb-[1px]">
 <label className="flex items-center gap-2 cursor-pointer select-none rounded-md border border-border px-3 py-2 font-medium hover:bg-muted transition-colors">
 <input
 type="checkbox"
 checked={isDraft}
 onChange={(e) => {
 const nowDraft = e.target.checked;
 setIsDraft(nowDraft);
 if (!nowDraft && editing?.isDraft) {
 const defaultTime = getDefaultOpenedAt();
 setOpenedAt(defaultTime);
 fetchStockPriceAtOpen(selectedTicker, defaultTime);
 }
 if (nowDraft) setPriceAtOpenStatus("idle");
 }}
 className="h-3.5 w-3.5 rounded border-border accent-primary"
 />
 Draft
 <span className="ml-auto tp-caption font-normal">plan / limit order</span>
 </label>
 </div>
 </div>
 {isDraft && (
 <p className="mt-1 tp-caption">Date confirmed when you open the position.</p>
 )}
 </div>

 {/* Contracts / Premium */}
 <div className="grid grid-cols-2 gap-4">
 <div>
 <label className="block text-xs font-medium mb-1"># Contracts</label>
 <input
 type="text" inputMode="numeric" required
 value={contracts} onChange={(e) => setContracts(e.target.value)}
 className="w-full rounded-md border border-border px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 <div>
 <label className="block text-xs font-medium mb-1">
 Premium / Share{" "}
 <span className="text-muted-foreground font-normal">
 {quoteFetching ?"(fetching…)" :""}
 </span>
 </label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal" required
 value={premiumPerShare}
 onChange={(e) => { setPremiumPerShare(e.target.value); setQuoteAutoFilled(false); }}
 placeholder={quoteFetching ?"Fetching…" :""}
 className="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 </div>
 </div>

 {/* Stock Price at Open + Delta at Open (50/50) */}
 <div className="grid grid-cols-2 gap-4">
 {/* Stock Price at Open */}
 <div>
 <label className="block text-xs font-medium mb-1">Stock Price at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={stockPriceAtOpen} onChange={(e) => setStockPriceAtOpen(e.target.value)}
 className="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 {priceAtOpenStatus ==="fetching" && <p className="mt-1 tp-caption">Getting open price…</p>}
 {priceAtOpenStatus ==="success" && <p className="mt-1 tp-caption">Price as of {priceAtOpenLabel}</p>}
 {priceAtOpenStatus ==="error" && <p className="mt-1 text-xs text-down">Price fetch failed</p>}
 </div>

 {/* Delta at Open */}
 <div>
 <label className="block text-xs font-medium mb-1">Delta at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
 <input
 type="text" inputMode="decimal"
 value={deltaAtOpenStr}
 onChange={(e) => { setDeltaAtOpenStr(e.target.value); setDeltaAtOpenCapturedAt(null); setDeltaAtOpenStatus("idle"); }}
 placeholder={deltaAtOpenStatus ==="fetching" ?"Fetching…" :""}
 className="w-full rounded-md border border-border px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 {deltaAtOpenStatus ==="fetching" && <p className="mt-1 tp-caption">Fetching delta…</p>}
 {deltaAtOpenStatus ==="success" && <p className="mt-1 tp-caption">From option chain</p>}
 {deltaAtOpenStatus ==="error" && <p className="mt-1 text-xs text-down">Delta fetch failed</p>}
 </div>
 </div>

 {/* Share Cost Basis — CC only */}
 {isCoveredCall && (
 <div>
 <label className="block text-xs font-medium mb-1">Cost Basis / Share</label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={shareCostBasis} onChange={(e) => setShareCostBasis(e.target.value)}
 className="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 </div>
 )}

 {/* Fees */}
 <div>
 <label className="block text-xs font-medium mb-1">Fees at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={feesOpen} onChange={(e) => setFeesOpen(e.target.value)}
 className="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 </div>

 {/* Notes */}
 <div>
 <label className="block text-xs font-medium mb-1">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
 <textarea
 value={notes} onChange={(e) => setNotes(e.target.value)}
 rows={2}
 className="w-full rounded-md border border-border px-3 py-2 resize-none focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>

 {/* Exclude from Total Live P&L — e.g. a covered call you expect to let get assigned */}
 {!isDraft && (
 <div className="rounded-md border border-border p-3">
 <label className="flex cursor-pointer items-center gap-2">
 <input
 type="checkbox"
 checked={excludeFromLivePnl}
 onChange={(e) => setExcludeFromLivePnl(e.target.checked)}
 className="h-4 w-4 rounded border-border"
 />
 <span className="text-13 font-normal">Exclude from Total Live P&L</span>
 </label>
 <p className="tp-caption mt-1.5 ml-6">Keep this position's mark out of the Total Live P&L rollup — useful for a position you plan to let expire or get assigned rather than close.</p>
 </div>
 )}

 {error && <p className="text-down">{error}</p>}

 <div className="flex items-center justify-between pt-2">
 <div>
 {editing && (
 <button
 type="button"
 onClick={handleDeleteClick}
 disabled={deleting}
 className="flex items-center gap-1.5 rounded-md px-3 py-2 text-13 font-normal text-down hover:bg-down/10 transition-colors"
 >
 <Trash2 className="h-3.5 w-3.5" />
 {deleting ?"Deleting…" : confirmDelete ?"Confirm Delete" :"Delete"}
 </button>
 )}
 </div>
 <div className="flex gap-2">
 <Button variant="secondary" onClick={onClose}>Cancel</Button>
 <Button type="submit" disabled={saving}>
 {saving ?"Saving…" : editing ? (editing.isDraft && !isDraft ?"Open Position" :"Save Changes") : isDraft ?"Save Draft" :"Open Position"}
 </Button>
 </div>
 </div>
 </form>
 </Modal>
 );
}

const LS_LAST_FETCHED_KEY ="options_last_fetched_at";
const LS_LIVE_PRICES_KEY ="options_live_prices";

// Cached live-price entries carry the time they were actually captured, so
// staleness can be judged per ticker rather than trusting a single global
// "we attempted a refresh" flag — a ticker Tradier silently drops from a
// batch response (bad/missing field, rate limit) must not be treated as
// current just because sibling tickers refreshed fine. Older cache entries
// (pre-timestamp format: a bare number) are treated as having ts=0, i.e.
// always stale, so they get refetched rather than trusted blindly.
type LivePriceEntry = { price: number; ts: number };

function readLivePriceCache(): Record<string, LivePriceEntry> {
 try {
 const stored = localStorage.getItem(LS_LIVE_PRICES_KEY);
 if (!stored) return {};
 const raw = JSON.parse(stored) as Record<string, number | LivePriceEntry>;
 const out: Record<string, LivePriceEntry> = {};
 for (const [ticker, v] of Object.entries(raw)) {
 out[ticker] = typeof v ==="number" ? { price: v, ts: 0 } : v;
 }
 return out;
 } catch {
 return {};
 }
}

// Stock price to use for an assignment decision/field. Reuses the page's own
// cached underlying quote (same Tradier-backed source as the table's price
// column) when it was captured at or after the option's 4pm ET expiration
// close — the common case, since refreshing premiums after the close is how
// most of these get reviewed. Otherwise fetches a fresh Tradier quote rather
// than falling back to a second, inconsistent price source.
async function getAssignmentStockPrice(symbol: string, expirationDateStr: string): Promise<number> {
 const expiryCloseMs = new Date(expirationDateStr +"T20:00:00.000Z").getTime();
 const cached = readLivePriceCache()[symbol];
 if (cached != null && cached.ts >= expiryCloseMs) return cached.price;
 const quote = await getUnderlyingQuote(symbol);
 return quote.price;
}

// ── Close Position Modal ───────────────────────────────────────────────────────

interface CloseModalProps {
 position: OptionsPosition;
 onClose: () => void;
 onSaved: () => void;
 defaultBankingAccountId?: string | null;
}

function addOneWeek(dateIso: string): string {
 return nextWeekExpiration(dateIso.split("T")[0]);
}

function ClosePositionModal({ position, onClose, onSaved, defaultBankingAccountId }: CloseModalProps) {
 const expirationDateStr = position.expirationDate.split("T")[0]; // YYYY-MM-DD
 const defaultAssignedClosedAt = expirationDateStr +"T16:00"; // 4pm ET market close

 const [outcome, setOutcome] = useState<OptionOutcome>("EXPIRED_WORTHLESS");
 const [closedAt, setClosedAt] = useState(getDefaultOpenedAt());
 const [closePremiumPerShare, setClosePremiumPerShare] = useState("");
 const [feesClose, setFeesClose] = useState("");
 const [contractsAssigned, setContractsAssigned] = useState("");
 const [stockPriceAtClose, setStockPriceAtClose] = useState("");
 const [investmentAccountId, setInvestmentAccountId] = useState(position.investmentAccountId ??"");
 const [bankingAccountId, setBankingAccountId] = useState(defaultBankingAccountId ??"");

 // Partial close (splitting) is allowed whenever a position has more than one
 // contract, including legs mid roll-chain — the split-off leg is reported as
 // its own standalone trade rather than folded into the chain's rollup stats.
 // Partial *rolling* an already-chained leg is still unsupported (see the roll
 // route), so that combination stays gated below once isRolled is known.
 const isChained = position.groupId != null;
 const [contractsToClose, setContractsToClose] = useState(position.contracts.toString());

 const { data: investmentAccounts } = useApi(() => getInvestmentAccounts(), []);
 const { data: allAccounts } = useApi(() => getAccounts(), []);
 const bankingAccounts = (allAccounts ?? []).filter((a) => a.type ==="CHECKING" || a.type ==="SAVINGS");

 // Roll-specific: new position fields
 const [newPremiumPerShare, setNewPremiumPerShare] = useState("");
 const [newStrikePrice, setNewStrikePrice] = useState(position.strikePrice.toFixed(2));
 const [newExpirationDate, setNewExpirationDate] = useState(() => addOneWeek(position.expirationDate));
 const [newStockPriceAtOpen, setNewStockPriceAtOpen] = useState("");
 const [newFeesOpen, setNewFeesOpen] = useState("");
 const [priceAtOpenStatus, setPriceAtOpenStatus] = useState<"idle" |"fetching" |"success" |"error">("idle");
 const [priceAtOpenLabel, setPriceAtOpenLabel] = useState("");
 const [assignedPriceFetching, setAssignedPriceFetching] = useState(false);

 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");

 const isExpired = outcome ==="EXPIRED_WORTHLESS";
 const isAssigned = outcome ==="ASSIGNED";
 const isRolled = outcome ==="ROLLED";
 // Rolling a chained leg only supports a full roll (backend still rejects a
 // partial roll once groupId is set); every other outcome can split freely.
 const showSplit = position.contracts > 1 && !(isRolled && isChained);

 // Upcoming earnings for the rolled-to expiration — the new leg carries the
 // same gap risk as a freshly opened position. Only fetched once ROLLED is
 // picked, since the other outcomes have no forward expiration.
 const { data: rollEarningsMap } = useApi(
 () =>
 isRolled
 ? getOptionsEarnings([position.ticker.symbol], localToday())
 : Promise.resolve({} as Record<string, EarningsInfo | null>),
 [isRolled, position.ticker.symbol]
 );
 const rollEarnings = rollEarningsMap?.[position.ticker.symbol.toUpperCase()] ?? null;
 const showRollEarningsWarning = earningsBeforeExpiry(rollEarnings, newExpirationDate);

 // On mount: if the option has already expired, resolve the assignment stock
 // price and default to ASSIGNED when the contract finished in-the-money.
 // For a CALL: ITM when price > strike. For a PUT: ITM when price < strike.
 // The existing isAssigned effects cascade from this and fill in the other fields.
 useEffect(() => {
 // Option expiry is treated as 4 pm ET = 20:00 UTC on the expiration date.
 const expiryUtc = new Date(expirationDateStr +"T20:00:00.000Z");
 if (Date.now() <= expiryUtc.getTime()) return; // not yet expired

 let cancelled = false;
 getAssignmentStockPrice(position.ticker.symbol, expirationDateStr)
 .then((price) => {
 if (cancelled) return;
 const strike = position.strikePrice;
 const itm = position.optionType ==="CALL" ? price > strike : price < strike;
 if (itm) setOutcome("ASSIGNED");
 })
 .catch(() => {}); // fall back silently to EXPIRED_WORTHLESS
 return () => { cancelled = true; };
 }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
 getAssignmentStockPrice(position.ticker.symbol, expirationDateStr)
 .then((price) => { if (!cancelled) setStockPriceAtClose(price.toFixed(2)); })
 .catch(() => {})
 .finally(() => { if (!cancelled) setAssignedPriceFetching(false); });
 return () => { cancelled = true; };
 }, [isAssigned, expirationDateStr, position.ticker.symbol]);

 // Auto-fetch stock price when closedAt changes and outcome is ROLLED
 useEffect(() => {
 if (!isRolled || !closedAt) return;
 let cancelled = false;
 setPriceAtOpenStatus("fetching");
 getStockPriceAtOpen(position.ticker.symbol, closedAt)
 .then((r) => {
 if (cancelled) return;
 setNewStockPriceAtOpen(r.price.toFixed(2));
 setPriceAtOpenLabel(r.timeLabel);
 setPriceAtOpenStatus("success");
 })
 .catch(() => { if (!cancelled) setPriceAtOpenStatus("error"); });
 return () => { cancelled = true; };
 }, [isRolled, closedAt, position.ticker.symbol]);

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();

 // Resolve how many contracts this action applies to. Splitting only happens
 // when the user picks fewer than the full size on a splittable position.
 const n = showSplit ? parseInt(contractsToClose, 10) : position.contracts;
 if (showSplit && (!Number.isInteger(n) || n < 1 || n > position.contracts)) {
 setError(`Enter between 1 and ${position.contracts} contracts.`);
 return;
 }
 const isPartial = showSplit && n < position.contracts;

 setSaving(true);
 setError("");
 try {
 if (isRolled) {
 await rollOptionsPosition(position.id, {
 closedAt: closedAt ? etToUtc(closedAt) : null,
 closePremiumPerShare: closePremiumPerShare ? parseAmount(closePremiumPerShare) : null,
 feesClose: feesClose ? parseAmount(feesClose) : null,
 newPremiumPerShare: parseAmount(newPremiumPerShare),
 newStrikePrice: parseAmount(newStrikePrice),
 newExpirationDate,
 newStockPriceAtOpen: newStockPriceAtOpen ? parseAmount(newStockPriceAtOpen) : null,
 newFeesOpen: newFeesOpen ? parseAmount(newFeesOpen) : null,
 ...(isPartial ? { contracts: n } : {}),
 });
 } else if (isPartial) {
 // Partial close → split N contracts off into a new closed leg.
 await partialCloseOptionsPosition(position.id, {
 contracts: n,
 outcome: outcome as Exclude<OptionOutcome,"ROLLED">,
 closedAt: isExpired ? null : closedAt ? etToUtc(closedAt) : null,
 closePremiumPerShare: isExpired || isAssigned ? null : closePremiumPerShare ? parseAmount(closePremiumPerShare) : null,
 feesClose: feesClose ? parseAmount(feesClose) : null,
 stockPriceAtClose: isAssigned && stockPriceAtClose ? parseAmount(stockPriceAtClose) : null,
 investmentAccountId: isAssigned ? (investmentAccountId || null) : undefined,
 bankingAccountId: bankingAccountId || null,
 });
 } else {
 const statusMap: Record<OptionOutcome, Exclude<import("@/api").OptionStatus,"OPEN">> = {
 EXPIRED_WORTHLESS:"EXPIRED",
 CLOSED_EARLY:"CLOSED",
 ROLLED:"CLOSED",
 ASSIGNED:"ASSIGNED",
 };
 // Full close. When splitting is available the"contracts to close" field
 // doubles as the assigned count; otherwise (single contract, or rolling a
 // chained leg) the legacy contractsAssigned field is used.
 const assignedCount = isAssigned
 ? (showSplit ? n : (contractsAssigned ? parseInt(contractsAssigned, 10) : null))
 : null;
 const data: OptionsCloseInput = {
 status: statusMap[outcome],
 outcome,
 closedAt: isExpired ? null : closedAt ? etToUtc(closedAt) : null,
 closePremiumPerShare: isExpired || isAssigned ? null : closePremiumPerShare ? parseAmount(closePremiumPerShare) : null,
 feesClose: feesClose ? parseAmount(feesClose) : null,
 contractsAssigned: assignedCount,
 stockPriceAtClose: isAssigned && stockPriceAtClose ? parseAmount(stockPriceAtClose) : null,
 investmentAccountId: isAssigned ? (investmentAccountId || null) : undefined,
 bankingAccountId: bankingAccountId || null,
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
 { value:"EXPIRED_WORTHLESS", label:"Expired Worthless" },
 { value:"CLOSED_EARLY", label:"Closed Early" },
 { value:"ROLLED", label:"Rolled to New Position" },
 { value:"ASSIGNED", label:"Assigned" },
];

 const inputClass ="w-full rounded-md border border-border px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
 const dollarInputClass ="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

 return (
 <Modal open onClose={onClose} title={`Close: ${position.ticker.symbol} $${position.strikePrice} ${position.optionType}`}>
 <form onSubmit={handleSubmit} noValidate className="space-y-4">
 {/* Outcome selector */}
 <div>
 <label className="block text-xs font-medium mb-1">Outcome</label>
 <div className="grid grid-cols-2 rounded-md border border-border overflow-hidden text-13 font-medium">
 {outcomeOptions.map((o, i) => (
 <button
 key={o.value}
 type="button"
 onClick={() => setOutcome(o.value)}
 className={cn(
"py-2 px-3 text-left transition-colors",
 i % 2 !== 0 &&"border-l border-border",
 i >= 2 &&"border-t border-border",
 outcome === o.value
 ?"bg-primary text-primary-foreground"
 :"bg-background text-foreground hover:bg-muted"
 )}
 >
 {o.label}
 </button>
 ))}
 </div>
 </div>

 {/* Contracts to close — splitting. Hidden for single-contract positions,
 and for rolling a chained leg (partial rolls of an already-rolled
 position aren't supported), which always act on the full size. */}
 {showSplit && (() => {
 const n = parseInt(contractsToClose, 10);
 const remaining = Number.isInteger(n) ? position.contracts - n : null;
 const label = isRolled ?"Contracts to Roll" : isAssigned ?"Contracts Assigned" :"Contracts to Close";
 return (
 <div>
 <label className="block text-xs font-medium mb-1">
 {label}{" "}
 <span className="text-muted-foreground font-normal">of {position.contracts}</span>
 </label>
 <input
 type="number" min={1} max={position.contracts} inputMode="numeric"
 value={contractsToClose} onChange={(e) => setContractsToClose(e.target.value)}
 className={cn(inputClass,"[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none")}
 />
 {remaining != null && remaining > 0 && (
 <p className="mt-1.5 text-xs text-muted-foreground">
 {remaining} contract{remaining !== 1 ?"s" :""} will stay open on this position.
 </p>
 )}
 </div>
 );
 })()}

 {/* ── Close fields ── */}
 {!isExpired && (
 <div>
 <label className="block text-xs font-medium mb-1">
 {isRolled ?"Date / Time Rolled" :"Date Closed"}{" "}
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
 {isRolled ?"Buy-back Premium / Share" :"Close Premium / Share"}
 </label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={closePremiumPerShare} onChange={(e) => setClosePremiumPerShare(e.target.value)}
 className={dollarInputClass}
 />
 </div>
 </div>
 )}

 {isAssigned && (
 <>
 {/* Legacy assigned-count field — only when the unified"Contracts
 Assigned" split input above isn't shown (chained or single-contract). */}
 {!showSplit && (
 <div>
 <label className="block text-xs font-medium mb-1">Contracts Assigned</label>
 <input
 type="text" inputMode="numeric"
 value={contractsAssigned} onChange={(e) => setContractsAssigned(e.target.value)}
 className={inputClass}
 />
 </div>
 )}
 <div>
 <label className="block text-xs font-medium mb-1">
 Stock Price at Assignment{" "}
 <span className="text-muted-foreground font-normal">
 {assignedPriceFetching ?"(fetching…)" :"(from Tradier)"}
 </span>
 </label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={stockPriceAtClose} onChange={(e) => setStockPriceAtClose(e.target.value)}
 placeholder={assignedPriceFetching ?"Fetching…" :""}
 className={dollarInputClass}
 />
 </div>
 </div>
 {(() => {
 const eligible = (investmentAccounts ?? []).filter((a) => a.type ==="INVESTMENT" && !a.isManaged);
 const isCall = position.optionType ==="CALL";
 const lotLocked = isCall && position.assignedFromStrikePrice != null;
 const accountLabel = isCall ?"(where shares will be sold)" :"(where shares will be purchased)";
 return eligible.length > 0 ? (
 <div>
 <label className="block text-xs font-medium mb-1">
 Investment Account <span className="text-muted-foreground font-normal">{accountLabel}</span>
 </label>
 {lotLocked ? (
 <div className="rounded-md border border-border bg-muted px-3 py-2 text-13 text-foreground">
 {eligible.find((a) => a.id === investmentAccountId)?.name ??"—"}
 <span className="ml-2 text-xs text-muted-foreground">(linked via assigned lot)</span>
 </div>
 ) : (
 <div className="relative">
 <select
 value={investmentAccountId}
 onChange={(e) => setInvestmentAccountId(e.target.value)}
 className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-foreground"
 >
 <option value="">None</option>
 {eligible.map((a) => (
 <option key={a.id} value={a.id}>{a.name}</option>
 ))}
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 )}
 </div>
 ) : null;
 })()}
 </>
 )}

 {!isRolled && bankingAccounts.length > 0 && (
 <div>
 <label className="block text-xs font-medium mb-1">
 Destination Account <span className="text-muted-foreground font-normal">(for income record)</span>
 </label>
 <div className="relative">
 <select
 value={bankingAccountId}
 onChange={(e) => setBankingAccountId(e.target.value)}
 className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-foreground"
 >
 <option value="">None</option>
 {bankingAccounts.map((a) => (
 <option key={a.id} value={a.id}>{a.name}</option>
 ))}
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 </div>
 )}

 <div>
 <label className="block text-xs font-medium mb-1">
 {isRolled ?"Fees at Close (buy-back)" :"Fees at Close"}{" "}
 <span className="text-muted-foreground font-normal">(optional)</span>
 </label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={feesClose} onChange={(e) => setFeesClose(e.target.value)}
 className={dollarInputClass}
 />
 </div>
 {isAssigned && position.optionType ==="CALL" && (
 <p className="mt-1.5 text-xs text-muted-foreground">
 For option contract fees only. Any brokerage or SEC fees on the share sale can be entered when reviewing the pending sale.
 </p>
 )}
 </div>

 {/* ── New position fields (roll only) ── */}
 {isRolled && (
 <>
 <div className="border-t border-border pt-4">
 <p className="font-semibold mb-3">New Position</p>
 <div className="rounded-md bg-muted px-3 py-2 text-muted-foreground mb-3 space-y-0.5">
 <div><span className="font-medium text-foreground">{position.ticker.symbol}</span> · {position.contracts} contract{position.contracts !== 1 ?"s" :""} · {position.optionType ==="CALL" ?"Covered Call" :"Cash-Secured Put"}</div>
 </div>

 <div className="space-y-4">
 {/* Premium / share */}
 <div>
 <label className="block text-xs font-medium mb-1">Premium / Share</label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal" required
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
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal" required
 value={newStrikePrice} onChange={(e) => setNewStrikePrice(e.target.value)}
 className={dollarInputClass}
 />
 </div>
 </div>
 <div>
 <label className="flex items-center gap-1 text-xs font-medium mb-1">
 Expiration Date
 {showRollEarningsWarning && (
 <Tooltip content={earningsWarningText(rollEarnings!)}>
 <span className="inline-flex items-center text-warn">
 <AlertTriangle className="h-3 w-3" />
 </span>
 </Tooltip>
 )}
 </label>
 <div className="flex items-center w-full">
 <DatePicker
 required
 value={newExpirationDate} onChange={setNewExpirationDate}
 className="w-[120px] shrink-0"
 />
 <div className="ml-auto flex items-center gap-0.5">
 {newExpirationDate && (
 <span className="mr-1 text-xs text-muted-foreground whitespace-nowrap tabular-nums">
 {calcDTE(newExpirationDate)} DTE
 </span>
 )}
 <button
 type="button"
 aria-label="Previous week"
 onClick={() => setNewExpirationDate(prevWeekExpiration(newExpirationDate))}
 className="rounded p-1 text-ink-3 hover:bg-muted-hover hover:text-ink transition-colors"
 >
 <ChevronLeft className="h-3.5 w-3.5" />
 </button>
 <button
 type="button"
 aria-label="Next week"
 onClick={() => setNewExpirationDate(nextWeekExpiration(newExpirationDate))}
 className="rounded p-1 text-ink-3 hover:bg-muted-hover hover:text-ink transition-colors"
 >
 <ChevronRight className="h-3.5 w-3.5" />
 </button>
 </div>
 </div>
 </div>
 </div>

 {/* Stock price (auto-fetched, editable) */}
 <div>
 <label className="block text-xs font-medium mb-1">
 Stock Price at Open{" "}
 <span className="text-muted-foreground font-normal">
 {priceAtOpenStatus ==="fetching" ?"(fetching…)" :"(from Tradier)"}
 </span>
 </label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={newStockPriceAtOpen} onChange={(e) => setNewStockPriceAtOpen(e.target.value)}
 placeholder={priceAtOpenStatus ==="fetching" ?"Fetching…" :""}
 className={dollarInputClass}
 />
 </div>
 {priceAtOpenStatus ==="success" && <p className="mt-1 tp-caption">Price as of {priceAtOpenLabel}</p>}
 {priceAtOpenStatus ==="error" && <p className="mt-1 text-xs text-down">Price fetch failed</p>}
 </div>

 {/* Fees at open for the new position */}
 <div>
 <label className="block text-xs font-medium mb-1">Fees at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={newFeesOpen} onChange={(e) => setNewFeesOpen(e.target.value)}
 className={dollarInputClass}
 />
 </div>
 </div>
 </div>
 </div>
 </>
 )}

 {error && <p className="text-down">{error}</p>}

 <div className="flex justify-end gap-2 pt-2">
 <Button variant="secondary" onClick={onClose}>Cancel</Button>
 <Button type="submit" disabled={saving}>
 {saving ?"Saving…" : isRolled ?"Roll Position" :"Close Position"}
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
 const isRolled = position.outcome ==="ROLLED";
 const isPartOfChain = !!position.groupId;
 const lockTimestamp = isRolled && isPartOfChain;

 const expirationDateStr = position.expirationDate.split("T")[0]; // YYYY-MM-DD
 const defaultAssignedClosedAt = expirationDateStr +"T16:00"; // 4pm ET market close

 const [outcome, setOutcome] = useState<OptionOutcome>(position.outcome ??"EXPIRED_WORTHLESS");
 const [closedAt, setClosedAt] = useState(() => {
 if (!position.closedAt) return"";
 const d = new Date(position.closedAt);
 d.setHours(d.getHours() - 4); // UTC → EDT approximation
 return d.toISOString().slice(0, 16);
 });
 const [closePremiumPerShare, setClosePremiumPerShare] = useState(
 position.closePremiumPerShare?.toString() ??""
 );
 const [feesClose, setFeesClose] = useState(position.feesClose?.toString() ??"");
 const [contractsAssigned, setContractsAssigned] = useState(
 position.contractsAssigned?.toString() ??""
 );
 const [stockPriceAtClose, setStockPriceAtClose] = useState(
 position.stockPriceAtClose?.toString() ??""
 );
 const [investmentAccountId, setInvestmentAccountId] = useState(position.investmentAccountId ??"");
 const [bankingAccountId, setBankingAccountId] = useState(position.bankingAccountId ??"");
 const [assignedPriceFetching, setAssignedPriceFetching] = useState(false);
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");

 const { data: investmentAccounts } = useApi(() => getInvestmentAccounts(), []);
 const { data: allAccounts } = useApi(() => getAccounts(), []);
 const bankingAccounts = (allAccounts ?? []).filter((a) => a.type ==="CHECKING" || a.type ==="SAVINGS");

 const isExpired = outcome ==="EXPIRED_WORTHLESS";
 const isAssigned = outcome ==="ASSIGNED";

 // When switching to ASSIGNED, default closedAt to expiration date at 4pm ET
 useEffect(() => {
 if (isAssigned && !closedAt) setClosedAt(defaultAssignedClosedAt);
 }, [isAssigned]); // eslint-disable-line react-hooks/exhaustive-deps

 // Auto-fetch stock price when newly switching to ASSIGNED and no price recorded yet
 useEffect(() => {
 if (!isAssigned || stockPriceAtClose) return;
 let cancelled = false;
 setAssignedPriceFetching(true);
 getAssignmentStockPrice(position.ticker.symbol, expirationDateStr)
 .then((price) => { if (!cancelled) setStockPriceAtClose(price.toFixed(2)); })
 .catch(() => {})
 .finally(() => { if (!cancelled) setAssignedPriceFetching(false); });
 return () => { cancelled = true; };
 }, [isAssigned, expirationDateStr, position.ticker.symbol]); // eslint-disable-line react-hooks/exhaustive-deps

 const statusMap: Record<OptionOutcome, Exclude<import("@/api").OptionStatus,"OPEN">> = {
 EXPIRED_WORTHLESS:"EXPIRED",
 CLOSED_EARLY:"CLOSED",
 ROLLED:"CLOSED",
 ASSIGNED:"ASSIGNED",
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
 closePremiumPerShare: isExpired || isAssigned ? null : closePremiumPerShare ? parseAmount(closePremiumPerShare) : null,
 feesClose: feesClose ? parseAmount(feesClose) : null,
 contractsAssigned: isAssigned && contractsAssigned ? parseInt(contractsAssigned, 10) : null,
 stockPriceAtClose: isAssigned && stockPriceAtClose ? parseAmount(stockPriceAtClose) : null,
 investmentAccountId: isAssigned ? (investmentAccountId || null) : undefined,
 bankingAccountId: isRolled ? undefined : (bankingAccountId || null),
 });
 onSaved();
 } catch {
 setError("Failed to save changes.");
 } finally {
 setSaving(false);
 }
 };

 const outcomeOptions: { value: OptionOutcome; label: string }[] = [
 { value:"EXPIRED_WORTHLESS", label:"Expired Worthless" },
 { value:"CLOSED_EARLY", label:"Closed Early" },
 { value:"ROLLED", label:"Rolled to New Position" },
 { value:"ASSIGNED", label:"Assigned" },
];

 const inputClass ="w-full rounded-md border border-border px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
 const dollarInputClass ="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

 return (
 <Modal open onClose={onClose} title={`Edit Close: ${position.ticker.symbol} $${position.strikePrice} ${position.optionType}`}>
 <form onSubmit={handleSubmit} noValidate className="space-y-4">
 <div>
 <label className="block text-xs font-medium mb-1">Outcome</label>
 <div className="grid grid-cols-2 rounded-md border border-border overflow-hidden text-13 font-medium">
 {outcomeOptions.map((o, i) => (
 <button
 key={o.value}
 type="button"
 onClick={() => setOutcome(o.value)}
 className={cn(
"py-2 px-3 text-left transition-colors",
 i % 2 !== 0 &&"border-l border-border",
 i >= 2 &&"border-t border-border",
 outcome === o.value
 ?"bg-primary text-primary-foreground"
 :"bg-background text-foreground hover:bg-muted"
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
 <div className="rounded-md border border-border bg-muted px-3 py-2 text-muted-foreground">
 {closedAt ||"—"}
 <span className="ml-2 text-xs">(locked — part of a roll)</span>
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
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
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
 type="text" inputMode="numeric"
 value={contractsAssigned} onChange={(e) => setContractsAssigned(e.target.value)}
 className={inputClass}
 />
 </div>
 <div>
 <label className="block text-xs font-medium mb-1">
 Stock Price at Assignment{" "}
 <span className="text-muted-foreground font-normal">
 {assignedPriceFetching ?"(fetching…)" :"(from Tradier)"}
 </span>
 </label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={stockPriceAtClose} onChange={(e) => setStockPriceAtClose(e.target.value)}
 placeholder={assignedPriceFetching ?"Fetching…" :""}
 className={dollarInputClass}
 />
 </div>
 </div>
 {(() => {
 const eligible = (investmentAccounts ?? []).filter((a) => a.type ==="INVESTMENT" && !a.isManaged);
 const isCall = position.optionType ==="CALL";
 const lotLocked = isCall && position.assignedFromStrikePrice != null;
 const accountLabel = isCall ?"(where shares will be sold)" :"(where shares will be purchased)";
 return eligible.length > 0 ? (
 <div>
 <label className="block text-xs font-medium mb-1">
 Investment Account <span className="text-muted-foreground font-normal">{accountLabel}</span>
 </label>
 {lotLocked ? (
 <div className="rounded-md border border-border bg-muted px-3 py-2 text-13 text-foreground">
 {eligible.find((a) => a.id === investmentAccountId)?.name ??"—"}
 <span className="ml-2 text-xs text-muted-foreground">(linked via assigned lot)</span>
 </div>
 ) : (
 <div className="relative">
 <select
 value={investmentAccountId}
 onChange={(e) => setInvestmentAccountId(e.target.value)}
 className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-foreground"
 >
 <option value="">None</option>
 {eligible.map((a) => (
 <option key={a.id} value={a.id}>{a.name}</option>
 ))}
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 )}
 </div>
 ) : null;
 })()}
 </>
 )}

 {!isRolled && bankingAccounts.length > 0 && (
 <div>
 <label className="block text-xs font-medium mb-1">
 Destination Account <span className="text-muted-foreground font-normal">(for income record)</span>
 </label>
 <div className="relative">
 <select
 value={bankingAccountId}
 onChange={(e) => setBankingAccountId(e.target.value)}
 className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-foreground"
 >
 <option value="">None</option>
 {bankingAccounts.map((a) => (
 <option key={a.id} value={a.id}>{a.name}</option>
 ))}
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 </div>
 )}

 <div>
 <label className="block text-xs font-medium mb-1">Fees at Close <span className="text-muted-foreground font-normal">(optional)</span></label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={feesClose} onChange={(e) => setFeesClose(e.target.value)}
 className={dollarInputClass}
 />
 </div>
 </div>

 {error && <p className="text-down">{error}</p>}

 <div className="flex items-center justify-between pt-2">
 <button
 type="button"
 onClick={onEditPositionDetails}
 className="text-primary hover:underline underline-offset-2 transition-colors"
 >
 Edit Position Details
 </button>
 <div className="flex gap-2">
 <Button variant="secondary" onClick={onClose}>Cancel</Button>
 <Button type="submit" disabled={saving}>{saving ?"Saving…" :"Save Changes"}</Button>
 </div>
 </div>
 </form>
 </Modal>
 );
}

// ── Settings Modal ─────────────────────────────────────────────────────────────

interface SettingsModalProps {
 current: OptionsSettings | null;
 capitalChanges: OptionsCapitalChange[];
 onClose: () => void;
 onSaved: () => void;
 onCapitalChangeMutated: () => void;
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
 const monLabel =`${cursor.getMonth() + 1}/${cursor.getDate()}`;
 const friLabel =`${fri.getMonth() + 1}/${fri.getDate()}`;
 const monIso = cursor.toISOString().split("T")[0];
 weeks.push({ monIso, label:`${monLabel}-${friLabel}` });
 cursor.setDate(cursor.getDate() + 7);
 }
 return weeks;
}

function SettingsModal({ current, capitalChanges, onClose, onSaved, onCapitalChangeMutated }: SettingsModalProps) {
 const [startingBasis, setStartingBasis] = useState(current?.startingBasis?.toString() ??"");
 const [targetReturn, setTargetReturn] = useState(
 current ? (current.targetReturn * 100).toFixed(1) :""
 );
 const [startingWeek, setStartingWeek] = useState(current?.startingWeek ??"");
 const [defaultCashAccountId, setDefaultCashAccountId] = useState(current?.defaultCashAccountId ??"");
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");

 const { data: allAccounts } = useApi(() => getAccounts(), []);
 const bankingAccounts = (allAccounts ?? []).filter((a) => a.type ==="CHECKING" || a.type ==="SAVINGS");

 // Client LOCAL date (en-CA → YYYY-MM-DD), not UTC — so the live-vs-back-dated
 // snapshot decision doesn't shift a day near midnight ET. See [[feedback_local_date_utc]].
 const todayStr = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
 const [showAdjustForm, setShowAdjustForm] = useState(false);
 const [adjustDate, setAdjustDate] = useState(todayStr);
 const [adjustDelta, setAdjustDelta] = useState("");
 const [adjustNote, setAdjustNote] = useState("");
 const [adjustSaving, setAdjustSaving] = useState(false);
 const [adjustError, setAdjustError] = useState("");

 const handleAddAdjustment = async () => {
 const delta = parseAmount(adjustDelta);
 if (isNaN(delta) || delta === 0) { setAdjustError("Enter a non-zero amount."); return; }
 setAdjustSaving(true);
 setAdjustError("");
 try {
 await createOptionsCapitalChange({ effectiveDate: adjustDate, delta, note: adjustNote || null, today: todayStr });
 onCapitalChangeMutated();
 setAdjustDelta("");
 setAdjustNote("");
 setAdjustDate(todayStr);
 setShowAdjustForm(false);
 } catch {
 setAdjustError("Failed to save adjustment.");
 } finally {
 setAdjustSaving(false);
 }
 };

 const handleDeleteAdjustment = async (id: string) => {
 await deleteOptionsCapitalChange(id);
 onCapitalChangeMutated();
 };

 const sortedChanges = useMemo(
 () => [...capitalChanges].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
 [capitalChanges]
 );

 const runningBasisRows = useMemo(() => {
 const basis = parseAmount(startingBasis) || 0;
 let running = basis;
 return sortedChanges.map((c) => {
 running += Number(c.delta);
 return { ...c, runningBasis: running };
 });
 }, [sortedChanges, startingBasis]);

 const yearWeeks = useMemo(() => getYearWeeks(), []);

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 setSaving(true);
 setError("");
 try {
 await updateOptionsSettings({
 startingBasis: parseAmount(startingBasis),
 targetReturn: parseFloat(targetReturn) / 100,
 startingWeek: startingWeek || null,
 defaultCashAccountId: defaultCashAccountId || null,
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
 <form onSubmit={handleSubmit} noValidate className="space-y-4">
 <div>
 <label className="block text-xs font-medium mb-1">Starting Basis</label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal" required
 value={startingBasis} onChange={(e) => setStartingBasis(e.target.value)}
 className="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 <p className="tp-caption mt-1.5">Total capital allocated to options trading — used as the denominator for annualized return calculations.</p>
 </div>

 <div>
 <label className="block text-xs font-medium mb-1">Basis Adjustments</label>

 {/* Capital change history */}
 {runningBasisRows.length > 0 && (
 <div className="mb-2 border border-border rounded-md overflow-hidden">
 <table className="w-full text-xs">
 <thead>
 <tr className="bg-muted text-muted-foreground">
 <th className="px-3 py-1.5 text-left font-medium">Date</th>
 <th className="px-3 py-1.5 text-right font-medium">Change</th>
 <th className="px-3 py-1.5 text-right font-medium">New Basis</th>
 <th className="px-3 py-1.5 text-left font-medium">Note</th>
 <th className="px-2 py-1.5" />
 </tr>
 </thead>
 <tbody>
 {runningBasisRows.map((row) => (
 <tr key={row.id} className="border-t border-border">
 <td className="px-3 py-1.5 tabular-nums font-mono">{row.effectiveDate}</td>
 <td className={cn("px-3 py-1.5 text-right tabular-nums font-mono", Number(row.delta) >= 0 ?"text-up" :"text-down")}>
 {Number(row.delta) >= 0 ?"+" :""}${Math.abs(Number(row.delta)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
 </td>
 <td className="px-3 py-1.5 text-right tabular-nums font-mono">
 ${row.runningBasis.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
 </td>
 <td className="px-3 py-1.5 text-muted-foreground">{row.note ??""}</td>
 <td className="px-2 py-1.5 text-right">
 <button
 type="button"
 onClick={() => handleDeleteAdjustment(row.id)}
 className="text-muted-foreground hover:text-down transition-colors"
 aria-label="Remove"
 >×</button>
 </td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}

 {/* Adjust form or trigger link */}
 {showAdjustForm ? (
 <div className="space-y-2">
 <div className="flex gap-2">
 <div className="flex-1">
 <label className="block tp-caption mb-1">Date</label>
 <DatePicker
 value={adjustDate} onChange={setAdjustDate}
 max={todayStr}
 className="w-full"
 />
 </div>
 <div className="flex-1">
 <label className="block tp-caption mb-1">Amount (+ deposit / − withdrawal)</label>
 <input
 type="text" inputMode="decimal" placeholder="e.g. 5000 or -2000"
 value={adjustDelta} onChange={(e) => setAdjustDelta(e.target.value)}
 onKeyDown={(e) => { if (e.key ==="Enter") handleAddAdjustment(); }}
 className="w-full rounded-md border border-border px-2 py-1.5 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 </div>
 <div>
 <label className="block tp-caption mb-1">Note (optional)</label>
 <input
 type="text" placeholder="e.g. Additional funding"
 value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)}
 onKeyDown={(e) => { if (e.key ==="Enter") handleAddAdjustment(); }}
 className="w-full rounded-md border border-border px-2 py-1.5 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 {adjustError && <p className="text-xs text-down">{adjustError}</p>}
 <div className="flex gap-2">
 <Button type="button" size="sm" disabled={adjustSaving} onClick={handleAddAdjustment}>{adjustSaving ?"Saving…" :"Add"}</Button>
 <Button type="button" variant="secondary" size="sm" onClick={() => { setShowAdjustForm(false); setAdjustError(""); }}>Cancel</Button>
 </div>
 </div>
 ) : (
 <button
 type="button"
 onClick={() => setShowAdjustForm(true)}
 className="text-xs text-primary hover:underline"
 >
 ± Adjust basis
 </button>
 )}
 <p className="tp-caption mt-1.5">Record cash added to or removed from the trading account so the annualized return is calculated correctly going forward.</p>
 </div>
 <div>
 <label className="block text-xs font-medium mb-1">Starting Week</label>
 <div className="relative">
 <select
 value={startingWeek}
 onChange={(e) => setStartingWeek(e.target.value)}
 className="w-full appearance-none rounded-md border border-border pl-2 pr-6 py-2 text-foreground focus:border-primary focus:outline-none"
 >
 <option value="">— Use first week with closed positions —</option>
 {yearWeeks.map((w) => (
 <option key={w.monIso} value={w.monIso}>{w.label}</option>
 ))}
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 <p className="tp-caption mt-1.5">First week counted toward performance. Sets the origin for charts and annualized return.</p>
 </div>
 <div>
 <label className="block text-xs font-medium mb-1">Target Annual Return</label>
 <div className="relative">
 <input
 type="text" inputMode="decimal" required
 value={targetReturn} onChange={(e) => setTargetReturn(e.target.value)}
 className="w-full rounded-md border border-border px-3 pr-8 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">%</span>
 </div>
 <p className="tp-caption mt-1.5">Used for premium target charts and performance benchmarking.</p>
 </div>
 {bankingAccounts.length > 0 && (
 <div>
 <label className="block text-xs font-medium mb-1">Default Cash Account <span className="text-muted-foreground font-normal">(optional)</span></label>
 <div className="relative">
 <select
 value={defaultCashAccountId}
 onChange={(e) => setDefaultCashAccountId(e.target.value)}
 className="appearance-none w-full rounded-md border border-border pl-2 pr-6 py-2 text-foreground"
 >
 <option value="">None</option>
 {bankingAccounts.map((a) => (
 <option key={a.id} value={a.id}>{a.name}</option>
 ))}
 </select>
 <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 opacity-50" />
 </div>
 <p className="tp-caption mt-1.5">Pre-selected as the destination account for premium income when closing a position.</p>
 </div>
 )}
 {error && <p className="text-down">{error}</p>}
 <div className="flex justify-end gap-2 pt-2">
 <Button variant="secondary" onClick={onClose}>Cancel</Button>
 <Button type="submit" disabled={saving}>{saving ?"Saving…" :"Save Settings"}</Button>
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
 const [stockPriceAtOpen, setStockPriceAtOpen] = useState(position.stockPriceAtOpen?.toString() ??"");
 const [feesOpen, setFeesOpen] = useState(position.feesOpen?.toString() ??"");
 const [priceFetching, setPriceFetching] = useState(false);
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState("");

 useEffect(() => {
 if (position.stockPriceAtOpen != null) return;
 let cancelled = false;
 setPriceFetching(true);
 getUnderlyingQuote(position.ticker.symbol)
 .then((r) => { if (!cancelled) setStockPriceAtOpen(r.price.toFixed(2)); })
 .catch(() => {})
 .finally(() => { if (!cancelled) setPriceFetching(false); });
 return () => { cancelled = true; };
 }, [position.ticker.symbol, position.stockPriceAtOpen]);

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 setSaving(true);
 setError("");
 try {
 await updateOptionsPosition(position.id, {
 isDraft: false,
 openedAt: etToUtc(confirmedAt),
 contracts: parseInt(contracts, 10),
 premiumPerShare: parseAmount(premiumPerShare),
 feesOpen: feesOpen ? parseAmount(feesOpen) : null,
 stockPriceAtOpen: stockPriceAtOpen ? parseAmount(stockPriceAtOpen) : null,
 });
 onSaved();
 } catch {
 setError("Failed to confirm position.");
 } finally {
 setSaving(false);
 }
 };

 const inputClass ="w-full rounded-md border border-border px-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";
 const dollarInputClass ="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

 return (
 <Modal open onClose={onClose} title={`Confirm: ${position.ticker.symbol} $${position.strikePrice} ${position.optionType}`}>
 <form onSubmit={handleSubmit} noValidate className="space-y-4">
 <p className="text-muted-foreground">Confirm the details for this position. All fields are pre-filled with defaults — edit as needed.</p>

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
 type="text" inputMode="numeric" required
 value={contracts} onChange={(e) => setContracts(e.target.value)}
 className={inputClass}
 />
 </div>
 <div>
 <label className="block text-xs font-medium mb-1">Premium / Share</label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal" required
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
 {priceFetching ?"(fetching…)" :"(from Tradier)"}
 </span>
 </label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={stockPriceAtOpen} onChange={(e) => setStockPriceAtOpen(e.target.value)}
 placeholder={priceFetching ?"Fetching…" :""}
 className={dollarInputClass}
 />
 </div>
 </div>

 <div>
 <label className="block text-xs font-medium mb-1">Fees at Open <span className="text-muted-foreground font-normal">(optional)</span></label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 type="text" inputMode="decimal"
 value={feesOpen} onChange={(e) => setFeesOpen(e.target.value)}
 className={dollarInputClass}
 />
 </div>
 </div>

 {error && <p className="text-down">{error}</p>}

 <div className="flex justify-end gap-2 pt-2">
 <Button variant="secondary" onClick={onClose}>Cancel</Button>
 <Button type="submit" disabled={saving}>{saving ?"Saving…" :"Confirm & Open"}</Button>
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
 chainMaxCapitalAtRiskMap: Map<string, number>;
 onEdit: (p: OptionsPosition) => void;
 onClose: (p: OptionsPosition) => void;
 onConfirm: (p: OptionsPosition) => void;
 onPositionUpdated: () => void;
 extraTickers?: string[];
 onPricesUpdated?: (prices: Map<string, number>) => void;
 seedLivePrices?: Map<string, number>;
 tabBarRef?: React.RefObject<HTMLDivElement | null>;
}

const COL_GROUPS = [
 { key:"details", label:"Details", count: 5 },
 { key:"return", label:"Return", count: 3 },
 { key:"risk", label:"Risk", count: 4 },
 { key:"live", label:"Live", count: 6 },
] as const;
type ColGroupKey = (typeof COL_GROUPS)[number]["key"];

function OpenPositionsTable({ positions, draftPositions, chainPnlMap, chainFirstOpenedMap, chainMaxCapitalAtRiskMap, onEdit, onClose, onConfirm, onPositionUpdated, extraTickers, onPricesUpdated, seedLivePrices, tabBarRef }: OpenPositionsTableProps) {
 const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
 const [openColGroups, setOpenColGroups] = useState<Set<ColGroupKey>>(new Set(["live"]));
 const [draftsOpen, setDraftsOpen] = useState(true);
 const tableContainerRef = useRef<HTMLDivElement>(null);
 const theadRef = useRef<HTMLTableSectionElement>(null);
 const portalScrollRef = useRef<HTMLDivElement>(null);
 const [stickyRect, setStickyRect] = useState<{ left: number; width: number; colWidths: number[] } | null>(null);
 // Live data: auto-fetched stock prices; editing buffer for the inline prem field
 const [livePrices, setLivePrices] = useState<Map<string, number>>(() => {
 const cache = readLivePriceCache();
 return new Map(Object.entries(cache).map(([t, e]) => [t, e.price]));
 });
 const [livePriceTs, setLivePriceTs] = useState<Map<string, number>>(() => {
 const cache = readLivePriceCache();
 return new Map(Object.entries(cache).map(([t, e]) => [t, e.ts]));
 });
 // Tickers whose most recent fetch attempt failed to return a fresh quote —
 // the displayed price (if any) is a stale cache leftover. Surfaced in the
 // UI rather than silently trusted; see readLivePriceCache above.
 const [stalePriceTickers, setStalePriceTickers] = useState<Set<string>>(new Set());
 const [editingPremId, setEditingPremId] = useState<string | null>(null);
 const [editingPremValue, setEditingPremValue] = useState("");
 // Per-row fetch tracking is retained for the (currently hidden) line-level
 // refresh control; the setter still runs so re-enabling it needs no rewiring.
 const [, setFetchingQuotes] = useState<Set<string>>(new Set());
 const [quoteErrors, setQuoteErrors] = useState<Map<string, string>>(new Map());

 const updateLivePrice = (ticker: string, price: number, ts: number = Date.now()) => {
 setLivePrices((prev) => new Map(prev).set(ticker, price));
 setLivePriceTs((prev) => new Map(prev).set(ticker, ts));
 try {
 const cache = readLivePriceCache();
 cache[ticker] = { price, ts };
 localStorage.setItem(LS_LIVE_PRICES_KEY, JSON.stringify(cache));
 } catch { /* ignore unavailable localStorage */ }
 };

 // A ticker's cached price is trustworthy only if it was captured after the
 // most recent market close relevant to it — mirrors optionsPricesAreFresh's
 // logic but per-ticker, so one silently-failed symbol in a batch fetch
 // doesn't hide behind a globally-fresh lastFetchedAt.
 const isTickerPriceFresh = (ticker: string) => {
 const ts = livePriceTs.get(ticker);
 return ts != null && optionsPricesAreFresh(new Date(ts));
 };

 useEffect(() => {
 if (!seedLivePrices?.size) return;
 for (const [ticker, price] of seedLivePrices) updateLivePrice(ticker, price);
 }, [seedLivePrices]);

 const fetchAllStockPrices = async () => {
 const uniqueTickers = [...new Set([
 ...[...positions, ...draftPositions].map((p) => p.ticker.symbol),
 ...(extraTickers ?? []),
])];
 if (uniqueTickers.length === 0) return;
 try {
 const results = await getUnderlyingQuotes(uniqueTickers);
 const priceMap = new Map<string, number>();
 const now = Date.now();
 for (const [ticker, data] of Object.entries(results)) {
 updateLivePrice(ticker, data.price, now);
 priceMap.set(ticker, data.price);
 }
 // Anything requested but missing from the response failed to refresh
 // (Tradier dropped/omitted it) — flag it instead of quietly keeping
 // whatever stale value happens to be cached for it.
 const missing = uniqueTickers.filter((t) => !results[t]);
 setStalePriceTickers(new Set(missing));
 onPricesUpdated?.(priceMap);
 } catch {
 // Whole batch failed — every requested ticker's cached price (if any) is
 // now of unknown age; flag them all rather than trusting stale values.
 setStalePriceTickers(new Set(uniqueTickers));
 }
 };

 const tickerKey = [...positions, ...draftPositions].map((p) => p.ticker.symbol).join(",");
 useEffect(() => {
 const tickers = tickerKey ? tickerKey.split(",") : [];
 if (lastFetchedAt != null && optionsPricesAreFresh(lastFetchedAt) && livePrices.size > 0 && tickers.every(isTickerPriceFresh)) return;
 fetchAllStockPrices();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [tickerKey]);

 // Upcoming earnings per ticker, used to flag expirations that straddle a call.
 const [earningsMap, setEarningsMap] = useState<Record<string, EarningsInfo | null>>({});
 useEffect(() => {
 const symbols = [...new Set([...positions, ...draftPositions].map((p) => p.ticker.symbol))];
 if (symbols.length === 0) return;
 getOptionsEarnings(symbols, localToday())
 .then(setEarningsMap)
 .catch(() => {});
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [tickerKey]);

 const isColOpen = (g: ColGroupKey) => openColGroups.has(g);
 const toggleColGroup = (g: ColGroupKey) =>
 setOpenColGroups((prev) => {
 const next = new Set(prev);
 if (next.has(g)) next.delete(g); else next.add(g);
 return next;
 });

 useEffect(() => {
 const NAV_BOTTOM = 72;
 const handleScroll = () => {
 const el = tableContainerRef.current;
 if (!el) return;
 const rect = el.getBoundingClientRect();
 if (rect.top < NAV_BOTTOM && rect.bottom > NAV_BOTTOM) {
 const cells = theadRef.current?.rows[1]?.cells;
 const colWidths = cells ? Array.from(cells).map(c => c.getBoundingClientRect().width) : [];
 setStickyRect({ left: rect.left, width: rect.width, colWidths });
 } else {
 setStickyRect(null);
 }
 };
 window.addEventListener("scroll", handleScroll, { passive: true });
 return () => window.removeEventListener("scroll", handleScroll);
 }, []);

 // Re-measure column widths after the DOM updates when a column group is toggled
 useLayoutEffect(() => {
 setStickyRect(prev => {
 if (!prev) return null;
 const cells = theadRef.current?.rows[1]?.cells;
 const colWidths = cells ? Array.from(cells).map(c => c.getBoundingClientRect().width) : prev.colWidths;
 return { ...prev, colWidths };
 });
 }, [openColGroups]);

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
 await updateOptionsPosition(p.id, { currentPremiumPerShare: lastPrice, currentDelta: quote.delta ?? null, currentDeltaAsOf: quote.deltaUpdatedAt ?? null });
 onPositionUpdated();
 } else {
 setQuoteErrors((prev) => new Map(prev).set(p.id,"No price available"));
 }
 } catch (e) {
 const msg = e instanceof Error ? e.message :"Failed to fetch";
 setQuoteErrors((prev) => new Map(prev).set(p.id, msg));
 } finally {
 setFetchingQuotes((prev) => { const s = new Set(prev); s.delete(p.id); return s; });
 }
 };

 const [refreshingAll, setRefreshingAll] = useState(false);
 const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(() => {
 try {
 const stored = localStorage.getItem(LS_LAST_FETCHED_KEY);
 return stored ? new Date(stored) : null;
 } catch {
 return null;
 }
 });
 const recordFetch = (date: Date) => {
 setLastFetchedAt(date);
 try { localStorage.setItem(LS_LAST_FETCHED_KEY, date.toISOString()); } catch { /* ignore unavailable localStorage */ }
 };
 const fetchAllQuotes = async () => {
 setRefreshingAll(true);
 await fetchAllStockPrices();
 const open = [...positions, ...draftPositions].filter((p) => p.status ==="OPEN" && calcPosition(p).daysLeft >= 0);
 for (let i = 0; i < open.length; i++) {
 await fetchQuoteForPosition(open[i]);
 if (i < open.length - 1) await new Promise((r) => setTimeout(r, 150));
 }
 recordFetch(new Date());
 setRefreshingAll(false);
 };

 // Auto-fetch on load unless we already captured post-close prices today.
 // If lastFetchedAt is null (no prior fetch) or was before today's 5 PM ET,
 // always fetch — regardless of the current time — so the page always shows prices.
 // Also refetches if any individual ticker's cached price isn't itself fresh,
 // even when the global lastFetchedAt flag looks fine (see isTickerPriceFresh).
 // Manual refreshes bypass this guard entirely.
 const positionIdsKey = [...positions, ...draftPositions].filter((p) => p.status ==="OPEN").map((p) => p.id).join(",");
 useEffect(() => {
 if (!positionIdsKey) return;
 const tickers = [...new Set([...positions, ...draftPositions].map((p) => p.ticker.symbol))];
 if (lastFetchedAt != null && optionsPricesAreFresh(lastFetchedAt) && livePrices.size > 0 && tickers.every(isTickerPriceFresh)) return;
 fetchAllQuotes();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [positionIdsKey]);

 if (positions.length === 0 && draftPositions.length === 0) {
 return (
 <div className="text-center py-12 tp-caption">
 No open positions. Click"Open Position" to add one.
 </div>
 );
 }

 const toggleGroup = (id: string) =>
 setExpandedGroups((prev) => {
 const next = new Set(prev);
 if (next.has(id)) next.delete(id); else next.add(id);
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

 // Group positions by their groupId (order preserved from sort above).
 // Standalone positions use their own id as key so they stay interleaved with
 // grouped positions rather than all collapsing into a single null bucket that
 // would render before any named-group entries regardless of sort order.
 const grouped = new Map<string, OptionsPosition[]>();
 for (const p of sorted) {
 const key = p.groupId ?? p.id;
 if (!grouped.has(key)) grouped.set(key, []);
 grouped.get(key)!.push(p);
 }

 // Total columns = 4 (position) + each group (expanded=full, collapsed=1) + 1 (actions)
 const totalCols =
 4 +
 COL_GROUPS.reduce((sum, g) => sum + (isColOpen(g.key) ? g.count : 1), 0) +
 1;

 const thClass ="px-2 py-2 text-left font-mono text-10 font-medium tracking-[0.11em] uppercase text-[var(--color-ink-3)] whitespace-nowrap";
 const renderRow = (p: OptionsPosition, isGrouped = false, isDraftRow = false) => {
 // For draft rows, substitute page-load time so duration/ann-return calculations are meaningful
 const calcP = isDraftRow ? { ...p, openedAt: PAGE_LOAD_TIME } : p;
 const c = calcPosition(calcP);
 const isExpired = c.daysLeft < 0;
 const priorPnl = p.groupId ? (chainPnlMap.get(p.groupId) ?? 0) : 0;
 const hasChain = p.groupId != null && priorPnl !== 0;
 const tdClass = hasChain ?"px-2 pt-2 pb-1 text-13 font-mono tabular-nums whitespace-nowrap" :"px-2 py-2 text-13 font-mono tabular-nums whitespace-nowrap";
 const tdNum = hasChain ?"px-2 pt-2 pb-1 tp-numeric whitespace-nowrap" :"px-2 py-2 tp-numeric whitespace-nowrap";
 const tdTextClass = hasChain ?"px-2 pt-2 pb-1 text-13 whitespace-nowrap" :"px-2 py-2 text-13 whitespace-nowrap";
 const chainNet = hasChain ? priorPnl + c.totalPremiumNet : null;

 // Live section
 const isEditingThisPrem = editingPremId === p.id;
 const curPrem = isEditingThisPrem
 ? (editingPremValue !=="" ? parseAmount(editingPremValue) : null)
 : p.currentPremiumPerShare ?? null;
 const stockNow = livePrices.get(p.ticker.symbol) ?? null;
 const livePnl = curPrem != null
 ? (p.premiumPerShare - curPrem) * 100 * p.contracts - (p.feesOpen ?? 0)
 : null;
 const chainLivePnl = hasChain && livePnl != null ? priorPnl + livePnl : null;
 // Shared Live P&L cell body — excluded positions hide the number behind an
 // eye-off icon (its value would otherwise distort the Total Live P&L rollup);
 // the actual amount — plus the roll-chain net, when applicable — lives in the tooltip.
 const livePnlCell = livePnl == null
 ? <span className="text-muted-foreground">—</span>
 : p.excludeFromLivePnl
 ? <Tooltip content={
 <div className="tp-caption text-left leading-relaxed">
 <div>Excludes <span className="font-medium text-foreground">{livePnl >= 0 ?"+" :"−"}${fmtUSD(Math.abs(livePnl))}</span> from Total Live P&L</div>
 {chainLivePnl != null && (
 <div>Net Live P&L: <span className="font-medium text-foreground">{chainLivePnl >= 0 ?"+" :"−"}${fmtUSD(Math.abs(chainLivePnl))}</span></div>
 )}
 </div>
 }>
 <span className="inline-flex items-center text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors">
 <EyeOff className="h-3.5 w-3.5 shrink-0" />
 </span>
 </Tooltip>
 : <span className={cn(livePnl >= 0 ?"text-up" :"text-down")}>
 {livePnl >= 0 ?"+" :"−"}${fmtUSD(Math.abs(livePnl))}
 </span>;
 const pctOtmNow = stockNow != null
 ? (p.strikePrice - stockNow) / stockNow * 100
 : null;
 // In-the-money: %OTM > 0 for CSPs (PUT), < 0 for CCs (CALL).
 const isItm = !isExpired && pctOtmNow != null && (p.optionType ==="PUT" ? pctOtmNow > 0 : pctOtmNow < 0);
 const daysInTrade = (Date.now() - new Date(p.openedAt).getTime()) / 86_400_000;
 const curAnnRet = livePnl != null && c.capitalAtRisk > 0 && daysInTrade > 0
 ? (livePnl / c.capitalAtRisk) * (365 / daysInTrade) * 100
 : null;

 // Roll-candidacy metrics for ITM positions. Intrinsic value is the amount by
 // which the option is in the money (CALL: stock − strike; PUT: strike − stock);
 // extrinsic is whatever premium remains above it — the portion that decays and
 // is worth buying back / rolling. A thin extrinsic ratio (or a high delta)
 // signals the option is deep enough that assignment is likely.
 const intrinsicNow = stockNow != null
 ? Math.max(0, p.optionType ==="CALL" ? stockNow - p.strikePrice : p.strikePrice - stockNow)
 : null;
 const extrinsicNow = curPrem != null && intrinsicNow != null ? curPrem - intrinsicNow : null;
 const extrinsicRatio = extrinsicNow != null && curPrem != null && curPrem > 0
 ? (extrinsicNow / curPrem) * 100
 : null;
 const showRollInfo = isItm && extrinsicNow != null;

 // Earnings landing inside the holding period — gap risk the expiry date alone
 // doesn't convey.
 const earnings = earningsMap[p.ticker.symbol.toUpperCase()] ?? null;
 const hasEarningsRisk = earningsBeforeExpiry(earnings, p.expirationDate);

 // Chain-level metrics
 const realBreakeven = hasChain ? c.breakeven - priorPnl / (p.contracts * 100) : null;
 const chainFirstMs = hasChain ? chainFirstOpenedMap.get(p.groupId!) ?? null : null;
 // Max capital at risk across all legs — matches the closed-tab denominator
 // so live ARR doesn't jump when the final leg closes.
 const chainCapitalAtRisk = hasChain
 ? Math.max(chainMaxCapitalAtRiskMap.get(p.groupId!) ?? 0, c.capitalAtRisk)
 : c.capitalAtRisk;
 // Days from original open to now (for live ann. return)
 const chainDaysFromOpenToNow = chainFirstMs != null ? (Date.now() - chainFirstMs) / 86_400_000 : null;
 const chainCurAnnRet =
 chainLivePnl != null && chainCapitalAtRisk > 0 && chainDaysFromOpenToNow != null && chainDaysFromOpenToNow > 0
 ? (chainLivePnl / chainCapitalAtRisk) * (365 / chainDaysFromOpenToNow) * 100
 : null;
 // Days from original open to current leg's expiry (for duration display + ann. return at expiry)
 const chainExpiryMs = new Date(p.openedAt).getTime() + c.durationDays * 86_400_000;
 const chainTotalDaysToExpiry = chainFirstMs != null ? (chainExpiryMs - chainFirstMs) / 86_400_000 : null;
 const chainDaysInTrade = chainTotalDaysToExpiry;
 const chainAnnRetAtExpiry =
 chainNet != null && chainCapitalAtRisk > 0 && chainTotalDaysToExpiry != null && chainTotalDaysToExpiry > 0
 ? (chainNet / chainCapitalAtRisk) * (365 / chainTotalDaysToExpiry) * 100
 : null;

 const ctd ="px-2 pb-2 text-xs font-mono tabular-nums whitespace-nowrap text-muted-foreground";

 // Frozen columns need an opaque fill so scrolling cells don't bleed through.
 // Hover mirrors the row: bg-muted for plain rows, bg-muted-hover for grouped
 // rows (which rest on bg-muted). Tinted rows use the *-solid tokens — opaque
 // composites of the translucent tints over the page base (see index.css),
 // token-derived so they're display-independent.
 // Plain rows are the exception: the resting page surface is gradient-lightened
 // above --color-background (which ≈ --color-muted), so a token fill would erase
 // the hover step. #fbfcfd matches the lightened surface and stays lighter than
 // the bg-muted hover. Near-white, so cross-monitor drift is negligible.
 const stickyBg = isExpired ?"bg-row-warn-solid" : isItm ?"bg-row-down-solid" :"bg-[#fbfcfd]";
 const stickyHover = isExpired ?"group-hover:bg-row-warn-solid-hover" : isItm ?"group-hover:bg-row-down-solid-hover" : isGrouped ?"group-hover:bg-muted-hover" :"group-hover:bg-muted";
 // Frozen cells are z-raised + opaque, so the row's collapsed bottom border
 // gets painted over. Re-draw it on the cell itself (matches the tr's
 // border-b condition: omitted when a roll sub-row follows). Tinted rows use
 // an opaque edge so it can't compound the translucent tint like the
 // scrolling side's collapsed border does — see --color-row-down-edge.
 const bEdge = isItm ?"border-b border-b-row-down-edge" :"border-b border-b-border";
 const stickyTd = (_leftPx: number, extra?: string, textOnly = false) =>
 cn(textOnly ? tdTextClass : tdClass,"sticky z-[2]", !hasChain && bEdge, stickyHover, stickyBg, extra);

 const primaryRow = (
 <tr key={p.id} className={cn("group", hasChain ?"" :"border-b border-border", isExpired ?"hover:bg-row-warn-hover" : isItm ?"hover:bg-row-down-hover" : isGrouped ?"hover:bg-muted-hover" :"hover:bg-muted", isGrouped &&"bg-muted", isExpired ?"bg-row-warn" : isItm ?"bg-row-down" :"", isDraftRow &&"italic opacity-60")}>
 {/* ── Group 1: Position (always visible, frozen) ── */}
 <td style={{ left: 0 }} className={stickyTd(0, isGrouped ?"pl-8 pr-2" :"pl-4 pr-2", true)}>
 <div className="flex items-center gap-1.5">
 <span className="font-bold font-mono">{p.ticker.symbol}</span>
 {p.group && <Link className="h-3 w-3 text-muted-foreground shrink-0" />}
 </div>
 </td>
 <td style={{ left: 80 }} className={stickyTd(80, undefined, true)}>
 <span className={cn(
"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
 p.optionType ==="CALL" ?"bg-blue-soft text-blue-deep" :"bg-violet-soft text-violet-deep"
 )}>
 {p.optionType ==="CALL" ?"CC" :"CSP"}
 </span>
 </td>
 <td style={{ left: 140 }} className={stickyTd(140)}>${fmtUSD(p.strikePrice)}</td>
 <td style={{ left: 220 }} className={stickyTd(220,"border-r border-r-border/40", true)}>
 <div className="flex items-center gap-1">
 <span className={cn(hasEarningsRisk &&"text-warn")}>{fmtDate(p.expirationDate)}</span>
 {hasEarningsRisk && (
 <Tooltip content={earningsWarningText(earnings!)}>
 <span className="inline-flex items-center p-0.5 text-warn">
 <AlertTriangle className="h-3 w-3" />
 </span>
 </Tooltip>
 )}
 </div>
 </td>

 {/* ── Group 2: Trade Details ── */}
 {isColOpen("details") ? (
 <>
 <td className={cn(tdClass,"border-l border-border/50")}>{p.contracts}</td>
 <td className={tdClass}>${fmtUSD(p.premiumPerShare)}</td>
 <td className={tdClass} title={isDraftRow ? undefined : fmtDateTimeFull(p.openedAt)}>
 {isDraftRow ? <span className="text-muted-foreground italic text-xs">Draft</span> : fmtDateTimeShort(p.openedAt)}
 </td>
 <td className={tdClass}>{fmt(p.stockPriceAtOpen, 2,"$")}</td>
 <td className={tdClass} title={p.deltaAtOpenCapturedAt != null ?`Captured ${new Date(p.deltaAtOpenCapturedAt).toLocaleString("en-US", { timeZone:"America/New_York", month:"numeric", day:"numeric", year:"2-digit", hour:"numeric", minute:"2-digit" })} ET` : undefined}>
 {p.deltaAtOpen != null ? Number(p.deltaAtOpen).toFixed(3) : <span className="text-muted-foreground">—</span>}
 </td>
 </>
 ) : (
 <td className={cn(tdClass,"border-l border-border/50 text-muted-foreground text-xs")}>
 {p.contracts} @ ${fmtUSD(p.premiumPerShare)}
 </td>
 )}

 {/* ── Group 3: Return ── */}
 {isColOpen("return") ? (
 <>
 <td className={cn(tdClass,"border-l border-border/50")}>${fmtUSD(c.totalPremiumNet)}</td>
 <td className={tdClass}>
 {c.daysLeft < 0 ?"Expired" : c.calDaysLeft === 0 ?"Today" :`${c.calDaysLeft}d`}
 </td>
 <td className={tdClass}>
 {c.annReturnAtExpiry != null
 ? <span className={cn(c.annReturnAtExpiry >= 0 ?"text-up" :"text-down")}>{fmtPct(c.annReturnAtExpiry)}</span>
 :"—"}
 </td>
 </>
 ) : (
 <td className={cn(tdClass,"border-l border-border/50 text-muted-foreground text-xs")}>
 ${fmtUSD(c.totalPremiumNet)}
 <span className="mx-1">·</span>
 {c.daysLeft < 0 ?"Exp" : c.calDaysLeft === 0 ?"Today" :`${c.calDaysLeft}d`}
 </td>
 )}

 {/* ── Group 4: Risk & Structure ── */}
 {isColOpen("risk") ? (
 <>
 <td className={cn(tdClass,"border-l border-border/50")}>{Math.round(c.durationDays)}d</td>
 <td className={tdClass}>{c.capitalAtRisk > 0 ?`$${c.capitalAtRisk.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :"—"}</td>
 <td className={tdClass}>${fmtUSD(c.breakeven)}</td>
 <td className={tdClass}>
 {c.pctOtmAtOpen != null
 ? <span className={cn((p.optionType ==="CALL" ? c.pctOtmAtOpen >= 0 : c.pctOtmAtOpen <= 0) ?"text-up" :"text-down")}>{fmtPct(c.pctOtmAtOpen)}</span>
 :"—"}
 </td>
 </>
 ) : (
 <td className={cn(tdClass,"border-l border-border/50")}>
 {c.pctOtmAtOpen != null
 ? <span className={cn((p.optionType ==="CALL" ? c.pctOtmAtOpen >= 0 : c.pctOtmAtOpen <= 0) ?"text-up" :"text-down")}>{fmtPct(c.pctOtmAtOpen)}</span>
 :"—"}
 </td>
 )}

 {/* ── Group 5: Live ── */}
 {isColOpen("live") ? (
 <>
 <td className={cn(tdClass,"border-l border-border/50")}>
 <div className="flex items-center gap-1">
 {stockNow != null
 ?`$${fmtUSD(stockNow)}`
 : <span className="text-muted-foreground">—</span>}
 {stalePriceTickers.has(p.ticker.symbol) && (
 <Tooltip content={stockNow != null
 ?"Latest price fetch failed — showing a stale cached value"
 :"Latest price fetch failed"}>
 <AlertTriangle className="h-3 w-3 text-warn shrink-0" />
 </Tooltip>
 )}
 </div>
 </td>
 <td className={tdClass}>
 <div className="flex items-center gap-1">
 {isEditingThisPrem ? (
 <input
 type="text"
 inputMode="decimal"
 autoFocus
 value={editingPremValue}
 onChange={(e) => setEditingPremValue(e.target.value)}
 onBlur={async () => {
 const val = editingPremValue !=="" ? parseAmount(editingPremValue) : null;
 await updateOptionsPosition(p.id, { currentPremiumPerShare: val });
 setEditingPremId(null);
 onPositionUpdated();
 }}
 onKeyDown={(e) => {
 if (e.key ==="Enter") (e.target as HTMLInputElement).blur();
 if (e.key ==="Escape") { setEditingPremId(null); }
 }}
 className="w-20 rounded border border-primary px-1 py-0.5 focus:outline-none"
 />
 ) : (
 <span
 onClick={() => { setEditingPremId(p.id); setEditingPremValue(p.currentPremiumPerShare?.toString() ??""); }}
 className="cursor-pointer border-b border-dotted border-transparent hover:border-muted-foreground/50"
 title={quoteErrors.get(p.id) ?`Error: ${quoteErrors.get(p.id)}` : undefined}
 >
 {p.currentPremiumPerShare != null
 ? <span className={quoteErrors.get(p.id) ?"text-down" :""}>${fmtUSD(p.currentPremiumPerShare)}</span>
 : <span className="text-muted-foreground">{quoteErrors.get(p.id) ?"err" :"—"}</span>}
 </span>
 )}
 {showRollInfo && (() => {
 const absDelta = p.currentDelta != null ? Math.abs(p.currentDelta) : null;
 const deltaColor = absDelta == null ?"" : absDelta < 0.65 ?"text-up" : absDelta <= 0.8 ?"text-warn" :"text-down";
 let deltaAsOf: string | null = null;
 if (p.currentDeltaAsOf != null) {
 const asOf = new Date(p.currentDeltaAsOf);
 const etDay = (d: Date) => d.toLocaleDateString("en-US", { timeZone:"America/New_York" });
 const sameDay = etDay(asOf) === etDay(new Date());
 const time = asOf.toLocaleString("en-US", { timeZone:"America/New_York", hour:"numeric", minute:"2-digit" });
 const stamp = sameDay ? time :`${asOf.toLocaleString("en-US", { timeZone:"America/New_York", month:"numeric", day:"numeric" })}, ${time}`;
 deltaAsOf =`${stamp} ET (${fmtAgo(asOf.getTime())})`;
 }
 return (
 <Tooltip content={
 <div className="tp-caption text-left leading-relaxed">
 <div>Extrinsic Value: <span className="font-medium text-foreground">${fmtUSD(extrinsicNow!)}</span></div>
 <div>Extrinsic Ratio: <span className={cn("font-medium", extrinsicRatio != null && extrinsicRatio < 20 ?"text-warn" :"text-foreground")}>{extrinsicRatio != null ?`${extrinsicRatio.toFixed(1)}%` :"—"}</span></div>
 <div>Current Delta: {p.currentDelta != null ? <span className={cn("font-medium", deltaColor)}>{Number(p.currentDelta).toFixed(3)}</span> : <span className="text-muted-foreground">—</span>}</div>
 {deltaAsOf != null && (
 <div className="flex items-center gap-1 text-muted-foreground">
 <CornerDownRight className="h-3 w-3 shrink-0" />
 <span>As of {deltaAsOf}</span>
 </div>
 )}
 </div>
 }>
 <span className="inline-flex items-center p-0.5 text-muted-foreground/40 hover:text-warn transition-colors">
 <Info className="h-3 w-3" />
 </span>
 </Tooltip>
 );
 })()}
 </div>
 </td>
 <td className={tdClass}>
 {pctOtmNow != null ? (() => {
 const isOtm = p.optionType ==="CALL" ? pctOtmNow >= 0 : pctOtmNow <= 0;
 const deteriorated = isOtm && c.pctOtmAtOpen != null && (
 p.optionType ==="CALL" ? pctOtmNow < c.pctOtmAtOpen : pctOtmNow > c.pctOtmAtOpen
 );
 return <span className={cn(deteriorated ?"text-warn" : isOtm ?"text-up" :"text-down")}>{fmtPct(pctOtmNow)}</span>;
 })() : <span className="text-muted-foreground">—</span>}
 </td>
 <td className={tdClass}>
 {curAnnRet != null
 ? <span className={cn(curAnnRet < 0 ?"text-down" : c.annReturnAtExpiry != null ? (curAnnRet > c.annReturnAtExpiry ?"text-up" :"text-warn") :"text-up")}>{fmtPctLive(curAnnRet)}</span>
 : <span className="text-muted-foreground">—</span>}
 </td>
 <td className={tdNum}>
 {livePnlCell}
 </td>
 <td className={tdNum}>
 {livePnl != null && c.totalPremiumNet !== 0
 ? <span className={cn(livePnl >= 0 ?"text-up" :"text-down")}>
 {fmtPct(livePnl / c.totalPremiumNet * 100)}
 </span>
 : <span className="text-muted-foreground">—</span>}
 </td>
 </>
 ) : (
 <td className={cn(tdNum,"border-l border-border/50")}>
 {livePnlCell}
 </td>
 )}

 {/* ── Actions ── */}
 <td className={tdClass}>
 <div className="flex items-center gap-1">
 {isDraftRow ? (
 <Tooltip content="Confirm & open position">
 <button onClick={() => onConfirm(p)} className="p-1.5 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted-hover transition-colors">
 <PlayCircle className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
 ) : (
 <Tooltip content="Close position">
 <button onClick={() => onClose(p)} className={cn("p-1.5 rounded transition-colors", isExpired ?"text-warn hover:text-warn hover:bg-warn-soft/60" :"text-muted-foreground/40 hover:text-primary hover:bg-primary/10")}>
 <CircleCheck className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
 )}
 <Tooltip content="Edit">
 <button onClick={() => onEdit(p)} className="p-1.5 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted-hover transition-colors">
 <Pencil className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
 </div>
 </td>
 </tr>
 );

 const chainRow = hasChain ? (
 <tr key={`${p.id}-chain`} className={cn("group","border-b border-border", isExpired ?"hover:bg-row-warn-hover" : isItm ?"hover:bg-row-down-hover" : isGrouped ?"hover:bg-muted-hover" :"hover:bg-muted", isGrouped &&"bg-muted", isExpired ?"bg-row-warn" : isItm ?"bg-row-down" :"")}>
 {/* Label — frozen */}
 <td style={{ left: 0 }} className={cn(ctd,"sticky z-[2]", bEdge, stickyHover, stickyBg, isGrouped ?"pl-8 pr-2" :"pl-4 pr-2","font-medium text-muted-foreground/60 uppercase tracking-[1px] font-mono text-10")}>roll</td>
 <td style={{ left: 80 }} className={cn(ctd,"sticky z-[2]", bEdge, stickyHover, stickyBg)} />
 <td style={{ left: 140 }} className={cn(ctd,"sticky z-[2]", bEdge, stickyHover, stickyBg)} />
 <td style={{ left: 220 }} className={cn(ctd,"sticky z-[2]", bEdge,"border-r border-r-border/40", stickyHover, stickyBg)} />

 {/* Details group — chain net per-share in Premium column */}
 {isColOpen("details") ? (
 <>
 <td className={cn(ctd,"border-l border-border/50")} />
 <td className={ctd}>
 {chainNet != null &&`$${fmtUSD(chainNet / (p.contracts * 100))} net`}
 </td>
 <td className={ctd} />
 <td className={ctd} />
 <td className={ctd} />
 </>
 ) : (
 <td className={cn(ctd,"border-l border-border/50")}>
 {chainNet != null &&`${p.contracts} @ $${fmtUSD(chainNet / (p.contracts * 100))} net`}
 </td>
 )}

 {/* Return group — chain net total prem + ann. return at expiry */}
 {isColOpen("return") ? (
 <>
 <td className={cn(ctd,"border-l border-border/50")}>
 {chainNet != null && (
 <span className="text-muted-foreground">${fmtUSD(Math.abs(chainNet))}</span>
 )}
 </td>
 <td className={ctd} />
 <td className={ctd}>
 {chainAnnRetAtExpiry != null && (
 <span className={cn(chainAnnRetAtExpiry >= 0 ?"text-up" :"text-down")}>
 {fmtPct(chainAnnRetAtExpiry)}
 </span>
 )}
 </td>
 </>
 ) : (
 <td className={cn(ctd,"border-l border-border/50")}>
 {chainNet != null && (
 <span className="text-muted-foreground">${fmtUSD(Math.abs(chainNet))}</span>
 )}
 </td>
 )}

 {/* Risk group — total duration + real breakeven */}
 {isColOpen("risk") ? (
 <>
 <td className={cn(ctd,"border-l border-border/50")}>
 {chainDaysInTrade != null &&`${Math.round(chainDaysInTrade)}d`}
 </td>
 <td className={ctd} />
 <td className={ctd}>
 {realBreakeven != null && (
 <span>${fmtUSD(realBreakeven)}</span>
 )}
 </td>
 <td className={ctd} />
 </>
 ) : (
 <td className={cn(ctd,"border-l border-border/50")} />
 )}

 {/* Live group — chain ann. ret + chain live P&L */}
 {isColOpen("live") ? (
 <>
 <td className={cn(ctd,"border-l border-border/50")} />
 <td className={ctd} />
 <td className={ctd} />
 <td className={ctd}>
 {chainCurAnnRet != null && (
 <span className={cn(chainCurAnnRet < 0 ?"text-down" : chainAnnRetAtExpiry != null ? (chainCurAnnRet > chainAnnRetAtExpiry ?"text-up" :"text-warn") :"text-up")}>
 {fmtPctLive(chainCurAnnRet)}
 </span>
 )}
 </td>
 <td className={ctd}>
 {chainLivePnl != null && !p.excludeFromLivePnl && (
 <span className={cn("font-medium", chainLivePnl >= 0 ?"text-up" :"text-down")}>
 {chainLivePnl >= 0 ?"+" :"−"}${fmtUSD(Math.abs(chainLivePnl))}
 </span>
 )}
 </td>
 <td className={ctd}>
 {chainLivePnl != null && !p.excludeFromLivePnl && chainNet != null && chainNet !== 0 && (
 <span className={cn("font-medium", chainLivePnl >= 0 ?"text-up" :"text-down")}>
 {fmtPct(chainLivePnl / chainNet * 100)}
 </span>
 )}
 </td>
 </>
 ) : (
 <td className={cn(ctd,"border-l border-border/50")}>
 {chainLivePnl != null && !p.excludeFromLivePnl && (
 <span className={cn("font-medium", chainLivePnl >= 0 ?"text-up" :"text-down")}>
 {chainLivePnl >= 0 ?"+" :"−"}${fmtUSD(Math.abs(chainLivePnl))}
 </span>
 )}
 </td>
 )}

 {/* Actions — empty */}
 <td className={ctd} />
 </tr>
 ) : null;

 return <React.Fragment key={p.id}>{primaryRow}{chainRow}</React.Fragment>;
 };

 // Summary stats for the footer modules
 let totalLivePnl: number | null = null;
 let totalCurrentPremium: number | null = null;
 let totalPremiumPendingClose = 0; // net premium collected on still-open positions
 let cspITMCapital = 0;
 let ccITMCapital = 0;
 for (const p of positions) {
 totalPremiumPendingClose += calcPosition(p).totalPremiumNet;
 const curPrem = p.currentPremiumPerShare ?? null;
 if (curPrem != null) {
 // Excluded positions still count toward Cost to Close (the factual cost to
 // buy back everything now) but are kept out of the Total Live P&L rollup.
 if (!p.excludeFromLivePnl) {
 const pnl = (p.premiumPerShare - curPrem) * 100 * p.contracts - (p.feesOpen ?? 0);
 totalLivePnl = (totalLivePnl ?? 0) + pnl;
 }
 totalCurrentPremium = (totalCurrentPremium ?? 0) + curPrem * 100 * p.contracts;
 }
 const stockNow = livePrices.get(p.ticker.symbol) ?? null;
 if (stockNow != null) {
 const isItm = p.optionType === "PUT" ? stockNow < p.strikePrice : stockNow > p.strikePrice;
 if (isItm) {
 const car = calcPosition(p).capitalAtRisk;
 if (p.optionType === "PUT") cspITMCapital += car;
 else ccITMCapital += car;
 }
 }
 }
 const hasCARData = positions.some((p) => livePrices.has(p.ticker.symbol));

 return (
 <>
 {tabBarRef?.current && createPortal(
 <div className="ml-auto flex items-center gap-2 py-1.5">
 <span className="tp-caption">
 {lastFetchedAt != null ? (
 <>
 {"Prices as of "}
 {lastFetchedAt.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit", timeZone: "America/New_York" })}
 {" "}
 {lastFetchedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
 {" ET via Tradier"}
 </>
 ) : (
 "Prices via Tradier"
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
 </div>,
 tabBarRef.current
 )}
 <div ref={tableContainerRef} className="overflow-x-auto" onScroll={(e) => { if (portalScrollRef.current) portalScrollRef.current.scrollLeft = e.currentTarget.scrollLeft; }}>
 <table className="w-full text-left border-collapse min-w-[700px]">
 <colgroup>
 <col style={{ width:'80px', minWidth:'80px' }} />{/* Ticker — sticky */}
 <col style={{ width:'60px', minWidth:'60px' }} />{/* Type — sticky */}
 <col style={{ width:'80px', minWidth:'80px' }} />{/* Strike — sticky */}
 <col style={{ width:'80px', minWidth:'80px' }} />{/* Expiration — sticky */}
 </colgroup>
 <thead ref={theadRef}>
 {/* ── Row 1: group headers ── */}
 <tr>
 {/* Position — always visible, no toggle */}
 <th colSpan={4} style={{ left: 0 }} className="sticky z-[3] bg-[#fbfcfd] px-3 pt-2 pb-1" />
 {/* Collapsible groups */}
 {COL_GROUPS.map(({ key, label, count }) => (
 <th
 key={key}
 colSpan={isColOpen(key) ? count : 1}
 onClick={() => toggleColGroup(key)}
 className={cn(
"px-3 pt-2 pb-1 text-left font-mono text-10 font-medium tracking-[0.11em] uppercase cursor-pointer select-none transition-colors",
"border-l border-border/50",
 isColOpen(key)
 ?"text-muted-foreground/70 hover:text-muted-foreground"
 :"text-muted-foreground/50 hover:text-muted-foreground/80"
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
 <tr className="border-b border-border">
 <th style={{ left: 0 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd] pl-4 pr-2")}>Ticker</th>
 <th style={{ left: 80 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Type</th>
 <th style={{ left: 140 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Strike</th>
 <th style={{ left: 220 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd] border-r border-border/50")}>Exp</th>
 {isColOpen("details") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Contracts</th>
 <th className={thClass}>Premium</th>
 <th className={thClass}>Opened</th>
 <th className={thClass}>Stock @ Open</th>
 <th className={thClass}>Delta @ Open</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>Contracts</th>
 )}
 {isColOpen("return") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Total Prem</th>
 <th className={thClass}>Days Left</th>
 <th className={thClass}>Ann. Return</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>Total Prem</th>
 )}
 {isColOpen("risk") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Duration</th>
 <th className={thClass}>Capital @ Risk</th>
 <th className={thClass}>Breakeven</th>
 <th className={thClass}>% to Strike</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>% to Strike</th>
 )}
 {isColOpen("live") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Stock Now</th>
 <th className={thClass}>Cur. Prem</th>
 <th className={thClass}>% OTM</th>
 <th className={thClass}>Ann. Return</th>
 <th className={thClass}>Live P&L</th>
 <th className={thClass}>% Gain</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>Live P&L</th>
 )}
 <th className={thClass} />
 </tr>
 </thead>
 <tbody>
 {/* ── Draft section ── */}
 {sortedDrafts.length > 0 && (
 <tr className="group bg-muted border-y border-border cursor-pointer hover:bg-muted select-none" onClick={() => setDraftsOpen((v) => !v)}>
 <td colSpan={4} className="py-1.5 pl-4 sticky left-0 z-[2] bg-muted group-hover:bg-muted">
 <div className="flex items-center gap-1.5">
 <SectionLabel as="span" className="text-foreground">Draft Positions</SectionLabel>
 {draftsOpen ? <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />}
 </div>
 </td>
 <td colSpan={totalCols - 4} className="py-1.5 pr-4 text-right">
 <span className="tp-caption font-normal">Not included in totals · click <PlayCircle className="inline h-3 w-3 mb-0.5" /> to confirm &amp; open</span>
 </td>
 </tr>
 )}
 {draftsOpen && sortedDrafts.map((p) => renderRow(p, false, true))}

 {/* ── Open section header (only when both sections are non-empty) ── */}
 {sortedDrafts.length > 0 && sorted.length > 0 && (
 <tr className="bg-muted border-y border-border">
 <td colSpan={4} className="py-1.5 pl-4 sticky left-0 z-[2] bg-muted">
 <SectionLabel as="span" className="text-foreground">Open Positions</SectionLabel>
 </td>
 <td colSpan={totalCols - 4} />
 </tr>
 )}

 {/* ── Open positions ── */}
 {Array.from(grouped.entries()).map(([gid, grpPositions]) => {
 // Single position (standalone or sole open leg of a chain): render inline
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
 className="border-b border-border bg-muted cursor-pointer hover:bg-muted-hover"
 onClick={() => toggleGroup(gid)}
 >
 <td colSpan={totalCols} className="px-3 py-1.5">
 <div className="flex items-center gap-2 font-medium">
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
 <div className="grid grid-cols-4 gap-3 mt-4">
 {/* Capital at Risk of Assignment */}
 <div className="flex flex-col gap-0.5 rounded-lg border border-border px-4 py-4">
 <span className="tp-eyebrow">Capital at Risk of Assignment</span>
 {hasCARData ? (
 cspITMCapital === 0 && ccITMCapital === 0 ? (
 <span className="tp-numeric font-medium text-up">$0.00</span>
 ) : (
 <div className="flex items-center gap-3">
 {cspITMCapital > 0 && (
 <span className="tp-numeric">
 <span className="tp-caption mr-1">CSP</span>
 <span className="font-medium text-down">−${fmtUSD(cspITMCapital)}</span>
 </span>
 )}
 {ccITMCapital > 0 && (
 <span className="tp-numeric">
 <span className="tp-caption mr-1">CC</span>
 <span className="font-medium text-up">+${fmtUSD(ccITMCapital)}</span>
 </span>
 )}
 </div>
 )
 ) : (
 <span className="tp-numeric text-muted-foreground">—</span>
 )}
 </div>
 {/* Premium Collected (Pending Close) — net credit on still-open positions */}
 <div className="flex flex-col gap-0.5 rounded-lg border border-border px-4 py-4">
 <span className="tp-eyebrow">Premium Collected (Pending Close)</span>
 <span className={cn("tp-numeric font-medium", totalPremiumPendingClose >= 0 ? "text-up" : "text-down")}>
 {totalPremiumPendingClose >= 0 ? "+" : "−"}${fmtUSD(Math.abs(totalPremiumPendingClose))}
 </span>
 </div>
 {/* Cost to Close — current cost to buy-to-close all open positions (a debit) */}
 <div className="flex flex-col gap-0.5 rounded-lg border border-border px-4 py-4">
 <span className="tp-eyebrow">Cost to Close</span>
 {totalCurrentPremium != null ? (
 <span className="tp-numeric font-medium text-down">−${fmtUSD(totalCurrentPremium)}</span>
 ) : (
 <span className="tp-numeric text-muted-foreground">—</span>
 )}
 </div>
 {/* Total Live P&L */}
 <div className="flex flex-col gap-0.5 rounded-lg border border-border px-4 py-4">
 <span className="tp-eyebrow">Total Live P&L</span>
 {totalLivePnl != null ? (
 <span className={cn("tp-numeric font-medium", totalLivePnl >= 0 ? "text-up" : "text-down")}>
 {totalLivePnl >= 0 ? "+" : "−"}${fmtUSD(Math.abs(totalLivePnl))}
 </span>
 ) : (
 <span className="tp-numeric text-muted-foreground">—</span>
 )}
 </div>
 </div>

 {/* Sticky column-header portal — shown when the thead has scrolled above the nav */}
 {stickyRect && createPortal(
 <div style={{ position:"fixed", top: 72, left: stickyRect.left, width: stickyRect.width, zIndex: 45 }}>
 <div ref={portalScrollRef} className="bg-background overflow-x-auto" style={{ scrollbarWidth:"none" }}>
 <table className="w-full text-left border-collapse" style={{ tableLayout:"fixed" }}>
 <colgroup>
 {stickyRect.colWidths.map((w, i) => <col key={i} style={{ width:`${w}px` }} />)}
 </colgroup>
 <thead>
 <tr>
 <th colSpan={4} style={{ left: 0 }} className="sticky z-[3] bg-[#fbfcfd] px-3 pt-2 pb-1" />
 {COL_GROUPS.map(({ key, label, count }) => (
 <th
 key={key}
 colSpan={isColOpen(key) ? count : 1}
 onClick={() => toggleColGroup(key)}
 className={cn(
"px-3 pt-2 pb-1 text-left font-mono text-10 font-medium tracking-[0.11em] uppercase cursor-pointer select-none transition-colors",
"border-l border-border/50",
 isColOpen(key)
 ?"text-muted-foreground/70 hover:text-muted-foreground"
 :"text-muted-foreground/50 hover:text-muted-foreground/80"
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
 <tr className="border-b border-border">
 <th style={{ left: 0 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd] pl-4 pr-2")}>Ticker</th>
 <th style={{ left: 80 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Type</th>
 <th style={{ left: 140 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Strike</th>
 <th style={{ left: 220 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd] border-r border-border/50")}>Exp</th>
 {isColOpen("details") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Contracts</th>
 <th className={thClass}>Premium</th>
 <th className={thClass}>Opened</th>
 <th className={thClass}>Stock @ Open</th>
 <th className={thClass}>Delta @ Open</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>Contracts</th>
 )}
 {isColOpen("return") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Total Prem</th>
 <th className={thClass}>Days Left</th>
 <th className={thClass}>Ann. Return</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>Total Prem</th>
 )}
 {isColOpen("risk") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Duration</th>
 <th className={thClass}>Capital @ Risk</th>
 <th className={thClass}>Breakeven</th>
 <th className={thClass}>% to Strike</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>% to Strike</th>
 )}
 {isColOpen("live") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Stock Now</th>
 <th className={thClass}>Cur. Prem</th>
 <th className={thClass}>% OTM</th>
 <th className={thClass}>Ann. Return</th>
 <th className={thClass}>Live P&L</th>
 <th className={thClass}>% Gain</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>Live P&L</th>
 )}
 <th className={thClass} />
 </tr>
 </thead>
 </table>
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
 openChainGroupIds: Set<string>;
 // splitGroupIds that still have an open remainder — deleting a leg in one of
 // these returns its contracts to that open position (undo-the-split).
 openSplitGroupIds: Set<string>;
 onEdit: (p: OptionsPosition) => void;
 onDelete: (p: OptionsPosition) => void;
 tabBarRef?: React.RefObject<HTMLDivElement | null>;
}

const CLOSED_COL_GROUPS = [
 { key:"dates", label:"Dates", count: 3 },
 { key:"pnl", label:"P&L", count: 4 },
] as const;
type ClosedColGroupKey = (typeof CLOSED_COL_GROUPS)[number]["key"];

function ClosedPositionsTable({ positions, openChainGroupIds, openSplitGroupIds, onEdit, onDelete, tabBarRef }: ClosedPositionsTableProps) {
 const [confirmDelete, setConfirmDelete] = useState<OptionsPosition | null>(null);
 const [openColGroups, setOpenColGroups] = useState<Set<ClosedColGroupKey>>(new Set(["pnl"]));
 const [tickerSearchQuery, setTickerSearchQuery] = useState(""); // raw input value
 const [appliedTickerSearch, setAppliedTickerSearch] = useState(""); // committed on Enter
 const tableContainerRef = useRef<HTMLDivElement>(null);
 const theadRef = useRef<HTMLTableSectionElement>(null);
 const portalScrollRef = useRef<HTMLDivElement>(null);
 const [stickyRect, setStickyRect] = useState<{ left: number; width: number; colWidths: number[] } | null>(null);

 // Collapse every week except the most recent one (by close/expiration date) by default.
 const [collapsedWeeks, setCollapsedWeeks] = useState<Set<string>>(() => {
 const weekKeys = new Set<string>();
 for (const p of positions) {
 const closeDateStr = p.closedAt ? p.closedAt.split("T")[0] : p.expirationDate.split("T")[0];
 const d = new Date(closeDateStr +"T00:00:00Z");
 const dow = d.getUTCDay();
 const monday = new Date(d);
 monday.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
 weekKeys.add(monday.toISOString().slice(0, 10));
 }
 const mostRecentWeek = [...weekKeys].sort().at(-1);
 const collapsed = new Set<string>();
 for (const key of weekKeys) {
 if (key !== mostRecentWeek) collapsed.add(key);
 }
 return collapsed;
 });
 const toggleWeek = (key: string) =>
 setCollapsedWeeks((prev) => {
 const next = new Set(prev);
 if (next.has(key)) next.delete(key); else next.add(key);
 return next;
 });

 const isColOpen = (g: ClosedColGroupKey) => openColGroups.has(g);
 const toggleColGroup = (g: ClosedColGroupKey) =>
 setOpenColGroups((prev) => {
 const next = new Set(prev);
 if (next.has(g)) next.delete(g); else next.add(g);
 return next;
 });

 useEffect(() => {
 const NAV_BOTTOM = 72;
 const handleScroll = () => {
 const el = tableContainerRef.current;
 if (!el) return;
 const rect = el.getBoundingClientRect();
 if (rect.top < NAV_BOTTOM && rect.bottom > NAV_BOTTOM) {
 const cells = theadRef.current?.rows[1]?.cells;
 const colWidths = cells ? Array.from(cells).map(c => c.getBoundingClientRect().width) : [];
 setStickyRect({ left: rect.left, width: rect.width, colWidths });
 } else {
 setStickyRect(null);
 }
 };
 window.addEventListener("scroll", handleScroll, { passive: true });
 return () => window.removeEventListener("scroll", handleScroll);
 }, []);

 // Re-measure column widths after the DOM updates when a column group is toggled
 useLayoutEffect(() => {
 setStickyRect(prev => {
 if (!prev) return null;
 const cells = theadRef.current?.rows[1]?.cells;
 const colWidths = cells ? Array.from(cells).map(c => c.getBoundingClientRect().width) : prev.colWidths;
 return { ...prev, colWidths };
 });
 }, [openColGroups]);

 if (positions.length === 0) {
 return (
 <div className="text-center py-12 tp-caption">
 No closed positions yet.
 </div>
 );
 }

 // Effective close timestamp: real closedAt, else expiration at 20:00 UTC (market close).
 const getCloseMs = (p: OptionsPosition): number => {
 if (p.closedAt) return new Date(p.closedAt).getTime();
 const [ey, em, ed] = p.expirationDate.split("T")[0].split("-").map(Number);
 return Date.UTC(ey, em - 1, ed, 20, 0, 0);
 };

 const sorted = [...positions].sort((a, b) => {
 const closeDiff = getCloseMs(a) - getCloseMs(b);
 if (closeDiff !== 0) return closeDiff;
 const tickerDiff = a.ticker.symbol.localeCompare(b.ticker.symbol);
 if (tickerDiff !== 0) return tickerDiff;
 const expDiff = a.expirationDate.localeCompare(b.expirationDate);
 if (expDiff !== 0) return expDiff;
 const strikeDiff = Number(a.strikePrice) - Number(b.strikePrice);
 if (strikeDiff !== 0) return strikeDiff;
 return Number(a.premiumPerShare) - Number(b.premiumPerShare);
 });

 // Ticker search: when active, every week group renders fully expanded
 // (ignoring collapsedWeeks) showing only the rows matching the ticker.
 const tickerQuery = appliedTickerSearch.trim().toLowerCase();
 const searchActive = tickerQuery.length > 0;
 const filteredSorted = searchActive
 ? sorted.filter((p) => p.ticker.symbol.toLowerCase().includes(tickerQuery))
 : sorted;

 const outcomeLabel: Record<string, string> = {
 EXPIRED_WORTHLESS:"Expired Worthless",
 CLOSED_EARLY:"Closed Early",
 ROLLED:"Rolled",
 ASSIGNED:"Assigned",
 };

 // ── Pre-compute fully-closed chain summaries ─────────────────────────────────
 // Each groupId whose every leg is closed becomes one summary row, rendered at
 // the bottom of the week in which the final leg closed.
 // Build chain summaries for fully-closed chains only (all legs closed).
 // Keyed by the ID of the final leg so we know where to render the row inline.
 interface ChainSummary {
 legs: OptionsPosition[];
 chainPnl: number;
 chainCapitalAtRisk: number;
 totalFees: number;
 firstOpenMs: number;
 lastCloseMs: number;
 chainDaysInTrade: number;
 chainAnnReturn: number | null;
 }

 const chainLegsMap = new Map<string, OptionsPosition[]>();
 for (const p of sorted) {
 if (!p.groupId) continue;
 const arr = chainLegsMap.get(p.groupId) ?? [];
 arr.push(p);
 chainLegsMap.set(p.groupId, arr);
 }

 // Map from final-leg position ID → chain summary
 const chainSummaryByFinalLegId = new Map<string, ChainSummary>();
 for (const [groupId, legs] of chainLegsMap) {
 if (openChainGroupIds.has(groupId)) continue; // skip chains that still have open legs
 const sortedLegs = [...legs].sort((a, b) =>
 a.sequenceInGroup != null && b.sequenceInGroup != null
 ? a.sequenceInGroup - b.sequenceInGroup
 : new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime()
 );
 const firstLeg = sortedLegs[0];
 const finalLeg = sortedLegs[sortedLegs.length - 1];
 const chainPnl = sortedLegs.reduce((s, p) => s + (calcPosition(p).pnl ?? 0), 0);
 const chainCapitalAtRisk = Math.max(...sortedLegs.map((p) => calcPosition(p).capitalAtRisk));
 const totalFees = sortedLegs.reduce((s, p) => s + calcPosition(p).totalFees, 0);
 const firstOpenMs = new Date(firstLeg.openedAt).getTime();
 const lastCloseMs = Math.max(...sortedLegs.map(getCloseMs));
 const chainDaysInTrade = (lastCloseMs - firstOpenMs) / 86_400_000;
 const chainAnnReturn =
 chainCapitalAtRisk > 0 && chainDaysInTrade > 0
 ? (chainPnl / chainCapitalAtRisk) * (365 / chainDaysInTrade) * 100
 : null;
 chainSummaryByFinalLegId.set(finalLeg.id, {
 legs: sortedLegs,
 chainPnl,
 chainCapitalAtRisk,
 totalFees,
 firstOpenMs,
 lastCloseMs,
 chainDaysInTrade,
 chainAnnReturn,
 });
 }

 const thClass ="px-2 py-2 text-left font-mono text-10 font-medium tracking-[0.11em] uppercase text-[var(--color-ink-3)] whitespace-nowrap";
 const tdClass ="px-2 py-2 text-13 font-mono tabular-nums whitespace-nowrap";
 const tdClassChained ="px-2 pt-2 pb-1 text-13 font-mono tabular-nums whitespace-nowrap";
 const tdNumClass ="px-2 py-2 tp-numeric whitespace-nowrap";
 const tdNumChained ="px-2 pt-2 pb-1 tp-numeric whitespace-nowrap";

 return (
 <>
 {tabBarRef?.current && createPortal(
 <div className="ml-auto flex items-center gap-2 py-1.5">
 <div className="relative">
 <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
 <input
 type="text"
 value={tickerSearchQuery}
 onChange={(e) => { setTickerSearchQuery(e.target.value); if (!e.target.value.trim()) setAppliedTickerSearch(""); }}
 onKeyDown={(e) => {
 if (e.key ==="Enter") setAppliedTickerSearch(tickerSearchQuery);
 if (e.key ==="Escape") { setTickerSearchQuery(""); setAppliedTickerSearch(""); }
 }}
 placeholder="Search ticker..."
 className="h-9 w-44 rounded-md border border-border bg-background pl-8 pr-3 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 </div>,
 tabBarRef.current
 )}
 <div ref={tableContainerRef} className="overflow-x-auto" onScroll={(e) => { if (portalScrollRef.current) portalScrollRef.current.scrollLeft = e.currentTarget.scrollLeft; }}>
 <table className="w-full text-left border-collapse min-w-[700px]">
 <colgroup>
 <col style={{ width:'80px', minWidth:'80px' }} />{/* Ticker — sticky */}
 <col style={{ width:'72px', minWidth:'72px' }} />{/* Type — sticky */}
 <col style={{ width:'80px', minWidth:'80px' }} />{/* Strike — sticky */}
 <col style={{ width:'80px', minWidth:'80px' }} />{/* Expiration — sticky */}
 <col style={{ width:'72px', minWidth:'72px' }} />{/* Contracts — sticky */}
 </colgroup>
 <thead ref={theadRef}>
 {/* ── Row 1: group headers ── */}
 <tr>
 {/* Position + Contracts — always, no toggle */}
 <th colSpan={5} style={{ left: 0 }} className="sticky z-[3] bg-[#fbfcfd] px-3 pt-2 pb-1" />
 {/* Collapsible groups */}
 {CLOSED_COL_GROUPS.map(({ key, label, count }) => (
 <th
 key={key}
 colSpan={isColOpen(key) ? count : 1}
 onClick={() => toggleColGroup(key)}
 className={cn(
"px-3 pt-2 pb-1 text-left font-mono text-10 font-medium tracking-[0.11em] uppercase cursor-pointer select-none transition-colors",
"border-l border-border/50",
 isColOpen(key)
 ?"text-muted-foreground/70 hover:text-muted-foreground"
 :"text-muted-foreground/50 hover:text-muted-foreground/80"
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
 <tr className="border-b border-border">
 <th style={{ left: 0 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd] pl-4 pr-2")}>Ticker</th>
 <th style={{ left: 80 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Type</th>
 <th style={{ left: 152 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Strike</th>
 <th style={{ left: 232 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Exp</th>
 <th style={{ left: 312 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd] border-r border-border/50")}>Contracts</th>
 {/* Dates group */}
 {isColOpen("dates") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Opened</th>
 <th className={thClass}>Closed</th>
 <th className={thClass}>Days in Trade</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>Days in Trade</th>
 )}
 {/* P&L group */}
 {isColOpen("pnl") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Open Prem</th>
 <th className={thClass}>Close Prem</th>
 <th className={thClass}>Total Fees</th>
 <th className={thClass}>P/L</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>P/L</th>
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
 for (const p of filteredSorted) {
 const closeDateStr = p.closedAt ? p.closedAt.split("T")[0] : p.expirationDate.split("T")[0];
 const expDay = new Date(closeDateStr +"T00:00:00Z");
 const dow = expDay.getUTCDay(); // 0=Sun … 6=Sat
 const monday = new Date(expDay);
 monday.setUTCDate(expDay.getUTCDate() - (dow === 0 ? 6 : dow - 1));
 const friday = new Date(monday);
 friday.setUTCDate(monday.getUTCDate() + 4);
 const key = monday.toISOString().slice(0, 10);
 const monLabel = monday.toLocaleDateString("en-US", { month:"short", day:"numeric", timeZone:"UTC" });
 const crossesMonth = friday.getUTCMonth() !== monday.getUTCMonth();
 const friLabel = friday.toLocaleDateString("en-US", crossesMonth ? { month:"short", day:"numeric", timeZone:"UTC" } : { day:"numeric", timeZone:"UTC" });
 const year = friday.getUTCFullYear();
 const label =`${monLabel} – ${friLabel}, ${year}`;
 const existing = weekGroups.find((g) => g.monday === key);
 if (existing) existing.positions.push(p);
 else weekGroups.push({ monday: key, label, positions: [p] });
 }

 if (searchActive && weekGroups.length === 0) {
 return [
 <tr key="no-search-results">
 <td colSpan={20} className="text-center py-12 tp-caption">
 No closed positions match "{appliedTickerSearch.trim()}".
 </td>
 </tr>,
 ];
 }

 return weekGroups.flatMap(({ monday, label, positions }) => {
 const isCollapsed = searchActive ? false : collapsedWeeks.has(monday);
 const weekPnl = positions.reduce((sum, p) => sum + (calcPosition(p).pnl ?? 0), 0);
 return [
 <tr
 key={`week-${label}`}
 className={cn("group border-y border-border select-none", searchActive ?"" :"cursor-pointer hover:bg-muted")}
 onClick={() => { if (!searchActive) toggleWeek(monday); }}
 >
 <td colSpan={5} className={cn("py-1.5 pl-4 sticky left-0 z-[2]", searchActive ?"" :"group-hover:bg-muted")}>
 <div className="flex items-center gap-1.5">
 <SectionLabel as="span" className="text-foreground">{label}</SectionLabel>
 {!searchActive && (isCollapsed ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" />)}
 </div>
 </td>
 <td colSpan={15} className="py-1.5 pr-4 text-right">
 <StatValue className={cn("text-xs font-semibold", weekPnl >= 0 ?"text-up" :"text-down")}>
 {weekPnl >= 0 ?"+" :"−"}${Math.abs(weekPnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
 </StatValue>
 </td>
 </tr>,
 ...(isCollapsed ? [] : positions.map((p) => {
 const c = calcPosition(p);
 const ctd ="px-2 pb-2 text-xs font-mono tabular-nums whitespace-nowrap text-muted-foreground";
 const cs = chainSummaryByFinalLegId.get(p.id);
 const td = cs ? tdClassChained : tdClass;
 const tdNum = cs ? tdNumChained : tdNumClass;
 const tdText = cs ?"px-2 pt-2 pb-1 text-13 whitespace-nowrap" :"px-2 py-2 text-13 whitespace-nowrap";

 const positionRow = (
 <tr key={p.id} className={cn("group hover:bg-muted", cs ?"" :"border-b border-border")}>
 {/* Position + Contracts — frozen */}
 <td style={{ left: 0 }} className={cn(tdText,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted pl-4 pr-2")}>
 <div className="flex items-center gap-1.5">
 <span className="font-bold font-mono">{p.ticker.symbol}</span>
 {p.groupId && <Link className="h-3 w-3 text-muted-foreground shrink-0" />}
 </div>
 </td>
 <td style={{ left: 80 }} className={cn(tdText,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted")}>
 <span className={cn(
"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
 p.optionType ==="CALL" ?"bg-blue-soft text-blue-deep" :"bg-violet-soft text-violet-deep"
 )}>
 {p.optionType ==="CALL" ?"CC" :"CSP"}
 </span>
 </td>
 <td style={{ left: 152 }} className={cn(td,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted")}>${fmtUSD(p.strikePrice)}</td>
 <td style={{ left: 232 }} className={cn(tdText,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted")}>{fmtDate(p.expirationDate)}</td>
 <td style={{ left: 312 }} className={cn(td,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted border-r border-border/50")}>{p.contracts}</td>
 {/* Dates group */}
 {isColOpen("dates") ? (
 <>
 <td className={cn(td,"border-l border-border/50")} title={fmtDateTimeFull(p.openedAt)}>{fmtDateTimeShort(p.openedAt)}</td>
 <td className={td} title={(() => {
 if (p.closedAt) return fmtDateTimeFull(p.closedAt);
 const [ey, em, ed] = p.expirationDate.split("T")[0].split("-").map(Number);
 return fmtDateTimeFull(new Date(Date.UTC(ey, em - 1, ed, 20, 0, 0)).toISOString());
 })()}>{p.closedAt ? fmtDateTimeShort(p.closedAt) : fmtDate(p.expirationDate)}</td>
 <td className={td}>{c.daysInTrade != null ?`${Math.round(c.daysInTrade)}d` :"—"}</td>
 </>
 ) : (
 <td className={cn(td,"border-l border-border/50")}>
 {c.daysInTrade != null ?`${Math.round(c.daysInTrade)}d` :"—"}
 </td>
 )}
 {/* P&L group */}
 {isColOpen("pnl") ? (
 <>
 <td className={cn(td,"border-l border-border/50")}>${fmtUSD(p.premiumPerShare)}</td>
 <td className={td}>
 {p.outcome ==="EXPIRED_WORTHLESS" || p.outcome ==="ASSIGNED" ?"—" : fmt(p.closePremiumPerShare, 2,"$")}
 </td>
 <td className={td}>${fmtUSD(c.totalFees)}</td>
 <td className={tdNum}>
 {c.pnl != null ? (
 <span className={cn(c.pnl >= 0 ?"text-up" :"text-down")}>
 {c.pnl >= 0 ?"+" :"−"}${fmtUSD(Math.abs(c.pnl))}
 </span>
 ) :"—"}
 </td>
 </>
 ) : (
 <td className={cn(tdNum,"border-l border-border/50")}>
 {c.pnl != null ? (
 <span className={cn(c.pnl >= 0 ?"text-up" :"text-down")}>
 {c.pnl >= 0 ?"+" :"−"}${fmtUSD(Math.abs(c.pnl))}
 </span>
 ) :"—"}
 </td>
 )}
 {/* Always-visible trailing columns */}
 <td className={td}>
 {c.closedAnnReturn != null ? (
 <span className={cn(c.closedAnnReturn >= 0 ?"text-up" :"text-down")}>
 {fmtPct(c.closedAnnReturn)}
 </span>
 ) :"—"}
 </td>
 <td className={tdText}>
 <span className={cn(
"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
 p.outcome ==="EXPIRED_WORTHLESS" ?"bg-up-soft text-up-deep" :
 p.outcome ==="ASSIGNED" ?"bg-warn-soft text-warn-deep" :
 p.outcome ==="ROLLED" ?"bg-blue-soft text-blue-deep" :
"bg-secondary text-muted-foreground"
 )}>
 {p.outcome ? outcomeLabel[p.outcome] :"—"}
 </span>
 </td>
 <td className={td}>
 <div className="flex items-center gap-1">
 <Tooltip content="Edit close details">
 <button
 onClick={() => onEdit(p)}
 className="p-1.5 rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted-hover transition-colors"
 >
 <Pencil className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
 <Tooltip content="Delete">
 <button
 onClick={() => setConfirmDelete(p)}
 className="p-1.5 rounded text-muted-foreground/40 hover:text-down hover:bg-down-soft transition-colors"
 >
 <Trash2 className="h-3.5 w-3.5" />
 </button>
 </Tooltip>
 </div>
 </td>
 </tr>
 );

 const chainRow = cs ? (
 <tr key={`${p.id}-chain`} className="group border-b border-border hover:bg-muted">
 {/* Label — frozen */}
 <td style={{ left: 0 }} className={cn(ctd,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted pl-4 pr-2 font-medium text-muted-foreground/60 uppercase tracking-[1px] font-mono text-10")}>roll</td>
 <td style={{ left: 80 }} className={cn(ctd,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted")} />
 <td style={{ left: 152 }} className={cn(ctd,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted")} />
 <td style={{ left: 232 }} className={cn(ctd,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted")} />
 <td style={{ left: 312 }} className={cn(ctd,"sticky z-[2] bg-[#fbfcfd] group-hover:bg-muted border-r border-border/50")} />
 {/* Dates group */}
 {isColOpen("dates") ? (
 <>
 <td className={cn(ctd,"border-l border-border/50")}>
 {fmtDateTimeShort(cs.legs[0].openedAt)}
 </td>
 <td className={ctd}>
 {new Date(cs.lastCloseMs).toLocaleDateString("en-US", { month:"numeric", day:"numeric", year:"2-digit" })}
 </td>
 <td className={ctd}>{Math.round(cs.chainDaysInTrade)}d</td>
 </>
 ) : (
 <td className={cn(ctd,"border-l border-border/50")}>{Math.round(cs.chainDaysInTrade)}d</td>
 )}
 {/* P&L group */}
 {isColOpen("pnl") ? (
 <>
 <td className={cn(ctd,"border-l border-border/50")} />
 <td className={ctd} />
 <td className={ctd}>${fmtUSD(cs.totalFees)}</td>
 <td className={ctd}>
 <span className={cn("font-medium", cs.chainPnl >= 0 ?"text-up" :"text-down")}>
 {cs.chainPnl >= 0 ?"+" :"−"}${fmtUSD(Math.abs(cs.chainPnl))}
 </span>
 </td>
 </>
 ) : (
 <td className={cn(ctd,"border-l border-border/50")}>
 <span className={cn("font-medium", cs.chainPnl >= 0 ?"text-up" :"text-down")}>
 {cs.chainPnl >= 0 ?"+" :"−"}${fmtUSD(Math.abs(cs.chainPnl))}
 </span>
 </td>
 )}
 {/* Ann. Return */}
 <td className={ctd}>
 {cs.chainAnnReturn != null ? (
 <span className={cn(cs.chainAnnReturn >= 0 ?"text-up" :"text-down")}>
 {fmtPct(cs.chainAnnReturn)}
 </span>
 ) :"—"}
 </td>
 {/* Outcome — empty; P&L + Ann. Return already convey the result */}
 <td className={ctd} />
 {/* Actions — empty */}
 <td className={ctd} />
 </tr>
 ) : null;

 return <React.Fragment key={p.id}>{positionRow}{chainRow}</React.Fragment>;
 }))];

 });
 })()}
 </tbody>
 </table>
 </div>
 {/* Sticky column-header portal — shown when the thead has scrolled above the nav */}
 {stickyRect && createPortal(
 <div style={{ position:"fixed", top: 72, left: stickyRect.left, width: stickyRect.width, zIndex: 45 }}>
 <div ref={portalScrollRef} className="bg-background overflow-x-auto" style={{ scrollbarWidth:"none" }}>
 <table className="w-full text-left border-collapse" style={{ tableLayout:"fixed" }}>
 <colgroup>
 {stickyRect.colWidths.map((w, i) => <col key={i} style={{ width:`${w}px` }} />)}
 </colgroup>
 <thead>
 <tr>
 <th colSpan={5} style={{ left: 0 }} className="sticky z-[3] bg-[#fbfcfd] px-3 pt-2 pb-1" />
 {CLOSED_COL_GROUPS.map(({ key, label, count }) => (
 <th
 key={key}
 colSpan={isColOpen(key) ? count : 1}
 onClick={() => toggleColGroup(key)}
 className={cn(
"px-3 pt-2 pb-1 text-left font-mono text-10 font-medium tracking-[0.11em] uppercase cursor-pointer select-none transition-colors",
"border-l border-border/50",
 isColOpen(key)
 ?"text-muted-foreground/70 hover:text-muted-foreground"
 :"text-muted-foreground/50 hover:text-muted-foreground/80"
 )}
 >
 <div className="flex items-center gap-1">
 {label}
 {isColOpen(key) ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
 </div>
 </th>
 ))}
 <th colSpan={3} className="pt-2 pb-1" />
 </tr>
 <tr className="border-b border-border">
 <th style={{ left: 0 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd] pl-4 pr-2")}>Ticker</th>
 <th style={{ left: 80 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Type</th>
 <th style={{ left: 152 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Strike</th>
 <th style={{ left: 232 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd]")}>Exp</th>
 <th style={{ left: 312 }} className={cn(thClass,"sticky z-[3] bg-[#fbfcfd] border-r border-border/50")}>Contracts</th>
 {isColOpen("dates") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Opened</th>
 <th className={thClass}>Closed</th>
 <th className={thClass}>Days in Trade</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>Days in Trade</th>
 )}
 {isColOpen("pnl") ? (
 <>
 <th className={cn(thClass,"border-l border-border/50")}>Open Prem</th>
 <th className={thClass}>Close Prem</th>
 <th className={thClass}>Total Fees</th>
 <th className={thClass}>P/L</th>
 </>
 ) : (
 <th className={cn(thClass,"border-l border-border/50 text-muted-foreground/40")}>P/L</th>
 )}
 <th className={thClass}>Ann. Return</th>
 <th className={thClass}>Outcome</th>
 <th className={thClass} />
 </tr>
 </thead>
 </table>
 </div>
 </div>,
 document.body
 )}

 {confirmDelete && createPortal((() => {
 // "Undo split" applies to a split-off leg whose still-open sibling remains
 // (splitGroupId present in the open set). Two shapes: a standalone split leg
 // (no groupId), or the terminal leg of a spun-off clone chain (has a chain
 // summary). Intermediate rolled clone legs fall through to a plain delete.
 const isUndo = confirmDelete.splitGroupId != null
 && openSplitGroupIds.has(confirmDelete.splitGroupId)
 && (confirmDelete.groupId == null || chainSummaryByFinalLegId.has(confirmDelete.id));
 const n = confirmDelete.contractsAssigned ?? confirmDelete.contracts;
 return (
 <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
 <div className="w-full max-w-sm rounded-lg bg-background text-foreground p-6 shadow-xl">
 <h3 className="tp-panel-title">{isUndo ?"Undo this partial close?" :"Delete position?"}</h3>
 <p className="mt-2 text-muted-foreground">
 {isUndo
 ?`This will return ${n} contract${n !== 1 ?"s" :""} to the open ${confirmDelete.ticker.symbol} $${confirmDelete.strikePrice} ${confirmDelete.optionType} position and remove the associated income and pending records. This cannot be undone.`
 :`Delete ${confirmDelete.ticker.symbol} $${confirmDelete.strikePrice} ${confirmDelete.optionType}? This cannot be undone.`}
 </p>
 <div className="mt-4 flex justify-end gap-2">
 <Button variant="secondary" onClick={() => setConfirmDelete(null)}>Cancel</Button>
 <Button variant="destructive" onClick={() => { onDelete(confirmDelete); setConfirmDelete(null); }}>{isUndo ?"Undo Split" :"Delete"}</Button>
 </div>
 </div>
 </div>
 );
 })(),
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

// Label a week by its Friday: M/D (e.g."5/8")
function weekFridayLabel(mondayMs: number): string {
 const fri = new Date(mondayMs + 4 * 86_400_000);
 return`${fri.getMonth() + 1}/${fri.getDate()}`;
}

// First of the month, local midnight — the monthly analogue of getWeekStart.
// A fixed-ms stride doesn't work for months (28-31 days), so monthly window
// math below steps via addMonths() instead of a WEEK_MS-style constant.
function getMonthStart(date: Date): Date {
 const d = new Date(date);
 d.setHours(0, 0, 0, 0);
 d.setDate(1);
 return d;
}

function addMonths(ms: number, n: number): number {
 const d = new Date(ms);
 d.setMonth(d.getMonth() + n);
 return d.getTime();
}

// Label a month abbreviation + 2-digit year (e.g."Jul '26") — a 12-month
// window routinely crosses a year boundary, unlike the 15-week bar window.
function monthLabel(monthStartMs: number): string {
 const d = new Date(monthStartMs);
 const month = d.toLocaleDateString("en-US", { month:"short" });
 const year = String(d.getFullYear()).slice(2);
 return`${month} '${year}`;
}

// SVG path for a rect with per-corner radii (tl/tr/br/bl = top-left/top-right/bottom-right/bottom-left)
function barPath(x: number, y: number, w: number, h: number, tl: number, tr: number, br: number, bl: number) {
 return`M${x + tl},${y} H${x + w - tr} Q${x + w},${y} ${x + w},${y + tr} V${y + h - br} Q${x + w},${y + h} ${x + w - br},${y + h} H${x + bl} Q${x},${y + h} ${x},${y + h - bl} V${y + tl} Q${x},${y} ${x + tl},${y} Z`;
}

// Absorption priority for a negative premium segment: same type/other status
// first, then other type/other status, then other type/same status.
const ABSORB_ORDER: Record<string, string[]> = {
 premiumCC: ["pendingCC", "pendingCSP", "premiumCSP"],
 premiumCSP: ["pendingCSP", "pendingCC", "premiumCC"],
 pendingCC: ["premiumCC", "premiumCSP", "pendingCSP"],
 pendingCSP: ["premiumCSP", "premiumCC", "pendingCC"],
};

// Net any negative segment against the positive segments (in priority order) so
// the stacked bar never overlaps. Only an overall-negative week leaves a
// remainder (barNeg ≤ 0) to render below the axis; the rest are heights ≥ 0.
function netWeekBars(raw: { premiumCSP: number; premiumCC: number; pendingCSP: number; pendingCC: number }) {
 const v: Record<string, number> = { ...raw };
 let neg = 0;
 for (const cat of ["premiumCSP", "premiumCC", "pendingCSP", "pendingCC"]) {
 if (v[cat] >= 0) continue;
 let deficit = -v[cat];
 v[cat] = 0;
 for (const absorber of ABSORB_ORDER[cat]) {
 if (deficit <= 0) break;
 const take = Math.min(Math.max(v[absorber], 0), deficit);
 v[absorber] -= take;
 deficit -= take;
 }
 neg -= deficit;
 }
 return { barCSP: v.premiumCSP, barCC: v.premiumCC, barPendCSP: v.pendingCSP, barPendCC: v.pendingCC, barNeg: neg };
}

// Segments shorter than this many pixels are dropped, and the segment beneath
// them takes the rounded top corners instead — otherwise a solid bar gets a
// squared-off top capped by an invisible sub-pixel sliver. The y-scale is
// shared across the stack, so any rendered segment's height/value ratio
// converts a sibling's dollar value into its pixel height.
const WEEK_MS = 7 * 86_400_000;
const MAX_CHART_WEEKS = 15;
const MAX_CHART_MONTHS = 12;

const MIN_SEG_PX = 1;
function segVisible(value: number | undefined, refPx: number, refValue: number | undefined) {
 return value != null && refValue != null && value > 0 && refValue > 0 && (value / refValue) * refPx >= MIN_SEG_PX;
}

// Props Recharts passes to a <Bar shape> render callback (position + the datum's
// stacked-segment values). Recharts types this as `any`; we narrow to what we read.
type BarShapeProps = {
 x: number; y: number; width: number; height: number;
 // Sibling stack values, spread onto shape props by Recharts at runtime but
 // absent from its static type — optional so the callback stays assignable.
 barCSP?: number; barCC?: number; barPendCSP?: number; barPendCC?: number;
};

function PerformanceCharts({
 openPositions,
 closedPositions,
 settings,
 capitalChanges,
}: {
 openPositions: OptionsPosition[];
 closedPositions: OptionsPosition[];
 settings: OptionsSettings | null;
 capitalChanges: OptionsCapitalChange[];
}) {
 // Current basis (starting basis + capital changes to date), not the original
 // starting basis alone — so the weekly/monthly target tracks deposits and
 // withdrawals instead of staying pinned to whatever basis was set initially.
 const currentBasis = computeCurrentBasis(settings, capitalChanges);
 const targetAnnual = settings && currentBasis != null ? currentBasis * settings.targetReturn : null;
 const targetWeekly = targetAnnual != null ? targetAnnual / 52 : null;
 const targetMonthly = targetAnnual != null ? targetAnnual / 12 : null;

 // Weekly/Monthly toggle for the "Premium Collected" bar chart only — the
 // Cumulative Performance chart below it stays on its own weekly cadence.
 const [chartPeriod, setChartPeriod] = useState<"weekly" | "monthly">("weekly");

 // Shared week-bucketed PnL maps split by option type (CC = CALL, CSP = PUT)
 const weekPnlMap = useMemo(() => {
 const cc = new Map<number, number>();
 const csp = new Map<number, number>();
 for (const p of closedPositions) {
 const closeDate = p.closedAt ? new Date(p.closedAt) : new Date(p.expirationDate.split("T")[0]);
 const ms = getWeekStart(closeDate).getTime();
 const pnl = calcPosition(p).pnl ?? 0;
 if (p.optionType ==="CALL") cc.set(ms, (cc.get(ms) ?? 0) + pnl);
 else csp.set(ms, (csp.get(ms) ?? 0) + pnl);
 }
 return { cc, csp };
 }, [closedPositions]);

 // Pending premium per week split by option type
 const pendingPnlMap = useMemo(() => {
 const cc = new Map<number, number>();
 const csp = new Map<number, number>();
 for (const p of openPositions) {
 const expDate = new Date(p.expirationDate.split("T")[0] +"T20:00:00Z");
 const ms = getWeekStart(expDate).getTime();
 const net = calcPosition(p).totalPremiumNet;
 if (p.optionType ==="CALL") cc.set(ms, (cc.get(ms) ?? 0) + net);
 else csp.set(ms, (csp.get(ms) ?? 0) + net);
 }
 return { cc, csp };
 }, [openPositions]);

 // First trade week: use the setting if provided, otherwise first week with a close
 const startingWeek = settings?.startingWeek;
 const firstTradeWeekMs = useMemo(() => {
 if (startingWeek) {
 return getWeekStart(new Date(startingWeek +"T12:00:00")).getTime();
 }
 const allMs = [...weekPnlMap.cc.keys(), ...weekPnlMap.csp.keys()];
 if (allMs.length === 0) return null;
 return Math.min(...allMs);
 }, [startingWeek, weekPnlMap]);

 const currentWeekMs = getWeekStart(new Date()).getTime();

 // Cumulative chart window: entirely backward-looking. The current week is the
 // rightmost point with the 14 preceding weeks before it. When fewer than 15
 // weeks have elapsed, pin to the start and extend forward to fill 15 weeks.
 const { cumStartMs, cumEndMs } = useMemo(() => {
 if (firstTradeWeekMs == null) return { cumStartMs: null, cumEndMs: null };
 const start = Math.max(currentWeekMs - (MAX_CHART_WEEKS - 1) * WEEK_MS, firstTradeWeekMs);
 const end = start + (MAX_CHART_WEEKS - 1) * WEEK_MS;
 return { cumStartMs: start, cumEndMs: end };
 }, [firstTradeWeekMs, currentWeekMs]);

 // Furthest-out week carrying pending (open-position) premium, so the bar chart
 // can extend forward to show premium we still expect to realize.
 const lastPendingWeekMs = useMemo(() => {
 const ms = [...pendingPnlMap.cc.keys(), ...pendingPnlMap.csp.keys()];
 return ms.length ? Math.max(...ms) : null;
 }, [pendingPnlMap]);

 // Bar chart window: both backward- and forward-looking, always spanning 15
 // weeks. The rightmost bar is the furthest-out pending expiration week (or the
 // current week if there is no later pending premium), with 14 weeks before it.
 // When that anchor is fewer than 15 weeks from the first trade week, the window
 // pins to the first trade week and extends forward to fill 15 weeks instead.
 const { barStartMs, barEndMs } = useMemo(() => {
 if (firstTradeWeekMs == null) return { barStartMs: null, barEndMs: null };
 const anchor = Math.max(currentWeekMs, lastPendingWeekMs ?? currentWeekMs);
 const start = Math.max(anchor - (MAX_CHART_WEEKS - 1) * WEEK_MS, firstTradeWeekMs);
 const end = start + (MAX_CHART_WEEKS - 1) * WEEK_MS;
 return { barStartMs: start, barEndMs: end };
 }, [firstTradeWeekMs, currentWeekMs, lastPendingWeekMs]);

 // Bar chart: capped 15-week window ending on the furthest pending expiration
 const weeklyData = useMemo(() => {
 if (barStartMs == null || barEndMs == null) return [];
 const weeks: { week: string; premiumCSP: number; premiumCC: number; pendingCSP: number; pendingCC: number; barCSP: number; barCC: number; barPendCSP: number; barPendCC: number; barNeg: number; isFuture: boolean }[] = [];
 for (let ms = barStartMs; ms <= barEndMs; ms += WEEK_MS) {
 const premiumCSP = weekPnlMap.csp.get(ms) ?? 0;
 const premiumCC = weekPnlMap.cc.get(ms) ?? 0;
 const pendingCSP = pendingPnlMap.csp.get(ms) ?? 0;
 const pendingCC = pendingPnlMap.cc.get(ms) ?? 0;
 weeks.push({
 week: weekFridayLabel(ms),
 premiumCSP, premiumCC, pendingCSP, pendingCC,
 ...netWeekBars({ premiumCSP, premiumCC, pendingCSP, pendingCC }),
 isFuture: ms > currentWeekMs,
 });
 }
 return weeks;
 }, [barStartMs, barEndMs, weekPnlMap, pendingPnlMap, currentWeekMs]);

 // Monthly analogue of weekPnlMap/pendingPnlMap, for the bar chart's Monthly
 // toggle — same source loops, bucketed by month instead of week.
 const monthPnlMap = useMemo(() => {
 const cc = new Map<number, number>();
 const csp = new Map<number, number>();
 for (const p of closedPositions) {
 const closeDate = p.closedAt ? new Date(p.closedAt) : new Date(p.expirationDate.split("T")[0]);
 const ms = getMonthStart(closeDate).getTime();
 const pnl = calcPosition(p).pnl ?? 0;
 if (p.optionType ==="CALL") cc.set(ms, (cc.get(ms) ?? 0) + pnl);
 else csp.set(ms, (csp.get(ms) ?? 0) + pnl);
 }
 return { cc, csp };
 }, [closedPositions]);

 const pendingMonthPnlMap = useMemo(() => {
 const cc = new Map<number, number>();
 const csp = new Map<number, number>();
 for (const p of openPositions) {
 const expDate = new Date(p.expirationDate.split("T")[0] +"T20:00:00Z");
 const ms = getMonthStart(expDate).getTime();
 const net = calcPosition(p).totalPremiumNet;
 if (p.optionType ==="CALL") cc.set(ms, (cc.get(ms) ?? 0) + net);
 else csp.set(ms, (csp.get(ms) ?? 0) + net);
 }
 return { cc, csp };
 }, [openPositions]);

 const firstTradeMonthMs = useMemo(() => {
 if (startingWeek) {
 return getMonthStart(new Date(startingWeek +"T12:00:00")).getTime();
 }
 const allMs = [...monthPnlMap.cc.keys(), ...monthPnlMap.csp.keys()];
 if (allMs.length === 0) return null;
 return Math.min(...allMs);
 }, [startingWeek, monthPnlMap]);

 const currentMonthMs = getMonthStart(new Date()).getTime();

 const lastPendingMonthMs = useMemo(() => {
 const ms = [...pendingMonthPnlMap.cc.keys(), ...pendingMonthPnlMap.csp.keys()];
 return ms.length ? Math.max(...ms) : null;
 }, [pendingMonthPnlMap]);

 // Bar chart window, monthly cadence: same fixed-width/anchor logic as the
 // weekly barStartMs/barEndMs above, just stepped via addMonths() since months
 // aren't a fixed number of ms.
 const { monthlyBarStartMs, monthlyBarEndMs } = useMemo(() => {
 if (firstTradeMonthMs == null) return { monthlyBarStartMs: null, monthlyBarEndMs: null };
 const anchor = Math.max(currentMonthMs, lastPendingMonthMs ?? currentMonthMs);
 const start = Math.max(addMonths(anchor, -(MAX_CHART_MONTHS - 1)), firstTradeMonthMs);
 const end = addMonths(start, MAX_CHART_MONTHS - 1);
 return { monthlyBarStartMs: start, monthlyBarEndMs: end };
 }, [firstTradeMonthMs, currentMonthMs, lastPendingMonthMs]);

 // Bar chart: capped 12-month window ending on the furthest pending expiration
 const monthlyData = useMemo(() => {
 if (monthlyBarStartMs == null || monthlyBarEndMs == null) return [];
 const months: typeof weeklyData = [];
 for (let ms = monthlyBarStartMs; ms <= monthlyBarEndMs; ms = addMonths(ms, 1)) {
 const premiumCSP = monthPnlMap.csp.get(ms) ?? 0;
 const premiumCC = monthPnlMap.cc.get(ms) ?? 0;
 const pendingCSP = pendingMonthPnlMap.csp.get(ms) ?? 0;
 const pendingCC = pendingMonthPnlMap.cc.get(ms) ?? 0;
 months.push({
 // Field name kept as "week" (not renamed to "month") so it stays a
 // generic x-axis label field shared with weeklyData below.
 week: monthLabel(ms),
 premiumCSP, premiumCC, pendingCSP, pendingCC,
 ...netWeekBars({ premiumCSP, premiumCC, pendingCSP, pendingCC }),
 isFuture: ms > currentMonthMs,
 });
 }
 return months;
 }, [monthlyBarStartMs, monthlyBarEndMs, monthPnlMap, pendingMonthPnlMap, currentMonthMs]);

 const barChartData = chartPeriod ==="weekly" ? weeklyData : monthlyData;
 const targetPeriodic = chartPeriod ==="weekly" ? targetWeekly : targetMonthly;

 // Cumulative chart: capped 15-week window ending on the current week.
 // actual is null for future weeks so the line stops at the current week
 // target uses 1-based week number so W1 target = 1 × targetWeekly (not zero)
 const cumulativeData = useMemo(() => {
 if (firstTradeWeekMs == null || cumStartMs == null || cumEndMs == null) return [];
 let cumulative = 0;
 const points: { week: string; actual: number | null; target: number }[] = [];
 let weekNum = 0;
 // Iterate from the true program start so cumulative + weekNum stay accurate,
 // but only emit the points that fall inside the visible window.
 for (let ms = firstTradeWeekMs; ms <= cumEndMs; ms += WEEK_MS) {
 weekNum++;
 const isPast = ms <= currentWeekMs;
 if (isPast) cumulative += (weekPnlMap.cc.get(ms) ?? 0) + (weekPnlMap.csp.get(ms) ?? 0);
 if (ms < cumStartMs) continue;
 points.push({
 week: weekFridayLabel(ms),
 actual: isPast ? cumulative : null,
 target: targetAnnual != null ? (weekNum / 52) * targetAnnual : 0,
 });
 }
 return points;
 }, [firstTradeWeekMs, weekPnlMap, targetAnnual, currentWeekMs, cumStartMs, cumEndMs]);

 // Delta for the header: actual vs target at the last week with real data
 const lastDataPoint = [...cumulativeData].reverse().find((d) => d.actual != null);
 const delta = lastDataPoint != null ? lastDataPoint.actual! - lastDataPoint.target : null;

 if (closedPositions.length === 0) return null;

 const dollarTick = (v: number) =>
 v >= 1000 ?`$${(v / 1000).toFixed(1)}k` :`$${v.toFixed(0)}`;

 return (
 <div className="grid grid-cols-2 gap-4">
 {/* Premium Bar Chart */}
 <Card className="p-6">
 <div className="flex items-start justify-between gap-2 mb-3">
 <SectionLabel>Premium Collected</SectionLabel>
 <div className="flex items-center gap-3">
 {targetPeriodic != null && (
 <div className="flex items-center gap-1.5">
 <svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke="var(--color-muted-foreground)" strokeWidth="1.5" strokeDasharray="4 3" strokeOpacity="0.7" /></svg>
 <span className="tp-caption">Target ${fmtUSD(targetPeriodic)}/{chartPeriod ==="weekly" ?"wk" :"mo"}</span>
 </div>
 )}
 <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-secondary p-0.5 text-xs font-medium">
 {(["weekly","monthly"] as const).map((v) => (
 <button
 key={v}
 onClick={() => setChartPeriod(v)}
 className={`rounded-md px-2 py-1 capitalize transition-colors ${
 chartPeriod === v
 ?"bg-background text-foreground shadow-sm"
 :"text-muted-foreground hover:text-foreground"
 }`}
 >
 {v.charAt(0).toUpperCase() + v.slice(1)}
 </button>
 ))}
 </div>
 </div>
 </div>
 <ResponsiveContainer width="100%" height={180}>
 <BarChart data={barChartData} stackOffset="sign" margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
 <XAxis
 dataKey="week"
 tick={{ fontSize: 10, fill:"var(--color-muted-foreground)" }}
 axisLine={false}
 tickLine={false}
 interval={0}
 />
 <YAxis
 tick={{ fontSize: 10, fill:"var(--color-muted-foreground)" }}
 axisLine={false}
 tickLine={false}
 tickFormatter={dollarTick}
 width={36}
 />
 <RechartsTooltip
 cursor={{ fill:"var(--color-muted)" }}
 content={({ active, payload, label }) => {
 if (!active || !payload?.length) return null;
 // Show raw totals (not the netted bar heights) so the breakdown still
 // reflects actual closed/pending premium, including negative closes.
 const row = (payload[0]?.payload ?? {}) as { premiumCSP?: number; premiumCC?: number; pendingCSP?: number; pendingCC?: number };
 const csp = row.premiumCSP ?? 0;
 const cc = row.premiumCC ?? 0;
 const pendingCSP = row.pendingCSP ?? 0;
 const pendingCC = row.pendingCC ?? 0;
 const realized = csp + cc;
 const pending = pendingCSP + pendingCC;
 return (
 <div className="rounded-lg border border-border bg-background shadow-md px-3 py-2 text-xs min-w-[230px]">
 <p className="font-semibold text-foreground">{label}</p>
 {realized === 0 && pending === 0 ? (
 <p className="mt-1 text-muted-foreground">$0.00</p>
 ) : (
 <>
 {realized !== 0 && (
 <div className="mt-1.5">
 <div className="flex justify-between gap-4">
 <span className="text-muted-foreground">Closed Total</span>
 <span className="font-medium text-foreground">${fmtUSD(realized)}</span>
 </div>
 <div className="mt-0.5 flex justify-between gap-4 text-muted-foreground">
 <span><span style={{ color:"var(--color-blue)" }}>CC</span>: ${fmtUSD(cc)}</span>
 <span><span style={{ color:"var(--color-violet)" }}>CSP</span>: ${fmtUSD(csp)}</span>
 </div>
 </div>
 )}
 {pending !== 0 && (
 <div className={realized !== 0 ?"mt-1.5 pt-1.5 border-t border-border" :"mt-1.5"}>
 <div className="flex justify-between gap-4">
 <span className="text-muted-foreground">Pending Total</span>
 <span className="font-medium text-foreground">${fmtUSD(pending)}</span>
 </div>
 <div className="mt-0.5 flex justify-between gap-4 text-muted-foreground">
 <span><span style={{ color:"var(--color-blue)" }}>CC</span>: ${fmtUSD(pendingCC)}</span>
 <span><span style={{ color:"var(--color-violet)" }}>CSP</span>: ${fmtUSD(pendingCSP)}</span>
 </div>
 </div>
 )}
 </>
 )}
 </div>
 );
 }}
 />
 {/* CSP realized — solid violet, bottom of stack */}
 <Bar
 dataKey="barCSP"
 stackId="a"
 maxBarSize={32}
 shape={(props: BarShapeProps) => {
 const { x, y, width, height, barCSP, barCC, barPendCSP, barPendCC } = props;
 if (!height || height < MIN_SEG_PX) return <g />;
 const isTop = !segVisible(barCC, height, barCSP) && !segVisible(barPendCSP, height, barCSP) && !segVisible(barPendCC, height, barCSP);
 const r = 3;
 return <path d={barPath(x, y, width, height, isTop ? r : 0, isTop ? r : 0, r, r)} fill="var(--color-violet)" />;
 }}
 />
 {/* CC realized — solid blue, above CSP */}
 <Bar
 dataKey="barCC"
 stackId="a"
 maxBarSize={32}
 shape={(props: BarShapeProps) => {
 const { x, y, width, height, barCSP, barCC, barPendCSP, barPendCC } = props;
 if (!height || height < MIN_SEG_PX) return <g />;
 const isTop = !segVisible(barPendCSP, height, barCC) && !segVisible(barPendCC, height, barCC);
 const isBottom = !segVisible(barCSP, height, barCC);
 const r = 3;
 return <path d={barPath(x, y, width, height, isTop ? r : 0, isTop ? r : 0, isBottom ? r : 0, isBottom ? r : 0)} fill="var(--color-blue)" />;
 }}
 />
 {/* CSP pending — striped violet, above CC realized */}
 <Bar
 dataKey="barPendCSP"
 stackId="a"
 maxBarSize={32}
 shape={(props: BarShapeProps) => {
 const { x, y, width, height, barCSP, barCC, barPendCSP, barPendCC } = props;
 if (!height || height < MIN_SEG_PX || !width || width <= 0) return <g />;
 const isTop = !segVisible(barPendCC, height, barPendCSP);
 const isBottom = !segVisible(barCSP, height, barPendCSP) && !segVisible(barCC, height, barPendCSP);
 const r = 3;
 const d = barPath(x, y, width, height, isTop ? r : 0, isTop ? r : 0, isBottom ? r : 0, isBottom ? r : 0);
 const clipId =`pending-csp-${Math.round(x * 10)}`;
 const lines: React.ReactElement[] = [];
 for (let offset = -height; offset < width + height; offset += 5) {
 lines.push(
 <line key={offset}
 x1={x + offset} y1={y + height}
 x2={x + offset + height} y2={y}
 stroke="white" strokeOpacity={0.55} strokeWidth={2}
 clipPath={`url(#${clipId})`}
 />
 );
 }
 return (
 <g>
 <defs><clipPath id={clipId}><path d={d} /></clipPath></defs>
 <path d={d} fill="var(--color-violet)" fillOpacity={0.3} />
 {lines}
 </g>
 );
 }}
 />
 {/* CC pending — striped blue, top of stack */}
 <Bar
 dataKey="barPendCC"
 stackId="a"
 maxBarSize={32}
 shape={(props: BarShapeProps) => {
 const { x, y, width, height, barCSP, barCC, barPendCSP, barPendCC } = props;
 if (!height || height < MIN_SEG_PX || !width || width <= 0) return <g />;
 const isBottom = !segVisible(barCSP, height, barPendCC) && !segVisible(barCC, height, barPendCC) && !segVisible(barPendCSP, height, barPendCC);
 const r = 3;
 const d = barPath(x, y, width, height, r, r, isBottom ? r : 0, isBottom ? r : 0);
 const clipId =`pending-cc-${Math.round(x * 10)}`;
 const lines: React.ReactElement[] = [];
 for (let offset = -height; offset < width + height; offset += 5) {
 lines.push(
 <line key={offset}
 x1={x + offset} y1={y + height}
 x2={x + offset + height} y2={y}
 stroke="white" strokeOpacity={0.55} strokeWidth={2}
 clipPath={`url(#${clipId})`}
 />
 );
 }
 return (
 <g>
 <defs><clipPath id={clipId}><path d={d} /></clipPath></defs>
 <path d={d} fill="var(--color-blue)" fillOpacity={0.3} />
 {lines}
 </g>
 );
 }}
 />
 {/* Net loss — solid red, below axis, only when the week is overall negative */}
 <Bar
 dataKey="barNeg"
 stackId="a"
 maxBarSize={32}
 shape={(props: BarShapeProps) => {
 const { x, y, width, height } = props;
 if (!height || height < MIN_SEG_PX) return <g />;
 const r = 3;
 return <path d={barPath(x, y, width, height, 0, 0, r, r)} fill="var(--color-down)" />;
 }}
 />
 {targetPeriodic != null && (
 <ReferenceLine
 y={targetPeriodic}
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
 <Card className="p-6">
 <div className="flex items-center justify-between mb-1">
 <SectionLabel>Cumulative Performance vs Target</SectionLabel>
 <div className="flex items-center gap-4">
 <div className="flex items-center gap-1.5">
 <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke="var(--color-primary)" strokeWidth="2" /></svg>
 <span className="tp-caption">Actual</span>
 </div>
 {targetAnnual != null && (
 <div className="flex items-center gap-1.5">
 <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke="var(--color-muted-foreground)" strokeWidth="1.5" strokeDasharray="4 3" strokeOpacity="0.7" /></svg>
 <span className="tp-caption">Target</span>
 </div>
 )}
 </div>
 </div>
 {delta != null && (
 <p className={cn("text-xs font-medium mb-2", delta >= 0 ?"text-up" :"text-down")}>
 {delta >= 0 ?"Ahead" :"Behind"} of target by ${fmtUSD(Math.abs(delta))}
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
 tick={{ fontSize: 10, fill:"var(--color-muted-foreground)" }}
 axisLine={false}
 tickLine={false}
 interval={0}
 />
 <YAxis
 tick={{ fontSize: 10, fill:"var(--color-muted-foreground)" }}
 axisLine={false}
 tickLine={false}
 tickFormatter={dollarTick}
 width={44}
 />
 <RechartsTooltip
 content={({ active, payload, label }) => {
 if (!active || !payload?.length) return null;
 const actual = payload.find((p) => p.dataKey ==="actual");
 const target = payload.find((p) => p.dataKey ==="target");
 return (
 <div className="rounded border border-border bg-background p-2 text-xs shadow-md">
 <p className="mb-1 font-medium">{label}</p>
 {actual?.value != null && (
 <p className="text-primary">Actual: ${fmtUSD(actual.value as number)}</p>
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
 dot={{ r: 3, fill:"var(--color-primary)", strokeWidth: 0 }}
 activeDot={{ r: 4, fill:"var(--color-primary)", strokeWidth: 0 }}
 connectNulls={false}
 />
 </ComposedChart>
 </ResponsiveContainer>
 </Card>
 </div>
 );
}

// ── Performance Table ──────────────────────────────────────────────────────────

const _fmtDays = (d: number | null) => (d != null ? d.toFixed(1) :"—");
const _fmtRate = (r: number | null) => (r != null ?`${r.toFixed(1)}%` :"—");

// Metric columns for one row of the performance table. Hoisted to module scope
// (rather than nested in PerformanceTable) so it's a stable component identity.
function MetricCells({ m }: { m: PerformanceMetrics }) {
 const tdCls ="px-4 py-2 text-right tabular-nums font-mono";
 return (
 <>
 <td className={tdCls}>{m.tradeCount}</td>
 <td className={tdCls}>{m.contractCount}</td>
 <td className={tdCls}>
 {m.winRate != null ? (
 <span className={m.winRate >= 50 ?"text-up" :"text-down"}>{_fmtRate(m.winRate)}</span>
 ) :"—"}
 </td>
 <td className={tdCls}>{_fmtRate(m.assignmentRate)}</td>
 <td className={tdCls}>
 {m.avgActualDays != null && m.avgExpectedDays != null ? (
 <span>{_fmtDays(m.avgActualDays)}<span className="text-muted-foreground"> / {_fmtDays(m.avgExpectedDays)}</span></span>
 ) :"—"}
 </td>
 <td className={tdCls}>
 {m.ccPremium !== 0 ? (
 <span className={m.ccPremium >= 0 ?"text-up" :"text-down"}>
 {m.ccPremium >= 0 ?"" :"−"}${fmtUSD(Math.abs(m.ccPremium))}
 </span>
 ) : <span className="text-muted-foreground">—</span>}
 </td>
 <td className={tdCls}>
 {m.cspPremium !== 0 ? (
 <span className={m.cspPremium >= 0 ?"text-up" :"text-down"}>
 {m.cspPremium >= 0 ?"" :"−"}${fmtUSD(Math.abs(m.cspPremium))}
 </span>
 ) : <span className="text-muted-foreground">—</span>}
 </td>
 <td className={tdCls}>
 {m.closedCount > 0 ? (
 <span className={m.totalPremium >= 0 ?"text-up" :"text-down"}>
 {m.totalPremium >= 0 ?"" :"−"}${fmtUSD(Math.abs(m.totalPremium))}
 </span>
 ) :"—"}
 </td>
 <td className={tdCls}>
 {m.weightedArr != null ? (
 <span className={m.weightedArr >= 0 ?"text-up" :"text-down"}>{fmtPct(m.weightedArr)}</span>
 ) :"—"}
 </td>
 </>
 );
}

function PerformanceTable({ positions }: { positions: OptionsPosition[] }) {
 const [expanded, setExpanded] = useState(false);

 if (positions.length === 0) return null;

 const symbols = Array.from(new Set(positions.map((p) => p.ticker.symbol))).sort();
 const aggregate = computePerformanceMetrics(positions);
 const byTicker = symbols.map((sym) => ({
 symbol: sym,
 metrics: computePerformanceMetrics(positions.filter((p) => p.ticker.symbol === sym)),
 }));

 return (
 <Card className="p-6">
 <div className="pb-3 border-b border-border flex items-center gap-1.5">
 <SectionLabel as="span">Performance Details (Fully Completed Trades)</SectionLabel>
 <CardInfoTooltip>
 Rolled positions are only counted here once every leg in the chain has closed — a roll with a still-open leg is excluded entirely until it fully closes
 </CardInfoTooltip>
 </div>
 <div className="overflow-x-auto">
 <table className="w-full text-xs">
 <thead>
 <tr className="border-b border-border">
 <ColumnHeader className="px-4 py-2 text-left">Ticker</ColumnHeader>
 <ColumnHeader className="px-4 py-2 text-right">Trades</ColumnHeader>
 <ColumnHeader className="px-4 py-2 text-right">Contracts</ColumnHeader>
 <ColumnHeader className="px-4 py-2 text-right">Win Rate</ColumnHeader>
 <ColumnHeader className="px-4 py-2 text-right">Assign. Rate</ColumnHeader>
 <ColumnHeader className="px-4 py-2 text-right whitespace-nowrap">Avg Days (actual / exp.)</ColumnHeader>
 <ColumnHeader className="px-4 py-2 text-right whitespace-nowrap">CC Premium</ColumnHeader>
 <ColumnHeader className="px-4 py-2 text-right whitespace-nowrap">CSP Premium</ColumnHeader>
 <ColumnHeader className="px-4 py-2 text-right whitespace-nowrap">Total Premium</ColumnHeader>
 <ColumnHeader className="px-4 py-2 text-right whitespace-nowrap">Wtd. Ann. Return</ColumnHeader>
 </tr>
 </thead>
 <tbody>
 <tr
 className="border-b border-border bg-muted font-medium cursor-pointer hover:bg-muted-hover transition-colors"
 onClick={() => setExpanded((v) => !v)}
 >
 <td className="px-4 py-2 text-13">
 <span className="inline-flex items-center gap-1.5">
 All
 {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
 </span>
 </td>
 <MetricCells m={aggregate} />
 </tr>
 {expanded && byTicker.map(({ symbol, metrics }) => (
 <tr key={symbol} className="border-b border-border last:border-0 hover:bg-muted transition-colors">
 <td className="px-4 py-2 font-bold font-mono">{symbol}</td>
 <MetricCells m={metrics} />
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </Card>
 );
}

// ── Capital Distribution Bar ───────────────────────────────────────────────────

// Ordered to maximise minimum hue distance between adjacent entries (≥108°).
const TICKER_COLORS = [
"var(--color-chart-4)", // 12° red-orange
"var(--color-chart-9)", // 220° steel-blue
"var(--color-chart-10)", // 330° pink
"var(--color-chart-6)", // 158° green
"var(--color-chart-1)", // 268° blue
"var(--color-chart-3)", // 75° yellow-green
"var(--color-chart-2)", // 192° cyan
"var(--color-chart-7)", // 300° purple
"var(--color-chart-8)", // 50° orange
"var(--color-chart-5)", // 245° blue-purple
];

// Trading basis in effect today = starting basis plus every capital adjustment
// whose effective date has already arrived. Shared by the Capital at Risk panel
// and the distribution bar so both reflect deposits/withdrawals.
function computeCurrentBasis(
 settings: OptionsSettings | null,
 capitalChanges: OptionsCapitalChange[],
): number | null {
 if (settings?.startingBasis == null) return null;
 const nowMs = Date.now();
 return capitalChanges.reduce(
 (basis, c) =>
 basis + (new Date(c.effectiveDate +"T12:00:00").getTime() <= nowMs ? Number(c.delta) : 0),
 Number(settings.startingBasis),
 );
}

function CapitalDistributionBar({
 openPositions,
 settings,
 capitalChanges,
 tickerColorMap,
 tickerContractMap,
}: {
 openPositions: OptionsPosition[];
 settings: OptionsSettings | null;
 capitalChanges: OptionsCapitalChange[];
 tickerColorMap: Map<string, string>;
 tickerContractMap: Map<string, number>;
}) {
 const [tooltip, setTooltip] = useState<{ x: number; y: number; ticker: string; capital: number; pct: number; contracts: number | null } | null>(null);

 const tickerCapital = new Map<string, number>();
 for (const p of openPositions) {
 const sym = p.ticker.symbol;
 tickerCapital.set(sym, (tickerCapital.get(sym) ?? 0) + calcPosition(p).capitalAtRisk);
 }

 const totalDeployed = Array.from(tickerCapital.values()).reduce((s, v) => s + v, 0);
 const basis = computeCurrentBasis(settings, capitalChanges) ?? 0;
 const total = Math.max(basis, totalDeployed);

 if (total === 0) return null;

 const tickers = Array.from(tickerColorMap.keys())
 .filter((sym) => tickerCapital.has(sym))
 .map((sym) => [sym, tickerCapital.get(sym)!] as [string, number]);

 const undeployed = Math.max(0, total - totalDeployed);

 return (
 <div className="relative flex h-2 w-full overflow-hidden rounded-md">
 {tickers.map(([sym, capital]) => {
 const pct = (capital / total) * 100;
 const color = tickerColorMap.get(sym)!;
 return (
 <div
 key={sym}
 style={{ width:`${pct}%`, backgroundColor: color }}
 className="h-full transition-all cursor-default"
 onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, ticker: sym, capital, pct, contracts: tickerContractMap.get(sym) ?? null })}
 onMouseMove={(e) => setTooltip((t) => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
 onMouseLeave={() => setTooltip(null)}
 />
 );
 })}
 {undeployed > 0 && (
 <div
 style={{ flex: 1, position:"relative", backgroundColor:"var(--color-muted)" }}
 className="h-full cursor-default"
 onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, ticker:"Undeployed", capital: undeployed, pct: (undeployed / total) * 100, contracts: null })}
 onMouseMove={(e) => setTooltip((t) => t ? { ...t, x: e.clientX, y: e.clientY } : null)}
 onMouseLeave={() => setTooltip(null)}
 >
 <svg width="100%" height="100%" style={{ position:"absolute", inset: 0 }}>
 <defs>
 <pattern id="undeployed-stripe" x="0" y="0" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
 <rect width="2" height="4" fill="rgba(100,116,139,0.35)" />
 </pattern>
 </defs>
 <rect width="100%" height="100%" fill="url(#undeployed-stripe)" />
 </svg>
 </div>
 )}
 {tooltip && (
 <div
 className="fixed z-[60] pointer-events-none bg-white border border-border rounded-lg shadow-lg px-3 py-2 text-xs min-w-[160px]"
 style={{ left: tooltip.x + 14, top: tooltip.y - 8, transform:"translateY(-100%)" }}
 >
 <p className="font-semibold mb-1.5">{tooltip.ticker}</p>
 <div className="space-y-1">
 <div className="flex justify-between gap-4">
 <span className="text-muted-foreground">Capital</span>
 <StatValue className="font-medium">${tooltip.capital.toLocaleString("en-US", { maximumFractionDigits: 0 })}</StatValue>
 </div>
 {tooltip.contracts != null && (
 <div className="flex justify-between gap-4">
 <span className="text-muted-foreground">Contracts</span>
 <StatValue className="font-medium">{tooltip.contracts}</StatValue>
 </div>
 )}
 <div className="flex justify-between gap-4">
 <span className="text-muted-foreground">Share</span>
 <StatValue className="font-medium">{tooltip.pct.toFixed(1)}%</StatValue>
 </div>
 </div>
 </div>
 )}
 </div>
 );
}

// ── Market calendar helpers ─────────────────────────────────────────────────
// NYSE holiday / trading-day logic lives in @/lib/marketHolidays (isNonTradingDay,
// etDateParts). The ET→UTC converter below stays local because it's only needed
// for the intraday trading-hours math in the utilization analytics.

const _etOffsetFmt = new Intl.DateTimeFormat("en-US", {
 timeZone:"America/New_York", timeZoneName:"shortOffset",
});

// Convert an ET clock time (year, month, day, hour, minute) to a UTC timestamp,
// accounting for DST automatically via the shortOffset trick from priceUtils.ts.
function _etToUTC(year: number, month: number, day: number, hour: number, minute = 0): number {
 const ref = new Date(Date.UTC(year, month - 1, day, 12, 0, 0)); // noon UTC same calendar day
 const tzStr = _etOffsetFmt.formatToParts(ref).find(p => p.type ==="timeZoneName")!.value;
 const m = tzStr.match(/GMT([+-])(\d+)/)!;
 const offsetStr =`${m[1]}${m[2].padStart(2,"0")}:00`;
 const hh = String(hour).padStart(2,"0"), mm = String(minute).padStart(2,"0");
 const mo = String(month).padStart(2,"0"), dd = String(day).padStart(2,"0");
 return new Date(`${year}-${mo}-${dd}T${hh}:${mm}:00${offsetStr}`).getTime();
}

// ── Summary Cards ──────────────────────────────────────────────────────────────

// Benchmark indices paginated (2 per page) inside the Benchmark Performance card.
const BENCHMARK_LAYOUT: { symbol: string; label: string }[][] = [
 [{ symbol:"^SP500TR", label:"S&P 500 TR" }, { symbol:"^IXIC", label:"Nasdaq Comp" }],
 [{ symbol:"^PUT", label:"S&P 500 PutWrite" }, { symbol:"^BXM", label:"S&P 500 BuyWrite" }],
];

// Hover (?) tooltip for a summary-card heading; mirrors the NIIT tooltip on TaxEstimator.
function CardInfoTooltip({ children }: { children: React.ReactNode }) {
 return (
 <span className="group relative inline-flex">
 <CircleQuestionMark className="h-3.5 w-3.5 cursor-default text-muted-foreground/60" />
 <span className="pointer-events-none invisible absolute bottom-full left-1/2 z-[60] mb-2 w-64 -translate-x-1/2 rounded-md border border-border bg-background px-3 py-2 tp-caption opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100">
 {children}
 </span>
 </span>
 );
}

function SummaryCards({
 openPositions,
 closedPositions,
 settings,
 capitalChanges,
 totalUnrealizedPnl,
 totalRealizedPnl,
 realizedRows,
}: {
 openPositions: OptionsPosition[];
 closedPositions: OptionsPosition[];
 settings: OptionsSettings | null;
 capitalChanges: OptionsCapitalChange[];
 totalUnrealizedPnl: number | null;
 totalRealizedPnl: number | null;
 realizedRows: RealizedDisposition[];
}) {
 // ── Capital utilization series ────────────────────────────────────────────
 const utilizationData = useMemo(() => {
 if (!settings?.startingWeek || !settings?.startingBasis) return null;

 const windowStartMs = getWeekStart(new Date(settings.startingWeek +"T12:00:00")).getTime();
 const windowEndMs = Date.now();
 if (windowEndMs <= windowStartMs) return null;

 // Build basis step-function: same period boundaries as the annualized return calc
 const changesAfterStart = capitalChanges
 .filter((c) => new Date(c.effectiveDate +"T12:00:00").getTime() > windowStartMs)
 .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

 const basisPeriods: { startMs: number; basis: number }[] = [
 { startMs: windowStartMs, basis: Number(settings.startingBasis) },
];
 for (const c of changesAfterStart) {
 const changeMs = new Date(c.effectiveDate +"T12:00:00").getTime();
 const prevBasis = basisPeriods[basisPeriods.length - 1].basis;
 basisPeriods.push({ startMs: changeMs, basis: prevBasis + Number(c.delta) });
 }

 const getBasis = (dayStartMs: number): number => {
 let basis = basisPeriods[0].basis;
 for (const period of basisPeriods) {
 if (period.startMs <= dayStartMs) basis = period.basis;
 else break;
 }
 return basis;
 };

 const allPositions = [...openPositions, ...closedPositions].filter(
 (p) => !p.isDraft && p.isActive
 );

 const DAY_MS = 86_400_000;
 const MINUTE_MS = 60_000;

 // For closed/expired/assigned positions with no closedAt, use expiration at 4 pm ET
 // rather than windowEndMs — otherwise they inflate utilization beyond their expiry date.
 const getPosCloseMs = (pos: OptionsPosition): number => {
 if (pos.closedAt) return new Date(pos.closedAt).getTime();
 if (pos.status ==="OPEN") return windowEndMs;
 const [ey, em, ed] = pos.expirationDate.split("T")[0].split("-").map(Number);
 return new Date(Date.UTC(ey, em - 1, ed, 20, 0, 0)).getTime();
 };

 type SeriesEntry = {
 dayMs: number;
 utilization: number;
 basis: number;
 capitalDeployed: number;
 contributors: { label: string; capitalAtRisk: number; overlapMin: number }[];
 };
 const series: SeriesEntry[] = [];
 let totalCapitalMinutes = 0;
 let totalBasisMinutes = 0;

 let dayMs = windowStartMs;
 while (dayMs < windowEndMs) {
 if (isNonTradingDay(dayMs)) { dayMs += DAY_MS; continue; }

 const dayEndMs = Math.min(dayMs + DAY_MS, windowEndMs);
 const dayDurationMin = (dayEndMs - dayMs) / MINUTE_MS;
 const basis = getBasis(dayMs);

 if (basis > 0) {
 let capitalMin = 0;
 const contributors: SeriesEntry["contributors"] = [];
 for (const pos of allPositions) {
 const openMs = new Date(pos.openedAt).getTime();
 const closeMs = getPosCloseMs(pos);
 const overlapStart = Math.max(openMs, dayMs);
 const overlapEnd = Math.min(closeMs, dayEndMs);
 if (overlapEnd > overlapStart) {
 const overlapMin = (overlapEnd - overlapStart) / MINUTE_MS;
 const car = calcPosition(pos).capitalAtRisk;
 capitalMin += car * overlapMin;
 const expStr = pos.expirationDate.split("T")[0].slice(5); // MM-DD
 contributors.push({
 label:`${pos.ticker.symbol} ${pos.status} ${pos.side} ${pos.optionType} $${pos.strikePrice} exp ${expStr} ×${pos.contracts}`,
 capitalAtRisk: car,
 overlapMin,
 });
 }
 }
 const capitalDeployed = capitalMin / dayDurationMin;
 const utilization = capitalDeployed / basis;
 series.push({ dayMs, utilization, basis, capitalDeployed, contributors });
 totalCapitalMinutes += capitalMin;
 totalBasisMinutes += basis * dayDurationMin;
 }

 dayMs += DAY_MS;
 }

 const overallRate = totalBasisMinutes > 0 ? (totalCapitalMinutes / totalBasisMinutes) * 100 : null;
 const yMax = Math.max(1.0, ...series.map((d) => d.utilization));

 return { series, overallRate, yMax };
 }, [openPositions, closedPositions, settings, capitalChanges]);
 void utilizationData; // 24hr version kept for reference; panel render removed

 // ── Capital utilization (market hours only: 9:30–4:00 ET) ─────────────────
 const utilizationDataTrading = useMemo(() => {
 if (!settings?.startingWeek || !settings?.startingBasis) return null;

 const windowStartMs = getWeekStart(new Date(settings.startingWeek +"T12:00:00")).getTime();
 const windowEndMs = Date.now();
 if (windowEndMs <= windowStartMs) return null;

 const changesAfterStart = capitalChanges
 .filter((c) => new Date(c.effectiveDate +"T12:00:00").getTime() > windowStartMs)
 .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

 const basisPeriods: { startMs: number; basis: number }[] = [
 { startMs: windowStartMs, basis: Number(settings.startingBasis) },
];
 for (const c of changesAfterStart) {
 const changeMs = new Date(c.effectiveDate +"T12:00:00").getTime();
 const prevBasis = basisPeriods[basisPeriods.length - 1].basis;
 basisPeriods.push({ startMs: changeMs, basis: prevBasis + Number(c.delta) });
 }

 const getBasis = (dayStartMs: number): number => {
 let basis = basisPeriods[0].basis;
 for (const period of basisPeriods) {
 if (period.startMs <= dayStartMs) basis = period.basis;
 else break;
 }
 return basis;
 };

 const allPositions = [...openPositions, ...closedPositions].filter(
 (p) => !p.isDraft && p.isActive
 );

 const DAY_MS = 86_400_000;
 const MINUTE_MS = 60_000;

 const getPosCloseMs = (pos: OptionsPosition): number => {
 if (pos.closedAt) return new Date(pos.closedAt).getTime();
 if (pos.status ==="OPEN") return windowEndMs;
 const [ey, em, ed] = pos.expirationDate.split("T")[0].split("-").map(Number);
 return new Date(Date.UTC(ey, em - 1, ed, 20, 0, 0)).getTime();
 };

 type TradingSeriesEntry = {
 dayMs: number;
 utilization: number;
 basis: number;
 capitalDeployed: number;
 ccDeployed: number;
 cspDeployed: number;
 tradingDurationMin: number;
 contributors: { label: string; capitalAtRisk: number; overlapMin: number; optionType: string }[];
 };
 const series: TradingSeriesEntry[] = [];
 let totalCapitalMinutes = 0;
 let totalBasisMinutes = 0;

 let dayMs = windowStartMs;
 while (dayMs < windowEndMs) {
 // Anchor to UTC midnight so ET clock times are timezone-independent
 if (isNonTradingDay(dayMs)) { dayMs += DAY_MS; continue; }
 const { year: etY, month: etMo, day: etD } = etDateParts(dayMs + 12 * 3600_000);
 const tradingOpenMs = _etToUTC(etY, etMo, etD, 9, 30);
 const tradingCloseMs = Math.min(_etToUTC(etY, etMo, etD, 16, 0), windowEndMs);

 if (tradingOpenMs < windowEndMs && tradingCloseMs > tradingOpenMs) {
 const tradingDurationMin = (tradingCloseMs - tradingOpenMs) / MINUTE_MS;
 const basis = getBasis(dayMs);

 if (basis > 0) {
 let capitalMin = 0;
 let ccCapitalMin = 0;
 let cspCapitalMin = 0;
 const contributors: TradingSeriesEntry["contributors"] = [];
 for (const pos of allPositions) {
 const openMs = new Date(pos.openedAt).getTime();
 const closeMs = getPosCloseMs(pos);
 const overlapStart = Math.max(openMs, tradingOpenMs);
 const overlapEnd = Math.min(closeMs, tradingCloseMs);
 if (overlapEnd > overlapStart) {
 const overlapMin = (overlapEnd - overlapStart) / MINUTE_MS;
 const car = calcPosition(pos).capitalAtRisk;
 capitalMin += car * overlapMin;
 if (pos.optionType ==="CALL") ccCapitalMin += car * overlapMin;
 else cspCapitalMin += car * overlapMin;
 const expStr = pos.expirationDate.split("T")[0].slice(5);
 contributors.push({
 label:`${pos.ticker.symbol} ${pos.status} ${pos.side} ${pos.optionType} $${pos.strikePrice} exp ${expStr} ×${pos.contracts}`,
 capitalAtRisk: car,
 overlapMin,
 optionType: pos.optionType,
 });
 }
 }
 const capitalDeployed = capitalMin / tradingDurationMin;
 const ccDeployed = ccCapitalMin / tradingDurationMin;
 const cspDeployed = cspCapitalMin / tradingDurationMin;
 const utilization = capitalDeployed / basis;
 series.push({ dayMs, utilization, basis, capitalDeployed, ccDeployed, cspDeployed, tradingDurationMin, contributors });
 totalCapitalMinutes += capitalMin;
 totalBasisMinutes += basis * tradingDurationMin;
 }
 }

 dayMs += DAY_MS;
 }

 const overallRate = totalBasisMinutes > 0 ? (totalCapitalMinutes / totalBasisMinutes) * 100 : null;
 // Absolute-dollar scale: the tallest of (basis, deployed) across all days sets the
 // track height, so each bar's gray background encodes the basis in effect that day
 // (it steps at capital adjustments) while over-deployed days still overflow their gray.
 const absMax = Math.max(1, ...series.map((d) => Math.max(d.basis, d.capitalDeployed)));
 // Basis on the most recent trading day — used for the faded future bars.
 const currentBasis = series.length > 0 ? series[series.length - 1].basis : 0;

 return { series, overallRate, absMax, currentBasis };
 }, [openPositions, closedPositions, settings, capitalChanges]);

 const chartContainerRef = useRef<HTMLDivElement>(null);
 const [chartWidth, setChartWidth] = useState(0);
 useEffect(() => {
 const el = chartContainerRef.current;
 if (!el) return;
 const ro = new ResizeObserver(entries => setChartWidth(Math.floor(entries[0].contentRect.width)));
 ro.observe(el);
 return () => ro.disconnect();
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [utilizationDataTrading != null]);

 // Pre-compute display bars (past trading days + future bars to fill available width)
 // with x positions that include a 2px gap at each week boundary.
 const displayBars = useMemo(() => {
 if (!utilizationDataTrading || chartWidth === 0) return null;
 const td = utilizationDataTrading;
 const BAR_W = 5, GAP = 2, DAY_MS = 86_400_000;
 type Bar = { dayMs: number; seriesIdx: number | null; utilization: number; basis: number; isFuture: boolean; x: number };
 const bars: Bar[] = [];
 let x = 0;

 for (let i = 0; i < td.series.length; i++) {
 const s = td.series[i];
 // Gap before any bar that is ≥3 calendar days after the previous bar — this
 // correctly marks week boundaries even when Monday is a market holiday.
 if (i > 0 && s.dayMs - td.series[i - 1].dayMs >= 3 * DAY_MS) x += GAP;
 bars.push({ dayMs: s.dayMs, seriesIdx: i, utilization: s.utilization, basis: s.basis, isFuture: false, x });
 x += BAR_W;
 }

 let prevDayMs = td.series.length > 0 ? td.series.at(-1)!.dayMs : null;
 let dayMs = td.series.length > 0 ? td.series.at(-1)!.dayMs + DAY_MS : Date.now();
 while (dayMs < Date.now() + 400 * DAY_MS) {
 if (!isNonTradingDay(dayMs)) {
 const gap = prevDayMs !== null && dayMs - prevDayMs >= 3 * DAY_MS ? GAP : 0;
 if (x + gap + BAR_W > chartWidth) break;
 x += gap;
 bars.push({ dayMs, seriesIdx: null, utilization: 0, basis: td.currentBasis, isFuture: true, x });
 prevDayMs = dayMs;
 x += BAR_W;
 }
 dayMs += DAY_MS;
 }

 return { bars, vbWidth: x };
 }, [utilizationDataTrading, chartWidth]);

 const [hoveredBarIdxTrading, setHoveredBarIdxTrading] = useState<number | null>(null);
 const [showUtilModal, setShowUtilModal] = useState(false);

 const handleChartMouseMoveTrading = (e: React.MouseEvent<SVGSVGElement>) => {
 if (!displayBars) return;
 const { bars } = displayBars;
 const rect = e.currentTarget.getBoundingClientRect();
 const xVB = e.clientX - rect.left;
 const bar = bars.find(b => xVB >= b.x && xVB < b.x + 5);
 setHoveredBarIdxTrading(bar && !bar.isFuture ? bar.seriesIdx : null);
 };


 const totalCapitalAtRisk = openPositions.reduce((sum, p) => {
 return sum + calcPosition(p).capitalAtRisk;
 }, 0);

 // Basis in effect today (starting basis + applied adjustments) drives capital available.
 const currentBasis = computeCurrentBasis(settings, capitalChanges);

 const cumulativePremium = closedPositions.reduce((sum, p) => {
 const c = calcPosition(p);
 return sum + (c.pnl ?? 0);
 }, 0);

 // Annualized rate: cumulative pnl / basis over time elapsed since the starting week.
 // When capital changes exist, the period is split at each change date and each sub-period
 // is weighted by its own basis so deposits/withdrawals don't distort past returns.
 const annReturnFirstDate = (() => {
 if (settings?.startingWeek) {
 return getWeekStart(new Date(settings.startingWeek +"T12:00:00")).getTime();
 }
 const allDates = closedPositions.map((p) => new Date(p.openedAt).getTime());
 return allDates.length > 0 ? Math.min(...allDates) : null;
 })();

 // Benchmark total return (S&P 500 TR + Nasdaq Composite) over the same window as
 // the account's marked return, for side-by-side comparison.
 const benchmarkStartStr = annReturnFirstDate != null
 ? new Date(annReturnFirstDate).toISOString().slice(0, 10)
 : null;
 const { data: benchmarkData } = useApi(
 () => benchmarkStartStr ? getOptionsBenchmark(benchmarkStartStr) : Promise.resolve({ benchmarks: [] }),
 [benchmarkStartStr]
 );
 // Benchmark card pagination: measure one page's height so the vertical-slide
 // carousel can translate by exact pixels (all pages share the same structure).
 const [benchPage, setBenchPage] = useState(0);
 const benchTrackRef = useRef<HTMLDivElement>(null);
 const [benchPageH, setBenchPageH] = useState(0);
 useLayoutEffect(() => {
 const first = benchTrackRef.current?.children[0] as HTMLElement | undefined;
 if (first) setBenchPageH(first.offsetHeight);
 }, [benchmarkData]);

 const annReturn = (() => {
 if (!settings?.startingBasis || cumulativePremium === 0 || annReturnFirstDate == null) return null;
 const totalElapsedDays = (Date.now() - annReturnFirstDate) / 86_400_000;
 if (totalElapsedDays < 1) return null;

 // No capital changes — use original simple formula
 const changesAfterStart = capitalChanges.filter(
 (c) => new Date(c.effectiveDate +"T12:00:00").getTime() > annReturnFirstDate
 );
 if (changesAfterStart.length === 0) {
 return (cumulativePremium / settings.startingBasis) * (365 / totalElapsedDays) * 100;
 }

 // Build sub-period boundaries sorted by date
 const sorted = [...changesAfterStart].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
 const periods: { startMs: number; basis: number }[] = [
 // Number(): startingBasis is a string at runtime (Prisma Decimal); without it
 // `prevBasis + Number(delta)` string-concats into a billion-dollar basis.
 { startMs: annReturnFirstDate, basis: Number(settings.startingBasis) },
];
 for (const c of sorted) {
 const changeMs = new Date(c.effectiveDate +"T12:00:00").getTime();
 const prevBasis = periods[periods.length - 1].basis;
 periods.push({ startMs: changeMs, basis: prevBasis + Number(c.delta) });
 }

 // Sum premium earned in each sub-period weighted by that period's basis
 let totalWeightedReturn = 0;
 for (let i = 0; i < periods.length; i++) {
 const periodStart = periods[i].startMs;
 const periodEnd = i + 1 < periods.length ? periods[i + 1].startMs : Date.now();
 const periodBasis = periods[i].basis;
 if (periodBasis <= 0) continue;

 const periodPremium = closedPositions.reduce((sum, p) => {
 const closeMs = p.closedAt
 ? new Date(p.closedAt).getTime()
 : new Date(p.expirationDate).getTime();
 if (closeMs >= periodStart && closeMs < periodEnd) {
 return sum + (calcPosition(p).pnl ?? 0);
 }
 return sum;
 }, 0);
 totalWeightedReturn += periodPremium / periodBasis;
 }

 return totalWeightedReturn * (365 / totalElapsedDays) * 100;
 })();

 // Live P&L of open positions (mark-to-market against current premium).
 // Matches the per-row livePnl used in OpenPositionsTable's footer.
 const totalLivePnl = openPositions.reduce<number | null>((acc, p) => {
 const curPrem = p.currentPremiumPerShare ?? null;
 if (curPrem == null || p.excludeFromLivePnl) return acc;
 const pnl = (p.premiumPerShare - curPrem) * 100 * p.contracts - (p.feesOpen ?? 0);
 return (acc ?? 0) + pnl;
 }, null);

 // Total current return: realized premium + live P&L of open positions +
 // underlying P&L (realized + unrealized from assigned lots).
 const totalMarkedPnl =
 cumulativePremium + (totalLivePnl ?? 0) + (totalUnrealizedPnl ?? 0) + (totalRealizedPnl ?? 0);

 // % return on the capital base, as a true time-weighted return.
 // We chain per-period returns split at each basis adjustment. Each period's NAV
 // is pinned at its boundaries using the stored mark-to-market snapshot, so a
 // deposit is treated as a flow (never a gain) and the % always shares the sign
 // of the dollar figure. Requires every boundary to carry a snapshot; otherwise
 // (older rows / market data unavailable) we fall back to a plain ratio.
 const markedReturnPct = (() => {
 if (!settings?.startingBasis || annReturnFirstDate == null) return null;

 const currentBasis = computeCurrentBasis(settings, capitalChanges);
 const fallback = () =>
 currentBasis != null && currentBasis > 0 ? (totalMarkedPnl / currentBasis) * 100 : null;

 const boundaries = capitalChanges
 .filter((c) => new Date(c.effectiveDate +"T12:00:00").getTime() > annReturnFirstDate)
 .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

 // No adjustments → plain markedPnl / startingBasis (== fallback on starting basis).
 if (boundaries.length === 0) {
 return settings.startingBasis > 0 ? (totalMarkedPnl / settings.startingBasis) * 100 : null;
 }
 // Any boundary missing its NAV snapshot → can't chain accurately; fall back.
 if (boundaries.some((c) => c.unrealizedSnapshot == null)) return fallback();

 // Current unrealized mark (open-option live P&L + assigned-share unrealized).
 // Realized dispositions are attributed by sale date below, not counted here.
 const uNow = (totalLivePnl ?? 0) + (totalUnrealizedPnl ?? 0);

 // Periods: each starts at a boundary (or the window start) and carries the
 // basis in effect and the unrealized mark at its start (0 before any holdings).
 const periods: { startMs: number; basis: number; uStart: number }[] = [
 // Number(): startingBasis arrives as a string (Prisma Decimal), so without
 // coercion `prev.basis + delta` would string-concat into a billion-dollar basis.
 { startMs: annReturnFirstDate, basis: Number(settings.startingBasis), uStart: 0 },
 ];
 for (const c of boundaries) {
 const changeMs = new Date(c.effectiveDate +"T12:00:00").getTime();
 const prev = periods[periods.length - 1];
 periods.push({ startMs: changeMs, basis: prev.basis + Number(c.delta), uStart: Number(c.unrealizedSnapshot) });
 }

 const realizedInRange = (startMs: number, endMs: number) => {
 const premium = closedPositions.reduce((sum, p) => {
 const closeMs = p.closedAt
 ? new Date(p.closedAt).getTime()
 : new Date(p.expirationDate).getTime();
 return closeMs >= startMs && closeMs < endMs ? sum + (calcPosition(p).pnl ?? 0) : sum;
 }, 0);
 const disp = realizedRows.reduce((sum, r) => {
 const saleMs = new Date(r.saleDate +"T12:00:00").getTime();
 return saleMs >= startMs && saleMs < endMs ? sum + r.realizedPnl : sum;
 }, 0);
 return premium + disp;
 };

 // We assume premium and capital gains are withdrawn rather than left to
 // compound, so each period's return is measured against the contributed basis
 // in effect — prior gains never inflate a later period's denominator.
 let chained = 1;
 for (let i = 0; i < periods.length; i++) {
 const periodStart = periods[i].startMs;
 const periodEnd = i + 1 < periods.length ? periods[i + 1].startMs : Date.now();
 const uStart = periods[i].uStart;
 const uEnd = i + 1 < periods.length ? periods[i + 1].uStart : uNow;

 // Period gain = realized cash in the window + change in unrealized mark.
 const gain = realizedInRange(periodStart, periodEnd) + (uEnd - uStart);
 const basis = periods[i].basis;
 if (basis > 0) chained *= 1 + gain / basis;
 }

 return (chained - 1) * 100;
 })();

 return (
 <>
 <div className="grid grid-cols-4 gap-4">
 {/* Capital at Risk */}
 <Card className="p-6">
 <SectionLabel>Capital at Risk</SectionLabel>
 <div className="flex items-end mt-1">
 <div className="flex-1 min-w-0">
 <p className="tp-stat truncate">
 {totalCapitalAtRisk > 0 ?`$${totalCapitalAtRisk.toLocaleString("en-US", { maximumFractionDigits: 0 })}` :"—"}
 </p>
 <p className="tp-caption mt-0.5 truncate">
 {openPositions.length > 0 ?`${openPositions.length} open position${openPositions.length !== 1 ?"s" :""}` :"No open positions"}
 </p>
 </div>
 {currentBasis != null && (
 <>
 <div className="w-px bg-border self-stretch shrink-0" />
 <div className="flex-1 min-w-0 pl-3">
 <p className="tp-stat truncate text-ink-3">
 {`$${(currentBasis - totalCapitalAtRisk).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
 </p>
 <p className="tp-caption mt-0.5">capital available</p>
 </div>
 </>
 )}
 </div>
 </Card>

 {/* Capital Utilization Rate — 3-card-wide module beside Capital at Risk */}
 {utilizationDataTrading && utilizationDataTrading.series.length > 0 && (
 <Card className="p-6 col-span-3 flex items-start">
 <div className="shrink-0 w-1/3">
 <span className="flex items-center gap-1">
 <SectionLabel as="span">Capital Utilization Rate</SectionLabel>
 <button
 onClick={() => setShowUtilModal(true)}
 className="inline-flex items-center text-muted-foreground hover:text-foreground"
 title="How is this calculated?"
 >
 <Info className="h-3 w-3" />
 </button>
 </span>
 <p className="tp-stat mt-1">
 {utilizationDataTrading.overallRate != null ? fmtPct(utilizationDataTrading.overallRate) :"—"}
 </p>
 {settings?.startingWeek && (() => {
 const fmt = (d: Date) => d.toLocaleDateString("en-US", { month:"numeric", day:"numeric", year:"2-digit" });
 const start = getWeekStart(new Date(settings.startingWeek +"T12:00:00"));
 return <p className="tp-caption mt-0.5">{fmt(start)} to {fmt(new Date())}</p>;
 })()}
 </div>
 {/* ref always mounts so ResizeObserver can measure before displayBars computes */}
 <div className="flex-1 relative" ref={chartContainerRef}>
 {displayBars && (
 <svg
 viewBox={`0 0 ${displayBars.vbWidth} 66`}
 width={displayBars.vbWidth}
 height="66"
 onMouseMove={handleChartMouseMoveTrading}
 onMouseLeave={() => setHoveredBarIdxTrading(null)}
 >
 {displayBars.bars.map((bar, i) => {
 const absMax = utilizationDataTrading.absMax;
 // Gray track height encodes the basis in effect that day; fills are deployed dollars.
 const bgH = (bar.basis / absMax) * 66;
 const fillH = bar.isFuture ? 0 : Math.min((bar.utilization * bar.basis / absMax) * 66, 66);
 const isHovered = bar.seriesIdx !== null && hoveredBarIdxTrading === bar.seriesIdx;
 const isOver = bar.utilization > 1;
 const dimmed = hoveredBarIdxTrading !== null && !isHovered;
 const s = bar.seriesIdx !== null ? utilizationDataTrading.series[bar.seriesIdx] : null;
 const cspH = s && !isOver ? Math.min((s.cspDeployed / absMax) * 66, fillH) : 0;
 const ccH = fillH - cspH;
 return (
 <g key={i}>
 <rect x={bar.x} y={66 - bgH} width={5} height={bgH} fill="var(--color-border)" opacity={bar.isFuture ? 0.5 : 1} />
 {!bar.isFuture && fillH > 0 && isOver && (
 <rect x={bar.x} y={66 - fillH} width={5} height={fillH}
 fill="var(--color-warn)" opacity={dimmed ? 0.4 : 1}
 />
 )}
 {!bar.isFuture && !isOver && cspH > 0 && (
 <rect x={bar.x} y={66 - cspH} width={5} height={cspH}
 fill="var(--color-violet)" opacity={dimmed ? 0.4 : 1}
 />
 )}
 {!bar.isFuture && !isOver && ccH > 0 && (
 <rect x={bar.x} y={66 - fillH} width={5} height={ccH}
 fill="var(--color-blue)" opacity={dimmed ? 0.4 : 1}
 />
 )}
 </g>
 );
 })}
 </svg>
 )}
 {displayBars && hoveredBarIdxTrading !== null && utilizationDataTrading.series[hoveredBarIdxTrading] && (() => {
 const bar = utilizationDataTrading.series[hoveredBarIdxTrading];
 const hovBar = displayBars.bars.find(b => b.seriesIdx === hoveredBarIdxTrading)!;
 const leftPx =`${hovBar.x + 2}px`;
 const label = new Date(bar.dayMs).toLocaleDateString("en-US", { month:"short", day:"numeric" });
 return (
 <div
 className="absolute bottom-[calc(100%+6px)] pointer-events-none z-[60] flex flex-col items-center"
 style={{ left: leftPx, transform:"translateX(-50%)" }}
 >
 <div className="rounded border border-border bg-background p-2 text-xs shadow-md whitespace-nowrap">
 <p className="font-medium mb-1">{label} — {(bar.utilization * 100).toFixed(1)}%</p>
 {bar.ccDeployed > 0 && <p style={{ color:"var(--color-blue)" }}>CC: ${Math.round(bar.ccDeployed).toLocaleString()} ({(bar.ccDeployed / bar.basis * 100).toFixed(1)}%)</p>}
 {bar.cspDeployed > 0 && <p style={{ color:"var(--color-violet)" }}>CSP: ${Math.round(bar.cspDeployed).toLocaleString()} ({(bar.cspDeployed / bar.basis * 100).toFixed(1)}%)</p>}
 </div>
 <div className="w-px h-1.5 bg-border" />
 </div>
 );
 })()}
 </div>
 </Card>
 )}
 </div>

 {/* Row 2: cumulative / underlying / marked totals / benchmark */}
 <div className="grid grid-cols-4 gap-4">
 {/* Cumulative Premium — split cumulative total / annualized ROR */}
 <Card className="p-6">
 <div className="flex items-center gap-1.5">
 <SectionLabel as="span">Cumulative Premium</SectionLabel>
 <CardInfoTooltip>
 Premium collected on positions that have been <span className="font-medium text-foreground">closed</span>
 </CardInfoTooltip>
 </div>
 <div className="flex items-end mt-1">
 <div className="flex-1 min-w-0">
 <p className={`tp-stat truncate ${cumulativePremium >= 0 ?"text-up" :"text-down"}`}>
 {`$${fmtUSD(cumulativePremium)}`}
 </p>
 <p className="tp-caption mt-0.5 truncate">
 {annReturnFirstDate != null ?`since ${fmtDateTimeShort(new Date(annReturnFirstDate).toISOString())}` :"—"}
 </p>
 </div>
 <div className="w-px bg-border self-stretch shrink-0" />
 <div className="flex-1 min-w-0 pl-3">
 <p className={`tp-stat truncate ${annReturn != null ? (annReturn >= (settings?.targetReturn ?? 0) * 100 ?"text-up" :"text-warn") :""}`}>
 {annReturn != null ? fmtPct(annReturn) :"—"}
 </p>
 <p className="tp-caption mt-0.5">Annualized ROR</p>
 </div>
 </div>
 </Card>

 {/* Underlying P&L — unrealized and realized from assigned lots */}
 <Card className="p-6">
 <div className="flex items-center gap-1.5">
 <SectionLabel as="span">Underlying P&L</SectionLabel>
 <CardInfoTooltip>
 Current gain or loss of shares that have been assigned from a put
 </CardInfoTooltip>
 </div>
 <div className="flex items-end mt-1">
 <div className="flex-1 min-w-0">
 <p className={`tp-stat truncate ${totalUnrealizedPnl != null && totalUnrealizedPnl !== 0 ? (totalUnrealizedPnl >= 0 ?"text-up" :"text-down") :""}`}>
 {totalUnrealizedPnl != null
 ?`${totalUnrealizedPnl >= 0 ?"+" :"−"}$${fmtUSD(Math.abs(totalUnrealizedPnl))}`
 :"—"}
 </p>
 <p className="tp-caption mt-0.5">Unrealized</p>
 </div>
 <div className="w-px bg-border self-stretch shrink-0" />
 <div className="flex-1 min-w-0 pl-3">
 <p className={`tp-stat truncate ${totalRealizedPnl != null && totalRealizedPnl !== 0 ? (totalRealizedPnl >= 0 ?"text-up" :"text-down") :""}`}>
 {totalRealizedPnl != null
 ?`${totalRealizedPnl >= 0 ?"+" :"−"}$${fmtUSD(Math.abs(totalRealizedPnl))}`
 :"—"}
 </p>
 <p className="tp-caption mt-0.5">Realized</p>
 </div>
 </div>
 </Card>

 {/* Total Marked P&L — total current return / time-weighted % on basis */}
 <Card className="p-6">
 <div className="flex items-center gap-1.5">
 <SectionLabel as="span">Total Marked P&L</SectionLabel>
 <CardInfoTooltip>
 Rollup of premium collected, current P&L of open positions, and total P&L of underlying shares. Positions flagged <span className="font-medium text-foreground">Exclude from Total Live P&L</span> in their edit modal are left out of the open-position mark. The % is a <span className="font-medium text-foreground">time-weighted return on basis</span> (chained across any basis adjustments so deposits aren't counted as gains) and is <span className="font-medium text-foreground">not</span> annualized.
 {capitalChanges.some((c) => c.snapshotExcludesOptions) && (
 <span className="block mt-1">Note: a back-dated basis adjustment valued only assigned shares at that date, excluding open-option P&L.</span>
 )}
 </CardInfoTooltip>
 </div>
 <div className="flex items-end mt-1">
 <div className="flex-1 min-w-0">
 <p className={`tp-stat truncate ${totalMarkedPnl !== 0 ? (totalMarkedPnl >= 0 ?"text-up" :"text-down") :""}`}>
 {`${totalMarkedPnl >= 0 ?"+" :"−"}$${fmtUSD(Math.abs(totalMarkedPnl))}`}
 </p>
 <p className="tp-caption mt-0.5">Total current return</p>
 </div>
 <div className="w-px bg-border self-stretch shrink-0" />
 <div className="flex-1 min-w-0 pl-3">
 <p className={`tp-stat truncate ${markedReturnPct != null && markedReturnPct !== 0 ? (markedReturnPct >= 0 ?"text-up" :"text-down") :""}`}>
 {markedReturnPct != null ? fmtPct(markedReturnPct) :"—"}
 </p>
 <p className="tp-caption mt-0.5">Return on basis</p>
 </div>
 </div>
 </Card>

 {/* Benchmark Performance — paginated total return of 4 indices since start date */}
 <Card className="p-6">
 <div className="flex items-center gap-1.5">
 <SectionLabel as="span">Benchmark Performance</SectionLabel>
 <CardInfoTooltip>
 Compare performance since your start date to the S&P 500 (<span className="font-medium text-foreground">^SP500TR</span>), Nasdaq Composite (<span className="font-medium text-foreground">^IXIC</span>), CBOE PutWrite (<span className="font-medium text-foreground">^PUT</span>), and BuyWrite (<span className="font-medium text-foreground">^BXM</span>) indices.
 </CardInfoTooltip>
 </div>
 {(() => {
 const pct = (symbol: string) => benchmarkData?.benchmarks.find((b) => b.symbol === symbol)?.pctChange ?? null;
 const cls = (v: number | null) => v != null && v !== 0 ? (v >= 0 ?"text-up" :"text-down") :"";
 const renderStat = (symbol: string, label: string, padLeft: boolean) => {
 const v = pct(symbol);
 return (
 <div className={cn("flex-1 min-w-0", padLeft &&"pl-3")}>
 <p className={`tp-stat truncate ${cls(v)}`}>{v != null ? fmtPct(v) :"—"}</p>
 <p className="tp-caption mt-0.5 whitespace-nowrap">{label}</p>
 </div>
 );
 };
 return (
 <>
 {/* Even split like the other cards; the centered chevron floats over the gutter */}
 <div className="overflow-hidden mt-1" style={{ height: benchPageH || undefined }}>
 <div
 ref={benchTrackRef}
 className="transition-transform duration-300 ease-out"
 style={{ transform:`translateY(-${benchPage * benchPageH}px)` }}
 >
 {BENCHMARK_LAYOUT.map((pair, i) => (
 <div key={i} className="flex items-end">
 {renderStat(pair[0].symbol, pair[0].label, false)}
 <div className="w-px bg-border self-stretch shrink-0" />
 {renderStat(pair[1].symbol, pair[1].label, true)}
 </div>
 ))}
 </div>
 </div>
 {/* Single toggle chevron, vertically centered in the whole card */}
 <button
 type="button"
 onClick={() => setBenchPage((p) => (p === 0 ? 1 : 0))}
 className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors"
 aria-label={benchPage === 0 ?"Show more benchmarks" :"Show previous benchmarks"}
 >
 {benchPage === 0
 ? <ChevronDown className="h-3.5 w-3.5" />
 : <ChevronUp className="h-3.5 w-3.5" />}
 </button>
 </>
 );
 })()}
 </Card>
 </div>

 {showUtilModal && (
 <div
 className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
 onClick={() => setShowUtilModal(false)}
 >
 <div
 className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-xl"
 onClick={(e) => e.stopPropagation()}
 >
 <button
 onClick={() => setShowUtilModal(false)}
 className="absolute right-4 top-4 rounded-sm p-1 text-muted-foreground opacity-70 hover:opacity-100 hover:bg-muted"
 >
 <X className="h-4 w-4" />
 </button>

 <h3 className="mb-1 tp-panel-title">How Capital Utilization Rate is calculated</h3>
 <p className="mb-5 tp-caption">
 Measures how actively your available options capital was deployed in positions, counting only NYSE trading hours (9:30 AM – 4:00 PM ET, excluding weekends and market holidays).
 </p>

 <div className="space-y-5">
 <section>
 <h4 className="mb-1.5 font-semibold text-foreground">The formula</h4>
 <p className="text-muted-foreground leading-relaxed">
 For each trading day: (Σ capital × minutes deployed per position) ÷ (available basis × trading minutes that day). The overall percentage aggregates this ratio across the full period since your Starting Week.
 </p>
 </section>

 <section>
 <h4 className="mb-1.5 font-semibold text-foreground">Available basis</h4>
 <p className="text-muted-foreground leading-relaxed">
 Uses your Starting Basis from Settings, adjusted over time by any dated Basis Adjustments you've recorded. Each bar's gray background is scaled to the basis in effect that day, so the track steps up or down when you record an adjustment.
 </p>
 </section>

 <section>
 <h4 className="mb-1.5 font-semibold text-foreground">Above 100%</h4>
 <p className="text-muted-foreground leading-relaxed">
 A day exceeds 100% when capital deployed exceeds your available basis — for example, when using margin. The colored fill rises above its gray track and the bar appears in amber.
 </p>
 </section>
 </div>
 </div>
 </div>
 )}
 </>
 );
}

// ── Option Screener ────────────────────────────────────────────────────────────

const DEFAULT_PARAMS: ScreenerParams = {
 tickers: [],
 optionType:"PUT",
 minDTE: 0,
 maxDTE: 7,
 minDelta: 0.10,
 maxDelta: 0.30,
 minOI: undefined,
 minVolume: undefined,
};

function OptionScreener({ trackedTickers, holdingTickers, recentTickers, onDraftCreated }: {
 trackedTickers: OptionsTicker[];
 holdingTickers: string[];
 recentTickers: string[];
 onDraftCreated: (ticker: string, underlyingPrice: number | null) => void;
}) {
 const [isOpen, setIsOpen] = useState(false);
 const [params, setParams] = useState<ScreenerParams>(DEFAULT_PARAMS);
 const [tickerInput, setTickerInput] = useState("");
 const [results, setResults] = useState<ScreenerResult[] | null>(null);
 const [earningsMap, setEarningsMap] = useState<Record<string, EarningsInfo | null>>({});
 const [highlightedRows, setHighlightedRows] = useState<Set<number>>(new Set());
 const [contractsMap, setContractsMap] = useState<Map<number, number>>(new Map());
 const [addingRow, setAddingRow] = useState<number | null>(null);
 const [addedRows, setAddedRows] = useState<Set<number>>(new Set());
 const [loading, setLoading] = useState(false);
 const [error, setError] = useState<string | null>(null);

 const setParam = <K extends keyof ScreenerParams>(k: K, v: ScreenerParams[K]) =>
 setParams((p) => ({ ...p, [k]: v }));

 const addTicker = (sym: string) => {
 const upper = sym.trim().toUpperCase();
 if (!upper || params.tickers.includes(upper)) return;
 setParam("tickers", [...params.tickers, upper]);
 setTickerInput("");
 };

 const removeTicker = (sym: string) =>
 setParam("tickers", params.tickers.filter((t) => t !== sym));

 const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
 if (e.key ==="Enter" || e.key ===",") {
 e.preventDefault();
 addTicker(tickerInput);
 }
 };

 const handleRun = async () => {
 if (params.tickers.length === 0) return;
 setLoading(true);
 setError(null);
 setResults(null);
 try {
 const data = await runOptionsScreener(params);
 setResults(data);
 setHighlightedRows(new Set());
 setContractsMap(new Map());
 setAddedRows(new Set());
 // Non-blocking: results render regardless of whether earnings resolve.
 getOptionsEarnings(params.tickers, localToday())
 .then(setEarningsMap)
 .catch(() => setEarningsMap({}));
 } catch (e) {
 setError(e instanceof Error ? e.message :"Screener failed");
 } finally {
 setLoading(false);
 }
 };

 const handleAddDraft = async (r: ScreenerResult, rowIdx: number) => {
 const contracts = contractsMap.get(rowIdx) ?? 1;
 setAddingRow(rowIdx);
 try {
 let ticker = trackedTickers.find((t) => t.symbol === r.ticker);
 if (!ticker) {
 ticker = await createOptionsTicker({ symbol: r.ticker });
 }
 await createOptionsPosition({
 tickerId: ticker.id,
 optionType: r.optionType,
 strikePrice: r.strike,
 expirationDate: r.expiration,
 openedAt: new Date().toISOString(),
 contracts,
 premiumPerShare: r.last ?? 0,
 currentPremiumPerShare: r.last ?? undefined,
 stockPriceAtOpen: r.underlyingPrice ?? undefined,
 deltaAtOpen: r.delta ?? undefined,
 deltaAtOpenCapturedAt: new Date().toISOString(),
 isDraft: true,
 });
 setAddedRows((prev) => new Set(prev).add(rowIdx));
 onDraftCreated(r.ticker, r.underlyingPrice);
 } catch {
 // leave button in normal state; user can retry
 } finally {
 setAddingRow(null);
 }
 };

 // Results arrive sorted ticker → expiration → strike, so the first row whose
 // expiry clears the earnings call is where that ticker's warning belongs —
 // every row below it carries the same risk.
 const earningsBanners = useMemo(() => {
 const banners = new Map<number, EarningsInfo>();
 if (!results) return banners;
 const flagged = new Set<string>();
 results.forEach((r, i) => {
 if (flagged.has(r.ticker)) return;
 const e = earningsMap[r.ticker.toUpperCase()] ?? null;
 if (!earningsBeforeExpiry(e, r.expiration)) return;
 flagged.add(r.ticker);
 banners.set(i, e!);
 });
 return banners;
 }, [results, earningsMap]);

 const suggestedHoldingTickers = holdingTickers.filter((s) => !params.tickers.includes(s));
 const suggestedRecentTickers = recentTickers.filter((s) => !params.tickers.includes(s));

 return (
 <Card>
 {/* Header */}
 <button
 type="button"
 className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted transition-colors rounded-t-lg"
 onClick={() => setIsOpen((o) => !o)}
 >
 <div className="flex items-center gap-2">
 <ScanSearch className="h-4 w-4 text-muted-foreground" />
 <SectionLabel as="span">Option Screener</SectionLabel>
 {results != null && !loading && (
 <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-xs px-1.5 py-0.5 font-medium">
 {results.length} result{results.length !== 1 ?"s" :""}
 </span>
 )}
 </div>
 {isOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
 </button>

 {isOpen && (
 <div className="border-t border-border">
 {/* Filter controls */}
 <div className="px-4 py-4 space-y-4">
 {/* Tickers */}
 <div>
 <div className="flex items-center justify-between mb-1">
 <label>Tickers</label>
 {params.tickers.length > 0 && (
 <label className="text-right">
 Screening {params.tickers.length} ticker{params.tickers.length !== 1 ?"s" :""} — one API call per expiration date.
 </label>
 )}
 </div>
 <div className="flex flex-wrap gap-1.5 items-center min-h-[38px] rounded-md border border-border bg-[rgba(255,255,255,0.78)] shadow-[var(--shadow-input)] px-3 py-2 focus-within:border-primary focus-within:shadow-[var(--shadow-focus-ring)] transition-[border-color,box-shadow] duration-[120ms]">
 {params.tickers.map((sym) => (
 <span key={sym} className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
 {sym}
 <button type="button" onClick={() => removeTicker(sym)} className="hover:text-down transition-colors">
 <X className="h-3 w-3" />
 </button>
 </span>
 ))}
 <input
 value={tickerInput}
 onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
 onKeyDown={handleKeyDown}
 onBlur={() => tickerInput && addTicker(tickerInput)}
 placeholder={params.tickers.length === 0 ?"Type ticker + Enter…" :""}
 className="flex-1 min-w-[100px] outline-none placeholder:text-muted-foreground"
 style={{ background:"transparent", border:"none", boxShadow:"none", borderRadius: 0, padding: 0 }}
 />
 </div>
 {/* Quick-add: current holdings (uncovered), then recently traded */}
 {(suggestedHoldingTickers.length > 0 || suggestedRecentTickers.length > 0) && (
 <div className="flex flex-wrap items-center gap-1 pt-2">
 {suggestedHoldingTickers.map((sym) => (
 <button
 key={sym}
 type="button"
 onClick={() => addTicker(sym)}
 className="rounded border border-border px-1.5 py-0.5 tp-caption hover:border-primary hover:text-primary transition-colors"
 >
 + {sym}
 </button>
 ))}
 {suggestedHoldingTickers.length > 0 && suggestedRecentTickers.length > 0 && (
 <span className="h-4 w-px bg-border mx-1" />
 )}
 {suggestedRecentTickers.map((sym) => (
 <button
 key={sym}
 type="button"
 onClick={() => addTicker(sym)}
 className="rounded border border-border px-1.5 py-0.5 tp-caption hover:border-primary hover:text-primary transition-colors"
 >
 + {sym}
 </button>
 ))}
 </div>
 )}
 </div>

 {/* Row: option type + DTE + delta + OI + volume + strike (single ticker) */}
 <div className="flex flex-wrap items-end gap-6">
 {/* Option Type */}
 <div>
 <label className="block text-xs font-medium mb-1">Type</label>
 <div className="flex gap-1">
 {(["PUT","CALL","BOTH"] as const).map((t) => (
 <button
 key={t}
 type="button"
 onClick={() => setParam("optionType", t)}
 className={cn(
"rounded px-3 py-2 font-medium border transition-colors",
 params.optionType === t
 ?"bg-primary text-primary-foreground border-primary"
 :"border-border text-muted-foreground hover:border-primary hover:text-primary"
 )}
 >
 {t ==="BOTH" ?"Both" : t}
 </button>
 ))}
 </div>
 </div>

 {/* DTE */}
 <div>
 <div className="flex items-baseline gap-2 mb-1">
 <label className="text-xs font-medium">DTE Range</label>
 {(params.minDTE != null || params.maxDTE != null) && (
 <button
 type="button"
 onClick={() => { setParam("minDTE", undefined); setParam("maxDTE", undefined); }}
 className="text-xs text-primary hover:text-primary/80 transition-colors"
 >
 clear
 </button>
 )}
 </div>
 <div className="flex items-center gap-1.5">
 <input
 type="number"
 value={params.minDTE ?? ""}
 min={0}
 onFocus={(e) => e.target.select()}
 onChange={(e) => { const v = e.target.value; setParam("minDTE", v === "" ? undefined : Math.max(0, parseInt(v) || 0)); }}
 className="w-16 rounded-md border border-border bg-background px-3 py-2 text-center [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
 />
 <span className="text-muted-foreground text-xs shrink-0">–</span>
 <input
 type="number"
 value={params.maxDTE ?? ""}
 min={0}
 onFocus={(e) => e.target.select()}
 onChange={(e) => { const v = e.target.value; setParam("maxDTE", v === "" ? undefined : Math.max(0, parseInt(v) || 0)); }}
 className="w-16 rounded-md border border-border bg-background px-3 py-2 text-center [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
 />
 </div>
 </div>

 {/* Delta */}
 <div>
 <div className="flex items-baseline gap-2 mb-1">
 <label className="text-xs font-medium">Delta Range</label>
 {(params.minDelta != null || params.maxDelta != null) && (
 <button
 type="button"
 onClick={() => { setParam("minDelta", undefined); setParam("maxDelta", undefined); }}
 className="text-xs text-primary hover:text-primary/80 transition-colors"
 >
 clear
 </button>
 )}
 </div>
 <div className="flex items-center gap-1.5">
 <input
 type="number"
 value={params.minDelta ?? ""}
 min={0}
 max={1}
 step={0.01}
 onFocus={(e) => e.target.select()}
 onChange={(e) => { const v = e.target.value; setParam("minDelta", v === "" ? undefined : Math.min(1, Math.max(0, parseFloat(v) || 0))); }}
 className="w-16 rounded-md border border-border bg-background px-3 py-2 text-center [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
 />
 <span className="text-muted-foreground text-xs shrink-0">–</span>
 <input
 type="number"
 value={params.maxDelta ?? ""}
 min={0}
 max={1}
 step={0.01}
 onFocus={(e) => e.target.select()}
 onChange={(e) => { const v = e.target.value; setParam("maxDelta", v === "" ? undefined : Math.min(1, Math.max(0, parseFloat(v) || 0))); }}
 className="w-16 rounded-md border border-border bg-background px-3 py-2 text-center [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
 />
 </div>
 </div>

 {/* Strike Price — only when exactly 1 ticker */}
 {params.tickers.length === 1 && (
 <div>
 <div className="flex items-baseline gap-2 mb-1">
 <label className="text-xs font-medium">Strike Price</label>
 {(params.strikeMin != null || params.strikeMax != null) && (
 <button
 type="button"
 onClick={() => { setParam("strikeMin", undefined); setParam("strikeMax", undefined); }}
 className="text-xs text-primary hover:text-primary/80 transition-colors"
 >
 clear
 </button>
 )}
 </div>
 <div className="flex items-center gap-1.5">
 <input
 type="number"
 value={params.strikeMin ?? ""}
 min={0}
 step={0.5}
 placeholder="min"
 onFocus={(e) => e.target.select()}
 onChange={(e) => { const v = e.target.value; setParam("strikeMin", v === "" ? undefined : Math.max(0, parseFloat(v) || 0)); }}
 className="w-16 rounded-md border border-border bg-background px-3 py-2 text-center [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
 />
 <span className="text-muted-foreground text-xs shrink-0">–</span>
 <input
 type="number"
 value={params.strikeMax ?? ""}
 min={0}
 step={0.5}
 placeholder="max"
 onFocus={(e) => e.target.select()}
 onChange={(e) => { const v = e.target.value; setParam("strikeMax", v === "" ? undefined : Math.max(0, parseFloat(v) || 0)); }}
 className="w-16 rounded-md border border-border bg-background px-3 py-2 text-center [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
 />
 </div>
 </div>
 )}

 {/* Run button — pushed to the right end of the filter row */}
 <div className="flex items-end ml-auto">
 <Button
 onClick={handleRun}
 disabled={loading || params.tickers.length === 0}
 >
 <Search className="h-4 w-4" />
 {loading ?"Scanning…" :"Run Screener"}
 </Button>
 </div>
 </div>
 </div>

 {/* Results */}
 {error && (
 <div className="mx-4 mb-4 rounded-md border border-down/30 bg-down/10 px-3 py-2 text-down">
 {error}
 </div>
 )}

 {results != null && !loading && (
 results.length === 0 ? (
 <div className="px-4 pb-4 text-muted-foreground">
 No options matched your filters.
 </div>
 ) : (
 <div className="overflow-x-auto border-t border-border mt-2">
 <table className="w-full text-13">
 <thead>
 <tr className="border-b border-border">
 <th className="pl-4 pr-2 py-2 text-left tp-table-header whitespace-nowrap">Ticker</th>
 <th className="px-2 py-2 text-left tp-table-header whitespace-nowrap">Type</th>
 <th className="px-2 py-2 text-left tp-table-header whitespace-nowrap">Exp</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">DTE</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">Strike</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">Underlying</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">% to Strike</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">Delta</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">IV</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">Last</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">Bid / Ask</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">Ann. Return</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">OI</th>
 <th className="px-2 py-2 text-right tp-table-header whitespace-nowrap">Volume</th>
 <th className="px-2 py-2 text-center tp-table-header whitespace-nowrap">Contracts</th>
 <th className="px-2 py-2"></th>
 </tr>
 </thead>
 <tbody>
 {results.map((r, i) => {
 const pctToStrike = r.underlyingPrice != null
 ? ((r.strike - r.underlyingPrice) / r.underlyingPrice) * 100
 : null;
 const annReturnDenominator = r.optionType ==="CALL"
 ? r.underlyingPrice
 : r.strike;
 const annReturn = r.last != null && r.last > 0 && r.dte > 0 && annReturnDenominator != null && annReturnDenominator > 0
 ? (r.last / annReturnDenominator) * (365 / r.dte) * 100
 : null;
 const isHighlighted = highlightedRows.has(i);
 const toggleHighlight = () =>
 setHighlightedRows((prev) => {
 const next = new Set(prev);
 if (next.has(i)) next.delete(i); else next.add(i);
 return next;
 });
 const banner = earningsBanners.get(i);
 return (
 <React.Fragment key={i}>
 {banner && (
 <tr className="border-b border-border bg-row-warn">
 <td colSpan={16} className="px-4 py-2">
 <div className="flex items-center gap-2 text-xs text-warn-deep">
 <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
 <span>Warning: {earningsWarningText(banner)}</span>
 </div>
 </td>
 </tr>
 )}
 <tr
 onClick={toggleHighlight}
 className={cn(
"border-b border-border transition-colors whitespace-nowrap cursor-pointer",
 isHighlighted ?"bg-primary/10 hover:bg-primary/15" :"hover:bg-muted"
 )}
 >
 <td className="pl-4 pr-2 py-2 font-bold font-mono">{r.ticker}</td>
 <td className="px-2 py-2">
 <span className={cn(
"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
 r.optionType ==="PUT" ?"bg-violet-soft text-violet-deep" :"bg-blue-soft text-blue-deep"
 )}>
 {r.optionType}
 </span>
 </td>
 <td className="px-2 py-2 text-muted-foreground">{fmtDate(r.expiration)}</td>
 <td className="px-2 py-2 text-right tabular-nums font-mono">{r.dte}d</td>
 <td className="px-2 py-2 text-right tp-numeric">${r.strike.toFixed(2)}</td>
 <td className="px-2 py-2 text-right tabular-nums font-mono text-muted-foreground">
 {r.underlyingPrice != null ?`$${r.underlyingPrice.toFixed(2)}` :"—"}
 </td>
 <td className={cn("px-2 py-2 text-right tabular-nums font-mono", pctToStrike != null && pctToStrike < 0 ?"text-up" : pctToStrike != null && pctToStrike > 0 ?"text-down" :"")}>
 {pctToStrike != null ?`${pctToStrike >= 0 ?"+" :""}${pctToStrike.toFixed(1)}%` :"—"}
 </td>
 <td className={cn("px-2 py-2 text-right tabular-nums font-mono", r.delta != null && Math.abs(r.delta) > 0.5 ?"text-warn" :"")}>
 {r.delta != null ? r.delta.toFixed(3) :"—"}
 </td>
 <td className="px-2 py-2 text-right tabular-nums font-mono text-muted-foreground">
 {r.iv != null ?`${(r.iv * 100).toFixed(1)}%` :"—"}
 </td>
 <td className="px-2 py-2 text-right tp-numeric">
 {r.last != null ?`$${r.last.toFixed(2)}` :"—"}
 </td>
 <td className="px-2 py-2 text-right tabular-nums font-mono text-muted-foreground">
 {r.bid != null ?`$${r.bid.toFixed(2)}` :"—"} / {r.ask != null ?`$${r.ask.toFixed(2)}` :"—"}
 </td>
 <td className={cn("px-2 py-2 text-right tp-numeric", annReturn != null ?"text-up" :"")}>
 {annReturn != null ?`${annReturn.toFixed(1)}%` :"—"}
 </td>
 <td className="px-2 py-2 text-right tabular-nums font-mono text-muted-foreground">
 {r.openInterest != null ? r.openInterest.toLocaleString() :"—"}
 </td>
 <td className="px-2 py-2 text-right tabular-nums font-mono text-muted-foreground">
 {r.volume != null ? r.volume.toLocaleString() :"—"}
 </td>
 <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
 <input
 type="number"
 min={1}
 value={contractsMap.get(i) ?? 1}
 onChange={(e) => {
 const v = Math.max(1, parseInt(e.target.value) || 1);
 setContractsMap((prev) => new Map(prev).set(i, v));
 }}
 className="w-12 rounded border border-border bg-background px-1 py-0.5 text-center [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
 />
 </td>
 <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
 <Tooltip content={addedRows.has(i) ? "Added to drafts" : "Add to drafts"}>
 <button
 type="button"
 disabled={addingRow === i || addedRows.has(i)}
 onClick={() => handleAddDraft(r, i)}
 className={cn(
"p-1.5 rounded transition-colors disabled:cursor-not-allowed",
 addedRows.has(i)
 ?"text-up cursor-default"
 : addingRow === i
 ?"text-muted-foreground/40"
 :"text-muted-foreground/40 hover:text-primary hover:bg-primary/10"
 )}
 >
 {addedRows.has(i)
 ? <BookmarkCheck className="h-3.5 w-3.5" />
 : <BookmarkPlus className="h-3.5 w-3.5" />}
 </button>
 </Tooltip>
 </td>
 </tr>
 </React.Fragment>
 );
 })}
 </tbody>
 </table>
 </div>
 )
 )}
 </div>
 )}
 </Card>
 );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function OptionsTrading() {
 const [tab, setTab] = useState<"open" |"closed">("open");
 const tabBarRef = useRef<HTMLDivElement>(null);
 const [positionModal, setPositionModal] = useState<"new" | OptionsPosition | PositionPrefill | null>(null);
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
 const { data: capitalChanges, refetch: refetchCapitalChanges } = useApi(getOptionsCapitalChanges, []);

 const normalizedPositions = (allPositions ?? []).map(normalizePosition);
 const draftPositions = normalizedPositions.filter((p) => p.isDraft);
 const openPositions = normalizedPositions.filter((p) => p.status ==="OPEN" && !p.isDraft);
 const closedPositions = normalizedPositions.filter((p) => p.status !=="OPEN");

 // Chain metrics for open rolled positions:
 // - chainPnlMap: sum of closed legs' P&L (open leg's live P&L is added at render time)
 // - chainFirstOpenedMap: earliest openedAt across ALL legs (open + closed) in the chain
 // - chainMaxCapitalAtRiskMap: max capitalAtRisk across ALL legs — matches the
 // closed-tab denominator so live ARR doesn't jump when the final leg closes.
 const chainPnlMap = new Map<string, number>();
 const chainFirstOpenedMap = new Map<string, number>();
 const chainMaxCapitalAtRiskMap = new Map<string, number>();
 for (const p of normalizedPositions) {
 if (!p.groupId) continue;
 if (p.status !=="OPEN") {
 const pnl = calcPosition(p).pnl;
 if (pnl != null) chainPnlMap.set(p.groupId, (chainPnlMap.get(p.groupId) ?? 0) + pnl);
 }
 const ms = new Date(p.openedAt).getTime();
 const prevMs = chainFirstOpenedMap.get(p.groupId);
 if (prevMs == null || ms < prevMs) chainFirstOpenedMap.set(p.groupId, ms);
 const car = calcPosition(p).capitalAtRisk;
 const prevCar = chainMaxCapitalAtRiskMap.get(p.groupId);
 if (prevCar == null || car > prevCar) chainMaxCapitalAtRiskMap.set(p.groupId, car);
 }

 const openTickerMap = new Map<string, number>();
 for (const p of openPositions) {
 openTickerMap.set(p.ticker.symbol, (openTickerMap.get(p.ticker.symbol) ?? 0) + p.contracts);
 }

 const tickerColorMap = new Map(
 Array.from(openTickerMap.keys())
 .map((sym, i) => [sym, TICKER_COLORS[i % TICKER_COLORS.length]] as [string, string])
 );

 const tradingWeekLabel = getTradingWeekLabel();
 const tickerEntries = Array.from(openTickerMap.entries());

 // ── Assigned lot prices (shared across SummaryCards, OpenPositionsTable, AssignedSharesCard) ──
 const { data: activeHoldings, refetch: refetchActiveHoldings } = useApi(getActiveAssignedHoldings, []);
 const { data: realizedAssignedData, refetch: refetchRealizedAssigned } = useApi(getRealizedDispositions, []);
 const activeLotTickers = useMemo(
 () => [...new Set((activeHoldings ?? []).map((r) => r.ticker))],
 [activeHoldings]
 );

 // Screener quick-add row 1: current holdings (assigned lots) that still have
 // shares not already tied up as covered-call collateral.
 const uncoveredHoldingTickers = useMemo(() => {
 const byTicker = new Map<string, { shares: number; covered: number }>();
 for (const h of activeHoldings ?? []) {
 const covered = Math.min(h.openCallContracts * 100, h.shares);
 const entry = byTicker.get(h.ticker) ?? { shares: 0, covered: 0 };
 entry.shares += h.shares;
 entry.covered += covered;
 byTicker.set(h.ticker, entry);
 }
 return [...byTicker.entries()]
 .filter(([, v]) => v.covered < v.shares)
 .map(([ticker]) => ticker)
 .sort();
 }, [activeHoldings]);

 // Screener quick-add row 2: the 10 most recently traded tickers (by openedAt)
 // that aren't already in the holdings row above.
 const recentlyTradedTickers = useMemo(() => {
 const holdingSet = new Set(uncoveredHoldingTickers);
 const lastTradedAt = new Map<string, number>();
 for (const p of allPositions ?? []) {
 if (p.isDraft) continue;
 const sym = p.ticker.symbol;
 const t = new Date(p.openedAt).getTime();
 if ((lastTradedAt.get(sym) ?? 0) < t) lastTradedAt.set(sym, t);
 }
 return [...lastTradedAt.entries()]
 .filter(([sym]) => !holdingSet.has(sym))
 .sort((a, b) => b[1] - a[1])
 .slice(0, 10)
 .map(([sym]) => sym);
 }, [allPositions, uncoveredHoldingTickers]);

 const [assignedQuotes, setAssignedQuotes] = useState<Record<string, { price: number }>>(() => {
 // Seed from the same localStorage cache that OpenPositionsTable uses for livePrices,
 // so assigned-lot prices are available even when the staleness guard skips the fetch.
 const cache = readLivePriceCache();
 return Object.fromEntries(Object.entries(cache).map(([t, e]) => [t, { price: e.price }]));
 });
 const handlePricesUpdated = useCallback((prices: Map<string, number>) => {
 setAssignedQuotes((prev) => {
 const next = { ...prev };
 for (const [ticker, price] of prices) {
 next[ticker] = { price };
 }
 return next;
 });
 }, []);
 const totalUnrealizedPnl = useMemo(() => {
 if (activeHoldings == null) return null;
 let total = 0;
 for (const h of activeHoldings) {
 const price = assignedQuotes[h.ticker]?.price;
 if (price == null) continue;
 const coveredShares = Math.min(h.openCallContracts * 100, h.shares);
 const uncoveredShares = h.shares - coveredShares;
 const ccIsItm = h.openCallAvgStrike != null && price > h.openCallAvgStrike && coveredShares > 0;
 if (ccIsItm && h.openCallAvgStrike != null) {
 // Cap the covered-share gain at the CC strike; uncovered shares use live price.
 total += (h.openCallAvgStrike - h.assignmentStrike) * coveredShares
 + (price - h.assignmentStrike) * uncoveredShares;
 } else {
 total += (price - h.assignmentStrike) * h.shares;
 }
 }
 return total;
 }, [activeHoldings, assignedQuotes]);
 const totalRealizedPnl = realizedAssignedData != null ? (realizedAssignedData.netRealizedPnl ?? 0) : null;

 const [seededLivePrices, setSeededLivePrices] = useState<Map<string, number>>(new Map());

 const refetchAll = useCallback(() => {
 refetchPositions();
 refetchTickers();
 // Opening/editing a covered call changes lot coverage, so keep the
 // Assigned Lots table in sync without a manual page refresh.
 refetchActiveHoldings();
 refetchRealizedAssigned();
 }, [refetchPositions, refetchTickers, refetchActiveHoldings, refetchRealizedAssigned]);

 const handleDraftCreated = useCallback((ticker: string, underlyingPrice: number | null) => {
 if (underlyingPrice != null) {
 setSeededLivePrices((prev) => new Map(prev).set(ticker, underlyingPrice));
 }
 refetchAll();
 }, [refetchAll]);

 // "Sell covered call" shortcut from an assigned lot: open the position modal
 // in create mode pre-filled to write a CC against that lot.
 const handleSellCoveredCall = useCallback((seed: SellCoveredCallSeed) => {
 const tickerId = (tickers ?? []).find((t) => t.symbol === seed.ticker)?.id ?? null;
 setPositionModal({
 kind:"prefill",
 tickerId,
 tickerSymbol: seed.ticker,
 investmentAccountId: seed.accountId,
 assignedBatchKey:`${seed.assignmentStrike}|${seed.assignmentExpiration}`,
 });
 }, [tickers]);

 const handleDelete = async (p: OptionsPosition) => {
 await deleteOptionsPosition(p.id);
 // Undoing a split returns contracts to the open original and removes its
 // income/pending records, so refresh notifications alongside positions.
 refetchPositions();
 refetchNotifications();
 refetchActiveHoldings();
 refetchRealizedAssigned();
 };

 // "A" keyboard shortcut to open the "Open Position" modal, matching the
 // Expenses/Income pages convention.
 useEffect(() => {
 const handleKeyDown = (e: KeyboardEvent) => {
 if (positionModal || closeModal || editCloseModal || confirmDraftModal || settingsModal || importModalOpen) return;
 const target = e.target as HTMLElement;
 if (["INPUT","TEXTAREA","SELECT"].includes(target.tagName) || target.isContentEditable) return;
 if (e.key ==="a" || e.key ==="A") {
 // Prevent the keystroke from also landing in the modal's
 // auto-focused ticker field once it mounts.
 e.preventDefault();
 setPositionModal("new");
 }
 };
 document.addEventListener("keydown", handleKeyDown);
 return () => document.removeEventListener("keydown", handleKeyDown);
 }, [positionModal, closeModal, editCloseModal, confirmDraftModal, settingsModal, importModalOpen]);

 const tabClass = (active: boolean) =>
 cn(
"px-4 py-2 font-medium border-b-2 transition-colors",
 active
 ?"border-primary text-foreground"
 :"border-transparent text-muted-foreground hover:text-foreground"
 );

 if (!allPositions) return <BeaconLoader />;

 return (
 <div className="space-y-6">
 {/* Header + Capital Distribution Bar */}
 <div>
 <div className="flex items-start justify-between">
 <h2 className="tp-page-title">Options Trading</h2>
 <div className="flex items-center gap-3">
 <button
 type="button"
 onClick={() => setSettingsModal(true)}
 className="tp-nav-link hover:bg-muted hover:text-ink"
 >
 <Settings className="h-4 w-4" />
 Settings
 </button>
 <Button variant="secondary" className="border border-border" onClick={() => setImportModalOpen(true)}>
 <Upload className="h-4 w-4" /> Import
 </Button>
 <Button onClick={() => setPositionModal("new")}>
 <Plus className="h-4 w-4" />
 Open Position
 </Button>
 </div>
 </div>
 <p className="tp-caption mt-0.5 mb-3 flex items-center flex-wrap gap-x-6">
 <span>{tradingWeekLabel}</span>
 {tickerEntries.length > 0 && (
 <span className="flex items-center gap-x-4">
 {tickerEntries.map(([sym]) => (
 <span key={sym} className="flex items-center gap-1.5">
 <span
 className="inline-block w-2 h-2 rounded-sm flex-shrink-0"
 style={{ backgroundColor: tickerColorMap.get(sym) }}
 />
 {sym}
 </span>
 ))}
 </span>
 )}
 </p>
 <CapitalDistributionBar
 openPositions={openPositions}
 settings={settings ?? null}
 capitalChanges={capitalChanges ?? []}
 tickerColorMap={tickerColorMap}
 tickerContractMap={openTickerMap}
 />
 </div>

 {/* Summary Cards */}
 <SummaryCards
 openPositions={openPositions}
 closedPositions={closedPositions}
 settings={settings ?? null}
 capitalChanges={capitalChanges ?? []}
 totalUnrealizedPnl={totalUnrealizedPnl}
 totalRealizedPnl={totalRealizedPnl}
 realizedRows={realizedAssignedData?.rows ?? []}
 />

 {/* Tabs */}
 <Card>
 <div ref={tabBarRef} className="flex border-b border-border px-4">
 <button className={tabClass(tab ==="open")} onClick={() => setTab("open")}>
 Open Positions
 {openPositions.length > 0 && (
 <span className="ml-2 inline-flex items-center justify-center rounded-full bg-primary/10 text-primary text-xs px-1.5 py-0.5 font-medium">
 {openPositions.length}
 </span>
 )}
 </button>
 <button className={tabClass(tab ==="closed")} onClick={() => setTab("closed")}>
 Closed / Expired
 {closedPositions.length > 0 && (
 <span className="ml-2 inline-flex items-center justify-center rounded-full bg-border text-muted-foreground text-xs px-1.5 py-0.5 font-medium">
 {closedPositions.length}
 </span>
 )}
 </button>
 </div>
 <div className="p-0">
 {tab ==="open" ? (
 <OpenPositionsTable
 positions={openPositions}
 draftPositions={draftPositions}
 chainPnlMap={chainPnlMap}
 chainFirstOpenedMap={chainFirstOpenedMap}
 chainMaxCapitalAtRiskMap={chainMaxCapitalAtRiskMap}
 onEdit={(p) => setPositionModal(p)}
 onClose={(p) => setCloseModal(p)}
 onConfirm={(p) => setConfirmDraftModal(p)}
 onPositionUpdated={refetchPositions}
 extraTickers={activeLotTickers}
 onPricesUpdated={handlePricesUpdated}
 seedLivePrices={seededLivePrices}
 tabBarRef={tabBarRef}
 />
 ) : (
 <ClosedPositionsTable
 positions={closedPositions}
 openChainGroupIds={new Set(openPositions.filter((p) => p.groupId).map((p) => p.groupId as string))}
 openSplitGroupIds={new Set(openPositions.filter((p) => p.splitGroupId).map((p) => p.splitGroupId as string))}
 onEdit={(p) => setEditCloseModal(p)}
 onDelete={handleDelete}
 tabBarRef={tabBarRef}
 />
 )}
 </div>
 </Card>

 {/* Assigned stock (acquired via assigned CSPs) */}
 <AssignedSharesCard externalQuotes={assignedQuotes} active={activeHoldings} realized={realizedAssignedData} onSellCoveredCall={handleSellCoveredCall} targetReturn={settings?.targetReturn ?? null} />

 {/* Performance Charts */}
 <PerformanceCharts
 openPositions={openPositions}
 closedPositions={closedPositions}
 settings={settings ?? null}
 capitalChanges={capitalChanges ?? []}
 />

 {/* Performance Table */}
 <PerformanceTable positions={normalizedPositions.filter((p) => !p.isDraft)} />

 {/* Option Screener */}
 <OptionScreener
 trackedTickers={tickers ?? []}
 holdingTickers={uncoveredHoldingTickers}
 recentTickers={recentlyTradedTickers}
 onDraftCreated={handleDraftCreated}
 />

 {/* Modals */}
 {(positionModal !== null) && (
 <PositionModal
 tickers={tickers ?? []}
 groups={groups ?? []}
 editing={positionModal ==="new" || (typeof positionModal ==="object" &&"kind" in positionModal) ? null : positionModal}
 prefill={typeof positionModal ==="object" && positionModal !== null &&"kind" in positionModal ? positionModal : undefined}
 onClose={() => setPositionModal(null)}
 onSaved={() => { setPositionModal(null); refetchAll(); }}
 onDelete={async () => { if (typeof positionModal ==="object" && positionModal !== null && !("kind" in positionModal)) { await handleDelete(positionModal); setPositionModal(null); } }}
 onTickerCreated={refetchTickers}
 />
 )}

 {closeModal && (
 <ClosePositionModal
 position={closeModal}
 onClose={() => setCloseModal(null)}
 onSaved={() => { setCloseModal(null); refetchPositions(); refetchGroups(); refetchNotifications(); refetchActiveHoldings(); refetchRealizedAssigned(); }}
 defaultBankingAccountId={settings?.defaultCashAccountId ?? null}
 />
 )}

 {editCloseModal && (
 <EditCloseModal
 position={editCloseModal}
 onClose={() => setEditCloseModal(null)}
 onSaved={() => { setEditCloseModal(null); refetchPositions(); refetchNotifications(); refetchActiveHoldings(); refetchRealizedAssigned(); }}
 onEditPositionDetails={() => { setPositionModal(editCloseModal); setEditCloseModal(null); }}
 />
 )}

 {settingsModal && (
 <SettingsModal
 current={settings ?? null}
 capitalChanges={capitalChanges ?? []}
 onClose={() => setSettingsModal(false)}
 onSaved={() => { setSettingsModal(false); refetchSettings(); }}
 onCapitalChangeMutated={refetchCapitalChanges}
 />
 )}

 {confirmDraftModal && (
 <ConfirmDraftModal
 position={confirmDraftModal}
 onClose={() => setConfirmDraftModal(null)}
 onSaved={() => { setConfirmDraftModal(null); refetchPositions(); }}
 />
 )}

 {importModalOpen && (
 <ImportOptionsModal
 onClose={() => setImportModalOpen(false)}
 onComplete={() => { setImportModalOpen(false); refetchPositions(); refetchTickers(); }}
 />
 )}
 </div>
 );
}

// ── Import Modal ───────────────────────────────────────────────────────────────

interface ParsedOptionsRow {
 raw: string[];
 ticker: string;
 optionType:"CALL" |"PUT";
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

// Returns { date:"YYYY-MM-DD", time:"HH:MM" | null } or null if unparseable.
// Handles YYYY-MM-DD, M/D/YYYY, M/D/YY, and optional" H:MM AM/PM" suffix.
function parseOpenedDate(s: string): { date: string; time: string | null } | null {
 s = s.trim();

 // Split off optional time suffix:"H:MM AM" /"HH:MM AM" /"H:MM" (24h)
 let datePart = s;
 let time: string | null = null;
 const timeMatch = s.match(/^(.+?)\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?)$/i);
 if (timeMatch) {
 datePart = timeMatch[1].trim();
 const rawTime = timeMatch[2].trim();
 const ampm = rawTime.match(/([AP]M)$/i);
 const [hStr, mStr] = rawTime.replace(/\s*[AP]M$/i,"").split(":");
 let h = parseInt(hStr, 10);
 const min = parseInt(mStr, 10);
 if (ampm) {
 if (ampm[1].toUpperCase() ==="PM" && h !== 12) h += 12;
 if (ampm[1].toUpperCase() ==="AM" && h === 12) h = 0;
 }
 time =`${String(h).padStart(2,"0")}:${String(min).padStart(2,"0")}`;
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
 date =`${year}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
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
 let current ="";
 let inQuotes = false;
 for (let i = 0; i < line.length; i++) {
 const ch = line[i];
 if (inQuotes) {
 if (ch ==='"' && line[i + 1] ==='"') { current +='"'; i++; }
 else if (ch ==='"') { inQuotes = false; }
 else { current += ch; }
 } else {
 if (ch ==='"') { inQuotes = true; }
 else if (ch === delimiter) { fields.push(current.trim()); current =""; }
 else { current += ch; }
 }
 }
 fields.push(current.trim());
 return fields;
}

function parseOptionType(s: string):"CALL" |"PUT" | null {
 const v = s.trim().toLowerCase();
 if (v ==="call" || v ==="c" || v ==="cc") return"CALL";
 if (v ==="put" || v ==="p" || v ==="csp") return"PUT";
 return null;
}

function ImportOptionsModal({ onClose, onComplete }: {
 onClose: () => void;
 onComplete: () => void;
}) {
 const [step, setStep] = useState<"upload" |"preview" |"result">("upload");
 const [rows, setRows] = useState<ParsedOptionsRow[]>([]);
 const [showErrorsOnly, setShowErrorsOnly] = useState(false);
 const [importing, setImporting] = useState(false);
 const [result, setResult] = useState<{ imported: number; errors: Array<{ row: number; message: string }> } | null>(null);
 const fileRef = useRef<HTMLInputElement>(null);

 const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
 const file = e.target.files?.[0];
 if (!file) return;
 const reader = new FileReader();
 reader.onload = () => {
 const text = reader.result as string;
 const lines = text.split(/\r?\n/).filter((l) => l.trim());
 if (lines.length < 2) return;

 const delimiter = lines[0].includes("\t") ?"\t" :",";
 const parsed: ParsedOptionsRow[] = [];

 for (let i = 1; i < lines.length; i++) {
 const fields = parseOptionCSVLine(lines[i], delimiter);
 if (fields.length < 7) continue;

 // Columns: Ticker, Type, Strike Price, Expiration, Date Opened, Premium, Contracts,
 // Cost Basis (opt), Stock Price (opt), Fees (opt), Notes (opt)
 const [rawTicker, rawType, rawStrike, rawExp, rawDate, rawPremium, rawContracts,
 rawCostBasis, rawStockPrice, rawFees, rawNotes] = fields;
 const errors: string[] = [];

 const ticker = rawTicker?.trim().toUpperCase() ||"";
 if (!ticker) errors.push("Missing ticker");
 else if (!/^[A-Z]{1,10}$/.test(ticker)) errors.push(`Invalid ticker"${ticker}"`);

 const optionType = parseOptionType(rawType ??"");
 if (!optionType) errors.push(`Invalid type"${rawType?.trim()}" (expected CALL or PUT)`);

 const strikeStr = (rawStrike ??"").replace(/[$,]/g,"");
 const strikePrice = parseFloat(strikeStr);
 if (isNaN(strikePrice) || strikePrice <= 0) errors.push("Invalid strike price");

 const expirationDate = parseOptionDate(rawExp ??"");
 if (!expirationDate) errors.push("Invalid expiration date");

 const parsedOpened = parseOpenedDate(rawDate ??"");
 if (!parsedOpened) errors.push("Invalid date opened");
 // If a time was provided treat it as ET wall-clock; otherwise default to noon ET (16:00 UTC)
 const openedAt = parsedOpened
 ? parsedOpened.time
 ? etToUtc(`${parsedOpened.date}T${parsedOpened.time}`)
 :`${parsedOpened.date}T16:00:00.000Z`
 :"";

 const premStr = (rawPremium ??"").replace(/[$,]/g,"");
 const premiumPerShare = parseFloat(premStr);
 if (isNaN(premiumPerShare) || premiumPerShare <= 0) errors.push("Invalid premium");

 const contracts = parseInt((rawContracts ??"").replace(/,/g,""), 10);
 if (isNaN(contracts) || contracts <= 0) errors.push("Invalid contracts (must be positive integer)");

 const parsedCostBasis = rawCostBasis?.trim()
 ? parseFloat(rawCostBasis.replace(/[$,]/g,""))
 : null;
 const shareCostBasis = parsedCostBasis != null && !isNaN(parsedCostBasis) && parsedCostBasis > 0
 ? parsedCostBasis : null;

 const parsedStockPrice = rawStockPrice?.trim()
 ? parseFloat(rawStockPrice.replace(/[$,]/g,""))
 : null;
 const stockPriceAtOpen = parsedStockPrice != null && !isNaN(parsedStockPrice) && parsedStockPrice > 0
 ? parsedStockPrice : null;

 const parsedFees = rawFees?.trim()
 ? parseFloat(rawFees.replace(/[$,]/g,""))
 : null;
 const feesOpen = parsedFees != null && !isNaN(parsedFees) && parsedFees !== 0
 ? Math.abs(parsedFees) : null;

 const notes = rawNotes?.trim() || null;

 parsed.push({
 raw: fields,
 ticker,
 optionType: optionType ??"CALL",
 strikePrice: isNaN(strikePrice) ? 0 : strikePrice,
 expirationDate: expirationDate || (rawExp?.trim() ??""),
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
 const message = e instanceof Error ? e.message :"Import request failed";
 setResult({ imported: 0, errors: [{ row: 0, message }] });
 setStep("result");
 }
 setImporting(false);
 };

 return (
 <Modal open onClose={onClose} title="Import Options">
 {step ==="upload" && (
 <div className="space-y-4">
 <p className="text-muted-foreground">
 Upload a CSV or TSV file with these columns in order:
 </p>
 <div className="rounded-md border border-border bg-card px-3 py-2 text-xs font-mono leading-relaxed">
 Ticker, Type, Strike Price, Expiration, Date Opened, Premium, Contracts,
 Cost Basis, Stock Price, Fees, Notes
 </div>
 <p className="tp-caption">
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

 {step ==="preview" && (
 <div className="space-y-4">
 <div className="flex items-center justify-between">
 <p className="font-medium">
 {validRows.length} of {rows.length} rows valid
 </p>
 {errorRows.length > 0 && (
 <button
 type="button"
 onClick={() => setShowErrorsOnly((v) => !v)}
 className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs transition-colors ${
 showErrorsOnly
 ?"bg-down/15 text-down font-medium"
 :"text-down hover:bg-down/10"
 }`}
 >
 <AlertCircle className="h-3 w-3" />
 {errorRows.length} error{errorRows.length !== 1 ?"s" :""}
 {showErrorsOnly ?" — show all" :" — show only"}
 </button>
 )}
 </div>

 <div className="max-h-[50vh] overflow-auto rounded-md border border-border bg-white">
 <table className="w-full text-xs">
 <thead className="sticky top-0 bg-muted">
 <tr className="border-b border-border text-left text-muted-foreground">
 <ColumnHeader className="px-2 py-1.5">#</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5">Ticker</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5">Type</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5 text-right">Strike</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5">Exp</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5">Opened</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5 text-right">Premium</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5 text-right">Qty</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5 text-right whitespace-nowrap">Cost Basis</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5 text-right whitespace-nowrap">Stock Price</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5 text-right">Fees</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5">Notes</ColumnHeader>
 <ColumnHeader className="px-2 py-1.5">Status</ColumnHeader>
 </tr>
 </thead>
 <tbody>
 {visibleRows.map((row) => {
 const i = rows.indexOf(row);
 return (
 <tr key={i} className={`border-b border-border last:border-b-0 ${row.errors.length > 0 ?"bg-down/5" :""}`}>
 <td className="px-2 py-1.5 text-muted-foreground">{i + 1}</td>
 <td className="px-2 py-1.5 font-bold font-mono">{row.ticker ||"—"}</td>
 <td className="px-2 py-1.5">{row.optionType}</td>
 <td className="px-2 py-1.5 text-right">{row.strikePrice > 0 ?`$${row.strikePrice.toFixed(2)}` :"—"}</td>
 <td className="px-2 py-1.5">{row.expirationDate ? new Date(row.expirationDate).toLocaleDateString("en-US", { timeZone:"America/New_York", month:"numeric", day:"numeric", year:"2-digit" }) :"—"}</td>
 <td className="px-2 py-1.5">{row.openedAt ? new Date(row.openedAt).toLocaleDateString("en-US", { timeZone:"America/New_York", month:"numeric", day:"numeric", year:"2-digit" }) :"—"}</td>
 <td className="px-2 py-1.5 text-right">{row.premiumPerShare > 0 ?`$${row.premiumPerShare.toFixed(2)}` :"—"}</td>
 <td className="px-2 py-1.5 text-right">{row.contracts > 0 ? row.contracts :"—"}</td>
 <td className="px-2 py-1.5 text-right">{row.shareCostBasis != null ?`$${row.shareCostBasis.toFixed(2)}` :"—"}</td>
 <td className="px-2 py-1.5 text-right">{row.stockPriceAtOpen != null ?`$${row.stockPriceAtOpen.toFixed(2)}` :"—"}</td>
 <td className="px-2 py-1.5 text-right">{row.feesOpen != null ?`$${row.feesOpen.toFixed(2)}` :"—"}</td>
 <td className="px-2 py-1.5 max-w-[120px] truncate text-muted-foreground">{row.notes ||"—"}</td>
 <td className="px-2 py-1.5">
 {row.errors.length > 0 ? (
 <span className="text-down" title={row.errors.join(";")}>
 <AlertCircle className="inline h-3 w-3" /> {row.errors[0]}
 </span>
 ) : (
 <span className="text-up"><Check className="inline h-3 w-3" /></span>
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
 {importing ?"Importing..." :`Import ${validRows.length} Position${validRows.length !== 1 ?"s" :""}`}
 </Button>
 </div>
 </div>
 </div>
 )}

 {step ==="result" && result && (
 <div className="space-y-4">
 <div className="flex items-center gap-3 rounded-md border border-border bg-muted p-4">
 <CheckCircle2 className="h-6 w-6 text-up shrink-0" />
 <div>
 <p className="font-medium">
 {result.imported} position{result.imported !== 1 ?"s" :""} imported successfully
 </p>
 {result.errors.length > 0 && (
 <p className="text-xs text-down mt-1">
 {result.errors.length} row{result.errors.length !== 1 ?"s" :""} failed on server
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

 <div className="flex justify-end pt-2">
 <Button type="button" onClick={onComplete}>Done</Button>
 </div>
 </div>
 )}
 </Modal>
 );
}
