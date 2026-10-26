//! stipend_pool: the H0.81 Capital shielded pool on Solana. Port of contracts/StipendPool.sol.
//! No admin key, no pause, no upgrade logic. See docs/SOLANA-PORT.md.
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

pub mod error;
pub mod events;
pub mod field;
pub mod generated;
pub mod groth16;
pub mod merkle;
pub mod ops;
pub mod state;
pub mod tokens;

use error::PoolError;
use generated::vk;
use groth16::{Proof, VerifyingKey};
use state::{Buffer, Pool, BUFFER_SEED, ESCROW_SEED, POOL_SEED, VAULT_AUTH_SEED, VAULT_SEED};

#[cfg(not(feature = "merkle-probe"))]
declare_id!("AzES8Vd7NmoxdSrEBbwDNAwn2pyoAz5m5w7bmVas5Si3");
#[cfg(feature = "merkle-probe")]
declare_id!("FWV9zZmHQoXE1M16eNcCTmzwVKft8RbS5zFUZ1od4hDR");

/// Circuit ids for `verify_proof`.
pub const CIRCUIT_TRANSACT: u8 = 0;
pub const CIRCUIT_GRANT: u8 = 1;
pub const CIRCUIT_SPEND: u8 = 2;
pub const CIRCUIT_DISCLOSE: u8 = 3;
pub const CIRCUIT_DELEGATE: u8 = 4;
pub const CIRCUIT_STREAM: u8 = 5;

pub fn verifying_key(circuit: u8) -> Result<&'static VerifyingKey> {
    Ok(match circuit {
        CIRCUIT_TRANSACT => &vk::TRANSACT_VK,
        CIRCUIT_GRANT => &vk::GRANT_VK,
        CIRCUIT_SPEND => &vk::SPEND_VK,
        CIRCUIT_DISCLOSE => &vk::DISCLOSE_VK,
        CIRCUIT_DELEGATE => &vk::DELEGATE_VK,
        CIRCUIT_STREAM => &vk::STREAM_VK,
        _ => return err!(PoolError::UnknownCircuit),
    })
}

/// Public inputs of the disclose circuit, in circuit order (32-byte big-endian field elements).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DiscloseArgs {
    pub root: [u8; 32],
    pub kind: [u8; 32],
    pub bound: [u8; 32],
    pub window_id: [u8; 32],
    pub agent_pk: [u8; 32],
    pub audience: [u8; 32],
}

/// Public inputs of the stream circuit, in circuit order. `lender` and `asset` are accounts; the
/// program maps them with fieldOf, never trusting a client-supplied field value for an account.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StreamArgs {
    pub root: [u8; 32],
    pub min_remaining: [u8; 32],
    pub min_rate: [u8; 32],
    pub lender: Pubkey,
    pub loan_ref: u64,
    pub pledge_bps: u16,
    pub expiry: u64,
    pub lifetime_cap: [u8; 32],
    pub pledge_paid: [u8; 32],
    pub agent_pk: [u8; 32],
    pub audience: [u8; 32],
    pub stream_start: u64,
    pub asset: Pubkey,
}

impl StreamArgs {
    pub fn public_inputs(&self) -> [[u8; 32]; 13] {
        [
            self.root,
            self.min_remaining,
            self.min_rate,
            field::field_of(&self.lender),
            field::u64_field(self.loan_ref),
            field::u64_field(self.pledge_bps as u64),
            field::u64_field(self.expiry),
            self.lifetime_cap,
            self.pledge_paid,
            self.agent_pk,
            self.audience,
            field::u64_field(self.stream_start),
            field::field_of(&self.asset),
        ]
    }
}

/// Reads the staged payload of a buffer and borsh-decodes it, requiring every byte to be consumed.
pub fn read_payload<T: AnchorDeserialize>(buffer: &Account<Buffer>) -> Result<T> {
    let info = buffer.to_account_info();
    let data = info.try_borrow_data()?;
    let end = Buffer::HEADER + buffer.len as usize;
    require!(data.len() >= end, PoolError::BufferPayload);
    let mut slice: &[u8] = &data[Buffer::HEADER..end];
    let v = T::deserialize(&mut slice).map_err(|_| error!(PoolError::BufferPayload))?;
    require!(slice.is_empty(), PoolError::BufferPayload);
    Ok(v)
}

