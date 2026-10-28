import { isAddress } from "viem";
import { CONFIG } from "../config.js";
import { isSolanaMintAddress } from "./solana_scan.js";

export class ScanInputError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Shared by paid scans, previews and evidence routes; never performs provider work. */
export async function readScanInput(c: any) {
  if (typeof c.req.queries === "function" && Object.values(c.req.queries()).some(values => Array.isArray(values) && values.length > 1)) throw new ScanInputError("DUPLICATE_QUERY_PARAMETER", "Duplicate query parameters are unsupported");
  let body: Record<string, unknown> = {};
  if (["POST", "PUT"].includes(c.req.method)) {
    try { body = await c.req.json(); }
    catch { throw new ScanInputError("INVALID_JSON", "Expected a JSON object request body"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScanInputError("INVALID_JSON_OBJECT", "Expected a JSON object request body");
  }
  const targets: unknown[] = [];
  for (const key of ["token_address", "address", "token", "target"]) {
    if (Object.hasOwn(body, key)) targets.push(body[key]);
    if (c.req.query(key) !== undefined) targets.push(c.req.query(key));
  }
  if (!targets.length || targets.some(target => typeof target !== "string")) throw new ScanInputError("INVALID_TOKEN_ADDRESS", "A token or wallet address string is required");
  const normalizedTargets = (targets as string[]).map(target => target.trim()).map(target => target.startsWith("0x") ? target.toLowerCase() : target);
  if (new Set(normalizedTargets).size !== 1) throw new ScanInputError("CONFLICTING_TARGET_ADDRESSES", "Every supplied target alias must name the same address");
  const token = (targets[0] as string).trim();
  const isEvm = isAddress(token as string);
  const isSolana = isSolanaMintAddress(token as string);
  if (!isEvm && !isSolana) throw new ScanInputError("INVALID_TOKEN_ADDRESS", "Expected a valid Base address or 32-byte Solana address");
  const chain = isSolana ? "solana" : "base";
  for (const value of [body.chain, body.chain_id, c.req.query("chain"), c.req.query("chain_id")]) {
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number") throw new ScanInputError("INVALID_CHAIN", "chain must name Base or Solana");
    const normalized = String(value).toLowerCase().trim();
    const requested = ["base", "8453", "eip155:8453"].includes(normalized) ? "base"
      : ["solana", CONFIG.solanaNetwork.toLowerCase(), "5eykt4usfv8p8njdtrepy1vzqkqzkvdp"].includes(normalized) ? "solana" : null;
    if (requested !== chain) throw new ScanInputError("CHAIN_MISMATCH_OR_UNSUPPORTED", "Every supplied chain selector must match the target address");
  }
  if (body.simulate_sell !== undefined && typeof body.simulate_sell !== "boolean") throw new ScanInputError("INVALID_SIMULATE_SELL", "simulate_sell must be a JSON boolean");
  const querySimulation = c.req.query("simulate_sell");
  if (querySimulation !== undefined && querySimulation !== "true" && querySimulation !== "false") throw new ScanInputError("INVALID_SIMULATE_SELL", "Query simulate_sell must be true or false");
  if (body.simulate_sell !== undefined && querySimulation !== undefined && body.simulate_sell !== (querySimulation === "true")) throw new ScanInputError("CONFLICTING_SIMULATE_SELL", "Body and query simulate_sell must agree");
  // A normal scan always requests the promised buy/sell simulation. Metadata-only
  // inspection must be an explicit choice on either chain, never a silent downgrade.
  const simulate = body.simulate_sell ?? (querySimulation === undefined ? true : querySimulation === "true");
  return { token: token as string, chain, simulate: simulate as boolean };
}
