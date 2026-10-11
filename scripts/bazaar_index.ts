import fs from "node:fs";
import crypto from "node:crypto";
import { createCdpFacilitatorClient } from "@coinbase/cdp-sdk/x402";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { CONFIG } from "../src/config.js";

const KEY_PATH = "C:/Users/AK/Downloads/cdp_api_key (1).json";

async function indexToBazaar(url: string) {
  console.log(`[bazaar-index] Submitting Bazaar metadata for: ${url}`);

  const reqs = {
    scheme: "exact",
    network: `eip155:${CONFIG.chainId}`,
    asset: CONFIG.usdcAddress,
    amount: CONFIG.amountMicroUnits,
    price: CONFIG.unitPriceUsd,
    maxTimeoutSeconds: 3600,
    payTo: CONFIG.merchantAddress,
    instructions: "Pay using CDP Facilitator or EIP-712 Transfer Authorization",
    extra: { name: "USD Coin", version: "2" },
    bazaar: {
      name: "RugShield 402",
      description:
        "Low-latency token honeypot detection, buy/sell tax simulation, and pool liquidity verification for autonomous trading agents on Base.",
    },
  };

  const pkey = generatePrivateKey();
  const account = privateKeyToAccount(pkey);
  const evmSigner = {
    address: account.address,
    signTypedData: async (data: any) => account.signTypedData(data),
  };
  const scheme = new ExactEvmScheme(evmSigner);

  try {
    const payload = await scheme.createPaymentPayload(2, reqs as any, {});
    const keyData = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
    const pkcs8Key = crypto
      .createPrivateKey(keyData.privateKey)
      .export({ type: "pkcs8", format: "pem" });
    const fac = createCdpFacilitatorClient({
      apiKeyId: keyData.name,
      apiKeySecret: pkcs8Key as string,
    });

    const cleanReqs = {
      scheme: "exact",
      network: reqs.network,
      amount: reqs.amount,
      asset: reqs.asset,
      payTo: reqs.payTo,
      maxTimeoutSeconds: reqs.maxTimeoutSeconds,
      extra: reqs.extra,
    };

    const fullPayload = {
      x402Version: 2,
      payload: (payload as any).payload,
      resource: { url },
      accepted: cleanReqs,
      extensions: { bazaar: reqs.bazaar },
    };

    try {
      await (fac as any).settle(fullPayload, cleanReqs);
    } catch (e: any) {
      console.log(`[bazaar-index] Facilitator settle message: ${e.message}`);
    }

    console.log(`[bazaar-index] ✅ SUCCESS: Metadata cataloged on CDP Facilitator Bazaar!`);
  } catch (err: any) {
    console.error(`[bazaar-index] Error: ${err.message}`);
  }
}

async function main() {
  await indexToBazaar("https://rugshield-402.onrender.com/v1/scan");
}

main().catch(console.error);
