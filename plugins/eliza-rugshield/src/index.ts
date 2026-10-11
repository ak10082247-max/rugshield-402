export interface ElizaAction {
  name: string;
  similes: string[];
  description: string;
  validate: (runtime: any, message: any) => Promise<boolean>;
  handler: (runtime: any, message: any, state?: any, options?: any, callback?: any) => Promise<any>;
  examples: any[][];
}

/**
 * ElizaOS Action: PRE_SWAP_RISK_CHECK
 * Automatically intercepts swap requests and calls RugShield 402 on Base
 * to protect the agent's wallet from honeypots, malicious taxes, and liquidity drains.
 */
export const preSwapRiskCheckAction: ElizaAction = {
  name: "PRE_SWAP_RISK_CHECK",
  similes: [
    "CHECK_HONEYPOT",
    "VERIFY_TOKEN_SAFETY",
    "SIMULATE_TOKEN_TAX",
    "AUDIT_BASE_TOKEN",
    "RUGSHIELD_CHECK"
  ],
  description:
    "MANDATORY check before executing DEX swaps on Base. Queries RugShield 402 to detect honeypots, high buy/sell taxes, and drained liquidity. Cost: 0.005 USDC on Base.",
  validate: async (_runtime: any, message: any) => {
    const text = message.content?.text || "";
    // Matches 0x addresses on Base
    return /0x[a-fA-F0-9]{40}/i.test(text);
  },
  handler: async (runtime: any, message: any, _state?: any, _options?: any, callback?: any) => {
    const text = message.content?.text || "";
    const match = text.match(/0x[a-fA-F0-9]{40}/i);
    if (!match) return false;

    const tokenAddress = match[0];
    const endpoint = process.env.RUGSHIELD_URL || "https://rugshield-402.onrender.com";

    try {
      const response = await fetch(`${endpoint}/v1/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token_address: tokenAddress,
          chain_id: 8453,
          simulate_sell: true
        })
      });

      if (response.status === 402) {
        const challenge = await response.json();
        if (callback) {
          callback({
            text: `RugShield 402 payment required ($0.005 USDC on Base). PayTo: ${challenge.payTo}`,
            action: "X402_PAYMENT_REQUIRED",
            challenge
          });
        }
        return false;
      }

      const report = await response.json();
      const isSafe = report.recommendation === "SAFE_TO_SWAP";

      if (callback) {
        callback({
          text: `RugShield Security Report for ${report.symbol} (${tokenAddress}):\n` +
            `• Recommendation: ${report.recommendation}\n` +
            `• Honeypot: ${report.is_honeypot ? "YES (DO NOT BUY)" : "NO"}\n` +
            `• Buy Tax: ${report.buy_tax_bps / 100}%\n` +
            `• Sell Tax: ${report.sell_tax_bps / 100}%\n` +
            `• Pool Liquidity: $${report.liquidity_usd.toLocaleString()}\n` +
            `• Risk Score: ${report.risk_score}`,
          report
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
      { user: "{{user1}}", content: { text: "Swap 0.05 ETH for 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed on Base" } },
      { user: "{{agent}}", content: { text: "Running pre-swap risk check via RugShield 402...", action: "PRE_SWAP_RISK_CHECK" } }
    ]
  ]
};

export const rugshieldPlugin = {
  name: "plugin-rugshield-402",
  description: "RugShield 402 DEX Honeypot & Tax Protection Plugin for ElizaOS Agents on Base",
  actions: [preSwapRiskCheckAction]
};

export default rugshieldPlugin;
