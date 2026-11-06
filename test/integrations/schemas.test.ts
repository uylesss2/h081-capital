import { describe, expect, it } from 'vitest';
import { DESCRIPTIONS, EXAMPLE_INPUTS, JSON_SCHEMA, OPS, ZOD } from '../../integrations/core/schemas.js';

describe('operation schemas', () => {
  it('every operation has a description, a zod schema and a JSON schema that accept the examples', () => {
    expect(OPS).toContain('h081_pay');
    expect(new Set(OPS).size).toBe(OPS.length);
    for (const op of OPS) {
      expect(DESCRIPTIONS[op].length).toBeGreaterThan(40);
      expect(JSON_SCHEMA[op]).toMatchObject({ type: 'object', additionalProperties: false });
      expect(EXAMPLE_INPUTS[op].length).toBeGreaterThan(0);
      for (const ex of EXAMPLE_INPUTS[op]) {
        const r = ZOD[op].safeParse(ex);
        expect(r.success, `${op} ${JSON.stringify(ex)}: ${r.success ? '' : r.error.message}`).toBe(true);
        // every example key is a declared JSON Schema property
        const props = JSON_SCHEMA[op].properties as Record<string, unknown>;
        for (const k of Object.keys(ex)) expect(props, `${op}.${k}`).toHaveProperty(k);
      }
    }
    for (const op of ['h081_bank_deposit', 'h081_bank_withdraw', 'h081_stake', 'h081_loan_borrow', 'h081_pay', 'h081_allowance_grant', 'h081_allowance_delegate', 'h081_allowance_reclaim', 'h081_lend']) expect(DESCRIPTIONS[op as typeof OPS[number]]).toMatch(/not audited yet/);
  });

  it('is strict: unknown keys, both amount forms, and bad values are refused', () => {
    expect(ZOD.h081_bank_deposit.safeParse({ usdg: '1', extra: 1 }).success).toBe(false);
    expect(ZOD.h081_bank_deposit.safeParse({ usdg: '1', amount: '1' }).success).toBe(false);
    expect(ZOD.h081_bank_deposit.safeParse({}).success).toBe(false);
    expect(ZOD.h081_bank_deposit.safeParse({ amount: '1.5' }).success).toBe(false);
    expect(ZOD.h081_bank_withdraw.safeParse({ usdg: '1', to: 'not-an-address' }).success).toBe(false);
    expect(ZOD.h081_stake.safeParse({ action: 'stake' }).success).toBe(false);
    expect(ZOD.h081_stake.safeParse({ action: 'unstake', h081: '1' }).success).toBe(false);
    expect(ZOD.h081_stake.safeParse({ action: 'burn' }).success).toBe(false);
    expect(ZOD.h081_loan_borrow.safeParse({ termsCode: 'x', budgetUsdg: '1', days: 10, unlockDays: 11 }).success).toBe(false);
    expect(ZOD.h081_loan_borrow.safeParse({ termsCode: 'x', days: 10, unlockDays: 5 }).success).toBe(false);
    expect(ZOD.h081_loan_quote.safeParse({ pledgeBps: 10001 }).success).toBe(false);
    expect(ZOD.h081_loan_quote.safeParse({}).success).toBe(true); // the bank decides what is missing
    const w = 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv';
    expect(ZOD.h081_pay.safeParse({ usdg: '1' }).success).toBe(false); // no recipient
    expect(ZOD.h081_pay.safeParse({ usdg: '1', to: w, toAddressCode: 'h081-address:x' }).success).toBe(false); // two recipients
    expect(ZOD.h081_pay.safeParse({ usdg: '1', toAddressCode: 'h081-address:x', direct: true }).success).toBe(false); // direct is for public payouts
    expect(ZOD.h081_pay.safeParse({ usdg: '1', to: w, allowanceId: '0x12' }).success).toBe(false);
    expect(ZOD.h081_pay.safeParse({ usdg: '1', to: w, agentIndex: 16 }).success).toBe(false);
    expect(ZOD.h081_pay.safeParse({ usdg: '1', amount: '1', to: w }).success).toBe(false);
    expect(ZOD.h081_pay.safeParse({ usdg: '1', to: w, confirm: true }).success).toBe(false);
    expect(ZOD.h081_pay.safeParse({ amount: '1', to: w, allowanceId: '123', agentIndex: 3, direct: true }).success).toBe(true);
    // allowances
    const G = ZOD.h081_allowance_grant, D = ZOD.h081_allowance_delegate, R = ZOD.h081_allowance_reclaim;
    expect(G.safeParse({ usdg: '1' }).success).toBe(true); // default: the first free sub-account, a plan
    expect(G.safeParse({ usdg: '1', agentIndex: 1, toAddressCode: 'h081-address:x' }).success).toBe(false);
    expect(G.safeParse({ usdg: '1', windowCap: '1', windowCapUsdg: '1' }).success).toBe(false);
    expect(G.safeParse({ usdg: '1', maxPerTx: '0' }).success).toBe(false); // 0 would mean "no cap": leave it out instead
    expect(G.safeParse({ usdg: '1', windowLen: 59 }).success).toBe(false);
    expect(G.safeParse({ usdg: '1', days: 3, unlockDays: 4 }).success).toBe(false);
    expect(G.safeParse({ usdg: '1', confirm: 'yes' }).success).toBe(false);
    expect(G.safeParse({ usdg: '1', to: 'E1ZAVTjMEAtPoUPAfsLrfJHpTXNtdmzgBWuZtUM1uKKv' }).success).toBe(false); // a grant goes to a shielded address, never a wallet
    expect(D.safeParse({ toAgentIndex: 1, usdg: '1' }).success).toBe(false); // the parent is required
    expect(D.safeParse({ allowanceId: '1', usdg: '1' }).success).toBe(false); // a recipient is required
    expect(D.safeParse({ allowanceId: '1', toAgentIndex: 1, toAddressCode: 'h081-address:x', usdg: '1' }).success).toBe(false);
    expect(D.safeParse({ allowanceId: '1', toAgentIndex: 1, usdg: '1', windowLen: 3600 }).success).toBe(false); // inherited from the parent
    expect(D.safeParse({ allowanceId: '1', agentIndex: 0, toAgentIndex: 1, amount: '5', maxPerTxUsdg: '1', days: 2, unlockDays: 1, confirm: true }).success).toBe(true);
    expect(R.safeParse({}).success).toBe(false);
    expect(R.safeParse({ allowanceId: '12', confirm: true }).success).toBe(true);
    expect(R.safeParse({ allowanceId: '12', usdg: '1' }).success).toBe(false); // always all of what is left
    // lending
    const L = ZOD.h081_lend;
    expect(L.safeParse({ action: 'open', pledgeBps: 4000 }).success).toBe(true);
    expect(L.safeParse({ action: 'open' }).success).toBe(false);
    expect(L.safeParse({ action: 'open', pledgeBps: 99 }).success).toBe(false);
    expect(L.safeParse({ action: 'open', pledgeBps: 9001 }).success).toBe(false);
    expect(L.safeParse({ action: 'fund' }).success).toBe(false);
    expect(L.safeParse({ action: 'fund', proofCode: 'h081-loan-proof:x', principal: '1', principalUsdg: '1' }).success).toBe(false);
    expect(L.safeParse({ action: 'fund', proofCode: 'h081-loan-proof:x', confirm: 'yes' }).success).toBe(false);
    expect(L.safeParse({ action: 'fund', proofCode: 'h081-loan-proof:x', loanRef: '3', principalUsdg: '40', pledgeBps: 4000, confirm: true }).success).toBe(true);
    expect(L.safeParse({ action: 'status' }).success).toBe(true);
    expect(L.safeParse({ action: 'status', confirm: true }).success).toBe(false); // read-only
    expect(L.safeParse({ action: 'claim' }).success).toBe(false);
    expect(L.safeParse({ action: 'claim', loanRef: '3', usdg: '0' }).success).toBe(false);
    expect(L.safeParse({ action: 'collect', loanRef: '3', confirm: true }).success).toBe(false);
    expect(L.safeParse({ action: 'settle', loanRef: '0x3' }).success).toBe(false);
    expect(L.safeParse({ action: 'close', loanRef: '3', confirm: true }).success).toBe(true);
    expect(L.safeParse({ action: 'borrow' }).success).toBe(false);
  });

  it('the allowance tools say plainly that nothing is sent without confirm, name the ceiling, and keep the risk notice', () => {
    for (const op of ['h081_allowance_grant', 'h081_allowance_delegate', 'h081_allowance_reclaim'] as const) {
      expect(DESCRIPTIONS[op]).toMatch(/WITHOUT `confirm: true` NOTHING IS SENT/);
      expect(DESCRIPTIONS[op]).toMatch(/not audited yet/);
      expect(JSON_SCHEMA[op].properties).toHaveProperty('confirm');
    }
    expect(DESCRIPTIONS.h081_allowance_grant).toMatch(/H081_MAX_GRANT/);
    expect(DESCRIPTIONS.h081_allowance_delegate).toMatch(/H081_MAX_GRANT/);
    expect(DESCRIPTIONS.h081_allowance_delegate).toMatch(/does not ship yet/);
    expect(DESCRIPTIONS.h081_bank_balance).toMatch(/grantedToOthers/);
  });
});
