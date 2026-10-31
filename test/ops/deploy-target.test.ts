// Which stipend_pool scripts/mainnet-init.mts initializes (src/solana/deploy-target.ts), against synthetic
// loader accounts: no RPC, no transaction.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import { MAINNET_GENESIS, resolvePoolProgramId, resolvePoolTarget } from '../../src/solana/deploy-target.js';
import { LOCALNET_POOL_PROGRAM_ID, programDataAddress } from '../../src/solana/index.js';
import { BPF_LOADER_2_ID, BPF_LOADER_UPGRADEABLE_ID } from '../../src/solana/verify.js';

const LOCAL_GENESIS = 'LocalGenesis1111111111111111111111111111111';
const so = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 5, 6, 7, 8]);

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
const info = (owner: PublicKey, data: Uint8Array, executable: boolean): AccountInfo<Buffer> =>
  ({ owner, data: Buffer.from(data), executable, lamports: 1, rentEpoch: 0 });

/** An upgradeable-loader program at `id`: Program -> ProgramData (the real PDA) with `authority` and `code`. */
function chain(id: PublicKey, authority: PublicKey | null, code = so) {
  const pd = programDataAddress(id);
  const body = new Uint8Array(code.length + 64); // deployed with --max-len headroom: zero padding
  body.set(code);
  const pdData = cat(u32(3), new Uint8Array(8), Uint8Array.of(authority ? 1 : 0), authority ? authority.toBytes() : new Uint8Array(32), body);
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [id.toBase58(), info(BPF_LOADER_UPGRADEABLE_ID, cat(u32(2), pd.toBytes()), true)],
    [pd.toBase58(), info(BPF_LOADER_UPGRADEABLE_ID, pdData, false)],
  ]);
  return { async getAccountInfo(k: PublicKey) { return accounts.get(k.toBase58()) ?? null; } };
}

const dir = mkdtempSync(join(tmpdir(), 'h081-deploy-target-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const programKp = Keypair.generate();
writeFileSync(join(dir, 'stipend_pool-keypair.json'), JSON.stringify([...programKp.secretKey]));

describe('stipend_pool program id for the setup script', () => {
  it('comes from POOL_PROGRAM_ID or the keys dir, never from a default', () => {
    const id = Keypair.generate().publicKey;
    expect(resolvePoolProgramId({ programId: id.toBase58(), genesis: LOCAL_GENESIS }).equals(id)).toBe(true);
    expect(resolvePoolProgramId({ keysDir: dir, genesis: MAINNET_GENESIS }).equals(programKp.publicKey)).toBe(true);
    expect(resolvePoolProgramId({ programId: programKp.publicKey.toBase58(), keysDir: dir, genesis: MAINNET_GENESIS }).equals(programKp.publicKey)).toBe(true);
    expect(() => resolvePoolProgramId({ genesis: MAINNET_GENESIS })).toThrow(/POOL_PROGRAM_ID/);
    expect(() => resolvePoolProgramId({ programId: id.toBase58(), keysDir: dir, genesis: MAINNET_GENESIS })).toThrow(/differs/);
  });

  it('refuses the localnet id on mainnet but allows it for a local rehearsal', () => {
    expect(() => resolvePoolProgramId({ programId: LOCALNET_POOL_PROGRAM_ID.toBase58(), genesis: MAINNET_GENESIS })).toThrow(/localnet/);
    expect(resolvePoolProgramId({ programId: LOCALNET_POOL_PROGRAM_ID.toBase58(), genesis: LOCAL_GENESIS }).equals(LOCALNET_POOL_PROGRAM_ID)).toBe(true);
  });
});

describe('deployed stipend_pool checks (before anything is signed)', () => {
  const payer = Keypair.generate().publicKey;
  const id = programKp.publicKey;

  it('accepts the program deployed with the reviewed .so and the payer as upgrade authority', async () => {
    const t = await resolvePoolTarget(chain(id, payer), { keysDir: dir, genesis: MAINNET_GENESIS, payer, expectSo: so });
    expect(t.programId.equals(id)).toBe(true);
    expect(t.upgradeAuthority?.equals(payer)).toBe(true);
    expect(t.loader).toBe('upgradeable');
  });

  it('fails when the program is not deployed at that id', async () => {
    await expect(resolvePoolTarget(chain(Keypair.generate().publicKey, payer), { keysDir: dir, genesis: MAINNET_GENESIS, payer, expectSo: so }))
      .rejects.toThrow(/is not deployed/);
  });

  it('fails when the signer is not the upgrade authority, or the program is final', async () => {
    await expect(resolvePoolTarget(chain(id, Keypair.generate().publicKey), { keysDir: dir, genesis: MAINNET_GENESIS, payer, expectSo: so }))
      .rejects.toThrow(/not the upgrade authority/);
    await expect(resolvePoolTarget(chain(id, null), { keysDir: dir, genesis: MAINNET_GENESIS, payer, expectSo: so })).rejects.toThrow(/final/);
  });

  it('fails when the deployed code is not the expected .so, and requires the .so on mainnet', async () => {
    await expect(resolvePoolTarget(chain(id, payer, Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 9])), { keysDir: dir, genesis: MAINNET_GENESIS, payer, expectSo: so }))
      .rejects.toThrow(/differs from the expected/);
    await expect(resolvePoolTarget(chain(id, payer), { keysDir: dir, genesis: MAINNET_GENESIS, payer })).rejects.toThrow(/POOL_SO/);
    // a local rehearsal may skip the hash check
    await expect(resolvePoolTarget(chain(id, payer), { keysDir: dir, genesis: LOCAL_GENESIS, payer })).resolves.toBeTruthy();
  });

  it('refuses a non-upgradeable loader (initialize reads the ProgramData)', async () => {
    const legacy = { async getAccountInfo(k: PublicKey) { return k.equals(id) ? info(BPF_LOADER_2_ID, so, true) : null; } };
    await expect(resolvePoolTarget(legacy, { keysDir: dir, genesis: LOCAL_GENESIS, payer })).rejects.toThrow(/upgradeable loader/);
  });
});
