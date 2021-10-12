// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.6;

contract MockStakingContract {
    mapping(address => uint256) private _balances;
    mapping(address => uint256) private _votes;

    function setBalanceOf(address account, uint256 balance) public {
        _balances[account] = balance;
    }

    function setVotes(address account, uint256 votes) public {
        _votes[account] = votes;
    }

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function getVotes(address account) external view returns (uint256) {
        return _votes[account];
    }
}
