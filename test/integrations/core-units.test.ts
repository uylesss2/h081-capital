import { describe, expect, it } from 'vitest';
import { fromUnits, parseAmount, toUnits } from '../../integrations/core/units.js';

describe('units', () => {
  it('toUnits / fromUnits round-trip at 6 decimals', () => {
    expect(toUnits('12.5', 6)).toBe(12_500_000n);
    expect(toUnits('0.000001', 6)).toBe(1n);
    expect(toUnits('1000', 6)).toBe(1_000_000_000n);
    expect(fromUnits(12_500_000n, 6)).toBe('12.5');
    expect(fromUnits(1_000_000_000n, 6)).toBe('1000');
    expect(fromUnits(-50_000n, 6)).toBe('-0.05');
    expect(() => toUnits('1.2345678', 6)).toThrow(/at most 6 decimals/);
    expect(() => toUnits('abc', 6)).toThrow(/like 12.5/);
  });

  it('parseAmount takes exactly one of base units or decimal', () => {
    expect(parseAmount({ amount: '1000000' }, 'usdg', 6)).toBe(1_000_000n);
    expect(parseAmount({ usdg: '2.5' }, 'usdg', 6)).toBe(2_500_000n);
    expect(() => parseAmount({ amount: '1', usdg: '1' }, 'usdg', 6)).toThrow(/not both/);
    expect(() => parseAmount({}, 'usdg', 6)).toThrow(/give "amount"/);
    expect(() => parseAmount({ amount: '1.5' }, 'usdg', 6)).toThrow(/integer in base units/);
    expect(() => parseAmount({ usdg: '0' }, 'usdg', 6)).toThrow(/positive/);
    expect(parseAmount({ usdg: '0' }, 'usdg', 6, { positive: false })).toBe(0n);
    expect(parseAmount({ budget: '7' }, 'budgetUsdg', 6, { baseKey: 'budget' })).toBe(7n);
  });
});
