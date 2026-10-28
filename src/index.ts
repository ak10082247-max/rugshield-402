import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { CONFIG, AGENT_CONTINUATION, ENDPOINT_SPECS, ENDPOINT_MAP } from "./config.js";
import { x402Middleware, X402_METRICS } from "./middleware/x402.js";
import { deliveryRecorderMiddleware, getRecentDeliveries, getPaidDeliveries } from "./middleware/delivery_recorder.js";
import { scanToken } from "./services/simulator.js";
import { scanSolanaToken, SolanaScanError } from "./services/solana_scan.js";
import { tokenScreener, holderConcentration, walletBalances, liquidityLockEvidence } from "./services/evidence.js";
import { readScanInput } from "./services/scan_input.js";
import { PreviewBudget } from "./services/preview_budget.js";
import { startHeartbeat } from "./services/heartbeat.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const app = new Hono();

// Path normalizer: strip trailing slashes, quotes, backslashes, brackets, and encoded noise
// to eliminate 404s from terminal/Render log auto-linkers or JSON copy-pasting
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  let decodedPath = url.pathname;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {}
  const cleanPath = decodedPath.replace(/[\/\\"'}\],;\s]+$/, "");
  if (cleanPath !== url.pathname && cleanPath.length > 0) {
    url.pathname = cleanPath;
    return c.redirect(url.toString(), 308);
  }
  await next();
});

// Global middleware
app.use("*", deliveryRecorderMiddleware);
app.use("*", x402Middleware);

// Health check endpoint (free, no auth, monitored by keep-alive)
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: CONFIG.serviceName,
    version: CONFIG.version,
    revision: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "unknown",
    fulfillment_storage: "filesystem_instance_local_unless_persistent_volume_mounted",
    capabilities: { base_swap_simulation: "Uniswap V2 WETH pool, 0.001 ETH, stateful unsigned RPC", solana_mint_inspection: true, solana_swap_simulation: false, specialized_full_analyses: false },
    chain_id: CONFIG.chainId,
    endpoints_count: ENDPOINT_SPECS.length,
    timestamp: Math.floor(Date.now() / 1000),
  });
});

app.get("/ping", (c) => c.json({ status: "ok" }));
app.get("/version", (c) => {
  const rev = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "unknown";
  return c.json({ service: CONFIG.serviceName, version: CONFIG.version, revision: rev, build_revision: rev });
});

// Corporate & Trust Probes (/careers, /jobs, /join, /about) for reputation crawlers
const handleTrustProbe = (c: any) => c.json({
  organization: "Kurox Fleet",
  service: "RugShield 402",
  status: "autonomous_ai_fleet",
  agent_id: 335687,
  network: `eip155:${CONFIG.chainId}`,
  erc8004_contract: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  operator_vault: CONFIG.merchantAddress,
  open_roles: "Autonomous AI Agents & Specialized MCP Oracles",
  github: "https://github.com/ak10082247-max",
  documentation: "/openapi.json",
  discovery: "/.well-known/x402.json",
});

app.get("/careers", handleTrustProbe);
app.get("/careers/", handleTrustProbe);
app.get("/jobs", handleTrustProbe);
app.get("/join", handleTrustProbe);
app.get("/about", handleTrustProbe);

function getBaseUrl(c: any): string {
  const host = c.req.header("host") || `localhost:${CONFIG.port}`;
  const proto = c.req.header("x-forwarded-proto") || (host.includes("onrender.com") ? "https" : "http");
  return host.includes("onrender.com") ? "https://rugshield-402.onrender.com" : `${proto}://${host}`;
}

// Root info & Web DApp
app.get("/", (c) => {
  const accept = c.req.header("accept") || "";
  if (accept.includes("text/html")) {
    const htmlPath = join(process.cwd(), "public", "index.html");
    if (existsSync(htmlPath)) {
      return c.html(readFileSync(htmlPath, "utf-8"));
    }
  }
  return c.json({
    service: "RugShield 402",
    version: CONFIG.version,
    description: "Low-latency token honeypot detection, LP lock verification, and 7-vector institutional risk audit on Base Mainnet for AI agents",
    pricing: "$0.010 - $0.020 USDC per call on Base (EIP-155:8453)",
    health: "/health",
    discovery: "/.well-known/x402.json",
    endpoints_count: ENDPOINT_SPECS.length,
    endpoints: ENDPOINT_SPECS.map(s => ({ path: s.path, price: `${s.priceUsd} USDC`, summary: s.summary })),
  });
});

