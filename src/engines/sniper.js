import { CONFIG } from "../config.js";

/**
 * Polymarket 15m crypto market fee calculator.
 * Taker fee is highest at 50¢ (~3%) and near-zero at 0/100¢.
 * Formula: fee = feeRate * price * (1 - price) * 2 * shares
 * At 97¢: fee ≈ 0.07 * 0.97 * 0.03 * 2 = ~0.4% effective
 * At 50¢: fee ≈ 0.07 * 0.50 * 0.50 * 2 = ~3.5% effective
 */
const FEE_RATE = 0.07; // Polymarket's base fee rate for 15m crypto

export function calculateTakerFee(price, shares) {
    // Fee = feeRate * price * (1 - price) * 2 * shares
    const fee = FEE_RATE * price * (1 - price) * 2 * shares;
    return Math.round(fee * 10000) / 10000; // Round to 4 decimals
}

export function calculateEffectiveFeePercent(price) {
    // Effective fee % at a given price
    return FEE_RATE * (1 - price) * 2 * 100;
}

/**
 * Sniper Engine — buys the winning side in the last seconds before market close.
 * 
 * Strategy:
 * - When market has <= SNIPE_WINDOW seconds left
 * - Check if Oracle price clearly above/below target (strike)
 * - If winning side's ask price <= SNIPE_MAX_PRICE
 * - Buy the winning side with maker limit order
 * - Payout = $1.00, cost = ask price + fee → profit = 1.00 - cost - fee
 */
export class SniperEngine {
    constructor(tradingEngine) {
        this.trader = tradingEngine;
        this.snipedMarkets = new Set(); // Track already-sniped markets
    }

    /**
     * Check if a snipe opportunity exists.
     * 
     * @param {Object} params
     * @param {string} params.slug - Market slug
     * @param {number} params.remainingMs - Milliseconds until market close
     * @param {number} params.oraclePrice - Chainlink oracle price
     * @param {number} params.binancePrice - Binance spot price
     * @param {number} params.targetPrice - Strike/target price
     * @param {number} params.askUp - Best ask for UP
     * @param {number} params.askDown - Best ask for DOWN
     * @param {string} params.upTokenId - UP token ID
     * @param {string} params.downTokenId - DOWN token ID
     * @returns {Object|null} Snipe opportunity or null
     */
    checkOpportunity({ slug, remainingMs, oraclePrice, binancePrice, targetPrice, askUp, askDown, upTokenId, downTokenId, minPriceOverride, maxPriceOverride, minConfidenceOverride, windowSecondsOverride, assetName }) {
        // Already sniped this market
        if (this.snipedMarkets.has(slug)) return null;

        // Config
        const windowMs = (windowSecondsOverride ?? CONFIG.sniper?.windowSeconds ?? 60) * 1000;
        const maxPrice = maxPriceOverride ?? CONFIG.sniper?.maxPrice ?? 0.99;
        const minPrice = minPriceOverride ?? CONFIG.sniper?.minPrice ?? 0.80;

        // Not in snipe window yet
        if (remainingMs > windowMs || remainingMs <= 0) return null;

        // Need both prices
        if (!oraclePrice || !targetPrice || !binancePrice) return null;
        if (askUp == null || askDown == null) return null;

        // Determine winning side based on BOTH oracle AND binance agreeing
        const oracleDelta = oraclePrice - targetPrice;
        const binanceDelta = binancePrice - targetPrice;
        const oraclePct = Math.abs(oracleDelta) / targetPrice;

        // Both sources must agree on direction
        const oracleUp = oracleDelta > 0;
        const binanceUp = binanceDelta > 0;

        if (oracleUp !== binanceUp) {
            // Sources disagree — too risky
            return null;
        }

        // Tiered confidence based on remaining time, floored by per-asset or global config
        const remainingSec = remainingMs / 1000;
        const perAssetFloor = assetName ? (CONFIG.sniper?.minConfidencePerAsset?.[assetName] ?? null) : null;
        const configFloor = perAssetFloor ?? minConfidenceOverride ?? CONFIG.sniper?.minConfidence ?? 0.0005;
        let minConfidence;
        if (remainingSec < 20) {
            minConfidence = 0.0005;
        } else if (remainingSec < 35) {
            minConfidence = 0.0005;
        } else if (remainingSec < 50) {
            minConfidence = 0.0005;
        } else {
            minConfidence = 0.001;
        }
        minConfidence = Math.max(minConfidence, configFloor);

        // Price must be meaningfully above/below target (not a coin flip)
        if (oraclePct < minConfidence) {
            return null;
        }

        const winningSide = oracleUp ? "UP" : "DOWN";
        const askPrice = winningSide === "UP" ? askUp : askDown;
        const tokenId = winningSide === "UP" ? upTokenId : downTokenId;

        // Check if price is within our min/max threshold
        // minPrice ensures market agrees with oracle (≥80% confident)
        if (askPrice > maxPrice || askPrice < minPrice) return null;

        // Orderbook imbalance check: if winning side ask is significantly
        // cheaper than losing side, the market agrees → higher confidence
        const losingAsk = winningSide === "UP" ? askDown : askUp;
        const imbalance = losingAsk > 0 ? askPrice / losingAsk : 1;
        // If imbalance > 0.8 (prices too close), the market is uncertain → skip
        if (imbalance > 0.8 && oraclePct < 0.001) {
            return null;
        }

        // Calculate fee and net profit
        const shares = 1; // Per-share calculation
        const fee = calculateTakerFee(askPrice, shares);
        const costPerShare = askPrice + fee;
        const profitPerShare = 1.00 - costPerShare;

        // Must be profitable after fees — require at least 8% return per share
        // At $0.92 ask: profit ≈ $0.08 → 8.7% ✓  At $0.95: profit ≈ $0.05 → 5.3% ✗
        const minMargin = CONFIG.sniper?.minProfitPct ?? 0.08;
        if (profitPerShare <= 0 || (profitPerShare / costPerShare) < minMargin) return null;

        return {
            slug,
            side: winningSide,
            tokenId,
            askPrice,
            fee,
            costPerShare,
            profitPerShare,
            profitPct: (profitPerShare / costPerShare) * 100,
            oraclePrice,
            binancePrice,
            targetPrice,
            remainingMs,
            oraclePct: oraclePct * 100,
            imbalance
        };
    }

