// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev An ERC-20 transfer that reports failure instead of reverting, so a
/// receiver the token refuses (blacklist, reverting hook) cannot block the
/// caller. Return data is read as SafeERC20 does: none means success for a
/// contract, otherwise the word must be exactly 1.
library TryERC20 {
    function tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        if (token.code.length == 0) return false;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (data.length == 0) return true;
        if (data.length < 32) return false;
        uint256 word;
        assembly {
            word := mload(add(data, 32))
        }
        return word == 1;
    }
}
