# H0.81 Capital protocol (codename Stipend)

Private, programmable treasuries for AI agents on Solana, and the first private cashflow a lender
can lend against. One shielded pool holds any SPL Token or Token-2022 asset (USDG, xStocks). Owners fund up to sixteen agents per proof; each
agent's spending policy lives inside its note, so a payment that breaks the policy has no valid proof.
Agents delegate slices of their allowance to sub-agents under provably tighter policy, budgets stream at
a rate per second, and an owner can pledge a streamed allowance to a lender: a fixed share of every spend
is routed to the lender inside the spend proof, and the lender can pull its share of what has vested.
Owners, agents and lenders prove bounds on balances and rates without revealing amounts, counterparties
or policies. There is no admin key, pause switch or upgrade path on any contract.

Target chain: **Solana** (owner decision 2026-10-26), the same chain as the H081 token. Assets: USDG and
tokenized stocks (xStocks; not available to US persons). The Solana programs (`solana/`: stipend_pool,
stream_loan, capacity_stake, safety_pool) are built and tested on a local validator per
`docs/SOLANA-PORT.md`; see "Solana programs" below and `solana/README.md`. The EVM contracts in
`contracts/` were built for Robinhood Chain and are kept as the reference implementation. Robinhood Chain is
no longer the target.
**The H081 token is live on Solana (below). The protocol programs in this repository are not deployed to
any public chain yet.**

## H081 token: the official contract

