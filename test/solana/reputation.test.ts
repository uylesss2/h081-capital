// rep_registry on a local validator (npm run test:solana:rep: rpc 8899, fixtures from test/solana/rep-fixtures.ts).
// Attest rules, the event log and root rebuild, then proofs made with the DEV reputation setup (build/circuits) verified
// off-chain and by verify_reputation on chain. Nothing here talks to a public cluster.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as snarkjs from 'snarkjs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { initCrypto } from '../../src/crypto.js';
import { MerkleTree } from '../../src/merkle.js';
import { Prover } from '../../src/prover.js';
import { NO_REQUIREMENT, REP_LEVELS, randomNonce, reputationInput, selectLoans, type RepPublic } from '../../src/reputation.js';
import { encodeProof, fieldOf } from '../../src/solana/field.js';
import { LOCALNET_LOAN_PROGRAM_ID, slotPda } from '../../src/solana/lender.js';
import {
  LOCALNET_REP_PROGRAM_ID, REP_ERROR_NAME, attestIx, fetchRepLeaves, fetchRepTree, isAttested, isKnownRepRootIn, myRepLoans,
  repBitsPda, repInitializeIx, snapshotOf, verifyReputationIx,
} from '../../src/solana/reputation.js';
import { LOCALNET_UPGRADE_AUTHORITY } from './config-authority.js';
import { CLOSED_REF, MASTER_A, MASTER_B, OTHER_MINT, U, USDG, fixtureLoans } from './rep-fixtures.js';
import { RepRelayer } from '../../relayer/rep.js';
import { RateLimiter } from '../../relayer/ratelimit.js';
import { createRelayerServer } from '../../relayer/server.js';

const RPC = process.env.STIPEND_REP_RPC ?? 'http://127.0.0.1:8899';
const connection = new Connection(RPC, 'confirmed');
const prover = new Prover();
const meta = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'solana', 'test-ledger', 'rep-meta.json'), 'utf8')) as { now: string };
const loans = fixtureLoans(BigInt(meta.now));
const relayer = Keypair.generate();
const assetF = fieldOf(USDG);
const CU: Record<string, number> = {};

async function fund(k: PublicKey, sol = 10) {
  const sig = await connection.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, 'confirmed');
}

/** Sends `ixs`; returns the compute units used. Throws Error("<RepError name>") on a rep_registry error. */
async function send(ixs: TransactionInstruction[], signers: Keypair[], cuLimit = 400_000): Promise<number> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ...ixs);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed', skipPreflight: false });
    const t = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    return t?.meta?.computeUnitsConsumed ?? 0;
  } catch (e) {
    const logs: string[] = (e as { logs?: string[] }).logs ?? (e as { transactionLogs?: string[] }).transactionLogs ?? [];
    const text = `${(e as Error).message}\n${logs.join('\n')}`;
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(text) ?? /Error Number: (\d+)/.exec(text);
    if (m) {
      const code = m[0].startsWith('custom') ? parseInt(m[1], 16) : Number(m[1]);
      throw new Error(REP_ERROR_NAME[code] ?? `code ${code}`);
    }
    if (/already in use/.test(text)) throw new Error('AccountInUse');
    throw new Error(text.slice(0, 600));
  }
}

const attest = (ref: bigint, payer = relayer) => send([attestIx(payer.publicKey, ref)], [payer]);

async function prove(over: Partial<{ expiry: bigint; master: bigint; tree: MerkleTree }> = {}, req = { ...NO_REQUIREMENT, minLoans: 3, minVolume: 60n * U, minLenders: 2, minSpanDays: 75, minMonths: 3, monthFloor: 10n * U }) {
  const { events, tree } = await fetchRepLeaves(connection);
  const master = over.master ?? MASTER_A;
  const mine = myRepLoans(events, master, { assetF });
  const chosen = selectLoans(mine, req);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const { input, publicSignals } = reputationInput({
    masterSk: master, loans: chosen, tree: over.tree ?? tree, req, assetF, audience: 0xabcdefn, nonce: randomNonce(), expiry: over.expiry ?? now + 600n, bindTo: 0n,
  });
  const result = await prover.prove('reputation', input as never);
  return { result, pub: publicSignals, proof: encodeProof(result.proof) };
}

