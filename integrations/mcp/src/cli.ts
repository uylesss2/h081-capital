// `h081-mcp`: the H081 Capital bank as a Model Context Protocol server over stdio (newline-delimited JSON-RPC).
//
//   h081-mcp                  serve (what `claude mcp add` / claude_desktop_config.json run)
//   h081-mcp fetch-circuits   download and hash-check the proving artifacts, then exit
//   h081-mcp info             print the configuration and the agent's addresses, then exit
//   h081-mcp --help
//
// stdout carries only JSON-RPC; everything else goes to stderr.
import { circuitsSize, fetchCircuits, verifyCircuits } from '../../core/circuits.js';
import { AGENT_CIRCUITS, ENV_VARS, NOTICE, configFromEnv } from '../../core/constants.js';
import { hasKeyInEnv, KEY_HELP } from '../../core/keys.js';
import { type BankLike, plain } from '../../core/operations.js';
import { openFromEnv } from '../../core/open.js';
import { SERVER_VERSION, createServer } from './server.js';

const err = (line: string) => process.stderr.write(line + '\n');

function help(): void {
  err(`h081-mcp ${SERVER_VERSION}: H081 Capital bank MCP server (stdio)\n\nusage: h081-mcp [serve | fetch-circuits | info | --help]\n\nenvironment:`);
  for (const [k, v] of Object.entries(ENV_VARS)) err(`  ${k.padEnd(26)} ${v}`);
  err(`\n${NOTICE}`);
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const cmd = argv[0] ?? 'serve';
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { help(); return 0; }
  const config = configFromEnv(env);

  if (cmd === 'fetch-circuits') {
    const report = await fetchCircuits({ dir: config.circuitsDir, names: AGENT_CIRCUITS, url: config.circuitsUrl, log: err });
    err(`${report.fetched.length} file(s) downloaded, ${report.kept.length} already present; ${(circuitsSize(config.circuitsDir) / 1e6).toFixed(1)} MB in ${config.circuitsDir}`);
    const bad = verifyCircuits(config.circuitsDir, AGENT_CIRCUITS);
    if (bad.length) { err(`hash mismatch: ${bad.join(', ')}`); return 1; }
    err('all hashes match docs/CEREMONY.md');
    return 0;
  }

  if (cmd === 'info') {
    if (!hasKeyInEnv(env)) { err(`no agent key: ${KEY_HELP}`); return 1; }
    const { bank, accountDerived } = await openFromEnv({ env, log: err });
    process.stdout.write(JSON.stringify(plain({ ...(await bank.protocolInfo()), accountDerived }), null, 2) + '\n');
    return 0;
  }

  if (cmd !== 'serve') { err(`unknown command ${cmd}`); help(); return 2; }

  let opened: Promise<BankLike> | undefined;
  const bank = (): Promise<BankLike> => {
    if (!opened) {
      opened = openFromEnv({ env, log: err }).then(({ bank: b, accountDerived }) => {
        err(`h081-mcp: agent ${b.signer.publicKey.toBase58()}, shielded account ${accountDerived ? 'derived from the agent key' : 'from H081_ACCOUNT_SK'}, rpc ${config.rpcUrl}`);
        return b;
      }).catch((e: Error) => { opened = undefined; throw e; });
    }
    return opened;
  };
  err(`h081-mcp ${SERVER_VERSION} serving on stdio (cluster ${config.cluster}, pool ${config.poolProgramId.toBase58()}); ${NOTICE}`);
  if (!hasKeyInEnv(env)) err(`warning: no agent key in the environment; every tool call will fail until one is set (${KEY_HELP})`);
  await createServer({ bank }).serveStdio();
  return 0;
}

const invokedDirectly = (() => {
  try {
    const arg = process.argv[1] ?? '';
    return /h081-mcp|[\\/]cli\.(js|ts|mjs|cjs)$/.test(arg);
  } catch { return false; }
})();

if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (e: Error) => { err(`h081-mcp: ${e.message}`); process.exitCode = 1; });
}
