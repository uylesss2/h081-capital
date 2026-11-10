import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import {
  ADDRESS_PREFIX, CODE_KIND, CodeError, PROOF_PREFIX, TERMS_PREFIX, contextTag, decodeAddressCode, decodeCode, decodeProofCode, decodeTerms, encodeAddressCode, encodeCode,
  decodeLoanProof, decodeLoanTerms, encodeLoanProof, encodeLoanTerms, encodeProofCode, encodeTerms, frameV2, tag, untag,
} from '../../integrations/core/codes.js';
import { slotPda } from '../../src/solana/lender.js';
import { MAINNET } from '../../integrations/core/constants.js';

// The site's encoder (stipend-site/src/lib/live/bank.ts), verbatim, to prove the Node one is byte-identical.
const siteHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function siteTag(v: any): any {
  if (typeof v === 'bigint') return { $b: v.toString() };
  if (v instanceof Uint8Array) return { $u: siteHex(v) };
  if (v && typeof v.toBase58 === 'function' && typeof v.toBytes === 'function') return { $k: v.toBase58() };
  if (Array.isArray(v)) return v.map(siteTag);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, siteTag(x)]));
  return v;
}
const siteB64u = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const siteEncode = (prefix: string, obj: unknown) => prefix + siteB64u(JSON.stringify(siteTag(obj)));

const slot = new PublicKey('5MMWdQWZB3JWTCZXZsEGSLWegi9bk9iSitT9avdLo4Kt');
const terms = {
  v: 1, cluster: 'mainnet-beta', program: MAINNET.programs.loan, mint: MAINNET.usdg.mint,
  lender: slot, loanRef: 3n, pledgeBps: 4000n, lenderViewPub: Uint8Array.from({ length: 32 }, (_, i) => i * 7 % 256),
};

describe('loan hand-over codes', () => {
  it('encodes exactly as the site does (fixed vector) and round-trips', () => {
    const code = encodeTerms(terms);
    expect(code).toBe(siteEncode(TERMS_PREFIX, terms));
    expect(code.startsWith('h081-loan-terms:')).toBe(true);
    const back = decodeTerms(code);
    expect(back.lender.equals(slot)).toBe(true);
    expect(back.loanRef).toBe(3n);
    expect(back.pledgeBps).toBe(4000n);
    expect(back.lenderViewPub).toEqual(terms.lenderViewPub);
    expect(back.program).toBe(MAINNET.programs.loan);
  });

  it('proof codes carry the proof, the args (keys and bigints) and the payout', () => {
    const proof = { a: [1n, 2n] as [bigint, bigint], b: [[3n, 4n], [5n, 6n]] as [[bigint, bigint], [bigint, bigint]], c: [7n, 8n] as [bigint, bigint] };
    const args = {
      root: 9n, minRemaining: 100_000_000n, minRate: 39n, lender: slot, loanRef: 3n, pledgeBps: 4000, expiry: 1_800_000_000n, lifetimeCap: 100_000_000n,
      pledgePaid: 0n, agentPk: 11n, audience: 12n, streamStart: 1_799_000_000n, asset: new PublicKey(MAINNET.usdg.mint),
    };
    const payout = new PublicKey('DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo');
    const code = encodeProofCode({ v: 1, cluster: 'mainnet-beta', program: MAINNET.programs.loan, ref: 3n, payout, proof, args });
    expect(code).toBe(siteEncode(PROOF_PREFIX, { v: 1, cluster: 'mainnet-beta', program: MAINNET.programs.loan, ref: 3n, payout, proof, args }));
    const p = decodeProofCode(code);
    expect(p.ref).toBe(3n);
    expect(p.payout.equals(payout)).toBe(true);
    expect(p.proof).toEqual(proof);
    expect(p.args.lender.equals(slot)).toBe(true);
    expect(p.args.pledgeBps).toBe(4000);
    expect(p.args.minRemaining).toBe(100_000_000n);
  });

  it('refuses the wrong prefix, damaged text and incomplete codes', () => {
    expect(() => decodeTerms('h081-loan-proof:abc')).toThrow(/not a loan terms code/);
    expect(() => decodeCode(TERMS_PREFIX, 'h081-loan-terms:%%%', 'loan terms code')).toThrow(/damaged/);
    expect(() => decodeTerms(encodeCode(TERMS_PREFIX, { v: 1 }))).toThrow(/incomplete/);
    expect(() => decodeProofCode(encodeCode(PROOF_PREFIX, { v: 1, ref: 1n }))).toThrow(/incomplete/);
    expect(untag(tag({ a: [1n, new Uint8Array([1, 2])], k: slot }))).toEqual({ a: [1n, new Uint8Array([1, 2])], k: slot });
  });
});