| | |
|---|---|
| Contract (mint) | [`EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo`](https://solscan.io/token/EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo) |
| Name, ticker | H0 81 Capital, `H081` |
| Chain, venue | Solana, Meteora Dynamic Bonding Curve (paired with SOL), graduates to a Meteora DAMM v2 pool |
| Supply | 1,000,000,000, fixed: no mint authority, no freeze authority, metadata immutable |
| Fee | flat 2% on every buy and sell, in SOL: 0.4% to Meteora, 1.6% to the creator |
| Allocation | no presale, no free allocation, no dev buy |
| Website | https://h081.xyz (facts and risks: https://h081.xyz/token) |
| X | https://x.com/H081CAP |
| Trade | https://jup.ag/tokens/EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo |

This is the only official H081 contract. Any other token named H081 or "H0 81 Capital" is not ours.
The token's on-chain metadata carries only its name and ticker, so this README and https://h081.xyz/token
are where the contract is published. Today H081 is a trading token; the staking and insurance uses
described under "Phase 2" need the Solana programs to be deployed first.

## The six circuits

| Circuit | Does | Constraints | Public inputs |
|---|---|---|---|
| `transact` | deposit, withdraw, shielded transfer (2-in 2-out) | 27,950 | 8 |
| `grant` | owner funds up to 16 agents plus change in one proof | 96,685 | 22 |
| `spend` | agent pays, owner reclaims, or lender claims; routes the pledge share | 27,344 | 15 |
| `disclose` | `remaining >= b`, `spent <= b`, `windowSpent <= b` over an allowance | 14,310 | 6 |
| `delegate` | agent splits an allowance into up to 4 sub-allowances plus a residual | 35,307 | 9 |
| `stream` | `proveStream`: the lender's view of a pledged, streamed allowance | 14,482 | 13 |

Counts are `snarkjs r1cs info` on the current build (Groth16, BN254, `pot17`, limit 131,072). Proving in
Node takes about one second per proof on a laptop; `grant` takes a few seconds.

## What the chain sees

| Operation | Public | Private |
|---|---|---|
| `transact` | root, two nullifiers, two commitments, the public leg (amount, asset, recipient) if any | note amounts, owners, the asset of a shielded transfer |
| `grant` | root, two nullifiers, seventeen commitments, an opaque total hash | every amount, every agent, every policy, the asset, any pledge |
| `delegate` | root, nullifier, five commitments, the timestamp | the parent, the sub-agents, every amount and policy |
| `spend` (unpledged) | root, nullifier, successor commitment, payout commitment or public payout, the timestamp, an opaque receipt | which allowance, its policy, remaining budget, window counters, the payer. For a shielded payout also the amount and recipient |
| `spend` (pledged) | the above plus the asset, the lender address, the loan ref and the share routed | the recipient and balances stay hidden; the gross amount is implied by the share |
| `verifyDisclosure` | root, statement kind, bound, window id, agent key, audience | the asset, the policy, the actual figures |
| `verifyStream` | root, min remaining, min rate, lender address, loan ref, pledge bps, expiry, lifetime cap, routed so far, agent key, audience, stream start, asset | the balance, counterparties, window state, strategy |

### The privacy price of a pledge

A pledged allowance reveals, per spend, the asset, the lender address, the loan ref and the share amount
(and so the gross spend amount) to the chain. Recipients and balances stay hidden. This is the cost of
on-chain-verifiable repayment: it is what lets a lender be paid without trusting anyone, and what makes
Phase 2 slashing objective. Unpledged allowances are unchanged from v1.

## Policies (enforced in the spend circuit)

| Field | Meaning | 0 means |
|---|---|---|
| `lifetimeCap` | total the allowance may ever spend (equals the grant amount) | n/a |
| `windowCap` / `windowLen` | at most `windowCap` per window of `windowLen` seconds; the window id is `floor(now / windowLen)` | no window limit |
| `maxPerTx` | per-payment ceiling | no ceiling |
| `expiry` | unix time after which the agent cannot spend | never |
| `recipientRoot` | Merkle root (depth 8) of allowed recipients, public addresses or shielded keys mixed | any recipient |
| `streamRate` / `streamStart` | cumulative spend may never exceed `streamRate * (now - streamStart)` (vesting: units per second) | no streaming |
| `ownerPk` | the key that can reclaim the allowance at any time | n/a |
| `lender` / `pledgeBps` | `Poseidon(DOM_LENDER, lenderAddr, loanRef)` and the share (0..10000) of every spend routed to it | not pledged |

The allowance note also carries `pledgePaid`, the cumulative amount routed to the lender on this line.
`now` is a public input that the contract checks against block time (15 minutes back, 1 minute ahead),
so the window length itself stays private.

### Who may spend, and the owner-reclaim rule

Exactly one of three roles proves a spend: the **agent** (every rule enforced, including when the owner
granted to its own key), the **owner** (no rules), or the **lender** (a claim: `sk = 0`, and the contract
requires `msg.sender == lenderAddr`). The owner's reclaim bypasses every policy rule except one: on a
pledged allowance the lender's share is still routed, so a lender cannot be drained by a reclaim. Over
any sequence of spends, reclaims and claims the total routed to a lender never exceeds
`floor(lifetimeCap * pledgeBps / 10000)`; this is a circuit test and a 300-run property test on the pure model.

## Delegation

An agent splits its allowance into up to four sub-allowances plus a residual, in one proof, without the
owner. The circuit forces every sub-policy to be no looser than the parent's: per-payment caps and
expiries at or below the parent's, window caps and stream rates that sum (with the residual's) to no
more than the parent's, sub-streams that start no earlier than now, and the parent's window length,
allow-list, owner and pledge carried over unchanged. The residual keeps the parent's spent-so-far and
routed-so-far, so the tree as a whole still obeys the owner's policy, and the owner can reclaim any note
in it. Only the owner creates a pledge; an agent can neither pledge, re-point nor drop one.

## Stream-backed lending (Phase 1)

1. The lender opens a slot in the `StreamLoan` registry (`openSlot`, sequential `loanRef`).
2. The owner grants (or re-grants) a streamed allowance pledged to `(StreamLoan address, loanRef, pledgeBps)`
   and hands the lender an encrypted copy of the note (`LenderPayload`), off-chain.
3. The borrower proves a stream bound (`proveStream`): at least `minRemaining` left, rate at least `minRate`,
   plus the cap, expiry, what was routed so far, when the stream starts and the asset. The lender checks it
   on chain (`verifyStream`) and against the note it holds, then funds through `StreamLoan.fund`, which
   records the loan and pays the principal out.
4. Every spend on the pledged allowance routes `floor(amount * pledgeBps / 10000)` to the lender inside
   the proof (`PledgeRouted`), credits `repaid` in the registry and forwards the tokens to the slot's lender.
   The recipient gets the net. A memo for the lender (`LenderMemo`) carries the successor note.
5. The lender may also pull the vested share itself: a claim through `StreamLoan.claim` for at most
   `floor(vested * pledgeBps / 10000) - pledgePaid`, where `vested <= min(lifetimeCap, streamRate * (now - streamStart))`.