app.get("/llms.txt", (c) => {
  const filePath = join(process.cwd(), "public", "llms.txt");
  if (existsSync(filePath)) {
    return c.text(readFileSync(filePath, "utf-8"), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  }
  return c.text("# RugShield 402 - Honeypot & Tax Simulation API on Base Mainnet\nEndpoints:\n" + ENDPOINT_SPECS.map(s => `- ${s.path}: ${s.priceUsd} USDC`).join("\n"), 200);
});

app.get("/llms-full.txt", (c) => c.redirect("/llms.txt"));

app.get("/app", (c) => {
  const htmlPath = join(process.cwd(), "public", "index.html");
  if (existsSync(htmlPath)) {
    return c.html(readFileSync(htmlPath, "utf-8"));
  }
  return c.redirect("/");
});

app.get("/favicon.ico", (c) => {
  const iconPath = join(process.cwd(), "public", "favicon.ico");
  if (existsSync(iconPath)) {
    return c.body(readFileSync(iconPath), 200, {
      "Content-Type": "image/x-icon",
      "Cache-Control": "public, max-age=86400",
    });
  }
  return new Response(null, { status: 204 });
});

// OpenAPI Spec Endpoint
app.get("/openapi.json", (c) => {
  const baseUrl = getBaseUrl(c);
  const openapiPaths: Record<string, any> = {};

  for (const spec of ENDPOINT_SPECS) {
    openapiPaths[spec.path] = {
      post: {
        summary: spec.summary,
        description: `${spec.description} Requires ${spec.priceUsd} USDC on Base.`,
        operationId: spec.path.replace(/\//g, "_").replace(/^_/, ""),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token_address: { type: "string", example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: `${spec.summary} executed successfully` },
          "402": { description: `Payment Required: ${spec.priceUsd} USDC on Base mainnet (EIP-155:8453)` },
        },
        "x-payment-info": {
          network: `eip155:${CONFIG.chainId}`,
          chainId: CONFIG.chainId,
          asset: CONFIG.usdcAddress,
          currency: "USDC",
          amount: spec.amountMicroUnits,
          price: `${spec.priceUsd} USDC`,
          payTo: CONFIG.merchantAddress,
          scheme: "exact",
          facilitator: CONFIG.facilitator,
        },
      },
      get: {
        summary: `${spec.summary} (GET probe)`,
        description: `Accepts query parameters for ${spec.summary}.`,
        parameters: [
          {
            name: "token_address",
            in: "query",
            required: false,
            schema: { type: "string", example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
          },
        ],
        responses: {
          "200": { description: "Success" },
          "402": { description: `Payment Required: ${spec.priceUsd} USDC on Base` },
        },
        "x-payment-info": {
          network: `eip155:${CONFIG.chainId}`,
          chainId: CONFIG.chainId,
          asset: CONFIG.usdcAddress,
          currency: "USDC",
          amount: spec.amountMicroUnits,
          price: `${spec.priceUsd} USDC`,
          payTo: CONFIG.merchantAddress,
          scheme: "exact",
          facilitator: CONFIG.facilitator,
        },
      },
    };
  }

  return c.json({
    openapi: "3.0.3",
    info: {
      title: "RugShield 402",
      version: CONFIG.version,
      description: "Low-latency DEX honeypot detection, buy/sell tax simulation, LP lock proofs, and 7-vector institutional token report on Base for AI agents.",
      contact: {
        name: "AK Kurox",
        email: "ak10082247@gmail.com",
        url: "https://github.com/ak10082247-max/rugshield-402",
      },
    },
    servers: [{ url: baseUrl }],
    paths: openapiPaths,
  });
});

// Machine Discovery Manifest (RFC/x402 standard)
const getDiscoveryManifest = (baseUrl: string) => ({
  x402_version: "2.0",
  service: {
    name: "RugShield 402",
    id: "rugshield-402",
    description:
      "Low-latency token honeypot detection, buy/sell tax simulation, and pool liquidity verification for autonomous trading agents on Base.",
    documentation_url: `${baseUrl}/`,
    healthcheck_url: `${baseUrl}/health`,
  },
  payment: {
    protocol: "x402",
    network: `eip155:${CONFIG.chainId}`,
    chain_id: CONFIG.chainId,
    asset: CONFIG.usdcAddress,
    asset_symbol: "USDC",
    decimals: 6,
    merchant_address: CONFIG.merchantAddress,
    facilitator: CONFIG.facilitator,
    solana_network: CONFIG.solanaNetwork,
    solana_asset: CONFIG.solanaUsdcMint,
    solana_merchant_address: CONFIG.solanaMerchantAddress,
    solana_facilitator: CONFIG.payaiFacilitator,
    solana_fee_payer: CONFIG.solanaFeePayer,
    scheme: "exact",
  },
  bazaar: {
    category: "security",
    subcategories: ["defi", "honeypot-detection", "dex-simulation", "audit"],
    tags: ["base", "agentkit", "usdc", "honeypot", "dex", "aerodrome", "uniswap"],
    pricing_model: "per_call",
    developer: {
      github: "https://github.com/ak10082247-max/rugshield-402",
    },
  },
  endpoints: ENDPOINT_SPECS.map(s => ({
    path: s.path,
    method: "POST",
    methods: ["GET", "POST"],
    price_usd: s.priceUsd,
    amount: s.amountMicroUnits,
    description: s.description,
  })),
});

app.get("/.well-known/x402.json", (c) => c.json(getDiscoveryManifest(getBaseUrl(c))));
app.get("/.well-known/x402", (c) => c.json(getDiscoveryManifest(getBaseUrl(c))));

const CANONICAL_FACEABOT_TOOLS = [
  {
    name: "analyze_liquidity",
    description: "Verifies DEX LP token locking, vesting schedules, pool liquidity depth, and unwrap risks across Aerodrome and Uniswap. Cost: 0.020 USDC on Base & Solana Mainnet.",
    inputSchema: {
      type: "object",
      properties: {
        token_address: { type: "string", description: "Target ERC-20 contract address on Base (0x...) or Solana SPL Mint" },
      },
      required: ["token_address"],
    },
    outputSchema: {
      type: "object",
      required: ["total_liquidity_usd", "pools"],
      properties: {
        total_liquidity_usd: { type: "number", description: "Sum of verified pool reserves converted to USD" },
        pools: {
          type: "array",
          items: {
            type: "object",
            properties: {
              dex: { type: "string" },
              pool_address: { type: "string" },
              liquidity_usd: { type: "number" },
            },
          },
          description: "Breakdown of verified pools by DEX venue",
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "check_honeypot",
    description: "Instant honeypot verification and transfer fee detection for autonomous AI trading agents. Cost: 0.010 USDC on Base & Solana Mainnet.",
    inputSchema: {
      type: "object",
      properties: {
        token_address: { type: "string", description: "Target ERC-20 contract address on Base (0x...) or Solana SPL Mint" },
      },
      required: ["token_address"],
    },
    outputSchema: {
      type: "object",
      required: ["is_honeypot", "can_sell"],
      properties: {
        is_honeypot: { type: ["boolean", "null"], description: "Whether selling is prevented or taxes exceed 50%" },
        can_sell: { type: ["boolean", "null"], description: "Whether test sell order executed successfully" },
        buy_tax_bps: { type: ["integer", "null"], description: "Buy fee in basis points" },
        sell_tax_bps: { type: ["integer", "null"], description: "Sell fee in basis points" },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
];

const BASE_MCP_TOOLS = ENDPOINT_SPECS.map(s => {
  let toolName = s.path.replace(/^\/(api\/)?v1\//, "").replace(/[\/-]/g, "_");
  if (toolName === "scan") toolName = "rugshield_pre_swap_scan";
  else toolName = `rugshield_${toolName}`;

  const props: Record<string, any> = {
    token_address: { type: "string", description: "Target ERC-20 contract address on Base (0x...) or Solana SPL Mint" },
  };
  if (s.path.includes("swap-simulation")) {
    props.amount_usd = { type: "number", description: "Swap size in USD (e.g. 1000, 10000, 50000)" };
  }

  const outputSchema = toolName === "rugshield_pre_swap_scan" ? {
    type: "object",
    required: ["is_honeypot", "risk_score", "recommendation"],
    properties: {
      token: { type: "string", description: "Normalized token address" },
      symbol: { type: "string", description: "Verified ticker symbol" },
      is_honeypot: { type: "boolean", description: "Whether token prevents selling" },
      buy_tax_bps: { type: "integer", description: "Buy tax in basis points" },
      sell_tax_bps: { type: "integer", description: "Sell tax in basis points" },
      liquidity_usd: { type: "number", description: "Verified USD liquidity" },
      risk_score: { type: "number", description: "Composite risk score (0.0 safe to 1.0 extreme risk)" },
      risk_factors: { type: "array", items: { type: "string" }, description: "Identified risk vectors" },
      recommendation: { type: "string", enum: ["SAFE", "CAUTION", "DANGER_HONEYPOT"], description: "Execution verdict" },
    },
  } : {
    type: "object",
    required: ["status", "token_address", "verdict"],
    properties: {
      status: { type: "string", description: "Execution status" },
      token_address: { type: "string", description: "Target token address" },
      verdict: { type: "string", description: "Cryptographic assessment verdict" },
      risk_score: { type: "number", description: "Risk severity score" },
      data: { type: "object", description: "Detailed metric findings" },
    },
  };

  return {
    name: toolName,
    description: `${s.description} Cost: ${s.priceUsd} USDC on Base & Solana Mainnet.`,
    inputSchema: {
      type: "object",
      properties: props,
      required: ["token_address"],
    },
    outputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  };
});

const MCP_TOOLS = [...CANONICAL_FACEABOT_TOOLS, ...BASE_MCP_TOOLS];

const serverCard = {
  serverInfo: {
    name: "rugshield-402",
    version: CONFIG.version,
  },
  description:
    "Low-latency DEX honeypot detection, buy/sell tax simulation, and pool liquidity verification on Base for AI agents, gated by x402.",
  tools: MCP_TOOLS,
};

const agentRegistration = {
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "RugShield 402 — Autonomous Pre-Trade Honeypot & Alpha Sentinel",
  description: "Enterprise-grade dual-chain (Base & Solana) pre-trade honeypot simulation, mempool front-running risk detection, sybil holder cluster mapping, and DEX smart-money oracle operating under x402 v2 micropayments.",
  image: "https://rugshield-402.onrender.com/logo.png",
  version: CONFIG.version,
  url: "https://rugshield-402.onrender.com",
  provider: {
    name: "Kurox Real",
    url: "https://rugshield-402.onrender.com",
    wallet: CONFIG.merchantAddress,
  },
  active: true,
  capabilities: {
    streaming: true,
    pushNotifications: false,
  },
  erc8004: {
    identity_registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation_registry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    agent_card: "https://rugshield-402.onrender.com/.well-known/agent-card.json",
  },
  securitySchemes: [
    {
      type: "x402",
      description: "EIP-3009 TransferWithAuthorization on Base Mainnet (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) & SPL TransferChecked on Solana Mainnet (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).",
    },
  ],
  services: [
    {
      name: "MCP",
      endpoint: "https://rugshield-402.onrender.com/mcp",
      version: "2024-11-05",
    },
    {
      name: "HTTP",
      endpoint: "https://rugshield-402.onrender.com",
      version: "2.0",
    },
  ],
  supportedChains: [
    `eip155:${CONFIG.chainId}`,
    CONFIG.solanaNetwork,
  ],
  registrations: [
    {
      agentId: 335687,
      agentRegistry: "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    },
  ],
  supportedTrust: ["reputation"],
};

app.get("/.well-known/agent-registration.json", (c) => c.json(agentRegistration));
app.get("/.well-known/agent-card.json", (c) => c.json(agentRegistration));
app.get("/.well-known/agent.json", (c) => c.json(agentRegistration));
app.get("/.well-known/erc8004.json", (c) => c.json(agentRegistration));

app.get("/.well-known/mcp/server-card.json", (c) => c.json(serverCard));
app.get("/.well-known/mcp", (c) => c.json(serverCard));
app.get("/.well-known/mcp.json", (c) => c.json(serverCard));
app.get("/.well-known/mcp/server-cards.json", (c) => c.json(serverCard));
app.get("/.well-known/mcp-server-card", (c) => c.json(serverCard));
app.get("/.well-known/mcp-server-card.json", (c) => c.json(serverCard));
app.get("/.well-known/ai-catalog.json", (c) => c.json(serverCard));
app.get("/server-card.json", (c) => c.json(serverCard));
app.get("/server.json", (c) => c.json(serverCard));
app.get("/.well-known/server.json", (c) => c.json(serverCard));
app.get("/glama.json", (c) => c.json({
  $schema: "https://glama.ai/mcp/schemas/server.json",
  maintainers: ["ak10082247-max"],
  homepage: "https://rugshield-402.onrender.com"
}));
app.get("/.well-known/glama.json", (c) => c.json({
  $schema: "https://glama.ai/mcp/schemas/server.json",
  maintainers: ["ak10082247-max"],
  homepage: "https://rugshield-402.onrender.com"
}));

const oauthResourceMetadata = {
  resource: "https://rugshield-402.onrender.com",
  authorization_servers: [],
  scopes_supported: ["mcp:read", "mcp:call"],
  bearer_methods_supported: ["header"],
  auth_schemes: ["x402-v2-eip712", "x402-v2-solana"],
  payment_recipient: CONFIG.merchantAddress,
  documentation: "https://rugshield-402.onrender.com/docs",
  note: "Protected via on-chain x402 V2 gasless micropayments (EIP-712 / SPL TransferChecked)."
};
app.get("/.well-known/oauth-protected-resource", (c) => c.json(oauthResourceMetadata));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(oauthResourceMetadata));
app.get("/.well-known/oauth-authorization-server", (c) => c.json(oauthResourceMetadata));
app.get("/.well-known/openid-configuration", (c) => c.json(oauthResourceMetadata));
app.get("/mcp/server-card", (c) => c.json(serverCard));
app.get("/mcp/server-card.json", (c) => c.json(serverCard));
app.get("/.well-known/mcp/server-card", (c) => c.json(serverCard));
app.get("/mcp", (c) => c.json({ status: "ok", protocol: "model-context-protocol", ...serverCard }));

// MCP JSON-RPC 2.0 Handler (tools/list, initialize, ping, tools/call)
app.post("/mcp", async (c) => {
  try {
    const body = await c.req.json();
    const id = body.id ?? 1;
    const method = body.method;

    if (!method || Object.keys(body || {}).length === 0) {
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: "rugshield-402",
            version: CONFIG.version,
          },
          tools: MCP_TOOLS,
        },
      });
    }

    if (method === "initialize") {
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: "rugshield-402",
            version: CONFIG.version,
          },
        },
      });
    }

    if (method === "server/discover" || method === "server/info") {
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "rugshield-402",
            version: CONFIG.version,
          },
          capabilities: {
            tools: { listChanged: false },
          },
          tools: MCP_TOOLS,
        },
      });
    }

    if (method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }

    if (method === "ping") {
      return c.json({ jsonrpc: "2.0", id, result: {} });
    }

    if (method === "tools/list") {
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: MCP_TOOLS,
        },
      });
    }

    if (method === "resources/list" || method === "prompts/list") {
      const key = method.split("/")[0];
      return c.json({ jsonrpc: "2.0", id, result: { [key]: [] } });
    }

    if (method === "tools/call") {
      const toolName = body.params?.name;
      const args = body.params?.arguments || {};
      const token = args.token_address || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

      const matchedSpec = ENDPOINT_SPECS.find(s => {
        const name = s.path.replace(/^\/(api\/)?v1\//, "").replace(/[\/-]/g, "_");
        return toolName === `rugshield_${name}` || toolName === name;
      });
      const route = ["rugshield_pre_swap_scan", "rugshield_scan", "check_honeypot", "analyze_liquidity"].includes(toolName) ? "/v1/scan" : matchedSpec?.path;
      if (route) {
        const headers = new Headers({ "Content-Type": "application/json", "user-agent": "rugshield-mcp-client" });
        for (const name of ["payment-signature", "x-payment"]) {
          const value = c.req.header(name); if (value) headers.set(name, value);
        }
        const response = await app.request(new Request(`${getBaseUrl(c)}${route}`, { method: "POST", headers, body: JSON.stringify(args) }));
        const data = await response.json();
        for (const name of ["payment-required", "payment-response", "x-payment-required"]) {
          const value = response.headers.get(name); if (value) c.header(name, value);
        }
        return c.json({ jsonrpc: "2.0", id, result: { isError: !response.ok, content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } }, response.status as any);
      }

      return c.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    }

    return c.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not supported: ${method}` },
    });
  } catch (err: any) {
    return c.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${err.message}` },
    }, 400);
  }
});

