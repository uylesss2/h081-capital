# H081 private reputation (ZK credit score)

Status: BUILT ON BRANCH `feat/zk-reputation`, tested on a local validator only. Nothing is deployed, published or
pushed. The verifying key committed in `solana/programs/rep_registry/src/generated/vk.rs` comes from a throwaway
single-party DEV setup; the mainnet build refuses to compile with it (section 11).

## 0. What a reputation proof says

An agent proves, to one named audience and for one challenge:

> "One account controls the loan keys of at least **N** fully repaid stream_loan loans in USDG, totalling at least
> **X**, from at least **L** distinct lender wallets, whose first and last funding are at least **D** days apart, and
> which fall in at least **M** distinct 30-day periods counting only loans of at least **F**."

It reveals nothing else: not which loans, when, which lenders, which keys, or the exact totals.

```ts
const ask = await desk.reputationRequest({ audience: 'acme-desk', minLoans: 3, minVolume: '500', minSpanDays: 90 });
const { code, presentation } = await agent.proveReputation({ request: ask.code });
const r = await desk.verifyReputation(code, { request: ask.code, presentation });   // r.ok, r.lowerBoundOnly === true
```

### What it guarantees (and what enforces it)

| Guarantee | Enforced by |
|---|---|
| A loan counts only if it was funded, fully repaid and never slashed | `attest` reads the live stream_loan `Slot` (owner, PDA, size, discriminator), needs `funded`, `repaid >= principal`, `principal >= 1 USDG`, and no `Subrogation` at stream_loan's PDA for the loan |
| A loan counts once across all proofs | one bit per loan ref in a bitmap page: `attest` refuses a second time |
| A loan counts once within a proof | the circuit needs strictly increasing loan refs over the enabled slots |
| Only the holder of the account secret can present it | every counted leaf's agent key must be `Poseidon(1, Poseidon(15, masterSk, k))` for the prover's one `masterSk` |
| A proof cannot be replayed to another verifier or challenge | public audience, nonce and expiry; the verifier checks its own request; `presNullifier` is per audience |
| A captured code is not a bearer token | bound by default: to the request's key, to a key the prover names, or to a fresh session key whose signature (`h081-rep-sig:`) is handed over separately at presentation; unbound codes are refused unless the verifier opts in |
| All counted loans are in the stated asset | the leaf commits `fieldOf(mint)`, the circuit uses the public `asset` |
| A raw-field caller cannot slip a wrapped threshold through | the circuit range-checks every threshold and the expiry; `verify_reputation` checks widths again and `now <= expiry <= now + 1 day` |

### What it does NOT show (every verifier-facing surface says this)

1. **Defaults.** Unpaid loans never enter the tree. A proof is a lower bound on good loans; a perfect record and one
   that hides ten defaults under other loan keys or other accounts look the same. A borrower can build a record,
   borrow big, default, and start a new account.
2. **Who supplied the money.** Anyone can repay a loan (a direct transfer to the inbox counts: it is real money).
3. **Whose loan it was.** stream_loan accepts a stream proof from the note's owner OR its agent, and the owner picks the
   agent key freely. So a third party can run loans under *your* public loan keys (you hand it `loanPk(k)` values, which
   costs you nothing) and the leaves then verify under your `masterSk`. Reputation can be **gifted or bought** without
   handing over any key. Closing this needs the stream proof to bind the agent key's holder (a stream_loan change, owner
   decision, section 13); until then the claim is "presentable only by the masterSk holder", not "earned by them".
4. **Independent lenders.** A lender can be the borrower's own second wallet; `minLenders` costs one wallet each.

So the score measures **capital throughput and calendar presence on loans bound to keys one account controls**. It is
not creditworthiness. Its cost to fake (section 9.2) is low. Never size credit from it alone; the backer feature must cap
a line at the backer's own shielded stake and use reputation only as a pricing input.

## 1. Why a new circuit and program (not disclose, not a stream_loan change)

`disclose.circom` has no key check (a lender holding the memo could prove), makes `agentPk` public, covers one note,
cannot count or sum, and the note holds neither the principal nor a clean "repaid" fact. The facts that matter live
only in the public `Slot`. So:

1. **New program `rep_registry`**: reads `Slot`/`Subrogation` by fixed offsets (no change to the four live programs),
   keeps its own Poseidon tree and verifying key. Alternative B (attest inside stream_loan, verifier inside
   stipend_pool) stays an owner option; it would touch two money programs with no ProgramData slack.
