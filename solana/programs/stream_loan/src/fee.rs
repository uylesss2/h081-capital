//! Loan origination fee (docs/FLYWHEEL.md). A platform fee: `fund` takes ORIGINATION_FEE_BPS of the
//! principal out of the payout and sends it to the treasury's associated token account for the loan asset.
//! The loan still owes the full principal. Both values are compile-time constants: no admin key, no setter.
//!
//! This is the only fee stream_loan charges. It has nothing to do with the H081 token's trading
//! creator fees, which stay with the team's launch wallets and are never routed here.
use anchor_lang::prelude::*;

/// 0.25% of the principal.
pub const ORIGINATION_FEE_BPS: u64 = 25;
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Owner of the treasury token accounts that receive the origination fee.
///
/// TODO(flywheel): PLACEHOLDER. Set this to the Squads multisig vault address once the treasury multisig
/// exists (an owner go is needed to create it), then rebuild. Nobody holds a key for this placeholder: fees
/// sent to it would be lost, so EVERY build refuses to compile while it is the placeholder, except a localnet
/// test build that opts in with the `localnet-treasury` feature (loan-build.sh, build-all.sh) and `cargo test`.
/// The production builds (verifiable-build.sh) pass no feature, so they fail until TREASURY is set.
pub const TREASURY: Pubkey = pubkey!("TreasuryP1aceho1derSetMeBeforeMainnet111111");
pub const TREASURY_PLACEHOLDER: Pubkey = pubkey!("TreasuryP1aceho1derSetMeBeforeMainnet111111");

/// H081 launch wallets. They hold the token's trading creator fees (the team's) and must never be the
/// treasury: the build fails if TREASURY is one of them.
pub const LAUNCH_WALLETS: [Pubkey; 3] = [
    pubkey!("2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP"),
    pubkey!("FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ"),
    pubkey!("5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw"),
];

pub(crate) const fn same(a: &Pubkey, b: &Pubkey) -> bool {
    let (a, b) = (a.as_array(), b.as_array());
    let mut i = 0;
    while i < 32 {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

const fn is_launch_wallet(k: &Pubkey) -> bool {
    let mut i = 0;
    while i < LAUNCH_WALLETS.len() {
        if same(k, &LAUNCH_WALLETS[i]) {
            return true;
        }
        i += 1;
    }
    false
}

const _: () = assert!(!is_launch_wallet(&TREASURY), "TREASURY must not be an H081 launch (creator-fee) wallet");
#[cfg(not(any(test, feature = "localnet-treasury")))]
const _: () = assert!(
    !same(&TREASURY, &TREASURY_PLACEHOLDER),
    "fee::TREASURY is still the placeholder: set it to the treasury multisig vault (or build for localnet with --features localnet-treasury)"
);

/// principal * ORIGINATION_FEE_BPS / 10_000, rounded down (loans under 400 base units pay no fee).
pub fn origination_fee(principal: u64) -> Option<u64> {
    let fee = (principal as u128).checked_mul(ORIGINATION_FEE_BPS as u128)? / BPS_DENOMINATOR as u128;
    u64::try_from(fee).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_math() {
        assert_eq!(origination_fee(0), Some(0));
        assert_eq!(origination_fee(399), Some(0));
        assert_eq!(origination_fee(400), Some(1));
        assert_eq!(origination_fee(10_000), Some(25));
        assert_eq!(origination_fee(300_000_000), Some(750_000));
        assert_eq!(origination_fee(u64::MAX), Some(u64::MAX / 400));
        for p in [1u64, 7, 401, 123_456_789, u64::MAX] {
            assert!(origination_fee(p).unwrap() <= p);
        }
    }

    #[test]
    fn treasury_is_not_a_launch_wallet() {
        assert!(!is_launch_wallet(&TREASURY));
        assert!(LAUNCH_WALLETS.iter().all(|w| is_launch_wallet(w)));
    }
}
