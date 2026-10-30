// Compares locally built programs with what a cluster runs. Read-only: two getAccountInfo calls per
// program and one getGenesisHash; no key is loaded and nothing is signed or sent.
//
//   npx tsx scripts/solana-program-hash.mts --so solana/target-verifiable/stipend_pool.so
//       prints the executable hash (sha256 without trailing zeros) and the file sha256
//   npx tsx scripts/solana-program-hash.mts --program <ID> --cluster <mainnet-beta|devnet|testnet|URL> [--so FILE | --expect HEX]
//       prints the deployed hash, loader and upgrade authority; with --so/--expect exits 1 on a mismatch
//   npx tsx scripts/solana-program-hash.mts --all <DIR> --cluster <...> [--ids FILE]
//       the four production programs: DIR/<name>.so against the ids in the source's declare_id!
//       (or a JSON map {"stipend_pool": "<id>", ...} given with --ids)
// Exit codes: 0 match (or nothing to compare), 1 mismatch, 2 usage or fetch error.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { GENESIS_HASHES, clusterUrl, executableHash, fetchDeployedProgram, fileHash } from '../src/solana/verify.js';

const PROGRAMS = ['stipend_pool', 'stream_loan', 'capacity_stake', 'safety_pool'] as const;
const root = resolve(import.meta.dirname, '..');

function args(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (!k.startsWith('--')) usage(`unexpected ${k}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) usage(`${k} needs a value`);
    (out[k.slice(2)] ??= []).push(v);
    i++;
  }
  return out;
}
function usage(msg: string): never {
  console.error(`${msg}\nusage: --so FILE | --program ID --cluster C [--so FILE | --expect HEX] | --all DIR --cluster C [--ids FILE]`);
  process.exit(2);
}

/** The default (non-feature) declare_id! of a program's lib.rs. */
function declaredId(name: string): string {
  const lib = readFileSync(resolve(root, 'solana', 'programs', name, 'src', 'lib.rs'), 'utf8');
  const ids = [...lib.matchAll(/declare_id!\("(\w+)"\)/g)].map((m) => m[1]!);
  if (!ids.length) throw new Error(`no declare_id! in ${name}`);
  return ids[0]!;
}

async function connect(cluster: string): Promise<Connection> {
  const url = clusterUrl(cluster);
  const conn = new Connection(url, 'finalized');
  const genesis = await conn.getGenesisHash();
  console.log(`cluster ${GENESIS_HASHES[genesis] ?? 'unknown (private or local)'}  genesis ${genesis}  rpc ${url}`);
  return conn;
}

function show(label: string, so: Uint8Array) {
  console.log(`${label}\n  executable hash ${executableHash(so)}\n  file sha256     ${fileHash(so)}  (${so.length} bytes)`);
}

const a = args();
try {
  if (a.all) {
    if (!a.cluster) usage('--all needs --cluster');
    const dir = resolve(a.all[0]!);
    const ids: Record<string, string> = a.ids ? JSON.parse(readFileSync(a.ids[0]!, 'utf8')) : Object.fromEntries(PROGRAMS.map((p) => [p, declaredId(p)]));
    const conn = await connect(a.cluster[0]!);
    let bad = 0;
    for (const p of PROGRAMS) {
      const id = ids[p];
      if (!id) { console.log(`${p}: no id given`); bad++; continue; }
      const local = executableHash(readFileSync(resolve(dir, `${p}.so`)));
      try {
        const d = await fetchDeployedProgram(conn, new PublicKey(id));
        const ok = d.executableHash === local;
        if (!ok) bad++;
        console.log(`${ok ? 'MATCH   ' : 'MISMATCH'} ${p} ${id}\n  local    ${local}\n  deployed ${d.executableHash}\n  loader ${d.loader}, upgrade authority ${d.upgradeAuthority?.toBase58() ?? 'none (immutable)'}`);
      } catch (e) {
        bad++;
        console.log(`ERROR    ${p} ${id}: ${(e as Error).message}`);
      }
    }
    process.exit(bad ? 1 : 0);
  }
  if (a.program) {
    if (!a.cluster) usage('--program needs --cluster');
    const conn = await connect(a.cluster[0]!);
    const d = await fetchDeployedProgram(conn, new PublicKey(a.program[0]!));
    console.log(`program ${d.programId.toBase58()}\n  loader ${d.loader}, data account ${d.dataAccount.toBase58()}` +
      `${d.slot !== null ? `, deployed at slot ${d.slot}` : ''}\n  upgrade authority ${d.upgradeAuthority?.toBase58() ?? 'none (immutable)'}` +
      `\n  executable hash ${d.executableHash}`);
    const expect = a.expect?.[0]?.toLowerCase() ?? (a.so ? executableHash(readFileSync(a.so[0]!)) : undefined);
    if (expect === undefined) process.exit(0);
    const ok = expect === d.executableHash;
    console.log(`${ok ? 'MATCH' : 'MISMATCH'}: local ${expect}`);
    process.exit(ok ? 0 : 1);
  }
  if (a.so) {
    for (const f of a.so) show(f, readFileSync(f));
    process.exit(0);
  }
  usage('nothing to do');
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(2);
}
