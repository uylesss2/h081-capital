use super::*;
use crate::view::{off, parse_slot, slot_discriminator, SLOT_SIZE};

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let s = format!("{s:0>64}");
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn sample_slot() -> stream_loan::state::Slot {
    stream_loan::state::Slot {
        loan_ref: 0x0102_0304_0506_0708,
        lender: Pubkey::new_from_array([7; 32]),
        bump: 254,
        funded: true,
        settled: false,
        asset: Pubkey::new_from_array([9; 32]),
        token_program: Pubkey::new_from_array([3; 32]),
        principal: 5_000_000,
        repaid: 5_000_001,
        min_remaining: 1,
        min_rate: 2,
        pledge_bps: 3,
        expiry: 4,
        agent_pk: hex32("27cb78d0541f3912c8645bd60acbe7a7205225e0e6f55a17f4843ac719e3eafe"),
        funded_at: 20400 * 86_400 + 5,
        payout_to: Pubkey::new_from_array([5; 32]),
        stream_start: 6,
    }
}

fn serialized(s: &stream_loan::state::Slot) -> Vec<u8> {
    let mut buf = vec![0u8; SLOT_SIZE];
    s.try_serialize(&mut &mut buf[..]).unwrap();
    buf
}

/// Fails when stream_loan's Slot layout moves any field rep_registry reads (see view.rs RELEASE CHECKLIST).
#[test]
fn slot_offsets_match_stream_loan() {
    assert_eq!(8 + stream_loan::state::Slot::INIT_SPACE, SLOT_SIZE);
    let s = sample_slot();
    let d = serialized(&s);
    assert_eq!(d[..8], slot_discriminator());
    let f = parse_slot(&d).expect("parses");
    assert_eq!(f.loan_ref, s.loan_ref);
    assert_eq!(f.lender, s.lender);
    assert_eq!(f.funded, s.funded);
    assert_eq!(f.asset, s.asset);
    assert_eq!(f.principal, s.principal);
    assert_eq!(f.repaid, s.repaid);
    assert_eq!(f.agent_pk, s.agent_pk);
    assert_eq!(f.funded_at, s.funded_at);
    // byte-level: each offset holds exactly its field
    assert_eq!(&d[off::LOAN_REF..off::LOAN_REF + 8], &s.loan_ref.to_le_bytes());
    assert_eq!(&d[off::LENDER..off::LENDER + 32], s.lender.as_ref());
    assert_eq!(d[off::FUNDED], 1);
    assert_eq!(&d[off::ASSET..off::ASSET + 32], s.asset.as_ref());
    assert_eq!(&d[off::PRINCIPAL..off::PRINCIPAL + 8], &s.principal.to_le_bytes());
    assert_eq!(&d[off::REPAID..off::REPAID + 8], &s.repaid.to_le_bytes());
    assert_eq!(&d[off::AGENT_PK..off::AGENT_PK + 32], &s.agent_pk);
    assert_eq!(&d[off::FUNDED_AT..off::FUNDED_AT + 8], &s.funded_at.to_le_bytes());
    // a wrong size, discriminator or funded byte is refused
    assert!(parse_slot(&d[..SLOT_SIZE - 1]).is_none());
    let mut bad = d.clone();
    bad[0] ^= 1;
    assert!(parse_slot(&bad).is_none());
    let mut bad = d.clone();
    bad[off::FUNDED] = 2;
    assert!(parse_slot(&bad).is_none());
}

/// The program ids rep_registry trusts are stream_loan's own (localnet build here).
#[test]
fn trusts_stream_loans_id_and_seeds() {
    assert_eq!(view::STREAM_LOAN_ID, stream_loan::ID);
    assert_eq!(view::SUBROGATION_SEED, stream_loan::state::SUBROGATION_SEED);
    assert_eq!(view::SLOT_SEED, stream_loan::state::SLOT_SEED);
    assert_eq!(view::subrogation_address(9), stream_loan::subrogation_address(9));
}

/// The Rust leaf equals the TS repLeaf (src/crypto.ts) for the same fields (fixture computed with the SDK).
#[test]
fn leaf_matches_the_sdk() {
    let agent_pk = hex32("27cb78d0541f3912c8645bd60acbe7a7205225e0e6f55a17f4843ac719e3eafe");
    let lender_f = view::field_of(&Pubkey::new_from_array([7; 32]));
    let asset_f = view::field_of(&Pubkey::new_from_array([9; 32]));
    assert_eq!(lender_f, hex32("4bb06f8e4e3a7715d201d573d0aa423762e55dab"));
    assert_eq!(asset_f, hex32("8c0cc17a04942cc4f8e0fe0b302606d3108860c1"));
    let leaf = merkle::rep_leaf(&agent_pk, 42, 5_000_000, &asset_f, &lender_f, 20400).unwrap();
    assert_eq!(leaf, hex32("154807c36666f8080086fd627f4d1ca634ba1400f0e706be2b2ce12ab0d9e74d"));
}

