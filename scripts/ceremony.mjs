// Groth16 phase-2 trusted-setup ceremony, one chain per circuit (snarkjs). See docs/CEREMONY.md.
//
//   node scripts/ceremony.mjs init       --dir D --ptau FILE [--ptau-blake2b HEX] [--verify-ptau]
//                                        [--circuits transact,grant,...] [--r1cs name=FILE ...]
//   node scripts/ceremony.mjs contribute --dir D --name "NAME" [--entropy-file FILE]
//   node scripts/ceremony.mjs verify     --dir D [--ptau FILE]
//   node scripts/ceremony.mjs beacon     --dir D --beacon HEX --source "TEXT" [--iterations 10]
//   node scripts/ceremony.mjs export     --dir D [--install]
//   node scripts/ceremony.mjs status     --dir D
//
// The ceremony directory holds ceremony.json (the transcript), one folder per circuit with the zkey chain
// <name>_0000.zkey (coordinator init), <name>_0001.zkey ... (one per participant) and <name>_final.zkey
// (random beacon), and after `export` the verifying keys, the Solidity verifiers and ATTESTATION.md.
// Entropy is never written anywhere. Phase 2 is sound if at least one participant destroyed theirs.
import * as snarkjs from 'snarkjs';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const PRODUCTION = ['transact', 'grant', 'spend', 'disclose', 'delegate', 'stream'];
const VERSION = 1;

// ---------------------------------------------------------------- helpers
const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const k = rest[i];
  if (!k.startsWith('--')) die(`unexpected argument ${k}`);
  const key = k.slice(2);
  const flag = ['verify-ptau', 'install', 'all'].includes(key);
  const v = flag ? true : rest[++i];
  if (v === undefined) die(`${k} needs a value`);
  (opts[key] ??= []).push(v);
}
const one = (k, dflt) => opts[k]?.[opts[k].length - 1] ?? dflt;

