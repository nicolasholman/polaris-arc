import {
  type Address,
  getAddress,
  domainSeparator,
  type Hex,
  type PublicClient,
  type TypedDataDomain,
} from "viem";
import { getEip712Domain, readContract } from "viem/actions";

/**
 * EIP-712 domains are never written by hand. Polaris for Business reports
 * every one the app signs under (`network.ts`, from the deployment record);
 * the few read here come from the verifying contract itself. Circle's USDC
 * and EURC name and version their own domains ("USDC"/"EURC", version "2"),
 * and our own contracts' domains include their deployed address and chain.
 */
export type Eip712Domain = {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: Address;
  salt?: Hex;
};

/** ERC-5267 `fields` bits: which domain members the contract actually uses. */
const FIELD = { name: 0x01, version: 0x02, chainId: 0x04, verifyingContract: 0x08, salt: 0x10 } as const;

/** Drops the members a contract's `fields` bitmap says it doesn't use. */
export function domainFromErc5267(
  raw: { name: string; version: string; chainId: number; verifyingContract: Address; salt: Hex },
  fields: Hex,
): Eip712Domain {
  const bits = Number.parseInt(fields, 16);
  const domain: Eip712Domain = {};
  if (bits & FIELD.name) domain.name = raw.name;
  if (bits & FIELD.version) domain.version = raw.version;
  if (bits & FIELD.chainId) domain.chainId = raw.chainId;
  if (bits & FIELD.verifyingContract) domain.verifyingContract = getAddress(raw.verifyingContract);
  if (bits & FIELD.salt) domain.salt = raw.salt;
  return domain;
}

const legacyAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/**
 * A token's EIP-712 domain, without ERC-5267. Circle's USDC and EURC don't
 * implement `eip712Domain()`, so the domain is rebuilt from `name()`,
 * `version()` (default "1"), the chain and the token's address, and accepted
 * only if it hashes to the token's own `DOMAIN_SEPARATOR()`. A wrong domain
 * would make every signature fail on chain, so a mismatch throws instead of
 * signing something useless.
 */
export async function readTokenDomain(client: PublicClient, token: Address): Promise<Eip712Domain> {
  const [name, version, separator, chainId] = await Promise.all([
    readContract(client, { address: token, abi: legacyAbi, functionName: "name" }),
    readContract(client, { address: token, abi: legacyAbi, functionName: "version" }).catch(() => "1"),
    readContract(client, { address: token, abi: legacyAbi, functionName: "DOMAIN_SEPARATOR" }),
    client.getChainId(),
  ]);
  const domain: Eip712Domain = { name, version, chainId, verifyingContract: getAddress(token) };
  if (domainSeparator({ domain: domain as TypedDataDomain }) !== separator) {
    throw new Error(`Could not reconstruct the EIP-712 domain of ${token}`);
  }
  return domain;
}

/**
 * Reads a Polaris contract's EIP-712 domain with ERC-5267 `eip712Domain()`
 * (every Polaris contract implements it). Never call it on USDC or EURC,
 * which don't: use the domain Polaris for Business reports, or
 * `readTokenDomain`.
 */
export async function readDomain(client: PublicClient, verifyingContract: Address): Promise<Eip712Domain> {
  const { domain, fields, extensions } = await getEip712Domain(client, { address: verifyingContract });
  if (extensions.length > 0) throw new Error("EIP-712 domain extensions are not supported");
  return domainFromErc5267(
    {
      name: domain.name,
      version: domain.version,
      chainId: Number(domain.chainId),
      verifyingContract: domain.verifyingContract,
      salt: domain.salt,
    },
    fields,
  );
}
