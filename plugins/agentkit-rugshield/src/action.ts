import { z } from "zod";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const EXPECTED_MERCHANT = "0x80e0ae84679b7f11be171daadd492fbecf628cd6";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const MAX_PER_CALL_MICRO_USDC = 150_000n;

export const RugShieldScanInputSchema = z.object({
  tokenAddress: z
    .string()
    .regex(/^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, "Invalid Base ERC-20 or Solana mint address")
    .describe("The ERC-20 contract on Base (0x...) or Solana SPL mint address to scan before swapping"),
  chain: z
    .enum(["base", "solana"])
    .optional()
    .describe("Target blockchain network (auto-detected from address format if omitted)"),
  swapAmountUsdc: z
    .string()
    .optional()
    .default("10")
    .describe("Optional swap amount in USDC to simulate slippage and tax impact"),
});

export type RugShieldScanInput = z.infer<typeof RugShieldScanInputSchema>;

export interface RugShieldScanOutput {
  token: string;
  chain: "base" | "solana";
  symbol: string | null;
  name: string | null;
  isHoneypot: boolean | null;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  liquidityUsd: number | null;
  riskScore: number | null;
  riskFactors: string[];
  recommendation: string;
  attestation: string | null;
  paymentMode: "x402_paid" | "x402_header" | "free_preview";
  x402UpgradeHint?: string;
  timestamp: number;
}

export interface RugShieldActionOptions {
  hostUrl?: string;
  paymentHeader?: string;
  privateKey?: `0x${string}` | string;
  useFreePreview?: boolean;
  customFetch?: typeof fetch;
}

function resolvePrivateKey(explicitKey?: string): `0x${string}` | undefined {
  const candidates = [
    explicitKey,
    typeof process !== "undefined" ? process.env?.X402_PRIVATE_KEY : undefined,
    typeof process !== "undefined" ? process.env?.RUGSHIELD_PRIVATE_KEY : undefined,
    typeof process !== "undefined" ? process.env?.EVM_PRIVATE_KEY : undefined,
    typeof process !== "undefined" ? process.env?.BASE_PRIVATE_KEY : undefined,
  ];
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const cleaned = raw.trim().replace(/^0x/i, "");
    if (/^[a-fA-F0-9]{64}$/.test(cleaned)) return `0x${cleaned}`;
  }
  return undefined;
}

function createPayingFetch(privateKey: `0x${string}`, baseFetch: typeof fetch = fetch): typeof fetch {
  const account = privateKeyToAccount(privateKey);
  const client = new x402Client();
  client.register("eip155:8453", new ExactEvmScheme(account));
  client.onBeforePaymentCreation(async (context) => {
    const req = context.selectedRequirements;
    if (req.network !== "eip155:8453") throw new Error(`Rejected network ${req.network}`);
    if (req.asset.toLowerCase() !== BASE_USDC) throw new Error(`Rejected asset ${req.asset}`);
    if (req.payTo.toLowerCase() !== EXPECTED_MERCHANT) throw new Error(`Rejected payTo ${req.payTo}`);
    if (BigInt(req.amount) > MAX_PER_CALL_MICRO_USDC) throw new Error(`Rejected amount ${req.amount}`);
  });
  return wrapFetchWithPayment(baseFetch, client);
}

/**
 * Execute pre-swap honeypot and tax simulation via RugShield 402 microservice on Base & Solana.
 */
export async function executeRugShieldScan(
  params: RugShieldScanInput,
  options?: RugShieldActionOptions
): Promise<RugShieldScanOutput> {
  const host = (
    options?.hostUrl ||
    process.env.RUGSHIELD_URL ||
    "https://rugshield-402.onrender.com"
  ).replace(/\/$/, "");
  const chain: "base" | "solana" =
    params.chain ?? (params.tokenAddress.startsWith("0x") ? "base" : "solana");
  const baseFetch = options?.customFetch ?? fetch;
  const privateKey = resolvePrivateKey(options?.privateKey);
  const paymentHeader = options?.paymentHeader || process.env.RUGSHIELD_PAYMENT_HEADER;
  const usePreview =
    options?.useFreePreview === true ||
    (!privateKey && !paymentHeader && options?.useFreePreview !== false);

  const url = `${host}${usePreview ? "/v1/scan/preview" : "/v1/scan"}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (paymentHeader && !privateKey && !usePreview) {
    headers["PAYMENT-SIGNATURE"] = paymentHeader;
    headers["X-PAYMENT"] = paymentHeader;
  }

  const caller = privateKey && !usePreview ? createPayingFetch(privateKey, baseFetch) : baseFetch;
  const res = await caller(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      token_address: params.tokenAddress,
      chain,
      chain_id: chain === "base" ? 8453 : undefined,
      simulate_sell: true,
    }),
  });

  if (res.status === 402) {
    const challenge: any = await res.json().catch(() => ({}));
    const payTo =
      challenge?.accepts?.[0]?.payTo ||
      challenge?.payTo ||
      "0x80E0Ae84679b7f11bE171DaADd492FBECf628cd6";
    throw new Error(
      `RugShield 402 Payment Required: 0.010 USDC to ${payTo} on Base. Set X402_PRIVATE_KEY (Base USDC, 0 ETH gas) or pass { privateKey } for automatic payment signing.`
    );
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`RugShield API returned ${res.status}: ${errText}`);
  }

  const data: any = await res.json();
  const isHoneypot = typeof data.is_honeypot === "boolean" ? data.is_honeypot : null;
  const buyTaxBps = typeof data.buy_tax_bps === "number" ? data.buy_tax_bps : null;
  const sellTaxBps = typeof data.sell_tax_bps === "number" ? data.sell_tax_bps : null;
  const recommendation =
    data.recommendation ||
    (isHoneypot === true
      ? "HIGH_RISK_BLOCK"
      : isHoneypot === false && sellTaxBps !== null && sellTaxBps < 1000
        ? "SAFE_TO_SWAP"
        : "UNVERIFIED");

  return {
    token: data.token || params.tokenAddress,
    chain,
    symbol: data.symbol ?? null,
    name: data.name ?? null,
    isHoneypot,
    buyTaxBps,
    sellTaxBps,
    liquidityUsd: typeof data.liquidity_usd === "number" ? data.liquidity_usd : null,
    riskScore: typeof data.risk_score === "number" ? data.risk_score : null,
    riskFactors: Array.isArray(data.risk_factors) ? data.risk_factors : [],
    recommendation,
    attestation: data.attestation ?? null,
    paymentMode: usePreview ? "free_preview" : privateKey ? "x402_paid" : "x402_header",
    x402UpgradeHint: usePreview
      ? "Evaluated via free /v1/scan/preview (unsimulated). Set X402_PRIVATE_KEY or pass { privateKey } (Base USDC, 0 ETH gas) for live buy/sell swap simulation ($0.010 USDC)."
      : undefined,
    timestamp: data.timestamp || Math.floor(Date.now() / 1000),
  };
}
