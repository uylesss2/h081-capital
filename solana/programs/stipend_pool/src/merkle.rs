//! Append-only Poseidon Merkle tree with a ring of recent roots. Mirrors src/merkle.ts,
//! circuits/lib/merkle.circom and contracts/MerkleTreeWithHistory.sol (history 128, as in the EVM pool).
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
    pool.roots[0] = ZEROS[LEVELS];
    pool.current_root_index = 0;
    pool.next_index = 0;
}

/// Inserts `leaf` and returns its index.
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
    let next_root = (pool.current_root_index + 1) % ROOT_HISTORY as u32;
    pool.current_root_index = next_root;
    pool.roots[next_root as usize] = current;
    pool.next_index = index + 1;
    Ok(index)
}

pub fn is_known_root(pool: &Pool, root: &[u8; 32]) -> bool {
    if root.iter().all(|b| *b == 0) {
        return false;
    }
    pool.roots.iter().any(|r| r == root)
}

pub fn last_root(pool: &Pool) -> [u8; 32] {
    pool.roots[pool.current_root_index as usize]
}
