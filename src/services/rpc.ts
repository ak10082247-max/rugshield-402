import { createPublicClient, fallback, http } from "viem";
import { base } from "viem/chains";
import { CONFIG } from "../config.js";

let currentIndex = 0;

export function getNextRpcUrl(): string {
  const url = CONFIG.rpcEndpoints[currentIndex % CONFIG.rpcEndpoints.length];
  currentIndex++;
  return url;
}

export function createFailoverPublicClient() {
  const transports = CONFIG.rpcEndpoints.map((url) =>
    http(url, {
      timeout: 10_000,
      retryCount: 2,
      retryDelay: 500,
    })
  );

  return createPublicClient({
    chain: base,
    transport: fallback(transports, {
      rank: false,
      retryCount: 3,
    }),
  });
}

export const publicClient = createFailoverPublicClient();
