//! Backed lines (docs/BACKER-SPEC.md): a backer stakes the loan asset behind a borrower it chose (a per-line draw
//! key), so a borrower with no stream to pledge can borrow from any lender against that stake.
//!
//! Accounts (both new; Slot, Ledger, Subrogation, ClosedSlot and Registry are unchanged):
//! - `Backing` ["backing", backer, nonce u64 LE]: the line. Its stake is the balance of `vault`, the Backing PDA's
//!   associated token account for the asset (anyone may top it up). `reserved` is the part locked behind funded and
//!   requested draws; free = vault - reserved.
//! - `Draw` ["draw", backing, loan_ref u64 LE]: one request against one lender's open slot. Seeded by the backing, so a
//!   stranger's request on the same slot never blocks this one.
//!
//! Money flow, reusing the existing Subrogation and the unchanged `sync`:
//! - `fund_backed` funds the slot with principal = advance + backer_fee + lender_fee and creates the loan's Subrogation
//!   with safety_config = the Backing PDA, to = the vault, owed = backer_fee. `sync` already forwards receipts to `to`
//!   first while paid < owed, and checks only `to.owner == safety_config`, which the vault satisfies. So the backer's fee
//!   is paid first, the lender gets the rest, capped at the principal, by the code that runs today.
//! - `back_claim` (permissionless) pays a defaulted loan's lender shortfall out of the vault, up to the draw's reserve,
//!   and sets owed = paid + payout: the unpaid fee is forfeited, and later receipts first recover the payout.
//! - `back_release` frees a reserve and closes a Draw once nothing more can reach the vault through that loan.
//!   A Draw stays open (and the vault cannot be closed) while its Subrogation may still route receipts to the vault.
//!
//! Every limit is a compile-time constant (no admin key, no setter). A backed slot's `agent_pk` is all zeros: a backed
//! loan proves nothing about any agent and must never count for or against one (no proof binds a key at funding).
#![allow(clippy::too_many_arguments)]
use anchor_lang::prelude::*;
use anchor_lang::AccountsClose;

use crate::error::LoanError;
use crate::state::{shortfall_of, Ledger, Slot, Subrogation, GRACE, LEDGER_SEED, SLOT_SEED, SUBROGATION_SEED};
use crate::{fee, pool, token};

pub const BACKING_SEED: &[u8] = b"backing";
pub const DRAW_SEED: &[u8] = b"draw";

/// Lowest cover a line may promise its lenders. Mainnet: full cover only (v1); a line below 100% is an unsecured loan
/// to an anonymous party for the uncovered part, and a lender cannot see who the backer is. Localnet tests exercise
/// partial cover down to 20%.
#[cfg(feature = "mainnet")]
pub const MIN_COVER_BPS: u16 = 10_000;
#[cfg(not(feature = "mainnet"))]
pub const MIN_COVER_BPS: u16 = 2_000;
pub const MAX_COVER_BPS: u16 = 10_000;
pub const MAX_BACKER_FEE_BPS: u16 = 2_000;
pub const MAX_LENDER_FEE_BPS: u16 = 2_000;
/// Smallest advance (1 unit of a 6-decimal asset): no dust Draws or Subrogations.
pub const MIN_ADVANCE: u64 = 1_000_000;
/// Largest advance per draw (10,000 units of a 6-decimal asset).
pub const MAX_DRAW: u64 = 10_000_000_000;
pub const MAX_OPEN_DRAWS: u16 = 8;
/// Shortest loan term a request may ask for (a lender cannot fund a loan that is due at once).
#[cfg(not(feature = "fast"))]
pub const MIN_TERM: u64 = 86_400;
#[cfg(feature = "fast")]
pub const MIN_TERM: u64 = 1;
/// Longest line: back_open's expiry is at most this far ahead, and every backed loan must end by the line's expiry.
pub const MAX_LINE_TERM: u64 = 180 * 86_400;
/// Longest time a request waits for a lender (`fund_by` - now at request).
pub const MAX_REQUEST_TTL: u64 = 7 * 86_400;
/// After expiry + GRACE a defaulted loan's lender has this long to claim the cover before the backer may release it.
#[cfg(not(feature = "fast"))]
pub const CLAIM_WINDOW: u64 = 30 * 86_400;
#[cfg(feature = "fast")]
pub const CLAIM_WINDOW: u64 = 5;
/// After the claim window, an unrecovered fee or payout stops routing receipts to the vault after this long, so a
/// borrower that never repays cannot keep the lender's slot open for ever (anyone may then release the Draw).
#[cfg(not(feature = "fast"))]
pub const RECOVERY_HORIZON: u64 = 365 * 86_400;
#[cfg(feature = "fast")]
pub const RECOVERY_HORIZON: u64 = 5;

/// The assets a mainnet line may back: USDG only.
#[cfg(feature = "mainnet")]
pub const BACKED_ASSETS: &[Pubkey] = &[pubkey!("2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH")];

pub const DRAW_REQUESTED: u8 = 0;
pub const DRAW_FUNDED: u8 = 1;
pub const DRAW_CLAIMED: u8 = 2;
/// Reserve freed, but the loan's Subrogation may still route a fee or recovery to the vault.
pub const DRAW_RELEASED: u8 = 3;

/// A backed line. PDA ["backing", backer, nonce u64 LE].
#[account]
#[derive(InitSpace)]
pub struct Backing {
    pub backer: Pubkey,
    /// the one key allowed to request draws on this line
    pub draw_key: Pubkey,
    /// Pubkey::default() = any lender
    pub lender: Pubkey,
    pub asset: Pubkey,
    pub token_program: Pubkey,
    /// rent payer of the Backing and the vault: gets both back at back_close
    pub payer: Pubkey,
    pub nonce: u64,
    pub cover_bps: u16,
    pub fee_bps: u16,
    /// the line's end: every backed loan must be due by then
    pub expiry: u64,
    pub max_advance: u64,
    pub max_total: u64,
    /// sum of the advances of every draw funded on this line
    pub advanced_total: u64,
    pub reserved: u64,
    pub open_draws: u16,
    pub draws_total: u32,
    pub covered_out: u64,
    /// back_request also needs the backer's signature
    pub cosign: bool,
    pub created_at: i64,
    pub bump: u8,
}

/// One draw on a line, against one lender's slot. PDA ["draw", backing, loan_ref u64 LE].
#[account]
#[derive(InitSpace)]
pub struct Draw {
    pub loan_ref: u64,
    pub backing: Pubkey,
    /// rent payer of the Draw: gets it back when the Draw closes
    pub payer: Pubkey,
    pub payout_to: Pubkey,
    pub advance: u64,
    pub backer_fee: u64,
    pub lender_fee: u64,
    pub reserve: u64,
    /// loan term in seconds: the slot's expiry is funded_at + term
    pub term: u64,
    /// the request is void after this unix time
    pub fund_by: i64,
    pub requested_at: i64,
    pub claimed: u64,
    pub state: u8,
    pub bump: u8,
}

