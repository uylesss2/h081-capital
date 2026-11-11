// Shared fakes for the integration tests: a duck-typed Connection serving the handful of accounts the bank
// reads (pool config, asset caps, vault, the signer's token accounts, the clock), a canned relayer /v1/info,
// and a mocked bank for the tool layers. No network, no validator, no proofs.
import { vi } from 'vitest';
import { ACCOUNT_SIZE, AccountLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { assetCapPda, configPda, vaultPda } from '../../src/solana/pda.js';
import { capacityConfigPda, stakePda, accountDiscriminator } from '../../src/solana/token.js';
import { MAINNET, MAINNET_GENESIS, configFromEnv, type H081Config } from '../../integrations/core/constants.js';
import type { BankLike } from '../../integrations/core/operations.js';

export const USDG = new PublicKey(MAINNET.usdg.mint);
export const H081 = new PublicKey(MAINNET.h081.mint);
export const POOL = new PublicKey(MAINNET.programs.pool);
export const CAPACITY = new PublicKey(MAINNET.programs.capacity);

export const RELAYER_INFO = {
  solana: {
    programId: MAINNET.programs.pool, relayer: 'DWp7dJ6QZxqtUDhMy7JB6UJru47J94bQSJNEdG4QrjjA', allowUnpaid: false,
    minFees: { [MAINNET.usdg.mint]: '50000' }, feeBps: 20, treasury: MAINNET.loanTreasury,
    feeAccounts: { [MAINNET.usdg.mint]: MAINNET.treasuryUsdgAccount }, lookupTables: [],
    capacity: { freeTier: '100000000', assets: [MAINNET.usdg.mint] },
  },
};

/** A fetch that answers the relayer's /v1/info with `info` (or a failure). */
export function fakeRelayerFetch(info: unknown = RELAYER_INFO, status = 200): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith('/v1/info')) return new Response(JSON.stringify({ error: { code: 'not_found', message: url } }), { status: 404 });
    return new Response(JSON.stringify(info), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const u64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return b; };

export function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const buf = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({
    mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, buf);
  return buf;
}

export interface FakeChain {
  genesis?: string;
  paused?: boolean;
  perDeposit?: bigint;
  total?: bigint;
  inVault?: bigint;
  walletUsdg?: bigint;
  walletH081?: bigint;
  lamports?: number;
  now?: bigint;
  /** capacity_stake config present (default true) */
  capacity?: { totalStaked?: bigint; maxTotal?: bigint; maxPerStake?: bigint; paused?: boolean; deskUnit?: bigint; shieldUnit?: bigint };
  stake?: { staked: bigint; pending: bigint; readyAt: bigint };
  /** extra accounts by base58 */
  accounts?: Record<string, { owner: PublicKey; data: Buffer; executable?: boolean }>;
}

