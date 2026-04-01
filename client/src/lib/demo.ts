import type { InvestmentAccountSummary, InvestmentHolding, AllocationSummary, GrowthPoint, ManualInvestment } from "@/types";

export const DEMO_SCALE_KEY = "beacon_demo_scale";
export const DEMO_MODE_KEY = "beacon_demo_mode";

/** Returns a stable random scale factor (0.35–0.65), creating one on first use. */
export function getOrCreateDemoScale(): number {
  const stored = localStorage.getItem(DEMO_SCALE_KEY);
  if (stored) return parseFloat(stored);
  const factor = 0.35 + Math.random() * 0.30;
  localStorage.setItem(DEMO_SCALE_KEY, String(factor));
  return factor;
}

export function scaleHolding(h: InvestmentHolding, f: number): InvestmentHolding {
  return {
    ...h,
    currentPrice: h.currentPrice != null ? h.currentPrice * f : null,
    totalCost: h.totalCost * f,
    marketValue: h.marketValue != null ? h.marketValue * f : null,
    totalGain: h.totalGain != null ? h.totalGain * f : null,
    shortTermGain: h.shortTermGain * f,
    longTermGain: h.longTermGain * f,
    // Scale costPerShare on each lot so computeLotGains() produces consistent values
    lots: h.lots?.map((lot) => ({
      ...lot,
      costPerShare: String(parseFloat(lot.costPerShare) * f),
    })) ?? [],
  };
}

export function scaleInvestmentAccounts(
  accounts: InvestmentAccountSummary[],
  f: number
): InvestmentAccountSummary[] {
  return accounts.map((a) => ({
    ...a,
    totalMarketValue: a.totalMarketValue * f,
    totalCost: a.totalCost * f,
    totalGain: a.totalGain * f,
    // totalGainPct is a ratio — scaling numerator and denominator equally keeps it unchanged
    holdings: a.holdings.map((h) => scaleHolding(h, f)),
  }));
}

export function scaleAllocationSummary(s: AllocationSummary, f: number): AllocationSummary {
  return {
    ...s,
    unclassifiedValue: s.unclassifiedValue * f,
    totalValue: s.totalValue * f,
    classifiedValue: s.classifiedValue * f,
    items: s.items.map((item) => ({ ...item, actualValue: item.actualValue * f })),
    topLevelItems: s.topLevelItems.map((item) => ({ ...item, actualValue: item.actualValue * f })),
  };
}

export function scaleGrowthPoints(points: GrowthPoint[], f: number): GrowthPoint[] {
  return points.map((p) => ({
    ...p,
    marketValue: p.marketValue * f,
    costBasis: p.costBasis * f,
    unrealizedGain: p.unrealizedGain * f,
    // unrealizedGainPct is a ratio — unchanged
    events: p.events?.map((e) => ({
      ...e,
      netAmount: e.netAmount * f,
      pricePerShare: e.pricePerShare != null ? e.pricePerShare * f : null,
    })),
  }));
}

export function scaleManuals(manuals: ManualInvestment[], f: number): ManualInvestment[] {
  return manuals.map((m) => ({
    ...m,
    marketValue: m.marketValue * f,
    totalCost: m.totalCost != null ? m.totalCost * f : null,
  }));
}
