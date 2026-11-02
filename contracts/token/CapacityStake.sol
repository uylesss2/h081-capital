// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CapacityStake
/// @notice Staked H081 buys capacity: desks (allowances an operator may run) and a
/// monthly shielding cap. Capacity is read by relayers and hosted endpoints, never by
/// the pool, so the pool's no-admin invariant is untouched. Leaving takes a 7-day
/// cooldown; the amount under cooldown no longer counts as capacity. No owner.
contract CapacityStake is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Staked H081 per desk.
    uint256 public constant DESK_UNIT = 100e18;
    /// @notice Staked H081 per shielding unit.
    uint256 public constant SHIELD_UNIT = 100e18;
    /// @notice USDG (6 decimals) per 30 days that one shielding unit allows.
    uint256 public constant SHIELD_PER_UNIT = 10_000e6;
    /// @notice Time between an unstake request and the tokens leaving.
    uint256 public constant COOLDOWN = 7 days;

    IERC20 public immutable token;

    struct Pending {
        uint256 amount; // waiting for the cooldown
        uint64 readyAt; // when `unstake` may run
    }

    /// @notice Stake that counts as capacity, by account.
    mapping(address => uint256) public staked;
    /// @notice Stake under cooldown, by account. A new request adds to it and restarts the cooldown.
    mapping(address => Pending) public pending;

    event Staked(address indexed account, uint256 amount);
    event UnstakeRequested(address indexed account, uint256 amount, uint64 readyAt);
    event Unstaked(address indexed account, uint256 amount);

    constructor(IERC20 _token) {
        token = _token;
    }

    /// @notice Lock `amount` H081; it counts as capacity at once.
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "amount");
        staked[msg.sender] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @notice Move `amount` out of capacity and into the cooldown.
    function requestUnstake(uint256 amount) external {
        require(amount > 0, "amount");
        require(amount <= staked[msg.sender], "more than staked");
        staked[msg.sender] -= amount;
        Pending storage p = pending[msg.sender];
        p.amount += amount;
        p.readyAt = uint64(block.timestamp + COOLDOWN);
        emit UnstakeRequested(msg.sender, amount, p.readyAt);
    }

    /// @notice Take back everything whose cooldown has passed.
    function unstake() external nonReentrant {
        Pending memory p = pending[msg.sender];
        require(p.amount > 0, "nothing pending");
        require(block.timestamp >= p.readyAt, "cooldown");
        delete pending[msg.sender];
        token.safeTransfer(msg.sender, p.amount);
        emit Unstaked(msg.sender, p.amount);
    }

    /// @notice Desks `account` may run.
    function deskCapacity(address account) external view returns (uint256) {
        return staked[account] / DESK_UNIT;
    }

    /// @notice USDG (6 decimals) `account` may shield per 30 days.
    function shieldCap(address account) external view returns (uint256) {
        return (staked[account] / SHIELD_UNIT) * SHIELD_PER_UNIT;
    }
}
