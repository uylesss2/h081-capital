# H081 private reputation (ZK credit score): implementation spec

Status: DESIGN. Nothing in this document is built, deployed or published. Branch `feat/zk-reputation`.

## 0. The claim

An agent proves, to one named audience, for one challenge:

> "I repaid at least **N** loans totalling at least **X** USDG, from at least **L** different lenders, spanning
> at least **D** days. I do not reveal which loans, when, to whom, or under which keys."

One SDK call makes the proof and one call checks it:

```ts
const { code } = await agent.proveReputation({ minLoans: 3, minVolume: '500', audience: 'acme-desk' });
const r = await agent.verifyReputation(code, { audience: 'acme-desk' });   // anyone; off-chain, or on-chain
```

### Soundness goals (and what enforces each)

| Goal | Enforced by |
|---|---|
| A repayment can't be faked | Leaves enter the reputation tree ONLY through `attest`. `attest` reads the live stream_loan `Slot` account, checks the account owner and PDA, and requires `funded && repaid >= principal` and no Subrogation. |
| A loan can't be counted twice (across proofs) | A marker PDA `["rep", loan_ref]` means one leaf per loan, ever. |
| A loan can't be counted twice (within one proof) | The circuit requires the keys `(lenderF << 64) + loanRef` to be strictly increasing across the enabled slots. |
| A loan can't be borrowed from another agent | Each counted leaf's `agentPk` must equal `PublicKey(Poseidon(15, masterSk, k))` for the prover's ONE `masterSk`. Leaves from two masters can't be mixed. Handing over `masterSk` hands over every shielded dollar of that account. |
| A proof can't be replayed or resold | Public `audience`, `nonce`, `expiry` and `bindTo`. The verifier checks the audience is itself, the nonce is its own fresh challenge, the expiry hasn't passed, and (when it sets `bindTo`) that the presenter controls that key. |
| One reputation can't back many accounts at one audience | A public `presNullifier = Poseidon(14, masterSk, audience)`. It is stable per audience, so the audience sees the same reputation coming back. |
| Asset honesty | The leaf commits `fieldOf(mint)`, and the circuit makes every counted leaf use the public `asset`. |

## 1. Why a new circuit and a new program (and not disclose)

`disclose.circom` (circuit 3) can't carry this claim:

- **(i)** It has no key check. A lender holding the LenderMemo can prove facts about the agent's note.
- **(ii)** `agentPk` is public, so a proof links straight to every Slot that carries that pk.
- **(iii)** It covers one note: it can't count or sum.
- **(iv)** Pledged notes don't hold the principal, and `pledgePaid` counts in-flight shares and borrower excess. The note route can't prove that a loan was funded or repaid.
- **(v)** Its only replay binding is the audience.

The facts that matter (funded, principal, repaid, no slash) are public in the stream_loan `Slot` and nowhere else. So the design:

1. **New program `rep_registry`** (no change to the four live programs). It reads `Slot` and `Subrogation` the way safety_pool's `stream_loan_view.rs` does (owner check plus fixed offsets), appends one leaf per repaid loan to its own Poseidon Merkle tree, and verifies reputation proofs with its own verifying key.
2. **New circuit `reputation.circom`.** It reuses `PublicKey`, `MerkleCheck(enabled)`, `Leq`/`Lt` and `NonZero` from `circuits/lib/*`, plus the audience-squaring pattern from disclose and stream.
3. **New loan-key derivation** for borrowing, `loanSk_k = Poseidon(15, accountSk, k)`. Today `bank.borrow` pledges to HMAC-derived sub-accounts (`integrations/core/keys.ts` `deriveAgentSk`). A circuit can't link those keys to one identity cheaply, and spent sub-keys could be sold as "reputation". Only loans taken under Poseidon-derived loan keys (or the root account key) count.

Alternative B is the cheaper option on byte budget: put `attest` and the tree into stream_loan, and add circuit id 6 plus `verify_reputation` to stipend_pool. It is rejected as the default because both programs have zero ProgramData slack and are the money path. Both would need `solana program extend` and an upgrade. The owner's decision is listed in section 12.

## 2. Data model

### 2.1 Domain tags (`circuits/lib/hashes.circom`, `src/crypto.ts` DOM)

