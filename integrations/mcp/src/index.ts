// @h081lll/mcp: the H081 Capital bank as an MCP server. `h081-mcp` (bin) serves stdio; this module exposes the
// pieces for embedding: the tools, the server factory and the bank facade.
export { createServer, INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, type ServerOptions } from './server.js';
export { h081Tools, type ToolContext } from './tools.js';
export { main } from './cli.js';
export { McpServer, type McpTool, toJson } from '../../../src/mcp-core.js';
export { H081Bank, type BankOptions } from '../../core/bank.js';
export { openFromEnv, AutoFetchProver, type OpenOptions } from '../../core/open.js';
export { configFromEnv, MAINNET, NOTICE, ENV_VARS, type H081Config } from '../../core/constants.js';
export { loadKeypair, parseSecret, deriveAccountSk, accountSkFromEnv } from '../../core/keys.js';
export { fetchCircuits, verifyCircuits, FlatDirProver } from '../../core/circuits.js';
export { explainProgramError, H081Error } from '../../core/errors.js';
export { OPS, DESCRIPTIONS, JSON_SCHEMA, type OpName } from '../../core/schemas.js';
export { runOp, plain, type BankLike } from '../../core/operations.js';
export {
  ADDRESS_PREFIX, PROOF_PREFIX, TERMS_PREFIX, CodeError, decodeAddressCode, decodeLoanProof, decodeLoanTerms, encodeAddressCode, encodeLoanProof, encodeLoanTerms, type CodeContext,
} from '../../core/codes.js';
