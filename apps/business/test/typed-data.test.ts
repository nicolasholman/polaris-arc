import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { DOMAIN_NAMES, TYPES } from "@/server/relayer/typed-data";
import { TRANSFER_WITH_AUTHORIZATION_FIELDS } from "@/server/policy/payout";

const require = createRequire(import.meta.url);
// The contracts' own list, which their tests check against every typehash on chain.
const contracts = require("@polarispay/contracts/lib/eip712") as {
  TYPES: Record<string, Record<string, Array<{ name: string; type: string }>>>;
  DOMAIN_NAMES: Record<string, { name: string; version: string }>;
};

describe("EIP-712 structs the relayer verifies", () => {
  it("match packages/contracts/lib/eip712.js field for field", () => {
    const flat: Record<string, unknown> = {};
    for (const group of Object.values(contracts.TYPES)) Object.assign(flat, group);
    for (const [primary, types] of Object.entries(TYPES)) {
      expect(types[primary as keyof typeof types], primary).toEqual(flat[primary]);
    }
    expect(Object.keys(TYPES).sort()).toEqual(Object.keys(flat).sort());
  });

  it("use each contract's own domain name", () => {
    expect(DOMAIN_NAMES.checkout).toBe(contracts.DOMAIN_NAMES.PolarisCheckout?.name);
    expect(DOMAIN_NAMES.loanEngine).toBe(contracts.DOMAIN_NAMES.PolarisLoanEngine?.name);
    expect(DOMAIN_NAMES.payments).toBe(contracts.DOMAIN_NAMES.PolarisPayments?.name);
    expect(DOMAIN_NAMES.send).toBe(contracts.DOMAIN_NAMES.PolarisSend?.name);
    expect(DOMAIN_NAMES.split).toBe(contracts.DOMAIN_NAMES.PolarisSplit?.name);
    expect(DOMAIN_NAMES.registry).toBe(contracts.DOMAIN_NAMES.MerchantRegistry?.name);
    expect(DOMAIN_NAMES.vault).toBe(contracts.DOMAIN_NAMES.CollateralVault?.name);
  });

  it("sign automatic payouts with the token's own TransferWithAuthorization", () => {
    expect([...TRANSFER_WITH_AUTHORIZATION_FIELDS]).toEqual(contracts.TYPES.Stablecoin?.TransferWithAuthorization);
  });
});
