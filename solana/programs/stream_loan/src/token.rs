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

/// Token-2022 account extension TLV: the base account (165 B), the account-type byte, then
/// (type u16 LE, length u16 LE, value) entries. ExtensionType::TransferFeeAmount = 2, value = withheld u64.
const EXT_TRANSFER_FEE_AMOUNT: u16 = 2;

/// Transfer fees withheld in a Token-2022 account (TransferFeeAmount extension); 0 for SPL Token accounts and
/// accounts without the extension. CloseAccount refuses an account whose withheld amount is not 0.
pub fn withheld_amount(info: &AccountInfo) -> u64 {
    if *info.owner != TOKEN_2022_ID {
        return 0;
    }
    let Ok(data) = info.try_borrow_data() else { return 0 };
    let mut o = ACCOUNT_LEN + 1;
    while o + 4 <= data.len() {
        let t = u16::from_le_bytes([data[o], data[o + 1]]);
        let len = u16::from_le_bytes([data[o + 2], data[o + 3]]) as usize;
        let v = o + 4;
        if t == 0 || v + len > data.len() {
            break;
        }
        if t == EXT_TRANSFER_FEE_AMOUNT && len >= 8 {
            return u64::from_le_bytes(data[v..v + 8].try_into().unwrap());
        }
        o = v + len;
    }
    0
}

/// Token-2022 `HarvestWithheldTokensToMint` (permissionless): moves the account's withheld transfer fees to the
/// mint, so the account can be closed. TokenInstruction::TransferFeeExtension (26), HarvestWithheldTokensToMint (4).
pub fn harvest_withheld_to_mint<'info>(token_program: &AccountInfo<'info>, mint: &AccountInfo<'info>, account: &AccountInfo<'info>) -> Result<()> {
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![AccountMeta::new(*mint.key, false), AccountMeta::new(*account.key, false)],
        data: vec![26u8, 4u8],
    };
    invoke(&ix, &[mint.clone(), account.clone(), token_program.clone()])?;
    Ok(())
}

/// `CloseAccount` (SPL Token and Token-2022): the empty `account` is closed, its rent goes to `destination`;
/// `owner` (a PDA) signs with `signer_seeds`.
pub fn close_account<'info>(
    token_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![AccountMeta::new(*account.key, false), AccountMeta::new(*destination.key, false), AccountMeta::new_readonly(*owner.key, true)],
        data: vec![9u8],
    };
    invoke_signed(&ix, &[account.clone(), destination.clone(), owner.clone(), token_program.clone()], signer_seeds)?;
    Ok(())
}

/// Token-2022 mint extension TLV: base mint (82 B) padded to 165, the account-type byte, then (type, length, value)
/// entries. ExtensionType::TransferFeeConfig = 1.
const EXT_TRANSFER_FEE_CONFIG: u16 = 1;
/// TransferFeeConfig value: transfer_fee_config_authority (32), withdraw_withheld_authority (32), withheld_amount u64,
/// then older_transfer_fee and newer_transfer_fee, each TransferFee { epoch u64, maximum_fee u64, basis_points u16 }.
const TRANSFER_FEE_CONFIG_LEN: usize = 32 + 32 + 8 + 2 * TRANSFER_FEE_LEN;
const TRANSFER_FEE_LEN: usize = 8 + 8 + 2;
const OLDER_FEE_OFFSET: usize = 32 + 32 + 8;
const NEWER_FEE_OFFSET: usize = OLDER_FEE_OFFSET + TRANSFER_FEE_LEN;

/// True when one TransferFee entry (epoch u64, maximum_fee u64, basis_points u16) can charge anything.
fn fee_entry_charges(v: &[u8]) -> bool {
    let maximum_fee = u64::from_le_bytes([v[8], v[9], v[10], v[11], v[12], v[13], v[14], v[15]]);
    let bps = u16::from_le_bytes([v[16], v[17]]);
    maximum_fee > 0 || bps > 0
}

