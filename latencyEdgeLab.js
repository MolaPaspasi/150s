/* ===================================================================
 * latencyEdgeLab.js  (Node.js)
 * ===================================================================
 * Polymarket "oracle sniper" stratejisi için LATENCY EDGE ölçüm altyapısı.
 *
 * Bu bir trade botu DEĞİLDİR. Emir göndermez (LatencyProbe hariç, o da
 * fill olmayacak şekilde tasarlıdır). Tek bir soruyu para riske atmadan
 * cevaplar: "Binance zıpladığında Polymarket ask'ı bir süre 'bayat'
 * (ucuz) kalıyor mu? Kalıyorsa ne kadar büyük, ne kadar uzun, ve ben
 * ona yetişebiliyor muyum?"
 *
 * İKİ PARÇA:
 *   1) StalenessRecorder — mevcut WS callback'lerine takılır, hizalanmış
 *      zaman damgalı anlık görüntüleri CSV'ye yazar. AYRI BAĞLANTI AÇMAZ.
 *   2) LatencyProbe — execution path'inin KONTROL EDİLEBİLİR kısmının
 *      gecikmesini ölçer (sinyal -> emir hazır -> API ack). Fill olmaz.
 *
 * KRİTİK: Tüm hizalama LOKAL monotonik saatle (performance.now) yapılır.
 * "Ne zaman öğrendim" sorusunun cevabı budur; borsa ts'leri farklı
 * saatler/anlamlar taşır ve karşılaştırılamaz.
 *
 * Node tek-thread event loop olduğundan kilide (lock) gerek yoktur:
 * WS callback'leri ve kayıt döngüsü aynı loop'ta çalışır.
 * =================================================================== */

import fs from 'fs';
import { performance } from 'perf_hooks';

const mono = () => performance.now() / 1000; // saniye (monotonik)
const wall = () => Date.now() / 1000;        // epoch saniye (insan-okunur)

const COLUMNS = [
  'capture_mono', 'capture_wall', 'asset', 'on_change',
  'round_id', 'secs_to_close', 'strike',
  'binance_price', 'binance_exch_ts', 'binance_recv_mono',
  'pm_ask_up', 'pm_ask_down', 'pm_bid_up', 'pm_bid_down',
  'pm_ask_up_size', 'pm_ask_down_size',
  'pm_ask_up_levels', 'pm_ask_down_levels',
  'pm_book_recv_mono', 'pm_book_seq',
  'delta', 'confidence', 'dir',
];

// CSV alan kaçışı: virgül / tırnak / yeni satır içeriyorsa tırnakla.
function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
const csvRow = (arr) => arr.map(csvField).join(',') + '\n';

/* -------------------------------------------------------------------
 * 1) STALENESS RECORDER
 * ----------------------------------------------------------------- */
class StalenessRecorder {
  /**
   * @param {string} csvPath
   * @param {string[]} assets
   * @param {object} opts  { tickMs=100, recordOnlyLastSecs=null }
   *   recordOnlyLastSecs: null => tüm round; örn. 120 => sadece her
   *   roundun son 120 saniyesi (T-89s stratejini kapsar, disk tasarrufu).
   */
  constructor(csvPath, assets, opts = {}) {
    this.csvPath = csvPath;
    this.assets = [...assets];
    this.tick = (opts.tickMs ?? 100) / 1000;
    this.recordOnlyLastSecs = opts.recordOnlyLastSecs ?? null;

    this.state = {};
    for (const a of this.assets) this.state[a] = this._blankState();

    const newFile = !fs.existsSync(csvPath);
    this.fd = fs.openSync(csvPath, 'a');
    if (newFile) fs.writeSync(this.fd, csvRow(COLUMNS));

    this._timer = null;
  }

  _blankState() {
    return {
      strike: null, roundId: null, roundEndMono: null,
      binancePrice: null, binanceExchTs: null, binanceRecvMono: null,
      pmAskUp: null, pmAskDown: null, pmBidUp: null, pmBidDown: null,
      pmAskUpSize: null, pmAskDownSize: null,
      pmAskUpLevels: null, pmAskDownLevels: null,
      pmBookRecvMono: null, pmBookSeq: null,
    };
  }

