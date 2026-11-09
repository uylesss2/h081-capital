// The agent end to end through the HTTP gateway on a private solana-test-validator, H081_CLUSTER=localnet:
// h081 init (CLI) -> deposit 5 -> fee -> withdraw 2 to a fresh keypair -> transfer 1 to a second agent's address code
// -> balance and history, and a balance.changed event on /v1/events. Real H081Bank, real proofs (build/circuits).
//
// Localnet only, patterned on lend-localnet.test.ts: skipped unless H081_LOCALNET_RPC (or STIPEND_LOAN_RPC) names a
// loopback RPC whose validator loads stipend_pool at the localnet id (npm run solana:localnet or test:solana:loan
// start one). With H081_AGENT_TEST_RELAYER_URL (a local relayer for that validator) withdrawals go through it;
// without it no relayer is configured and the agent key sends the withdrawal. Nothing touches a public cluster.
import { request } from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { initCrypto } from '../../src/crypto.js';
import { Prover } from '../../src/prover.js';
import { LOCALNET_POOL_PROGRAM_ID, SolanaPool, send } from '../../src/solana/index.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, associatedTokenAddress } from '../../src/solana/lender.js';
import { LOCALNET_UPGRADE_AUTHORITY } from '../solana/config-authority.js';
import { H081Bank } from '../../integrations/core/bank.js';
import { MAINNET_GENESIS } from '../../integrations/core/constants.js';
import { deriveAccountSk } from '../../integrations/core/keys.js';
import { fromUnits } from '../../integrations/core/units.js';
import { main } from '../../integrations/agent/src/cli.js';
import { H081, type AgentBank } from '../../integrations/agent/src/h081.js';
import { newToken } from '../../integrations/agent/src/home.js';
import { startServer, type RunningServer } from '../../integrations/agent/src/server.js';
import { call, tempHome } from './agent-helpers.js';

const RPC = process.env.H081_LOCALNET_RPC ?? process.env.STIPEND_LOAN_RPC;
// localnet only: refuse anything that is not a loopback RPC, even when the variable is set
const LOCAL = !!RPC && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC);
const RELAYER = process.env.H081_AGENT_TEST_RELAYER_URL;
const suite = describe.skipIf(!LOCAL);

const U = 1_000_000n;
const connection = new Connection(RPC ?? 'http://127.0.0.1:8999', 'confirmed');

async function airdrop(k: PublicKey, sol = 5) {
  const sig = await connection.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, 'confirmed');
}
async function tokenBalance(account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account, 'confirmed');
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}
function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
function mintToIx(mint: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint) {
  const data = Buffer.alloc(9); data[0] = 7; data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: SPL_TOKEN_PROGRAM_ID, keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }], data });
}
async function createMint(authority: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const data = Buffer.alloc(67); data[0] = 20; data[1] = 6; authority.publicKey.toBuffer().copy(data, 2);
  await send(connection, authority, [
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports: await connection.getMinimumBalanceForRentExemption(82), space: 82, programId: SPL_TOKEN_PROGRAM_ID }),
    new TransactionInstruction({ programId: SPL_TOKEN_PROGRAM_ID, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data }),
  ], { signers: [mint] });
  return mint.publicKey;
}

async function cli(argv: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  const code = await main(argv, { env, stdout: (s) => out.push(s), stderr: () => {} });
  return { code, json: JSON.parse(out.join('\n')) };
}

/** An H081 over a real H081Bank with the build-tree prover (as lend-localnet does). */
async function openAgent(env: NodeJS.ProcessEnv): Promise<H081> {
  let h!: H081;
  h = await H081.open({
    env, log: () => {}, pollSeconds: 1,
    bank: async () => (await H081Bank.open({ config: h.config, signer: h.signer, accountSk: deriveAccountSk(h.signer), prover: new Prover(), cacheDir: null })) as unknown as AgentBank,
  });
  return h;
}