beforeAll(async () => {
  await initCrypto();
  await fund(relayer.publicKey);
  await fund(LOCALNET_UPGRADE_AUTHORITY.publicKey);
}, 120_000);

describe('rep_registry: initialize', () => {
  it('only the upgrade authority opens tree 0, once; tree 1 needs tree 0 full', async () => {
    await expect(send([repInitializeIx(relayer.publicKey, 0)], [relayer])).rejects.toThrow(/UpgradeAuthority/);
    CU.initialize = await send([repInitializeIx(LOCALNET_UPGRADE_AUTHORITY.publicKey, 0)], [LOCALNET_UPGRADE_AUTHORITY]);
    await expect(send([repInitializeIx(LOCALNET_UPGRADE_AUTHORITY.publicKey, 0)], [LOCALNET_UPGRADE_AUTHORITY])).rejects.toThrow();
    await expect(send([repInitializeIx(LOCALNET_UPGRADE_AUTHORITY.publicKey, 1)], [LOCALNET_UPGRADE_AUTHORITY])).rejects.toThrow(/TreeFull/);
    const t = await fetchRepTree(connection);
    expect(t?.nextIndex).toBe(0);
    expect(t?.version).toBe(0);
  });
});

describe('rep_registry: attest', () => {
  it('attests every good loan from a third-party payer, once; the bitmap and the root ring follow', async () => {
    const good = loans.filter((l) => l.kind === 'good');
    for (const l of good) {
      CU[`attest#${l.loanRef}`] = await attest(l.loanRef);
      expect(await isAttested(connection, l.loanRef)).toBe(true);
    }
    const t = (await fetchRepTree(connection))!;
    expect(t.nextIndex).toBe(good.length);
    expect(await connection.getAccountInfo(repBitsPda(8200n))).not.toBeNull(); // second page
    expect(repBitsPda(8200n).equals(repBitsPda(1n))).toBe(false);
    await expect(attest(1n)).rejects.toThrow(/AlreadyAttested/);
    await expect(attest(8200n)).rejects.toThrow(/AlreadyAttested/);
  });

  it('refuses unfunded, partly repaid, slashed, tiny, fake-owner, zero-key, mismatched and closed slots', async () => {
    const want: Record<string, RegExp> = {
      unfunded: /NotFunded/, partial: /NotRepaid/, slashed: /Slashed/, tiny: /TooSmall/, fakeOwner: /NotStreamLoanSlot/, zeroKey: /BadAgentKey/, refMismatch: /NotStreamLoanSlot/,
    };
    for (const l of loans.filter((x) => want[x.kind])) await expect(attest(l.loanRef)).rejects.toThrow(want[l.kind]);
    // a slot closed before anyone attested it has no account: it can never count
    await expect(attest(CLOSED_REF)).rejects.toThrow(/NotStreamLoanSlot/);
    for (const r of [5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n]) expect(await isAttested(connection, r)).toBe(false);
  });

  it('refuses a Subrogation account that is not stream_loan\'s PDA for the loan (an empty look-alike)', async () => {
    const ix = attestIx(relayer.publicKey, 7n);
    ix.keys[2] = { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false };
    await expect(send([ix], [relayer])).rejects.toThrow(/BadSubrogationAccount/);
    const wrongSlot = attestIx(relayer.publicKey, 2n);
    wrongSlot.keys[1] = { pubkey: slotPda(1n, LOCALNET_LOAN_PROGRAM_ID), isSigner: false, isWritable: false };
    await expect(send([wrongSlot], [relayer])).rejects.toThrow(/NotStreamLoanSlot/);
  });

  it('the leaf list rebuilds from the event log to the on-chain root; a snapshot round-trips', async () => {
    const { events, tree, onChain } = await fetchRepLeaves(connection);
    expect(events.length).toBe(onChain.nextIndex);
    expect(tree.root).toBe(onChain.root);
    expect(isKnownRepRootIn(onChain, tree.root)).toBe(true);
    const snap = snapshotOf(events, LOCALNET_REP_PROGRAM_ID);
    const again = await fetchRepLeaves(connection, { snapshot: JSON.parse(JSON.stringify(snap)) });
    expect(again.tree.root).toBe(onChain.root);
    // a doctored snapshot (one principal raised) is refused
    const bad = JSON.parse(JSON.stringify(snap));
    bad.events[0].principal = String(BigInt(bad.events[0].principal) + 1n);
    await expect(fetchRepLeaves(connection, { snapshot: bad })).rejects.toThrow(/does not match/);
  });

  it("finds each master's own loans by its loan keys only", async () => {
    const { events } = await fetchRepLeaves(connection);
    const a = myRepLoans(events, MASTER_A);
    expect(a.map((l) => l.loanRef).sort()).toEqual([1n, 2n, 3n, 13n, 8200n].sort());
    expect(myRepLoans(events, MASTER_A, { assetF }).map((l) => l.loanRef)).not.toContain(13n);
    expect(myRepLoans(events, MASTER_A, { assetF: fieldOf(OTHER_MINT) }).map((l) => l.loanRef)).toEqual([13n]);
    expect(myRepLoans(events, MASTER_B).map((l) => l.loanRef)).toEqual([4n]);
  });
});

