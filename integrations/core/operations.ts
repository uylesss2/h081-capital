// The operations as plain functions over a bank: argument parsing here, chain work in H081Bank. The MCP
// tools and the Agent Kit actions are thin wrappers around `runOp`, so both expose exactly the same behavior
// and the tests can drive them against a mocked bank.
import { PublicKey } from '@solana/web3.js';
import type { StipendAddress } from '../../src/account.js';
import type { H081Bank } from './bank.js';
import { decodeAddressCode } from './codes.js';
import { MAINNET } from './constants.js';
import { LEND_ACTIONS, LEND_FIELDS, type OpName, STAKE_ACTIONS, ZOD } from './schemas.js';
import { parseAmount } from './units.js';

/** What an operation needs from the bank (H081Bank satisfies it; tests pass a mock). */
export type BankLike = Pick<H081Bank, 'deposit' | 'withdraw' | 'balance' | 'loanQuote' | 'borrow' | 'stakeView' | 'stake' | 'requestUnstake' | 'unstake' | 'protocolInfo' | 'pay' | 'codeContext'
  | 'allowanceGrant' | 'allowanceDelegate' | 'allowanceReclaim' | 'lendOpen' | 'lendFund' | 'lendStatus' | 'lendCollect' | 'lendClaim' | 'lendSettle' | 'lendClose' | 'lendSweep'> & { decimals: number };

export type Args = Record<string, unknown>;

const USDG_DECIMALS = MAINNET.usdg.decimals;
const H081_DECIMALS = MAINNET.h081.decimals;

export async function opDeposit(bank: BankLike, args: Args) {
  return bank.deposit(parseAmount(args, 'usdg', bank.decimals));
}

export async function opWithdraw(bank: BankLike, args: Args) {
  const amount = parseAmount(args, 'usdg', bank.decimals);
  let to: PublicKey | undefined;
  if (args.to !== undefined && args.to !== null && String(args.to).trim() !== '') {
    try { to = new PublicKey(String(args.to).trim()); } catch { throw new Error('`to` must be a base58 Solana wallet address'); }
  }
  const direct = args.direct === true || args.direct === 'true';
  return bank.withdraw(amount, to, direct);
}

export async function opBalance(bank: BankLike, _args: Args) {
  return bank.balance();
}

export async function opLoanQuote(bank: BankLike, args: Args) {
  const has = (k: string) => args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== '';
  const minRemaining = has('minRemaining') || has('minRemainingUsdg') ? parseAmount(args, 'minRemainingUsdg', USDG_DECIMALS, { baseKey: 'minRemaining', positive: false }) : undefined;
  const principal = has('principal') || has('principalUsdg') ? parseAmount(args, 'principalUsdg', USDG_DECIMALS, { baseKey: 'principal', positive: false }) : undefined;
  let pledgeBps: number | undefined;
  if (has('pledgeBps')) {
    pledgeBps = Number(args.pledgeBps);
    if (!Number.isInteger(pledgeBps) || pledgeBps < 1 || pledgeBps > 10000) throw new Error('pledgeBps must be an integer 1..10000');
  }
  let loanRef: bigint | undefined;
  if (has('loanRef')) {
    if (!/^\d+$/.test(String(args.loanRef).trim())) throw new Error('loanRef must be a non-negative integer');
    loanRef = BigInt(String(args.loanRef).trim());
  }
  return bank.loanQuote({ termsCode: has('termsCode') ? String(args.termsCode) : undefined, minRemaining, pledgeBps, principal, loanRef });
}

