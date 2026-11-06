import { makeAction } from './factory.js';

const CODE = 'h081-address:2Q4hfqVf8dZ3vSt6EzNw3hMKx5mT1nJxkPZfFh9cYbLwRb7uA2gE5sQ1rVhC7jYtUe2kWxN8pD6mHf3LzR9aB4cXv';

export const allowanceGrantAction = makeAction({
  op: 'h081_allowance_grant',
  name: 'H081_ALLOWANCE_GRANT',
  similes: ['give a sub-agent a budget', 'grant an h081 allowance', 'set a daily spending cap for an agent', 'fund a sub-account', 'give another agent a private budget', 'stream a budget to an agent'],
  examples: [[
    {
      input: { usdg: '50', agentIndex: 1, windowCapUsdg: '10', maxPerTxUsdg: '2', days: 30 },
      output: {
        status: 'success', sent: false, dryRun: true,
        plan: { action: 'grant', to: 'sub-account 1', agentIndex: 1, rules: { amount: '50000000', amountUsdg: '50', windowCapUsdg: '10', windowLen: '86400', maxPerTxUsdg: '2', expiresAt: '2026-12-06T…' }, shieldedAfterUsdg: '25' },
        next: 'nothing was sent. Call h081_allowance_grant again with the same arguments and confirm: true to send exactly this.',
      },
      explanation: 'Without confirm nothing is sent: the plan shows exactly the allowance that would be granted (50 USDG for 30 days, at most 10 USDG a day and 2 USDG per payment).',
    },
    {
      input: { usdg: '20', toAddressCode: CODE, unlockDays: 10, days: 30, confirm: true },
      output: { status: 'success', sent: true, signature: '4Ty…', to: 'another agent\'s shielded address', allowanceId: '9921…', rules: { amountUsdg: '20', unlocksPerDayUsdg: '2.000001' }, shieldedUsdg: '5' },
      explanation: 'Grant another agent 20 USDG that unlocks over 10 days; it sees the allowance in its own balance and spends it with h081_pay. This account can reclaim what is left.',
    },
  ]],
});

export const allowanceDelegateAction = makeAction({
  op: 'h081_allowance_delegate',
  name: 'H081_ALLOWANCE_DELEGATE',
  similes: ['give a sub-agent part of my allowance', 'delegate an h081 allowance', 'carve a child budget', 'split my allowance', 'sub-delegate spending'],
  examples: [[
    {
      input: { allowanceId: '12345', agentIndex: 1, toAgentIndex: 2, usdg: '10', maxPerTxUsdg: '1' },
      output: {
        status: 'success', sent: false, dryRun: true,
        plan: { action: 'delegate', parentId: '12345', parentAgentIndex: 1, to: 'sub-account 2', child: { amountUsdg: '10', maxPerTxUsdg: '1', windowCapUsdg: '2' }, parentKeeps: { amountUsdg: '40', windowCapUsdg: '7.999997' } },
        next: 'nothing was sent. Call h081_allowance_delegate again with the same arguments and confirm: true to send exactly this.',
      },
      explanation: 'Plan a 10 USDG child of sub-account 1\'s allowance for sub-account 2, at most 1 USDG per payment; its daily cap is shared out of the parent\'s.',
    },
    {
      input: { allowanceId: '12345', toAgentIndex: 2, usdg: '100' },
      output: { status: 'error', message: 'the parent has 50 USDG left; a child can never get more than its parent has. Nothing was sent.' },
      explanation: 'A child can never be looser than its parent: the limit is named and nothing is sent.',
    },
  ]],
});

export const allowanceReclaimAction = makeAction({
  op: 'h081_allowance_reclaim',
  name: 'H081_ALLOWANCE_RECLAIM',
  similes: ['take back an allowance', 'revoke an h081 allowance', 'cancel a sub-agent budget', 'reclaim unspent budget'],
  examples: [[
    {
      input: { allowanceId: '12345', confirm: true },
      output: { status: 'success', sent: true, signature: '2Hd…', allowanceId: '12345', reclaimed: '30000000', reclaimedUsdg: '30', lenderShare: '0', shieldedUsdg: '55' },
      explanation: 'Take back the 30 USDG left of an allowance this account granted; it returns to the shielded balance.',
    },
  ]],
});
