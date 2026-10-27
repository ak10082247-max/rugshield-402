// Deliberately public, unfunded test keys. No user wallet or live payment is involved.
// Solana messages contain no transfer instructions and unusable synthetic blockhashes.
// Base authorizations expired in 2023 and cannot be settled on mainnet.
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { CONFIG } from "../src/config.js";

const edKey = (byte: number) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, byte)]), format: "der", type: "pkcs8" });
const publicBytes = (key: ReturnType<typeof edKey>) => createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decode58(value: string) { let number = 0n; for (const char of value) number = number * 58n + BigInt(alphabet.indexOf(char)); return Buffer.from(number.toString(16).padStart(64, "0"), "hex"); }
function encode58(bytes: Buffer) { let number = BigInt(`0x${bytes.toString("hex")}`), output = ""; while (number > 0n) { output = alphabet[Number(number % 58n)] + output; number /= 58n; } for (const byte of bytes) { if (byte !== 0) break; output = "1" + output; } return output; }

export function offlineSolanaTransaction(index: number, coSignedTestSponsor = false) {
  const buyer = edKey(17), sponsor = edKey(19);
  const feeBytes = coSignedTestSponsor ? publicBytes(sponsor) : decode58(CONFIG.solanaFeePayer);
  const message = Buffer.concat([Buffer.from([128, 2, 0, 0, 2]), feeBytes, publicBytes(buyer), Buffer.alloc(32, index + 1), Buffer.from([0, 0])]);
  const feeSignature = coSignedTestSponsor ? sign(null, message, sponsor) : Buffer.alloc(64);
  return { feePayer: encode58(feeBytes), transaction: Buffer.concat([Buffer.from([2]), feeSignature, sign(null, message, buyer), message]).toString("base64") };
}

export async function offlineBaseAuthorization() {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const authorization = { from: account.address, to: CONFIG.merchantAddress, value: "10000", validAfter: "0", validBefore: "1700000000", nonce: `0x${"22".repeat(32)}` as `0x${string}` };
  const signature = await account.signTypedData({ domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: CONFIG.usdcAddress }, types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] }, primaryType: "TransferWithAuthorization", message: { ...authorization, value: 10000n, validAfter: 0n, validBefore: 1700000000n } });
  return { authorization, signature, transaction: `0x${"33".repeat(32)}` };
}