function die(msg) { console.error(`ceremony: ${msg}`); process.exit(2); }
const hashFile = (file, algo) => new Promise((ok, fail) => {
  const h = createHash(algo);
  createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
});
const sha256 = (file) => hashFile(file, 'sha256');
const hex = (u8) => Buffer.from(u8).toString('hex');
const pad = (n) => String(n).padStart(4, '0');
const quietLogger = (lines = []) => ({
  debug() {}, info: (m) => lines.push(String(m)), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`), lines,
});

function dirOf() {
  const d = one('dir');
  if (!d) die('--dir is required');
  return resolve(d);
}
function load(dir) {
  const f = join(dir, 'ceremony.json');
  if (!existsSync(f)) die(`${f} not found (run init first)`);
  const c = JSON.parse(readFileSync(f, 'utf8'));
  if (c.version !== VERSION) die(`unsupported ceremony.json version ${c.version}`);
  return c;
}
const save = (dir, c) => writeFileSync(join(dir, 'ceremony.json'), JSON.stringify(c, null, 2) + '\n');
const zkeyPath = (dir, name, idx) => join(dir, name, `${name}_${idx === 'final' ? 'final' : pad(idx)}.zkey`);
const latestIndex = (c) => c.contributions.length;
const latestZkey = (dir, c, name) => (c.beacon ? zkeyPath(dir, name, 'final') : zkeyPath(dir, name, latestIndex(c)));

// ---------------------------------------------------------------- init
async function init() {
  const dir = dirOf();
  if (existsSync(join(dir, 'ceremony.json'))) die(`${dir} already holds a ceremony`);
  const ptau = one('ptau');
  if (!ptau || !existsSync(ptau)) die('--ptau FILE is required (a public phase-1 file, e.g. powersOfTau28_hez_final_17.ptau)');
  const circuits = (one('circuits') ?? PRODUCTION.join(',')).split(',').filter(Boolean);
  const r1csOverride = Object.fromEntries((opts.r1cs ?? []).map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));

  console.log(`ptau ${ptau}: hashing`);
  const ptauBlake2b = await hashFile(ptau, 'blake2b512');
  const expected = one('ptau-blake2b');
  if (expected && expected.toLowerCase() !== ptauBlake2b) die(`ptau blake2b ${ptauBlake2b} does not match --ptau-blake2b ${expected}`);
  if (!expected) console.warn('WARNING: no --ptau-blake2b given; compare the hash below with the published one before going public');
  if (opts['verify-ptau']) {
    console.log('verifying the ptau (slow)');
    const log = quietLogger();
    if (!(await snarkjs.powersOfTau.verify(ptau, log))) die(`ptau does not verify:\n${log.lines.join('\n')}`);
  }

  mkdirSync(dir, { recursive: true });
  const c = {
    version: VERSION,
    created: new Date().toISOString(),
    protocol: 'groth16', curve: 'bn128',
    ptau: { file: basename(ptau), blake2b: ptauBlake2b, sha256: await sha256(ptau), verified: !!opts['verify-ptau'], expected: expected ?? null },
    circuits: {},
    contributions: [],
    beacon: null,
  };
  for (const name of circuits) {
    const r1cs = resolve(r1csOverride[name] ?? join(root, 'build', 'circuits', name, `${name}.r1cs`));
    if (!existsSync(r1cs)) die(`missing ${r1cs} (npm run circuits:build ${name})`);
    mkdirSync(join(dir, name), { recursive: true });
    const z0 = zkeyPath(dir, name, 0);
    process.stdout.write(`init ${name} ... `);
    const csHash = await snarkjs.zKey.newZKey(r1cs, ptau, z0, quietLogger());
    if (!(csHash instanceof Uint8Array)) die(`newZKey failed for ${name} (is the ptau large enough for this circuit?)`);
    const info = await snarkjs.r1cs.info(r1cs, quietLogger());
    c.circuits[name] = {
      r1cs: relative(root, r1cs).replace(/\\/g, '/'), r1csSha256: await sha256(r1cs), circuitHash: hex(csHash),
      constraints: info.nConstraints, publicInputs: info.nPubInputs + info.nOutputs, init: { file: relative(dir, z0).replace(/\\/g, '/'), sha256: await sha256(z0) },
    };
    console.log(`ok (${info.nConstraints} constraints)`);
  }
  save(dir, c);
  console.log(`\nceremony initialised in ${dir}\nptau blake2b ${ptauBlake2b}\npublish ceremony.json and the *_0000.zkey files; the first participant runs contribute.`);
}

// ---------------------------------------------------------------- contribute
async function contribute() {
  const dir = dirOf();
  const c = load(dir);
  if (c.beacon) die('the beacon is already applied; the ceremony is closed');
  const name = one('name');
  if (!name) die('--name is required (public; it goes into the transcript)');
  // snarkjs hashes the entropy string with blake2b; ours is 64 fresh random bytes plus any extra the
  // participant supplies (a file of keyboard noise, dice rolls, ...). None of it is stored.
  let entropy = randomBytes(64).toString('hex');
  if (one('entropy-file')) entropy += createHash('sha512').update(readFileSync(one('entropy-file'))).digest('hex');
  if (process.env.CEREMONY_ENTROPY) entropy += createHash('sha512').update(process.env.CEREMONY_ENTROPY).digest('hex');

  // The files we build on must be the ones the transcript names.
  const prev = latestIndex(c);
  const entry = { index: prev + 1, name, at: new Date().toISOString(), circuits: {} };
  for (const circuit of Object.keys(c.circuits)) {
    const from = zkeyPath(dir, circuit, prev);
    const want = prev === 0 ? c.circuits[circuit].init.sha256 : c.contributions[prev - 1].circuits[circuit].sha256;
    if ((await sha256(from)) !== want) die(`${from} is not the file in the transcript`);
    const to = zkeyPath(dir, circuit, prev + 1);
    process.stdout.write(`contribute ${circuit} ... `);
    const h = await snarkjs.zKey.contribute(from, to, name, entropy, quietLogger());
    entry.circuits[circuit] = { file: relative(dir, to).replace(/\\/g, '/'), sha256: await sha256(to), prevSha256: want, contributionHash: hex(h) };
    console.log('ok');
  }
  entropy = '';
  c.contributions.push(entry);
  delete c.verified;
  save(dir, c);
  console.log(`\ncontribution #${entry.index} by ${name}. Publish these contribution hashes (they appear in every later verify):`);
  for (const [k, v] of Object.entries(entry.circuits)) console.log(`  ${k.padEnd(9)} ${v.contributionHash}`);
  console.log('Then hand back ceremony.json and the new zkeys, and destroy anything that held your entropy.');
}

// ---------------------------------------------------------------- verify
async function verify() {
  const dir = dirOf();
  const c = load(dir);
  const ptau = one('ptau') ?? (existsSync(join(dir, c.ptau.file)) ? join(dir, c.ptau.file) : null);
  if (!ptau || !existsSync(ptau)) die('--ptau FILE is required (the same file as at init)');
  if ((await hashFile(ptau, 'blake2b512')) !== c.ptau.blake2b) die('the ptau is not the one the ceremony was initialised with');
  let ok = true;
  const report = [];
  for (const [name, meta] of Object.entries(c.circuits)) {
    const r1cs = resolve(root, meta.r1cs);
    const fail = (why) => { ok = false; report.push(`${name}: FAIL ${why}`); };
    if (!existsSync(r1cs) || (await sha256(r1cs)) !== meta.r1csSha256) { fail(`r1cs ${meta.r1cs} differs from the one at init`); continue; }
    // Every file in the chain must be the one the transcript names, each built on the one before.
    const chain = [{ file: meta.init.file, sha256: meta.init.sha256 }, ...c.contributions.map((x) => x.circuits[name])];
    if (c.beacon) chain.push(c.beacon.circuits[name]);
    let brokenAt = null;
    for (let i = 0; i < chain.length; i++) {
      const f = join(dir, chain[i].file);
      if (!existsSync(f) || (await sha256(f)) !== chain[i].sha256) { brokenAt = chain[i].file; break; }
      if (i > 0 && chain[i].prevSha256 !== chain[i - 1].sha256) { brokenAt = `${chain[i].file} (prev hash)`; break; }
    }
    if (brokenAt) { fail(`transcript does not match ${brokenAt}`); continue; }
    // snarkjs re-derives the initial key from the r1cs and the ptau and checks every contribution proof.
    const last = join(dir, chain[chain.length - 1].file);
    const log = quietLogger();
    process.stdout.write(`verify ${name} (${chain.length - 1} contributions${c.beacon ? ' incl. beacon' : ''}) ... `);
    const good = await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, last, log);
    writeFileSync(join(dir, name, 'verify.log'), log.lines.join('\n') + '\n');
    if (!good) { console.log('FAIL'); fail(`snarkjs rejects ${chain[chain.length - 1].file}; see ${name}/verify.log`); continue; }
    // The contribution hashes snarkjs reads out of the key must be the ones in the transcript, in order.
    // (snarkjs logs each as one entry, newest first: "contribution #i name:\n<hash in 4 rows of hex words>")
    const inKey = [];
    for (const l of log.lines) {
      const m = /^contribution #(\d+)/.exec(l);
      if (m) inKey[Number(m[1]) - 1] = l.slice(l.indexOf('\n') + 1).replace(/\s+/g, '');
    }
    const expect = chain.slice(1).map((x) => x.contributionHash);
    if (inKey.length !== expect.length || inKey.some((h, i) => h !== expect[i])) {
      console.log('FAIL');
      const n = Math.max(inKey.length, expect.length);
      const diff = Array.from({ length: n }, (_, i) => `  #${i + 1} key ${inKey[i] ?? '(none)'}\n     transcript ${expect[i] ?? '(none)'}`).join('\n');
      fail(`contribution hashes in the key differ from the transcript\n${diff}`);
      continue;
    }
    console.log('ok');
    report.push(`${name}: ok, ${expect.length} contributions`);
  }
  console.log(report.join('\n'));
  if (!ok) process.exit(1);
  c.verified = { at: new Date().toISOString(), contributions: c.contributions.length, beacon: !!c.beacon };
  save(dir, c);
}

