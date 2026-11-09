// `h081`: the H081 private bank from the command line, the local API (h081 serve) and the MCP server (h081 mcp).
// Every command that sends anything prints the plan and sends nothing unless --yes is given. --json prints the same
// envelope as the API on stdout; logs go to stderr. Exit codes: 0 ok, 1 error, 2 bad usage.
import './quiet.js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { initCrypto } from '../../../src/crypto.js';
import { Account } from '../../../src/account.js';
import { fetchCircuits, verifyCircuits, circuitsSize } from '../../core/circuits.js';
import { decodeKeyCode, encodeAddressCode, encodeKeyCode } from '../../core/codes.js';
import { AGENT_CIRCUITS, CLUSTERS, NOTICE, configFromEnv, rpcHost } from '../../core/constants.js';
import { classify } from '../../core/errors.js';
import { accountSkFromEnv, loadKeypair, parseSecret } from '../../core/keys.js';
import type { BankLike } from '../../core/operations.js';
import { createServer as createMcpServer } from '../../mcp/src/server.js';
import { checkCode, H081, type OpenOptions, type Outcome, type Plan, VERSION, poolContext } from './h081.js';
import { effectiveEnv, ensureHome, ensureToken, homePaths, readFileConfig, rotateToken, writeFileConfig, writePrivate } from './home.js';
import { buildOpenApi } from './openapi.js';
import { ROUTES, startServer } from './server.js';

export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
export const KEY_WARNING = 'Anyone with this code controls the agent\'s funds. Store it offline.';

/** Every command, as the README lists them (the site's quickstart test checks its commands against this). */
export const COMMANDS = [
  'init', 'address', 'info', 'fetch-circuits', 'balance', 'history', 'deposit', 'withdraw', 'fee', 'pay', 'transfer', 'allow', 'reclaim',
  'loan', 'lend', 'stake', 'check', 'serve', 'token', 'backup', 'restore', 'openapi', 'mcp',
] as const;

const USAGE = `h081 ${VERSION}: the H081 private bank on this machine (SDK, CLI, local API, MCP)

usage: h081 <command> [options]

  init [--rpc <url>] [--cluster mainnet-beta|localnet]   create ~/.h081/agent.json, config.json and api-token (offline)
  address                                       the agent wallet and its h081-address: code (offline)
  info                                          protocol facts, key source, RPC host, SOL needed
  fetch-circuits                                download the proving files (about 98 MB, hash-checked)
  balance [--fresh]                             shielded and wallet balances, allowances
  history [--limit N] [--after <id>]            what this machine sent
  deposit <usdg> [--yes]                        wallet USDG into the shielded account
  withdraw <usdg> --to <wallet|self> [--direct] [--yes]
  fee <usdg>                                    the withdraw fee quote
  pay <usdg> (--to <wallet> | --to-code <h081-address:...>) [--allowance <id>] [--yes]
  transfer <usdg> --to-code <h081-address:...> [--yes]
  allow <usdg> [--daily-cap X] [--max-per-tx X] [--days N] [--unlock-days N] [--agent-index N] [--to-code C] [--yes]
  reclaim <id> [--yes]
  loan quote <termsCode> [--principal X]
  loan borrow <termsCode> --days N --unlock-days N [--principal X] [--budget X] [--yes]
  lend open --pledge-bps N | fund <proofCode> [--principal X] | status [--loan-ref N]
       | collect <loanRef> | claim <loanRef> [--usdg X] | settle <loanRef>   [--yes]
  stake view | stake <h081> | request-unstake <h081> | unstake   [--yes]
  check <code>                                  validate any h081-* code: kind, network, checksum
  serve [--port 8081] [--poll 20] [--allow-origin <url>]   the local API on 127.0.0.1
  token [--rotate]                              print or replace the API token
  backup                                        the agent key as an h081-key: code (CLI only)
  restore <code> [--force]                      write ~/.h081/agent.json from an h081-key: code
  openapi                                       print the OpenAPI document
  mcp                                           the MCP server on stdio

global: --json  --yes  --home <dir>  --cluster mainnet-beta|localnet  --idempotency-key <k>

Without --yes nothing is sent: the command prints the plan.
${NOTICE}`;

