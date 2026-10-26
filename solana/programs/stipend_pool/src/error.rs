use anchor_lang::prelude::*;

/// Codes are 6000 + index; append only, never reorder (the SDK and tests match on codes).
#[error_code]
pub enum PoolError {
    #[msg("wrong number of public inputs")]
    PublicInputCount,
    #[msg("public input is not a canonical field element")]
    InputNotInField,
    #[msg("alt_bn128 syscall failed")]
    Bn254Syscall,
    #[msg("malformed proof points")]
    InvalidProofEncoding,
    #[msg("invalid proof")]
    InvalidProof,
    #[msg("poseidon syscall failed")]
    PoseidonSyscall,
    #[msg("merkle tree is full")]
    TreeFull,
    #[msg("unknown merkle root")]
    UnknownRoot,
    #[msg("unknown circuit")]
    UnknownCircuit,
    #[msg("buffer length out of range")]
    BufferLength,
    #[msg("write out of buffer bounds")]
    BufferBounds,
    #[msg("buffer payload is malformed")]
    BufferPayload,
    // ---- pool operations (stage 2) ----
    #[msg("ext data hash mismatch")]
    ExtData,
    #[msg("same nullifier twice")]
    SameNullifier,
    #[msg("public amount does not match extAmount - fee")]
    PublicAmount,
    #[msg("a fully shielded transfer must hide its asset")]
    AssetMustBeHidden,
    #[msg("asset (mint) required")]
    AssetRequired,
    #[msg("a required account is missing")]
    MissingAccount,
    #[msg("nullifier already spent")]
    AlreadySpent,
    #[msg("wrong nullifier account")]
    NullifierAccount,
    #[msg("stale timestamp")]
    StaleTimestamp,
    #[msg("recipient")]
    Recipient,
    #[msg("lender")]
    Lender,
    #[msg("amount does not fit a token transfer")]
    AmountOverflow,
    #[msg("wrong mint")]
    WrongMint,
    #[msg("wrong token account")]
    WrongTokenAccount,
    #[msg("wrong vault")]
    WrongVault,
    #[msg("wrong escrow account")]
    WrongEscrow,
    #[msg("nothing owed")]
    NothingOwed,
    #[msg("the vault received less than the deposit (transfer fee or hook)")]
    DepositShortfall,
    #[msg("fee exceeds the public amount")]
    FeeExceedsAmount,
    #[msg("wrong token program")]
    WrongTokenProgram,
    #[msg("buffer authority must be the payer")]
    BufferAuthority,
    #[msg("account already in use")]
    AccountInUse,
    #[msg("lender token account is not the associated token account of its owner")]
    LenderAccount,
}