export async function opLoanBorrow(bank: BankLike, args: Args) {
  const termsCode = String(args.termsCode ?? '').trim();
  if (!termsCode) throw new Error('termsCode (the lender\'s "h081-loan-terms:" code) is required');
  const has = (k: string) => args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== '';
  const budget = has('budget') || has('budgetUsdg') ? parseAmount(args, 'budgetUsdg', USDG_DECIMALS, { baseKey: 'budget' }) : undefined;
  const dailyCap = has('dailyCap') || has('dailyCapUsdg') ? parseAmount(args, 'dailyCapUsdg', USDG_DECIMALS, { baseKey: 'dailyCap' }) : undefined;
  const maxPerTx = has('maxPerTx') || has('maxPerTxUsdg') ? parseAmount(args, 'maxPerTxUsdg', USDG_DECIMALS, { baseKey: 'maxPerTx' }) : undefined;
  const principal = has('principal') || has('principalUsdg') ? parseAmount(args, 'principalUsdg', USDG_DECIMALS, { baseKey: 'principal' }) : undefined;
  const days = Number(args.days), unlockDays = Number(args.unlockDays);
  if (!(days > 0) || !(unlockDays > 0)) throw new Error('days and unlockDays must be positive numbers');
  if (unlockDays > days) throw new Error('unlockDays must not exceed days');
  let agentIndex: number | undefined;
  if (has('agentIndex')) {
    agentIndex = Number(args.agentIndex);
    if (!Number.isInteger(agentIndex) || agentIndex < 0 || agentIndex > 15) throw new Error('agentIndex must be 0..15');
  }
  return bank.borrow(termsCode, { budget, dailyCap, maxPerTx, principal, days, unlockDays, agentIndex });
}

export async function opPay(bank: BankLike, args: Args) {
  if (args.confirm !== undefined) throw new Error('h081_pay has no plan step and takes no `confirm`: it pays as soon as it is called. Nothing was sent.');
  const amount = parseAmount(args, 'usdg', bank.decimals);
  const has = (k: string) => args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== '';
  if (has('to') === has('toAddressCode')) throw new Error('give exactly one recipient: `to` (a Solana wallet, public payout) or `toAddressCode` (an "h081-address:" code, private payment)');
  let to: PublicKey | StipendAddress;
  if (has('to')) {
    try { to = new PublicKey(String(args.to).trim()); } catch { throw new Error('`to` must be a base58 Solana wallet address; for a shielded H081 address use toAddressCode (an "h081-address:" code)'); }
  } else {
    to = decodeAddressCode(bank.codeContext, String(args.toAddressCode));
  }
  let allowanceId: bigint | undefined;
  if (has('allowanceId')) {
    if (!/^\d+$/.test(String(args.allowanceId).trim())) throw new Error('allowanceId must be the decimal id h081_bank_balance shows');
    allowanceId = BigInt(String(args.allowanceId).trim());
  }
  let agentIndex: number | undefined;
  if (has('agentIndex')) {
    agentIndex = Number(args.agentIndex);
    if (!Number.isInteger(agentIndex) || agentIndex < 0 || agentIndex > 15) throw new Error('agentIndex must be 0..15');
  }
  const direct = args.direct === true || args.direct === 'true';
  if (direct && !has('to')) throw new Error('direct applies to a public payout (`to`); a private payment is always sent by the agent key');
  const allowPledged = args.allowPledged === true || args.allowPledged === 'true';
  return bank.pay({ amount, to, allowanceId, agentIndex, direct, allowPledged });
}

const present = (args: Args, k: string) => args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== '';

/** An optional positive amount given as `<baseKey>` (base units) or `<baseKey>Usdg` (decimal). */
function optionalUsdg(args: Args, baseKey: string): bigint | undefined {
  return present(args, baseKey) || present(args, `${baseKey}Usdg`) ? parseAmount(args, `${baseKey}Usdg`, USDG_DECIMALS, { baseKey }) : undefined;
}

function optionalIndex(args: Args, key: string): number | undefined {
  if (!present(args, key)) return undefined;
  const i = Number(args[key]);
  if (!Number.isInteger(i) || i < 0 || i > 15) throw new Error(`${key} must be 0..15`);
  return i;
}

function optionalDays(args: Args, key: string): number | undefined {
  if (!present(args, key)) return undefined;
  const n = Number(args[key]);
  if (!(n > 0) || n > 3650) throw new Error(`${key} must be a positive number of days (at most 3650)`);
  return n;
}

function allowanceIdOf(args: Args, required = true): bigint | undefined {
  if (!present(args, 'allowanceId')) {
    if (required) throw new Error('allowanceId is required: the decimal id h081_bank_balance shows');
    return undefined;
  }
  if (!/^\d+$/.test(String(args.allowanceId).trim())) throw new Error('allowanceId must be the decimal id h081_bank_balance shows');
  return BigInt(String(args.allowanceId).trim());
}

