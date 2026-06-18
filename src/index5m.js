/**
 * pompav5 — 5m Oracle Sniper
 *
 * Strateji:
 *  1. Her 5m market açıldığında Binance'den açılış fiyatını al (strike)
 *  2. T-90s'de mevcut Binance fiyatını strike ile karşılaştır
 *  3. |fark| / strike >= MIN_CONFIDENCE ise kazanan tarafı al
 *  4. Kazanan taraf: mevcut > strike → UP, mevcut < strike → DOWN
 *
 * Backtest sonuçları:
 *  - ≥0.10% confidence: %95-99 WR, EV@$0.85 = +0.09
 *  - DOGE avgAsk = $0.51 → EV = +0.42 per share
 */

import * as dotenv from "dotenv";
dotenv.config();

import { CONFIG } from "./config.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import {
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  fetchOrderBook,
  summarizeOrderBook,
  fetchResolvedMarket,
} from "./data/polymarket.js";
import { polyOrderbookWs } from "./data/polymarketOrderbookWs.js";
import { startBinanceTradeStream } from "./data/binanceWs.js";
import { TradingEngine } from "./engines/trading.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { sleep } from "./utils.js";
import { initTelegram, notifyTrade, notifyResult, notifyObserve } from "./services/telegram.js";
import { StalenessRecorder } from "../latencyEdgeLab.js";
import fs from "fs";
import path from "path";