6. After `expiry + 7 days` with `repaid < principal` the registry reports a `shortfall`; the lender
   `settle`s when done. An allowance that never expires has no due date and never reports a shortfall.

The lender leg never blocks a spend, so the owner can always reclaim: a share the token refuses to
transfer is escrowed in the pool (`pullLenderShare` is permissionless), a lender contract gets at most
300,000 gas for `onPledge`, and the registry keeps what it cannot forward for the slot's lender (`collect`).
The pull path depends on the borrower writing the successor memo; a borrower that withholds it leaves the
loan `opaque` to the lender's wallet, which then relies on the routed shares and the shortfall.

### The lender wallet

`LenderWallet(viewingKey, pool, streamLoan)` is the lender's side: `openSlot`, `ingest(payload)`,
`sync()` (follows every pledged note through `LenderMemo` and commitment memos), `claimable(loanRef, now)`,
`claim(loanRef, amount?)`, `fund(loanRef, streamProof, asset, principal, payoutTo)` (refuses a proof that
does not restate a live note it holds), `collect`, `settle`, `loan`, `shortfall`, `opaque(loanRef)`.

## Phase 2 contracts (`contracts/token/`, built and tested, not deployed)

- `StipendToken` (EVM reference only; the real H081 is the Solana token `EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo`): plain OpenZeppelin ERC-20, name "H0.81 Capital", symbol `H081` (working symbol, not a
  commitment), 18 decimals, whole supply minted once to the deployer. No mint, no owner.
- `CapacityStake`: staked H081 buys capacity for relayers and hosted endpoints to honour:
  `deskCapacity = staked / 100e18`, `shieldCap = (staked / 100e18) * 10,000 USDG per 30 days`;
  7-day unstake cooldown. **The pool never reads this contract**, so the no-admin invariant holds.
- `SafetyPool`: stakers pool H081; a loan's lender `insure`s a funded, unexpired loan and pays a premium
  in; once the registry reports a shortfall, anyone may `slash` and the pool pays the lender
  `min(shortfall, poolBalance)` (1:1 in base units for v1). The shortfall is chain state produced by the
  circuit's routing, so no oracle decides. 14-day unbonding; a slash that empties the pool retires every share.

Details and caveats: `docs/tokenomics.md`.

## Phase 3 helpers

- `Wallet.transferAllowance(owned, to)`: a bearer note. The whole balance moves to another key under the
  identical policy (zero residual); the mandate, and any pledge, travel with the note.
- `Wallet.treasuryTree()`: the owner's nested view of every granted allowance and its sub-allowances.

## Disclosures

Over an allowance note as of a known root: `remaining >= bound`, `spent <= bound`, or
`windowSpent <= bound` in a stated window. The note's own counters make the statement complete, since
every spend must rewrite the note. A grant's total is openable off-chain from its `TotalCommitment`.
Each payment also emits a `ReceiptCommitment` the payer can open to a counterparty.

## Layout

```
circuits/lib/        hashes (Poseidon, domain-tagged), Merkle proof, range checks, pledge share and lender binding
circuits/main/       transact, grant, spend, disclose, delegate, stream
contracts/           StipendPool, MerkleTreeWithHistory, TryERC20, generated verifiers/
contracts/lending/   StreamLoan registry, IPledgeSink
contracts/token/     StipendToken, CapacityStake, SafetyPool (Phase 2)
contracts/test/      TestERC20, BlockingERC20, GreedySink (test doubles only)
src/                 SDK: crypto (mirrors the circuits), merkle, encryption (x25519 + XChaCha20),
                     inputs (circuit input builders), prover (snarkjs), client (Wallet, deploy, scanning),
                     lender (LenderWallet), token (Phase 2 deploy helpers and the capacity curve)
test/circuits/       constraint tests: honest inputs accepted, every dishonest input rejected
test/e2e/            full flow on an in-process EVM with real Groth16 proofs (pool, lending, token)
test/sdk/            pure-model property test of the lender total bound
scripts/             build-circuits, setup-circuits, deploy, gen-solana-vk, Solana localnet and test runners
solana/programs/     stipend_pool, stream_loan, capacity_stake, safety_pool (Anchor crates, cargo build-sbf)
solana/scripts/      WSL build and private-validator scripts
src/solana/          Solana SDK: fieldOf, PDAs, buffers, instruction builders, events, SolanaWallet,
                     SolanaLenderWallet (wallet lender), loan.SolanaLoanLenderWallet (stream_loan), staking helpers
test/solana/         e2e, pool, lending, staking (local validator), events and consistency (unit)
```

