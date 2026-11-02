// Deploy pre-flight (scripts/solana-preflight.mts) and the vk.rs drift check (gen-solana-vk.mjs --check).
// Local only: no RPC, throwaway directories, no real keys. Needs build/circuits (npm run circuits:setup).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const root = resolve(import.meta.dirname, '..', '..');
const built = existsSync(join(root, 'build', 'circuits', 'stream', 'stream.zkey'));
const work = mkdtempSync(join(tmpdir(), 'h081-preflight-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const node = (...args: string[]) => {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const preflight = (...args: string[]) => node(join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(root, 'scripts', 'solana-preflight.mts'), ...args);

describe.skipIf(!built)('deploy pre-flight', () => {
  it('vk.rs and zeros.rs match the verifying keys in build/circuits', () => {
    const r = node(join(root, 'scripts', 'gen-solana-vk.mjs'), '--check');
    expect(r.out).toContain('match');
    expect(r.status).toBe(0);
  });

  it('refuses missing keypairs and a localnet-only build, and writes no stamp', () => {
    const keys = join(work, 'keys');
    const so = join(work, 'so');
    mkdirSync(keys);
    mkdirSync(so);
    // An ELF that embeds the capacity_stake_fast program id: a localnet-only build.
    const fast = new PublicKey('DoiRuuwMkN8M4CWQy45Lne2wGP7JCPUtPDiC1pE9QM1q').toBytes();
    writeFileSync(join(so, 'capacity_stake.so'), Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(16), Buffer.from(fast)]));
    const r = preflight('--cluster', 'mainnet-beta', '--skip-tests', '--keys', keys, '--so', so);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL\s+stipend_pool: no keypair/);
    expect(r.out).toMatch(/FAIL\s+capacity_stake: contains a probe\/fast program id/);
    expect(r.out).toMatch(/FAIL\s+.*not a verifiable-build output/); // strict on mainnet
    expect(r.out).toContain('NOT READY');
    expect(existsSync(join(so, 'PREFLIGHT.txt'))).toBe(false);
  });

  it('rejects an unknown cluster', () => {
    expect(preflight('--cluster', 'localhost').status).toBe(2);
  });
});