#[test]
fn zeros_and_groth16_are_stipend_pools() {
    assert_eq!(include_str!("generated/zeros.rs"), include_str!("../../stipend_pool/src/generated/zeros.rs"));
    assert_eq!(include_str!("groth16.rs"), include_str!("../../stipend_pool/src/groth16.rs"));
}

#[test]
fn account_sizes_are_unchanged() {
    assert_eq!(8 + std::mem::size_of::<RepTree>(), 8 + 8 + 2 + 1 + 5 + 640 + 8192);
    assert_eq!(8 + std::mem::size_of::<RepTree>(), 8856);
    assert_eq!(8 + RepBits::INIT_SPACE, 8 + 4 + 1 + 1024);
}

#[test]
fn tree_insert_matches_a_naive_rebuild() {
    let mut t: RepTree = bytemuck_zeroed();
    merkle::init_tree(&mut t);
    let empty = merkle::last_root(&t);
    assert!(!merkle::is_known_root(&t, &[0; 32]));
    assert!(merkle::is_known_root(&t, &empty));
    let leaves: Vec<[u8; 32]> = (1..=5u64).map(merkle::u64_fe).collect();
    for l in &leaves {
        merkle::insert(&mut t, l).unwrap();
        merkle::commit_root(&mut t);
    }
    // naive: full level arrays with zeros
    let mut level: Vec<[u8; 32]> = leaves.clone();
    for i in 0..LEVELS {
        let z = generated::zeros::ZEROS[i];
        let mut next = vec![];
        for p in level.chunks(2) {
            next.push(merkle::hash_left_right(&p[0], p.get(1).unwrap_or(&z)).unwrap());
        }
        level = next;
    }
    assert_eq!(merkle::last_root(&t), level[0]);
    assert!(merkle::is_known_root(&t, &empty));
    assert_eq!(t.next_index, 5);
}

fn bytemuck_zeroed() -> RepTree {
    // RepTree is plain old data (zero_copy, repr(C)); all zeros is a valid value
    unsafe { std::mem::zeroed() }
}

fn inputs(min_volume: u64, expiry: i64) -> [[u8; 32]; NPUBLIC] {
    let mut x = [[0u8; 32]; NPUBLIC];
    x[input::REP_ROOT] = merkle::u64_fe(1);
    x[input::MIN_LOANS] = merkle::u64_fe(3);
    x[input::MIN_VOLUME] = merkle::u64_fe(min_volume);
    x[input::MIN_SPAN_DAYS] = merkle::u64_fe(30);
    x[input::EXPIRY] = merkle::u64_fe(expiry as u64);
    x
}

#[test]
fn public_inputs_are_range_checked() {
    let now = 1_800_000_000;
    let ev = check_public(&inputs(500, now + 600), now).unwrap();
    assert_eq!((ev.min_loans, ev.min_volume, ev.min_span_days, ev.expiry), (3, 500, 30, now + 600));
    // expired, too far, exactly at the bounds
    assert!(check_public(&inputs(1, now - 1), now).is_err());
    assert!(check_public(&inputs(1, now), now).is_ok());
    assert!(check_public(&inputs(1, now + MAX_TTL), now).is_ok());
    assert!(check_public(&inputs(1, now + MAX_TTL + 1), now).is_err());
    // a threshold or expiry beyond its width (a field element near r, 2^64, 2^200)
    let mut x = inputs(1, now + 1);
    x[input::MIN_VOLUME] = hex32("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000000");
    assert!(check_public(&x, now).is_err());
    let mut x = inputs(1, now + 1);
    x[input::MIN_LOANS] = merkle::u64_fe(256);
    assert!(check_public(&x, now).is_err());
    let mut x = inputs(1, now + 1);
    x[input::MIN_SPAN_DAYS] = merkle::u64_fe(1 << 16);
    assert!(check_public(&x, now).is_err());
    let mut x = inputs(1, now + 1);
    x[input::EXPIRY][0] = 1;
    assert!(check_public(&x, now).is_err());
    // not a field element at all
    let mut x = inputs(1, now + 1);
    x[input::NONCE] = [0xff; 32];
    assert!(check_public(&x, now).is_err());
}

#[test]
fn bitmap_pages() {
    assert_eq!(page_of(0), 0);
    assert_eq!(page_of(8191), 0);
    assert_eq!(page_of(8192), 1);
    assert_eq!(page_of(u64::MAX), (u64::MAX / 8192) as u32);
}

#[test]
fn small_reads_big_endian_widths() {
    assert_eq!(small(&merkle::u64_fe(255), 8), Some(255));
    assert_eq!(small(&merkle::u64_fe(256), 8), None);
    assert_eq!(small(&merkle::u64_fe(u64::MAX), 64), Some(u64::MAX));
    let mut x = merkle::u64_fe(1);
    x[23] = 1;
    assert_eq!(small(&x, 64), None);
}
