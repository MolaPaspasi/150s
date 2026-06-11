/**
 * chainlinkDivLogger.js
 *
 * Pasif logger: Polymarket'ın Chainlink Data Streams yayınını ve
 * Binance spot'u aynı anda dinler; her round kapanışında ve her
 * Data Streams güncellemesinde ikisi arasındaki farkı kaydeder.
 *
 * Soru: "strike yakınında Chainlink ≠ Binance ne sıklıkla ve ne büyüklükte?"
 *
 * Çalıştırma: node chainlinkDivLogger.js
 * Çıktı: logs/chainlink_div_YYYY-MM-DD.ndjson  (append, JSON Lines)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { startPolymarketChainlinkPriceStream } from './src/data/polymarketLiveWs.js';
import { startBinanceTradeStream }              from './src/data/binanceWs.js';
import { CONFIG }                               from './src/config.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const ASSETS = Object.entries(CONFIG.assets)
  .filter(([name]) => CONFIG.activeAssets.includes(name))
  .filter(([, conf]) => conf.polymarket5m)
  .map(([name, conf]) => ({ name, conf }));

const BINANCE_TO_STREAM_SYMBOL = {
  BTCUSDT: 'btc', ETHUSDT: 'eth', SOLUSDT: 'sol',
  DOGEUSDT: 'doge', XRPUSDT: 'xrp', BNBUSDT: 'bnb',
};

// ─── State ───────────────────────────────────────────────────────────────────

const state = {};  // name → { binancePrice, binanceTs, clPrice, clTs, roundEndMs, strike }

for (const { name } of ASSETS) {
  state[name] = { binancePrice: null, binanceTs: null, clPrice: null, clTs: null, roundEndMs: null, strike: null };
}

// ─── Output ──────────────────────────────────────────────────────────────────

const LOG_DIR  = './logs';
const LOG_PATH = path.join(LOG_DIR, `chainlink_div_${new Date().toISOString().slice(0,10)}.ndjson`);
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const fd = fs.openSync(LOG_PATH, 'a');

function emit(record) {
  fs.writeSync(fd, JSON.stringify(record) + '\n');
}

function snapshot(name, trigger) {
  const s = state[name];
  if (!s.binancePrice || !s.clPrice || !s.strike) return;

  const now = Date.now();
  const binanceDiff  = (s.binancePrice - s.strike) / s.strike;
  const clDiff       = (s.clPrice      - s.strike) / s.strike;
  const spread       = s.binancePrice - s.clPrice;
  const spreadPct    = spread / s.strike;
  const binanceDir   = binanceDiff >= 0 ? 'UP' : 'DOWN';
  const clDir        = clDiff      >= 0 ? 'UP' : 'DOWN';
  const diverge      = binanceDir !== clDir;
  const secsToClose  = s.roundEndMs ? (s.roundEndMs - now) / 1000 : null;

  emit({
    ts:           now,
    iso:          new Date(now).toISOString(),
    trigger,
    asset:        name,
    strike:       s.strike,
    binancePrice: s.binancePrice,
    clPrice:      s.clPrice,
    binanceDiff:  +binanceDiff.toFixed(6),
    clDiff:       +clDiff.toFixed(6),
    spreadPct:    +spreadPct.toFixed(6),
    binanceDir,
    clDir,
    diverge,
    secsToClose:  secsToClose !== null ? +secsToClose.toFixed(1) : null,
    binanceTs:    s.binanceTs,
    clTs:         s.clTs,
  });

  if (diverge) {
    const msg = `[DIVERGE] ${name} | strike=${s.strike} | binance=${s.binancePrice.toFixed(4)}(${binanceDir}) | CL=${s.clPrice.toFixed(4)}(${clDir}) | spread=${(spreadPct*100).toFixed(4)}% | T-${secsToClose?.toFixed(0)}s`;
    console.log(msg);
  }
}

// ─── Round state: açık round listesini Polymarket REST'ten çek ───────────────

async function refreshRounds() {
  for (const { name, conf } of ASSETS) {
    try {
      const url = `https://gamma-api.polymarket.com/events?seriesSlug=${conf.polymarket5m.seriesSlug}&active=true&limit=5`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const events = await r.json();
      if (!Array.isArray(events) || !events.length) continue;

      // En yakın kapanacak event
      const now = Date.now();
      let best = null;
      for (const ev of events) {
        const endMs = ev.endDate ? new Date(ev.endDate).getTime() : null;
        if (!endMs || endMs < now) continue;
        if (!best || endMs < best.endMs) best = { endMs, ev };
      }
      if (!best) continue;

      const ev = best.ev;
      // Strike: her market'in açılış fiyatı = round başındaki CL fiyatı → direkt description'dan parse et
      // Ya da zaten açık round'da strikePrice = ilk market'in openingPrice var mı?
      // Basit: şu anki CL fiyatını "strike yaklaşımı" olarak kullan → gerçek strike index5m'den geliyor
      // Sadece round bitiş zamanını ayarla
      state[name].roundEndMs = best.endMs;
    } catch {}
  }
}

// ─── Binance stream ──────────────────────────────────────────────────────────

for (const { name, conf } of ASSETS) {
  startBinanceTradeStream({
    symbol: conf.symbol,
    onUpdate: ({ price, ts }) => {
      state[name].binancePrice = price;
      state[name].binanceTs    = ts;
      snapshot(name, 'binance');
    },
  });
}

// ─── Polymarket Chainlink Data Streams yayını ─────────────────────────────────

startPolymarketChainlinkPriceStream({
  onUpdate: ({ symbol: rawSym, price, updatedAt }) => {
    const sym = (rawSym || '').toLowerCase();
    // symbol eşlemesi: "ETH/USD" → eth, "eth-usd" → eth, "eth" → eth
    const assetName = ASSETS.find(({ conf }) => {
      const s = BINANCE_TO_STREAM_SYMBOL[conf.symbol];
      return s && sym.includes(s);
    })?.name;
    if (!assetName) return;

    state[assetName].clPrice = price;
    state[assetName].clTs    = updatedAt || Date.now();
    snapshot(assetName, 'chainlink');

    // Round kapanışına <10s kaldığında özel kayıt
    const s = state[assetName];
    if (s.roundEndMs) {
      const secsLeft = (s.roundEndMs - Date.now()) / 1000;
      if (secsLeft >= 0 && secsLeft <= 10) {
        emit({
          ts:        Date.now(),
          iso:       new Date().toISOString(),
          trigger:   'ROUND_CLOSE_WINDOW',
          asset:     assetName,
          secsLeft:  +secsLeft.toFixed(2),
          clPrice:   price,
          binancePrice: s.binancePrice,
          strike:    s.strike,
          diverge:   s.binancePrice && s.strike
                       ? ((price >= s.strike ? 'UP' : 'DOWN') !== (s.binancePrice >= s.strike ? 'UP' : 'DOWN'))
                       : null,
        });
      }
    }
  },
});

// ─── Strike bilgisini index5m'den al (shared log okuyarak) ───────────────────
// index5m çalışıyorsa aktif trade'lerin strikePrice'ını log'dan okuyabiliriz.
// Alternatif: REST poll ile aktif market'in strikePrice'ını çek (her 60s).

async function pollStrikes() {
  for (const { name, conf } of ASSETS) {
    try {
      const url = `https://gamma-api.polymarket.com/events?seriesSlug=${conf.polymarket5m.seriesSlug}&active=true&limit=3`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const events = await r.json();
      if (!Array.isArray(events) || !events.length) continue;

      const now = Date.now();
      for (const ev of events) {
        const endMs = ev.endDate ? new Date(ev.endDate).getTime() : null;
        if (!endMs || endMs < now || endMs > now + 6 * 60_000) continue;
        // strike = bu round'un Chainlink fiyatı başlangıcı → description'dan parse
        // Format: "price at the beginning of that range"
        // Bunu direkt öğrenmek için: mevcut CL fiyatını strike proxy olarak kullan
        // (daha iyisi: index5m'deki openingPriceCache ile entegre et)
        // Şimdilik: güncelleme yoksa CL fiyatını initial strike yap
        if (!state[name].strike && state[name].clPrice) {
          state[name].strike = state[name].clPrice;
          console.log(`[${name}] Strike proxy: ${state[name].strike} (CL current)`);
        }
        state[name].roundEndMs = endMs;
        break;
      }
    } catch {}
  }
}

// ─── Periyodik görevler ───────────────────────────────────────────────────────

// Her 60s: round durumunu yenile
setInterval(async () => { await refreshRounds(); await pollStrikes(); }, 60_000);

// Her 10s: snapshot kaydet (heartbeat)
setInterval(() => {
  for (const { name } of ASSETS) snapshot(name, 'heartbeat');
}, 10_000);

// Başlangıçta
await refreshRounds();
await pollStrikes();

console.log(`Chainlink Divergence Logger başladı`);
console.log(`Aktif asset'ler: ${ASSETS.map(a=>a.name).join(', ')}`);
console.log(`Log: ${LOG_PATH}`);
console.log(`Polymarket WS: ${CONFIG.polymarket.liveDataWsUrl}`);
console.log(`(Ctrl+C ile durdur)\n`);

process.on('SIGINT', () => {
  fs.closeSync(fd);
  console.log('\nLogger durduruldu.');
  process.exit(0);
});
