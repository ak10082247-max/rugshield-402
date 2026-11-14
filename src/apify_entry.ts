import { Actor } from 'apify';
import { scanToken } from './services/simulator.js';

interface RugShieldActorInput {
  token_address?: string;
  chain?: string;
}

await Actor.init();

try {
  const input = (await Actor.getInput<RugShieldActorInput>()) || {};
  const tokenAddress = typeof input.token_address === 'string' ? input.token_address.trim() : '';
  if (!tokenAddress) throw new Error("Missing required string input: token_address");
  const chain = input.chain || 'base';

  console.log(`[rugshield-apify] Scanning token ${tokenAddress} on ${chain}...`);

  if (chain !== "base" && chain !== "8453" && chain !== "eip155:8453") throw new Error("This Actor supports Base simulation only");
  const result = await scanToken({ token_address: tokenAddress, chain_id: 8453, simulate_sell: true });
  if (result.simulation_status !== "passed") throw new Error("Actual buy/sell simulation could not complete; no event charge attempted");

  const payload = {
    ...result,
    recommended_actions: [
      {
        service: 'CanaryGuard-402',
        url: 'https://canaryguard-402.onrender.com/v1/sanitize',
        price: '0.010 USDC',
        description: 'Deterministic prompt-injection firewall and honeypot scrubber for autonomous AI agents',
      },
      {
        service: 'AgentFuel402',
        url: 'https://agentfuel402.ak10082247.workers.dev/v1/fuel/llm-clean-markdown',
        price: '0.005 USDC',
        description: 'Fetch public web pages into SSRF-safe clean Markdown with prompt-injection defense',
      },
    ],
  };

  await Actor.pushData(payload);
  await Actor.charge({ eventName: 'token_scan', count: 1 });
  console.log('[rugshield-apify] Scan output successfully pushed to dataset');
  await Actor.exit();
} catch (err: any) {
  console.error(`[rugshield-apify] Error: ${err.message}`);
  await Actor.fail(`RugShield Actor execution failed: ${err.message}`);
}
