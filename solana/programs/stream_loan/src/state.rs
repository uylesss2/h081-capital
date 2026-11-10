use anchor_lang::prelude::*;

pub const REGISTRY_SEED: &[u8] = b"registry";
pub const SLOT_SEED: &[u8] = b"slot";
pub const LEDGER_SEED: &[u8] = b"ledger";
pub const CLOSED_SEED: &[u8] = b"closed";
pub const SUBROGATION_SEED: &[u8] = b"subrogation";

/// Time after the allowance's expiry before an unpaid loan counts as a shortfall.
pub const GRACE: u64 = 7 * 24 * 60 * 60;

/// Sequential loan refs. PDA ["registry"]. No admin field.
#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub next_loan_ref: u64,
    pub bump: u8,
}

/// One slot (= one loan). PDA ["slot", loan_ref u64 LE]. The slot PDA is the `lenderAddr` borrowers
/// pledge to: lenderAddr = fieldOf(slot PDA). Its inbox is the slot PDA's associated token account.
#[account]
#[derive(InitSpace)]
pub struct Slot {
    pub loan_ref: u64,
    /// who receives everything routed to this loan ref
    pub lender: Pubkey,
    pub bump: u8,
    pub funded: bool,
    pub settled: bool,
    /// the loan asset (SPL mint) and its token program
    pub asset: Pubkey,
    pub token_program: Pubkey,
    pub principal: u64,
    pub repaid: u64,
    pub min_remaining: u128,
    pub min_rate: u128,
    pub pledge_bps: u16,
    pub expiry: u64,
    /// 32-byte big-endian field element
    pub agent_pk: [u8; 32],
    pub funded_at: i64,
    /// the token account the principal was paid to
    pub payout_to: Pubkey,
    pub stream_start: u64,
}

/// Per (slot, mint) inbox accounting. PDA ["ledger", loan_ref u64 LE, mint].
/// `held` is the part of the inbox balance that could not be forwarded (waits for `collect`);
/// everything above `held` in the inbox is new, unsynced routed shares.
#[account]
#[derive(InitSpace)]
pub struct Ledger {
    pub loan_ref: u64,
    pub mint: Pubkey,
    pub held: u64,
    /// total ever credited from the inbox as repayment (forwarded + held + subrogated); since the overpay cap,
    /// borrower excess is not counted
    pub received: u64,
    pub bump: u8,
}

/// Receipt of a funded loan whose slot the lender closed (`close_slot`). PDA ["closed", loan_ref u64 LE].
/// A new account type: Slot, Ledger and Registry are unchanged. `lender` sits at offset 16 as in Slot, so one
/// getProgramAccounts memcmp finds a lender's open slots and closed receipts. It keeps the loan's final figures
/// for readers, and it is how the lender still reaches shares routed to the loan after the close: a pledge keeps
/// routing its share to (fieldOf(slot PDA), loan_ref) after settle, and only the slot PDA can move what lands in
/// its inbox (`sweep_closed`). Never closed. Unfunded slots get no receipt (nothing routed to them is the lender's).
#[account]
#[derive(InitSpace)]
pub struct ClosedSlot {
    pub loan_ref: u64,
    pub lender: Pubkey,
    pub asset: Pubkey,
    pub principal: u64,
    pub repaid: u64,
    /// bump of the (closed) slot PDA, which still signs for its inbox
    pub slot_bump: u8,
    pub bump: u8,
}

/// Offset of the borrower's payout account in a ClosedSlot receipt made after the overpay cap (v2): the 98-byte
/// struct above is unchanged and `payout_to` follows it in 32 trailing bytes (Anchor reads only the struct, so
/// both sizes decode as ClosedSlot). Older receipts are 98 bytes and record no payout.
pub const CLOSED_PAYOUT_OFFSET: usize = 8 + ClosedSlot::INIT_SPACE;
/// Size of a v2 receipt: the struct plus `payout_to`.
pub const CLOSED_V2_SIZE: usize = CLOSED_PAYOUT_OFFSET + 32;

