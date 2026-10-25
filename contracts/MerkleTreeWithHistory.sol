// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Poseidon(2) hasher deployed from circomlibjs bytecode.
interface IHasher {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// @notice Append-only Poseidon Merkle tree with a ring buffer of recent
/// roots, so proofs made against a slightly stale root still verify.
/// Mirrors src/merkle.ts and circuits/lib/merkle.circom exactly.
contract MerkleTreeWithHistory {
    uint256 public constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant ZERO_LEAF = uint256(keccak256("stipend")) % FIELD_SIZE;
    uint32 public constant ROOT_HISTORY_SIZE = 128;

    IHasher public immutable hasher;
    uint32 public immutable levels;

    mapping(uint256 => uint256) public filledSubtrees;
    mapping(uint256 => uint256) public zeros;
    mapping(uint256 => uint256) public roots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    constructor(uint32 _levels, IHasher _hasher) {
        require(_levels > 0 && _levels < 32, "levels");
        levels = _levels;
        hasher = _hasher;
        uint256 z = ZERO_LEAF;
        for (uint32 i = 0; i < _levels; i++) {
            zeros[i] = z;
            filledSubtrees[i] = z;
            z = _hasher.poseidon([z, z]);
        }
        roots[0] = z;
    }

    function hashLeftRight(uint256 left, uint256 right) public view returns (uint256) {
        require(left < FIELD_SIZE && right < FIELD_SIZE, "field");
        return hasher.poseidon([left, right]);
    }

    function _insert(uint256 leaf) internal returns (uint32 index) {
        uint32 i = nextIndex;
        require(i < uint32(2) ** levels, "tree full");
        uint256 current = leaf;
        for (uint32 level = 0; level < levels; level++) {
            uint256 left;
            uint256 right;
            if (i % 2 == 0) {
                left = current;
                right = zeros[level];
                filledSubtrees[level] = current;
            } else {
                left = filledSubtrees[level];
                right = current;
            }
            current = hashLeftRight(left, right);
            i /= 2;
        }
        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = current;
        index = nextIndex;
        nextIndex = index + 1;
    }

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 i = currentRootIndex;
        do {
            if (root == roots[i]) return true;
            if (i == 0) i = ROOT_HISTORY_SIZE;
            i--;
        } while (i != currentRootIndex);
        return false;
    }

    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }
}
