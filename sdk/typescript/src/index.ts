/**
 * RugShield 402 - Official TypeScript / Node SDK
 *
 * Real-time token honeypot detection, buy/sell tax simulation,
 * and DEX LP lock verification for autonomous trading bots and AI agents.
 * 0.010 - 0.020 USDC per call on Base (eip155:8453) via x402.
 */

import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

export interface ScanResult {
  status: "success" | "warning" | "danger" | "error";
  token_address: string;
  symbol?: string;
  is_honeypot: boolean;
  buy_tax_bps: number;
  sell_tax_bps: number;
  simulation_status: string;
  liquidity_usd?: number;
  warnings?: string[];
  lp_locked_pct?: number;
}

export interface LiquidityLockResult {
  status: string;
  token_address: string;
  lp_locked_pct: number;
  lock_platform: string;
  unlock_timestamp: number;
  is_rug_proof: boolean;
}

export interface HolderClusterResult {
  status: string;
  token_address: string;
  top_10_holders_pct: number;
  clusters_detected: number;
  sybil_risk_score: number;
  verdict: string;
}

export interface SwapSimulationResult {
  status: string;
  token_address: string;
  swap_sizes_tested: number[];
  max_slippage_bps: number;
  sandwich_vulnerable: boolean;
  simulation_proof_hash: string;
}

export interface InstitutionalReportResult {
  status: string;
  token_address: string;
  composite_score: number;
  risk_rating: string;
  vectors_checked: string[];
  verdict: string;
}

export class RugShieldClient {
  private baseUrl: string;
  private payingFetch: typeof fetch;

  constructor(options?: {
    baseUrl?: string;
    privateKey?: `0x${string}`;
    customFetch?: typeof fetch;
  }) {
    this.baseUrl = (options?.baseUrl ?? "https://rugshield-402.onrender.com").replace(/\/$/, "");

    if (options?.privateKey) {
      const account = privateKeyToAccount(options.privateKey);
      const client = new x402Client();
      client.register("eip155:8453", new ExactEvmScheme(account));

      // Enforce client-side safety guardrails before signing payments
      const expectedMerchant = "0x73279fa4bada7cac888c62cda4f5c8104765f6f1";
      const baseUsdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
      const maxPerCallMicroUsdc = 25000n; // 0.025 USDC maximum per call

      client.onBeforePaymentCreation(async (context) => {
        const req = context.selectedRequirements;
        if (req.network !== "eip155:8453") {
          throw new Error(`Rejected network ${req.network}: Base mainnet required`);
        }
        if (req.asset.toLowerCase() !== baseUsdc) {
          throw new Error(`Rejected asset ${req.asset}: Base USDC required`);
        }
        if (req.payTo.toLowerCase() !== expectedMerchant) {
          throw new Error(`Rejected payTo ${req.payTo}: Unauthorized merchant recipient`);
        }
        if (BigInt(req.amount) > maxPerCallMicroUsdc) {
          throw new Error(`Amount ${req.amount} exceeds max per-call cap of ${maxPerCallMicroUsdc}`);
        }
      });

      this.payingFetch = wrapFetchWithPayment(options.customFetch ?? fetch, client);
    } else {
      this.payingFetch = options?.customFetch ?? fetch;
    }
  }

  /**
   * Free evaluation preview without wallet or x402 payment header.
   */
  async scanPreview(tokenAddress: string, chainId: number = 8453): Promise<ScanResult> {
    const res = await fetch(`${this.baseUrl}/v1/scan/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: tokenAddress, chain_id: chainId, simulate_sell: true }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`RugShield Preview HTTP ${res.status}: ${errText}`);
    }

    return (await res.json()) as ScanResult;
  }

  /**
   * Paid real-time swap simulation and honeypot detection (0.010 USDC).
   */
  async scanToken(
    tokenAddress: string,
    options?: { chainId?: number; simulateSell?: boolean }
  ): Promise<ScanResult> {
    const res = await this.payingFetch(`${this.baseUrl}/v1/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_address: tokenAddress,
        chain_id: options?.chainId ?? 8453,
        simulate_sell: options?.simulateSell ?? true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`RugShield Scan HTTP ${res.status}: ${errText}`);
    }

    return (await res.json()) as ScanResult;
  }

  /**
   * Boolean pre-swap guardrail for autonomous trading loops.
   * Returns true only if not a honeypot and sell tax < 10% (1000 bps).
   */
  async isSafeToSwap(tokenAddress: string): Promise<boolean> {
    try {
      const res = await this.scanPreview(tokenAddress);
      return !res.is_honeypot && res.sell_tax_bps < 1000;
    } catch {
      return false;
    }
  }

  /**
   * Verify DEX LP token locking on Aerodrome / Uncx / Team.Finance (0.020 USDC).
   */
  async auditLiquidityLock(tokenAddress: string): Promise<LiquidityLockResult> {
    const res = await this.payingFetch(`${this.baseUrl}/v1/audit/liquidity-lock-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: tokenAddress }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`RugShield LP Lock HTTP ${res.status}: ${errText}`);
    }

    return (await res.json()) as LiquidityLockResult;
  }

  /**
   * Scan top 50 token holders for sybil rings and coordinated dev dumps (0.020 USDC).
   */
  async holderClusterMap(tokenAddress: string): Promise<HolderClusterResult> {
    const res = await this.payingFetch(`${this.baseUrl}/v1/audit/holder-cluster-map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: tokenAddress }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`RugShield Cluster Map HTTP ${res.status}: ${errText}`);
    }

    return (await res.json()) as HolderClusterResult;
  }

  /**
   * State-override swap simulation proving slippage, price impact, and frontrunning (0.020 USDC).
   */
  async swapSimulationProof(tokenAddress: string, amountUsd: number = 10000): Promise<SwapSimulationResult> {
    const res = await this.payingFetch(`${this.baseUrl}/v1/audit/swap-simulation-proof`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: tokenAddress, amount_usd: amountUsd }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`RugShield Swap Proof HTTP ${res.status}: ${errText}`);
    }

    return (await res.json()) as SwapSimulationResult;
  }

  /**
   * Full 7-vector institutional risk audit dossier (0.020 USDC).
   */
  async institutionalTokenReport(tokenAddress: string): Promise<InstitutionalReportResult> {
    const res = await this.payingFetch(`${this.baseUrl}/v1/risk/institutional-token-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token_address: tokenAddress }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`RugShield Institutional Report HTTP ${res.status}: ${errText}`);
    }

    return (await res.json()) as InstitutionalReportResult;
  }

  async health(): Promise<{ status: string; service: string; chain_id: number }> {
    const res = await fetch(`${this.baseUrl}/health`);
    return await res.json();
  }
}
