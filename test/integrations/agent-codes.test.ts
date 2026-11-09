// "h081-key:" backup codes (CLI backup / restore), /v1/codes/check, and untrusted codes refused before use.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { main } from '../../integrations/agent/src/cli.js';
import { checkCode } from '../../integrations/agent/src/h081.js';
import { decodeKeyCode, encodeAddressCode, encodeKeyCode, encodeLoanTerms } from '../../integrations/core/codes.js';
import { MAINNET, configFromEnv } from '../../integrations/core/constants.js';
import { makeAgent, startGateway, tempHome, type AgentSetup, type Gateway } from './agent-helpers.js';

const pool = { cluster: 'mainnet-beta', program: MAINNET.programs.pool, mint: MAINNET.usdg.mint };
const loan = { cluster: 'mainnet-beta', program: MAINNET.programs.loan, mint: MAINNET.usdg.mint };
const localMint = Keypair.generate().publicKey.toBase58();
const localEnv = { H081_CLUSTER: 'localnet', H081_RPC_URL: 'http://127.0.0.1:8999', H081_USDG_MINT: localMint };

async function cli(argv: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { env, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  let json: any;
  try { json = JSON.parse(out.join('\n')); } catch { json = undefined; }
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), json };
}

describe('h081-key: codes', () => {
  it('round-trip: backup prints the code once with the warning; restore checks it and writes the same key', async () => {
    const home = tempHome();
    const made = await cli(['init', '--json'], { H081_HOME: home });
    const backup = await cli(['backup'], { H081_HOME: home });
    expect(backup.code).toBe(0);
    expect(backup.stdout).toMatch(/^h081-key:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(backup.stderr).toContain('Anyone with this code controls the agent\'s funds. Store it offline.');
    const other = tempHome();
    const restored = await cli(['restore', backup.stdout, '--json'], { H081_HOME: other });
    expect(restored.code).toBe(0);
    expect(restored.stderr).toContain('check: agent key code, mainnet-beta, checksum ok');
    expect(restored.json.result.wallet).toBe(made.json.result.wallet);
    expect((await cli(['address', '--json'], { H081_HOME: other })).json.result).toEqual({ wallet: made.json.result.wallet, addressCode: made.json.result.addressCode });
    // never replaces a key without --force
    const again = await cli(['restore', backup.stdout], { H081_HOME: other });
    expect(again.code).toBe(2);
    expect(again.stderr).toMatch(/key already exists at .*agent\.json; keeping it/);
    expect((await cli(['restore', backup.stdout, '--force'], { H081_HOME: other })).code).toBe(0);
  });

  it('a wrong network, a bad checksum or another kind is refused, and nothing is written', async () => {
    const seed = Keypair.generate().secretKey.slice(0, 32);
    const code = encodeKeyCode(pool, seed);
    const localCtx = { cluster: 'localnet', program: configFromEnv(localEnv).poolProgramId.toBase58(), mint: localMint };
    expect(() => decodeKeyCode(localCtx, code)).toThrow(/another network/);
    const home = tempHome();
    const wrongNet = await cli(['restore', encodeKeyCode(localCtx, seed)], { H081_HOME: home });
    expect(wrongNet.code).toBe(1);
    expect(wrongNet.stderr).toMatch(/check: That agent key code is for another network/);
    const flipped = code.slice(0, -1) + (code.endsWith('2') ? '3' : '2');
    const bad = await cli(['restore', flipped, '--json'], { H081_HOME: home });
    expect(bad.code).toBe(1);
    expect(bad.json.error).toMatchObject({ code: 'invalid_code', retryable: false });
    const kind = await cli(['restore', encodeAddressCode(pool, { pk: 5n, viewPub: new Uint8Array(32) })], { H081_HOME: home });
    expect(kind.code).toBe(1);
    expect(kind.stderr).toMatch(/"h081-address:" code, not a agent key code|not a agent key code/);
    expect((await cli(['address'], { H081_HOME: home })).code).toBe(1); // still no key
  });
});

describe('/v1/codes/check and h081 check', () => {
  let a: AgentSetup;
  let g: Gateway;
  beforeAll(async () => { a = await makeAgent(); g = await startGateway(a.h); });
  afterAll(async () => { await g.close(); });

  it('says the kind, the network and whether it is valid here', async () => {
    const addr = encodeAddressCode(pool, { pk: 9n, viewPub: new Uint8Array(32).fill(3) });
    expect((await g.api('POST', '/v1/codes/check', { code: addr })).json.result).toEqual({ kind: 'address', network: 'mainnet-beta', valid: true });
    expect((await g.api('POST', '/v1/codes/check', { code: `  "${addr}".` })).json.result.valid).toBe(true); // what copying adds
    const terms = encodeLoanTerms(loan, { loanRef: 1n, pledgeBps: 4000n, lenderViewPub: new Uint8Array(32) });
    expect((await g.api('POST', '/v1/codes/check', { code: terms })).json.result).toEqual({ kind: 'loan-terms', network: 'mainnet-beta', valid: true });
    expect((await g.api('POST', '/v1/codes/check', { code: encodeKeyCode(pool, new Uint8Array(32).fill(1)) })).json.result).toMatchObject({ kind: 'key', valid: true });
    const broken = await g.api('POST', '/v1/codes/check', { code: addr.slice(0, -4) });
    expect(broken.status).toBe(200);
    expect(broken.json.result).toMatchObject({ kind: 'address', network: null, valid: false });
    expect(broken.json.result.reason).toMatch(/built-in check|too short/);
    expect((await g.api('POST', '/v1/codes/check', { code: 'hello' })).json.result).toMatchObject({ kind: null, valid: false });
    expect((await g.api('POST', '/v1/codes/check', { code: 'h081-nope:abc' })).json.result).toMatchObject({ kind: null, valid: false });
    expect((await g.api('POST', '/v1/codes/check', {})).status).toBe(400);
  });

  it('a code made for another network is refused (a localnet code on mainnet, a mainnet code on localnet)', () => {
    const local = configFromEnv(localEnv);
    const localAddr = encodeAddressCode({ cluster: 'localnet', program: local.poolProgramId.toBase58(), mint: localMint }, { pk: 9n, viewPub: new Uint8Array(32) });
    expect(checkCode(configFromEnv({}), localAddr)).toMatchObject({ kind: 'address', network: 'unknown', valid: false, reason: expect.stringMatching(/another network/) });
    const mainAddr = encodeAddressCode(pool, { pk: 9n, viewPub: new Uint8Array(32) });
    expect(checkCode(local, mainAddr)).toMatchObject({ kind: 'address', network: 'mainnet-beta', valid: false });
    expect(checkCode(local, localAddr)).toEqual({ kind: 'address', network: 'localnet', valid: true });
  });

  it('every code a write takes is checked before use: a bad one is 400 invalid_code and the bank never sees it', async () => {
    const r = await g.api('POST', '/v1/transfer', { usdg: '1', toAddressCode: 'h081-address:3vQB7B6MrGQZaxCuFg4oh', confirm: true }, { 'idempotency-key': 'bad-code' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'invalid_code', retryable: false });
    const local = configFromEnv(localEnv);
    const foreign = encodeAddressCode({ cluster: 'localnet', program: local.poolProgramId.toBase58(), mint: localMint }, { pk: 9n, viewPub: new Uint8Array(32) });
    const f = await g.api('POST', '/v1/pay', { usdg: '1', toAddressCode: foreign });
    expect(f.status).toBe(400);
    expect(f.json.error.message).toMatch(/another network/);
    const wrongKind = await g.api('POST', '/v1/transfer', { usdg: '1', toAddressCode: encodeLoanTerms(loan, { loanRef: 1n, pledgeBps: 4000n, lenderViewPub: new Uint8Array(32) }) });
    expect(wrongKind.json.error.code).toBe('invalid_code');
    expect((await g.api('POST', '/v1/loans/borrow', { termsCode: 'h081-loan-terms:zzz', days: 1, unlockDays: 1 })).json.error.code).toBe('invalid_code');
    expect((await g.api('POST', '/v1/loans/lend', { action: 'fund', proofCode: 'h081-loan-proof:zzz' })).json.error.code).toBe('invalid_code');
    expect(a.bank.transfer).not.toHaveBeenCalled();
    expect(a.bank.pay).not.toHaveBeenCalled();
    expect(a.bank.borrow).not.toHaveBeenCalled();
    expect(a.bank.lendFund).not.toHaveBeenCalled();
    // the CLI check
    const out: string[] = [];
    expect(await main(['check', 'h081-address:3vQB7B6MrGQZaxCuFg4oh'], { env: { H081_HOME: tempHome() }, stdout: (s) => out.push(s), stderr: () => {} })).toBe(1);
    expect(out.join('')).toMatch(/^not valid \(address code\)/);
  });
});
