// Prove solvency in one line (docs/SOLVENCY-SPEC.md): codes 10/11, the audience and signature binding, the ladder and
// the probing cap, and every refusal of the verifier in the spec's order, over a REAL disclose proof made with the
// build tree's artifacts (the ceremony's when they are there; a dev setup's in CI, then pinned for the test only).
// No validator: the pool's root ring, the AssetCap accounts and the vaults are served by a fake connection.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { Account } from '../../src/account.js';
import { type Allowance, allowanceCommitment, initCrypto, randomField } from '../../src/crypto.js';
import { LEVELS, discloseInput } from '../../src/inputs.js';
import { MerkleTree } from '../../src/merkle.js';
import { Prover } from '../../src/prover.js';
import { encodeProof, fieldOf } from '../../src/solana/field.js';
import { poolPda, vaultPda } from '../../src/solana/pda.js';
import { POOL_DISCRIMINATOR, POOL_SIZE, encodeDiscloseArgs } from '../../src/solana/program.js';
import {
  SOLVENCY_DOES_NOT_SAY, type VaultTx, assetFloor, isOnLadder, presentationMessage, probeBlock, rootAge, snapDown, snapUp, solvencyAudience, solvencyStatement, vaultTxPeak,
} from '../../src/solvency.js';
import {
  type CodeContext, CodeError, SOLVENCY_ASK_PREFIX, SOLVENCY_PREFIX, decodeSolvencyCode, decodeSolvencyRequest, encodeAddressCode, encodeSolvencyCode,
  encodeSolvencyRequest, unframeV2, CODE_KIND,
} from '../../integrations/core/codes.js';
import { CIRCUIT_HASHES, MAINNET } from '../../integrations/core/constants.js';
import { deriveReserveSk, deriveLenderSk, deriveAgentSk, deriveAccountSk } from '../../integrations/core/keys.js';
import { type SolvencyHost, checkSolvencyProbe, decodeProofBytes, verifySolvency } from '../../integrations/core/solvency.js';

const U = 1_000_000n;
const CTX: CodeContext = { cluster: 'mainnet-beta', program: MAINNET.programs.pool, mint: MAINNET.usdg.mint };
const OTHER: CodeContext = { cluster: 'localnet', program: MAINNET.programs.pool, mint: MAINNET.usdg.mint };
const POOL = new PublicKey(MAINNET.programs.pool);
const USDG = new PublicKey(MAINNET.usdg.mint);
const NOW = 1_900_000_000;

function request(over: Partial<Parameters<typeof encodeSolvencyRequest>[1]> = {}, ctx = CTX) {
  return encodeSolvencyRequest(ctx, {
    verifierKey: new Uint8Array(32).fill(7), nonce: new Uint8Array(16).fill(9), expiry: BigInt(NOW + 600), min: 2500n * U, maxRootAge: 32,
    expectWallet: new Uint8Array(32), label: 'acme-desk', ...over,
  });
}

