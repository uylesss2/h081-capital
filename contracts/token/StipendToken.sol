// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title StipendToken
/// @notice H0.81 Capital (H081): a plain ERC-20 with 18 decimals. The whole supply is
/// minted once, to the deployer, in the constructor. There is no mint afterwards, no
/// owner, no pause and no upgrade. Not deployed anywhere by this repository.
contract StipendToken is ERC20 {
    constructor(uint256 supply) ERC20("H0.81 Capital", "H081") {
        require(supply > 0, "supply");
        _mint(msg.sender, supply);
    }
}
