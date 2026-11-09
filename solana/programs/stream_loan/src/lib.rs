//! stream_loan: lender-facing registry for loans against pledged stream allowances held in
//! stipend_pool (H0.81 Capital). Port of contracts/lending/StreamLoan.sol without the onPledge
//! callback (docs/SOLANA-PORT.md section 3.2). No owner, no admin key, no pause, no upgrade logic; only the
//! program's upgrade authority may `initialize` (read from its ProgramData account, as stipend_pool does).
//!
//! A lender opens a slot; the slot PDA is the `lenderAddr` a borrower pledges to
//! (lenderAddr = fieldOf(slot PDA), loanRef = the slot's loan ref). The pool delivers every routed
//! share to the slot's inbox (the slot PDA's associated token account). `sync` (permissionless) credits
//! the new inbox balance as repayment and forwards it to the slot lender; what cannot be forwarded
//! (lender account missing or frozen) is held for `collect`. Nothing leaves the inbox before the slot is
//! funded: shares routed to an unfunded slot wait there, and `fund` returns them to the borrower's
//! `payout_to` (they were routed before any principal existed, so they repay nothing), so a lender gains
//! nothing from a borrower's pledge until it has lent, and nothing from shares routed before it did.
//!
//! `fund` binds the loan to the borrower: the stream proof's `audience` must be fieldOf(payout_to), so
//! the principal can only go to the token account the borrower proved for, and the principal must be
//! exactly what the proof backs, max_principal(min_remaining, pledge_bps) = min_remaining * pledge_bps /
//! 10,000: the borrower chooses the amount by choosing min_remaining (minRemainingFor in the SDK), the
//! lender cannot fund less and still take the whole pledge. The lender pulls its vested share with
//! `claim`, a lender-claim spend submitted through this program with the slot PDA as signer.
//!
//! Subrogation (safety_pool): when a safety pool pays a lender for a loan's shortfall, its `slash` calls
//! `record_slash` here, signed by the pool's config PDA (safety.rs lists the safety_pool program ids; a PDA
//! can only be signed for by its program). That creates `Subrogation` ["subrogation", loan_ref] = {to, owed,
//! paid}; from then on `sync` and `claim` forward every receipt in the loan asset to `to` (the safety pool's
//! associated token account for the loan asset) until `paid` reaches `owed`, and only the remainder to the
//! lender, so a lender cannot collect the cover and then the stream as well. Slot and Ledger are unchanged.
//!
//! Platform fee: `fund` takes a 0.25% origination fee out of the payout for the treasury (fee.rs).
//! The rate and the treasury are compile-time constants; the loan still owes the full principal.
//!
//! Overpay cap (docs/LOAN-OVERPAY-CAP.md): the lender, plus a safety pool's subrogation, never receives more than
//! the principal. `sync` credits only what still fits under the principal (in the loan asset; nothing in any other
//! mint); the rest stays in the inbox above `ledger.held` and belongs to the borrower, and the permissionless
//! `return_excess` sends it to `payout_to` (the account the principal was paid to), for open and closed slots. `claim`
//! refuses a repaid loan and any claim above what is still owed; `sweep_closed` pays the lender at most what the
//! closed loan still owes. A loan over-repaid before the cap releases its held overage to the borrower once, at its
//! next sync (`repaid` drops, never below the principal).
//!
//! Rent: `close_slot` lets the slot's lender reclaim the rent of a finished loan (settled, or never funded): the
//! Slot, the loan asset's inbox and Ledger are closed to the lender. A funded loan leaves a small ClosedSlot
//! receipt (its final figures, and the key to `sweep_closed`, which hands the lender shares a pledge still routes
//! to the loan after the close). Loan refs come from the registry's monotonic counter, so a closed ref is never
//! opened again.
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::program::set_return_data;

pub mod error;
pub mod fee;
pub mod pool;
pub mod safety;
pub mod state;
pub mod token;

use error::LoanError;
use state::{
    closed_payout, closed_room, collectable, legacy_release, shortfall_of, split_receipt, subrogation_blocks_close, sweep_split, ClosedSlot, Ledger,
    Registry, Slot, Subrogation, CLOSED_PAYOUT_OFFSET,
    CLOSED_SEED, CLOSED_V2_SIZE, LEDGER_SEED, REGISTRY_SEED, SLOT_SEED, SUBROGATION_SEED,
};
pub use state::GRACE;

declare_id!("FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc");

/// The localnet program id (solana/keys/stream_loan-keypair.json). A mainnet build patches declare_id to the
/// mainnet program key (scripts/build-phase2-mainnet.sh) and refuses to compile if it is still this one.
pub const LOCALNET_ID: Pubkey = pubkey!("FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc");
#[cfg(feature = "mainnet")]
const _: () = assert!(!fee::same(&ID, &LOCALNET_ID), "mainnet build: declare_id is still the localnet stream_loan key");
#[cfg(all(feature = "mainnet", feature = "localnet-treasury"))]
compile_error!("the mainnet build cannot use the localnet-treasury feature");

#[event]
pub struct SlotOpened {
    pub loan_ref: u64,
    pub lender: Pubkey,
    pub slot: Pubkey,
}

#[event]
pub struct LoanFunded {
    pub loan_ref: u64,
    pub lender: Pubkey,
    pub asset: Pubkey,
    /// the full principal: what the loan owes
    pub principal: u64,
    /// origination fee sent to the treasury; `payout_to` received principal - fee
    pub fee: u64,
    pub payout_to: Pubkey,
}

#[event]
pub struct DripRouted {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
    pub lender: Pubkey,
    /// true when the amount counted as repayment of the loan
    pub credited: bool,
}

/// A routed share held in the inbox because the lender's account could not take it.
#[event]
pub struct DripEscrowed {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
    pub credited: bool,
}

#[event]
pub struct DripCollected {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
    pub lender: Pubkey,
}

#[event]
pub struct LoanSettled {
    pub loan_ref: u64,
}

/// The inbox held less than `ledger.held` (a Token-2022 permanent delegate moved or burned tokens out of
/// it): `held` was lowered to the inbox balance so later arrivals are credited again.
/// The lender closed the slot of `loan_ref` (close_slot). `lamports_refunded`: what the lender got back net of the
/// receipt's rent (slot + inbox + ledger - receipt). `funded` false: a slot that never lent (no receipt). The
/// final figures are here so indexers need not read the (gone) slot.
#[event]
pub struct SlotClosed {
    pub loan_ref: u64,
    pub lender: Pubkey,
    pub lamports_refunded: u64,
    pub funded: bool,
    pub asset: Pubkey,
    pub principal: u64,
    pub repaid: u64,
    pub agent_pk: [u8; 32],
    pub expiry: u64,
}

/// Shares that reached a closed slot's inbox were handed to its lender (sweep_closed).
#[event]
pub struct ClosedSlotSwept {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
    pub lender: Pubkey,
}

#[event]
pub struct HeldReconciled {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub held_before: u64,
    pub held_after: u64,
}

/// Shares that reached the inbox before the loan was funded, returned to the borrower's payout account at `fund`.
#[event]
pub struct PreFundReturned {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
    pub to: Pubkey,
}

/// A safety pool paid the lender `amount` for this loan: receipts now go to `to` until `amount` is recovered.
#[event]
pub struct SlashRecorded {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub safety_config: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

/// Part of a synced receipt forwarded to the safety pool under a recorded slash (subrogation).
#[event]
pub struct DripSubrogated {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
    pub to: Pubkey,
    /// what the pool has recovered so far, including this amount
    pub paid: u64,
    pub owed: u64,
}

/// Borrower excess in the inbox for `asset` after a sync (overpay cap): value beyond what the loan still owes, never
/// credited or forwarded; it leaves through `return_excess`. `waiting` is a level, not an increment: everything
/// waiting now, including excess an earlier sync already reported, so indexers must not sum it (sum ExcessReturned).
#[event]
pub struct ExcessHeld {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub waiting: u64,
}

/// Borrower excess sent out of the inbox (return_excess). `by_owner`: the payout account's owner signed and chose `to`.
#[event]
pub struct ExcessReturned {
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
    pub to: Pubkey,
    pub by_owner: bool,
}

/// A loan over-repaid before the overpay cap: `amount` of the held overage stopped being the lender's (repaid and
/// held both dropped by it; repaid is still >= principal). Happens at most once per loan.
#[event]
pub struct LegacyExcessReleased {
    pub loan_ref: u64,
    pub amount: u64,
}

/// Upgrade authority recorded in a BPF upgradeable loader ProgramData account (same parser as
/// stipend_pool::upgrade_authority): u32 LE tag 3 | slot u64 | Option<Pubkey>. None when immutable.
pub fn upgrade_authority(info: &AccountInfo) -> Result<Option<Pubkey>> {
    require_keys_eq!(*info.owner, bpf_loader_upgradeable::ID, LoanError::UpgradeAuthority);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 45 && data[..4] == [3, 0, 0, 0], LoanError::UpgradeAuthority);
    Ok(match data[12] {
        0 => None,
        1 => Some(Pubkey::new_from_array(data[13..45].try_into().unwrap())),
        _ => return err!(LoanError::UpgradeAuthority),
    })
}

