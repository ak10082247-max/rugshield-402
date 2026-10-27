import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// Load environment variables
for (const rel of [".env", "../.env", "../canaryguard-402/.env.local"]) {
  const p = path.resolve(process.cwd(), rel);
  if (fs.existsSync(p)) {
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const idx = trimmed.indexOf("=");
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
}

const BASE_NETWORK = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_MERCHANT = "0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1";

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOLANA_MERCHANT = new PublicKey("3tQ4GthjUMqNsyrb1rZMocMHoNewFQWjDUvHZqWeYuCN");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PAYAI_FACILITATOR = "https://facilitator.payai.network";
const PAYAI_FEE_PAYER = new PublicKey("CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww");

function findAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return pda;
}

function createTransferCheckedIx(
  sourceAta: PublicKey,
  mint: PublicKey,
  destAta: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // Opcode 12: TransferChecked
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function signBasePayment(
  account: ReturnType<typeof privateKeyToAccount>,
  targetUrl: string,
  targetBody: any
) {
  // Step 1: Probe endpoint for 402 challenge
  const chalRes = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(targetBody),
  });

  const reqHdr = chalRes.headers.get("payment-required") || chalRes.headers.get("x-payment-required");
  if (!reqHdr) {
    throw new Error(`Endpoint did not return 402 challenge header, status: ${chalRes.status}`);
  }

  const decoded = JSON.parse(Buffer.from(reqHdr, "base64").toString("utf8"));
  const exactAcc = (decoded.accepts || []).find((a: any) => a.network === BASE_NETWORK) || decoded.accepts?.[0];
  const exactRes = decoded.resource;
  const exactExt = decoded.extensions;

  const nowSec = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(nowSec - 60);
  const validBefore = BigInt(nowSec + (exactAcc?.maxTimeoutSeconds || 300));
  const nonce = (`0x${crypto.randomBytes(32).toString("hex")}`) as `0x${string}`;
  const payToAddr = (exactAcc?.payTo || BASE_MERCHANT) as `0x${string}`;
  const reqAmount = String(exactAcc?.amount || "10000");

  const signature = await account.signTypedData({
    domain: {
      name: exactAcc?.extra?.name || "USD Coin",
      version: exactAcc?.extra?.version || "2",
      chainId: 8453,
      verifyingContract: (exactAcc?.asset || BASE_USDC) as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: payToAddr,
      value: BigInt(reqAmount),
      validAfter,
      validBefore,
      nonce,
    },
  });

  const baseRequirements = exactAcc || {
    scheme: "exact",
    network: BASE_NETWORK,
    amount: reqAmount,
    asset: BASE_USDC,
    payTo: BASE_MERCHANT,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };

  const paymentPayload = {
    x402Version: 2,
    resource: exactRes || { url: targetUrl, mimeType: "application/json" },
    extensions: exactExt,
    accepted: baseRequirements,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: payToAddr,
        value: reqAmount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  const sigHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
  const paidRes = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "PAYMENT-SIGNATURE": sigHeader,
      "X-PAYMENT": sigHeader,
    },
    body: JSON.stringify(targetBody),
  });

  const payResp = paidRes.headers.get("payment-response") || paidRes.headers.get("x-payment-response");
  let txHash = "";
  if (payResp) {
    try {
      const rec = JSON.parse(Buffer.from(payResp, "base64").toString("utf8"));
      txHash = rec.transaction || rec.txHash || "";
    } catch {}
  }

  const responseJson = await paidRes.json().catch(() => ({}));
  return {
    status: paidRes.status,
    txHash,
    amountMicro: reqAmount,
    response: responseJson,
  };
}

