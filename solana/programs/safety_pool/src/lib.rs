//! safety_pool: H081 stakers insure lenders against a stream-backed loan that is not repaid
//! (Phase 2, docs/SOLANA-PORT.md section 3.3). Port of contracts/token/SafetyPool.sol.
//!
//! - One pool per mint (`SafetyConfig`, PDA ["safety", mint]). Only the program's upgrade authority may
//!   create one (`init_pool`, ProgramData check as in stipend_pool); it names the pool's config authority.
//! - The config authority caps and pauses DEPOSITS only (`set_deposit_caps`, `set_deposits_paused`):
//!   unbonding, withdrawals and slashes are never paused. It is also the pool's underwriter: `insure`
//!   needs its signature, and it sets which loan asset is insurable, the per-cover and total cover limits
//!   and the premium floor (`set_underwriting`). Until it does, nothing can be insured.
//! - Stakers `deposit` for shares at the price (assets + 10^6) / (total shares + 10^9). The virtual shares and
//!   assets (an offset in the style of OpenZeppelin ERC4626) make share-price inflation by a first depositor
//!   unprofitable, and the pool's assets are an accounted figure (`SafetyConfig.assets`, moved only by
//!   deposits, premiums, top-ups, withdrawals and slashes), so tokens sent straight to the vault never move
//!   the price; they stay in the vault unaccounted. Premiums and top-ups raise the price, slashes lower it.
//!   `request_unbond` starts a 14-day cooldown during which the shares stay at risk; `withdraw` redeems them at the price on that day.
//! - `insure(loan_ref, premium, cover)`: the stream_loan slot's lender AND the pool's underwriter sign; only
//!   for a loan in the pool's insurable asset that is funded, not settled, has an expiry, and whose
//!   expiry + grace is at least one unbonding cooldown away (stakers can leave before it can be slashed).
//!   `cover` (the most a slash can pay) is at most the principal and the per-cover limit; open cover in
//!   the pool stays under the total limit; the premium is at least min_premium_bps of the cover. One cover
//!   per loan ref across every mint's pool (PDA ["cover", loan_ref]) so a loan cannot be insured twice.
//!   `release_cover` (anyone) frees the cover's exposure once the loan is settled or repaid.
//! - `slash(loan_ref)`: anyone, once stream_loan's state shows a shortfall (expiry + 7-day grace passed,
//!   repaid below principal, not settled; shares routed to the loan but still unsynced in the slot inbox or
//!   held in the stipend_pool escrow count as repaid). Pays the cover's lender min(shortfall, pool assets) of the
//!   pool's token, valued 1:1 in base units (see caveats), never more than the cover, and marks the cover
//!   paid. A slash with an empty pool fails (`PoolEmpty`) so the cover stays open. A slash that takes the
//!   whole pool, or leaves the share price below 1/MAX_SHARES_PER_ASSET, bumps the generation, retiring every
//!   share (including unbonding ones); the next deposit starts a fresh share count.
//! - `top_up(amount)`: anyone adds tokens to the pool's assets without minting shares, raising what every
//!   outstanding share (unbonding ones too) redeems for. The H081 flywheel pays stakers this way from
//!   PLATFORM fees only (docs/FLYWHEEL.md). Refused while no shares exist (nobody to pay; the tokens would
//!   go to the next depositor), refused above the pool's current assets (one top-up at most doubles it),
//!   and refused from the token launch wallets (`LAUNCH_WALLETS`): the token's trading creator fees are
//!   never a source. The virtual 10^6 base units of assets mean a dust stake earns only its proportional
//!   share of a top-up (a 1-unit stake gets about a millionth of it, not half).
//!
//! CAVEATS (docs/tokenomics.md, restated): the valuation is 1:1 in base units and ignores the H081 price;
//! the underwriter must size cover and premium accordingly. A lender can still fund a loan to a borrower it
//! controls; only the underwriter's signature stands between such a loan and the pool, so stakers trust the
//! config authority. A loan with no expiry never reports a shortfall and cannot be insured.
//! No upgrade logic.
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

pub mod stream_loan_view;
use stream_loan_view::{load_slot, pending_in_escrow, pending_in_inbox, shortfall_of};

#[cfg(not(feature = "fast"))]
declare_id!("EvKjwxVQX1RhyoBXisdbzk1JGLb5fMgZzHVLQAiPKJwe");
#[cfg(feature = "fast")]
declare_id!("5K2L3eNBzmeznEZpY4vav74UHRaBHgQJv582W5i4kT7");

