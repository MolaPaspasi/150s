import { CONFIG } from "../config.js";
import { logArbExecution } from "../services/executionLogger.js";
import { simulateArbFill } from "../services/preFillSimulation.js";

export class ArbitrageEngine {
    constructor(tradingEngine) {
        this.trader = tradingEngine;
    }

    /**
     * Checks for a negative spread (Risk-Free Arbitrage) opportunity.
     * Logic: If BestAsk(UP) + BestAsk(DOWN) < 1.00 - minProfit
     *
     * @param {Object} market - The market object
     * @param {Object} orderbooks - Contains { up: { bestAsk }, down: { bestAsk } }
     * @returns {Object|null} Opportunity details or null
     */
    checkOpportunity(market, orderbooks) {
        const askUp = orderbooks.up?.bestAsk;
        const askDown = orderbooks.down?.bestAsk;

        if (askUp === null || askUp === undefined || askDown === null || askDown === undefined) {
            return null;
        }

        const totalCost = askUp + askDown;
        // Payout is always $1.00 for the winning side per share.
        // If we buy 1 share of UP and 1 share of DOWN, we spend totalCost and receive $1.00.
        // Profit = 1.00 - totalCost.

        const minProfit = CONFIG.arbitrage.minProfit; // e.g., 0.01 for 1 cent/share
        const projectedProfit = 1.00 - totalCost;

        if (projectedProfit >= minProfit) {
            return {
                slug: market.slug,
                details: {
                    askUp,
                    askDown,
                    totalCost,
                    projectedProfit,
                    roi: (projectedProfit / totalCost) * 100
                }
            };
        }

        return null;
    }

    /**
     * Executes the arbitrage trade by buying both sides simultaneously.
     *
     * @param {Object} opportunity - Opportunity details returned by checkOpportunity
     * @param {Object} tokens - { upTokenId, downTokenId }
     * @returns {Promise<Object>} Execution results
     */
    async execute(opportunity, tokens) {
        if (!CONFIG.arbitrage.enabled) {
            return { success: true, dryRun: true, message: "Arbitrage detected but execution disabled." };
        }

        const { askUp, askDown } = opportunity.details;
        const { upTokenId, downTokenId } = tokens;

        // Determine size based on budget
        // We need to buy EQUAL amounts of UP and DOWN to hedge perfectly.
        // Budget is split: CostUp * Size + CostDown * Size <= MaxSpend
        // Size * (CostUp + CostDown) <= MaxSpend
        // Size <= MaxSpend / TotalCost

        // However, for simplicity and speed, we might use a fixed USDC amount per side
        // OR a fixed share count.

        // Let's use config.trading.amountUsdc as the "Target Payout" (e.g. buy 5 shares to get $5).
        // Or treating amountUsdc as total spend.

        // Approach: Buy fixed SHARES to ensure perfect 1:1 hedging.
        // Buying $5 worth of UP and $5 worth of DOWN results in different share counts, which leaves us exposed using 'amountUsdc'.
        // We must calculate shares.

        // Let's assume we want to deployment approx CONFIG.trading.amountUsdc TOTAL.
        // Total Cost per unit = askUp + askDown.
        // Target Shares = amountUsdc / TotalCost.

        const totalCost = askUp + askDown;
        const amountToSpend = CONFIG.trading.amountUsdc; // Total budget for this arb loop
        const targetShares = Math.floor(amountToSpend / totalCost);

        if (targetShares < 1) {
            return { success: false, error: "Insufficient budget for even 1 share." };
        }

        // Phase 4: Pre-fill simulation — skip if simulated profit would be below threshold
        const orderbookSim = { up: { bestAsk: askUp }, down: { bestAsk: askDown } };
        const sim = simulateArbFill(orderbookSim, targetShares);
        if (!sim.ok) {
            return { success: false, error: sim.reason ?? "Pre-fill simulation failed" };
        }

        const amountUsdc = targetShares * totalCost;
        logArbExecution(opportunity, targetShares, amountUsdc);

        console.log(`[ARBITRAGE] Executing ⚡ | Target Shares: ${targetShares} | Cost: $${(targetShares * totalCost).toFixed(2)} | Profit: $${(targetShares * (1 - totalCost)).toFixed(2)}`);

        // Phase 4: Parallel execution — both legs sent in same tick (no await between)
        const validAmountUp = (targetShares * askUp) + 0.001;
        const validAmountDown = (targetShares * askDown) + 0.001;

        try {
            const [resUp, resDown] = await Promise.all([
                this.trader.executeTrade(upTokenId, "UP", validAmountUp),
                this.trader.executeTrade(downTokenId, "DOWN", validAmountDown)
            ]);

            const success = resUp.success && resDown.success;
            if (!success) {
                console.error(`[ARBITRAGE] ⚠️ Partial execution! UP:${resUp.success} DOWN:${resDown.success}`);
            }

            return {
                success,
                resUp,
                resDown,
                shares: targetShares,
                profit: targetShares * (1 - totalCost)
            };

        } catch (err) {
            console.error(`[ARBITRAGE] Execution failed: ${err.message}`);
            return { success: false, error: err.message };
        }
    }
}
