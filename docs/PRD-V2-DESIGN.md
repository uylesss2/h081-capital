# PRD v2 design: stream-backed lending, capacity token, bearer notes

Binding design for implementing `C:\Users\Joseph\Desktop\stipend-prd-v2.md` on this repo. Where the PRD
and this document differ, this document wins, because it is fitted to the code that exists. Written
2026-10-26 after answering PRD section 10 from the code.

## 0. Answers to PRD section 10

1. `streamRate` is vesting style: the agent may spend no faster than `streamRate * (now - streamStart)`
   cumulative (spend.circom "streaming release"). Unit: asset base units per second. So a pledged
   stream has a defined future cashflow: by time `t` at most `min(lifetimeCap, streamRate * (t - streamStart))`
   has vested.
2. There are no drips. Value leaves an allowance only when someone spends it. Therefore repayment cannot
   be "automatic on each drip"; it must be (a) routed on every spend and (b) pullable by the lender from
   the vested part. Both are designed below. This is what makes the loan self-repaying.
3. The disclose circuit has six fixed public inputs and an immutable verifier. `proveStream` is a new
   circuit (`stream.circom`) with its own verifier; `disclose` is unchanged for existing callers.
4. SDK naming follows `Wallet` methods: `pledge`, `proveStream`, `verifyStream`, and a `LenderWallet` with
   `claim`. "settle" is a StreamLoan registry action by the lender.
5. Owner reclaim currently bypasses every rule. With a pledge it must still route the lender's share
   (section 2.3), otherwise a lender could be drained. This is the one place the owner's "no rules" changes.

## 1. Data model changes (all circuits, SDK, site port)

Domain tags: add `DOM.LENDER = 12`.

Policy gains two fields, appended, in this order:

```
Policy = { lifetimeCap, windowCap, windowLen, maxPerTx, expiry, recipientRoot, ownerPk, streamRate, streamStart, lender, pledgeBps }
PolicyHash = Poseidon(DOM_POLICY, ...11 fields)   // Poseidon(12)
lender     = pledgeBps == 0 ? 0 : Poseidon(DOM_LENDER, lenderAddr, loanRef)
pledgeBps  = 0..10000 (uint16 semantics; range-checked and <= 10000 in every circuit that reads it)
```

`lenderAddr` is an EVM address as a field element; `loanRef` is a uint64 chosen by the lender (a slot id in
the StreamLoan registry). Hashing them keeps the policy at two new fields and lets the spend circuit expose
both as public inputs when a share is paid. Every circuit that opens the hash (`LenderBinding`) range-checks
`lenderAddr` to 160 bits and `loanRef` to 64 bits and requires `lenderAddr != 0` when pledged, so the preimage
always fits `SpendArgs` and a pledged note can always be spent.

Allowance note gains one field, appended:

```
Allowance = { asset, remaining, agentPk, policy, windowId, windowSpent, rho, pledgePaid }
AllowanceCommitment = Poseidon(DOM_ALLOW, asset, remaining, agentPk, policyHash, windowId, windowSpent, rho, pledgePaid)  // Poseidon(9)
```

`pledgePaid` is the cumulative value this allowance line has routed to its lender (shares on spends plus
lender claims). New allowances start at 0. The successor note after a spend carries the updated value.
Sub-allowances from `delegate` start at 0; the residual keeps the parent's value.

Every circuit that rebuilds an allowance commitment (grant, spend, disclose, delegate, stream) takes the
new fields as private inputs. `transact` is untouched. The empty leaf, note commitments, nullifiers and
`nextRho` are unchanged.

## 2. Spend circuit (`circuits/main/spend.circom`)

### 2.1 Signals

Public, in this order (the contract and `inputs.ts` must match exactly):

```
root, nullifier, newAllowanceCommitment, payCommitment, publicAmount, publicRecipient, publicAsset, fee, now, receipt,
lenderAmount, lenderAddr, loanRef, isLenderClaim, extDataHash          // 15 public inputs
```

