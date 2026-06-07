/**
 * report.js — 2 günlük trade verisi analiz raporu
 * Kullanım: node src/report.js > rapor.txt
 */

import "dotenv/config";
import fs   from "fs";
import path from "path";

const LOGS_DIR = "./logs";
const ASSETS   = ["BTC", "ETH", "SOL", "DOGE", "XRP", "BNB"];

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function loadStats(name) {
  try { return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, `stats5m_${name}.json`), "utf8")); }
  catch { return { wins: 0, losses: 0, trades: [] }; }
}

function bucket(value, size) {
  return Math.floor(value / size) * size;
}

function pct(w, t) {
  return t === 0 ? "—" : ((w / t) * 100).toFixed(1) + "%";
}

function pnlStr(pnl) {
  return (pnl >= 0 ? "+" : "") + pnl.toFixed(2);
}

function section(title) {
  const line = "═".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

// ─── Veri toplama ─────────────────────────────────────────────────────────────

const allTrades = [];
const perAsset  = {};

for (const name of ASSETS) {
  const stats = loadStats(name);
  const settled = (stats.trades || []).filter(t => t.settled && t.result);
  perAsset[name] = { settled, stats };
  settled.forEach(t => allTrades.push({ ...t, asset: name }));
}

if (allTrades.length === 0) {
  console.log("Hiç settle edilmiş trade yok. Botu 2 gün çalıştırdıktan sonra tekrar dene.");
  process.exit(0);
}

// ─── Rapor ───────────────────────────────────────────────────────────────────

console.log("pompav5 — 5m Oracle Sniper Analiz Raporu");
console.log("Oluşturulma:", new Date().toISOString());
console.log("Toplam settle trade:", allTrades.length);

// ── 1. Özet ──────────────────────────────────────────────────────────────────
section("ÖZET");

let grandW = 0, grandL = 0, grandPnl = 0;

for (const name of ASSETS) {
  const { settled } = perAsset[name];
  if (!settled.length) continue;

  const wins   = settled.filter(t => t.result === "WIN" || t.result === "TP").length;
  const losses = settled.filter(t => t.result === "LOSS" || t.result === "SL").length;
  const total  = wins + losses;
  const pnl    = settled.reduce((s, t) => {
    if (t.result === "WIN") return s + (t.shares * (1 - t.askPrice));
    if (t.result === "TP")  return s + ((t.exitPrice - t.askPrice) * t.shares);
    if (t.result === "SL")  return s + ((t.exitPrice - t.askPrice) * t.shares);
    return s - t.amount;
  }, 0);

  grandW   += wins;
  grandL   += losses;
  grandPnl += pnl;

  console.log(`${name.padEnd(5)} ${String(wins).padStart(3)}W ${String(losses).padStart(3)}L  WR:${pct(wins, total).padStart(6)}  P&L: ${pnlStr(pnl).padStart(8)}`);
}

console.log("─".repeat(50));
const grandTotal = grandW + grandL;
console.log(`TOTAL ${String(grandW).padStart(3)}W ${String(grandL).padStart(3)}L  WR:${pct(grandW, grandTotal).padStart(6)}  P&L: ${pnlStr(grandPnl).padStart(8)}`);

// ── 2. Confidence bucket analizi ─────────────────────────────────────────────
section("WIN RATE — CONFIDENCE EŞİĞİNE GÖRE");
console.log("(her bucket o confidence ve üzeri olan trade'leri kapsar)\n");

const bucketSizes = [0.001, 0.002, 0.003, 0.004, 0.005, 0.007, 0.010];
for (const thresh of bucketSizes) {
  const subset = allTrades.filter(t => t.confidence >= thresh);
  const w = subset.filter(t => t.result === "WIN" || t.result === "TP").length;
  const l = subset.length - w;
  const pnl = subset.reduce((s, t) => {
    if (t.result === "WIN") return s + (t.shares * (1 - t.askPrice));
    if (t.result === "TP")  return s + ((t.exitPrice - t.askPrice) * t.shares);
    if (t.result === "SL")  return s + ((t.exitPrice - t.askPrice) * t.shares);
    return s - t.amount;
  }, 0);
  console.log(`≥${(thresh * 100).toFixed(1).padStart(4)}%  ${String(subset.length).padStart(4)} trade  WR:${pct(w, subset.length).padStart(6)}  P&L:${pnlStr(pnl).padStart(9)}`);
}

// ── 3. Direction analizi ─────────────────────────────────────────────────────
section("WIN RATE — YÖN GÖRE (UP vs DOWN)");

for (const dir of ["UP", "DOWN"]) {
  const subset = allTrades.filter(t => t.side === dir);
  const w = subset.filter(t => t.result === "WIN" || t.result === "TP").length;
  console.log(`${dir.padEnd(5)} ${String(subset.length).padStart(4)} trade  WR:${pct(w, subset.length).padStart(6)}`);
}

// ── 4. Ask price bucket analizi ──────────────────────────────────────────────
section("WIN RATE — GİRİŞ FİYATINA GÖRE");
console.log("(düşük fiyat = daha düşük ihtimal ama daha yüksek kazanç)\n");

const priceRanges = [[0.10, 0.30], [0.30, 0.50], [0.50, 0.65], [0.65, 0.80], [0.80, 0.95]];
for (const [lo, hi] of priceRanges) {
  const subset = allTrades.filter(t => t.askPrice >= lo && t.askPrice < hi);
  if (!subset.length) continue;
  const w = subset.filter(t => t.result === "WIN" || t.result === "TP").length;
  const avgConf = subset.reduce((s, t) => s + t.confidence, 0) / subset.length;
  console.log(`$${lo.toFixed(2)}-${hi.toFixed(2)}  ${String(subset.length).padStart(4)} trade  WR:${pct(w, subset.length).padStart(6)}  avgConf:${(avgConf * 100).toFixed(2)}%`);
}

// ── 5. Saatlik dağılım ───────────────────────────────────────────────────────
section("WIN RATE — SAAT GÖRE (UTC)");

const byHour = {};
for (const t of allTrades) {
  if (!t.marketEndMs) continue;
  const h = new Date(t.marketEndMs).getUTCHours();
  if (!byHour[h]) byHour[h] = { w: 0, l: 0 };
  if (t.result === "WIN" || t.result === "TP") byHour[h].w++;
  else byHour[h].l++;
}
for (let h = 0; h < 24; h++) {
  const d = byHour[h];
  if (!d) continue;
  const total = d.w + d.l;
  const bar = "█".repeat(Math.round(d.w / total * 20));
  console.log(`${String(h).padStart(2)}:00  ${String(total).padStart(3)} trade  WR:${pct(d.w, total).padStart(6)}  ${bar}`);
}

// ── 6. Asset × Direction matrisi ─────────────────────────────────────────────
section("WIN RATE — ASSET × YÖN MATRİSİ");
console.log(`${"".padEnd(8)} ${"UP".padStart(10)} ${"DOWN".padStart(10)}`);

for (const name of ASSETS) {
  const { settled } = perAsset[name];
  const up   = settled.filter(t => t.side === "UP");
  const down = settled.filter(t => t.side === "DOWN");
  const upW  = up.filter(t => t.result === "WIN" || t.result === "TP").length;
  const dnW  = down.filter(t => t.result === "WIN" || t.result === "TP").length;
  if (!up.length && !down.length) continue;
  console.log(`${name.padEnd(8)} ${(pct(upW, up.length) + ` (${up.length})`).padStart(10)} ${(pct(dnW, down.length) + ` (${down.length})`).padStart(10)}`);
}

// ── 7. T-150s Pre-Signal Analizi ─────────────────────────────────────────────
section("T-150s PRE-SİNYAL ANALİZİ");
console.log("(T-150s gözlemi ile T-89s gerçek trade sinyali karşılaştırması)\n");

const withPre  = allTrades.filter(t => t.pre150s);
const noPre    = allTrades.filter(t => !t.pre150s);

if (withPre.length === 0) {
  console.log("  Henüz T-150s verisi yok — bot güncellendikten sonra birikecek.");
} else {
  const sameDir = withPre.filter(t => t.pre150s.direction === t.side);
  const diffDir = withPre.filter(t => t.pre150s.direction !== t.side);

  const winCount = t => (t.result === "WIN" || t.result === "TP") ? 1 : 0;

  const sameDirW = sameDir.reduce((s, t) => s + winCount(t), 0);
  const diffDirW = diffDir.reduce((s, t) => s + winCount(t), 0);

  console.log(`Pre-sinyal VAR: ${withPre.length} trade  |  Pre-sinyal YOK: ${noPre.length} trade\n`);
  console.log(`Aynı yön  (pre=entry): ${String(sameDir.length).padStart(3)} trade  WR: ${pct(sameDirW, sameDir.length).padStart(6)}`);
  console.log(`Farklı yön(pre≠entry): ${String(diffDir.length).padStart(3)} trade  WR: ${pct(diffDirW, diffDir.length).padStart(6)}`);

  console.log(`\nYorum:`);
  if (sameDir.length > 5 && diffDir.length > 5) {
    const sWr = sameDirW / sameDir.length;
    const dWr = diffDirW / diffDir.length;
    if (sWr > dWr + 0.05) console.log(`  → Aynı yön daha yüksek WR — T-150s filtresi faydalı olabilir`);
    else if (dWr > sWr + 0.05) console.log(`  → Farklı yön daha yüksek WR — reversal sinyali değerli olabilir`);
    else console.log(`  → Anlamlı fark yok — T-150s sinyali şimdilik bilgi vermiyor`);
  } else {
    console.log(`  → Yeterli veri yok (her grupta en az 5 trade gerekli)`);
  }
}

// ── 8. Ham trade verisi (CSV) ─────────────────────────────────────────────────
section("HAM VERİ — TÜM TRADE'LER (CSV)");
console.log("asset,side,confidence_pct,strike,binanceAtFire,askPrice,shares,result,exitType,pnl,time_utc");

for (const t of allTrades.sort((a, b) => (a.marketEndMs || 0) - (b.marketEndMs || 0))) {
  const confPct = (t.confidence * 100).toFixed(3);
  const pnl = t.result === "WIN"  ? (t.shares * (1 - t.askPrice)).toFixed(2)
            : t.result === "TP"   ? ((t.exitPrice - t.askPrice) * t.shares).toFixed(2)
            : t.result === "SL"   ? ((t.exitPrice - t.askPrice) * t.shares).toFixed(2)
            : (-t.amount).toFixed(2);
  const exitType = t.exitedEarly ? t.exitReason : "SETTLE";
  const time = t.marketEndMs ? new Date(t.marketEndMs).toISOString() : "";
  const bnb  = t.binancePrice?.toFixed(4) ?? "";
  const str  = t.strikePrice?.toFixed(4)  ?? "";
  console.log(`${t.asset},${t.side},${confPct},${str},${bnb},${t.askPrice?.toFixed(4)},${t.shares},${t.result},${exitType},${pnl},${time}`);
}
