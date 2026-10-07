/**
 * EIP-712 structs the relayer verifies, field for field with the contracts
 * (packages/contracts/lib/eip712.js is the source; test/typed-data.test.ts
 * fails if these drift from it). Field order is part of the type hash.
 *
 * Plain, erasable TypeScript, shared with scripts.
 */

import type { Address } from "viem";

const AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export const TYPES = {
  PlanIntent: {
    PlanIntent: [
      { name: "buyer", type: "address" },
      { name: "merchant", type: "address" },
      { name: "principal", type: "uint256" },
      { name: "installments", type: "uint32" },
      { name: "interval", type: "uint64" },
      { name: "orderId", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  SubscribeIntent: {
    SubscribeIntent: [
      { name: "buyer", type: "address" },
      { name: "merchant", type: "address" },
      { name: "planId", type: "uint256" },
      { name: "pricePerPeriod", type: "uint256" },
      { name: "periodSeconds", type: "uint64" },
      { name: "orderId", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  ReceiveWithAuthorization: { ReceiveWithAuthorization: AUTHORIZATION },
  TransferWithAuthorization: { TransferWithAuthorization: AUTHORIZATION },
  Permit: {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  RepayIntent: {
    RepayIntent: [
      { name: "loanId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "expectedRepaid", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  CancelSubscription: {
    CancelSubscription: [
      { name: "subId", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  Open: {
    Open: [
      { name: "sender", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "expiresAt", type: "uint64" },
    ],
  },
  Claim: {
    Claim: [
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  },
  Cancel: {
    Cancel: [
      { name: "linkKey", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  },
  CreateSplit: {
    CreateSplit: [
      { name: "organiser", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "amounts", type: "uint128[]" },
      { name: "memoHash", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "deadline", type: "uint256" },
    ],
  },
  CloseSplit: {
    CloseSplit: [
      { name: "splitId", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  },
  Withdraw: {
    Withdraw: [
      { name: "borrower", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  Registration: {
    Registration: [
      { name: "merchant", type: "address" },
      { name: "name", type: "string" },
      { name: "payoutAddress", type: "address" },
      { name: "metadataURI", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  PayoutUpdate: {
    PayoutUpdate: [
      { name: "merchant", type: "address" },
      { name: "payoutAddress", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
} as const;

/** The domain each Polaris contract signs under (EIP712("<name>", "1")). */
export const DOMAIN_NAMES = {
  checkout: "PolarisCheckout",
  loanEngine: "PolarisLoanEngine",
  payments: "PolarisPayments",
  send: "PolarisSend",
  split: "PolarisSplit",
  registry: "MerchantRegistry",
  /** Only a vault with `withdrawWithSig` (relay.ts `vaultWithdrawDomain`); Monad testnet's of 28 Sep 2026 has none. */
  vault: "CollateralVault",
} as const;

export type Domain = { name: string; version: string; chainId: number; verifyingContract: Address };

export function polarisDomain(contract: keyof typeof DOMAIN_NAMES, chainId: number, verifyingContract: Address): Domain {
  return { name: DOMAIN_NAMES[contract], version: "1", chainId, verifyingContract };
}
