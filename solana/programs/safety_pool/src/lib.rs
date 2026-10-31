//! safety_pool: H081 stakers insure lenders against a stream-backed loan that is not repaid
//! (Phase 2, docs/SOLANA-PORT.md section 3.3). Port of contracts/token/SafetyPool.sol.
//!
//! - One pool per mint (`SafetyConfig`, PDA ["safety", mint]), created permissionlessly; no admin field.
//! - Stakers `deposit` for shares at the price (assets + 1) / (total shares + 1,000). The virtual shares and
//!   assets (an offset in the style of OpenZeppelin ERC4626) make share-price inflation by a first depositor
//!   unprofitable, and the pool's assets are an accounted figure (`SafetyConfig.assets`, moved only by
//!   deposits, premiums, top-ups, withdrawals and slashes), so tokens sent straight to the vault never move
//!   the price; they stay in the vault unaccounted. Premiums and top-ups raise the price, slashes lower it.
//!   `request_unbond` starts a 14-day cooldown during which the shares stay at risk; `withdraw` redeems them at the price on that day.
//! - `insure(loan_ref, premium)`: only the stream_loan slot's lender, only for a loan that is funded, not
//!   settled, has an expiry and has not expired. One cover per loan ref across every mint's pool (PDA
//!   ["cover", loan_ref]) so a loan cannot be insured twice.
//! - `slash(loan_ref)`: anyone, once stream_loan's state shows a shortfall (expiry + 7-day grace passed,
//!   repaid below principal, not settled; shares routed to the loan but still unsynced in the slot inbox or
//!   held in the stipend_pool escrow count as repaid). Pays the cover's lender min(shortfall, pool assets) of the
//!   pool's token, valued 1:1 in base units (see caveats), and marks the cover paid. A slash with an
//!   empty pool fails (`PoolEmpty`) so the cover stays open. A slash that takes the whole pool bumps the
//!   generation, retiring every share (including unbonding ones); the next deposit starts a fresh share count.
//! - `top_up(amount)`: anyone adds tokens to the pool's assets without minting shares, raising what every
//!   outstanding share (unbonding ones too) redeems for. The H081 flywheel pays stakers this way from
//!   PLATFORM fees only (docs/FLYWHEEL.md). Refused while no shares exist (nobody to pay; the tokens would
//!   go to the next depositor), and refused from the token launch wallets (`LAUNCH_WALLETS`): the token's
//!   trading creator fees are never a source. Like a premium, a top-up into a pool whose only shares are a
//!   first depositor's dust mostly accrues to the virtual shares, so it cannot inflate the price at a
//!   later depositor's expense.
//!
//! CAVEATS (docs/tokenomics.md, restated): with lender-chosen premiums and 1:1 valuation a lender can fund
//! a loan to itself, let it lapse past the grace period and slash the pool for the principal; until
//! premiums are priced or cover is underwritten, only stakers who trust the set of insurable lenders
//! should deposit. The 1:1 valuation ignores the H081 price entirely. A loan with no expiry never reports
//! a shortfall and cannot be insured.
//! No admin key, no pause, no upgrade logic.
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

pub mod stream_loan_view;
use stream_loan_view::{load_slot, pending_in_escrow, pending_in_inbox, shortfall_of};

#[cfg(not(feature = "fast"))]
declare_id!("EvKjwxVQX1RhyoBXisdbzk1JGLb5fMgZzHVLQAiPKJwe");
#[cfg(feature = "fast")]
declare_id!("5K2L3eNBzmeznEZpY4vav74UHRaBHgQJv582W5i4kT7");

/// Time between an unbond request and the tokens leaving.
#[cfg(not(feature = "fast"))]
pub const COOLDOWN: i64 = 14 * 24 * 60 * 60;
/// stream_loan's GRACE: time after expiry before an unpaid loan counts as a shortfall.
#[cfg(not(feature = "fast"))]
pub const GRACE: u64 = 7 * 24 * 60 * 60;
/// LOCALNET TEST BUILD ONLY (feature `fast`, separate program id).
#[cfg(feature = "fast")]
pub const COOLDOWN: i64 = 3;
#[cfg(feature = "fast")]
pub const GRACE: u64 = 2;

pub const SAFETY_SEED: &[u8] = b"safety";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const COVER_SEED: &[u8] = b"cover";

/// H081 launch wallets. `top_up` refuses them as signer or as source owner so the token's trading
/// creator fees can never be routed into the pool.
pub const LAUNCH_WALLETS: [Pubkey; 3] = [
    pubkey!("2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP"),
    pubkey!("FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ"),
    pubkey!("5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw"),
];

