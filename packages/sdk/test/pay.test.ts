import { Interface, Signature, TypedDataEncoder, Wallet, getAddress, keccak256, solidityPacked, verifyTypedData } from "ethers";
import { describe, expect, it, vi } from "vitest";

import { ARC, ARC_TESTNET, SEPOLIA, USDC, type PolarisChain } from "../src/chains.js";
import { DEPLOYMENTS } from "../src/deployments.js";
import { createPolaris } from "../src/client.js";
import { PolarisError } from "../src/errors.js";
import {
  PAYMENTS_ABI,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  domainFromErc5267,
  paymentId,
  receiveWithAuthorizationTypedData,
} from "../src/pay/eip3009.js";
import { createFakeWallet } from "./helpers/fake-wallet.js";

const PAYMENTS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const MERCHANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/**
 * The testnet preset with a PolarisPayments the fake wallet serves, over
 * Circle's USDC on Arc: these tests pin USDC's own domain and quirks (no
 * ERC-5267, domain { name: "USDC", version: "2" }).
 */
const CHAIN: PolarisChain = { ...ARC_TESTNET, payments: PAYMENTS, stablecoin: USDC.arcTestnet };
/** USDC's DOMAIN_SEPARATOR() on Arc testnet, read from https://rpc.testnet.arc.io. */
const ARC_TESTNET_USDC_SEPARATOR = "0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0";
const iface = new Interface(PAYMENTS_ABI);

function client(provider: unknown, extra: Record<string, unknown> = {}) {
  return createPolaris({ publishableKey: "pk_test_51Hx8yQfT3sLk2Pz", chain: CHAIN, provider, ...extra });
}

describe("the ERC-3009 authorization", () => {
  it("derives the nonce exactly as PolarisPayments does: keccak256(abi.encodePacked(merchant, orderId))", () => {
    expect(paymentId(MERCHANT, "INV-2041")).toBe(keccak256(solidityPacked(["address", "string"], [MERCHANT, "INV-2041"])));
    // Checksum-insensitive, order-sensitive.
    expect(paymentId(MERCHANT.toLowerCase(), "INV-2041")).toBe(paymentId(MERCHANT, "INV-2041"));
    expect(paymentId(MERCHANT, "INV-2042")).not.toBe(paymentId(MERCHANT, "INV-2041"));
  });

  it("reproduces USDC's live domain separator on Arc testnet from name() and version()", () => {
    const domain = { name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC.arcTestnet };
    expect(TypedDataEncoder.hashDomain(domain)).toBe(ARC_TESTNET_USDC_SEPARATOR);
  });

  it("drops an ERC-5267 salt the fields bitmap excludes", () => {
    // fields 0x0f: name, version, chainId, verifyingContract.
    const domain = domainFromErc5267(
      { name: "USDC", version: "2", chainId: 5042002n, verifyingContract: USDC.arcTestnet, salt: `0x${"00".repeat(32)}` },
      "0x0f",
    );
    expect(domain).not.toHaveProperty("salt");
    expect(TypedDataEncoder.hashDomain(domain)).toBe(ARC_TESTNET_USDC_SEPARATOR);
  });

  it("builds eth_signTypedData_v4 JSON with only the domain fields present", () => {
    const typed = receiveWithAuthorizationTypedData(
      { name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC.arcTestnet },
      { from: MERCHANT, to: PAYMENTS, value: 25_000_000n, validAfter: 0n, validBefore: 1_790_430_000n, nonce: paymentId(MERCHANT, "x") },
    );
    expect(typed.types.EIP712Domain.map((f) => f.name)).toEqual(["name", "version", "chainId", "verifyingContract"]);
    expect(typed.primaryType).toBe("ReceiveWithAuthorization");
    expect(typed.message.value).toBe("25000000");
    expect(JSON.parse(JSON.stringify(typed))).toEqual(typed);
  });
});

