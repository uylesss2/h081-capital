// Input schemas of the operations, once as zod (the Agent Kit actions validate with it) and once as
// JSON Schema (what an MCP client shows its model), kept side by side so they say the same thing.
// Amounts are strings: `amount` in base units (integer) or `usdg` / `h081` as a decimal token amount.
import { z } from 'zod';

const BASE = /^\d+$/;
const DECIMAL = /^\d+(\.\d+)?$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const OPS = ['h081_bank_deposit', 'h081_bank_withdraw', 'h081_bank_balance', 'h081_loan_quote', 'h081_loan_borrow', 'h081_stake', 'h081_protocol_info', 'h081_pay',
  'h081_allowance_grant', 'h081_allowance_delegate', 'h081_allowance_reclaim', 'h081_lend', 'h081_transfer', 'h081_back', 'h081_back_draw'] as const;
export type OpName = (typeof OPS)[number];

const NOTICE_SHORT = 'H081 Capital is live on Solana mainnet, not audited yet; use at your own risk.';

export const DESCRIPTIONS: Record<OpName, string> = {
  h081_bank_deposit:
    'Deposit USDG from the agent wallet into its private (shielded) H081 bank account on Solana. The chain sees the ' +
    'depositor and the amount; the shielded balance and every later move inside the bank are private. Caps (read from ' +
    'chain before any proof is made): at most 1,000 USDG per deposit and 10,000 USDG in the bank in total; deposits can be ' +
    'paused by the config authority, withdrawals never. Needs ~0.02 SOL in the agent wallet for buffer rent (refunded) and fees. ' +
    'Give `amount` (base units, 6 decimals) or `usdg` (decimal). ' + NOTICE_SHORT,
  h081_bank_withdraw:
    'Withdraw USDG from the shielded account to a Solana wallet (default: the agent wallet). By default the relayer sends ' +
    'the transaction and takes its fee out of the amount: max(0.05 USDG, 0.20%) of the public amount, paid to the protocol ' +
    'treasury (checked before anything is proven); the chain then does not link the agent wallet to the withdrawal. If the ' +
    'relayer is unreachable or refuses, the withdrawal is NOT sent and the error says why; it is never silently sent by the ' +
    'agent key. Up to 100 USDG per withdrawal with nothing staked; above that, H081 staked in capacity_stake sets a 30-day ' +
    'limit (the agent wallet is named to the relayer as capacity operator, `h081_stake`); otherwise split the withdrawal or go direct. ' +
    '`direct: true` has the agent key send it instead (no relay fee, no limit, but the agent wallet is visible on chain as the ' +
    'sender). Give `amount` or `usdg`. ' + NOTICE_SHORT,
  h081_bank_balance:
    'The shielded USDG balance of the agent\'s H081 bank account (visible only to this key), the wallet\'s public USDG and ' +
    'SOL balances, the current deposit caps, and every allowance with its id and limits: `agentAllowances` (granted to ' +
    'this account; h081_pay spends them), `subAccounts` (granted by this account to its sub-accounts; h081_pay spends them ' +
    'with agentIndex), `heldBySubAccounts` (delegated to a sub-account from an allowance someone else owns; h081_pay with ' +
    'agentIndex) and `grantedToOthers` (granted to other agents; theirs to spend). `reclaimable: true` marks the ones this ' +
    'account owns (h081_allowance_reclaim). Ids are what h081_pay, h081_allowance_delegate and h081_allowance_reclaim take ' +
    'as `allowanceId`; an id changes after every payment or delegation. Also `shieldedAddressCode`: this account\'s ' +
    'shielded address as an "h081-address:" code, to hand to whoever should pay it privately (h081_pay) or grant it an ' +
    'allowance. Read-only.',
  h081_loan_quote:
    'Price a stream-backed loan without sending anything. From a lender\'s `h081-loan-terms:` code (or `pledgeBps` and ' +
    '`minRemaining` directly) it returns the largest principal that pledge can back (minRemaining * pledgeBps / 10000), ' +
    'the 0.25% origination fee the protocol takes out of the payout, and the payout. With `loanRef` it also reads the ' +
    'slot\'s on-chain status (funded, principal, repaid, expiry). There is no on-chain offer book: terms come from a ' +
    'lender off-chain. Read-only.',
  h081_loan_borrow:
    'Pledge an agent allowance to a lender\'s loan slot and produce the proof the lender funds against. The agent\'s ' +
    'shielded balance funds an allowance of `budget` USDG to a sub-account that unlocks as a stream over `unlockDays`, ' +
    'with `pledgeBps` of every payment from it routed to the lender (from the terms code), then makes the stream proof ' +
    'and returns it as an `h081-loan-proof:` code. Hand that code to the lender: when they fund the slot, the principal ' +
    'minus the 0.25% origination fee lands in the agent wallet\'s USDG account. Give `principal` to borrow a set amount: ' +
    'the proof fixes it and the program lets the lender fund exactly that, nothing else. The lender\'s share runs over the ' +
    'whole budget, so with a principal the budget is sized to it (principal * 10000 / pledgeBps) and a bigger budget is ' +
    'refused: it would let the lender take more than it lent. With only `budget`, the principal is the most it can back. This is a two-party flow with no automatic matching: without a lender who funds, nothing is borrowed (a lender ' +
    'agent opens the slot and funds it with h081_lend). Needs the grant (44 MB) and stream circuits. ' +
    NOTICE_SHORT,
  h081_stake:
    'capacity_stake: stake H081 from the agent wallet to earn relayer capacity (desks and shield capacity: how much ' +
    'the relayer relays for this wallet per 30 days above 100 USDG per withdrawal, used by h081_bank_withdraw), request ' +
    'unstake (30-day cooldown), unstake after the cooldown, or `view` the position. Caps: 100,000 H081 per stake, ' +
    '1,000,000 H081 total. Give `amount` (base units, 6 decimals) or `h081` (decimal) for stake / request_unstake. ' +
    NOTICE_SHORT,
  h081_protocol_info:
    'Static and live facts about the H081 Capital bank: cluster, program ids, USDG and H081 mints, deposit caps and ' +
    'pause flag read from chain, relayer terms and status, the agent wallet and shielded address (also as an ' +
    '"h081-address:" code others pay with h081_pay), the operator ceilings (H081_MAX_DEPOSIT, H081_MAX_PAY, H081_MAX_GRANT, ' +
    'H081_MAX_LEND), how the shielded ' +
    'account secret is derived, where the proving artifacts live, and the risk notice. Reports only the RPC host, never ' +
    'the full RPC URL. Read-only.',
  h081_pay:
    'Pay USDG from an allowance this agent holds: one granted to this account, or (with `agentIndex`) one held by a ' +
    'sub-account. `amount`/`usdg` is taken out of the allowance; a pledged allowance (a loan) routes its lender share ' +
    '(pledgeBps) out of it, the rest is paid. Recipient, exactly one: `to`, a Solana wallet (a public payout: the chain ' +
    'shows the wallet and the amount it received, not which account paid), or `toAddressCode`, the recipient\'s ' +
    '"h081-address:" code (a private payment from note to note: amount and recipient stay hidden). A public payout goes ' +
    'through the relayer, fee max(0.05 USDG, 0.20% of the amount), plus a surcharge when the wallet has no USDG account ' +
    'yet, to the protocol treasury (checked before anything is ' +
    'proven); if the relayer is unreachable or refuses, the payment is NOT sent, never silently sent by the agent key; ' +
    'up to 100 USDG per withdrawal with nothing staked; above that, H081 staked in capacity_stake sets a 30-day limit (the agent wallet is named as capacity operator, h081_stake). ' +
    '`direct: true` has the agent key send a public payout (no fee; the agent wallet is then visible as the sender). A ' +
    'private payment is always sent by the agent key (no public leg to pay a relayer from): the chain sees that the ' +
    'agent wallet submitted a payment, not to whom or how much. A pledged (loan) allowance is never used unless ' +
    '`allowPledged: true`: paying from it puts its loan slot and lender share on chain next to the payment, which links ' +
    'the recipient to the borrower wallet (the slot\'s public payout account) and reveals the gross amount. The ' +
    'allowance is `allowanceId` (from h081_bank_balance) or picked automatically: one whose caps allow the amount now ' +
    '(expiry, maxPerTx, remaining, streaming release, per-window cap); when none can, the error names the cap that blocks ' +
    'each one and nothing is sent. Allowances with a recipient allow-list are not supported. The operator ceiling ' +
    'H081_MAX_PAY caps every payment. Returns signature, fee, what the recipient received, and the allowance left. ' +
    'Needs the spend circuit. ' + NOTICE_SHORT,
  h081_allowance_grant:
    'Give a budget (an allowance) from this account\'s shielded balance to one of its sub-accounts (`agentIndex`, default ' +
    'the first free one) or to another agent (`toAddressCode`, its "h081-address:" code). Limits, all enforced by the ' +
    'circuit on every payment: the lifetime `amount`/`usdg`; optional per-window cap `windowCap`/`windowCapUsdg` per ' +
    '`windowLen` seconds (default 86400: a daily cap); per-payment cap `maxPerTx`/`maxPerTxUsdg`; lifetime `days` ' +
    '(default: no expiry); `unlockDays`: the budget streams in linearly over that many days instead of all at once. This ' +
    'account stays the owner and can take back what is left any time (h081_allowance_reclaim). WITHOUT `confirm: true` ' +
    'NOTHING IS SENT: the result is the plan of exactly what would be granted; call again with confirm: true to send it. ' +
    'The operator ceiling H081_MAX_GRANT caps every allowance. Privacy: the agent key sends it (a grant has no public leg ' +
    'a relayer could take its fee from), so the chain shows that the agent wallet made a grant, not the amount, the rules ' +
    'or the recipient. Needs ~0.1 SOL (buffer rent, mostly refunded) and the grant circuit (44 MB). ' + NOTICE_SHORT,
  h081_allowance_delegate:
    'Carve a child allowance for a sub-agent out of an allowance this agent holds (`allowanceId` from h081_bank_balance; ' +
    'with `agentIndex`, one a sub-account holds). The child goes to a sub-account (`toAgentIndex`) or another agent ' +
    '(`toAddressCode`, its "h081-address:" code) and can never be looser than its parent, which the circuit enforces and ' +
    'this checks first, naming the limit: `amount`/`usdg` at most what the parent has left; `windowCap`/`windowCapUsdg` ' +
    'and the streaming rate (`unlockDays`) shared with what the parent keeps (default: in proportion to the amount); ' +
    '`maxPerTx`/`maxPerTxUsdg` and `days` no looser than the parent\'s (default: the parent\'s); owner, window length, ' +
    'recipient allow-list and any loan pledge are inherited, and the parent\'s owner can reclaim the child. WITHOUT ' +
    '`confirm: true` NOTHING IS SENT: the result is the plan (the child\'s rules and what the parent keeps). The operator ' +
    'ceiling H081_MAX_GRANT applies. The agent key sends it (chain sees the agent wallet made a delegation, not amounts, ' +
    'rules or recipient). Needs ~0.02 SOL and the delegate proving artifacts, which the site does not ship yet: put ' +
    'delegate.wasm and delegate.zkey in H081_CIRCUITS_DIR; without them confirm: true is refused before anything is sent ' +
    '(the plan still works). ' + NOTICE_SHORT,
  h081_allowance_reclaim:
    'Take back what is left of an allowance this account granted (to a sub-account or another agent) into its shielded ' +
    'balance: `allowanceId` from h081_bank_balance (`reclaimable: true`; the current id, which changes after every ' +
    'payment). A pledged allowance (a loan) still routes its lender\'s share (pledgeBps) of what is reclaimed. WITHOUT ' +
    '`confirm: true` NOTHING IS SENT: the result is the plan (amount back, lender share). The agent key sends it (chain ' +
    'sees the agent wallet made a payment, not the amount). Needs ~0.02 SOL and the spend circuit. ' + NOTICE_SHORT,
  h081_lend:
    'Lend USDG to another agent against its pledged stream (the lender side of h081_loan_borrow), by `action`: ' +
    '"open" a loan slot owned by the agent key (`pledgeBps`, 100..9000: the share of every borrower payment routed to ' +
    'the slot) and get its "h081-loan-terms:" code to hand to the borrower; "fund" a slot against the borrower\'s ' +
    '"h081-loan-proof:" code (`proofCode`): the code is checked (checksum, network), the proof must be for this slot, ' +
    'USDG and the payout account in the code, not expired, verified locally when stream.vkey.json is present, and backed ' +
    'by a live allowance pledged to this slot; the principal is exactly what the proof backs (the program funds no other ' +
    'amount), leaves the agent wallet\'s public USDG (not the shielded balance), and the borrower receives it minus the ' +
    '0.25% origination fee to the protocol treasury; or "fund" a backed draw (`backingCode`): the plan shows the exact ' +
    'terms and a `planDigest`, and the confirm call must pass that `planDigest` back (the draw is funded only at exactly ' +
    'those terms, so a borrower re-request in between is refused); "status" lists the agent\'s slots (or `loanRef`): funded, repaid, ' +
    'outstanding, claimable, collectable, shortfall, and with `pledgeBps` an open slot\'s terms code again; "claim" ' +
    'pulls the vested lender share of the borrower\'s stream (spend circuit), sized to what the loan still owes; ' +
    '"collect" takes shares already routed to the slot; "settle" closes the books (no shortfall can be reported after); ' +
    '"close" returns a settled slot\'s rent (repayments still in it are collected first); "sweep" takes what reached a ' +
    'closed loan since, up to what it still owes. The lender is never paid more than the principal: anything routed ' +
    'beyond it is the borrower\'s and is sent back to the borrower\'s payout account. WITHOUT `confirm: true` open, ' +
    'fund, settle and close send NOTHING and return the plan. The operator ceiling H081_MAX_LEND caps every loan funded. Risk: repayment is ' +
    'only the pledged share of what the borrower\'s allowance pays, until the principal is repaid; there is no collateral ' +
    'beyond it. Privacy: stream_loan needs the slot owner\'s signature, so the agent key sends every lender action (no ' +
    'relayer): the agent wallet is public as the lender, and the principal and payout account are public; the ' +
    'borrower\'s budget and payments are not. Needs SOL for slot rent and fees (~0.02 SOL to fund). ' + NOTICE_SHORT,
  h081_back:
    'Back another agent\'s credit with a USDG stake (a backed line, docs/BACKER-SPEC.md), by `action`: "open" a line for ' +
    'a borrower\'s "h081-draw-key:" code (`drawKeyCode`) with `feeBps` (your fee, paid first out of its repayments, 0..2000), ' +
    '`maxLenderFeeBps` (the highest lender fee a draw may offer, default 500: the stake covers that fee too), ' +
    '`days` (the line\'s life, 1..180), `maxAdvance` / `maxAdvanceUsdg` per draw and `maxTotal` over the line; `coverBps` ' +
    'defaults to 10000 (the stake covers the lender\'s whole due; mainnet accepts nothing less); returns the "h081-backing:" ' +
    'code to hand the borrower. "stake" moves USDG into the line\'s vault (from the agent wallet, or `fromShielded`: a pool ' +
    'withdraw straight to it; H081_MAX_BACK caps it); "status" lists your lines and their draws; "withdraw" takes free ' +
    'stake (not reserved by draws) to the agent wallet; "close" empties and closes a line with no open draw; "cancel" a ' +
    'request; "release" (anyone) frees the reserve of a finished loan; "forgive" gives up an unrecovered fee or payout; ' +
    '"claim" (anyone, with `backingCode` and `loanRef`) pays a defaulted loan\'s lender out of the stake. Risk: on a default ' +
    'the stake pays the lender\'s shortfall up to the cover; you then get the borrower\'s later repayments until that is ' +
    'recovered. Without a `lender` pin or `cosign`, the borrower could fund its own draw from a second wallet and default; ' +
    'pin a lender or co-sign if that matters. Privacy: the line acts through a fresh key, but the agent wallet pays its fees, so the chain links the line ' +
    'to the agent wallet; stake, terms, the advance and any default are public. WITHOUT `confirm: true` open, stake, ' +
    'withdraw, close, cancel and forgive send NOTHING and return the plan. ' + NOTICE_SHORT,
  h081_back_draw:
    'Borrow against a backed line another agent opened for you, by `action`: "key" gives your "h081-draw-key:" code for ' +
    'line `lineNonce` (read-only; hand it to the backer first); "request" asks the lender of slot `loanRef` for an advance ' +
    '(`advance` / `advanceUsdg`, `lenderFeeBps` up to the line\'s cap, `days` until due, request valid `ttlHours`, default 24) on the ' +
    'line in `backingCode` and returns the "h081-backing:" code to hand the lender (h081_lend fund with backingCode); ' +
    '"cancel" an unfunded request; "repay" (from the draw key\'s account where the advance was paid, or `fromShielded`); ' +
    '"take" moves USDG from the draw key\'s account to the agent wallet; "status" shows the line and the loan. The loan ' +
    'owes advance + backer fee + lender fee; the borrower receives the advance minus the 0.25% origination fee. ' +
    'H081_MAX_DRAW caps an advance. WITHOUT `confirm: true` request, cancel, repay and take send NOTHING and return the ' +
    'plan. ' + NOTICE_SHORT,
  h081_transfer:
    'Pay USDG from this account\'s main shielded balance to another account\'s shielded address, given as its ' +
    '"h081-address:" code (its checksum, kind and network are checked first). Note to note: the amount and the recipient ' +
    'stay hidden on chain. The agent key sends it (there is no public leg a relayer could take a fee from), so the chain ' +
    'shows that the agent wallet used the bank. No relay fee. Sends when called (no plan step). Needs ~0.02 SOL and the ' +
    'transact circuit. Give `amount` (base units) or `usdg` (decimal). ' + NOTICE_SHORT,
};

