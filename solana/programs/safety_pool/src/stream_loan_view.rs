//! View of stream_loan accounts (same chain, read directly; no crate dependency so the two programs build
//! independently) and the one CPI this program makes into it. Mirrors solana/programs/stream_loan/src/state.rs:
//!   Slot        PDA ["slot", loan_ref u64 LE]          (Anchor account "Slot")
//!   Ledger      PDA ["ledger", loan_ref u64 LE, mint]  (Anchor account "Ledger")
//!   Subrogation PDA ["subrogation", loan_ref u64 LE]   (created by stream_loan `record_slash`, called from `slash`)
//!   inbox  = associated token account of the slot PDA for the loan asset
//!   escrow = stipend_pool token account ["owed", asset, fieldOf(slot PDA), loan_ref u64 LE]
//! and its `shortfall_of`: routed shares still unsynced in the inbox, and shares the pool escrowed for
//! the slot, count as paid.
//! If stream_loan's layout, seeds, instruction names or program id change, this file must change with them.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use solana_sha256_hasher::hash;

use crate::{SafetyError, GRACE};

/// stream_loan program id (localnet key in solana/keys/stream_loan-keypair.json). A mainnet build patches
/// this line to the mainnet stream_loan key (solana/scripts/build-phase2-mainnet.sh) and refuses to compile
/// if it is still the localnet key: whoever holds a localnet key could deploy a forged stream_loan there.
pub const STREAM_LOAN_ID: Pubkey = pubkey!("FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc");
pub const LOCALNET_STREAM_LOAN_ID: Pubkey = pubkey!("FvM9Xczax1TCU15imjdNAMg8JXP4apSs2pn9LWCdjyPc");
#[cfg(feature = "mainnet")]
const _: () = assert!(!same(&STREAM_LOAN_ID, &LOCALNET_STREAM_LOAN_ID), "mainnet build: STREAM_LOAN_ID is still the localnet key");
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SLOT_SEED: &[u8] = b"slot";
pub const LEDGER_SEED: &[u8] = b"ledger";
pub const SUBROGATION_SEED: &[u8] = b"subrogation";
/// stipend_pool program id and its escrow seed: the mainnet deployment with `--features mainnet`, the
/// localnet key (solana/keys/stipend_pool-keypair.json) otherwise.
pub const LOCALNET_POOL_PROGRAM_ID: Pubkey = pubkey!("AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3");
pub const MAINNET_POOL_PROGRAM_ID: Pubkey = pubkey!("E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM");
#[cfg(not(feature = "mainnet"))]
pub const POOL_PROGRAM_ID: Pubkey = LOCALNET_POOL_PROGRAM_ID;
#[cfg(feature = "mainnet")]
pub const POOL_PROGRAM_ID: Pubkey = MAINNET_POOL_PROGRAM_ID;

/// Compile-time pubkey equality (for the mainnet build guards).
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

/// stream_loan's Subrogation PDA of a loan.
pub fn subrogation_address(loan_ref: u64) -> Pubkey {
    Pubkey::find_program_address(&[SUBROGATION_SEED, &loan_ref.to_le_bytes()], &STREAM_LOAN_ID).0
}

/// The associated token account of `owner` for `mint` under `token_program`.
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM_ID).0
}

fn sighash(namespace: &str, name: &str) -> [u8; 8] {
    let h = hash(format!("{namespace}:{name}").as_bytes()).to_bytes();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

/// Associated Token Account `CreateIdempotent` (raw CPI; works for SPL Token and Token-2022 mints).
#[allow(clippy::too_many_arguments)]
pub fn create_ata_idempotent<'info>(
    ata_program: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    ata_account: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    let ix = Instruction {
        program_id: ATA_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*ata_account.key, false),
            AccountMeta::new_readonly(*owner.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data: vec![1u8],
    };
    invoke(
        &ix,
        &[payer.clone(), ata_account.clone(), owner.clone(), mint.clone(), system_program.clone(), token_program.clone(), ata_program.clone()],
    )?;
    Ok(())
}

/// CPI stream_loan::record_slash(loan_ref, amount): creates the loan's Subrogation so stream_loan forwards
/// the loan's receipts to `to` (this pool's ATA for the loan asset) until `amount` is recovered. Signed by
/// the pool's config PDA (`config_seeds`); stream_loan accepts no other signer. Account order is
/// stream_loan's RecordSlash: slot, subrogation, payer, safety_config, to, system_program.
#[allow(clippy::too_many_arguments)]
pub fn record_slash<'info>(
    stream_loan_program: &AccountInfo<'info>,
    slot: &AccountInfo<'info>,
    subrogation: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    config: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    loan_ref: u64,
    amount: u64,
    config_seeds: &[&[u8]],
) -> Result<()> {
    require_keys_eq!(*stream_loan_program.key, STREAM_LOAN_ID, SafetyError::WrongStreamLoanProgram);
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&sighash("global", "record_slash"));
    data.extend_from_slice(&loan_ref.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: STREAM_LOAN_ID,
        accounts: vec![
            AccountMeta::new_readonly(*slot.key, false),
            AccountMeta::new(*subrogation.key, false),
            AccountMeta::new(*payer.key, true),
            AccountMeta::new_readonly(*config.key, true),
            AccountMeta::new_readonly(*to.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[slot.clone(), subrogation.clone(), payer.clone(), config.clone(), to.clone(), system_program.clone(), stream_loan_program.clone()],
        &[config_seeds],
    )?;
    Ok(())
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
