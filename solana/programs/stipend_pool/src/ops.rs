//! The pool operations: transact, grant, spend, delegate, pull_lender_share. Each mirrors the function of
//! the same name in contracts/StipendPool.sol; see docs/SOLANA-PORT.md section 3.1 for the mapping.
//!
//! Every proof-bearing operation reads `Proof | Args | ExtData` (borsh) from a staged Buffer. The ext
//! data is never copied: extDataHash = keccak256(the ext bytes as staged) mod r, and memos are emitted
//! as slices of the buffer.
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;

use crate::error::PoolError;
use crate::events::*;
use crate::field::{self, field_of, field_of_opt, hash_to_field, is_zero, token_amount, u128_field, u64_field, Fe, ZERO};
use crate::groth16::Proof;
use crate::merkle;
use crate::state::*;
use crate::tokens::{self, VaultCtx};
use crate::{require_proof, CIRCUIT_DELEGATE, CIRCUIT_GRANT, CIRCUIT_SPEND, CIRCUIT_TRANSACT};
use crate::{Delegate, Grant, PullLenderShare, Spend, Transact};

// ------------------------------------------------------------------ payload

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransactArgs {
    pub root: Fe,
    /// (extAmount - fee) mod r
    pub public_amount: Fe,
    pub ext_data_hash: Fe,
    pub input_nullifiers: [Fe; 2],
    pub output_commitments: [Fe; 2],
}

/// borsh: recipient | relayer | fee_recipient | ext_amount i128 | fee u128 | encrypted_outputs [Vec<u8>; 2].
/// `recipient` is the withdrawal destination token account and `fee_recipient` the relayer's token account
/// (Pubkey::default when unused); the asset is the mint account, bound to the proof as fieldOf(mint).
pub struct TransactExt<'a> {
    pub recipient: Pubkey,
    pub relayer: Pubkey,
    pub fee_recipient: Pubkey,
    pub ext_amount: i128,
    pub fee: u128,
    pub outputs: [&'a [u8]; 2],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GrantArgs {
    pub root: Fe,
    pub input_nullifiers: [Fe; 2],
    pub allowance_commitments: [Fe; GRANT_OUTPUTS],
    pub change_commitment: Fe,
    pub total_commitment: Fe,
    pub ext_data_hash: Fe,
}

/// borsh: encrypted_allowances [Vec<u8>; 16] | encrypted_change Vec<u8>.
pub struct GrantExt<'a> {
    pub allowances: [&'a [u8]; GRANT_OUTPUTS],
    pub change: &'a [u8],
}

/// Spend public inputs. Addresses that are accounts travel as pubkeys and are mapped with fieldOf on chain
/// (Pubkey::default stands for 0). `lender_addr` is the circuit's lender field: the program never pays it
/// to an account whose owner does not map to it, and a claim needs a signer that maps to it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SpendArgs {
    pub root: Fe,
    pub nullifier: Fe,
    pub new_allowance_commitment: Fe,
    /// zero for a public payout or a lender claim
    pub pay_commitment: Fe,
    /// net of the lender share; zero for a shielded payout or a claim
    pub public_amount: u128,
    /// wallet owning the payout token account
    pub public_recipient: Pubkey,
    /// the mint; set whenever a share may be paid
    pub public_asset: Pubkey,
    pub fee: u128,
    /// `now` inside the proof
    pub timestamp: u64,
    pub receipt: Fe,
    pub lender_amount: u128,
    pub lender_addr: Fe,
    pub loan_ref: u64,
    pub is_lender_claim: bool,
    pub ext_data_hash: Fe,
}

/// borsh: relayer | fee_recipient | encrypted_allowance | encrypted_payment | encrypted_lender.
pub struct SpendExt<'a> {
    pub relayer: Pubkey,
    pub fee_recipient: Pubkey,
    pub allowance: &'a [u8],
    pub payment: &'a [u8],
    pub lender: &'a [u8],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DelegateArgs {
    pub root: Fe,
    pub nullifier: Fe,
    pub sub_commitments: [Fe; DELEGATE_OUTPUTS],
    pub residual_commitment: Fe,
    pub timestamp: u64,
    pub ext_data_hash: Fe,
}

