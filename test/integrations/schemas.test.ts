import { describe, expect, it } from 'vitest';
import { DESCRIPTIONS, EXAMPLE_INPUTS, JSON_SCHEMA, OPS, ZOD } from '../../integrations/core/schemas.js';

describe('operation schemas', () => {
  it('seven operations, each with a description, a zod schema and a JSON schema that accept the examples', () => {
    expect(OPS).toHaveLength(7);
    expect(new Set(OPS).size).toBe(7);
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
    for (const op of ['h081_bank_deposit', 'h081_bank_withdraw', 'h081_stake', 'h081_loan_borrow']) expect(DESCRIPTIONS[op as typeof OPS[number]]).toMatch(/not audited yet/);
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
  });
});
