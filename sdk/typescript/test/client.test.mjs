import assert from "node:assert/strict";
import { test } from "node:test";
import { RugShieldClient } from "../dist/index.js";

const VALID_TEST_KEY = "0x1111111111111111111111111111111111111111111111111111111111111111";

test("isSafeToSwap routes unconfigured clients through /v1/scan/preview and stays fail-closed false", async () => {
  const seen = [];
  const mockFetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    return new Response(
      JSON.stringify({
        status: "warning",
        token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        is_honeypot: null,
        buy_tax_bps: null,
        sell_tax_bps: null,
        simulation_status: "unsimulated_preview",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new RugShieldClient({ customFetch: mockFetch });
  const safe = await client.isSafeToSwap("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(safe, false);
  assert.equal(seen[0], "https://rugshield-402.onrender.com/v1/scan/preview");
});

test("isSafeToSwap invokes paid x402 /v1/scan handshake when privateKey is configured", async () => {
  const seen = [];
  let calls = 0;
  const mockFetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    calls++;
    if (calls === 1) {
      const challenge = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          resource: { url: "https://rugshield-402.onrender.com/v1/scan", description: "RugShield", mimeType: "application/json" },
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              amount: "10000",
              asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              payTo: "0x80E0Ae84679b7f11bE171DaADd492FBECf628cd6",
              maxTimeoutSeconds: 300,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        }),
      ).toString("base64");
      return new Response(JSON.stringify({ error: "Payment Required" }), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": challenge, "content-type": "application/json" },
      });
    }
    const headers = input instanceof Request ? input.headers : new Headers();
    assert.ok(headers.get("PAYMENT-SIGNATURE") || headers.get("X-PAYMENT"));
    return new Response(
      JSON.stringify({
        status: "success",
        token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        is_honeypot: false,
        buy_tax_bps: 0,
        sell_tax_bps: 50,
        simulation_status: "passed",
      }),
      { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": "ok" } },
    );
  };

  const client = new RugShieldClient({ privateKey: VALID_TEST_KEY, customFetch: mockFetch });
  const safe = await client.isSafeToSwap("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(safe, true);
  assert.equal(seen[0], "https://rugshield-402.onrender.com/v1/scan");
  assert.equal(seen.length, 2);
});
