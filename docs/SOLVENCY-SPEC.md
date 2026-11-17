# H081 prove solvency in one line (spec)

Status: BUILT on branch `feat/prove-solvency` (off `d01d882`), not deployed, published or pushed. No new circuit, no
ceremony, no program change: everything below reuses the ceremony'd `disclose` circuit and the live
`stipend_pool.verify_disclosure`. One **config** change (not a program change) is recommended to the owner (section 2.1).
Section 9 says where each part lives and what differs from the text below.

```ts
const ask = await desk.solvencyRequest({ min: '2500', label: 'acme-desk' });       // -> "h081-solvency-ask:..."
const { code } = await agent.proveSolvency({ request: ask.code });                   // -> "h081-solvency:..."
const r = await desk.verifySolvency(code, { request: ask.code });                    // r.ok, r.statement, r.assetSound
```

Recommended default before any B2B agent deal: the party taking the risk asks (`h081-solvency-ask:`), the other
proves (`h081-solvency:`), the asker verifies, then they trade. Same request -> prove -> verify shape as reputation
(`feat/zk-reputation`, `docs/REPUTATION-SPEC.md` section 5).

## 0. What `disclose` can and cannot prove (from `circuits/main/disclose.circom`)

Public inputs, in order: `root, kind, bound, windowIdPub, agentPk, audience` (6). Over ONE allowance note
(`AllowanceCommitment`: asset, remaining, agentPk, policyHash, windowId, windowSpent, rho, pledgePaid) in the pool tree
at `root`:

| kind | statement | useful for solvency? |
|---|---|---|
| 0 `remainingAtLeast` | `bound <= remaining` | yes: the whole feature |
| 1 `spentAtMost` | `lifetimeCap - remaining <= bound` | no as a default: trivially 0 on a fresh reserve note; on an operating budget it says "this one budget has spent at most Y over its life", not anything about the account |
| 2 `windowSpentAtMost` | `windowSpent <= bound` in `windowIdPub` | no as a default: `windowLen` is private, so a verifier cannot map `windowIdPub` to a time |

Facts the circuit fixes, each a limit this spec must design around:

1. **The asset is private.** `asset` is a private input. `create_vault` is permissionless and a new vault starts with
   the config's default caps (mainnet: 10,000 / 1,000 USDG in base units, `scripts/mainnet-core-check.mts`). Anyone
   can make a worthless mint, deposit up to the default cap in raw units, grant an allowance and prove
   `remaining >= 1e10`. The proof alone does NOT say "$X". Section 2.1 closes this off chain.
2. **No key check.** There is no `sk` input (`stream.circom` has one; disclose does not). Anyone who knows the note's
   contents can prove for that `agentPk`: the granter, anyone holding the memo's viewing key, or the x402
   `prove-disclose` service once it was sent the figures. So `proveSolvency` proves locally only, on a note only this
   account knows (section 1).
3. **No nullifier: a note that ever existed proves forever.** The pool's tree is append-only (`merkle.rs` `insert`),
   so a note that was spent or reclaimed is still a leaf of every LATER root, not only of the 1024 roots in the ring.
   Anyone who knows its figures can prove over it at the current root (rootAge 0) at any time. Nothing locks the funds;
   the same note can be shown to any number of verifiers. Root recency (section 3.2) dates the PROOF; it is not a
   freshness or liveness guarantee for the note. Closing this needs a circuit that exposes (or binds) the note's
   nullifier so a verifier can check that no `["nf", nullifier]` account exists: a new circuit, ceremony and verifier
   (owner decision D6). Until then every surface says only that the note existed at some time in the pool's history.
4. **One note.** It cannot sum notes and does not see the shielded balance (transact notes). An agent with 600 + 500
   in two allowances cannot prove 1,000.
5. **Private policy.** `expiry`, `recipientRoot`, `pledgeBps`, `lender`, caps are private: a note's `remaining` may be
   expired, restricted to some recipients, or pledged to a lender. Section 1 makes the reserve note plain by
   construction; the verifier cannot check that, so the statement says "an allowance note", not "free cash".