/// Virtual shares and assets added to the pool's totals when pricing shares (see the module docs).
pub const VIRTUAL_SHARES: u128 = 1_000;
pub const VIRTUAL_ASSETS: u128 = 1;

/// Shares minted for `assets_in` when the pool holds `assets` against `total` shares (rounds down).
pub fn shares_for(assets_in: u64, assets: u64, total: u128) -> Result<u128> {
    let t = total.checked_add(VIRTUAL_SHARES).ok_or(error!(SafetyError::Overflow))?;
    mul_div(assets_in as u128, t, assets as u128 + VIRTUAL_ASSETS)
}

/// Tokens `shares` redeem for (rounds down; never more than `assets` while shares <= total).
pub fn assets_for(shares: u128, assets: u64, total: u128) -> Result<u64> {
    let t = total.checked_add(VIRTUAL_SHARES).ok_or(error!(SafetyError::Overflow))?;
    let out = mul_div(shares, assets as u128 + VIRTUAL_ASSETS, t)?;
    Ok(out.min(assets as u128) as u64)
}

fn mul_div(a: u128, b: u128, c: u128) -> Result<u128> {
    a.checked_mul(b).and_then(|x| x.checked_div(c)).ok_or(error!(SafetyError::Overflow))
}

#[program]
pub mod safety_pool {
    use super::*;

