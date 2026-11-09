use anchor_lang::prelude::*;

#[error_code]
pub enum LoanError {
    #[msg("not the lender")]
    NotTheLender,
    #[msg("already funded")]
    AlreadyFunded,
    #[msg("proof not for this slot")]
    WrongSlot,
    #[msg("proof names another asset")]
    WrongAsset,
    #[msg("stream not started")]
    StreamNotStarted,
    #[msg("payout account is not a token account of the loan asset")]
    BadPayout,
    #[msg("no loan")]
    NoLoan,
    #[msg("nothing owed")]
    NothingOwed,
    #[msg("not a claim for this slot")]
    NotAClaim,
    #[msg("account is not the stipend_pool program")]
    WrongPoolProgram,
    #[msg("buffer is not a stipend_pool buffer")]
    BadBuffer,
    #[msg("buffer payload is malformed")]
    BadPayload,
    #[msg("not a token program")]
    BadTokenProgram,
    #[msg("bad mint")]
    BadMint,
    #[msg("inbox is not the slot's associated token account")]
    BadInbox,
    #[msg("lender token account is not the lender's associated token account")]
    BadLenderAccount,
    #[msg("value does not fit")]
    Overflow,
    #[msg("escrow is not the stipend_pool escrow of this slot and loan ref")]
    BadEscrow,
    #[msg("the pool holds an escrowed share for this slot: pull_lender_share it to the inbox before funding")]
    EscrowNotEmpty,
    #[msg("treasury account is not the treasury's associated token account of the loan asset")]
    BadTreasury,
    #[msg("signer is not the program's upgrade authority")]
    UpgradeAuthority,
    #[msg("the stream proof's audience is not fieldOf(payout_to)")]
    PayoutNotProven,
    #[msg("principal is zero or above what the pledge can repay (min_remaining * pledge_bps / 10,000)")]
    PrincipalTooLarge,
    #[msg("principal must be exactly what the borrower's proof backs: min_remaining * pledge_bps / 10,000, above zero")]
    PrincipalMismatch,
    #[msg("signer is not a safety_pool config PDA")]
    NotSafetyPool,
    #[msg("subrogation account is not this loan's [\"subrogation\", loan_ref] PDA")]
    BadSubrogation,
    #[msg("recovery account is not the safety pool's associated token account of the loan asset")]
    BadRecovery,
    #[msg("slash amount is zero")]
    BadSlashAmount,
    #[msg("the loan is funded and not settled: settle it before closing the slot")]
    NotSettled,
    #[msg("the slot's inbox still holds tokens: sync (and collect) them before closing the slot")]
    InboxNotEmpty,
    #[msg("safety_pool holds an open cover for this loan: release_cover it (anyone may) before closing the slot")]
    CoverOpen,
    #[msg("cover is not the safety_pool cover PDA of this loan ref")]
    BadCover,
    #[msg("account is not the closed-slot receipt PDA of this loan ref")]
    BadReceipt,
    #[msg("a recorded slash of this loan is not yet recovered by the safety pool: the slot stays open until it is")]
    SubrogationOpen,
    // ---- overpay cap (docs/LOAN-OVERPAY-CAP.md). Appended at the end: the codes above never shift.
    #[msg("the loan is repaid: nothing more is owed to the lender (the excess goes back to the borrower through return_excess)")]
    LoanRepaid,
    #[msg("the claim is larger than what the loan still owes (principal - repaid - unsynced inbox - escrow)")]
    ClaimTooLarge,
    #[msg("nothing in this inbox belongs to the borrower")]
    NoExcess,
    #[msg("the destination cannot receive the excess (missing, frozen or another mint): the payout owner may redirect it, or retry once it can")]
    PayoutCannotReceive,
    #[msg("this closed-loan receipt predates the overpay cap and records no payout account")]
    LegacyReceiptNoPayout,
    #[msg("the closed-loan receipt must be writable: the lender is still owed on this loan")]
    ReceiptNotWritable,
}