// ------------------------------------------------------------------ zod

const amountZ = z.string().regex(BASE, 'base units: an integer string');
const decimalZ = z.string().regex(DECIMAL, 'a decimal amount like "12.5"');
const b58Z = z.string().regex(BASE58, 'a base58 Solana address');
const INDEX_MSG = 'must be 0..15 (a sub-account number)';
const indexZ = z.number().int(INDEX_MSG).min(0, INDEX_MSG).max(15, INDEX_MSG);

const exactlyOne = (a: string, b: string) => (o: Record<string, unknown>) => (o[a] !== undefined) !== (o[b] !== undefined);
const oneOfMsg = (a: string, b: string) => ({ message: `give exactly one of "${a}" (base units) or "${b}" (decimal), not both` });

export const DepositZ = z.object({ amount: amountZ.optional(), usdg: decimalZ.optional() }).strict().refine(exactlyOne('amount', 'usdg'), oneOfMsg('amount', 'usdg'));

export const WithdrawZ = z.object({
  amount: amountZ.optional(), usdg: decimalZ.optional(), to: b58Z.optional(), direct: z.boolean().optional(),
}).strict().refine(exactlyOne('amount', 'usdg'), oneOfMsg('amount', 'usdg'));

export const BalanceZ = z.object({}).strict();

