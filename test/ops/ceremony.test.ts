// The phase-2 ceremony tooling end to end on a toy circuit and a small local ptau: init, two
// participants, verify, beacon, verify, export, then a real proof against the exported key. Tampering
// with a zkey or the transcript must make verify fail.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as snarkjs from 'snarkjs';
import { getCurveFromName } from 'ffjavascript';

const root = resolve(import.meta.dirname, '..', '..');
const win = process.platform === 'win32';
const work = mkdtempSync(join(tmpdir(), 'h081-ceremony-'));
const dir = join(work, 'ceremony');
const ptau = join(work, 'pot8.ptau');
const r1cs = join(work, 'toy.r1cs');
const wasm = join(work, 'toy_js', 'toy.wasm');

function ceremony(...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'ceremony.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, CEREMONY_ENTROPY: '' } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const transcript = () => JSON.parse(readFileSync(join(dir, 'ceremony.json'), 'utf8'));

beforeAll(async () => {
  // toy circuit: c = a * b, a public
  writeFileSync(join(work, 'toy.circom'), 'pragma circom 2.0.0;\ntemplate T() { signal input a; signal input b; signal output c; c <== a * b; }\ncomponent main {public [a]} = T();\n');
  const circom = join(root, 'node_modules', '.bin', win ? 'circom2.cmd' : 'circom2');
  execFileSync(circom, ['toy.circom', '--r1cs', '--wasm'], { cwd: work, stdio: 'pipe', shell: win });
  const wc = join(work, 'toy_js', 'witness_calculator.js');
  writeFileSync(wc, readFileSync(wc, 'utf8').replace('\ta = flatArray(input);', '\tlet a = flatArray(input);'));
  // a small phase-1 file with one local contribution (stands in for the public Hermez ptau)
  const curve = await getCurveFromName('bn128');
  await snarkjs.powersOfTau.newAccumulator(curve, 8, join(work, 'p0.ptau'));
  await snarkjs.powersOfTau.contribute(join(work, 'p0.ptau'), join(work, 'p1.ptau'), 'test', 'phase one entropy');
  await snarkjs.powersOfTau.preparePhase2(join(work, 'p1.ptau'), ptau);
  await curve.terminate();
}, 300_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('ceremony', () => {
  it('runs init, two contributions, beacon and export, and the final key proves', async () => {
    const wrongHash = 'ab'.repeat(64);
    expect(ceremony('init', '--dir', dir, '--ptau', ptau, '--ptau-blake2b', wrongHash, '--circuits', 'toy', '--r1cs', `toy=${r1cs}`).status).toBe(2);

    let r = ceremony('init', '--dir', dir, '--ptau', ptau, '--circuits', 'toy', '--r1cs', `toy=${r1cs}`, '--verify-ptau');
    expect(r.status, r.out).toBe(0);
    expect(transcript().circuits.toy.constraints).toBe(1);
    expect(ceremony('init', '--dir', dir, '--ptau', ptau, '--circuits', 'toy', '--r1cs', `toy=${r1cs}`).status).toBe(2); // no double init

    expect(ceremony('beacon', '--dir', dir, '--beacon', 'aa', '--source', 'x').status).toBe(2); // needs a contribution
    r = ceremony('contribute', '--dir', dir, '--name', 'alice');
    expect(r.status, r.out).toBe(0);
    r = ceremony('contribute', '--dir', dir, '--name', 'bob');
    expect(r.status, r.out).toBe(0);
    const t = transcript();
    expect(t.contributions.map((c: { name: string }) => c.name)).toEqual(['alice', 'bob']);
    expect(t.contributions[1].circuits.toy.prevSha256).toBe(t.contributions[0].circuits.toy.sha256);
    expect(t.contributions[0].circuits.toy.contributionHash).toMatch(/^[0-9a-f]{128}$/);

    r = ceremony('verify', '--dir', dir, '--ptau', ptau);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('toy: ok, 2 contributions');
    expect(ceremony('export', '--dir', dir).status).toBe(2); // beacon first

    r = ceremony('beacon', '--dir', dir, '--beacon', '0123456789abcdef'.repeat(4), '--source', 'test value', '--iterations', '10');
    expect(r.status, r.out).toBe(0);
    expect(ceremony('contribute', '--dir', dir, '--name', 'late').status).toBe(2); // closed after the beacon
    expect(ceremony('export', '--dir', dir).status).toBe(2); // verify after the beacon first
    r = ceremony('verify', '--dir', dir, '--ptau', ptau);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('toy: ok, 3 contributions');
    r = ceremony('export', '--dir', dir);
    expect(r.status, r.out).toBe(0);

    const att = JSON.parse(readFileSync(join(dir, 'attestation.json'), 'utf8'));
    expect(att.circuits.toy.contributions).toHaveLength(2);
    expect(att.circuits.toy.beacon.source).toBe('test value');
    expect(readFileSync(join(dir, 'ATTESTATION.md'), 'utf8')).toContain('alice');
    expect(existsSync(join(dir, 'final', 'verifiers', 'ToyVerifier.sol'))).toBe(true);

    const vkey = JSON.parse(readFileSync(join(dir, 'final', 'toy.vkey.json'), 'utf8'));
    const { proof, publicSignals } = await snarkjs.groth16.fullProve({ a: 3, b: 11 }, wasm, join(dir, 'toy', 'toy_final.zkey'));
    expect(publicSignals).toEqual(['33', '3']);
    expect(await snarkjs.groth16.verify(vkey, publicSignals, proof)).toBe(true);
    expect(await snarkjs.groth16.verify(vkey, ['34', '3'], proof)).toBe(false);
  }, 300_000);

  it('verify fails when a zkey is swapped or the transcript is edited', () => {
    const t = transcript();
    // a zkey that is not the one named in the transcript
    const z1 = join(dir, 'toy', 'toy_0001.zkey');
    const backup = join(work, 'backup.zkey');
    copyFileSync(z1, backup);
    copyFileSync(join(dir, 'toy', 'toy_0002.zkey'), z1);
    let r = ceremony('verify', '--dir', dir, '--ptau', ptau);
    expect(r.status).toBe(1);
    expect(r.out).toContain('transcript does not match toy/toy_0001.zkey');
    copyFileSync(backup, z1);

    // a transcript that claims a different contribution hash
    const edited = structuredClone(t);
    edited.contributions[0].circuits.toy.contributionHash = '00'.repeat(64);
    writeFileSync(join(dir, 'ceremony.json'), JSON.stringify(edited));
    r = ceremony('verify', '--dir', dir, '--ptau', ptau);
    expect(r.status).toBe(1);
    expect(r.out).toContain('contribution hashes in the key differ from the transcript');

    writeFileSync(join(dir, 'ceremony.json'), JSON.stringify(t));
    r = ceremony('verify', '--dir', dir, '--ptau', ptau);
    expect(r.status, r.out).toBe(0);
  }, 300_000);
});
