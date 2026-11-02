// H081 Capital: a private bank for AI agents on Solana (https://h081.xyz).
// Every address is derived at runtime from the program ids and mints; nothing is read from an API.
const { PublicKey } = require("@solana/web3.js");
const { sumTokensExport } = require("../helper/solana");

// Programs (live on Solana mainnet, not audited yet)
const STIPEND_POOL = "E16DKmtrYtYGp7guSso25Pvq8gzKunnUULU28RmRmDGM"; // the bank: shielded deposits
const CAPACITY_STAKE = "CH1rrfFyJMVn158UHL2fLpKTtoLJojrz5f68toMQdQKU"; // H081 staking for relay capacity
const SAFETY_POOL = "HmzKNPn8LaRyjmggt2uT95B7KvphtoVXQkeVc2HHARTt"; // H081 safety pool (loan cover)
const H081 = "EgqxxR7zowzaLEm24oep5qqBieLVAWYX78LhgeqAJAo"; // protocol token

const pda = (seeds, programId) =>
  PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0].toBase58();

// stipend_pool: PDA ["vault_auth"] owns every per-mint vault (["vault", mint], e.g. the USDG vault
// FaRG7DV8e7XF3RyoZrBb3h1oLiFFWFFCuYDSXsDoyyzG) and every "owed" escrow, so summing the token accounts
// of this owner counts all deposits, in any asset the bank accepts now or later.
const vaultAuthority = pda([Buffer.from("vault_auth")], STIPEND_POOL);

// capacity_stake / safety_pool: PDA ["vault", mint] holds the staked / deposited H081.
const capacityVault = pda([Buffer.from("vault"), new PublicKey(H081).toBuffer()], CAPACITY_STAKE);
const safetyVault = pda([Buffer.from("vault"), new PublicKey(H081).toBuffer()], SAFETY_POOL);

module.exports = {
  timetravel: true,
  start: "2026-10-31",
  methodology:
    "TVL is the balance of every token account owned by the stipend_pool vault authority PDA (the bank's deposit vaults, USDG today). " +
    "Staking is the H081 held by the capacity_stake and safety_pool vault PDAs (the protocol's own token, reported separately). " +
    "Loans are allowances pledged inside the bank, so they are already part of the vault balance and are not counted again.",
  solana: {
    tvl: sumTokensExport({ owners: [vaultAuthority] }),
    staking: sumTokensExport({ tokenAccounts: [capacityVault, safetyVault] }),
  },
};
