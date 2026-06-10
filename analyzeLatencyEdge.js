/* ===================================================================
 * analyzeLatencyEdge.js  (Node.js, sıfır bağımlılık)
 * ===================================================================
 * latencyEdgeLab.js'in ürettiği staleness CSV'sini analiz eder ve TEK
 * SORUYA cevap verir: yakalanabilir bayat-ask penceresi var mı, ve sen
 * ona yetişebiliyor musun?
 *
 * ÇIKTI:
 *   A) LEAD-LAG : PM ask Binance'i kaç ms geriden takip ediyor?
 *   B) STALE EVENTS : zıplama sonrası ask kaç sent (slippage dahil VWAP)
 *                     ve kaç ms ucuz kalıyor? Kaç event yakalanabilir?
 *   C) VERDICT : pencere > senin execution latency'in mi?
 *
 * DÜRÜST VARSAYIM: "adil fiyat" için olasılık modeli UYDURMUYORUM.
 * Piyasanın KENDİ bir-an-sonraki fiyatını adil kabul ediyorum.
 *
 * Kullanım:
 *   node analyzeLatencyEdge.js staleness_log.csv \
 *     --exec-latency-p95-ms 120 --order-usd 10 \
 *     --jump-bps 5 --min-edge-cents 2 --react-window-s 4
 * =================================================================== */

import fs, { createReadStream } from 'fs';
import readline from 'readline';

/* ---------- CSV parse (tırnaklı alanları destekler) ---------- */
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function loadCsv(path) {
  const text = fs.readFileSync(path, 'utf8').replace(/\r/g, '');
  const lines = text.split('\n').filter((l) => l.length);
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const o = {};
    header.forEach((h, j) => { o[h] = f[j]; });
    rows.push(o);
  }
  return rows;
}

const num = (v) => (v === '' || v == null ? NaN : Number(v));

/* ---------- yön (momentum) bağımlı alanlar ---------- */
function dirAsk(r) {
  const d = num(r.delta);
  if (d > 0) return num(r.pm_ask_up);
  if (d < 0) return num(r.pm_ask_down);
  return NaN;
}
function dirSize(r) {
  const d = num(r.delta);
  if (d > 0) return num(r.pm_ask_up_size);
  if (d < 0) return num(r.pm_ask_down_size);
  return NaN;
}
function dirLevels(r) {
  const d = num(r.delta);
  if (d > 0) return r.pm_ask_up_levels || '';
  if (d < 0) return r.pm_ask_down_levels || '';
  return '';
}

/* ---------- order_usd'lik taker emrinin GERÇEK VWAP fill fiyatı ----------
 * levels varsa slippage dahil VWAP; yoksa top-of-book size ile yetinir.
 * Polymarket'te size 'shares' (her biri max $1); seviye USD kapasite ≈ px*sz.
 * Dönen: { vwap, filledUsd }. filledUsd < orderUsd => likidite yetmedi. */