| Tag | Name | Use |
|---|---|---|
| 13 | `DOM_REP` | reputation leaf |
| 14 | `DOM_REPNF` | presentation nullifier |
| 15 | `DOM_LOANKEY` | loan-key derivation from the account secret |

Tags 1-12 are unchanged.

### 2.2 Loan keys

```
loanSk(k)  = Poseidon(15, accountSk, k)        k in [0, 2^32)
loanPk(k)  = Poseidon(1, loanSk(k))            (= the note's agentPk, = Slot.agent_pk)
```

- `bank.borrow` uses the next unused `k` for each loan instead of `freeAgentIndex()`. The owner grants the pledged allowance to `Account(loanSk(k)).address`, and the loan-key account makes the stream proof (unchanged circuit).
- The used `k` values are stored in the bank cache.
- Recovery: fetch every Slot (as `relayer/x402/loans.ts` already does), compute `loanPk(k)` for k = 0.. and match locally until 20 consecutive misses (gap limit). No per-agent RPC query (it would leak the pk to the RPC).
- The existing HMAC sub-accounts 0..15 are kept for allowances, and still scanned, so nothing held today moves.

### 2.3 Reputation leaf

```
R = Poseidon(13, agentPk, loanRef, principal, assetF, lenderF, fundedDay)        (7 inputs)
  agentPk   = Slot.agent_pk (32 B big-endian field)
  loanRef   = Slot.loan_ref (u64)
  principal = Slot.principal (u64, base units)
  assetF    = fieldOf(Slot.asset)  = sha256(mint)[0..20] big-endian (160 bits)
  lenderF   = fieldOf(Slot.lender) (the lender WALLET, not the slot PDA)
  fundedDay = floor(Slot.funded_at / 86400) (u32)
```

The leaf records no repaid amount, because `attest` only admits fully repaid loans. It records no attest time, because a borrower could wait before attesting and inflate it. `fundedDay` is fixed at funding, so it can't be stretched.

### 2.4 Reputation tree

The tree is an append-only Poseidon Merkle tree with depth `LEVELS = 20` (1,048,576 loans). It uses the same `hash_left_right`, the same ZEROS and the same frontier algorithm as `stipend_pool/src/merkle.rs` and `circuits/lib/merkle.circom`. The zeros are copied into `rep_registry/src/generated/zeros.rs`, and a test asserts they are byte-equal to stipend_pool's. Each `attest` inserts one leaf and commits one root.

## 3. Program `rep_registry` (new, Anchor, `solana/programs/rep_registry`)

The program id is a new keypair; the localnet id comes from `solana/scripts/keygen.sh`. The mainnet id is patched the way the stream_loan build does it, with a compile-time assert. The stream_loan id it trusts is a compile-time constant per feature (`localnet` FvM9Xcza…, `mainnet` 8JBd7epQ…). The upgrade authority stays with the deployer or Squads. **Never `--final`.**

### 3.1 Accounts

| Account | Seeds | Layout | Size (bytes) |
|---|---|---|---|
| `RepTree` (zero-copy) | `["reptree"]` | disc 8 \| next_index u32 \| current_root_index u32 \| filled_subtrees [20][32] \| roots [ROOT_HISTORY=256][32] | 8+4+4+640+8192 = **8,848** |
| `RepMarker` | `["rep", loan_ref u64 LE]` | disc 8 \| loan_ref u64 \| index u32 \| leaf [32] \| bump u8 | 8+8+4+32+1 = **53** |

- `RepTree` is under the 10,240 B CPI-create limit, so it is created in one `initialize`.
- 256 roots is plenty, because attests are rare (one per repaid loan). A proof stays valid for 255 later attests, and its own `expiry` bounds it anyway.
- `RepMarker` stores the leaf, so the full leaf list stays readable after the Slot is closed: `getProgramAccounts(rep_registry, dataSize 53)`, sorted by `index`.
- Both sizes are pinned by an `account_sizes_are_unchanged` test.

### 3.2 Instructions

**`initialize()`**
- Signer: upgrade authority only, through the ProgramData check, as in stream_loan `initialize`.
- Creates `RepTree` and calls `init_tree`.

