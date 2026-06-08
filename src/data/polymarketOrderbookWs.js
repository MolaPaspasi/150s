import WebSocket from "ws";
import { CONFIG } from "../config.js";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const RECONNECT_INTERVAL = 3000;
const TOKEN_TTL_MS = 20 * 60 * 1000; // 20 min — closed markets stop updating

class PolymarketOrderbookWs {
    constructor() {
        this.ws = null;
        this.cache = {}; // Map<tokenId, { bestBid, bestAsk, lastUpdate, subscribedAt }>
        this.subscribedTokens = new Set();
        this.reconnectTimer = null;
        this.pingInterval = null;
        this.cleanupInterval = null;
        this.onBookUpdate = null; // optional: (tokenId, { bestBid, bestAsk }) => void
    }

    start() {
        this.connect();
        // Purge every 30 minutes — removes tokens not updated in TOKEN_TTL_MS
        this.cleanupInterval = setInterval(() => this._purgeStale(), 30 * 60 * 1000);
    }

    _purgeStale() {
        const cutoff = Date.now() - TOKEN_TTL_MS;
        let purged = 0;

        // Purge tokens that have cache entries but no recent update
        for (const [tokenId, entry] of Object.entries(this.cache)) {
            if (entry.lastUpdate < cutoff) {
                delete this.cache[tokenId];
                this.subscribedTokens.delete(tokenId);
                purged++;
            }
        }

        // Also purge subscribed tokens that never received any data
        for (const tokenId of this.subscribedTokens) {
            if (!this.cache[tokenId]) {
                const subscribed = this._subscribeTime?.get(tokenId) ?? 0;
                if (subscribed < cutoff) {
                    this.subscribedTokens.delete(tokenId);
                    this._subscribeTime?.delete(tokenId);
                    purged++;
                }
            }
        }

        if (purged > 0) {
            console.log(`[Poly WS] Purged ${purged} stale tokens (active: ${this.subscribedTokens.size})`);
        }
    }

    connect() {
        try {
            this.ws = new WebSocket(WS_URL);

            this.ws.on("open", () => {
                console.log("[Poly WS] Connected to CLOB Orderbook Stream");
                this.resubscribe();
                this.startPing();
            });

            this.ws.on("message", (data) => {
                const raw = typeof data === "string" ? data : data.toString();
                const trimmed = raw.trim();
                if (!trimmed) return;

                const lower = trimmed.toLowerCase();
                if (lower === "ping") {
                    try { this.ws.send("pong"); } catch {}
                    return;
                }
                if (lower === "pong") return;

                if (trimmed === "INVALID OPERATION" || trimmed.startsWith("INVALID")) {
                    if (!this._loggedInvalid) {
                        this._loggedInvalid = true;
                        console.warn("[Poly WS] Server sent:", trimmed, "(ignored; subscription format may have changed)");
                    }
                    return;
                }
                try {
                    const msg = JSON.parse(trimmed);
                    this._loggedInvalid = false;
                    this.handleMessage(msg);
                } catch (e) {
                    console.error("[Poly WS] Parse error:", e.message, "raw:", trimmed.slice(0, 80));
                }
            });

            this.ws.on("close", () => {
                console.log("[Poly WS] Disconnected. Reconnecting in 3s...");
                this.stopPing();
                this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_INTERVAL);
            });

            this.ws.on("error", (err) => {
                console.error("[Poly WS] Error:", err.message);
                this.ws.close();
            });

        } catch (e) {
            console.error("[Poly WS] Connection failed:", e.message);
            this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_INTERVAL);
        }
    }

    subscribe(tokenIds) {
        if (!this._subscribeTime) this._subscribeTime = new Map();

        const newTokens = tokenIds.filter(id => !this.subscribedTokens.has(id));
        if (newTokens.length === 0) return;

        const now = Date.now();
        newTokens.forEach(id => {
            this.subscribedTokens.add(id);
            this._subscribeTime.set(id, now);
        });

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const msg = { assets_ids: newTokens, type: "market", custom_feature_enabled: true };
        console.log("[Poly WS] Sending Subscription:", JSON.stringify(msg));
        this.ws.send(JSON.stringify(msg));
        console.log(`[Poly WS] Subscribed to ${newTokens.length} tokens`);
    }

    resubscribe() {
        if (this.subscribedTokens.size > 0) {
            const tokens = Array.from(this.subscribedTokens);
            const msg = { assets_ids: tokens, type: "market", custom_feature_enabled: true };
            console.log("[Poly WS] Sending Resubscription:", JSON.stringify(msg));
            this.ws.send(JSON.stringify(msg));
            console.log(`[Poly WS] Resubscribed to ${tokens.length} tokens`);
        }
    }

    handleMessage(msg) {
        const updates = Array.isArray(msg) ? msg : [msg];

        for (const update of updates) {
            if (update.event_type === "book" || update.eventType === "book") {
                const tokenId = update.asset_id || update.market;
                if (!tokenId) continue;

                let bestBid = null;
                let bestAsk = null;

                const bids = update.bids || update.buys;
                const asks = update.asks || update.sells;
                if (bids && bids.length > 0) {
                    const price = parseFloat(bids[0].price);
                    if (!isNaN(price)) bestBid = price;
                }
                if (asks && asks.length > 0) {
                    const price = parseFloat(asks[0].price);
                    if (!isNaN(price)) bestAsk = price;
                }

                if (bestBid !== null || bestAsk !== null) {
                    const current = this.cache[tokenId] || { bestBid: null, bestAsk: null, subscribedAt: Date.now() };
                    if (bestBid !== null) current.bestBid = bestBid;
                    if (bestAsk !== null) current.bestAsk = bestAsk;
                    current.lastUpdate = Date.now();
                    this.cache[tokenId] = current;
                    if (this.onBookUpdate) {
                        try { this.onBookUpdate(tokenId, { bestBid: current.bestBid, bestAsk: current.bestAsk }); } catch {}
                    }
                }
            }
        }
    }

    getBestPrices(tokenId) {
        return this.cache[tokenId] || null;
    }

    startPing() {
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send("ping");
            }
        }, 20000);
    }

    stopPing() {
        if (this.pingInterval) clearInterval(this.pingInterval);
    }
}

export const polyOrderbookWs = new PolymarketOrderbookWs();