pub const BACKING_SIZE: usize = 8 + Backing::INIT_SPACE;
pub const DRAW_SIZE: usize = 8 + Draw::INIT_SPACE;

/// The figures of one backed draw. principal = advance + backer_fee + lender_fee is what the loan owes; the lender is
/// due principal - backer_fee = advance + lender_fee; the reserve covers cover_bps of that, rounded up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    pub backer_fee: u64,
    pub lender_fee: u64,
    pub principal: u64,
    pub reserve: u64,
}

pub fn backed_terms(advance: u64, fee_bps: u16, lender_fee_bps: u16, cover_bps: u16) -> Option<Terms> {
    let a = advance as u128;
    let backer_fee = a * fee_bps as u128 / 10_000;
    let lender_fee = a * lender_fee_bps as u128 / 10_000;
    let principal = a + backer_fee + lender_fee;
    let reserve = ((a + lender_fee) * cover_bps as u128).div_ceil(10_000);
    Some(Terms {
        backer_fee: u64::try_from(backer_fee).ok()?,
        lender_fee: u64::try_from(lender_fee).ok()?,
        principal: u64::try_from(principal).ok()?,
        reserve: u64::try_from(reserve).ok()?,
    })
}

/// What back_claim pays the lender of a defaulted backed loan: its unpaid due (principal - backer_fee, minus what it
/// has been credited: repaid - what went to the vault), at most the draw's reserve and what the vault holds. Pending
/// receipts must be synced first (back_claim refuses otherwise), so none are subtracted here.
pub fn claim_amount(principal: u64, backer_fee: u64, repaid: u64, sub_paid: u64, reserve: u64, vault: u64) -> u64 {
    let lender_due = principal.saturating_sub(backer_fee);
    let lender_got = repaid.saturating_sub(sub_paid);
    lender_due.saturating_sub(lender_got).min(reserve).min(vault)
}

/// Why a funded draw's reserve may be freed (0 = not yet). 1 repaid, 2 settled by the lender, 3 slot closed,
/// 4 the claim window passed without a claim.
pub fn release_reason(slot_closed: bool, repaid: u64, principal: u64, settled: bool, now: i64, expiry: u64) -> u8 {
    if slot_closed {
        3
    } else if repaid >= principal {
        1
    } else if settled {
        2
    } else if now > 0 && (now as u64) > expiry.saturating_add(GRACE).saturating_add(CLAIM_WINDOW) {
        4
    } else {
        0
    }
}

/// True once nothing more can reach the vault through this loan: the slot is closed (sweep_closed pays the lender
/// only, and close_slot refused while the vault was still owed), the loan is repaid, or the Subrogation is recovered.
pub fn routing_done(slot_closed: bool, repaid: u64, principal: u64, sub_paid: u64, sub_owed: u64) -> bool {
    slot_closed || repaid >= principal || sub_paid >= sub_owed
}

/// After expiry + GRACE + CLAIM_WINDOW + RECOVERY_HORIZON an unrecovered Subrogation stops routing to the vault.
pub fn horizon_passed(now: i64, expiry: u64) -> bool {
    now > 0 && (now as u64) > expiry.saturating_add(GRACE).saturating_add(CLAIM_WINDOW).saturating_add(RECOVERY_HORIZON)
}

/// The free stake: vault - reserved (0 when a permanent delegate moved the vault below the reserve).
pub fn free_stake(vault: u64, reserved: u64) -> u64 {
    vault.saturating_sub(reserved)
}

pub fn vault_address(backing: &Pubkey, asset: &Pubkey, token_program: &Pubkey) -> Pubkey {
    token::ata(backing, asset, token_program)
}

fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

fn now_u64() -> Result<u64> {
    let t = now()?;
    require!(t >= 0, LoanError::Overflow);
    Ok(t as u64)
}

/// Mainnet lines back USDG only; localnet any mint.
fn check_asset(_mint: &Pubkey) -> Result<()> {
    #[cfg(feature = "mainnet")]
    require!(BACKED_ASSETS.contains(_mint), LoanError::AssetNotBackable);
    Ok(())
}

/// The payout account a backed advance goes to: a token account of the asset, not the vault, not the slot's inbox, and
/// not owned by the lender, the slot PDA, the Backing PDA or the backer (the advance must reach the borrower).
fn check_payout(payout: &AccountInfo, asset: &Pubkey, tp: &Pubkey, slot_key: &Pubkey, lender: &Pubkey, backing: &Backing, backing_key: &Pubkey) -> Result<()> {
    let v = token::read_token_account(payout, tp).ok_or(error!(LoanError::BadPayout))?;
    require_keys_eq!(v.mint, *asset, LoanError::BadPayout);
    require!(!v.frozen, LoanError::BadPayout);
    let vault = vault_address(backing_key, asset, tp);
    let inbox = token::ata(slot_key, asset, tp);
    require!(
        *payout.key != vault && *payout.key != inbox && v.owner != *lender && v.owner != *slot_key && v.owner != *backing_key && v.owner != backing.backer,
        LoanError::BadPayout
    );
    Ok(())
}

fn backing_seeds<'a>(b: &'a Backing, nonce: &'a [u8; 8], bump: &'a [u8; 1]) -> [&'a [u8]; 4] {
    [BACKING_SEED, b.backer.as_ref(), nonce, bump]
}

fn vault_amount(vault: &AccountInfo, b: &Backing, backing_key: &Pubkey) -> Result<token::TokenAccountView> {
    require_keys_eq!(*vault.key, vault_address(backing_key, &b.asset, &b.token_program), LoanError::BadVault);
    let v = token::read_token_account(vault, &b.token_program).ok_or(error!(LoanError::BadVault))?;
    require_keys_eq!(v.mint, b.asset, LoanError::BadVault);
    Ok(v)
}

// ------------------------------------------------------------------------------------------------ events

#[event]
pub struct BackingOpened {
    pub backing: Pubkey,
    pub asset: Pubkey,
    pub draw_key: Pubkey,
    pub lender: Pubkey,
    pub cover_bps: u16,
    pub fee_bps: u16,
    pub expiry: u64,
    pub max_advance: u64,
    pub max_total: u64,
}

#[event]
pub struct DrawRequested {
    pub backing: Pubkey,
    pub loan_ref: u64,
    pub advance: u64,
    pub principal: u64,
    pub reserve: u64,
    pub term: u64,
    pub fund_by: i64,
}

#[event]
pub struct DrawCancelled {
    pub backing: Pubkey,
    pub loan_ref: u64,
    pub by: Pubkey,
}

