export interface EndpointPriceSpec {
  path: string;
  amountMicroUnits: string;
  priceUsd: string;
  summary: string;
  description: string;
  exampleInput: Record<string, any>;
  outputExample: Record<string, any>;
}

export const ENDPOINT_SPECS: EndpointPriceSpec[] = [
  {
    path: "/v1/scan",
    amountMicroUnits: "10000",
    priceUsd: "0.010",
    summary: "Simulate DEX swap and verify honeypot / tax safety",
    description: "Simulates buy/sell orders via state overrides to detect honeypots, compute exact transfer taxes in bps, and verify pool liquidity depth.",
    exampleInput: { token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain_id: 8453, simulate_sell: true },
    outputExample: {
      status: "success",
      token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      is_honeypot: false,
      buy_tax_bps: 0,
      sell_tax_bps: 0,
      simulation_status: "passed",
      liquidity_usd: 450000000,
    },
  },
  {
    path: "/v1/audit/liquidity-lock-verify",
    amountMicroUnits: "20000",
    priceUsd: "0.020",
    summary: "Verify DEX LP token locking, vesting schedules, and unwrap risks",
    description: "Verifies LP token ownership across Uncx, Team.Finance, and Aerodrome slipstream pools to prove liquidity cannot be pulled.",
    exampleInput: { token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    outputExample: {
      status: "success",
      token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      lp_locked_pct: 100,
      lock_platform: "Aerodrome SlipStream Immutable Reserve",
      unlock_timestamp: 1893456000,
      is_rug_proof: true,
    },
  },
  {
    path: "/v1/audit/holder-cluster-map",
    amountMicroUnits: "20000",
    priceUsd: "0.020",
    summary: "Scan top token holders for coordinated wallet clusters and sybil rings",
    description: "Analyzes on-chain funding origins for the top 50 token holders to detect sybil clusters, dev dump risks, and wash-trading rings.",
    exampleInput: { token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    outputExample: {
      status: "success",
      token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      top_10_holders_pct: 14.8,
      clusters_detected: 0,
      sybil_risk_score: 0.01,
      verdict: "DECENTRALIZED_DISTRIBUTION",
    },
  },
  {
    path: "/v1/audit/swap-simulation-proof",
    amountMicroUnits: "20000",
    priceUsd: "0.020",
    summary: "State-override swap simulation with exact slippage & price impact proof",
    description: "Executes state-override simulation of $1k, $10k, and $50k swap orders on Base Mainnet, calculating exact slippage, gas overhead, and MEV frontrun exposure.",
    exampleInput: { token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount_usd: 10000 },
    outputExample: {
      status: "success",
      token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      swap_sizes_tested: [1000, 10000, 50000],
      max_slippage_bps: 4.2,
      sandwich_vulnerable: false,
      simulation_proof_hash: "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b",
    },
  },
  {
    path: "/v1/audit/cross-chain-bridge-risk",
    amountMicroUnits: "20000",
    priceUsd: "0.020",
    summary: "Bridge proof verification and cross-chain message replay auditor",
    description: "Audits canonical Base bridge and CCIP/LayerZero endpoints for message replay vulnerabilities, unbacked wrapped collateral, and admin multisig latency.",
    exampleInput: { token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    outputExample: {
      status: "success",
      token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      canonical_bridge_backed: true,
      bridge_type: "Base Standard Bridge + native CCTP",
      unbacked_collateral_risk: "NONE",
      verdict: "CANONICAL_SECURE",
    },
  },
  {
    path: "/v1/risk/institutional-token-report",
    amountMicroUnits: "20000",
    priceUsd: "0.020",
    summary: "Full 7-vector institutional token security report and audit dossier",
    description: "Generates an end-to-end cryptographic audit report covering bytecode decompilation, honeypot tax simulation, LP lock proofs, holder clusters, and bridge risk.",
    exampleInput: { token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    outputExample: {
      status: "success",
      token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      composite_score: 99.4,
      risk_rating: "AAA",
      vectors_checked: ["bytecode", "honeypot", "lp_lock", "holder_clusters", "swap_slippage", "bridge_security", "drainer_blacklists"],
      verdict: "INSTITUTIONAL_GRADE_SAFE",
    },
  },
  {
    path: "/api/v1/token-screener",
    amountMicroUnits: "10000",
    priceUsd: "0.010",
    summary: "Real-time Solana & Base token screener with honeypot & liquidity filter (80% discount vs Nansen)",
    description: "Screens trending Solana (Pump.fun/Raydium) and Base (Aerodrome/Uniswap V3) tokens with pre-verified honeypot, tax, and liquidity depth metrics.",
    exampleInput: { chain: "solana", token_address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
    outputExample: {
      status: "success",
      chain: "solana",
      tokens: [
        { symbol: "BONK", address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", price_usd: 0.000024, liquidity_usd: 18400000, volume_24h_usd: 64200000, honeypot: false, smart_money_inflow_usd: 412000 },
        { symbol: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", price_usd: 2.85, liquidity_usd: 78500000, volume_24h_usd: 54100000, honeypot: false, smart_money_inflow_usd: 890000 },
      ],
    },
  },
  {
    path: "/api/v1/smart-money/netflow",
    amountMicroUnits: "10000",
    priceUsd: "0.010",
    summary: "Smart-money whale wallet 24h netflow tracker on Solana & Base ($0.010 USDC)",
    description: "Tracks institutional and high-win-rate whale wallet net inflows and outflows across Solana SPL and Base ERC-20 tokens.",
    exampleInput: { chain: "base", token_address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
    outputExample: {
      status: "success",
      token_address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
      netflow_24h_usd: 428900,
      smart_wallets_buying: 14,
      smart_wallets_selling: 2,
      signal: "STRONG_ACCUMULATION",
    },
  },
  {
    path: "/api/v1/smart-money/dex-trades",
    amountMicroUnits: "10000",
    priceUsd: "0.010",
    summary: "Live smart-money DEX swap execution feed across Raydium, Jupiter, Aerodrome & Uniswap",
    description: "Returns real-time DEX trades executed by labeled smart-money and whale wallets on Solana and Base with pre-trade honeypot verification.",
    exampleInput: { chain: "base", token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    outputExample: {
      status: "success",
      trades_count: 3,
      dex_trades: [
        { dex: "Aerodrome SlipStream", side: "BUY", amount_usd: 45200, wallet_label: "Base Whale #4", tx_hash: "0x91a8...4e2b" },
        { dex: "Jupiter v6 (Solana)", side: "BUY", amount_usd: 28900, wallet_label: "Solana Sniper Fund", tx_hash: "5xK9...8mPq" },
      ],
    },
  },
  {
    path: "/api/v1/tgm/who-bought-sold",
    amountMicroUnits: "10000",
    priceUsd: "0.010",
    summary: "Token God Mode (TGM): Top buyers & sellers breakdown by wallet cohort",
    description: "Analyzes who bought and sold a specific Solana or Base token over the last 24h, segmented by Smart Money, Whales, Fresh Wallets, and Dev Clusters.",
    exampleInput: { token_address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b" },
    outputExample: {
      status: "success",
      token_address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
      top_buyers_usd: 1240000,
      top_sellers_usd: 811100,
      net_buyer_cohort: "SMART_MONEY_AND_WHALES",
      dev_wallet_dumping: false,
    },
  },
  {
    path: "/api/v1/tgm/holders",
    amountMicroUnits: "10000",
    priceUsd: "0.010",
    summary: "Token God Mode (TGM): Top holder concentration, sybil cluster & lock breakdown",
    description: "Returns top-10/top-50 holder distribution, LP lock percentage, and coordinated sybil cluster detection for any Solana or Base token.",
    exampleInput: { token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    outputExample: {
      status: "success",
      token_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      top_10_holders_pct: 14.8,
      sybil_clusters_detected: 0,
      lp_locked_pct: 99.4,
      verdict: "HEALTHY_HOLDER_DISTRIBUTION",
    },
  },
  {
    path: "/api/v1/profiler/address/current-balance",
    amountMicroUnits: "10000",
    priceUsd: "0.010",
    summary: "Wallet Address Profiler: Current portfolio balances, PnL & counterparty safety",
    description: "Profiles any Solana or Base wallet address for current token balances, USD valuation, historical win-rate, and drainer/OFAC taint.",
    exampleInput: { address: "0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1" },
    outputExample: {
      status: "success",
      address: "0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1",
      total_value_usd: 148920.50,
      sanctioned: false,
      drainer_exposure: false,
      top_holdings: [
        { symbol: "USDC", balance_usd: 84200.00, chain: "base" },
        { symbol: "SOL", balance_usd: 64720.50, chain: "solana" },
      ],
    },
  },
];

export const ENDPOINT_MAP = new Map<string, EndpointPriceSpec>(
  ENDPOINT_SPECS.map(s => [s.path, s])
);

export const CONFIG = {
  serviceName: "rugshield-402",
  version: "1.3.0",
  port: Number(process.env.PORT || 4020),
  chainId: 8453,
  network: "base",
  merchantAddress: (process.env.MERCHANT_ADDRESS || "0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1") as `0x${string}`,
  solanaMerchantAddress: process.env.SOLANA_MERCHANT_ADDRESS || "3tQ4GthjUMqNsyrb1rZMocMHoNewFQWjDUvHZqWeYuCN",
  solanaNetwork: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  solanaUsdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  solanaFeePayer: "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww",
  payaiFacilitator: "https://facilitator.payai.network",
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
  wethAddress: "0x4200000000000000000000000000000000000006" as `0x${string}`,
  amountMicroUnits: "10000", // Default $0.010 USDC
  unitPriceUsd: "0.010",
  facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
  rpcEndpoints: [
    "https://mainnet.base.org",
    "https://1rpc.io/base",
    "https://base.llamarpc.com",
    "https://base.drpc.org"
  ],
  dex: {
    aerodromeFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as `0x${string}`,
    aerodromeRouter: "0xcF77a3Ba9A5CA399B7c97c748846942438557642" as `0x${string}`,
    uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as `0x${string}`,
    uniswapV3Quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a" as `0x${string}`,
    uniswapV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6" as `0x${string}`,
  },
  launchpads: {
    clankerDeployer: "0x7b0c06043468469967dba22d1ef33f7b3ea7be50" as `0x${string}`,
    virtualsDeployer: "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b" as `0x${string}`,
  },
} as const;

export const AGENT_CONTINUATION = {
  chain_execution: "autonomous_agent_flow_v2",
  recommended_follow_up: [
    {
      service: "CanaryGuard-402",
      endpoint: "https://canaryguard-402.onrender.com/v1/risk/full-portfolio-audit",
      method: "POST",
      cost: "0.02 USDC",
      reason: "Institutional Base token & portfolio security audit with bytecode + LP lock verification"
    },
    {
      service: "StealthGuard-402",
      endpoint: "https://stealthguard-402.onrender.com/v1/research/deep-web-dossier",
      method: "POST",
      cost: "0.02 USDC",
      reason: "Multi-source stealth web synthesis + CanaryGuard injection firewall dossier"
    },
    {
      service: "RugShield-402",
      endpoint: "https://rugshield-402.onrender.com/v1/risk/institutional-token-report",
      method: "POST",
      cost: "0.02 USDC",
      reason: "Full 7-vector token risk audit: bytecode, taxes, LP lock, whale clusters, and swap simulation"
    }
  ]
};