## Build and test

```
npm ci
npm run circuits:build      # circom2 (WASM) -> build/circuits/<name>/{r1cs,wasm,sym}; minutes per circuit
npm run circuits:setup      # Groth16 keys + Solidity verifiers from circuits/ptau/pot17.ptau (dev ceremony)
npm run contracts:compile   # Hardhat, solc 0.8.28, artifacts in build/artifacts
npm test                    # 41 circuit tests + 50 end-to-end tests + 1 pure-model property test
npm run typecheck
```

`npm run circuits:build grant` and `npm run circuits:setup grant` take circuit names to rebuild one.
`test:circuits` and `test:e2e` run the halves. Builds and setups must not run in parallel.

The powers-of-tau file `circuits/ptau/pot17.ptau` is not committed. Generate it with snarkjs (this is what
CI does when the cache misses):

```
npx snarkjs powersoftau new bn128 17 pot17_0000.ptau
npx snarkjs powersoftau contribute pot17_0000.ptau pot17_0001.ptau --name=dev -e="$(openssl rand -hex 32)"
npx snarkjs powersoftau prepare phase2 pot17_0001.ptau circuits/ptau/pot17.ptau
```

For production, download `powersOfTau28_hez_final_17.ptau` or larger, set `PTAU=<path>`, and replace the
single dev contribution with a public ceremony. The circuits, the pipeline and the contracts do not change.

CI (`.github/workflows/ci.yml`) runs the same steps on Node 20 with the ptau cached.

## Solana programs (`solana/`)

| program | what it does | port of |
|---|---|---|
| `stipend_pool` | shielded pool: deposit, withdraw, transfer, 16-way grant, spend (agent, owner reclaim, lender claim), delegate, lender-share routing and escrow, on-chain Groth16 (alt_bn128) and Poseidon Merkle tree, disclosure and stream verification | `StipendPool.sol` |
| `stream_loan` | slots, loans funded against a stream proof, repayment credited from the slot inbox, lender claims through the slot PDA, shortfall view | `StreamLoan.sol` |
| `capacity_stake` | staked H081 buys desk and shielding capacity, 7-day unstake cooldown | `CapacityStake.sol` |
| `safety_pool` | H081 stakers insure stream-backed loans; slash on shortfall, 14-day unbonding at risk | `SafetyPool.sol` |

