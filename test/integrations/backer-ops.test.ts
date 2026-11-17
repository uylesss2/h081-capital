// h081_back / h081_back_draw and h081_lend fund with a backing code: argument checks, plan-unless-confirm routing,
// operator ceilings and the kind 10 / 11 codes. A mocked bank: nothing touches a network.
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { InputError, runOp, type BankLike } from '../../integrations/core/operations.js';
import { DESCRIPTIONS, EXAMPLE_INPUTS, JSON_SCHEMA, OPS, ZOD } from '../../integrations/core/schemas.js';
import {
  BACKING_PREFIX, CODE_KIND, CodeError, DRAW_KEY_PREFIX, KIND_NAMES, PREFIX_KIND, RESERVED_CODE_KINDS, decodeBackingCode, decodeDrawKeyCode, encodeBackingCode, encodeDrawKeyCode, encodeLoanTerms, frameV2,
} from '../../integrations/core/codes.js';
import { configFromEnv } from '../../integrations/core/constants.js';
import { BackerOps, BACKED_PRIVACY, type BackerHost } from '../../integrations/core/backer.js';
import { BACKING_ACCOUNT_SIZE, DRAW_ACCOUNT_SIZE, backerKeyFor, backingPda, backingVault, drawPda } from '../../src/solana/backer.js';
import { LOCALNET_LOAN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, slotPda } from '../../src/solana/lender.js';
import { createHash } from 'node:crypto';

const ctx = { cluster: 'mainnet-beta', program: '8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4', mint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH' };

function mockBank() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rec = (name: string) => async (req: Record<string, unknown>) => { calls.push([name, req]); return { ok: name }; };
  const bank = {
    decimals: 6, codeContext: ctx,
    backOpen: rec('backOpen'), backStake: rec('backStake'), backStatus: rec('backStatus'), backWithdraw: rec('backWithdraw'), backSettle: rec('backSettle'),
    backClaim: rec('backClaim'), backDrawKey: rec('backDrawKey'), backRequest: rec('backRequest'), backDrawCancel: rec('backDrawCancel'), backRepay: rec('backRepay'),
    backTake: rec('backTake'), backDrawStatus: rec('backDrawStatus'), lendFundBacked: rec('lendFundBacked'), lendFund: rec('lendFund'),
  } as unknown as BankLike;
  return { bank, calls };
}
const backingCode = encodeBackingCode(ctx, { backing: Keypair.generate().publicKey, loanRef: 3n });