**`attest(loan_ref: u64)`**
- Permissionless; anyone pays rent.
- Accounts: `payer` (signer, mut); `slot` (read); `subrogation` (read, may be empty); `marker` (init, PDA `["rep", loan_ref]`); `rep_tree` (mut); `system_program`.
- Checks, in order:
  1. `slot.owner == STREAM_LOAN_ID`.
  2. `slot.key == PDA(["slot", loan_ref LE], STREAM_LOAN_ID)`.
  3. `slot.data.len() == 253` and the discriminator equals `sha256("account:Slot")[0..8]`.
  4. `funded == 1`.
  5. `repaid >= principal`.
  6. `principal >= MIN_PRINCIPAL` (1 USDG = 1_000_000 base units; stops dust filling the tree).
  7. `agent_pk < r` and `agent_pk != 0`.
  8. `funded_at > 0`.
  9. `subrogation.key == PDA(["subrogation", loan_ref], STREAM_LOAN_ID)` and `subrogation.data_is_empty()`: a "clean" repayment, never slashed.
- Slot byte offsets, verified by the Rust test against `stream_loan::state::Slot` through a dev-dependency:

  | Field | Bytes |
  |---|---|
  | loan_ref | 8..16 |
  | lender | 16..48 |
  | funded | 49 |
  | asset | 51..83 |
  | principal | 115..123 |
  | repaid | 123..131 |
  | agent_pk | 173..205 |
  | funded_at | 205..213 |

- It then:
  - computes `lenderF` and `assetF` with the sha256 syscall, and `R` with the `solana_poseidon` syscall (Bn254X5, 7 inputs);
  - runs `insert`, then `commit_root`;
  - writes the marker;
  - emits `RepAttested { loan_ref, index, leaf, root }`.
- Errors: `NotStreamLoanSlot`, `NotFunded`, `NotRepaid`, `Slashed`, `TooSmall`, `TreeFull`, plus Anchor `AccountAlreadyInUse` on a second attest.
- Estimated CU: about 25k (21 Poseidon(2), 1 Poseidon(7), 2 sha256).

**`verify_reputation(proof: [u8;256], p: RepPublic)`**
- Stateless and CPI-able. Instruction data is 8 + 256 + 352 = 616 B, which fits one transaction with no buffer.
- `RepPublic` holds the 11 public inputs of section 4, each 32 B big-endian.
- Checks:
  1. Every input is `< r` (`is_field`).
  2. `repRoot` is in the RepTree ring and is not zero.
  3. `expiry >= Clock::unix_timestamp`.
  4. Groth16 with `REPUTATION_VK` (alt_bn128 syscalls; the `groth16.rs` code is copied from stipend_pool with a test that it stays identical).
- Emits `ReputationVerified { audience, nonce, pres_nullifier, min_loans, min_volume, min_lenders, min_span_days, asset }`.
- It does NOT consume the nonce. An on-chain caller (for example a future backer program) that needs one-time use creates its own `["used", audience, nonce]` PDA.
- Estimated CU: about 130k (stream with root check was measured at 137k with 13 inputs). Recorded in `solana/compute-units.json`.

There is no admin key, no pause and no fee. `MIN_PRINCIPAL` is a constant.

### 3.3 Who calls `attest` (closing the race with `close_slot`)

`close_slot` deletes the Slot, and `ClosedSlot` has no `agent_pk`. A loan closed before it is attested can never be attested. Three callers prevent that, and none of them needs a stream_loan change:

1. **Borrower:** `H081Bank` puts `sync(loan_ref)` and `attest(loan_ref)` in one transaction as soon as `repaid >= principal` (polled by `lendStatus` and `borrowStatus`). The borrower pays about 0.0009 SOL rent.
2. **Lender:** `bank.lendClose` adds the `attest` instruction ahead of `close_slot` when the marker is missing.
3. **Relayer cron** (`relayer/rep-attest.ts`, every 15 min with the seed snapshot): attest every live Slot with `funded && repaid >= principal` and no marker. It is paid from the relayer hot wallet (owner decision, section 12).

## 4. Circuit `circuits/main/reputation.circom`, `Reputation(levels = 20, N = 16)`

### Private inputs

