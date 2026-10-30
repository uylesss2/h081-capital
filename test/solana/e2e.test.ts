// stipend_pool end to end on the private localnet validator (WSL, rpc 127.0.0.1:8999), with real proofs
// and locally created mints (SPL Token and Token-2022). Port of the main cases of test/e2e/pool.test.ts.
// Run with `npm run test:solana`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  ExtensionType, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAccount, createEnableRequiredMemoTransfersInstruction, createMint, createReallocateInstruction,
  freezeAccount, getOrCreateAssociatedTokenAccount, mintTo, thawAccount,
} from '@solana/spl-token';
import { Account } from '../../src/client.js';
import { allowanceCommitment, initCrypto, lenderClaimable, randomField } from '../../src/crypto.js';
import { randomViewingKey } from '../../src/encryption.js';
import {
  OP_CU_LIMIT, POOL_ERROR, SPEND_ROOT_OFFSET, SolanaLenderWallet, SolanaPool, SolanaWallet, be32, customErrorCode, decodePool, encodeSpendArgs, escrowPda,
  fieldOf, nullifierPda, poolPda, pullLenderShareIx, send, spendIx, vaultPda, type LocatedEvent, type SolOwnedAllowance,
} from '../../src/solana/index.js';

const RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8999';
const connection = new Connection(RPC, 'confirmed');
const pool = new SolanaPool(connection);
const funder = Keypair.generate(); // mint and freeze authority of the test mints
const cu: Record<string, number> = {};

let usd: PublicKey; // SPL Token, 6 decimals
let t22: PublicKey; // Token-2022, 6 decimals

async function airdrop(k: PublicKey, sol = 20) {
  const sig = await connection.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash('confirmed')) }, 'confirmed');
}

async function wallet(): Promise<SolanaWallet> {
  const signer = Keypair.generate();
  await airdrop(signer.publicKey);
  return new SolanaWallet(Account.random(), pool, signer);
}

async function expectCode(p: Promise<unknown>, code: number) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(caught, 'transaction should fail').toBeDefined();
  expect(customErrorCode(caught), String(caught).slice(0, 400)).toBe(code);
}

async function nextIndex(): Promise<number> {
  const info = await connection.getAccountInfo(poolPda(pool.programId), 'confirmed');
  return decodePool(info!.data).nextIndex;
}

const bal = (mint: PublicKey, owner: PublicKey, tp = TOKEN_PROGRAM_ID) => pool.tokenBalance(pool.ata(mint, owner, tp));

/** An operation stopped at pool.run: its signer, staged payload and instruction builder, not sent. */
interface Captured { payer: Keypair; payload: Uint8Array; mk: (buffer: PublicKey) => TransactionInstruction; signers: Keypair[] }
const CAPTURED = new Error('captured');
async function capture(op: () => Promise<unknown>): Promise<Captured> {
  let got: Captured | undefined;
  const p = pool as unknown as { run: unknown };
  p.run = async (payer: Keypair, payload: Uint8Array, mk: Captured['mk'], signers: Keypair[] = []) => {
    got = { payer, payload, mk, signers };
    throw CAPTURED;
  };
  try {
    await op();
  } catch (e) {
    if (e !== CAPTURED) throw e;
  } finally {
    delete p.run; // back to SolanaPool.prototype.run
  }
  if (!got) throw new Error('operation did not reach pool.run');
  return got;
}
/** Sends a captured operation, optionally with another payload or instruction builder. */
const replay = (c: Captured, payload = c.payload, mk = c.mk) => pool.run(c.payer, payload, mk, c.signers);
/** The instruction builder with account `index` replaced. */
const withKey = (mk: Captured['mk'], index: number, pubkey: PublicKey): Captured['mk'] => (buffer) => {
  const i = mk(buffer);
  i.keys[index] = { ...i.keys[index], pubkey };
  return i;
};
const flip = (payload: Uint8Array, at: number) => { const x = Uint8Array.from(payload); x[at] ^= 1; return x; };
const live = (w: SolanaWallet, mint: PublicKey) => w.agentAllowances(mint).filter((x) => x.allowance.remaining > 0n)[0];
/** A token account of `mint` owned by `owner` that is NOT its associated token account. */
const sideAccount = (mint: PublicKey, owner: PublicKey, tp = TOKEN_PROGRAM_ID) =>
  createAccount(connection, funder, mint, owner, Keypair.generate(), { commitment: 'confirmed' }, tp);
const eventsOf = (sig: string): LocatedEvent[] => pool.log.byTx.get(sig) ?? [];

let owner: SolanaWallet;
let agentA: SolanaWallet;
let agentB: SolanaWallet;
let agentC: SolanaWallet;
let shop: SolanaWallet; // a Stipend address receiving shielded payments
const merchant = Keypair.generate(); // a public recipient wallet
const relayer = Keypair.generate();