  // ---- besleme noktaları (WS callback'lerinden çağrılır) ----

  setRound(asset, roundId, strike, roundEndEpoch) {
    const s = this.state[asset];
    s.roundId = roundId;
    s.strike = Number(strike);
    // round bitişini lokal mono saate çevir (drift'i tek seferde sabitle)
    s.roundEndMono = mono() + (roundEndEpoch - wall());
  }

  onBinanceTrade(asset, price, exchTs = null) {
    const s = this.state[asset];
    const changed = s.binancePrice !== price;
    s.binancePrice = Number(price);
    s.binanceExchTs = exchTs;
    s.binanceRecvMono = mono();
    if (changed) this._emit(asset, 1); // fiyat değişimini anında yakala
  }

  /**
   * @param {object} b  {
   *   askUp, askDown, bidUp, bidDown, seq,
   *   askUpSize, askDownSize,           // top-of-book hacim
   *   askUpLevels, askDownLevels         // [[price,size],...] derinlik
   * }
   * askUpLevels/askDownLevels verirsen analiz GERÇEK VWAP fill hesaplar
   * (slippage = 'hayalet edge' elenir). Vermezsen top-of-book size kullanılır.
   */
  onPmBook(asset, b = {}) {
    const s = this.state[asset];
    if (b.askUp != null) s.pmAskUp = Number(b.askUp);
    if (b.askDown != null) s.pmAskDown = Number(b.askDown);
    if (b.bidUp != null) s.pmBidUp = Number(b.bidUp);
    if (b.bidDown != null) s.pmBidDown = Number(b.bidDown);
    if (b.askUpSize != null) s.pmAskUpSize = Number(b.askUpSize);
    if (b.askDownSize != null) s.pmAskDownSize = Number(b.askDownSize);
    if (b.askUpLevels != null) s.pmAskUpLevels = JSON.stringify(b.askUpLevels);
    if (b.askDownLevels != null) s.pmAskDownLevels = JSON.stringify(b.askDownLevels);
    s.pmBookRecvMono = mono();
    s.pmBookSeq = b.seq ?? null;
    this._emit(asset, 1); // book güncellemesini de anında yakala
  }

  // ---- iç işleyiş ----

  _row(asset, onChange) {
    const s = this.state[asset];
    if (s.strike == null || s.binancePrice == null) return null;
    const delta = s.binancePrice - s.strike;
    const conf = s.strike ? Math.abs(delta) / s.strike : 0;
    const dir = delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : 'FLAT';
    let stc = null;
    if (s.roundEndMono != null) stc = Number((s.roundEndMono - mono()).toFixed(3));
    if (this.recordOnlyLastSecs != null && stc != null && stc > this.recordOnlyLastSecs) {
      return null; // henüz ilgilenmediğimiz erken faz
    }
    const r6 = (x) => (x == null ? null : Number(x.toFixed(6)));
    return [
      r6(mono()), r6(wall()), asset, onChange,
      s.roundId, stc, s.strike,
      s.binancePrice, s.binanceExchTs, r6(s.binanceRecvMono),
      s.pmAskUp, s.pmAskDown, s.pmBidUp, s.pmBidDown,
      s.pmAskUpSize, s.pmAskDownSize,
      s.pmAskUpLevels, s.pmAskDownLevels,
      r6(s.pmBookRecvMono), s.pmBookSeq,
      Number(delta.toFixed(6)), Number(conf.toFixed(8)), dir,
    ];
  }

  _emit(asset, onChange) {
    const row = this._row(asset, onChange);
    if (row) fs.writeSync(this.fd, csvRow(row));
  }

