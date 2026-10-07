import { encodeFunctionData, getAddress, zeroHash, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { iausdAbi, polarisSendAbi } from "@polarispay/contracts/abi";
import { POST as relayRoute } from "@/app/api/relay/route";
import { buildRelayerPolicy, checkRelayerCall, PolicyViolation, type RelayerAddresses } from "@/server/policy/relayer";
import { TYPES } from "@/server/relayer/typed-data";

import { ADDR, json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { inSeconds, stablecoinDomain } from "./helpers/flows";

/**
 * The relayer pays gas for every call it carries. Transfers and sends by link
 * need no merchant's checkout behind them, so a stranger with a fresh key
 * could otherwise make it move 0 AUSD between throwaway accounts forever.
 */

let env: TestEnv;

beforeEach(() => {
  env = setupServer();
});

let ipCounter = 0;
const relay = (body: unknown) => relayRoute(request("POST", "/api/relay", { body, headers: { "x-forwarded-for": `198.51.100.${(ipCounter++ % 250) + 1}` } }), params({}));

async function signedTransfer(from: LocalAccount, to: Address, value: bigint) {
  const nonce = generatePrivateKey() as Hex; // any fresh 32 bytes
  const message = { from: from.address, to, value, validAfter: 0n, validBefore: BigInt(inSeconds(600)), nonce };
  const signature = await from.signTypedData({ domain: stablecoinDomain, types: TYPES.TransferWithAuthorization, primaryType: "TransferWithAuthorization", message });
  return { type: "transfer", from: from.address, to, value: value.toString(), validAfter: "0", validBefore: message.validBefore.toString(), nonce, signature };
}

const fresh = () => privateKeyToAccount(generatePrivateKey());

describe("POST /api/relay type=transfer is not free gas for strangers", () => {
  it("refuses a zero-value transfer between two fresh keys (the reported attack), and sends nothing", async () => {
    const res = await json(await relay(await signedTransfer(fresh(), fresh().address, 0n)));
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("value");
    expect(env.chain.sent).toHaveLength(0);
  });

  it("refuses anything below the minimum ($0.10 by default), and a transfer to oneself", async () => {
    const below = await json(await relay(await signedTransfer(fresh(), fresh().address, 99_999n)));
    expect(below.status).toBe(400);
    expect(below.body.error.message).toMatch(/at least 0\.10/);
    const me = fresh();
    const self = await json(await relay(await signedTransfer(me, me.address, 1_000_000n)));
    expect(self.status).toBe(400);
    expect(self.body.error.param).toBe("to");
    expect(env.chain.sent).toHaveLength(0);
  });

  it("carries a real transfer at or above the minimum", async () => {
    const res = await json(await relay(await signedTransfer(fresh(), fresh().address, 100_000n)));
    expect(res.status).toBe(200);
    expect(env.chain.sent).toHaveLength(1);
    expect(env.chain.sent[0]?.functionName).toBe("transferWithAuthorization");
  });

  it("the minimum is configurable", async () => {
    env = setupServer({ RELAYER_MIN_TRANSFER_UNITS: "5000000" });
    const res = await json(await relay(await signedTransfer(fresh(), fresh().address, 1_000_000n)));
    expect(res.body.error.message).toMatch(/at least 5\.00/);
  });

  it("refuses a send by link below the minimum before looking at its signatures", async () => {
    const res = await json(
      await relay({
        type: "send",
        sender: fresh().address,
        linkKey: fresh().address,
        amount: "1",
        expiresAt: inSeconds(3600),
        validAfter: "0",
        validBefore: inSeconds(600),
        signature: `0x${"11".repeat(65)}`,
        linkSignature: `0x${"22".repeat(65)}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe("amount");
    expect(env.chain.sent).toHaveLength(0);
  });

  it("one global budget bounds every open transfer, however many fresh keys and IPs send them", async () => {
    // The bucket refills one token a second from Date.now(): hold the clock still, so a slow machine
    // can't refill it mid-loop and the test says exactly what the budget allows.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 125 && !statuses.includes(429); i++) statuses.push((await relay(await signedTransfer(fresh(), fresh().address, 100_000n))).status);
      // The burst (120), and not one transfer more.
      expect(statuses.filter((s) => s === 200).length).toBe(120);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});

describe("caps the Privy policy can't express", () => {
  it("refuses a call whose gas estimate is above RELAYER_MAX_GAS (Monad bills the whole limit)", async () => {
    env = setupServer({ RELAYER_MAX_GAS: "100000" }); // the fake chain estimates 200k
    const res = await json(await relay(await signedTransfer(fresh(), fresh().address, 1_000_000n)));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("policy_violation");
    expect(env.chain.sent).toHaveLength(0);
  });

  it("waits out a fee spike above RELAYER_MAX_FEE_GWEI instead of paying it", async () => {
    env = setupServer({ RELAYER_MAX_FEE_GWEI: "1" });
    env.chain.fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
    const res = await json(await relay(await signedTransfer(fresh(), fresh().address, 1_000_000n)));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("network_busy");
    expect(env.chain.sent).toHaveLength(0);
  });
});

describe("the minimum is in the policy too, not only in the route", () => {
  const addresses: RelayerAddresses = {
    checkout: getAddress(ADDR.checkout),
    payments: getAddress(ADDR.payments),
    send: getAddress(ADDR.send),
    loanEngine: getAddress(ADDR.loanEngine),
    registry: getAddress(ADDR.registry),
    stablecoin: getAddress(ADDR.stablecoin),
  };
  const someone = "0x1111111111111111111111111111111111111111" as Address;
  const twa = (value: bigint) =>
    encodeFunctionData({ abi: iausdAbi, functionName: "transferWithAuthorization", args: [someone, someone, value, 0n, 1n, zeroHash, 27, zeroHash, zeroHash] });

  it("checkRelayerCall refuses a transfer or a send below the minimum, whoever builds it", () => {
    const expected = { chainId: 10143, addresses, minAmountUnits: 100_000n };
    expect(() => checkRelayerCall({ to: addresses.stablecoin, data: twa(0n), chainId: 10143 }, expected)).toThrow(PolicyViolation);
    expect(checkRelayerCall({ to: addresses.stablecoin, data: twa(100_000n), chainId: 10143 }, expected).functionName).toBe("transferWithAuthorization");
    const send = encodeFunctionData({
      abi: polarisSendAbi,
      functionName: "send",
      args: [someone, someone, 1n, 1n, 0n, 1n, 27, zeroHash, zeroHash, 27, zeroHash, zeroHash],
    });
    expect(() => checkRelayerCall({ to: addresses.send, data: send, chainId: 10143 }, expected)).toThrow(/send only for 100000/);
  });

  it("the Privy policy's transfer and send rules carry the same floor", () => {
    const policy = buildRelayerPolicy({ chainId: 10143, addresses, minAmountUnits: 100_000n });
    const floor = (rule: string) => policy.rules.find((r) => r.name === rule)?.conditions.find((c) => c.operator === "gte");
    expect(floor("Payouts: AUSD transferWithAuthorization")).toMatchObject({ field_source: "ethereum_calldata", field: "transferWithAuthorization.value", value: "100000" });
    expect(floor("Send by link: PolarisSend.send")).toMatchObject({ field: "send.amount", value: "100000" });
    expect(floor("Pay now: PolarisCheckout.pay")).toBeUndefined();
  });
});
