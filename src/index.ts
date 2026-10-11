import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { CONFIG } from "./config.js";
import { x402Middleware } from "./middleware/x402.js";
import { scanToken } from "./services/simulator.js";
import { startHeartbeat } from "./services/heartbeat.js";

const app = new Hono();

// Global middleware
app.use("*", x402Middleware);

// Health check endpoint (free, no auth, monitored by keep-alive)
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: CONFIG.serviceName,
    version: CONFIG.version,
    chain_id: CONFIG.chainId,
    timestamp: Math.floor(Date.now() / 1000),
  });
});

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
    description: "Low-latency token honeypot detection & tax simulation on Base for AI agents",
    pricing: "0.005 USDC per scan (5000 micro-units)",
    health: "/health",
    discovery: "/.well-known/x402.json",
    endpoints: {
      scan: "POST /v1/scan",
      mcp: "GET /mcp",
      app: "GET /app",
      llms: "GET /llms.txt",
    },
  });
});

app.get("/llms.txt", (c) => {
  const filePath = join(process.cwd(), "public", "llms.txt");
  if (existsSync(filePath)) {
    return c.text(readFileSync(filePath, "utf-8"), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  }
  return c.text("# RugShield 402 - Honeypot & Tax Simulation API on Base Mainnet\nEndpoint: POST /v1/scan", 200);
});

app.get("/llms-full.txt", (c) => {
  return c.redirect("/llms.txt");
});

app.get("/app", (c) => {
  const htmlPath = join(process.cwd(), "public", "index.html");
  if (existsSync(htmlPath)) {
    return c.html(readFileSync(htmlPath, "utf-8"));
  }
  return c.redirect("/");
});

// Machine Discovery Manifest (RFC/x402 standard)
const getDiscoveryManifest = (baseUrl: string) => ({
  x402_version: "1.0",
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
    network: "base",
    chain_id: CONFIG.chainId,
    asset: CONFIG.usdcAddress,
    asset_symbol: "USDC",
    decimals: 6,
    amount: CONFIG.amountMicroUnits,
    unit_price_usd: CONFIG.unitPriceUsd,
    merchant_address: CONFIG.merchantAddress,
    facilitator: CONFIG.facilitator,
    scheme: "exact",
  },
  bazaar: {
    category: "security",
    subcategories: ["defi", "honeypot-detection", "dex-simulation"],
    tags: ["base", "agentkit", "elizaos", "usdc", "honeypot", "dex", "aerodrome", "uniswap"],
    pricing_model: "per_call",
    developer: {
      github: "https://github.com/ak10082247-max/rugshield-402",
      package: "@kurox_real/agentkit-rugshield-402",
    },
  },
  endpoints: [
    {
      path: "/v1/scan",
      method: "POST",
      price_usd: "0.005",
      description:
        "Simulates DEX buy/sell orders on Base to detect honeypot traps, compute buy/sell taxes in bps, and calculate USD liquidity depth.",
      input_schema: {
        type: "object",
        properties: {
          token_address: {
            type: "string",
            description: "Target ERC-20 contract address on Base (0x...)",
          },
          chain_id: {
            type: "integer",
            default: 8453,
          },
          simulate_sell: {
            type: "boolean",
            default: true,
          },
        },
        required: ["token_address"],
      },
      output_schema: {
        type: "object",
        properties: {
          token: { type: "string" },
          symbol: { type: "string" },
          is_honeypot: { type: "boolean" },
          buy_tax_bps: { type: "integer" },
          sell_tax_bps: { type: "integer" },
          liquidity_usd: { type: "number" },
          risk_score: { type: "number" },
          recommendation: { type: "string" },
          attestation: { type: "string" },
          timestamp: { type: "integer" },
        },
      },
    },
  ],
  mcp: {
    endpoint: `${baseUrl}/mcp`,
    tools: ["rugshield_pre_swap_scan"],
  },
});

app.get("/.well-known/x402.json", (c) => {
  const host = c.req.header("host") || `localhost:${CONFIG.port}`;
  const proto = c.req.header("x-forwarded-proto") || "https";
  const baseUrl = `${proto}://${host}`;
  return c.json(getDiscoveryManifest(baseUrl));
});

app.get("/.well-known/x402", (c) => {
  const host = c.req.header("host") || `localhost:${CONFIG.port}`;
  const proto = c.req.header("x-forwarded-proto") || "https";
  const baseUrl = `${proto}://${host}`;
  return c.json(getDiscoveryManifest(baseUrl));
});