2. **New circuit `reputation.circom`.**
3. **Loan keys** `loanSk_k = Poseidon(15, accountSk, k)`: `bank.borrow` now pledges each loan to a fresh loan key
   instead of an HMAC sub-account (those cannot be tied to one account inside a circuit).

## 2. Data model

| Tag | Name | Use |
|---|---|---|
| 13 | `DOM_REP` | leaf |
| 14 | `DOM_REPNF` | presentation nullifier |
| 15 | `DOM_LOANKEY` | loan-key derivation |

- `loanSk(k) = Poseidon(15, accountSk, k)`, `k < 2^32`; `loanPk(k) = Poseidon(1, loanSk(k))` = the note's `agentPk` =
  `Slot.agent_pk`. The root account key is never used for a loan (it may already sit in shared addresses), and the
  circuit has no root-key path.
- Leaf: `R = Poseidon(13, agentPk, loanRef, principal, fieldOf(asset), fieldOf(lender wallet), floor(funded_at/86400), outcome)`
  with `outcome = 1` (repaid). The outcome input is there so a later version can attest defaults (outcome 0) into the
  same tree format; today only repaid loans are attested and the circuit forces outcome 1. No attest time (it could be
  delayed to inflate it); the funding day is fixed at funding.
- Tree: depth 20, the same `hash_left_right`, zeros and frontier as stipend_pool (`zeros.rs` is byte-identical; a test
  checks). One leaf and one committed root per attest; a ring of 256 roots.

## 3. Program `rep_registry` (`solana/programs/rep_registry`)

Localnet id `8w59GKraS4JrmDqYnqXcvjHTubnj7udMsuLXnscd3KEL` (from `solana/scripts/rep-keygen.sh`; the keypair lives in the
gitignored `solana/keys/`). It trusts stream_loan `FvM9Xcza…` on localnet and `8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4`
with `--features mainnet`. The mainnet build refuses to compile while `declare_id` is the localnet key or while
`REPUTATION_VK_IS_DEV` is true (checked: both guards fire). Upgradeable; the upgrade authority is kept. **Never `--final`.**
Built size: 168,672 bytes.

### 3.1 Accounts

| Account | Seeds | Layout | Size |
|---|---|---|---|
| `RepTree` (zero-copy) | `["reptree", version u16 LE]` | disc 8, next_index u32, current_root_index u32, version u16, bump u8, pad 5, filled_subtrees 20x32, roots 256x32 | 8,856 |
| `RepBits` | `["repbits", page u32 LE]` | disc 8, page u32, bump u8, bits 1,024 B (loan refs `page*8192 .. +8191`) | 1,037 |

- No per-loan marker account. Loan refs are sequential (stream_loan `Registry`), so one 1 KiB page marks 8,192 loans;
  the per-loan rent drops from about 0.0013 SOL (a 53-byte account) to about 0.000001 SOL.
- The leaf list is public in the `RepAttested` events (which carry the leaf preimage: all of it was public in the
  Slot) and in the relayer snapshot; every client rebuilds the tree and checks it against the on-chain root.
- Versioned trees: version `v > 0` can be opened (upgrade authority) only when `v-1` is full. A loan lives in one tree;
  a proof uses one tree.

### 3.2 Instructions

**`initialize(version)`**: upgrade authority only (ProgramData check, as stream_loan); creates `RepTree[version]`.
14,435 CU.

**`attest(loan_ref)`**: permissionless. Accounts: payer, slot, subrogation, rep_tree (mut), rep_bits (init_if_needed),
system_program. Checks, in order: slot owner is `STREAM_LOAN_ID`, its address is `["slot", ref]` under it, size 253,
`Slot` discriminator, `loan_ref` field matches; the subrogation account is stream_loan's `["subrogation", ref]` PDA
(checked BEFORE the emptiness test, so an empty look-alike is refused) and is empty; funded; `repaid >= principal`;
`principal >= 1_000_000`; agent key nonzero and in the field; `funded_at > 0`; the loan's bit not set. Then the leaf
(Poseidon syscall, 8 inputs), insert, commit, set the bit, emit `RepAttested{version, index, loan_ref, leaf, root,
agent_pk, principal, asset_f, lender_f, funded_day}`. 41,655-45,158 CU (the top includes creating a bitmap page).