export const LoanQuoteZ = z.object({
  termsCode: z.string().optional(),
  minRemaining: amountZ.optional(),
  minRemainingUsdg: decimalZ.optional(),
  pledgeBps: z.number().int().min(1).max(10000).optional(),
  principal: amountZ.optional(),
  principalUsdg: decimalZ.optional(),
  loanRef: z.string().regex(BASE).optional(),
}).strict();

export const LoanBorrowZ = z.object({
  termsCode: z.string().min(1),
  budget: amountZ.optional(), budgetUsdg: decimalZ.optional(),
  dailyCap: amountZ.optional(), dailyCapUsdg: decimalZ.optional(),
  maxPerTx: amountZ.optional(), maxPerTxUsdg: decimalZ.optional(),
  principal: amountZ.optional(), principalUsdg: decimalZ.optional(),
  days: z.number().positive().max(3650),
  unlockDays: z.number().positive().max(3650),
  agentIndex: indexZ.optional(),
}).strict()
  .refine((o) => !(o.budget !== undefined && o.budgetUsdg !== undefined), { message: 'give budget or budgetUsdg, not both' })
  .refine((o) => [o.budget, o.budgetUsdg, o.principal, o.principalUsdg].some((v) => v !== undefined), { message: 'give a budget (budget / budgetUsdg) or a principal (principal / principalUsdg); with only a principal the budget is sized to it' })
  .refine((o) => !(o.principal !== undefined && o.principalUsdg !== undefined), { message: 'give principal or principalUsdg, not both' })
  .refine((o) => o.unlockDays <= o.days, { message: 'unlockDays must not exceed days' });

export const STAKE_ACTIONS = ['view', 'stake', 'request_unstake', 'unstake'] as const;
export const StakeZ = z.object({
  action: z.enum(STAKE_ACTIONS, { errorMap: () => ({ message: `action must be one of ${STAKE_ACTIONS.join(', ')}` }) }),
  amount: amountZ.optional(), h081: decimalZ.optional(),
}).strict().refine((o) => (o.action === 'stake' || o.action === 'request_unstake') ? exactlyOne('amount', 'h081')(o) : (o.amount === undefined && o.h081 === undefined), {
  message: 'stake and request_unstake take exactly one of "amount" (base units) or "h081" (decimal); view and unstake take no amount',
});

export const ProtocolInfoZ = z.object({}).strict();

