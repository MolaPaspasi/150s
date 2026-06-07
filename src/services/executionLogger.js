import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "execution_log.csv");
const HEADER = "timestamp,type,slug,side,price,amount_usdc,mid_price,extra\n";

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Log an execution attempt (before sending order) for analysis and slippage tracking.
 * mid_price: (bestBid+bestAsk)/2 at order time for fill-quality analysis (Roan: positive = good fill).
 * @param {Object} opts
 * @param {string} opts.type - "ARB" | "WHALE_STYLE" | "SNIPE" | "COPY"
 * @param {string} opts.slug - market slug
 * @param {string} opts.side - "UP" | "DOWN" | "BOTH"
 * @param {number} opts.price - limit/ask price (or totalCost for ARB)
 * @param {number} opts.amountUsdc - amount in USDC
 * @param {number} [opts.midPrice] - mid at order time (for fill quality)
 * @param {string} [opts.extra] - JSON or string (e.g. askUp,askDown for arb)
 */
export function logExecution(opts) {
  try {
    ensureLogDir();
    const exists = fs.existsSync(LOG_FILE);
    const mid = opts.midPrice != null && Number.isFinite(opts.midPrice) ? opts.midPrice.toFixed(4) : "";
    const line = [
      new Date().toISOString(),
      opts.type || "",
      (opts.slug || "").replace(/,/g, ";"),
      opts.side || "",
      typeof opts.price === "number" ? opts.price.toFixed(4) : "",
      typeof opts.amountUsdc === "number" ? opts.amountUsdc.toFixed(2) : "",
      mid,
      (opts.extra != null ? String(opts.extra) : "").replace(/,/g, ";").replace(/\n/g, " ")
    ].join(",") + "\n";
    fs.appendFileSync(LOG_FILE, exists ? line : HEADER + line);
  } catch (err) {
    console.error("[EXEC_LOG]", err.message);
  }
}

/**
 * Log arbitrage execution with both legs' prices (for later slippage analysis).
 */
export function logArbExecution(opportunity, targetShares, amountUsdc) {
  const d = opportunity?.details;
  const extra = d
    ? `askUp=${d.askUp?.toFixed(4)} askDown=${d.askDown?.toFixed(4)} profit=${d.projectedProfit?.toFixed(4)}`
    : "";
  logExecution({
    type: "ARB",
    slug: opportunity?.slug ?? "",
    side: "BOTH",
    price: d?.totalCost,
    amountUsdc,
    extra
  });
}