describe('h081_back and h081_back_draw are operations', () => {
  it('are registered with a description, a JSON schema, a zod schema and examples that validate', () => {
    for (const op of ['h081_back', 'h081_back_draw'] as const) {
      expect(OPS).toContain(op);
      expect(DESCRIPTIONS[op]).toMatch(/WITHOUT `confirm: true`/);
      expect(JSON_SCHEMA[op].additionalProperties).toBe(false);
      for (const ex of EXAMPLE_INPUTS[op]) expect(ZOD[op].safeParse(ex).success, JSON.stringify(ex)).toBe(true);
    }
    // the description never claims the backer or borrower is hidden
    expect(DESCRIPTIONS.h081_back).toMatch(/links the line\s+to the agent wallet|links the line to the agent wallet/);
    expect(BACKED_PRIVACY).toMatch(/links each line to it/);
  });

  it('plans unless confirm: open, stake, withdraw, close, cancel, forgive reach the bank with confirm false', async () => {
    const { bank, calls } = mockBank();
    await runOp(bank, 'h081_back', { action: 'open', drawKeyCode: 'h081-draw-key:x', feeBps: 500, days: 30, maxAdvanceUsdg: '500' });
    await runOp(bank, 'h081_back', { action: 'stake', nonce: '1', usdg: '600' });
    await runOp(bank, 'h081_back', { action: 'stake', nonce: '1', amount: '1', confirm: true, fromShielded: true });
    await runOp(bank, 'h081_back', { action: 'close', nonce: '1' });
    await runOp(bank, 'h081_back', { action: 'forgive', nonce: '1', loanRef: '3' });
    expect(calls.map(([n, r]) => [n, r.confirm])).toEqual([['backOpen', false], ['backStake', false], ['backStake', true], ['backWithdraw', false], ['backSettle', false]]);
    expect(calls[0][1]).toMatchObject({ maxAdvance: 500_000_000n, feeBps: 500, days: 30 });
    expect(calls[2][1]).toMatchObject({ amount: 1n, fromShielded: true });
    expect(calls[3][1]).toMatchObject({ close: true });
    expect(calls[4][1]).toMatchObject({ mode: 'forgive', loanRef: 3n });
  });

  it('refuses stray, missing and out-of-range fields before anything is sent', async () => {
    const { bank, calls } = mockBank();
    const bad = [
      ['h081_back', { action: 'status', usdg: '1' }],
      ['h081_back', { action: 'open', drawKeyCode: 'x', feeBps: 2001, days: 30, maxAdvanceUsdg: '5' }],
      ['h081_back', { action: 'open', drawKeyCode: 'x', feeBps: 0, days: 181, maxAdvanceUsdg: '5' }],
      ['h081_back', { action: 'open', drawKeyCode: 'x', feeBps: 0, days: 1, coverBps: 1999, maxAdvanceUsdg: '5' }],
      ['h081_back', { action: 'release', nonce: '1' }],
      ['h081_back', { action: 'stake', nonce: '1' }],
      ['h081_back_draw', { action: 'request', backingCode, loanRef: '3', advanceUsdg: '5' }],
      ['h081_back_draw', { action: 'request', backingCode, loanRef: '3', advanceUsdg: '5', days: 3, lenderFeeBps: 2001 }],
      ['h081_back_draw', { action: 'take', lineNonce: '1' }],
      ['h081_back_draw', { action: 'key', confirm: true }],
      ['h081_lend', { action: 'fund', backingCode, proofCode: 'h081-loan-proof:x' }],
      ['h081_lend', { action: 'fund', backingCode, principalUsdg: '5' }],
      ['h081_lend', { action: 'fund', proofCode: 'h081-loan-proof:x', minCoverBps: 10_000 }],
    ] as const;
    for (const [op, args] of bad) await expect(runOp(bank, op, args as Record<string, unknown>), JSON.stringify(args)).rejects.toThrow(InputError);
    expect(calls).toEqual([]);
  });

  it('routes the borrower side and a backed fund', async () => {
    const { bank, calls } = mockBank();
    await runOp(bank, 'h081_back_draw', { action: 'key' });
    await runOp(bank, 'h081_back_draw', { action: 'request', backingCode, loanRef: '3', advanceUsdg: '500', lenderFeeBps: 300, days: 14 });
    await runOp(bank, 'h081_back_draw', { action: 'repay', backingCode, usdg: '540', confirm: true });
    await runOp(bank, 'h081_lend', { action: 'fund', backingCode });
    await runOp(bank, 'h081_lend', { action: 'fund', backingCode, minCoverBps: 5000, planDigest: 'abcdef0123456789', confirm: true });
    expect(calls.map(([n]) => n)).toEqual(['backDrawKey', 'backRequest', 'backRepay', 'lendFundBacked', 'lendFundBacked']);
    expect(calls[0][1]).toEqual({ lineNonce: 1n });
    expect(calls[1][1]).toMatchObject({ advance: 500_000_000n, lenderFeeBps: 300, days: 14, confirm: false });
    expect(calls[2][1]).toMatchObject({ amount: 540_000_000n, confirm: true });
    expect(calls[3][1]).toMatchObject({ confirm: false, minCoverBps: undefined });
    expect(calls[4][1]).toMatchObject({ confirm: true, minCoverBps: 5000 });
  });
});