const serverCard = {
  serverInfo: {
    name: "rugshield-402",
    version: CONFIG.version,
  },
  description:
    "Low-latency DEX honeypot detection, buy/sell tax simulation, and pool liquidity verification on Base for AI agents, gated by x402.",
  tools: [
    {
      name: "rugshield_pre_swap_scan",
      description:
        "Simulates DEX buy/sell orders on Base to detect honeypots, compute buy/sell taxes in bps, and calculate USD liquidity depth before executing swaps. Cost: 0.005 USDC on Base.",
      inputSchema: {
        type: "object",
        properties: {
          token_address: {
            type: "string",
            description: "Target ERC-20 contract address on Base (0x...)",
          },
          chain_id: {
            type: "integer",
            default: 8453,
          },
          simulate_sell: {
            type: "boolean",
            default: true,
          },
        },
        required: ["token_address"],
      },
    },
  ],
};

app.get("/.well-known/mcp/server-card.json", (c) => {
  return c.json(serverCard);
});

app.get("/.well-known/mcp", (c) => {
  return c.json(serverCard);
});

app.get("/server-card.json", (c) => {
  return c.json(serverCard);
});

app.get("/mcp/server-card.json", (c) => {
  return c.json(serverCard);
});

// MCP discovery and inspection endpoint
app.get("/mcp", (c) => {
  return c.json({
    status: "ok",
    protocol: "model-context-protocol",
    transport: "stdio/sse",
    ...serverCard,
  });
});

// MCP JSON-RPC protocol endpoint (Smithery & MCP client scanner)
app.post("/mcp", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = body.id ?? null;
  const method = body.method;

  if (method === "initialize") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "rugshield-402",
          version: CONFIG.version,
        },
      },
    });
  }

  if (method === "notifications/initialized") {
    return c.json({ jsonrpc: "2.0", result: {} });
  }

  if (method === "ping") {
    return c.json({ jsonrpc: "2.0", id, result: {} });
  }

  if (method === "tools/list") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: serverCard.tools,
      },
    });
  }

  if (method === "tools/call") {
    const params = body.params || {};
    if (params.name === "rugshield_pre_swap_scan") {
      const args = params.arguments || {};
      const scanResult = await scanToken({
        token_address: args.token_address,
        chain_id: args.chain_id || 8453,
        simulate_sell: args.simulate_sell ?? true,
      });
      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(scanResult, null, 2),
            },
          ],
        },
      });
    }
  }

  return c.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method ${method} not found`,
      },
    },
    200
  );
});

const scanBodySchema = z.object({
  token_address: z.string().min(42).max(42),
  chain_id: z.number().optional().default(8453),
  simulate_sell: z.boolean().optional().default(true),
});

// Protected Core Endpoint: POST /v1/scan ($0.005 USDC)
app.post("/v1/scan", async (c) => {
  try {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = scanBodySchema.safeParse(raw);

    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_request",
          details: parsed.error.format(),
        },
        400
      );
    }

    const result = await scanToken(parsed.data);
    return c.json(result, 200);
  } catch (err: any) {
    return c.json(
      {
        error: "scan_failed",
        message: err.message,
      },
      500
    );
  }
});

// Public Live Stream Endpoint: GET /v1/recent-scans
app.get("/v1/recent-scans", async (c) => {
  const { RECENT_SCANS } = await import("./workers/autonomous_scanner.js");
  return c.json({
    status: "ok",
    network: "base",
    total: RECENT_SCANS.length,
    scans: RECENT_SCANS,
  });
});

const server = serve(
  {
    fetch: app.fetch,
    port: CONFIG.port,
  },
  (info) => {
    console.log(`[rugshield-402] Server running on http://localhost:${info.port}`);
    console.log(`[rugshield-402] Merchant: ${CONFIG.merchantAddress} | Chain: Base (${CONFIG.chainId})`);

    // Start anti-cold-start heartbeat
    const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${info.port}`;
    startHeartbeat(publicUrl);

    // Auto-start Telegram Bot if configured
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (botToken) {
      import("./bot/telegram.js")
        .then(({ RugShieldTelegramBot }) => {
          const bot = new RugShieldTelegramBot(botToken);
          bot.startPolling().catch((err) => console.error("[telegram-bot] Polling error:", err));
          console.log("[rugshield-402] Telegram bot service started.");
        })
        .catch((err) => console.error("[telegram-bot] Failed to initialize:", err));
    }

    // Auto-start Autonomous Base Token Scanner Daemon
    import("./workers/autonomous_scanner.js")
      .then(({ startAutonomousScanner }) => {
        startAutonomousScanner(10 * 60 * 1000);
      })
      .catch((err) => console.error("[autonomous-scanner] Failed to start:", err));
  }
);

export default app;
