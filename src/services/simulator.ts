import { isAddress, getAddress, erc20Abi } from "viem";
import { publicClient } from "./rpc.js";
import { simulateBuySell } from "./swap_simulation.js";

export interface ScanRequest { token_address: string; chain_id?: number; simulate_sell?: boolean; }
export interface ScanResponse {
  status: string; token: `0x${string}`; token_address: string; symbol: string; name: string; decimals: number;
  is_honeypot: boolean | null; buy_tax_bps: number | null; sell_tax_bps: number | null;
  liquidity_usd: number | null; risk_score: number | null; risk_factors: string[]; recommendation: string;
  simulation_status: string; attestation: null; timestamp: number; evidence: Record<string, unknown>;
  platform: string; in_bonding_curve: null;
}

// Injectable dependencies exercise actual provider payloads without payments or signing.
export async function scanToken(params: ScanRequest, dependencies: { client?: typeof publicClient; fetch?: typeof fetch; simulate?: typeof simulateBuySell } = {}): Promise<ScanResponse> {
  const address = params.token_address?.trim();
  if (!address || !isAddress(address)) throw new Error(`Invalid token address format: ${address}`);
  if (params.chain_id !== undefined && params.chain_id !== 8453) throw new Error("Only Base mainnet chain 8453 is supported by this scanner");
  const token = getAddress(address);
  const client = dependencies.client ?? publicClient;
  const request = dependencies.fetch ?? fetch;
  const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  if (chainId !== 8453) throw new Error("RPC chain mismatch: expected Base mainnet");
  const bytecode = await client.getBytecode({ address: token, blockNumber });
  if (!bytecode || bytecode === "0x") throw new Error("NO_CONTRACT_BYTECODE_AT_ADDRESS");
  const read = (functionName: "name" | "symbol" | "decimals" | "totalSupply") => client.readContract({ address: token, abi: erc20Abi, functionName, blockNumber });
  const [name, symbol, decimals, supply] = await Promise.all([read("name"), read("symbol"), read("decimals"), read("totalSupply")]);
  if (typeof name !== "string" || typeof symbol !== "string" || !Number.isInteger(Number(decimals)) || Number(decimals) < 0 || Number(decimals) > 255 || typeof supply !== "bigint") throw new Error("Invalid ERC20 metadata returned by RPC");
  const riskFactors = ["LP_LOCK_AND_HOLDER_DISTRIBUTION_NOT_VERIFIED"];
  const selectors = ["44337666", "815f949a", "c9567bf9", "d65377bf", "851bf54e"];
  if (selectors.some(selector => bytecode.toLowerCase().includes(selector))) riskFactors.push("BYTECODE_SELECTOR_HEURISTIC_REQUIRES_MANUAL_REVIEW");
  let liquidity: number | null = null;
  const pools: { address: string; dex: string; liquidity_usd: number }[] = [];
  try {
    const response = await request(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const body: any = await response.json();
      if (Array.isArray(body.pairs)) {
        const seen = new Set<string>();
        for (const pair of body.pairs) {
          if (!pair || typeof pair !== "object") continue;
          const addresses = [pair.baseToken?.address, pair.quoteToken?.address].filter(x => typeof x === "string").map(x => x.toLowerCase());
          if (pair.chainId !== "base" || !addresses.includes(token.toLowerCase()) || typeof pair.pairAddress !== "string" || seen.has(pair.pairAddress.toLowerCase()) || typeof pair.liquidity?.usd !== "number" || !Number.isFinite(pair.liquidity.usd) || pair.liquidity.usd < 0) continue;
          seen.add(pair.pairAddress.toLowerCase());
          pools.push({ address: pair.pairAddress, dex: String(pair.dexId || "unknown"), liquidity_usd: pair.liquidity.usd });
        }
        // No indexed matching pool is missing market evidence, not proof that the
        // token has zero on-chain liquidity (a supported RPC pool may still exist).
        if (pools.length > 0) liquidity = pools.reduce((sum, pool) => sum + pool.liquidity_usd, 0);
      }
    }
  } catch { /* Upstream failure does not establish zero liquidity or trading safety. */ }
  if (liquidity === null) riskFactors.push("LIQUIDITY_PROVIDER_UNAVAILABLE");
  const simulation = params.simulate_sell === false ? null : await (dependencies.simulate ?? simulateBuySell)(token, blockNumber, { client });
  if (!simulation || simulation.status !== "passed") riskFactors.push(simulation?.reason || "BUY_SELL_EXECUTION_NOT_SIMULATED");
  const completed = simulation?.status === "passed";
  return {
    status: "success", token, token_address: token, symbol, name, decimals: Number(decimals),
    is_honeypot: completed ? simulation.sell_tax_bps! >= 5000 : null,
    buy_tax_bps: simulation?.buy_tax_bps ?? null, sell_tax_bps: simulation?.sell_tax_bps ?? null, liquidity_usd: liquidity, risk_score: null,
    risk_factors: riskFactors, recommendation: completed ? "SELL_EXECUTED_IN_SCOPED_SIMULATION" : "INCONCLUSIVE_REQUIRES_SWAP_SIMULATION",
    simulation_status: params.simulate_sell === false ? "not_requested" : simulation?.status || "inconclusive",
    attestation: null, platform: "Unverified", in_bonding_curve: null,
    evidence: { rpc: { chain_id: chainId, block_number: blockNumber.toString(), methods: ["eth_getCode", "eth_call"], total_supply_raw: supply.toString() }, liquidity: { provider: "DexScreener", status: liquidity === null ? "unavailable" : "observed", pools }, simulation: simulation?.evidence || { requested: false, executed: false } },
    timestamp: Math.floor(Date.now() / 1000),
  };
}
