// Prove solvency in one line, end to end on a private validator (npm run test:solana:solvency; rpc 127.0.0.1:28899):
// real H081Bank instances, real proofs from the build tree, the localnet stipend_pool. Nothing touches a public cluster.
//
//   1. plan then confirm: proveSolvency without confirm sends nothing; with confirm it grants the reserve and proves;
//   2. the asker verifies locally and with ONE simulated transaction whose fee payer's key nobody here holds (CU and
//      size recorded in solana/compute-units-solvency.json); a second verify of the same code is nonce_reused;
//   3. pay never spends the reserve; balance() lists it as `reserve`, not under grantedToOthers;
//   4. a larger request reclaims the smaller reserve and grants a new one;
//   5. a released reserve's proof still verifies until its root is older than the request allows, then stale_root; and
//      a FRESH proof over the released note at the current root verifies (rootAge 0): disclose checks no nullifier, so
//      root recency dates the proof, never the note (pinned so the docs cannot claim otherwise);
//   6. a junk mint with the default caps backs a fake claim: assetSound false; after set_asset_caps(junk, 0, 0) and the
//      vault drained, a claim at that size is asset-sound; after set_default_caps(0, 0) a new vault takes no deposit.
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { Account } from '../../src/account.js';
import { initCrypto } from '../../src/crypto.js';
import { Prover } from '../../src/prover.js';
import { LOCALNET_POOL_PROGRAM_ID, SolanaPool, SolanaWallet, encodeDiscloseArgs, encodeProof, send, setAssetCapsIx, setDefaultCapsIx, vaultPda } from '../../src/solana/index.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, associatedTokenAddress } from '../../src/solana/lender.js';
import { presentationMessage, solvencyAudience } from '../../src/solvency.js';
import { H081Bank } from '../../integrations/core/bank.js';
import { decodeSolvencyRequest, encodeSolvencyCode } from '../../integrations/core/codes.js';
import { MAINNET_GENESIS, configFromEnv } from '../../integrations/core/constants.js';
import { deriveAccountSk, deriveReserveSk } from '../../integrations/core/keys.js';
import type { ProveSolvencyResult, SolvencyPlan, SolvencyRequestResult, SolvencyVerifyResult } from '../../integrations/core/solvency.js';
import { LOCALNET_UPGRADE_AUTHORITY } from './config-authority.js';

const RPC = process.env.STIPEND_SOLVENCY_RPC ?? 'http://127.0.0.1:28899';
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC);
const U = 1_000_000n;
const connection = new Connection(RPC, 'confirmed');
const prover = new Prover();
const CONFIG_AUTH = LOCALNET_UPGRADE_AUTHORITY;

async function airdrop(k: PublicKey, sol = 5) {
  const sig = await connection.requestAirdrop(k, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, 'confirmed');
}
function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
function mintToIx(mint: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint) {
  const data = Buffer.alloc(9); data[0] = 7; data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({ programId: SPL_TOKEN_PROGRAM_ID, keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }], data });
}
async function createMint(authority: Keypair): Promise<PublicKey> {
  const mint = Keypair.generate();
  const data = Buffer.alloc(67); data[0] = 20; data[1] = 6; authority.publicKey.toBuffer().copy(data, 2);
  await send(connection, authority, [
    SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint.publicKey, lamports: await connection.getMinimumBalanceForRentExemption(82), space: 82, programId: SPL_TOKEN_PROGRAM_ID }),
    new TransactionInstruction({ programId: SPL_TOKEN_PROGRAM_ID, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }], data }),
  ], { signers: [mint] });
  return mint.publicKey;
}
async function fund(authority: Keypair, mint: PublicKey, owner: PublicKey, amount: bigint) {
  await send(connection, authority, [createAtaIx(authority.publicKey, owner, mint), mintToIx(mint, associatedTokenAddress(owner, mint), authority.publicKey, amount)]);
}
async function tokenBalance(account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account, 'confirmed');
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}

