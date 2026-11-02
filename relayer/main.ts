// Relayer service entry: `npm run relayer` (tsx relayer/main.ts). Configuration: environment variables,
// see relayer/README.md. Nothing here reads a .env file; the operator sets the environment.
import { buildRelayer } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createRelayerServer } from './server.js';

async function main() {
  const cfg = loadConfig();
  const server = createRelayerServer(await buildRelayer(cfg));
  server.listen(cfg.port, cfg.host, () => console.log(`relayer listening on http://${cfg.host}:${cfg.port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e instanceof ConfigError ? `config: ${e.message}` : e);
  process.exit(1);
});
