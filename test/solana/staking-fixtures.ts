// Writes stream_loan fixture accounts (Slot, Ledger, inbox token accounts) for the staking suite into
// solana/target-so/staking-fixtures/ (gitignored); the staking validator loads them with --account-dir.
// They are owned by the stream_loan program id so safety_pool reads them exactly as it would read real
// stream_loan state, at times relative to T0 (the WSL clock, which the validator uses).
// Usage: npx tsx test/solana/staking-fixtures.ts <T0 unix seconds>
// The lender keypair here is a throwaway localnet test key, generated per run.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  CLASSIC_TOKEN_PROGRAM_ID, SAFETY_POOL_ESCROW_PROGRAM_ID, SAFETY_STREAM_LOAN_PROGRAM_ID, ataAddress, encodeStreamLedger, encodeStreamSlot, streamEscrowPda,
  streamLedgerPda, streamSlotPda, type StreamSlot,
} from '../../src/solana/token.js';

export const FIXTURE_DIR = resolve(import.meta.dirname, '..', '..', 'solana', 'target-so', 'staking-fixtures');
/** Live loans expire this long after T0 (insure must land before; slash after expiry + grace). */
export const LIVE_SECONDS = 200n;

export const REF = {
  live: 1001n, unfunded: 1002n, noExpiry: 1003n, expired: 1004n, settled: 1005n, pending: 1006n, huge: 1007n, wrongOwner: 1008n,
  emptyPool: 1011n, overdue: 1012n, escrowed: 1013n, long: 1014n, repaid: 1015n, dust: 1016n,
} as const;

export interface StakingMeta {
  t0: number;
  liveExpiry: number;
  lenderSecret: number[];
  asset: string;
  loans: Record<keyof typeof REF, { loanRef: string; principal: string; repaid: string; pending: string; escrowed: string }>;
}

export function readStakingMeta(): StakingMeta {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'meta.json'), 'utf8'));
}