/// Checks a proof against a circuit's key; fails the instruction if it does not verify.
pub fn require_proof(circuit: u8, proof: &Proof, inputs: &[[u8; 32]]) -> Result<()> {
    let ok = groth16::verify(verifying_key(circuit)?, proof, inputs)?;
    require!(ok, PoolError::InvalidProof);
    Ok(())
}

#[program]
pub mod stipend_pool {
    use super::*;

    /// Creates the pool's Merkle state. Permissionless; the `init` constraint makes a second call fail.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let mut pool = ctx.accounts.pool.load_init()?;
        merkle::init_tree(&mut pool);
        Ok(())
    }

    /// Creates the vault token account ["vault", mint] (authority ["vault_auth"]) of a mint. Permissionless,
    /// once per mint; SPL Token or Token-2022, sized by the token program for the mint's extensions.
    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        let a = &ctx.accounts;
        let mint = a.mint.to_account_info();
        let mint_key = mint.key();
        tokens::create_token_account_pda(
            &a.payer.to_account_info(),
            &a.vault.to_account_info(),
            &mint,
            &a.vault_authority.to_account_info(),
            &a.token_program.to_account_info(),
            &a.system_program.to_account_info(),
            &[VAULT_SEED, mint_key.as_ref(), &[ctx.bumps.vault]],
        )
    }

    /// Opens a staging buffer for a payload of `len` bytes owned by the payer. Up to 10 KiB is
    /// allocated at once; `buffer_grow` extends it to `len`.
    pub fn buffer_open(ctx: Context<BufferOpen>, seed: u64, len: u32) -> Result<()> {
        require!(len > 0 && (len as usize) <= Buffer::MAX_LEN, PoolError::BufferLength);
        let b = &mut ctx.accounts.buffer;
        b.authority = ctx.accounts.authority.key();
        b.seed = seed;
        b.len = len;
        b.bump = ctx.bumps.buffer;
        Ok(())
    }

    /// Grows a buffer by up to 10 KiB toward its declared length, topping up rent from the authority.
    pub fn buffer_grow(ctx: Context<BufferGrow>, _seed: u64) -> Result<()> {
        let info = ctx.accounts.buffer.to_account_info();
        let target = Buffer::HEADER + ctx.accounts.buffer.len as usize;
        let current = info.data_len();
        let new_len = target.min(current + anchor_lang::solana_program::entrypoint::MAX_PERMITTED_DATA_INCREASE);
        if new_len <= current {
            return Ok(());
        }
        let need = Rent::get()?.minimum_balance(new_len);
        let have = info.lamports();
        if need > have {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    anchor_lang::system_program::Transfer { from: ctx.accounts.authority.to_account_info(), to: info.clone() },
                ),
                need - have,
            )?;
        }
        info.resize(new_len)?;
        Ok(())
    }

    /// Writes `bytes` at `offset`; any number of writes, in any order.
    pub fn buffer_write(ctx: Context<BufferWrite>, _seed: u64, offset: u32, bytes: Vec<u8>) -> Result<()> {
        let len = ctx.accounts.buffer.len as usize;
        let start = offset as usize;
        let end = start.checked_add(bytes.len()).ok_or(error!(PoolError::BufferBounds))?;
        require!(end <= len, PoolError::BufferBounds);
        let info = ctx.accounts.buffer.to_account_info();
        let mut data = info.try_borrow_mut_data()?;
        require!(Buffer::HEADER + end <= data.len(), PoolError::BufferBounds);
        data[Buffer::HEADER + start..Buffer::HEADER + end].copy_from_slice(&bytes);
        Ok(())
    }

    /// Closes a buffer and returns its rent to the authority.
    pub fn buffer_close(_ctx: Context<BufferClose>, _seed: u64) -> Result<()> {
        Ok(())
    }

    /// Deposit, withdraw or shielded transfer. Buffer: borsh (Proof, TransactArgs, TransactExt).
    pub fn transact<'info>(ctx: Context<'info, Transact<'info>>) -> Result<()> {
        ops::transact(ctx)
    }

    /// One proof funds up to 16 allowances. Buffer: borsh (Proof, GrantArgs, GrantExt).
    pub fn grant<'info>(ctx: Context<'info, Grant<'info>>) -> Result<()> {
        ops::grant(ctx)
    }

    /// Agent spend, owner reclaim or lender claim. Buffer: borsh (Proof, SpendArgs, SpendExt).
    pub fn spend<'info>(ctx: Context<'info, Spend<'info>>) -> Result<()> {
        ops::spend(ctx)
    }

    /// An agent splits its allowance into up to 4 subs. Buffer: borsh (Proof, DelegateArgs, DelegateExt).
    pub fn delegate<'info>(ctx: Context<'info, Delegate<'info>>) -> Result<()> {
        ops::delegate(ctx)
    }

    /// Delivers an escrowed lender share. Permissionless.
    pub fn pull_lender_share<'info>(ctx: Context<'info, PullLenderShare<'info>>, lender_addr: [u8; 32], loan_ref: u64) -> Result<()> {
        ops::pull_lender_share(ctx, lender_addr, loan_ref)
    }

    /// Stateless Groth16 check of `(Proof, Vec<[u8; 32]>)` staged in `buffer` against the key of
    /// `circuit`. Succeeds iff the proof verifies. Also usable through simulateTransaction.
    pub fn verify_proof(ctx: Context<VerifyBuffer>, circuit: u8) -> Result<()> {
        let (proof, inputs): (Proof, Vec<[u8; 32]>) = read_payload(&ctx.accounts.buffer)?;
        require_proof(circuit, &proof, &inputs)
    }

    /// Port of StipendPool.verifyDisclosure: known root + disclose proof over `(Proof, DiscloseArgs)`.
    pub fn verify_disclosure(ctx: Context<VerifyAgainstPool>) -> Result<()> {
        let (proof, a): (Proof, DiscloseArgs) = read_payload(&ctx.accounts.buffer)?;
        require!(merkle::is_known_root(&*ctx.accounts.pool.load()?, &a.root), PoolError::UnknownRoot);
        require_proof(CIRCUIT_DISCLOSE, &proof, &[a.root, a.kind, a.bound, a.window_id, a.agent_pk, a.audience])
    }

    /// Port of StipendPool.verifyStream: known root + stream proof over `(Proof, StreamArgs)`.
    pub fn verify_stream(ctx: Context<VerifyAgainstPool>) -> Result<()> {
        let (proof, a): (Proof, StreamArgs) = read_payload(&ctx.accounts.buffer)?;
        require!(merkle::is_known_root(&*ctx.accounts.pool.load()?, &a.root), PoolError::UnknownRoot);
        require_proof(CIRCUIT_STREAM, &proof, &a.public_inputs())
    }

    /// LOCALNET PROBE BUILD ONLY (feature `merkle-probe`, separate program id): appends raw leaves so
    /// tests can compare on-chain roots with src/merkle.ts. Absent from the production program.
    #[cfg(feature = "merkle-probe")]
    pub fn probe_insert(ctx: Context<ProbeInsert>, leaves: Vec<[u8; 32]>) -> Result<()> {
        let mut pool = ctx.accounts.pool.load_mut()?;
        for leaf in leaves.iter() {
            merkle::insert(&mut pool, leaf)?;
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = Pool::SIZE, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer of every vault and escrow; never created.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: created here as a token account (PDA ["vault", mint]); creation fails if it exists.
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: u64, len: u32)]
pub struct BufferOpen<'info> {
    #[account(
        init,
        payer = authority,
        space = Buffer::HEADER + core::cmp::min(len as usize, Buffer::MAX_INIT),
        seeds = [BUFFER_SEED, authority.key().as_ref(), &seed.to_le_bytes()],
        bump
    )]
    pub buffer: Account<'info, Buffer>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct BufferGrow<'info> {
    #[account(
        mut,
        seeds = [BUFFER_SEED, authority.key().as_ref(), &seed.to_le_bytes()],
        bump = buffer.bump,
        has_one = authority
    )]
    pub buffer: Account<'info, Buffer>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct BufferWrite<'info> {
    #[account(
        mut,
        seeds = [BUFFER_SEED, authority.key().as_ref(), &seed.to_le_bytes()],
        bump = buffer.bump,
        has_one = authority
    )]
    pub buffer: Account<'info, Buffer>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct BufferClose<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [BUFFER_SEED, authority.key().as_ref(), &seed.to_le_bytes()],
        bump = buffer.bump,
        has_one = authority
    )]
    pub buffer: Account<'info, Buffer>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