/// Localnet program id (solana/keys/safety_pool-keypair.json). A mainnet build patches declare_id to the
/// mainnet key (solana/scripts/build-phase2-mainnet.sh) and refuses to compile if it is still this one.
pub const LOCALNET_ID: Pubkey = pubkey!("EvKjwxVQX1RhyoBXisdbzk1JGLb5fMgZzHVLQAiPKJwe");
#[cfg(all(feature = "mainnet", feature = "fast"))]
compile_error!("the mainnet build cannot use the fast (test) feature");
#[cfg(feature = "mainnet")]
const _: () = assert!(!stream_loan_view::same(&ID, &LOCALNET_ID), "mainnet build: declare_id is still the localnet safety_pool key");

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

/// Virtual shares and assets added to the pool's totals when pricing shares (see the module docs). The
/// first deposit gets 1,000 shares per base unit; the 10^6 virtual base units keep a dust stake from
/// capturing a top-up or premium paid into an almost empty pool.
pub const VIRTUAL_SHARES: u128 = 1_000_000_000;
pub const VIRTUAL_ASSETS: u128 = 1_000_000;
/// A slash that leaves more than this many shares per base unit (the price fell 10^6-fold from the first
/// deposit's 1,000) retires the generation, so a dust remainder cannot blow up later share counts.
pub const MAX_SHARES_PER_ASSET: u128 = 1_000_000_000;
/// Basis-point denominator of min_premium_bps.
pub const BPS: u128 = 10_000;

/// Upgrade authority recorded in a BPF upgradeable loader ProgramData account (same parser as
/// stipend_pool::upgrade_authority): u32 LE tag 3 | slot u64 | Option<Pubkey>. None when immutable.
pub fn upgrade_authority(info: &AccountInfo) -> Result<Option<Pubkey>> {
    require_keys_eq!(*info.owner, bpf_loader_upgradeable::ID, SafetyError::UpgradeAuthority);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 45 && data[..4] == [3, 0, 0, 0], SafetyError::UpgradeAuthority);
    Ok(match data[12] {
        0 => None,
        1 => Some(Pubkey::new_from_array(data[13..45].try_into().unwrap())),
        _ => return err!(SafetyError::UpgradeAuthority),
    })
}

/// True when a pool with `assets` against `total` shares has collapsed past MAX_SHARES_PER_ASSET.
pub fn collapsed(assets: u64, total: u128) -> bool {
    total > (assets as u128 + VIRTUAL_ASSETS).saturating_mul(MAX_SHARES_PER_ASSET)
}

/// Least premium for `cover`: cover * min_premium_bps / 10,000, rounded up.
pub fn min_premium(cover: u64, min_premium_bps: u16) -> u64 {
    let x = (cover as u128) * (min_premium_bps as u128);
    x.div_ceil(BPS) as u64
}

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

/// a * b / c rounded down, through a 256-bit product: fails only when c == 0 or the quotient exceeds u128.
pub fn mul_div(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c != 0, SafetyError::Overflow);
    if let Some(p) = a.checked_mul(b) {
        return Ok(p / c);
    }
    let (hi, lo) = mul_wide(a, b);
    require!(hi < c, SafetyError::Overflow);
    // long division of hi:lo by c; rem < c holds before every step
    let mut rem = hi;
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let carry = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || rem >= c {
            rem = rem.wrapping_sub(c);
            q |= 1;
        }
    }
    Ok(q)
}

/// Full 256-bit product of two u128 values as (high, low).
pub fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & M);
    let (b1, b0) = (b >> 64, b & M);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    let lo = (p00 & M) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

#[program]
pub mod safety_pool {
    use super::*;

    /// Creates the per-mint pool and its vault, naming its config authority and deposit caps. Only the
    /// program's upgrade authority (read from its ProgramData account); `init` makes a second call fail.
    /// Nothing is insurable until the config authority calls `set_underwriting`.
    pub fn init_pool(ctx: Context<InitPool>, config_authority: Pubkey, max_total: u64, max_per_deposit: u64) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.authority = config_authority;
        c.deposits_paused = false;
        c.max_total = max_total;
        c.max_per_deposit = max_per_deposit;
        c.loan_asset = Pubkey::default();
        c.max_cover = 0;
        c.max_exposure = 0;
        c.min_premium_bps = 0;
        c.exposure = 0;
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

