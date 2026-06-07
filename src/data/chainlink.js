import { ethers } from "ethers";
import { CONFIG } from "../config.js";

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)"
];

const iface = new ethers.Interface(AGGREGATOR_ABI);

let preferredRpcUrl = null;

const MIN_FETCH_INTERVAL_MS = 2_000;
const RPC_TIMEOUT_MS = 1_500;

function getRpcCandidates() {
  const fromList = Array.isArray(CONFIG.chainlink.polygonRpcUrls) ? CONFIG.chainlink.polygonRpcUrls : [];
  const single = CONFIG.chainlink.polygonRpcUrl ? [CONFIG.chainlink.polygonRpcUrl] : [];
  const defaults = [
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
    "https://polygon.llamarpc.com"
  ];

  const all = [...fromList, ...single, ...defaults].map((s) => String(s).trim()).filter(Boolean);
  return Array.from(new Set(all));
}

function getOrderedRpcs() {
  const rpcs = getRpcCandidates();
  const pref = preferredRpcUrl;
  if (pref && rpcs.includes(pref)) {
    return [pref, ...rpcs.filter((x) => x !== pref)];
  }
  return rpcs;
}

async function jsonRpcRequest(rpcUrl, method, params) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`rpc_http_${res.status}`);
    }

    const data = await res.json();
    if (data.error) {
      throw new Error(`rpc_error_${data.error.code}`);
    }
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

async function ethCall(rpcUrl, to, data) {
  return await jsonRpcRequest(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

async function fetchDecimals(rpcUrl, aggregator) {
  const data = iface.encodeFunctionData("decimals", []);
  const result = await ethCall(rpcUrl, aggregator, data);
  const [dec] = iface.decodeFunctionResult("decimals", result);
  return Number(dec);
}

async function fetchLatestRoundData(rpcUrl, aggregator) {
  const data = iface.encodeFunctionData("latestRoundData", []);
  const result = await ethCall(rpcUrl, aggregator, data);
  const decoded = iface.decodeFunctionResult("latestRoundData", result);
  return {
    answer: decoded[1],
    updatedAt: decoded[3]
  };
}

const cacheMap = new Map(); // Key: aggregator, Value: { price, updatedAt, fetchedAtMs, decimals }

export async function fetchChainlinkPrice(aggregatorAddress) {
  if ((!CONFIG.chainlink.polygonRpcUrl && (!CONFIG.chainlink.polygonRpcUrls || CONFIG.chainlink.polygonRpcUrls.length === 0)) || !aggregatorAddress) {
    return { price: null, updatedAt: null, source: "missing_config" };
  }

  const now = Date.now();
  const cached = cacheMap.get(aggregatorAddress);

  if (cached && cached.fetchedAtMs && now - cached.fetchedAtMs < MIN_FETCH_INTERVAL_MS) {
    return { price: cached.price, updatedAt: cached.updatedAt, source: "chainlink_cache" };
  }

  const rpcs = getOrderedRpcs();
  if (rpcs.length === 0) return { price: null, updatedAt: null, source: "missing_config" };

  for (const rpc of rpcs) {
    preferredRpcUrl = rpc;
    try {
      let decimals = cached?.decimals;
      if (decimals == null) {
        decimals = await fetchDecimals(rpc, aggregatorAddress);
      }

      const round = await fetchLatestRoundData(rpc, aggregatorAddress);
      const answer = Number(round.answer);
      const scale = 10 ** Number(decimals);
      const price = answer / scale;

      const newCache = {
        price,
        updatedAt: Number(round.updatedAt) * 1000,
        fetchedAtMs: now,
        decimals,
        source: "chainlink"
      };

      cacheMap.set(aggregatorAddress, newCache);
      preferredRpcUrl = rpc;
      return { price: newCache.price, updatedAt: newCache.updatedAt, source: "chainlink" };
    } catch (e) {
      continue;
    }
  }

  return cached ? { price: cached.price, updatedAt: cached.updatedAt, source: "chainlink_stale" } : { price: null, updatedAt: null, source: "error" };
}