/// The payout account recorded in a v2 receipt's trailing bytes; None for an older (98-byte) receipt.
pub fn closed_payout(data: &[u8]) -> Option<Pubkey> {
    let b = data.get(CLOSED_PAYOUT_OFFSET..CLOSED_V2_SIZE)?;
    Some(Pubkey::new_from_array(b.try_into().ok()?))
}

/// How one synced receipt splits under the overpay cap: only `credit` (what still fits under the principal, in the
/// loan asset; 0 in any other mint) repays the loan; the safety pool's subrogation comes out of `credit`, the
/// lender gets the rest of it, and `excess` stays in the inbox for the borrower.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Split {
    pub credit: u64,
    pub to_pool: u64,
    pub to_lender: u64,
    pub excess: u64,
}

/// What the lender (plus the safety pool) may still be credited: principal - repaid in the loan asset, 0 otherwise.
pub fn closed_room(principal: u64, repaid: u64, is_asset: bool) -> u64 {
    if is_asset {
        principal.saturating_sub(repaid)
    } else {
        0
    }
}

/// Splits `delta` newly arrived in the inbox. `sub_left` is what a recorded slash has not yet recovered.
pub fn split_receipt(principal: u64, repaid: u64, delta: u64, is_asset: bool, sub_left: u64) -> Split {
    let credit = delta.min(closed_room(principal, repaid, is_asset));
    let to_pool = credit.min(sub_left);
    Split { credit, to_pool, to_lender: credit - to_pool, excess: delta - credit }
}

/// One-time release of held overage on a loan over-repaid before the cap: the part of `held` above the principal
/// (at most repaid - principal) stops being the lender's. Afterwards repaid >= principal still holds and either
/// held == 0 or repaid == principal, so a second call returns 0.
pub fn legacy_release(principal: u64, repaid: u64, held: u64) -> u64 {
    if repaid > principal {
        held.min(repaid - principal)
    } else {
        0
    }
}

/// What `collect` may pay the lender out of `held`: all of it, except (loan asset only) the overage of a loan
/// over-repaid before the cap, which is the borrower's and stays held until the next sync releases it. Without this,
/// a lender collecting before that sync would take the overage.
pub fn collectable(principal: u64, repaid: u64, held: u64, is_asset: bool) -> u64 {
    if is_asset {
        held - legacy_release(principal, repaid, held)
    } else {
        held
    }
}

/// How `sweep_closed` splits a closed slot's inbox balance `inbox`: first what was held for the lender before the
/// close (`held`, from that mint's Ledger when passed; close_slot closes only the loan asset's Ledger, so another
/// mint's held share outlives the close), then up to `room` (closed_room) of the rest. Returns (held part, room part).
pub fn sweep_split(inbox: u64, held: u64, room: u64) -> (u64, u64) {
    let from_held = held.min(inbox);
    (from_held, (inbox - from_held).min(room))
}

/// close_slot's subrogation guard: a recorded slash blocks the close while the pool has not recovered what it paid
/// and the loan can still credit it (repaid < principal). Once repaid, nothing more can reach the pool, so it never
/// locks the close.
pub fn subrogation_blocks_close(paid: u64, owed: u64, principal: u64, repaid: u64) -> bool {
    paid < owed && repaid < principal
}

/// A safety-pool slash of this loan (recorded by `record_slash`, signed by the safety_pool config PDA).
/// PDA ["subrogation", loan_ref u64 LE]; one per loan, created at the slash. After it exists, every receipt
/// for the loan (synced inbox value in the loan asset) is forwarded to `to`, the safety pool's associated
/// token account for the loan asset, until `paid` reaches `owed`; only the remainder reaches the lender.
#[account]
#[derive(InitSpace)]
pub struct Subrogation {
    pub loan_ref: u64,
    /// the safety_pool config PDA that recorded the slash
    pub safety_config: Pubkey,
    /// where the subrogated receipts go (the safety pool's ATA for the loan asset)
    pub to: Pubkey,
    /// what the safety pool paid the lender for this loan
    pub owed: u64,
    /// what has been forwarded to `to` so far
    pub paid: u64,
    pub bump: u8,
}