describe('solvency codes (kinds 10 and 11, v2 frame)', () => {
  it('a request round-trips, and its digest is recomputed from the frame', () => {
    const { code, digest } = request();
    expect(code.startsWith(SOLVENCY_ASK_PREFIX)).toBe(true);
    expect(code.slice(SOLVENCY_ASK_PREFIX.length)).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    const r = decodeSolvencyRequest(CTX, code);
    expect(r).toMatchObject({ min: 2500n * U, maxRootAge: 32, label: 'acme-desk', expiry: BigInt(NOW + 600) });
    expect(Buffer.from(r.digest).toString('hex')).toBe(Buffer.from(digest).toString('hex'));
    // any change to the request changes the digest
    expect(Buffer.from(request({ min: 5000n * U }).digest).equals(Buffer.from(digest))).toBe(false);
    expect(Buffer.from(request({}, OTHER).digest).equals(Buffer.from(digest))).toBe(false);
  });

  it('a presentation round-trips byte for byte', () => {
    const p = { requestDigest: new Uint8Array(32).fill(1), proof: new Uint8Array(256).fill(2), args: new Uint8Array(192).fill(3), wallet: new Uint8Array(32).fill(4), signature: new Uint8Array(64).fill(5) };
    const code = encodeSolvencyCode(CTX, p);
    expect(code.startsWith(SOLVENCY_PREFIX)).toBe(true);
    const back = decodeSolvencyCode(CTX, code);
    for (const k of Object.keys(p) as (keyof typeof p)[]) expect(Buffer.from(back[k]).equals(Buffer.from(p[k]))).toBe(true);
    // the kind 11 proof+args are kind 3's first 448 bytes: the same encoders
    expect(back.proof.length + back.args.length).toBe(448);
  });

  it('survives what copying adds: quotes, Markdown, zero-width characters, line breaks', () => {
    const { code } = request();
    const mangled = '> "`' + code.slice(0, 40) + '​\n' + code.slice(40) + '`".';
    expect(decodeSolvencyRequest(CTX, mangled).label).toBe('acme-desk');
  });

  it('refuses a wrong kind, network, checksum, a cut-off code and other codes by name', () => {
    const { code } = request();
    // the request where a presentation is expected (with and without its prefix)
    expect(() => decodeSolvencyCode(CTX, code)).toThrow(/"h081-solvency-ask:" code, not a solvency proof code/);
    expect(() => decodeSolvencyCode(CTX, code.slice(SOLVENCY_ASK_PREFIX.length))).toThrow(/That is a solvency request code, not a solvency proof code/);
    expect(() => decodeSolvencyRequest(OTHER, code)).toThrow(/another network/);
    const flipped = code.slice(0, -3) + (code.at(-3) === 'a' ? 'b' : 'a') + code.slice(-2);
    expect(() => decodeSolvencyRequest(CTX, flipped)).toThrow(/built-in check/);
    expect(() => decodeSolvencyRequest(CTX, code.slice(0, 30))).toThrow(CodeError);
    expect(() => decodeSolvencyRequest(CTX, 'h081-rep:3vQB7B6MrGQZaxCuFg4oh')).toThrow(/"h081-rep:" code, not a solvency request code/);
    expect(() => decodeSolvencyRequest(CTX, 'h081-backing:3vQB7B6MrGQZaxCuFg4oh')).toThrow(/"h081-backing:" code/);
    const addr = encodeAddressCode(CTX, { pk: 5n, viewPub: new Uint8Array(32).fill(1) });
    expect(() => decodeSolvencyRequest(CTX, addr)).toThrow(/"h081-address:" code, not a solvency request code/);
    expect(() => unframeV2(SOLVENCY_PREFIX, CODE_KIND.solvency, CTX, addr.slice('h081-address:'.length))).toThrow(/shielded address code, not a solvency proof code/);
    expect(() => decodeSolvencyRequest(CTX, 'h081-solvency-ask:0OIl')).toThrow(/letters and digits only/);
  });

  it('refuses a request it should never answer', () => {
    expect(() => request({ min: 0n })).toThrow(/min must be a positive/);
    expect(() => request({ label: 'x'.repeat(33) })).toThrow(/at most 32 bytes/);
    expect(() => request({ maxRootAge: 0 })).toThrow(/maxRootAge/);
  });
});

describe('audience, signature and the reserve key', () => {
  it('audience is the first 31 bytes of sha256(domain || digest || wallet), big-endian (fixed vector)', () => {
    const d = new Uint8Array(32).fill(1), w = new Uint8Array(32).fill(2);
    expect(solvencyAudience(d, w).toString(16).padStart(62, '0')).toBe('17147ee3c0887b135c03f9f207fc07ce16a4bcca389d2568ec67dad4c8ed89');
    const indep = createHash('sha256').update(Buffer.concat([Buffer.from('h081-solvency-audience|v1|'), d, w])).digest().subarray(0, 31);
    expect(solvencyAudience(d, w)).toBe(BigInt('0x' + indep.toString('hex')));
    // any changed byte of the request digest or the wallet changes it
    for (let i = 0; i < 32; i += 7) {
      const d2 = d.slice(); d2[i] ^= 1; const w2 = w.slice(); w2[i] ^= 1;
      expect(solvencyAudience(d2, w)).not.toBe(solvencyAudience(d, w));
      expect(solvencyAudience(d, w2)).not.toBe(solvencyAudience(d, w));
    }
  });

  it('the signed message is domain separated and covers the digest and every args byte (fixed vector)', () => {
    const d = new Uint8Array(32).fill(1), a = new Uint8Array(192).fill(3);
    expect(Buffer.from(presentationMessage(d, a)).toString('hex')).toBe('9274a0f216f48ef4535836cc6aebfec0320bdd091c16c46678ae48d18b69c33d');
    const kp = Keypair.generate();
    const sig = ed25519.sign(presentationMessage(d, a), kp.secretKey.subarray(0, 32));
    expect(ed25519.verify(sig, presentationMessage(d, a), kp.publicKey.toBytes())).toBe(true);
    const a2 = a.slice(); a2[191] ^= 1;
    expect(ed25519.verify(sig, presentationMessage(d, a2), kp.publicKey.toBytes())).toBe(false);
    const d2 = d.slice(); d2[0] ^= 1;
    expect(ed25519.verify(sig, presentationMessage(d2, a), kp.publicKey.toBytes())).toBe(false);
    expect(ed25519.verify(sig, presentationMessage(d, a), Keypair.generate().publicKey.toBytes())).toBe(false);
  });

  it('the reserve key is its own: not the account, a sub-account or the lender key', async () => {
    await initCrypto();
    const kp = Keypair.generate();
    const r = deriveReserveSk(kp);
    expect(r).toBe(deriveReserveSk(kp));
    expect(new Set([r, deriveAccountSk(kp), deriveLenderSk(kp), ...Array.from({ length: 16 }, (_, i) => deriveAgentSk(kp, i))]).size).toBe(19);
    expect(deriveReserveSk(kp, 'signature')).not.toBe(r);
  });
});