function vwapFill(levelsJson, topPx, topSize, orderUsd) {
  let levels = null;
  if (levelsJson && levelsJson !== 'nan') {
    try { levels = JSON.parse(levelsJson); } catch { levels = null; }
  }
  if (!levels || !levels.length) {
    if (!isFinite(topPx)) return { vwap: null, filledUsd: 0 };
    const sz = isFinite(topSize) ? topSize : 1e9;
    const capUsd = topPx * sz;
    return capUsd >= orderUsd
      ? { vwap: topPx, filledUsd: orderUsd }
      : { vwap: topPx, filledUsd: capUsd };
  }
  let shares = 0, cost = 0, remaining = orderUsd;
  for (const [px, sz] of levels) {
    const capUsd = px * sz;
    const take = Math.min(remaining, capUsd);
    shares += take / px;
    cost += take;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (shares === 0) return { vwap: null, filledUsd: 0 };
  return { vwap: cost / shares, filledUsd: cost };
}

/* ---------- bir (round,asset) serisini uniform grid'e last-value-forward ---------- */
function resampleRound(rows, gridMs) {
  rows = rows
    .filter((r) => isFinite(num(r.binance_price)) && isFinite(num(r.strike)))
    .sort((a, b) => num(a.capture_mono) - num(b.capture_mono));
  if (rows.length < 2) return null;
  const t0 = num(rows[0].capture_mono);
  const t1 = num(rows[rows.length - 1].capture_mono);
  if (t1 - t0 < 1.0) return null;

  const step = gridMs / 1000;
  const grid = [];
  for (let t = t0; t < t1; t += step) grid.push(t);

  // her satır için yön-bağımlı türevleri önceden hesapla
  const pre = rows.map((r) => ({
    t: num(r.capture_mono),
    bp: num(r.binance_price),
    ask: dirAsk(r),
    size: dirSize(r),
    levels: dirLevels(r),
  }));

  const out = { t: grid, bp: [], ask: [], size: [], levels: [] };
  let p = 0;
  for (const gt of grid) {
    while (p + 1 < pre.length && pre[p + 1].t <= gt) p++;
    const cur = pre[p];
    out.bp.push(cur.bp);
    out.ask.push(cur.ask);
    out.size.push(cur.size);
    out.levels.push(cur.levels);
  }
  return out;
}

/* ---------- A) LEAD-LAG ---------- */
function pearson(x, y) {
  const n = x.length;
  if (n < 3) return NaN;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

function leadLag(grids, gridMs, maxLagMs = 2000) {
  const maxLag = Math.floor(maxLagMs / gridMs);
  const b = [], a = [];
  for (const g of grids) {
    for (let i = 1; i < g.bp.length; i++) {
      b.push(g.bp[i - 1] ? g.bp[i] / g.bp[i - 1] - 1 : 0);
      a.push((g.ask[i] || 0) - (g.ask[i - 1] || 0));
    }
  }
  if (!b.length) return null;
  let best = 0, bestC = -Infinity, czero = NaN;
  for (let L = 0; L <= maxLag; L++) {
    const c = L === 0
      ? pearson(b, a)
      : pearson(b.slice(0, -L), a.slice(L));
    if (L === 0) czero = c;
    if (isFinite(c) && c > bestC) { bestC = c; best = L; }
  }
  return {
    bestLagMs: best * gridMs,
    corrAtBest: Number(bestC.toFixed(4)),
    corrAtZero: Number((czero || 0).toFixed(4)),
  };
}

/* ---------- B) STALE-ASK EVENTLERİ ---------- */
function staleEvents(grids, gridMs, jumpBps, minEdgeCents, reactWindowS, orderUsd) {
  const win = Math.floor((reactWindowS * 1000) / gridMs);
  const jumpWindow = Math.max(1, Math.floor(500 / gridMs)); // 500ms zıplama
  const events = [];
  for (const g of grids) {
    const { bp, ask, size, levels } = g;
    const n = bp.length;
    let i = jumpWindow;
    while (i < n - 1) {
      const retBps = (bp[i] / bp[i - jumpWindow] - 1) * 1e4;
      if (Math.abs(retBps) < jumpBps || !isFinite(ask[i])) { i++; continue; }
      const { vwap, filledUsd } = vwapFill(levels[i], ask[i], size[i], orderUsd);
      if (vwap == null) { i++; continue; }
      const partial = filledUsd < orderUsd - 1e-6;
      const seg = ask.slice(i, i + win).filter(isFinite);
      if (seg.length < 3) { i++; continue; }
      const fair = seg[seg.length - 1];        // piyasanın sonradan taşıdığı yer
      const edge = (fair - vwap) * 100;         // sent — slippage dahil
      const thresh = vwap + minEdgeCents / 100;
      let durMs = null;
      for (let k = i; k < Math.min(i + win, n); k++) {
        if (isFinite(ask[k]) && ask[k] >= thresh) { durMs = (k - i) * gridMs; break; }
      }
      events.push({
        retBps, payVwap: Number(vwap.toFixed(4)), topAsk: Number(ask[i].toFixed(4)),
        fair: Number(fair.toFixed(4)), edgeCents: Number(edge.toFixed(3)),
        filledUsd: Number(filledUsd.toFixed(2)), partial,
        windowMs: durMs,
        capturable: edge >= minEdgeCents && durMs != null && !partial,
      });
      i += win; // aynı zıplamayı tekrar sayma
    }
  }
  return events;
}

/* ---------- yardımcılar ---------- */
const median = (arr) => {
  const a = arr.filter((x) => x != null && isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  return a[Math.floor(a.length / 2)];
};
const percentile = (arr, p) => {
  const a = arr.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return Number(a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))].toFixed(1));
};

