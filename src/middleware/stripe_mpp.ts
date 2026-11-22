import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_STRIPE_PROFILE_ID = "profile_61VnzdDTGkNiFINqdA6VnzdDR1E92xUACS0Twn2zoUBE";
export const DEFAULT_STRIPE_MPP_VERIFY_URL = "https://agentfuel402.ak10082247.workers.dev/internal/mpp/stripe/verify";
export const STRIPE_MIN_USD_CENTS = 50;

const MAX_AUTHORIZATION_LENGTH = 64 * 1024;
const usedChallengeIds = new Set<string>();
const MAX_USED_CHALLENGES = 10_000;

export function resolveStripeProfileId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof env.STRIPE_PROFILE_ID === "string" ? env.STRIPE_PROFILE_ID.trim() : "";
  return configured || DEFAULT_STRIPE_PROFILE_ID;
}

export function resolveStripeVerifyUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof env.STRIPE_MPP_VERIFY_URL === "string" ? env.STRIPE_MPP_VERIFY_URL.trim() : "";
  return configured || DEFAULT_STRIPE_MPP_VERIFY_URL;
}

export function computeMppAmountCents(amountMicro?: string | number): number {
  return Math.max(STRIPE_MIN_USD_CENTS, Math.round(Number(amountMicro || 10_000) / 10_000));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function encodeCanonicalRequest(requestObj: Record<string, unknown>): string {
  return Buffer.from(canonicalJson(requestObj), "utf8").toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function rememberUsedChallenge(id: string): void {
  if (!id) return;
  if (usedChallengeIds.size >= MAX_USED_CHALLENGES) {
    const oldest = usedChallengeIds.values().next().value;
    if (oldest) usedChallengeIds.delete(oldest);
  }
  usedChallengeIds.add(id);
}

export function computeChallengeIdSync(
  challenge: {
    realm: string;
    method: string;
    intent: string;
    request: Record<string, unknown> | string;
    expires?: string;
    digest?: string;
    header?: string;
    opaque?: string;
    meta?: Record<string, string>;
  },
  secretKey: string,
): string {
  const encodedReq = typeof challenge.request === "string"
    ? challenge.request
    : encodeCanonicalRequest(challenge.request || {});
  const values = [
    String(challenge.realm || ""),
    String(challenge.method || ""),
    String(challenge.intent || ""),
    encodedReq,
    challenge.expires ? String(challenge.expires) : "",
    challenge.digest ? String(challenge.digest) : "",
  ];
  if (challenge.header && /^payment-authorization$/i.test(challenge.header)) {
    values.push(challenge.header);
  }
  const encodedOpaque = challenge.opaque
    ? String(challenge.opaque)
    : challenge.meta
      ? encodeCanonicalRequest(challenge.meta)
      : "";
  values.push(encodedOpaque);
  return createHmac("sha256", secretKey).update(values.join("|"), "utf8").digest("base64url");
}

function authParam(name: string, value: string): string {
  const str = String(value ?? "");
  if (/[\r\n]/.test(str)) {
    throw new Error(`Invalid quoted-string header value for ${name}`);
  }
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\u0100-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${name}="${escaped}"`;
}

export interface BuiltStripeMppChallenge {
  challenge: {
    id: string;
    realm: string;
    method: "stripe";
    intent: "charge";
    request: Record<string, unknown>;
    description?: string;
    expires: string;
  };
  requestEncoded: string;
  headerValue: string;
}

export function buildStripeChargeChallengeSync(params: {
  realm: string;
  amountCents?: number;
  description?: string;
  networkId?: string;
  secretKey?: string;
  expiresIso?: string;
}): BuiltStripeMppChallenge {
  const safeAmount = Math.max(STRIPE_MIN_USD_CENTS, Math.round(Number(params.amountCents) || STRIPE_MIN_USD_CENTS));
  const safeExpires = params.expiresIso || new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const safeRealm = String(params.realm || "rugshield-402.onrender.com");
  const safeDesc = params.description ? String(params.description).slice(0, 440) : undefined;
  const networkId = String(params.networkId || resolveStripeProfileId());

  const request: Record<string, unknown> = {
    amount: String(safeAmount),
    currency: "usd",
    ...(safeDesc ? { description: safeDesc } : {}),
    methodDetails: {
      networkId,
      paymentMethodTypes: ["card"],
    },
  };

  const base = {
    realm: safeRealm,
    method: "stripe" as const,
    intent: "charge" as const,
    request,
    ...(safeDesc ? { description: safeDesc } : {}),
    expires: safeExpires,
  };

  const secret = typeof params.secretKey === "string" ? params.secretKey.trim() : "";
  const id = secret.length >= 16
    ? computeChallengeIdSync(base, secret)
    : `dev_${randomBytes(16).toString("base64url")}`;

  const challenge = { id, ...base };
  const requestEncoded = encodeCanonicalRequest(request);
  const parts = [
    authParam("id", challenge.id),
    authParam("realm", challenge.realm),
    authParam("method", challenge.method),
    authParam("intent", challenge.intent),
    authParam("request", requestEncoded),
  ];
  if (challenge.description) parts.push(authParam("description", challenge.description));
  if (challenge.expires) parts.push(authParam("expires", challenge.expires));

  return {
    challenge,
    requestEncoded,
    headerValue: `Payment ${parts.join(", ")}`,
  };
}

export function extractPaymentSchemeHeader(
  authorizationHeader: string | undefined | null,
  paymentAuthorizationHeader?: string | undefined | null,
): string | null {
  for (const raw of [paymentAuthorizationHeader, authorizationHeader]) {
    if (!raw || raw.length > MAX_AUTHORIZATION_LENGTH) continue;
    const schemes = raw.split(",").map((s) => s.trim());
    const match = schemes.find((s) => /^Payment\s+\S+/i.test(s));
    if (match) return match;
  }
  return null;
}

export interface NormalizedMppCredential {
  challenge: Record<string, any> & { _rawRequestB64?: string };
  payload: Record<string, any>;
  source?: string;
}

export class MppCredentialError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeMppCredential(rawCred: any): NormalizedMppCredential {
  if (!rawCred || typeof rawCred !== "object" || !rawCred.challenge || typeof rawCred.challenge !== "object") {
    throw new MppCredentialError(402, "INVALID_PAYMENT_CREDENTIAL", "Credential missing challenge object");
  }
  const rawChallenge = rawCred.challenge;
  let decodedRequest = rawChallenge.request;
  let rawRequestB64: string | undefined;
  if (typeof rawChallenge.request === "string") {
    rawRequestB64 = rawChallenge.request;
    try {
      decodedRequest = JSON.parse(Buffer.from(rawChallenge.request, "base64url").toString("utf8"));
    } catch {
      throw new MppCredentialError(402, "INVALID_PAYMENT_CREDENTIAL", "Invalid base64url challenge.request");
    }
  }
  if (!decodedRequest || typeof decodedRequest !== "object") {
    throw new MppCredentialError(402, "INVALID_PAYMENT_CREDENTIAL", "Invalid challenge.request payload");
  }
  return {
    challenge: {
      ...rawChallenge,
      request: decodedRequest,
      ...(rawRequestB64 ? { _rawRequestB64: rawRequestB64 } : {}),
    },
    payload: rawCred.payload || {},
    ...(rawCred.source ? { source: rawCred.source } : {}),
  };
}

export function parsePaymentCredentialToken(rawHeader: string): NormalizedMppCredential {
  if (!rawHeader || rawHeader.length > MAX_AUTHORIZATION_LENGTH) {
    throw new MppCredentialError(402, "INVALID_PAYMENT_CREDENTIAL", "Missing or oversized Payment credential");
  }
  const m = rawHeader.trim().match(/^Payment\s+([A-Za-z0-9_-]+)$/i);
  if (!m?.[1]) {
    throw new MppCredentialError(402, "INVALID_PAYMENT_CREDENTIAL", "Malformed Payment credential scheme");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  } catch {
    throw new MppCredentialError(402, "INVALID_PAYMENT_CREDENTIAL", "Invalid base64url JSON Payment credential");
  }
  return normalizeMppCredential(parsed);
}

export function verifyStripeChallengePreFlight(
  cred: NormalizedMppCredential,
  secretKey: string | undefined,
  expectedRealms: string[],
  minAmountCents = STRIPE_MIN_USD_CENTS,
): { challenge: Record<string, any>; spt: string; amountCents: number } {
  if (!secretKey || secretKey.trim().length < 16) {
    throw new MppCredentialError(503, "STRIPE_MPP_UNAVAILABLE", "MPP challenge verification secret not configured");
  }
  const { challenge, payload } = cred;
  if (!challenge.id || !challenge.realm) {
    throw new MppCredentialError(402, "INVALID_PAYMENT_CREDENTIAL", "Challenge missing id or realm");
  }
  if (challenge.method !== "stripe" || challenge.intent !== "charge") {
    throw new MppCredentialError(402, "UNSUPPORTED_PAYMENT_METHOD", "Expected method=stripe, intent=charge");
  }
  const allowedSet = new Set(expectedRealms.map((r) => String(r).toLowerCase().replace(/\.$/, "")));
  const realmNorm = String(challenge.realm).toLowerCase().replace(/\.$/, "");
  if (!allowedSet.has(realmNorm)) {
    throw new MppCredentialError(402, "CHALLENGE_REALM_MISMATCH", `Challenge realm mismatch: ${challenge.realm}`);
  }
  const expMs = Date.parse(String(challenge.expires || ""));
  if (!Number.isFinite(expMs) || expMs <= Date.now()) {
    throw new MppCredentialError(402, "CHALLENGE_EXPIRED", "Payment challenge expired");
  }
  if (challenge.header && !/^payment-authorization$/i.test(String(challenge.header))) {
    throw new MppCredentialError(402, "UNSUPPORTED_CREDENTIAL_HEADER", "Unsupported challenge header");
  }
  const expectedId = computeChallengeIdSync(
    {
      ...challenge,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
      request: challenge._rawRequestB64 || challenge.request,
    },
    secretKey.trim(),
  );
  if (!constantTimeEqual(String(challenge.id), expectedId)) {
    throw new MppCredentialError(402, "INVALID_CHALLENGE_SIGNATURE", "Invalid Payment challenge signature");
  }
  if (usedChallengeIds.has(String(challenge.id))) {
    throw new MppCredentialError(402, "CHALLENGE_REPLAYED", "Payment challenge already redeemed");
  }

  const amountStr = String(challenge.request?.amount || "");
  if (!/^\d+$/.test(amountStr)) {
    throw new MppCredentialError(402, "INVALID_AMOUNT", "Invalid integer amount in Stripe challenge");
  }
  const amountCents = Number(amountStr);
  const currency = String(challenge.request?.currency || "").toLowerCase();
  if (currency !== "usd" || amountCents < Math.max(STRIPE_MIN_USD_CENTS, minAmountCents)) {
    throw new MppCredentialError(402, "INSUFFICIENT_AMOUNT", `Stripe MPP requires currency='usd' and amount >= ${minAmountCents} cents`);
  }
  const spt = typeof payload?.spt === "string" ? payload.spt.trim() : "";
  if (!spt || spt.length < 6) {
    throw new MppCredentialError(402, "MISSING_SPT", "Invalid credential payload: missing or malformed spt");
  }
  const reqExt = challenge.request?.externalId !== undefined ? String(challenge.request.externalId) : undefined;
  const credExt = payload?.externalId !== undefined ? String(payload.externalId) : undefined;
  if (reqExt !== undefined && credExt !== reqExt) {
    throw new MppCredentialError(402, "EXTERNAL_ID_MISMATCH", "Credential externalId does not match challenge");
  }
  return { challenge, spt, amountCents };
}

export interface StripeMppRelaySettlement {
  ok: true;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  sku: string;
  tier: string;
  receipt: Record<string, unknown>;
  receiptHeader: string;
  apiKey: string;
  apiKeyExpiresAt: string;
}

export async function settleViaAgentFuelRelay(params: {
  service: string;
  expectedRealm: string;
  credential: NormalizedMppCredential;
  minAmountCents?: number;
  secretKey: string;
  verifyUrl?: string;
  requestFn?: typeof fetch;
}): Promise<StripeMppRelaySettlement> {
  const {
    service,
    expectedRealm,
    credential,
    minAmountCents = STRIPE_MIN_USD_CENTS,
    secretKey,
    verifyUrl = resolveStripeVerifyUrl(),
    requestFn = fetch,
  } = params;

  const wireCredential = {
    challenge: {
      ...credential.challenge,
      request: credential.challenge._rawRequestB64 || encodeCanonicalRequest(credential.challenge.request),
    },
    payload: credential.payload,
    ...(credential.source ? { source: credential.source } : {}),
  };
  delete (wireCredential.challenge as any)._rawRequestB64;

  const rawBody = JSON.stringify({
    service,
    expectedRealm,
    minAmountCents,
    credential: wireCredential,
  });

  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", secretKey.trim())
    .update(`${ts}.${service}.${rawBody}`, "utf8")
    .digest("base64url");

  const res = await requestFn(verifyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kurox-Internal-Timestamp": ts,
      "X-Kurox-Internal-Service": service,
      "X-Kurox-Internal-Signature": sig,
    },
    body: rawBody,
    signal: AbortSignal.timeout(25_000),
  });

  const data: any = await res.json().catch(() => null);
  if (res.status === 402 || (data && data.ok === false && res.status < 500)) {
    throw new MppCredentialError(402, "STRIPE_MPP_VERIFICATION_FAILED", data?.message || "Stripe MPP verification rejected");
  }
  if (!res.ok || !data?.ok) {
    throw new MppCredentialError(503, "STRIPE_MPP_RELAY_UNAVAILABLE", data?.message || `Stripe MPP relay error HTTP ${res.status}`);
  }
  rememberUsedChallenge(String(credential.challenge.id));
  return data as StripeMppRelaySettlement;
}

export function buildRugShieldMppDescription(desc?: string): string {
  return `${(desc || "RugShield-402 pre-trade security scan").slice(0, 340)} ($0.50 USD Stripe MPP pass includes 7d Unified Kurox API Key)`;
}
