import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, keccak256, pad, recoverTypedDataAddress, toHex, type Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  BURN_INTENT_DOMAIN,
  BURN_INTENT_TYPES,
  buildBurnIntent,
  gatewayFor,
  intentFromJson,
  intentToJson,
  maxFeeFor,
  type GatewayNetwork,
} from "@/server/gateway";
import { checkRelayerCall, RELAYER_CALLS } from "@/server/policy/relayer";
import { encodeFunctionData, parseAbi } from "viem";

/**
 * Circle Gateway (server/gateway.ts): the burn intent a buyer signs to spend
 * their unified USDC balance on Arc, checked field by field, and the one
 * relayer call it leads to. The live test (GATEWAY_LIVE=1) posts a signed
 * intent from an empty key to Circle's testnet Gateway API: a correct
 * signature is refused only for the balance, a tampered one for the signature.
 */

const ARC_TESTNET_CIRCLE = {
  usdc: "0x3600000000000000000000000000000000000000" as Address,
  eurc: null,
  cctpDomain: 26,
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address,
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address,
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9" as Address,
  gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B" as Address,
  memo: null,
  irisApiUrl: "https://iris-api-sandbox.circle.com",
};
const g = gatewayFor({ circle: ARC_TESTNET_CIRCLE, mainnet: false }) as GatewayNetwork;
const buyer = privateKeyToAccount(generatePrivateKey());
const polarisAccount = getAddress("0x00000000000000000000000000000000000a11ce");
const salt = keccak256(toHex("salt"));
const sign = (message: ReturnType<typeof buildBurnIntent>) => buyer.signTypedData({ domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message });

