/**
 * Automatic payouts, locked to one address (docs/research/privy.md §6).
 *
 * Our payout signer (a Privy key quorum whose private key the server holds)
 * is added to the merchant's embedded wallet with this as its override
 * policy. So the only thing our server can ever get that wallet to sign is an
 * AUSD `TransferWithAuthorization` on this chain, from the merchant's own
 * wallet, to the payout address the merchant chose, up to a per-payout cap.
 * Every other method has no rule, and Privy denies unmatched requests. The
 * relayer then submits the authorisation, so the merchant never holds MON.
 *
 * Plain, erasable TypeScript: the setup scripts import it too.
 */

import type { Address } from "viem";

import { bothCases, type PrivyPolicy } from "./relayer.ts";

export const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export const TRANSFER_WITH_AUTHORIZATION_FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/**
 * The `types` map the sweep signs with, EIP712Domain included. Privy
 * evaluates a typed-data condition only when the request's `types` equal the
 * policy's exactly, so both sides use this one constant.
 */
export const TWA_TYPES = {
  EIP712Domain: EIP712_DOMAIN_FIELDS.map((f) => ({ ...f })),
  TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_FIELDS.map((f) => ({ ...f })),
};

/** Per-payout cap: $10,000 at 6 decimals. */
export const DEFAULT_PAYOUT_CAP_UNITS = 10_000n * 1_000_000n;

export function buildPayoutPolicy(input: {
  merchantKey: string;
  payoutAddress: Address;
  stablecoin: Address;
  chainId: number;
  capUnits?: bigint;
}): PrivyPolicy {
  const message = (field: string, operator: "eq" | "in" | "lte", value: string | string[]) => ({
    field_source: "ethereum_typed_data_message",
    typed_data: { types: TWA_TYPES, primary_type: "TransferWithAuthorization" },
    field,
    operator,
    value,
  });
  return {
    version: "1.0",
    name: `payout-${input.merchantKey.replace(/^did:privy:/, "")}`.slice(0, 50),
    chain_type: "ethereum",
    rules: [
      {
        name: "AUSD to the payout address only",
        method: "eth_signTypedData_v4",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: String(input.chainId) },
          { field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "in", value: bothCases(input.stablecoin) },
          message("to", "in", bothCases(input.payoutAddress)),
          message("from", "eq", "{{wallet.address}}"),
          message("value", "lte", (input.capUnits ?? DEFAULT_PAYOUT_CAP_UNITS).toString()),
        ],
      },
    ],
  };
}
