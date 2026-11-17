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
// one call: the prover names the verifier and the thresholds
const p = await agent.proveReputation({ audience: 'acme-desk', minLoans: 3, minVolume: '500' });
// p.code ("h081-rep:", which carries the audience, nonce and thresholds), p.presentation ("h081-rep-sig:"),
// p.challenge === 'prover-chosen'; the verifier states what it requires (nothing else does without a request):
const v = await desk.verifyReputation(p.code, { audience: 'acme-desk', nonce: p.nonce, presentation: p.presentation, minLoans: 3, minVolume: '500' });

// a desk that sets the thresholds and the challenge itself hands out a request code (framed: checksum, kind, network)
const ask = await desk.reputationRequest({ audience: 'acme-desk', minLoans: 3, minVolume: '500', minSpanDays: 90 });
const { code, presentation } = await agent.proveReputation({ request: ask.code });
const r = await desk.verifyReputation(code, { request: ask.code, presentation });   // r.ok, r.lowerBoundOnly === true
```

The same one call exists on every surface (section 6): MCP `h081_prove_reputation`, Agent Kit `H081_PROVE_REPUTATION`
and `h081ProveReputation`, CLI `h081 rep prove --audience A --nonce N --min-loans 3 --min-volume 500`, local API
`POST /v1/reputation/prove`. `minVolume` / `monthFloor` are decimal USDG; the first release's names `minVolumeUsdg` /
`monthFloorUsdg` stay accepted as aliases (one of each pair; both is refused). Without `nonce` the prover draws one and
returns it (`p.nonce`, also inside `p.code`, and `p.challenge === 'prover-chosen'`). A verifier without a request
checks with `{ audience, nonce }`, but that nonce came from the prover, so the check is a tautology: **the no-request
flow gives no challenge freshness**. Whoever holds the code and its presentation can present it until it expires (at
most a day); only the expiry and the verifier's own record of accepted nonces stop a replay. It also fixes no
thresholds: verify on the `{ audience, nonce }` path checks the thresholds the verifier passes (`minLoans`,
`minVolume`, ...; compared as given, not rounded) and otherwise accepts whatever claim the prover chose, which the
verifier then has to compare in `thresholds` itself. A verifier that needs a live answer or fixed thresholds issues a
request code. An optional `nonce` input lets a verifier's own challenge be passed in without a request code
(`challenge: 'verifier'`); it is a raw number copied between parties, which the code-framing rule (letters and digits,
checksum, kind, network tag) discourages, so the documented flow for a verifier-set challenge is the request code, and
whether to keep the raw input is listed for the owner (section 13).

### What it guarantees (and what enforces it)

| Guarantee | Enforced by |
|---|---|
| A loan counts only if it was funded, fully repaid and never slashed | `attest` reads the live stream_loan `Slot` (owner, PDA, size, discriminator), needs `funded`, `repaid >= principal`, `principal >= 1 USDG`, and no `Subrogation` at stream_loan's PDA for the loan |
| A loan counts once across all proofs | one bit per loan ref in a bitmap page: `attest` refuses a second time |
| A loan counts once within a proof | the circuit needs strictly increasing loan refs over the enabled slots |
| Only the holder of the account secret can present it | every counted leaf's agent key must be `Poseidon(1, Poseidon(15, masterSk, k))` for the prover's one `masterSk` |
| A proof cannot be replayed to another verifier or challenge | public audience, nonce and expiry; the verifier checks its own request; `presNullifier` is per audience. Holds for a challenge the verifier issued (a request code, or a nonce it gave). A nonce the prover drew (`challenge: 'prover-chosen'`) binds the audience only: within the expiry, a replay to that verifier is stopped only by its record of accepted nonces |
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
2. **Relayer:** `POST /v1/rep/attest {loanRef}` (the borrower's bank calls it) only checks the loan and **queues** it
   (202); nothing is sent then. The sweep (every `RELAYER_REP_SWEEP_MIN` minutes in the long-running server, or the cron
   route `GET /v1/rep/sweep` with `CRON_SECRET`) attests every queued loan together with every other repaid,
   unattested loan of at least the floor, in loanRef order. The relayer's hot wallet signs and pays. The bank posts a
   borrower's loans in random order.
3. **Never the borrower's wallet** by default: as signer and fee payer it would link the loan to the borrower on chain.
   `reputationAttest({ selfSign: true })` exists and says what it links.

**What queueing fixes and what is left.** Sent on request, a borrower's attests for loans X, Y and Z would land as a
burst outside the sweep cadence, which clusters them on chain for anyone watching. Queued, they land inside a sweep
alongside every other repaid loan, ordered by loanRef, so the chain shows nothing about who asked. What remains: the
**relayer operator** (its request log) sees one client (an IP) name loans X, Y and Z within one call, which ties them
together off chain. That is an operator-trust link, like the `payout_to` launch gate in section 10 item 2 is an on-chain
one, and it is not closed here. It goes away when no request is needed at all: the sweep already attests every eligible
loan without being asked, so a borrower who trusts the sweep to run can skip `reputationAttest` (its loans then show as
`pending` in `reputationStatus` until the next sweep). Fixing it inside the request path needs requests spread over time
from unrelated network paths (minutes to hours apart), which a tool call cannot do; not built.

Accepted and documented: a hostile lender, or any client older than this branch (agent 0.1.x / mcp-plugin 0.2.x
`lendClose`, the current site bundle, the house fleet's own close flow), can close a repaid loan without attesting it,
and a cron cannot catch a close in the same transaction as the repayment. The borrower loses that leaf. Fixing it for
good needs stream_loan to keep `agent_pk` and `funded_at` in `ClosedSlot` (an upgrade of a live money program; owner
decision). The house fleet's lend/close flows need the attest-before-close change too (they are kept out of git and
were not touched here).

### 3.4 Backed loans and slashed loans: never counted, and never mislabelled

The backed-line feature (branch `feat/private-backer`, docs/BACKER-SPEC.md there, section 13) funds a slot through
`fund_backed` with `pledge_bps = 0` and `agent_pk = 0`, and creates the loan's **Subrogation at funding**: it routes the
backer's fee or recovery to the Backing's vault. It is not a slash. A safety-pool slash leaves a Subrogation too.

- **On chain nothing changes.** `attest` refuses any loan whose Subrogation PDA holds data, so a backed loan is refused
  with error `Slashed` (6010) whatever its agent key (tested on the validator with both a live and a missing Backing).
  The program was not rebuilt for this; its error name stays `Slashed`, and the SDK readers below say which one it is.
- **Readers** use `repBlockOf(connection, slot, loanProgram)` (`src/solana/reputation.ts`): `backed` when the slot is
  funded with `pledge_bps == 0` (checked first, so a closed or missing Backing never turns a backed loan into a slash),
  else `backed` when the Subrogation's `safety_config` is a Backing account of the loan program (owner, discriminator,
  278 bytes: `isBackedSubrogation`), else `slashed`; `no_agent_key` for a zero key. `isBackedSlot`,
  `isBackedSubrogation` and `isBackingAccount` are a minimal **read-only port** of the same-named helpers in that
  branch's `src/solana/backer.ts` (same names and rules); nothing else of the backer feature is on this branch, and no
  branch was merged. When the two branches meet, keep one copy (the backer branch's) and re-export it here.
- **Relayer:** `POST /v1/rep/attest` answers `409 backed` ("the backer's fee or recovery, not a slash") or `409
  slashed` and queues nothing. The sweep never makes a backed slot a candidate, and reports slashed ones under
  `skipped` (never sent, never `failed`, so they no longer show as a send failure every run).
- **Lender close:** `lendClose` sends no attest for a backed, slashed, keyless or sub-1-USDG loan (it would fail) and
  logs why.
- **Borrower:** `reputationStatus` lists repaid loans that can never count under `never` (`backed`, `slashed`,
  `no_agent_key`, `too_small`) with a warning, instead of showing them as `pending` forever; `reputationAttest` does not
  ask the relayer for them. A backed loan has agent key 0, so it never matches an account's loan keys and does not show
  up in an account's status at all; a slashed-then-repaid stream loan does (tested: loan 25 below).

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
  grant, and recovery scans slots and events with a gap limit of 20. Before it picks a key, `borrow` also adds every key
  the account's own grants (in the synced pool log, spent ones included) already used, scanning 20 past the highest, so
  a lost cache dir, a restore on another machine, or a second process on the same signer never reuses a loan key (two
  Slots with one `agent_pk` would be linked on chain). Two processes that borrow at the same moment on one signer (an
  MCP server and the CLI) no longer pick the same key: the pick re-reads the key list under an exclusive lock file next
  to it (`<list>.lock`, `integrations/core/loankeys.ts`), takes the first free key and writes it back before the lock is
  released; every other write to the list merges under the same lock. Each lock holds a token unique to its holder, and
  release removes it only while it still holds that token. A lock older than 30 s (a crashed process; a pick holds it
  for milliseconds) is taken over, only under a short-lived `<list>.lock.takeover` file, inside which the waiter
  re-reads the lock and removes it only if it still holds the token the waiter saw stale: two waiters that saw the same
  stale lock cannot both take it. A held one is waited for up to 10 s, then the borrow is refused with nothing sent. Without a cache dir there is one process's memory only, as before.
- `reputationRequest` → `h081-rep-ask:` (thresholds rounded UP to the ladder; optional `bindTo`).
- `proveReputation({request} | {audience, nonce?, thresholds})` → `h081-rep:` and, when the request binds no key, an
  `h081-rep-sig:` presentation from a fresh session key, plus the `audience` and `nonce` the code answers (0x hex) and
  `challenge` (`request`, `verifier` or `prover-chosen`: who chose the nonce). A
  `nonce` given without a request is the verifier's own challenge (1 .. 2^248 - 1, refused otherwise before proving);
  without one a fresh random nonce is drawn, and `next` says it proves no freshness. Thresholds snap DOWN when given directly. The prover refuses a
  fifth distinct threshold set per audience per UTC day, a fifth per `bindTo` key (from the request or the caller), and a
  ninth across all audiences (`REP_MAX_SETS_PER_DAY_ALL`): a verifier that knows the prover through its own channel
  cannot binary-search the record by asking under fresh audience names. A set already proven today is free again. The
  log is kept in the cache dir, and in memory for the life of the process when there is none (never skipped). Local proof only, verified locally before it is
  handed out.
- `verifyReputation(code, {request} | {audience, nonce, thresholds?}, presentation?, allowBearer?, onChain?)` checks,
  in order: frame, kind, network tag; audience, nonce and thresholds against the request (thresholds given next to a
  request are refused), or, without one, audience, nonce and the thresholds the verifier passes (each one compared as
  given; none given means any claim passes); the binding (request key, or the
  presentation's key and signature, or refused as bearer); `now <= expiry <= now + 1 day`; the root in the on-chain
  ring; Groth16 against the vkey whose sha256 is pinned in `CIRCUIT_HASHES.reputation` (empty today: unreleased, so
  only a localnet dev setup with `H081_REP_DEV_SETUP=1` passes); optionally a read-only simulation of
  `verify_reputation`. Only an `InstructionError` from the simulation is the program's answer ("verify_reputation
  refused it: <error name>"). Everything else is `ok: false`, `onChain.ran: false` and a reason that says the
  simulation could not run and that the off-chain checks passed: a fee payer whose balance is below the fee the RPC
  quotes for the message (checked first; the reason names that fee), a transaction error before execution
  (`AccountNotFound`, `InsufficientFundsForFee`, `BlockhashNotFound`, ...), or an RPC call that throws. (A wallet with no
  SOL used to come back as "verify_reputation refused it: AccountNotFound", found by the validator test in section 8;
  the first fix tested for a zero balance only, so a wallet holding dust still read as a refused proof.) Every result
  carries `lowerBoundOnly: true`, `statement` and `setup`.
- `reputationStatus` (attested count, volume, lenders, span, periods; pending repaid-but-unattested loans; `never`:
  repaid loans rep_registry refuses for good, by reason, section 3.4: in a borrower's status only `slashed` and
  `too_small` can appear, since a backed loan has agent key 0 and never matches the account's loan keys; legacy loans
  under HMAC sub-accounts that can never count, with warnings) and `reputationAttest` (plan unless confirm; via the relayer; never asks for a `never` loan).

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
| relayer | `GET /v1/rep/leaves` (incremental, single-flight), `GET /v1/rep/roots`, `POST /v1/rep/attest` (202, queued; `409 backed` / `409 slashed` / `409 no_agent_key` never queued, section 3.4), `GET /v1/rep/sweep` (cron, `CRON_SECRET`; its result lists `skipped` loans that can never count) and a sweep timer in `main.ts`; every rep route takes a rate-limit token; `RELAYER_REP_PROGRAM_ID`, `RELAYER_REP_MIN_PRINCIPAL` (default 10 USDG), `RELAYER_REP_SWEEP_MIN` (default 15). No proving route. No free verify route (owner decision) |

**The one-call shape** `proveReputation({ audience, minLoans, minVolume })` (section 0) is the same on every surface:
the operation schema takes `minVolume` / `monthFloor` (decimal USDG) with `minVolumeUsdg` / `monthFloorUsdg` kept as
aliases (zod refuses both of a pair; `runOp` folds the alias), and a prover-side `nonce` (refused next to a
`request`, which carries its own). The agent method, the local API body (no renaming layer any more: the methods fold
the aliases), the CLI (`--nonce`), MCP and Agent Kit (actions, methods and examples now use `minVolume`) all pass it
through; `openapi.json` regenerated.

Not built here (other repo or deploy config): the site (code kinds in `src/lib/live/codes.ts`, a LiveBank panel, a
docs page, a `drive-live-localnet.mjs` check), and the Vercel cron entry that calls `GET /v1/rep/sweep`. The cron is
left to the owner because it changes a live deploy config and Vercel's plan limits decide whether a 15-minute schedule
deploys at all. The entry, for `deploy/relayer-vercel/vercel.json` `crons` (with `CRON_SECRET` and
`RELAYER_REP_PROGRAM_ID` set on the relayer project; without them the route answers 503 and sends nothing):

```json
{ "path": "/v1/rep/sweep", "schedule": "*/15 * * * *" }
```

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

Last full run, 2026-11-17, on this machine (Windows, the Solana toolchain in WSL), after the fourth pass (section 9.6;
the `cargo test` and `npm test` rows are from the third pass and were not re-run):

| Command | Result |
|---|---|
| `npm run test:solana:rep` (validator on rpc 8899: rep_registry + stream_loan built from this worktree, fixtures) | 16 passed (14 before the third pass) |
| `npx vitest run test/circuits/reputation.test.ts test/sdk/rep-consistency.test.ts` | 21 passed (18 circuit, 3 drift) |
| `npx vitest run test/integrations test/relayer` | 345 passed, 9 skipped (localnet-only, POSIX-permission and mainnet-read tests); 338 after the third pass, 324 before it |
| `cargo test -p rep_registry` (WSL; the program is unchanged in this pass) | 9 passed |
| `npm run typecheck` | clean |
| `npm run build:integrations` | mcp, plugin and agent build |
| `npm test` (everything but test/solana) | 466 passed, 36 failed, 49 skipped. The 35 failures in `test/e2e/pool.test.ts` (and the skipped e2e files) need the pool's proving keys (`missing proving key for transact; run npm run circuits:setup`), which are not in this worktree's build/circuits and were deliberately not generated (that is the pool setup). The other one was `agent-auth` "a wrong token gives 401": the test makes the wrong token by replacing the last character with `x`, which is the right token when it already ends in `x` (about 1 run in 64); it passed on re-run. Neither touches reputation. |

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
  ceremony proving keys, which this work does not use.
  Added in the third pass (16 now):
  - **Backed loans** (fixtures 20 and 22: `pledge_bps = 0`, agent key 0, a Subrogation naming a Backing account, live
    for 20 and missing for 22): `attest` refuses both (error `Slashed`); `repBlockOf` reads both as `backed` and the
    safety-pool slash (7) as `slashed`; `isBackedSubrogation` is true for 20 only. The relayer answers `409 backed` for
    20 and 22 and `409 slashed` for 7; its sweep never makes 20/22 candidates and lists 7 and 25 under `skipped` with
    `failed` empty.
  - **The bank flow end to end on the validator**, with the real `H081Bank` (account C, fixtures 23-25): status lists 23
    and 24 as pending and 25 (slashed, then repaid) under `never`; the plan names 23 and 24; `reputationAttest` queues
    23 at a local relayer (202) and reports 24 below that relayer's 25 USDG floor; the sweep attests 23 from the hot
    wallet only. Then the **lender** bank (signer LENDER_K, the slot's lender) runs `lendClose` on 24: two
    signatures, the first one a rep_registry attest from the lender wallet, the second **stream_loan's real
    `close_slot`** (the program built from this worktree, loaded at its localnet id): the slot is gone, the
    ClosedSlot receipt exists, and the leaf survived. Status then shows 2 loans, 45 USDG, 2 lenders, nothing pending.
    Finally the **one call** `proveReputation({ audience, nonce, minLoans: 2, minVolume: '25' })` is checked by a
    second bank with `{ audience, nonce, presentation, onChain: true }` (the `verify_reputation` simulation passes), a
    wrong nonce is refused, and an out-of-reach claim names what is short. This test found a bug: an on-chain check
    from a verifier wallet with no SOL came back as "verify_reputation refused it: AccountNotFound" (section 5); fixed.
  - What still is not end to end: a **borrow** (a real grant and stream proof) and a **fund**; both need the pool's
    ceremony proving keys (not in this worktree, see the `npm test` row above). `borrow`'s loan-key choice is covered by
    unit tests (below), and every attest path after funding is now covered on the validator.
- Integrations: schemas, MCP, plugin, agent CLI, OpenAPI route list, relayer routes and config, a drift test between
  the Rust source and the SDK (ids, error table, sizes, public-input order). Third pass:
  - `test/integrations/reputation-surfaces.test.ts` (7): the one-call shape `{ audience, minLoans, minVolume, nonce? }`
    through the zod schema, `runOp`, MCP `tools/call`, the Agent Kit action and method, the agent method and
    `POST /v1/reputation/prove`; the `minVolumeUsdg` / `monthFloorUsdg` aliases reach the bank as `minVolume` /
    `monthFloor`; both of a pair, a nonce or thresholds next to a request, and malformed nonces are refused before the
    bank; a returned nonce (0x + 64 hex, as every code prints it) goes straight back into verify through `runOp`.
  - `test/integrations/reputation.test.ts` (18, was 17 before this pass): adds the one-call prove with the
    verifier's nonce (returned, verified with `{ audience, nonce }`, another nonce refused, a fresh nonce returned when
    none is given, 0 and 2^248 refused before proving).
  - `test/integrations/loankeys.test.ts` (6, was 4): two banks with stale in-memory key lists on one signer take
    different keys; memory-only picking; a stale lock is taken over, a held one is waited for and then refused; **two
    real processes** released together at a barrier take 50 keys each, interleaved, and get 100 distinct keys (with the
    lock stubbed out: 61 to 68 distinct, 6 of 6 runs failed); a slow holder's release does not drop the lock a waiter
    took over; a waiter that saw a stale lock someone else took over first leaves the fresh lock (fourth pass, 9.6).
  - Fourth pass (9.6): `test/integrations/reputation.test.ts` 21 (was 18: who chose the nonce; the thresholds a verifier
    without a request states; an on-chain check that could not run, on a mocked RPC) and
    `test/integrations/reputation-surfaces.test.ts` 9 (was 7: verify thresholds through the schema and `runOp`; the
    prove route's result string). Each failed before its fix (the schema test against the third pass's
    `schemas.ts` / `operations.ts`). The takeover-race test cannot run against the old lock (it has no hook), so it was
    checked by mutation instead: with the token re-check under the takeover file removed, it fails.
  - `test/integrations/core-lend.test.ts` (+2): `lendClose` on a repaid backed loan and on a repaid slashed loan closes
    with no attest attempt and logs why.

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

### 9.4 Second review (resolved on this branch)

| Finding | Resolution |
|---|---|
| `borrow` chose the loan key from the local cache only: a lost cache, a restore elsewhere, or two processes on one signer reused key 0 and linked two Slots by `agent_pk` | Before choosing, `borrow` adds every key the account's own grants already used (synced pool log, spent grants included; gap limit 20). Tested with an empty cache dir and grants under keys 0 (spent) and 3: the borrow takes key 1 and the cache learns 0, 1, 3. The case left then, two borrows at the same instant on one signer, is closed in 9.5. |
| The probing cap was per audience (presNullifier) and did nothing without a cache dir | Also at most 4 sets per `bindTo` key and 8 across all audiences per day; the log is kept in memory when there is no cache dir, and merged with the file when there is one. Tested with 5 audience names on one day. |
| Attests sent back to back on request clustered one borrower's loans on chain by timing | The relayer queues (202) and the sweep attests in loanRef order with every other repaid loan; the bank posts in random order. The operator-side link that remains is in section 3.3. |
| Every attest dropped the relayer's leaf cache, so the next `GET /v1/rep/leaves` refetched every attest transaction; GETs took no rate-limit token and concurrent misses each refetched | The leaf list is kept and topped up with `getSignaturesForAddress(tree, { until })` (only new transactions), with a full rebuild only when the rebuilt root does not match; one refresh in flight; every rep route takes a token. Tested: two attests then three GETs cost one incremental fetch of the two new transactions. |

### 9.5 Third pass (this branch; code only: no program change, no SOL, no ceremony)

| Gap | Resolution |
|---|---|
| The one-call API `proveReputation({ audience, minLoans, minVolume })` existed on the agent only; MCP, Agent Kit and the operation schema took `minVolumeUsdg` / `monthFloorUsdg`, and the local API renamed fields in between. A verifier without a request had no way to give the prover its challenge, and the result did not say which nonce the code answered | One shape on every surface (section 6), the old names kept as aliases; `nonce` in, `audience` and `nonce` out (section 5). Docs: section 0, the agent, MCP and Agent Kit READMEs. |
| Backed loans (private-backer branch) would have been read as slashed: the relayer queued them and failed every sweep, `lendClose` sent an attest that could not land, and `reputationStatus` showed slashed repaid loans as pending forever (backed loans never appear in a borrower's status: agent key 0 matches no loan key) | Section 3.4: `repBlockOf` / `isBackedSlot` / `isBackedSubrogation` (minimal read-only port), used by the relayer, the lender close and the borrower status; `never` in the status (slashed and too-small loans). Tested on the validator. |
| "Lender close attests first" and "borrower status / relayer queue" were tested on a mocked chain only | On the validator with the real bank and stream_loan's real `close_slot` (section 8). The suite now loads stream_loan built from this worktree (`node scripts/solana-rep-localnet.mjs loan-build`; `restart` builds it when missing). |
| Two borrows at the same instant on one signer could take one loan key (spec 9.4, "left") | An exclusive lock file around re-read, pick and write of the key list (section 5); tested with two real processes. |
| An on-chain check by a verifier wallet with no SOL read as a refused proof (found by the new validator test) | Reported as `onChain.ran: false` with a reason that says the simulation could not run (section 5). |
| The suite's validator used the default gossip, faucet and dynamic ports (8000, 9900, 8000-10000), which collided with another local validator running at the same time, and its health check accepted any validator on 8899 | Pinned to 8902, 8903 and 8910-8990 (rpc stays 8899); the start script only reports healthy when its own validator (by ledger path) is running. |

Not done here, and why: the site (another repository), the house fleet's close flow (kept out of git), the Vercel cron
entry (a live deploy config; the exact entry is in section 6), and everything section 13 lists.

### 9.6 Fourth pass (review of the third; code and docs only: no program change, no SOL, no ceremony)

| Finding | Resolution |
|---|---|
| In the documented one-call flow the verifier's nonce check could never fail: the prover drew the nonce and returned it, and the docs told the verifier to verify with that same nonce. The verify error and schema text spoke of "the nonce you issued", and section 0 claimed no replay "to another challenge" | The prove result says who chose the nonce (`challenge: 'request' \| 'verifier' \| 'prover-chosen'`) and, when the prover drew it, `next` says it proves no freshness. Section 0, its guarantee row, the agent, MCP and Agent Kit READMEs and the verify error and schema text now say plainly that the no-request flow gives expiry plus the verifier's own nonce record only, and point to request codes for a live answer. Tested: the label for all three, the `next` text, the verify error. |
| On the no-request path verify compared no thresholds: any claim the prover chose passed (as little as one loan, or snapped down by the ladder), and no doc told the verifier to compare `r.thresholds` | Verify takes the thresholds the verifier requires on the `{ audience, nonce }` path (`minLoans`, `minVolume`, `minLenders`, `minSpanDays`, `minMonths` with `monthFloor`; aliases folded) and refuses a code that proves less, compared as given, never rounded; next to a request they are refused (core and schema). Wired through the schema, JSON schema, `runOp`, MCP, Agent Kit, the agent method, the CLI (`rep verify ... [thresholds]`) and the local API; `openapi.json` regenerated. The docs say that without them `thresholds` must be compared by hand. Tested at bank level with real proofs (each threshold short, matching, weaker, malformed, next to a request) and through the schema and `runOp`. |
| The two-process lock test could pass without exercising the lock: tsx start-up skew often let one child finish before the other began, and a sequential pair also yields distinct keys | The children meet at a barrier file before looping, take 50 keys each with a short random pause between picks (outside the lock, so a waiter can get in), and the test asserts their keys interleave. With the lock stubbed out it failed 6 of 6 runs (61 to 68 distinct of 100); with the lock it passed every run. |
| Taking over a stale lock was racy (two waiters that saw one stale lock could both end up holding "the" lock), and release removed whatever lock file existed | Each lock holds a token unique to its holder; release removes it only while it holds that token. A stale lock is taken over only under a short-lived takeover file, inside which the waiter re-reads the lock and removes it only if it still holds the token it saw stale (section 5). Tested: a slow holder's release after a takeover leaves the new holder's lock; a waiter that saw a stale lock which another waiter took over in between (a test hook at that point) leaves the fresh lock and waits. |
| The "could not run" on-chain path fired only for a zero balance: dust below the fee, a transaction rejected before execution, or an RPC failure still read as "verify_reputation refused it", and the message said "fund it with any amount" | Classified by the simulation's error: only an `InstructionError` is the program's refusal; any other error, a throw from the RPC, or a balance below the fee the RPC quotes for the message is `onChain.ran: false`, and the message names that fee ("at least N lamports"). Tested on a mocked RPC (1 lamport; `InsufficientFundsForFee`, `AccountNotFound`, `BlockhashNotFound` with enough balance; a throwing RPC; a program error; a pass) and on the validator (no SOL, then funded). |
| Docs said the borrower's status shows backed loans under `never`, which cannot happen (agent key 0 matches no loan key); the local API's prove route result omitted `audience` and `nonce` | The MCP and Agent Kit READMEs, the `ReputationStatus` comment and the 9.5 row say only slashed and too-small loans appear there (the reason type stays shared with the relayer and the lender close, which do see `backed`). The route's result lists `audience, nonce, challenge` (tested against the route table) and `openapi.json` is regenerated. |

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
5. **Threshold probing**: the ladder plus at most 4 distinct sets per audience and per `bindTo` key per day, and 8
   across all audiences (prover side). Eight ladder steps still narrow a value down; the cap bounds the rate, not the end
   result over many days.
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
11. Whether backed loans ever count (default and today: never; section 3.4). The backer spec names what that would
    take: a proof of the borrower key at funding, no BackingClaimed, repayment before expiry, a minimum fee paid.
12. The Vercel sweep cron (section 6 has the exact entry) and the relayer env it needs.
13. Whether to keep the raw `nonce` input of `proveReputation` (section 0). It predates no framing: the verify side
    already took a raw `{ audience, nonce }`; a framed alternative exists (the `h081-rep-ask:` request code).

## 14. Cost (mainnet, estimates at 6,960 lamports per byte)

| Item | Estimate |
|---|---|
| ProgramData, 168,672 B as built | ≈ 1.17 SOL; ≈ 1.47 SOL with 25% headroom (locked; back only through program close) |
| RepTree (8,856 B) | ≈ 0.062 SOL, once per tree version |
| RepBits page (1,037 B) | ≈ 0.008 SOL per 8,192 loan refs |
| Per attested loan | one transaction fee (≈ 5,000 lamports + priority), paid by the attester; no per-loan rent |
| `verify_reputation` | 146.5k CU, base fee only (simulation is free) |
| Total one-time | ≈ 1.25-1.55 SOL |
