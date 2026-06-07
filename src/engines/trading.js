import { ClobClient, AssetType } from "@polymarket/clob-client-v2";
import { ethers } from "ethers";
import { CONFIG } from "../config.js";

export class TradingEngine {
    constructor() {
        this.client = null;
        this.wallet = null;
        this.initialized = false;
    }

    async init() {
        if (!CONFIG.trading.privateKey || !CONFIG.trading.apiKey) {
            console.error("Trading Engine: Missing API keys or Private Key in .env");
            return false;
        }

        try {
            this.wallet = new ethers.Wallet(CONFIG.trading.privateKey.trim());

            // Ethers v6 vs v5 shim for older SDKs
            if (typeof this.wallet._signTypedData !== 'function' && typeof this.wallet.signTypedData === 'function') {
                this.wallet._signTypedData = this.wallet.signTypedData.bind(this.wallet);
            }

            const creds = {
                key: CONFIG.trading.apiKey.trim(),
                secret: CONFIG.trading.apiSecret.trim(),
                passphrase: CONFIG.trading.apiPassphrase.trim(),
            };

            // 0x731c... is a Gnosis Safe v1.3.0 — use signatureType=2 (EIP-1271)
            // MetaMask (0xAC0d...) is an owner of the Safe and signs on its behalf.
            const proxyAddress = (process.env.POLY_PROXY_ADDRESS || "").trim();
            const signatureType = proxyAddress ? 2 : 0;

            this.client = new ClobClient({
                host: CONFIG.clobBaseUrl,
                chain: 137, // Polygon Mainnet
                signer: this.wallet,
                creds,
                signatureType,
                funderAddress: proxyAddress || undefined,
            });

            this.initialized = true;
            console.log(`Trading Engine: Initialized successfully (signatureType=${signatureType}, proxy=${proxyAddress || "none"})`);
            return true;
        } catch (error) {
            console.error("Trading Engine: Initialization failed", error.message);
            return false;
        }
    }

    async getBalance() {
        if (!this.initialized) return null;
        try {
            const result = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            if (result && result.balance !== undefined) {
                const raw = parseFloat(result.balance);
                // CLOB API returns balance in USDC base units (6 decimals) — convert to dollars
                return raw > 1_000_000 ? raw / 1_000_000 : raw;
            }
            throw new Error("No balance in response");
        } catch (error) {
            if (error.response?.status === 401) {
                console.error("Trading Engine: Auth Error (401).");
            } else {
                console.error("Trading Engine: Balance fetch failed", error.message);
            }
            return null;
        }
    }

