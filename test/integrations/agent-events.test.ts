// /v1/events: op.completed / op.failed from writes, balance.changed / allowance.changed from a sync that runs only
// while a client is connected, monotonic ids, Last-Event-ID replay, the 1,000-event buffer.
import { request, type IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { EVENT_BUFFER, EventHub, diffSnapshots } from '../../integrations/agent/src/events.js';
import { H081, type AgentBank } from '../../integrations/agent/src/h081.js';
import { newToken } from '../../integrations/agent/src/home.js';
import { startServer } from '../../integrations/agent/src/server.js';
import { Keypair } from '@solana/web3.js';
import { stubBank, tempHome } from './agent-helpers.js';
import { MAINNET } from '../../integrations/core/constants.js';

interface Sse { events: Array<{ id: number; event: string; data: any }>; res: IncomingMessage; close: () => void }

function sse(port: number, token: string, lastEventId?: number): Promise<Sse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/events', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}) } }, (res) => {
      const out: Sse = { events: [], res, close: () => req.destroy() };
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const f = Object.fromEntries(block.split('\n').filter((l) => /^(id|event|data):/.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
          if (f.event) out.events.push({ id: Number(f.id), event: f.event, data: JSON.parse(f.data) });
        }
      });
      resolve(out);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('/v1/events', () => {
  it('streams op events and balance changes; syncs only while a client is connected; resumes with Last-Event-ID', async () => {
    let shielded = 25_000_000n;
    const bank = stubBank();
    const base = await bank.balance();
    bank.balance.mockImplementation(async () => ({ ...base, shielded, shieldedUsdg: (Number(shielded) / 1e6).toString(), agentAllowances: [] }));
    bank.balance.mockClear();
    const h = await H081.open({ env: { H081_HOME: tempHome(), H081_RELAYER_URL: MAINNET.relayer }, signer: Keypair.generate(), bank: bank as unknown as AgentBank, log: () => {}, pollSeconds: 0.05 });
    const token = newToken();
    const srv = await startServer({ h081: h, token, port: 0, log: () => {} });
    try {
      // nobody connected: no background sync
      await new Promise((r) => setTimeout(r, 150));
      expect(bank.balance).not.toHaveBeenCalled();
      const s = await sse(srv.port, token);
      expect(s.res.statusCode).toBe(200);
      expect(s.res.headers['content-type']).toMatch(/text\/event-stream/);
      await vi.waitFor(() => expect(bank.balance).toHaveBeenCalled());
      shielded = 30_000_000n;
      await vi.waitFor(() => expect(s.events.find((e) => e.event === 'balance.changed')).toBeDefined(), { timeout: 3000 });
      expect(s.events.find((e) => e.event === 'balance.changed')!.data).toMatchObject({ shielded: '30', deltaShielded: '5', wallet: { usdg: '100', sol: '0.2' } });
      // a write: op.completed with its key and signature
      const r = await fetch(`${srv.url}/deposit`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'ev-1' }, body: JSON.stringify({ usdg: '1', confirm: true }) });
      expect(r.status).toBe(200);
      await vi.waitFor(() => expect(s.events.find((e) => e.event === 'op.completed')).toBeDefined());
      expect(s.events.find((e) => e.event === 'op.completed')!.data).toMatchObject({ idempotencyKey: 'ev-1', kind: 'deposit', signature: 'sigDeposit' });
      const ids = s.events.map((e) => e.id);
      expect([...ids].sort((x, y) => x - y)).toEqual(ids);
      s.close();
      await new Promise((r) => setTimeout(r, 100));
      const calls = bank.balance.mock.calls.length;
      await new Promise((r) => setTimeout(r, 200));
      expect(bank.balance.mock.calls.length).toBe(calls); // stopped with the last client
      // resume: only what came after the given id
      const resumed = await sse(srv.port, token, ids[0]);
      await vi.waitFor(() => expect(resumed.events.length).toBeGreaterThanOrEqual(ids.length - 1));
      expect(resumed.events[0].id).toBe(ids[1]);
      resumed.close();
    } finally {
      await srv.close();
    }
  });

  it('the hub keeps the last 1,000 events with increasing ids; the diff names allowance changes', () => {
    const hub = new EventHub();
    for (let i = 0; i < EVENT_BUFFER + 50; i++) hub.emit('op.completed', { i });
    const all = hub.since(0);
    expect(all).toHaveLength(EVENT_BUFFER);
    expect(all[0].id).toBe(51);
    expect(hub.lastId).toBe(EVENT_BUFFER + 50);
    const a = { shielded: '1', wallet: { usdg: '0', sol: '0.1' }, allowances: [{ id: '7', remaining: '5' }, { id: '8', remaining: '1' }] };
    const b = { shielded: '0.5', wallet: { usdg: '0', sol: '0.1' }, allowances: [{ id: '9', remaining: '4' }, { id: '8', remaining: '1' }] };
    expect(diffSnapshots(undefined, a)).toEqual([]);
    expect(diffSnapshots(a, b)).toEqual([
      { type: 'balance.changed', data: { shielded: '0.5', wallet: { usdg: '0', sol: '0.1' }, deltaShielded: '-0.5' } },
      { type: 'allowance.changed', data: { id: '9', remaining: '4' } },
      { type: 'allowance.changed', data: { id: '7', remaining: '0' } },
    ]);
  });
});
