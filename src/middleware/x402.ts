import { createMiddleware } from "hono/factory";
import { LRUCache } from "lru-cache";
import { createHash, randomUUID } from "node:crypto";
import { verifyTypedData, getAddress, isAddress } from "viem";
import { CONFIG } from "../config.js";

// Replay protection cache: max 100,000 items, TTL 24 hours (86,400,000 ms)
const replayCache = new LRUCache<string, boolean>({
  max: 100_000,
  ttl: 86_400_000,
});

export interface X402VerificationResult {
  payer: `0x${string}`;
  amount: bigint;
  signatureHash: string;
}

// Metrics tracking for agent lifecycle and conversion observability
export const X402_METRICS = {
  challenges: 0,
  settlements: 0,
  replaysPrevented: 0,
};

export const x402Middleware = createMiddleware<{
  Variables: {
    payment?: X402VerificationResult;
  };
}>(async (c, next) => {
  // 1. Universal CORS and transport headers
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-PAYMENT, PAYMENT-SIGNATURE, X-402-Version, PAYMENT-REQUIRED, X-Payment-Required, X-402-Payment-Required"
  );
  c.header(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, X-PAYMENT, PAYMENT-SIGNATURE, X-402-Version, PAYMENT-REQUIRED, X-Payment-Required, X-402-Payment-Required, PAYMENT-RESPONSE, Payment-Receipt, Location, Retry-After"
  );
  c.header("X-402-Version", "2");

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  // Only protect /v1/scan
  const path = c.req.path;
  if (!path.startsWith("/v1/scan")) {
    return next();
  }

  // Check incoming payment headers
  const rawPaymentHeader =
    c.req.header("X-PAYMENT") ||
    c.req.header("PAYMENT-SIGNATURE") ||
    c.req.header("x-payment") ||
    c.req.header("payment-signature");

  if (!rawPaymentHeader) {
    return return402Challenge(c);
  }

  try {
    let payloadStr = rawPaymentHeader.trim();
    // Decode base64 if not starting with {
    if (!payloadStr.startsWith("{")) {
      try {
        payloadStr = Buffer.from(payloadStr, "base64").toString("utf-8");
      } catch {
        // keep as is
      }
    }

    const parsed = JSON.parse(payloadStr);

    // Parse authorization data
    const auth =
      parsed.payload?.authorization ||
      parsed.authorization ||
      parsed.message ||
      parsed;

    const signature = (
      parsed.payload?.signature ||
      parsed.signature ||
      ""
    ) as `0x${string}`;

    if (!auth || !signature) {
      return return402Challenge(c, "Missing authorization or signature payload");
    }

    const from = (auth.from || auth.payer || auth.agentAddress) as `0x${string}`;
    const to = (auth.to || auth.payTo || auth.recipient) as `0x${string}`;
    const value = BigInt(auth.value ?? auth.amount ?? auth.amountUsdc ?? 0);
    const validBefore = BigInt(auth.validBefore ?? auth.deadline ?? Math.floor(Date.now() / 1000) + 3600);
    const validAfter = BigInt(auth.validAfter ?? 0);
    const nonce = (auth.nonce ?? "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;

    // Verify recipient matches Wallet A
    if (!isAddress(to) || getAddress(to) !== getAddress(CONFIG.merchantAddress)) {
      return return402Challenge(c, `Invalid recipient: must pay ${CONFIG.merchantAddress}`);
    }

    // Verify amount is at least 5000 micro-units
    if (value < BigInt(CONFIG.amountMicroUnits)) {
      return return402Challenge(
        c,
        `Insufficient payment: requires ${CONFIG.amountMicroUnits} micro-units USDC`
      );
    }

    // Verify validity window
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (validBefore < nowSec - 60n) {
      return return402Challenge(c, "Payment authorization expired");
    }
    if (validAfter > nowSec + 300n) {
      return return402Challenge(c, "Payment authorization not yet valid");
    }

    // Replay protection via signature hash
    const sigHash = createHash("sha256").update(signature).digest("hex");
    if (replayCache.has(sigHash)) {
      X402_METRICS.replaysPrevented++;
      return c.json(
        {
          error: "replay_detected",
          message: "Payment authorization already consumed. Nonce replay prevented.",
        },
        409
      );
    }

    // Verify EIP-712 signature against Base USDC
    const domain = {
      name: "USD Coin",
      version: "2",
      chainId: CONFIG.chainId,
      verifyingContract: CONFIG.usdcAddress,
    };

    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };

    const message = {
      from: getAddress(from),
      to: getAddress(to),
      value,
      validAfter,
      validBefore,
      nonce: nonce.startsWith("0x") && nonce.length === 66 ? nonce : (`0x${nonce.replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`),
    };

    // Try verifying TransferWithAuthorization
    let isValid = false;
    try {
      isValid = await verifyTypedData({
        address: getAddress(from),
        domain,
        types,
        primaryType: "TransferWithAuthorization",
        message,
        signature,
      });
    } catch {
      // Also try ReceiveWithAuthorization if client used that
      try {
        const receiveTypes = {
          ReceiveWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        };
        isValid = await verifyTypedData({
          address: getAddress(from),
          domain,
          types: receiveTypes,
          primaryType: "ReceiveWithAuthorization",
          message,
          signature,
        });
      } catch {
        isValid = false;
      }
    }

    if (!isValid) {
      return return402Challenge(c, "Invalid EIP-712 cryptographic signature");
    }

    // Mark as consumed in replay cache
    replayCache.set(sigHash, true);
    X402_METRICS.settlements++;

    c.set("payment", {
      payer: getAddress(from),
      amount: value,
      signatureHash: sigHash,
    });

    return next();
  } catch (err: any) {
    return return402Challenge(c, `Malformed payment payload: ${err.message}`);
  }
});

