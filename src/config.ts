export const CONFIG = {
  serviceName: "rugshield-402",
  version: "1.0.0",
  port: Number(process.env.PORT || 4020),
  chainId: 8453,
  network: "base",
  merchantAddress: (process.env.MERCHANT_ADDRESS || "0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1") as `0x${string}`,
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
  wethAddress: "0x4200000000000000000000000000000000000006" as `0x${string}`,
  amountMicroUnits: "5000", // 0.005 USDC
  unitPriceUsd: "0.005",
  facilitator: "coinbase-cdp",
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