describe('rep_registry: verify_reputation (dev setup keys)', () => {
  let good: Awaited<ReturnType<typeof prove>>;

  beforeAll(async () => { good = await prove(); }, 300_000);

  it('a fresh proof verifies off-chain and on-chain', async () => {
    const vkey = JSON.parse(readFileSync(prover.paths('reputation').vkey, 'utf8'));
    expect(await snarkjs.groth16.verify(vkey, good.result.raw.publicSignals, good.result.raw.proof as never)).toBe(true);
    CU.verify_reputation = await send([verifyReputationIx(good.proof, good.pub)], [relayer]);
    expect(CU.verify_reputation).toBeGreaterThan(0);
  });

  it('tampered inputs or proof bytes fail', async () => {
    const pub: RepPublic = { ...good.pub, minVolume: good.pub.minVolume + 1n };
    await expect(send([verifyReputationIx(good.proof, pub)], [relayer])).rejects.toThrow(/InvalidProof/);
    const aud: RepPublic = { ...good.pub, audience: good.pub.audience + 1n };
    await expect(send([verifyReputationIx(good.proof, aud)], [relayer])).rejects.toThrow(/InvalidProof/);
    const bytes = Uint8Array.from(good.proof);
    bytes[200] ^= 1;
    await expect(send([verifyReputationIx(bytes, good.pub)], [relayer])).rejects.toThrow(/InvalidProof|InvalidProofEncoding|Bn254Syscall/);
  });

  it('thresholds beyond their width are refused before the pairing', async () => {
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    await expect(send([verifyReputationIx(good.proof, { ...good.pub, minVolume: P - 1n })], [relayer])).rejects.toThrow(/ThresholdOutOfRange/);
    await expect(send([verifyReputationIx(good.proof, { ...good.pub, minLoans: 256n })], [relayer])).rejects.toThrow(/ThresholdOutOfRange/);
  });

  it('an expired proof, and one valid for more than a day, fail', async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const old = await prove({ expiry: now - 120n });
    await expect(send([verifyReputationIx(old.proof, old.pub)], [relayer])).rejects.toThrow(/Expired/);
    const far = await prove({ expiry: now + 3n * 86_400n });
    await expect(send([verifyReputationIx(far.proof, far.pub)], [relayer])).rejects.toThrow(/ExpiryTooFar/);
  }, 300_000);

  it('a proof against a root the chain never had fails', async () => {
    const { events } = await fetchRepLeaves(connection);
    const forged = new MerkleTree(REP_LEVELS);
    for (const e of [...events].sort((a, b) => a.index - b.index)) forged.insert(e.leaf);
    forged.insert(123n); // a leaf nobody attested
    const p = await prove({ tree: forged });
    await expect(send([verifyReputationIx(p.proof, p.pub)], [relayer])).rejects.toThrow(/UnknownRoot/);
  }, 300_000);

  it("master B cannot count master A's loans", async () => {
    const { events, tree } = await fetchRepLeaves(connection);
    const aLoans = myRepLoans(events, MASTER_A, { assetF });
    expect(() => reputationInput({
      masterSk: MASTER_B, loans: aLoans.slice(0, 1), tree, req: NO_REQUIREMENT, assetF, audience: 1n, nonce: 1n, expiry: 1n, bindTo: 0n,
    })).toThrow(/not this account's leaf/);
    expect(myRepLoans(events, MASTER_B, { assetF }).length).toBe(1);
  });

  it('records compute units', () => {
    console.log('rep_registry compute units', JSON.stringify(CU));
    expect(CU.verify_reputation).toBeLessThan(400_000);
  });
});

