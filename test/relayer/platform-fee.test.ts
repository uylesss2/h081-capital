// Platform fee and capacity rules of the Solana relayer (in-process, stub connection, no validator, no keys
// on disk): the fee is at least max(minFee, RELAYER_FEE_BPS of the public amount), it goes to the treasury's
// fee account and nowhere else, the treasury is never an H081 launch wallet, and capacity_stake capacity is
// enforced above the free tier.
import { describe, expect, it } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ed25519 } from '@noble/curves/ed25519';
import { ConfigError, DEFAULT_FEE_BPS, LAUNCH_WALLET_DENYLIST, loadConfig } from '../../relayer/config.js';
import { RelayError, toRelayError } from '../../relayer/errors.js';
import {
  CAPACITY_WINDOW_SECS, CapacityGate, SolanaRelayer, capacityMessage, publicAmountOf, requiredFee, solanaRelayerOptions, type CapacityOptions,
} from '../../relayer/solana.js';
import { concatBytes, decodeRelayPayload, encodeSpendArgs, encodeSpendExt, encodeTransactArgs, encodeTransactExt, extDataHash, toB64 } from '../../src/solana/index.js';

const proof = new Uint8Array(256).fill(7);
const payer = Keypair.generate();
const treasury = Keypair.generate().publicKey;
const usd = Keypair.generate().publicKey;
const treasuryAta = getAssociatedTokenAddressSync(usd, treasury, true, TOKEN_PROGRAM_ID);
const relayerAta = getAssociatedTokenAddressSync(usd, payer.publicKey, true, TOKEN_PROGRAM_ID);
const MIN = 1_000n;

/** A mint account's data with `decimals` at byte 44 (SPL Mint layout). */
const mintData = (decimals: number) => { const b = Buffer.alloc(82); b[44] = decimals; return b; };
/** Enough of a Connection for init(): every mint is a 6-decimal SPL Token mint. */
const stubConnection = { getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data: mintData(6), lamports: 1, executable: false }) } as unknown as Connection;

async function relayer(o: { capacity?: CapacityOptions; feeBps?: number } = {}) {
  return new SolanaRelayer({
    connection: stubConnection, payer, treasury, minFees: new Map([[usd.toBase58(), MIN]]), feeBps: o.feeBps, capacity: o.capacity,
  }).init();
}

function withdrawal(o: { amount: bigint; fee: bigint; feeRecipient?: PublicKey }) {
  const ext = encodeTransactExt({
    recipient: Keypair.generate().publicKey, relayer: payer.publicKey, feeRecipient: o.feeRecipient ?? treasuryAta,
    extAmount: -o.amount, fee: o.fee, encryptedOutputs: [new Uint8Array(120).fill(1), new Uint8Array(120).fill(2)],
  });
  const args = encodeTransactArgs({ root: 11n, publicAmount: 0n, extDataHash: extDataHash(ext), inputNullifiers: [21n, 22n], outputCommitments: [31n, 32n] });
  return concatBytes(proof, args, ext);
}

function spend(o: { amount: bigint; fee: bigint; feeRecipient?: PublicKey; lenderAmount?: bigint }) {
  const ext = encodeSpendExt({
    relayer: payer.publicKey, feeRecipient: o.feeRecipient ?? treasuryAta, encryptedAllowance: new Uint8Array(300).fill(3),
    encryptedPayment: new Uint8Array(), encryptedLender: new Uint8Array(),
  });
  const args = encodeSpendArgs({
    root: 11n, nullifier: 41n, newAllowanceCommitment: 42n, payCommitment: 0n, publicAmount: o.amount, publicRecipient: Keypair.generate().publicKey,
    publicAsset: usd, fee: o.fee, timestamp: 1_700_000_000n, receipt: 43n, lenderAmount: o.lenderAmount ?? 0n, lenderAddr: o.lenderAmount ? 5n : 0n, loanRef: o.lenderAmount ? 6n : 0n, isLenderClaim: false,
    extDataHash: extDataHash(ext),
  });
  return concatBytes(proof, args, ext);
}

const body = (op: 'transact' | 'spend', payload: Uint8Array, extra: Record<string, unknown> = {}) =>
  ({ op, payload: toB64(payload), ...(op === 'transact' ? { mint: usd.toBase58() } : {}), ...extra });

/** The RelayError a promise rejects with (PayloadErrors mapped as the server maps them). */
async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string } | 'ok'> {
  try { await p; return 'ok'; } catch (e) { const r = toRelayError(e); return { status: r.status, code: r.code }; }
}

