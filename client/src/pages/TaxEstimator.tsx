import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Settings } from "lucide-react";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { useApi } from "@/hooks/useApi";
import { getIncome } from "@/api";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Income } from "@/types";

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

interface CapGainSplit { stcg: number; ltcg: number; }

function getCapGainSplit(income: Income): CapGainSplit {
  const act = income.activity;
  // Prisma serializes Decimal fields as strings in JSON, so we must use Number()
  // rather than relying on JS arithmetic to coerce them (which causes NaN via
  // string-concatenation in Array.reduce).
  if (act) return {
    stcg: act.shortTermGain != null ? Number(act.shortTermGain) : 0,
    ltcg: act.longTermGain != null ? Number(act.longTermGain) : 0,
  };
  // No activity linked — treat full taxable amount as LTCG
  return { stcg: 0, ltcg: getTaxableAmt(income) };
}

// ── Group types ────────────────────────────────────────────────────────────────

type TaxBucket = "ordinary" | "qualified_dividend" | "capital_gain" | "exempt" | "return_of_capital";

interface TaxGroup {
  label: string;
  bucket: TaxBucket;
  incomes: Income[];
  totalTaxable: number;
  stcgTotal?: number;
  ltcgTotal?: number;
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
  if (subtype === "DIVIDEND" && taxClassification === "ORDINARY")
    return { label: "Ordinary Dividend", bucket: "ordinary" };
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
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const otherOrdinaryRef = useRef<HTMLInputElement>(null);
  const [niitInfoOpen, setNiitInfoOpen] = useState(false);
  const niitInfoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!niitInfoOpen) return;
    const handle = (e: MouseEvent) => {
      if (niitInfoRef.current && !niitInfoRef.current.contains(e.target as Node)) {
        setNiitInfoOpen(false);
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [niitInfoOpen]);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  // Focus the Other Ordinary Income field when the modal is opened via the edit link
  useEffect(() => {
    if (assumptionsOpen && focusOnOpen) {
      const t = setTimeout(() => { otherOrdinaryRef.current?.focus(); setFocusOnOpen(false); }, 50);
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

    const capGainSplits = classified.capGain.map(getCapGainSplit);
    const rawSTCG = capGainSplits.reduce((s, g) => s + g.stcg, 0);
    const rawLTCG = capGainSplits.reduce((s, g) => s + g.ltcg, 0);

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

    const stdDeduction = STANDARD_DEDUCTION[filingStatus];
    const grossOrdinary = otherOrdinaryNum + ordinaryFromApp + stcgOrdinaryContrib;
    const taxableOrdinary = Math.max(0, grossOrdinary - stdDeduction);

    // Standard deduction may spill over to offset preferential income
    const unusedDeduction = Math.max(0, stdDeduction - grossOrdinary);
    const grossPreferential = ltcgContrib + qdContrib;
    const taxablePreferential = Math.max(0, grossPreferential - unusedDeduction);

    const ordBrackets  = ORDINARY_BRACKETS[filingStatus];
    const ltcgBrackets = LTCG_BRACKETS[filingStatus];

    const ordinaryTax     = calcOrdinaryTax(taxableOrdinary, ordBrackets);
    const preferentialTax = calcLTCGTax(taxablePreferential, taxableOrdinary, ltcgBrackets);

    // NIIT — 3.8% on lesser of NII or (MAGI - threshold)
    // NII from app = all investment income (dividends, cap gains)
    // "Other ordinary income" is treated as wages (not NII)
    const nii = ordinaryFromApp + rawSTCG + rawLTCG + qualDivFromApp + otherLTCGNum;
    const magi = grossOrdinary + grossPreferential;
    const niitThreshold = NIIT_THRESHOLD[filingStatus];
    const niitBase = magi > niitThreshold ? Math.max(0, Math.min(nii, magi - niitThreshold)) : 0;
    const niitTax = niitBase * 0.038;

    const totalTax    = ordinaryTax + preferentialTax + niitTax;
    const effectiveRate = magi > 0 ? totalTax / magi : 0;

    const marginalOrdRate  = marginalOrdinaryRate(taxableOrdinary, ordBrackets);
    const ltcgEnd = taxableOrdinary + taxablePreferential;
    const marginalPrefRate = marginalLTCGRate(ltcgEnd, ltcgBrackets);

    return {
      ordinaryFromApp, qualDivFromApp, exemptFromApp, rocFromApp,
      rawSTCG, rawLTCG, netSTCG, netLTCG, stcgOrdinaryContrib, ltcgContrib, qdContrib,
      grossOrdinary, grossPreferential, taxableOrdinary, taxablePreferential, stdDeduction,
      ordinaryTax, preferentialTax, niitTax, niitBase, totalTax, effectiveRate,
      marginalOrdRate, marginalPrefRate, ltcgEnd, magi,
      hasCapLoss, capLossDeduction,
    };
  }, [classified, otherOrdinaryNum, otherLTCGNum, filingStatus]);

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
          let stcg = 0, ltcg = 0;
          for (const inc of group.incomes) {
            const s = getCapGainSplit(inc);
            stcg += s.stcg; ltcg += s.ltcg;
          }
          group.stcgTotal = stcg; group.ltcgTotal = ltcg;
          group.totalTaxable = stcg + ltcg;
        } else if (group.bucket === "exempt" || group.bucket === "return_of_capital") {
          group.totalTaxable = 0;
        } else {
          group.totalTaxable = group.incomes.reduce((s, i) => s + getTaxableAmt(i), 0);
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => a.categoryName.localeCompare(b.categoryName));
  }, [incomes]);

  const rateLabel = (bucket: TaxBucket, groupSTCG?: number, groupLTCG?: number): React.ReactNode => {
    if (bucket === "exempt" || bucket === "return_of_capital")
      return <RateBadge label="Non-taxable" className="bg-muted text-muted-foreground" />;
    if (bucket === "qualified_dividend")
      return <RateBadge label={`${fmtPct(calc.marginalPrefRate)} capital gains rate`} className="bg-emerald-50 text-emerald-700" />;
    if (bucket === "capital_gain") {
      const hasSTCG = (groupSTCG ?? 0) !== 0;
      const hasLTCG = (groupLTCG ?? 0) !== 0;
      return (
        <span className="flex flex-wrap gap-1">
          {hasSTCG && <RateBadge label={`${fmtPct(calc.marginalOrdRate)} short-term (ordinary)`} className="bg-amber-50 text-amber-700" />}
          {hasLTCG && <RateBadge label={`${fmtPct(calc.marginalPrefRate)} long-term (capital gains)`} className="bg-emerald-50 text-emerald-700" />}
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
          <Link
            to="/income"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Income
          </Link>
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
          <div className="h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" onClick={() => setYear((y) => y - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[4rem] text-center font-semibold">{year}</span>
          <Button variant="ghost" size="sm" onClick={() => setYear((y) => y + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
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
          />
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Federal only · 2026 brackets · Standard deduction ({formatCurrency(STANDARD_DEDUCTION[filingStatus])}) applied · Does not account for tax-advantaged accounts, EITC, child tax credits, or QBI deductions
        </p>
        <div className="mt-5 flex justify-end">
          <Button onClick={() => setAssumptionsOpen(false)}>Done</Button>
        </div>
      </Modal>

      {/* Tax Summary */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Income breakdown */}
        <Card>
          <h3 className="mb-4 text-sm font-semibold">Income Breakdown</h3>
          <div className="space-y-3 text-sm">

            {/* ── Ordinary ── */}
            {(otherOrdinaryNum !== 0 || calc.ordinaryFromApp !== 0 || calc.rawSTCG !== 0) && (
              <div className="flex gap-2">
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
                          onClick={() => { setFocusOnOpen(true); setAssumptionsOpen(true); }}
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
                </div>
              </div>
            )}

            {/* ── LT ── */}
            {(calc.qualDivFromApp !== 0 || calc.rawLTCG !== 0 || otherLTCGNum !== 0) && (
              <div className="flex gap-2">
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
                        Other Long-Term Capital Gains
                        {otherLTCGNum < 0 && <span className="ml-1 text-xs text-muted-foreground">(loss)</span>}
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
              <div className="flex gap-2">
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
              Capital loss of {formatCurrency(Math.abs(calc.stcgOrdinaryContrib + calc.ltcgContrib - calc.rawSTCG - calc.rawLTCG - otherLTCGNum))} exceeds gains.
              Up to {formatCurrency(3000)} is deductible against ordinary income this year; excess carries forward.
            </p>
          )}
        </Card>

        {/* Tax breakdown */}
        <Card>
          <h3 className="mb-4 text-sm font-semibold">Estimated Federal Tax</h3>
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
                  <div>Ordinary Income Tax</div>
                  <div className="text-xs text-muted-foreground">{formatCurrency(calc.taxableOrdinary)} taxable</div>
                </td>
                <td className="py-2 text-right text-muted-foreground">
                  up to {fmtPct(calc.marginalOrdRate)}
                </td>
                <td className="py-2 text-right font-medium">{formatCurrency(calc.ordinaryTax)}</td>
              </tr>
              {calc.taxablePreferential > 0 && (
                <tr>
                  <td className="py-2">
                    <div>Capital Gains / Qualified Dividends</div>
                    <div className="text-xs text-muted-foreground">{formatCurrency(calc.taxablePreferential)} taxable</div>
                  </td>
                  <td className="py-2 text-right text-muted-foreground">
                    up to {fmtPct(calc.marginalPrefRate)}
                  </td>
                  <td className="py-2 text-right font-medium">{formatCurrency(calc.preferentialTax)}</td>
                </tr>
              )}
              {calc.niitBase > 0 && (
                <tr>
                  <td className="py-2">
                    <div className="flex items-center gap-1.5">
                      Net Investment Income Tax
                      <div className="relative" ref={niitInfoRef}>
                        <button
                          type="button"
                          onClick={() => setNiitInfoOpen((v) => !v)}
                          className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-muted-foreground/40 text-[9px] font-bold leading-none text-muted-foreground hover:border-foreground hover:text-foreground transition-colors"
                        >
                          ?
                        </button>
                        {niitInfoOpen && (
                          <div className="absolute left-0 top-5 z-20 w-64 rounded-md border border-border bg-background p-3 shadow-lg text-xs text-muted-foreground">
                            <p><span className="font-medium text-foreground">MAGI:</span> {formatCurrency(calc.magi)}</p>
                            <p className="mt-1.5">
                              {calc.magi > NIIT_THRESHOLD[filingStatus]
                                ? <><span className="font-medium text-foreground">{formatCurrency(calc.magi - NIIT_THRESHOLD[filingStatus])}</span> above the {formatCurrency(NIIT_THRESHOLD[filingStatus])} threshold</>
                                : <><span className="font-medium text-foreground">{formatCurrency(NIIT_THRESHOLD[filingStatus] - calc.magi)}</span> below the {formatCurrency(NIIT_THRESHOLD[filingStatus])} threshold</>}
                            </p>
                            <p className="mt-1.5">{formatCurrency(calc.niitBase)} of net investment income subject to 3.8% NIIT</p>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">{formatCurrency(calc.niitBase)} subject to NIIT</div>
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
            const sectionTotal = section.groups.reduce((s, g) => s + g.totalTaxable, 0);

            return (
              <Card key={sectionKey} className="overflow-hidden p-0">
                {/* Category header */}
                <button
                  type="button"
                  onClick={() => toggleSection(sectionKey)}
                  className="flex w-full items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors text-left"
                >
                  <span className="font-semibold">{section.categoryName}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {formatCurrency(sectionTotal)} taxable
                    </span>
                    {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </div>
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
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                                <th className="pb-1.5 font-medium w-28">Date</th>
                                <th className="pb-1.5 font-medium">Source</th>
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
                                  ? (split!.stcg + split!.ltcg)
                                  : getTaxableAmt(inc);
                                return (
                                  <tr key={inc.id} className="hover:bg-muted/30">
                                    <td className="py-1.5 text-muted-foreground">{formatDate(inc.date)}</td>
                                    <td className="py-1.5">{inc.source ?? <span className="text-muted-foreground italic">—</span>}</td>
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
                              ? (split!.stcg + split!.ltcg)
                              : getTaxableAmt(inc);
                            return (
                              <div key={inc.id} className="flex items-start justify-between py-2">
                                <div>
                                  <p className="text-sm font-medium">{inc.source ?? <span className="italic text-muted-foreground">No source</span>}</p>
                                  <p className="text-xs text-muted-foreground">{formatDate(inc.date)}</p>
                                  {split && (split.stcg !== 0 || split.ltcg !== 0) && (
                                    <p className="text-xs text-muted-foreground">
                                      ST: {split.stcg !== 0 ? formatCurrency(split.stcg) : "—"} · LT: {split.ltcg !== 0 ? formatCurrency(split.ltcg) : "—"}
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
                            {rateLabel(group.bucket, group.stcgTotal, group.ltcgTotal)}
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
                                  <span className={(group.ltcgTotal ?? 0) < 0 ? "text-destructive" : ""}>
                                    LT: {formatCurrency(group.ltcgTotal ?? 0)}
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
        </div>
      )}
    </div>
  );
}