/** The accounts the bank reads, keyed by address, for `signer`. */
export function fakeConnection(signer: Keypair, chain: FakeChain = {}) {
  const accounts = new Map<string, { owner: PublicKey; data: Buffer; executable: boolean; lamports: number }>();
  const put = (k: PublicKey, owner: PublicKey, data: Buffer, executable = false) => accounts.set(k.toBase58(), { owner, data, executable, lamports: 1 });
  // mints
  put(USDG, TOKEN_2022_PROGRAM_ID, Buffer.alloc(82));
  put(H081, TOKEN_PROGRAM_ID, Buffer.alloc(82));
  // pool config: disc | authority | paused | maxTotal | maxPerDeposit
  const cfg = Buffer.concat([Buffer.alloc(8), Keypair.generate().publicKey.toBuffer(), Buffer.from([chain.paused ? 1 : 0]), u64(chain.total ?? 10_000_000_000n), u64(chain.perDeposit ?? 1_000_000_000n)]);
  put(configPda(POOL), POOL, cfg);
  const cap = Buffer.concat([Buffer.alloc(8), USDG.toBuffer(), u64(chain.total ?? 10_000_000_000n), u64(chain.perDeposit ?? 1_000_000_000n)]);
  put(assetCapPda(POOL, USDG), POOL, cap);
  put(vaultPda(POOL, USDG), TOKEN_2022_PROGRAM_ID, tokenAccountData(USDG, PublicKey.default, chain.inVault ?? 0n));
  put(getAssociatedTokenAddressSync(USDG, signer.publicKey, false, TOKEN_2022_PROGRAM_ID), TOKEN_2022_PROGRAM_ID, tokenAccountData(USDG, signer.publicKey, chain.walletUsdg ?? 0n));
  put(getAssociatedTokenAddressSync(H081, signer.publicKey, false, TOKEN_PROGRAM_ID), TOKEN_PROGRAM_ID, tokenAccountData(H081, signer.publicKey, chain.walletH081 ?? 0n));
  // clock sysvar: slot u64 | epochStartTimestamp i64 | epoch u64 | leaderScheduleEpoch u64 | unixTimestamp i64
  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(chain.now ?? 1_800_000_000n, 32);
  put(SYSVAR_CLOCK_PUBKEY, PublicKey.default, clock);
  // capacity_stake config and the signer's stake
  const c = chain.capacity ?? {};
  const cfgC = Buffer.concat([
    accountDiscriminator('Config'), H081.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), Keypair.generate().publicKey.toBuffer(), Buffer.from([6]),
    u64(c.deskUnit ?? 100_000_000n), u64(c.shieldUnit ?? 100_000_000n), u64(c.totalStaked ?? 0n), u64(0n), Buffer.from([0, 0]),
    Keypair.generate().publicKey.toBuffer(), Buffer.from([c.paused ? 1 : 0]), u64(c.maxTotal ?? MAINNET.stakeCaps.total), u64(c.maxPerStake ?? MAINNET.stakeCaps.perStake),
  ]);
  put(capacityConfigPda(CAPACITY, H081), CAPACITY, cfgC);
  if (chain.stake) {
    const s = chain.stake;
    const stake = Buffer.concat([accountDiscriminator('Stake'), signer.publicKey.toBuffer(), H081.toBuffer(), u64(s.staked), u64(s.pending), (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(s.readyAt); return b; })(), Buffer.from([0])]);
    put(stakePda(CAPACITY, H081, signer.publicKey), CAPACITY, stake);
  }
  for (const [k, v] of Object.entries(chain.accounts ?? {})) accounts.set(k, { owner: v.owner, data: v.data, executable: v.executable ?? false, lamports: 1 });

  const conn = {
    rpcEndpoint: 'http://127.0.0.1:1',
    calls: [] as string[],
    getGenesisHash: vi.fn(async () => chain.genesis ?? MAINNET_GENESIS),
    getAccountInfo: vi.fn(async (k: PublicKey) => { conn.calls.push(`getAccountInfo ${k.toBase58()}`); return accounts.get(k.toBase58()) ?? null; }),
    getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map((k) => accounts.get(k.toBase58()) ?? null)),
    getBalance: vi.fn(async () => chain.lamports ?? Math.round(0.5 * LAMPORTS_PER_SOL)),
    getSignaturesForAddress: vi.fn(async () => []),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 })),
    simulateTransaction: vi.fn(async () => { throw new Error('fake connection: nothing is simulated in tests'); }),
    sendRawTransaction: vi.fn(async () => { throw new Error('fake connection: nothing is sent in tests'); }),
    accounts,
  };
  return conn;
}

/** The mainnet config with a throwaway circuits directory and no relayer unless `relayerUrl` is set. */
export function testConfig(over: Partial<H081Config> = {}): H081Config {
  const cfg = configFromEnv({ H081_CIRCUITS_DIR: 'C:/nonexistent/h081-test-circuits', H081_RELAYER_URL: '' });
  return { ...cfg, ...over };
}

