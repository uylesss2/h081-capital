// The agent-facing layer end to end on an in-process EVM with real Groth16 proofs: an x402 vendor (a real HTTP
// server on 127.0.0.1) paid from allowances through Wallet.pay, its on-chain verifier, and the MCP tool handlers
// and JSON-RPC server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserProvider, Contract, ContractFactory, JsonRpcSigner, hexlify, randomBytes } from 'ethers';
import { createServer, type Server } from 'node:http';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Account, Wallet, deployPool, type OwnedAllowance } from '../../src/client.js';
import { initCrypto, addressToField, lenderShare, type Allowance } from '../../src/crypto.js';
import { randomViewingKey } from '../../src/encryption.js';
import {
  StipendX402Vendor, X402_HEADERS, X402_SCHEME, decodeHeader, encodeHeader, grossFor, payRequirement, stipendRequirements, x402Fetch, x402Tag,
  type PaymentPayload, type PaymentRequired,
} from '../../src/x402.js';
import { McpServer, stipendTools } from '../../src/mcp.js';

const U = 1_000_000n;

let provider: BrowserProvider;
let deployer: JsonRpcSigner;
let relayerSigner: JsonRpcSigner;
let vendorSigner: JsonRpcSigner;
let lenderSigner: JsonRpcSigner;
let pool: Contract;
let token: Contract;
let tokenAddr: string;
let asset: bigint;
let chainId: bigint;
let owner: Wallet;
let agent: Wallet;    // unpledged: maxPerTx 50, window 200 per day
let pledged: Wallet;  // 25% pledged to an EOA lender
let vendor: StipendX402Vendor;
let vendorAddr: string;
let relayer: string;
let lenderAddr: string;
let server: Server;
let base: string;
let served = 0;

/** A vendor that charges `price` for /v2/* (v2 headers) and /v1/* (v1 body and X-PAYMENT). */
let price = 10n * U;
function startVendor(): Promise<void> {
  server = createServer(async (req, res) => {
    const version = req.url!.startsWith('/v1/') ? 1 : 2;
    const resource = { url: `${base}${req.url}`, description: 'market data', mimeType: 'application/json' };
    const payment = StipendX402Vendor.paymentFrom(req.headers as Record<string, string>);
    if (!payment) {
      const r = await vendor.paymentRequired({ asset: tokenAddr, payTo: vendorAddr, amount: price, resource }, version);
      res.writeHead(r.status, r.headers).end(r.body);
      return;
    }
    const s = await vendor.settle(payment);
    const header = version === 1 ? X402_HEADERS.v1.response : X402_HEADERS.v2.response;
    if (!s.success) {
      const r = await vendor.paymentRequired({ asset: tokenAddr, payTo: vendorAddr, amount: price, resource }, version);
      res.writeHead(402, { ...r.headers, [header]: encodeHeader(s) }).end(r.body);
      return;
    }
    served++;
    res.writeHead(200, { 'content-type': 'application/json', [header]: encodeHeader(s) }).end(JSON.stringify({ price: 'AAPL 231.40' }));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    ok();
  }));
}

const live = (w: Wallet): OwnedAllowance => {
  const list = w.agentAllowances(asset).filter((a) => a.allowance.remaining > 0n);
  if (list.length !== 1) throw new Error(`expected one live allowance, got ${list.length}`);
  return list[0];
};

