// EIP-712 signing helpers shared by the Metropolis test suites.
//
// Every user action in Polaris is a signature that a relayer submits, so the
// tests sign exactly what a Mera or Privy account would sign in the app. The
// domain is always read from the verifying contract (ERC-5267) rather than
// rebuilt by hand: that is what the app has to do against real AUSD, whose
// name and version we do not control.

const { ethers } = require("hardhat");

const MAX_UINT = ethers.MaxUint256;

async function domainOf(contract) {
  const d = await contract.eip712Domain();
  return {
    name: d.name,
    version: d.version,
    chainId: d.chainId,
    verifyingContract: d.verifyingContract,
  };
}

async function signTyped(signer, contract, types, value) {
  const signature = await signer.signTypedData(await domainOf(contract), types, value);
  // Signature exposes v/r/s as prototype getters, so spreading it copies
  // nothing; read them out explicitly.
  const sig = ethers.Signature.from(signature);
  return { signature, v: sig.v, r: sig.r, s: sig.s };
}

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const AUTH_FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

/** ERC-2612 permit. Returns { v, r, s, deadline, value }. */
async function signPermit(token, owner, spender, value, deadline = MAX_UINT) {
  const nonce = await token.nonces(owner.address);
  const sig = await signTyped(owner, token, PERMIT_TYPES, {
    owner: owner.address,
    spender,
    value,
    nonce,
    deadline,
  });
  return { ...sig, deadline, value };
}

async function signAuthorization(kind, token, from, to, value, nonce, opts = {}) {
  const validAfter = opts.validAfter ?? 0n;
  const validBefore = opts.validBefore ?? MAX_UINT;
  const sig = await signTyped(from, token, { [kind]: AUTH_FIELDS }, {
    from: from.address,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  });
  return { ...sig, validAfter, validBefore, nonce, value };
}

/** ERC-3009 receiveWithAuthorization: the payee must be the caller. */
function signReceive(token, from, to, value, nonce, opts) {
  return signAuthorization("ReceiveWithAuthorization", token, from, to, value, nonce, opts);
}

/** ERC-3009 transferWithAuthorization: anyone may submit it. */
function signTransfer(token, from, to, value, nonce, opts) {
  return signAuthorization("TransferWithAuthorization", token, from, to, value, nonce, opts);
}

/** The payment id PolarisPayments derives, and uses as the ERC-3009 nonce. */
function paymentId(merchant, orderId) {
  return ethers.solidityPackedKeccak256(["address", "string"], [merchant, orderId]);
}

module.exports = {
  MAX_UINT,
  domainOf,
  signTyped,
  signPermit,
  signReceive,
  signTransfer,
  paymentId,
};
