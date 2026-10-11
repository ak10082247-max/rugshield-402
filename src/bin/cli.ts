#!/usr/bin/env node
import { scanToken } from "../services/simulator.js";

async function main() {
  const args = process.argv.slice(2);
  const token = args[0] || "0x4200000000000000000000000000000000000006";

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
🛡️  RugShield 402 — Autonomous DEX Honeypot Firewall CLI
Usage:
  npx rugshield <token_address> [options]

Options:
  --chain-id <id>     Network chain ID (default: 8453 for Base)
  --no-sell-sim       Skip sell simulation
  -h, --help          Show help message
`);
    process.exit(0);
  }

  console.log(`\n🔍 Simulating DEX orders for ${token} on Base...`);

  try {
    const res = await scanToken({
      token_address: token,
      chain_id: 8453,
      simulate_sell: true,
    });

    const isSafe = !res.is_honeypot && res.sell_tax_bps < 1000;
    const badge = isSafe ? "\x1b[32m[SAFE TO SWAP]\x1b[0m" : "\x1b[31m[HIGH RISK / HONEYPOT]\x1b[0m";

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛡️  RugShield 402 Audit Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Token:       ${res.name} (${res.symbol})
Address:     ${res.token}
Verdict:     ${badge}
Honeypot:    ${res.is_honeypot ? "\x1b[31mYES (Transfer Blocked)\x1b[0m" : "\x1b[32mNO\x1b[0m"}
Buy Tax:     ${(res.buy_tax_bps / 100).toFixed(1)}%
Sell Tax:    ${(res.sell_tax_bps / 100).toFixed(1)}%
Liquidity:   $${Number(res.liquidity_usd).toLocaleString()} USD
Risk Score:  ${(res.risk_score * 100).toFixed(0)} / 100
Attestation: ${res.attestation}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ Gated by x402 Protocol on Base Mainnet ($0.005 USDC/scan)
`);
  } catch (err: any) {
    console.error(`❌ Scan failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
