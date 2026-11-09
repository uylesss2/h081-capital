// The local JSON API (http://127.0.0.1:8081/v1): node:http, no framework. Binds 127.0.0.1 only; checks Host (DNS
// rebinding), Origin (browsers), Content-Type (form posts) and the bearer token on every route except health and the
// OpenAPI document. Every route is in ROUTES, which the OpenAPI document is generated from.
import { randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { CodedError, ERROR_CODES, classify } from '../../core/errors.js';
import { JSON_SCHEMA, type OpName } from '../../core/schemas.js';
import { fromUnits } from '../../core/units.js';
import { BIND_HOST, hostAllowed, originAllowed, tokenMatches } from './auth.js';
import type { AgentEvent } from './events.js';
import { type H081, type Outcome, VERSION } from './h081.js';
import { IDEMPOTENCY_KEY } from './idempotency.js';
import { buildOpenApi } from './openapi.js';

export const API_PREFIX = '/v1';
const MAX_BODY = 64 * 1024;

type Json = Record<string, unknown>;
type Reply = { status: 'done' | 'plan' | 'sent'; result: unknown; replayed?: boolean };

export interface Ctx {
  h: H081;
  body: Json;
  query: URLSearchParams;
  params: Record<string, string>;
  idempotencyKey?: string;
  req: IncomingMessage;
  res: ServerResponse;
}

export interface QueryParam { name: string; required?: boolean; schema: Json; description: string }

export interface RouteDef {
  method: 'GET' | 'POST';
  /** OpenAPI path template, e.g. /v1/allowances/{id}/reclaim */
  path: string;
  auth: boolean;
  /** a write: confirm: true needs an Idempotency-Key */
  write?: boolean;
  summary: string;
  description?: string;
  /** JSON Schema of the request body (POST) */
  body?: Json;
  query?: QueryParam[];
  /** what `result` holds */
  result: string;
  /** a server-sent event stream instead of JSON */
  stream?: boolean;
  handle: (c: Ctx) => Promise<Reply | undefined>;
}

// ---- request helpers

const bad = (m: string) => new CodedError('bad_request', m);

function only(body: Json, allowed: string[]): void {
  const stray = Object.keys(body).filter((k) => !allowed.includes(k));
  if (stray.length) throw bad(`unknown field(s): ${stray.join(', ')} (this route takes ${allowed.join(', ')})`);
}

function confirmOf(body: Json): boolean {
  const c = body.confirm;
  if (c === undefined || c === false) return false;
  if (c === true) return true;
  throw bad('confirm must be true or false');
}

/** `usdg` (decimal) or `amount` (base units), exactly one, as decimal USDG text. */
function usdgOf(src: Json | URLSearchParams, usdgKey = 'usdg', baseKey = 'amount'): string {
  const get = (k: string) => (src instanceof URLSearchParams ? src.get(k) ?? undefined : src[k]);
  const u = get(usdgKey), a = get(baseKey);
  const has = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
  if (has(u) && has(a)) throw bad(`give "${usdgKey}" (decimal) or "${baseKey}" (base units), not both`);
  if (has(a)) {
    if (!/^\d+$/.test(String(a).trim())) throw bad(`"${baseKey}" must be an integer in base units (6 decimals)`);
    return fromUnits(BigInt(String(a).trim()), 6);
  }
  if (!has(u)) throw bad(`give "${usdgKey}" (decimal, e.g. "2.5") or "${baseKey}" (base units)`);
  if (typeof u !== 'string' && typeof u !== 'number') throw bad(`"${usdgKey}" must be a decimal string like "2.5"`);
  return String(u).trim();
}

const optStr = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`${what} must be a string`);
  return String(v);
};
const optNum = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${what} must be a number`);
  return v;
};
const optBool = (v: unknown, what: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw bad(`${what} must be true or false`);
  return v;
};

const wo = (c: Ctx) => ({ confirm: confirmOf(c.body), idempotencyKey: c.idempotencyKey });
const done = (result: unknown): Reply => ({ status: 'done', result });
const out = (o: Outcome): Reply => (o.status === 'sent' ? { status: 'sent', result: o.result, ...(o.replayed ? { replayed: true } : {}) } : { status: o.status, result: o.result });

// ---- JSON Schemas of the bodies (from the operation schemas, so they say the same thing)

const prop = (op: OpName, k: string) => (JSON_SCHEMA[op].properties as Json)[k] as Json;
const confirmJ = { type: 'boolean', description: 'true: send it (needs the Idempotency-Key header). Missing or false: return the plan and send nothing' };
const usdgJ = { ...prop('h081_bank_deposit', 'usdg'), description: 'decimal USDG, e.g. "5.25"' };
const amountJ = { ...prop('h081_bank_deposit', 'amount'), description: 'base units instead of usdg ("5250000" = 5.25 USDG)' };
const codeJ = (what: string) => ({ type: 'string', description: what });
const obj = (properties: Json, required: string[] = [], description?: string): Json => ({
  type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false, ...(description ? { description } : {}),
});

const fresh = (q: URLSearchParams) => { const f = q.get('fresh'); return f === '1' || f === 'true'; };

export const ROUTES: RouteDef[] = [
  {
    method: 'GET', path: '/v1/health', auth: false, summary: 'Liveness', result: '{version, network}',
    handle: async (c) => done({ version: VERSION, network: c.h.network }),
  },
  {
    method: 'GET', path: '/v1/openapi.json', auth: false, summary: 'This document (OpenAPI 3.1)', result: 'the OpenAPI document (not wrapped in the envelope)',
    handle: async () => undefined, // answered raw by the dispatcher
  },
  {
    method: 'GET', path: '/v1/status', auth: true, summary: 'Where things stand (no RPC call)',
    result: '{network, agent, keySource, rpcHost, relayer, circuits:{present, missing}, syncedAt, syncing, queue:{depth}, fundingNeeded}',
    handle: async (c) => done(c.h.status()),
  },
  {
    method: 'GET', path: '/v1/address', auth: true, summary: 'The agent wallet and its h081-address: code (offline)', result: '{wallet, addressCode}',
    handle: async (c) => done(c.h.address()),
  },
  {
    method: 'GET', path: '/v1/balance', auth: true, summary: 'Shielded and wallet balances, caps, allowances',
    description: 'Served from cache when the last sync is under 15 s old; fresh=1 forces a sync.',
    query: [{ name: 'fresh', schema: { type: 'string', enum: ['0', '1'] }, description: '1: sync now' }],
    result: '{shielded, wallet:{usdg, sol}, caps, allowances:[{id, remaining, dailyCap?, expires?, ...}], addressCode, syncedAt}',
    handle: async (c) => done(await c.h.balance({ fresh: fresh(c.query) })),
  },
  {
    method: 'GET', path: '/v1/history', auth: true, summary: 'What this gateway or CLI did (from ops.jsonl), newest first',
    query: [
      { name: 'after', schema: { type: 'string' }, description: 'the `next` cursor of the previous page' },
      { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 }, description: 'items per page' },
    ],
    result: '{items:[{id, time, kind, usdg, signature, state, to?}], next}',
    handle: async (c) => {
      const l = c.query.get('limit');
      if (l !== null && !/^\d+$/.test(l)) throw bad('limit must be an integer 1..200');
      return done(c.h.history({ after: c.query.get('after') ?? undefined, limit: l === null ? undefined : Number(l) }));
    },
  },
  {
    method: 'GET', path: '/v1/fees/withdraw', auth: true, summary: 'The relayer fee for a withdrawal (no proof is made)',
    query: [
      { name: 'usdg', schema: usdgJ, description: 'the amount to withdraw (decimal)' },
      { name: 'amount', schema: amountJ, description: 'or in base units' },
    ],
    result: '{fee, feeBps, minFee, payout, freeTierMax, needsStake, relayer}',
    handle: async (c) => done(await c.h.withdrawFee(usdgOf(c.query))),
  },
  {
    method: 'POST', path: '/v1/deposit', auth: true, write: true, summary: 'Deposit USDG from the agent wallet into the shielded account',
    body: obj({ usdg: usdgJ, amount: amountJ, confirm: confirmJ }, [], 'exactly one of usdg or amount'),
    result: 'plan, or {signature, amount, shielded, ...}',
    handle: async (c) => { only(c.body, ['usdg', 'amount', 'confirm']); return out(await c.h.deposit(usdgOf(c.body), wo(c))); },
  },
  {
    method: 'POST', path: '/v1/withdraw', auth: true, write: true, summary: 'Withdraw USDG to a wallet through the relayer',
    description: '`to` is required: a fresh wallet, or "self" for the agent wallet (the plan then warns that this links the two).',
    body: obj({
      usdg: usdgJ, amount: amountJ,
      to: { type: 'string', description: 'a base58 wallet address, or "self" (the agent wallet)' },
      direct: prop('h081_bank_withdraw', 'direct'), confirm: confirmJ,
    }, ['to'], 'exactly one of usdg or amount'),
    result: 'plan, or {signature, fee, received, via, ...}',
    handle: async (c) => {
      only(c.body, ['usdg', 'amount', 'to', 'direct', 'confirm']);
      const to = optStr(c.body.to, 'to');
      if (to === undefined || to.trim() === '') throw bad('to is required: a fresh wallet address, or "self"');
      return out(await c.h.withdraw(usdgOf(c.body), { ...wo(c), to, direct: optBool(c.body.direct, 'direct') }));
    },
  },
  {
    method: 'POST', path: '/v1/pay', auth: true, write: true, summary: 'Pay from an allowance this agent holds',
    description: 'To a wallet (public payout through the relayer) or to an h081-address: code (private; sent by the agent key).',
    body: obj({
      usdg: usdgJ, amount: amountJ, to: prop('h081_pay', 'to'), toAddressCode: prop('h081_pay', 'toAddressCode'), allowanceId: prop('h081_pay', 'allowanceId'),
      agentIndex: prop('h081_pay', 'agentIndex'), direct: prop('h081_pay', 'direct'), allowPledged: prop('h081_pay', 'allowPledged'), confirm: confirmJ,
    }, [], 'exactly one of usdg or amount, and exactly one of to or toAddressCode'),
    result: 'plan, or {signature, fee, received, via, allowanceId, remaining, ...}',
    handle: async (c) => {
      only(c.body, ['usdg', 'amount', 'to', 'toAddressCode', 'allowanceId', 'agentIndex', 'direct', 'allowPledged', 'confirm']);
      return out(await c.h.pay(usdgOf(c.body), {
        ...wo(c), to: optStr(c.body.to, 'to'), toAddressCode: optStr(c.body.toAddressCode, 'toAddressCode'), allowanceId: optStr(c.body.allowanceId, 'allowanceId'),
        agentIndex: optNum(c.body.agentIndex, 'agentIndex'), direct: optBool(c.body.direct, 'direct'), allowPledged: optBool(c.body.allowPledged, 'allowPledged'),
      }));
    },
  },
  {
    method: 'POST', path: '/v1/transfer', auth: true, write: true, summary: 'Pay from the main shielded balance to an h081-address: code',
    description: 'Note to note: amount and recipient stay hidden. Sent by the agent key, so the agent wallet is visible as a bank user.',
    body: obj({ usdg: usdgJ, amount: amountJ, toAddressCode: prop('h081_transfer', 'toAddressCode'), confirm: confirmJ }, ['toAddressCode'], 'exactly one of usdg or amount'),
    result: 'plan, or {signature, amount, shielded, ...}',
    handle: async (c) => {
      only(c.body, ['usdg', 'amount', 'toAddressCode', 'confirm']);
      const code = optStr(c.body.toAddressCode, 'toAddressCode');
      if (!code) throw bad('toAddressCode is required: the recipient\'s "h081-address:" code');
      return out(await c.h.transfer(usdgOf(c.body), { ...wo(c), toAddressCode: code }));
    },
  },
  {
    method: 'POST', path: '/v1/allowances', auth: true, write: true, summary: 'Give a sub-account or another agent a budget',
    description: 'Needs about 0.1 SOL and the grant circuit (about 51 MB).',
    body: obj({
      budget: { ...usdgJ, description: 'the lifetime budget (decimal USDG)' },
      dailyCap: { ...usdgJ, description: 'most it may pay per day (decimal USDG)' },
      maxPerTx: { ...usdgJ, description: 'most per payment (decimal USDG)' },
      days: prop('h081_allowance_grant', 'days'), unlockDays: prop('h081_allowance_grant', 'unlockDays'),
      agentIndex: prop('h081_allowance_grant', 'agentIndex'), toAddressCode: prop('h081_allowance_grant', 'toAddressCode'), confirm: confirmJ,
    }, ['budget']),
    result: 'plan, or the grant result {signature, allowanceId, rules, ...}',
    handle: async (c) => {
      only(c.body, ['budget', 'dailyCap', 'maxPerTx', 'days', 'unlockDays', 'agentIndex', 'toAddressCode', 'confirm']);
      const budget = optStr(c.body.budget, 'budget');
      if (!budget) throw bad('budget is required (decimal USDG)');
      return out(await c.h.allow(budget, {
        ...wo(c), dailyCap: optStr(c.body.dailyCap, 'dailyCap'), maxPerTx: optStr(c.body.maxPerTx, 'maxPerTx'), days: optNum(c.body.days, 'days'),
        unlockDays: optNum(c.body.unlockDays, 'unlockDays'), agentIndex: optNum(c.body.agentIndex, 'agentIndex'), toAddressCode: optStr(c.body.toAddressCode, 'toAddressCode'),
      }));
    },
  },
  {
    method: 'POST', path: '/v1/allowances/{id}/reclaim', auth: true, write: true, summary: 'Take back what is left of an allowance this account granted',
    body: obj({ confirm: confirmJ }),
    result: 'plan, or the reclaim result {signature, reclaimed, ...}',
    handle: async (c) => { only(c.body, ['confirm']); return out(await c.h.reclaim(c.params.id, wo(c))); },
  },
  {
    method: 'GET', path: '/v1/loans/quote', auth: true, summary: 'Price a loan from a lender\'s terms code (read-only)',
    query: [
      { name: 'termsCode', required: true, schema: { type: 'string' }, description: 'the lender\'s "h081-loan-terms:" code' },
      { name: 'principal', schema: usdgJ, description: 'a principal to price (decimal USDG); default the most it backs' },
    ],
    result: 'the loanQuote result {pledgeBps, maxPrincipal, principal, originationFee, payout, ...}',
    handle: async (c) => done(await c.h.loanQuote(c.query.get('termsCode') ?? '', { principal: c.query.get('principal') ?? undefined })),
  },
  {
    method: 'POST', path: '/v1/loans/borrow', auth: true, write: true, summary: 'Pledge an allowance to a lender\'s terms and get the proof code',
    body: obj({
      termsCode: codeJ('the lender\'s "h081-loan-terms:" code'), days: prop('h081_loan_borrow', 'days'), unlockDays: prop('h081_loan_borrow', 'unlockDays'),
      principal: { ...usdgJ, description: 'the loan amount (decimal USDG); the lender must fund exactly this' },
      budget: { ...usdgJ, description: 'the pledged budget (decimal USDG); default sized to the principal' },
      dailyCap: { ...usdgJ, description: 'most per day (decimal USDG)' }, maxPerTx: { ...usdgJ, description: 'most per payment (decimal USDG)' },
      agentIndex: prop('h081_loan_borrow', 'agentIndex'), confirm: confirmJ,
    }, ['termsCode', 'days', 'unlockDays']),
    result: 'plan, or {proofCode, principal, ...}',
    handle: async (c) => {
      only(c.body, ['termsCode', 'days', 'unlockDays', 'principal', 'budget', 'dailyCap', 'maxPerTx', 'agentIndex', 'confirm']);
      const days = optNum(c.body.days, 'days'), unlockDays = optNum(c.body.unlockDays, 'unlockDays');
      if (days === undefined || unlockDays === undefined) throw bad('days and unlockDays are required');
      return out(await c.h.borrow(optStr(c.body.termsCode, 'termsCode') ?? '', {
        ...wo(c), days, unlockDays, principal: optStr(c.body.principal, 'principal'), budget: optStr(c.body.budget, 'budget'),
        dailyCap: optStr(c.body.dailyCap, 'dailyCap'), maxPerTx: optStr(c.body.maxPerTx, 'maxPerTx'), agentIndex: optNum(c.body.agentIndex, 'agentIndex'),
      }));
    },
  },
  {
    method: 'POST', path: '/v1/loans/lend', auth: true, write: true, summary: 'Lender actions: open, fund, collect, claim, settle',
    description: 'The fields are the h081_lend schema\'s. close answers 501 not_available. Every lender action is sent by the agent key.',
    body: obj({
      action: { type: 'string', enum: ['open', 'fund', 'collect', 'claim', 'settle'] },
      pledgeBps: prop('h081_lend', 'pledgeBps'), proofCode: prop('h081_lend', 'proofCode'), loanRef: prop('h081_lend', 'loanRef'),
      principal: prop('h081_lend', 'principal'), principalUsdg: prop('h081_lend', 'principalUsdg'), amount: prop('h081_lend', 'amount'), usdg: prop('h081_lend', 'usdg'),
      confirm: confirmJ,
    }, ['action']),
    result: 'plan, or the matching lend result',
    handle: async (c) => {
      only(c.body, ['action', 'pledgeBps', 'proofCode', 'loanRef', 'principal', 'principalUsdg', 'amount', 'usdg', 'confirm']);
      const action = optStr(c.body.action, 'action') ?? '';
      if (action === 'status') throw bad('status is a read: GET /v1/loans/lent');
      const { action: _a, confirm: _c, ...fields } = c.body;
      return out(await c.h.lend(action, fields, wo(c)));
    },
  },
  {
    method: 'GET', path: '/v1/loans/lent', auth: true, summary: 'This agent\'s loan slots as a lender',
    query: [{ name: 'loanRef', schema: { type: 'string', pattern: '^\\d+$' }, description: 'one slot; default all of this agent\'s slots' }],
    result: 'the lendStatus result {slots:[...]}',
    handle: async (c) => done(await c.h.lendStatus(c.query.get('loanRef') ?? undefined)),
  },
  {
    method: 'GET', path: '/v1/stake', auth: true, summary: 'The agent wallet\'s H081 stake in capacity_stake', result: 'the stakeView result',
    handle: async (c) => done(await c.h.stakeView()),
  },
  {
    method: 'POST', path: '/v1/stake', auth: true, write: true, summary: 'Stake, request unstake (30-day cooldown) or unstake H081',
    body: obj({ action: { type: 'string', enum: ['stake', 'request_unstake', 'unstake'] }, h081: prop('h081_stake', 'h081'), confirm: confirmJ }, ['action']),
    result: 'plan, or the stake result',
    handle: async (c) => {
      only(c.body, ['action', 'h081', 'confirm']);
      const action = optStr(c.body.action, 'action') ?? '';
      if (action === 'view') throw bad('view is a read: GET /v1/stake');
      return out(await c.h.stake(action, { ...wo(c), h081: optStr(c.body.h081, 'h081') }));
    },
  },
  {
    method: 'POST', path: '/v1/codes/check', auth: true, summary: 'Check any h081-* code: kind, network, valid',
    body: obj({ code: { type: 'string', description: 'an "h081-address:", "h081-loan-terms:", "h081-loan-proof:" or "h081-key:" code' } }, ['code']),
    result: '{kind, network, valid, reason?}',
    handle: async (c) => {
      only(c.body, ['code']);
      const code = optStr(c.body.code, 'code');
      if (!code) throw bad('code is required');
      return done(c.h.checkCode(code));
    },
  },
  {
    method: 'GET', path: '/v1/events', auth: true, stream: true, summary: 'Server-sent events',
    description: 'balance.changed {shielded, wallet, deltaShielded}, allowance.changed {id, remaining}, op.completed {idempotencyKey, kind, signature}, op.failed {idempotencyKey, code}. Resume with Last-Event-ID. A background sync runs every --poll seconds while a client is connected.',
    result: 'text/event-stream',
    handle: async () => undefined, // answered by the dispatcher
  },
];

const compiled = ROUTES.map((r) => {
  const names: string[] = [];
  const re = new RegExp('^' + r.path.replace(/\{(\w+)\}/g, (_m, n: string) => { names.push(n); return '([^/]+)'; }) + '$');
  return { r, re, names };
});

function match(method: string, pathname: string): { route?: RouteDef; params: Record<string, string>; pathKnown: boolean } {
  let pathKnown = false;
  for (const { r, re, names } of compiled) {
    const m = re.exec(pathname);
    if (!m) continue;
    pathKnown = true;
    if (r.method !== method) continue;
    const params: Record<string, string> = {};
    names.forEach((n, i) => {
      try { params[n] = decodeURIComponent(m[i + 1]); } catch { throw bad(`the path segment "${m[i + 1]}" is not valid percent-encoding`); }
    });
    return { route: r, params, pathKnown };
  }
  return { params: {}, pathKnown };
}

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      if (tooBig) return; // read and drop the rest, so the client gets the 400 instead of a reset connection
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; reject(bad(`the body is larger than ${MAX_BODY} bytes`)); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      let v: unknown;
      try { v = JSON.parse(text); } catch { return reject(bad('the body is not valid JSON')); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(bad('the body must be a JSON object'));
      resolve(v as Json);
    });
    req.on('error', reject);
  });
}

export interface ServerOptions {
  h081: H081;
  /** the bearer token (h081 token prints it) */
  token: string;
  /** default H081_API_PORT or 8081; 0 picks a free port (tests) */
  port?: number;
  /** only 127.0.0.1 is accepted; anything else is refused */
  host?: string;
  /** the one browser origin allowed to call (exact match); default none, and no CORS headers are sent */
  allowOrigin?: string;
  log?: (line: string) => void;
}

export interface RunningServer { url: string; port: number; server: Server; close: () => Promise<void> }

/** Starts the gateway on 127.0.0.1. */
export async function startServer(o: ServerOptions): Promise<RunningServer> {
  if (o.host !== undefined && o.host !== BIND_HOST) throw new Error(`the gateway binds ${BIND_HOST} only; ${o.host} is refused`);
  if (!o.token || o.token.length < 16) throw new Error('the API token is missing or too short (h081 token --rotate makes a new one)');
  const h = o.h081;
  const log = o.log ?? h.log;
  const port = o.port ?? Number(h.env.H081_API_PORT?.trim() || 8081);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('the port must be 0..65535');
  let boundPort = port;
  const streams = new Set<ServerResponse>();

  const server = createServer((req, res) => { void handle(req, res); });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const requestId = 'req_' + randomBytes(8).toString('hex');
    const method = (req.method ?? 'GET').toUpperCase();
    let pathname = '/';
    let query = new URLSearchParams();
    try {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      pathname = u.pathname.replace(/\/+$/, '') || '/';
      query = u.searchParams;
    } catch { /* keep defaults */ }
    const origin = req.headers.origin;
    const cors: Record<string, string> = o.allowOrigin && origin === o.allowOrigin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    let code: string | undefined;

    const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      const text = h.redact(JSON.stringify(payload));
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff', ...cors, ...extra });
      res.end(text);
      log(`${method} ${pathname} ${status} ${Date.now() - started}ms ${requestId}${code ? ' ' + code : ''}`);
    };
    const fail = (e: unknown) => {
      const c = classify(e);
      code = c.code;
      const extra: Record<string, string> = {};
      const ra = c.details?.retryAfter;
      if (typeof ra === 'number') extra['retry-after'] = String(ra);
      else if (c.code === 'in_progress') extra['retry-after'] = '5';
      else if (c.code === 'busy') extra['retry-after'] = '5';
      if (c.code === 'internal') log(`internal error ${requestId}: ${h.redact(c.message)}`);
      send(c.status, { ok: false, network: h.network, error: { code: c.code, message: h.redact(c.message), retryable: c.retryable, ...(c.details ? { details: c.details } : {}) }, requestId }, extra);
    };

    try {
      // DNS rebinding: a page on evil.example resolving to 127.0.0.1 still sends Host: evil.example
      if (!hostAllowed(req.headers.host, boundPort)) throw new CodedError('forbidden_origin', 'the Host header must be 127.0.0.1 or localhost with this port');
      if (!originAllowed(origin, o.allowOrigin)) throw new CodedError('forbidden_origin', 'requests from a browser page are refused (start the gateway with --allow-origin <url> to allow one origin)');
      if (method === 'OPTIONS' && o.allowOrigin && origin === o.allowOrigin) {
        res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key, Last-Event-ID', 'access-control-max-age': '600' });
        res.end();
        return;
      }
      const { route, params, pathKnown } = match(method, pathname);
      if (!route) throw new CodedError('not_found', pathKnown ? `${method} is not allowed on ${pathname}` : `no route ${pathname} (GET /v1/openapi.json lists them)`);
      if (route.auth && !tokenMatches(req.headers.authorization, o.token)) throw new CodedError('unauthorized', 'missing or wrong token: send Authorization: Bearer <the token in ~/.h081/api-token>');
      if (route.path === '/v1/openapi.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId, ...cors });
        res.end(JSON.stringify(buildOpenApi(ROUTES), null, 2));
        log(`${method} ${pathname} 200 ${Date.now() - started}ms ${requestId}`);
        return;
      }
      if (route.stream) return stream(req, res, requestId, cors, started);
      let body: Json = {};
      if (method === 'POST') {
        const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/json') throw new CodedError('unsupported_media_type', 'send the body as JSON with Content-Type: application/json');
        body = await readBody(req);
      }
      let idempotencyKey: string | undefined;
      if (route.write) {
        const raw = req.headers['idempotency-key'];
        const k = Array.isArray(raw) ? raw[0] : raw;
        if (k !== undefined && !IDEMPOTENCY_KEY.test(k)) throw new CodedError('idempotency_key_required', 'Idempotency-Key must be 1-128 characters of A-Z a-z 0-9 _ . : -');
        if (body.confirm === true && k === undefined) throw new CodedError('idempotency_key_required', 'a confirmed write needs an Idempotency-Key header, so a retry never sends twice');
        idempotencyKey = k;
      }
      const reply = await route.handle({ h, body, query, params, idempotencyKey, req, res });
      send(200, { ok: true, network: h.network, status: reply!.status, result: reply!.result, ...(reply!.replayed ? { replayed: true } : {}), requestId });
    } catch (e) {
      fail(e);
    }
  }

  function stream(req: IncomingMessage, res: ServerResponse, requestId: string, cors: Record<string, string>, started: number): void {
    const lastRaw = req.headers['last-event-id'];
    const last = Number(Array.isArray(lastRaw) ? lastRaw[0] : lastRaw ?? 0) || 0;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-request-id': requestId, ...cors });
    res.write('retry: 3000\n\n');
    const write = (e: AgentEvent) => { res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${h.redact(JSON.stringify({ ...e.data, time: e.time }))}\n\n`); };
    for (const e of h.events.since(last)) write(e);
    streams.add(res);
    const unsubscribe = h.events.subscribe(write);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    ping.unref?.();
    log(`GET /v1/events stream opened ${requestId}`);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      streams.delete(res);
      log(`GET /v1/events stream closed after ${Date.now() - started}ms ${requestId}`);
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => { server.off('error', reject); resolve(); });
  });
  boundPort = (server.address() as { port: number }).port;
  return {
    url: `http://${BIND_HOST}:${boundPort}${API_PREFIX}`,
    port: boundPort,
    server,
    close: () => new Promise<void>((resolve) => {
      for (const s of streams) s.end();
      h.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

export { ERROR_CODES };
