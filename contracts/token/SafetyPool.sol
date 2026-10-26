// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {StreamLoan} from "../lending/StreamLoan.sol";

/// @title SafetyPool
/// @notice Stakers pool H081 to insure lenders against a stream-backed loan that is not
/// repaid. A lender binds its loan to the pool with `insure` and pays a premium into it.
/// Once the StreamLoan registry reports a shortfall (expiry plus grace passed, repaid
/// below principal, not settled), anyone may `slash`: the pool pays the lender
/// `min(shortfall, pool balance)` in H081, valued 1:1 in base units for v1, and the cover
/// is marked paid. The shortfall is chain state produced by the circuit's routing, so no
/// oracle decides. Stakers hold shares of the pool; premiums raise the share price and
/// slashes lower it. Leaving takes a 14-day unbonding during which the shares stay at
/// risk. A slash that empties the pool retires every share; the next deposit starts a
/// fresh pool. No owner.
contract SafetyPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Time between an unbond request and the tokens leaving.
    uint256 public constant COOLDOWN = 14 days;

    IERC20 public immutable token;
    StreamLoan public immutable streamLoan;

    struct Position {
        uint256 shares; // at risk, redeemable after unbonding
        uint256 unbonding; // shares waiting for the cooldown, still at risk
        uint64 readyAt; // when `withdraw` may run
        uint64 gen; // the pool generation these figures belong to
    }

    struct Cover {
        address lender; // who the slash pays
        uint256 premium;
        uint64 boundAt; // 0 while not insured
        bool paid;
        uint256 paidOut;
    }

    /// @notice Shares outstanding in the current generation.
    uint256 public totalShares;
    /// @notice Bumped when a slash empties the pool; shares of an older generation are worth nothing.
    uint64 public generation;
    mapping(address => Position) private positions;
    /// @notice Cover by loan ref.
    mapping(uint64 => Cover) public covers;

    event Deposited(address indexed account, uint256 amount, uint256 shares);
    event UnbondRequested(address indexed account, uint256 shares, uint64 readyAt);
    event Withdrawn(address indexed account, uint256 shares, uint256 amount);
    event Insured(uint64 indexed loanRef, address indexed lender, uint256 premium);
    event Slashed(uint64 indexed loanRef, address indexed lender, uint256 shortfall, uint256 paid);
    event PoolRetired(uint64 generation);

    constructor(IERC20 _token, StreamLoan _streamLoan) {
        token = _token;
        streamLoan = _streamLoan;
    }

    // ---- views ----

    /// @notice H081 held by the pool.
    function poolBalance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Shares `account` holds at risk, excluding those unbonding.
    function sharesOf(address account) public view returns (uint256) {
        Position storage p = positions[account];
        return p.gen == generation ? p.shares : 0;
    }

    /// @notice Shares `account` has unbonding and when they may leave.
    function unbondingOf(address account) external view returns (uint256 shares, uint64 readyAt) {
        Position storage p = positions[account];
        return p.gen == generation ? (p.unbonding, p.readyAt) : (0, 0);
    }

    /// @notice H081 that `shares` redeem for now.
    function redeemable(uint256 shares) public view returns (uint256) {
        return totalShares == 0 ? 0 : (shares * poolBalance()) / totalShares;
    }

    // ---- stakers ----

    /// @notice Put `amount` H081 at risk; shares are minted at the current price.
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "amount");
        uint256 balance = poolBalance();
        uint256 shares = totalShares == 0 || balance == 0 ? amount : (amount * totalShares) / balance;
        require(shares > 0, "too small");
        Position storage p = _position(msg.sender);
        p.shares += shares;
        totalShares += shares;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount, shares);
    }

    /// @notice Start the cooldown on `shares`. They stay at risk until withdrawn.
    function requestUnbond(uint256 shares) external {
        require(shares > 0, "shares");
        Position storage p = _position(msg.sender);
        require(shares <= p.shares, "more than held");
        p.shares -= shares;
        p.unbonding += shares;
        p.readyAt = uint64(block.timestamp + COOLDOWN);
        emit UnbondRequested(msg.sender, shares, p.readyAt);
    }

    /// @notice Redeem the unbonding shares at today's price, once the cooldown has passed.
    function withdraw() external nonReentrant {
        Position storage p = _position(msg.sender);
        uint256 shares = p.unbonding;
        require(shares > 0, "nothing unbonding");
        require(block.timestamp >= p.readyAt, "cooldown");
        uint256 amount = redeemable(shares);
        p.unbonding = 0;
        p.readyAt = 0;
        totalShares -= shares;
        if (amount > 0) token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, shares, amount);
    }

    // ---- lenders ----

    /// @notice The slot's lender binds its funded, unexpired loan to the pool and pays `premium` in.
    function insure(uint64 loanRef, uint256 premium) external nonReentrant {
        address lender = streamLoan.slots(loanRef);
        require(lender == msg.sender, "not the lender");
        (, , , , , , uint64 expiry, , uint64 fundedAt, bool settled, , ) = streamLoan.loans(loanRef);
        require(fundedAt != 0, "no loan");
        require(!settled, "settled");
        require(expiry != 0, "no due date");
        require(block.timestamp <= expiry, "expired");
        require(covers[loanRef].boundAt == 0, "already insured");
        covers[loanRef] = Cover({lender: lender, premium: premium, boundAt: uint64(block.timestamp), paid: false, paidOut: 0});
        if (premium > 0) token.safeTransferFrom(msg.sender, address(this), premium);
        emit Insured(loanRef, lender, premium);
    }

    /// @notice Anyone: pay the lender of an insured loan the registry's shortfall, capped by the pool.
    function slash(uint64 loanRef) external nonReentrant {
        Cover storage c = covers[loanRef];
        require(c.boundAt != 0, "not insured");
        require(!c.paid, "already paid");
        uint256 shortfall = streamLoan.shortfall(loanRef);
        require(shortfall > 0, "no shortfall");
        uint256 balance = poolBalance();
        require(balance > 0, "pool empty");
        uint256 pay = shortfall < balance ? shortfall : balance;
        c.paid = true;
        c.paidOut = pay;
        token.safeTransfer(c.lender, pay);
        emit Slashed(loanRef, c.lender, shortfall, pay);
        if (pay == balance && totalShares > 0) {
            totalShares = 0;
            generation += 1;
            emit PoolRetired(generation);
        }
    }

    // ---- internal ----

    /// @dev The caller's position in the current generation; an older one is worthless and reset.
    function _position(address account) private returns (Position storage p) {
        p = positions[account];
        if (p.gen != generation) {
            p.shares = 0;
            p.unbonding = 0;
            p.readyAt = 0;
            p.gen = generation;
        }
    }
}
