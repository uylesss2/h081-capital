// The four paid services, as X402Service objects over the relayer's existing pieces: the priority relay
// lane and the relay preflight (SolanaRelayer), loan-market data (LoanMarketReader) and disclosure proving
// (DiscloseProver). Descriptions are plain statements (Bazaar listing text, at most 500 characters).
import { RelayError } from '../errors.js';
import type { PreparedRelay, SolanaRelayer } from '../solana.js';
import { X402_ROUTES, type X402Service } from './catalog.js';
import type { LoanMarketReader } from './loans.js';
import type { DiscloseProver, DiscloseRequest } from './prove.js';

const B58 = { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' };
const FIELD_STRING = { type: 'string', pattern: '^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$' };

/** The relay request body (POST /v1/solana/relay) as JSON Schema. */
export const RELAY_BODY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['op', 'payload'],
  properties: {
    op: { type: 'string', enum: ['transact', 'spend', 'grant', 'delegate'] },
    payload: { type: 'string', contentEncoding: 'base64', description: 'borsh(Proof, Args, ext) of the operation, as the SDK stages it' },
    mint: B58, recipientOwner: B58, lenderToken: B58, operator: B58, operatorSig: { type: 'string', contentEncoding: 'base64' },
  },
};

const RELAY_EXAMPLE = {
  op: 'transact', payload: 'AAEC...base64 borsh(Proof, Args, ext)...', mint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  recipientOwner: 'EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq',
};

const DISCLAIMER = 'The H081 private bank is live on Solana mainnet, not audited yet; use at your own risk.';

export function relayPriority(solana: SolanaRelayer): X402Service<{ prepared: PreparedRelay; release: () => void }> {
  return {
    id: 'relay-priority', ...X402_ROUTES['relay-priority'], flow: 'settle-first', mimeType: 'application/json',
    description: 'Submits a stipend_pool operation (withdrawal, spend, grant or delegate; the same body as POST /v1/solana/relay) '
      + 'through a dedicated priority lane: its own in-flight capacity and a higher priority-fee cap on every transaction. '
      + 'The operation must still carry the in-proof relay fee to the treasury fee account. Returns the signature and compute units. ' + DISCLAIMER,
    inputExample: RELAY_EXAMPLE, inputSchema: RELAY_BODY_SCHEMA,
    outputExample: { signature: '5uGn7...', computeUnits: 210000, op: 'transact', fee: '50000', lane: 'priority', priorityFee: { maxLamports: 4000000, priceCeil: 5000000 } },
    outputSchema: {
      type: 'object', required: ['signature', 'computeUnits', 'op', 'fee', 'lane'],
      properties: {
        signature: { type: 'string' }, computeUnits: { type: 'integer' }, op: { type: 'string' }, fee: { type: 'string' }, lane: { const: 'priority' },
        priorityFee: { type: 'object', properties: { maxLamports: { type: 'integer' }, priceCeil: { type: 'integer' } } },
      },
    },
    // fee, root, nullifier, timestamp and capacity refusals happen here, before the payment is settled
    async prepare(ctx) {
      const release = solana.acquire('priority');
      try {
        return { prepared: await solana.prepare(ctx.body, { lane: 'priority' }), release };
      } catch (e) {
        release();
        throw e;
      }
    },
    async run(_ctx, p) {
      try {
        return await solana.submit(p.prepared, { lane: 'priority' });
      } finally {
        p.release();
      }
    },
    abort(p) { p.release(); },
  };
}

