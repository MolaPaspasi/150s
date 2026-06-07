/**
 * Phase 2: VWAP / order book depth — position sizing so we don't trade below min profit threshold.
 * Kelly-like size cap based on book liquidity and edge.
 */

import { CONFIG } from "../config.js";

const MIN_PROFIT_USD = 0.05;
const MAX_FRACTION_OF_BOOK = 0.25; // don't take more than 25% of best level

/**
 * Given order book summary (best ask, liquidity at best ask), cap size so that:
 * 1. Expected profit per share >= MIN_PROFIT_USD (or config)
 * 2. We don't take more than a fraction of available liquidity (slippage control).
 * @param {Object} params
 * @param {number} params.bestAsk - best ask price
 * @param {number} [params.askLiquidity] - size at best ask (shares)
 * @param {number} params.baseAmountUsdc - desired spend from getTradeAmount
 * @param {number} [params.profitIfWin] - 1 - bestAsk for binary; if below MIN_PROFIT_USD we may reduce or skip
 * @returns {{ amountUsdc: number, shares: number, skip: boolean, reason?: string }}
 */
export function capSizeByBook({ bestAsk, askLiquidity = 1e6, baseAmountUsdc, profitIfWin }) {
  const minProfit = CONFIG.scalper?.minProfit ?? MIN_PROFIT_USD;
  if (profitIfWin != null && profitIfWin < minProfit) {
    return {
      amountUsdc: 0,
      shares: 0,
      skip: true,
      reason: `Profit per share $${profitIfWin.toFixed(3)} < min $${minProfit}`
    };
  }
  const maxSharesByLiquidity = Math.floor(askLiquidity * MAX_FRACTION_OF_BOOK);
  const sharesByBudget = bestAsk > 0 ? Math.floor(baseAmountUsdc / bestAsk) : 0;
  const shares = Math.min(maxSharesByLiquidity, sharesByBudget);
  const amountUsdc = Math.min(baseAmountUsdc, shares * bestAsk);
  return {
    amountUsdc,
    shares,
    skip: shares < 1,
    reason: shares < 1 ? "Size too small after book cap" : undefined
  };
}

/**
 * Integrate with getTradeAmount: returns the same or reduced amount based on order book.
 * Call this when you have orderbook and want to size the next trade.
 */
export function getTradeAmountCapped(baseAmountUsdc, orderbookSide, profitIfWin) {
  const bestAsk = orderbookSide?.bestAsk;
  const askLiquidity = orderbookSide?.askLiquidity ?? 1e6;
  if (bestAsk == null) return { amountUsdc: baseAmountUsdc, skip: false };
  return capSizeByBook({
    bestAsk,
    askLiquidity,
    baseAmountUsdc,
    profitIfWin
  });
}
