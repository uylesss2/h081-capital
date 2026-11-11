// @h081lll/agent: the H081 private bank on your own machine, as a TypeScript SDK, the `h081` CLI and a local JSON API.
//
//   import { H081 } from '@h081lll/agent';
//   const bank = await H081.open();                 // ~/.h081/agent.json + ~/.h081/config.json + env
//   await bank.deposit('5', { confirm: true });
//   await bank.withdraw('2', { to: 'FreshWallet111...', confirm: true });
//   console.log(await bank.balance());
//
// Live on Solana mainnet; not audited yet; use at your own risk.
export { H081, VERSION, FUNDING_NEEDED, type OpenOptions, type WriteOptions, type Plan, type Outcome, type FeeQuote, type BalanceResult, type HistoryItem, type CodeCheck, type AgentBank } from './h081.js';
export { startServer, ROUTES, type ServerOptions, type RunningServer } from './server.js';
export { buildOpenApi } from './openapi.js';
export { homePaths, effectiveEnv, ensureToken, rotateToken, readToken } from './home.js';
export { EventHub, type AgentEvent } from './events.js';
export { H081Bank, type BankOptions } from '../../core/bank.js';
export { openFromEnv } from '../../core/open.js';
export { runOp, plain, type BankLike } from '../../core/operations.js';
export { OPS, JSON_SCHEMA, DESCRIPTIONS, type OpName } from '../../core/schemas.js';
export { H081Error, classify, ERROR_CODES, CodedError, type ErrorCode, type Classified } from '../../core/errors.js';
export { configFromEnv, MAINNET, NOTICE, ENV_VARS } from '../../core/constants.js';
export { encodeKeyCode, decodeKeyCode, encodeAddressCode, decodeAddressCode, CodeError } from '../../core/codes.js';
