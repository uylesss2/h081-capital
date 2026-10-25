// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleTreeWithHistory, IHasher} from "./MerkleTreeWithHistory.sol";

interface ITransactVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[8] calldata input) external view returns (bool);
}

interface IGrantVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[22] calldata input) external view returns (bool);
}

interface IDelegateVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[9] calldata input) external view returns (bool);
}

interface ISpendVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[11] calldata input) external view returns (bool);
}

interface IDiscloseVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[6] calldata input) external view returns (bool);
}

/// @title StipendPool
/// @notice One shielded pool for every ERC-20. Holds treasury notes and
/// agent allowances as commitments in a Poseidon Merkle tree. There is no
/// owner, no admin key, no pause switch and no upgrade path: the only
/// privileged party over any note is the key that can prove it.
contract StipendPool is MerkleTreeWithHistory, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_AMOUNT = (1 << 128) - 1;
    /// @dev `now` in a spend proof must fall inside this window around block time.
    uint256 public constant NOW_LOOKBACK = 15 minutes;
    uint256 public constant NOW_LOOKAHEAD = 1 minutes;
    uint256 public constant GRANT_OUTPUTS = 16;
    uint256 public constant DELEGATE_OUTPUTS = 4;

    ITransactVerifier public immutable transactVerifier;
    IGrantVerifier public immutable grantVerifier;
    ISpendVerifier public immutable spendVerifier;
    IDiscloseVerifier public immutable discloseVerifier;
    IDelegateVerifier public immutable delegateVerifier;

    mapping(uint256 => bool) public nullifierHashes;

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    struct TransactArgs {
        uint256 root;
        uint256 publicAmount; // (extAmount - fee) mod FIELD_SIZE
        address publicAsset;  // zero for a fully shielded transfer
        uint256 extDataHash;
        uint256[2] inputNullifiers;
        uint256[2] outputCommitments;
    }

    struct TransactExtData {
        address recipient; // withdrawal destination
        address relayer;
        int256 extAmount;  // > 0 deposit, < 0 withdrawal, 0 shielded transfer
        uint256 fee;
        bytes[2] encryptedOutputs;
    }

    struct GrantArgs {
        uint256 root;
        uint256[2] inputNullifiers;
        uint256[GRANT_OUTPUTS] allowanceCommitments;
        uint256 changeCommitment;
        uint256 totalCommitment;
        uint256 extDataHash;
    }

    struct GrantExtData {
        bytes[GRANT_OUTPUTS] encryptedAllowances;
        bytes encryptedChange;
    }

    struct SpendArgs {
        uint256 root;
        uint256 nullifier;
        uint256 newAllowanceCommitment;
        uint256 payCommitment;   // zero for a public payout
        uint256 publicAmount;    // zero for a shielded payout
        address publicRecipient;
        address publicAsset;
        uint256 fee;
        uint256 timestamp;       // `now` inside the proof
        uint256 receipt;
        uint256 extDataHash;
    }

    struct SpendExtData {
        address relayer;
        bytes encryptedAllowance; // successor note, for the agent
        bytes encryptedPayment;   // payout note, for a shielded recipient
    }

    struct DelegateArgs {
        uint256 root;
        uint256 nullifier;
        uint256[DELEGATE_OUTPUTS] subCommitments;
        uint256 residualCommitment;
        uint256 timestamp; // `now` inside the proof
        uint256 extDataHash;
    }

    struct DelegateExtData {
        bytes[DELEGATE_OUTPUTS] encryptedSubs;
        bytes encryptedResidual;
    }

    struct DiscloseArgs {
        uint256 root;
        uint256 kind;
        uint256 bound;
        uint256 windowId;
        uint256 agentPk;
        uint256 audience;
    }

    event NewCommitment(uint256 indexed commitment, uint32 index, bytes encryptedOutput);
    event NewNullifier(uint256 indexed nullifier);
    event NewGrant(uint256 indexed totalCommitment, uint32 firstIndex);
    event NewReceipt(uint256 indexed receipt);
    event PublicPayout(address indexed asset, address indexed recipient, uint256 amount);

    constructor(
        uint32 _levels,
        IHasher _hasher,
        ITransactVerifier _transact,
        IGrantVerifier _grant,
        ISpendVerifier _spend,
        IDiscloseVerifier _disclose,
        IDelegateVerifier _delegate
    ) MerkleTreeWithHistory(_levels, _hasher) {
        transactVerifier = _transact;
        grantVerifier = _grant;
        spendVerifier = _spend;
        discloseVerifier = _disclose;
        delegateVerifier = _delegate;
    }

    // ------------------------------------------------------------------
    // Treasury: deposit, withdraw, shielded transfer
    // ------------------------------------------------------------------

    function transact(Proof calldata proof, TransactArgs calldata args, TransactExtData calldata ext) external nonReentrant {
        require(isKnownRoot(args.root), "unknown root");
        require(args.extDataHash == _hash(abi.encode(ext)), "ext data");
        require(args.inputNullifiers[0] != args.inputNullifiers[1], "same nullifier");
        require(ext.fee <= MAX_AMOUNT, "fee");
        require(args.publicAmount == _publicAmount(ext.extAmount, ext.fee), "public amount");
        if (ext.extAmount == 0 && ext.fee == 0) {
            require(args.publicAsset == address(0), "asset must be hidden");
        } else {
            require(args.publicAsset != address(0), "asset");
        }
        require(
            transactVerifier.verifyProof(
                proof.a,
                proof.b,
                proof.c,
                [
                    args.root,
                    args.publicAmount,
                    uint256(uint160(args.publicAsset)),
                    args.extDataHash,
                    args.inputNullifiers[0],
                    args.inputNullifiers[1],
                    args.outputCommitments[0],
                    args.outputCommitments[1]
                ]
            ),
            "invalid proof"
        );

        _spendNullifier(args.inputNullifiers[0]);
        _spendNullifier(args.inputNullifiers[1]);

        if (ext.extAmount > 0) {
            IERC20(args.publicAsset).safeTransferFrom(msg.sender, address(this), uint256(ext.extAmount));
        }

        _insertWithMemo(args.outputCommitments[0], ext.encryptedOutputs[0]);
        _insertWithMemo(args.outputCommitments[1], ext.encryptedOutputs[1]);

        if (ext.extAmount < 0) {
            require(ext.recipient != address(0), "recipient");
            IERC20(args.publicAsset).safeTransfer(ext.recipient, uint256(-ext.extAmount));
        }
        if (ext.fee > 0) {
            IERC20(args.publicAsset).safeTransfer(ext.relayer, ext.fee);
        }
    }

    // ------------------------------------------------------------------
    // Distribution: one proof funds up to GRANT_OUTPUTS agents
    // ------------------------------------------------------------------

    function grant(Proof calldata proof, GrantArgs calldata args, GrantExtData calldata ext) external nonReentrant {
        require(isKnownRoot(args.root), "unknown root");
        require(args.extDataHash == _hash(abi.encode(ext)), "ext data");
        require(args.inputNullifiers[0] != args.inputNullifiers[1], "same nullifier");

        uint256[22] memory input;
        input[0] = args.root;
        input[1] = args.inputNullifiers[0];
        input[2] = args.inputNullifiers[1];
        for (uint256 i = 0; i < GRANT_OUTPUTS; i++) {
            input[3 + i] = args.allowanceCommitments[i];
        }
        input[3 + GRANT_OUTPUTS] = args.changeCommitment;
        input[4 + GRANT_OUTPUTS] = args.totalCommitment;
        input[5 + GRANT_OUTPUTS] = args.extDataHash;
        require(grantVerifier.verifyProof(proof.a, proof.b, proof.c, input), "invalid proof");

        _spendNullifier(args.inputNullifiers[0]);
        _spendNullifier(args.inputNullifiers[1]);

        uint32 first = nextIndex;
        for (uint256 i = 0; i < GRANT_OUTPUTS; i++) {
            _insertWithMemo(args.allowanceCommitments[i], ext.encryptedAllowances[i]);
        }
        _insertWithMemo(args.changeCommitment, ext.encryptedChange);
        emit NewGrant(args.totalCommitment, first);
    }

    // ------------------------------------------------------------------
    // Spend from an allowance (agent) or reclaim it (owner)
    // ------------------------------------------------------------------

    function spend(Proof calldata proof, SpendArgs calldata args, SpendExtData calldata ext) external nonReentrant {
        require(isKnownRoot(args.root), "unknown root");
        require(args.extDataHash == _hash(abi.encode(ext)), "ext data");
        require(
            args.timestamp + NOW_LOOKBACK >= block.timestamp && args.timestamp <= block.timestamp + NOW_LOOKAHEAD,
            "stale timestamp"
        );
        require(
            spendVerifier.verifyProof(
                proof.a,
                proof.b,
                proof.c,
                [
                    args.root,
                    args.nullifier,
                    args.newAllowanceCommitment,
                    args.payCommitment,
                    args.publicAmount,
                    uint256(uint160(args.publicRecipient)),
                    uint256(uint160(args.publicAsset)),
                    args.fee,
                    args.timestamp,
                    args.receipt,
                    args.extDataHash
                ]
            ),
            "invalid proof"
        );

        _spendNullifier(args.nullifier);
        _insertWithMemo(args.newAllowanceCommitment, ext.encryptedAllowance);

        if (args.publicAmount > 0) {
            require(args.publicRecipient != address(0), "recipient");
            uint256 toRecipient = args.publicAmount - args.fee;
            IERC20(args.publicAsset).safeTransfer(args.publicRecipient, toRecipient);
            if (args.fee > 0) IERC20(args.publicAsset).safeTransfer(ext.relayer, args.fee);
            emit PublicPayout(args.publicAsset, args.publicRecipient, toRecipient);
        } else {
            _insertWithMemo(args.payCommitment, ext.encryptedPayment);
        }
        emit NewReceipt(args.receipt);
    }

    // ------------------------------------------------------------------
    // Delegation: an agent splits its allowance into sub-allowances under
    // provably tighter policy, without the owner
    // ------------------------------------------------------------------

    event NewDelegation(uint256 indexed nullifier, uint32 firstIndex);

    function delegate(Proof calldata proof, DelegateArgs calldata args, DelegateExtData calldata ext) external nonReentrant {
        require(isKnownRoot(args.root), "unknown root");
        require(args.extDataHash == _hash(abi.encode(ext)), "ext data");
        require(
            args.timestamp + NOW_LOOKBACK >= block.timestamp && args.timestamp <= block.timestamp + NOW_LOOKAHEAD,
            "stale timestamp"
        );
        require(
            delegateVerifier.verifyProof(
                proof.a,
                proof.b,
                proof.c,
                [
                    args.root,
                    args.nullifier,
                    args.subCommitments[0],
                    args.subCommitments[1],
                    args.subCommitments[2],
                    args.subCommitments[3],
                    args.residualCommitment,
                    args.timestamp,
                    args.extDataHash
                ]
            ),
            "invalid proof"
        );
        _spendNullifier(args.nullifier);
        uint32 first = nextIndex;
        for (uint256 i = 0; i < DELEGATE_OUTPUTS; i++) {
            _insertWithMemo(args.subCommitments[i], ext.encryptedSubs[i]);
        }
        _insertWithMemo(args.residualCommitment, ext.encryptedResidual);
        emit NewDelegation(args.nullifier, first);
    }

    // ------------------------------------------------------------------
    // Selective disclosure: anyone can verify on-chain, nothing is written
    // ------------------------------------------------------------------

    function verifyDisclosure(Proof calldata proof, DiscloseArgs calldata args) external view returns (bool) {
        if (!isKnownRoot(args.root)) return false;
        return discloseVerifier.verifyProof(
            proof.a, proof.b, proof.c, [args.root, args.kind, args.bound, args.windowId, args.agentPk, args.audience]
        );
    }

    // ------------------------------------------------------------------

    function isSpent(uint256 nullifier) external view returns (bool) {
        return nullifierHashes[nullifier];
    }

    function _spendNullifier(uint256 nullifier) internal {
        require(!nullifierHashes[nullifier], "already spent");
        nullifierHashes[nullifier] = true;
        emit NewNullifier(nullifier);
    }

    function _insertWithMemo(uint256 commitment, bytes calldata memo) internal {
        uint32 index = _insert(commitment);
        emit NewCommitment(commitment, index, memo);
    }

    function _hash(bytes memory data) internal pure returns (uint256) {
        return uint256(keccak256(data)) % FIELD_SIZE;
    }

    function _publicAmount(int256 extAmount, uint256 fee) internal pure returns (uint256) {
        require(fee <= MAX_AMOUNT, "fee");
        if (extAmount >= 0) {
            require(uint256(extAmount) <= MAX_AMOUNT, "amount");
            return (uint256(extAmount) + FIELD_SIZE - fee) % FIELD_SIZE;
        }
        require(uint256(-extAmount) <= MAX_AMOUNT, "amount");
        return (FIELD_SIZE - uint256(-extAmount) - fee) % FIELD_SIZE;
    }
}
