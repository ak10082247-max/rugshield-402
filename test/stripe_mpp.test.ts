import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_STRIPE_PROFILE_ID,
  buildStripeChargeChallengeSync,
  computeChallengeIdSync,
  encodeCanonicalRequest,
} from "../src/middleware/stripe_mpp.js";

const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MINT = {
  owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  data: {
    parsed: {
      type: "mint",
      info: { decimals: 6, supply: "100000000", mintAuthority: null, freezeAuthority: null, isInitialized: true },
    },
  },
};

test("RugShield emits valid Stripe MPP challenges, enforces acquisition-before-settlement, settles via Option A relay, and issues unified Bearer key", async () => {
  const TEST_SECRET = "rugshield_stripe_mpp_test_secret_32b";
  const dir = mkdtempSync(join(tmpdir(), "rug-stripe-mpp-"));
  const prevSecret = process.env.KUROX_SIGNING_SECRET;
  const origFetch = globalThis.fetch;

  process.env.RUGSHIELD_NO_LISTEN = "1";
  process.env.RUGSHIELD_DISABLE_DELIVERY_LOGGING = "1";
  process.env.X402_FULFILLMENT_DIR = dir;
  process.env.X402_FREE_TRIAL_ENABLED = "0";
  process.env.DOTENV_CONFIG_PATH = join(dir, "empty.env");
  writeFileSync(process.env.DOTENV_CONFIG_PATH, "");
  process.env.KUROX_SIGNING_SECRET = TEST_SECRET;

  const relayCalls: Array<{ url: string; headers: any; body: string }> = [];

  globalThis.fetch = (async (url: any, options: any = {}) => {
    const u = String(url);
    if (u.endsWith("/internal/mpp/stripe/verify")) {
      relayCalls.push({ url: u, headers: options.headers || {}, body: String(options.body || "") });
      const nowSec = Math.floor(Date.now() / 1000);
      const payloadObj = {
        typ: "api_key",
        sid: "pi_rs_mpp_01",
        sku: "kurox-mpp-pass-7d",
        tier: "mpp_pass",
        iat: nowSec,
        exp: nowSec + 7 * 86400,
      };
      const b64Body = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
      const sig = createHmac("sha256", TEST_SECRET).update(`sk_kurox_v1.${b64Body}`).digest("base64url");
      const apiKey = `sk_kurox_v1.${b64Body}.${sig}`;
      const receipt = { method: "stripe", status: "success", timestamp: new Date().toISOString(), reference: "pi_rs_mpp_01" };
      return new Response(
        JSON.stringify({
          ok: true,
          paymentIntentId: "pi_rs_mpp_01",
          amountCents: 50,
          currency: "USD",
          sku: "kurox-mpp-pass-7d",
          tier: "mpp_pass",
          receipt,
          receiptHeader: Buffer.from(JSON.stringify(receipt)).toString("base64url"),
          apiKey,
          apiKeyExpiresAt: new Date((nowSec + 7 * 86400) * 1000).toISOString(),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("dexscreener")) {
      return new Response(JSON.stringify({ pairs: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const rpcBody = JSON.parse(String(options.body || "{}"));
    const jsonRpc = (resObj: any) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: rpcBody.id || 1, result: resObj }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (rpcBody.method === "getGenesisHash") return jsonRpc(GENESIS);
    if (rpcBody.method === "getAccountInfo") return jsonRpc({ context: { slot: 789 }, value: MINT });
    if (rpcBody.method === "getTokenSupply") return jsonRpc({ context: { slot: 789 }, value: { amount: "1000" } });
    if (rpcBody.method === "getBalance") return jsonRpc({ context: { slot: 789 }, value: 100 });
    return jsonRpc({ context: { slot: 789 }, value: [] });
  }) as typeof fetch;

  try {
    const { default: app } = await import("../src/index.js");

    // 1. Unpaid request emits valid mppx WWW-Authenticate: Payment ..., method="stripe" + PAYMENT-REQUIRED
    const unpaid = await app.request("https://rugshield-402.onrender.com/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: SOL_USDC, chain: "solana", simulate_sell: false }),
    });
    assert.equal(unpaid.status, 402);
    const wwwAuth = unpaid.headers.get("www-authenticate") || "";
    assert.ok(wwwAuth.startsWith("Payment "));
    assert.match(wwwAuth, /method="stripe"/);
    assert.match(wwwAuth, /intent="charge"/);
    assert.match(wwwAuth, /realm="rugshield-402\.onrender\.com"/);
    assert.ok(unpaid.headers.get("payment-required"));

    const idMatch = /id="([^"]+)"/.exec(wwwAuth)!;
    const reqMatch = /request="([^"]+)"/.exec(wwwAuth)!;
    const expMatch = /expires="([^"]+)"/.exec(wwwAuth)!;
    assert.ok(idMatch && reqMatch && expMatch);

    const decodedReq = JSON.parse(Buffer.from(reqMatch[1], "base64url").toString("utf8"));
    assert.equal(decodedReq.amount, "50");
    assert.equal(decodedReq.currency, "usd");
    assert.equal(decodedReq.methodDetails.networkId, DEFAULT_STRIPE_PROFILE_ID);

    const verifiedId = computeChallengeIdSync(
      { realm: "rugshield-402.onrender.com", method: "stripe", intent: "charge", request: reqMatch[1], expires: expMatch[1] },
      TEST_SECRET,
    );
    assert.equal(idMatch[1], verifiedId);

    // 2. Malformed Payment credential returns 402 with fresh WWW-Authenticate
    const badCred = await app.request("https://rugshield-402.onrender.com/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Payment dGhpcyBpcyBnYXJiYWdl" },
      body: JSON.stringify({ token_address: SOL_USDC, chain: "solana", simulate_sell: false }),
    });
    assert.equal(badCred.status, 402);
    assert.ok((badCred.headers.get("www-authenticate") || "").startsWith("Payment "));
    assert.equal(relayCalls.length, 0);

    const mkCred = (challengeObj: any, rawReqB64: string, spt = "spt_rs_test_01") =>
      `Payment ${Buffer.from(
        JSON.stringify({
          challenge: {
            id: challengeObj.id,
            realm: challengeObj.realm,
            method: "stripe",
            intent: "charge",
            expires: challengeObj.expires,
            request: rawReqB64,
          },
          payload: { spt },
        }),
      ).toString("base64url")}`;

    // 3. Invalid scan input (400) rejects BEFORE charging Stripe!
    const badInput = await app.request("https://rugshield-402.onrender.com/v1/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: mkCred({ id: idMatch[1], realm: "rugshield-402.onrender.com", expires: expMatch[1] }, reqMatch[1], "spt_never_charge"),
      },
      body: JSON.stringify({ token_address: "invalid_addr" }),
    });
    assert.equal(badInput.status, 400);
    assert.equal(relayCalls.length, 0);

    // 4. Paid Stripe MPP scan settles via relay, returns Payment-Receipt & mints reusable sk_kurox_v1 key
    const paidRes = await app.request("https://rugshield-402.onrender.com/v1/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: mkCred({ id: idMatch[1], realm: "rugshield-402.onrender.com", expires: expMatch[1] }, reqMatch[1], "spt_rs_live_ok"),
      },
      body: JSON.stringify({ token_address: SOL_USDC, chain: "solana", simulate_sell: false }),
    });
    assert.equal(paidRes.status, 200);
    assert.equal(relayCalls.length, 1);
    assert.equal(relayCalls[0].headers["X-Kurox-Internal-Service"], "rugshield-402");
    const receiptHdr = paidRes.headers.get("payment-receipt");
    assert.ok(receiptHdr);
    const receipt = JSON.parse(Buffer.from(receiptHdr, "base64url").toString("utf8"));
    assert.equal(receipt.method, "stripe");
    assert.equal(receipt.reference, "pi_rs_mpp_01");
    const issuedKey = paidRes.headers.get("x-kurox-api-key");
    assert.ok(issuedKey && issuedKey.startsWith("sk_kurox_v1."));
    const paidJson = (await paidRes.json()) as any;
    assert.equal(paidJson.evidence?.mint?.slot, 789);

    // 5. MCP /mcp tools/call with _meta['org.paymentauth/credential'] works too
    const mcpCh = buildStripeChargeChallengeSync({
      realm: "rugshield-402.onrender.com",
      amountCents: 50,
      description: "RugShield MCP",
      secretKey: TEST_SECRET,
    });
    const mcpRes = await app.request("https://rugshield-402.onrender.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "rugshield_pre_swap_scan",
          arguments: { token_address: SOL_USDC, chain: "solana", simulate_sell: false },
          _meta: {
            "org.paymentauth/credential": {
              challenge: { ...mcpCh.challenge, request: encodeCanonicalRequest(mcpCh.challenge.request) },
              payload: { spt: "spt_rs_mcp_01" },
            },
          },
        },
      }),
    });
    assert.equal(mcpRes.status, 200);
    assert.equal(relayCalls.length, 2);
    assert.ok(mcpRes.headers.get("payment-receipt"));
    assert.ok((mcpRes.headers.get("x-kurox-api-key") || "").startsWith("sk_kurox_v1."));
  } finally {
    globalThis.fetch = origFetch;
    if (prevSecret === undefined) delete process.env.KUROX_SIGNING_SECRET;
    else process.env.KUROX_SIGNING_SECRET = prevSecret;
    rmSync(dir, { recursive: true, force: true });
  }
});
