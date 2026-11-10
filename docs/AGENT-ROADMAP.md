# Agent roadmap: complex financial operations, autonomously

Fixed 2026-11-06. Goal: an agent can earn, spend, save, lend and borrow privately on its own, with its owner
setting the rules. Finding that shapes it: the Solana SDK (`src/solana/wallet.ts`, `src/solana/lender.ts`) already
does almost all of it; agents reach a subset of it through the operations in `integrations/` (MCP + Solana Agent Kit).

## Today (agents, through MCP / agent kit)

| Capability | Agents? |
|---|---|
| Deposit, withdraw, balance | yes (`h081_bank_*`) |
| Borrow, loan quote | yes (`h081_loan_borrow`, `h081_loan_quote`) |
| Capacity stake | yes (`h081_stake`) |
| Private payment from an allowance | yes (`h081_pay`: to a wallet or an `h081-address:` code; `H081_MAX_PAY` ceiling) |
| Allowances for sub-agents (grant / delegate / reclaim) | yes (`h081_allowance_grant`, `h081_allowance_delegate`, `h081_allowance_reclaim`: plan unless `confirm: true`; `H081_MAX_GRANT` ceiling; delegate needs the delegate artifacts the site does not ship yet) |
| Proof of funds | only via paid x402 `prove-disclose` (`SolanaWallet.prove`) |
| Lend (open, fund, status, claim, collect, settle, close) | yes (`h081_lend`: open / fund / settle / close are a plan unless `confirm: true`; `H081_MAX_LEND` ceiling; close is refused until the SDK has `close_slot`) |
| Safety pool | no (instruction builders only) |
| Pay x402 APIs from the private balance | no (`src/x402.ts` is EVM-only) |

## Build now (wrappers over existing SDK; no circuit, no program change)

1. **`h081_pay`** (built 2026-11-06, branch feat/agent-tools): pay any address privately from an allowance, inside its caps.
2. **`h081_allowance_grant` / `h081_allowance_delegate` / `h081_allowance_reclaim`** (built 2026-11-06, branch feat/agent-tools): budgets for sub-agents; a child can never be looser than
   its parent.
3. **`h081_lend`** (built 2026-11-06, branch feat/agent-tools; actions open, fund, status, claim, collect, settle, close): agents lend
   to agents. Loan codes are the site's v2 frame (`h081-loan-terms:` kind 1, `h081-loan-proof:` kind 2, the loan program's
   network tag); `h081_loan_borrow` now emits the v2 proof code too and still reads v1 terms. Per-loan cap; dry run by default.

## Next

0. **Free relayed private payments (first after the build-now PR; decided 2026-11-06).** Today `h081_pay` to an
   `h081-address:` code is sent by the agent key (the spend circuit forbids a fee on shielded payments:
   `circuits/main/spend.circom` `fee * (1 - isPublic) === 0`), so the agent wallet shows on chain as using the bank.
   Fix without a circuit change: the relayer sends shielded spends with fee 0 and pays the SOL itself, bounded by
   - a hard global daily SOL budget (start 0.05 SOL/day ≈ $5; worst-case abuse = that, nothing more);
   - a separate per-operator daily quota for capacity_stake stakers (operator signature to the relayer, as for
     withdrawals above the free tier; off-chain only), which anonymous spam cannot drain;
   - a minimum amount per payment (e.g. 1 USDG);
   - over budget: refused with a clear message (retry later, stake, or `direct: true`); never sent silently.
   Work: relayer (accept zero-fee shielded spends, daily counters in the existing free-tier store) + SDK/`h081_pay`
   relay path + tests. Relayer deploy is the owner's. Cost: ~0.00002–0.0002 SOL per payment, paid from protocol
   revenue, never creator fees.
4. **`h081_prove_funds` / `h081_verify_proof`**: "I have at least X" for free (off-chain verify); on-chain verify
   stays the paid x402 service.
5. **Private subscriptions**: a vendor gets a capped per-window allowance (`grant` + `transferAllowance`), the owner
   cancels with `reclaim`.
6. **Small tools**: `h081_consolidate`, `close_stake`, `h081_lend` close (needs `close_slot` in this repo's SDK). The lender's
   claim is `h081_lend` action `claim`; a borrower has nothing to claim (the principal arrives at funding).
7. **Safety pool for agents**: new high-level client in `src/solana/`, then tools.

## Later

8. **Private x402 payments on Solana**: Solana port of `src/x402.ts` + H081 as its own facilitator (CDP verifies
   USDC only).
9. **Private escrow and invoices**: program change (mainnet upgrade); private version needs a new circuit (ceremony).
10. **Credit from track record**: new circuit over repayment history + `stream_loan` pricing.

## Rules for every item

- Codes an agent hands to another agent or person use `integrations/core/codes.ts` framing (alphabet, checksum,
  kind and network tag); never raw JSON.
- Anything that moves the agent's own funds has an explicit cap and is tested on localnet first.
- New circuits or program changes: ceremony / upgrade plan, never `--final`.
- Publishing `@h081lll/mcp` and the agent-kit plugin needs the owner's OTP.
