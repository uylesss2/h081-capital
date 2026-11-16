import { makeAction } from './factory.js';

export const backDrawAction = makeAction({
  op: 'h081_back_draw',
  name: 'H081_BACK_DRAW',
  similes: ['borrow against a backer', 'request a backed advance', 'give my draw key code', 'repay a backed loan', 'check my backed loan'],
  examples: [[
    {
      input: { action: 'key' },
      output: { status: 'success', drawKeyCode: 'h081-draw-key:5vQB7…', next: 'hand drawKeyCode to a backer (h081_back action "open")' },
      explanation: 'Get the code a backer opens a line for.',
    },
    {
      input: { action: 'request', backingCode: 'h081-backing:7mZb3…', loanRef: '3', advanceUsdg: '500', lenderFeeBps: 300, days: 14 },
      output: { status: 'success', sent: false, dryRun: true, plan: { action: 'request', loanRef: '3', advanceUsdg: '500', principalUsdg: '540', youReceiveUsdg: '498.75' } },
      explanation: 'Plan an advance of 500 USDG from the lender of slot #3: the loan owes 540 (5% backer fee, 3% lender fee); 498.75 arrive after the 0.25% origination fee.',
    },
  ]],
});
