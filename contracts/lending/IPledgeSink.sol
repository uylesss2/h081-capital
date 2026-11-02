// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice A contract lender the pool tells about every routed share. The
/// tokens are already transferred when this runs; a revert is ignored and
/// the call gets at most `StipendPool.SINK_GAS` (300,000) gas, enough for a
/// ledger update, one ERC-20 forward and an event.
interface IPledgeSink {
    function onPledge(address asset, uint256 amount, uint64 loanRef) external;
}