describe('the ladder and the probing cap', () => {
  it('snaps up when asking and down when proving directly', () => {
    expect(snapUp(1n, 6)).toBe(1n * U);
    expect(snapUp(1n * U, 6)).toBe(1n * U);
    expect(snapUp(1n * U + 1n, 6)).toBe(2_500_000n);
    expect(snapUp(2400n * U, 6)).toBe(2500n * U);
    expect(snapUp(2501n * U, 6)).toBe(5000n * U);
    expect(snapUp(7000n * U, 6)).toBe(10_000n * U);
    expect(snapDown(7000n * U, 6)).toBe(5000n * U);
    expect(snapDown(999_999n, 6)).toBe(0n);
    expect(isOnLadder(25_000n * U, 6)).toBe(true);
    expect(isOnLadder(2600n * U, 6)).toBe(false);
  });

  it('refuses a 5th distinct bound to one verifier per UTC day and a 9th overall; repeats are free', () => {
    const t = Date.UTC(2030, 0, 1, 12);
    const day = Math.floor(t / 86_400_000);
    const log = [1n, 2n, 3n, 4n].map((b) => ({ day, verifier: 'V', bound: (b * U).toString() }));
    expect(probeBlock(log, 'V', 4n * U, t)).toBeUndefined();
    expect(probeBlock(log, 'V', 5n * U, t)).toMatch(/4 different solvency bounds/);
    expect(probeBlock(log, 'W', 5n * U, t)).toBeUndefined();
    expect(probeBlock(log, 'V', 5n * U, t + 86_400_000)).toBeUndefined(); // the next UTC day
    const eight = [...log, ...[5n, 6n, 7n, 8n].map((b) => ({ day, verifier: 'W', bound: (b * U).toString() }))];
    expect(probeBlock(eight, 'X', 9n * U, t)).toMatch(/8 different solvency bounds today across all verifiers/);
    expect(probeBlock(eight, 'X', 1n * U, t)).toBeUndefined();
  });

  it('the bank keeps the log (in memory without a cache dir) and records only on request', () => {
    const host = { config: { cluster: 'mainnet-beta', poolProgramId: POOL }, signer: Keypair.generate(), log: () => {} } as unknown as SolvencyHost;
    const v = new Uint8Array(32).fill(3);
    for (const b of [1n, 2n, 3n, 4n]) checkSolvencyProbe(host, v, b * U, true);
    expect(() => checkSolvencyProbe(host, v, 5n * U, false)).toThrow(/4 different/);
    expect(() => checkSolvencyProbe(host, v, 2n * U, true)).not.toThrow();
  });
});

describe('what a proof says: a note that existed, not one still unspent (disclose has no nullifier)', () => {
  it('the statement never presents root recency as liveness, and doesNotSay says a spent note still proves at the current root', () => {
    const s = solvencyStatement({ bound: '2500', symbol: 'USDG', rootAge: 0, wallet: 'W', assetSound: true });
    expect(s).toMatch(/may since have been spent or reclaimed/);
    expect(s).toMatch(/when the proof was made, not when the note/);
    expect(s).not.toMatch(/as of a pool root/);
    expect(SOLVENCY_DOES_NOT_SAY[0]).toMatch(/still proves against the CURRENT root/);
    expect(SOLVENCY_DOES_NOT_SAY[0]).toMatch(/BEFORE the proof/);
  });
});

