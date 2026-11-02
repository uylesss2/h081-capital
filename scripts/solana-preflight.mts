// Pre-flight checklist before deploying the four production programs to a public cluster. Local only:
// no RPC call, no signing, no secret key is printed. Exit 0 when every check passes (warnings allowed),
// 1 when any check fails. On success it writes <so-dir>/PREFLIGHT.txt (cluster, commit, ids, .so hashes) as a
// record. MVP: nothing enforces the stamp yet; solana/scripts/mainnet-deploy.sh does not read it and deploys
// solana/target-so with the solana/keys keypairs, so point --so and --keys at exactly what will be deployed.
//
//   npx tsx scripts/solana-preflight.mts --cluster devnet|testnet|mainnet-beta
//       [--keys DIR]          program keypairs <name>-keypair.json (default solana/keys)
//       [--so DIR]            the .so files to deploy (default solana/target-verifiable, from npm run solana:verifiable-build)
//       [--attestation FILE]  ceremony attestation.json (default build/circuits/ceremony-attestation.json if present)
//       [--allow-localnet-ids]  accept the committed localnet program ids (see solana/README.md, "Deploying")
//       [--skip-tests]        do not run the consistency test (only for a quick look; the stamp is not written)
//
// Checks: git state; program keypairs present and equal to every declare_id! and cross-program constant
// (test/solana/consistency.test.ts); program ids not the localnet ones; verifying keys equal the final
// zkeys and the ceremony attestation, and vk.rs equals the verifying keys; the .so files are the verifiable
// build of this commit (pinned toolchain, SHA256SUMS) and none is a probe/fast build.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as snarkjs from 'snarkjs';

const root = resolve(import.meta.dirname, '..');
const PROGRAMS = ['stipend_pool', 'stream_loan', 'capacity_stake', 'safety_pool'] as const;
const VARIANTS = ['stipend_pool_probe', 'capacity_stake_fast', 'safety_pool_fast'];
const CIRCUITS = ['transact', 'grant', 'spend', 'disclose', 'delegate', 'stream'];
/** Program ids of the localnet keypairs committed in declare_id! as of 2026-10-31 (solana/README.md). */
export const LOCALNET_IDS: Record<string, string> = {
  stipend_pool: 'AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3',
  stipend_pool_probe: 'FWV9zZmHQoXE1M16eNcCTmzwVKft8RbS5zFUZ1od4hDR',
  stream_loan: 'FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc',
  capacity_stake: '6yzLZPu3JcLQHZQqLKWpGnHUpNTGAkoRcW8Ji8oSgCd3',
  capacity_stake_fast: 'DoiRuuwMkN8M4CWQy45Lne2wGP7JCPUtPDiC1pE9QM1q',
  safety_pool: 'EvKjwxVQX1RhyoBXisdbzk1JGLb5fMgZzHVLQAiPKJwe',
  safety_pool_fast: '5K2L3eNBzmeznEZpY4vav74UHRaBHgQJv582W5i4kT7',
};

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(`--${k}`);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const cluster = opt('cluster');
if (!cluster || !['devnet', 'testnet', 'mainnet-beta'].includes(cluster)) {
  console.error('usage: --cluster devnet|testnet|mainnet-beta [--keys DIR] [--so DIR] [--attestation FILE] [--allow-localnet-ids] [--skip-tests]');
  process.exit(2);
}
const mainnet = cluster === 'mainnet-beta';
const keysDir = resolve(opt('keys', join(root, 'solana', 'keys'))!);
const soDir = resolve(opt('so', join(root, 'solana', 'target-verifiable'))!);
const defaultAtt = join(root, 'build', 'circuits', 'ceremony-attestation.json');
const attFile = opt('attestation') ?? (existsSync(defaultAtt) ? defaultAtt : undefined);

// ---------------------------------------------------------------- reporting
type Level = 'PASS' | 'WARN' | 'FAIL';
const results: { level: Level; what: string }[] = [];
const report = (level: Level, what: string) => { results.push({ level, what }); console.log(`${level}  ${what}`); };
const pass = (w: string) => report('PASS', w);
const warn = (w: string) => report('WARN', w);
const fail = (w: string) => report('FAIL', w);
/** FAIL on mainnet, WARN on devnet/testnet. */
const strict = (w: string) => (mainnet ? fail(w) : warn(w));
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();

