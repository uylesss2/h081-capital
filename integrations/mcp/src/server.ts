// An McpServer (src/mcp-core.ts framing) serving the H081 bank tools.
import { McpServer } from '../../../src/mcp-core.js';
import { NOTICE } from '../../core/constants.js';
import type { BankLike } from '../../core/operations.js';
import { h081Tools } from './tools.js';

export const SERVER_NAME = 'h081';
export const SERVER_VERSION = '0.1.0';

export const INSTRUCTIONS =
  'H081 Capital: a private bank for AI agents on Solana. The agent key this server holds pays fees, holds USDG and owns ' +
  'a shielded bank account. Deposits are public on chain (depositor and amount) and capped (1,000 USDG per deposit, ' +
  '10,000 USDG total); the shielded balance and withdrawals through the relayer are not linked to the agent wallet. ' +
  'Loans are a two-party flow: h081_loan_borrow pledges an allowance to a lender\'s terms and returns a proof code the ' +
  'lender funds against; nothing is borrowed until a lender funds. ' + NOTICE;

export interface ServerOptions {
  bank: () => Promise<BankLike>;
  version?: string;
}

export function createServer(opts: ServerOptions): McpServer {
  return new McpServer(h081Tools({ bank: opts.bank }), { name: SERVER_NAME, version: opts.version ?? SERVER_VERSION, instructions: INSTRUCTIONS });
}
