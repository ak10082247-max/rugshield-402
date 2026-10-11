# @kurox_real/plugin-rugshield-402 🛡️

**Autonomous Pre-Swap Honeypot Detection & Tax Verification Plugin for ElizaOS Agents on Base**

Gated by the **x402 Payment Protocol** ($0.005 USDC per scan on Base Mainnet).

## Overview
This plugin provides the `PRE_SWAP_RISK_CHECK` action for ElizaOS agents. Before an agent swaps any token on Base (Aerodrome, Uniswap v3), it automatically queries the RugShield 402 engine to:
- Detect buy/sell honeypots and non-transferable token traps
- Calculate real buy & sell taxes (bps)
- Verify pool liquidity depth
- Block swaps if honeypots or high-tax drainers are detected

## Installation
```bash
npm install @kurox_real/plugin-rugshield-402
# or
bun add @kurox_real/plugin-rugshield-402
# or
pnpm add @kurox_real/plugin-rugshield-402
```

## Agent Configuration
Import and add `rugshieldPlugin` to your ElizaOS agent's character file:

```typescript
import { rugshieldPlugin } from "@kurox_real/plugin-rugshield-402";

export const defaultCharacter = {
  name: "DeFiTrader",
  plugins: [rugshieldPlugin],
  // ...
};
```

Or in JSON character configuration:
```json
{
  "name": "DeFiTrader",
  "plugins": ["@kurox_real/plugin-rugshield-402"]
}
```

## Environment Variables
- `RUGSHIELD_URL`: (Optional) Custom RugShield 402 host. Defaults to `https://rugshield-402.onrender.com`.

## License
MIT