- `masterSk`
- Per slot `j < N`:
  - `enabled[j]`, `isRoot[j]`, `keyIndex[j]`;
  - `loanRef[j]`, `principal[j]`, `lenderF[j]`, `fundedDay[j]`;
  - `pathElements[j][20]`, `pathIndices[j][20]`.
- `selLo[N]` and `selHi[N]`: one-hot selectors for the span.

### Public inputs (11, in this order)

`repRoot, asset, minLoans, minVolume, minLenders, minSpanDays, audience, nonce, expiry, bindTo, presNullifier`

### Constraints

1. `NonZero(masterSk)`.
2. For each `j`:
   - `isRoot[j]`, `enabled[j]` and the selectors are boolean.
   - `keyIndex[j] < 2^32`.
   - `sk_j = isRoot ? masterSk : Poseidon(15, masterSk, keyIndex)`.
   - `pk_j = Poseidon(1, sk_j)`.
   - `leaf_j = Poseidon(13, pk_j, loanRef, principal, asset, lenderF, fundedDay)`. The public `asset` is used, so every counted loan is in that asset.
   - `MerkleCheck(enabled[j])(leaf_j, path_j) == repRoot`.
   - Ranges: `loanRef < 2^64`, `principal < 2^64`, `lenderF < 2^160`, `fundedDay < 2^32`.
3. Enabled slots come first: `enabled[j+1] * (1 - enabled[j]) === 0`.
4. Distinctness: `key_j = lenderF_j * 2^64 + loanRef_j` (< 2^224), and `LessThan(224)(key_j, key_{j+1})` is enforced when `enabled[j+1]`. Every loan_ref has exactly one leaf (the marker), so this means no loan appears twice. Sorting by lender first lets the lender count be read off adjacent pairs.
5. `count = Σ enabled[j]`; `count >= 1`; `minLoans <= count` (8-bit compare).
6. `volume = Σ enabled[j]*principal[j]` (< 2^68); `minVolume < 2^72`; `minVolume <= volume`.
7. `lenders = enabled[0] + Σ enabled[j+1]*(1 - IsEqual(lenderF[j], lenderF[j+1]))`; `minLenders <= lenders`.
8. Span:
   - `Σ selLo = Σ selHi = 1`;
   - `Σ selLo*enabled = Σ selHi*enabled = 1`;
   - `lo = Σ selLo*fundedDay` and `hi = Σ selHi*fundedDay`;
   - `minSpanDays < 2^16`;
   - `Leq(33)(lo + minSpanDays, hi)`.
9. `presNullifier === Poseidon(14, masterSk, audience)`.
10. `nonce`, `expiry` and `bindTo` are bound by squaring them. Nothing further is needed, because Groth16 public inputs are already bound; this matches the existing pattern.

### Size

The estimate is about 6.4k constraints per slot:
- 3 Poseidon calls (derivation, pk, leaf), about 880;
- Merkle 20 x Poseidon(2), about 4.9k;
- ranges, about 350;
- LessThan(224), about 225.

That gives about 104k in total, under pot17's 131,072. **Measure with `build-circuits.mjs`.** If it comes out over:
- fall back to N = 12, or
- move to pot18 (an owner decision, because the ceremony used pot17).

More than 16 loans: the prover picks 16. A claim is bounded by `minLoans <= 16` and by the sum of its 16 largest loans.

Proving time is roughly 6-12 s in Node and 15-30 s in a browser. The zkey is roughly 50-60 MB (to be measured). There is **no remote proving**: the witness contains `masterSk`. Unlike `prove-disclose`, no x402 service may prove reputation.

## 5. SDK

### 5.1 Core (`src/`)

- `src/crypto.ts`:
  - `DOM.REP = 13n`, `DOM.REPNF = 14n`, `DOM.LOANKEY = 15n`;
  - `loanSk(accountSk, k)`;
  - `repLeaf({agentPk, loanRef, principal, assetF, lenderF, fundedDay})`;
  - `presNullifier(masterSk, audience)`.
- `src/reputation.ts`:
  - `type RepLoan = { loanRef; principal; assetF; lenderF; fundedDay; key: { root: true } | { k: number }; index: number }`;
  - `selectLoans(loans, req)`: greedy by principal, then repairs for `minLenders` and span; throws `ReputationUnreachable` with what is short;
  - `reputationInput({ masterSk, loans, tree, req })` returns `{ input, publicSignals }`;
  - `REPUTATION_PUBLIC`.
