// H081Bank against a fake connection: caps and balances are checked before any proof, relay fees are
// computed the way the relayer checks them, the cluster/id guard refuses mismatches. Nothing is proven or sent.
import { describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Prover } from '../../src/prover.js';
import { capacityMessage, fromB64 } from '../../src/solana/relay.js';
import { relayBody } from '../../src/solana/wallet.js';
import { H081Bank, RelayerUnavailableError } from '../../integrations/core/bank.js';
import { MAINNET, MAINNET_GENESIS, checkCluster, configFromEnv, isMainnetConfig, rpcHost } from '../../integrations/core/constants.js';
import { deriveAccountSk } from '../../integrations/core/keys.js';
import { plain } from '../../integrations/core/operations.js';
import { RELAYER_INFO, USDG, fakeConnection, fakeRelayerFetch, testConfig } from './helpers.js';

const noProver = new Prover('C:/nonexistent');
const RELAYER_INFO_TERMS = { minFee: BigInt(RELAYER_INFO.solana.minFees[MAINNET.usdg.mint]), feeBps: RELAYER_INFO.solana.feeBps };

async function open(signer: Keypair, chain: Parameters<typeof fakeConnection>[1] = {}, relayer = false) {
  const conn = fakeConnection(signer, chain);
  const config = testConfig(relayer ? { relayerUrl: MAINNET.relayer } : {});
  const bank = await H081Bank.open({
    config, signer, accountSk: deriveAccountSk(signer), connection: conn as unknown as Connection, prover: noProver, cacheDir: null,
    fetch: fakeRelayerFetch(RELAYER_INFO),
  });
  return { bank, conn };
}