  start() {
    // uniform grid satırları
    this._timer = setInterval(() => {
      for (const a of this.assets) this._emit(a, 0);
    }, this.tick * 1000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    fs.closeSync(this.fd);
  }
}

/* -------------------------------------------------------------------
 * 2) LATENCY PROBE
 * ----------------------------------------------------------------- */
class LatencyProbe {
  /**
   * Execution path'inin KONTROL EDİLEBİLİR kısmının gecikmesini ölçer:
   *   t0 = sinyal hesaplandı
   *   t1 = emir objesi kuruldu + imzalandı (senin buildAndSign fn'in)
   *   t2 = API ack döndü (senin send fn'in)
   *
   * ÖNEMLİ: On-chain settlement'ı ÖLÇMEZ. Bayat ask'ı ALMAK (taker)
   * için emir off-chain matching engine'e gider -> ilgili gecikme
   * API + matching yanıt süresidir, RPC/blok-zamanı DEĞİL.
   *
   * FILL RİSKİ: Default 'send' HİÇBİR emir göndermez (sadece bekler).
   * Gerçek POST RTT'si için, piyasadan UZAK + fill olmayacak bir limit
   * emri + anında cancel kullanan kendi send fn'ini ver. Bilerek default
   * yapMADIM.
   */
  constructor(buildAndSign = null, send = null) {
    this.buildAndSign = buildAndSign || LatencyProbe._stubBuild;
    this.send = send || LatencyProbe._stubSend;
    this.samples = [];
  }

  async measureOnce(signalPayload) {
    const t0 = mono();
    const order = await this.buildAndSign(signalPayload);
    const t1 = mono();
    await this.send(order);
    const t2 = mono();
    this.samples.push({
      signalToBuiltMs: (t1 - t0) * 1000,
      builtToAckMs: (t2 - t1) * 1000,
      totalMs: (t2 - t0) * 1000,
    });
    return this.samples[this.samples.length - 1];
  }

  async run(n = 200, signalPayload = { side: 'UP', size: 1 }, intervalMs = 250) {
    for (let i = 0; i < n; i++) {
      await this.measureOnce(signalPayload);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return this.summary();
  }

  summary() {
    if (!this.samples.length) return {};
    const tot = this.samples.map((s) => s.totalMs).sort((a, b) => a - b);
    const n = tot.length;
    const pct = (p) => tot[Math.min(n - 1, Math.floor((p / 100) * n))];
    const r1 = (x) => Number(x.toFixed(1));
    return {
      n,
      p50TotalMs: r1(tot[Math.floor(n / 2)]),
      p95TotalMs: r1(pct(95)),
      p99TotalMs: r1(pct(99)),
      maxTotalMs: r1(tot[n - 1]),
    };
  }

  static async _stubBuild() {
    await new Promise((r) => setTimeout(r, 2)); // imzalama maliyeti taklidi
    return { signed: true };
  }
  static async _stubSend() {
    await new Promise((r) => setTimeout(r, 50)); // ağ RTT taklidi
  }
}

export { StalenessRecorder, LatencyProbe, mono, wall, COLUMNS };

/* -------------------------------------------------------------------
 * Doğrudan çalıştırılırsa: WS olmadan duman testi
 * ----------------------------------------------------------------- */
if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  (async () => {
    const rec = new StalenessRecorder('staleness_log_demo.csv',
      ['BTC', 'ETH'], { tickMs: 100, recordOnlyLastSecs: 120 });
    rec.start();
    rec.setRound('BTC', 'btc-round-1', 60000.0, wall() + 90);
    for (let i = 0; i < 20; i++) {
      rec.onBinanceTrade('BTC', 60000 + i * 3);
      rec.onPmBook('BTC', {
        askUp: 0.70 + i * 0.005, askDown: 0.32, bidUp: 0.66, bidDown: 0.30,
        seq: i, askUpSize: 5, askDownSize: 8,
        askUpLevels: [[0.70 + i * 0.005, 5], [0.72 + i * 0.005, 40]],
      });
      await new Promise((r) => setTimeout(r, 50));
    }
    rec.stop();

    const probe = new LatencyProbe();
    console.log('Latency summary (stub):', await probe.run(20, undefined, 10));
    console.log('Demo CSV yazıldı: staleness_log_demo.csv');
  })();
}
