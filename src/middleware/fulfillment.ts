import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Snapshot = { status: number; body: string; headers: [string, string][] };
type Record = { fingerprint: string; state: "pending" | "settled"; response: Snapshot; receipt?: object };
export class FulfillmentStorageError extends Error {}

/** The directory must be on a persistent volume in production. Pending is never auto-released:
 * a timeout after /settle can mean funds moved and requires reconciliation, not a second charge. */
export class FulfillmentStore {
  constructor(private directory = process.env.X402_FULFILLMENT_DIR || join(process.cwd(), ".x402-fulfillments")) {}
  private file(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid payment identifier");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    return join(this.directory, `${id}.json`);
  }
  get(id: string): Record | null {
    try {
      const path = this.file(id);
      if (!existsSync(path)) return null;
      const stored = JSON.parse(readFileSync(path, "utf8"));
      if (!["pending", "settled"].includes(stored.state) || typeof stored.fingerprint !== "string" || !stored.response) throw new Error("Malformed record");
      return stored;
    } catch { throw new FulfillmentStorageError("Payment recovery storage is unavailable or corrupt; do not replace the authorization"); }
  }
  reserve(id: string, fingerprint: string, response: Snapshot): boolean {
    const path = this.file(id);
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); } catch (error: any) { if (error.code === "EEXIST") return false; throw new FulfillmentStorageError("Payment recovery storage could not be reserved"); }
    try { writeFileSync(fd, JSON.stringify({ fingerprint, state: "pending", response })); fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  }
  complete(id: string, receipt: object) {
    const record = this.get(id);
    if (!record || record.state !== "pending") throw new Error("No pending purchased result");
    const path = this.file(id), tmp = `${path}.complete`;
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...record, state: "settled", receipt })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
  }
  releaseRejected(id: string) { unlinkSync(this.file(id)); }
}

export const fulfillmentStore = new FulfillmentStore();
export const paymentId = (value: string) => createHash("sha256").update(value).digest("hex");
export async function requestFingerprint(c: any) {
  const body = ["POST", "PUT", "PATCH"].includes(c.req.method) ? await c.req.raw.clone().text() : "";
  return paymentId(`${c.req.method}\n${new URL(c.req.url).pathname}${new URL(c.req.url).search}\n${body}`);
}
export async function snapshotResponse(response: Response): Promise<Snapshot> {
  return { status: response.status, body: await response.clone().text(), headers: [...response.headers] };
}
export function restoreResponse(record: Record): Response {
  const headers = new Headers(record.response.headers);
  if (record.receipt) headers.set("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(record.receipt)).toString("base64"));
  headers.set("X-Payment-Recovered", "true");
  return new Response(record.response.body, { status: record.response.status, headers });
}
