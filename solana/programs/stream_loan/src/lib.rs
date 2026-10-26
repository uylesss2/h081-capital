//! stream_loan: lender-facing registry for loans against pledged stream allowances held in
//! stipend_pool (H0.81 Capital). Port of contracts/lending/StreamLoan.sol without the onPledge
//! callback (docs/SOLANA-PORT.md section 3.2). No owner, no admin key, no pause, no upgrade logic.
//!
//! A lender opens a slot; the slot PDA is the `lenderAddr` a borrower pledges to
//! (lenderAddr = fieldOf(slot PDA), loanRef = the slot's loan ref). The pool delivers every routed
//! share to the slot's inbox (the slot PDA's associated token account). `sync` (permissionless) credits
//! the new inbox balance as repayment and forwards it to the slot lender; what cannot be forwarded
//! (lender account missing or frozen) is held for `collect`. The lender pulls its vested share with
//! `claim`, a lender-claim spend submitted through this program with the slot PDA as signer.
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;

pub mod error;
pub mod pool;
pub mod state;
pub mod token;

use error::LoanError;
use state::{shortfall_of, Ledger, Registry, Slot, LEDGER_SEED, REGISTRY_SEED, SLOT_SEED};
pub use state::GRACE;

declare_id!("FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc");

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
    pub principal: u64,
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

fn be32_to_u128(x: &[u8; 32]) -> Result<u128> {
    require!(x[..16].iter().all(|b| *b == 0), LoanError::Overflow);
    Ok(u128::from_be_bytes(x[16..].try_into().unwrap()))
}

fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Credits what arrived in the slot's inbox since the last sync and forwards it to the slot lender,
/// or holds it when the lender's account cannot receive it. Returns the amount newly credited.
#[allow(clippy::too_many_arguments)]
fn sync_inbox<'info>(
    slot: &mut Account<'info, Slot>,
    ledger: &mut Account<'info, Ledger>,
    mint: &AccountInfo<'info>,
    inbox: &AccountInfo<'info>,
    lender_token: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<u64> {
    let tp = token_program.key;
    require!(token::is_token_program(tp), LoanError::BadTokenProgram);
    let slot_key = slot.key();
    require_keys_eq!(*inbox.key, token::ata(&slot_key, mint.key, tp), LoanError::BadInbox);
    require_keys_eq!(*lender_token.key, token::ata(&slot.lender, mint.key, tp), LoanError::BadLenderAccount);
    let Some(inbox_view) = token::read_token_account(inbox, tp) else { return Ok(0) };
    require_keys_eq!(inbox_view.mint, *mint.key, LoanError::BadInbox);
    let delta = inbox_view.amount.saturating_sub(ledger.held);
    if delta == 0 {
        return Ok(0);
    }
    ledger.received = ledger.received.saturating_add(delta);
    let credited = slot.funded && slot.asset == *mint.key;
    if credited {
        slot.repaid = slot.repaid.saturating_add(delta);
    }
    let lender = slot.lender;
    let deliverable = !inbox_view.frozen
        && matches!(token::read_token_account(lender_token, tp), Some(v) if v.owner == lender && v.mint == *mint.key && !v.frozen);
    if deliverable {
        let decimals = token::mint_decimals(mint, tp)?;
        let loan_ref = slot.loan_ref.to_le_bytes();
        let bump = [slot.bump];
        let seeds: &[&[u8]] = &[SLOT_SEED, &loan_ref, &bump];
        let slot_info = slot.to_account_info();
        token::transfer_checked(token_program, inbox, mint, lender_token, &slot_info, delta, decimals, &[seeds])?;
        emit!(DripRouted { loan_ref: slot.loan_ref, asset: *mint.key, amount: delta, lender, credited });
    } else {
        ledger.held = ledger.held.saturating_add(delta);
        emit!(DripEscrowed { loan_ref: slot.loan_ref, asset: *mint.key, amount: delta, credited });
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

    /// Creates the loan-ref counter. Permissionless; `init` makes a second call fail.
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
    /// The proof must name this slot PDA and loan ref, the loan asset and a stream that has started;
    /// the pool verifies it (known root + Groth16) by CPI. The principal goes from the lender to
    /// `payout_to`. Creates the slot's inbox for the asset so routed shares can arrive.
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
        let decimals = token::mint_decimals(&a.mint, tp)?;
        pool::verify_stream(&a.pool_program, &a.pool_state, &a.buffer)?;
        let min_remaining = be32_to_u128(&args.min_remaining)?;
        let min_rate = be32_to_u128(&args.min_rate)?;

        let slot_key = a.slot.key();
        require_keys_eq!(a.inbox.key(), token::ata(&slot_key, a.mint.key, tp), LoanError::BadInbox);
        // Shares escrowed in the pool for this slot before funding would later be credited as repayment
        // once pulled into the inbox; they must be pulled (and so held, below) before the loan starts.
        require!(pool::escrowed(&a.escrow, a.mint.key, &slot_key, loan_ref, tp)? == 0, LoanError::EscrowNotEmpty);
        token::create_ata_idempotent(
            &a.ata_program, &a.lender.to_account_info(), &a.inbox, &a.slot.to_account_info(), &a.mint,
            &a.system_program.to_account_info(), &a.token_program,
        )?;
        token::transfer_checked(&a.token_program, &a.lender_source, &a.mint, &a.payout_to, &a.lender.to_account_info(), principal, decimals, &[])?;
        // StreamLoan.onPledge credits only shares that arrive while the loan is funded. Whatever already sits
        // in the inbox now (routed or sent before funding) is held for `collect`, never counted as repayment.
        let pre_fund = token::read_token_account(&a.inbox, tp).map(|v| v.amount).unwrap_or(0);
        let mint_key = a.mint.key();

        let ledger = &mut ctx.accounts.ledger;
        init_ledger(ledger, loan_ref, mint_key, ctx.bumps.ledger);
        let unsynced = pre_fund.saturating_sub(ledger.held);
        if unsynced > 0 {
            ledger.received = ledger.received.saturating_add(unsynced);
            ledger.held = ledger.held.saturating_add(unsynced);
            emit!(DripEscrowed { loan_ref, asset: mint_key, amount: unsynced, credited: false });
        }

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
        emit!(LoanFunded { loan_ref, lender: s.lender, asset: s.asset, principal, payout_to: s.payout_to });
        Ok(())
    }

    /// Permissionless: credits the shares routed to the slot's inbox in `mint` since the last sync
    /// (as repayment when `mint` is the loan asset) and forwards them to the slot lender's associated
    /// token account, or holds them when that account is missing or frozen.
    pub fn sync(ctx: Context<SyncInbox>, loan_ref: u64) -> Result<()> {
        let a = ctx.accounts;
        init_ledger(&mut a.ledger, loan_ref, a.mint.key(), ctx.bumps.ledger);
        sync_inbox(&mut a.slot, &mut a.ledger, &a.mint, &a.inbox, &a.lender_token, &a.token_program)?;
        Ok(())
    }

    /// The slot's lender takes the shares held in the inbox for it, to a token account of its choice.
    pub fn collect(ctx: Context<Collect>, loan_ref: u64) -> Result<()> {
        let a = ctx.accounts;
        let tp = a.token_program.key;
        require!(token::is_token_program(tp), LoanError::BadTokenProgram);
        require_keys_eq!(a.inbox.key(), token::ata(&a.slot.key(), a.mint.key, tp), LoanError::BadInbox);
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
        sync_inbox(&mut a.slot, &mut a.ledger, &a.mint, &a.inbox, &a.lender_token, &a.token_program)?;
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
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
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
