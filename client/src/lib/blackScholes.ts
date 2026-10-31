// Black-Scholes delta implied from a traded premium.
//
// Delta at open is derived from the user's own fill rather than a broker
// greek snapshot (Tradier's greeks can be hours stale): solve for the
// volatility that reprices the option to the premium paid, then take that
// volatility's delta. Backtested against 93 chain-logged deltas at a median
// absolute error of ~0.013.

// Rate barely matters at the short tenors traded here (3%/4%/5% moved the
// backtest's mean error by <0.0002), so a fixed assumption is fine.
const RISK_FREE_RATE = 0.04;

const normCdf = (x: number) => {
  // Abramowitz & Stegun 7.1.26 erf approximation (|error| < 1.5e-7).
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
};

function priceAndD1(isCall: boolean, S: number, K: number, T: number, r: number, vol: number) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (vol * vol) / 2) * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const disc = K * Math.exp(-r * T);
  const price = isCall
    ? S * normCdf(d1) - disc * normCdf(d2)
    : disc * normCdf(-d2) - S * normCdf(-d1);
  return { price, d1 };
}

export type ImpliedDelta = { delta: number; iv: number };

/**
 * Delta implied by a premium. `openedAtUtc` is an ISO UTC instant; expiry is
 * 4 pm ET on `expirationDate` (YYYY-MM-DD), approximated as 20:00 UTC like the
 * rest of the page. Returns null when inputs are missing/invalid or no
 * volatility reproduces the premium (e.g. premium below intrinsic value).
 */
export function impliedDelta(params: {
  optionType: "CALL" | "PUT";
  stockPrice: number;
  strike: number;
  premium: number;
  openedAtUtc: string;
  expirationDate: string;
}): ImpliedDelta | null {
  const { optionType, stockPrice: S, strike: K, premium, openedAtUtc, expirationDate } = params;
  if (![S, K, premium].every((n) => Number.isFinite(n) && n > 0)) return null;
  const openedMs = new Date(openedAtUtc).getTime();
  const expiryMs = new Date(`${expirationDate}T20:00:00.000Z`).getTime();
  if (!Number.isFinite(openedMs) || !Number.isFinite(expiryMs)) return null;
  const T = (expiryMs - openedMs) / (365 * 86_400_000);
  if (T <= 0) return null;

  const isCall = optionType === "CALL";
  const r = RISK_FREE_RATE;
  // Price is monotonic in vol, so bisect between bounds that bracket the premium.
  let lo = 1e-4;
  let hi = 6;
  if (priceAndD1(isCall, S, K, T, r, lo).price > premium) return null;
  if (priceAndD1(isCall, S, K, T, r, hi).price < premium) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (priceAndD1(isCall, S, K, T, r, mid).price > premium) hi = mid;
    else lo = mid;
  }
  const iv = (lo + hi) / 2;
  const { d1 } = priceAndD1(isCall, S, K, T, r, iv);
  return { delta: isCall ? normCdf(d1) : normCdf(d1) - 1, iv };
}
