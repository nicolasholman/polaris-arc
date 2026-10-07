import { encodeFunctionData, erc20Abi, getAddress, zeroHash, type Address } from "viem";
import { describe, expect, it } from "vitest";

import { collateralVaultAbi, iausdAbi, merchantRegistryAbi, polarisCheckoutAbi, polarisLoanEngineAbi, polarisPaymentsAbi, polarisSendAbi, polarisSplitAbi } from "@polarispay/contracts/abi";
import { buildPayoutPolicy, TWA_TYPES } from "@/server/policy/payout";
import {
  buildRegistryAdminPolicy,
  buildRelayerPolicy,
  callsFor,
  checkRelayerCall,
  lintPolicy,
  PolicyViolation,
  RELAYER_CALLS,
  type RelayerAddresses,
} from "@/server/policy/relayer";

const addresses: RelayerAddresses = {
  checkout: "0x000000000000000000000000000000000000C4c1",
  payments: "0x0000000000000000000000000000000000009A01",
  send: "0x0000000000000000000000000000000000005E01",
  split: "0x0000000000000000000000000000000000005B11",
  loanEngine: "0x0000000000000000000000000000000000001E01",
  registry: "0x0000000000000000000000000000000000004E01",
  stablecoin: "0x00000000000000000000000000000000000A05D0",
  vault: "0x000000000000000000000000000000000000Ca01",
};
for (const k of Object.keys(addresses) as (keyof RelayerAddresses)[]) addresses[k] = getAddress(addresses[k] as Address);
const splitAddress = addresses.split as Address;
const expected = { chainId: 10143, addresses };
const someone = "0x1111111111111111111111111111111111111111" as Address;
const merchant = "0x2222222222222222222222222222222222222222" as Address;

const payData = encodeFunctionData({
  abi: polarisCheckoutAbi,
  functionName: "pay",
  args: [someone, merchant, 25_000_000n, "order-1", 0n, 2_000_000_000n, 27, zeroHash, zeroHash],
});

