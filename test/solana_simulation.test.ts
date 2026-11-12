import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SOLANA_GENESIS_HASH,
  SOLANA_USDC_MINT,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  WSOL_MINT,
  simulateSolanaToken,
} from "../src/services/solana_swap_simulation.js";
import { SolanaScanError } from "../src/services/solana_scan.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const TOKEN2022_TAX = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeRpc(
  opts: {
    owner?: string;
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
    extensions?: any[];
    epoch?: number;
  } = {},
) {
  return async (method: string) => {
    if (method === "getGenesisHash") return { result: SOLANA_GENESIS_HASH, provider: "https://rpc.test" };
    if (method === "getEpochInfo") return { result: { epoch: opts.epoch ?? 610 }, provider: "https://rpc.test" };
    if (method === "getTokenSupply") return { result: { context: { slot: 900 }, value: { amount: "100000000000" } }, provider: "https://rpc.test" };
    if (method === "getAccountInfo") {
      return {
        provider: "https://rpc.test",
        result: {
          context: { slot: 900 },
          value: {
            owner: opts.owner ?? SPL_TOKEN_PROGRAM,
            data: {
              parsed: {
                type: "mint",
                info: {
                  decimals: 5,
                  supply: "100000000000",
                  isInitialized: true,
                  mintAuthority: opts.mintAuthority ?? null,
                  freezeAuthority: opts.freezeAuthority ?? null,
                  ...(opts.extensions ? { extensions: opts.extensions } : {}),
                },
              },
            },
          },
        },
      };
    }
    return { result: { context: { slot: 900 }, value: [] }, provider: "https://rpc.test" };
  };
}

test("Solana simulation passes cleanly for liquid SPL token with Jupiter round-trip quote", async () => {
  const res = await simulateSolanaToken(
    BONK,
    { includeMultiTier: true },
    {
      rpcQuery: makeRpc() as any,
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("dexscreener.com")) {
          return json({
            pairs: [
              { chainId: "solana", pairAddress: "pool1", dexId: "whirlpool", baseToken: { address: BONK, symbol: "BONK", name: "Bonk" }, liquidity: { usd: 5000000 } },
            ],
          });
        }
        if (url.includes("lite-api.jup.ag/swap/v1/quote")) {
          const parsed = new URL(url);
          const inMint = parsed.searchParams.get("inputMint");
          const amt = BigInt(parsed.searchParams.get("amount") || "0");
          if (inMint === WSOL_MINT) {
            return json({
              outAmount: (amt * 3000n).toString(),
              priceImpactPct: "0.001",
              routePlan: [{ swapInfo: { label: "Whirlpool", feeAmount: "1000", inAmount: amt.toString() } }],
            });
          }
          return json({
            outAmount: ((amt / 3000n) * 9998n / 10000n).toString(),
            priceImpactPct: "0.001",
            routePlan: [{ swapInfo: { label: "Whirlpool", feeAmount: "1000", inAmount: amt.toString() } }],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }) as any,
    },
  );

  assert.equal(res.status, "success");
  assert.equal(res.simulation_status, "passed");
  assert.equal(res.is_honeypot, false);
  assert.equal(res.buy_tax_bps, 0);
  assert.equal(res.sell_tax_bps, 0);
  assert.equal(res.recommendation, "SELL_EXECUTED_IN_SCOPED_SIMULATION");
  assert.equal(res.verdict, "SELL_EXECUTED_IN_SCOPED_SIMULATION");
  assert.equal(res.risk_factors.includes("BUY_SELL_EXECUTION_NOT_SIMULATED"), false);
  assert.equal(res.swap_tiers.length, 3);
  assert.equal(res.evidence.token_program.program, "spl-token");
  assert.equal(res.evidence.simulation.buy_leg.provider, "Jupiter");
  assert.equal(res.evidence.simulation.sell_leg.provider, "Jupiter");
});

