import { createMiddleware } from "hono/factory";
import fs from "node:fs";
import path from "node:path";

export interface DeliveryRecord {
  timestamp_utc: string;
  settled: boolean;
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
const paidMemoryStore: DeliveryRecord[] = [];
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
      return { payer: String(parsed.payload.authorization.from).toLowerCase(), amount: val };
    }
    if (parsed.authorization?.from) {
      const val = parsed.authorization.value ? Number(parsed.authorization.value) / 1e6 : 0.005;
      return { payer: String(parsed.authorization.from).toLowerCase(), amount: val };
    }
    if (parsed.from) {
      const val = parsed.value ? Number(parsed.value) / 1e6 : 0.005;
      return { payer: String(parsed.from).toLowerCase(), amount: val };
    }
    if (parsed.payer) {
      return { payer: String(parsed.payer).toLowerCase(), amount: Number(parsed.amount || 0.005) };
    }
  } catch {}
  return { payer: "unknown_signer", amount: 0.005 };
}

export const deliveryRecorderMiddleware = createMiddleware(async (c, next) => {
  const reqPath = c.req.path;
  if (reqPath === "/health" || reqPath === "/ping" || reqPath === "/favicon.ico" || reqPath === "/robots.txt") {
    return next();
  }

  const startTime = Date.now();
  const rawPaymentHdr =
    c.req.header("payment-signature") ||
    c.req.header("x-payment") ||
    c.req.header("PAYMENT-SIGNATURE") ||
    c.req.header("X-PAYMENT");

  const { payer, amount } = decodePayerFromHeader(rawPaymentHdr);

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
  let settled = Boolean(status === 200 && rawPaymentHdr && reqPath.startsWith("/v1/scan"));

  const payRespHeader = c.res.headers.get("PAYMENT-RESPONSE") || c.res.headers.get("X-PAYMENT-RESPONSE");
  if (payRespHeader) {
    try {
      const parsedResp = JSON.parse(Buffer.from(payRespHeader, "base64").toString("utf8"));
      if (parsedResp.payer) resolvedPayer = String(parsedResp.payer).toLowerCase();
      if (parsedResp.amount) resolvedAmount = Number(parsedResp.amount) / 1e6;
      if (parsedResp.success === true) settled = true;
    } catch {}
  }

  let responsePreview = `HTTP ${status}`;
  try {
    const clonedText = await c.res.clone().text();
    if (clonedText) responsePreview = clonedText.slice(0, 300);
  } catch {}

  let reqInputStr = "{}";
  try {
    reqInputStr = JSON.stringify(requestInput).slice(0, 500);
  } catch {}

  const record: DeliveryRecord = {
    timestamp_utc: new Date().toISOString(),
    settled,
    payer_wallet: resolvedPayer,
    amount_usdc: settled ? (resolvedAmount || 0.005) : 0.0,
    endpoint: reqPath,
    method: c.req.method,
    user_agent,
    client_ip,
    referer,
    request_input: requestInput,
    http_status: status,
    latency_ms,
    response_preview: responsePreview,
  };

  console.log(JSON.stringify({
    ts: record.timestamp_utc,
    service: "rugshield-402",
    endpoint: `${c.req.method} ${reqPath}`,
    status,
    durationMs: latency_ms,
    settled,
    payer: resolvedPayer,
    amountUsdc: record.amount_usdc,
    requestInput: reqInputStr,
    responsePreview,
  }));

  memoryStore.unshift(record);
  if (memoryStore.length > MAX_MEMORY_RECORDS) {
    memoryStore.pop();
  }

  if (settled) {
    paidMemoryStore.unshift(record);
    if (paidMemoryStore.length > MAX_MEMORY_RECORDS) {
      paidMemoryStore.pop();
    }
  }

  try {
    fs.appendFileSync(logFilePath, JSON.stringify(record) + "\n", "utf8");
  } catch {}
});

export function getRecentDeliveries(): DeliveryRecord[] {
  return [...memoryStore];
}

export function getPaidDeliveries(): DeliveryRecord[] {
  return [...paidMemoryStore];
}