// ---------------------------------------------------------------- beacon
async function beacon() {
  const dir = dirOf();
  const c = load(dir);
  if (c.beacon) die('beacon already applied');
  if (c.contributions.length === 0) die('no contributions yet');
  const b = one('beacon');
  const source = one('source');
  if (!b || !/^[0-9a-fA-F]{2,}$/.test(b) || b.length % 2) die('--beacon HEX is required (a public random value announced in advance, e.g. a future block hash or drand round)');
  if (!source) die('--source "TEXT" is required: where the beacon value comes from, so anyone can check it');
  const iterations = Number(one('iterations', '10'));
  const prev = latestIndex(c);
  const entry = { name: 'final beacon', value: b.toLowerCase(), source, iterationsExp: iterations, at: new Date().toISOString(), circuits: {} };
  for (const circuit of Object.keys(c.circuits)) {
    const from = zkeyPath(dir, circuit, prev);
    const want = c.contributions[prev - 1].circuits[circuit].sha256;
    if ((await sha256(from)) !== want) die(`${from} is not the file in the transcript`);
    const to = zkeyPath(dir, circuit, 'final');
    process.stdout.write(`beacon ${circuit} ... `);
    const h = await snarkjs.zKey.beacon(from, to, 'final beacon', b, iterations, quietLogger());
    if (!h) die(`beacon failed for ${circuit}`);
    entry.circuits[circuit] = { file: relative(dir, to).replace(/\\/g, '/'), sha256: await sha256(to), prevSha256: want, contributionHash: hex(h) };
    console.log('ok');
  }
  c.beacon = entry;
  delete c.verified;
  save(dir, c);
  console.log('beacon applied; run verify, then export');
}

