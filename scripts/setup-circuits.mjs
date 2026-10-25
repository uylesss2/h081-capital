// Groth16 setup for every compiled circuit. Produces, per circuit:
//   build/circuits/<name>/<name>.zkey      proving key (dev ceremony: one local contribution)
//   build/circuits/<name>/<name>.vkey.json verification key
//   contracts/verifiers/<Name>Verifier.sol  on-chain verifier
// A production deployment replaces the single contribution with a public
// multi-party ceremony; the circuits and the pipeline do not change.
import * as snarkjs from 'snarkjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const ptau = process.env.PTAU || join(root, 'circuits', 'ptau', 'pot17.ptau');
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['transact', 'grant', 'spend', 'disclose', 'delegate'];
const template = readFileSync(join(root, 'node_modules', 'snarkjs', 'templates', 'verifier_groth16.sol.ejs'), 'utf8');
mkdirSync(join(root, 'contracts', 'verifiers'), { recursive: true });

for (const name of names) {
  const dir = join(root, 'build', 'circuits', name);
  const r1cs = join(dir, `${name}.r1cs`);
  const zkey0 = join(dir, `${name}.0.zkey`);
  const zkey = join(dir, `${name}.zkey`);
  if (!existsSync(r1cs)) throw new Error(`compile first: ${r1cs}`);
  const t0 = Date.now();
  process.stdout.write(`setup ${name} ... `);
  await snarkjs.zKey.newZKey(r1cs, ptau, zkey0);
  await snarkjs.zKey.contribute(zkey0, zkey, 'stipend dev contribution', randomBytes(32).toString('hex'));
  const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
  writeFileSync(join(dir, `${name}.vkey.json`), JSON.stringify(vkey, null, 1));
  const Name = name[0].toUpperCase() + name.slice(1);
  const sol = (await snarkjs.zKey.exportSolidityVerifier(zkey, { groth16: template }))
    .replace('contract Groth16Verifier', `contract ${Name}Verifier`)
    .replace(/pragma solidity [^;]+;/, 'pragma solidity ^0.8.20;');
  writeFileSync(join(root, 'contracts', 'verifiers', `${Name}Verifier.sol`), sol);
  console.log(`ok (${vkey.nPublic} public signals, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
process.exit(0);
