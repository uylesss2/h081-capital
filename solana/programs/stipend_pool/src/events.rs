//! Events, emitted with Anchor's event-CPI format (self-CPI signed by ["__event_authority"], data =
//! EVENT_IX_TAG_LE | event discriminator | borsh fields) so that large memos are never truncated the way
//! program logs are. The memo-bearing events are serialized straight into one reusable instruction
//! buffer: the default bump heap is 32 KiB and is never freed, and a 16-way grant carries more memo
//! bytes than that.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::Discriminator;

use crate::field::Fe;

#[event]
pub struct NewCommitment {
    pub commitment: [u8; 32],
    pub index: u32,
    pub encrypted_output: Vec<u8>,
}

#[event]
pub struct NewNullifier {
    pub nullifier: [u8; 32],
}

#[event]
pub struct NewGrant {
    pub total_commitment: [u8; 32],
    pub first_index: u32,
}

#[event]
pub struct NewDelegation {
    pub nullifier: [u8; 32],
    pub first_index: u32,
}

#[event]
pub struct NewReceipt {
    pub receipt: [u8; 32],
}

/// `recipient` is the wallet that owns `token_account` (the address the proof's publicRecipient maps to).
#[event]
pub struct PublicPayout {
    pub asset: Pubkey,
    pub recipient: Pubkey,
    pub token_account: Pubkey,
    pub amount: u64,
}

/// A lender share of a spend. `delivered_to` is the lender's token account, or the escrow token account
/// when it could not be delivered (then a PledgeEscrowed precedes it).
#[event]
pub struct PledgeRouted {
    pub lender_addr: [u8; 32],
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
    pub nullifier: [u8; 32],
    pub delivered_to: Pubkey,
}

#[event]
pub struct PledgeEscrowed {
    pub lender_addr: [u8; 32],
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
}

#[event]
pub struct LenderShareReleased {
    pub lender_addr: [u8; 32],
    pub loan_ref: u64,
    pub asset: Pubkey,
    pub amount: u64,
    pub delivered_to: Pubkey,
}

#[event]
pub struct LenderMemo {
    pub loan_ref: u64,
    pub encrypted_lender: Vec<u8>,
}

pub const EVENT_AUTHORITY_SEED: &[u8] = b"__event_authority";

pub struct Emitter<'info> {
    authority: AccountInfo<'info>,
    ix: Instruction,
}

impl<'info> Emitter<'info> {
    /// `capacity`: the largest event this instruction emits (the largest memo plus 64 bytes).
    pub fn new(authority: AccountInfo<'info>, capacity: usize) -> Self {
        let ix = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new_readonly(*authority.key, true)],
            data: Vec::with_capacity(capacity),
        };
        Self { authority, ix }
    }

    fn begin(&mut self, disc: &[u8]) {
        self.ix.data.clear();
        self.ix.data.extend_from_slice(anchor_lang::event::EVENT_IX_TAG_LE);
        self.ix.data.extend_from_slice(disc);
    }

    fn flush(&self) -> Result<()> {
        invoke_signed(
            &self.ix,
            core::slice::from_ref(&self.authority),
            &[&[EVENT_AUTHORITY_SEED, &[crate::EVENT_AUTHORITY_AND_BUMP.1]]],
        )
        .map_err(Into::into)
    }

    pub fn emit<E: anchor_lang::Event + Discriminator>(&mut self, e: &E) -> Result<()> {
        self.begin(E::DISCRIMINATOR);
        e.serialize(&mut self.ix.data).map_err(|_| error!(crate::error::PoolError::BufferPayload))?;
        self.flush()
    }

    /// NewCommitment with the memo copied straight from the buffer.
    pub fn commitment(&mut self, commitment: &Fe, index: u32, memo: &[u8]) -> Result<()> {
        self.begin(NewCommitment::DISCRIMINATOR);
        self.ix.data.extend_from_slice(commitment);
        self.ix.data.extend_from_slice(&index.to_le_bytes());
        self.ix.data.extend_from_slice(&(memo.len() as u32).to_le_bytes());
        self.ix.data.extend_from_slice(memo);
        self.flush()
    }

    pub fn lender_memo(&mut self, loan_ref: u64, memo: &[u8]) -> Result<()> {
        self.begin(LenderMemo::DISCRIMINATOR);
        self.ix.data.extend_from_slice(&loan_ref.to_le_bytes());
        self.ix.data.extend_from_slice(&(memo.len() as u32).to_le_bytes());
        self.ix.data.extend_from_slice(memo);
        self.flush()
    }
}