// ==============================================================================
// 6 PAID ENDPOINTS (POST & GET, Pre-warmed <50ms Execution)
// ==============================================================================

const invalidScanInput = (c: any, error: any) => c.json({ status: "error", error: error.code || "INVALID_REQUEST", message: error.message, payment_collected: false }, 400);
const previewBudget = new PreviewBudget();

// 1. /v1/scan ($0.010 USDC)
const handleScan = async (c: any) => {
  let input;
  try { input = await readScanInput(c); } catch (error) { return invalidScanInput(c, error); }
  const { token, chain, simulate } = input;

  if (chain === "solana") {
    // This capability cannot be fulfilled yet. Avoid provider costs and quote expiry
    // for a request which must not settle regardless of the mint's metadata.
    if (simulate) return c.json({ status: "error", error: "SWAP_SIMULATION_UNAVAILABLE", chain, token_address: token, is_honeypot: null, simulation_status: "not_performed", message: "Solana buy/sell execution has not been implemented. No payment collected. Explicit simulate_sell:false requests mint inspection only.", payment_collected: false }, 503);
    let solanaScan;
    try { solanaScan = await scanSolanaToken(token); } catch (error) {
      const err = error as SolanaScanError;
      return c.json({ status: "error", error: err.code || "RPC_UNAVAILABLE", message: err.message, chain: "solana", token_address: token, is_honeypot: null }, err.httpStatus || 503);
    }
    return c.json(solanaScan, 200);
  }

  try {
    const scanResult: any = await scanToken({ token_address: token, chain_id: 8453, simulate_sell: simulate });
    if (simulate && scanResult.simulation_status !== "passed") return c.json({ ...scanResult, status: "error", error: "SWAP_SIMULATION_UNAVAILABLE", message: "A supported pool and valid stateful buy/sell execution could not be established. No payment collected.", payment_collected: false }, 503);
    scanResult.agent_continuation = AGENT_CONTINUATION;
    return c.json(scanResult, 200);
  } catch (err: any) {
    return c.json({
      status: "error",
      chain: "base",
      token_address: token,
      is_honeypot: null,
      error: err.message || "Failed to scan token on Base",
      simulation_status: "failed",
      verdict: "SCAN_FAILED_OR_INVALID_TOKEN",
      timestamp: Math.floor(Date.now() / 1000),
      agent_continuation: AGENT_CONTINUATION,
    }, 503);
  }
};
app.post("/v1/scan", handleScan);
app.get("/v1/scan", handleScan);