/// borsh: encrypted_subs [Vec<u8>; 4] | encrypted_residual Vec<u8>.
pub struct DelegateExt<'a> {
    pub subs: [&'a [u8]; DELEGATE_OUTPUTS],
    pub residual: &'a [u8],
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or(error!(PoolError::BufferPayload))?;
        require!(end <= self.data.len(), PoolError::BufferPayload);
        let s = &self.data[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn pubkey(&mut self) -> Result<Pubkey> {
        Ok(Pubkey::new_from_array(self.take(32)?.try_into().unwrap()))
    }
    fn u128(&mut self) -> Result<u128> {
        Ok(u128::from_le_bytes(self.take(16)?.try_into().unwrap()))
    }
    fn i128(&mut self) -> Result<i128> {
        Ok(i128::from_le_bytes(self.take(16)?.try_into().unwrap()))
    }
    fn bytes(&mut self) -> Result<&'a [u8]> {
        let n = u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as usize;
        self.take(n)
    }
    fn finish(&self) -> Result<()> {
        require!(self.pos == self.data.len(), PoolError::BufferPayload);
        Ok(())
    }
}

impl<'a> TransactExt<'a> {
    fn parse(data: &'a [u8]) -> Result<Self> {
        let mut c = Cursor { data, pos: 0 };
        let e = Self {
            recipient: c.pubkey()?,
            relayer: c.pubkey()?,
            fee_recipient: c.pubkey()?,
            ext_amount: c.i128()?,
            fee: c.u128()?,
            outputs: [c.bytes()?, c.bytes()?],
        };
        c.finish()?;
        Ok(e)
    }
}

impl<'a> GrantExt<'a> {
    fn parse(data: &'a [u8]) -> Result<Self> {
        let mut c = Cursor { data, pos: 0 };
        let mut allowances: [&'a [u8]; GRANT_OUTPUTS] = [&[]; GRANT_OUTPUTS];
        for a in allowances.iter_mut() {
            *a = c.bytes()?;
        }
        let change = c.bytes()?;
        c.finish()?;
        Ok(Self { allowances, change })
    }
}

impl<'a> SpendExt<'a> {
    fn parse(data: &'a [u8]) -> Result<Self> {
        let mut c = Cursor { data, pos: 0 };
        let e = Self { relayer: c.pubkey()?, fee_recipient: c.pubkey()?, allowance: c.bytes()?, payment: c.bytes()?, lender: c.bytes()? };
        c.finish()?;
        Ok(e)
    }
}

impl<'a> DelegateExt<'a> {
    fn parse(data: &'a [u8]) -> Result<Self> {
        let mut c = Cursor { data, pos: 0 };
        let mut subs: [&'a [u8]; DELEGATE_OUTPUTS] = [&[]; DELEGATE_OUTPUTS];
        for s in subs.iter_mut() {
            *s = c.bytes()?;
        }
        let residual = c.bytes()?;
        c.finish()?;
        Ok(Self { subs, residual })
    }
}

/// The staged payload of a buffer: `Proof | Args | ext bytes`.
fn split<'a, A: AnchorDeserialize>(data: &'a [u8], len: u32) -> Result<(Proof, Box<A>, &'a [u8])> {
    let end = Buffer::HEADER + len as usize;
    require!(data.len() >= end, PoolError::BufferPayload);
    let mut s: &[u8] = &data[Buffer::HEADER..end];
    let proof = Proof::deserialize(&mut s).map_err(|_| error!(PoolError::BufferPayload))?;
    let args = Box::new(A::deserialize(&mut s).map_err(|_| error!(PoolError::BufferPayload))?);
    Ok((proof, args, s))
}

fn max_len(memos: &[&[u8]]) -> usize {
    memos.iter().map(|m| m.len()).max().unwrap_or(0) + 96
}

// ------------------------------------------------------------------ shared steps

fn check_ext(ext_bytes: &[u8], ext_data_hash: &Fe) -> Result<()> {
    require!(hash_to_field(ext_bytes) == *ext_data_hash, PoolError::ExtData);
    Ok(())
}

fn check_root(pool: &Pool, root: &Fe) -> Result<()> {
    require!(merkle::is_known_root(pool, root), PoolError::UnknownRoot);
    Ok(())
}

/// `now` in the proof must fall in [clock - NOW_LOOKBACK, clock + NOW_LOOKAHEAD].
fn check_now(timestamp: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp as i128;
    let t = timestamp as i128;
    require!(t + NOW_LOOKBACK as i128 >= now && t <= now + NOW_LOOKAHEAD as i128, PoolError::StaleTimestamp);
    Ok(())
}

/// Creates the nullifier PDA ["nf", nullifier]; an existing one means the note was spent.
fn spend_nullifier<'info>(
    nf: &Fe,
    account: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    emitter: &mut Emitter<'info>,
) -> Result<()> {
    let (expected, bump) = Pubkey::find_program_address(&[NULLIFIER_SEED, nf], &crate::ID);
    require_keys_eq!(account.key(), expected, PoolError::NullifierAccount);
    require!(account.owner != &crate::ID, PoolError::AlreadySpent);
    tokens::create_pda_account(payer, account, system, Nullifier::SIZE, &crate::ID, &[NULLIFIER_SEED, nf, &[bump]])?;
    account.try_borrow_mut_data()?[..8].copy_from_slice(Nullifier::DISCRIMINATOR);
    emitter.emit(&NewNullifier { nullifier: *nf })
}