export const PayZ = z.object({
  amount: amountZ.optional(), usdg: decimalZ.optional(),
  to: b58Z.optional(),
  toAddressCode: z.string().min(1).optional(),
  allowanceId: z.string().regex(BASE, 'the decimal allowance id h081_bank_balance shows').optional(),
  agentIndex: indexZ.optional(),
  direct: z.boolean().optional(),
  allowPledged: z.boolean().optional(),
}).strict()
  .refine(exactlyOne('amount', 'usdg'), oneOfMsg('amount', 'usdg'))
  .refine(exactlyOne('to', 'toAddressCode'), { message: 'give exactly one recipient: "to" (a Solana wallet) or "toAddressCode" (an "h081-address:" code)' })
  .refine((o) => !(o.direct === true && o.toAddressCode !== undefined), { message: 'direct applies to a public payout ("to"); a private payment is always sent by the agent key' });

const atMostOne = (a: string, b: string) => (o: Record<string, unknown>) => !(o[a] !== undefined && o[b] !== undefined);
const bothMsg = (a: string, b: string) => ({ message: `give ${a} or ${b}, not both` });
const posAmountZ = amountZ.refine((s) => BigInt(s) > 0n, 'must be positive');
const posDecimalZ = decimalZ.refine((s) => Number(s) > 0, 'must be positive');
const daysZ = z.number().positive().max(3650);
const idZ = z.string({ required_error: 'allowanceId is required: the decimal id h081_bank_balance shows' }).regex(BASE, 'allowanceId must be the decimal id h081_bank_balance shows');

export const AllowanceGrantZ = z.object({
  amount: amountZ.optional(), usdg: decimalZ.optional(),
  agentIndex: indexZ.optional(),
  toAddressCode: z.string().min(1).optional(),
  windowCap: posAmountZ.optional(), windowCapUsdg: posDecimalZ.optional(),
  windowLen: z.number().int().min(60).max(3650 * 86400).optional(),
  maxPerTx: posAmountZ.optional(), maxPerTxUsdg: posDecimalZ.optional(),
  days: daysZ.optional(),
  unlockDays: daysZ.optional(),
  confirm: z.boolean().optional(),
}).strict()
  .refine(exactlyOne('amount', 'usdg'), oneOfMsg('amount', 'usdg'))
  .refine(atMostOne('agentIndex', 'toAddressCode'), bothMsg('agentIndex (a sub-account)', 'toAddressCode (another agent)'))
  .refine(atMostOne('windowCap', 'windowCapUsdg'), bothMsg('windowCap', 'windowCapUsdg'))
  .refine(atMostOne('maxPerTx', 'maxPerTxUsdg'), bothMsg('maxPerTx', 'maxPerTxUsdg'))
  .refine((o) => o.days === undefined || o.unlockDays === undefined || o.unlockDays <= o.days, { message: 'unlockDays must not exceed days' });

export const AllowanceDelegateZ = z.object({
  allowanceId: idZ,
  agentIndex: indexZ.optional(),
  toAgentIndex: indexZ.optional(),
  toAddressCode: z.string().min(1).optional(),
  amount: amountZ.optional(), usdg: decimalZ.optional(),
  windowCap: posAmountZ.optional(), windowCapUsdg: posDecimalZ.optional(),
  maxPerTx: posAmountZ.optional(), maxPerTxUsdg: posDecimalZ.optional(),
  days: daysZ.optional(),
  unlockDays: daysZ.optional(),
  confirm: z.boolean().optional(),
}).strict()
  .refine(exactlyOne('amount', 'usdg'), oneOfMsg('amount', 'usdg'))
  .refine(exactlyOne('toAgentIndex', 'toAddressCode'), { message: 'give exactly one recipient for the child: "toAgentIndex" (a sub-account) or "toAddressCode" (another agent\'s "h081-address:" code)' })
  .refine(atMostOne('windowCap', 'windowCapUsdg'), bothMsg('windowCap', 'windowCapUsdg'))
  .refine(atMostOne('maxPerTx', 'maxPerTxUsdg'), bothMsg('maxPerTx', 'maxPerTxUsdg'))
  .refine((o) => o.days === undefined || o.unlockDays === undefined || o.unlockDays <= o.days, { message: 'unlockDays must not exceed days' });

export const AllowanceReclaimZ = z.object({ allowanceId: idZ, confirm: z.boolean().optional() }).strict();

export const LEND_ACTIONS = ['open', 'fund', 'status', 'claim', 'collect', 'settle', 'close', 'sweep'] as const;
export const LEND_FIELDS: Record<(typeof LEND_ACTIONS)[number], string[]> = {
  open: ['pledgeBps', 'confirm'],
  fund: ['proofCode', 'backingCode', 'minCoverBps', 'planDigest', 'loanRef', 'principal', 'principalUsdg', 'pledgeBps', 'confirm'],
  status: ['loanRef', 'pledgeBps'],
  claim: ['loanRef', 'amount', 'usdg'],
  collect: ['loanRef'],
  settle: ['loanRef', 'confirm'],
  close: ['loanRef', 'confirm'],
  sweep: ['loanRef'],
};
export const LendZ = z.object({
  action: z.enum(LEND_ACTIONS, { errorMap: () => ({ message: `action must be one of ${LEND_ACTIONS.join(', ')}` }) }),
  pledgeBps: z.number().int().min(100, 'pledgeBps must be 100..9000 (1% to 90%)').max(9000, 'pledgeBps must be 100..9000 (1% to 90%)').optional(),
  proofCode: z.string().min(1).optional(),
  backingCode: z.string().min(1).optional(),
  minCoverBps: z.number().int().min(2000, 'minCoverBps must be 2000..10000').max(10000, 'minCoverBps must be 2000..10000').optional(),
  planDigest: z.string().regex(/^[0-9a-f]{16}$/, 'planDigest must be the 16 hex characters the fund plan returned').optional(),
  loanRef: z.string().regex(BASE, 'loanRef must be a non-negative integer (the loan slot number)').optional(),
  principal: posAmountZ.optional(), principalUsdg: posDecimalZ.optional(),
  amount: posAmountZ.optional(), usdg: posDecimalZ.optional(),
  confirm: z.boolean().optional(),
}).strict()
  .refine((o) => Object.keys(o).every((k) => k === 'action' || LEND_FIELDS[o.action].includes(k)), {
    message: `each action takes only its own fields: ${LEND_ACTIONS.map((a) => `${a} (${LEND_FIELDS[a].join(', ')})`).join('; ')}`,
  })
  .refine((o) => o.action !== 'open' || o.pledgeBps !== undefined, { message: 'pledgeBps is required: open needs pledgeBps (100..9000)' })
  .refine((o) => o.action !== 'fund' || (o.proofCode !== undefined) !== (o.backingCode !== undefined), { message: 'proofCode (the borrower\'s "h081-loan-proof:" code) is required: fund needs exactly one of proofCode or backingCode (an "h081-backing:" code for a backed draw)' })
  .refine((o) => o.backingCode !== undefined || (o.minCoverBps === undefined), { message: 'minCoverBps applies to a backed draw (backingCode) only' })
  .refine((o) => o.backingCode !== undefined || (o.planDigest === undefined), { message: 'planDigest applies to a backed draw (backingCode) only' })
  .refine((o) => o.backingCode === undefined || o.confirm !== true || o.planDigest !== undefined, { message: 'planDigest is required to confirm a backed fund: call fund without confirm first, then confirm with the planDigest the plan returned' })
  .refine((o) => o.backingCode === undefined || (o.principal === undefined && o.principalUsdg === undefined && o.pledgeBps === undefined), { message: 'a backed draw (backingCode) takes no principal or pledgeBps: the lender funds exactly the draw on chain' })
  .refine((o) => !['claim', 'collect', 'settle', 'close', 'sweep'].includes(o.action) || o.loanRef !== undefined, { message: 'loanRef is required: claim, collect, settle, close and sweep need loanRef (the loan slot number)' })
  .refine(atMostOne('principal', 'principalUsdg'), bothMsg('principal', 'principalUsdg'))
  .refine(atMostOne('amount', 'usdg'), bothMsg('amount', 'usdg'));

