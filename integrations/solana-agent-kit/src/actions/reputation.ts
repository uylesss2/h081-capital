// Private reputation: request (verifier), prove (prover), verify (verifier), attest and status (prover).
import { makeAction } from './factory.js';

const ASK = 'h081-rep-ask:5Hq2Vb7Zr9KcTmW3xLpN4';
const CODE = 'h081-rep:7Yk3LmQ9pR2';
const SIG = 'h081-rep-sig:3Df8Kq2';

export const reputationRequestAction = makeAction({
  op: 'h081_reputation_request',
  name: 'H081_REPUTATION_REQUEST',
  similes: ['ask an agent to prove its repayment record', 'request a private credit score', 'challenge an agent for its loan history without seeing it'],
  examples: [[{
    input: { audience: 'acme-desk', minLoans: 3, minVolumeUsdg: '500', minSpanDays: 90 },
    output: { status: 'success', code: ASK, thresholds: { minLoans: 3, minVolume: '500', minSpanDays: 90 }, expiresAt: 1900000600 },
    explanation: 'Make a request code with a fresh challenge; the agent answers it with h081_prove_reputation and you check the answer with h081_verify_reputation and this request.',
  }]],
});

export const proveReputationAction = makeAction({
  op: 'h081_prove_reputation',
  name: 'H081_PROVE_REPUTATION',
  similes: ['prove my repayment record privately', 'show my credit score without revealing my loans', 'answer a reputation request'],
  examples: [[{
    input: { request: ASK },
    output: { status: 'success', code: CODE, presentation: SIG, binding: 'session-key', counted: { loans: 4 } },
    explanation: 'Prove, locally, at least what the request asks over repaid loans under this account\'s loan keys, revealing none of them. Give the verifier the code, and the presentation only when presenting.',
  }, {
    input: { audience: 'acme-desk', minLoans: 3, minVolumeUsdg: '700' },
    output: { status: 'error', message: 'ReputationUnreachable: minVolume needs 700000000, has 420000000. Attested so far: 4 loans, 420 volume, 2 lenders, 120 days, 4 periods. Nothing was proven.' },
    explanation: 'A claim the record does not support is refused and the message says what is short.',
  }]],
});

export const verifyReputationAction = makeAction({
  op: 'h081_verify_reputation',
  name: 'H081_VERIFY_REPUTATION',
  similes: ['check an agent reputation proof', 'verify a private credit score code', 'check an h081-rep code'],
  examples: [[{
    input: { code: CODE, request: ASK, presentation: SIG },
    output: { status: 'success', ok: true, presenter: 'signed-session-key', lowerBoundOnly: true, thresholds: { minLoans: 3, minVolume: '500' } },
    explanation: 'Checks challenge, binding, expiry, root and proof. ok means at least these repaid loans; it says nothing about defaults.',
  }]],
});

export const reputationAttestAction = makeAction({
  op: 'h081_reputation_attest',
  name: 'H081_REPUTATION_ATTEST',
  similes: ['attest my repaid loans', 'count my repaid loans toward reputation'],
  examples: [[{
    input: {},
    output: { status: 'success', sent: false, dryRun: true, plan: { action: 'attest', loans: ['12', '15'], via: 'the relayer (it signs and pays; your wallet does not appear)' } },
    explanation: 'Returns the plan; call again with confirm: true to have the relayer attest them.',
  }]],
});

export const reputationStatusAction = makeAction({
  op: 'h081_reputation_status',
  name: 'H081_REPUTATION_STATUS',
  similes: ['what is my reputation', 'how many repaid loans count', 'my private credit record'],
  examples: [[{
    input: {},
    output: { status: 'success', attested: { count: 4, volume: '420', lenders: 2, spanDays: 120, months: 4 }, pending: [], legacy: 1 },
    explanation: 'Local view of what counts, what waits for an attest and what can never count.',
  }]],
});
