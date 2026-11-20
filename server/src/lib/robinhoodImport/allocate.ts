// Split a dollar amount across positions in proportion to their contracts,
// in whole cents that add back up to the total exactly. Each share is floored
// to a cent; the cents left over go to the largest fractional remainders
// (ties: the bigger share, then the earlier position).
//
//   splitCents(0.21, [1, 1, 2, 1]) → [0.04, 0.04, 0.09, 0.04]
//
// A null total (fee unknown) stays null for every position.
export function splitCents(total: number | null, weights: number[]): Array<number | null> {
  if (total == null) return weights.map(() => null);
  const sumW = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0 || sumW <= 0) return weights.map(() => 0);

  const sign = total < 0 ? -1 : 1;
  const cents = Math.round(Math.abs(total) * 100);
  const exact = weights.map((w) => (cents * w) / sumW);
  const floors = exact.map((x) => Math.floor(x + 1e-9));
  let left = cents - floors.reduce((s, x) => s + x, 0);

  const order = exact
    .map((x, i) => ({ i, frac: x - floors[i], w: weights[i] }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i] += 1;
    left -= 1;
  }
  return floors.map((c) => (sign * c) / 100);
}