export const TransferZ = z.object({
  amount: amountZ.optional(), usdg: decimalZ.optional(),
  toAddressCode: z.string({ required_error: 'must be given: the recipient\'s "h081-address:" code' }).min(1),
}).strict().refine(exactlyOne('amount', 'usdg'), oneOfMsg('amount', 'usdg'));

const nonceZ = z.string().regex(BASE, 'must be a positive integer string (the line number)');
const loanRefZ = z.string().regex(BASE, 'loanRef must be a non-negative integer (the loan slot number)');
export const BACK_ACTIONS = ['open', 'stake', 'status', 'withdraw', 'close', 'cancel', 'release', 'forgive', 'claim'] as const;
export const BACK_FIELDS: Record<(typeof BACK_ACTIONS)[number], string[]> = {
  open: ['drawKeyCode', 'coverBps', 'feeBps', 'maxLenderFeeBps', 'days', 'maxAdvance', 'maxAdvanceUsdg', 'maxTotal', 'maxTotalUsdg', 'lender', 'cosign', 'allowPartialCover', 'nonce', 'confirm'],
  stake: ['nonce', 'amount', 'usdg', 'fromShielded', 'confirm'],
  status: ['nonce'],
  withdraw: ['nonce', 'amount', 'usdg', 'confirm'],
  close: ['nonce', 'confirm'],
  cancel: ['nonce', 'loanRef', 'confirm'],
  release: ['nonce', 'loanRef'],
  forgive: ['nonce', 'loanRef', 'confirm'],
  claim: ['backingCode', 'loanRef'],
};
export const BackZ = z.object({
  action: z.enum(BACK_ACTIONS, { errorMap: () => ({ message: `action must be one of ${BACK_ACTIONS.join(', ')}` }) }),
  drawKeyCode: z.string().min(1).optional(), backingCode: z.string().min(1).optional(),
  coverBps: z.number().int().min(2000, 'coverBps must be 2000..10000').max(10000, 'coverBps must be 2000..10000').optional(),
  feeBps: z.number().int().min(0, 'feeBps must be 0..2000').max(2000, 'feeBps must be 0..2000').optional(),
  maxLenderFeeBps: z.number().int().min(0, 'maxLenderFeeBps must be 0..2000').max(2000, 'maxLenderFeeBps must be 0..2000').optional(),
  days: z.number().positive('days must be positive').max(180, 'days must be at most 180').optional(),
  maxAdvance: posAmountZ.optional(), maxAdvanceUsdg: posDecimalZ.optional(), maxTotal: posAmountZ.optional(), maxTotalUsdg: posDecimalZ.optional(),
  lender: b58Z.optional(), cosign: z.boolean().optional(), allowPartialCover: z.boolean().optional(), fromShielded: z.boolean().optional(),
  nonce: nonceZ.optional(), loanRef: loanRefZ.optional(), amount: posAmountZ.optional(), usdg: posDecimalZ.optional(), confirm: z.boolean().optional(),
}).strict()
  .refine((o) => Object.keys(o).every((k) => k === 'action' || BACK_FIELDS[o.action].includes(k)), {
    message: `each action takes only its own fields: ${BACK_ACTIONS.map((a) => `${a} (${BACK_FIELDS[a].join(', ')})`).join('; ')}`,
  })
  .refine((o) => o.action !== 'open' || (o.drawKeyCode !== undefined && o.feeBps !== undefined && o.days !== undefined && (o.maxAdvance !== undefined) !== (o.maxAdvanceUsdg !== undefined)), { message: 'open needs drawKeyCode, feeBps, days and one of maxAdvance / maxAdvanceUsdg' })
  .refine((o) => !['stake', 'withdraw', 'close', 'cancel', 'release', 'forgive'].includes(o.action) || o.nonce !== undefined, { message: 'nonce (the line number h081_back status shows) is required' })
  .refine((o) => !['cancel', 'release', 'forgive'].includes(o.action) || o.loanRef !== undefined, { message: 'loanRef is required: the loan slot the draw is on' })
  .refine((o) => o.action !== 'stake' || (o.amount !== undefined) !== (o.usdg !== undefined), oneOfMsg('amount', 'usdg'))
  .refine((o) => o.action !== 'claim' || o.backingCode !== undefined, { message: 'claim needs backingCode (and loanRef unless the code carries it)' })
  .refine(atMostOne('amount', 'usdg'), bothMsg('amount', 'usdg'))
  .refine(atMostOne('maxTotal', 'maxTotalUsdg'), bothMsg('maxTotal', 'maxTotalUsdg'));

export const DRAW_ACTIONS = ['key', 'request', 'cancel', 'repay', 'take', 'status'] as const;
export const DRAW_FIELDS: Record<(typeof DRAW_ACTIONS)[number], string[]> = {
  key: ['lineNonce'],
  request: ['backingCode', 'lineNonce', 'loanRef', 'advance', 'advanceUsdg', 'lenderFeeBps', 'days', 'ttlHours', 'allowHighFees', 'confirm'],
  cancel: ['backingCode', 'lineNonce', 'loanRef', 'confirm'],
  repay: ['backingCode', 'lineNonce', 'loanRef', 'amount', 'usdg', 'fromShielded', 'confirm'],
  take: ['lineNonce', 'amount', 'usdg', 'confirm'],
  status: ['backingCode', 'loanRef'],
};
export const BackDrawZ = z.object({
  action: z.enum(DRAW_ACTIONS, { errorMap: () => ({ message: `action must be one of ${DRAW_ACTIONS.join(', ')}` }) }),
  backingCode: z.string().min(1).optional(), lineNonce: nonceZ.optional(), loanRef: loanRefZ.optional(),
  advance: posAmountZ.optional(), advanceUsdg: posDecimalZ.optional(),
  lenderFeeBps: z.number().int().min(0, 'lenderFeeBps must be 0..2000').max(2000, 'lenderFeeBps must be 0..2000').optional(),
  days: z.number().positive('days must be positive').max(180, 'days must be at most 180').optional(),
  ttlHours: z.number().positive('ttlHours must be positive').max(168, 'ttlHours must be at most 168 (7 days)').optional(),
  allowHighFees: z.boolean().optional(), fromShielded: z.boolean().optional(),
  amount: posAmountZ.optional(), usdg: posDecimalZ.optional(), confirm: z.boolean().optional(),
}).strict()
  .refine((o) => Object.keys(o).every((k) => k === 'action' || DRAW_FIELDS[o.action].includes(k)), {
    message: `each action takes only its own fields: ${DRAW_ACTIONS.map((a) => `${a} (${DRAW_FIELDS[a].join(', ')})`).join('; ')}`,
  })
  .refine((o) => o.action !== 'request' || (o.backingCode !== undefined && o.loanRef !== undefined && o.days !== undefined && (o.advance !== undefined) !== (o.advanceUsdg !== undefined)), { message: 'request needs backingCode, loanRef, days and one of advance / advanceUsdg' })
  .refine((o) => !['cancel', 'repay', 'status'].includes(o.action) || o.backingCode !== undefined, { message: 'backingCode is required' })
  .refine((o) => !['repay', 'take'].includes(o.action) || (o.amount !== undefined) !== (o.usdg !== undefined), oneOfMsg('amount', 'usdg'));

