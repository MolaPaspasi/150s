import { CONFIG } from "../config.js";

/**
 * Scalper Engine — captures micro-spreads using Maker (Limit Post-Only) orders.
 * 
 * Strategy:
 * - Continuously compare Binance Price vs Polymarket Orderbook.
 * - Calculate "Fair Probability" based on Binance spot relative to Strike.
 * - If Polymarket spread is wide or prices are misaligned with Fair Prob:
 *   - Place a "Post-Only" limit order to capture the spread/rebate.
 *   - Auto-cancel/re-adjust if price moves.
 */
export class ScalperEngine {
  constructor(tradingEngine) {
    this.trader = tradingEngine;
    this.activeOrders = new Map(); // Track current limit orders
  }

  /**
   * Analyze market for scalp opportunity.
   * 
   * @param {Object} params
   * @param {string} params.slug - Market slug
   * @param {number} params.binancePrice - Binance spot price
   * @param {number} params.targetPrice - Strike/target price (e.g. 68500)
   * @param {Object} params.orderbook - Real-time bestBid/bestAsk for both tokens
   * @param {string} params.upTokenId - UP token ID
   * @param {string} params.downTokenId - DOWN token ID
   */
  async checkOpportunity({ slug, binancePrice, targetPrice, orderbook, upTokenId, downTokenId }) {
    if (!binancePrice || !targetPrice || !orderbook) return null;

    // 1. Calculate Fair Probability (P)
    // Simple linear approximation for 15m/5m markets:
    // If price is AT strike, P = 0.5.
    // If price is $100 above strike, P increases.
    // In HFT, we use Volatility to price this, but for now let's use a dynamic range.
    const delta = binancePrice - targetPrice;
    const volatilityRange = targetPrice * 0.001; // 0.1% move is significant in 15m
    let fairProb = 0.5 + (delta / volatilityRange) * 0.2; // Sensitivity factor
    fairProb = Math.max(0.05, Math.min(0.95, fairProb));

    // 2. Check UP and DOWN books (orderbook keyed by tokenId)
    const upPrices = orderbook[upTokenId];
    const downPrices = orderbook[downTokenId];
    if (upPrices) {
      const { bestBid, bestAsk } = upPrices;

      // If fair probability is significantly higher than Best Ask -> Opportunity to BUY UP
      if (bestAsk && fairProb > bestAsk + 0.03) {
        return {
          slug,
          tokenId: upTokenId,
          side: "UP",
          type: "BUY",
          suggestedPrice: bestAsk,
          isMaker: true
        };
      }

      // If fair probability is significantly lower than Best Bid -> Opportunity to BUY DOWN (use DOWN token's ask)
      if (bestBid && fairProb < bestBid - 0.03 && downPrices?.bestAsk != null) {
        return {
          slug,
          tokenId: downTokenId,
          side: "DOWN",
          type: "BUY",
          suggestedPrice: downPrices.bestAsk,
          isMaker: true
        };
      }
    }

    return null;
  }

  async execute(opportunity, amountUsdc) {
    console.log(`[SCALPER] 🔍 Attempting Scalp: ${opportunity.side} on ${opportunity.slug}`);

    // Use the executeTrade method with makerOnly = true and pass the suggestedPrice
    const result = await this.trader.executeTrade(
      opportunity.tokenId,
      opportunity.side,
      amountUsdc,
      true, // makerOnly
      opportunity.suggestedPrice
    );

    if (result.success) {
      console.log(`[SCALPER] ✅ Order placed: ${opportunity.side}`);
      if (result.orderId) {
        this.activeOrders.set(result.orderId, { ...opportunity, amountUsdc, timestamp: Date.now() });
      }
    } else {
      console.log(`[SCALPER] ❌ Order failed: ${result.error}`);
    }

    return result;
  }
}
