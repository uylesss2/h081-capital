// The plugin's `methods`: plain async functions an agent program can call directly
// (`agent.methods.h081BankDeposit(agent, { usdg: '25' })`). Each returns plain JSON (bigints as decimal strings).
import type { AgentLike } from '../bank.js';
import { bankFor } from '../bank.js';
import { plain, runOp, validateArgs } from '../../../core/operations.js';
import type { OpName } from '../../../core/schemas.js';

async function run(agent: AgentLike, name: OpName, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  validateArgs(name, input); // refuse bad input before opening the bank (runOp checks again)
  return plain<Record<string, unknown>>(await runOp(await bankFor(agent), name, input ?? {}));
}

export const h081BankDeposit = (agent: AgentLike, input: { amount?: string; usdg?: string }) => run(agent, 'h081_bank_deposit', input);
export const h081BankWithdraw = (agent: AgentLike, input: { amount?: string; usdg?: string; to?: string; direct?: boolean }) => run(agent, 'h081_bank_withdraw', input);
export const h081BankBalance = (agent: AgentLike, input: Record<string, never> = {}) => run(agent, 'h081_bank_balance', input);
export const h081LoanQuote = (agent: AgentLike, input: { termsCode?: string; minRemaining?: string; minRemainingUsdg?: string; pledgeBps?: number; principal?: string; principalUsdg?: string; loanRef?: string }) => run(agent, 'h081_loan_quote', input);
export const h081LoanBorrow = (agent: AgentLike, input: { termsCode: string; budget?: string; budgetUsdg?: string; dailyCap?: string; dailyCapUsdg?: string; maxPerTx?: string; maxPerTxUsdg?: string; principal?: string; principalUsdg?: string; days: number; unlockDays: number; agentIndex?: number }) => run(agent, 'h081_loan_borrow', input);
export const h081Stake = (agent: AgentLike, input: { action: 'view' | 'stake' | 'request_unstake' | 'unstake'; amount?: string; h081?: string }) => run(agent, 'h081_stake', input);
export const h081ProtocolInfo = (agent: AgentLike, input: Record<string, never> = {}) => run(agent, 'h081_protocol_info', input);
export const h081Pay = (agent: AgentLike, input: { amount?: string; usdg?: string; to?: string; toAddressCode?: string; allowanceId?: string; agentIndex?: number; direct?: boolean; allowPledged?: boolean }) => run(agent, 'h081_pay', input);

type AllowanceLimits = { windowCap?: string; windowCapUsdg?: string; maxPerTx?: string; maxPerTxUsdg?: string; days?: number; unlockDays?: number; confirm?: boolean };
export const h081AllowanceGrant = (agent: AgentLike, input: { amount?: string; usdg?: string; agentIndex?: number; toAddressCode?: string; windowLen?: number } & AllowanceLimits) => run(agent, 'h081_allowance_grant', input);
export const h081AllowanceDelegate = (agent: AgentLike, input: { allowanceId: string; agentIndex?: number; toAgentIndex?: number; toAddressCode?: string; amount?: string; usdg?: string } & AllowanceLimits) => run(agent, 'h081_allowance_delegate', input);
export const h081AllowanceReclaim = (agent: AgentLike, input: { allowanceId: string; confirm?: boolean }) => run(agent, 'h081_allowance_reclaim', input);

export const h081Lend = (agent: AgentLike, input: {
  action: 'open' | 'fund' | 'status' | 'claim' | 'collect' | 'settle' | 'close' | 'sweep'; pledgeBps?: number; proofCode?: string; loanRef?: string;
  principal?: string; principalUsdg?: string; amount?: string; usdg?: string; confirm?: boolean;
}) => run(agent, 'h081_lend', input);

export const h081Transfer = (agent: AgentLike, input: { amount?: string; usdg?: string; toAddressCode: string }) => run(agent, 'h081_transfer', input);

export const METHODS = { h081BankDeposit, h081BankWithdraw, h081BankBalance, h081LoanQuote, h081LoanBorrow, h081Stake, h081ProtocolInfo, h081Pay, h081AllowanceGrant, h081AllowanceDelegate, h081AllowanceReclaim, h081Lend, h081Transfer };
export const METHOD_OF: Record<OpName, keyof typeof METHODS> = {
  h081_bank_deposit: 'h081BankDeposit', h081_bank_withdraw: 'h081BankWithdraw', h081_bank_balance: 'h081BankBalance', h081_loan_quote: 'h081LoanQuote',
  h081_loan_borrow: 'h081LoanBorrow', h081_stake: 'h081Stake', h081_protocol_info: 'h081ProtocolInfo', h081_pay: 'h081Pay',
  h081_allowance_grant: 'h081AllowanceGrant', h081_allowance_delegate: 'h081AllowanceDelegate', h081_allowance_reclaim: 'h081AllowanceReclaim',
  h081_lend: 'h081Lend', h081_transfer: 'h081Transfer',
};