describe('shielded address codes (v2 frame, kind 5)', () => {
  const ctx = { cluster: 'mainnet-beta', program: MAINNET.programs.pool, mint: MAINNET.usdg.mint };
  const addr = { pk: 0x1234_5678_9abc_def0_1122_3344_5566_7788n, viewPub: Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) % 256) };

  it('is letters and digits after the prefix, carries kind 5 and the network tag, and round-trips', () => {
    const code = encodeAddressCode(ctx, addr);
    expect(code.startsWith(ADDRESS_PREFIX)).toBe(true);
    const payload = code.slice(ADDRESS_PREFIX.length);
    expect(payload).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    const all = bs58.decode(payload);
    expect(all.length).toBe(6 + 64 + 4);
    expect([all[0], all[1]]).toEqual([2, CODE_KIND.address]);
    // the site's network tag: sha256("h081-handover|cluster|program|mint")[0..4]
    expect(Array.from(all.slice(2, 6))).toEqual(Array.from(sha256(new TextEncoder().encode(`h081-handover|${ctx.cluster}|${ctx.program}|${ctx.mint}`)).slice(0, 4)));
    expect(Array.from(contextTag(ctx))).toEqual(Array.from(all.slice(2, 6)));
    const back = decodeAddressCode(ctx, code);
    expect(back.pk).toBe(addr.pk);
    expect(back.viewPub).toEqual(addr.viewPub);
  });

  it('survives what chat apps do: line breaks, spaces, quotes, invisible characters, a lost prefix', () => {
    const code = encodeAddressCode(ctx, addr);
    const mid = Math.floor(code.length / 2);
    for (const pasted of [
      `"${code}"`, `\`${code}\`.`, `${code.slice(0, mid)}\n${code.slice(mid)}`, `  ${code.slice(0, 20)} ${code.slice(20)}  `,
      `${code.slice(0, mid)}​${code.slice(mid)}`, code.slice(ADDRESS_PREFIX.length),
    ]) expect(decodeAddressCode(ctx, pasted).pk).toBe(addr.pk);
  });

  it('refuses a changed or cut code, another network, another kind, and an empty paste, each with its own message', () => {
    const code = encodeAddressCode(ctx, addr);
    const flip = code.slice(0, -3) + (code.at(-3) === 'a' ? 'b' : 'a') + code.slice(-2);
    expect(() => decodeAddressCode(ctx, flip)).toThrow(/does not pass its built-in check/);
    expect(() => decodeAddressCode(ctx, code.slice(0, -10))).toThrow(/built-in check/);
    expect(() => decodeAddressCode(ctx, ADDRESS_PREFIX + 'abc')).toThrow(/far too short/);
    expect(() => decodeAddressCode(ctx, code + '0OIl')).toThrow(/letters and digits only/);
    expect(() => decodeAddressCode({ ...ctx, cluster: 'devnet' }, code)).toThrow(/another network, program or asset than this bank \(devnet\)/);
    expect(() => decodeAddressCode({ ...ctx, program: MAINNET.programs.loan }, code)).toThrow(/another network/);
    // a loan terms frame (kind 1) under the address prefix
    const terms = frameV2(ADDRESS_PREFIX, CODE_KIND.terms, ctx, new Uint8Array(42));
    expect(() => decodeAddressCode(ctx, terms)).toThrow(/is a loan terms code, not a shielded address code/);
    expect(() => decodeAddressCode(ctx, 'h081-loan-terms:abc')).toThrow(/"h081-loan-terms:" code, not a shielded address code/);
    expect(() => decodeAddressCode(ctx, '  ')).toThrow(CodeError);
    expect(() => decodeAddressCode(ctx, frameV2(ADDRESS_PREFIX, CODE_KIND.address, ctx, new Uint8Array(64)))).toThrow(/not hold a valid address/);
    expect(() => encodeAddressCode(ctx, { pk: 0n, viewPub: addr.viewPub })).toThrow(/field element/);
    expect(() => encodeAddressCode(ctx, { pk: 1n, viewPub: new Uint8Array(31) })).toThrow(/32 bytes/);
  });
});

