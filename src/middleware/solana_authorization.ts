import { createHash, createPublicKey, verify } from "node:crypto";
import { CONFIG } from "../config.js";

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`), output = "";
  while (value > 0n) { output = alphabet[Number(value % 58n)] + output; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; output = "1" + output; }
  return output;
}

/** Authenticate the buyer before result recovery. Message identity survives sponsor co-signing
 * and equivalent base64 padding, but cannot be forged from a public payer address and nonce. */
export function authenticateSolanaTransaction(encoded: string, expectedFeePayer = CONFIG.solanaFeePayer) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 1800) throw new Error("Invalid serialized Solana transaction");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 1232 || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error("Noncanonical transaction bytes");
  let cursor = 0;
  const shortVec = (data: Buffer) => {
    let value = 0, shift = 0;
    for (let count = 0; count < 3; count++) {
      if (cursor >= data.length) throw new Error("Truncated transaction length");
      const next = data[cursor++]; value |= (next & 127) << shift;
      if (!(next & 128)) return value;
      shift += 7;
    }
    throw new Error("Invalid transaction length");
  };
  const signatures = shortVec(bytes);
  if (signatures !== 2 || bytes.length <= cursor + signatures * 64) throw new Error("Expected sponsored transaction with buyer and fee payer signers");
  const feeSignature = bytes.subarray(cursor, cursor + 64), buyerSignature = bytes.subarray(cursor + 64, cursor + 128);
  const message = bytes.subarray(cursor + signatures * 64);
  cursor = 0;
  if (message[0] & 128) { if (message[cursor++] !== 128) throw new Error("Unsupported Solana transaction version"); }
  if (message[cursor] !== signatures) throw new Error("Signer count mismatch");
  cursor += 3;
  const accounts = shortVec(message);
  if (accounts < 2 || message.length < cursor + accounts * 32 + 32 + 1) throw new Error("Truncated account/message data");
  const feeKey = message.subarray(cursor, cursor + 32), buyerKey = message.subarray(cursor + 32, cursor + 64);
  if (encodeBase58(feeKey) !== expectedFeePayer) throw new Error("Unexpected transaction fee payer");
  const publicKey = (key: Buffer) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]), format: "der", type: "spki" });
  if (!verify(null, message, publicKey(buyerKey), buyerSignature)) throw new Error("Invalid buyer signature");
  if (!feeSignature.equals(Buffer.alloc(64)) && !verify(null, message, publicKey(feeKey), feeSignature)) throw new Error("Invalid sponsor signature");
  const id = createHash("sha256").update("solana:").update(message).update(buyerKey).digest("hex");
  return { id, payer: encodeBase58(buyerKey), canonicalTransaction: bytes.toString("base64") };
}