// Free Zero-Wallet Preview Endpoint for Butler Skills and Developers
const handleScanPreview = async (c: any) => {
  let input;
  try { input = await readScanInput(c); } catch (error) { return invalidScanInput(c, error); }
  const { token, chain } = input;
  c.header("Cache-Control", "no-store");
  c.header("X-Preview-Max-Age-Seconds", "5");

  if (chain === "solana") {
    let solanaScan;
    try { solanaScan = await previewBudget.acquire(`solana:${token}`, () => scanSolanaToken(token)); } catch (error) {
      const err = error as SolanaScanError;
      if (err.message === "PREVIEW_BUDGET_EXHAUSTED") { c.header("Retry-After", "60"); return c.json({ status: "error", error: "PREVIEW_RATE_LIMITED", payment_collected: false }, 429); }
      return c.json({ status: "error", error: err.code || "RPC_UNAVAILABLE", message: err.message, chain: "solana", token_address: token, is_honeypot: null }, err.httpStatus || 503);
    }
    return c.json({ ...solanaScan, preview: true }, solanaScan.status === "success" ? 200 : 400);
  }

  try {
    const scanResult: any = await previewBudget.acquire(`base:${token.toLowerCase()}`, () => scanToken({ token_address: token, chain_id: 8453, simulate_sell: false }));
    scanResult.preview = true;
    scanResult.agent_continuation = AGENT_CONTINUATION;
    return c.json(scanResult, 200);
  } catch (err: any) {
    if (err.message === "PREVIEW_BUDGET_EXHAUSTED") { c.header("Retry-After", "60"); return c.json({ status: "error", error: "PREVIEW_RATE_LIMITED", payment_collected: false }, 429); }
    return c.json({
      status: "error",
      preview: true,
      chain: "base",
      token_address: token,
      is_honeypot: null,
      error: err.message || "Failed to scan token on Base",
      simulation_status: "failed",
      verdict: "SCAN_FAILED_OR_INVALID_TOKEN",
      timestamp: Math.floor(Date.now() / 1000),
      agent_continuation: AGENT_CONTINUATION,
    }, 503);
  }
};
app.post("/v1/scan/preview", handleScanPreview);
app.get("/v1/scan/preview", handleScanPreview);