describe("pay(): the wallet sends payWithAuthorization", () => {
  it("signs a ReceiveWithAuthorization to PolarisPayments and sends it with a 15% gas margin", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS);
    const stages: string[] = [];
    const before = Math.floor(Date.now() / 1000);
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "25.00", orderId: "INV-2041", onStage: (s) => stages.push(s) });

    expect(result).toMatchObject({ ok: true, amount: "25.00", relayed: false, payer: fake.wallet.address, paymentId: paymentId(MERCHANT, "INV-2041") });
    expect(result.explorerUrl).toBe(`https://explorer.testnet.arc.io/tx/${result.transactionHash}`);
    expect(stages).toEqual(["connecting", "signing", "submitting", "confirming"]);

    // What the wallet was asked to sign.
    const [typed] = fake.signed;
    expect(typed!.domain).toEqual({ name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC.arcTestnet });
    // USDC has no eip712Domain(): the domain came from name()/version(), checked against DOMAIN_SEPARATOR().
    expect(TypedDataEncoder.hashDomain(typed!.domain)).toBe(ARC_TESTNET_USDC_SEPARATOR);
    expect(typed!.primaryType).toBe("ReceiveWithAuthorization");
    expect(typed!.message).toMatchObject({
      from: fake.wallet.address,
      to: PAYMENTS,
      value: "25000000",
      validAfter: "0",
      nonce: paymentId(MERCHANT, "INV-2041"),
    });
    const validBefore = Number(typed!.message.validBefore);
    expect(validBefore).toBeGreaterThanOrEqual(before + 900);
    expect(validBefore).toBeLessThanOrEqual(before + 902);

    // What went on chain.
    const [tx] = fake.sent;
    expect(getAddress(tx!.to)).toBe(PAYMENTS);
    expect(tx!.value).toBe("0x0");
    expect(BigInt(tx!.gas)).toBe(115_000n);
    const decoded = iface.decodeFunctionData("payWithAuthorization", tx!.data);
    expect(decoded[0]).toBe(fake.wallet.address);
    expect(decoded[1]).toBe(MERCHANT);
    expect(decoded[2]).toBe(25_000_000n);
    expect(decoded[3]).toBe("INV-2041");
    expect(decoded[4]).toBe(0n);
    expect(decoded[5]).toBe(BigInt(validBefore));
    const sig = Signature.from({ v: Number(decoded[6]), r: decoded[7], s: decoded[8] });
    const signer = verifyTypedData(typed!.domain, RECEIVE_WITH_AUTHORIZATION_TYPES as never, typed!.message, sig);
    expect(signer).toBe(fake.wallet.address);
  });

  it("reads decimals from the token rather than assuming 6", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { decimals: 18, balance: 10n ** 21n });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "1.50", orderId: "o-1" });
    expect(result.ok).toBe(true);
    expect(fake.signed[0]!.message.value).toBe("1500000000000000000");
  });

  it("switches the wallet to Arc, adding the chain when the wallet has never seen it", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { chainId: 1, knownChains: [1] });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-2" });
    expect(result.ok).toBe(true);
    const add = fake.calls.find((c) => c.method === "wallet_addEthereumChain");
    expect(add?.params).toEqual([
      {
        chainId: "0x4cef52",
        chainName: "Arc Testnet",
        rpcUrls: ["https://rpc.testnet.arc.io"],
        blockExplorerUrls: ["https://explorer.testnet.arc.io"],
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      },
    ]);
  });

  it("asks the buyer to switch network, not 'You cancelled', when they decline the switch", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { chainId: 1, rejectSwitch: true });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-2a" });
    expect(result).toMatchObject({ ok: false, error: "Switch your wallet to Arc Testnet to pay." });
    const cause = result.cause as PolarisError;
    expect(cause).toBeInstanceOf(PolarisError);
    expect(cause).toMatchObject({ type: "wallet_error", code: "wrong_chain" });
    expect((cause as { cause?: { code?: number } }).cause?.code).toBe(4001);
    expect(fake.methods()).not.toContain("eth_signTypedData_v4");
  });

  it("asks the buyer to switch network when they decline adding it", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { chainId: 1, knownChains: [1], rejectAddChain: true });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-2b" });
    expect(result).toMatchObject({ ok: false, error: "Switch your wallet to Arc Testnet to pay." });
    expect((result.cause as PolarisError).code).toBe("wrong_chain");
    expect(fake.methods()).not.toContain("eth_signTypedData_v4");
  });

  it("asks the buyer to switch network when the wallet stays on the wrong one", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { chainId: 1, ignoreSwitch: true });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-2c" });
    expect(result).toMatchObject({ ok: false, error: "Switch your wallet to Arc Testnet to pay." });
    expect((result.cause as PolarisError).code).toBe("wrong_chain");
    expect(fake.methods()).not.toContain("eth_signTypedData_v4");
  });

  it("asks for the network in the 0.2 flows too, before any approval", async () => {
    const fake = createFakeWallet(SEPOLIA.stablecoin, SEPOLIA.payments, { chainId: 1, rejectSwitch: true });
    const legacy = createPolaris({ chain: SEPOLIA, provider: fake.provider });
    const result = await legacy.pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-2d" }); // Sepolia: approve, then pay
    expect(result).toMatchObject({ ok: false, error: "Switch your wallet to Sepolia to pay." });
    expect((result.cause as PolarisError).code).toBe("wrong_chain");
    expect(fake.sent).toHaveLength(0);
  });

  it("stops before any signature when the order is already paid", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, {
      paid: { payer: MERCHANT, merchant: MERCHANT, amount: 1n, paidAt: 1_790_000_000n },
    });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-3" });
    expect(result).toMatchObject({ ok: false, error: "This order has already been paid." });
    expect(fake.methods()).not.toContain("eth_signTypedData_v4");
  });

  it("stops when the buyer is short, naming both amounts", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { balance: 1_000_000n });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-4" });
    expect(result).toMatchObject({ ok: false, error: "Not enough USDC: this costs 2.00 and you have 1.00." });
    expect(fake.methods()).not.toContain("eth_signTypedData_v4");
  });

  it("stops when the order is quoted at another price", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { quoted: 3_000_000n });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-5" });
    expect(result).toMatchObject({ ok: false, error: "This order is priced at 3.00, not 2.00." });
  });

  it("turns a rejected signature into a sentence", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { rejectSignature: true });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-6" });
    expect(result).toMatchObject({ ok: false, error: "You cancelled the request." });
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses a signature that doesn't recover to the paying account", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { signWith: Wallet.createRandom() });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-7" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/different account/);
    expect(fake.sent).toHaveLength(0);
  });

  it("reports a reverted transaction", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { receiptStatus: "0x0" });
    const result = await client(fake.provider).pay({ merchant: MERCHANT, amount: "2.00", orderId: "o-8" });
    expect(result).toMatchObject({ ok: false, error: "The payment didn't go through. Nothing was charged." });
    expect(result.transactionHash).toMatch(/^0x/);
  });

  it("never calls eip712Domain() on USDC: name(), version() and DOMAIN_SEPARATOR() are enough", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS);
    await expect(client(fake.provider).pay({ merchant: MERCHANT, amount: "1.00", orderId: "o-9a" })).resolves.toMatchObject({ ok: true });
    const tokenCalls = fake.calls
      .filter((c) => c.method === "eth_call" && getAddress((c.params as [{ to: string }])[0].to) === USDC.arcTestnet)
      .map((c) => (c.params as [{ data: string }])[0].data.slice(0, 10));
    expect(tokenCalls).not.toContain("0x84b0196e"); // eip712Domain()
  });

  it("uses version \"2\" when the token has no version(), if DOMAIN_SEPARATOR() agrees", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, { tokenVersion: null, domainSeparator: ARC_TESTNET_USDC_SEPARATOR });
    await expect(client(fake.provider).pay({ merchant: MERCHANT, amount: "1.00", orderId: "o-9b" })).resolves.toMatchObject({ ok: true });
    expect(fake.signed[0]!.domain).toMatchObject({ name: "USDC", version: "2" });
  });

  it("falls back to ERC-5267 when name() isn't the domain name, and still checks DOMAIN_SEPARATOR()", async () => {
    // A token whose name() differs from its EIP-712 name, but which reports its domain over ERC-5267.
    const separator = TypedDataEncoder.hashDomain({ name: "Example Dollar", version: "1", chainId: 5042002, verifyingContract: USDC.arcTestnet });
    const erc5267 = { fields: "0x0f", name: "Example Dollar", version: "1", salt: `0x${"00".repeat(32)}` };
    const ok = createFakeWallet(USDC.arcTestnet, PAYMENTS, { legacyName: "XUSD", domainSeparator: separator, domain: erc5267 });
    await expect(client(ok.provider).pay({ merchant: MERCHANT, amount: "1.00", orderId: "o-9c" })).resolves.toMatchObject({ ok: true });
    expect(ok.signed[0]!.domain).toEqual({ name: "Example Dollar", version: "1", chainId: 5042002, verifyingContract: USDC.arcTestnet });

    // ERC-5267 that disagrees with DOMAIN_SEPARATOR() is refused too.
    const lying = createFakeWallet(USDC.arcTestnet, PAYMENTS, { legacyName: "XUSD", domainSeparator: separator, domain: { ...erc5267, name: "Other" } });
    const lied = await client(lying.provider).pay({ merchant: MERCHANT, amount: "1.00", orderId: "o-9d" });
    expect(lied.ok).toBe(false);
    expect(lied.error).toMatch(/doesn't match its DOMAIN_SEPARATOR/);
    expect(lying.methods()).not.toContain("eth_signTypedData_v4");
  });

  it("never signs a guessed domain: name() and DOMAIN_SEPARATOR() disagree and there is no ERC-5267", async () => {
    // name() says "USDC" but the separator was built from another name. Refuse.
    const other = TypedDataEncoder.hashDomain({ name: "Not USDC", version: "2", chainId: 5042002, verifyingContract: USDC.arcTestnet });
    const trap = createFakeWallet(USDC.arcTestnet, PAYMENTS, { domainSeparator: other });
    const result = await client(trap.provider).pay({ merchant: MERCHANT, amount: "1.00", orderId: "o-10" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing to sign against a guess/);
    expect(trap.methods()).not.toContain("eth_signTypedData_v4");

    // Nothing readable at all.
    const blank = createFakeWallet(USDC.arcTestnet, PAYMENTS, { domainSeparator: null });
    const unreadable = await client(blank.provider).pay({ merchant: MERCHANT, amount: "1.00", orderId: "o-10b" });
    expect(unreadable).toMatchObject({ ok: false });
    expect((unreadable.cause as PolarisError).code).toBe("domain_unreadable");
  });
});