class UsageError extends Error {}

const BOOL = new Set(['json', 'yes', 'fresh', 'direct', 'force', 'rotate', 'help', 'allow-pledged']);

export interface ParsedArgs { pos: string[]; flags: Record<string, string | true> }

export function parseArgs(argv: string[]): ParsedArgs {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a === '-h') { flags.help = true; continue; }
    if (a === '-y') { flags.yes = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) {
        const v = a.slice(eq + 1);
        if (!BOOL.has(name)) flags[name] = v;
        else if (v !== 'false') flags[name] = true;
        continue;
      }
      if (BOOL.has(name)) { flags[name] = true; continue; }
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      flags[name] = v;
      i++;
      continue;
    }
    pos.push(a);
  }
  return { pos, flags };
}

export interface CliIO {
  env?: NodeJS.ProcessEnv;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** tests: open the agent with a stub bank */
  open?: (opts: OpenOptions) => Promise<H081>;
  platform?: NodeJS.Platform;
}

/** The `claude mcp add` line for this machine (Windows needs cmd /c before npx). */
export function mcpAddLine(keyPath: string, rpcUrl: string, platform: NodeJS.Platform = process.platform): string {
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const npx = platform === 'win32' ? 'cmd /c npx' : 'npx';
  return `claude mcp add --scope user h081 -e ${q(`H081_SOLANA_KEYPAIR=${keyPath}`)} -e ${q(`H081_RPC_URL=${rpcUrl}`)} -- ${npx} -y @h081lll/agent mcp`;
}