beforeAll(async () => {
  await initCrypto();
  const hre = (await import('hardhat')).default as unknown as { network: { provider: unknown } };
  provider = new BrowserProvider(hre.network.provider as never);
  [deployer, relayerSigner, vendorSigner, lenderSigner] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  chainId = (await provider.getNetwork()).chainId;
  ({ pool } = await deployPool(deployer));
  const erc = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../build/artifacts/contracts/test/TestERC20.sol/TestERC20.json'), 'utf8'));
  token = (await new ContractFactory(erc.abi, erc.bytecode, deployer).deploy()) as unknown as Contract;
  await token.waitForDeployment();
  tokenAddr = await token.getAddress();
  asset = addressToField(tokenAddr);
  await (await token.mint(await deployer.getAddress(), 10_000n * U)).wait();
  await (await token.approve(await pool.getAddress(), 10_000n * U)).wait();
  [vendorAddr, relayer, lenderAddr] = await Promise.all([vendorSigner.getAddress(), relayerSigner.getAddress(), lenderSigner.getAddress()]);

  owner = new Wallet(Account.random(), pool.connect(deployer) as Contract);
  const viaRelayer = pool.connect(relayerSigner) as Contract;
  agent = new Wallet(Account.random(), viaRelayer);
  pledged = new Wallet(Account.random(), viaRelayer);
  await owner.deposit(asset, 2_000n * U);
  await owner.grant(asset, [
    { to: agent.account.address, amount: 1_000n * U, maxPerTx: 50n * U, windowCap: 200n * U },
    { to: pledged.account.address, amount: 100n * U, pledge: { lenderAddr, loanRef: 1n, pledgeBps: 2500n, lenderViewPub: randomViewingKey().pub } },
  ]);
  await Promise.all([agent.sync(), pledged.sync()]);

  // the vendor reads the chain only: no key, no signer
  vendor = new StipendX402Vendor(pool.connect(provider) as Contract, chainId);
  await startVendor();
});

afterAll(() => new Promise<void>((ok) => (server ? server.close(() => ok()) : ok())));