- `src/prover.ts`: add `'reputation'` to `CircuitName`.
- `src/solana/reputation.ts`:
  - `REP_PROGRAM_ID`, `MAINNET_REP_PROGRAM_ID`;
  - PDAs `repTreePda()` and `repMarkerPda(ref)`;
  - `attestIx(ref, payer)` and `verifyReputationIx(proof, pub)`;
  - `decodeRepTree` and `decodeRepMarker`;
  - `fetchRepLeaves(conn)` (getProgramAccounts dataSize 53, sorted by index, root rebuilt and checked against the ring);
  - `isKnownRepRoot(conn, root)`;
  - `RepTreeMirror` (a `MerkleTree(20)` fed from markers).
- `audienceOf(x: string | PublicKey): bigint`:
  - a PublicKey gives `fieldOf(pk)`;
  - a string gives `sha256("h081-rep-audience|" + x)[0..20]`.

### 5.2 Bank (`integrations/core/bank.ts`)

```ts
proveReputation(req: {
  minLoans: number; minVolume: string | bigint; minLenders?: number; minSpanDays?: number;
  audience?: string; request?: string /* h081-rep-ask: code */; bindTo?: string /* base58 pubkey */;
  expiresInSec?: number /* default 600 */;
}): Promise<{ code: string; presNullifier: string; expiresAt: number; counted: { loans: number } }>;

verifyReputation(code: string, opts: { audience?: string; request?: string; nonce?: string; now?: number;
  onChain?: boolean /* simulate verify_reputation */ }): Promise<{
  ok: boolean; reason?: string; minLoans: number; minVolume: string; minLenders: number; minSpanDays: number;
  asset: string; presNullifier: string; audience: string; expiresAt: number; bindTo?: string }>;

reputationRequest(req: { audience: string; minLoans: number; minVolume: string; minLenders?: number;
  minSpanDays?: number; ttlSec?: number; bindTo?: string }): { code: string; nonce: string; expiresAt: number };

reputationAttest(opts?: { confirm?: boolean }): Promise<Plan | { attested: number[]; signatures: string[] }>;
reputationStatus(): Promise<{ attested: { count: number; volume: string; lenders: number; spanDays: number };
  pending: number /* repaid, not yet attested */; legacy: number /* repaid under HMAC sub-accounts: not countable */ }>;
```

- `verifyReputation` checks, in order:
  1. frame and checksum;
  2. kind 7 and network tag;
  3. that the code matches the request (audience, nonce, thresholds ≥ the asked ones, bindTo);
  4. `now <= expiry`;
  5. that `repRoot` is known (one RPC read of RepTree);
  6. Groth16 with the bundled `reputation.vkey.json`, whose hash is pinned in `scripts/circuit-hashes.json`.
- Without a request code, the verifier must remember the nonces it has seen until their expiry.
- `reputationStatus` is local and private. It reads markers and Slots, and matches against the cached loan keys.
- The SDK snaps thresholds to a public ladder before proving (section 9, threshold probing):
  - loans: 1, 2, 3, 5, 8, 12, 16;
  - volume: 1-2.5-5 x 10^k USDG;
  - span: 7, 30, 90, 180, 365 days.

  A request for an off-ladder value is rounded down, and the code states the snapped value.

### 5.3 `@h081lll/agent` (`integrations/agent/src/h081.ts`)

- `agent.proveReputation({ minLoans, minVolume, audience, ... })` and `agent.verifyReputation(code, { audience | request })`.
- `agent.reputationRequest(...)`, `agent.reputation()` (status), and `agent.reputationAttest({ confirm })`. Like other writes, attest returns a plan unless it is confirmed.
- Add `reputation` (and `disclose`, which is missing today) to `CIRCUIT_MB`.

## 6. Integrations

