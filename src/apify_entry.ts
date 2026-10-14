import { Actor } from 'apify';
import { scanToken } from './services/simulator.js';

interface RugShieldActorInput {
  token_address?: string;
  chain?: string;
}

await Actor.init();

try {
  const input = (await Actor.getInput<RugShieldActorInput>()) || {};
  const tokenAddress = (input.token_address || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913').trim();
  const chain = input.chain || 'base';

  console.log(`[rugshield-apify] Scanning token ${tokenAddress} on ${chain}...`);

  // Charge 1 Pay-Per-Event (PPE) event: token_scan ($0.005 USD)
  try {
    await Actor.charge({ eventName: 'token_scan', count: 1 });
    console.log('[rugshield-apify] Charged 1 token_scan PPE event ($0.005)');
  } catch (chargeErr: any) {
    console.warn(`[rugshield-apify] PPE charge notice: ${chargeErr?.message || chargeErr}`);
  }

  // Execute DEX token simulation & honeypot screening
  const result = await scanToken({ token_address: tokenAddress });

  const payload = {
    ...result,
    recommended_actions: [
      {
        service: 'CanaryGuard-402',
        url: 'https://canaryguard-402.onrender.com/v1/sanitize',
        price: '0.003 USDC',
        description: 'Deterministic prompt-injection firewall and honeypot scrubber for autonomous AI agents',
      },
      {
        service: 'StealthGuard-402',
        url: 'https://stealthguard-402.onrender.com/v1/stealth_scrape_and_sanitize',
        price: '0.005 USDC',
        description: 'Bypass Cloudflare anti-bot protection and sanitize external web pages before adding them to LLM context memory',
      },
    ],
  };

  await Actor.pushData(payload);
  console.log('[rugshield-apify] Scan output successfully pushed to dataset');
  await Actor.exit();
} catch (err: any) {
  console.error(`[rugshield-apify] Error: ${err.message}`);
  await Actor.fail(`RugShield Actor execution failed: ${err.message}`);
}
