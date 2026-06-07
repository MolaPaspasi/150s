import fs from "fs";
import path from "path";
import { fetchMarketBySlug } from "./data/polymarket.js";

// Use arguments or defaults
const WALLET = process.argv[2] || "0x63ce342161250d705dc0b16df89036c8e5f9ba9a";
const LIMIT = 500;
const OUTPUT_FILE = process.argv[3] || "logs/whale_analysis.csv";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchTrades(wallet) {
    console.log(`Fetching last ${LIMIT} trades for ${wallet}...`);
    const url = `https://data-api.polymarket.com/trades?user=${wallet}&limit=${LIMIT}`;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.error("Failed to fetch trades:", e.message);
        return [];
    }
}

async function analyze() {
    // Check if output dir exists
    if (!fs.existsSync("logs")) fs.mkdirSync("logs");

    const trades = await fetchTrades(WALLET);
    if (!trades || trades.length === 0) {
        console.log("No trades found.");
        return;
    }

    console.log(`Fetched ${trades.length} trades.`);

    // Get unique market slugs to fetch details
    const slugs = [...new Set(trades.map(t => t.slug))];
    console.log(`Found ${slugs.length} unique markets.`);

    const marketCache = {};
    let processedSlugs = 0;

    // Fetch market details
    for (const slug of slugs) {
        if (!slug) continue;
        if (marketCache[slug]) continue;

        try {
            const market = await fetchMarketBySlug(slug);
            if (market) marketCache[slug] = market;

            processedSlugs++;
            process.stdout.write(`\rFetching market details: ${processedSlugs}/${slugs.length}`);
            await sleep(100);
        } catch (e) {
            // Ignore errors for individual markets
        }
    }
    console.log("\nMarket details fetched.");

    // CSV Header
    const headers = [
        "Time", "Slug", "Side", "Outcome", "Price", "Size", "Value($)",
        "EndWait(min)", "MarketEnd", "ApproxResult", "TxHash"
    ];
    const rows = [headers.join(",")];

    const uniqueHashes = new Set();

    for (const trade of trades) {
        if (trade.transactionHash) uniqueHashes.add(trade.transactionHash);
        const market = marketCache[trade.slug];

        const ts = trade.timestamp * 1000;
        const dateStr = new Date(ts).toISOString();
        const price = parseFloat(trade.price || 0);
        const size = parseFloat(trade.size || 0);
        const value = (price * size).toFixed(2);

        let endWaitMin = "N/A";
        let endDateStr = "N/A";
        let result = "Unknown";

        if (market && market.endDate) {
            // "endDate" in API is usually ISO string
            const endTs = new Date(market.endDate).getTime();
            // Calculate minutes between trade and market end
            // Negative means trade happened *after* end? (impossible unless bug)
            // Positive means trade happened *before* end.
            const diffMs = endTs - ts;
            endWaitMin = (diffMs / 60000).toFixed(1);
            endDateStr = market.endDate;

            // Try to guess result
            // If market is closed, we need winner.
            // In basic `fetchMarketBySlug` (gamma-api), winner might not be populated directly in simple object
            // But let's assume if it ended > 24h ago, we can't easily know without checking resolution.
            // For now, leave result as Unknown or analyze manually.
        }

        rows.push([
            dateStr, trade.slug, trade.side, trade.outcome, price, size, value,
            endWaitMin, endDateStr, result, trade.transactionHash || ""
        ].join(","));
    }

    fs.writeFileSync(OUTPUT_FILE, rows.join("\n"));
    console.log(`Analysis saved to ${OUTPUT_FILE}`);
    console.log(`Summary: ${trades.length} fills (execution parts) across ${uniqueHashes.size} unique transactions.`);
}

analyze();
