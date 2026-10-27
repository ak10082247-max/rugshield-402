import { createMiddleware } from "hono/factory";
import { LRUCache } from "lru-cache";
import { createHash, randomUUID } from "node:crypto";
import { verifyTypedData, getAddress, isAddress } from "viem";
import { CONFIG, ENDPOINT_MAP, ENDPOINT_SPECS, type EndpointPriceSpec } from "../config.js";
import { fulfillmentStore, FulfillmentStorageError, paymentId, requestFingerprint, snapshotResponse, restoreResponse } from "./fulfillment.js";
import { authenticateSolanaTransaction } from "./solana_authorization.js";

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
  freemiumConversions: 0,
};

// 1-Call Freemium Hook cache for trading bots (converts scrapers on call #2)
const freeTrialIpMap = new Map<string, number>();

const paymentHandler = createMiddleware<{
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
    const rawIp = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "unknown";
    const clientIp = rawIp.toLowerCase();
    const userAgent = (c.req.header("user-agent") || "").toLowerCase();
    const isProbe = userAgent.includes("probe") || userAgent.includes("crawler") || userAgent.includes("spider") || userAgent.includes("mcp") || userAgent.includes("glama") || userAgent.includes("rokmcp") || userAgent.includes("lumiere") || userAgent.includes("wellknown") || c.req.method === "HEAD";

    // 1-Call Freemium Hook: Provide real alpha on Call #1 to trading bots, convert to paid on Call #2
    if (process.env.X402_FREE_TRIAL_ENABLED === "1" && !isProbe && clientIp !== "unknown" && c.req.method === "POST") {
      const now = Date.now();
      const lastUsed = freeTrialIpMap.get(clientIp);
      if (!lastUsed || (now - lastUsed > 86400000)) {
        freeTrialIpMap.set(clientIp, now);
        X402_METRICS.freemiumConversions++;
        c.header("X-Free-Trial-Remaining", "0");
        c.header("X-Trial-Notice", "1 free daily alpha scan consumed. Subsequent calls require 0.010 USDC via x402.");
        c.header("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, amount: "0", transaction: "freemium-trial-1-of-1", network: `eip155:${CONFIG.chainId}`, resource: spec.path })).toString("base64"));
        return next();
      }
    }

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
    const fingerprint = await requestFingerprint(c);
    const resourceHost = c.req.header("host") || `localhost:${CONFIG.port}`;
    const resourceProto = c.req.header("x-forwarded-proto") || (resourceHost.includes("onrender.com") ? "https" : "http");
    const canonicalResource = `${resourceHost.includes("onrender.com") ? "https://rugshield-402.onrender.com" : `${resourceProto}://${resourceHost}`}${spec.path}`;
    const validateMetadata = (requirements: any) => {
      const accepted = parsed.accepted;
      if (accepted !== undefined) {
        if (!accepted || typeof accepted !== "object" || Array.isArray(accepted)) throw new Error("Invalid accepted payment requirements");
        for (const name of ["scheme", "network", "amount", "asset", "payTo"]) {
          if (accepted[name] !== undefined && accepted[name] !== requirements[name]) throw new Error(`Payment ${name} does not match the requested resource`);
        }
      }
      const resource = typeof parsed.resource === "string" ? parsed.resource : parsed.resource?.url;
      if (resource !== undefined && resource !== canonicalResource) throw new Error("Payment resource URL mismatch");
    };
    const recover = (id: string) => {
      const stored = fulfillmentStore.get(id);
      if (!stored) return null;
      if (stored.fingerprint !== fingerprint) return c.json({ error: "PAYMENT_REQUEST_MISMATCH", message: "This payment is bound to a different request; no new charge attempted." }, 409);
      if (stored.state === "settled") return restoreResponse(stored);
      return c.json({ error: "SETTLEMENT_PENDING_RECONCILIATION", message: "This payment may already have settled. Do not replace it or pay again; the prepared result is retained for reconciliation." }, 503);
    };
    const prepare = async (id: string) => {
      await next();
      if (c.res.status < 200 || c.res.status >= 300) return c.res;
      const snapshot = await snapshotResponse(c.res);
      const body = JSON.parse(snapshot.body);
      if (body.status === "error" || body.error) return c.json({ error: "FULFILLMENT_FAILED", message: "Analysis did not complete; no settlement attempted." }, 503);
      if (body.fulfillment_complete === false) return c.json({ ...body, status: "error", error: "ANALYSIS_INCOMPLETE", payment_collected: false }, 503);
      if (!fulfillmentStore.reserve(id, fingerprint, snapshot)) return recover(id);
      return null;
    };

    // PRE-SETTLEMENT PARAMETER VALIDATION (Prevents charging payment on invalid requests)
    // Body-first extraction to match route handler precedence (prevents valid query bypassing invalid body)
    let hasBodyTarget = false;
    let reqToken: any = null;
    let reqChain: any = null;
    if (c.req.method === "POST" || c.req.method === "PUT") {
      try {
        const clonedBody = await c.req.raw.clone().json().catch(() => null);
        if (clonedBody && typeof clonedBody === "object") {
          for (const k of ["token_address", "address", "token", "target"]) {
            if (k in clonedBody) {
              reqToken = clonedBody[k];
              hasBodyTarget = true;
              break;
            }
          }
          if ("chain" in clonedBody) {
            reqChain = clonedBody.chain;
          } else if ("chain_id" in clonedBody) {
            reqChain = clonedBody.chain_id;
          }
        }
      } catch {}
    }
    if (!hasBodyTarget) {
      for (const k of ["token_address", "address", "token", "target"]) {
        const qVal = c.req.query(k);
        if (qVal !== undefined && qVal !== null) {
          reqToken = qVal;
          break;
        }
      }
    }
    if (!reqChain) {
      reqChain = c.req.query("chain") ?? c.req.query("chain_id");
    }

    if (reqToken === null || reqToken === undefined) {
      return c.json({
        status: "error",
        error: "MISSING_TARGET_ADDRESS",
        message: "Missing required token address parameter in body or query.",
        timestamp: Math.floor(Date.now() / 1000)
      }, 400);
    }

    if (typeof reqToken !== "string") {
      return c.json({
        status: "error",
        error: "INVALID_TOKEN_ADDRESS",
        message: "Token address parameter must be a string.",
        timestamp: Math.floor(Date.now() / 1000)
      }, 400);
    }

    function checkSolanaBase58Mint32(str: string): boolean {
      if (typeof str !== "string" || str.length < 32 || str.length > 44) return false;
      const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let zeros = 0;
      while (zeros < str.length && str[zeros] === "1") zeros++;
      const bytes: number[] = [];
      for (let i = zeros; i < str.length; i++) {
        const idx = ALPHABET.indexOf(str[i]);
        if (idx === -1) return false;
        let carry = idx;
        for (let j = 0; j < bytes.length; j++) {
          carry += bytes[j] * 58;
          bytes[j] = carry & 0xff;
          carry >>= 8;
        }
        while (carry > 0) {
          bytes.push(carry & 0xff);
          carry >>= 8;
        }
      }
      return (zeros + bytes.length) === 32;
    }

    const cleanToken = reqToken.trim();
    const isEvmToken = cleanToken.startsWith("0x") && cleanToken.length === 42 && /^0x[a-fA-F0-9]{40}$/.test(cleanToken);
    const isSolanaToken = !cleanToken.startsWith("0x") && checkSolanaBase58Mint32(cleanToken);
    if (!isEvmToken && !isSolanaToken) {
      return c.json({
        status: "error",
        error: "INVALID_TOKEN_ADDRESS",
        message: `Invalid token address '${cleanToken}'. Must be a 42-char EVM address or 32-byte Solana base58 mint.`,
        timestamp: Math.floor(Date.now() / 1000)
      }, 400);
    }

    if (reqChain !== null && reqChain !== undefined) {
      const chainStr = String(reqChain).toLowerCase().trim();
      const isSupportedBase = chainStr === "base" || chainStr === "eip155:8453" || chainStr === "8453";
      const isSupportedSolana = chainStr === "solana" || chainStr === "solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp" || chainStr === "5eykt4usfv8p8njdtrepy1vzqkqzkvdp";

      if (!isSupportedBase && !isSupportedSolana) {
        return c.json({
          status: "error",
          error: "UNSUPPORTED_CHAIN",
          message: `Requested chain '${chainStr}' is not supported. Supported chains: Base ('eip155:8453', 'base') and Solana ('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'solana').`,
          timestamp: Math.floor(Date.now() / 1000)
        }, 400);
      }

      if (isSupportedSolana && !isSolanaToken) {
        return c.json({
          status: "error",
          error: "CHAIN_MISMATCH",
          message: "Target token address is an EVM address but requested chain is 'solana'.",
          timestamp: Math.floor(Date.now() / 1000)
        }, 400);
      }

      if (isSupportedBase && !isEvmToken) {
        return c.json({
          status: "error",
          error: "CHAIN_MISMATCH",
          message: "Target token address is a Solana mint but requested chain is EVM/Base.",
          timestamp: Math.floor(Date.now() / 1000)
        }, 400);
      }
    }

    // Branch 1: Solana Mainnet x402 Payment Settlement via PayAI Facilitator
    const incomingNetwork = (parsed.accepted?.network || parsed.network || "").toString();
    if (incomingNetwork.startsWith("solana") || parsed.payload?.transaction) {
      const txB64 = (parsed.payload?.transaction || parsed.transaction || "").toString();
      if (!txB64) {
        return return402Challenge(c, spec, "Missing Solana serialized transaction in payload.transaction");
      }
      const solanaAuthorization = authenticateSolanaTransaction(txB64);
      const solSigHash = solanaAuthorization.id;

      const host = c.req.header("host") || `localhost:${CONFIG.port}`;
      const proto = c.req.header("x-forwarded-proto") || (host.includes("onrender.com") ? "https" : "http");
      const baseUrl = host.includes("onrender.com") ? "https://rugshield-402.onrender.com" : `${proto}://${host}`;
      const resUrl = `${baseUrl}${spec.path}`;

      const solanaRequirements = {
        scheme: "exact",
        network: CONFIG.solanaNetwork,
        amount: spec.amountMicroUnits,
        asset: CONFIG.solanaUsdcMint,
        payTo: CONFIG.solanaMerchantAddress,
        maxTimeoutSeconds: 300,
        extra: {
          name: "USD Coin (Solana)",
          version: "2",
          feePayer: CONFIG.solanaFeePayer,
        },
      };
      validateMetadata(solanaRequirements);
      const recovered = recover(solSigHash);
      if (recovered) return recovered;
      if (replayCache.has(solSigHash)) {
        X402_METRICS.replaysPrevented++;
        return c.json({ error: "replay_detected", message: "Solana payment transaction already consumed." }, 409);
      }

      const resourceObj = {
        url: resUrl,
        description: spec.description,
        mimeType: "application/json",
      };

      const payaiBody = {
        x402Version: 2,
        paymentPayload: {
          x402Version: 2,
          resource: resourceObj,
          extensions: parsed.extensions || { bazaar: buildBazaarExtension(spec) },
          accepted: solanaRequirements,
          payload: { ...parsed.payload, transaction: solanaAuthorization.canonicalTransaction },
        },
        paymentRequirements: solanaRequirements,
      };

      // PayAI's read-only verification rejects invalid signatures/transactions before expensive analysis.
      try {
        const verified = await fetch(`${CONFIG.payaiFacilitator}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payaiBody), signal: AbortSignal.timeout(15000) });
        const verification: any = await verified.json();
        if (!verified.ok || verification.isValid !== true) return return402Challenge(c, spec, "Solana authorization verification failed; no settlement attempted");
      } catch { return c.json({ error: "PAYMENT_VERIFICATION_UNAVAILABLE", message: "Read-only facilitator verification unavailable. No settlement attempted." }, 503); }

      // Acquire and durably retain the exact response before any irreversible transfer.
      const preparationError = await prepare(solSigHash);
      if (preparationError) return preparationError;

      try {
        const settleRes = await fetch(`${CONFIG.payaiFacilitator}/settle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payaiBody),
          signal: AbortSignal.timeout(30000),
        });
        const settleData: any = await settleRes.json().catch(() => ({}));
        if (!settleRes.ok || settleData.success !== true || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(settleData.transaction || "") || settleData.payer !== solanaAuthorization.payer || (settleData.network !== undefined && settleData.network !== CONFIG.solanaNetwork)) {
          // Even an HTTP error may occur after broadcast. Keep pending until reconciled.
          return c.json({ error: "SETTLEMENT_PENDING_RECONCILIATION", message: "Facilitator did not return a complete confirmed receipt; do not pay again." }, 503);
        }

        replayCache.set(solSigHash, true);
        X402_METRICS.settlements++;
        const paymentInfo = {
          success: true,
          payer: settleData.payer,
          transaction: settleData.transaction,
          amount: spec.amountMicroUnits,
          network: CONFIG.solanaNetwork,
          resource: resUrl,
        };
        fulfillmentStore.complete(solSigHash, paymentInfo);
        c.header("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(paymentInfo)).toString("base64"));
        return c.res;
      } catch (solErr: any) {
        return c.json({ error: "SETTLEMENT_PENDING_RECONCILIATION", message: "Facilitator response unavailable; prepared result retained. Do not pay again." }, 503);
      }
    }

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
    const nonce = String(auth.nonce || "") as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) return return402Challenge(c, spec, "A canonical 32-byte authorization nonce is required");
    const sigHash = paymentId(`base:${from.toLowerCase()}:${nonce.toLowerCase()}`);

    // Verify recipient matches Merchant Payout Wallet
    if (!isAddress(to) || getAddress(to) !== getAddress(CONFIG.merchantAddress)) {
      return return402Challenge(c, spec, `Invalid recipient: must pay ${CONFIG.merchantAddress}`);
    }

    // Verify amount is at least route required micro-units
    const requiredUnits = BigInt(spec.amountMicroUnits);
    if (value !== requiredUnits) {
      return return402Challenge(
        c,
        spec,
        `Exact payment required: ${spec.amountMicroUnits} micro-units USDC, received ${value}`
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
    validateMetadata({ scheme: "exact", network: `eip155:${CONFIG.chainId}`, amount: spec.amountMicroUnits, asset: CONFIG.usdcAddress, payTo: CONFIG.merchantAddress });
    const recovered = recover(sigHash);
    if (recovered) return recovered;
    // Verify validity window
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (validBefore <= nowSec || validBefore > nowSec + 300n) {
      return return402Challenge(c, spec, "Payment authorization expired");
    }
    if (validAfter > nowSec) {
      return return402Challenge(c, spec, "Payment authorization not yet valid");
    }

    // Replay protection via signature hash
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


    // Direct facilitator settlement; no unauthenticated payment-only relay dependency.
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
      x402Version: 2,
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

    const preparationError = await prepare(sigHash);
    if (preparationError) return preparationError;

    let settleData: any = null;
    try {
      const relayRes = await fetch(`${CONFIG.payaiFacilitator}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(relayBody),
        signal: AbortSignal.timeout(35000),
      });
      settleData = await relayRes.json().catch(() => ({}));
      if (!relayRes.ok || settleData.success !== true || !/^0x[0-9a-fA-F]{64}$/.test(settleData.transaction || "") || (settleData.payer && String(settleData.payer).toLowerCase() !== getAddress(from).toLowerCase()) || (settleData.network !== undefined && settleData.network !== `eip155:${CONFIG.chainId}`)) {
        const errMsg = settleData.error || settleData.errorReason || `Relay HTTP ${relayRes.status}`;
        console.warn(`[rugshield-402] On-chain settlement rejected: ${errMsg}`);
        return c.json({ error: "SETTLEMENT_PENDING_RECONCILIATION", message: "Facilitator did not return a complete confirmed receipt; do not pay again." }, 503);
      }
    } catch (relayErr: any) {
      console.error(`[rugshield-402] Facilitator exception: ${relayErr.message}`);
      return c.json({ error: "SETTLEMENT_PENDING_RECONCILIATION", message: "Facilitator response unavailable; prepared result retained. Do not pay again." }, 503);
    }

    // Mark as consumed in replay cache
    replayCache.set(sigHash, true);
    X402_METRICS.settlements++;

    const txHash = settleData.transaction;
    const paymentInfo = {
      success: true,
      payer: getAddress(from),
      transaction: txHash,
      amount: value.toString(),
      network: `eip155:${CONFIG.chainId}`,
      resource: resUrl,
    };

    try { fulfillmentStore.complete(sigHash, paymentInfo); }
    catch { return c.json({ error: "SETTLEMENT_PENDING_RECONCILIATION", message: "Settlement succeeded but local receipt persistence failed. Do not pay again; prepared result retained." }, 503); }
    c.header("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(paymentInfo)).toString("base64"));
    c.set("payment", {
      payer: getAddress(from),
      amount: value,
      signatureHash: sigHash,
    });

    return c.res;
  } catch (err: any) {
    if (err instanceof FulfillmentStorageError) return c.json({ error: "PAYMENT_STORAGE_UNAVAILABLE", message: err.message }, 503);
    return return402Challenge(c, spec, `Malformed payment payload: ${err.message}`);
  }
});

// Hono has already finalized c.res after next(). Explicitly replace it when settlement
// fails; merely returning a new 503 would otherwise leak the prepared HTTP 200.
export const x402Middleware = createMiddleware<{ Variables: { payment?: X402VerificationResult } }>(async (c, next) => {
  const response = await paymentHandler(c, next);
  if (response instanceof Response) c.res = response;
  return response;
});

function buildInputSchema(example: Record<string, any>) {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const [key, val] of Object.entries(example || {})) {
    required.push(key);
    if (typeof val === "string") {
      properties[key] = { type: "string", description: key.replace(/_/g, " ") };
    } else if (typeof val === "number") {
      properties[key] = { type: Number.isInteger(val) ? "integer" : "number" };
    } else if (typeof val === "boolean") {
      properties[key] = { type: "boolean" };
    } else if (Array.isArray(val)) {
      properties[key] = { type: "array" };
    } else {
      properties[key] = { type: "object" };
    }
  }
  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: true,
  };
}

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
            body: buildInputSchema(spec.exampleInput),
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

function buildRugShieldTeaser(spec: EndpointPriceSpec, tokAddr: string) {
  const isSolana = !tokAddr.startsWith("0x") && tokAddr.length >= 32;
  const chainName = isSolana ? "Solana Mainnet" : "Base Mainnet (8453)";

  const freePreview: Record<string, any> = {
    status: "partial_preview",
    token_address: tokAddr,
    chain: chainName,
    preliminary_metrics: {
      standard: isSolana ? "SPL Token" : "ERC-20",
      market_state: "NOT_QUERIED",
      basic_risk_grade: "UNVERIFIED_HONEYPOT_RISK",
      preliminary_liquidity_usd: null,
      dex_venues_detected: [],
    },
    teaser_verdict: `No token risk conclusion has been acquired in this payment challenge. Successful analysis costs ${spec.priceUsd} USDC; failed analysis is not settled.`,
  };

  const lockedFeatures = [
    "exact_buy_sell_tax_simulation (precise transfer tax down to 0.01% fee)",
    "mempool_frontrun_sandwich_vulnerability_index",
    "sybil_holder_cluster_graph (detects coordinated dev dump clusters)",
    "liquidity_lock_expiry_audit & multisig timelock trace",
    "cryptographic_pre_trade_attestation_signature"
  ];

  return { freePreview, lockedFeatures };
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
      {
        scheme: "exact",
        network: CONFIG.solanaNetwork,
        asset: CONFIG.solanaUsdcMint,
        amount: spec.amountMicroUnits,
        maxTimeoutSeconds: 300,
        payTo: CONFIG.solanaMerchantAddress,
        extra: { name: "USD Coin (Solana)", version: "2", feePayer: CONFIG.solanaFeePayer },
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

  let targetToken = "";
  try {
    targetToken = c.req.query("token_address") || c.req.query("address") || c.req.query("token") || "";
  } catch {}
  if (!targetToken && spec.exampleInput?.token_address) {
    targetToken = spec.exampleInput.token_address;
  }
  if (!targetToken) {
    targetToken = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  }

  const { freePreview, lockedFeatures } = buildRugShieldTeaser(spec, targetToken);

  return c.json(
    {
      error: "payment_required",
      status: 402,
      x402Version: 2,
      x402_version: "2",
      message: `Payment of ${spec.priceUsd} USDC required to unlock full cryptographic analysis. Preliminary teaser data provided below.`,
      endpoint: spec.path,
      price_usdc: spec.priceUsd,
      free_preview: freePreview,
      locked_premium_analysis: lockedFeatures,
      unlock_instructions: {
        price: `${spec.priceUsd} USDC`,
        accepted_chains: ["Base Mainnet (eip155:8453)", "Solana Mainnet (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)"],
        gasless_sponsorship: "100% Gasless ($0 ETH / $0 SOL required)",
        merchant_recipient_base: CONFIG.merchantAddress,
        merchant_recipient_solana: CONFIG.solanaMerchantAddress,
        header_required: "Attach PAYMENT-SIGNATURE with signed authorization to retry",
      },
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
