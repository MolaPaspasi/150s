import { CONFIG } from "../config.js";

export class WhaleWatcher {
    constructor(wallets) {
        this.wallets = wallets || [];
        this.wallets = wallets || [];
        this.startTime = Date.now() - (30 * 1000); // Look back 30 seconds on startup to catch very recent trades
        this.processedHashes = new Set();
        this.marketSlugPrefix = (CONFIG.polymarket.seriesSlug || "").replace(/-15m.*$/, "");
    }

    async checkActivity() {
        if (this.wallets.length === 0) return null;

        const signals = [];

        for (const wallet of this.wallets) {
            try {
                // Fetch recent trades (limit 10 to be safe against rapid HFT activity)
                const url = `https://data-api.polymarket.com/trades?user=${wallet}&limit=10`;
                const res = await fetch(url);

                if (!res.ok) continue;

                const trades = await res.json();
                if (!Array.isArray(trades)) continue;

                // Process from oldest to newest to maintain order, or just filter
                for (const trade of trades) {
                    const tradeTime = trade.timestamp * 1000;

                    // 1. Time Filter: strict check against startup time ONLY
                    // We rely on processedHashes for ongoing deduplication.
                    // This fixes the bug where API lag caused missed trades.
                    if (tradeTime < this.startTime) continue;

                    // 2. Side Filter: Only Copy BUYS
                    if (trade.side !== "BUY") continue;

                    // 3. Deduplication
                    if (this.processedHashes.has(trade.transactionHash)) continue;
                    this.processedHashes.add(trade.transactionHash); // Mark as seen

                    // 4. Market Relevance
                    // Accept any crypto up/down market (BTC, ETH, SOL, etc.)
                    const slug = (trade.slug || "").toLowerCase();
                    if (!slug.includes("up") && !slug.includes("down")) continue;

                    // Determine outcome side clearly
                    let side = null;
                    const outcome = (trade.outcome || "").toUpperCase();
                    if (outcome === "UP" || outcome === "YES") side = "UP";
                    if (outcome === "DOWN" || outcome === "NO") side = "DOWN";

                    if (!side) continue;

                    // Create Signal
                    const signal = {
                        type: "COPY",
                        wallet: wallet,
                        side: side,
                        marketSlug: trade.slug,
                        asset: trade.asset,
                        price: parseFloat(trade.price),
                        size: parseFloat(trade.size),
                        timestamp: tradeTime,
                        hash: trade.transactionHash,
                        originalOutcome: trade.outcome
                    };

                    signals.push(signal);
                }
            } catch (e) {
                console.error(`WhaleWatcher error for ${wallet}:`, e.message);
            }
        }

        // cleanup old hashes to prevent memory leak
        if (this.processedHashes.size > 2000) {
            // Keep the last 1000 (simplified clear for now)
            this.processedHashes.clear();
            // Reset start time to now to avoid re-reading old history if we cleared hashes
            this.startTime = Date.now() - 10000;
        }

        // Sort by timestamp desc to return latest signal?
        // Actually, returning the *first* detected signal is fine, bot loop handles one by one.
        // But usually we want to execute them all. 
        // The current structure returns only ONE signal per checkActivity call.
        // To handle HFT, we might want to return ALL?
        // But `index.js` expects a single signal.
        // Let's sort oldest first (to execute in order)? 
        // Original code returned signals[0].
        // Let's sort by timestamp ASCENDING so we execute the oldest missed trade first.
        signals.sort((a, b) => a.timestamp - b.timestamp);

        return signals.length > 0 ? signals[0] : null;
    }
}