function return402Challenge(c: any, reason?: string) {
  X402_METRICS.challenges++;
  const host = c.req.header("host") || `localhost:${CONFIG.port}`;
  const proto = c.req.header("x-forwarded-proto") || (host.includes("onrender.com") ? "https" : "http");
  const baseUrl = host.includes("onrender.com") ? "https://rugshield-402.onrender.com" : `${proto}://${host}`;
  const resUrl = `${baseUrl}/v1/scan`;
  const desc = "Low-latency token honeypot detection, tax simulation, and pool liquidity verification for AI agents.";

  const challengeId = randomUUID();
  const reqPayload = {
    amount: CONFIG.amountMicroUnits,
    chainId: CONFIG.chainId,
    currency: CONFIG.usdcAddress,
    decimals: 6,
    recipient: CONFIG.merchantAddress,
  };
  const reqB64 = Buffer.from(JSON.stringify(reqPayload)).toString("base64url");
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  c.header(
    "WWW-Authenticate",
    `Payment id="${challengeId}", realm="rugshield-402.onrender.com", method="evm", intent="charge", request="${reqB64}", expires="${expires}"`
  );
  c.header("X-402-Version", "2");

  const resourceObj = {
    url: resUrl,
    description: desc,
    mimeType: "application/json",
  };

  // Construct standard Base x402 PAYMENT-REQUIRED header for standard x402 clients
  const x402Pr = {
    x402Version: 2,
    resource: resourceObj,
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${CONFIG.chainId}`,
        asset: CONFIG.usdcAddress,
        amount: CONFIG.amountMicroUnits,
        price: CONFIG.unitPriceUsd,
        maxTimeoutSeconds: 3600,
        payTo: CONFIG.merchantAddress,
        instructions: "Pay using EIP-712/EIP-3009 transfer authorization",
        extra: { name: "USD Coin", version: "2" },
        description: desc,
        mimeType: "application/json",
        bazaar: {
          name: "RugShield 402",
          description: desc,
        },
      },
    ],
  };

  const invoiceBase64 = Buffer.from(JSON.stringify(x402Pr)).toString("base64");
  c.header("PAYMENT-REQUIRED", invoiceBase64);
  c.header("X-Payment-Required", invoiceBase64);
  c.header("X-402-Payment-Required", invoiceBase64);

  return c.json(
    {
      error: "payment_required",
      x402Version: 2,
      x402_version: "2",
      resource: resourceObj,
      accepts: x402Pr.accepts,
      payTo: CONFIG.merchantAddress,
      amount: CONFIG.amountMicroUnits,
      asset: CONFIG.usdcAddress,
      network: CONFIG.network,
      chainId: CONFIG.chainId,
      facilitator: CONFIG.facilitator,
      unit_price_usd: CONFIG.unitPriceUsd,
      ...(reason ? { details: reason } : {}),
    },
    402
  );
}
