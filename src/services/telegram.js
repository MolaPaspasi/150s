import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

let bot = null;
let _tradingPaused = false;

export function isTradingPaused() {
  return _tradingPaused;
}

export function initTelegram() {
  if (!TOKEN || !CHAT_ID) return;
  try {
    bot = new TelegramBot(TOKEN, { polling: true });
    bot.on("polling_error", (err) => {
      console.error("[Telegram] Polling error:", err.code || err.message);
    });
    console.log("[Telegram] Bot initialized");
    _registerCommands();
  } catch (e) {
    console.error("[Telegram] Init failed:", e.message);
  }
}

let _getState = null;
export function registerStateProvider(fn) {
  _getState = fn;
}

function _registerCommands() {
  bot.onText(/\/stop/, () => {
    _tradingPaused = true;
    send(`🛑 *Trading PAUSED*\nNo new trades will be placed.\nSend /start to resume.`);
  });

  bot.onText(/\/start/, () => {
    _tradingPaused = false;
    send(`✅ *Trading RESUMED*\nBot is active again.`);
  });

  bot.onText(/\/balance/, () => {
    if (!_getState) return;
    const state = _getState();
    const realBal = state.realBalance;
    const balLine = realBal != null ? `💵 USDC: $${realBal.toFixed(2)}` : `💵 USDC: —`;
    const lines = Object.entries(state.bots).map(([name, b]) => {
      const total = b.stats.wins + b.stats.losses;
      const wr = total > 0 ? ` ${((b.stats.wins / total) * 100).toFixed(0)}% WR` : "";
      return `${name}: ${b.stats.wins}W / ${b.stats.losses}L${wr}`;
    });
    const status = _tradingPaused ? "🛑 PAUSED" : "✅ ACTIVE";
    send(`💰 *Balance* [${status}]\n${balLine}\n\n${lines.join("\n")}`);
  });

  bot.onText(/\/trades/, () => {
    if (!_getState) return;
    const state = _getState();
    const open = [];
    for (const [name, b] of Object.entries(state.bots)) {
      b.stats.trades.filter(t => !t.settled).forEach(t => {
        open.push(`${name} ${t.side} @ $${t.askPrice?.toFixed(3)} — ${t.shares} shares (${t.type})`);
      });
    }
    if (open.length === 0) send("📭 No open positions");
    else send(`📂 *Open Positions*\n${open.join("\n")}`);
  });

  bot.onText(/\/stats/, () => {
    if (!_getState) return;
    const state = _getState();
    let totalPnl = 0;
    const lines = Object.entries(state.bots).map(([name, b]) => {
      const total = b.stats.wins + b.stats.losses;
      const wr = total > 0 ? ((b.stats.wins / total) * 100).toFixed(0) : "—";
      const pnl = (b.stats.trades || []).filter(t => t.settled && t.result).reduce((sum, t) => {
        if (t.result === "WIN") return sum + ((t.shares || 0) * 1.0 - (t.amount || 0));
        return sum - (t.amount || 0);
      }, 0);
      totalPnl += pnl;
      const pnlStr = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
      return `${name}: ${b.stats.wins}W/${b.stats.losses}L (${wr}% WR) | ${pnlStr}`;
    });
    const totalStr = `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`;
    const status = _tradingPaused ? "🛑 PAUSED" : "✅ ACTIVE";
    send(`📊 *Stats* [${status}]\n${lines.join("\n")}\n\nTotal P&L: ${totalStr}`);
  });

  bot.onText(/\/analyze/, () => {
    if (!_getState) return;
    const state = _getState();
    const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const status = _tradingPaused ? "🛑 PAUSED" : "✅ ACTIVE";
    const realBal = state.realBalance != null ? `$${state.realBalance.toFixed(2)}` : "—";

    // --- Per-asset breakdown ---
    const typeTotals = {};
    let grandW = 0, grandL = 0, grandPnl = 0;

    const assetLines = Object.entries(state.bots).map(([name, b]) => {
      const trades = b.stats.trades || [];
      const settled = trades.filter(t => t.settled && t.result);
      const w = b.stats.wins || 0;
      const l = b.stats.losses || 0;
      const total = w + l;
      const wr = total > 0 ? `${((w / total) * 100).toFixed(0)}%` : " — ";
      const pnl = settled.reduce((s, t) => {
        if (t.result === "WIN") return s + ((t.shares || 0) - (t.amount || 0));
        return s - (t.amount || 0);
      }, 0);
      grandW += w; grandL += l; grandPnl += pnl;

      // accumulate by type
      for (const t of settled) {
        const ty = t.type || "SNIPE";
        if (!typeTotals[ty]) typeTotals[ty] = { w: 0, l: 0, pnl: 0 };
        if (t.result === "WIN") { typeTotals[ty].w++; typeTotals[ty].pnl += (t.shares || 0) - (t.amount || 0); }
        else { typeTotals[ty].l++; typeTotals[ty].pnl -= (t.amount || 0); }
      }

      const openCount = trades.filter(t => !t.settled).length;
      const openTag = openCount > 0 ? ` [${openCount} open]` : "";
      const frozenTag = b.stats.frozen5m ? " ❄️5m" : (b.stats.consecLosses5m > 0 ? ` ⚠️${b.stats.consecLosses5m}L5m` : "");
      const pnlStr = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
      return `${name.padEnd(4)} ${String(w).padStart(2)}W ${String(l).padStart(2)}L ${wr.padStart(4)} | ${pnlStr}${openTag}${frozenTag}`;
    });

    // --- By type ---
    const typeLines = Object.entries(typeTotals).map(([ty, v]) => {
      const t = v.w + v.l;
      const wr = t > 0 ? `${((v.w / t) * 100).toFixed(0)}%` : " — ";
      return `${ty.padEnd(10)} ${v.w}W/${v.l}L ${wr.padStart(4)} | ${v.pnl >= 0 ? "+" : ""}$${v.pnl.toFixed(2)}`;
    });
    if (typeLines.length === 0) typeLines.push("(no settled trades yet)");

    // --- Open positions ---
    const openLines = [];
    for (const [name, b] of Object.entries(state.bots)) {
      (b.stats.trades || []).filter(t => !t.settled).forEach(t => {
        const rem = t.endMs ? Math.max(0, (t.endMs - Date.now()) / 60000) : null;
        const remStr = rem != null ? ` ${rem.toFixed(0)}min left` : "";
        openLines.push(`${name} ${t.side} @ $${t.askPrice?.toFixed(3)} | ${t.shares}sh | $${t.amount?.toFixed(2)} [${t.type}]${remStr}`);
      });
    }

    // --- Last 10 settled trades (newest first) ---
    const allSettled = [];
    for (const [name, b] of Object.entries(state.bots)) {
      (b.stats.trades || []).filter(t => t.settled && t.result).forEach(t => allSettled.push({ name, ...t }));
    }
    // Sort by array order (newest last → reverse)
    const recentTrades = allSettled.slice(-10).reverse().map(t => {
      const icon = t.result === "WIN" ? "✅" : "❌";
      return `${icon} ${t.name} ${t.type?.replace("_", " ")} ${t.side} $${t.askPrice?.toFixed(3)} ${t.shares}sh $${t.amount?.toFixed(2)}`;
    });

    // --- Modules (read from env) ---
    const modules = [];
    const sniperOn  = process.env.ENABLE_SNIPER !== "false";
    const sniper5mOn = process.env.ENABLE_5M_SNIPER === "true";
    const whaleOn   = process.env.WHALE_STYLE_ENABLED === "true";
    const kellyOn   = process.env.TRADING_USE_KELLY === "true";
    const assets    = (process.env.ACTIVE_ASSETS || "BTC").toUpperCase();
    const tradeAmt  = process.env.TRADE_AMOUNT_USDC || "?";
    modules.push(`Sniper 15m: ${sniperOn ? "✅" : "❌"}  Sniper 5m: ${sniper5mOn ? "✅" : "❌"}  Whale: ${whaleOn ? "✅" : "❌"}  Kelly: ${kellyOn ? "✅" : "❌"}`);
    modules.push(`Assets: ${assets}  |  Trade: $${tradeAmt}/trade`);

    // --- Grand total ---
    const grandTotal = grandW + grandL;
    const grandWr = grandTotal > 0 ? `${((grandW / grandTotal) * 100).toFixed(0)}%` : "—";
    const grandPnlStr = `${grandPnl >= 0 ? "+" : ""}$${grandPnl.toFixed(2)}`;

    const msg1 = [
      `🔬 *ANALYZE* — ${now}`,
      `💵 Balance: ${realBal}  [${status}]`,
      ``,
      `*── PER ASSET ──*`,
      "```",
      ...assetLines,
      "```",
      ``,
      `*── BY TYPE ──*`,
      "```",
      ...typeLines,
      "```",
    ].join("\n");

    const msg2 = [
      openLines.length ? `*── OPEN (${openLines.length}) ──*\n${openLines.join("\n")}` : `*── OPEN ──*\n(none)`,
      ``,
      `*── LAST ${recentTrades.length} TRADES ──*`,
      recentTrades.length ? recentTrades.join("\n") : "(none)",
      ``,
      `*── MODULES ──*`,
      modules.join("\n"),
      ``,
      `*TOTAL: ${grandW}W/${grandL}L | ${grandWr} WR | P&L: ${grandPnlStr}*`,
    ].join("\n");

    send(msg1);
    send(msg2);
  });

  bot.onText(/\/help/, () => {
    send(`*Hadi Bot Commands*\n/stop — pause all trading\n/start — resume trading\n/balance — P&L per asset\n/trades — open positions\n/stats — win rate per asset\n/analyze — full diagnostic dump`);
  });
}

