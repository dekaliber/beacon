import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Settings, Layers, Landmark, Briefcase, TrendingUp, Activity } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { useApi } from "@/hooks/useApi";
import { getIncome, getAllGainSnapshots } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Income, RealizedGainSnapshotWithAccount } from "@/types";

// ── 2026 Federal Tax Data ──────────────────────────────────────────────────────

type FilingStatus = "SINGLE" | "MFJ" | "HoH" | "MFS";

interface Bracket { rate: number; threshold: number; }

const ORDINARY_BRACKETS: Record<FilingStatus, Bracket[]> = {
  SINGLE: [
    { rate: 0.10, threshold: 0 },       { rate: 0.12, threshold: 12400 },
    { rate: 0.22, threshold: 50400 },   { rate: 0.24, threshold: 105700 },
    { rate: 0.32, threshold: 201775 },  { rate: 0.35, threshold: 256225 },
    { rate: 0.37, threshold: 640600 },
  ],
  MFJ: [
    { rate: 0.10, threshold: 0 },       { rate: 0.12, threshold: 24800 },
    { rate: 0.22, threshold: 100800 },  { rate: 0.24, threshold: 211400 },
    { rate: 0.32, threshold: 403550 },  { rate: 0.35, threshold: 512450 },
    { rate: 0.37, threshold: 768700 },
  ],
  HoH: [
    { rate: 0.10, threshold: 0 },       { rate: 0.12, threshold: 17700 },
    { rate: 0.22, threshold: 67450 },   { rate: 0.24, threshold: 105700 },
    { rate: 0.32, threshold: 201775 },  { rate: 0.35, threshold: 256200 },
    { rate: 0.37, threshold: 640600 },
  ],
  // MFS brackets are the same as Single except 37% kicks in at half the MFJ threshold
  MFS: [
    { rate: 0.10, threshold: 0 },       { rate: 0.12, threshold: 12400 },
    { rate: 0.22, threshold: 50400 },   { rate: 0.24, threshold: 105700 },
    { rate: 0.32, threshold: 201775 },  { rate: 0.35, threshold: 256225 },
    { rate: 0.37, threshold: 384350 },
  ],
};

const LTCG_BRACKETS: Record<FilingStatus, Bracket[]> = {
  SINGLE: [{ rate: 0, threshold: 0 }, { rate: 0.15, threshold: 49450 },  { rate: 0.20, threshold: 545500 }],
  MFJ:    [{ rate: 0, threshold: 0 }, { rate: 0.15, threshold: 98900 },  { rate: 0.20, threshold: 613700 }],
  HoH:    [{ rate: 0, threshold: 0 }, { rate: 0.15, threshold: 66200 },  { rate: 0.20, threshold: 579600 }],
  MFS:    [{ rate: 0, threshold: 0 }, { rate: 0.15, threshold: 49450 },  { rate: 0.20, threshold: 306850 }],
};

const STANDARD_DEDUCTION: Record<FilingStatus, number> = {
  SINGLE: 16100, MFJ: 32200, HoH: 24150, MFS: 16100,
};

const NIIT_THRESHOLD: Record<FilingStatus, number> = {
  SINGLE: 200000, MFJ: 250000, HoH: 200000, MFS: 125000,
};

const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  SINGLE: "Single",
  MFJ: "Married Filing Jointly",
  HoH: "Head of Household",
  MFS: "Married Filing Separately",
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
  return (rate * 100).toFixed(0) + "%";
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

type TaxBucket = "ordinary" | "qualified_dividend" | "capital_gain" | "exempt" | "return_of_capital";

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
  if (taxClassification === "TAX_EXEMPT")
    return { label: "Tax-Exempt", bucket: "exempt" };
  if (taxClassification === "RETURN_OF_CAPITAL" || subtype === "RETURN_OF_CAPITAL")
    return { label: "Return of Capital", bucket: "return_of_capital" };
  if (subtype === "CAPITAL_GAIN")
    return { label: "Capital Gain", bucket: "capital_gain" };
  if (subtype === "DIVIDEND" && taxClassification === "QUALIFIED")
    return { label: "Qualified Dividend", bucket: "qualified_dividend" };
  return { label: "Ordinary Income", bucket: "ordinary" };
}

// ── Number input component ─────────────────────────────────────────────────────

function NumberInput({
  label, value, onChange, placeholder, allowNegative = false, inputRef,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; allowNegative?: boolean;
  inputRef?: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            const pattern = allowNegative ? /^-?\d*\.?\d{0,2}$/ : /^\d*\.?\d{0,2}$/;
            if (v === "" || v === "-" || pattern.test(v)) onChange(v);
          }}
          placeholder={placeholder ?? "0"}
          className="w-full rounded-md border border-border pl-7 pr-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
    </div>
  );
}

// ── Rate badge ─────────────────────────────────────────────────────────────────

