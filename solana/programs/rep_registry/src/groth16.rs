//! Groth16 verification over BN254 with the alt_bn128 syscalls (big-endian encodings).
//!
//! Encodings (what the SDK sends):
//! - G1: x || y, 32-byte big-endian each.
//! - G2: x.c1 || x.c0 || y.c1 || y.c0 (EIP-197 order), 32-byte big-endian each.
//! - proof.a is sent NEGATED (x, q - y) so the check is one product of four pairings:
//!   e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1.
//! - public inputs: 32-byte big-endian, each strictly below the scalar field modulus r.
use anchor_lang::prelude::*;
use solana_bn254::prelude::{alt_bn128_g1_addition_be, alt_bn128_g1_multiplication_be, alt_bn128_pairing_be};

use crate::error::PoolError;

/// BN254 scalar field modulus r (the circuits' field), big-endian.
pub const FIELD_R: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

pub struct VerifyingKey {
    pub alpha_g1: [u8; 64],
    pub beta_g2: [u8; 128],
    pub gamma_g2: [u8; 128],
    pub delta_g2: [u8; 128],
    pub ic: &'static [[u8; 64]],
}

/// A Groth16 proof as the program receives it (`a` already negated).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Proof {
    pub a: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
}

/// True when `x` (big-endian) is a canonical field element (< r).
pub fn is_field(x: &[u8; 32]) -> bool {
    x < &FIELD_R // lexicographic comparison of big-endian bytes == numeric comparison
}

fn is_zero(x: &[u8; 32]) -> bool {
    x.iter().all(|b| *b == 0)
}

fn is_one(x: &[u8; 32]) -> bool {
    x[..31].iter().all(|b| *b == 0) && x[31] == 1
}

/// Verifies `proof` against `vk` and `inputs`. Errors on malformed inputs; returns Ok(false) only
/// when the pairing check fails.
pub fn verify(vk: &VerifyingKey, proof: &Proof, inputs: &[[u8; 32]]) -> Result<bool> {
    require!(inputs.len() + 1 == vk.ic.len(), PoolError::PublicInputCount);
    // vk_x = IC[0] + sum(input_i * IC[i + 1])
    let mut acc = [0u8; 128];
    acc[..64].copy_from_slice(&vk.ic[0]);
    let mut mul_in = [0u8; 96];
    for (i, x) in inputs.iter().enumerate() {
        require!(is_field(x), PoolError::InputNotInField);
        if is_zero(x) {
            continue;
        }
        let term: [u8; 64] = if is_one(x) {
            vk.ic[i + 1]
        } else {
            mul_in[..64].copy_from_slice(&vk.ic[i + 1]);
            mul_in[64..].copy_from_slice(x);
            let out = alt_bn128_g1_multiplication_be(&mul_in).map_err(|_| error!(PoolError::Bn254Syscall))?;
            out.as_slice().try_into().map_err(|_| error!(PoolError::Bn254Syscall))?
        };
        acc[64..].copy_from_slice(&term);
        let sum = alt_bn128_g1_addition_be(&acc).map_err(|_| error!(PoolError::Bn254Syscall))?;
        acc[..64].copy_from_slice(&sum);
    }

    let mut pairing = [0u8; 768];
    pairing[0..64].copy_from_slice(&proof.a);
    pairing[64..192].copy_from_slice(&proof.b);
    pairing[192..256].copy_from_slice(&vk.alpha_g1);
    pairing[256..384].copy_from_slice(&vk.beta_g2);
    pairing[384..448].copy_from_slice(&acc[..64]);
    pairing[448..576].copy_from_slice(&vk.gamma_g2);
    pairing[576..640].copy_from_slice(&proof.c);
    pairing[640..768].copy_from_slice(&vk.delta_g2);
    let out = alt_bn128_pairing_be(&pairing).map_err(|_| error!(PoolError::InvalidProofEncoding))?;
    Ok(out.len() == 32 && out[..31].iter().all(|b| *b == 0) && out[31] == 1)
}