describe("pay(): gasless through the relayer", () => {
  it("POSTs the signed authorization to relayUrl and never asks the wallet to send", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS);
    const txHash = `0x${"cd".repeat(32)}`;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { txHash, status: "confirmed" } }), { status: 201 }));
    const result = await client(fake.provider, { relayUrl: "http://localhost:3100/api/v1/relay/payments", fetch }).pay({
      merchant: MERCHANT,
      amount: "25.00",
      orderId: "INV-2041",
    });

    expect(result).toMatchObject({ ok: true, relayed: true, transactionHash: txHash });
    expect(fake.methods()).not.toContain("eth_sendTransaction");
    expect(fake.methods()).not.toContain("eth_getTransactionReceipt");

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3100/api/v1/relay/payments");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer pk_test_51Hx8yQfT3sLk2Pz",
      "Polaris-Client": "polarispay-sdk/0.3.0",
    });
    const body = JSON.parse(init.body as string);
    const typed = fake.signed[0]!;
    expect(body).toEqual({
      type: "payWithAuthorization",
      chainId: 5042002,
      contract: PAYMENTS,
      payer: fake.wallet.address,
      merchant: MERCHANT,
      amount: "25000000",
      orderId: "INV-2041",
      validAfter: "0",
      validBefore: typed.message.validBefore,
      nonce: paymentId(MERCHANT, "INV-2041"),
      signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
    });
    // The relayer gets a signature it can verify on its own.
    expect(verifyTypedData(typed.domain, RECEIVE_WITH_AUTHORIZATION_TYPES as never, typed.message, body.signature)).toBe(fake.wallet.address);
  });

  it("waits for the receipt when the relayer only submitted", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { txHash: `0x${"ef".repeat(32)}`, status: "submitted" } }), { status: 200 }));
    const result = await client(fake.provider, { relayUrl: "https://relay.example/pay", fetch }).pay({ merchant: MERCHANT, amount: "1.00", orderId: "o-11" });
    expect(result.ok).toBe(true);
    expect(fake.methods()).toContain("eth_getTransactionReceipt");
  });

  it("passes the relayer's refusal through as the buyer's error", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS);
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: "merchant_inactive", message: "This merchant isn't accepting payments yet." } }), { status: 422 }),
    );
    const result = await client(fake.provider, { relayUrl: "https://relay.example/pay", fetch }).pay({ merchant: MERCHANT, amount: "1.00", orderId: "o-12" });
    expect(result).toMatchObject({ ok: false, error: "This merchant isn't accepting payments yet." });
    expect((result.cause as PolarisError).code).toBe("merchant_inactive");
  });
});

