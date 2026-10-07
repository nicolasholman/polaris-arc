/**
 * EIP-712 domains and struct types for every signature Polaris uses, field for
 * field with the contracts' typehash strings.
 *
 * One source for the deploy script (which writes them into
 * deployments/<network>.json), the test suites, the local end-to-end run, and
 * any client that wants them without reading Solidity. `test/metropolis/
 * Eip712.test.js` rebuilds each preimage from these field lists and checks it
 * against the contract's typehash constant, so the two cannot drift.
 *
 * Field order matters: EIP-712 hashes fields in declaration order.
 */

"use strict";

const AUTHORIZATION_FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

/** Struct types, grouped by the contract whose domain signs them. */
const TYPES = {
  // Domain: name "PolarisCheckout", version "1".
  PolarisCheckout: {
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
  // Domain: the token's own. Real AUSD is name "Agora Dollar", version "1";
  // MockAUSD uses the same name and version. Read it with eip712Domain().
  Stablecoin: {
    ReceiveWithAuthorization: AUTHORIZATION_FIELDS,
    TransferWithAuthorization: AUTHORIZATION_FIELDS,
    // ERC-2612. Signed for PolarisCheckout.openPlan and .reauthorize (spender:
    // PolarisLoanEngine, value: everything the buyer owes it) and .subscribe
    // (spender: PolarisPayments). reauthorize checks it against the token's
    // DOMAIN_SEPARATOR itself; no Polaris-domain message is involved.
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  // Domain: name "PolarisLoanEngine", version "1".
  PolarisLoanEngine: {
    RepayIntent: [
      { name: "loanId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "expectedRepaid", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  // Domain: name "PolarisPayments", version "1".
  PolarisPayments: {
    CancelSubscription: [
      { name: "subId", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  // Domain: name "PolarisSend", version "1".
  PolarisSend: {
    Open: [
      { name: "sender", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "expiresAt", type: "uint64" },
    ],
    Claim: [
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    Cancel: [
      { name: "linkKey", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
  },
  // Domain: name "PolarisSplit", version "1". A friend pays a share with the
  // stablecoin's ReceiveWithAuthorization (nonce PolarisSplit.shareNonce).
  PolarisSplit: {
    CreateSplit: [
      { name: "organiser", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "amounts", type: "uint128[]" },
      { name: "memoHash", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "deadline", type: "uint256" },
    ],
    CloseSplit: [
      { name: "splitId", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  },
  // Domain: name "CollateralVault", version "1". Take collateral out through a
  // relayer (withdrawWithSig); nonce is CollateralVault.nonces(borrower).
  // Absent from a vault that predates it (Monad testnet's of 28 Sep 2026).
  CollateralVault: {
    Withdraw: [
      { name: "borrower", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  // Domain: name "MerchantRegistry", version "1".
  MerchantRegistry: {
    Registration: [
      { name: "merchant", type: "address" },
      { name: "name", type: "string" },
      { name: "payoutAddress", type: "address" },
      { name: "metadataURI", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    PayoutUpdate: [
      { name: "merchant", type: "address" },
      { name: "payoutAddress", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
};

/** The EIP-712 domain name and version each Polaris contract is constructed with. */
const DOMAIN_NAMES = {
  PolarisCheckout: { name: "PolarisCheckout", version: "1" },
  PolarisLoanEngine: { name: "PolarisLoanEngine", version: "1" },
  PolarisPayments: { name: "PolarisPayments", version: "1" },
  PolarisSend: { name: "PolarisSend", version: "1" },
  PolarisSplit: { name: "PolarisSplit", version: "1" },
  MerchantRegistry: { name: "MerchantRegistry", version: "1" },
  CollateralVault: { name: "CollateralVault", version: "1" },
};

/** The real AUSD domain name and version (docs/research/ausd.md section 4.2). */
const AUSD_DOMAIN_NAME = { name: "Agora Dollar", version: "1" };

/**
 * The typehash preimage for a single-struct type (none of ours nest; an
 * array of atoms, CreateSplit's `uint128[] amounts`, is not a nested struct), e.g.
 * "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)".
 */
function typeString(primaryType, fields) {
  return `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

/** Read a contract's EIP-712 domain (ERC-5267), dropping fields it does not use. */
async function readDomain(contract) {
  const d = await contract.eip712Domain();
  // fields bit mask: 0x01 name, 0x02 version, 0x04 chainId, 0x08 verifyingContract, 0x10 salt.
  // Real AUSD reports 0x0f; passing its zero salt through breaks signatures.
  const fields = Number(d.fields);
  const domain = {};
  if (fields & 0x01) domain.name = d.name;
  if (fields & 0x02) domain.version = d.version;
  if (fields & 0x04) domain.chainId = d.chainId;
  if (fields & 0x08) domain.verifyingContract = d.verifyingContract;
  if (fields & 0x10) domain.salt = d.salt;
  return domain;
}

/** JSON-safe form of a domain (bigint chain id as a number). */
function domainJson(domain) {
  return { ...domain, chainId: domain.chainId === undefined ? undefined : Number(domain.chainId) };
}

module.exports = { TYPES, DOMAIN_NAMES, AUSD_DOMAIN_NAME, typeString, readDomain, domainJson };
