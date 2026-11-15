//! rep_registry: H081 private reputation (docs/REPUTATION-SPEC.md).
//!
//! A Poseidon Merkle tree with one leaf per attested, fully repaid stream_loan loan, and a stateless Groth16 verifier
//! for reputation proofs over it. No change to stipend_pool, stream_loan, safety_pool or capacity_stake: this program
//! only READS stream_loan's Slot and Subrogation accounts (owner, address, size and discriminator checked; fields at
//! fixed offsets, tested against stream_loan::state::Slot).
//!
//! `attest(loan_ref)` (permissionless) appends
//!     R = Poseidon(13, agent_pk, loan_ref, principal, fieldOf(asset), fieldOf(lender), funded_at / 86400, 1)
//! when the slot is funded, repaid >= principal, principal >= MIN_PRINCIPAL and no Subrogation exists. A loan is
//! marked in a bitmap page (1 bit per loan_ref, ["repbits", page]) so it is attested once ever; the leaf list is
//! public in the RepAttested events (and in the relayer snapshot), and a rebuilt list is checked against the root ring.
//!
//! `verify_reputation(proof, inputs)` checks a proof of circuits/main/reputation.circom: every input in the field,
//! the thresholds and expiry in range, the root in the tree's ring, now <= expiry <= now + MAX_TTL, then Groth16.
//! It does not consume the nonce: an on-chain caller that needs one-time use keeps its own ["used", audience, nonce].
//!
//! What a passing proof means (and every caller must respect): a LOWER BOUND on fully repaid loans whose keys one
//! account controls. Defaults never enter the tree, so nothing is said about them; a lender may be the borrower's own
//! wallet; anyone may repay a loan for its borrower. Never size credit from it alone.
//!
//! Upgradeable, with the upgrade authority kept (never --final): only `initialize` reads it.
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

pub mod generated;
pub mod groth16;
pub mod merkle;
pub mod view;

/// groth16.rs is a byte-for-byte copy of stipend_pool's (a test checks it); it names its errors PoolError.
pub mod error {
    pub use crate::RepError as PoolError;
}

use groth16::{is_field, Proof};
use merkle::{commit_root, init_tree, insert, is_known_root, last_root};

declare_id!("8w59GKraS4JrmDqYnqXcvjHTubnj7udMsuLXnscd3KEL");

/// The localnet program id (solana/keys/rep_registry-keypair.json). A mainnet build patches declare_id to the mainnet
/// key and refuses to compile while it is still this one.
pub const LOCALNET_ID: Pubkey = pubkey!("8w59GKraS4JrmDqYnqXcvjHTubnj7udMsuLXnscd3KEL");
#[cfg(feature = "mainnet")]
const _: () = assert!(!view::same(&ID, &LOCALNET_ID), "mainnet build: declare_id is still the localnet rep_registry key");
#[cfg(feature = "mainnet")]
const _: () = assert!(!generated::vk::REPUTATION_VK_IS_DEV, "mainnet build: the reputation verifying key is a dev setup; run the ceremony and gen-rep-vk first");

pub const TREE_SEED: &[u8] = b"reptree";
pub const BITS_SEED: &[u8] = b"repbits";
pub const LEVELS: usize = 20;
pub const ROOT_HISTORY: usize = 256;
/// loan refs per bitmap page (1,024 bytes)
pub const BITS_PER_PAGE: u64 = 8192;
/// smallest principal attest accepts (base units; 1 USDG). Stops dust from filling the tree.
pub const MIN_PRINCIPAL: u64 = 1_000_000;
/// verify_reputation refuses an expiry further than this past the clock (a squared 2^200 expiry would never expire)
pub const MAX_TTL: i64 = 86_400;
pub const DOM_REP: u64 = 13;
pub const NPUBLIC: usize = 13;

