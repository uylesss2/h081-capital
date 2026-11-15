//! The reputation tree: same hashing, zero values and frontier algorithm as stipend_pool's merkle.rs (and
//! src/merkle.ts / circuits/lib/merkle.circom), over RepTree. One leaf and one committed root per attest.
use anchor_lang::prelude::*;
use solana_poseidon::{hashv, Endianness, Parameters};

use crate::generated::zeros::ZEROS;
use crate::groth16::is_field;
use crate::{RepError, RepTree, DOM_REP, LEVELS, ROOT_HISTORY};

pub fn u64_fe(x: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&x.to_be_bytes());
    out
}

/// Poseidon(left, right), circom-compatible (BN254, x^5), big-endian.
pub fn hash_left_right(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    require!(is_field(left) && is_field(right), RepError::InputNotInField);
    let h = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[left, right]).map_err(|_| error!(RepError::PoseidonSyscall))?;
    Ok(h.to_bytes())
}

/// R = Poseidon(13, agent_pk, loan_ref, principal, asset_f, lender_f, funded_day, 1) (outcome 1 = repaid).
pub fn rep_leaf(agent_pk: &[u8; 32], loan_ref: u64, principal: u64, asset_f: &[u8; 32], lender_f: &[u8; 32], funded_day: u32) -> Result<[u8; 32]> {
    require!(is_field(agent_pk), RepError::BadAgentKey);
    let parts: [[u8; 32]; 8] = [
        u64_fe(DOM_REP),
        *agent_pk,
        u64_fe(loan_ref),
        u64_fe(principal),
        *asset_f,
        *lender_f,
        u64_fe(funded_day as u64),
        u64_fe(1),
    ];
    let refs: [&[u8]; 8] = [&parts[0], &parts[1], &parts[2], &parts[3], &parts[4], &parts[5], &parts[6], &parts[7]];
    let h = hashv(Parameters::Bn254X5, Endianness::BigEndian, &refs).map_err(|_| error!(RepError::PoseidonSyscall))?;
    Ok(h.to_bytes())
}

pub fn init_tree(t: &mut RepTree) {
    for i in 0..LEVELS {
        t.filled_subtrees[i] = ZEROS[i];
    }
    for r in t.roots.iter_mut() {
        *r = [0u8; 32];
    }
    t.roots[0] = ZEROS[LEVELS];
    t.current_root_index = 0;
    t.next_index = 0;
}

fn staging_slot(t: &RepTree) -> usize {
    (t.current_root_index as usize + 1) % ROOT_HISTORY
}

/// Appends `leaf`, stages the new root in the next ring slot and returns the leaf index (see stipend_pool merkle.rs).
pub fn insert(t: &mut RepTree, leaf: &[u8; 32]) -> Result<u32> {
    let index = t.next_index;
    require!((index as u64) < (1u64 << LEVELS), RepError::TreeFull);
    let mut i = index;
    let mut current = *leaf;
    for level in 0..LEVELS {
        let (left, right) = if i % 2 == 0 {
            t.filled_subtrees[level] = current;
            (current, ZEROS[level])
        } else {
            (t.filled_subtrees[level], current)
        };
        current = hash_left_right(&left, &right)?;
        i /= 2;
    }
    let slot = staging_slot(t);
    t.roots[slot] = current;
    t.next_index = index + 1;
    Ok(index)
}

pub fn commit_root(t: &mut RepTree) {
    t.current_root_index = staging_slot(t) as u32;
}

/// Whether `root` is one of the last ROOT_HISTORY committed roots (never the zero root).
pub fn is_known_root(t: &RepTree, root: &[u8; 32]) -> bool {
    if root.iter().all(|b| *b == 0) {
        return false;
    }
    let current = t.current_root_index as usize;
    (0..ROOT_HISTORY).any(|k| t.roots[(current + ROOT_HISTORY - k) % ROOT_HISTORY] == *root)
}

pub fn last_root(t: &RepTree) -> [u8; 32] {
    t.roots[t.current_root_index as usize]
}
