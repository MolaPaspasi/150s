/**
 * Phase 1: Dependency mapping — relate current market to other markets (same underlying, different timeframe/strike).
 * Used for A→B logical constraints and cross-market arbitrage.
 */

import { CONFIG } from "../config.js";
import { fetchMarketsBySeriesSlug, fetchLiveEventsBySeriesId, flattenEventMarkets } from "../data/polymarket.js";

// Optional: map asset to related series slugs (15m, 1h, strikes). Extend via config later.
const RELATED_SERIES = {
  BTC: ["btc-up-or-down-15m"], // add "btc-up-or-down-1h" etc. when Polymarket has them
  ETH: ["eth-up-or-down-15m"],
  SOL: ["sol-up-or-down-15m"]
};

function getSeriesId(assetName) {
  return CONFIG.assets?.[assetName]?.polymarket?.seriesId || (assetName === "BTC" ? "10192" : assetName === "ETH" ? "10191" : "10423");
}

/**
 * Get related markets for an asset (same underlying, possibly different timeframe).
 * @param {string} assetName - e.g. "BTC", "ETH", "SOL"
 * @param {string} [excludeSlug] - current market slug to exclude from results
 * @returns {Promise<Array<{ slug: string, question: string, endDate: string, seriesSlug: string }>>}
 */
export async function getRelatedMarkets(assetName, excludeSlug = null) {
  const seriesSlugs = RELATED_SERIES[assetName] || [];
  const seriesId = getSeriesId(assetName);
  const out = [];
  const seen = new Set();

  for (const seriesSlug of seriesSlugs) {
    try {
      let markets = [];
      if (seriesId) {
        const events = await fetchLiveEventsBySeriesId({ seriesId, limit: 5 });
        markets = flattenEventMarkets(events);
      }
      if (markets.length === 0) {
        markets = await fetchMarketsBySeriesSlug({ seriesSlug, limit: 10 });
      }
      for (const m of markets) {
        const slug = m.slug || m.id;
        if (!slug || seen.has(slug)) continue;
        if (excludeSlug && String(slug) === String(excludeSlug)) continue;
        seen.add(slug);
        out.push({
          slug,
          question: m.question || "",
          endDate: m.endDate || m.end_time,
          seriesSlug
        });
      }
    } catch (e) {
      // ignore per-series errors
    }
  }
  return out;
}

/**
 * Check if two markets have a logical dependency A→B (e.g. "1h UP" implies "15m UP" for same strike).
 * Placeholder: returns null when we don't have strike/condition metadata; can be extended.
 * @param {Object} marketA - { slug, question }
 * @param {Object} marketB - { slug, question }
 * @returns {string|null} "A_IMPLIES_B" | "B_IMPLIES_A" | null
 */
export function inferImplication(marketA, marketB) {
  if (!marketA?.question || !marketB?.question) return null;
  const qA = marketA.question.toLowerCase();
  const qB = marketB.question.toLowerCase();
  // Example: "btc 1h above 100k" implies "btc 15m above 100k" (longer window => shorter window)
  if (qA.includes("1h") && qB.includes("15m") && (qA.includes("btc") || qA.includes("eth") || qA.includes("sol"))) {
    if ((qB.includes("btc") || qB.includes("eth") || qB.includes("sol"))) return "A_IMPLIES_B";
  }
  if (qB.includes("1h") && qA.includes("15m")) return "B_IMPLIES_A";
  return null;
}