/** A bank whose every method is a vi.fn() returning canned, JSON-friendly results (bigints included). */
export function mockBank(over: Partial<Record<keyof BankLike, unknown>> = {}): BankLike & Record<keyof BankLike, ReturnType<typeof vi.fn>> {
  const b = {
    decimals: 6,
    deposit: vi.fn(async (amount: bigint) => ({ signature: 'sigDeposit', amount, amountUsdg: (Number(amount) / 1e6).toString(), shielded: amount, shieldedUsdg: (Number(amount) / 1e6).toString(), computeUnits: 300000 })),
    withdraw: vi.fn(async (amount: bigint, to?: PublicKey, direct?: boolean) => ({ signature: 'sigWithdraw', amount, fee: direct ? 0n : 50000n, received: amount - (direct ? 0n : 50000n), receivedUsdg: '1', to: (to ?? PublicKey.default).toBase58(), via: direct ? 'direct' : 'relayer', shielded: 0n, shieldedUsdg: '0' })),
    balance: vi.fn(async () => ({ shielded: 25_000_000n, shieldedUsdg: '25', walletUsdg: 100_000_000n, walletUsdgHuman: '100', walletSol: 0.2, signer: 'S', shieldedAddress: { pk: '1', viewPub: '0x00' }, subAccounts: [], agentAllowances: [], grantedToOthers: [], heldBySubAccounts: [], caps: { perDeposit: 1_000_000_000n, total: 10_000_000_000n, inVault: 0n, paused: false } })),
    loanQuote: vi.fn(async (q: { pledgeBps?: number; minRemaining?: bigint; principal?: bigint; loanRef?: bigint; termsCode?: string }) => ({ pledgeBps: q.pledgeBps ?? 0, minRemaining: q.minRemaining ?? 0n, maxPrincipal: 40_000_000n, principal: q.principal ?? 40_000_000n, originationFee: 100_000n, originationFeeBps: 25, payout: 39_900_000n, loanRef: q.loanRef, slot: null, note: 'n' })),
    borrow: vi.fn(async () => ({ agentIndex: 0, allowanceId: 1n, loanRef: 3n, pledgeBps: 4000n, grantSignature: 'sigGrant', proofCode: 'h081-loan-proof:eyJ2IjoxfQ', maxPrincipal: 40_000_000n, originationFeeAtMax: 100_000n, payoutAccount: 'P', streamRate: 1n, expiry: 1n, next: 'n' })),
    stakeView: vi.fn(async () => ({ signer: 'S', walletH081: 1_000_000_000n, staked: 0n, pending: 0n, readyAt: 0n, now: 1n, desks: 0n, shieldCap: 0n, totalStaked: 0n, caps: { maxPerStake: 1n, maxTotal: 2n, paused: false }, cooldownDays: 30 })),
    stake: vi.fn(async (amount: bigint) => ({ signature: 'sigStake', staked: amount })),
    requestUnstake: vi.fn(async (amount: bigint) => ({ signature: 'sigRequest', pending: amount })),
    unstake: vi.fn(async () => ({ signature: 'sigUnstake', pending: 0n })),
    protocolInfo: vi.fn(async () => ({ cluster: 'mainnet-beta', programs: { pool: MAINNET.programs.pool }, notice: 'n' })),
    pay: vi.fn(async (req: { amount: bigint; to: PublicKey | { pk: bigint }; agentIndex?: number; direct?: boolean }) => {
      const pub = req.to instanceof PublicKey, fee = pub && !req.direct ? 50_000n : 0n;
      return { signature: 'sigPay', amount: req.amount, amountUsdg: '1', fee, lenderShare: 0n, received: req.amount - fee, receivedUsdg: '1', to: pub ? (req.to as PublicKey).toBase58() : 'shielded', private: !pub, via: fee ? 'relayer' : 'direct', allowanceId: 7n, nextAllowanceId: 8n, ...(req.agentIndex === undefined ? {} : { agentIndex: req.agentIndex }), remaining: 1_000_000n, remainingUsdg: '1' };
    }),
    codeContext: { cluster: 'mainnet-beta', program: MAINNET.programs.pool, mint: MAINNET.usdg.mint },
    allowanceGrant: vi.fn(async (req: { amount: bigint; agentIndex?: number; confirm?: boolean }) => (req.confirm
      ? { sent: true, signature: 'sigGrant', to: req.agentIndex === undefined ? 'another agent\'s shielded address' : `sub-account ${req.agentIndex}`, ...(req.agentIndex === undefined ? {} : { agentIndex: req.agentIndex }), allowanceId: 11n, rules: { amount: req.amount }, shielded: 0n, shieldedUsdg: '0', next: 'n' }
      : { sent: false, dryRun: true, plan: { action: 'grant', rules: { amount: req.amount } }, next: 'nothing was sent' })),
    allowanceDelegate: vi.fn(async (req: { allowanceId: bigint; amount: bigint; confirm?: boolean }) => (req.confirm
      ? { sent: true, signature: 'sigDelegate', signatures: ['sigDelegate'], parentId: req.allowanceId, to: 'sub-account 2', allowanceId: 12n, rules: { amount: req.amount }, residualId: 13n, residualRemaining: 1n, residualRemainingUsdg: '0.000001', next: 'n' }
      : { sent: false, dryRun: true, plan: { action: 'delegate', parentId: req.allowanceId, child: { amount: req.amount } }, next: 'nothing was sent' })),
    allowanceReclaim: vi.fn(async (req: { allowanceId: bigint; confirm?: boolean }) => (req.confirm
      ? { sent: true, signature: 'sigReclaim', allowanceId: req.allowanceId, reclaimed: 5_000_000n, reclaimedUsdg: '5', lenderShare: 0n, shielded: 5_000_000n, shieldedUsdg: '5' }
      : { sent: false, dryRun: true, plan: { action: 'reclaim', allowanceId: req.allowanceId }, next: 'nothing was sent' })),
    lendOpen: vi.fn(async (req: { pledgeBps: bigint; confirm?: boolean }) => (req.confirm
      ? { sent: true, loanRef: 3n, pledgeBps: req.pledgeBps, slot: 'Slot', termsCode: 'h081-loan-terms:4mD9q', next: 'n' }
      : { sent: false, dryRun: true, plan: { action: 'open', loanRef: 3n, pledgeBps: req.pledgeBps }, next: 'nothing was sent' })),
    lendFund: vi.fn(async (req: { proofCode: string; loanRef?: bigint; principal?: bigint; confirm?: boolean }) => (req.confirm
      ? { sent: true, signature: 'sigFund', loanRef: req.loanRef ?? 3n, principal: 40_000_000n, principalUsdg: '40', originationFee: 100_000n, borrowerReceives: 39_900_000n, borrowerReceivesUsdg: '39.9', next: 'n' }
      : { sent: false, dryRun: true, plan: { action: 'fund', loanRef: req.loanRef ?? 3n, principal: 40_000_000n }, next: 'nothing was sent' })),
    lendStatus: vi.fn(async (req: { loanRef?: bigint } = {}) => ({ slots: [{ loanRef: req.loanRef ?? 3n, state: 'funded', principal: 40_000_000n, repaid: 0n, claimable: 1_000_000n }] })),
    lendCollect: vi.fn(async (req: { loanRef: bigint }) => ({ sent: true, action: 'collect', loanRef: req.loanRef, signatures: ['sigSync'], collected: 2_000_000n, collectedUsdg: '2' })),
    lendClaim: vi.fn(async (req: { loanRef: bigint; amount?: bigint }) => ({ sent: true, action: 'claim', loanRef: req.loanRef, signatures: ['sigClaim'], collected: req.amount ?? 1_000_000n, collectedUsdg: '1' })),
    lendSettle: vi.fn(async (req: { loanRef: bigint; confirm?: boolean }) => (req.confirm
      ? { sent: true, action: 'settle', loanRef: req.loanRef, signatures: ['sigSettle'] }
      : { sent: false, dryRun: true, plan: { action: 'settle', loanRef: req.loanRef }, next: 'nothing was sent' })),
    lendSweep: vi.fn(async (req: { loanRef: bigint }) => ({ sent: true, action: 'sweep', loanRef: req.loanRef, signatures: ['sigSweep'], collected: 1_000_000n, collectedUsdg: '1', returnedToBorrower: 0n, returnedToBorrowerUsdg: '0' })),
    lendClose: vi.fn(async (req: { loanRef: bigint; confirm?: boolean }) => (req.confirm
      ? { sent: true, action: 'close', loanRef: req.loanRef, signatures: ['sigClose'] }
      : { sent: false, dryRun: true, plan: { action: 'close', loanRef: req.loanRef }, next: 'nothing was sent' })),
    transfer: vi.fn(async (amount: bigint, _code: string) => ({ signature: 'sigTransfer', amount, amountUsdg: (Number(amount) / 1e6).toString(), to: 'shielded', via: 'direct', shielded: 1n, shieldedUsdg: '0.000001' })),
    ...over,
  };
  return b as unknown as BankLike & Record<keyof BankLike, ReturnType<typeof vi.fn>>;
}
