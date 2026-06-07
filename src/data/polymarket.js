import { CONFIG } from "../config.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const GAMMA_RATE_LIMIT_DELAY_MS = 60;
const GAMMA_429_RETRY_ATTEMPTS = 3;
const GAMMA_429_BACKOFF_MS = 2000;

async function fetchWithRetry(url, options = {}, attempt = 1) {
  const res = await fetch(url, options);
  if (res.status === 429 && attempt < GAMMA_429_RETRY_ATTEMPTS) {
    const wait = GAMMA_429_BACKOFF_MS * attempt;
    await new Promise((r) => setTimeout(r, wait));
    return fetchWithRetry(url, options, attempt + 1);
  }
  return res;
}

export async function fetchMarketBySlug(slug, { closed } = {}) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("slug", slug);
  if (closed != null) url.searchParams.set("closed", String(closed));

  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`Gamma markets error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const market = Array.isArray(data) ? data[0] : data;
  if (!market) return null;

  return market;
}

export async function fetchResolvedMarket(slug) {
  // Try closed first, then active (handles both just-closed and still-resolving)
  const closed = await fetchMarketBySlug(slug, { closed: true });
  if (closed) return closed;
  return fetchMarketBySlug(slug);
}

/**
 * Get CLOB token IDs for a market by slug (for whale copy trading).
 * Handles both "Up"/"Down" and "Yes"/"No" outcome labels.
 * @param {string} slug - Market slug (e.g. btc-updown-15m-1771064100)
 * @returns {Promise<{ upTokenId: string, downTokenId: string } | null>}
 */
export async function getTokenIdsForMarketBySlug(slug) {
  const market = await fetchMarketBySlug(slug);
  if (!market) return null;

  const outcomes = Array.isArray(market.outcomes)
    ? market.outcomes
    : (typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : []);
  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : []);

  let upTokenId = null;
  let downTokenId = null;
  const upLabels = ["up", "yes"];
  const downLabels = ["down", "no"];

  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]).toLowerCase();
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;
    if (upLabels.includes(label)) upTokenId = tokenId;
    if (downLabels.includes(label)) downTokenId = tokenId;
  }

  if (!upTokenId || !downTokenId) return null;
  return { upTokenId, downTokenId, conditionId: market.conditionId || market.id || null };
}

export async function fetchMarketsBySeriesSlug({ seriesSlug, limit = 50 }) {
  // 1. Try fetching by seriesSlug directly
  try {
    const url = new URL("/markets", CONFIG.gammaBaseUrl);
    url.searchParams.set("seriesSlug", seriesSlug);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("enableOrderBook", "true");
    url.searchParams.set("limit", String(limit));

    const res = await fetchWithRetry(url);
    if (res.ok) {
      const data = await res.json();
      // The API might ignore invalid seriesSlug and return all markets. 
      // We must check if the returned data actually relates to our query if we used a slug.
      // However, if we are using "bitcoin up or down" as a slug, it certainly won't match a real seriesSlug field.
      // So sending it as seriesSlug is likely the wrong approach if it's not a real slug.

      // Strategy: If the input looks like a real slug (no spaces), trust the API (mostly).
      // If it looks like keywords (has spaces), SKIP this header fetch and go straight to search.
      if (!seriesSlug.includes(" ") && Array.isArray(data) && data.length > 0) {
        return data;
      }
    }
  } catch (e) { }

  // 2. Fallback: Search in high-volume markets
  // We fetch a larger batch to ensure we find our specific markets
  const allMarkets = await fetchActiveMarkets({ limit: 500, order: "volume24hr", ascending: false });

  // Normalized keywords
  const keywords = seriesSlug.toLowerCase().split("-").join(" ").split(" ").filter(w => w.length > 2);

  return allMarkets.filter(m => {
    const q = (m.question || "").toLowerCase();
    // Must match ALL keywords
    return keywords.every(k => q.includes(k));
  });
}

export async function fetchLiveEventsBySeriesId({ seriesId, limit = 20 }) {
  const url = new URL("/events", CONFIG.gammaBaseUrl);
  url.searchParams.set("series_id", String(seriesId));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("enableOrderBook", "true");
  url.searchParams.set("limit", String(limit));

  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`Gamma events(series_id) error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export function flattenEventMarkets(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    const markets = Array.isArray(e.markets) ? e.markets : [];
    for (const m of markets) {
      out.push(m);
    }
  }
  return out;
}