    /// Creates the per-mint pool and its vault. Permissionless; `init` makes a second call fail.
    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.mint = ctx.accounts.mint.key();
        c.token_program = ctx.accounts.token_program.key();
        c.vault = ctx.accounts.vault.key();
        c.decimals = ctx.accounts.mint.decimals;
        c.total_shares = 0;
        c.assets = 0;
        c.generation = 0;
        c.bump = ctx.bumps.config;
        c.vault_bump = ctx.bumps.vault;
        emit!(PoolCreated { mint: c.mint, vault: c.vault });
        Ok(())
    }

    /// Puts `amount` at risk; shares are minted at the current price on what the vault received.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, SafetyError::Amount);
        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        let received = ctx.accounts.vault.amount.checked_sub(before).ok_or(error!(SafetyError::Amount))?;
        require!(received > 0, SafetyError::Amount);
        let total = ctx.accounts.config.total_shares;
        let shares = shares_for(received, ctx.accounts.config.assets, total)?;
        require!(shares > 0, SafetyError::TooSmall);

        let generation = ctx.accounts.config.generation;
        let owner = ctx.accounts.owner.key();
        let p = &mut ctx.accounts.position;
        if p.owner == Pubkey::default() {
            p.owner = owner;
            p.mint = ctx.accounts.config.mint;
            p.bump = ctx.bumps.position;
            p.gen = generation;
        }
        p.sync(generation);
        p.shares = p.shares.checked_add(shares).ok_or(error!(SafetyError::Overflow))?;
        let c = &mut ctx.accounts.config;
        c.total_shares = c.total_shares.checked_add(shares).ok_or(error!(SafetyError::Overflow))?;
        c.assets = c.assets.checked_add(received).ok_or(error!(SafetyError::Overflow))?;
        emit!(Deposited { mint: c.mint, owner, amount: received, shares });
        Ok(())
    }

    /// Starts the cooldown on `shares` (restarting it for any already unbonding). They stay at risk.
    pub fn request_unbond(ctx: Context<RequestUnbond>, shares: u128) -> Result<()> {
        require!(shares > 0, SafetyError::Shares);
        let now = Clock::get()?.unix_timestamp;
        let generation = ctx.accounts.config.generation;
        let p = &mut ctx.accounts.position;
        p.sync(generation);
        require!(shares <= p.shares, SafetyError::MoreThanHeld);
        p.shares -= shares;
        p.unbonding = p.unbonding.checked_add(shares).ok_or(error!(SafetyError::Overflow))?;
        p.ready_at = now.checked_add(COOLDOWN).ok_or(error!(SafetyError::Overflow))?;
        emit!(UnbondRequested { mint: p.mint, owner: p.owner, shares, ready_at: p.ready_at });
        Ok(())
    }

    /// Redeems the unbonding shares at today's price into `to`, once the cooldown has passed.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let generation = ctx.accounts.config.generation;
        let p = &mut ctx.accounts.position;
        p.sync(generation);
        let shares = p.unbonding;
        require!(shares > 0, SafetyError::NothingUnbonding);
        require!(now >= p.ready_at, SafetyError::Cooldown);
        let total = ctx.accounts.config.total_shares;
        let assets = ctx.accounts.config.assets;
        let amount = assets_for(shares, assets, total)?;
        p.unbonding = 0;
        p.ready_at = 0;
        ctx.accounts.config.total_shares = total.checked_sub(shares).ok_or(error!(SafetyError::Overflow))?;
        ctx.accounts.config.assets = assets - amount;
        let mint_key = ctx.accounts.config.mint;
        if amount > 0 {
            let bump = [ctx.accounts.config.bump];
            let seeds: &[&[u8]] = &[SAFETY_SEED, mint_key.as_ref(), &bump];
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.to.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
                ctx.accounts.mint.decimals,
            )?;
        }
        emit!(Withdrawn { mint: mint_key, owner: ctx.accounts.owner.key(), shares, amount });
        Ok(())
    }

    /// The slot's lender binds its funded, unexpired loan to this pool and pays `premium` in.
    pub fn insure(ctx: Context<Insure>, loan_ref: u64, premium: u64) -> Result<()> {
        let s = load_slot(&ctx.accounts.slot, loan_ref)?;
        let lender = ctx.accounts.lender.key();
        require_keys_eq!(s.lender, lender, SafetyError::NotTheLender);
        require!(s.funded, SafetyError::NoLoan);
        require!(!s.settled, SafetyError::Settled);
        require!(s.expiry != 0, SafetyError::NoDueDate);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= 0 && (now as u64) <= s.expiry, SafetyError::Expired);

        let mut received = 0u64;
        if premium > 0 {
            let before = ctx.accounts.vault.amount;
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.from.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.lender.to_account_info(),
                    },
                ),
                premium,
                ctx.accounts.mint.decimals,
            )?;
            ctx.accounts.vault.reload()?;
            received = ctx.accounts.vault.amount.checked_sub(before).ok_or(error!(SafetyError::Amount))?;
            let cfg = &mut ctx.accounts.config;
            cfg.assets = cfg.assets.checked_add(received).ok_or(error!(SafetyError::Overflow))?;
        }
        let c = &mut ctx.accounts.cover;
        c.loan_ref = loan_ref;
        c.mint = ctx.accounts.config.mint;
        c.lender = lender;
        c.premium = received;
        c.bound_at = now;
        c.paid = false;
        c.paid_out = 0;
        c.bump = ctx.bumps.cover;
        emit!(Insured { loan_ref, mint: c.mint, lender, premium: received });
        Ok(())
    }

    /// Anyone: pays the lender of an insured loan stream_loan's shortfall, capped by the pool.
    pub fn slash(ctx: Context<Slash>, loan_ref: u64) -> Result<()> {
        require!(!ctx.accounts.cover.paid, SafetyError::AlreadyPaid);
        let shortfall = current_shortfall(&ctx.accounts.slot, &ctx.accounts.inbox, &ctx.accounts.ledger, &ctx.accounts.escrow, loan_ref)?;
        require!(shortfall > 0, SafetyError::NoShortfall);
        let balance = ctx.accounts.config.assets;
        require!(balance > 0, SafetyError::PoolEmpty);
        let pay = shortfall.min(balance);
        {
            let c = &mut ctx.accounts.cover;
            c.paid = true;
            c.paid_out = pay;
        }
        let mint_key = ctx.accounts.config.mint;
        let bump = [ctx.accounts.config.bump];
        let seeds: &[&[u8]] = &[SAFETY_SEED, mint_key.as_ref(), &bump];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.lender_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            pay,
            ctx.accounts.mint.decimals,
        )?;
        let lender = ctx.accounts.cover.lender;
        emit!(Slashed { loan_ref, mint: mint_key, lender, shortfall, paid: pay });
        let c = &mut ctx.accounts.config;
        c.assets = balance - pay;
        if pay == balance && c.total_shares > 0 {
            c.total_shares = 0;
            c.generation += 1;
            emit!(PoolRetired { mint: mint_key, generation: c.generation });
        }
        Ok(())
    }

    /// Anyone but a launch wallet: adds what the vault receives of `amount` to the pool's assets, minting
    /// no shares, so every outstanding share of the current generation redeems for more.
    pub fn top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
        require!(amount > 0, SafetyError::Amount);
        let funder = ctx.accounts.funder.key();
        require!(
            !LAUNCH_WALLETS.contains(&funder) && !LAUNCH_WALLETS.contains(&ctx.accounts.from.owner),
            SafetyError::LaunchWallet
        );
        require!(ctx.accounts.config.total_shares > 0, SafetyError::NoShares);
        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        let received = ctx.accounts.vault.amount.checked_sub(before).ok_or(error!(SafetyError::Amount))?;
        require!(received > 0, SafetyError::Amount);
        let c = &mut ctx.accounts.config;
        c.assets = c.assets.checked_add(received).ok_or(error!(SafetyError::Overflow))?;
        emit!(ToppedUp { mint: c.mint, funder, amount: received, assets: c.assets, generation: c.generation });
        Ok(())
    }

    /// View (return data, u64 LE; use simulateTransaction): the shortfall slash would see now.
    pub fn shortfall(ctx: Context<ShortfallView>, loan_ref: u64) -> Result<u64> {
        current_shortfall(&ctx.accounts.slot, &ctx.accounts.inbox, &ctx.accounts.ledger, &ctx.accounts.escrow, loan_ref)
    }

    /// Closes an empty position (no shares, nothing unbonding, or a retired generation) for its rent.
    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        let generation = ctx.accounts.config.generation;
        let p = &mut ctx.accounts.position;
        p.sync(generation);
        require!(p.shares == 0 && p.unbonding == 0, SafetyError::NotEmpty);
        Ok(())
    }
}

