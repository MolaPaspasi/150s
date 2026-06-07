/**
 * Phase 4: Pre-fill simulation — before sending arb orders, check that simulated profit
 * (using current book) still meets min threshold; optional slippage estimate.
 */

import { CONFIG } from "../config.js";

const MIN_PROFIT_PER_SHARE = 0.05;

/**
 * Simulate filling targetShares on both legs at current best ask.
 * If orderbook has depth, optionally estimate worst-case (next level) for slippage.
 * @param {Object} orderbook - { up: { bestAsk, askLiquidity? }, down: { bestAsk, askLiquidity? } }
 * @param {number} targetShares
 * @returns {{ ok: boolean, simulatedProfit: number, profitPerShare: number, reason?: string }}
 */
export function simulateArbFill(orderbook, targetShares) {
  const askUp = orderbook?.up?.bestAsk;
  const askDown = orderbook?.down?.bestAsk;
  const minProfit = CONFIG.arbitrage?.minProfit ?? MIN_PROFIT_PER_SHARE;

  if (askUp == null || askDown == null) {
    return { ok: false, simulatedProfit: 0, profitPerShare: 0, reason: "Missing book" };
  }

  const totalCostPerShare = askUp + askDown;
  const profitPerShare = 1.0 - totalCostPerShare;
  const simulatedProfit = targetShares * profitPerShare;

  const ok = profitPerShare >= minProfit && targetShares >= 1;
  return {
    ok,
    simulatedProfit,
    profitPerShare,
    ...(ok ? {} : { reason: profitPerShare < minProfit ? `Profit $${profitPerShare.toFixed(4)} < min $${minProfit}` : "Shares < 1" })
  };
}

/**
 * Call before execute: if simulation says profit would be below threshold, skip execution.
 */
export function shouldExecuteArb(orderbook, targetShares) {
  const sim = simulateArbFill(orderbook, targetShares);
  return sim.ok;
}