/// Largest principal a stream proof can back: what the pledge routes out of the proven remaining
/// allowance, min_remaining * pledge_bps / 10,000 (rounded down).
pub fn max_principal(min_remaining: u128, pledge_bps: u16) -> u128 {
    min_remaining.saturating_mul(pledge_bps as u128) / 10_000
}

/// Lowers `ledger.held` to the inbox balance when tokens left the inbox outside this program.
fn reconcile_held(ledger: &mut Ledger, inbox_amount: u64, loan_ref: u64, asset: Pubkey) {
    if inbox_amount < ledger.held {
        let before = ledger.held;
        ledger.held = inbox_amount;
        emit!(HeldReconciled { loan_ref, asset, held_before: before, held_after: inbox_amount });
    }
}

fn be32_to_u128(x: &[u8; 32]) -> Result<u128> {
    require!(x[..16].iter().all(|b| *b == 0), LoanError::Overflow);
    Ok(u128::from_be_bytes(x[16..].try_into().unwrap()))
}

fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// The loan's Subrogation PDA address.
pub fn subrogation_address(loan_ref: u64) -> Pubkey {
    Pubkey::find_program_address(&[SUBROGATION_SEED, &loan_ref.to_le_bytes()], &crate::ID).0
}

/// Reads the loan's Subrogation when the (address-checked) account exists; None before any slash.
fn read_subrogation(info: &AccountInfo, loan_ref: u64) -> Result<Option<Subrogation>> {
    require_keys_eq!(*info.key, subrogation_address(loan_ref), LoanError::BadSubrogation);
    if info.owner != &crate::ID || info.data_len() == 0 {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    Ok(Some(Subrogation::try_deserialize(&mut &data[..])?))
}

/// Credits what arrived in the slot's inbox since the last sync and forwards it: first to the safety pool
/// while a recorded slash is not yet recovered (subrogation), then to the slot lender, or holds the
/// lender's part when its account cannot receive it. Returns the amount newly credited. When the safety
/// pool's account cannot take its part, nothing is synced now (the receipt waits in the inbox).
/// Overpay cap: only what still fits under the principal is credited (split_receipt; nothing in another mint);
/// the excess stays in the inbox above `held` for the borrower (return_excess). The borrower is never paid
/// inline, so a payout account that cannot receive never blocks the lender's credit.
#[allow(clippy::too_many_arguments)]
fn sync_inbox<'info>(
    slot: &mut Account<'info, Slot>,
    ledger: &mut Account<'info, Ledger>,
    mint: &AccountInfo<'info>,
    inbox: &AccountInfo<'info>,
    lender_token: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    subrogation: &AccountInfo<'info>,
    subrogation_to: &AccountInfo<'info>,
) -> Result<u64> {
    let tp = token_program.key;
    require!(token::is_token_program(tp), LoanError::BadTokenProgram);
    let slot_key = slot.key();
    require_keys_eq!(*inbox.key, token::ata(&slot_key, mint.key, tp), LoanError::BadInbox);
    require_keys_eq!(*lender_token.key, token::ata(&slot.lender, mint.key, tp), LoanError::BadLenderAccount);
    let Some(inbox_view) = token::read_token_account(inbox, tp) else { return Ok(0) };
    require_keys_eq!(inbox_view.mint, *mint.key, LoanError::BadInbox);
    // Before funding nothing is credited or forwarded: the shares wait in the inbox and `fund` returns them
    // to the borrower (a lender that never funds must not collect a borrower's routed shares).
    if !slot.funded {
        return Ok(0);
    }
    reconcile_held(ledger, inbox_view.amount, slot.loan_ref, *mint.key);
    let is_asset = slot.asset == *mint.key;
    // A loan over-repaid before the overpay cap: the held part above the principal is the borrower's (once; the
    // released amount becomes unsynced excess in the inbox).
    if is_asset {
        let x = legacy_release(slot.principal, slot.repaid, ledger.held);
        if x > 0 {
            ledger.held -= x;
            slot.repaid -= x;
            emit!(LegacyExcessReleased { loan_ref: slot.loan_ref, amount: x });
        }
    }
    let delta = inbox_view.amount.saturating_sub(ledger.held);
    if delta == 0 {
        return Ok(0);
    }
    // Subrogation: a safety pool that paid the lender for this loan takes the receipts in the loan asset
    // first, up to what it paid, out of the credited part.
    let mut sub = if is_asset { read_subrogation(subrogation, slot.loan_ref)? } else { None };
    let sub_left = sub.as_ref().map_or(0, |s| s.owed.saturating_sub(s.paid));
    let split = split_receipt(slot.principal, slot.repaid, delta, is_asset, sub_left);
    // excess only exists once the room is full, so split.excess is everything waiting above `held` (a level)
    if split.credit == 0 {
        emit!(ExcessHeld { loan_ref: slot.loan_ref, asset: *mint.key, waiting: split.excess });
        return Ok(0);
    }
    let to_pool = split.to_pool;
    if to_pool > 0 {
        let s = sub.as_ref().unwrap();
        require_keys_eq!(*subrogation_to.key, s.to, LoanError::BadRecovery);
        let ok = !inbox_view.frozen
            && matches!(token::read_token_account(subrogation_to, tp), Some(v) if v.mint == *mint.key && v.owner == s.safety_config && !v.frozen);
        if !ok {
            return Ok(0);
        }
    }
    ledger.received = ledger.received.saturating_add(split.credit);
    slot.repaid = slot.repaid.saturating_add(split.credit);
    let decimals = token::mint_decimals(mint, tp)?;
    let loan_ref = slot.loan_ref.to_le_bytes();
    let bump = [slot.bump];
    let seeds: &[&[u8]] = &[SLOT_SEED, &loan_ref, &bump];
    let slot_info = slot.to_account_info();
    if to_pool > 0 {
        let s = sub.as_mut().unwrap();
        token::transfer_checked(token_program, inbox, mint, subrogation_to, &slot_info, to_pool, decimals, &[seeds])?;
        s.paid = s.paid.saturating_add(to_pool);
        {
            let mut data = subrogation.try_borrow_mut_data()?;
            s.try_serialize(&mut &mut data[..])?;
        }
        emit!(DripSubrogated { loan_ref: slot.loan_ref, asset: *mint.key, amount: to_pool, to: s.to, paid: s.paid, owed: s.owed });
    }
    let rest = split.to_lender;
    if rest > 0 {
        let lender = slot.lender;
        let deliverable = !inbox_view.frozen
            && matches!(token::read_token_account(lender_token, tp), Some(v) if v.owner == lender && v.mint == *mint.key && !v.frozen);
        if deliverable {
            token::transfer_checked(token_program, inbox, mint, lender_token, &slot_info, rest, decimals, &[seeds])?;
            emit!(DripRouted { loan_ref: slot.loan_ref, asset: *mint.key, amount: rest, lender, credited: true });
        } else {
            ledger.held = ledger.held.saturating_add(rest);
            emit!(DripEscrowed { loan_ref: slot.loan_ref, asset: *mint.key, amount: rest, credited: true });
        }
    }
    if split.excess > 0 {
        emit!(ExcessHeld { loan_ref: slot.loan_ref, asset: *mint.key, waiting: split.excess });
    }
    Ok(split.credit)
}

/// Closes an account this program owns: its lamports go to `to`, it is handed back to the system program, empty.
fn close_owned<'info>(info: &AccountInfo<'info>, to: &AccountInfo<'info>) -> Result<u64> {
    let lamports = info.lamports();
    to.add_lamports(lamports)?;
    **info.lamports.borrow_mut() = 0;
    info.assign(&anchor_lang::system_program::ID);
    info.resize(0)?;
    Ok(lamports)
}