describe('loan codes in the v2 frame (kinds 1 and 2, the loan program network tag)', () => {
  const ctx = { cluster: 'mainnet-beta', program: MAINNET.programs.loan, mint: MAINNET.usdg.mint };
  const viewPub = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) % 256);
  const proof = { a: [1n, 2n] as [bigint, bigint], b: [[3n, 4n], [5n, 6n]] as [[bigint, bigint], [bigint, bigint]], c: [7n, 8n] as [bigint, bigint] };
  const args = {
    root: 9n, minRemaining: 100_000_000n, minRate: 39n, lender: slot, loanRef: 3n, pledgeBps: 4000, expiry: 1_800_000_000n, lifetimeCap: 100_000_000n,
    pledgePaid: 0n, agentPk: 11n, audience: 12n, streamStart: 1_799_000_000n, asset: new PublicKey(MAINNET.usdg.mint),
  };
  const payout = new PublicKey('DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo');

  /** The site's terms frame, written out independently: 2 | 1 | tag | loanRef u64 LE | bps u16 LE | viewPub | sha256[0..4]. */
  function siteTermsV2(loanRef: bigint, bps: number): string {
    const body = new Uint8Array(42);
    for (let i = 0; i < 8; i++) body[i] = Number((loanRef >> BigInt(8 * i)) & 0xffn);
    body[8] = bps & 0xff; body[9] = bps >> 8; body.set(viewPub, 10);
    const head = [2, 1, ...sha256(new TextEncoder().encode(`h081-handover|${ctx.cluster}|${ctx.program}|${ctx.mint}`)).slice(0, 4)];
    const unsummed = Uint8Array.from([...head, ...body]);
    return 'h081-loan-terms:' + bs58.encode(Uint8Array.from([...unsummed, ...sha256(unsummed).slice(0, 4)]));
  }

  it('terms are byte-for-byte the site\'s (about 71 letters and digits) and round-trip; the proof code carries proof, args and payout', () => {
    const code = encodeLoanTerms(ctx, { loanRef: 3n, pledgeBps: 4000n, lenderViewPub: viewPub });
    expect(code).toBe(siteTermsV2(3n, 4000));
    expect(code.slice(TERMS_PREFIX.length)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{60,80}$/);
    expect(decodeLoanTerms(ctx, code)).toEqual({ loanRef: 3n, pledgeBps: 4000n, lenderViewPub: viewPub });
    expect(decodeLoanTerms(ctx, `"${code.slice(0, 30)}\n${code.slice(30)}".`).loanRef).toBe(3n);
    const p = encodeLoanProof(ctx, { ref: 3n, payout, proof, args });
    expect(p.slice(PROOF_PREFIX.length)).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    const back = decodeLoanProof(ctx, p);
    expect(back.ref).toBe(3n);
    expect(back.payout.equals(payout)).toBe(true);
    expect(back.proof).toEqual(proof);
    expect(back.args.lender.equals(slot)).toBe(true);
    expect(back.args.minRemaining).toBe(100_000_000n);
  });

  it('old (v1) codes still decode when they name this network; v1 for another network or a foreign lender is refused', () => {
    const v1 = encodeTerms({ ...terms, lender: slotPda(3n, new PublicKey(MAINNET.programs.loan)) });
    expect(decodeLoanTerms(ctx, v1)).toMatchObject({ loanRef: 3n, pledgeBps: 4000n });
    expect(() => decodeLoanTerms(ctx, encodeTerms({ ...terms, lender: slotPda(3n, new PublicKey(MAINNET.programs.loan)), cluster: 'devnet' }))).toThrow(/another network, loan program or asset/);
    expect(() => decodeLoanTerms(ctx, encodeTerms(terms))).toThrow(/not the loan slot/);
    const v1p = encodeProofCode({ v: 1, cluster: 'mainnet-beta', program: MAINNET.programs.loan, ref: 3n, payout, proof, args });
    expect(decodeLoanProof(ctx, v1p).ref).toBe(3n);
    // as the site: a v1 terms code must name this asset (no mint is refused), and only version 1 is read
    const slotTerms = { ...terms, lender: slotPda(3n, new PublicKey(MAINNET.programs.loan)) };
    const { mint: _mint, ...noMint } = slotTerms;
    expect(() => decodeLoanTerms(ctx, encodeCode(TERMS_PREFIX, noMint))).toThrow(/another network, loan program or asset/);
    expect(() => decodeLoanTerms(ctx, encodeTerms({ ...slotTerms, mint: MAINNET.h081.mint }))).toThrow(/another network, loan program or asset/);
    expect(() => decodeLoanTerms(ctx, encodeTerms({ ...slotTerms, v: 7 }))).toThrow(/not in a format this bank reads/);
    expect(() => decodeLoanProof(ctx, encodeProofCode({ v: 3, cluster: 'mainnet-beta', program: MAINNET.programs.loan, ref: 3n, payout, proof, args }))).toThrow(/not in a format this bank reads/);
  });

  it('refuses a share outside 1%..90%, a code of the other kind, another network, a cut code, and a proof missing parts', () => {
    expect(() => encodeLoanTerms(ctx, { loanRef: 3n, pledgeBps: 99n, lenderViewPub: viewPub })).toThrow(/100\.\.9000/);
    expect(() => decodeLoanTerms(ctx, frameV2(TERMS_PREFIX, CODE_KIND.terms, ctx, (() => { const b = new Uint8Array(42); b[8] = 50; return b; })()))).toThrow(/outside 1% to 90%/);
    const code = encodeLoanTerms(ctx, { loanRef: 3n, pledgeBps: 4000n, lenderViewPub: viewPub });
    const p = encodeLoanProof(ctx, { ref: 3n, payout, proof, args });
    expect(() => decodeLoanProof(ctx, code)).toThrow(/"h081-loan-terms:" code, not a borrower proof code/);
    expect(() => decodeLoanTerms(ctx, p)).toThrow(/"h081-loan-proof:" code, not a loan terms code/);
    expect(() => decodeLoanTerms({ ...ctx, program: MAINNET.programs.pool }, code)).toThrow(/another network, program or asset/);
    expect(() => decodeLoanTerms(ctx, code.slice(0, -5))).toThrow(/does not pass its built-in check/);
    expect(() => decodeLoanProof(ctx, frameV2(PROOF_PREFIX, CODE_KIND.proof, ctx, new TextEncoder().encode(JSON.stringify(tag({ ref: 3n, payout })))))).toThrow(/missing parts/);
    expect(() => decodeLoanTerms(ctx, '')).toThrow(CodeError);
  });
});
