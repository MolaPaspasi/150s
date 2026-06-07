import { clamp } from "../utils.js";

/**
 * Z-score → probability via sigmoid.
 * k=1.5 gives reasonable sensitivity for BTC 15m markets.
 * z=1  → ~82% UP, z=2 → ~95%, z=-1 → ~18%, z=0 → 50%
 */
function zScoreToProb(z, k = 1.5) {
  return 1 / (1 + Math.exp(-k * z));
}

/**
 * Score direction of the market.
 *
 * Primary signal: distance-to-strike z-score.
 *   z = (price - strike) / (atr * sqrt(remainingFraction))
 *   This answers: "how many expected moves is price away from strike?"
 *   Already embeds time — no further time decay needed when available.
 *
 * Secondary signals: lagging indicators (VWAP slope, RSI, MACD) applied
 *   as small ±bias adjustments (~±0.05 total max) on top of z-score.
 *
 * Falls back to pure indicator voting if z-score inputs are missing.
 */
export function scoreDirection(inputs) {
  const {
    price,
    strikePrice,
    atr,
    remainingMinutes,
    windowMinutes,
    vwap,
    vwapSlope,
    rsi,
    macd,
    failedVwapReclaim
  } = inputs;

  // --- Primary: z-score model ---
  let zProb = null;
  const hasZScore =
    price != null && strikePrice != null && strikePrice > 0 &&
    atr != null && atr > 0 &&
    remainingMinutes != null && remainingMinutes > 0 &&
    windowMinutes != null && windowMinutes > 0;

  if (hasZScore) {
    const remainingFraction = Math.min(1, remainingMinutes / windowMinutes);
    const expectedMove = atr * Math.sqrt(remainingFraction);
    if (expectedMove > 0) {
      const z = (price - strikePrice) / expectedMove;
      zProb = zScoreToProb(clamp(z, -4, 4));
    }
  }

  // --- Secondary: indicator bias (small adjustment, max ±0.08) ---
  let indicatorBias = 0;

  if (vwapSlope != null) {
    indicatorBias += vwapSlope > 0 ? 0.03 : -0.03;
  }

  if (rsi != null) {
    if (rsi > 60) indicatorBias += 0.03;
    else if (rsi < 40) indicatorBias -= 0.03;
  }

  if (macd?.hist != null) {
    indicatorBias += macd.hist > 0 ? 0.02 : -0.02;
  }

  if (failedVwapReclaim === true) {
    indicatorBias -= 0.05;
  }

  let rawUp;
  if (zProb != null) {
    // z-score is primary — indicators are small correction only
    rawUp = clamp(zProb + indicatorBias, 0.05, 0.95);
  } else {
    // Fallback: pure indicator voting (original logic)
    let up = 1;
    let down = 1;

    if (price !== null && vwap !== null) {
      if (price > vwap) up += 2;
      if (price < vwap) down += 2;
    }
    if (vwapSlope !== null) {
      if (vwapSlope > 0) up += 2;
      if (vwapSlope < 0) down += 2;
    }
    if (rsi !== null) {
      if (rsi > 55) up += 2;
      if (rsi < 45) down += 2;
    }
    if (macd?.hist !== null && macd?.histDelta !== null) {
      if (macd.hist > 0 && macd.histDelta > 0) up += 2;
      if (macd.hist < 0 && macd.histDelta < 0) down += 2;
      if (macd.macd > 0) up += 1;
      if (macd.macd < 0) down += 1;
    }
    if (failedVwapReclaim === true) down += 3;

    rawUp = up / (up + down);
  }

  return {
    upScore: rawUp * 10,
    downScore: (1 - rawUp) * 10,
    rawUp,
    hasZScore: zProb != null,
    zProb,
    indicatorBias
  };
}

/**
 * Apply time-awareness decay — pulls probability toward 0.5 as remaining time decreases.
 * Used ONLY when z-score is unavailable (no strike price).
 * When z-score is active, call this with timeDecay=1 or skip entirely.
 */
export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
