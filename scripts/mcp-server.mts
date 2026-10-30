// Stdio MCP server for one stipend agent (EVM reference pool). Run with tsx:
//
//   STIPEND_RPC_URL=http://127.0.0.1:8545 STIPEND_POOL=0x... STIPEND_AGENT_SK=<spending key> \
//   STIPEND_SUBMITTER_KEY=0x<relayer's EVM key> npx tsx scripts/mcp-server.mts
//
// Optional: STIPEND_RELAYER (fee recipient, default the submitter's address), STIPEND_RELAY_FEE (base units per
// public payout, default 0), STIPEND_X402_MAX (ceiling per x402 request, base units).
// The submitter only pays gas and relays; it never holds the agent's funds. Keys come from the environment of the
// process that launches the server (the MCP client's config); this script reads no files. stdout carries only
// JSON-RPC; diagnostics go to stderr.
import { JsonRpcProvider, Wallet as EthersWallet } from 'ethers';
import { Account, Wallet, connectPool } from '../src/client.js';
import { initCrypto } from '../src/crypto.js';
import { McpServer, stipendTools } from '../src/mcp.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return v;
}

await initCrypto();
const provider = new JsonRpcProvider(need('STIPEND_RPC_URL'));
const submitter = new EthersWallet(need('STIPEND_SUBMITTER_KEY'), provider);
const pool = connectPool(need('STIPEND_POOL'), submitter);
const wallet = new Wallet(new Account(BigInt(need('STIPEND_AGENT_SK'))), pool);
const { chainId } = await provider.getNetwork();
const relayer = process.env.STIPEND_RELAYER ?? (await submitter.getAddress());
const fee = process.env.STIPEND_RELAY_FEE ? BigInt(process.env.STIPEND_RELAY_FEE) : 0n;
const maxX402Amount = process.env.STIPEND_X402_MAX ? BigInt(process.env.STIPEND_X402_MAX) : undefined;

const server = new McpServer(stipendTools({ wallet, chainId, relay: { relayer, fee }, maxX402Amount }));
process.stderr.write(`stipend MCP server: pool ${await pool.getAddress()} on eip155:${chainId}\n`);
await server.serveStdio();