// Unimplemented acquisition must never be represented by sample data or charged as a completed audit.
const acquisitionResponse = async (c: any, acquire: (token: string) => Promise<any>) => {
  let input;
  try { input = await readScanInput(c); } catch (error) { return invalidScanInput(c, error); }
  const { token } = input;
  try { return c.json({ ...await acquire(token), payment_collected: false, error: "ANALYSIS_INCOMPLETE" }, 503); }
  catch (error: any) { return c.json({ status: "error", error: "ACQUISITION_UNAVAILABLE", message: error.message, payment_collected: false }, 503); }
};
const unavailableAnalysis = (c: any) => c.json({ status: "error", error: "ANALYSIS_UNAVAILABLE", endpoint: c.req.path, message: "Required provider or execution evidence is not available. No payment settlement was attempted.", payment_collected: false }, 503);
const handleLiquidityLock = async (c: any) => acquisitionResponse(c, liquidityLockEvidence);
app.post("/v1/audit/liquidity-lock-verify", handleLiquidityLock);
app.get("/v1/audit/liquidity-lock-verify", handleLiquidityLock);
const handleHolderClusterMap = unavailableAnalysis;
app.post("/v1/audit/holder-cluster-map", handleHolderClusterMap);
app.get("/v1/audit/holder-cluster-map", handleHolderClusterMap);
const handleSwapSimulationProof = unavailableAnalysis;
app.post("/v1/audit/swap-simulation-proof", handleSwapSimulationProof);
app.get("/v1/audit/swap-simulation-proof", handleSwapSimulationProof);
const handleCrossChainBridgeRisk = unavailableAnalysis;
app.post("/v1/audit/cross-chain-bridge-risk", handleCrossChainBridgeRisk);
app.get("/v1/audit/cross-chain-bridge-risk", handleCrossChainBridgeRisk);
const handleInstitutionalReport = unavailableAnalysis;
app.post("/v1/risk/institutional-token-report", handleInstitutionalReport);
app.get("/v1/risk/institutional-token-report", handleInstitutionalReport);
const handleNansenTokenScreener = async (c: any) => acquisitionResponse(c, tokenScreener);
app.post("/api/v1/token-screener", handleNansenTokenScreener);
app.get("/api/v1/token-screener", handleNansenTokenScreener);
const handleNansenSmartMoneyNetflow = unavailableAnalysis;
app.post("/api/v1/smart-money/netflow", handleNansenSmartMoneyNetflow);
app.get("/api/v1/smart-money/netflow", handleNansenSmartMoneyNetflow);
const handleNansenSmartMoneyDexTrades = unavailableAnalysis;
app.post("/api/v1/smart-money/dex-trades", handleNansenSmartMoneyDexTrades);
app.get("/api/v1/smart-money/dex-trades", handleNansenSmartMoneyDexTrades);
const handleNansenWhoBoughtSold = unavailableAnalysis;
app.post("/api/v1/tgm/who-bought-sold", handleNansenWhoBoughtSold);
app.get("/api/v1/tgm/who-bought-sold", handleNansenWhoBoughtSold);
const handleNansenHolders = async (c: any) => acquisitionResponse(c, holderConcentration);
app.post("/api/v1/tgm/holders", handleNansenHolders);
app.get("/api/v1/tgm/holders", handleNansenHolders);
const handleNansenAddressBalance = async (c: any) => acquisitionResponse(c, walletBalances);
app.post("/api/v1/profiler/address/current-balance", handleNansenAddressBalance);
app.get("/api/v1/profiler/address/current-balance", handleNansenAddressBalance);

