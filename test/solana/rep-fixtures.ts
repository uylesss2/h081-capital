// Fixture stream_loan accounts for the rep_registry localnet suite (test/solana/reputation.test.ts).
//
// rep_registry only READS stream_loan's Slot and Subrogation accounts, so the suite loads them into the validator
// directly (solana-test-validator --account-dir) under the localnet stream_loan program id, at their real PDAs, with
// the exact borsh layout of stream_loan::state (checked by consistency of decodeSlot below and by the Rust offset
// test). This exercises every attest rule without stream proofs, which would need the pool's ceremony proving keys.
// Masters and keys come from public seeds: localnet only.
import { sha256 } from '@noble/hashes/sha2';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { initCrypto, loanPk } from '../../src/crypto.js';
import { be32 } from '../../src/solana/field.js';
import { LOCALNET_LOAN_PROGRAM_ID, slotPda, subrogationPda } from '../../src/solana/lender.js';

const enc = (s: string) => new TextEncoder().encode(s);
const seedKey = (s: string) => new PublicKey(sha256(enc(`h081 rep localnet ${s}`)));
const field = (s: string) => BigInt('0x' + Buffer.from(sha256(enc(`h081 rep localnet master ${s}`))).toString('hex').slice(0, 60));

export const USDG = seedKey('usdg mint');
export const OTHER_MINT = seedKey('other mint');
export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const LENDER_1 = seedKey('lender 1');
export const LENDER_2 = seedKey('lender 2');
export const LENDER_3 = seedKey('lender 3');
export const MASTER_A = field('A');
export const MASTER_B = field('B');
export const U = 1_000_000n;
const DAY = 86_400n;

export type FixtureKind = 'good' | 'unfunded' | 'partial' | 'slashed' | 'tiny' | 'fakeOwner' | 'zeroKey' | 'refMismatch';
export interface FixtureLoan {
  loanRef: bigint; kind: FixtureKind; master?: bigint; keyIndex?: number; principal: bigint; repaid: bigint; lender: PublicKey;
  asset: PublicKey; fundedAt: bigint;
}

/** A clock-independent set: funding days relative to a fixed base far enough back that every span test passes today. */
export function fixtureLoans(nowSec: bigint): FixtureLoan[] {
  const d0 = (nowSec / DAY - 200n) * DAY + 3600n;
  const L = (loanRef: bigint, kind: FixtureKind, o: Partial<FixtureLoan>): FixtureLoan => ({
    loanRef, kind, principal: 10n * U, repaid: 10n * U, lender: LENDER_1, asset: USDG, fundedAt: d0, ...o,
  });
  return [
    L(1n, 'good', { master: MASTER_A, keyIndex: 0, principal: 10n * U, repaid: 10n * U, lender: LENDER_1, fundedAt: d0 }),
    L(2n, 'good', { master: MASTER_A, keyIndex: 1, principal: 20n * U, repaid: 21n * U, lender: LENDER_2, fundedAt: d0 + 40n * DAY }),
    L(3n, 'good', { master: MASTER_A, keyIndex: 2, principal: 30n * U, repaid: 30n * U, lender: LENDER_1, fundedAt: d0 + 75n * DAY }),
    L(4n, 'good', { master: MASTER_B, keyIndex: 0, principal: 15n * U, repaid: 15n * U, lender: LENDER_2, fundedAt: d0 + 10n * DAY }),
    L(5n, 'unfunded', { master: MASTER_A, keyIndex: 3, repaid: 0n, fundedAt: 0n }),
    L(6n, 'partial', { master: MASTER_A, keyIndex: 4, principal: 10n * U, repaid: 10n * U - 1n }),
    L(7n, 'slashed', { master: MASTER_A, keyIndex: 5 }),
    L(8n, 'tiny', { master: MASTER_A, keyIndex: 6, principal: U - 1n, repaid: U - 1n }),
    L(9n, 'fakeOwner', { master: MASTER_A, keyIndex: 7 }),
    L(10n, 'zeroKey', {}),
    L(12n, 'refMismatch', { master: MASTER_A, keyIndex: 8 }),
    // a second bitmap page, and a loan in another asset under A
    L(8200n, 'good', { master: MASTER_A, keyIndex: 9, principal: 5n * U, repaid: 5n * U, lender: LENDER_3, fundedAt: d0 + 150n * DAY }),
    L(13n, 'good', { master: MASTER_A, keyIndex: 10, principal: 7n * U, repaid: 7n * U, asset: OTHER_MINT, fundedAt: d0 + 20n * DAY }),
  ];
}

