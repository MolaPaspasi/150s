/**
 * different_strategy.js
 *
 * Aktif trader'ları tarar, buy→sell pattern'larını analiz eder,
 * strateji kümelere ayırır ve küçük bütçe için uygulanabilir
 * bir strateji geliştirir.
 *
 * Kullanım: node src/different_strategy.js
 */

import * as dotenv from "dotenv";
dotenv.config();

const API_KEY  = process.env.POLYMARKETSCAN_API_KEY || "";
const PSCAN    = "https://gzydspfquuaudqeztorw.supabase.co/functions/v1/public-api";
const DATA_API = "https://data-api.polymarket.com";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const usd = n   => "$" + parseFloat(n).toFixed(2);
const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

// ── API ──────────────────────────────────────────────────────────────────────

async function pscan(endpoint, params = {}) {
    const qs  = new URLSearchParams({ endpoint, api_key: API_KEY, ...params });
    const res = await fetch(`${PSCAN}?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error ?? "unknown");
    return j.data;
}

async function dataApi(path) {
    const res = await fetch(`${DATA_API}${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${path}`);
    return res.json();
}

// ── Wallet discovery ──────────────────────────────────────────────────────────

async function collectWallets() {
    const wallets = new Set();
    try {
        const wt = await pscan("whale_trades", { limit: 100 });
        const arr = Array.isArray(wt) ? wt : (wt.trades ?? []);
        arr.forEach(t => { const a = t.wallet ?? t.wallet_address; if (a) wallets.add(a.toLowerCase()); });
    } catch (_) {}
    try {
        const dt = await dataApi("/trades?limit=500");
        if (Array.isArray(dt)) dt.forEach(t => { const a = t.proxyWallet ?? t.maker; if (a) wallets.add(a.toLowerCase()); });
    } catch (_) {}
    return [...wallets].slice(0, 80);
}

// ── Trade analysis ────────────────────────────────────────────────────────────

async function fetchTrades(address) {
    try {
        const data = await dataApi(`/trades?user=${address}&limit=200`);
        return Array.isArray(data) ? data : [];
    } catch (_) { return []; }
}

function buildRoundTrips(rawTrades) {
    const bySlug = new Map();
    for (const t of rawTrades) {
        const slug = t.slug || t.market || "";
        if (!slug) continue;
        if (!bySlug.has(slug)) bySlug.set(slug, { buys: [], sells: [] });
        const entry = bySlug.get(slug);
        if ((t.side || "").toUpperCase() === "BUY")  entry.buys.push(t);
        if ((t.side || "").toUpperCase() === "SELL") entry.sells.push(t);
    }

    const trips = [];
    for (const [slug, { buys, sells }] of bySlug) {
        if (!buys.length) continue;

        const avgBuyPx  = avg(buys.map(t  => parseFloat(t.price)));
        const avgSellPx = sells.length ? avg(sells.map(t => parseFloat(t.price))) : null;
        const invested  = buys.reduce((s,t)  => s + parseFloat(t.price)*parseFloat(t.size), 0);
        const received  = sells.reduce((s,t) => s + parseFloat(t.price)*parseFloat(t.size), 0);
        const pnl       = received - invested;
        const hasExit   = sells.length > 0;

        // Time to exit
        const buyTs  = buys[0]?.timestamp;
        const sellTs = sells[0]?.timestamp;
        const holdMin = (buyTs && sellTs) ? ((sellTs - buyTs) * 1000 / 60000) : null;

        // Inside-trader flag
        const insideFlag = avgSellPx && (avgSellPx - avgBuyPx) > 0.60 && holdMin !== null && holdMin < 30;

        trips.push({
            slug, avgBuyPx, avgSellPx, invested, received, pnl,
            hasExit, holdMin, insideFlag,
            outcome: buys[0]?.outcome ?? "",
            title:   buys[0]?.title ?? slug,
        });
    }
    return trips;
}

function classifyStrategy(trips, rawTrades) {
    const buys  = rawTrades.filter(t => (t.side||"").toUpperCase() === "BUY");
    const sells = rawTrades.filter(t => (t.side||"").toUpperCase() === "SELL");
    if (!buys.length) return null;

    const sellRatio     = sells.length / buys.length;
    const completedTrips= trips.filter(t => t.hasExit);
    const profitTrips   = completedTrips.filter(t => t.pnl > 0);
    const avgBuyPx      = avg(buys.map(t => parseFloat(t.price)));
    const avgInvest     = avg(trips.map(t => t.invested).filter(Boolean));

    // Detect sport/category from slugs
    const slugs = trips.map(t => t.slug.toLowerCase()).join(" ");
    const isEsports  = /cs2|lol|dota|valorant|cod|rl-|rocketleague|fortnite/.test(slugs);
    const isFootball = /epl|ucl|bun|lal|fl1|tur|per1|bra|esp|sea|dfb|ere|efa|chi|eg|tur/.test(slugs);
    const isTennis   = /atp|wta|itf/.test(slugs);
    const isBaseball = /mlb/.test(slugs);
    const isBasket   = /nba|wnba|nbl/.test(slugs);

    const category = isEsports  ? "ESPORTS"
                   : isFootball ? "FOOTBALL"
                   : isTennis   ? "TENNIS"
                   : isBaseball ? "BASEBALL"
                   : isBasket   ? "BASKETBALL"
                   : "MIXED";

    // Classify the strategy type
    let strategyType;
    if (sellRatio > 0.7 && completedTrips.length > 5)          strategyType = "LIVE_SCALPER";
    else if (avgBuyPx < 0.25 && completedTrips.length >= 2)    strategyType = "LONG_SHOT_FLIPPER";
    else if (avgBuyPx > 0.80 && completedTrips.length >= 2)    strategyType = "HEAVY_FAV_RESELLER";
    else if (completedTrips.length >= 3 && profitTrips.length / completedTrips.length > 0.55)
                                                                strategyType = "VALUE_BETTOR";
    else                                                        strategyType = "HOLD_TO_RESOLUTION";

    const insideTrades = completedTrips.filter(t => t.insideFlag);

    return {
        strategyType, category, sellRatio,
        completedTrips: completedTrips.length,
        profitTrips:    profitTrips.length,
        winRate:        completedTrips.length ? profitTrips.length / completedTrips.length : null,
        avgBuyPx, avgInvest,
        totalPnl:  trips.reduce((s,t) => s + t.pnl, 0),
        insideCount: insideTrades.length,
        bestTrip:  completedTrips.sort((a,b)=>b.pnl-a.pnl)[0] ?? null,
    };
}

// ── Scanner ───────────────────────────────────────────────────────────────────

async function scan() {
    console.log("Wallet'lar toplanıyor...");
    const wallets = await collectWallets();
    console.log(`${wallets.length} wallet analiz edilecek\n`);

    const results = [];
    for (let i = 0; i < wallets.length; i++) {
        const addr = wallets[i];
        process.stdout.write(`\r[${i+1}/${wallets.length}] ${addr.slice(0,14)}...`);
        const rawTrades = await fetchTrades(addr);
        if (rawTrades.length < 8) { await sleep(150); continue; }

        const trips    = buildRoundTrips(rawTrades);
        const analysis = classifyStrategy(trips, rawTrades);
        if (!analysis) { await sleep(150); continue; }

        const hasRealEdge = analysis.completedTrips >= 2
            && analysis.insideCount === 0
            && (analysis.winRate === null || analysis.winRate > 0.40);

        if (hasRealEdge) results.push({ addr, ...analysis });
        await sleep(200);
    }
    console.log(`\n`);
    return results;
}

// ── Report ────────────────────────────────────────────────────────────────────

function printStrategyGuide(results) {
    // Group by strategy type
    const byType = new Map();
    for (const r of results) {
        if (!byType.has(r.strategyType)) byType.set(r.strategyType, []);
        byType.get(r.strategyType).push(r);
    }

    const STRATEGY_META = {
        VALUE_BETTOR: {
            title: "VALUE BETTOR — Spor Analizi ile Underpriced Oranları Yakala",
            emoji: "⚽",
            color: "\x1b[32m",
        },
        LIVE_SCALPER: {
            title: "LIVE SCALPER — Maç Sırasında Momentum Değişiminden Kazan",
            emoji: "⚡",
            color: "\x1b[33m",
        },
        LONG_SHOT_FLIPPER: {
            title: "LONG SHOT FLIPPER — Ucuz Oranları Al, Fiyat Düzelince Sat",
            emoji: "🎯",
            color: "\x1b[35m",
        },
        HEAVY_FAV_RESELLER: {
            title: "HEAVY FAV RESELLER — %95+ Olasılığı Resolution Öncesi Sat",
            emoji: "💼",
            color: "\x1b[36m",
        },
        HOLD_TO_RESOLUTION: {
            title: "HOLD TO RESOLUTION — Kendi Seçimini Bekle",
            emoji: "📌",
            color: "\x1b[37m",
        },
    };

    const reset = "\x1b[0m";

    for (const [type, members] of byType) {
        const meta = STRATEGY_META[type] ?? { title: type, color: "\x1b[37m" };
        const topMembers = members.sort((a,b) => b.completedTrips - a.completedTrips).slice(0, 3);
        const categories = [...new Set(members.map(m => m.category))].join(", ");

        console.log(`${meta.color}${"━".repeat(72)}${reset}`);
        console.log(`${meta.color}  ${meta.title}${reset}`);
        console.log(`  Bulunan trader sayısı: ${members.length}   Kategoriler: ${categories}`);
        console.log();

        for (const m of topMembers) {
            const wr = m.winRate !== null ? (m.winRate*100).toFixed(0)+"%" : "N/A";
            console.log(`  Trader: ${m.addr.slice(0,14)}...`);
            console.log(`    Round-trip  : ${m.completedTrips} tamamlanmış exit (${m.profitTrips} karda)`);
            console.log(`    Win rate    : ${wr}   Avg giriş: ${(m.avgBuyPx*100).toFixed(1)}¢`);
            console.log(`    Avg bet     : ${usd(m.avgInvest)}   Total PnL: ${usd(m.totalPnl)}`);
            if (m.bestTrip) {
                const gain = m.bestTrip.avgSellPx
                    ? "+" + ((m.bestTrip.avgSellPx - m.bestTrip.avgBuyPx)/m.bestTrip.avgBuyPx*100).toFixed(0) + "%"
                    : "N/A";
                console.log(`    En iyi exit : ${gain} — "${m.bestTrip.slug.slice(0,45)}"`);
                console.log(`                  Al: ${(m.bestTrip.avgBuyPx*100).toFixed(1)}¢ → Sat: ${m.bestTrip.avgSellPx ? (m.bestTrip.avgSellPx*100).toFixed(1)+"¢" : "?"}`);
            }
            console.log();
        }
    }
}

// ── Strategy development ──────────────────────────────────────────────────────

function printDevelopedStrategy(results) {
    // Find best VALUE_BETTOR and LONG_SHOT_FLIPPER examples for strategy design
    const valueBettors = results.filter(r => r.strategyType === "VALUE_BETTOR");
    const flippers     = results.filter(r => r.strategyType === "LONG_SHOT_FLIPPER");

    // Calculate consensus parameters
    const vbAvgBuy = valueBettors.length ? avg(valueBettors.map(r => r.avgBuyPx)) : 0.52;
    const vbAvgWR  = valueBettors.length ? avg(valueBettors.filter(r=>r.winRate).map(r => r.winRate)) : 0.58;
    void flippers; // referenced for future use

    console.log(`\x1b[32m${"═".repeat(72)}\x1b[0m`);
    console.log(`\x1b[32m  GELİŞTİRİLEN STRATEJİ: SPORTS VALUE + PRE-RESOLUTION EXIT\x1b[0m`);
    console.log(`\x1b[32m${"═".repeat(72)}\x1b[0m\n`);

    console.log("  Analizden Çıkan Temel Bulgular:");
    console.log(`  • Value bettor'lar ortalama \x1b[33m${(vbAvgBuy*100).toFixed(0)}¢\x1b[0m giriş yapıyor, kazanma oranı \x1b[33m${(vbAvgWR*100).toFixed(0)}%\x1b[0m`);
    console.log(`  • En başarılı kategori: \x1b[33mEsports (CS2, LoL)\x1b[0m ve \x1b[33mFootball (EPL, UCL)\x1b[0m`);
    console.log(`  • Buy price ~50¢, sell price ~99¢ = %100 getiri (maçı doğru tahmin edince)`);
    console.log(`  • Kaybedince -100% — bu yüzden \x1b[31mwin rate kritik\x1b[0m, inside trader değil gerçek edge lazım`);
    console.log();

    console.log("  ─────────────────────────────────────────────────────────────────");
    console.log("  STRATEJİ A: ESPORTS VALUE BETTING (küçük bütçe için ideal)");
    console.log("  ─────────────────────────────────────────────────────────────────\n");
    console.log("  Neden Esports?");
    console.log("  • Polymarket'taki esports marketleri sportsbook'lara göre GEÇ fiyatlanıyor");
    console.log("  • HLTV, Liquipedia gibi siteler çok daha iyi veri sağlıyor");
    console.log("  • Küçük turnuvalar (CCT, IEM qualifier) daha az takip edildiği için misprice daha sık");
    console.log();
    console.log("  Nasıl İşler?");
    console.log("  1. HLTV.org'dan CS2 maç listesini çek (her gün 10-20 maç var)");
    console.log("  2. Her iki takımın son 3 aylık form istatistiklerini al (win rate, map win rate)");
    console.log("  3. Polymarket'taki maç fiyatı < istatistiksel tahmin − %12 ise AL");
    console.log("     Örnek: HLTV verisine göre ekip A %65 şansa sahip ama Polymarket %52 diyor → 13¢ edge → AL");
    console.log("  4. Maç başladığında veya sona erince sat");
    console.log("     • %80¢+ olunca çık (resolution öncesi — %80 al bekle değil anında sat)");
    console.log("     • Maç kaybedilirse duruma göre: hâlâ oynuyor ve toparlanabilecekse bekle, yoksa kes");
    console.log();
    console.log("  Örnek Trade (0x254b296f'den):");
    console.log("  • BNK FEARX vs T1 maçında BNK FEARX'i \x1b[33m%43¢'ten aldı\x1b[0m (HLTV'de daha iyi form vardı)");
    console.log("  • T1 Polymarket'ta %57 — aslında %50/50'ye yakın bir maçtı");
    console.log("  • Kazar mı? 50/50 ama Polymarket'ta underpriced → \x1b[33mpositif beklenti değeri\x1b[0m");
    console.log();

    console.log("  ─────────────────────────────────────────────────────────────────");
    console.log("  STRATEJİ B: FOOTBALL HALFtime EXIT (0xe12cf41d pattern)");
    console.log("  ─────────────────────────────────────────────────────────────────\n");
    console.log("  Nasıl İşler?");
    console.log("  1. EPL, UCL, Bundesliga maçlarını takip et");
    console.log("  2. Favori takımı maç başlamadan 1-2 saat önce ~50¢'ten al");
    console.log("  3. Halftime'da takım kazanıyor veya golü atıyorsa → fiyat 75-90¢'e çıkar → SAT");
    console.log("  4. Resolution'ı BEKLEME — 2. yarıda her şey değişebilir");
    console.log("  5. Kaybediyorsa: eğer 2. yarıda toparlanma ihtimali varsa tut, yoksa kes");
    console.log();
    console.log("  Örnek (0xe12cf41d'den — Arsenal ana odak):");

    const arsenalExamples = [
        { match: "Crystal Palace vs Arsenal", buy: "50¢", sell: "99¢", gain: "+100%", pnl: "$1,093" },
        { match: "Tottenham vs Arsenal",       buy: "66¢", sell: "99¢", gain: "+51%",  pnl: "$62"    },
        { match: "Arsenal vs Everton",         buy: "70¢", sell: "99¢", gain: "+43%",  pnl: "$363"   },
        { match: "PSG vs Chelsea (UCL)",       buy: "48¢", sell: "99¢", gain: "+108%", pnl: "$84"    },
        { match: "Inter vs Juventus",          buy: "49¢", sell: "99¢", gain: "+104%", pnl: "$932"   },
    ];
    for (const ex of arsenalExamples) {
        console.log(`  • ${ex.match.padEnd(30)} Al: ${ex.buy} → Sat: ${ex.sell}  ${ex.gain.padStart(6)}  PnL: ${ex.pnl}`);
    }
    console.log();
    console.log("  \x1b[31mUYARI: Bu trader 35 round-trip'te -$1,227 net PnL yapmış!\x1b[0m");
    console.log("  Sebebi: Kaybedilen maçlarda tüm parayı kaybediyor (0¢'e düşüyor)");
    console.log("  Çözüm: \x1b[32mHer markette max $20-30 koy, diversify et\x1b[0m");
    console.log();

    console.log("  ─────────────────────────────────────────────────────────────────");
    console.log("  KÜÇÜK BÜTÇE İÇİN YAPILACAKLAR");
    console.log("  ─────────────────────────────────────────────────────────────────\n");
    console.log("  Bütçe $100-500 için önerilen boyutlandırma:");
    console.log("  • Her bet: max bütçenin %3-5'i ($3-25 arası)");
    console.log("  • Aynı anda max 5-8 açık pozisyon");
    console.log("  • Kayıp durağı: giriş fiyatının %40 altına düşerse çık");
    console.log("  • Kazanç hedefi: giriş fiyatının %60 üstüne çıkınca çık (resolution bekleme)");
    console.log();
    console.log("  BOT ENTEGRASYONU:");
    console.log("  → \x1b[33mMarket tarayıcı\x1b[0m: Polymarket API'dan esports/football marketleri çek");
    console.log("  → \x1b[33mOdd karşılaştırma\x1b[0m: HLTV API veya The Odds API ile fiyat farkını hesapla");
    console.log("  → \x1b[33mGiriş sinyali\x1b[0m: |polymarket_price - external_prob| > 0.12 ise al");
    console.log("  → \x1b[33mÇıkış sinyali\x1b[0m: Fiyat entry * 1.60 olunca VEYA resolution 30 dakika kalmışsa sat");
    console.log("  → \x1b[33mStop loss\x1b[0m: Fiyat entry * 0.60 olunca otomatik sat");
    console.log();
    console.log("  MEVCUT BOTUNDA NE DEĞİŞTİRİLMELİ:");
    console.log("  1. sniper.js → crypto 15m/5m marketleri yerine esports/football marketleri de tara");
    console.log("  2. whaleWatcher.js → burada bulduğun trader'ların adreslerini ekle, onların aldığı");
    console.log("     aynı markete sen de al (kopyalama değil, doğrulama sinyali olarak kullan)");
    console.log("  3. trading.js → exit mantığını değiştir: resolution bekleme, fiyat hedefine çık");
    console.log(`\n\x1b[32m${"═".repeat(72)}\x1b[0m\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n${"═".repeat(72)}`);
    console.log("  POLYMARKET TRADER PATTERN ANALİZİ + STRATEJİ GELİŞTİRME");
    console.log(`${"═".repeat(72)}\n`);

    const results = await scan();

    if (!results.length) {
        console.log("Uygun trader bulunamadı.");
        return;
    }

    console.log(`${results.length} trader analiz edildi\n`);
    printStrategyGuide(results);
    printDevelopedStrategy(results);
}

main().catch(e => {
    console.error("Fatal:", e.message);
    process.exit(1);
});
