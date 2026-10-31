# Solana port: binding design

Owner decision 2026-10-26: **the bank moves to Solana**, the same chain as the H081 trading token
(the launchpad). Robinhood Chain is no longer the target. This document is binding for the port; where it is
silent, follow `docs/PRD-V2-DESIGN.md` and the existing Solidity behaviour in `contracts/`.

Non-negotiables: no upgrade path in program logic, no admin key or pause except stipend_pool's deposit guard
(per-asset caps and a pause of deposits only, set by a config authority; withdrawals can never be blocked); programs are made
immutable (upgrade authority set to none) at deployment; nothing is deployed to devnet or mainnet by this
work; no token is launched.

## 1. What does not change

- **Circuits, zkeys and verifying keys are byte-identical.** No circom or snarkjs setup step re-runs. The
  in-browser app and demo keep working untouched.
- Poseidon parameters, domain tags (PK 1 … LENDER 12), commitment and nullifier formulas, Merkle depth 20,
  the empty leaf `keccak256("stipend") mod p`, window/stream/pledge semantics, NOW_LOOKBACK 15 min,
  NOW_LOOKAHEAD 1 min, MAX_AMOUNT 2^128-1, GRANT_OUTPUTS 16, DELEGATE_OUTPUTS 4.
- The EVM code in `contracts/` and its tests stay in the repo and keep passing; they become the reference
  implementation. `npm test` must still pass.

## 2. Addresses inside the circuits

Circuits range-check addresses to 160 bits (lenderAddr in `LenderBinding`, recipients via `AddressKey`).
Solana pubkeys are 256 bits, so every pubkey that enters a circuit is mapped with:

```
fieldOf(pubkey) = big-endian integer of sha256(pubkey bytes)[0..20]     // 160 bits, < p
```

Used for: `asset` (the SPL mint), `publicRecipient` (the recipient wallet, i.e. the owner of the
destination token account), `lenderAddr` (the lender wallet or a StreamLoan slot PDA), the relayer. The
program recomputes `fieldOf` from the accounts it is given and requires equality with the public input;
it never trusts a client-supplied field value for an account. `loanRef` stays a u64.

`extDataHash = keccak256(borsh(ext)) mod p`, where `ext` is the instruction's ext-data struct (relayer
pubkey, fee recipient token account, encrypted memos).

## 3. Programs (Anchor framework via the `anchor-lang` crate; build with `cargo build-sbf`)

Workspace: `solana/` (Cargo workspace, `programs/<name>`). Anchor CLI is not installed and is not needed:
use `anchor-lang` / `anchor-spl` crates directly, `cargo build-sbf --manifest-path ...`. If a crate version
does not build with the installed platform-tools, pick the newest that does and record it. Program keypairs
for localnet are generated with `solana-keygen` into `solana/keys/` (gitignored); `declare_id!` uses them.

### 3.1 `stipend_pool`

Accounts:
- `Pool` PDA `["pool"]`: Merkle state (filled subtrees, next index, a ring of the last 1,024 roots, one root per
  state-changing operation), nothing else; 33,424 B. Created once by `initialize`, which only the program's upgrade
  authority may call (read from the ProgramData account; idempotent-refusing; no admin field). Accounts created by
  CPI are capped at 10,240 B, so `initialize` creates the PDA at 10,240 B without a discriminator and `grow_pool`
  (+10 KiB per call, rent topped up by the caller) completes it; the call that reaches full size writes the
  discriminator and the empty tree. initialize + 3 x grow_pool are sent as one transaction. `initialize` also creates
  `Config` `["config"]` (config authority, deposits_paused, default caps); `create_vault` creates `AssetCap` `["cap", mint]`.
- `Nullifier` PDA `["nf", nullifier_be32]`: created on spend; existing account = double spend (`init` fails).
- Per-asset vault: token account owned by PDA `["vault_auth"]`, one per mint, ATA-style PDA
  `["vault", mint]`. Supports SPL Token and Token-2022 (`anchor_spl::token_interface`); `transfer_checked`.