fn insert_with_memo(pool: &mut Pool, commitment: &Fe, memo: &[u8], emitter: &mut Emitter) -> Result<u32> {
    let index = merkle::insert(pool, commitment)?;
    emitter.commitment(commitment, index, memo)?;
    Ok(index)
}

fn required<'a, T>(x: &'a Option<T>) -> Result<&'a T> {
    x.as_ref().ok_or(error!(PoolError::MissingAccount))
}

/// The vault of `asset`: requires the mint account to be `asset`, the token program to own it and the
/// vault to be the PDA ["vault", mint].
fn vault_ctx<'a, 'info>(
    mint: &'a Option<Box<InterfaceAccount<'info, anchor_spl::token_interface::Mint>>>,
    mint_info: &'a AccountInfo<'info>,
    vault: &'a Option<UncheckedAccount<'info>>,
    vault_authority: &'a AccountInfo<'info>,
    vault_auth_bump: u8,
    token_program: &'a AccountInfo<'info>,
    asset: &Pubkey,
) -> Result<VaultCtx<'a, 'info>> {
    let m = required(mint)?;
    require_keys_eq!(m.key(), *asset, PoolError::AssetRequired);
    require!(tokens::is_token_program(token_program.key) && mint_info.owner == token_program.key, PoolError::WrongTokenProgram);
    let vault = required(vault)?;
    let (expected, _) = Pubkey::find_program_address(&[VAULT_SEED, asset.as_ref()], &crate::ID);
    require_keys_eq!(vault.key(), expected, PoolError::WrongVault);
    Ok(VaultCtx { vault: vault.as_ref(), vault_authority, vault_auth_bump, mint: mint_info, decimals: m.decimals, token_program })
}

fn opt_info<'info>(x: &Option<UncheckedAccount<'info>>) -> Option<AccountInfo<'info>> {
    x.as_ref().map(|a| a.to_account_info())
}

