pragma circom 2.1.0;

include "lib/hashes.circom";
include "lib/merkle.circom";
include "lib/range.circom";

// Batch distribution: the owner spends up to nIns treasury notes and mints
// nOuts allowance notes (one per agent, each with its own policy) plus one
// change note back to the treasury. The chain sees nOuts + 1 commitments
// and a hash of the total; amounts, agents, policies and the asset stay
// private. Unused slots carry amount 0 and a throwaway agent key.
template Grant(levels, nIns, nOuts) {
    signal input root;
    signal input inputNullifier[nIns];
    signal input allowanceCommitment[nOuts];
    signal input changeCommitment;
    signal input totalCommitment;
    signal input extDataHash;

    signal input asset;
    signal input sk;
    signal input inAmount[nIns];
    signal input inBlinding[nIns];
    signal input inPathIndices[nIns][levels];
    signal input inPathElements[nIns][levels];

    signal input agentPk[nOuts];
    signal input amount[nOuts];
    signal input windowCap[nOuts];
    signal input windowLen[nOuts];
    signal input maxPerTx[nOuts];
    signal input expiry[nOuts];
    signal input recipientRoot[nOuts];
    signal input rho[nOuts];

    signal input changeAmount;
    signal input changeBlinding;
    signal input totalSalt;

    component ownerPk = PublicKey();
    ownerPk.sk <== sk;
    component nk = NullifyingKey();
    nk.sk <== sk;

    component inC[nIns];
    component inNf[nIns];
    component inRange[nIns];
    component inLive[nIns];
    component inTree[nIns];
    var sumIns = 0;
    for (var i = 0; i < nIns; i++) {
        inC[i] = NoteCommitment();
        inC[i].asset <== asset;
        inC[i].amount <== inAmount[i];
        inC[i].pk <== ownerPk.pk;
        inC[i].blinding <== inBlinding[i];

        inNf[i] = NoteNullifier();
        inNf[i].nk <== nk.nk;
        inNf[i].commitment <== inC[i].out;
        inNf[i].out === inputNullifier[i];

        inRange[i] = Range(AMOUNT_BITS());
        inRange[i].in <== inAmount[i];

        inLive[i] = NonZero();
        inLive[i].in <== inAmount[i];
        inTree[i] = MerkleCheck(levels);
        inTree[i].enabled <== inLive[i].out;
        inTree[i].root <== root;
        inTree[i].leaf <== inC[i].out;
        for (var j = 0; j < levels; j++) {
            inTree[i].pathElements[j] <== inPathElements[i][j];
            inTree[i].pathIndices[j] <== inPathIndices[i][j];
        }
        sumIns += inAmount[i];
    }

    component policy[nOuts];
    component allow[nOuts];
    component aRange[nOuts];
    component capRange[nOuts];
    component txRange[nOuts];
    component lenRange[nOuts];
    component expRange[nOuts];
    component lenNonZero[nOuts];
    var sumOuts = 0;
    for (var i = 0; i < nOuts; i++) {
        aRange[i] = Range(AMOUNT_BITS());
        aRange[i].in <== amount[i];
        capRange[i] = Range(AMOUNT_BITS());
        capRange[i].in <== windowCap[i];
        txRange[i] = Range(AMOUNT_BITS());
        txRange[i].in <== maxPerTx[i];
        lenRange[i] = Range(TIME_BITS());
        lenRange[i].in <== windowLen[i];
        expRange[i] = Range(TIME_BITS());
        expRange[i].in <== expiry[i];
        // A window length of zero would make the spend circuit's division
        // meaningless, so it is forbidden at grant time.
        lenNonZero[i] = NonZero();
        lenNonZero[i].in <== windowLen[i];
        lenNonZero[i].out === 1;

        policy[i] = PolicyHash();
        policy[i].lifetimeCap <== amount[i];
        policy[i].windowCap <== windowCap[i];
        policy[i].windowLen <== windowLen[i];
        policy[i].maxPerTx <== maxPerTx[i];
        policy[i].expiry <== expiry[i];
        policy[i].recipientRoot <== recipientRoot[i];
        policy[i].ownerPk <== ownerPk.pk;

        allow[i] = AllowanceCommitment();
        allow[i].asset <== asset;
        allow[i].remaining <== amount[i];
        allow[i].agentPk <== agentPk[i];
        allow[i].policyHash <== policy[i].out;
        allow[i].windowId <== 0;
        allow[i].windowSpent <== 0;
        allow[i].rho <== rho[i];
        allow[i].out === allowanceCommitment[i];

        sumOuts += amount[i];
    }

    component change = NoteCommitment();
    change.asset <== asset;
    change.amount <== changeAmount;
    change.pk <== ownerPk.pk;
    change.blinding <== changeBlinding;
    change.out === changeCommitment;
    component changeRange = Range(AMOUNT_BITS());
    changeRange.in <== changeAmount;

    sumIns === sumOuts + changeAmount;

    component total = TotalCommitment();
    total.asset <== asset;
    total.total <== sumOuts;
    total.salt <== totalSalt;
    total.out === totalCommitment;

    signal extDataSquare <== extDataHash * extDataHash;
}

component main { public [root, inputNullifier, allowanceCommitment, changeCommitment, totalCommitment, extDataHash] } = Grant(20, 2, 8);
