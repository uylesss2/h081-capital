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
use state::{shortfall_of, Ledger, Registry, Slot, Subrogation, LEDGER_SEED, REGISTRY_SEED, SLOT_SEED, SUBROGATION_SEED};
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
    let delta = inbox_view.amount.saturating_sub(ledger.held);
    if delta == 0 {
        return Ok(0);
    }
    let credited = slot.funded && slot.asset == *mint.key;
    // Subrogation: a safety pool that paid the lender for this loan takes the receipts in the loan asset
    // first, up to what it paid.
    let mut sub = if credited { read_subrogation(subrogation, slot.loan_ref)? } else { None };
    let mut to_pool = 0u64;
    if let Some(s) = &sub {
        to_pool = delta.min(s.owed.saturating_sub(s.paid));
        if to_pool > 0 {
            require_keys_eq!(*subrogation_to.key, s.to, LoanError::BadRecovery);
            let ok = !inbox_view.frozen
                && matches!(token::read_token_account(subrogation_to, tp), Some(v) if v.mint == *mint.key && v.owner == s.safety_config && !v.frozen);
            if !ok {
                return Ok(0);
            }
        }
    }
    ledger.received = ledger.received.saturating_add(delta);
    if credited {
        slot.repaid = slot.repaid.saturating_add(delta);
    }
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
    let rest = delta - to_pool;
    if rest == 0 {
        return Ok(delta);
    }
    let lender = slot.lender;
    let deliverable = !inbox_view.frozen
        && matches!(token::read_token_account(lender_token, tp), Some(v) if v.owner == lender && v.mint == *mint.key && !v.frozen);
    if deliverable {
        token::transfer_checked(token_program, inbox, mint, lender_token, &slot_info, rest, decimals, &[seeds])?;
        emit!(DripRouted { loan_ref: slot.loan_ref, asset: *mint.key, amount: rest, lender, credited });
    } else {
        ledger.held = ledger.held.saturating_add(rest);
        emit!(DripEscrowed { loan_ref: slot.loan_ref, asset: *mint.key, amount: rest, credited });
    }
    Ok(delta)
}

fn init_ledger(ledger: &mut Account<Ledger>, loan_ref: u64, mint: Pubkey, bump: u8) {
    if ledger.mint == Pubkey::default() {
        ledger.loan_ref = loan_ref;
        ledger.mint = mint;
        ledger.bump = bump;
    }
}

/// The lender-claim checks of StreamLoan.claim, on every stipend_pool buffer passed to the spend:
/// `isLenderClaim && lenderAddr == fieldOf(slot PDA) && loanRef == loan_ref`.
fn check_claim_buffers(accounts: &[AccountInfo], slot: &Pubkey, loan_ref: u64) -> Result<()> {
    let mut seen = false;
    for a in accounts {
        if *a.owner != pool::POOL_PROGRAM_ID {
            continue;
        }
        let Ok(payload) = pool::buffer_payload(a) else { continue };
        pool::check_lender_claim(&payload, slot, loan_ref)?;
        seen = true;
    }
    require!(seen, LoanError::NotAClaim);
    Ok(())
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

    /// The slot's lender takes the shares held in the inbox for it, to a token account of its choice.
    pub fn collect(ctx: Context<Collect>, loan_ref: u64) -> Result<()> {
        let a = ctx.accounts;
        let tp = a.token_program.key;
        require!(token::is_token_program(tp), LoanError::BadTokenProgram);
        require_keys_eq!(a.inbox.key(), token::ata(&a.slot.key(), a.mint.key, tp), LoanError::BadInbox);
        let inbox_amount = token::read_token_account(&a.inbox, tp).map(|v| v.amount).unwrap_or(0);
        reconcile_held(&mut a.ledger, inbox_amount, loan_ref, a.mint.key());
        let amount = a.ledger.held;
        require!(amount > 0, LoanError::NothingOwed);
        a.ledger.held = 0;
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
    pub fn claim<'info>(ctx: Context<'info, Claim<'info>>, loan_ref: u64, spend_data: Vec<u8>) -> Result<()> {
        let a = ctx.accounts;
        require!(a.slot.funded, LoanError::NoLoan);
        require!(spend_data.len() >= 8 && spend_data[..8] == pool::sighash("global", "spend"), LoanError::NotAClaim);
        let slot_key = a.slot.key();
        check_claim_buffers(ctx.remaining_accounts, &slot_key, loan_ref)?;
        init_ledger(&mut a.ledger, loan_ref, a.mint.key(), ctx.bumps.ledger);
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
    fn principal_must_match_the_proof_exactly() {
        // the SDK's minRemainingFor(amount, bps) = ceil(amount * 10,000 / bps) makes max_principal == amount
        for (amount, bps) in [(1u128, 1u16), (399, 4_000), (300_000_000, 4_000), (7, 10_000), (123_456_789, 33)] {
            let min_remaining = (amount * 10_000).div_ceil(bps as u128);
            assert_eq!(max_principal(min_remaining, bps), amount);
        }
    }
}
