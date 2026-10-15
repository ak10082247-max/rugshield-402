import { createMiddleware } from "hono/factory";
import fs from "node:fs";
import path from "node:path";

export interface DeliveryRecord {
  timestamp_utc: string;
  payer_wallet: string;
  amount_usdc: number;
  endpoint: string;
  method: string;
  user_agent: string;
  client_ip: string;
  referer: string;
  request_input: any;
  http_status: number;
  latency_ms: number;
  response_preview: string;
}

const MAX_MEMORY_RECORDS = 200;
const memoryStore: DeliveryRecord[] = [];
const logFilePath = path.join(process.cwd(), "deliveries.jsonl");

function decodePayerFromHeader(rawHeader?: string): { payer: string; amount: number } {
  if (!rawHeader) return { payer: "unpaid_probe", amount: 0.0 };
  try {
    let jsonStr = rawHeader;
    if (!rawHeader.trim().startsWith("{")) {
      jsonStr = Buffer.from(rawHeader, "base64").toString("utf8");
    }
    const parsed = JSON.parse(jsonStr);

    if (parsed.payload?.authorization?.from) {
      const val = parsed.payload.authorization.value ? Number(parsed.payload.authorization.value) / 1e6 : 0.005;
      return { payer: parsed.payload.authorization.from.toLowerCase(), amount: val };
    }
    if (parsed.authorization?.from) {
      const val = parsed.authorization.value ? Number(parsed.authorization.value) / 1e6 : 0.005;
      return { payer: parsed.authorization.from.toLowerCase(), amount: val };
    }
    if (parsed.from) {
      const val = parsed.value ? Number(parsed.value) / 1e6 : 0.005;
      return { payer: parsed.from.toLowerCase(), amount: val };
    }
    if (parsed.payer) {
      return { payer: parsed.payer.toLowerCase(), amount: Number(parsed.amount || 0.005) };
    }
  } catch {}
  return { payer: "unknown_signer", amount: 0.005 };
}

export const deliveryRecorderMiddleware = createMiddleware(async (c, next) => {
  const path = c.req.path;
  if (path === "/health" || path === "/ping" || path === "/favicon.ico" || path === "/robots.txt") {
    return next();
  }

  const startTime = Date.now();
  const rawPaymentHdr =
    c.req.header("payment-signature") ||
    c.req.header("x-payment") ||
    c.req.header("PAYMENT-SIGNATURE") ||
    c.req.header("X-PAYMENT");

  const { payer, amount } = decodePayerFromHeader(rawPaymentHdr);

  // Capture request body / query
  let requestInput: any = {};
  if (c.req.method === "POST" || c.req.method === "PUT") {
    try {
      requestInput = await c.req.raw.clone().json();
    } catch {
      requestInput = {};
    }
  } else {
    requestInput = c.req.query();
  }

  await next();

  const latency_ms = Date.now() - startTime;
  const client_ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const user_agent = c.req.header("user-agent") || "none";
  const referer = c.req.header("referer") || "direct";
  const status = c.res.status;

  let resolvedPayer = payer;
  let resolvedAmount = amount;

  // Check payment response header
  const payRespHeader = c.res.headers.get("PAYMENT-RESPONSE") || c.res.headers.get("X-PAYMENT-RESPONSE");
  if (payRespHeader) {
    try {
      const parsedResp = JSON.parse(Buffer.from(payRespHeader, "base64").toString("utf8"));
      if (parsedResp.payer) resolvedPayer = parsedResp.payer.toLowerCase();
      if (parsedResp.amount) resolvedAmount = Number(parsedResp.amount) / 1e6;
    } catch {}
  }

  const record: DeliveryRecord = {
    timestamp_utc: new Date().toISOString(),
    payer_wallet: resolvedPayer,
    amount_usdc: status === 200 ? (resolvedAmount || 0.005) : 0.0,
    endpoint: path,
    method: c.req.method,
    user_agent,
    client_ip,
    referer,
    request_input: requestInput,
    http_status: status,
    latency_ms,
    response_preview: `HTTP ${status}`
  };

  memoryStore.unshift(record);
  if (memoryStore.length > MAX_MEMORY_RECORDS) {
    memoryStore.pop();
  }

  try {
    fs.appendFileSync(logFilePath, JSON.stringify(record) + "\n", "utf8");
  } catch {}
});

export function getRecentDeliveries(): DeliveryRecord[] {
  return [...memoryStore];
}
