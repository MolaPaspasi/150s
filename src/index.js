/**
 * pompav5 — Market Price Sniper
 *
 * Strategy: At T-60s, if Polymarket prices one side >= MIN_PRICE and <= MAX_PRICE,
 * buy that side. No oracle, no z-score — pure market consensus signal.
 * Never buys the same market twice, even if price fluctuates in/out of range.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { CONFIG } from "./config.js";
import {
  fetchLiveEventsBySeriesId,
  fetchMarketsBySeriesSlug,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchOrderBook,
  summarizeOrderBook,
  fetchResolvedMarket,
} from "./data/polymarket.js";
import { polyOrderbookWs } from "./data/polymarketOrderbookWs.js";
import { TradingEngine } from "./engines/trading.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { sleep } from "./utils.js";
import { initTelegram, notifyTrade, notifyResult } from "./services/telegram.js";
import fs from "fs";
import path from "path";

applyGlobalProxyFromEnv();
initTelegram();

// ─── Config ───────────────────────────────────────────────────────────────────

const MIN_PRICE      = parseFloat(process.env.SNIPE_MIN_PRICE    || "0.70");
const MAX_PRICE      = parseFloat(process.env.SNIPE_MAX_PRICE    || "0.95");
const WINDOW_SECONDS = parseInt(process.env.SNIPE_WINDOW_SECONDS  || "60");
const TRADE_AMOUNT   = parseFloat(process.env.TRADE_AMOUNT_USDC   || "20");
const POLL_MS        = 1000;

const ASSETS = Object.entries(CONFIG.assets)
  .filter(([name]) => CONFIG.activeAssets.includes(name))
  .filter(([, conf]) => conf.polymarket)
  .map(([name, conf]) => ({ name, conf }));

// ─── Market resolution ────────────────────────────────────────────────────────

const marketCache = {};

async function resolveMarket(assetConf) {
  const { polymarket } = assetConf;
  const seriesId   = polymarket.seriesId;
  const seriesSlug = polymarket.seriesSlug;
  const cacheKey   = seriesId || seriesSlug;
  const now        = Date.now();

  if (!marketCache[cacheKey]) marketCache[cacheKey] = { market: null, fetchedAtMs: 0 };
  const cache = marketCache[cacheKey];

  if (cache.market) {
    const endMs      = cache.market.endDate ? new Date(cache.market.endDate).getTime() : null;
    const stale      = now - cache.fetchedAtMs > 30_000; // refresh prices every 30s
    const nearClose  = Number.isFinite(endMs) && now >= endMs - 60_000;
    if (!stale && !nearClose && Number.isFinite(endMs)) return cache.market;
  }

  try {
    let markets = [];
    if (seriesId) {
      const events = await fetchLiveEventsBySeriesId({ seriesId, limit: 5 });
      markets = flattenEventMarkets(events);
    }
    if (markets.length === 0 && seriesSlug) {
      markets = await fetchMarketsBySeriesSlug({ seriesSlug, limit: 10 });
    }
    const picked = pickLatestLiveMarket(markets);
    if (picked) { cache.market = picked; cache.fetchedAtMs = now; }
  } catch { /* keep old cache */ }

  return cache.market;
}

// ─── Token ID extraction ──────────────────────────────────────────────────────

function extractTokenIds(market, assetConf) {
  const { polymarket } = assetConf;
  const upLabel   = polymarket.upLabel   || "Up";
  const downLabel = polymarket.downLabel || "Down";

  const outcomes = Array.isArray(market.outcomes)
    ? market.outcomes
    : JSON.parse(market.outcomes || "[]");
  const tokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : JSON.parse(market.clobTokenIds || "[]");

  let upTokenId = null, downTokenId = null;
  for (let i = 0; i < outcomes.length; i++) {
    const label = String(outcomes[i] || "").toLowerCase();
    if (label === upLabel.toLowerCase())   upTokenId   = String(tokenIds[i] || "");
    if (label === downLabel.toLowerCase()) downTokenId = String(tokenIds[i] || "");
  }
  return { upTokenId, downTokenId };
}

// ─── Price fetcher (WS → REST → Gamma, cached 15s) ───────────────────────────

const _polyPriceCache = {};

