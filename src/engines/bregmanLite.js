/**
 * Phase 2: Bregman lite — LMSR-style cost awareness for 2–4 outcomes.
 * Log-cost (LMSR) implied probability and max extractable profit projection.
 */

/**
 * LMSR cost: C(q) = b * ln(exp(q1/b) + exp(q2/b) + ...)
 * For binary: C(q1,q2) = b * ln(exp(q1/b) + exp(q2/b))
 * Price of outcome i: p_i = exp(q_i/b) / (sum_j exp(q_j/b)) = 1/(1+exp(-(q_i - q_j)/b))
 * We don't have q directly; we have prices. So we use prices as proxy for implied probability.
 * "Arbitrage-free" projection: constrain so that sum of probabilities = 1 and no outcome < 0.
 * @param {number[]} prices - e.g. [askUp, askDown] or mid prices
 * @returns {{ projected: number[], maxProfitPerShare: number }} projected probabilities and max profit if we could trade at true value
 */
export function projectLmsrLite(prices) {
  if (!Array.isArray(prices) || prices.length === 0) return { projected: [], maxProfitPerShare: 0 };
  const sum = prices.reduce((a, b) => a + b, 0);
  if (sum <= 0) return { projected: prices.map(() => 0), maxProfitPerShare: 0 };
  // Simple normalization: projected_i = price_i / sum (so sum = 1)
  const projected = prices.map(p => p / sum);
  // Max profit: if we buy at ask and true prob is projected, expected value = projected_i * 1 - cost = projected_i - price_i. So profit per share outcome i = projected_i - price_i. For binary, we get 1 share of winner; so max extractable is max(projected_i - price_i) per outcome, but we can only buy one side. So max profit per share = max(projected[0] - prices[0], projected[1] - prices[1], ...). If projected sums to 1 and we have 2 outcomes, profit if we buy outcome 0 = projected[0]*1 - prices[0] = projected[0] - prices[0]. So maxProfitPerShare = max_i (projected[i] - prices[i]).
  let maxProfitPerShare = 0;
  for (let i = 0; i < projected.length; i++) {
    const p = projected[i] - prices[i];
    if (p > maxProfitPerShare) maxProfitPerShare = p;
  }
  return { projected, maxProfitPerShare };
}

/**
 * For a binary market with best ask UP and best ask DOWN, return LMSR-lite projection and whether arb exists (sum < 1).
 * @param {number} askUp
 * @param {number} askDown
 * @returns {{ projectedUp: number, projectedDown: number, sum: number, arb: boolean, maxProfitPerShare: number }}
 */
export function binaryLmsrProjection(askUp, askDown) {
  if (askUp == null || askDown == null) {
    return { projectedUp: null, projectedDown: null, sum: null, arb: false, maxProfitPerShare: 0 };
  }
  const sum = askUp + askDown;
  const { projected, maxProfitPerShare } = projectLmsrLite([askUp, askDown]);
  return {
    projectedUp: projected[0],
    projectedDown: projected[1],
    sum,
    arb: sum < 1,
    maxProfitPerShare
  };
}