    async executeTrade(tokenId, outcome, amountUsdc, makerOnly = false, suggestedPrice = null) {
        if (!this.initialized || !CONFIG.trading.enabled) {
            console.log(`[DRY RUN] Would have traded ${outcome} (Token: ${tokenId}) for ${amountUsdc} USDC${makerOnly ? " (MAKER)" : ""}${suggestedPrice ? ` @ $${suggestedPrice}` : ""}`);
            return { success: true, dryRun: true };
        }

        if (!tokenId) {
            console.error("Trading Engine: Missing Token ID for trade");
            return { success: false, error: "Missing Token ID" };
        }

        try {
            console.log(`Executing trade: ${outcome} (Token: ${tokenId}) for ${amountUsdc} USDC${makerOnly ? " (MAKER)" : ""}${suggestedPrice ? ` @ suggested $${suggestedPrice}` : ""}`);

            // 1. Get current market price from orderbook to set a limit order
            const orderbook = await this.client.getOrderBook(tokenId);
            const askPrices = (orderbook.asks || []).map(a => parseFloat(a.price)).filter(p => p > 0);
            const bidPrices = (orderbook.bids || []).map(b => parseFloat(b.price)).filter(p => p > 0);
            const bestAsk = askPrices.length ? Math.min(...askPrices) : null;
            const bestBid = bidPrices.length ? Math.max(...bidPrices) : null;

            if (!bestAsk) {
                throw new Error("No liquidity available on the ask side");
            }

            let limitPrice;
            if (makerOnly && bestBid) {
                // If we have a suggestedPrice from the engine, try to use it
                // but cap it between (bestBid + 0.001) and (bestAsk - 0.002) for safety.
                const floorPrice = bestBid + 0.001;
                const ceilingPrice = bestAsk - 0.002;

                if (suggestedPrice !== null) {
                    limitPrice = Math.min(Math.max(suggestedPrice, floorPrice), ceilingPrice);
                } else {
                    limitPrice = floorPrice;
                }

                limitPrice = Math.max(0.01, limitPrice); // Min valid price
                limitPrice = Math.round(limitPrice * 1000) / 1000;
            } else {
                // TAKER STRATEGY: Sweep up to suggestedPrice (from sniper's observed ask)
                // Using only bestAsk+0.01 misses shares at higher price levels when WS cache was stale.
                const sweepTarget = suggestedPrice != null ? suggestedPrice + 0.01 : bestAsk + 0.01;
                limitPrice = Math.min(0.99, Math.max(bestAsk + 0.01, sweepTarget));
            }

            const size = Math.floor(amountUsdc / limitPrice); // Amount of shares

            if (size <= 0) {
                return { success: false, error: "Size too small" };
            }

            const order = await this.client.createOrder({
                tokenID: tokenId,
                price: limitPrice,
                side: "BUY",
                size: size,
            });

            // FAK = Fill and Kill (default): fills what's available, cancels the rest
            const response = await this.client.postOrder(order);
            if (response.error || response.status === 400 || response.status === 422) {
                throw new Error(response.error || `Order rejected (status ${response.status})`);
            }

            const orderStatus = response.status ?? response.orderStatus ?? "";
            const isLive = typeof orderStatus === "string" && orderStatus.toLowerCase() === "live";

            if (isLive && !makerOnly) {
                console.log(`[TRADING] ⚠ Taker order not filled (status: live) — no liquidity`);
                return { success: false, error: "Taker order unfilled — no liquidity at price" };
            }

            // API new format: takingAmount = shares received (human-readable float)
            // makingAmount = USDC paid (human-readable float) — NOT shares anymore
            // Old format used 6-decimal fixed (37630000 = 37.63 shares) — no longer seen
            const rawTaking = response.takingAmount != null ? parseFloat(response.takingAmount) : null;
            const rawMaking = response.makingAmount != null ? parseFloat(response.makingAmount) : null;
            let actualShares;
            if (rawTaking != null && rawTaking > 0) {
                actualShares = Math.round(rawTaking);
            } else if (rawMaking != null && rawMaking >= 1000) {
                // Legacy 6-decimal fixed format fallback
                actualShares = Math.round(rawMaking / 1_000_000);
            } else {
                actualShares = size;
            }

            console.log(`Trade executed: status=${orderStatus || "ok"} filled=${actualShares}/${size} shares @ ${limitPrice} | makingAmount=${response.makingAmount ?? "?"} takingAmount=${response.takingAmount ?? "?"} (USDC/shares)`);
            return { success: true, orderId: response.orderID, fillPrice: limitPrice, fillShares: actualShares, response };
        } catch (error) {
            // Sanitize HTML error pages (504/503 from Cloudflare) into a clean message
            const raw = error.message || "";
            const isHtml = raw.trimStart().startsWith("<");
            const cleanMsg = isHtml
                ? `API timeout (${raw.match(/<title>(.*?)<\/title>/i)?.[1] ?? "5xx"})`
                : raw;
            console.error("Trade execution failed:", cleanMsg);
            return { success: false, error: cleanMsg };
        }
    }