describe('kinds 10 and 11 in the v2 frame', () => {
  it('round-trip, are letters and digits only, and refuse another kind or network', () => {
    const backing = Keypair.generate().publicKey, drawKey = Keypair.generate().publicKey, payoutTo = Keypair.generate().publicKey;
    const b = encodeBackingCode(ctx, { backing, loanRef: 42n });
    expect(b.startsWith(BACKING_PREFIX)).toBe(true);
    expect(/^[A-Za-z0-9]+$/.test(b.slice(BACKING_PREFIX.length))).toBe(true);
    const back = decodeBackingCode(ctx, `  "${b}"\n`);
    expect([back.backing.equals(backing), back.loanRef]).toEqual([true, 42n]);
    const d = encodeDrawKeyCode(ctx, { drawKey, payoutTo });
    const dk = decodeDrawKeyCode(ctx, d);
    expect([dk.drawKey.equals(drawKey), dk.payoutTo.equals(payoutTo)]).toEqual([true, true]);
    expect([CODE_KIND.backing, CODE_KIND.drawKey, PREFIX_KIND[BACKING_PREFIX], PREFIX_KIND[DRAW_KEY_PREFIX]]).toEqual([10, 11, 10, 11]);
    expect(() => decodeBackingCode(ctx, d)).toThrow(CodeError);
    expect(() => decodeBackingCode({ ...ctx, cluster: 'localnet' }, b)).toThrow(/another network/);
    expect(() => decodeBackingCode(ctx, b.slice(0, -3))).toThrow(CodeError);
    expect(() => decodeDrawKeyCode(ctx, encodeLoanTerms(ctx, { loanRef: 1n, pledgeBps: 4000n, lenderViewPub: new Uint8Array(32) }))).toThrow(/loan terms code|not a draw key code/);
  });
});

describe('the code-kind registry', () => {
  it('every kind is used once, none is a reserved reputation kind (7, 8, 9), and each has a name', () => {
    const kinds = Object.values(CODE_KIND);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(Object.keys(RESERVED_CODE_KINDS).map(Number)).toEqual([7, 8, 9]);
    for (const k of kinds) expect(RESERVED_CODE_KINDS[k], `kind ${k} is reserved`).toBeUndefined();
    for (const k of [...Object.values(PREFIX_KIND)]) expect(KIND_NAMES[k], `kind ${k} has a name`).toBeDefined();
  });
  it('a reputation code (kind 8 or 9) is never read as a backed-line code, even under a backing prefix', () => {
    const body = new Uint8Array(40);
    for (const k of [7, 8, 9]) {
      expect(() => decodeBackingCode(ctx, frameV2(BACKING_PREFIX, k, ctx, body))).toThrow(/not a backing code/);
      expect(() => decodeDrawKeyCode(ctx, frameV2(DRAW_KEY_PREFIX, k, ctx, new Uint8Array(64)))).toThrow(/not a draw key code/);
    }
  });
});

describe('operator ceilings', () => {
  it('H081_MAX_BACK and H081_MAX_DRAW parse as base units', () => {
    const c = configFromEnv({ H081_MAX_BACK: '1000000', H081_MAX_DRAW: '2000000' } as NodeJS.ProcessEnv);
    expect([c.maxBack, c.maxDraw]).toEqual([1_000_000n, 2_000_000n]);
    expect(() => configFromEnv({ H081_MAX_BACK: '1.5' } as NodeJS.ProcessEnv)).toThrow(/H081_MAX_BACK/);
  });

  it('a stake over H081_MAX_BACK (per stake, or the vault after it) is refused before anything is sent', async () => {
    const sk = 777n;
    const key = backerKeyFor(sk, 1n);
    const usdg = Keypair.generate().publicKey;
    const backing = backingPda(key.publicKey, 1n, LOCALNET_LOAN_PROGRAM_ID);
    const vault = backingVault(backing, usdg, SPL_TOKEN_PROGRAM_ID);
    const line = Buffer.alloc(BACKING_ACCOUNT_SIZE);
    createHash('sha256').update('account:Backing').digest().subarray(0, 8).copy(line, 0);
    key.publicKey.toBuffer().copy(line, 8); usdg.toBuffer().copy(line, 8 + 96); SPL_TOKEN_PROGRAM_ID.toBuffer().copy(line, 8 + 128);
    const vaultData = Buffer.alloc(165); vaultData.writeBigUInt64LE(800_000n, 64);
    let sent = 0;
    const connection = {
      getAccountInfo: async (k: PublicKey) => (k.equals(backing) ? { owner: LOCALNET_LOAN_PROGRAM_ID, data: line } : k.equals(vault) ? { owner: SPL_TOKEN_PROGRAM_ID, data: vaultData } : null),
      sendTransaction: async () => { sent++; return 'x'; },
    };
    const host: BackerHost = {
      connection: connection as never, signer: Keypair.generate(), usdg, decimals: 6, account: { keys: { sk } }, loanCodeContext: ctx,
      config: { ...configFromEnv({} as NodeJS.ProcessEnv), loanProgramId: LOCALNET_LOAN_PROGRAM_ID, maxBack: 1_000_000n },
      tokenProgram: async () => SPL_TOKEN_PROGRAM_ID, walletUsdgAccount: async () => Keypair.generate().publicKey, shieldedWithdrawTo: async () => { sent++; return {}; },
    };
    const ops = await new BackerOps(host).prepare();
    await expect(ops.stake({ nonce: 1n, amount: 300_000n, confirm: true })).rejects.toThrow(/H081_MAX_BACK/);
    await expect(ops.stake({ nonce: 1n, amount: 2_000_000n, confirm: true })).rejects.toThrow(/H081_MAX_BACK/);
    const p = await ops.stake({ nonce: 1n, amount: 100_000n });
    expect(p).toMatchObject({ sent: false, dryRun: true });
    expect(sent).toBe(0);
  });
});