/// Creates the PDA `target` (seeds `seeds`) as a `space`-byte account owned by this program, funded from `funder`,
/// an account this program owns (its lamports are moved directly). allocate + assign rather than create_account,
/// so lamports someone already sent to the address cannot block it. The lamports move only after both CPIs: a
/// CPI syncs just the accounts it names, and a debit/credit pair split across that boundary is an
/// UnbalancedInstruction. Returns the rent it took.
fn create_pda_from_owned<'info>(funder: &AccountInfo<'info>, target: &AccountInfo<'info>, space: usize, seeds: &[&[u8]]) -> Result<u64> {
    require!(target.owner == &anchor_lang::system_program::ID && target.data_is_empty(), LoanError::BadReceipt);
    let sp = anchor_lang::system_program::ID;
    anchor_lang::system_program::allocate(
        CpiContext::new_with_signer(sp, anchor_lang::system_program::Allocate { account_to_allocate: target.clone() }, &[seeds]),
        space as u64,
    )?;
    anchor_lang::system_program::assign(
        CpiContext::new_with_signer(sp, anchor_lang::system_program::Assign { account_to_assign: target.clone() }, &[seeds]),
        &crate::ID,
    )?;
    let rent = Rent::get()?.minimum_balance(space);
    let need = rent.saturating_sub(target.lamports());
    if need > 0 {
        funder.sub_lamports(need)?;
        target.add_lamports(need)?;
    }
    Ok(need)
}

/// Closes the empty inbox `inbox` of `slot` (rent to `to`), first harvesting any Token-2022 withheld transfer fee
/// to the mint (CloseAccount refuses an account with a withheld amount). A frozen inbox is left as it is (the token
/// program would refuse to close it; whatever it holds stays reachable through sweep_closed). Returns the rent.
#[allow(clippy::too_many_arguments)]
fn close_inbox<'info>(
    token_program: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    inbox: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    slot: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<u64> {
    let Some(v) = token::read_token_account(inbox, token_program.key) else { return Ok(0) };
    if v.frozen {
        return Ok(0);
    }
    require!(v.amount == 0, LoanError::InboxNotEmpty);
    if token::withheld_amount(inbox) > 0 {
        token::harvest_withheld_to_mint(token_program, mint, inbox)?;
    }
    let lamports = inbox.lamports();
    token::close_account(token_program, inbox, to, slot, &[seeds])?;
    Ok(lamports)
}

fn init_ledger(ledger: &mut Account<Ledger>, loan_ref: u64, mint: Pubkey, bump: u8) {
    if ledger.mint == Pubkey::default() {
        ledger.loan_ref = loan_ref;
        ledger.mint = mint;
        ledger.bump = bump;
    }
}

/// The lender-claim checks of StreamLoan.claim, on every stipend_pool buffer passed to the spend:
/// `isLenderClaim && lenderAddr == fieldOf(slot PDA) && loanRef == loan_ref`. Returns the sum of their
/// `lender_amount`s (every buffer counts, so a decoy buffer can only make the overpay check stricter).
fn check_claim_buffers(accounts: &[AccountInfo], slot: &Pubkey, loan_ref: u64) -> Result<u128> {
    let mut seen = false;
    let mut total = 0u128;
    for a in accounts {
        if *a.owner != pool::POOL_PROGRAM_ID {
            continue;
        }
        let Ok(payload) = pool::buffer_payload(a) else { continue };
        total = total.saturating_add(pool::check_lender_claim(&payload, slot, loan_ref)?);
        seen = true;
    }
    require!(seen, LoanError::NotAClaim);
    Ok(total)
}

/// What a claim may still take: principal - repaid - value already routed but not yet credited (inbox above
/// `held`) - the pool escrow of the slot (when passed). 0 once the loan is repaid.
pub fn claim_room(principal: u64, repaid: u64, pending_inbox: u64, escrowed: u64) -> u64 {
    principal.saturating_sub(repaid).saturating_sub(pending_inbox).saturating_sub(escrowed)
}

#[program]
pub mod stream_loan {
    use super::*;