const env = (o: Record<string, string> = {}) => ({
  RELAYER_SOLANA_RPC: 'http://127.0.0.1:9099', RELAYER_SOLANA_KEYPAIR: 'relayer.json', RELAYER_SOLANA_MIN_FEES: `${usd.toBase58()}=1000`,
  RELAYER_SOLANA_TREASURY: treasury.toBase58(), ...o,
});

describe('platform fee: max(minimum, bps of the public amount)', () => {
  it('computes the required fee and the public leg', () => {
    expect(DEFAULT_FEE_BPS).toBe(20);
    expect(requiredFee(MIN, 20, 5_000_000n)).toBe(10_000n); // 0.20% of 5 USDG
    expect(requiredFee(MIN, 20, 100_000n)).toBe(MIN); // tiny amounts pay the minimum
    expect(requiredFee(0n, 20, 4_999n)).toBe(9n); // rounds down
    expect(publicAmountOf(decodeRelayPayload('transact', withdrawal({ amount: 7n, fee: 1n })))).toBe(7n);
    expect(publicAmountOf(decodeRelayPayload('spend', spend({ amount: 9n, fee: 1n })))).toBe(9n);
    // the lender's share also leaves the vault, so it counts
    expect(publicAmountOf(decodeRelayPayload('spend', spend({ amount: 9n, fee: 1n, lenderAmount: 100n })))).toBe(109n);
  });

  it('charges the bps fee on the lender share too: a tiny public amount cannot hide a large lender payout', async () => {
    const r = await relayer();
    const sneaky = spend({ amount: 1n, fee: MIN, lenderAmount: 5_000_000_000n });
    expect(await refusal(r.checkTerms(body('spend', sneaky)))).toEqual({ status: 402, code: 'fee_too_low' });
    expect((await r.checkTerms(body('spend', spend({ amount: 1n, fee: 10_000_001n, lenderAmount: 5_000_000_000n })))).fee).toBe(10_000_001n);
  });

  it('refuses a withdrawal or spend paying less than 20 bps of the public amount (402 fee_too_low)', async () => {
    const r = await relayer();
    expect(await refusal(r.checkTerms(body('transact', withdrawal({ amount: 5_000_000n, fee: 9_999n }))))).toEqual({ status: 402, code: 'fee_too_low' });
    expect(await refusal(r.checkTerms(body('spend', spend({ amount: 5_000_000n, fee: 9_999n }))))).toEqual({ status: 402, code: 'fee_too_low' });
    expect((await r.checkTerms(body('transact', withdrawal({ amount: 5_000_000n, fee: 10_000n })))).fee).toBe(10_000n);
    expect((await r.checkTerms(body('spend', spend({ amount: 5_000_000n, fee: 10_000n })))).fee).toBe(10_000n);
    // the per-mint minimum still applies below the bps threshold
    expect(await refusal(r.checkTerms(body('transact', withdrawal({ amount: 1_000n, fee: 999n }))))).toEqual({ status: 402, code: 'fee_too_low' });
    // the rate is configurable
    const r50 = await relayer({ feeBps: 50 });
    expect(await refusal(r50.checkTerms(body('transact', withdrawal({ amount: 5_000_000n, fee: 10_000n }))))).toEqual({ status: 402, code: 'fee_too_low' });
  });

  it('refuses a fee paid to any account but the treasury fee account (402 wrong_fee_account)', async () => {
    const r = await relayer();
    expect(r.feeAccount(usd).equals(treasuryAta)).toBe(true);
    expect(r.info()).toMatchObject({ treasury: treasury.toBase58(), feeBps: 20, feeAccounts: { [usd.toBase58()]: treasuryAta.toBase58() } });
    const launchAtas = [...LAUNCH_WALLET_DENYLIST].map((w) => getAssociatedTokenAddressSync(usd, new PublicKey(w), true, TOKEN_PROGRAM_ID));
    for (const feeRecipient of [relayerAta, Keypair.generate().publicKey, ...launchAtas, ...[...LAUNCH_WALLET_DENYLIST].map((w) => new PublicKey(w))]) {
      expect(await refusal(r.checkTerms(body('transact', withdrawal({ amount: 5_000_000n, fee: 10_000n, feeRecipient })))))
        .toEqual({ status: 402, code: 'wrong_fee_account' });
      expect(await refusal(r.checkTerms(body('spend', spend({ amount: 5_000_000n, fee: 10_000n, feeRecipient })))))
        .toEqual({ status: 402, code: 'wrong_fee_account' });
    }
  });
});

