// Address lookup tables and the v0 operation planner (src/solana/alt.ts), in process: no validator. What
// needs a chain (creating a table, sending the planned transactions) is in test/solana/alt.test.ts.
import { describe, expect, it } from 'vitest';
import { AddressLookupTableAccount, Keypair, PACKET_DATA_SIZE, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  BUFFER_MAX_INIT, LOCALNET_POOL_PROGRAM_ID, OP_CU_LIMIT, buildV0Transaction, bufferPda, createLookupTableInstructions, delegateIx, eventAuthorityPda,
  fits, grantIx, legacyTransactions, planOperation, planTransactions, poolLookupAddresses, poolPda, spendIx, v0Size, vaultAuthorityPda, vaultPda,
  type OpPlan,
} from '../../src/solana/index.js';

const programId = LOCALNET_POOL_PROGRAM_ID;
const payer = Keypair.generate().publicKey;
const usd = Keypair.generate().publicKey;
const t22 = Keypair.generate().publicKey;
const mints = [{ mint: usd, tokenProgram: TOKEN_PROGRAM_ID }, { mint: t22, tokenProgram: TOKEN_2022_PROGRAM_ID }];

/** A lookup table account as the chain would return it, without a chain. */
function table(addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: payer, addresses },
  });
}
const alt = table(poolLookupAddresses(programId, mints));

const payload = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31) & 0xff);
const spendOf = (buffer: PublicKey) => spendIx(programId, {
  payer, buffer, nullifier: 77n, token: { mint: usd, tokenProgram: TOKEN_PROGRAM_ID },
  recipientToken: Keypair.generate().publicKey, feeToken: Keypair.generate().publicKey, escrow: { lenderAddr: 5n, loanRef: 1n },
});

/** Rebuilds the payload from a plan's buffer_write instructions (data: disc 8 | seed 8 | offset u32 | len u32 | bytes). */
function staged(plan: OpPlan, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const seen = new Uint8Array(len);
  const all = [...plan.setup, ...plan.writes, plan.final].flat();
  for (const ix of all) {
    if (!ix.programId.equals(programId) || ix.data.length < 24) continue;
    const dv = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.length);
    const off = dv.getUint32(16, true);
    const n = dv.getUint32(20, true);
    if (ix.data.length !== 24 + n) continue; // not a write
    out.set(ix.data.subarray(24), off);
    seen.fill(1, off, off + n);
  }
  expect(seen.every((x) => x === 1), 'every byte written').toBe(true);
  return out;
}

const allTxs = (plan: OpPlan) => [...plan.setup.map((t) => ({ ixs: t, tables: [] as AddressLookupTableAccount[] })), ...plan.writes.map((t) => ({ ixs: t, tables: [] })), { ixs: plan.final, tables: plan.lookupTables }];

describe('pool lookup addresses', () => {
  it('lists the static accounts once, then each mint and its vault', () => {
    const a = poolLookupAddresses(programId, mints, [usd]);
    const s = a.map((k) => k.toBase58());
    expect(new Set(s).size).toBe(s.length);
    for (const k of [poolPda(programId), vaultAuthorityPda(programId), eventAuthorityPda(programId), TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, vaultPda(programId, usd), vaultPda(programId, t22), usd]) {
      expect(s).toContain(k.toBase58());
    }
    expect(a.length).toBe(7 + 2 * mints.length);
  });

  it('creating a table fills it in batches of 20 addresses per transaction', () => {
    const many = Array.from({ length: 45 }, () => Keypair.generate().publicKey);
    const { address, transactions } = createLookupTableInstructions(payer, payer, 123, many);
    expect(address).toBeInstanceOf(PublicKey);
    expect(transactions).toHaveLength(3);
    expect(transactions[0]).toHaveLength(2); // create + first extend
    for (const ixs of transactions) expect(fits(payer, ixs)).toBe(true);
  });
});