/// True when `account` is the associated token account of `owner` for `mint` under `token_program`.
///
/// Every token destination that is not bound by extDataHash (the public payout, the lender leg and the
/// escrow release) must be the owner's canonical ATA. Otherwise whoever submits the transaction could pick
/// any token account the owner nominally holds, for example a non-ATA account created with
/// InitializeAccount3(owner = a program PDA) that the owning program never reads. A stream_loan slot only
/// syncs and forwards its ATA (the inbox), so a share sent elsewhere would be lost and never credited.
pub(crate) fn is_ata(account: &Pubkey, owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> bool {
    let (ata, _) = Pubkey::find_program_address(&[owner.as_ref(), token_program.as_ref(), mint.as_ref()], &tokens::ATA_PROGRAM_ID);
    ata == *account
}

// ------------------------------------------------------------------ transact

pub fn transact<'info>(ctx: Context<'info, Transact<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    let buf_info = a.buffer.to_account_info();
    let data = buf_info.try_borrow_data()?;
    let (proof, args, ext_bytes) = split::<TransactArgs>(&data, a.buffer.len)?;
    let ext = TransactExt::parse(ext_bytes)?;
    let mut pool = a.pool.load_mut()?;

    check_root(&pool, &args.root)?;
    check_ext(ext_bytes, &args.ext_data_hash)?;
    require!(args.input_nullifiers[0] != args.input_nullifiers[1], PoolError::SameNullifier);
    require!(args.public_amount == field::public_amount(ext.ext_amount, ext.fee), PoolError::PublicAmount);
    let moves_tokens = !(ext.ext_amount == 0 && ext.fee == 0);
    let public_asset = if moves_tokens { field_of(&required(&a.mint)?.key()) } else { ZERO };
    require_proof(
        CIRCUIT_TRANSACT,
        &proof,
        &[
            args.root,
            args.public_amount,
            public_asset,
            args.ext_data_hash,
            args.input_nullifiers[0],
            args.input_nullifiers[1],
            args.output_commitments[0],
            args.output_commitments[1],
        ],
    )?;

    let payer = a.payer.to_account_info();
    let system = a.system_program.to_account_info();
    let mut emitter = Emitter::new(a.event_authority.to_account_info(), max_len(&ext.outputs));
    spend_nullifier(&args.input_nullifiers[0], &a.nullifier0.to_account_info(), &payer, &system, &mut emitter)?;
    spend_nullifier(&args.input_nullifiers[1], &a.nullifier1.to_account_info(), &payer, &system, &mut emitter)?;

    let vault_authority = a.vault_authority.to_account_info();
    let (mint_info, tp_info) = (a.mint.as_ref().map(|m| m.to_account_info()), a.token_program.as_ref().map(|t| t.to_account_info()));
    let vault = if moves_tokens {
        let mi = mint_info.as_ref().ok_or(error!(PoolError::AssetRequired))?;
        let tp = tp_info.as_ref().ok_or(error!(PoolError::MissingAccount))?;
        Some(vault_ctx(&a.mint, mi, &a.vault, &vault_authority, ctx.bumps.vault_authority, tp, &a.mint.as_ref().unwrap().key())?)
    } else {
        None
    };

    if ext.ext_amount > 0 {
        let v = vault.as_ref().unwrap();
        let from = opt_info(&a.depositor_token).ok_or(error!(PoolError::MissingAccount))?;
        v.receive(&from, &payer, token_amount(ext.ext_amount as u128)?)?;
    }

    insert_with_memo(&mut pool, &args.output_commitments[0], ext.outputs[0], &mut emitter)?;
    insert_with_memo(&mut pool, &args.output_commitments[1], ext.outputs[1], &mut emitter)?;

    if ext.ext_amount < 0 {
        let v = vault.as_ref().unwrap();
        require!(ext.recipient != Pubkey::default(), PoolError::Recipient);
        let to = opt_info(&a.recipient_token).ok_or(error!(PoolError::MissingAccount))?;
        require_keys_eq!(to.key(), ext.recipient, PoolError::Recipient);
        tokens::token_account_of(&to, v.mint.key, v.token_program.key)?;
        v.pay(&to, token_amount(ext.ext_amount.unsigned_abs())?)?;
    }
    if ext.fee > 0 {
        let v = vault.as_ref().unwrap();
        let to = opt_info(&a.fee_token).ok_or(error!(PoolError::MissingAccount))?;
        require_keys_eq!(to.key(), ext.fee_recipient, PoolError::WrongTokenAccount);
        v.pay(&to, token_amount(ext.fee)?)?;
    }
    let _ = ext.relayer;
    Ok(())
}

// ------------------------------------------------------------------ grant