async function fetchPolyPrices(market, conf) {
  const slug = market.slug;
  const cached = _polyPriceCache[slug];
  if (cached && Date.now() - cached.t < 15_000) return cached;

  const { upTokenId, downTokenId } = extractTokenIds(market, conf);

  // Gamma outcomePrices as baseline
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices : JSON.parse(market.outcomePrices || "[]");
  const outcomes = Array.isArray(market.outcomes)
    ? market.outcomes : JSON.parse(market.outcomes || "[]");
  const { upLabel = "Up", downLabel = "Down" } = conf.polymarket || {};
  let gammaUp = null, gammaDown = null;
  for (let i = 0; i < outcomes.length; i++) {
    const lbl = String(outcomes[i] || "").toLowerCase();
    if (lbl === upLabel.toLowerCase())   gammaUp   = parseFloat(outcomePrices[i]) || null;
    if (lbl === downLabel.toLowerCase()) gammaDown = parseFloat(outcomePrices[i]) || null;
  }

  if (!upTokenId || !downTokenId) {
    return { pUp: gammaUp, pDown: gammaDown, askUp: gammaUp, askDown: gammaDown, t: Date.now() };
  }

  // WS cache first
  polyOrderbookWs.subscribe([upTokenId, downTokenId]);
  const upWs   = polyOrderbookWs.getBestPrices(upTokenId);
  const downWs = polyOrderbookWs.getBestPrices(downTokenId);

  let askUp   = upWs?.bestAsk   ?? null;
  let askDown = downWs?.bestAsk ?? null;

  // REST fallback for missing sides
  if (!askUp || !askDown) {
    try {
      const [upBook, downBook] = await Promise.all([
        askUp   ? null : fetchOrderBook({ tokenId: upTokenId }),
        askDown ? null : fetchOrderBook({ tokenId: downTokenId }),
      ]);
      if (!askUp   && upBook)   askUp   = summarizeOrderBook(upBook).bestAsk;
      if (!askDown && downBook) askDown = summarizeOrderBook(downBook).bestAsk;
    } catch { /* keep nulls */ }
  }

  const result = {
    pUp:   askUp   ?? gammaUp,
    pDown: askDown ?? gammaDown,
    askUp:  askUp  ?? gammaUp,
    askDown: askDown ?? gammaDown,
    upTokenId, downTokenId,
    t: Date.now(),
  };
  _polyPriceCache[slug] = result;
  return result;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

const LOGS_DIR = "./logs";
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function loadStats(name) {
  try { return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, `stats_${name}.json`), "utf8")); }
  catch { return { wins: 0, losses: 0, trades: [] }; }
}
function saveStats(name, stats) {
  fs.writeFileSync(path.join(LOGS_DIR, `stats_${name}.json`), JSON.stringify(stats, null, 2));
}

function formatRem(ms) {
  const s = Math.round(ms / 1000);
  return s > 60 ? `${Math.floor(s/60)}m${s%60}s` : `${s}s`;
}

// ─── Settlement checker ───────────────────────────────────────────────────────

async function settleOpenTrades(name, stats) {
  const unsettled = stats.trades.filter(t => !t.settled);
  if (!unsettled.length) return false;

  let changed = false;
  for (const trade of unsettled) {
    try {
      const market = await fetchResolvedMarket(trade.slug);
      if (!market) continue;
      if (!market.closed) continue; // still active — don't settle yet

      // Not resolved yet
      const prices = Array.isArray(market.outcomePrices)
        ? market.outcomePrices
        : JSON.parse(market.outcomePrices || "[]");
      const outcomes = Array.isArray(market.outcomes)
        ? market.outcomes
        : JSON.parse(market.outcomes || "[]");

      // Winner = side with highest price if >= 0.90 (Gamma API can show 0.90-1.00 on resolution)
      let winner = null;
      let maxPrice = 0;
      for (let i = 0; i < outcomes.length; i++) {
        const p = parseFloat(prices[i] || "0");
        if (p > maxPrice) { maxPrice = p; }
      }
      if (maxPrice >= 0.90) {
        for (let i = 0; i < outcomes.length; i++) {
          if (parseFloat(prices[i] || "0") === maxPrice) {
            const label = String(outcomes[i] || "").toLowerCase();
            if (["up", "yes"].includes(label))   winner = "UP";
            if (["down", "no"].includes(label))  winner = "DOWN";
          }
        }
      }

      if (!winner) continue; // still unresolved

      trade.settled = true;
      trade.result  = trade.side === winner ? "WIN" : "LOSS";
      if (trade.result === "WIN") stats.wins++;
      else stats.losses++;

      const pnl = trade.result === "WIN"
        ? parseFloat(((trade.shares || 0) * (1 - (trade.askPrice || 0))).toFixed(2))
        : -(trade.amount || 0);

      const icon = trade.result === "WIN" ? "✅" : "❌";
      pushEvent(`${icon} [${name}] ${trade.side} → ${trade.result} | P&L:${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${trade.slug}`);
      notifyResult({ asset: name, side: trade.side, result: trade.result, pnl, type: trade.dryRun ? "DRY RUN" : "LIVE" });
      changed = true;
    } catch { /* skip, try next tick */ }
  }
  return changed;
}