describe('h081_lend fund with a backing code: the lender funds exactly the planned terms (B3 through the agent ops)', () => {
  const disc = (s: string) => createHash('sha256').update(s).digest().subarray(0, 8);
  /** A mocked chain with one line and one requested draw on slot 3; `setDraw` re-requests with other terms. */
  function chain(lender: Keypair, usdg: PublicKey) {
    const backer = Keypair.generate().publicKey;
    const backing = backingPda(backer, 1n, LOCALNET_LOAN_PROGRAM_ID);
    const payoutTo = Keypair.generate().publicKey;
    const line = Buffer.alloc(BACKING_ACCOUNT_SIZE);
    disc('account:Backing').copy(line, 0);
    backer.toBuffer().copy(line, 8); usdg.toBuffer().copy(line, 104); SPL_TOKEN_PROGRAM_ID.toBuffer().copy(line, 136);
    line.writeUInt16LE(10_000, 208); line.writeUInt16LE(500, 210); line.writeUInt16LE(500, 212);
    let draw = Buffer.alloc(DRAW_ACCOUNT_SIZE);
    const setDraw = (o: { advance: bigint; backerFee: bigint; lenderFee: bigint; term: bigint }) => {
      draw = Buffer.alloc(DRAW_ACCOUNT_SIZE);
      disc('account:Draw').copy(draw, 0); draw.writeBigUInt64LE(3n, 8); backing.toBuffer().copy(draw, 16); payoutTo.toBuffer().copy(draw, 80);
      draw.writeBigUInt64LE(o.advance, 112); draw.writeBigUInt64LE(o.backerFee, 120); draw.writeBigUInt64LE(o.lenderFee, 128); draw.writeBigUInt64LE(o.advance, 136);
      draw.writeBigUInt64LE(o.term, 144); draw.writeBigInt64LE(9_999_999_999n, 152); draw[176] = 0;
    };
    setDraw({ advance: 100_000_000n, backerFee: 5_000_000n, lenderFee: 1_000_000n, term: 2n * 86_400n });
    const slot = Buffer.alloc(253);
    disc('account:Slot').copy(slot, 0); slot.writeBigUInt64LE(3n, 8); lender.publicKey.toBuffer().copy(slot, 16);
    let sends = 0;
    const connection = {
      getAccountInfo: async (k: PublicKey) => k.equals(backing) ? { owner: LOCALNET_LOAN_PROGRAM_ID, data: line }
        : k.equals(drawPda(backing, 3n, LOCALNET_LOAN_PROGRAM_ID)) ? { owner: LOCALNET_LOAN_PROGRAM_ID, data: draw }
          : k.equals(slotPda(3n, LOCALNET_LOAN_PROGRAM_ID)) ? { owner: LOCALNET_LOAN_PROGRAM_ID, data: slot } : null,
      getLatestBlockhash: async () => { sends++; throw new Error('reached the send step'); },
      sendTransaction: async () => { sends++; throw new Error('reached the send step'); },
      sendRawTransaction: async () => { sends++; throw new Error('reached the send step'); },
    };
    return { backing, connection, setDraw, sends: () => sends };
  }
  function ops(lender: Keypair, usdg: PublicKey, connection: unknown) {
    const host: BackerHost = {
      connection: connection as never, signer: lender, usdg, decimals: 6, account: { keys: { sk: 1n } }, loanCodeContext: ctx,
      config: { ...configFromEnv({} as NodeJS.ProcessEnv), loanProgramId: LOCALNET_LOAN_PROGRAM_ID },
      tokenProgram: async () => SPL_TOKEN_PROGRAM_ID, walletUsdgAccount: async () => Keypair.generate().publicKey, shieldedWithdrawTo: async () => ({}),
    };
    return new BackerOps(host);
  }

  it('the plan returns the exact terms and a planDigest; a confirm without it or with a stale one sends nothing', async () => {
    const lender = Keypair.generate(), usdg = Keypair.generate().publicKey;
    const c = chain(lender, usdg);
    const o = ops(lender, usdg, c.connection);
    const code = encodeBackingCode(ctx, { backing: c.backing, loanRef: 3n });
    const p = await o.lendFund({ backingCode: code }) as { sent: false; plan: Record<string, unknown>; next: string };
    expect(p.sent).toBe(false);
    const digest = p.plan.planDigest as string;
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(p.plan.terms).toMatchObject({ advance: 100_000_000n, principal: 106_000_000n, term: 172_800n, coverBps: 10_000 });
    expect(p.next).toContain(digest);
    await expect(o.lendFund({ backingCode: code, confirm: true })).rejects.toThrow(/planDigest is required/);
    // the borrower cancels and re-requests: the same advance, a 180-day term and a higher lender fee
    c.setDraw({ advance: 100_000_000n, backerFee: 5_000_000n, lenderFee: 5_000_000n, term: 180n * 86_400n });
    await expect(o.lendFund({ backingCode: code, planDigest: digest, confirm: true })).rejects.toThrow(/changed since your plan/);
    expect(c.sends()).toBe(0);
    // with the digest of the new plan it goes on to the send step (the mocked chain stops it there)
    const p2 = await o.lendFund({ backingCode: code }) as { plan: Record<string, unknown> };
    expect(p2.plan.planDigest).not.toBe(digest);
    await expect(o.lendFund({ backingCode: code, planDigest: p2.plan.planDigest as string, confirm: true })).rejects.toThrow(/reached the send step/);
    expect(c.sends()).toBeGreaterThan(0);
  });

  it('the schema requires planDigest to confirm a backed fund, and takes it only with a backing code', async () => {
    const { bank, calls } = mockBank();
    await expect(runOp(bank, 'h081_lend', { action: 'fund', backingCode, confirm: true })).rejects.toThrow(InputError);
    await expect(runOp(bank, 'h081_lend', { action: 'fund', proofCode: 'h081-loan-proof:x', planDigest: '0123456789abcdef' })).rejects.toThrow(InputError);
    await expect(runOp(bank, 'h081_lend', { action: 'fund', backingCode, planDigest: 'xyz', confirm: true })).rejects.toThrow(InputError);
    await runOp(bank, 'h081_lend', { action: 'fund', backingCode, planDigest: '0123456789abcdef', confirm: true });
    expect(calls).toEqual([['lendFundBacked', { backingCode, loanRef: undefined, minCoverBps: undefined, planDigest: '0123456789abcdef', confirm: true }]]);
  });

  it('h081_back open takes maxLenderFeeBps (0..2000) and passes it on', async () => {
    const { bank, calls } = mockBank();
    await runOp(bank, 'h081_back', { action: 'open', drawKeyCode: 'h081-draw-key:x', feeBps: 500, maxLenderFeeBps: 200, days: 30, maxAdvanceUsdg: '500' });
    expect(calls[0][1]).toMatchObject({ maxLenderFeeBps: 200 });
    await expect(runOp(bank, 'h081_back', { action: 'open', drawKeyCode: 'h081-draw-key:x', feeBps: 500, maxLenderFeeBps: 2001, days: 30, maxAdvanceUsdg: '500' })).rejects.toThrow(InputError);
  });
});