| Surface | Additions |
|---|---|
| `integrations/core/schemas.ts` | OPS, DESCRIPTIONS, ZOD, JSON_SCHEMA and EXAMPLE_INPUTS for `h081_prove_reputation`, `h081_verify_reputation`, `h081_reputation_request`, `h081_reputation_attest` (write: plan/confirm) and `h081_reputation_status` |
| `operations.ts` | OPERATIONS entries calling the bank methods |
| MCP (`integrations/mcp`) | tools come from OPS automatically: `h081_prove_reputation`, `h081_verify_reputation`, … |
| agent-kit plugin | `actions/proveReputation.ts`, `verifyReputation.ts`, `reputationRequest.ts`, `reputationAttest.ts`, `reputationStatus.ts`; register in `index.ts` |
| CLI `h081` | `rep ask --audience A --min-loans 3 --min-volume 500 [--min-lenders 2] [--span 30] [--bind <pubkey>]`; `rep prove <ask-code> \| --min-loans … --audience A`; `rep verify <code> [--ask <ask-code>] [--on-chain]`; `rep attest [--yes]`; `rep status` |
| local API (`server.ts`) | `POST /v1/reputation/request`, `POST /v1/reputation/prove`, `POST /v1/reputation/verify`, `POST /v1/reputation/attest`, `GET /v1/reputation`; regenerate `openapi.json` |
| relayer | `GET /v1/rep/leaves?from=<index>` (public marker cache) and `GET /v1/rep/roots`; cron attest sweep (section 3.3); **no proving endpoint**; optional free `POST /v1/rep/verify` (off-chain verify for clients without snarkjs) |
| site (`stipend-site`) | mirror kinds 7/8 in `src/lib/live/codes.ts` with Copy buttons and a live check under the paste box; a "Reputation" panel in LiveBank (status, Prove for a request code, Verify a code); a /docs page; a `drive-live-localnet.mjs` check (AGENTS.md rule) |
| backer (later feature) | can gate a backed line on `verify_reputation` by CPI, plus its own nonce PDA |

## 7. Code framing (v2 frame, `integrations/core/codes.ts`, mirrored on the site)

Both codes use the v2 frame `version 2 | kind | 4-byte tag | body | 4-byte checksum`, in base58 (letters and digits only). The network tag is `sha256("h081-handover|<cluster>|<rep_registry id>|<USDG mint>")[0..4]`. A code for another cluster, program or asset is refused with its own message.

| Kind | Name | Prefix | Body |
|---|---|---|---|
| 7 | reputation proof code | `h081-rep:` | ver u8=1 \| proof 256 \| repRoot 32 \| presNullifier 32 \| audience 32 \| nonce 32 \| expiry u64 \| bindTo 32 \| minLoans u8 \| minVolume u64 \| minLenders u8 \| minSpanDays u16 = 486 B (about 670 chars) |
| 8 | reputation request code | `h081-rep-ask:` | ver u8=1 \| audience 32 \| nonce 32 \| expiry u64 \| bindTo 32 (0 = unbound) \| minLoans u8 \| minVolume u64 \| minLenders u8 \| minSpanDays u16 \| label len u8 + UTF-8 ≤ 32 |

- `asset` is not in the body. It is the context tag's mint, and the verifier rebuilds it as `fieldOf(USDG)`.
- Add to `CODE_KIND` `{ reputation: 7, repRequest: 8 }`, to `KIND_NAME`, and to `PREFIX_KIND`. A pasted code of the wrong kind gets the existing "this is a … code" message.

## 8. Test plan

### Unit (no validator)

- **`test/circuits/reputation.test.ts`** (witness only, `Prover.witness`, `fresh()`/`pledged()`-style helpers).
  - Must accept: 1, 3 and 16 loans; a root-key leaf; mixed k values; thresholds exactly at the bound.
  - Must reject:
    - the same leaf twice;
    - an unsorted pair;
    - a leaf from another master;
    - a leaf not in the tree, or a wrong path;
    - an asset mismatch;
    - count, volume, lender or span below the bound;
    - a selector on a disabled slot;
    - an enabled gap (1, 0, 1);
    - a wrong presNullifier;
    - principal ≥ 2^64, keyIndex ≥ 2^32, lenderF ≥ 2^160;
    - zero enabled slots;
    - `masterSk = 0`.
- **`test/reputation.test.ts`**:
  - TS `repLeaf` and `loanSk` equal the circuit outputs (fixture);
  - `selectLoans` edge cases;
  - ladder snapping;
  - kind 7/8 round trip, a flipped checksum character, the wrong network tag, a wrong-kind message;
  - verifier rejects: expired, wrong audience, wrong nonce, bindTo mismatch, unknown root, tampered public input, tampered proof, thresholds below the request.
