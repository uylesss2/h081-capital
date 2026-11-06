// A relay that fails after staging closes its buffer to get the rent back: the close is retried, and a buffer
// that still holds its rent is logged (address, seed) instead of being forgotten. The relay's own error is
// what the client sees either way.
import { describe, expect, it } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { type RelayIo, SolanaRelayer } from '../../relayer/solana.js';
import { abandonPlan, planOperation } from '../../src/solana/alt.js';
import { vaultPda } from '../../src/solana/pda.js';
import { concatBytes, encodeTransactArgs, encodeTransactExt, extDataHash, toB64 } from '../../src/solana/index.js';
import { stubCluster } from './helpers/cluster.js';

const payer = Keypair.generate();
const programId = Keypair.generate().publicKey;

describe('abandonPlan', () => {
  const plan = planOperation({ programId, authority: payer.publicKey, payload: new Uint8Array(3000).fill(1), op: () => ({ programId, keys: [], data: Buffer.alloc(0) }) as never });
  const open = { getAccountInfo: async () => ({ data: Buffer.alloc(10), owner: programId, lamports: 1, executable: false }) } as unknown as Connection;

  it('retries a failing close and reports a buffer it could not close, without throwing', async () => {
    let calls = 0;
    const flaky = async () => { calls++; if (calls < 3) throw new Error(`blockhash expired ${calls}`); return { signature: 'ok', computeUnits: 1, logs: [] }; };
    expect(await abandonPlan(open, programId, payer, plan, { send: flaky, pauseMs: 0 })).toEqual({ closed: true, attempts: 3 });
    calls = 0;
    const dead = async () => { calls++; throw new Error('node down'); };
    expect(await abandonPlan(open, programId, payer, plan, { send: dead, pauseMs: 0 })).toEqual({ closed: false, attempts: 3, error: 'node down' });
    expect(calls).toBe(3);
    expect(await abandonPlan(open, programId, payer, plan, { send: dead, pauseMs: 0, attempts: 1 })).toMatchObject({ closed: false, attempts: 1 });
  });

  it('a buffer that was never opened (or is already closed) counts as closed without a transaction', async () => {
    const gone = { getAccountInfo: async () => null } as unknown as Connection;
    let sent = 0;
    expect(await abandonPlan(gone, programId, payer, plan, { send: async () => { sent++; return { signature: 's', computeUnits: 0, logs: [] }; } })).toEqual({ closed: true, attempts: 0 });
    expect(sent).toBe(0);
  });
});

describe('SolanaRelayer: a failed relay closes its buffer and logs what it could not close', () => {
  const treasury = Keypair.generate().publicKey;
  const usd = Keypair.generate().publicKey;
  const treasuryAta = getAssociatedTokenAddressSync(usd, treasury, true, TOKEN_PROGRAM_ID);
  const owner = Keypair.generate().publicKey;
  const ata = getAssociatedTokenAddressSync(usd, owner, true, TOKEN_PROGRAM_ID);
  const body = () => {
    const ext = encodeTransactExt({ recipient: ata, relayer: payer.publicKey, feeRecipient: treasuryAta, extAmount: -5_000_000n, fee: 10_000n, encryptedOutputs: [new Uint8Array(100), new Uint8Array(100)] });
    const args = encodeTransactArgs({ root: 11n, publicAmount: 0n, extDataHash: extDataHash(ext), inputNullifiers: [21n, 22n], outputCommitments: [31n, 32n] });
    return { op: 'transact', payload: toB64(concatBytes(new Uint8Array(256).fill(7), args, ext)), mint: usd.toBase58(), recipientOwner: owner.toBase58() };
  };
  const relayer = (io: RelayIo, log: string[]) => new SolanaRelayer({
    connection: stubCluster({ programId, mints: [usd], existing: [ata, vaultPda(programId, usd)] }), payer, treasury, programId,
    minFees: new Map([[usd.toBase58(), 1_000n]]), verifier: { verify: async () => true }, io, log: (l) => log.push(l),
  }).init();

  it('staging failure: 502 staging_failed to the client, the unclosed buffer in the log', async () => {
    const log: string[] = [];
    const abandoned: PublicKey[] = [];
    const io: RelayIo = {
      stagePlan: async () => { throw new Error('rpc timeout'); },
      simulateV0: async () => ({ err: null, logs: [], computeUnits: 1 }),
      sendV0: async () => { throw new Error('not reached'); },
      abandonPlan: async (_c, _p, _k, plan) => { abandoned.push(plan.buffer); return { closed: false, attempts: 3, error: 'node down' }; },
    };
    const r = await relayer(io, log);
    await expect(r.relay(body())).rejects.toMatchObject({ status: 502, code: 'staging_failed', message: 'rpc timeout' });
    expect(abandoned).toHaveLength(1);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(abandoned[0].toBase58());
    expect(log[0]).toContain('staging_failed');
    expect(log[0]).toContain('rent stays locked');
    expect(log[0]).toContain('node down');
  });

  it('simulation failure: a close that succeeds logs nothing; a transport that throws on close is logged too', async () => {
    const log: string[] = [];
    const base: RelayIo = {
      stagePlan: async () => [],
      simulateV0: async () => ({ err: { InstructionError: [0, 'Custom'] }, logs: ['Program log: nope'], computeUnits: 1 }),
      sendV0: async () => { throw new Error('not reached'); },
      abandonPlan: async () => ({ closed: true, attempts: 1 }),
    };
    await expect((await relayer(base, log)).relay(body())).rejects.toMatchObject({ status: 422, code: 'simulation_failed' });
    expect(log).toEqual([]);
    const throwing = { ...base, abandonPlan: async () => { throw new Error('connection reset'); } };
    await expect((await relayer(throwing, log)).relay(body())).rejects.toMatchObject({ status: 422, code: 'simulation_failed' });
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('connection reset');
  });
});