/** Ref 11 has no account at all: a loan whose slot was closed before anyone attested it. */
export const CLOSED_REF = 11n;

function slotData(l: FixtureLoan): Uint8Array {
  const b = Buffer.alloc(253);
  let o = 0;
  const put = (x: Uint8Array) => { b.set(x, o); o += x.length; };
  const u8 = (x: number) => { b[o] = x; o += 1; };
  const u64 = (x: bigint) => { b.writeBigUInt64LE(x, o); o += 8; };
  const i64 = (x: bigint) => { b.writeBigInt64LE(x, o); o += 8; };
  const u128 = (x: bigint) => { u64(x & ((1n << 64n) - 1n)); u64(x >> 64n); };
  put(sha256(enc('account:Slot')).subarray(0, 8));
  u64(l.kind === 'refMismatch' ? l.loanRef + 1n : l.loanRef);
  put(l.lender.toBytes());
  u8(255);                                  // bump
  u8(l.kind === 'unfunded' ? 0 : 1);        // funded
  u8(0);                                    // settled
  put(l.asset.toBytes());
  put(TOKEN_PROGRAM.toBytes());
  u64(l.principal);
  u64(l.repaid);
  u128(1n); u128(1n);                       // min_remaining, min_rate
  b.writeUInt16LE(5000, o); o += 2;         // pledge_bps
  u64(0n);                                  // expiry
  put(l.kind === 'zeroKey' || l.master === undefined ? new Uint8Array(32) : be32(loanPk(l.master, l.keyIndex!)));
  i64(l.fundedAt);
  put(seedKey(`payout ${l.loanRef}`).toBytes());
  u64(0n);                                  // stream_start
  if (o !== 253) throw new Error(`slot fixture is ${o} bytes`);
  return b;
}

function subrogationData(loanRef: bigint): Uint8Array {
  const b = Buffer.alloc(97);
  b.set(sha256(enc('account:Subrogation')).subarray(0, 8), 0);
  b.writeBigUInt64LE(loanRef, 8);
  b.set(seedKey('safety config').toBytes(), 16);
  b.set(seedKey('safety ata').toBytes(), 48);
  b.writeBigUInt64LE(10n * U, 80);
  b.writeBigUInt64LE(0n, 88);
  b[96] = 254;
  return b;
}

export interface AccountFixture { pubkey: string; account: { lamports: number; data: [string, 'base64']; owner: string; executable: false; rentEpoch: 0; space: number } }

const acct = (pubkey: PublicKey, owner: PublicKey, data: Uint8Array): AccountFixture => ({
  pubkey: pubkey.toBase58(),
  account: { lamports: 10_000_000, data: [Buffer.from(data).toString('base64'), 'base64'], owner: owner.toBase58(), executable: false, rentEpoch: 0, space: data.length },
});

/** Every account file for --account-dir. */
export async function fixtureAccounts(nowSec: bigint): Promise<AccountFixture[]> {
  await initCrypto();
  const out: AccountFixture[] = [];
  for (const l of fixtureLoans(nowSec)) {
    const owner = l.kind === 'fakeOwner' ? SystemProgram.programId : LOCALNET_LOAN_PROGRAM_ID;
    out.push(acct(slotPda(l.loanRef, LOCALNET_LOAN_PROGRAM_ID), owner, slotData(l)));
    if (l.kind === 'slashed') out.push(acct(subrogationPda(l.loanRef, LOCALNET_LOAN_PROGRAM_ID), LOCALNET_LOAN_PROGRAM_ID, subrogationData(l.loanRef)));
  }
  return out;
}
