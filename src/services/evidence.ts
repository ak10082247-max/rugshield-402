import { erc20Abi, getAddress, parseAbi } from "viem";
import { CONFIG } from "../config.js";
import { publicClient } from "./rpc.js";
import { querySolanaRpc, isSolanaMintAddress } from "./solana_scan.js";

export async function liquidityLockEvidence(token: string, client: typeof publicClient = publicClient) {
  if (!token.startsWith("0x")) throw new Error("SOLANA_LP_LOCK_ACQUISITION_UNAVAILABLE");
  const address = getAddress(token);
  const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  if (chainId !== 8453) throw new Error("RPC_CHAIN_MISMATCH");
  const pair = await client.readContract({ address: CONFIG.dex.uniswapV2Factory, abi: parseAbi(["function getPair(address tokenA,address tokenB) view returns(address)"]), functionName: "getPair", args: [CONFIG.wethAddress, address], blockNumber });
  if (pair === "0x0000000000000000000000000000000000000000") throw new Error("NO_SUPPORTED_UNISWAP_V2_WETH_POOL");
  const [supply, zeroBalance, deadBalance] = await Promise.all([
    client.readContract({ address: pair, abi: erc20Abi, functionName: "totalSupply", blockNumber }),
    client.readContract({ address: pair, abi: erc20Abi, functionName: "balanceOf", args: ["0x0000000000000000000000000000000000000000"], blockNumber }),
    client.readContract({ address: pair, abi: erc20Abi, functionName: "balanceOf", args: ["0x000000000000000000000000000000000000dEaD"], blockNumber }),
  ]);
  if (supply <= 0n || zeroBalance + deadBalance > supply) throw new Error("INVALID_LP_BALANCE_EVIDENCE");
  return { status: "partial", fulfillment_complete: false, chain: "base", token_address: address, pool: pair,
    lp_locked_pct: null, is_rug_proof: null, unlock_timestamp: null,
    lp_total_supply_raw: supply.toString(), zero_address_lp_raw: zeroBalance.toString(), dead_address_lp_raw: deadBalance.toString(),
    burn_address_lp_pct: Number((zeroBalance + deadBalance) * 1_000_000n / supply) / 10_000,
    evidence: { chain_id: chainId, block_number: blockNumber.toString(), factory: CONFIG.dex.uniswapV2Factory, methods: ["getPair", "totalSupply", "balanceOf"], scope: "one Uniswap V2 WETH pool; balances at burn addresses only" },
    unavailable: ["other_dex_pools", "all_lp_owners", "locker_contract_and_beneficiary_verification", "vesting_and_unwrap_risks"] };
}