describe('H081Bank', () => {
  it('reads the caps from the config, asset cap and vault accounts', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer, { inVault: 2_500_000_000n, paused: false });
    expect(await bank.caps()).toEqual({ perDeposit: 1_000_000_000n, total: 10_000_000_000n, inVault: 2_500_000_000n, paused: false });
  });

  it('refuses deposits the program would refuse, before the wallet proves anything', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer, { inVault: 9_500_000_000n, walletUsdg: 5_000_000_000n });
    const spy = vi.spyOn(bank.owner, 'deposit');
    await expect(bank.deposit(1_000_000_001n)).rejects.toThrow(/DepositTooLarge: at most 1000 USDG per deposit/);
    await expect(bank.deposit(600_000_000n)).rejects.toThrow(/DepositCapExceeded: the bank holds at most 10000 USDG in total; 500 USDG of room left/);
    await expect(bank.deposit(0n)).rejects.toThrow(/positive/);
    expect(spy).not.toHaveBeenCalled();

    const paused = await open(signer, { paused: true });
    const spy2 = vi.spyOn(paused.bank.owner, 'deposit');
    await expect(paused.bank.deposit(1_000_000n)).rejects.toThrow(/DepositsPaused/);
    expect(spy2).not.toHaveBeenCalled();

    const poor = await open(signer, { walletUsdg: 500_000n, lamports: 1_000_000_000 });
    await expect(poor.bank.deposit(1_000_000n)).rejects.toThrow(/holds 0\.5 USDG, less than 1/);
    const noSol = await open(signer, { walletUsdg: 5_000_000n, lamports: 1_000_000 });
    await expect(noSol.bank.deposit(1_000_000n)).rejects.toThrow(/0\.0010 SOL; a deposit needs about 0\.02 SOL/);

    const capped = fakeConnection(signer, { walletUsdg: 5_000_000_000n });
    const b = await H081Bank.open({ config: testConfig({ maxDeposit: 2_000_000n }), signer, accountSk: 1n, connection: capped as unknown as Connection, prover: noProver, cacheDir: null });
    await expect(b.deposit(3_000_000n)).rejects.toThrow(/H081_MAX_DEPOSIT/);
  });

  it('a deposit that passes the checks goes to the wallet and the program error (if any) is explained', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer, { walletUsdg: 5_000_000_000n });
    const dep = vi.spyOn(bank.owner, 'deposit').mockResolvedValue({ tx: { signature: 'sig1', computeUnits: 400_000, logs: [] }, proof: {} as never });
    vi.spyOn(bank.owner, 'balance').mockReturnValue(25_000_000n);
    const r = await bank.deposit(25_000_000n);
    expect(dep).toHaveBeenCalledWith(new PublicKey(MAINNET.usdg.mint), 25_000_000n);
    expect(r).toMatchObject({ signature: 'sig1', amount: 25_000_000n, amountUsdg: '25', shielded: 25_000_000n, shieldedUsdg: '25' });
    dep.mockRejectedValue(new Error(`Program ${MAINNET.programs.pool} failed: custom program error: 0x1795`));
    await expect(bank.deposit(25_000_000n)).rejects.toThrow(/^DepositCapExceeded \(6037, stipend_pool\)/);
  });

  it('relayFee is the smallest fee the relayer accepts: fee >= max(min, bps * (amount - fee) / 10000)', () => {
    const t = { minFee: 50_000n, feeBps: 20 };
    const need = (amount: bigint, fee: bigint) => { const pct = (20n * (amount - fee)) / 10_000n; return pct > t.minFee ? pct : t.minFee; };
    for (const amount of [60_000n, 1_000_000n, 25_000_000n, 25_050_100n, 100_000_000n, 999_999_999n, 10_000_000_000n]) {
      const fee = H081Bank.relayFee(amount, t);
      expect(fee >= need(amount, fee), `${amount}`).toBe(true);
      expect(fee - 1n < need(amount, fee - 1n) || fee === t.minFee, `${amount} minimal`).toBe(true);
    }
    expect(H081Bank.relayFee(1_000_000n, t)).toBe(50_000n); // 1 USDG: the minimum
    expect(H081Bank.relayFee(100_000_000n, t)).toBe(199_600n); // 100 USDG: 0.20% of the public amount
    expect(H081Bank.relayFee(1_000_000n, { minFee: 0n, feeBps: 0 })).toBe(0n);
  });

  it('withdraws through the relayer with its terms, or directly, and checks the shielded balance first', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer, {}, true);
    vi.spyOn(bank.owner, 'sync').mockResolvedValue(undefined);
    vi.spyOn(bank.owner, 'balance').mockReturnValue(10_000_000n);
    const wd = vi.spyOn(bank.owner, 'withdraw').mockResolvedValue({ tx: { signature: 'sigW', computeUnits: 1, logs: [] }, proof: {} as never });
    await expect(bank.withdraw(20_000_000n)).rejects.toThrow(/shielded balance is 10 USDG, less than 20/);
    expect(wd).not.toHaveBeenCalled();

    const r = await bank.withdraw(10_000_000n);
    expect(r).toMatchObject({ signature: 'sigW', amount: 10_000_000n, fee: 50_000n, received: 9_950_000n, receivedUsdg: '9.95', to: signer.publicKey.toBase58(), via: 'relayer' });
    const relay = wd.mock.calls[0][3]!;
    expect(relay.fee).toBe(50_000n);
    expect(relay.relayer!.toBase58()).toBe(RELAYER_INFO.solana.relayer);
    expect(relay.feeRecipient!.toBase58()).toBe(MAINNET.treasuryUsdgAccount);
    expect(relay.via).toBeDefined();

    const to = Keypair.generate().publicKey;
    const d = await bank.withdraw(10_000_000n, to, true);
    expect(d).toMatchObject({ fee: 0n, received: 10_000_000n, to: to.toBase58(), via: 'direct' });
    expect(wd.mock.calls[1][3]).toEqual({});
    await expect(bank.withdraw(50_000n)).rejects.toThrow(/relay fee .* is not below the amount/);
  });

  it('relayTerms is undefined only without a relayer (H081_RELAYER_URL empty); unreachable, no USDG or another pool are errors', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer, {}, false);
    expect(await bank.relayTerms()).toBeUndefined();
    const conn = fakeConnection(signer);
    const withInfo = (info: unknown, status = 200) => H081Bank.open({
      config: testConfig({ relayerUrl: MAINNET.relayer }), signer, accountSk: 1n, connection: conn as unknown as Connection, prover: noProver, cacheDir: null,
      fetch: fakeRelayerFetch(info, status),
    });
    await expect((await withInfo({ solana: { ...RELAYER_INFO.solana, minFees: {}, feeAccounts: {} } })).relayTerms()).rejects.toThrow(/does not accept USDG/);
    await expect((await withInfo({ error: { code: 'down' } }, 503)).relayTerms()).rejects.toThrow(/is unreachable/);
    await expect((await withInfo({ evm: {} })).relayTerms()).rejects.toThrow(/does not relay Solana/);
    await expect((await withInfo({ solana: { ...RELAYER_INFO.solana, programId: Keypair.generate().publicKey.toBase58() } })).relayTerms()).rejects.toThrow(/serves pool/);
  });

  it('a relayed withdrawal fails closed: an unreachable relayer refuses it instead of sending it from the agent key', async () => {
    const signer = Keypair.generate();
    const conn = fakeConnection(signer);
    const bank = await H081Bank.open({
      config: testConfig({ relayerUrl: MAINNET.relayer }), signer, accountSk: 1n, connection: conn as unknown as Connection, prover: noProver, cacheDir: null,
      fetch: fakeRelayerFetch({ error: { code: 'down' } }, 503),
    });
    vi.spyOn(bank.owner, 'sync').mockResolvedValue(undefined);
    vi.spyOn(bank.owner, 'balance').mockReturnValue(500_000_000n);
    const wd = vi.spyOn(bank.owner, 'withdraw').mockResolvedValue({ tx: { signature: 'sigW', computeUnits: 1, logs: [] }, proof: {} as never });
    const to = Keypair.generate().publicKey;
    await expect(bank.withdraw(500_000_000n, to)).rejects.toThrow(/is unreachable[\s\S]*The withdrawal was not sent[\s\S]*pass direct: true/);
    expect(wd).not.toHaveBeenCalled();
    // direct: true is the only way the agent key sends it
    expect(await bank.withdraw(500_000_000n, to, true)).toMatchObject({ via: 'direct', fee: 0n, to: to.toBase58() });
    expect(wd).toHaveBeenCalledTimes(1);
    const info = await bank.protocolInfo();
    expect(info.relayer).toBeNull();
    expect(String(info.relayerStatus)).toMatch(/^unavailable: the relayer .* is unreachable/);

    // no relayer configured at all: the signer sends, and says so
    const none = await open(signer, {}, false);
    vi.spyOn(none.bank.owner, 'sync').mockResolvedValue(undefined);
    vi.spyOn(none.bank.owner, 'balance').mockReturnValue(500_000_000n);
    const wd2 = vi.spyOn(none.bank.owner, 'withdraw').mockResolvedValue({ tx: { signature: 'sigD', computeUnits: 1, logs: [] }, proof: {} as never });
    expect(await none.bank.withdraw(500_000_000n, to)).toMatchObject({ via: 'direct', fee: 0n });
    expect(wd2.mock.calls[0][3]).toEqual({});
    expect(String((await none.bank.protocolInfo()).relayerStatus)).toMatch(/no relayer configured/);
  });

  it('a relayer whose fee account is not the treasury\'s is refused before anything is proven', async () => {
    const signer = Keypair.generate();
    const conn = fakeConnection(signer);
    const lookalike = Keypair.generate().publicKey.toBase58();
    const openWith = (solana: Record<string, unknown>) => H081Bank.open({
      config: testConfig({ relayerUrl: MAINNET.relayer }), signer, accountSk: 1n, connection: conn as unknown as Connection, prover: noProver, cacheDir: null,
      fetch: fakeRelayerFetch({ solana: { ...RELAYER_INFO.solana, ...solana } }),
    });
    const wrongAccount = await openWith({ feeAccounts: { [MAINNET.usdg.mint]: lookalike } });
    vi.spyOn(wrongAccount.owner, 'sync').mockResolvedValue(undefined);
    vi.spyOn(wrongAccount.owner, 'balance').mockReturnValue(10_000_000n);
    const wd = vi.spyOn(wrongAccount.owner, 'withdraw');
    await expect(wrongAccount.relayTerms()).rejects.toThrow(RelayerUnavailableError);
    await expect(wrongAccount.withdraw(10_000_000n)).rejects.toThrow(new RegExp(`names ${lookalike} as its USDG fee account .*not the treasury's USDG account ${MAINNET.treasuryUsdgAccount} owned by ${MAINNET.loanTreasury}`));
    expect(wd).not.toHaveBeenCalled();
    expect((await wrongAccount.protocolInfo()).relayer).toBeNull();
    // the right account but another treasury owner is refused too
    await expect((await openWith({ treasury: Keypair.generate().publicKey.toBase58() })).relayTerms()).rejects.toThrow(/not the treasury's USDG account/);
    // the mainnet terms pass
    expect((await (await openWith({})).relayTerms())!.feeRecipient.toBase58()).toBe(MAINNET.treasuryUsdgAccount);

    // off mainnet (other program ids) the fee account must be the associated USDG account of the treasury the relayer names
    const otherPool = Keypair.generate().publicKey, treasury = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(USDG, treasury, true, TOKEN_2022_PROGRAM_ID).toBase58();
    const openOff = (feeAccount: string) => H081Bank.open({
      config: testConfig({ relayerUrl: MAINNET.relayer, poolProgramId: otherPool }), signer, accountSk: 1n, connection: conn as unknown as Connection, prover: noProver, cacheDir: null,
      fetch: fakeRelayerFetch({ solana: { ...RELAYER_INFO.solana, programId: otherPool.toBase58(), treasury: treasury.toBase58(), feeAccounts: { [MAINNET.usdg.mint]: feeAccount } } }),
    });
    expect((await (await openOff(ata)).relayTerms())!.feeRecipient.toBase58()).toBe(ata);
    await expect((await openOff(lookalike)).relayTerms()).rejects.toThrow(/not the treasury's associated USDG account/);
  });

  it('above the free tier the agent wallet is named as capacity operator (signed), or the withdrawal is refused before proving', async () => {
    const signer = Keypair.generate();
    // 500 H081 staked at 100 H081 per unit: shieldCap = 5 x 10,000 USDG
    const staked = await open(signer, { stake: { staked: 500_000_000n, pending: 0n, readyAt: 0n } }, true);
    vi.spyOn(staked.bank.owner, 'sync').mockResolvedValue(undefined);
    vi.spyOn(staked.bank.owner, 'balance').mockReturnValue(100_000_000_000n);
    const wd = vi.spyOn(staked.bank.owner, 'withdraw').mockResolvedValue({ tx: { signature: 'sigW', computeUnits: 1, logs: [] }, proof: {} as never });
    const fee = H081Bank.relayFee(150_000_000n, RELAYER_INFO_TERMS);
    const r = await staked.bank.withdraw(150_000_000n);
    expect(r).toMatchObject({ via: 'relayer', fee, received: 150_000_000n - fee, operator: signer.publicKey.toBase58() });
    const relay = wd.mock.calls[0][3]!;
    expect(relay.operator!.operator.equals(signer.publicKey)).toBe(true);
    // what relayThrough sends: the operator and its signature over capacityMessage(payload), as relayer/solana.ts verifies it
    const payload = new Uint8Array([1, 2, 3, 4]);
    const body = await relayBody({ op: 'transact', mint: MAINNET.usdg.mint }, payload, relay.operator);
    expect(body).toMatchObject({ op: 'transact', mint: MAINNET.usdg.mint, operator: signer.publicKey.toBase58() });
    expect(ed25519.verify(fromB64(body.operatorSig!), capacityMessage(payload), signer.publicKey.toBytes())).toBe(true);
    expect(ed25519.verify(fromB64(body.operatorSig!), capacityMessage(new Uint8Array([9])), signer.publicKey.toBytes())).toBe(false);
    expect((await relayBody({ op: 'transact' }, payload)).operator).toBeUndefined();

    // at the free tier (public amount 99.8004 USDG) nobody is named
    const atTier = await staked.bank.withdraw(100_000_000n);
    expect(atTier.operator).toBeUndefined();
    expect(wd.mock.calls[1][3]!.operator).toBeUndefined();

    // over the free tier plus the staked capacity: refused before any proof, naming the stake, the limit and direct: true
    await expect(staked.bank.withdraw(60_000_000_000n)).rejects.toThrow(
      "is more than the relayer takes with nothing staked (up to 100 USDG per withdrawal; above that, H081 staked in capacity_stake sets a 30-day limit: the agent wallet's 500 H081 staked allows 50100 USDG per 30 days). Nothing was sent. Stake more H081 (h081_stake), withdraw at most 100 USDG at a time, or pass direct: true",
    );
    expect(wd).toHaveBeenCalledTimes(2);

    // nothing staked: 150 USDG is refused, direct: true still works
    const none = await open(signer, {}, true);
    vi.spyOn(none.bank.owner, 'sync').mockResolvedValue(undefined);
    vi.spyOn(none.bank.owner, 'balance').mockReturnValue(200_000_000n);
    const wd2 = vi.spyOn(none.bank.owner, 'withdraw').mockResolvedValue({ tx: { signature: 'sigW', computeUnits: 1, logs: [] }, proof: {} as never });
    await expect(none.bank.withdraw(150_000_000n)).rejects.toThrow(/sets a 30-day limit: the agent wallet has none staked\)\. Nothing was sent\.[\s\S]*direct: true/);
    expect(wd2).not.toHaveBeenCalled();
    expect(await none.bank.withdraw(150_000_000n, undefined, true)).toMatchObject({ via: 'direct', fee: 0n });
  });

  it('protocolInfo and the cluster guard report the RPC host only, never a private RPC URL\'s key', async () => {
    const signer = Keypair.generate();
    const conn = fakeConnection(signer);
    const rpcUrl = 'https://solana-mainnet.g.alchemy.com/v2/SECRETKEY123?api-key=ALSOSECRET';
    const bank = await H081Bank.open({ config: testConfig({ rpcUrl }), signer, accountSk: 1n, connection: conn as unknown as Connection, prover: noProver, cacheDir: null });
    const info = await bank.protocolInfo();
    expect(info).toMatchObject({ rpc: 'solana-mainnet.g.alchemy.com', rpcIsPublic: false, account: { source: 'seed' } });
    expect(String((info.account as { note: string }).note)).toMatch(/no signature the key makes reveals it/);
    const text = JSON.stringify(plain(info));
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('/v2/');
    expect(text).not.toContain('api-key');
    expect((await (await open(signer)).bank.protocolInfo()).rpcIsPublic).toBe(true);
    expect(rpcHost('https://rpc.helius.xyz/?api-key=KEY')).toBe('rpc.helius.xyz');
    expect(rpcHost('http://127.0.0.1:8899')).toBe('127.0.0.1:8899');
    const err = (() => { try { checkCluster({ ...configFromEnv({}), rpcUrl }, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'); return ''; } catch (e) { return (e as Error).message; } })();
    expect(err).toMatch(/the RPC solana-mainnet\.g\.alchemy\.com is not mainnet-beta/);
    expect(err).not.toContain('SECRET');
    // the account note follows the derivation
    const sig = await H081Bank.open({ config: testConfig(), signer, accountSk: 1n, derivation: 'signature', connection: conn as unknown as Connection, prover: noProver, cacheDir: null });
    expect((await sig.protocolInfo()).account).toMatchObject({ source: 'signature', note: expect.stringMatching(/never let a message-signing tool sign it/) });
    const env = await H081Bank.open({ config: testConfig(), signer, accountSk: 1n, accountSource: 'env', connection: conn as unknown as Connection, prover: noProver, cacheDir: null });
    expect((await env.protocolInfo()).account).toMatchObject({ source: 'env' });
  });

  it('balance and protocolInfo read the chain; stake checks caps and cooldown before sending', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer, { walletUsdg: 100_000_000n, walletH081: 1_000_000_000n, inVault: 1n, stake: { staked: 500_000_000n, pending: 100_000_000n, readyAt: 2_000_000_000n } }, true);
    vi.spyOn(bank.owner, 'sync').mockResolvedValue(undefined);
    const b = await bank.balance();
    expect(b).toMatchObject({ shielded: 0n, shieldedUsdg: '0', walletUsdg: 100_000_000n, walletUsdgHuman: '100', signer: signer.publicKey.toBase58(), subAccounts: [], agentAllowances: [] });
    expect(b.caps).toEqual({ perDeposit: 1_000_000_000n, total: 10_000_000_000n, inVault: 1n, paused: false });
    expect(b.shieldedAddress.pk).toBe(bank.account.address.pk.toString());

    const info = await bank.protocolInfo();
    expect(info).toMatchObject({
      cluster: 'mainnet-beta', rpc: 'api.mainnet-beta.solana.com', rpcIsPublic: true, relayerStatus: 'ok',
      programs: { pool: MAINNET.programs.pool, loan: MAINNET.programs.loan, capacity: MAINNET.programs.capacity },
      usdg: { mint: MAINNET.usdg.mint, decimals: 6 }, h081: { mint: MAINNET.h081.mint }, loanTreasury: MAINNET.loanTreasury,
      caps: { perDepositUsdg: '1000', totalUsdg: '10000', paused: false }, fees: { relayBps: 20, relayMin: 50_000n, loanOriginationBps: 25 },
      relayer: { feeAccount: MAINNET.treasuryUsdgAccount, treasury: MAINNET.loanTreasury, freeTier: 100_000_000n },
    });
    expect(String(info.notice)).toMatch(/not audited yet; use at your own risk/);

    const v = await bank.stakeView();
    expect(v).toMatchObject({ walletH081: 1_000_000_000n, staked: 500_000_000n, pending: 100_000_000n, readyAt: 2_000_000_000n, desks: 5n, caps: { maxPerStake: MAINNET.stakeCaps.perStake, maxTotal: MAINNET.stakeCaps.total, paused: false } });
    await expect(bank.stake(MAINNET.stakeCaps.perStake + 1n)).rejects.toThrow(/StakeCap: at most 100000 H081 per stake/);
    await expect(bank.stake(2_000_000_000n)).rejects.toThrow(/holds 1000 H081, less than 2000/);
    await expect(bank.requestUnstake(600_000_000n)).rejects.toThrow(/MoreThanStaked: only 500 H081 is staked/);
    await expect(bank.unstake()).rejects.toThrow(/Cooldown: unstakable from/);
  });

  it('loanQuote prices a pledge (max principal, 0.25% fee) from terms or numbers and reads a slot', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer);
    const q = await bank.loanQuote({ pledgeBps: 4000, minRemaining: 100_000_000n });
    expect(q).toMatchObject({ pledgeBps: 4000, maxPrincipal: 40_000_000n, principal: 40_000_000n, originationFee: 100_000n, originationFeeBps: 25, payout: 39_900_000n });
    expect((await bank.loanQuote({ pledgeBps: 4000, minRemaining: 100_000_000n, principal: 10_000_000n })).payout).toBe(9_975_000n);
    await expect(bank.loanQuote({ pledgeBps: 4000, minRemaining: 100_000_000n, principal: 40_000_001n })).rejects.toThrow(/PrincipalTooLarge/);
    // a principal with no budget quotes the budget that principal needs (was: "at most 0 USDG")
    const byPrincipal = await bank.loanQuote({ pledgeBps: 4000, principal: 20_000_000n });
    expect(byPrincipal).toMatchObject({ minRemaining: 50_000_000n, maxPrincipal: 20_000_000n, principal: 20_000_000n, payout: 19_950_000n });
    expect((await bank.loanQuote({ pledgeBps: 3333, principal: 7_000_001n })).maxPrincipal).toBe(7_000_001n);
    await expect(bank.loanQuote({})).rejects.toThrow(/termsCode, a pledgeBps or a loanRef/);
    expect((await bank.loanQuote({ loanRef: 3n })).slot).toBeNull();
    await expect(bank.loanQuote({ termsCode: 'h081-loan-proof:x' })).rejects.toThrow(/not a loan terms code/);
  });

  it('borrow refuses foreign terms, a missing or funded slot, and an unlock longer than the lifetime, before granting', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer);
    const grant = vi.spyOn(bank.owner, 'grant');
    const { encodeTerms } = await import('../../integrations/core/codes.js');
    const { slotPda } = await import('../../src/solana/lender.js');
    const loan = new PublicKey(MAINNET.programs.loan);
    const good = { v: 1, cluster: 'mainnet-beta', program: MAINNET.programs.loan, mint: MAINNET.usdg.mint, lender: slotPda(3n, loan), loanRef: 3n, pledgeBps: 4000n, lenderViewPub: new Uint8Array(32) };
    const rules = { budget: 100_000_000n, days: 30, unlockDays: 30 };
    await expect(bank.borrow(encodeTerms({ ...good, cluster: 'devnet' }), rules)).rejects.toThrow(/another network, loan program or asset/);
    await expect(bank.borrow(encodeTerms({ ...good, lender: Keypair.generate().publicKey }), rules)).rejects.toThrow(/not the loan slot/);
    await expect(bank.borrow(encodeTerms(good), { ...rules, unlockDays: 31 })).rejects.toThrow(/unlock within/);
    await expect(bank.borrow(encodeTerms(good), rules)).rejects.toThrow(/loan slot #3 does not exist/);
    expect(grant).not.toHaveBeenCalled();
  });

  it('borrow sizes the budget to the principal and refuses a bigger one (the lender would take more than it lent)', async () => {
    const signer = Keypair.generate();
    const { bank } = await open(signer);
    const grant = vi.spyOn(bank.owner, 'grant');
    const { encodeTerms } = await import('../../integrations/core/codes.js');
    const { slotPda } = await import('../../src/solana/lender.js');
    const loan = new PublicKey(MAINNET.programs.loan);
    const terms = encodeTerms({ v: 1, cluster: 'mainnet-beta', program: MAINNET.programs.loan, mint: MAINNET.usdg.mint, lender: slotPda(3n, loan), loanRef: 3n, pledgeBps: 4000n, lenderViewPub: new Uint8Array(32) });
    // 100 pledged at 40% lets the lender take 40 against a 20 loan: refused, and the right budget (50) is named
    await expect(bank.borrow(terms, { budget: 100_000_000n, principal: 20_000_000n, days: 30, unlockDays: 30 })).rejects.toThrow(/Overpay:.*up to 40 .*Use a budget of 50 .*Nothing was sent/);
    // exactly the needed budget, or none (sized for you), pass the overpay check and reach the chain checks
    await expect(bank.borrow(terms, { budget: 50_000_000n, principal: 20_000_000n, days: 30, unlockDays: 30 })).rejects.toThrow(/loan slot #3 does not exist/);
    await expect(bank.borrow(terms, { principal: 20_000_000n, days: 30, unlockDays: 30 })).rejects.toThrow(/loan slot #3 does not exist/);
    await expect(bank.borrow(terms, { days: 30, unlockDays: 30 })).rejects.toThrow(/give a budget or a principal/);
    expect(grant).not.toHaveBeenCalled();
  });

  it('checkCluster refuses mainnet with localnet ids and other clusters with the mainnet ids', () => {
    const cfg = configFromEnv({});
    expect(isMainnetConfig(cfg)).toBe(true);
    expect(() => checkCluster(cfg, MAINNET_GENESIS)).not.toThrow();
    expect(() => checkCluster(cfg, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')).toThrow(/not mainnet-beta .* mainnet ones/);
    const local = configFromEnv({ H081_POOL_PROGRAM_ID: 'AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3' });
    expect(() => checkCluster(local, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')).toThrow(/localnet program id/);
    expect(() => checkCluster({ ...local, usdgMint: Keypair.generate().publicKey }, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')).not.toThrow();
    expect(() => configFromEnv({ H081_POOL_PROGRAM_ID: 'nope' })).toThrow(/not a Solana public key/);
    expect(configFromEnv({ H081_RELAYER_URL: '' }).relayerUrl).toBeUndefined();
    expect(configFromEnv({}).relayerUrl).toBe(MAINNET.relayer);
    expect(configFromEnv({}).rpcUrl).toBe('https://api.mainnet-beta.solana.com');
    expect(configFromEnv({ H081_MAX_DEPOSIT: '5000000' }).maxDeposit).toBe(5_000_000n);
  });

  it('H081Bank.open refuses a cluster mismatch before anything else', async () => {
    const signer = Keypair.generate();
    const conn = fakeConnection(signer, { genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' });
    await expect(H081Bank.open({ config: testConfig(), signer, accountSk: 1n, connection: conn as unknown as Connection, prover: noProver, cacheDir: null })).rejects.toThrow(/not mainnet-beta/);
  });
});
