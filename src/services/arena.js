const BASE_URL = "https://gzydspfquuaudqeztorw.supabase.co/functions/v1/agent-api";

/**
 * Arena paper trading client.
 * Mirrors real trade decisions to the PolymarketScan Arena simulator.
 * Set ARENA_AGENT_ID in .env to enable. Safe to leave empty — all calls no-op.
 */
export class ArenaClient {
  constructor(agentId) {
    this.agentId = agentId || "";
    this.enabled = !!this.agentId;
  }

  /**
   * Mirror a trade to the Arena.
   * @param {Object} params
   * @param {string} params.marketId  - Polymarket condition ID (market.conditionId)
   * @param {string} params.side      - "UP" or "DOWN" (converted to YES/NO for Arena)
   * @param {number} params.amount    - USD amount
   * @param {number} [params.fairValue] - Model probability (0-1), shown publicly
   */
  async placeOrder({ marketId, side, amount, fairValue }) {
    if (!this.enabled || !marketId || !amount || amount <= 0) return;

    try {
      const body = {
        agent_id: this.agentId,
        market_id: marketId,
        side: side === "UP" ? "YES" : "NO",
        amount: Math.round(amount * 100) / 100,
        action: "BUY"
      };

      if (fairValue != null && Number.isFinite(fairValue)) {
        body.fair_value = Math.round(fairValue * 1000) / 1000;
      }

      const res = await fetch(`${BASE_URL}?action=place_order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const json = await res.json();
      if (json.ok) {
        const d = json.data;
        console.log(`[Arena] ✅ ${side} $${amount.toFixed(2)} @ ${d?.price?.toFixed(3) ?? "?"} | balance: $${d?.remaining_balance?.toFixed(2) ?? "?"}`);
      } else {
        console.log(`[Arena] ⚠ order rejected: ${json.error}`);
      }
    } catch {
      // Arena is non-critical — never let it break the real bot
    }
  }

  /** Fetch and log current Arena portfolio stats. */
  async logPortfolio() {
    if (!this.enabled) return;
    try {
      const res = await fetch(`${BASE_URL}?action=my_portfolio&agent_id=${encodeURIComponent(this.agentId)}`);
      const json = await res.json();
      if (json.ok) {
        const d = json.data;
        console.log(`[Arena] Portfolio: $${d.portfolio_value?.toFixed(2)} | PnL: $${d.portfolio_value - 1000 >= 0 ? "+" : ""}${(d.portfolio_value - 1000).toFixed(2)} | Trades: ${d.total_trades}`);
      }
    } catch {
      // non-critical
    }
  }
}