- **Integrations:** schemas, EXAMPLE_INPUTS validate, MCP tool list, agent-kit action registry, server routes, CLI parsing, openapi snapshot.
- **Rust (WSL, `cargo test`):**
  - Slot offsets equal `stream_loan::state::Slot` (dev-dependency);
  - Rust leaf hash equals the TS fixture;
  - zeros equal stipend_pool's;
  - account sizes are 8,848 and 53;
  - `groth16.rs` is identical to stipend_pool's.

### Localnet (new suite `rep`, private validator on rpc 9299; never 8899/8900)

The suite deploys localnet stipend_pool, stream_loan, the `fast` safety_pool and rep_registry, then:

1. Lends three loans with two lenders under loan keys k = 0, 1, 2. Each is funded, repaid through pledged spends, then sync, then attest. Check the marker, the leaf and that the root is in the ring.
2. Second attest of the same loan fails. Attest of an unfunded slot, a partly repaid slot, or a fake account owned by another program fails. After a fast-pool slash (Subrogation exists), attest fails. After `close_slot`, attest fails.
3. Prove `minLoans 3, minVolume = sum, minLenders 2, span 0`. Verify off-chain and on-chain (`verify_reputation`, CU recorded). Expired, unknown root and tampered inputs fail.
4. Attack: master B tries to include master A's leaf. The witness fails.
5. `bank.lendClose` on a repaid, unattested loan attests first. The bank borrower auto-attests on repayment.

### Site

- `npm run test:full`.
- New checks in `scripts/qa/drive-live-localnet.mjs`: a kind 7/8 paste check, and a reputation panel flow on the private validator.

## 9. Privacy analysis (honest)

### Hidden from the verifier

- which loans;
- the loan count and volume beyond the stated thresholds;
- the lenders' identities;
- the dates (beyond the stated span);
- the agent's keys (`agentPk` is private);
- the shielded account.

The anonymity set is every attested loan in the asset.

### What leaks, and the mitigations

1. **Public loan data.** Every Slot is public: lender, principal, `payout_to`, `agent_pk`, `funded_at`. The RepMarker publishes `loan_ref` and its leaf. The proof hides which leaves are used, but the set of repaid loans is public, as it is today.
2. **`payout_to` links loans.** `bank.borrow` pays the principal to the agent wallet's public ATA, so all of an agent's loans are linked through `payout_to` whatever the agent keys are.
   - If the presenter's wallet (or `bindTo`) is that wallet, a verifier can list its Slots and estimate the score without the proof.
   - **Mitigations:**
     - `bindTo` should be a fresh session key;
     - the owner decides on per-loan payout addresses (section 12);
     - per-loan loan keys already stop `agent_pk` linking.
3. **Per-audience linkability.** `presNullifier` is stable per audience, so the same audience recognises the same reputation each time; this is intended. Different audiences can't link two presentations through it. Audiences that collude can still link presentations by timing or by the thresholds asked.
4. **Threshold probing.** One audience asking for many thresholds can binary-search the volume. The SDK ladder (section 5.2) caps this at a handful of buckets. The SDK can also refuse more than M proofs per audience per day (owner decision).
5. **Root timing.** `repRoot` dates the proof to after a given attest. It is minor.
6. **Lender view.** A lender knows the `agent_pk` of its own loan, but the proof never shows `agentPk`, so the lender can't tell its loan was counted.
7. **Wash lending.** The proof is sound about funded and repaid loans, but it can't tell an independent lender from a second wallet of the agent.
   - The cost of faking volume X is the 0.25% origination fee (0.0025·X to the treasury), plus the capital tied up, plus about 0.0009 SOL rent per loan.
   - `minLenders` raises the cost only slightly, because wallets are free.
   - **`minSpanDays` is the strong signal**: real calendar time can't be bought. Verifiers should ask for span plus volume, not count alone. Docs must say this plainly.
