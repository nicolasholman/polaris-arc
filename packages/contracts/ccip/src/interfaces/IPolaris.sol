// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// The Polaris calls PolarisCCIPReceiver makes on Arc.
interface IPolarisPaymentsLike {
    function pay(address merchant, uint256 amount, string calldata orderId) external returns (bytes32 paymentId);
}

interface IPolarisLoanEngineLike {
    function collectInstallment(uint256 loanId) external returns (uint256 collected);
    function isInstallmentDue(uint256 loanId) external view returns (bool);
}
