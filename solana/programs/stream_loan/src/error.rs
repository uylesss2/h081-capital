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
}