New private inputs: `lender`, `pledgeBps`, `pledgePaid` (note fields), `share`, `shareRem` (division
witnesses), `vested`, `owedQ`, `owedRem` (claim witnesses).

### 2.2 Who is spending

Three roles, exactly one:

- agent: `pk(sk) == agentPk`; every rule enforced (`enforce = isAgent`).
- owner: `pk(sk) == ownerPk`; no rules, but the pledge share is still routed (2.3).
- lender claim: `isLenderClaim == 1`; no `sk` check in the circuit (set `sk = 0`); the contract requires
  `msg.sender == lenderAddr`. Only valid when `pledgeBps != 0`.

```
isLenderClaim * (1 - isLenderClaim) === 0
(1 - isOwner) * (1 - isAgent) * (1 - isLenderClaim) === 0     // as two quadratic steps
isLenderClaim * (1 - hasPledge) === 0
enforce <== isAgent * (1 - isLenderClaim)
```

### 2.3 Pledge routing on every non-claim spend

`hasPledge = NonZero(pledgeBps)`. Constrain `pledgeBps <= 10000`, and the lender hash:

```
lenderHash = Poseidon(DOM_LENDER, lenderAddr, loanRef)
hasPledge * (lender - lenderHash) === 0
(1 - hasPledge) * lender === 0
(1 - hasPledge) * lenderAddr === 0
(1 - hasPledge) * loanRef === 0
```

For an agent or owner spend of gross `amount` (deducted from `remaining`):

```
amount * pledgeBps === share * 10000 + shareRem      // shareRem in [0, 10000), share range-checked
net      = amount - share                             // what the recipient gets
toLender = share
```

The payout note, public leg, fee bound and receipt all use `net` instead of `amount`:
`publicAmount === net * isPublic`, `fee <= net`, `pay.amount <== net`, `rcpt.amount <== net`.
`lenderAmount === toLender * (1 - isLenderClaim) + amount * isLenderClaim`.

### 2.4 Lender claim

When `isLenderClaim == 1` the lender pulls from the vested part of the stream:

```
allotted = streamRate * (now - streamStart)           // only meaningful when hasStream
vested  <= lifetimeCap                                 // always
vested  <= allotted                                    // when hasStream (LeqWhen); the lender may choose a smaller vested
vested * pledgeBps === owedQ * 10000 + owedRem         // owedRem in [0, 10000)
amount + pledgePaid <= owedQ                           // claim bounded by vested share minus what was already routed
amount <= remaining                                    // always, same as every spend
isPublic === 0, payCommitment === 0, publicAmount === 0, fee === 0
```

A claim pays `lenderAmount = amount` to the lender, nothing to anyone else. No window, per-tx, expiry or
allow-list check applies to a claim (expiry binds the agent, not the lender). This is acceptable only because
the owner consents to every pledge (section 3). `streamStart` in the future
makes `allotted` unprovable only when hasStream and the claim path must reuse the existing `startOk` gate
with `when = hasStream * isLenderClaim + streamEnforced` (keep it a single bit).

A claim leaves the agent's window state untouched: `next.windowId` and `next.windowSpent` are the note's own
values when `isLenderClaim == 1`, so a lender's `now` (up to 15 minutes behind block time) cannot roll the
window back and hand the agent a fresh cap. The receipt uses the same selected window id.

### 2.5 Successor note and public asset

```
next.remaining  <== remaining - amount
next.pledgePaid <== pledgePaid + lenderAmount
next.windowId    <== isLenderClaim ? windowId : newWindowId
next.windowSpent <== isLenderClaim ? windowSpent : carried + amount * enforce
publicAsset === asset * (isPublic + hasPledge - isPublic * hasPledge)   // the asset is public whenever a share may be paid
```