const confirmed = (args: Args) => args.confirm === true || args.confirm === 'true';

export async function opAllowanceGrant(bank: BankLike, args: Args) {
  const amount = parseAmount(args, 'usdg', bank.decimals);
  if (present(args, 'agentIndex') && present(args, 'toAddressCode')) throw new Error('give agentIndex (a sub-account) or toAddressCode (another agent\'s "h081-address:" code), not both');
  const to = present(args, 'toAddressCode') ? decodeAddressCode(bank.codeContext, String(args.toAddressCode)) : undefined;
  let windowLen: bigint | undefined;
  if (present(args, 'windowLen')) {
    const s = String(args.windowLen).trim();
    if (!/^\d+$/.test(s) || BigInt(s) < 60n) throw new Error('windowLen must be a whole number of seconds, at least 60 (default 86400, a day)');
    windowLen = BigInt(s);
  }
  return bank.allowanceGrant({
    amount, to, agentIndex: optionalIndex(args, 'agentIndex'), windowCap: optionalUsdg(args, 'windowCap'), windowLen, maxPerTx: optionalUsdg(args, 'maxPerTx'),
    days: optionalDays(args, 'days'), unlockDays: optionalDays(args, 'unlockDays'), confirm: confirmed(args),
  });
}

export async function opAllowanceDelegate(bank: BankLike, args: Args) {
  const amount = parseAmount(args, 'usdg', bank.decimals);
  const allowanceId = allowanceIdOf(args)!;
  if (present(args, 'toAgentIndex') === present(args, 'toAddressCode')) throw new Error('give exactly one recipient for the child: toAgentIndex (a sub-account) or toAddressCode (another agent\'s "h081-address:" code)');
  const to = present(args, 'toAddressCode') ? decodeAddressCode(bank.codeContext, String(args.toAddressCode)) : undefined;
  return bank.allowanceDelegate({
    allowanceId, agentIndex: optionalIndex(args, 'agentIndex'), toAgentIndex: optionalIndex(args, 'toAgentIndex'), to, amount,
    windowCap: optionalUsdg(args, 'windowCap'), maxPerTx: optionalUsdg(args, 'maxPerTx'), days: optionalDays(args, 'days'), unlockDays: optionalDays(args, 'unlockDays'),
    confirm: confirmed(args),
  });
}

export async function opAllowanceReclaim(bank: BankLike, args: Args) {
  return bank.allowanceReclaim({ allowanceId: allowanceIdOf(args)!, confirm: confirmed(args) });
}

function loanRefOf(args: Args, required: boolean): bigint | undefined {
  if (!present(args, 'loanRef')) {
    if (required) throw new Error('loanRef is required: the loan slot number (h081_lend action "status" lists this agent\'s slots)');
    return undefined;
  }
  const s = String(args.loanRef).trim();
  if (!/^\d+$/.test(s)) throw new Error('loanRef must be a non-negative integer (the loan slot number)');
  return BigInt(s);
}

function pledgeBpsOf(args: Args): bigint | undefined {
  if (!present(args, 'pledgeBps')) return undefined;
  const n = Number(args.pledgeBps);
  if (!Number.isInteger(n) || n < 100 || n > 9000) throw new Error('pledgeBps must be an integer 100..9000: the share of every borrower payment routed to the lender (1% to 90%)');
  return BigInt(n);
}

