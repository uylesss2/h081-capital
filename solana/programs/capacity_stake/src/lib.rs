//! capacity_stake: staked H081 buys capacity (Phase 2, docs/SOLANA-PORT.md section 3.3).
//! Port of contracts/token/CapacityStake.sol for an SPL Token or Token-2022 mint.
//!
//! - One `Config` per mint, created permissionlessly by anyone (`init_config`); it has no admin field.
//! - `stake` locks tokens; they count as capacity at once. `request_unstake` moves an amount out of
//!   capacity into a 7-day cooldown (a new request adds to it and restarts the cooldown); `unstake`
//!   takes back everything whose cooldown has passed.
//! - Capacity is read off the `Stake` account (or the `capacity` view): desks = staked / DESK_UNIT,
//!   shield cap = (staked / SHIELD_UNIT) * SHIELD_PER_UNIT. Units follow the mint's decimals:
//!   DESK_UNIT = SHIELD_UNIT = 100 whole tokens; SHIELD_PER_UNIT = 10,000 USDG (6 decimals).
//! - Relayers and hosted endpoints enforce capacity off-chain; stipend_pool never reads this program.
//! No admin key, no pause, no upgrade logic.
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

#[cfg(not(feature = "fast"))]
declare_id!("6yzLZPu3JcLQHZQqLKWpGnHUpNTGAkoRcW8Ji8oSgCd3");
#[cfg(feature = "fast")]
declare_id!("DoiRuuwMkN8M4CWQy45Lne2wGP7JCPUtPDiC1pE9QM1q");

/// Whole tokens per desk (scaled by the mint's decimals at `init_config`).
pub const DESK_WHOLE_TOKENS: u64 = 100;
/// Whole tokens per shielding unit (scaled by the mint's decimals at `init_config`).
pub const SHIELD_WHOLE_TOKENS: u64 = 100;
/// USDG base units (6 decimals) per 30 days that one shielding unit allows: 10,000 USDG.
pub const SHIELD_PER_UNIT: u64 = 10_000_000_000;
/// Time between an unstake request and the tokens leaving.
#[cfg(not(feature = "fast"))]
pub const COOLDOWN: i64 = 7 * 24 * 60 * 60;
/// LOCALNET TEST BUILD ONLY (feature `fast`, separate program id).
#[cfg(feature = "fast")]
pub const COOLDOWN: i64 = 3;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const STAKE_SEED: &[u8] = b"stake";

#[program]
pub mod capacity_stake {
    use super::*;

    /// Creates the per-mint config and its vault. Permissionless; `init` makes a second call fail.
    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        let decimals = ctx.accounts.mint.decimals;
        let scale = 10u64.checked_pow(decimals as u32).ok_or(error!(StakeError::Decimals))?;
        let c = &mut ctx.accounts.config;
        c.mint = ctx.accounts.mint.key();
        c.token_program = ctx.accounts.token_program.key();
        c.vault = ctx.accounts.vault.key();
        c.decimals = decimals;
        c.desk_unit = DESK_WHOLE_TOKENS.checked_mul(scale).ok_or(error!(StakeError::Decimals))?;
        c.shield_unit = SHIELD_WHOLE_TOKENS.checked_mul(scale).ok_or(error!(StakeError::Decimals))?;
        c.total_staked = 0;
        c.total_pending = 0;
        c.bump = ctx.bumps.config;
        c.vault_bump = ctx.bumps.vault;
        emit!(ConfigCreated { mint: c.mint, vault: c.vault, desk_unit: c.desk_unit, shield_unit: c.shield_unit });
        Ok(())
    }

    /// Locks `amount` tokens from `from`; what the vault actually receives (net of any Token-2022
    /// transfer fee) counts as capacity at once.
    pub fn stake(ctx: Context<StakeTokens>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeError::Amount);
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
        let received = ctx.accounts.vault.amount.checked_sub(before).ok_or(error!(StakeError::Amount))?;
        require!(received > 0, StakeError::Amount);

        let owner = ctx.accounts.owner.key();
        let s = &mut ctx.accounts.stake;
        if s.owner == Pubkey::default() {
            s.owner = owner;
            s.mint = ctx.accounts.config.mint;
            s.bump = ctx.bumps.stake;
        }
        s.staked = s.staked.checked_add(received).ok_or(error!(StakeError::Overflow))?;
        let c = &mut ctx.accounts.config;
        c.total_staked = c.total_staked.checked_add(received).ok_or(error!(StakeError::Overflow))?;
        emit!(Staked { mint: c.mint, owner, amount: received });
        Ok(())
    }

    /// Moves `amount` out of capacity and into the cooldown; restarts the cooldown on everything pending.
    pub fn request_unstake(ctx: Context<RequestUnstake>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeError::Amount);
        let now = Clock::get()?.unix_timestamp;
        let s = &mut ctx.accounts.stake;
        require!(amount <= s.staked, StakeError::MoreThanStaked);
        s.staked -= amount;
        s.pending = s.pending.checked_add(amount).ok_or(error!(StakeError::Overflow))?;
        s.ready_at = now.checked_add(COOLDOWN).ok_or(error!(StakeError::Overflow))?;
        let c = &mut ctx.accounts.config;
        c.total_staked -= amount;
        c.total_pending = c.total_pending.checked_add(amount).ok_or(error!(StakeError::Overflow))?;
        emit!(UnstakeRequested { mint: c.mint, owner: s.owner, amount, ready_at: s.ready_at });
        Ok(())
    }

    /// Sends everything whose cooldown has passed to `to` (any token account of the mint).
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let amount = ctx.accounts.stake.pending;
        require!(amount > 0, StakeError::NothingPending);
        require!(now >= ctx.accounts.stake.ready_at, StakeError::Cooldown);
        {
            let s = &mut ctx.accounts.stake;
            s.pending = 0;
            s.ready_at = 0;
        }
        ctx.accounts.config.total_pending -= amount;
        let mint_key = ctx.accounts.config.mint;
        let bump = [ctx.accounts.config.bump];
        let seeds: &[&[u8]] = &[CONFIG_SEED, mint_key.as_ref(), &bump];
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
        emit!(Unstaked { mint: mint_key, owner: ctx.accounts.owner.key(), amount });
        Ok(())
    }

    /// Closes an empty stake account (nothing staked, nothing pending) and returns its rent.
    pub fn close_stake(ctx: Context<CloseStake>) -> Result<()> {
        let s = &ctx.accounts.stake;
        require!(s.staked == 0 && s.pending == 0, StakeError::NotEmpty);
        Ok(())
    }

    /// View (return data; also usable via simulateTransaction): the capacity of a stake account.
    pub fn capacity(ctx: Context<CapacityView>) -> Result<Capacity> {
        Ok(ctx.accounts.config.capacity_of(ctx.accounts.stake.staked))
    }
}

