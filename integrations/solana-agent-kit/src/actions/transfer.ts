import { makeAction } from './factory.js';

export const transferAction = makeAction({
  op: 'h081_transfer',
  name: 'H081_TRANSFER',
  similes: ['transfer usdg privately', 'pay an h081-address code from my balance', 'send usdg to another agent privately', 'move shielded usdg to another account'],
  examples: [[
    {
      input: { usdg: '1', toAddressCode: 'h081-address:2Q4hfqVf8dZ3vSt6EzNw3hMKx5mT1nJxkPZfFh9cYbLwRb7uA2gE5sQ1rVhC7jYtUe2kWxN8pD6mHf3LzR9aB4cXv' },
      output: { status: 'success', signature: '4Hq…', amount: '1000000', amountUsdg: '1', to: 'shielded', via: 'direct', shielded: '24000000', shieldedUsdg: '24' },
      explanation: 'Pay 1 USDG from the main shielded balance to another account\'s address code. The amount and recipient stay hidden; the agent key sends it, so the chain shows the agent wallet used the bank.',
    },
    {
      input: { usdg: '1', toAddressCode: 'h081-address:2Q4hfqVf8dZ3vSt6EzNw3hMKx5mT1nJxkPZfFh9cYbLwRb7uA2gE5sQ1rVhC7jYtUe2kWxN8pD6mHf3LzR9aB4cXw' },
      output: { status: 'error', message: 'That shielded address code does not pass its built-in check: it was cut off or changed when it was copied.' },
      explanation: 'A code with a wrong checksum, kind or network is refused before anything is proven or sent.',
    },
  ]],
});