pub fn grant<'info>(ctx: Context<'info, Grant<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    let buf_info = a.buffer.to_account_info();
    let data = buf_info.try_borrow_data()?;
    let (proof, args, ext_bytes) = split::<GrantArgs>(&data, a.buffer.len)?;
    let ext = GrantExt::parse(ext_bytes)?;
    let mut pool = a.pool.load_mut()?;

    check_root(&pool, &args.root)?;
    check_ext(ext_bytes, &args.ext_data_hash)?;
    require!(args.input_nullifiers[0] != args.input_nullifiers[1], PoolError::SameNullifier);
    let mut input = [ZERO; 3 + GRANT_OUTPUTS + 3];
    input[0] = args.root;
    input[1] = args.input_nullifiers[0];
    input[2] = args.input_nullifiers[1];
    input[3..3 + GRANT_OUTPUTS].copy_from_slice(&args.allowance_commitments);
    input[3 + GRANT_OUTPUTS] = args.change_commitment;
    input[4 + GRANT_OUTPUTS] = args.total_commitment;
    input[5 + GRANT_OUTPUTS] = args.ext_data_hash;
    require_proof(CIRCUIT_GRANT, &proof, &input)?;

    let payer = a.payer.to_account_info();
    let system = a.system_program.to_account_info();
    let mut memos: [&[u8]; GRANT_OUTPUTS + 1] = [&[]; GRANT_OUTPUTS + 1];
    memos[..GRANT_OUTPUTS].copy_from_slice(&ext.allowances);
    memos[GRANT_OUTPUTS] = ext.change;
    let mut emitter = Emitter::new(a.event_authority.to_account_info(), max_len(&memos));
    spend_nullifier(&args.input_nullifiers[0], &a.nullifier0.to_account_info(), &payer, &system, &mut emitter)?;
    spend_nullifier(&args.input_nullifiers[1], &a.nullifier1.to_account_info(), &payer, &system, &mut emitter)?;

    let first = pool.next_index;
    for i in 0..GRANT_OUTPUTS {
        insert_with_memo(&mut pool, &args.allowance_commitments[i], ext.allowances[i], &mut emitter)?;
    }
    insert_with_memo(&mut pool, &args.change_commitment, ext.change, &mut emitter)?;
    emitter.emit(&NewGrant { total_commitment: args.total_commitment, first_index: first })
}

// ------------------------------------------------------------------ spend

