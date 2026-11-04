// Optional read-only check against mainnet (public RPC, getAccountInfo only; the relayer's /v1/info over
// HTTPS). Skipped unless H081_MAINNET_READ=1. Sends nothing, needs no key.
import { describe, expect, it } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { Prover } from '../../src/prover.js';
import { H081Bank } from '../../integrations/core/bank.js';
import { MAINNET, MAINNET_GENESIS, configFromEnv } from '../../integrations/core/constants.js';

const on = process.env.H081_MAINNET_READ === '1';

describe.skipIf(!on)('mainnet (read-only)', () => {
  it('the deployed pool carries the documented caps and the relayer pays its fees to the treasury', async () => {
    const config = configFromEnv({ H081_CIRCUITS_DIR: 'C:/nonexistent/h081-test-circuits' });
    const connection = new Connection(config.rpcUrl, 'confirmed');
    expect(await connection.getGenesisHash()).toBe(MAINNET_GENESIS);
    const bank = await H081Bank.open({ config, signer: Keypair.generate(), accountSk: 1n, connection, prover: new Prover('C:/nonexistent'), cacheDir: null });
    const caps = await bank.caps();
    expect(caps).not.toBeNull();
    expect(caps!.perDeposit).toBe(1_000_000_000n);
    expect(caps!.total).toBe(10_000_000_000n);
    expect(caps!.inVault <= caps!.total).toBe(true);
    const terms = await bank.relayTerms();
    expect(terms).toBeDefined();
    expect(terms!.treasury).toBe(MAINNET.loanTreasury);
    expect(terms!.feeRecipient.toBase58()).toBe(MAINNET.treasuryUsdgAccount);
    expect(terms!.minFee).toBe(50_000n);
    expect(terms!.feeBps).toBe(20);
    const v = await bank.stakeView();
    expect(v.caps.maxPerStake).toBe(MAINNET.stakeCaps.perStake);
    expect(v.caps.maxTotal).toBe(MAINNET.stakeCaps.total);
  }, 120_000);
});