Slot offsets (tested against `stream_loan::state::Slot` through a dev-dependency; the test fails on any layout move):
loan_ref 8, lender 16, funded 49, asset 51, principal 115, repaid 123, agent_pk 173, funded_at 205, size 253.
**Release checklist:** any stream_loan upgrade must re-run `cargo test -p rep_registry` and re-check what `repaid`
means (today it only grows, except `legacy_release`, which never takes it below the principal).

**`verify_reputation(proof, inputs[13])`**: stateless, CPI-able, 8 + 256 + 416 = 680 B of data. Every input `< r`;
`minLoans, minLenders, minMonths < 2^8`, `minSpanDays < 2^16`, `minVolume, monthFloor < 2^64`; `expiry < 2^63`,
`expiry >= now`, `expiry <= now + 86,400`; the root in the tree's ring; Groth16 (`groth16.rs` byte-identical to
stipend_pool's). Emits `ReputationVerified`. Does not consume the nonce: an on-chain caller keeps its own
`["used", audience, nonce]` PDA. **146,541 CU.** Groth16 proofs are malleable: dedupe on `(audience, nonce)` or
`presNullifier`, never on proof bytes.

### 3.3 Who attests, and the close race

`close_slot` erases the agent key, and a close can follow the final repaying sync in the same transaction, so a loan
must be attested while its slot is open. Callers:

1. **Lender:** `bank.lendClose` attests a repaid, unattested loan before `close_slot` (the lender is already public on
   the slot; it links nothing new).
