import { makeAction } from './factory.js';

export const bankWithdrawAction = makeAction({
  op: 'h081_bank_withdraw',
  name: 'H081_BANK_WITHDRAW',
  similes: ['withdraw usdg from h081', 'unshield usdg', 'take usdg out of the private bank', 'cash out of h081', 'send shielded usdg to a wallet'],
  examples: [[
    {
      input: { usdg: '10' },
      output: { status: 'success', signature: '4bQ…', amount: '10000000', fee: '50000', received: '9950000', receivedUsdg: '9.95', to: 'AgentWallet…', via: 'relayer' },
      explanation: 'Withdraw 10 USDG to the agent wallet through the relayer; the relay fee (max of 0.05 USDG and 0.20%) goes to the protocol treasury.',
    },
    {
      input: { amount: '5000000', to: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv', direct: true },
      output: { status: 'success', signature: '2Hk…', amount: '5000000', fee: '0', received: '5000000', receivedUsdg: '5', to: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv', via: 'direct' },
      explanation: 'Withdraw 5 USDG to another wallet, sent by the agent key itself (no relay fee; the agent wallet is visible as the sender).',
    },
  ]],
});
