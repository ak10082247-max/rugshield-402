import {
  isSolanaMintAddress,
  querySolanaRpc,
  scanSolanaToken,
  SolanaScanError,
} from "./solana_scan.js";

export const SOLANA_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface Token2022Inspection {
  program: "spl-token" | "token-2022" | string;
  extensionNames: string[];
  transferFeeBps: number;
  newerTransferFeeBps: number | null;
  olderTransferFeeBps: number | null;
  newerTransferFeeEpoch: number | null;
  maximumFeeRaw: string | null;
  transferHookProgramId: string | null;
  permanentDelegate: string | null;
  nonTransferable: boolean;
  defaultAccountState: string | null;
  paused: boolean;
  mintCloseAuthority: string | null;
  epochChecked: number | null;
}

export interface DexQuoteLeg {
  provider: "Jupiter" | "Raydium";
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outAmount: bigint;
  priceImpactPct: number;
  poolFeeEstimateBps: number;
  routeLabels: string[];
}

export interface SolanaRoundTripTier {
  label: string;
  quote_mint: string;
  input_amount_raw: string;
  buy_out_amount_raw: string | null;
  sell_out_amount_raw: string | null;
  buy_provider: string | null;
  sell_provider: string | null;
  buy_route: string[];
  sell_route: string[];
  round_trip_loss_bps: number | null;
  estimated_dex_spread_bps: number | null;
}

export interface SolanaSimulationDependencies {
  rpcQuery?: typeof querySolanaRpc;
  fetch?: typeof fetch;
}

type QuoteOutcome =
  | { ok: true; quote: DexQuoteLeg }
  | { ok: false; kind: "no_route" | "provider_error"; errors: string[] };

function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