#[event]
pub struct BackedFunded {
    pub backing: Pubkey,
    pub loan_ref: u64,
    pub lender: Pubkey,
    pub advance: u64,
    pub backer_fee: u64,
    pub lender_fee: u64,
    pub reserve: u64,
    pub expiry: u64,
}

#[event]
pub struct BackingClaimed {
    pub backing: Pubkey,
    pub loan_ref: u64,
    pub lender: Pubkey,
    pub amount: u64,
    /// true: paid into the slot's inbox as held (the lender's account could not take it; `collect` delivers it)
    pub held: bool,
    /// the backer fee left unpaid at the default, forfeited
    pub fee_forfeited: u64,
}

#[event]
pub struct DrawReleased {
    pub backing: Pubkey,
    pub loan_ref: u64,
    /// 1 repaid, 2 settled, 3 slot closed, 4 claim window over, 0 no reserve freed now
    pub reason: u8,
    /// what the Subrogation stopped routing to the vault (fee or recovery given up): forgive, a frozen or missing
    /// vault, or the recovery horizon
    pub forgone: u64,
    /// the Draw was closed (else it stays in state 3 until its Subrogation is done)
    pub closed: bool,
}

#[event]
pub struct BackingWithdrawn {
    pub backing: Pubkey,
    pub amount: u64,
    pub to: Pubkey,
}

#[event]
pub struct BackingClosed {
    pub backing: Pubkey,
    pub swept: u64,
    pub to: Pubkey,
}

// ------------------------------------------------------------------------------------------------ handlers

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BackOpenArgs {
    pub nonce: u64,
    pub cover_bps: u16,
    pub fee_bps: u16,
    pub expiry: u64,
    pub lender: Pubkey,
    pub draw_key: Pubkey,
    pub max_advance: u64,
    pub max_total: u64,
    pub cosign: bool,
}

pub fn handle_back_open(ctx: Context<BackOpen>, args: BackOpenArgs) -> Result<()> {
    let a = &ctx.accounts;
    let tp = a.token_program.key;
    require!(token::is_token_program(tp), LoanError::BadTokenProgram);
    token::mint_decimals(&a.mint, tp)?;
    check_asset(a.mint.key)?;
    // a transfer fee would make stakes, fees and payouts arrive short of the amounts this program books
    require!(!token::mint_has_transfer_fee(&a.mint), LoanError::AssetNotBackable);
    let t = now_u64()?;
    require!((MIN_COVER_BPS..=MAX_COVER_BPS).contains(&args.cover_bps), LoanError::BackingTerms);
    require!(args.fee_bps <= MAX_BACKER_FEE_BPS, LoanError::BackingTerms);
    require!(args.expiry >= t.saturating_add(MIN_TERM) && args.expiry <= t.saturating_add(MAX_LINE_TERM), LoanError::BackingTerms);
    require!(args.draw_key != Pubkey::default(), LoanError::BackingTerms);
    require!((MIN_ADVANCE..=MAX_DRAW).contains(&args.max_advance) && args.max_total >= args.max_advance, LoanError::BackingTerms);
    let backing_key = a.backing.key();
    require_keys_eq!(a.vault.key(), vault_address(&backing_key, a.mint.key, tp), LoanError::BadVault);
    token::create_ata_idempotent(
        &a.ata_program, &a.payer.to_account_info(), &a.vault, &a.backing.to_account_info(), &a.mint, &a.system_program.to_account_info(), &a.token_program,
    )?;
    let b = &mut ctx.accounts.backing;
    b.backer = ctx.accounts.backer.key();
    b.draw_key = args.draw_key;
    b.lender = args.lender;
    b.asset = ctx.accounts.mint.key();
    b.token_program = *tp;
    b.payer = ctx.accounts.payer.key();
    b.nonce = args.nonce;
    b.cover_bps = args.cover_bps;
    b.fee_bps = args.fee_bps;
    b.expiry = args.expiry;
    b.max_advance = args.max_advance;
    b.max_total = args.max_total;
    b.cosign = args.cosign;
    b.created_at = t as i64;
    b.bump = ctx.bumps.backing;
    emit!(BackingOpened {
        backing: backing_key, asset: b.asset, draw_key: b.draw_key, lender: b.lender, cover_bps: b.cover_bps, fee_bps: b.fee_bps, expiry: b.expiry,
        max_advance: b.max_advance, max_total: b.max_total,
    });
    Ok(())
}

pub fn handle_back_request(ctx: Context<BackRequest>, loan_ref: u64, advance: u64, lender_fee_bps: u16, term: u64, fund_by: i64) -> Result<()> {
    let a = &ctx.accounts;
    let b = &a.backing;
    let backing_key = b.key();
    require_keys_eq!(a.draw_key.key(), b.draw_key, LoanError::NotTheDrawKey);
    require_keys_eq!(a.backer.key(), b.backer, LoanError::NotTheBacker);
    require!(!b.cosign || a.backer.is_signer, LoanError::NotTheBacker);
    require!(!a.slot.funded, LoanError::AlreadyFunded);
    require!(b.lender == Pubkey::default() || b.lender == a.slot.lender, LoanError::LenderNotAllowed);
    require!(advance >= MIN_ADVANCE && advance <= MAX_DRAW.min(b.max_advance), LoanError::DrawTooLarge);
    require!(b.advanced_total.saturating_add(advance) <= b.max_total, LoanError::DrawTooLarge);
    require!(lender_fee_bps <= MAX_LENDER_FEE_BPS, LoanError::BackingTerms);
    let t = now_u64()?;
    require!(term >= MIN_TERM && t.saturating_add(term) <= b.expiry, LoanError::LineExpired);
    require!(fund_by > t as i64 && (fund_by as u64) <= t.saturating_add(MAX_REQUEST_TTL), LoanError::BackingTerms);
    require!(b.open_draws < MAX_OPEN_DRAWS, LoanError::TooManyDraws);
    let slot_key = a.slot.key();
    check_payout(&a.payout_to, &b.asset, &b.token_program, &slot_key, &a.slot.lender, b, &backing_key)?;
    let terms = backed_terms(advance, b.fee_bps, lender_fee_bps, b.cover_bps).ok_or(error!(LoanError::Overflow))?;
    let vault = vault_amount(&a.vault, b, &backing_key)?;
    require!(free_stake(vault.amount, b.reserved) >= terms.reserve, LoanError::StakeShort);

    let payout = a.payout_to.key();
    let payer = a.payer.key();
    let d = &mut ctx.accounts.draw;
    d.loan_ref = loan_ref;
    d.backing = backing_key;
    d.payer = payer;
    d.payout_to = payout;
    d.advance = advance;
    d.backer_fee = terms.backer_fee;
    d.lender_fee = terms.lender_fee;
    d.reserve = terms.reserve;
    d.term = term;
    d.fund_by = fund_by;
    d.requested_at = t as i64;
    d.claimed = 0;
    d.state = DRAW_REQUESTED;
    d.bump = ctx.bumps.draw;
    let b = &mut ctx.accounts.backing;
    b.reserved = b.reserved.checked_add(terms.reserve).ok_or(error!(LoanError::Overflow))?;
    b.open_draws += 1;
    emit!(DrawRequested { backing: backing_key, loan_ref, advance, principal: terms.principal, reserve: terms.reserve, term, fund_by });
    Ok(())
}

