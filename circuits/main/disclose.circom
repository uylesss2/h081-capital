pragma circom 2.1.0;

include "lib/hashes.circom";
include "lib/merkle.circom";
include "lib/range.circom";
include "circomlib/circuits/comparators.circom";

// Selective proof of spend over one allowance note as of one Merkle root.
// The note's own counters make the statement complete: every spend must
// have rewritten the note, so "remaining" and "windowSpent" are exact.
//   kind 0: remaining      >= bound          (solvency)
//   kind 1: spent          <= bound          (lifetimeCap - remaining)
//   kind 2: windowSpent    <= bound          in window windowIdPub
// `audience` is chosen by the verifier so the proof cannot be replayed.
// agentPk is public so the verifier knows which agent the statement covers;
// the asset, the policy and every amount stay private.
template Disclose(levels) {
    signal input root;
    signal input kind;
    signal input bound;
    signal input windowIdPub;
    signal input agentPk;
    signal input audience;

    signal input asset;
    signal input remaining;
    signal input windowId;
    signal input windowSpent;
    signal input rho;
    signal input lifetimeCap;
    signal input windowCap;
    signal input windowLen;
    signal input maxPerTx;
    signal input expiry;
    signal input recipientRoot;
    signal input ownerPk;
    signal input pathIndices[levels];
    signal input pathElements[levels];

    signal kindA <== kind * (kind - 1);
    kindA * (kind - 2) === 0;

    component policy = PolicyHash();
    policy.lifetimeCap <== lifetimeCap;
    policy.windowCap <== windowCap;
    policy.windowLen <== windowLen;
    policy.maxPerTx <== maxPerTx;
    policy.expiry <== expiry;
    policy.recipientRoot <== recipientRoot;
    policy.ownerPk <== ownerPk;

    component note = AllowanceCommitment();
    note.asset <== asset;
    note.remaining <== remaining;
    note.agentPk <== agentPk;
    note.policyHash <== policy.out;
    note.windowId <== windowId;
    note.windowSpent <== windowSpent;
    note.rho <== rho;

    component tree = MerkleCheck(levels);
    tree.enabled <== 1;
    tree.root <== root;
    tree.leaf <== note.out;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    component rRemaining = Range(AMOUNT_BITS());
    rRemaining.in <== remaining;
    component rCap = Range(AMOUNT_BITS());
    rCap.in <== lifetimeCap;
    component rSpent = Range(AMOUNT_BITS());
    rSpent.in <== windowSpent;
    component rBound = Range(AMOUNT_BITS());
    rBound.in <== bound;

    // remaining can never exceed the lifetime cap, so spent is non-negative.
    component capOk = Leq(AMOUNT_BITS());
    capOk.a <== remaining;
    capOk.b <== lifetimeCap;
    capOk.out === 1;
    signal spent <== lifetimeCap - remaining;

    component is0 = IsEqual();
    is0.in[0] <== kind;
    is0.in[1] <== 0;
    component is1 = IsEqual();
    is1.in[0] <== kind;
    is1.in[1] <== 1;
    component is2 = IsEqual();
    is2.in[0] <== kind;
    is2.in[1] <== 2;

    // kind 0: bound <= remaining
    component c0 = LeqWhen(AMOUNT_BITS());
    c0.a <== bound;
    c0.b <== remaining;
    c0.when <== is0.out;
    // kind 1: spent <= bound
    component c1 = LeqWhen(AMOUNT_BITS());
    c1.a <== spent;
    c1.b <== bound;
    c1.when <== is1.out;
    // kind 2: windowSpent <= bound, and the note's window is the stated one
    component c2 = LeqWhen(AMOUNT_BITS());
    c2.a <== windowSpent;
    c2.b <== bound;
    c2.when <== is2.out;
    (windowId - windowIdPub) * is2.out === 0;

    signal audienceSquare <== audience * audience;
}

component main { public [root, kind, bound, windowIdPub, agentPk, audience] } = Disclose(20);