describe('treasury configuration', () => {
  it('reads RELAYER_FEE_BPS (default 20) and RELAYER_SOLANA_TREASURY', () => {
    expect(loadConfig(env()).solana).toMatchObject({ feeBps: 20, treasury: treasury.toBase58() });
    expect(loadConfig(env({ RELAYER_FEE_BPS: '35' })).solana?.feeBps).toBe(35);
    expect(() => loadConfig(env({ RELAYER_FEE_BPS: '10001' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ RELAYER_FEE_BPS: '-1' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ RELAYER_SOLANA_TREASURY: '' }))).toThrow(/RELAYER_SOLANA_TREASURY/);
    expect(() => loadConfig(env({ RELAYER_SOLANA_TREASURY: 'nope' }))).toThrow(ConfigError);
  });

  it('refuses every H081 launch wallet as the treasury at startup', () => {
    expect(LAUNCH_WALLET_DENYLIST.size).toBe(3);
    for (const w of ['2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP', 'FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ', '5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw']) {
      expect(LAUNCH_WALLET_DENYLIST.has(w)).toBe(true);
      expect(() => loadConfig(env({ RELAYER_SOLANA_TREASURY: w }))).toThrow(/launch wallet/);
      expect(() => new SolanaRelayer({ connection: stubConnection, payer, treasury: new PublicKey(w), minFees: new Map() })).toThrow(/launch wallet/);
    }
  });

  it('reads the capacity settings (free tier default 100 USDG, assets named explicitly)', () => {
    const h081 = Keypair.generate().publicKey.toBase58();
    expect(loadConfig(env()).solana?.capacity).toBeUndefined();
    const assets = { RELAYER_SOLANA_CAPACITY_ASSETS: usd.toBase58() };
    expect(loadConfig(env({ RELAYER_SOLANA_CAPACITY_MINT: h081, ...assets })).solana?.capacity).toEqual({
      programId: undefined, mint: h081, freeTier: 100_000_000n, assets: [usd.toBase58()],
    });
    // no default asset set: the fee mints may include non-6-decimal assets (SOL)
    expect(() => loadConfig(env({ RELAYER_SOLANA_CAPACITY_MINT: h081 }))).toThrow(/RELAYER_SOLANA_CAPACITY_ASSETS/);
    expect(() => loadConfig(env({ RELAYER_SOLANA_CAPACITY_MINT: h081, ...assets, RELAYER_SOLANA_CAPACITY_FREE_TIER: '1.5' }))).toThrow(ConfigError);
  });

  it('main wiring: the configured treasury, fee rate and capacity reach the relayer (no hot-wallet fallback)', async () => {
    const h081 = Keypair.generate().publicKey;
    const s = loadConfig(env({ RELAYER_FEE_BPS: '35', RELAYER_SOLANA_CAPACITY_MINT: h081.toBase58(), RELAYER_SOLANA_CAPACITY_ASSETS: usd.toBase58() })).solana!;
    const r = await new SolanaRelayer(solanaRelayerOptions(s, { connection: stubConnection, payer })).init();
    expect(r.feeOwner.equals(treasury)).toBe(true);
    expect(r.feeAccount(usd).equals(treasuryAta)).toBe(true);
    expect(r.info()).toMatchObject({ treasury: treasury.toBase58(), feeBps: 35, capacity: { freeTier: '100000000', assets: [usd.toBase58()] } });
    expect(r.capacity).toBeDefined();
    // a relayer without a treasury is refused rather than paying its own hot wallet
    expect(() => new SolanaRelayer({ connection: stubConnection, payer, minFees: new Map() } as unknown as ConstructorParameters<typeof SolanaRelayer>[0])).toThrow(/treasury is required/);
  });

  it('refuses a capacity asset without 6 decimals at startup', async () => {
    const nineDecimals = { getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data: mintData(9), lamports: 1, executable: false }) } as unknown as Connection;
    const cap: CapacityOptions = { freeTier: 1n, assets: new Set([usd.toBase58()]), lookup: async () => 0n };
    await expect(new SolanaRelayer({ connection: nineDecimals, payer, treasury, minFees: new Map(), capacity: cap }).init()).rejects.toThrow(/6-decimal/);
  });
});