/// What the lender expects to fund. Every field must match the Draw (and cover_bps the line), so a borrower that
/// cancels and re-requests between the lender's read and its transaction cannot change what the lender sends.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct BackedTermsArgs {
    pub advance: u64,
    pub principal: u64,
    pub term: u64,
    pub payout_to: Pubkey,
    pub cover_bps: u16,
    /// the lowest cover this lender accepts (10,000 = fully covered)
    pub min_cover_bps: u16,
}

/// The lender funds a requested draw. Its own body (the live `fund` is untouched): the advance minus the 0.25%
/// origination fee goes to the draw's payout account, the fee to the treasury; the slot is funded with
/// principal = advance + backer_fee + lender_fee, no pledge (pledge_bps 0), agent_pk zero and expiry now + term; the
/// loan's Subrogation routes the backer fee to the vault first. Shares already in the inbox go back to payout_to.
pub fn handle_fund_backed(ctx: Context<FundBacked>, loan_ref: u64, expect: BackedTermsArgs) -> Result<()> {
    let a = &ctx.accounts;
    let b = &a.backing;
    let d = &a.draw;
    let backing_key = b.key();
    require!(d.state == DRAW_REQUESTED, LoanError::DrawState);
    require!(!a.slot.funded, LoanError::AlreadyFunded);
    let tp = a.token_program.key;
    require_keys_eq!(*tp, b.token_program, LoanError::BadTokenProgram);
    require_keys_eq!(a.mint.key(), b.asset, LoanError::WrongAsset);
    require!(b.lender == Pubkey::default() || b.lender == a.lender.key(), LoanError::LenderNotAllowed);
    let t = now_u64()?;
    require!((t as i64) <= d.fund_by, LoanError::RequestExpired);
    require!(t.saturating_add(d.term) <= b.expiry, LoanError::LineExpired);
    let principal = d.advance.checked_add(d.backer_fee).and_then(|x| x.checked_add(d.lender_fee)).ok_or(error!(LoanError::Overflow))?;
    require!(
        expect.advance == d.advance && expect.principal == principal && expect.term == d.term && expect.payout_to == d.payout_to
            && expect.cover_bps == b.cover_bps,
        LoanError::TermsMismatch
    );
    require!(b.cover_bps >= expect.min_cover_bps, LoanError::CoverTooLow);
    require!(b.advanced_total.saturating_add(d.advance) <= b.max_total, LoanError::DrawTooLarge);
    require_keys_eq!(a.payout_to.key(), d.payout_to, LoanError::BadPayout);
    let slot_key = a.slot.key();
    check_payout(&a.payout_to, &b.asset, tp, &slot_key, &a.lender.key(), b, &backing_key)?;
    require!(a.payout_to.key() != a.lender_source.key(), LoanError::BadPayout);
    let vault = vault_amount(&a.vault, b, &backing_key)?;
    require!(vault.amount >= b.reserved, LoanError::StakeShort);
    require_keys_eq!(a.inbox.key(), token::ata(&slot_key, a.mint.key, tp), LoanError::BadInbox);
    require!(pool::escrowed(&a.escrow, a.mint.key, &slot_key, loan_ref, tp)? == 0, LoanError::EscrowNotEmpty);
    let decimals = token::mint_decimals(&a.mint, tp)?;
    let mut fee = fee::origination_fee(d.advance).ok_or(error!(LoanError::Overflow))?;
    require_keys_eq!(a.treasury.key(), token::ata(&fee::TREASURY, a.mint.key, tp), LoanError::BadTreasury);
    if fee > 0 {
        let tr = token::read_token_account(&a.treasury, tp).ok_or(error!(LoanError::BadTreasury))?;
        require!(tr.owner == fee::TREASURY && tr.mint == a.mint.key(), LoanError::BadTreasury);
        if tr.frozen {
            fee = 0;
        }
    }
    let to_payout = d.advance - fee;
    token::create_ata_idempotent(
        &a.ata_program, &a.lender.to_account_info(), &a.inbox, &a.slot.to_account_info(), &a.mint, &a.system_program.to_account_info(), &a.token_program,
    )?;
    token::transfer_checked(&a.token_program, &a.lender_source, &a.mint, &a.payout_to, &a.lender.to_account_info(), to_payout, decimals, &[])?;
    if fee > 0 {
        token::transfer_checked(&a.token_program, &a.lender_source, &a.mint, &a.treasury, &a.lender.to_account_info(), fee, decimals, &[])?;
    }
    let pre_fund = token::read_token_account(&a.inbox, tp).map(|v| v.amount).unwrap_or(0);
    if pre_fund > 0 {
        let lr = loan_ref.to_le_bytes();
        let bump = [a.slot.bump];
        let seeds: &[&[u8]] = &[SLOT_SEED, &lr, &bump];
        token::transfer_checked(&a.token_program, &a.inbox, &a.mint, &a.payout_to, &a.slot.to_account_info(), pre_fund, decimals, &[seeds])?;
        emit!(crate::PreFundReturned { loan_ref, asset: a.mint.key(), amount: pre_fund, to: a.payout_to.key() });
    }
    let mint_key = a.mint.key();
    let vault_key = a.vault.key();
    let (advance, backer_fee, lender_fee, reserve, term, payout_to) = (d.advance, d.backer_fee, d.lender_fee, d.reserve, d.term, d.payout_to);

    let ledger = &mut ctx.accounts.ledger;
    if ledger.mint == Pubkey::default() {
        ledger.loan_ref = loan_ref;
        ledger.mint = mint_key;
        ledger.bump = ctx.bumps.ledger;
    }
    ledger.held = 0;

    let s = &mut ctx.accounts.slot;
    s.funded = true;
    s.asset = mint_key;
    s.token_program = *tp;
    s.principal = principal;
    s.repaid = 0;
    s.min_remaining = 0;
    s.min_rate = 0;
    s.pledge_bps = 0;
    s.expiry = t + term;
    s.agent_pk = [0; 32];
    s.funded_at = t as i64;
    s.payout_to = payout_to;
    s.stream_start = 0;
    let (lender, expiry) = (s.lender, s.expiry);

    let sub = &mut ctx.accounts.subrogation;
    sub.loan_ref = loan_ref;
    sub.safety_config = backing_key;
    sub.to = vault_key;
    sub.owed = backer_fee;
    sub.paid = 0;
    sub.bump = ctx.bumps.subrogation;

    ctx.accounts.draw.state = DRAW_FUNDED;
    let b = &mut ctx.accounts.backing;
    b.advanced_total = b.advanced_total.saturating_add(advance);
    b.draws_total = b.draws_total.saturating_add(1);
    emit!(crate::LoanFunded { loan_ref, lender, asset: mint_key, principal, fee, payout_to });
    emit!(BackedFunded { backing: backing_key, loan_ref, lender, advance, backer_fee, lender_fee, reserve, expiry });
    Ok(())
}

