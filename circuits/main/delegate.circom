pragma circom 2.1.0;

include "lib/hashes.circom";
include "lib/merkle.circom";
include "lib/range.circom";
include "circomlib/circuits/comparators.circom";

// Hierarchical delegation: an agent splits its allowance into nSubs
// sub-allowances for other agents plus a residual for itself, without the
// owner. Every sub-policy is provably no looser than the parent's, and the
// window caps and streaming rates of the subs and the residual together
// never exceed the parent's, so the tree as a whole still obeys the
// owner's policy. The owner can reclaim any note in the tree.
//   fixed by the parent:  windowLen, recipientRoot, ownerPk, (residual) expiry
//   tightened per sub:    windowCap, maxPerTx, expiry, streamRate, streamStart
// What the parent has already consumed is not forgotten: the subs together
// start the current window with at least what the residual's cap cannot
// absorb of the parent's windowSpent, and a sub's stream starts no earlier
// than the parent's start, than now, and than the point where the parent's
// stream had released what the parent already spent. Without those, an
// agent could self-delegate to reset its window or re-mint its stream.
// Pledges: every sub and the residual carry the parent's lender and
// pledgeBps unchanged. A pledge is immutable and only the owner creates one
// (grant.circom), so an agent can neither re-point a lender nor lend to
// itself to escape the owner's rules. The residual keeps the parent's
// pledgePaid and may not shrink below what the lender has already been
// advanced on; subs start at zero.
template Delegate(levels, nSubs) {
    // public
    signal input root;
    signal input nullifier;
    signal input subCommitment[nSubs];
    signal input residualCommitment;
    signal input now;
    signal input extDataHash;

    // the parent allowance
    signal input asset;
    signal input remaining;
    signal input agentPk;
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
    // preimage of `lender`; both 0 when unpledged
    signal input lenderAddr;
    signal input loanRef;
    signal input sk;
    signal input pathIndices[levels];
    signal input pathElements[levels];

    // the subs
    signal input subAgentPk[nSubs];
    signal input subAmount[nSubs];
    signal input subWindowCap[nSubs];
    signal input subMaxPerTx[nSubs];
    signal input subExpiry[nSubs];
    signal input subStreamRate[nSubs];
    signal input subStreamStart[nSubs];
    signal input subRho[nSubs];
    // what each sub starts the current window with (see "the window already spent" below)
    signal input subWindowSpent[nSubs];

    // the residual's share of the window cap and stream
    signal input resWindowCap;
    signal input resStreamRate;
    // witness: floor((lifetimeCap - sumAmount) * pledgeBps / 10000)
    signal input resLifetimeShare;
    signal input resLifetimeShareRem;

    // --- only the agent delegates ---
    component pk = PublicKey();
    pk.sk <== sk;
    pk.pk === agentPk;

    // --- the parent exists ---
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

    // --- parent ranges and flags ---
    component rRemaining = Range(AMOUNT_BITS());
    rRemaining.in <== remaining;
    component rCap = Range(AMOUNT_BITS());
    rCap.in <== windowCap;
    component rMax = Range(AMOUNT_BITS());
    rMax.in <== maxPerTx;
    component rExp = Range(TIME_BITS());
    rExp.in <== expiry;
    component rRate = Range(TIME_BITS());
    rRate.in <== streamRate;
    component rNow = Range(TIME_BITS());
    rNow.in <== now;
    component rLifetime = Range(AMOUNT_BITS());
    rLifetime.in <== lifetimeCap;
    component rPaid = Range(AMOUNT_BITS());
    rPaid.in <== pledgePaid;
    component rSpent = Range(AMOUNT_BITS());
    rSpent.in <== windowSpent;
    component rStart = Range(TIME_BITS());
    rStart.in <== streamStart;
    // what the parent has drawn from its lifetime budget so far (remaining never exceeds the cap)
    component capOk = Leq(AMOUNT_BITS());
    capOk.a <== remaining;
    capOk.b <== lifetimeCap;
    capOk.out === 1;
    signal spentSoFar <== lifetimeCap - remaining;

    component hasCap = NonZero();
    hasCap.in <== windowCap;
    component hasMax = NonZero();
    hasMax.in <== maxPerTx;
    component hasExp = NonZero();
    hasExp.in <== expiry;
    component hasRate = NonZero();
    hasRate.in <== streamRate;
    // the parent's pledge is well formed; subs and the residual copy it as is
    component bps = PledgeBps();
    bps.bps <== pledgeBps;
    component binding = LenderBinding();
    binding.hasPledge <== bps.hasPledge;
    binding.lender <== lender;
    binding.lenderAddr <== lenderAddr;
    binding.loanRef <== loanRef;

    // --- subs ---
    component subPolicy[nSubs];
    component sub[nSubs];
    component rAmt[nSubs];
    component rSCap[nSubs];
    component rSMax[nSubs];
    component rSExp[nSubs];
    component rSRate[nSubs];
    component rSStart[nSubs];
    component capNZ[nSubs];
    component maxNZ[nSubs];
    component expNZ[nSubs];
    component rateNZ[nSubs];
    component maxLe[nSubs];
    component expLe[nSubs];
    component startGe[nSubs];
    component startAfterParent[nSubs];
    component frontierOk[nSubs];
    component rSSpent[nSubs];
    component spentLe[nSubs];
    signal gap[nSubs];
    signal drawnBySubStart[nSubs];
    var sumAmount = 0;
    var sumCap = 0;
    var sumRate = 0;
    var sumWindowSpent = 0;
    for (var i = 0; i < nSubs; i++) {
        rAmt[i] = Range(AMOUNT_BITS());
        rAmt[i].in <== subAmount[i];
        rSCap[i] = Range(AMOUNT_BITS());
        rSCap[i].in <== subWindowCap[i];
        rSMax[i] = Range(AMOUNT_BITS());
        rSMax[i].in <== subMaxPerTx[i];
        rSExp[i] = Range(TIME_BITS());
        rSExp[i].in <== subExpiry[i];
        rSRate[i] = Range(TIME_BITS());
        rSRate[i].in <== subStreamRate[i];
        rSStart[i] = Range(TIME_BITS());
        rSStart[i].in <== subStreamStart[i];

        // a capped parent cannot spawn an uncapped sub (0 would mean unlimited)
        capNZ[i] = NonZero();
        capNZ[i].in <== subWindowCap[i];
        (1 - capNZ[i].out) * hasCap.out === 0;
        maxNZ[i] = NonZero();
        maxNZ[i].in <== subMaxPerTx[i];
        (1 - maxNZ[i].out) * hasMax.out === 0;
        expNZ[i] = NonZero();
        expNZ[i].in <== subExpiry[i];
        (1 - expNZ[i].out) * hasExp.out === 0;
        rateNZ[i] = NonZero();
        rateNZ[i].in <== subStreamRate[i];
        (1 - rateNZ[i].out) * hasRate.out === 0;

        // per-sub ceilings inherited from the parent
        maxLe[i] = LeqWhen(AMOUNT_BITS());
        maxLe[i].a <== subMaxPerTx[i];
        maxLe[i].b <== maxPerTx;
        maxLe[i].when <== hasMax.out;
        expLe[i] = LeqWhen(TIME_BITS());
        expLe[i].a <== subExpiry[i];
        expLe[i].b <== expiry;
        expLe[i].when <== hasExp.out;
        // a sub stream starts no earlier than now, so it cannot claim the parent's past allotment
        startGe[i] = LeqWhen(TIME_BITS());
        startGe[i].a <== now;
        startGe[i].b <== subStreamStart[i];
        startGe[i].when <== hasRate.out;
        // ... nor earlier than the parent's own start (a cliff cannot be skipped by self-delegating) ...
        startAfterParent[i] = LeqWhen(TIME_BITS());
        startAfterParent[i].a <== streamStart;
        startAfterParent[i].b <== subStreamStart[i];
        startAfterParent[i].when <== hasRate.out;
        // ... nor earlier than the point the parent's stream had already released what the parent spent:
        // spentSoFar <= streamRate * (subStreamStart - streamStart). A sub starts with spentSoFar = 0, so
        // without this a self-delegation at a back-dated `now` re-mints allotment the parent already used.
        gap[i] <== hasRate.out * (subStreamStart[i] - streamStart);
        drawnBySubStart[i] <== streamRate * gap[i];
        frontierOk[i] = LeqWhen(130);
        frontierOk[i].a <== spentSoFar;
        frontierOk[i].b <== drawnBySubStart[i];
        frontierOk[i].when <== hasRate.out;

        // the window already spent: a sub under a capped parent may start the window partly spent (at most
        // its own cap); an uncapped parent's subs start at zero
        rSSpent[i] = Range(AMOUNT_BITS());
        rSSpent[i].in <== subWindowSpent[i];
        spentLe[i] = LeqWhen(AMOUNT_BITS());
        spentLe[i].a <== subWindowSpent[i];
        spentLe[i].b <== subWindowCap[i];
        spentLe[i].when <== hasCap.out;
        (1 - hasCap.out) * subWindowSpent[i] === 0;

        subPolicy[i] = PolicyHash();
        subPolicy[i].lifetimeCap <== subAmount[i];
        subPolicy[i].windowCap <== subWindowCap[i];
        subPolicy[i].windowLen <== windowLen;
        subPolicy[i].maxPerTx <== subMaxPerTx[i];
        subPolicy[i].expiry <== subExpiry[i];
        subPolicy[i].recipientRoot <== recipientRoot;
        subPolicy[i].ownerPk <== ownerPk;
        subPolicy[i].streamRate <== subStreamRate[i];
        subPolicy[i].streamStart <== subStreamStart[i];
        subPolicy[i].lender <== lender;
        subPolicy[i].pledgeBps <== pledgeBps;

        sub[i] = AllowanceCommitment();
        sub[i].asset <== asset;
        sub[i].remaining <== subAmount[i];
        sub[i].agentPk <== subAgentPk[i];
        sub[i].policyHash <== subPolicy[i].out;
        sub[i].windowId <== windowId;
        sub[i].windowSpent <== subWindowSpent[i];
        sub[i].rho <== subRho[i];
        sub[i].pledgePaid <== 0;
        sub[i].out === subCommitment[i];

        sumAmount += subAmount[i];
        sumCap += subWindowCap[i];
        sumRate += subStreamRate[i];
        sumWindowSpent += subWindowSpent[i];
    }

    // --- the window already spent is not forgotten ---
    // The residual keeps the parent's windowSpent, so this window it can still spend at most
    // max(0, resWindowCap - windowSpent). Whatever the residual's cap cannot absorb must be carried
    // by the subs: sum(subWindowSpent) >= windowSpent - resWindowCap. Then, across the whole tree,
    // what can still be spent this window never exceeds windowCap - windowSpent. (A stale windowId
    // makes the inherited figure moot: the first spend in a later window starts from zero anyway.)
    component resAbsorbs = Leq(AMOUNT_BITS());
    resAbsorbs.a <== windowSpent;
    resAbsorbs.b <== resWindowCap;
    signal excessSpent <== (1 - resAbsorbs.out) * (windowSpent - resWindowCap);
    component carriedOk = LeqWhen(132);
    carriedOk.a <== excessSpent;
    carriedOk.b <== sumWindowSpent;
    carriedOk.when <== hasCap.out;

    // --- the shares add up to no more than the parent's ---
    signal residualRemaining <== remaining - sumAmount;
    component rRes = Range(AMOUNT_BITS());
    rRes.in <== residualRemaining;
    component rResCap = Range(AMOUNT_BITS());
    rResCap.in <== resWindowCap;
    component rResRate = Range(TIME_BITS());
    rResRate.in <== resStreamRate;
    // a non-empty residual under a capped or streamed parent keeps a non-zero cap and rate; an empty one may drop them
    component resNZ = NonZero();
    resNZ.in <== residualRemaining;
    component resCapNZ = NonZero();
    resCapNZ.in <== resWindowCap;
    signal capNeeded <== hasCap.out * resNZ.out;
    (1 - resCapNZ.out) * capNeeded === 0;
    component resRateNZ = NonZero();
    resRateNZ.in <== resStreamRate;
    signal rateNeeded <== hasRate.out * resNZ.out;
    (1 - resRateNZ.out) * rateNeeded === 0;
    component capSum = LeqWhen(132);
    capSum.a <== resWindowCap + sumCap;
    capSum.b <== windowCap;
    capSum.when <== hasCap.out;
    component rateSum = LeqWhen(68);
    rateSum.a <== resStreamRate + sumRate;
    rateSum.b <== streamRate;
    rateSum.when <== hasRate.out;

    // --- the residual: same policy, shrunk ---
    // Its lifetime share must still cover what the lender has been paid, so the
    // lender's lifetime total over the whole tree stays at most floor(lifetimeCap * bps / 10000).
    signal resLifetimeCap <== lifetimeCap - sumAmount;
    component rResLifetime = Range(AMOUNT_BITS());
    rResLifetime.in <== resLifetimeCap;
    component resShare = ShareOf();
    resShare.value <== resLifetimeCap;
    resShare.bps <== pledgeBps;
    resShare.q <== resLifetimeShare;
    resShare.rem <== resLifetimeShareRem;
    component resPaidOk = Leq(AMOUNT_BITS());
    resPaidOk.a <== pledgePaid;
    resPaidOk.b <== resLifetimeShare;
    resPaidOk.out === 1;

    component resPolicy = PolicyHash();
    resPolicy.lifetimeCap <== resLifetimeCap;
    resPolicy.windowCap <== resWindowCap;
    resPolicy.windowLen <== windowLen;
    resPolicy.maxPerTx <== maxPerTx;
    resPolicy.expiry <== expiry;
    resPolicy.recipientRoot <== recipientRoot;
    resPolicy.ownerPk <== ownerPk;
    resPolicy.streamRate <== resStreamRate;
    resPolicy.streamStart <== streamStart;
    resPolicy.lender <== lender;
    resPolicy.pledgeBps <== pledgeBps;

    component nextRho = NextRho();
    nextRho.rho <== rho;
    component res = AllowanceCommitment();
    res.asset <== asset;
    res.remaining <== residualRemaining;
    res.agentPk <== agentPk;
    res.policyHash <== resPolicy.out;
    res.windowId <== windowId;
    res.windowSpent <== windowSpent;
    res.rho <== nextRho.out;
    res.pledgePaid <== pledgePaid;
    res.out === residualCommitment;

    signal extDataSquare <== extDataHash * extDataHash;
}

component main { public [root, nullifier, subCommitment, residualCommitment, now, extDataHash] } = Delegate(20, 4);
