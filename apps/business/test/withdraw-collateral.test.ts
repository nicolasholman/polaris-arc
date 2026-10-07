/**
 * POST /api/relay type=withdrawCollateral: take out of Boost with no MON.
 * The borrower signs CollateralVault's EIP-712 Withdraw and the relayer sends
 * CollateralVault.withdrawWithSig, which pays the borrower and nobody else.
 * Where the network's vault predates signed withdrawal (Monad testnet's
 * today), the relayer says so before anything is signed or sent.
 */
import { zeroHash, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";

import { POST as relayRoute } from "@/app/api/relay/route";
import { TYPES } from "@/server/relayer/typed-data";
import { ADDR, json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { inSeconds } from "./helpers/flows";

let env: TestEnv;
const borrower = privateKeyToAccount(generatePrivateKey());
const vaultDomain = { name: "CollateralVault", version: "1", chainId: 31337, verifyingContract: ADDR.vault } as const;
const USD = (n: number) => BigInt(Math.round(n * 1e6));

/** What a vault with withdrawWithSig answers to eip712Domain() (ERC-5267). */
const takesSignedWithdraw = (overrides: Partial<{ name: string; chainId: bigint; verifyingContract: Address }> = {}) => () => [
  "0x0f",
  overrides.name ?? "CollateralVault",
  "1",
  overrides.chainId ?? 31337n,
  overrides.verifyingContract ?? ADDR.vault,
  zeroHash,
  [],
];

beforeEach(() => {
  env = setupServer();
  env.chain.reads.eip712Domain = takesSignedWithdraw();
  env.chain.reads.nonces = () => 0n;
  env.chain.reads.lockedOf = () => USD(300);
  env.chain.reads.withdrawable = () => USD(300);
});

async function signWithdraw(amount: bigint, { signer = borrower, nonce = 0n, deadline = BigInt(inSeconds(900)), domain = vaultDomain as typeof vaultDomain } = {}) {
  const signature = await signer.signTypedData({ domain, types: TYPES.Withdraw, primaryType: "Withdraw", message: { borrower: borrower.address, amount, nonce, deadline } });
  return { type: "withdrawCollateral", borrower: borrower.address, amount: amount.toString(), deadline: deadline.toString(), signature };
}

const relay = async (body: unknown) => json(await relayRoute(request("POST", "/api/relay", { body }), params({})));

describe("POST /api/relay type=withdrawCollateral", () => {
  it("relays CollateralVault.withdrawWithSig for the borrower who signed, once, with the gas limit at the estimate plus 15%", async () => {
    const body = await signWithdraw(USD(120));
    const res = await relay(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ type: "withdrawCollateral", status: "confirmed", sessionId: null });
    const [sent] = env.chain.relayed;
    expect(sent).toMatchObject({ to: ADDR.vault, functionName: "withdrawWithSig", value: 0n, gas: 230_000n });
    expect(sent?.args).toEqual([borrower.address, USD(120), BigInt(body.deadline), body.signature]);

    const again = await relay(body);
    expect(again.body.data.txHash).toBe(res.body.data.txHash);
    expect(env.chain.relayed).toHaveLength(1);
  });

  it("takes everything out", async () => {
    const res = await relay(await signWithdraw(USD(300)));
    expect(res.status).toBe(200);
    expect(env.chain.relayed[0]?.args[1]).toBe(USD(300));
  });

  it("on a vault that predates signed withdrawal (Monad testnet's today) says it isn't available, before any gas", async () => {
    delete env.chain.reads.eip712Domain; // the old vault has no eip712Domain(): the call reverts
    const res = await relay(await signWithdraw(USD(50)));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("withdraw_unavailable");
    expect(res.body.error.message).toMatch(/isn't available on this network yet/);

    // A vault that answers with another contract's domain, chain or address is treated the same.
    for (const wrong of [{ name: "PolarisCheckout" }, { chainId: 10143n }, { verifyingContract: ADDR.loanEngine }]) {
      env.chain.reads.eip712Domain = takesSignedWithdraw(wrong);
      expect((await relay(await signWithdraw(USD(50)))).body.error.code).toBe("withdraw_unavailable");
    }
    expect(env.chain.relayed).toHaveLength(0);
  });

  it("refuses before any gas: someone else's signature, a stale nonce, another vault's domain", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect((await relay(await signWithdraw(USD(50), { signer: stranger }))).body.error.code).toBe("invalid_signature");
    expect((await relay(await signWithdraw(USD(50), { nonce: 1n }))).body.error.code).toBe("invalid_signature");
    const otherVault = { ...vaultDomain, verifyingContract: ADDR.loanEngine };
    expect((await relay(await signWithdraw(USD(50), { domain: otherVault as typeof vaultDomain }))).body.error.code).toBe("invalid_signature");
    // A signature for another amount than the one asked for.
    const signed = await signWithdraw(USD(50));
    expect((await relay({ ...signed, amount: USD(60).toString() })).body.error.code).toBe("invalid_signature");
    expect(env.chain.relayed).toHaveLength(0);
  });

  it("refuses before any gas: more than is in Boost, Boost that secures a plan, dust left behind, below the minimum, a deadline over an hour away", async () => {
    const over = await relay(await signWithdraw(USD(301)));
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("insufficient_collateral");

    env.chain.reads.withdrawable = () => 0n; // the vault releases nothing while any debt is outstanding
    const inUse = await relay(await signWithdraw(USD(50)));
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe("collateral_in_use");
    expect(inUse.body.error.message).toMatch(/secures a Pay in 4 plan/);
    env.chain.reads.withdrawable = () => USD(300);

    const dust = await relay(await signWithdraw(USD(299.95)));
    expect(dust.status).toBe(400);
    expect(dust.body.error.param).toBe("amount");
    expect(dust.body.error.message).toMatch(/Take it all out, or leave more/);

    const tiny = await relay(await signWithdraw(1n));
    expect(tiny.status).toBe(400);
    expect(tiny.body.error.param).toBe("amount");

    const far = await relay(await signWithdraw(USD(50), { deadline: BigInt(inSeconds(2 * 3600)) }));
    expect(far.status).toBe(400);
    expect(far.body.error.param).toBe("deadline");

    const unsigned = await relay({ type: "withdrawCollateral", borrower: borrower.address, amount: USD(50).toString(), deadline: String(inSeconds(900)) });
    expect(unsigned.status).toBe(400);
    expect(unsigned.body.error.param).toBe("signature");
    expect(env.chain.relayed).toHaveLength(0);
  });

  it("a revert in simulation sends nothing", async () => {
    env.chain.reverts.set("withdrawWithSig", "0x8baa579f"); // InvalidSignature(): a nonce someone else spent first
    const res = await relay(await signWithdraw(USD(50)));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(env.chain.relayed).toHaveLength(0);
  });
});
