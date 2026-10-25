# H0.81 Capital protocol (codename Stipend)

Private, programmable treasuries for AI agents on a public chain. One shielded pool holds any ERC-20.
Owners fund up to sixteen agents per proof; each agent's spending policy lives inside its note, so a
payment that breaks the policy has no valid proof. Agents can delegate slices of their allowance to
sub-agents under provably tighter policy, and budgets can stream at a rate per second. Owners and agents can prove bounds on what was spent without
revealing amounts, counterparties or policies. There is no admin key, pause switch or upgrade path.

Target chain: **Robinhood Chain** (4663, Arbitrum Orbit, Cancun). Assets: USDG and the tokenized stocks.
Token launch on the EVM launchpad is a separate step, see an earlier launch plan.

## What the chain sees

| Operation | Public | Private |
|---|---|---|
| `transact` (deposit, withdraw, shielded transfer) | root, two nullifiers, two commitments, the public leg (amount, asset, recipient) if any | note amounts, owners, the asset of a shielded transfer |
| `grant` (fund up to 16 agents) | root, two nullifiers, seventeen commitments, an opaque total hash | every amount, every agent, every policy, the asset |
| `delegate` (agent splits its allowance into up to 4 sub-allowances) | root, nullifier, five commitments, the timestamp | the parent, the sub-agents, every amount and policy |
| `spend` (agent pays, or owner reclaims) | root, nullifier, successor commitment, payout commitment or public payout, the timestamp, an opaque receipt | which allowance, its policy, remaining budget, window counters, the payer. For a shielded payout also the amount and recipient |
| `verifyDisclosure` | root, statement kind, bound, window id, agent key, audience | the asset, the policy, the actual figures |

## Policies (enforced in the spend circuit)

| Field | Meaning | 0 means |
|---|---|---|
| `lifetimeCap` | total the allowance may ever spend (equals the grant amount) | n/a |
| `windowCap` / `windowLen` | at most `windowCap` per window of `windowLen` seconds; the window id is `floor(now / windowLen)` | no window limit |
| `maxPerTx` | per-payment ceiling | no ceiling |
| `expiry` | unix time after which the agent cannot spend | never |
| `recipientRoot` | Merkle root (depth 8) of allowed recipients, public addresses or shielded keys mixed | any recipient |
| `streamRate` / `streamStart` | cumulative spend may never exceed `streamRate * (now - streamStart)` | no streaming |
| `ownerPk` | the key that can reclaim the allowance at any time, under no rules | n/a |

`now` is a public input that the contract checks against block time (15 minutes back, 1 minute ahead),
so the window length itself stays private.

## Delegation

An agent splits its allowance into up to four sub-allowances plus a residual, in one proof, without the
owner. The circuit forces every sub-policy to be no looser than the parent's: per-payment caps and
expiries at or below the parent's, window caps and stream rates that sum (with the residual's) to no
more than the parent's, sub-streams that start no earlier than now, and the parent's window length,
allow-list and owner carried over unchanged. The residual keeps the parent's spent-so-far, so the tree
as a whole still obeys the owner's policy, and the owner can reclaim any note in it.

## Disclosures

Over an allowance note as of a known root: `remaining >= bound`, `spent <= bound`, or
`windowSpent <= bound` in a stated window. The note's own counters make the statement complete, since
every spend must rewrite the note. A grant's total is openable off-chain from its `TotalCommitment`.
Each payment also emits a `ReceiptCommitment` the payer can open to a counterparty.

## Layout

```
circuits/lib/        hashes (Poseidon, domain-tagged), Merkle proof, range checks
circuits/main/       transact (2-in 2-out), grant (2-in, 16 allowances + change), spend, disclose, delegate (1-in, 4 subs + residual)
contracts/           StipendPool, MerkleTreeWithHistory, generated verifiers, test token
src/                 SDK: crypto (mirrors the circuits), merkle, encryption (x25519 + XChaCha20),
                     inputs (circuit input builders), prover (snarkjs), client (Wallet, deploy, scanning)
test/circuits/       constraint tests: honest inputs accepted, every dishonest input rejected
test/e2e/            full flow on an in-process EVM with real Groth16 proofs
scripts/             build-circuits, setup-circuits, deploy
```

## Build and test

```
npm install
npm run circuits:build      # circom (WASM build) -> build/circuits/<name>/{r1cs,wasm,sym}
npm run circuits:setup      # Groth16 keys + Solidity verifiers (dev ceremony, local pot16)
npm run contracts:compile
npm test                    # 19 circuit tests + 15 end-to-end tests
```

Constraint counts: transact 27,950 · grant 78,541 · spend 24,700 · disclose 14,057 · delegate 32,345.
Proving in Node takes about one second per proof on a laptop.

The powers-of-tau file is generated locally (`circuits/ptau/pot17.ptau`) because the public Hermez
copies were not reachable from this machine. For production, download `powersOfTau28_hez_final_17.ptau`
or larger, set `PTAU=<path>`, and replace the single dev contribution with a public ceremony. The
circuits, the pipeline and the contracts do not change.

## Deploy

```
DEPLOYER_KEY=0x... npm run deploy -- robinhoodTestnet
STIPEND_ALLOW_MAINNET=1 DEPLOYER_KEY=0x... npm run deploy -- robinhood
```

Writes `deployments/<network>.json`. The pool has no owner, so redeploying is just a new address.

## Using the SDK

```ts
const owner = new Wallet(Account.random(), pool.connect(ownerSigner));
await owner.deposit(usdg, 5_000_000_000n, { relayer, fee: 1_000_000n });
await owner.grant(usdg, [
  { to: agentA.account.address, amount: 1_000_000_000n, windowCap: 300_000_000n, maxPerTx: 250_000_000n },
  { to: agentB.account.address, amount: 500_000_000n, recipients: [vendorAddress] },
]);

const agent = new Wallet(agentKeys, pool.connect(relayerSigner)); // submitted by a relayer
await agent.sync();
await agent.pay(agent.agentAllowances(usdg)[0], 200_000_000n, vendorAddress, { relayer, fee: 2_000_000n });
await agent.pay(agent.agentAllowances(usdg)[0], 40_000_000n, agentB.account.address); // shielded

const { proof, args } = await agent.prove(agent.agentAllowances(usdg)[0], 'spentAtMost', 500_000_000n, audience);
await verifyDisclosure(pool, proof, args); // true, and the figures stay private
await owner.reclaim(owner.grantedAllowances()[0]);
```

## Not yet built

- Relayer service (the SDK already produces relayer-submittable calldata and pays fees in the asset).
- x402 adapter and MCP server on top of `Wallet.pay` and `Wallet.prove`.
- Relayer fees for fully shielded operations (fee notes). Today only operations with a public leg pay a fee.
- Note consolidation when more than two inputs are needed.
- Per-asset caps inside one policy for mixed stock and stablecoin desks; more than four subs per delegation.
- Public trusted-setup ceremony and an external audit.
