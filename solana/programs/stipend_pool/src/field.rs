//! Field encodings (design section 2) and the little big-integer arithmetic the pool needs.
//! fieldOf(pubkey) = big-endian integer of sha256(pubkey bytes)[0..20]  (160 bits, < r).
//! Field elements are 32-byte big-endian values below r.
use anchor_lang::prelude::*;

use crate::groth16::FIELD_R;

pub type Fe = [u8; 32];
pub const ZERO: Fe = [0u8; 32];

pub fn field_of(key: &Pubkey) -> Fe {
    let h = solana_sha256_hasher::hashv(&[key.as_ref()]).to_bytes();
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(&h[..20]);
    out
}

/// fieldOf, with the all-zero pubkey (Pubkey::default) standing for "no address" (0), like address(0).
pub fn field_of_opt(key: &Pubkey) -> Fe {
    if *key == Pubkey::default() {
        ZERO
    } else {
        field_of(key)
    }
}

pub fn u64_field(x: u64) -> Fe {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&x.to_be_bytes());
    out
}

pub fn u128_field(x: u128) -> Fe {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&x.to_be_bytes());
    out
}

pub fn is_zero(x: &Fe) -> bool {
    x.iter().all(|b| *b == 0)
}

/// a - b over 256 bits; returns (difference, borrow).
fn sub256(a: &Fe, b: &Fe) -> (Fe, bool) {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = a[i] as i16 - b[i] as i16 - borrow;
        if d < 0 {
            d += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[i] = d as u8;
    }
    (out, borrow != 0)
}

/// a + b over 256 bits (wrapping).
fn add256(a: &Fe, b: &Fe) -> Fe {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let s = a[i] as u16 + b[i] as u16 + carry;
        out[i] = s as u8;
        carry = s >> 8;
    }
    out
}

/// (a - b) mod r for canonical a, b.
pub fn sub_mod(a: &Fe, b: &Fe) -> Fe {
    let (d, borrow) = sub256(a, b);
    if borrow {
        add256(&d, &FIELD_R)
    } else {
        d
    }
}

/// x mod r for any 256-bit x (r > 2^253, so at most a few subtractions).
pub fn reduce(mut x: Fe) -> Fe {
    while x >= FIELD_R {
        x = sub256(&x, &FIELD_R).0;
    }
    x
}

/// keccak256(data) mod r: the extDataHash of an operation's borsh-encoded ext data.
pub fn hash_to_field(data: &[u8]) -> Fe {
    reduce(solana_keccak_hasher::hash(data).to_bytes())
}

/// StipendPool._publicAmount: (extAmount - fee) mod r.
pub fn public_amount(ext_amount: i128, fee: u128) -> Fe {
    let base = if ext_amount >= 0 {
        u128_field(ext_amount as u128)
    } else {
        sub_mod(&ZERO, &u128_field(ext_amount.unsigned_abs()))
    };
    sub_mod(&base, &u128_field(fee))
}

/// A token amount from a u128 the proof fixed; transfers are u64 on Solana.
pub fn token_amount(x: u128) -> Result<u64> {
    u64::try_from(x).map_err(|_| error!(crate::error::PoolError::AmountOverflow))
}
