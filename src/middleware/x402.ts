import { createMiddleware } from "hono/factory";
import { LRUCache } from "lru-cache";
import { createHash, randomUUID } from "node:crypto";
import { verifyTypedData, getAddress, isAddress } from "viem";
import { CONFIG, ENDPOINT_MAP, ENDPOINT_SPECS, type EndpointPriceSpec } from "../config.js";

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

  // Check if this route is one of our paid endpoints
  const path = c.req.path;
  const spec = ENDPOINT_MAP.get(path);
  if (!spec) {
    return next();
  }

  // Check incoming payment headers
  const rawPaymentHeader =
    c.req.header("X-PAYMENT") ||
    c.req.header("PAYMENT-SIGNATURE") ||
    c.req.header("x-payment") ||
    c.req.header("payment-signature");

  if (!rawPaymentHeader) {
    return return402Challenge(c, spec);
  }

  try {
    let payloadStr = rawPaymentHeader.trim();
    if (!payloadStr.startsWith("{")) {
      try {
        payloadStr = Buffer.from(payloadStr, "base64").toString("utf-8");
      } catch {
        // keep as is
      }
    }

    const parsed = JSON.parse(payloadStr);

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
      return return402Challenge(c, spec, "Missing authorization or signature payload");
    }

    const from = (auth.from || auth.payer || auth.agentAddress) as `0x${string}`;
    const to = (auth.to || auth.payTo || auth.recipient) as `0x${string}`;
    const value = BigInt(auth.value ?? auth.amount ?? auth.amountUsdc ?? 0);
    const validBefore = BigInt(auth.validBefore ?? auth.deadline ?? Math.floor(Date.now() / 1000) + 3600);
    const validAfter = BigInt(auth.validAfter ?? 0);
    const nonce = (auth.nonce ?? "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;

    // Verify recipient matches Merchant Payout Wallet
    if (!isAddress(to) || getAddress(to) !== getAddress(CONFIG.merchantAddress)) {
      return return402Challenge(c, spec, `Invalid recipient: must pay ${CONFIG.merchantAddress}`);
    }

    // Verify amount is at least route required micro-units
    const requiredUnits = BigInt(spec.amountMicroUnits);
    if (value < requiredUnits) {
      return return402Challenge(
        c,
        spec,
        `Insufficient payment: requires ${spec.amountMicroUnits} micro-units USDC, received ${value}`
      );
    }

    // Verify validity window
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (validBefore < nowSec - 60n) {
      return return402Challenge(c, spec, "Payment authorization expired");
    }
    if (validAfter > nowSec + 300n) {
      return return402Challenge(c, spec, "Payment authorization not yet valid");
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

    const formattedNonce = nonce.startsWith("0x") && nonce.length === 66 ? nonce : (`0x${nonce.replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`);

    const message = {
      from: getAddress(from),
      to: getAddress(to),
      value,
      validAfter,
      validBefore,
      nonce: formattedNonce,
    };

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
      return return402Challenge(c, spec, "Invalid EIP-712 cryptographic signature");
    }

    // Production on-chain settlement via CanaryGuard CDP Facilitator Relay
    const host = c.req.header("host") || `localhost:${CONFIG.port}`;
    const proto = c.req.header("x-forwarded-proto") || (host.includes("onrender.com") ? "https" : "http");
    const baseUrl = host.includes("onrender.com") ? "https://rugshield-402.onrender.com" : `${proto}://${host}`;
    const resUrl = `${baseUrl}${spec.path}`;

    const cleanRequirements = {
      scheme: "exact",
      network: `eip155:${CONFIG.chainId}`,
      amount: spec.amountMicroUnits,
      asset: CONFIG.usdcAddress,
      payTo: CONFIG.merchantAddress,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    };

    const resourceObj = {
      url: resUrl,
      description: spec.description,
      mimeType: "application/json",
    };

    const relayBody = {
      paymentPayload: {
        x402Version: 2,
        resource: resourceObj,
        extensions: parsed.extensions || {
          bazaar: buildBazaarExtension(spec),
        },
        accepted: cleanRequirements,
        payload: {
          signature,
          authorization: {
            from: getAddress(from),
            to: getAddress(to),
            value: value.toString(),
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
            nonce: formattedNonce,
          },
        },
      },
      paymentRequirements: cleanRequirements,
    };

    let settleData: any = null;
    try {
      const relayRes = await fetch("https://canaryguard-402.onrender.com/v1/internal/cdp-settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(relayBody),
        signal: AbortSignal.timeout(35000),
      });
      settleData = await relayRes.json().catch(() => ({}));
      if (!relayRes.ok || !settleData.success) {
        const errMsg = settleData.error || settleData.errorReason || `Relay HTTP ${relayRes.status}`;
        console.warn(`[rugshield-402] On-chain settlement rejected: ${errMsg}`);
        return return402Challenge(c, spec, `On-chain settlement rejected: ${errMsg}`);
      }
    } catch (relayErr: any) {
      console.error(`[rugshield-402] CDP relay exception: ${relayErr.message}`);
      return return402Challenge(c, spec, `CDP relay exception: ${relayErr.message}`);
    }

    // Mark as consumed in replay cache
    replayCache.set(sigHash, true);
    X402_METRICS.settlements++;

    const txHash = settleData.transaction || `0x${sigHash}`;
    const paymentInfo = {
      success: true,
      payer: settleData.payer || getAddress(from),
      transaction: txHash,
      amount: value.toString(),
      network: settleData.network || `eip155:${CONFIG.chainId}`,
      resource: resUrl,
    };

    c.header("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(paymentInfo)).toString("base64"));
    c.set("payment", {
      payer: getAddress(from),
      amount: value,
      signatureHash: sigHash,
    });

    return next();
  } catch (err: any) {
    return return402Challenge(c, spec, `Malformed payment payload: ${err.message}`);
  }
});

