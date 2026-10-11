import assert from "node:assert/strict";
import { scanToken } from "../src/services/simulator.js";
import { getNextRpcUrl, createFailoverPublicClient } from "../src/services/rpc.js";
import { CONFIG } from "../src/config.js";

let passed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    console.error(`  ✗ ${name}: ${err.message}`);
    throw err;
  }
}

async function runTests() {
  console.log("\n[rugshield-402] Running Automated Unit & Integration Tests...\n");

  await test("Rejects invalid EVM address format", async () => {
    await assert.rejects(
      async () => {
        await scanToken({ token_address: "not-an-address" });
      },
      /Invalid token address format/
    );
  });

  await test("Detects non-contract EOA address as honeypot risk", async () => {
    // Zero address or dead address has no contract bytecode
    const res = await scanToken({
      token_address: "0x0000000000000000000000000000000000000001",
    });
    assert.equal(res.is_honeypot, true);
    assert.equal(res.risk_score, 1.0);
    assert.equal(res.recommendation, "DANGER_HONEYPOT");
  });

  await test("RPC Failover Pool round-robin functions correctly", () => {
    const url1 = getNextRpcUrl();
    const url2 = getNextRpcUrl();
    assert.ok(CONFIG.rpcEndpoints.includes(url1));
    assert.ok(CONFIG.rpcEndpoints.includes(url2));
    const client = createFailoverPublicClient();
    assert.ok(client);
  });

  await test("Scans Base USDC contract and verifies safe parameters", async () => {
    const res = await scanToken({
      token_address: CONFIG.usdcAddress,
      simulate_sell: true,
    });

    assert.equal(res.symbol, "USDC");
    assert.equal(res.decimals, 6);
    assert.equal(res.is_honeypot, false);
    assert.equal(res.buy_tax_bps, 0);
    assert.equal(res.sell_tax_bps, 0);
    assert.ok(res.liquidity_usd > 10_000);
    assert.equal(res.recommendation, "SAFE_TO_SWAP");
    assert.ok(res.risk_score <= 0.15);
  });

  await test("Scans DEGEN token on Base and confirms pool analysis", async () => {
    const degenAddress = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";
    const res = await scanToken({
      token_address: degenAddress,
      simulate_sell: true,
    });

    assert.equal(res.symbol, "DEGEN");
    assert.equal(res.is_honeypot, false);
    assert.equal(res.buy_tax_bps, 0);
    assert.equal(res.sell_tax_bps, 0);
    assert.ok(res.liquidity_usd > 5000);
    assert.equal(res.recommendation, "SAFE_TO_SWAP");
  });

  await test("Identifies Uniswap V2 factory and Clanker launchpad configuration", () => {
    assert.equal(CONFIG.dex.uniswapV2Factory, "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6");
    assert.equal(CONFIG.launchpads.clankerDeployer, "0x7b0c06043468469967dba22d1ef33f7b3ea7be50");
    assert.equal(CONFIG.launchpads.virtualsDeployer, "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b");
  });

  console.log(`\nAll ${passed} integration tests successfully passed! ✨\n`);
}

runTests().catch((e) => {
  console.error("Test suite failed:", e);
  process.exit(1);
});
