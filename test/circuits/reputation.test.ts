// reputation.circom, witness only: honest claims pass, every dishonest one fails.
import { beforeAll, describe, expect, it } from 'vitest';
import { initCrypto, loanPk, presNullifier, randomField, repLeaf } from '../../src/crypto.js';
import { MerkleTree } from '../../src/merkle.js';
import { NO_REQUIREMENT, REP_LEVELS, REP_SLOTS, reputationInput, type RepLoan, type RepRequirement } from '../../src/reputation.js';
import { Prover } from '../../src/prover.js';

const prover = new Prover();
const ASSET = 0x1111111111111111111111111111111111111111n;
const OTHER_ASSET = 0x2222222222222222222222222222222222222222n;
const L1 = 0xaaaa000000000000000000000000000000000001n;
const L2 = 0xaaaa000000000000000000000000000000000002n;
const L3 = 0xaaaa000000000000000000000000000000000003n;
const USDG = 1_000_000n;
const AUD = 0x1234n;

let A: bigint;
let B: bigint;
let tree: MerkleTree;
let ref = 100n;

/** Appends one attested loan of `master` under loan key k and returns it as the prover sees it. */
function attest(master: bigint, k: number, principal: bigint, lenderF: bigint, fundedDay: bigint, assetF = ASSET): RepLoan {
  const loanRef = ref++;
  const index = tree.insert(repLeaf({ agentPk: loanPk(master, k), loanRef, principal, assetF, lenderF, fundedDay }));
  return { loanRef, principal, assetF, lenderF, fundedDay, keyIndex: k, index };
}

function req(over: Partial<RepRequirement> = {}): RepRequirement {
  return { ...NO_REQUIREMENT, ...over };
}

function input(loans: RepLoan[], r: RepRequirement = req(), master = A) {
  return reputationInput({ masterSk: master, loans, tree, req: r, assetF: ASSET, audience: AUD, nonce: 77n, expiry: 1_900_000_000n, bindTo: 5n }).input as Record<string, any>;
}

