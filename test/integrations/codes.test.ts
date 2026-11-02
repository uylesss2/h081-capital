import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PROOF_PREFIX, TERMS_PREFIX, decodeCode, decodeProofCode, decodeTerms, encodeCode, encodeProofCode, encodeTerms, tag, untag } from '../../integrations/core/codes.js';
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