/// Accounts of `transact`. Optional accounts are passed as the program id when absent.
#[event_cpi]
#[derive(Accounts)]
pub struct Transact<'info> {
    /// Fee payer, owner of the staging buffer and, on a deposit, the authority of `depositor_token`.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, close = payer, constraint = buffer.authority == payer.key() @ PoolError::BufferAuthority)]
    pub buffer: Box<Account<'info, Buffer>>,
    /// CHECK: PDA ["nf", inputNullifiers[0]], created here.
    #[account(mut)]
    pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: PDA ["nf", inputNullifiers[1]], created here.
    #[account(mut)]
    pub nullifier1: UncheckedAccount<'info>,
    /// CHECK: PDA signer of the vaults.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// The asset; required when tokens move (extAmount != 0 or fee != 0), then bound as fieldOf(mint).
    pub mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    /// CHECK: PDA ["vault", mint], checked in the handler.
    #[account(mut)]
    pub vault: Option<UncheckedAccount<'info>>,
    /// CHECK: deposit source (owner = payer); the token program checks it.
    #[account(mut)]
    pub depositor_token: Option<UncheckedAccount<'info>>,
    /// CHECK: withdrawal destination; must equal ext.recipient.
    #[account(mut)]
    pub recipient_token: Option<UncheckedAccount<'info>>,
    /// CHECK: relayer fee destination; must equal ext.fee_recipient.
    #[account(mut)]
    pub fee_token: Option<UncheckedAccount<'info>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Grant<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, close = payer, constraint = buffer.authority == payer.key() @ PoolError::BufferAuthority)]
    pub buffer: Box<Account<'info, Buffer>>,
    /// CHECK: PDA ["nf", inputNullifiers[0]], created here.
    #[account(mut)]
    pub nullifier0: UncheckedAccount<'info>,
    /// CHECK: PDA ["nf", inputNullifiers[1]], created here.
    #[account(mut)]
    pub nullifier1: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Accounts of `spend`. Optional accounts are passed as the program id when absent.
