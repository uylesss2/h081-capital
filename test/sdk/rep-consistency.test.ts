// rep_registry and its SDK must agree: program ids, the stream_loan id it trusts, the error table, account sizes,
// the public-input order, and the scripts that load it. Reads source files only (no validator, no build).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPUTATION_PUBLIC } from '../../src/reputation.js';
import { LOCALNET_LOAN_PROGRAM_ID, MAINNET_LOAN_PROGRAM_ID } from '../../src/solana/lender.js';
import { LOCALNET_REP_PROGRAM_ID, REP_ERROR, REP_TREE_SIZE } from '../../src/solana/reputation.js';
import { LOCALNET_UPGRADE_AUTHORITY } from '../solana/config-authority.js';

const lib = readFileSync('solana/programs/rep_registry/src/lib.rs', 'utf8');
const view = readFileSync('solana/programs/rep_registry/src/view.rs', 'utf8');

describe('rep_registry <-> SDK', () => {
  it('program ids', () => {
    expect(/declare_id!\("(\w+)"\)/.exec(lib)![1]).toBe(LOCALNET_REP_PROGRAM_ID.toBase58());
    expect(/LOCALNET_STREAM_LOAN_ID: Pubkey = pubkey!\("(\w+)"\)/.exec(view)![1]).toBe(LOCALNET_LOAN_PROGRAM_ID.toBase58());
    expect(/MAINNET_STREAM_LOAN_ID: Pubkey = pubkey!\("(\w+)"\)/.exec(view)![1]).toBe(MAINNET_LOAN_PROGRAM_ID.toBase58());
    expect(readFileSync('solana/scripts/rep-start-validator.sh', 'utf8')).toContain(`UPGRADE_AUTHORITY=${LOCALNET_UPGRADE_AUTHORITY.publicKey.toBase58()}`);
  });

  it('the error table follows the Rust enum order', () => {
    const body = /pub enum RepError \{([\s\S]*?)\n\}/.exec(lib)![1];
    const names = [...body.matchAll(/^\s+(\w+),$/gm)].map((m) => m[1]);
    expect(names).toEqual(Object.keys(REP_ERROR));
    names.forEach((n, i) => expect(REP_ERROR[n as keyof typeof REP_ERROR]).toBe(6000 + i));
  });

  it('account size and public inputs', () => {
    expect(REP_TREE_SIZE).toBe(8856);
    expect(lib).toContain('pub const NPUBLIC: usize = 13;');
    const order = /pub mod input \{([\s\S]*?)\n\}/.exec(lib)![1];
    const idx = [...order.matchAll(/pub const (\w+): usize = (\d+);/g)].map((m) => [m[1], Number(m[2])] as const);
    const camel = (s: string) => s.toLowerCase().replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
    for (const [name, i] of idx) expect(REPUTATION_PUBLIC[i]).toBe(camel(name));
    expect(idx).toHaveLength(REPUTATION_PUBLIC.length);
    const circom = readFileSync('circuits/main/reputation.circom', 'utf8');
    const pub = /public \[([^\]]+)\]/.exec(circom)![1].split(',').map((s) => s.trim());
    expect(pub).toEqual([...REPUTATION_PUBLIC]);
  });
});