2. **Relayer:** `POST /v1/rep/attest {loanRef}` (the borrower's bank calls it) and `RepRelayer.sweep()` for a cron. The
   relayer's hot wallet signs and pays.
3. **Never the borrower's wallet** by default: as signer and fee payer it would link the loan to the borrower on chain.
   `reputationAttest({ selfSign: true })` exists and says what it links.

Accepted and documented: a hostile lender, or any client older than this branch (agent 0.1.x / mcp-plugin 0.2.x
`lendClose`, the current site bundle, the house fleet's own close flow), can close a repaid loan without attesting it,
and a cron cannot catch a close in the same transaction as the repayment. The borrower loses that leaf. Fixing it for
good needs stream_loan to keep `agent_pk` and `funded_at` in `ClosedSlot` (an upgrade of a live money program; owner
decision). The house fleet's lend/close flows need the attest-before-close change too (they are kept out of git and
were not touched here).

## 4. Circuit `circuits/main/reputation.circom`, `Reputation(levels = 20, N = 16)`

Public inputs (13, in this order): `repRoot, asset, minLoans, minVolume, minLenders, minSpanDays, minMonths, monthFloor,
audience, nonce, expiry, bindTo, presNullifier`.

Private: `masterSk`; per slot `enabled, keyIndex, loanRef, principal, lenderF, fundedDay, pathElements[20],
pathIndices[20]`; one-hot `selLo`, `selHi`.

Constraints:
1. Range checks on the public thresholds and expiry (`minLoans, minLenders, minMonths < 2^8`, `minSpanDays < 2^16`,
   `minVolume, monthFloor, expiry < 2^64`); `masterSk != 0`.
2. Per slot: `enabled` boolean; `keyIndex < 2^32`, `loanRef, principal < 2^64`, `lenderF < 2^160`, `fundedDay < 2^32`;
   `sk = Poseidon(15, masterSk, keyIndex)`, `pk = Poseidon(1, sk)`; leaf with the PUBLIC asset and outcome 1;
   `MerkleCheck(enabled)`; `fundedDay = 30*month + rem`, `rem < 30`.
3. Enabled slots first: `enabled[j+1] * (1 - enabled[j]) = 0`.
4. `loanRef[j] < loanRef[j+1]` whenever `enabled[j+1]`.
5. `count >= 1`, `minLoans <= count`; `minVolume <= Σ enabled*principal`.
6. Distinct lenders: slot `j` counts when enabled and no earlier ENABLED slot has its lender (pairwise, every term gated
   by `enabled`, so zero padding adds nothing; tested with padding between enabled slots).
7. Distinct periods: the same over slots with `enabled` and `principal >= monthFloor`.
8. Span: `Σ selLo = Σ selHi = 1`, both select ENABLED slots, `lo + minSpanDays <= hi`.
9. `presNullifier = Poseidon(14, masterSk, audience)`.
10. `nonce`, `bindTo` bound by squaring (Groth16 binds every public input anyway).

**Measured:** 102,129 constraints with circom `--O2` (214,206 with the default `--O1`, which keeps linear constraints).
`build-circuits.mjs` passes `--O2` for reputation only, so the six ceremony circuits' r1cs never change. That fits pot17
(131,072) with 22% headroom. Dev zkey 64.9 MB, wasm 4.3 MB. Proving in Node: about 2.5-3 s on this machine (measured in
the tests); a browser will be several times slower and the 65 MB download is heavy on mobile: for a LiveBank panel,
consider an N = 8 variant (about 51k constraints, pot16) as a second verifying key in the same program.

There is no remote proving: the witness contains `masterSk`. No x402 service may prove reputation.

## 5. SDK and bank

Core: `src/crypto.ts` (`DOM.REP/REPNF/LOANKEY`, `loanSk`, `loanPk`, `repLeaf`, `presNullifier`); `src/reputation.ts`
(`reputationInput`, `selectLoans` with `ReputationUnreachable` naming what is short, the ladder, `snapRequirement` (down,
for proving) and `snapRequirementUp` (up, for asking), `audienceOf`); `src/solana/reputation.ts` (PDAs, `attestIx`,
`verifyReputationIx`, `repInitializeIx`, decoders, the event log with per-program log attribution so another program in
the same transaction cannot pass off a fake event, `rebuildRepTree` that checks every leaf hash and the final root
against the chain, `fetchRepLeaves` (snapshot, topped up from the chain when behind), `myRepLoans` with a gap limit).

`audienceOf` is domain separated: a key is `sha256(0x01 || key)[0..20]`, a name `sha256(0x02 || "h081-rep-audience|" || name)[0..20]`.

Bank (`integrations/core/reputation.ts`, delegated from `H081Bank`):

- `borrow` pledges to a fresh loan key (virtual sub-account index `1000 + k`, so pay, reclaim and balance see it)
  unless `agentIndex` names a legacy sub-account; used keys are cached (`<cache>/...loankeys-<signer>.json`) before the
  grant, and recovery scans slots and events with a gap limit of 20.
- `reputationRequest` → `h081-rep-ask:` (thresholds rounded UP to the ladder; optional `bindTo`).
- `proveReputation({request} | {audience, thresholds})` → `h081-rep:` and, when the request binds no key, an
  `h081-rep-sig:` presentation from a fresh session key. Thresholds snap DOWN when given directly. The prover refuses a
  fifth distinct threshold set per audience per UTC day (probing). Local proof only, verified locally before it is
  handed out.
- `verifyReputation(code, {request} | {audience, nonce}, presentation?, allowBearer?, onChain?)` checks, in order:
  frame, kind, network tag; audience, nonce and thresholds against the request; the binding (request key, or the
  presentation's key and signature, or refused as bearer); `now <= expiry <= now + 1 day`; the root in the on-chain
  ring; Groth16 against the vkey whose sha256 is pinned in `CIRCUIT_HASHES.reputation` (empty today: unreleased, so
  only a localnet dev setup with `H081_REP_DEV_SETUP=1` passes); optionally a read-only simulation of
  `verify_reputation`. Every result carries `lowerBoundOnly: true`, `statement` and `setup`.
- `reputationStatus` (attested count, volume, lenders, span, periods; pending repaid-but-unattested loans; legacy loans
  under HMAC sub-accounts that can never count, with warnings) and `reputationAttest` (plan unless confirm; via the
  relayer).

Ladder: loans 1, 2, 3, 5, 8, 12, 16; volume 0 and 1 / 2.5 / 5 × 10^k USDG; lenders 0, 1, 2, 3, 5, 8; span 0, 7, 30, 90,
180, 365, 730 days; periods 0, 1, 2, 3, 6, 9, 12, 16.

## 6. Integrations (built)

| Surface | Added |
|---|---|
| operations (`schemas.ts`, `operations.ts`) | `h081_reputation_request`, `h081_prove_reputation`, `h081_verify_reputation`, `h081_reputation_attest` (plan/confirm), `h081_reputation_status`; descriptions state the limits (section 0) and the beta setup |
| MCP | the five tools, from the operation table |
| Agent Kit plugin | five actions and methods |
| `@h081lll/agent` | `reputationRequest`, `proveReputation`, `verifyReputation`, `reputation`, `reputationAttest`; `checkCode` reads kinds 7-9; `CIRCUIT_MB` gains `disclose` and `reputation` |
| CLI | `h081 rep ask \| prove \| verify \| attest \| status` |
| local API | `POST /v1/reputation/{request,prove,verify,attest}`, `GET /v1/reputation`; `openapi.json` regenerated |
| relayer | `GET /v1/rep/leaves`, `GET /v1/rep/roots`, `POST /v1/rep/attest`, `RepRelayer.sweep()`; `RELAYER_REP_PROGRAM_ID`, `RELAYER_REP_MIN_PRINCIPAL` (default 10 USDG). No proving route. No free verify route (owner decision) |

Not built here (other repo or deploy config): the site (code kinds in `src/lib/live/codes.ts`, a LiveBank panel, a
docs page, a `drive-live-localnet.mjs` check), and the Vercel cron entry that calls `sweep()`.

## 7. Codes (v2 frame, base58)

Network tag over `(cluster, rep_registry id, USDG mint)`; the asset is implicit (the tag's mint).

| Kind | Prefix | Body |
|---|---|---|
| 7 | `h081-rep:` | ver 1, treeVersion u16, proof 256, repRoot, presNullifier, audience, nonce (32 each), expiry u64, bindTo 32, minLoans u8, minVolume u64, minLenders u8, minSpanDays u16, minMonths u8, monthFloor u64: 448 B |
| 8 | `h081-rep-ask:` | ver 1, audience, nonce, expiry u64, bindTo (0 = none), thresholds (21 B), label len u8 + UTF-8 ≤ 32 |
| 9 | `h081-rep-sig:` | session pub 32, ed25519 signature 64 over `sha256("h081-rep-present|" ‖ audience ‖ nonce ‖ presNullifier)` |

All three are in `CODE_KIND`, `KIND_NAME` and `PREFIX_KIND`; a pasted code of the wrong kind gets the existing "this is a
… code" message.

## 8. Tests (what ran on this branch)

- Circuit, witness only (`test/circuits/reputation.test.ts`, 18): accepts 1, 3 and 16 loans, mixed keys, every bound
  exactly met; rejects one over each bound, a duplicate, an unsorted pair, another master's leaf, a bad leaf or path,
  an asset mismatch, a selector on a disabled slot, an enabled gap, padding that tries to add lenders or volume, zero
  slots, a wrong or other-audience nullifier, every out-of-range private and public value, `masterSk = 0`.
- Rust (`cargo test -p rep_registry`, 9): Slot offsets against stream_loan's struct, ids and seeds against
  stream_loan's, leaf equals the SDK fixture, zeros and `groth16.rs` identical to stipend_pool's, account sizes, tree
  vs a naive rebuild, public-input range checks, bitmap pages.
- Bank level with real dev-setup proofs over a mocked chain (`test/integrations/reputation.test.ts`, 12): ladder,
  selection, audiences, codes 7/8/9 (round trip, pasted noise, checksum, network, wrong kind), request → prove → verify,
  request-bound and session-bound presentation, and refusals: no presentation, wrong signer, other audience, other nonce,
  weaker claim, bearer, expired, too long-lived, unknown root, tampered input, tampered proof, the probing cap, another
  account. A test found and fixed a real bug (a decoded request spread into the code overwrote the session binding).
- Localnet (`npm run test:solana:rep`, rpc 8899, 14): initialize (authority only, once; version 1 needs version 0
  full); attests from a third-party payer, bitmap pages, double attest; refuses unfunded, partly repaid, slashed, tiny,
  fake owner, zero key, mismatched ref, closed slot, a look-alike Subrogation and a wrong slot; leaf list rebuild,
  snapshot round trip, doctored snapshot refused; own-loan discovery per master and asset; on-chain verify (CU above),
  tampered inputs and proof, out-of-width thresholds, expired, more than a day, unknown root; master B cannot use A's
  leaf; the relayer attests with only its hot wallet as signer, refuses below its floor, twice, unfunded, closed and
  malformed, its sweep attests the rest, and its leaf list is accepted by a client.
  Slots are fixture accounts loaded with `--account-dir` at their real PDAs: real stream proofs would need the pool's
  ceremony proving keys, which this work does not use. So the "bank borrower auto-attests / lendClose attests first"
  flow is covered by unit tests with a mocked chain, not end to end.
- Integrations: schemas, MCP, plugin, agent CLI, OpenAPI route list, relayer routes and config, a drift test between
  the Rust source and the SDK (ids, error table, sizes, public-input order).

## 9. Soundness and economics (review findings and how each was resolved)

### 9.1 Blocking findings

| Finding | Resolution |
|---|---|
| Reputation can be gifted or bought without handing over a key (stream proof accepted from the owner, agent key chosen freely) | **Claim dropped** (section 0, item 3). Per-loan keys make this inherent: even binding the stream prover to the agent key would not help, since `loanSk(k)` can be handed over without revealing `masterSk`. A real fix needs the stream proof to show the agent key derives from the pledging account (circuit + stream_loan change; owner decision). |
| "Can't be faked" means "can be bought for 0.25%" | Stated plainly (section 0, 9.2). Added a time-and-money signal: distinct 30-day funding periods with a per-loan floor. Duration-weighted volume is not possible without a repayment time in the Slot (stream_loan change; owner decision). |
| The score only goes up; bust-out is free | Every verifier surface says the proof is a lower bound and says nothing about defaults. The leaf has an outcome input so a later version can attest defaults (outcome 0) and add a "keys 0..K-1 all present and repaid" mode without a new tree format. Not built. |
| Borrower-signed attests link loans to the borrower | Attest never borrower-signed by default (relayer or lender); tested that the relayed attest's only signer is the hot wallet. Per-loan payout addresses are NOT built (section 10, item 2): a launch gate. |
| The lender alone decides whether a loan ever counts | Accepted and documented (section 3.3); new lender code attests first; the ClosedSlot fix is an owner decision. |
| Relayer drain | Bitmap instead of rent-bearing markers; relayer floor 10 USDG (config refuses < 1 USDG) and a rate-limit token per attest. |
| Threshold range checks | In the circuit and again in `verify_reputation`; expiry capped at one day past the clock. Tested at both layers. |
| Trusted setup | Labelled "beta: single-party trusted setup" in every result and description; mainnet build refuses a dev key; ceremony steps in section 11. |

### 9.2 What faking costs (honest)

The only per-loan costs of a wash loan are the 0.25% origination fee, transaction fees and slot rent (refunded on
close); capital can be recycled. 1M USDG of volume costs about 2.5k USDG. Two 1-USDG loans a year apart give a 365-day
span for about 0.005 USDG, so span alone is weak. `minMonths` with a meaningful `monthFloor` (for example 12 periods of
at least 1,000 USDG) costs 12 × 2.5 USDG and, unlike the rest, a year of calendar time that cannot be compressed; it can
still be prepared in advance. `minLenders` costs one wallet per lender. Verifiers should ask for periods with a floor
plus volume, and treat the result as a pricing input.

### 9.3 Improvements taken

Claims fixed (section 0); Subrogation PDA derived under `STREAM_LOAN_ID` and checked before emptiness; bound by default
with a session-key signature, bearer codes refused; domain-separated `audienceOf`; no root-key loans; the probing cap
enforced by the prover; versioned tree seeds; leaves from a snapshot checked against the chain, full-set fetch; measured
constraints (with an N = 8 browser option); padding cannot add lenders or periods (tested); the backer interaction
(cap a line at the backer's stake); `reputationStatus` warns about legacy-key loans; release-checklist line and offset
test for stream_loan upgrades; rent model in section 14.

## 10. Privacy (honest)

Hidden from the verifier: which loans, the exact count and volume, the lenders, the dates beyond the span and periods,
the loan keys, the account.

The anonymity set is **not** "all attested loans". It is the set of account-sized clusters of loans that meet the
stated thresholds, and clustering is possible:

1. **Public data.** Slots (lender, principal, payout account, agent key, funding time) and the attested leaves are
   public. The proof hides which leaves it uses; the set of repaid loans is public, as it is today.
2. **`payout_to` links all of an agent's loans** (the principal goes to the agent wallet's public token account). A
   verifier that knows the thresholds can list the clusters that meet them, often just one at high thresholds:
   deanonymisation without breaking the proof. **Launch gate (not built):** per-loan payout addresses (a fresh owner per
   loan, swept into the pool through a relayed deposit) for every loan that counts. Until then `reputationStatus`
   warns, and `bindTo` must never be the agent wallet.
3. **Signer and fee payer** of the attest: solved for H081 clients (relayer or lender), not for third-party attesters.
4. **Per-audience linkability** by `presNullifier`, by design. Colluding audiences can still intersect results by
   timing and thresholds.
5. **Threshold probing**: the ladder plus at most 4 distinct sets per audience per day (prover side).
6. **Root timing**: the root dates the proof to after a given attest. Minor.
7. **Proof rental**: an agent can prove for a buyer with the buyer's `bindTo`. Cryptography cannot stop it; the
   nullifier gives each audience "one reputation per account".
8. **Legacy loans** (HMAC sub-accounts, or closed before rep_registry exists) never count.

## 11. Trusted setup

- **Dev / CI:** `node scripts/build-circuits.mjs reputation` then `node scripts/setup-circuits.mjs reputation` (one
  throwaway contribution on a throwaway pot17, generated as CI does). `setup-circuits` writes no Solidity verifier for
  reputation. `node scripts/gen-rep-vk.mjs` writes only `rep_registry/src/generated/vk.rs` (with `REPUTATION_VK_IS_DEV
  = true` and the vkey sha256); `--check` compares. **Never run `npm run solana:vk` after a dev setup** (it would
  overwrite the pool's ceremony keys).
- **Production (owner):** a separate ceremony run for reputation only:
  `node scripts/ceremony.mjs init --dir <D> --ptau <pot17> --circuits reputation`, contributions (including outside
  contributors, not only machines of the team), `beacon`, `verify`, `export` (without `--install`, which is for the six
  pool circuits), then `node scripts/gen-rep-vk.mjs --ceremony <D>/.../reputation.vkey.json` (sets `IS_DEV = false`),
  pin the wasm/zkey/vkey sha256 in `integrations/core/constants.ts CIRCUIT_HASHES.reputation`, and publish the
  transcript hash next to the vkey hash. Until a multi-party ceremony with outside contributors and a public
  transcript, whoever ran the setup can forge any reputation; keep the "beta, single-party" label.

## 12. Rollout (owner order; nothing here was done)

No existing program changes. Launch gates first: ceremony (section 11), per-loan payout addresses (section 10.2), site
and house-fleet lenders attesting before close.

1. Ceremony; pin hashes; regenerate `vk.rs`.
2. Program: build with `--features mainnet` (patch `declare_id`), deploy with headroom, keep the upgrade authority
   (never `--final`), `initialize(0)`.
3. Relayer: `RELAYER_REP_PROGRAM_ID`, the sweep cron; stage with `--skip-domain`, probe, promote.
4. npm: agent 0.3.0, mcp/plugin 0.4.0 (borrow switches to loan keys; HMAC sub-accounts still scanned; old packages keep
   borrowing under keys that never count and `reputationStatus` in the new ones says so).
5. Site: code kinds, panel, docs, `drive-live-localnet` check.

## 13. Owner decisions

1. Architecture: `rep_registry` (built) or Alternative B.
2. Whether slashed-then-recovered loans count (default no).
3. Relayer floor and who pays attests (hot wallet, platform fees only; creator fees never touched).
4. N = 16 only, or also an N = 8 browser key.
5. Ladder values and the per-audience cap.
6. Per-loan payout addresses (a launch gate here, not an option).
7. The ceremony and its contributors.
8. A free relayer verify route.
9. stream_loan changes that would close the remaining gaps: keep `agent_pk`/`funded_at` in `ClosedSlot` (close race);
   record a repayment time (duration-weighted volume); bind the stream prover to the pledging account (gifting).
10. Default attests (outcome 0) and the contiguous-key "no hidden defaults on this account" mode.

## 14. Cost (mainnet, estimates at 6,960 lamports per byte)

| Item | Estimate |
|---|---|
| ProgramData, 168,672 B as built | ≈ 1.17 SOL; ≈ 1.47 SOL with 25% headroom (locked; back only through program close) |
| RepTree (8,856 B) | ≈ 0.062 SOL, once per tree version |
| RepBits page (1,037 B) | ≈ 0.008 SOL per 8,192 loan refs |
| Per attested loan | one transaction fee (≈ 5,000 lamports + priority), paid by the attester; no per-loan rent |
| `verify_reputation` | 146.5k CU, base fee only (simulation is free) |
| Total one-time | ≈ 1.25-1.55 SOL |
