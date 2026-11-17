import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function signTestToken(payload: Record<string, unknown>, secret: string, prefix = "sk_kurox_v1") {
  const b64Body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signedData = `${prefix}.${b64Body}`;
  const sig = createHmac("sha256", secret).update(signedData).digest("base64url");
  return `${signedData}.${sig}`;
}

test("RugShield accepts valid Stripe-minted Bearer sk_kurox_v1 keys on HTTP & MCP and fails closed on invalid/expired keys", async () => {
  const TEST_SECRET = "rugshield_test_signing_secret_32_bytes_ok";
  const dir = mkdtempSync(join(tmpdir(), "rug-kurox-auth-"));
  const prevSecret = process.env.KUROX_SIGNING_SECRET;
  process.env.RUGSHIELD_NO_LISTEN = "1";
  process.env.RUGSHIELD_DISABLE_DELIVERY_LOGGING = "1";
  process.env.X402_FULFILLMENT_DIR = dir;
  process.env.X402_FREE_TRIAL_ENABLED = "0";
  process.env.DOTENV_CONFIG_PATH = join(dir, "empty.env");
  writeFileSync(process.env.DOTENV_CONFIG_PATH, "");
  process.env.KUROX_SIGNING_SECRET = TEST_SECRET;

  try {
    const { default: app } = await import("../src/index.js");
    const now = Math.floor(Date.now() / 1000);
    const validKey = signTestToken(
      { typ: "api_key", sid: "cs_test_rs", sku: "kurox-api-starter-30d", tier: "starter", iat: now, exp: now + 3600 },
      TEST_SECRET,
    );
    const expiredKey = signTestToken(
      { typ: "api_key", sid: "cs_test_exp", sku: "kurox-api-starter-30d", tier: "starter", iat: 10, exp: 20 },
      TEST_SECRET,
    );

    // 1. Unauthenticated challenges 402
    const unpaid = await app.request("https://rugshield-402.onrender.com/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: "invalid_addr" }),
    });
    assert.equal(unpaid.status, 402);

    // 2. Valid Bearer key bypasses x402Middleware into handler (returns 400 validation error + X-Kurox-Auth header without RPC)
    const validHttp = await app.request("https://rugshield-402.onrender.com/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validKey}` },
      body: JSON.stringify({ token_address: "invalid_addr" }),
    });
    assert.equal(validHttp.status, 400);
    assert.equal(validHttp.headers.get("x-kurox-auth"), "bearer-api-key");
    assert.equal(validHttp.headers.get("x-kurox-tier"), "starter");

    // 3. Valid Bearer key forwarded cleanly through /mcp tools/call
    const validMcp = await app.request("https://rugshield-402.onrender.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": validKey },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "rugshield_pre_swap_scan", arguments: { token_address: "invalid_addr" } },
      }),
    });
    assert.equal(validMcp.status, 400);
    assert.equal(validMcp.headers.get("x-kurox-auth"), "bearer-api-key");

    // 4. Tampered / expired keys fail closed 401; unset secret fails closed 503
    const tampered = await app.request("https://rugshield-402.onrender.com/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validKey}bad` },
      body: JSON.stringify({ token_address: "invalid_addr" }),
    });
    assert.equal(tampered.status, 401);

    const expired = await app.request("https://rugshield-402.onrender.com/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${expiredKey}` },
      body: JSON.stringify({ token_address: "invalid_addr" }),
    });
    assert.equal(expired.status, 401);

    delete process.env.KUROX_SIGNING_SECRET;
    const missingSecret = await app.request("https://rugshield-402.onrender.com/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${validKey}` },
      body: JSON.stringify({ token_address: "invalid_addr" }),
    });
    assert.equal(missingSecret.status, 503);
  } finally {
    if (prevSecret === undefined) delete process.env.KUROX_SIGNING_SECRET;
    else process.env.KUROX_SIGNING_SECRET = prevSecret;
    rmSync(dir, { recursive: true, force: true });
  }
});