beforeAll(async () => {
  await initCrypto();
  try {
    await connection.getVersion();
  } catch {
    throw new Error(`no validator at ${RPC}; run: node scripts/solana-localnet.mjs start`);
  }
  const prog = await connection.getAccountInfo(pool.programId);
  if (!prog?.executable) throw new Error('stipend_pool is not loaded; run npm run solana:build and restart the validator');
  await airdrop(funder.publicKey, 100);
  await pool.initialize(funder);
  usd = await createMint(connection, funder, funder.publicKey, funder.publicKey, 6, undefined, { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
  t22 = await createMint(connection, funder, funder.publicKey, funder.publicKey, 6, undefined, { commitment: 'confirmed' }, TOKEN_2022_PROGRAM_ID);
  [owner, agentA, agentB, agentC, shop] = await Promise.all([wallet(), wallet(), wallet(), wallet(), wallet()]);
  for (const [mint, tp] of [[usd, TOKEN_PROGRAM_ID], [t22, TOKEN_2022_PROGRAM_ID]] as const) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, funder, mint, owner.signer.publicKey, false, 'confirmed', { commitment: 'confirmed' }, tp);
    await mintTo(connection, funder, mint, ata.address, funder, 10_000_000n, [], { commitment: 'confirmed' }, tp);
  }
});