/// Permissionless: pays a defaulted backed loan's lender out of the vault (claim_amount). Every routed share must be
/// synced first (the inbox holds no more than `held`, the pool escrow is empty): a pending share synced after the claim
/// would go to the vault as recovery, short-changing the lender. Pays the lender's associated token account, or, when
/// that account cannot receive, the slot's inbox as held (the lender takes it with `collect`). The unpaid backer fee
/// is forfeited: the Subrogation's owed becomes paid + payout, so later receipts first recover the payout.
pub fn handle_back_claim(ctx: Context<BackClaim>, loan_ref: u64) -> Result<()> {
    let a = &ctx.accounts;
    let b = &a.backing;
    let backing_key = b.key();
    require!(a.draw.state == DRAW_FUNDED, LoanError::DrawState);
    let s = &a.slot;
    let tp = s.token_program;
    require_keys_eq!(a.token_program.key(), tp, LoanError::BadTokenProgram);
    require_keys_eq!(a.mint.key(), s.asset, LoanError::BadMint);
    require_keys_eq!(a.subrogation.safety_config, backing_key, LoanError::BadSubrogation);
    require!(shortfall_of(s, now()?, 0) > 0, LoanError::NoBackedDefault);
    let slot_key = s.key();
    require_keys_eq!(a.inbox.key(), token::ata(&slot_key, &s.asset, &tp), LoanError::BadInbox);
    let inbox = token::read_token_account(&a.inbox, &tp);
    let in_inbox = inbox.map_or(0, |v| v.amount);
    require!(in_inbox <= a.ledger.held, LoanError::ReceiptsPending);
    require!(pool::escrowed(&a.escrow, &s.asset, &slot_key, loan_ref, &tp)? == 0, LoanError::ReceiptsPending);
    let vault = vault_amount(&a.vault, b, &backing_key)?;
    let sub_paid = a.subrogation.paid;
    let pay = claim_amount(s.principal, a.draw.backer_fee, s.repaid, sub_paid, a.draw.reserve, vault.amount);
    require!(pay > 0, LoanError::NoBackedDefault);
    require_keys_eq!(a.lender_token.key(), token::ata(&s.lender, &s.asset, &tp), LoanError::BadLenderAccount);
    let deliverable = !vault.frozen
        && matches!(token::read_token_account(&a.lender_token, &tp), Some(v) if v.owner == s.lender && v.mint == s.asset && !v.frozen);
    let to_inbox = !deliverable;
    if to_inbox {
        require!(inbox.is_some_and(|v| !v.frozen), LoanError::BadInbox);
    }
    let decimals = token::mint_decimals(&a.mint, &tp)?;
    let nonce = b.nonce.to_le_bytes();
    let bump = [b.bump];
    let seeds = backing_seeds(b, &nonce, &bump);
    let dest = if to_inbox { &a.inbox } else { &a.lender_token };
    token::transfer_checked(&a.token_program, &a.vault, &a.mint, dest, &a.backing.to_account_info(), pay, decimals, &[&seeds])?;
    let lender = s.lender;
    if to_inbox {
        ctx.accounts.ledger.held = ctx.accounts.ledger.held.checked_add(pay).ok_or(error!(LoanError::Overflow))?;
    }
    let sub = &mut ctx.accounts.subrogation;
    let fee_forfeited = sub.owed.saturating_sub(sub.paid);
    sub.owed = sub.paid.saturating_add(pay);
    let d = &mut ctx.accounts.draw;
    d.state = DRAW_CLAIMED;
    d.claimed = pay;
    let reserve = d.reserve;
    let b = &mut ctx.accounts.backing;
    b.reserved = b.reserved.saturating_sub(reserve);
    b.covered_out = b.covered_out.saturating_add(pay);
    emit!(BackingClaimed { backing: backing_key, loan_ref, lender, amount: pay, held: to_inbox, fee_forfeited });
    Ok(())
}

/// The slot PDA's figures; the slot may be closed (closed = true, everything else 0).
struct SlotView {
    closed: bool,
    funded: bool,
    settled: bool,
    lender: Pubkey,
    repaid: u64,
    principal: u64,
    expiry: u64,
}

fn slot_view(info: &AccountInfo) -> Result<SlotView> {
    if info.owner == &crate::ID && !info.data_is_empty() {
        let data = info.try_borrow_data()?;
        let s = Slot::try_deserialize(&mut &data[..])?;
        Ok(SlotView { closed: false, funded: s.funded, settled: s.settled, lender: s.lender, repaid: s.repaid, principal: s.principal, expiry: s.expiry })
    } else {
        Ok(SlotView { closed: true, funded: false, settled: true, lender: Pubkey::default(), repaid: 0, principal: 0, expiry: 0 })
    }
}

