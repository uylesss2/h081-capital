// Cross-program consistency (no validator): the four programs were built in parallel and talk to each other
// through hard-coded program ids, PDA seeds, mirrored borsh layouts and error tables. This pins them to the
// Rust sources and to each SDK module so they cannot drift apart silently.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { BUFFER_HEADER, LOCALNET_POOL_PROGRAM_ID, LOCALNET_PROBE_PROGRAM_ID, POOL_ERROR, POOL_INIT_LEN, POOL_SIZE, ROOT_HISTORY, escrowPda, fieldOf, initializePoolIxs } from '../../src/solana/index.js';
import { LOCALNET_UPGRADE_AUTHORITY } from './config-authority.js';
import { GRACE, LOAN_ERROR, LOCALNET_LOAN_PROGRAM_ID, decodeLedger, decodeSlot, ledgerPda, slotEscrow, slotInbox, slotPda } from '../../src/solana/lender.js';
import {
  CAPACITY_ERROR, CLASSIC_TOKEN_PROGRAM_ID, LOCALNET_CAPACITY_STAKE_FAST_PROGRAM_ID, LOCALNET_CAPACITY_STAKE_PROGRAM_ID, LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID,
  LOCALNET_SAFETY_POOL_PROGRAM_ID, SAFETY_ERROR, SAFETY_POOL_ESCROW_PROGRAM_ID, SAFETY_STREAM_LOAN_PROGRAM_ID, SAFETY_VIRTUAL_ASSETS, SAFETY_VIRTUAL_SHARES,
  STREAM_GRACE, ataAddress, encodeStreamLedger, encodeStreamSlot, streamEscrowPda, streamLedgerPda, streamSlotPda,
} from '../../src/solana/token.js';

const SOL = resolve(import.meta.dirname, '..', '..', 'solana');
const src = (p: string) => readFileSync(resolve(SOL, 'programs', p), 'utf8');

