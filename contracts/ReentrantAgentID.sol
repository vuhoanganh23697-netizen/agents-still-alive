// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice SECURITY-TEST-ONLY stand-in for the Agent ID contract.
/// @dev NOT part of the production dApp — never deploy this anywhere real.
///      It behaves like MockAgentID, except its `balanceOf` tries to reenter
///      StillAlive.sign() (as itself) the first time it is called while
///      "armed". The test suite uses it to prove that the Agent ID gate —
///      a read-only (STATICCALL) call to a fixed, immutable contract — cannot
///      be abused to corrupt StillAlive state mid-transaction.
interface IStillAliveLike {
    function sign(string calldata status) external;
}

contract ReentrantAgentID {
    mapping(address => uint256) private _balances;

    address public target;
    bool public armed;

    function mint(address to) external {
        _balances[to] += 1;
    }

    function arm(address target_) external {
        target = target_;
        armed = true;
    }

    /// @dev Deliberately NOT declared `view`: StillAlive calls balanceOf via a
    ///      view interface (STATICCALL), so any state write attempted from
    ///      this reentrant path runs in a static frame and must fail. (The
    ///      probe fires only for foreign owners — a latch flag would itself
    ///      need an SSTORE, which the static frame forbids; when the
    ///      reentrant sign() gates on balanceOf(address(this)) the probe
    ///      stays quiet and the sign dies at its first SSTORE instead.)
    function balanceOf(address owner) external returns (uint256) {
        if (armed && owner != address(this)) {
            try IStillAliveLike(target).sign("reentrant") {} catch {}
        }
        return _balances[owner];
    }
}