    async sellPosition(tokenId, shares) {
        if (!this.initialized || !CONFIG.trading.enabled) {
            console.log(`[DRY RUN SELL] Would sell ${shares} shares of token ${tokenId?.slice(0, 12)}...`);
            return { success: true, dryRun: true };
        }
        if (!tokenId || !shares || shares <= 0) {
            return { success: false, error: "Missing tokenId or shares" };
        }
        try {
            const orderbook = await this.client.getOrderBook(tokenId);
            const bidPrices = (orderbook.bids || []).map(b => parseFloat(b.price)).filter(p => p > 0);
            const bestBid = bidPrices.length ? Math.max(...bidPrices) : null;
            if (!bestBid || bestBid <= 0.01) {
                return { success: false, error: "No bids available to sell into" };
            }
            // Cross the bid to ensure fill
            const price = Math.max(0.01, Math.round((bestBid - 0.01) * 1000) / 1000);
            console.log(`[SELL] ${shares} shares @ $${price.toFixed(3)} (bid: $${bestBid.toFixed(3)})`);
            const order = await this.client.createOrder({ tokenID: tokenId, price, side: "SELL", size: shares });
            const response = await this.client.postOrder(order);
            console.log("Sell executed:", response);
            return { success: true, sellPrice: price, shares, response };
        } catch (error) {
            console.error("Sell failed:", error.message);
            return { success: false, error: error.message };
        }
    }

    async getBidPrice(tokenId) {
        try {
            const ob = await this.client.getOrderBook(tokenId);
            const prices = (ob.bids || []).map(b => parseFloat(b.price)).filter(p => p > 0);
            return prices.length ? Math.max(...prices) : null;
        } catch { return null; }
    }

    async claimWinnings(conditionId) {
        if (!this.initialized || !this.wallet || !conditionId) return false;
        const proxyAddress = (process.env.POLY_PROXY_ADDRESS || "").trim();
        if (!proxyAddress) return false;

        try {
            const rpcUrl = CONFIG.chainlink.polygonRpcUrls?.[0] || CONFIG.chainlink.polygonRpcUrl;
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const signer = this.wallet.connect(provider);

            const CTF_ADDRESS   = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
            const USDC_ADDRESS  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

            const ctfIface = new ethers.Interface([
                "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external"
            ]);

            const calldata = ctfIface.encodeFunctionData("redeemPositions", [
                USDC_ADDRESS,
                ethers.ZeroHash,          // parentCollectionId = 0
                conditionId,
                [1, 2]                    // redeem both outcomes — loser gives $0, winner gives USDC
            ]);

            const safeAbi = [
                "function nonce() view returns (uint256)",
                "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool success)"
            ];
            const safe = new ethers.Contract(proxyAddress, safeAbi, signer);
            const nonce = await safe.nonce();

            // Build EIP-712 Safe transaction hash
            const SAFE_TX_TYPEHASH    = "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8";
            const DOMAIN_TYPEHASH     = "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218";

            const domainSeparator = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["bytes32", "uint256", "address"],
                    [DOMAIN_TYPEHASH, 137, proxyAddress]
                )
            );

            const safeTxHash = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["bytes32","address","uint256","bytes32","uint8","uint256","uint256","uint256","address","address","uint256"],
                    [SAFE_TX_TYPEHASH, CTF_ADDRESS, 0, ethers.keccak256(calldata), 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce]
                )
            );

            const msgHash = ethers.keccak256(
                ethers.solidityPacked(["bytes1","bytes1","bytes32","bytes32"], ["0x19","0x01", domainSeparator, safeTxHash])
            );

            const signingKey = new ethers.SigningKey(this.wallet.privateKey);
            const sig = signingKey.sign(msgHash);
            const signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);

            const tx = await safe.execTransaction(
                CTF_ADDRESS, 0, calldata, 0, 0, 0, 0,
                ethers.ZeroAddress, ethers.ZeroAddress,
                signature,
                { gasLimit: 500_000 }
            );
            await tx.wait();
            console.log(`[CLAIM] Winnings claimed for condition ${conditionId.slice(0, 10)}... tx: ${tx.hash}`);
            return true;
        } catch (error) {
            console.error(`[CLAIM] Failed: ${error.message}`);
            return false;
        }
    }
}