describe('treasury', () => {
  it('deposits with a relayer fee and sees a shielded balance', async () => {
    const before = await nextIndex();
    const res = await owner.deposit(usd, 2_000_000n, { relayer: relayer.publicKey, fee: 1_000n });
    cu.transact_deposit = res.tx.computeUnits;
    expect(owner.balance(usd)).toBe(1_999_000n);
    expect(await pool.tokenBalance(vaultPda(pool.programId, usd))).toBe(1_999_000n);
    expect(await bal(usd, relayer.publicKey)).toBe(1_000n);
    expect(await bal(usd, owner.signer.publicKey)).toBe(8_000_000n);
    expect(await nextIndex()).toBe(before + 2);
    // both input nullifiers are marked spent on chain
    const evs = eventsOf(res.tx.signature);
    const nfs = evs.filter((e) => e.name === 'NewNullifier');
    expect(nfs).toHaveLength(2);
    for (const e of nfs) expect(await connection.getAccountInfo(nullifierPda(pool.programId, (e as { nullifier: bigint }).nullifier))).not.toBeNull();
    expect(evs.filter((e) => e.name === 'NewCommitment')).toHaveLength(2);
  });

  it('a fully shielded transfer hides the asset; the receiver withdraws publicly', async () => {
    const res = await owner.transfer(usd, 5_000n, shop.address);
    // the mint is not among the accounts of a shielded transfer
    const tx = await connection.getTransaction(res.tx.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    expect(tx!.transaction.message.staticAccountKeys.some((k) => k.equals(usd))).toBe(false);
    await shop.sync();
    shop.registerMint(usd);
    expect(shop.balance(usd)).toBe(5_000n);
    const w = await shop.withdraw(usd, 5_000n, shop.signer.publicKey);
    cu.transact_withdraw = w.tx.computeUnits;
    expect(await bal(usd, shop.signer.publicKey)).toBe(5_000n);
    expect(shop.balance(usd)).toBe(0n);
  });
});

describe('distribution', () => {
  it('funds three agents under three policies in one transaction', async () => {
    const res = await owner.grant(usd, [
      { to: agentA.address, amount: 300_000n, maxPerTx: 100_000n, windowCap: 150_000n },
      { to: agentB.address, amount: 200_000n },
      { to: agentC.address, amount: 100_000n, recipients: [merchant.publicKey] },
    ]);
    cu.grant = res.tx.computeUnits;
    expect(res.total).toBe(600_000n);
    expect(owner.balance(usd)).toBe(1_999_000n - 5_000n - 600_000n);
    expect(eventsOf(res.tx.signature).filter((e) => e.name === 'NewCommitment')).toHaveLength(17);
    expect(eventsOf(res.tx.signature).some((e) => e.name === 'NewGrant')).toBe(true);
    for (const [w, amt] of [[agentA, 300_000n], [agentB, 200_000n], [agentC, 100_000n]] as const) {
      await w.sync();
      const mine = w.agentAllowances(usd);
      expect(mine).toHaveLength(1);
      expect(mine[0].allowance.remaining).toBe(amt);
      expect(mine[0].mint!.equals(usd)).toBe(true);
    }
    expect(owner.grantedAllowances()).toHaveLength(3);
  });
});

describe('spending under policy', () => {
  it('agent pays a public recipient; the relayer fee comes out of the payout', async () => {
    const a = agentA.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    const res = await agentA.pay(a, 50_000n, merchant.publicKey, { relayer: relayer.publicKey, fee: 500n });
    cu.spend_public = res.tx.computeUnits;
    expect(await bal(usd, merchant.publicKey)).toBe(49_500n);
    expect(await bal(usd, relayer.publicKey)).toBe(1_500n);
    const payout = eventsOf(res.tx.signature).find((e) => e.name === 'PublicPayout') as Extract<LocatedEvent, { name: 'PublicPayout' }>;
    expect(payout.recipient.equals(merchant.publicKey)).toBe(true);
    expect(payout.amount).toBe(49_500n);
    expect(agentA.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0].allowance.remaining).toBe(250_000n);
  });

  it('has no proof over the per-transaction cap or the window cap', async () => {
    const before = await nextIndex();
    const a = agentA.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    await expect(agentA.pay(a, 100_001n, merchant.publicKey)).rejects.toThrow();
    await agentA.pay(a, 100_000n, merchant.publicKey); // 150k used in the window
    const a2 = agentA.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    await expect(agentA.pay(a2, 1n, merchant.publicKey)).rejects.toThrow();
    expect(await nextIndex()).toBe(before + 1); // only the valid spend inserted a successor
  });

  it('allow-listed agent can pay the merchant and nobody else', async () => {
    agentC.rememberRecipients([merchant.publicKey]);
    const c = agentC.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    await agentC.pay(c, 10_000n, merchant.publicKey);
    expect(await bal(usd, merchant.publicKey)).toBe(159_500n);
    const c2 = agentC.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    await expect(agentC.pay(c2, 1_000n, Keypair.generate().publicKey)).rejects.toThrow(/allow-list/);
  });

  it('shielded payment between agents reveals nothing and can be unshielded later', async () => {
    const b = agentB.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    const res = await agentB.pay(b, 40_000n, shop.address);
    cu.spend_shielded = res.tx.computeUnits;
    const tx = await connection.getTransaction(res.tx.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    expect(tx!.transaction.message.staticAccountKeys.some((k) => k.equals(usd))).toBe(false);
    expect(eventsOf(res.tx.signature).some((e) => e.name === 'PublicPayout')).toBe(false);
    await shop.sync();
    expect(shop.balance(usd)).toBe(40_000n);
    await shop.withdraw(usd, 40_000n, shop.signer.publicKey);
    expect(await bal(usd, shop.signer.publicKey)).toBe(45_000n);
  });

  it('rejects a replayed spend as already spent', async () => {
    const b = agentB.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    const p = await agentB.prepareSpend(b, 10_000n, merchant.publicKey);
    await agentB.submitSpend(p);
    await expectCode(pool.run(agentB.signer, p.payload, (buffer) => spendIx(pool.programId, { ...p.accounts, buffer })), POOL_ERROR.AlreadySpent);
  });

  it('refuses a spend against a root the pool never had', async () => {
    const b = agentB.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    const p = await agentB.prepareSpend(b, 1_000n, merchant.publicKey);
    const forged = Uint8Array.from(p.payload);
    forged.set(be32(randomField()), SPEND_ROOT_OFFSET);
    await expectCode(pool.run(agentB.signer, forged, (buffer) => spendIx(pool.programId, { ...p.accounts, buffer })), POOL_ERROR.UnknownRoot);
    // the same root bytes but a different proof statement: the honest payload still goes through
    await agentB.submitSpend(p);
  });

  it('refuses a stale or future `now`', async () => {
    const b = agentB.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    const clock = await pool.now();
    const stale = await agentB.prepareSpend(b, 1_000n, merchant.publicKey, {}, { now: clock - 16n * 60n });
    await expectCode(agentB.submitSpend(stale), POOL_ERROR.StaleTimestamp);
    const future = await agentB.prepareSpend(b, 1_000n, merchant.publicKey, {}, { now: clock + 600n });
    await expectCode(agentB.submitSpend(future), POOL_ERROR.StaleTimestamp);
  });

  it('refuses a payout to a token account whose owner is not publicRecipient', async () => {
    const b = agentB.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    const p = await agentB.prepareSpend(b, 1_000n, merchant.publicKey);
    const other = await pool.ensureAta(agentB.signer, usd, Keypair.generate().publicKey);
    await expectCode(pool.run(agentB.signer, p.payload, (buffer) => spendIx(pool.programId, { ...p.accounts, recipientToken: other, buffer })), POOL_ERROR.Recipient);
  });

  it('refuses a payout to a token account of publicRecipient that is not its associated token account', async () => {
    // the payout account is not bound by extDataHash: a relayer copying the payload must not pick it
    const b = agentB.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    const p = await agentB.prepareSpend(b, 1_000n, merchant.publicKey);
    const side = await sideAccount(usd, merchant.publicKey);
    await expectCode(pool.run(agentB.signer, p.payload, (buffer) => spendIx(pool.programId, { ...p.accounts, recipientToken: side, buffer })), POOL_ERROR.Recipient);
    expect(await pool.tokenBalance(side)).toBe(0n);
  });
});

describe('owner controls', () => {
  it('owner reclaims an agent allowance into the treasury', async () => {
    await owner.sync();
    const line = owner.grantedAllowances().find((a) => a.allowance.agentPk === agentB.account.keys.pk)!;
    expect(line.allowance.remaining).toBe(200_000n - 40_000n - 10_000n - 1_000n);
    const before = owner.balance(usd);
    const res = await owner.reclaim(line);
    cu.spend_reclaim = res.tx.computeUnits;
    expect(owner.balance(usd)).toBe(before + 149_000n);
    await agentB.sync();
    expect(agentB.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)).toHaveLength(0);
  });
});

