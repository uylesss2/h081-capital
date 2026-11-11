// Shared setup for the @h081lll/agent tests: an H081 over a stub bank (helpers.ts mockBank) in a throwaway home, a
// gateway on 127.0.0.1 with a random port, and a raw HTTP client (node:http, so tests can send any Host / Origin).
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { MAINNET } from '../../integrations/core/constants.js';
import { H081, type AgentBank } from '../../integrations/agent/src/h081.js';
import { newToken } from '../../integrations/agent/src/home.js';
import { startServer, type RunningServer } from '../../integrations/agent/src/server.js';
import { mockBank } from './helpers.js';

export const FRESH = 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv';

export function tempHome(prefix = 'h081-agent-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The mock bank plus what the agent uses beyond BankLike: relayer terms (mainnet's published ones) and signature statuses. */
export function stubBank(over: Record<string, unknown> = {}) {
  const bank = mockBank({
    relayTerms: vi.fn(async () => ({
      url: MAINNET.relayer, relayer: new PublicKey('DWp7dJ6QZxqtUDhMy7JB6UJru47J94bQSJNEdG4QrjjA'), feeRecipient: new PublicKey(MAINNET.treasuryUsdgAccount),
      minFee: 50_000n, feeBps: 20, treasury: MAINNET.loanTreasury, freeTier: 100_000_000n, createAccountFee: 2_000_000n,
    })),
    connection: { getSignatureStatuses: vi.fn(async () => ({ value: [null] })) },
    ...over,
  } as never);
  return bank as typeof bank & { relayTerms: ReturnType<typeof vi.fn>; connection: { getSignatureStatuses: ReturnType<typeof vi.fn> } };
}

export interface AgentSetup {
  h: H081; bank: ReturnType<typeof stubBank>; home: string; signer: Keypair; logs: string[];
}

export async function makeAgent(opts: { home?: string; signer?: Keypair; env?: NodeJS.ProcessEnv; bank?: ReturnType<typeof stubBank>; maxSendsPerMin?: number } = {}): Promise<AgentSetup> {
  const home = opts.home ?? tempHome();
  const signer = opts.signer ?? Keypair.generate();
  const bank = opts.bank ?? stubBank();
  const logs: string[] = [];
  const h = await H081.open({
    env: { H081_HOME: home, H081_RELAYER_URL: MAINNET.relayer, ...(opts.env ?? {}) }, signer, bank: bank as unknown as AgentBank,
    log: (l) => logs.push(l), retryDelayMs: 2, maxSendsPerMin: opts.maxSendsPerMin,
  });
  return { h, bank, home, signer, logs };
}

export interface Res { status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any }

/** One HTTP request to the gateway; `headers` may set Host, Origin, Content-Type freely. */
export function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const req = request({ host: '127.0.0.1', port, method, path, headers: { ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...(opts.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export interface Gateway {
  srv: RunningServer; token: string; port: number; logs: string[];
  /** an authorized JSON request (POST bodies get Content-Type: application/json) */
  api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Res>;
  close: () => Promise<void>;
}

export async function startGateway(h: H081, opts: { allowOrigin?: string } = {}): Promise<Gateway> {
  const token = newToken();
  const logs: string[] = [];
  const srv = await startServer({ h081: h, token, port: 0, allowOrigin: opts.allowOrigin, log: (l) => logs.push(l) });
  const port = srv.port;
  const api = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => call(port, method, path, {
    body, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  });
  return { srv, token, port, logs, api, close: () => srv.close() };
}
