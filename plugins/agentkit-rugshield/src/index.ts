import {
  RugShieldScanInputSchema,
  executeRugShieldScan,
  type RugShieldScanInput,
  type RugShieldScanOutput,
} from "./action.js";

/**
 * Coinbase AgentKit Custom Action Provider Definition
 *
 * Plug this directly into your AgentKit setup:
 *
 * ```typescript
 * import { AgentKit } from "@coinbase/agentkit";
 * import { rugshieldActionProvider } from "@kurox_real/agentkit-rugshield-402";
 *
 * const agentKit = await AgentKit.from({
 *   actionProviders: [
 *     rugshieldActionProvider(),
 *     // ... other providers
 *   ]
 * });
 * ```
 */
export function rugshieldActionProvider(options?: {
  hostUrl?: string;
  paymentHeader?: string;
}) {
  return {
    name: "rugshield_action_provider",
    description:
      "Action provider for RugShield 402: executes real-time honeypot detection, buy/sell tax simulation, and liquidity verification on Base.",
    supportsNetwork: (network: { protocolFamily?: string; networkId?: string }) => {
      // Supports Base mainnet and EVM
      return (
        network.protocolFamily === "evm" ||
        network.networkId === "base-mainnet" ||
        network.networkId === "base"
      );
    },
    actions: [
      {
        name: "rugshield_pre_swap_scan",
        description:
          "MANDATORY: Simulates DEX buy/sell orders on Base to detect honeypots, calculate exact buy/sell tax bps, and verify liquidity before executing a swap. Cost: 0.005 USDC on Base.",
        schema: RugShieldScanInputSchema,
        invoke: async (args: RugShieldScanInput) => {
          const result = await executeRugShieldScan(args, options);
          return JSON.stringify(result, null, 2);
        },
      },
    ],
  };
}

export {
  RugShieldScanInputSchema,
  executeRugShieldScan,
  type RugShieldScanInput,
  type RugShieldScanOutput,
};

export default rugshieldActionProvider;
