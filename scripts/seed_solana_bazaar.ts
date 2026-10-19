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
import { createPublicClient, http, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// Load both workspace .env (Solana keypair) and canaryguard-402/.env.local (Base keypair)
for (const rel of [".env", "canaryguard-402/.env.local"]) {
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

const PAYAI_FACILITATOR = "https://facilitator.payai.network";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SOLANA_MERCHANT = new PublicKey(
  process.env.SOLANA_MERCHANT_ADDRESS || "3tQ4GthjUMqNsyrb1rZMocMHoNewFQWjDUvHZqWeYuCN"
);

const BASE_NETWORK = "eip155:8453";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_MERCHANT = "0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1";

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
  amountMicro: bigint,
  decimals: number = 6
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0); // 12 = TransferChecked
  data.writeBigUInt64LE(amountMicro, 1);
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

function loadSolanaBuyerKeypair(): Keypair {
  const raw = process.env.PRIVATE_KEY || "";
  if (!raw) throw new Error("Missing PRIVATE_KEY in .env");
  if (raw.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function getSolanaUsdcMicro(conn: Connection, owner: PublicKey): Promise<number> {
  const resp = await conn.getParsedTokenAccountsByOwner(owner, { mint: SOLANA_USDC_MINT });
  let total = 0;
  for (const acc of resp.value) {
    total += Number(acc.account.data.parsed.info.tokenAmount.amount || 0);
  }
  return total;
}

function buildBazaarExtension(pathStr: string, description: string, exampleInput?: any) {
  const inputBody = exampleInput || {
    token_address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    chain: "solana",
  };
  return {
    bazaar: {
      info: {
        input: {
          type: "http",
          method: "POST",
          bodyType: "json",
          body: inputBody,
        },
        output: {
          type: "json",
          example: {
            status: "success",
            endpoint: pathStr,
            description,
            verdict: "INSTITUTIONAL_GRADE_SAFE",
          },
        },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["input"],
        properties: {
          input: {
            type: "object",
            required: ["type", "method", "bodyType", "body"],
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["POST", "GET"] },
              bodyType: { type: "string", enum: ["json"] },
              body: { type: "object", properties: {} },
            },
            additionalProperties: false,
          },
          output: {
            type: "object",
            required: ["type"],
            properties: {
              type: { type: "string" },
              example: {
                type: "object",
                required: ["status"],
                properties: { status: { type: "string" } },
                additionalProperties: true,
              },
            },
          },
        },
      },
    },
  };
}

interface EndpointTarget {
  service: string;
  baseUrl: string;
  path: string;
  url: string;
  amountMicro: string;
  description: string;
}

async function discoverAll65Endpoints(): Promise<EndpointTarget[]> {
  const all: EndpointTarget[] = [];

  // 1. RugShield-402 (12 routes)
  const rsRes = await fetch("https://rugshield-402.onrender.com/.well-known/x402.json");
  const rsJson: any = await rsRes.json();
  for (const ep of rsJson.endpoints || []) {
    all.push({
      service: "rugshield-402",
      baseUrl: "https://rugshield-402.onrender.com",
      path: ep.path,
      url: `https://rugshield-402.onrender.com${ep.path}`,
      amountMicro: String(ep.amount || "10000"),
      description: ep.description || `RugShield 402 ${ep.path}`,
    });
  }

  // 2. CanaryGuard-402 (34 routes)
  const cgRes = await fetch("https://canaryguard-402.onrender.com/.well-known/x402.json");
  const cgJson: any = await cgRes.json();
  for (const ep of cgJson.endpoints || []) {
    const u = String(ep.url || "");
    const p = u.replace("https://canaryguard-402.onrender.com", "");
    all.push({
      service: "canaryguard-402",
      baseUrl: "https://canaryguard-402.onrender.com",
      path: p,
      url: `https://canaryguard-402.onrender.com${p}`,
      amountMicro: String(ep.amount || "10000"),
      description: ep.description || `CanaryGuard 402 ${p}`,
    });
  }

  // 3. StealthGuard-402 (15 routes)
  const sgRes = await fetch("https://stealthguard-402.onrender.com/.well-known/x402.json");
  const sgJson: any = await sgRes.json();
  for (const ep of sgJson.endpoints || []) {
    const u = String(ep.url || "");
    const p = u.replace("https://stealthguard-402.onrender.com", "");
    all.push({
      service: "stealthguard-402",
      baseUrl: "https://stealthguard-402.onrender.com",
      path: p,
      url: `https://stealthguard-402.onrender.com${p}`,
      amountMicro: String(ep.amount || "10000"),
      description: ep.description || `StealthGuard 402 ${p}`,
    });
  }

  // 4. x402-Agent-Tollbooth (4 routes)
  const tbRoutes = [
    { path: "/toll/ai_intel", amountMicro: "1000", description: "Deep AI Vulnerability & Intelligence Engine on Base & Solana." },
    { path: "/toll/arbitrage_scan", amountMicro: "2000", description: "Cross-DEX Arbitrage & Liquidity Scanner on Base & Solana." },
    { path: "/toll/smart_router", amountMicro: "2000", description: "MEV-Protected Smart Order Router & Slippage Optimizer." },
    { path: "/api/audit", amountMicro: "3000", description: "Automated Smart Contract Bytecode & Exploit Auditor." },
  ];
  for (const ep of tbRoutes) {
    all.push({
      service: "x402-agent-tollbooth",
      baseUrl: "https://x402-agent-tollbooth.onrender.com",
      path: ep.path,
      url: `https://x402-agent-tollbooth.onrender.com${ep.path}`,
      amountMicro: ep.amountMicro,
      description: ep.description,
    });
  }

  return all;
}

async function signBaseEip3009Payload(
  account: ReturnType<typeof privateKeyToAccount>,
  resourceUrl: string,
  description: string,
  pathStr: string,
  amountMicro: string = "10000",
  exactAccepted?: any,
  exactResource?: any,
  exactExtensions?: any
) {
  const nowSec = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(nowSec - 600);
  const validBefore = BigInt(nowSec + (exactAccepted?.maxTimeoutSeconds || 300));
  const nonce = (`0x${crypto.randomBytes(32).toString("hex")}`) as `0x${string}`;
  const payToAddr = (exactAccepted?.payTo || BASE_MERCHANT) as `0x${string}`;
  const reqAmount = String(exactAccepted?.amount || amountMicro);

  const signature = await account.signTypedData({
    domain: {
      name: exactAccepted?.extra?.name || "USD Coin",
      version: exactAccepted?.extra?.version || "2",
      chainId: 8453,
      verifyingContract: (exactAccepted?.asset || BASE_USDC) as `0x${string}`,
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

  const baseRequirements = exactAccepted || {
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
    resource: exactResource || {
      url: resourceUrl,
      description,
      mimeType: "application/json",
    },
    extensions: exactExtensions || buildBazaarExtension(pathStr, description, {
      token_address: BASE_USDC,
      chain: "base",
    }),
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

  return { paymentPayload, paymentRequirements: baseRequirements };
}

async function main() {
  console.log("====================================================================");
  console.log("KUROX 402 — FULL 65-ENDPOINT SOLANA + 12 NANSEN BASE BAZAAR SEEDER");
  console.log("====================================================================");

  const reportPath = path.resolve(process.cwd(), "scripts/full_65_bazaar_settlement_report.json");
  let prevReport: any = null;
  if (fs.existsSync(reportPath)) {
    try {
      prevReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch {}
  }

  const solConn = new Connection(SOLANA_RPC, "confirmed");
  const solBuyer = loadSolanaBuyerKeypair();
  const buyerAta = findAssociatedTokenAddress(solBuyer.publicKey, SOLANA_USDC_MINT);
  const merchantAta = findAssociatedTokenAddress(SOLANA_MERCHANT, SOLANA_USDC_MINT);

  const baseBuyerKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
  const baseAccount = privateKeyToAccount(baseBuyerKey);
  const baseRpc = createPublicClient({
    chain: base,
    transport: http("https://base-rpc.publicnode.com"),
  });
  const getBaseUsdc = async (addr: string) => {
    const raw = await baseRpc.readContract({
      address: BASE_USDC as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [addr as `0x${string}`],
    });
    return Number(raw) / 1e6;
  };

  const initSolBuyerUsdc = prevReport?.wallets?.solana_buyer?.initial_usdc ?? (await getSolanaUsdcMicro(solConn, solBuyer.publicKey)) / 1e6;
  const initSolMerchantUsdc = prevReport?.wallets?.solana_merchant?.initial_usdc ?? (await getSolanaUsdcMicro(solConn, SOLANA_MERCHANT)) / 1e6;
  const initBaseBuyerUsdc = prevReport?.wallets?.base_buyer?.initial_usdc ?? await getBaseUsdc(baseAccount.address);
  const initBaseMerchantUsdc = prevReport?.wallets?.base_merchant?.initial_usdc ?? await getBaseUsdc(BASE_MERCHANT);

  console.log(`[Init] Solana Buyer (${solBuyer.publicKey.toBase58()}): ${initSolBuyerUsdc.toFixed(6)} USDC`);
  console.log(`[Init] Solana Merchant (${SOLANA_MERCHANT.toBase58()}): ${initSolMerchantUsdc.toFixed(6)} USDC`);
  console.log(`[Init] Base Buyer (${baseAccount.address}): ${initBaseBuyerUsdc.toFixed(6)} USDC`);
  console.log(`[Init] Base Merchant (${BASE_MERCHANT}): ${initBaseMerchantUsdc.toFixed(6)} USDC`);

  // Check already-indexed URLs in PayAI discovery/resources
  const discRes = await fetch(`${PAYAI_FACILITATOR}/discovery/resources?limit=250`);
  const discJson: any = await discRes.json().catch(() => ({ items: [] }));
  const alreadyIndexedSolana = new Set<string>();
  for (const item of discJson.items || []) {
    const resUrl = String(item.resource || "");
    const nets = (item.accepts || []).map((a: any) => a.network);
    if (resUrl.includes("onrender.com") && nets.includes(SOLANA_CAIP2)) {
      alreadyIndexedSolana.add(resUrl);
    }
  }
  console.log(`[Discovery] Already indexed in PayAI Solana Bazaar: ${alreadyIndexedSolana.size} endpoint(s)`);

  // Get PayAI Solana feePayer
  const supRes = await fetch(`${PAYAI_FACILITATOR}/supported`);
  const sup: any = await supRes.json();
  const solMainnet = (sup.kinds || []).find((k: any) => k.network === SOLANA_CAIP2 && k.x402Version === 2);
  const feePayerPubkey = new PublicKey(solMainnet.extra.feePayer);

  const all65 = await discoverAll65Endpoints();
  console.log(`[Discovery] Discovered ${all65.length} total endpoints across the 4 services.`);

  // ============================================================================
  // PART 1A: SETTLE ALL 12 NANSEN ROUTES ON BASE MAINNET (CDP + PAYAI)
  // ============================================================================
  const nansenEndpoints = all65.filter((e) => e.path.startsWith("/api/v1/"));
  console.log(`\n=== PART 1A: Seeding ${nansenEndpoints.length} Nansen Routes on Base Mainnet (CDP + PayAI) ===`);
  const baseResults: any[] = [];

  for (let i = 0; i < nansenEndpoints.length; i++) {
    const ep = nansenEndpoints[i];
    const prevBase = (prevReport?.base_nansen_settlements || []).find((b: any) => b.url === ep.url);
    if (prevBase && prevBase.cdp_tx && prevBase.payai_base_tx) {
      console.log(`[Base ${i + 1}/${nansenEndpoints.length}] ⏭️ Already settled on CDP & PayAI: ${ep.url}`);
      baseResults.push(prevBase);
      continue;
    }

    console.log(`[Base ${i + 1}/${nansenEndpoints.length}] ${ep.service} ${ep.path} ($0.010 USDC)...`);
    try {
      let cdpTx = prevBase?.cdp_tx || "";
      let srvStatus = prevBase?.server_status || 0;
      if (!cdpTx) {
        // Fetch 402 challenge first so we match @x402/express exact requirements
        const chalRes = await fetch(ep.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ token_address: BASE_USDC, chain: "base" }),
        });
        const reqHdr = chalRes.headers.get("payment-required") || chalRes.headers.get("x-payment-required");
        let exactAcc: any = undefined;
        let exactRes: any = undefined;
        let exactExt: any = undefined;
        if (reqHdr) {
          try {
            const decoded = JSON.parse(Buffer.from(reqHdr, "base64").toString("utf8"));
            exactAcc = (decoded.accepts || []).find((a: any) => a.network === BASE_NETWORK) || decoded.accepts?.[0];
            exactRes = decoded.resource;
            exactExt = decoded.extensions;
          } catch {}
        }

        const signed1 = await signBaseEip3009Payload(
          baseAccount,
          ep.url,
          ep.description,
          ep.path,
          "10000",
          exactAcc,
          exactRes,
          exactExt
        );
        const sigHeader = Buffer.from(JSON.stringify(signed1.paymentPayload)).toString("base64");
        const srvRes = await fetch(ep.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "PAYMENT-SIGNATURE": sigHeader,
            "X-PAYMENT": sigHeader,
          },
          body: JSON.stringify({ token_address: BASE_USDC, chain: "base" }),
        });
        srvStatus = srvRes.status;
        const payResp = srvRes.headers.get("payment-response") || srvRes.headers.get("x-payment-response");
        if (payResp) {
          try {
            const rec = JSON.parse(Buffer.from(payResp, "base64").toString("utf8"));
            cdpTx = rec.transaction || rec.txHash || "";
          } catch {}
        }
      }

      let payaiTx = prevBase?.payai_base_tx || "";
      if (!payaiTx) {
        const signed2 = await signBaseEip3009Payload(baseAccount, ep.url, ep.description, ep.path, "10000");
        const payaiRes = await fetch(`${PAYAI_FACILITATOR}/settle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x402Version: 2,
            paymentPayload: signed2.paymentPayload,
            paymentRequirements: signed2.paymentRequirements,
          }),
        });
        const payaiJson: any = await payaiRes.json().catch(() => ({}));
        payaiTx = payaiJson.transaction || "";
      }

      console.log(`   ✅ Server HTTP ${srvStatus} (CDP Tx: ${cdpTx.slice(0, 14)}...) | PayAI Base Tx: ${payaiTx.slice(0, 14)}...`);
      baseResults.push({
        service: ep.service,
        path: ep.path,
        url: ep.url,
        server_status: srvStatus,
        cdp_tx: cdpTx,
        payai_base_tx: payaiTx,
      });
    } catch (e: any) {
      console.error(`   ⚠️ Base Nansen seed error on ${ep.url}: ${e.message}`);
      baseResults.push({ service: ep.service, path: ep.path, url: ep.url, error: e.message });
    }
  }

  // ============================================================================
  // PART 1B: SEED ALL 65 ENDPOINTS ON SOLANA MAINNET VIA PAYAI FACILITATOR
  // ============================================================================
  console.log(`\n=== PART 1B: Seeding All 65 Endpoints on Solana Mainnet via PayAI Facilitator ===`);
  const solanaResults: any[] = [];
  const usedBlockhashes = new Set<string>();

  async function getFreshBlockhash(): Promise<string> {
    for (let attempt = 0; attempt < 25; attempt++) {
      const latest = await solConn.getLatestBlockhash("confirmed");
      if (!usedBlockhashes.has(latest.blockhash)) {
        usedBlockhashes.add(latest.blockhash);
        return latest.blockhash;
      }
      await new Promise((r) => setTimeout(r, 450));
    }
    return (await solConn.getLatestBlockhash("finalized")).blockhash;
  }

  for (let i = 0; i < all65.length; i++) {
    const ep = all65[i];
    const prevSol = (prevReport?.solana_65_settlements || []).find((s: any) => s.url === ep.url && s.transaction);
    if (alreadyIndexedSolana.has(ep.url)) {
      console.log(`[Solana ${i + 1}/${all65.length}] ⏭️ Already indexed in PayAI Bazaar: ${ep.url}`);
      solanaResults.push({
        index: i + 1,
        service: ep.service,
        path: ep.path,
        url: ep.url,
        status: prevSol ? "settled" : "already_indexed",
        transaction: prevSol?.transaction || undefined,
      });
      continue;
    }

    const rawMicro = Number(ep.amountMicro || "10000");
    const settleMicro = BigInt(Math.min(rawMicro, 10000));
    const settleMicroStr = settleMicro.toString();

    console.log(`[Solana ${i + 1}/${all65.length}] Settling ${ep.service} ${ep.path} (${settleMicroStr} micro-USDC)...`);
    let settledOk = false;
    for (let retry = 0; retry < 3 && !settledOk; retry++) {
      try {
        if (retry > 0) {
          console.log(`   🔄 Retry ${retry}/2 for ${ep.path}...`);
          await new Promise((r) => setTimeout(r, 1500));
        }
        const blockhash = await getFreshBlockhash();
        const ixs = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 20000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          createTransferCheckedIx(buyerAta, SOLANA_USDC_MINT, merchantAta, solBuyer.publicKey, settleMicro, 6),
        ];
        const msgV0 = new TransactionMessage({
          payerKey: feePayerPubkey,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message();
        const vtx = new VersionedTransaction(msgV0);
        vtx.sign([solBuyer]);
        const txB64 = Buffer.from(vtx.serialize()).toString("base64");

        const solReq = {
          scheme: "exact",
          network: SOLANA_CAIP2,
          amount: settleMicroStr,
          asset: SOLANA_USDC_MINT.toBase58(),
          payTo: SOLANA_MERCHANT.toBase58(),
          maxTimeoutSeconds: 300,
          extra: {
            name: "USD Coin (Solana)",
            version: "2",
            feePayer: feePayerPubkey.toBase58(),
          },
        };

        const payaiBody = {
          x402Version: 2,
          paymentPayload: {
            x402Version: 2,
            resource: {
              url: ep.url,
              description: ep.description,
              mimeType: "application/json",
            },
            extensions: buildBazaarExtension(ep.path, ep.description),
            accepted: solReq,
            payload: { transaction: txB64 },
          },
          paymentRequirements: solReq,
        };

        const sRes = await fetch(`${PAYAI_FACILITATOR}/settle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payaiBody),
        });
        const sJson: any = await sRes.json().catch(() => ({}));
        if (sRes.ok && sJson.success) {
          console.log(`   ✅ Solana Settled! Tx: https://solscan.io/tx/${sJson.transaction}`);
          solanaResults.push({
            index: i + 1,
            service: ep.service,
            path: ep.path,
            url: ep.url,
            amount_micro: settleMicroStr,
            status: "settled",
            transaction: sJson.transaction,
          });
          settledOk = true;
        } else if (retry === 2) {
          console.error(`   ⚠️ Solana settle rejected (${sRes.status}): ${JSON.stringify(sJson)}`);
          solanaResults.push({
            index: i + 1,
            service: ep.service,
            path: ep.path,
            url: ep.url,
            status: "failed",
            error: sJson,
          });
        }
      } catch (err: any) {
        if (retry === 2) {
          console.error(`   ⚠️ Solana error on ${ep.url}: ${err.message}`);
          solanaResults.push({
            index: i + 1,
            service: ep.service,
            path: ep.path,
            url: ep.url,
            status: "error",
            error: err.message,
          });
        }
      }
    }
  }

  // ============================================================================
  // PART 1C: VERIFY PAYAI BAZAAR CATALOG & FINAL DUAL-CHAIN BALANCES
  // ============================================================================
  const finalDiscRes = await fetch(`${PAYAI_FACILITATOR}/discovery/resources?limit=250`);
  const finalDiscJson: any = await finalDiscRes.json().catch(() => ({ items: [] }));
  const ourIndexed = (finalDiscJson.items || []).filter((item: any) =>
    String(item.resource || "").includes("onrender.com")
  );

  const finalSolBuyerUsdc = (await getSolanaUsdcMicro(solConn, solBuyer.publicKey)) / 1e6;
  const finalSolMerchantUsdc = (await getSolanaUsdcMicro(solConn, SOLANA_MERCHANT)) / 1e6;
  const finalBaseBuyerUsdc = await getBaseUsdc(baseAccount.address);
  const finalBaseMerchantUsdc = await getBaseUsdc(BASE_MERCHANT);

  console.log("\n====================================================================");
  console.log("FINAL DUAL-CHAIN BAZAAR & WALLET AUDIT SUMMARY");
  console.log("====================================================================");
  console.log(`PayAI Bazaar Indexed Endpoints (onrender.com): ${ourIndexed.length}`);
  console.log(`Solana Buyer (${solBuyer.publicKey.toBase58()}): ${finalSolBuyerUsdc.toFixed(6)} USDC`);
  console.log(`Solana Merchant (${SOLANA_MERCHANT.toBase58()}): ${finalSolMerchantUsdc.toFixed(6)} USDC`);
  console.log(`Base Buyer (${baseAccount.address}): ${finalBaseBuyerUsdc.toFixed(6)} USDC`);
  console.log(`Base Merchant (${BASE_MERCHANT}): ${finalBaseMerchantUsdc.toFixed(6)} USDC`);

  const report = {
    timestamp: new Date().toISOString(),
    payai_bazaar_indexed_count: ourIndexed.length,
    payai_bazaar_indexed_urls: ourIndexed.map((i: any) => i.resource),
    wallets: {
      solana_buyer: { address: solBuyer.publicKey.toBase58(), initial_usdc: initSolBuyerUsdc, final_usdc: finalSolBuyerUsdc },
      solana_merchant: { address: SOLANA_MERCHANT.toBase58(), initial_usdc: initSolMerchantUsdc, final_usdc: finalSolMerchantUsdc },
      base_buyer: { address: baseAccount.address, initial_usdc: initBaseBuyerUsdc, final_usdc: finalBaseBuyerUsdc },
      base_merchant: { address: BASE_MERCHANT, initial_usdc: initBaseMerchantUsdc, final_usdc: finalBaseMerchantUsdc },
    },
    base_nansen_settlements: baseResults,
    solana_65_settlements: solanaResults,
  };

  fs.writeFileSync(
    path.resolve(process.cwd(), "scripts/full_65_bazaar_settlement_report.json"),
    JSON.stringify(report, null, 2)
  );
  console.log("Saved full report to scripts/full_65_bazaar_settlement_report.json");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