describe('selective disclosure', () => {
  it('agent proves a bound on its allowance; anyone verifies it on chain', async () => {
    const a = agentA.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    expect(a.allowance.remaining).toBe(150_000n);
    const d = await agentA.prove(a, 'remainingAtLeast', 100_000n, 0xa0d17n);
    const checker = Keypair.generate();
    await airdrop(checker.publicKey);
    expect(await pool.verifyDisclosure(checker, d.proof, d.args)).toBe(true);
    expect(await pool.verifyDisclosure(checker, d.proof, d.args, 'simulate')).toBe(true);
    expect(await pool.verifyDisclosure(checker, d.proof, { ...d.args, bound: 140_000n })).toBe(false);
    expect(await pool.verifyDisclosure(checker, d.proof, { ...d.args, root: randomField() })).toBe(false);
  });
});

describe('hierarchical delegation and bearer notes', () => {
  let agentD: SolanaWallet;
  let agentE: SolanaWallet;

  it('an agent splits its allowance into a tighter sub-allowance without the owner', async () => {
    agentD = await wallet();
    const a = agentA.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    const res = await agentA.delegate(a, [{ to: agentD.address, amount: 30_000n, maxPerTx: 10_000n, windowCap: 20_000n }]);
    cu.delegate = res.tx.computeUnits;
    expect(eventsOf(res.tx.signature).some((e) => e.name === 'NewDelegation')).toBe(true);
    await agentD.sync();
    const d = agentD.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    expect(d.allowance.remaining).toBe(30_000n);
    expect(d.allowance.policy.maxPerTx).toBe(10_000n);
    expect(agentA.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0].allowance.remaining).toBe(120_000n);
    await agentD.pay(d, 10_000n, merchant.publicKey);
    await expect(agentD.pay(agentD.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0], 10_001n, merchant.publicKey)).rejects.toThrow();
  });

  it('a bearer transfer moves the whole sub-allowance; the owner sees the lines as a tree', async () => {
    agentE = await wallet();
    const d = agentD.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    await agentD.transferAllowance(d, agentE.address);
    await agentE.sync();
    const e = agentE.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    expect(e.allowance.remaining).toBe(20_000n);
    expect(e.allowance.policy.maxPerTx).toBe(10_000n);
    await owner.sync();
    const tree = owner.treasuryTree();
    const lineA = tree.find((n) => n.granted.agentPk === agentA.account.keys.pk)!;
    expect(lineA.children).toHaveLength(1);
    expect(lineA.children[0].granted.agentPk).toBe(agentD.account.keys.pk);
    expect(lineA.children[0].children[0].granted.agentPk).toBe(agentE.account.keys.pk);
  });
});