function accountJson(pubkey: PublicKey, owner: PublicKey, data: Uint8Array) {
  return {
    pubkey: pubkey.toBase58(),
    account: { lamports: 1_000_000_000, data: [Buffer.from(data).toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length },
  };
}

/** A classic SPL token account (165 bytes): mint, owner, amount, initialized. */
function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(mint.toBytes(), 0);
  d.set(owner.toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1; // AccountState::Initialized
  return d;
}

export function writeFixtures(t0: bigint): StakingMeta {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const lender = Keypair.generate();
  const asset = Keypair.generate().publicKey; // the loan asset (USDG-like); only its address is read
  const liveExpiry = t0 + LIVE_SECONDS;
  const loans = {} as StakingMeta['loans'];
  let n = 0;
  const put = (pubkey: PublicKey, owner: PublicKey, data: Uint8Array) => writeFileSync(resolve(FIXTURE_DIR, `a${n++}.json`), JSON.stringify(accountJson(pubkey, owner, data)));

  // stipend_pool escrow token accounts are owned by the token program, authority = the pool's ["vault_auth"] PDA
  const vaultAuth = PublicKey.findProgramAddressSync([new TextEncoder().encode('vault_auth')], SAFETY_POOL_ESCROW_PROGRAM_ID)[0];
  const slot = (name: keyof typeof REF, over: Partial<StreamSlot>, inbox?: { amount: bigint; held: bigint }, owner = SAFETY_STREAM_LOAN_PROGRAM_ID, escrowed = 0n) => {
    const loanRef = REF[name];
    const [addr, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode('slot'), new Uint8Array(new BigUint64Array([loanRef]).buffer)], SAFETY_STREAM_LOAN_PROGRAM_ID);
    if (!addr.equals(streamSlotPda(loanRef))) throw new Error('slot pda mismatch');
    const s: StreamSlot = {
      loanRef, lender: lender.publicKey, bump, funded: true, settled: false, asset, tokenProgram: CLASSIC_TOKEN_PROGRAM_ID,
      principal: 5_000_000n, repaid: 0n, minRemaining: 1_000_000n, minRate: 1n, pledgeBps: 2500, expiry: liveExpiry,
      agentPk: new Uint8Array(32).fill(7), fundedAt: t0 - 3600n, payoutTo: Keypair.generate().publicKey, streamStart: t0 - 7200n, ...over,
    };
    put(addr, owner, encodeStreamSlot(s));
    let pending = 0n;
    if (inbox) {
      put(ataAddress(addr, asset, CLASSIC_TOKEN_PROGRAM_ID), CLASSIC_TOKEN_PROGRAM_ID, tokenAccountData(asset, addr, inbox.amount));
      const [ledger, lbump] = PublicKey.findProgramAddressSync(
        [new TextEncoder().encode('ledger'), new Uint8Array(new BigUint64Array([loanRef]).buffer), asset.toBytes()], SAFETY_STREAM_LOAN_PROGRAM_ID);
      if (!ledger.equals(streamLedgerPda(loanRef, asset))) throw new Error('ledger pda mismatch');
      put(ledger, SAFETY_STREAM_LOAN_PROGRAM_ID, encodeStreamLedger({ loanRef, mint: asset, held: inbox.held, received: inbox.held + 10n, bump: lbump }));
      pending = inbox.amount - inbox.held;
    }
    if (escrowed > 0n) put(streamEscrowPda(loanRef, asset), CLASSIC_TOKEN_PROGRAM_ID, tokenAccountData(asset, vaultAuth, escrowed));
    loans[name] = { loanRef: loanRef.toString(), principal: s.principal.toString(), repaid: s.repaid.toString(), pending: pending.toString(), escrowed: escrowed.toString() };
  };

  slot('live', { principal: 5_000_000n, repaid: 1_000_000n });
  slot('unfunded', { funded: false, principal: 0n, expiry: 0n, fundedAt: 0n });
  slot('noExpiry', { expiry: 0n });
  slot('expired', { expiry: t0 - 1000n });
  slot('settled', { settled: true });
  slot('pending', { principal: 3_000_000n }, { amount: 1_000_000n, held: 250_000n });
  slot('huge', { principal: 1_000_000_000_000_000n });
  slot('wrongOwner', {}, undefined, SystemProgram.programId);
  slot('emptyPool', { principal: 2_000_000n });
  slot('overdue', { principal: 7_000_000n, repaid: 2_000_000n, expiry: t0 - 8n * 86400n }, { amount: 1_500_000n, held: 500_000n });
  // shares the pool escrowed for the slot (lender account left out of the spends) count as paid
  slot('escrowed', { principal: 3_000_000n, repaid: 500_000n }, undefined, SAFETY_STREAM_LOAN_PROGRAM_ID, 1_200_000n);
  // expires in 8 days: the only loan the production build (14-day cooldown, 7-day grace) can insure
  slot('long', { principal: 5_000_000n, expiry: t0 + 8n * 86400n });
  // repaid in full once the unsynced inbox value is counted: its cover can be released
  slot('repaid', { principal: 2_000_000n, repaid: 1_500_000n }, { amount: 600_000n, held: 100_000n });
  // a shortfall of 2M tokens minus one base unit: slashing a 2M-token pool for it leaves dust
  slot('dust', { principal: 2_000_000_000_000n - 1n });

  const meta: StakingMeta = { t0: Number(t0), liveExpiry: Number(liveExpiry), lenderSecret: Array.from(lender.secretKey), asset: asset.toBase58(), loans };
  writeFileSync(resolve(FIXTURE_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const t0 = BigInt(process.argv[2] ?? Math.floor(Date.now() / 1000));
  const m = writeFixtures(t0);
  console.log(`staking fixtures: T0=${m.t0} liveExpiry=${m.liveExpiry} -> ${FIXTURE_DIR}`);
}
