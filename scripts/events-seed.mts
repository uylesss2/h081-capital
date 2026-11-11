// Builds the pool's public event-log snapshot that a fresh MCP / agent install starts from
// (integrations/core EVENTS_SEED_URL), so its first sync fetches only what is newer instead of every pool
// transaction since launch. Read only: getSignaturesForAddress / getTransaction, nothing is signed or sent.
//
//   H081_RPC_URL=<private mainnet RPC> npx tsx scripts/events-seed.mts --out <dir> [--from <previous snapshot>]
//
// Writes <dir>/<cluster>-<pool>.events.json (the file name the clients ask for). --from (or an existing output
// file) is extended, not rebuilt. The snapshot is public chain data only: commitments, nullifiers, encrypted memos.
// Clients check it against the chain before use (the root history and their own nullifier accounts).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Connection } from '@solana/web3.js';
import { PoolEventLog } from '../src/solana/events.js';
import { configFromEnv, rpcHost } from '../integrations/core/constants.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const out = arg('--out');
if (!out) { console.error('usage: H081_RPC_URL=<rpc> tsx scripts/events-seed.mts --out <dir> [--from <snapshot>]'); process.exit(2); }
const config = configFromEnv(process.env);
const file = join(out, `${config.cluster}-${config.poolProgramId.toBase58()}.events.json`);
const from = arg('--from') ?? (existsSync(file) ? file : undefined);

const log = new PoolEventLog(new Connection(config.rpcUrl, 'confirmed'), config.poolProgramId, {
  onProgress: (done, total) => { if (done === total || done % 500 === 0) console.error(`  ${done}/${total} transactions`); },
});
if (from) {
  const ok = log.restore(JSON.parse(readFileSync(from, 'utf8')));
  console.error(ok ? `extending ${from} (${log.events.length} events)` : `${from} is not a snapshot of this pool; building from the start`);
}
const t0 = Date.now();
console.error(`scanning ${config.poolProgramId.toBase58()} on ${config.cluster} via ${rpcHost(config.rpcUrl)}`);
const added = await log.refresh();
mkdirSync(out, { recursive: true });
const json = JSON.stringify(log.snapshot());
writeFileSync(file + '.tmp', json);
renameSync(file + '.tmp', file);
console.error(`${added} new events, ${log.events.length} in all, ${(json.length / 1e6).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${file}`);