/* ---------- C) VERDICT ---------- */
function verdict(ll, ev, execP95) {
  const line = '='.repeat(67);
  console.log(line + '\n  LATENCY EDGE RAPORU\n' + line);

  console.log("\n[A] LEAD-LAG — PM ask, Binance'i kaç ms geriden takip ediyor?");
  if (!ll) {
    console.log('    Yetersiz varyans (veri az ya da hareket yok).');
  } else {
    console.log(`    En iyi lag        : ${ll.bestLagMs} ms`);
    console.log(`    Korelasyon (best) : ${ll.corrAtBest}`);
    console.log(`    Korelasyon (lag0) : ${ll.corrAtZero}`);
    if (ll.bestLagMs <= 50) console.log('    => PM neredeyse anında tepki veriyor. EDGE YOK denecek kadar.');
    else console.log(`    => PM ~${ll.bestLagMs}ms gecikiyor. Pencere BURADA olabilir.`);
  }

  console.log('\n[B] STALE-ASK EVENTLERİ');
  if (!ev.length) { console.log('    Hiç zıplama eventi yok (jump-bps düşür?).'); return; }
  const cap = ev.filter((e) => e.capturable);
  const nPartial = ev.filter((e) => e.partial).length;
  console.log(`    Toplam zıplama eventi : ${ev.length}`);
  console.log(`    Likidite yetmeyen     : ${nPartial} (kısmi fill = hayalet edge)`);
  console.log(`    Yakalanabilir event   : ${cap.length} (${(100 * cap.length / ev.length).toFixed(1)}%)`);
  console.log(`    Medyan edge (tümü)    : ${median(ev.map((e) => e.edgeCents)).toFixed(2)} sent (VWAP/slippage dahil)`);
  if (cap.length) {
    console.log(`    Medyan edge (cap.)    : ${median(cap.map((e) => e.edgeCents)).toFixed(2)} sent`);
    console.log(`    Medyan pencere süresi : ${percentile(cap.map((e) => e.windowMs), 50)} ms`);
    console.log(`    p25 pencere süresi    : ${percentile(cap.map((e) => e.windowMs), 25)} ms`);
  }

  console.log('\n[C] VERDICT — yetişebiliyor musun?');
  console.log(`    Senin exec latency p95: ${execP95} ms`);
  if (!cap.length) {
    console.log('    => Yakalanabilir pencere YOK. Bu strateji latency-edge olarak');
    console.log('       çalışmaz; mevcut hali piyasa-verimli (edge yok).');
    console.log(line); return;
  }
  const medWin = percentile(cap.map((e) => e.windowMs), 50);
  console.log(`    Medyan pencere (${medWin}ms) vs latency'in (${execP95}ms):`);
  if (medWin != null && medWin > execP95) {
    console.log(`    => PRENSİPTE YAKALANABİLİR. ~${(medWin - execP95).toFixed(0)}ms marjın var.`);
    console.log('       AMA: aynı pencereyi profesyonel botlar da kovalıyor; canlı');
    console.log('       (parasız/paper) test etmeden ölçek büyütme. Edge teorik üst sınır.');
  } else {
    console.log('    => ÇOK YAVAŞSIN. Pencere senin tepki sürenden kısa. Bu haliyle');
    console.log('       latency-edge yakalanamaz. Ya altyapıyı hızlandır ya da bırak.');
  }
  console.log(line);
}