function send(text) {
  if (!bot || !CHAT_ID) return;
  bot.sendMessage(CHAT_ID, text, { parse_mode: "Markdown" }).catch(() => {});
}

export function notifyTrade({ asset, side, price, amount, shares, type }) {
  const emoji = side === "UP" ? "🟢" : "🔴";
  send(`${emoji} *${asset} ${side}* [${type}]\nPrice: $${price?.toFixed(3)} | Size: $${amount?.toFixed(2)} | Shares: ${shares}`);
}

export function notifyResult({ asset, side, result, pnl, type, reason }) {
  const emoji = result === "WIN" ? "✅" : "❌";
  const reasonStr = reason ? ` (${reason})` : "";
  send(`${emoji} *${asset} ${side} — ${result}*${reasonStr}\nP&L: ${pnl >= 0 ? "+" : ""}$${pnl?.toFixed(2)} [${type}]`);
}

export function notifyWarn(message) {
  send(`⚠️ *Warning*\n${message}`);
}

export function notifyLoss({ asset, side, type, entryPrice, shares, amount, finalPrice, pnl }) {
  const dir = side === "UP" ? "📈 UP" : "📉 DOWN";
  const move = finalPrice != null && entryPrice != null
    ? ` → $${finalPrice.toFixed(4)} (${finalPrice > entryPrice ? "+" : ""}${((finalPrice - entryPrice) / entryPrice * 100).toFixed(2)}%)`
    : "";
  send(
    `❌ *LOSS — ${asset} ${dir}* [${type}]\n` +
    `Entry: $${entryPrice?.toFixed(3)} | Shares: ${shares} | Cost: $${amount?.toFixed(2)}\n` +
    `Final price: $${finalPrice?.toFixed(4)}${move}\n` +
    `P&L: -$${Math.abs(pnl ?? amount)?.toFixed(2)}`
  );
}