describe("pay(): configuration", () => {
  it("refuses the undeployed Arc preset instead of signing for a zero address", async () => {
    // Arc mainnet has no Polaris deployment yet, so its preset is all zero placeholders.
    expect(DEPLOYMENTS.arc.source).toBeNull();
    const fake = createFakeWallet(USDC.arc, PAYMENTS);
    const polaris = createPolaris({ publishableKey: "pk_live_51Hx8yQfT3sLk2Pz", chain: ARC, provider: fake.provider });
    expect(polaris.chain.chainId).toBe(5042);
    await expect(polaris.pay({ merchant: MERCHANT, amount: "1.00", orderId: "o-13" })).rejects.toMatchObject({
      type: "configuration_error",
      code: "contract_not_deployed",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("validates the merchant and order id", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS);
    await expect(client(fake.provider).pay({ merchant: "0x123", amount: "1.00", orderId: "o" })).rejects.toMatchObject({ code: "invalid_merchant" });
    await expect(client(fake.provider).pay({ merchant: MERCHANT, amount: "1.00", orderId: "" })).rejects.toMatchObject({ code: "invalid_order_id" });
  });

  it("reads the recorded payment for an order", async () => {
    const fake = createFakeWallet(USDC.arcTestnet, PAYMENTS, {
      paid: { payer: MERCHANT, merchant: MERCHANT, amount: 25_000_000n, paidAt: 1_790_000_000n },
    });
    await expect(client(fake.provider).getPayment({ merchant: MERCHANT, orderId: "INV-2041" })).resolves.toEqual({
      paymentId: paymentId(MERCHANT, "INV-2041"),
      payer: MERCHANT,
      merchant: MERCHANT,
      amount: "25.00",
      paidAt: new Date(1_790_000_000_000),
    });
  });
});
