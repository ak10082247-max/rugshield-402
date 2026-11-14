import test from "node:test";
import assert from "node:assert/strict";
import { preSwapRiskCheckAction } from "../dist/index.js";

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

test("preSwapRiskCheckAction falls back to free preview and marks unknown honeypot safely", async () => {
  const prevKey = process.env.X402_PRIVATE_KEY;
  delete process.env.X402_PRIVATE_KEY;
  const seenUrls = [];
  let callbackPayload;
  try {
    const ok = await preSwapRiskCheckAction.validate(
      { getSetting: () => undefined },
      { content: { text: `Check safety of ${BASE_TOKEN} before swap` } }
    );
    assert.equal(ok, true);

    const res = await preSwapRiskCheckAction.handler(
      { getSetting: () => undefined },
      { content: { text: `Scan ${BASE_TOKEN}` } },
      undefined,
      {
        customFetch: async (input) => {
          seenUrls.push(input instanceof Request ? input.url : String(input));
          return new Response(
            JSON.stringify({
              symbol: "USDC",
              risk_score: 20,
              recommendation: "CAUTION",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        },
      },
      (msg) => {
        callbackPayload = msg;
      }
    );
    assert.equal(seenUrls.length, 1);
    assert.match(seenUrls[0], /\/v1\/scan\/preview$/);
    assert.ok(callbackPayload?.text?.includes("UNVERIFIED"));
    assert.equal(res, false);
  } finally {
    if (prevKey !== undefined) process.env.X402_PRIVATE_KEY = prevKey;
  }
});

test("preSwapRiskCheckAction signs /v1/scan via @x402/fetch when runtime provides X402_PRIVATE_KEY", async () => {
  const seenSigUrls = [];
  let callbackPayload;
  const runtime = {
    getSetting: (key) => (key === "X402_PRIVATE_KEY" ? TEST_PRIVATE_KEY : undefined),
  };

  const res = await preSwapRiskCheckAction.handler(
    runtime,
    { content: { text: "Check DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" } },
    undefined,
    {
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
            recommendation: "SAFE_TO_SWAP",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    },
    (msg) => {
      callbackPayload = msg;
    }
  );
  assert.equal(seenSigUrls.length, 1);
  assert.match(seenSigUrls[0], /\/v1\/scan$/);
  assert.ok(callbackPayload?.text?.includes("Honeypot: NO"));
  assert.equal(res, true);
});
