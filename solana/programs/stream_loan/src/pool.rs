//! The stipend_pool interface this registry relies on (raw CPI; the pool's crate is not linked).
//! Must stay byte-compatible with programs/stipend_pool: Buffer header, StreamArgs / SpendArgs borsh
//! layout, instruction names and account order.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::{invoke, invoke_signed};

use crate::error::LoanError;

/// Localnet stipend_pool program id (solana/keys/stipend_pool-keypair.json).
pub const POOL_PROGRAM_ID: Pubkey = pubkey!("AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3");

/// Buffer header: discriminator(8) | authority(32) | seed u64 | len u32 | bump u8, then the payload.
pub const BUFFER_HEADER: usize = 8 + 32 + 8 + 4 + 1;

pub fn sighash(namespace: &str, name: &str) -> [u8; 8] {
    let h = solana_sha256_hasher::hashv(&[namespace.as_bytes(), b":", name.as_bytes()]).to_bytes();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

/// A Groth16 proof as the pool takes it (`a` negated), 256 bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Proof {
    pub a: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
}

/// stipend_pool::StreamArgs (public inputs of the stream circuit; lender and asset as pubkeys).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StreamArgs {
    pub root: [u8; 32],
    pub min_remaining: [u8; 32],
    pub min_rate: [u8; 32],
    pub lender: Pubkey,
    pub loan_ref: u64,
    pub pledge_bps: u16,
    pub expiry: u64,
    pub lifetime_cap: [u8; 32],
    pub pledge_paid: [u8; 32],
    pub agent_pk: [u8; 32],
    pub audience: [u8; 32],
    pub stream_start: u64,
    pub asset: Pubkey,
}

/// Returns the staged payload of a stipend_pool Buffer account (owner, discriminator and length checked).
pub fn buffer_payload(info: &AccountInfo) -> Result<Vec<u8>> {
    require_keys_eq!(*info.owner, POOL_PROGRAM_ID, LoanError::BadBuffer);
    let data = info.try_borrow_data()?;
    require!(data.len() >= BUFFER_HEADER, LoanError::BadBuffer);
    require!(data[..8] == sighash("account", "Buffer"), LoanError::BadBuffer);
    let len = u32::from_le_bytes(data[48..52].try_into().unwrap()) as usize;
    require!(data.len() >= BUFFER_HEADER + len, LoanError::BadBuffer);
    Ok(data[BUFFER_HEADER..BUFFER_HEADER + len].to_vec())
}

/// Decodes `(Proof, StreamArgs)` exactly as stipend_pool::verify_stream does.
pub fn read_stream(info: &AccountInfo) -> Result<StreamArgs> {
    let payload = buffer_payload(info)?;
    let mut s: &[u8] = &payload;
    let _proof = Proof::deserialize(&mut s).map_err(|_| error!(LoanError::BadPayload))?;
    let args = StreamArgs::deserialize(&mut s).map_err(|_| error!(LoanError::BadPayload))?;
    require!(s.is_empty(), LoanError::BadPayload);
    Ok(args)
}

/// CPI stipend_pool::verify_stream(pool, buffer): fails unless the root is known and the proof verifies.
pub fn verify_stream<'info>(pool_program: &AccountInfo<'info>, pool_state: &AccountInfo<'info>, buffer: &AccountInfo<'info>) -> Result<()> {
    require_keys_eq!(*pool_program.key, POOL_PROGRAM_ID, LoanError::WrongPoolProgram);
    let ix = Instruction {
        program_id: POOL_PROGRAM_ID,
        accounts: vec![AccountMeta::new_readonly(*pool_state.key, false), AccountMeta::new_readonly(*buffer.key, false)],
        data: sighash("global", "verify_stream").to_vec(),
    };
    invoke(&ix, &[pool_state.clone(), buffer.clone(), pool_program.clone()])?;
    Ok(())
}

/// CPI into stipend_pool `spend` with the accounts the caller passed through, in order, adding the
/// signer flag to `signer` (the slot PDA) and signing for it with `seeds`.
pub fn spend_as<'info>(
    pool_program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    data: Vec<u8>,
    signer: &AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*pool_program.key, POOL_PROGRAM_ID, LoanError::WrongPoolProgram);
    let metas = accounts
        .iter()
        .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer || a.key == signer.key, is_writable: a.is_writable })
        .collect::<Vec<_>>();
    let ix = Instruction { program_id: POOL_PROGRAM_ID, accounts: metas, data };
    let mut infos: Vec<AccountInfo<'info>> = accounts.to_vec();
    infos.push(signer.clone());
    infos.push(pool_program.clone());
    invoke_signed(&ix, &infos, seeds)?;
    Ok(())
}

/// Mirror of stipend_pool::ops::SpendArgs (borsh; the spend buffer is (Proof, SpendArgs, SpendExt)).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SpendArgs {
    pub root: [u8; 32],
    pub nullifier: [u8; 32],
    pub new_allowance_commitment: [u8; 32],
    pub pay_commitment: [u8; 32],
    pub public_amount: u128,
    pub public_recipient: Pubkey,
    pub public_asset: Pubkey,
    pub fee: u128,
    pub timestamp: u64,
    pub receipt: [u8; 32],
    pub lender_amount: u128,
    pub lender_addr: [u8; 32],
    pub loan_ref: u64,
    pub is_lender_claim: bool,
    pub ext_data_hash: [u8; 32],
}

/// fieldOf(pubkey) = big-endian integer of sha256(pubkey)[0..20] (design section 2).
pub fn field_of(key: &Pubkey) -> [u8; 32] {
    let h = solana_sha256_hasher::hashv(&[key.as_ref()]).to_bytes();
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(&h[..20]);
    out
}

/// Requires the staged spend (Proof, SpendArgs, ..) to be a lender claim for (fieldOf(slot PDA), loan_ref).
pub fn check_lender_claim(payload: &[u8], slot: &Pubkey, loan_ref: u64) -> Result<()> {
    let mut s: &[u8] = payload;
    let _proof = Proof::deserialize(&mut s).map_err(|_| error!(LoanError::BadPayload))?;
    let a = SpendArgs::deserialize(&mut s).map_err(|_| error!(LoanError::BadPayload))?;
    require!(a.is_lender_claim && a.lender_addr == field_of(slot) && a.loan_ref == loan_ref, LoanError::NotAClaim);
    Ok(())
}

/// stipend_pool escrow seed: ["owed", mint, lender_field_be32, loan_ref_le8] under the pool program.
pub const ESCROW_SEED: &[u8] = b"owed";

/// The pool's escrow token account for shares routed to (fieldOf(slot), loan_ref) in `mint` that the
/// pool could not deliver to the slot's inbox.
pub fn escrow_address(mint: &Pubkey, slot: &Pubkey, loan_ref: u64) -> Pubkey {
    Pubkey::find_program_address(&[ESCROW_SEED, mint.as_ref(), &field_of(slot), &loan_ref.to_le_bytes()], &POOL_PROGRAM_ID).0
}

/// Balance of the pool escrow of (slot, loan_ref, mint); 0 when it does not exist. The address is checked.
pub fn escrowed(info: &AccountInfo, mint: &Pubkey, slot: &Pubkey, loan_ref: u64, token_program: &Pubkey) -> Result<u64> {
    require_keys_eq!(*info.key, escrow_address(mint, slot, loan_ref), LoanError::BadEscrow);
    Ok(match crate::token::read_token_account(info, token_program) {
        Some(v) if v.mint == *mint => v.amount,
        _ => 0,
    })
}
