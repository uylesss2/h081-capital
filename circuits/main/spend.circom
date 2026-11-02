pragma circom 2.1.0;

include "lib/hashes.circom";
include "lib/merkle.circom";
include "lib/range.circom";
include "circomlib/circuits/comparators.circom";

// Spend from an allowance. The policy lives inside the note, so a payment
// that breaks it has no valid proof. Three callers, exactly one per proof:
//   - the agent (pk == agentPk): every policy rule is enforced;
//   - the owner (pk == ownerPk in the policy): no rules, which is how an
//     owner reclaims or revokes an allowance; the pledge share is still routed;
//   - the lender (isLenderClaim == 1, sk unused): pulls its share of the
//     vested stream; the contract checks msg.sender == lenderAddr.
// A pledged allowance (pledgeBps != 0) routes floor(amount * pledgeBps / 10000)
// of every agent or owner spend to the lender, capped so the lender never
// receives more than floor(lifetimeCap * pledgeBps / 10000) over the note's
// life; the recipient gets the rest. The chain then sees the asset, the
// lender, the loan ref and the share. Unpledged notes behave as before.
// The payout is either shielded (a note to recipientPk; chain sees only a
// commitment) or public (amount and address visible; payer still hidden).
template Spend(levels, recipientLevels) {
    // public, in this order
    signal input root;
    signal input nullifier;
    signal input newAllowanceCommitment;
    signal input payCommitment;
    signal input publicAmount;
    signal input publicRecipient;
    signal input publicAsset;
    signal input fee;
    signal input now;
    signal input receipt;
    signal input lenderAmount;
    signal input lenderAddr;
    signal input loanRef;
    signal input isLenderClaim;
    signal input extDataHash;

    // allowance note being spent
    signal input asset;
    signal input remaining;
    signal input agentPk;
    signal input windowId;
    signal input windowSpent;
    signal input rho;
    signal input pledgePaid;
    // its policy
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
    // spender and membership
    signal input sk;
    signal input pathIndices[levels];
    signal input pathElements[levels];
    // the payment (gross: deducted from remaining)
    signal input amount;
    signal input isPublic;
    signal input recipientPk;
    signal input payBlinding;
    signal input recipientPathIndices[recipientLevels];
    signal input recipientPathElements[recipientLevels];
    // pledge witnesses: share = floor(amount * bps / 10000), lifetimeShare = floor(lifetimeCap * bps / 10000)
    signal input share;
    signal input shareRem;
    signal input lifetimeShare;
    signal input lifetimeShareRem;
    // claim witnesses: vested value and owed = floor(vested * bps / 10000)
    signal input vested;
    signal input owedQ;
    signal input owedRem;

    isPublic * (1 - isPublic) === 0;
    isLenderClaim * (1 - isLenderClaim) === 0;
    signal notClaim <== 1 - isLenderClaim;

    // --- who is spending ---
    component pk = PublicKey();
    pk.sk <== sk;
    component isOwner = IsEqual();
    isOwner.in[0] <== pk.pk;
    isOwner.in[1] <== ownerPk;
    component isAgent = IsEqual();
    isAgent.in[0] <== pk.pk;
    isAgent.in[1] <== agentPk;
    signal stranger <== (1 - isOwner.out) * (1 - isAgent.out);
    stranger * notClaim === 0;
    // Rules are enforced only for the agent's own spends.
    signal enforce <== isAgent.out * notClaim;

    // --- the note exists ---
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

    component nf = AllowanceNullifier();
    nf.rho <== rho;
    nf.commitment <== note.out;
    nf.out === nullifier;

    // --- ranges ---
    component rAmount = Range(AMOUNT_BITS());
    rAmount.in <== amount;
    component rRemaining = Range(AMOUNT_BITS());
    rRemaining.in <== remaining;
    component rFee = Range(AMOUNT_BITS());
    rFee.in <== fee;
    component rSpent = Range(AMOUNT_BITS());
    rSpent.in <== windowSpent;
    component rCap = Range(AMOUNT_BITS());
    rCap.in <== windowCap;
    component rMax = Range(AMOUNT_BITS());
    rMax.in <== maxPerTx;
    component rNow = Range(TIME_BITS());
    rNow.in <== now;
    component rLen = Range(TIME_BITS());
    rLen.in <== windowLen;
    component rExp = Range(TIME_BITS());
    rExp.in <== expiry;
    component rPaid = Range(AMOUNT_BITS());
    rPaid.in <== pledgePaid;

    // --- lifetime budget: amount <= remaining, always ---
    component okRemaining = Leq(AMOUNT_BITS());
    okRemaining.a <== amount;
    okRemaining.b <== remaining;
    okRemaining.out === 1;

    // --- spending window: newWindowId = floor(now / windowLen) ---
    signal newWindowId;
    signal rem;
    newWindowId <-- now \ windowLen;
    rem <-- now % windowLen;
    now === newWindowId * windowLen + rem;
    component rWid = Range(TIME_BITS());
    rWid.in <== newWindowId;
    component rRem = Range(TIME_BITS());
    rRem.in <== rem;
    component remOk = Lt(TIME_BITS());
    remOk.a <== rem;
    remOk.b <== windowLen;
    remOk.out === 1;

    component sameWindow = IsEqual();
    sameWindow.in[0] <== newWindowId;
    sameWindow.in[1] <== windowId;
    signal carried <== sameWindow.out * windowSpent;
    signal counted <== amount * enforce;
    signal newWindowSpent <== carried + counted;

    // --- per-window cap (0 = unlimited) ---
    component hasCap = NonZero();
    hasCap.in <== windowCap;
    signal capEnforced <== hasCap.out * enforce;
    component okCap = LeqWhen(AMOUNT_BITS());
    okCap.a <== newWindowSpent;
    okCap.b <== windowCap;
    okCap.when <== capEnforced;

    // --- per-transaction cap (0 = unlimited) ---
    component hasMax = NonZero();
    hasMax.in <== maxPerTx;
    signal maxEnforced <== hasMax.out * enforce;
    component okMax = LeqWhen(AMOUNT_BITS());
    okMax.a <== amount;
    okMax.b <== maxPerTx;
    okMax.when <== maxEnforced;

    // --- expiry (0 = never): now < expiry; binds the agent, not the lender ---
    component hasExpiry = NonZero();
    hasExpiry.in <== expiry;
    signal expEnforced <== hasExpiry.out * enforce;
    component okExp = Lt(TIME_BITS());
    okExp.a <== now;
    okExp.b <== expiry;
    (1 - okExp.out) * expEnforced === 0;

    // --- pledge: lender fields are consistent, pledgeBps <= 10000 ---
    component bps = PledgeBps();
    bps.bps <== pledgeBps;
    signal hasPledge <== bps.hasPledge;
    component binding = LenderBinding();
    binding.hasPledge <== hasPledge;
    binding.lender <== lender;
    binding.lenderAddr <== lenderAddr;
    binding.loanRef <== loanRef;
    // a claim exists only on a pledged allowance
    isLenderClaim * (1 - hasPledge) === 0;

    // --- streaming release (streamRate 0 = none): spentSoFar + amount <= rate * (now - start) ---
    component rRate = Range(TIME_BITS());
    rRate.in <== streamRate;
    component rStart = Range(TIME_BITS());
    rStart.in <== streamStart;
    component hasStream = NonZero();
    hasStream.in <== streamRate;
    signal streamEnforced <== hasStream.out * enforce;
    signal claimStream <== hasStream.out * isLenderClaim;
    // elapsed must be non-negative for agent spends and claims; a start in the future makes it unprovable
    component startOk = Leq(TIME_BITS());
    startOk.a <== streamStart;
    startOk.b <== now;
    (1 - startOk.out) * (streamEnforced + claimStream) === 0;
    signal elapsed <== now - streamStart;
    signal allotted <== streamRate * elapsed;
    signal spentSoFar <== lifetimeCap - remaining;
    component rLifetime = Range(AMOUNT_BITS());
    rLifetime.in <== lifetimeCap;
    component capOk = Leq(AMOUNT_BITS());
    capOk.a <== remaining;
    capOk.b <== lifetimeCap;
    capOk.out === 1;
    component streamOk = LeqWhen(130);
    streamOk.a <== spentSoFar + amount;
    streamOk.b <== allotted;
    streamOk.when <== streamEnforced;

    // --- pledge routing on agent and owner spends ---
    // share = floor(amount * bps / 10000), capped at what the lender may still receive over the
    // note's life, lifetimeShare - pledgePaid, so claims (advances) are never collected twice.
    component shareOf = ShareOf();
    shareOf.value <== amount;
    shareOf.bps <== pledgeBps;
    shareOf.q <== share;
    shareOf.rem <== shareRem;
    component lifetimeShareOf = ShareOf();
    lifetimeShareOf.value <== lifetimeCap;
    lifetimeShareOf.bps <== pledgeBps;
    lifetimeShareOf.q <== lifetimeShare;
    lifetimeShareOf.rem <== lifetimeShareRem;
    component paidOk = Leq(AMOUNT_BITS());
    paidOk.a <== pledgePaid;
    paidOk.b <== lifetimeShare;
    paidOk.out === 1;
    signal headroom <== lifetimeShare - pledgePaid;
    component shareFits = Leq(AMOUNT_BITS());
    shareFits.a <== share;
    shareFits.b <== headroom;
    signal routed <== headroom + shareFits.out * (share - headroom);
    signal shareLeg <== routed * notClaim;
    signal claimLeg <== amount * isLenderClaim;
    lenderAmount === shareLeg + claimLeg;
    // what the recipient gets
    signal net <== amount - lenderAmount;

    // --- lender claim: amount + pledgePaid <= floor(vested * bps / 10000), vested <= min(lifetimeCap, allotted) ---
    component rVested = Range(AMOUNT_BITS());
    rVested.in <== vested;
    component vestedCap = Leq(AMOUNT_BITS());
    vestedCap.a <== vested;
    vestedCap.b <== lifetimeCap;
    vestedCap.out === 1;
    component vestedOk = LeqWhen(130);
    vestedOk.a <== vested;
    vestedOk.b <== allotted;
    vestedOk.when <== claimStream;
    component owedOf = ShareOf();
    owedOf.value <== vested;
    owedOf.bps <== pledgeBps;
    owedOf.q <== owedQ;
    owedOf.rem <== owedRem;
    component claimOk = LeqWhen(130);
    claimOk.a <== amount + pledgePaid;
    claimOk.b <== owedQ;
    claimOk.when <== isLenderClaim;
    // a claim pays nobody but the lender
    isPublic * isLenderClaim === 0;
    payCommitment * isLenderClaim === 0;

    // --- recipient ---
    component addrKey = AddressKey();
    addrKey.addr <== publicRecipient;
    signal recipientKey <== recipientPk + isPublic * (addrKey.out - recipientPk);

    // allow-list (recipientRoot 0 = any recipient)
    component hasList = NonZero();
    hasList.in <== recipientRoot;
    signal listEnforced <== hasList.out * enforce;
    component listTree = MerkleCheck(recipientLevels);
    listTree.enabled <== listEnforced;
    listTree.root <== recipientRoot;
    listTree.leaf <== recipientKey;
    for (var i = 0; i < recipientLevels; i++) {
        listTree.pathElements[i] <== recipientPathElements[i];
        listTree.pathIndices[i] <== recipientPathIndices[i];
    }

    // --- public leg: the asset is revealed whenever a share may be paid ---
    publicAmount === net * isPublic;
    signal publicAndPledged <== isPublic * hasPledge;
    signal revealAsset <== isPublic + hasPledge - publicAndPledged;
    publicAsset === asset * revealAsset;
    publicRecipient * (1 - isPublic) === 0;
    fee * (1 - isPublic) === 0;
    component feeOk = Leq(AMOUNT_BITS());
    feeOk.a <== fee;
    feeOk.b <== net;
    feeOk.out === 1;

    // --- shielded payout note ---
    component pay = NoteCommitment();
    pay.asset <== asset;
    pay.amount <== net;
    pay.pk <== recipientPk;
    pay.blinding <== payBlinding;
    signal shieldedPay <== (1 - isPublic) * notClaim;
    (payCommitment - pay.out) * shieldedPay === 0;
    payCommitment * isPublic === 0;

    // --- successor allowance ---
    // A claim leaves the agent's window state untouched: the lender's `now`
    // must not be able to reset the window counters.
    signal keptWindowId <== newWindowId + isLenderClaim * (windowId - newWindowId);
    signal keptWindowSpent <== newWindowSpent + isLenderClaim * (windowSpent - newWindowSpent);
    component nextRho = NextRho();
    nextRho.rho <== rho;
    component next = AllowanceCommitment();
    next.asset <== asset;
    next.remaining <== remaining - amount;
    next.agentPk <== agentPk;
    next.policyHash <== policy.out;
    next.windowId <== keptWindowId;
    next.windowSpent <== keptWindowSpent;
    next.rho <== nextRho.out;
    next.pledgePaid <== pledgePaid + lenderAmount;
    next.out === newAllowanceCommitment;

    // --- receipt ---
    component rcpt = ReceiptCommitment();
    rcpt.asset <== asset;
    rcpt.amount <== net;
    rcpt.recipientKey <== recipientKey;
    rcpt.windowId <== keptWindowId;
    rcpt.nullifier <== nullifier;
    rcpt.out === receipt;

    signal extDataSquare <== extDataHash * extDataHash;
}

component main { public [root, nullifier, newAllowanceCommitment, payCommitment, publicAmount, publicRecipient, publicAsset, fee, now, receipt, lenderAmount, lenderAddr, loanRef, isLenderClaim, extDataHash] } = Spend(20, 8);
