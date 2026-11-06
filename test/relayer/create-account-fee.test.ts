// The relayer never pays rent that is not covered: an account the final transaction creates for an operation
// (a withdrawal's or payout's ATA, a vault) belongs to its owner, who can close it and keep the rent, so the fee
// must carry a per-mint surcharge for each one (RELAYER_SOLANA_CREATE_ACCOUNT_FEE), and the lamports a relay
// costs the hot wallet (rent + transactions) must stay within what the fee policy covers.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { ConfigError, DEFAULT_CIRCUITS_DIR, DEFAULT_CREATE_ACCOUNT_LAMPORTS, DEFAULT_STAGING_LAMPORTS, loadConfig } from '../../relayer/config.js';
import { toRelayError } from '../../relayer/errors.js';
import { LAMPORTS_PER_SIGNATURE, SolanaRelayer, type SolanaRelayerOptions, rentExempt, requiredFee, solanaRelayerOptions, tokenAccountBytes } from '../../relayer/solana.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { vaultPda } from '../../src/solana/pda.js';
import { concatBytes, encodeSpendArgs, encodeSpendExt, encodeTransactArgs, encodeTransactExt, extDataHash, toB64 } from '../../src/solana/index.js';
import { stubCluster } from './helpers/cluster.js';

const proof = new Uint8Array(256).fill(7);
const payer = Keypair.generate();
const treasury = Keypair.generate().publicKey;
const usd = Keypair.generate().publicKey;
const programId = Keypair.generate().publicKey;
const treasuryAta = getAssociatedTokenAddressSync(usd, treasury, true, TOKEN_PROGRAM_ID);
const vault = vaultPda(programId, usd);
const MIN = 1_000n;
const SURCHARGE = 400_000n; // 0.40 USDG per created account
const AMOUNT = 5_000_000n;
const BASE = requiredFee(MIN, 20, AMOUNT); // 10_000
const okVerifier = { verify: async () => true };

function relayer(existing: PublicKey[], o: Partial<SolanaRelayerOptions> = {}) {
  return new SolanaRelayer({
    connection: stubCluster({ programId, mints: [usd], existing }), payer, treasury, programId, minFees: new Map([[usd.toBase58(), MIN]]), verifier: okVerifier, ...o,
  }).init();
}
const withSurcharge = { createAccountFees: new Map([[usd.toBase58(), SURCHARGE]]) };

const freshOwner = Keypair.generate().publicKey;
const freshAta = getAssociatedTokenAddressSync(usd, freshOwner, true, TOKEN_PROGRAM_ID);

function withdrawal(fee: bigint, owner = freshOwner) {
  const ext = encodeTransactExt({
    recipient: getAssociatedTokenAddressSync(usd, owner, true, TOKEN_PROGRAM_ID), relayer: payer.publicKey, feeRecipient: treasuryAta,
    extAmount: -AMOUNT, fee, encryptedOutputs: [new Uint8Array(120).fill(1), new Uint8Array(120).fill(2)],
  });
  const args = encodeTransactArgs({ root: 11n, publicAmount: 0n, extDataHash: extDataHash(ext), inputNullifiers: [21n, 22n], outputCommitments: [31n, 32n] });
  return { op: 'transact', payload: toB64(concatBytes(proof, args, ext)), mint: usd.toBase58(), recipientOwner: owner.toBase58() };
}

function spend(fee: bigint, recipient = freshOwner) {
  const ext = encodeSpendExt({ relayer: payer.publicKey, feeRecipient: treasuryAta, encryptedAllowance: new Uint8Array(300).fill(3), encryptedPayment: new Uint8Array(), encryptedLender: new Uint8Array() });
  const args = encodeSpendArgs({
    root: 11n, nullifier: 41n, newAllowanceCommitment: 42n, payCommitment: 0n, publicAmount: AMOUNT, publicRecipient: recipient, publicAsset: usd, fee,
    timestamp: 1_800_000_000n, receipt: 43n, lenderAmount: 0n, lenderAddr: 0n, loanRef: 0n, isLenderClaim: false, extDataHash: extDataHash(ext),
  });
  return { op: 'spend', payload: toB64(concatBytes(proof, args, ext)) };
}

const refusal = (p: Promise<unknown>) => p.then(() => 'ok' as const, (e) => { const r = toRelayError(e); return { status: r.status, code: r.code, message: r.message }; });

