// H081Bank.transfer (h081_transfer) over the fake chain, the RPC-unreachable message from H081Bank.open, the
// "h081-key:" backup code, and localnet config defaults. Nothing is proven or sent.
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Prover } from '../../src/prover.js';
import { H081Bank } from '../../integrations/core/bank.js';
import { CODE_KIND, CodeError, decodeKeyCode, encodeAddressCode, encodeKeyCode } from '../../integrations/core/codes.js';
import { configFromEnv } from '../../integrations/core/constants.js';
import { RpcUnreachableError, classify } from '../../integrations/core/errors.js';
import { deriveAccountSk } from '../../integrations/core/keys.js';
import { runOp } from '../../integrations/core/operations.js';
import { fakeConnection, testConfig } from './helpers.js';

const noProver = new Prover('C:/nonexistent');

async function open(signer: Keypair, chain: Parameters<typeof fakeConnection>[1] = {}) {
  const conn = fakeConnection(signer, chain);
  const bank = await H081Bank.open({ config: testConfig(), signer, accountSk: deriveAccountSk(signer), connection: conn as unknown as Connection, prover: noProver, cacheDir: null });
  return { bank, conn };
}

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe('H081Bank.transfer', () => {
  it('pays an address code from the main balance; checks the code, the balance, SOL and the circuit before anything is sent', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer);
    const other = await open(Keypair.generate());
    const code = other.bank.shieldedAddressCode();
    vi.spyOn(bank.owner, 'sync').mockResolvedValue(undefined);
    const bal = vi.spyOn(bank.owner, 'balance').mockReturnValue(5_000_000n);
    const send = vi.spyOn(bank.owner, 'transfer').mockResolvedValue({ tx: { signature: 'sigT', computeUnits: 1, logs: [] }, proof: {} as never });
    (bank as unknown as { requireArtifacts: () => Promise<void> }).requireArtifacts = async () => {};

    // a code for another network is refused before anything else
    const foreign = encodeAddressCode({ ...bank.codeContext, cluster: 'localnet' }, other.bank.account.address);
    await expect(bank.transfer(1_000_000n, foreign)).rejects.toThrow(CodeError);
    await expect(bank.transfer(1_000_000n, foreign)).rejects.toThrow(/another network/);
    // a damaged code
    await expect(bank.transfer(1_000_000n, code.slice(0, -3) + 'zzz')).rejects.toThrow(/built-in check/);
    // its own address
    await expect(bank.transfer(1_000_000n, bank.shieldedAddressCode())).rejects.toThrow(/own shielded address/);
    // more than the shielded balance
    await expect(bank.transfer(6_000_000n, code)).rejects.toThrow(/the shielded balance is 5 USDG, less than 6/);
    expect(send).not.toHaveBeenCalled();

    const r = await runOp(bank, 'h081_transfer', { usdg: '2', toAddressCode: code }) as { signature: string; amount: bigint; to: string; via: string };
    expect(r).toMatchObject({ signature: 'sigT', amount: 2_000_000n, to: 'shielded', via: 'direct' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe(2_000_000n);
    expect(send.mock.calls[0][2].pk).toBe(other.bank.account.address.pk);
    bal.mockRestore();
  });

  it('refuses without about 0.02 SOL (needs_sol) and names it', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer, { lamports: Math.round(0.001 * LAMPORTS_PER_SOL) });
    const other = await open(Keypair.generate());
    vi.spyOn(bank.owner, 'sync').mockResolvedValue(undefined);
    vi.spyOn(bank.owner, 'balance').mockReturnValue(5_000_000n);
    const send = vi.spyOn(bank.owner, 'transfer');
    const e = await bank.transfer(1_000_000n, other.bank.shieldedAddressCode()).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/holds 0\.0010 SOL; a transfer the agent key sends needs about 0\.02 SOL/);
    expect(classify(e)).toMatchObject({ code: 'needs_sol', status: 409, retryable: false, details: { needSol: '0.02' } });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('H081Bank.open against an RPC that is not there', () => {
  it('says "cannot reach the Solana RPC at <host>" with only the host, as rpc_unreachable', async () => {
    const port = await closedPort();
    const signer = Keypair.generate();
    const rpcUrl = `http://127.0.0.1:${port}/v2/secret-api-key?api-key=also-secret`;
    const e = await H081Bank.open({ config: testConfig({ rpcUrl }), signer, accountSk: deriveAccountSk(signer), prover: noProver, cacheDir: null }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(RpcUnreachableError);
    expect((e as Error).message).toMatch(new RegExp(`^cannot reach the Solana RPC at 127\\.0\\.0\\.1:${port}: \\S+.*\\. Set H081_RPC_URL\\.$`));
    expect((e as Error).message).not.toMatch(/secret/);
    expect(classify(e)).toMatchObject({ code: 'rpc_unreachable', status: 502, retryable: true });
  });
});

describe('"h081-key:" backup code', () => {
  const ctx = { cluster: 'mainnet-beta', program: 'E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM', mint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH' };
  it('round-trips the 32-byte seed and refuses another network, a bad checksum and another kind', () => {
    const kp = Keypair.generate();
    const seed = kp.secretKey.slice(0, 32);
    const code = encodeKeyCode(ctx, seed);
    expect(code).toMatch(/^h081-key:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(Keypair.fromSeed(decodeKeyCode(ctx, code)).publicKey.equals(kp.publicKey)).toBe(true);
    expect(() => decodeKeyCode({ ...ctx, cluster: 'localnet' }, code)).toThrow(/another network/);
    expect(() => decodeKeyCode(ctx, code.slice(0, -2) + (code.endsWith('1') ? '22' : '11'))).toThrow(/built-in check/);
    expect(() => decodeKeyCode(ctx, encodeAddressCode(ctx, { pk: 5n, viewPub: new Uint8Array(32) }))).toThrow(/"h081-address:" code, not a agent key code|not a/);
    expect(CODE_KIND.key).toBe(6);
  });
});

describe('configFromEnv', () => {
  it('accepts mainnet-beta and localnet only; localnet needs an RPC and a mint, defaults to the localnet ids and no relayer', () => {
    expect(configFromEnv({}).cluster).toBe('mainnet-beta');
    expect(() => configFromEnv({ H081_CLUSTER: 'devnet' })).toThrow(/mainnet-beta or localnet/);
    expect(() => configFromEnv({ H081_CLUSTER: 'localnet' })).toThrow(/H081_RPC_URL/);
    expect(() => configFromEnv({ H081_CLUSTER: 'localnet', H081_RPC_URL: 'http://127.0.0.1:8999' })).toThrow(/H081_USDG_MINT/);
    const mint = Keypair.generate().publicKey.toBase58();
    const c = configFromEnv({ H081_CLUSTER: 'localnet', H081_RPC_URL: 'http://127.0.0.1:8999', H081_USDG_MINT: mint });
    expect(c.relayerUrl).toBeUndefined();
    expect(c.poolProgramId.toBase58()).not.toBe('E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM');
    expect(c.usdgMint.toBase58()).toBe(mint);
    expect(configFromEnv({ H081_HOME: '/tmp/h081-x' }).circuitsDir.replace(/\\/g, '/')).toMatch(/\/tmp\/h081-x\/circuits$/);
  });
});
