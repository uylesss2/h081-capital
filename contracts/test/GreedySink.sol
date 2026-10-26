// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IPledgeSink} from "../lending/IPledgeSink.sol";

/// @dev A pledge sink that burns every unit of gas it is given. Exists only to
/// show that a lender contract cannot make a pledged spend cost the whole block.
contract GreedySink is IPledgeSink {
    uint256 public calls;

    function onPledge(address, uint256, uint64) external {
        while (true) {
            calls++;
        }
    }
}
