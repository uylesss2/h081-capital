//! What stream_loan knows about safety_pool, read directly (no CPI, no crate dependency):
//!
//! 1. Which safety_pool programs may record a slash (`record_slash`). A slash is recorded only when the
//!    instruction is signed by a safety_pool `SafetyConfig` PDA ["safety", mint]; PDAs have no key, so only the
//!    safety_pool program itself can sign for one (by CPI from its `slash`). The ids are compile-time constants
//!    like POOL_PROGRAM_ID: the mainnet deployment with `--features mainnet`, the localnet keys otherwise
//!    (safety_pool and its `fast` test variant, which the staking suite runs against the same stream_loan).
//!    Mirror of safety_pool's declare_id and SafetyConfig layout (mint is the first field after the discriminator).
//!
//! 2. The one fact `close_slot` needs: is an insurance cover of this loan still open? safety_pool's
//!    `release_cover` reads the stream_loan Slot account, so a cover that is neither paid nor released when its
//!    slot is closed could never be released, and its exposure would block that pool's cover limit for good.
//!    `close_slot` therefore refuses while one is open (release_cover is permissionless and always succeeds on a
//!    settled loan). Must stay byte-compatible with programs/safety_pool (Cover PDA ["cover", loan_ref u64 LE],
//!    Anchor account "Cover"); safety_pool's state.rs is unchanged by the 2026-11-05 security release.
use anchor_lang::prelude::*;

use crate::error::LoanError;
use crate::pool::sighash;

/// Localnet safety_pool program id (solana/keys/safety_pool-keypair.json).
pub const LOCALNET_SAFETY_PROGRAM_ID: Pubkey = pubkey!("EvKjwxVQX1RhyoBXisdbzk1JGLb5fMgZzHVLQAiPKJwe");
/// Localnet-only `fast` test build of safety_pool (3 s cooldown, 2 s grace). Never deployed.
pub const LOCALNET_SAFETY_FAST_PROGRAM_ID: Pubkey = pubkey!("5K2L3eNBzmeznEZpY4vav74UHRaBHgQJv582W5i4kT7");
/// The safety_pool deployed on mainnet-beta (2026-10-31).
pub const MAINNET_SAFETY_PROGRAM_ID: Pubkey = pubkey!("HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt");

/// The safety_pool programs whose config PDAs may record a slash.
#[cfg(not(feature = "mainnet"))]
pub const SAFETY_PROGRAM_IDS: &[Pubkey] = &[LOCALNET_SAFETY_PROGRAM_ID, LOCALNET_SAFETY_FAST_PROGRAM_ID];
#[cfg(feature = "mainnet")]
pub const SAFETY_PROGRAM_IDS: &[Pubkey] = &[MAINNET_SAFETY_PROGRAM_ID];

/// The safety_pool whose Cover accounts `close_slot` reads (the deployed one; the `fast` variant is test-only).
#[cfg(not(feature = "mainnet"))]
pub const SAFETY_POOL_ID: Pubkey = LOCALNET_SAFETY_PROGRAM_ID;
#[cfg(feature = "mainnet")]
pub const SAFETY_POOL_ID: Pubkey = MAINNET_SAFETY_PROGRAM_ID;

/// safety_pool's SafetyConfig seed.
pub const SAFETY_SEED: &[u8] = b"safety";
/// safety_pool's Cover seed.
pub const COVER_SEED: &[u8] = b"cover";

/// Requires `info` to be a signing SafetyConfig PDA of one of SAFETY_PROGRAM_IDS: owned by that program,
/// carrying the `SafetyConfig` discriminator, and at ["safety", mint] under it (mint read from its data).
/// Returns the mint of that pool.
pub fn check_safety_config(info: &AccountInfo) -> Result<Pubkey> {
    require!(info.is_signer, LoanError::NotSafetyPool);
    require!(SAFETY_PROGRAM_IDS.contains(info.owner), LoanError::NotSafetyPool);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 40 && data[..8] == sighash("account", "SafetyConfig"), LoanError::NotSafetyPool);
    let mint = Pubkey::new_from_array(data[8..40].try_into().unwrap());
    let (expect, _) = Pubkey::find_program_address(&[SAFETY_SEED, mint.as_ref()], info.owner);
    require_keys_eq!(*info.key, expect, LoanError::NotSafetyPool);
    Ok(mint)
}

pub fn cover_address(loan_ref: u64) -> Pubkey {
    Pubkey::find_program_address(&[COVER_SEED, &loan_ref.to_le_bytes()], &SAFETY_POOL_ID).0
}

/// Cover layout after the 8-byte discriminator: loan_ref u64 | mint 32 | lender 32 | premium u64 | bound_at i64 |
/// paid bool | paid_out u64 | bump u8 | limit u64 | released bool.
const PAID: usize = 8 + 8 + 32 + 32 + 8 + 8;
const RELEASED: usize = PAID + 1 + 8 + 1 + 8;

/// True when safety_pool holds a cover of `loan_ref` that is neither paid nor released. The address is checked;
/// a missing account (never insured) is no cover.
pub fn cover_open(info: &AccountInfo, loan_ref: u64) -> Result<bool> {
    require_keys_eq!(*info.key, cover_address(loan_ref), LoanError::BadCover);
    if *info.owner != SAFETY_POOL_ID {
        return Ok(false);
    }
    let data = info.try_borrow_data()?;
    if data.is_empty() {
        return Ok(false);
    }
    require!(data.len() > RELEASED && data[..8] == sighash("account", "Cover"), LoanError::BadCover);
    Ok(data[PAID] == 0 && data[RELEASED] == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_offsets_match_safety_pool() {
        // Cover::INIT_SPACE in safety_pool = 8 + 32 + 32 + 8 + 8 + 1 + 8 + 1 + 8 + 1 = 107; released is the last byte
        assert_eq!(PAID, 96);
        assert_eq!(RELEASED, 8 + 107 - 1);
    }
}
