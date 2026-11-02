// A Model Context Protocol server over stdio that gives an agent its stipend:
// balances and allowances (as the wallet itself sees them), pay, disclosure
// proofs, disclosure verification and x402 fetch. Implements the JSON-RPC 2.0
// methods MCP needs for tools (initialize, ping, tools/list, tools/call) with
// newline-delimited messages, without an SDK dependency. See docs/MCP.md.
//
// The server holds the agent's spending key. It cannot spend past the
// allowance's policy: every payment is a spend proof the pool verifies, and a
// payment the policy forbids has no valid proof.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { hexlify } from 'ethers';
import { type OwnedAllowance, type Relay, type StipendAddress, type Wallet, fieldToAddress, verifyDisclosure } from './client.js';
import { fromHex } from './encryption.js';
import type { DisclosureKind } from './inputs.js';
import type { ProofResult, SolidityProof } from './prover.js';
import { x402Fetch } from './x402.js';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface StipendToolContext {
  wallet: Wallet;
  /** chain id of the pool, for x402 network matching */
  chainId: bigint | number;
  /** who submits the agent's transactions and the fee it takes from public payouts; set by the operator, not the model */
  relay?: Relay;
  /** a ceiling per x402 request on top of the policy (the policy still binds; this only lowers it) */
  maxX402Amount?: bigint;
  fetch?: typeof fetch;
}

const POLICY_NOTE =
  'Spending is bounded by the allowance policy the owner set (lifetime cap, window cap, per-payment cap, expiry, ' +
  'recipient allow-list, stream rate): the pool accepts a payment only with a zero-knowledge spend proof, and a ' +
  'payment that breaks the policy has no valid proof, whatever this tool is asked to do.';

const KINDS: DisclosureKind[] = ['remainingAtLeast', 'spentAtMost', 'windowSpentAtMost'];
const uint = { type: 'string', pattern: '^(0x[0-9a-fA-F]+|[0-9]+)$' };

