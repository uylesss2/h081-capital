# Audit scope

What an external auditor is asked to review before any mainnet deployment. Nothing here is deployed to mainnet.

## In scope

| Area | Paths | Focus |
|---|---|---|
| Circuits | `circuits/` | soundness of transact, grant, spend, delegate, stream and disclosure circuits; nullifier and commitment uniqueness; range checks; public-input binding (`extDataHash`) |
| Solana programs | `solana/programs/stipend_pool`, `stream_loan`, `capacity_stake`, `safety_pool` | account validation and PDA seeds, signer checks, Groth16 verification and public-input encoding, Merkle tree updates, token / Token-2022 handling, arithmetic overflow, cross-program reads, deposit caps and deposit pause (withdrawals must stay open) |
| Verifying keys | `solana/programs/stipend_pool/src/generated/` | match the ceremony's final zkeys (`npm run solana:vk`, vk drift check) |
| SDK | `src/` (`client.ts`, `delegation.ts`, `solana/`, `x402.ts`) | note encryption, key derivation, proof input construction, relayer and x402 binding |
| Relayer | relayer service on `feat/relayer` | cannot alter a user's operation; fee handling; denial of service |

## Out of scope

- The H081 token mint and its launch scripts (separate, already live).
- The website.
- EVM contracts in `contracts/` (not deployed; the bank runs on Solana).

## Inputs given to the auditor

- Commit hash of the audited tree, verifiable build hashes (`npm run solana:verifiable-build`, `npm run solana:hash`).
- Ceremony transcript and final zkeys (`npm run ceremony`).
- Test suites: `npm test`, `npm run test:solana`.

## Known trust assumptions

- Each program is made immutable after deployment (upgrade authority removed).
- The stipend_pool config authority can change deposit caps and pause deposits; it can never block withdrawals
  or move funds.
- Mint authorities (permanent delegate, freeze, transfer hook) of listed mints can move or freeze vault balances.