suite('the agent through the HTTP gateway on localnet (H081_CLUSTER=localnet)', () => {
  const authority = Keypair.generate();
  const fresh = Keypair.generate();
  let usdg: PublicKey;
  let envA: NodeJS.ProcessEnv;
  let envB: NodeJS.ProcessEnv;
  let walletA: PublicKey;
  let codeB: string;
  let srv: RunningServer;
  let token: string;
  let A: H081;
  const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(srv.port, method, path, {
    body, headers: { host: `127.0.0.1:${srv.port}`, authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  });

  beforeAll(async () => {
    await initCrypto();
    if (await connection.getGenesisHash() === MAINNET_GENESIS) throw new Error('refusing: this RPC is mainnet');
    if (!(await connection.getAccountInfo(LOCALNET_POOL_PROGRAM_ID))?.executable) throw new Error(`stipend_pool is not loaded on ${RPC}`);
    await airdrop(authority.publicKey, 10);
    await airdrop(LOCALNET_UPGRADE_AUTHORITY.publicKey, 2);
    await new SolanaPool(connection).initialize(LOCALNET_UPGRADE_AUTHORITY);
    usdg = await createMint(authority);
    const base = { H081_CLUSTER: 'localnet', H081_RPC_URL: RPC!, H081_USDG_MINT: usdg.toBase58(), H081_RELAYER_URL: RELAYER ?? '' };
    envA = { ...base, H081_HOME: tempHome('h081-local-a-') };
    envB = { ...base, H081_HOME: tempHome('h081-local-b-') };
    // h081 init, offline, for both agents
    const a = await cli(['init', '--cluster', 'localnet', '--rpc', RPC!, '--json'], envA);
    const b = await cli(['init', '--cluster', 'localnet', '--rpc', RPC!, '--json'], envB);
    expect(a.code).toBe(0);
    expect(a.json.result).toMatchObject({ created: true, cluster: 'localnet' });
    walletA = new PublicKey(a.json.result.wallet);
    codeB = b.json.result.addressCode;
    // fund agent A: SOL and 20 test USDG
    await airdrop(walletA, 2);
    await send(connection, authority, [createAtaIx(authority.publicKey, walletA, usdg), mintToIx(usdg, associatedTokenAddress(walletA, usdg), authority.publicKey, 20n * U)]);
    A = await openAgent(envA);
    token = newToken();
    srv = await startServer({ h081: A, token, port: 0, log: () => {} });
  });

  it('deposit 5, fee, withdraw 2 to a fresh keypair, transfer 1 to another agent, balance, history, and a balance.changed event', async () => {
    const events: string[] = [];
    const sse = request({ host: '127.0.0.1', port: srv.port, path: '/v1/events', headers: { host: `127.0.0.1:${srv.port}`, authorization: `Bearer ${token}` } }, (res) => { res.setEncoding('utf8'); res.on('data', (c: string) => events.push(c)); });
    sse.end();
    try {
      expect((await api('GET', '/v1/health')).json.result.network).toBe('localnet');
      const plan = await api('POST', '/v1/deposit', { usdg: '5' });
      expect(plan.json.status).toBe('plan');
      const dep = await api('POST', '/v1/deposit', { usdg: '5', confirm: true }, { 'idempotency-key': 'loc-dep' });
      expect(dep.status, dep.text).toBe(200);
      expect(dep.json).toMatchObject({ status: 'sent', network: 'localnet', result: { amount: '5000000', shielded: '5000000' } });

      const fee = await api('GET', '/v1/fees/withdraw?usdg=2');
      expect(fee.status, fee.text).toBe(200);
      const wd = await api('POST', '/v1/withdraw', { usdg: '2', to: fresh.publicKey.toBase58(), confirm: true }, { 'idempotency-key': 'loc-wd' });
      expect(wd.status, wd.text).toBe(200);
      const received = BigInt(wd.json.result.received);
      expect(received).toBe(2n * U - BigInt(wd.json.result.fee));
      // the fee charged is the one quoted (0 when no relayer is configured)
      expect(fromUnits(BigInt(wd.json.result.fee), 6)).toBe(fee.json.result.fee);
      expect(wd.json.result.via).toBe(RELAYER ? 'relayer' : 'direct');
      expect(await tokenBalance(associatedTokenAddress(fresh.publicKey, usdg))).toBe(received);
      // replaying the same key sends nothing more
      expect((await api('POST', '/v1/withdraw', { usdg: '2', to: fresh.publicKey.toBase58(), confirm: true }, { 'idempotency-key': 'loc-wd' })).json.replayed).toBe(true);
      expect(await tokenBalance(associatedTokenAddress(fresh.publicKey, usdg))).toBe(received);

      const tr = await api('POST', '/v1/transfer', { usdg: '1', toAddressCode: codeB, confirm: true }, { 'idempotency-key': 'loc-tr' });
      expect(tr.status, tr.text).toBe(200);
      expect(tr.json.result).toMatchObject({ to: 'shielded', amount: '1000000' });

      const bal = await api('GET', '/v1/balance?fresh=1');
      expect(bal.json.result.shielded).toBe('2');
      const hist = await api('GET', '/v1/history');
      expect(hist.json.result.items.map((i: { kind: string; state: string }) => `${i.kind}:${i.state}`)).toEqual(['transfer:done', 'withdraw:done', 'deposit:done']);

      // the second agent sees the transfer in its own shielded balance
      const B = await openAgent(envB);
      expect((await B.balance({ fresh: true })).shielded).toBe('1');

      // the background sync noticed a change while the stream was open
      for (let i = 0; i < 60 && !events.join('').includes('event: balance.changed'); i++) await new Promise((r) => setTimeout(r, 500));
      expect(events.join('')).toContain('event: balance.changed');
      expect(events.join('')).toContain('event: op.completed');
    } finally {
      sse.destroy();
      await srv.close();
    }
  });
});