/// Ends a draw's part in its line. One instruction for every way a draw ends (fewer instructions keep the upgrade small):
/// - a request (state 0) is cancelled: by the backer, the draw key or the slot's lender at any time; by anyone once
///   `fund_by` passed, once the slot was funded another way (another line's draw or a stream), or once the slot is gone.
///   The reserve is freed and the Draw closed.
/// - a funded draw (state 1) has its reserve freed once release_reason allows it (permissionless): repaid, settled,
///   slot closed, or the claim window over. It then closes if nothing more can reach the vault, else waits in state 3.
/// - a claimed (2) or released (3) draw is closed once nothing more can reach the vault through the loan (routing_done).
///   Its Subrogation is cut (owed = paid) when `forgive` is set and the backer signs, when the vault can no longer
///   receive (missing or frozen: receipts would wait in the inbox for ever), or after the recovery horizon.
/// The Draw's rent goes to its payer.
pub fn handle_back_settle(ctx: Context<BackSettle>, loan_ref: u64, forgive: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let backing_key = ctx.accounts.backing.key();
    let state = ctx.accounts.draw.state;
    let sv = slot_view(&ctx.accounts.slot)?;
    let t = now()?;
    if state == DRAW_REQUESTED {
        let b = &ctx.accounts.backing;
        let allowed = signer == b.backer || signer == b.draw_key || signer == sv.lender || t > ctx.accounts.draw.fund_by || sv.closed || sv.funded;
        require!(allowed, LoanError::NotReleasable);
        let reserve = ctx.accounts.draw.reserve;
        let b = &mut ctx.accounts.backing;
        b.reserved = b.reserved.saturating_sub(reserve);
        b.open_draws = b.open_draws.saturating_sub(1);
        ctx.accounts.draw.close(ctx.accounts.payer.to_account_info())?;
        emit!(DrawCancelled { backing: backing_key, loan_ref, by: signer });
        return Ok(());
    }
    let sub_info = &ctx.accounts.subrogation;
    require_keys_eq!(*sub_info.key, crate::subrogation_address(loan_ref), LoanError::BadSubrogation);
    require!(sub_info.owner == &crate::ID && !sub_info.data_is_empty(), LoanError::BadSubrogation);
    let mut sub = {
        let data = sub_info.try_borrow_data()?;
        Subrogation::try_deserialize(&mut &data[..])?
    };
    require_keys_eq!(sub.safety_config, backing_key, LoanError::BadSubrogation);
    let mut reason = 0u8;
    if state == DRAW_FUNDED {
        reason = release_reason(sv.closed, sv.repaid, sv.principal, sv.settled, t, sv.expiry);
        require!(reason > 0, LoanError::NotReleasable);
        let reserve = ctx.accounts.draw.reserve;
        let b = &mut ctx.accounts.backing;
        b.reserved = b.reserved.saturating_sub(reserve);
        ctx.accounts.draw.state = DRAW_RELEASED;
    }
    let mut done = routing_done(sv.closed, sv.repaid, sv.principal, sub.paid, sub.owed);
    let mut forgone = 0u64;
    if !done {
        let b = &ctx.accounts.backing;
        require_keys_eq!(*ctx.accounts.vault.key, vault_address(&backing_key, &b.asset, &b.token_program), LoanError::BadVault);
        let vault_ok = matches!(token::read_token_account(&ctx.accounts.vault, &b.token_program), Some(v) if !v.frozen && v.mint == b.asset);
        if forgive {
            require_keys_eq!(signer, b.backer, LoanError::NotTheBacker);
        }
        if forgive || !vault_ok || horizon_passed(t, sv.expiry) {
            forgone = sub.owed - sub.paid;
            sub.owed = sub.paid;
            let mut data = sub_info.try_borrow_mut_data()?;
            sub.try_serialize(&mut &mut data[..])?;
            done = true;
        }
    }
    require!(reason > 0 || done, LoanError::NotReleasable);
    if done {
        let b = &mut ctx.accounts.backing;
        b.open_draws = b.open_draws.saturating_sub(1);
        ctx.accounts.draw.close(ctx.accounts.payer.to_account_info())?;
    }
    emit!(DrawReleased { backing: backing_key, loan_ref, reason, forgone, closed: done });
    Ok(())
}

/// The backer takes stake out of its line. `close` false: `amount` of free stake (vault - reserved) to `destination`.
/// `close` true (no open draw, nothing reserved): everything in the vault (dust others sent included) goes to
/// `destination`, the vault is closed (withheld Token-2022 fees harvested first) and so is the Backing; both rents go
/// to the line's payer.
pub fn handle_back_withdraw(ctx: Context<BackWithdraw>, amount: u64, close: bool) -> Result<()> {
    let a = &ctx.accounts;
    let b = &a.backing;
    let backing_key = b.key();
    require_keys_eq!(a.token_program.key(), b.token_program, LoanError::BadTokenProgram);
    require_keys_eq!(a.mint.key(), b.asset, LoanError::BadMint);
    let vault = vault_amount(&a.vault, b, &backing_key)?;
    let nonce = b.nonce.to_le_bytes();
    let bump = [b.bump];
    let seeds = backing_seeds(b, &nonce, &bump);
    let backing_info = a.backing.to_account_info();
    let take = if close {
        require!(b.open_draws == 0 && b.reserved == 0, LoanError::BackingBusy);
        vault.amount
    } else {
        require!(amount > 0 && amount <= free_stake(vault.amount, b.reserved), LoanError::StakeShort);
        amount
    };
    if take > 0 {
        let decimals = token::mint_decimals(&a.mint, &b.token_program)?;
        token::transfer_checked(&a.token_program, &a.vault, &a.mint, &a.destination, &backing_info, take, decimals, &[&seeds])?;
    }
    if !close {
        emit!(BackingWithdrawn { backing: backing_key, amount: take, to: a.destination.key() });
        return Ok(());
    }
    if token::withheld_amount(&a.vault) > 0 {
        token::harvest_withheld_to_mint(&a.token_program, &a.mint, &a.vault)?;
    }
    token::close_account(&a.token_program, &a.vault, &a.payer.to_account_info(), &backing_info, &[&seeds])?;
    emit!(BackingClosed { backing: backing_key, swept: take, to: a.destination.key() });
    ctx.accounts.backing.close(ctx.accounts.payer.to_account_info())?;
    Ok(())
}

// ------------------------------------------------------------------------------------------------ accounts