#[error_code]
pub enum RepError {
    // the four names groth16.rs uses
    #[msg("wrong number of public inputs")]
    PublicInputCount,
    #[msg("a public input is not a field element")]
    InputNotInField,
    #[msg("alt_bn128 syscall failed")]
    Bn254Syscall,
    #[msg("malformed proof encoding")]
    InvalidProofEncoding,
    #[msg("Poseidon syscall failed")]
    PoseidonSyscall,
    #[msg("the reputation tree is full; attest into the next version")]
    TreeFull,
    #[msg("not a stream_loan slot for this loan ref (owner, address, size or type)")]
    NotStreamLoanSlot,
    #[msg("the Subrogation account is not stream_loan's PDA for this loan ref")]
    BadSubrogationAccount,
    #[msg("the loan was never funded")]
    NotFunded,
    #[msg("the loan is not fully repaid")]
    NotRepaid,
    #[msg("the loan was slashed (a safety pool covered it); it does not count")]
    Slashed,
    #[msg("the principal is below the minimum that counts")]
    TooSmall,
    #[msg("the slot's agent key is zero or not a field element")]
    BadAgentKey,
    #[msg("the slot has no funding time")]
    NoFundingTime,
    #[msg("this loan is already attested")]
    AlreadyAttested,
    #[msg("the proof's root is not a recent root of this tree")]
    UnknownRoot,
    #[msg("the proof has expired")]
    Expired,
    #[msg("the proof's expiry is too far in the future")]
    ExpiryTooFar,
    #[msg("a threshold is out of range")]
    ThresholdOutOfRange,
    #[msg("the proof does not verify")]
    InvalidProof,
    #[msg("only the program's upgrade authority may do this")]
    UpgradeAuthority,
    #[msg("wrong bitmap page for this loan ref")]
    WrongPage,
}

/// One version of the reputation tree. PDA ["reptree", version u16 LE]. Zero-copy: 8 + 8,848 = 8,856 bytes.
/// A new version is opened (by the upgrade authority) only when the current one is full; a loan lives in exactly one.
#[account(zero_copy)]
#[repr(C)]
pub struct RepTree {
    pub next_index: u32,
    pub current_root_index: u32,
    pub version: u16,
    pub bump: u8,
    pub _pad: [u8; 5],
    pub filled_subtrees: [[u8; 32]; LEVELS],
    pub roots: [[u8; 32]; ROOT_HISTORY],
}

/// Attested-loan bitmap. PDA ["repbits", page u32 LE]; bit (loan_ref % 8192) of page loan_ref / 8192.
/// Loan refs are sequential (stream_loan Registry), so one page covers 8,192 loans for ~0.008 SOL of rent.
#[account]
#[derive(InitSpace)]
pub struct RepBits {
    pub page: u32,
    pub bump: u8,
    pub bits: [u8; 1024],
}

#[event]
pub struct RepAttested {
    pub version: u16,
    pub index: u32,
    pub loan_ref: u64,
    pub leaf: [u8; 32],
    pub root: [u8; 32],
    /// the leaf's preimage (all of it was public in the Slot): lets a borrower find its own leaves after the slot closes
    pub agent_pk: [u8; 32],
    pub principal: u64,
    pub asset_f: [u8; 32],
    pub lender_f: [u8; 32],
    pub funded_day: u32,
}

#[event]
pub struct ReputationVerified {
    pub version: u16,
    pub asset: [u8; 32],
    pub audience: [u8; 32],
    pub nonce: [u8; 32],
    pub pres_nullifier: [u8; 32],
    pub min_loans: u8,
    pub min_volume: u64,
    pub min_lenders: u8,
    pub min_span_days: u16,
    pub min_months: u8,
    pub month_floor: u64,
    pub expiry: i64,
    pub bind_to: [u8; 32],
}

/// Upgrade authority recorded in a BPF upgradeable loader ProgramData account (same parser as stream_loan's).
pub fn upgrade_authority(info: &AccountInfo) -> Result<Option<Pubkey>> {
    require_keys_eq!(*info.owner, bpf_loader_upgradeable::ID, RepError::UpgradeAuthority);
    let data = info.try_borrow_data()?;
    require!(data.len() >= 45 && data[..4] == [3, 0, 0, 0], RepError::UpgradeAuthority);
    Ok(match data[12] {
        0 => None,
        1 => Some(Pubkey::new_from_array(data[13..45].try_into().unwrap())),
        _ => return err!(RepError::UpgradeAuthority),
    })
}

