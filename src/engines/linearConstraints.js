/**
 * Phase 1: Linear constraints — P(YES)+P(NO) > 1.05 and A→B implication rules.
 * Layer 1 LCMM-style: a few simple rules to detect invalid pricing.
 */

const SUM_RULE_THRESHOLD = 1.05; // P(UP)+P(DOWN) > 1.05 => arbitrage / invalid

/**
 * Check single-market sum rule: best ask UP + best ask DOWN should be >= 1 (no free arb).
 * When > 1.05 we treat as "constraint violated" (arb opportunity exists).
 * @param {Object} orderbook - { up: { bestAsk }, down: { bestAsk } }
 * @returns {{ valid: boolean, total: number, violation?: string }}
 */
export function checkSumRule(orderbook) {
  const askUp = orderbook?.up?.bestAsk;
  const askDown = orderbook?.down?.bestAsk;
  if (askUp == null || askDown == null) {
    return { valid: true, total: null };
  }
  const total = askUp + askDown;
  const valid = total <= SUM_RULE_THRESHOLD;
  return {
    valid,
    total,
    ...(valid ? {} : { violation: `P(UP)+P(DOWN)=${total.toFixed(4)} > ${SUM_RULE_THRESHOLD}` })
  };
}

/**
 * A→B implication: if A implies B then P(A) <= P(B) (roughly; same outcome).
 * So we require priceA <= priceB + tolerance.
 * @param {number} priceA - e.g. P(A) (YES/UP price for market A)
 * @param {number} priceB - e.g. P(B)
 * @param {string} relation - "A_IMPLIES_B" | "B_IMPLIES_A"
 * @param {number} tolerance - max allowed slack (default 0.02)
 * @returns {{ valid: boolean, reason?: string }}
 */
export function checkImplication(priceA, priceB, relation, tolerance = 0.02) {
  if (priceA == null || priceB == null) return { valid: true };
  if (relation === "A_IMPLIES_B") {
    // P(A) <= P(B) + tol
    const valid = priceA <= priceB + tolerance;
    return valid ? { valid: true } : { valid: false, reason: `A→B: P(A)=${priceA.toFixed(4)} > P(B)+tol=${(priceB + tolerance).toFixed(4)}` };
  }
  if (relation === "B_IMPLIES_A") {
    const valid = priceB <= priceA + tolerance;
    return valid ? { valid: true } : { valid: false, reason: `B→A: P(B)=${priceB.toFixed(4)} > P(A)+tol=${(priceA + tolerance).toFixed(4)}` };
  }
  return { valid: true };
}

/**
 * Run all Layer 1 checks for one market.
 * @param {Object} orderbook - { up: { bestAsk }, down: { bestAsk } }
 * @returns {{ sumRule: ReturnType<typeof checkSumRule>, violations: string[] }}
 */
export function checkAll(orderbook) {
  const sumRule = checkSumRule(orderbook);
  const violations = [];
  if (!sumRule.valid && sumRule.violation) violations.push(sumRule.violation);
  return { sumRule, violations };
}