describe.skipIf(!LOCAL)('prove solvency on localnet (rpc 28899)', () => {
  const mintAuth = Keypair.generate();
  const agentKey = Keypair.generate(); // the prover
  const deskKey = Keypair.generate(); // the asker
  const desk2Key = Keypair.generate(); // a second verifier (its own seen-nonce store)
  const junkKey = Keypair.generate(); // the attacker with a worthless mint
  let usdg: PublicKey;
  let agent: H081Bank, desk: H081Bank, desk2: H081Bank;
  const measured: Record<string, unknown> = {};

  const open = async (signer: Keypair) => H081Bank.open({
    config: configFromEnv({ H081_CLUSTER: 'localnet', H081_RPC_URL: RPC, H081_USDG_MINT: usdg.toBase58(), H081_RELAYER_URL: '' }),
    signer, accountSk: deriveAccountSk(signer), prover, cacheDir: null,
  });
  const ask = (b: H081Bank, minUsdg: bigint, over: { maxRootAge?: number } = {}) => b.solvencyRequest({ min: minUsdg * U, label: 'desk', ...over }) as SolvencyRequestResult;
  const prove = async (request: string, confirm = true) => (await agent.proveSolvency({ request, confirm })) as ProveSolvencyResult;
  const verify = (b: H081Bank, code: string, request: string, o: Partial<Parameters<H081Bank['verifySolvency']>[1]> = {}) => b.verifySolvency(code, { request, ...o }) as Promise<SolvencyVerifyResult>;

  beforeAll(async () => {
    await initCrypto();
    if (await connection.getGenesisHash() === MAINNET_GENESIS) throw new Error('refusing: this RPC is mainnet');
    if (!(await connection.getAccountInfo(LOCALNET_POOL_PROGRAM_ID))?.executable) throw new Error(`stipend_pool is not loaded on ${RPC}`);
    for (const k of [mintAuth, agentKey, deskKey, junkKey, CONFIG_AUTH]) await airdrop(k.publicKey, 10);
    // mainnet-like deposit guard, scaled down: a new vault starts at 10 units total / 10 per deposit
    await new SolanaPool(connection).initialize(CONFIG_AUTH, { maxTotal: 10n * U, maxPerDeposit: 10n * U });
    usdg = await createMint(mintAuth);
    // the USDG vault exists and has room (the owner raises its caps, as on mainnet)
    await new SolanaPool(connection).ensureVault(mintAuth, usdg);
    await send(connection, CONFIG_AUTH, [setAssetCapsIx(LOCALNET_POOL_PROGRAM_ID, CONFIG_AUTH.publicKey, usdg, 1_000_000n * U, 1_000n * U)]);
    await fund(mintAuth, usdg, agentKey.publicKey, 200n * U);
    agent = await open(agentKey);
    desk = await open(deskKey);
    desk2 = await open(desk2Key);
    await agent.deposit(100n * U);
  });

  it('plan, then confirm: one grant sets the reserve aside; the asker verifies locally and with one simulated transaction', async () => {
    const r = ask(desk, 25n);
    expect(r.min).toBe(25n * U);
    const before = (await agent.balance()).shielded;
    const plan = (await agent.proveSolvency({ request: r.code })) as SolvencyPlan;
    expect(plan).toMatchObject({ sent: false, dryRun: true, plan: { topUp: 25n * U } });
    expect((await agent.balance()).shielded).toBe(before); // nothing was sent
    const p = await prove(r.code);
    expect(p.code).toMatch(/^h081-solvency:/);
    expect(p.topUp?.signatures).toHaveLength(1);
    expect(p.bound).toBe(25n * U);
    expect(p.selfCheck).toEqual({ ok: true, assetSound: true });
    // a funded fee payer whose key this test throws away: the check is read-only
    const payer = Keypair.generate().publicKey;
    await airdrop(payer, 1);
    const v = await verify(desk, p.code, r.code, { onChain: 'simulate', feePayer: payer.toBase58() });
    expect(v).toMatchObject({ ok: true, wallet: agentKey.publicKey.toBase58(), bound: 25n * U, assetSound: true, assetFloor: 0n });
    expect(v.rootAge).toBeLessThanOrEqual(1);
    expect(v.onChain).toMatchObject({ mode: 'simulate', ok: true });
    expect(v.onChain!.txBytes!).toBeLessThanOrEqual(1232);
    measured.simulate = { computeUnits: v.onChain!.computeUnits, txBytes: v.onChain!.txBytes, fits: true, feePayerKeyHeld: false };
    expect(await connection.getBalance(payer, 'confirmed')).toBe(LAMPORTS_PER_SOL); // nothing was charged
    expect(await verify(desk, p.code, r.code)).toMatchObject({ ok: false, reason: 'nonce_reused' });
    // the code answers one request only
    const bad = await desk2.verifySolvency(p.code, { request: ask(desk, 50n).code });
    expect(bad).toMatchObject({ ok: false, reason: 'other_request' });
  });

  it('pay never spends the reserve; balance lists it as the reserve', async () => {
    const b = await agent.balance();
    expect(b.reserve).toMatchObject({ remaining: 25n * U });
    expect(b.grantedToOthers).toHaveLength(0);
    expect(b.agentAllowances).toHaveLength(0);
    await expect(agent.pay({ amount: 1n * U, to: Keypair.generate().publicKey, direct: true })).rejects.toThrow(/holds no USDG allowance/);
    expect((await agent.balance()).reserve).toMatchObject({ remaining: 25n * U });
  });

  it('a larger request reclaims the smaller reserve and grants one new reserve', async () => {
    const r = ask(desk, 50n);
    const plan = (await agent.proveSolvency({ request: r.code })) as SolvencyPlan;
    expect(plan.plan.reclaimFirst).toHaveLength(1);
    expect(plan.plan.topUp).toBe(50n * U);
    const p = await prove(r.code);
    expect(p.topUp?.reclaimed).toHaveLength(1);
    expect(p.topUp?.signatures).toHaveLength(2);
    expect((await agent.balance()).reserve).toMatchObject({ remaining: 50n * U });
    expect(await verify(desk, p.code, r.code)).toMatchObject({ ok: true, bound: 50n * U });
    // a smaller request is answered from the same reserve, no top-up
    const small = await prove(ask(desk, 25n).code, false);
    expect(small.topUp).toBeUndefined();
    expect(small.bound).toBe(25n * U);
  });

  it('a released reserve\'s proof verifies until its root is older than the request allows, then stale_root; a fresh proof over the released note still verifies', async () => {
    const r = ask(desk, 50n, { maxRootAge: 2 });
    const p = await prove(r.code, false);
    // the same account in a second wallet object, to keep the reserve note after the bank forgets it
    const aw = new SolanaWallet(new Account(deriveAccountSk(agentKey)), new SolanaPool(connection, LOCALNET_POOL_PROGRAM_ID, prover), agentKey);
    aw.registerMint(usdg);
    await aw.sync();
    const reserveKey = new Account(deriveReserveSk(agentKey));
    const oldNote = aw.grantedAllowances().find((a) => a.allowance.agentPk === reserveKey.keys.pk && a.allowance.remaining === 50n * U)!;
    expect(oldNote).toBeDefined();
    const released = await agent.solvencyReserve({ release: true, confirm: true });
    expect(released).toMatchObject({ sent: true });
    expect((await agent.balance()).reserve).toBeNull();
    // point in time: one operation later the proof still holds (another verifier, its own nonce store)
    expect(await verify(desk2, p.code, r.code)).toMatchObject({ ok: true, rootAge: 1 });
    await agent.deposit(1n * U);
    await agent.deposit(1n * U);
    expect(await verify(desk, p.code, r.code)).toMatchObject({ ok: false, reason: 'stale_root', rootAge: 3 });
    // the limit of disclose (spec section 0 fact 3): the released note is still a leaf of the CURRENT root, so whoever
    // knows its figures proves over it again for a new request, with an empty reserve, and it verifies at rootAge 0
    expect((await agent.balance()).reserve).toBeNull();
    const again = ask(desk, 50n, { maxRootAge: 2 });
    const req = decodeSolvencyRequest(desk.codeContext, again.code);
    const made = await aw.prove(oldNote, 'remainingAtLeast', 50n * U, solvencyAudience(req.digest, agentKey.publicKey.toBytes()));
    const args = encodeDiscloseArgs(made.args);
    const code = encodeSolvencyCode(desk.codeContext, {
      requestDigest: req.digest, proof: encodeProof(made.proof.proof), args, wallet: agentKey.publicKey.toBytes(),
      signature: ed25519.sign(presentationMessage(req.digest, args), agentKey.secretKey.subarray(0, 32)),
    });
    const stale = await verify(desk, code, again.code);
    expect(stale).toMatchObject({ ok: true, rootAge: 0, bound: 50n * U });
    // so the statement and doesNotSay never claim the note is unspent
    expect(stale.statement).toMatch(/may since have been spent or reclaimed/);
    expect(stale.doesNotSay[0]).toMatch(/still proves against the CURRENT root/);
  });

  it('junk mint: the default caps let a worthless asset back a claim (assetSound false); caps 0 and a drained vault fix it; default caps 0 block new vaults', async () => {
    // the attacker: its own mint, the default caps (10 units), a deposit, a self-grant to its reserve key, a disclose proof
    const junk = await createMint(junkKey);
    await fund(junkKey, junk, junkKey.publicKey, 10n * U);
    const pool = new SolanaPool(connection, LOCALNET_POOL_PROGRAM_ID, prover);
    const jw = new SolanaWallet(new Account(deriveAccountSk(junkKey)), pool, junkKey);
    jw.registerMint(junk);
    await jw.deposit(junk, 10n * U);
    const jReserve = new Account(deriveReserveSk(junkKey));
    await jw.grant(junk, [{ to: jReserve.address, amount: 10n * U, windowCap: 0n, windowLen: 86400n, maxPerTx: 0n, expiry: 0n, streamRate: 0n }]);
    await jw.sync();
    const note = jw.grantedAllowances().find((a) => a.allowance.agentPk === jReserve.keys.pk)!;
    expect(note.allowance.remaining).toBe(10n * U);
    const r = ask(desk, 10n);
    const req = decodeSolvencyRequest(desk.codeContext, r.code);
    const made = await jw.prove(note, 'remainingAtLeast', 10n * U, solvencyAudience(req.digest, junkKey.publicKey.toBytes()));
    const args = encodeDiscloseArgs(made.args);
    const code = encodeSolvencyCode(desk.codeContext, {
      requestDigest: req.digest, proof: encodeProof(made.proof.proof), args, wallet: junkKey.publicKey.toBytes(),
      signature: ed25519.sign(presentationMessage(req.digest, args), junkKey.secretKey.subarray(0, 32)),
    });
    const caught = await verify(desk, code, r.code);
    expect(caught).toMatchObject({ ok: false, reason: 'asset_not_bound', assetSound: false, assetFloor: 10n * U });
    // the proof itself is valid (the asset is private in the circuit): accepted only as "SOME asset"
    const some = await verify(desk, code, r.code, { allowUnboundAsset: true, onChain: 'simulate' });
    expect(some).toMatchObject({ ok: true, assetSound: false, onChain: { ok: true } });
    expect(some.statement).toMatch(/SOME asset/);
    // an honest USDG claim at the same size is not asset-sound either while that vault can back it
    const honest = ask(desk, 10n);
    const hp = await prove(honest.code);
    expect(hp.selfCheck).toEqual({ ok: true, assetSound: false });
    expect(await verify(desk, hp.code, honest.code)).toMatchObject({ ok: false, reason: 'asset_not_bound' });

    // the owner's fix for that vault: caps 0 (no deposit fits), and the vault drained (the attacker leaves)
    await send(connection, CONFIG_AUTH, [setAssetCapsIx(LOCALNET_POOL_PROGRAM_ID, CONFIG_AUTH.publicKey, junk, 0n, 0n)]);
    await jw.reclaim(note);
    await jw.sync();
    await jw.withdraw(junk, 10n * U, junkKey.publicKey);
    expect(await tokenBalance(vaultPda(LOCALNET_POOL_PROGRAM_ID, junk))).toBe(0n);
    const after = ask(desk2, 10n);
    const ap = await prove(after.code);
    expect(await verify(desk2, ap.code, after.code)).toMatchObject({ ok: true, assetSound: true, assetFloor: 0n });

    // D1: default caps 0, so a vault anyone creates from now on takes no deposit until the owner sets its caps
    await send(connection, CONFIG_AUTH, [setDefaultCapsIx(LOCALNET_POOL_PROGRAM_ID, CONFIG_AUTH.publicKey, 0n, 0n)]);
    const junk2 = await createMint(junkKey);
    await fund(junkKey, junk2, junkKey.publicKey, 1n * U);
    jw.registerMint(junk2);
    await expect(jw.deposit(junk2, 1n * U)).rejects.toThrow(/DepositTooLarge|DepositCapExceeded|0x1794|0x1795|603[67]/);
    const fresh = ask(desk2, 10n);
    const fp = await prove(fresh.code, false);
    expect(await verify(desk2, fp.code, fresh.code)).toMatchObject({ ok: true, assetSound: true, assetFloor: 0n });
    writeFileSync('solana/compute-units-solvency.json', JSON.stringify({ note: 'test/solana/solvency.test.ts on a private localnet validator; verify_disclosure as ONE simulated transaction (buffer_open, buffer_write 448 B, verify), sigVerify off', ...measured }, null, 2) + '\n');
  });
});
