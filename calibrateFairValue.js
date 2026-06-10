/* ===================================================================
 * calibrateFairValue.js  (Node.js, sıfır bağımlılık)
 * ===================================================================
 * staleness CSV'sini okur ve TEK SORUYU cevaplar:
 *   "Polymarket ask'ı momentum tarafına X fiyat biçtiğinde, o taraf
 *    GERÇEKTE yüzde kaç kazanıyor?"
 *
 *   ask ≈ winrate  -> piyasa verimli, EDGE YOK
 *   winrate > ask  -> momentum tarafı ucuza satılıyor, YÖNSEL EDGE var
 *   winrate < ask  -> momentum tarafı pahalı, ters edge (fade et)
 *
 * Bu, ms-latency DEĞİL yönsel mispricing testidir — REST tabanlı bir
 * botla bile yakalanabilecek tek edge türü budur.
 *
 * METODOLOJİ (data-dredging'e karşı):
 *   - Outcome her round için Binance kapanışından TÜRETİLİR
 *     (outcome = close_price > strike ? UP : DOWN). Settlement'ın ta kendisi.
 *   - Her round'dan SADECE BİR gözlem alınır: giriş anına (T-89s) en
 *     yakın satır. Round içi 1200 korele satırı bağımsız saymak sahte
 *     anlamlılık üretir; round başına 1 gözlem doğru olandır.
 *   - Kovalardaki fark, binom standart hatasıyla anlamlılık testinden geçer.
 *
 * Kullanım:
 *   node calibrateFairValue.js staleness.csv --entry-secs 89 --tol 12
 * =================================================================== */

'use strict';
const fs = require('fs');
const readline = require('readline');
const { createReadStream } = require('fs');

function parseCsvLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
const num = (v) => (v === '' || v == null ? NaN : Number(v));

function parseArgs(argv) {
  const a = { csv: null, entrySecs: 89, tol: 12, minBucketN: 10, orderUsd: 5 };
  const map = { '--entry-secs': 'entrySecs', '--tol': 'tol', '--min-bucket-n': 'minBucketN', '--order-usd': 'orderUsd' };
  for (let i = 2; i < argv.length; i++) {
    if (map[argv[i]]) a[map[argv[i]]] = Number(argv[++i]);
    else if (!a.csv) a.csv = argv[i];
  }
  return a;
}