#[event_cpi]
#[derive(Accounts)]
pub struct Spend<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, close = payer, constraint = buffer.authority == payer.key() @ PoolError::BufferAuthority)]
    pub buffer: Box<Account<'info, Buffer>>,
    /// CHECK: PDA ["nf", nullifier], created here.
    #[account(mut)]
    pub nullifier: UncheckedAccount<'info>,
    /// CHECK: PDA signer of the vaults.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// The mint named by publicAsset; required when tokens move.
    pub mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    /// CHECK: PDA ["vault", mint], checked in the handler.
    #[account(mut)]
    pub vault: Option<UncheckedAccount<'info>>,
    /// CHECK: public payout token account; its owner must be publicRecipient.
    #[account(mut)]
    pub recipient_token: Option<UncheckedAccount<'info>>,
    /// CHECK: relayer fee destination; must equal ext.fee_recipient.
    #[account(mut)]
    pub fee_token: Option<UncheckedAccount<'info>>,
    /// CHECK: lender's token account; used only if its owner maps to lenderAddr, else the share is escrowed.
    #[account(mut)]
    pub lender_token: Option<UncheckedAccount<'info>>,
    /// CHECK: escrow token account PDA ["owed", mint, lenderAddr, loanRef le]; created on first use.
    #[account(mut)]
    pub escrow: Option<UncheckedAccount<'info>>,
    /// The lender (wallet or program PDA) signing a lender claim.
    pub lender_signer: Option<Signer<'info>>,
    pub token_program: Option<Interface<'info, TokenInterface>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Delegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut, close = payer, constraint = buffer.authority == payer.key() @ PoolError::BufferAuthority)]
    pub buffer: Box<Account<'info, Buffer>>,
    /// CHECK: PDA ["nf", nullifier], created here.
    #[account(mut)]
    pub nullifier: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(lender_addr: [u8; 32], loan_ref: u64)]
pub struct PullLenderShare<'info> {
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer of the escrows.
    #[account(seeds = [VAULT_AUTH_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: escrow token account PDA; its whole balance is delivered.
    #[account(mut, seeds = [ESCROW_SEED, mint.key().as_ref(), lender_addr.as_ref(), &loan_ref.to_le_bytes()], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: destination; its owner must map to lender_addr.
    #[account(mut)]
    pub lender_token: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct VerifyBuffer<'info> {
    pub buffer: Account<'info, Buffer>,
}

#[derive(Accounts)]
pub struct VerifyAgainstPool<'info> {
    #[account(seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
    pub buffer: Account<'info, Buffer>,
}

#[cfg(feature = "merkle-probe")]
#[derive(Accounts)]
pub struct ProbeInsert<'info> {
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: AccountLoader<'info, Pool>,
}
