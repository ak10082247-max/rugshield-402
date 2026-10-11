import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import {
  createWalletClient,
  createPublicClient,
  http,
  erc20Abi,
  parseAbi,
  getAddress,
  encodeAbiParameters,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { randomBytes } from "node:crypto";
import { CONFIG } from "../src/config.js";

async function main() {
  const targetHost = (
    process.argv[2] ||
    process.env.TARGET_URL ||
    `http://localhost:${CONFIG.port}`
  ).replace(/\/$/, "");

  console.log(`\n======================================================`);
  console.log(`RUGSHIELD 402 - SEEDING SETTLEMENT VERIFICATION`);
  console.log(`Target Host: ${targetHost}`);
  console.log(`Chain: Base Mainnet (${CONFIG.chainId})`);
  console.log(`======================================================\n`);

  const privateKey = (process.env.WALLET_B_PRIVATE_KEY ||
    process.env.BUYER_PRIVATE_KEY) as `0x${string}`;

  if (!privateKey) {
    throw new Error(
      "Missing Wallet B private key in .env.local (WALLET_B_PRIVATE_KEY)"
    );
  }

  const account = privateKeyToAccount(privateKey);
  console.log(`[seed] Payer Account (Wallet B): ${account.address}`);
  console.log(`[seed] Merchant (Wallet A):      ${CONFIG.merchantAddress}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(CONFIG.rpcEndpoints[0]),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(CONFIG.rpcEndpoints[0]),
  });

  // Verify USDC balance
  const usdcBalance = await publicClient.readContract({
    address: CONFIG.usdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(
    `[seed] Wallet B USDC Balance: ${Number(usdcBalance) / 1e6} USDC`
  );

  const scanUrl = `${targetHost}/v1/scan`;
  const testPayload = {
    token_address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", // DEGEN on Base
    chain_id: 8453,
    simulate_sell: true,
  };

  // Step 1: Send unauthenticated request to trigger HTTP 402
  console.log(`\nStep 1: Probing ${scanUrl} (Expecting HTTP 402)...`);
  const initialRes = await fetch(scanUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(testPayload),
  });

  console.log(`[seed] Response Status: ${initialRes.status} Payment Required`);
  if (initialRes.status !== 402) {
    throw new Error(`Expected HTTP 402, received ${initialRes.status}`);
  }

  const challengeHeader = initialRes.headers.get("www-authenticate");
  console.log(`[seed] WWW-Authenticate: ${challengeHeader}`);
  const challengeBody = await initialRes.json();
  console.log(`[seed] Challenge Details:`, JSON.stringify(challengeBody, null, 2));

  // Step 2: Construct & Sign EIP-712 Transfer Authorization for 0.005 USDC
  console.log(`\nStep 2: Constructing EIP-712 Transfer Authorization for 5000 micro-units (0.005 USDC)...`);
  const nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour validity
  const amount = BigInt(CONFIG.amountMicroUnits); // 5000 micro-units

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: CONFIG.chainId,
    verifyingContract: CONFIG.usdcAddress,
  };

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    from: account.address,
    to: getAddress(CONFIG.merchantAddress),
    value: amount,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await walletClient.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  console.log(`[seed] EIP-712 Signature Generated: ${signature.slice(0, 20)}...`);

  // Step 3: Broadcast On-Chain Settlement to Base Mainnet
  console.log(`\nStep 3: Broadcasting on-chain settlement to Base Mainnet...`);
  let onChainTxHash = "";
  try {
    // Settle 0.005 USDC directly from Wallet B to Wallet A on Base
    const tx = await walletClient.writeContract({
      address: CONFIG.usdcAddress,
      abi: erc20Abi,
      functionName: "transfer",
      args: [getAddress(CONFIG.merchantAddress), amount],
    });
    onChainTxHash = tx;
    console.log(`[seed] Transaction Broadcasted: ${tx}`);
    console.log(`[seed] Waiting for on-chain block confirmation...`);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: tx,
      timeout: 30_000,
    });
    console.log(
      `[seed] ✅ Confirmed in Block #${receipt.blockNumber} (Status: ${receipt.status})`
    );
    console.log(`[seed] BaseScan URL: https://basescan.org/tx/${tx}`);
  } catch (err: any) {
    console.warn(`[seed] Note on direct contract broadcast: ${err.message}`);
  }

  // Step 4: Resend request with X-PAYMENT header
  console.log(`\nStep 4: Submitting paid request to RugShield with X-PAYMENT header...`);
  const paymentPayload = {
    x402_version: "1.0",
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: CONFIG.merchantAddress,
        value: amount.toString(),
        validAfter: Number(validAfter),
        validBefore: Number(validBefore),
        nonce,
      },
    },
    transactionHash: onChainTxHash || undefined,
  };

  const paidRes = await fetch(scanUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PAYMENT": JSON.stringify(paymentPayload),
    },
    body: JSON.stringify(testPayload),
  });

  console.log(`[seed] Paid Response HTTP Status: ${paidRes.status} OK`);
  const report = await paidRes.json();
  console.log(`\n================== RUGSHIELD AUDIT REPORT ==================`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`============================================================\n`);

  if (paidRes.status !== 200 || !report.token) {
    throw new Error(`Failed to receive verified audit report: status ${paidRes.status}`);
  }

  console.log(`\n✨ SEEDING SETTLEMENT COMPLETE!`);
  console.log(`Wallet A (Merchant):  ${CONFIG.merchantAddress}`);
  console.log(`Wallet B (Payer):     ${account.address}`);
  if (onChainTxHash) {
    console.log(`Settlement TX Hash:   ${onChainTxHash}`);
    console.log(`BaseScan Explorer:    https://basescan.org/tx/${onChainTxHash}`);
  }
}

main().catch((e) => {
  console.error("\n❌ Seeding failed:", e);
  process.exit(1);
});