- `Escrow` PDA `["owed", mint, lender_field_be32, loan_ref_le8]` with a token account, for lender shares
  that could not be delivered (frozen account etc.); `pull_lender_share` is permissionless.
- `Buffer` PDA `["buf", payer, seed_u64]`: staging account for payloads larger than a transaction.

Large payloads: proofs (256 B) + public inputs (up to 22 × 32 B) + encrypted memos exceed Solana's
1,232-byte transaction limit. Every proof-bearing instruction reads its arguments from a `Buffer`:
`buffer_open(seed, len)`, `buffer_write(seed, offset, bytes)` (any number of txs), then the operation
(`transact`, `grant`, `spend`, `delegate`) takes the buffer, borsh-decodes `(Proof, Args, ExtData)` from it
and closes it to the payer at the end. Address lookup tables are allowed client-side.

Groth16: `groth16-solana` (alt_bn128 syscalls) or an equivalent using `solana_program::alt_bn128`.
Verifying keys for transact(8), grant(22), spend(15), disclose(6), delegate(9), stream(13) are generated
from `build/circuits/<name>/<name>.vkey.json` into Rust constants by a script in the repo (re-runnable).
Proof `a` is negated as the library requires; the SDK encodes proofs accordingly.

Poseidon for Merkle inserts: the `sol_poseidon` syscall via `solana-poseidon` (BN254 x5, circom-compatible)
or `light-poseidon`; a test must show on-chain roots equal `src/merkle.ts` roots.

Instructions mirror `contracts/StipendPool.sol`: `transact` (deposit/withdraw/transfer with relayer fee),
`grant`, `spend` (agent / owner / lender-claim, public payout to a token account whose owner maps to
`publicRecipient`, shielded payout, lender leg to the lender's token account, escrow on failure,
`msg.sender == lenderAddr` becomes "the signer's fieldOf == lenderAddr" on claims), `delegate`,
`pull_lender_share`, and read-only verification `verify_disclosure` / `verify_stream` (instructions that
succeed or fail; also usable via `simulateTransaction`). Same checks as the Solidity: known root, nullifier
unspent, `now` window from the Clock sysvar, amounts within MAX_AMOUNT, public-input order exactly as
`SPEND_PUBLIC` / `STREAM_PUBLIC` etc. in `src/inputs.ts`.

Events (Anchor `emit_cpi!`, not plain logs, so large memos are not truncated): NewCommitment(commitment,
index, encrypted_output), NewNullifier, NewGrant, NewDelegation, NewReceipt, PublicPayout, PledgeRouted,
PledgeEscrowed, LenderShareReleased, LenderMemo.

Lender delivery: there is no callback. The pool transfers the share to the lender's token account; if the
lender is a StreamLoan slot PDA, StreamLoan credits repayment by reading `PledgeRouted` data passed to it or
its own token balance (pull model, section 3.2).

### 3.2 `stream_loan`

Port of `contracts/lending/StreamLoan.sol` without the `onPledge` callback: `open_slot` (sequential
loanRef from a counter PDA, slot lender = signer), `fund` (verifies the stream proof by CPI to
`stipend_pool::verify_stream` or the same verifier module, checks `lenderAddr == fieldOf(slot PDA)`,
loanRef, asset, streamStart <= now; records the loan; transfers principal from the lender to `payout_to`),
`sync` (permissionless: credits `repaid` from the slot's token account balance increase, forwards to the
slot lender, escrows if the forward fails), `claim` (slot lender submits a lender-claim spend through the
pool with the slot PDA as signer via CPI), `settle`, `shortfall` (view; 0 when expiry == 0), GRACE 7 days.

### 3.3 `capacity_stake` and `safety_pool` (Phase 2, for the H081 Token-2022 mint)

`capacity_stake`: config PDA `["config", mint]` created permissionlessly per mint (no admin). Same rules as
`CapacityStake.sol`: stake, request_unstake (7-day cooldown), unstake; capacity read off the stake account.
Units follow the mint's decimals: DESK_UNIT = SHIELD_UNIT = 100 whole tokens, SHIELD_PER_UNIT = 10,000 USDG
(6 decimals). Relayers enforce capacity off-chain; the pool never reads this program.

