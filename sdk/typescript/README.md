# @kurox_real/rugshield-client

> Official TypeScript & Node.js client for **RugShield 402** — real-time token honeypot detection, buy/sell tax simulation, LP lock proofs, and DEX risk audits on Base Mainnet via HTTP 402 micropayments.

---

## ⚡ Quickstart

### 1. Install
```bash
npm install @kurox_real/rugshield-client viem @x402/fetch @x402/evm
```

### 2. Free Zero-Wallet Preview (No API Key or Wallet Required)
```typescript
import { RugShieldClient } from "@kurox_real/rugshield-client";

const shield = new RugShieldClient();

// Free instant pre-swap honeypot evaluation
const result = await shield.scanPreview("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
console.log("Is Safe?", !result.is_honeypot && result.sell_tax_bps < 1000);
console.log(`Buy Tax: ${result.buy_tax_bps / 100}% | Sell Tax: ${result.sell_tax_bps / 100}%`);
```

### 3. Production Trading Bot Pre-Swap Hook (Paid x402)
```typescript
import { RugShieldClient } from "@kurox_real/rugshield-client";

const shield = new RugShieldClient({
  privateKey: process.env.BOT_PRIVATE_KEY as `0x${string}`, // Signs 0.010 USDC transfer on Base
});

// One-line boolean check for trading execution loops
if (await shield.isSafeToSwap(targetTokenAddress)) {
  executeSwap(targetTokenAddress);
} else {
  console.warn("Swap aborted: token flagged as honeypot or high tax!");
}
```

---

## 🛡️ Key Features

- **Sub-50ms Heuristic & State Override Simulation**: Simulates swap orders on Base Mainnet via state overrides to calculate exact buy/sell taxes without relying on stale third-party indexers.
- **DEX LP Token Lock Verification**: Audits liquidity locks on Aerodrome, Uncx, and Team.Finance.
- **Client-Side Spend Safety Rails**: Automatically verifies the recipient merchant address (`0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1`), asset (Base USDC), and enforces a maximum spending ceiling before signing payments.
- **Dual Settlement Ready**: Compatible with Base Mainnet and Solana SPL USDC.

---

## 📄 License
MIT © kurox_real