export function preflight(solana: SolanaRelayer): X402Service<void> {
  return {
    id: 'preflight', ...X402_ROUTES.preflight, flow: 'settle-after', mimeType: 'application/json',
    description: 'Checks whether a stipend_pool operation (the same body as POST /v1/solana/relay) would be relayed, without sending anything: '
      + 'relay fee against the minimum and 0.20% rule, the proof itself, capacity_stake capacity, known root, unspent nullifiers, fresh timestamp, the accounts '
      + 'it would create (and their surcharge) and the transaction plan. Returns ok plus every refusal the relay API would answer with. ' + DISCLAIMER,
    inputExample: RELAY_EXAMPLE, inputSchema: RELAY_BODY_SCHEMA,
    outputExample: {
      ok: false, op: 'transact',
      fee: {
        paid: '40000', required: '50000', min: '50000', bps: 20, publicAmount: '5000000', mint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
        feeAccount: 'DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo', createAccountFee: '400000',
      },
      proof: { verified: true },
      capacity: { needed: false, operator: null, used: null, limit: null, ok: true },
      chain: { rootKnown: true, nullifiersUnspent: [true, true], timestampFresh: null },
      accounts: { recipientExists: true, vaultExists: true, lenderTokenUsable: null },
      plan: { payloadBytes: 1200, setupTxs: 1, writeTxs: 0, createdAccounts: 0, lamports: { estimate: 10000, covered: 1000000 } },
      refusals: [{ status: 402, code: 'fee_too_low', message: 'fee 40000 is below 50000 (max of the minimum 50000 and 20 bps of 5000000)' }],
    },
    outputSchema: {
      type: 'object', required: ['ok', 'op', 'fee', 'chain', 'refusals'],
      properties: {
        ok: { type: 'boolean' }, op: { type: 'string' }, fee: { type: 'object' }, capacity: { type: ['object', 'null'] }, chain: { type: 'object' },
        accounts: { type: ['object', 'null'] }, plan: { type: ['object', 'null'] },
        refusals: { type: 'array', items: { type: 'object', properties: { status: { type: 'integer' }, code: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
    run: (ctx) => solana.inspect(ctx.body),
  };
}

export function loansMarket(reader: LoanMarketReader): X402Service<void> {
  return {
    id: 'loans-market', ...X402_ROUTES['loans-market'], flow: 'settle-after', mimeType: 'application/json',
    description: 'Returns the stream_loan market read from Solana mainnet: the registry, every loan slot (lender, asset, principal, repaid, expiry, '
      + 'pledge, stream bounds, settlement, shortfall as of chain time), open slots waiting for a borrower, counts and the origination fee rate. '
      + 'Cached for 30 seconds. ' + DISCLAIMER,
    inputExample: {}, inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    outputExample: {
      programId: '8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4', registry: { nextLoanRef: '1' }, originationFeeBps: 25, graceSeconds: 604800,
      treasury: 'EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq', counts: { open: 0, funded: 0, settled: 0 }, loans: [], openSlots: [],
      now: '1793600000', updatedAt: '2026-11-02T00:00:00.000Z',
    },
    outputSchema: {
      type: 'object', required: ['programId', 'registry', 'counts', 'loans', 'openSlots', 'updatedAt'],
      properties: {
        programId: { type: 'string' }, registry: { type: 'object' }, originationFeeBps: { type: 'integer' }, graceSeconds: { type: 'integer' }, treasury: { type: 'string' },
        counts: { type: 'object' }, loans: { type: 'array' }, openSlots: { type: 'array' }, now: { type: 'string' }, updatedAt: { type: 'string' },
      },
    },
    run: () => reader.snapshot(),
  };
}

const POLICY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lifetimeCap', 'windowCap', 'windowLen', 'maxPerTx', 'expiry', 'recipientRoot', 'ownerPk', 'streamRate', 'streamStart', 'lender', 'pledgeBps'],
  properties: Object.fromEntries(['lifetimeCap', 'windowCap', 'windowLen', 'maxPerTx', 'expiry', 'recipientRoot', 'ownerPk', 'streamRate', 'streamStart', 'lender', 'pledgeBps'].map((k) => [k, FIELD_STRING])),
};

export const DISCLOSE_BODY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['root', 'kind', 'bound', 'audience', 'allowance', 'path'],
  properties: {
    root: FIELD_STRING, kind: { type: 'string', enum: ['remainingAtLeast', 'spentAtMost', 'windowSpentAtMost'] }, bound: FIELD_STRING, audience: FIELD_STRING,
    windowId: FIELD_STRING,
    allowance: {
      type: 'object', additionalProperties: false, required: ['asset', 'remaining', 'agentPk', 'windowId', 'windowSpent', 'rho', 'pledgePaid', 'policy'],
      properties: { asset: FIELD_STRING, remaining: FIELD_STRING, agentPk: FIELD_STRING, windowId: FIELD_STRING, windowSpent: FIELD_STRING, rho: FIELD_STRING, pledgePaid: FIELD_STRING, policy: POLICY_SCHEMA },
    },
    path: {
      type: 'object', additionalProperties: false, required: ['pathIndices', 'pathElements'],
      properties: { pathIndices: { type: 'array', minItems: 20, maxItems: 20, items: { type: 'integer', enum: [0, 1] } }, pathElements: { type: 'array', minItems: 20, maxItems: 20, items: FIELD_STRING } },
    },
  },
};

export function proveDisclose(prover: DiscloseProver | undefined): X402Service<DiscloseRequest | undefined> {
  return {
    id: 'prove-disclose', ...X402_ROUTES['prove-disclose'], flow: 'settle-first', mimeType: 'application/json',
    description: 'Proves a statement about a stipend_pool allowance (Groth16 disclose circuit): remaining at least, lifetime spend at most or window spend '
      + 'at most a bound, for an audience, as of a root the pool knows. Input: the allowance figures and policy (the prover sees them), its Merkle path, '
      + 'the bound and the audience; no spending key. Output: the proof, its public signals and the payload for verify_disclosure. ' + DISCLAIMER,
    // every value must satisfy DISCLOSE_BODY_SCHEMA: the Bazaar checks the example against it and refuses the listing
    // ("invalid discovery configuration") otherwise. Illustrative field elements, not a real allowance.
    inputExample: {
      root: '0x1a2b3c4d', kind: 'remainingAtLeast', bound: '600', audience: '77',
      allowance: {
        asset: '0x1111111111111111111111111111111111111111', remaining: '640', agentPk: '0x2c3d4e5f', windowId: '0', windowSpent: '0', rho: '0x4e5f6a7b', pledgePaid: '0',
        policy: { lifetimeCap: '1000', windowCap: '0', windowLen: '86400', maxPerTx: '0', expiry: '0', recipientRoot: '0', ownerPk: '0x6a7b8c9d', streamRate: '0', streamStart: '0', lender: '0', pledgeBps: '0' },
      },
      path: { pathIndices: Array(20).fill(0), pathElements: ['0x8c9d0e1f', ...Array(19).fill('0x0')] },
    },
    inputSchema: DISCLOSE_BODY_SCHEMA,
    outputExample: {
      proof: { pi_a: ['...', '...', '1'], pi_b: [['...', '...'], ['...', '...'], ['1', '0']], pi_c: ['...', '...', '1'], protocol: 'groth16', curve: 'bn128' },
      publicSignals: ['...', '0', '600', '0', '...', '77'], args: { root: '...', kind: '0', bound: '600', windowId: '0', agentPk: '...', audience: '77' },
      payload: 'base64 borsh(Proof, DiscloseArgs)', policyHash: '...',
    },
    outputSchema: {
      type: 'object', required: ['proof', 'publicSignals', 'args', 'payload', 'policyHash'],
      properties: { proof: { type: 'object' }, publicSignals: { type: 'array', items: { type: 'string' } }, args: { type: 'object' }, payload: { type: 'string' }, policyHash: { type: 'string' } },
    },
    async prepare(ctx) {
      if (!prover) throw new RelayError(503, 'service_disabled', 'disclose circuit artifacts are not installed on this relayer');
      return prover.check(ctx.body);
    },
    run(_ctx, r) {
      if (!prover || !r) throw new RelayError(503, 'service_disabled', 'disclose circuit artifacts are not installed on this relayer');
      return prover.prove(r);
    },
  };
}
