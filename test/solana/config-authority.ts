// Localnet-only keys of stipend_pool shared by every suite on the pool and loan validators. Derived from
// public seeds: never use them outside a local validator.
//  - config authority of the deposit guard, so the tests can drive caps and pause whichever suite
//    initializes the pool first;
//  - upgrade authority the validator scripts load stipend_pool with (--upgradeable-program), the only
//    signer `initialize` accepts. Its pubkey is written in solana/scripts/start-validator.sh and
//    loan-start-validator.sh (test/solana/consistency.test.ts checks they match).
import { sha256 } from '@noble/hashes/sha2';
import { Keypair } from '@solana/web3.js';

export const LOCALNET_CONFIG_AUTHORITY = Keypair.fromSeed(sha256(new TextEncoder().encode('h081 localnet stipend_pool config authority')));
export const LOCALNET_UPGRADE_AUTHORITY = Keypair.fromSeed(sha256(new TextEncoder().encode('h081 localnet stipend_pool upgrade authority')));
