/**
 * sell.js — Polymarket pozisyon yönetimi
 *
 * Kullanım:
 *   node src/sell.js                        → tüm açık pozisyonları listele
 *   node src/sell.js <tokenId> <shares>     → belirli tokenı sat (tam miktar)
 *   node src/sell.js <tokenId> all          → pozisyonun tamamını sat
 *   node src/sell.js <tokenId> half         → pozisyonun yarısını sat
 */

import "dotenv/config";
import { TradingEngine } from "./engines/trading.js";

const CLOB_BASE = "https://clob.polymarket.com";
const DATA_API  = "https://data-api.polymarket.com";

// ─── Yardımcı Fonksiyonlar ───────────────────────────────────────────────────

function getWalletAddress() {
  // POLY_PROXY_ADDRESS = Gnosis Safe (işlem adresi), WALLET_ADDRESS = EOA
  return (process.env.POLY_PROXY_ADDRESS || process.env.WALLET_ADDRESS || "").trim().toLowerCase();
}

async function fetchPositions(address) {
  const url = `${DATA_API}/positions?user=${address}&sizeThreshold=0.01&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Positions API error: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchCurrentBid(tokenId) {
  try {
    const res = await fetch(`${CLOB_BASE}/book?token_id=${tokenId}`);
    if (!res.ok) return null;
    const book = await res.json();
    const bids = (book.bids || []).map(b => parseFloat(b.price)).filter(p => p > 0);
    return bids.length ? Math.max(...bids) : null;
  } catch { return null; }
}

function fmt(n, dec = 2) {
  if (n == null) return "—";
  return Number(n).toFixed(dec);
}

function pct(n) {
  if (n == null) return "";
  const s = (n >= 0 ? "+" : "") + (n * 100).toFixed(1) + "%";
  return n >= 0 ? `\x1b[32m${s}\x1b[0m` : `\x1b[31m${s}\x1b[0m`;
}

// ─── Pozisyon Listeleme ───────────────────────────────────────────────────────

async function listPositions() {
  const address = getWalletAddress();
  if (!address) {
    console.error("POLY_PROXY_ADDRESS veya WALLET_ADDRESS .env'de tanımlı değil.");
    process.exit(1);
  }

  console.log(`\n\x1b[1mPolymarket Pozisyonları\x1b[0m — ${address}\n`);
  console.log("Pozisyonlar yükleniyor...\n");

  let positions;
  try {
    positions = await fetchPositions(address);
  } catch (e) {
    console.error("Pozisyon çekme hatası:", e.message);
    process.exit(1);
  }

  if (!positions.length) {
    console.log("Açık pozisyon yok.");
    return;
  }

  // Her pozisyon için mevcut bid fiyatı çek
  const enriched = await Promise.all(
    positions.map(async (p) => {
      const tokenId = p.asset ?? p.tokenId ?? p.token_id;
      const bid = await fetchCurrentBid(tokenId);
      const avgPrice = parseFloat(p.avgPrice ?? p.averagePrice ?? 0);
      const size = parseFloat(p.size ?? p.shares ?? 0);
      const currentValue = bid != null ? bid * size : null;
      const costBasis = avgPrice * size;
      const pnl = currentValue != null ? (bid - avgPrice) / avgPrice : null;
      return { ...p, tokenId, bid, avgPrice, size, currentValue, costBasis, pnl };
    })
  );

  // Tabloyu yazdır
  const W = { idx: 3, title: 36, token: 16, side: 5, size: 8, avg: 6, bid: 6, val: 8, pnl: 9 };
  const header = [
    "#".padEnd(W.idx),
    "Market".padEnd(W.title),
    "Token (kısa)".padEnd(W.token),
    "Yön".padEnd(W.side),
    "Adet".padEnd(W.size),
    "Alış$".padEnd(W.avg),
    "Mev$".padEnd(W.bid),
    "Değer$".padEnd(W.val),
    "PnL",
  ].join("  ");

  console.log("\x1b[1m" + header + "\x1b[0m");
  console.log("─".repeat(header.length));

  enriched.forEach((p, i) => {
    const title = (p.title ?? p.question ?? p.marketQuestion ?? "Bilinmiyor").slice(0, W.title - 1).padEnd(W.title);
    const token = (p.tokenId ?? "").slice(0, 14).padEnd(W.token);
    const side  = (p.outcome ?? p.side ?? "?").toUpperCase().slice(0, W.side).padEnd(W.side);
    const size  = fmt(p.size).padEnd(W.size);
    const avg   = fmt(p.avgPrice, 3).padEnd(W.avg);
    const bid   = fmt(p.bid, 3).padEnd(W.bid);
    const val   = fmt(p.currentValue).padEnd(W.val);
    const pl    = pct(p.pnl);
    console.log(`${String(i + 1).padEnd(W.idx)}  ${title}  ${token}  ${side}  ${size}  ${avg}  ${bid}  ${val}  ${pl}`);
  });

  console.log("\n\x1b[2mSatmak için:\x1b[0m");
  console.log("  node src/sell.js <tokenId> all       → tamamını sat");
  console.log("  node src/sell.js <tokenId> half      → yarısını sat");
  console.log("  node src/sell.js <tokenId> <adet>    → belirli adet sat\n");

  // Token ID'leri kopyalamayı kolaylaştırmak için tam listele
  console.log("\x1b[2m── Tam Token ID'ler ──\x1b[0m");
  enriched.forEach((p, i) => {
    const title = (p.title ?? p.question ?? "?").slice(0, 40);
    console.log(`  [${i + 1}] ${p.tokenId}  ← ${title}`);
  });
  console.log();
}

// ─── Satış Yapma ─────────────────────────────────────────────────────────────

async function sellPosition(tokenId, sharesArg) {
  // Önce pozisyon listesini çek (gerçek adet için)
  let actualShares = null;

  const address = getWalletAddress();
  if (address) {
    try {
      const positions = await fetchPositions(address);
      const pos = positions.find(p => {
        const t = p.asset ?? p.tokenId ?? p.token_id ?? "";
        return t.toLowerCase() === tokenId.toLowerCase();
      });
      if (pos) {
        const size = parseFloat(pos.size ?? pos.shares ?? 0);
        if (sharesArg === "all") {
          actualShares = size;
        } else if (sharesArg === "half") {
          actualShares = Math.floor(size / 2 * 100) / 100;
        } else {
          actualShares = parseFloat(sharesArg);
        }
        console.log(`\nPozisyon bulundu: ${pos.title ?? pos.question ?? tokenId.slice(0, 20)}`);
        console.log(`  Toplam adet: ${size} | Satılacak: ${actualShares}`);
      }
    } catch { /* pozisyon çekilemedi, devam */ }
  }

  if (!actualShares || actualShares <= 0) {
    if (sharesArg === "all" || sharesArg === "half") {
      console.error("Pozisyon bulunamadı veya adet 0. Token ID'yi kontrol et.");
      process.exit(1);
    }
    actualShares = parseFloat(sharesArg);
    if (!actualShares || actualShares <= 0) {
      console.error("Geçersiz adet:", sharesArg);
      process.exit(1);
    }
  }

  console.log(`\nSatış başlatılıyor...`);
  console.log(`  Token: ${tokenId.slice(0, 20)}...`);
  console.log(`  Adet:  ${actualShares}`);

  const engine = new TradingEngine();
  const ok = await engine.init();
  if (!ok) {
    console.error("\nTradingEngine başlatılamadı — .env'deki API anahtarlarını kontrol et.");
    process.exit(1);
  }

  // Mevcut bid'i göster
  const bid = await fetchCurrentBid(tokenId);
  if (bid != null) {
    const est = (bid * actualShares).toFixed(2);
    console.log(`  Mevcut bid: $${bid.toFixed(3)} → tahmini gelir: $${est}`);
  }

  const result = await engine.sellPosition(tokenId, actualShares);

  if (result.success) {
    if (result.dryRun) {
      console.log("\n\x1b[33m[DRY RUN]\x1b[0m TRADING_ENABLED=false — gerçek satış yapılmadı.");
    } else {
      console.log(`\n\x1b[32m✓ Satış başarılı!\x1b[0m`);
      console.log(`  Fiyat: $${result.sellPrice?.toFixed(3)}`);
      console.log(`  Adet:  ${result.shares}`);
      console.log(`  Tahmini gelir: $${(result.sellPrice * result.shares).toFixed(2)}`);
    }
  } else {
    console.error(`\n\x1b[31m✗ Satış başarısız:\x1b[0m ${result.error}`);
    process.exit(1);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [,, tokenId, sharesArg] = process.argv;

if (!tokenId) {
  await listPositions();
} else {
  if (!sharesArg) {
    console.error("Kullanım: node src/sell.js <tokenId> <adet|all|half>");
    process.exit(1);
  }
  await sellPosition(tokenId, sharesArg);
}
