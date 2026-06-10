/* ===================================================================
 * analyzeSlices.js  (Node.js, sıfır bağımlılık)
 * ===================================================================
 * Trade log'undaki her "dilimi" (asset / yön / asset×yön / saat) istatistik
 * testinden geçirir: hangisi GERÇEKTEN anlamlı, hangisi GÜRÜLTÜ?
 *
 * İki şeyi birden yapar:
 *   1) Wilson %95 güven aralığı (p=0/1'de çökmez)
 *   2) Çoklu-karşılaştırma DÜZELTMESİ (Bonferroni): çok sayıda dilimi
 *      tarayınca tesadüfen "anlamlı" çıkanları eler. Bir tablodan en uç
 *      hücreyi seçip tek-test eşiğiyle yargılamak sahte pozitif üretir;
 *      bu script onu engeller.
 *
 * Her hücre için karar (break-even = WR eşiği = ödenen ask):
 *   CI_üst < BE  -> "BE ALTI" (asset/saat gerçekten zarar ediyor)
 *   CI_alt > BE  -> "BE ÜSTÜ" (gerçekten kâr ediyor)
 *   aksi         -> "belirsiz" (gürültüden ayırt edilemiyor)
 * ...hem ham %95 hem düzeltilmiş eşikte gösterilir.
 *
 * VERİ: --path bir klasör (içindeki tüm *.json), tek .json, ya da .csv olabilir.
 * Beklenen trade alanları (CLI ile değiştirilebilir):
 *   slug/round id, side (UP/DOWN), result (WIN/LOSS), marketEndMs, (ops.) entryPrice
 *   asset, slug yoksa side... asset slug ön-ekinden türetilir ("btc-..."→BTC).
 *
 * Kullanım:
 *   node analyzeSlices.js --path logs/ --global-be 0.84
 *   node analyzeSlices.js --path trades.json --field-price entryAsk
 * =================================================================== */

import fs from 'fs';
import path from 'path';

/* ---------- inverse normal CDF (Acklam) — düzeltilmiş z için ---------- */
function normInv(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425, phigh = 1 - plow; let q, r;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= phigh) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
function wilson(wins, n, z) {
  if (n === 0) return { lo: NaN, hi: NaN };
  const p = wins / n, z2 = z * z, dn = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / dn;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / dn;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/* ---------- arg parse ---------- */
function parseArgs(argv) {
  const a = { path: null, globalBe: 0.84, alpha: 0.05, minN: 8,
    fAsset: 'asset', fSlug: 'slug', fSide: 'side', fResult: 'result', fEnd: 'marketEndMs', fPrice: 'askPrice' };
  const m = { '--path': 'path', '--global-be': 'globalBe', '--alpha': 'alpha', '--min-n': 'minN',
    '--field-asset': 'fAsset', '--field-slug': 'fSlug', '--field-side': 'fSide', '--field-result': 'fResult', '--field-end': 'fEnd', '--field-price': 'fPrice' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (m[k]) { const v = argv[++i]; a[m[k]] = (['globalBe', 'alpha', 'minN'].includes(m[k])) ? Number(v) : v; }
    else if (!a.path) a.path = k;
  }
  return a;
}

/* ---------- trade yükleme (klasör / json / csv toleranslı) ---------- */
function extractTrades(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && Array.isArray(obj.trades)) return obj.trades;
  if (obj && Array.isArray(obj.history)) return obj.history;
  if (obj && (obj.result || obj.side)) return [obj];
  return [];
}
function loadCsv(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => { const f = l.split(','); const o = {}; head.forEach((h, i) => { o[h] = f[i]; }); return o; });
}
function loadTrades(p) {
  let files = [];
  const st = fs.statSync(p);
  if (st.isDirectory()) files = fs.readdirSync(p).filter((f) => /^stats5m_.*\.json$/.test(f) || (f.endsWith('.csv') && !f.startsWith('staleness'))).map((f) => path.join(p, f));
  else files = [p];
  let trades = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.csv')) trades = trades.concat(loadCsv(text));
    else { try { trades = trades.concat(extractTrades(JSON.parse(text))); } catch (e) { console.error(`! ${f} parse edilemedi: ${e.message}`); } }
  }
  return trades;
}

function assetOf(t, a) {
  if (t[a.fAsset]) return String(t[a.fAsset]).toUpperCase();
  const slug = t[a.fSlug];
  if (slug && typeof slug === 'string') return slug.split('-')[0].toUpperCase();
  return '?';
}
function hourOf(t, a) {
  const ms = Number(t[a.fEnd]);
  if (!isFinite(ms)) return null;
  return new Date(ms).getUTCHours();
}
const isWin = (t, a) => String(t[a.fResult]).toUpperCase() === 'WIN';

