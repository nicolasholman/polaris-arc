import { Interface, Signature, TypedDataEncoder, getAddress, keccak256, solidityPacked, verifyTypedData } from "ethers";

import { PolarisError } from "../errors.js";
import type { Address, Eip1193Provider, Hex } from "../types.js";
import { ethCall } from "./wallet.js";

/**
 * ERC-3009 `ReceiveWithAuthorization` for PolarisPayments.payWithAuthorization.
 *
 * The nonce isn't random: the contract derives it as the payment id,
 * keccak256(abi.encodePacked(merchant, orderId)), and hands that to the token.
 * The buyer's signature covers the nonce, so it commits to this merchant and
 * this order. A relayer that swaps either changes the nonce and the token
 * rejects the signature: it can carry the payment, never redirect it.
 */

export const PAYMENTS_ABI = [
  "function payWithAuthorization(address payer, address merchant, uint256 amount, string orderId, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s) returns (bytes32)",
  "function paymentFor(address merchant, string orderId) view returns (tuple(address payer, address merchant, uint128 amount, uint64 paidAt))",
  "function quotedAmount(address merchant, bytes32 paymentId) view returns (uint256)",
  "event PaymentMade(bytes32 indexed paymentId, address indexed payer, address indexed merchant, uint256 amount, uint256 fee, string orderId)",
] as const;

export const TOKEN_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
] as const;

export const payments = new Interface(PAYMENTS_ABI);
export const token = new Interface(TOKEN_ABI);

/** EIP-712 field lists, field for field with Circle's FiatToken and Agora's AUSD. */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type Eip712Domain = {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: Address;
  salt?: Hex;
};

/** The ERC-3009 nonce and PolarisPayments payment id for an order: keccak256(abi.encodePacked(merchant, orderId)). */
export function paymentId(merchant: string, orderId: string): Hex {
  return keccak256(solidityPacked(["address", "string"], [getAddress(merchant), orderId])) as Hex;
}

/** ERC-5267 `fields` bits: which domain members the contract uses. */
const FIELD = { name: 0x01, version: 0x02, chainId: 0x04, verifyingContract: 0x08, salt: 0x10 } as const;

/**
 * Keep only the domain members a contract's `fields` bitmap says it uses.
 * AUSD reports `salt = 0x00…00` but its bitmap (0x0f) excludes it; signing
 * with the salt included is rejected.
 */
export function domainFromErc5267(
  raw: { name: string; version: string; chainId: bigint | number; verifyingContract: string; salt: string },
  fields: string,
): Eip712Domain {
  const bits = Number.parseInt(fields, 16);
  const domain: Eip712Domain = {};
  if (bits & FIELD.name) domain.name = raw.name;
  if (bits & FIELD.version) domain.version = raw.version;
  if (bits & FIELD.chainId) domain.chainId = Number(raw.chainId);
  if (bits & FIELD.verifyingContract) domain.verifyingContract = getAddress(raw.verifyingContract) as Address;
  if (bits & FIELD.salt) domain.salt = raw.salt as Hex;
  return domain;
}

/**
 * Read a token's EIP-712 domain from the token, never from a guess.
 *
 * ERC-5267 first. Failing that, rebuild it from `name()`, `version()` (default
 * "1"), the chain and the address, and accept it only if it hashes to the
 * token's own `DOMAIN_SEPARATOR()`. AUSD's `name()` is "AUSD" but its domain
 * name is "Agora Dollar", which is exactly the mistake this refuses to make.
 */