describe('root recency and the asset floor', () => {
  it('root age counts back through the ring from the current index', () => {
    const roots = Array.from({ length: 1024 }, () => 0n);
    roots[1020] = 11n; roots[1023] = 12n; roots[2] = 13n;
    expect(rootAge(roots, 2, 13n)).toBe(0);
    expect(rootAge(roots, 2, 12n)).toBe(3);
    expect(rootAge(roots, 2, 11n)).toBe(6);
    expect(rootAge(roots, 2, 99n)).toBeUndefined();
    expect(rootAge(roots, 2, 0n)).toBeUndefined();
  });

  it('is the largest of cap, balance and HISTORICAL peak over non-USDG vaults', () => {
    const usdg = MAINNET.usdg.mint;
    expect(assetFloor([{ mint: usdg, maxTotal: 10n ** 12n, vaultBalance: 5n, peak: 10n ** 13n }], usdg)).toBe(0n);
    expect(assetFloor([{ mint: 'A', maxTotal: 10_000n * U, vaultBalance: 3n, peak: 3n }, { mint: 'B', maxTotal: 0n, vaultBalance: 12_000n * U, peak: 12_000n * U }], usdg)).toBe(12_000n * U);
    // capped at 0 and drained today, but it once held 10,000: a note made then is still a leaf, so it still counts
    expect(assetFloor([{ mint: 'C', maxTotal: 0n, vaultBalance: 0n, peak: 10_000n * U }], usdg)).toBe(10_000n * U);
  });

  it('a vault transaction\'s peak is its balance before plus every inflow (a deposit withdrawn in the same transaction counts)', () => {
    const V = 'Vau1t1111111111111111111111111111111111111';
    const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const tx = (pre: bigint | null, post: bigint, ixs: VaultTx['ixs']): VaultTx => ({
      keys: ['payer', V], pre: pre === null ? [] : [{ accountIndex: 1, amount: pre.toString() }], post: [{ accountIndex: 1, amount: post.toString() }], ixs,
    });
    const tIn = (a: bigint) => ({ programId: SPL, parsed: { type: 'transferChecked', info: { source: 'x', destination: V, tokenAmount: { amount: a.toString() } } } });
    const tOut = (a: bigint) => ({ programId: SPL, parsed: { type: 'transferChecked', info: { source: V, destination: 'x', tokenAmount: { amount: a.toString() } } } });
    expect(vaultTxPeak(V, tx(null, 0n, [{ programId: SPL, parsed: { type: 'initializeAccount3', info: { account: V, mint: 'M', owner: 'A' } } }]))).toEqual({ peak: 0n, createdHere: true });
    expect(vaultTxPeak(V, tx(5n, 12n, [tIn(7n)]))).toEqual({ peak: 12n, createdHere: false });
    // in and out again inside one transaction: the balance after is 5, the peak inside was 5 + 1000
    expect(vaultTxPeak(V, tx(5n, 5n, [tIn(1000n), tOut(1000n)]))).toEqual({ peak: 1005n, createdHere: false });
    expect(vaultTxPeak(V, tx(5n, 5n, [{ programId: SPL, parsed: { type: 'mintTo', info: { account: V, amount: '40' } } }])).peak).toBe(45n);
    // what it cannot read, it refuses (the caller fails closed)
    expect(() => vaultTxPeak(V, tx(5n, 5n, [{ programId: SPL, accounts: ['x', V] }]))).toThrow(/could not be read/);
    expect(() => vaultTxPeak(V, tx(5n, 5n, [{ programId: SPL, parsed: { type: 'confidentialTransfer', info: { destination: V } } }]))).toThrow(/confidentialTransfer/);
    expect(() => vaultTxPeak(V, { keys: ['payer'], pre: [], post: [], ixs: [] })).toThrow(/does not name the vault/);
  });
});

// ------------------------------------------------------------------ the verifier, over a real disclose proof

const prover = new Prover();
const HAVE = existsSync(prover.paths('disclose').zkey) && existsSync(prover.paths('disclose').wasm);
const vkeyHash = HAVE ? createHash('sha256').update(readFileSync(prover.paths('disclose').vkey)).digest('hex') : '';
const CEREMONY = vkeyHash === CIRCUIT_HASHES.disclose.vkey;