8. **Direct-transfer repayment.** Anyone can send USDG to the slot inbox and `sync` will credit it. That is still real money repaid, so it counts.
9. **Proof rental.** An agent can prove on behalf of a buyer (with the buyer's `bindTo`) without giving up `masterSk`. Cryptography can't stop this. The nullifier lets each audience enforce "one reputation, one account".
10. **Legacy loans don't count.** Loans under the HMAC sub-accounts, or closed before `rep_registry` exists, have no attestable leaf. `reputationStatus.legacy` reports them, and reputation starts at launch.

## 10. Trusted setup

- **Dev and test:**
  - `node scripts/build-circuits.mjs reputation`;
  - `node scripts/setup-circuits.mjs reputation` (one throwaway contribution on a dev pot17, as CI does);
  - add `reputation` to the CI build and setup steps.
- **VK for the program:** a NEW `scripts/gen-rep-vk.mjs` writes `solana/programs/rep_registry/src/generated/vk.rs` only, with `--check` as a deploy pre-flight. `scripts/gen-solana-vk.mjs` and `stipend_pool/src/generated/vk.rs` are untouched. Never run `npm run solana:vk` after a dev setup.
- **Production (owner):**
  - `scripts/ceremony.mjs init/contribute/beacon/verify/export reputation`, per docs/CEREMONY.md: 3 team contributions plus a Solana-blockhash beacon on the Hermez pot17 (or pot18, if N needs it);
  - add `reputation` to the ceremony's PRODUCTION list;
  - publish `docs/ceremony/reputation/{ceremony.json, attestation.json, reputation.vkey.json}`.

## 11. Rollout and upgrade notes

1. The four live programs are not changed: stipend_pool, stream_loan, safety_pool and capacity_stake keep every layout and instruction.
2. **New program deploy** (owner):
   - keypair;
   - build with `--features mainnet`;
   - `solana program deploy` with about 25% max-len headroom;
   - upgrade authority = deployer/Squads;
   - never `--final`;
   - `initialize` creates RepTree.
3. **SDK:** core, agent 0.3.0, mcp/plugin 0.4.0.
   - Borrowing switches to Poseidon loan keys (minor bump).
   - HMAC sub-accounts are still scanned.
   - Bank cache gains `loanKeys: number[]`.
   - Recovery uses the gap-limit scan.
4. Relayer gets the attest cron and the leaves/roots endpoints. Stage first with `--skip-domain`, probe, then promote (see the relayer deploy notes).
5. The site mirrors codes 7/8 and the panel. The circuit hashes are pinned.
6. Order:
   1. ceremony;
   2. program deploy and initialize;
   3. relayer cron;
   4. npm packages;
   5. site.

   Loans repaid between steps 3 and 4 get attested by the cron. Loans taken before step 4 under HMAC keys never count.

## 12. Owner decisions

1. Architecture: a new `rep_registry` program (recommended; about 1 SOL locked) or Alternative B (stream_loan plus stipend_pool upgrades; about 0.2 SOL extend, but it touches two zero-slack money programs).
2. Whether loans that were slashed and later fully recovered count. The default is no: attest requires that no Subrogation exists.
3. Who pays attest rent for the cron sweep: the relayer hot wallet (platform fees only; creator fees never touched) or the borrower only.
4. N = 16 on pot17 (if the measurement fits) or a larger N on pot18.
5. `MIN_PRINCIPAL` (proposed 1 USDG).
6. Threshold ladder values and a per-audience daily proof cap.
7. Per-loan payout addresses in `bank.borrow` for privacy. Today the principal lands in the agent wallet's public ATA and links all its loans.
8. The production ceremony round for `reputation`, and its contributors.
9. Whether to run a free relayer `POST /v1/rep/verify`. Remote proving is never offered.

## 13. Cost (mainnet, estimates)

| Item | Estimate |
|---|---|
| `rep_registry` ProgramData | about 140 KB code + 25% headroom ≈ 175 KB × ~5,080 lamports/B ≈ **0.9 SOL** (locked; back only through `solana program close`) |
| RepTree | 8,848 B → **≈ 0.045 SOL** |
| Per attested loan | marker 53 B → about 0.0009 SOL rent + ~5,000 lamports fee (payer: attester) |
| `verify_reputation` | ~130k CU, the base fee only; it creates no account |
| Total one-time | **≈ 1.0 SOL** (+ ≈ 0.001 SOL per attested loan) |