export async function readDomain(provider: Eip1193Provider, verifyingContract: string, chainId: number): Promise<Eip712Domain> {
  try {
    const out = await ethCall(provider, verifyingContract, token.encodeFunctionData("eip712Domain"));
    const [fields, name, version, cid, contract, salt, extensions] = token.decodeFunctionResult("eip712Domain", out);
    if ((extensions as unknown[]).length > 0) throw new Error("EIP-712 domain extensions are not supported");
    return domainFromErc5267(
      { name: name as string, version: version as string, chainId: cid as bigint, verifyingContract: contract as string, salt: salt as string },
      fields as string,
    );
  } catch (erc5267Error) {
    const call = async (fn: "name" | "version" | "DOMAIN_SEPARATOR") =>
      token.decodeFunctionResult(fn, await ethCall(provider, verifyingContract, token.encodeFunctionData(fn)))[0] as string;
    let name: string;
    let separator: string;
    try {
      [name, separator] = await Promise.all([call("name"), call("DOMAIN_SEPARATOR")]);
    } catch {
      throw new PolarisError(`Couldn't read the EIP-712 domain of ${verifyingContract}.`, {
        type: "wallet_error",
        code: "domain_unreadable",
        cause: erc5267Error,
      });
    }
    const version = await call("version").catch(() => "1");
    const domain: Eip712Domain = { name, version, chainId, verifyingContract: getAddress(verifyingContract) as Address };
    if (TypedDataEncoder.hashDomain(domain) !== separator) {
      throw new PolarisError(`Couldn't reconstruct the EIP-712 domain of ${verifyingContract}; refusing to sign against a guess.`, {
        type: "wallet_error",
        code: "domain_mismatch",
      });
    }
    return domain;
  }
}

export type Authorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

const DOMAIN_FIELD_TYPES: Record<keyof Eip712Domain, string> = {
  name: "string",
  version: "string",
  chainId: "uint256",
  verifyingContract: "address",
  salt: "bytes32",
};
const DOMAIN_ORDER: Array<keyof Eip712Domain> = ["name", "version", "chainId", "verifyingContract", "salt"];

/**
 * The exact JSON `eth_signTypedData_v4` takes: the EIP712Domain type lists
 * only the members present, numbers are decimal strings.
 */
export function receiveWithAuthorizationTypedData(domain: Eip712Domain, message: Authorization) {
  const domainType = DOMAIN_ORDER.filter((k) => domain[k] !== undefined).map((k) => ({ name: k, type: DOMAIN_FIELD_TYPES[k] }));
  return {
    types: { EIP712Domain: domainType, ...RECEIVE_WITH_AUTHORIZATION_TYPES },
    primaryType: "ReceiveWithAuthorization" as const,
    domain,
    message: {
      from: message.from,
      to: message.to,
      value: message.value.toString(),
      validAfter: message.validAfter.toString(),
      validBefore: message.validBefore.toString(),
      nonce: message.nonce,
    },
  };
}

/** Ask the wallet to sign, then check the signature recovers to the payer before anything is sent. */
export async function signAuthorization(provider: Eip1193Provider, domain: Eip712Domain, message: Authorization): Promise<Hex> {
  const typedData = receiveWithAuthorizationTypedData(domain, message);
  const signature = (await provider.request({
    method: "eth_signTypedData_v4",
    params: [message.from, JSON.stringify(typedData)],
  })) as string;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new PolarisError("The wallet returned an invalid signature.", { type: "wallet_error", code: "invalid_signature" });
  }
  const signer = verifyTypedData(domain, RECEIVE_WITH_AUTHORIZATION_TYPES as never, typedData.message, signature);
  if (getAddress(signer) !== getAddress(message.from)) {
    throw new PolarisError("The wallet signed with a different account than the one paying.", {
      type: "wallet_error",
      code: "signer_mismatch",
    });
  }
  return Signature.from(signature).serialized as Hex;
}

/** Calldata for PolarisPayments.payWithAuthorization. */
export function encodePayWithAuthorization(args: {
  payer: string;
  merchant: string;
  amount: bigint;
  orderId: string;
  validAfter: bigint;
  validBefore: bigint;
  signature: string;
}): Hex {
  const sig = Signature.from(args.signature);
  return payments.encodeFunctionData("payWithAuthorization", [
    args.payer,
    args.merchant,
    args.amount,
    args.orderId,
    args.validAfter,
    args.validBefore,
    sig.v,
    sig.r,
    sig.s,
  ]) as Hex;
}