describe('x402 adapter', () => {
  it('grossFor: the smallest gross whose payout covers the price after the lender share and the fee', () => {
    const a = (bps: bigint, paid = 0n): Allowance => ({
      asset, remaining: 1_000n * U, agentPk: 1n, windowId: 0n, windowSpent: 0n, rho: 1n, pledgePaid: paid,
      policy: { lifetimeCap: 1_000n * U, windowCap: 0n, windowLen: 86400n, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: 2n, streamRate: 0n, streamStart: 0n, lender: 0n, pledgeBps: bps },
    });
    expect(grossFor(a(0n), 10n * U, 1n * U)).toBe(11n * U);
    for (const bps of [1n, 2500n, 3333n, 9999n]) {
      for (const net of [1n, 7n, 10n * U + 3n]) {
        const al = a(bps);
        const g = grossFor(al, net, 5n);
        expect(g - lenderShare(al, g) - 5n).toBeGreaterThanOrEqual(net);
        expect(g - 1n - lenderShare(al, g - 1n) - 5n).toBeLessThan(net);
      }
    }
    // the lifetime share is exhausted: nothing more goes to the lender
    const done = a(2500n, 250n * U);
    expect(grossFor(done, 10n * U)).toBe(10n * U);
    expect(() => grossFor(a(10000n), 1n)).toThrow(/fully pledged/);
  });

  it('pays a v2 402 from the allowance and gets the resource; the vendor learns the payout, not the payer', async () => {
    const before = await token.balanceOf(vendorAddr);
    const r = await x402Fetch(agent, `${base}/v2/quote`, {}, { chainId });
    expect(r.response.status).toBe(200);
    expect(await r.response.json()).toEqual({ price: 'AAPL 231.40' });
    expect(await token.balanceOf(vendorAddr)).toBe(before + 10n * U);
    expect(r.settlement).toMatchObject({ success: true, network: `eip155:${chainId}`, amount: (10n * U).toString(), transaction: r.payment!.tx.receipt.hash });
    expect(r.settlement!.payer).toBeUndefined();
    expect(r.payment!.payload.x402Version).toBe(2);
    expect(r.payment!.payload.accepted!.scheme).toBe(X402_SCHEME);
    // the transaction came from the relayer, and nothing in it names the agent or the allowance
    const tx = await provider.getTransaction(r.payment!.tx.receipt.hash);
    expect(tx!.from.toLowerCase()).toBe(relayer.toLowerCase());
    const pk = agent.account.keys.pk.toString(16);
    expect(tx!.data.toLowerCase()).not.toContain(pk);
    expect(live(agent).allowance.remaining).toBe(990n * U);
  });

  it('pays a v1 402 (requirements in the body, X-PAYMENT header)', async () => {
    const r = await x402Fetch(agent, `${base}/v1/quote`, {}, { chainId });
    expect(r.response.status).toBe(200);
    expect(r.payment!.header.name).toBe(X402_HEADERS.v1.payment);
    expect(r.payment!.payload).toMatchObject({ x402Version: 1, scheme: X402_SCHEME, network: `eip155:${chainId}` });
    expect(r.settlement!.success).toBe(true);
  });

  it('a payment settles one request once: a replayed header is refused', async () => {
    const r = await x402Fetch(agent, `${base}/v2/quote`, {}, { chainId });
    expect(r.response.status).toBe(200);
    const servedBefore = served;
    const again = await fetch(`${base}/v2/quote`, { headers: { [r.payment!.header.name]: r.payment!.header.value } });
    expect(again.status).toBe(402);
    expect(decodeHeader<{ success: boolean; errorReason: string }>(again.headers.get(X402_HEADERS.v2.response)!))
      .toMatchObject({ success: false, errorReason: 'invalid_transaction_state' });
    expect(served).toBe(servedBefore);
  });

  it('only the payer can claim a payout: the tag needs the secret, and binds the nonce', async () => {
    const req = await vendor.requirement({ asset: tokenAddr, payTo: vendorAddr, amount: 10n * U, resource: { url: 'x' } });
    const [parsed] = stipendRequirements({ x402Version: 2, accepts: [req] });
    const paid = await payRequirement(agent, parsed);
    const wrongSecret: PaymentPayload = { ...paid.payload, payload: { ...paid.payload.payload, secret: hexlify(randomBytes(32)) } };
    expect(await vendor.verify(wrongSecret)).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
    // an observer of the chain asks for its own request and presents the agent's transaction
    const theirs = await vendor.requirement({ asset: tokenAddr, payTo: vendorAddr, amount: 10n * U, resource: { url: 'x' } });
    const nonce = (theirs.extra as { nonce: string }).nonce;
    const stolen: PaymentPayload = { x402Version: 2, accepted: theirs, payload: { transaction: paid.tx.receipt.hash, nonce, secret: hexlify(randomBytes(32)) } };
    expect(await vendor.verify(stolen)).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
    // the payer's own header is good
    expect(await vendor.verify(paid.payload)).toMatchObject({ isValid: true });
    expect((await vendor.settle(paid.payload)).success).toBe(true);
    expect((await vendor.settle(paid.payload)).success).toBe(false);
  });

  it('refuses a payout below the price, to another address, or never issued', async () => {
    const req = await vendor.requirement({ asset: tokenAddr, payTo: vendorAddr, amount: 10n * U, resource: { url: 'x' } });
    const nonce = (req.extra as { nonce: string }).nonce;
    const secret = hexlify(randomBytes(32));
    const short = await agent.pay(live(agent), 5n * U, vendorAddr, {}, { paymentTag: x402Tag(nonce, secret) });
    expect(await vendor.verify({ x402Version: 2, accepted: req, payload: { transaction: short.receipt.hash, nonce, secret } }))
      .toMatchObject({ isValid: false, invalidReason: 'insufficient_funds' });

    const req2 = await vendor.requirement({ asset: tokenAddr, payTo: vendorAddr, amount: 1n * U, resource: { url: 'x' } });
    const n2 = (req2.extra as { nonce: string }).nonce;
    const elsewhere = await agent.pay(live(agent), 1n * U, lenderAddr, {}, { paymentTag: x402Tag(n2, secret) });
    expect((await vendor.verify({ x402Version: 2, accepted: req2, payload: { transaction: elsewhere.receipt.hash, nonce: n2, secret } })).isValid).toBe(false);

    const unknown = hexlify(randomBytes(32));
    expect(await vendor.verify({ x402Version: 2, accepted: { ...req, extra: { ...req.extra, nonce: unknown } }, payload: { transaction: short.receipt.hash, nonce: unknown, secret } }))
      .toMatchObject({ isValid: false, invalidReason: 'invalid_payment_requirements' });
    // a tampered accepted amount does not match what was issued
    expect(await vendor.verify({ x402Version: 2, accepted: { ...req, amount: '1' }, payload: { transaction: short.receipt.hash, nonce, secret } }))
      .toMatchObject({ isValid: false, invalidReason: 'invalid_payment_requirements' });
  });

  it('a relayer fee comes out of the gross: the vendor still receives the full price', async () => {
    const before = await Promise.all([token.balanceOf(vendorAddr), token.balanceOf(relayer)]);
    const r = await x402Fetch(agent, `${base}/v2/quote`, {}, { chainId, relay: { relayer, fee: 1n * U } });
    expect(r.response.status).toBe(200);
    expect(r.payment!.gross).toBe(11n * U);
    expect(await token.balanceOf(vendorAddr)).toBe(before[0] + 10n * U);
    expect(await token.balanceOf(relayer)).toBe(before[1] + 1n * U);
  });

  it('a pledged allowance grosses up so the vendor gets the price and the lender its share', async () => {
    const before = await Promise.all([token.balanceOf(vendorAddr), token.balanceOf(lenderAddr)]);
    const r = await x402Fetch(pledged, `${base}/v2/quote`, {}, { chainId });
    expect(r.response.status).toBe(200);
    const gross = r.payment!.gross;
    expect(gross).toBe(grossFor({ ...live(pledged).allowance, pledgePaid: 0n }, 10n * U));
    const share = (gross * 2500n) / 10000n;
    expect(await token.balanceOf(vendorAddr)).toBe(before[0] + gross - share);
    expect(gross - share).toBeGreaterThanOrEqual(10n * U);
    expect(await token.balanceOf(lenderAddr)).toBe(before[1] + share);
  });

  it('the policy binds: a price above the per-payment cap has no valid proof, and the vendor is not paid', async () => {
    const before = await token.balanceOf(vendorAddr);
    price = 60n * U; // maxPerTx is 50
    try {
      await expect(x402Fetch(agent, `${base}/v2/quote`, {}, { chainId })).rejects.toThrow();
    } finally {
      price = 10n * U;
    }
    expect(await token.balanceOf(vendorAddr)).toBe(before);
  });

  it('a client ceiling refuses before any proof', async () => {
    await expect(x402Fetch(agent, `${base}/v2/quote`, {}, { chainId, maxAmount: 5n * U })).rejects.toThrow(/ceiling/);
  });

  it('ignores a 402 for another network', async () => {
    const pr: PaymentRequired = {
      x402Version: 2,
      accepts: [{ scheme: X402_SCHEME, network: 'eip155:1', amount: '1', asset: tokenAddr, payTo: vendorAddr, maxTimeoutSeconds: 60, extra: { pool: await pool.getAddress(), nonce: hexlify(randomBytes(32)) } }],
    };
    const fake = async () => new Response('{}', { status: 402, headers: { [X402_HEADERS.v2.required]: encodeHeader(pr) } });
    await expect(x402Fetch(agent, 'http://vendor.example/x', {}, { chainId, fetch: fake as typeof fetch })).rejects.toThrow(/no stipend-shielded requirement/);
  });
});

