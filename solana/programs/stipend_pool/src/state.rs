use anchor_lang::prelude::*;

pub const LEVELS: usize = 20;
/// Committed roots kept in the ring: one per state-changing operation (not per leaf), so a proof stays
/// valid for the next ROOT_HISTORY - 1 operations. The EVM reference kept 128, one per leaf.
pub const ROOT_HISTORY: usize = 1024;

pub const POOL_SEED: &[u8] = b"pool";
pub const BUFFER_SEED: &[u8] = b"buf";
pub const NULLIFIER_SEED: &[u8] = b"nf";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ESCROW_SEED: &[u8] = b"owed";

/// Amounts inside the circuits are range-checked to 128 bits (StipendPool.MAX_AMOUNT). Token transfers on
/// Solana are additionally limited to u64.
pub const MAX_AMOUNT: u128 = u128::MAX;
/// `now` in a spend or delegate proof must fall inside this window around the Clock sysvar.
pub const NOW_LOOKBACK: i64 = 15 * 60;
pub const NOW_LOOKAHEAD: i64 = 60;
pub const GRANT_OUTPUTS: usize = 16;
pub const DELEGATE_OUTPUTS: usize = 4;

/// Merkle state only; no admin, no config. PDA ["pool"].
/// Layout (after the 8-byte discriminator): next_index u32 LE, current_root_index u32 LE,
/// filled_subtrees [20][32] BE field elements, roots [1024][32] ring of recent roots (one per operation).
/// SIZE (33,424 B) is above the 10,240 B a program may create by CPI: `initialize` creates the PDA at
/// INIT_LEN with no discriminator and `grow_pool` extends it by 10 KiB per call; the call that reaches SIZE
/// writes the discriminator and the empty tree. Until then no AccountLoader<Pool> loads it.
#[account(zero_copy)]
#[repr(C)]
pub struct Pool {
    pub next_index: u32,
    pub current_root_index: u32,
    pub filled_subtrees: [[u8; 32]; LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY],
}

impl Pool {
    pub const SIZE: usize = 8 + 4 + 4 + 32 * LEVELS + 32 * ROOT_HISTORY;
    /// Size `initialize` creates the PDA with (the CPI account-creation limit).
    pub const INIT_LEN: usize = if Self::SIZE < 10_240 { Self::SIZE } else { 10_240 };
}

const _: () = assert!(Pool::SIZE == 8 + core::mem::size_of::<Pool>());

/// Staging account for payloads larger than a transaction. PDA ["buf", authority, seed_le8].
/// Layout: discriminator(8) | authority(32) | seed u64 LE | len u32 LE | bump u8 | data[len].
#[account]
pub struct Buffer {
    pub authority: Pubkey,
    pub seed: u64,
    pub len: u32,
    pub bump: u8,
}

impl Buffer {
    pub const HEADER: usize = 8 + 32 + 8 + 4 + 1;
    /// Account creation through CPI (buffer_open) is limited to 10 KiB; larger buffers grow with
    /// `buffer_grow` (+10 KiB per instruction) up to MAX_LEN.
    pub const MAX_INIT: usize = 10_240 - Self::HEADER;
    /// Largest payload: a 16-way grant whose allowances are all pledged (three memo copies each).
    pub const MAX_LEN: usize = 96 * 1024;
}

/// Spent-nullifier marker. PDA ["nf", nullifier_be32]. Its existence is the spent flag; `init` of an
/// existing one fails, so a nullifier can be spent once.
#[account]
pub struct Nullifier {}

impl Nullifier {
    pub const SIZE: usize = 8;
}

pub const CONFIG_SEED: &[u8] = b"config";
pub const ASSET_CAP_SEED: &[u8] = b"cap";

/// Deposit guard. PDA ["config"], created by `initialize`. The authority can change deposit caps and pause
/// DEPOSITS only; nothing it controls can block a withdrawal, a spend or any other outflow, or move funds.
/// Setting the authority to the default pubkey renounces it (caps and pause state are then final).
#[account]
pub struct Config {
    pub authority: Pubkey,
    pub deposits_paused: bool,
    /// Caps a new vault's `AssetCap` starts with (`create_vault`).
    pub default_max_total: u64,
    pub default_max_per_deposit: u64,
    pub bump: u8,
}

impl Config {
    pub const SIZE: usize = 8 + 32 + 1 + 8 + 8 + 1;
}

/// Per-asset deposit caps. PDA ["cap", mint], created with the vault. A deposit must not exceed
/// `max_per_deposit`, and the vault balance after it must not exceed `max_total`.
#[account]
pub struct AssetCap {
    pub mint: Pubkey,
    pub max_total: u64,
    pub max_per_deposit: u64,
    pub bump: u8,
}

impl AssetCap {
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 1;
}
