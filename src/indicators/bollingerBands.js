/**
 * Bollinger Bands indicator.
 * Used to confirm momentum (price outside bands = genuine move, not noise).
 */

/**
 * Compute Bollinger Bands from closing prices.
 * @param {number[]} closes - Array of closing prices
 * @param {number} period - Lookback period (default 20)
 * @param {number} multiplier - Standard deviation multiplier (default 2)
 * @returns {{ upper: number, lower: number, middle: number, bandwidth: number, percentB: number } | null}
 */
export function computeBollingerBands(closes, period = 20, multiplier = 2) {
    if (!closes || closes.length < period) return null;

    const slice = closes.slice(-period);
    const middle = slice.reduce((sum, v) => sum + v, 0) / period;

    const variance = slice.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);

    const upper = middle + multiplier * stdDev;
    const lower = middle - multiplier * stdDev;

    const currentPrice = closes[closes.length - 1];

    // bandwidth: how wide the bands are relative to middle (volatility measure)
    const bandwidth = middle > 0 ? (upper - lower) / middle : 0;

    // percentB: where is price relative to bands? >1 = above upper, <0 = below lower
    const range = upper - lower;
    const percentB = range > 0 ? (currentPrice - lower) / range : 0.5;

    return { upper, lower, middle, bandwidth, percentB, stdDev };
}

/**
 * Check if price has momentum (outside Bollinger Band threshold).
 * @param {number} percentB - From computeBollingerBands
 * @param {string} side - "UP" or "DOWN"
 * @param {number} threshold - How far outside bands to confirm (default 0.75 = 75th percentile)
 * @returns {boolean}
 */
export function hasBollingerMomentum(percentB, side, threshold = 0.75) {
    if (percentB === null || percentB === undefined) return false;
    if (side === "UP") return percentB >= threshold;
    if (side === "DOWN") return percentB <= (1 - threshold);
    return false;
}

/**
 * Compute ATR (Average True Range) for volatility assessment.
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {number} period
 * @returns {number|null}
 */
export function computeATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return null;

    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].high;
        const low = candles[i].low;
        const prevClose = candles[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trueRanges.push(tr);
    }

    if (trueRanges.length < period) return null;

    // Simple average of last `period` true ranges
    const slice = trueRanges.slice(-period);
    return slice.reduce((sum, v) => sum + v, 0) / period;
}