export function notifyPositionClosed({ asset, side, reason, pnl }) {
  const emoji = pnl >= 0 ? "✅" : "🛑";
  send(`${emoji} *${asset} ${side} closed early*\nReason: ${reason}\nP&L: ${pnl >= 0 ? "+" : ""}$${pnl?.toFixed(2)}`);
}

export function notifyBalanceFloor(balance, floor) {
  send(`🚨 *TRADING STOPPED*\nBalance $${balance?.toFixed(2)} hit the $${floor} floor.\nSend /start to resume.`);
}

export function notifyDailySummary(bots) {
  let totalPnl = 0;
  const lines = Object.entries(bots).map(([name, b]) => {
    const total = b.stats.wins + b.stats.losses;
    const wr = total > 0 ? ((b.stats.wins / total) * 100).toFixed(0) : "—";
    const pnl = (b.stats.trades || []).filter(t => t.settled && t.result).reduce((sum, t) => {
      if (t.result === "WIN") return sum + ((t.shares || 0) * 1.0 - (t.amount || 0));
      return sum - (t.amount || 0);
    }, 0);
    totalPnl += pnl;
    return `${name}: ${b.stats.wins}W/${b.stats.losses}L (${wr}%) | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
  });
  send(`📅 *Daily Summary*\n${lines.join("\n")}\n\nTotal: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`);
}
