import { CONFIG } from "../config.js";

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);
const DEFAULT_RPCS = ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"];
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export async function querySolanaRpc(method: string, params: unknown[], request: typeof fetch = fetch) {
  const urls = [...new Set(process.env.SOLANA_RPC_URLS?.split(",").map(x => x.trim()).filter(Boolean) || DEFAULT_RPCS)];
  for (const url of urls) {
    try {
      const call = async (name: string, args: unknown[]) => {
        const response = await request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: name, method: name, params: args }), signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error("RPC HTTP failure");
        const data: any = await response.json();
        if (data.error || !Object.hasOwn(data, "result")) throw new Error("RPC request failed");
        return data.result;
      };
      if (await call("getGenesisHash", []) !== MAINNET_GENESIS) continue;
      const result = await call(method, params);
      return { result, provider: new URL(url).origin };
    } catch { /* Continue to next mainnet provider. */ }
  }
  throw new SolanaScanError("RPC_UNAVAILABLE", "Confirmed mainnet RPC data could not be acquired", 503);
}

export class SolanaScanError extends Error {
  constructor(public code: string, message: string, public httpStatus: 400 | 404 | 503) { super(message); }
}

export function isSolanaMintAddress(value: string): boolean {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const char of value) { const digit = alphabet.indexOf(char); if (digit < 0) return false; decoded = decoded * 58n + BigInt(digit); }
  const leadingZeros = value.match(/^1*/)?.[0].length || 0;
  const bytes = decoded === 0n ? 0 : Math.ceil(decoded.toString(16).length / 2);
  return leadingZeros + bytes === 32;
}

export async function scanSolanaToken(
  token: string,
  options: { fetch?: typeof fetch; rpcUrls?: string[] } = {},
) {
  if (!isSolanaMintAddress(token)) throw new SolanaScanError("INVALID_TOKEN_ADDRESS", "Expected a 32-byte base58 Solana mint", 400);
  const request = options.fetch ?? fetch;
  const rpcUrls = [...new Set(options.rpcUrls ?? (process.env.SOLANA_RPC_URLS?.split(",").map(x => x.trim()).filter(Boolean) || DEFAULT_RPCS))];
  let account: any;
  let contextSlot: number | undefined;
  let nullResponses = 0;
  let source = "";
  for (const rpc of rpcUrls) {
    try {
      const genesisResponse = await request(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "genesis", method: "getGenesisHash", params: [] }), signal: AbortSignal.timeout(8000) });
      if (!genesisResponse.ok || (await genesisResponse.json() as any).result !== MAINNET_GENESIS) continue;
      const response = await request(rpc, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "scan", method: "getAccountInfo", params: [token, { encoding: "jsonParsed", commitment: "confirmed" }] }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const body: any = await response.json();
      if (body.error || !body.result || !Object.hasOwn(body.result, "value") || !Number.isSafeInteger(body.result.context?.slot) || body.result.context.slot < 0) continue;
      if (body.result.value === null) { nullResponses++; continue; }
      const candidate = body.result.value;
      // A malformed provider response must not become a false "mint missing" or a false successful analysis.
      if (!TOKEN_PROGRAMS.has(candidate.owner) || candidate.data?.parsed?.type !== "mint") {
        // Only a complete, parsed non-mint account establishes wrong account type.
        // An incomplete/malformed RPC payload must fail over instead of falsely rejecting a real mint.
        if (isSolanaMintAddress(candidate.owner) && typeof candidate.data?.parsed?.type === "string" && candidate.data.parsed.info && typeof candidate.data.parsed.info === "object") {
          throw new SolanaScanError("NOT_A_TOKEN_MINT", "Target account is not a supported SPL token mint", 400);
        }
        continue;
      }
      const info = candidate.data.parsed.info;
      if (!info || !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 255 || typeof info.supply !== "string" || !/^\d+$/.test(info.supply) ||
          !(info.mintAuthority === null || isSolanaMintAddress(info.mintAuthority)) || !(info.freezeAuthority === null || isSolanaMintAddress(info.freezeAuthority)) || info.isInitialized !== true) continue;
      account = candidate; contextSlot = body.result.context.slot; source = new URL(rpc).origin; break;
    } catch (error) {
      if (error instanceof SolanaScanError) throw error;
      // Transport errors, rate limits, JSON-RPC errors and invalid JSON try the next provider.
    }
  }
  if (!account) {
    // A single null amidst upstream failures is insufficient proof of absence.
    if (rpcUrls.length >= 2 && nullResponses === rpcUrls.length) {
      throw new SolanaScanError("MINT_NOT_FOUND", "Account absent at all configured confirmed mainnet providers", 404);
    }
    throw new SolanaScanError("RPC_UNAVAILABLE", "Mainnet providers could not establish the token mint; no payment should be collected", 503);
  }
  const info = account.data.parsed.info;
  let liquidityUsd: number | null = null;
  const pools: { address: string; dex: string; liquidity_usd: number }[] = [];
  try {
    const response = await request(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data: any = await response.json();
      if (Array.isArray(data.pairs)) {
        const seen = new Set<string>();
        for (const pair of data.pairs) {
          if (!pair || typeof pair !== "object") continue;
          if (pair.chainId !== "solana" || (pair.baseToken?.address !== token && pair.quoteToken?.address !== token) ||
              typeof pair.pairAddress !== "string" || seen.has(pair.pairAddress) || typeof pair.liquidity?.usd !== "number" ||
              !Number.isFinite(pair.liquidity.usd) || pair.liquidity.usd < 0) continue;
          seen.add(pair.pairAddress);
          pools.push({ address: pair.pairAddress, dex: String(pair.dexId || "unknown"), liquidity_usd: pair.liquidity.usd });
        }
        if (pools.length > 0) liquidityUsd = pools.reduce((sum, pair) => sum + pair.liquidity_usd, 0);
      }
    }
  } catch { /* Mint evidence remains usable; liquidity stays unknown, not zero. */ }
  return {
    status: "success", chain: "solana", network: CONFIG.solanaNetwork, token_address: token,
    is_honeypot: null, buy_tax_bps: null, sell_tax_bps: null,
    mint_authority_revoked: info.mintAuthority === null, freeze_authority_revoked: info.freezeAuthority === null,
    decimals: info.decimals, supply: info.supply, liquidity_usd: liquidityUsd,
    simulation_status: "not_performed", verdict: "INCONCLUSIVE_REQUIRES_SWAP_SIMULATION",
    risk_factors: ["BUY_SELL_EXECUTION_NOT_SIMULATED", ...(info.mintAuthority === null ? [] : ["MINT_AUTHORITY_ACTIVE"]), ...(info.freezeAuthority === null ? [] : ["FREEZE_AUTHORITY_ACTIVE"])],
    evidence: { mint: { provider: source, method: "getAccountInfo", commitment: "confirmed", slot: contextSlot, owner: account.owner }, liquidity: { provider: "DexScreener", status: liquidityUsd === null ? "unavailable" : "observed", pools } },
    timestamp: Math.floor(Date.now() / 1000),
  };
}
