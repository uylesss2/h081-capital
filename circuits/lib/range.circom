pragma circom 2.1.0;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// Amounts are 128-bit. Two such values can be added without wrapping the
// BN254 scalar field, and a field element is checked to be in range by
// decomposing it into bits.
function AMOUNT_BITS() { return 128; }
function TIME_BITS() { return 64; }

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