function buildBazaarExtension(spec: EndpointPriceSpec) {
  return {
    info: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        body: spec.exampleInput,
      },
      output: {
        type: "json",
        example: spec.outputExample,
      },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["POST", "GET"] },
            bodyType: { type: "string", enum: ["json"] },
            body: { type: "object", properties: {} },
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: {
              type: "object",
              properties: {
                status: { type: "string" },
              },
              required: ["status"],
              additionalProperties: true,
            },
          },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  };
}

function return402Challenge(c: any, spec: EndpointPriceSpec, reason?: string) {
  X402_METRICS.challenges++;
  const host = c.req.header("host") || `localhost:${CONFIG.port}`;
  const proto = c.req.header("x-forwarded-proto") || (host.includes("onrender.com") ? "https" : "http");
  const baseUrl = host.includes("onrender.com") ? "https://rugshield-402.onrender.com" : `${proto}://${host}`;
  const resUrl = `${baseUrl}${spec.path}`;

  const challengeId = randomUUID();
  const reqPayload = {
    amount: spec.amountMicroUnits,
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
    description: spec.description,
    mimeType: "application/json",
  };

  const bazaarExtension = buildBazaarExtension(spec);

  const x402Pr = {
    x402Version: 2,
    resource: resourceObj,
    extensions: { bazaar: bazaarExtension },
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${CONFIG.chainId}`,
        asset: CONFIG.usdcAddress,
        amount: spec.amountMicroUnits,
        maxTimeoutSeconds: 300,
        payTo: CONFIG.merchantAddress,
        extra: { name: "USD Coin", version: "2" },
      },
    ],
  };

  const invoiceBase64 = Buffer.from(JSON.stringify(x402Pr)).toString("base64");
  c.header("PAYMENT-REQUIRED", invoiceBase64);
  c.header("X-Payment-Required", invoiceBase64);
  c.header("X-402-Payment-Required", invoiceBase64);
  c.header("X-402-Amount", spec.priceUsd);
  c.header("X-402-Amount-Units", spec.amountMicroUnits);
  c.header("X-402-Payment-To", CONFIG.merchantAddress);
  c.header("X-402-Asset", CONFIG.usdcAddress);
  c.header("X-402-Network", "base");
  c.header("X-402-Chain-Id", CONFIG.chainId.toString());

  return c.json(
    {
      error: "payment_required",
      x402Version: 2,
      x402_version: "2",
      resource: resourceObj,
      extensions: { bazaar: bazaarExtension },
      accepts: x402Pr.accepts,
      payTo: CONFIG.merchantAddress,
      amount: spec.amountMicroUnits,
      asset: CONFIG.usdcAddress,
      network: `eip155:${CONFIG.chainId}`,
      chainId: CONFIG.chainId,
      price: `${spec.priceUsd} USDC`,
      facilitator: CONFIG.facilitator,
      ...(reason ? { details: reason } : {}),
    },
    402
  );
}