/** The five stipend tools, bound to one wallet. Handlers return plain JSON (bigints as decimal strings). */
export function stipendTools(ctx: StipendToolContext): McpTool[] {
  const w = ctx.wallet;
  return [
    {
      name: 'stipend_balance',
      description:
        'Shielded balances and allowances as this wallet sees them (owner-visible: nothing here is public on chain). ' +
        'Lists allowances this key can spend as the agent, with remaining budget, window state and policy, and ' +
        'allowances it granted as the owner. ' + POLICY_NOTE,
      inputSchema: { type: 'object', properties: { asset: { type: 'string', description: 'token address; omit for all' } }, additionalProperties: false },
      handler: async (args) => {
        await w.sync();
        const asset = args.asset === undefined ? undefined : BigInt(String(args.asset));
        const assets = new Set<bigint>([...w.notes.values()].filter((n) => !n.spent).map((n) => n.note.asset));
        const live = (list: OwnedAllowance[]) => list.filter((a) => asset === undefined || a.allowance.asset === asset).map(allowanceView);
        return {
          address: { pk: w.account.address.pk, viewPub: hexlify(w.account.address.viewPub) },
          notes: [...assets].filter((a) => asset === undefined || a === asset).map((a) => ({ asset: fieldToAddress(a), balance: w.balance(a) })),
          agentAllowances: live(w.agentAllowances()),
          grantedAllowances: live(w.grantedAllowances()),
        };
      },
    },
    {
      name: 'stipend_pay',
      description:
        'Pay from an allowance. `to` is a public address (the chain sees the amount, asset and recipient, never the payer) ' +
        'or a shielded stipend address {pk, viewPub} (the chain sees neither). The relayer fee, if any, comes out of a public payout. ' +
        POLICY_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          amount: { ...uint, description: 'gross amount in base units' },
          to: {
            description: '0x address, or {pk, viewPub} for a shielded payout',
            oneOf: [{ type: 'string' }, { type: 'object', properties: { pk: uint, viewPub: { type: 'string' } }, required: ['pk', 'viewPub'] }],
          },
          allowance: { ...uint, description: 'allowance id (its commitment) from stipend_balance; optional when one allowance fits' },
          asset: { type: 'string', description: 'token address, to pick the allowance' },
        },
        required: ['amount', 'to'],
        additionalProperties: false,
      },
      handler: async (args) => {
        await w.sync();
        const owned = pickAllowance(w, args);
        const amount = BigInt(String(args.amount));
        const to = recipientOf(args.to);
        const res = await w.pay(owned, amount, to, typeof to === 'string' ? (ctx.relay ?? {}) : {});
        return { transaction: res.receipt.hash, amount, remaining: res.next.remaining, windowSpent: res.next.windowSpent };
      },
    },
    {
      name: 'stipend_prove',
      description:
        'Prove a statement about an allowance without revealing its figures: remainingAtLeast (at least `bound` left), ' +
        'spentAtMost (spent at most `bound`), windowSpentAtMost (at most `bound` spent in the current window). ' +
        '`audience` binds the proof to one verifier. Public: the statement, the bound, the window id, the agent key, the audience.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS },
          bound: uint,
          audience: { ...uint, description: 'a field element naming the verifier' },
          allowance: uint,
          asset: { type: 'string' },
        },
        required: ['kind', 'bound', 'audience'],
        additionalProperties: false,
      },
      handler: async (args) => {
        await w.sync();
        const kind = String(args.kind) as DisclosureKind;
        if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
        const owned = pickAllowance(w, args);
        const { proof, args: pub } = await w.prove(owned, kind, BigInt(String(args.bound)), BigInt(String(args.audience)));
        return { kind, proof: proof.proof, args: pub };
      },
    },
    {
      name: 'stipend_verify_disclosure',
      description: 'Check a disclosure proof (from stipend_prove, or anyone else) against the pool. Read-only; returns {valid}.',
      inputSchema: {
        type: 'object',
        properties: {
          proof: { type: 'object', description: '{a, b, c} as stipend_prove returns it' },
          args: { type: 'object', description: '{root, kind, bound, windowId, agentPk, audience}' },
        },
        required: ['proof', 'args'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const p = args.proof as { a: unknown[]; b: unknown[][]; c: unknown[] };
        const big = (x: unknown) => BigInt(String(x));
        const proof: SolidityProof = {
          a: [big(p.a[0]), big(p.a[1])], b: [[big(p.b[0][0]), big(p.b[0][1])], [big(p.b[1][0]), big(p.b[1][1])]], c: [big(p.c[0]), big(p.c[1])],
        };
        const a = args.args as Record<string, unknown>;
        const pub: Record<string, bigint> = {};
        for (const k of ['root', 'kind', 'bound', 'windowId', 'agentPk', 'audience']) pub[k] = big(a[k]);
        const valid = await verifyDisclosure(w.pool, { proof } as ProofResult, pub);
        return { valid };
      },
    },
    {
      name: 'stipend_x402_fetch',
      description:
        'HTTP request that pays an x402 "402 Payment Required" response from the allowance (scheme stipend-shielded) and ' +
        'retries once with the payment header. The vendor learns the payout, not the payer. `maxAmount` caps the gross ' +
        'payment for this request. ' + POLICY_NOTE,
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: { type: 'string' },
          maxAmount: uint,
        },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const asked = args.maxAmount === undefined ? undefined : BigInt(String(args.maxAmount));
        const cap = ctx.maxX402Amount;
        const maxAmount = asked === undefined ? cap : cap === undefined ? asked : asked < cap ? asked : cap;
        const init: RequestInit = { method: args.method ? String(args.method) : 'GET', headers: (args.headers ?? {}) as Record<string, string> };
        if (args.body !== undefined) init.body = String(args.body);
        const r = await x402Fetch(w, String(args.url), init, { chainId: ctx.chainId, relay: ctx.relay, maxAmount, fetch: ctx.fetch });
        const text = await r.response.text();
        return {
          status: r.response.status,
          contentType: r.response.headers.get('content-type'),
          body: text.length > 100_000 ? text.slice(0, 100_000) : text,
          truncated: text.length > 100_000,
          payment: r.payment
            ? { transaction: r.payment.tx.receipt.hash, gross: r.payment.gross, amount: r.payment.requirement.amount, asset: r.payment.requirement.asset, payTo: r.payment.requirement.payTo }
            : undefined,
          settlement: r.settlement,
        };
      },
    },
  ];
}

function allowanceView(a: OwnedAllowance) {
  const x = a.allowance;
  const P = x.policy;
  return {
    id: a.commitment,
    asset: fieldToAddress(x.asset),
    remaining: x.remaining,
    spent: P.lifetimeCap - x.remaining,
    windowId: x.windowId,
    windowSpent: x.windowSpent,
    policy: {
      lifetimeCap: P.lifetimeCap, windowCap: P.windowCap, windowLen: P.windowLen, maxPerTx: P.maxPerTx, expiry: P.expiry,
      allowList: P.recipientRoot !== 0n, streamRate: P.streamRate, streamStart: P.streamStart, pledgeBps: P.pledgeBps, pledgePaid: x.pledgePaid,
    },
  };
}