console.log(`pre-flight for ${cluster}\n  keys ${keysDir}\n  .so  ${soDir}\n  attestation ${attFile ?? '(none)'}\n`);

// ---------------------------------------------------------------- 1. git state
const head = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'solana', 'circuits', 'src', 'scripts');
if (dirty) strict(`uncommitted changes under solana/, circuits/, src/ or scripts/:\n${dirty.split('\n').map((l) => `        ${l}`).join('\n')}`);
else pass(`clean tree at ${head}`);

// ---------------------------------------------------------------- 2. program ids and keypairs
const declared = (name: string) => {
  const lib = readFileSync(join(root, 'solana', 'programs', name, 'src', 'lib.rs'), 'utf8');
  return [...lib.matchAll(/declare_id!\("(\w+)"\)/g)].map((m) => m[1]!);
};
const ids: Record<string, string> = {};
for (const p of PROGRAMS) {
  const [id] = declared(p);
  ids[p] = id!;
  const f = join(keysDir, `${p}-keypair.json`);
  if (!existsSync(f)) { fail(`${p}: no keypair ${f}`); continue; }
  let kp: Keypair;
  try { kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, 'utf8')))); } catch { fail(`${p}: ${f} is not a keypair file`); continue; }
  if (kp.publicKey.toBase58() !== id) fail(`${p}: keypair ${kp.publicKey.toBase58()} is not declare_id! ${id}`);
  else pass(`${p}: keypair matches declare_id! ${id}`);
  if (LOCALNET_IDS[p] === id) {
    const msg = `${p}: ${id} is the committed LOCALNET id (solana/keys); solana/README.md says those keypairs are never used for a public cluster`;
    if (flag('allow-localnet-ids')) warn(`${msg} (accepted with --allow-localnet-ids)`);
    else fail(`${msg}; generate real ids (Deploying, step 1) or pass --allow-localnet-ids if the owner decided to use them`);
  }
}
for (const v of VARIANTS) if (existsSync(join(keysDir, `${v}-keypair.json`))) warn(`${keysDir} also holds ${v}-keypair.json (a localnet-only variant; it is never deployed)`);

if (flag('skip-tests')) warn('consistency test skipped (--skip-tests); no PREFLIGHT.txt will be written');
else {
  // Every check of consistency.test.ts except the one about the localnet keypairs in solana/keys, which
  // is replaced by the --keys check above.
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const r = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.solana.config.ts', 'test/solana/consistency.test.ts', '-t', '^(?!.*localnet keypairs)'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const summary = /Tests\s+(.*)/.exec(r.stdout ?? '')?.[1]?.trim() ?? 'no summary';
  if (r.status === 0) pass(`test/solana/consistency.test.ts: ${summary} (ids, PDAs, mirrored layouts, error tables)`);
  else fail(`test/solana/consistency.test.ts failed (${summary}):\n${(r.stdout ?? '') + (r.stderr ?? '')}`);
}

// ---------------------------------------------------------------- 3. verifying keys
const att = attFile ? JSON.parse(readFileSync(attFile, 'utf8')) : null;
if (!att) strict('no ceremony attestation: the verifying keys come from the single-contribution dev setup (scripts/setup-circuits.mjs), not a public ceremony');
for (const c of CIRCUITS) {
  const dir = join(root, 'build', 'circuits', c);
  const vkFile = join(dir, `${c}.vkey.json`);
  const zkey = join(dir, `${c}.zkey`);
  if (!existsSync(vkFile) || !existsSync(zkey)) { fail(`${c}: missing ${existsSync(vkFile) ? zkey : vkFile}`); continue; }
  const fromZkey = await snarkjs.zKey.exportVerificationKey(zkey);
  const onDisk = JSON.parse(readFileSync(vkFile, 'utf8'));
  if (JSON.stringify(fromZkey) !== JSON.stringify(onDisk)) { fail(`${c}: ${c}.vkey.json is not the verifying key of ${c}.zkey`); continue; }
  if (!att) { pass(`${c}: vkey.json is the key of ${c}.zkey`); continue; }
  const a = att.circuits?.[c];
  if (!a) { fail(`${c}: not in the ceremony attestation`); continue; }
  const problems: string[] = [];
  if (sha256(readFileSync(vkFile)) !== a.vkeySha256) problems.push('vkey.json sha256');
  if (sha256(readFileSync(zkey)) !== a.finalZkeySha256) problems.push('zkey sha256');
  const r1cs = join(dir, `${c}.r1cs`);
  if (existsSync(r1cs) && sha256(readFileSync(r1cs)) !== a.r1csSha256) problems.push('r1cs sha256 (the circuit changed after the ceremony)');
  if (problems.length) fail(`${c}: differs from the ceremony's final key: ${problems.join(', ')}`);
  else pass(`${c}: vkey and zkey are the ceremony's final key (${a.contributions.length} contributions + beacon)`);
}
{
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'gen-solana-vk.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
  if (r.status === 0) pass('solana/programs/stipend_pool/src/generated/vk.rs matches build/circuits/*/*.vkey.json');
  else fail(`vk.rs is stale: ${(r.stderr || r.stdout).trim()}`);
}

