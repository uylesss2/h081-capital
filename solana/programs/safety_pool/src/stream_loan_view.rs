//! Read-only view of stream_loan accounts (same chain, read directly; no CPI, no crate dependency so
//! the two programs build independently). Mirrors solana/programs/stream_loan/src/state.rs:
//!   Slot   PDA ["slot", loan_ref u64 LE]          (Anchor account "Slot")
//!   Ledger PDA ["ledger", loan_ref u64 LE, mint]  (Anchor account "Ledger")
//!   inbox  = associated token account of the slot PDA for the loan asset
//!   escrow = stipend_pool token account ["owed", asset, fieldOf(slot PDA), loan_ref u64 LE]
//! and its `shortfall_of`: routed shares still unsynced in the inbox, and shares the pool escrowed for
//! the slot, count as paid.
//! If stream_loan's layout, seeds or program id change, this file must change with them.
use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

use crate::{SafetyError, GRACE};

/// stream_loan program id (localnet key in solana/keys/stream_loan-keypair.json).
pub const STREAM_LOAN_ID: Pubkey = pubkey!("FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc");
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SLOT_SEED: &[u8] = b"slot";
pub const LEDGER_SEED: &[u8] = b"ledger";
/// stipend_pool program id (localnet key in solana/keys/stipend_pool-keypair.json) and its escrow seed.
pub const POOL_PROGRAM_ID: Pubkey = pubkey!("AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3");
pub const ESCROW_SEED: &[u8] = b"owed";

/// Field-for-field mirror of stream_loan::state::Slot (borsh, after the 8-byte discriminator).
#[derive(AnchorDeserialize, Clone, Debug)]
pub struct StreamSlot {
    pub loan_ref: u64,
    pub lender: Pubkey,
    pub bump: u8,
    pub funded: bool,
    pub settled: bool,
    pub asset: Pubkey,
    pub token_program: Pubkey,
    pub principal: u64,
    pub repaid: u64,
    pub min_remaining: u128,
    pub min_rate: u128,
    pub pledge_bps: u16,
    pub expiry: u64,
    pub agent_pk: [u8; 32],
    pub funded_at: i64,
    pub payout_to: Pubkey,
    pub stream_start: u64,
}

/// Mirror of stream_loan::state::Ledger.
#[derive(AnchorDeserialize, Clone, Debug)]
pub struct StreamLedger {
    pub loan_ref: u64,
    pub mint: Pubkey,
    pub held: u64,
    pub received: u64,
    pub bump: u8,
}

fn discriminator(name: &str) -> [u8; 8] {
    let h = hash(format!("account:{name}").as_bytes()).to_bytes();
    let mut d = [0u8; 8];
    d.copy_from_slice(&h[..8]);
    d
}

fn decode<T: AnchorDeserialize>(info: &AccountInfo, name: &str) -> Result<T> {
    let data = info.try_borrow_data()?;
    require!(data.len() >= 8 && data[..8] == discriminator(name), SafetyError::BadLoanAccount);
    let mut slice: &[u8] = &data[8..];
    T::deserialize(&mut slice).map_err(|_| error!(SafetyError::BadLoanAccount))
}

pub fn slot_address(loan_ref: u64) -> Pubkey {
    Pubkey::find_program_address(&[SLOT_SEED, &loan_ref.to_le_bytes()], &STREAM_LOAN_ID).0
}

/// Loads the stream_loan slot of `loan_ref`: owner, address and discriminator are checked.
pub fn load_slot(info: &AccountInfo, loan_ref: u64) -> Result<StreamSlot> {
    require_keys_eq!(*info.owner, STREAM_LOAN_ID, SafetyError::BadLoanAccount);
    require_keys_eq!(info.key(), slot_address(loan_ref), SafetyError::BadLoanAccount);
    let s: StreamSlot = decode(info, "Slot")?;
    require!(s.loan_ref == loan_ref, SafetyError::BadLoanAccount);
    Ok(s)
}

/// Routed-but-unsynced value in the slot's inbox for the loan asset: inbox balance minus the
/// ledger's `held`. 0 when the loan is not funded or the inbox does not exist.
pub fn pending_in_inbox(slot_key: &Pubkey, s: &StreamSlot, inbox: &AccountInfo, ledger: &AccountInfo) -> Result<u64> {
    if !s.funded {
        return Ok(0);
    }
    let (ata, _) = Pubkey::find_program_address(&[slot_key.as_ref(), s.token_program.as_ref(), s.asset.as_ref()], &ATA_PROGRAM_ID);
    require_keys_eq!(inbox.key(), ata, SafetyError::BadLoanAccount);
    if inbox.owner != &s.token_program || inbox.data_len() < 72 {
        return Ok(0);
    }
    let amount = {
        let d = inbox.try_borrow_data()?;
        u64::from_le_bytes(d[64..72].try_into().unwrap())
    };
    let (expect, _) = Pubkey::find_program_address(&[LEDGER_SEED, &s.loan_ref.to_le_bytes(), s.asset.as_ref()], &STREAM_LOAN_ID);
    require_keys_eq!(ledger.key(), expect, SafetyError::BadLoanAccount);
    let held = if ledger.owner == &STREAM_LOAN_ID && ledger.data_len() > 0 {
        decode::<StreamLedger>(ledger, "Ledger")?.held
    } else {
        0
    };
    Ok(amount.saturating_sub(held))
}

/// fieldOf(pubkey) = big-endian integer of sha256(pubkey)[0..20], as a 32-byte field element.
pub fn field_of(key: &Pubkey) -> [u8; 32] {
    let h = hash(key.as_ref()).to_bytes();
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(&h[..20]);
    out
}

/// Shares stipend_pool holds in escrow for (fieldOf(slot), loan_ref) in the loan asset: they were routed
/// to the loan and reach the slot's inbox with pull_lender_share, so they count as paid. 0 when the loan
/// is not funded or the escrow does not exist. The address is checked.
pub fn pending_in_escrow(slot_key: &Pubkey, s: &StreamSlot, escrow: &AccountInfo) -> Result<u64> {
    if !s.funded {
        return Ok(0);
    }
    let (expect, _) = Pubkey::find_program_address(
        &[ESCROW_SEED, s.asset.as_ref(), &field_of(slot_key), &s.loan_ref.to_le_bytes()],
        &POOL_PROGRAM_ID,
    );
    require_keys_eq!(escrow.key(), expect, SafetyError::BadLoanAccount);
    if escrow.owner != &s.token_program || escrow.data_len() < 72 {
        return Ok(0);
    }
    let d = escrow.try_borrow_data()?;
    if d[..32] != s.asset.to_bytes() {
        return Ok(0);
    }
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

/// Same rule as stream_loan::state::shortfall_of (GRACE is this program's copy of stream_loan's).
pub fn shortfall_of(s: &StreamSlot, now: i64, pending: u64) -> u64 {
    if !s.funded || s.settled || s.expiry == 0 {
        return 0;
    }
    if now < 0 || (now as u64) <= s.expiry.saturating_add(GRACE) {
        return 0;
    }
    s.principal.saturating_sub(s.repaid.saturating_add(pending))
}
