// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleTreeWithHistory, IHasher} from "./MerkleTreeWithHistory.sol";
import {IPledgeSink} from "./lending/IPledgeSink.sol";
import {TryERC20} from "./TryERC20.sol";

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
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[15] calldata input) external view returns (bool);
}

interface IDiscloseVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[6] calldata input) external view returns (bool);
}

interface IStreamVerifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[13] calldata input) external view returns (bool);
}

/// @title StipendPool
/// @notice One shielded pool for every ERC-20. Holds treasury notes and
/// agent allowances as commitments in a Poseidon Merkle tree. There is no
/// owner, no admin key, no pause switch and no upgrade path: the only
/// privileged party over any note is the key that can prove it.
///
/// A pledged allowance routes a circuit-fixed share of every spend to its
/// lender, and the lender may pull the vested share itself (a claim). Both
/// are spends; the pool only moves what the proof says.
contract StipendPool is MerkleTreeWithHistory, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using TryERC20 for address;

    uint256 public constant MAX_AMOUNT = (1 << 128) - 1;
    /// @dev Gas forwarded to a lender contract's `onPledge`; a greedy sink cannot make a spend cost the block.
    uint256 public constant SINK_GAS = 300_000;
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
    IStreamVerifier public immutable streamVerifier;

    mapping(uint256 => bool) public nullifierHashes;
    /// @notice Lender shares the token refused to deliver, by asset, lender and loan ref.
    /// Anyone may push them out with `pullLenderShare`; a spend is never blocked by its lender leg.
    mapping(address => mapping(address => mapping(uint64 => uint256))) public owed;

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
        uint256 payCommitment;   // zero for a public payout or a lender claim
        uint256 publicAmount;    // net of the lender share; zero for a shielded payout or a claim
        address publicRecipient;
        address publicAsset;     // set whenever a share may be paid, so the pool knows what to move
        uint256 fee;
        uint256 timestamp;       // `now` inside the proof
        uint256 receipt;
        uint256 lenderAmount;    // the lender share of this spend, or the whole amount on a claim
        address lenderAddr;      // zero when the allowance is unpledged
        uint64 loanRef;          // zero when the allowance is unpledged
        bool isLenderClaim;      // the lender pulls its vested share; nothing goes to anyone else
        uint256 extDataHash;
    }

    struct SpendExtData {
        address relayer;
        bytes encryptedAllowance; // successor note, for the agent
        bytes encryptedPayment;   // payout note, for a shielded recipient
        bytes encryptedLender;    // successor note, for the lender; empty when unpledged
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

    /// @dev Public inputs of the stream proof, in circuit order.
    struct StreamArgs {
        uint256 root;
        uint256 minRemaining;
        uint256 minRate;
        address lenderAddr;
        uint64 loanRef;
        uint16 pledgeBps;
        uint64 expiry;
        uint256 lifetimeCap;
        uint256 pledgePaid;
        uint256 agentPk;
        uint256 audience;
        uint64 streamStart;  // when the stream begins; a lender funds only a stream that has started
        address asset;       // what the shares are paid in
    }

    event NewCommitment(uint256 indexed commitment, uint32 index, bytes encryptedOutput);
    event NewNullifier(uint256 indexed nullifier);
    event NewGrant(uint256 indexed totalCommitment, uint32 firstIndex);
    event NewReceipt(uint256 indexed receipt);
    event PublicPayout(address indexed asset, address indexed recipient, uint256 amount);
    event PledgeRouted(address indexed lenderAddr, uint64 indexed loanRef, address indexed asset, uint256 amount, uint256 nullifier);
    /// @dev The share of a PledgeRouted that stayed in the pool because the token refused the lender.
    event PledgeEscrowed(address indexed lenderAddr, uint64 indexed loanRef, address indexed asset, uint256 amount);
    event LenderShareReleased(address indexed lenderAddr, uint64 indexed loanRef, address indexed asset, uint256 amount);
    event LenderMemo(uint64 indexed loanRef, bytes encryptedLender);

    constructor(
        uint32 _levels,
        IHasher _hasher,
        ITransactVerifier _transact,
        IGrantVerifier _grant,
        ISpendVerifier _spend,
        IDiscloseVerifier _disclose,
        IDelegateVerifier _delegate,
        IStreamVerifier _stream
    ) MerkleTreeWithHistory(_levels, _hasher) {
        transactVerifier = _transact;
        grantVerifier = _grant;
        spendVerifier = _spend;
        discloseVerifier = _disclose;
        delegateVerifier = _delegate;
        streamVerifier = _stream;
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
    // Spend from an allowance (agent), reclaim it (owner) or claim the
    // vested share (lender). The pledge share is routed on every spend.
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
                    args.lenderAmount,
                    uint256(uint160(args.lenderAddr)),
                    uint256(args.loanRef),
                    args.isLenderClaim ? 1 : 0,
                    args.extDataHash
                ]
            ),
            "invalid proof"
        );
        // Only the lender itself pulls its vested share.
        if (args.isLenderClaim) require(msg.sender == args.lenderAddr, "lender");

        _spendNullifier(args.nullifier);
        _insertWithMemo(args.newAllowanceCommitment, ext.encryptedAllowance);

        if (args.publicAmount > 0) {
            require(args.publicRecipient != address(0), "recipient");
            uint256 toRecipient = args.publicAmount - args.fee;
            IERC20(args.publicAsset).safeTransfer(args.publicRecipient, toRecipient);
            if (args.fee > 0) IERC20(args.publicAsset).safeTransfer(ext.relayer, args.fee);
            emit PublicPayout(args.publicAsset, args.publicRecipient, toRecipient);
        } else if (!args.isLenderClaim && args.payCommitment != 0) {
            // A public spend whose net is zero (pledgeBps 10000) has no payout note to insert.
            _insertWithMemo(args.payCommitment, ext.encryptedPayment);
        }

        if (args.lenderAmount > 0) {
            require(args.lenderAddr != address(0), "lender");
            // The lender leg never blocks a spend, so the owner can always reclaim. A share the token
            // refuses to deliver stays here, owed to the lender, until someone calls pullLenderShare.
            if (args.publicAsset.tryTransfer(args.lenderAddr, args.lenderAmount)) {
                _tellSink(args.lenderAddr, args.publicAsset, args.lenderAmount, args.loanRef);
            } else {
                owed[args.publicAsset][args.lenderAddr][args.loanRef] += args.lenderAmount;
                emit PledgeEscrowed(args.lenderAddr, args.loanRef, args.publicAsset, args.lenderAmount);
            }
            emit PledgeRouted(args.lenderAddr, args.loanRef, args.publicAsset, args.lenderAmount, args.nullifier);
        }
        if (ext.encryptedLender.length > 0) emit LenderMemo(args.loanRef, ext.encryptedLender);
        emit NewReceipt(args.receipt);
    }

    /// @notice Deliver a lender share the pool holds in escrow. Anyone may call it.
    function pullLenderShare(address asset, address lenderAddr, uint64 loanRef) external nonReentrant {
        uint256 amount = owed[asset][lenderAddr][loanRef];
        require(amount > 0, "nothing owed");
        owed[asset][lenderAddr][loanRef] = 0;
        IERC20(asset).safeTransfer(lenderAddr, amount);
        _tellSink(lenderAddr, asset, amount, loanRef);
        emit LenderShareReleased(lenderAddr, loanRef, asset, amount);
    }

    /// @dev A contract lender is told about a delivered share; a failing or greedy sink never blocks the caller.
    function _tellSink(address lenderAddr, address asset, uint256 amount, uint64 loanRef) internal {
        if (lenderAddr.code.length == 0) return;
        try IPledgeSink(lenderAddr).onPledge{gas: SINK_GAS}(asset, amount, loanRef) {} catch {}
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

    /// @notice A lender-facing bound: the note is pledged to (lenderAddr, loanRef), has at least
    /// `minRemaining` left and streams at least `minRate`; cap, expiry, what was already routed,
    /// the stream start and the asset are revealed.
    function verifyStream(Proof calldata proof, StreamArgs calldata args) external view returns (bool) {
        if (!isKnownRoot(args.root)) return false;
        return streamVerifier.verifyProof(
            proof.a,
            proof.b,
            proof.c,
            [
                args.root,
                args.minRemaining,
                args.minRate,
                uint256(uint160(args.lenderAddr)),
                uint256(args.loanRef),
                uint256(args.pledgeBps),
                uint256(args.expiry),
                args.lifetimeCap,
                args.pledgePaid,
                args.agentPk,
                args.audience,
                uint256(args.streamStart),
                uint256(uint160(args.asset))
            ]
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