/** A complete ["pool"] account with `roots` at the end of the ring and current index `cur`. */
function poolAccount(roots: bigint[], cur: number): Buffer {
  const b = Buffer.alloc(POOL_SIZE);
  Buffer.from(POOL_DISCRIMINATOR).copy(b, 0);
  b.writeUInt32LE(5, 8);
  b.writeUInt32LE(cur, 12);
  const off = 8 + 4 + 4 + 32 * LEVELS;
  roots.forEach((r, i) => { const slot = (((cur - (roots.length - 1 - i)) % 1024) + 1024) % 1024; Buffer.from(r.toString(16).padStart(64, '0'), 'hex').copy(b, off + 32 * slot); });
  return b;
}

function assetCapData(mint: PublicKey, maxTotal: bigint): Buffer {
  const disc = createHash('sha256').update('account:AssetCap').digest().subarray(0, 8);
  const b = Buffer.alloc(57); disc.copy(b, 0); mint.toBuffer().copy(b, 8); b.writeBigUInt64LE(maxTotal, 40); b.writeBigUInt64LE(maxTotal, 48); b[56] = 255;
  return b;
}
function tokenAccount(amount: bigint): Buffer { const b = Buffer.alloc(165); b.writeBigUInt64LE(amount, 64); return b; }

/** One transaction in a vault's history: its balance before (null: the vault did not exist yet), after, and inflows. */
interface HistTx { pre: bigint | null; post: bigint; inflows?: bigint[] }
interface Chain {
  roots: bigint[]; cur: number; caps: Array<{ mint: PublicKey; maxTotal: bigint; balance: bigint; history?: HistTx[] }>; capsFail?: boolean; lamports?: number;
  /** getSignaturesForAddress / getParsedTransactions fail */
  historyFail?: boolean;
}

const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** A jsonParsed transaction touching `vault` (account index 1), as getParsedTransactions returns it. */
function parsedVaultTx(vault: PublicKey, t: HistTx) {
  return {
    slot: 1, blockTime: null,
    transaction: { signatures: ['s'], message: { accountKeys: [{ pubkey: Keypair.generate().publicKey, signer: true, writable: true }, { pubkey: vault, signer: false, writable: true }], instructions: [], recentBlockhash: '' } },
    meta: {
      err: null, fee: 5000, preBalances: [], postBalances: [],
      preTokenBalances: t.pre === null ? [] : [{ accountIndex: 1, mint: 'M', uiTokenAmount: { amount: t.pre.toString(), decimals: 6, uiAmount: null } }],
      postTokenBalances: [{ accountIndex: 1, mint: 'M', uiTokenAmount: { amount: t.post.toString(), decimals: 6, uiAmount: null } }],
      innerInstructions: [{ index: 0, instructions: (t.inflows ?? []).map((a) => ({ program: 'spl-token', programId: new PublicKey(SPL_TOKEN), parsed: { type: 'transferChecked', info: { source: 'x', destination: vault.toBase58(), tokenAmount: { amount: a.toString() } } } })) }],
    },
  };
}

function host(signer: Keypair, chain: Chain, over: Partial<SolvencyHost> = {}): SolvencyHost {
  // each vault's history, oldest first; by default one transaction: the creation, ending at today's balance
  const hist = (vault: PublicKey) => {
    const c = chain.caps.find((x) => vaultPda(POOL, x.mint).equals(vault));
    return c ? (c.history ?? [{ pre: null, post: c.balance }]) : [];
  };
  const connection = {
    getSignaturesForAddress: vi.fn(async (vault: PublicKey, o: { until?: string } = {}) => {
      if (chain.historyFail) throw new Error('history unavailable');
      const sigs = hist(vault).map((_, i) => ({ signature: `${vault.toBase58()}:${i}`, slot: i, err: null, memo: null, blockTime: null })).reverse();
      const stop = o.until ? sigs.findIndex((s) => s.signature === o.until) : -1;
      return stop >= 0 ? sigs.slice(0, stop) : sigs;
    }),
    getParsedTransactions: vi.fn(async (sigs: string[]) => sigs.map((s) => {
      const [v, i] = s.split(':');
      const vault = new PublicKey(v);
      return parsedVaultTx(vault, hist(vault)[Number(i)]);
    })),
    getAccountInfo: vi.fn(async (k: PublicKey) => (k.equals(poolPda(POOL)) ? { data: poolAccount(chain.roots, chain.cur), owner: POOL, lamports: 1, executable: false } : null)),
    getProgramAccounts: vi.fn(async () => {
      if (chain.capsFail) throw new Error('429 Too Many Requests');
      return chain.caps.map((c) => ({ pubkey: PublicKey.default, account: { data: assetCapData(c.mint, c.maxTotal), owner: POOL, lamports: 1, executable: false } }));
    }),
    getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map((k) => {
      const c = chain.caps.find((x) => vaultPda(POOL, x.mint).equals(k));
      return c ? { data: tokenAccount(c.balance), owner: PublicKey.default, lamports: 1, executable: false } : null;
    })),
    getBalance: vi.fn(async () => chain.lamports ?? LAMPORTS_PER_SOL),
  };
  return {
    connection: connection as never, config: { cluster: 'mainnet-beta', poolProgramId: POOL, circuitsUrl: 'https://invalid.example/', decimals: 6 } as never, signer, prover,
    pool: {} as never, owner: {} as never, usdg: USDG, decimals: 6, codeContext: CTX, reserve: {} as never, fetch: (() => { throw new Error('no network in tests'); }) as never,
    log: () => {}, sync: async () => {}, saveCache: () => {}, requireArtifacts: async () => {}, needSol: async () => {}, grantCeiling: () => {}, explain: (e) => e as Error,
    vkeyPin: CEREMONY ? undefined : vkeyHash, ...over,
  };
}

