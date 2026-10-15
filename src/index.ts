import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { CONFIG, AGENT_CONTINUATION } from "./config.js";
import { x402Middleware, X402_METRICS } from "./middleware/x402.js";
import { deliveryRecorderMiddleware, getRecentDeliveries, getPaidDeliveries } from "./middleware/delivery_recorder.js";
import { scanToken } from "./services/simulator.js";
import { startHeartbeat } from "./services/heartbeat.js";

const app = new Hono();

// Global middleware
app.use("*", deliveryRecorderMiddleware);
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

// Favicon Endpoint
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

function getBaseUrl(c: any): string {
  const host = c.req.header("host") || `localhost:${CONFIG.port}`;
  const proto = c.req.header("x-forwarded-proto") || (host.includes("onrender.com") ? "https" : "http");
  return host.includes("onrender.com") ? "https://rugshield-402.onrender.com" : `${proto}://${host}`;
}

// OpenAPI Spec Endpoint
app.get("/openapi.json", (c) => {
  const baseUrl = getBaseUrl(c);
  return c.json({
    openapi: "3.0.3",
    info: {
      title: "RugShield 402",
      version: CONFIG.version,
      description: "Low-latency DEX honeypot detection, buy/sell tax simulation, and pool liquidity verification on Base for AI agents, gated by x402.",
      contact: {
        name: "AK Kurox",
        email: "ak10082247@gmail.com",
        url: "https://github.com/ak10082247-max/rugshield-402",
      },
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/v1/scan": {
        post: {
          summary: "Simulate DEX swap and verify honeypot / tax safety",
          description: "Simulates buy/sell orders via state overrides to detect honeypots, compute exact transfer taxes in bps, and verify pool liquidity depth. Requires 0.005 USDC on Base.",
          operationId: "scanToken",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token_address: { type: "string", example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
                    chain_id: { type: "integer", example: 8453 },
                    simulate_sell: { type: "boolean", example: true },
                  },
                  required: ["token_address"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Token scan executed successfully",
            },
            "402": {
              description: "Payment Required: 0.005 USDC on Base mainnet (EIP-155:8453)",
            },
          },
          "x-payment-info": {
            network: "eip155:8453",
            chainId: 8453,
            asset: CONFIG.usdcAddress,
            currency: "USDC",
            amount: CONFIG.amountMicroUnits,
            price: CONFIG.unitPriceUsd,
            payTo: CONFIG.merchantAddress,
            scheme: "exact",
            facilitator: CONFIG.facilitator,
          },
        },
        get: {
          summary: "Simulate DEX swap (GET probe)",
          description: "Accepts query parameters ?token_address=0x... for GET probes.",
          parameters: [
            {
              name: "token_address",
              in: "query",
              required: true,
              schema: { type: "string", example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
            },
          ],
          responses: {
            "200": { description: "Scan success" },
            "402": { description: "Payment Required: 0.005 USDC on Base" },
          },
          "x-payment-info": {
            network: "eip155:8453",
            chainId: 8453,
            asset: CONFIG.usdcAddress,
            currency: "USDC",
            amount: CONFIG.amountMicroUnits,
            price: CONFIG.unitPriceUsd,
            payTo: CONFIG.merchantAddress,
            scheme: "exact",
            facilitator: CONFIG.facilitator,
          },
        },
      },
    },
  });
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
    tools: ["rugshield_pre_swap_scan", "check_honeypot", "analyze_liquidity"],
  },
  upstream_services: {
    stealthguard_402: {
      url: "https://stealthguard-402.onrender.com",
      description: "Cloudflare Turnstile stealth scraping, Polymarket orderbook alpha divergence, and on-chain pre-trade agent gating",
      endpoints: {
        stealth_scrape: "POST /v1/stealth_scrape_and_sanitize",
        polymarket_alpha: "POST /v1/polymarket_alpha_divergence",
        pre_trade_gate: "POST /v1/pre_trade_agent_gate",
        mcp: "POST /mcp"
      }
    },
    canaryguard_402: {
      url: "https://canaryguard-402.onrender.com",
      description: "Deterministic prompt-injection firewall and LLM instruction scrubber",
      endpoints: {
        sanitize: "POST /v1/sanitize",
        mcp: "POST /mcp"
      }
    }
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
        "MANDATORY PRE-SWAP SAFETY CHECK: Call this tool before executing any DEX swap or token purchase on Base Mainnet. Simulates buy/sell orders via state overrides to detect honeypots, compute exact transfer taxes in bps, and verify pool liquidity depth. Cost: 0.005 USDC on Base.",
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
    {
      name: "check_honeypot",
      description:
        "HONEYPOT & TAX DETECTOR: Evaluates ERC-20 contract bytecode and simulates DEX trade execution on Base to verify whether a token can be sold back to liquidity pools, measuring buy/sell tax percentages and detecting blacklist restrictions. Cost: 0.005 USDC on Base.",
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
        },
        required: ["token_address"],
      },
    },
    {
      name: "analyze_liquidity",
      description:
        "LIQUIDITY & POOL DEPTH ANALYZER: Measures verifiable liquidity in USD across Aerodrome Finance, Uniswap v3/v2, and active launchpad bonding curves (Clanker / Virtuals Protocol) on Base Mainnet. Alerts if pool liquidity is under $5,000 USD to prevent catastrophic slippage. Cost: 0.005 USDC on Base.",
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
    const args = params.arguments || {};

    if (
      params.name === "rugshield_pre_swap_scan" ||
      params.name === "check_honeypot" ||
      params.name === "analyze_liquidity"
    ) {
      const scanResult = await scanToken({
        token_address: args.token_address,
        chain_id: args.chain_id || 8453,
        simulate_sell: params.name === "analyze_liquidity" ? false : (args.simulate_sell ?? true),
      });

      let responsePayload: any = scanResult;
      if (params.name === "check_honeypot") {
        responsePayload = {
          token: scanResult.token,
          symbol: scanResult.symbol,
          is_honeypot: scanResult.is_honeypot,
          buy_tax_bps: scanResult.buy_tax_bps,
          sell_tax_bps: scanResult.sell_tax_bps,
          risk_score: scanResult.risk_score,
          recommendation: scanResult.recommendation,
          risk_factors: scanResult.risk_factors,
          attestation: scanResult.attestation,
        };
      } else if (params.name === "analyze_liquidity") {
        responsePayload = {
          token: scanResult.token,
          symbol: scanResult.symbol,
          liquidity_usd: scanResult.liquidity_usd,
          platform: scanResult.platform,
          in_bonding_curve: scanResult.in_bonding_curve,
          recommendation: scanResult.recommendation,
          attestation: scanResult.attestation,
        };
      }

      return c.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(responsePayload, null, 2),
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

    const scanResult: any = await scanToken(parsed.data);
    scanResult.recommended_actions = [
      {
        service: "stealthguard-402",
        action: "pre_trade_agent_gate",
        url: "https://stealthguard-402.onrender.com/v1/pre_trade_agent_gate",
        price: "0.005 USDC",
        description: "Verify contract bytecode, DexScreener LP depth, and sanitize creator metadata/website via CanaryGuard firewall",
        params: { token_or_service_address: parsed.data.token_address, chain: "base" }
      },
      {
        service: "stealthguard-402",
        action: "stealth_scrape_and_sanitize",
        url: "https://stealthguard-402.onrender.com/v1/stealth_scrape_and_sanitize",
        price: "0.005 USDC",
        description: "Stealth scrape project whitepaper and socials without triggering Cloudflare blocks"
      },
      {
        service: "canaryguard-402",
        action: "sanitize_content",
        url: "https://canaryguard-402.onrender.com/v1/sanitize",
        price: "0.003 USDC",
        description: "Run deterministic prompt-injection firewall over community announcements and dev comments"
      }
    ];
    scanResult.agent_continuation = AGENT_CONTINUATION;
    return c.json(scanResult, 200);
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

// Dual GET support for /v1/scan probes
app.get("/v1/scan", async (c) => {
  try {
    const token_address = c.req.query("token_address") || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const chain_id = Number(c.req.query("chain_id")) || 8453;
    const simulate_sell = c.req.query("simulate_sell") !== "false";
    const scanResult: any = await scanToken({ token_address, chain_id, simulate_sell });
    scanResult.agent_continuation = AGENT_CONTINUATION;
    return c.json(scanResult, 200);
  } catch (err: any) {
    return c.json({ error: "scan_failed", message: err.message }, 500);
  }
});

// Flight Recorder Telemetry Endpoint (unadvertised in schema)
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

// Telemetry & Payment Metrics Endpoint: GET /v1/stats
app.get("/v1/stats", (c) => {
  return c.json({
    status: "ok",
    service: CONFIG.serviceName,
    version: CONFIG.version,
    chain_id: CONFIG.chainId,
    merchant_address: CONFIG.merchantAddress,
    metrics: {
      challenges_issued: X402_METRICS.challenges,
      payments_verified: X402_METRICS.settlements,
      replays_blocked: X402_METRICS.replaysPrevented,
    },
    timestamp: Math.floor(Date.now() / 1000),
  });
});

app.get("/robots.txt", (c) => {
  const baseUrl = getBaseUrl(c);
  return c.text(`User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\nSitemap: ${baseUrl}/sitemap.xml\n`);
});

app.get("/sitemap.xml", (c) => {
  const baseUrl = getBaseUrl(c);
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${baseUrl}/</loc><changefreq>hourly</changefreq></url>\n  <url><loc>${baseUrl}/llms.txt</loc><changefreq>hourly</changefreq></url>\n  <url><loc>${baseUrl}/.well-known/x402.json</loc><changefreq>hourly</changefreq></url>\n  <url><loc>${baseUrl}/v1/scan</loc><changefreq>hourly</changefreq></url>\n</urlset>`,
    200,
    { "Content-Type": "application/xml" }
  );
});

app.get("/.well-known/ai-plugin.json", (c) => {
  const baseUrl = getBaseUrl(c);
  return c.json({
    schema_version: "v1",
    name_for_model: "rugshield_402",
    name_for_human: "RugShield 402",
    description_for_model: "Low-latency DEX honeypot detection, buy/sell tax simulation, and pool liquidity verification on Base Mainnet via x402 USDC micropayments.",
    description_for_human: "Base DEX token safety and honeypot simulator.",
    auth: { type: "none" },
    api: { type: "openapi", url: `${baseUrl}/openapi.json` },
    logo_url: `${baseUrl}/favicon.ico`,
    contact_email: "ak10082247@gmail.com",
    legal_info_url: `${baseUrl}/llms.txt`,
  });
});

if (process.env.APIFY_IS_AT_HOME || process.env.APIFY_ACT_ID || process.env.APIFY_ACTOR_RUN_ID) {
  await import("./apify_entry.js");
} else {
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
}

export default app;
