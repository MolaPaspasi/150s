import * as dotenv from "dotenv";
dotenv.config();

const WALLET = process.argv[2];
if (!WALLET) {
    console.error("Usage: node src/analyze_trader.js <wallet_address>");
    process.exit(1);
}

const API_KEY = process.env.POLYMARKETSCAN_API_KEY || "";
const BASE = "https://gzydspfquuaudqeztorw.supabase.co/functions/v1/public-api";

// ── API helpers ─────────────────────────────────────────────────────────────

async function pscan(endpoint, params = {}) {
    const qs = new URLSearchParams({ endpoint, api_key: API_KEY, ...params });
    const res = await fetch(`${BASE}?${qs}`);
    if (!res.ok) throw new Error(`PolymarketScan ${endpoint}: HTTP ${res.status}`);
    const json = await res.json();
    if (!json.ok) throw new Error(`PolymarketScan ${endpoint}: ${json.error ?? "unknown"}`);
    return json.data;
}

async function fetchAllTrades(address) {
    const all = [];
    let offset = 0;
    while (true) {
        const data = await pscan("wallet_trades", { address, limit: 500, offset });
        const trades = data.trades ?? [];
        if (!trades.length) break;
        all.push(...trades);
        const total = data.meta?.total ?? 0;
        if (all.length >= total || trades.length < 500) break;
        offset += 500;
        await new Promise(r => setTimeout(r, 400));
    }
    return all;
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function pct(n, d)  { return d === 0 ? "N/A" : ((n / d) * 100).toFixed(1) + "%"; }
function usd(n)     { return "$" + parseFloat(n).toFixed(2); }
function avg(arr)   { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stddev(arr) {
    if (arr.length < 2) return 0;
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function topN(map, n = 5) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ── Trade field normalisation ────────────────────────────────────────────────

function normaliseTrade(t) {
    return {
        slug:      t.event_slug ?? "",
        question:  t.market_question ?? "",
        outcome:   (t.outcome ?? "").toUpperCase(),
        side:      (t.side ?? "").toUpperCase(),
        price:     parseFloat(t.price ?? 0),
        size:      parseFloat(t.size ?? 0),
        value:     parseFloat(t.price ?? 0) * parseFloat(t.size ?? 0),
        ts:        t.trade_timestamp ? new Date(t.trade_timestamp) : null,
        hash:      t.transaction_hash ?? "",
    };
}

// ── Asset / timeframe inference from event_slug ───────────────────────────────

function inferAsset(slug, question) {
    const s = (slug + " " + question).toLowerCase();
    for (const a of ["btc","bitcoin","eth","ethereum","sol","solana","doge","xrp","bnb","avax","matic","link"]) {
        if (s.includes(a)) return a.toUpperCase().slice(0, 4);
    }
    // Sports
    for (const sp of ["world cup","nba","nfl","mlb","ufc","euro","copa","champions","premier"]) {
        if (s.includes(sp)) return "SPORT";
    }
    // Politics
    for (const po of ["president","election","senate","congress","trump","biden","harris"]) {
        if (s.includes(po)) return "POLIT";
    }
    return "OTHER";
}

function inferTimeframe(slug) {
    const s = slug.toLowerCase();
    if (s.includes("5m"))  return "5m";
    if (s.includes("15m")) return "15m";
    if (s.includes("1h"))  return "1h";
    if (s.includes("4h"))  return "4h";
    if (s.includes("24h") || s.includes("1d")) return "1d";
    return "event";   // non-recurring market
}

function priceBucket(p) {
    if (p < 0.05)  return "<5¢  (moonshot)";
    if (p < 0.20)  return "5-20¢ (long shot)";
    if (p < 0.40)  return "20-40¢ (underdog)";
    if (p < 0.60)  return "40-60¢ (coin flip)";
    if (p < 0.80)  return "60-80¢ (likely)";
    if (p < 0.93)  return "80-93¢ (heavy fav)";
    return         ">93¢  (near-cert)";
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function analyze() {
    console.log(`\n${"═".repeat(64)}`);
    console.log(` TRADER ANALYSIS  —  ${WALLET}`);
    console.log(`${"═".repeat(64)}\n`);

    // 1. Profile
    let profile = null;
    try { profile = await pscan("wallet_profile", { address: WALLET }); }
    catch (e) { console.warn("Profile unavailable:", e.message); }

    if (profile) {
        const winRate = profile.win_rate != null
            ? (profile.win_rate > 1 ? profile.win_rate.toFixed(1) : (profile.win_rate * 100).toFixed(1)) + "%"
            : "N/A";
        console.log("── OVERVIEW ──────────────────────────────────────────────");
        console.log(`  Realized PnL   : ${usd(profile.realized_pnl ?? profile.total_pnl ?? 0)}`);
        console.log(`  Unrealized PnL : ${usd(profile.unrealized_pnl ?? 0)}`);
        console.log(`  ROI            : ${profile.roi != null ? profile.roi.toFixed(2) + "%" : "N/A"}`);
        console.log(`  Volume         : ${usd(profile.total_volume ?? profile.volume ?? 0)}`);
        console.log(`  Win rate       : ${winRate}  (${profile.wins ?? 0}W / ${profile.losses ?? 0}L)`);
        console.log(`  Unique markets : ${profile.unique_markets ?? "N/A"}`);
        console.log(`  Active since   : ${profile.first_trade_date?.slice(0,10) ?? "N/A"}`);
        console.log(`  Last trade     : ${profile.last_trade_date?.slice(0,10) ?? "N/A"}`);
        console.log();
    }

    // 2. Trades
    console.log("Fetching trade history...");
    let rawTrades = [];
    try { rawTrades = await fetchAllTrades(WALLET); }
    catch (e) { console.error("Could not fetch trades:", e.message); }

    if (!rawTrades.length) { console.log("No trades found."); return; }

    const trades = rawTrades.map(normaliseTrade);
    const buys   = trades.filter(t => t.side === "BUY");

    console.log(`Loaded ${trades.length} trades  (${buys.length} BUY / ${trades.length - buys.length} SELL)\n`);

    // ── Aggregate ──────────────────────────────────────────────────────────
    const assetCount   = new Map();
    const tfCount      = new Map();
    const outcomeCount = new Map();
    const bucketCount  = new Map();
    const bucketValue  = new Map();
    const slugCount    = new Map();
    const slugQuestion = new Map();
    const hourCount    = new Array(24).fill(0);
    const dayCount     = new Array(7).fill(0);
    const prices = [], values = [];

    for (const t of buys) {
        const asset  = inferAsset(t.slug, t.question);
        const tf     = inferTimeframe(t.slug);
        const bucket = priceBucket(t.price);

        if (t.price > 0) prices.push(t.price);

        if (t.value > 0) values.push(t.value);

        assetCount.set(asset,   (assetCount.get(asset)   ?? 0) + 1);
        tfCount.set(tf,         (tfCount.get(tf)         ?? 0) + 1);
        outcomeCount.set(t.outcome, (outcomeCount.get(t.outcome) ?? 0) + 1);
        bucketCount.set(bucket, (bucketCount.get(bucket) ?? 0) + 1);
        bucketValue.set(bucket, (bucketValue.get(bucket) ?? 0) + t.value);
        slugCount.set(t.slug,   (slugCount.get(t.slug)   ?? 0) + 1);
        if (!slugQuestion.has(t.slug)) slugQuestion.set(t.slug, t.question);

        if (t.ts) {
            hourCount[t.ts.getUTCHours()]++;
            dayCount[t.ts.getUTCDay()]++;
        }
    }

    // ── Print ──────────────────────────────────────────────────────────────

    console.log("── MARKET PREFERENCES ────────────────────────────────────");
    console.log("  Category breakdown:");
    for (const [asset, count] of topN(assetCount, 8))
        console.log(`    ${asset.padEnd(6)}  ${String(count).padStart(4)} trades  (${pct(count, buys.length)})`);
    console.log();
    console.log("  Timeframe / market type:");
    for (const [tf, count] of topN(tfCount, 5))
        console.log(`    ${tf.padEnd(6)}  ${String(count).padStart(4)} trades  (${pct(count, buys.length)})`);
    console.log();
    console.log("  Top 5 specific events:");
    for (const [slug, count] of topN(slugCount, 5)) {
        const q = slugQuestion.get(slug) || slug || "(unknown)";
        const label = q.length > 52 ? q.slice(0, 49) + "..." : q;
        console.log(`    ${String(count).padStart(3)}x  ${label}`);
    }
    console.log();

    console.log("── OUTCOME PREFERENCES ───────────────────────────────────");
    for (const [outcome, count] of [...outcomeCount.entries()].sort((a, b) => b[1] - a[1])) {
        if (!outcome) continue;
        console.log(`    ${outcome.padEnd(8)}  ${String(count).padStart(4)} trades  (${pct(count, buys.length)})`);
    }
    console.log();

    console.log("── PRICE / CONFIDENCE ANALYSIS ───────────────────────────");
    const BUCKET_ORDER = [
        "<5¢  (moonshot)", "5-20¢ (long shot)", "20-40¢ (underdog)",
        "40-60¢ (coin flip)", "60-80¢ (likely)", "80-93¢ (heavy fav)", ">93¢  (near-cert)"
    ];
    for (const bucket of BUCKET_ORDER) {
        const count = bucketCount.get(bucket) ?? 0;
        if (!count) continue;
        const vol = bucketValue.get(bucket) ?? 0;
        console.log(`    ${bucket.padEnd(22)}  ${String(count).padStart(4)} trades   ${usd(vol).padStart(10)} invested`);
    }
    if (prices.length) {
        console.log();
        console.log(`  Avg entry price  : ${avg(prices).toFixed(4)}  (${(avg(prices)*100).toFixed(2)}¢)`);
        console.log(`  Median price     : ${median(prices).toFixed(4)}  (${(median(prices)*100).toFixed(2)}¢)`);
        console.log(`  Price std dev    : ${stddev(prices).toFixed(4)}`);
    }
    console.log();

    console.log("── BET SIZING (USD invested per trade) ───────────────────");
    if (values.length) {
        const small  = values.filter(v => v <   20).length;
        const medium = values.filter(v => v >=  20 && v < 200).length;
        const large  = values.filter(v => v >= 200).length;
        console.log(`  Min    : ${usd(Math.min(...values))}`);
        console.log(`  Max    : ${usd(Math.max(...values))}`);
        console.log(`  Avg    : ${usd(avg(values))}`);
        console.log(`  Median : ${usd(median(values))}`);
        console.log(`  Total  : ${usd(values.reduce((a, b) => a + b, 0))}`);
        console.log(`  Small  (<$20)    : ${small}  (${pct(small, values.length)})`);
        console.log(`  Medium ($20-200) : ${medium}  (${pct(medium, values.length)})`);
        console.log(`  Large  (>$200)   : ${large}  (${pct(large, values.length)})`);
    }
    console.log();

    console.log("── ACTIVITY TIMING (UTC) ─────────────────────────────────");
    const maxH    = Math.max(...hourCount) || 1;
    const peakH   = hourCount.indexOf(maxH);
    const maxD    = Math.max(...dayCount)  || 1;
    const peakD   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dayCount.indexOf(maxD)];
    console.log(`  Peak hour : ${String(peakH).padStart(2)}:00 UTC  (${hourCount[peakH]} trades)`);
    console.log(`  Peak day  : ${peakD}`);
    console.log("  Hourly distribution:");
    for (let h = 0; h < 24; h += 6) {
        const row = [0,1,2,3,4,5].map(i => {
            const hi  = h + i;
            const bar = Math.round((hourCount[hi] / maxH) * 6);
            return `${String(hi).padStart(2)}h:${"█".repeat(bar)}${"░".repeat(6 - bar)}`;
        }).join("  ");
        console.log(`    ${row}`);
    }
    console.log();

    // 3. PnL timeline
    try {
        const pnlData = await pscan("wallet_pnl", { address: WALLET });
        const daily   = pnlData?.daily ?? pnlData?.timeseries ?? pnlData?.daily_pnl ?? [];
        if (daily.length) {
            console.log("── PnL TIMELINE (last 14 days) ───────────────────────────");
            for (const day of [...daily].slice(-14)) {
                const date = (day.date ?? day.day ?? "?").slice(0, 10);
                const val  = parseFloat(day.pnl ?? day.value ?? 0);
                const sign = val >= 0 ? "▲" : "▼";
                const bar  = Math.min(20, Math.round(Math.abs(val) / 100));
                console.log(`    ${date}  ${sign} ${usd(val).padStart(10)}  ${"█".repeat(bar)}`);
            }
            console.log();
        }
    } catch (_) {}

    // 4. Strategy inference
    console.log("── STRATEGY INFERENCE ────────────────────────────────────");
    inferStrategy({ prices, values, assetCount, tfCount, outcomeCount, profile });

    console.log(`\n${"═".repeat(64)}\n`);
}

function inferStrategy({ prices, values, assetCount, tfCount, outcomeCount, profile }) {
    const avgP  = avg(prices);
    const notes = [];

    // What they bet ON
    const topAsset = [...assetCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (topAsset === "SPORT") notes.push("• Bets primarily on SPORTS markets (World Cup, NBA, etc.).");
    else if (topAsset === "POLIT") notes.push("• Primarily a POLITICS bettor (elections, policy events).");
    else if (topAsset && topAsset !== "OTHER") notes.push(`• Focused on CRYPTO price markets (mainly ${topAsset}).`);
    else notes.push("• Trades a mix of general event markets.");

    // Price range strategy
    if (avgP < 0.05)       notes.push(`• MOONSHOT hunter — avg entry ${(avgP*100).toFixed(2)}¢. Buys tiny-probability outcomes hoping for massive payouts. 1 win can cover many losses.`);
    else if (avgP < 0.20)  notes.push(`• LONG-SHOT bettor — avg entry ${(avgP*100).toFixed(2)}¢. Seeks high upside on unlikely events. Needs very high win rate relative to price to be profitable.`);
    else if (avgP < 0.45)  notes.push(`• UNDERDOG player — avg entry ${(avgP*100).toFixed(2)}¢. Contrarian approach, bets against consensus.`);
    else if (avgP < 0.70)  notes.push(`• BALANCED range trader — avg entry ${(avgP*100).toFixed(2)}¢. Near 50/50 markets, likely momentum or news-driven.`);
    else if (avgP < 0.88)  notes.push(`• HIGH-CONFIDENCE bettor — avg entry ${(avgP*100).toFixed(2)}¢. Only bets on likely outcomes.`);
    else                   notes.push(`• NEAR-CERTAINTY seeker — avg entry ${(avgP*100).toFixed(2)}¢. Very low-risk, low-reward per trade. Volume-dependent strategy.`);

    // Timeframe
    const topTf = [...tfCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (topTf === "event") notes.push("• Trades one-off EVENT markets (not recurring crypto price series). Positions held until market resolves.");
    else if (topTf)        notes.push(`• Primarily ${topTf} crypto price markets — short-term signal trader.`);

    // Sizing
    if (values.length) {
        const maxV = Math.max(...values);
        const minV = Math.min(...values);
        const ratio = maxV / (minV || 0.01);
        if (ratio > 50)   notes.push(`• CONVICTION-BASED sizing — ranges from ${usd(minV)} to ${usd(maxV)}. Puts significantly more on highest-conviction bets.`);
        else if (ratio > 5) notes.push(`• VARIABLE sizing — moderate range (${usd(minV)} to ${usd(maxV)}). May adjust for confidence or market liquidity.`);
        else               notes.push(`• FLAT sizing — very consistent bet amounts (~${usd(avg(values))} avg). Systematic / rule-based approach.`);
    }

    // Outcome bias
    const up   = (outcomeCount.get("UP")  ?? 0) + (outcomeCount.get("YES") ?? 0);
    const down = (outcomeCount.get("DOWN") ?? 0) + (outcomeCount.get("NO")  ?? 0);
    const tot  = up + down || 1;
    if (up / tot > 0.75)        notes.push(`• BULLISH bias — ${pct(up, tot)} YES/UP bets. Trusts the favourite or leans long.`);
    else if (down / tot > 0.75) notes.push(`• BEARISH bias — ${pct(down, tot)} NO/DOWN bets. Contrarian or downside-focused.`);
    else                        notes.push(`• Relatively balanced UP/DOWN exposure (${pct(up,tot)} YES vs ${pct(down,tot)} NO).`);

    // ROI summary
    if (profile?.roi != null)
        notes.push(`• Overall ROI: ${profile.roi.toFixed(1)}%  |  Realized PnL: ${usd(profile.realized_pnl ?? 0)}`);

    for (const n of notes) console.log(`  ${n}`);

    console.log();
    console.log("  ── BOT BUILDING TAKEAWAYS ──");
    if (avgP < 0.20) {
        console.log("  → To replicate: scan all markets for odds <20¢, filter by event category.");
        console.log("  → Risk model: accept high loss rate, size bets so 1 win covers N losses.");
        console.log("  → Exit: hold to resolution (no early exit needed at these prices).");
    } else if (avgP > 0.70) {
        console.log("  → To replicate: only enter when market price > 70¢ (high consensus).");
        console.log("  → Use a thin-margin model — profit comes from volume, not big moves.");
        console.log("  → Monitor for price drops that signal consensus shifting.");
    } else {
        console.log("  → Mid-range bettor — likely uses news/sentiment signals to pick side.");
        console.log("  → Check if trades cluster around specific events (earnings, games, news).");
    }
}

analyze().catch(e => {
    console.error("Fatal:", e.message);
    process.exit(1);
});