pub fn spend<'info>(ctx: Context<'info, Spend<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    let buf_info = a.buffer.to_account_info();
    let data = buf_info.try_borrow_data()?;
    let (proof, args, ext_bytes) = split::<SpendArgs>(&data, a.buffer.len)?;
    let ext = SpendExt::parse(ext_bytes)?;
    let mut pool = a.pool.load_mut()?;

    check_root(&pool, &args.root)?;
    check_ext(ext_bytes, &args.ext_data_hash)?;
    check_now(args.timestamp)?;
    let public_asset = field_of_opt(&args.public_asset);
    require_proof(
        CIRCUIT_SPEND,
        &proof,
        &[
            args.root,
            args.nullifier,
            args.new_allowance_commitment,
            args.pay_commitment,
            u128_field(args.public_amount),
            field_of_opt(&args.public_recipient),
            public_asset,
            u128_field(args.fee),
            u64_field(args.timestamp),
            args.receipt,
            u128_field(args.lender_amount),
            args.lender_addr,
            u64_field(args.loan_ref),
            u64_field(args.is_lender_claim as u64),
            args.ext_data_hash,
        ],
    )?;
    // Only the lender itself pulls its vested share: msg.sender == lenderAddr becomes fieldOf(signer) == lenderAddr.
    if args.is_lender_claim {
        let signer = a.lender_signer.as_ref().ok_or(error!(PoolError::Lender))?;
        require!(field_of(signer.key) == args.lender_addr, PoolError::Lender);
    }

    let payer = a.payer.to_account_info();
    let system = a.system_program.to_account_info();
    let mut emitter = Emitter::new(a.event_authority.to_account_info(), max_len(&[ext.allowance, ext.payment, ext.lender]));
    spend_nullifier(&args.nullifier, &a.nullifier.to_account_info(), &payer, &system, &mut emitter)?;
    insert_with_memo(&mut pool, &args.new_allowance_commitment, ext.allowance, &mut emitter)?;

    let vault_authority = a.vault_authority.to_account_info();
    let mint_info = a.mint.as_ref().map(|m| m.to_account_info());
    let tp_info = a.token_program.as_ref().map(|t| t.to_account_info());
    let vault = if args.public_amount > 0 || args.lender_amount > 0 {
        let mi = mint_info.as_ref().ok_or(error!(PoolError::AssetRequired))?;
        let tp = tp_info.as_ref().ok_or(error!(PoolError::MissingAccount))?;
        Some(vault_ctx(&a.mint, mi, &a.vault, &vault_authority, ctx.bumps.vault_authority, tp, &args.public_asset)?)
    } else {
        None
    };

    if args.public_amount > 0 {
        require!(args.public_recipient != Pubkey::default(), PoolError::Recipient);
        let v = vault.as_ref().unwrap();
        let to_recipient = args.public_amount.checked_sub(args.fee).ok_or(error!(PoolError::FeeExceedsAmount))?;
        let to = opt_info(&a.recipient_token).ok_or(error!(PoolError::MissingAccount))?;
        let ta = tokens::token_account_of(&to, v.mint.key, v.token_program.key)?;
        require_keys_eq!(ta.owner, args.public_recipient, PoolError::Recipient);
        // the payout account is not in extDataHash: only the recipient's canonical ATA is accepted
        require!(is_ata(to.key, &args.public_recipient, v.mint.key, v.token_program.key), PoolError::Recipient);
        let amount = token_amount(to_recipient)?;
        v.pay(&to, amount)?;
        if args.fee > 0 {
            let fee_to = opt_info(&a.fee_token).ok_or(error!(PoolError::MissingAccount))?;
            require_keys_eq!(fee_to.key(), ext.fee_recipient, PoolError::WrongTokenAccount);
            v.pay(&fee_to, token_amount(args.fee)?)?;
        }
        emitter.emit(&PublicPayout { asset: args.public_asset, recipient: args.public_recipient, token_account: to.key(), amount })?;
    } else if !args.is_lender_claim && !is_zero(&args.pay_commitment) {
        // A public spend whose net is zero (pledgeBps 10000) has no payout note to insert.
        insert_with_memo(&mut pool, &args.pay_commitment, ext.payment, &mut emitter)?;
    }

    if args.lender_amount > 0 {
        require!(!is_zero(&args.lender_addr), PoolError::Lender);
        let v = vault.as_ref().unwrap();
        let amount = token_amount(args.lender_amount)?;
        // The lender leg never blocks a spend: a share that cannot be delivered to the canonical ATA of an
        // owner that maps to lenderAddr (none given, wrong owner or mint, not the owner's ATA, frozen) goes
        // to the escrow token account ["owed", mint, lenderAddr, loanRef], from which anyone may push it to
        // that ATA with pull_lender_share.
        let lender_to = opt_info(&a.lender_token).filter(|info| {
            info.key != v.vault.key
                && tokens::read_token_account(info, v.token_program.key)
                    .map(|ta| {
                        ta.mint == *v.mint.key
                            && !ta.is_frozen()
                            && field_of(&ta.owner) == args.lender_addr
                            && is_ata(info.key, &ta.owner, v.mint.key, v.token_program.key)
                    })
                    .unwrap_or(false)
        });
        let delivered_to = match lender_to {
            Some(to) => {
                v.pay(&to, amount)?;
                to.key()
            }
            None => {
                let escrow = opt_info(&a.escrow).ok_or(error!(PoolError::MissingAccount))?;
                let loan_ref = args.loan_ref.to_le_bytes();
                let (expected, bump) =
                    Pubkey::find_program_address(&[ESCROW_SEED, v.mint.key.as_ref(), &args.lender_addr, &loan_ref], &crate::ID);
                require_keys_eq!(escrow.key(), expected, PoolError::WrongEscrow);
                if escrow.owner == &anchor_lang::system_program::ID {
                    tokens::create_token_account_pda(
                        &payer,
                        &escrow,
                        v.mint,
                        v.vault_authority,
                        v.token_program,
                        &system,
                        &[ESCROW_SEED, v.mint.key.as_ref(), &args.lender_addr, &loan_ref, &[bump]],
                    )?;
                }
                tokens::token_account_of(&escrow, v.mint.key, v.token_program.key)?;
                v.pay(&escrow, amount)?;
                emitter.emit(&PledgeEscrowed { lender_addr: args.lender_addr, loan_ref: args.loan_ref, asset: args.public_asset, amount })?;
                escrow.key()
            }
        };
        emitter.emit(&PledgeRouted {
            lender_addr: args.lender_addr,
            loan_ref: args.loan_ref,
            asset: args.public_asset,
            amount,
            nullifier: args.nullifier,
            delivered_to,
        })?;
    }
    if !ext.lender.is_empty() {
        emitter.lender_memo(args.loan_ref, ext.lender)?;
    }
    let _ = ext.relayer;
    emitter.emit(&NewReceipt { receipt: args.receipt })
}