/* ---------- arg parse ---------- */
function parseArgs(argv) {
  const a = { csv: null, gridMs: 50, jumpBps: 5, minEdgeCents: 2, reactWindowS: 4, orderUsd: 10, execP95: 120 };
  const map = {
    '--grid-ms': 'gridMs', '--jump-bps': 'jumpBps', '--min-edge-cents': 'minEdgeCents',
    '--react-window-s': 'reactWindowS', '--order-usd': 'orderUsd', '--exec-latency-p95-ms': 'execP95',
  };
  for (let i = 2; i < argv.length; i++) {
    if (map[argv[i]]) a[map[argv[i]]] = Number(argv[++i]);
    else if (!a.csv) a.csv = argv[i];
  }
  return a;
}

/* ---------- satır-satır stream okuma — bellek OOM'u önler ---------- */
const NEEDED_KEYS = [
  'capture_mono', 'binance_price', 'strike', 'delta',
  'pm_ask_up', 'pm_ask_down', 'pm_bid_up', 'pm_bid_down',
  'pm_ask_up_size', 'pm_ask_down_size', 'pm_ask_up_levels', 'pm_ask_down_levels',
  'round_id', 'asset',
];

async function streamAnalyze(csvPath, gridMs) {
  const rl = readline.createInterface({
    input: createReadStream(csvPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let header = null, colIdx = {}, rowCount = 0;
  const active = new Map(); // asset → { roundId, rows[] }
  const grids = [];

  function flushGroup(g) {
    const gr = resampleRound(g.rows, gridMs);
    if (gr && gr.ask.filter(isFinite).length > 5) grids.push(gr);
  }

  for await (const rawLine of rl) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) continue;
    const fields = parseCsvLine(line);

    if (!header) {
      header = fields;
      fields.forEach((h, i) => { colIdx[h] = i; });
      continue;
    }

    const roundId = fields[colIdx['round_id']];
    const asset   = fields[colIdx['asset']];
    if (!roundId || !asset) continue;

    rowCount++;

    const g = active.get(asset);
    if (g && g.roundId !== roundId) {
      flushGroup(g);
      active.delete(asset);
    }

    if (!active.has(asset)) active.set(asset, { roundId, rows: [] });

    const row = {};
    for (const k of NEEDED_KEYS) row[k] = colIdx[k] != null ? (fields[colIdx[k]] ?? '') : '';
    active.get(asset).rows.push(row);
  }

  for (const g of active.values()) flushGroup(g);

  console.log(`Yüklendi: ${rowCount.toLocaleString()} satır → ${grids.length} (round,asset) serisi`);
  return grids;
}

/* ---------- main ---------- */
async function main() {
  const a = parseArgs(process.argv);
  if (!a.csv) {
    console.error('Kullanım: node analyzeLatencyEdge.js <csv> [--exec-latency-p95-ms N] [--order-usd N] ...');
    process.exit(1);
  }

  const grids = await streamAnalyze(a.csv, a.gridMs);
  if (!grids.length) { console.error('Yeterli (round,asset) serisi yok.'); process.exit(1); }

  const ll = leadLag(grids, a.gridMs);
  const ev = staleEvents(grids, a.gridMs, a.jumpBps, a.minEdgeCents, a.reactWindowS, a.orderUsd);
  verdict(ll, ev, a.execP95);
}

export { loadCsv, resampleRound, leadLag, staleEvents, vwapFill };

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('analyzeLatencyEdge.js'))
  main().catch((e) => { console.error(e); process.exit(1); });
