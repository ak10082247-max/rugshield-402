import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

export interface ElizaAction {
  name: string;
  similes: string[];
  description: string;
  validate: (runtime: any, message: any) => Promise<boolean>;
  handler: (runtime: any, message: any, state?: any, options?: any, callback?: any) => Promise<any>;
  examples: any[][];
}

const EXPECTED_MERCHANT = "0x80e0ae84679b7f11be171daadd492fbecf628cd6";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const MAX_PER_CALL_MICRO_USDC = 50_000n;

function readSetting(runtime: any, keys: string[]): string | undefined {
  for (const key of keys) {
    const rt = typeof runtime?.getSetting === "function" ? runtime.getSetting(key) : undefined;
    if (typeof rt === "string" && rt.trim()) return rt.trim();
    const env = typeof process !== "undefined" ? process.env?.[key] : undefined;
    if (typeof env === "string" && env.trim()) return env.trim();
  }
  return undefined;
}

function resolvePrivateKey(runtime: any, explicitKey?: string): `0x${string}` | undefined {
  const candidates = [
    explicitKey,
    readSetting(runtime, ["X402_PRIVATE_KEY", "RUGSHIELD_PRIVATE_KEY", "EVM_PRIVATE_KEY", "BASE_PRIVATE_KEY"]),
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
 * ElizaOS Action: PRE_SWAP_RISK_CHECK
 * Automatically intercepts swap requests and calls RugShield 402 (Base or Solana)
 * using @x402/fetch auto-signing when X402_PRIVATE_KEY is available, or free preview otherwise.
 */
export const preSwapRiskCheckAction: ElizaAction = {
  name: "PRE_SWAP_RISK_CHECK",
  similes: [
    "CHECK_HONEYPOT",
    "VERIFY_TOKEN_SAFETY",
    "SIMULATE_TOKEN_TAX",
    "AUDIT_BASE_TOKEN",
    "RUGSHIELD_CHECK",
  ],
  description:
    "MANDATORY check before executing DEX swaps on Base or Solana. Uses @x402/fetch when X402_PRIVATE_KEY is configured ($0.010 USDC/call) to detect honeypots, buy/sell taxes, and drained liquidity.",
  validate: async (_runtime: any, message: any) => {
    const text = message.content?.text || "";
    return /0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/i.test(text);
  },
  handler: async (runtime: any, message: any, _state: any, options: any, callback: any) => {
    const text = message.content?.text || "";
    const evmMatch = text.match(/0x[a-fA-F0-9]{40}/i);
    const solMatch = !evmMatch ? text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/) : null;
    const tokenAddress = options?.tokenAddress || evmMatch?.[0] || solMatch?.[0];
    if (!tokenAddress) return false;

    const chain = tokenAddress.startsWith("0x") ? "base" : "solana";
    const endpoint = (
      options?.hostUrl ||
      readSetting(runtime, ["RUGSHIELD_URL"]) ||
      "https://rugshield-402.onrender.com"
    ).replace(/\/$/, "");
    const baseFetch: typeof fetch = options?.customFetch ?? fetch;
    const privateKey = resolvePrivateKey(runtime, options?.privateKey);
    const paymentHeader =
      options?.paymentHeader || readSetting(runtime, ["RUGSHIELD_PAYMENT_HEADER", "PAYMENT_SIGNATURE"]);
    const usePreview = !privateKey && !paymentHeader && options?.useFreePreview !== false;

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (paymentHeader && !privateKey && !usePreview) {
        headers["PAYMENT-SIGNATURE"] = paymentHeader;
        headers["X-PAYMENT"] = paymentHeader;
      }

      const caller = privateKey && !usePreview ? createPayingFetch(privateKey, baseFetch) : baseFetch;
      const targetUrl = `${endpoint}${usePreview ? "/v1/scan/preview" : "/v1/scan"}`;

      const response = await caller(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          token_address: tokenAddress,
          chain,
          chain_id: chain === "base" ? 8453 : undefined,
          simulate_sell: true,
        }),
      });

      if (response.status === 402) {
        const challenge = await response.json().catch(() => ({}));
        const payTo =
          challenge?.accepts?.[0]?.payTo ||
          challenge?.payTo ||
          "0x80E0Ae84679b7f11bE171DaADd492FBECf628cd6";
        if (callback) {
          callback({
            text: `RugShield 402 payment required ($0.010 USDC on Base). Set X402_PRIVATE_KEY (Base USDC, 0 ETH gas) for automatic x402 signing. PayTo: ${payTo}`,
            action: "X402_PAYMENT_REQUIRED",
            challenge,
          });
        }
        return false;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const report: any = await response.json();
      const isSafe = report.recommendation === "SAFE_TO_SWAP" && report.is_honeypot === false;
      if (callback) {
        const modeNote = usePreview
          ? `\n• Mode: Free Preview (set X402_PRIVATE_KEY for full swap simulation)`
          : `\n• Mode: Paid x402 Verification`;
        callback({
          text:
            `RugShield Security Report for ${report.symbol ?? tokenAddress} (${tokenAddress}):\n` +
            `• Chain: ${chain}\n` +
            `• Recommendation: ${report.recommendation ?? "UNVERIFIED"}\n` +
            `• Honeypot: ${report.is_honeypot === true ? "YES (DO NOT BUY)" : report.is_honeypot === false ? "NO" : "UNVERIFIED (paid /v1/scan required)"}\n` +
            `• Buy Tax: ${typeof report.buy_tax_bps === "number" ? report.buy_tax_bps / 100 + "%" : "UNVERIFIED"}\n` +
            `• Sell Tax: ${typeof report.sell_tax_bps === "number" ? report.sell_tax_bps / 100 + "%" : "UNVERIFIED"}\n` +
            `• Pool Liquidity: ${typeof report.liquidity_usd === "number" ? "$" + report.liquidity_usd.toLocaleString() : "Unavailable"}\n` +
            `• Risk Score: ${report.risk_score ?? "N/A"}` +
            modeNote,
          report,
        });
      }

      return isSafe;
    } catch (err: any) {
      if (callback) {
        callback({ text: `Failed to query RugShield: ${err.message}` });
      }
      return false;
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Swap 0.05 ETH for 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed on Base" },
      },
      {
        user: "{{agent}}",
        content: { text: "Running pre-swap risk check via RugShield 402...", action: "PRE_SWAP_RISK_CHECK" },
      },
    ],
  ],
};

export const rugshieldPlugin = {
  name: "plugin-rugshield-402",
  description: "RugShield 402 DEX Honeypot & Tax Protection Plugin for ElizaOS Agents (Base & Solana)",
  actions: [preSwapRiskCheckAction],
};

export default rugshieldPlugin;