export async function main(argv: string[] = process.argv.slice(2), io: CliIO = {}): Promise<number> {
  const out = io.stdout ?? ((s: string) => { process.stdout.write(s + '\n'); });
  const err = io.stderr ?? ((s: string) => { process.stderr.write(s + '\n'); });
  const baseEnv = io.env ?? process.env;
  let json = false;
  let network = 'mainnet-beta';
  try {
    const { pos, flags } = parseArgs(argv);
    json = flags.json === true;
    const cmd = pos[0];
    if (flags.help || cmd === 'help' || cmd === undefined) { (cmd === undefined && !flags.help ? err : out)(USAGE); return cmd === undefined && !flags.help ? 2 : 0; }
    if (cmd === '--version' || cmd === 'version') { out(VERSION); return 0; }
    const str = (k: string): string | undefined => { const v = flags[k]; if (v === true) throw new UsageError(`--${k} needs a value`); return v; };
    const num = (k: string): number | undefined => {
      const v = str(k);
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new UsageError(`--${k} must be a number`);
      return n;
    };
    const cluster = str('cluster');
    if (cluster !== undefined && !(CLUSTERS as readonly string[]).includes(cluster)) throw new UsageError('--cluster must be mainnet-beta or localnet');
    const home = str('home');
    const env = effectiveEnv(baseEnv, { home, cluster });
    network = env.H081_CLUSTER?.trim() || 'mainnet-beta';
    const yes = flags.yes === true;
    const write = { confirm: yes, idempotencyKey: str('idempotency-key') ?? `cli-${randomBytes(9).toString('hex')}` };
    const arg = (i: number, what: string): string => { const v = pos[i]; if (v === undefined) throw new UsageError(`missing ${what}`); return v; };
    const open = (extra: Partial<OpenOptions> = {}) => (io.open ?? H081.open)({ env: baseEnv, home, cluster: cluster as OpenOptions['cluster'], log: err, ...extra });

    const ok = (status: 'done' | 'plan' | 'sent', result: unknown, human?: () => void) => {
      if (json) out(JSON.stringify({ ok: true, network, status, result }, null, 2));
      else if (human) human();
      else out(JSON.stringify(result, null, 2));
      return 0;
    };
    const outcome = (o: Outcome) => {
      if (o.status === 'plan') return ok('plan', o.result, () => printPlan(o.result, out));
      if (o.status === 'sent') {
        return ok('sent', o.result, () => {
          out(o.replayed ? `Already sent earlier with this idempotency key (${o.idempotencyKey}):` : 'Sent.');
          out(JSON.stringify(o.result, null, 2));
        });
      }
      return ok('done', o.result);
    };

    switch (cmd) {
      case 'init': {
        const paths = homePaths(env);
        ensureHome(paths.home, err);
        const file = readFileConfig(paths.config);
        const clusterNow = cluster ?? file.cluster ?? (env.H081_CLUSTER?.trim() || 'mainnet-beta');
        const rpcUrl = str('rpc') ?? file.rpcUrl ?? (baseEnv.H081_RPC_URL?.trim() || DEFAULT_RPC);
        try { const u = new URL(rpcUrl); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { throw new UsageError('--rpc must be an http(s) URL'); }
        let created = false;
        if (existsSync(paths.key)) {
          err(`key already exists at ${paths.key}, keeping it`);
        } else {
          const kp = Keypair.generate();
          try {
            writePrivate(paths.key, JSON.stringify(Array.from(kp.secretKey)), err, { exclusive: true });
            created = true;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            err(`key already exists at ${paths.key}, keeping it`);
          }
          kp.secretKey.fill(0);
        }
        writeFileConfig(paths.config, { cluster: clusterNow, rpcUrl, port: file.port ?? 8081 }, err);
        const token = ensureToken(paths.token, err);
        const initEnv = { ...env, H081_CLUSTER: clusterNow, H081_RPC_URL: rpcUrl };
        const signer = parseSecret(readFileSync(paths.key, 'utf8'), `the key file ${paths.key}`);
        await initCrypto();
        const config = configFromEnv(initEnv);
        const addressCode = encodeAddressCode(poolContext(config), new Account(accountSkFromEnv(signer, initEnv).sk).address);
        const wallet = signer.publicKey.toBase58();
        const mcpAdd = mcpAddLine(paths.key, rpcUrl, io.platform);
        network = clusterNow;
        return ok('done', { wallet, addressCode, keyPath: paths.key, created, configPath: paths.config, tokenPath: paths.token, tokenCreated: token.created, cluster: clusterNow, rpcHost: rpcHost(rpcUrl), mcpAdd }, () => {
          out(created ? `Agent key created: ${paths.key} (only you can read it)` : `Agent key: ${paths.key}`);
          out(`Agent wallet: ${wallet}`);
          out(`Address code (others pay you privately with it): ${addressCode}`);
          out(`Config: ${paths.config} (${clusterNow}, RPC ${rpcHost(rpcUrl)})`);
          out(`API token: ${paths.token}`);
          out('');
          out(`Next: send 0.05 SOL and a few USDG to ${wallet} (0.15 SOL if you will grant budgets or lend).`);
          out('Then: npx -y @h081lll/agent deposit 5 --yes');
          out('');
          out('For Claude Code:');
          out(`  ${mcpAdd}`);
        });
      }

      case 'address': {
        const h = await open();
        const a = h.address();
        return ok('done', a, () => { out(`Agent wallet: ${a.wallet}`); out(`Address code: ${a.addressCode}`); });
      }

      case 'info': {
        const h = await open();
        return ok('done', await h.info());
      }

      case 'fetch-circuits': {
        const config = configFromEnv(env);
        const report = await fetchCircuits({ dir: config.circuitsDir, names: AGENT_CIRCUITS, url: config.circuitsUrl, log: err });
        const bad = verifyCircuits(config.circuitsDir, AGENT_CIRCUITS);
        if (bad.length) throw new Error(`hash mismatch: ${bad.join(', ')}`);
        const result = { dir: config.circuitsDir, downloaded: report.fetched.length, kept: report.kept.length, mb: Number((circuitsSize(config.circuitsDir) / 1e6).toFixed(1)) };
        return ok('done', result, () => out(`${result.downloaded} file(s) downloaded, ${result.kept} already present; ${result.mb} MB in ${result.dir}; all hashes match`));
      }

      case 'balance': {
        const h = await open();
        const b = await h.balance({ fresh: flags.fresh === true });
        return ok('done', b, () => {
          out(`Shielded: ${b.shielded} USDG`);
          out(`Wallet:   ${b.wallet.usdg} USDG, ${b.wallet.sol} SOL`);
          if (b.allowances.length) for (const a of b.allowances) out(`Allowance ${a.id}: ${a.remaining} USDG left (${a.holder})`);
          out(`Address code: ${b.addressCode}`);
        });
      }

      case 'history': {
        const h = await open();
        const r = h.history({ limit: num('limit'), after: str('after') });
        return ok('done', r, () => {
          if (!r.items.length) out('Nothing sent from this machine yet.');
          for (const i of r.items) out(`${i.time}  ${i.kind.padEnd(8)} ${(i.usdg ?? '').padStart(10)}  ${i.state.padEnd(7)} ${i.signature ?? i.error ?? ''}`);
          if (r.next) out(`more: --after ${r.next}`);
        });
      }

      case 'fee': {
        const h = await open();
        const q = await h.withdrawFee(arg(1, '<usdg>'));
        return ok('done', q, () => {
          out(`Fee: ${q.fee} USDG; the recipient gets ${q.payout} USDG${q.relayer ? ` (relayer ${q.relayer})` : ''}`);
          if (q.createAccountFee !== undefined) out(`If the recipient has no USDG account yet (a fresh wallet usually has none), the relayer adds ${q.createAccountFee} USDG to create it, so less arrives.`);
          if (q.needsStake) out(`Above ${q.freeTierMax} USDG the relayer needs H081 staked by the agent wallet; split it or use --direct.`);
          if (q.note) out(q.note);
        });
      }

      case 'deposit': return outcome(await (await open()).deposit(arg(1, '<usdg>'), write));

      case 'withdraw': {
        const to = str('to');
        if (!to) throw new UsageError('withdraw needs --to <a wallet that never touched the agent>, or --to self');
        return outcome(await (await open()).withdraw(arg(1, '<usdg>'), { ...write, to, direct: flags.direct === true }));
      }

      case 'pay': return outcome(await (await open()).pay(arg(1, '<usdg>'), {
        ...write, to: str('to'), toAddressCode: str('to-code'), allowanceId: str('allowance'), agentIndex: num('agent-index'), direct: flags.direct === true, allowPledged: flags['allow-pledged'] === true,
      }));

      case 'transfer': {
        const code = str('to-code');
        if (!code) throw new UsageError('transfer needs --to-code <h081-address:...>');
        return outcome(await (await open()).transfer(arg(1, '<usdg>'), { ...write, toAddressCode: code }));
      }

      case 'allow': return outcome(await (await open()).allow(arg(1, '<usdg>'), {
        ...write, dailyCap: str('daily-cap'), maxPerTx: str('max-per-tx'), days: num('days'), unlockDays: num('unlock-days'), agentIndex: num('agent-index'), toAddressCode: str('to-code'),
      }));

      case 'reclaim': return outcome(await (await open()).reclaim(arg(1, '<allowance id>'), write));

      case 'loan': {
        const sub = arg(1, 'quote or borrow');
        const h = await open();
        if (sub === 'quote') return ok('done', await h.loanQuote(arg(2, '<termsCode>'), { principal: str('principal') }));
        if (sub === 'borrow') {
          const days = num('days'), unlockDays = num('unlock-days');
          if (days === undefined || unlockDays === undefined) throw new UsageError('loan borrow needs --days N and --unlock-days N');
          return outcome(await h.borrow(arg(2, '<termsCode>'), { ...write, days, unlockDays, principal: str('principal'), budget: str('budget'), dailyCap: str('daily-cap'), maxPerTx: str('max-per-tx'), agentIndex: num('agent-index') }));
        }
        throw new UsageError('loan quote <termsCode> | loan borrow <termsCode> --days N --unlock-days N');
      }

      case 'lend': {
        const action = arg(1, 'open, fund, status, collect, claim or settle');
        const h = await open();
        const pledge = num('pledge-bps');
        switch (action) {
          case 'open':
            if (pledge === undefined) throw new UsageError('lend open needs --pledge-bps N (100..9000)');
            return outcome(await h.lend('open', { pledgeBps: pledge }, write));
          case 'fund': return outcome(await h.lend('fund', { proofCode: arg(2, '<proofCode>'), loanRef: str('loan-ref'), principalUsdg: str('principal'), pledgeBps: pledge }, write));
          case 'status': return ok('done', await h.lendStatus(str('loan-ref') ?? pos[2]));
          case 'collect': case 'settle': return outcome(await h.lend(action, { loanRef: arg(2, '<loanRef>') }, write));
          case 'claim': return outcome(await h.lend('claim', { loanRef: arg(2, '<loanRef>'), usdg: str('usdg') }, write));
          default: throw new UsageError('lend open | fund | status | collect | claim | settle');
        }
      }

      case 'stake': {
        const action = arg(1, 'view, stake, request-unstake or unstake').replace(/-/g, '_');
        const h = await open();
        if (action === 'view') return ok('done', await h.stakeView());
        if (action === 'stake' || action === 'request_unstake') return outcome(await h.stake(action, { ...write, h081: arg(2, '<h081 amount>') }));
        if (action === 'unstake') return outcome(await h.stake('unstake', write));
        throw new UsageError('stake view | stake <h081> | request-unstake <h081> | unstake');
      }

      case 'check': {
        const r = checkCode(configFromEnv(env), arg(1, '<code>'));
        ok('done', r, () => out(r.valid ? `valid ${r.kind} code for ${r.network}` : `not valid${r.kind ? ` (${r.kind} code${r.network ? `, made for ${r.network}` : ''})` : ''}: ${r.reason}`));
        return r.valid ? 0 : 1;
      }

      case 'serve': {
        const poll = num('poll');
        if (poll !== undefined && !(poll >= 1)) throw new UsageError('--poll must be at least 1 (seconds)');
        const port = num('port');
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new UsageError('--port must be 1..65535');
        if (flags.host !== undefined || flags.bind !== undefined) throw new UsageError('the gateway binds 127.0.0.1 only; there is no option to bind anywhere else');
        const h = await open({ pollSeconds: poll });
        const { token, created } = ensureToken(h.paths.token, err);
        if (created) err(`API token written to ${h.paths.token}`);
        const srv = await startServer({ h081: h, token, port, allowOrigin: str('allow-origin'), log: err });
        err(`H081 gateway ${VERSION} on ${srv.url} (${h.network}, agent ${h.signer.publicKey.toBase58()}, RPC ${rpcHost(h.config.rpcUrl)})`);
        err(`token: ${h.paths.token}   docs: ${srv.url}/openapi.json   ${NOTICE}`);
        // pre-warm the proving files in the background (hash-checked); the first proof then does not wait
        void fetchCircuits({ dir: h.config.circuitsDir, names: AGENT_CIRCUITS, url: h.config.circuitsUrl, log: err })
          .then((r) => { if (r.fetched.length) err(`circuits ready (${r.fetched.length} downloaded)`); })
          .catch((e: Error) => err(`circuit download failed (it is retried when a proof needs it): ${e.message}`));
        await new Promise<void>((resolve) => {
          const stop = () => { err('stopping'); void srv.close().then(resolve); };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
        return 0;
      }

      case 'token': {
        const path = homePaths(env).token;
        ensureHome(homePaths(env).home, err);
        const token = flags.rotate === true ? rotateToken(path, err) : ensureToken(path, err).token;
        if (flags.rotate === true) err('new token written; restart h081 serve and update your scripts');
        return ok('done', { token, path }, () => out(token));
      }

      case 'backup': {
        const signer = loadKeypair(env);
        const code = encodeKeyCode(poolContext(configFromEnv(env)), signer.secretKey.slice(0, 32));
        return ok('done', { code, warning: KEY_WARNING }, () => { out(code); err(KEY_WARNING); });
      }

      case 'restore': {
        const code = arg(1, '<h081-key:... code>');
        const config = configFromEnv(env);
        let seed: Uint8Array;
        try { seed = decodeKeyCode(poolContext(config), code); } catch (e) {
          err(`check: ${(e as Error).message}`);
          throw e;
        }
        err(`check: agent key code, ${config.cluster}, checksum ok`);
        const paths = homePaths(env);
        ensureHome(paths.home, err);
        if (existsSync(paths.key) && flags.force !== true) {
          throw new UsageError(`key already exists at ${paths.key}; keeping it. Back it up (h081 backup) and pass --force to replace it.`);
        }
        const kp = Keypair.fromSeed(seed);
        writePrivate(paths.key, JSON.stringify(Array.from(kp.secretKey)), err, { exclusive: flags.force !== true });
        const wallet = kp.publicKey.toBase58();
        kp.secretKey.fill(0);
        seed.fill(0);
        return ok('done', { wallet, keyPath: paths.key }, () => out(`Restored ${paths.key}: agent wallet ${wallet}`));
      }

      case 'openapi': out(JSON.stringify(buildOpenApi(ROUTES), null, 2)); return 0;

      case 'mcp': {
        // stdout carries only JSON-RPC
        console.log = (...a: unknown[]) => console.error(...a);
        let opened: Promise<H081> | undefined;
        const agent = () => { opened ??= open().catch((e) => { opened = undefined; throw e; }); return opened; };
        err(`h081 mcp ${VERSION} on stdio (${network}); ${NOTICE}`);
        await createMcpServer({ bank: async () => (await (await agent()).bank()) as BankLike, version: VERSION }).serveStdio();
        return 0;
      }

      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`h081: ${e.message}`);
      if (json) out(JSON.stringify({ ok: false, network, error: { code: 'bad_request', message: e.message, retryable: false } }, null, 2));
      else err('run h081 --help for the commands');
      return 2;
    }
    const c = classify(e);
    if (json) out(JSON.stringify({ ok: false, network, error: { code: c.code, message: c.message, retryable: c.retryable, ...(c.details ? { details: c.details } : {}) } }, null, 2));
    err(`h081: ${c.message}`);
    return 1;
  }
}

function printPlan(p: Plan, out: (s: string) => void): void {
  out('Plan (nothing was sent):');
  out(`  ${p.op}${p.usdg ? ` ${p.usdg} USDG` : ''}${p.to ? ` to ${p.to}` : ''}`);
  if (p.fee !== '0') out(`  fee: ${p.fee} USDG`);
  if (p.payout !== undefined && p.fee !== '0') out(`  arrives: ${p.payout} USDG`);
  out(`  sent by: ${p.sentBy}; SOL needed: ${p.solNeeded}`);
  if (p.circuit) out(`  proof: ${p.circuit} (download ${p.download})`);
  out(`  public on chain: ${p.publicOnChain.join(', ')}`);
  for (const w of p.warnings) out(`  ! ${w}`);
  if (p.details !== undefined) out(`  details: ${JSON.stringify(p.details)}`);
  out('Add --yes to send it.');
}

const invokedDirectly = (() => {
  try {
    const arg = process.argv[1];
    if (!arg) return false;
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (e: Error) => { process.stderr.write(`h081: ${e.message}\n`); process.exitCode = 1; });
}