/// Per-mint configuration. PDA ["config", mint]. No admin field.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    /// Token account PDA ["vault", mint], authority = this config.
    pub vault: Pubkey,
    pub decimals: u8,
    /// Base units per desk: 100 whole tokens.
    pub desk_unit: u64,
    /// Base units per shielding unit: 100 whole tokens.
    pub shield_unit: u64,
    /// Sum of `staked` over all stake accounts (counts as capacity).
    pub total_staked: u64,
    /// Sum of `pending` over all stake accounts (under cooldown).
    pub total_pending: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Config {
    pub fn capacity_of(&self, staked: u64) -> Capacity {
        let units = (staked / self.shield_unit) as u128;
        Capacity { desks: staked / self.desk_unit, shield_cap: units * SHIELD_PER_UNIT as u128 }
    }
}

/// One owner's stake for one mint. PDA ["stake", mint, owner].
#[account]
#[derive(InitSpace)]
pub struct Stake {
    pub owner: Pubkey,
    pub mint: Pubkey,
    /// Counts as capacity.
    pub staked: u64,
    /// Under cooldown; no longer counts as capacity.
    pub pending: u64,
    /// When `unstake` may run (unix seconds); 0 when nothing is pending.
    pub ready_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capacity {
    /// Desks the owner may run.
    pub desks: u64,
    /// USDG base units (6 decimals) the owner may shield per 30 days.
    pub shield_cap: u128,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED, mint.key().as_ref()], bump)]
    pub config: Account<'info, Config>,
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
pub struct StakeTokens<'info> {
    #[account(mut, seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump, has_one = mint, has_one = vault, has_one = token_program)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Stake::INIT_SPACE,
        seeds = [STAKE_SEED, mint.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub stake: Account<'info, Stake>,
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
pub struct RequestUnstake<'info> {
    #[account(mut, seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [STAKE_SEED, config.mint.as_ref(), owner.key().as_ref()], bump = stake.bump, has_one = owner)]
    pub stake: Account<'info, Stake>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut, seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.bump, has_one = mint, has_one = vault, has_one = token_program)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [STAKE_SEED, mint.key().as_ref(), owner.key().as_ref()], bump = stake.bump, has_one = owner)]
    pub stake: Account<'info, Stake>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub owner: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CloseStake<'info> {
    #[account(mut, close = owner, seeds = [STAKE_SEED, stake.mint.as_ref(), owner.key().as_ref()], bump = stake.bump, has_one = owner)]
    pub stake: Account<'info, Stake>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CapacityView<'info> {
    #[account(seeds = [CONFIG_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [STAKE_SEED, config.mint.as_ref(), stake.owner.as_ref()], bump = stake.bump)]
    pub stake: Account<'info, Stake>,
}

#[event]
pub struct ConfigCreated {
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub desk_unit: u64,
    pub shield_unit: u64,
}

#[event]
pub struct Staked {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct UnstakeRequested {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub ready_at: i64,
}

#[event]
pub struct Unstaked {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum StakeError {
    #[msg("amount must be positive")]
    Amount,
    #[msg("more than staked")]
    MoreThanStaked,
    #[msg("nothing pending")]
    NothingPending,
    #[msg("cooldown has not passed")]
    Cooldown,
    #[msg("stake account is not empty")]
    NotEmpty,
    #[msg("mint decimals too large")]
    Decimals,
    #[msg("arithmetic overflow")]
    Overflow,
}
