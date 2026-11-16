import { makeAction } from './factory.js';

export const backAction = makeAction({
  op: 'h081_back',
  name: 'H081_BACK',
  similes: ['back an agent', 'sponsor an agent', 'stake behind a borrower', 'open a backed line', 'vouch for an agent with a stake', 'claim a backed default', 'close a backed line'],
  examples: [[
    {
      input: { action: 'open', drawKeyCode: 'h081-draw-key:5vQB7…', feeBps: 500, days: 30, maxAdvanceUsdg: '500' },
      output: {
        status: 'success', sent: false, dryRun: true,
        plan: { action: 'open', nonce: '1', coverPercent: 100, feeBps: 500, maxAdvanceUsdg: '500', risk: 'if the borrower defaults, the stake pays the lender up to 100% of what it is due' },
        next: 'nothing was sent. Call h081_back again with action "open", the same fields and confirm: true; then stake with action "stake".',
      },
      explanation: 'Plan a line backing a new agent for up to 500 USDG per draw at a 5% fee; nothing is sent without confirm.',
    },
    {
      input: { action: 'stake', nonce: '1', usdg: '600', confirm: true },
      output: { status: 'success', sent: true, action: 'stake', nonce: '1', amountUsdg: '600', staked: '600000000' },
      explanation: 'Stake 600 USDG behind line #1.',
    },
  ]],
});