// ─── Tek instance kilidi ──────────────────────────────────────────────────────
{
  const LOCK = "./logs/index5m.lock";
  if (!fs.existsSync("./logs")) fs.mkdirSync("./logs", { recursive: true });

  function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  if (existsSync(LOCK)) {
    const pid = parseInt(readFileSync(LOCK, "utf8").trim(), 10);
    if (!isNaN(pid) && pidAlive(pid)) {
      console.error(`\n[index5m] Zaten çalışıyor (PID: ${pid}). İki instance çalıştırma!\nDurdurmak için terminali kapat veya '${LOCK}' dosyasını sil.\n`);
      process.exit(1);
    }
    unlinkSync(LOCK); // eski/stale lock
  }

  writeFileSync(LOCK, String(process.pid));
  const cleanup = () => { try { unlinkSync(LOCK); } catch {} };
  process.on("exit", cleanup);
  process.on("SIGINT",  () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

applyGlobalProxyFromEnv();
initTelegram();

// ─── Config ───────────────────────────────────────────────────────────────────

const WINDOW_SECONDS  = parseInt(process.env.SNIPE_5M_WINDOW_SECONDS  || "90");
const TRADE_AMOUNT    = parseFloat(process.env.SNIPE_5M_AMOUNT_USDC   || "10");
const MIN_CONFIDENCE  = parseFloat(process.env.SNIPE_5M_MIN_CONFIDENCE || "0.001"); // 0.10%
const MAX_CONFIDENCE  = parseFloat(process.env.SNIPE_5M_MAX_CONFIDENCE || "1.0");   // default: sınırsız
const MIN_PRICE       = parseFloat(process.env.SNIPE_5M_MIN_PRICE     || "0.10");
const MAX_PRICE       = parseFloat(process.env.SNIPE_5M_MAX_PRICE     || "0.95");
const POLL_MS              = 1000;
const STOP_LOSS_PCT        = parseFloat(process.env.SNIPE_5M_STOP_LOSS_PCT   || process.env.STOP_LOSS_PCT   || "35") / 100;
const SIGNAL_REVERSE_PCT   = parseFloat(process.env.SNIPE_5M_SIGNAL_REVERSE_PCT || "0"); // 0 = kapalı
const OBSERVE_SECONDS      = parseInt(process.env.SNIPE_5M_OBSERVE_SECONDS || "150");    // T-150s gözlem
const POS_CHECK_MS         = 5_000; // 5 saniyede bir pozisyon kontrol et
const BINANCE_BASE    = "https://api.binance.com";

// 5m asset'leri: config'de polymarket5m alanı olan aktif assetler
const ASSETS = Object.entries(CONFIG.assets)
  .filter(([name]) => CONFIG.activeAssets.includes(name))
  .filter(([, conf]) => conf.polymarket5m)
  .map(([name, conf]) => ({ name, conf }));

if (!ASSETS.length) {
  console.error("Aktif 5m asset bulunamadı. ACTIVE_ASSETS env değişkenini kontrol et.");
  process.exit(1);
}

// ─── Binance WS — her asset için canlı fiyat ─────────────────────────────────

const binancePrices = {};
const binanceStreams = {};
// Rolling 15dk log-return std → vol-normalized z-score için
const _priceHistory = {}; // name → [{price, ts}] (son 15dk)
const ROLLING_VOL_WINDOW_MS = 15 * 60_000;
function getRollingVol(name) {
  const hist = _priceHistory[name];
  if (!hist || hist.length < 5) return null;
  const cutoff = Date.now() - ROLLING_VOL_WINDOW_MS;
  const recent = hist.filter(h => h.ts >= cutoff);
  if (recent.length < 5) return null;
  const returns = [];
  for (let i = 1; i < recent.length; i++)
    returns.push(Math.log(recent[i].price / recent[i-1].price));
  const mean = returns.reduce((a,b)=>a+b,0)/returns.length;
  const variance = returns.reduce((a,r)=>a+(r-mean)**2,0)/returns.length;
  return Math.sqrt(variance) || null;
}

// ─── Latency Edge Lab — pasif ölçüm (trade etmez, CSV'ye yazar) ──────────────
const _tokenMeta = {}; // tokenId → { name, dir: 'UP'|'DOWN' }
const _bookState = {}; // name → { askUp, askDown, bidUp, bidDown }
const _pmPollLastT = {}; // staleness REST poll throttle: asset → lastMs
for (const { name: n } of ASSETS) _bookState[n] = {};

const _stalenessPath = path.join("./logs", `staleness_${new Date().toISOString().slice(0,10)}.csv`);
const _rec = new StalenessRecorder(_stalenessPath, ASSETS.map(a => a.name), { tickMs: 500, recordOnlyLastSecs: 120 });
_rec.start();

for (const { name, conf } of ASSETS) {
  const symbol = conf.symbol;
  binancePrices[name] = { price: null, ts: null };

  binanceStreams[name] = startBinanceTradeStream({
    symbol,
    onUpdate: ({ price, ts }) => {
      binancePrices[name] = { price, ts };
      _rec.onBinanceTrade(name, price, ts);
      if (!_priceHistory[name]) _priceHistory[name] = [];
      _priceHistory[name].push({ price, ts });
      // Pencereyi 20dk'da tut (bellek)
      const cutoff = ts - 20 * 60_000;
      while (_priceHistory[name].length && _priceHistory[name][0].ts < cutoff)
        _priceHistory[name].shift();
    },
  });
}

// Polymarket orderbook WS hook — her book güncellemesinde çağrılır
polyOrderbookWs.onBookUpdate = (tokenId, { bestAsk, bestBid }) => {
  const meta = _tokenMeta[tokenId];
  if (!meta) return;
  const { name, dir } = meta;
  if (dir === 'UP')   { _bookState[name].askUp = bestAsk; _bookState[name].bidUp = bestBid; }
  else                { _bookState[name].askDown = bestAsk; _bookState[name].bidDown = bestBid; }
  _rec.onPmBook(name, {
    askUp:   _bookState[name].askUp,   askDown: _bookState[name].askDown,
    bidUp:   _bookState[name].bidUp,   bidDown: _bookState[name].bidDown,
  });
};

function getBinancePrice(name) {
  const { price, ts } = binancePrices[name] || {};
  if (!price || !ts) return null;
  // 30 saniyeden eski fiyatı kabul etme
  if (Date.now() - ts > 30_000) return null;
  return price;
}

// ─── Market açılış fiyatı (strike) ───────────────────────────────────────────

// Her market için opening price cache: slug → { price, fetchedAt }
const openingPriceCache = {};

async function fetchBinanceKlineClose(symbol, marketEndMs) {
  if (marketEndMs % 60_000 !== 0) log(`⚠️ kline hizalama: marketEndMs dakika sınırında değil (${marketEndMs})`);
  try {
    // 1. Market bitiş anında AÇILAN mumu al → open fiyatı = T anındaki fiyat
    //    (Chainlink oracle da bu anı kullanır)
    const url1 = `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=1&startTime=${marketEndMs}&endTime=${marketEndMs + 59_999}`;
    const res1 = await fetch(url1);
    if (res1.ok) {
      const data1 = await res1.json();
      if (Array.isArray(data1) && data1.length) {
        return parseFloat(data1[0][1]); // open = T anındaki ilk işlem fiyatı
      }
    }
    // 2. Fallback: T'den önce kapanan son mumun close'u
    const url2 = `${BINANCE_BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=1&endTime=${marketEndMs}`;
    const res2 = await fetch(url2);
    if (!res2.ok) return null;
    const data2 = await res2.json();
    if (!Array.isArray(data2) || !data2.length) return null;
    return parseFloat(data2[0][4]); // close
  } catch { return null; }
}

async function getOpeningPrice(name, conf, market) {
  const slug = market.slug;
  if (openingPriceCache[slug]?.price) return openingPriceCache[slug].price;

  // startDate = event oluşturma tarihi (güvenilmez), eventStartTime de tutarsız.
  // 5m market olduğu için: startMs = endDate - 300s — her zaman doğru.
  const endMs   = market.endDate ? new Date(market.endDate).getTime() : null;
  const startMs = endMs ? endMs - 5 * 60_000 : null;

  if (!startMs) return null;

  // 1. Market yeni açıldıysa (son 3 dakikada) — mevcut Binance fiyatını strike say
  if (Date.now() - startMs < 3 * 60_000) {
    const current = getBinancePrice(name);
    if (current) {
      openingPriceCache[slug] = { price: current, fetchedAt: Date.now(), strikeSource: 'live', strikeDelay: Date.now() - startMs };
      return current;
    }
  }

  // 2. Eski market — Binance REST'ten açılış klinesi çek
  const historical = await fetchBinanceKlineClose(conf.symbol, startMs);
  if (historical) {
    openingPriceCache[slug] = { price: historical, fetchedAt: Date.now(), strikeSource: 'kline', strikeDelay: null };
    return historical;
  }

  return null;
}

// ─── Market resolution ────────────────────────────────────────────────────────

const marketCache5m = {};

async function fetchEventsBySlug(slug) {
  try {
    const url = `${CONFIG.gammaBaseUrl}/events?slug=${encodeURIComponent(slug)}&enableOrderBook=true`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// Markets ending within this window are "current" — excludes far-future pre-created rounds
function pickCurrentLiveMarket(markets, nowMs) {
  const MAX_FUTURE_MS = 10 * 60 * 1000;
  return markets
    .filter(m => {
      const end = new Date(m.endDate).getTime();
      return end > nowMs && end <= nowMs + MAX_FUTURE_MS;
    })
    .sort((a, b) => new Date(a.endDate) - new Date(b.endDate))[0] ?? null;
}

async function resolveMarket5m(assetConf) {
  const { polymarket5m } = assetConf;
  const { seriesId, eventSlugPrefix } = polymarket5m;
  const now    = Date.now();
  const nowSec = Math.floor(now / 1000);

  if (!marketCache5m[seriesId]) marketCache5m[seriesId] = { market: null, fetchedAtMs: 0 };
  const cache = marketCache5m[seriesId];

  if (cache.market) {
    const endMs     = cache.market.endDate ? new Date(cache.market.endDate).getTime() : null;
    const expired   = !Number.isFinite(endMs) || now >= endMs;
    // 120s öncesinden yeni slug'ı bul — window öncesinde geçiş garantilenir
    const nearClose = Number.isFinite(endMs) && now >= endMs - 120_000;

    if (!expired && !nearClose) {
      cache.fetchedAtMs = now;
      return cache.market;
    }
  }

  const setAndReturn = (m) => { cache.market = m; cache.fetchedAtMs = now; return m; };

  try {
    if (eventSlugPrefix) {
      // base = ceil(now/300)*300 = başlangıç zamanı olan bir sonraki 5dk sınırı
      // base-300 = hâlâ çalışan mevcut round
      // base     = henüz başlamamış gelecek round
      // base+300 = ondan sonraki round
      const base = Math.ceil(nowSec / 300) * 300;
      for (const slug of [base - 300, base, base + 300]) {
        if (slug <= 0) continue;
        const events  = await fetchEventsBySlug(`${eventSlugPrefix}-${slug}`);
        if (!events.length) continue;
        const markets = flattenEventMarkets(events);
        const live    = pickCurrentLiveMarket(markets, now);
        if (live) return setAndReturn(live);
      }
    }

    // Fallback: series_id (DOGE/BNB gibi yeni seriler için çalışır)
    const events  = await fetchLiveEventsBySeriesId({ seriesId, limit: 5 });
    const markets = flattenEventMarkets(events);
    const live    = pickCurrentLiveMarket(markets, now);
    if (live) return setAndReturn(live);
  } catch { /* keep cache */ }

  return cache.market;
}

// ─── Token IDs ────────────────────────────────────────────────────────────────

function extractTokenIds5m(market, assetConf) {
  const { polymarket5m } = assetConf;
  const upLabel   = polymarket5m.upLabel   || "Up";
  const downLabel = polymarket5m.downLabel || "Down";

  const outcomes = Array.isArray(market.outcomes)
    ? market.outcomes : JSON.parse(market.outcomes || "[]");
  const tokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds : JSON.parse(market.clobTokenIds || "[]");

  let upTokenId = null, downTokenId = null;
  for (let i = 0; i < outcomes.length; i++) {
    const label = String(outcomes[i] || "").toLowerCase();
    if (label === upLabel.toLowerCase())   upTokenId   = String(tokenIds[i] || "");
    if (label === downLabel.toLowerCase()) downTokenId = String(tokenIds[i] || "");
  }
  return { upTokenId, downTokenId };
}

// ─── Orderbook fiyat çekme ────────────────────────────────────────────────────

const _priceCache5m = {};

async function fetchAskPrices(market, assetConf) {
  const slug = market.slug;
  const cached = _priceCache5m[slug];
  if (cached && Date.now() - cached.t < 10_000) return cached;

  const { upTokenId, downTokenId } = extractTokenIds5m(market, assetConf);
  if (!upTokenId || !downTokenId) return null;

  polyOrderbookWs.subscribe([upTokenId, downTokenId]);
  const upWs   = polyOrderbookWs.getBestPrices(upTokenId);
  const downWs = polyOrderbookWs.getBestPrices(downTokenId);

  let askUp   = upWs?.bestAsk   ?? null;
  let askDown = downWs?.bestAsk ?? null;

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

  const result = { askUp, askDown, upTokenId, downTokenId, t: Date.now() };
  _priceCache5m[slug] = result;
  return result;
}

// Staleness lab için cache bypass — sadece REST, cache güncellemez, levels dahil
async function fetchAskPricesNoCache(market, assetConf) {
  const { upTokenId, downTokenId } = extractTokenIds5m(market, assetConf);
  if (!upTokenId || !downTokenId) return null;
  try {
    const [upBook, downBook] = await Promise.all([
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId }),
    ]);
    const askUp   = upBook   ? summarizeOrderBook(upBook).bestAsk   : null;
    const askDown = downBook ? summarizeOrderBook(downBook).bestAsk : null;
    const extractLevels = (book) => {
      if (!book?.asks?.length) return null;
      return book.asks
        .map(l => [parseFloat(l.price), parseFloat(l.size)])
        .filter(([p, s]) => isFinite(p) && isFinite(s) && s > 0)
        .sort((a, b) => a[0] - b[0])
        .slice(0, 5);
    };
    return { askUp, askDown, upTokenId, downTokenId,
      askUpLevels: extractLevels(upBook), askDownLevels: extractLevels(downBook) };
  } catch { return null; }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

const LOGS_DIR = "./logs";
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function loadStats(name) {
  try { return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, `stats5m_${name}.json`), "utf8")); }
  catch { return { wins: 0, losses: 0, trades: [] }; }
}
function saveStats(name, stats) {
  fs.writeFileSync(path.join(LOGS_DIR, `stats5m_${name}.json`), JSON.stringify(stats, null, 2));
}

