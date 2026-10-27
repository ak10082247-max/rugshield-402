import fs from 'fs';
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const env = fs.readFileSync('../canaryguard-402/.env.local', 'utf8');
const match = env.match(/BUYER_PRIVATE_KEY=(.*)/);
const pk = match[1].trim().replace(/^['"]|['"]$/g, '');
const acc = privateKeyToAccount(pk as `0x${string}`);
console.log('Buyer Address:', acc.address);

const client = createPublicClient({ chain: base, transport: http('https://base-rpc.publicnode.com') });
async function run() {
  const usdc = await client.readContract({
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [acc.address]
  });
  console.log('Buyer USDC:', formatUnits(usdc, 6));
}
run();
