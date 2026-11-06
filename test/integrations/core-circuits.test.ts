import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FlatDirProver, fetchCircuits, missingCircuits, sha256Hex, verifyCircuits } from '../../integrations/core/circuits.js';
import { CIRCUIT_HASHES } from '../../integrations/core/constants.js';
import { AutoFetchProver } from '../../integrations/core/open.js';

/** A fake artifact server: a file's body is whatever `bodies` says (default: bytes whose sha256 is pinned). */
function server(bodies: Record<string, Uint8Array>) {
  const hits: string[] = [];
  const f = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    hits.push(url);
    const name = url.slice(url.lastIndexOf('/') + 1);
    const body = bodies[name];
    if (!body) return new Response('nope', { status: 404 });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: f, hits };
}

describe('circuits', () => {
  it('FlatDirProver reads the site layout <dir>/<name>.{wasm,zkey,vkey.json}', () => {
    const p = new FlatDirProver('/circuits');
    expect(p.paths('transact')).toEqual({ wasm: join('/circuits', 'transact.wasm'), zkey: join('/circuits', 'transact.zkey'), vkey: join('/circuits', 'transact.vkey.json') });
    expect(p.paths('grant').zkey).toBe(join('/circuits', 'grant.zkey'));
  });

  it('fetchCircuits refuses a file whose sha256 is not the pinned one and writes nothing for it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h081-circuits-'));
    const good = new TextEncoder().encode('good');
    // pin the fake bytes for this test only
    const saved = { ...CIRCUIT_HASHES.transact };
    Object.assign(CIRCUIT_HASHES.transact, { wasm: sha256Hex(good), zkey: sha256Hex(good), vkey: sha256Hex(good) });
    try {
      const tampered = server({ 'transact.wasm': good, 'transact.zkey': new TextEncoder().encode('evil'), 'transact.vkey.json': good });
      await expect(fetchCircuits({ dir, names: ['transact'], url: 'https://example.test/circuits', fetch: tampered.fetch })).rejects.toThrow(/sha256 .* does not match the pinned .*; refusing/);
      expect(existsSync(join(dir, 'transact.wasm'))).toBe(true); // the good file before it was kept
      expect(existsSync(join(dir, 'transact.zkey'))).toBe(false); // the tampered one never landed
      expect(readdirSync(dir).filter((f) => f.includes('.part-'))).toEqual([]);
      expect(missingCircuits(dir, ['transact'])).toEqual(['transact']);

      const ok = server({ 'transact.wasm': good, 'transact.zkey': good, 'transact.vkey.json': good });
      const r = await fetchCircuits({ dir, names: ['transact'], url: 'https://example.test/circuits/', fetch: ok.fetch });
      expect(r.kept).toEqual([join(dir, 'transact.wasm')]);
      expect(r.fetched).toEqual([join(dir, 'transact.zkey'), join(dir, 'transact.vkey.json')]);
      expect(ok.hits).toEqual(['https://example.test/circuits/transact.zkey', 'https://example.test/circuits/transact.vkey.json']);
      expect(missingCircuits(dir, ['transact'])).toEqual([]);
      expect(verifyCircuits(dir, ['transact'])).toEqual([]);

      // a corrupted file on disk is found by verify and replaced by fetch (repair)
      writeFileSync(join(dir, 'transact.zkey'), 'corrupt');
      expect(verifyCircuits(dir, ['transact'])).toEqual([join(dir, 'transact.zkey')]);
      const again = server({ 'transact.wasm': good, 'transact.zkey': good, 'transact.vkey.json': good });
      await fetchCircuits({ dir, names: ['transact'], url: 'https://example.test/circuits/', fetch: again.fetch });
      expect(readFileSync(join(dir, 'transact.zkey'), 'utf8')).toBe('good');
      expect(again.hits).toEqual(['https://example.test/circuits/transact.zkey']);

      // AutoFetchProver fetches once per circuit, on demand, and dedupes concurrent requests
      const dir2 = mkdtempSync(join(tmpdir(), 'h081-circuits-'));
      const lazy = server({ 'transact.wasm': good, 'transact.zkey': good, 'transact.vkey.json': good });
      const prover = new AutoFetchProver(dir2, 'https://example.test/circuits/', lazy.fetch);
      expect(lazy.hits).toEqual([]);
      await Promise.all([prover.ensure('transact'), prover.ensure('transact')]);
      expect(lazy.hits).toHaveLength(3);
      await prover.ensure('transact');
      expect(lazy.hits).toHaveLength(3);
    } finally {
      Object.assign(CIRCUIT_HASHES.transact, saved);
    }
  });

  it('refuses to fetch a circuit with no pinned hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h081-circuits-'));
    await expect(fetchCircuits({ dir, names: ['delegate'], fetch: server({}).fetch })).rejects.toThrow(/no pinned hash/);
  });

  it('the pinned zkey and vkey hashes are the ceremony\'s (docs/CEREMONY.md)', () => {
    expect(CIRCUIT_HASHES.transact.zkey).toBe('19115cc60b47b8ba71a8bd2ec0eb7d1973801df78d5eee52550c1daca8ca940f');
    expect(CIRCUIT_HASHES.grant.zkey).toBe('8c1df0b58d1bdb69a60097479fa49d344af5ccbd8c21d6b625c60eeca1584200');
    expect(CIRCUIT_HASHES.stream.zkey).toBe('466363f8ff528443d6fe73122d26df3689a8409af3cf0ba7238ae366e6911deb'); // round 2
    expect(CIRCUIT_HASHES.spend.zkey).toBe('709c59049c6e133ba981ba32a962af42f839d7600ada4e0e51237654d4e02b91'); // round 2
    expect(CIRCUIT_HASHES.delegate.zkey).toBe('6e47fc61d6023562c6d3a8429e09fc5b3d9b0df5fcd91243f50508e11074e631'); // round 2
    expect(CIRCUIT_HASHES.transact.vkey).toBe('ea4def715d6fe7c4dd834ee973f491d80fac913b7c0a10e2a505faa0091259bb');
    for (const n of ['transact', 'grant', 'stream'] as const) expect(CIRCUIT_HASHES[n].wasm).toMatch(/^[0-9a-f]{64}$/);
  });
});
