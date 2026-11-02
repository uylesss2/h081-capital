// Serverless entry (Vercel Node function): bundled by scripts/relayer-vercel.mjs into deploy/relayer-vercel/.
// Same environment variables as main.ts; the hot key comes from RELAYER_SOLANA_KEYPAIR_JSON. Setup runs once
// per instance; a failed setup is retried on the next request.
import { existsSync } from 'node:fs';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelayer } from './app.js';
import { loadConfig } from './config.js';
import { createRelayerHandler } from './server.js';

let ready: Promise<RequestListener> | undefined;

/**
 * The environment, plus the disclose circuit artifacts the bundle ships next to the function
 * (deploy/relayer-vercel/circuits, see scripts/relayer-vercel.mjs) when RELAYER_X402_CIRCUITS_DIR is unset.
 */
function environment(): Record<string, string | undefined> {
  const env = { ...process.env };
  if (!env.RELAYER_X402_CIRCUITS_DIR) {
    const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', 'circuits');
    if (existsSync(join(bundled, 'disclose'))) env.RELAYER_X402_CIRCUITS_DIR = bundled;
  }
  return env;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= buildRelayer(loadConfig(environment())).then(createRelayerHandler);
  let handle: RequestListener;
  try {
    handle = await ready;
  } catch (e) {
    ready = undefined;
    console.error('relayer setup failed', e);
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error: { code: 'unavailable', message: 'relayer is starting or misconfigured' } }));
  }
  return handle(req, res);
}