    /// Config authority: deposit caps (on the pool's accounted assets after a deposit, and per deposit).
    /// A cap below the current assets only blocks new deposits.
    pub fn set_deposit_caps(ctx: Context<SetPoolConfig>, max_total: u64, max_per_deposit: u64) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.max_total = max_total;
        c.max_per_deposit = max_per_deposit;
        emit!(PoolConfigChanged { mint: c.mint });
        Ok(())
    }

    /// Config authority: pauses or resumes DEPOSITS and new covers. Unbonding, withdrawals, slashes,
    /// top-ups and releases are never paused.
    pub fn set_deposits_paused(ctx: Context<SetPoolConfig>, paused: bool) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.deposits_paused = paused;
        emit!(PoolConfigChanged { mint: c.mint });
        Ok(())
    }

    /// Config authority: which stream_loan asset the pool insures (the default pubkey: none), the most one
    /// cover may pay, the most open cover in total, and the premium floor in bps of the cover.
    pub fn set_underwriting(ctx: Context<SetPoolConfig>, loan_asset: Pubkey, max_cover: u64, max_exposure: u64, min_premium_bps: u16) -> Result<()> {
        require!((min_premium_bps as u128) <= BPS, SafetyError::PremiumTooLow);
        let c = &mut ctx.accounts.config;
        c.loan_asset = loan_asset;
        c.max_cover = max_cover;
        c.max_exposure = max_exposure;
        c.min_premium_bps = min_premium_bps;
        emit!(PoolConfigChanged { mint: c.mint });
        Ok(())
    }

    /// Config authority: hands the authority to `new_authority` (the default pubkey renounces it, which
    /// also ends underwriting: no new cover can be signed).
    pub fn set_config_authority(ctx: Context<SetPoolConfig>, new_authority: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.authority = new_authority;
        emit!(PoolConfigChanged { mint: c.mint });
        Ok(())
    }

    /// Puts `amount` at risk; shares are minted at the current price on what the vault received.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, SafetyError::Amount);
        require!(!ctx.accounts.config.deposits_paused, SafetyError::DepositsPaused);
        require!(amount <= ctx.accounts.config.max_per_deposit, SafetyError::DepositCap);
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
        let after = ctx.accounts.config.assets.checked_add(received).ok_or(error!(SafetyError::Overflow))?;
        require!(after <= ctx.accounts.config.max_total, SafetyError::DepositCap);
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

    /// The slot's lender binds its funded loan to this pool for at most `cover` and pays `premium` in; the
    /// pool's underwriter (config authority) co-signs. See the module docs for every limit.
    pub fn insure(ctx: Context<Insure>, loan_ref: u64, premium: u64, cover: u64) -> Result<()> {
        let s = load_slot(&ctx.accounts.slot, loan_ref)?;
        let lender = ctx.accounts.lender.key();
        require_keys_eq!(s.lender, lender, SafetyError::NotTheLender);
        require!(s.funded, SafetyError::NoLoan);
        require!(!s.settled, SafetyError::Settled);
        require!(s.expiry != 0, SafetyError::NoDueDate);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= 0 && (now as u64) <= s.expiry, SafetyError::Expired);
        let cfg = &ctx.accounts.config;
        require!(!cfg.deposits_paused, SafetyError::DepositsPaused);
        require!(cfg.loan_asset != Pubkey::default() && s.asset == cfg.loan_asset, SafetyError::NotInsurable);
        // stakers who object to a new cover can unbond and leave before it can be slashed
        let earliest_slash = s.expiry.saturating_add(GRACE);
        require!(earliest_slash >= (now as u64).saturating_add(COOLDOWN as u64), SafetyError::TooShort);
        require!(cover > 0 && cover <= cfg.max_cover && cover <= s.principal, SafetyError::CoverTooLarge);
        let exposure = cfg.exposure.checked_add(cover).ok_or(error!(SafetyError::Overflow))?;
        require!(exposure <= cfg.max_exposure, SafetyError::ExposureCap);
        require!(premium >= min_premium(cover, cfg.min_premium_bps), SafetyError::PremiumTooLow);
        ctx.accounts.config.exposure = exposure;

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
            // the floor holds on what the vault received (a Token-2022 transfer fee cannot shave it)
            require!(received >= min_premium(cover, ctx.accounts.config.min_premium_bps), SafetyError::PremiumTooLow);
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
        c.limit = cover;
        c.released = false;
        emit!(Insured { loan_ref, mint: c.mint, lender, premium: received, cover });
        Ok(())
    }

    /// Anyone: pays the lender of an insured loan stream_loan's shortfall, capped by the pool.
    pub fn slash(ctx: Context<Slash>, loan_ref: u64) -> Result<()> {
        require!(!ctx.accounts.cover.paid, SafetyError::AlreadyPaid);
        require!(!ctx.accounts.cover.released, SafetyError::Released);
        let shortfall = current_shortfall(&ctx.accounts.slot, &ctx.accounts.inbox, &ctx.accounts.ledger, &ctx.accounts.escrow, loan_ref)?;
        require!(shortfall > 0, SafetyError::NoShortfall);
        let balance = ctx.accounts.config.assets;
        require!(balance > 0, SafetyError::PoolEmpty);
        let limit = ctx.accounts.cover.limit;
        let pay = shortfall.min(balance).min(limit);
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
        c.exposure = c.exposure.saturating_sub(limit);
        if c.total_shares > 0 && (c.assets == 0 || collapsed(c.assets, c.total_shares)) {
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
        require!(amount <= ctx.accounts.config.assets, SafetyError::TopUpTooLarge);
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

    /// Anyone: frees an unpaid cover's exposure once its loan is settled or repaid in full (repaid plus
    /// routed-but-unsynced value covers the principal). The cover can no longer be slashed.
    pub fn release_cover(ctx: Context<ReleaseCover>, loan_ref: u64) -> Result<()> {
        let cover = &ctx.accounts.cover;
        require!(!cover.paid && !cover.released, SafetyError::Released);
        let s = load_slot(&ctx.accounts.slot, loan_ref)?;
        let slot_key = ctx.accounts.slot.key();
        let done = s.settled || {
            let pending = pending_in_inbox(&slot_key, &s, &ctx.accounts.inbox, &ctx.accounts.ledger)?
                .saturating_add(pending_in_escrow(&slot_key, &s, &ctx.accounts.escrow)?);
            s.repaid.saturating_add(pending) >= s.principal
        };
        require!(done, SafetyError::NotReleasable);
        let limit = cover.limit;
        ctx.accounts.cover.released = true;
        let c = &mut ctx.accounts.config;
        c.exposure = c.exposure.saturating_sub(limit);
        emit!(CoverReleased { loan_ref, mint: c.mint, limit });
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
    /// Config authority: deposit caps and pause, and the pool's underwriter (co-signs every insure).
    pub authority: Pubkey,
    /// Pauses deposits and new covers only.
    pub deposits_paused: bool,
    /// Most accounted assets a deposit may bring the pool to.
    pub max_total: u64,
    /// Most one deposit may bring in.
    pub max_per_deposit: u64,
    /// The only stream_loan asset this pool insures (default pubkey: none).
    pub loan_asset: Pubkey,
    /// Most one cover may pay (pool base units).
    pub max_cover: u64,
    /// Most open cover in total (sum of unpaid, unreleased covers' limits).
    pub max_exposure: u64,
    /// Premium floor, in bps of the cover.
    pub min_premium_bps: u16,
    /// Open cover now.
    pub exposure: u64,
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
    /// Most a slash of this cover pays.
    pub limit: u64,
    /// Freed by release_cover (loan settled or repaid); cannot be slashed.
    pub released: bool,
}

#[derive(Accounts)]
pub struct SetPoolConfig<'info> {
    #[account(mut, seeds = [SAFETY_SEED, config.mint.as_ref()], bump = config.bump, has_one = authority @ SafetyError::ConfigAuthority)]
    pub config: Account<'info, SafetyConfig>,
    pub authority: Signer<'info>,
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
    /// Must be the program's upgrade authority.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// CHECK: this program's ProgramData account (PDA [program id] of the BPF upgradeable loader); its
    /// upgrade authority must be the payer (parsed by upgrade_authority).
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = upgrade_authority(&program_data)? == Some(payer.key()) @ SafetyError::UpgradeAuthority
    )]
    pub program_data: UncheckedAccount<'info>,
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
    /// The pool's config authority, underwriting this cover.
    #[account(address = config.authority @ SafetyError::ConfigAuthority)]
    pub underwriter: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct ReleaseCover<'info> {
    #[account(mut, seeds = [SAFETY_SEED, config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, SafetyConfig>,
    #[account(mut, seeds = [COVER_SEED, &loan_ref.to_le_bytes()], bump = cover.bump, constraint = cover.mint == config.mint @ SafetyError::WrongPool)]
    pub cover: Account<'info, Cover>,
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
    pub cover: u64,
}

