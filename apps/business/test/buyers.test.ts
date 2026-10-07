import { parseAbi, zeroAddress, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { GET as buyerGet } from "@/app/api/public/buyers/[address]/route";
import { POST as relayRoute } from "@/app/api/relay/route";

import { polarisSendAbi } from "@polarispay/contracts/abi";

import { ADDR, json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { makeLog } from "./helpers/fake-chain";
import { emitLikeTheContracts, merchantWithKeys, newSession, signPayNow, type Merchant } from "./helpers/flows";

let merchant: Merchant;
let env: TestEnv;
const buyer = privateKeyToAccount(generatePrivateKey());

beforeEach(async () => {
  env = setupServer();
  emitLikeTheContracts(env);
  merchant = await merchantWithKeys();
});

const book = async (address: string) => (await json(await buyerGet(request("GET", `/api/public/buyers/${address}`), params({ address })))).body.data;

describe("GET /api/public/buyers/{address}", () => {
  it("shows a buyer's payments from chain events, with the merchant's name but never the checkout's description or order", async () => {
    const session = await newSession(merchant, { description: "Private consultation for J. Doe", orderId: "INV-secret-42" });
    const auth = await signPayNow(buyer, merchant.account.address, session.orderId, 200_000_000n);
    expect((await relayRoute(request("POST", "/api/relay", { body: { type: "pay", sessionId: session.id, buyer: buyer.address, ...auth } }), params({}))).status).toBe(200);

    const mine = await book(buyer.address);
    expect(mine.payments).toHaveLength(1);
    expect(mine.payments[0]).toMatchObject({ kind: "now", amountUnits: "200000000", merchant: { address: merchant.account.address } });
    expect(mine.payments[0].txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const text = JSON.stringify(mine);
    expect(text).not.toContain("Private consultation");
    expect(text).not.toContain("INV-secret-42");

    // Someone else's address shows nothing of it; the lookup is case-insensitive.
    expect((await book(privateKeyToAccount(generatePrivateKey()).address)).payments).toEqual([]);
    expect((await book(buyer.address.toLowerCase())).payments).toHaveLength(1);
  });

  it("shows every other dollar in and out: money added, a send link made and claimed, a transfer", async () => {
    const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]) as unknown as Abi;
    const friend = privateKeyToAccount(generatePrivateKey()).address;
    const linkKey = privateKeyToAccount(generatePrivateKey()).address;
    const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
    const emit = (block: number, txHash: Hex, logs: Array<{ address: `0x${string}`; abi: Abi; eventName: string; args: Record<string, unknown> }>) =>
      logs.forEach((spec, i) => env.chain.logs.push(makeLog(spec, { txHash, logIndex: i, blockNumber: BigInt(block) })));
    const send = polarisSendAbi as unknown as Abi;
    emit(101, tx(1), [{ address: ADDR.stablecoin, abi: erc20, eventName: "Transfer", args: { from: zeroAddress, to: buyer.address, value: 1_000_000_000n } }]);
    emit(102, tx(2), [
      { address: ADDR.stablecoin, abi: erc20, eventName: "Transfer", args: { from: buyer.address, to: ADDR.send, value: 50_000_000n } },
      { address: ADDR.send, abi: send, eventName: "Sent", args: { linkKey, sender: buyer.address, amount: 50_000_000n, expiresAt: 9_999_999_999n } },
    ]);
    emit(103, tx(3), [
      { address: ADDR.stablecoin, abi: erc20, eventName: "Transfer", args: { from: ADDR.send, to: friend, value: 50_000_000n } },
      { address: ADDR.send, abi: send, eventName: "Claimed", args: { linkKey, to: friend, amount: 50_000_000n } },
    ]);
    emit(104, tx(4), [{ address: ADDR.stablecoin, abi: erc20, eventName: "Transfer", args: { from: friend, to: buyer.address, value: 5_000_000n } }]);
    env.chain.blockNumber = 104n;

    const mine = await book(buyer.address);
    expect(mine.moves.map((m: { kind: string; direction: string; amountUnits: string }) => [m.kind, m.direction, m.amountUnits])).toEqual([
      ["received", "in", "5000000"],
      ["sent-link", "out", "50000000"],
      ["added", "in", "1000000000"],
    ]);
    // The sender learns the link was claimed.
    expect(mine.moves[1]).toMatchObject({ linkKey, settledAs: "claimed" });
    expect(mine.moves[1].settledAt).toEqual(expect.any(String));

    const theirs = await book(friend);
    expect(theirs.moves.map((m: { kind: string }) => m.kind)).toEqual(["sent", "claimed"]);
    expect(theirs.moves[1]).toMatchObject({ linkKey, direction: "in", amountUnits: "50000000" });

    // Read again: nothing is counted twice, and later blocks are picked up.
    emit(105, tx(5), [{ address: ADDR.stablecoin, abi: erc20, eventName: "Transfer", args: { from: zeroAddress, to: buyer.address, value: 1_000_000n } }]);
    env.chain.blockNumber = 105n;
    expect((await book(buyer.address)).moves).toHaveLength(4);
  });

  it("refuses something that isn't an address", async () => {
    const res = await buyerGet(request("GET", "/api/public/buyers/nope"), params({ address: "nope" }));
    expect(res.status).toBe(400);
  });
});
