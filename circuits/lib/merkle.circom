pragma circom 2.1.0;

include "circomlib/circuits/poseidon.circom";

// Computes the root of a Poseidon(2) Merkle tree from a leaf and its path.
// pathIndices[i] is the bit of the leaf index at level i (0 = leaf is on the left).
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    signal hashes[levels + 1];
    signal left[levels];
    signal right[levels];
    hashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        left[i] <== hashes[i] + pathIndices[i] * (pathElements[i] - hashes[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (hashes[i] - pathElements[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];
        hashes[i + 1] <== hashers[i].out;
    }
    root <== hashes[levels];
}

// Checks membership only when `enabled` is 1. Used for dummy inputs
// (amount 0) that do not exist in the tree.
template MerkleCheck(levels) {
    signal input enabled;
    signal input root;
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    enabled * (1 - enabled) === 0;
    component p = MerkleProof(levels);
    p.leaf <== leaf;
    for (var i = 0; i < levels; i++) {
        p.pathElements[i] <== pathElements[i];
        p.pathIndices[i] <== pathIndices[i];
    }
    (p.root - root) * enabled === 0;
}