export const ZOD: Record<OpName, z.ZodType<any>> = {
  h081_bank_deposit: DepositZ, h081_bank_withdraw: WithdrawZ, h081_bank_balance: BalanceZ, h081_loan_quote: LoanQuoteZ,
  h081_loan_borrow: LoanBorrowZ, h081_stake: StakeZ, h081_protocol_info: ProtocolInfoZ, h081_pay: PayZ,
  h081_allowance_grant: AllowanceGrantZ, h081_allowance_delegate: AllowanceDelegateZ, h081_allowance_reclaim: AllowanceReclaimZ,
  h081_lend: LendZ, h081_transfer: TransferZ, h081_back: BackZ, h081_back_draw: BackDrawZ,
};

// ------------------------------------------------------------------ JSON Schema (MCP inputSchema)

const amountJ = { type: 'string', pattern: BASE.source, description: 'base units (USDG has 6 decimals): "1000000" = 1 USDG' };
const decimalJ = (unit: string) => ({ type: 'string', pattern: DECIMAL.source, description: `decimal ${unit} amount, e.g. "12.5"` });
const b58J = { type: 'string', pattern: BASE58.source, description: 'base58 Solana wallet address' };

export const JSON_SCHEMA: Record<OpName, Record<string, unknown>> = {
  h081_bank_deposit: {
    type: 'object',
    properties: { amount: amountJ, usdg: decimalJ('USDG') },
    additionalProperties: false,
    description: 'exactly one of amount (base units) or usdg (decimal)',
  },
  h081_bank_withdraw: {
    type: 'object',
    properties: {
      amount: amountJ, usdg: decimalJ('USDG'),
      to: { ...b58J, description: 'recipient wallet (default: the agent wallet); must be a wallet, not a token account or program' },
      direct: { type: 'boolean', description: 'true: the agent key sends the withdrawal itself (no relay fee, no free-tier limit, sender visible on chain); default false: through the relayer, refused (not sent) when the relayer is unavailable' },
    },
    additionalProperties: false,
    description: 'exactly one of amount (base units) or usdg (decimal)',
  },
  h081_bank_balance: { type: 'object', properties: {}, additionalProperties: false },
  h081_loan_quote: {
    type: 'object',
    properties: {
      termsCode: { type: 'string', description: 'a lender\'s "h081-loan-terms:" code (gives pledgeBps and the slot)' },
      minRemaining: { ...amountJ, description: 'the allowance budget the proof will state (base units)' },
      minRemainingUsdg: decimalJ('USDG'),
      pledgeBps: { type: 'integer', minimum: 1, maximum: 10000, description: 'share of every payment routed to the lender, basis points' },
      principal: { ...amountJ, description: 'a principal to price (base units); default: the maximum' },
      principalUsdg: decimalJ('USDG'),
      loanRef: { type: 'string', pattern: BASE.source, description: 'loan slot number to read on chain' },
    },
    additionalProperties: false,
  },
  h081_loan_borrow: {
    type: 'object',
    properties: {
      termsCode: { type: 'string', description: 'the lender\'s "h081-loan-terms:" code' },
      budget: { ...amountJ, description: 'allowance budget taken from the shielded balance (base units); with a principal: default and maximum principal * 10000 / pledgeBps' },
      budgetUsdg: decimalJ('USDG'),
      dailyCap: { ...amountJ, description: 'most the sub-account may pay per day (base units); default: no daily cap' },
      dailyCapUsdg: decimalJ('USDG'),
      maxPerTx: { ...amountJ, description: 'most per payment (base units); default: no per-payment cap' },
      maxPerTxUsdg: decimalJ('USDG'),
      principal: { ...amountJ, description: 'the loan amount asked for (base units): the lender must fund exactly this; at most budget * pledgeBps / 10000. Default: that maximum' },
      principalUsdg: decimalJ('USDG'),
      days: { type: 'number', exclusiveMinimum: 0, maximum: 3650, description: 'lifetime of the allowance in days' },
      unlockDays: { type: 'number', exclusiveMinimum: 0, maximum: 3650, description: 'the budget unlocks linearly over this many days (<= days)' },
      agentIndex: { type: 'integer', minimum: 0, maximum: 15, description: 'which sub-account to use (default: the first free one)' },
    },
    required: ['termsCode', 'days', 'unlockDays'],
    additionalProperties: false,
    description: 'a budget (budget or budgetUsdg) and/or a principal (principal or principalUsdg); with a principal the budget defaults to exactly what it needs and a larger one is refused',
  },
  h081_stake: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...STAKE_ACTIONS] },
      amount: { ...amountJ, description: 'base units (H081 has 6 decimals), for stake / request_unstake' },
      h081: decimalJ('H081'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  h081_protocol_info: { type: 'object', properties: {}, additionalProperties: false },
  h081_pay: {
    type: 'object',
    properties: {
      amount: { ...amountJ, description: 'taken out of the allowance (base units); a pledged allowance routes its lender share out of it' }, usdg: decimalJ('USDG'),
      to: { ...b58J, description: 'public payout to this Solana wallet (its USDG account); must be a wallet, not a token account or program' },
      toAddressCode: { type: 'string', description: 'private payment to this shielded H081 address: the recipient\'s "h081-address:" code (h081_bank_balance shows this agent\'s own as shieldedAddressCode)' },
      allowanceId: { type: 'string', pattern: BASE.source, description: 'the allowance to spend, its id from h081_bank_balance (agentAllowances, or subAccounts with agentIndex); default: picked automatically' },
      agentIndex: { type: 'integer', minimum: 0, maximum: 15, description: 'spend an allowance held by this sub-account (default: allowances granted to this account)' },
      direct: { type: 'boolean', description: 'public payout only. true: the agent key sends it (no relay fee, sender visible on chain); default false: through the relayer, refused (not sent) when the relayer is unavailable' },
      allowPledged: { type: 'boolean', description: 'default false: a pledged (loan) allowance is never used. true accepts one, whose loan slot and lender share go on chain next to the payment, linking the recipient to the borrower wallet and revealing the gross amount' },
    },
    additionalProperties: false,
    description: 'exactly one of amount (base units) or usdg (decimal), and exactly one of to (wallet, public) or toAddressCode (shielded, private)',
  },
  h081_allowance_grant: {
    type: 'object',
    properties: {
      amount: { ...amountJ, description: 'the lifetime budget, taken out of the shielded balance (base units)' }, usdg: decimalJ('USDG'),
      agentIndex: { type: 'integer', minimum: 0, maximum: 15, description: 'grant to this sub-account of the agent (default, without toAddressCode: the first free one)' },
      toAddressCode: { type: 'string', description: 'grant to another agent: its "h081-address:" code (its h081_bank_balance shows it as shieldedAddressCode)' },
      windowCap: { ...amountJ, description: 'most it may pay per window (base units); default: no window cap' }, windowCapUsdg: decimalJ('USDG'),
      windowLen: { type: 'integer', minimum: 60, maximum: 3650 * 86400, description: 'the window in seconds (default 86400: windowCap is a daily cap)' },
      maxPerTx: { ...amountJ, description: 'most per payment (base units); default: no per-payment cap' }, maxPerTxUsdg: decimalJ('USDG'),
      days: { type: 'number', exclusiveMinimum: 0, maximum: 3650, description: 'lifetime in days; default: no expiry' },
      unlockDays: { type: 'number', exclusiveMinimum: 0, maximum: 3650, description: 'stream: the budget unlocks linearly over this many days (<= days); default: all of it at once' },
      confirm: { type: 'boolean', description: 'true: send it. Default false: nothing is sent, the result is the plan of exactly what would be granted' },
    },
    additionalProperties: false,
    description: 'exactly one of amount (base units) or usdg (decimal); at most one of agentIndex / toAddressCode',
  },
  h081_allowance_delegate: {
    type: 'object',
    properties: {
      allowanceId: { type: 'string', pattern: BASE.source, description: 'the parent: an allowance this agent holds, its current id from h081_bank_balance' },
      agentIndex: { type: 'integer', minimum: 0, maximum: 15, description: 'the parent is held by this sub-account (default: this account; with an id, sub-accounts in use are searched too)' },
      toAgentIndex: { type: 'integer', minimum: 0, maximum: 15, description: 'the child goes to this sub-account' },
      toAddressCode: { type: 'string', description: 'the child goes to another agent: its "h081-address:" code' },
      amount: { ...amountJ, description: 'the child\'s budget (base units), at most what the parent has left' }, usdg: decimalJ('USDG'),
      windowCap: { ...amountJ, description: 'the child\'s per-window cap (base units), shared out of the parent\'s; default: in proportion to the amount' }, windowCapUsdg: decimalJ('USDG'),
      maxPerTx: { ...amountJ, description: 'the child\'s per-payment cap (base units), at most the parent\'s; default: the parent\'s' }, maxPerTxUsdg: decimalJ('USDG'),
      days: { type: 'number', exclusiveMinimum: 0, maximum: 3650, description: 'the child\'s lifetime in days, never past the parent\'s expiry; default: the parent\'s expiry' },
      unlockDays: { type: 'number', exclusiveMinimum: 0, maximum: 3650, description: 'the child unlocks linearly over this many days, never faster than the parent; default: in proportion to the parent\'s stream (if it streams)' },
      confirm: { type: 'boolean', description: 'true: send it. Default false: nothing is sent, the result is the plan (the child\'s rules and what the parent keeps)' },
    },
    required: ['allowanceId'],
    additionalProperties: false,
    description: 'exactly one of amount (base units) or usdg (decimal), and exactly one of toAgentIndex or toAddressCode',
  },
  h081_allowance_reclaim: {
    type: 'object',
    properties: {
      allowanceId: { type: 'string', pattern: BASE.source, description: 'an allowance this account granted (reclaimable: true in h081_bank_balance), its current id' },
      confirm: { type: 'boolean', description: 'true: send it. Default false: nothing is sent, the result is the plan' },
    },
    required: ['allowanceId'],
    additionalProperties: false,
  },
  h081_lend: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...LEND_ACTIONS], description: 'open a slot, fund it against a borrower proof, status, claim the vested share (up to what is owed), collect routed shares, settle, close, sweep a closed loan' },
      pledgeBps: { type: 'integer', minimum: 100, maximum: 9000, description: 'open: the share of every borrower payment routed to the slot (basis points). fund: the least share the proof must pledge. status: show an open slot terms code with this share' },
      proofCode: { type: 'string', description: 'fund: the borrower proof code, "h081-loan-proof:..." (from h081_loan_borrow)' },
      backingCode: { type: 'string', description: 'fund: instead of proofCode, an "h081-backing:" code for a backed draw (from h081_back_draw request)' },
      minCoverBps: { type: 'integer', minimum: 2000, maximum: 10000, description: 'fund with backingCode: the least cover you accept (default 10000)' },
      planDigest: { type: 'string', pattern: '^[0-9a-f]{16}$', description: 'fund with backingCode and confirm: the planDigest the plan returned; the draw is funded only at exactly those terms' },
      loanRef: { type: 'string', pattern: BASE.source, description: 'the loan slot number; status without it lists every slot of this agent; fund defaults to the slot in the proof code' },
      principal: { ...amountJ, description: 'fund: the amount you expect to lend (base units); refused unless it is exactly what the proof backs. Default: what the proof backs' },
      principalUsdg: decimalJ('USDG'),
      amount: { ...amountJ, description: 'claim: at most this much (base units); default: everything claimable now, capped at what the loan still owes' },
      usdg: decimalJ('USDG'),
      confirm: { type: 'boolean', description: 'open, fund, settle, close: true sends it. Default false: nothing is sent, the result is the plan' },
    },
    required: ['action'],
    additionalProperties: false,
    description: 'open needs pledgeBps; fund needs proofCode or backingCode; claim, collect, settle and close need loanRef; each action takes only its own fields',
  },
  h081_back: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...BACK_ACTIONS], description: 'open a line, stake, status, withdraw free stake, close, cancel a request, release a finished loan, forgive, claim a default for the lender' },
      drawKeyCode: { type: 'string', description: 'open: the borrower\'s "h081-draw-key:" code' },
      coverBps: { type: 'integer', minimum: 2000, maximum: 10000, description: 'open: share of the lender\'s due the stake covers (default 10000; mainnet accepts only 10000)' },
      feeBps: { type: 'integer', minimum: 0, maximum: 2000, description: 'open: your fee on each advance, paid first out of repayments' },
      maxLenderFeeBps: { type: 'integer', minimum: 0, maximum: 2000, description: 'open: the highest lender fee a draw may offer (default 500); the stake covers that fee too' },
      days: { type: 'number', exclusiveMinimum: 0, maximum: 180, description: 'open: the line\'s life in days; every backed loan must be due by then' },
      maxAdvance: { ...amountJ, description: 'open: the largest advance per draw (base units)' }, maxAdvanceUsdg: decimalJ('USDG'),
      maxTotal: { ...amountJ, description: 'open: the most the line advances in all (base units; default maxAdvance)' }, maxTotalUsdg: decimalJ('USDG'),
      lender: { ...b58J, description: 'open: pin the line to one lender wallet (default any)' },
      cosign: { type: 'boolean', description: 'open: every request also needs this agent\'s line key' },
      allowPartialCover: { type: 'boolean', description: 'open: accept coverBps below 10000 (localnet only on v1)' },
      fromShielded: { type: 'boolean', description: 'stake: from the shielded balance (a pool withdraw to the line) instead of the agent wallet' },
      nonce: { type: 'string', pattern: BASE.source, description: 'the line number (status lists them); open picks the next free one by default' },
      loanRef: { type: 'string', pattern: BASE.source, description: 'cancel, release, forgive, claim: the loan slot of the draw' },
      backingCode: { type: 'string', description: 'claim: the "h081-backing:" code of the line' },
      amount: { ...amountJ, description: 'stake, withdraw: base units' }, usdg: decimalJ('USDG'),
      confirm: { type: 'boolean', description: 'true sends it. Default false: nothing is sent, the result is the plan' },
    },
    required: ['action'],
    additionalProperties: false,
    description: 'each action takes only its own fields',
  },
  h081_back_draw: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...DRAW_ACTIONS], description: 'key (your draw-key code), request an advance, cancel it, repay, take the advance to the agent wallet, status' },
      backingCode: { type: 'string', description: 'the "h081-backing:" code the backer gave you' },
      lineNonce: { type: 'string', pattern: BASE.source, description: 'which of your draw keys (default 1)' },
      loanRef: { type: 'string', pattern: BASE.source, description: 'request: the lender\'s open loan slot' },
      advance: { ...amountJ, description: 'request: the advance (base units)' }, advanceUsdg: decimalJ('USDG'),
      lenderFeeBps: { type: 'integer', minimum: 0, maximum: 2000, description: 'request: the lender\'s fee on the advance' },
      days: { type: 'number', exclusiveMinimum: 0, maximum: 180, description: 'request: days from funding until the loan is due' },
      ttlHours: { type: 'number', exclusiveMinimum: 0, maximum: 168, description: 'request: how long the lender may fund it (default 24)' },
      allowHighFees: { type: 'boolean', description: 'request: accept fees above 10% of the advance' },
      fromShielded: { type: 'boolean', description: 'repay: from the shielded balance (a pool withdraw to the loan)' },
      amount: { ...amountJ, description: 'repay, take: base units' }, usdg: decimalJ('USDG'),
      confirm: { type: 'boolean', description: 'true sends it. Default false: nothing is sent, the result is the plan' },
    },
    required: ['action'],
    additionalProperties: false,
    description: 'each action takes only its own fields',
  },
  h081_transfer: {
    type: 'object',
    properties: {
      amount: { ...amountJ, description: 'taken out of the main shielded balance (base units)' }, usdg: decimalJ('USDG'),
      toAddressCode: { type: 'string', description: 'the recipient\'s "h081-address:" code (its h081_bank_balance shows it as shieldedAddressCode)' },
    },
    required: ['toAddressCode'],
    additionalProperties: false,
    description: 'exactly one of amount (base units) or usdg (decimal), and the recipient\'s address code',
  },
};

