//! Minimal SPL Token / Token-2022 helpers. Both programs share the base account layout and the
//! `TransferChecked` instruction, so the registry works with either without anchor-spl.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::{invoke, invoke_signed};

use crate::error::LoanError;

pub const SPL_TOKEN_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Base token-account length (SPL Token); Token-2022 accounts may be longer (extensions).
const ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;
const STATE_OFFSET: usize = 108;
const STATE_INITIALIZED: u8 = 1;
const STATE_FROZEN: u8 = 2;

pub fn is_token_program(key: &Pubkey) -> bool {
    *key == SPL_TOKEN_ID || *key == TOKEN_2022_ID
}

#[derive(Clone, Copy, Debug)]
pub struct TokenAccountView {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub frozen: bool,
}

/// Reads an initialized token account owned by `token_program`; None when the account is missing,
/// owned by another program, too short or uninitialized.
pub fn read_token_account(info: &AccountInfo, token_program: &Pubkey) -> Option<TokenAccountView> {
    if info.owner != token_program {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    if data.len() < ACCOUNT_LEN || data.len() == MINT_LEN {
        return None;
    }
    let state = data[STATE_OFFSET];
    if state != STATE_INITIALIZED && state != STATE_FROZEN {
        return None;
    }
    Some(TokenAccountView {
        mint: Pubkey::new_from_array(data[0..32].try_into().ok()?),
        owner: Pubkey::new_from_array(data[32..64].try_into().ok()?),
        amount: u64::from_le_bytes(data[64..72].try_into().ok()?),
        frozen: state == STATE_FROZEN,
    })
}

/// Decimals of an initialized mint owned by `token_program`.
pub fn mint_decimals(mint: &AccountInfo, token_program: &Pubkey) -> Result<u8> {
    require_keys_eq!(*mint.owner, *token_program, LoanError::BadMint);
    let data = mint.try_borrow_data()?;
    require!(data.len() >= MINT_LEN && data[45] == 1, LoanError::BadMint);
    Ok(data[44])
}

/// The associated token account of `owner` for `mint` under `token_program`.
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &ATA_PROGRAM_ID).0
}

#[allow(clippy::too_many_arguments)]
pub fn transfer_checked<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(10);
    data.push(12u8); // TransferChecked
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    let infos = [from.clone(), mint.clone(), to.clone(), authority.clone(), token_program.clone()];
    if signer_seeds.is_empty() {
        invoke(&ix, &infos)?;
    } else {
        invoke_signed(&ix, &infos, signer_seeds)?;
    }
    Ok(())
}

/// Associated Token Account `CreateIdempotent`.
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