pub fn page_of(loan_ref: u64) -> u32 {
    (loan_ref / BITS_PER_PAGE) as u32
}

/// Value of a 32-byte big-endian public input if it fits `bits` bits.
pub fn small(x: &[u8; 32], bits: u32) -> Option<u64> {
    if x[..24].iter().any(|b| *b != 0) {
        return None;
    }
    let v = u64::from_be_bytes(x[24..].try_into().unwrap());
    if bits < 64 && v >> bits != 0 {
        return None;
    }
    Some(v)
}

/// Public-input order of circuits/main/reputation.circom.
pub mod input {
    pub const REP_ROOT: usize = 0;
    pub const ASSET: usize = 1;
    pub const MIN_LOANS: usize = 2;
    pub const MIN_VOLUME: usize = 3;
    pub const MIN_LENDERS: usize = 4;
    pub const MIN_SPAN_DAYS: usize = 5;
    pub const MIN_MONTHS: usize = 6;
    pub const MONTH_FLOOR: usize = 7;
    pub const AUDIENCE: usize = 8;
    pub const NONCE: usize = 9;
    pub const EXPIRY: usize = 10;
    pub const BIND_TO: usize = 11;
    pub const PRES_NULLIFIER: usize = 12;
}

/// The checks verify_reputation makes before the pairing, apart from the root (pure; unit tested).
pub fn check_public(inputs: &[[u8; 32]; NPUBLIC], now: i64) -> Result<ReputationVerified> {
    use input::*;
    for x in inputs.iter() {
        require!(is_field(x), RepError::InputNotInField);
    }
    let r = |i: usize, bits: u32| small(&inputs[i], bits).ok_or(error!(RepError::ThresholdOutOfRange));
    let min_loans = r(MIN_LOANS, 8)? as u8;
    let min_volume = r(MIN_VOLUME, 64)?;
    let min_lenders = r(MIN_LENDERS, 8)? as u8;
    let min_span_days = r(MIN_SPAN_DAYS, 16)? as u16;
    let min_months = r(MIN_MONTHS, 8)? as u8;
    let month_floor = r(MONTH_FLOOR, 64)?;
    let expiry = small(&inputs[EXPIRY], 63).ok_or(error!(RepError::ExpiryTooFar))? as i64;
    require!(expiry >= now, RepError::Expired);
    require!(expiry <= now.saturating_add(MAX_TTL), RepError::ExpiryTooFar);
    Ok(ReputationVerified {
        version: 0,
        asset: inputs[ASSET],
        audience: inputs[AUDIENCE],
        nonce: inputs[NONCE],
        pres_nullifier: inputs[PRES_NULLIFIER],
        min_loans,
        min_volume,
        min_lenders,
        min_span_days,
        min_months,
        month_floor,
        expiry,
        bind_to: inputs[BIND_TO],
    })
}

#[program]
pub mod rep_registry {
    use super::*;

    /// Opens tree `version` (0 first). Only the program's upgrade authority. A version above 0 requires the previous
    /// one to be full, so attesters always know which tree is current.
    pub fn initialize(ctx: Context<Initialize>, version: u16) -> Result<()> {
        if version > 0 {
            let prev = ctx.accounts.previous.as_ref().ok_or(error!(RepError::TreeFull))?;
            let (expect, _) = Pubkey::find_program_address(&[TREE_SEED, &(version - 1).to_le_bytes()], &crate::ID);
            require_keys_eq!(prev.key(), expect, RepError::TreeFull);
            require!((prev.load()?.next_index as u64) >= (1u64 << LEVELS), RepError::TreeFull);
        }
        let mut t = ctx.accounts.rep_tree.load_init()?;
        init_tree(&mut t);
        t.version = version;
        t.bump = ctx.bumps.rep_tree;
        Ok(())
    }