const accepts = (i: Record<string, unknown>) => expect(prover.witness('reputation', i as never)).resolves.toBeUndefined();
const rejects = (i: Record<string, unknown>) => expect(prover.witness('reputation', i as never)).rejects.toThrow();
const clone = (i: Record<string, any>) => JSON.parse(JSON.stringify(i, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

let a: RepLoan[]; // A's loans: 3 lenders, days 1000..1400
let bLoan: RepLoan;

beforeAll(async () => {
  await initCrypto();
  A = randomField();
  B = randomField();
  tree = new MerkleTree(REP_LEVELS);
  tree.insert(randomField()); // someone else's leaf first
  a = [
    attest(A, 0, 10n * USDG, L1, 1000n),
    attest(A, 1, 20n * USDG, L2, 1040n),
    attest(A, 2, 5n * USDG, L1, 1100n),
    attest(A, 3, 50n * USDG, L3, 1400n),
  ];
  bLoan = attest(B, 0, 1000n * USDG, L2, 1200n);
  for (let k = 4; k < 4 + REP_SLOTS; k++) a.push(attest(A, k, 1n * USDG, L1, 1500n + BigInt(k)));
});

describe('reputation: honest claims', () => {
  it('one loan', async () => accepts(input([a[0]])));

  it('three loans at exactly the bounds (count, volume, lenders, span, months)', async () => {
    // a[0..2]: days 1000, 1040, 1100 -> periods 33, 34, 36; lenders L1, L2 (2 distinct); volume 35
    const r = req({ minLoans: 3, minVolume: 35n * USDG, minLenders: 2, minSpanDays: 100, minMonths: 3, monthFloor: 5n * USDG });
    await accepts(input(a.slice(0, 3), r));
  });

  it('sixteen loans', async () => accepts(input(a.slice(4, 4 + REP_SLOTS), req({ minLoans: 16, minVolume: 16n * USDG }))));

  it('mixed key indices, not adjacent in the tree', async () => accepts(input([a[0], a[3], a[10]], req({ minLenders: 2 }))));

  it('the presentation nullifier is Poseidon(14, masterSk, audience)', async () => {
    const i = input([a[0]]);
    expect(BigInt(i.presNullifier)).toBe(presNullifier(A, AUD));
    await accepts(i);
  });
});

describe('reputation: dishonest claims', () => {
  it('one over each bound fails', async () => {
    const base = { minLoans: 3, minVolume: 35n * USDG, minLenders: 2, minSpanDays: 100, minMonths: 3, monthFloor: 5n * USDG };
    for (const over of [{ minLoans: 4 }, { minVolume: 35n * USDG + 1n }, { minLenders: 3 }, { minSpanDays: 101 }, { minMonths: 4 }, { monthFloor: 5n * USDG + 1n }]) {
      const i = input(a.slice(0, 3), req(base));
      Object.assign(i, Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])));
      await rejects(i);
    }
  });

  it('the same loan twice', async () => {
    const i = clone(input([a[0], a[1]]));
    for (const k of ['keyIndex', 'loanRef', 'principal', 'lenderF', 'fundedDay', 'pathElements', 'pathIndices']) i[k][1] = i[k][0];
    await rejects(i);
  });

  it('two loans out of order', async () => {
    const i = clone(input([a[0], a[1]]));
    for (const k of ['keyIndex', 'loanRef', 'principal', 'lenderF', 'fundedDay', 'pathElements', 'pathIndices']) [i[k][0], i[k][1]] = [i[k][1], i[k][0]];
    await rejects(i);
  });

  it("another master's loan (B's leaf under A's key, and B's key index under A)", async () => {
    expect(() => input([a[0], bLoan])).toThrow(/not this account's leaf/);
    const i = clone(input([a[0], a[1]]));
    const p = tree.path(bLoan.index);
    i.loanRef[1] = String(bLoan.loanRef); i.principal[1] = String(bLoan.principal); i.lenderF[1] = String(bLoan.lenderF);
    i.fundedDay[1] = String(bLoan.fundedDay); i.keyIndex[1] = '0';
    i.pathElements[1] = p.pathElements.map(String); i.pathIndices[1] = p.pathIndices.map(String);
    await rejects(i);
  });

  it('a leaf not in the tree, or a wrong path', async () => {
    const i = clone(input([a[0]]));
    i.principal[0] = String(a[0].principal + 1n);
    await rejects(i);
    const j = clone(input([a[0]]));
    j.pathElements[0][3] = '1';
    await rejects(j);
  });

  it('an asset mismatch', async () => {
    const other = attest(A, 40, 9n * USDG, L1, 1000n, OTHER_ASSET);
    const i = clone(input([a[0]]));
    const p = tree.path(other.index);
    i.loanRef[0] = String(other.loanRef); i.principal[0] = String(other.principal); i.keyIndex[0] = '40';
    i.pathElements[0] = p.pathElements.map(String); i.pathIndices[0] = p.pathIndices.map(String); i.repRoot = String(tree.root);
    await rejects(i);
    i.asset = String(OTHER_ASSET);
    i.presNullifier = String(presNullifier(A, AUD));
    await accepts(i); // same loan, honest asset: fine
  });

  it('a span selector on a disabled slot', async () => {
    const i = clone(input([a[0], a[1]], req({ minSpanDays: 40 })));
    i.selHi = i.selHi.map(() => '0'); i.selHi[5] = '1';
    await rejects(i);
    const j = clone(input([a[0], a[1]], req({ minSpanDays: 40 })));
    j.selLo[1] = '1'; // two selectors
    await rejects(j);
  });

  it('an enabled gap (1, 0, 1)', async () => {
    const i = clone(input([a[0], a[1]]));
    for (const k of ['keyIndex', 'loanRef', 'principal', 'lenderF', 'fundedDay', 'pathElements', 'pathIndices', 'enabled', 'selLo', 'selHi']) [i[k][1], i[k][2]] = [i[k][2], i[k][1]];
    await rejects(i);
  });

  it('padding cannot add lenders or periods: zero-leaf padding between enabled slots with different lenders fails', async () => {
    // a disabled slot carrying a fake lender and day between two enabled ones
    const i = clone(input([a[0], a[1]], req({ minLenders: 2 })));
    for (const k of ['keyIndex', 'loanRef', 'principal', 'lenderF', 'fundedDay', 'pathElements', 'pathIndices', 'enabled', 'selLo', 'selHi']) [i[k][1], i[k][2]] = [i[k][2], i[k][1]];
    i.lenderF[1] = String(L3);
    await rejects(i);
    // trailing padding with a fake lender and a big principal adds nothing
    const j = clone(input([a[0]], req({ minLenders: 2 })));
    j.lenderF[1] = String(L2); j.principal[1] = String(100n * USDG);
    await rejects(j);
    const k2 = clone(input([a[0]], req({ minVolume: 11n * USDG })));
    k2.principal[3] = String(100n * USDG);
    await rejects(k2);
  });

  it('zero enabled slots', async () => {
    const i = clone(input([a[0]], req({ minLoans: 0 })));
    i.enabled[0] = '0';
    await rejects(i);
  });

  it('a wrong presentation nullifier, or one for another audience', async () => {
    const i = clone(input([a[0]]));
    i.presNullifier = String(presNullifier(A, AUD + 1n));
    await rejects(i);
    i.presNullifier = String(presNullifier(B, AUD));
    await rejects(i);
  });

  it('out-of-range values (principal 2^64, key index 2^32, lender 2^160, thresholds and expiry)', async () => {
    for (const [k, v] of [['principal', 1n << 64n], ['keyIndex', 1n << 32n], ['lenderF', 1n << 160n], ['fundedDay', 1n << 32n]] as const) {
      const i = clone(input([a[0]]));
      i[k][0] = String(v);
      await rejects(i);
    }
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    for (const [k, v] of [['minVolume', P - 1n], ['minVolume', 1n << 64n], ['minLoans', 256n], ['minLenders', P - 1n], ['minSpanDays', 1n << 16n], ['minMonths', 256n], ['monthFloor', 1n << 64n], ['expiry', 1n << 64n], ['expiry', P - 1n]] as const) {
      const i = clone(input([a[0]]));
      i[k] = String(v);
      await rejects(i);
    }
  });

  it('masterSk = 0', async () => {
    expect(() => input([a[0]], req(), 0n)).toThrow();
    const i = clone(input([a[0]]));
    i.masterSk = '0';
    await rejects(i);
  });
});
