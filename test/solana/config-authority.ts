// Localnet-only config authority of stipend_pool's deposit guard, shared by every suite on the pool validator
// so the tests can drive caps and pause whichever suite initializes the pool first. Derived from a public
// seed: never use it outside a local validator.
import { sha256 } from '@noble/hashes/sha2';
import { Keypair } from '@solana/web3.js';

export const LOCALNET_CONFIG_AUTHORITY = Keypair.fromSeed(sha256(new TextEncoder().encode('h081 localnet stipend_pool config authority')));
