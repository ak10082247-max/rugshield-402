import { z } from "zod";

export const RugShieldScanInputSchema = z.object({
  tokenAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM contract address")
    .describe("The ERC-20 token contract address on Base (0x...) to scan before swapping"),
  swapAmountUsdc: z
    .string()
    .optional()
    .default("10")
    .describe("Optional swap amount in USDC to simulate slippage and tax impact"),
});

export type RugShieldScanInput = z.infer<typeof RugShieldScanInputSchema>;

export interface RugShieldScanOutput {
  token: string;
  symbol: string;
  name: string;
  isHoneypot: boolean;
  buyTaxBps: number;
  sellTaxBps: number;
  liquidityUsd: number;
  riskScore: number;
  riskFactors: string[];
  recommendation: "SAFE_TO_SWAP" | "HIGH_RISK_BLOCK" | "CAUTION";
  attestation: string;
  timestamp: number;
}

/**
 * Execute pre-swap honeypot and tax simulation via RugShield 402 microservice on Base.
 */
export async function executeRugShieldScan(
  params: RugShieldScanInput,
  options?: { hostUrl?: string; paymentHeader?: string }
): Promise<RugShieldScanOutput> {
  const host = (
    options?.hostUrl ||
    process.env.RUGSHIELD_URL ||
    "https://rugshield-402.onrender.com"
  ).replace(/\/$/, "");

  const url = `${host}/v1/scan`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options?.paymentHeader) {
    headers["X-PAYMENT"] = options.paymentHeader;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      token_address: params.tokenAddress,
      chain_id: 8453,
      simulate_sell: true,
    }),
  });

  if (res.status === 402) {
    const challenge = await res.json().catch(() => ({}));
    throw new Error(
      `RugShield 402 Payment Required: 0.005 USDC to ${challenge.payTo || "0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1"} on Base. Facilitator: ${challenge.facilitator || "coinbase-cdp"}.`
    );
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`RugShield API returned ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as any;
  return {
    token: data.token,
    symbol: data.symbol,
    name: data.name,
    isHoneypot: Boolean(data.is_honeypot),
    buyTaxBps: Number(data.buy_tax_bps ?? 0),
    sellTaxBps: Number(data.sell_tax_bps ?? 0),
    liquidityUsd: Number(data.liquidity_usd ?? 0),
    riskScore: Number(data.risk_score ?? 0),
    riskFactors: Array.isArray(data.risk_factors) ? data.risk_factors : [],
    recommendation: data.recommendation || (data.is_honeypot ? "HIGH_RISK_BLOCK" : "SAFE_TO_SWAP"),
    attestation: data.attestation || "",
    timestamp: data.timestamp || Math.floor(Date.now() / 1000),
  };
}
