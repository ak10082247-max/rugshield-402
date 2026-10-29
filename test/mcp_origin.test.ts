import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const PUBLIC = "https://rugshield-402.onrender.com";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const json = (body: any) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const decodeHeader = (response: Response, name: string) => JSON.parse(Buffer.from(response.headers.get(name)!, "base64").toString());
const mcpBody = (args: any) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "rugshield_pre_swap_scan", arguments: args } });

test("HTTP and MCP bind the same request origin without forwarding untrusted authorities", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "rug-origin-"));
  process.env.RUGSHIELD_NO_LISTEN = "1";
  process.env.RUGSHIELD_DISABLE_DELIVERY_LOGGING = "1";
  process.env.X402_FULFILLMENT_DIR = directory;
  process.env.X402_FREE_TRIAL_ENABLED = "0";
  process.env.DOTENV_CONFIG_PATH = join(directory, "empty.env");
  writeFileSync(process.env.DOTENV_CONFIG_PATH, "");
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("Unexpected external request in offline origin regression"); }) as typeof fetch;
  try {
    const { default: app } = await import("../src/index.js");
    for (const [name, origin, headers, expected] of [
      ["public Request URL without a Host header", PUBLIC, {}, PUBLIC],
      ["public reverse proxy", "http://rugshield-402.onrender.com", { host: "rugshield-402.onrender.com", "x-forwarded-proto": "https" }, PUBLIC],
      ["custom HTTPS binding", "https://rug.test:8443", {}, "https://rug.test:8443"],
      ["custom reverse proxy", "http://rug.test:8443", { host: "rug.test:8443", "x-forwarded-proto": "https" }, "https://rug.test:8443"],
      ["explicit local development port", "http://localhost:4567", { host: "localhost:4567" }, "http://localhost:4567"],
      ["local IPv6 binding", "http://[::1]:4567", { host: "[::1]:4567" }, "http://[::1]:4567"],
      ["forwarded host ignored", PUBLIC, { "x-forwarded-host": "attacker.invalid", forwarded: "host=attacker.invalid;proto=http" }, PUBLIC],
      ["hostname substring is not the production authority", "https://onrender.com.attacker.invalid", {}, "https://onrender.com.attacker.invalid"],
    ] as [string, string, Record<string, string>, string][]) {
      await t.test(name, async () => {
        for (const [chain, token] of [["base", USDC], ["solana", SOL_USDC]]) {
          const args = { token_address: token, chain, simulate_sell: false };
          const requestHeaders = { "content-type": "application/json", ...headers };
          const http = await app.request(`${origin}/v1/scan`, { method: "POST", headers: requestHeaders, body: JSON.stringify(args) });
          const mcp = await app.request(`${origin}/mcp`, { method: "POST", headers: requestHeaders, body: mcpBody(args) });
          assert.equal(http.status, 402);
          assert.equal(mcp.status, 402);
          const httpQuote = decodeHeader(http, "payment-required");
          const mcpQuote = decodeHeader(mcp, "payment-required");
          assert.equal(httpQuote.resource.url, `${expected}/v1/scan`);
          assert.deepEqual(mcpQuote.resource, httpQuote.resource);
          assert.deepEqual(mcpQuote.accepts, httpQuote.accepts);
          assert.equal((await mcp.json() as any).result.structuredContent.resource.url, `${expected}/v1/scan`);
          assert.equal(http.headers.get("payment-response"), null);
          assert.equal(mcp.headers.get("payment-response"), null);
        }
        assert.equal(networkCalls, 0);
      });
    }
    await t.test("malformed/conflicting Host and protocol headers fail before authorization or acquisition", async () => {
      for (const headers of [
        { host: "attacker.invalid" }, { host: "rugshield-402.onrender.com/path" },
        { host: "rugshield-402.onrender.com@attacker.invalid" }, { host: "rugshield-402.onrender.com,attacker.invalid" },
        { host: "" }, { "x-forwarded-proto": "https, http" }, { "x-forwarded-proto": "javascript:" },
        { "x-forwarded-proto": "https://attacker.invalid" },
      ]) {
        for (const path of ["/v1/scan", "/mcp"]) {
          const response = await app.request(`${PUBLIC}${path}`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": "malformed-not-an-authorization", ...headers }, body: path === "/mcp" ? mcpBody({ token_address: USDC }) : JSON.stringify({ token_address: USDC }) });
          assert.equal(response.status, 400);
          assert.deepEqual(await response.json(), { error: "INVALID_REQUEST_ORIGIN", payment_collected: false });
          assert.equal(response.headers.get("payment-response"), null);
        }
      }
      assert.equal(networkCalls, 0);
    });
    await t.test("canonical MCP authorization settles once and recovers identically over MCP and HTTP", async () => {
      // Public, unfunded fixture: no transfer instructions and a synthetic blockhash.
      const { offlineSolanaTransaction } = await import("./offline_fixtures.js");
      const { authenticateSolanaTransaction } = await import("../src/middleware/solana_authorization.js");
      const fixture = offlineSolanaTransaction(77);
      const payer = authenticateSolanaTransaction(fixture.transaction).payer;
      const args = { token_address: SOL_USDC, chain: "solana", simulate_sell: false };
      const unpaid = await app.request(`${PUBLIC}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: mcpBody(args) });
      const quote = decodeHeader(unpaid, "payment-required");
      const authorization = { x402Version: 2, resource: quote.resource, accepted: quote.accepts.find((item: any) => item.network.startsWith("solana:")), payload: { transaction: fixture.transaction } };
      const headers = (resource = quote.resource) => ({ "content-type": "application/json", "payment-signature": Buffer.from(JSON.stringify({ ...authorization, resource })).toString("base64") });
      let verifies = 0, settlements = 0;
      globalThis.fetch = (async (url: any, options: any) => {
        networkCalls++;
        if (String(url).endsWith("/verify") || String(url).endsWith("/settle")) {
          const body = JSON.parse(options.body);
          assert.equal(body.paymentPayload.resource.url, `${PUBLIC}/v1/scan`);
          if (String(url).endsWith("/verify")) { verifies++; return json({ isValid: true, payer }); }
          settlements++;
          return json({ success: true, payer, transaction: "4".repeat(88), network: authorization.accepted.network });
        }
        if (String(url).includes("dexscreener")) return json({ pairs: [] });
        const { method } = JSON.parse(options.body);
        if (method === "getGenesisHash") return json({ result: GENESIS });
        if (method === "getAccountInfo") return json({ result: { context: { slot: 456 }, value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { decimals: 6, supply: "1000", mintAuthority: null, freezeAuthority: null, isInitialized: true } } } } } });
        throw new Error(`Unexpected offline RPC method ${method}`);
      }) as typeof fetch;
      const wrong = await app.request(`${PUBLIC}/mcp`, { method: "POST", headers: headers({ url: "http://localhost:4020/v1/scan" }), body: mcpBody(args) });
      assert.equal(wrong.status, 402);
      assert.equal(verifies, 0);
      assert.equal(settlements, 0);
      const first = await app.request(`${PUBLIC}/mcp`, { method: "POST", headers: headers(), body: mcpBody(args) });
      assert.equal(first.status, 200);
      const result = (await first.json() as any).result.structuredContent;
      const receipt = decodeHeader(first, "payment-response");
      assert.equal(receipt.resource, `${PUBLIC}/v1/scan`);
      assert.equal(settlements, 1);
      const repeat = await app.request(`${PUBLIC}/mcp`, { method: "POST", headers: headers(), body: mcpBody(args) });
      assert.equal(repeat.status, 200);
      assert.deepEqual((await repeat.json() as any).result.structuredContent, result);
      assert.deepEqual(decodeHeader(repeat, "payment-response"), receipt);
      const httpRecovery = await app.request(`${PUBLIC}/v1/scan`, { method: "POST", headers: headers(), body: JSON.stringify(args) });
      assert.equal(httpRecovery.status, 200);
      assert.deepEqual(await httpRecovery.json(), result);
      assert.deepEqual(decodeHeader(httpRecovery, "payment-response"), receipt);
      assert.equal(verifies, 1);
      assert.equal(settlements, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    const cleanupPath = resolve(directory);
    assert.ok(cleanupPath.startsWith(resolve(tmpdir()) + sep) && basename(cleanupPath).startsWith("rug-origin-"));
    rmSync(cleanupPath, { recursive: true, force: true });
  }
});
