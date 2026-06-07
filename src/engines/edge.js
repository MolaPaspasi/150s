import { clamp } from "../utils.js";
import { projectWithFrankWolfe } from "./frankWolfe.js";

export function computeEdge({ modelUp, modelDown, marketYes, marketNo }) {
  if (marketYes === null || marketNo === null) {
    return { marketUp: null, marketDown: null, edgeUp: null, edgeDown: null };
  }

  const sum = marketYes + marketNo;
  let marketUp = sum > 0 ? marketYes / sum : null;
  let marketDown = sum > 0 ? marketNo / sum : null;

  // When spread is wide (sum deviates significantly from 1.0),
  // use Frank-Wolfe projected probabilities for fairer edge estimate.
  // This corrects for market inefficiency in the orderbook spread.
  const spreadWidth = Math.abs(1.0 - sum);
  if (spreadWidth > 0.10 && marketYes > 0 && marketNo > 0) {
    try {
      const { projected } = projectWithFrankWolfe([marketYes, marketNo]);
      if (projected && projected.length === 2) {
        marketUp = projected[0];
        marketDown = projected[1];
      }
    } catch {
      // Fallback to raw normalization (already done above)
    }
  }

  const edgeUp = marketUp === null ? null : modelUp - marketUp;
  const edgeDown = marketDown === null ? null : modelDown - marketDown;

  return {
    marketUp: marketUp === null ? null : clamp(marketUp, 0, 1),
    marketDown: marketDown === null ? null : clamp(marketDown, 0, 1),
    edgeUp,
    edgeDown
  };
}

export function decide({ remainingMinutes, edgeUp, edgeDown, modelUp = null, modelDown = null, minProb = null, edgeThresh = null }) {
  const phase = remainingMinutes > 10 ? "EARLY" : remainingMinutes > 5 ? "MID" : "LATE";

  /* 
   * DYNAMIC THRESHOLDS (Passed from Config)
   * If config values aren't passed, use safe defaults.
   */

  // Thresholds calibrated for z-score model (more accurate = tighter thresholds ok)
  // EARLY: low bar, z-score uncertain at 15 min out; LATE: z-score reliable, lower edge still good
  const defaultThreshold = phase === "EARLY" ? 0.08 : phase === "MID" ? 0.10 : 0.12;
  const defaultMinProb = phase === "EARLY" ? 0.60 : phase === "MID" ? 0.65 : 0.70;

  const threshold = edgeThresh !== null ? edgeThresh : defaultThreshold;
  const probThreshold = minProb !== null ? minProb : defaultMinProb;

  if (edgeUp === null || edgeDown === null) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data" };
  }

  const bestSide = edgeUp > edgeDown ? "UP" : "DOWN";
  const bestEdge = bestSide === "UP" ? edgeUp : edgeDown;
  const bestModel = bestSide === "UP" ? modelUp : modelDown;

  if (bestEdge < threshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `edge_below_${threshold}` };
  }

  if (bestModel !== null && bestModel < probThreshold) {
    return { action: "NO_TRADE", side: null, phase, reason: `prob_below_${probThreshold}` };
  }

  const strength = bestEdge >= 0.2 ? "STRONG" : bestEdge >= 0.1 ? "GOOD" : "OPTIONAL";
  return { action: "ENTER", side: bestSide, phase, strength, edge: bestEdge };
}

