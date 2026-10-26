pragma circom 2.1.0;

include "lib/hashes.circom";
include "lib/merkle.circom";
include "lib/range.circom";

// Proof of a pledged stream for a lender (`proveStream`). Over one allowance
// note as of one Merkle root it reveals exactly: a lower bound on the
// remaining balance, a lower bound on the streaming rate, the lender the
// note is pledged to, the pledge fraction, the expiry, the lifetime cap,
// what has already been routed to the lender, when the stream starts and
// the asset. It hides the balance, the window state, counterparties and
// the policy's other rules. A lender prices a loan from these fields alone:
// the start date says when the cashflow begins, the asset what it is paid
// in. `audience` is chosen by the verifier so the proof cannot be replayed.
template Stream(levels) {
    // public, in this order
    signal input root;
    signal input minRemaining;
    signal input minRate;
    signal input lenderAddr;
    signal input loanRef;
    signal input pledgeBpsPub;
    signal input expiryPub;
    signal input lifetimeCapPub;
    signal input pledgePaidPub;
    signal input agentPk;
    signal input audience;
    signal input streamStartPub;
    signal input assetPub;

    // the note
    signal input asset;
    signal input remaining;
    signal input windowId;
    signal input windowSpent;
    signal input rho;
    signal input pledgePaid;
    signal input lifetimeCap;
    signal input windowCap;
    signal input windowLen;
    signal input maxPerTx;
    signal input expiry;
    signal input recipientRoot;
    signal input ownerPk;
    signal input streamRate;
    signal input streamStart;
    signal input lender;
    signal input pledgeBps;
    signal input pathIndices[levels];
    signal input pathElements[levels];

    component policy = PolicyHash();
    policy.lifetimeCap <== lifetimeCap;
    policy.windowCap <== windowCap;
    policy.windowLen <== windowLen;
    policy.maxPerTx <== maxPerTx;
    policy.expiry <== expiry;
    policy.recipientRoot <== recipientRoot;
    policy.ownerPk <== ownerPk;
    policy.streamRate <== streamRate;
    policy.streamStart <== streamStart;
    policy.lender <== lender;
    policy.pledgeBps <== pledgeBps;

    component note = AllowanceCommitment();
    note.asset <== asset;
    note.remaining <== remaining;
    note.agentPk <== agentPk;
    note.policyHash <== policy.out;
    note.windowId <== windowId;
    note.windowSpent <== windowSpent;
    note.rho <== rho;
    note.pledgePaid <== pledgePaid;

    component tree = MerkleCheck(levels);
    tree.enabled <== 1;
    tree.root <== root;
    tree.leaf <== note.out;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // --- bounds ---
    component rRemaining = Range(AMOUNT_BITS());
    rRemaining.in <== remaining;
    component rMinRemaining = Range(AMOUNT_BITS());
    rMinRemaining.in <== minRemaining;
    component remainingOk = Leq(AMOUNT_BITS());
    remainingOk.a <== minRemaining;
    remainingOk.b <== remaining;
    remainingOk.out === 1;
    component rRate = Range(TIME_BITS());
    rRate.in <== streamRate;
    component rMinRate = Range(TIME_BITS());
    rMinRate.in <== minRate;
    component rateOk = Leq(TIME_BITS());
    rateOk.a <== minRate;
    rateOk.b <== streamRate;
    rateOk.out === 1;

    // --- the note is pledged to exactly this lender ---
    component bps = PledgeBps();
    bps.bps <== pledgeBps;
    bps.hasPledge === 1;
    component key = LenderKey();
    key.lenderAddr <== lenderAddr;
    key.loanRef <== loanRef;
    key.out === lender;

    // --- disclosed fields ---
    pledgeBpsPub === pledgeBps;
    expiryPub === expiry;
    lifetimeCapPub === lifetimeCap;
    pledgePaidPub === pledgePaid;
    streamStartPub === streamStart;
    assetPub === asset;

    signal audienceSquare <== audience * audience;
}

component main { public [root, minRemaining, minRate, lenderAddr, loanRef, pledgeBpsPub, expiryPub, lifetimeCapPub, pledgePaidPub, agentPk, audience, streamStartPub, assetPub] } = Stream(20);