export async function opLend(bank: BankLike, args: Args) {
  const action = String(args.action ?? '');
  if (!(LEND_ACTIONS as readonly string[]).includes(action)) throw new Error(`action must be one of ${LEND_ACTIONS.join(', ')}`);
  // each action reads only its own fields; a stray one (e.g. `usdg` on fund, `confirm` on claim) is refused, never ignored
  const allowed = LEND_FIELDS[action as (typeof LEND_ACTIONS)[number]];
  const stray = Object.keys(args).filter((k) => k !== 'action' && args[k] !== undefined && !allowed.includes(k));
  if (stray.length) throw new Error(`action "${action}" does not take ${stray.join(', ')} (it takes ${allowed.join(', ') || 'no other fields'}). Nothing was sent.`);
  const confirm = confirmed(args);
  switch (action) {
    case 'open': {
      const pledgeBps = pledgeBpsOf(args);
      if (pledgeBps === undefined) throw new Error('pledgeBps is required to open a slot: the share of every borrower payment routed to it, 100..9000 basis points');
      return bank.lendOpen({ pledgeBps, confirm });
    }
    case 'fund': {
      const proofCode = String(args.proofCode ?? '').trim();
      if (!proofCode) throw new Error('proofCode (the borrower\'s "h081-loan-proof:" code) is required to fund a loan');
      return bank.lendFund({ proofCode, loanRef: loanRefOf(args, false), principal: optionalUsdg(args, 'principal'), pledgeBps: pledgeBpsOf(args), confirm });
    }
    case 'status': return bank.lendStatus({ loanRef: loanRefOf(args, false), pledgeBps: pledgeBpsOf(args) });
    case 'collect': return bank.lendCollect({ loanRef: loanRefOf(args, true)! });
    case 'claim': return bank.lendClaim({ loanRef: loanRefOf(args, true)!, amount: present(args, 'amount') || present(args, 'usdg') ? parseAmount(args, 'usdg', USDG_DECIMALS) : undefined });
    case 'settle': return bank.lendSettle({ loanRef: loanRefOf(args, true)!, confirm });
    case 'sweep': return bank.lendSweep({ loanRef: loanRefOf(args, true)! });
    default: return bank.lendClose({ loanRef: loanRefOf(args, true)!, confirm });
  }
}

export async function opStake(bank: BankLike, args: Args) {
  const action = String(args.action ?? 'view');
  if (!(STAKE_ACTIONS as readonly string[]).includes(action)) throw new Error(`action must be one of ${STAKE_ACTIONS.join(', ')}`);
  switch (action) {
    case 'view': return bank.stakeView();
    case 'stake': return bank.stake(parseAmount(args, 'h081', H081_DECIMALS));
    case 'request_unstake': return bank.requestUnstake(parseAmount(args, 'h081', H081_DECIMALS));
    default: return bank.unstake();
  }
}

export async function opProtocolInfo(bank: BankLike, _args: Args) {
  return bank.protocolInfo();
}

export const OPERATIONS: Record<OpName, (bank: BankLike, args: Args) => Promise<unknown>> = {
  h081_bank_deposit: opDeposit,
  h081_bank_withdraw: opWithdraw,
  h081_bank_balance: opBalance,
  h081_loan_quote: opLoanQuote,
  h081_loan_borrow: opLoanBorrow,
  h081_pay: opPay,
  h081_allowance_grant: opAllowanceGrant,
  h081_allowance_delegate: opAllowanceDelegate,
  h081_allowance_reclaim: opAllowanceReclaim,
  h081_lend: opLend,
  h081_stake: opStake,
  h081_protocol_info: opProtocolInfo,
};

/** Checks `args` against the operation's zod schema (strict: unknown or misplaced fields are refused). Both front ends
 *  (MCP tools and Agent Kit methods) go through runOp, so they accept and refuse exactly the same inputs. */
export function validateArgs(name: OpName, args: Args | undefined): Args {
  const schema = ZOD[name];
  if (!schema) throw new Error(`unknown operation ${name}`);
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const where = (i: { path: (string | number)[] }) => i.path.join('.') || 'input';
    throw new Error(parsed.error.issues.map((i) => (/^must /.test(i.message) ? `${where(i)} ${i.message}` : `${where(i)}: ${i.message}`)).join('; ') + '. Nothing was sent.');
  }
  return parsed.data as Args;
}

export async function runOp(bank: BankLike, name: OpName, args: Args = {}): Promise<unknown> {
  const op = OPERATIONS[name];
  if (!op) throw new Error(`unknown operation ${name}`);
  return op(bank, validateArgs(name, args));
}

/** Converts an operation result to plain JSON (bigints as decimal strings, bytes as 0x hex). */
export function plain<T = unknown>(value: unknown): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? '0x' + Buffer.from(v).toString('hex') : v)));
}