#[derive(Accounts)]
#[instruction(args: BackOpenArgs)]
pub struct BackOpen<'info> {
    #[account(
        init,
        payer = payer,
        space = BACKING_SIZE,
        seeds = [BACKING_SEED, backer.key().as_ref(), &args.nonce.to_le_bytes()],
        bump
    )]
    pub backing: Box<Account<'info, Backing>>,
    pub backer: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the asset (owner and initialization checked by mint_decimals)
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the Backing PDA's associated token account (address checked; created here)
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 (checked)
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: associated token account program (address checked)
    #[account(address = token::ATA_PROGRAM_ID)]
    pub ata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct BackRequest<'info> {
    #[account(mut, seeds = [BACKING_SEED, backing.backer.as_ref(), &backing.nonce.to_le_bytes()], bump = backing.bump)]
    pub backing: Box<Account<'info, Backing>>,
    #[account(init, payer = payer, space = DRAW_SIZE, seeds = [DRAW_SEED, backing.key().as_ref(), &loan_ref.to_le_bytes()], bump)]
    pub draw: Box<Account<'info, Draw>>,
    #[account(seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump)]
    pub slot: Box<Account<'info, Slot>>,
    pub draw_key: Signer<'info>,
    /// CHECK: the line's backer (checked); must sign when the line requires a co-sign
    pub backer: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the token account the advance goes to (checked)
    pub payout_to: UncheckedAccount<'info>,
    /// CHECK: the line's vault (address checked)
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct FundBacked<'info> {
    #[account(mut, seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump, has_one = lender @ LoanError::NotTheLender)]
    pub slot: Box<Account<'info, Slot>>,
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(mut, seeds = [BACKING_SEED, backing.backer.as_ref(), &backing.nonce.to_le_bytes()], bump = backing.bump)]
    pub backing: Box<Account<'info, Backing>>,
    #[account(mut, seeds = [DRAW_SEED, backing.key().as_ref(), &loan_ref.to_le_bytes()], bump = draw.bump)]
    pub draw: Box<Account<'info, Draw>>,
    /// CHECK: the loan asset (checked against the line; owner and initialization checked by mint_decimals)
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the lender's token account the advance is paid from (the token program checks it)
    #[account(mut)]
    pub lender_source: UncheckedAccount<'info>,
    /// CHECK: the draw's payout account (checked)
    #[account(mut)]
    pub payout_to: UncheckedAccount<'info>,
    /// CHECK: the slot PDA's associated token account for the asset (address checked; created here)
    #[account(mut)]
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: the line's vault (address checked; must hold at least the line's reserve)
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the line's token program (checked)
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: associated token account program (address checked)
    #[account(address = token::ATA_PROGRAM_ID)]
    pub ata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    #[account(
        init_if_needed,
        payer = lender,
        space = 8 + Ledger::INIT_SPACE,
        seeds = [LEDGER_SEED, &loan_ref.to_le_bytes(), mint.key().as_ref()],
        bump
    )]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: stipend_pool escrow of this slot (address checked; must be empty)
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: fee::TREASURY's associated token account for the asset (checked as in `fund`)
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(init, payer = lender, space = 8 + Subrogation::INIT_SPACE, seeds = [SUBROGATION_SEED, &loan_ref.to_le_bytes()], bump)]
    pub subrogation: Box<Account<'info, Subrogation>>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct BackClaim<'info> {
    #[account(seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump = slot.bump)]
    pub slot: Box<Account<'info, Slot>>,
    #[account(mut, seeds = [BACKING_SEED, backing.backer.as_ref(), &backing.nonce.to_le_bytes()], bump = backing.bump)]
    pub backing: Box<Account<'info, Backing>>,
    #[account(mut, seeds = [DRAW_SEED, backing.key().as_ref(), &loan_ref.to_le_bytes()], bump = draw.bump)]
    pub draw: Box<Account<'info, Draw>>,
    #[account(mut, seeds = [SUBROGATION_SEED, &loan_ref.to_le_bytes()], bump = subrogation.bump)]
    pub subrogation: Box<Account<'info, Subrogation>>,
    #[account(mut, seeds = [LEDGER_SEED, &loan_ref.to_le_bytes(), slot.asset.as_ref()], bump = ledger.bump)]
    pub ledger: Box<Account<'info, Ledger>>,
    /// CHECK: the line's vault (address checked)
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the loan asset (checked)
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the slot's inbox (address checked; must hold nothing unsynced)
    #[account(mut)]
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: stipend_pool escrow of this slot (address checked; must be empty)
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: the slot lender's associated token account (address checked; may not exist or be frozen)
    #[account(mut)]
    pub lender_token: UncheckedAccount<'info>,
    /// CHECK: the loan's token program (checked)
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct BackSettle<'info> {
    #[account(mut, seeds = [BACKING_SEED, backing.backer.as_ref(), &backing.nonce.to_le_bytes()], bump = backing.bump)]
    pub backing: Box<Account<'info, Backing>>,
    #[account(mut, seeds = [DRAW_SEED, backing.key().as_ref(), &loan_ref.to_le_bytes()], bump = draw.bump)]
    pub draw: Box<Account<'info, Draw>>,
    /// CHECK: the slot PDA (seeds checked); may be closed
    #[account(seeds = [SLOT_SEED, &loan_ref.to_le_bytes()], bump)]
    pub slot: UncheckedAccount<'info>,
    /// CHECK: the loan's Subrogation PDA (address checked; read for a funded draw; may not exist for a request)
    #[account(mut)]
    pub subrogation: UncheckedAccount<'info>,
    /// CHECK: the line's vault (address checked when read)
    pub vault: UncheckedAccount<'info>,
    /// anyone for a permissionless release; the backer, draw key or lender for an early cancel; the backer to forgive
    pub signer: Signer<'info>,
    /// CHECK: the Draw's rent payer (address checked)
    #[account(mut, address = draw.payer)]
    pub payer: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BackWithdraw<'info> {
    #[account(mut, seeds = [BACKING_SEED, backing.backer.as_ref(), &backing.nonce.to_le_bytes()], bump = backing.bump, has_one = backer @ LoanError::NotTheBacker)]
    pub backing: Box<Account<'info, Backing>>,
    pub backer: Signer<'info>,
    /// CHECK: the line's vault (address checked)
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the asset (checked); writable for a Token-2022 withheld-fee harvest at close
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: any token account of the asset the backer chooses (the token program checks it)
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: the line's token program (checked)
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the line's rent payer (address checked; gets both rents at close)
    #[account(mut, address = backing.payer)]
    pub payer: UncheckedAccount<'info>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::split_receipt;

    #[test]
    fn sizes() {
        assert_eq!(BACKING_SIZE, 8 + 32 * 6 + 8 + 2 + 2 + 8 + 8 + 8 + 8 + 8 + 2 + 4 + 8 + 1 + 8 + 1);
        assert_eq!(BACKING_SIZE, 276);
        assert_eq!(DRAW_SIZE, 8 + 8 + 32 * 3 + 8 * 4 + 8 + 8 + 8 + 8 + 1 + 1);
        assert_eq!(DRAW_SIZE, 178);
    }

    #[test]
    fn terms_round_fees_down_and_the_reserve_up() {
        let u = 1_000_000u64;
        // the spec's worked case: 500 at 5% + 3% -> principal 540, full cover reserve = 515
        let t = backed_terms(500 * u, 500, 300, 10_000).unwrap();
        assert_eq!(t, Terms { backer_fee: 25 * u, lender_fee: 15 * u, principal: 540 * u, reserve: 515 * u });
        // 20% cover rounds up: (1 + 0) * 2000 / 10000 = 0.2 -> 1
        assert_eq!(backed_terms(1, 0, 0, 2_000).unwrap(), Terms { backer_fee: 0, lender_fee: 0, principal: 1, reserve: 1 });
        // fees under one unit round to 0
        assert_eq!(backed_terms(19, 500, 500, 10_000).unwrap(), Terms { backer_fee: 0, lender_fee: 0, principal: 19, reserve: 19 });
        assert_eq!(backed_terms(7_777_777, 2_000, 2_000, 2_000).unwrap(), Terms { backer_fee: 1_555_555, lender_fee: 1_555_555, principal: 10_888_887, reserve: 1_866_667 });
        // overflow is None, never a wrap
        assert!(backed_terms(u64::MAX, 2_000, 2_000, 10_000).is_none());
        assert!(backed_terms(MAX_DRAW, MAX_BACKER_FEE_BPS, MAX_LENDER_FEE_BPS, MAX_COVER_BPS).is_some());
    }

    #[test]
    fn claim_amount_table() {
        // (principal, fee, repaid, sub_paid, reserve, vault) -> pay
        let rows: [(u64, u64, u64, u64, u64, u64, u64); 9] = [
            (540, 25, 0, 0, 515, 1_000, 515),   // nothing repaid, full cover
            (540, 25, 10, 10, 515, 1_000, 515), // repaid below the fee: all went to the vault, lender got 0
            (540, 25, 100, 25, 515, 1_000, 440), // fee paid, lender got 75
            (540, 25, 540, 25, 515, 1_000, 0),  // repaid
            (540, 25, 0, 0, 103, 1_000, 103),   // 20% cover: capped by the reserve
            (540, 25, 0, 0, 515, 300, 300),     // vault drained below the reserve (permanent delegate)
            (540, 25, 0, 0, 515, 0, 0),
            (540, 0, 200, 0, 540, 1_000, 340),  // no fee
            (u64::MAX, 0, 0, 0, u64::MAX, u64::MAX, u64::MAX),
        ];
        for (p, f, r, sp, res, v, want) in rows {
            assert_eq!(claim_amount(p, f, r, sp, res, v), want, "{p} {f} {r} {sp} {res} {v}");
        }
    }

    #[test]
    fn release_reasons() {
        let e = 1_000u64;
        let after_window = (e + GRACE + CLAIM_WINDOW + 1) as i64;
        assert_eq!(release_reason(true, 0, 10, false, 0, e), 3);
        assert_eq!(release_reason(false, 10, 10, false, 0, e), 1);
        assert_eq!(release_reason(false, 11, 10, true, 0, e), 1);
        assert_eq!(release_reason(false, 3, 10, true, 0, e), 2);
        assert_eq!(release_reason(false, 3, 10, false, after_window - 1, e), 0);
        assert_eq!(release_reason(false, 3, 10, false, after_window, e), 4);
        assert_eq!(release_reason(false, 3, 10, false, -5, e), 0);
        assert!(routing_done(true, 0, 10, 0, 5));
        assert!(routing_done(false, 10, 10, 0, 5));
        assert!(routing_done(false, 0, 10, 5, 5));
        assert!(!routing_done(false, 9, 10, 4, 5));
        assert!(!horizon_passed((e + GRACE + CLAIM_WINDOW + RECOVERY_HORIZON) as i64, e));
        assert!(horizon_passed((e + GRACE + CLAIM_WINDOW + RECOVERY_HORIZON + 1) as i64, e));
        assert_eq!(free_stake(10, 3), 7);
        assert_eq!(free_stake(2, 3), 0);
    }

    #[test]
    fn the_fee_is_routed_first_by_the_unchanged_split() {
        // principal 540, fee 25: a first receipt of 10 goes wholly to the vault, the next 300 pays the rest of the fee
        let s = split_receipt(540, 0, 10, true, 25);
        assert_eq!((s.to_pool, s.to_lender), (10, 0));
        let s = split_receipt(540, 10, 300, true, 15);
        assert_eq!((s.to_pool, s.to_lender), (15, 285));
        let s = split_receipt(540, 310, 300, true, 0);
        assert_eq!((s.to_pool, s.to_lender, s.excess), (0, 230, 70));
    }

    /// One backed loan through random receipts, an optional default claim, more random receipts and an optional
    /// full repayment. Checks: the lender plus the vault never receive more than the principal from receipts; the
    /// lender never ends with more than principal - fee paid before the default; the backer never ends with more than
    /// its stake + its fee; on a full repayment lender + vault net == principal exactly. This is the property that
    /// catches syncing a pending share after a claim (the share would be counted twice).
    #[test]
    fn property_backer_and_lender_accounting() {
        let mut x: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = |m: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % m
        };
        for _ in 0..5_000 {
            let advance = next(10_000) + 1;
            let fee_bps = next(2_001) as u16;
            let lfee_bps = next(2_001) as u16;
            let cover = (2_000 + next(8_001)) as u16;
            let t = backed_terms(advance, fee_bps, lfee_bps, cover).unwrap();
            let stake = t.reserve + next(1_000);
            let p = t.principal;
            let (mut repaid, mut sub_owed, mut sub_paid) = (0u64, t.backer_fee, 0u64);
            let (mut lender_got, mut vault) = (0u64, stake);
            let receive = |repaid: &mut u64, sub_paid: &mut u64, sub_owed: u64, lender_got: &mut u64, vault: &mut u64, delta: u64| {
                let s = split_receipt(p, *repaid, delta, true, sub_owed - *sub_paid);
                *repaid += s.credit;
                *sub_paid += s.to_pool;
                *vault += s.to_pool;
                *lender_got += s.to_lender;
            };
            for _ in 0..next(4) {
                let d = next(p / 2 + 1);
                receive(&mut repaid, &mut sub_paid, sub_owed, &mut lender_got, &mut vault, d);
            }
            let fee_paid_at_default = sub_paid;
            let mut claimed = 0;
            if repaid < p && next(3) != 0 {
                claimed = claim_amount(p, t.backer_fee, repaid, sub_paid, t.reserve, vault);
                vault -= claimed;
                lender_got += claimed;
                sub_owed = sub_paid + claimed;
            }
            for _ in 0..next(4) {
                let d = next(p + 1);
                receive(&mut repaid, &mut sub_paid, sub_owed, &mut lender_got, &mut vault, d);
            }
            let full = next(2) == 0;
            if full {
                receive(&mut repaid, &mut sub_paid, sub_owed, &mut lender_got, &mut vault, p);
            }
            assert!(repaid <= p);
            assert!(lender_got - claimed + (vault + claimed - stake) <= p);
            if claimed > 0 {
                assert!(lender_got <= p - fee_paid_at_default, "lender {lender_got} p {p} fee paid {fee_paid_at_default}");
                assert!(vault <= stake + fee_paid_at_default);
            } else {
                assert!(lender_got <= p - t.backer_fee.min(sub_paid));
                assert!(vault <= stake + t.backer_fee);
            }
            if full {
                assert_eq!(repaid, p);
                assert_eq!(lender_got + vault - stake, p);
                if claimed == 0 {
                    assert_eq!(lender_got, p - t.backer_fee);
                } else {
                    assert_eq!(lender_got, p - fee_paid_at_default);
                    assert_eq!(vault, stake + fee_paid_at_default);
                }
            }
            // a claim never pays more than the lender's unpaid due or the reserve
            assert!(claimed <= t.reserve);
        }
    }

    #[test]
    fn constants() {
        assert!(MIN_COVER_BPS >= 2_000 && MIN_COVER_BPS <= MAX_COVER_BPS);
        assert_eq!(MAX_OPEN_DRAWS, 8);
        assert!(MIN_ADVANCE > 0 && MIN_ADVANCE < MAX_DRAW);
        assert!(MAX_REQUEST_TTL < MAX_LINE_TERM);
    }
}
