# RugShield 402 🛡️

**Autonomous DEX Honeypot Detection & Tax Simulation Engine for AI Agents on Base**  
Gated by the **Coinbase x402 Payment Protocol** ($0.005 USDC per call on Base Mainnet).

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ak10082247-max/rugshield-402)

---

## ⚡ Specifications & Architecture
- **Settlement Network**: Base Mainnet (`eip155:8453`)
- **Settlement Asset**: USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- **Price per Scan**: $0.005 USDC (`5000` micro-units)
- **Merchant Address**: `0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1`
- **Protocol**: HTTP 402 Payment Required with EIP-712 Transfer Authorization

---

## 🚀 Core API Endpoints

### 1. `POST /v1/scan` (Paid: $0.005 USDC)
Simulates DEX buy/sell orders on Base, calculates buy & sell taxes in basis points (bps), inspects bytecode for blacklist/trading restrictions, and queries Aerodrome & Uniswap v3 pool depths.

**Request Payload:**
```json
{
  "token_address": "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
  "chain_id": 8453,
  "simulate_sell": true
}
```

**Response (HTTP 200):**
```json
{
  "token": "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
  "symbol": "DEGEN",
  "is_honeypot": false,
  "buy_tax_bps": 0,
  "sell_tax_bps": 0,
  "liquidity_usd": 68400,
  "risk_score": 0.02,
  "recommendation": "SAFE_TO_SWAP",
  "attestation": "rugshield_verified_8453_0x4ed4e8_1740000000",
  "timestamp": 1740000000
}
```

### 2. `GET /health` (Free)
Returns health check status for container keep-alive monitoring.

### 3. `GET /.well-known/x402.json` (Free)
Machine-readable discovery manifest according to the x402 specification.

---

## 🤖 MCP Server Integration

Add to your `claude_desktop_config.json` or Cursor MCP settings:

```json
{
  "mcpServers": {
    "rugshield": {
      "command": "node",
      "args": ["<PATH_TO_RUGSHIELD>/dist/mcp/server.js"],
      "env": {
        "BUYER_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

---

## 🔌 Ecosystem Plugins

### ElizaOS (`/plugins/eliza-rugshield`)
Drop-in action `PRE_SWAP_RISK_CHECK` that hooks into trading execution loops and queries `/v1/scan`.

### Coinbase AgentKit (`/plugins/agentkit-rugshield`)
Action provider `rugshield_pre_swap_check` for automated agent protection.

---

## ⏱️ Anti-Cold-Start Heartbeat Trigger

RugShield has a built-in internal heartbeat daemon pinging `/health` every 9 minutes. For external zero-latency monitoring, configure an external cron trigger (e.g. UptimeRobot or Cron-Job.org):

```bash
curl -s -X GET "https://rugshield-402.onrender.com/health" -H "User-Agent: UptimeRobot/2.0"
```

Recommended interval: Every 5 to 10 minutes.
