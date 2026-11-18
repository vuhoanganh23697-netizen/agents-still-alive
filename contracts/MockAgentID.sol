// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test-only stand-in for the Binance Agent ID contract.
/// @dev NOT part of the production dApp. Used by the Hardhat test suite, and
///      handy for a BSC *testnet* rehearsal: deploy this on testnet, `mint`
///      an Agent ID to your test wallet, then deploy StillAlive with this
///      contract's address as the constructor argument. On BSC mainnet,
///      always use the real Agent ID contract instead:
///      0x60b9262456de011f7d15a54cdd8c48baaa8b022f
contract MockAgentID {
    mapping(address => uint256) private _balances;

    /// @notice Give `to` one (more) fake Agent ID. Permissionless on purpose —
    ///         this contract must never be deployed to mainnet.
    function mint(address to) external {
        _balances[to] += 1;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }
}