#[event]
pub struct CoverReleased {
    pub loan_ref: u64,
    pub mint: Pubkey,
    pub limit: u64,
}

#[event]
pub struct PoolConfigChanged {
    pub mint: Pubkey,
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
    #[msg("signer is not the program's upgrade authority")]
    UpgradeAuthority,
    #[msg("signer is not the pool's config authority")]
    ConfigAuthority,
    #[msg("deposits are paused")]
    DepositsPaused,
    #[msg("deposit above the pool's caps")]
    DepositCap,
    #[msg("the loan's asset is not insurable by this pool")]
    NotInsurable,
    #[msg("cover is zero, above the principal or above the per-cover limit")]
    CoverTooLarge,
    #[msg("premium below the pool's floor")]
    PremiumTooLow,
    #[msg("open cover would exceed the pool's limit")]
    ExposureCap,
    #[msg("the loan can be slashed before stakers could unbond")]
    TooShort,
    #[msg("cover already paid or released")]
    Released,
    #[msg("loan neither settled nor repaid")]
    NotReleasable,
    #[msg("top-up larger than the pool's assets")]
    TopUpTooLarge,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide_eq(a: u128, b: u128, q: u128, c: u128) {
        // a * b == q * c + r with r < c
        let (h1, l1) = mul_wide(a, b);
        let (h2, l2) = mul_wide(q, c);
        let r = l1.wrapping_sub(l2);
        let borrow = (l1 < l2) as u128;
        assert_eq!(h1 - h2 - borrow, 0, "remainder exceeds 128 bits");
        assert!(r < c, "remainder not below divisor");
    }