    /// Creates the loan-ref counter. Only the program's upgrade authority (read from its ProgramData
    /// account); `init` makes a second call fail.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.next_loan_ref = 1;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Reserves the next loan ref for the signer. The borrower pledges to (fieldOf(slot PDA), loan_ref).
    pub fn open_slot(ctx: Context<OpenSlot>) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        let loan_ref = r.next_loan_ref;
        r.next_loan_ref = loan_ref.checked_add(1).ok_or(error!(LoanError::Overflow))?;
        let s = &mut ctx.accounts.slot;
        s.loan_ref = loan_ref;
        s.lender = ctx.accounts.lender.key();
        s.bump = ctx.bumps.slot;
        emit!(SlotOpened { loan_ref, lender: s.lender, slot: s.key() });
        Ok(())
    }

    /// Funds a slot against a stream proof staged in a stipend_pool buffer as (Proof, StreamArgs).
    /// The proof must name this slot PDA and loan ref, the loan asset and a stream that has started, and its
    /// `audience` must be fieldOf(payout_to): the borrower names the account the principal goes to. The
    /// principal must equal max_principal(min_remaining, pledge_bps) (the borrower's proof fixes the amount),
    /// and payout_to may not be the slot's inbox, the lender's source account, or an account the lender or the
    /// slot PDA owns. The pool verifies the proof (known root + Groth16) by CPI. The principal leaves the
    /// lender: principal - fee goes to `payout_to` and the origination fee (fee::origination_fee, rounds down)
    /// to the treasury's associated token account for the asset (no fee if that account is frozen). The loan
    /// owes the full principal. Creates the slot's inbox for the asset so routed shares can arrive; whatever
    /// already sits in it (shares routed before funding) is returned to `payout_to`, not counted as repayment.
    pub fn fund(ctx: Context<Fund>, loan_ref: u64, principal: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(!a.slot.funded, LoanError::AlreadyFunded);
        let tp = a.token_program.key;
        require!(token::is_token_program(tp), LoanError::BadTokenProgram);
        let args = pool::read_stream(&a.buffer)?;
        require!(args.lender == a.slot.key() && args.loan_ref == loan_ref, LoanError::WrongSlot);
        require_keys_eq!(args.asset, a.mint.key(), LoanError::WrongAsset);
        let t = now()?;
        require!(t >= 0 && args.stream_start <= t as u64, LoanError::StreamNotStarted);
        let payout = token::read_token_account(&a.payout_to, tp).ok_or(error!(LoanError::BadPayout))?;
        require_keys_eq!(payout.mint, a.mint.key(), LoanError::BadPayout);
        let slot_key = a.slot.key();
        require!(
            *a.payout_to.key != *a.lender_source.key
                && *a.payout_to.key != *a.inbox.key
                && payout.owner != a.lender.key()
                && payout.owner != slot_key,
            LoanError::BadPayout
        );
        require!(args.audience == pool::field_of(a.payout_to.key), LoanError::PayoutNotProven);
        let decimals = token::mint_decimals(&a.mint, tp)?;
        let mut fee = fee::origination_fee(principal).ok_or(error!(LoanError::Overflow))?;
        require_keys_eq!(a.treasury.key(), token::ata(&fee::TREASURY, a.mint.key, tp), LoanError::BadTreasury);
        if fee > 0 {
            let tr = token::read_token_account(&a.treasury, tp).ok_or(error!(LoanError::BadTreasury))?;
            require!(tr.owner == fee::TREASURY && tr.mint == a.mint.key(), LoanError::BadTreasury);
            // A frozen treasury account (the asset issuer froze it, or the mint creates accounts frozen) must
            // never block lending in that asset for everyone: the loan is funded without a fee instead.
            if tr.frozen {
                fee = 0;
            }
        }
        let to_payout = principal.checked_sub(fee).ok_or(error!(LoanError::Overflow))?;
        pool::verify_stream(&a.pool_program, &a.pool_state, &a.buffer)?;
        let min_remaining = be32_to_u128(&args.min_remaining)?;
        let min_rate = be32_to_u128(&args.min_rate)?;
        // The borrower's proof fixes the principal: exactly what the pledge backs. A smaller principal would
        // still capture the whole pledge (every routed share repays it), so the lender may not choose it.
        require!(principal > 0 && (principal as u128) == max_principal(min_remaining, args.pledge_bps), LoanError::PrincipalMismatch);

        require_keys_eq!(a.inbox.key(), token::ata(&slot_key, a.mint.key, tp), LoanError::BadInbox);
        // Shares escrowed in the pool for this slot before funding would later be credited as repayment
        // once pulled into the inbox; they must be pulled (and so returned, below) before the loan starts.
        require!(pool::escrowed(&a.escrow, a.mint.key, &slot_key, loan_ref, tp)? == 0, LoanError::EscrowNotEmpty);
        token::create_ata_idempotent(
            &a.ata_program, &a.lender.to_account_info(), &a.inbox, &a.slot.to_account_info(), &a.mint,
            &a.system_program.to_account_info(), &a.token_program,
        )?;
        token::transfer_checked(&a.token_program, &a.lender_source, &a.mint, &a.payout_to, &a.lender.to_account_info(), to_payout, decimals, &[])?;
        if fee > 0 {
            token::transfer_checked(&a.token_program, &a.lender_source, &a.mint, &a.treasury, &a.lender.to_account_info(), fee, decimals, &[])?;
        }
        // Shares routed to the slot before funding (sync never forwards them) repaid nothing: they go back
        // to the borrower's proven payout account now, so the lender cannot count them as repayment.
        let pre_fund = token::read_token_account(&a.inbox, tp).map(|v| v.amount).unwrap_or(0);
        if pre_fund > 0 {
            let lr = loan_ref.to_le_bytes();
            let bump = [a.slot.bump];
            let seeds: &[&[u8]] = &[SLOT_SEED, &lr, &bump];
            token::transfer_checked(&a.token_program, &a.inbox, &a.mint, &a.payout_to, &a.slot.to_account_info(), pre_fund, decimals, &[seeds])?;
            emit!(PreFundReturned { loan_ref, asset: a.mint.key(), amount: pre_fund, to: a.payout_to.key() });
        }
        let mint_key = a.mint.key();

        let ledger = &mut ctx.accounts.ledger;
        init_ledger(ledger, loan_ref, mint_key, ctx.bumps.ledger);
        reconcile_held(ledger, 0, loan_ref, mint_key);

        let s = &mut ctx.accounts.slot;
        s.funded = true;
        s.asset = ctx.accounts.mint.key();
        s.token_program = *tp;
        s.principal = principal;
        s.repaid = 0;
        s.min_remaining = min_remaining;
        s.min_rate = min_rate;
        s.pledge_bps = args.pledge_bps;
        s.expiry = args.expiry;
        s.agent_pk = args.agent_pk;
        s.funded_at = t;
        s.payout_to = ctx.accounts.payout_to.key();
        s.stream_start = args.stream_start;
        emit!(LoanFunded { loan_ref, lender: s.lender, asset: s.asset, principal, fee, payout_to: s.payout_to });
        Ok(())
    }

    /// Permissionless: credits the shares routed to the slot's inbox in `mint` since the last sync
    /// (as repayment when `mint` is the loan asset) and forwards them: to the safety pool first while a
    /// recorded slash is unrecovered (`subrogation` / `subrogation_to`), then to the slot lender's associated
    /// token account, or holds the lender's part when that account is missing or frozen.
    pub fn sync(ctx: Context<SyncInbox>, loan_ref: u64) -> Result<()> {
        let a = ctx.accounts;
        init_ledger(&mut a.ledger, loan_ref, a.mint.key(), ctx.bumps.ledger);
        sync_inbox(&mut a.slot, &mut a.ledger, &a.mint, &a.inbox, &a.lender_token, &a.token_program, &a.subrogation, &a.subrogation_to)?;
        Ok(())
    }

    /// Records that a safety pool paid the lender `amount` for this loan, so receipts go to the pool first
    /// (see the module docs). Only a safety_pool `SafetyConfig` PDA can sign it (safety.rs), by CPI from the
    /// pool's `slash`; `to` must be that pool's associated token account for the loan asset. One per loan:
    /// the account is created here, so a second record fails.
    pub fn record_slash(ctx: Context<RecordSlash>, loan_ref: u64, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.slot.funded, LoanError::NoLoan);
        require!(amount > 0, LoanError::BadSlashAmount);
        let safety_config = a.safety_config.key();
        safety::check_safety_config(&a.safety_config)?;
        let tp = a.slot.token_program;
        require_keys_eq!(a.to.key(), token::ata(&safety_config, &a.slot.asset, &tp), LoanError::BadRecovery);
        let to = token::read_token_account(&a.to, &tp).ok_or(error!(LoanError::BadRecovery))?;
        require!(to.mint == a.slot.asset && to.owner == safety_config, LoanError::BadRecovery);
        let s = &mut ctx.accounts.subrogation;
        s.loan_ref = loan_ref;
        s.safety_config = safety_config;
        s.to = ctx.accounts.to.key();
        s.owed = amount;
        s.paid = 0;
        s.bump = ctx.bumps.subrogation;
        emit!(SlashRecorded { loan_ref, asset: ctx.accounts.slot.asset, safety_config, to: s.to, amount });
        Ok(())
    }

    /// The slot's lender takes the shares held in the inbox for it, to a token account of its choice. On a loan
    /// over-repaid before the overpay cap, the held overage (loan asset, at most repaid - principal) is the borrower's:
    /// it stays held, and the next sync releases it to return_excess (state::collectable).
    pub fn collect(ctx: Context<Collect>, loan_ref: u64) -> Result<()> {
        let a = ctx.accounts;
        let tp = a.token_program.key;
        require!(token::is_token_program(tp), LoanError::BadTokenProgram);
        require_keys_eq!(a.inbox.key(), token::ata(&a.slot.key(), a.mint.key, tp), LoanError::BadInbox);
        let inbox_amount = token::read_token_account(&a.inbox, tp).map(|v| v.amount).unwrap_or(0);
        reconcile_held(&mut a.ledger, inbox_amount, loan_ref, a.mint.key());
        let amount = collectable(a.slot.principal, a.slot.repaid, a.ledger.held, a.mint.key() == a.slot.asset);
        require!(amount > 0, LoanError::NothingOwed);
        a.ledger.held -= amount;
        let decimals = token::mint_decimals(&a.mint, tp)?;
        let lr = loan_ref.to_le_bytes();
        let bump = [a.slot.bump];
        let seeds: &[&[u8]] = &[SLOT_SEED, &lr, &bump];
        let slot_info = a.slot.to_account_info();
        token::transfer_checked(&a.token_program, &a.inbox, &a.mint, &a.destination, &slot_info, amount, decimals, &[seeds])?;
        emit!(DripCollected { loan_ref, asset: a.mint.key(), amount, lender: a.slot.lender });
        Ok(())
    }

    /// The lender pulls its vested share: a lender-claim spend staged in a stipend_pool buffer,
    /// submitted to stipend_pool `spend` with the slot PDA as signer (the pool requires the signer's
    /// fieldOf == lenderAddr). `spend_data` is the pool instruction data (must be `spend`); the pool's
    /// spend accounts follow as remaining accounts, in the pool's order. The share lands in the inbox
    /// and is synced in the same instruction.
    /// Overpay cap: only in the loan asset, never once the loan is repaid (LoanRepaid), and never for more than
    /// it still owes, principal - repaid - unsynced inbox value - the slot's pool escrow when passed (ClaimTooLarge):
    /// the borrower's allowance stays private instead of passing through the inbox back to the borrower.
    pub fn claim<'info>(ctx: Context<'info, Claim<'info>>, loan_ref: u64, spend_data: Vec<u8>) -> Result<()> {
        let a = ctx.accounts;
        require!(a.slot.funded, LoanError::NoLoan);
        require_keys_eq!(a.mint.key(), a.slot.asset, LoanError::WrongAsset);
        require!(spend_data.len() >= 8 && spend_data[..8] == pool::sighash("global", "spend"), LoanError::NotAClaim);
        let slot_key = a.slot.key();
        let claimed = check_claim_buffers(ctx.remaining_accounts, &slot_key, loan_ref)?;
        init_ledger(&mut a.ledger, loan_ref, a.mint.key(), ctx.bumps.ledger);
        // the inbox address and token program are checked by the sync below (a wrong one fails the instruction)
        let tp = a.token_program.key;
        let held = a.ledger.held;
        let pending = token::read_token_account(&a.inbox, tp).map_or(0, |v| v.amount.saturating_sub(held));
        let escrow_key = pool::escrow_address(&a.slot.asset, &slot_key, loan_ref);
        let escrowed = ctx
            .remaining_accounts
            .iter()
            .find(|x| *x.key == escrow_key)
            .and_then(|x| token::read_token_account(x, tp))
            .filter(|v| v.mint == a.slot.asset)
            .map_or(0, |v| v.amount);
        require!(a.slot.repaid < a.slot.principal, LoanError::LoanRepaid);
        // not repaid, but value already on its way (unsynced inbox, escrow) may cover the rest: ClaimTooLarge, not LoanRepaid
        let room = claim_room(a.slot.principal, a.slot.repaid, pending, escrowed);
        require!(claimed <= room as u128, LoanError::ClaimTooLarge);
        {
            let lr = loan_ref.to_le_bytes();
            let bump = [a.slot.bump];
            let seeds: &[&[u8]] = &[SLOT_SEED, &lr, &bump];
            let slot_info = a.slot.to_account_info();
            pool::spend_as(&a.pool_program, ctx.remaining_accounts, spend_data, &slot_info, &[seeds])?;
        }
        sync_inbox(&mut a.slot, &mut a.ledger, &a.mint, &a.inbox, &a.lender_token, &a.token_program, &a.subrogation, &a.subrogation_to)?;
        Ok(())
    }

    /// The lender closes the loan; no shortfall can be reported afterwards.
    pub fn settle(ctx: Context<Settle>, loan_ref: u64) -> Result<()> {
        require!(ctx.accounts.slot.funded, LoanError::NoLoan);
        ctx.accounts.slot.settled = true;
        emit!(LoanSettled { loan_ref });
        Ok(())
    }

    /// The slot's lender closes the slot of a finished loan and takes its rent back. Allowed when the loan is
    /// settled, or was never funded (an unfunded slot holds nothing the lender may take: shares routed to it stay
    /// where they are, as before). For a settled loan:
    /// - safety_pool must hold no open cover of the loan (its release_cover reads the slot; anyone can release
    ///   the cover of a settled loan first);
    /// - no recorded slash may be unrecovered (Subrogation paid < owed) while the loan is not repaid; once it is,
    ///   the pool can be credited nothing more, so it never locks the close;
    /// - nothing may be held for the lender (collect first); while repaid < principal the loan asset's inbox must be
    ///   empty (sync first; a frozen inbox is left as it is). Once repaid, the inbox may still hold borrower excess:
    ///   it then stays open for return_excess. An empty inbox has its withheld Token-2022 transfer fee, if any,
    ///   harvested to the mint and is closed to the lender;
    /// - the loan asset's Ledger is closed to the lender (Ledgers of other mints, made by permissionless syncs, stay);
    /// - a ClosedSlot receipt ["closed", loan_ref] is created out of the slot's own lamports: the final figures and
    ///   the lender, for `sweep_closed`, and (v2, 130 bytes) the borrower's payout account, for `return_excess`.
    /// The Slot is closed to the lender. The loan ref is never reused: open_slot only creates the slot of the
    /// registry's next ref, and every other instruction needs the Slot account.
    pub fn close_slot(ctx: Context<CloseSlot>, loan_ref: u64) -> Result<()> {
        let a = &ctx.accounts;
        let s = &a.slot;
        let slot_info = s.to_account_info();
        let lender_info = a.lender.to_account_info();
        let mut refunded = 0u64;
        if s.funded {
            require!(s.settled, LoanError::NotSettled);
            require!(!safety::cover_open(&a.cover, loan_ref)?, LoanError::CoverOpen);
            // a slashed loan stays open until the safety pool has recovered what it paid: after the close,
            // sweep_closed pays the lender only, which would bypass the subrogation. A repaid loan has no room left
            // for anyone, so it never waits on the pool.
            if let Some(sub) = read_subrogation(&a.subrogation, loan_ref)? {
                require!(!subrogation_blocks_close(sub.paid, sub.owed, s.principal, s.repaid), LoanError::SubrogationOpen);
            }
            let tp = s.token_program;
            require_keys_eq!(a.token_program.key(), tp, LoanError::BadTokenProgram);
            require_keys_eq!(a.mint.key(), s.asset, LoanError::BadMint);
            require_keys_eq!(a.inbox.key(), token::ata(&slot_info.key(), &s.asset, &tp), LoanError::BadInbox);
            let lr = loan_ref.to_le_bytes();
            let (ledger_key, _) = Pubkey::find_program_address(&[LEDGER_SEED, &lr, s.asset.as_ref()], &crate::ID);
            require_keys_eq!(a.ledger.key(), ledger_key, LoanError::BadInbox);
            let held = if a.ledger.owner == &crate::ID && !a.ledger.data_is_empty() {
                let data = a.ledger.try_borrow_data()?;
                Ledger::try_deserialize(&mut &data[..])?.held
            } else {
                0
            };
            require!(held == 0, LoanError::InboxNotEmpty);
            let inbox = token::read_token_account(&a.inbox, &tp);
            let in_inbox = inbox.map_or(0, |v| v.amount);
            // below the principal, whatever waits in the inbox is unsynced repayment: sync it first
            require!(in_inbox == 0 || s.repaid >= s.principal || inbox.is_some_and(|v| v.frozen), LoanError::InboxNotEmpty);
            let bump = [s.bump];
            let seeds: &[&[u8]] = &[SLOT_SEED, &lr, &bump];
            // order matters: every CPI comes before any direct lamport move (a CPI syncs only the accounts it names)
            if in_inbox == 0 {
                refunded = refunded.saturating_add(close_inbox(&a.token_program, &a.mint, &a.inbox, &lender_info, &slot_info, seeds)?);
            }
            let cbump = [ctx.bumps.closed];
            let cseeds: &[&[u8]] = &[CLOSED_SEED, &lr, &cbump];
            create_pda_from_owned(&slot_info, &a.closed, CLOSED_V2_SIZE, cseeds)?;
            let receipt = ClosedSlot {
                loan_ref, lender: s.lender, asset: s.asset, principal: s.principal, repaid: s.repaid, slot_bump: s.bump, bump: ctx.bumps.closed,
            };
            {
                let mut data = a.closed.try_borrow_mut_data()?;
                receipt.try_serialize(&mut &mut data[..])?;
                data[CLOSED_PAYOUT_OFFSET..CLOSED_V2_SIZE].copy_from_slice(s.payout_to.as_ref());
            }
            if a.ledger.owner == &crate::ID && !a.ledger.data_is_empty() {
                refunded = refunded.saturating_add(close_owned(&a.ledger, &lender_info)?);
            }
        }
        // the slot's remaining lamports go to the lender when Anchor closes it (close = lender)
        refunded = refunded.saturating_add(slot_info.lamports());
        emit!(SlotClosed {
            loan_ref, lender: s.lender, lamports_refunded: refunded, funded: s.funded, asset: s.asset, principal: s.principal, repaid: s.repaid,
            agent_pk: s.agent_pk, expiry: s.expiry,
        });
        Ok(())
    }

    /// The lender of a closed (funded) slot takes what reached the slot's inbox in `mint` after the close (a
    /// pledge keeps routing its share to the loan; the pool escrows it when the inbox is missing, and anyone may
    /// pull_lender_share it into a re-created inbox) to a token account of its choice, up to what the loan still
    /// owes (principal - receipt.repaid, in the loan asset only; the receipt's `repaid` grows by it, so the receipt
    /// must then be writable: ReceiptNotWritable). The rest is the borrower's (return_excess). An empty inbox is
    /// closed to the lender. Fails with NothingOwed when it neither pays nor closes anything. The slot PDA signs,
    /// with the bump kept in the ClosedSlot receipt.
    /// Optional first remaining account (writable): the Ledger PDA ["ledger", loan_ref, mint]. What it still holds for
    /// the lender (shares in another mint held before the overpay cap, whose Ledger close_slot leaves open) is paid
    /// first, outside the room and without touching the receipt, and the Ledger is closed to the lender. Callers that
    /// leave it out get the room only, as before.
    pub fn sweep_closed<'info>(ctx: Context<'info, SweepClosed<'info>>, loan_ref: u64) -> Result<()> {
        let a = &ctx.accounts;
        let tp = a.token_program.key;
        require!(token::is_token_program(tp), LoanError::BadTokenProgram);
        // the receipt exists only for a closed slot, and a slot is never re-created; checked anyway
        require!(a.slot.owner == &anchor_lang::system_program::ID && a.slot.data_is_empty(), LoanError::BadReceipt);
        require_keys_eq!(a.inbox.key(), token::ata(a.slot.key, a.mint.key, tp), LoanError::BadInbox);
        let v = token::read_token_account(&a.inbox, tp).ok_or(error!(LoanError::NothingOwed))?;
        require_keys_eq!(v.mint, a.mint.key(), LoanError::BadInbox);
        let lr = loan_ref.to_le_bytes();
        let ledger = match ctx.remaining_accounts.first() {
            Some(l) if l.owner == &crate::ID && !l.data_is_empty() => {
                let held = {
                    let data = l.try_borrow_data()?;
                    let led = Ledger::try_deserialize(&mut &data[..])?;
                    let expect = Pubkey::create_program_address(&[LEDGER_SEED, &lr, a.mint.key.as_ref(), &[led.bump]], &crate::ID)
                        .map_err(|_| error!(LoanError::BadInbox))?;
                    require_keys_eq!(*l.key, expect, LoanError::BadInbox);
                    led.held
                };
                Some((l, held))
            }
            _ => None,
        };
        let bump = [a.closed.slot_bump];
        let seeds: &[&[u8]] = &[SLOT_SEED, &lr, &bump];
        let slot_info = a.slot.to_account_info();
        let room = closed_room(a.closed.principal, a.closed.repaid, a.mint.key() == a.closed.asset);
        let (from_held, from_room) = sweep_split(v.amount, ledger.map_or(0, |(_, h)| h), room);
        let amount = from_held + from_room;
        if amount > 0 {
            let decimals = token::mint_decimals(&a.mint, tp)?;
            token::transfer_checked(&a.token_program, &a.inbox, &a.mint, &a.destination, &slot_info, amount, decimals, &[seeds])?;
            emit!(ClosedSlotSwept { loan_ref, asset: a.mint.key(), amount, lender: a.closed.lender });
        }
        if from_room > 0 {
            let closed_info = a.closed.to_account_info();
            require!(closed_info.is_writable, LoanError::ReceiptNotWritable);
            let mut receipt: ClosedSlot = (*a.closed).clone();
            receipt.repaid = receipt.repaid.saturating_add(from_room);
            // the 98-byte struct only: a v2 receipt's trailing payout_to is left as it is
            let mut data = closed_info.try_borrow_mut_data()?;
            receipt.try_serialize(&mut &mut data[..])?;
        }
        let mut inbox_closed = false;
        if v.amount == amount {
            inbox_closed = close_inbox(&a.token_program, &a.mint, &a.inbox, &a.lender.to_account_info(), &slot_info, seeds)? > 0;
        }
        // after every CPI (a direct lamport move must not straddle one): nothing is held any more (what the inbox lacked
        // was taken by a permanent delegate), so the Ledger is closed to the lender
        let mut ledger_closed = false;
        if let Some((l, _)) = ledger {
            close_owned(l, &a.lender.to_account_info())?;
            ledger_closed = true;
        }
        require!(amount > 0 || inbox_closed || ledger_closed, LoanError::NothingOwed);
        Ok(())
    }

    /// Permissionless: sends the borrower's excess in the slot's inbox for `mint` (overpay cap) to the borrower:
    /// everything above `held` and above what the loan may still credit (principal - repaid in the loan asset; 0 in
    /// any other mint). Works for an open funded slot (figures from the Slot) and for a closed one (figures and
    /// payout from a v2 ClosedSlot receipt; an older receipt records no payout: LegacyReceiptNoPayout).
    /// The loan asset goes to `payout_to` itself, another mint to the associated token account of payout_to's owner.
    /// When that owner signs (first remaining account), `destination` may be any token account of `mint` (a frozen,
    /// closed or memo-required payout account; a closed one's owner is recognised when payout_to was its associated
    /// token account of the loan asset). Fails with PayoutCannotReceive while the inbox or destination is
    /// frozen or not a token account of `mint`: the excess then keeps waiting.
    pub fn return_excess<'info>(ctx: Context<'info, ReturnExcess<'info>>, loan_ref: u64) -> Result<()> {
        let a = &ctx.accounts;
        let tp = a.token_program.key;
        require!(token::is_token_program(tp), LoanError::BadTokenProgram);
        let mint = a.mint.key();
        let (principal, repaid, asset, payout_to) = if a.slot.owner == &crate::ID && !a.slot.data_is_empty() {
            let data = a.slot.try_borrow_data()?;
            let s = Slot::try_deserialize(&mut &data[..])?;
            require!(s.funded, LoanError::NoLoan);
            (s.principal, s.repaid, s.asset, s.payout_to)
        } else {
            require!(a.slot.data_is_empty() && a.closed.owner == &crate::ID, LoanError::BadReceipt);
            let data = a.closed.try_borrow_data()?;
            let c = ClosedSlot::try_deserialize(&mut &data[..])?;
            let p = closed_payout(&data).ok_or(error!(LoanError::LegacyReceiptNoPayout))?;
            (c.principal, c.repaid, c.asset, p)
        };
        let held = if a.ledger.owner == &crate::ID && !a.ledger.data_is_empty() {
            let data = a.ledger.try_borrow_data()?;
            Ledger::try_deserialize(&mut &data[..])?.held
        } else {
            0
        };
        require_keys_eq!(a.inbox.key(), token::ata(a.slot.key, &mint, tp), LoanError::BadInbox);
        let v = token::read_token_account(&a.inbox, tp).ok_or(error!(LoanError::NoExcess))?;
        require_keys_eq!(v.mint, mint, LoanError::BadInbox);
        let is_asset = mint == asset;
        let excess = v.amount.saturating_sub(held).saturating_sub(closed_room(principal, repaid, is_asset));
        require!(excess > 0, LoanError::NoExcess);

        require_keys_eq!(a.payout_to.key(), payout_to, LoanError::BadPayout);
        let payout_owner = if token::is_token_program(a.payout_to.owner) {
            token::read_token_account(&a.payout_to, a.payout_to.owner).map(|p| p.owner)
        } else {
            None
        };
        // the payout account's owner: read from it, or, once it is closed, proven by a signer whose associated token
        // account of the loan asset (either token program) it was. A closed non-associated payout account can only be
        // re-created at its address by whoever holds its keypair.
        let by_owner = match ctx.remaining_accounts.first() {
            Some(s) if s.is_signer => match payout_owner {
                Some(o) => *s.key == o,
                None => [token::SPL_TOKEN_ID, token::TOKEN_2022_ID].iter().any(|p| token::ata(s.key, &asset, p) == payout_to),
            },
            _ => false,
        };
        if !by_owner {
            let expect = if is_asset {
                payout_to
            } else {
                token::ata(&payout_owner.ok_or(error!(LoanError::PayoutCannotReceive))?, &mint, tp)
            };
            require_keys_eq!(a.destination.key(), expect, LoanError::BadPayout);
        }
        let deliverable =
            !v.frozen && matches!(token::read_token_account(&a.destination, tp), Some(d) if d.mint == mint && !d.frozen);
        require!(deliverable, LoanError::PayoutCannotReceive);
        let decimals = token::mint_decimals(&a.mint, tp)?;
        let lr = loan_ref.to_le_bytes();
        let bump = [ctx.bumps.slot];
        let seeds: &[&[u8]] = &[SLOT_SEED, &lr, &bump];
        token::transfer_checked(&a.token_program, &a.inbox, &a.mint, &a.destination, &a.slot.to_account_info(), excess, decimals, &[seeds])?;
        emit!(ExcessReturned { loan_ref, asset: mint, amount: excess, to: a.destination.key(), by_owner });
        Ok(())
    }

    /// View (use simulateTransaction): unpaid principal once expiry + GRACE has passed, 0 otherwise,
    /// 0 when expiry == 0. Routed shares still unsynced in the inbox, and shares the pool holds in its
    /// escrow for (fieldOf(slot), loan_ref) in the loan asset, count as paid. Return data: u64 LE.
    pub fn shortfall(ctx: Context<Shortfall>, loan_ref: u64) -> Result<()> {
        let s = &ctx.accounts.slot;
        let mut pending = 0u64;
        if s.funded {
            pending = pool::escrowed(&ctx.accounts.escrow, &s.asset, &s.key(), loan_ref, &s.token_program)?;
            let inbox = &ctx.accounts.inbox;
            require_keys_eq!(inbox.key(), token::ata(&s.key(), &s.asset, &s.token_program), LoanError::BadInbox);
            if let Some(v) = token::read_token_account(inbox, &s.token_program) {
                let ledger = &ctx.accounts.ledger;
                let (expect, _) = Pubkey::find_program_address(&[LEDGER_SEED, &loan_ref.to_le_bytes(), s.asset.as_ref()], &crate::ID);
                require_keys_eq!(ledger.key(), expect, LoanError::BadInbox);
                let held = if ledger.owner == &crate::ID && ledger.data_len() > 0 {
                    let data = ledger.try_borrow_data()?;
                    Ledger::try_deserialize(&mut &data[..])?.held
                } else {
                    0
                };
                pending = pending.saturating_add(v.amount.saturating_sub(held));
            }
        }
        let out = shortfall_of(s, now()?, pending);
        set_return_data(&out.to_le_bytes());
        msg!("shortfall {}", out);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + Registry::INIT_SPACE, seeds = [REGISTRY_SEED], bump)]
    pub registry: Account<'info, Registry>,
    /// Must be the program's upgrade authority.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: this program's ProgramData account (PDA [program id] of the BPF upgradeable loader); its
    /// upgrade authority must be the payer (parsed by upgrade_authority).
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = upgrade_authority(&program_data)? == Some(payer.key()) @ LoanError::UpgradeAuthority
    )]
    pub program_data: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OpenSlot<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, Registry>,
    #[account(
        init,
        payer = lender,
        space = 8 + Slot::INIT_SPACE,
        seeds = [SLOT_SEED, &registry.next_loan_ref.to_le_bytes()],
        bump
    )]
    pub slot: Account<'info, Slot>,
    #[account(mut)]
    pub lender: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct Fund<'info> {
    #[account(mut, seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump, has_one = lender @ LoanError::NotTheLender)]
    pub slot: Account<'info, Slot>,
    #[account(mut)]
    pub lender: Signer<'info>,
    /// CHECK: must be stipend_pool (checked before the CPI)
    pub pool_program: UncheckedAccount<'info>,
    /// CHECK: stipend_pool's Pool PDA; the pool checks its seeds in verify_stream
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK: stipend_pool Buffer holding (Proof, StreamArgs); owner and discriminator checked
    pub buffer: UncheckedAccount<'info>,
    /// CHECK: the loan asset; owner (token program) and initialization checked
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the lender's token account the principal is paid from (the token program checks it)
    #[account(mut)]
    pub lender_source: UncheckedAccount<'info>,
    /// CHECK: token account of the loan asset that receives the principal (checked)
    #[account(mut)]
    pub payout_to: UncheckedAccount<'info>,
    /// CHECK: the slot PDA's associated token account for the asset (address checked; created here)
    #[account(mut)]
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 (checked)
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: associated token account program (address checked)
    #[account(address = token::ATA_PROGRAM_ID)]
    pub ata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// Inbox accounting for the loan asset; what is in the inbox before funding is held here.
    #[account(
        init_if_needed,
        payer = lender,
        space = 8 + Ledger::INIT_SPACE,
        seeds = [LEDGER_SEED, &loan_ref.to_le_bytes(), mint.key().as_ref()],
        bump
    )]
    pub ledger: Account<'info, Ledger>,
    /// CHECK: stipend_pool escrow ["owed", mint, fieldOf(slot), loan_ref] (address checked; may not exist; must be empty)
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: fee::TREASURY's associated token account for the loan asset (address checked; owner and
    /// mint checked when a fee is due; may not exist when the fee rounds to 0; if frozen, no fee is taken)
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct SyncInbox<'info> {
    #[account(mut, seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump)]
    pub slot: Account<'info, Slot>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Ledger::INIT_SPACE,
        seeds = [LEDGER_SEED, &loan_ref.to_le_bytes(), mint.key().as_ref()],
        bump
    )]
    pub ledger: Account<'info, Ledger>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the mint whose inbox is synced (checked against the inbox)
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the slot PDA's associated token account for `mint` (address checked)
    #[account(mut)]
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: the slot lender's associated token account for `mint` (address checked; may not exist)
    #[account(mut)]
    pub lender_token: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 (checked)
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the loan's Subrogation PDA ["subrogation", loan_ref] (address checked; may not exist: no slash)
    #[account(mut)]
    pub subrogation: UncheckedAccount<'info>,
    /// CHECK: the subrogation's `to` account (checked when a recorded slash is still unrecovered; any account otherwise)
    #[account(mut)]
    pub subrogation_to: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct RecordSlash<'info> {
    #[account(seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump)]
    pub slot: Account<'info, Slot>,
    #[account(init, payer = payer, space = 8 + Subrogation::INIT_SPACE, seeds = [SUBROGATION_SEED, &loan_ref.to_le_bytes()], bump)]
    pub subrogation: Account<'info, Subrogation>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: a signing safety_pool SafetyConfig PDA ["safety", mint] of a known safety_pool program (safety.rs)
    pub safety_config: Signer<'info>,
    /// CHECK: the safety pool's associated token account for the loan asset (address, mint and owner checked)
    pub to: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct Collect<'info> {
    #[account(seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump, has_one = lender @ LoanError::NotTheLender)]
    pub slot: Account<'info, Slot>,
    #[account(mut, seeds = [LEDGER_SEED, &loan_ref.to_le_bytes(), mint.key().as_ref()], bump = ledger.bump)]
    pub ledger: Account<'info, Ledger>,
    pub lender: Signer<'info>,
    /// CHECK: checked by the token program (transfer_checked) and the inbox address
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the slot PDA's associated token account for `mint` (address checked)
    #[account(mut)]
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: any token account the lender chooses
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 (checked)
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct Claim<'info> {
    #[account(mut, seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump, has_one = lender @ LoanError::NotTheLender)]
    pub slot: Account<'info, Slot>,
    #[account(
        init_if_needed,
        payer = lender,
        space = 8 + Ledger::INIT_SPACE,
        seeds = [LEDGER_SEED, &loan_ref.to_le_bytes(), mint.key().as_ref()],
        bump
    )]
    pub ledger: Account<'info, Ledger>,
    #[account(mut)]
    pub lender: Signer<'info>,
    /// CHECK: must be stipend_pool (checked before the CPI)
    pub pool_program: UncheckedAccount<'info>,
    /// CHECK: the claimed asset (checked against the inbox)
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the slot PDA's associated token account for `mint` (address checked)
    #[account(mut)]
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: the slot lender's associated token account for `mint` (address checked; may not exist)
    #[account(mut)]
    pub lender_token: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 (checked)
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the loan's Subrogation PDA ["subrogation", loan_ref] (address checked; may not exist: no slash)
    #[account(mut)]
    pub subrogation: UncheckedAccount<'info>,
    /// CHECK: the subrogation's `to` account (checked when a recorded slash is still unrecovered; any account otherwise)
    #[account(mut)]
    pub subrogation_to: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct Settle<'info> {
    #[account(mut, seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump, has_one = lender @ LoanError::NotTheLender)]
    pub slot: Account<'info, Slot>,
    pub lender: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct CloseSlot<'info> {
    #[account(
        mut,
        seeds = [SLOT_SEED, &loan_ref.to_le_bytes()],
        bump = slot.bump,
        has_one = lender @ LoanError::NotTheLender,
        close = lender
    )]
    pub slot: Account<'info, Slot>,
    /// The slot's lender: signs and receives every refund.
    #[account(mut)]
    pub lender: Signer<'info>,
    /// CHECK: the Ledger PDA of the loan asset (address checked when funded; closed to the lender)
    #[account(mut)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: the loan asset (checked when funded); writable for a Token-2022 withheld-fee harvest
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the slot PDA's associated token account for the loan asset (address checked when funded; must be empty)
    #[account(mut)]
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: the loan's token program (checked against the slot when funded)
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: safety_pool Cover PDA ["cover", loan_ref] (address checked when funded; may not exist; must not be open)
    pub cover: UncheckedAccount<'info>,
    /// CHECK: ClosedSlot receipt PDA ["closed", loan_ref]; created here for a funded loan
    #[account(mut, seeds = [CLOSED_SEED, &loan_ref.to_le_bytes()], bump)]
    pub closed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the loan's Subrogation PDA ["subrogation", loan_ref] (address checked when funded; may not exist; must be recovered)
    pub subrogation: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct SweepClosed<'info> {
    #[account(seeds = [CLOSED_SEED, &loan_ref.to_le_bytes()], bump = closed.bump, has_one = lender @ LoanError::NotTheLender)]
    pub closed: Account<'info, ClosedSlot>,
    #[account(mut)]
    pub lender: Signer<'info>,
    /// CHECK: the closed slot PDA ["slot", loan_ref] (seeds checked; must be empty); signs for its inbox
    #[account(seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = closed.slot_bump)]
    pub slot: UncheckedAccount<'info>,
    /// CHECK: the swept asset (checked against the inbox); writable for a Token-2022 withheld-fee harvest
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the slot PDA's associated token account for `mint` (address checked)
    #[account(mut)]
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: any token account the lender chooses (the token program checks it)
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 (checked)
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct ReturnExcess<'info> {
    /// CHECK: the slot PDA ["slot", loan_ref] (seeds checked): a funded Slot, or empty once closed; signs for its inbox
    #[account(seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump)]
    pub slot: UncheckedAccount<'info>,
    /// CHECK: the receipt PDA ["closed", loan_ref] (seeds checked; read only when the slot is closed; may not exist)
    #[account(seeds = [CLOSED_SEED, &loan_ref.to_le_bytes()], bump)]
    pub closed: UncheckedAccount<'info>,
    /// CHECK: the Ledger PDA ["ledger", loan_ref, mint] (seeds checked; may not exist: nothing held)
    #[account(seeds = [LEDGER_SEED, &loan_ref.to_le_bytes(), mint.key().as_ref()], bump)]
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: the inbox's mint (checked against the inbox; owner checked by mint_decimals)
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the slot PDA's associated token account for `mint` (address checked)
    #[account(mut)]
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: must be the loan's recorded payout account (the Slot's, or a v2 receipt's)
    pub payout_to: UncheckedAccount<'info>,
    /// CHECK: payout_to (loan asset), the ATA of payout_to's owner (other mints), or any token account of `mint`
    /// when that owner signs (checked)
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 (checked; the mint's owner)
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct Shortfall<'info> {
    #[account(seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump)]
    pub slot: Account<'info, Slot>,
    /// CHECK: the slot's inbox for the loan asset (address checked when funded; may not exist)
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: the ledger PDA for the loan asset (address checked; may not exist)
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: stipend_pool escrow ["owed", asset, fieldOf(slot), loan_ref] (address checked when funded; may not exist)
    pub escrow: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn principal_is_capped_by_what_the_pledge_repays() {
        assert_eq!(max_principal(1_000_000_000, 4_000), 400_000_000);
        assert_eq!(max_principal(10, 2_500), 2);
        assert_eq!(max_principal(0, 10_000), 0);
        assert_eq!(max_principal(u128::MAX, 10_000), u128::MAX / 10_000);
    }

    #[test]
    fn localnet_ids_are_the_test_keys() {
        assert_eq!(pool::LOCALNET_POOL_PROGRAM_ID.to_string(), "AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3");
        assert_eq!(pool::MAINNET_POOL_PROGRAM_ID.to_string(), "E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM");
        assert_eq!(safety::LOCALNET_SAFETY_PROGRAM_ID.to_string(), "EvKjwxVQX1RhyoBXisdbzk1JGLb5fMgZzHVLQAiPKJwe");
        assert_eq!(safety::LOCALNET_SAFETY_FAST_PROGRAM_ID.to_string(), "5K2L3eNBzmeznEZpY4vav74UHRaBHgQJv582W5i4kT7");
        assert_eq!(safety::MAINNET_SAFETY_PROGRAM_ID.to_string(), "HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt");
    }

    #[test]
    fn error_codes_never_shift() {
        // the TS LOAN_ERROR map and every published client depend on these ordinals (6000 + index)
        assert_eq!(LoanError::NotTheLender as u32, 0);
        assert_eq!(LoanError::WrongAsset as u32, 3);
        assert_eq!(LoanError::NothingOwed as u32, 7);
        assert_eq!(LoanError::InboxNotEmpty as u32, 29);
        assert_eq!(LoanError::SubrogationOpen as u32, 33);
        assert_eq!(LoanError::LoanRepaid as u32, 34);
        assert_eq!(LoanError::ClaimTooLarge as u32, 35);
        assert_eq!(LoanError::NoExcess as u32, 36);
        assert_eq!(LoanError::PayoutCannotReceive as u32, 37);
        assert_eq!(LoanError::LegacyReceiptNoPayout as u32, 38);
        assert_eq!(LoanError::ReceiptNotWritable as u32, 39);
    }

    #[test]
    fn claim_room_subtracts_what_is_already_on_its_way() {
        assert_eq!(claim_room(20, 0, 0, 0), 20);
        assert_eq!(claim_room(20, 5, 3, 2), 10);
        assert_eq!(claim_room(20, 20, 0, 0), 0);
        assert_eq!(claim_room(20, 35, 0, 0), 0);
        assert_eq!(claim_room(20, 5, 30, 0), 0);
        assert_eq!(claim_room(u64::MAX, 0, u64::MAX, u64::MAX), 0);
    }

    /// A stipend_pool Buffer account holding a staged lender claim (header, then (Proof, SpendArgs)).
    fn claim_buffer(slot: &Pubkey, loan_ref: u64, lender_amount: u128) -> Vec<u8> {
        let args = pool::SpendArgs {
            root: [0; 32], nullifier: [0; 32], new_allowance_commitment: [0; 32], pay_commitment: [0; 32], public_amount: 0,
            public_recipient: Pubkey::default(), public_asset: Pubkey::default(), fee: 0, timestamp: 0, receipt: [0; 32], lender_amount,
            lender_addr: pool::field_of(slot), loan_ref, is_lender_claim: true, ext_data_hash: [0; 32],
        };
        let mut payload = vec![0u8; 256];
        args.serialize(&mut payload).unwrap();
        let mut d = pool::sighash("account", "Buffer").to_vec();
        d.extend_from_slice(&[0u8; 32 + 8]);
        d.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        d.push(255);
        d.extend_from_slice(&payload);
        d
    }

    #[test]
    fn check_claim_buffers_sums_every_claim_buffer() {
        let slot = Pubkey::new_from_array([5; 32]);
        let owner = pool::POOL_PROGRAM_ID;
        let (k1, k2, k3) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let (mut d1, mut d2, mut d3) = (claim_buffer(&slot, 9, 12), claim_buffer(&slot, 9, 30), vec![1u8; 10]);
        let (mut l1, mut l2, mut l3) = (0u64, 0u64, 0u64);
        let other = Pubkey::default();
        let a1 = AccountInfo::new(&k1, false, false, &mut l1, &mut d1, &owner, false);
        let a2 = AccountInfo::new(&k2, false, false, &mut l2, &mut d2, &owner, false);
        // not a pool account: skipped
        let a3 = AccountInfo::new(&k3, false, false, &mut l3, &mut d3, &other, false);
        assert_eq!(check_claim_buffers(&[a1.clone(), a3.clone(), a2.clone()], &slot, 9).unwrap(), 42);
        assert_eq!(check_claim_buffers(&[a1.clone()], &slot, 9).unwrap(), 12);
        // a claim for another loan ref, or no claim at all, is refused
        assert!(check_claim_buffers(&[a1.clone(), a2.clone()], &slot, 8).is_err());
        assert!(check_claim_buffers(&[a3], &slot, 9).is_err());
    }

    #[test]
    fn principal_must_match_the_proof_exactly() {
        // the SDK's minRemainingFor(amount, bps) = ceil(amount * 10,000 / bps) makes max_principal == amount
        for (amount, bps) in [(1u128, 1u16), (399, 4_000), (300_000_000, 4_000), (7, 10_000), (123_456_789, 33)] {
            let min_remaining = (amount * 10_000).div_ceil(bps as u128);
            assert_eq!(max_principal(min_remaining, bps), amount);
        }
    }
}