`enforce = isAgent * (1 - isLenderClaim)` where `isAgent` is `pk(sk) == agentPk`: the rules bind the agent
key even when the owner granted to itself, and the SDK's `spendInput` computes the successor the same way.

Privacy consequence, to document: a pledged allowance reveals, per spend, the asset, the lender address,
the loan ref and the share amount (hence the gross spend amount) to the chain. Recipients and balances stay
hidden. This is the price of on-chain-verifiable repayment and it is what makes Phase 2 slashing objective.

### 2.6 Invariants to test (negative tests are mandatory)

- No proof for a pledged spend with `lenderAmount != floor(amount * pledgeBps / 10000)` (short, zero or over).
- No proof with a different `lenderAddr` or `loanRef` than the policy's hash (re-point).
- No proof for a claim when `pledgeBps == 0`, when `amount + pledgePaid > floor(vested * bps / 10000)`,
  when `vested > allotted`, when `vested > lifetimeCap`, or when `amount > remaining`.
- No proof for a claim that also pays a recipient (payCommitment or publicAmount non-zero).
- Owner reclaim of a pledged allowance routes the share.
- Total routed to a lender over any sequence of spends and claims never exceeds `floor(lifetimeCap * bps / 10000)`
  (a property test over random sequences in the SDK, using the pure model, plus one circuit test).

## 3. Delegate circuit (`delegate.circom`)

