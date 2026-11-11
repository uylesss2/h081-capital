// The h081 CLI in process: init twice, offline address, --json envelopes, --yes before anything sends, ~ and the
// default key path, the unreachable-RPC message, exit codes, and the README's command list.
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { COMMANDS, main, mcpAddLine, parseArgs } from '../../integrations/agent/src/cli.js';
import { H081, type AgentBank, type OpenOptions } from '../../integrations/agent/src/h081.js';
import { FRESH, stubBank, tempHome } from './agent-helpers.js';

interface Run { code: number; stdout: string; stderr: string; json: any }

async function run(argv: string[], env: NodeJS.ProcessEnv, open?: (o: OpenOptions) => Promise<H081>): Promise<Run> {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { env, stdout: (s) => out.push(s), stderr: (s) => err.push(s), open, platform: 'linux' });
  const stdout = out.join('\n');
  let json: unknown;
  try { json = JSON.parse(stdout); } catch { json = undefined; }
  return { code, stdout, stderr: err.join('\n'), json };
}

async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const noStack = (r: Run) => { expect(r.stderr).not.toMatch(/^\s+at /m); expect(r.stdout).not.toMatch(/^\s+at /m); };

describe('h081 CLI', () => {
  it('init twice: the second run exits 0, keeps the key and prints no stack trace', async () => {
    const home = tempHome();
    const env = { H081_HOME: home };
    const first = await run(['init', '--rpc', 'https://rpc.example.com/v2/abc', '--json'], env);
    expect(first.code).toBe(0);
    expect(first.json).toMatchObject({ ok: true, network: 'mainnet-beta', status: 'done', result: { created: true, keyPath: join(home, 'agent.json'), cluster: 'mainnet-beta', rpcHost: 'rpc.example.com' } });
    expect(first.json.result.addressCode).toMatch(/^h081-address:/);
    expect(first.json.result.mcpAdd).toBe(`claude mcp add --scope user h081 -e H081_SOLANA_KEYPAIR=${join(home, 'agent.json')} -e H081_RPC_URL=https://rpc.example.com/v2/abc -- npx -y @h081lll/agent mcp`);
    const second = await run(['init'], env);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain(`key already exists at ${join(home, 'agent.json')}, keeping it`);
    expect(second.stderr).not.toMatch(/EEXIST/);
    noStack(second);
    expect(second.stdout).toContain(`Agent wallet: ${first.json.result.wallet}`);
    expect(second.stdout).toContain('claude mcp add --scope user h081');
    // config.json keeps the RPC from the first run; the token exists
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ cluster: 'mainnet-beta', rpcUrl: 'https://rpc.example.com/v2/abc', port: 8081 });
    const tok = await run(['token', '--json'], env);
    expect(tok.json.result.token.length).toBeGreaterThan(40);
  });

  it('address works offline (the RPC is never reached) and --json has the envelope', async () => {
    const home = tempHome();
    const env = { H081_HOME: home, H081_RPC_URL: `http://127.0.0.1:${await closedPort()}` };
    await run(['init'], env);
    const r = await run(['address', '--json'], env);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ ok: true, network: 'mainnet-beta', status: 'done', result: { wallet: expect.any(String), addressCode: expect.stringMatching(/^h081-address:[1-9A-HJ-NP-Za-km-z]+$/) } });
    const human = await run(['address'], env);
    expect(human.stdout).toMatch(/^Agent wallet: \w+\nAddress code: h081-address:/);
  });

  it('an unreachable RPC gives "cannot reach the Solana RPC at <host>" (host only), exit 1, the error envelope with --json', async () => {
    const home = tempHome();
    const port = await closedPort();
    const env = { H081_HOME: home, H081_RPC_URL: `http://127.0.0.1:${port}/v2/SECRET-KEY` };
    await run(['init'], { H081_HOME: home });
    const r = await run(['balance', '--json'], env);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, network: 'mainnet-beta', error: { code: 'rpc_unreachable', retryable: true } });
    expect(r.json.error.message).toMatch(new RegExp(`^cannot reach the Solana RPC at 127\\.0\\.0\\.1:${port}: \\S+.*Set H081_RPC_URL\\.$`));
    expect(r.stdout + r.stderr).not.toContain('SECRET-KEY');
    noStack(r);
    const human = await run(['balance'], env);
    expect(human.code).toBe(1);
    expect(human.stderr).toMatch(/^h081: cannot reach the Solana RPC at 127\.0\.0\.1:\d+/);
  });

  it('--yes is needed before anything sends; without it the plan is printed', async () => {
    const home = tempHome();
    const signer = Keypair.generate();
    const bank = stubBank();
    const open = (o: OpenOptions) => H081.open({ ...o, signer, bank: bank as unknown as AgentBank, retryDelayMs: 1 });
    const env = { H081_HOME: home };
    const plan = await run(['deposit', '5'], env, open);
    expect(plan.code).toBe(0);
    expect(plan.stdout).toMatch(/^Plan \(nothing was sent\):/);
    expect(plan.stdout).toMatch(/Add --yes to send it\./);
    const planJson = await run(['withdraw', '2', '--to', FRESH, '--json'], env, open);
    expect(planJson.json).toMatchObject({ ok: true, status: 'plan', result: { op: 'withdraw', fee: '0.05', payout: '1.95' } });
    for (const argv of [['transfer', '1', '--to-code', 'h081-address:x'], ['stake', 'stake', '10'], ['allow', '10', '--daily-cap', '2'], ['lend', 'open', '--pledge-bps', '4000']]) {
      const r = await run(argv, env, open);
      expect(r.code, `${argv.join(' ')}: ${r.stderr}`).toBe(argv[0] === 'transfer' ? 1 : 0); // a bad code is refused before any plan
    }
    expect(bank.deposit).not.toHaveBeenCalled();
    expect(bank.withdraw).not.toHaveBeenCalled();
    expect(bank.stake).not.toHaveBeenCalled();
    expect(bank.lendOpen).toHaveBeenCalledWith({ pledgeBps: 4000n, confirm: false });
    const sent = await run(['deposit', '5', '--yes', '--json'], env, open);
    expect(sent.code).toBe(0);
    expect(sent.json).toMatchObject({ ok: true, status: 'sent', result: { signature: 'sigDeposit', amount: '5000000' } });
    expect(bank.deposit).toHaveBeenCalledTimes(1);
    // each CLI call has its own key; --idempotency-key makes a retry safe
    await run(['deposit', '5', '--yes', '--idempotency-key', 'cli-fixed'], env, open);
    const again = await run(['deposit', '5', '--yes', '--idempotency-key', 'cli-fixed'], env, open);
    expect(again.stdout).toMatch(/^Already sent earlier with this idempotency key \(cli-fixed\)/);
    expect(bank.deposit).toHaveBeenCalledTimes(2);
  });

  it('bad usage exits 2: no command, an unknown one, withdraw without --to, a missing value, a bind flag', async () => {
    const env = { H081_HOME: tempHome() };
    expect((await run([], env)).code).toBe(2);
    expect((await run(['--help'], env)).code).toBe(0);
    expect((await run(['frobnicate'], env)).code).toBe(2);
    const wd = await run(['withdraw', '2'], env);
    expect(wd.code).toBe(2);
    expect(wd.stderr).toMatch(/--to <a wallet that never touched the agent>, or --to self/);
    expect((await run(['withdraw', '2', '--to'], env)).code).toBe(2);
    expect((await run(['serve', '--host', '0.0.0.0'], env)).stderr).toMatch(/127\.0\.0\.1 only/);
    expect((await run(['balance', '--cluster', 'devnet'], env)).code).toBe(2);
    const json = await run(['withdraw', '2', '--json'], env);
    expect(json.json).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(parseArgs(['pay', '1', '--to=abc', '--yes', '--json=false', '-y'])).toEqual({ pos: ['pay', '1'], flags: { to: 'abc', yes: true } });
  });

  describe('~ and the default key path', () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    let fake: string;
    beforeEach(() => {
      fake = tempHome('h081-fakehome-');
      process.env.HOME = fake;
      process.env.USERPROFILE = fake;
      // never touch the real home directory
      if (homedir() !== fake) throw new Error('could not point the home directory at a temporary one');
    });
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    });

    it('--home ~/x expands; H081_SOLANA_KEYPAIR=~/x/agent.json expands; with nothing set the key is ~/.h081/agent.json', async () => {
      const made = await run(['init', '--home', '~/agents/one', '--json'], {});
      expect(made.code).toBe(0);
      expect(made.json.result.keyPath).toBe(join(fake, 'agents', 'one', 'agent.json'));
      const other = join(fake, 'empty');
      mkdirSync(other);
      const viaVar = await run(['address', '--json'], { H081_HOME: other, H081_SOLANA_KEYPAIR: '~/agents/one/agent.json' });
      expect(viaVar.json.result.wallet).toBe(made.json.result.wallet);
      // nothing set and no ~/.h081/agent.json yet: a plain message, not a stack trace
      const none = await run(['address'], {});
      expect(none.code).toBe(1);
      expect(none.stderr).toMatch(/no agent key: run `npx -y @h081lll\/agent init` \(it creates ~\/\.h081\/agent\.json\)/);
      noStack(none);
      const def = await run(['init', '--json'], {});
      expect(def.json.result.keyPath).toBe(join(fake, '.h081', 'agent.json'));
      const viaDefault = await run(['address', '--json'], {});
      expect(viaDefault.json.result.wallet).toBe(def.json.result.wallet);
    });
  });

  it('the claude mcp add line fits the OS; every README command is a CLI command and the reverse', () => {
    expect(mcpAddLine('/home/u/.h081/agent.json', 'https://rpc', 'linux')).toBe('claude mcp add --scope user h081 -e H081_SOLANA_KEYPAIR=/home/u/.h081/agent.json -e H081_RPC_URL=https://rpc -- npx -y @h081lll/agent mcp');
    expect(mcpAddLine('C:\\Users\\Jo Do\\.h081\\agent.json', 'https://rpc', 'win32')).toBe('claude mcp add --scope user h081 -e "H081_SOLANA_KEYPAIR=C:\\Users\\Jo Do\\.h081\\agent.json" -e H081_RPC_URL=https://rpc -- cmd /c npx -y @h081lll/agent mcp');
    const readme = readFileSync('integrations/agent/README.md', 'utf8');
    const firstCells = readme.split('\n').filter((l) => l.startsWith('| `h081 ')).map((l) => l.split(' | ')[0]);
    const listed = new Set(firstCells.flatMap((cell) => [...cell.matchAll(/`h081 ([a-z-]+)/g)].map((m) => m[1])));
    expect([...listed].sort()).toEqual([...COMMANDS].sort());
    for (const m of readme.matchAll(/npx -y @h081lll\/agent ([a-z-]+)/g)) expect(COMMANDS as readonly string[], m[0]).toContain(m[1]);
  });
});
