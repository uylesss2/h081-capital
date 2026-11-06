// An McpServer (src/mcp-core.ts framing) serving the H081 bank tools.
import { McpServer } from '../../../src/mcp-core.js';
import { NOTICE } from '../../core/constants.js';
import type { BankLike } from '../../core/operations.js';
import { h081Tools } from './tools.js';

export const SERVER_NAME = 'h081';
export const SERVER_VERSION = '0.2.0';

export const INSTRUCTIONS =
  'H081 Capital: a private bank for AI agents on Solana. The agent key this server holds pays fees, holds USDG and owns ' +
  'a shielded bank account. Deposits are public on chain (depositor and amount) and capped (1,000 USDG per deposit, ' +
  '10,000 USDG total); the shielded balance and withdrawals through the relayer are not linked to the agent wallet. ' +
  'Loans are a two-party flow between agents: the lender opens a slot with h081_lend (action "open") and hands its ' +
  '"h081-loan-terms:" code to the borrower; h081_loan_borrow pledges an allowance to those terms and returns an ' +
  '"h081-loan-proof:" code; the lender funds against it with h081_lend (action "fund", from the agent wallet\'s public ' +
  'USDG, capped by H081_MAX_LEND) and later claims, collects and settles. Nothing is borrowed until a lender funds; the ' +
  'lender agent wallet is public on chain. h081_pay spends an allowance inside its caps: to a ' +
  'Solana wallet (public payout through the relayer) or privately to another agent\'s "h081-address:" code (h081_bank_balance ' +
  'shows this agent\'s own code); it pays when called (no plan step) and uses a pledged loan allowance only with ' +
  'allowPledged: true, since that puts the loan slot and lender share on chain next to the payment. h081_allowance_grant gives a sub-account or another agent a capped budget from the ' +
  'shielded balance, h081_allowance_delegate carves a child (never looser than its parent) out of an allowance this agent ' +
  'holds, and h081_allowance_reclaim takes back what is left; without confirm: true these three, and h081_lend open, ' +
  'fund, settle and close, only return the plan and send nothing. ' + NOTICE;

export interface ServerOptions {
  bank: () => Promise<BankLike>;
  version?: string;
}

export function createServer(opts: ServerOptions): McpServer {
  return new McpServer(h081Tools({ bank: opts.bank }), { name: SERVER_NAME, version: opts.version ?? SERVER_VERSION, instructions: INSTRUCTIONS });
}
