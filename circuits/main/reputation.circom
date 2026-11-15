pragma circom 2.1.0;

include "lib/hashes.circom";
include "lib/merkle.circom";
include "lib/range.circom";
include "circomlib/circuits/comparators.circom";

// Private reputation (docs/REPUTATION-SPEC.md section 4).
//
// Over the rep_registry tree (one leaf per attested, fully repaid stream_loan loan) the prover shows that ONE
// account secret `masterSk` controls the loan keys of at least `minLoans` distinct loans in `asset` that total at
// least `minVolume`, come from at least `minLenders` distinct lender wallets, were funded at least `minSpanDays`
// apart, and fall into at least `minMonths` distinct 30-day periods counting only loans of at least `monthFloor`.
// Nothing else is revealed: not which loans, not the keys, not the exact totals.
//
// What it does NOT show (and a verifier must not read into it): anything about loans that were not repaid. The
// statement is a lower bound on good loans; defaults are never in the tree. It also cannot tell an independent
// lender from a second wallet of the borrower, nor whether the borrower's own money repaid the loan.
//
// Leaf (written by rep_registry `attest` from the stream_loan Slot):
//   R = Poseidon(DOM_REP, agentPk, loanRef, principal, assetF, lenderF, fundedDay, outcome)   outcome = 1 (repaid)
// Loan key k of an account:  loanSk = Poseidon(DOM_LOANKEY, masterSk, k), agentPk = Poseidon(DOM_PK, loanSk).
// Presentation nullifier:    presNullifier = Poseidon(DOM_REPNF, masterSk, audience), stable per audience.
//
// Slots are filled in order (enabled ones first) with strictly increasing loanRef, so no loan is counted twice.
// Padding slots (enabled = 0) take zeros and add nothing: every sum and every distinct-count is gated by `enabled`.
template Reputation(levels, N) {
    // ---- public, in this order (REPUTATION_PUBLIC in src/reputation.ts)
    signal input repRoot;
    signal input asset;
    signal input minLoans;
    signal input minVolume;
    signal input minLenders;
    signal input minSpanDays;
    signal input minMonths;
    signal input monthFloor;
    signal input audience;
    signal input nonce;
    signal input expiry;
    signal input bindTo;
    signal input presNullifier;

    // ---- private
    signal input masterSk;
    signal input enabled[N];
    signal input keyIndex[N];
    signal input loanRef[N];
    signal input principal[N];
    signal input lenderF[N];
    signal input fundedDay[N];
    signal input pathElements[N][levels];
    signal input pathIndices[N][levels];
    signal input selLo[N];
    signal input selHi[N];

    // ---- public thresholds are range checked here, so a raw-field caller (verify_reputation by CPI) can never
    // pass a value near the field modulus that wraps a comparison.
    component rMinLoans = Range(8);      rMinLoans.in <== minLoans;
    component rMinVolume = Range(64);    rMinVolume.in <== minVolume;
    component rMinLenders = Range(8);    rMinLenders.in <== minLenders;
    component rMinSpan = Range(16);      rMinSpan.in <== minSpanDays;
    component rMinMonths = Range(8);     rMinMonths.in <== minMonths;
    component rMonthFloor = Range(64);   rMonthFloor.in <== monthFloor;
    component rExpiry = Range(64);       rExpiry.in <== expiry;

    component skNz = NonZero();
    skNz.in <== masterSk;
    skNz.out === 1;

    // ---- per slot: key derivation, leaf, membership, ranges
    component rKey[N];
    component rRef[N];
    component rPrin[N];
    component rLender[N];
    component rDay[N];
    component loanSk[N];
    component loanPk[N];
    component leaf[N];
    component member[N];
    signal month[N];
    signal monthRem[N];
    component rMonth[N];
    component rRem[N];
    component remLt[N];
    for (var j = 0; j < N; j++) {
        enabled[j] * (1 - enabled[j]) === 0;
        rKey[j] = Range(32);     rKey[j].in <== keyIndex[j];
        rRef[j] = Range(64);     rRef[j].in <== loanRef[j];
        rPrin[j] = Range(64);    rPrin[j].in <== principal[j];
        rLender[j] = Range(160); rLender[j].in <== lenderF[j];
        rDay[j] = Range(32);     rDay[j].in <== fundedDay[j];

        loanSk[j] = Poseidon(3);
        loanSk[j].inputs[0] <== DOM_LOANKEY();
        loanSk[j].inputs[1] <== masterSk;
        loanSk[j].inputs[2] <== keyIndex[j];
        loanPk[j] = PublicKey();
        loanPk[j].sk <== loanSk[j].out;

        leaf[j] = Poseidon(8);
        leaf[j].inputs[0] <== DOM_REP();
        leaf[j].inputs[1] <== loanPk[j].pk;
        leaf[j].inputs[2] <== loanRef[j];
        leaf[j].inputs[3] <== principal[j];
        leaf[j].inputs[4] <== asset;           // the PUBLIC asset: every counted loan is in it
        leaf[j].inputs[5] <== lenderF[j];
        leaf[j].inputs[6] <== fundedDay[j];
        leaf[j].inputs[7] <== 1;               // outcome: repaid

        member[j] = MerkleCheck(levels);
        member[j].enabled <== enabled[j];
        member[j].root <== repRoot;
        member[j].leaf <== leaf[j].out;
        for (var i = 0; i < levels; i++) {
            member[j].pathElements[i] <== pathElements[j][i];
            member[j].pathIndices[i] <== pathIndices[j][i];
        }

        // 30-day period of the funding day: fundedDay = 30 * month + rem, 0 <= rem < 30
        month[j] <-- fundedDay[j] \ 30;
        monthRem[j] <-- fundedDay[j] % 30;
        rMonth[j] = Range(32);   rMonth[j].in <== month[j];
        rRem[j] = Range(5);      rRem[j].in <== monthRem[j];
        remLt[j] = Lt(5);
        remLt[j].a <== monthRem[j];
        remLt[j].b <== 30;
        remLt[j].out === 1;
        fundedDay[j] === 30 * month[j] + monthRem[j];
    }

    // ---- enabled slots first, loan refs strictly increasing over them (no loan counted twice)
    component refLt[N - 1];
    for (var j = 0; j < N - 1; j++) {
        enabled[j + 1] * (1 - enabled[j]) === 0;
        refLt[j] = Lt(64);
        refLt[j].a <== loanRef[j];
        refLt[j].b <== loanRef[j + 1];
        (1 - refLt[j].out) * enabled[j + 1] === 0;
    }

    // ---- count and volume
    signal countAcc[N + 1];
    signal volAcc[N + 1];
    countAcc[0] <== 0;
    volAcc[0] <== 0;
    for (var j = 0; j < N; j++) {
        countAcc[j + 1] <== countAcc[j] + enabled[j];
        volAcc[j + 1] <== volAcc[j] + enabled[j] * principal[j];
    }
    component someLoan = NonZero();
    someLoan.in <== countAcc[N];
    someLoan.out === 1;
    component loansOk = Leq(9);
    loansOk.a <== minLoans;
    loansOk.b <== countAcc[N];
    loansOk.out === 1;
    // volume < N * 2^64 <= 2^72 for N <= 256
    component volOk = Leq(73);
    volOk.a <== minVolume;
    volOk.b <== volAcc[N];
    volOk.out === 1;

    // ---- distinct lenders: slot j counts when enabled and no earlier enabled slot has the same lender
    // ---- distinct 30-day periods: the same, over slots whose principal is at least monthFloor
    component floorOk[N];
    signal inMonth[N];
    for (var j = 0; j < N; j++) {
        floorOk[j] = Leq(64);
        floorOk[j].a <== monthFloor;
        floorOk[j].b <== principal[j];
        inMonth[j] <== enabled[j] * floorOk[j].out;
    }
    component sameLender[N][N];
    component sameMonth[N][N];
    signal lenderNew[N][N + 1];
    signal monthNew[N][N + 1];
    signal lenderHit[N][N];
    signal monthHit[N][N];
    signal lendersAcc[N + 1];
    signal monthsAcc[N + 1];
    lendersAcc[0] <== 0;
    monthsAcc[0] <== 0;
    for (var j = 0; j < N; j++) {
        lenderNew[j][0] <== enabled[j];
        monthNew[j][0] <== inMonth[j];
        for (var i = 0; i < j; i++) {
            sameLender[i][j] = IsEqual();
            sameLender[i][j].in[0] <== lenderF[i];
            sameLender[i][j].in[1] <== lenderF[j];
            lenderHit[i][j] <== sameLender[i][j].out * enabled[i];
            lenderNew[j][i + 1] <== lenderNew[j][i] * (1 - lenderHit[i][j]);

            sameMonth[i][j] = IsEqual();
            sameMonth[i][j].in[0] <== month[i];
            sameMonth[i][j].in[1] <== month[j];
            monthHit[i][j] <== sameMonth[i][j].out * inMonth[i];
            monthNew[j][i + 1] <== monthNew[j][i] * (1 - monthHit[i][j]);
        }
        lendersAcc[j + 1] <== lendersAcc[j] + lenderNew[j][j];
        monthsAcc[j + 1] <== monthsAcc[j] + monthNew[j][j];
    }
    component lendersOk = Leq(9);
    lendersOk.a <== minLenders;
    lendersOk.b <== lendersAcc[N];
    lendersOk.out === 1;
    component monthsOk = Leq(9);
    monthsOk.a <== minMonths;
    monthsOk.b <== monthsAcc[N];
    monthsOk.out === 1;

    // ---- span: two selected ENABLED slots with lo + minSpanDays <= hi (funding days)
    signal loSum[N + 1];
    signal hiSum[N + 1];
    signal loOn[N + 1];
    signal hiOn[N + 1];
    signal lo[N + 1];
    signal hi[N + 1];
    loSum[0] <== 0; hiSum[0] <== 0; loOn[0] <== 0; hiOn[0] <== 0; lo[0] <== 0; hi[0] <== 0;
    for (var j = 0; j < N; j++) {
        selLo[j] * (1 - selLo[j]) === 0;
        selHi[j] * (1 - selHi[j]) === 0;
        loSum[j + 1] <== loSum[j] + selLo[j];
        hiSum[j + 1] <== hiSum[j] + selHi[j];
        loOn[j + 1] <== loOn[j] + selLo[j] * enabled[j];
        hiOn[j + 1] <== hiOn[j] + selHi[j] * enabled[j];
        lo[j + 1] <== lo[j] + selLo[j] * fundedDay[j];
        hi[j + 1] <== hi[j] + selHi[j] * fundedDay[j];
    }
    loSum[N] === 1;
    hiSum[N] === 1;
    loOn[N] === 1;
    hiOn[N] === 1;
    component spanOk = Leq(34);
    spanOk.a <== lo[N] + minSpanDays;
    spanOk.b <== hi[N];
    spanOk.out === 1;

    // ---- one reputation per account per audience
    component nf = Poseidon(3);
    nf.inputs[0] <== DOM_REPNF();
    nf.inputs[1] <== masterSk;
    nf.inputs[2] <== audience;
    presNullifier === nf.out;

    // ---- bind the challenge (Groth16 binds every public input; the squares keep them in the constraint system)
    signal nonceSquare <== nonce * nonce;
    signal bindSquare <== bindTo * bindTo;
}

component main { public [repRoot, asset, minLoans, minVolume, minLenders, minSpanDays, minMonths, monthFloor, audience, nonce, expiry, bindTo, presNullifier] } = Reputation(20, 16);
