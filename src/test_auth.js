import { TradingEngine } from "./engines/trading.js";
import { CONFIG } from "./config.js";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";

async function testAuth() {
    applyGlobalProxyFromEnv();
    console.log("=== Polymarket Bot Auth Test ===");
    console.log("Current Config:");
    console.log("- Trading Enabled:", CONFIG.trading.enabled);
    console.log("- Amount:", CONFIG.trading.amountUsdc, "USDC");
    console.log("- Private Key Set:", !!CONFIG.trading.privateKey);
    console.log("- API Key Set:", !!CONFIG.trading.apiKey);

    const trader = new TradingEngine();
    const initSuccess = await trader.init();

    if (!initSuccess) {
        console.error("❌ Authentication failed during initialization.");
        return;
    }

    console.log("✅ Initialization successful.");

    console.log("Fetching balance...");
    const balance = await trader.getBalance();

    if (balance !== null) {
        console.log(`✅ Balance fetched: ${balance} USDC`);
    } else {
        console.error("❌ Failed to fetch balance.");
    }

    console.log("=== Test Complete ===");
}

testAuth().catch(err => {
    console.error("Unexpected error during test:", err);
});