async function quoteJupiter(
  inputMint: string,
  outputMint: string,
  amount: string,
  request: typeof fetch,
): Promise<{ ok: true; quote: DexQuoteLeg } | { ok: false; kind: "no_route" | "provider_error"; error: string }> {
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${encodeURIComponent(amount)}&slippageBps=500`;
  try {
    const response = await request(url, { signal: AbortSignal.timeout(7000) });
    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {}
    if (!response.ok) {
      const code = String(body?.errorCode || body?.error || `HTTP_${response.status}`);
      if (
        response.status === 400 &&
        /TOKEN_NOT_TRADABLE|NO_ROUTES_FOUND|COULD_NOT_FIND_ANY_ROUTE|ROUTE_NOT_FOUND|NOT_SUPPORTED/i.test(code)
      ) {
        return { ok: false, kind: "no_route", error: `Jupiter: ${code}` };
      }
      return { ok: false, kind: "provider_error", error: `Jupiter HTTP ${response.status}: ${code}` };
    }
    if (!body || !isDecimalString(String(body.outAmount))) {
      return { ok: false, kind: "provider_error", error: "Jupiter returned malformed outAmount" };
    }
    const outAmount = BigInt(body.outAmount);
    if (outAmount <= 0n) {
      return { ok: false, kind: "no_route", error: "Jupiter returned zero output" };
    }
    const routePlan = Array.isArray(body.routePlan) ? body.routePlan : [];
    const routeLabels = routePlan
      .map((hop: any) => String(hop?.swapInfo?.label || "unknown"))
      .filter(Boolean);
    const platformFeeBps = Number(body.platformFee?.feeBps || 0);
    // Estimate baseline DEX fee when routePlan omits feeAmount (~25 bps per hop bounded reasonably)
    let estimatedHopFeeBps = 0;
    for (const hop of routePlan) {
      const feeAmt = hop?.swapInfo?.feeAmount;
      const inAmt = hop?.swapInfo?.inAmount;
      if (isDecimalString(String(feeAmt)) && isDecimalString(String(inAmt)) && BigInt(inAmt) > 0n) {
        estimatedHopFeeBps += Number((BigInt(feeAmt) * 10000n) / BigInt(inAmt));
      } else {
        estimatedHopFeeBps += 25;
      }
    }
    const priceImpactPct = Number(body.priceImpactPct);
    return {
      ok: true,
      quote: {
        provider: "Jupiter",
        inputMint,
        outputMint,
        inputAmount: amount,
        outAmount,
        priceImpactPct: Number.isFinite(priceImpactPct) ? Math.max(0, priceImpactPct) : 0,
        poolFeeEstimateBps: Math.max(0, Math.round(estimatedHopFeeBps + (Number.isFinite(platformFeeBps) ? platformFeeBps : 0))),
        routeLabels: routeLabels.length ? [...new Set<string>(routeLabels)] : ["Jupiter"],
      },
    };
  } catch (error: any) {
    return { ok: false, kind: "provider_error", error: `Jupiter request failed: ${error?.message || "timeout"}` };
  }
}

async function quoteRaydium(
  inputMint: string,
  outputMint: string,
  amount: string,
  request: typeof fetch,
): Promise<{ ok: true; quote: DexQuoteLeg } | { ok: false; kind: "no_route" | "provider_error"; error: string }> {
  const url = `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${encodeURIComponent(amount)}&slippageBps=500&txVersion=V0`;
  try {
    const response = await request(url, { signal: AbortSignal.timeout(7000) });
    const text = await response.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {}
    if (!response.ok) {
      return { ok: false, kind: "provider_error", error: `Raydium HTTP ${response.status}` };
    }
    if (!body || body.success !== true || !body.data || !isDecimalString(String(body.data.outputAmount))) {
      const msg = String(body?.msg || "NO_ROUTE");
      if (/INSUFFICIENT|NOT_FOUND|ROUTE/i.test(msg)) {
        return { ok: false, kind: "no_route", error: `Raydium: ${msg}` };
      }
      return { ok: false, kind: "provider_error", error: `Raydium: ${msg}` };
    }
    const outAmount = BigInt(body.data.outputAmount);
    if (outAmount <= 0n) {
      return { ok: false, kind: "no_route", error: "Raydium returned zero output" };
    }
    const routePlan = Array.isArray(body.data.routePlan) ? body.data.routePlan : [];
    const poolFeeEstimateBps = routePlan.reduce((sum: number, hop: any) => {
      const rate = Number(hop?.feeRate);
      return sum + (Number.isFinite(rate) && rate >= 0 ? rate : 25);
    }, 0);
    const priceImpactPct = Number(body.data.priceImpactPct);
    return {
      ok: true,
      quote: {
        provider: "Raydium",
        inputMint,
        outputMint,
        inputAmount: amount,
        outAmount,
        priceImpactPct: Number.isFinite(priceImpactPct) ? Math.max(0, priceImpactPct) : 0,
        poolFeeEstimateBps: Math.round(poolFeeEstimateBps),
        routeLabels: ["Raydium"],
      },
    };
  } catch (error: any) {
    return { ok: false, kind: "provider_error", error: `Raydium request failed: ${error?.message || "timeout"}` };
  }
}

async function acquireDexQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  request: typeof fetch,
): Promise<QuoteOutcome> {
  const jup = await quoteJupiter(inputMint, outputMint, amount, request);
  if (jup.ok) return jup;
  const ray = await quoteRaydium(inputMint, outputMint, amount, request);
  if (ray.ok) return ray;
  // Treat as definitive no_route ONLY when at least one engine checked cleanly with no_route and neither errored ambiguously,
  // or both cleanly reported no_route. If either hit provider_error (e.g. 429/timeout) without the other proving no_route cleanly, mark provider_error.
  const errors = [jup.error, ray.error];
  if (jup.kind === "no_route" && ray.kind === "no_route") {
    return { ok: false, kind: "no_route", errors };
  }
  return { ok: false, kind: "provider_error", errors };
}

export async function inspectToken2022Extensions(
  mint: string,
  rpcQuery: typeof querySolanaRpc = querySolanaRpc,
): Promise<{
  inspection: Token2022Inspection;
  slot: number | null;
  provider: string | null;
}> {
  const infoRes = await rpcQuery("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const account = infoRes.result?.value;
  if (!account || typeof account !== "object") {
    throw new SolanaScanError("TOKEN_NOT_FOUND_ON_SOLANA", "No Solana mint account exists at that address", 404);
  }
  const parsedInfo = account?.data?.parsed?.info || {};
  const owner = String(account.owner || SPL_TOKEN_PROGRAM);
  const rawExtensions = Array.isArray(parsedInfo.extensions) ? parsedInfo.extensions : [];
  const extensionNames = rawExtensions
    .map((e: any) => String(e?.extension || ""))
    .filter(Boolean);

  let transferFeeBps = 0;
  let newerTransferFeeBps: number | null = null;
  let olderTransferFeeBps: number | null = null;
  let newerTransferFeeEpoch: number | null = null;
  let maximumFeeRaw: string | null = null;
  let transferHookProgramId: string | null = null;
  let permanentDelegate: string | null = null;
  let nonTransferable = false;
  let defaultAccountState: string | null = null;
  let paused = false;
  let mintCloseAuthority: string | null = null;
  let epochChecked: number | null = null;

  for (const ext of rawExtensions) {
    if (!ext || typeof ext !== "object") continue;
    const name = String(ext.extension || "");
    const state = ext.state && typeof ext.state === "object" ? ext.state : {};
    if (name === "transferFeeConfig") {
      const newerBps = Number(state.newerTransferFee?.transferFeeBasisPoints ?? 0);
      const olderBps = Number(state.olderTransferFee?.transferFeeBasisPoints ?? 0);
      const newerEpoch = Number(state.newerTransferFee?.epoch ?? 0);
      newerTransferFeeBps = Number.isFinite(newerBps) ? newerBps : null;
      olderTransferFeeBps = Number.isFinite(olderBps) ? olderBps : null;
      newerTransferFeeEpoch = Number.isFinite(newerEpoch) ? newerEpoch : null;
      try {
        const ep = await rpcQuery("getEpochInfo", []);
        if (typeof ep.result?.epoch === "number") {
          const currentEpoch = ep.result.epoch;
          epochChecked = currentEpoch;
          const activeFee = currentEpoch >= newerEpoch ? state.newerTransferFee : state.olderTransferFee;
          transferFeeBps = Math.max(0, Math.min(10000, Number(activeFee?.transferFeeBasisPoints ?? 0)));
          if (activeFee?.maximumFee !== undefined) maximumFeeRaw = String(activeFee.maximumFee);
        }
      } catch {
        // If getEpochInfo is unavailable on a failover endpoint, use the stricter observed fee rate.
        transferFeeBps = Math.max(0, Math.min(10000, Math.max(newerBps || 0, olderBps || 0)));
      }
      if (epochChecked === null) {
        transferFeeBps = Math.max(0, Math.min(10000, Math.max(newerBps || 0, olderBps || 0)));
      }
    } else if (name === "transferHook") {
      transferHookProgramId = typeof state.programId === "string" ? state.programId : null;
    } else if (name === "permanentDelegate") {
      permanentDelegate = typeof state.delegate === "string" ? state.delegate : null;
    } else if (name === "nonTransferable") {
      nonTransferable = true;
    } else if (name === "defaultAccountState") {
      defaultAccountState = typeof state.state === "string" ? state.state : null;
    } else if (name === "pausable") {
      paused = state.paused === true;
    } else if (name === "mintCloseAuthority") {
      mintCloseAuthority = typeof state.closeAuthority === "string" ? state.closeAuthority : null;
    }
  }

  return {
    inspection: {
      program: owner === TOKEN_2022_PROGRAM ? "token-2022" : owner === SPL_TOKEN_PROGRAM ? "spl-token" : owner,
      extensionNames,
      transferFeeBps,
      newerTransferFeeBps,
      olderTransferFeeBps,
      newerTransferFeeEpoch,
      maximumFeeRaw,
      transferHookProgramId,
      permanentDelegate,
      nonTransferable,
      defaultAccountState,
      paused,
      mintCloseAuthority,
      epochChecked,
    },
    slot: typeof infoRes.result?.context?.slot === "number" ? infoRes.result.context.slot : null,
    provider: infoRes.provider || null,
  };
}

async function runRoundTripTier(
  mint: string,
  quoteMint: string,
  amountRaw: string,
  label: string,
  request: typeof fetch,
): Promise<
  | { status: "ok"; tier: SolanaRoundTripTier; buy: DexQuoteLeg; sell: DexQuoteLeg }
  | { status: "buy_only_unsellable"; buy: DexQuoteLeg; sellErrors: string[] }
  | { status: "unavailable"; reason: string; errors: string[] }
> {
  const buy = await acquireDexQuote(quoteMint, mint, amountRaw, request);
  if (!buy.ok) {
    return {
      status: "unavailable",
      reason: buy.kind === "no_route" ? "NO_SOLANA_DEX_ROUTE" : "SIMULATION_PROVIDER_UNAVAILABLE",
      errors: buy.errors,
    };
  }
  const sell = await acquireDexQuote(mint, quoteMint, buy.quote.outAmount.toString(), request);
  if (!sell.ok) {
    if (sell.kind === "no_route") {
      return { status: "buy_only_unsellable", buy: buy.quote, sellErrors: sell.errors };
    }
    return {
      status: "unavailable",
      reason: "SIMULATION_PROVIDER_UNAVAILABLE",
      errors: sell.errors,
    };
  }

  const inputNum = Number(amountRaw);
  const sellOutNum = Number(sell.quote.outAmount);
  const roundTripLossBps =
    Number.isFinite(inputNum) && inputNum > 0 && Number.isFinite(sellOutNum)
      ? Math.max(0, Math.round((1 - sellOutNum / inputNum) * 10000))
      : 0;
  const estimatedDexSpreadBps = Math.round(
    buy.quote.poolFeeEstimateBps +
      sell.quote.poolFeeEstimateBps +
      buy.quote.priceImpactPct * 100 +
      sell.quote.priceImpactPct * 100,
  );

  return {
    status: "ok",
    buy: buy.quote,
    sell: sell.quote,
    tier: {
      label,
      quote_mint: quoteMint,
      input_amount_raw: amountRaw,
      buy_out_amount_raw: buy.quote.outAmount.toString(),
      sell_out_amount_raw: sell.quote.outAmount.toString(),
      buy_provider: buy.quote.provider,
      sell_provider: sell.quote.provider,
      buy_route: buy.quote.routeLabels,
      sell_route: sell.quote.routeLabels,
      round_trip_loss_bps: roundTripLossBps,
      estimated_dex_spread_bps: estimatedDexSpreadBps,
    },
  };
}

export async function simulateSolanaToken(
  tokenAddress: string,
  options: { includeMultiTier?: boolean } = {},
  dependencies: SolanaSimulationDependencies = {},
): Promise<Record<string, any>> {
  const mint = tokenAddress.trim();
  if (!isSolanaMintAddress(mint)) {
    throw new SolanaScanError("INVALID_SOLANA_ADDRESS", "Expected a base58-encoded 32-byte Solana address", 400);
  }
  const rpcQuery = dependencies.rpcQuery ?? querySolanaRpc;
  const request = dependencies.fetch ?? fetch;

  const scanFetch: typeof fetch | undefined = dependencies.rpcQuery
    ? (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST" && init.body) {
          try {
            const parsed = JSON.parse(String(init.body));
            if (parsed && typeof parsed.method === "string" && parsed.jsonrpc === "2.0") {
              const out = await rpcQuery(parsed.method, Array.isArray(parsed.params) ? parsed.params : [], request);
              return new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? 1, result: out.result }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
          } catch {}
        }
        return request(input, init);
      }) as typeof fetch
    : dependencies.fetch;

  const baseScan = await scanSolanaToken(mint, scanFetch ? { fetch: scanFetch } : {});
  const { inspection, slot: extSlot, provider: extProvider } = await inspectToken2022Extensions(mint, rpcQuery);

  const riskFactors: string[] = Array.isArray(baseScan.risk_factors)
    ? baseScan.risk_factors.filter((f: string) => f !== "SOLANA_BUY_SELL_EXECUTION_NOT_SIMULATED")
    : [];
  const addFactor = (flag: string) => {
    if (!riskFactors.includes(flag)) riskFactors.push(flag);
  };
  addFactor("LP_LOCK_AND_HOLDER_DISTRIBUTION_NOT_VERIFIED");

  if (inspection.transferFeeBps > 0) addFactor("TOKEN_2022_TRANSFER_FEE_PRESENT");
  if (inspection.transferFeeBps >= 5000) addFactor("HIGH_TRANSFER_TAX");
  if (inspection.nonTransferable) addFactor("NON_TRANSFERABLE_TOKEN");
  if (inspection.defaultAccountState === "frozen") addFactor("DEFAULT_ACCOUNT_STATE_FROZEN");
  if (inspection.paused) addFactor("TOKEN_2022_PAUSED");
  if (inspection.transferHookProgramId) addFactor("CUSTOM_TRANSFER_HOOK_PROGRAM");
  if (inspection.permanentDelegate) addFactor("PERMANENT_DELEGATE_ENABLED");
  if (inspection.mintCloseAuthority) addFactor("MINT_CLOSE_AUTHORITY_ENABLED");

  const hardBlockedByExtension =
    inspection.nonTransferable ||
    inspection.defaultAccountState === "frozen" ||
    inspection.paused ||
    inspection.transferFeeBps >= 10000;

  const quoteMint = mint === WSOL_MINT ? SOLANA_USDC_MINT : WSOL_MINT;
  const primaryAmount = mint === WSOL_MINT ? "1000000" : "10000000"; // 1 USDC or 0.01 SOL
  const primaryLabel = mint === WSOL_MINT ? "1 USDC" : "0.01 SOL";

  const primary = await runRoundTripTier(mint, quoteMint, primaryAmount, primaryLabel, request);

  // Guard against dust rounding if 0.01 SOL returned a buy quote with no sell route: re-test at 0.1 SOL before labeling honeypot.
  let confirmedSellBlocked = false;
  let buyOnlyEvidence: { buy: DexQuoteLeg; sellErrors: string[] } | null = null;
  if (primary.status === "buy_only_unsellable") {
    const largerAmount = mint === WSOL_MINT ? "10000000" : "100000000";
    const largerCheck = await runRoundTripTier(mint, quoteMint, largerAmount, "0.1 SOL", request);
    if (largerCheck.status === "buy_only_unsellable") {
      confirmedSellBlocked = true;
      buyOnlyEvidence = { buy: largerCheck.buy, sellErrors: largerCheck.sellErrors };
      addFactor("ASYMMETRIC_BUY_ONLY_NO_SELL_ROUTE");
    } else if (largerCheck.status === "unavailable" && !hardBlockedByExtension) {
      throw new SolanaScanError(
        largerCheck.reason,
        `Solana DEX quote simulation could not complete both legs (${largerCheck.errors.join("; ")}). No payment collected.`,
        503,
      );
    }
  } else if (primary.status === "unavailable" && !hardBlockedByExtension) {
    throw new SolanaScanError(
      primary.reason,
      `Solana DEX quote simulation unavailable for ${mint} (${primary.errors.join("; ")}). No payment collected.`,
      503,
    );
  }

  let additionalTiers: SolanaRoundTripTier[] = [];
  if (options.includeMultiTier && primary.status === "ok") {
    const tierConfigs =
      mint === WSOL_MINT
        ? [
            { label: "10 USDC", amount: "10000000" },
            { label: "100 USDC", amount: "100000000" },
          ]
        : [
            { label: "0.1 SOL", amount: "100000000" },
            { label: "1.0 SOL", amount: "1000000000" },
          ];
    for (const tc of tierConfigs) {
      const nextTier = await runRoundTripTier(mint, quoteMint, tc.amount, tc.label, request);
      if (nextTier.status === "ok") additionalTiers.push(nextTier.tier);
    }
  }

  let buyTaxBps: number | null = inspection.transferFeeBps;
  let sellTaxBps: number | null = inspection.transferFeeBps;
  let roundTripLossBps: number | null = null;
  let excessLossBps = 0;

  if (primary.status === "ok") {
    roundTripLossBps = primary.tier.round_trip_loss_bps ?? 0;
    const expectedBaseline = (primary.tier.estimated_dex_spread_bps ?? 0) + inspection.transferFeeBps * 2;
    excessLossBps = Math.max(0, roundTripLossBps - expectedBaseline);
    if (excessLossBps >= 500) {
      addFactor("ELEVATED_ROUND_TRIP_LOSS");
      sellTaxBps = Math.min(10000, Math.max(inspection.transferFeeBps, roundTripLossBps));
    }
  } else if (confirmedSellBlocked || hardBlockedByExtension) {
    sellTaxBps = inspection.transferFeeBps >= 5000 ? inspection.transferFeeBps : 10000;
  }

  const isHoneypot = Boolean(
    hardBlockedByExtension ||
      confirmedSellBlocked ||
      inspection.transferFeeBps >= 5000 ||
      (sellTaxBps !== null && sellTaxBps >= 5000),
  );

  const hasCautionExtension = Boolean(inspection.transferHookProgramId || inspection.permanentDelegate);
  const recommendation = isHoneypot
    ? "HONEYPOT_OR_SELL_BLOCKED_IN_SIMULATION"
    : hasCautionExtension || excessLossBps >= 500
      ? "CAUTION_HIGH_RISK_TOKEN_2022_OR_SPREAD"
      : "SELL_EXECUTED_IN_SCOPED_SIMULATION";

  const allTiers = primary.status === "ok" ? [primary.tier, ...additionalTiers] : [];
  const maxSlippageBps =
    allTiers.length > 0
      ? Math.max(...allTiers.map(t => t.round_trip_loss_bps ?? 0))
      : sellTaxBps;

  return {
    ...baseScan,
    is_honeypot: isHoneypot,
    buy_tax_bps: buyTaxBps,
    sell_tax_bps: sellTaxBps,
    round_trip_loss_bps: roundTripLossBps,
    swap_tiers: allTiers,
    max_slippage_bps: maxSlippageBps,
    risk_factors: riskFactors,
    recommendation,
    simulation_status: "passed",
    evidence: {
      ...(baseScan.evidence || {}),
      token_program: {
        program: inspection.program,
        extensions_slot: extSlot,
        extensions_provider: extProvider,
        extensions: inspection.extensionNames,
        transfer_fee_config: {
          active_bps: inspection.transferFeeBps,
          newer_bps: inspection.newerTransferFeeBps,
          older_bps: inspection.olderTransferFeeBps,
          newer_epoch: inspection.newerTransferFeeEpoch,
          epoch_checked: inspection.epochChecked,
          maximum_fee_raw: inspection.maximumFeeRaw,
        },
        transfer_hook_program_id: inspection.transferHookProgramId,
        permanent_delegate: inspection.permanentDelegate,
        non_transferable: inspection.nonTransferable,
        default_account_state: inspection.defaultAccountState,
        paused: inspection.paused,
        mint_close_authority: inspection.mintCloseAuthority,
      },
      simulation: {
        requested: true,
        executed: true,
        method: "token2022_extension_audit_and_dex_roundtrip_quotes",
        genesis_hash: SOLANA_GENESIS_HASH,
        buy_leg:
          primary.status === "ok"
            ? {
                provider: primary.buy.provider,
                input_mint: primary.buy.inputMint,
                output_mint: primary.buy.outputMint,
                input_amount_raw: primary.buy.inputAmount,
                out_amount_raw: primary.buy.outAmount.toString(),
                price_impact_pct: primary.buy.priceImpactPct,
                route: primary.buy.routeLabels,
              }
            : buyOnlyEvidence
              ? {
                  provider: buyOnlyEvidence.buy.provider,
                  input_mint: buyOnlyEvidence.buy.inputMint,
                  output_mint: buyOnlyEvidence.buy.outputMint,
                  input_amount_raw: buyOnlyEvidence.buy.inputAmount,
                  out_amount_raw: buyOnlyEvidence.buy.outAmount.toString(),
                  route: buyOnlyEvidence.buy.routeLabels,
                }
              : null,
        sell_leg:
          primary.status === "ok"
            ? {
                provider: primary.sell.provider,
                input_mint: primary.sell.inputMint,
                output_mint: primary.sell.outputMint,
                input_amount_raw: primary.sell.inputAmount,
                out_amount_raw: primary.sell.outAmount.toString(),
                price_impact_pct: primary.sell.priceImpactPct,
                route: primary.sell.routeLabels,
              }
            : buyOnlyEvidence
              ? {
                  provider: "Jupiter+Raydium",
                  status: "no_sell_route",
                  errors: buyOnlyEvidence.sellErrors,
                }
              : null,
        limitations: [
          "Public Solana JSON-RPC lacks arbitrary balance state overrides; simulation combines live on-chain Mint/Token-2022 extension rules with live Jupiter Lite / Raydium buy+sell routing quotes rather than signing an on-chain wallet swap.",
          "Custom Token-2022 TransferHook programs or authority Freeze actions triggered post-trade may block transfers dynamically.",
        ],
      },
    },
    timestamp: Math.floor(Date.now() / 1000),
  };
}
