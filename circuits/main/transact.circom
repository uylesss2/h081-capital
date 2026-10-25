pragma circom 2.1.0;

include "lib/hashes.circom";
include "lib/merkle.circom";
include "lib/range.circom";

// Treasury transfer: nIns shielded notes in, nOuts shielded notes out, with
// an optional public leg (deposit when publicAmount > 0, withdrawal when it
// is negative mod p). Every note is in the same asset; the asset is public
// only because the public leg reveals it anyway for deposits/withdrawals.
// For a fully shielded transfer the caller passes publicAmount = 0 and the
// contract does not touch any token, so `asset` is then a private choice
// that the circuit still binds all notes to.
template Transact(levels, nIns, nOuts) {
    signal input root;
    signal input publicAmount;
    signal input publicAsset;
    signal input extDataHash;
    signal input inputNullifier[nIns];
    signal input outputCommitment[nOuts];

    signal input asset;
    signal input inAmount[nIns];
    signal input inBlinding[nIns];
    signal input inSk[nIns];
    signal input inPathIndices[nIns][levels];
    signal input inPathElements[nIns][levels];

    signal input outAmount[nOuts];
    signal input outPk[nOuts];
    signal input outBlinding[nOuts];

    component inPk[nIns];
    component inNk[nIns];
    component inC[nIns];
    component inNf[nIns];
    component inRange[nIns];
    component inLive[nIns];
    component inTree[nIns];

    var sumIns = 0;
    for (var i = 0; i < nIns; i++) {
        inPk[i] = PublicKey();
        inPk[i].sk <== inSk[i];
        inNk[i] = NullifyingKey();
        inNk[i].sk <== inSk[i];

        inC[i] = NoteCommitment();
        inC[i].asset <== asset;
        inC[i].amount <== inAmount[i];
        inC[i].pk <== inPk[i].pk;
        inC[i].blinding <== inBlinding[i];

        inNf[i] = NoteNullifier();
        inNf[i].nk <== inNk[i].nk;
        inNf[i].commitment <== inC[i].out;
        inNf[i].out === inputNullifier[i];

        inRange[i] = Range(AMOUNT_BITS());
        inRange[i].in <== inAmount[i];

        // Membership is only required for real (non-zero) inputs.
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

    component outC[nOuts];
    component outRange[nOuts];
    var sumOuts = 0;
    for (var i = 0; i < nOuts; i++) {
        outC[i] = NoteCommitment();
        outC[i].asset <== asset;
        outC[i].amount <== outAmount[i];
        outC[i].pk <== outPk[i];
        outC[i].blinding <== outBlinding[i];
        outC[i].out === outputCommitment[i];

        outRange[i] = Range(AMOUNT_BITS());
        outRange[i].in <== outAmount[i];
        sumOuts += outAmount[i];
    }

    // Nullifier distinctness within one transaction is enforced by the
    // contract, which rejects duplicates in the same call.
    sumIns + publicAmount === sumOuts;

    // The asset is revealed only when there is a public leg (deposit or
    // withdrawal), where the token transfer reveals it anyway. A fully
    // shielded transfer publishes publicAsset = 0.
    component pubLeg = NonZero();
    pubLeg.in <== publicAmount;
    publicAsset === asset * pubLeg.out;

    // Bind the external data (recipient, relayer, fee, memos) to the proof.
    signal extDataSquare <== extDataHash * extDataHash;
}

component main { public [root, publicAmount, publicAsset, extDataHash, inputNullifier, outputCommitment] } = Transact(20, 2, 2);