/* round başına: strike, kapanış fiyatı (outcome için), giriş gözlemi */
async function collect(csvPath, entrySecs, tol) {
  const rl = readline.createInterface({ input: createReadStream(csvPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let col = null;
  const rounds = new Map(); // round_id -> { strike, closePx, closeAbsSecs, entry:{...}, entryDist }

  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const f = parseCsvLine(line);
    if (!col) { col = {}; f.forEach((h, i) => { col[h] = i; }); continue; }

    const rid = f[col['round_id']];
    if (!rid) continue;
    const strike = num(f[col['strike']]);
    const bp = num(f[col['binance_price']]);
    const stc = num(f[col['secs_to_close']]);
    const delta = num(f[col['delta']]);
    if (!isFinite(strike) || !isFinite(bp)) continue;

    let r = rounds.get(rid);
    if (!r) { r = { strike, closePx: NaN, closeAbsSecs: Infinity, entry: null, entryDist: Infinity }; rounds.set(rid, r); }

    // outcome için: secs_to_close = 0'a EN YAKIN satırın binance fiyatı
    if (isFinite(stc) && Math.abs(stc) < r.closeAbsSecs) {
      r.closeAbsSecs = Math.abs(stc);
      r.closePx = bp;
    }

    // giriş gözlemi: entrySecs'e en yakın satır, tol içinde, ask DOLU ve yön net
    if (isFinite(stc) && Math.abs(stc - entrySecs) <= tol) {
      const askUp = num(f[col['pm_ask_up']]);
      const askDown = num(f[col['pm_ask_down']]);
      const dirAsk = delta > 0 ? askUp : (delta < 0 ? askDown : NaN);
      const side = delta > 0 ? 'UP' : (delta < 0 ? 'DOWN' : 'FLAT');
      const dist = Math.abs(stc - entrySecs);
      if (isFinite(dirAsk) && side !== 'FLAT' && dist < r.entryDist) {
        r.entryDist = dist;
        r.entry = { side, ask: dirAsk, conf: num(f[col['confidence']]), stc };
      }
    }
  }
  return rounds;
}

/* Wilson skor güven aralığı (p=0 veya p=1'de çökmez) */
function wilson(wins, n, z = 1.96) {
  if (n === 0) return { lo: NaN, hi: NaN };
  const p = wins / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: center - half, hi: center + half };
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.csv) { console.error('Kullanım: node calibrateFairValue.js <csv> [--entry-secs 89] [--tol 12]'); process.exit(1); }

  collect(a.csv, a.entrySecs, a.tol).then((rounds) => {
    // her round'u bir gözleme indir: {ask, win, side, outcome}
    const obs = [];
    let skippedNoEntry = 0, skippedNoClose = 0;
    for (const [, r] of rounds) {
      if (!isFinite(r.closePx)) { skippedNoClose++; continue; }
      if (!r.entry) { skippedNoEntry++; continue; }
      const outcome = r.closePx > r.strike ? 'UP' : 'DOWN';
      const win = r.entry.side === outcome ? 1 : 0;
      obs.push({ ask: r.entry.ask, win, side: r.entry.side, outcome, conf: r.entry.conf });
    }

    const line = '='.repeat(70);
    console.log(line + '\n  ADİL-DEĞER KALİBRASYONU (yönsel mispricing testi)\n' + line);
    console.log(`\n  Toplam round            : ${rounds.size}`);
    console.log(`  Kullanılabilir gözlem   : ${obs.length}  (round başına 1)`);
    console.log(`  Atlanan (giriş yok)     : ${skippedNoEntry}`);
    console.log(`  Atlanan (kapanış yok)   : ${skippedNoClose}`);
    console.log(`  Giriş anı               : T-${a.entrySecs}s (±${a.tol}s tolerans)`);

    if (obs.length < 20) {
      console.log(`\n  !! ${obs.length} gözlem çok az. Güvenilir kalibrasyon için birkaç`);
      console.log('     YÜZ round gerekir (yani günlerce temiz veri). Şimdilik yön fikri verir.');
    }

    // ask kovaları
    const edges = [0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95, 1.01];
    console.log('\n  PM ask kovası | n | gerçek WR | ort. ask | fark (WR-ask) | anlamlı?');
    console.log('  ' + '-'.repeat(66));
    let totN = 0, totWin = 0, totAsk = 0;
    for (let b = 0; b < edges.length - 1; b++) {
      const lo = edges[b], hi = edges[b + 1];
      const inB = obs.filter((o) => o.ask >= lo && o.ask < hi);
      if (!inB.length) continue;
      const n = inB.length;
      const wins = inB.reduce((s, o) => s + o.win, 0);
      const wr = wins / n;
      const meanAsk = inB.reduce((s, o) => s + o.ask, 0) / n;
      const gap = wr - meanAsk;
      const ci = wilson(wins, n);
      // anlamlı edge: ask, WR'nin %95 güven aralığının TAMAMEN dışında mı?
      const sig = (ci.lo > meanAsk || ci.hi < meanAsk) ? 'EVET' : 'hayır';
      totN += n; totWin += wins; totAsk += meanAsk * n;
      console.log(`  ${lo.toFixed(2)}-${hi >= 1 ? '1.00' : hi.toFixed(2)}     | ${String(n).padStart(3)} |   ${(wr * 100).toFixed(1).padStart(5)}% |   ${meanAsk.toFixed(3)} |   ${(gap * 100 >= 0 ? '+' : '') + (gap * 100).toFixed(1).padStart(5)} sent | ${sig} (WR %95: ${(ci.lo * 100).toFixed(0)}-${(ci.hi * 100).toFixed(0)})`);
    }

    console.log('  ' + '-'.repeat(66));
    if (totN) {
      const wrAll = totWin / totN, askAll = totAsk / totN, gapAll = wrAll - askAll;
      const ciAll = wilson(totWin, totN);
      console.log(`  GENEL        | ${String(totN).padStart(3)} |   ${(wrAll * 100).toFixed(1)}% |   ${askAll.toFixed(3)} |   ${(gapAll * 100 >= 0 ? '+' : '') + (gapAll * 100).toFixed(1)} sent  (WR %95: ${(ciAll.lo * 100).toFixed(0)}-${(ciAll.hi * 100).toFixed(0)})`);

      console.log('\n[VERDICT]');
      const sigPos = ciAll.lo > askAll;   // WR'nin alt sınırı bile ask'ı aşıyor
      const sigNeg = ciAll.hi < askAll;   // WR'nin üst sınırı bile ask'ın altında
      if (!sigPos && !sigNeg) {
        console.log("  => Ask, gerçek WR'nin %95 güven aralığının İÇİNDE. Yani fark");
        console.log('     istatistiksel gürültüden ayırt edilemiyor: yönsel edge KANITLANMADI.');
        console.log('     (Ya piyasa verimli, ya da karar vermek için veri çok az.)');
      } else if (sigPos) {
        console.log(`  => Gerçek WR'nin ALT sınırı bile ask'ı ~${((ciAll.lo - askAll) * 100).toFixed(1)} sent aşıyor.`);
        console.log('     YÖNSEL EDGE sinyali GÜÇLÜ. AMA önce ileriye dönük (out-of-sample)');
        console.log('     doğrula — tek dönemin trendi sahte pozitif üretebilir.');
      } else {
        console.log(`  => Gerçek WR'nin ÜST sınırı bile ask'ın ~${((askAll - ciAll.hi) * 100).toFixed(1)} sent altında.`);
        console.log('     Momentum tarafı pahalı; bu yönde almak sistematik zarar.');
      }
    }
    console.log(line);
  }).catch((e) => { console.error(e); process.exit(1); });
}

if (require.main === module) main();
module.exports = { collect };