function formatRem(ms) {
  const s = Math.round(ms / 1000);
  return s > 60 ? `${Math.floor(s/60)}m${s%60}s` : `${s}s`;
}

// ─── Settlement checker ───────────────────────────────────────────────────────

async function settleWithBinance(trade, conf) {
  if (!trade.strikePrice || !trade.marketEndMs) return null;
  const closePrice = await fetchBinanceKlineClose(conf.symbol, trade.marketEndMs);
  if (!closePrice) return null;
  // Strike'a %0.05'ten yakınsa belirsiz → Polymarket API'ye bırak (yanlış saymak yerine bekle)
  const margin = Math.abs(closePrice - trade.strikePrice) / trade.strikePrice;
  if (margin < 0.0005) return null;
  return closePrice > trade.strikePrice ? "UP" : "DOWN";
}

async function settleOpenTrades(name, assetConf, stats) {
  const unsettled = stats.trades.filter(t => !t.settled);
  if (!unsettled.length) return false;

  const now     = Date.now();
  let   changed = false;

  for (const trade of unsettled) {
    if (!trade.marketEndMs || now < trade.marketEndMs) continue; // round bitmedi

    let winner = null;

    // Method 1: Polymarket outcomePrices — tek gerçek kaynak (Chainlink oracle sonucu)
    // %95+ eşiği: 0.85 yeterliydi ama yanlış okumayı önlemek için daha katı
    try {
      const market = await fetchResolvedMarket(trade.slug);
      if (market) {
        const prices   = Array.isArray(market.outcomePrices)
          ? market.outcomePrices : JSON.parse(market.outcomePrices || "[]");
        const outcomes = Array.isArray(market.outcomes)
          ? market.outcomes : JSON.parse(market.outcomes || "[]");
        let maxP = 0, maxIdx = -1;
        for (let i = 0; i < prices.length; i++) {
          const p = parseFloat(prices[i] || "0");
          if (p > maxP) { maxP = p; maxIdx = i; }
        }
        if (maxP >= 0.95 && maxIdx >= 0) {
          const lbl = String(outcomes[maxIdx] || "").toLowerCase();
          if (["up", "yes", "higher"].includes(lbl)) winner = "UP";
          if (["down", "no", "lower"].includes(lbl)) winner = "DOWN";
        }
      }
    } catch { /* skip */ }

    // Method 2: Binance kline — sadece 10dk sonra ve strike'tan %0.1+ uzaksa (son çare)
    // Polymarket resolve etmediyse ve çok zaman geçtiyse kullan
    if (!winner && now >= trade.marketEndMs + 10 * 60_000) {
      const closePrice = await fetchBinanceKlineClose(assetConf.conf.symbol, trade.marketEndMs);
      if (closePrice && trade.strikePrice) {
        const margin = Math.abs(closePrice - trade.strikePrice) / trade.strikePrice;
        if (margin >= 0.001) { // %0.1 net fark — belirsiz değil
          winner = closePrice > trade.strikePrice ? "UP" : "DOWN";
          log(`⚠️ [5m/${name}] Binance fallback settlement kullanıldı (Polymarket 10dk'da resolve etmedi)`);
        }
      }
    }

    if (!winner) continue;

    trade.settled = true;
    trade.result  = trade.side === winner ? "WIN" : "LOSS";
    if (trade.result === "WIN") stats.wins++;
    else stats.losses++;

    // Kayıp anatomisi: T=0'daki Binance fiyatı vs. settlement yönü
    // distToStrikeAtEnd küçükse → fiyat reversal yaşamış, Chainlink/Binance ayrışma riski yüksek
    try {
      const closeAtEnd = await fetchBinanceKlineClose(assetConf.conf.symbol, trade.marketEndMs);
      if (closeAtEnd && trade.strikePrice) {
        const dist = (closeAtEnd - trade.strikePrice) / trade.strikePrice;
        trade.binanceCloseAtEnd   = parseFloat(closeAtEnd.toFixed(6));
        trade.distToStrikeAtEnd   = parseFloat(dist.toFixed(6));
        trade.binanceDirection    = dist >= 0 ? 'UP' : 'DOWN';
        trade.settlementDirection = winner;
        trade.diverged            = trade.binanceDirection !== winner;
      }
    } catch { /* pasif — settlement'ı engelleme */ }

    const pnl = trade.result === "WIN"
      ? parseFloat(((trade.shares || 0) * (1 - (trade.askPrice || 0))).toFixed(2))
      : -(trade.amount || 0);

    const icon = trade.result === "WIN" ? "✅" : "❌";
    const divTag = trade.diverged === true ? ' ⚡DIV' : '';
    log(`${icon} [5m/${name}] ${trade.side} → ${trade.result} | P&L:${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | dist@end:${trade.distToStrikeAtEnd != null ? (trade.distToStrikeAtEnd * 100).toFixed(3) + '%' : '?'}${divTag}`);
    notifyResult({ asset: `5m/${name}`, side: trade.side, result: trade.result, pnl, type: trade.dryRun ? "DRY" : "LIVE", distAtEnd: trade.distToStrikeAtEnd, diverged: trade.diverged });
    changed = true;
  }
  return changed;
}

