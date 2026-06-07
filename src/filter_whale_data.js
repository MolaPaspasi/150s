import fs from "fs";

const CSV_FILE = process.argv[2] || "logs/whale_analysis.csv";
const OUTPUT_FILE = process.argv[3] || "logs/whale_crypto_only.csv";
const CRYPTO_KEYWORDS = ["btc", "eth", "sol", "xrp", "bitcoin", "ethereum", "solana", "ripple", "pol", "matic", "doge", "shib", "pepe", "wif", "bonk", "link", "avax", "bnb", "crypto"];

function filter() {
    if (!fs.existsSync(CSV_FILE)) {
        console.error("CSV file not found.");
        return;
    }

    const content = fs.readFileSync(CSV_FILE, "utf-8");
    const lines = content.split("\n");
    const header = lines[0];
    const dataLines = lines.slice(1);

    const cryptoTrades = dataLines.filter(line => {
        if (!line.trim()) return false;
        const columns = line.split(",");
        const slug = columns[1].toLowerCase();
        return CRYPTO_KEYWORDS.some(k => slug.includes(k));
    });

    const uniqueHashes = new Set();
    cryptoTrades.forEach(line => {
        const columns = line.split(",");
        // TxHash is likely the last column now
        const txHash = columns[columns.length - 1];
        if (txHash && txHash.startsWith("0x")) uniqueHashes.add(txHash);
    });

    console.log(`Total Trades (All): ${dataLines.length}`);
    console.log(`Crypto Trades: ${cryptoTrades.length}`);
    console.log(`Unique Crypto Transactions: ${uniqueHashes.size}`);

    // Save filtered CSV for inspection
    fs.writeFileSync(OUTPUT_FILE, [header, ...cryptoTrades].join("\n"));
    console.log(`Saved filtered data to ${OUTPUT_FILE}`);
}

filter();
