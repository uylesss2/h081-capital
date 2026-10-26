use anchor_lang::prelude::*;

pub const LEVELS: usize = 20;
/// Same as MerkleTreeWithHistory.ROOT_HISTORY_SIZE in the EVM reference.
pub const ROOT_HISTORY: usize = 128;

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
/// filled_subtrees [20][32] BE field elements, roots [128][32] ring of recent roots.
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
}

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
