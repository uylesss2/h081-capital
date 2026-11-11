// No response, log line, event, CLI output or ops.jsonl line ever carries the agent key, the shielded spending or
// viewing key, a nullifier key, a sub-account or lender key, a note secret, the API token, or a full RPC URL.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { Account } from '../../src/account.js';
import { initCrypto } from '../../src/crypto.js';
import { main } from '../../integrations/agent/src/cli.js';
import { H081, type AgentBank } from '../../integrations/agent/src/h081.js';
import { encodeAddressCode } from '../../integrations/core/codes.js';
import { MAINNET } from '../../integrations/core/constants.js';
import { deriveAccountSk, deriveAgentSk, deriveLenderSk } from '../../integrations/core/keys.js';
import { FRESH, makeAgent, startGateway, stubBank } from './agent-helpers.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function secretsOf(kp: Keypair): string[] {
  const sk = deriveAccountSk(kp);
  const acct = new Account(sk);
  const seed = kp.secretKey.slice(0, 32);
  const out = [
    bs58.encode(kp.secretKey), bs58.encode(seed), hex(seed), hex(kp.secretKey.slice(32, 64)).length ? hex(kp.secretKey) : '',
    JSON.stringify(Array.from(kp.secretKey)).slice(1, 60), // the agent.json content
    sk.toString(), sk.toString(16), acct.keys.nk.toString(), hex(acct.view.secret), bs58.encode(acct.view.secret),
    deriveAgentSk(kp, 0).toString(), deriveAgentSk(kp, 1).toString(), deriveLenderSk(kp).toString(),
  ];
  return out.filter((s) => s.length >= 16);
}

describe('no secret leaves through the API, the logs, the events, the CLI or ops.jsonl', () => {
  it('a full session over the gateway', async () => {
    await initCrypto();
    const signer = Keypair.generate();
    const bank = stubBank();
    const base = await bank.balance();
    // a bank result with a field the API does not know (e.g. a note): /v1/balance maps fields explicitly and drops it
    bank.balance.mockImplementation(async () => ({ ...base, notes: [{ blinding: 'NOTE-BLINDING-SECRET-123456789', amount: 1n }] }));
    const a = await makeAgent({ signer, bank, env: { H081_RPC_URL: 'https://rpc.example.com/v2/RPC-API-KEY-abcdef' } });
    const g = await startGateway(a.h);
    const seen: string[] = [];
    try {
      // an event stream open through the session
      const stream: string[] = [];
      const req = request({ host: '127.0.0.1', port: g.port, path: '/v1/events', headers: { host: `127.0.0.1:${g.port}`, authorization: `Bearer ${g.token}` } }, (res) => { res.setEncoding('utf8'); res.on('data', (c: string) => stream.push(c)); });
      req.end();
      const addr = encodeAddressCode({ cluster: 'mainnet-beta', program: MAINNET.programs.pool, mint: MAINNET.usdg.mint }, { pk: 5n, viewPub: new Uint8Array(32).fill(2) });
      const calls: Array<[string, string, unknown?, Record<string, string>?]> = [
        ['GET', '/v1/health'], ['GET', '/v1/status'], ['GET', '/v1/address'], ['GET', '/v1/balance?fresh=1'], ['GET', '/v1/fees/withdraw?usdg=2'], ['GET', '/v1/stake'],
        ['POST', '/v1/deposit', { usdg: '5' }], ['POST', '/v1/deposit', { usdg: '5', confirm: true }, { 'idempotency-key': 's-1' }],
        ['POST', '/v1/withdraw', { usdg: '2', to: FRESH }], ['POST', '/v1/withdraw', { usdg: '2', to: 'self', confirm: true }, { 'idempotency-key': 's-2' }],
        ['POST', '/v1/transfer', { usdg: '1', toAddressCode: addr, confirm: true }, { 'idempotency-key': 's-3' }],
        ['POST', '/v1/pay', { usdg: '1', toAddressCode: addr }], ['POST', '/v1/allowances', { budget: '3' }], ['POST', '/v1/codes/check', { code: a.h.address().addressCode }],
        ['GET', '/v1/history'], ['GET', '/v1/openapi.json'], ['GET', '/v1/nope'], ['POST', '/v1/deposit', { usdg: 'x' }],
      ];
      bank.withdraw.mockRejectedValueOnce(new Error('failed: https://rpc.example.com/v2/RPC-API-KEY-abcdef answered 500'));
      for (const [m, p, body, headers] of calls) {
        const r = await g.api(m, p, body, headers);
        seen.push(r.text, JSON.stringify(r.headers));
      }
      await new Promise((r) => setTimeout(r, 50));
      req.destroy();
      seen.push(stream.join(''), g.logs.join('\n'), a.logs.join('\n'), readFileSync(join(a.home, 'ops.jsonl'), 'utf8'));
      // the SDK's own results
      seen.push(JSON.stringify(a.h.status()), JSON.stringify(await a.h.info()), JSON.stringify(a.h.history()));
    } finally {
      await g.close();
    }
    const all = seen.join('\n');
    for (const s of secretsOf(signer)) expect(all.includes(s), `a secret (${s.slice(0, 6)}...) leaked`).toBe(false);
    expect(all).not.toContain(g.token);
    expect(all).not.toContain('NOTE-BLINDING-SECRET');
    expect(all).not.toContain('RPC-API-KEY');
    expect(all).toContain('rpc.example.com'); // the host is fine
    expect(all).toContain(signer.publicKey.toBase58()); // public: the agent wallet
  });

  it('the CLI: init, address, info-like reads, plans and errors print no secret (backup is the one command that does, on purpose)', async () => {
    await initCrypto();
    const { tempHome } = await import('./agent-helpers.js');
    const home = tempHome();
    const out: string[] = [];
    const io = { env: { H081_HOME: home, H081_RPC_URL: 'http://127.0.0.1:9/v2/RPC-API-KEY-xyz' }, stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s) };
    const initOut: string[] = [];
    await main(['init', '--json'], { ...io, stdout: (s) => initOut.push(s), stderr: (s) => initOut.push(s) });
    // init prints the `claude mcp add` line with the RPC URL the user gave it: that line is for them to copy
    expect(initOut.join('\n')).toContain('H081_RPC_URL=http://127.0.0.1:9/v2/RPC-API-KEY-xyz');
    const signer = (await H081.open({ env: io.env, log: () => {}, bank: stubBank() as unknown as AgentBank })).signer;
    for (const argv of [['address'], ['address', '--json'], ['token'], ['deposit', '5'], ['withdraw', '2', '--to', FRESH], ['balance'], ['check', 'h081-address:x'], ['openapi']]) {
      await main(argv, io);
    }
    const all = out.join('\n');
    for (const s of secretsOf(signer)) expect((all + initOut.join('\n')).includes(s), `a secret (${s.slice(0, 6)}...) leaked`).toBe(false);
    expect(all).not.toContain('RPC-API-KEY');
    const b: string[] = [];
    await main(['backup'], { ...io, stdout: (s) => b.push(s) });
    expect(b.join('')).toMatch(/^h081-key:/);
  });
});
