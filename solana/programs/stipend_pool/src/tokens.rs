//! Token and account helpers: PDA account creation (robust to pre-funded addresses), token-account
//! creation for vaults and escrows (SPL Token and Token-2022, sized by the token program itself),
//! token-account inspection and vault transfers signed by ["vault_auth"].
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Allocate, Assign, CreateAccount, Transfer};
use anchor_spl::token_interface::{self, GetAccountDataSize, InitializeAccount3, TokenAccount, TransferChecked};

use crate::error::PoolError;
use crate::state::VAULT_AUTH_SEED;

pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

pub fn is_token_program(key: &Pubkey) -> bool {
    *key == anchor_spl::token::ID || *key == anchor_spl::token_2022::ID
}

/// Creates `target` (a PDA of this program signed by `seeds`) with `space` bytes owned by `owner`.
/// An address someone pre-funded with lamports is topped up, allocated and assigned instead.
pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> Result<()> {
    let need = Rent::get()?.minimum_balance(space);
    let have = target.lamports();
    let signer: &[&[&[u8]]] = &[seeds];
    if have == 0 {
        return system_program::create_account(
            CpiContext::new_with_signer(system.key(), CreateAccount { from: payer.clone(), to: target.clone() }, signer),
            need,
            space as u64,
            owner,
        );
    }
    require!(target.owner == &system_program::ID && target.data_is_empty(), PoolError::AccountInUse);
    if need > have {
        system_program::transfer(CpiContext::new(system.key(), Transfer { from: payer.clone(), to: target.clone() }), need - have)?;
    }
    system_program::allocate(CpiContext::new_with_signer(system.key(), Allocate { account_to_allocate: target.clone() }, signer), space as u64)?;
    system_program::assign(CpiContext::new_with_signer(system.key(), Assign { account_to_assign: target.clone() }, signer), owner)
}

/// Creates a token account at the PDA `target` (signed by `seeds`) for `mint`, owned by the vault authority.
pub fn create_token_account_pda<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    vault_authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    require!(is_token_program(token_program.key) && mint.owner == token_program.key, PoolError::WrongTokenProgram);
    let size = token_interface::get_account_data_size(
        CpiContext::new(token_program.key(), GetAccountDataSize { mint: mint.clone() }),
        &[],
    )?;
    create_pda_account(payer, target, system, size as usize, token_program.key, seeds)?;
    token_interface::initialize_account3(CpiContext::new(
        token_program.key(),
        InitializeAccount3 { account: target.clone(), mint: mint.clone(), authority: vault_authority.clone() },
    ))
}

/// Reads a token account owned by `token_program`; None when it is not one (wrong owner, uninitialized, garbage).
pub fn read_token_account(info: &AccountInfo, token_program: &Pubkey) -> Option<TokenAccount> {
    if info.owner != token_program {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    let mut slice: &[u8] = &data;
    <TokenAccount as anchor_lang::AccountDeserialize>::try_deserialize_unchecked(&mut slice).ok()
}

/// Requires `info` to be a token account of `mint` under `token_program`; returns it.
pub fn token_account_of(info: &AccountInfo, mint: &Pubkey, token_program: &Pubkey) -> Result<TokenAccount> {
    let ta = read_token_account(info, token_program).ok_or(error!(PoolError::WrongTokenAccount))?;
    require_keys_eq!(ta.mint, *mint, PoolError::WrongMint);
    Ok(ta)
}

pub struct VaultCtx<'a, 'info> {
    pub vault: &'a AccountInfo<'info>,
    pub vault_authority: &'a AccountInfo<'info>,
    pub vault_auth_bump: u8,
    pub mint: &'a AccountInfo<'info>,
    pub decimals: u8,
    pub token_program: &'a AccountInfo<'info>,
}

impl<'a, 'info> VaultCtx<'a, 'info> {
    /// transfer_checked out of the vault (or another account the vault authority owns, e.g. an escrow).
    pub fn pay_from(&self, from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let seeds: &[&[u8]] = &[VAULT_AUTH_SEED, &[self.vault_auth_bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.key(),
                TransferChecked { from: from.clone(), mint: self.mint.clone(), to: to.clone(), authority: self.vault_authority.clone() },
                &[seeds],
            ),
            amount,
            self.decimals,
        )
    }

    pub fn pay(&self, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        self.pay_from(self.vault, to, amount)
    }

    /// transfer_checked into the vault from `from`, signed by its owner `authority`; requires the vault to
    /// receive exactly `amount` (a transfer-fee mint would credit less than the proof says).
    pub fn receive(&self, from: &AccountInfo<'info>, authority: &AccountInfo<'info>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let before = token_account_of(self.vault, self.mint.key, self.token_program.key)?.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                self.token_program.key(),
                TransferChecked { from: from.clone(), mint: self.mint.clone(), to: self.vault.clone(), authority: authority.clone() },
            ),
            amount,
            self.decimals,
        )?;
        let after = token_account_of(self.vault, self.mint.key, self.token_program.key)?.amount;
        require!(after.checked_sub(before) == Some(amount), PoolError::DepositShortfall);
        Ok(())
    }
}
