import { ClobClient } from "@polymarket/clob-client-v2";
import { ethers } from "ethers";
import { CONFIG } from "./config.js";
import * as dotenv from "dotenv";
dotenv.config();

async function deriveKeys() {
    console.log("=== Polymarket API Key Derivation Tool ===");

    const privateKey = process.env.PRIVATE_KEY;

    if (!privateKey) {
        console.error("❌ Error: PRIVATE_KEY not found in .env file.");
        console.log("Please add your private key to .env first.");
        return;
    }

    try {
        const wallet = new ethers.Wallet(privateKey.trim());

        // Ethers v6 vs v5 shim for older SDKs
        if (typeof wallet._signTypedData !== 'function' && typeof wallet.signTypedData === 'function') {
            wallet._signTypedData = wallet.signTypedData.bind(wallet);
        }

        console.log("Wallet Address:", wallet.address);

        // Initialize client with just the wallet to derive keys
        const client = new ClobClient({
            host: CONFIG.clobBaseUrl,
            chain: 137, // Polygon Mainnet
            signer: wallet,
        });

        console.log("Deriving/Creating API Keys... (This might take a few seconds)");
        const apiKeys = await client.createOrDeriveApiKey();

        console.log("\n✅ SUCCESS! Copy these values into your .env file:\n");
        console.log(`POLY_API_KEY=${apiKeys.key}`);
        console.log(`POLY_API_SECRET=${apiKeys.secret}`);
        console.log(`POLY_API_PASSPHRASE=${apiKeys.passphrase}`);
        console.log("\n===========================================");
    } catch (error) {
        console.error("❌ Failed to derive keys:", error.message);
    }
}

deriveKeys();
