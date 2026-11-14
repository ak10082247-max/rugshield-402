import test from "node:test";
import assert from "node:assert/strict";
import { executeRugShieldScan, rugshieldActionProvider } from "../dist/index.js";

const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const BASE_TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function buildPaymentRequiredHeader(url) {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      error: "Payment Required",
      resource: { url, description: "RugShield", mimeType: "application/json" },
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
    "utf8"
  ).toString("base64");
}

test("rugshieldActionProvider supports Base and Solana and preserves null when honeypot status is unknown", async () => {
  const prevKey = process.env.X402_PRIVATE_KEY;
  delete process.env.X402_PRIVATE_KEY;
  const seenUrls = [];
  try {
    const provider = rugshieldActionProvider({
      customFetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        seenUrls.push(url);
        return new Response(
          JSON.stringify({
            symbol: "TEST",
            name: "Test Token",
            risk_score: 40,
            recommendation: "CAUTION",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });
    assert.equal(provider.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet" }), true);
    assert.equal(provider.supportsNetwork({ protocolFamily: "svm", networkId: "solana-mainnet" }), true);

    const out = await executeRugShieldScan(
      { tokenAddress: BASE_TOKEN, swapAmountUsdc: "10" },
      {
        customFetch: async (input) => {
          const url = input instanceof Request ? input.url : String(input);
          seenUrls.push(url);
          return new Response(
            JSON.stringify({ symbol: "TEST", risk_score: 40, recommendation: "CAUTION" }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        },
      }
    );
    assert.equal(seenUrls.length, 1);
    assert.match(seenUrls[0], /\/v1\/scan\/preview$/);
    assert.equal(out.paymentMode, "free_preview");
    assert.equal(out.isHoneypot, null);
  } finally {
    if (prevKey !== undefined) process.env.X402_PRIVATE_KEY = prevKey;
  }
});

test("executeRugShieldScan signs live /v1/scan when privateKey is set", async () => {
  const seenSigUrls = [];
  const out = await executeRugShieldScan(
    {
      tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      chain: "solana",
      swapAmountUsdc: "25",
    },
    {
      privateKey: TEST_PRIVATE_KEY,
      customFetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const sig =
          (input instanceof Request ? input.headers.get("payment-signature") : null) ??
          (init?.headers instanceof Headers ? init.headers.get("payment-signature") : null);
        if (!sig) {
          return new Response(JSON.stringify({ error: "Payment Required" }), {
            status: 402,
            headers: {
              "content-type": "application/json",
              "payment-required": buildPaymentRequiredHeader(url),
            },
          });
        }
        seenSigUrls.push(url);
        return new Response(
          JSON.stringify({
            symbol: "BONK",
            is_honeypot: false,
            buy_tax_bps: 0,
            sell_tax_bps: 0,
            risk_score: 5,
            recommendation: "SAFE",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    }
  );
  assert.equal(seenSigUrls.length, 1);
  assert.match(seenSigUrls[0], /\/v1\/scan$/);
  assert.equal(out.chain, "solana");
  assert.equal(out.paymentMode, "x402_paid");
  assert.equal(out.isHoneypot, false);
});
