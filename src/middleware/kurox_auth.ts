import { createHmac, timingSafeEqual } from "node:crypto";

export interface KuroxApiKeyPayload {
  typ: string;
  sid: string;
  sku: string;
  tier: string;
  iat: number;
  exp: number;
}

export interface KuroxBearerAuthResult {
  present: boolean;
  valid: boolean;
  status?: number;
  error?: string;
  payload?: KuroxApiKeyPayload;
}

/**
 * Verifies unified Stripe-issued sk_kurox_v1.* HMAC-SHA256 Bearer tokens.
 */
export async function verifyKuroxApiKeyToken(
  rawToken: string,
  secret: string | undefined,
): Promise<{ valid: true; payload: KuroxApiKeyPayload } | { valid: false; status: number; error: string }> {
  if (!secret || secret.length < 16) {
    return { valid: false, status: 503, error: "API key verification temporarily unavailable" };
  }
  const parts = rawToken.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "sk_kurox_v1" || !parts[1] || !parts[2]) {
    return { valid: false, status: 401, error: "Malformed Kurox API key" };
  }
  try {
    const providedSig = Buffer.from(parts[2], "base64url");
    const expectedSig = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
    if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
      return { valid: false, status: 401, error: "Invalid Kurox API key signature" };
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as KuroxApiKeyPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.typ !== "api_key" || typeof payload.exp !== "number" || payload.exp <= now) {
      return { valid: false, status: 401, error: "Expired or invalid Kurox API key" };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, status: 401, error: "Malformed Kurox API key" };
  }
}

/**
 * Inspects Authorization/X-API-Key headers for sk_kurox_v1.* Bearer tokens.
 * Leaves non-Kurox secrets (such as static SERVICE_API_KEY) untouched (present: false).
 */
export async function authenticateKuroxHeaders(
  authorizationHeader: string | undefined | null,
  xApiKeyHeader: string | undefined | null,
  secret: string | undefined,
): Promise<KuroxBearerAuthResult> {
  const auth = authorizationHeader || "";
  const rawToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : (xApiKeyHeader || "").trim();
  if (!rawToken || !rawToken.startsWith("sk_kurox_v1.")) {
    return { present: false, valid: false };
  }
  const checked = await verifyKuroxApiKeyToken(rawToken, secret);
  if (!checked.valid) {
    return { present: true, valid: false, status: checked.status, error: checked.error };
  }
  return { present: true, valid: true, payload: checked.payload };
}
