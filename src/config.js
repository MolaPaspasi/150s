import * as dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  symbol: "BTCUSDT", // Default, will be overridden by ASSETS
  binanceBaseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 1_000,
  candleWindowMinutes: 15,

  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,

  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  // ASSET CONFIGURATION
  // User can select which to run via .env: ACTIVE_ASSETS=BTC,ETH,SOL,DOGE
  activeAssets: (process.env.ACTIVE_ASSETS || "BTC").toUpperCase().split(",").map(s => s.trim()).filter(Boolean),

  assets: {
    BTC: {
      symbol: "BTCUSDT",
      polymarket: {
        seriesSlug: "btc-up-or-down-15m",
        seriesId: "10192",
        eventSlugPrefix: "btc-updown-15m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket5m: {
        seriesSlug: "btc-up-or-down-5m",
        seriesId: "10684",
        eventSlugPrefix: "btc-updown-5m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket4h: {
        seriesId: "10331",
        eventSlugPrefix: "btc-updown-4h",
        upLabel: "Up",
        downLabel: "Down"
      },
      chainlink: {
        aggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
      }
    },
    ETH: {
      symbol: "ETHUSDT",
      polymarket: {
        seriesSlug: "eth-up-or-down-15m",
        seriesId: "10191",
        eventSlugPrefix: "eth-updown-15m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket5m: {
        seriesSlug: "eth-up-or-down-5m",
        seriesId: "10683",
        eventSlugPrefix: "eth-updown-5m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket4h: {
        seriesId: "10332",
        eventSlugPrefix: "eth-updown-4h",
        upLabel: "Up",
        downLabel: "Down"
      },
      chainlink: {
        aggregator: process.env.CHAINLINK_ETH_USD_AGGREGATOR || "0xF9680D99D6C9589e2a93a78A04A279771948601E"
      }
    },
    SOL: {
      symbol: "SOLUSDT",
      polymarket: {
        seriesSlug: "sol-up-or-down-15m",
        seriesId: "10423",
        eventSlugPrefix: "sol-updown-15m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket5m: {
        seriesSlug: "sol-up-or-down-5m",
        seriesId: "10686",
        eventSlugPrefix: "sol-updown-5m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket4h: {
        seriesId: "10333",
        eventSlugPrefix: "sol-updown-4h",
        upLabel: "Up",
        downLabel: "Down"
      },
      chainlink: {
        aggregator: process.env.CHAINLINK_SOL_USD_AGGREGATOR || "0x1d36d4B30A588722a4667a425337E1C7eD4B5718"
      }
    },
    DOGE: {
      symbol: "DOGEUSDT",
      polymarket: {
        seriesSlug: "doge-up-or-down-15m",
        seriesId: "11328",
        eventSlugPrefix: "doge-updown-15m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket5m: {
        seriesSlug: "doge-up-or-down-5m",
        seriesId: "11325",
        eventSlugPrefix: "doge-updown-5m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket4h: {
        seriesId: "11331",
        eventSlugPrefix: "doge-updown-4h",
        upLabel: "Up",
        downLabel: "Down"
      },
      chainlink: {
        aggregator: process.env.CHAINLINK_DOGE_USD_AGGREGATOR || "0xbaf9327b6564454F4a3364C33eFeEf032b4b4444"
      }
    },
    XRP: {
      symbol: "XRPUSDT",
      polymarket: {
        seriesSlug: "xrp-up-or-down-15m",
        seriesId: "10422",
        eventSlugPrefix: "xrp-updown-15m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket5m: {
        seriesSlug: "xrp-up-or-down-5m",
        seriesId: "10685",
        eventSlugPrefix: "xrp-updown-5m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket4h: {
        seriesId: "10327",
        eventSlugPrefix: "xrp-updown-4h",
        upLabel: "Up",
        downLabel: "Down"
      },
      chainlink: {
        aggregator: process.env.CHAINLINK_XRP_USD_AGGREGATOR || "0x8d5E29FF3B3f55D58AbB165EA9Ce3886C0A43Fc7"
      }
    },
    BNB: {
      symbol: "BNBUSDT",
      polymarket: {
        seriesSlug: "bnb-up-or-down-15m",
        seriesId: "11330",
        eventSlugPrefix: "bnb-updown-15m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket5m: {
        seriesSlug: "bnb-up-or-down-5m",
        seriesId: "11326",
        eventSlugPrefix: "bnb-updown-5m",
        upLabel: "Up",
        downLabel: "Down"
      },
      polymarket4h: {
        seriesId: "11332",
        eventSlugPrefix: "bnb-updown-4h",
        upLabel: "Up",
        downLabel: "Down"
      },
      chainlink: {
        aggregator: process.env.CHAINLINK_BNB_USD_AGGREGATOR || ""
      }
    }

  },

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "", // Legacy/Override for single market mode
    seriesId: process.env.POLYMARKET_SERIES_ID || "10192", // DEPRECATED for multi-asset? Keep for legacy
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com"
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "https://polygon.drpc.org,https://1rpc.io/matic").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon.drpc.org",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || ""
  },
  trading: {
    enabled: (process.env.TRADING_ENABLED || "false").toLowerCase() === "true",
    amountUsdc: parseFloat(process.env.TRADE_AMOUNT_USDC || "20"),
    privateKey: process.env.PRIVATE_KEY || "",
    apiKey: process.env.POLY_API_KEY || "",
    apiSecret: process.env.POLY_API_SECRET || "",
    apiPassphrase: process.env.POLY_API_PASSPHRASE || "",
    amountPercentage: parseFloat(process.env.TRADE_AMOUNT_PERCENTAGE || "0"),
    longThreshold: parseFloat(process.env.LONG_THRESHOLD || "70"),
    shortThreshold: parseFloat(process.env.SHORT_THRESHOLD || "70"),
    minTimeLeftSeconds: parseInt(process.env.MIN_TIME_LEFT_SECONDS || "30"),
    maxTimeLeftSeconds: parseInt(process.env.MAX_TIME_LEFT_SECONDS || "300"),
    copyWallets: (process.env.COPY_WALLETS || "").split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    copyTradingEnabled: (process.env.COPY_TRADING_ENABLED || "false").toLowerCase() === "true",
    copyMaxAmountUsdc: parseFloat(process.env.COPY_MAX_AMOUNT_USDC || "0") || null,
    // Kelly sizing (Roan: "position size correlates with edge magnitude")
    useKelly: (process.env.TRADING_USE_KELLY || "true").toLowerCase() === "true",
    kellyFraction: Math.max(0.1, Math.min(1, parseFloat(process.env.TRADING_KELLY_FRACTION || "0.2"))),
    kellyMaxPct: Math.max(0.05, Math.min(0.5, parseFloat(process.env.TRADING_KELLY_MAX_PCT || "0.1")))
  },
  positionManager: {
    enabled: (process.env.POSITION_MANAGER_ENABLED || "true").toLowerCase() === "true",
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "50"),   // sell when +50% gain on token price
    stopLossPct:   parseFloat(process.env.STOP_LOSS_PCT   || "35"),   // sell when -35% loss on token price
  },
  arbitrage: {
    enabled: (process.env.ENABLE_ARBITRAGE || "false").toLowerCase() === "true",
    minProfit: parseFloat(process.env.MIN_ARBITRAGE_PROFIT || "0.05")
  },
  sniper: {
    enabled: (process.env.ENABLE_SNIPER || "true").toLowerCase() === "true",
    windowSeconds: parseInt(process.env.SNIPE_WINDOW_SECONDS || "60"),
    maxPrice: parseFloat(process.env.SNIPE_MAX_PRICE || "0.88"),
    minPrice: parseFloat(process.env.SNIPE_MIN_PRICE || "0.80"),
    minConfidence: parseFloat(process.env.SNIPE_MIN_CONFIDENCE || "0.0005"),
    minConfidencePerAsset: {
      ETH:  0.0015, // ≥0.15% — 119 trades, 100% WR (vs 99.4% at 0.10%)
      SOL:  0.0025, // ≥0.25% — 125 trades, 100% WR (vs 98.7% at 0.20%)
      DOGE: 0.004,  // ≥0.40% — 51 trades,  100% WR (vs 95.8% at 0.05%)
      XRP:  0.005,  // ≥0.50% — 38 trades,  100% WR (vs 91.5% at 0.05%)
    },
    minProfitPct: parseFloat(process.env.SNIPE_MIN_PROFIT_PCT || "0.08"),
    enabled5m: (process.env.ENABLE_5M_SNIPER || "true").toLowerCase() === "true",
    amount5mUsdc: parseFloat(process.env.SNIPE_5M_AMOUNT_USDC || "5"),
    windowSeconds5m: parseInt(process.env.SNIPE_5M_WINDOW_SECONDS || "90"),
    minPrice5m: parseFloat(process.env.SNIPE_5M_MIN_PRICE || "0.05"),
    maxPrice5m: parseFloat(process.env.SNIPE_5M_MAX_PRICE || "0.92"),
    minConfidence5m: parseFloat(process.env.SNIPE_5M_MIN_CONFIDENCE || "0.001"),
    maxConsecLosses5m: parseInt(process.env.SNIPE_5M_MAX_CONSEC_LOSSES || "2"),
    enabled4h: (process.env.ENABLE_4H_SNIPER || "true").toLowerCase() === "true",
    amount4hUsdc: parseFloat(process.env.SNIPE_4H_AMOUNT_USDC || "30"),
    windowSeconds4h: parseInt(process.env.SNIPE_4H_WINDOW_SECONDS || "75"),
    minPrice4h: parseFloat(process.env.SNIPE_4H_MIN_PRICE || "0.80"),
    maxPrice4h: parseFloat(process.env.SNIPE_4H_MAX_PRICE || "0.95"),
    minConfidence4h: parseFloat(process.env.SNIPE_4H_MIN_CONFIDENCE || "0.0025"),
    maxConsecLosses4h: parseInt(process.env.SNIPE_4H_MAX_CONSEC_LOSSES || "3")
  },
  whaleStyle: {
    enabled: (process.env.WHALE_STYLE_ENABLED || "true").toLowerCase() === "true",
    windowMinMinutes: parseFloat(process.env.WHALE_STYLE_WINDOW_MIN_MINUTES || "0.5"),
    windowMaxMinutes: parseFloat(process.env.WHALE_STYLE_WINDOW_MAX_MINUTES || "5"),
    // Removed hard 0.50 cap — any price is valid if edge > fee + margin (fee ~1.4% at 90c)
    maxAskPrice: parseFloat(process.env.WHALE_STYLE_MAX_ASK_PRICE || "0.97"),
    // Lowered from 0.20 to 0.07 — pairs with better z-score model; 0.20 was too restrictive
    minEdge: parseFloat(process.env.WHALE_STYLE_MIN_EDGE || "0.07"),
    requireBollingerConfirm: (process.env.WHALE_STYLE_REQUIRE_BOLLINGER || "true").toLowerCase() === "true",
    // Volume surge on 1m candles is noise for 15m outcomes — disabled by default
    requireVolumeSurge: (process.env.WHALE_STYLE_REQUIRE_VOLUME_SURGE || "false").toLowerCase() === "true",
    volumeSurgeMultiplier: parseFloat(process.env.WHALE_STYLE_VOLUME_SURGE_MULT || "1.5")
  },
  scalper: {
    enabled: (process.env.ENABLE_SCALPER || "false").toLowerCase() === "true",
    minProfit: parseFloat(process.env.SCALPER_MIN_PROFIT || "0.05")
  },
  twoLegArb: {
    enabled: (process.env.ENABLE_TWO_LEG_ARB || "false").toLowerCase() === "true",
    shares: Math.max(1, parseInt(process.env.TWO_LEG_SHARES || "3", 10)),
    sumTarget: Math.max(0.80, Math.min(0.95, parseFloat(process.env.TWO_LEG_SUM_TARGET || "0.90"))),
    move: Math.max(0.05, Math.min(0.50, parseFloat(process.env.TWO_LEG_MOVE || "0.15"))),
    windowMin: Math.max(1, Math.min(15, parseFloat(process.env.TWO_LEG_WINDOW_MIN || "4")))
  },
  // Arena paper trading (PolymarketScan simulator — set ARENA_AGENT_ID to enable)
  arena: {
    agentId: process.env.ARENA_AGENT_ID || ""
  },
  // Circuit breaker: stop trading if daily loss exceeds threshold
  circuitBreaker: {
    maxDailyLossPct: parseFloat(process.env.MAX_DAILY_LOSS_PCT || "10"),
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || "3", 10),
    minBalanceUsdc: parseFloat(process.env.MIN_BALANCE_USDC || "0")
  }
};
