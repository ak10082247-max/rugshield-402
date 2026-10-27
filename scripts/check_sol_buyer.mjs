import fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const env = fs.readFileSync('../.env', 'utf8');
const match = env.match(/PRIVATE_KEY=(.*)/);
const pk = match[1].trim().replace(/^['"]|['"]$/g, '');
const keypair = pk.startsWith('[')
  ? Uint8Array.from(JSON.parse(pk))
  : bs58.decode(pk);

const { Keypair } = await import('@solana/web3.js');
const kp = Keypair.fromSecretKey(keypair);
console.log('Solana Buyer Pubkey:', kp.publicKey.toBase58());

const conn = new Connection('https://api.mainnet-beta.solana.com');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const [buyerAta] = PublicKey.findProgramAddressSync(
  [kp.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), USDC_MINT.toBuffer()],
  ATOKEN_PROGRAM_ID
);
console.log('Solana Buyer ATA:', buyerAta.toBase58());

try {
  const bal = await conn.getTokenAccountBalance(buyerAta);
  console.log('Solana Buyer USDC:', bal.value.uiAmountString);
} catch (e) {
  console.log('Solana Buyer ATA error or 0:', e.message);
}