describe.skipIf(!HAVE)('verifySolvency over a real disclose proof', () => {
  const agent = Keypair.generate();
  const asker = Keypair.generate();
  let reserve: Account;
  let allowance: Allowance;
  let root: bigint;
  let proofBytes: Uint8Array;
  let argsOf: (o?: Partial<Record<'kind' | 'bound' | 'windowId' | 'agentPk' | 'audience', bigint>>) => Uint8Array;
  const req = request({ verifierKey: asker.publicKey.toBytes(), expiry: BigInt(NOW + 600) });
  const chainOk = (): Chain => ({ roots: [root], cur: 40, caps: [{ mint: USDG, maxTotal: 10n ** 12n, balance: 3000n * U }] });
  const present = (o: { args?: Uint8Array; proof?: Uint8Array; wallet?: Keypair; signer?: Keypair; digest?: Uint8Array } = {}) => {
    const args = o.args ?? argsOf();
    const digest = o.digest ?? req.digest;
    const signature = ed25519.sign(presentationMessage(digest, args), (o.signer ?? o.wallet ?? agent).secretKey.subarray(0, 32));
    return encodeSolvencyCode(CTX, { requestDigest: digest, proof: o.proof ?? proofBytes, args, wallet: (o.wallet ?? agent).publicKey.toBytes(), signature });
  };

  beforeAll(async () => {
    await initCrypto();
    reserve = new Account(deriveReserveSk(agent));
    const owner = new Account(randomField());
    allowance = {
      asset: fieldOf(USDG), remaining: 3000n * U, agentPk: reserve.keys.pk, windowId: 0n, windowSpent: 0n, rho: randomField(), pledgePaid: 0n,
      policy: { lifetimeCap: 3000n * U, windowCap: 0n, windowLen: 86400n, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: owner.keys.pk, streamRate: 0n, streamStart: 0n, lender: 0n, pledgeBps: 0n },
    };
    const tree = new MerkleTree(LEVELS);
    tree.insert(randomField());
    const i = tree.insert(allowanceCommitment(allowance));
    root = tree.root;
    const audience = solvencyAudience(req.digest, agent.publicKey.toBytes());
    const built = discloseInput({ root, allowance, path: tree.path(i), kind: 'remainingAtLeast', bound: 2500n * U, audience });
    const p = await prover.prove('disclose', built.input);
    expect(await prover.verify('disclose', p)).toBe(true);
    proofBytes = encodeProof(p.proof);
    // the program's encoding decodes back to the same proof
    expect(decodeProofBytes(proofBytes)).toEqual(p.proof);
    argsOf = (o = {}) => encodeDiscloseArgs({ root, kind: 0n, bound: 2500n * U, windowId: 0n, agentPk: reserve.keys.pk, audience, ...o });
  });

  it.skipIf(!CEREMONY)('the build tree is the ceremony\'s disclose (hash-checked against CIRCUIT_HASHES)', () => {
    const p = prover.paths('disclose');
    const h = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
    expect(h(p.zkey)).toBe(CIRCUIT_HASHES.disclose.zkey);
    expect(h(p.vkey)).toBe(CIRCUIT_HASHES.disclose.vkey);
    expect(h(p.wasm)).toBe(CIRCUIT_HASHES.disclose.wasm);
  });

  it('accepts an honest presentation, says what it does not say, and accepts each request once', async () => {
    const h = host(asker, chainOk());
    const r = await verifySolvency(h, present(), { request: req.code, now: NOW });
    expect(r).toMatchObject({ ok: true, wallet: agent.publicKey.toBase58(), bound: 2500n * U, boundUsdg: '2500', rootAge: 0, assetSound: true, assetFloor: 0n });
    expect(r.request).toMatchObject({ label: 'acme-desk', askedByThisWallet: true });
    expect(r.statement).toMatch(/at least 2500 USDG remaining/);
    expect(r.doesNotSay).toEqual(SOLVENCY_DOES_NOT_SAY);
    expect(r.warning).toBeUndefined();
    const again = await verifySolvency(h, present(), { request: req.code, now: NOW });
    expect(again).toMatchObject({ ok: false, reason: 'nonce_reused' });
    expect(again.doesNotSay).toEqual(SOLVENCY_DOES_NOT_SAY);
  });

  it('a failed check does not use up the request\'s nonce', async () => {
    // another verifier (its own seen-nonce store) with the same request
    const v2 = Keypair.generate();
    const h = host(v2, { ...chainOk(), capsFail: true });
    expect(await verifySolvency(h, present(), { request: req.code, now: NOW })).toMatchObject({ ok: false, reason: 'asset_floor_unavailable' });
    h.connection = host(v2, chainOk()).connection;
    const foreign = await verifySolvency(h, present(), { request: req.code, now: NOW });
    expect(foreign).toMatchObject({ ok: true, request: { askedByThisWallet: false } });
    expect(foreign.warning).toMatch(/not made by this wallet/);
    expect(await verifySolvency(h, present(), { request: req.code, now: NOW })).toMatchObject({ ok: false, reason: 'nonce_reused' });
  });

  const fresh = () => host(Keypair.generate(), chainOk());

  it('refuses each failure with its own reason, in the spec\'s order', async () => {
    const v = (code: string, o: Partial<Parameters<typeof verifySolvency>[2]> = {}, h = fresh()) => verifySolvency(h, code, { request: req.code, now: NOW, ...o });
    expect((await v('h081-solvency:abc')).reason).toBe('bad_code');
    expect((await v(present(), { request: 'h081-solvency-ask:abc' })).reason).toBe('bad_request');
    // another request (same asker, other nonce)
    const other = request({ verifierKey: asker.publicKey.toBytes(), nonce: new Uint8Array(16).fill(1) });
    expect((await v(present(), { request: other.code })).reason).toBe('other_request');
    expect((await v(present(), { now: NOW + 601 })).reason).toBe('expired');
    // expectWallet set to someone else
    const pinned = request({ verifierKey: asker.publicKey.toBytes(), expectWallet: Keypair.generate().publicKey.toBytes() });
    expect((await v(present({ digest: pinned.digest }), { request: pinned.code })).reason).toBe('wrong_wallet');
    // public inputs
    expect((await v(present({ args: argsOf({ kind: 1n }) }))).reason).toBe('wrong_kind');
    expect((await v(present({ args: argsOf({ windowId: 3n }) }))).reason).toBe('wrong_window');
    const bigger = request({ verifierKey: asker.publicKey.toBytes(), min: 5000n * U });
    expect((await v(present({ digest: bigger.digest }), { request: bigger.code })).reason).toBe('below_min');
    // another wallet presents the same proof (its audience is the first wallet's)
    expect((await v(present({ wallet: Keypair.generate() }))).reason).toBe('wrong_audience');
    expect((await v(present({ args: argsOf({ agentPk: 0n }) }))).reason).toBe('zero_agent');
    // signed by a key that is not the wallet named
    expect((await v(present({ signer: Keypair.generate() }))).reason).toBe('bad_signature');
    // tampered proof bytes (the signature covers the args, not the proof)
    const bad = proofBytes.slice(); bad[200] ^= 1;
    expect((await v(present({ proof: bad }))).reason).toBe('bad_proof');
    // tampered args, re-signed by the wallet: the proof no longer matches them
    expect((await v(present({ args: argsOf({ bound: 2600n * U }) }))).reason).toBe('bad_proof');
    // a verifying key that is not the pinned one
    expect((await v(present(), {}, host(Keypair.generate(), chainOk(), { vkeyPin: '00'.repeat(32) }))).reason).toBe('vkey_not_pinned');
    // root recency: 33 operations later (maxRootAge 32), and a root the ring no longer holds
    const later = Array.from({ length: 34 }, (_, i) => (i === 0 ? root : BigInt(i + 1000)));
    const stale = await v(present(), {}, host(Keypair.generate(), { ...chainOk(), roots: later, cur: 100 }));
    expect(stale).toMatchObject({ reason: 'stale_root', rootAge: 33 });
    expect((await v(present(), {}, host(Keypair.generate(), { ...chainOk(), roots: [77n] }))).reason).toBe('unknown_root');
    // the asset floor: a junk vault whose cap could back 10,000 units
    const junk = { mint: Keypair.generate().publicKey, maxTotal: 10_000n * U, balance: 0n };
    const unbound = await v(present(), {}, host(Keypair.generate(), { ...chainOk(), caps: [...chainOk().caps, junk] }));
    expect(unbound).toMatchObject({ ok: false, reason: 'asset_not_bound', assetSound: false, assetFloor: 10_000n * U });
    expect(unbound.statement).toMatch(/SOME asset/);
    const allowed = await v(present(), { allowUnboundAsset: true }, host(Keypair.generate(), { ...chainOk(), caps: [...chainOk().caps, junk] }));
    expect(allowed).toMatchObject({ ok: true, assetSound: false });
    // a junk vault capped at 0 that never held more than 2,000 counts by that: a 2,500 claim is sound
    const small = { ...junk, maxTotal: 0n, balance: 2000n * U };
    expect(await v(present(), {}, host(Keypair.generate(), { ...chainOk(), caps: [...chainOk().caps, small] }))).toMatchObject({ ok: true, assetSound: true, assetFloor: 2000n * U });
    // capped at 0 and drained TODAY, but it once held 3,000: a junk note made then is still a leaf and still proves,
    // so the floor is the historical peak, never today's cap and balance
    const drained = { ...junk, maxTotal: 0n, balance: 0n, history: [{ pre: null, post: 0n }, { pre: 0n, post: 3000n * U, inflows: [3000n * U] }, { pre: 3000n * U, post: 0n }] };
    expect(await v(present(), {}, host(Keypair.generate(), { ...chainOk(), caps: [...chainOk().caps, drained] }))).toMatchObject({ ok: false, reason: 'asset_not_bound', assetFloor: 3000n * U });
    // in and out inside ONE transaction: the balances around it show nothing, the inflow does
    const flash = { ...junk, maxTotal: 0n, balance: 0n, history: [{ pre: null, post: 0n }, { pre: 0n, post: 0n, inflows: [2600n * U] }] };
    expect(await v(present(), {}, host(Keypair.generate(), { ...chainOk(), caps: [...chainOk().caps, flash] }))).toMatchObject({ ok: false, reason: 'asset_not_bound', assetFloor: 2600n * U });
    // a history that does not reach the vault's creation (a pruned RPC), or no history at all: fails closed
    const pruned = { ...junk, maxTotal: 0n, balance: 0n, history: [{ pre: 3000n * U, post: 0n }] };
    expect((await v(present(), {}, host(Keypair.generate(), { ...chainOk(), caps: [...chainOk().caps, pruned] }))).reason).toBe('asset_floor_unavailable');
    const none = { ...junk, maxTotal: 0n, balance: 0n, history: [] };
    expect((await v(present(), {}, host(Keypair.generate(), { ...chainOk(), caps: [...chainOk().caps, none] }))).reason).toBe('asset_floor_unavailable');
    expect((await v(present(), {}, host(Keypair.generate(), { ...chainOk(), caps: [...chainOk().caps, small], historyFail: true }))).reason).toBe('asset_floor_unavailable');
    // USDG's own vault history is never read
    const hu = host(Keypair.generate(), chainOk());
    expect(await v(present(), {}, hu)).toMatchObject({ ok: true });
    expect((hu.connection as unknown as { getSignaturesForAddress: { mock: { calls: unknown[] } } }).getSignaturesForAddress.mock.calls).toHaveLength(0);
    // an RPC that refuses getProgramAccounts fails closed
    expect((await v(present(), {}, host(Keypair.generate(), { ...chainOk(), capsFail: true }))).reason).toBe('asset_floor_unavailable');
  });

  it('the simulated on-chain check needs a funded fee payer and never signs', async () => {
    const h = host(Keypair.generate(), { ...chainOk(), lamports: 0 });
    const r = await verifySolvency(h, present(), { request: req.code, now: NOW, onChain: 'simulate', feePayer: Keypair.generate().publicKey.toBase58() });
    expect(r).toMatchObject({ ok: false, reason: 'on_chain_unavailable' });
    expect(r.message).toMatch(/fee payer holding SOL/);
  });
});