New private inputs: `lender`, `pledgeBps`, `pledgePaid` (parent), `lenderAddr`, `loanRef` (the preimage of
the parent's `lender`, both 0 when unpledged, checked with `LenderBinding`).

- Only the owner creates a pledge, at grant (section 4). Every sub and the residual rebuild their policy from
  the parent's `lender` and `pledgeBps` directly, so an agent can neither re-point a lender nor pledge an
  allowance to itself: an agent-made pledge with `pledgeBps = 10000` to its own address would route every
  spend past the allow-list and let a "claim" ignore the window, per-tx cap and expiry.
- `pledge()` in the SDK is therefore an owner-side operation: the owner reclaims what is left and grants it
  again to the same agent under the same rules plus the pledge (two transactions).
- Sub notes have `pledgePaid = 0`; the residual keeps the parent's `pledgePaid`.
- A streamed sub starts at `now` unless told otherwise, so a self-delegation restarts the stream. A lender
  that reads a successor memo with a later `streamStart` should treat it as a change of terms.
- Relax the residual rules so a zero residual is legal: the "residual windowCap must be non-zero when the parent
  has a cap" and the same for streamRate apply only when `residualRemaining != 0`
  (`(1 - resCapNZ) * hasCap * resNZ === 0`, same for rate). The sums `resWindowCap + sumCap <= windowCap` and
  `resStreamRate + sumRate <= streamRate` stay.
- `subAgentPk` may equal `agentPk` (self-delegation); this is already allowed, add a test.

## 4. Grant and disclose circuits

- `grant.circom`: each output allowance gets `lender[i]` and `pledgeBps[i]` policy inputs with the 2.3
  consistency rules, and `pledgePaid = 0`. Owners may grant pre-pledged allowances.
- `disclose.circom`: add `lender`, `pledgeBps`, `pledgePaid` as private inputs so the commitment rebuilds.
  Public inputs unchanged (six). Existing `prove` callers keep working.

## 5. Stream circuit (`circuits/main/stream.circom`, the `proveStream` proof)

Private: the full allowance note, policy, Merkle path. Public, in this order:

```
root, minRemaining, minRate, lenderAddr, loanRef, pledgeBpsPub, expiryPub, lifetimeCapPub, pledgePaidPub, agentPk, audience,
streamStartPub, assetPub   // 13
```

Constraints: note in tree at `root`; `remaining >= minRemaining`; `streamRate >= minRate`;
`lender == Poseidon(DOM_LENDER, lenderAddr, loanRef)` and `pledgeBps != 0`; `pledgeBpsPub == pledgeBps`;
`expiryPub == expiry`; `lifetimeCapPub == lifetimeCap`; `pledgePaidPub == pledgePaid`; `agentPk` is the note's;
`streamStartPub == streamStart`; `assetPub == asset`; `audience` is squared in (replay binding, as in disclose).
Reveals the PRD's fields plus the cap, what has already been routed, when the stream starts (without it
`minRate` says nothing about cashflow: a start years away is unclaimable and never reports a shortfall) and
the asset (so the registry's `Loan.asset` is proof-backed, which Phase 2 slashing needs).
Hides the balance, counterparties, window state, strategy.

Verifier: `contracts/verifiers/StreamVerifier.sol` (generated), immutable in the pool, `verifyStream(proof, args)`
view on `StipendPool` next to `verifyDisclosure`.

## 6. Contracts

### 6.1 StipendPool changes

- `SpendArgs` gains `lenderAmount (uint256)`, `lenderAddr (address)`, `loanRef (uint64)`, `isLenderClaim (bool)`;
  the public-input array becomes the 15 of section 2.1 in that order (`isLenderClaim` as 0/1).
- `SpendExtData` gains `bytes encryptedLender` (a copy of the successor allowance encrypted to the lender's
  viewing key; empty when unpledged).
- After the proof: `if (args.isLenderClaim) require(msg.sender == args.lenderAddr, "lender")`.
  Public payout uses `publicAmount` as today (it is already net); the shielded payout note is inserted only
  when `payCommitment != 0` (a public spend with `pledgeBps = 10000` has net 0 and no payout note). Then the
  lender leg, which never blocks a spend so the owner can always reclaim: `if (args.lenderAmount > 0)`, try a
  plain `transfer` to `lenderAddr` (`TryERC20`, failure reported, not reverted); on success tell a contract
  lender with `onPledge{gas: SINK_GAS}` (300,000, `try/catch`); on failure hold the share in
  `owed[asset][lenderAddr][loanRef]` and emit `PledgeEscrowed`. `PledgeRouted` is emitted either way.
  `pullLenderShare(asset, lenderAddr, loanRef)` is permissionless and delivers escrowed shares later.
- `if (ext.encryptedLender.length > 0) emit LenderMemo(args.loanRef, ext.encryptedLender);`
- `verifyStream(Proof, StreamArgs) view returns (bool)` with the 13 inputs of section 5 and `isKnownRoot`.
- Constructor takes the sixth verifier. `deployPool` in the SDK and `scripts/deploy.mjs` deploy it.
- Constants, events, no admin: unchanged. No pause, no owner, no upgrade.

### 6.2 `contracts/lending/IPledgeSink.sol` and `StreamLoan.sol`

```
interface IPledgeSink { function onPledge(address asset, uint256 amount, uint64 loanRef) external; }

contract StreamLoan is IPledgeSink, ReentrancyGuard {
  StipendPool immutable pool;
  struct Slot { address lender; }                        // loanRef => who receives
  struct Loan { address asset; uint256 principal; uint256 repaid; uint256 minRemaining; uint256 minRate; uint16 pledgeBps;
                uint64 expiry; uint256 agentPk; uint64 fundedAt; bool settled; address payoutTo; uint64 streamStart; }
  mapping(uint64 => mapping(address => uint256)) owed;   // shares held for a slot: no lender yet, or the token refused the forward
  function openSlot() external returns (uint64 loanRef);              // sequential ids from 1; slot.lender = msg.sender
  function fund(uint64 loanRef, Proof p, StreamArgs a, address asset, uint256 principal, address payoutTo) external nonReentrant;
     // slot.lender == msg.sender; no loan yet; a.lenderAddr == address(this) && a.loanRef == loanRef; a.asset == asset;
     // a.streamStart <= block.timestamp; pool.verifyStream(p, a);
     // records Loan; IERC20(asset).safeTransferFrom(msg.sender, payoutTo, principal); emit LoanFunded
  function onPledge(address asset, uint256 amount, uint64 loanRef) external;   // msg.sender == pool; repaid += amount if a loan exists
     // and asset matches; then try to forward to slot.lender (emit DripRouted) or keep it in owed (emit DripEscrowed); never reverts
  function collect(uint64 loanRef, address asset) external nonReentrant;   // slot.lender == msg.sender; pays out owed[loanRef][asset]
  function claim(uint64 loanRef, Proof p, SpendArgs a, SpendExtData e) external nonReentrant;   // slot.lender == msg.sender; a.isLenderClaim && a.lenderAddr == address(this) && a.loanRef == loanRef; pool.spend(p, a, e)
  function settle(uint64 loanRef) external;                            // slot.lender == msg.sender; loan.settled = true; emit LoanSettled
  function shortfall(uint64 loanRef) external view returns (uint256);  // 0 unless block.timestamp > expiry + GRACE (7 days) and repaid < principal and !settled
}
```

The registry is a ledger plus a forwarder. It holds funds only when a forward fails or a share arrives for a
slot nobody has opened yet, and then only for the slot's lender to `collect`. No owner.

### 6.3 Phase 2 contracts (`contracts/token/`)

- `StipendToken.sol`: plain ERC-20 (OpenZeppelin), name "H0.81 Capital", symbol "H081", 18 decimals, total
  supply minted once to the deployer in the constructor. No mint, no admin. NOT deployed anywhere by this work.
- `CapacityStake.sol`: `stake(amount)`, `requestUnstake(amount)` with a 7-day cooldown, `unstake()`;
  views `deskCapacity(addr) = staked / DESK_UNIT` and `shieldCap(addr) = (staked / SHIELD_UNIT) * SHIELD_PER_UNIT`
  with `DESK_UNIT = 100e18`, `SHIELD_UNIT = 100e18`, `SHIELD_PER_UNIT = 10_000e6` (USDG per 30 days). Constants, no owner.
  The pool does not read it: capacity is enforced by relayers and hosted endpoints, never by the pool, so the
  no-admin invariant holds. State this in `docs/tokenomics.md`.
- `SafetyPool.sol`: stakers deposit H081 into a pool; `insure(loanRef, premium)` by the loan's lender binds the
  loan to the pool and pays the premium to the pool; `slash(loanRef)` by anyone: `uint256 s = streamLoan.shortfall(loanRef)`
  must be > 0 and the loan bound and not yet paid; transfers `min(s, poolBalance)` of the pool's H081 to the lender
  (valued 1:1 in token units for v1; pricing is out of scope) and marks it paid. The settlement is the chain
  state produced by the circuit's routing, so no oracle decides. Unbonding cooldown 14 days.

## 7. SDK (`src/`)

- `crypto.ts`: `DOM.LENDER`, new `Policy`/`Allowance` fields, `lenderKey(lenderAddr, loanRef)`,
  `shareOf(amount, bps)`, `vestedNow(a, now)`, `lenderClaimable(a, now)`, `spendAllowance` updated
  (gross/net/share, claims), `policyHash`/`allowanceCommitment` updated.
- `inputs.ts`: `spendInput` (share witnesses, `lenderAmount`, claim mode), `delegateInput` (sub lender fields,
  zero residual), `grantInput`, `discloseInput`, new `streamInput`. Export `SPEND_PUBLIC`, `STREAM_PUBLIC` orders.
- `client.ts`:
  - `Wallet.pledge(owned, { lenderAddr, loanRef, pledgeBps, lenderViewPub })` is the owner's: reclaim what is
    left, grant it again to the same agent with the pledge (`GrantRequest.pledge`); returns the pledged
    allowance and a `LenderPayload` (type exported from `encryption.ts`: the full note plus both view keys,
    encrypted to `lenderViewPub`), which is handed to the lender off-chain. Agents cannot pledge.
  - `Wallet.pay` on a pledged allowance fills the lender fields and `ext.encryptedLender`.
  - `Wallet.sync` recovers a successor whose memo was never written for this wallet (a lender claim with a
    blank `encryptedAllowance`): it is fixed by public calldata (`remaining - lenderAmount`,
    `pledgePaid + lenderAmount`, window kept, `nextRho`), rebuilt from the spend's `PledgeRouted` and
    `NewCommitment` logs and kept when the commitment matches. A successor memo that omits the lender block
    inherits it from the predecessor on the same line.
  - `Wallet.proveStream(owned, { minRemaining, minRate, audience })`, `verifyStream(pool, proof, args)`.
  - `Wallet.transferAllowance(owned, to)` (Phase 3 bearer note: delegate full amount, identical policy, zero residual).
  - `Wallet.treasuryTree()` for owners: nested view of granted allowances and their sub-allowances (Phase 3).
  - `LenderWallet` (new file `src/lender.ts`): `ingest(payload)`, `sync()` (scan `LenderMemo` events for its
    loanRefs and decrypt successor notes), `claimable(loanRef, now)`, `claim(loanRef, amount)` -> builds the
    claim proof and calls `StreamLoan.claim`, `fund(...)` (refuses a stream proof that does not restate a
    live note the lender holds: agent, cap, expiry, pledge, routed total, start, asset and bounds),
    `settle(...)`, `collect(...)`.
  - The pull path depends on the borrower's memos: the pool hashes `encryptedLender` into the proof but cannot
    read it. A spent note with no readable successor is `lost`; `opaque(loanRef)` reports it, `claim` throws
    `borrower withheld the successor memo; use shortfall/settle`. The routed shares on every spend and the
    registry's shortfall are the backstop. `pending` records are capped at `PENDING_MAX`.
- `encryption.ts`: memo payload gains the lender copy; keep the `n:<hex>` bigint encoding.
- Tests: extend `test/circuits/circuits.test.ts` (sections 2.6, 3, 4, 5) and `test/e2e/pool.test.ts`
  (Phase 1 end to end: grant -> pledge -> proveStream -> fund -> spends route shares -> lender claims the
  vested share -> owner reclaim routes -> settle; negative tests for re-pledge, re-point, skipped share,
  short share, double spend, claim by a non-lender; Phase 3 transfer and tree). Add `test/e2e/token.test.ts`
  for Phase 2. Everything must pass with `npm test`.

## 8. Repo hygiene

- `README.md`: rewrite for v2 (positioning, the six circuits with constraint counts, the lending flow, Phase 2
  contracts, what is and is not deployed, build/test/compile instructions).
- `.github/workflows/ci.yml`: Node 20, `npm ci`, `npm run circuits:build`, generate `pot17` with snarkjs if
  absent (cache `circuits/ptau`), `npm run circuits:setup`, `npm run contracts:compile`, `npm test`.
- `docs/tokenomics.md`: supply, no emissions, capacity curve constants, safety pool mechanics, fee capture
  (none at launch), the statement that no token is launched and that the pool never reads the token.

## 9. Site (`../stipend-site`)

- Regenerate `public/circuits/spend.*` and `disclose.*` from the new build and add `stream.*`; update
  `src/lib/zk/protocol.ts` to the new fields and add `streamInput`; update constraint counts in `prover.ts`.
- Demo step 3 "Lend": pledge the demo allowance to a demo lender (40 %), prove a stream bound, show the lender
  view (bound, rate, share, expiry) and a pay that routes the share.
- Chapter statuses: Lend "Phase 1 · built, testnet next"; Capacity "Phase 2 · built, not deployed";
  Transfer "Phase 3 · built". Keep "no token is live" and "nothing on mainnet".

## 10. Non-negotiables

No admin keys, no pause, no upgrade, no owner on any new contract. No deployment to any public chain and no
token launch in this work. Mainnet only after an external audit. Every claim on the site must be backed by a
passing test.
