import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeFunctionData, encodeFunctionData, getAddress } from "viem";

import { depositForBurnCall, STANDARD_TRANSFER } from "../src/lib/cctp-burn.ts";

/**
 * Add money from another chain: the burn the buyer's wallet sends to
 * TokenMessengerV2 on the source chain mints to their Polaris account on Arc
 * (domain 26), as a standard transfer anyone may finish on Arc.
 */

const MESSENGER = getAddress("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
const USDC_SEPOLIA = getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
const ACCOUNT = getAddress("0x00000000000000000000000000000000000a11ce");

describe("the CCTP burn", () => {
  const call = depositForBurnCall({ tokenMessengerV2: MESSENGER, usdc: USDC_SEPOLIA, arcDomain: 26, recipient: ACCOUNT, amount: 25_000_000n });

  it("calls depositForBurn on TokenMessengerV2 (CCTP V2's selector)", () => {
    assert.equal(call.address, MESSENGER);
    const data = encodeFunctionData(call);
    assert.equal(data.slice(0, 10), "0x8e0250ee");
  });

  it("mints to the account on Arc, standard transfer, no destination caller", () => {
    const { args } = decodeFunctionData({ abi: call.abi, data: encodeFunctionData(call) });
    const [amount, domain, recipient, token, caller, maxFee, finality] = args;
    assert.equal(amount, 25_000_000n);
    assert.equal(domain, 26);
    assert.equal(recipient, `0x${"0".repeat(24)}${ACCOUNT.slice(2).toLowerCase()}`);
    assert.equal(getAddress(token), USDC_SEPOLIA);
    assert.equal(caller, `0x${"0".repeat(64)}`);
    assert.equal(maxFee, STANDARD_TRANSFER.maxFee);
    assert.equal(finality, 2000);
  });
});