function pickAllowance(w: Wallet, args: Record<string, unknown>): OwnedAllowance {
  if (args.allowance !== undefined) {
    const id = BigInt(String(args.allowance));
    const a = w.allowances.get(id);
    if (!a || a.spent) throw new Error('unknown or spent allowance');
    if (a.allowance.agentPk !== w.account.keys.pk) throw new Error('this key is not the agent of that allowance');
    return a;
  }
  const asset = args.asset === undefined ? undefined : BigInt(String(args.asset));
  const live = w.agentAllowances(asset).filter((a) => a.allowance.remaining > 0n);
  if (live.length !== 1) throw new Error(`${live.length} live allowances match; pass "allowance" (an id from stipend_balance)`);
  return live[0];
}

function recipientOf(to: unknown): string | StipendAddress {
  if (typeof to === 'string') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('`to` must be a 0x address or {pk, viewPub}');
    return to;
  }
  const o = to as { pk?: unknown; viewPub?: unknown };
  if (o?.pk === undefined || typeof o.viewPub !== 'string') throw new Error('`to` must be a 0x address or {pk, viewPub}');
  return { pk: BigInt(String(o.pk)), viewPub: fromHex(o.viewPub) };
}

/** JSON with bigints as decimal strings and byte arrays as hex. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hexlify(v) : v));
}

// ------------------------------------------------------------------ JSON-RPC

type Id = string | number | null;
interface JsonRpcRequest { jsonrpc: '2.0'; id?: Id; method: string; params?: Record<string, unknown> }
interface JsonRpcResponse { jsonrpc: '2.0'; id: Id; result?: unknown; error?: { code: number; message: string; data?: unknown } }

export class McpServer {
  private readonly byName: Map<string, McpTool>;

  constructor(readonly tools: McpTool[], readonly info: { name: string; version: string } = { name: 'stipend', version: '0.1.0' }) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  /** Handles one message; returns the response, or undefined for a notification. */
  async handle(msg: unknown): Promise<JsonRpcResponse | undefined> {
    const req = msg as JsonRpcRequest;
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id: (req as { id?: Id })?.id ?? null, error: { code: -32600, message: 'invalid request' } };
    }
    const isNotification = req.id === undefined;
    const reply = (result: unknown): JsonRpcResponse | undefined => (isNotification ? undefined : { jsonrpc: '2.0', id: req.id!, result });
    const fail = (code: number, message: string): JsonRpcResponse | undefined => (isNotification ? undefined : { jsonrpc: '2.0', id: req.id!, error: { code, message } });
    switch (req.method) {
      case 'initialize': {
        const asked = String(req.params?.protocolVersion ?? '');
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
          instructions: 'Stipend wallet tools. ' + POLICY_NOTE,
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const tool = this.byName.get(name);
        if (!tool) return fail(-32602, `unknown tool: ${name}`);
        try {
          const out = await tool.handler((req.params?.arguments ?? {}) as Record<string, unknown>);
          const text = toJson(out);
          return reply({ content: [{ type: 'text', text }], structuredContent: JSON.parse(text), isError: false });
        } catch (e) {
          // a tool failure (a refused proof, a bad argument) is a result the model can read, not a protocol error
          return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
        }
      }
      default:
        if (req.method.startsWith('notifications/')) return undefined;
        return fail(-32601, `method not found: ${req.method}`);
    }
  }

  /**
   * Serves newline-delimited JSON-RPC on the streams (stdin/stdout by default) until input ends. Messages are
   * handled one at a time: two payments from one allowance must not race for the same note.
   */
  serveStdio(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let queue: Promise<void> = Promise.resolve();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      queue = queue.then(async () => {
        let msg: unknown;
        try { msg = JSON.parse(line); } catch {
          output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
          return;
        }
        const batch = Array.isArray(msg) ? msg : [msg];
        const replies: JsonRpcResponse[] = [];
        for (const m of batch) { const r = await this.handle(m); if (r) replies.push(r); }
        if (replies.length) output.write(toJson(Array.isArray(msg) ? replies : replies[0]) + '\n');
      });
    });
    return new Promise((resolve) => rl.on('close', () => { void queue.then(() => resolve()); }));
  }
}