    #[test]
    fn mul_div_matches_u128_and_handles_wide_products() {
        for (a, b, c) in [(0u128, 5u128, 3u128), (7, 9, 2), (u64::MAX as u128, u64::MAX as u128, 1), (1_000, 999, 7)] {
            assert_eq!(mul_div(a, b, c).unwrap(), a * b / c);
        }
        // the reviewer's case: 5e27 shares * 1e12 assets / 1e28 total
        let (a, b, c) = (5_000_000_000_000_000_000_000_000_000u128, 1_000_000_000_001u128, 10_000_000_000_000_000_000_000_000_000u128);
        let q = mul_div(a, b, c).unwrap();
        assert_eq!(q, 500_000_000_000);
        wide_eq(a, b, q, c);
        let big = [u128::MAX, u128::MAX - 1, 1u128 << 127, (1u128 << 100) + 12345, 3u128.pow(80)];
        for &x in &big {
            for &y in &big {
                for &d in &big {
                    match mul_div(x, y, d) {
                        Ok(q) => wide_eq(x, y, q, d),
                        Err(_) => assert!(mul_wide(x, y).0 >= d),
                    }
                }
            }
        }
        assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX).unwrap(), u128::MAX);
        assert!(mul_div(1, 1, 0).is_err());
    }

    #[test]
    fn dust_stake_gets_a_proportional_share_of_a_top_up() {
        let s = shares_for(1, 0, 0).unwrap();
        assert_eq!(s, 1_000);
        // a 1,000,000-unit top-up: the dust stake redeems for ~1 unit, not half
        let v = assets_for(s, 1 + 1_000_000, s).unwrap();
        assert!(v <= 2, "dust stake got {v}");
    }

    #[test]
    fn dust_slash_is_retired_and_no_withdraw_overflows() {
        // 10M tokens staked (6 decimals), then a slash that leaves 1 base unit
        let total = shares_for(10_000_000_000_000, 0, 0).unwrap();
        assert!(collapsed(1, total));
        assert!(!collapsed(10_000_000_000_000, total));
        // even without retiring, a later 1M-token depositor can always withdraw
        let d = shares_for(1_000_000_000_000, 1, total).unwrap();
        let out = assets_for(d, 1_000_000_000_001, total + d).unwrap();
        assert!(out <= 1_000_000_000_001);
    }

    #[test]
    fn premium_floor_rounds_up() {
        assert_eq!(min_premium(0, 100), 0);
        assert_eq!(min_premium(1, 100), 1);
        assert_eq!(min_premium(10_000, 100), 100);
        assert_eq!(min_premium(10_001, 100), 101);
        assert_eq!(min_premium(u64::MAX, 10_000), u64::MAX);
    }
}
