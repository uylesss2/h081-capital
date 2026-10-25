pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Domain separation tags. Every hash in the protocol is Poseidon with a
// leading tag so that no two object types can collide.
function DOM_PK()     { return 1; }
function DOM_NK()     { return 2; }
function DOM_NOTE()   { return 3; }
function DOM_ALLOW()  { return 4; }
function DOM_POLICY() { return 5; }
function DOM_NF()     { return 6; }
function DOM_NFA()    { return 7; }
function DOM_RHO()    { return 8; }
function DOM_TOTAL()  { return 9; }
function DOM_RCPT()   { return 10; }
function DOM_ADDR()   { return 11; }

// pk = Poseidon(DOM_PK, sk)
template PublicKey() {
    signal input sk;
    signal output pk;
    component h = Poseidon(2);
    h.inputs[0] <== DOM_PK();
    h.inputs[1] <== sk;
    pk <== h.out;
}

// nk = Poseidon(DOM_NK, sk): the nullifying key. Can be handed to a scanner
// so it can detect spends without being able to spend.
template NullifyingKey() {
    signal input sk;
    signal output nk;
    component h = Poseidon(2);
    h.inputs[0] <== DOM_NK();
    h.inputs[1] <== sk;
    nk <== h.out;
}

// Treasury note: funds owned by a key, any ERC-20 asset.
// C = Poseidon(DOM_NOTE, asset, amount, pk, blinding)
template NoteCommitment() {
    signal input asset;
    signal input amount;
    signal input pk;
    signal input blinding;
    signal output out;
    component h = Poseidon(5);
    h.inputs[0] <== DOM_NOTE();
    h.inputs[1] <== asset;
    h.inputs[2] <== amount;
    h.inputs[3] <== pk;
    h.inputs[4] <== blinding;
    out <== h.out;
}

// Policy: the programmable spending rules bound into an allowance.
// Zero means "no limit" for windowCap, maxPerTx, expiry and recipientRoot.
// P = Poseidon(DOM_POLICY, lifetimeCap, windowCap, windowLen, maxPerTx, expiry, recipientRoot, ownerPk)
template PolicyHash() {
    signal input lifetimeCap;
    signal input windowCap;
    signal input windowLen;
    signal input maxPerTx;
    signal input expiry;
    signal input recipientRoot;
    signal input ownerPk;
    signal output out;
    component h = Poseidon(8);
    h.inputs[0] <== DOM_POLICY();
    h.inputs[1] <== lifetimeCap;
    h.inputs[2] <== windowCap;
    h.inputs[3] <== windowLen;
    h.inputs[4] <== maxPerTx;
    h.inputs[5] <== expiry;
    h.inputs[6] <== recipientRoot;
    h.inputs[7] <== ownerPk;
    out <== h.out;
}

// Allowance note: funds an agent may spend under a policy.
// A = Poseidon(DOM_ALLOW, asset, remaining, agentPk, policyHash, windowId, windowSpent, rho)
template AllowanceCommitment() {
    signal input asset;
    signal input remaining;
    signal input agentPk;
    signal input policyHash;
    signal input windowId;
    signal input windowSpent;
    signal input rho;
    signal output out;
    component h = Poseidon(8);
    h.inputs[0] <== DOM_ALLOW();
    h.inputs[1] <== asset;
    h.inputs[2] <== remaining;
    h.inputs[3] <== agentPk;
    h.inputs[4] <== policyHash;
    h.inputs[5] <== windowId;
    h.inputs[6] <== windowSpent;
    h.inputs[7] <== rho;
    out <== h.out;
}

// nf = Poseidon(DOM_NF, nk, commitment)
template NoteNullifier() {
    signal input nk;
    signal input commitment;
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== DOM_NF();
    h.inputs[1] <== nk;
    h.inputs[2] <== commitment;
    out <== h.out;
}

// Allowance nullifier: rho is shared by owner and agent, so either can
// nullify (the owner's reclaim is how revocation works).
// nfA = Poseidon(DOM_NFA, rho, commitment)
template AllowanceNullifier() {
    signal input rho;
    signal input commitment;
    signal output out;
    component h = Poseidon(3);
    h.inputs[0] <== DOM_NFA();
    h.inputs[1] <== rho;
    h.inputs[2] <== commitment;
    out <== h.out;
}

// The allowance's successor note uses rho' = Poseidon(DOM_RHO, rho), so the
// owner can follow the chain without receiving memos.
template NextRho() {
    signal input rho;
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== DOM_RHO();
    h.inputs[1] <== rho;
    out <== h.out;
}

// Commitment to the total of a batch grant, openable off-chain.
template TotalCommitment() {
    signal input asset;
    signal input total;
    signal input salt;
    signal output out;
    component h = Poseidon(4);
    h.inputs[0] <== DOM_TOTAL();
    h.inputs[1] <== asset;
    h.inputs[2] <== total;
    h.inputs[3] <== salt;
    out <== h.out;
}

// Receipt of one payment, emitted publicly as an opaque hash.
template ReceiptCommitment() {
    signal input asset;
    signal input amount;
    signal input recipientKey;
    signal input windowId;
    signal input nullifier;
    signal output out;
    component h = Poseidon(6);
    h.inputs[0] <== DOM_RCPT();
    h.inputs[1] <== asset;
    h.inputs[2] <== amount;
    h.inputs[3] <== recipientKey;
    h.inputs[4] <== windowId;
    h.inputs[5] <== nullifier;
    out <== h.out;
}

// A public (unshielded) recipient address, lifted into the same key space
// as shielded public keys so that recipient allow-lists can mix both.
template AddressKey() {
    signal input addr;
    signal output out;
    component h = Poseidon(2);
    h.inputs[0] <== DOM_ADDR();
    h.inputs[1] <== addr;
    out <== h.out;
}