// ---------------------------------------------------------------- export
async function exportKeys() {
  const dir = dirOf();
  const c = load(dir);
  if (!c.beacon) die('apply the beacon first');
  if (!c.verified?.beacon) die('run verify after the beacon first');
  const out = join(dir, 'final');
  mkdirSync(join(out, 'verifiers'), { recursive: true });
  const template = readFileSync(join(root, 'node_modules', 'snarkjs', 'templates', 'verifier_groth16.sol.ejs'), 'utf8');
  const att = { ceremony: 'H0.81 Capital (stipend) Groth16 phase 2', protocol: c.protocol, curve: c.curve, ptau: c.ptau, circuits: {} };
  for (const [name, meta] of Object.entries(c.circuits)) {
    const zkey = join(dir, c.beacon.circuits[name].file);
    if ((await sha256(zkey)) !== c.beacon.circuits[name].sha256) die(`${zkey} changed since the beacon`);
    const vkey = await snarkjs.zKey.exportVerificationKey(zkey, quietLogger());
    const vkFile = join(out, `${name}.vkey.json`);
    writeFileSync(vkFile, JSON.stringify(vkey, null, 1));
    const Name = name[0].toUpperCase() + name.slice(1);
    const sol = (await snarkjs.zKey.exportSolidityVerifier(zkey, { groth16: template }, quietLogger()))
      .replace('contract Groth16Verifier', `contract ${Name}Verifier`)
      .replace(/pragma solidity [^;]+;/, 'pragma solidity ^0.8.20;');
    writeFileSync(join(out, 'verifiers', `${Name}Verifier.sol`), sol);
    att.circuits[name] = {
      r1cs: meta.r1cs, r1csSha256: meta.r1csSha256, circuitHash: meta.circuitHash, constraints: meta.constraints, publicInputs: vkey.nPublic,
      contributions: c.contributions.map((x) => ({ index: x.index, name: x.name, at: x.at, contributionHash: x.circuits[name].contributionHash })),
      beacon: { value: c.beacon.value, source: c.beacon.source, iterationsExp: c.beacon.iterationsExp, contributionHash: c.beacon.circuits[name].contributionHash },
      finalZkeySha256: c.beacon.circuits[name].sha256,
      vkeySha256: await sha256(vkFile),
    };
  }
  writeFileSync(join(dir, 'attestation.json'), JSON.stringify(att, null, 2) + '\n');
  writeFileSync(join(dir, 'ATTESTATION.md'), attestationMd(att, c));
  console.log(`wrote ${join(dir, 'attestation.json')}, ATTESTATION.md, final/*.vkey.json, final/verifiers/*.sol`);

  if (opts.install) {
    const names = Object.keys(c.circuits);
    if (names.length !== PRODUCTION.length || PRODUCTION.some((n) => !names.includes(n))) die('--install needs all six production circuits in the ceremony');
    for (const name of names) {
      const meta = c.circuits[name];
      const r1cs = join(root, 'build', 'circuits', name, `${name}.r1cs`);
      if ((await sha256(r1cs)) !== meta.r1csSha256) die(`build/circuits/${name}/${name}.r1cs is not the circuit of the ceremony`);
      copyFileSync(join(dir, c.beacon.circuits[name].file), join(root, 'build', 'circuits', name, `${name}.zkey`));
      copyFileSync(join(out, `${name}.vkey.json`), join(root, 'build', 'circuits', name, `${name}.vkey.json`));
      const Name = name[0].toUpperCase() + name.slice(1);
      copyFileSync(join(out, 'verifiers', `${Name}Verifier.sol`), join(root, 'contracts', 'verifiers', `${Name}Verifier.sol`));
    }
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'gen-solana-vk.mjs')], { stdio: 'inherit' });
    if (r.status !== 0) die('gen-solana-vk failed');
    writeFileSync(join(root, 'build', 'circuits', 'ceremony-attestation.json'), JSON.stringify(att, null, 2) + '\n');
    console.log('installed: build/circuits/*/{zkey,vkey.json}, contracts/verifiers/*.sol, solana vk.rs; copy of the attestation in build/circuits/ceremony-attestation.json');
    console.log('next: npm run contracts:compile, npm test, rebuild the Solana programs, and commit the verifiers, vk.rs and attestation.json');
  }
}

