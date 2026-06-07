import { useState, useMemo, useEffect, useRef } from"react";
import { useNavigate } from"react-router-dom";
import { ArrowLeft, CalendarCheck2, Check, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Settings, Layers, Landmark, Briefcase, TrendingUp, Activity, CircleQuestionMark } from"lucide-react";
import { Card } from"@/components/Card";
import { Button } from"@/components/Button";
import { Modal } from"@/components/Modal";
import { useApi } from"@/hooks/useApi";
import { getIncome, getAllGainSnapshots, getTaxAssumptions, updateTaxAssumptions, updateTaxQuarterlyPayments, getDataRange } from"@/api";
import { formatCurrency, formatDate, parseAmount } from"@/lib/utils";
import type { Income, RealizedGainSnapshotWithAccount } from"@/types";
import { BeaconLoader } from"@/components/BeaconLoader";
import { SectionLabel, StatValue, DisplayStat } from"@/components/Typography";

// ── 2026 Federal Tax Data ──────────────────────────────────────────────────────

type FilingStatus ="SINGLE" |"MFJ" |"HoH" |"MFS";

interface Bracket { rate: number; threshold: number; }

const ORDINARY_BRACKETS: Record<FilingStatus, Bracket[]> = {
 SINGLE: [
 { rate: 0.10, threshold: 0 }, { rate: 0.12, threshold: 12400 },
 { rate: 0.22, threshold: 50400 }, { rate: 0.24, threshold: 105700 },
 { rate: 0.32, threshold: 201775 }, { rate: 0.35, threshold: 256225 },
 { rate: 0.37, threshold: 640600 },
],
 MFJ: [
 { rate: 0.10, threshold: 0 }, { rate: 0.12, threshold: 24800 },
 { rate: 0.22, threshold: 100800 }, { rate: 0.24, threshold: 211400 },
 { rate: 0.32, threshold: 403550 }, { rate: 0.35, threshold: 512450 },
 { rate: 0.37, threshold: 768700 },
],
 HoH: [
 { rate: 0.10, threshold: 0 }, { rate: 0.12, threshold: 17700 },
 { rate: 0.22, threshold: 67450 }, { rate: 0.24, threshold: 105700 },
 { rate: 0.32, threshold: 201775 }, { rate: 0.35, threshold: 256200 },
 { rate: 0.37, threshold: 640600 },
],
 // MFS brackets are the same as Single except 37% kicks in at half the MFJ threshold
 MFS: [
 { rate: 0.10, threshold: 0 }, { rate: 0.12, threshold: 12400 },
 { rate: 0.22, threshold: 50400 }, { rate: 0.24, threshold: 105700 },
 { rate: 0.32, threshold: 201775 }, { rate: 0.35, threshold: 256225 },
 { rate: 0.37, threshold: 384350 },
],
};

const LTCG_BRACKETS: Record<FilingStatus, Bracket[]> = {
 SINGLE: [{ rate: 0, threshold: 0 }, { rate: 0.15, threshold: 49450 }, { rate: 0.20, threshold: 545500 }],
 MFJ: [{ rate: 0, threshold: 0 }, { rate: 0.15, threshold: 98900 }, { rate: 0.20, threshold: 613700 }],
 HoH: [{ rate: 0, threshold: 0 }, { rate: 0.15, threshold: 66200 }, { rate: 0.20, threshold: 579600 }],
 MFS: [{ rate: 0, threshold: 0 }, { rate: 0.15, threshold: 49450 }, { rate: 0.20, threshold: 306850 }],
};

const STANDARD_DEDUCTION: Record<FilingStatus, number> = {
 SINGLE: 16100, MFJ: 32200, HoH: 24150, MFS: 16100,
};

const NIIT_THRESHOLD: Record<FilingStatus, number> = {
 SINGLE: 200000, MFJ: 250000, HoH: 200000, MFS: 125000,
};

const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
 SINGLE:"Single",
 MFJ:"Married Filing Jointly",
 HoH:"Head of Household",
 MFS:"Married Filing Separately",
};

// ── 2025 California Tax Data ───────────────────────────────────────────────────
// (2026 CA brackets not yet released by FTB; 2025 figures used)
// CA taxes all capital gains as ordinary income — no preferential rate.

const CA_ORDINARY_BRACKETS: Record<FilingStatus, Bracket[]> = {
 SINGLE: [
 { rate: 0.01, threshold: 0 }, { rate: 0.02, threshold: 11079 },
 { rate: 0.04, threshold: 26264 }, { rate: 0.06, threshold: 41452 },
 { rate: 0.08, threshold: 57542 }, { rate: 0.093, threshold: 72724 },
 { rate: 0.103, threshold: 371479 }, { rate: 0.113, threshold: 445771 },
 { rate: 0.123, threshold: 742953 },
],
 MFJ: [
 { rate: 0.01, threshold: 0 }, { rate: 0.02, threshold: 22158 },
 { rate: 0.04, threshold: 52528 }, { rate: 0.06, threshold: 82904 },
 { rate: 0.08, threshold: 115084 }, { rate: 0.093, threshold: 145448 },
 { rate: 0.103, threshold: 742958 }, { rate: 0.113, threshold: 891542 },
 { rate: 0.123, threshold: 1485906 },
],
 HoH: [
 { rate: 0.01, threshold: 0 }, { rate: 0.02, threshold: 22173 },
 { rate: 0.04, threshold: 52530 }, { rate: 0.06, threshold: 67716 },
 { rate: 0.08, threshold: 83805 }, { rate: 0.093, threshold: 98990 },
 { rate: 0.103, threshold: 505208 }, { rate: 0.113, threshold: 606251 },
 { rate: 0.123, threshold: 1010417 },
],
 MFS: [
 { rate: 0.01, threshold: 0 }, { rate: 0.02, threshold: 11079 },
 { rate: 0.04, threshold: 26264 }, { rate: 0.06, threshold: 41452 },
 { rate: 0.08, threshold: 57542 }, { rate: 0.093, threshold: 72724 },
 { rate: 0.103, threshold: 371479 }, { rate: 0.113, threshold: 445771 },
 { rate: 0.123, threshold: 742953 },
],
};

const CA_STANDARD_DEDUCTION: Record<FilingStatus, number> = {
 SINGLE: 5706, MFJ: 11412, HoH: 11412, MFS: 5706,
};

const CA_MHST_THRESHOLD = 1_000_000; // Mental Health Services Tax: +1% above this

// ── 2025 California AMT Data (Schedule P 540, Part II, Line 22) ───────────────
// Exemption phases out at 25¢ per dollar of AMTI above the threshold.
// CA taxes all gains as ordinary income — single flat 7% rate on taxable AMTI.

const CA_AMT_EXEMPTION: Record<FilingStatus, number> = {
 SINGLE: 92749, MFJ: 123667, HoH: 92749, MFS: 61830,
};
const CA_AMT_PHASE_OUT: Record<FilingStatus, number> = {
 SINGLE: 347808, MFJ: 463745, HoH: 347808, MFS: 231868,
};

// ── 2026 Federal AMT Data (Rev. Proc. 2025-32 / OBBBA) ────────────────────────
// Phase-out rate doubled to 50¢/$ (from 25¢ under TCJA) by the OBBBA.
// Phase-out thresholds were also reset from higher TCJA levels to $500k / $1M.

const AMT_EXEMPTION: Record<FilingStatus, number> = {
 SINGLE: 90100, MFJ: 140200, HoH: 90100, MFS: 70100,
};
const AMT_PHASE_OUT_THRESHOLD: Record<FilingStatus, number> = {
 SINGLE: 500000, MFJ: 1_000_000, HoH: 500000, MFS: 500000,
};
// 28% AMT rate applies above this AMTI amount (half for MFS)
const AMT_28_THRESHOLD: Record<FilingStatus, number> = {
 SINGLE: 244500, MFJ: 244500, HoH: 244500, MFS: 122250,
};

// ── Tax calculation functions ──────────────────────────────────────────────────

function calcOrdinaryTax(taxableIncome: number, brackets: Bracket[]): number {
 if (taxableIncome <= 0) return 0;
 let remaining = taxableIncome;
 let tax = 0;
 for (let i = brackets.length - 1; i >= 0; i--) {
 if (remaining > brackets[i].threshold) {
 tax += (remaining - brackets[i].threshold) * brackets[i].rate;
 remaining = brackets[i].threshold;
 }
 }
 return tax;
}

function marginalOrdinaryRate(taxableIncome: number, brackets: Bracket[]): number {
 if (taxableIncome <= 0) return brackets[0].rate;
 for (let i = brackets.length - 1; i >= 0; i--) {
 if (taxableIncome > brackets[i].threshold) return brackets[i].rate;
 }
 return brackets[0].rate;
}

function calcLTCGTax(ltcgAmount: number, ordinaryTaxable: number, brackets: Bracket[]): number {
 if (ltcgAmount <= 0) return 0;
 const ltcgEnd = ordinaryTaxable + ltcgAmount;
 let tax = 0;
 for (let i = 0; i < brackets.length; i++) {
 const bracketEnd = i + 1 < brackets.length ? brackets[i + 1].threshold : Infinity;
 const from = Math.max(brackets[i].threshold, ordinaryTaxable);
 const to = Math.min(bracketEnd, ltcgEnd);
 if (to > from) tax += (to - from) * brackets[i].rate;
 }
 return tax;
}

function marginalLTCGRate(ltcgEnd: number, brackets: Bracket[]): number {
 if (ltcgEnd <= 0) return 0;
 for (let i = brackets.length - 1; i >= 0; i--) {
 if (ltcgEnd > brackets[i].threshold) return brackets[i].rate;
 }
 return 0;
}

function fmtPct(rate: number): string {
 return (rate * 100).toFixed(0) +"%";
}

// ── Income record helpers ──────────────────────────────────────────────────────

function getTaxableAmt(income: Income): number {
 if (income.taxableAmount != null) return parseFloat(income.taxableAmount);
 return parseFloat(income.amount);
}

interface CapGainSplit { stcg: number; ltcg: number; collectibleLtcg: number; }

function getCapGainSplit(income: Income): CapGainSplit {
 const act = income.activity;
 // Prisma serializes Decimal fields as strings in JSON, so we must use Number()
 // rather than relying on JS arithmetic to coerce them (which causes NaN via
 // string-concatenation in Array.reduce).
 if (act) {
 const ltcgRaw = act.longTermGain != null ? Number(act.longTermGain) : 0;
 const isCollectible = act.isCollectible ?? false;
 return {
 stcg: act.shortTermGain != null ? Number(act.shortTermGain) : 0,
 ltcg: isCollectible ? 0 : ltcgRaw,
 collectibleLtcg: isCollectible ? ltcgRaw : 0,
 };
 }
 // No activity linked — treat full taxable amount as regular LTCG
 return { stcg: 0, ltcg: getTaxableAmt(income), collectibleLtcg: 0 };
}

// ── Group types ────────────────────────────────────────────────────────────────

type TaxBucket ="ordinary" |"qualified_dividend" |"capital_gain" |"exempt" |"return_of_capital";

const BUCKET_ORDER: Record<TaxBucket, number> = {
 ordinary: 0,
 capital_gain: 1,
 qualified_dividend: 2,
 exempt: 3,
 return_of_capital: 4,
};

interface TaxGroup {
 label: string;
 bucket: TaxBucket;
 incomes: Income[];
 totalTaxable: number;
 stcgTotal?: number;
 ltcgTotal?: number;
 collectibleLtcgTotal?: number;
}

interface CategorySection {
 categoryName: string;
 groups: TaxGroup[];
}

function classifyIncome(inc: Income): { label: string; bucket: TaxBucket } {
 const { subtype, taxClassification } = inc;
 if (taxClassification ==="TAX_EXEMPT")
 return { label:"Tax-Exempt", bucket:"exempt" };
 if (taxClassification ==="RETURN_OF_CAPITAL" || subtype ==="RETURN_OF_CAPITAL")
 return { label:"Return of Capital", bucket:"return_of_capital" };
 if (subtype ==="CAPITAL_GAIN")
 return { label:"Capital Gain", bucket:"capital_gain" };
 if (subtype ==="DIVIDEND" && taxClassification ==="QUALIFIED")
 return { label:"Qualified Dividend", bucket:"qualified_dividend" };
 return { label:"Ordinary Income", bucket:"ordinary" };
}

// ── Number input component ─────────────────────────────────────────────────────

