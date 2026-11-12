// An McpServer (src/mcp-core.ts framing) serving the H081 bank tools.
import { McpServer } from '../../../src/mcp-core.js';
import { NOTICE } from '../../core/constants.js';
import { classify, classifySend } from '../../core/errors.js';
import type { BankLike } from '../../core/operations.js';
import { h081Tools } from './tools.js';

export const SERVER_NAME = 'h081';
export const SERVER_VERSION = '0.2.3';

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
  'holds, and h081_allowance_reclaim takes back what is left; h081_transfer pays from the main shielded balance to an "h081-address:" ' +
  'code (sent by the agent key when called); without confirm: true the three allowance tools, and h081_lend open, ' +
  'fund, settle and close, only return the plan and send nothing. ' + NOTICE;

export interface ServerOptions {
  bank: () => Promise<BankLike>;
  version?: string;
}

const READS = new Set(['h081_bank_balance', 'h081_loan_quote', 'h081_protocol_info']);
/** Tools that only return a plan unless called with confirm: true (for h081_lend: open, fund, settle, close). */
const PLAN_FIRST = new Set(['h081_allowance_grant', 'h081_allowance_delegate', 'h081_allowance_reclaim']);

/** Whether this call can send a transaction (so a dropped connection leaves its outcome unknown). */
export function sends(name: string, args: Record<string, unknown> = {}): boolean {
  if (READS.has(name)) return false;
  if (name === 'h081_stake' && (args.action ?? 'view') === 'view') return false;
  if (name === 'h081_lend') {
    if (args.action === 'status') return false;
    if (['open', 'fund', 'settle', 'close'].includes(String(args.action)) && args.confirm !== true) return false;
  }
  if (PLAN_FIRST.has(name) && args.confirm !== true) return false;
  return true;
}

export function createServer(opts: ServerOptions): McpServer {
  return new McpServer(h081Tools({ bank: opts.bank }), {
    name: SERVER_NAME, version: opts.version ?? SERVER_VERSION, instructions: INSTRUCTIONS,
    // the same stable code and retry flag the local API (@h081lll/agent) returns
    // a failure while sending is retryable only when nothing was sent (classifySend); otherwise it is outcome_unknown
    errorContent: (e, call) => {
      const c = sends(call.name, call.args) ? classifySend(e) : classify(e);
      return { error: { code: c.code, retryable: c.retryable, message: c.message }, ...(c.code === 'outcome_unknown' ? { text: c.message } : {}) };
    },
  });
}