describe('v0 transactions against the table', () => {
  it('a spend instruction is smaller with the table than without, and smaller than legacy', () => {
    const ix = spendOf(bufferPda(programId, payer, 1n));
    const legacy = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(ix);
    const legacySize = legacy.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    const plain = v0Size(payer, [ix]);
    const withAlt = v0Size(payer, [ix], [alt]);
    expect(withAlt).toBeLessThan(plain);
    expect(withAlt).toBeLessThan(legacySize);
    // pool, vault authority, event authority, system, mint, vault, token program: 7 keys move to 1-byte indexes
    expect(plain - withAlt).toBeGreaterThanOrEqual(7 * 31 - 40);
    const tx = buildV0Transaction(payer, [ix], PublicKey.default.toBase58(), [alt]);
    expect(tx.message.addressTableLookups).toHaveLength(1);
    // the invoked program and the signer stay static
    expect(tx.message.staticAccountKeys.some((k) => k.equals(programId))).toBe(true);
    expect(tx.message.staticAccountKeys[0].equals(payer)).toBe(true);
  });
});

describe('planning an operation', () => {
  it('a small payload opens, writes and runs in one transaction', () => {
    const p = payload(300);
    const plan = planOperation({ programId, authority: payer, payload: p, op: (b) => delegateIx(programId, payer, b, 9n), lookupTables: [alt], cuLimit: OP_CU_LIMIT });
    expect(plan.setup).toHaveLength(0);
    expect(plan.writes).toHaveLength(0);
    expect(planTransactions(plan)).toBe(1);
    expect(staged(plan, p.length)).toEqual(p);
    expect(fits(payer, plan.final, [alt])).toBe(true);
  });

  it('a spend-sized payload takes two transactions instead of three', () => {
    const p = payload(1_150); // proof + spend args + memos, about what a public spend stages
    const plan = planOperation({ programId, authority: payer, payload: p, op: spendOf, lookupTables: [alt], cuLimit: OP_CU_LIMIT });
    expect(staged(plan, p.length)).toEqual(p);
    expect(planTransactions(plan)).toBe(2);
    expect(legacyTransactions(p.length)).toBe(3);
  });

  for (const size of [5_000, 12_000, 40_000]) {
    it(`a ${size}-byte payload (grant scale) stages every byte, grows before writing past 10 KiB, and fits every transaction`, () => {
      const p = payload(size);
      const plan = planOperation({ programId, authority: payer, payload: p, op: (b) => grantIx(programId, payer, b, [1n, 2n]), lookupTables: [alt], cuLimit: OP_CU_LIMIT });
      expect(staged(plan, p.length)).toEqual(p);
      for (const { ixs, tables } of allTxs(plan)) expect(v0Size(payer, ixs, tables)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const grows = plan.setup.slice(1).flat().length;
      expect(grows).toBe(Math.max(0, Math.ceil((size - BUFFER_MAX_INIT) / 10_240)));
      // the final transaction carries part of the payload with the operation
      expect(plan.final.length).toBe(3); // compute budget, write, grant
      expect(planTransactions(plan)).toBeLessThan(legacyTransactions(size));
    });
  }

  it('the legacy-equivalent plan without tables still fits (only the final transaction differs)', () => {
    const p = payload(3_000);
    const a = planOperation({ programId, authority: payer, payload: p, op: spendOf, cuLimit: OP_CU_LIMIT, seed: 5n });
    const b = planOperation({ programId, authority: payer, payload: p, op: spendOf, cuLimit: OP_CU_LIMIT, seed: 5n, lookupTables: [alt] });
    expect(staged(a, p.length)).toEqual(p);
    const tail = (plan: OpPlan) => plan.final[1].data.length;
    expect(tail(b)).toBeGreaterThan(tail(a)); // the table frees room for more payload in the final transaction
  });

  it('extra instructions before the operation ride in the final transaction', () => {
    const marker = new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [], data: Buffer.from([1]) });
    const plan = planOperation({ programId, authority: payer, payload: payload(2_000), op: spendOf, pre: [marker], lookupTables: [alt] });
    expect(plan.final[plan.final.length - 2]).toBe(marker);
    expect(plan.final[plan.final.length - 1].programId.equals(programId)).toBe(true);
  });

  it('refuses an empty or oversized payload', () => {
    expect(() => planOperation({ programId, authority: payer, payload: new Uint8Array(), op: spendOf })).toThrow(/payload/);
    expect(() => planOperation({ programId, authority: payer, payload: new Uint8Array(96 * 1024 + 1), op: spendOf })).toThrow(/payload/);
  });
});
