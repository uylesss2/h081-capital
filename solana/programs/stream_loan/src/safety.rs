//! The safety_pool programs this registry trusts to record a slash (`record_slash`). A slash is recorded
//! only when the instruction is signed by a safety_pool `SafetyConfig` PDA ["safety", mint]; PDAs have no
//! key, so only the safety_pool program itself can sign for one (by CPI from its `slash`).
//!
//! The ids are compile-time constants like POOL_PROGRAM_ID: the mainnet deployment with `--features
//! mainnet`, the localnet keys otherwise (safety_pool and its `fast` test variant, which the staking suite
//! runs against the same stream_loan). Mirror of safety_pool's declare_id and SafetyConfig layout
//! (mint is the first field after the discriminator).
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

/// safety_pool's SafetyConfig seed.
pub const SAFETY_SEED: &[u8] = b"safety";

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