// ---------------------------------------------------------------- 4. the .so files
const soHashes: Record<string, string> = {};
if (!existsSync(soDir)) fail(`${soDir} does not exist (npm run solana:verifiable-build)`);
else {
  const files = readdirSync(soDir).filter((f) => f.endsWith('.so'));
  const extra = files.filter((f) => !PROGRAMS.includes(f.slice(0, -3) as (typeof PROGRAMS)[number]));
  if (extra.length) fail(`${soDir} holds non-production builds: ${extra.join(', ')}`);
  const sums = existsSync(join(soDir, 'SHA256SUMS'))
    ? Object.fromEntries(readFileSync(join(soDir, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => { const [h, f] = l.trim().split(/\s+\*?/); return [f!, h!]; }))
    : null;
  const info = existsSync(join(soDir, 'build-info.txt')) ? readFileSync(join(soDir, 'build-info.txt'), 'utf8') : '';
  if (!sums || !info) strict(`${soDir} is not a verifiable-build output (no SHA256SUMS / build-info.txt)`);
  else {
    const commit = /^commit\s+(\S+)/m.exec(info)?.[1];
    if (!/^pinned toolchain\s+yes/m.test(info)) strict('the .so files were built with an unpinned toolchain');
    else pass('the .so files come from the pinned toolchain (build-info.txt)');
    if (commit !== head) strict(`the .so files were built from ${commit}, HEAD is ${head}`);
    else pass(`the .so files were built from HEAD ${head}`);
  }
  const variantIds = VARIANTS.map((v) => new PublicKey(LOCALNET_IDS[v]!).toBytes());
  for (const p of PROGRAMS) {
    const f = join(soDir, `${p}.so`);
    if (!existsSync(f)) { fail(`${p}: ${f} missing`); continue; }
    const so = readFileSync(f);
    soHashes[p] = sha256(so);
    if (so.readUInt32BE(0) !== 0x7f454c46) { fail(`${p}: not an ELF file`); continue; }
    if (sums && sums[`${p}.so`] !== soHashes[p]) { fail(`${p}.so: sha256 ${soHashes[p]} is not the one in SHA256SUMS`); continue; }
    // A probe/fast build carries its own localnet program id; a production build never contains one.
    if (variantIds.some((id) => so.indexOf(Buffer.from(id)) >= 0)) fail(`${p}: contains a probe/fast program id; this is a localnet-only build`);
    else if (so.includes('ProbeInsert') || so.includes('probe_insert')) fail(`${p}: contains the probe_insert instruction`);
    else pass(`${p}.so: production build, sha256 ${soHashes[p]}`);
  }
}

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => r.level === 'FAIL').length;
const warned = results.filter((r) => r.level === 'WARN').length;
console.log(`\n${failed ? 'NOT READY' : 'READY'}: ${results.length - failed - warned} pass, ${warned} warn, ${failed} fail (cluster ${cluster})`);
if (!failed && !flag('skip-tests') && existsSync(soDir)) {
  const stamp = [
    `cluster ${cluster}`, `commit ${head}`, `checked ${new Date().toISOString()}`, `attestation ${att ? sha256(readFileSync(attFile!)) : 'none (dev setup)'}`,
    `warnings ${warned}`, ...PROGRAMS.map((p) => `program ${p} ${ids[p]} ${soHashes[p]}`),
  ].join('\n');
  writeFileSync(join(soDir, 'PREFLIGHT.txt'), stamp + '\n');
  console.log(`wrote ${join(soDir, 'PREFLIGHT.txt')}`);
}
process.exit(failed ? 1 : 0);