describe('create-account surcharge (withdrawal to a fresh owner)', () => {
  it('without a surcharge configured the relayer creates nothing: 400 account_creation_disabled, even for a generous fee', async () => {
    const r = await relayer([vault]);
    expect(await refusal(r.prepare(withdrawal(BASE)))).toMatchObject({ status: 400, code: 'account_creation_disabled', message: expect.stringContaining(freshAta.toBase58()) });
    expect(await refusal(r.prepare(withdrawal(BASE + 10n * SURCHARGE)))).toMatchObject({ status: 400, code: 'account_creation_disabled' });
    // to an existing account the same fee is fine
    expect(await refusal((await relayer([vault, freshAta])).prepare(withdrawal(BASE)))).toBe('ok');
  });

  it('with the surcharge, the minimum fee alone is refused (400 fee_too_low naming the surcharge) and fee + surcharge is accepted', async () => {
    const r = await relayer([vault], withSurcharge);
    const low = await refusal(r.prepare(withdrawal(BASE)));
    expect(low).toMatchObject({ status: 400, code: 'fee_too_low' });
    expect((low as { message: string }).message).toContain(SURCHARGE.toString());
    expect((low as { message: string }).message).toContain((BASE + SURCHARGE).toString());
    expect(await refusal(r.prepare(withdrawal(BASE + SURCHARGE - 1n)))).toMatchObject({ code: 'fee_too_low' });
    const p = await r.prepare(withdrawal(BASE + SURCHARGE));
    expect(p.lamports.createdAccounts).toBe(1);
    // the estimate carries the ATA's rent (a 165-byte SPL Token account) and the plan's base fees
    expect(p.lamports.estimate).toBe(rentExempt(165) + p.lamports.transactions * LAMPORTS_PER_SIGNATURE);
    expect(p.lamports.covered).toBe(DEFAULT_STAGING_LAMPORTS + DEFAULT_CREATE_ACCOUNT_LAMPORTS);
    expect(p.plan.final.length).toBeGreaterThan(1);
  });

  it('a missing vault is a created account too: two surcharges when both are missing', async () => {
    const r = await relayer([], withSurcharge);
    expect(await refusal(r.prepare(withdrawal(BASE + SURCHARGE)))).toMatchObject({ code: 'fee_too_low', message: expect.stringContaining('vault') });
    const p = await r.prepare(withdrawal(BASE + 2n * SURCHARGE));
    expect(p.lamports.createdAccounts).toBe(2);
    expect(p.lamports.estimate).toBe(2 * rentExempt(165) + p.lamports.transactions * LAMPORTS_PER_SIGNATURE);
  });

  it('inspect reports the surcharge, the created accounts and the lamport budget as findings', async () => {
    const r = await relayer([vault], withSurcharge);
    const low = await r.inspect(withdrawal(BASE));
    expect(low.ok).toBe(false);
    expect(low.fee.createAccountFee).toBe(SURCHARGE.toString());
    // a price refusal still reports the accounts and the plan it priced
    expect(low.accounts).toMatchObject({ recipientExists: false, vaultExists: true });
    expect(low.plan).toMatchObject({ createdAccounts: 1 });
    expect(low.refusals.map((x) => x.code)).toEqual(['fee_too_low']);
    const over = await (await relayer([vault], { ...withSurcharge, stagingLamports: 0, createAccountLamports: 1 })).inspect(withdrawal(BASE + SURCHARGE));
    expect(over.refusals.map((x) => x.code)).toEqual(['lamport_budget_exceeded']);
    expect(over.plan!.lamports.estimate).toBeGreaterThan(over.plan!.lamports.covered);
    const ok = await r.inspect(withdrawal(BASE + SURCHARGE));
    expect(ok.ok).toBe(true);
    expect(ok.plan).toMatchObject({ createdAccounts: 1, lamports: { estimate: expect.any(Number), covered: DEFAULT_STAGING_LAMPORTS + DEFAULT_CREATE_ACCOUNT_LAMPORTS } });
  });
});

describe('create-account surcharge (spend payout to a wallet without a token account)', () => {
  it('is refused with the minimum fee and accepted with the surcharge; an existing payout account needs none', async () => {
    const none = await relayer([vault]);
    expect(await refusal(none.prepare(spend(BASE)))).toMatchObject({ status: 400, code: 'account_creation_disabled', message: expect.stringContaining('payout account') });
    const r = await relayer([vault], withSurcharge);
    expect(await refusal(r.prepare(spend(BASE)))).toMatchObject({ status: 400, code: 'fee_too_low', message: expect.stringContaining(SURCHARGE.toString()) });
    const p = await r.prepare(spend(BASE + SURCHARGE));
    expect(p.lamports.createdAccounts).toBe(1);
    const existing = await relayer([vault, freshAta]);
    expect(await refusal(existing.prepare(spend(BASE)))).toBe('ok');
  });
});