export async function fetchActiveMarkets({ limit = 200, offset = 0, order, ascending } = {}) {
  const url = new URL("/markets", CONFIG.gammaBaseUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("enableOrderBook", "true");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  if (order) url.searchParams.set("order", order);
  if (ascending !== undefined) url.searchParams.set("ascending", String(ascending));

  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`Gamma markets(active) error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function safeTimeMs(x) {
  if (!x) return null;
  const t = new Date(x).getTime();
  return Number.isFinite(t) ? t : null;
}

export function pickLatestLiveMarket(markets, nowMs = Date.now()) {
  if (!Array.isArray(markets) || markets.length === 0) return null;

  const enriched = markets
    .map((m) => {
      const endMs = safeTimeMs(m.endDate);
      const startMs = safeTimeMs(m.eventStartTime ?? m.startTime ?? m.startDate);
      return { m, endMs, startMs };
    })
    .filter((x) => x.endMs !== null);

  const live = enriched
    .filter((x) => {
      const started = x.startMs === null ? true : x.startMs <= nowMs;
      return started && nowMs < x.endMs;
    })
    .sort((a, b) => a.endMs - b.endMs);

  if (live.length) return live[0].m;

  const upcoming = enriched
    .filter((x) => nowMs < x.endMs)
    .sort((a, b) => a.endMs - b.endMs);

  return upcoming.length ? upcoming[0].m : null;
}

function marketHasSeriesSlug(market, seriesSlug) {
  if (!market || !seriesSlug) return false;

  const events = Array.isArray(market.events) ? market.events : [];
  for (const e of events) {
    const series = Array.isArray(e.series) ? e.series : [];
    for (const s of series) {
      if (String(s.slug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
    }
    if (String(e.seriesSlug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
  }
  if (String(market.seriesSlug ?? "").toLowerCase() === String(seriesSlug).toLowerCase()) return true;
  return false;
}

export function filterBtcUpDown15mMarkets(markets, { seriesSlug, slugPrefix } = {}) {
  const prefix = (slugPrefix ?? "").toLowerCase();
  const wantedSeries = (seriesSlug ?? "").toLowerCase();

  return (Array.isArray(markets) ? markets : []).filter((m) => {
    const slug = String(m.slug ?? "").toLowerCase();
    const matchesPrefix = prefix ? slug.startsWith(prefix) : false;
    const matchesSeries = wantedSeries ? marketHasSeriesSlug(m, wantedSeries) : false;
    return matchesPrefix || matchesSeries;
  });
}

export async function fetchClobPrice({ tokenId, side }) {
  const url = new URL("/price", CONFIG.clobBaseUrl);
  url.searchParams.set("token_id", tokenId);
  url.searchParams.set("side", side);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CLOB price error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return toNumber(data.price);
}

export async function fetchOrderBook({ tokenId }) {
  const url = new URL("/book", CONFIG.clobBaseUrl);
  url.searchParams.set("token_id", tokenId);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CLOB book error: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

export function summarizeOrderBook(book, depthLevels = 5) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  const bestBid = bids.length
    ? bids.reduce((best, lvl) => {
      const p = toNumber(lvl.price);
      if (p === null) return best;
      if (best === null) return p;
      return Math.max(best, p);
    }, null)
    : null;

  const bestAsk = asks.length
    ? asks.reduce((best, lvl) => {
      const p = toNumber(lvl.price);
      if (p === null) return best;
      if (best === null) return p;
      return Math.min(best, p);
    }, null)
    : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  const bidLiquidity = bids.slice(0, depthLevels).reduce((acc, x) => acc + (toNumber(x.size) ?? 0), 0);
  const askLiquidity = asks.slice(0, depthLevels).reduce((acc, x) => acc + (toNumber(x.size) ?? 0), 0);

  return {
    bestBid,
    bestAsk,
    spread,
    bidLiquidity,
    askLiquidity
  };
}