test("Solana simulation detects Token-2022 epoch-active transfer tax, transferHook, and permanentDelegate", async () => {
  const res = await simulateSolanaToken(
    TOKEN2022_TAX,
    {},
    {
      rpcQuery: makeRpc({
        owner: TOKEN_2022_PROGRAM,
        epoch: 610,
        extensions: [
          {
            extension: "transferFeeConfig",
            state: {
              olderTransferFee: { epoch: 500, maximumFee: 0, transferFeeBasisPoints: 100 },
              newerTransferFee: { epoch: 605, maximumFee: 5000000, transferFeeBasisPoints: 500 },
            },
          },
          { extension: "transferHook", state: { programId: "Hook111111111111111111111111111111111111111" } },
          { extension: "permanentDelegate", state: { delegate: "Dele111111111111111111111111111111111111111" } },
        ],
      }) as any,
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("dexscreener.com")) return json({ pairs: [] });
        if (url.includes("lite-api.jup.ag")) return json({ errorCode: "RATE_LIMIT" }, 429);
        if (url.includes("raydium.io/compute/swap-base-in")) {
          const parsed = new URL(url);
          const inMint = parsed.searchParams.get("inputMint");
          const amt = BigInt(parsed.searchParams.get("amount") || "0");
          if (inMint === WSOL_MINT) {
            return json({ success: true, data: { outputAmount: "100000", priceImpactPct: 0.05, routePlan: [{ feeRate: 25 }] } });
          }
          // 5% tax each way -> ~90% return
          return json({ success: true, data: { outputAmount: ((amt * 90000n) / 1000n).toString(), priceImpactPct: 0.05, routePlan: [{ feeRate: 25 }] } });
        }
        return json({}, 500);
      }) as any,
    },
  );

  assert.equal(res.simulation_status, "passed");
  assert.equal(res.buy_tax_bps, 500);
  assert.equal(res.sell_tax_bps, 500);
  assert.equal(res.is_honeypot, false);
  assert.equal(res.recommendation, "CAUTION_HIGH_RISK_TOKEN_2022_OR_SPREAD");
  assert.ok(res.risk_factors.includes("TOKEN_2022_TRANSFER_FEE_PRESENT"));
  assert.ok(res.risk_factors.includes("CUSTOM_TRANSFER_HOOK_PROGRAM"));
  assert.ok(res.risk_factors.includes("PERMANENT_DELEGATE_ENABLED"));
  assert.equal(res.evidence.simulation.buy_leg.provider, "Raydium");
});

test("Solana simulation flags Token-2022 nonTransferable, frozen default state, and asymmetric buy-only honeypots", async () => {
  const nonTransferable = await simulateSolanaToken(
    TOKEN2022_TAX,
    {},
    {
      rpcQuery: makeRpc({ owner: TOKEN_2022_PROGRAM, extensions: [{ extension: "nonTransferable", state: {} }] }) as any,
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).includes("dexscreener")) return json({ pairs: [] });
        return json({ errorCode: "TOKEN_NOT_TRADABLE" }, 400);
      }) as any,
    },
  );
  assert.equal(nonTransferable.simulation_status, "passed");
  assert.equal(nonTransferable.is_honeypot, true);
  assert.ok(nonTransferable.risk_factors.includes("NON_TRANSFERABLE_TOKEN"));

  const asymmetric = await simulateSolanaToken(
    BONK,
    {},
    {
      rpcQuery: makeRpc() as any,
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("dexscreener")) return json({ pairs: [] });
        if (url.includes("lite-api.jup.ag")) {
          const parsed = new URL(url);
          if (parsed.searchParams.get("inputMint") === WSOL_MINT) {
            return json({ outAmount: "50000000", priceImpactPct: "0.1", routePlan: [{ swapInfo: { label: "Pump" } }] });
          }
          return json({ errorCode: "NO_ROUTES_FOUND" }, 400);
        }
        if (url.includes("raydium.io")) {
          const parsed = new URL(url);
          if (parsed.searchParams.get("inputMint") === WSOL_MINT) {
            return json({ success: true, data: { outputAmount: "50000000", priceImpactPct: 0.1, routePlan: [] } });
          }
          return json({ success: false, msg: "ROUTE_NOT_FOUND" }, 200);
        }
        return json({}, 500);
      }) as any,
    },
  );
  assert.equal(asymmetric.simulation_status, "passed");
  assert.equal(asymmetric.is_honeypot, true);
  assert.ok(asymmetric.risk_factors.includes("ASYMMETRIC_BUY_ONLY_NO_SELL_ROUTE"));
});

test("Solana simulation fails closed when all DEX quote providers fail, never blaming the token", async () => {
  await assert.rejects(
    simulateSolanaToken(
      SOLANA_USDC_MINT,
      {},
      {
        rpcQuery: makeRpc() as any,
        fetch: (async (input: RequestInfo | URL) => {
          if (String(input).includes("dexscreener")) return json({ pairs: [] });
          return json({ errorCode: "RATE_LIMIT" }, 429);
        }) as any,
      },
    ),
    (err: unknown) => err instanceof SolanaScanError && err.code === "SIMULATION_PROVIDER_UNAVAILABLE" && err.httpStatus === 503,
  );
});

