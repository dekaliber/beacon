// Net premium collected for a single option leg, whether still open or closed.
// Mirrors the `legNet` convention in routes/options.ts (applyCloseSideEffects):
// premiumPerShare - closePremiumPerShare (0 when not yet closed), scaled by the
// assigned contract count on an ASSIGNED leg, minus both fee legs.
export function legNetPremium(pos: {
  outcome: string | null;
  premiumPerShare: unknown;
  closePremiumPerShare: unknown;
  contracts: number;
  contractsAssigned: number | null;
  feesOpen: unknown;
  feesClose: unknown;
}): number {
  const c = pos.outcome === "ASSIGNED"
    ? Number(pos.contractsAssigned ?? pos.contracts)
    : Number(pos.contracts);
  return (Number(pos.premiumPerShare) - Number(pos.closePremiumPerShare ?? 0)) * c * 100
    - Number(pos.feesOpen ?? 0)
    - Number(pos.feesClose ?? 0);
}