function attestationMd(att, c) {
  let s = `# Trusted-setup attestation\n\n${att.ceremony}. Groth16 on BN254 (snarkjs), one phase-2 chain per circuit.\n\n`;
  s += `Phase 1: \`${att.ptau.file}\`, blake2b \`${att.ptau.blake2b}\`${att.ptau.expected ? ' (checked against the published hash)' : ' (NOT checked against a published hash at init)'}` +
    `${att.ptau.verified ? ', verified with `snarkjs powersoftau verify`' : ''}.\n\n`;
  s += `Participants, in order:\n\n| # | name | at |\n|---|---|---|\n`;
  for (const x of c.contributions) s += `| ${x.index} | ${x.name.replace(/\|/g, '/')} | ${x.at} |\n`;
  s += `\nRandom beacon: \`${c.beacon.value}\` from ${c.beacon.source}, 2^${c.beacon.iterationsExp} iterations.\n\n`;
  for (const [name, x] of Object.entries(att.circuits)) {
    s += `## ${name}\n\n- r1cs sha256 \`${x.r1csSha256}\` (${x.constraints} constraints, ${x.publicInputs} public inputs)\n- circuit hash \`${x.circuitHash}\`\n`;
    for (const k of x.contributions) s += `- contribution #${k.index} (${k.name.replace(/\|/g, '/')}): \`${k.contributionHash}\`\n`;
    s += `- beacon: \`${x.beacon.contributionHash}\`\n- final zkey sha256 \`${x.finalZkeySha256}\`\n- verifying key sha256 \`${x.vkeySha256}\`\n\n`;
  }
  s += 'Check it yourself: `node scripts/ceremony.mjs verify --dir <ceremony dir> --ptau <ptau>` re-derives every key from the r1cs and the ptau and checks every contribution.\n';
  return s;
}

// ---------------------------------------------------------------- status
function status() {
  const dir = dirOf();
  const c = load(dir);
  console.log(`ceremony ${dir}\nptau ${c.ptau.file} blake2b ${c.ptau.blake2b.slice(0, 16)}...\ncircuits ${Object.keys(c.circuits).join(', ')}`);
  for (const x of c.contributions) console.log(`  #${x.index} ${x.name} ${x.at}`);
  console.log(`beacon ${c.beacon ? `${c.beacon.value} (${c.beacon.source})` : 'not yet'}; verified ${c.verified ? `${c.verified.at} (${c.verified.contributions} contributions, beacon ${c.verified.beacon})` : 'no'}`);
}

switch (cmd) {
  case 'init': await init(); break;
  case 'contribute': await contribute(); break;
  case 'verify': await verify(); break;
  case 'beacon': await beacon(); break;
  case 'export': await exportKeys(); break;
  case 'status': status(); break;
  default: die('usage: init | contribute | verify | beacon | export | status (see the header of scripts/ceremony.mjs)');
}
process.exit(0);