6. **`audience` is one field, squared in.** No nonce, no expiry inside the circuit. Replay binding, expiry and
   presenter binding are folded into `audience` by hashing and checked off chain (section 2).

`stream.circom` (also ceremony'd) has a key check and a public `assetPub`, but requires a pledged note
(`bps.hasPledge === 1`, `lender == LenderKey(lenderAddr, loanRef)`) and discloses the exact `lifetimeCap`, expiry,
pledge and stream start. Using it for solvency would mean pledging the reserve to a self-made loan slot, with lender
share routing on reclaim. Not chosen; listed as owner decision D6.

### Why it has 0 users today (what the code shows, not usage numbers)

- `disclose` is not in `AGENT_CIRCUITS` / `BANK_CIRCUITS` (`integrations/core/constants.ts`) nor in `CIRCUIT_MB`
  (`integrations/agent/src/h081.ts`): no bank ever downloads its artifacts.
- No bank method, no `h081_*` operation, no MCP tool, Agent Kit action, CLI verb or local API route proves or verifies
  a disclosure. The only path is low level (`SolanaWallet.prove` + `SolanaPool.verifyDisclosure`) or the paid x402
  `prove-disclose` (0.02 USDC, the caller must assemble its own allowance figures and Merkle path, and the service is
  off until artifacts are bundled with the function; `docs/X402-SELLER.md` step 5). `docs/AGENT-ROADMAP.md` lists
  proof of funds as "only via paid x402".
- `CODE_KIND.zkproof = 3` exists in `integrations/core/codes.ts` but nothing in this repo encodes or decodes it
  (only the site does). No request/challenge format, no convention for `audience`.
- The bank's money lives in shielded notes, which disclose cannot see; nothing makes the allowance note a proof needs.
- On-chain verification needs a funded payer and 3 sent transactions (buffer open+write, verify, close), even in
  `'simulate'` mode (`SolanaPool.check`): there is no read-only path.
- Nothing tells a verifier what the proof does NOT say (asset, key, time, one note), so it could not be relied on.

## 1. The reserve (how "I hold >= X" becomes one disclose proof)

- A dedicated **reserve key**: `deriveReserveSk(keypair, derivation)` with label `h081/agent-account/v1/solvency-reserve`
  (same construction as `deriveLenderSk`; not a 0..15 sub-account index, so `freeAgentIndex`, reputation's virtual
  indices and existing sub-accounts never collide with it). Its `agentPk` is used for nothing else, so a proof reveals
  no other key of the account.
- The reserve is an allowance granted by the main account to the reserve address: `remaining = lifetimeCap = amount`,
  no expiry, no window cap, no max-per-tx, `recipientRoot 0`, no stream, no pledge. Its memo is sealed to the
  reserve's viewing key, which only this signer derives: only this account knows the note, so only it can prove
  (fact 2). `pay` never picks it (it is not in `agentAllowances` nor a sub-account); `h081_allowance_reclaim` takes it
  back like any granted allowance. `balance()` lists it as `reserve`, not under `grantedToOthers`.
- `proveSolvency` needs ONE reserve note with `remaining >= min`. If there is none:
  - without `confirm`: returns a plan `{ topUp, reclaimFirst?: reserveId, shieldedAfter, solNeeded, privacy }`, sends nothing;
  - with `confirm: true`: reclaims an existing smaller reserve (if any) into the shielded balance, then grants one new
    reserve of `amount` (default: `min` rounded UP the ladder, section 2.3; at most the shielded balance; under the
    existing `H081_MAX_GRANT` ceiling), then proves. These are the only transactions; proving and verifying send nothing.
- Grant needs the `grant` artifacts (51 MB) and SOL (`GRANT_SOL_MIN`). Proving needs only `disclose` (add it to the
  bank's lazily fetched set, NOT to `AGENT_CIRCUITS`, so a plain bank does not download it).
- `h081_bank_balance` gains `reserve: { id, remaining, remainingUsdg } | null`.

## 2. Codes, audience and binding

### 2.1 Asset soundness (off chain, closes fact 1 without a circuit)

Every outstanding note of mint M is backed by M's vault, and a vault can never take deposits above its `AssetCap.max_total`
(`ops.rs`: `require!(after <= cap.max_total)`; a cap of 0 blocks deposits). A note of remaining R was therefore
written while M's vault held at least R. Notes are never removed from the tree (fact 3), so a note written while the
vault was large keeps proving after the cap is lowered and the vault drained: TODAY's cap and balance do not bound it,
the vault's HISTORICAL peak does. So at verification:

```
peak(M)    = the most M's vault held at any point of any transaction since its creation
             (per transaction: max(before, after, before + every inflow), so a deposit withdrawn in the same
             transaction counts; read from getSignaturesForAddress + jsonParsed getTransaction, remembered per vault
             in the cache dir so later checks read only new transactions)
assetFloor = max over every AssetCap account whose mint is not USDG of max(cap.max_total, vault balance, peak(M))
assetSound = bound > assetFloor
```

The history read fails closed (`asset_floor_unavailable`): when the RPC returns no history, when the oldest
transaction is not the vault's creation (a pruned RPC), when a token instruction naming the vault cannot be read, or
when more than 10,000 new transactions would have to be read.

`verifySolvency` reads the AssetCap accounts (`getProgramAccounts` with a size filter; no instruction closes an AssetCap,
only buffers close, so a vault made for an attack stays visible) and their vaults, and returns
`assetSound`. With `assetSound: false` the result is `ok: false` (reason `asset_not_bound`) unless the verifier passes
`allowUnboundAsset: true`, and then `statement` says "at least X base units of SOME asset in the pool".

Owner action (config authority, Squads; NOT a program change, not done here): `set_default_caps(0, 0)` so a new
vault takes no deposits until the owner sets its caps, and `set_asset_caps(m, 0, 0)` for any non-USDG vault that should
not count. Until then any vault created by anyone sets the floor to 10,000 USDG-equivalent base units, and every
claim at or below it is reported `assetSound: false`. Caps of 0 stop a vault from backing NEW notes; they never
lower the floor below what the vault already held (its peak), because the notes it backed then are still provable.

### 2.2 Code kinds (v2 frame, `integrations/core/codes.ts`; letters and digits, checksum, kind, network tag)

Network tag over `(cluster, stipend_pool program id, USDG mint)` (the same context the site uses for kind 3).

| Kind | Prefix | Body |
|---|---|---|
| 10 | `h081-solvency-ask:` | ver u8 = 1, verifierKey 32 (ed25519 pub of the asker, or 32 random bytes), nonce 16 (from `solvencyRequest`: 8 random bytes then the first 8 bytes of an HMAC-SHA256, under a key only the asker's wallet derives, over the network and every other field; `askedByThisWallet` is true only when it checks, so a request that merely names a verifier's key gets a warning), expiry u64 (unix s, at most now + 1 day; the verifier refuses more too, `bad_request`), min u64 (USDG base units), maxRootAge u16 (default 32), expectWallet 32 (0 = anyone), label len u8 + UTF-8 <= 32 |
| 11 | `h081-solvency:` | ver u8 = 1, requestDigest 32, proof 256, DiscloseArgs 192, wallet 32, signature 64 |

- `proof` and `DiscloseArgs` bytes are exactly kind 3's first 448 bytes (`encodeProof` + `encodeDiscloseArgs`), so a
  kind 3 reader's verification code is reused. Kind 3 itself is not reused: its body has no request digest nor binding.
- `requestDigest = sha256(the request's framed bytes without the checksum)`; the verifier recomputes it from its own
  request, never trusts the code's.
- **Kind collision to fix (flag):** `feat/zk-reputation` uses 7/8/9 (`reputation`, `repRequest`, `repSig`) and
  `feat/private-backer` uses 8/9 (`backing`, `drawKey`). Whichever merges second must renumber; proposed registry:
  1-6 as on main, 7/8/9 reputation, 10/11 solvency, 12/13 backer. Kinds must be unique across the site too
  (`stipend-site/src/lib/live/codes.ts` holds 1/2, the site's zk codes 3/4).

### 2.3 Audience, binding, ladder

```
audience  = be(sha256("h081-solvency-audience|v1|" || requestDigest || wallet)[0..31])     // < 2^248 < field
signature = ed25519(walletKey, sha256("h081-solvency-present|v1|" || requestDigest || DiscloseArgs bytes))
```

- `wallet` is the agent's Solana signer (the key the bank already holds). The proof is therefore about the counterparty
  that controls `wallet`: deal only with `wallet` (pay outs, loan payouts, its `h081-address:` given by it). A captured
  code replayed by someone else still names `wallet` and the request's single nonce; it is useless to another verifier
  (other digest) or another wallet (other audience, signature fails). The signed message is domain separated, so it can
  never be a valid Solana transaction.
- Not provable (fact 2 + no key check): that `wallet` is the key that derived the reserve. Only a note-knower can
  forge, and for a reserve that is only this account (section 1), so the binding is as strong as "never send the
  reserve's figures anywhere".
- `min` snaps UP to the reputation ladder (1 / 2.5 / 5 x 10^k USDG) when asking, DOWN when proving directly. The
  prover refuses a 5th distinct bound per verifierKey per UTC day and a 9th across all (kept in the cache dir, in
  memory without one): a verifier cannot binary-search the reserve. (Leak is bounded anyway: the reserve's size is the
  agent's choice, not its balance.)

## 3. Verification paths

### 3.1 Local (default; free; RPC reads only)

`verifySolvency(code, { request, onChain?: 'simulate' | 'send', allowUnboundAsset? })` checks, in order, and returns
the first failure as `reason`:
frame, kind 11, network tag -> request decodes (kind 10), `requestDigest` matches, not expired (`now <= expiry`) ->
nonce not seen before by this verifier (a small seen-nonce store in the cache dir; same default/off rules as the
reputation probing log) -> `expectWallet` (if set) equals `wallet` -> args: `kind == 0`, `windowId == 0`,
`bound >= request.min`, `audience == recompute`, `agentPk != 0` -> ed25519 signature -> Groth16 against the vkey whose
sha256 is pinned in `CIRCUIT_HASHES.disclose.vkey` -> root recency (3.2) -> asset floor (2.1) -> optional on-chain.
Result: `{ ok, reason?, statement, wallet, bound, boundUsdg, root, rootAge, assetSound, assetFloor, onChain?, doesNotSay: [...] }`.

### 3.2 Root recency

`decodePool` gives `roots[1024]` and `current_root_index`. `rootAge = (current_root_index - i) mod 1024` for the slot
`i` holding `root`; refuse when absent (`unknown_root`) or `rootAge > request.maxRootAge` (`stale_root`). The prover
syncs and proves at the current root right before handing the code over. What this buys: a proof made for this
request is presented within a few operations (with the audience binding, a relayed or stockpiled presentation of an
honest reserve goes stale). What it does NOT buy (fact 3): any statement that the note is unspent, since a spent note
still proves at the current root.

### 3.3 On chain

- `'simulate'` (new, the recommended on-chain check): ONE simulated transaction `[CU limit, buffer_open(seed, 448),
  buffer_write(0, 448 B), verify_disclosure]`, `sigVerify: false`, `replaceRecentBlockhash: true`, fee payer = any
  funded account (default: the verifier's wallet; no key needed). Nothing is signed or sent. Expected to fit (448-byte
  payload under the 900-byte `WRITE_CHUNK`; verify_disclosure measured 91,957 CU in `solana/compute-units.json`), but
  that is a test to write (section 5), not a fact yet. If it does not fit: fall back to the existing 3-transaction
  path only on explicit opt-in.
- `'send'`: the existing `SolanaPool.verifyDisclosure(..., 'send')`. Opt-in only: it puts `agentPk`, `bound`, `root`
  and `audience` on chain for good and costs fees.
- The live program's `verify_disclosure` checks known root + Groth16 only; it never checks asset, recency, the request
  or the binding. On-chain verification adds nothing to 3.1 except "the deployed verifier agrees".

### 3.4 Relayer

- `proveSolvency` never uses x402 `prove-disclose` (fact 2: the service would learn the reserve and could present it
  for any wallet). The x402 service stays as is for callers that choose it.
- No free relayer verify route in v1 (as reputation). Owner decision D3.

## 4. API shape (one operation table, every surface from it)

| Operation | Effect | Sends? |
|---|---|---|
| `h081_solvency_request` `{ min, label?, expectWallet?, maxRootAge?, ttlMinutes? (<= 1440) }` | makes `h081-solvency-ask:`; verifierKey = this agent's wallet pub | no |
| `h081_prove_solvency` `{ request } \| { min, audienceCode? }`, `confirm?`, `amount?` | ensures a reserve (plan unless `confirm`), proves locally, verifies locally before returning `h081-solvency:` | only the reserve top-up, with `confirm` |
| `h081_verify_solvency` `{ code, request, onChain?: 'none' \| 'simulate' \| 'send', allowUnboundAsset? }` | section 3 | only `onChain: 'send'` |
| `h081_solvency_reserve` `{ release?: true, confirm? }` | shows the reserve; `release` reclaims it to the shielded balance | with `confirm` |

- SDK core: `src/solvency.ts` (audience, digest, signature message, ladder), `integrations/core/codes.ts` (kinds 10/11
  with `CODE_KIND`, `KIND_NAME`, `PREFIX_KIND`), `integrations/core/solvency.ts` (bank delegate, as reputation does),
  `deriveReserveSk` in `keys.ts`.
- Bank: `solvencyRequest`, `proveSolvency`, `verifySolvency`, `solvencyReserve`; `balance().reserve`.
- MCP: the four tools from the table. Agent Kit plugin: four actions. `@h081lll/agent`: the four methods,
  `checkCode` reads kinds 10/11, `CIRCUIT_MB.disclose`. CLI: `h081 solvency ask | prove | verify | reserve`. Local API:
  `POST /v1/solvency/{request,prove,verify}`, `GET /v1/solvency/reserve`, `POST /v1/solvency/reserve/release`;
  `openapi.json` regenerated.
- Every description and every verify result carries `doesNotSay` (section 6) verbatim.
- Default handshake text for agent prompts / docs: "Before a deal where you carry risk, send an `h081-solvency-ask:`
  for the amount at risk; deal only with the wallet a valid `h081-solvency:` names."
- Not in this repo: the site (code kinds in `src/lib/live/codes.ts`, a LiveBank panel, a docs page, a
  `drive-live-localnet.mjs` check per AGENTS.md).

## 5. Tests to write

Unit (`npm test`, vitest):
- codes 10/11: round trip; wrong kind, wrong network, bad checksum, cut off, pasted with wrappers/zero-width chars; a
  kind 3 / reputation / backer code pasted gets the "that is a ... code" message.
- audience and signature: fixed vectors; any changed byte of request, wallet or args breaks it.
- ladder snapping up/down; probing cap (5th bound per verifier per day, 9th overall; a repeated bound is free).
- verify refusals, one test each: expired, reused nonce, other request, other wallet, `expectWallet` mismatch,
  `kind != 0`, `bound < min`, tampered proof, tampered args, unpinned vkey, stale root, unknown root, asset floor.
- Groth16 with the real `disclose` artifacts (hash-checked against `CIRCUIT_HASHES.disclose`).

Localnet (`npm run test:solana:pool` style: `scripts/solana-localnet.mjs restart`, rpc 8899; never a public cluster):
- end to end: deposit, `proveSolvency` plan (nothing sent), confirm (one grant), code verifies locally and with
  `'simulate'`; record the simulated CU and whether the single transaction fits.
- the simulated check runs with a fee payer whose key the test does not hold.
- reserve top-up: smaller reserve reclaimed then regranted; `pay` never spends the reserve.
- reclaim after proving: the old code still verifies against its root until `maxRootAge` operations pass, then `stale_root`;
  and a FRESH proof over the released note at the current root still verifies (`ok: true, rootAge: 0`): the limit of fact 3, pinned.
- junk mint: a second mint with default caps, deposit, self-grant, prove `bound = 1e10` -> `assetSound: false`; after
  `set_asset_caps(junk, 0, 0)` with its vault drained, true; after `set_default_caps(0,0)` a new vault cannot take a deposit.
- integration tests for MCP / Agent Kit / agent CLI / local API (`npm run test:integrations`).

## 6. What a solvency proof says, and what it does NOT

Says: "Someone who knows the figures of ONE allowance note that was written into the H081 pool at some point (it may
since have been spent or reclaimed: the circuit checks no nullifier) proved that the note had at least `bound`
remaining when it was written; the proof was made against a pool root `rootAge` operations old, which dates when the
proof was made, not when the note was last unspent; the wallet `wallet` signed this presentation for this one request." With `assetSound: true`: no non-USDG vault ever held that many units (its historical peak, 2.1), so the
note is USDG.

Does NOT say (every verifier surface prints this):
1. that the funds are there now, or were there when the proof was made: the note may have been spent or reclaimed
   BEFORE the proof (append-only tree, no nullifier check: a spent note still proves against the CURRENT root; rootAge
   dates the proof, not the note) or right after (nothing is locked);
2. that they are not shown to other counterparties at the same time (no exclusivity);
3. the account's total balance (one note; shielded notes are not counted);
4. that the note is free of a pledge, an expiry or a recipient restriction (private policy; only the agent's own
   reserve construction makes it plain);
5. that `wallet` derived the note's key (not provable without a key check in the circuit);
6. anything about spending behaviour, debts or creditworthiness.

## 7. Privacy

- Revealed to the verifier: `bound` (a lower bound only), the reserve's `agentPk` (used for nothing else), the root
  (an approximate time), the agent's `wallet`. Hidden: the exact reserve, the shielded balance, every other note, the
  asset (except via the floor argument), the policy.
- Linkable: the same `agentPk` appears in every proof of the same reserve, so colluding verifiers can link them (they
  already see `wallet`). Owner decision D4 for a fresh reserve per counterparty (one grant each).
- On chain: nothing unless `onChain: 'send'`. The reserve grant itself is an ordinary grant (sender wallet visible,
  amount and recipient not).
- Local proving only; the reserve's figures never leave the process.

## 8. Owner decisions

- D1 `set_default_caps(0, 0)` and review every existing non-USDG vault's caps (config authority, Squads). Without it
  claims at or below 10,000 USDG are not asset-sound. Config only; no program upgrade. It bounds the floor from now on;
  a vault that already held X keeps the floor at X or above for good (its peak), whatever its caps become.
- D2 code kind registry: 10/11 solvency; renumber backer (8/9 -> 12/13 proposed) or reputation before either merges.
- D3 free relayer verify route (`POST /v1/solvency/verify`)? Default no (matches reputation).
- D4 one reserve per account (default) or one per counterparty (unlinkable, a grant each).
- D5 ship kinds 1/2 ("spent at most" on a named operating allowance) later? Default no (section 0 table).
- D6 if a cryptographic asset binding or key check is required: either the stream route (pledged reserve, discloses
  more, lender-share routing on reclaim) or a new circuit + ceremony + verifier program change. This spec stops there.
- D7 count other USD stablecoin vaults (e.g. a USDC vault, if one is ever opened) as sound instead of in the floor.

## 9. As built (branch `feat/prove-solvency`)

Where it lives:

| Part | File |
|---|---|
| audience, signed message, ladder, probing rule, root age, asset floor, `doesNotSay` | `src/solvency.ts` |
| the ONE simulated on-chain check | `src/solana/disclosure.ts` (`simulateDisclosureCheck`) |
| kinds 10 / 11 | `integrations/core/codes.ts` (`encodeSolvencyRequest` returns the digest; `decodeSolvencyRequest` recomputes it) |
| reserve key | `integrations/core/keys.ts` `deriveReserveSk(keypair, derivation)` |
| request / prove / verify / reserve | `integrations/core/solvency.ts`, wired in `H081Bank` (`balance().reserve`) |
| four operations | `integrations/core/{schemas,operations}.ts`; MCP, Agent Kit (`actions/solvency.ts`), `@h081lll/agent` (SDK, `h081 solvency`, `/v1/solvency/*`) |
| tests | `test/integrations/solvency.test.ts` (codes, vectors, ladder, cap, one test per refusal over a real disclose proof), `test/integrations/solvency-surfaces.test.ts`, `test/solana/solvency.test.ts` (`npm run test:solana:solvency`, private validator on rpc 28899) |

Measured on localnet (`solana/compute-units-solvency.json`): the one-transaction simulated check is **821 bytes**
(limit 1,232) and uses about **118k-121k CU** (117,731, 119,231 and 120,731 in three runs; the file keeps the latest); it ran with a fee payer whose key the test never held, and that payer's balance
was unchanged afterwards. So 3.3's "expected to fit" is now a measured fact; the 3-transaction fallback is not needed.

Localnet also showed, with real proofs: plan then confirm (nothing sent before confirm); a second verify of the same
code is `nonce_reused`; `pay` never picks the reserve; a larger request reclaims the smaller reserve and grants one;
a released reserve's proof still verified one operation later and was `stale_root` three operations later with
`maxRootAge: 2`, while a FRESH proof over the same released note at the current root verified `ok: true, rootAge 0`
(fact 3: root recency dates the proof, not the note); a junk mint at the default caps (scaled to 10 units) made a valid proof that was reported
`asset_not_bound` (and an honest USDG claim of the same size too); after `set_asset_caps(junk, 0, 0)` and the
vault drained, the ORIGINAL junk note re-proved at the current root is still `asset_not_bound` (floor = the vault's
historical peak of 10 units), a 25-unit USDG claim is sound, and after `set_default_caps(0, 0)` a new vault refused a
deposit (its empty history adds nothing to the floor).

Decisions taken while building (not owner decisions; each is easy to change):

- The seen-nonce store records a nonce only when a check PASSES, so an RPC failure or a stale root does not burn the
  asker's request; replaying a valid code is what it stops (tested both ways).
- A verify whose AssetCap read fails is `ok: false, reason: asset_floor_unavailable` (fails closed). The prover's own
  check treats that one reason as a warning (an RPC that refuses `getProgramAccounts` should not stop an honest proof);
  the asker's check still decides.
- The bound proven is the request's minimum snapped UP to the ladder (a hostile asker cannot pick a fine-grained bound),
  and a request that lives longer than a day is refused by the prover.
- Without a cache dir the probing log and the nonce store live in memory for the life of the process.
- `onChain: "send"` is refused by the local HTTP API; the SDK and CLI need `confirm: true` for it; MCP and Agent Kit take
  it as the explicit opt-in.
- `vkeyPin` on the bank host is a test-only hook for a dev-setup build tree (CI); the bank never sets it.

Not built: the direct mode `{ min, audienceCode? }` of 4 (section 3.1 verifies against a request, so there is nothing
for a verifier to check it with); the site parts (out of this repo); a relayer verify route (D3).