// ─── Position Monitor: Stop-Loss / Take-Profit ───────────────────────────────

async function checkPositionExits(trader, name, stats) {
  const now = Date.now();
  const active = stats.trades.filter(t =>
    !t.settled &&
    !t.dryRun &&
    t.tokenId &&
    t.marketEndMs &&
    now < t.marketEndMs
  );
  if (!active.length) return false;

  let changed = false;

  for (const trade of active) {
    let exitReason = null;
    let currentBid = null;

    // 1. Oracle signal reversal (SIGNAL_REVERSE_PCT=0 ise devre dışı)
    if (SIGNAL_REVERSE_PCT > 0) {
      const currentBinance = getBinancePrice(name);
      if (currentBinance && trade.strikePrice) {
        const delta      = currentBinance - trade.strikePrice;
        const conf       = Math.abs(delta) / trade.strikePrice;
        const currentDir = delta > 0 ? "UP" : "DOWN";
        if (currentDir !== trade.side && conf >= SIGNAL_REVERSE_PCT) {
          exitReason = "SR";
        }
      }
    }

    // 2. Token bid stop-loss (STOP_LOSS_PCT=0 ise devre dışı)
    if (!exitReason && STOP_LOSS_PCT > 0) {
      currentBid = polyOrderbookWs.getBestPrices(trade.tokenId)?.bestBid ?? null;
      if (!currentBid) {
        try {
          const book = await fetchOrderBook({ tokenId: trade.tokenId });
          currentBid = summarizeOrderBook(book).bestBid;
        } catch { /* skip */ }
      }
      if (currentBid && currentBid > 0 && currentBid <= trade.askPrice * (1 - STOP_LOSS_PCT)) {
        exitReason = "SL";
      }
    }

    if (!exitReason) continue;

    // Satış yap
    const sellResult = await trader.sellPosition(trade.tokenId, trade.shares);

    // Satış başarısız oldu — trade'i kapatma, bir sonraki kontrolde tekrar dene
    if (!sellResult.success && !sellResult.dryRun) {
      log(`⚠️ [5m/${name}] ${exitReason} sell FAILED: ${sellResult.error} — retrying`);
      continue;
    }

    // Bid'i henüz çekmedik (SR ile çıkıldıysa) — sellPrice için al
    if (!currentBid) currentBid = polyOrderbookWs.getBestPrices(trade.tokenId)?.bestBid ?? trade.askPrice * (1 - STOP_LOSS_PCT);

    const sellPrice = (sellResult.success && !sellResult.dryRun) ? sellResult.sellPrice : currentBid;
    const pnl       = parseFloat(((sellPrice - trade.askPrice) * trade.shares).toFixed(2));

    trade.settled     = true;
    trade.exitedEarly = true;
    trade.exitReason  = exitReason;
    trade.exitPrice   = sellPrice;
    trade.result      = exitReason;
    stats.losses++;

    log(`🛡️ [5m/${name}] ${exitReason} @$${sellPrice?.toFixed(3)} | P&L:${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | entry:$${trade.askPrice.toFixed(3)}`);
    notifyResult({ asset: `5m/${name}`, side: trade.side, result: exitReason, pnl, type: "LIVE" });
    changed = true;
  }

  return changed;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

const DIVIDER = "─".repeat(72);
const HEADER  = "═".repeat(72);
const recentEvents = [];

// Günlük log dosyası: logs/index5m_YYYY-MM-DD.log
function getLogFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `index5m_${date}.log`);
}