describe('more than four subs per delegation', () => {
  it('six subs take two delegate steps, the second from the first residual; every sub sees its allowance', async () => {
    const boss = await wallet();
    const ata = await getOrCreateAssociatedTokenAccount(connection, funder, usd, boss.signer.publicKey, false, 'confirmed', { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
    await mintTo(connection, funder, usd, ata.address, funder, 20_000n, [], { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
    await boss.deposit(usd, 20_000n);
    const lead = await wallet();
    await boss.grant(usd, [{ to: lead.address, amount: 10_000n, windowCap: 9_000n }]);
    await lead.sync();
    const team = await Promise.all(Array.from({ length: 6 }, () => wallet()));
    const before = await nextIndex();
    const res = await lead.delegate(live(lead, usd), team.map((t) => ({ to: t.address, amount: 1_000n, windowCap: 1_000n })));
    expect(res.steps).toHaveLength(2);
    expect(await nextIndex()).toBe(before + 10);
    expect(res.residual.remaining).toBe(4_000n);
    expect(res.residual.policy.windowCap).toBe(9_000n - 6_000n - 2n);
    for (const t of team) {
      await t.sync();
      expect(live(t, usd).allowance.remaining).toBe(1_000n);
    }
    await boss.sync();
    const line = boss.treasuryTree().find((n) => n.granted.agentPk === lead.account.keys.pk)!;
    expect(line.children).toHaveLength(6);
  });
});

describe('pledges and the lender leg', () => {
  const lender = Keypair.generate();
  const lenderView = randomViewingKey();
  let lw: SolanaLenderWallet;
  let pledged: SolOwnedAllowance;
  const loanRef = 7n;

  it('the owner pledges an agent allowance; the agent sees the pledge and the lender ingests it', async () => {
    await airdrop(lender.publicKey);
    lw = new SolanaLenderWallet(pool, lender, lenderView);
    await owner.sync();
    const lineC = owner.grantedAllowances().find((a) => a.allowance.agentPk === agentC.account.keys.pk)!;
    const res = await owner.pledge(lineC, { lender: lender.publicKey, loanRef, pledgeBps: 4000n, lenderViewPub: lenderView.pub });
    expect(lw.ingest(res.payload)).not.toBeNull();
    await agentC.sync();
    pledged = agentC.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    expect(pledged.allowance.policy.pledgeBps).toBe(4000n);
    expect(pledged.lenderKey!.equals(lender.publicKey)).toBe(true);
    // a stream proof over the pledge verifies on chain with the lender and the mint as accounts
    const s = await agentC.proveStream(pledged, { minRemaining: 80_000n, minRate: 0n, audience: 9n });
    expect(await pool.verifyStream(lender, s.proof, s.args)).toBe(true);
    expect(await pool.verifyStream(lender, s.proof, { ...s.args, lender: Keypair.generate().publicKey })).toBe(false);
  });

  it('every spend routes the pledged share to the lender', async () => {
    await pool.ensureAta(lender, usd, lender.publicKey);
    const before = await bal(usd, merchant.publicKey);
    const res = await agentC.pay(pledged, 10_000n, merchant.publicKey);
    cu.spend_pledged = res.tx.computeUnits;
    expect(await bal(usd, lender.publicKey)).toBe(4_000n);
    expect(await bal(usd, merchant.publicKey)).toBe(before + 6_000n);
    const routed = eventsOf(res.tx.signature).find((e) => e.name === 'PledgeRouted') as Extract<LocatedEvent, { name: 'PledgeRouted' }>;
    expect(routed.lenderAddr).toBe(fieldOf(lender.publicKey));
    expect(routed.amount).toBe(4_000n);
    expect(eventsOf(res.tx.signature).some((e) => e.name === 'LenderMemo')).toBe(true);
    // the next spend routes its share too (agent C is allow-listed to the merchant only)
    await agentC.pay(agentC.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0], 5_000n, merchant.publicKey);
    expect(await bal(usd, lender.publicKey)).toBe(6_000n);
  });

  it('a lender account that cannot receive gets its share escrowed; anyone releases it later', async () => {
    const lenderAta = pool.ata(usd, lender.publicKey, TOKEN_PROGRAM_ID);
    await freezeAccount(connection, funder, lenderAta, usd, funder, [], { commitment: 'confirmed' });
    const res = await agentC.pay(agentC.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0], 5_000n, merchant.publicKey);
    expect(eventsOf(res.tx.signature).some((e) => e.name === 'PledgeEscrowed')).toBe(true);
    const escrow = escrowPda(pool.programId, usd, fieldOf(lender.publicKey), loanRef);
    expect(await pool.tokenBalance(escrow)).toBe(2_000n);
    expect(await bal(usd, lender.publicKey)).toBe(6_000n);
    // the spend went through although the lender could not receive; the share waits in the escrow
    await thawAccount(connection, funder, lenderAta, usd, funder, [], { commitment: 'confirmed' });
    const someone = Keypair.generate();
    await airdrop(someone.publicKey);
    await pool.pullLenderShare(someone, usd, lender.publicKey, loanRef);
    expect(await bal(usd, lender.publicKey)).toBe(8_000n);
    expect(await pool.tokenBalance(escrow)).toBe(0n);
    await expectCode(pool.pullLenderShare(someone, usd, lender.publicKey, loanRef), POOL_ERROR.NothingOwed);
  });

  it('the lender claims the vested share; only the lender can; the agent continues from the successor', async () => {
    await lw.sync();
    const live = lw.live();
    expect(live).toHaveLength(1);
    const rec = live[0];
    const claimable = lenderClaimable(rec.allowance, await pool.now());
    expect(claimable).toBe(36_000n - 8_000n); // 40% of the 90k pledged cap is vested (unstreamed); 8k was routed
    // a different signer is refused by the pool even with a valid proof
    const mallory = Keypair.generate();
    await airdrop(mallory.publicKey);
    const p = await lw.prepareClaim(rec, 1_000n);
    await expectCode(
      pool.run(lender, p.payload, (buffer) => spendIx(pool.programId, { ...p.accounts, lenderSigner: mallory.publicKey, buffer }), [mallory]),
      POOL_ERROR.Lender,
    );
    const res = await lw.claim(lw.live()[0], 1_000n);
    cu.spend_lender_claim = res.tx.computeUnits;
    expect(await bal(usd, lender.publicKey)).toBe(9_000n);
    await agentC.sync();
    const next = agentC.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0];
    expect(next.allowance.pledgePaid).toBe(9_000n);
    expect(next.commitment).toBe(allowanceCommitment(res.next));
    await agentC.pay(next, 1_000n, merchant.publicKey);
  });

  it('a lender token account that is not the lender ATA never gets the share: it is escrowed, and pull_lender_share only pays the ATA', async () => {
    const side = await sideAccount(usd, lender.publicKey);
    const p = await agentC.prepareSpend(agentC.agentAllowances(usd).filter((x) => x.allowance.remaining > 0n)[0], 5_000n, merchant.publicKey);
    const escrow = escrowPda(pool.programId, usd, fieldOf(lender.publicKey), loanRef);
    const escrowBefore = await pool.tokenBalance(escrow);
    const lenderBefore = await bal(usd, lender.publicKey);
    // a submitter (relayer, front-runner) names the side account as the lender leg
    const res = await pool.run(agentC.signer, p.payload, (buffer) => spendIx(pool.programId, { ...p.accounts, lenderToken: side, buffer }));
    await agentC.sync();
    expect(eventsOf(res.signature).some((e) => e.name === 'PledgeEscrowed')).toBe(true);
    expect(await pool.tokenBalance(side)).toBe(0n);
    expect(await pool.tokenBalance(escrow)).toBe(escrowBefore + 2_000n);
    const someone = Keypair.generate();
    await airdrop(someone.publicKey);
    const pull = (to: PublicKey) => send(connection, someone, [pullLenderShareIx(pool.programId, usd, TOKEN_PROGRAM_ID, fieldOf(lender.publicKey), loanRef, to)]);
    await expectCode(pull(side), POOL_ERROR.LenderAccount);
    await expectCode(pull(await pool.ensureAta(someone, usd, someone.publicKey)), POOL_ERROR.Lender);
    expect(await pool.tokenBalance(escrow)).toBe(escrowBefore + 2_000n);
    await pool.pullLenderShare(someone, usd, lender.publicKey, loanRef);
    expect(await bal(usd, lender.publicKey)).toBe(lenderBefore + escrowBefore + 2_000n);
    expect(await pool.tokenBalance(escrow)).toBe(0n);
  });
});

describe('Token-2022', () => {
  it('deposits, grants, pays and withdraws a Token-2022 asset', async () => {
    const agentT = await wallet();
    await owner.deposit(t22, 500_000n);
    expect(await pool.tokenBalance(vaultPda(pool.programId, t22))).toBe(500_000n);
    await owner.grant(t22, [{ to: agentT.address, amount: 100_000n }]);
    await agentT.sync();
    const a = agentT.agentAllowances(t22).filter((x) => x.allowance.remaining > 0n)[0];
    expect(a.allowance.asset).toBe(fieldOf(t22));
    await agentT.pay(a, 25_000n, merchant.publicKey);
    expect(await bal(t22, merchant.publicKey, TOKEN_2022_PROGRAM_ID)).toBe(25_000n);
    await owner.withdraw(t22, 100_000n, owner.signer.publicKey);
    expect(await bal(t22, owner.signer.publicKey, TOKEN_2022_PROGRAM_ID)).toBe(9_600_000n);
    expect(await pool.tokenBalance(vaultPda(pool.programId, t22))).toBe(375_000n);
  });

  it('a lender account that cannot take a CPI transfer (Token-2022 required memo) does not block the spend: the SDK escrows the share', async () => {
    const agentM = await wallet();
    const lender2 = Keypair.generate();
    await airdrop(lender2.publicKey);
    const lenderAta2 = await pool.ensureAta(lender2, t22, lender2.publicKey);
    await send(connection, lender2, [
      createReallocateInstruction(lenderAta2, lender2.publicKey, [ExtensionType.MemoTransfer], lender2.publicKey, [], TOKEN_2022_PROGRAM_ID),
      createEnableRequiredMemoTransfersInstruction(lenderAta2, lender2.publicKey, [], TOKEN_2022_PROGRAM_ID),
    ]);
    await owner.grant(t22, [{ to: agentM.address, amount: 20_000n, pledge: { lender: lender2.publicKey, loanRef: 99n, pledgeBps: 5000n, lenderViewPub: randomViewingKey().pub } }]);
    await agentM.sync();
    const p = await agentM.prepareSpend(live(agentM, t22), 10_000n, merchant.publicKey);
    expect(p.accounts.lenderToken?.equals(lenderAta2)).toBe(true);
    // sent as built, the token program refuses the transfer into the memo-required account
    await expect(pool.run(agentM.signer, p.payload, (buffer) => spendIx(pool.programId, { ...p.accounts, buffer }))).rejects.toThrow();
    const before = await bal(t22, merchant.publicKey, TOKEN_2022_PROGRAM_ID);
    const sent = await agentM.submitSpend(p);
    expect(eventsOf(sent.tx.signature).some((e) => e.name === 'PledgeEscrowed')).toBe(true);
    expect(await pool.tokenBalance(escrowPda(pool.programId, t22, fieldOf(lender2.publicKey), 99n))).toBe(5_000n);
    expect(await pool.tokenBalance(lenderAta2)).toBe(0n);
    expect(await bal(t22, merchant.publicKey, TOKEN_2022_PROGRAM_ID)).toBe(before + 5_000n);
  });
});

describe('sixteen agents per grant', () => {
  it('funds sixteen agents in one proof and each sees only its own slot', async () => {
    const agents = await Promise.all(Array.from({ length: 16 }, () => wallet()));
    const res = await owner.grant(usd, agents.map((w, i) => ({ to: w.address, amount: 1_000n + BigInt(i) })));
    cu.grant_16 = res.tx.computeUnits;
    for (const [i, w] of agents.entries()) {
      await w.sync();
      const mine = w.agentAllowances(usd);
      expect(mine).toHaveLength(1);
      expect(mine[0].allowance.remaining).toBe(1_000n + BigInt(i));
    }
  });
});

describe('ext data binding, account binding, replays and the time window (negative cases)', () => {
  // TransactArgs is 7 x 32 bytes; its ext data starts after the proof and the args
  const TX_EXT = 256 + 7 * 32;
  let granted: SolOwnedAllowance; // the 2,000 allowance granted to agent B below
  const grantedLine = () => agentB.agentAllowances(usd).find((x) => x.allowance.policy.lifetimeCap === 2_000n && !x.spent)!;

  it('transact: tampered fee recipient or memo, swapped withdrawal or fee account, and a repeated nullifier are refused', async () => {
    const dep = await capture(() => owner.deposit(usd, 10_000n, { relayer: relayer.publicKey, fee: 100n }));
    // ext: recipient | relayer | fee_recipient | ext_amount | fee | memos
    const feeSwap = Uint8Array.from(dep.payload);
    feeSwap.set((await pool.ensureAta(funder, usd, Keypair.generate().publicKey)).toBytes(), TX_EXT + 64);
    await expectCode(replay(dep, feeSwap), POOL_ERROR.ExtData);
    await expectCode(replay(dep, flip(dep.payload, TX_EXT + 32)), POOL_ERROR.ExtData); // relayer
    await expectCode(replay(dep, flip(dep.payload, dep.payload.length - 1)), POOL_ERROR.ExtData); // a memo byte
    await replay(dep); // the honest payload still goes through
    await expectCode(replay(dep), POOL_ERROR.AlreadySpent);
    await owner.sync();

    const other = await pool.ensureAta(funder, usd, Keypair.generate().publicKey);
    const wd = await capture(() => owner.withdraw(usd, 3_000n, merchant.publicKey, { relayer: relayer.publicKey, fee: 50n }));
    // transact accounts: ... depositor_token 8, recipient_token 9, fee_token 10
    await expectCode(replay(wd, wd.payload, withKey(wd.mk, 9, other)), POOL_ERROR.Recipient);
    await expectCode(replay(wd, wd.payload, withKey(wd.mk, 10, other)), POOL_ERROR.WrongTokenAccount);
    expect(await pool.tokenBalance(other)).toBe(0n);

    const tr = await capture(() => owner.transfer(usd, 1_000n, shop.address));
    const twice = Uint8Array.from(tr.payload);
    twice.copyWithin(256 + 128, 256 + 96, 256 + 128); // inputNullifiers[1] := inputNullifiers[0]
    await expectCode(replay(tr, twice), POOL_ERROR.SameNullifier);
  });

  it('grant: tampered memo, a repeated nullifier and a replay are refused', async () => {
    const g = await capture(() => owner.grant(usd, [{ to: agentB.address, amount: 2_000n }]));
    await expectCode(replay(g, flip(g.payload, g.payload.length - 1)), POOL_ERROR.ExtData);
    const twice = Uint8Array.from(g.payload);
    twice.copyWithin(256 + 64, 256 + 32, 256 + 64);
    await expectCode(replay(g, twice), POOL_ERROR.SameNullifier);
    await replay(g);
    await expectCode(replay(g), POOL_ERROR.AlreadySpent);
    await agentB.sync();
    granted = grantedLine();
    expect(granted.allowance.remaining).toBe(2_000n);
  });

  it('spend: a tampered relayer, fee recipient or memo breaks extDataHash', async () => {
    const p = await agentB.prepareSpend(granted, 100n, merchant.publicKey, { relayer: relayer.publicKey, fee: 10n });
    const ext = 256 + encodeSpendArgs(p.args).length; // relayer | fee_recipient | memos
    const send_ = (payload: Uint8Array) => pool.run(agentB.signer, payload, (buffer) => spendIx(pool.programId, { ...p.accounts, buffer }));
    await expectCode(send_(flip(p.payload, ext)), POOL_ERROR.ExtData);
    await expectCode(send_(flip(p.payload, ext + 32)), POOL_ERROR.ExtData);
    await expectCode(send_(flip(p.payload, ext + 64 + 4)), POOL_ERROR.ExtData);
  });

  it('delegate: a stale or future `now`, a tampered memo and a replay are refused', async () => {
    const sub = await wallet();
    const a = grantedLine();
    const clock = await pool.now();
    await expectCode(agentB.delegate(a, [{ to: sub.address, amount: 100n }], { now: clock - 16n * 60n }), POOL_ERROR.StaleTimestamp);
    await expectCode(agentB.delegate(a, [{ to: sub.address, amount: 100n }], { now: clock + 600n }), POOL_ERROR.StaleTimestamp);
    const d = await capture(() => agentB.delegate(a, [{ to: sub.address, amount: 500n }]));
    await expectCode(replay(d, flip(d.payload, d.payload.length - 1)), POOL_ERROR.ExtData);
    await replay(d);
    await expectCode(replay(d), POOL_ERROR.AlreadySpent);
    await sub.sync();
    expect(live(sub, usd).allowance.remaining).toBe(500n);
  });
});

describe('note consolidation', () => {
  it('a withdrawal that needs four notes merges twice first; each merge is a fully shielded transfer', async () => {
    const w = await wallet();
    const ata = await getOrCreateAssociatedTokenAccount(connection, funder, usd, w.signer.publicKey, false, 'confirmed', { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
    await mintTo(connection, funder, usd, ata.address, funder, 40_000n, [], { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
    for (let i = 0; i < 4; i++) await w.deposit(usd, 10_000n);
    const vault = await pool.tokenBalance(vaultPda(pool.programId, usd));
    const merges = await w.consolidate(usd, 35_000n);
    expect(merges).toHaveLength(2);
    for (const m of merges) {
      const names = eventsOf(m.tx.signature).map((e) => e.name).sort();
      expect(names).toEqual(['NewCommitment', 'NewCommitment', 'NewNullifier', 'NewNullifier']);
    }
    // the vault did not move: merges touch no token
    expect(await pool.tokenBalance(vaultPda(pool.programId, usd))).toBe(vault);
    const merchantBefore = await bal(usd, merchant.publicKey);
    const before = await nextIndex();
    await w.withdraw(usd, 35_000n, merchant.publicKey);
    expect(await nextIndex()).toBe(before + 2);
    expect(await bal(usd, merchant.publicKey)).toBe(merchantBefore + 35_000n);
    expect(w.balance(usd)).toBe(5_000n);
  });
});

describe('compute units', () => {
  it('every measured operation fits its budget (written to solana/target-so, not a tracked file)', () => {
    const budget: Record<string, number> = {
      transact_deposit: 300_000, transact_withdraw: 300_000, grant: 800_000, grant_16: 800_000, spend_public: 300_000, spend_shielded: 300_000,
      spend_reclaim: 300_000, spend_pledged: 300_000, spend_lender_claim: 300_000, delegate: 400_000,
    };
    for (const [k, max] of Object.entries(budget)) {
      expect(cu[k], k).toBeGreaterThan(0);
      expect(cu[k], k).toBeLessThan(Math.min(max, OP_CU_LIMIT));
    }
    const dir = resolve(import.meta.dirname, '..', '..', 'solana', 'target-so');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'compute-units-ops.json'), JSON.stringify({ measured: new Date().toISOString(), rpc: RPC, computeUnits: cu }, null, 2) + '\n');
    console.log('compute units', cu);
  });
});