Circuits, zkeys and verifying keys are byte-identical to the EVM build. Solana pubkeys enter the circuits
as `fieldOf(pubkey)` (first 160 bits of sha256). No program has an admin key, a pause or upgrade logic;
every per-mint pool is created permissionlessly. Layout, PDAs, the buffer flow and the deploy steps
(including removing the upgrade authority, only on the owner's explicit go) are in `solana/README.md`.

Requirements: WSL Ubuntu with Rust 1.99, cargo-build-sbf 4.4.0 and the Solana CLI 4.3.2
(`solana-test-validator`); Node on Windows. Anchor CLI is not needed.

```
npm run solana:build     # all programs (+ localnet-only probe/fast variants) -> solana/target-so (gitignored)
npm run test:solana      # every Solana test file: three private validators (8999, 9099, 9199), started fresh
                         # and stopped afterwards; a missing validator, program or a skipped test fails the run
```

Test results (2026-10-26, local only):

| command | result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` (EVM reference + circuits) | 5 files, 92/92 |
| `npm run test:solana` | 86/86: pool suite 52 (e2e, pool, events, consistency), loan 11, staking 23 |
| `npm run solana:build` | all 4 programs and 3 localnet variants build |

Measured compute units (local validator): deposit 191k, withdraw 188k, grant 565k (16-way 576k), public
spend 180k, shielded spend 169k, pledged spend 198k, lender claim 181k, delegate 237k; Groth16 spend verify
121k. All are asserted against budgets in the tests and written to `solana/target-so/compute-units*.json`.

## What is not deployed

- No contract or program in this repository is deployed to Solana (devnet or mainnet), Robinhood Chain,
  its testnet, or any other public chain. The Solana programs have only run on private local
  `solana-test-validator` instances, loaded as immutable programs at localnet ids whose keypairs live in the
  gitignored `solana/keys/` and must never be used for a public cluster.
- No Solana program has been given an upgrade authority on any cluster, and none has been made final;
  removing the upgrade authority (`solana program set-upgrade-authority <ID> --final`) is part of a future
  deployment and happens only on the owner's explicit go (`solana/README.md`, "Deploying").
- The H081 token is the one deployed piece: `EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo` on Solana
  (see "H081 token" above). `StipendToken.sol` is an EVM reference contract in the repo, not the token; the
  the EVM launchpad and the launchpad launch plans are superseded.
- **Superseded for the protocol (2026-10-26):** the EVM deploy below targets Robinhood Chain and is kept
  only for the reference implementation; the bank ships as Solana programs (`docs/SOLANA-PORT.md`).
- `scripts/deploy.mjs` deploys the hasher, the six verifiers, the pool and the `StreamLoan` registry to
  the named network and writes `deployments/<network>.json`; mainnet additionally needs `STIPEND_ALLOW_MAINNET=1`.
  It does not deploy the Phase 2 contracts.
- Mainnet only after an external audit and a public trusted-setup ceremony.

```
DEPLOYER_KEY=0x... npm run deploy -- robinhoodTestnet
STIPEND_ALLOW_MAINNET=1 DEPLOYER_KEY=0x... npm run deploy -- robinhood
```

The pool has no owner, so redeploying is just a new address.

## Using the SDK

```ts
const owner = new Wallet(Account.random(), pool.connect(ownerSigner));
await owner.deposit(usdg, 5_000_000_000n, { relayer, fee: 1_000_000n });

// Lender side: a slot in the registry, and a viewing key for its memos.
const lender = new LenderWallet(lenderView, pool, streamLoan.connect(lenderSigner));
const loanRef = await lender.openSlot();

// Owner grants a streamed allowance pledged 40% to that slot.
const { lenderPayloads } = await owner.grant(usdg, [
  { to: agentA.account.address, amount: 1_000_000_000n, streamRate: 100_000n, expiry,
    pledge: { lenderAddr: lender.address.lenderAddr, loanRef, pledgeBps: 4000n, lenderViewPub: lender.address.viewPub } },
  { to: agentB.account.address, amount: 500_000_000n, recipients: [vendorAddress] },
]);
lender.ingest(lenderPayloads[0]!);            // handed over off-chain

// Borrower proves a stream bound; the lender verifies it on chain and funds.
const agent = new Wallet(agentKeys, pool.connect(relayerSigner));
await agent.sync();
const stream = await agent.proveStream(agent.agentAllowances(usdg)[0], { minRemaining: 900_000_000n, minRate: 50_000n, audience });
await verifyStream(pool, stream.proof, stream.args);   // true
await lender.sync();
await lender.fund(loanRef, stream, usdgAddress, 300_000_000n, borrowerPayout);

// Every pay routes the share to the lender inside the proof; the vendor gets the net.
await agent.pay(agent.agentAllowances(usdg)[0], 200_000_000n, vendorAddress, { relayer, fee: 2_000_000n });
await lender.sync();
await lender.claim(loanRef);                  // pulls the vested share not yet routed

const { proof, args } = await agent.prove(agent.agentAllowances(usdg)[0], 'spentAtMost', 500_000_000n, audience);
await verifyDisclosure(pool, proof, args);    // true, and the figures stay private
await owner.reclaim(owner.grantedAllowances()[0]);   // still routes the lender's share
```

## Not yet built

- Relayer service (the SDK already produces relayer-submittable calldata and pays fees in the asset).
- x402 adapter and MCP server on top of `Wallet.pay` and `Wallet.prove`.
- Relayer fees for fully shielded operations (fee notes). Today only operations with a public leg pay a fee.
- Note consolidation when more than two inputs are needed.
- Per-asset caps inside one policy for mixed stock and stablecoin desks; more than four subs per delegation.
- Loan pricing: the safety pool values H081 1:1 against the shortfall and premiums are lender-chosen.
- Public trusted-setup ceremony and an external audit.
- Solana: a relayer service and address lookup tables for the SDK; deploy scripts for a public cluster (the
  steps are documented, nothing is automated); verifiable builds.
