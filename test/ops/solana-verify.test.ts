// Verifiable-build hash comparison (src/solana/verify.ts) against synthetic loader accounts: no RPC.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import {
  BPF_LOADER_2_ID, BPF_LOADER_UPGRADEABLE_ID, LOADER_V4_ID, PROGRAMDATA_METADATA, compareWithDeployed, executableHash, fetchDeployedProgram,
  fileHash, parseProgramData, programDataAddress, stripTrailingZeros, clusterUrl,
} from '../../src/solana/verify.js';

// A fake ELF that itself ends in zeros, like a real .so can.
const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 0, 9, 9, 0, 0]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function u64(n: bigint) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; }
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));

function programAccount(pd: PublicKey) { return cat(u32(2), pd.toBytes()); }
function programData(slot: bigint, authority: PublicKey | null, code: Uint8Array, maxLen: number) {
  const header = cat(u32(3), u64(slot), authority ? Uint8Array.of(1) : Uint8Array.of(0), authority ? authority.toBytes() : new Uint8Array(32));
  const body = new Uint8Array(maxLen);
  body.set(code);
  return cat(header, body);
}
const info = (owner: PublicKey, data: Uint8Array, executable: boolean): AccountInfo<Buffer> =>
  ({ owner, data: Buffer.from(data), executable, lamports: 1, rentEpoch: 0 });

function reader(accounts: Map<string, AccountInfo<Buffer>>) {
  const seen: string[] = [];
  return {
    seen,
    async getAccountInfo(k: PublicKey) { seen.push(k.toBase58()); return accounts.get(k.toBase58()) ?? null; },
  };
}

describe('executable hash', () => {
  it('strips trailing zeros only, like solana-verify', () => {
    expect([...stripTrailingZeros(elf)]).toEqual([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 0, 9, 9]);
    expect(executableHash(elf)).toBe(sha(elf.subarray(0, 10)));
    expect(fileHash(elf)).toBe(sha(elf));
    expect(executableHash(cat(elf, new Uint8Array(5000)))).toBe(executableHash(elf));
    expect(executableHash(new Uint8Array(3))).toBe(sha(new Uint8Array(0)));
  });
});

describe('deployed program (upgradeable loader)', () => {
  const id = Keypair.generate().publicKey;
  const pd = Keypair.generate().publicKey;
  const auth = Keypair.generate().publicKey;

  it('parses Program and ProgramData, with and without an upgrade authority', () => {
    expect(programDataAddress(programAccount(pd)).equals(pd)).toBe(true);
    const withAuth = parseProgramData(programData(77n, auth, elf, 64));
    expect(withAuth.slot).toBe(77n);
    expect(withAuth.upgradeAuthority?.equals(auth)).toBe(true);
    expect(withAuth.elf.length).toBe(64);
    const final = parseProgramData(programData(78n, null, elf, 64));
    expect(final.upgradeAuthority).toBeNull();
    expect(() => programDataAddress(cat(u32(3), pd.toBytes()))).toThrow(/Program account/);
    expect(() => parseProgramData(cat(u32(2), new Uint8Array(60)))).toThrow(/ProgramData/);
    expect(PROGRAMDATA_METADATA).toBe(45);
  });

  it('hashes the padded program data the same as the local .so and reports the authority', async () => {
    const r = reader(new Map([
      [id.toBase58(), info(BPF_LOADER_UPGRADEABLE_ID, programAccount(pd), true)],
      [pd.toBase58(), info(BPF_LOADER_UPGRADEABLE_ID, programData(5n, null, elf, elf.length * 5), false)],
    ]));
    const d = await fetchDeployedProgram(r, id);
    expect(d.loader).toBe('upgradeable');
    expect(d.upgradeAuthority).toBeNull();
    expect(d.executableHash).toBe(executableHash(elf));
    expect(r.seen).toEqual([id.toBase58(), pd.toBase58()]);

    const same = await compareWithDeployed(r, id, elf);
    expect(same.match).toBe(true);
    const other = await compareWithDeployed(r, id, Uint8Array.from([...elf.subarray(0, 10), 1]));
    expect(other.match).toBe(false);
  });

  it('refuses a missing, non-executable or foreign-owned account', async () => {
    await expect(fetchDeployedProgram(reader(new Map()), id)).rejects.toThrow(/no account/);
    await expect(fetchDeployedProgram(reader(new Map([[id.toBase58(), info(BPF_LOADER_UPGRADEABLE_ID, programAccount(pd), false)]])), id)).rejects.toThrow(/not executable/);
    await expect(fetchDeployedProgram(reader(new Map([[id.toBase58(), info(Keypair.generate().publicKey, elf, true)]])), id)).rejects.toThrow(/not a known loader/);
    const fakePd = reader(new Map([
      [id.toBase58(), info(BPF_LOADER_UPGRADEABLE_ID, programAccount(pd), true)],
      [pd.toBase58(), info(Keypair.generate().publicKey, programData(5n, null, elf, 32), false)],
    ]));
    await expect(fetchDeployedProgram(fakePd, id)).rejects.toThrow(/wrong owner/);
  });
});

describe('other loaders', () => {
  it('reads loader v2 (data is the ELF) and loader v4 (48-byte header, finalized = no authority)', async () => {
    const id = Keypair.generate().publicKey;
    const v2 = await fetchDeployedProgram(reader(new Map([[id.toBase58(), info(BPF_LOADER_2_ID, elf, true)]])), id);
    expect(v2.loader).toBe('v2');
    expect(v2.executableHash).toBe(executableHash(elf));

    const auth = Keypair.generate().publicKey;
    const v4 = (status: bigint) => cat(u64(9n), auth.toBytes(), u64(status), elf, new Uint8Array(16));
    const deployed = await fetchDeployedProgram(reader(new Map([[id.toBase58(), info(LOADER_V4_ID, v4(1n), true)]])), id);
    expect(deployed.upgradeAuthority?.equals(auth)).toBe(true);
    expect(deployed.executableHash).toBe(executableHash(elf));
    const finalized = await fetchDeployedProgram(reader(new Map([[id.toBase58(), info(LOADER_V4_ID, v4(2n), true)]])), id);
    expect(finalized.upgradeAuthority).toBeNull();
  });

  it('maps cluster names and refuses anything that is not a URL', () => {
    expect(clusterUrl('devnet')).toBe('https://api.devnet.solana.com');
    expect(clusterUrl('mainnet-beta')).toBe('https://api.mainnet-beta.solana.com');
    expect(clusterUrl('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
    expect(() => clusterUrl('localnet')).toThrow(/unknown cluster/);
  });
});