async function signSolanaPayment(
  buyerKeypair: Keypair,
  targetUrl: string,
  targetBody: any
) {
  const chalRes = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(targetBody),
  });

  const reqHdr = chalRes.headers.get("payment-required") || chalRes.headers.get("x-payment-required");
  if (!reqHdr) {
    throw new Error(`Endpoint did not return 402 challenge header, status: ${chalRes.status}`);
  }

  const decoded = JSON.parse(Buffer.from(reqHdr, "base64").toString("utf8"));
  const solAcc = (decoded.accepts || []).find((a: any) => a.network === SOLANA_CAIP2);
  if (!solAcc) {
    throw new Error("Endpoint does not advertise Solana in accepts[]");
  }

  const conn = new Connection(SOLANA_RPC, "confirmed");
  const buyerAta = findAssociatedTokenAddress(buyerKeypair.publicKey, SOLANA_USDC_MINT);
  const merchantAta = findAssociatedTokenAddress(SOLANA_MERCHANT, SOLANA_USDC_MINT);

  const transferAmount = BigInt(solAcc.amount || "10000");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 20000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    createTransferCheckedIx(buyerAta, SOLANA_USDC_MINT, merchantAta, buyerKeypair.publicKey, transferAmount, 6),
  ];

  const v0Msg = new TransactionMessage({
    payerKey: PAYAI_FEE_PAYER,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const v0Tx = new VersionedTransaction(v0Msg);
  v0Tx.sign([buyerKeypair]); // Partial sign slot [1]

  const serializedTxB64 = Buffer.from(v0Tx.serialize()).toString("base64");

  const paymentPayload = {
    x402Version: 2,
    resource: decoded.resource || { url: targetUrl, mimeType: "application/json" },
    extensions: decoded.extensions,
    accepted: solAcc,
    payload: { transaction: serializedTxB64 },
  };

  const sigHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
  const paidRes = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "PAYMENT-SIGNATURE": sigHeader,
      "X-PAYMENT": sigHeader,
    },
    body: JSON.stringify(targetBody),
  });

  const payResp = paidRes.headers.get("payment-response") || paidRes.headers.get("x-payment-response");
  let txHash = "";
  if (payResp) {
    try {
      const rec = JSON.parse(Buffer.from(payResp, "base64").toString("utf8"));
      txHash = rec.transaction || "";
    } catch {}
  }

  const responseJson = await paidRes.json().catch(() => ({}));
  return {
    status: paidRes.status,
    txHash,
    amountMicro: solAcc.amount,
    response: responseJson,
  };
}

