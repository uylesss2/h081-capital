use anchor_lang::prelude::*;

pub const REGISTRY_SEED: &[u8] = b"registry";
pub const SLOT_SEED: &[u8] = b"slot";
pub const LEDGER_SEED: &[u8] = b"ledger";

/// Time after the allowance's expiry before an unpaid loan counts as a shortfall.
pub const GRACE: u64 = 7 * 24 * 60 * 60;

/// Sequential loan refs. PDA ["registry"]. No admin field.
#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub next_loan_ref: u64,
    pub bump: u8,
}

/// One slot (= one loan). PDA ["slot", loan_ref u64 LE]. The slot PDA is the `lenderAddr` borrowers
/// pledge to: lenderAddr = fieldOf(slot PDA). Its inbox is the slot PDA's associated token account.
#[account]
#[derive(InitSpace)]
pub struct Slot {
    pub loan_ref: u64,
    /// who receives everything routed to this loan ref
    pub lender: Pubkey,
    pub bump: u8,
    pub funded: bool,
    pub settled: bool,
    /// the loan asset (SPL mint) and its token program
    pub asset: Pubkey,
    pub token_program: Pubkey,
    pub principal: u64,
    pub repaid: u64,
    pub min_remaining: u128,
    pub min_rate: u128,
    pub pledge_bps: u16,
    pub expiry: u64,
    /// 32-byte big-endian field element
    pub agent_pk: [u8; 32],
    pub funded_at: i64,
    /// the token account the principal was paid to
    pub payout_to: Pubkey,
    pub stream_start: u64,
}

/// Per (slot, mint) inbox accounting. PDA ["ledger", loan_ref u64 LE, mint].
/// `held` is the part of the inbox balance that could not be forwarded (waits for `collect`);
/// everything above `held` in the inbox is new, unsynced routed shares.
#[account]
#[derive(InitSpace)]
pub struct Ledger {
    pub loan_ref: u64,
    pub mint: Pubkey,
    pub held: u64,
    /// total ever credited from the inbox (forwarded + held)
    pub received: u64,
    pub bump: u8,
}

/// Unpaid principal once expiry + GRACE has passed; 0 otherwise (and always 0 when expiry == 0).
/// `pending` is value already routed to the loan but not yet credited: unsynced inbox balance plus the
/// stipend_pool escrow for (fieldOf(slot), loan_ref) in the loan asset.
pub fn shortfall_of(slot: &Slot, now: i64, pending: u64) -> u64 {
    if !slot.funded || slot.settled || slot.expiry == 0 {
        return 0;
    }
    if now < 0 || (now as u64) <= slot.expiry.saturating_add(GRACE) {
        return 0;
    }
    let paid = slot.repaid.saturating_add(pending);
    slot.principal.saturating_sub(paid)
}