describe('MCP server', () => {
  let mcp: McpServer;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    return r!.result as { isError: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
  };

  beforeAll(() => {
    mcp = new McpServer(stipendTools({ wallet: agent, chainId, relay: { relayer, fee: 0n }, maxX402Amount: 20n * U }));
  });

  it('initializes and lists five tools that say the policy bounds spending', async () => {
    const init = await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(init!.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stipend' } });
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))!.result as { tools: Array<{ name: string; description: string; inputSchema: object }> };
    expect(list.tools.map((t) => t.name)).toEqual(['stipend_balance', 'stipend_pay', 'stipend_prove', 'stipend_verify_disclosure', 'stipend_x402_fetch']);
    for (const n of ['stipend_balance', 'stipend_pay', 'stipend_x402_fetch']) {
      expect(list.tools.find((t) => t.name === n)!.description).toMatch(/no valid proof/);
    }
    expect((await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' }))!.error!.code).toBe(-32601);
    expect((await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }))!.error!.code).toBe(-32602);
  });

  it('stipend_balance shows the allowance as the agent sees it', async () => {
    const r = await call('stipend_balance', {});
    expect(r.isError).toBe(false);
    const out = r.structuredContent as { agentAllowances: Array<{ id: string; remaining: string; policy: { maxPerTx: string } }> };
    expect(out.agentAllowances).toHaveLength(1);
    expect(out.agentAllowances[0].remaining).toBe(live(agent).allowance.remaining.toString());
    expect(out.agentAllowances[0].policy.maxPerTx).toBe((50n * U).toString());
  });

  it('stipend_pay pays within the policy and returns a tool error past it', async () => {
    const before = await token.balanceOf(vendorAddr);
    const left = live(agent).allowance.remaining;
    const ok = await call('stipend_pay', { amount: (20n * U).toString(), to: vendorAddr, allowance: live(agent).commitment.toString() });
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent).toMatchObject({ remaining: (left - 20n * U).toString() });
    expect(await token.balanceOf(vendorAddr)).toBe(before + 20n * U);
    const over = await call('stipend_pay', { amount: (51n * U).toString(), to: vendorAddr });
    expect(over.isError).toBe(true);
    expect(await token.balanceOf(vendorAddr)).toBe(before + 20n * U);
    const bad = await call('stipend_pay', { amount: '1', to: 'not-an-address' });
    expect(bad).toMatchObject({ isError: true });
  });

  it('stipend_prove and stipend_verify_disclosure: a true statement verifies, an altered one does not', async () => {
    const spent = 1_000n * U - live(agent).allowance.remaining;
    const proved = await call('stipend_prove', { kind: 'spentAtMost', bound: (spent + 1n).toString(), audience: '42' });
    expect(proved.isError).toBe(false);
    const { proof, args } = proved.structuredContent as { proof: unknown; args: Record<string, string> };
    expect(args.bound).toBe((spent + 1n).toString());
    expect((await call('stipend_verify_disclosure', { proof, args })).structuredContent).toEqual({ valid: true });
    expect((await call('stipend_verify_disclosure', { proof, args: { ...args, bound: (spent - 1n).toString() } })).structuredContent).toEqual({ valid: false });
    // a false statement has no proof
    expect((await call('stipend_prove', { kind: 'spentAtMost', bound: (spent - 1n).toString(), audience: '42' })).isError).toBe(true);
  });

  it('stipend_x402_fetch pays a 402 and returns the body; the operator ceiling caps it', async () => {
    const r = await call('stipend_x402_fetch', { url: `${base}/v2/quote` });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ status: 200, body: JSON.stringify({ price: 'AAPL 231.40' }), payment: { amount: (10n * U).toString() }, settlement: { success: true } });
    price = 25n * U; // above the operator's 20 ceiling, within the policy
    try {
      const capped = await call('stipend_x402_fetch', { url: `${base}/v2/quote` });
      expect(capped.isError).toBe(true);
      expect(capped.content[0].text).toMatch(/ceiling/);
    } finally {
      price = 10n * U;
    }
  });

  it('serves newline-delimited JSON-RPC over stdio streams', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (d: Buffer) => lines.push(...d.toString().split('\n').filter(Boolean)));
    const done = mcp.serveStdio(input, output);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write('{not json\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stipend_balance', arguments: {} } }) + '\n');
    input.end();
    await done;
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({ id: 1, result: { protocolVersion: '2025-11-25' } });
    expect(msgs[1]).toMatchObject({ id: null, error: { code: -32700 } });
    expect(msgs[2]).toMatchObject({ id: 2, result: { isError: false } });
  });
});
