import {
  RugShieldScanInputSchema,
  executeRugShieldScan,
  type RugShieldScanInput,
  type RugShieldScanOutput,
  type RugShieldActionOptions,
} from "./action.js";

/**
 * Coinbase AgentKit Custom Action Provider Definition
 */
export function rugshieldActionProvider(options?: RugShieldActionOptions) {
  const action = {
    name: "rugshield_pre_swap_scan",
    description:
      "MANDATORY: Simulates DEX buy/sell orders on Base and Solana to detect honeypots, calculate exact buy/sell tax bps, and verify liquidity before executing a swap. Auto-pays $0.010 USDC via @x402/fetch when X402_PRIVATE_KEY is set, or evaluates /v1/scan/preview.",
    schema: RugShieldScanInputSchema,
    invoke: async (args: RugShieldScanInput) => {
      const result = await executeRugShieldScan(args, options);
      return JSON.stringify(result, null, 2);
    },
  };

  return {
    name: "rugshield_action_provider",
    description:
      "Action provider for RugShield 402: executes real-time honeypot detection, buy/sell tax simulation, and liquidity verification on Base & Solana.",
    supportsNetwork: (network: { protocolFamily?: string; networkId?: string }) => {
      return (
        network.protocolFamily === "evm" ||
        network.protocolFamily === "svm" ||
        network.networkId === "base-mainnet" ||
        network.networkId === "base" ||
        network.networkId === "solana-mainnet" ||
        network.networkId === "solana"
      );
    },
    getActions: () => [action],
    actions: [action],
  };
}

export {
  RugShieldScanInputSchema,
  executeRugShieldScan,
  type RugShieldScanInput,
  type RugShieldScanOutput,
  type RugShieldActionOptions,
};
export default rugshieldActionProvider;