/* ---------- dilim toplama ---------- */
function buildCells(trades, a) {
  const dims = { asset: new Map(), side: new Map(), 'asset×side': new Map(), 'saat(UTC)': new Map() };
  function add(map, key, t) {
    if (!map.has(key)) map.set(key, { n: 0, w: 0, beSum: 0, bePts: 0 });
    const c = map.get(key); c.n++; if (isWin(t, a)) c.w++;
    const pr = Number(t[a.fPrice]);
    if (isFinite(pr)) { c.beSum += pr; c.bePts++; }
  }
  for (const t of trades) {
    if (!t[a.fResult]) continue;
    const asset = assetOf(t, a); const side = (String(t[a.fSide] || '?')).toUpperCase(); const hr = hourOf(t, a);
    add(dims.asset, asset, t);
    add(dims.side, side, t);
    add(dims['asset×side'], `${asset} ${side}`, t);
    if (hr != null) add(dims['saat(UTC)'], String(hr).padStart(2, '0'), t);
  }
  return dims;
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.path) { console.error('Kullanım: node analyzeSlices.js --path <klasör|json|csv> [--global-be 0.84] [--min-n 8]'); process.exit(1); }
  const trades = loadTrades(a.path);
  if (!trades.length) { console.error('Hiç trade bulunamadı. Alan adlarını --field-* ile kontrol et.'); process.exit(1); }

  const dims = buildCells(trades, a);

  // test edilecek hücre sayısı (m) = minN'i geçen tüm hücreler
  let m = 0;
  for (const map of Object.values(dims)) for (const c of map.values()) if (c.n >= a.minN) m++;
  const zNaive = normInv(1 - a.alpha / 2);
  const alphaCorr = a.alpha / Math.max(1, m);             // Bonferroni
  const zCorr = normInv(1 - alphaCorr / 2);

  const line = '='.repeat(78);
  console.log(line + '\n  DİLİM ANLAMLILIK ANALİZİ (Wilson CI + çoklu-karşılaştırma düzeltmesi)\n' + line);
  console.log(`\n  Toplam trade            : ${trades.length}`);
  console.log(`  Test edilen hücre (m)   : ${m}  (n >= ${a.minN})`);
  console.log(`  Ham eşik                : %95   (z=${zNaive.toFixed(2)})`);
  console.log(`  Düzeltilmiş eşik        : %${((1 - alphaCorr) * 100).toFixed(2)}  (Bonferroni, z=${zCorr.toFixed(2)})`);
  const priced = trades.filter((t) => isFinite(Number(t[a.fPrice]))).length;
  console.log(`  Giriş fiyatı olan trade : ${priced}/${trades.length} ${priced === 0 ? `(yok → BE=${a.globalBe} varsayıldı)` : '(hücre BE = ort. giriş ask)'}`);

  let sigCorr = 0, sigNaiveOnly = 0;

  for (const [dimName, map] of Object.entries(dims)) {
    const rows = [...map.entries()].filter(([, c]) => c.n >= a.minN).sort((x, y) => (y[1].w / y[1].n) - (x[1].w / x[1].n));
    if (!rows.length) continue;
    console.log(`\n  ── ${dimName} ──`);
    console.log('  hücre           |  n  |   WR   |  BE  | ham %95 CI  | düz. CI     | karar (düzeltilmiş)');
    console.log('  ' + '-'.repeat(88));
    for (const [key, c] of rows) {
      const wr = c.w / c.n;
      const be = c.bePts ? c.beSum / c.bePts : a.globalBe;
      const ciN = wilson(c.w, c.n, zNaive);
      const ciC = wilson(c.w, c.n, zCorr);
      let verdict, naiveSig = (ciN.hi < be || ciN.lo > be);
      if (ciC.hi < be) { verdict = 'BE ALTI (zarar, KANIT)'; sigCorr++; }
      else if (ciC.lo > be) { verdict = 'BE ÜSTÜ (kâr, KANIT)'; sigCorr++; }
      else { verdict = naiveSig ? 'belirsiz (ham anlamlı ama düzeltmede ELENDİ)' : 'belirsiz (gürültü)'; if (naiveSig) sigNaiveOnly++; }
      const f = (x) => (x * 100).toFixed(0);
      console.log(`  ${key.padEnd(15)} | ${String(c.n).padStart(3)} | ${(wr * 100).toFixed(1).padStart(5)}% | ${be.toFixed(2)} | ${f(ciN.lo)}-${f(ciN.hi)}%`.padEnd(58) + `| ${f(ciC.lo)}-${f(ciC.hi)}%`.padEnd(14) + `| ${verdict}`);
    }
  }

  console.log('\n' + line + '\n[ÖZET]');
  console.log(`  Düzeltme sonrası ANLAMLI hücre : ${sigCorr}`);
  console.log(`  Ham %95'te anlamlıyken DÜZELTMEDE elenen : ${sigNaiveOnly}  (← bunlar büyük olasılıkla gürültüydü)`);
  if (sigCorr === 0) {
    console.log('  => Hiçbir asset/yön/saat dilimi, çoklu-karşılaştırma düzeltmesinden');
    console.log('     sonra BE eşiğini güvenle aşmıyor/altına düşmüyor. Yani "şu asseti at,');
    console.log('     şu saati at" reçetesi istatistiksel olarak DESTEKLENMİYOR — overfit riski.');
  } else {
    console.log('  => Yukarıda "KANIT" işaretli hücreler düzeltmeden sonra da ayakta. Yine de');
    console.log('     karar vermeden önce ileriye dönük (out-of-sample) bir dönemde teyit et.');
  }
  console.log(line);
}

export { wilson, normInv, buildCells };
main();
