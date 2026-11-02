import { describe, expect, it } from 'vitest';
import { SendTransactionError } from '@solana/web3.js';
import { RelayerError } from '../../src/relayer-client.js';
import { SimulationError } from '../../src/solana/send.js';
import { MAINNET } from '../../integrations/core/constants.js';
import { H081Error, explainProgramError, explained, programErrorCode, programOf } from '../../integrations/core/errors.js';

const ids = { pool: MAINNET.programs.pool, loan: MAINNET.programs.loan, capacity: MAINNET.programs.capacity };
const poolLogs = (hex: string) => [
  `Program ${MAINNET.programs.pool} invoke [1]`,
  'Program log: Instruction: Transact',
  `Program ${MAINNET.programs.pool} consumed 412000 of 1400000 compute units`,
  `Program ${MAINNET.programs.pool} failed: custom program error: ${hex}`,
];

describe('explainProgramError', () => {
  it('reads the Anchor code out of simulation logs and names the pool variant', () => {
    const e = new SimulationError({ InstructionError: [2, { Custom: 6037 }] }, poolLogs('0x1795'));
    expect(programErrorCode(e)).toBe(6037);
    expect(programOf(e, ids)).toBe('pool');
    expect(explainProgramError(e, { ids })).toBe('DepositCapExceeded (6037, stipend_pool): the bank holds at most 10,000 USDG in total on mainnet and this deposit would exceed it');
    expect(explainProgramError(new SimulationError({}, poolLogs('0x1794')), { ids })).toMatch(/^DepositTooLarge \(6036, stipend_pool\): the deposit is over the per-deposit cap/);
    expect(explainProgramError(new SimulationError({}, poolLogs('0x1793')), { ids })).toMatch(/^DepositsPaused \(6035, stipend_pool\): new deposits are paused/);
  });

  it('uses the caller\'s program hint when the logs name none, and the loan / capacity tables', () => {
    expect(explainProgramError(new Error('transaction 5x failed: {"InstructionError":[1,{"Custom":6022}]}'), { program: 'loan' })).toMatch(/^PrincipalTooLarge \(6022, stream_loan\)/);
    expect(explainProgramError(new Error('custom program error: 0x1771'), { program: 'loan' })).toMatch(/^AlreadyFunded \(6001, stream_loan\): this loan slot is already funded/);
    expect(explainProgramError(new Error('custom program error: 0x177a'), { program: 'capacity' })).toMatch(/^StakeCap \(6010, capacity_stake\)/);
    expect(explainProgramError(new Error('custom program error: 0x1779'), { program: 'capacity' })).toMatch(/^StakingPaused \(6009, capacity_stake\)/);
    expect(explainProgramError(new Error('Error Number: 6003. Error Message: x'), { program: 'capacity' })).toMatch(/^Cooldown \(6003, capacity_stake\)/);
  });

  it('the failing program in the logs wins over the hint', () => {
    const logs = [`Program ${MAINNET.programs.loan} invoke [1]`, `Program ${MAINNET.programs.loan} failed: custom program error: 0x1785`];
    const e = new SendTransactionError({ action: 'send', signature: 'x', transactionMessage: 'failed', logs });
    expect(explainProgramError(e, { program: 'pool', ids })).toMatch(/^PayoutNotProven \(6021, stream_loan\)/);
  });

  it('a code outside the table still carries the number; unknown programs list the candidates', () => {
    expect(explainProgramError(new Error('custom program error: 0x2000'), { program: 'pool' })).toBe('program error 8192');
    expect(explainProgramError(new Error('custom program error: 0x1771'))).toMatch(/^program error 6001: InputNotInField \(stipend_pool\) or AlreadyFunded \(stream_loan\) or MoreThanStaked \(capacity_stake\)/);
  });

  it('relayer refusals pass through with their stable code; plain errors keep their message', () => {
    expect(explainProgramError(new RelayerError(402, 'fee_too_low', 'fee 1 is below 50000'))).toBe('the relayer refused it (402 fee_too_low): fee 1 is below 50000');
    expect(explainProgramError(new Error('something else'))).toBe('something else');
    expect(explainProgramError(new Error('transaction 5x expired before it was confirmed; nothing was spent by it. Please try again.'))).toMatch(/nothing was spent/);
  });

  it('explained() wraps once and keeps the cause', () => {
    const cause = new SimulationError({}, poolLogs('0x1795'));
    const e = explained(cause, { ids });
    expect(e).toBeInstanceOf(H081Error);
    expect(e.code).toBe(6037);
    expect(e.cause).toBe(cause);
    expect(explained(e)).toBe(e);
  });
});
