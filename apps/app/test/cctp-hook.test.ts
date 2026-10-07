import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector } from "viem";

import { depositForBurnWithHookCall, orderHookData, STANDARD_TRANSFER } from "../src/lib/cctp-burn.ts";

/**
 * Pay an order with CCTP in one source-chain transaction: the hooked burn
 * mints to PolarisCctpHookReceiver on Arc (domain 26), which alone may finish
 * it, and carries the order for it to pay.
 */

const MESSENGER = getAddress("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
const USDC_BASE_SEPOLIA = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const HOOK = getAddress("0x00000000000000000000000000000000000000b0");
const MERCHANT = getAddress("0x000000000000000000000000000000000000beef");
const ACCOUNT = getAddress("0x00000000000000000000000000000000000a11ce");
const word = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

const ORDER = [
  { name: "merchant", type: "address" },
  { name: "orderId", type: "string" },
  { name: "orderAmount", type: "uint256" },
  { name: "refundTo", type: "address" },
] as const;

describe("the order's hook data", () => {
  it("is abi.encode(merchant, orderId, orderAmount, refundTo), as PolarisCctpHookReceiver decodes it", () => {
    const data = orderHookData({ merchant: MERCHANT, orderId: "HC-39073", orderAmount: 32_020_000n, refundTo: ACCOUNT });
    assert.deepEqual(decodeAbiParameters(ORDER, data), [MERCHANT, "HC-39073", 32_020_000n, ACCOUNT]);
  });
});

describe("the hooked CCTP burn", () => {
  const call = depositForBurnWithHookCall({
    tokenMessengerV2: MESSENGER,
    usdc: USDC_BASE_SEPOLIA,
    arcDomain: 26,
    hookReceiver: HOOK,
    amount: 32_020_000n,
    merchant: MERCHANT,
    orderId: "HC-39073",
    orderAmount: 32_020_000n,
    refundTo: ACCOUNT,
  });

  it("calls depositForBurnWithHook on TokenMessengerV2", () => {
    assert.equal(call.address, MESSENGER);
    assert.equal(
      encodeFunctionData(call).slice(0, 10),
      toFunctionSelector("depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)"),
    );
  });

  it("mints to the hook receiver, which is also the only destination caller, as a standard transfer with the order", () => {
    const { args } = decodeFunctionData({ abi: call.abi, data: encodeFunctionData(call) });
    const [amount, domain, recipient, token, caller, maxFee, finality, hookData] = args as unknown as readonly [bigint, number, string, string, string, bigint, number, `0x${string}`];
    assert.equal(amount, 32_020_000n);
    assert.equal(domain, 26);
    assert.equal(recipient, word(HOOK));
    assert.equal(caller, word(HOOK));
    assert.equal(getAddress(token), USDC_BASE_SEPOLIA);
    assert.equal(maxFee, STANDARD_TRANSFER.maxFee);
    assert.equal(finality, 2000);
    assert.deepEqual(decodeAbiParameters(ORDER, hookData), [MERCHANT, "HC-39073", 32_020_000n, ACCOUNT]);
  });

  it("refuses a burn smaller than the order", () => {
    assert.throws(() =>
      depositForBurnWithHookCall({
        tokenMessengerV2: MESSENGER,
        usdc: USDC_BASE_SEPOLIA,
        arcDomain: 26,
        hookReceiver: HOOK,
        amount: 1n,
        merchant: MERCHANT,
        orderId: "HC-39073",
        orderAmount: 32_020_000n,
        refundTo: ACCOUNT,
      }),
    );
  });
});
