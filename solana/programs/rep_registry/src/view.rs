//! Read-only view of stream_loan accounts (no crate dependency, like safety_pool's stream_loan_view.rs).
//!   Slot        PDA ["slot", loan_ref u64 LE]          Anchor account "Slot", 253 bytes
//!   Subrogation PDA ["subrogation", loan_ref u64 LE]   created by stream_loan `record_slash`
//! Fields are read at fixed offsets; tests.rs checks every offset against stream_loan::state::Slot.
//!
//! RELEASE CHECKLIST: any stream_loan upgrade must re-run `cargo test -p rep_registry` (slot_offsets_match_stream_loan)
//! and re-check what `repaid` means: attest counts a loan once repaid >= principal. Today `repaid` only grows, except
//! legacy_release, which never takes it below the principal.
use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

use crate::RepError;

/// stream_loan program id: the mainnet deployment with `--features mainnet`, the localnet key otherwise.
pub const LOCALNET_STREAM_LOAN_ID: Pubkey = pubkey!("FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc");
pub const MAINNET_STREAM_LOAN_ID: Pubkey = pubkey!("8JBd7epQXxdcKRMaWM1S5PC7nsQKoZq3uCetpiJ684g4");
#[cfg(not(feature = "mainnet"))]
pub const STREAM_LOAN_ID: Pubkey = LOCALNET_STREAM_LOAN_ID;
#[cfg(feature = "mainnet")]
pub const STREAM_LOAN_ID: Pubkey = MAINNET_STREAM_LOAN_ID;

pub const SLOT_SEED: &[u8] = b"slot";
pub const SUBROGATION_SEED: &[u8] = b"subrogation";
pub const SLOT_SIZE: usize = 253;

/// Byte offsets inside the Slot account (the 8-byte discriminator included).
pub mod off {
    pub const LOAN_REF: usize = 8;
    pub const LENDER: usize = 16;
    pub const FUNDED: usize = 49;
    pub const ASSET: usize = 51;
    pub const PRINCIPAL: usize = 115;
    pub const REPAID: usize = 123;
    pub const AGENT_PK: usize = 173;
    pub const FUNDED_AT: usize = 205;
}

pub const fn same(a: &Pubkey, b: &Pubkey) -> bool {
    let (a, b) = (a.as_array(), b.as_array());
    let mut i = 0;
    while i < 32 {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

pub fn slot_discriminator() -> [u8; 8] {
    let h = hash(b"account:Slot").to_bytes();
    let mut d = [0u8; 8];
    d.copy_from_slice(&h[..8]);
    d
}

pub fn slot_address(loan_ref: u64) -> Pubkey {
    Pubkey::find_program_address(&[SLOT_SEED, &loan_ref.to_le_bytes()], &STREAM_LOAN_ID).0
}

pub fn subrogation_address(loan_ref: u64) -> Pubkey {
    Pubkey::find_program_address(&[SUBROGATION_SEED, &loan_ref.to_le_bytes()], &STREAM_LOAN_ID).0
}

/// The Slot fields attest reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotFacts {
    pub loan_ref: u64,
    pub lender: Pubkey,
    pub funded: bool,
    pub asset: Pubkey,
    pub principal: u64,
    pub repaid: u64,
    pub agent_pk: [u8; 32],
    pub funded_at: i64,
}

pub fn parse_slot(d: &[u8]) -> Option<SlotFacts> {
    if d.len() != SLOT_SIZE || d[..8] != slot_discriminator() {
        return None;
    }
    let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    let key_at = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
    let funded = match d[off::FUNDED] {
        0 => false,
        1 => true,
        _ => return None,
    };
    Some(SlotFacts {
        loan_ref: u64_at(off::LOAN_REF),
        lender: key_at(off::LENDER),
        funded,
        asset: key_at(off::ASSET),
        principal: u64_at(off::PRINCIPAL),
        repaid: u64_at(off::REPAID),
        agent_pk: d[off::AGENT_PK..off::AGENT_PK + 32].try_into().unwrap(),
        funded_at: u64_at(off::FUNDED_AT) as i64,
    })
}

/// Loads the stream_loan slot of `loan_ref`: owner, PDA, size and discriminator checked.
pub fn load_slot(info: &AccountInfo, loan_ref: u64) -> Result<SlotFacts> {
    require_keys_eq!(*info.owner, STREAM_LOAN_ID, RepError::NotStreamLoanSlot);
    require_keys_eq!(info.key(), slot_address(loan_ref), RepError::NotStreamLoanSlot);
    let data = info.try_borrow_data()?;
    let s = parse_slot(&data).ok_or(error!(RepError::NotStreamLoanSlot))?;
    require!(s.loan_ref == loan_ref, RepError::NotStreamLoanSlot);
    Ok(s)
}

/// fieldOf(pubkey) = big-endian integer of sha256(pubkey)[0..20], as a 32-byte field element.
pub fn field_of(key: &Pubkey) -> [u8; 32] {
    let h = hash(key.as_ref()).to_bytes();
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(&h[..20]);
    out
}
