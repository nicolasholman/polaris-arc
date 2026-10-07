/**
 * POST /api/relay type=lockCollateral: a secured Pay in 4 line with no MON.
 * The borrower signs one ERC-2612 permit (spender CollateralVault, value the
 * amount) and the relayer sends CollateralVault.lockWithPermit, which puts it
 * in the borrower's own position.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { POST as relayRoute } from "@/app/api/relay/route";
import { TYPES } from "@/server/relayer/typed-data";
import { ADDR, json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { inSeconds, stablecoinDomain } from "./helpers/flows";

let env: TestEnv;
const borrower = privateKeyToAccount(generatePrivateKey());

beforeEach(() => {
  env = setupServer();
  env.chain.reads.nonces = () => 0n;
  env.chain.reads.balanceOf = () => 1_000_000_000n;
});

async function signPermit(value: bigint, { spender = ADDR.vault, signer = borrower, nonce = 0n } = {}) {
  const deadline = BigInt(inSeconds(900));
  const signature = await signer.signTypedData({
    domain: stablecoinDomain,
    types: TYPES.Permit,
    primaryType: "Permit",
    message: { owner: borrower.address, spender, value, nonce, deadline },
  });
  return { value: value.toString(), deadline: deadline.toString(), signature };
}

const lock = (amount: bigint, permit: unknown) =>
  relayRoute(request("POST", "/api/relay", { body: { type: "lockCollateral", borrower: borrower.address, amount: amount.toString(), permit } }), params({}));

describe("POST /api/relay type=lockCollateral", () => {
  it("relays CollateralVault.lockWithPermit for the borrower who signed, once, with no MON", async () => {
    const permit = await signPermit(202_000_000n);
    const res = await json(await lock(202_000_000n, permit));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: "lockCollateral", status: "confirmed", sessionId: null });
    const [sent] = env.chain.relayed;
    expect(sent).toMatchObject({ to: ADDR.vault, functionName: "lockWithPermit", value: 0n });
    expect(sent?.args[0]).toBe(borrower.address);
    expect(sent?.args[1]).toBe(202_000_000n);

    const again = await json(await lock(202_000_000n, permit));
    expect(again.body.data.txHash).toBe(res.body.data.txHash);
    expect(env.chain.relayed).toHaveLength(1);
  });

  it("refuses before any gas: someone else's permit, another spender, another amount, too little, more than the borrower holds, no permit", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect((await json(await lock(50_000_000n, await signPermit(50_000_000n, { signer: stranger })))).body.error.code).toBe("invalid_signature");
    expect((await json(await lock(50_000_000n, await signPermit(50_000_000n, { spender: ADDR.loanEngine })))).body.error.code).toBe("invalid_signature");

    const other = await json(await lock(60_000_000n, await signPermit(50_000_000n)));
    expect(other.status).toBe(400);
    expect(other.body.error.param).toBe("permit.value");

    const dust = await json(await lock(1n, await signPermit(1n)));
    expect(dust.status).toBe(400);
    expect(dust.body.error.param).toBe("amount");

    env.chain.reads.balanceOf = () => 10_000_000n;
    const poor = await json(await lock(50_000_000n, await signPermit(50_000_000n)));
    expect(poor.status).toBe(409);
    expect(poor.body.error.code).toBe("insufficient_balance");

    const bare = await json(await lock(50_000_000n, undefined));
    expect(bare.status).toBe(400);
    expect(bare.body.error.param).toBe("permit");
    expect(env.chain.relayed).toHaveLength(0);
  });
});
