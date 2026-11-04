// Creates the treasury's associated token account for an x402 payment asset, so the relayer's x402 seller can
// list it (relayer/app.ts refuses an asset whose treasury ATA does not exist). The payer only pays the rent;
// the account is owned by the treasury vault. Dry run by default: derives, checks, simulates. `--send` sends.
//
//   node node_modules/tsx/dist/cli.mjs scripts/x402-treasury-ata.mts --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
//     --payer solana/keys/mainnet/deployer-keypair.json [--owner EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq] [--rpc URL] [--send]
import { readFileSync } from 'node:fs';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

const TREASURY = 'EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq';
const LAUNCH_WALLET_DENYLIST = new Set([
  '2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP', 'FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ', '5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw',
]);

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const mint = new PublicKey(arg('--mint') ?? (() => { throw new Error('--mint is required'); })());
const owner = new PublicKey(arg('--owner', TREASURY)!);
if (owner.toBase58() !== TREASURY) throw new Error(`owner must be the treasury vault ${TREASURY}`);
if (LAUNCH_WALLET_DENYLIST.has(owner.toBase58())) throw new Error('owner is a launch wallet');
const payerPath = arg('--payer') ?? (() => { throw new Error('--payer <keypair.json> is required'); })();
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerPath, 'utf8'))));
const conn = new Connection(arg('--rpc', 'https://api.mainnet-beta.solana.com')!, 'confirmed');

const mintInfo = await conn.getAccountInfo(mint, 'confirmed');
if (!mintInfo) throw new Error(`mint ${mint.toBase58()} does not exist`);
const tokenProgram = mintInfo.owner;
const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
console.log(`mint ${mint.toBase58()} (token program ${tokenProgram.toBase58()})\nowner ${owner.toBase58()}\nATA ${ata.toBase58()}\npayer ${payer.publicKey.toBase58()}`);
const existing = await conn.getAccountInfo(ata, 'confirmed');
if (existing) { console.log('already exists; nothing to do'); process.exit(0); }
const rent = await conn.getMinimumBalanceForRentExemption(165, 'confirmed');
const balance = await conn.getBalance(payer.publicKey, 'confirmed');
console.log(`rent ${rent / 1e9} SOL + fee ~0.00001 SOL; payer balance ${balance / 1e9} SOL`);

const tx = new Transaction().add(
  ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint, tokenProgram),
);
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
const sim = await conn.simulateTransaction(tx);
if (sim.value.err) { console.error('simulation failed', sim.value.err, sim.value.logs); process.exit(1); }
console.log(`simulation ok (${sim.value.unitsConsumed} CU)`);
if (!process.argv.includes('--send')) { console.log('dry run; pass --send to create it'); process.exit(0); }
const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
console.log(`created: ${sig}`);