function RateBadge({ label, className = "" }: { label: string; className?: string }) {
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
  const [filingStatus, setFilingStatus] = useState<FilingStatus>(() => {
    return (localStorage.getItem("beacon-tax-filing-status") as FilingStatus | null) ?? "SINGLE";
  });
  const [otherOrdinary, setOtherOrdinary] = useState(
    () => localStorage.getItem("beacon-tax-other-ordinary") ?? ""
  );
  const [otherLTCG, setOtherLTCG] = useState(
    () => localStorage.getItem("beacon-tax-other-ltcg") ?? ""
  );
  const [withheld, setWithheld] = useState(
    () => localStorage.getItem("beacon-tax-withheld") ?? ""
  );
  const [assumptionsOpen, setAssumptionsOpen] = useState(false);
  const [focusOnOpen, setFocusOnOpen] = useState<"ordinary" | "ltcg" | false>(false);
  const otherOrdinaryRef = useRef<HTMLInputElement>(null);
  const otherLTCGRef = useRef<HTMLInputElement>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  // Focus the correct field when the modal is opened via an edit link
  useEffect(() => {
    if (assumptionsOpen && focusOnOpen) {
      const ref = focusOnOpen === "ltcg" ? otherLTCGRef : otherOrdinaryRef;
      const t = setTimeout(() => { ref.current?.focus(); setFocusOnOpen(false); }, 50);
      return () => clearTimeout(t);
    }
  }, [assumptionsOpen, focusOnOpen]);

  const updateFilingStatus = (s: FilingStatus) => {
    setFilingStatus(s);
    localStorage.setItem("beacon-tax-filing-status", s);
  };
  const updateOtherOrdinary = (v: string) => {
    setOtherOrdinary(v);
    localStorage.setItem("beacon-tax-other-ordinary", v);
  };
  const updateOtherLTCG = (v: string) => {
    setOtherLTCG(v);
    localStorage.setItem("beacon-tax-other-ltcg", v);
  };
  const updateWithheld = (v: string) => {
    setWithheld(v);
    localStorage.setItem("beacon-tax-withheld", v);
  };

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const params = useMemo(() => ({
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
    limit: "1000",
    sortBy: "date",
    sortOrder: "asc",
    showOnlyReceived: "false",
  }), [year]);

  const { data, loading } = useApi(() => getIncome(params), [params]);
  const incomes = useMemo(() => data?.data ?? [], [data]);

  const { data: gainSnapshots } = useApi(() => getAllGainSnapshots(year), [year]);
  const snapshots: RealizedGainSnapshotWithAccount[] = useMemo(() => gainSnapshots ?? [], [gainSnapshots]);

  const otherOrdinaryNum = parseFloat(otherOrdinary) || 0;
  const otherLTCGNum = parseFloat(otherLTCG) || 0;
  const withheldNum = parseFloat(withheld) || 0;

  // Classify records into tax buckets
  const classified = useMemo(() => {
    const ordinary: Income[] = [], qualDividend: Income[] = [],
          capGain: Income[] = [], exempt: Income[] = [], roc: Income[] = [];
    for (const inc of incomes) {
      const { bucket } = classifyIncome(inc);
      if (bucket === "ordinary") ordinary.push(inc);
      else if (bucket === "qualified_dividend") qualDividend.push(inc);
      else if (bucket === "capital_gain") capGain.push(inc);
      else if (bucket === "exempt") exempt.push(inc);
      else roc.push(inc);
    }
    return { ordinary, qualDividend, capGain, exempt, roc };
  }, [incomes]);

  // Compute income totals and taxes
  const calc = useMemo(() => {
    const ordinaryFromApp = classified.ordinary.reduce((s, i) => s + getTaxableAmt(i), 0);
    const qualDivFromApp  = classified.qualDividend.reduce((s, i) => s + getTaxableAmt(i), 0);
    const exemptFromApp   = classified.exempt.reduce((s, i) => s + parseFloat(i.amount), 0);
    const rocFromApp      = classified.roc.reduce((s, i) => s + parseFloat(i.amount), 0);

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
    const qdContrib   = qualDivFromApp;
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

    const ordBrackets  = ORDINARY_BRACKETS[filingStatus];
    const ltcgBrackets = LTCG_BRACKETS[filingStatus];

    // Marginal ordinary rate is needed for the collectible rate, so compute first
    const marginalOrdRate = marginalOrdinaryRate(taxableOrdinary, ordBrackets);
    const collectibleRate = Math.min(0.28, marginalOrdRate);
    const collectibleTax  = collectibleContrib * collectibleRate;

    const ordinaryTax     = calcOrdinaryTax(taxableOrdinary, ordBrackets);
    const preferentialTax = calcLTCGTax(taxablePreferential, taxableOrdinary, ltcgBrackets);

    // NIIT — 3.8% on lesser of NII or (MAGI - threshold)
    // NII from app = all investment income (dividends, cap gains, collectibles)
    // "Other ordinary income" is treated as wages (not NII)
    const nii = ordinaryFromApp + rawSTCG + rawLTCG + rawCollectibleLTCG + qualDivFromApp + otherLTCGNum;
    const magi = grossOrdinary + grossPreferential + collectibleContrib;
    const niitThreshold = NIIT_THRESHOLD[filingStatus];
    const niitBase = magi > niitThreshold ? Math.max(0, Math.min(nii, magi - niitThreshold)) : 0;
    const niitTax = niitBase * 0.038;

    const totalTax    = ordinaryTax + preferentialTax + collectibleTax + niitTax;
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

  // Build category sections for detailed breakdown
  const categorySections = useMemo((): CategorySection[] => {
    const map = new Map<string, CategorySection>();
    for (const inc of incomes) {
      const catName = inc.category?.name ?? "Uncategorized";
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
        if (group.bucket === "capital_gain") {
          let stcg = 0, ltcg = 0, collectibleLtcg = 0;
          for (const inc of group.incomes) {
            const s = getCapGainSplit(inc);
            stcg += s.stcg; ltcg += s.ltcg; collectibleLtcg += s.collectibleLtcg;
          }
          group.stcgTotal = stcg; group.ltcgTotal = ltcg; group.collectibleLtcgTotal = collectibleLtcg;
          group.totalTaxable = stcg + ltcg + collectibleLtcg;
        } else if (group.bucket === "exempt" || group.bucket === "return_of_capital") {
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
    s.groups.some((g) => g.bucket === "ordinary" || (g.bucket === "capital_gain" && (g.stcgTotal ?? 0) > 0))
  );
  const anyPreferentialInSections = categorySections.some((s) =>
    s.groups.some((g) => g.bucket === "qualified_dividend" || (g.bucket === "capital_gain" && (g.ltcgTotal ?? 0) > 0))
  );
  const anyCollectibleInSections = categorySections.some((s) =>
    s.groups.some((g) => g.bucket === "capital_gain" && (g.collectibleLtcgTotal ?? 0) !== 0)
  );
  // When the collectible rate equals the ordinary marginal rate (i.e. ordinary rate ≤ 28%),
  // collectible gains are taxed identically to ordinary income, so roll them into the
  // ordinary column rather than showing a redundant separate column.
  const showCollectibleSeparately = anyCollectibleInSections && calc.collectibleRate < calc.marginalOrdRate;

  const rateLabel = (bucket: TaxBucket, groupSTCG?: number, groupLTCG?: number, groupCollectible?: number): React.ReactNode => {
    if (bucket === "exempt" || bucket === "return_of_capital")
      return <RateBadge label="Non-taxable" className="bg-muted text-muted-foreground" />;
    if (bucket === "qualified_dividend")
      return <RateBadge label={`${fmtPct(calc.marginalPrefRate)} capital gains rate`} className="bg-emerald-50 text-emerald-700" />;
    if (bucket === "capital_gain") {
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
                hasSTCG && collectibleRolledUp ? "short-term/collectible (ordinary)"
                : hasSTCG                      ? "short-term (ordinary)"
                :                                "ordinary rate"
              }`}
              className="bg-amber-50 text-amber-700"
            />
          )}
          {hasLTCG && <RateBadge label={`${fmtPct(calc.marginalPrefRate)} long-term (capital gains)`} className="bg-emerald-50 text-emerald-700" />}
          {hasCollectible && showCollectibleSeparately && <RateBadge label={`${fmtPct(calc.collectibleRate)} collectible (28% max)`} className="bg-orange-50 text-orange-700" />}
        </span>
      );
    }
    return <RateBadge label={`${fmtPct(calc.marginalOrdRate)} marginal ordinary rate`} className="bg-amber-50 text-amber-700" />;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h2 className="text-2xl font-bold">Tax Estimator</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setAssumptionsOpen(true)}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Settings className="h-4 w-4" />
            Tax Assumptions
          </button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setYear((y) => y - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[4rem] text-center font-semibold">{year}</span>
            <Button variant="ghost" size="sm" onClick={() => setYear((y) => y + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Tax Assumptions Modal */}
      <Modal
        open={assumptionsOpen}
        onClose={() => setAssumptionsOpen(false)}
        title="Tax Assumptions"
        className="max-w-lg"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Filing Status</label>
            <div className="relative">
              <select
                value={filingStatus}
                onChange={(e) => updateFilingStatus(e.target.value as FilingStatus)}
                className="appearance-none w-full rounded-md border border-border py-2 pl-2 pr-6 text-sm text-foreground"
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
            label="Income Tax Withheld"
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
        <p className="mt-4 text-xs text-muted-foreground">
          Federal only · 2026 brackets · Standard deduction ({formatCurrency(STANDARD_DEDUCTION[filingStatus])}) applied · Does not account for tax-advantaged accounts, EITC, child tax credits, or QBI deductions
        </p>
        <div className="mt-5 flex justify-end">
          <Button onClick={() => setAssumptionsOpen(false)}>Done</Button>
        </div>
      </Modal>

      {/* Stat strip */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">Total Income (MAGI)</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{formatCurrency(calc.magi)}</p>
        </div>
        <div className="rounded-lg border border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">Estimated Federal Tax</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{formatCurrency(calc.totalTax)}</p>
          {withheldNum > 0 && (() => {
            const netOwed = calc.totalTax - withheldNum;
            return (
              <p className={`mt-1 text-xs font-medium tabular-nums ${netOwed >= 0 ? "text-amber-600" : "text-emerald-600"}`}>
                {netOwed >= 0
                  ? `${formatCurrency(netOwed)} owed after withholding`
                  : `${formatCurrency(Math.abs(netOwed))} refund after withholding`}
              </p>
            );
          })()}
        </div>
        <div className="rounded-lg border border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">Effective Tax Rate</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{(calc.effectiveRate * 100).toFixed(1)}%</p>
        </div>
      </div>

      {/* Tax Summary */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Income breakdown */}
        <Card>
          <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <Layers className="h-4 w-4 text-muted-foreground" />
            Income Breakdown
          </h3>
          <div className="space-y-3 text-sm">

            {/* ── Ordinary ── */}
            {(otherOrdinaryNum !== 0 || calc.ordinaryFromApp !== 0 || calc.rawSTCG !== 0 || calc.rawCollectibleLTCG !== 0) && (
              <div className="flex gap-1">
                <div className="flex shrink-0 items-center justify-center w-5">
                  <span
                    className="text-[10px] font-semibold uppercase tracking-widest text-amber-500 select-none"
                    style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                  >
                    Ordinary
                  </span>
                </div>
                <div className="flex-1 border-l-2 border-amber-300 pl-3">
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
                      <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize: "5px 100%", backgroundRepeat: "repeat-x" }} />
                      <span className="shrink-0 tabular-nums">{formatCurrency(otherOrdinaryNum)}</span>
                    </div>
                  )}
                  {calc.ordinaryFromApp !== 0 && (
                    <div className="flex items-baseline gap-1.5 py-1.5">
                      <span className="shrink-0">Ordinary Income</span>
                      <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize: "5px 100%", backgroundRepeat: "repeat-x" }} />
                      <span className="shrink-0 tabular-nums">{formatCurrency(calc.ordinaryFromApp)}</span>
                    </div>
                  )}
                  {calc.rawSTCG !== 0 && (
                    <div className="flex items-baseline gap-1.5 py-1.5">
                      <span className="shrink-0">
                        Short-Term Capital Gains
                        {calc.rawSTCG < 0 && <span className="ml-1 text-xs text-muted-foreground">(loss)</span>}
                      </span>
                      <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize: "5px 100%", backgroundRepeat: "repeat-x" }} />
                      <span className={`shrink-0 tabular-nums ${calc.rawSTCG < 0 ? "text-destructive" : ""}`}>
                        {calc.rawSTCG < 0 ? "-" : ""}{formatCurrency(Math.abs(calc.rawSTCG))}
                      </span>
                    </div>
                  )}
                  {calc.rawCollectibleLTCG !== 0 && (
                    <div className="flex items-baseline gap-1.5 py-1.5">
                      <span className="shrink-0">
                        Collectible Gains
                        <span className="ml-1 text-xs text-muted-foreground">(28% max rate)</span>
                        {calc.rawCollectibleLTCG < 0 && <span className="ml-1 text-xs text-muted-foreground">(loss)</span>}
                      </span>
                      <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize: "5px 100%", backgroundRepeat: "repeat-x" }} />
                      <span className={`shrink-0 tabular-nums ${calc.rawCollectibleLTCG < 0 ? "text-destructive" : ""}`}>
                        {calc.rawCollectibleLTCG < 0 ? "-" : ""}{formatCurrency(Math.abs(calc.rawCollectibleLTCG))}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── LT ── */}
            {(calc.qualDivFromApp !== 0 || calc.rawLTCG !== 0 || otherLTCGNum !== 0) && (
              <div className="flex gap-1">
                <div className="flex shrink-0 items-center justify-center w-5">
                  <span
                    className="text-[10px] font-semibold uppercase tracking-widest text-emerald-600 select-none"
                    style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                  >
                    LT
                  </span>
                </div>
                <div className="flex-1 border-l-2 border-emerald-300 pl-3">
                  {calc.qualDivFromApp !== 0 && (
                    <div className="flex items-baseline gap-1.5 py-1.5">
                      <span className="shrink-0">Qualified Dividends</span>
                      <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize: "5px 100%", backgroundRepeat: "repeat-x" }} />
                      <span className="shrink-0 tabular-nums">{formatCurrency(calc.qualDivFromApp)}</span>
                    </div>
                  )}
                  {calc.rawLTCG !== 0 && (
                    <div className="flex items-baseline gap-1.5 py-1.5">
                      <span className="shrink-0">
                        Long-Term Capital Gains
                        {calc.rawLTCG < 0 && <span className="ml-1 text-xs text-muted-foreground">(loss)</span>}
                      </span>
                      <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize: "5px 100%", backgroundRepeat: "repeat-x" }} />
                      <span className={`shrink-0 tabular-nums ${calc.rawLTCG < 0 ? "text-destructive" : ""}`}>
                        {calc.rawLTCG < 0 ? "-" : ""}{formatCurrency(Math.abs(calc.rawLTCG))}
                      </span>
                    </div>
                  )}
                  {otherLTCGNum !== 0 && (
                    <div className="flex items-baseline gap-1.5 py-1.5">
                      <span className="shrink-0">
                        {otherLTCGNum < 0 ? "Other Long-Term Capital Losses" : "Other Long-Term Capital Gains"}
                        <button
                          type="button"
                          onClick={() => { setFocusOnOpen("ltcg"); setAssumptionsOpen(true); }}
                          className="ml-1.5 text-xs text-primary hover:underline"
                        >
                          Edit
                        </button>
                      </span>
                      <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize: "5px 100%", backgroundRepeat: "repeat-x" }} />
                      <span className={`shrink-0 tabular-nums ${otherLTCGNum < 0 ? "text-destructive" : ""}`}>
                        {otherLTCGNum < 0 ? "-" : ""}{formatCurrency(Math.abs(otherLTCGNum))}
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
                  <span
                    className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 select-none"
                    style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                  >
                    $0
                  </span>
                </div>
                <div className="flex-1 border-l-2 border-slate-200 pl-3 text-muted-foreground">
                  {calc.exemptFromApp !== 0 && (
                    <div className="flex items-baseline gap-1.5 py-1.5">
                      <span className="shrink-0">Tax-Exempt Income</span>
                      <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize: "5px 100%", backgroundRepeat: "repeat-x" }} />
                      <span className="shrink-0 tabular-nums">{formatCurrency(calc.exemptFromApp)}</span>
                    </div>
                  )}
                  {calc.rocFromApp !== 0 && (
                    <div className="flex items-baseline gap-1.5 py-1.5">
                      <span className="shrink-0">Return of Capital</span>
                      <span className="flex-1 h-0.5 mb-0.5" style={{ backgroundImage: "radial-gradient(circle, rgba(0,0,0,0.15) 1px, transparent 1px)", backgroundSize: "5px 100%", backgroundRepeat: "repeat-x" }} />
                      <span className="shrink-0 tabular-nums">{formatCurrency(calc.rocFromApp)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

          </div>

          {/* Standard deduction + total */}
          <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Standard Deduction</span>
              <span className="text-destructive">-{formatCurrency(calc.stdDeduction)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Total Taxable Income</span>
              <span>{formatCurrency(calc.taxableOrdinary + calc.taxablePreferential)}</span>
            </div>
          </div>

          {calc.hasCapLoss && (
            <p className="mt-3 text-xs text-amber-600">
              Capital loss of {formatCurrency(Math.abs(calc.stcgOrdinaryContrib + calc.ltcgContrib - calc.rawSTCG - calc.rawLTCG - otherLTCGNum) + Math.max(0, -calc.rawCollectibleLTCG))} exceeds gains.
              Up to {formatCurrency(3000)} is deductible against ordinary income this year; excess carries forward.
            </p>
          )}
        </Card>

        {/* Tax breakdown */}
        <Card>
          <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <Landmark className="h-4 w-4 text-muted-foreground" />
            Estimated Federal Tax
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">Component</th>
                <th className="pb-2 text-right font-medium">Rate</th>
                <th className="pb-2 text-right font-medium">Tax</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              <tr>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <Briefcase className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    Ordinary Income Tax
                  </div>
                  <div className="ml-[1.375rem] text-xs text-muted-foreground">{formatCurrency(calc.taxableOrdinary)} taxable</div>
                </td>
                <td className="py-2 text-right text-muted-foreground">
                  up to {fmtPct(calc.marginalOrdRate)}
                </td>
                <td className="py-2 text-right font-medium">{formatCurrency(calc.ordinaryTax)}</td>
              </tr>
              {calc.taxablePreferential > 0 && (
                <tr>
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      Capital Gains / Qualified Dividends
                    </div>
                    <div className="ml-[1.375rem] text-xs text-muted-foreground">{formatCurrency(calc.taxablePreferential)} taxable</div>
                  </td>
                  <td className="py-2 text-right text-muted-foreground">
                    up to {fmtPct(calc.marginalPrefRate)}
                  </td>
                  <td className="py-2 text-right font-medium">{formatCurrency(calc.preferentialTax)}</td>
                </tr>
              )}
              {calc.collectibleContrib > 0 && (
                <tr>
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-3.5 w-3.5 shrink-0 text-orange-400" />
                      Collectible Gains Tax
                    </div>
                    <div className="ml-[1.375rem] text-xs text-muted-foreground">{formatCurrency(calc.collectibleContrib)} taxable</div>
                  </td>
                  <td className="py-2 text-right text-muted-foreground">
                    {fmtPct(calc.collectibleRate)}
                  </td>
                  <td className="py-2 text-right font-medium">{formatCurrency(calc.collectibleTax)}</td>
                </tr>
              )}
              {calc.niitBase > 0 && (
                <tr>
                  <td className="py-2">
                    <div className="flex items-center gap-1.5">
                      <Activity className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                      Net Investment Income Tax
                      <span className="group relative">
                        <span className="flex h-3.5 w-3.5 cursor-default items-center justify-center rounded-full border border-muted-foreground/40 text-[9px] font-bold leading-none text-muted-foreground">
                          ?
                        </span>
                        <span className="pointer-events-none invisible absolute bottom-full left-1/2 mb-2 w-64 -translate-x-1/2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100">
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
                    <div className="ml-[1.375rem] text-xs text-muted-foreground">{formatCurrency(calc.niitBase)} subject to NIIT</div>
                  </td>
                  <td className="py-2 text-right text-muted-foreground">3.8%</td>
                  <td className="py-2 text-right font-medium">{formatCurrency(calc.niitTax)}</td>
                </tr>
              )}
              <tr className="border-t-2 border-border font-bold text-base">
                <td className="pt-2">Total Estimated Tax</td>
                <td className="pt-2 text-right text-sm font-medium text-muted-foreground">
                  {(calc.effectiveRate * 100).toFixed(1)}% eff.
                </td>
                <td className="pt-2 text-right">{formatCurrency(calc.totalTax)}</td>
              </tr>
            </tbody>
          </table>
          {withheldNum > 0 && (() => {
            const netOwed = calc.totalTax - withheldNum;
            return (
              <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Less: Tax Withheld</span>
                  <span className="text-destructive">-{formatCurrency(withheldNum)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>{netOwed >= 0 ? "Net Tax Owed" : "Estimated Refund"}</span>
                  <span className="text-foreground">{formatCurrency(Math.abs(netOwed))}</span>
                </div>
              </div>
            );
          })()}
        </Card>
      </div>

      {/* Detailed Breakdown */}
      {loading ? (
        <Card><p className="text-sm text-muted-foreground">Loading income records…</p></Card>
      ) : incomes.length === 0 ? (
        <Card><p className="text-sm text-muted-foreground">No income records found for {year}.</p></Card>
      ) : (
        <div className="space-y-3">
          <h3 className="text-base font-semibold">Income Detail by Category</h3>
          {categorySections.map((section) => {
            const sectionKey = section.categoryName;
            const isExpanded = expandedSections.has(sectionKey);
            const sectionOrdinaryAmt = section.groups.reduce((sum, g) => {
              if (g.bucket === "ordinary") return sum + g.totalTaxable;
              if (g.bucket === "capital_gain") return sum + Math.max(0, g.stcgTotal ?? 0);
              return sum;
            }, 0);
            const sectionPreferentialAmt = section.groups.reduce((sum, g) => {
              if (g.bucket === "qualified_dividend") return sum + g.totalTaxable;
              if (g.bucket === "capital_gain") return sum + Math.max(0, g.ltcgTotal ?? 0);
              return sum;
            }, 0);
            const sectionCollectibleAmt = section.groups.reduce((sum, g) => {
              if (g.bucket === "capital_gain") return sum + Math.max(0, g.collectibleLtcgTotal ?? 0);
              return sum;
            }, 0);

            return (
              <Card key={sectionKey} className="overflow-hidden p-0">
                {/* Category header */}
                <button
                  type="button"
                  onClick={() => toggleSection(sectionKey)}
                  className="flex w-full items-center gap-4 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
                >
                  <span className="flex-1 font-semibold">{section.categoryName}</span>
                  {(anyOrdinaryInSections || (anyCollectibleInSections && !showCollectibleSeparately)) && (
                    <span className="w-[220px] shrink-0 text-right text-sm text-muted-foreground tabular-nums">
                      {(() => {
                        const amt = sectionOrdinaryAmt + (!showCollectibleSeparately ? sectionCollectibleAmt : 0);
                        return amt > 0 ? <>{formatCurrency(amt)} <span className="text-xs">@ {fmtPct(calc.marginalOrdRate)} ordinary</span></> : null;
                      })()}
                    </span>
                  )}
                  {showCollectibleSeparately && (
                    <span className="w-[240px] shrink-0 text-right text-sm text-muted-foreground tabular-nums">
                      {sectionCollectibleAmt > 0 && (
                        <>{formatCurrency(sectionCollectibleAmt)} <span className="text-xs">@ {fmtPct(calc.collectibleRate)} collectible</span></>
                      )}
                    </span>
                  )}
                  {anyPreferentialInSections && (
                    <span className="w-[240px] shrink-0 text-right text-sm text-muted-foreground tabular-nums">
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
                      <div key={group.label} className="px-4 py-3">
                        {/* Group subheader */}
                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {group.label}
                          </span>
                        </div>

                        {/* Transactions table */}
                        <div className="hidden md:block">
                          <table className="w-full table-fixed text-sm">
                            <colgroup>
                              <col className="w-[100px]" />  {/* Date */}
                              <col />                         {/* Source — fills remainder */}
                              <col className="w-[180px]" />  {/* Account */}
                              <col className="w-[120px]" />  {/* Amount */}
                              {group.bucket === "capital_gain" && (
                                <>
                                  <col className="w-[120px]" />  {/* Short-Term */}
                                  <col className="w-[120px]" />  {/* Long-Term */}
                                </>
                              )}
                              <col className="w-[120px]" />  {/* Taxable */}
                            </colgroup>
                            <thead>
                              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                                <th className="pb-1.5 font-medium">Date</th>
                                <th className="pb-1.5 font-medium">Source</th>
                                <th className="pb-1.5 font-medium">Account</th>
                                <th className="pb-1.5 font-medium text-right">Amount</th>
                                {group.bucket === "capital_gain" && (
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
                                const split = group.bucket === "capital_gain" ? getCapGainSplit(inc) : null;
                                const taxable = group.bucket === "exempt" || group.bucket === "return_of_capital"
                                  ? 0
                                  : group.bucket === "capital_gain"
                                  ? (split!.stcg + split!.ltcg + split!.collectibleLtcg)
                                  : getTaxableAmt(inc);
                                return (
                                  <tr key={inc.id} className="hover:bg-muted/30">
                                    <td className="py-1.5 text-muted-foreground">{formatDate(inc.date)}</td>
                                    <td className="py-1.5">
                                      <span className="flex items-center gap-1.5 flex-wrap">
                                        {inc.source ?? <span className="text-muted-foreground italic">—</span>}
                                        {(split?.collectibleLtcg ?? 0) !== 0 && (
                                          <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">collectible</span>
                                        )}
                                      </span>
                                    </td>
                                    <td className="py-1.5 text-muted-foreground">{inc.account.name}</td>
                                    <td className="py-1.5 text-right">{formatCurrency(inc.amount)}</td>
                                    {group.bucket === "capital_gain" && (
                                      <>
                                        <td className={`py-1.5 text-right ${split!.stcg < 0 ? "text-destructive" : ""}`}>
                                          {split!.stcg !== 0
                                            ? (split!.stcg < 0 ? "-" : "") + formatCurrency(Math.abs(split!.stcg))
                                            : <span className="text-muted-foreground">—</span>}
                                        </td>
                                        <td className={`py-1.5 text-right ${split!.ltcg < 0 ? "text-destructive" : ""}`}>
                                          {split!.ltcg !== 0
                                            ? (split!.ltcg < 0 ? "-" : "") + formatCurrency(Math.abs(split!.ltcg))
                                            : <span className="text-muted-foreground">—</span>}
                                        </td>
                                      </>
                                    )}
                                    <td className={`py-1.5 text-right font-medium ${taxable < 0 ? "text-destructive" : taxable === 0 && group.bucket !== "capital_gain" ? "text-muted-foreground" : ""}`}>
                                      {taxable === 0 && (group.bucket === "exempt" || group.bucket === "return_of_capital")
                                        ? "—"
                                        : (taxable < 0 ? "-" : "") + formatCurrency(Math.abs(taxable))}
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
                            const split = group.bucket === "capital_gain" ? getCapGainSplit(inc) : null;
                            const taxable = group.bucket === "exempt" || group.bucket === "return_of_capital"
                              ? 0
                              : group.bucket === "capital_gain"
                              ? (split!.stcg + split!.ltcg + split!.collectibleLtcg)
                              : getTaxableAmt(inc);
                            return (
                              <div key={inc.id} className="flex items-start justify-between py-2">
                                <div>
                                  <p className="flex items-center gap-1.5 text-sm font-medium">
                                    {inc.source ?? <span className="italic text-muted-foreground">No source</span>}
                                    {(split?.collectibleLtcg ?? 0) !== 0 && (
                                      <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">collectible</span>
                                    )}
                                  </p>
                                  <p className="text-xs text-muted-foreground">{formatDate(inc.date)} · {inc.account.name}</p>
                                  {split && (split.stcg !== 0 || split.ltcg !== 0 || split.collectibleLtcg !== 0) && (
                                    <p className="text-xs text-muted-foreground">
                                      {split.stcg !== 0 && <>ST: {formatCurrency(split.stcg)}</>}
                                      {split.ltcg !== 0 && <>{split.stcg !== 0 ? " · " : ""}LT: {formatCurrency(split.ltcg)}</>}
                                      {split.collectibleLtcg !== 0 && <>{(split.stcg !== 0 || split.ltcg !== 0) ? " · " : ""}Collectible: {formatCurrency(split.collectibleLtcg)}</>}
                                    </p>
                                  )}
                                </div>
                                <div className="text-right ml-3">
                                  <p className="text-sm">{formatCurrency(inc.amount)}</p>
                                  <p className={`text-xs ${taxable === 0 ? "text-muted-foreground" : "font-medium"}`}>
                                    {taxable === 0 && (group.bucket === "exempt" || group.bucket === "return_of_capital")
                                      ? "non-taxable"
                                      : `${formatCurrency(taxable)} taxable`}
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
                          <div className="text-sm font-semibold">
                            {group.bucket === "exempt" || group.bucket === "return_of_capital" ? (
                              <span className="text-muted-foreground">
                                {formatCurrency(group.incomes.reduce((s, i) => s + parseFloat(i.amount), 0))} · non-taxable
                              </span>
                            ) : group.bucket === "capital_gain" ? (
                              <span>
                                {group.stcgTotal !== 0 && (
                                  <span className={`mr-3 ${(group.stcgTotal ?? 0) < 0 ? "text-destructive" : ""}`}>
                                    ST: {formatCurrency(group.stcgTotal ?? 0)}
                                  </span>
                                )}
                                {group.ltcgTotal !== 0 && (
                                  <span className={`${(group.collectibleLtcgTotal ?? 0) !== 0 ? "mr-3" : ""} ${(group.ltcgTotal ?? 0) < 0 ? "text-destructive" : ""}`}>
                                    LT: {formatCurrency(group.ltcgTotal ?? 0)}
                                  </span>
                                )}
                                {(group.collectibleLtcgTotal ?? 0) !== 0 && (
                                  <span className={(group.collectibleLtcgTotal ?? 0) < 0 ? "text-destructive" : ""}>
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
            const managedKey = "__managed_accounts__";
            const isExpanded = expandedSections.has(managedKey);
            const snapshotNetST = snapshots.reduce((s, snap) => s + (snap.shortTermGain ?? 0) - (snap.shortTermLoss ?? 0), 0);
            const snapshotNetLT = snapshots.reduce((s, snap) => s + (snap.longTermGain ?? 0) - (snap.longTermLoss ?? 0), 0);
            return (
              <Card key={managedKey} className="overflow-hidden p-0">
                <button
                  type="button"
                  onClick={() => toggleSection(managedKey)}
                  className="flex w-full items-center gap-4 px-4 py-3 hover:bg-muted/40 transition-colors text-left"
                >
                  <span className="flex-1 font-semibold">Managed Accounts</span>
                  {(anyOrdinaryInSections || (anyCollectibleInSections && !showCollectibleSeparately)) && (
                    <span className="w-[220px] shrink-0 text-right text-sm text-muted-foreground tabular-nums">
                      {snapshotNetST !== 0 && (
                        <span className={snapshotNetST < 0 ? "text-destructive" : ""}>
                          {snapshotNetST < 0 ? "-" : ""}{formatCurrency(Math.abs(snapshotNetST))}{" "}
                          <span className="text-xs">@ {fmtPct(calc.marginalOrdRate)} ordinary</span>
                        </span>
                      )}
                    </span>
                  )}
                  {showCollectibleSeparately && (
                    <span className="w-[240px] shrink-0" />
                  )}
                  {anyPreferentialInSections && (
                    <span className="w-[240px] shrink-0 text-right text-sm text-muted-foreground tabular-nums">
                      {snapshotNetLT !== 0 && (
                        <span className={snapshotNetLT < 0 ? "text-destructive" : ""}>
                          {snapshotNetLT < 0 ? "-" : ""}{formatCurrency(Math.abs(snapshotNetLT))}{" "}
                          <span className="text-xs">@ {fmtPct(calc.marginalPrefRate)} LT capital gains</span>
                        </span>
                      )}
                    </span>
                  )}
                  {isExpanded ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />}
                </button>

                {isExpanded && (
                  <div className="border-t border-border">
                    <div className="hidden md:block px-4 py-3">
                      <table className="w-full table-fixed text-sm">
                        <colgroup>
                          <col />
                          <col className="w-[160px]" />
                          <col className="w-[160px]" />
                        </colgroup>
                        <thead>
                          <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
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
                              <tr key={snap.id} className="hover:bg-muted/30">
                                <td className="py-1.5">
                                  <span className="flex items-center gap-2">
                                    {snap.account.color && (
                                      <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: snap.account.color }} />
                                    )}
                                    {snap.account.name}
                                  </span>
                                </td>
                                <td className={`py-1.5 text-right tabular-nums ${netST < 0 ? "text-destructive" : netST === 0 ? "text-muted-foreground" : ""}`}>
                                  {netST === 0 ? "—" : (netST < 0 ? "-" : "") + formatCurrency(Math.abs(netST))}
                                </td>
                                <td className={`py-1.5 text-right tabular-nums ${netLT < 0 ? "text-destructive" : netLT === 0 ? "text-muted-foreground" : ""}`}>
                                  {netLT === 0 ? "—" : (netLT < 0 ? "-" : "") + formatCurrency(Math.abs(netLT))}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile list */}
                    <div className="divide-y divide-border/30 px-4 md:hidden">
                      {snapshots.map((snap) => {
                        const netST = (snap.shortTermGain ?? 0) - (snap.shortTermLoss ?? 0);
                        const netLT = (snap.longTermGain ?? 0) - (snap.longTermLoss ?? 0);
                        return (
                          <div key={snap.id} className="flex items-center justify-between py-2">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              {snap.account.color && (
                                <span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: snap.account.color }} />
                              )}
                              {snap.account.name}
                            </div>
                            <div className="text-right text-sm">
                              {netST !== 0 && <p className={`tabular-nums ${netST < 0 ? "text-destructive" : ""}`}>ST: {netST < 0 ? "-" : ""}{formatCurrency(Math.abs(netST))}</p>}
                              {netLT !== 0 && <p className={`tabular-nums ${netLT < 0 ? "text-destructive" : ""}`}>LT: {netLT < 0 ? "-" : ""}{formatCurrency(Math.abs(netLT))}</p>}
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