describe('lamport budget', () => {
  it('refuses a relay whose estimated cost is above what the fee policy covers (400 lamport_budget_exceeded)', async () => {
    // one created account deemed to cover less than its own rent
    const r = await relayer([vault], { ...withSurcharge, createAccountLamports: rentExempt(165) - 1, stagingLamports: 0 });
    expect(await refusal(r.prepare(withdrawal(BASE + SURCHARGE)))).toMatchObject({ status: 400, code: 'lamport_budget_exceeded' });
    // nothing created, but no staging budget at all: the transactions themselves are over
    const zero = await relayer([vault, freshAta], { stagingLamports: 0 });
    expect(await refusal(zero.prepare(withdrawal(BASE)))).toMatchObject({ code: 'lamport_budget_exceeded' });
    // the priority lane's fee cap counts on both sides: it is the lane's own, configured, price
    const lane = { maxInFlight: 1, maxLamports: 4_000_000, priceCeil: 5_000_000 };
    const pri = await relayer([vault, freshAta], { priority: lane });
    const p = await pri.prepare(withdrawal(BASE), { lane: 'priority' });
    expect(p.lamports.estimate).toBe(p.lamports.transactions * (LAMPORTS_PER_SIGNATURE + lane.maxLamports));
    expect(p.lamports.covered).toBe(DEFAULT_STAGING_LAMPORTS + p.lamports.transactions * lane.maxLamports);
  });

  it('rent estimates: SPL Token accounts are 165 bytes; Token-2022 accounts carry ImmutableOwner and the mint\'s required extensions', () => {
    expect(rentExempt(165)).toBe(2_039_280);
    const legacy = { data: new Uint8Array(82), owner: TOKEN_PROGRAM_ID };
    expect(tokenAccountBytes(usd, legacy, TOKEN_PROGRAM_ID)).toBe(165);
    // a Token-2022 mint with no extensions: base account + ImmutableOwner (165 + 1 + 4)
    const bare = { data: new Uint8Array(82), owner: TOKEN_2022_PROGRAM_ID };
    expect(tokenAccountBytes(usd, bare, TOKEN_2022_PROGRAM_ID)).toBe(170);
    // unreadable mint data: the conservative size
    expect(tokenAccountBytes(usd, { data: new Uint8Array(3), owner: TOKEN_2022_PROGRAM_ID }, TOKEN_2022_PROGRAM_ID)).toBe(200);
    expect(DEFAULT_CREATE_ACCOUNT_LAMPORTS).toBeGreaterThan(rentExempt(200));
  });
});

describe('configuration', () => {
  const env = (o: Record<string, string> = {}) => ({
    RELAYER_SOLANA_RPC: 'http://127.0.0.1:9099', RELAYER_SOLANA_KEYPAIR: 'relayer.json', RELAYER_SOLANA_MIN_FEES: `${usd.toBase58()}=1000`,
    RELAYER_SOLANA_TREASURY: treasury.toBase58(), ...o,
  });

  it('reads RELAYER_SOLANA_CREATE_ACCOUNT_FEE per fee mint (default none), the lamport coverage and the circuits directory', () => {
    const none = loadConfig(env()).solana!;
    expect(none.createAccountFees.size).toBe(0);
    expect(none).toMatchObject({ createAccountLamports: DEFAULT_CREATE_ACCOUNT_LAMPORTS, stagingLamports: DEFAULT_STAGING_LAMPORTS, circuitsDir: DEFAULT_CIRCUITS_DIR, vkeySha256: {} });
    const s = loadConfig(env({
      RELAYER_SOLANA_CREATE_ACCOUNT_FEE: `${usd.toBase58()}=400000`, RELAYER_SOLANA_CREATE_ACCOUNT_LAMPORTS: '2200000', RELAYER_SOLANA_STAGING_LAMPORTS: '500000',
      RELAYER_SOLANA_CIRCUITS_DIR: '/keys', RELAYER_VKEY_SHA256_TRANSACT: 'A'.repeat(64),
    })).solana!;
    expect(s.createAccountFees).toEqual(new Map([[usd.toBase58(), 400_000n]]));
    expect(s).toMatchObject({ createAccountLamports: 2_200_000, stagingLamports: 500_000, circuitsDir: '/keys', vkeySha256: { transact: 'a'.repeat(64) } });
    // the x402 circuits directory is the fallback (one bundle, one set of artifacts)
    expect(loadConfig(env({ RELAYER_X402_CIRCUITS_DIR: '/x402' })).solana!.circuitsDir).toBe('/x402');
    expect(() => loadConfig(env({ RELAYER_SOLANA_CREATE_ACCOUNT_FEE: `${Keypair.generate().publicKey.toBase58()}=1` }))).toThrow(/not a fee mint/);
    expect(() => loadConfig(env({ RELAYER_SOLANA_CREATE_ACCOUNT_FEE: 'nope' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ RELAYER_VKEY_SHA256_SPEND: 'xyz' }))).toThrow(/hex sha256/);
    expect(() => loadConfig(env({ RELAYER_SOLANA_CREATE_ACCOUNT_LAMPORTS: '0' }))).toThrow(ConfigError);
  });

  it('wires the surcharge into the relayer and /v1/info; a surcharge for a non-fee mint is refused', async () => {
    const s = loadConfig(env({ RELAYER_SOLANA_CREATE_ACCOUNT_FEE: `${usd.toBase58()}=400000` })).solana!;
    const r = await new SolanaRelayer(solanaRelayerOptions(s, { connection: stubCluster({ programId, mints: [usd] }), payer, verifier: okVerifier })).init();
    expect(r.info()).toMatchObject({
      createAccountFees: { [usd.toBase58()]: '400000' }, createAccountLamports: DEFAULT_CREATE_ACCOUNT_LAMPORTS, stagingLamports: DEFAULT_STAGING_LAMPORTS,
      proofVerification: { vkeySha256: null },
    });
    expect(() => new SolanaRelayer({
      connection: stubCluster({ programId, mints: [usd] }), payer, treasury, minFees: new Map(), createAccountFees: new Map([[usd.toBase58(), 1n]]),
    })).toThrow(/not a fee mint/);
  });
});
