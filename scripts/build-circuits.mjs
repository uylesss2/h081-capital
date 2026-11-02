// Compiles every circuit in circuits/main into build/circuits/<name>/.
// The WASM build of circom (circom2) can only see its working directory and
// keeps the input path inside output names, so each circuit is staged into
// its own folder together with the include libraries and compiled there.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, existsSync, cpSync, copyFileSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const srcDir = join(root, 'circuits', 'main');
const outRoot = join(root, 'build', 'circuits');
const only = process.argv.slice(2);
const win = process.platform === 'win32';

const circom = join(root, 'node_modules', '.bin', win ? 'circom2.cmd' : 'circom2');
const snarkjs = join(root, 'node_modules', '.bin', win ? 'snarkjs.cmd' : 'snarkjs');
const files = readdirSync(srcDir).filter((f) => f.endsWith('.circom') && (only.length === 0 || only.includes(f.replace('.circom', ''))));

for (const file of files) {
  const name = file.replace('.circom', '');
  const out = join(outRoot, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(join(srcDir, file), join(out, file));
  cpSync(join(root, 'circuits', 'lib'), join(out, 'lib'), { recursive: true });
  cpSync(join(root, 'node_modules', 'circomlib', 'circuits'), join(out, 'circomlib', 'circuits'), { recursive: true });

  const t0 = Date.now();
  process.stdout.write(`compiling ${name} ... `);
  execFileSync(circom, [file, '--r1cs', '--wasm', '--sym', '-l', '.'], { cwd: out, stdio: ['ignore', 'pipe', 'inherit'], shell: win });
  rmSync(join(out, 'lib'), { recursive: true, force: true });
  rmSync(join(out, 'circomlib'), { recursive: true, force: true });
  rmSync(join(out, file), { force: true });
  // circom's witness_calculator.js assigns an undeclared `a`, which throws under strict mode.
  const wc = join(out, `${name}_js`, 'witness_calculator.js');
  writeFileSync(wc, readFileSync(wc, 'utf8').replace('\ta = flatArray(input);', '\tlet a = flatArray(input);'));

  const info = execFileSync(snarkjs, ['r1cs', 'info', join(out, `${name}.r1cs`)], { shell: win }).toString();
  const constraints = /# of Constraints:\s*(\d+)/.exec(info)?.[1];
  console.log(`ok (${constraints} constraints, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (!existsSync(join(out, `${name}_js`, `${name}.wasm`))) throw new Error(`missing wasm for ${name}`);
}
