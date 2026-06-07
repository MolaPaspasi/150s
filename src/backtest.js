/**
 * backtest.js — 5m Oracle Sniper geriye dönük test
 *
 * Binance 1m kline kullanarak her 5dk round'u simüle eder:
 *   Strike     = round başı fiyatı (T=0)
 *   Sinyal     = T+210s fiyatı (T-90s penceresi)
 *   Settlement = T+300s fiyatı (round sonu)
 *
 * Kullanım:
 *   node src/backtest.js            → son 30 gün, tüm assetler
 *   node src/backtest.js 60         → son 60 gün
 *   node src/backtest.js 30 BTC ETH → sadece BTC ve ETH
 */

const DAYS     = parseInt(process.argv[2]) || 30;
const ASSETS_ARG = process.argv.slice(3);

const ASSETS = {
  BTC:  "BTCUSDT",
  ETH:  "ETHUSDT",
  SOL:  "SOLUSDT",
  DOGE: "DOGEUSDT",
  XRP:  "XRPUSDT",
  BNB:  "BNBUSDT",
};

const ACTIVE = ASSETS_ARG.length
  ? Object.fromEntries(ASSETS_ARG.map(a => [a.toUpperCase(), ASSETS[a.toUpperCase()]]).filter(([,v]) => v))
  : ASSETS;

const BINANCE   = "https://api.binance.com";
const ROUND_SEC = 300;
const SIGNAL_OFFSET_SEC = 210; // T-90s = 3.5dk sonra
const AVG_ASK   = 0.51;        // Ortalama giriş fiyatı varsayımı
const TRADE_AMT = 5;           // $5 per trade

// ─── Binance kline çekici ─────────────────────────────────────────────────────