/** Example inputs (one per operation) that the schemas accept; the plugin's action examples and tests use them. */
export const EXAMPLE_INPUTS: Record<OpName, Record<string, unknown>[]> = {
  h081_bank_deposit: [{ usdg: '25' }, { amount: '1000000' }],
  h081_bank_withdraw: [{ usdg: '10' }, { amount: '5000000', to: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv', direct: true }],
  h081_bank_balance: [{}],
  h081_loan_quote: [{ pledgeBps: 4000, minRemainingUsdg: '100' }, { loanRef: '3' }],
  h081_loan_borrow: [{ termsCode: 'h081-loan-terms:4mD9qXw7Lc2bTzKfP8vRj', budgetUsdg: '100', dailyCapUsdg: '20', maxPerTxUsdg: '10', days: 30, unlockDays: 30 }],
  h081_stake: [{ action: 'view' }, { action: 'stake', h081: '100' }, { action: 'request_unstake', amount: '100000000' }, { action: 'unstake' }],
  h081_protocol_info: [{}],
  h081_pay: [
    { usdg: '2.5', to: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv' },
    { usdg: '1', toAddressCode: 'h081-address:2Q4hfqVf8dZ3vSt6EzNw3hMKx5mT1nJxkPZfFh9cYbLwRb7uA2gE5sQ1rVhC7jYtUe2kWxN8pD6mHf3LzR9aB4cXv', agentIndex: 0 },
    { amount: '5000000', to: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv', allowanceId: '12345', direct: true },
  ],
  h081_allowance_grant: [
    { usdg: '50', agentIndex: 1, windowCapUsdg: '10', maxPerTxUsdg: '2', days: 30 },
    { usdg: '50', agentIndex: 1, windowCapUsdg: '10', maxPerTxUsdg: '2', days: 30, confirm: true },
    { usdg: '20', toAddressCode: 'h081-address:2Q4hfqVf8dZ3vSt6EzNw3hMKx5mT1nJxkPZfFh9cYbLwRb7uA2gE5sQ1rVhC7jYtUe2kWxN8pD6mHf3LzR9aB4cXv', unlockDays: 10, days: 30, confirm: true },
  ],
  h081_allowance_delegate: [
    { allowanceId: '12345', agentIndex: 1, toAgentIndex: 2, usdg: '10', maxPerTxUsdg: '1' },
    { allowanceId: '12345', toAddressCode: 'h081-address:2Q4hfqVf8dZ3vSt6EzNw3hMKx5mT1nJxkPZfFh9cYbLwRb7uA2gE5sQ1rVhC7jYtUe2kWxN8pD6mHf3LzR9aB4cXv', amount: '5000000', days: 7, confirm: true },
  ],
  h081_allowance_reclaim: [{ allowanceId: '12345' }, { allowanceId: '12345', confirm: true }],
  h081_lend: [
    { action: 'open', pledgeBps: 4000 },
    { action: 'open', pledgeBps: 4000, confirm: true },
    { action: 'fund', proofCode: 'h081-loan-proof:3vQB7B6MrGQZaxCuFg4oh', principalUsdg: '40' },
    { action: 'fund', proofCode: 'h081-loan-proof:3vQB7B6MrGQZaxCuFg4oh', confirm: true },
    { action: 'fund', backingCode: 'h081-backing:7mZb3Lq9Xc2Wn4Rt' },
    { action: 'fund', backingCode: 'h081-backing:7mZb3Lq9Xc2Wn4Rt', planDigest: '3f9a0c41d2e87b65', confirm: true },
    { action: 'status' },
    { action: 'status', loanRef: '3', pledgeBps: 4000 },
    { action: 'claim', loanRef: '3' },
    { action: 'collect', loanRef: '3' },
    { action: 'settle', loanRef: '3', confirm: true },
    { action: 'sweep', loanRef: '3' },
  ],
  h081_transfer: [{ usdg: '1', toAddressCode: 'h081-address:2Q4hfqVf8dZ3vSt6EzNw3hMKx5mT1nJxkPZfFh9cYbLwRb7uA2gE5sQ1rVhC7jYtUe2kWxN8pD6mHf3LzR9aB4cXv' }],
  h081_back: [
    { action: 'open', drawKeyCode: 'h081-draw-key:5vQB7B6MrGQZaxCuFg4oh', feeBps: 500, days: 30, maxAdvanceUsdg: '500' },
    { action: 'stake', nonce: '1', usdg: '600', confirm: true },
    { action: 'status' },
    { action: 'release', nonce: '1', loanRef: '3' },
    { action: 'claim', backingCode: 'h081-backing:7mZb3Lq9Xc2Wn4Rt', loanRef: '3' },
    { action: 'close', nonce: '1', confirm: true },
  ],
  h081_back_draw: [
    { action: 'key' },
    { action: 'request', backingCode: 'h081-backing:7mZb3Lq9Xc2Wn4Rt', loanRef: '3', advanceUsdg: '500', lenderFeeBps: 300, days: 14 },
    { action: 'repay', backingCode: 'h081-backing:7mZb3Lq9Xc2Wn4Rt', loanRef: '3', usdg: '540', confirm: true },
    { action: 'status', backingCode: 'h081-backing:7mZb3Lq9Xc2Wn4Rt' },
  ],
};
