# @kurox_real/agentkit-rugshield-402 🛡️

**Coinbase AgentKit Action Provider for Pre-Swap Honeypot Detection & Tax Simulation on Base**

Gated by the **x402 Payment Protocol** ($0.005 USDC per scan on Base Mainnet to merchant `0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1`).

---

## Overview

This package exposes the `rugshield_pre_swap_scan` action for **Coinbase AgentKit** and LangChain on Base. Before an agent executes any token swap on Base (Aerodrome, Uniswap v3), it automatically simulates the transaction to:
- Detect buy/sell honeypots and non-transferable token traps.
- Calculate exact buy and sell taxes in basis points (bps).
- Verify pool liquidity depth (USD).
- Prevent draining trading funds on malicious contracts.

---

## Installation

```bash
npm install @kurox_real/agentkit-rugshield-402 zod
```

---

## AgentKit Usage

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { rugshieldActionProvider } from "@kurox_real/agentkit-rugshield-402";

// Initialize AgentKit with the RugShield provider
const agentKit = await AgentKit.from({
  walletProvider: myWalletProvider,
  actionProviders: [
    rugshieldActionProvider(),
    // ... other providers (weth, cdp, erc20)
  ],
});
```

### LangChain Integration

```typescript
import { getLangChainTools } from "@coinbase/agentkit-langchain";

const tools = await getLangChainTools(agentKit);
// The LLM can now invoke rugshield_pre_swap_scan automatically before swaps!
```

---

## Standalone Usage

```typescript
import { executeRugShieldScan } from "@kurox_real/agentkit-rugshield-402";

const report = await executeRugShieldScan({
  tokenAddress: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", // DEGEN on Base
});

console.log(report.recommendation); // "SAFE_TO_SWAP"
console.log(`Liquidity: $${report.liquidityUsd}`);
console.log(`Buy Tax: ${report.buyTaxBps} bps | Sell Tax: ${report.sellTaxBps} bps`);
```

---

## Environment Variables

- `RUGSHIELD_URL`: Custom RugShield host (defaults to `https://rugshield-402.onrender.com`).

---

## License

MIT
