// Prove solvency in one line: request (asker), prove (agent), verify (asker), reserve (agent).
// The default pre-deal step: the party carrying the risk asks, the other proves, the asker verifies, then they trade.
import { makeAction } from './factory.js';

const ASK = 'h081-solvency-ask:5Hq2Vb7Zr9KcTmW3xLpN4';
const CODE = 'h081-solvency:7Yk3LmQ9pR2';

export const solvencyRequestAction = makeAction({
  op: 'h081_solvency_request',
  name: 'H081_SOLVENCY_REQUEST',
  similes: ['ask a counterparty to prove it can pay', 'request proof of funds before a deal', 'check an agent is solvent before lending', 'ask for an h081 solvency proof'],
  examples: [[{
    input: { minUsdg: '2500', label: 'acme-desk' },
    output: { status: 'success', code: ASK, min: '2500000000', minUsdg: '2500', expiresAt: '2030-01-01T00:30:00.000Z', maxRootAge: 32 },
    explanation: 'Make a request for at least 2,500 USDG; the counterparty answers it with h081_prove_solvency; check the answer with h081_verify_solvency and this request, then deal only with the wallet it names.',
  }]],
});

export const proveSolvencyAction = makeAction({
  op: 'h081_prove_solvency',
  name: 'H081_PROVE_SOLVENCY',
  similes: ['prove I hold at least an amount', 'answer a solvency request', 'show proof of funds without revealing my balance'],
  examples: [[{
    input: { request: ASK },
    output: { status: 'success', sent: false, dryRun: true, plan: { action: 'reserve top-up', topUpUsdg: '2500', shieldedAfterUsdg: '500', solNeeded: 0.1 } },
    explanation: 'No reserve yet: the plan of the one grant that sets 2,500 USDG aside. Call again with confirm: true to send it and prove.',
  }, {
    input: { request: ASK, confirm: true },
    output: { status: 'success', code: CODE, boundUsdg: '2500', wallet: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv', selfCheck: { ok: true, assetSound: true } },
    explanation: 'The proof is made locally over the reserve and bound to this request and this wallet. Hand the code to the asker.',
  }]],
});

export const verifySolvencyAction = makeAction({
  op: 'h081_verify_solvency',
  name: 'H081_VERIFY_SOLVENCY',
  similes: ['check a solvency proof', 'verify an h081-solvency code', 'check proof of funds from a counterparty'],
  examples: [[{
    input: { code: CODE, request: ASK },
    output: { status: 'success', ok: true, wallet: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv', boundUsdg: '2500', rootAge: 2, assetSound: true, doesNotSay: ['that the funds are still there: ...'] },
    explanation: 'Valid: one note held at least 2,500 USDG a couple of pool operations ago; deal only with that wallet. It does not lock the funds.',
  }, {
    input: { code: CODE, request: ASK },
    output: { status: 'success', ok: false, reason: 'stale_root', message: 'the proof\'s pool root is 40 operations old; the request allows 32' },
    explanation: 'A failure names the first check that did not pass.',
  }]],
});

export const solvencyReserveAction = makeAction({
  op: 'h081_solvency_reserve',
  name: 'H081_SOLVENCY_RESERVE',
  similes: ['show my solvency reserve', 'release my solvency reserve', 'take back the reserve set aside for proofs'],
  examples: [[{
    input: {},
    output: { status: 'success', reserve: { id: '123', remaining: '2500000000', remainingUsdg: '2500' }, others: [], totalUsdg: '2500' },
    explanation: 'The reserve h081_prove_solvency proves over. release: true (plan unless confirm) takes it back into the shielded balance.',
  }]],
});