async function main() {
  console.log("====================================================================");
  console.log("KUROX FLEET: AUTONOMOUS ON-CHAIN TRACTION & SETTLEMENT PULSE");
  console.log("====================================================================");

  // 1. Setup Base Account
  const baseKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
  const baseAccount = privateKeyToAccount(baseKey);
  const basePublic = createPublicClient({ chain: base, transport: http("https://base-rpc.publicnode.com") });

  const getBaseMerchantBal = async () => {
    const b = await basePublic.readContract({
      address: BASE_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [BASE_MERCHANT],
    });
    return formatUnits(b, 6);
  };

  const getBaseBuyerBal = async () => {
    const b = await basePublic.readContract({
      address: BASE_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [baseAccount.address],
    });
    return formatUnits(b, 6);
  };

  const initialBaseBuyer = await getBaseBuyerBal();
  const initialBaseMerch = await getBaseMerchantBal();
  console.log(`Initial Base Buyer Bal:    ${initialBaseBuyer} USDC`);
  console.log(`Initial Base Merchant Bal: ${initialBaseMerch} USDC\n`);

  // 2. Setup Solana Account
  const rawSolKey = process.env.PRIVATE_KEY || "";
  const solBuyerKp = rawSolKey.startsWith("[")
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawSolKey)))
    : Keypair.fromSecretKey(bs58.decode(rawSolKey));

  const solConn = new Connection(SOLANA_RPC, "confirmed");
  const merchantSolAta = findAssociatedTokenAddress(SOLANA_MERCHANT, SOLANA_USDC_MINT);
  const buyerSolAta = findAssociatedTokenAddress(solBuyerKp.publicKey, SOLANA_USDC_MINT);

  const initialSolBuyer = await solConn.getTokenAccountBalance(buyerSolAta).then(b => b.value.uiAmountString).catch(() => "0");
  const initialSolMerch = await solConn.getTokenAccountBalance(merchantSolAta).then(b => b.value.uiAmountString).catch(() => "0");
  console.log(`Initial Solana Buyer Bal:    ${initialSolBuyer} USDC`);
  console.log(`Initial Solana Merchant Bal: ${initialSolMerch} USDC\n`);

  const results: any[] = [];

  // PULSE 1: CanaryGuard Prompt-Injection Sanitizer (Base)
  console.log("▶ [1/4] Executing settlement on CanaryGuard (/v1/sanitize)...");
  try {
    const r1 = await signBasePayment(baseAccount, "https://canaryguard-402.onrender.com/v1/sanitize", {
      content: "Audit autonomous trading agent system context for malicious transfer overrides.",
      strict_mode: true,
    });
    console.log(`   ✅ CanaryGuard HTTP ${r1.status} | TxHash: ${r1.txHash || "Settled via CDP"}`);
    results.push({ service: "canaryguard-402", path: "/v1/sanitize", network: "base", ...r1 });
  } catch (e: any) {
    console.error(`   ❌ CanaryGuard failed: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  // PULSE 2: RugShield Pre-Trade Honeypot Scanner (Base)
  console.log("▶ [2/4] Executing settlement on RugShield (/v1/scan)...");
  try {
    const r2 = await signBasePayment(baseAccount, "https://rugshield-402.onrender.com/v1/scan", {
      token_address: BASE_USDC,
      chain: "base",
    });
    console.log(`   ✅ RugShield HTTP ${r2.status} | TxHash: ${r2.txHash || "Settled via CDP"}`);
    results.push({ service: "rugshield-402", path: "/v1/scan", network: "base", ...r2 });
  } catch (e: any) {
    console.error(`   ❌ RugShield failed: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  // PULSE 3: RugShield Nansen Token Screener (Base)
  console.log("▶ [3/4] Executing settlement on RugShield (/api/v1/token-screener)...");
  try {
    const r3 = await signBasePayment(baseAccount, "https://rugshield-402.onrender.com/api/v1/token-screener", {
      chain: "base",
      token_address: BASE_USDC,
    });
    console.log(`   ✅ Token Screener HTTP ${r3.status} | TxHash: ${r3.txHash || "Settled via CDP"}`);
    results.push({ service: "rugshield-402", path: "/api/v1/token-screener", network: "base", ...r3 });
  } catch (e: any) {
    console.error(`   ❌ Token Screener failed: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  // PULSE 4: RugShield Pre-Trade Scanner on Solana (Solana via PayAI)
  console.log("▶ [4/4] Executing settlement on RugShield Solana (/v1/scan)...");
  try {
    const r4 = await signSolanaPayment(solBuyerKp, "https://rugshield-402.onrender.com/v1/scan", {
      token_address: SOLANA_USDC_MINT.toBase58(),
      chain: "solana",
    });
    console.log(`   ✅ Solana RugShield HTTP ${r4.status} | TxHash: ${r4.txHash || "Settled via PayAI"}`);
    results.push({ service: "rugshield-402", path: "/v1/scan", network: "solana", ...r4 });
  } catch (e: any) {
    console.error(`   ❌ Solana RugShield failed: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 3000));

  const finalBaseMerch = await getBaseMerchantBal();
  const finalSolMerch = await solConn.getTokenAccountBalance(merchantSolAta).then(b => b.value.uiAmountString).catch(() => "0");

  console.log("\n====================================================================");
  console.log("PULSE COMPLETE — TREASURY UPDATES");
  console.log("====================================================================");
  console.log(`Base Merchant Vault:   ${initialBaseMerch} -> ${finalBaseMerch} USDC`);
  console.log(`Solana Merchant Vault: ${initialSolMerch} -> ${finalSolMerch} USDC`);
  console.log("====================================================================");

  const reportOut = {
    timestamp: new Date().toISOString(),
    results,
    treasury: {
      base_merchant: finalBaseMerch,
      solana_merchant: finalSolMerch,
    },
  };

  fs.writeFileSync("../scripts/m2m_pulse_receipts.json", JSON.stringify(reportOut, null, 2));
  console.log("Saved receipts to scripts/m2m_pulse_receipts.json");
}

main().catch(console.error);