fn current_shortfall(slot: &AccountInfo, inbox: &AccountInfo, ledger: &AccountInfo, escrow: &AccountInfo, loan_ref: u64) -> Result<u64> {
    let s = load_slot(slot, loan_ref)?;
    let pending = pending_in_inbox(&slot.key(), &s, inbox, ledger)?.saturating_add(pending_in_escrow(&slot.key(), &s, escrow)?);
    Ok(shortfall_of(&s, Clock::get()?.unix_timestamp, pending))
}

/// Per-mint pool. PDA ["safety", mint]. No admin field.
#[account]
#[derive(InitSpace)]
pub struct SafetyConfig {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    /// Token account PDA ["vault", mint], authority = this config. Its balance is the pool balance.
    pub vault: Pubkey,
    pub decimals: u8,
    /// Shares outstanding in the current generation.
    pub total_shares: u128,
    /// Bumped when a slash empties the pool; positions of an older generation are worth nothing.
    pub generation: u64,
    pub bump: u8,
    pub vault_bump: u8,
    /// The pool's accounted assets: deposits + premiums + top-ups - withdrawals - slashes. Shares are priced on
    /// this, not on the vault balance, so direct transfers to the vault do not move the price.
    pub assets: u64,
}

/// One staker's position in one mint's pool. PDA ["position", mint, owner].
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub mint: Pubkey,
    /// At risk, redeemable after unbonding.
    pub shares: u128,
    /// Waiting for the cooldown, still at risk.
    pub unbonding: u128,
    /// When `withdraw` may run (unix seconds).
    pub ready_at: i64,
    /// The pool generation these figures belong to.
    pub gen: u64,
    pub bump: u8,
}

impl Position {
    /// An older generation's figures are worthless: reset them.
    pub fn sync(&mut self, generation: u64) {
        if self.gen != generation {
            self.shares = 0;
            self.unbonding = 0;
            self.ready_at = 0;
            self.gen = generation;
        }
    }
}

