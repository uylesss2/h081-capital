import { makeAction } from './factory.js';

export const payAction = makeAction({
  op: 'h081_pay',
  name: 'H081_PAY',
  similes: ['pay from my h081 allowance', 'pay usdg privately', 'pay another agent privately', 'spend from an allowance', 'pay an h081-address code', 'send usdg from my budget'],
  examples: [[
    {
      input: { usdg: '2.5', to: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv' },
      output: {
        status: 'success', signature: '3xK…', amount: '2500000', amountUsdg: '2.5', fee: '50000', lenderShare: '0', received: '2450000', receivedUsdg: '2.45',
        to: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv', private: false, via: 'relayer', allowanceId: '8713…', nextAllowanceId: '1204…', remaining: '7500000', remainingUsdg: '7.5',
      },
      explanation: 'Pay 2.5 USDG from an allowance granted to this account (picked automatically) to a wallet, through the relayer; the relay fee goes to the protocol treasury. If the relayer is unreachable or refuses, the action returns status error and nothing is sent.',
    },
    {
      input: { usdg: '1', toAddressCode: 'h081-address:2Q4hfqVf8dZ3vSt6EzNw3hMKx5mT1nJxkPZfFh9cYbLwRb7uA2gE5sQ1rVhC7jYtUe2kWxN8pD6mHf3LzR9aB4cXv', agentIndex: 0 },
      output: {
        status: 'success', signature: '5Lm…', amount: '1000000', amountUsdg: '1', fee: '0', lenderShare: '0', received: '1000000', receivedUsdg: '1',
        to: 'shielded', private: true, via: 'direct', allowanceId: '5521…', agentIndex: 0, remaining: '19000000', remainingUsdg: '19',
      },
      explanation: 'Pay 1 USDG privately (note to note) from sub-account 0\'s allowance to another agent\'s shielded address code; amount and recipient stay hidden on chain.',
    },
    {
      input: { usdg: '30', to: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv' },
      output: { status: 'error', message: 'no allowance can pay 30 USDG now. Nothing was sent. allowance 8713…: over its per-window cap (windowCap 20 USDG per 86400 s; 12 USDG left in this window, which resets at …).' },
      explanation: 'When no allowance\'s caps allow the payment, nothing is proven or sent and the error names the cap that blocks each one.',
    },
  ]],
});