describe("Circle Gateway: spending a unified balance on Arc", () => {
  it("runs where the record has Circle's GatewayWallet and GatewayMinter, not on a local node", () => {
    expect(g).toMatchObject({ apiUrl: "https://gateway-api-testnet.circle.com", arcDomain: 26, minter: ARC_TESTNET_CIRCLE.gatewayMinter });
    expect(g.sources.map((s) => s.domain)).toEqual(expect.arrayContaining([0, 6, 26]));
    expect(gatewayFor({ circle: null, mainnet: false })).toBeNull();
    expect(gatewayFor({ circle: ARC_TESTNET_CIRCLE, mainnet: true })?.apiUrl).toBe("https://gateway-api.circle.com");
  });

  it("caps the fee at the source chain's gas fee plus a quarter, the 0.005% transfer fee and a cent", () => {
    expect(maxFeeFor(6, 100_000_000n)).toBe(12_500n + 5_000n + 10_000n); // Base: $0.01 gas
    expect(maxFeeFor(0, 100_000_000n)).toBe(1_250_000n + 5_000n + 10_000n); // Ethereum: $1.00 gas
    expect(maxFeeFor(26, 1n)).toBe(4_375n + 1n + 10_000n); // Arc, rounded up
  });

  it("builds an intent that mints to the buyer's Polaris account on Arc through Circle's minter, with no destination caller", () => {
    const i = buildBurnIntent(g, { sourceDomain: 6, depositor: buyer.address, recipient: polarisAccount, value: 25_000_000n, salt });
    expect(i.spec).toMatchObject({
      version: 1,
      sourceDomain: 6,
      destinationDomain: 26,
      sourceContract: pad(ARC_TESTNET_CIRCLE.gatewayWallet, { size: 32 }).toLowerCase(),
      destinationContract: pad(ARC_TESTNET_CIRCLE.gatewayMinter, { size: 32 }).toLowerCase(),
      sourceToken: pad("0x036CbD53842c5426634e7929541eC2318f3dCF7e", { size: 32 }).toLowerCase(),
      destinationToken: pad(ARC_TESTNET_CIRCLE.usdc, { size: 32 }).toLowerCase(),
      destinationRecipient: pad(polarisAccount, { size: 32 }).toLowerCase(),
      destinationCaller: `0x${"0".repeat(64)}`,
      value: 25_000_000n,
    });
    expect(i.spec.sourceSigner).toBe(i.spec.sourceDepositor);
    expect(() => buildBurnIntent(g, { sourceDomain: 99, depositor: buyer.address, recipient: polarisAccount, value: 1n, salt })).toThrow(/sourceDomain/);
    expect(() => buildBurnIntent(g, { sourceDomain: 6, depositor: buyer.address, recipient: polarisAccount, value: 10_000_000_001n, salt })).toThrow(/10,000/);
  });

  it("round-trips through JSON, recovers the buyer's signature, and refuses an intent Polaris wouldn't have built", async () => {
    const i = buildBurnIntent(g, { sourceDomain: 0, depositor: buyer.address, recipient: polarisAccount, value: 5_000_000n, salt });
    const json = JSON.parse(JSON.stringify(intentToJson(i)));
    const back = intentFromJson(g, json);
    expect(back).toEqual(i);
    const signature = await sign(i);
    expect(await recoverTypedDataAddress({ domain: BURN_INTENT_DOMAIN, types: BURN_INTENT_TYPES, primaryType: "BurnIntent", message: back, signature })).toBe(buyer.address);

    const other = pad("0x0000000000000000000000000000000000000bad", { size: 32 });
    expect(() => intentFromJson(g, { ...json, spec: { ...json.spec, destinationDomain: 6 } })).toThrow(/destinationDomain/);
    expect(() => intentFromJson(g, { ...json, spec: { ...json.spec, destinationContract: other } })).toThrow(/destinationContract/);
    expect(() => intentFromJson(g, { ...json, spec: { ...json.spec, destinationCaller: other } })).toThrow(/destinationCaller/);
    expect(() => intentFromJson(g, { ...json, spec: { ...json.spec, sourceSigner: other } })).toThrow(/sourceSigner/);
    expect(() => intentFromJson(g, { ...json, maxFee: "5000000" })).toThrow(/maxFee/);
  });

  it("lets the relayer call GatewayMinter.gatewayMint, and nothing else there", () => {
    expect(RELAYER_CALLS.some((c) => c.contract === "gatewayMinter" && c.functionName === "gatewayMint")).toBe(true);
    const addresses = { checkout: polarisAccount, payments: polarisAccount, send: polarisAccount, loanEngine: polarisAccount, registry: polarisAccount, stablecoin: polarisAccount, gatewayMinter: ARC_TESTNET_CIRCLE.gatewayMinter };
    const mint = encodeFunctionData({ abi: parseAbi(["function gatewayMint(bytes,bytes)"]), functionName: "gatewayMint", args: ["0x01", "0x02"] });
    expect(checkRelayerCall({ to: ARC_TESTNET_CIRCLE.gatewayMinter, data: mint, chainId: 5042002 }, { chainId: 5042002, addresses })).toMatchObject({ contract: "gatewayMinter", functionName: "gatewayMint" });
    const other = encodeFunctionData({ abi: parseAbi(["function pause()"]), functionName: "pause" });
    expect(() => checkRelayerCall({ to: ARC_TESTNET_CIRCLE.gatewayMinter, data: other, chainId: 5042002 }, { chainId: 5042002, addresses })).toThrow();
  });

  it.runIf(process.env.GATEWAY_LIVE === "1")("Circle's testnet Gateway API accepts the signature (refusing only the empty balance) and rejects a tampered one", async () => {
    const i = buildBurnIntent(g, { sourceDomain: 6, depositor: buyer.address, recipient: polarisAccount, value: 1_000_000n, salt: keccak256(toHex(String(Date.now()))) });
    const signature = await sign(i);
    const post = (sig: string) =>
      fetch(`${g.apiUrl}/v1/transfer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ burnIntent: intentToJson(i), signature: sig }]) }).then(async (r) => ({ status: r.status, body: (await r.json()) as { message?: string } }));
    const good = await post(signature);
    expect(good.status).toBe(400);
    expect(good.body.message).toMatch(/Insufficient balance/);
    const bad = await post(signature.slice(0, -4) + (signature.endsWith("1b") ? "001c" : "001b"));
    expect(bad.body.message).toMatch(/Invalid signature/);
  }, 20_000);
});
