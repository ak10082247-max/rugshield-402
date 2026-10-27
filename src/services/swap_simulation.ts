import { randomBytes, createHash } from "node:crypto";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, parseAbi, toHex, type Address } from "viem";
import { publicClient } from "./rpc.js";
import { CONFIG } from "../config.js";

// Official deployments: https://developers.uniswap.org/docs/protocols/v2/deployments
const ROUTER = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24" as Address;
const FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const ETH_LOG = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const routerAbi = parseAbi([
  "function factory() view returns (address)", "function WETH() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
]);
const factoryAbi = parseAbi(["function getPair(address tokenA,address tokenB) view returns(address)"]);

export interface SwapSimulation {
  status: "passed" | "inconclusive"; reason?: string; buy_tax_bps: number | null; sell_tax_bps: number | null;
  evidence: Record<string, unknown>;
}
const inconclusive = (reason: string, evidence: Record<string, unknown> = {}): SwapSimulation => ({ status: "inconclusive", reason, buy_tax_bps: null, sell_tax_bps: null, evidence });

/** Stateful, unsigned RPC simulation only. No eth_send*, private key, approval transaction or funded wallet is used. */
export async function simulateBuySell(token: Address, blockNumber: bigint, dependencies: { client?: typeof publicClient; request?: (payload: any) => Promise<any>; trader?: Address } = {}): Promise<SwapSimulation> {
  if (token.toLowerCase() === CONFIG.wethAddress.toLowerCase()) return inconclusive("WRAPPED_NATIVE_REQUIRES_DIFFERENT_PATH");
  const client = dependencies.client ?? publicClient;
  const trader = dependencies.trader ?? (`0x${randomBytes(20).toString("hex")}` as Address);
  const amount = 1_000_000_000_000_000n; // Precisely disclosed 0.001 ETH; not a user-sized trade recommendation.
  const path = [CONFIG.wethAddress, token];
  let pair: Address;
  let block: any;
  try {
    const [factory, weth, acquiredPair, acquiredBlock, chainId] = await Promise.all([
      client.readContract({ address: ROUTER, abi: routerAbi, functionName: "factory", blockNumber }),
      client.readContract({ address: ROUTER, abi: routerAbi, functionName: "WETH", blockNumber }),
      client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "getPair", args: [CONFIG.wethAddress, token], blockNumber }),
      client.getBlock({ blockNumber }),
      client.getChainId(),
    ]);
    if (chainId !== 8453 || acquiredBlock.number !== blockNumber || !/^0x[0-9a-fA-F]{64}$/.test(acquiredBlock.hash || "")) return inconclusive("RPC_CHAIN_OR_BLOCK_MISMATCH");
    if (factory.toLowerCase() !== FACTORY.toLowerCase() || weth.toLowerCase() !== CONFIG.wethAddress.toLowerCase()) return inconclusive("ROUTER_DEPLOYMENT_MISMATCH");
    if (acquiredPair === ZERO) return inconclusive("NO_SUPPORTED_UNISWAP_V2_WETH_POOL");
    pair = acquiredPair; block = acquiredBlock;
  } catch { return inconclusive("SIMULATION_POOL_ACQUISITION_FAILED"); }

  const send = dependencies.request ?? (async (payload: any) => {
    // viem publicClient transport handles configured RPC failover. This method never broadcasts.
    return (client.request as any)({ method: "eth_simulateV1", params: [payload, toHex(blockNumber)] });
  });
  const call = (to: Address, data: `0x${string}`, value = 0n) => ({ from: trader, to, data, value: toHex(value), gas: "0x4c4b40", gasPrice: "0x0" });
  const balance = call(token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [trader] }));
  const buyQuote = call(ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "getAmountsOut", args: [amount, path] }));
  const buy = call(ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [0n, path, trader, BigInt(block.timestamp) + 300n] }), amount);
  const payload = (calls: any[]) => ({ validation: false, traceTransfers: true, blockStateCalls: [{ blockOverrides: { baseFeePerGas: "0x0", time: toHex(BigInt(block.timestamp) + 12n) }, stateOverrides: { [trader]: { balance: toHex(amount * 100n), nonce: "0x0" } }, calls }] });
  const uint = (result: any) => {
    if (!result || result.status !== "0x1" || !/^0x[0-9a-fA-F]{64}$/.test(result.returnData || "")) throw new Error("Invalid uint result");
    return BigInt(result.returnData);
  };
  const quote = (result: any) => {
    if (!result || result.status !== "0x1") throw new Error("Quote failed");
    const amounts = decodeFunctionResult({ abi: routerAbi, functionName: "getAmountsOut", data: result.returnData });
    if (amounts.length !== 2 || amounts[1] <= 0n) throw new Error("Invalid quote");
    return amounts[1];
  };
  const provenance = { method: "eth_simulateV1", network: "eip155:8453", parent_block_number: blockNumber.toString(), parent_block_hash: block.hash, router: ROUTER, factory: FACTORY, pool: pair, trader, input_wei: amount.toString(), input_eth: "0.001", path, overrides: "only virtual trader ETH balance and nonce; no token storage or code overrides", scope: "one pool, one size, one fresh virtual trader; excludes future behavior and global token safety" };
  const validEnvelope = (result: any) => {
    if (!Array.isArray(result) || result.length !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(result[0]?.hash || "") || result[0].parentHash?.toLowerCase() !== block.hash?.toLowerCase()) return false;
    try { return BigInt(result[0].number) === blockNumber + 1n && BigInt(result[0].timestamp) === BigInt(block.timestamp) + 12n; } catch { return false; }
  };
  try {
    const discovery = await send(payload([balance, buyQuote, buy, balance]));
    if (!validEnvelope(discovery)) return inconclusive("SIMULATION_BLOCK_ENVELOPE_MISMATCH", provenance);
    const initial = discovery?.[0]?.calls;
    if (!Array.isArray(initial) || initial.length !== 4 || initial.some((item: any) => item.status !== "0x1")) return inconclusive("BUY_SIMULATION_FAILED_OR_UNSUPPORTED", provenance);
    if (uint(initial[0]) !== 0n) return inconclusive("VIRTUAL_TRADER_HAS_EXISTING_TOKEN_BALANCE", provenance);
    const bought = uint(initial[3]);
    const expectedBuy = quote(initial[1]);
    if (bought <= 0n || bought > expectedBuy) return inconclusive("UNEXPECTED_BUY_BALANCE_DELTA", provenance);
    const approve = call(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, bought] }));
    const sellQuote = call(ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "getAmountsOut", args: [bought, [token, CONFIG.wethAddress]] }));
    const sell = call(ROUTER, encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [bought, 0n, [token, CONFIG.wethAddress], trader, BigInt(block.timestamp) + 300n] }));
    const fullPayload = payload([balance, buyQuote, buy, balance, approve, sellQuote, sell, balance]);
    const full = await send(fullPayload);
    if (!validEnvelope(full)) return inconclusive("SIMULATION_BLOCK_ENVELOPE_MISMATCH", provenance);
    const results = full?.[0]?.calls;
    if (!Array.isArray(results) || results.length !== 8 || results.some((item: any) => item.status !== "0x1")) return inconclusive("SELL_OR_APPROVAL_SIMULATION_FAILED_OR_UNSUPPORTED", { ...provenance, calls: results ?? null });
    if (uint(results[0]) !== 0n || uint(results[3]) !== bought || quote(results[1]) !== expectedBuy || uint(results[7]) !== 0n) return inconclusive("STATEFUL_SIMULATION_BALANCE_MISMATCH", provenance);
    const expectedSell = quote(results[5]);
    let received = 0n;
    for (const log of results[6].logs || []) {
      if (log.address?.toLowerCase() === ETH_LOG && log.topics?.[0]?.toLowerCase() === TRANSFER &&
          log.topics?.[1]?.slice(-40).toLowerCase() === ROUTER.slice(2).toLowerCase() && log.topics?.[2]?.slice(-40).toLowerCase() === trader.slice(2).toLowerCase() && /^0x[0-9a-fA-F]{64}$/.test(log.data || "")) received += BigInt(log.data);
    }
    if (received <= 0n || received > expectedSell) return inconclusive("SELL_PROCEEDS_NOT_ESTABLISHED", provenance);
    // Conservative ceiling to bps, with exact raw numerator/denominator retained in evidence.
    const bps = (expected: bigint, actual: bigint) => Number(((expected - actual) * 10_000n + expected - 1n) / expected);
    return { status: "passed", buy_tax_bps: bps(expectedBuy, bought), sell_tax_bps: bps(expectedSell, received), evidence: { ...provenance,
      expected_buy_raw: expectedBuy.toString(), received_buy_raw: bought.toString(), expected_sell_wei: expectedSell.toString(), received_sell_wei: received.toString(),
      calls: results, request_sha256: createHash("sha256").update(JSON.stringify(fullPayload)).digest("hex"), simulated_block_hash: full[0].hash,
      simulated_block: { hash: full[0].hash, parent_hash: full[0].parentHash, number: full[0].number, timestamp: full[0].timestamp },
      fee_basis: "Router getAmountsOut at each respective simulated state; pool fees and price impact excluded from transfer-tax comparison" } };
  } catch { return inconclusive("STATEFUL_SIMULATION_RPC_UNAVAILABLE_OR_INVALID", provenance); }
}
