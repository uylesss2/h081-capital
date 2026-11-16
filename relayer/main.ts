// Relayer service entry: `npm run relayer` (tsx relayer/main.ts). Configuration: environment variables,
// see relayer/README.md. Nothing here reads a .env file; the operator sets the environment.
import { buildRelayer } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createRelayerServer } from './server.js';

async function main() {
  const cfg = loadConfig();
  const opts = await buildRelayer(cfg);
  const server = createRelayerServer(opts);
  server.listen(cfg.port, cfg.host, () => console.log(`relayer listening on http://${cfg.host}:${cfg.port}`));
  // private reputation: queued attests go out with every other repaid loan on this timer (a serverless host uses the
  // cron route GET /v1/rep/sweep instead)
  const every = cfg.solana?.rep?.sweepEveryMin ?? 0;
  let sweeping = false;
  const sweep = opts.rep?.sweep?.bind(opts.rep);
  const timer = sweep && every > 0
    ? setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      sweep()
        .then((r) => { if (r.attested.length || r.failed.length) console.log(`rep sweep ${JSON.stringify(r)}`); })
        .catch((e) => console.error(`rep sweep failed: ${(e as Error).message}`))
        .finally(() => { sweeping = false; });
    }, every * 60_000)
    : undefined;
  const stop = () => { if (timer) clearInterval(timer); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? `config: ${e.message}` : e);
  process.exit(1);
});