describe('relayer: attest for borrowers, the sweep, and the leaf snapshot (rpc 8899)', () => {
  it('queues an attest request (nothing sent then), refuses below its floor, sweeps queued and unasked loans together from its own wallet, and serves a leaf list clients accept', async () => {
    const hot = Keypair.generate();
    await fund(hot.publicKey, 2);
    const rep = new RepRelayer({ connection, payer: hot, repProgramId: LOCALNET_REP_PROGRAM_ID, loanProgramId: LOCALNET_LOAN_PROGRAM_ID, minPrincipal: 10n * U, cacheMs: 0 });
    const server = createRelayerServer({ solana: { info: () => ({}), relay: async () => ({}) }, limiter: new RateLimiter({ perMinute: 60, burst: 10 }), rep });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const j = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
      const post = (loanRef: string) => fetch(`${url}/v1/rep/attest`, { method: 'POST', body: JSON.stringify({ loanRef }) });
      const r14 = await post('14');
      expect(r14.status).toBe(202);
      expect((await j(r14)).queued).toBe(true);
      // queued, not sent: the attest's timing on chain is the sweep's, not this request's
      expect(await isAttested(connection, 14n)).toBe(false);
      expect((await j(post('16'))).error.code).toBe('below_floor');
      expect((await j(post('5'))).error.code).toBe('not_funded');
      expect((await j(post('11'))).error.code).toBe('no_slot');
      expect((await post('x')).status).toBe(400);
      // the sweep sends 14 (asked for) and 15 (20 USDG, nobody asked) together in loanRef order, and skips 16 (below the floor)
      const swept = await rep.sweep();
      expect(swept.attested).toEqual(['14', '15']);
      // the borrower's wallet is nowhere in the transaction: only the relayer's hot wallet signs and pays
      const tx = await connection.getTransaction(swept.signatures[0], { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      expect(tx!.transaction.message.staticAccountKeys[0].equals(hot.publicKey)).toBe(true);
      expect(tx!.transaction.signatures).toHaveLength(1);
      expect(await isAttested(connection, 14n)).toBe(true);
      expect((await post('14')).status).toBe(409);
      expect(await isAttested(connection, 16n)).toBe(false);
      expect((await rep.sweep()).attested).toEqual([]);
      // the served leaf list rebuilds the on-chain root, and a bank-side client accepts it as a snapshot
      const snap = await j(fetch(`${url}/v1/rep/leaves`));
      const checked = await fetchRepLeaves(connection, { snapshot: snap });
      expect(checked.tree.root).toBe(checked.onChain.root);
      expect(myRepLoans(checked.events, MASTER_A, { assetF }).map((l) => l.loanRef)).toContain(14n);
      const roots = await j(fetch(`${url}/v1/rep/roots`));
      expect(BigInt(roots.root)).toBe(checked.onChain.root);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 300_000);
});