`safety_pool`: port of `SafetyPool.sol` (shares, 14-day unbonding at risk, insure by the slot lender before
expiry, permissionless slash when `stream_loan` reports a shortfall, pool-empty revert, generation reset).
It reads `stream_loan` accounts directly (same chain now). The self-lend and 1:1 valuation caveats from
`docs/tokenomics.md` still apply and must be restated.

## 4. SDK and tests

`src/solana/` (TypeScript, `@solana/web3.js` 1.x + borsh/anchor coder): PDA helpers, `fieldOf`, buffer
upload, instruction builders, a `SolanaWallet` with the same surface as `Wallet` in `src/client.ts`
(deposit, grant, pay, reclaim, delegate, pledge, proveStream, verifyStream, transferAllowance, sync from
`emit_cpi` events), `SolanaLenderWallet`, and capacity/safety helpers. Reuse `src/crypto.ts`,
`src/inputs.ts`, `src/prover.ts` and `src/encryption.ts` unchanged.

Tests: a local `solana-test-validator` in WSL (Ubuntu; Solana CLI 4.3.2; the existing script pattern in
`solana/scripts/start-validator.sh`, but loading our `.so` files with `--bpf-program` (stipend_pool: `--upgradeable-program`, see 4b), on its own ports,
never touching other validators already running) driven from Windows Node with vitest
(`test/solana/*.test.ts`, `npm run test:solana`). Mints are created locally (SPL Token and Token-2022). No
mainnet mint is hard-coded in programs; the SDK takes mints as parameters.

## 4a. Amendments after review (2026-10-26)

- Root history is 128 (the EVM pool's ROOT_HISTORY_SIZE); an earlier draft said 100. Superseded 2026-10-31, see 4b.
- Token destinations that extDataHash does not bind must be the owner's canonical associated token account:
  the spend public payout (`Recipient` otherwise), the lender leg (escrowed otherwise) and
  `pull_lender_share` (`LenderAccount` otherwise). Without this a submitter could divert a share to a
  non-ATA account owned by a slot PDA, where stream_loan never credits or moves it.
- stream_loan `shortfall` and safety_pool `slash` count the pool escrow of the slot
  (`["owed", asset, fieldOf(slot), loan_ref]`) as paid, like the unsynced inbox. `fund` holds whatever sits in
  the inbox at funding time (not repayment, matching onPledge) and refuses to fund while that escrow is non-empty.
- safety_pool prices shares on an accounted `assets` figure with virtual shares/assets (1,000 / 1), so
  donations to the vault do not move the price and first-depositor inflation does not pay.


## 4b. Amendments before mainnet (2026-10-31, stipend_pool security review)

- Root history DoS: with one root per leaf and 128 roots, anyone could flush the ring with cheap zero-amount
  transacts/grants (17 roots per grant) and make every pending proof stale. Now one root per INSTRUCTION
  (`merkle::insert` stages, `merkle::commit_root` advances the ring once after an operation's inserts; the
  proof's root is checked before them) and ROOT_HISTORY = 1,024, so a proof survives the next 1,023 operations.
  `is_known_root` scans newest first. The Pool account grew to 33,424 B (see 3.1: `grow_pool`).
- `initialize` was permissionless (the first caller set the config authority). It now requires the signer to
  be the program's upgrade authority: `program_data` must be the loader's ProgramData PDA `[program id]` and
  its recorded upgrade authority must equal the payer. The ProgramData header is parsed by hand
  (`upgrade_authority`): anchor's `Account<ProgramData>` / `Program::programdata_address` pull bincode into
  the binary (+57 KB of .so, i.e. deploy rent). Local validators load stipend_pool with
  `--upgradeable-program <id> <so> <authority>`, authority = the localnet-only
  `LOCALNET_UPGRADE_AUTHORITY` (test/solana/config-authority.ts).

## 5. Out of scope

Deploying anywhere public; a relayer service; changing circuits; the site's in-browser prover.
