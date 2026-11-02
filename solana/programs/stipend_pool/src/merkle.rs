//! Append-only Poseidon Merkle tree with a ring of recent roots. Mirrors src/merkle.ts and
//! circuits/lib/merkle.circom (same hashing and zero values as contracts/MerkleTreeWithHistory.sol).
//!
//! Roots are recorded once per INSTRUCTION, not once per leaf: `insert` updates the frontier
//! (`filled_subtrees`, `next_index`) and stages the new root in the ring slot after the current one without
//! advancing `current_root_index`; `commit_root` then advances the ring once. Every state-changing operation
//! (transact, grant, spend, delegate) checks its proof's root BEFORE its inserts and commits exactly once
//! after them, so one operation evicts exactly one old root however many notes it adds. With
//! ROOT_HISTORY = 1024 a proof stays valid for the next 1023 operations (the EVM pool kept 128 roots, one
//! per leaf, which cheap no-token operations could flush; see docs/SOLANA-PORT.md).
use anchor_lang::prelude::*;
use solana_poseidon::{hashv, Endianness, Parameters};

use crate::error::PoolError;
use crate::generated::zeros::ZEROS;
use crate::groth16::is_field;
use crate::state::{Pool, LEVELS, ROOT_HISTORY};

/// Poseidon(left, right), circom-compatible (BN254, x^5, t = 3), big-endian.
pub fn hash_left_right(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    require!(is_field(left) && is_field(right), PoolError::InputNotInField);
    let h = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[left, right]).map_err(|_| error!(PoolError::PoseidonSyscall))?;
    Ok(h.to_bytes())
}

pub fn init_tree(pool: &mut Pool) {
    for i in 0..LEVELS {
        pool.filled_subtrees[i] = ZEROS[i];
    }
    for r in pool.roots.iter_mut() {
        *r = [0u8; 32];
    }
    pool.roots[0] = ZEROS[LEVELS];
    pool.current_root_index = 0;
    pool.next_index = 0;
}

/// Ring slot after the current root: where `insert` stages and `commit_root` moves to.
fn staging_slot(pool: &Pool) -> usize {
    (pool.current_root_index as usize + 1) % ROOT_HISTORY
}

/// Appends `leaf` and returns its index. The tree root after it is STAGED in the next ring slot (overwriting
/// the oldest root, which the following `commit_root` evicts anyway); `current_root_index` does not move.
/// Callers must check proof roots before inserting and call `commit_root` once after their last insert.
pub fn insert(pool: &mut Pool, leaf: &[u8; 32]) -> Result<u32> {
    let index = pool.next_index;
    require!((index as u64) < (1u64 << LEVELS), PoolError::TreeFull);
    let mut i = index;
    let mut current = *leaf;
    for level in 0..LEVELS {
        let (left, right) = if i % 2 == 0 {
            pool.filled_subtrees[level] = current;
            (current, ZEROS[level])
        } else {
            (pool.filled_subtrees[level], current)
        };
        current = hash_left_right(&left, &right)?;
        i /= 2;
    }
    let slot = staging_slot(pool);
    pool.roots[slot] = current;
    pool.next_index = index + 1;
    Ok(index)
}

/// Publishes the root staged by the last `insert`: advances the ring by exactly one slot.
pub fn commit_root(pool: &mut Pool) {
    pool.current_root_index = staging_slot(pool) as u32;
}

/// Whether `root` is one of the last ROOT_HISTORY committed roots. Scans newest first, so a proof against a
/// recent root is found after a few comparisons (the zero root is never known).
pub fn is_known_root(pool: &Pool, root: &[u8; 32]) -> bool {
    if root.iter().all(|b| *b == 0) {
        return false;
    }
    let current = pool.current_root_index as usize;
    (0..ROOT_HISTORY).any(|k| pool.roots[(current + ROOT_HISTORY - k) % ROOT_HISTORY] == *root)
}

pub fn last_root(pool: &Pool) -> [u8; 32] {
    pool.roots[pool.current_root_index as usize]
}
