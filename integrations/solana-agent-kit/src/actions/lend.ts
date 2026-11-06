import { makeAction } from './factory.js';

export const lendAction = makeAction({
  op: 'h081_lend',
  name: 'H081_LEND',
  similes: ['lend to an agent', 'open an h081 loan slot', 'make loan terms', 'fund a loan against a proof code', 'claim loan repayments', 'settle a loan', 'check my loans'],
  examples: [[
    {
      input: { action: 'open', pledgeBps: 4000, confirm: true },
      output: {
        status: 'success', sent: true, loanRef: '3', pledgeBps: '4000', slot: 'Slot…', termsCode: 'h081-loan-terms:4mD9q…',
        next: 'hand termsCode to the borrower (h081_loan_borrow); it returns an "h081-loan-proof:" code: fund the loan with h081_lend action "fund" and that proofCode',
      },
      explanation: 'Open loan slot #3 where 40% of every payment the borrower makes is routed back, and get the terms code to send the borrower.',
    },
    {
      input: { action: 'fund', proofCode: 'h081-loan-proof:3vQB7…' },
      output: {
        status: 'success', sent: false, dryRun: true,
        plan: { action: 'fund', loanRef: '3', principalUsdg: '40', borrowerReceivesUsdg: '39.9', pledgeBps: 4000, walletUsdg: '100000000', proofChecked: 'verified locally and matched to a live pledged note; the program verifies it again on chain' },
        next: 'nothing was sent. Call h081_lend again with action "fund", the same proofCode and confirm: true to lend exactly this.',
      },
      explanation: 'Without confirm nothing is sent: the plan shows the exact principal the borrower\'s proof backs (the program funds no other amount) and what the borrower receives after the 0.25% fee.',
    },
    {
      input: { action: 'status', loanRef: '3' },
      output: { status: 'success', slots: [{ loanRef: '3', state: 'funded', principalUsdg: '40', repaidUsdg: '12', outstandingUsdg: '28', claimableUsdg: '1.5', collectableUsdg: '0', shortfall: '0' }] },
      explanation: 'How much of loan #3 is repaid, outstanding and claimable now.',
    },
  ]],
});