test("HTTP /health advertises Solana simulation capability cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rug-sol-cap-"));
  process.env.RUGSHIELD_NO_LISTEN = "1";
  process.env.RUGSHIELD_DISABLE_DELIVERY_LOGGING = "1";
  process.env.DOTENV_CONFIG_PATH = join(dir, "empty.env");
  writeFileSync(process.env.DOTENV_CONFIG_PATH, "");
  try {
    const { default: service } = await import("../src/index.js");
    const res = await service.request("http://localhost/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(typeof body.capabilities.solana_swap_simulation === "string" && body.capabilities.solana_swap_simulation.length > 0);
    assert.equal(body.capabilities.specialized_full_analyses, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP Solana /v1/scan/preview, paid /v1/scan simulation, 402 proof challenge, and 503 honest gap work end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rug-sol-http-"));
  process.env.RUGSHIELD_NO_LISTEN = "1";
  process.env.RUGSHIELD_DISABLE_DELIVERY_LOGGING = "1";
  process.env.DOTENV_CONFIG_PATH = join(dir, "empty.env");
  writeFileSync(process.env.DOTENV_CONFIG_PATH, "");
  const { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import("@solana/web3.js");
  const buyer = Keypair.generate();
  const mockSig = "2".repeat(88);
  let settleCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("solana.com") || url.includes("publicnode.com")) {
      const body = JSON.parse(String(init?.body || "{}"));
      const id = body.id ?? 1;
      if (body.method === "getGenesisHash") return json({ jsonrpc: "2.0", id, result: SOLANA_GENESIS_HASH });
      if (body.method === "getEpochInfo") return json({ jsonrpc: "2.0", id, result: { epoch: 610 } });
      if (body.method === "getTokenSupply") return json({ jsonrpc: "2.0", id, result: { context: { slot: 900 }, value: { amount: "100000000000" } } });
      if (body.method === "getAccountInfo") {
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            context: { slot: 900 },
            value: {
              owner: SPL_TOKEN_PROGRAM,
              data: { parsed: { type: "mint", info: { decimals: 5, supply: "100000000000", isInitialized: true, mintAuthority: null, freezeAuthority: null } } },
            },
          },
        });
      }
      return json({ jsonrpc: "2.0", id, result: { context: { slot: 900 }, value: [] } });
    }
    if (url.includes("dexscreener.com")) {
      return json({ pairs: [{ chainId: "solana", pairAddress: "pool1", dexId: "whirlpool", baseToken: { address: BONK, symbol: "BONK", name: "Bonk" }, liquidity: { usd: 5000000 } }] });
    }
    if (url.includes("lite-api.jup.ag/swap/v1/quote")) {
      const parsed = new URL(url);
      const inMint = parsed.searchParams.get("inputMint");
      const amt = BigInt(parsed.searchParams.get("amount") || "0");
      if (inMint === WSOL_MINT) {
        return json({ outAmount: (amt * 3000n).toString(), priceImpactPct: "0.001", routePlan: [{ swapInfo: { label: "Whirlpool", feeAmount: "1000", inAmount: amt.toString() } }] });
      }
      return json({ outAmount: (amt / 3000n).toString(), priceImpactPct: "0.001", routePlan: [{ swapInfo: { label: "Whirlpool", feeAmount: "1000", inAmount: amt.toString() } }] });
    }
    if (url === "https://facilitator.payai.network/verify") {
      return json({ isValid: true, payer: buyer.publicKey.toBase58() });
    }
    if (url === "https://facilitator.payai.network/settle") {
      settleCount++;
      return json({ success: true, payer: buyer.publicKey.toBase58(), transaction: mockSig, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    }
    return json({ error: "unexpected_url", url }, 500);
  }) as typeof fetch;

  try {
    const { default: service } = await import("../src/index.js");
    const previewRes = await service.request(`http://localhost/v1/scan/preview?token=${BONK}&chain=solana`);
    assert.equal(previewRes.status, 200);
    const previewBody = (await previewRes.json()) as any;
    assert.equal(previewBody.chain, "solana");
    assert.equal(previewBody.mint_authority_revoked, true);

    const scanChallenge = await service.request("http://localhost/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: BONK, chain: "solana" }),
    });
    assert.equal(scanChallenge.status, 402);
    const pr = JSON.parse(Buffer.from(scanChallenge.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8"));
    const solAccept = pr.accepts.find((a: any) => String(a.network).startsWith("solana:"));
    assert.ok(solAccept);

    const tokenProg = new PublicKey(SPL_TOKEN_PROGRAM);
    const usdcMint = new PublicKey(SOLANA_USDC_MINT);
    const [buyerAta] = PublicKey.findProgramAddressSync(
      [buyer.publicKey.toBuffer(), tokenProg.toBuffer(), usdcMint.toBuffer()],
      new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    );
    const destAta = new PublicKey(solAccept.extra?.recipientAta || "DD3A7jaXFeHcif9eYj6Vhomuxypat5Yxi8ow6wxz27yL");
    const amtBuf = Buffer.alloc(10);
    amtBuf.writeUInt8(12, 0);
    amtBuf.writeBigUInt64LE(BigInt(solAccept.amount), 1);
    amtBuf.writeUInt8(6, 9);
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: new PublicKey(solAccept.extra.feePayer),
        recentBlockhash: "11111111111111111111111111111111",
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 20000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          new TransactionInstruction({
            programId: tokenProg,
            keys: [
              { pubkey: buyerAta, isSigner: false, isWritable: true },
              { pubkey: usdcMint, isSigner: false, isWritable: false },
              { pubkey: destAta, isSigner: false, isWritable: true },
              { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
            ],
            data: amtBuf,
          }),
        ],
      }).compileToV0Message(),
    );
    tx.sign([buyer]);
    const sigHeader = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: pr.resource,
        accepted: solAccept,
        payload: { transaction: Buffer.from(tx.serialize()).toString("base64") },
        extensions: pr.extensions,
      }),
    ).toString("base64");

    const paidScan = await service.request("http://localhost/v1/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": sigHeader },
      body: JSON.stringify({ token_address: BONK, chain: "solana" }),
    });
    assert.equal(paidScan.status, 200);
    assert.ok(paidScan.headers.get("PAYMENT-RESPONSE"));
    const paidBody = (await paidScan.json()) as any;
    assert.equal(paidBody.chain, "solana");
    assert.equal(paidBody.simulation_status, "passed");
    assert.equal(paidBody.is_honeypot, false);
    assert.equal(paidBody.evidence.simulation.buy_leg.provider, "Jupiter");

    const proofChallenge = await service.request("http://localhost/v1/audit/swap-simulation-proof", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: BONK, chain: "solana" }),
    });
    assert.equal(proofChallenge.status, 402);
    const decodedProof = JSON.parse(Buffer.from(proofChallenge.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8"));
    assert.ok(decodedProof.accepts.some((a: any) => String(a.network).startsWith("solana:")));

    const instChallenge = await service.request("http://localhost/v1/risk/institutional-token-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: BONK, chain: "solana" }),
    });
    assert.equal(instChallenge.status, 402);
    const instPr = JSON.parse(Buffer.from(instChallenge.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8"));
    const instSol = instPr.accepts.find((a: any) => String(a.network).startsWith("solana:"));
    assert.ok(instSol);
    const instBuf = Buffer.alloc(10);
    instBuf.writeUInt8(12, 0);
    instBuf.writeBigUInt64LE(BigInt(instSol.amount), 1);
    instBuf.writeUInt8(6, 9);
    const instTx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: new PublicKey(instSol.extra.feePayer),
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 20000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          new TransactionInstruction({
            programId: tokenProg,
            keys: [
              { pubkey: buyerAta, isSigner: false, isWritable: true },
              { pubkey: usdcMint, isSigner: false, isWritable: false },
              { pubkey: destAta, isSigner: false, isWritable: true },
              { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
            ],
            data: instBuf,
          }),
        ],
      }).compileToV0Message(),
    );
    instTx.sign([buyer]);
    const instHeader = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        resource: instPr.resource,
        accepted: instSol,
        payload: { transaction: Buffer.from(instTx.serialize()).toString("base64") },
        extensions: instPr.extensions,
      }),
    ).toString("base64");

    const instRes = await service.request("http://localhost/v1/risk/institutional-token-report", {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": instHeader },
      body: JSON.stringify({ token_address: BONK, chain: "solana" }),
    });
    assert.equal(instRes.status, 503);
    assert.equal(instRes.headers.get("PAYMENT-RESPONSE"), null);
    assert.equal(settleCount, 1);
    const instBody = (await instRes.json()) as any;
    assert.equal(instBody.error, "ANALYSIS_UNAVAILABLE");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