/// Cover of one loan. PDA ["cover", loan_ref u64 LE], one per loan ref across all mints.
#[account]
#[derive(InitSpace)]
pub struct Cover {
    pub loan_ref: u64,
    /// The pool (mint) that insures it.
    pub mint: Pubkey,
    /// Who the slash pays (the slot lender at insure time).
    pub lender: Pubkey,
    /// Premium the vault received.
    pub premium: u64,
    pub bound_at: i64,
    pub paid: bool,
    pub paid_out: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(init, payer = payer, space = 8 + SafetyConfig::INIT_SPACE, seeds = [SAFETY_SEED, mint.key().as_ref()], bump)]
    pub config: Account<'info, SafetyConfig>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = config,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [SAFETY_SEED, mint.key().as_ref()], bump = config.bump, has_one = mint, has_one = vault, has_one = token_program)]
    pub config: Account<'info, SafetyConfig>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, mint.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestUnbond<'info> {
    #[account(seeds = [SAFETY_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, SafetyConfig>,
    #[account(mut, seeds = [POSITION_SEED, config.mint.as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner)]
    pub position: Account<'info, Position>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [SAFETY_SEED, mint.key().as_ref()], bump = config.bump, has_one = mint, has_one = vault, has_one = token_program)]
    pub config: Account<'info, SafetyConfig>,
    #[account(mut, seeds = [POSITION_SEED, mint.key().as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner)]
    pub position: Account<'info, Position>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub owner: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct Insure<'info> {
    #[account(mut, seeds = [SAFETY_SEED, mint.key().as_ref()], bump = config.bump, has_one = mint, has_one = vault, has_one = token_program)]
    pub config: Account<'info, SafetyConfig>,
    #[account(init, payer = lender, space = 8 + Cover::INIT_SPACE, seeds = [COVER_SEED, &loan_ref.to_le_bytes()], bump)]
    pub cover: Account<'info, Cover>,
    /// CHECK: stream_loan Slot PDA ["slot", loan_ref]; owner, address and discriminator checked in load_slot
    pub slot: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub lender: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct Slash<'info> {
    #[account(mut, seeds = [SAFETY_SEED, mint.key().as_ref()], bump = config.bump, has_one = mint, has_one = vault, has_one = token_program)]
    pub config: Account<'info, SafetyConfig>,
    #[account(mut, seeds = [COVER_SEED, &loan_ref.to_le_bytes()], bump = cover.bump, constraint = cover.mint == mint.key() @ SafetyError::WrongPool)]
    pub cover: Account<'info, Cover>,
    /// CHECK: stream_loan Slot PDA; checked in load_slot
    pub slot: UncheckedAccount<'info>,
    /// CHECK: the slot's inbox (ATA of the slot PDA for the loan asset); address checked, may not exist
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: stream_loan Ledger PDA ["ledger", loan_ref, asset]; address checked, may not exist
    pub ledger: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = cover.lender,
        token::token_program = token_program
    )]
    pub lender_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: stipend_pool escrow ["owed", loan asset, fieldOf(slot), loan_ref]; address checked, may not exist
    pub escrow: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TopUp<'info> {
    #[account(mut, seeds = [SAFETY_SEED, mint.key().as_ref()], bump = config.bump, has_one = mint, has_one = vault, has_one = token_program)]
    pub config: Account<'info, SafetyConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub from: InterfaceAccount<'info, TokenAccount>,
    pub funder: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ShortfallView<'info> {
    /// CHECK: stream_loan Slot PDA; checked in load_slot
    pub slot: UncheckedAccount<'info>,
    /// CHECK: see Slash
    pub inbox: UncheckedAccount<'info>,
    /// CHECK: see Slash
    pub ledger: UncheckedAccount<'info>,
    /// CHECK: see Slash
    pub escrow: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(seeds = [SAFETY_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, SafetyConfig>,
    #[account(mut, close = owner, seeds = [POSITION_SEED, config.mint.as_ref(), owner.key().as_ref()], bump = position.bump, has_one = owner)]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[event]
pub struct PoolCreated {
    pub mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct Deposited {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub shares: u128,
}

#[event]
pub struct UnbondRequested {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub shares: u128,
    pub ready_at: i64,
}

#[event]
pub struct Withdrawn {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub shares: u128,
    pub amount: u64,
}

#[event]
pub struct Insured {
    pub loan_ref: u64,
    pub mint: Pubkey,
    pub lender: Pubkey,
    pub premium: u64,
}

#[event]
pub struct Slashed {
    pub loan_ref: u64,
    pub mint: Pubkey,
    pub lender: Pubkey,
    pub shortfall: u64,
    pub paid: u64,
}

/// `amount`: what the vault received; `assets`: the pool's accounted assets after it.
#[event]
pub struct ToppedUp {
    pub mint: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
    pub assets: u64,
    pub generation: u64,
}

#[event]
pub struct PoolRetired {
    pub mint: Pubkey,
    pub generation: u64,
}

/// Codes are 6000 + index.
#[error_code]
pub enum SafetyError {
    #[msg("amount must be positive")]
    Amount,
    #[msg("deposit too small for one share")]
    TooSmall,
    #[msg("shares must be positive")]
    Shares,
    #[msg("more than held")]
    MoreThanHeld,
    #[msg("nothing unbonding")]
    NothingUnbonding,
    #[msg("cooldown has not passed")]
    Cooldown,
    #[msg("not the slot's lender")]
    NotTheLender,
    #[msg("no loan")]
    NoLoan,
    #[msg("loan settled")]
    Settled,
    #[msg("loan has no due date")]
    NoDueDate,
    #[msg("loan expired")]
    Expired,
    #[msg("cover already paid")]
    AlreadyPaid,
    #[msg("no shortfall")]
    NoShortfall,
    #[msg("pool empty")]
    PoolEmpty,
    #[msg("not a stream_loan account for this loan")]
    BadLoanAccount,
    #[msg("cover belongs to another pool")]
    WrongPool,
    #[msg("position is not empty")]
    NotEmpty,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("no shares to top up")]
    NoShares,
    #[msg("launch wallets cannot top up")]
    LaunchWallet,
}