function NumberInput({
 label, value, onChange, placeholder, allowNegative = false, inputRef,
}: {
 label: string; value: string; onChange: (v: string) => void;
 placeholder?: string; allowNegative?: boolean;
 inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
 return (
 <div>
 <label className="block text-xs font-medium mb-1">{label}</label>
 <div className="relative">
 <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
 <input
 ref={inputRef}
 type="text"
 inputMode="decimal"
 value={value}
 onChange={(e) => {
 const v = e.target.value;
 const pattern = allowNegative ? /^-?\d*\.?\d{0,2}$/ : /^\d*\.?\d{0,2}$/;
 if (v ==="" || v ==="-" || pattern.test(v)) onChange(v);
 }}
 onPaste={(e) => {
 e.preventDefault();
 const cleaned = e.clipboardData.getData("text").replace(/[$,\s]/g,"");
 const pattern = allowNegative ? /^-?\d*\.?\d{0,2}$/ : /^\d*\.?\d{0,2}$/;
 if (cleaned ==="" || cleaned ==="-" || pattern.test(cleaned)) onChange(cleaned);
 }}
 placeholder={placeholder ??"0"}
 className="w-full rounded-md border border-border pl-7 pr-3 py-2 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 </div>
 );
}

// ── Rate badge ─────────────────────────────────────────────────────────────────

function RateBadge({ label, className ="" }: { label: string; className?: string }) {
 return (
 <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
 {label}
 </span>
 );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function TaxEstimatorPage() {
 const navigate = useNavigate();
 const now = new Date();
 const [year, setYear] = useState(now.getFullYear());
 const [filingStatus, setFilingStatus] = useState<FilingStatus>("SINGLE");
 const [otherOrdinary, setOtherOrdinary] = useState("");
 const [otherLTCG, setOtherLTCG] = useState("");
 const [withheld, setWithheld] = useState("");
 const [taxBreakdownTab, setTaxBreakdownTab] = useState<"federal" |"ca">("federal");
 const [useTmt, setUseTmt] = useState(false);
 const [useCaTmt, setUseCaTmt] = useState(false);
 const [assumptionsOpen, setAssumptionsOpen] = useState(false);
 const [paymentScheduleOpen, setPaymentScheduleOpen] = useState(false);
 const [caPaymentScheduleOpen, setCaPaymentScheduleOpen] = useState(false);
 const [focusOnOpen, setFocusOnOpen] = useState<"ordinary" |"ltcg" | false>(false);
 const [qPaid, setQPaid] = useState<[string, string, string, string]>(["","","",""]);
 const [caWithheld, setCaWithheld] = useState("");
 const [caQPaid, setCaQPaid] = useState<[string, string, string, string]>(["","","",""]);
 const otherOrdinaryRef = useRef<HTMLInputElement>(null);
 const otherLTCGRef = useRef<HTMLInputElement>(null);
 const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

 // Load persisted assumptions from the server whenever year changes
 const { data: taxData } = useApi(() => getTaxAssumptions(year), [year]);

 useEffect(() => {
 if (!taxData) return;
 setFilingStatus(taxData.filingStatus as FilingStatus);
 setOtherOrdinary(taxData.otherOrdinary != null ? String(taxData.otherOrdinary) :"");
 setWithheld( taxData.federalWithheld != null ? String(taxData.federalWithheld) :"");
 setOtherLTCG( taxData.otherLtcg != null ? String(taxData.otherLtcg) :"");
 setCaWithheld( taxData.caWithheld != null ? String(taxData.caWithheld) :"");
 setUseTmt(taxData.useTmt);
 setUseCaTmt(taxData.useCaTmt);
 const p = taxData.quarterlyPayments;
 setQPaid([
 p[0]?.federalAmount != null ? String(p[0].federalAmount) :"",
 p[1]?.federalAmount != null ? String(p[1].federalAmount) :"",
 p[2]?.federalAmount != null ? String(p[2].federalAmount) :"",
 p[3]?.federalAmount != null ? String(p[3].federalAmount) :"",
]);
 setCaQPaid([
 p[0]?.caAmount != null ? String(p[0].caAmount) :"",
 p[1]?.caAmount != null ? String(p[1].caAmount) :"",
 p[2]?.caAmount != null ? String(p[2].caAmount) :"",
 p[3]?.caAmount != null ? String(p[3].caAmount) :"",
]);
 }, [taxData]);

 // Focus the correct field when the modal is opened via an edit link
 useEffect(() => {
 if (assumptionsOpen && focusOnOpen) {
 const ref = focusOnOpen ==="ltcg" ? otherLTCGRef : otherOrdinaryRef;
 const t = setTimeout(() => { ref.current?.focus(); setFocusOnOpen(false); }, 50);
 return () => clearTimeout(t);
 }
 }, [assumptionsOpen, focusOnOpen]);

 const updateFilingStatus = (s: FilingStatus) => setFilingStatus(s);
 const updateOtherOrdinary = (v: string) => setOtherOrdinary(v);
 const updateOtherLTCG = (v: string) => setOtherLTCG(v);
 const updateWithheld = (v: string) => setWithheld(v);
 const updateQPaid = (idx: 0 | 1 | 2 | 3, v: string) => {
 setQPaid((prev) => {
 const next = [...prev] as [string, string, string, string];
 next[idx] = v;
 return next;
 });
 };
 const updateCaWithheld = (v: string) => setCaWithheld(v);
 const updateCaQPaid = (idx: 0 | 1 | 2 | 3, v: string) => {
 setCaQPaid((prev) => {
 const next = [...prev] as [string, string, string, string];
 next[idx] = v;
 return next;
 });
 };

 // Save helpers — fire-and-forget; local state is always the live source of truth
 const saveAssumptions = () => {
 updateTaxAssumptions(year, {
 filingStatus,
 otherOrdinary: otherOrdinary.trim() ? parseAmount(otherOrdinary) : null,
 federalWithheld: withheld.trim() ? parseAmount(withheld) : null,
 otherLtcg: otherLTCG.trim() ? parseAmount(otherLTCG) : null,
 caWithheld: caWithheld.trim() ? parseAmount(caWithheld) : null,
 useTmt,
 useCaTmt,
 });
 };

 const saveQuarterlyPayments = () => {
 updateTaxQuarterlyPayments(year, {
 federal: qPaid.map((v) => v.trim() ? parseAmount(v) : null),
 ca: caQPaid.map((v) => v.trim() ? parseAmount(v) : null),
 });
 };

 const toggleSection = (key: string) => {
 setExpandedSections((prev) => {
 const next = new Set(prev);
 next.has(key) ? next.delete(key) : next.add(key);
 return next;
 });
 };

 const params = useMemo(() => ({
 startDate:`${year}-01-01`,
 endDate:`${year}-12-31`,
 limit:"1000",
 sortBy:"date",
 sortOrder:"asc",
 showOnlyReceived:"false",
 }), [year]);

 const { data, loading } = useApi(() => getIncome(params), [params]);
 const incomes = useMemo(() => data?.data ?? [], [data]);

 const { data: gainSnapshots } = useApi(() => getAllGainSnapshots(year), [year]);
 const snapshots: RealizedGainSnapshotWithAccount[] = useMemo(() => gainSnapshots ?? [], [gainSnapshots]);

 const { data: dataRange } = useApi(() => getDataRange(), []);

 const otherOrdinaryNum = parseAmount(otherOrdinary) || 0;
 const otherLTCGNum = parseAmount(otherLTCG) || 0;
 const withheldNum = parseAmount(withheld) || 0;
 const qPaidNums = qPaid.map((v) => parseAmount(v) || 0) as [number, number, number, number];
 const totalQPaid = qPaidNums.reduce((s, v) => s + v, 0);
 const caWithheldNum = parseAmount(caWithheld) || 0;
 const caQPaidNums = caQPaid.map((v) => parseAmount(v) || 0) as [number, number, number, number];
 const totalCAQPaid = caQPaidNums.reduce((s, v) => s + v, 0);

 // Federal quarterly schedule: equal 25/25/25/25 installments
 const quarters: { label: string; period: string; dueLabel: string; dueDate: Date }[] = useMemo(() => [
 { label:"Q1", period:"Jan – Mar", dueLabel:`Apr 15, ${year}`, dueDate: new Date(year, 3, 15) },
 { label:"Q2", period:"Apr – May", dueLabel:`Jun 15, ${year}`, dueDate: new Date(year, 5, 15) },
 { label:"Q3", period:"Jun – Aug", dueLabel:`Sep 15, ${year}`, dueDate: new Date(year, 8, 15) },
 { label:"Q4", period:"Sep – Dec", dueLabel:`Jan 15, ${year + 1}`, dueDate: new Date(year + 1, 0, 15) },
], [year]);

 // CA quarterly schedule: 30% / 40% / 0% / 30% (cumulative targets: 30/70/70/100)
 // Q3 has no CA estimated payment due.
 const caQuarters: { label: string; period: string; dueLabel: string; dueDate: Date | null; cumulativePct: number; noDue: boolean }[] = useMemo(() => [
 { label:"Q1", period:"Jan – Mar", dueLabel:`Apr 15, ${year}`, dueDate: new Date(year, 3, 15), cumulativePct: 0.30, noDue: false },
 { label:"Q2", period:"Apr – May", dueLabel:`Jun 15, ${year}`, dueDate: new Date(year, 5, 15), cumulativePct: 0.70, noDue: false },
 { label:"Q3", period:"Jun – Aug", dueLabel:"—", dueDate: null, cumulativePct: 0.70, noDue: true },
 { label:"Q4", period:"Sep – Dec", dueLabel:`Jan 15, ${year + 1}`, dueDate: new Date(year + 1, 0, 15), cumulativePct: 1.00, noDue: false },
], [year]);

 // Classify records into tax buckets
 const classified = useMemo(() => {
 const ordinary: Income[] = [], qualDividend: Income[] = [],
 capGain: Income[] = [], exempt: Income[] = [], roc: Income[] = [];
 for (const inc of incomes) {
 const { bucket } = classifyIncome(inc);
 if (bucket ==="ordinary") ordinary.push(inc);
 else if (bucket ==="qualified_dividend") qualDividend.push(inc);
 else if (bucket ==="capital_gain") capGain.push(inc);
 else if (bucket ==="exempt") exempt.push(inc);
 else roc.push(inc);
 }
 return { ordinary, qualDividend, capGain, exempt, roc };
 }, [incomes]);

 // Compute income totals and taxes
 const calc = useMemo(() => {
 const ordinaryFromApp = classified.ordinary.reduce((s, i) => s + getTaxableAmt(i), 0);
 const qualDivFromApp = classified.qualDividend.reduce((s, i) => s + getTaxableAmt(i), 0);
 const exemptFromApp = classified.exempt.reduce((s, i) => s + parseFloat(i.amount), 0);
 const rocFromApp = classified.roc.reduce((s, i) => s + parseFloat(i.amount), 0);

 // Net realized gains/losses from managed-account snapshots
 const snapshotNetSTCG = snapshots.reduce(
 (s, snap) => s + (snap.shortTermGain ?? 0) - (snap.shortTermLoss ?? 0), 0
 );
 const snapshotNetLTCG = snapshots.reduce(
 (s, snap) => s + (snap.longTermGain ?? 0) - (snap.longTermLoss ?? 0), 0
 );

 const capGainSplits = classified.capGain.map(getCapGainSplit);
 const rawCollectibleLTCG = capGainSplits.reduce((s, g) => s + g.collectibleLtcg, 0);
 // Income records + managed-account snapshots combined for netting and display
 const rawSTCG = capGainSplits.reduce((s, g) => s + g.stcg, 0) + snapshotNetSTCG;
 const rawLTCG = capGainSplits.reduce((s, g) => s + g.ltcg, 0) + snapshotNetLTCG;

 // Net STCG against LTCG across app + other inputs, then cap loss deduction at $3,000
 let netSTCG = rawSTCG;
 let netLTCG = rawLTCG + otherLTCGNum;

 if (netSTCG < 0 && netLTCG > 0) {
 const offset = Math.min(-netSTCG, netLTCG);
 netSTCG += offset; netLTCG -= offset;
 } else if (netLTCG < 0 && netSTCG > 0) {
 const offset = Math.min(-netLTCG, netSTCG);
 netLTCG += offset; netSTCG -= offset;
 }

 // If combined capital loss remains, cap ordinary income offset at $3,000
 const combinedCapLoss = Math.min(0, netSTCG + netLTCG);
 const capLossDeduction = Math.max(-3000, combinedCapLoss);
 const hasCapLoss = combinedCapLoss < 0;

 const stcgOrdinaryContrib = netSTCG >= 0 ? netSTCG : capLossDeduction;
 const ltcgContrib = Math.max(0, netLTCG);
 const qdContrib = qualDivFromApp;
 // Collectible LTCG is kept as a separate pool; positive gains are taxed at
 // min(28%, marginalOrdRate). Losses reduce the collectible amount directly.
 const collectibleContrib = Math.max(0, rawCollectibleLTCG);

 const stdDeduction = STANDARD_DEDUCTION[filingStatus];
 const grossOrdinary = otherOrdinaryNum + ordinaryFromApp + stcgOrdinaryContrib;
 const taxableOrdinary = Math.max(0, grossOrdinary - stdDeduction);

 // Standard deduction may spill over to offset preferential income
 const unusedDeduction = Math.max(0, stdDeduction - grossOrdinary);
 const grossPreferential = ltcgContrib + qdContrib;
 const taxablePreferential = Math.max(0, grossPreferential - unusedDeduction);

 const ordBrackets = ORDINARY_BRACKETS[filingStatus];
 const ltcgBrackets = LTCG_BRACKETS[filingStatus];

 // Marginal ordinary rate is needed for the collectible rate, so compute first
 const marginalOrdRate = marginalOrdinaryRate(taxableOrdinary, ordBrackets);
 const collectibleRate = Math.min(0.28, marginalOrdRate);
 const collectibleTax = collectibleContrib * collectibleRate;

 const ordinaryTax = calcOrdinaryTax(taxableOrdinary, ordBrackets);
 const preferentialTax = calcLTCGTax(taxablePreferential, taxableOrdinary, ltcgBrackets);

 // NIIT — 3.8% on lesser of NII or (MAGI - threshold)
 // NII from app = all investment income (dividends, cap gains, collectibles)
 //"Other ordinary income" is treated as wages (not NII)
 const nii = ordinaryFromApp + rawSTCG + rawLTCG + rawCollectibleLTCG + qualDivFromApp + otherLTCGNum;
 const magi = grossOrdinary + grossPreferential + collectibleContrib;
 const niitThreshold = NIIT_THRESHOLD[filingStatus];
 const niitBase = magi > niitThreshold ? Math.max(0, Math.min(nii, magi - niitThreshold)) : 0;
 const niitTax = niitBase * 0.038;

 const totalTax = ordinaryTax + preferentialTax + collectibleTax + niitTax;
 const effectiveRate = magi > 0 ? totalTax / magi : 0;

 const ltcgEnd = taxableOrdinary + taxablePreferential;
 const marginalPrefRate = marginalLTCGRate(ltcgEnd, ltcgBrackets);

 return {
 ordinaryFromApp, qualDivFromApp, exemptFromApp, rocFromApp,
 snapshotNetSTCG, snapshotNetLTCG,
 rawSTCG, rawLTCG, rawCollectibleLTCG, netSTCG, netLTCG,
 stcgOrdinaryContrib, ltcgContrib, qdContrib, collectibleContrib,
 grossOrdinary, grossPreferential, taxableOrdinary, taxablePreferential, stdDeduction,
 ordinaryTax, preferentialTax, collectibleTax, collectibleRate, niitTax, niitBase,
 totalTax, effectiveRate,
 marginalOrdRate, marginalPrefRate, ltcgEnd, magi,
 hasCapLoss, capLossDeduction,
 };
 }, [classified, otherOrdinaryNum, otherLTCGNum, filingStatus, snapshots]);

 // CA taxes all capital gains as ordinary income; no NIIT equivalent.
 // CA gross income = federal MAGI (same income pool, same cap-loss netting).
 const caCalc = useMemo(() => {
 const caBrackets = CA_ORDINARY_BRACKETS[filingStatus];
 const caStdDed = CA_STANDARD_DEDUCTION[filingStatus];
 const caGross = calc.magi;
 const caTaxable = Math.max(0, caGross - caStdDed);
 const caOrdTax = calcOrdinaryTax(caTaxable, caBrackets);
 const caMhstBase = Math.max(0, caTaxable - CA_MHST_THRESHOLD);
 const caMhstTax = caMhstBase * 0.01;
 const caTotalTax = caOrdTax + caMhstTax;
 const caEffRate = caGross > 0 ? caTotalTax / caGross : 0;
 const caMargRate = marginalOrdinaryRate(caTaxable, caBrackets) + (caTaxable > CA_MHST_THRESHOLD ? 0.01 : 0);
 return { caGross, caTaxable, caStdDed, caOrdTax, caMhstBase, caMhstTax, caTotalTax, caEffRate, caMargRate };
 }, [calc.magi, filingStatus]);

 // AMT uses MAGI as starting income (no standard deduction; own exemption instead).
 // LTCG/QD retain preferential rates in AMT — only ordinary AMTI is taxed at 26/28%.
 const amtCalc = useMemo(() => {
 const exemptionBase = AMT_EXEMPTION[filingStatus];
 const phaseOutStart = AMT_PHASE_OUT_THRESHOLD[filingStatus];
 // OBBBA: 50¢ phase-out per $1 of AMTI above threshold
 const phaseOutRedux = Math.max(0, calc.magi - phaseOutStart) * 0.50;
 const effectiveExemp = Math.max(0, exemptionBase - phaseOutRedux);

 const amtiGross = calc.magi;
 const amti = Math.max(0, amtiGross - effectiveExemp);

 const amtBrackets: Bracket[] = [
 { rate: 0.26, threshold: 0 },
 { rate: 0.28, threshold: AMT_28_THRESHOLD[filingStatus] },
];

 // Preferential income stacks on top of ordinary AMTI (same as regular tax)
 const preferentialPool = calc.ltcgContrib + calc.qdContrib;
 const collectiblePool = calc.collectibleContrib;
 const amtiOrdinary = Math.max(0, amti - preferentialPool - collectiblePool);
 const amtiCollectible = Math.max(0, Math.min(collectiblePool, amti - amtiOrdinary));
 const amtiPreferential = Math.max(0, amti - amtiOrdinary - amtiCollectible);

 const amtOrdTax = calcOrdinaryTax(amtiOrdinary, amtBrackets);
 const amtMargOrdRate = marginalOrdinaryRate(amtiOrdinary, amtBrackets);
 const amtCollRate = Math.min(0.28, amtMargOrdRate);
 const amtCollTax = amtiCollectible * amtCollRate;
 // Preferential income: LTCG rates, stacked on top of ordinary + collectible AMTI
 const amtPrefTax = calcLTCGTax(amtiPreferential, amtiOrdinary + amtiCollectible, LTCG_BRACKETS[filingStatus]);

 const tmt = amtOrdTax + amtCollTax + amtPrefTax;
 // NIIT (§1411) is a separate tax that applies on top of whichever income tax regime
 // is binding — it is not part of AMT and not displaced by it.
 // Correct comparison: TMT vs. pre-NIIT regular income tax only.
 const preNiitTax = calc.totalTax - calc.niitTax;
 const potentialCredit = Math.max(0, preNiitTax - tmt);
 const amtSurcharge = Math.max(0, tmt - preNiitTax);
 // Total federal liability in TMT mode: TMT income tax + NIIT (same as regular mode)
 const tmtTotal = tmt + calc.niitTax;

 return {
 effectiveExemp, amtiGross, amti,
 amtiOrdinary, amtiCollectible, amtiPreferential,
 amtOrdTax, amtMargOrdRate, amtCollRate, amtCollTax, amtPrefTax,
 tmt, tmtTotal, potentialCredit, amtSurcharge,
 };
 }, [calc, filingStatus]);

 // CA AMT — flat 7% on CA AMTI after exemption.
 // CA AMTI = caGross (standard deduction is added back; no preferential-rate split since CA taxes all gains as ordinary).
 const caTmtCalc = useMemo(() => {
 const exemptionBase = CA_AMT_EXEMPTION[filingStatus];
 const phaseOutStart = CA_AMT_PHASE_OUT[filingStatus];
 const caAmti = caCalc.caGross;
 const phaseOutRedux = Math.max(0, caAmti - phaseOutStart) * 0.25;
 const effectiveExemp = Math.max(0, exemptionBase - phaseOutRedux);
 const taxableCaAmti = Math.max(0, caAmti - effectiveExemp);
 const caTmt = taxableCaAmti * 0.07;
 const amtSurcharge = Math.max(0, caTmt - caCalc.caTotalTax);
 const potentialCredit = Math.max(0, caCalc.caTotalTax - caTmt);
 return { caAmti, effectiveExemp, taxableCaAmti, caTmt, amtSurcharge, potentialCredit };
 }, [caCalc, filingStatus]);

 // When TMT mode is on, model federal liability as TMT (crediting prior-year AMT credits)
 const effectiveFederalTax = useTmt ? amtCalc.tmtTotal : calc.totalTax;
 const effectiveCaTax = useCaTmt ? caTmtCalc.caTmt : caCalc.caTotalTax;

 // Build category sections for detailed breakdown
 const categorySections = useMemo((): CategorySection[] => {
 const map = new Map<string, CategorySection>();
 for (const inc of incomes) {
 const catName = inc.category?.name ??"Uncategorized";
 if (!map.has(catName)) map.set(catName, { categoryName: catName, groups: [] });
 const section = map.get(catName)!;
 const { label, bucket } = classifyIncome(inc);
 let group = section.groups.find((g) => g.label === label);
 if (!group) {
 group = { label, bucket, incomes: [], totalTaxable: 0 };
 section.groups.push(group);
 }
 group.incomes.push(inc);
 }

 // Compute group totals
 for (const section of map.values()) {
 for (const group of section.groups) {
 if (group.bucket ==="capital_gain") {
 let stcg = 0, ltcg = 0, collectibleLtcg = 0;
 for (const inc of group.incomes) {
 const s = getCapGainSplit(inc);
 stcg += s.stcg; ltcg += s.ltcg; collectibleLtcg += s.collectibleLtcg;
 }
 group.stcgTotal = stcg; group.ltcgTotal = ltcg; group.collectibleLtcgTotal = collectibleLtcg;
 group.totalTaxable = stcg + ltcg + collectibleLtcg;
 } else if (group.bucket ==="exempt" || group.bucket ==="return_of_capital") {
 group.totalTaxable = 0;
 } else {
 group.totalTaxable = group.incomes.reduce((s, i) => s + getTaxableAmt(i), 0);
 }
 }
 }

 for (const section of map.values()) {
 section.groups.sort((a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket]);
 }

 return Array.from(map.values()).sort((a, b) => a.categoryName.localeCompare(b.categoryName));
 }, [incomes]);

 // Whether any section has ordinary / preferential / collectible income — drives column visibility in headers
 const anyOrdinaryInSections = categorySections.some((s) =>
 s.groups.some((g) => g.bucket ==="ordinary" || (g.bucket ==="capital_gain" && (g.stcgTotal ?? 0) > 0))
 );
 const anyPreferentialInSections = categorySections.some((s) =>
 s.groups.some((g) => g.bucket ==="qualified_dividend" || (g.bucket ==="capital_gain" && (g.ltcgTotal ?? 0) > 0))
 );
 const anyCollectibleInSections = categorySections.some((s) =>
 s.groups.some((g) => g.bucket ==="capital_gain" && (g.collectibleLtcgTotal ?? 0) !== 0)
 );
 // When the collectible rate equals the ordinary marginal rate (i.e. ordinary rate ≤ 28%),
 // collectible gains are taxed identically to ordinary income, so roll them into the
 // ordinary column rather than showing a redundant separate column.
 const showCollectibleSeparately = anyCollectibleInSections && calc.collectibleRate < calc.marginalOrdRate;

 const rateLabel = (bucket: TaxBucket, groupSTCG?: number, groupLTCG?: number, groupCollectible?: number): React.ReactNode => {
 if (bucket ==="exempt" || bucket ==="return_of_capital")
 return <RateBadge label="Non-taxable" className="bg-border text-muted-foreground" />;
 if (bucket ==="qualified_dividend")
 return <RateBadge label={`${fmtPct(calc.marginalPrefRate)} capital gains rate`} className="bg-up-soft text-up-deep" />;
 if (bucket ==="capital_gain") {
 const hasSTCG = (groupSTCG ?? 0) !== 0;
 const hasLTCG = (groupLTCG ?? 0) !== 0;
 const hasCollectible = (groupCollectible ?? 0) !== 0;
 // Collectible gains rolled into ordinary when rates are the same
 const collectibleRolledUp = hasCollectible && !showCollectibleSeparately;
 return (
 <span className="flex flex-wrap gap-1">
 {(hasSTCG || collectibleRolledUp) && (
 <RateBadge
 label={`${fmtPct(calc.marginalOrdRate)} ${
 hasSTCG && collectibleRolledUp ?"short-term/collectible (ordinary)"
 : hasSTCG ?"short-term (ordinary)"
 :"ordinary rate"
 }`}
 className="bg-warn-soft text-warn-deep"
 />
 )}
 {hasLTCG && <RateBadge label={`${fmtPct(calc.marginalPrefRate)} long-term (capital gains)`} className="bg-up-soft text-up-deep" />}
 {hasCollectible && showCollectibleSeparately && <RateBadge label={`${fmtPct(calc.collectibleRate)} collectible (28% max)`} className="bg-orange-soft text-orange-deep" />}
 </span>
 );
 }
 return <RateBadge label={`${fmtPct(calc.marginalOrdRate)} marginal ordinary rate`} className="bg-warn-soft text-warn-deep" />;
 };

 if (!taxData) return <BeaconLoader />;

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="flex items-start justify-between">
 <div className="flex items-center gap-3">
 <button
 onClick={() => navigate(-1)}
 className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
 >
 <ArrowLeft className="h-4 w-4" />
 </button>
 <h2 className="tp-page-title">Tax Estimator</h2>
 </div>
 <div className="flex items-center gap-3">
 <button
 type="button"
 onClick={() => setAssumptionsOpen(true)}
 className="tp-nav-link hover:bg-muted hover:text-ink"
 >
 <Settings className="h-4 w-4" />
 Tax Assumptions
 </button>
 <div className="flex items-center gap-2">
 <Button variant="ghost" size="sm" onClick={() => setYear((y) => y - 1)} disabled={dataRange ? year <= dataRange.minYear : false}>
 <ChevronLeft className="h-4 w-4" />
 </Button>
 <span className="min-w-[4rem] text-center font-semibold">{year}</span>
 <Button variant="ghost" size="sm" onClick={() => setYear((y) => y + 1)} disabled={dataRange ? year >= dataRange.maxYear : false}>
 <ChevronRight className="h-4 w-4" />
 </Button>
 </div>
 </div>
 </div>

 {/* Tax Assumptions Modal */}
 <Modal
 open={assumptionsOpen}
 onClose={() => { saveAssumptions(); setAssumptionsOpen(false); }}
 title="Tax Assumptions"
 className="max-w-lg"
 >
 <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
 <div className="sm:col-span-2">
 <label className="block text-xs font-medium mb-1">Filing Status</label>
 <div className="relative">
 <select
 value={filingStatus}
 onChange={(e) => updateFilingStatus(e.target.value as FilingStatus)}
 className="appearance-none w-full rounded-md border border-border py-2 pl-2 pr-6 text-foreground"
 >
 {(Object.keys(FILING_STATUS_LABELS) as FilingStatus[]).map((s) => (
 <option key={s} value={s}>{FILING_STATUS_LABELS[s]}</option>
 ))}
 </select>
 <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
 </div>
 </div>
 <NumberInput
 label="Other Ordinary Income (W-2, etc.)"
 value={otherOrdinary}
 onChange={updateOtherOrdinary}
 placeholder="0"
 inputRef={otherOrdinaryRef}
 />
 <NumberInput
 label="Federal Income Tax Withheld"
 value={withheld}
 onChange={updateWithheld}
 placeholder="0"
 />
 <NumberInput
 label="Other Net Long-Term Capital Gains / Losses"
 value={otherLTCG}
 onChange={updateOtherLTCG}
 placeholder="0"
 allowNegative
 inputRef={otherLTCGRef}
 />
 </div>
 <div className="mt-4 border-t border-border pt-4">
 <SectionLabel className="mb-3">California</SectionLabel>
 <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
 <NumberInput
 label="CA Income Tax Withheld"
 value={caWithheld}
 onChange={updateCaWithheld}
 placeholder="0"
 />
 </div>
 </div>
 <p className="mt-4 tp-caption">
 Federal: 2026 brackets · Standard deduction ({formatCurrency(STANDARD_DEDUCTION[filingStatus])}) applied · Does not account for tax-advantaged accounts, EITC, child tax credits, or QBI deductions
 <br />California: 2025 brackets · Standard deduction ({formatCurrency(CA_STANDARD_DEDUCTION[filingStatus])}) applied · All capital gains taxed as ordinary income · State only, does not include SDI
 </p>
 <div className="mt-5 flex justify-end">
 <Button onClick={() => { saveAssumptions(); setAssumptionsOpen(false); }}>Done</Button>
 </div>
 </Modal>

 {/* Payment Schedule Modal */}
 <Modal
 open={paymentScheduleOpen}
 onClose={() => { saveQuarterlyPayments(); setPaymentScheduleOpen(false); }}
 title={`${useTmt ?"TMT" :""}Payment Schedule · ${year}`}
 className="max-w-3xl"
 >
 {(() => {
 const netEstimated = Math.max(0, effectiveFederalTax - withheldNum);
 // Each quarter's suggested payment brings cumulative paid up to 25%/50%/75%/100%
 // of the current annual estimate, catching up automatically as income grows.
 const suggested = [0, 1, 2, 3].map((i) => {
 const priorPaid = qPaidNums.slice(0, i).reduce((s, v) => s + v, 0);
 return Math.max(0, netEstimated * (i + 1) / 4 - priorPaid);
 });
 const today = new Date();
 const totalPaid = withheldNum + totalQPaid;
 const netOwed = effectiveFederalTax - totalPaid;
 const safeHarborPct = effectiveFederalTax > 0 ? totalPaid / effectiveFederalTax : 1;
 const onTrack = safeHarborPct >= 0.9;

 return (
 <div className="space-y-5">
 <table className="w-full text-13">
 <thead>
 <tr className="border-b border-border text-left tp-table-header">
 <th className="pb-2 font-medium">Quarter</th>
 <th className="pb-2 font-medium">Income Period</th>
 <th className="pb-2 font-medium">Due Date</th>
 <th className="pb-2 text-right font-medium">Suggested</th>
 <th className="pb-2 text-right font-medium w-36">Paid</th>
 <th className="pb-2 text-right font-medium">Balance</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-border/50">
 {quarters.map((q, i) => {
 const paid = qPaidNums[i];
 const balance = suggested[i] - paid;
 const isPast = today > q.dueDate;
 return (
 <tr key={q.label} className={isPast && balance > 0.005 ?"text-warn-deep" :""}>
 <td className="py-2.5 font-medium">{q.label}</td>
 <td className="py-2.5 text-muted-foreground">{q.period}</td>
 <td className={`py-2.5 ${isPast ?"text-muted-foreground line-through" :""}`}>{q.dueLabel}</td>
 <td className="py-2.5 text-right tp-numeric">{formatCurrency(suggested[i])}</td>
 <td className="py-2.5 text-right">
 <div className="relative inline-flex items-center">
 <span className="pointer-events-none absolute left-2 tp-caption">$</span>
 <input
 type="text"
 inputMode="decimal"
 value={qPaid[i]}
 onChange={(e) => {
 const v = e.target.value;
 if (v ==="" || /^\d*\.?\d{0,2}$/.test(v)) updateQPaid(i as 0|1|2|3, v);
 }}
 placeholder="0"
 className="w-32 rounded-md border border-border py-1 pl-5 pr-2 text-right focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 </td>
 <td className={`py-2.5 text-right tp-numeric ${balance < -0.005 ?"text-up" : balance > 0.005 && isPast ?"text-warn" :""}`}>
 {balance < -0.005
 ? <span className="inline-flex items-center justify-end gap-1" title="Quarter satisfied — overpayment reduces final balance"><Check className="h-3 w-3" />{formatCurrency(0)}</span>
 : formatCurrency(Math.max(0, balance))}
 </td>
 </tr>
 );
 })}
 </tbody>
 <tfoot>
 <tr className="border-t-2 border-border font-semibold">
 <td className="pt-2.5" colSpan={3}>
 Est. balance due{withheldNum > 0 && <span className="font-normal text-muted-foreground"> (after {formatCurrency(withheldNum)} in withholding)</span>}
 </td>
 <td className="pt-2.5 text-right tabular-nums font-mono">{formatCurrency(netEstimated)}</td>
 <td className="pt-2.5 text-right tabular-nums font-mono">{formatCurrency(totalQPaid)}</td>
 <td className="pt-2.5 text-right tabular-nums font-mono">{formatCurrency(Math.max(0, netEstimated - totalQPaid))}</td>
 </tr>
 </tfoot>
 </table>

 {/* Summary */}
 <div className="rounded-lg border border-border bg-card p-4 space-y-1.5 text-13">
 {withheldNum > 0 && (
 <div className="flex justify-between text-muted-foreground">
 <span>Tax Withheld (W-2 / other)</span>
 <span className="tp-numeric">{formatCurrency(withheldNum)}</span>
 </div>
 )}
 <div className="flex justify-between text-muted-foreground">
 <span>Estimated Payments Made</span>
 <span className="tp-numeric">{formatCurrency(totalQPaid)}</span>
 </div>
 <div className="flex justify-between font-semibold border-t border-border pt-1.5 mt-1.5">
 <span>{netOwed >= 0 ?"Remaining Tax Owed" :"Estimated Refund"}</span>
 <StatValue>{formatCurrency(Math.abs(netOwed))}</StatValue>
 </div>
 </div>

 {/* Safe harbor status */}
 <div className={`flex items-start gap-2 rounded-md px-3 py-2.5 text-xs ${onTrack ?"bg-up-soft text-up-deep" :"bg-warn-soft text-warn-deep"}`}>
 <span className="mt-0.5 shrink-0">{onTrack ?"✓" :"!"}</span>
 <span>
 {onTrack
 ?`Total payments (${formatCurrency(totalPaid)}) cover ${(safeHarborPct * 100).toFixed(0)}% of estimated tax — IRS 90% safe harbor met.`
 :`Total payments (${formatCurrency(totalPaid)}) cover ${(safeHarborPct * 100).toFixed(0)}% of estimated tax. Completing all suggested payments reaches 100%, satisfying the 90% safe harbor.`}
 </span>
 </div>

 <p className="tp-caption">
 Suggested amounts assume four equal installments of your estimated balance after withholding.
 If your income is uneven across the year, the IRS annualized income installment method
 (Form 2210, Schedule AI) may reduce required early-quarter payments.
 Underpayment penalties accrue quarterly at the federal short-term rate + 3%.
 </p>

 <div className="flex justify-end">
 <Button onClick={() => { saveQuarterlyPayments(); setPaymentScheduleOpen(false); }}>Done</Button>
 </div>
 </div>
 );
 })()}
 </Modal>

 {/* CA Payment Schedule Modal */}
 <Modal
 open={caPaymentScheduleOpen}
 onClose={() => { saveQuarterlyPayments(); setCaPaymentScheduleOpen(false); }}
 title={`${useCaTmt ?"CA TMT" :"CA"}Payment Schedule · ${year}`}
 className="max-w-3xl"
 >
 {(() => {
 const caNetEstimated = Math.max(0, effectiveCaTax - caWithheldNum);
 // CA schedule: cumulative targets 30% / 70% / 70% (no Q3 payment) / 100%
 const caSuggested = caQuarters.map((q, i) => {
 if (q.noDue) return 0;
 const priorPaid = caQPaidNums.slice(0, i).reduce((s, v) => s + v, 0);
 return Math.max(0, caNetEstimated * q.cumulativePct - priorPaid);
 });
 const today = new Date();
 const caTotalPaid = caWithheldNum + totalCAQPaid;
 const caNetOwed = effectiveCaTax - caTotalPaid;
 const caSafeHarborPct = effectiveCaTax > 0 ? caTotalPaid / effectiveCaTax : 1;
 const caOnTrack = caSafeHarborPct >= 0.9;

 return (
 <div className="space-y-5">
 <table className="w-full text-13">
 <thead>
 <tr className="border-b border-border text-left tp-table-header">
 <th className="pb-2 font-medium">Quarter</th>
 <th className="pb-2 font-medium">Income Period</th>
 <th className="pb-2 font-medium">Due Date</th>
 <th className="pb-2 text-right font-medium">Suggested</th>
 <th className="pb-2 text-right font-medium w-36">Paid</th>
 <th className="pb-2 text-right font-medium">Balance</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-border/50">
 {caQuarters.map((q, i) => {
 const paid = caQPaidNums[i];
 const suggested = caSuggested[i];
 const balance = suggested - paid;
 const isPast = q.dueDate ? today > q.dueDate : false;
 return (
 <tr key={q.label} className={!q.noDue && isPast && balance > 0.005 ?"text-warn-deep" : q.noDue ?"text-muted-foreground" :""}>
 <td className="py-2.5 font-medium">{q.label}</td>
 <td className="py-2.5 text-muted-foreground">{q.period}</td>
 <td className={`py-2.5 ${!q.noDue && isPast ?"text-muted-foreground line-through" :""}`}>
 {q.noDue ? <span className="italic">No payment due</span> : q.dueLabel}
 </td>
 <td className="py-2.5 text-right tp-numeric">
 {q.noDue ? <span className="text-muted-foreground">—</span> : formatCurrency(suggested)}
 </td>
 <td className="py-2.5 text-right">
 {q.noDue ? (
 <span className="text-muted-foreground">—</span>
 ) : (
 <div className="relative inline-flex items-center">
 <span className="pointer-events-none absolute left-2 tp-caption">$</span>
 <input
 type="text"
 inputMode="decimal"
 value={caQPaid[i]}
 onChange={(e) => {
 const v = e.target.value;
 if (v ==="" || /^\d*\.?\d{0,2}$/.test(v)) updateCaQPaid(i as 0|1|2|3, v);
 }}
 placeholder="0"
 className="w-32 rounded-md border border-border py-1 pl-5 pr-2 text-right focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
 />
 </div>
 )}
 </td>
 <td className={`py-2.5 text-right tp-numeric ${!q.noDue && balance < -0.005 ?"text-up" : !q.noDue && balance > 0.005 && isPast ?"text-warn" :""}`}>
 {q.noDue ? (
 <span className="text-muted-foreground">—</span>
 ) : balance < -0.005 ? (
 <span className="inline-flex items-center justify-end gap-1" title="Quarter satisfied — overpayment reduces final balance">
 <Check className="h-3 w-3" />{formatCurrency(0)}
 </span>
 ) : (
 formatCurrency(Math.max(0, balance))
 )}
 </td>
 </tr>
 );
 })}
 </tbody>
 <tfoot>
 <tr className="border-t-2 border-border font-semibold">
 <td className="pt-2.5" colSpan={3}>
 Est. balance due{caWithheldNum > 0 && <span className="font-normal text-muted-foreground"> (after {formatCurrency(caWithheldNum)} in withholding)</span>}
 </td>
 <td className="pt-2.5 text-right tabular-nums font-mono">{formatCurrency(caNetEstimated)}</td>
 <td className="pt-2.5 text-right tabular-nums font-mono">{formatCurrency(totalCAQPaid)}</td>
 <td className="pt-2.5 text-right tabular-nums font-mono">{formatCurrency(Math.max(0, caNetEstimated - totalCAQPaid))}</td>
 </tr>
 </tfoot>
 </table>

 {/* Summary */}
 <div className="rounded-lg border border-border bg-card p-4 space-y-1.5 text-13">
 {caWithheldNum > 0 && (
 <div className="flex justify-between text-muted-foreground">
 <span>CA Tax Withheld</span>
 <span className="tp-numeric">{formatCurrency(caWithheldNum)}</span>
 </div>
 )}
 <div className="flex justify-between text-muted-foreground">
 <span>Estimated Payments Made</span>
 <span className="tp-numeric">{formatCurrency(totalCAQPaid)}</span>
 </div>
 <div className="flex justify-between font-semibold border-t border-border pt-1.5 mt-1.5">
 <span>{caNetOwed >= 0 ?"Remaining Tax Owed" :"Estimated Refund"}</span>
 <StatValue>{formatCurrency(Math.abs(caNetOwed))}</StatValue>
 </div>
 </div>

 {/* Safe harbor status */}
 <div className={`flex items-start gap-2 rounded-md px-3 py-2.5 text-xs ${caOnTrack ?"bg-up-soft text-up-deep" :"bg-warn-soft text-warn-deep"}`}>
 <span className="mt-0.5 shrink-0">{caOnTrack ?"✓" :"!"}</span>
 <span>
 {caOnTrack
 ?`Total payments (${formatCurrency(caTotalPaid)}) cover ${(caSafeHarborPct * 100).toFixed(0)}% of estimated CA tax — 90% safe harbor met.`
 :`Total payments (${formatCurrency(caTotalPaid)}) cover ${(caSafeHarborPct * 100).toFixed(0)}% of estimated CA tax. Completing all suggested payments reaches 100%, satisfying the 90% safe harbor.`}
 </span>
 </div>

 <p className="tp-caption">
 California's installment schedule is 30% / 40% / 0% / 30% — no payment is due in Q3 (September).
 Suggested amounts use the cumulative catch-up method, so future quarters automatically adjust
 as additional income is recorded. Safe harbor: 90% of current-year CA tax or 100% of prior-year CA tax.
 </p>

 <div className="flex justify-end">
 <Button onClick={() => { saveQuarterlyPayments(); setCaPaymentScheduleOpen(false); }}>Done</Button>
 </div>
 </div>
 );
 })()}
 </Modal>

 {/* Stat strip */}
 <div className="grid grid-cols-3 gap-3">
 <div className="relative rounded-lg border border-border bg-card p-6 shadow-card before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-px before:rounded-t-lg before:pointer-events-none before:bg-gradient-to-r before:from-transparent before:via-white/85 before:to-transparent">
 <p className="tp-eyebrow">Total Income (MAGI)</p>
 <DisplayStat as="p" className="mt-1 tp-stat">{formatCurrency(calc.magi)}</DisplayStat>
 </div>
 <div className="relative rounded-lg border border-border bg-card p-6 shadow-card before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-px before:rounded-t-lg before:pointer-events-none before:bg-gradient-to-r before:from-transparent before:via-white/85 before:to-transparent">
 <p className="tp-eyebrow flex items-center gap-1.5">
 Estimated Federal Tax
 {useTmt && <span className="rounded px-1.5 py-0.5 text-10 font-semibold bg-violet-soft text-violet-deep">TMT</span>}
 </p>
 <DisplayStat as="p" className="mt-1 tp-stat">{formatCurrency(effectiveFederalTax)}</DisplayStat>
 {(withheldNum > 0 || totalQPaid > 0) && (() => {
 const netOwed = effectiveFederalTax - withheldNum - totalQPaid;
 const suffix = withheldNum > 0 && totalQPaid > 0
 ?"after withholding & payments"
 : totalQPaid > 0 ?"after est. payments" :"after withholding";
 return (
 <p className={`mt-1 text-xs font-medium tabular-nums font-mono ${netOwed >= 0 ?"text-warn" :"text-up"}`}>
 {netOwed >= 0
 ?`${formatCurrency(netOwed)} owed ${suffix}`
 :`${formatCurrency(Math.abs(netOwed))} refund ${suffix}`}
 </p>
 );
 })()}
 </div>
 <div className="relative rounded-lg border border-border bg-card p-6 shadow-card before:content-[''] before:absolute before:inset-x-0 before:top-0 before:h-px before:rounded-t-lg before:pointer-events-none before:bg-gradient-to-r before:from-transparent before:via-white/85 before:to-transparent">
 <p className="tp-eyebrow flex items-center gap-1.5">
 Estimated State Tax <span className="text-muted-foreground/60">(CA)</span>
 {useCaTmt && <span className="rounded px-1.5 py-0.5 text-10 font-semibold bg-violet-soft text-violet-deep">TMT</span>}
 </p>
 <DisplayStat as="p" className="mt-1 tp-stat">{formatCurrency(effectiveCaTax)}</DisplayStat>
 {(caWithheldNum > 0 || totalCAQPaid > 0) && (() => {
 const netOwed = effectiveCaTax - caWithheldNum - totalCAQPaid;
 const suffix = caWithheldNum > 0 && totalCAQPaid > 0
 ?"after withholding & payments"
 : totalCAQPaid > 0 ?"after est. payments" :"after withholding";
 return (
 <p className={`mt-1 text-xs font-medium tabular-nums font-mono ${netOwed >= 0 ?"text-warn" :"text-up"}`}>
 {netOwed >= 0
 ?`${formatCurrency(netOwed)} owed ${suffix}`
 :`${formatCurrency(Math.abs(netOwed))} refund ${suffix}`}
 </p>
 );
 })()}
 </div>
 </div>

 {/* Tax Summary */}
 <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
 {/* Income breakdown */}
 <Card>
 <h3 className="mb-4 flex items-center gap-2 tp-card-title">
 <Layers className="h-4 w-4 text-muted-foreground" />
 Income Breakdown
 </h3>
 <div className="space-y-3 text-13">

 {/* ── Ordinary ── */}
 {(otherOrdinaryNum !== 0 || calc.ordinaryFromApp !== 0 || calc.rawSTCG !== 0 || calc.rawCollectibleLTCG !== 0) && (
 <div className="flex gap-1">
 <div className="flex shrink-0 items-center justify-center w-5">
 <SectionLabel as="span"
 className="text-10 text-warn select-none"
 style={{ writingMode:"vertical-rl", transform:"rotate(180deg)" }}
 >
 Ordinary
 </SectionLabel>
 </div>
 <div className="flex-1 border-l-2 border-warn-line pl-3">
 {calc.ordinaryFromApp !== 0 && (
 <div className="flex items-baseline gap-1.5 py-1.5">
 <span className="shrink-0">Ordinary Income</span>
 <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage:"radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize:"5px 100%", backgroundRepeat:"repeat-x" }} />
 <span className="shrink-0 tp-numeric">{formatCurrency(calc.ordinaryFromApp)}</span>
 </div>
 )}
 {calc.rawSTCG !== 0 && (
 <div className="flex items-baseline gap-1.5 py-1.5">
 <span className="shrink-0">
 Short-Term Capital Gains
 {calc.rawSTCG < 0 && <span className="ml-1 tp-caption">(loss)</span>}
 </span>
 <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage:"radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize:"5px 100%", backgroundRepeat:"repeat-x" }} />
 <span className={`shrink-0 tp-numeric ${calc.rawSTCG < 0 ?"text-down" :""}`}>
 {calc.rawSTCG < 0 ?"-" :""}{formatCurrency(Math.abs(calc.rawSTCG))}
 </span>
 </div>
 )}
 {calc.rawCollectibleLTCG !== 0 && (
 <div className="flex items-baseline gap-1.5 py-1.5">
 <span className="shrink-0">
 Collectible Gains
 <span className="ml-1 tp-caption">(28% max rate)</span>
 {calc.rawCollectibleLTCG < 0 && <span className="ml-1 tp-caption">(loss)</span>}
 </span>
 <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage:"radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize:"5px 100%", backgroundRepeat:"repeat-x" }} />
 <span className={`shrink-0 tp-numeric ${calc.rawCollectibleLTCG < 0 ?"text-down" :""}`}>
 {calc.rawCollectibleLTCG < 0 ?"-" :""}{formatCurrency(Math.abs(calc.rawCollectibleLTCG))}
 </span>
 </div>
 )}
 {otherOrdinaryNum !== 0 && (
 <div className="flex items-baseline gap-1.5 py-1.5">
 <span className="shrink-0">
 Other Ordinary Income
 <button
 type="button"
 onClick={() => { setFocusOnOpen("ordinary"); setAssumptionsOpen(true); }}
 className="ml-1.5 text-xs text-primary hover:underline"
 >
 Edit
 </button>
 </span>
 <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage:"radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize:"5px 100%", backgroundRepeat:"repeat-x" }} />
 <span className="shrink-0 tp-numeric">{formatCurrency(otherOrdinaryNum)}</span>
 </div>
 )}
 </div>
 </div>
 )}

 {/* ── LT ── */}
 {(calc.qualDivFromApp !== 0 || calc.rawLTCG !== 0 || otherLTCGNum !== 0) && (
 <div className="flex gap-1">
 <div className="flex shrink-0 items-center justify-center w-5">
 <SectionLabel as="span"
 className="text-10 text-up select-none"
 style={{ writingMode:"vertical-rl", transform:"rotate(180deg)" }}
 >
 LT
 </SectionLabel>
 </div>
 <div className="flex-1 border-l-2 border-up-line pl-3">
 {calc.qualDivFromApp !== 0 && (
 <div className="flex items-baseline gap-1.5 py-1.5">
 <span className="shrink-0">Qualified Dividends</span>
 <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage:"radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize:"5px 100%", backgroundRepeat:"repeat-x" }} />
 <span className="shrink-0 tp-numeric">{formatCurrency(calc.qualDivFromApp)}</span>
 </div>
 )}
 {calc.rawLTCG !== 0 && (
 <div className="flex items-baseline gap-1.5 py-1.5">
 <span className="shrink-0">
 Long-Term Capital Gains
 {calc.rawLTCG < 0 && <span className="ml-1 tp-caption">(loss)</span>}
 </span>
 <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage:"radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize:"5px 100%", backgroundRepeat:"repeat-x" }} />
 <span className={`shrink-0 tp-numeric ${calc.rawLTCG < 0 ?"text-down" :""}`}>
 {calc.rawLTCG < 0 ?"-" :""}{formatCurrency(Math.abs(calc.rawLTCG))}
 </span>
 </div>
 )}
 {otherLTCGNum !== 0 && (
 <div className="flex items-baseline gap-1.5 py-1.5">
 <span className="shrink-0">
 {otherLTCGNum < 0 ?"Other Long-Term Capital Losses" :"Other Long-Term Capital Gains"}
 <button
 type="button"
 onClick={() => { setFocusOnOpen("ltcg"); setAssumptionsOpen(true); }}
 className="ml-1.5 text-xs text-primary hover:underline"
 >
 Edit
 </button>
 </span>
 <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage:"radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize:"5px 100%", backgroundRepeat:"repeat-x" }} />
 <span className={`shrink-0 tp-numeric ${otherLTCGNum < 0 ?"text-down" :""}`}>
 {otherLTCGNum < 0 ?"-" :""}{formatCurrency(Math.abs(otherLTCGNum))}
 </span>
 </div>
 )}
 </div>
 </div>
 )}

 {/* ── $0 (non-taxable) ── */}
 {(calc.exemptFromApp !== 0 || calc.rocFromApp !== 0) && (
 <div className="flex gap-1">
 <div className="flex shrink-0 items-center justify-center w-5">
 <SectionLabel as="span"
 className="text-10 text-slate select-none"
 style={{ writingMode:"vertical-rl", transform:"rotate(180deg)" }}
 >
 $0
 </SectionLabel>
 </div>
 <div className="flex-1 border-l-2 border-slate-soft pl-3 text-muted-foreground">
 {calc.exemptFromApp !== 0 && (
 <div className="flex items-baseline gap-1.5 py-1.5">
 <span className="shrink-0">Tax-Exempt Income</span>
 <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage:"radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize:"5px 100%", backgroundRepeat:"repeat-x" }} />
 <span className="shrink-0 tp-numeric">{formatCurrency(calc.exemptFromApp)}</span>
 </div>
 )}
 {calc.rocFromApp !== 0 && (
 <div className="flex items-baseline gap-1.5 py-1.5">
 <span className="shrink-0">Return of Capital</span>
 <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage:"radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize:"5px 100%", backgroundRepeat:"repeat-x" }} />
 <span className="shrink-0 tp-numeric">{formatCurrency(calc.rocFromApp)}</span>
 </div>
 )}
 </div>
 </div>
 )}

 </div>

 {/* Standard deduction + total — adapts to active tab and TMT mode */}
 {(() => {
 const isCa = taxBreakdownTab ==="ca";
 const isCaTmt = isCa && useCaTmt;
 const isFedTmt = !isCa && useTmt;

 const deductionLabel = isCaTmt ?"AMT Exemption"
 : isFedTmt ?"AMT Exemption"
 :"Standard Deduction";
 const deductionAmt = isCaTmt ? caTmtCalc.effectiveExemp
 : isFedTmt ? amtCalc.effectiveExemp
 : isCa ? caCalc.caStdDed
 : calc.stdDeduction;
 const isPhaseOut = isCaTmt
 ? caTmtCalc.effectiveExemp < CA_AMT_EXEMPTION[filingStatus]
 : isFedTmt
 ? amtCalc.effectiveExemp < AMT_EXEMPTION[filingStatus]
 : false;

 const totalLabel = (isCaTmt || isFedTmt) ?"Alternative Minimum Taxable Income" :"Total Taxable Income";
 const totalAmt = isCaTmt ? caTmtCalc.taxableCaAmti
 : isFedTmt ? amtCalc.amti
 : isCa ? caCalc.caTaxable
 : calc.taxableOrdinary + calc.taxablePreferential + calc.collectibleContrib;

 return (
 <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-13">
 <div className="flex justify-between text-muted-foreground">
 <span className="flex items-center gap-1.5">
 {deductionLabel}
 {isCa && <span className="rounded px-1.5 py-0.5 text-10 font-semibold bg-sky-soft text-sky-deep">CA</span>}
 {(isCaTmt || isFedTmt) && <span className="rounded px-1.5 py-0.5 text-10 font-semibold bg-violet-soft text-violet-deep">TMT</span>}
 {isPhaseOut && <span className="text-xs italic">(partially phased out)</span>}
 </span>
 <span className="text-down tp-numeric">-{formatCurrency(deductionAmt)}</span>
 </div>
 <div className="flex justify-between font-semibold">
 <span className="flex items-center gap-1.5">
 {totalLabel}
 {isCa && <span className="rounded px-1.5 py-0.5 text-10 font-semibold bg-sky-soft text-sky-deep">CA</span>}
 {(isCaTmt || isFedTmt) && <span className="rounded px-1.5 py-0.5 text-10 font-semibold bg-violet-soft text-violet-deep">TMT</span>}
 </span>
 <span className="tabular-nums font-mono">{formatCurrency(totalAmt)}</span>
 </div>
 </div>
 );
 })()}

 {calc.hasCapLoss && (
 <p className="mt-3 text-xs text-warn">
 Capital loss of {formatCurrency(Math.abs(calc.stcgOrdinaryContrib + calc.ltcgContrib - calc.rawSTCG - calc.rawLTCG - otherLTCGNum) + Math.max(0, -calc.rawCollectibleLTCG))} exceeds gains.
 Up to {formatCurrency(3000)} is deductible against ordinary income this year; excess carries forward.
 </p>
 )}
 </Card>

 {/* Tax breakdown */}
 <Card>
 {/* Tab strip */}
 <div className="mb-4 flex items-center gap-3">
 <Landmark className="h-4 w-4 shrink-0 text-muted-foreground" />
 <div className="flex items-center gap-0.5 rounded-lg bg-secondary p-0.5 text-xs font-medium">
 <button
 type="button"
 onClick={() => setTaxBreakdownTab("federal")}
 className={`rounded-md px-2.5 py-1 transition-colors ${taxBreakdownTab ==="federal" ?"bg-background text-foreground shadow-sm" :"text-muted-foreground hover:text-foreground"}`}
 >
 Federal
 </button>
 <button
 type="button"
 onClick={() => setTaxBreakdownTab("ca")}
 className={`rounded-md px-2.5 py-1 transition-colors ${taxBreakdownTab ==="ca" ?"bg-background text-foreground shadow-sm" :"text-muted-foreground hover:text-foreground"}`}
 >
 California
 </button>
 </div>
 {taxBreakdownTab ==="federal" && (
 <button
 type="button"
 onClick={() => setUseTmt((v) => { const next = !v; updateTaxAssumptions(year, { useTmt: next }); return next; })}
 className={`ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${useTmt ?"border-violet-soft bg-violet-soft text-violet-deep" :"border-border text-muted-foreground hover:border-violet-soft hover:text-violet-deep"}`}
 >
 <span className={`inline-block h-3.5 w-6 rounded-full transition-colors ${useTmt ?"bg-violet" :"bg-muted-foreground/30"}`}>
 <span className={`block h-3 w-3 translate-y-[1px] rounded-full bg-white shadow transition-transform ${useTmt ?"translate-x-[13px]" :"translate-x-[1px]"}`} />
 </span>
 Use TMT
 </button>
 )}
 {taxBreakdownTab ==="ca" && (
 <button
 type="button"
 onClick={() => setUseCaTmt((v) => { const next = !v; updateTaxAssumptions(year, { useCaTmt: next }); return next; })}
 className={`ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${useCaTmt ?"border-violet-soft bg-violet-soft text-violet-deep" :"border-border text-muted-foreground hover:border-violet-soft hover:text-violet-deep"}`}
 >
 <span className={`inline-block h-3.5 w-6 rounded-full transition-colors ${useCaTmt ?"bg-violet" :"bg-muted-foreground/30"}`}>
 <span className={`block h-3 w-3 translate-y-[1px] rounded-full bg-white shadow transition-transform ${useCaTmt ?"translate-x-[13px]" :"translate-x-[1px]"}`} />
 </span>
 Use TMT
 </button>
 )}
 </div>
 {/* ── Federal tab ── */}
 {taxBreakdownTab ==="federal" && <>{!useTmt && <table className="w-full text-13">
 <thead>
 <tr className="border-b border-border text-left tp-table-header">
 <th className="pb-2 font-medium">Component</th>
 <th className="pb-2 text-right font-medium w-20">Rate</th>
 <th className="pb-2 text-right font-medium w-36">Tax</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-border/50">
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-2">
 <Briefcase className="h-3.5 w-3.5 shrink-0 text-warn" />
 Ordinary Income Tax
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(calc.taxableOrdinary)} taxable</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">
 up to {fmtPct(calc.marginalOrdRate)}
 </td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(calc.ordinaryTax)}</td>
 </tr>
 {calc.taxablePreferential > 0 && (
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-2">
 <TrendingUp className="h-3.5 w-3.5 shrink-0 text-up" />
 Capital Gains / Qualified Dividends Tax
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(calc.taxablePreferential)} taxable</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">
 up to {fmtPct(calc.marginalPrefRate)}
 </td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(calc.preferentialTax)}</td>
 </tr>
 )}
 {calc.collectibleContrib > 0 && (
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-2">
 <TrendingUp className="h-3.5 w-3.5 shrink-0 text-orange-deep" />
 Collectible Gains Tax
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(calc.collectibleContrib)} taxable</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">
 {fmtPct(calc.collectibleRate)}
 </td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(calc.collectibleTax)}</td>
 </tr>
 )}
 {calc.niitBase > 0 && (
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-1.5">
 <Activity className="h-3.5 w-3.5 shrink-0 text-blue" />
 Net Investment Income Tax
 <span className="group relative">
 <CircleQuestionMark className="h-3.5 w-3.5 cursor-default text-muted-foreground/60" />
 <span className="pointer-events-none invisible absolute bottom-full left-1/2 mb-2 w-64 -translate-x-1/2 rounded-md border border-border bg-background px-3 py-2 tp-caption opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100">
 <span className="block"><span className="font-medium text-foreground">MAGI:</span> {formatCurrency(calc.magi)}</span>
 <span className="mt-1.5 block">
 {calc.magi > NIIT_THRESHOLD[filingStatus]
 ? <><span className="font-medium text-foreground">{formatCurrency(calc.magi - NIIT_THRESHOLD[filingStatus])}</span> above the {formatCurrency(NIIT_THRESHOLD[filingStatus])} threshold</>
 : <><span className="font-medium text-foreground">{formatCurrency(NIIT_THRESHOLD[filingStatus] - calc.magi)}</span> below the {formatCurrency(NIIT_THRESHOLD[filingStatus])} threshold</>}
 </span>
 <span className="mt-1.5 block">{formatCurrency(calc.niitBase)} of net investment income subject to 3.8% NIIT</span>
 </span>
 </span>
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(calc.niitBase)} subject to NIIT</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">3.8%</td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(calc.niitTax)}</td>
 </tr>
 )}
 <tr className="border-t-2 border-border font-bold text-base">
 <td className="pt-2">Total Estimated Tax</td>
 <td className="pt-2 text-right text-13 font-medium text-muted-foreground">
 {(calc.effectiveRate * 100).toFixed(1)}% eff.
 </td>
 <td className="pt-2 text-right font-mono tabular-nums">{formatCurrency(calc.totalTax)}</td>
 </tr>
 </tbody>
 </table>}
 {useTmt && <>
 <table className="w-full text-13">
 <thead>
 <tr className="border-b border-border text-left tp-table-header">
 <th className="pb-2 font-medium">Component</th>
 <th className="pb-2 text-right font-medium w-20">Rate</th>
 <th className="pb-2 text-right font-medium w-36">Tax</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-border/50">
 {amtCalc.amtiOrdinary > 0 && (
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-2">
 <Briefcase className="h-3.5 w-3.5 shrink-0 text-warn" />
 Ordinary AMT Income Tax
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(amtCalc.amtiOrdinary)} taxable</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">up to {fmtPct(amtCalc.amtMargOrdRate)}</td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(amtCalc.amtOrdTax)}</td>
 </tr>
 )}
 {amtCalc.amtiPreferential > 0 && (
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-2">
 <TrendingUp className="h-3.5 w-3.5 shrink-0 text-up" />
 Capital Gains / Qualified Dividends Tax
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(amtCalc.amtiPreferential)} taxable</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">up to {fmtPct(marginalLTCGRate(amtCalc.amtiOrdinary + amtCalc.amtiPreferential, LTCG_BRACKETS[filingStatus]))}</td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(amtCalc.amtPrefTax)}</td>
 </tr>
 )}
 {amtCalc.amtiCollectible > 0 && (
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-2">
 <TrendingUp className="h-3.5 w-3.5 shrink-0 text-orange-deep" />
 Collectible Gains Tax
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(amtCalc.amtiCollectible)} taxable</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">{fmtPct(amtCalc.amtCollRate)}</td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(amtCalc.amtCollTax)}</td>
 </tr>
 )}
 {calc.niitBase > 0 && (
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-1.5">
 <Activity className="h-3.5 w-3.5 shrink-0 text-blue" />
 Net Investment Income Tax
 <span className="group relative">
 <span className="flex h-3.5 w-3.5 cursor-default items-center justify-center rounded-full border border-muted-foreground/40 text-[9px] font-bold leading-none text-muted-foreground">
 ?
 </span>
 <span className="pointer-events-none invisible absolute bottom-full left-1/2 mb-2 w-64 -translate-x-1/2 rounded-md border border-border bg-background px-3 py-2 tp-caption opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100">
 <span className="block"><span className="font-medium text-foreground">MAGI:</span> {formatCurrency(calc.magi)}</span>
 <span className="mt-1.5 block">
 {calc.magi > NIIT_THRESHOLD[filingStatus]
 ? <><span className="font-medium text-foreground">{formatCurrency(calc.magi - NIIT_THRESHOLD[filingStatus])}</span> above the {formatCurrency(NIIT_THRESHOLD[filingStatus])} threshold</>
 : <><span className="font-medium text-foreground">{formatCurrency(NIIT_THRESHOLD[filingStatus] - calc.magi)}</span> below the {formatCurrency(NIIT_THRESHOLD[filingStatus])} threshold</>}
 </span>
 <span className="mt-1.5 block">{formatCurrency(calc.niitBase)} of net investment income subject to 3.8% NIIT</span>
 </span>
 </span>
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(calc.niitBase)} subject to NIIT</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">3.8%</td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(calc.niitTax)}</td>
 </tr>
 )}
 <tr className="border-t-2 border-border font-bold text-base">
 <td className="pt-2">Total Estimated Tax</td>
 <td className="pt-2 text-right text-13 font-medium text-muted-foreground">
 {amtCalc.amtiGross > 0 ?`${((amtCalc.tmtTotal / amtCalc.amtiGross) * 100).toFixed(1)}% eff.` :"—"}
 </td>
 <td className="pt-2 text-right font-mono tabular-nums">{formatCurrency(amtCalc.tmtTotal)}</td>
 </tr>
 </tbody>
 </table>
 {/* Comparison note */}
 <div className={`mt-3 rounded-md px-3 py-2.5 text-xs ${amtCalc.potentialCredit > 0 ?"bg-violet-soft text-violet-deep" :"bg-warn-soft text-warn-deep"}`}>
 {amtCalc.potentialCredit > 0
 ? <>TMT income tax ({formatCurrency(amtCalc.tmt)}) is <span className="font-semibold">{formatCurrency(amtCalc.potentialCredit)}</span> less than regular income tax ({formatCurrency(calc.totalTax - calc.niitTax)}). With sufficient prior-year AMT credits, your federal liability could be reduced to <span className="font-semibold">{formatCurrency(amtCalc.tmtTotal)}</span>{calc.niitTax > 0 ? <> ({formatCurrency(amtCalc.tmt)} TMT + {formatCurrency(calc.niitTax)} NIIT)</> :""}.</>
 : <>TMT income tax ({formatCurrency(amtCalc.tmt)}) exceeds regular income tax ({formatCurrency(calc.totalTax - calc.niitTax)}) by <span className="font-semibold">{formatCurrency(amtCalc.amtSurcharge)}</span>. AMT applies this year — prior-year credits cannot be used.</>}
 </div>
 </>}
 {(withheldNum > 0 || totalQPaid > 0) && (() => {
 const netOwed = effectiveFederalTax - withheldNum - totalQPaid;
 return (
 <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-13">
 {withheldNum > 0 && (
 <div className="flex justify-between text-muted-foreground">
 <span>Less: Tax Withheld</span>
 <span className="text-down tp-numeric">-{formatCurrency(withheldNum)}</span>
 </div>
 )}
 {totalQPaid > 0 && (
 <div className="flex justify-between text-muted-foreground">
 <span>Less: Estimated Payments</span>
 <span className="text-down tp-numeric">-{formatCurrency(totalQPaid)}</span>
 </div>
 )}
 <div className="flex justify-between font-semibold">
 <span>{netOwed >= 0 ? (useTmt ?"Net TMT Owed" :"Net Tax Owed") :"Estimated Refund"}</span>
 <span className="text-foreground tabular-nums font-mono">{formatCurrency(Math.abs(netOwed))}</span>
 </div>
 </div>
 );
 })()}
 <div className="mt-3 border-t border-border pt-3">
 <button
 type="button"
 onClick={() => setPaymentScheduleOpen(true)}
 className="flex items-center gap-1.5 text-xs text-primary hover:underline"
 >
 <CalendarCheck2 className="h-3.5 w-3.5" />
 Payment schedule
 </button>
 </div></>}

 {/* ── California tab ── */}
 {taxBreakdownTab ==="ca" && <>
 {/* Regular CA tax table */}
 {!useCaTmt && <table className="w-full text-13">
 <thead>
 <tr className="border-b border-border text-left tp-table-header">
 <th className="pb-2 font-medium">Component</th>
 <th className="pb-2 text-right font-medium w-20">Rate</th>
 <th className="pb-2 text-right font-medium w-36">Tax</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-border/50">
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-2">
 <Briefcase className="h-3.5 w-3.5 shrink-0 text-warn" />
 CA Income Tax
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(caCalc.caTaxable)} taxable</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">
 up to {fmtPct(marginalOrdinaryRate(caCalc.caTaxable, CA_ORDINARY_BRACKETS[filingStatus]))}
 </td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(caCalc.caOrdTax)}</td>
 </tr>
 {caCalc.caMhstBase > 0 && (
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-2">
 <Activity className="h-3.5 w-3.5 shrink-0 text-blue" />
 Mental Health Services Tax
 </div>
 <div className="ml-[1.375rem] tp-caption">{formatCurrency(caCalc.caMhstBase)} above $1M threshold</div>
 </td>
 <td className="py-2 text-right text-muted-foreground">1%</td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(caCalc.caMhstTax)}</td>
 </tr>
 )}
 <tr className="border-t-2 border-border font-bold text-base">
 <td className="pt-2">Total Estimated Tax</td>
 <td className="pt-2 text-right text-13 font-medium text-muted-foreground">
 {(caCalc.caEffRate * 100).toFixed(1)}% eff.
 </td>
 <td className="pt-2 text-right font-mono tabular-nums">{formatCurrency(caCalc.caTotalTax)}</td>
 </tr>
 </tbody>
 </table>}
 {/* CA TMT table */}
 {useCaTmt && <>
 <table className="w-full text-13">
 <thead>
 <tr className="border-b border-border text-left tp-table-header">
 <th className="pb-2 font-medium">Component</th>
 <th className="pb-2 text-right font-medium w-20">Rate</th>
 <th className="pb-2 text-right font-medium w-36">Tax</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-border/50">
 <tr>
 <td className="py-2">
 <div className="flex items-center gap-2">
 <Briefcase className="h-3.5 w-3.5 shrink-0 text-warn" />
 CA AMT Income Tax
 </div>
 <div className="ml-[1.375rem] tp-caption">
 {formatCurrency(caTmtCalc.taxableCaAmti)} taxable
 </div>
 </td>
 <td className="py-2 text-right text-muted-foreground">7%</td>
 <td className="py-2 text-right tp-numeric">{formatCurrency(caTmtCalc.caTmt)}</td>
 </tr>
 <tr className="border-t-2 border-border font-bold text-base">
 <td className="pt-2">Tentative Minimum Tax</td>
 <td className="pt-2 text-right text-13 font-medium text-muted-foreground">
 {caTmtCalc.caAmti > 0 ?`${((caTmtCalc.caTmt / caTmtCalc.caAmti) * 100).toFixed(1)}% eff.` :"—"}
 </td>
 <td className="pt-2 text-right font-mono tabular-nums">{formatCurrency(caTmtCalc.caTmt)}</td>
 </tr>
 </tbody>
 </table>
 {/* Comparison note */}
 <div className={`mt-3 rounded-md px-3 py-2.5 text-xs ${caTmtCalc.potentialCredit > 0 ?"bg-violet-soft text-violet-deep" :"bg-warn-soft text-warn-deep"}`}>
 {caTmtCalc.potentialCredit > 0
 ? <>CA TMT is <span className="font-semibold">{formatCurrency(caTmtCalc.potentialCredit)}</span> less than your regular CA tax of {formatCurrency(caCalc.caTotalTax)}. With sufficient prior-year CA AMT credits, your state liability could be reduced to <span className="font-semibold">{formatCurrency(caTmtCalc.caTmt)}</span>.</>
 : <>CA TMT ({formatCurrency(caTmtCalc.caTmt)}) exceeds regular CA tax ({formatCurrency(caCalc.caTotalTax)}) by <span className="font-semibold">{formatCurrency(caTmtCalc.amtSurcharge)}</span>. CA AMT applies this year — prior-year CA AMT credits cannot be used.</>}
 </div>
 </>}
 {(caWithheldNum > 0 || totalCAQPaid > 0) && (() => {
 const netOwed = effectiveCaTax - caWithheldNum - totalCAQPaid;
 return (
 <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-13">
 {caWithheldNum > 0 && (
 <div className="flex justify-between text-muted-foreground">
 <span>Less: CA Tax Withheld</span>
 <span className="text-down tp-numeric">-{formatCurrency(caWithheldNum)}</span>
 </div>
 )}
 {totalCAQPaid > 0 && (
 <div className="flex justify-between text-muted-foreground">
 <span>Less: Estimated Payments</span>
 <span className="text-down tp-numeric">-{formatCurrency(totalCAQPaid)}</span>
 </div>
 )}
 <div className="flex justify-between font-semibold">
 <span>{netOwed >= 0 ? (useCaTmt ?"Net CA TMT Owed" :"Net Tax Owed") :"Estimated Refund"}</span>
 <span className="text-foreground tabular-nums font-mono">{formatCurrency(Math.abs(netOwed))}</span>
 </div>
 </div>
 );
 })()}
 <div className="mt-3 border-t border-border pt-3 flex items-center justify-between gap-4">
 <button
 type="button"
 onClick={() => setCaPaymentScheduleOpen(true)}
 className="flex items-center gap-1.5 text-xs text-primary hover:underline"
 >
 <CalendarCheck2 className="h-3.5 w-3.5" />
 Payment schedule
 </button>
 <p className="tp-caption text-right">
 2025 CA brackets · All capital gains taxed as ordinary income
 </p>
 </div>
 </>}
 </Card>
 </div>

 {/* Detailed Breakdown */}
 {loading ? (
 <Card><p className="text-muted-foreground">Loading income records…</p></Card>
 ) : incomes.length === 0 ? (
 <Card><p className="text-muted-foreground">No income records found for {year}.</p></Card>
 ) : (
 <div className="space-y-3">
 <h3 className="tp-card-title">Income Detail by Category</h3>
 {categorySections.map((section) => {
 const sectionKey = section.categoryName;
 const isExpanded = expandedSections.has(sectionKey);
 const sectionOrdinaryAmt = section.groups.reduce((sum, g) => {
 if (g.bucket ==="ordinary") return sum + g.totalTaxable;
 if (g.bucket ==="capital_gain") return sum + Math.max(0, g.stcgTotal ?? 0);
 return sum;
 }, 0);
 const sectionPreferentialAmt = section.groups.reduce((sum, g) => {
 if (g.bucket ==="qualified_dividend") return sum + g.totalTaxable;
 if (g.bucket ==="capital_gain") return sum + Math.max(0, g.ltcgTotal ?? 0);
 return sum;
 }, 0);
 const sectionCollectibleAmt = section.groups.reduce((sum, g) => {
 if (g.bucket ==="capital_gain") return sum + Math.max(0, g.collectibleLtcgTotal ?? 0);
 return sum;
 }, 0);

 return (
 <Card key={sectionKey} className="overflow-hidden p-0">
 {/* Category header */}
 <button
 type="button"
 onClick={() => toggleSection(sectionKey)}
 className="flex w-full items-center gap-4 px-6 py-3 hover:bg-muted transition-colors text-left"
 >
 <span className="flex-1 tp-panel-title">{section.categoryName}</span>
 {(anyOrdinaryInSections || (anyCollectibleInSections && !showCollectibleSeparately)) && (
 <span className="w-[220px] shrink-0 text-right text-muted-foreground tp-numeric">
 {(() => {
 const amt = sectionOrdinaryAmt + (!showCollectibleSeparately ? sectionCollectibleAmt : 0);
 return amt > 0 ? <>{formatCurrency(amt)} <span className="text-xs">@ {fmtPct(calc.marginalOrdRate)} ordinary</span></> : null;
 })()}
 </span>
 )}
 {showCollectibleSeparately && (
 <span className="w-[240px] shrink-0 text-right text-muted-foreground tp-numeric">
 {sectionCollectibleAmt > 0 && (
 <>{formatCurrency(sectionCollectibleAmt)} <span className="text-xs">@ {fmtPct(calc.collectibleRate)} collectible</span></>
 )}
 </span>
 )}
 {anyPreferentialInSections && (
 <span className="w-[280px] shrink-0 text-right text-muted-foreground tp-numeric">
 {sectionPreferentialAmt > 0 && (
 <>{formatCurrency(sectionPreferentialAmt)} <span className="text-xs">@ {fmtPct(calc.marginalPrefRate)} LT capital gains</span></>
 )}
 </span>
 )}
 {isExpanded ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
 </button>

 {isExpanded && (
 <div className="border-t border-border divide-y divide-border">
 {section.groups.map((group) => (
 <div key={group.label} className="px-6 py-3">
 {/* Group subheader */}
 <div className="mb-2 flex items-center gap-2">
 <SectionLabel as="span">
 {group.label}
 </SectionLabel>
 </div>

 {/* Transactions table */}
 <div className="hidden md:block">
 <table className="w-full table-fixed text-13">
 <colgroup>
 <col className="w-[100px]" /> {/* Date */}
 <col /> {/* Source — fills remainder */}
 <col className="w-[180px]" /> {/* Account */}
 <col className="w-[120px]" /> {/* Amount */}
 {group.bucket ==="capital_gain" && (
 <>
 <col className="w-[120px]" /> {/* Short-Term */}
 <col className="w-[120px]" /> {/* Long-Term */}
 </>
 )}
 <col className="w-[120px]" /> {/* Taxable */}
 </colgroup>
 <thead>
 <tr className="border-b border-border/50 text-left tp-table-header">
 <th className="pb-1.5 font-medium">Date</th>
 <th className="pb-1.5 font-medium">Source</th>
 <th className="pb-1.5 font-medium">Account</th>
 <th className="pb-1.5 font-medium text-right">Amount</th>
 {group.bucket ==="capital_gain" && (
 <>
 <th className="pb-1.5 font-medium text-right">Short-Term</th>
 <th className="pb-1.5 font-medium text-right">Long-Term</th>
 </>
 )}
 <th className="pb-1.5 font-medium text-right">Taxable</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-border/30">
 {group.incomes.map((inc) => {
 const split = group.bucket ==="capital_gain" ? getCapGainSplit(inc) : null;
 const taxable = group.bucket ==="exempt" || group.bucket ==="return_of_capital"
 ? 0
 : group.bucket ==="capital_gain"
 ? (split!.stcg + split!.ltcg + split!.collectibleLtcg)
 : getTaxableAmt(inc);
 return (
 <tr key={inc.id} className="hover:bg-muted">
 <td className="py-1.5 text-muted-foreground">{formatDate(inc.date)}</td>
 <td className="py-1.5">
 <span className="flex items-center gap-1.5 flex-wrap">
 {inc.source ?? <span className="text-muted-foreground italic">—</span>}
 {(split?.collectibleLtcg ?? 0) !== 0 && (
 <span className="rounded border border-warn-line bg-warn-soft px-1.5 py-0.5 text-xs font-medium text-warn-deep">collectible</span>
 )}
 </span>
 </td>
 <td className="py-1.5 text-muted-foreground">{inc.account.name}</td>
 <td className="py-1.5 text-right font-mono tabular-nums">{formatCurrency(inc.amount)}</td>
 {group.bucket ==="capital_gain" && (
 <>
 <td className={`py-1.5 text-right font-mono tabular-nums ${split!.stcg < 0 ?"text-down" :""}`}>
 {split!.stcg !== 0
 ? (split!.stcg < 0 ?"-" :"") + formatCurrency(Math.abs(split!.stcg))
 : <span className="text-muted-foreground">—</span>}
 </td>
 <td className={`py-1.5 text-right font-mono tabular-nums ${split!.ltcg < 0 ?"text-down" :""}`}>
 {split!.ltcg !== 0
 ? (split!.ltcg < 0 ?"-" :"") + formatCurrency(Math.abs(split!.ltcg))
 : <span className="text-muted-foreground">—</span>}
 </td>
 </>
 )}
 <td className={`py-1.5 text-right tp-numeric ${taxable < 0 ?"text-down" : taxable === 0 && group.bucket !=="capital_gain" ?"text-muted-foreground" :""}`}>
 {taxable === 0 && (group.bucket ==="exempt" || group.bucket ==="return_of_capital")
 ?"—"
 : (taxable < 0 ?"-" :"") + formatCurrency(Math.abs(taxable))}
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>

 {/* Mobile list */}
 <div className="divide-y divide-border/30 md:hidden">
 {group.incomes.map((inc) => {
 const split = group.bucket ==="capital_gain" ? getCapGainSplit(inc) : null;
 const taxable = group.bucket ==="exempt" || group.bucket ==="return_of_capital"
 ? 0
 : group.bucket ==="capital_gain"
 ? (split!.stcg + split!.ltcg + split!.collectibleLtcg)
 : getTaxableAmt(inc);
 return (
 <div key={inc.id} className="flex items-start justify-between py-2">
 <div>
 <p className="flex items-center gap-1.5 text-13 font-medium">
 {inc.source ?? <span className="italic text-muted-foreground">No source</span>}
 {(split?.collectibleLtcg ?? 0) !== 0 && (
 <span className="rounded border border-warn-line bg-warn-soft px-1.5 py-0.5 text-xs font-medium text-warn-deep">collectible</span>
 )}
 </p>
 <p className="tp-caption">{formatDate(inc.date)} · {inc.account.name}</p>
 {split && (split.stcg !== 0 || split.ltcg !== 0 || split.collectibleLtcg !== 0) && (
 <p className="tp-caption">
 {split.stcg !== 0 && <>ST: {formatCurrency(split.stcg)}</>}
 {split.ltcg !== 0 && <>{split.stcg !== 0 ?" ·" :""}LT: {formatCurrency(split.ltcg)}</>}
 {split.collectibleLtcg !== 0 && <>{(split.stcg !== 0 || split.ltcg !== 0) ?" ·" :""}Collectible: {formatCurrency(split.collectibleLtcg)}</>}
 </p>
 )}
 </div>
 <div className="text-right ml-3">
 <p className="text-13">{formatCurrency(inc.amount)}</p>
 <p className={`text-xs ${taxable === 0 ?"text-muted-foreground" :"font-medium"}`}>
 {taxable === 0 && (group.bucket ==="exempt" || group.bucket ==="return_of_capital")
 ?"non-taxable"
 :`${formatCurrency(taxable)} taxable`}
 </p>
 </div>
 </div>
 );
 })}
 </div>

 {/* Group total + rate */}
 <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
 <div className="flex items-center gap-2">
 {rateLabel(group.bucket, group.stcgTotal, group.ltcgTotal, group.collectibleLtcgTotal)}
 </div>
 <div className="font-semibold">
 {group.bucket ==="exempt" || group.bucket ==="return_of_capital" ? (
 <span className="text-muted-foreground">
 {formatCurrency(group.incomes.reduce((s, i) => s + parseFloat(i.amount), 0))} · non-taxable
 </span>
 ) : group.bucket ==="capital_gain" ? (
 <span>
 {group.stcgTotal !== 0 && (
 <span className={`mr-3 ${(group.stcgTotal ?? 0) < 0 ?"text-down" :""}`}>
 ST: {formatCurrency(group.stcgTotal ?? 0)}
 </span>
 )}
 {group.ltcgTotal !== 0 && (
 <span className={`${(group.collectibleLtcgTotal ?? 0) !== 0 ?"mr-3" :""} ${(group.ltcgTotal ?? 0) < 0 ?"text-down" :""}`}>
 LT: {formatCurrency(group.ltcgTotal ?? 0)}
 </span>
 )}
 {(group.collectibleLtcgTotal ?? 0) !== 0 && (
 <span className={(group.collectibleLtcgTotal ?? 0) < 0 ?"text-down" :""}>
 Collectible: {formatCurrency(group.collectibleLtcgTotal ?? 0)}
 </span>
 )}
 </span>
 ) : (
 <span>{formatCurrency(group.totalTaxable)} taxable</span>
 )}
 </div>
 </div>
 </div>
 ))}
 </div>
 )}
 </Card>
 );
 })}

 {snapshots.length > 0 && (() => {
 const managedKey ="__managed_accounts__";
 const isExpanded = expandedSections.has(managedKey);
 const snapshotNetST = snapshots.reduce((s, snap) => s + (snap.shortTermGain ?? 0) - (snap.shortTermLoss ?? 0), 0);
 const snapshotNetLT = snapshots.reduce((s, snap) => s + (snap.longTermGain ?? 0) - (snap.longTermLoss ?? 0), 0);
 return (
 <Card key={managedKey} className="overflow-hidden p-0">
 <button
 type="button"
 onClick={() => toggleSection(managedKey)}
 className="flex w-full items-center gap-4 px-6 py-3 hover:bg-muted transition-colors text-left"
 >
 <span className="flex-1 tp-panel-title">Managed Accounts</span>
 {(anyOrdinaryInSections || (anyCollectibleInSections && !showCollectibleSeparately)) && (
 <span className="w-[220px] shrink-0 text-right text-muted-foreground tp-numeric">
 {snapshotNetST !== 0 && (
 <span className={snapshotNetST < 0 ?"text-down" :""}>
 {snapshotNetST < 0 ?"-" :""}{formatCurrency(Math.abs(snapshotNetST))}{""}
 <span className="text-xs">@ {fmtPct(calc.marginalOrdRate)} ordinary</span>
 </span>
 )}
 </span>
 )}
 {showCollectibleSeparately && (
 <span className="w-[240px] shrink-0" />
 )}
 {anyPreferentialInSections && (
 <span className="w-[280px] shrink-0 text-right text-muted-foreground tp-numeric">
 {snapshotNetLT !== 0 && (
 <span className={snapshotNetLT < 0 ?"text-down" :""}>
 {snapshotNetLT < 0 ?"-" :""}{formatCurrency(Math.abs(snapshotNetLT))}{""}
 <span className="text-xs">@ {fmtPct(calc.marginalPrefRate)} LT capital gains</span>
 </span>
 )}
 </span>
 )}
 {isExpanded ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
 </button>

 {isExpanded && (
 <div className="border-t border-border">
 <div className="hidden md:block px-6 py-3">
 <table className="w-full table-fixed text-13">
 <colgroup>
 <col />
 <col className="w-[160px]" />
 <col className="w-[160px]" />
 </colgroup>
 <thead>
 <tr className="border-b border-border/50 text-left tp-table-header">
 <th className="pb-1.5 font-medium">Account</th>
 <th className="pb-1.5 font-medium text-right">Short-Term Net</th>
 <th className="pb-1.5 font-medium text-right">Long-Term Net</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-border/30">
 {snapshots.map((snap) => {
 const netST = (snap.shortTermGain ?? 0) - (snap.shortTermLoss ?? 0);
 const netLT = (snap.longTermGain ?? 0) - (snap.longTermLoss ?? 0);
 return (
 <tr key={snap.id} className="hover:bg-muted">
 <td className="py-1.5">
 <span className="flex items-center gap-2">
 {snap.account.color && (
 <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: snap.account.color }} />
 )}
 {snap.account.name}
 </span>
 </td>
 <td className={`py-1.5 text-right tabular-nums font-mono ${netST < 0 ?"text-down" : netST === 0 ?"text-muted-foreground" :""}`}>
 {netST === 0 ?"—" : (netST < 0 ?"-" :"") + formatCurrency(Math.abs(netST))}
 </td>
 <td className={`py-1.5 text-right tabular-nums font-mono ${netLT < 0 ?"text-down" : netLT === 0 ?"text-muted-foreground" :""}`}>
 {netLT === 0 ?"—" : (netLT < 0 ?"-" :"") + formatCurrency(Math.abs(netLT))}
 </td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>

 {/* Mobile list */}
 <div className="divide-y divide-border/30 px-6 md:hidden">
 {snapshots.map((snap) => {
 const netST = (snap.shortTermGain ?? 0) - (snap.shortTermLoss ?? 0);
 const netLT = (snap.longTermGain ?? 0) - (snap.longTermLoss ?? 0);
 return (
 <div key={snap.id} className="flex items-center justify-between py-2">
 <div className="flex items-center gap-2 text-13 font-medium">
 {snap.account.color && (
 <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: snap.account.color }} />
 )}
 {snap.account.name}
 </div>
 <div className="text-right text-13">
 {netST !== 0 && <p className={`tabular-nums font-mono ${netST < 0 ?"text-down" :""}`}>ST: {netST < 0 ?"-" :""}{formatCurrency(Math.abs(netST))}</p>}
 {netLT !== 0 && <p className={`tabular-nums font-mono ${netLT < 0 ?"text-down" :""}`}>LT: {netLT < 0 ?"-" :""}{formatCurrency(Math.abs(netLT))}</p>}
 {netST === 0 && netLT === 0 && <p className="text-muted-foreground">—</p>}
 </div>
 </div>
 );
 })}
 </div>
 </div>
 )}
 </Card>
 );
 })()}
 </div>
 )}
 </div>
 );
}