// ─── Dashboard renderer ───────────────────────────────────────────────────────

const DIVIDER = "─".repeat(68);
const HEADER  = "═".repeat(68);
const recentEvents = [];

function pushEvent(msg) {
  const ts = new Date().toLocaleTimeString();
  recentEvents.push(`  [${ts}] ${msg}`);
  if (recentEvents.length > 12) recentEvents.shift();
}

function renderDashboard(rows, now) {
  const mode = CONFIG.trading.enabled ? "LIVE" : "DRY RUN";
  const time = new Date(now).toLocaleTimeString();

  let out = "\x1b[H\x1b[2J"; // clear screen
  out += `${HEADER}\n`;
  out += `  pompav5 — Market Price Sniper | ${time} | ${mode}\n`;
  out += `  Price range: $${MIN_PRICE} – $${MAX_PRICE}  |  Window: T-${WINDOW_SECONDS}s  |  Amount: $${TRADE_AMOUNT}\n`;
  out += `${HEADER}\n\n`;

  for (const r of rows) {
    out += `--- ${r.name} ---\n`;

    if (!r.market) {
      out += `  Market:     (no market)\n\n`;
      continue;
    }

    const upStr   = r.pUp   != null ? `$${r.pUp.toFixed(2)}`   : "—";
    const downStr = r.pDown != null ? `$${r.pDown.toFixed(2)}` : "—";

    out += `  Market:     ${r.market.slug || "—"}\n`;
    out += `  Polymarket: UP ${upStr} | DOWN ${downStr}\n`;
    out += `  Sniper:     ${r.sniperStatus}\n`;
    out += `  Stats:      ${r.wins}W / ${r.losses}L`;
    const total = r.wins + r.losses;
    if (total > 0) out += `  (${((r.wins / total) * 100).toFixed(0)}% WR)`;
    out += `\n\n`;
  }

  if (recentEvents.length) {
    out += `${DIVIDER}\n`;
    out += recentEvents.join("\n") + "\n";
  }

  process.stdout.write(out);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
  const trader       = new TradingEngine();
  await trader.init();
  const snipedSlugs  = new Set();
  const skippedSlugs = new Set();

  const assetState = {};
  for (const { name } of ASSETS) {
    assetState[name] = { stats: loadStats(name), lastSettleMs: 0 };
  }

  while (true) {
    const now  = Date.now();
    const rows = [];

    for (const { name, conf } of ASSETS) {
      const st  = assetState[name];
      const row = { name, market: null, pUp: null, pDown: null, sniperStatus: "—", wins: st.stats.wins, losses: st.stats.losses };

      // Settlement check every 30s
      if (now - st.lastSettleMs > 30_000) {
        st.lastSettleMs = now;
        const changed = await settleOpenTrades(name, st.stats);
        if (changed) { saveStats(name, st.stats); row.wins = st.stats.wins; row.losses = st.stats.losses; }
      }

      // Resolve market
      const market = await resolveMarket(conf);
      if (!market) { rows.push(row); continue; }
      row.market = market;

      const endMs      = new Date(market.endDate).getTime();
      const remainingMs = endMs - now;
      const remainingS  = remainingMs / 1000;

      // Fetch prices: WS → REST → Gamma (same chain as pompav3, cached 15s)
      const poly = await fetchPolyPrices(market, conf);
      row.pUp   = poly.pUp;
      row.pDown = poly.pDown;

      const { upTokenId, downTokenId } = poly;

      if (remainingS <= 0) {
        snipedSlugs.delete(market.slug);
        skippedSlugs.delete(market.slug);
        row.sniperStatus = "closed";
        rows.push(row); continue;
      }

      if (remainingS > WINDOW_SECONDS) {
        row.sniperStatus = `Waiting (${formatRem(remainingMs - WINDOW_SECONDS * 1000)} to window)`;
        rows.push(row); continue;
      }

      // In snipe window
      if (snipedSlugs.has(market.slug)) {
        row.sniperStatus = `⚡ SNIPED — waiting settlement (${formatRem(remainingMs)} left)`;
        rows.push(row); continue;
      }

      if (!upTokenId || !downTokenId) {
        row.sniperStatus = `In window (${formatRem(remainingMs)}) — no token IDs`;
        rows.push(row); continue;
      }

      let askUp   = poly.askUp;
      let askDown = poly.askDown;

      if (!askUp || !askDown) {
        row.sniperStatus = `In window (${formatRem(remainingMs)}) — no prices`;
        rows.push(row); continue;
      }

      // Update display prices from fresh fetch
      const side     = askUp >= askDown ? "UP" : "DOWN";
      const askPrice = side === "UP" ? askUp : askDown;
      const otherAsk = side === "UP" ? askDown : askUp;
      const tokenId  = side === "UP" ? upTokenId : downTokenId;

      // Out of price range — show once
      if (askPrice < MIN_PRICE || askPrice > MAX_PRICE) {
        row.sniperStatus = `Skip ${side}@${askPrice.toFixed(2)} — out of range (${formatRem(remainingMs)})`;
        if (!skippedSlugs.has(market.slug)) {
          skippedSlugs.add(market.slug);
          pushEvent(`[${name}] Skip ${side}@${askPrice.toFixed(2)} — out of [$${MIN_PRICE}-$${MAX_PRICE}]`);
        }
        rows.push(row); continue;
      }

      // Fire — mark sniped before async
      snipedSlugs.add(market.slug);
      const profitIfWin = parseFloat((1 - askPrice).toFixed(4));

      if (!CONFIG.trading.enabled) {
        const estShares = Math.floor(TRADE_AMOUNT / askPrice);
        row.sniperStatus = `⚡ SNIPED ${side}@${askPrice.toFixed(3)} — DRY RUN (${estShares} shares)`;
        pushEvent(`⚡ [${name}] DRY RUN ${side} @ $${askPrice.toFixed(3)} | ${estShares} shares | other: $${otherAsk.toFixed(3)}`);
        notifyTrade({ asset: name, side, price: askPrice, amount: TRADE_AMOUNT, shares: estShares, type: "DRY RUN" });
        st.stats.trades.push({ slug: market.slug, side, askPrice, amount: TRADE_AMOUNT, shares: estShares, profitIfWin: estShares * profitIfWin, type: "PRICE_SNIPE", settled: false, dryRun: true });
        saveStats(name, st.stats);
        rows.push(row); continue;
      }

      try {
        const result = await trader.executeTrade(tokenId, side, TRADE_AMOUNT, false, askPrice);
        const shares = result.fillShares || Math.floor(TRADE_AMOUNT / askPrice);
        const trade  = { slug: market.slug, side, askPrice, amount: TRADE_AMOUNT, shares, profitIfWin: parseFloat((shares * profitIfWin).toFixed(4)), tokenId, settled: false, type: "PRICE_SNIPE" };
        st.stats.trades.push(trade);
        saveStats(name, st.stats);
        if (result.success) {
          row.sniperStatus = `⚡ SNIPED ${side}@${askPrice.toFixed(3)} — LIVE (${shares} shares)`;
          pushEvent(`⚡ [${name}] LIVE ${side} @ $${askPrice.toFixed(3)} | ${shares} shares | profit if win: $${trade.profitIfWin.toFixed(2)}`);
          notifyTrade({ asset: name, side, price: askPrice, amount: TRADE_AMOUNT, shares, type: "LIVE" });
        } else {
          row.sniperStatus = `Failed: ${result.error}`;
          pushEvent(`❌ [${name}] Order failed: ${result.error}`);
        }
      } catch (e) {
        row.sniperStatus = `Error: ${e.message}`;
        pushEvent(`❌ [${name}] Error: ${e.message}`);
      }

      rows.push(row);
    }

    renderDashboard(rows, now);
    await sleep(POLL_MS);
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