// ==============================================================================
// SOLANA ACTIONS & BLINKS (/actions.json + /api/actions/scan)
// ==============================================================================

const ACTION_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Action-Version, X-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
  "X-Action-Version": "2.2",
  "X-Blockchain-Ids": CONFIG.solanaNetwork,
};

app.options("/actions.json", (c) => c.body(null, 204, ACTION_HEADERS));
app.get("/actions.json", (c) => {
  return c.json(
    {
      rules: [
        { pathPattern: "/**", apiPath: "/api/actions/scan" },
        { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" },
      ],
    },
    200,
    ACTION_HEADERS
  );
});

app.options("/api/actions/scan", (c) => c.body(null, 204, ACTION_HEADERS));
app.get("/api/actions/scan", (c) => c.json({ type: "action", icon: `${getBaseUrl(c)}/favicon.ico`, title: "RugShield inspection", description: "Solana Action payment fulfillment is not available. Use the x402 API for supported analysis.", label: "Unavailable", disabled: true, error: { message: "No token risk or liquidity conclusion has been acquired." } }, 200, ACTION_HEADERS));

app.post("/api/actions/scan", (c) => c.json({ type: "error", error: { message: "Action payment fulfillment is unavailable. Use the x402 /v1/scan API; no transaction or unlocked report has been created." } }, 503, ACTION_HEADERS));

// ==============================================================================
// LIVE TRAFFIC MAGNET FEED (/v1/feed/live-alerts)
// ==============================================================================

const LIVE_ALERTS_BUFFER: Array<Record<string, any>> = [];

app.get("/v1/feed/live-alerts", (c) => {
  return c.json({
    status: "ok",
    service: CONFIG.serviceName,
    description: "Live 3-minute Solana (Pump.fun/DexScreener) & Base graduated token risk teasers with 1-click $0.01 USDC x402 unlock links.",
    solana_merchant: CONFIG.solanaMerchantAddress,
    base_merchant: CONFIG.merchantAddress,
    count: LIVE_ALERTS_BUFFER.length,
    alerts: LIVE_ALERTS_BUFFER.slice(0, 30),
  });
});

app.post("/v1/feed/live-alerts", (c) => c.json({ status: "error", error: "FEED_PUBLISHING_UNAVAILABLE", message: "Authenticated evidence ingestion is required." }, 503));

// Flight Recorder Telemetry Endpoint
app.get("/v1/telemetry/deliveries", (c) => {
  const deliveries = getRecentDeliveries();
  const paid = getPaidDeliveries();
  return c.json({
    status: "ok",
    service: CONFIG.serviceName,
    paid_count: paid.length,
    paid_deliveries: paid,
    count: deliveries.length,
    deliveries,
  });
});

// Telemetry & Payment Metrics Endpoint: GET /v1/stats
app.get("/v1/stats", (c) => {
  return c.json({
    status: "ok",
    service: CONFIG.serviceName,
    version: CONFIG.version,
    chain_id: CONFIG.chainId,
    merchant_address: CONFIG.merchantAddress,
    total_endpoints: ENDPOINT_SPECS.length,
    endpoints: ENDPOINT_SPECS.map(s => ({ path: s.path, price: `${s.priceUsd} USDC` })),
    metrics: {
      challenges_issued: X402_METRICS.challenges,
      payments_verified: X402_METRICS.settlements,
      replays_blocked: X402_METRICS.replaysPrevented,
    },
    timestamp: Math.floor(Date.now() / 1000),
  });
});

// IndexNow ownership verification key (must be served at the domain root)
app.get("/kurox402indexnowkey20261022abc.txt", (c) => c.text("kurox402indexnowkey20261022abc"));

app.get("/robots.txt", (c) => {
  const baseUrl = getBaseUrl(c);
  return c.text(`User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: Meta-ExternalAgent
Allow: /

User-agent: CCBot
Allow: /

Sitemap: ${baseUrl}/sitemap.xml
LLMs-Txt: ${baseUrl}/llms.txt
`);
});

app.get("/sitemap.xml", (c) => {
  const baseUrl = getBaseUrl(c);
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${baseUrl}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>\n  <url><loc>${baseUrl}/llms.txt</loc><changefreq>daily</changefreq><priority>0.9</priority></url>\n  <url><loc>${baseUrl}/llms-full.txt</loc><changefreq>daily</changefreq><priority>0.9</priority></url>\n  <url><loc>${baseUrl}/openapi.json</loc><changefreq>daily</changefreq><priority>0.9</priority></url>\n  <url><loc>${baseUrl}/pricing</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>\n  <url><loc>${baseUrl}/privacy</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>\n  <url><loc>${baseUrl}/terms</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>\n  <url><loc>${baseUrl}/.well-known/x402.json</loc><changefreq>hourly</changefreq><priority>0.9</priority></url>\n  ${ENDPOINT_SPECS.map(s => `<url><loc>${baseUrl}${s.path}</loc><changefreq>hourly</changefreq><priority>0.8</priority></url>`).join("\n  ")}\n</urlset>`,
    200,
    { "Content-Type": "application/xml" }
  );
});

// Bounty Challenge Redirect to Fleet Leader
app.get("/bounty.html", (c) => c.redirect("https://canaryguard-402.onrender.com/bounty.html", 302));

// Compliance, SEO & Metadata Routes
const pricingHandler = (c: any) => c.json({
  service: "rugshield-402",
  pricing_model: "x402-pay-per-request",
  accepted_currencies: ["USDC on Base (eip155:8453)", "USDC on Solana (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)"],
  gasless_sponsorship: "100% sponsored ($0 ETH / $0 SOL required)",
  tier_base: { price_per_request: "0.010 USDC", amount_micro: 10000, description: "Pre-Trade Honeypot Calldata Simulation & LP Lock Audit" },
  tier_premium: { price_per_request: "0.020 USDC", amount_micro: 20000, description: "Sybil Cluster Map & Smart-Money Inflow Radar" },
  challenge_bounty_url: "https://canaryguard-402.onrender.com/bounty.html",
  docs: "https://rugshield-402.onrender.com/stats"
});
app.get("/pricing", pricingHandler);
app.get("/plans", pricingHandler);

const privacyHandler = (c: any) => c.json({
  service: "rugshield-402",
  privacy_summary: "Zero-retention deterministic security proxy. No private keys or proprietary trading queries stored on disk.",
  data_handling: "Ephemeral, in-memory processing. calldata is evaluated statelessly in <1ms and discarded immediately.",
  telemetry: "Only anonymous on-chain transaction hashes and token simulation latency metrics are logged for SLA verification.",
  contact: "security@canaryguard.network"
});
app.get("/privacy", privacyHandler);
app.get("/legal/privacy", privacyHandler);
app.get("/privacy-policy", privacyHandler);

const termsHandler = (c: any) => c.json({
  service: "rugshield-402",
  protocol: "x402 V2 HTTP Micropayment Protocol",
  terms: [
    "All API requests are settled on-chain via EIP-712 or SPL Token transfer authorization.",
    "Settlements are instant, final, and non-refundable once verified by the facilitator.",
    "Red-Team Challenge Bounty: Hosted at https://canaryguard-402.onrender.com/bounty.html"
  ],
  compliance: "Non-custodial cryptographic settlement infrastructure."
});
app.get("/terms", termsHandler);
app.get("/legal/terms", termsHandler);
app.get("/terms-of-service", termsHandler);

const aboutHandler = (c: any) => c.json({
  name: "RugShield 402",
  mission: "Autonomous AI Agent Pre-Trade Honeypot Calldata Simulation & Liquidity Security Suite",
  network: "Base Mainnet (8453) & Solana Mainnet",
  facilitators: ["Coinbase CDP", "PayAI Network"],
  bounty_challenge: "https://canaryguard-402.onrender.com/bounty.html",
  docs: "https://rugshield-402.onrender.com/stats"
});
app.get("/about", aboutHandler);
app.get("/about-us", aboutHandler);
app.get("/team", aboutHandler);
app.get("/leadership", aboutHandler);

const faqHelpHandler = (c: any) => c.json({
  service: "RugShield 402",
  tagline: "Autonomous Pre-Trade Honeypot Calldata Simulation & Institutional Risk Audit Suite",
  faq: [
    {
      question: "What is RugShield 402?",
      answer: "RugShield provides pre-trade honeypot simulation, buy/sell transfer tax audit down to 0.01% fee, LP lock verification, and smart-money orderflow tracking on Base and Solana for AI agents and snipers."
    },
    {
      question: "How do payments work?",
      answer: "All endpoints are metered via HTTP 402 (x402 V2). Agents pay micropayments ($0.010 - $0.020 USDC) via EIP-712 on Base or SPL Token TransferChecked on Solana."
    },
    {
      question: "Do I need ETH or SOL for gas?",
      answer: "No. Settlements are 100% gasless ($0 ETH / $0 SOL required) through Coinbase CDP and PayAI facilitator sponsorship."
    },
    {
      question: "Where can I find the API documentation and MCP manifest?",
      answer: "OpenAPI specification is available at /openapi.json, x402 discovery at /.well-known/x402.json, and Model Context Protocol cards at /mcp and /mcp/server-card."
    }
  ],
  resources: {
    documentation: "/openapi.json",
    discovery: "/.well-known/x402.json",
    mcp_card: "/mcp/server-card",
    web_terminal: "/",
    telemetry: "/v1/telemetry/deliveries",
  },
  support: {
    github: "https://github.com/ak10082247-max/rugshield-402"
  }
});

app.get("/help", faqHelpHandler);
app.get("/faq", faqHelpHandler);
app.get("/faqs", faqHelpHandler);
app.get("/support", faqHelpHandler);
app.get("/guide", faqHelpHandler);
app.get("/docs/faq", faqHelpHandler);
app.get("/company", aboutHandler);
app.get("/contact", aboutHandler);
app.get("/contact-us", aboutHandler);
app.get("/press", aboutHandler);

if (process.env.APIFY_IS_AT_HOME || process.env.APIFY_ACT_ID || process.env.APIFY_ACTOR_RUN_ID) {
  await import("./apify_entry.js");
} else if (process.env.RUGSHIELD_NO_LISTEN !== "1") {
  const server = serve(
    {
      fetch: app.fetch,
      port: CONFIG.port,
    },
    (info) => {
      console.log(`[rugshield-402] Server running on http://localhost:${info.port}`);
      console.log(`[rugshield-402] Merchant: ${CONFIG.merchantAddress} | Chain: Base (${CONFIG.chainId})`);
      console.log(`[rugshield-402] Endpoints active: ${ENDPOINT_SPECS.length}`);

      const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${info.port}`;
      startHeartbeat(publicUrl);
    }
  );
}

export default app;