describe("the relayer's allow-list (checkRelayerCall)", () => {
  it("allows every listed call, and nothing else on those contracts", () => {
    expect(checkRelayerCall({ to: addresses.checkout, data: payData, value: 0n, chainId: 10143 }, expected)).toMatchObject({ contract: "checkout", functionName: "pay" });
    const repay = encodeFunctionData({ abi: polarisLoanEngineAbi, functionName: "repayWithSig", args: [1n, 1n, 0n, 2n, "0x"] });
    expect(checkRelayerCall({ to: addresses.loanEngine, data: repay, chainId: 10143 }, expected).functionName).toBe("repayWithSig");
    const claim = encodeFunctionData({ abi: polarisSendAbi, functionName: "claim", args: [someone, merchant, 1n, 27, zeroHash, zeroHash] });
    expect(checkRelayerCall({ to: addresses.send, data: claim, chainId: 10143 }, expected).functionName).toBe("claim");
    const twa = encodeFunctionData({ abi: iausdAbi, functionName: "transferWithAuthorization", args: [someone, merchant, 1n, 0n, 1n, zeroHash, 27, zeroHash, zeroHash] });
    expect(checkRelayerCall({ to: addresses.stablecoin, data: twa, chainId: 10143 }, expected).functionName).toBe("transferWithAuthorization");
  });

  it("allows a buyer's re-signed permit through PolarisCheckout.reauthorize, but never a bare AUSD permit", () => {
    const permit = { value: 201_530_000n, deadline: 2_000_000_000n, v: 27, r: zeroHash, s: zeroHash };
    const reauthorize = encodeFunctionData({ abi: polarisCheckoutAbi, functionName: "reauthorize", args: [someone, permit] });
    expect(checkRelayerCall({ to: addresses.checkout, data: reauthorize, chainId: 10143 }, expected)).toMatchObject({ contract: "checkout", functionName: "reauthorize" });
    expect(buildRelayerPolicy(expected).rules.some((r) => r.name === "Re-sign: PolarisCheckout.reauthorize")).toBe(true);
    const bare = encodeFunctionData({ abi: iausdAbi, functionName: "permit", args: [someone, merchant, 1n, 2n, 27, zeroHash, zeroHash] });
    expect(() => checkRelayerCall({ to: addresses.stablecoin, data: bare, chainId: 10143 }, expected)).toThrow(/allow-list/);
  });

  it("carries a borrower's permit to CollateralVault.lockWithPermit (a secured line with no MON), above the minimum only", () => {
    const lock = (amount: bigint) => encodeFunctionData({ abi: collateralVaultAbi, functionName: "lockWithPermit", args: [someone, amount, 2_000_000_000n, 27, zeroHash, zeroHash] });
    const withMin = { ...expected, minAmountUnits: 100_000n };
    expect(checkRelayerCall({ to: addresses.vault, data: lock(202_000_000n), chainId: 10143 }, withMin)).toMatchObject({ contract: "vault", functionName: "lockWithPermit" });
    expect(() => checkRelayerCall({ to: addresses.vault, data: lock(1n), chainId: 10143 }, withMin)).toThrow(/100000 base units or more/);
    // The vault's own lock (msg.sender's), withdraw and owner calls are not the relayer's.
    const bare = encodeFunctionData({ abi: collateralVaultAbi, functionName: "lock", args: [1_000_000n] });
    expect(() => checkRelayerCall({ to: addresses.vault, data: bare, chainId: 10143 }, expected)).toThrow(/allow-list/);
    const seize = encodeFunctionData({ abi: collateralVaultAbi, functionName: "seize", args: [someone, 1n, merchant] });
    expect(() => checkRelayerCall({ to: addresses.vault, data: seize, chainId: 10143 }, expected)).toThrow(/allow-list/);
    const rule = buildRelayerPolicy(withMin).rules.find((r) => r.name === "Secure a line: CollateralVault.lockWithPermit");
    expect(rule?.conditions).toContainEqual(expect.objectContaining({ field: "lockWithPermit.amount", operator: "gte", value: "100000" }));
  });

  it("without a vault in the deployment, has no collateral rule and refuses the call", () => {
    const { vault, ...rest } = addresses;
    const noVault = { chainId: 10143, addresses: { ...rest, vault: null } };
    const lock = encodeFunctionData({ abi: collateralVaultAbi, functionName: "lockWithPermit", args: [someone, 1_000_000n, 2_000_000_000n, 27, zeroHash, zeroHash] });
    expect(() => checkRelayerCall({ to: vault as Address, data: lock, chainId: 10143 }, noVault)).toThrow(/isn't a Polaris contract/);
    const take = encodeFunctionData({ abi: collateralVaultAbi, functionName: "withdrawWithSig", args: [someone, 1_000_000n, 2_000_000_000n, "0x"] });
    expect(() => checkRelayerCall({ to: vault as Address, data: take, chainId: 10143 }, noVault)).toThrow(/isn't a Polaris contract/);
    const policy = buildRelayerPolicy(noVault);
    expect(policy.rules.some((r) => r.name.includes("CollateralVault"))).toBe(false);
    // The two vault calls are left out; the DENY rule is added.
    expect(policy.rules).toHaveLength(RELAYER_CALLS.length - 2 + 1);
  });

  it("carries a borrower's Withdraw to CollateralVault.withdrawWithSig (take out of Boost with no MON), above the minimum only", () => {
    const take = (amount: bigint) => encodeFunctionData({ abi: collateralVaultAbi, functionName: "withdrawWithSig", args: [someone, amount, 2_000_000_000n, "0x1234"] });
    const withMin = { ...expected, minAmountUnits: 100_000n };
    expect(checkRelayerCall({ to: addresses.vault, data: take(25_000_000n), chainId: 10143 }, withMin)).toMatchObject({ contract: "vault", functionName: "withdrawWithSig" });
    expect(() => checkRelayerCall({ to: addresses.vault, data: take(1n), chainId: 10143 }, withMin)).toThrow(/100000 base units or more/);
    // withdraw() pays its caller, the relayer itself: never on the list, and neither is invalidateNonce.
    const bare = encodeFunctionData({ abi: collateralVaultAbi, functionName: "withdraw", args: [1_000_000n] });
    expect(() => checkRelayerCall({ to: addresses.vault, data: bare, chainId: 10143 }, expected)).toThrow(/allow-list/);
    const burn = encodeFunctionData({ abi: collateralVaultAbi, functionName: "invalidateNonce" });
    expect(() => checkRelayerCall({ to: addresses.vault, data: burn, chainId: 10143 }, expected)).toThrow(/allow-list/);
    // Sent to another contract, it decodes as nothing there.
    expect(() => checkRelayerCall({ to: addresses.loanEngine, data: take(25_000_000n), chainId: 10143 }, expected)).toThrow(PolicyViolation);

    const policy = buildRelayerPolicy(withMin);
    expect(lintPolicy(policy)).toEqual([]);
    const rule = policy.rules.find((r) => r.name === "Take out of Boost: CollateralVault.withdrawWithSig");
    expect(rule).toMatchObject({ method: "eth_signTransaction", action: "ALLOW" });
    expect(rule?.conditions).toContainEqual(expect.objectContaining({ field: "to", operator: "in", value: [addresses.vault, (addresses.vault as string).toLowerCase()] }));
    expect(rule?.conditions).toContainEqual(expect.objectContaining({ field: "function_name", operator: "eq", value: "withdrawWithSig" }));
    expect(rule?.conditions).toContainEqual(expect.objectContaining({ field: "withdrawWithSig.amount", operator: "gte", value: "100000" }));
    expect(RELAYER_CALLS.find((c) => c.functionName === "withdrawWithSig")).toMatchObject({ contract: "vault", signedBy: "owner" });
  });

  it("allows the three split-the-bill calls on PolarisSplit, and nothing else there", () => {
    const creation = { organiser: someone, salt: zeroHash, amounts: [30_000_000n], memoHash: zeroHash, expiresAt: 2_000_000_000n, deadline: 2_000_000_000n };
    const create = encodeFunctionData({ abi: polarisSplitAbi, functionName: "createSplit", args: [creation, "0x"] });
    const pay = encodeFunctionData({ abi: polarisSplitAbi, functionName: "payShare", args: [zeroHash, 0n, someone, 0n, 1n, 27, zeroHash, zeroHash] });
    const close = encodeFunctionData({ abi: polarisSplitAbi, functionName: "closeSplit", args: [zeroHash, 1n, "0x"] });
    for (const [data, fn] of [[create, "createSplit"], [pay, "payShare"], [close, "closeSplit"]] as const) {
      expect(checkRelayerCall({ to: splitAddress, data, chainId: 10143 }, expected)).toMatchObject({ contract: "split", functionName: fn });
    }
    // A split call sent to another Polaris contract decodes as nothing there.
    expect(() => checkRelayerCall({ to: addresses.send, data: pay, chainId: 10143 }, expected)).toThrow(PolicyViolation);
    const rules = buildRelayerPolicy(expected).rules.map((r) => r.name);
    expect(rules).toEqual(expect.arrayContaining(["Split a bill: PolarisSplit.createSplit", "Pay a share: PolarisSplit.payShare", "Close a split: PolarisSplit.closeSplit"]));
  });

  it("without PolarisSplit (a deployment that predates it) the policy has no split rules, and split calls are refused", () => {
    const old = { chainId: 10143, addresses: { ...addresses, split: null } };
    const pay = encodeFunctionData({ abi: polarisSplitAbi, functionName: "payShare", args: [zeroHash, 0n, someone, 0n, 1n, 27, zeroHash, zeroHash] });
    expect(() => checkRelayerCall({ to: splitAddress, data: pay, chainId: 10143 }, old)).toThrow(/isn't a Polaris contract/);
    const policy = buildRelayerPolicy(old);
    expect(lintPolicy(policy)).toEqual([]);
    expect(policy.rules.filter((r) => r.name.includes("PolarisSplit"))).toEqual([]);
    expect(policy.rules).toHaveLength(RELAYER_CALLS.length - 3 + 1);
    expect(callsFor(old.addresses).some((c) => c.contract === "split")).toBe(false);
  });

  it("refuses a relayer that tries to send MON", () => {
    expect(() => checkRelayerCall({ to: addresses.checkout, data: payData, value: 1n, chainId: 10143 }, expected)).toThrow(PolicyViolation);
  });

  it("refuses another chain", () => {
    expect(() => checkRelayerCall({ to: addresses.checkout, data: payData, chainId: 143 }, expected)).toThrow(/only on chain 10143/);
  });

  it("refuses a contract that isn't ours, even with a listed function", () => {
    expect(() => checkRelayerCall({ to: someone, data: payData, chainId: 10143 }, expected)).toThrow(/isn't a Polaris contract/);
  });

  it("refuses approve on the dollar token (a relayer must never set allowances)", () => {
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [someone, 2n ** 255n] });
    expect(() => checkRelayerCall({ to: addresses.stablecoin, data: approve, chainId: 10143 }, expected)).toThrow(/allow-list/);
  });

  it("refuses owner functions on our own contracts", () => {
    const setOperator = encodeFunctionData({ abi: polarisPaymentsAbi, functionName: "setOperator", args: [someone, true] });
    expect(() => checkRelayerCall({ to: addresses.payments, data: setOperator, chainId: 10143 }, expected)).toThrow(/allow-list/);
    const activate = encodeFunctionData({ abi: merchantRegistryAbi, functionName: "setActive", args: [someone, true] });
    expect(() => checkRelayerCall({ to: addresses.registry, data: activate, chainId: 10143 }, expected)).toThrow(/allow-list/);
    const withdraw = encodeFunctionData({ abi: polarisLoanEngineAbi, functionName: "withdrawLiquidity", args: [1n, someone] });
    expect(() => checkRelayerCall({ to: addresses.loanEngine, data: withdraw, chainId: 10143 }, expected)).toThrow(/allow-list/);
  });

  it("refuses a plain transfer and a deployment", () => {
    expect(() => checkRelayerCall({ to: someone, data: "0x", chainId: 10143 }, expected)).toThrow(PolicyViolation);
    expect(() => checkRelayerCall({ to: null, data: payData, chainId: 10143 }, expected)).toThrow(/deploys/);
    expect(() => checkRelayerCall({ to: addresses.checkout, data: "0x", chainId: 10143 }, expected)).toThrow(/functions/);
  });
});

describe("the Privy relayer policy (buildRelayerPolicy)", () => {
  const policy = buildRelayerPolicy(expected);

  it("passes Privy's own limits", () => {
    expect(lintPolicy(policy)).toEqual([]);
    expect(policy).toMatchObject({ version: "1.0", chain_type: "ethereum" });
  });

  it("denies any MON first, then allows exactly one rule per listed call", () => {
    const [deny, ...allows] = policy.rules;
    expect(deny).toMatchObject({ action: "DENY", method: "eth_signTransaction", conditions: [{ field: "value", operator: "gt", value: "0" }] });
    expect(allows).toHaveLength(RELAYER_CALLS.length);
    for (const rule of allows) expect(rule).toMatchObject({ action: "ALLOW", method: "eth_signTransaction" });
  });

  it("pins each rule to our chain, our contract (either spelling) and one function, with function-only ABI fragments", () => {
    for (const [i, call] of RELAYER_CALLS.entries()) {
      const rule = policy.rules[i + 1];
      const [to, chain, fn] = rule?.conditions ?? [];
      const at = addresses[call.contract] as Address;
      expect(to).toEqual({ field_source: "ethereum_transaction", field: "to", operator: "in", value: [at, at.toLowerCase()] });
      expect(chain).toEqual({ field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: "10143" });
      expect(fn).toMatchObject({ field_source: "ethereum_calldata", field: "function_name", operator: "eq", value: call.functionName });
      const abi = (fn as { abi: Array<{ type: string; name: string }> }).abi;
      expect(abi.length).toBeGreaterThan(0);
      expect(abi.every((x) => x.type === "function" && x.name === call.functionName)).toBe(true);
    }
  });

  it("never allows a raw MON transfer, approve, typed data or key export (no rule for them)", () => {
    const methods = new Set(policy.rules.map((r) => r.method));
    expect([...methods]).toEqual(["eth_signTransaction"]);
    const allowedFns = policy.rules.flatMap((r) => r.conditions.filter((c) => c.field === "function_name").map((c) => c.value));
    expect(allowedFns).not.toContain("approve");
    expect(allowedFns).not.toContain("transfer");
  });
});

describe("the registry admin policy", () => {
  it("allows only setActive and setMaxOrderValue up to the cap", () => {
    const policy = buildRegistryAdminPolicy({ chainId: 10143, registry: addresses.registry, capUnits: 1_000_000_000n });
    expect(lintPolicy(policy)).toEqual([]);
    const allowed = policy.rules.filter((r) => r.action === "ALLOW");
    expect(allowed.map((r) => r.conditions.find((c) => c.field === "function_name")?.value)).toEqual(["setActive", "setMaxOrderValue"]);
    expect(allowed[1]?.conditions).toContainEqual(expect.objectContaining({ field: "setMaxOrderValue.maxOrderValue", operator: "lte", value: "1000000000" }));
  });
});

describe("the automatic payout policy", () => {
  it("pins typed-data signing to AUSD, this chain, the merchant's own wallet and one payout address", () => {
    const payout = "0x3333333333333333333333333333333333333333" as Address;
    const policy = buildPayoutPolicy({ merchantKey: "did:privy:abc", payoutAddress: payout, stablecoin: addresses.stablecoin, chainId: 10143 });
    expect(lintPolicy(policy)).toEqual([]);
    expect(policy.name).toBe("payout-abc");
    expect(policy.rules).toHaveLength(1);
    const [rule] = policy.rules;
    expect(rule).toMatchObject({ method: "eth_signTypedData_v4", action: "ALLOW" });
    const conds = rule?.conditions ?? [];
    expect(conds).toContainEqual({ field_source: "ethereum_typed_data_domain", field: "chainId", operator: "eq", value: "10143" });
    expect(conds).toContainEqual({ field_source: "ethereum_typed_data_domain", field: "verifyingContract", operator: "in", value: [addresses.stablecoin, addresses.stablecoin.toLowerCase()] });
    expect(conds).toContainEqual(expect.objectContaining({ field: "to", operator: "in", value: [payout, payout.toLowerCase()] }));
    expect(conds).toContainEqual(expect.objectContaining({ field: "from", operator: "eq", value: "{{wallet.address}}" }));
    expect(conds).toContainEqual(expect.objectContaining({ field: "value", operator: "lte" }));
    // The typed-data conditions only evaluate when the request's types match these exactly.
    for (const c of conds.filter((x) => x.field_source === "ethereum_typed_data_message")) {
      expect((c.typed_data as { types: unknown }).types).toEqual(TWA_TYPES);
    }
  });
});
