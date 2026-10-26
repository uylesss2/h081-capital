pragma circom 2.1.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "hashes.circom";

// Amounts are 128-bit. Two such values can be added without wrapping the
// BN254 scalar field, and a field element is checked to be in range by
// decomposing it into bits.
function AMOUNT_BITS() { return 128; }
function TIME_BITS() { return 64; }
// pledgeBps is a fraction of this.
function BPS() { return 10000; }

template Range(bits) {
    signal input in;
    component n2b = Num2Bits(bits);
    n2b.in <== in;
}

// out = 1 iff a <= b. Both inputs must already be range checked to `bits`.
template Leq(bits) {
    signal input a;
    signal input b;
    signal output out;
    component c = LessEqThan(bits);
    c.in[0] <== a;
    c.in[1] <== b;
    out <== c.out;
}

// out = 1 iff a < b.
template Lt(bits) {
    signal input a;
    signal input b;
    signal output out;
    component c = LessThan(bits);
    c.in[0] <== a;
    c.in[1] <== b;
    out <== c.out;
}

// Enforces (a <= b) whenever `when` is 1. `when` must be boolean.
template LeqWhen(bits) {
    signal input a;
    signal input b;
    signal input when;
    component c = Leq(bits);
    c.a <== a;
    c.b <== b;
    (1 - c.out) * when === 0;
}

// out = 1 iff in != 0
template NonZero() {
    signal input in;
    signal output out;
    component z = IsZero();
    z.in <== in;
    out <== 1 - z.out;
}

// A pledge fraction: 0 <= bps <= 10000. hasPledge = 1 iff bps != 0.
template PledgeBps() {
    signal input bps;
    signal output hasPledge;
    component r = Range(16);
    r.in <== bps;
    component le = Leq(16);
    le.a <== bps;
    le.b <== BPS();
    le.out === 1;
    component nz = NonZero();
    nz.in <== bps;
    hasPledge <== nz.out;
}

// Division witness: value * bps === q * 10000 + rem with 0 <= rem < 10000
// and q 128-bit, so q = floor(value * bps / 10000) and nothing else fits.
// `value` must be 128-bit and `bps` at most 10000, so the product does not wrap.
template ShareOf() {
    signal input value;
    signal input bps;
    signal input q;
    signal input rem;
    component rq = Range(AMOUNT_BITS());
    rq.in <== q;
    component rr = Range(16);
    rr.in <== rem;
    component lt = Lt(16);
    lt.a <== rem;
    lt.b <== BPS();
    lt.out === 1;
    value * bps === q * BPS() + rem;
}

// Lender fields of a policy are consistent with its pledge flag:
//   hasPledge == 1: lender == LenderKey(lenderAddr, loanRef), lenderAddr != 0
//   hasPledge == 0: lender, lenderAddr and loanRef are all 0
// lenderAddr is a 160-bit address and loanRef a 64-bit slot id, so the
// preimage of every pledge fits the contract's SpendArgs and the note can
// always be spent.
template LenderBinding() {
    signal input hasPledge;
    signal input lender;
    signal input lenderAddr;
    signal input loanRef;
    component ra = Range(160);
    ra.in <== lenderAddr;
    component rl = Range(64);
    rl.in <== loanRef;
    component key = LenderKey();
    key.lenderAddr <== lenderAddr;
    key.loanRef <== loanRef;
    hasPledge * (lender - key.out) === 0;
    component nz = NonZero();
    nz.in <== lenderAddr;
    hasPledge * (1 - nz.out) === 0;
    signal noPledge <== 1 - hasPledge;
    noPledge * lender === 0;
    noPledge * lenderAddr === 0;
    noPledge * loanRef === 0;
}