    /// Appends the leaf of a funded, fully repaid, never slashed stream_loan loan. Permissionless: the H081 SDK has
    /// the relayer or the lender send it, never the borrower (the signer and fee payer are public and would link the
    /// loan to the borrower's wallet).
    pub fn attest(ctx: Context<Attest>, loan_ref: u64) -> Result<()> {
        let s = view::load_slot(&ctx.accounts.slot, loan_ref)?;
        require_keys_eq!(ctx.accounts.subrogation.key(), view::subrogation_address(loan_ref), RepError::BadSubrogationAccount);
        require!(ctx.accounts.subrogation.data_is_empty(), RepError::Slashed);
        require!(s.funded, RepError::NotFunded);
        require!(s.repaid >= s.principal, RepError::NotRepaid);
        require!(s.principal >= MIN_PRINCIPAL, RepError::TooSmall);
        require!(is_field(&s.agent_pk) && s.agent_pk.iter().any(|b| *b != 0), RepError::BadAgentKey);
        require!(s.funded_at > 0, RepError::NoFundingTime);

        let bits = &mut ctx.accounts.rep_bits;
        let page = page_of(loan_ref);
        if bits.bump == 0 {
            bits.page = page;
            bits.bump = ctx.bumps.rep_bits;
        }
        require!(bits.page == page, RepError::WrongPage);
        let bit = (loan_ref % BITS_PER_PAGE) as usize;
        require!(bits.bits[bit / 8] & (1 << (bit % 8)) == 0, RepError::AlreadyAttested);
        bits.bits[bit / 8] |= 1 << (bit % 8);

        let asset_f = view::field_of(&s.asset);
        let lender_f = view::field_of(&s.lender);
        let funded_day = (s.funded_at / 86_400) as u32;
        let leaf = merkle::rep_leaf(&s.agent_pk, loan_ref, s.principal, &asset_f, &lender_f, funded_day)?;
        let mut t = ctx.accounts.rep_tree.load_mut()?;
        let index = insert(&mut t, &leaf)?;
        commit_root(&mut t);
        emit!(RepAttested {
            version: t.version,
            index,
            loan_ref,
            leaf,
            root: last_root(&t),
            agent_pk: s.agent_pk,
            principal: s.principal,
            asset_f,
            lender_f,
            funded_day,
        });
        Ok(())
    }

    /// Verifies a reputation proof against this tree's recent roots. Stateless; callable by CPI. Reverts unless valid.
    pub fn verify_reputation(ctx: Context<VerifyReputation>, proof: Proof, inputs: [[u8; 32]; NPUBLIC]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut ev = check_public(&inputs, now)?;
        let t = ctx.accounts.rep_tree.load()?;
        require!(is_known_root(&t, &inputs[input::REP_ROOT]), RepError::UnknownRoot);
        ev.version = t.version;
        drop(t);
        let ok = groth16::verify(&generated::vk::REPUTATION_VK, &proof, &inputs)?;
        require!(ok, RepError::InvalidProof);
        emit!(ev);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(version: u16)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + std::mem::size_of::<RepTree>(), seeds = [TREE_SEED, &version.to_le_bytes()], bump)]
    pub rep_tree: AccountLoader<'info, RepTree>,
    /// the previous version (required when version > 0; must be full)
    pub previous: Option<AccountLoader<'info, RepTree>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: this program's ProgramData account; its upgrade authority must be the payer.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = upgrade_authority(&program_data)? == Some(payer.key()) @ RepError::UpgradeAuthority
    )]
    pub program_data: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(loan_ref: u64)]
pub struct Attest<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: stream_loan Slot ["slot", loan_ref]; owner, address, size and discriminator checked in view::load_slot.
    pub slot: UncheckedAccount<'info>,
    /// CHECK: stream_loan Subrogation ["subrogation", loan_ref] under STREAM_LOAN_ID; address checked, must be empty.
    pub subrogation: UncheckedAccount<'info>,
    #[account(mut)]
    pub rep_tree: AccountLoader<'info, RepTree>,
    #[account(init_if_needed, payer = payer, space = 8 + RepBits::INIT_SPACE, seeds = [BITS_SEED, &page_of(loan_ref).to_le_bytes()], bump)]
    pub rep_bits: Box<Account<'info, RepBits>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VerifyReputation<'info> {
    pub rep_tree: AccountLoader<'info, RepTree>,
}

#[cfg(test)]
mod tests;