export async function tokenScreener(token: string, request: typeof fetch = fetch) {
  const chain = token.startsWith("0x") ? "base" : "solana";
  const response = await request(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("TOKEN_MARKET_PROVIDER_UNAVAILABLE");
  const body: any = await response.json();
  if (!Array.isArray(body.pairs)) throw new Error("TOKEN_MARKET_PROVIDER_INVALID_RESPONSE");
  const matches = (value: unknown) => typeof value === "string" && (chain === "base" ? value.toLowerCase() === token.toLowerCase() : value === token);
  const seen = new Set<string>();
  const pools = body.pairs.filter((pair: any) => {
    if (!pair || typeof pair !== "object") return false;
    if (pair.chainId !== chain || !matches(pair.baseToken?.address) || typeof pair.pairAddress !== "string" || seen.has(pair.pairAddress)) return false;
    seen.add(pair.pairAddress); return true;
  }).map((pair: any) => ({ pair_address: pair.pairAddress, dex: pair.dexId, token_address: pair.baseToken.address, symbol: pair.baseToken.symbol, quote_token: pair.quoteToken?.address,
    price_usd: typeof pair.priceUsd === "string" && pair.priceUsd.trim() !== "" && Number.isFinite(Number(pair.priceUsd)) && Number(pair.priceUsd) >= 0 ? pair.priceUsd : null,
    liquidity_usd: typeof pair.liquidity?.usd === "number" && Number.isFinite(pair.liquidity.usd) && pair.liquidity.usd >= 0 ? pair.liquidity.usd : null,
    volume_24h_usd: typeof pair.volume?.h24 === "number" && Number.isFinite(pair.volume.h24) && pair.volume.h24 >= 0 ? pair.volume.h24 : null,
    honeypot: null, smart_money_inflow_usd: null }));
  return { status: "partial", fulfillment_complete: false, chain, queried_token: token, pools, evidence: { provider: "DexScreener", acquired_at: new Date().toISOString() }, unavailable: ["honeypot_execution", "smart_money_identity_and_inflows"] };
}

export async function holderConcentration(token: string, query = querySolanaRpc) {
  if (token.startsWith("0x")) throw new Error("BASE_HOLDER_INDEXER_NOT_CONFIGURED");
  const [largest, supply] = await Promise.all([
    query("getTokenLargestAccounts", [token, { commitment: "confirmed" }]),
    query("getTokenSupply", [token, { commitment: "confirmed" }]),
  ]);
  const accounts = largest.result?.value;
  const rawSupply = supply.result?.value?.amount;
  if (!Array.isArray(accounts) || typeof rawSupply !== "string" || !/^\d+$/.test(rawSupply) || ![largest.result?.context?.slot, supply.result?.context?.slot].every(slot => Number.isSafeInteger(slot) && slot >= 0)) throw new Error("INVALID_HOLDER_PROVIDER_RESPONSE");
  const total = BigInt(rawSupply);
  const seen = new Set<string>();
  const rows = accounts.map((account: any) => {
    if (!account || !isSolanaMintAddress(account.address) || seen.has(account.address) || typeof account.amount !== "string" || !/^\d+$/.test(account.amount)) throw new Error("INVALID_HOLDER_PROVIDER_RESPONSE");
    seen.add(account.address);
    const amount = BigInt(account.amount);
    if (amount > total) throw new Error("INVALID_HOLDER_PROVIDER_RESPONSE");
    return { token_account: account.address, amount_raw: amount.toString(), pct_of_supply: total === 0n ? null : Number(amount * 1_000_000n / total) / 10_000 };
  }).sort((a: any, b: any) => BigInt(a.amount_raw) > BigInt(b.amount_raw) ? -1 : BigInt(a.amount_raw) < BigInt(b.amount_raw) ? 1 : 0);
  if (rows.reduce((sum: bigint, row: any) => sum + BigInt(row.amount_raw), 0n) > total) throw new Error("INCONSISTENT_HOLDER_SUPPLY_EVIDENCE");
  const top10 = rows.slice(0, 10).reduce((sum: bigint, account: any) => sum + BigInt(account.amount_raw), 0n);
  return { status: "partial", fulfillment_complete: false, chain: "solana", token_address: token,
    top_10_token_accounts_pct: total === 0n ? null : Number(top10 * 1_000_000n / total) / 10_000,
    token_accounts: rows, total_supply_raw: rawSupply, sybil_clusters_detected: null, lp_locked_pct: null,
    evidence: { accounts_provider: largest.provider, supply_provider: supply.provider, accounts_slot: largest.result.context.slot, supply_slot: supply.result.context.slot, methods: ["getTokenLargestAccounts", "getTokenSupply"], holder_identity: "token_accounts_are_not_aggregated_owners", slot_consistency: largest.result.context.slot === supply.result.context.slot ? "same_slot" : "different_slots_not_atomic" },
    unavailable: ["top_50_owners", "funding_origin_clusters", "lp_lock_verification"] };
}

export async function walletBalances(address: string) {
  if (address.startsWith("0x")) {
    const wallet = getAddress(address);
    const [chainId, blockNumber] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
    if (chainId !== 8453) throw new Error("RPC_CHAIN_MISMATCH");
    const [native, usdc] = await Promise.all([publicClient.getBalance({ address: wallet, blockNumber }), publicClient.readContract({ address: CONFIG.usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [wallet], blockNumber })]);
    return { status: "partial", fulfillment_complete: false, chain: "base", address: wallet, total_value_usd: null,
      balances: [{ asset: "ETH", decimals: 18, amount_raw: native.toString() }, { asset: CONFIG.usdcAddress, decimals: 6, amount_raw: usdc.toString() }],
      evidence: { chain_id: chainId, block_number: blockNumber.toString(), scope: "native_and_usdc_only" },
      unavailable: ["all_erc20_assets", "usd_valuation", "historical_pnl", "sanctions_and_drainer_screening"] };
  }
  const [native, spl, token2022] = await Promise.all([
    querySolanaRpc("getBalance", [address, { commitment: "confirmed" }]),
    querySolanaRpc("getTokenAccountsByOwner", [address, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed", commitment: "confirmed" }]),
    querySolanaRpc("getTokenAccountsByOwner", [address, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { encoding: "jsonParsed", commitment: "confirmed" }]),
  ]);
  if (!Number.isSafeInteger(native.result?.value) || native.result.value < 0 || !Array.isArray(spl.result?.value) || !Array.isArray(token2022.result?.value)) throw new Error("INVALID_BALANCE_PROVIDER_RESPONSE");
  const accounts = [...spl.result.value, ...token2022.result.value].map((account: any) => {
    const info = account.account?.data?.parsed?.info;
    if (!info || info.owner !== address || !isSolanaMintAddress(info.mint) || !isSolanaMintAddress(account.pubkey) || typeof info.tokenAmount?.amount !== "string" || !/^\d+$/.test(info.tokenAmount.amount) || !Number.isInteger(info.tokenAmount.decimals) || info.tokenAmount.decimals < 0 || info.tokenAmount.decimals > 255) throw new Error("INVALID_BALANCE_PROVIDER_RESPONSE");
    return { token_account: account.pubkey, asset: info.mint, amount_raw: info.tokenAmount.amount, decimals: info.tokenAmount.decimals };
  });
  return { status: "partial", fulfillment_complete: false, chain: "solana", address, total_value_usd: null,
    balances: [{ asset: "SOL", amount_raw: String(native.result.value), decimals: 9 }, ...accounts],
    evidence: { commitment: "confirmed", native_slot: native.result.context.slot, spl_slot: spl.result.context.slot, token2022_slot: token2022.result.context.slot },
    unavailable: ["usd_valuation", "historical_pnl", "sanctions_and_drainer_screening"] };
}
