import { z } from "zod";

export const RugshieldScanInput = z.object({
  tokenAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Must be valid 40-character EVM address")
    .describe("ERC-20 token contract address on Base to simulate and verify"),
  simulateSell: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to simulate immediate sell order to detect honeypot trap"),
});

export type RugshieldScanInputType = z.infer<typeof RugshieldScanInput>;

/**
 * Coinbase AgentKit Action Provider for RugShield 402
 */
export const rugshieldPreSwapAction = {
  name: "rugshield_pre_swap_check",
  description:
    "Pre-swap DeFi risk verification on Base. Simulates buys and sells to detect token honeypots, hidden fees, and drained liquidity. Paid via x402 (0.005 USDC on Base).",
  schema: RugshieldScanInput,
  invoke: async (args: RugshieldScanInputType) => {
    const endpoint = process.env.RUGSHIELD_URL || "https://rugshield-402.onrender.com";
    const response = await fetch(`${endpoint}/v1/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_address: args.tokenAddress,
        chain_id: 8453,
        simulate_sell: args.simulateSell,
      }),
    });

    if (response.status === 402) {
      const challenge = await response.json();
      return JSON.stringify({
        status: "payment_required",
        protocol: "x402",
        challenge,
        message: "Sign EIP-712 payment authorization for 5000 micro-units USDC on Base",
      });
    }

    const report = await response.json();
    return JSON.stringify(report, null, 2);
  },
};

export const agentkitRugshieldPlugin = {
  name: "agentkit-rugshield",
  actions: [rugshieldPreSwapAction],
};

export default agentkitRugshieldPlugin;