/// The rule on a Token-2022 mint's raw data (pure, so host tests cover it): true when the mint carries a
/// TransferFeeConfig whose older or newer fee has a rate or a maximum above 0, or a TransferFeeConfig too short to
/// read. A config at 0 bps with maximum 0 (USDG today) charges nothing and is accepted. The newer fee is checked too:
/// the fee authority may have scheduled a rise that applies from a later epoch.
pub fn transfer_fee_active(data: &[u8]) -> bool {
    let mut o = ACCOUNT_LEN + 1;
    while o + 4 <= data.len() {
        let t = u16::from_le_bytes([data[o], data[o + 1]]);
        let len = u16::from_le_bytes([data[o + 2], data[o + 3]]) as usize;
        if t == 0 {
            break;
        }
        let v = o + 4;
        if t == EXT_TRANSFER_FEE_CONFIG {
            if len < TRANSFER_FEE_CONFIG_LEN || v + TRANSFER_FEE_CONFIG_LEN > data.len() {
                return true;
            }
            let c = &data[v..v + TRANSFER_FEE_CONFIG_LEN];
            return fee_entry_charges(&c[OLDER_FEE_OFFSET..OLDER_FEE_OFFSET + TRANSFER_FEE_LEN])
                || fee_entry_charges(&c[NEWER_FEE_OFFSET..NEWER_FEE_OFFSET + TRANSFER_FEE_LEN]);
        }
        o = v + len;
    }
    false
}

/// True when a Token-2022 mint can charge a transfer fee now or from a scheduled epoch (transfer_fee_active). False for
/// SPL Token mints, Token-2022 mints without TransferFeeConfig, and a TransferFeeConfig at 0 bps with maximum 0.
pub fn mint_charges_transfer_fee(mint: &AccountInfo) -> bool {
    if *mint.owner != TOKEN_2022_ID {
        return false;
    }
    let Ok(data) = mint.try_borrow_data() else { return true };
    transfer_fee_active(&data)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Token-2022 mint with the given (type, value) extensions: 165 B base, account type 1 (Mint), then the TLV.
    fn mint_with(exts: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut d = vec![0u8; ACCOUNT_LEN];
        d.push(1);
        for (t, v) in exts {
            d.extend_from_slice(&t.to_le_bytes());
            d.extend_from_slice(&(v.len() as u16).to_le_bytes());
            d.extend_from_slice(v);
        }
        d
    }
    fn fee_config(older: (u64, u16), newer: (u64, u16)) -> Vec<u8> {
        let mut v = vec![7u8; 64]; // both authorities set
        v.extend_from_slice(&123u64.to_le_bytes()); // withheld
        for (max, bps) in [older, newer] {
            v.extend_from_slice(&5u64.to_le_bytes()); // epoch
            v.extend_from_slice(&max.to_le_bytes());
            v.extend_from_slice(&bps.to_le_bytes());
        }
        assert_eq!(v.len(), TRANSFER_FEE_CONFIG_LEN);
        v
    }

    #[test]
    fn transfer_fee_rule() {
        const PERMANENT_DELEGATE: u16 = 12;
        let pd = (PERMANENT_DELEGATE, vec![9u8; 32]);
        let cfg = |older, newer| (EXT_TRANSFER_FEE_CONFIG, fee_config(older, newer));
        // USDG today: TransferFeeConfig at 0 bps and maximum 0, next to a PermanentDelegate, in either order
        assert!(!transfer_fee_active(&mint_with(&[cfg((0, 0), (0, 0)), pd.clone()])));
        assert!(!transfer_fee_active(&mint_with(&[pd.clone(), cfg((0, 0), (0, 0))])));
        // no extension, only a PermanentDelegate, or a plain 82-byte mint
        assert!(!transfer_fee_active(&mint_with(&[])));
        assert!(!transfer_fee_active(&mint_with(&[pd.clone()])));
        assert!(!transfer_fee_active(&[0u8; 82]));
        // a rate or a maximum on the older (current) or the newer (scheduled) fee
        assert!(transfer_fee_active(&mint_with(&[cfg((1_000_000, 100), (1_000_000, 100))])));
        assert!(transfer_fee_active(&mint_with(&[cfg((0, 0), (0, 1))])));
        assert!(transfer_fee_active(&mint_with(&[cfg((0, 0), (1, 0))])));
        assert!(transfer_fee_active(&mint_with(&[cfg((0, 1), (0, 0))])));
        assert!(transfer_fee_active(&mint_with(&[pd, cfg((1, 0), (0, 0))])));
        // a config too short to read counts as a fee
        assert!(transfer_fee_active(&mint_with(&[(EXT_TRANSFER_FEE_CONFIG, vec![0u8; 40])])));
    }
}