describe('capacity (capacity_stake)', () => {
  const operator = Keypair.generate();
  const FREE = 100_000_000n; // 100 USDG
  const CAP = 10_000_000_000n; // one shielding unit: 10,000 USDG per 30 days
  const sign = (payload: Uint8Array, kp = operator) => toB64(ed25519.sign(capacityMessage(payload), kp.secretKey.subarray(0, 32)));
  const opts = (now: { t: number }): CapacityOptions => ({
    freeTier: FREE, assets: new Set([usd.toBase58()]), now: () => now.t,
    lookup: async (k) => (k.equals(operator.publicKey) ? CAP : 0n),
  });
  const paid = (amount: bigint) => withdrawal({ amount, fee: requiredFee(MIN, 20, amount) });

  it('relays the free tier anonymously and refuses larger anonymous operations (403 capacity_required)', async () => {
    const r = await relayer({ capacity: opts({ t: 1_000 }) });
    expect((await r.checkTerms(body('transact', paid(FREE)))).capacity).toBeUndefined();
    expect(await refusal(r.checkTerms(body('transact', paid(FREE + 1n))))).toEqual({ status: 403, code: 'capacity_required' });
  });

  it('counts an operator against free tier + shieldCap over 30 days and refuses past it (403 over_capacity)', async () => {
    const now = { t: 1_000 };
    const r = await relayer({ capacity: opts(now) });
    const big = paid(6_000_000_000n);
    const t1 = (await r.checkTerms(body('transact', big, { operator: operator.publicKey.toBase58(), operatorSig: sign(big) }))).capacity;
    expect(t1).toEqual({ operator: operator.publicKey.toBase58(), amount: 6_000_000_000n, limit: FREE + CAP });
    const uncount = r.capacity!.reserve(t1!);
    const more = paid(4_200_000_000n);
    const over = await refusal(r.checkTerms(body('transact', more, { operator: operator.publicKey.toBase58(), operatorSig: sign(more) })));
    expect(over).toEqual({ status: 403, code: 'over_capacity' });
    // a failed relay uncounts its reservation
    uncount();
    expect(r.capacity!.usage(operator.publicKey.toBase58())).toBe(0n);
    r.capacity!.reserve(t1!);
    // after 30 days the volume is forgotten
    now.t += CAPACITY_WINDOW_SECS + 1;
    expect((await r.checkTerms(body('transact', more, { operator: operator.publicKey.toBase58(), operatorSig: sign(more) }))).capacity?.amount).toBe(4_200_000_000n);
  });

  it('an operator with nothing staked only gets the free tier; a wrong signature is refused', async () => {
    const r = await relayer({ capacity: opts({ t: 1_000 }) });
    const nobody = Keypair.generate();
    const p = paid(FREE + 1n);
    expect(await refusal(r.checkTerms(body('transact', p, { operator: nobody.publicKey.toBase58(), operatorSig: sign(p, nobody) }))))
      .toEqual({ status: 403, code: 'over_capacity' });
    // someone else's signature, or a signature over another payload, cannot spend the operator's capacity
    expect(await refusal(r.checkTerms(body('transact', p, { operator: operator.publicKey.toBase58(), operatorSig: sign(p, nobody) }))))
      .toEqual({ status: 400, code: 'bad_operator_sig' });
    expect(await refusal(r.checkTerms(body('transact', p, { operator: operator.publicKey.toBase58(), operatorSig: sign(paid(5n)) }))))
      .toEqual({ status: 400, code: 'bad_operator_sig' });
  });

  it('reserve re-checks so concurrent relays cannot overshoot; an unreadable capacity_stake is a 503', async () => {
    const gate = new CapacityGate(opts({ t: 1_000 }));
    const a = await gate.check(usd, 6_000_000_000n, operator.publicKey);
    const b = await gate.check(usd, 6_000_000_000n, operator.publicKey);
    gate.reserve(a!);
    expect(() => gate.reserve(b!)).toThrow(RelayError);
    // mints that do not count, and operations with no public leg, need no capacity
    expect(await gate.check(Keypair.generate().publicKey, 10n ** 15n, undefined)).toBeUndefined();
    expect(await gate.check(usd, 0n, undefined)).toBeUndefined();
    const broken = new CapacityGate({ ...opts({ t: 0 }), lookup: async () => { throw new Error('config not initialized'); } });
    expect(await refusal(broken.check(usd, FREE + 1n, operator.publicKey))).toEqual({ status: 503, code: 'capacity_unavailable' });
  });
});
