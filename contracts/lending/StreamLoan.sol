// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {StipendPool} from "../StipendPool.sol";
import {TryERC20} from "../TryERC20.sol";
import {IPledgeSink} from "./IPledgeSink.sol";

/// @title StreamLoan
/// @notice Lender-facing registry for loans against pledged stream allowances.
/// A lender opens a slot, the borrower pledges an allowance to (this, slot),
/// and the lender funds against a stream proof. Every share the pool routes
/// here is credited to the slot and forwarded to its lender in the same call;
/// a share the token refuses to deliver, or one routed to a slot nobody has
/// opened yet, waits here for the slot's lender to `collect`. The lender pulls
/// its vested share through `claim`. No owner.
contract StreamLoan is IPledgeSink, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using TryERC20 for address;

    /// @notice Time after the allowance's expiry before an unpaid loan counts as a shortfall.
    uint256 public constant GRACE = 7 days;

    StipendPool public immutable pool;

    struct Slot {
        address lender; // who receives everything routed to this loanRef
    }

    struct Loan {
        address asset;
        uint256 principal;
        uint256 repaid;
        uint256 minRemaining;
        uint256 minRate;
        uint16 pledgeBps;
        uint64 expiry;
        uint256 agentPk;
        uint64 fundedAt;
        bool settled;
        address payoutTo;
        uint64 streamStart;
    }

    uint64 public nextLoanRef = 1;
    mapping(uint64 => Slot) public slots;
    mapping(uint64 => Loan) public loans;
    /// @notice Shares routed to a slot that could not be forwarded yet, by loan ref and asset.
    mapping(uint64 => mapping(address => uint256)) public owed;

    event SlotOpened(uint64 indexed loanRef, address indexed lender);
    event LoanFunded(uint64 indexed loanRef, address indexed lender, address indexed asset, uint256 principal, address payoutTo);
    event DripRouted(uint64 indexed loanRef, address indexed asset, uint256 amount, address indexed lender);
    /// @dev A routed share held here because the slot has no lender yet or the token refused the forward.
    event DripEscrowed(uint64 indexed loanRef, address indexed asset, uint256 amount);
    event DripCollected(uint64 indexed loanRef, address indexed asset, uint256 amount, address indexed lender);
    event LoanSettled(uint64 indexed loanRef);

    constructor(StipendPool _pool) {
        pool = _pool;
    }

    /// @notice Reserve a loanRef; the borrower pledges to (address(this), loanRef).
    function openSlot() external returns (uint64 loanRef) {
        loanRef = nextLoanRef++;
        slots[loanRef].lender = msg.sender;
        emit SlotOpened(loanRef, msg.sender);
    }

    /// @notice Fund a slot against a stream proof bound to it. The principal goes straight to `payoutTo`.
    /// The proof must name this slot, the loan asset and a stream that has already started, so the
    /// recorded terms describe a cashflow the lender can actually pull.
    function fund(
        uint64 loanRef,
        StipendPool.Proof calldata p,
        StipendPool.StreamArgs calldata a,
        address asset,
        uint256 principal,
        address payoutTo
    ) external nonReentrant {
        require(slots[loanRef].lender == msg.sender, "not the lender");
        require(loans[loanRef].fundedAt == 0, "already funded");
        require(a.lenderAddr == address(this) && a.loanRef == loanRef, "proof not for this slot");
        require(a.asset == asset, "proof names another asset");
        require(uint256(a.streamStart) <= block.timestamp, "stream not started");
        require(payoutTo != address(0), "payout");
        require(pool.verifyStream(p, a), "invalid stream proof");
        loans[loanRef] = Loan({
            asset: asset,
            principal: principal,
            repaid: 0,
            minRemaining: a.minRemaining,
            minRate: a.minRate,
            pledgeBps: a.pledgeBps,
            expiry: a.expiry,
            agentPk: a.agentPk,
            fundedAt: uint64(block.timestamp),
            settled: false,
            payoutTo: payoutTo,
            streamStart: a.streamStart
        });
        IERC20(asset).safeTransferFrom(msg.sender, payoutTo, principal);
        emit LoanFunded(loanRef, msg.sender, asset, principal, payoutTo);
    }

    /// @notice Called by the pool after it transferred a routed share here. Counts it as repayment
    /// when a loan in that asset exists, then forwards it to the slot's lender; what cannot be
    /// forwarded (no lender yet, token refused) is kept for `collect`. Never reverts for the pool.
    /// Not reentrancy-guarded on purpose: `claim` reaches here through the pool.
    function onPledge(address asset, uint256 amount, uint64 loanRef) external {
        require(msg.sender == address(pool), "not the pool");
        Loan storage loan = loans[loanRef];
        if (loan.fundedAt != 0 && loan.asset == asset) loan.repaid += amount;
        address lender = slots[loanRef].lender;
        if (lender != address(0) && asset.tryTransfer(lender, amount)) {
            emit DripRouted(loanRef, asset, amount, lender);
        } else {
            owed[loanRef][asset] += amount;
            emit DripEscrowed(loanRef, asset, amount);
        }
    }

    /// @notice The slot's lender takes the shares held here for it.
    function collect(uint64 loanRef, address asset) external nonReentrant {
        address lender = slots[loanRef].lender;
        require(lender == msg.sender, "not the lender");
        uint256 amount = owed[loanRef][asset];
        require(amount > 0, "nothing owed");
        owed[loanRef][asset] = 0;
        IERC20(asset).safeTransfer(lender, amount);
        emit DripCollected(loanRef, asset, amount, lender);
    }

    /// @notice The lender pulls its vested share: a claim spend proved off-chain, submitted through this
    /// contract so the pool's `msg.sender == lenderAddr` rule holds. The share arrives via `onPledge`.
    function claim(uint64 loanRef, StipendPool.Proof calldata p, StipendPool.SpendArgs calldata a, StipendPool.SpendExtData calldata e)
        external
        nonReentrant
    {
        require(slots[loanRef].lender == msg.sender, "not the lender");
        require(a.isLenderClaim && a.lenderAddr == address(this) && a.loanRef == loanRef, "not a claim for this slot");
        pool.spend(p, a, e);
    }

    /// @notice The lender closes the loan; no shortfall can be reported afterwards.
    function settle(uint64 loanRef) external {
        require(slots[loanRef].lender == msg.sender, "not the lender");
        require(loans[loanRef].fundedAt != 0, "no loan");
        loans[loanRef].settled = true;
        emit LoanSettled(loanRef);
    }

    /// @notice Unpaid principal once the allowance's expiry plus GRACE has passed; 0 otherwise.
    /// An allowance that never expires (expiry 0) has no due date and never reports a shortfall.
    function shortfall(uint64 loanRef) external view returns (uint256) {
        Loan storage loan = loans[loanRef];
        if (loan.fundedAt == 0 || loan.settled || loan.expiry == 0) return 0;
        if (block.timestamp <= uint256(loan.expiry) + GRACE) return 0;
        if (loan.repaid >= loan.principal) return 0;
        return loan.principal - loan.repaid;
    }
}