/// Unpaid principal once expiry + GRACE has passed; 0 otherwise (and always 0 when expiry == 0).
/// `pending` is value already routed to the loan but not yet credited: unsynced inbox balance plus the
/// stipend_pool escrow for (fieldOf(slot), loan_ref) in the loan asset.
pub fn shortfall_of(slot: &Slot, now: i64, pending: u64) -> u64 {
    if !slot.funded || slot.settled || slot.expiry == 0 {
        return 0;
    }
    if now < 0 || (now as u64) <= slot.expiry.saturating_add(GRACE) {
        return 0;
    }
    let paid = slot.repaid.saturating_add(pending);
    slot.principal.saturating_sub(paid)
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: u64 = 20;

    #[test]
    fn split_below_at_and_across_the_principal() {
        // below the room: everything is credited and goes to the lender
        assert_eq!(split_receipt(P, 0, 5, true, 0), Split { credit: 5, to_pool: 0, to_lender: 5, excess: 0 });
        // exactly the room
        assert_eq!(split_receipt(P, 15, 5, true, 0), Split { credit: 5, to_pool: 0, to_lender: 5, excess: 0 });
        // crossing it: repaid 15 + 10 arrives -> the lender gets 5, 5 stays for the borrower
        assert_eq!(split_receipt(P, 15, 10, true, 0), Split { credit: 5, to_pool: 0, to_lender: 5, excess: 5 });
        // the bug repro: budget 100 at 40% for a 20 loan; the whole 40 arrives at once
        assert_eq!(split_receipt(P, 0, 40, true, 0), Split { credit: 20, to_pool: 0, to_lender: 20, excess: 20 });
    }

    #[test]
    fn nothing_is_credited_once_repaid_or_in_another_mint() {
        assert_eq!(split_receipt(P, P, 7, true, 0), Split { credit: 0, to_pool: 0, to_lender: 0, excess: 7 });
        // a legacy loan over-repaid before the cap
        assert_eq!(split_receipt(P, 35, 7, true, 3), Split { credit: 0, to_pool: 0, to_lender: 0, excess: 7 });
        // another mint never repays the loan, even with an open subrogation
        assert_eq!(split_receipt(P, 0, 7, false, 3), Split { credit: 0, to_pool: 0, to_lender: 0, excess: 7 });
        assert_eq!(split_receipt(P, 0, 0, true, 3), Split { credit: 0, to_pool: 0, to_lender: 0, excess: 0 });
    }

    #[test]
    fn subrogation_comes_out_of_the_credit() {
        // pool owed 8: it takes 8 of the 12 that fit, the lender 4, the borrower the 18 above the principal
        let s = split_receipt(P, 8, 30, true, 8);
        assert_eq!(s, Split { credit: 12, to_pool: 8, to_lender: 4, excess: 18 });
        // the pool's claim larger than the room: it gets only the room, the lender nothing
        let s = split_receipt(P, 15, 30, true, 100);
        assert_eq!(s, Split { credit: 5, to_pool: 5, to_lender: 0, excess: 25 });
        for (repaid, delta, sub) in [(0u64, 1u64, 0u64), (3, 50, 2), (19, 1, 1), (0, 20, 20), (10, 9, 30)] {
            let s = split_receipt(P, repaid, delta, true, sub);
            assert!(s.to_pool <= s.credit && s.to_pool + s.to_lender == s.credit && s.credit + s.excess == delta);
        }
    }

    #[test]
    fn u64_extremes_never_overflow() {
        let m = u64::MAX;
        assert_eq!(split_receipt(m, 0, m, true, m), Split { credit: m, to_pool: m, to_lender: 0, excess: 0 });
        assert_eq!(split_receipt(m, m, m, true, m), Split { credit: 0, to_pool: 0, to_lender: 0, excess: m });
        assert_eq!(split_receipt(0, m, m, true, 0), Split { credit: 0, to_pool: 0, to_lender: 0, excess: m });
        assert_eq!(split_receipt(m, 1, m, true, 0).excess, 1);
        assert_eq!(legacy_release(0, m, m), m);
        assert_eq!(legacy_release(m, m, m), 0);
        assert_eq!(closed_room(m, 0, true), m);
    }

    /// Random receipt sequences: the pool plus the lender never get more than principal - repaid at the start, and
    /// repaid never passes max(principal, repaid at the start).
    #[test]
    fn property_lender_plus_pool_never_exceed_the_room() {
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = |m: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % m
        };
        for _ in 0..2_000 {
            let principal = next(1_000) + 1;
            let repaid0 = next(principal * 2);
            let mut repaid = repaid0;
            let mut sub_left = next(principal + 1);
            let (mut to_pool, mut to_lender, mut excess, mut arrived) = (0u64, 0u64, 0u64, 0u64);
            for _ in 0..(next(12) + 1) {
                let delta = next(principal);
                let is_asset = next(5) != 0;
                let s = split_receipt(principal, repaid, delta, is_asset, if is_asset { sub_left } else { 0 });
                repaid += s.credit;
                sub_left -= s.to_pool;
                to_pool += s.to_pool;
                to_lender += s.to_lender;
                excess += s.excess;
                arrived += delta;
                assert!(repaid <= principal.max(repaid0));
            }
            assert!(to_pool + to_lender <= principal.saturating_sub(repaid0));
            assert_eq!(to_pool + to_lender + excess, arrived);
        }
    }

    #[test]
    fn legacy_release_runs_once_and_never_drops_below_the_principal() {
        // over-repaid by 15 with 10 still held: all 10 are released, repaid 35 -> 25
        let (principal, mut repaid, mut held) = (20u64, 35u64, 10u64);
        let x = legacy_release(principal, repaid, held);
        assert_eq!(x, 10);
        held -= x;
        repaid -= x;
        assert_eq!((repaid, held), (25, 0));
        assert_eq!(legacy_release(principal, repaid, held), 0);
        // over-repaid by 4 with 10 held: 4 released, repaid back at the principal, 6 still the lender's
        let (mut repaid, mut held) = (24u64, 10u64);
        let x = legacy_release(principal, repaid, held);
        assert_eq!(x, 4);
        held -= x;
        repaid -= x;
        assert_eq!((repaid, held), (20, 6));
        assert_eq!(legacy_release(principal, repaid, held), 0);
        // not over-repaid: nothing
        assert_eq!(legacy_release(20, 20, 9), 0);
        assert_eq!(legacy_release(20, 3, 9), 0);
    }

    #[test]
    fn closed_room_is_the_unpaid_principal_in_the_loan_asset_only() {
        assert_eq!(closed_room(20, 5, true), 15);
        assert_eq!(closed_room(20, 20, true), 0);
        assert_eq!(closed_room(20, 30, true), 0);
        assert_eq!(closed_room(20, 5, false), 0);
    }

    #[test]
    fn collect_never_pays_legacy_overage() {
        // over-repaid by 10 with 30 held: the lender collects 20, 10 stay for the next sync to release
        assert_eq!(collectable(20, 30, 30, true), 20);
        // over-repaid by 15 with 10 held: everything held is overage
        assert_eq!(collectable(20, 35, 10, true), 0);
        // not over-repaid, or another mint: all of held
        assert_eq!(collectable(20, 20, 7, true), 7);
        assert_eq!(collectable(20, 5, 7, true), 7);
        assert_eq!(collectable(20, 35, 7, false), 7);
        // collect-then-sync splits held exactly like sync-then-collect
        let (p, r, h) = (20u64, 30u64, 30u64);
        let paid = collectable(p, r, h, true);
        let x = legacy_release(p, r, h - paid);
        let x2 = legacy_release(p, r, h);
        assert_eq!((paid, x), (h - x2, x2));
        assert_eq!(collectable(u64::MAX, u64::MAX, u64::MAX, true), u64::MAX);
        assert_eq!(collectable(0, u64::MAX, u64::MAX, true), 0);
    }

    #[test]
    fn sweep_pays_held_first_then_the_room() {
        assert_eq!(sweep_split(10, 0, 4), (0, 4));
        assert_eq!(sweep_split(10, 3, 0), (3, 0));
        assert_eq!(sweep_split(10, 3, 4), (3, 4));
        assert_eq!(sweep_split(10, 3, 100), (3, 7));
        // a permanent delegate drained the inbox below held: only what is there
        assert_eq!(sweep_split(2, 3, 100), (2, 0));
        assert_eq!(sweep_split(0, 3, 5), (0, 0));
        assert_eq!(sweep_split(u64::MAX, u64::MAX, u64::MAX), (u64::MAX, 0));
    }

    #[test]
    fn a_repaid_loan_never_waits_on_the_pool() {
        assert!(subrogation_blocks_close(0, 10, 20, 5));
        assert!(!subrogation_blocks_close(10, 10, 20, 5));
        assert!(!subrogation_blocks_close(12, 10, 20, 5));
        // repaid (or over-repaid before the cap) with the pool short: the close goes through
        assert!(!subrogation_blocks_close(3, 10, 20, 20));
        assert!(!subrogation_blocks_close(0, 10, 20, 35));
    }

    fn receipt() -> ClosedSlot {
        ClosedSlot {
            loan_ref: 7,
            lender: Pubkey::new_from_array([1; 32]),
            asset: Pubkey::new_from_array([2; 32]),
            principal: 20,
            repaid: 12,
            slot_bump: 254,
            bump: 253,
        }
    }

    #[test]
    fn old_and_v2_receipts_both_decode() {
        assert_eq!(CLOSED_PAYOUT_OFFSET, 98);
        assert_eq!(CLOSED_V2_SIZE, 130);
        let payout = Pubkey::new_from_array([9; 32]);
        let mut old = vec![0u8; CLOSED_PAYOUT_OFFSET];
        receipt().try_serialize(&mut &mut old[..]).unwrap();
        let mut v2 = vec![0u8; CLOSED_V2_SIZE];
        receipt().try_serialize(&mut &mut v2[..]).unwrap();
        v2[CLOSED_PAYOUT_OFFSET..].copy_from_slice(payout.as_ref());
        for buf in [&old, &v2] {
            let c = ClosedSlot::try_deserialize(&mut &buf[..]).unwrap();
            assert_eq!(
                (c.loan_ref, c.lender, c.asset, c.principal, c.repaid, c.slot_bump, c.bump),
                (7, receipt().lender, receipt().asset, 20, 12, 254, 253)
            );
        }
        assert_eq!(closed_payout(&old), None);
        assert_eq!(closed_payout(&v2), Some(payout));
        // sweep_closed rewrites only the 98-byte struct: the trailing payout stays
        let mut c = ClosedSlot::try_deserialize(&mut &v2[..]).unwrap();
        c.repaid = 20;
        c.try_serialize(&mut &mut v2[..]).unwrap();
        assert_eq!(v2.len(), CLOSED_V2_SIZE);
        assert_eq!(closed_payout(&v2), Some(payout));
        assert_eq!(ClosedSlot::try_deserialize(&mut &v2[..]).unwrap().repaid, 20);
    }

    #[test]
    fn account_sizes_are_unchanged() {
        assert_eq!(8 + Slot::INIT_SPACE, 253);
        assert_eq!(8 + ClosedSlot::INIT_SPACE, 98);
        assert_eq!(8 + Ledger::INIT_SPACE, 65);
        assert_eq!(8 + Subrogation::INIT_SPACE, 8 + 8 + 32 + 32 + 8 + 8 + 1);
        assert_eq!(8 + Registry::INIT_SPACE, 17);
    }
}