    /**
     * Execute a snipe trade.
     */
    async execute(opportunity, tradeAmount) {
        this.snipedMarkets.add(opportunity.slug);

        const { tokenId, side, askPrice, fee, costPerShare, profitPerShare } = opportunity;

        // Pre-trade estimate (used for the log and as fallback if API returns nothing)
        const estimatedShares = Math.floor(tradeAmount / costPerShare);
        if (estimatedShares < 1) {
            return { success: false, error: "Insufficient budget for 1 share" };
        }

        console.log(`[SNIPER] ⚡ ${side} @ ${askPrice.toFixed(3)} | Est. Shares: ${estimatedShares} | Est. Cost: $${(estimatedShares * costPerShare).toFixed(2)}`);

        // Taker order: fills immediately against the book — guaranteed fill in last 60s
        // Maker (post-only) risked expiring unfilled if no counterparty appeared
        const result = await this.trader.executeTrade(tokenId, side, tradeAmount, false, opportunity.askPrice);

        // Use actual filled shares from API (FAK may partially fill — takingAmount = shares received)
        const shares = (result.fillShares && result.fillShares > 0) ? result.fillShares : estimatedShares;
        const totalCost = shares * costPerShare;
        const totalFee = shares * fee;
        const totalProfit = shares * profitPerShare;

        if (shares !== estimatedShares) {
            console.log(`[SNIPER] ⚠ Partial fill: ${shares}/${estimatedShares} shares | Actual cost: $${totalCost.toFixed(2)}`);
        }

        return {
            ...result,
            shares,
            totalCost,
            totalFee,
            totalProfit,
            side,
            askPrice,
            costPerShare,
            profitPerShare
        };
    }

    /**
     * Clean up old market tracking when new market detected.
     */
    cleanupOldMarkets(currentSlugs) {
        for (const slug of this.snipedMarkets) {
            if (!currentSlugs.includes(slug)) {
                this.snipedMarkets.delete(slug);
            }
        }
    }
}
