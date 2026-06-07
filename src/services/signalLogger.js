/**
 * logs/signals.csv — Karar günlüğü: whale-style ve sniper anında ENTER / SKIP + neden.
 * Analiz: hangi edge/fiyat/remaining_min'de giriş yapıldı, neden atlandı; eşik ayarı için.
 */

import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");
const SIGNALS_FILE = path.join(LOG_DIR, "signals.csv");

const HEADER = "timestamp,asset,slug,decision,side,reason,edge_up,edge_down,ask_up,ask_down,remaining_min,oracle_price,binance_price,price_to_beat,model_up,model_down\n";

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function safe(v) {
  if (v == null || v === "") return "";
  const s = String(v).replace(/,/g, ";").replace(/\n/g, " ");
  return s;
}

function num(v) {
  if (v == null || typeof v !== "number" || !Number.isFinite(v)) return "";
  return v.toFixed(4);
}

/**
 * Log a decision point (whale window or sniper window).
 * @param {Object} opts
 * @param {string} opts.asset - BTC, ETH, SOL
 * @param {string} opts.slug - market slug
 * @param {string} opts.decision - ENTER_WHALE_STYLE | SNIPE | SKIP
 * @param {string} [opts.side] - UP | DOWN
 * @param {string} opts.reason - no_signal | cooldown | already_entered | ask_too_high | snipe_no_opp | ...
 * @param {number} [opts.edgeUp] - edge engine
 * @param {number} [opts.edgeDown]
 * @param {number} [opts.askUp] - orderbook best ask
 * @param {number} [opts.askDown]
 * @param {number} [opts.remainingMin]
 * @param {number} [opts.oraclePrice]
 * @param {number} [opts.binancePrice]
 * @param {number} [opts.priceToBeat]
 * @param {number} [opts.modelUp] - probability model
 * @param {number} [opts.modelDown]
 */
export function logSignal(opts) {
  try {
    ensureLogDir();
    const exists = fs.existsSync(SIGNALS_FILE);
    const line = [
      new Date().toISOString(),
      safe(opts.asset),
      safe(opts.slug),
      safe(opts.decision),
      safe(opts.side),
      safe(opts.reason),
      num(opts.edgeUp),
      num(opts.edgeDown),
      num(opts.askUp),
      num(opts.askDown),
      num(opts.remainingMin),
      num(opts.oraclePrice),
      num(opts.binancePrice),
      num(opts.priceToBeat),
      num(opts.modelUp),
      num(opts.modelDown)
    ].join(",") + "\n";
    fs.appendFileSync(SIGNALS_FILE, exists ? line : HEADER + line);
  } catch (err) {
    console.error("[SIGNAL_LOG]", err.message);
  }
}