async function fetchKlines(symbol, startMs, endMs) {
  const results = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const url = `${BINANCE}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${cursor}&endTime=${Math.min(cursor + 1000 * 60_000, endMs)}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    results.push(...data);
    cursor = data[data.length - 1][0] + 60_000;
    await new Promise(r => setTimeout(r, 120)); // rate limit
  }

  return results; // [openTime, open, high, low, close, ...]
}

// Kline array'inden ms → fiyat map'i oluştur
function buildPriceMap(klines) {
  const map = new Map();
  for (const k of klines) {
    map.set(k[0], { open: parseFloat(k[1]), close: parseFloat(k[4]) });
  }
  return map;
}

// Belirli bir ms zamanına en yakın fiyatı bul (1m hassasiyetle)
function getPrice(map, ms) {
  const minuteMs = Math.floor(ms / 60_000) * 60_000;
  const candle = map.get(minuteMs);
  return candle ? candle.open : null;
}

// ─── Tek asset backtest ───────────────────────────────────────────────────────

async function backtestAsset(name, symbol, klines) {
  const map = buildPriceMap(klines);

  const nowSec   = Math.floor(Date.now() / 1000);
  const startSec = nowSec - DAYS * 86_400;
  // İlk tam round başlangıcı
  const firstRound = Math.ceil(startSec / ROUND_SEC) * ROUND_SEC;

  const trades = [];

  for (let t = firstRound; t + ROUND_SEC <= nowSec; t += ROUND_SEC) {
    const strikeMs  = t * 1000;
    const signalMs  = (t + SIGNAL_OFFSET_SEC) * 1000;
    const settleMs  = (t + ROUND_SEC) * 1000;

    const strike    = getPrice(map, strikeMs);
    const signalPx  = getPrice(map, signalMs);
    const settlePx  = getPrice(map, settleMs);

    if (!strike || !signalPx || !settlePx) continue;

    const delta      = signalPx - strike;
    const confidence = Math.abs(delta) / strike;
    const direction  = delta > 0 ? "UP" : "DOWN";
    const winner     = settlePx > strike ? "UP" : "DOWN";
    const win        = direction === winner;

    trades.push({ t, strike, signalPx, settlePx, confidence, direction, win });
  }

  return trades;
}

// ─── Analiz ───────────────────────────────────────────────────────────────────

function analyze(trades, label) {
  const thresholds = [0.001, 0.002, 0.003, 0.004, 0.005, 0.007, 0.010, 0.015, 0.020];

  const rows = [];
  for (const thresh of thresholds) {
    const sub  = trades.filter(t => t.confidence >= thresh);
    if (!sub.length) continue;
    const wins = sub.filter(t => t.win).length;
    const wr   = wins / sub.length;

    // EV hesabı: ask=$0.51 varsayımı
    // WIN → +$0.49 per share, LOSS → -$0.51 per share
    // Shares = floor(5 / 0.51) = 9
    const shares  = Math.floor(TRADE_AMT / AVG_ASK);
    const profitW = shares * (1 - AVG_ASK);
    const lossL   = TRADE_AMT;
    const ev      = wr * profitW - (1 - wr) * lossL;
    const totalPnl = ev * sub.length;

    rows.push({ thresh, count: sub.length, wins, wr, ev, totalPnl });
  }
  return rows;
}

function printTable(rows, label) {
  console.log(`\n── ${label} ──`);
  console.log("Conf    Trades   Wins    WR       EV/trade   PnL(sim)");
  console.log("─".repeat(58));
  for (const r of rows) {
    const confStr  = `≥${(r.thresh * 100).toFixed(1).padStart(4)}%`;
    const wrStr    = (r.wr * 100).toFixed(1).padStart(5) + "%";
    const evStr    = (r.ev >= 0 ? "+" : "") + r.ev.toFixed(3);
    const pnlStr   = (r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(0);
    const highlight = r.ev > 0 ? " ◄" : "";
    console.log(`${confStr}  ${String(r.count).padStart(6)}  ${String(r.wins).padStart(5)}  ${wrStr}  ${evStr.padStart(9)}  ${pnlStr.padStart(8)}${highlight}`);
  }
}

// UP vs DOWN ayrımı
function analyzeByDir(trades, thresh) {
  const sub = trades.filter(t => t.confidence >= thresh);
  const up   = sub.filter(t => t.direction === "UP");
  const down = sub.filter(t => t.direction === "DOWN");
  const upWr   = up.length   ? up.filter(t => t.win).length / up.length : 0;
  const downWr = down.length ? down.filter(t => t.win).length / down.length : 0;
  return { upCount: up.length, downCount: down.length, upWr, downWr };
}

// Saatlik WR
function analyzeByHour(trades, thresh) {
  const sub = trades.filter(t => t.confidence >= thresh);
  const hours = {};
  for (const t of sub) {
    const h = new Date(t.t * 1000).getUTCHours();
    if (!hours[h]) hours[h] = { w: 0, l: 0 };
    if (t.win) hours[h].w++; else hours[h].l++;
  }
  return hours;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const startMs = (Math.floor(Date.now() / 1000) - DAYS * 86_400) * 1000;
const endMs   = Date.now();

console.log(`\n${"═".repeat(60)}`);
console.log(`  pompav5 Backtest — Son ${DAYS} gün`);
console.log(`  Assetler: ${Object.keys(ACTIVE).join(", ")}`);
console.log(`  Dönem: ${new Date(startMs).toISOString().slice(0, 10)} → bugün`);
console.log(`  Varsayım: ask=$${AVG_ASK}, trade=$${TRADE_AMT}`);
console.log(`${"═".repeat(60)}\n`);

const allTrades = [];
const assetTrades = {};

for (const [name, symbol] of Object.entries(ACTIVE)) {
  process.stdout.write(`${name} kline indiriliyor (${DAYS * 24 * 60} mum)... `);
  try {
    const klines = await fetchKlines(symbol, startMs, endMs);
    process.stdout.write(`${klines.length} mum ✓\n`);

    const trades = await backtestAsset(name, symbol, klines);
    assetTrades[name] = trades;
    allTrades.push(...trades);

    const rows = analyze(trades, name);
    printTable(rows, `${name} — ${trades.length} round`);

    // Yön analizi
    const BEST_THRESH = 0.002;
    const dir = analyzeByDir(trades, BEST_THRESH);
    console.log(`  @ ≥${(BEST_THRESH*100).toFixed(1)}%: UP WR=${(dir.upWr*100).toFixed(1)}% (${dir.upCount}) | DOWN WR=${(dir.downWr*100).toFixed(1)}% (${dir.downCount})`);

  } catch (e) {
    console.log(`HATA: ${e.message}`);
  }
}

// Genel özet
if (Object.keys(ACTIVE).length > 1) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  TÜM ASSETLER — ${allTrades.length} toplam round`);
  console.log(`${"═".repeat(60)}`);
  printTable(analyze(allTrades, "ALL"), "Tüm assetler birleşik");

  // Saatlik analiz @ 0.002
  const THRESH = 0.002;
  console.log(`\n── Saatlik WR @ ≥${(THRESH*100).toFixed(1)}% (UTC) ──`);
  const hours = analyzeByHour(allTrades, THRESH);
  for (let h = 0; h < 24; h++) {
    const d = hours[h];
    if (!d) continue;
    const total = d.w + d.l;
    const wr = (d.w / total * 100).toFixed(1);
    const bar = "█".repeat(Math.round(d.w / total * 20));
    console.log(`  ${String(h).padStart(2)}:00  ${String(total).padStart(4)} round  WR:${wr.padStart(5)}%  ${bar}`);
  }

  // Asset karşılaştırma tablosu
  console.log(`\n── Asset Karşılaştırması @ ≥0.2% confidence ──`);
  console.log("Asset   Rounds   WR      EV/trade   PnL(sim)");
  console.log("─".repeat(50));
  for (const [name, trades] of Object.entries(assetTrades)) {
    const rows = analyze(trades, name);
    const r = rows.find(x => x.thresh === 0.002);
    if (!r) continue;
    const wr  = (r.wr * 100).toFixed(1).padStart(5) + "%";
    const ev  = ((r.ev >= 0 ? "+" : "") + r.ev.toFixed(3)).padStart(9);
    const pnl = ((r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(0)).padStart(8);
    console.log(`${name.padEnd(7)} ${String(r.count).padStart(6)}  ${wr}  ${ev}  ${pnl}`);
  }
}

console.log(`\n  Not: Gerçek ask fiyatları $${AVG_ASK} varsayımı üzerinden hesaplandı.`);
console.log(`  Orderbook durumu (piyasa karar verdi) simülasyona dahil değil.\n`);