function log(msg) {
  const ts  = new Date().toLocaleTimeString();
  const iso = new Date().toISOString();
  const line = `  [${ts}] ${msg}`;
  recentEvents.push(line);
  if (recentEvents.length > 14) recentEvents.shift();
  // Dosyaya da yaz (ANSI renk kodları olmadan)
  try {
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, "");
    fs.appendFileSync(getLogFile(), `[${iso}] ${clean}\n`);
  } catch { /* disk hatası bot'u durdurmasın */ }
}

function renderDashboard(rows, now) {
  const mode = CONFIG.trading.enabled ? "LIVE" : "DRY RUN";
  const time = new Date(now).toLocaleTimeString();

  let out = "\x1b[H\x1b[2J";
  out += `${HEADER}\n`;
  out += `  pompav5 — 5m Oracle Sniper | ${time} | ${mode}\n`;
  out += `  Window: T-${WINDOW_SECONDS}s | Amount: $${TRADE_AMOUNT} | MinConf: ${(MIN_CONFIDENCE*100).toFixed(2)}% | Price: $${MIN_PRICE}-$${MAX_PRICE}\n`;
  out += `${HEADER}\n\n`;

  for (const r of rows) {
    out += `--- ${r.name} (5m) ---\n`;
    if (!r.market) {
      out += `  Market:  (no market)\n\n`;
      continue;
    }
    const bPrice = r.binancePrice != null ? `$${r.binancePrice.toFixed(4)}` : "—";
    const strike = r.strikePrice  != null ? `$${r.strikePrice.toFixed(4)}`  : "—";
    const conf   = r.confidence   != null ? `${(r.confidence*100).toFixed(3)}%` : "—";

    out += `  Market:  ${r.market.slug || "—"}\n`;
    out += `  Binance: ${bPrice}  Strike: ${strike}  Conf: ${conf}  Dir: ${r.direction || "—"}\n`;
    out += `  Ask UP:  ${r.askUp  != null ? `$${r.askUp.toFixed(3)}`  : "—"}  ` +
           `Ask DOWN: ${r.askDown != null ? `$${r.askDown.toFixed(3)}` : "—"}\n`;
    out += `  Sniper:  ${r.status}\n`;
    out += `  Stats:   ${r.wins}W / ${r.losses}L`;
    const total = r.wins + r.losses;
    if (total > 0) out += `  (${((r.wins/total)*100).toFixed(0)}% WR)`;
    out += `\n\n`;
  }

  if (recentEvents.length) {
    out += `${DIVIDER}\n`;
    out += recentEvents.join("\n") + "\n";
  }

  process.stdout.write(out);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

// slug → { direction, confidence, binancePrice, strikePrice, recordedAt }
const preSignals = {};

async function main() {
  const trader      = new TradingEngine();
  await trader.init();

  const snipedSlugs      = new Set();
  const snipedRoundSlots = new Map(); // roundSlot → { name, confidence } — korelasyon koruması
  const assetState  = {};
  for (const { name } of ASSETS) {
    assetState[name] = { stats: loadStats(name), lastSettleMs: 0, lastExitCheckMs: 0 };
  }

  console.log(`5m Oracle Sniper başlatılıyor... Assetler: ${ASSETS.map(a => a.name).join(", ")}`);
  console.log(`Binance WS bağlanıyor, 3 saniye bekleniyor...`);
  await sleep(3000);

  while (true) {
    const now          = Date.now();
    const rows         = [];
    const pendingFires = new Map(); // roundSlot → candidate — bu tick'te ateşlenecek en iyi sinyal

    for (const { name, conf } of ASSETS) {
      const st  = assetState[name];
      const row = {
        name, market: null,
        binancePrice: null, strikePrice: null, confidence: null, direction: null,
        askUp: null, askDown: null,
        status: "—",
        wins: st.stats.wins, losses: st.stats.losses,
      };

      // Settlement
      if (now - st.lastSettleMs > 30_000) {
        st.lastSettleMs = now;
        const changed = await settleOpenTrades(name, { name, conf }, st.stats);
        if (changed) { saveStats(name, st.stats); row.wins = st.stats.wins; row.losses = st.stats.losses; }
      }

      // Stop-loss / take-profit: her 10 saniyede bir aktif pozisyonları kontrol et
      if (now - st.lastExitCheckMs > POS_CHECK_MS) {
        st.lastExitCheckMs = now;
        const exitChanged = await checkPositionExits(trader, name, st.stats);
        if (exitChanged) { saveStats(name, st.stats); row.wins = st.stats.wins; row.losses = st.stats.losses; }
      }

      // Market resolve
      const market = await resolveMarket5m(conf);
      if (!market) { rows.push(row); continue; }
      row.market = market;

      const endMs      = new Date(market.endDate).getTime();
      const remainingMs = endMs - now;
      const remainingS  = remainingMs / 1000;

      if (remainingS <= 0) {
        snipedSlugs.delete(market.slug);
        row.status = "closed";
        rows.push(row); continue;
      }

      // Binance live price
      const binancePrice = getBinancePrice(name);
      row.binancePrice = binancePrice;

      if (remainingS > WINDOW_SECONDS) {
        // T-150s gözlem penceresi: sinyal kaydet, trade yok
        if (remainingS <= OBSERVE_SECONDS && binancePrice && !preSignals[market.slug]) {
          const strikePre = await getOpeningPrice(name, conf, market);
          if (strikePre) {
            const deltaPre = binancePrice - strikePre;
            const confPre  = Math.abs(deltaPre) / strikePre;
            const dirPre   = deltaPre > 0 ? "UP" : "DOWN";
            preSignals[market.slug] = { direction: dirPre, confidence: confPre, binancePrice, strikePrice: strikePre, recordedAt: now };
            row.strikePrice = strikePre;
            row.confidence  = confPre;
            row.direction   = dirPre;
            row.status = `👁 T-150s obs: ${dirPre} ${(confPre*100).toFixed(3)}% | window in ${formatRem(remainingMs - WINDOW_SECONDS * 1000)}`;
            if (confPre >= MIN_CONFIDENCE) notifyObserve({ asset: `5m/${name}`, direction: dirPre, confidence: confPre, windowSec: Math.round((remainingMs - WINDOW_SECONDS * 1000) / 1000) });
          } else {
            row.status = `Waiting ${formatRem(remainingMs - WINDOW_SECONDS * 1000)} to window`;
          }
        } else if (preSignals[market.slug]) {
          const p = preSignals[market.slug];
          row.strikePrice = p.strikePrice;
          row.confidence  = p.confidence;
          row.direction   = p.direction;
          row.status = `👁 ${p.direction} ${(p.confidence*100).toFixed(3)}% kaydedildi | window in ${formatRem(remainingMs - WINDOW_SECONDS * 1000)}`;
        } else {
          row.status = `Waiting ${formatRem(remainingMs - WINDOW_SECONDS * 1000)} to window`;
        }
        rows.push(row); continue;
      }

      // In window — zaten snipe yaptık mı?
      if (snipedSlugs.has(market.slug)) {
        // Staleness lab: snipe sonrası PM fiyatını 5s'de bir REST'ten al
        const _nowMs = Date.now();
        if (remainingMs > 0 && remainingMs < 120_000 && _nowMs - (_pmPollLastT[name] || 0) >= 5_000) {
          _pmPollLastT[name] = _nowMs;
          fetchAskPricesNoCache(market, conf).then(p => {
            if (p && (p.askUp || p.askDown)) _rec.onPmBook(name, {
              askUp: p.askUp, askDown: p.askDown,
              askUpLevels: p.askUpLevels, askDownLevels: p.askDownLevels,
            });
          }).catch(() => {});
        }
        row.status = `⚡ SNIPED — waiting settlement (${formatRem(remainingMs)})`;
        rows.push(row); continue;
      }

      if (!binancePrice) {
        row.status = `In window — Binance fiyatı yok`;
        rows.push(row); continue;
      }

      // Strike fiyatını al
      const strikePrice = await getOpeningPrice(name, conf, market);
      row.strikePrice = strikePrice;

      if (!strikePrice) {
        row.status = `In window — Strike fiyatı yok`;
        rows.push(row); continue;
      }

      // Latency lab: round bilgisini kayıt et (her tick'te günceller, idempotent)
      _rec.setRound(name, market.slug, strikePrice, endMs / 1000);

      // Oracle signal
      const delta      = binancePrice - strikePrice;
      const confidence = Math.abs(delta) / strikePrice;
      const direction  = delta > 0 ? "UP" : "DOWN";
      row.confidence = confidence;
      row.direction  = direction;

      if (confidence < MIN_CONFIDENCE) {
        row.status = `Skip — conf ${(confidence*100).toFixed(3)}% < ${(MIN_CONFIDENCE*100).toFixed(2)}% (${formatRem(remainingMs)})`;
        rows.push(row); continue;
      }
      if (confidence > MAX_CONFIDENCE) {
        row.status = `Skip — conf ${(confidence*100).toFixed(3)}% > ${(MAX_CONFIDENCE*100).toFixed(2)}% (aşırı hareket)`;
        rows.push(row); continue;
      }

      // T-150s filtresi: T-150s ile T-89s aynı yönde ise momentum zaten fiyatlanmış →
      // piyasa genelde tersine döner (veri: %23.5 WR). Sadece reversal sinyallerinde gir.
      const pre150 = preSignals[market.slug];
      if (pre150 && pre150.direction === direction) {
        row.status = `Skip — T-150s(${pre150.direction})=T-89s(${direction}) → mean-reversion riski`;
        rows.push(row); continue;
      }

      // Latency lab: token → asset eşlemesini WS subscribe'dan ÖNCE set et
      const _earlyTokens = extractTokenIds5m(market, conf);
      if (_earlyTokens.upTokenId && !_tokenMeta[_earlyTokens.upTokenId]) {
        _tokenMeta[_earlyTokens.upTokenId]   = { name, dir: 'UP' };
        _tokenMeta[_earlyTokens.downTokenId] = { name, dir: 'DOWN' };
      }

      // Orderbook fiyatlarını al
      const prices = await fetchAskPrices(market, conf);
      if (!prices) {
        row.status = `In window — token ID bulunamadı`;
        rows.push(row); continue;
      }
      row.askUp   = prices.askUp;
      row.askDown = prices.askDown;

      // Latency lab: REST'ten gelen PM fiyatlarını da recorder'a besle
      if (prices.askUp || prices.askDown) {
        _rec.onPmBook(name, { askUp: prices.askUp, askDown: prices.askDown });
      }

      if (!prices.askUp || !prices.askDown) {
        const askDir = direction === "UP" ? prices.askUp : prices.askDown;
        const oppAsk = direction === "UP" ? prices.askDown : prices.askUp;
        if (!askDir && oppAsk) {
          row.status = `No ${direction} asks — piyasa karar verdi (${formatRem(remainingMs)})`;
        } else {
          row.status = `In window — ask yok (${formatRem(remainingMs)})`;
        }
        rows.push(row); continue;
      }

      const askPrice = direction === "UP" ? prices.askUp : prices.askDown;
      const tokenId  = direction === "UP" ? prices.upTokenId : prices.downTokenId;

      if (askPrice < MIN_PRICE || askPrice > MAX_PRICE) {
        row.status = `Skip ${direction}@${askPrice.toFixed(3)} — fiyat aralığı dışı`;
        rows.push(row); continue;
      }

      // Korelasyon koruması: aynı 5dk slot'unda tek pozisyon, en yüksek confidence kazanır
      const roundSlot   = Math.floor(endMs / (5 * 60_000));
      const profitIfWin = parseFloat((1 - askPrice).toFixed(4));
      const estShares   = Math.floor(TRADE_AMOUNT / askPrice);
      const confPct     = (confidence * 100).toFixed(3);

      if (snipedRoundSlots.has(roundSlot)) {
        snipedSlugs.add(market.slug);
        const winner = snipedRoundSlots.get(roundSlot);
        row.status = `Corr.skip — slot ${winner?.name ?? '?'} aldı`;
      } else {
        const cur = pendingFires.get(roundSlot);
        if (!cur || confidence > cur.confidence) {
          if (cur) {
            snipedSlugs.add(cur.market.slug);
            cur.row.status = `Corr.skip — ${name} daha yüksek conf (${confPct}%)`;
          }
          pendingFires.set(roundSlot, { name, direction, askPrice, tokenId, estShares, profitIfWin, confPct, market, endMs, st, row, binancePrice, strikePrice, confidence });
          row.status = `⏳ ${direction}@${askPrice.toFixed(3)} conf:${confPct}% — ateş bekliyor`;
        } else {
          snipedSlugs.add(market.slug);
          row.status = `Corr.skip — ${cur.name} daha yüksek conf (${(cur.confidence * 100).toFixed(3)}%)`;
        }
      }
      rows.push(row);
    }

    // Korelasyon koruması: en yüksek confidence'lı adayı ateşle (round başına tek pozisyon)
    for (const [roundSlot, c] of pendingFires) {
      const { name, direction, askPrice, tokenId, estShares, profitIfWin, confPct, market, endMs, st, row, binancePrice, strikePrice, confidence } = c;
      snipedRoundSlots.set(roundSlot, { name, confidence });
      snipedSlugs.add(market.slug);

      if (!CONFIG.trading.enabled) {
        row.status = `⚡ DRY ${direction}@${askPrice.toFixed(3)} | conf:${confPct}% | ~${estShares}sh`;
        log(`⚡ [5m/${name}] DRY ${direction}@$${askPrice.toFixed(3)} | conf:${confPct}% | ~${estShares}sh`);
        notifyTrade({ asset: `5m/${name}`, side: direction, price: askPrice, amount: TRADE_AMOUNT, shares: estShares, type: "DRY RUN" });
        const _volDry = getRollingVol(name);
        st.stats.trades.push({ slug: market.slug, side: direction, askPrice, amount: TRADE_AMOUNT, shares: estShares, profitIfWin: estShares * profitIfWin, confidence, strikePrice, binancePrice, marketEndMs: endMs, settled: false, dryRun: true, pre150s: preSignals[market.slug] ?? null, volZ: _volDry ? parseFloat((confidence/_volDry).toFixed(3)) : null, strikeSource: openingPriceCache[market.slug]?.strikeSource ?? null, strikeDelay: openingPriceCache[market.slug]?.strikeDelay ?? null });
        saveStats(name, st.stats);
        continue;
      }

      try {
        const result = await trader.executeTrade(tokenId, direction, TRADE_AMOUNT, false, askPrice);
        const shares = result.fillShares || estShares;
        const _vol = getRollingVol(name);
        const trade  = { slug: market.slug, side: direction, askPrice, amount: TRADE_AMOUNT, shares, profitIfWin: parseFloat((shares * profitIfWin).toFixed(4)), tokenId, confidence, strikePrice, binancePrice, marketEndMs: endMs, settled: false, pre150s: preSignals[market.slug] ?? null, volZ: _vol ? parseFloat((confidence/_vol).toFixed(3)) : null, strikeSource: openingPriceCache[market.slug]?.strikeSource ?? null, strikeDelay: openingPriceCache[market.slug]?.strikeDelay ?? null };
        if (result.success) {
          st.stats.trades.push(trade);
          saveStats(name, st.stats);
          row.status = `⚡ LIVE ${direction}@${askPrice.toFixed(3)} | conf:${confPct}% | ${shares}sh`;
          log(`⚡ [5m/${name}] LIVE ${direction}@$${askPrice.toFixed(3)} | conf:${confPct}% | profit if win: $${trade.profitIfWin.toFixed(2)}`);
          notifyTrade({ asset: `5m/${name}`, side: direction, price: askPrice, amount: TRADE_AMOUNT, shares, type: "LIVE" });
        } else {
          // Slug kilitli kalır — aynı round'a tekrar girme (emir PM'de dolmuş olabilir)
          // Sadece slot serbest bırakılır: başka bir asset bu round'u alabilsin
          snipedRoundSlots.delete(roundSlot);
          row.status = `Failed (slug kilitli): ${result.error}`;
          log(`❌ [5m/${name}] Order failed (slug kilitli, slot serbest): ${result.error}`);
        }
      } catch (e) {
        snipedRoundSlots.delete(roundSlot);
        row.status = `Error (slug kilitli): ${e.message}`;
        log(`❌ [5m/${name}] ${e.message} (slug kilitli, slot serbest)`);
      }
    }

    // Süresi dolmuş slot kayıtlarını temizle (>10dk geçmiş)
    for (const [slot] of snipedRoundSlots) {
      if (slot * 5 * 60_000 < now - 10 * 60_000) snipedRoundSlots.delete(slot);
    }

    renderDashboard(rows, now);
    await sleep(POLL_MS);
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