/** declare_id! values of a lib.rs: [default, feature build]. */
const declared = (lib: string) => [...src(lib).matchAll(/declare_id!\("(\w+)"\)/g)].map((m) => m[1]);
const constPubkey = (file: string, name: string) => {
  const m = new RegExp(`pub const ${name}: Pubkey = pubkey!\\("(\\w+)"\\)`).exec(src(file));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return m[1];
};
/** Variant names of a Rust enum, in order. */
function variants(file: string, name: string): string[] {
  const body = new RegExp(`pub enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src(file))?.[1];
  if (!body) throw new Error(`enum ${name} not found in ${file}`);
  return body.split('\n').map((l) => l.trim()).filter((l) => /^[A-Z]\w*,$/.test(l)).map((l) => l.slice(0, -1));
}
/** `name: type` pairs of a Rust struct, types normalized (Fe = [u8; 32]). */
function fields(file: string, name: string): string[] {
  const body = new RegExp(`pub struct ${name}(?:<[^>]*>)? \\{([\\s\\S]*?)\\n\\}`).exec(src(file))?.[1];
  if (!body) throw new Error(`struct ${name} not found in ${file}`);
  return [...body.matchAll(/pub (\w+): ([^,\n]+),/g)].map((m) => `${m[1]}: ${m[2].replace(/\bFe\b/, '[u8; 32]').replace(/\s+/g, ' ')}`);
}
const table = (names: string[]) => Object.fromEntries(names.map((n, i) => [n, 6000 + i]));

describe('program ids', () => {
  it('declare_id!, the cross-program constants and every SDK module agree', () => {
    expect(declared('stipend_pool/src/lib.rs')).toEqual([LOCALNET_POOL_PROGRAM_ID.toBase58(), LOCALNET_PROBE_PROGRAM_ID.toBase58()]);
    expect(declared('stream_loan/src/lib.rs')).toEqual([LOCALNET_LOAN_PROGRAM_ID.toBase58()]);
    expect(declared('capacity_stake/src/lib.rs')).toEqual([LOCALNET_CAPACITY_STAKE_PROGRAM_ID.toBase58(), LOCALNET_CAPACITY_STAKE_FAST_PROGRAM_ID.toBase58()]);
    expect(declared('safety_pool/src/lib.rs')).toEqual([LOCALNET_SAFETY_POOL_PROGRAM_ID.toBase58(), LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID.toBase58()]);
    // stream_loan reaches the pool; safety_pool reads stream_loan and the pool's escrows
    expect(constPubkey('stream_loan/src/pool.rs', 'POOL_PROGRAM_ID')).toBe(LOCALNET_POOL_PROGRAM_ID.toBase58());
    expect(constPubkey('safety_pool/src/stream_loan_view.rs', 'STREAM_LOAN_ID')).toBe(LOCALNET_LOAN_PROGRAM_ID.toBase58());
    expect(constPubkey('safety_pool/src/stream_loan_view.rs', 'POOL_PROGRAM_ID')).toBe(LOCALNET_POOL_PROGRAM_ID.toBase58());
    expect(SAFETY_STREAM_LOAN_PROGRAM_ID.equals(LOCALNET_LOAN_PROGRAM_ID)).toBe(true);
    expect(SAFETY_POOL_ESCROW_PROGRAM_ID.equals(LOCALNET_POOL_PROGRAM_ID)).toBe(true);
    for (const f of ['stipend_pool/src/tokens.rs', 'stream_loan/src/token.rs', 'safety_pool/src/stream_loan_view.rs']) {
      expect(constPubkey(f, 'ATA_PROGRAM_ID')).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    }
  });

  it('the localnet keypairs in solana/keys (when present) are the declared ids', () => {
    const ids: Record<string, PublicKey> = {
      stipend_pool: LOCALNET_POOL_PROGRAM_ID, stipend_pool_probe: LOCALNET_PROBE_PROGRAM_ID, stream_loan: LOCALNET_LOAN_PROGRAM_ID,
      capacity_stake: LOCALNET_CAPACITY_STAKE_PROGRAM_ID, capacity_stake_fast: LOCALNET_CAPACITY_STAKE_FAST_PROGRAM_ID,
      safety_pool: LOCALNET_SAFETY_POOL_PROGRAM_ID, safety_pool_fast: LOCALNET_SAFETY_POOL_FAST_PROGRAM_ID,
    };
    let seen = 0;
    for (const [name, id] of Object.entries(ids)) {
      const f = resolve(SOL, 'keys', `${name}-keypair.json`);
      if (!existsSync(f)) continue;
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, 'utf8'))));
      expect(kp.publicKey.toBase58(), name).toBe(id.toBase58());
      seen++;
    }
    if (process.env.SOLANA_REQUIRED) expect(seen).toBe(Object.keys(ids).length);
  });
});

describe('PDAs and seeds', () => {
  it('lender.ts, token.ts and pda.ts derive the same slot, ledger, inbox and escrow addresses', () => {
    const mint = Keypair.generate().publicKey;
    for (const ref of [1n, 7n, 1013n, 2n ** 40n]) {
      const slot = slotPda(ref);
      expect(streamSlotPda(ref).equals(slot)).toBe(true);
      expect(streamLedgerPda(ref, mint).equals(ledgerPda(ref, mint))).toBe(true);
      expect(ataAddress(slot, mint, CLASSIC_TOKEN_PROGRAM_ID).equals(slotInbox(ref, mint))).toBe(true);
      const escrow = escrowPda(LOCALNET_POOL_PROGRAM_ID, mint, fieldOf(slot), ref);
      expect(slotEscrow(ref, mint).equals(escrow)).toBe(true);
      expect(streamEscrowPda(ref, mint).equals(escrow)).toBe(true);
    }
  });

  it('the seed strings match the Rust constants', () => {
    expect(src('stipend_pool/src/state.rs')).toContain('pub const ESCROW_SEED: &[u8] = b"owed";');
    expect(src('stream_loan/src/pool.rs')).toContain('pub const ESCROW_SEED: &[u8] = b"owed";');
    expect(src('safety_pool/src/stream_loan_view.rs')).toContain('pub const ESCROW_SEED: &[u8] = b"owed";');
    expect(src('stream_loan/src/state.rs')).toContain('pub const SLOT_SEED: &[u8] = b"slot";');
    expect(src('safety_pool/src/stream_loan_view.rs')).toContain('pub const SLOT_SEED: &[u8] = b"slot";');
    expect(src('stream_loan/src/state.rs')).toContain('pub const LEDGER_SEED: &[u8] = b"ledger";');
    expect(src('safety_pool/src/stream_loan_view.rs')).toContain('pub const LEDGER_SEED: &[u8] = b"ledger";');
  });
});

describe('mirrored layouts', () => {
  it('safety_pool mirrors stream_loan Slot and Ledger field for field', () => {
    expect(fields('safety_pool/src/stream_loan_view.rs', 'StreamSlot')).toEqual(fields('stream_loan/src/state.rs', 'Slot'));
    expect(fields('safety_pool/src/stream_loan_view.rs', 'StreamLedger')).toEqual(fields('stream_loan/src/state.rs', 'Ledger'));
  });

  it('stream_loan mirrors the pool SpendArgs and StreamArgs field for field', () => {
    expect(fields('stream_loan/src/pool.rs', 'SpendArgs')).toEqual(fields('stipend_pool/src/ops.rs', 'SpendArgs'));
    expect(fields('stream_loan/src/pool.rs', 'StreamArgs')).toEqual(fields('stipend_pool/src/lib.rs', 'StreamArgs'));
  });

  it('token.ts encodes a Slot and Ledger that lender.ts decodes', () => {
    const s = {
      loanRef: 42n, lender: Keypair.generate().publicKey, bump: 254, funded: true, settled: false, asset: Keypair.generate().publicKey,
      tokenProgram: CLASSIC_TOKEN_PROGRAM_ID, principal: 5n, repaid: 3n, minRemaining: 2n ** 100n, minRate: 9n, pledgeBps: 2500, expiry: 77n,
      agentPk: new Uint8Array(32).fill(3), fundedAt: -5n, payoutTo: Keypair.generate().publicKey, streamStart: 11n,
    };
    const d = decodeSlot(encodeStreamSlot(s));
    expect(d.loanRef).toBe(42n);
    expect(d.lender.equals(s.lender)).toBe(true);
    expect([d.bump, d.funded, d.settled, d.principal, d.repaid, d.minRemaining, d.minRate, d.pledgeBps, d.expiry, d.fundedAt, d.streamStart])
      .toEqual([254, true, false, 5n, 3n, 2n ** 100n, 9n, 2500n, 77n, -5n, 11n]);
    expect(d.agentPk).toBe(BigInt('0x' + '03'.repeat(32)));
    expect(d.payoutTo.equals(s.payoutTo)).toBe(true);
    const l = decodeLedger(encodeStreamLedger({ loanRef: 9n, mint: s.asset, held: 4n, received: 6n, bump: 1 }));
    expect([l.loanRef, l.held, l.received]).toEqual([9n, 4n, 6n]);
    expect(l.mint.equals(s.asset)).toBe(true);
  });

  it('the Buffer header and the root history match the program', () => {
    expect(BUFFER_HEADER).toBe(8 + 32 + 8 + 4 + 1);
    expect(src('stream_loan/src/pool.rs')).toContain('pub const BUFFER_HEADER: usize = 8 + 32 + 8 + 4 + 1;');
    expect(src('stipend_pool/src/state.rs')).toContain(`pub const ROOT_HISTORY: usize = ${ROOT_HISTORY};`);
    // one root per operation, 1024 kept (the EVM reference keeps 128, one per leaf)
    expect(ROOT_HISTORY).toBe(1024);
    expect(POOL_SIZE).toBe(8 + 4 + 4 + 32 * 20 + 32 * 1024);
    expect(POOL_SIZE).toBe(33_424);
    expect(POOL_INIT_LEN).toBe(10_240);
  });

  it('initialize + grow_pool are one transaction that fits the 1232-byte packet', () => {
    const auth = LOCALNET_UPGRADE_AUTHORITY.publicKey;
    const tx = new Transaction({ feePayer: auth, recentBlockhash: PublicKey.default.toBase58() });
    tx.add(...initializePoolIxs(LOCALNET_POOL_PROGRAM_ID, auth, { authority: Keypair.generate().publicKey }));
    expect(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBeLessThan(1232 - 100); // room for a CU-limit ix
  });

  it('the validator scripts load stipend_pool upgradeable with the localnet upgrade authority', () => {
    const auth = LOCALNET_UPGRADE_AUTHORITY.publicKey.toBase58();
    for (const script of ['start-validator.sh', 'loan-start-validator.sh']) {
      const sh = readFileSync(resolve(SOL, 'scripts', script), 'utf8');
      expect(sh, script).toContain(`UPGRADE_AUTHORITY=${auth}`);
      expect(sh, script).toMatch(/--upgradeable-program "\$POOL_ID" "[^"]+stipend_pool\.so" "\$UPGRADE_AUTHORITY"/);
      expect(sh, script).not.toMatch(/--bpf-program "\$(POOL|PROBE)_ID"/);
    }
  });
});

describe('constants and error tables', () => {
  it('GRACE and the safety_pool share-price offsets match the programs', () => {
    expect(GRACE).toBe(7n * 86400n);
    expect(STREAM_GRACE).toBe(GRACE);
    expect(src('stream_loan/src/state.rs')).toContain('pub const GRACE: u64 = 7 * 24 * 60 * 60;');
    expect(src('safety_pool/src/lib.rs')).toContain('pub const GRACE: u64 = 7 * 24 * 60 * 60;');
    expect(src('safety_pool/src/lib.rs')).toContain(`pub const VIRTUAL_SHARES: u128 = 1_000;`);
    expect(src('safety_pool/src/lib.rs')).toContain(`pub const VIRTUAL_ASSETS: u128 = 1;`);
    expect([SAFETY_VIRTUAL_SHARES, SAFETY_VIRTUAL_ASSETS]).toEqual([1_000n, 1n]);
  });

  it('every launch-wallet deny-list is exactly the three H081 launch wallets (creator fees are never a source)', () => {
    const launch = ['2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP', '5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw', 'FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ'];
    const listed = (text: string, re: RegExp) => {
      const block = text.match(re);
      expect(block, re.source).not.toBeNull();
      return [...block![1].matchAll(/["'](\w{32,44})["']/g)].map((m) => m[1]).sort();
    };
    const rust = /pub const LAUNCH_WALLETS: \[Pubkey; 3\] = \[([^\]]*)\];/;
    const repo = (p: string) => readFileSync(resolve(SOL, '..', p), 'utf8');
    expect(listed(src('safety_pool/src/lib.rs'), rust)).toEqual(launch); // top_up
    expect(listed(src('stream_loan/src/fee.rs'), rust)).toEqual(launch); // origination-fee TREASURY build check
    expect(listed(repo('relayer/config.ts'), /LAUNCH_WALLET_DENYLIST[^=]*= new Set\(\[([^\]]*)\]/)).toEqual(launch); // relayer fee recipient
    expect(listed(repo('scripts/flywheel/common.mts'), /DENY_LIST[^=]*= Object\.freeze\(\[([^\]]*)\]/)).toEqual(launch); // buyback
  });

  it('every SDK error table is the Rust enum in order (6000 + index)', () => {
    expect(POOL_ERROR).toEqual(table(variants('stipend_pool/src/error.rs', 'PoolError')));
    expect(LOAN_ERROR).toEqual(table(variants('stream_loan/src/error.rs', 'LoanError')));
    expect(SAFETY_ERROR).toEqual(table(variants('safety_pool/src/lib.rs', 'SafetyError')));
    expect(CAPACITY_ERROR).toEqual(table(variants('capacity_stake/src/lib.rs', 'StakeError')));
  });
});