// ------------------------------------------------------------------ delegate

pub fn delegate<'info>(ctx: Context<'info, Delegate<'info>>) -> Result<()> {
    let a = &ctx.accounts;
    let buf_info = a.buffer.to_account_info();
    let data = buf_info.try_borrow_data()?;
    let (proof, args, ext_bytes) = split::<DelegateArgs>(&data, a.buffer.len)?;
    let ext = DelegateExt::parse(ext_bytes)?;
    let mut pool = a.pool.load_mut()?;

    check_root(&pool, &args.root)?;
    check_ext(ext_bytes, &args.ext_data_hash)?;
    check_now(args.timestamp)?;
    require_proof(
        CIRCUIT_DELEGATE,
        &proof,
        &[
            args.root,
            args.nullifier,
            args.sub_commitments[0],
            args.sub_commitments[1],
            args.sub_commitments[2],
            args.sub_commitments[3],
            args.residual_commitment,
            u64_field(args.timestamp),
            args.ext_data_hash,
        ],
    )?;

    let payer = a.payer.to_account_info();
    let system = a.system_program.to_account_info();
    let mut memos: [&[u8]; DELEGATE_OUTPUTS + 1] = [&[]; DELEGATE_OUTPUTS + 1];
    memos[..DELEGATE_OUTPUTS].copy_from_slice(&ext.subs);
    memos[DELEGATE_OUTPUTS] = ext.residual;
    let mut emitter = Emitter::new(a.event_authority.to_account_info(), max_len(&memos));
    spend_nullifier(&args.nullifier, &a.nullifier.to_account_info(), &payer, &system, &mut emitter)?;
    let first = pool.next_index;
    for i in 0..DELEGATE_OUTPUTS {
        insert_with_memo(&mut pool, &args.sub_commitments[i], ext.subs[i], &mut emitter)?;
    }
    insert_with_memo(&mut pool, &args.residual_commitment, ext.residual, &mut emitter)?;
    emitter.emit(&NewDelegation { nullifier: args.nullifier, first_index: first })
}

// ------------------------------------------------------------------ escrow

/// Delivers an escrowed lender share to the associated token account of an owner that maps to
/// `lender_addr`. Anyone may call it; the destination is fixed, so the caller cannot divert the share.
pub fn pull_lender_share<'info>(ctx: Context<'info, PullLenderShare<'info>>, lender_addr: Fe, loan_ref: u64) -> Result<()> {
    let a = &ctx.accounts;
    let mint_info = a.mint.to_account_info();
    let tp = a.token_program.to_account_info();
    require!(mint_info.owner == tp.key && tokens::is_token_program(tp.key), PoolError::WrongTokenProgram);
    let escrow = a.escrow.to_account_info();
    let owed = tokens::token_account_of(&escrow, mint_info.key, tp.key).map_err(|_| error!(PoolError::NothingOwed))?.amount;
    require!(owed > 0, PoolError::NothingOwed);
    let to = a.lender_token.to_account_info();
    let ta = tokens::token_account_of(&to, mint_info.key, tp.key)?;
    require!(field_of(&ta.owner) == lender_addr, PoolError::Lender);
    require!(is_ata(to.key, &ta.owner, mint_info.key, tp.key), PoolError::LenderAccount);
    let vault_authority = a.vault_authority.to_account_info();
    let v = VaultCtx {
        vault: &escrow,
        vault_authority: &vault_authority,
        vault_auth_bump: ctx.bumps.vault_authority,
        mint: &mint_info,
        decimals: a.mint.decimals,
        token_program: &tp,
    };
    v.pay_from(&escrow, &to, owed)?;
    let mut emitter = Emitter::new(a.event_authority.to_account_info(), 256);
    emitter.emit(&LenderShareReleased { lender_addr, loan_ref, asset: mint_info.key(), amount: owed, delivered_to: to.key() })
}
