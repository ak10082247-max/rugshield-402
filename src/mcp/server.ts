import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scanToken } from "../services/simulator.js";
import { CONFIG } from "../config.js";

export function createRugshieldMcpServer(): McpServer {
  const server = new McpServer({
    name: "rugshield-402",
    version: "1.0.0",
  });

  server.tool(
    "rugshield_pre_swap_scan",
    "Local read-only Base inspection and stateful buy/sell simulation for a supported Uniswap V2 WETH pool at 0.001 ETH. Returns scoped evidence or unknowns. No transaction is broadcast.",
    {
      token_address: z
        .string()
        .min(42)
        .max(42)
        .describe("The ERC-20 token address on Base (0x...) to analyze"),
      simulate_sell: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to simulate immediate sell order to test for honeypot traps"),
    },
    async ({ token_address, simulate_sell }) => {
      try {
        const result = await scanToken({
          token_address,
          chain_id: CONFIG.chainId,
          simulate_sell,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `RugShield scan error: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "check_honeypot",
    "Local read-only buy/sell test for a supported Base Uniswap V2 WETH pool at 0.001 ETH. Measured taxes apply only to that simulation; unsupported cases are unknown.",
    {
      token_address: z
        .string()
        .min(42)
        .max(42)
        .describe("The ERC-20 token address on Base (0x...) to verify for honeypot risks"),
    },
    async ({ token_address }) => {
      try {
        const result = await scanToken({
          token_address,
          chain_id: CONFIG.chainId,
          simulate_sell: true,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  token: result.token,
                  symbol: result.symbol,
                  is_honeypot: result.is_honeypot,
                  buy_tax_bps: result.buy_tax_bps,
                  sell_tax_bps: result.sell_tax_bps,
                  risk_score: result.risk_score,
                  recommendation: result.recommendation,
                  risk_factors: result.risk_factors,
                  attestation: result.attestation,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Honeypot check error: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "analyze_liquidity",
    "Local Base metadata plus acquired DexScreener pool liquidity. Provider liquidity is not LP lock or trade execution proof.",
    {
      token_address: z
        .string()
        .min(42)
        .max(42)
        .describe("The ERC-20 token address on Base (0x...) to analyze liquidity depth for"),
    },
    async ({ token_address }) => {
      try {
        const result = await scanToken({
          token_address,
          chain_id: CONFIG.chainId,
          simulate_sell: false,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  token: result.token,
                  symbol: result.symbol,
                  liquidity_usd: result.liquidity_usd,
                  platform: result.platform,
                  in_bonding_curve: result.in_bonding_curve,
                  recommendation: result.recommendation,
                  attestation: result.attestation,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Liquidity analysis error: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

// Standalone execution via stdio (for Cursor, Claude Desktop, local MCP agents)
if (process.argv[1] && process.argv[1].includes("mcp")) {
  const mcpServer = createRugshieldMcpServer();
  const transport = new StdioServerTransport();
  mcpServer.connect(transport).then(() => {
    console.error("[mcp] RugShield MCP Server running on stdio");
  });
}
